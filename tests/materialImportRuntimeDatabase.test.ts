import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {bytesToHex} from '@noble/hashes/utils';
import {sha256} from '@noble/hashes/sha256';
import {afterEach, expect, it, vi} from 'vitest';
import {installMaterialImportRuntime} from '@/src/app/background/materialImportRuntime';
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
