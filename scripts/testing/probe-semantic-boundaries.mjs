import fs from 'node:fs';
import ts from 'typescript';
import crypto from 'node:crypto';
const sourceFile = process.argv[3] || 'src/features/video-subtitle/semanticSegmentation.ts';
const source = fs.readFileSync(sourceFile, 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
const {createSemanticDocument, segmentSemanticDocument} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const dir=process.argv[2];
if (!dir) throw new Error('Usage: node scripts/testing/probe-semantic-boundaries.mjs INPUT_DIR [SOURCE_TS]');
const canonical=(text,end)=>{while(end>0 && /\s/u.test(text[end-1]))end--;return end;};
function evaluate(records, separator){
 let text='',gold=[];
 for(let i=0;i<records.length;i++){text+=records[i].text;if(i<records.length-1){gold.push(canonical(text,text.length));text+=separator;}}
 const doc=createSemanticDocument([{text,startMs:0,durationMs:1000}]);
 const units=segmentSemanticDocument(doc);
 const truth=new Set(gold), predicted=new Set(units.slice(0,-1).map(u=>canonical(text,u.end)));
 const candidates=new Set(doc.boundaries.map(b=>canonical(text,b.offset)));
 const scores=new Map(doc.boundaries.map(b=>[b.offset,b.score]));
 const strong=new Set(units.slice(0,-1).filter(u=>scores.get(u.end)>0).map(u=>canonical(text,u.end)));
 const score=ps=>({tp:[...ps].filter(x=>truth.has(x)).length,fp:[...ps].filter(x=>!truth.has(x)).length,fn:[...truth].filter(x=>!ps.has(x)).length});
 return {ids:records.map(r=>r.sent_id),chars:text.length,gold:truth.size,all:score(predicted),strong:score(strong),missingCandidateGold:[...truth].filter(x=>!candidates.has(x)).length,exact:predicted.size===truth.size&&[...truth].every(x=>predicted.has(x)),preserved:units.map(u=>u.text).join('')===text,fragments:units.filter(u=>!u.complete).length};
}
function summarize(cases){let s={groups:cases.length,errors:cases.filter(c=>c.error).length,preserved:0,exact:0,gold:0,missingCandidateGold:0,fragments:0,all:{tp:0,fp:0,fn:0},strong:{tp:0,fp:0,fn:0}};
for(const c of cases){if(c.error)continue;for(const k of ['preserved','exact','gold','missingCandidateGold','fragments'])s[k]+=Number(c[k]);for(const mode of ['all','strong'])for(const k of ['tp','fp','fn'])s[mode][k]+=c[mode][k];}
for(const mode of ['all','strong']){let a=s[mode];a.precision=a.tp+a.fp?a.tp/(a.tp+a.fp):null;a.recall=a.tp+a.fn?a.tp/(a.tp+a.fn):null;a.f1=2*a.tp+a.fp+a.fn?2*a.tp/(2*a.tp+a.fp+a.fn):null;}return s;}
const results={algorithm:process.env.ALGORITHM_LABEL || 'current-source',sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),node:process.version,icu:process.versions.icu,locale:new Intl.Segmenter().resolvedOptions().locale,languages:{}};
for(const name of ['en_ewt','zh_gsd','ja_gsd']){
 const input=JSON.parse(fs.readFileSync(`${dir}/${name}.json`));const language=input.language,separator=language==='en'?' ':'';
 const groups=[];
 if(language==='en'){let current=[],key;for(const r of input.records){const next=`${r.document_id}/${r.paragraph_id}`;if(current.length&&(next!==key||current.length===5)){groups.push(current);current=[];}current.push(r);key=next;}if(current.length)groups.push(current);}
 else for(let i=0;i<input.records.length;i+=5)groups.push(input.records.slice(i,i+5));
 const run=groups=>groups.map(rs=>{try{return evaluate(rs,separator)}catch(e){return {ids:rs.map(r=>r.sent_id),error:String(e)}}});
 const single=run(input.records.map(r=>[r])),multi=run(groups);
 results.languages[language]={dataset:input.dataset,sourceCommit:input.source_commit,multiContinuity:language==='en'?'original document/paragraph order, chunks at most5':'synthetic adjacency, groups5',single:summarize(single),multi:summarize(multi),cases:{single,multi}};
}
fs.writeFileSync(`${dir}/${process.env.RESULT_NAME || "results.json"}`,JSON.stringify(results,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.languages).map(([k,v])=>[k,{single:v.single,multi:v.multi}]))));
