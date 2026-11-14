/**
 * @file integrations/zotero/workspace.ts
 * 文件职责：在 Zotero 独立内容窗口中组装 Vue 工作台，提供任务、服务设置与划词双语笔记。
 * 主要内容：设置保存先于入队；使用不可变服务快照续译，重启任务等待用户继续；界面只以文本显示原文与服务结果。
 * 模块边界：通过 window.arguments 注入宿主端口，PDF 与网络交给引擎，文件与数据库交给 ZoteroHost。
 */
import {createApp, h, ref} from 'vue';
import {translationLanguageOptions} from '../../src/core/language/catalog';
import type {AttachmentSource, TaskSettings, TranslationSettings, TranslationTask, ZoteroHost} from './contracts';
import {createZoteroEngine} from './engine';
import {escapeNoteHtml, taskSettings, ZoteroTaskQueue} from './queue';
import {normalizeCompatibleEndpoint, normalizeSettings} from './settings';
import {parseZoteroGlossary} from './translation';
import {createZoteroFontLoader} from './fontCache';

interface SelectionRequest {attachmentID: number; text: string; page?: number}
type SelectedAttachments = Array<Pick<AttachmentSource, 'id' | 'libraryID' | 'key' | 'title'>>;
interface WorkspaceOptions {host: ZoteroHost; initialSelection?: unknown; attachments?: SelectedAttachments; selection?: SelectionRequest}
interface WorkspaceWindow extends Window {
    arguments?: WorkspaceOptions[];
    FluentReadWorkspace?: {receive(options: Partial<WorkspaceOptions>): void; dispose(): Promise<void>};
    FluentReadWorkspacePending?: Array<Partial<WorkspaceOptions>>;
}
const ownWindow = window as WorkspaceWindow;
let windowClosed = false;
window.addEventListener('unload', () => {windowClosed = true;}, {once: true});
const options = ownWindow.arguments?.[0];
const container = document.getElementById('fluentread-workspace');
const labels: Record<TranslationTask['state'], string> = {
    queued: '排队中', running: '翻译中', paused: '已暂停', failed: '需重试', completed: '已完成', canceled: '已取消',
};
const languageLabel = (value: string) => value === 'auto' ? '自动检测'
    : translationLanguageOptions.find(option => option.value === value)?.label || value;

if (!options?.host || !container) {
    if (container) container.textContent = '请从 Zotero 的流畅阅读菜单打开此工作台。';
} else {
    void startWorkspace(options, container).catch(error => {
        if (windowClosed || ownWindow.closed) return;
        container.textContent = `流畅阅读未能启动：${error instanceof Error ? error.message : '请重新打开工作台'}`;
    });
}

async function startWorkspace(initial: WorkspaceOptions, mount: HTMLElement): Promise<void> {
    const host = initial.host;
    const settings = ref<TranslationSettings>(await host.loadSettings());
    let persistedSettings = {...settings.value};
    if (windowClosed || ownWindow.closed) return;
    const engine = createZoteroEngine({pdfFontLoader: host.fontCache ? createZoteroFontLoader(host.fontCache) : undefined});
    const queue = new ZoteroTaskQueue(host, engine, () => ({...persistedSettings}));
    const revision = ref(0);
    const openSelect = ref('');       // Windows 下 Zotero 内容窗口的原生 <select> 弹层渲染异常，改为自绘下拉
    const notice = ref(''); const errorNotice = ref(false); const showSettings = ref(false);
    const busy = ref(false); const selection = ref<SelectionRequest | null>(initial.selection || null);
    const selectionResult = ref(''); const selectionBusy = ref(false);
    const selectionSaving = ref(false); const selectionSaved = ref(false);
    let selectionController: AbortController | undefined;
    let selectionSettings: TaskSettings | undefined;
    let selectionSource: AttachmentSource | undefined;
    let selectionSaveID = '';
    let selectionGeneration = 0;
    let disposed = false;
    let settingsWrites: Promise<void> = Promise.resolve();
    let enqueueRequests: Promise<unknown> = Promise.resolve();
    const announce = (message: string, error = false) => {notice.value = message; errorNotice.value = error;};
    const safe = async (operation: () => Promise<unknown>) => {
        try {await operation();} catch (error) {
            if (disposed) return;
            if (error instanceof Error && error.name === 'AbortError') return;
            let message = error instanceof Error ? error.message : '操作未完成，请重试';
            if (settings.value.apiKey) message = message.replaceAll(settings.value.apiKey, '[已隐藏]');
            announce(message.slice(0, 600), true);
        }
    };
    const saveSettings = async (draft = {...settings.value}): Promise<TranslationSettings> => {
        if (draft.service === 'compatible') {
            normalizeCompatibleEndpoint(draft.endpoint);
            if (!draft.model.trim() || /[\u0000-\u001f]/u.test(draft.model)) throw new Error('请填写有效的模型名称');
        }
        parseZoteroGlossary(draft.glossary);
        const snapshot = normalizeSettings(draft);
        // A queued action must not replace edits made after it was accepted or share its snapshot with the form.
        if ((Object.keys(draft) as Array<keyof TranslationSettings>).every(key => settings.value[key] === draft[key])) {
            settings.value = {...snapshot};
        }
        const saving = settingsWrites.catch(() => undefined).then(async () => {
            await host.saveSettings(snapshot);
            persistedSettings = {...snapshot};
        });
        settingsWrites = saving; await saving;
        return snapshot;
    };
    const enqueue = async (attachments?: SelectedAttachments, draft = {...settings.value}) => {
        if (busy.value || disposed) return;
        busy.value = true;
        try {
            const [selected, snapshot] = await Promise.all([
                attachments ?? host.selectedAttachments(), saveSettings(draft),
            ]);
            if (disposed) return;
            const count = await queue.enqueue(selected, snapshot);
            if (count) announce(`已加入 ${count} 个 PDF，将按顺序翻译`);
        } finally {busy.value = false;}
    };
    const update = (key: keyof TranslationSettings, value: string | boolean) => {
        Object.assign(settings.value, {[key]: value});
    };
    const requestEnqueue = (attachments?: SelectedAttachments) => {
        const draft = {...settings.value};
        const next = enqueueRequests.catch(() => undefined).then(() => enqueue(attachments, draft));
        enqueueRequests = next; return next;
    };
    const receive = (next: Partial<WorkspaceOptions>) => {
        if (disposed) return;
        if (next.selection) {
            selectionController?.abort(); selectionGeneration++;
            selection.value = next.selection; selectionResult.value = ''; selectionBusy.value = false;
            selectionSaving.value = false; selectionSaved.value = false; selectionSaveID = '';
            selectionSource = undefined;
        }
        if (next.initialSelection) void safe(() => requestEnqueue(next.attachments));
    };
    const translateSelection = async () => {
        if (!selection.value || selectionBusy.value || selectionSaving.value) return;
        selectionController?.abort();
        const controller = selectionController = new AbortController();
        const generation = ++selectionGeneration;
        const captured = {...selection.value};
        const text = captured.text;
        selectionBusy.value = true; selectionResult.value = ''; selectionSaved.value = false; selectionSaveID = '';
        selectionSource = undefined;
        announce('');
        try {
            const snapshot = await saveSettings(); controller.signal.throwIfAborted();
            const source = await host.readAttachment(captured.attachmentID, controller.signal, 'selection');
            controller.signal.throwIfAborted();
            // Retain source identity, not a second PDF buffer, for the later explicit note commit.
            source.bytes = new Uint8Array();
            if (!disposed && generation === selectionGeneration) selectionSource = source;
            selectionSettings = taskSettings(snapshot);
            const translated = await engine.selection(text, snapshot, controller.signal);
            if (!disposed && generation === selectionGeneration) selectionResult.value = translated;
        } catch (error) {
            if (!disposed && generation === selectionGeneration && !controller.signal.aborted) throw error;
        } finally {if (generation === selectionGeneration) selectionBusy.value = false;}
    };
    const saveSelection = async () => {
        if (!selection.value || !selectionResult.value || !selectionSettings || !selectionSource || selectionSaving.value || selectionSaved.value) return;
        const captured = {...selection.value}; const translated = selectionResult.value;
        const source = selectionSource;
        const generation = selectionGeneration;
        selectionSaving.value = true;
        const controller = selectionController = new AbortController();
        try {
            controller.signal.throwIfAborted();
            if (disposed) return;
            const page = Math.max(1, captured.page || 1);
            const link = source.sourceURI ? `<a href="${escapeNoteHtml(`${source.sourceURI}?page=${page}`)}">查看原文 · 第 ${page} 页</a>` : `第 ${page} 页`;
            const html = `<div data-schema-version="9"><h1>划词翻译 · ${escapeNoteHtml(source.title)}</h1><p>${link}</p>`
                + `<blockquote><p>${escapeNoteHtml(captured.text).replace(/\n/gu, '<br/>')}</p></blockquote>`
                + `<p>${escapeNoteHtml(translated).replace(/\n/gu, '<br/>')}</p></div>`;
            const now = Date.now();
            selectionSaveID ||= `fr-selection-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const task: TranslationTask = {id: selectionSaveID,
                attachmentID: source.id, libraryID: source.libraryID, attachmentKey: source.key, title: source.title,
                fingerprint: source.fingerprint, state: 'completed', phase: '划词翻译', createdAt: now, updatedAt: now,
                settings: selectionSettings, translations: [translated], completed: 1, total: 1};
            await host.saveNote(source, task, html, controller.signal);
            if (!disposed && generation === selectionGeneration) {
                selectionSaved.value = true;
                announce('原文、译文和页码链接已保存到文献笔记');
            }
        } catch (error) {
            if (!disposed && generation === selectionGeneration && !controller.signal.aborted) throw error;
        } finally {if (generation === selectionGeneration) selectionSaving.value = false;}
    };
    const unsubscribe = queue.subscribe(() => revision.value++);
    await queue.initialize();
    if (windowClosed || ownWindow.closed) {unsubscribe(); await queue.dispose(); return;}

    function selectField(key: keyof TranslationSettings, title: string, values: Array<{value: string; label: string}>) {
        const current = values.find(option => option.value === settings.value[key]);
        const isOpen = openSelect.value === key;
        return h('label', [h('span', title), h('div', {class: 'dropdown'}, [
            h('button', {type: 'button', class: 'dropdown-toggle', 'aria-haspopup': 'listbox', 'aria-expanded': isOpen,
                onClick: () => {openSelect.value = isOpen ? '' : key;}},
                [h('span', {class: 'dropdown-label'}, String(current?.label ?? settings.value[key])), h('span', {class: 'dropdown-caret'}, '▾')]),
            isOpen ? h('div', {class: 'dropdown-backdrop', onClick: () => {openSelect.value = '';}}) : null,
            isOpen ? h('ul', {class: 'dropdown-menu', role: 'listbox', 'aria-label': title},
                values.map(option => h('li', {key: option.value, role: 'option',
                    'aria-selected': option.value === settings.value[key],
                    class: option.value === settings.value[key] ? 'active' : '',
                    onClick: (event: MouseEvent) => {
                        event.preventDefault();      // 阻止 label 转发点击到按钮导致重新展开
                        update(key, option.value);
                        openSelect.value = '';
                    }}, option.label))) : null,
        ])]);
    }
    const button = (text: string, operation: () => Promise<unknown>, className = '', disabled = false) =>
        h('button', {type: 'button', class: className, disabled, onClick: () => void safe(operation)}, text);
    const inputField = (key: keyof TranslationSettings, title: string, type = 'text', placeholder = '') => h('label', {class: 'field'}, [
        h('span', title), h('input', {type, value: settings.value[key], placeholder, autocomplete: 'off', spellcheck: false,
            onInput: (event: Event) => update(key, (event.target as HTMLInputElement).value)}),
    ]);
    function renderTask(task: TranslationTask) {
        const actions = [button('原文', () => host.openSource(task.attachmentID))];
        if (task.state === 'queued' || task.state === 'running') actions.push(button('暂停', () => queue.pause(task.id)));
        if (task.state === 'paused' || task.state === 'failed') actions.push(button(task.state === 'failed' ? '重试' : '继续', () => queue.resume(task.id), 'primary'));
        if (!['completed', 'canceled'].includes(task.state)) actions.push(button('取消', () => queue.cancel(task.id), 'quiet danger'));
        if (task.outputAttachmentID) actions.push(button('打开译文', () => host.openAttachment(task.outputAttachmentID!), 'primary'));
        if (task.state === 'completed') actions.push(button(task.noteID ? '笔记已保存' : '保存双语笔记', () => queue.saveBilingualNote(task.id), '', !!task.noteID));
        return h('article', {key: task.id, class: 'task', 'aria-label': task.title}, [
            h('div', {class: 'task-top'}, [h('div', {class: 'task-title'}, task.title), h('span', {class: 'badge'}, labels[task.state])]),
            h('div', {class: 'task-meta'}, `${languageLabel(task.settings.sourceLanguage)} → ${languageLabel(task.settings.targetLanguage)} · ${task.settings.service === 'microsoft' ? '微软翻译' : task.settings.model} · ${task.settings.output === 'bilingual' ? '双语 PDF' : '译文 PDF'}`),
            h('p', {class: 'muted'}, task.phase),
            task.total ? h('progress', {max: task.total, value: task.completed, 'aria-label': `${task.completed}/${task.total} 段`}) : null,
            task.error ? h('p', {class: 'task-error'}, task.error) : null,
            h('div', {class: 'actions'}, actions),
        ]);
    }
    const app = createApp({render() {
        void revision.value;
        const tasks = [...queue.tasks].reverse();
        const active = tasks.filter(task => ['running', 'queued', 'paused', 'failed'].includes(task.state)).length;
        return h('main', {class: 'app'}, [
            h('header', {class: 'header'}, [h('div', [h('h1', '流畅阅读'), h('p', {class: 'subtitle'}, 'Zotero · 论文翻译与双语笔记')]),
                h('div', {class: 'row'}, [h('button', {type: 'button', 'aria-expanded': showSettings.value, onClick: () => {showSettings.value = !showSettings.value;}}, '翻译设置'),
                    button(busy.value ? '正在加入…' : '翻译所选文献', enqueue, 'primary', busy.value)])]),
            h('div', {class: 'toolbar'}, [
                selectField('sourceLanguage', '原文', [{value: 'auto', label: '自动检测'}, ...translationLanguageOptions]),
                selectField('targetLanguage', '译文', translationLanguageOptions),
                selectField('output', '输出', [{value: 'bilingual', label: '双语 PDF'}, {value: 'translated', label: '仅译文 PDF'}]),
            ]),
            h('p', {class: 'privacy'}, '在本地解析 PDF；点击翻译后，将待译文字和必要的翻译提示发送给所选服务。译文保存为新附件，原文和已有批注保留。'),
            notice.value ? h('div', {class: ['notice', errorNotice.value ? 'error' : ''], role: errorNotice.value ? 'alert' : 'status'}, notice.value) : null,
            showSettings.value ? h('section', {class: 'panel'}, [h('h2', '翻译设置'), h('div', {class: 'settings'}, [
                h('div', {class: 'field'}, [selectField('service', '翻译服务', [{value: 'microsoft', label: '微软翻译 · 无需密钥'}, {value: 'compatible', label: '自定义兼容模型'}])]),
                h('label', {class: 'check'}, [h('input', {type: 'checkbox', checked: settings.value.autoOpen,
                    onChange: (event: Event) => update('autoOpen', (event.target as HTMLInputElement).checked)}), '完成后打开译文']),
                ...(settings.value.service === 'compatible' ? [inputField('endpoint', '模型服务地址', 'url', 'https://example.com/v1'),
                    inputField('model', '模型名称', 'text', '填写服务支持的模型'), inputField('apiKey', 'API 密钥（仅保存在本机）', 'password')] : []),
                h('label', {class: 'field wide'}, [h('span', '学术术语 · 每行一条，格式：原文 = 译文'), h('textarea', {rows: 3, value: settings.value.glossary,
                    placeholder: 'large language model = 大语言模型', onInput: (event: Event) => update('glossary', (event.target as HTMLTextAreaElement).value)})]),
                h('div', {class: 'wide row'}, [button('保存设置', async () => {await saveSettings(); announce('设置已保存，新任务将使用这些设置');}, 'primary'),
                    h('span', {class: 'muted'}, '已有任务保留开始时的语言、模型和术语设置。')]),
            ])]) : null,
            selection.value ? h('section', {class: 'panel'}, [h('div', {class: 'section-title'}, [h('h2', '划词翻译'),
                    h('button', {type: 'button', class: 'quiet', onClick: () => {selectionController?.abort(); selectionGeneration++; selection.value = null; selectionSource = undefined; selectionBusy.value = false;}}, '关闭')]),
                h('blockquote', {class: 'selection-source'}, selection.value.text),
                selectionResult.value ? h('div', {class: 'selection-result', role: 'status'}, selectionResult.value) : null,
                h('div', {class: 'actions'}, [button(selectionBusy.value ? '正在翻译…' : '翻译选中文字', translateSelection, 'primary', selectionBusy.value || selectionSaving.value),
                    ...(selectionBusy.value ? [button('取消', async () => {selectionController?.abort();}, 'quiet')] : []),
                    ...(selectionResult.value ? [button(selectionSaved.value ? '笔记已保存' : selectionSaving.value ? '正在保存…' : '保存为双语笔记', saveSelection, '', selectionSaving.value || selectionSaved.value)] : []),
                    button('查看原文', () => host.openSource(selection.value!.attachmentID, selection.value!.page))]),
            ]) : null,
            h('section', {'aria-label': '翻译任务'}, [h('div', {class: 'section-title'}, [h('h2', active ? `翻译任务 · ${active} 项待处理` : '翻译任务'),
                tasks.some(task => ['completed', 'canceled'].includes(task.state)) ? button('清理已结束记录', () => queue.clearFinished(), 'quiet') : null]),
                tasks.length ? tasks.map(renderTask) : h('div', {class: 'empty'}, [h('h2', '从一篇论文开始'),
                    h('p', '在 Zotero 中选中文献或 PDF，可一次选择多篇。'), button('翻译所选文献', enqueue, 'primary', busy.value)]),
            ]),
            h('p', {class: 'footer'}, '已完成的段落会保存在本机，暂停或重启后可继续。扫描件需先添加 OCR 文字层；PDF 导出字体首次使用时按需下载。'),
        ]);
    }});
    app.mount(mount);
    const dispose = async () => {
        if (disposed) return;
        disposed = true; selectionController?.abort(); selectionGeneration++;
        unsubscribe(); app.unmount(); await queue.dispose();
    };
    ownWindow.FluentReadWorkspace = {receive, dispose};
    window.addEventListener('unload', () => {void dispose().catch(() => undefined);}, {once: true});
    if (initial.initialSelection) await safe(() => requestEnqueue(initial.attachments));
    for (const pending of ownWindow.FluentReadWorkspacePending?.splice(0) || []) receive(pending);
}
