/**
 * @file src/features/selection-translation/dictionary/script.ts
 * 文件职责：在随包 QuickJS 虚拟机中解释用户词典转换脚本，与浏览器运行环境隔离。
 * 主要内容：仅输入单词与已获取的 JSON，限制运行时间、内存、栈和输出，回收全部句柄；不向脚本暴露网络或扩展 API。
 * 模块边界：只做有界纯转换，不使用浏览器 eval、动态脚本标签、用户页面或远程代码。
 */
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import release from '@jitl/quickjs-wasmfile-release-sync';
let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
export async function runDictionaryScript(script: string, word: string, data: unknown): Promise<unknown> {
    if (script.length > 16384) throw new Error('Dictionary script is too large');
    modulePromise ??= newQuickJSWASMModuleFromVariant(release).catch(error => {modulePromise = undefined; throw error;});
    const engine = await modulePromise;
    const runtime = engine.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    const deadline = Date.now() + 100;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    try {
        const result = context.evalCode(`JSON.stringify((function(word, data){"use strict";\n${script}\n})(${JSON.stringify(word)},${JSON.stringify(data)}))`, 'dictionary-recipe.js');
        if (result.error) {result.error.dispose(); throw new Error('Dictionary script failed or exceeded its limits');}
        try {
            const output = context.getString(result.value);
            if (output.length > 65536) throw new Error('Dictionary script output is too large');
            return JSON.parse(output);
        } finally {result.value.dispose();}
    } finally {context.dispose(); runtime.dispose();}
}
