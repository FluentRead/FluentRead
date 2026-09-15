import {afterEach, describe, expect, it, vi} from 'vitest';

import {
    addPressedHotkeyEventKey,
    canonicalizeHotkey,
    deletePressedHotkeyEventKey,
    matchesConfiguredHotkey,
    matchesHotkey,
    matchesModifierOnlyHotkey,
    normalizeHotkeyEventKey,
    parseHotkey,
    resolveConfiguredHotkey,
    shouldClaimConfiguredHotkey,
    validateHotkeyConflicts,
    type ParsedHotkey,
} from '@/src/core/hotkey';

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
        key: 't',
        code: 'KeyT',
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        ...overrides,
    } as KeyboardEvent;
}

describe('hotkey parsing', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('拒绝空值、未知修饰键、未知普通键和单字母裸键', () => {
        expect(parseHotkey('')).toMatchObject({isValid: false, errorMessage: '快捷键不能为空'});
        expect(parseHotkey('Ctrl+Hyper+T')).toMatchObject({isValid: false, errorMessage: '不支持的修饰键: hyper'});
        expect(parseHotkey('Ctrl+Launch')).toMatchObject({isValid: false, errorMessage: '不支持的按键: launch'});
        expect(parseHotkey('a')).toMatchObject({isValid: false, errorMessage: '单个字母键需要与修饰键组合使用'});
    });

    it('合并重复修饰键并按平台生成展示名', () => {
        // 展示名取决于 navigator.platform。Node 21 起全局就存在 navigator，宿主平台会
        // 泄漏进来，因此非 macOS 分支同样要显式 stub，不能依赖 navigator 缺失。
        vi.stubGlobal('navigator', {platform: 'Win32'});
        expect(parseHotkey('Ctrl+Control+Alt+Space')).toEqual({
            modifiers: ['ctrl', 'alt'],
            key: 'space',
            isValid: true,
            displayName: 'Ctrl+Alt+Space',
        });

        vi.stubGlobal('navigator', {platform: 'MacIntel'});
        expect(parseHotkey('Option+Enter')).toEqual({
            modifiers: ['alt'],
            key: 'enter',
            isValid: true,
            displayName: 'Option+Enter',
        });

        // 没有 navigator 的宿主（Node 20 等）走空平台回退，展示名与非 macOS 一致。
        // 显式覆盖这一分支，避免它的覆盖率取决于运行测试的 Node 版本。
        vi.stubGlobal('navigator', undefined);
        expect(parseHotkey('Option+Enter').displayName).toBe('Alt+Enter');
    });

    it('禁用 meta/cmd 组合并允许非字母裸键', () => {
        expect(parseHotkey('Cmd+K')).toMatchObject({
            isValid: false,
            errorMessage: 'CMD 键已被禁用，请使用其他修饰键组合',
        });
        expect(parseHotkey('F4')).toMatchObject({isValid: true, key: 'f4'});
        expect(parseHotkey('/')).toMatchObject({isValid: true, key: '/'});
    });

    it('以稳定格式保留多个 Ctrl 方案，并统一别名与修饰键顺序', () => {
        expect(canonicalizeHotkey(' control + t ')).toBe('Ctrl+T');
        expect(canonicalizeHotkey('CTRL+y')).toBe('Ctrl+Y');
        expect(canonicalizeHotkey('Shift+Option+Ctrl+y')).toBe('Ctrl+Alt+Shift+Y');
        expect(canonicalizeHotkey('Option+Alt+f4')).toBe('Alt+F4');
        expect(canonicalizeHotkey('Ctrl+ArrowDown')).toBe('Ctrl+Arrowdown');
    });

    it('不为非法或已禁用的组合生成可持久化热键', () => {
        expect(canonicalizeHotkey('')).toBe('');
        expect(canonicalizeHotkey('Ctrl+Hyper+T')).toBe('');
        expect(canonicalizeHotkey('Cmd+Y')).toBe('');
        expect(canonicalizeHotkey('y')).toBe('');
    });
});

describe('hotkey matching', () => {
    it('按住组合按物理 code 移除按下时的逻辑键，并忽略修饰键与不可配置按键', () => {
        const pressed = new Set<string>();
        const keyByCode = new Map<string, string>();
        addPressedHotkeyEventKey(keyboardEvent({key: '!', code: 'Digit1', shiftKey: true}), pressed, keyByCode);
        addPressedHotkeyEventKey(keyboardEvent({key: ' ', code: 'Space'}), pressed, keyByCode);
        addPressedHotkeyEventKey(keyboardEvent({key: 'F13', code: 'F13'}), pressed, keyByCode);
        addPressedHotkeyEventKey(keyboardEvent({key: 'x', code: ''}), pressed, keyByCode);
        for (const [key, code] of [['Shift', 'ShiftLeft'], ['CapsLock', 'CapsLock'], ['AltGraph', 'AltRight'], ['Unidentified', '']]) {
            addPressedHotkeyEventKey(keyboardEvent({key, code}), pressed, keyByCode);
        }
        expect([...pressed]).toEqual(['1', 'space', 'f13', 'x']);
        expect([...keyByCode]).toEqual([['Digit1', '1'], ['Space', 'space'], ['F13', 'f13']]);

        // Shift 先松开后同一物理键 keyup 为 “1”；Option 字形也必须按按下时的记录移除。
        pressed.add('shift');
        deletePressedHotkeyEventKey(keyboardEvent({key: 'Shift', code: 'ShiftLeft'}), pressed, keyByCode);
        expect(pressed.has('shift')).toBe(true);
        deletePressedHotkeyEventKey(keyboardEvent({key: '¡', code: 'Digit1', altKey: true}), pressed, keyByCode);
        deletePressedHotkeyEventKey(keyboardEvent({key: 'x', code: ''}), pressed, keyByCode);
        expect([...pressed]).toEqual(['space', 'f13', 'shift']);
        expect(keyByCode.has('Digit1')).toBe(false);
    });

    it('优先解释可配置逻辑字符，并为未知键值或 Option 变形字形回退 code', () => {
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'y', code: 'KeyT'}))).toBe('y');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'f', code: 'KeyY'}))).toBe('f');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: '†', code: 'KeyT', altKey: true}))).toBe('t');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'œ', code: 'KeyQ', altKey: true}))).toBe('q');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: '∂', code: 'KeyD', altKey: true}))).toBe('d');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: '÷', code: 'Slash', altKey: true}))).toBe('/');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: '≠', code: 'Equal', altKey: true}))).toBe('=');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: '§', code: ''}))).toBe('§');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'Unidentified', code: 'KeyY'}))).toBe('y');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'Dead', code: 'Digit2'}))).toBe('2');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'Unidentified', code: 'F9'}))).toBe('f9');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'Unidentified', code: 'ArrowDown'}))).toBe('arrowdown');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: 'Unidentified', code: ''}))).toBe('unidentified');
        expect(normalizeHotkeyEventKey(keyboardEvent({key: ' ', code: 'Space'}))).toBe('space');
        expect(matchesConfiguredHotkey(
            keyboardEvent({key: 'y', code: 'KeyT', ctrlKey: true}), 'Ctrl+Y',
        )).toBe(true);
        expect(matchesConfiguredHotkey(
            keyboardEvent({key: 'f', code: 'KeyY', ctrlKey: true}), 'Ctrl+Y',
        )).toBe(false);
        expect(matchesConfiguredHotkey(
            keyboardEvent({key: '†', code: 'KeyT', altKey: true}), 'Alt+T',
        )).toBe(true);
        expect(matchesConfiguredHotkey(
            keyboardEvent({key: '÷', code: 'Slash', altKey: true}), 'Alt+/',
        )).toBe(true);
    });

    it('无效解析结果和修饰键不完全匹配时不命中', () => {
        const parsed = parseHotkey('Ctrl+T');
        expect(matchesHotkey(keyboardEvent({ctrlKey: true}), {...parsed, isValid: false})).toBe(false);
        expect(matchesHotkey(keyboardEvent({ctrlKey: true, shiftKey: true}), parsed)).toBe(false);
        expect(matchesHotkey(keyboardEvent({altKey: true}), parsed)).toBe(false);
    });

    it('匹配特殊键、字母数字、功能键和符号键', () => {
        expect(matchesHotkey(keyboardEvent({key: ' ', code: 'Space', ctrlKey: true}), parseHotkey('Ctrl+Space'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'Unidentified', code: 'ArrowDown', altKey: true}), parseHotkey('Alt+ArrowDown'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'x', code: 'KeyX', ctrlKey: true}), parseHotkey('Ctrl+X'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'Unidentified', code: 'KeyX', ctrlKey: true}), parseHotkey('Ctrl+X'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'F4', code: 'F4', altKey: true}), parseHotkey('Alt+F4'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'Unidentified', code: 'F4', altKey: true}), parseHotkey('Alt+F4'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: '/', code: 'Slash', ctrlKey: true}), parseHotkey('Ctrl+/'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'Enter', code: undefined, ctrlKey: true}), parseHotkey('Ctrl+Enter'))).toBe(true);
        expect(matchesHotkey(keyboardEvent({key: 'k', code: 'KeyK', metaKey: true}), {
            modifiers: ['meta'],
            key: 'k',
            isValid: true,
            displayName: 'Cmd+K',
        })).toBe(true);
    });

    it('匹配预设修饰键热键，并拒绝多余修饰键或错误按键', () => {
        expect(matchesModifierOnlyHotkey(keyboardEvent({key: 'Control', ctrlKey: true}), 'Control')).toBe(true);
        expect(matchesModifierOnlyHotkey(keyboardEvent({key: 'Alt', altKey: true}), 'Alt')).toBe(true);
        expect(matchesModifierOnlyHotkey(keyboardEvent({key: 'Shift', shiftKey: true}), 'Shift')).toBe(true);
        expect(matchesModifierOnlyHotkey(keyboardEvent({key: 'Control', ctrlKey: true, metaKey: true}), 'Control')).toBe(false);
        expect(matchesModifierOnlyHotkey(keyboardEvent({key: 'T', ctrlKey: true}), 'Control')).toBe(false);
        expect(matchesModifierOnlyHotkey(keyboardEvent({key: 'Control', ctrlKey: true}), 'Meta')).toBe(false);
    });

    it('解析配置热键并只在热键命中后检查候选文本', () => {
        expect(resolveConfiguredHotkey(' custom ', ' Ctrl+Shift+Y ')).toBe('Ctrl+Shift+Y');
        expect(resolveConfiguredHotkey('custom', undefined)).toBe('');
        expect(resolveConfiguredHotkey(' Alt ', 'Ctrl+Shift+Y')).toBe('Alt');
        expect(resolveConfiguredHotkey(undefined, undefined)).toBe('');

        expect(matchesConfiguredHotkey(keyboardEvent({key: 'Control', ctrlKey: true}), 'Control')).toBe(true);
        expect(matchesConfiguredHotkey(keyboardEvent({ctrlKey: true}), 'custom', 'Ctrl+T')).toBe(true);
        expect(matchesConfiguredHotkey(keyboardEvent({ctrlKey: true}), 'none')).toBe(false);
        expect(matchesConfiguredHotkey(keyboardEvent({ctrlKey: true}), '')).toBe(false);

        const hasCandidate = vi.fn(() => true);
        expect(shouldClaimConfiguredHotkey(keyboardEvent({altKey: true}), 'Ctrl+T', '', hasCandidate)).toBe(false);
        expect(hasCandidate).not.toHaveBeenCalled();
        expect(shouldClaimConfiguredHotkey(keyboardEvent({ctrlKey: true}), 'Ctrl+T', '', hasCandidate)).toBe(true);
    });
});

describe('hotkey conflict validation', () => {
    it('识别常见系统快捷键冲突并放行非冲突组合', () => {
        expect(validateHotkeyConflicts({isValid: false} as ParsedHotkey)).toEqual({hasConflict: false});
        expect(validateHotkeyConflicts(parseHotkey('Ctrl+C'))).toEqual({
            hasConflict: true,
            conflictDescription: '与系统快捷键冲突: 复制',
        });
        expect(validateHotkeyConflicts(parseHotkey('Ctrl+Shift+T'))).toEqual({
            hasConflict: true,
            conflictDescription: '与系统快捷键冲突: 重新打开关闭的标签页',
        });
        expect(validateHotkeyConflicts(parseHotkey('Ctrl+Alt+T'))).toEqual({hasConflict: false});
    });
});
