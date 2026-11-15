import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TFile as ObsidianFile} from 'obsidian';
import {DOCUMENT_MAX_BYTES} from '../src/features/document-translation/core/document';

class TFile {}
class Dropdown {
    options = new Map<string, string>();
    value = '';
    changed?: (value: string) => unknown;
    addOption(value: string, label: string) {this.options.set(value, label); return this;}
    setValue(value: string) {this.value = value; return this;}
    onChange(callback: (value: string) => unknown) {this.changed = callback; return this;}
}
const state = {
    notices: [] as Array<{message: string; hide: ReturnType<typeof vi.fn>; setMessage: ReturnType<typeof vi.fn>}>,
    translator: vi.fn(), pdf: vi.fn(), dispose: vi.fn(),
    dropdowns: [] as Dropdown[],
    TFile,
    MarkdownView: class MarkdownView {},
    Notice: class Notice {
        hide = vi.fn(); setMessage = vi.fn();
        constructor(public message: string) { state.notices.push(this); }
    },
    Plugin: class Plugin {
        app: unknown;
        loadData = vi.fn(async () => null);
        saveData = vi.fn(async () => {});
        addSettingTab = vi.fn(); addCommand = vi.fn(); registerEvent = vi.fn();
    },
    PluginSettingTab: class PluginSettingTab {
        containerEl = {empty: vi.fn(), createEl: vi.fn()};
        constructor(..._args: unknown[]) {}
    },
    Setting: class Setting {
        constructor(..._args: unknown[]) {}
        setName(_name: string) {return this;}
        setHeading() {return this;}
        addDropdown(callback: (dropdown: Dropdown) => unknown) {
            const dropdown = new Dropdown(); state.dropdowns.push(dropdown); callback(dropdown); return this;
        }
    },
};
let ObsidianPlugin: new () => InspectablePlugin;

// 正常加载实际插件入口，仅替换 Obsidian 应用 API、PDF 和翻译端口。
vi.mock('obsidian', () => ({...state, requestUrl: () => {throw new Error('Unexpected real HTTP request');}}));
vi.mock('../integrations/obsidian/pdf', () => ({extractPdfSegments: (...args: unknown[]) => state.pdf(...args), disposePdfWorker: () => state.dispose()}));
vi.mock('../integrations/obsidian/translation', () => ({createObsidianTranslator: () => (...args: unknown[]) => state.translator(...args)}));
beforeAll(async () => {
    ObsidianPlugin = (await import('../integrations/obsidian/main')).default as unknown as new () => InspectablePlugin;
});

type InspectablePlugin = Omit<import('../integrations/obsidian/main').default, 'translateFile'> & {
    translateFile(file: ObsidianFile): Promise<void>;
};

function fixture() {
    const file = Object.assign(new TFile(), {
        name: 'source.md', path: 'notes/source.md', extension: 'md', parent: {path: 'notes'}, stat: {mtime: 42, size: 6},
    }) as unknown as ObsidianFile;
    const entries = new Map<string, ObsidianFile>([[file.path, file]]);
    const create = vi.fn(async (path: string, content: string) => {
        const output = Object.assign(new TFile(), {path, name: path.split('/').at(-1), content}) as unknown as ObsidianFile;
        entries.set(path, output);
        return output;
    });
    const read = vi.fn(async () => 'Source');
    const openFile = vi.fn(async () => {});
    const workspace = {
        getActiveFile: vi.fn(() => file),
        getActiveViewOfType: vi.fn(() => null),
        getLeaf: vi.fn(() => ({openFile})),
        on: vi.fn((_event: string, _callback: (...args: unknown[]) => void) => ({event: 'menu'})),
    };
    const plugin = new ObsidianPlugin() as unknown as InspectablePlugin;
    const vault = {read, readBinary: vi.fn(async () => new ArrayBuffer(1)), create, getAbstractFileByPath: (path: string) => entries.get(path) ?? null};
    plugin.app = {workspace, vault} as never;
    return {plugin, file, entries, create, read, workspace, openFile, vault};
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}

async function flushSettingsEvents(): Promise<void> {
    // onChange 是原生 void 回调；刷新 Promise 队列，验证 storage 是否真的启动。
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

beforeEach(() => {
    vi.clearAllMocks();
    state.notices.length = 0;
    state.dropdowns.length = 0;
    state.pdf.mockReset();
    state.translator.mockResolvedValue(['译文']);
});

describe('Obsidian plugin job ownership', () => {
    it('does not display a late translation failure after the plugin unloads', async () => {
        const {plugin,file,create}=fixture(),translation=deferred<string[]>();state.translator.mockReturnValueOnce(translation.promise);
        await plugin.onload();const work=plugin.translateFile(file);await vi.waitFor(()=>expect(state.translator).toHaveBeenCalledOnce());
        plugin.onunload();const count=state.notices.length;translation.reject(new Error('native translation channel closed'));await work;
        expect(state.notices).toHaveLength(count);expect(create).not.toHaveBeenCalled();
    });
    it('cleans up a renamed job and prevents a second request for the same moved file', async () => {
        const {plugin, file, entries, create} = fixture();
        const pendingTranslation = deferred<string[]>();
        state.translator.mockReturnValue(pendingTranslation.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(state.translator).toHaveBeenCalledTimes(1));
        entries.delete(file.path);
        file.path = 'moved/renamed.md'; file.name = 'renamed.md'; file.parent = {path: 'moved'} as never;
        entries.set(file.path, file);
        const duplicate = plugin.translateFile(file);
        await Promise.resolve();
        pendingTranslation.resolve(['译文']);
        await duplicate;
        expect(state.translator).toHaveBeenCalledTimes(1);
        await job;
        expect(create).toHaveBeenCalledWith('moved/renamed.bilingual.md', expect.any(String));
        const cancel = vi.mocked(plugin.addCommand).mock.calls.map(([command]) => command).find(command => command.id === 'cancel-document-translation')!;
        expect(cancel.checkCallback!(true)).toBe(false);
        plugin.onunload();
    });

    it('does not register commands or events when settings load finishes after unload', async () => {
        const {plugin} = fixture();
        const loaded = deferred<null>();
        vi.mocked(plugin.loadData).mockReturnValue(loaded.promise);
        const loading = plugin.onload();
        plugin.onunload();
        loaded.resolve(null);
        await loading;
        expect(plugin.addCommand).not.toHaveBeenCalled();
        expect(plugin.registerEvent).not.toHaveBeenCalled();
    });

    it('stops before PDF extraction when cancelled during binary reading', async () => {
        const {plugin, file, vault} = fixture();
        file.extension = 'pdf'; file.name = 'source.pdf';
        const bytes = deferred<ArrayBuffer>();
        vault.readBinary.mockReturnValue(bytes.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(vault.readBinary).toHaveBeenCalled());
        plugin.onunload();
        bytes.resolve(new ArrayBuffer(1));
        await job;
        expect(state.pdf).not.toHaveBeenCalled();
    });

    it('passes cancellation to PDF extraction', async () => {
        const {plugin, file} = fixture();
        file.extension = 'pdf'; file.name = 'source.pdf';
        state.pdf.mockResolvedValue([{id: 0, source: 'PDF Source'}]);
        await plugin.onload();
        await plugin.translateFile(file);
        expect(state.pdf).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.any(AbortSignal));
        plugin.onunload();
    });

    it('rejects oversized PDF bytes even when the earlier file stat was small', async () => {
        const {plugin, file, vault, create} = fixture();
        file.extension = 'pdf'; file.name = 'source.pdf';
        vault.readBinary.mockResolvedValue(new ArrayBuffer(DOCUMENT_MAX_BYTES + 1));
        await plugin.onload();
        await plugin.translateFile(file);
        expect(state.pdf).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(state.notices.at(-1)?.message).toContain('10 MB');
        plugin.onunload();
    });

    it('freezes language settings before an asynchronous source read', async () => {
        const {plugin, file, read} = fixture();
        const reading = deferred<string>();
        read.mockReturnValue(reading.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        plugin.settings = {sourceLanguage: 'fr', targetLanguage: 'de'};
        reading.resolve('Source');
        await job;
        expect(state.translator.mock.calls[0][1]).toMatchObject({sourceLanguage: 'auto', targetLanguage: 'zh-Hans'});
        plugin.onunload();
    });

    it('stops after cancellation during a Markdown read', async () => {
        const {plugin, file, read, create} = fixture();
        const reading = deferred<string>(); read.mockReturnValue(reading.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        const cancel = vi.mocked(plugin.addCommand).mock.calls[1][0];
        cancel.checkCallback!(false);
        reading.resolve('Source'); await job;
        expect(state.translator).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
        plugin.onunload();
    });

    it('stops after unload during PDF extraction', async () => {
        const {plugin, file, create} = fixture();
        file.extension = 'pdf'; file.name = 'source.pdf';
        const extraction = deferred<Array<{id: number; source: string}>>();
        state.pdf.mockReturnValue(extraction.promise);
        await plugin.onload(); const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(state.pdf).toHaveBeenCalled());
        plugin.onunload(); extraction.resolve([{id: 0, source: 'Source'}]); await job;
        expect(state.translator).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    });

    it('ignores late progress/results after cancellation and allows retry once the old job settles', async () => {
        const {plugin, file, create} = fixture();
        const translation = deferred<string[]>();
        state.translator.mockReturnValueOnce(translation.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(state.translator).toHaveBeenCalled());
        const options = state.translator.mock.calls[0][1];
        const cancel = vi.mocked(plugin.addCommand).mock.calls.map(([command]) => command).find(command => command.id === 'cancel-document-translation')!;
        expect(cancel.checkCallback!(true)).toBe(true);
        cancel.checkCallback!(false);
        expect(options.signal.aborted).toBe(true);
        options.onProgress({completed: 1, total: 1});
        translation.resolve(['Late result']);
        await job;
        expect(create).not.toHaveBeenCalled();
        expect(state.notices[0].setMessage).not.toHaveBeenCalled();
        expect(cancel.checkCallback!(true)).toBe(false);
        await plugin.translateFile(file);
        expect(create).toHaveBeenCalledTimes(1);
        plugin.onunload();
    });

    it('does not reopen UI or report success after unload during an in-flight openFile', async () => {
        const {plugin, file, openFile} = fixture();
        const opening = deferred<void>();
        openFile.mockReturnValue(opening.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(openFile).toHaveBeenCalled());
        plugin.onunload();
        opening.resolve();
        await job;
        expect(state.notices.some(({message}) => message.includes('created'))).toBe(false);
        expect(state.notices[0].hide).toHaveBeenCalled();
    });

    it('does not open a note when cancellation arrives during its native create call', async () => {
        const {plugin, file, create, openFile} = fixture();
        const creating = deferred<ObsidianFile>(); create.mockReturnValue(creating.promise);
        await plugin.onload(); const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(create).toHaveBeenCalled());
        plugin.onunload(); creating.resolve(Object.assign(new TFile(), {name: 'output.md'}) as ObsidianFile); await job;
        expect(openFile).not.toHaveBeenCalled();
    });

    it('rejects an edited draft even if the note was moved during translation', async () => {
        const {plugin, file, workspace, entries, create} = fixture();
        let source = 'Draft';
        const view = {file, getViewData: () => source};
        workspace.getActiveViewOfType.mockReturnValue(view as never);
        const translation = deferred<string[]>();
        state.translator.mockReturnValue(translation.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(state.translator).toHaveBeenCalled());
        entries.delete(file.path); file.path = 'moved/source.md'; entries.set(file.path, file);
        source = 'Edited draft';
        translation.resolve(['Outdated']);
        await job;
        expect(create).not.toHaveBeenCalled();
        expect(state.notices.at(-1)?.message).toContain('source note changed');
        plugin.onunload();
    });

    it('revalidates a draft from disk after its original view changes to another file', async () => {
        const {plugin, file, workspace, create, read} = fixture();
        const view = {file, getViewData: () => 'Original draft'};
        workspace.getActiveViewOfType.mockReturnValue(view as never);
        const translation = deferred<string[]>();
        state.translator.mockReturnValue(translation.promise);
        await plugin.onload();
        const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(state.translator).toHaveBeenCalled());
        view.file = Object.assign(new TFile(), {path: 'other.md'}) as never;
        read.mockResolvedValue('Edited draft');
        translation.resolve(['Outdated']);
        await job;
        expect(create).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledTimes(1);
        plugin.onunload();
    });

    it('revalidates a newly active source view before writing', async () => {
        const {plugin, file, workspace, create} = fixture();
        workspace.getActiveViewOfType.mockReturnValueOnce(null).mockReturnValueOnce({file, getViewData: () => 'Edited'} as never);
        await plugin.onload(); await plugin.translateFile(file);
        expect(create).not.toHaveBeenCalled();
        expect(state.notices.at(-1)?.message).toContain('source note changed');
        plugin.onunload();
    });

    it('stops if unloading while rereading a draft whose original view changed', async () => {
        const {plugin, file, workspace, read, create} = fixture();
        const view = {file, getViewData: () => 'Draft'};
        workspace.getActiveViewOfType.mockReturnValue(view as never);
        const translation = deferred<string[]>(); state.translator.mockReturnValue(translation.promise);
        const rereading = deferred<string>(); read.mockReturnValue(rereading.promise);
        await plugin.onload(); const job = plugin.translateFile(file);
        await vi.waitFor(() => expect(state.translator).toHaveBeenCalled());
        view.file = Object.assign(new TFile(), {path: 'other.md'}) as never;
        translation.resolve(['Result']); await vi.waitFor(() => expect(read).toHaveBeenCalled());
        plugin.onunload(); rereading.resolve('Draft'); await job;
        expect(create).not.toHaveBeenCalled();
    });

    it('reports active progress and unknown source failures, then permits retry', async () => {
        const {plugin, file, read} = fixture();
        await plugin.onload(); read.mockRejectedValueOnce('Native source read failed');
        await plugin.translateFile(file);
        expect(state.notices.at(-1)?.message).toContain('Unknown error');
        state.translator.mockImplementationOnce(async (_segments, options) => {
            options.onProgress({completed: 1, total: 1}); return ['Result'];
        });
        await plugin.translateFile(file);
        expect(state.notices.find(({setMessage}) => setMessage.mock.calls.length)?.setMessage)
            .toHaveBeenCalledWith('FluentRead: source.md · 1/1');
        plugin.onunload();
    });

    it('cleans up on provider/storage errors and permits the next explicit request', async () => {
        const {plugin, file, create} = fixture();
        state.translator.mockRejectedValueOnce(new Error('Provider unavailable'));
        await plugin.onload();
        await plugin.translateFile(file);
        expect(state.notices.at(-1)?.message).toContain('Provider unavailable');
        create.mockRejectedValueOnce(new Error('Disk full'));
        await plugin.translateFile(file);
        expect(state.notices.at(-1)?.message).toContain('Disk full');
        await plugin.translateFile(file);
        expect(create).toHaveBeenCalledTimes(2);
        plugin.onunload();
    });

    it('does not translate empty, unsupported or oversized source files', async () => {
        const {plugin, file, read, create} = fixture();
        await plugin.onload();
        read.mockResolvedValue('');
        await plugin.translateFile(file);
        expect(state.notices.at(-1)?.message).toContain('No translatable text');
        file.extension = 'png';
        await plugin.translateFile(file);
        file.extension = 'md'; file.stat.size = DOCUMENT_MAX_BYTES + 1;
        await plugin.translateFile(file);
        file.stat.size = 1; read.mockResolvedValue('A'.repeat(DOCUMENT_MAX_BYTES + 1));
        await plugin.translateFile(file);
        file.stat.size = 1; read.mockResolvedValue('文'.repeat(Math.floor(DOCUMENT_MAX_BYTES / 3) + 1));
        await plugin.translateFile(file);
        expect(state.notices.at(-1)?.message).toContain('10 MB');
        expect(state.translator).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        plugin.onunload();
    });

    it('does not send a quote-contained code block from the actual plugin chain', async () => {
        const {plugin, file, read} = fixture();
        read.mockResolvedValue('> ```js\n> const secret = 1;\n> ```\nVisible [[source]] - keep the dash.');
        state.translator.mockResolvedValue(['可见', '保留破折号']);
        await plugin.onload();
        await plugin.translateFile(file);
        expect(state.translator.mock.calls[0][0].map(({source}: {source: string}) => source)).toEqual(['Visible', '- keep the dash.']);
        plugin.onunload();
    });
});

describe('Obsidian plugin commands, menus and settings', () => {
    it.each([0, 1])('handles a rejected native settings write from dropdown %i and allows the next save', async index => {
        const {plugin} = fixture(); await plugin.onload();
        vi.mocked(plugin.addSettingTab).mock.calls[0][0].display();
        vi.mocked(plugin.saveData).mockRejectedValueOnce(new Error('native settings disk full'));
        state.dropdowns[index].changed!('fr');
        await vi.waitFor(() => expect(state.notices.at(-1)?.message).toContain('native settings disk full'));
        state.dropdowns[index].changed!('de');
        await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(2));
        expect(plugin.settings[index === 0 ? 'sourceLanguage' : 'targetLanguage']).toBe('de');
        plugin.onunload();
    });
    it('loads validated settings and exposes palette checks without starting work', async () => {
        const {plugin, file, workspace} = fixture();
        vi.mocked(plugin.loadData).mockResolvedValue({sourceLanguage: 'fr', targetLanguage: 'de'});
        await plugin.onload();
        expect(plugin.settings).toEqual({sourceLanguage: 'fr', targetLanguage: 'de'});
        const translate = vi.mocked(plugin.addCommand).mock.calls[0][0];
        expect(translate.checkCallback!(true)).toBe(true);
        file.extension = 'png'; expect(translate.checkCallback!(true)).toBe(false);
        workspace.getActiveFile.mockReturnValue(null as never); expect(translate.checkCallback!(false)).toBe(false);
        expect(state.translator).not.toHaveBeenCalled();
        plugin.onunload();
    });

    it('executes a palette command and disables it after unload', async () => {
        const {plugin, create} = fixture(); await plugin.onload();
        const translate = vi.mocked(plugin.addCommand).mock.calls[0][0];
        expect(translate.checkCallback!(false)).toBe(true);
        await vi.waitFor(() => expect(create).toHaveBeenCalled());
        plugin.onunload(); expect(translate.checkCallback!(false)).toBe(false);
    });

    it.each([null, {sourceLanguage: 'unknown', targetLanguage: 'auto'}, {sourceLanguage: 42, targetLanguage: {}}])
        ('falls back for absent or malformed saved languages: %j', async stored => {
            const {plugin} = fixture();
            vi.mocked(plugin.loadData).mockResolvedValue(stored);
            await plugin.onload();
            expect(plugin.settings).toEqual({sourceLanguage: 'auto', targetLanguage: 'zh-Hans'});
            plugin.onunload();
        });

    it('builds a file menu only for supported files and ignores callbacks after unload', async () => {
        const {plugin, file, workspace, create} = fixture();
        await plugin.onload();
        const handler = workspace.on.mock.calls[0][1];
        const item = {setTitle: vi.fn(() => item), setIcon: vi.fn(() => item), onClick: vi.fn()};
        const menu = {addItem: vi.fn((callback: (value: typeof item) => void) => callback(item))};
        handler(menu, file);
        expect(item.setTitle).toHaveBeenCalledWith('Translate with FluentRead');
        expect(item.setIcon).toHaveBeenCalledWith('languages');
        item.onClick.mock.calls[0][0]();
        await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        handler(menu, {extension: 'md'});
        file.extension = 'png'; handler(menu, file);
        expect(menu.addItem).toHaveBeenCalledTimes(1);
        plugin.onunload();
        file.extension = 'md'; handler(menu, file);
        expect(menu.addItem).toHaveBeenCalledTimes(1);
        expect(state.dispose).toHaveBeenCalledTimes(1);
    });

    it('displays current languages and persists dropdown choices in order', async () => {
        const {plugin} = fixture();
        await plugin.onload();
        const tab = vi.mocked(plugin.addSettingTab).mock.calls[0][0];
        tab.display();
        expect(state.dropdowns.map(({value}) => value)).toEqual(['auto', 'zh-Hans']);
        expect(state.dropdowns[0].options.has('auto')).toBe(true);
        expect(state.dropdowns[1].options.has('fr')).toBe(true);
        state.dropdowns[0].changed!('fr');
        state.dropdowns[1].changed!('de');
        await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(2));
        expect(vi.mocked(plugin.saveData).mock.calls.map(([value]) => value)).toEqual([
            {sourceLanguage: 'fr', targetLanguage: 'zh-Hans'}, {sourceLanguage: 'fr', targetLanguage: 'de'},
        ]);
        plugin.onunload();
    });

    it('serializes pending saves and recovers after one save fails', async () => {
        const {plugin} = fixture();
        await plugin.onload();
        const first = deferred<void>();
        vi.mocked(plugin.saveData).mockReturnValueOnce(first.promise);
        plugin.settings.sourceLanguage = 'fr';
        const firstSave = plugin.saveSettings().catch(error => error);
        plugin.settings.sourceLanguage = 'de';
        const secondSave = plugin.saveSettings();
        await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(1));
        expect(vi.mocked(plugin.saveData).mock.calls[0][0]).toEqual({sourceLanguage: 'fr', targetLanguage: 'zh-Hans'});
        first.reject(new Error('Save failed'));
        expect(await firstSave).toMatchObject({message: 'Save failed'});
        await secondSave;
        expect(vi.mocked(plugin.saveData).mock.calls[1][0]).toEqual({sourceLanguage: 'de', targetLanguage: 'zh-Hans'});
        expect(state.notices.at(-1)?.message).toContain('Save failed');
        plugin.onunload();
    });

    it('reports unknown settings failures but keeps late failures silent after unload', async () => {
        const {plugin} = fixture(); await plugin.onload();
        vi.mocked(plugin.saveData).mockRejectedValueOnce('Unknown native failure');
        await expect(plugin.saveSettings()).rejects.toBe('Unknown native failure');
        expect(state.notices.at(-1)?.message).toContain('Unknown error');
        const saving = deferred<void>(); vi.mocked(plugin.saveData).mockReturnValueOnce(saving.promise);
        const late = plugin.saveSettings().catch(error => error);
        await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(2));
        plugin.onunload(); const noticeCount = state.notices.length;
        saving.reject(new Error('Late failure')); await late;
        expect(state.notices).toHaveLength(noticeCount);
    });

    it.each([0, 1])('ignores cached dropdown %i after unload before mutating settings or saving', async index => {
        const {plugin} = fixture(); await plugin.onload();
        const tab = vi.mocked(plugin.addSettingTab).mock.calls[0][0]; tab.display();
        const changed = state.dropdowns[index].changed!;
        const snapshot = {...plugin.settings};
        plugin.onunload(); changed('fr'); await flushSettingsEvents();
        expect.soft(plugin.settings).toEqual(snapshot);
        expect.soft(plugin.saveData).not.toHaveBeenCalled();
    });

    it.each([0, 1])('keeps cached dropdown %i bound to its original session after a same-instance restart', async index => {
        const {plugin} = fixture(); await plugin.onload();
        const oldTab = vi.mocked(plugin.addSettingTab).mock.calls[0][0]; oldTab.display();
        const oldChanged = state.dropdowns[index].changed!;
        plugin.onunload();
        vi.mocked(plugin.loadData).mockResolvedValue({sourceLanguage: 'en', targetLanguage: 'ja'});
        await plugin.onload(); const snapshot = {...plugin.settings};
        oldChanged('fr'); await flushSettingsEvents();
        expect.soft(plugin.settings).toEqual(snapshot);
        expect.soft(plugin.saveData).not.toHaveBeenCalled();
        const currentTab = vi.mocked(plugin.addSettingTab).mock.calls.at(-1)![0]; currentTab.display();
        state.dropdowns.at(-1)!.changed!('de'); await flushSettingsEvents();
        expect(plugin.saveData).toHaveBeenCalledWith({sourceLanguage: 'en', targetLanguage: 'de'});
        plugin.onunload();
    });

    it('does not redisplay a retired tab in a new session', async () => {
        const {plugin} = fixture(); await plugin.onload();
        const oldTab = vi.mocked(plugin.addSettingTab).mock.calls[0][0]; oldTab.display();
        plugin.onunload(); await plugin.onload(); oldTab.display();
        expect(state.dropdowns).toHaveLength(2);
        plugin.onunload();
    });

    it('does not start direct settings saves before loading or after unload', async () => {
        const {plugin} = fixture(); await plugin.saveSettings();
        await plugin.onload(); plugin.onunload(); await plugin.saveSettings();
        expect(plugin.saveData).not.toHaveBeenCalled();
    });

    it('does not start settings storage while a new session is still loading', async () => {
        const {plugin} = fixture(); const loaded = deferred<null>();
        vi.mocked(plugin.loadData).mockReturnValue(loaded.promise);
        const loading = plugin.onload(); await plugin.saveSettings();
        loaded.resolve(null); await loading;
        expect(plugin.saveData).not.toHaveBeenCalled();
        plugin.onunload();
    });

    it('allows an issued settings save to settle but skips storage still queued at unload', async () => {
        const {plugin} = fixture(); await plugin.onload(); const first = deferred<void>();
        vi.mocked(plugin.saveData).mockReturnValueOnce(first.promise);
        const issued = plugin.saveSettings(); await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(1));
        plugin.settings.sourceLanguage = 'fr'; const queued = plugin.saveSettings();
        plugin.onunload(); first.resolve(); await Promise.all([issued, queued]);
        expect(plugin.saveData).toHaveBeenCalledTimes(1);
    });

    it('skips old queued settings writes while keeping new-session saves in order', async () => {
        const {plugin} = fixture(); await plugin.onload(); const first = deferred<void>();
        vi.mocked(plugin.saveData).mockReturnValueOnce(first.promise);
        const issued = plugin.saveSettings(); await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(1));
        plugin.settings.sourceLanguage = 'fr'; const oldQueued = plugin.saveSettings();
        plugin.onunload(); await plugin.onload();
        plugin.settings.targetLanguage = 'de'; const current = plugin.saveSettings();
        first.resolve(); await Promise.all([issued, oldQueued, current]);
        expect(vi.mocked(plugin.saveData).mock.calls.map(([value]) => value)).toEqual([
            {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'}, {sourceLanguage: 'auto', targetLanguage: 'de'},
        ]);
        plugin.onunload();
    });

    it('does not report a prior-session settings error in a restarted session', async () => {
        const {plugin} = fixture(); await plugin.onload(); const first = deferred<void>();
        vi.mocked(plugin.saveData).mockReturnValueOnce(first.promise);
        const saving = plugin.saveSettings().catch(error => error);
        await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledTimes(1));
        plugin.onunload(); await plugin.onload(); const noticeCount = state.notices.length;
        first.reject(new Error('Retired session error')); await saving;
        expect(state.notices).toHaveLength(noticeCount);
        plugin.onunload();
    });
});
