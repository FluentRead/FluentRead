import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {matchesNormalizedMaterialSearch, normalizeMaterialSearch, summarizeMaterial} from '@/src/features/vocabulary/materialSummary';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

function material(overrides: Partial<MaterialRecord> = {}): MaterialRecord {
    return {
        id: 'material', identityKey: 'private identity', aliases: ['private alias'], kind: 'article', title: 'Title',
        source: {kind: 'article', url: 'https://example.test/page'}, topics: ['Topic'], references: [],
        createdAt: 1, updatedAt: 2, lastReadAt: 3, archivedAt: null, ...overrides,
    };
}

function oldSearch(record: MaterialRecord, query: string): boolean {
    const search = query.trim().toLocaleLowerCase();
    return !search || [record.title, record.source.url, ...record.topics,
        ...record.references.flatMap(reference => [reference.excerpt, reference.note])].join(' ').toLocaleLowerCase().includes(search);
}

describe('material summaries', () => {
    it('sends only list fields and the untruncated existing preview', () => {
        const excerpt = 'x'.repeat(5000);
        const record = material({references: [{kind: 'note', id: 'private', excerpt, note: 'private note'}]});
        const summary = summarizeMaterial(record);
        expect(summary).toEqual({
            id: 'material', kind: 'article', title: 'Title', sourceUrl: 'https://example.test/page', topics: ['Topic'],
            lastReadAt: 3, updatedAt: 2, archivedAt: null, preview: excerpt, referenceCount: 1,
        });
        summary.topics.push('new');
        expect(record.topics).toEqual(['Topic']);
        expect(summary).not.toHaveProperty('references');
        expect(summary).not.toHaveProperty('identityKey');
        expect(summary).not.toHaveProperty('aliases');
    });

    it('uses the original preview priority even when the first occupied reference has only a note', () => {
        const refs: MaterialRecord['references'] = [
            {kind: 'note', id: 'a'}, {kind: 'note', id: 'b', note: 'first note'},
            {kind: 'note', id: 'c', excerpt: 'later excerpt', note: 'later note'},
        ];
        expect(summarizeMaterial(material({references: refs})).preview).toBe('first note');
        expect(summarizeMaterial(material({references: refs, locator: {kind: 'text', quote: 'location'}})).preview).toBe('location');
        expect(summarizeMaterial(material({references: [{kind: 'note', id: 'd', excerpt: 'first excerpt'}]})).preview).toBe('first excerpt');
        expect(summarizeMaterial(material()).preview).toBe('');
    });

    it('matches the old joined search for field boundaries, missing values, and contextual Unicode casing', () => {
        const records = [
            material({title: 'A', source: {kind: 'article'}, topics: [], references: [{kind: 'note', id: 'n', note: 'B'}]}),
            material({title: 'ΟΣ', source: {kind: 'article', url: 'ΟΣΑ'}, topics: ['ΘΈΜΑ'], references: [{kind: 'note', id: 'n', excerpt: 'ἈΣ', note: 'Σ'}]}),
            material({title: '', source: {kind: 'article'}, topics: ['', 'İ'], references: [{kind: 'note', id: 'n', excerpt: '', note: ''}]}),
        ];
        const queries = ['', ' ', 'A', 'a   b', 'ΟΣ', 'ος', 'οσα', 'Σ', 'σ', 'ς', 'İ', 'i', 'ΘΈΜΑ', 'note', 'no match'];
        for (const record of records) for (const query of queries) {
            expect(matchesNormalizedMaterialSearch(record, normalizeMaterialSearch(query)), JSON.stringify({record, query})).toBe(oldSearch(record, query));
        }
        expect(matchesNormalizedMaterialSearch(records[0], normalizeMaterialSearch('a   b'))).toBe(true);
    });

    it('preserves cross-field spaces, single-code-unit matches and sparse array behavior', () => {
        const topics = new Array<string>(3);topics[1]='ΜΈΣΟ';
        const references = new Array<MaterialRecord['references'][number]>(3);
        references[1]={kind:'note',id:'n',excerpt:'尾\ud83d',note:'\ude00End'};
        const record=material({title:'ΟΣ',source:{kind:'article'},topics,references});
        for(const query of ['ο','ς','σ','ος   μέσο','μέσο   尾','尾\ud83d \ude00end','\ud83d','\ude00','  ','missing'])
            expect(matchesNormalizedMaterialSearch(record,normalizeMaterialSearch(query)),JSON.stringify(query)).toBe(oldSearch(record,query));
        expect(matchesNormalizedMaterialSearch(material({title:'a',source:{kind:'article'},topics:['',''],references:[{kind:'note',id:'n',note:'b'}]}),normalizeMaterialSearch('a     b'))).toBe(true);
    });

    it('keeps original field reads and native join errors even when an earlier field matches', () => {
        const calls:string[]=[];
        const make=()=>material({title:'target',source:{kind:'article',get url(){calls.push('url');return undefined;}},
            references:[{kind:'note',id:'n',get excerpt(){calls.push('excerpt');return 'later';},get note(){calls.push('note');return undefined;}}]});
        expect(oldSearch(make(),'target')).toBe(true);const expected=[...calls];calls.length=0;
        expect(matchesNormalizedMaterialSearch(make(),'target')).toBe(true);expect(calls).toEqual(expected);
        const nullRef=material({title:'target',references:[null as never]});
        expect(()=>oldSearch(nullRef,'target')).toThrow(TypeError);
        expect(()=>matchesNormalizedMaterialSearch(nullRef,'target')).toThrow(TypeError);
        const symbol=material({title:'target',topics:[Symbol('bad') as never]});
        expect(()=>oldSearch(symbol,'target')).toThrow(TypeError);
        expect(()=>matchesNormalizedMaterialSearch(symbol,'target')).toThrow(TypeError);
        const broken={toString(){throw new Error('invalid stored field');}};
        const object=material({title:'target',topics:[broken as never]});
        expect(()=>oldSearch(object,'target')).toThrow('invalid stored field');
        expect(()=>matchesNormalizedMaterialSearch(object,'target')).toThrow('invalid stored field');
        const regex=/target/u;
        expect(()=>matchesNormalizedMaterialSearch(material({title:'target'}),regex as never)).toThrow(TypeError);
        const search={toString(){return 'target';}};
        expect(matchesNormalizedMaterialSearch(material({title:'target'}),search as never)).toBe(true);
    });

    it('matches the original whole-string search under actual default ICU locales', () => {
        const source=readFileSync(new URL('../src/features/vocabulary/materialSummary.ts',import.meta.url),'utf8');
        const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
        const runner=`${compiled}
const {matchesNormalizedMaterialSearch: match, normalizeMaterialSearch: normalize} = module.exports;
const requested=process.env.MATERIAL_CASE_LOCALE,actualLocale=Intl.DateTimeFormat().resolvedOptions().locale;
// On hosts that ignore LC_ALL, call the same native ICU mapping with an explicit locale.
if(!actualLocale.toLowerCase().startsWith(requested)){
 const native=String.prototype.toLocaleLowerCase;
 String.prototype.toLocaleLowerCase=function(){return native.call(this,requested);};
}
const turkish={title:'Σ',source:{url:'I'},topics:[],references:[]};
const turkishWhole=[turkish.title,turkish.source.url].join(' ').toLocaleLowerCase();
if(match(turkish,'ı')!==turkishWhole.includes('ı'))throw Error('mixed ASCII/Unicode case differs');
const unicode=['A','I','İ','i','ı','Σ','Ο','Α','ς','σ','\\u0307','\\u0301','\\u0323','\\u0345','\\u200d','\\ud800','\\udc00','😀',' ', ''];
const ascii=['A','I','i','Z','z','0','9','-',' ', ''];
let seed=0x623ad249;
const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
let units=unicode;
const text=()=>{let out='',n=next()%12;for(let i=0;i<n;i++)out+=units[next()%units.length];return out;};
for(let n=0;n<1000;n++){
 units=n<500?unicode:ascii;
 const r={title:text(),source:{url:n%4?text():undefined},topics:Array.from({length:n%4},text),references:Array.from({length:n%5},()=>({excerpt:n%3?text():undefined,note:n%4?text():undefined}))};
 const whole=[r.title,r.source.url,...r.topics,...r.references.flatMap(x=>[x.excerpt,x.note])].join(' ').toLocaleLowerCase();
 const queries=[text(),whole.slice(next()%(whole.length+1),next()%(whole.length+1)),whole.slice(0,Math.min(whole.length,9)),String.fromCharCode(0xd800+next()%2048),'Σ','I\\u0307','İ','ος','missing'];
 for(const raw of queries){const q=normalize(raw),expected=!q||whole.includes(q),actual=match(r,q);if(expected!==actual)throw Error(JSON.stringify({locale:Intl.DateTimeFormat().resolvedOptions().locale,r,raw,q,whole,expected,actual}));}
}
console.log(JSON.stringify({actualLocale,requested}));`;
        for(const locale of ['en_US.UTF-8','tr_TR.UTF-8','az_AZ.UTF-8','lt_LT.UTF-8','el_GR.UTF-8']) {
            const run=spawnSync(process.execPath,['-e',runner],{encoding:'utf8',timeout:15_000,env:{...process.env,LC_ALL:locale,MATERIAL_CASE_LOCALE:locale.slice(0,2)}});
            expect(run.status,`${locale}: ${run.stderr}`).toBe(0);
            expect(JSON.parse(run.stdout).requested).toBe(locale.slice(0,2));
        }
    });

});
