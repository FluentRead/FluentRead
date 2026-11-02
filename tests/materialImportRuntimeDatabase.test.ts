import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {bytesToHex} from '@noble/hashes/utils';
import {sha256} from '@noble/hashes/sha256';
import {afterEach, expect, it, vi} from 'vitest';
import {installMaterialImportRuntime, MATERIAL_IMPORT_CLEANUP_ALARM} from '@/src/app/background/materialImportRuntime';
import {PORT_NAME} from '@/src/features/vocabulary/materialImportPort';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {MaterialDatabase} from '@/src/features/vocabulary/materialRepository';

vi.mock('webextension-polyfill', () => ({default: {}}));

const dbName = 'material-import-runtime-database-test';
const opened: MaterialDatabase[] = [];
afterEach(async () => {for (const db of opened.splice(0)) db.close(); await Dexie.delete(dbName);});

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn),
    fire: (...args: any[]) => {for (const fn of [...listeners]) fn(...args);}};
}
function port() {
  const onMessage = event(), onDisconnect = event(), messages: any[] = [];
  return {onMessage, messages, port: {name: PORT_NAME, sender: {id: 'fixture', url: 'chrome-extension://fixture/options.html'},
    onMessage, onDisconnect, postMessage: (message: any) => messages.push(message), disconnect: () => onDisconnect.fire()}};
}
function runtime() {
  const onConnect = event(), messages: unknown[] = [];
  return {onConnect, messages, id: 'fixture', getURL: (path: string) => `chrome-extension://fixture/${path.replace(/^\//u, '')}`,
    sendMessage: async (message: unknown) => {messages.push(message);}};
}
const capability = (id: string) => ({id, token: 'a'.repeat(64)});
const manifest = {records: 0, frames: 0, bytes: 0, digest: bytesToHex(sha256(new Uint8Array()))};

it('reclaims expired stage budget when the receiver is reinstalled', async () => {
  let now = 100;
  const browserRuntime = runtime();
  const deps = {runtime: browserRuntime, isPrivateContext: () => false, ready: Promise.resolve(), createStage: () => {
    const db = new MaterialDatabase(dbName); opened.push(db);
    return {stage: createStage(db, {clock: () => now, limits: {slots: 1, ttlMs: 1000, receiptTtlMs: 1000}}), close: () => db.close()};
  }};
  let dispose = installMaterialImportRuntime(deps as never);
  const first = port(); browserRuntime.onConnect.fire(first.port);
  first.onMessage.fire({id: 1, action: 'begin', capability: capability('00000000-0000-4000-8000-000000000001'),
    manifest, guard: {generation: 0, capturedAt: 100}, deadline: 1000});
  await vi.waitFor(() => expect(first.messages).toHaveLength(1)); expect(first.messages[0].ok).toBe(true);
  dispose(); now = 1200; dispose = installMaterialImportRuntime(deps as never);
  const second = port(); browserRuntime.onConnect.fire(second.port);
  second.onMessage.fire({id: 1, action: 'begin', capability: capability('00000000-0000-4000-8000-000000000002'),
    manifest, guard: {generation: 0, capturedAt: 1200}, deadline: 2000});
  await vi.waitFor(() => expect(second.messages).toHaveLength(1)); expect(second.messages[0].ok).toBe(true);
  dispose();
});

it('recovers a sealed session and broadcasts only after the database commits', async () => {
  const browserRuntime = runtime(); let database: MaterialDatabase;
  const deps = {runtime: browserRuntime, isPrivateContext: () => false, ready: Promise.resolve(), createStage: () => {
    database = new MaterialDatabase(dbName); opened.push(database);
    return {stage: createStage(database, {clock: () => 100, limits: {ttlMs: 1000}}), close: () => database.close()};
  }};
  const cap = capability('00000000-0000-4000-8000-000000000003');
  let dispose = installMaterialImportRuntime(deps as never), current = port(); browserRuntime.onConnect.fire(current.port);
  current.onMessage.fire({id: 1, action: 'begin', capability: cap, manifest, guard: {generation: 0, capturedAt: 100}, deadline: 1000});
  await vi.waitFor(() => expect(current.messages).toHaveLength(1)); expect(current.messages[0].ok).toBe(true);
  current.onMessage.fire({id: 2, action: 'seal'}); await vi.waitFor(() => expect(current.messages).toHaveLength(2)); expect(current.messages[1].ok).toBe(true);
  dispose(); dispose = installMaterialImportRuntime(deps as never); current = port(); browserRuntime.onConnect.fire(current.port);
  current.onMessage.fire({id: 1, action: 'resume', capability: cap}); await vi.waitFor(() => expect(current.messages).toHaveLength(1));
  expect(current.messages[0]).toMatchObject({ok: true, data: {state: 'sealed'}});
  const fail = () => {throw Error('injected failure');}; const receipts = database!.table('stageReceipts'); receipts.hook('creating', fail);
  current.onMessage.fire({id: 2, action: 'commit'}); await vi.waitFor(() => expect(current.messages).toHaveLength(2));
  expect(current.messages[1]).toEqual({id: 2, ok: false, error: 'operation-failed'}); expect(browserRuntime.messages).toEqual([]);
  receipts.hook('creating').unsubscribe(fail);
  current.onMessage.fire({id: 3, action: 'commit'}); await vi.waitFor(() => expect(current.messages).toHaveLength(3));
  expect(current.messages[2].ok).toBe(true); expect(browserRuntime.messages).toEqual([{type: 'fluentReadMaterialsChanged'}]);
  current.onMessage.fire({id: 4, action: 'commit'}); await vi.waitFor(() => expect(current.messages).toHaveLength(4));
  expect(current.messages[3].ok).toBe(true); expect(browserRuntime.messages).toHaveLength(1); dispose();
});

it('cleans expired private frames after an alarm while preserving a live session during clock rollback', async () => {
  let now = 100, marker = false, period: number | undefined;
  const browserRuntime = runtime(), onAlarm = event(), warnings: string[] = [];
  const maintenance = {warn: (message: string) => warnings.push(message),
    storage: {get: async () => ({fluentreadMaterialImportMaintenance: marker}), set: async () => {marker = true;}},
    alarms: {onAlarm, get: async () => period === undefined ? undefined : {periodInMinutes: period},
      create: async (_name: string, options: {periodInMinutes: number}) => {period = options.periodInMinutes;}}};
  let db: MaterialDatabase, stage: ReturnType<typeof createStage>;
  const deps = {runtime: browserRuntime, maintenance, isPrivateContext: () => false, ready: Promise.resolve(), createStage: () => {
    db = new MaterialDatabase(dbName); opened.push(db);
    stage = createStage(db, {clock: () => now, limits: {ttlMs: 1000, receiptTtlMs: 1000}});
    return {stage, close: () => db.close()};
  }};
  const raw = new TextEncoder().encode('null'), bytes = new Uint8Array([0,0,0,raw.length,...raw]);
  const recordManifest = {records: 1, frames: 1, bytes: raw.length, digest: bytesToHex(sha256(bytes))};
  const dispose = installMaterialImportRuntime(deps as never), p = port(); browserRuntime.onConnect.fire(p.port);
  const cap = capability('00000000-0000-4000-8000-000000000004');
  p.onMessage.fire({id: 1, action: 'begin', capability: cap, manifest: recordManifest, guard: {generation: 0, capturedAt: now}, deadline: 1000});
  await vi.waitFor(() => expect(p.messages).toHaveLength(1)); expect(p.messages[0].ok).toBe(true);
  p.onMessage.fire({id: 2, action: 'append', frame: {seq: 0, record: 0, part: 0, total: 1, recordBytes: raw.length, base64: 'bnVsbA=='}});
  await vi.waitFor(() => expect(p.messages).toHaveLength(2)); expect(p.messages[1].ok).toBe(true);
  expect(await db!.table('stageFrames').count()).toBe(1);
  const cleanup = vi.spyOn(stage!, 'cleanup');
  now = 50; onAlarm.fire({name: MATERIAL_IMPORT_CLEANUP_ALARM});
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1)); await cleanup.mock.results[0].value;
  expect(await db!.table('stageFrames').count()).toBe(1); expect(await db!.table('stageSessions').count()).toBe(1); expect(marker).toBe(true);
  now = 1200; onAlarm.fire({name: MATERIAL_IMPORT_CLEANUP_ALARM});
  await vi.waitFor(async () => expect(await db!.table('stageFrames').count()).toBe(0));
  expect(await db!.table('stageFrames').count()).toBe(0); expect(await db!.table('stageSessions').count()).toBe(0);
  expect(await db!.table('stageStarts').count()).toBe(0); expect(marker).toBe(true); expect(period).toBe(60); expect(warnings).toEqual([]); dispose();
});

it('reports committed corruption cleanup even if runtime is disposed before the transaction result is delivered', async () => {
  const db = new MaterialDatabase(dbName), other = new MaterialDatabase(dbName); opened.push(db, other);
  let onCleanupCorruption = () => {};
  const stage = createStage(db, {clock: () => 100, limits: {ttlMs: 1000}, onCleanupCorruption: () => onCleanupCorruption()});
  const cap = capability('00000000-0000-4000-8000-000000000005');
  const raw = new TextEncoder().encode('{"note":"synthetic private content"}'), hashInput = new Uint8Array(4 + raw.length);
  new DataView(hashInput.buffer).setUint32(0, raw.length); hashInput.set(raw, 4);
  await stage.beginRecoverable({records: 1, frames: 1, bytes: raw.length, digest: bytesToHex(sha256(hashInput))},
    {generation: 0, capturedAt: 100}, cap, {deadline: 1000});
  await stage.append(cap, {seq: 0, record: 0, part: 0, total: 1, recordBytes: raw.length, bytes: raw});
  await db.table('stageSessions').update(cap.id, {expiresAt: NaN});

  let committed!: () => void, deliver!: () => void;
  const arrived = new Promise<void>(resolve => {committed = resolve;}), release = new Promise<void>(resolve => {deliver = resolve;});
  const original = db.transaction.bind(db) as (...args: any[]) => Promise<any>;
  const transaction = vi.spyOn(db, 'transaction').mockImplementation(((...args: any[]) => Promise.resolve(original(...args)).then(async value => {
    if (value?.corruptSessions === 1) {committed(); await release;} return value;
  })) as never);
  const browserRuntime = runtime(), onAlarm = event(), warnings: string[] = [];
  const maintenance = {warn: (message: string) => warnings.push(message),
    storage: {get: async () => ({fluentreadMaterialImportMaintenance: true}), set: async () => {}},
    alarms: {onAlarm, get: async () => ({periodInMinutes: 60}), create: async () => {}}};
  const deps = {runtime: browserRuntime, maintenance, isPrivateContext: () => false, ready: Promise.resolve(),
    createStage: (notify: () => void) => {onCleanupCorruption = notify; return {stage, close: () => {}};}};
  const dispose = installMaterialImportRuntime(deps as never);
  try {
    await arrived;
    expect(await other.table('stageFrames').count()).toBe(0); expect(await other.table('stageSessions').count()).toBe(0);
    expect(warnings).toEqual(['[FluentRead] 材料恢复暂存元数据损坏，请检查材料与备份。']);
    expect(JSON.stringify(warnings)).not.toContain(cap.token);
    dispose(); deliver(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(warnings.filter(message => message.includes('元数据损坏'))).toHaveLength(1);
    expect(warnings.every(message => message === '[FluentRead] 材料恢复暂存元数据损坏，请检查材料与备份。'
      || message === '[FluentRead] 材料恢复暂存维护未确认，将在后续维护时重试')).toBe(true);
  } finally {deliver(); dispose(); transaction.mockRestore();}
});
