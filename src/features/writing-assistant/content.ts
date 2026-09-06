/**
 * @file src/features/writing-assistant/content.ts
 * 文件职责：将写作网页界面挂载到 WXT 管理的隔离 Shadow DOM。
 * 主要内容：固定宿主身份，防止重复挂载，异步挂载失效后立即移除。
 * 模块边界：只组装 UI，不实现模型、编辑器或配置策略；应用注册表控制启停。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createVueShadowUi} from '@/src/platform/shadow-ui/vue';
import WritingSurface from './ui/WritingSurface.vue';
let mounted: Awaited<ReturnType<typeof createVueShadowUi>> | undefined;
let generation = 0;
export async function mountWritingAssistant(ctx: ContentScriptContext): Promise<void> {
    const owner = ++generation;
    const ui = await createVueShadowUi(ctx, {name: 'fluent-read-writing-assistant', hostId: 'fluent-read-writing-assistant', component: WritingSurface});
    if (owner !== generation) { ui.remove(); return; }
    mounted?.remove(); mounted = ui;
}
export function unmountWritingAssistant(): void { generation++; mounted?.remove(); mounted = undefined; }
export function isWritingAssistantMounted(): boolean { return Boolean(mounted); }
