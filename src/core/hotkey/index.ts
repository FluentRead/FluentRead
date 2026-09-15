/**
 * @file src/core/hotkey/index.ts
 *
 * 文件职责：解析、匹配并校验 FluentRead 的组合快捷键，是划词、悬浮和其他触发器共享的键盘规则引擎。
 * 主要内容：维护修饰键与普通键目录，输出 ParsedHotkey，处理仅修饰键、macOS Meta 映射、自定义快捷键解析、事件匹配、手势占用和冲突诊断。 可核对的公开符号包括 MODIFIER_KEYS、REGULAR_KEYS、ParsedHotkey、parseHotkey、matchesHotkey、resolveConfiguredHotkey、matchesModifierOnlyHotkey、matchesConfiguredHotkey。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

/**
 * 快捷键处理工具函数
 */

// 支持的修饰键
export const MODIFIER_KEYS: Record<string, string[]> = {
  ctrl: ['control', 'ctrl'],
  alt: ['alt', 'option'],
  shift: ['shift'],
  meta: ['meta', 'cmd', 'command']
};

// 支持的普通按键
export const REGULAR_KEYS = {
  // 字母
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', i: 'i', j: 'j',
  k: 'k', l: 'l', m: 'm', n: 'n', o: 'o', p: 'p', q: 'q', r: 'r', s: 's', t: 't',
  u: 'u', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
  // 数字
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  // 功能键
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12',
  // 特殊键
  space: 'space',
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  // 符号键
  '`': '`', '~': '~',
  '-': '-', '_': '_',
  '=': '=', '+': '+',
  '[': '[', '{': '{',
  ']': ']', '}': '}',
  '\\': '\\', '|': '|',
  ';': ';', ':': ':',
  "'": "'", '"': '"',
  ',': ',', '<': '<',
  '.': '.', '>': '>',
  '/': '/', '?': '?',
} as const;

// 快捷键解析结果接口
export interface ParsedHotkey {
  modifiers: string[];
  key: string;
  isValid: boolean;
  displayName: string;
  errorMessage?: string;
}

const REGULAR_CODE_KEYS: Readonly<Record<string, keyof typeof REGULAR_KEYS>> = {
  backquote: '`',
  minus: '-',
  equal: '=',
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
  intlbackslash: '\\',
  semicolon: ';',
  quote: "'",
  comma: ',',
  period: '.',
  slash: '/',
};

function normalizeHotkeyEventCode(code: string | undefined): string {
  const normalizedCode = code?.toLowerCase() ?? '';
  if (normalizedCode.startsWith('key')) return normalizedCode.slice(3);
  if (normalizedCode.startsWith('digit')) return normalizedCode.slice(5);
  if (REGULAR_CODE_KEYS[normalizedCode]) return REGULAR_CODE_KEYS[normalizedCode];
  if (Object.prototype.hasOwnProperty.call(REGULAR_KEYS, normalizedCode)) return normalizedCode;
  return '';
}

/**
 * 将键盘事件收敛为录制器与运行时共享的逻辑按键。支持的可打印字符优先使用
 * `event.key`，因此非 QWERTY 布局会执行用户实际录下的字符；当 Option 等
 * 修饰键把字符变成不可配置字形时，则回退到稳定的物理 `code`。
 */
export function normalizeHotkeyEventKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const key = event.key.toLowerCase();
  if (key === 'control' || key === 'ctrl') return 'ctrl';
  if (key === 'alt' || key === 'option') return 'alt';
  if (key === 'shift') return 'shift';
  if (key === 'meta' || key === 'command') return 'meta';
  if (key === ' ' || key === 'spacebar') return 'space';
  const codeKey = normalizeHotkeyEventCode(event.code);
  if (key.length === 1) {
    if (Object.prototype.hasOwnProperty.call(REGULAR_KEYS, key)) return key;
    return codeKey || key;
  }
  if (key && key !== 'unidentified' && key !== 'dead') return key;
  return codeKey || key;
}

const PRESSED_NAMED_KEYS: ReadonlySet<string> = new Set([
  'escape', 'enter', 'space', 'tab', 'backspace', 'delete', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

/** 修饰键由事件标志维护，CapsLock、AltGraph 等不可配置键不进入组合，避免改变既有匹配范围。 */
function pressedHotkeyEventKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const key = normalizeHotkeyEventKey(event);
  return key.length === 1 || /^f\d+$/u.test(key) || PRESSED_NAMED_KEYS.has(key) ? key : '';
}

/**
 * 记录按住组合中的非修饰键。页面运行时必须与录制器使用同一逻辑按键，并按物理 code
 * 记住按下时的结果：先松开 Shift 或 Option 会改变同一物理键 keyup 的 event.key。
 */
export function addPressedHotkeyEventKey(
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  pressed: Set<string>,
  keyByCode: Map<string, string>,
): void {
  const key = pressedHotkeyEventKey(event);
  if (!key) return;
  pressed.add(key);
  if (event.code) keyByCode.set(event.code, key);
}

/** 按物理 code 移除按下时记录的逻辑键；缺少记录时退回当前事件的归一化结果。 */
export function deletePressedHotkeyEventKey(
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  pressed: Set<string>,
  keyByCode: Map<string, string>,
): void {
  const key = (event.code && keyByCode.get(event.code)) || pressedHotkeyEventKey(event);
  if (event.code) keyByCode.delete(event.code);
  if (key) pressed.delete(key);
}

/**
 * 解析快捷键字符串
 * @param hotkeyString 快捷键字符串，如 "Ctrl+Alt+T"
 * @returns 解析结果
 */
export function parseHotkey(hotkeyString: string): ParsedHotkey {
  if (!hotkeyString || hotkeyString.trim() === '') {
    return {
      modifiers: [],
      key: '',
      isValid: false,
      displayName: '',
      errorMessage: '快捷键不能为空'
    };
  }

  const parts = hotkeyString.toLowerCase().split('+').map(part => part.trim());

  const modifiers: string[] = [];
  let key = '';

  // 检查每个部分
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (i === parts.length - 1) {
      // 最后一个部分应该是普通按键
      if (REGULAR_KEYS[part as keyof typeof REGULAR_KEYS]) {
        key = part;
      } else {
        return {
          modifiers,
          key: part,
          isValid: false,
          displayName: '',
          errorMessage: `不支持的按键: ${part}`
        };
      }
    } else {
      // 前面的部分应该是修饰键
      let isValidModifier = false;
      for (const [modifierKey, aliases] of Object.entries(MODIFIER_KEYS)) {
        if (aliases.includes(part)) {
          if (!modifiers.includes(modifierKey)) {
            modifiers.push(modifierKey);
          }
          isValidModifier = true;
          break;
        }
      }

      if (!isValidModifier) {
        return {
          modifiers,
          key,
          isValid: false,
          displayName: '',
          errorMessage: `不支持的修饰键: ${part}`
        };
      }
    }
  }

  // 验证至少有一个修饰键（避免占用单个字母键）
  if (modifiers.length === 0 && key.length === 1 && /[a-z]/.test(key)) {
    return {
      modifiers,
      key,
      isValid: false,
      displayName: '',
      errorMessage: '单个字母键需要与修饰键组合使用'
    };
  }

  // 禁用包含 CMD/Meta 键的快捷键组合
  if (modifiers.includes('meta')) {
    return {
      modifiers,
      key,
      isValid: false,
      displayName: '',
      errorMessage: 'CMD 键已被禁用，请使用其他修饰键组合'
    };
  }

  // 生成显示名称
  const displayName = generateDisplayName(modifiers, key);

  return {
    modifiers,
    key,
    isValid: true,
    displayName,
  };
}

/**
 * 生成快捷键显示名称
 * @param modifiers 修饰键数组
 * @param key 普通按键
 * @returns 显示名称
 */
function generateDisplayName(modifiers: string[], key: string): string {
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
  const isMac = /Mac|iPod|iPhone|iPad/.test(platform);
  const modifierDisplayNames: Record<string, string> = isMac ?
    {
      ctrl: 'Control',
      alt: 'Option',
      shift: 'Shift',
      meta: 'Cmd'
    } :
    {
      ctrl: 'Ctrl',
      alt: 'Alt',
      shift: 'Shift',
      meta: 'Win'
    };

  const keyDisplayName = key.charAt(0).toUpperCase() + key.slice(1);
  const modifierNames = modifiers.map(mod => modifierDisplayNames[mod]);

  return [...modifierNames, keyDisplayName].join('+');
}

/**
 * 把可用快捷键收敛为与平台无关的稳定字符串，便于持久化、去重和跨设备导入。
 * Option 等别名统一保存为 Alt，修饰键顺序固定为 Ctrl → Alt → Shift。
 */
export function canonicalizeHotkey(hotkeyString: string): string {
  const parsed = parseHotkey(hotkeyString);
  if (!parsed.isValid) return '';

  const modifierLabels: Record<string, string> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
  };
  const orderedModifiers = ['ctrl', 'alt', 'shift', 'meta']
    .filter((modifier) => parsed.modifiers.includes(modifier))
    .map((modifier) => modifierLabels[modifier]);
  const key = /^f\d+$/u.test(parsed.key)
    ? parsed.key.toUpperCase()
    : parsed.key.length === 1
      ? parsed.key.toUpperCase()
      : `${parsed.key.charAt(0).toUpperCase()}${parsed.key.slice(1)}`;
  return [...orderedModifiers, key].join('+');
}

/**
 * 检查事件是否匹配指定的快捷键
 * @param event 键盘事件
 * @param parsedHotkey 解析后的快捷键
 * @returns 是否匹配
 */
export function matchesHotkey(event: KeyboardEvent, parsedHotkey: ParsedHotkey): boolean {
  if (!parsedHotkey.isValid) return false;

  // 检查修饰键
  const requiredModifiers = new Set(parsedHotkey.modifiers);
  const actualModifiers = new Set();

  if (event.ctrlKey) actualModifiers.add('ctrl');
  if (event.altKey) actualModifiers.add('alt');
  if (event.shiftKey) actualModifiers.add('shift');
  if (event.metaKey) actualModifiers.add('meta');

  // 修饰键必须完全匹配
  if (requiredModifiers.size !== actualModifiers.size) return false;
  for (const modifier of requiredModifiers) {
    if (!actualModifiers.has(modifier)) return false;
  }

  // 检查普通按键
  const eventKey = normalizeHotkeyEventKey(event);

  // 处理特殊按键映射
  const keyMappings: Record<string, string[]> = {
    'space': [' ', 'space'],
    'enter': ['enter', 'return'],
    'escape': ['escape', 'esc'],
    'backspace': ['backspace'],
    'delete': ['delete', 'del'],
    'tab': ['tab'],
    'arrowup': ['arrowup', 'up'],
    'arrowdown': ['arrowdown', 'down'],
    'arrowleft': ['arrowleft', 'left'],
    'arrowright': ['arrowright', 'right'],
  };

  if (keyMappings[parsedHotkey.key]) {
    return keyMappings[parsedHotkey.key].includes(eventKey);
  }

  // 普通字母数字键
  if (/^[a-z0-9]$/.test(parsedHotkey.key)) {
    return eventKey === parsedHotkey.key;
  }

  // 功能键
  if (/^f\d+$/.test(parsedHotkey.key)) {
    return eventKey === parsedHotkey.key;
  }

  // 符号键直接比较
  return eventKey === parsedHotkey.key;
}

type HotkeyModifierState = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> & {
  key?: string;
};

const modifierOnlyHotkeys: Record<string, { eventKey: string; modifier: keyof Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> }> = {
  Control: { eventKey: 'control', modifier: 'ctrlKey' },
  Alt: { eventKey: 'alt', modifier: 'altKey' },
  Shift: { eventKey: 'shift', modifier: 'shiftKey' },
};

/** 将预设或自定义配置解析为 runtime 使用的快捷键字符串。 */
export function resolveConfiguredHotkey(configuredHotkey: string | undefined, customHotkey: string | undefined): string {
  const configured = typeof configuredHotkey === 'string' ? configuredHotkey.trim() : '';
  if (configured === 'custom') return typeof customHotkey === 'string' ? customHotkey.trim() : '';
  return configured;
}

/** 匹配仅含 Ctrl/Alt/Shift、用作划词修饰键的快捷键。 */
export function matchesModifierOnlyHotkey(event: HotkeyModifierState, hotkey: string): boolean {
  const definition = modifierOnlyHotkeys[hotkey];
  if (!definition || event.key?.toLowerCase() !== definition.eventKey) return false;

  const actualModifiers = [
    event.ctrlKey ? 'ctrlKey' : '',
    event.altKey ? 'altKey' : '',
    event.shiftKey ? 'shiftKey' : '',
    event.metaKey ? 'metaKey' : '',
  ].filter(Boolean);
  return actualModifiers.length === 1 && actualModifiers[0] === definition.modifier;
}

/** 匹配划词快捷键，包括预设的纯修饰键和自定义组合键。 */
export function matchesConfiguredHotkey(event: KeyboardEvent, configuredHotkey: string | undefined, customHotkey = ''): boolean {
  const resolvedHotkey = resolveConfiguredHotkey(configuredHotkey, customHotkey);
  if (!resolvedHotkey || resolvedHotkey === 'none') return false;
  if (matchesModifierOnlyHotkey(event, resolvedHotkey)) return true;
  return matchesHotkey(event, parseHotkey(resolvedHotkey));
}

/**
 * 仅在低成本按键匹配成功后占用已配置的快捷键。延迟执行的候选检查可能读取选区布局并
 * 检测语言，因此无关的键盘输入绝不能触发该检查。
 */
export function shouldClaimConfiguredHotkey(
  event: KeyboardEvent,
  configuredHotkey: string | undefined,
  customHotkey: string,
  hasCandidate: () => boolean,
): boolean {
  return matchesConfiguredHotkey(event, configuredHotkey, customHotkey) && hasCandidate();
}

/**
 * 验证快捷键是否与系统快捷键冲突
 * @param parsedHotkey 解析后的快捷键
 * @returns 冲突信息
 */
export function validateHotkeyConflicts(parsedHotkey: ParsedHotkey): {
  hasConflict: boolean;
  conflictDescription?: string
} {
  if (!parsedHotkey.isValid) {
    return { hasConflict: false };
  }

  const { modifiers, key } = parsedHotkey;
  // 常见的系统快捷键冲突检测
  const commonConflicts = [
    // Windows/Linux 系统快捷键
    { modifiers: ['ctrl'], key: 'c', desc: '复制' },
    { modifiers: ['ctrl'], key: 'v', desc: '粘贴' },
    { modifiers: ['ctrl'], key: 'x', desc: '剪切' },
    { modifiers: ['ctrl'], key: 'z', desc: '撤销' },
    { modifiers: ['ctrl'], key: 'y', desc: '重做' },
    { modifiers: ['ctrl'], key: 'a', desc: '全选' },
    { modifiers: ['ctrl'], key: 's', desc: '保存' },
    { modifiers: ['ctrl'], key: 'o', desc: '打开' },
    { modifiers: ['ctrl'], key: 'n', desc: '新建' },
    { modifiers: ['ctrl'], key: 'w', desc: '关闭标签页' },
    { modifiers: ['ctrl'], key: 't', desc: '新建标签页' },
    { modifiers: ['ctrl'], key: 'r', desc: '刷新页面' },
    { modifiers: ['ctrl'], key: 'f', desc: '查找' },
    { modifiers: ['ctrl'], key: 'h', desc: '历史记录' },
    { modifiers: ['ctrl'], key: 'd', desc: '添加书签' },
    { modifiers: ['alt'], key: 'f4', desc: '关闭程序' },
    { modifiers: ['ctrl', 'shift'], key: 't', desc: '重新打开关闭的标签页' },
    { modifiers: ['ctrl', 'shift'], key: 'n', desc: '无痕模式' },
    { modifiers: ['ctrl', 'shift'], key: 'delete', desc: '清除浏览数据' },

    // macOS 系统快捷键
    { modifiers: ['meta'], key: 'c', desc: '复制' },
    { modifiers: ['meta'], key: 'v', desc: '粘贴' },
    { modifiers: ['meta'], key: 'x', desc: '剪切' },
    { modifiers: ['meta'], key: 'z', desc: '撤销' },
    { modifiers: ['meta'], key: 'a', desc: '全选' },
    { modifiers: ['meta'], key: 's', desc: '保存' },
    { modifiers: ['meta'], key: 'o', desc: '打开' },
    { modifiers: ['meta'], key: 'n', desc: '新建' },
    { modifiers: ['meta'], key: 'w', desc: '关闭标签页' },
    { modifiers: ['meta'], key: 't', desc: '新建标签页' },
    { modifiers: ['meta'], key: 'r', desc: '刷新页面' },
    { modifiers: ['meta'], key: 'f', desc: '查找' },
    { modifiers: ['meta'], key: 'q', desc: '退出程序' },
    { modifiers: ['meta'], key: 'space', desc: 'Spotlight搜索' },
  ];

  for (const conflict of commonConflicts) {
    if (conflict.modifiers.length === modifiers.length &&
        conflict.key === key &&
        conflict.modifiers.every(mod => modifiers.includes(mod))) {
      return {
        hasConflict: true,
        conflictDescription: `与系统快捷键冲突: ${conflict.desc}`
      };
    }
  }

  return { hasConflict: false };
}
