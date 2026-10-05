import {describe, expect, it} from 'vitest';
import {translate, translateLegacyText} from '@/src/core/i18n';
import type {UiLanguage} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';
import {options} from '@/src/core/config/catalog';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

const languages: UiLanguage[] = ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'];
const sources = ['自动均衡', '自动分配', '实验候选', '网络问题通常几分钟后重试；限流按服务提示恢复；拦截可能需要几小时；日额度通常隔天恢复。', '搜狗翻译', '实验性网页接口，可能触发访问验证'];

describe('free translation legacy text localization', () => {
  it('localizes the free unofficial badge independently from the DeepLX name', () => {
    const labels = {'zh-CN': '免费 · 非官方', 'en-US': 'Free · Unofficial', 'ja-JP': '無料 · 非公式', 'ko-KR': '무료 · 비공식', 'fr-FR': 'Gratuit · Non officiel', 'ru-RU': 'Бесплатно · Неофициально', 'es-ES': 'Gratis · No oficial'};
    for (const [language, label] of Object.entries(labels)) {
      expect(translate('settings.services.library.freeUnofficial', language as UiLanguage)).toBe(label);
    }
    expect(options.services.find(item => item.value === 'deeplx')?.label).toBe('DeepLX');
  });

  // 服务目录的说明在设置页整句显示，在翻译中心按第一个“；”截取摘要显示，两种形态都必须有译文。
  it.each(languages)('%s translates every service label, description and description summary', language => {
    const copy = (options.services as ReadonlyArray<{label: string; description?: string}>).flatMap(({label, description}) => (
      description ? [label, description, description.split('；')[0]!] : [label]
    )).filter(source => /[\u3400-\u9fff]/u.test(source));
    const untranslated = copy.filter(source => {
      const translated = translateLegacyText(source, language);
      return translated === source || (language !== 'ja-JP' && /[\u3400-\u9fff]/u.test(translated));
    });
    expect(untranslated).toEqual([]);
  });

  it.each(languages)('%s translates new free-service labels and guidance', language => {
    for (const source of sources) {
      const translated = translateLegacyText(source, language);
      expect(translated, `${language}: ${source}`).not.toBe(source);
      expect(translated).not.toContain('实验性');
    }
  });
});
