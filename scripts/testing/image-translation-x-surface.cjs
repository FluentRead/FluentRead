'use strict';
/** X 页面快照的透明 img + 同级背景图契约，复用隔离生产产物浏览器回归。 */
const assert = require('node:assert/strict');

const xBitmap = `(paintRoot?.querySelector('img') ?? this.querySelector('.fluent-read-image-translation-overlay img'))`;

async function verifyXScroll({page, ui, wait, report, surface}) {
    const bitmapAndSource = `
        const source = document.querySelector('#x-surface');
        const bitmap = ${xBitmap};
        const owner = paintRoot?.host;
        const position = () => ({
            sourceTop: source.getBoundingClientRect().top,
            bitmapTop: bitmap.getBoundingClientRect().top,
        });
    `;
    const probe = async scroller => {
        const before = await ui(`
            ${bitmapAndSource}
            const scroller = ${scroller};
            const initial = scroller.scrollTop;
            const before = position();
            // 在同一个 JS 调用栈内读取滚动前后几何，扩展的 scroll/rAF 逻辑不能参与位移。
            scroller.scrollTop += 36;
            const after = position();
            const delta = scroller.scrollTop - initial;
            scroller.scrollTop = initial;
            const samples = [];
            const observe = event => {
                if (event.target !== scroller && !(scroller === document.scrollingElement && event.target === document)) return;
                const {sourceTop, bitmapTop} = position();
                samples.push({scrollTop: scroller.scrollTop, delta: Math.abs(sourceTop - bitmapTop)});
            };
            window.addEventListener('scroll', observe, true);
            this.__scrollProbe = {samples, stop: () => window.removeEventListener('scroll', observe, true)};
            return {
                sameContainingBlock: owner?.parentElement === source.parentElement && owner.offsetParent === source.parentElement,
                positioning: owner ? getComputedStyle(owner).position : getComputedStyle(bitmap.parentElement).position,
                initial, delta, sourceDelta: after.sourceTop - before.sourceTop,
                bitmapDelta: after.bitmapTop - before.bitmapTop,
            };
        `);
        const rect = await surface.boundingBox();
        assert.ok(rect);
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.wheel(0, 36);
        await wait(() => ui(`return ${scroller}.scrollTop > ${before.initial};`));
        const wheel = await ui(`
            ${bitmapAndSource}
            const samples = this.__scrollProbe.samples.filter(sample => sample.scrollTop > ${before.initial});
            this.__scrollProbe.stop();
            delete this.__scrollProbe;
            const {sourceTop, bitmapTop} = position();
            const delta = ${scroller}.scrollTop - ${before.initial};
            ${scroller}.scrollTop = ${before.initial};
            return {delta, samples, finalOffset: Math.abs(sourceTop - bitmapTop)};
        `);
        return {...before, wheel};
    };

    const root = await probe('document.scrollingElement');
    await page.evaluate(() => {
        const photo = document.querySelector('#x-surface').parentElement;
        const scroller = document.createElement('div');
        scroller.id = 'x-image-scroll-fixture';
        scroller.style.cssText = `overflow:auto;overscroll-behavior:contain;height:${photo.offsetHeight + 112}px`;
        const spacer = document.createElement('div');
        const tail = document.createElement('div');
        spacer.style.height = '80px';
        tail.style.height = '240px';
        photo.before(scroller);
        scroller.append(spacer, photo, tail);
        scroller.scrollTop = 32;
    });
    await wait(() => ui(`${bitmapAndSource}
        const {sourceTop, bitmapTop} = position();
        return Math.abs(sourceTop - bitmapTop) < 1;
    `));
    const nested = await probe("document.querySelector('#x-image-scroll-fixture')");
    await page.evaluate(() => {
        const photo = document.querySelector('#x-surface').parentElement;
        document.querySelector('#x-image-scroll-fixture').replaceWith(photo);
    });
    report.scrollAlignment = {root, nested};
    // 恢复夹具后等全局操作条同步，后续点击使用实际屏幕坐标。
    await wait(() => ui(`
        const source = document.querySelector('#x-surface').getBoundingClientRect();
        const controls = this.querySelector('.fr-image-controls').getBoundingClientRect();
        return Math.abs(source.bottom - controls.bottom - 8) <= 1;
    `));
    for (const {sameContainingBlock, positioning, delta, sourceDelta, bitmapDelta, wheel} of [root, nested]) {
        assert.ok(delta >= 30, 'fixture must move the source before the next animation frame');
        assert.ok(Math.abs(sourceDelta + delta) <= 1 && Math.abs(bitmapDelta - sourceDelta) <= 1,
            `译图应同步随图片滚动：原图 ${sourceDelta}px，译图 ${bitmapDelta}px`);
        assert.equal(sameContainingBlock, true, '译图宿主应和原背景图共用图片容器');
        assert.equal(positioning, 'absolute');
        assert.ok(wheel.samples.length > 0 && wheel.samples.every(sample => sample.delta <= 1) && wheel.finalOffset <= 1,
            '可信滚轮触发的原图和译图位置偏差不能超过 1px');
    }
    report.cases.push('local translated bitmap scrolls with its source before JavaScript on document and nested scroll');
}

async function verifyXSurface({page, popup, worker, ui, wait, click, shot, report, originalImage, lightboxOnly = false}) {
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
    let fullSizeSource;
    if (lightboxOnly && !originalImage) {
        const thumbnail = 'https://pbs.twimg.com/media/fluentread-preview-fixture?format=png&name=small';
        fullSizeSource = 'https://pbs.twimg.com/media/fluentread-preview-fixture?format=png&name=large';
        const images = await page.locator('#sample').evaluate(async image => {
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth * 1.5;
            canvas.height = image.naturalHeight * 1.5;
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            return [image.src, canvas.toDataURL()];
        });
        for (const [url, dataUrl] of [[thumbnail, images[0]], [fullSizeSource, images[1]]]) {
            const body = Buffer.from(dataUrl.split(',')[1], 'base64');
            await page.route(url, route => route.fulfill({
                contentType: 'image/png', headers: {'Access-Control-Allow-Origin': '*'}, body,
            }));
        }
        await page.evaluate(src => {
            const image = document.querySelector('#sample');
            image.crossOrigin = 'anonymous';
            image.src = src;
            document.querySelector('#x-surface').style.backgroundImage = `url("${src}")`;
        }, thumbnail);
    }
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

    async function menuAction(target = surface, dismissMenu = true) {
        // 可信右键建立目标；通过生产消息执行原生菜单动作，OS 菜单项点击未自动化。
        await target.click({button:'right'});
        if (dismissMenu) await page.keyboard.press('Escape');
        const response=await worker.evaluate(async url => {
            const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
            return chrome.tabs.sendMessage(tab.id,{type:'contextMenuTranslateImage'}, {frameId:0});
        },page.url());
        assert.equal(response?.status,'success');
    }
    await menuAction();
    if (lightboxOnly) {
        await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"), 300000);
        report.cases.push('default PaddleOCR translates X thumbnail before opening viewer');
    } else {
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
    }
    const result=await ui(`
        const bitmap=${xBitmap};
        return {surfaceOpacity:getComputedStyle(document.querySelector('#x-surface')).opacity,
            imgOpacity:getComputedStyle(document.querySelector('#sample')).opacity,
            bitmapOpacity:getComputedStyle(bitmap).opacity,fit:getComputedStyle(bitmap).objectFit,
            hidden:getComputedStyle(paintRoot?.host ?? bitmap.parentElement).display==='none'
                || getComputedStyle(bitmap).visibility!=='visible',size:[bitmap.naturalWidth,bitmap.naturalHeight]};`);
    assert.equal(result.surfaceOpacity,'0');assert.equal(result.imgOpacity,'0');
    assert.equal(result.bitmapOpacity,'1');assert.equal(result.fit,'cover');assert.equal(result.hidden,false);
    assert.deepEqual(result.size,report.fixture.originalSize);
    report.replacement=result;
    report.cases.push(lightboxOnly ? 'default PaddleOCR result visibly replaces X background surface'
        : 'one-click Chinese/English/Japanese language preparation continues to real OCR, translation, and visible X replacement');
    await shot('x-04-translated');
    const requests=await worker.evaluate(()=>globalThis.__imageFixture.requests.length);
    if (lightboxOnly) assert.ok(requests > 0, '必须实际命中 Google 翻译 transport');
    const operations=await worker.evaluate(()=>globalThis.__imageFixture.operationIds.length);
    assert.ok(operations > 0, '必须观察真实图片翻译请求');
    if (lightboxOnly) {
        await verifyXScroll({page, ui, wait, report, surface});
        assert.equal(await worker.evaluate(()=>globalThis.__imageFixture.requests.length),requests);
        assert.equal(await worker.evaluate(()=>globalThis.__imageFixture.operationIds.length),operations);
    }
    await click('文字');
    await wait(() => ui("return !!this.querySelector('.fr-image-reader-body')"));
    report.translatedText=await ui("return this.querySelector('.fr-image-reader-body').textContent");
    assert.match(report.translatedText,/[\u4e00-\u9fff]/);
    await shot('x-05-translated-text');
    await click('文字');
    report.requests=await worker.evaluate(()=>globalThis.__imageFixture.requests);
    await menuAction();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='idle'"));
    assert.equal(await surface.evaluate(el=>getComputedStyle(el).opacity),'1');
    assert.equal(await page.locator('#sample').evaluate(el=>getComputedStyle(el).opacity),'0');
    await shot('x-06-restored');
    await menuAction();
    await wait(() => ui("return this.querySelector('.fr-image-controls')?.dataset.phase==='translated'"));
    assert.equal(await worker.evaluate(()=>globalThis.__imageFixture.requests.length),requests);
    assert.equal(await worker.evaluate(()=>globalThis.__imageFixture.operationIds.length),operations);
    report.cases.push('right-click restore and cached redisplay preserve the X source DOM');
    await ui('this.__progressObserver?.disconnect();return true;');
    await ui(`this.__lightboxThumbnail=${xBitmap};return true;`);

    // 同一个宿主查看器分别加载列表原地址、X 原尺寸变体和一张不同的图片。
    await page.evaluate(fullSize => {
        const image = document.querySelector('#sample');
        const differentImage = document.createElement('canvas');
        differentImage.width = 1400;
        differentImage.height = 700;
        const context = differentImage.getContext('2d');
        context.fillStyle = '#c6e7fb';
        context.fillRect(0, 0, differentImage.width, differentImage.height);
        const nextSource = differentImage.toDataURL();
        let openings = 0;
        document.querySelector('#x-surface').addEventListener('click', () => {
            if (document.querySelector('#x-lightbox')) return;
            const native = openings === 2;
            const dialog = document.createElement(native ? 'dialog' : 'div');
            dialog.id = 'x-lightbox'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
            dialog.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center';
            const photo = document.createElement('img'); photo.id = 'x-lightbox-photo';
            photo.src = openings++ > 0 && fullSize ? fullSize : image.src;
            photo.style.cssText = 'width:95vw;height:70vh;object-fit:contain;background:white';
            const close = document.createElement('button'); close.id = 'x-lightbox-close'; close.textContent = '关闭大图';
            close.style.cssText = 'position:absolute;right:16px;top:16px;border:0;padding:8px;background:white;color:black';
            close.addEventListener('click', () => native ? dialog.close() : dialog.remove());
            const next = document.createElement('button'); next.id = 'x-lightbox-next'; next.textContent = '下一张';
            next.style.cssText = 'position:absolute;right:16px;bottom:16px;border:0;padding:8px;background:white;color:black';
            next.addEventListener('click', () => {photo.src = nextSource;});
            dialog.append(photo, close, next);
            if (native) {
                dialog.style.cssText += ';margin:auto;border:0;padding:0;width:min(850px,90vw);height:70vh;max-width:none;max-height:none;transform:translateY(12px) scale(.95)';
                photo.style.width = '100%';
                photo.style.height = '100%';
                // 原生模态框内保留可信右键，防止关闭系统菜单的 Escape 关闭模态框。
                photo.addEventListener('contextmenu', event => event.preventDefault());
                dialog.addEventListener('close', () => dialog.remove(), {once: true});
            }
            document.body.append(dialog);
            if (native) dialog.showModal();
        });
    }, fullSizeSource ?? null);
    const viewer = page.locator('#x-lightbox-photo');
    const originalSource = await page.locator('#sample').getAttribute('src');
    const visibleBitmaps = `[...this.querySelectorAll('.fluent-read-image-translation-overlay img'), paintRoot?.querySelector('img')]
        .filter(img => img?.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility === 'visible'
            && getComputedStyle(img.parentElement ?? img.getRootNode().host).display !== 'none')`;
    const originalVisible = `getComputedStyle(document.querySelector('#x-lightbox-photo')).opacity === '1'`;
    async function expectViewerTranslated(source) {
        await wait(() => ui(`const visible = ${visibleBitmaps};
            return visible.length === 1 && visible[0].src === this.__lightboxThumbnail.src
                && !(${originalVisible});`));
        assert.equal(await viewer.getAttribute('src'), source);
        if (fullSizeSource && source === fullSizeSource) {
            assert.ok(await viewer.evaluate(photo => photo.naturalWidth > document.querySelector('#sample').naturalWidth));
        }
        assert.equal(await surface.evaluate(el => getComputedStyle(el).opacity), '1');
        assert.equal(await worker.evaluate(() => globalThis.__imageFixture.requests.length), requests);
        assert.equal(await worker.evaluate(() => globalThis.__imageFixture.operationIds.length), operations);
    }
    async function expectThumbnailRestored() {
        await wait(() => ui(`const visible = ${visibleBitmaps};
            return visible.length === 1 && visible[0] === this.__lightboxThumbnail
                && this.querySelectorAll('.fluent-read-image-translation-overlay').length === 1;`));
        assert.equal(await surface.evaluate(el => getComputedStyle(el).opacity), '0');
        assert.equal(await page.locator('#sample').getAttribute('src'), originalSource);
    }

    report.lightboxStage = 'exact source on first open';
    await surface.click();
    await viewer.waitFor({state:'visible'});
    await expectViewerTranslated(originalSource);
    await shot('x-07-lightbox-translated-on-open');

    report.lightboxStage = 'restore preview original';
    await menuAction(viewer);
    await wait(() => ui(`return ${visibleBitmaps}.length === 0 && ${originalVisible};`));
    await shot('x-08-lightbox-restored');
    await page.locator('#x-lightbox-close').click();
    await expectThumbnailRestored();

    report.lightboxStage = 'X full-size source on reopen';
    await surface.click();
    await expectViewerTranslated(fullSizeSource ?? originalSource);
    await shot('x-09-lightbox-reopened');
    report.lightboxStage = 'replace preview source';
    await page.locator('#x-lightbox-next').click();
    await wait(() => ui(`return ${visibleBitmaps}.length === 0 && ${originalVisible};`));
    await shot('x-10-lightbox-next');
    await page.locator('#x-lightbox-close').click();
    await expectThumbnailRestored();
    await shot('x-11-lightbox-closed');

    report.lightboxStage = 'native modal top layer';
    await surface.click();
    await expectViewerTranslated(fullSizeSource ?? originalSource);
    assert.equal(await viewer.evaluate(photo => photo.closest('dialog').matches(':modal')), true);
    assert.equal(await viewer.evaluate(photo =>
        photo.closest('dialog').contains(document.querySelector('#fluent-read-image-translation-root'))), true,
    '译图必须处于原生模态框的 top layer 中才可见');
    const nativeBounds = await ui(`
        const bitmap = ${visibleBitmaps}[0];
        const photo = document.querySelector('#x-lightbox-photo');
        const actual = bitmap.getBoundingClientRect();
        const expected = photo.getBoundingClientRect();
        return Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, Math.abs(actual[key] - expected[key])]));
    `);
    assert.ok(Object.values(nativeBounds).every(delta => delta <= 1),
        `原生模态框缩放后译图和原图的边界应一致：${JSON.stringify(nativeBounds)}`);
    await shot('x-12-native-lightbox-translated');

    report.lightboxStage = 'native modal restore and cached redisplay';
    await menuAction(viewer, false);
    await wait(() => ui(`return ${visibleBitmaps}.length === 0 && ${originalVisible};`));
    await page.locator('#x-lightbox-close').hover();
    await page.waitForTimeout(300); // 超过普通图片 180ms 的空闲状态回收周期。
    assert.equal(await viewer.evaluate(photo =>
        photo.closest('dialog').contains(document.querySelector('#fluent-read-image-translation-root'))), true);
    await menuAction(viewer, false);
    await expectViewerTranslated(fullSizeSource ?? originalSource);
    await page.locator('#x-lightbox-close').click();
    await expectThumbnailRestored();

    report.lightboxStage = 'unrelated native modal';
    await page.evaluate(() => {
        const dialog = document.createElement('dialog'); dialog.id = 'native-image-dialog';
        dialog.style.cssText = 'width:400px;height:200px';
        const close = document.createElement('button'); close.id = 'native-image-dialog-close'; close.textContent = '关闭';
        close.style.cssText = 'border:0;background:white;color:black;padding:8px';
        close.addEventListener('click', () => dialog.close());
        dialog.append(close); document.body.append(dialog); dialog.showModal();
    });
    await wait(() => ui("return getComputedStyle(this.querySelector('.fluent-read-image-translation-overlay')).display==='none'"));
    await page.locator('#native-image-dialog-close').click();
    await wait(() => ui("return getComputedStyle(this.querySelector('.fluent-read-image-translation-overlay')).display==='block'"));
    await page.locator('#native-image-dialog').evaluate(el=>el.remove());
    const requestsAfterViewer = await worker.evaluate(() => globalThis.__imageFixture.requests.length);
    const operationsAfterViewer = await worker.evaluate(() => globalThis.__imageFixture.operationIds.length);
    assert.equal(requestsAfterViewer, requests);
    assert.equal(operationsAfterViewer, operations);
    delete report.lightboxStage;
    report.lightbox = {requestsBefore: requests, requestsAfterViewer, operations, operationsAfterViewer,
        testedFullSizeXVariant: Boolean(fullSizeSource), nativeBoundsDelta: nativeBounds,
        originalSourcePreserved: true, decodedThumbnailRetained: true};
    report.cases.push('trusted thumbnail click opens the existing translation in the viewer without new work',
        'viewer restores its own original and reopening reuses the thumbnail translation',
        'switching viewer source removes stale enlarged translation',
        'native image modal opens the same translation in the browser top layer',
        'native modal keeps its translation state after restore and idle pointer exit',
        'unrelated native modal open attribute changes suspend and restore thumbnail without new work',
        'closing the viewer restores the same decoded thumbnail without requests');
}
module.exports={verifyXSurface};
