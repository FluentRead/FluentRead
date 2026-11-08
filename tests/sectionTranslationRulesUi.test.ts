import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {App, Component} from 'vue';
import {Config, normalizeConfig} from '@/src/core/config/model';
import type {SectionTranslationRule} from '@/src/core/config/sectionTranslationRules';
import {createQuickTranslationProfile} from '@/src/core/config/quickTranslation';

// 执行真实 SFC 客户端模板；第三方控件只通过其公开 v-model 端口映射到原生输入。
vi.mock('@/src/ui/i18n', async () => {
    const {translate} = await import('@/src/core/i18n');
    return {useUiI18n: () => ({t: (key: string, params?: Record<string, string | number>) => translate(key, 'zh-CN', params)})};
});
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
let component: Component, app: App | undefined, document: Document, window: ReturnType<typeof parseHTML>['window'];
let root: HTMLElement, props: {config: Config; active: boolean};
let visible: import('vue').Ref<boolean>;
const rule = (id = 'first', patch: Partial<SectionTranslationRule> = {}): SectionTranslationRule => ({id, enabled: true, site: 'example.com/articles/', selectors: [['#comments']], mode: 'remind', ...patch});
const settle = async () => {await runtime.nextTick(); await runtime.nextTick();};
beforeAll(async () => {
    component = (await import('@/src/features/settings/ui/SectionTranslationRules.vue')).default;
    expect((component as any).render).toBeTypeOf('function');
});
beforeEach(() => {
    const dom = parseHTML('<html><body><div id="app"></div></body></html>'); document = dom.document; window = dom.window;
    root = document.querySelector('#app')!;
    vi.stubGlobal('document', document);
    vi.stubGlobal('Element', window.Element);
});
afterEach(async () => {app?.unmount(); app = undefined; await settle(); vi.unstubAllGlobals();});

function controls() {
    const {defineComponent, h} = runtime;
    return {
        ElButton: defineComponent({inheritAttrs: false, props: ['disabled', 'nativeType'], setup: (p, {attrs, slots}) => () => h('button', {...attrs, disabled: p.disabled, type: p.nativeType ?? 'button'}, slots.default?.())}),
        ElInput: defineComponent({inheritAttrs: false, props: ['modelValue', 'type', 'rows'], emits: ['update:modelValue'], setup: (p, {attrs, emit}) => () => h(p.type === 'textarea' ? 'textarea' : 'input', {...attrs, value: p.modelValue, rows: p.rows, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value)})}),
        ElSwitch: defineComponent({inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup: (p, {attrs, emit}) => () => h('input', {...attrs, type: 'checkbox', checked: p.modelValue, disabled: p.disabled, onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).checked)})}),
        ElSelect: defineComponent({inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup: (p, {attrs, emit, slots}) => () => h('select', {...attrs, value: p.modelValue, disabled: p.disabled, onChange: (e: Event) => emit('update:modelValue', (e.target as HTMLSelectElement).value)}, slots.default?.())}),
        ElOption: defineComponent({props: ['value', 'label', 'disabled'], setup: p => () => h('option', {value: p.value, disabled: p.disabled}, p.label)}),
    };
}

async function mount(rules: SectionTranslationRule[] = [rule()], active = true, cached = false) {
    const renderer = runtime.createRenderer<Node, HTMLElement>({
        patchProp(node, key, old, value) {
            if (/^on[A-Z]/u.test(key)) {const name = key.slice(2).toLowerCase(); if (old) node.removeEventListener(name, old); if (value) node.addEventListener(name, value);}
            else if (key === 'value') (node as HTMLInputElement).value = value ?? '';
            else if (key === 'checked') (node as HTMLInputElement).checked = Boolean(value);
            else if (value == null || value === false && !/^(?:aria-|data-)/u.test(key)) node.removeAttribute(key);
            else node.setAttribute(key, String(value));
        },
        insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.parentNode?.removeChild(node),
        createElement: tag => {const element = runtime.markRaw(document.createElement(tag)); if (tag === 'select') Object.defineProperty(element, 'value', {value: '', writable: true, configurable: true}); return element;},
        createText: text => document.createTextNode(text), createComment: text => document.createComment(text), setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode as HTMLElement | null, nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
        insertStaticContent: (content, parent, anchor) => {const template = document.createElement('template'); template.innerHTML = content; const first = template.content.firstChild!, last = template.content.lastChild!; parent.insertBefore(template.content, anchor || null); return [first, last];},
    });
    props = runtime.reactive({config: normalizeConfig({...new Config(), sectionTranslationRules: rules}), active});
    visible = runtime.ref(true);
    const other = {render: () => null};
    app = renderer.createApp({setup: () => () => cached ? runtime.h(runtime.KeepAlive, null, {default: () => visible.value ? runtime.h(component, props) : runtime.h(other)}) : runtime.h(component, props)});
    Object.entries(controls()).forEach(([name, control]) => app!.component(name, control));
    app.mount(root); await settle();
}
function get<T extends Element = HTMLElement>(selector: string): T {const node = root.querySelector<T>(selector); expect(node, selector).not.toBeNull(); return node!;}
function fire(node: Element, type: string): void {node.dispatchEvent(new window.Event(type, {bubbles: true, cancelable: true}));}
async function click(selector: string) {fire(get(selector), 'click'); await settle();}
async function input(selector: string, value: string) {const node = get<HTMLInputElement>(selector); node.value = value; fire(node, 'input'); await settle();}
async function change(selector: string, value: string | boolean) {const node = get<HTMLInputElement>(selector); if (typeof value === 'boolean') node.checked = value; else node.value = value; fire(node, 'change'); await settle();}
async function save() {fire(get('form'), 'submit'); await settle();}
async function draft(site = 'example.net/docs/', selectors = 'article .content') {await click('.rules-heading button'); await input('.rule-editor input', site); await input('.rule-editor textarea', selectors);}

describe('记住局部区域规则的实际 Vue 界面', () => {
    it('列表只显示网站/路径与动作，不展示路径计数、CSS或常驻教程，切换开关和行为可直接保存', async () => {
        await mount([rule(), rule('second', {site: 'other.example.com', mode: 'auto', selectors: [['#host', '#content']]})]);
        expect(get('.rule-main strong').textContent).toBe('example.com/articles/');
        expect(root.querySelector('.rule-row details, .rule-row code, .rules-heading p')).toBeNull();
        expect(root.textContent).not.toContain('/100');
        expect(root.textContent).not.toContain('元素路径');
        expect(root.textContent).not.toContain('#comments');
        await change('[data-rule-id="first"] input', false);
        expect(props.config.sectionTranslationRules[0].enabled).toBe(false);
        expect(get('[data-rule-id="first"]').classList.contains('is-disabled')).toBe(true);
        await change('[data-rule-id="first"] select', 'auto');
        expect(props.config.sectionTranslationRules[0].mode).toBe('auto');
        await click('[data-rule-id="first"] .rule-actions button:last-child');
        expect(props.config.sectionTranslationRules.map(rule => rule.id)).toEqual(['second']);
        expect(root.querySelector('[data-rule-id="first"]')).toBeNull();
    });

    it('默认草稿为提醒，显式确认后才创建规则并规范化网站与多层路径', async () => {
        await mount([]); expect(get('.rules-empty').textContent).toContain('区域');
        await draft('EXAMPLE.NET/docs///', ' #host >>> #content \n article .content ');
        expect(get('.rule-advanced').hasAttribute('open')).toBe(true);
        expect(root.querySelector('[data-testid="section-rule-profile"]')).toBeNull();
        expect(props.config.sectionTranslationRules).toEqual([]);
        expect(get<HTMLSelectElement>('.rule-editor select').value).toBe('remind');
        await change('.rule-editor select', 'auto'); await save();
        const saved = props.config.sectionTranslationRules[0];
        expect(saved).toMatchObject({site: 'example.net/docs/', enabled: true, mode: 'auto', selectors: [['#host', '#content'], ['article .content']]});
        expect(saved.id).toMatch(/^section-/u);
        expect(root.querySelector('form')).toBeNull();
        await click('.rule-actions button:first-child');
        expect(root.querySelector('.rules-list')).toBeNull();
        expect(get('.rule-advanced').hasAttribute('open')).toBe(false);
        expect(get<HTMLTextAreaElement>('.rule-editor textarea').value).toBe('#host >>> #content\narticle .content');
        await input('.rule-editor input', 'example.org/articles/'); await save();
        expect(props.config.sectionTranslationRules).toHaveLength(1);
        expect(props.config.sectionTranslationRules[0]).toMatchObject({...saved, site: 'example.org/articles/'});
    });

    it('编辑时高级设置默认关闭，可展开编辑；无效选择器会展开错误所在字段', async () => {
        await mount(); await click('.rule-actions button:first-child');
        const advanced = get<HTMLDetailsElement>('.rule-advanced');
        advanced.open = true; fire(advanced, 'toggle'); await settle();
        expect(advanced.hasAttribute('open')).toBe(true);
        await input('.rule-editor textarea', 'body');
        advanced.open = false; fire(advanced, 'toggle'); await settle();
        expect(advanced.hasAttribute('open')).toBe(false);
        await save();
        expect(advanced.hasAttribute('open')).toBe(true);
        expect(get('[role="alert"]').textContent).toContain('选择器');
        expect(props.config.sectionTranslationRules[0].selectors).toEqual([['#comments']]);
        await input('.rule-editor textarea', '#');
        advanced.open = false; fire(advanced, 'toggle'); await settle(); await save();
        expect(advanced.hasAttribute('open')).toBe(true);
        await input('.rule-editor textarea', '#reading'); await save();
        expect(props.config.sectionTranslationRules[0].selectors).toEqual([['#reading']]);
    });

    it('非法作用域、宽泛选择器和语法错误保留草稿并给出错误，不写入配置', async () => {
        await mount([]); await draft('https://example.com?token=private', '#content'); await save();
        expect(get('[role="alert"]').textContent).toContain('网站');
        expect(props.config.sectionTranslationRules).toEqual([]);
        await input('.rule-editor input', 'example.com'); await input('.rule-editor textarea', 'body'); await save();
        expect(get('[role="alert"]').textContent).toContain('选择器');
        await input('.rule-editor textarea', '#'); await save();
        expect(get('[role="alert"]').textContent).toContain('选择器');
        expect(props.config.sectionTranslationRules).toEqual([]);
        await click('.editor-actions button:first-child');
        expect(root.querySelector('form,[role="alert"]')).toBeNull();
    });

    it('取消编辑保留原数据和快捷方案，新增规则时不让旧行事件改变保存快照', async () => {
        await mount([rule('first', {profileId: 'quick-1'}), rule('second')]);
        const oldToggle = get<HTMLInputElement>('[data-rule-id="first"] input');
        const oldEdit = get('[data-rule-id="first"] .rule-actions button:first-child');
        const oldDelete = get('[data-rule-id="first"] .rule-actions button:last-child');
        await click('[data-rule-id="first"] .rule-actions button:first-child');
        await input('.rule-editor input', 'example.net');
        oldToggle.checked = false; fire(oldToggle, 'change'); fire(oldEdit, 'click'); fire(oldDelete, 'click'); await settle();
        expect(props.config.sectionTranslationRules).toHaveLength(2);
        expect(props.config.sectionTranslationRules[0]).toMatchObject({site: 'example.com/articles/', enabled: true, profileId: 'quick-1'});
        await click('.editor-actions button:first-child');
        await click('[data-rule-id="first"] .rule-actions button:first-child');
        await change('.rule-editor select', 'auto'); await save();
        expect(props.config.sectionTranslationRules[0]).toMatchObject({mode: 'auto', profileId: 'quick-1'});
    });

    it('外部规则变化和页面停用关闭旧草稿，停用后的旧控件事件不能提交', async () => {
        await mount(); await click('.rule-actions button:first-child');
        const oldForm = get('form');
        props.config.sectionTranslationRules = [rule('external', {site: 'new.example.com'})]; await settle();
        expect(root.querySelector('form')).toBeNull(); fire(oldForm, 'submit'); await settle();
        expect(props.config.sectionTranslationRules[0].id).toBe('external');
        const add = get('.rules-heading button'), edit = get('.rule-actions button:first-child'), remove = get('.rule-actions button:last-child'), toggle = get<HTMLInputElement>('.rule-row input');
        await draft(); const form = get('form');
        props.active = false; await settle();
        expect(root.querySelector('form')).toBeNull();
        for (const [node, event] of [[form, 'submit'], [add, 'click'], [edit, 'click'], [remove, 'click'], [toggle, 'change']] as const) fire(node, event);
        await settle(); expect(root.querySelector('form')).toBeNull(); expect(props.config.sectionTranslationRules).toHaveLength(1);
        props.active = true; await settle(); await draft('return.example.com', '#reading'); await save();
        expect(props.config.sectionTranslationRules).toHaveLength(2);
    });

    it('筛选大小写和无结果状态不会修改规则，100条上限禁止继续添加', async () => {
        await mount(Array.from({length: 6}, (_, index) => rule(`rule-${index}`, {site: `site${index}.example.com`})));
        await input('.section-rules > input', ' SITE3.');
        expect(root.querySelectorAll('.rule-row')).toHaveLength(1);
        await input('.section-rules > input', 'missing');
        expect(root.querySelectorAll('.rule-row')).toHaveLength(0); expect(get('.rules-empty').textContent).toContain('没有');
        expect(props.config.sectionTranslationRules).toHaveLength(6);
        props.config.sectionTranslationRules = Array.from({length: 100}, (_, index) => rule(`full-${index}`)); await settle();
        const add = get<HTMLButtonElement>('.rules-heading button'); expect(add.hasAttribute('disabled')).toBe(true); fire(add, 'click'); await settle();
        expect(root.querySelector('form')).toBeNull(); expect(props.config.sectionTranslationRules).toHaveLength(100);
    });

    it('相同内容的新配置对象和卸载后旧表单都不能接收已有草稿', async () => {
        await mount(); await draft();
        const old = props.config, oldForm = get('form');
        props.config = normalizeConfig(JSON.parse(JSON.stringify(props.config))); await settle();
        expect(root.querySelector('form')).toBeNull(); fire(oldForm, 'submit'); await settle();
        expect(props.config.sectionTranslationRules).toHaveLength(1); expect(old.sectionTranslationRules).toHaveLength(1);
        const oldAdd = get('.rules-heading button'); await draft(); const lateForm = get('form');
        app!.unmount(); app = undefined; fire(lateForm, 'submit'); fire(oldAdd, 'click'); await settle();
        expect(props.config.sectionTranslationRules).toHaveLength(1);
    });

    it('缓存停用关闭草稿并拒绝旧事件，重新激活可以创建新规则', async () => {
        await mount([rule()], true, true); const staleAdd = get('.rules-heading button'); await draft();
        const staleForm = get('form');
        visible.value = false; await settle(); fire(staleForm, 'submit'); fire(staleAdd, 'click'); await settle();
        expect(props.config.sectionTranslationRules).toHaveLength(1);
        visible.value = true; await settle(); expect(root.querySelector('form')).toBeNull();
        await draft('new.example.com', '#content'); await save();
        expect(props.config.sectionTranslationRules).toHaveLength(2);
    });

    it('外部替换相同ID的规则后，旧行的切换、编辑和删除都不会作用到新规则', async () => {
        await mount();
        const staleToggle = get<HTMLInputElement>('.rule-row input'), staleMode = get<HTMLSelectElement>('.rule-row select'), staleEdit = get('.rule-actions button:first-child'), staleRemove = get('.rule-actions button:last-child');
        props.config.sectionTranslationRules = [rule('first', {site: 'new.example.com'})];
        staleToggle.checked = false; staleMode.value = 'auto';
        fire(staleToggle, 'change'); fire(staleMode, 'change'); fire(staleEdit, 'click'); fire(staleRemove, 'click'); await settle();
        expect(props.config.sectionTranslationRules).toEqual([rule('first', {site: 'new.example.com'})]);
        expect(root.querySelector('form')).toBeNull();
    });

    it.each([undefined, {}])('无randomUUID的环境仍能显式保存有限规则', async cryptoPort => {
        vi.stubGlobal('crypto', cryptoPort);
        await mount([]); await draft('fallback.example.com', '#content'); await save();
        expect(props.config.sectionTranslationRules).toHaveLength(1);
        expect(props.config.sectionTranslationRules[0].id).toMatch(/^section-\d+-[a-z\d]+$/u);
    });

    it('缺失方案保持原关联并提示，用户可明确清除或重新选择局部方案', async () => {
        await mount([rule('first', {profileId: 'removed-profile'})]);
        expect(root.querySelector('.rule-profile-missing')?.textContent).toBe('方案不可用');
        await click('.rule-actions button:first-child');
        expect(get('.rule-profile-missing').textContent).toContain('重新选择');
        const select = get<HTMLSelectElement>('[data-testid="section-rule-profile"]');
        expect(select.value).toBe('removed-profile');
        expect(get('option[value="removed-profile"]').hasAttribute('disabled')).toBe(true);
        expect(get('option[value=""]').textContent).toBe('跟随默认');
        await save();
        expect(props.config.sectionTranslationRules[0].profileId).toBe('removed-profile');
        await click('.rule-actions button:first-child');
        await change('[data-testid="section-rule-profile"]', ''); await save();
        expect(props.config.sectionTranslationRules[0]).not.toHaveProperty('profileId');
        expect(root.querySelector('.rule-profile-missing')).toBeNull();
        props.config.quickTranslationProfiles = [
            {...createQuickTranslationProfile('section'), id: 'section-alt', hotkey: 'Alt+K', enabled: true},
            {...createQuickTranslationProfile('section'), id: 'section-empty'},
            {...createQuickTranslationProfile('hover'), id: 'hover-only', hotkey: 'Alt+H'},
        ];
        await settle(); await click('.rule-actions button:first-child');
        expect(get('option[value="section-alt"]').textContent).toBe('Alt+K');
        expect(get('option[value="section-empty"]').textContent).toContain('未设置快捷键');
        expect(root.querySelector('option[value="hover-only"]')).toBeNull();
        await change('[data-testid="section-rule-profile"]', 'section-alt'); await save();
        expect(props.config.sectionTranslationRules[0].profileId).toBe('section-alt');
        expect(root.querySelector('.rule-profile-missing')).toBeNull();
        props.config.quickTranslationProfiles = []; await settle();
        await click('.rule-actions button:first-child');
        expect(get('.rule-profile-missing').textContent).toContain('重新选择');
        expect(props.config.sectionTranslationRules[0].profileId).toBe('section-alt');
    });
});
