import {afterEach, describe, expect, it, vi} from 'vitest';
import * as hashModule from '@/src/shared/function/sha256';
import {buildGlossaryRevision, createGlossaryRevisionMemoizer, type GlossaryLibrary} from '@/src/core/glossary';

function library(id = 'technical'): GlossaryLibrary {
    return {id, name: '技术', enabled: true, sourceLanguage: 'en', targetLanguage: 'zh-CN',
        domains: ['EXAMPLE.com.'], entries: [{id: 'term-1', source: 'agent', target: '智能体', caseSensitive: false}]};
}
afterEach(() => vi.restoreAllMocks());

describe('可变词库版本摘要复用', () => {
    it('五千条可变词库逐项复验后只散列一次，克隆相同配置也复用且不修改输入', () => {
        const libraries = Array.from({length: 10}, (_, n) => ({...library(`library-${n}`),
            entries: Array.from({length: 500}, (_, i) => ({id: `term-${i}`, source: `agent ${i}`, target: `智能体 ${i}`, caseSensitive: false}))}));
        const before = structuredClone(libraries), expected = buildGlossaryRevision(libraries, true);
        const hash = vi.spyOn(hashModule, 'sha256Hex');
        const read = createGlossaryRevisionMemoizer();
        for (let i = 0; i < 30; i += 1) expect(read(libraries, true)).toBe(expected);
        expect(read(structuredClone(libraries), true)).toBe(expected);
        expect(hash).toHaveBeenCalledTimes(1);
        expect(libraries).toEqual(before);
    });

    it('原地编辑所有规则、插入、删除与重排始终沿用精确摘要', () => {
        const libraries = [library(), library('second')];
        const read = createGlossaryRevisionMemoizer();
        const verify = () => expect(read(libraries, true)).toBe(buildGlossaryRevision(libraries, true));
        verify();
        const mutations = [
            () => {libraries[0].entries[0].source = 'manager';},
            () => {libraries[0].entries[0].target = '管理器';},
            () => {libraries[0].entries[0].caseSensitive = true;},
            () => {libraries[0].sourceLanguage = 'auto';},
            () => {libraries[0].targetLanguage = 'zh-Hans';},
            () => {libraries[0].domains[0] = '*.example.org';},
            () => {libraries[0].domains.push('invalid domain');},
            () => {libraries[0].enabled = false;},
            () => {libraries[0].id = 'changed';},
            () => {libraries[0].entries.unshift({id: 'prepended', source: 'API', target: '接口', caseSensitive: false});},
            () => {libraries[0].entries.reverse();},
            () => {libraries.unshift(library('prepended'));},
            () => {libraries.reverse();},
            () => {libraries[0].entries.pop();},
            () => {libraries.pop();},
            () => {libraries.length = 0;},
        ];
        mutations.forEach(mutate => {mutate(); verify(); verify();});
    });

    it('元数据与条目ID变化会重新核对，版本仍只反映实际语义', () => {
        const libraries = [library()], read = createGlossaryRevisionMemoizer();
        const hash = vi.spyOn(hashModule, 'sha256Hex');
        const original = read(libraries, true);
        libraries[0].name = '新的展示名称'; libraries[0].entries[0].id = 'new-entry';
        expect(read(libraries, true)).toBe(original);
        libraries[0].preset = {id: 'technical', version: 1};
        expect(read(libraries, true)).toBe(original);
        libraries[0].preset.version = 2;
        expect(read(libraries, true)).toBe(original);
        libraries[0].preset = undefined;
        expect(read(libraries, true)).toBe(original);
        delete libraries[0].preset;
        expect(read(libraries, true)).toBe(original);
        expect(hash).toHaveBeenCalledTimes(5);
    });

    it('关闭期间原地改变规则，重新启用时读取当前值，memo实例彼此隔离', () => {
        const libraries = [library()], first = createGlossaryRevisionMemoizer(), second = createGlossaryRevisionMemoizer();
        const before = first(libraries, true);
        expect(first(libraries, false)).toBe('glossary-v1:disabled');
        expect(first(libraries, undefined)).toBe('glossary-v1:disabled');
        libraries[0].entries[0].target = '新译名';
        expect(first(libraries, true)).toBe(second(libraries, true));
        expect(first(libraries, true)).not.toBe(before);
    });

    it('Unicode清洗、语言别名、无效或重复ID及来源裁剪保持原算法语义', () => {
        const read = createGlossaryRevisionMemoizer();
        const libraries = [library(), library('technical')];
        libraries[0].id = 'bad id';
        libraries[0].entries.push({id: 'term-1', source: ' cafe\u0301\u0000 ', target: '文'.repeat(250), caseSensitive: true});
        libraries[0].entries[0].source = ' ';
        libraries[0].targetLanguage = 'zh-SG';
        const before = read(libraries, true);
        expect(before).toBe(buildGlossaryRevision(libraries, true));
        libraries[0].targetLanguage = 'zh-Hans';
        expect(read(libraries, true)).toBe(before);
        libraries[0].entries[1].source = 'café';
        expect(read(libraries, true)).toBe(before);
        libraries[0].id = 'glossary-1';
        expect(read(libraries, true)).toBe(buildGlossaryRevision(libraries, true));
    });

    it('只复用自有普通数据字段，null原型规则也精确支持', () => {
        const source = library();
        const libraries = [Object.assign(Object.create(null), source)];
        libraries[0].entries = source.entries.map(entry => Object.assign(Object.create(null), entry));
        const read = createGlossaryRevisionMemoizer(), expected = buildGlossaryRevision(libraries, true);
        const hash = vi.spyOn(hashModule, 'sha256Hex');
        expect(read(libraries, true)).toBe(expected);
        expect(read(libraries, true)).toBe(expected);
        expect(hash).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['缺省词库', (): undefined => undefined], ['非数组词库', () => ({})],
        ['数组子类', () => new (class Libraries extends Array {})()],
        ['过多词库', () => Array.from({length: 21}, (_, i) => library(`library-${i}`))],
        ['无效词库', () => [null]], ['非对象词库', () => [true]],
        ['缺失自有字段', () => [{}]],
        ['词库自定义原型', () => [Object.assign(Object.create({marker: true}), library())]],
        ['缺失字符串', () => [{...library(), sourceLanguage: undefined}]],
        ['缺失开关', () => [{...library(), enabled: undefined}]],
        ['无效preset', () => [{...library(), preset: null}]],
        ['无效preset ID', () => [{...library(), preset: {id: 1, version: 2}}]],
        ['无效preset版本', () => [{...library(), preset: {id: 'technical', version: '2'}}]],
        ['过长库ID', () => [{...library(), id: 'i'.repeat(81)}]],
        ['过长库名', () => [{...library(), name: 'n'.repeat(161)}]],
        ['过长语言', () => [{...library(), sourceLanguage: 'a'.repeat(41)}]],
        ['过长preset ID', () => [{...library(), preset: {id: 'i'.repeat(81), version: 1}}]],
        ['非数组域名', () => [{...library(), domains: 'example.com'}]],
        ['域名数组子类', () => [{...library(), domains: new (class Domains extends Array {})()}]],
        ['过多域名', () => [{...library(), domains: Array.from({length: 51}, () => 'example.com')}]],
        ['无效域名类型', () => [{...library(), domains: [null]}]],
        ['过长原始域名', () => [{...library(), domains: ['d'.repeat(257)]}]],
        ['非数组条目', () => [{...library(), entries: null}]],
        ['条目数组子类', () => [{...library(), entries: new (class Entries extends Array {})()}]],
        ['过多条目', () => [{...library(), entries: Array.from({length: 501}, () => library().entries[0])}]],
        ['总量超限', () => Array.from({length: 11}, (_, i) => ({...library(`library-${i}`), entries: Array.from({length: 500}, () => library().entries[0])}))],
        ['无效条目', () => [{...library(), entries: [null]}]],
        ['缺失条目字段', () => [{...library(), entries: [{...library().entries[0], target: undefined}]}]],
        ['过长条目ID', () => [{...library(), entries: [{...library().entries[0], id: 'i'.repeat(81)}]}]],
        ['过长原始来源', () => [{...library(), entries: [{...library().entries[0], source: 's'.repeat(401)}]}]],
        ['过长原始译名', () => [{...library(), entries: [{...library().entries[0], target: '文'.repeat(401)}]}]],
        ['无效大小写开关', () => [{...library(), entries: [{...library().entries[0], caseSensitive: 'true'}]}]],
    ] as const)('%s 回退精确算法且不污染此前的可复用镜像', (_name, input) => {
        const read = createGlossaryRevisionMemoizer(), valid = [library()];
        const previous = read(valid, true);
        const invalid = input() as GlossaryLibrary[];
        expect(read(invalid, true)).toBe(buildGlossaryRevision(invalid, true));
        expect(read(invalid, true)).toBe(buildGlossaryRevision(invalid, true));
        expect(read(valid, true)).toBe(previous);
    });

    it.each(['id', 'enabled', 'preset', 'entries', 'entry-source', 'domain-index', 'library-index'])('%s访问器回退后恢复普通数据不混用摘要', field => {
        const libraries = [library()], read = createGlossaryRevisionMemoizer();
        const original = read(libraries, true);
        const object = field === 'entry-source' ? libraries[0].entries[0] : field === 'domain-index' ? libraries[0].domains
            : field === 'library-index' ? libraries : libraries[0];
        const key = field === 'entry-source' ? 'source' : ['domain-index', 'library-index'].includes(field) ? '0' : field;
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        const value = field === 'id' ? 'new-id' : field === 'enabled' ? false : field === 'preset' ? {id: 'technical', version: 1}
            : field === 'entries' ? [{...library().entries[0], target: '新译名'}] : field === 'entry-source' ? 'manager'
                : field === 'domain-index' ? 'new.example' : library('new-id');
        Object.defineProperty(object, key, {configurable: true, get: () => value});
        expect(read(libraries, true)).toBe(buildGlossaryRevision(libraries, true));
        if (descriptor) Object.defineProperty(object, key, descriptor);
        else Reflect.deleteProperty(object, key);
        expect(read(libraries, true)).toBe(original);
    });

    it.each(['libraries', 'entries', 'domains'])('%s 的自定义 slice/constructor 不会被普通数据镜像误复用', field => {
        const libraries = [library()], read = createGlossaryRevisionMemoizer();
        const original = read(libraries, true);
        const array = field === 'libraries' ? libraries : field === 'entries' ? libraries[0].entries : libraries[0].domains;
        Object.defineProperty(array, 'constructor', {configurable: true, value: Array});
        expect(read(libraries, true)).toBe(buildGlossaryRevision(libraries, true));
        Reflect.deleteProperty(array, 'constructor');
        const replacement = field === 'libraries' ? [library('replaced')]
            : field === 'entries' ? [{...library().entries[0], target: '新译名'}] : ['new.example'];
        Object.defineProperty(array, 'slice', {configurable: true, value: () => replacement});
        expect(read(libraries, true)).toBe(buildGlossaryRevision(libraries, true));
        expect(read(libraries, true)).not.toBe(original);
        Reflect.deleteProperty(array, 'slice');
        expect(read(libraries, true)).toBe(original);
    });
});
