/**
 * @file src/features/vocabulary/materialBackupRestore.ts
 * 文件职责：协调设置页的大材料备份扫描、暂存和原子恢复。
 * 主要内容：完整验证源文件后才封存提交，断连或超时保留可查询能力，已提交结果由调用方确认后释放。
 * 模块边界：不持久化能力或文件、不读取材料正文以外的配置；界面负责生命周期、结果展示与回执确认。
 */
import browser from 'webextension-polyfill';
import {prepareMaterialBackup, sendMaterialBackup} from './materialBackupReader';
import {createMaterialImportCapability, PORT_NAME} from './materialImportPort';
import {createMaterialImportPortClient, type MaterialImportClientPort, type MaterialImportStatus} from './materialImportPortClient';
import type {Capability} from './materialImportStage';
import type {MaterialImportResult, MaterialOperationGuard} from './materialProtocol';

const REQUEST_TIMEOUT_MS = 30_000;
const BEGIN_DEADLINE_MS = 5 * 60_000;

type Client = ReturnType<typeof createMaterialImportPortClient>;
export type MaterialBackupOutcome =
  | {kind: 'committed'; result: MaterialImportResult; capability: Capability}
  | {kind: 'unknown'; capability: Capability; commitDispatched: boolean}
  | {kind: 'cancelled'; cleanupPending: boolean; capability?: Capability}
  | {kind: 'failed'; error: unknown; cleanupPending: boolean; capability?: Capability};

function cancelled(): Error {return Object.assign(new Error('已取消恢复'), {name: 'AbortError'});}
function timedOut(): Error {return Object.assign(new Error('恢复请求超时'), {name: 'TimeoutError'});}
function check(signal?: AbortSignal): void {if (signal?.aborted) throw cancelled();}
function request<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: (value: T | never) => void, value: T | never) => {
      if (done) return; done = true; signal?.removeEventListener('abort', onAbort); clearTimeout(timer); fn(value);
    };
    const onAbort = () => finish(reject, cancelled() as never);
    const timer = setTimeout(() => finish(reject, timedOut() as never), REQUEST_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, {once: true});
    work.then(value => finish(resolve, value), error => finish(reject, error as never));
    if (signal?.aborted) onAbort();
  });
}
function connect(): Client {
  if (browser.extension?.inIncognitoContext === true) throw Error('无痕窗口不读取或保存学习材料');
  const port = browser.runtime.connect({name: PORT_NAME}) as unknown as MaterialImportClientPort;
  return createMaterialImportPortClient(port);
}
function validResult(result: MaterialImportResult): boolean {
  return !!result && [result.inserted, result.updated, result.skipped].every(value => Number.isSafeInteger(value) && value >= 0);
}

/** 开始前将能力交给界面；页面关闭后的能力持久化不由此模块负责。 */
export async function restoreLargeMaterialBackup(file: Blob, guard: MaterialOperationGuard, options: {signal?: AbortSignal; onCapability: (value: Capability) => void}): Promise<MaterialBackupOutcome> {
  const signal = options.signal, safeGuard = {generation: guard.generation, capturedAt: guard.capturedAt};
  let client: Client | undefined, cap: Capability | undefined, opened = false, beginDispatched = false, commitDispatched = false;
  try {
    check(signal);
    const prepared = await prepareMaterialBackup(file, {signal});
    check(signal);
    cap = createMaterialImportCapability();
    options.onCapability(cap);
    check(signal);
    client = connect();
    const deadline = Date.now() + BEGIN_DEADLINE_MS;
    beginDispatched = true;
    const state = await request(client.begin(cap, prepared.manifest, safeGuard, deadline), signal);
    if (!state || state.state !== 'open' || state.nextSeq !== 0) return {kind: 'unknown', capability: cap, commitDispatched: false};
    opened = true;
    check(signal);
    await sendMaterialBackup(file, prepared, frame => request(client!.append(frame), signal), {signal});
    check(signal);
    await request(client.seal(), signal);
    check(signal);
    commitDispatched = true;
    const result = await request(client.commit(), signal);
    if (!validResult(result)) return {kind: 'unknown', capability: cap, commitDispatched: true};
    return {kind: 'committed', result, capability: cap};
  } catch (error) {
    if (commitDispatched && cap) return {kind: 'unknown', capability: cap, commitDispatched: true};
    // 捕获值可能来自文件读取或调用方；异常元数据本身不可阻止暂存清理。
    let failure = error, name: string | undefined;
    try {if (error instanceof Error) name = error.name;}
    catch {failure = new Error('材料恢复操作失败');}
    const interrupted = signal?.aborted || name === 'AbortError' || name === 'TimeoutError';
    // This category is sent only for a begin admission that rolled back.
    const rejectedAdmission = !interrupted && name === 'MaterialBackupCapacityError';
    let cleanupPending = beginDispatched && !opened && !rejectedAdmission;
    if (opened && client) {
      if (interrupted) cleanupPending = true;
      else {
        try {cleanupPending = (await request(client.discard(), signal)) !== 'discarded';}
        catch {cleanupPending = true;}
      }
    }
    const result = {cleanupPending, ...(cleanupPending && cap ? {capability: cap} : {})};
    return interrupted && signal?.aborted ? {kind: 'cancelled', ...result} : {kind: 'failed', error: failure, ...result};
  } finally {client?.close();}
}

/** 断线结果只能通过同一能力查询；无法查询时不得推断事务回滚。 */
export async function queryMaterialBackup(cap: Capability): Promise<MaterialImportStatus> {
  const client = connect();
  try {
    const state = await request(client.resume(cap));
    if (!state || (state.state !== 'open' && state.state !== 'sealed' && state.state !== 'committed') || state.state === 'committed' && !validResult(state.result)) throw Error('材料恢复状态不可用');
    return state;
  } finally {client.close();}
}

/** 调用方展示已提交结果并刷新列表后，尽力释放结果回执。 */
export async function acknowledgeMaterialBackup(cap: Capability): Promise<void> {
  const client = connect();
  try {
    const state = await request(client.resume(cap));
    if (!state || state.state !== 'committed' || !validResult(state.result)) throw Error('材料恢复回执不可用');
    await request(client.acknowledge());
  } finally {client.close();}
}

/** 仅由用户显式结束会话；若提交先完成，返回回执而不声称已经取消。 */
export async function discardMaterialBackup(cap: Capability): Promise<{state: 'discarded'} | {state: 'committed'; result: MaterialImportResult}> {
  const client = connect();
  try {
    let state = await request(client.resume(cap));
    if (state?.state === 'committed' && validResult(state.result)) return state;
    if (!state || (state.state !== 'open' && state.state !== 'sealed')) throw Error('材料恢复状态不可用');
    const outcome = await request(client.discard());
    if (outcome === 'discarded') return {state: 'discarded'};
    if (outcome !== 'committed') throw Error('材料恢复状态不可用');
    state = await request(client.status());
    if (state?.state !== 'committed' || !validResult(state.result)) throw Error('材料恢复状态不可用');
    return state;
  } finally {client.close();}
}
