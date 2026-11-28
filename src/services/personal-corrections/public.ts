/**
 * @file src/services/personal-corrections/public.ts
 * 文件职责：公开跨页面个人校订客户端及纯数据合同。
 * 主要内容：客户端只延迟取得现有 runtime，后台存储和服务由 composition root 单独装配。
 * 模块边界：内容页不会导入数据库、加密仓库或后台业务实现。
 */
import {createPersonalCorrectionsClient, type PersonalCorrectionClientRuntime} from './client';
export const personalCorrections = createPersonalCorrectionsClient(() => {
    if (typeof browser === 'undefined' || !browser.runtime) throw new Error('个人校订运行时不可用');
    return browser.runtime as unknown as PersonalCorrectionClientRuntime;
});
export {PERSONAL_CORRECTIONS_MESSAGE, PERSONAL_CORRECTIONS_CHANGED} from './protocol';
export type {CorrectionQuery, PersonalCorrectionInput, PersonalCorrectionLookup, PersonalCorrectionProject, PersonalCorrectionRecord, PersonalCorrectionSaveResult, PersonalCorrectionScope, PersonalCorrectionState} from '@/src/core/personal-corrections/public';
