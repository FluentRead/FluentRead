import {afterEach, describe, expect, it, vi} from 'vitest';
import {installBackgroundBadge} from '@/src/app/background/badgeRuntime';
import {TabTranslationStateStore} from '@/src/app/background/tabTranslationState';
const previous = (globalThis as any).browser;
afterEach(() => { (globalThis as any).browser = previous; vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const event = () => { const listeners: Function[] = []; return {addListener: (fn: Function) => listeners.push(fn), emit: (...args: unknown[]) => listeners.forEach(fn => fn(...args))}; };
function setup(namespace = 'action', sendMessage = vi.fn(async () => ({status:'success',isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'}))) {
    const action = {setBadgeBackgroundColor: vi.fn(async (_details: {tabId:number;color:string}) => {}), setBadgeTextColor: vi.fn(async (_details: {tabId:number;color:string}) => {}), setBadgeText: vi.fn(async (_details: {tabId:number;text:string}) => {}), setIcon: vi.fn(async (_details: {tabId:number;path:Record<number,string>}) => {})};
    const tabs = {onActivated: event(), onUpdated: event(), onRemoved: event(), sendMessage};
    (globalThis as any).browser = {...(namespace === 'none' ? {} : {[namespace]:action}), tabs};
    const store = new TabTranslationStateStore();
    return {action, tabs, store, badge: installBackgroundBadge(store)};
}
const settle = async () => { for (let i=0;i<40;i++) await Promise.resolve(); };
describe('工具栏原生三态角标', () => {
    it('完成后的状态切换直接更新角标，不清空标识或重复加载底图', async () => {
        const {store,badge,action}=setup();
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
        await badge.update(1);
        action.setBadgeText.mockClear();action.setIcon.mockClear();
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'error'});
        await badge.update(1);
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
        await badge.update(1);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['!','✓']);
        expect(action.setIcon).not.toHaveBeenCalled();
    });
    it('相同状态在慢 API 写入期间重复到达，合并为同一次完整写入', async () => {
        const {store,badge,action}=setup();let release!:()=>void;
        action.setIcon.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}));
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
        const first=badge.update(1);await settle();
        const duplicate=badge.update(1);release();await Promise.all([first,duplicate]);
        expect(action.setIcon).toHaveBeenCalledTimes(1);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['✓']);
    });
    it('完成后反复快速补译保留对勾，下一次持续等待仍正常显示省略号', async () => {
        vi.useFakeTimers();
        const {store,badge,action}=setup();
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await badge.update(1);
        action.setBadgeText.mockClear();action.setIcon.mockClear();
        for(let i=0;i<5;i++) {
            store.setTranslated(1,true,'translating');const pending=badge.update(1);
            await vi.advanceTimersByTimeAsync(90);
            store.setTranslated(1,true,'translated');await badge.update(1);await pending;
            await vi.advanceTimersByTimeAsync(200);
        }
        expect(action.setBadgeText).not.toHaveBeenCalled();expect(action.setIcon).not.toHaveBeenCalled();
        store.setTranslated(1,true,'translating');const pending=badge.update(1);
        await vi.advanceTimersByTimeAsync(90);const duplicate=badge.update(1);
        await vi.advanceTimersByTimeAsync(90);await Promise.all([pending,duplicate]);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['…']);
        store.setTranslated(1,true,'translated');await badge.update(1);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['…','✓']);
    });
    it.each(['restore','disable','navigate','close'] as const)('%s 取消迟到的补译等待标识', async mode => {
        vi.useFakeTimers();
        const {store,badge,action,tabs}=setup();
        store.setTranslated(1,true,'translated');await badge.update(1);
        action.setBadgeText.mockClear();store.setTranslated(1,true,'translating');const pending=badge.update(1);
        if(mode==='restore') {store.reset(1);await badge.update(1);}
        if(mode==='disable') {store.setSiteDisabled(1,true);await badge.update(1);}
        if(mode==='navigate') {store.reset(1);tabs.sendMessage.mockRejectedValueOnce(new Error('document unloaded'));tabs.onUpdated.emit(1,{status:'loading'});await settle();}
        if(mode==='close') tabs.onRemoved.emit(1);
        await vi.advanceTimersByTimeAsync(500);await pending;
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(mode==='close'?[]:['']);
    });
    it('候选扫描与入队之间的短空档保留等待标识，真正空闲仍能清空', async () => {
        vi.useFakeTimers();const {store,badge,action}=setup();
        store.setTranslated(1,true,'translating');await badge.update(1);action.setBadgeText.mockClear();
        store.setTranslated(1,true,'idle');const gap=badge.update(1);
        await vi.advanceTimersByTimeAsync(90);
        store.setTranslated(1,true,'translating');await badge.update(1);await gap;
        await vi.advanceTimersByTimeAsync(200);expect(action.setBadgeText).not.toHaveBeenCalled();
        store.setTranslated(1,true,'idle');const idle=badge.update(1);
        await vi.advanceTimersByTimeAsync(180);await idle;
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['']);
    });
    it('短暂空闲改为补译、完成和失败时，只保留最后所需的标识', async () => {
        vi.useFakeTimers();const {store,badge,action}=setup();
        store.setTranslated(1,true,'translated');await badge.update(1);action.setBadgeText.mockClear();
        store.setTranslated(1,true,'idle');const idle=badge.update(1);await vi.advanceTimersByTimeAsync(60);
        store.setTranslated(1,true,'translating');const busy=badge.update(1);await idle;
        await vi.advanceTimersByTimeAsync(60);store.setTranslated(1,true,'error');await badge.update(1);await busy;
        await vi.advanceTimersByTimeAsync(300);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['!']);
        store.setTranslated(1,true,'translated');await badge.update(1);
        store.setTranslated(1,true,'idle');const gap=badge.update(1);await vi.advanceTimersByTimeAsync(90);
        store.setTranslated(1,true,'translated');await badge.update(1);await gap;
        await vi.advanceTimersByTimeAsync(300);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['!','✓']);
    });
    it.each(['translated','translating','error'] as const)('按真实 %s 结果显示原生角标并恢复原图', async status => {
        const {store,badge,action}=setup(); store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:status}); await badge.update(1);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:{translated:'✓',translating:'…',error:'!'}[status]});
        expect(action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({tabId:1,color:{translated:'#15803d',translating:'#2563eb',error:'#b45309'}[status]});
        expect(action.setBadgeTextColor).toHaveBeenCalledWith({tabId:1,color:'#ffffff'});
        expect(action.setIcon).toHaveBeenLastCalledWith({tabId:1,path:Object.fromEntries([16,32,48,64,128].map(size=>[size,`icon/${size}.png`]))});
        await badge.update(1); expect(action.setIcon).toHaveBeenCalledTimes(1);
    });
    it('恢复、禁用、旧消息与另一标签页都不会误用成功图标', async () => {
        const {store,badge,action}=setup();
        for(const state of [{isTranslated:false,isSiteDisabled:false},{isTranslated:true,isSiteDisabled:true},{isTranslated:true,isSiteDisabled:false}]) {
            store.set(2,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await badge.update(2);
            store.set(2,state);await badge.update(2);expect(action.setIcon.mock.lastCall?.[0].path[16]).toBe('icon/16.png');
            expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:2,text:''});
        }
        store.set(3,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await badge.update(3);
        await badge.update(4);expect(action.setIcon.mock.lastCall?.[0]).toMatchObject({tabId:4,path:{16:'icon/16.png'}});
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:4,text:''});
    });
    it('激活时回源，包括完整但陈旧的缓存；查询失败保留安全默认', async () => {
        const {store,tabs,action}=setup();store.set(5,{isTranslated:false,isSiteDisabled:false});tabs.onActivated.emit({tabId:5});await settle();
        expect(tabs.sendMessage).toHaveBeenCalledWith(5,{type:'getFullPageTranslationState'},{frameId:0});expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:5,text:'✓'});
        tabs.sendMessage.mockRejectedValueOnce(new Error('no receiver'));tabs.onActivated.emit({tabId:6});await settle();expect(action.setIcon.mock.lastCall?.[0].path[16]).toBe('icon/16.png');
    });
    it('导航恢复原图，普通更新不清空，关闭取消还未写出的任务', async () => {
        const {store,badge,tabs,action}=setup();store.set(7,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await badge.update(7);
        tabs.onUpdated.emit(7,{status:'complete'});await settle();expect(action.setIcon).toHaveBeenCalledTimes(1);
        store.reset(7);tabs.sendMessage.mockRejectedValueOnce(new Error('document unloaded'));
        tabs.onUpdated.emit(7,{status:'loading'});await settle();expect(action.setIcon.mock.lastCall?.[0].path[16]).toBe('icon/16.png');
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:7,text:''});
        const pending=badge.update(8);tabs.onRemoved.emit(8);await pending;expect(action.setIcon).toHaveBeenCalledTimes(1);
    });
    it.each(['translating', 'translated', 'error'] as const)('子页面 loading/complete 后回源保留 %s，内容脚本无需再次推送', async status => {
        const reply = {status:'success', isTranslated:true, isSiteDisabled:false, toolbarStatus:status};
        const {store,badge,tabs,action}=setup('action', vi.fn(async () => reply));
        store.set(1,reply);await badge.update(1);action.setBadgeText.mockClear();
        // 与生产菜单监听一致：loading 先使旧查询失效并重置后台缓存。
        store.reset(1);tabs.onUpdated.emit(1,{status:'loading'});await settle();
        tabs.onUpdated.emit(1,{status:'complete'});await settle();
        expect(tabs.sendMessage).toHaveBeenCalledWith(1,{type:'getFullPageTranslationState'},{frameId:0});
        expect(store.get(1)).toMatchObject({isTranslated:true,isSiteDisabled:false,toolbarStatus:status});
        expect(action.setBadgeText).not.toHaveBeenCalledWith({tabId:1,text:''});
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:{translating:'…',translated:'✓',error:'!'}[status]});
        expect(action.setIcon).toHaveBeenCalledTimes(1);
    });
    it('加载完成强制重画同态角标，覆盖浏览器原生已清空但本地缓存仍存在的情况', async () => {
        const {store,badge,tabs,action}=setup();store.setTranslated(1,true,'translated');await badge.update(1);
        action.setBadgeText.mockClear();tabs.onUpdated.emit(1,{status:'complete'});await settle();
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(['✓']);
        tabs.onUpdated.emit(1,{title:'new title'});await settle();
        expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('真正导航完成后回源到新页面原文状态，旧 loading 查询迟到也不能复活对勾', async () => {
        const {store,badge,tabs,action}=setup();store.setTranslated(1,true,'translated');await badge.update(1);
        let release!:(value:any)=>void;
        tabs.sendMessage.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
        store.reset(1);tabs.onUpdated.emit(1,{status:'loading'});await settle();
        tabs.sendMessage.mockResolvedValueOnce({status:'success',isTranslated:false,isSiteDisabled:false,toolbarStatus:'idle'});
        tabs.onUpdated.emit(1,{status:'complete'});await settle();
        release({status:'success',isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await settle();
        expect(store.get(1).isTranslated).toBe(false);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:''});
    });
    it.each(['restore','close'] as const)('加载回源途中 %s 后，迟到回复不能覆盖最新状态', async mode => {
        const {store,badge,tabs,action}=setup();store.setTranslated(1,true,'translated');await badge.update(1);
        let release!:(value:any)=>void;
        tabs.sendMessage.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
        tabs.onUpdated.emit(1,{status:'complete'});await settle();action.setBadgeText.mockClear();
        if(mode==='close') {store.delete(1);tabs.onRemoved.emit(1);}
        else {store.setTranslated(1,false,'idle');await badge.update(1);}
        release({status:'success',isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await settle();
        expect(store.get(1).isTranslated).toBe(false);
        expect(action.setBadgeText.mock.calls.map(([details])=>details.text)).toEqual(mode==='close'?[]:['']);
    });
    it('慢旧写入不能覆盖较新的恢复状态', async () => {
        const {store,badge,action}=setup();let release!:()=>void;action.setIcon.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}));
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});const first=badge.update(1);await settle();store.reset(1);const restore=badge.update(1);release();await Promise.all([first,restore]);expect(action.setIcon.mock.lastCall?.[0].path[16]).toBe('icon/16.png');
    });
    it('Firefox MV2 使用 browserAction；无 action 环境不查询或写入', async () => {
        const ff=setup('browserAction');await ff.badge.update(1);expect(ff.action.setIcon).toHaveBeenCalled();const none=setup('none');await none.badge.update(1);none.tabs.onActivated.emit({tabId:1});expect(none.badge.isSupported).toBe(false);expect(none.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('图标 API 失败不会拒绝，后续刷新可以重试', async () => {
        const {badge,action}=setup();const error=vi.spyOn(console,'error').mockImplementation(()=>{});action.setIcon.mockRejectedValueOnce(new Error('tab gone'));await badge.update(1);await badge.update(1);expect(error).toHaveBeenCalled();expect(action.setIcon).toHaveBeenCalledTimes(2);
    });
    it('Edge 关闭标签页后的原生 setIcon 回调错误被读取，且不再写角标或记录错误', async () => {
        vi.stubEnv('BROWSER', 'edge');
        const {store,badge,tabs,action}=setup();
        const error=vi.spyOn(console,'error').mockImplementation(()=>{});
        const runtime: {id:string;lastError?:{message:string}}={id:'extension-id'};
        let complete!:()=>void;
        const setIcon=vi.fn((_details:unknown,callback:()=>void)=>callback());
        setIcon.mockImplementationOnce((_details,callback)=>{complete=callback;});
        vi.stubGlobal('chrome',{runtime,action:{setIcon}});
        store.setTranslated(1,true,'translated');
        const pending=badge.update(1);await settle();
        expect(setIcon).toHaveBeenCalledTimes(1);
        expect(setIcon).toHaveBeenCalledWith({tabId:1,path:{16:'icon/16.png',32:'icon/32.png',48:'icon/48.png',64:'icon/64.png',128:'icon/128.png'}},expect.any(Function));
        tabs.onRemoved.emit(1);
        runtime.lastError={message:'No tab with id: 1.'};complete();delete runtime.lastError;
        await pending;
        expect(action.setIcon).not.toHaveBeenCalled();
        expect(action.setBadgeBackgroundColor).not.toHaveBeenCalled();
        expect(action.setBadgeTextColor).not.toHaveBeenCalled();
        expect(action.setBadgeText).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        store.setTranslated(2,true,'translated');await badge.update(2);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:2,text:'✓'});
    });
    it('当前原生图标写入失败仍报错，刷新重试成功后复用底图', async () => {
        vi.stubEnv('BROWSER','chrome');
        const {store,badge,action}=setup();
        const error=vi.spyOn(console,'error').mockImplementation(()=>{});
        const runtime: {id:string;lastError?:{message:string}}={id:'extension-id'};
        const setIcon=vi.fn((_details:unknown,callback:()=>void)=>callback());
        setIcon.mockImplementationOnce((_details,callback)=>{
            runtime.lastError={message:'Invalid icon path'};callback();delete runtime.lastError;
        });
        vi.stubGlobal('chrome',{runtime,action:{setIcon}});
        store.setTranslated(1,true,'translated');await badge.update(1);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith('Failed to update toolbar translation status:',expect.objectContaining({message:'Invalid icon path'}));
        expect(action.setBadgeText).not.toHaveBeenCalled();
        await badge.update(1);await badge.update(1);
        expect(setIcon).toHaveBeenCalledTimes(2);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:'✓'});
    });
    it.each(['setIcon','setBadgeBackgroundColor','setBadgeTextColor','setBadgeText'] as const)(
        '关闭标签页后 %s 的迟到拒绝不再记录错误或继续写入', async method => {
            const {store,badge,tabs,action}=setup();
            const error=vi.spyOn(console,'error').mockImplementation(()=>{});
            let reject!:(error:Error)=>void;
            action[method].mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
            store.setTranslated(1,true,'translated');const pending=badge.update(1);await settle();
            expect(reject).toBeTypeOf('function');
            const calls=Object.values(action).map(mock=>mock.mock.calls.length);
            tabs.onRemoved.emit(1);reject(new Error('No tab with id: 1.'));await pending;
            expect(Object.values(action).map(mock=>mock.mock.calls.length)).toEqual(calls);
            expect(error).not.toHaveBeenCalled();
        },
    );
    it.each(['setIcon','setBadgeBackgroundColor','setBadgeTextColor','setBadgeText'] as const)(
        '恢复原文后旧 %s 拒绝不误报，新版本仍完成写入', async method => {
            const {store,badge,action}=setup();
            const error=vi.spyOn(console,'error').mockImplementation(()=>{});
            let reject!:(error:Error)=>void;
            action[method].mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
            store.setTranslated(1,true,'translated');const pending=badge.update(1);await settle();
            expect(reject).toBeTypeOf('function');
            store.reset(1);const restored=badge.update(1);
            reject(new Error('obsolete API failure'));await Promise.all([pending,restored]);
            expect(error).not.toHaveBeenCalled();
            expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:''});
        },
    );
    it('一个标签页的角标 API 挂起时，其他标签页仍可完成并在关闭后重置自身状态', async () => {
        const {store,badge,tabs,action}=setup();
        let release!:()=>void;
        action.setBadgeBackgroundColor.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
        store.setTranslated(1,true,'translated');
        const first=badge.update(1);await settle();
        store.setTranslated(2,true,'error');await badge.update(2);
        expect(action.setBadgeText).toHaveBeenCalledWith({tabId:2,text:'!'});
        tabs.onRemoved.emit(1);release();await first;
        expect(action.setBadgeText).not.toHaveBeenCalledWith({tabId:1,text:'✓'});
        store.setTranslated(2,true,'translated');await badge.update(2);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:2,text:'✓'});
        expect(action.setIcon.mock.calls.filter(([details])=>details.tabId===2)).toHaveLength(1);
    });
    it('当前角标文字写入失败时记录错误并允许同态重试', async () => {
        const {store,badge,action}=setup();
        const error=vi.spyOn(console,'error').mockImplementation(()=>{});
        const failure=new Error('badge text unavailable');
        action.setBadgeText.mockRejectedValueOnce(failure);
        store.setTranslated(1,true,'translated');await badge.update(1);
        expect(error).toHaveBeenCalledWith('Failed to update toolbar translation status:',failure);
        await badge.update(1);
        expect(action.setBadgeText).toHaveBeenCalledTimes(2);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:'✓'});
        expect(action.setIcon).toHaveBeenCalledTimes(1);
    });
    it('没有文字颜色 API 时仍能显示完成角标', async () => {
        const {store,badge,action}=setup('browserAction');
        delete (action as any).setBadgeTextColor;
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
        await badge.update(1);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:'✓'});
    });
    it('慢颜色写入期间恢复原文，不再写出过期成功角标', async () => {
        const {store,badge,action}=setup();let release!:()=>void;
        action.setBadgeBackgroundColor.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}));
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
        const first=badge.update(1);await settle();store.reset(1);
        const restore=badge.update(1);release();await Promise.all([first,restore]);
        expect(action.setBadgeText).not.toHaveBeenCalledWith({tabId:1,text:'✓'});
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:''});
    });
    it.each(['setBadgeText','setBadgeBackgroundColor','setBadgeTextColor'] as const)(
        '%s 写入中回到已显示过的完成状态，仍会重画完成角标', async method => {
            vi.useFakeTimers();
            const {store,badge,action}=setup();
            store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
            await badge.update(1);
            let release!:()=>void;
            action[method].mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}));
            store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translating'});
            const pending=badge.update(1);await vi.advanceTimersByTimeAsync(180);await settle();
            expect(release).toBeTypeOf('function');
            store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
            const completed=badge.update(1);release();await Promise.all([pending,completed]);
            expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:'✓'});
            expect(action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({tabId:1,color:'#15803d'});
        },
    );
    it('已显示原文时，迟到的完成文字写入不能覆盖再次恢复原文', async () => {
        const {store,badge,action}=setup();await badge.update(1);
        let release!:()=>void;
        action.setBadgeText.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}));
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});
        const completed=badge.update(1);await settle();
        expect(release).toBeTypeOf('function');
        store.reset(1);const restored=badge.update(1);release();await Promise.all([completed,restored]);
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:''});
    });
    it('部分写入失败后回到上次完成状态，也能重新显示对勾', async () => {
        const {store,badge,action}=setup();
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await badge.update(1);
        const error=vi.spyOn(console,'error').mockImplementation(()=>{});
        action.setBadgeBackgroundColor.mockRejectedValueOnce(new Error('temporary API failure'));
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translating'});await badge.update(1);
        store.set(1,{isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'});await badge.update(1);
        expect(error).toHaveBeenCalled();
        expect(action.setBadgeText).toHaveBeenLastCalledWith({tabId:1,text:'✓'});
    });
});
