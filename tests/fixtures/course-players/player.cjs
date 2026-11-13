/**
 * @file tests/fixtures/course-players/player.cjs
 * 文件职责：提供可独立打开的课程播放器布局复刻页，不包含第三方播放器源码、账号或网络依赖。
 * 主要内容：B 站采用 2026-11-14 真实页面测得的 55px 底控、35px 行、22px 按钮；Udemy/edX 使用不同的控件高度、嵌套和对齐方式，覆盖网页全屏与实际 Fullscreen API。
 * 模块边界：只模拟宿主播放器；FluentRead 图标与菜单必须由待测扩展自行注入。
 */
const source = 'A class is a blueprint for creating objects.';

function coursePlayerFixture(platform, mediaUrl = '') {
    if (!['bilibili', 'udemy', 'edx'].includes(platform)) throw Error('Unknown course fixture');
    const icon = (label, kind) => `<svg aria-hidden="true" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2">${kind === 'full' ? '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>' : kind === 'settings' ? '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>' : '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h3m-3 4h3m4-4h3m-3 4h3"/>'}</g></svg><span class="sr-only">${label}</span>`;
    const button = (attrs, label, content = label) => `<button type="button" ${attrs} aria-label="${label}">${content}</button>`;
    const caption = platform === 'bilibili' ? button('class="bpx-player-ctrl-btn bpx-player-ctrl-subtitle"', '字幕', '<span class="bpx-player-ctrl-subtitle-result">字幕</span>')
        : platform === 'udemy' ? `<span class="native-tooltip">${button('data-purpose="captions-dropdown-button"', 'Captions', icon('Captions'))}</span>`
            : button('class="toggle-captions"', 'Captions', icon('Captions'));
    const web = button('data-fixture-web class="bpx-player-ctrl-btn bpx-player-ctrl-web"', '网页全屏', icon('网页全屏', 'full'));
    const full = button(`data-fixture-full ${platform === 'udemy' ? 'data-purpose="fullscreen-button"' : ''} class="bpx-player-ctrl-btn bpx-player-ctrl-full toggle-fullscreen"`, '全屏', icon('全屏', 'full'));
    const settings = button('class="bpx-player-ctrl-btn bpx-player-ctrl-setting"', '设置', icon('设置', 'settings'));
    const actions = platform === 'bilibili' ? `<div class="bpx-player-control-bottom-right"><span class="native-label">倍速</span>${caption}${settings}${web}${full}</div>`
        : platform === 'udemy' ? `<div data-purpose="video-control-bar"><span class="native-label">1×</span><div class="native-actions">${caption}${settings}${web}${full}</div></div>`
            : `<div class="secondary-controls">${caption}${settings}${web}${full}</div>`;
    const controls = `<div class="bpx-player-control-wrap"><div class="fixture-progress" data-fixture-progress></div><div class="bpx-player-control-bottom"><div class="native-left">▶ <span>0:00 / 0:20</span></div>${actions}</div></div>`;
    const metadata = JSON.stringify({transcriptLanguage:'en', transcriptTranslationUrl:'/transcript/__lang__'});
    const root = platform === 'bilibili' ? 'id="bilibili-player" class="player bpx-player-container"' : platform === 'udemy' ? 'class="player" data-purpose="shaka-video-player"'
        : `class="player video" data-block-id="course-video-1" data-metadata='${metadata}'`;
    const nativeCaption = platform === 'bilibili' ? 'class="native-caption bpx-player-subtitle-wrap"' : platform === 'udemy' ? 'class="native-caption" data-purpose="captions-cue-text"' : 'class="native-caption closed-captions"';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${platform} · 本地播放器复刻</title><style>
    *{box-sizing:border-box}body{margin:0;background:#edf1f6;color:#263346;font:15px system-ui}main{max-width:1050px;margin:28px auto;padding:0 18px}h1{font-size:22px;margin:0 0 6px}p{color:#64748b}.player{position:relative;width:100%;height:560px;overflow:hidden;background:#111824;color:white;border-radius:10px;font:12px/22px system-ui}.player video{width:100%;height:100%;object-fit:contain;position:absolute;inset:0}.lesson{position:absolute;left:7%;top:12%;font:24px/1.7 monospace;color:#cbd5e1;pointer-events:none}.lesson small{font:14px system-ui;color:#94a3b8}.native-caption{position:absolute;bottom:90px;left:12%;font-size:20px}
    .bpx-player-control-wrap{position:absolute;bottom:0;left:0;right:0;height:55px;z-index:75;background:linear-gradient(transparent,#000c)}.fixture-progress{position:absolute;bottom:44px;left:12px;right:12px;height:4px;background:#8b949e;border-radius:2px}.bpx-player-control-bottom{display:flex;justify-content:space-between;height:35px;margin:20px 0 0;padding:0 12px;line-height:22px}.native-left{display:flex;gap:18px;height:35px}.bpx-player-control-bottom-right{display:flex;justify-content:flex-end;height:35px}.native-label{margin:0 10px;height:22px;font-size:14px}button{border:0;padding:0;background:transparent;color:inherit;cursor:pointer;font:inherit;flex:none}button svg{display:block;width:22px;height:22px;margin:auto}.bpx-player-ctrl-btn{position:relative;width:36px;height:22px;line-height:22px}.bpx-player-ctrl-subtitle{width:28px;margin:0 5px;font-size:14px}.native-actions{display:flex;align-items:center;height:100%;gap:4px}.native-tooltip{display:inline-flex;align-items:center;height:100%}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
    .bpx-player-ctrl-subtitle-result{display:block;height:22px;line-height:22px}.bpx-player-ctrl-subtitle:hover{box-sizing:content-box;padding-bottom:13px}
    body[data-platform=udemy] .bpx-player-control-wrap{height:70px}body[data-platform=udemy] .fixture-progress{bottom:58px}body[data-platform=udemy] .bpx-player-control-bottom{height:52px;margin-top:18px;align-items:center}body[data-platform=udemy] [data-purpose=video-control-bar]{display:flex;height:52px;align-items:center;gap:12px}body[data-platform=udemy] .native-actions button{width:36px;height:32px}
    body[data-platform=edx] .bpx-player-control-wrap{height:70px}body[data-platform=edx] .fixture-progress{bottom:58px}body[data-platform=edx] .bpx-player-control-bottom{height:48px;margin-top:22px}.secondary-controls{display:flex;align-items:flex-end;gap:6px;height:42px;padding-bottom:8px;border-top:1px solid transparent}.secondary-controls button{height:24px;width:32px}
    .player.web-fullscreen,.player:fullscreen{position:fixed;inset:0;width:100%;height:100%;margin:0;z-index:9999;border-radius:0}.player:fullscreen{background:#111824}.player.web-fullscreen .lesson,.player:fullscreen .lesson{font-size:32px}@media(max-width:650px){main{padding:0 8px}.player{height:280px}.lesson{font-size:15px}.native-left span{display:none}.native-label{margin:0 4px}.bpx-player-ctrl-btn{width:30px}}
    </style></head><body data-platform="${platform}"><main><h1>${platform} · 本地播放器复刻</h1><p>独立布局测试页 · 图标和菜单由 FluentRead 扩展注入</p><div ${root}><video muted preload="auto" ${mediaUrl ? `src="${mediaUrl}"` : ''}></video><div class="lesson"><small>PYTHON · CLASSES AND OBJECTS</small><pre>class Dog:\n    def bark(self):\n        return "Hello"</pre></div><div ${nativeCaption}>${source}</div>${controls}</div></main><script>
    window.player={getManifest:()=>({bvid:'BV1xx411c7mD',aid:123,p:1,cid:456})};
    const root=document.querySelector('.player'),video=root.querySelector('video');
    video.addEventListener('loadedmetadata',()=>{video.currentTime=.5;});
    root.addEventListener('click',event=>{if(event.target.closest('[data-fixture-web]'))root.classList.toggle('web-fullscreen');if(event.target.closest('[data-fixture-full]'))document.fullscreenElement?document.exitFullscreen():root.requestFullscreen();});
    document.addEventListener('fullscreenchange',()=>{
        if(document.fullscreenElement)return;
        const bar=root.querySelector('${platform === 'bilibili' ? '.bpx-player-control-bottom-right' : platform === 'udemy' ? '.native-actions' : '.secondary-controls'}');
        const next=bar.cloneNode(true);next.querySelector('#fluent-read-course-controls')?.remove();
        for(const child of [...bar.children])if(child.id!=='fluent-read-course-controls')child.remove();
        bar.style.display='none';bar.after(next);
        if(document.body.dataset.platform==='bilibili'&&!document.querySelector('.v-recommend-inline-player')){
            const preview=document.createElement('aside');preview.className='v-recommend-inline-player';preview.style.cssText='position:fixed;right:0;top:110px;width:142px;height:80px;z-index:1';
            const container=document.createElement('div');container.className='bpx-player-container';
            const clip=document.createElement('video');clip.src=video.src;clip.muted=true;clip.autoplay=true;clip.style.cssText='width:142px;height:80px';
            const hiddenBar=document.createElement('div');hiddenBar.className='bpx-player-control-bottom-right';hiddenBar.style.display='none';
            container.append(clip,hiddenBar);preview.append(container);document.body.append(preview);
        }
    });
    </script></body></html>`;
}
module.exports = {coursePlayerFixture, source};

if (require.main === module) {
    const http = require('node:http');
    const port = Number(process.argv[2] || 4178);
    http.createServer((request,response)=>{
        const platform=new URL(request.url,'http://localhost').searchParams.get('site')||'bilibili';
        response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(coursePlayerFixture(platform));
    }).listen(port,'127.0.0.1',()=>console.log(`Course player layouts: http://127.0.0.1:${port}/?site=bilibili (also udemy, edx)`));
}
