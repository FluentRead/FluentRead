/**
 * @file src/features/selection-translation/content/contextMenuBridge.ts
 * 文件职责：为“右键翻译选中文本”提供内容脚本内的单向调用桥，让后台消息不必知道划词卡片的组件实例。
 * 主要内容：保存当前已挂载卡片注册的处理函数，提供注销句柄，转交浏览器菜单绑定的原文用于核对选区，并在未挂载或选区不可翻译时返回 false 让调用方据实回应。
 * 模块边界：这里只保管一个函数引用，不读取 Selection、不发起翻译、不操作 DOM；选区判定与卡片展示归 SelectionTranslator.vue，消息分发归 app/content。
 */

/** 返回 true 表示已经为当前选区打开划词卡片。 */
export type SelectionContextMenuHandler = (selectionText?: string) => boolean;

let activeHandler: SelectionContextMenuHandler | null = null;

/** 卡片挂载时注册处理函数；返回的注销句柄只会清除自己注册的那一个。 */
export function setSelectionContextMenuHandler(handler: SelectionContextMenuHandler): () => void {
    activeHandler = handler;
    return () => {
        if (activeHandler === handler) activeHandler = null;
    };
}

export function translateSelectionFromContextMenu(selectionText?: string): boolean {
    return activeHandler?.(selectionText) === true;
}
