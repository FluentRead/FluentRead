'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// 自拟中文扫描语料：真 OCR、双栏、低清和倾斜页面；使用主运行器的临时浏览器及诊断。
const {PDFDocument}=require('pdf-lib');
module.exports=async function runCorpus({page,load,openSettings,shot,report,fixture,artifactsDir}){
  const changeConfig=async patch=>{
    const result=await page.evaluate(async patch=>{
      const stored=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});if(!stored.success)throw new Error(stored.error);
      const current=typeof stored.value==='string'?JSON.parse(stored.value):stored.value;
      return chrome.runtime.sendMessage({type:'persistConfig',mode:'replace',baseRevision:current.__fluentConfigRevision,clientId:`corpus-${crypto.randomUUID()}`,sequence:1,config:{...current,...patch}});
    },patch);assert(result.success,result.error);
  };
  await changeConfig({from:'zh-Hans',to:'en'});
  await page.addInitScript(()=>{
    const Original=globalThis.Worker;globalThis.__corpusOcr=[];
    globalThis.Worker=new Proxy(Original,{construct(target,args){const worker=new target(...args);worker.addEventListener('message',event=>{
      const value=event.data;if(value?.action==='recognize'&&value.status==='resolve'&&value.data?.blocks&&globalThis.__corpusOcr.length<256){
        globalThis.__corpusOcr.push({text:value.data.text,confidence:value.data.confidence,blocks:value.data.blocks});
      }
    });return worker;}});
  });
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.file-drop-zone').waitFor();
  const paragraphs=[
    '本研究比较不同采样频率下的测量误差。实验共包含128个样本，每个样本重复测量3次。所有结果均保留原始单位，不对缺失数值进行推断。',
    '在相同实验条件下，方法甲的平均误差为0.12，方法乙为0.18。误差降低不代表计算成本一定减少，仍需结合运行时间进行比较。',
    '图像由扫描设备采集，文字识别仅用于生成可编辑原文。读者可以对照原图核对数字、单位和专业术语，并保存人工校订。',
    '结果显示，低分辨率主要影响细小标点和相近字形。不能确认的内容应提示复核，而不是补写一个看似合理的数值。',
  ];
  const rows=[['方法','样本数量','平均误差','耗时（ms）'],['方法甲','128','0.12','25.4'],['方法乙','128','0.18','20.1'],['方法丙','256','0.09','38.6']];
  const cases=[{name:'clean-300dpi',dpi:300,quality:1,angle:0,ink:20},{name:'compressed-150dpi',dpi:150,quality:.55,angle:0,ink:35},{name:'lowcontrast-100dpi',dpi:100,quality:.35,angle:0,ink:85},{name:'skewed-150dpi',dpi:150,quality:.65,angle:.7,ink:30}];
  const source=await page.evaluate(async({paragraphs,rows,cases})=>{
    await document.fonts.ready;
    const results=[];
    for(const variant of cases){
      const scale=variant.dpi/72,canvas=document.createElement('canvas');canvas.width=Math.round(595*scale);canvas.height=Math.round(842*scale);
      const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.scale(scale,scale);
      ctx.translate(297.5,421);ctx.rotate(variant.angle*Math.PI/180);ctx.translate(-297.5,-421);
      ctx.fillStyle=`rgb(${variant.ink},${variant.ink},${variant.ink})`;ctx.textBaseline='top';
      const font=size=>ctx.font=`${size}px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
      const lines=[];
      function wrap(text,x,y,width,size=11){font(size);const tokens=text.match(/[A-Za-z0-9]+(?:[.,][0-9]+)*|./gu)||[];let line='',row=0;
        for(const token of tokens){if(line&&ctx.measureText(line+token).width>width){ctx.fillText(line,x,y+row*size*1.55);lines.push({text:line,x,y:y+row*size*1.55,size});line='';row++;}line+=token;}
        if(line){ctx.fillText(line,x,y+row*size*1.55);lines.push({text:line,x,y:y+row*size*1.55,size});}
      }
      font(18);ctx.fillText('扫描论文识别与翻译实验',45,42);font(10);ctx.fillText('自拟样例 · 双栏正文、数据表与脚注',45,76);
      wrap(paragraphs[0],45,118,236);wrap(paragraphs[1],45,258,236);wrap(paragraphs[2],314,118,236);wrap(paragraphs[3],314,258,236);
      font(11);ctx.fillText('表1 实验测量结果（数值仅为测试样例）',45,414);
      for(let r=0;r<rows.length;r++)for(let c=0;c<rows[r].length;c++){font(10.5);ctx.fillText(rows[r][c],[56,225,350,477][c],452+r*32);}
      wrap('注：本文所有样本、数字和结论均为自拟测试内容，不代表真实研究结果。',45,716,505,8);
      font(8.5);ctx.fillText('Accuracy is not the same as precision. No missing value was imputed.',45,752);
      const png=canvas.toDataURL(variant.quality===1?'image/png':'image/jpeg',variant.quality);
      results.push({variant,lines,image:png});canvas.width=canvas.height=0;
    }return results;
  },{paragraphs,rows,cases});
  const pdf=await PDFDocument.create();for(const [i,item]of source.entries()){
    const bytes=Buffer.from(item.image.split(',')[1],'base64');fs.writeFileSync(path.join(artifactsDir,`${item.variant.name}.${item.variant.quality===1?'png':'jpg'}`),bytes);
    const image=item.variant.quality===1?await pdf.embedPng(bytes):await pdf.embedJpg(bytes);pdf.addPage([595,842]).drawImage(image,{x:0,y:0,width:595,height:842});delete item.image;
  }
  fs.writeFileSync(path.join(artifactsDir,'ground-truth.json'),JSON.stringify({paragraphs,rows,pages:source},null,2));
  const bytes=Buffer.from(await pdf.save());fs.writeFileSync(path.join(artifactsDir,'chinese-scan-corpus.pdf'),bytes);await load('chinese-scan-corpus.pdf',bytes);
  const read=()=>page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('FluentReadDocumentHistory');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{const records=await new Promise((resolve,reject)=>{const r=db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const r=records.find(r=>r.name==='chinese-scan-corpus.pdf');return r?{segments:r.parsed.segments,pages:r.parsed.binary.pages,translations:r.translations}:null;}finally{db.close();}});
  const pageInput=page.locator('.pdf-page-navigation input');report.ocrPages=[];
  for(let index=0;index<cases.length;index++){
    await pageInput.fill(String(index+1));await pageInput.press('Enter');await openSettings();
    await page.evaluate(()=>{globalThis.__corpusOcr=[];});
    const since=Date.now();await page.locator('.document-settings-dialog[open]').getByRole('button',{name:`重新识别当前页（${index+1}）`,exact:true}).click();
    await page.locator('.taskbar-toast').filter({hasText:'当前页已重新识别'}).waitFor({timeout:240000});
    let current;for(let attempt=0;attempt<60;attempt++){current=await read();if(current?.pages[index].ocrRecognized)break;await page.waitForTimeout(250);}
    assert(current?.pages[index].ocrRecognized,'页识别应保存');
    report.ocrPages.push({variant:cases[index],milliseconds:Date.now()-since,page:current.pages[index],segments:current.pages[index].segmentIndexes.map(i=>current.segments[i])});
    fs.writeFileSync(path.join(artifactsDir,'recognized-corpus.json'),JSON.stringify(current,null,2));
    fs.writeFileSync(path.join(artifactsDir,`raw-ocr-page-${index+1}.json`),JSON.stringify(await page.evaluate(()=>globalThis.__corpusOcr),null,2));
    await page.getByLabel('阅读方式',{exact:true}).getByRole('button',{name:'原文',exact:true}).click();
    const target=page.locator(`.pdf-page-row[data-page-number="${index+1}"] [data-pdf-ocr-line]`).filter({hasText:'扫描论文识别与翻译实验'}).first();
    await target.waitFor();await target.scrollIntoViewIfNeeded();
    const box=await target.boundingBox(),expected=await target.textContent();assert(box,'中文选择行应可见');
    await page.mouse.move(box.x+.2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width-.2,box.y+box.height/2,{steps:12});await page.mouse.up();
    assert.equal(await page.evaluate(()=>getSelection().toString().trim()),expected.trim(),'实际鼠标应选到复核后的中文原文');
    await shot(`corpus-${cases[index].name}`);await page.evaluate(()=>getSelection().removeAllRanges());
  }
  assert.equal(fixture.state.requests.length,0,'识别本身不应发送翻译请求');

  const normalized=text=>text.replace(/\s/gu,'');
  for(const [index,entry]of report.ocrPages.entries()){
    assert(entry.segments.some(segment=>segment.source==='扫描论文识别与翻译实验'),'所有清晰度的标题都应恢复完整');
    if(index<2)for(const paragraph of paragraphs)assert(entry.segments.some(segment=>normalized(segment.source)===normalized(paragraph)),`清晰/150dpi 正文应完整成段：${paragraph}`);
    if(index===3)for(const [number,prefix]of ['本研究','在相同','图像由','结果显示'].entries()){
      const segment=entry.segments.find(segment=>segment.source.startsWith(prefix));assert(segment&&normalized(segment.source).length>=normalized(paragraphs[number]).length*.98,`倾斜扫描应保留完整段落 ${prefix}`);
    }
    const cells=entry.page.blocks.map(block=>block.source);for(const value of ['128','256','0.12','0.18','0.09','25.4','20.1','38.6'])assert(cells.includes(value),`第 ${index+1} 页数值丢失 ${value}`);
    for(const block of entry.page.blocks.filter(block=>['方法两','方法己'].includes(block.source)))assert(entry.page.ocrReviewRegions.some(r=>r.x<block.x+block.width&&r.x+r.width>block.x&&r.y<block.y+block.height&&r.y+r.height>block.y),'未确认的方法标签必须显示核对位置');
  }
  assert(report.ocrPages[2].page.ocrReviewRegions.length>0,'低清页必须保留不确定位置');
  report.cases.push('four self-authored Chinese paper scans captured through explicit real OCR: 300 dpi, compressed 150 dpi, low-contrast 100 dpi and 0.7-degree skew');
  report.qualityAssessment={cleanAnd150dpiBodyComplete:true,skewedParagraphsComplete:true,headersRestored:true,correctedChinesePointerSelection:true,tableNumericCellsPreserved:true,lowQualityReviewVisible:true,borderlessTableReadingOrder:'separate unresolved work; not claimed as passed'};
};
