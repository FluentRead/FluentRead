import {describe, expect, it, vi} from 'vitest';
import {deflate, gzip} from 'pako';
import JSZip from 'jszip';
import {lzo1xCompress} from 'lzo1x';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {extractConfigCredentials, mergeConfigCredentials, sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {defaultDictionaryWorkspace, dictionaryId, dictionaryObject, dictionaryText, dictionaryUrl, EMPTY_DICTIONARY_FIELDS, exportDictionaryRecipes, importDictionaryRecipes, normalizeDictionaryWorkspace, validateDictionaryRecipe, type DictionaryRecipe} from '@/src/core/config/dictionaryWorkspace';
import {cardTemplate, dictionaryCard, dictionaryCsv, dictionaryMarkdown, dictionaryPath, dictionaryPlainText, mapDictionaryResponse, normalizeDictionaryWord} from '@/src/features/selection-translation/dictionary/model';
import {dictionaryResourcePath, inflateDictionary, parseDictionaryFiles, type DictionaryFile} from '@/src/features/selection-translation/dictionary/imports';
import {decodeMdictKeyInfo, mdictKeyDigest} from '@/src/features/selection-translation/dictionary/mdictKeys';
import {dictionaryWorkspaceMessages} from '@/src/core/i18n/messages/dictionaryWorkspace';

const utf8 = new TextEncoder();
const file = (name: string, text: string): DictionaryFile => ({name, bytes: utf8.encode(text)});
const recipe = (extra: Partial<DictionaryRecipe> = {}): DictionaryRecipe => ({id: 'test', name: 'Test', kind: 'json', url: 'https://example.com/{{word}}', headers: {}, fields: {...EMPTY_DICTIONARY_FIELDS, definition: '[0].meaning'}, script: '', localId: '', ...extra});
const concatenate = (...parts: Uint8Array[]): Uint8Array => {const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));let at = 0;for (const part of parts) {bytes.set(part, at);at += part.length;}return bytes;};
const be = (value: number, size = 4): Uint8Array => {const bytes = new Uint8Array(size);for (let index = size - 1; index >= 0; index--) {bytes[index] = value % 256; value = Math.floor(value / 256);}return bytes;};
const utf16 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf16le'));

/** 自写最小二进制标本，记录偏移跨多个条目；不读取第三方词库或复制 parser 的输出。 */
export function mdictFixture(options: {version?: number; method?: number; media?: boolean; encryption?: string; malformed?: string; encoding?: string} = {}): Uint8Array {
    const version = options.version ?? 2, width = version >= 2 ? 8 : 4, method = options.method ?? 2, media = options.media ?? false;
    const encoding = options.encoding ?? (media ? 'UTF-16LE' : 'UTF-8');
    const encode = /UTF-16/i.test(encoding) ? utf16 : (text: string) => utf8.encode(text);
    const zero = new Uint8Array(/UTF-16/i.test(encoding) ? 2 : 1);
    const words = media ? ['\\picture.png', '\\style.css'] : ['curious', 'wonder'];
    const definitions = media ? [new Uint8Array([1, 2, 3]), utf8.encode('b{color:navy}')] : [encode('<b>eager to learn</b>\0'), encode('a feeling of surprise\0')];
    const block = (input: Uint8Array) => concatenate(new Uint8Array([method, 0, 0, 0, 0, 0, 0, 0]), method === 0 ? input : method === 1 ? lzo1xCompress(input) : deflate(input));
    const keyRaw = concatenate(...words.flatMap((word, index) => [be(index === 0 ? 0 : definitions[0].length, width), encode(word), zero]));
    const keyBlock = block(keyRaw);
    const keyInfoRaw = concatenate(be(words.length, width), ...[words[0], words[1]].flatMap(word => [be(word.length, version >= 2 ? 2 : 1), encode(word), ...(version >= 2 ? [zero] : [])]), be(keyBlock.length, width), be(keyRaw.length, width));
    let keyInfo = version >= 2 ? block(keyInfoRaw) : keyInfoRaw;
    if (options.encryption === '2') {
        const seed = concatenate(keyInfo.subarray(4, 8), new Uint8Array([0x95, 0x36, 0, 0]));
        const key = mdictKeyDigest(seed); const encrypted = keyInfo.slice(); let previous = 0x36;
        for (let index = 8; index < keyInfo.length; index++) {const nibble = keyInfo[index] ^ previous ^ ((index - 8) & 255) ^ key[(index - 8) % 16];encrypted[index] = (nibble >>> 4) | (nibble << 4);previous = encrypted[index];}
        keyInfo = encrypted;
    }
    const recordsRaw = concatenate(...definitions), recordBlock = block(recordsRaw);
    const header = utf16(`<Dictionary GeneratedByEngineVersion="${version}" ${options.malformed === 'no-encoding' ? '' : `Encoding="${encoding}"`} Encrypted="${options.encryption ?? '0'}" />\0`);
    return concatenate(be(header.length), header, be(0), be(1, width), be(options.malformed === 'count' ? 3 : words.length, width), ...(version >= 2 ? [be(keyInfoRaw.length, width)] : []), be(keyInfo.length, width), be(keyBlock.length, width), ...(version >= 2 ? [be(0)] : []), keyInfo, keyBlock,
        be(1, width), be(words.length, width), be(width * 2, width), be(recordBlock.length, width), be(recordBlock.length, width), be(recordsRaw.length, width), recordBlock);
}

describe('dictionary workspace configuration and cards', () => {
    it('keeps existing defaults and normalizes an explicitly selected source', () => {
        const config = new Config(); expect(config.selectionDictionarySource).toBe('auto'); expect(config.selectionDictionaryRecipe).toBe('');
        const normalized = normalizeConfig({selectionDictionaryRecipe: 'test', selectionDictionaryWorkspace: {recipes: [recipe()]}});
        expect(normalized.selectionDictionaryRecipe).toBe('test');
        expect(normalizeConfig({selectionDictionaryRecipe: 'missing'}).selectionDictionaryRecipe).toBe('');
        expect(normalizeDictionaryWorkspace(null)).toEqual(defaultDictionaryWorkspace());
        expect(normalizeDictionaryWorkspace(defaultDictionaryWorkspace())).toEqual(defaultDictionaryWorkspace());
        expect(dictionaryObject([])).toBe(false); expect(dictionaryObject({})).toBe(true); expect(dictionaryText(42)).toBe('');
        expect(dictionaryId('../a')).toBe(''); expect(dictionaryId('ok-id')).toBe('ok-id');
    });
    it('keeps dictionary headers in the existing private credential store across normalization', () => {
        const config = normalizeConfig({selectionDictionaryWorkspace: {recipes: [recipe()]} as any, customHeaders: {'dictionary:test': '{"Authorization":"fixture-only"}', 'dictionary:absent': 'orphan'}});
        expect(config.customHeaders).toEqual({'dictionary:test': '{"Authorization":"fixture-only"}'});
        const publicConfig = sanitizeConfigCredentials(config);
        expect(JSON.stringify(publicConfig)).not.toContain('fixture-only');
        expect(normalizeConfig(mergeConfigCredentials(publicConfig, extractConfigCredentials(config))).customHeaders).toEqual(config.customHeaders);
    });
    it.each(['javascript:alert(1)', 'file:///etc/passwd', 'http://192.168.1.1/{{word}}', 'https://user:secret@example.com/{{word}}'])('rejects an unsafe recipe URL %s', url => expect(() => validateDictionaryRecipe(recipe({url}))).toThrow());
    it('encodes the word as data and allows loopback servers', () => {
        expect(dictionaryUrl('https://example.com/{{word}}', 'a/b')).toBe('https://example.com/a%2Fb');
        expect(dictionaryUrl('http://localhost:8000/{{word}}')).toContain('localhost');
        expect(dictionaryUrl('http://[::1]:8000/{{word}}')).toContain('[::1]');
    });
    it.each([null, {}, {id: '../'}, recipe({name: ''}), recipe({kind: 'no' as any}), recipe({url: 'https://example.com'}), recipe({kind: 'local', localId: ''}), recipe({kind: 'script'})])('rejects invalid recipe %j', value => expect(() => validateDictionaryRecipe(value)).toThrow());
    it.each([{'Cookie': 'secret'}, {'Origin': 'x'}, {'sec-evil': 'x'}, {'X-A': 'a\nb'}, {'a b': 'bad'}, {'x': 4}, Object.fromEntries(Array.from({length: 17}, (_, index) => [`X-${index}`, 'x']))])('rejects forbidden or malformed headers', headers => expect(() => validateDictionaryRecipe({...recipe(), headers})).toThrow());
    it('imports strict recipes, strips headers on export and isolates duplicate IDs', () => {
        const secret = recipe({headers: {Authorization: 'fixture-only'}});
        expect(importDictionaryRecipes(exportDictionaryRecipes([secret, recipe({id: 'local', kind: 'local', localId: 'local'})]))).toEqual([recipe()]);
        expect(normalizeDictionaryWorkspace({recipes: [secret, secret, null], front: 'front', back: '', anki: {url: 'https://evil.test', deck: 'Study'}})).toMatchObject({recipes: [secret], front: 'front', back: '', anki: {url: 'http://127.0.0.1:8765/', deck: 'Study'}});
        expect(normalizeDictionaryWorkspace({anki: {url: 'http://localhost:8765'}}).anki.url).toBe('http://localhost:8765/');
        expect(normalizeDictionaryWorkspace({anki: {url: 'invalid'}}).anki.url).toBe('http://127.0.0.1:8765/');
        expect(() => importDictionaryRecipes(JSON.stringify({version: 1, recipes: [secret, secret]}))).toThrow('Duplicate');
        for (const body of ['x'.repeat(1024 * 1024 + 1), '{}', '{', '{"version":2,"recipes":[]}']) expect(() => importDictionaryRecipes(body)).toThrow();
        expect(validateDictionaryRecipe({...recipe(), fields: null, headers: null}).fields).toEqual(EMPTY_DICTIONARY_FIELDS);
    });
    it('supports safe paths with arrays, wildcards, primitives and missing values', () => {
        expect(dictionaryPath([{meaning: 'hello'}, {meaning: 'world'}], '$[*].meaning')).toBe('hello\nworld');
        expect(dictionaryPath({data: [{values: ['a', 'b'], bool: true}]}, 'data[0].values')).toBe('a\nb');
        expect(dictionaryPath({bool: false, count: 2}, '$.*')).toBe('false\n2');
        expect(dictionaryPath({}, 'data[0]')).toBe(''); expect(dictionaryPath(null, 'data')).toBe(''); expect(dictionaryPath({}, '')).toBe('');
        for (const path of ['__proto__', 'constructor.a', 'x.prototype', '$..x', 'x[?(@.y)]', Array(22).fill('x').join('.')]) expect(() => dictionaryPath({}, path)).toThrow();
        const inherited = Object.create({key: 'hidden'}); expect(dictionaryPath(inherited, 'key')).toBe('');
    });
    it('normalizes multilingual words and maps only text fields', () => {
        for (const word of ['好奇', 'ありがとう', 'Café', "wonder's", 'red fox']) expect(normalizeDictionaryWord(word)).toBeTruthy();
        for (const word of ['', 'a'.repeat(129), 'hello\nworld', '<b>x</b>', 'hi\u200b']) expect(normalizeDictionaryWord(word)).toBeNull();
        expect(dictionaryPlainText('<script>evil()</script><b>Fish &amp; chips</b>')).toBe('Fish & chips');
        const entry = mapDictionaryResponse([{meaning: '<b>hello</b>', audio: 'https://audio.test/a.mp3'}], recipe({fields: {...EMPTY_DICTIONARY_FIELDS, definition: '[0].meaning', audio: '[0].audio'}}), 'word');
        expect(entry.definition).toBe('hello'); expect(entry.audio).toBe('https://audio.test/a.mp3');
        const card = dictionaryCard(entry, 'A sentence.', 'AI answer', {...defaultDictionaryWorkspace(), front: '{{word}} <b>{{unknown}}</b>', back: '{{definition}} / {{context_sentence}} / {{ai_explanation}}'});
        expect(card).toEqual({front: 'word <b></b>', back: 'hello / A sentence. / AI answer'});
        expect(cardTemplate('{{word}}', {...entry, ai_explanation: '', context_sentence: '', source_url: ''})).toBe('word');
        expect(dictionaryCsv({front: '=cmd()', back: 'a,"b"\nc'})).toBe('Front,Back\r\n"\'=cmd()","a,""b""\nc"\r\n');
        expect(dictionaryMarkdown(card)).toContain('\n\n---\n\n');
    });
    it('has matching keys in all seven interface languages', () => {
        const keys = Object.keys(dictionaryWorkspaceMessages['zh-CN']).sort();
        for (const catalog of Object.values(dictionaryWorkspaceMessages)) {expect(Object.keys(catalog).sort()).toEqual(keys);expect(Object.values(catalog).every(Boolean)).toBe(true);}
    });
});

describe('offline dictionary import formats', () => {
    it.each([false, true])('imports UTF-8/UTF-16 DSL with aliases and markup, UTF16=%s', async utf16le => {
        const text = '#NAME "Fixture"\ncurious\nwonder\n\t[b]eager[/b] & happy\n\t[s]a.mp3[/s]\n\nありがとう\n\tThanks!';
        const dictionary = await parseDictionaryFiles([{name: 'test.dsl', bytes: utf16le ? concatenate(new Uint8Array([255,254]), utf16(text)) : utf8.encode(text)}]);
        expect(dictionary.entries.map(item => item.key)).toEqual(['curious','wonder','ありがとう']);
        expect(dictionary.entries[0].html).toContain('<b>eager</b>');expect(dictionary.entries[0].html).toContain('<audio');
    });
    it('imports compressed DSL, local media and stylesheet companions', async () => {
        const result = await parseDictionaryFiles([{name:'test.dsl.dz',bytes:gzip(utf8.encode('word\n\tmeaning'))},file('a.css','b{color:red}'),{name:'a.png',bytes:new Uint8Array([1])}]);
        expect(result.format).toBe('DSL');expect(result.resources).toHaveLength(1);expect(result.css).toContain('red');
    });
    it.each([false, true])('reads StarDict with matching index and dictionary, compressed=%s', async compressed => {
        const definition = utf8.encode('meaning\0'); const index = concatenate(utf8.encode('curious\0'),be(0),be(definition.length));
        const result = await parseDictionaryFiles([file('fixture.ifo','StarDict\nsametypesequence=m\n'),{name:`fixture.idx${compressed ? '.gz' : ''}`,bytes:compressed?gzip(index):index},{name:`fixture.dict${compressed?'.dz':''}`,bytes:compressed?gzip(definition):definition}]);
        expect(result.entries[0]).toMatchObject({word:'curious',definition:'meaning'});
    });
    it.each([0,1,2])('reads MDX and MDD with compression method %s', async method => {
        const result = await parseDictionaryFiles([{name:'fixture.mdx',bytes:mdictFixture({method})},{name:'fixture.mdd',bytes:mdictFixture({method,media:true})}]);
        expect(result.entries.map(item=>item.word)).toEqual(['curious','wonder']);expect(result.entries[0].definition).toBe('eager to learn');expect(result.resources[0].path).toBe('picture.png');
    });
    it.each([{version:1},{encryption:'2'},{encoding:'UTF-16LE'}])('reads MDict compatibility variant %j', async options => {
        const result=await parseDictionaryFiles([{name:'a.mdx',bytes:mdictFixture(options)}]);expect(result.entries[1].definition).toBe('a feeling of surprise');
    });
    it('checks published RIPEMD-128 vectors and rejects truncated obfuscated indexes', () => {
        for (const [input,hex] of [['','cdf26213a150dc3ecb610f18f6b38b46'],['a','86be7afa339d0fc7cfc785e72f578d33'],['abc','c14a12199c66e4ba84636b0f69144c77'],['1234567890'.repeat(8),'3f45ef194732c2dbb2c4a2c769795fa3']]) expect(Buffer.from(mdictKeyDigest(utf8.encode(input))).toString('hex')).toBe(hex);
        expect(()=>decodeMdictKeyInfo(new Uint8Array(7))).toThrow();
    });
    it('reads Yomitan structured definitions, alternate readings and media', async () => {
        const zip = new JSZip();zip.file('index.json',JSON.stringify({title:'Japanese'}));zip.file('term_bank_1.json',JSON.stringify([['好奇','こうき','','',0,['curiosity',{type:'structured-content',content:[{tag:'span',content:'interest'},{tag:'img',path:'a.png'}]}]]]));zip.file('a.png',new Uint8Array([1,2]));zip.file('styles.css','span{color:navy}');zip.file('extra.json','{}');zip.folder('folder');
        const result=await parseDictionaryFiles([{name:'japanese.zip',bytes:await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})}]);
        expect(result.name).toBe('Japanese');expect(result.entries.map(item=>item.key)).toEqual(['好奇','こうき']);expect(result.resources).toHaveLength(1);expect(result.css).toContain('navy');
    });
    it('fails clearly on unsupported, corrupt, missing and protected files', async () => {
        for (const files of [[],[file('x.txt','no')],[file('empty.dsl','#NAME "empty"')],[file('a.ifo','bad')],[{name:'a.mdx',bytes:mdictFixture({encryption:'1'})}],[{name:'a.mdx',bytes:mdictFixture({version:3})}],[{name:'a.mdx',bytes:mdictFixture({malformed:'count'})}],[{name:'a.mdx',bytes:mdictFixture().slice(0,20)}]]) await expect(parseDictionaryFiles(files)).rejects.toThrow();
        expect(()=>dictionaryResourcePath('../a.png')).toThrow();expect(()=>dictionaryResourcePath('https://evil/a')).toThrow();expect(dictionaryResourcePath('\\a\\b.png')).toBe('a/b.png');
        expect(()=>inflateDictionary(new Uint8Array([1]))).toThrow();expect(()=>inflateDictionary(deflate(utf8.encode('abc')),2)).toThrow();expect(()=>inflateDictionary(deflate(utf8.encode('abc')),4)).toThrow();expect(()=>inflateDictionary(new Uint8Array(),300*1024*1024)).toThrow();
    });
    it('handles UTF-16BE, skips invalid headwords and enforces entry/file limits', async () => {
        const body=Buffer.from('word\n\tmeaning','utf16le');body.swap16();expect((await parseDictionaryFiles([{name:'a.dsl',bytes:concatenate(new Uint8Array([254,255]),body)}])).entries[0].word).toBe('word');
        const result=await parseDictionaryFiles([file('a.dsl','<invalid>\n\tno\nword\n\tmeaning')]);expect(result.entries).toHaveLength(1);
        await expect(parseDictionaryFiles([file('a.dsl','word\n\t'+'x'.repeat(262145))])).rejects.toThrow('too large');
        await expect(parseDictionaryFiles([file('a.dsl',Array(500001).fill('word').join('\n')+'\n\tmeaning')])).rejects.toThrow('Too many');
        await expect(parseDictionaryFiles(Array.from({length:65},()=>file('a.dsl','word\n\tmeaning')))).rejects.toThrow('128');
        expect(()=>dictionaryResourcePath('')).toThrow();expect(()=>dictionaryResourcePath('a'.repeat(513))).toThrow();expect(()=>inflateDictionary(new Uint8Array(),-1)).toThrow();
    });
    it('reads StarDict mixed text, phonetic, HTML and binary fields with 64-bit offsets',async()=>{
        const bytes=concatenate(utf8.encode('tIPA\0h<b>meaning</b>\0P'),be(3),new Uint8Array([1,2,3]));
        const idx=concatenate(utf8.encode('word\0'),be(0,8),be(bytes.length));
        const result=await parseDictionaryFiles([file('a.ifo','idxoffsetbits=64\n'),{name:'a.idx',bytes:idx},{name:'a.dict',bytes}]);expect(result.entries[0]).toMatchObject({phonetic:'IPA',definition:'meaning'});
        const sequence=await parseDictionaryFiles([file('a.ifo','sametypesequence=tm'),{name:'a.idx',bytes:concatenate(utf8.encode('word\0'),be(0),be(11))},{name:'a.dict',bytes:utf8.encode('IPA\0meaning')}]);expect(sequence.entries[0].phonetic).toBe('IPA');
        for (const [index,dict] of [[utf8.encode('unterminated'),bytes],[concatenate(utf8.encode('word\0'),new Uint8Array(8).fill(255),be(1)),bytes],[concatenate(utf8.encode('word\0'),be(999,8),be(1)),bytes]]) await expect(parseDictionaryFiles([file('a.ifo','idxoffsetbits=64'),{name:'a.idx',bytes:index},{name:'a.dict',bytes:dict}])).rejects.toThrow();
    });
    it('rejects malformed MDict offsets, block sizes, counts and compression IDs before indexing',async()=>{
        const base=mdictFixture({method:0});const view=new DataView(base.buffer);const headerEnd=4+view.getUint32(0)+4;const infoStart=headerEnd+44;const infoSize=Number(view.getBigUint64(headerEnd+24));const keysStart=infoStart+infoSize;const keySize=Number(view.getBigUint64(headerEnd+32));const recordStart=keysStart+keySize;
        const mutations:[number,number,number][]=[[headerEnd+8,0,8],[headerEnd+8,500001,8],[headerEnd+16,300*1024*1024,8],[headerEnd+24,7,8],[infoStart,3,4],[headerEnd+16,infoSize-7,8],[recordStart+8,3,8],[recordStart,3,8],[recordStart+16,1,8],[recordStart+40,300*1024*1024,8],[keysStart+8,999,8]];
        for (const [offset,value,width] of mutations) {const bytes=base.slice();bytes.set(be(value,width),offset);await expect(parseDictionaryFiles([{name:'a.mdx',bytes}])).rejects.toThrow();}
        expect((await parseDictionaryFiles([{name:'a.mdx',bytes:mdictFixture({malformed:'no-encoding',encryption:''})}])).entries).toHaveLength(2);
    });
    it('rejects malformed Yomitan archives while accepting missing optional metadata and readings',async()=>{
        async function archive(metadata:unknown,rows:unknown){const zip=new JSZip();if(metadata!==undefined)zip.file('index.json',JSON.stringify(metadata));zip.file('term_bank_1.json',JSON.stringify(rows));return [{name:'a.zip',bytes:await zip.generateAsync({type:'uint8array'})}];}
        for (const [metadata,rows] of [[undefined,[]],[{},{}],[{},[null]],[{},[[42]]]]) await expect(parseDictionaryFiles(await archive(metadata,rows))).rejects.toThrow();
        const result=await parseDictionaryFiles(await archive({},[['word',null,'','',0,[null,42,{content:'text'}]]]));expect(result.name).toBe('Yomitan');expect(result.entries[0].definition).toBe('text');
    });
    it('limits archive resources and expanded/indexed size before database writes',async()=>{
        const zip=new JSZip();zip.file('index.json','{}');zip.file('term_bank_1.json','[["word","","","",0,["meaning"]]]');for(let index=0;index<5001;index++)zip.file(`${index}.png`,new Uint8Array([1]));
        await expect(parseDictionaryFiles([{name:'a.zip',bytes:await zip.generateAsync({type:'uint8array'})}])).rejects.toThrow('Too many dictionary resources');
        const handlers:Record<string,(value?:unknown)=>void>={};const fake={internalStream:()=>({on:(name:string,listener:(value?:unknown)=>void)=>{handlers[name]=listener;},pause:()=>{},resume:()=>handlers.data({length:256*1024*1024+1})})};
        const load=vi.spyOn(JSZip,'loadAsync').mockResolvedValue({file:()=>fake,files:{}} as any);
        try{await expect(parseDictionaryFiles([{name:'huge.zip',bytes:new Uint8Array([1])}])).rejects.toThrow('decompression limit');}finally{load.mockRestore();}
        await expect(parseDictionaryFiles([file('large.dsl',Array(1000).fill('word').join('\n')+'\n\t'+'x'.repeat(240000))])).rejects.toThrow('index size limit');
        expect(()=>inflateDictionary(gzip(utf8.encode('large')),undefined,2)).toThrow('decompression limit');
    });
});
