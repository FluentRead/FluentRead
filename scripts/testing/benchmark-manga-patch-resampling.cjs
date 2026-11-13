'use strict';
/**
 * 漫画修补补丁的几何对照：执行指定提交与当前源码中的实际张量准备和回填函数。
 * 恒等模型、小尺寸纹理、棋盘缩小及理想渐变只证明重采样正确性，不代表真实 LaMa 的背景生成质量。
 * 用法：node scripts/testing/benchmark-manga-patch-resampling.cjs --before-ref <commit> --out-dir <新证据目录>
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),ts=require('typescript'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'../..'),args={};
for(let index=2;index<process.argv.length;index+=2){const key=process.argv[index],value=process.argv[index+1];
 if(!['--before-ref','--out-dir'].includes(key)||!value||args[key])throw Error('参数无效：'+key);args[key]=value;
}
assert.ok(args['--before-ref']&&args['--out-dir'],'需要 before-ref 和 out-dir');
const before=execFileSync('git',['rev-parse','--verify',args['--before-ref']+'^{commit}'],{cwd:root,encoding:'utf8'}).trim();
const directory=path.resolve(args['--out-dir']);fs.mkdirSync(directory,{recursive:false});
const sourceFile='src/features/image-translation/services/mangaInpainting.ts',maskFile='src/features/image-translation/mangaPatchResult.ts';
const source=(file,old)=>old?execFileSync('git',['show',`${before}:${file}`],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,file),'utf8');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function extract(text,name){const file=ts.createSourceFile('patch.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const node=file.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text===name);
 assert.ok(node,'缺少生产函数 '+name);return node.getText(file).replace(/^export\s+/u,'');
}
function load(old){const text=source(sourceFile,old),mask=source(maskFile,old);
 const code=extract(mask,'mangaMaskBoxes')+'\nconst maskBoxes=mangaMaskBoxes;\n'
  +['uniformMaskAlpha','createMangaPatch','applyMangaPatch'].map(name=>extract(text,name)).join('\n');
 const api=new Function(esbuild.transformSync(code,{loader:'ts'}).code+';return {createMangaPatch,applyMangaPatch,maskBoxes};')();
 fs.writeFileSync(path.join(directory,old?'before.ts':'after.ts'),text);
 return {...api,sourceSha256:sha(text),maskSha256:sha(mask)};
}
function pixels(width,height,paint){const data=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)data.set([...paint(x,y),255],(y*width+x)*4);return data;
}
function errors(actual,expected,width,height,boxes){let squared=0,samples=0,max=0,outsideChanges=0,alphaChanges=0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const inside=boxes.some(box=>x>=box.x0&&x<box.x1&&y>=box.y0&&y<box.y1),offset=(y*width+x)*4;
  if(actual[offset+3]!==expected[offset+3])alphaChanges++;
  for(let channel=0;channel<3;channel++){const delta=Math.abs(actual[offset+channel]-expected[offset+channel]);
   if(inside){squared+=delta*delta;samples++;max=Math.max(max,delta);}else if(delta)outsideChanges++;
  }
 }
 return{rmse:Math.sqrt(squared/Math.max(samples,1)),max,samples,outsideChanges,alphaChanges};
}
function run(api){const rows=[];
 for(const[width,height]of [[137,91],[512,509]]){
  const input=pixels(width,height,(x,y)=>[(x*17+y*31)%256,(x*11+y*3)%256,(x+y*7)%256]);
  const region={text:'controlled identity texture',fontSize:12,bbox:{x0:0,y0:0,x1:width,y1:height}};
  const mapping=api.createMangaPatch(input,width,height,region),output=input.slice();
  api.applyMangaPatch(output,width,region,mapping,mapping.patch.image);
  rows.push({case:`identity-${width}x${height}`,inputSha256:sha(input),source:[mapping.sourceWidth,mapping.sourceHeight],content:[mapping.contentWidth??mapping.patch.width,mapping.contentHeight??mapping.patch.height],tensor:[mapping.patch.width,mapping.patch.height],...errors(output,input,width,height,api.maskBoxes(region,width,height))});
 }
 {
  const width=1024,height=1024,input=pixels(width,height,(x,y)=>(x+y)%2?[230,120,20]:[10,180,230]);
  const mapping=api.createMangaPatch(input,width,height,{text:'controlled checker',fontSize:12,bbox:{x0:0,y0:0,x1:width,y1:height}});
  const count=mapping.patch.width*mapping.patch.height,expected=[120,150,125];let squared=0,max=0;
  for(let channel=0;channel<3;channel++)for(let index=0;index<count;index++){
   const delta=Math.abs(mapping.patch.image[channel*count+index]*255-expected[channel]);squared+=delta*delta;max=Math.max(max,delta);
  }
  rows.push({case:'checker-area-average',inputSha256:sha(input),tensor:[mapping.patch.width,mapping.patch.height],rmse:Math.sqrt(squared/(count*3)),max});
 }
 {
  const width=1537,height=301,input=pixels(width,height,()=>[255,255,255]);
  const region={text:'controlled ideal ramp',fontSize:12,bbox:{x0:40,y0:40,x1:1490,y1:260}};
  const mapping=api.createMangaPatch(input,width,height,region),{patch,left,top,sourceWidth,sourceHeight}=mapping;
  const cw=mapping.contentWidth??patch.width,ch=mapping.contentHeight??patch.height,count=patch.width*patch.height,model=new Float32Array(count*3).fill(1);
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const at=y*patch.width+x;model[at]=.1+.6*(x+.5)/cw;model[count+at]=.1+.5*(y+.5)/ch;model[count*2+at]=.4;}
  const expected=input.slice(),boxes=api.maskBoxes(region,width,height);
  for(const box of boxes)for(let y=box.y0;y<box.y1;y++)for(let x=box.x0;x<box.x1;x++)expected.set([
   Math.round((.1+.6*(x-left+.5)/sourceWidth)*255),Math.round((.1+.5*(y-top+.5)/sourceHeight)*255),102,255,
  ],(y*width+x)*4);
  const output=input.slice();api.applyMangaPatch(output,width,region,mapping,model);
  rows.push({case:'ideal-ramp-return',source:[sourceWidth,sourceHeight],content:[cw,ch],tensor:[patch.width,patch.height],...errors(output,expected,width,height,boxes)});
 }
 return rows;
}
const original=load(true),current=load(false),baseline=run(original),candidate=run(current);
assert.ok(candidate.slice(0,2).every(row=>row.rmse===0&&row.outsideChanges===0&&row.alphaChanges===0),'小补丁恒等往返须逐字节一致');
assert.ok(candidate[2].max<.0001,'棋盘平均颜色不能混叠');
assert.ok(candidate[3].max<=1&&candidate[3].outsideChanges===0&&candidate[3].alphaChanges===0,'渐变回填只允许量化误差');
const report={beforeCommit:before,sourceFile,sourceBeforeSha256:original.sourceSha256,sourceAfterSha256:current.sourceSha256,
 scope:'Actual production resampling functions with controlled identity/ideal-output models; no OCR, model inference, font or real-image reconstruction quality claim.',baseline,candidate,
 references:['https://raw.githubusercontent.com/advimman/lama/main/saicinpainting/evaluation/data.py','https://onnx.ai/onnx/operators/onnx__Resize.html#attributes'],
 runtime:{node:process.version,platform:process.platform,arch:process.arch}};
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({beforeCommit:before,baseline,candidate,report:path.join(directory,'report.json')}));
