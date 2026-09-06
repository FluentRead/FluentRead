'use strict';
/** X 页面快照的透明 img + 同级背景图契约，复用隔离生产产物浏览器回归。 */
const assert = require('node:assert/strict');

async function verifyXSurface({page, popup, worker, ui, wait, click, shot, report, originalImage}) {
    let settingsSequence = 0;
    async function patchSettings(config) {
        await popup.evaluate(async ({config, sequence}) => {
            const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
            const expected=Object.fromEntries(Object.keys(config).map(key=>[key,read.value[key]]));
            const response=await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config,expected,
                baseRevision:read.value.__fluentConfigRevision||0,clientId:'x-surface-fixture',sequence});
            if (!response.success) throw new Error(response.error);
        }, {config,sequence:++settingsSequence});
    }
    const surface = page.locator('#x-surface');
    if (originalImage) {
        await page.evaluate(src => {
            const image = document.querySelector('#sample');
            image.src = src;
            document.querySelector('#x-surface').style.backgroundImage = `url("${src}")`;
            image.parentElement.style.width = '449.796px';
        }, originalImage);
    }
    await page.waitForFunction(() => {
        const image = document.querySelector('#sample');
        return image.complete && image.naturalWidth > 0;
    });
    // 从用户授权读取的 X DOM 提取：100% 高度的滚动根节点，其 rect 随整页滚动离开视口。
    await page.evaluate(() => {
        const image = document.querySelector('#sample');
        image.parentElement.style.height = `${image.parentElement.clientWidth * image.naturalHeight / image.naturalWidth}px`;
        document.documentElement.style.cssText = 'height:100%;overflow-x:auto;overflow-y:scroll';
        document.body.style.height = '100%';
        const spacer = document.createElement('div'); spacer.style.height = '2700px';
        document.querySelector('.card').before(spacer);
        window.scrollTo(0, document.querySelector('#x-surface').getBoundingClientRect().top + window.scrollY - 78);
    });
    report.rootScroll = await page.evaluate(() => ({scrollY:window.scrollY,
        rootBottom:document.documentElement.getBoundingClientRect().bottom,
        imageTop:document.querySelector('#x-surface').getBoundingClientRect().top}));
    assert.ok(report.rootScroll.scrollY > 2000); assert.ok(report.rootScroll.rootBottom < 0);
    report.fixture = {kind: 'X snapshot-derived transparent img with matching sibling background', originalImage,
        originalSize: await page.locator('#sample').evaluate(image => [image.naturalWidth, image.naturalHeight])};
    await surface.hover();
    await wait(() => ui(`const overlay=this.querySelector('.fluent-read-image-translation-overlay');
        return !!overlay && getComputedStyle(overlay).display !== 'none';`));
    const position = await ui(`
        const rect = document.querySelector('#x-surface').getBoundingClientRect();
        const button = this.querySelector('.fr-image-controls').getBoundingClientRect();
        return {source:{left:rect.left,bottom:rect.bottom},button:{left:button.left,bottom:button.bottom}};
    `);
    assert.ok(Math.abs(position.button.left-position.source.left-8)<1);
    assert.ok(Math.abs(position.source.bottom-position.button.bottom-8)<1);
    report.cases.push('visible bottom-left action after document-root scroll on X background surface');
    await shot('x-01-hover-action');
    await patchSettings({imageTranslationHoverEnabled:false});
    await page.mouse.move(10,10);
    await wait(() => ui("return !this.querySelector('.fr-image-controls')"));
    await surface.hover();
    await page.waitForTimeout(250);
    assert.equal(await ui("return !!this.querySelector('.fr-image-controls')"),false);

    async function menuAction() {
        // 可信右键建立目标；通过生产消息执行原生菜单动作，OS 菜单项点击未自动化。
        await surface.click({button:'right'});
        await page.keyboard.press('Escape');
        const response=await worker.evaluate(async url => {
            const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
            return chrome.tabs.sendMessage(tab.id,{type:'contextMenuTranslateImage'}, {frameId:0});
        },page.url());
        assert.equal(response?.status,'success');
    }
    await menuAction();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='error'"));
    assert.match(await ui("return this.querySelector('.fr-image-status').textContent"),/首次使用/);
    await page.mouse.move(10,10);
    await page.waitForTimeout(500);
    assert.equal(await ui("return this.querySelector('.fr-image-controls')?.dataset.phase"),'error');
    await shot('x-02-first-use-prompt');
    for (const [language, title] of [['en-US','Image translation'],['ja-JP','画像翻訳'],['ko-KR','이미지 번역'],['fr-FR','Traduction d’images'],['ru-RU','Перевод изображений'],['es-ES','Traducción de imágenes']]) {
        await patchSettings({uiLanguage:language});
        await wait(() => ui(`return this.querySelector('.fr-image-feedback-title').textContent === ${JSON.stringify(`FluentRead · ${title}`)}`));
        const copy=await ui("return this.querySelector('.fr-image-status').textContent");
        const firstUse={'en-US':'first use','ja-JP':'初回','ko-KR':'처음','fr-FR':'première','ru-RU':'первого','es-ES':'primer uso'};
        assert.ok(copy.includes(firstUse[language]));
        const bounds = await ui(`const card=this.querySelector('.fr-image-feedback');
            const r=card.getBoundingClientRect();return {width:r.width,scroll:card.scrollWidth,client:card.clientWidth};`);
        assert.ok(bounds.scroll <= bounds.client + 1);
        await shot(`x-02-first-use-${language}`);
    }
    await patchSettings({uiLanguage:'zh-CN'});
    await wait(() => ui("return this.querySelector('.fr-image-feedback-title').textContent==='FluentRead · 图片翻译'"));
    report.cases.push('FluentRead branding and all seven supported UI languages and prompt changes fit without horizontal overflow');
    await click('关闭');
    await wait(() => ui("return !this.querySelector('.fr-image-controls')"));
    await menuAction();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='error'"));
    report.cases.push('right-click target routing works with hover disabled; missing models prompt persists and closes');
    await ui(`this.__progress=[];const root=this;
        this.__progressObserver=new MutationObserver(()=>{const text=root.querySelector('.fr-image-status')?.textContent;
        if(text&&!root.__progress.includes(text))root.__progress.push(text)});
        this.__progressObserver.observe(this,{subtree:true,childList:true,characterData:true});return true;`);
    const began=Date.now();
    await click('下载语言包并翻译');
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='loading'"));
    const loading=await ui(`
        const feedback=this.querySelector('.fr-image-feedback');
        const spinner=this.querySelector('.fr-image-spinner');
        const r=feedback.getBoundingClientRect(),s=document.querySelector('#x-surface').getBoundingClientRect();
        return {hidden:feedback.hidden,spinner:!!spinner&&!spinner.hidden,
            center:[r.x+r.width/2,r.y+r.height/2],expected:[s.x+s.width/2,s.y+s.height/2]};`);
    assert.equal(loading.hidden,false);assert.equal(loading.spinner,true);
    loading.center.forEach((v,i)=>assert.ok(Math.abs(v-loading.expected[i])<1));
    report.loading=loading;
    await shot('x-03-downloading-models');
    await wait(() => ui("return /识别.*\\d+%/.test(this.querySelector('.fr-image-status')?.textContent) || this.querySelector('.fr-image-controls')?.dataset.phase!=='loading'"),300000);
    const recognitionStatus=await ui("return this.querySelector('.fr-image-status').textContent");
    if (/识别.*\d+%/.test(recognitionStatus)) {
        assert.equal(await surface.evaluate(el=>getComputedStyle(el).opacity),'1');
        report.recognitionStatus=recognitionStatus;
        await shot('x-03-recognizing-progress');
    }
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"),300000);
    report.coldPreparationAndTranslationMs=Date.now()-began;
    report.progress=await ui('return this.__progress');
    assert.ok(report.progress.some(text=>/识别.*\d+%/.test(text)), 'OCR must expose real engine percentages');
    report.downloadedLanguages=await popup.evaluate(async()=>{const read=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:fluentReadImageOcrLanguages'});return read.value;});
    assert.ok(report.downloadedLanguages.includes('jpn'), 'one-click automatic preparation must include Japanese');
    const result=await ui(`
        const bitmap=this.querySelector('.fluent-read-image-translation-overlay img');
        return {surfaceOpacity:getComputedStyle(document.querySelector('#x-surface')).opacity,
            imgOpacity:getComputedStyle(document.querySelector('#sample')).opacity,
            bitmapOpacity:getComputedStyle(bitmap).opacity,fit:getComputedStyle(bitmap).objectFit,
            hidden:getComputedStyle(bitmap.parentElement).display==='none',size:[bitmap.naturalWidth,bitmap.naturalHeight]};`);
    assert.equal(result.surfaceOpacity,'0');assert.equal(result.imgOpacity,'0');
    assert.equal(result.bitmapOpacity,'1');assert.equal(result.fit,'cover');assert.equal(result.hidden,false);
    assert.deepEqual(result.size,report.fixture.originalSize);
    report.replacement=result;
    report.cases.push('one-click Chinese/English/Japanese language preparation continues to real OCR, translation, and visible X replacement');
    await shot('x-04-translated');
    await click('文字');
    report.translatedText=await ui("return this.querySelector('.fr-image-details').textContent");
    assert.match(report.translatedText,/[\u4e00-\u9fff]/);
    await shot('x-05-translated-text');
    await click('文字');
    const requests=await worker.evaluate(()=>globalThis.__imageFixture.requests.length);
    report.requests=await worker.evaluate(()=>globalThis.__imageFixture.requests);
    await menuAction();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='idle'"));
    assert.equal(await surface.evaluate(el=>getComputedStyle(el).opacity),'1');
    assert.equal(await page.locator('#sample').evaluate(el=>getComputedStyle(el).opacity),'0');
    await shot('x-06-restored');
    await menuAction();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"));
    assert.equal(await worker.evaluate(()=>globalThis.__imageFixture.requests.length),requests);
    report.cases.push('right-click restore and cached redisplay preserve the X source DOM');
    await ui('this.__progressObserver?.disconnect();return true;');
}
module.exports={verifyXSurface};
