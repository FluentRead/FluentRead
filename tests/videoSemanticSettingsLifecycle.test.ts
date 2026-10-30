import {afterEach, describe, expect, it, vi} from 'vitest';
const dom = await vi.hoisted(async () => {
  const {parseHTML} = await import('linkedom');
  const {window, document} = parseHTML('<html><body></body></html>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event'])
    Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
  Object.defineProperty(window, 'getSelection', {configurable: true, value: () => ({toString: () => ''})});
  return {document: document as unknown as Document};
});
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key})}));
import {createApp, defineComponent, h, nextTick, reactive, type App} from 'vue';
import {Config} from '@/src/core/config/model';
import Settings from '@/src/features/settings/ui/VideoSemanticSegmentationSettings.vue';
let app: App | undefined;
async function mount() {
  const state = reactive({config: new Config()});
  const config = state.config;
  const host = dom.document.createElement('div');dom.document.body.append(host);
  const services = reactive([{value: 'openai', label: 'AI'}, {value: 'google', label: 'MT'}, {value: 'claude', label: 'Disabled AI', disabled: true}]);
  app = createApp({render: () => h(Settings, {config: state.config, services})});
  // The actual SFC and settings rows run; only external Element Plus control ports are replaced.
  app.component('el-switch', defineComponent({props: ['modelValue'], emits: ['update:modelValue'], setup: (p, {emit}) => () => h('button', {role: 'switch', 'aria-checked': p.modelValue, onClick: () => emit('update:modelValue', !p.modelValue)}, 'toggle')}));
  app.component('el-select', defineComponent({props: ['modelValue'], emits: ['update:modelValue'], setup: (p, {emit, slots}) => () => h('select', {'data-value': p.modelValue, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)}, slots.default?.())}));
  app.component('el-option', defineComponent({props: ['value', 'label'], setup: p => () => h('option', {value: p.value}, p.label)}));
  app.component('el-input', defineComponent({props: ['modelValue'], emits: ['update:modelValue'], setup: (p, {emit}) => () => h('input', {value: p.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)})}));
  app.mount(host);await nextTick();return {config, host, services, state};
}
afterEach(() => {app?.unmount();app = undefined;dom.document.body.replaceChildren();});
describe('AI segmentation settings boundary', () => {
  it('retains its navigation anchor and updates only explicit segmentation fields', async () => {
    const {config, host} = await mount();
    const before = config.videoService;
    expect(host.querySelector('#video-semantic-segmentation')?.getAttribute('data-settings-anchor')).toBe('video-semantic-segmentation');
    expect(host.querySelector('select')).toBeNull();expect(host.querySelector('input')).toBeNull();
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click();await nextTick();
    expect(config.videoSemanticSegmentationEnabled).toBe(true);
    expect(Array.from(host.querySelectorAll('option')).map(x => x.textContent)).toEqual(['AI']);
    const select = host.querySelector('select')!;
    Object.defineProperty(select, 'value', {configurable: true, value: 'openai'});
    select.dispatchEvent(new Event('change'));await nextTick();
    const input = host.querySelector('input')!;input.value = 'chosen-model';input.dispatchEvent(new Event('input'));await nextTick();
    expect(config.videoSemanticSegmentationService).toBe('openai');expect(config.videoSemanticSegmentationModel).toBe('chosen-model');
    expect(config.videoService).toBe(before);
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click();await nextTick();
    expect(host.querySelector('select')).toBeNull();expect(config.videoSemanticSegmentationModel).toBe('chosen-model');
    expect(config.videoSemanticSegmentationService).toBe('openai');
    host.querySelector<HTMLButtonElement>('[role="switch"]')!.click();await nextTick();
    expect(host.querySelector('select')?.getAttribute('data-value')).toBe('openai');
    expect(host.querySelector('input')?.value).toBe('chosen-model');
  });
  it('recomputes service eligibility when the supplied catalog changes', async () => {
    const {config, host, services} = await mount();config.videoSemanticSegmentationEnabled = true;await nextTick();
    services[0].disabled = true;services[2].disabled = false;await nextTick();
    expect(Array.from(host.querySelectorAll('option')).map(x => x.textContent)).toEqual(['Disabled AI']);
  });
  it('reacts to custom provider removal and config replacement without overwriting selections', async () => {
    const {config, host, services, state} = await mount();
    services.push({value: 'custom:local', label: 'Local'});
    config.videoSemanticSegmentationEnabled = true;
    config.videoSemanticSegmentationService = 'custom:local';
    config.videoSemanticSegmentationModel = 'private-model';
    config.customOpenAIProviders = [{id: 'custom:local', name: 'Local', endpoint: 'https://local.example.test/v1', models: ['private-model']}];
    await nextTick();
    expect(host.textContent).toContain('Local');
    config.customOpenAIProviders = [];await nextTick();
    expect(Array.from(host.querySelectorAll('option')).map(x => x.textContent)).toEqual(['AI']);
    expect(config.videoSemanticSegmentationService).toBe('custom:local');
    expect(config.videoSemanticSegmentationModel).toBe('private-model');
    const replacement = new Config();replacement.videoSemanticSegmentationEnabled = true;
    replacement.videoSemanticSegmentationService = 'openai';replacement.videoSemanticSegmentationModel = 'replacement';
    state.config = replacement;await nextTick();
    expect(host.querySelector('select')?.getAttribute('data-value')).toBe('openai');
    expect(host.querySelector('input')?.value).toBe('replacement');
    expect(config.videoSemanticSegmentationModel).toBe('private-model');
  });

});
