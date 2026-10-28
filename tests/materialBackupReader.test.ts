import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {prepareMaterialBackup, sendMaterialBackup} from '@/src/features/vocabulary/materialBackupReader';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import type {Frame} from '@/src/features/vocabulary/materialImportStage';

const wrap = (records: string, version = '1') => `{"format":"fluentread-learning-materials","version":${version},"materials":[${records}]}`;
const encoder = new TextEncoder();
const dbs: MaterialDatabase[] = [];
let serial = 0;
function database() {const result = new MaterialDatabase(`material-reader-test-${++serial}`); dbs.push(result); return result;}
afterEach(async () => {for (const db of dbs.splice(0)) {const name = db.name; db.close(); await Dexie.delete(name);}});
async function read(blob: Blob) {
  const prepared = await prepareMaterialBackup(blob), frames: Frame[] = [];
  await sendMaterialBackup(blob, prepared, async frame => {frames.push(frame);});
  const actual = [];
  for (let i = 0; i < prepared.manifest.records; i++) actual.push(JSON.parse(await new Blob(frames.filter(frame => frame.record === i).map(frame => frame.bytes)).text()));
  return {prepared, frames, actual};
}

describe('material backup source reader', () => {
  it('retains exact last-key, UTF-8 replacement, numeric and long-token semantics', async () => {
    const title = 'A' + '\u0315'.repeat(131072) + '\u0300', number = '1' + '0'.repeat(140000) + 'e-140000';
    const prefix = `\ufeff{"format":"bad","format":"fluentread-learning-materials","version":2,"version":1,"materials":[0],"m\\u0061terials":[{"title":${JSON.stringify(title)},"number":${number},"negative":-0,"huge":1e400,"value":"`;
    const blob = new Blob([encoder.encode(prefix), new Uint8Array([0xe0, 0x80, 0x80]), encoder.encode('\\ud800","value":"x"}]}')]);
    const {actual} = await read(blob), expected = JSON.parse(await blob.text()).materials;
    expect(actual).toEqual(expected);
    expect((actual[0].title as string).normalize('NFC')[0]).toBe('À');
    expect(Object.is(actual[0].negative, -0)).toBe(true); expect(actual[0].huge).toBe(Infinity);
  });
  it('preserves escaped ASCII and positive and negative numeric forms', async () => {
    const value = wrap('{"s":"\\\"\\\\\\/\\b\\f\\n\\r\\t","numbers":[-3,-0,0.2,0e1,1.1e1]}');
    expect((await read(new Blob([value]))).actual).toEqual(JSON.parse(value).materials);
  });
  it.each([
    '{"format":"fluentread-learning-materials","version":1,"materials":[1,],"materials":[]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[],"ignored":{"x":01}}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[]}x',
    '{"format":"fluentread-learning-materials","version":1,"materials":[],}',
    '{"format":"fluentread-learning-materials","version":1,"materials":["a\\u00xy"]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[1e+]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[true false]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[-x]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[0e]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[0.]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[0.1e+]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[truex]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":["\\z"]}',
    '{"format":"fluentread-learning-materials","version":1,"materials":[{}',
    '\ufeff',
  ])('rejects malformed syntax even in ignored and overwritten fields', async value => {
    expect(() => JSON.parse(value)).toThrow(); await expect(prepareMaterialBackup(new Blob([value]))).rejects.toBeInstanceOf(SyntaxError);
  });
  it('uses native JSON number conversion for long version and rejects other versions', async () => {
    const one = '1' + '0'.repeat(140000) + 'e-140000', two = '2' + '0'.repeat(140000) + 'e-140000';
    expect((await prepareMaterialBackup(new Blob([wrap('', one)]))).manifest.records).toBe(0);
    await expect(prepareMaterialBackup(new Blob([wrap('', two)]))).rejects.toThrow('不支持');
  });
  it('checks the full long version token when rereading it', async () => {
    const old = '2' + '0'.repeat(140000) + 'e-140000', next = '1' + '0'.repeat(140000) + 'e-140000';
    const raw = wrap('', old), start = raw.indexOf(old), source = new Blob([raw]), original = source.slice.bind(source);
    source.slice = (from, to) => from === start ? new Blob([next.slice(0, (to ?? raw.length) - start)]) : original(from, to);
    await expect(prepareMaterialBackup(source)).rejects.toThrow('改变');
  });
  it('accepts a valid version at the resource boundary while yielding between reads', async () => {
    const version = '1.' + '0'.repeat(1024 * 1024 - 2), controller = new AbortController();
    const result = await prepareMaterialBackup(new Blob([wrap('', version)]), {signal: controller.signal});
    expect(result.manifest.records).toBe(0);
  });
  it('bounds exceptionally large version tokens and nesting depth with clear errors', async () => {
    const version = '1.' + '0'.repeat(1024 * 1024);
    expect(JSON.parse(version)).toBe(1);
    await expect(prepareMaterialBackup(new Blob([wrap('', version)]))).rejects.toMatchObject({name: 'MaterialBackupCapacityError', message: '备份版本字段超过恢复大小限制'});
    const deep = `{"format":"fluentread-learning-materials","version":1,"materials":[],"unknown":${'['.repeat(1024)}0${']'.repeat(1024)}}`;
    expect(JSON.parse(deep).materials).toEqual([]);
    await expect(prepareMaterialBackup(new Blob([deep]))).rejects.toMatchObject({name: 'MaterialBackupCapacityError', message: '备份文件嵌套层级超过恢复限制'});
  });
  it.each([
    {frame: 8, record: 4, total: 100, frames: 100, records: '"abcd"'},
    {frame: 8, record: 100, total: 5, frames: 100, records: '"a","b"'},
    {frame: 2, record: 100, total: 100, frames: 1, records: '"ab"'},
  ])('rejects a record, total or frame budget after one scan', async ({frame, record, total, frames, records}) => {
    vi.resetModules();
    vi.doMock('@/src/features/vocabulary/materialProtocol', async importOriginal => ({
      ...await importOriginal<object>(), MATERIAL_IMPORT_FRAME_BYTES: frame, MATERIAL_IMPORT_MAX_RECORD_BYTES: record,
      MATERIAL_IMPORT_MAX_TOTAL_BYTES: total, MATERIAL_IMPORT_MAX_FRAMES: frames,
    }));
    try {
      const reader = await import('@/src/features/vocabulary/materialBackupReader'), blob = new Blob([wrap(records)]), original = blob.slice.bind(blob);
      let reads = 0; blob.slice = (start, end) => {reads++; return original(start, end);};
      await expect(reader.prepareMaterialBackup(blob)).rejects.toMatchObject({name: 'MaterialBackupCapacityError', message: '材料备份超过当前恢复容量限制'});
      expect(reads).toBe(1);
    } finally {vi.doUnmock('@/src/features/vocabulary/materialProtocol'); vi.resetModules();}
  });
  it('rejects wrong scalar metadata and unknown oversized keys do not shadow known keys', async () => {
    const key = 'version' + 'x'.repeat(140000), escapedFormat = [...'format'].map(ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const text = `{"${key}":3,"${escapedFormat}":"fluentread-learning-materials","version":1,"materials":[{},[]]}`;
    expect((await read(new Blob([text]))).actual).toEqual(JSON.parse(text).materials);
    await expect(prepareMaterialBackup(new Blob([wrap('', JSON.stringify('x'.repeat(2048)))]))).rejects.toThrow('不支持');
    await expect(prepareMaterialBackup(new Blob(['[]']))).rejects.toThrow('不支持');
    await expect(prepareMaterialBackup(new Blob([wrap('') + ' true']))).rejects.toBeInstanceOf(SyntaxError);
  });
  it('validates all JSON and selects the final materials value including over-limit overwritten arrays', async () => {
    const value = `{"format":"fluentread-learning-materials","version":1,"materials":[${Array(10001).fill('null').join(',')}],"materials":[-0]}`;
    const result = await read(new Blob([value]));
    expect(result.prepared.manifest.records).toBe(1); expect(Object.is(result.actual[0], -0)).toBe(true);
    await expect(prepareMaterialBackup(new Blob([value.replace('"materials":[-0]', '"materials":null')]))).rejects.toThrow('不支持');
    await expect(prepareMaterialBackup(new Blob([wrap(Array(10001).fill('null').join(','))]))).rejects.toThrow('超过材料上限');
  });
  it('matches JSON.parse when malformed UTF-8 crosses the 64 KiB source boundary', async () => {
    const prefix = '{"format":"fluentread-learning-materials","version":1,"materials":[{"value":"';
    const pad = new Uint8Array(65535 - encoder.encode(prefix).length); pad.fill(0x61);
    const source = new Blob([encoder.encode(prefix), pad, new Uint8Array([0xf0, 0x9f, 0x28, 0xff]), encoder.encode('"}]}')]);
    expect((await read(source)).actual).toEqual(JSON.parse(await source.text()).materials);
  });
  it('agrees with JSON.parse on a seeded corpus of malformed and valid byte mutations', async () => {
    let state = 0xdecafbad; const random = () => {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state;};
    const samples = [wrap('{"text":"😀","nested":[true,false,null,-0,1e400]}'), wrap('"ok",42,{"\\u0061":"x"}'), '{"format":"wrong","format":"fluentread-learning-materials","version":1,"materials":[1],"materials":["x"]}'];
    for (let sample = 0; sample < 600; sample++) {
      const bytes = encoder.encode(samples[random() % samples.length]);
      if (sample % 3 !== 0) for (let n = 0; n < 1 + random() % 3; n++) bytes[random() % bytes.length] = random() % 256;
      const source = new Blob([bytes]); let expected: any, valid = false;
      try {expected = JSON.parse(await source.text()); valid = !!expected && typeof expected === 'object' && !Array.isArray(expected) && expected.format === 'fluentread-learning-materials' && expected.version === 1 && Array.isArray(expected.materials) && expected.materials.length <= 10000;} catch {/* Invalid input must not yield a plan. */}
      let result: Awaited<ReturnType<typeof read>> | undefined;
      try {result = await read(source);} catch {/* Rejection is checked against JSON.parse below. */}
      expect(Boolean(result), `acceptance mismatch in sample ${sample}`).toBe(valid);
      if (result) expect(result.actual).toEqual(expected.materials);
    }
  });
  it('maintains existing stage digest and ordered bounded frames', async () => {
    const blob = new Blob([wrap(`{"text":"😀${'x'.repeat(140000)}"},-0,1e400`)]), {prepared, frames, actual} = await read(blob), h = sha256.create();
    for (let i = 0; i < actual.length; i++) {
      const all = frames.filter(frame => frame.record === i).map(frame => frame.bytes), bytes = new Uint8Array(await new Blob(all).arrayBuffer()), n = bytes.length;
      h.update(new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])); h.update(bytes);
    }
    expect(bytesToHex(h.digest())).toBe(prepared.manifest.digest);
    expect(frames.map(frame => frame.seq)).toEqual(frames.map((_, i) => i));
    expect(frames.every(frame => frame.bytes.length > 0 && frame.bytes.length <= 128 * 1024)).toBe(true);
    expect(actual).toEqual(JSON.parse(await blob.text()).materials);
  });
  it('detects source changes during prepare and after frames are sent', async () => {
    const original = new Blob([wrap('{"a":1}')]), changed = new Blob([wrap('{"a":2}')]);
    const plan = await prepareMaterialBackup(original), frames: Frame[] = [];
    await expect(sendMaterialBackup(changed, plan, async frame => {frames.push(frame);})).rejects.toThrow('改变');
    expect(frames.length).toBeGreaterThan(0);
    const unstable = new Blob([original]), slice = unstable.slice.bind(unstable); let reads = 0;
    unstable.slice = (start, end) => ++reads > 1 ? changed.slice(start, end) : slice(start, end);
    await expect(prepareMaterialBackup(unstable)).rejects.toThrow('改变');
  });
  it('detects short source reads, rejected callbacks and invalid prepared plans', async () => {
    const source = new Blob([wrap('{"a":1}')]), plan = await prepareMaterialBackup(source), short = new Blob([source]);
    short.slice = () => ({arrayBuffer: async () => new Uint8Array([1]).buffer} as Blob);
    await expect(prepareMaterialBackup(short)).rejects.toThrow('读取长度改变');
    await expect(sendMaterialBackup(short, plan, async () => {})).rejects.toThrow('读取长度改变');
    await expect(sendMaterialBackup(source, plan, async () => {throw Error('append failed');})).rejects.toThrow('append failed');
    for (const mutate of [
      (p: typeof plan) => {p.manifest.records++;},
      (p: typeof plan) => {p.manifest.bytes++;},
      (p: typeof plan) => {p.manifest.frames++;},
      (p: typeof plan) => {p.manifest.digest = 'invalid';},
      (p: typeof plan) => {p.plan.records[0].start = -1;},
      (p: typeof plan) => {p.plan.records[0].end = p.plan.size + 1;},
    ]) {
      const bad = structuredClone(plan); mutate(bad);
      await expect(sendMaterialBackup(source, bad, async () => {})).rejects.toThrow('无效的备份计划');
    }
  });
  it('validates caller-provided plan and source before accepting frames', async () => {
    const source = new Blob([wrap('{"a":"abcdefghijkl"}')]), plan = await prepareMaterialBackup(source);
    await expect(prepareMaterialBackup(null as unknown as Blob)).rejects.toThrow('无效的备份文件');
    await expect(sendMaterialBackup(source, null as never, async () => {})).rejects.toThrow('无效的备份计划');
    const missing = structuredClone(plan); missing.plan.records[0] = null as never;
    await expect(sendMaterialBackup(source, missing, async () => {})).rejects.toThrow('无效的备份计划');
    const badDigest = structuredClone(plan); badDigest.plan.fileDigest = 'x';
    await expect(sendMaterialBackup(source, badDigest, async () => {})).rejects.toThrow('无效的备份计划');
    await expect(sendMaterialBackup(new Blob(['shorter']), plan, async () => {})).rejects.toThrow('改变');
    for (const delta of [-1, 1]) {
      const bad = structuredClone(plan); bad.plan.records[0].length += delta; bad.manifest.bytes += delta;
      await expect(sendMaterialBackup(source, bad, async () => {})).rejects.toThrow('改变');
    }
    const tampered = structuredClone(plan); tampered.manifest.digest = '0'.repeat(64);
    await expect(sendMaterialBackup(source, tampered, async () => {})).rejects.toThrow('改变');
  });
  it('rejects a corrupted plan that ends in the middle of a multibyte character', async () => {
    const blob = new Blob([wrap('{"value":"😀"}')]), plan = await prepareMaterialBackup(blob);
    const bytes = new Uint8Array(await blob.arrayBuffer()), firstByte = bytes.indexOf(0xf0), bad = structuredClone(plan);
    bad.plan.records[0].end = firstByte + 1;
    bad.plan.records[0].length = bad.plan.records[0].end - bad.plan.records[0].start + 2;
    bad.manifest.bytes = bad.plan.records[0].length;
    bad.manifest.digest = '0'.repeat(64);
    await expect(sendMaterialBackup(blob, bad, async () => {})).rejects.toThrow('改变');
  });
  it('rejects partial BOM, incomplete root values, and cancellation before reading', async () => {
    for (const bytes of [new Uint8Array([0xef, 0xbb]), encoder.encode('true'), encoder.encode('{')]) {
      await expect(prepareMaterialBackup(new Blob([bytes]))).rejects.toThrow();
    }
    const source = new Blob([wrap('')]), slice = vi.spyOn(source, 'slice'), controller = new AbortController();
    controller.abort(); await expect(prepareMaterialBackup(source, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(slice).not.toHaveBeenCalled();
  });
  it('snapshots a prepared plan before asynchronous frame delivery', async () => {
    const blob = new Blob([wrap(`{"value":"${'x'.repeat(150000)}"},-0`)]), plan = await prepareMaterialBackup(blob);
    Object.defineProperty(plan.plan.records[0], 'unrelated', {enumerable: true, get() {throw Error('unrelated data must not be read');}});
    let calls = 0;
    await sendMaterialBackup(blob, plan, async () => {if (calls++ === 0) {plan.manifest.digest = '0'.repeat(64); plan.plan.fileDigest = '0'.repeat(64); plan.plan.records[1].start = 0;}});
    expect(calls).toBeGreaterThan(1);
    await expect(sendMaterialBackup(blob, plan, async () => {})).rejects.toThrow();
  });
  it('cancels pending file reads and frame delivery without starting additional work', async () => {
    const blob = new Blob([wrap('{}')]); let finish!: (value: ArrayBuffer) => void, reads = 0;
    const pending = new Promise<ArrayBuffer>(resolve => {finish = resolve;});
    blob.slice = () => ({arrayBuffer() {reads++; return pending;}} as Blob);
    const controller = new AbortController(), task = prepareMaterialBackup(blob, {signal: controller.signal});
    controller.abort(); await expect(task).rejects.toMatchObject({name: 'AbortError'}); finish(new Uint8Array([0]).buffer);
    await new Promise(resolve => setTimeout(resolve, 0)); expect(reads).toBe(1);
    const source = new Blob([wrap(`{"a":"${'x'.repeat(200000)}"}`)]), plan = await prepareMaterialBackup(source), controller2 = new AbortController();
    let calls = 0, resume!: () => void; const hold = new Promise<void>(resolve => {resume = resolve;});
    const sending = sendMaterialBackup(source, plan, async () => {calls++; await hold;}, {signal: controller2.signal});
    await viUntil(() => calls === 1); controller2.abort(); await expect(sending).rejects.toMatchObject({name: 'AbortError'});
    resume(); await new Promise(resolve => setTimeout(resolve, 0)); expect(calls).toBe(1);
  });
  it('sends a >20 MiB synthetic record through the actual stage transaction', async () => {
    const record = `{"id":"one","source":{"kind":"article","url":"https://example.test/a"},"title":"A","topics":[],"references":[],"createdAt":1,"updatedAt":2,"archivedAt":null,"unused":"${'x'.repeat(21 * 1024 * 1024)}"}`;
    const blob = new Blob([wrap(record)]), plan = await prepareMaterialBackup(blob), db = database(), repo = new MaterialRepository(db), stage = createStage(db, {clock: () => 1000});
    const cap = await stage.begin(plan.manifest, {generation: 0, capturedAt: 1});
    await sendMaterialBackup(blob, plan, frame => stage.append(cap, frame));
    await stage.seal(cap); expect(await stage.commit(cap)).toEqual({inserted: 1, updated: 0, skipped: 0});
    expect((await repo.get('one'))?.source.url).toBe('https://example.test/a');
  }, 60000);
});

async function viUntil(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(check()).toBe(true);
}
