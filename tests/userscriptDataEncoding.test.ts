/** Static resource encoding preserves gzip payloads and checks invalid characters and padding. */
import {expect, it} from 'vitest';
import {gzipSync, gunzipSync} from 'node:zlib';
import {encodeUserscriptData, encodeUserscriptDataCompact} from '@/userscript/buildDataEncoding';
import {decodeUserscriptData, USERSCRIPT_DATA_ALPHABET, USERSCRIPT_COMPACT_DATA_ALPHABET} from '@/userscript/dataEncoding';

it('round-trips compact standalone data for every byte, offset and tail length', () => {
    const input = Uint8Array.from({length: 2051}, (_, index) => (index * 73 + (index >>> 3)) & 255);
    expect(new Set(USERSCRIPT_COMPACT_DATA_ALPHABET).size).toBe(91);
    for (let length = 0; length <= 2048; length += 1) {
        const bytes = input.subarray(3, 3 + length);
        const encoded = encodeUserscriptDataCompact(bytes);
        expect(encoded.startsWith('~91:')).toBe(true);
        expect(encoded).not.toMatch(/["/\\\s\u0080-\uffff]/u);
        expect(decodeUserscriptData(encoded)).toEqual(bytes);
    }
    for (const text of ['中文 日本語 한국어', 'français español русский 😀', '\\0 &lt; \ud800']) {
        const original = Buffer.from(text);
        expect(gunzipSync(decodeUserscriptData(encodeUserscriptDataCompact(gzipSync(original))))).toEqual(original);
    }
    expect(() => decodeUserscriptData('~91:中')).toThrow(/Invalid userscript resource/u);
    expect(() => decodeUserscriptData('~91:"')).toThrow(/Invalid userscript resource/u);
    expect(() => decodeUserscriptData('~91:!')).toThrow(/Invalid userscript resource padding/u);
    expect(decodeUserscriptData('~91:!!')).toEqual(Uint8Array.of(0));
    // 两字符和三字符分别覆盖非零尾部位与超出字节范围的尾部符号。
    expect(() => decodeUserscriptData('~91:!%')).toThrow(/Invalid userscript resource padding/u);
    expect(() => decodeUserscriptData('~91:!!&')).toThrow(/Invalid userscript resource padding/u);
    // 此输入通过尾部位校验，但存在等价的非规范末尾；必须拒绝，而非接受不唯一的编码。
    expect(() => decodeUserscriptData('~91:PxNC{.~qS*g!')).toThrow(/Invalid userscript resource padding/u);
});

it('keeps every byte value and every padding width, including offset Uint8Array views', () => {
    const bytes = Uint8Array.from({length: 1028}, (_, index) => index & 0xff);
    for (let length = 0; length <= 1024; length += 1) {
        const input = bytes.subarray(3, 3 + length);
        const encoded = encodeUserscriptData(input);
        expect(encoded).toMatch(/^~85:[0-3]/u);
        expect(encoded).not.toMatch(/["'\\\s\u0080-\uffff]/u);
        expect(decodeUserscriptData(encoded)).toEqual(input);
    }
    expect(decodeUserscriptData(encodeUserscriptData(new Uint8Array(4).fill(255)))).toEqual(new Uint8Array(4).fill(255));
    expect(new Set(USERSCRIPT_DATA_ALPHABET).size).toBe(85);
});

it('roundtrips compact Base91 for every length, all byte values and offset views',()=>{
    const input=Uint8Array.from({length:4099},(_,index)=>(index*73+29)&255);
    for(let length=0;length<=4096;length++) {
      const bytes=input.subarray(2,2+length),encoded=encodeUserscriptDataCompact(bytes);
      expect(encoded).toMatch(/^~91:/);expect(encoded).not.toMatch(/["\\\/\s\u0080-\uffff]/u);
      expect(decodeUserscriptData(encoded)).toEqual(bytes);
    }
    expect(()=>decodeUserscriptData('~91:"')).toThrow(/Invalid userscript resource/);
    expect(new Set(USERSCRIPT_COMPACT_DATA_ALPHABET).size).toBe(91);
    expect(()=>decodeUserscriptData('~91:!')).toThrow(/Invalid userscript resource/);
    expect(()=>decodeUserscriptData('~91:+f6w4.|X-2= ')).toThrow(/Invalid userscript resource/);
    for (const a of USERSCRIPT_COMPACT_DATA_ALPHABET) for (const b of USERSCRIPT_COMPACT_DATA_ALPHABET) {
      const encoded='~91:'+a+b;
      try { expect(encodeUserscriptDataCompact(decodeUserscriptData(encoded))).toBe(encoded); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith('Invalid userscript resource'))) throw error; }
    }
    let random=0x9e3779b9;
    for(let sample=0;sample<5000;sample++) {
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      let encoded='~91:';const length=4+(random%30);
      for(let i=0;i<length;i++){random=(Math.imul(random,1664525)+1013904223)>>>0;encoded+=USERSCRIPT_COMPACT_DATA_ALPHABET[random%91];}
      try {expect(encodeUserscriptDataCompact(decodeUserscriptData(encoded))).toBe(encoded);}
      catch(error){if(!(error instanceof Error && error.message.startsWith('Invalid userscript resource')))throw error;}
    }
});

it('restores gzip CSS, UTF-8 dictionary data and binary images without changing decoded bytes', () => {
    const fixtures = [Buffer.from('.example::before{content:"中文 日本語 😀";background:url("data:image/png;base64,AA==")}'),
        Buffer.from(JSON.stringify({中文: '语言', text: 'French é and escaped \\n', math: '∑x²', astral: '😀'})),
        Buffer.from(Array.from({length: 4096}, (_, index) => index * 73 & 255))];
    for (const input of fixtures) {
        const gzip = gzipSync(input, {level: 9});
        const restored = decodeUserscriptData(encodeUserscriptData(gzip));
        expect(Buffer.from(restored)).toEqual(gzip);
        expect(gunzipSync(restored)).toEqual(input);
    }
});

it('keeps the existing atob Base64 path including whitespace, omitted padding and invalid input', () => {
    expect(decodeUserscriptData('')).toEqual(new Uint8Array());
    expect(decodeUserscriptData(' \nAAH/\t')).toEqual(Uint8Array.of(0, 1, 255));
    expect(decodeUserscriptData('/w')).toEqual(Uint8Array.of(255));
    expect(() => decodeUserscriptData('not base64!')).toThrow();
    expect(() => decodeUserscriptData('~86:000000')).toThrow();
});

it.each(['~85:', '~85:x00000', '~85:-00000', '~85:400000', '~85:10000', '~85:1', '~85:3000000',
    '~85:00000"', '~85:00000\\', '~85:00000中', '~85:0~~~~~', '~85:100001'])('rejects malformed or noncanonical resource encoding %s', value => {
    expect(() => decodeUserscriptData(value)).toThrow(/Invalid userscript resource/u);
});
