import {beforeEach,describe,expect,it,vi} from 'vitest';
const ids=vi.hoisted(()=>({create:vi.fn(()=> '00000000-0000-4000-8000-000000000001')}));
vi.mock('@/src/features/vocabulary/repository',()=>({createUuid:ids.create}));
import {createMemoryVocabularyUndo} from '@/userscript/memoryVocabularyUndo';
const type='fluentReadVocabularyBook';
function fixture(){
  const entry={id:'entry',term:'private term',contexts:[{text:'private passage'}]};
  const repository={removeWithSnapshot:vi.fn(async()=>({entry,reviewLogs:[{id:'review'}]})),restoreSnapshot:vi.fn(async()=>undefined)};
  const notify=vi.fn();const handle=createMemoryVocabularyUndo(repository as never,notify);return {entry,repository,notify,handle};
}
beforeEach(()=>{ids.create.mockReset();ids.create.mockReturnValue('00000000-0000-4000-8000-000000000001')});
describe('userscript in-memory vocabulary undo',()=>{
  it('keeps snapshots in memory, sends only tickets, restores once and clears explicitly',async()=>{
    const {handle,repository,notify}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});
    expect(removed.success).toBe(true);if(!removed.success)throw new Error('unexpected failure');const ticket=removed.data as {id:string};
    expect(JSON.stringify(await handle({type,action:'listUndo'}))).not.toContain('private passage');expect(JSON.stringify(notify.mock.calls)).not.toContain('private passage');
    expect(await handle({type,action:'restoreUndo',undoId:ticket.id})).toEqual({success:true,data:'restored'});
    expect(await handle({type,action:'restoreUndo',undoId:ticket.id})).toEqual({success:true,data:'previously-restored'});expect(repository.restoreSnapshot).toHaveBeenCalledOnce();
    expect(handle.beginClear()).toBe(true);handle.endClear(true);expect(await handle({type,action:'listUndo'})).toEqual({success:true,data:[]});
  });
  it('does not delete the entry when generating a ticket ID fails',async()=>{
    const {handle,repository}=fixture();ids.create.mockImplementationOnce(()=>{throw new Error('random unavailable')});
    expect(await handle({type,action:'removeWithUndo',entryId:'entry'})).toMatchObject({success:false});expect(repository.removeWithSnapshot).not.toHaveBeenCalled();
  });
  it('rejects duplicate concurrent deletes without invoking a second removal',async()=>{
    const {handle,repository}=fixture();let finish!:(value:any)=>void;
    repository.removeWithSnapshot.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    const first=handle({type,action:'removeWithUndo',entryId:'entry'});
    expect(await handle({type,action:'removeWithUndo',entryId:'entry'})).toMatchObject({success:false,error:{code:'invalid-input'}});
    expect(repository.removeWithSnapshot).toHaveBeenCalledOnce();finish({entry:{id:'entry',term:'word'},reviewLogs:[]});expect(await first).toMatchObject({success:true});
  });
  it('rejects discard and clear while restore is in flight, then retains only a receipt',async()=>{
    const {handle,repository}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});if(!removed.success)throw new Error('unexpected');
    const id=(removed.data as {id:string}).id;let finish!:()=>void;repository.restoreSnapshot.mockImplementationOnce(()=>new Promise<undefined>(resolve=>{finish=()=>resolve(undefined)}));
    const pending=handle({type,action:'restoreUndo',undoId:id});
    expect(await handle({type,action:'restoreUndo',undoId:id})).toMatchObject({success:false,error:{code:'storage-error'}});
    expect(await handle({type,action:'discardUndo',undoId:id})).toMatchObject({success:false,error:{code:'invalid-input'}});expect(handle.beginClear()).toBe(false);
    finish();expect(await pending).toEqual({success:true,data:'restored'});
    expect(await handle({type,action:'restoreUndo',undoId:id})).toEqual({success:true,data:'previously-restored'});
    expect(handle.beginClear()).toBe(true);handle.endClear(true);handle.dispose();
  });
  it('bounds pending tickets and receipt history without deleting a new entry when capacity is full',async()=>{
    let sequence=0;ids.create.mockImplementation(()=>String(++sequence));const {handle,repository}=fixture();
    for(let i=0;i<20;i++) expect(await handle({type,action:'removeWithUndo',entryId:'entry'})).toMatchObject({success:true});
    expect(await handle({type,action:'removeWithUndo',entryId:'entry'})).toMatchObject({success:false,error:{code:'limit-exceeded'}});
    expect(repository.removeWithSnapshot).toHaveBeenCalledTimes(20);
    for(let i=1;i<=20;i++)expect(await handle({type,action:'restoreUndo',undoId:String(i)})).toEqual({success:true,data:'restored'});
    for(let i=21;i<=41;i++) {await handle({type,action:'removeWithUndo',entryId:'entry'});await handle({type,action:'restoreUndo',undoId:String(i)});}
    expect(await handle({type,action:'restoreUndo',undoId:'1'})).toEqual({success:true,data:'missing'});handle.dispose();
  });
  it('refuses duplicate ticket identifiers before deleting and ignores notification failures after commit',async()=>{
    const {handle,repository,notify}=fixture();notify.mockImplementation(()=>{throw new Error('private')});
    expect(await handle({type,action:'removeWithUndo',entryId:'entry'})).toMatchObject({success:true});
    expect(await handle({type,action:'removeWithUndo',entryId:'entry'})).toMatchObject({success:false});
    expect(repository.removeWithSnapshot).toHaveBeenCalledOnce();handle.dispose();
  });
  it('blocks restore during a pending clear and preserves tickets after a failed clear',async()=>{
    const {handle,repository}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});if(!removed.success)throw new Error('unexpected');
    const id=(removed.data as {id:string}).id;expect(handle.beginClear()).toBe(true);
    expect(await handle({type,action:'restoreUndo',undoId:id})).toMatchObject({success:false,error:{code:'invalid-input'}});expect(repository.restoreSnapshot).not.toHaveBeenCalled();
    handle.endClear(false);expect(await handle({type,action:'listUndo'})).toMatchObject({success:true,data:[{id}]});
    expect(await handle({type,action:'restoreUndo',undoId:id})).toEqual({success:true,data:'restored'});handle.dispose();
  });
  it('releases expired memory tickets even when the page stays idle',async()=>{
    vi.useFakeTimers();try{const {handle}=fixture();await handle({type,action:'removeWithUndo',entryId:'entry'});
      await vi.advanceTimersByTimeAsync(86_400_000);expect(await handle({type,action:'listUndo'})).toEqual({success:true,data:[]});handle.dispose();
    }finally{vi.useRealTimers();}
  });
  it('bounds the expiry timer after a large system-clock rollback',async()=>{
    vi.useFakeTimers();try{
      const start=Date.now(),timer=vi.spyOn(globalThis,'setTimeout'),{handle}=fixture();await handle({type,action:'removeWithUndo',entryId:'entry'});
      vi.setSystemTime(start-40*86_400_000);await vi.advanceTimersByTimeAsync(86_400_000);
      expect(timer.mock.calls.at(-1)?.[1]).toBeLessThanOrEqual(2_147_483_647);expect(vi.getTimerCount()).toBe(1);handle.dispose();timer.mockRestore();
    }finally{vi.useRealTimers();}
  });
  it('retains a ticket and reports a confirmed identity conflict without retrying',async()=>{
    const {handle,repository}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});if(!removed.success)throw new Error('unexpected');
    repository.restoreSnapshot.mockRejectedValueOnce(Object.assign(new Error('private context'),{name:'VocabularyBookError',code:'invalid-input'}));
    const id=(removed.data as {id:string}).id;const result=await handle({type,action:'restoreUndo',undoId:id});
    expect(result).toMatchObject({success:false,error:{code:'invalid-input'}});expect(JSON.stringify(result)).not.toContain('private context');
    expect(await handle({type,action:'listUndo'})).toMatchObject({success:true,data:[{id}]});expect(repository.restoreSnapshot).toHaveBeenCalledOnce();
  });
  it('retains a ticket on capacity failure and drops it when the repository reports expiry',async()=>{
    const {handle,repository}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});if(!removed.success)throw new Error('unexpected');
    const id=(removed.data as {id:string}).id;
    repository.restoreSnapshot.mockRejectedValueOnce(Object.assign(new Error('private'),{name:'VocabularyBookError',code:'limit-exceeded'}));
    expect(await handle({type,action:'restoreUndo',undoId:id})).toMatchObject({success:false,error:{code:'limit-exceeded'}});
    expect(await handle({type,action:'listUndo'})).toMatchObject({success:true,data:[{id}]});
    repository.restoreSnapshot.mockRejectedValueOnce(Object.assign(new Error('private'),{name:'VocabularyBookError',code:'not-found'}));
    expect(await handle({type,action:'restoreUndo',undoId:id})).toEqual({success:true,data:'expired'});
    expect(await handle({type,action:'listUndo'})).toEqual({success:true,data:[]});handle.dispose();
  });
  it('rejects malformed requests and unavailable records without repository writes',async()=>{
    const {handle,repository}=fixture();
    expect(await handle({type:'other',action:'listUndo'})).toMatchObject({success:false});
    expect(await handle({type,action:'removeWithUndo',entryId:''})).toMatchObject({success:false,error:{code:'invalid-input'}});
    expect(await handle({type,action:'restoreUndo'})).toMatchObject({success:false,error:{code:'invalid-input'}});
    expect(await handle({type,action:'unknown',undoId:'x'})).toMatchObject({success:false,error:{code:'invalid-input'}});
    expect(await handle({type,action:'restoreUndo',undoId:'missing'})).toEqual({success:true,data:'missing'});
    expect(repository.removeWithSnapshot).not.toHaveBeenCalled();expect(repository.restoreSnapshot).not.toHaveBeenCalled();handle.dispose();
  });
  it('does not resurrect an in-flight memory snapshot after explicit clear',async()=>{
    const {handle,repository}=fixture();let finish!:(value:any)=>void;
    repository.removeWithSnapshot.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    const pending=handle({type,action:'removeWithUndo',entryId:'entry'});handle.dispose();finish({entry:{id:'entry',term:'old'},reviewLogs:[]});
    expect(await pending).toEqual({success:true,data:null});expect(await handle({type,action:'listUndo'})).toEqual({success:true,data:[]});
  });
  it('retains an uncertain snapshot and does not replay without another explicit request',async()=>{
    const {handle,repository}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});if(!removed.success)throw new Error('unexpected');
    repository.restoreSnapshot.mockRejectedValueOnce(new Error('ambiguous'));const id=(removed.data as {id:string}).id;
    expect(await handle({type,action:'restoreUndo',undoId:id})).toMatchObject({success:false,error:{code:'storage-error'}});
    expect((await handle({type,action:'listUndo'}))).toMatchObject({success:true,data:[{id}]});expect(repository.restoreSnapshot).toHaveBeenCalledOnce();
    expect(await handle({type,action:'discardUndo',undoId:id})).toEqual({success:true,data:true});expect(repository.restoreSnapshot).toHaveBeenCalledOnce();
  });
  it('releases the restore barrier even if an error has an unreadable code',async()=>{
    const {handle,repository}=fixture();const removed=await handle({type,action:'removeWithUndo',entryId:'entry'});if(!removed.success)throw new Error('unexpected');
    const error=Object.assign(new Error('private'),{name:'VocabularyBookError'});Object.defineProperty(error,'code',{get(){throw new Error('private')}});
    repository.restoreSnapshot.mockRejectedValueOnce(error);const id=(removed.data as {id:string}).id;
    expect(await handle({type,action:'restoreUndo',undoId:id})).toMatchObject({success:false,error:{code:'storage-error'}});
    expect(await handle({type,action:'discardUndo',undoId:id})).toEqual({success:true,data:true});handle.dispose();
  });
});
