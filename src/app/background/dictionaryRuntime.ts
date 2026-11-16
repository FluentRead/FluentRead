/**
 * @file src/app/background/dictionaryRuntime.ts
 * 文件职责：为后台划词与学习卡导出装配词典工作区能力。
 * 主要内容：等待现有配置水合，选择内置词典或按需加载的配方服务，并注入本机 Anki 导出。
 * 模块边界：仅组合配置和 feature 端口，不解析文件、不实现查询协议、不创建并行存储。
 */
import {config, configReady} from '@/src/services/config/store';
import {lookupWord} from '@/src/features/selection-translation/services/wordDictionary';
import {createDictionaryCardHandler} from '@/src/features/selection-translation/background/dictionaryCardHandler';
export async function lookupSelectionDictionary(word: string) {
    await configReady;
    const recipe = config.selectionDictionaryWorkspace?.recipes.find(item => item.id === config.selectionDictionaryRecipe);
    if (!recipe) return lookupWord(word, config.selectionDictionarySource);
    const {lookupDictionaryRecipe} = await import('@/src/features/selection-translation/dictionary/service');
    const headers = config.customHeaders[`dictionary:${recipe.id}`];
    return lookupDictionaryRecipe(word, {...recipe, headers: headers ? JSON.parse(headers) : recipe.headers});
}
export function createDictionaryRuntimeHandler<T>() {
    return createDictionaryCardHandler<T>({ready: configReady, settings: () => config.selectionDictionaryWorkspace.anki, send: async (card, settings) => {
        const {sendDictionaryCardToAnki} = await import('@/src/features/selection-translation/dictionary/anki');
        return sendDictionaryCardToAnki(card, settings);
    }});
}
