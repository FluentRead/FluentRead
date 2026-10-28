/**
 * @file userscript/memoryVocabularyUndo.ts
 * 文件职责：为 userscript 完整设置保留当前页面内的词书删除撤销。
 * 模块边界：快照只存在脚本沙箱内存，不写宿主页 IndexedDB 或 GM；刷新和关闭页面后不可恢复。
 */
import {type VocabularyRemovalSnapshot, type VocabularyUndoTicket} from '@/src/features/vocabulary/learningModel';
import {VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse, type VocabularyBookErrorCode} from '@/src/features/vocabulary/protocol';
import {createUuid} from '@/src/features/vocabulary/repository';

interface MemoryUndoRepository {
  removeWithSnapshot(id: string): Promise<VocabularyRemovalSnapshot | null>;
  restoreSnapshot(snapshot: VocabularyRemovalSnapshot, expiresAt: number): Promise<void>;
}
export function createMemoryVocabularyUndo(repository: MemoryUndoRepository, notify: (reason:'remove'|'import'|'undo', entryId?:string)=>void) {
  type RecordState = {ticket:VocabularyUndoTicket;snapshot:VocabularyRemovalSnapshot;state:'pending'|'restoring'} | {ticket:VocabularyUndoTicket;state:'restored'};
  const records = new Map<string,RecordState>();
  const restoring = new Set<string>();
  let clearing = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let removing = false;
  let generation = 0;
  const fail = (code: VocabularyBookErrorCode, message: string): VocabularyBookResponse<never> => ({success:false,error:{code,message}});
  const emit = (reason:'remove'|'import'|'undo', id?:string) => {try {notify(reason,id);} catch { /* 保存结果不由通知决定 */ }};
  const cleanup = () => {const now=Date.now();for(const [id,record] of records) if(record.ticket.expiresAt<=now) records.delete(id);};
  const scheduleExpiry = () => {
    if(expiryTimer!==undefined)clearTimeout(expiryTimer);
    expiryTimer=undefined;
    if(!records.size)return;
    const next=Math.min(...[...records.values()].map(record=>record.ticket.expiresAt));
    expiryTimer=setTimeout(()=>{expiryTimer=undefined;cleanup();scheduleExpiry();},Math.min(2_147_483_647,Math.max(0,next-Date.now())));
    if(typeof expiryTimer==='object' && 'unref' in expiryTimer) expiryTimer.unref();
  };
  const handle = async (message: {type:string;action?:unknown;entryId?:unknown;undoId?:unknown}): Promise<VocabularyBookResponse> => {
    cleanup();
    try {
      if(message.type!==VOCABULARY_BOOK_MESSAGE) throw new Error('unsupported');
      if(clearing && message.action!=='listUndo') return fail('invalid-input','操作进行中，请稍后重试');
      if(message.action==='listUndo') return {success:true,data:[...records.values()].filter(record=>record.state!=='restored').map(record=>record.ticket)};
      if(message.action==='removeWithUndo') {
        if(typeof message.entryId!=='string' || !message.entryId) return fail('invalid-input','词条标识无效');
        if(removing)return fail('invalid-input','删除进行中');
        if([...records.values()].filter(record=>record.state!=='restored').length>=20)return fail('limit-exceeded','恢复记录已满');
        // At most 20 non-restored records can exist, so a full map always contains a receipt.
        while(records.size>=40) {const old=[...records].find(([,record])=>record.state==='restored')!;records.delete(old[0]);}
        const id=createUuid();if(records.has(id))throw new Error('duplicate ticket');
        const owner=generation;removing=true;
        let snapshot: VocabularyRemovalSnapshot | null;
        try {snapshot=await repository.removeWithSnapshot(message.entryId);} finally {removing=false;}
        if(!snapshot || owner!==generation)return {success:true,data:null};
        const createdAt=Date.now();const ticket={id,term:snapshot.entry.term,createdAt,expiresAt:createdAt+86_400_000};
        records.set(id,{ticket,snapshot,state:'pending'});scheduleExpiry();emit('remove',message.entryId);return {success:true,data:ticket};
      }
      if(typeof message.undoId!=='string')return fail('invalid-input','标识无效');
      const record=records.get(message.undoId);
      if(message.action==='discardUndo'){if(restoring.has(message.undoId))return fail('invalid-input','操作进行中，请稍后重试');records.delete(message.undoId);scheduleExpiry();emit('undo');return {success:true,data:true};}
      if(message.action!=='restoreUndo')return fail('invalid-input','操作不支持');
      if(!record)return {success:true,data:'missing'};
      if(record.state==='restored')return {success:true,data:'previously-restored'};
      if(record.state==='restoring')return fail('storage-error','恢复进行中');
      const undoId=message.undoId;record.state='restoring';restoring.add(undoId);
      return await (async (): Promise<VocabularyBookResponse> => {try {
        await repository.restoreSnapshot(record.snapshot,record.ticket.expiresAt);
        if(records.get(undoId)===record)records.set(undoId,{ticket:record.ticket,state:'restored'});
        emit('import');return {success:true,data:'restored'};
      } catch (error) {
        record.state='pending';
        if(error instanceof Error && error.name==='VocabularyBookError' && 'code' in error) {
          if(error.code==='not-found'){records.delete(undoId);scheduleExpiry();return {success:true,data:'expired'};}
          if(error.code==='invalid-input')return fail('invalid-input','已有相同收藏或复习记录');
          if(error.code==='limit-exceeded')return fail('limit-exceeded','收藏空间已满');
        }
        return fail('storage-error','恢复结果未确认，请检查收藏后选择是否重试');
      }})().finally(()=>{restoring.delete(undoId);});
    } catch {return fail('storage-error','结果未确认，请检查收藏');}
  };
  return Object.assign(handle,{
    beginClear:()=>{if(clearing || removing || restoring.size)return false;clearing=true;return true;},
    endClear:(success:boolean)=>{try{if(success){generation+=1;records.clear();scheduleExpiry();emit('undo');}}finally{clearing=false;}},
    dispose:()=>{generation+=1;records.clear();scheduleExpiry();},
  });
}
