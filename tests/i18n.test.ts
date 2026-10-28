import {siteRuleTextRows} from '@/src/core/i18n/messages/siteRules';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createLegacyPatternSet, localizedLegacyPatterns} from '@/src/core/i18n/messages/legacy-patterns';
import {createRuntimeFeedbackLegacyText, runtimeFeedbackRows} from '@/src/core/i18n/messages/runtime-feedback';
import {createLegacyCorrectionText, correctionRows} from '@/src/core/i18n/messages/legacy-corrections';
import {runtimeFeedbackPatterns} from '@/src/core/i18n/messages/runtime-feedback-patterns';
import * as onboardingMessages from '@/src/core/i18n/messages/onboarding';

import {
  DEFAULT_UI_LANGUAGE,
  getUiLanguageDisplayLabel,
  UI_LANGUAGE_OPTIONS,
  normalizeUiLanguage,
  resolveUiLanguageFromLocale,
  translate,
  translateLegacyText,
  registerUiLanguageBundle,
} from '@/src/core/i18n';
import {enUSLegacyText, enUSMessages} from '@/src/core/i18n/messages/en-US';
import {esESLegacyText, esESMessages} from '@/src/core/i18n/messages/es-ES';
import {frFRLegacyText, frFRMessages} from '@/src/core/i18n/messages/fr-FR';
import {jaJPLegacyText, jaJPMessages} from '@/src/core/i18n/messages/ja-JP';
import {koKRLegacyText, koKRMessages} from '@/src/core/i18n/messages/ko-KR';
import {ruRULegacyText, ruRUMessages} from '@/src/core/i18n/messages/ru-RU';
import {zhCNMessages} from '@/src/core/i18n/messages/zh-CN';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {translationLoadingStyleOptions} from '@/src/core/config/translationLoadingStyle';
import {TRANSLATION_STYLE_PRESETS} from '@/src/core/config/translationAppearance';
import {interfaceFontOptions, interfaceSkinGroups, interfaceSkinOptions, popupModuleOptions, popupQuickFeatureOptions} from '@/src/core/config/interfaceAppearance';
import {buildConfigDiff} from '@/src/core/config/diff';
import {getMultilingualTargetLanguageLabel, options, services} from '@/src/core/config/catalog';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {toRestorableConfig} from '@/src/services/config/history';
import {renderContextMenuTitle} from '@/src/core/context-menu/presentation';
import {navigationItems} from '@/src/features/settings/model/navigation';
import {parseHotkey} from '@/src/core/hotkey';
import {IMAGE_OCR_LANGUAGE_PACKS} from '@/src/features/image-translation/ocrLanguages';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import {translateServiceLabel} from '@/src/core/i18n/serviceLabels';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

describe('界面 i18n 契约', () => {
  it('两点选取的动态快捷键冲突说明翻译整句和实际占用功能名', () => {
    const owners = ['鼠标悬停翻译', '全文翻译', '划词翻译', '圈选翻译', '段落复制', '局部翻译', '输入框翻译', '额外翻译方案'];
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const owner of owners) {
        const translatedOwner = translateLegacyText(owner, language);
        expect(translatedOwner, `${language} ${owner}`).not.toBe(owner);
        for (const source of [`快捷键已用于${owner}，请点击快捷键更换后使用`, `此快捷键已用于${owner}，请更换组合键`]) {
          const result = translateLegacyText(source, language);
          expect(result, `${language} ${source}`).not.toBe(source);
          expect(result).toContain(translatedOwner);
          if (language !== 'ja-JP') expect(result).not.toMatch(/[\u3400-\u9fff]/u);
        }
      }
    }
    expect(translateLegacyText('快捷键已用于段落复制，请点击快捷键更换后使用', 'en-US')).toBe('This shortcut is used for Paragraph copy. Click the shortcut to change it before use.');
    expect(translateLegacyText('此快捷键已用于额外翻译方案，请更换组合键', 'en-US')).toBe('This shortcut is already used for Additional translation profile. Choose another combination.');
  });

  it('原型属性名既不是资源键也不是旧文案，不会被替换为原生函数或对象', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      for (const language of ['zh-CN', 'en-US', 'ja-JP'] as const) {
        expect(translate(key, language)).toBe(key);
        expect(translateLegacyText(`  ${key}  `, language)).toBe(`  ${key}  `);
      }
    }
  });

  it('Popup 站点规则的保存、暂停与网站范围反馈覆盖六种语言并保留用户域名', () => {
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const text of ['自动翻译已暂停', '应用于此网站及其子域名，跳转后按新网站规则执行', '禁用会停止此网站的翻译，保留始终翻译偏好', '禁用优先于自动翻译', '恢复扩展后继续自动翻译', '请先恢复扩展', '无法读取当前网站，请重试']) {
        const translated = translateLegacyText(text, language);expect(translated).not.toBe(text);if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u)
      }
      for (const text of ['未能保存 example.com 的网站设置，请重试', '已保存 example.com，恢复扩展后生效', 'example.com 已禁用扩展，无法开启始终翻译 · 恢复扩展后继续自动翻译']) {
        const translated = translateLegacyText(text, language);expect(translated).toContain('example.com');expect(translated).not.toBe(text);if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u)
      }
    }
  });
  it('配置云备份和 WebDAV 七种语言的键与插值一致，供应商可互换', () => {
    const languages = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const;
    const catalogs = languages.map(language => JSON.parse(readFileSync(join(process.cwd(), 'src/core/i18n/messages/cloud-backup', language + '.json'), 'utf8')).messages as Record<string, string>);
    const keys = Object.keys(catalogs[0]).sort();
    for (const [index, catalog] of catalogs.entries()) {
      expect(Object.keys(catalog).sort()).toEqual(keys);
      for (const key of keys) {
        expect(catalog[key].trim()).not.toBe('');
        expect([...catalog[key].matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()).toEqual([...catalogs[0][key].matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort());
        expect(translate(key, languages[index], {provider: 'WebDAV', status: 502})).not.toBe(key);
      }
      expect(translate('settings.cloud.syncNow', languages[index], {provider: 'WebDAV'})).toContain('WebDAV');
      expect(translate('settings.cloud.syncNow', languages[index], {provider: 'Google Drive'})).toContain('Google Drive');
      expect(translate('settings.webdav.error.http', languages[index], {status: 502})).toContain('502');
      if (languages[index] !== 'zh-CN') for (const source of ['请先设置 WebDAV 服务器和应用密码。', '同步连接已变化，请重新生成预览。', '删除预览已失效，请重新检查云端备份。', '删除目标账号或连接已变化，请重新检查云端备份。', '云端备份已变化，请重新检查后再删除。', '云端备份缺少安全删除所需的版本信息，请到服务商管理页面手动删除。', '删除后仍检测到云端备份，可能已被其他设备重新创建，请重新检查。', '删除预览属于其他页面或已失效，请在原设置页面继续。']) expect(translateLegacyText(source, languages[index])).not.toBe(source);
    }
    expect(JSON.stringify(catalogs[1])).not.toMatch(/[\u3400-\u9fff]/u);
    expect(translate('settings.cloud.syncNow', 'zh-CN', {provider: 'Google Drive'})).toBe('立即与Google Drive同步');
  });

  it('issue #626：自定义地址提示与嵌套 HTML 错误覆盖全部界面语言', () => {
    const hint = '支持完整 Chat Completions 地址或以 /v1 结尾的 Base URL；模型须支持 Chat Completions。';
    const detail = '服务返回了 HTML 网页。请检查 Base URL、接口路径，以及所选模型是否支持 Chat Completions。';
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      expect(translateLegacyText(hint, language)).not.toBe(hint);
      const message = translateLegacyText(`当前翻译服务拒绝了请求（HTTP 404）：${detail}`, language);
      expect(message).toContain('HTTP 404');
      expect(message).toContain(translateLegacyText(detail, language));
      expect(message).not.toContain('服务返回了');
    }
  });

  const translatedCatalogs: ReadonlyArray<Readonly<Record<string, string>>> = [
    enUSMessages,
    jaJPMessages,
    koKRMessages,
    frFRMessages,
    ruRUMessages,
    esESMessages,
  ];

  const translatedLegacyCatalogs = [
    jaJPLegacyText,
    koKRLegacyText,
    frFRLegacyText,
    ruRULegacyText,
    esESLegacyText,
  ];

  const placeholders = (message: string) => (
    [...message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort()
  );

  it('完整本地化写作连接、配置与生成失败状态', () => {
    const errors = ["请先启用写作助手", "请在写作助手设置中选择一个 AI 服务", "请先选择写作模型", "请先在翻译服务中配置这个服务的 API Key", "请先输入草稿", "请先写下要求或提供参考内容", "已停止生成", "写作助手连接中断，请重试", "写作助手仅支持 Gmail 和 GitHub 的 Issue、Pull Request 回复页面", "写作助手已停用", "当前网站已禁用写作助手", "无效的写作请求", "正在处理其他写作请求，请稍后重试", "生成超时，请重试", "生成未完成，请重试", "模型没有返回正文，请重试", "对照译文未完整生成，请重试"];
    for (const {value: language} of UI_LANGUAGE_OPTIONS.filter(item => item.value !== 'zh-CN')) {
      for (const error of errors) expect(translateLegacyText(error, language)).not.toBe(error);
    }
  });

  it('Google Drive 同步完整翻译账号状态、差异数量与隐藏凭据预览', () => {
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      expect(translate('settings.drive.account', language, {email: 'tester@fixture.invalid'})).toContain('tester@fixture.invalid');
      expect(translate('settings.drive.selectedAccount', language)).not.toMatch(/^settings\.drive\./u);
      expect(translate('settings.drive.differences', language, {count: 23})).toContain('23');
      for (const source of ['Google Drive 请求失败（HTTP 500），请重试。', '读取 Google 账号失败（HTTP 401）。', '翻译连接：google；自定义服务：2；凭据和地址已隐藏']) {
        const translated = translateLegacyText(source, language);
        if (source.includes('HTTP')) expect(translated).toContain('HTTP');
        expect(translated).not.toBe(source);
      }
      expect(translate('settings.drive.lastSync', language, {time: 'fixture-time'})).toContain('fixture-time');
      for (const source of ['Google Drive 配置同步', '立即与Google Drive同步', '未允许 Google Drive 配置数据权限，请重新同步并在 Google 授权页面允许访问配置数据。', '翻译连接与凭据（整组）', '已设置（内容隐藏）', '本机 → 云端', '云端 → 本机', 'Google Drive 网络请求失败或响应无效，请检查网络后重试。', '同步预览已失效，请重新生成。', '另一个设置页面正在确认同步，请先完成或取消该页面的预览。', '悬停翻译延迟（毫秒）', '划词翻译延迟（毫秒）', '禁用悬浮球']) {
        expect(translateLegacyText(source, language)).not.toBe(source);
      }
    }
  });

  it('Google Drive 全部固定反馈和设置名称覆盖六种非中文界面语言', () => {
    const files = ['src/platform/google-drive/auth.ts', 'src/platform/google-drive/api.ts', 'src/core/config/driveSync.ts', 'src/services/config/googleDriveSync.ts', 'src/services/config/googleDriveSyncClient.ts', 'src/app/background/handlers/googleDriveSync.ts'];
    const sources = new Set(files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/gu)].map(match => match[1])));
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      expect([...sources].filter(source => translateLegacyText(source, language) === source), language).toEqual([]);
    }
  });

  it('Google Drive 操作选择、冲突处理和成功账号记录在七种语言中保留参数', () => {
    const keys = ['previewTitle', 'switchAccount', 'cancelSync', 'downloadTitle', 'uploadTitle', 'firstMergeDescription', 'keepAllLocal', 'keepAllRemote', 'localSelected', 'remoteSelected', 'needsChoice', 'finishSync', 'chooseAction', 'enabled', 'disabled', 'stepsLabel', 'chooseStep', 'reviewStep', 'mergeQuestion', 'mergeReviewTitle', 'back', 'continue'];
    for (const {value: language} of UI_LANGUAGE_OPTIONS) {
      for (const key of keys) expect(translate(`settings.drive.${key}`, language)).not.toMatch(/^settings\.drive\./u);
      expect(translate('settings.drive.lastAccount', language, {email: 'last@fixture.invalid'})).toContain('last@fixture.invalid');
      expect(translate('settings.drive.account', language, {email: 'current@fixture.invalid'})).toContain('current@fixture.invalid');
      for (const key of ['remaining', 'showDetails', 'showAutomatic', 'groupedContent', 'differenceCount']) expect(translate(`settings.drive.${key}`, language, {count: 123})).toContain('123');
      expect(translate('settings.drive.choice', language, {label: 'Fixture setting'})).toContain('Fixture setting');
    }
  });

  it('使用操作按钮文案表达西班牙语的停止生成', () => {
    expect(translateLegacyText('停止', 'es-ES')).toBe('Detener');
  });

  it('保留中文默认值，并只接受受支持的界面语言', () => {
    expect(DEFAULT_UI_LANGUAGE).toBe('zh-CN');
    expect(new Config().uiLanguage).toBe('zh-CN');
    expect(normalizeUiLanguage('en-US')).toBe('en-US');
    expect(normalizeUiLanguage('ja-JP')).toBe('ja-JP');
    expect(normalizeUiLanguage('ko-KR')).toBe('ko-KR');
    expect(normalizeUiLanguage('fr-FR')).toBe('fr-FR');
    expect(normalizeUiLanguage('ru-RU')).toBe('ru-RU');
    expect(normalizeUiLanguage('es-ES')).toBe('es-ES');
    expect(normalizeConfig({uiLanguage: 'en-US'}).uiLanguage).toBe('en-US');
    expect(normalizeConfig({uiLanguage: 'invalid'}).uiLanguage).toBe('zh-CN');
    expect(new Config().uiLanguageSetupCompleted).toBe(false);
    expect(normalizeConfig({uiLanguageSetupCompleted: true}).uiLanguageSetupCompleted).toBe(true);
    expect(normalizeConfig({uiLanguageSetupCompleted: 'true'}).uiLanguageSetupCompleted).toBe(false);
  });

  it('在七种界面语言的高级设置提供全部节点选项，并删除旧操作入口文案', () => {
    const labels = {
      'zh-CN': '识别全部节点',
      'en-US': 'Detect all nodes',
      'ja-JP': 'すべてのノードを検出',
      'ko-KR': '모든 노드 인식',
      'fr-FR': 'Détecter tous les nœuds',
      'ru-RU': 'Найти все узлы',
      'es-ES': 'Detectar todos los nodos',
    } as const;
    expect(translate('settings.pageRecognition.title', 'zh-CN')).toBe('页面识别');
    for (const language of Object.keys(labels) as Array<keyof typeof labels>) {
      expect(translate('settings.pageRecognition.allNodes', language)).toBe(labels[language]);
      expect(translateLegacyText('识别全部节点', language)).toBe(labels[language]);
      for (const key of ['settings.pageRecognition.title', 'settings.pageRecognition.description']) {
        expect(translate(key, language)).not.toBe(key);
        expect(translate(key, language).trim()).not.toBe('');
      }
    }
    for (const catalog of [zhCNMessages, ...translatedCatalogs]) {
      expect(Object.keys(catalog).filter((key) => key.startsWith('popup.allNodes.'))).toEqual([]);
      expect(Object.keys(catalog).filter((key) => key.startsWith('settings.contextMenu.'))).toEqual([]);
      expect(Object.keys(catalog)).not.toContain('contextMenu.allNodes');
    }
  });

  it('按浏览器 locale 选择首次界面语言，并为目标语言保留原生名称', () => {
    expect(resolveUiLanguageFromLocale('en-US')).toBe('en-US');
    expect(resolveUiLanguageFromLocale('en-GB')).toBe('en-US');
    expect(resolveUiLanguageFromLocale('ja-JP')).toBe('ja-JP');
    expect(resolveUiLanguageFromLocale('ko-KR')).toBe('ko-KR');
    expect(resolveUiLanguageFromLocale('fr-FR')).toBe('fr-FR');
    expect(resolveUiLanguageFromLocale('ru-RU')).toBe('ru-RU');
    expect(resolveUiLanguageFromLocale('zh-CN')).toBe('zh-CN');
    expect(resolveUiLanguageFromLocale('zh-TW')).toBe('zh-CN');
    expect(resolveUiLanguageFromLocale('es-ES')).toBe('es-ES');
    expect(resolveUiLanguageFromLocale(null)).toBe('zh-CN');
    expect(resolveUiLanguageFromLocale('ar-EG')).toBe('zh-CN');
    expect(resolveUiLanguageFromLocale('')).toBe('zh-CN');
    expect(options.to.slice(0, 8).map(item => item.label)).toEqual([
      '简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Русский', 'Español',
    ]);
    expect(translate('settings.general.defaultTargetLanguage', 'zh-CN')).toBe('翻译语言');
    expect(translate('settings.general.defaultTargetLanguage', 'en-US')).toBe('Translation language');
  });

  it('为目标语言选择器提供中文、英文和原生名称的组合标签', () => {
    expect(options.to.slice(0, 8).map(item => getMultilingualTargetLanguageLabel(item.value, item.label))).toEqual([
      '简体中文 / Simplified Chinese',
      '繁體中文 / Traditional Chinese',
      'English / 英语',
      '日本語 / Japanese / 日语',
      '한국어 / Korean / 韩语',
      'Français / French / 法语',
      'Русский / Russian / 俄语',
      'Español / Spanish / 西班牙语',
    ]);
    expect(getMultilingualTargetLanguageLabel('de', 'Deutsch')).toBe('Deutsch / German / 德语');
    expect(getMultilingualTargetLanguageLabel('pt', 'Português')).toBe('Português / Portuguese / 葡萄牙语');
    expect(getMultilingualTargetLanguageLabel('it', 'Italiano')).toBe('Italiano / Italian / 意大利语');
    expect(getMultilingualTargetLanguageLabel('ja', '日本語', 'es-ES')).toBe('Japonés / Japanese / 日本語');
    expect(getMultilingualTargetLanguageLabel('ja', '日本語', 'de-DE')).toBe('日本語 / Japanese / 日语');
    expect(getMultilingualTargetLanguageLabel('ja', '日本語', 'en-US')).toBe('Japanese');
    expect(getMultilingualTargetLanguageLabel('unknown', 'Custom language', 'en-US')).toBe('Custom language');
    expect(getMultilingualTargetLanguageLabel('unknown', '自定义语言')).toBe('自定义语言');
  });

  it('所有界面语言均独立显示中文简繁译文名称，并识别历史别名', () => {
    const expectedChineseLabels = {
      'zh-CN': ['简体中文 / Simplified Chinese', '繁體中文 / Traditional Chinese'],
      'en-US': ['Simplified Chinese', 'Traditional Chinese'],
      'ja-JP': ['中国語（簡体字） / Simplified Chinese / 简体中文', '中国語（繁体字） / Traditional Chinese / 繁體中文'],
      'ko-KR': ['중국어 간체 / Simplified Chinese / 简体中文', '중국어 번체 / Traditional Chinese / 繁體中文'],
      'fr-FR': ['chinois simplifié / Simplified Chinese / 简体中文', 'chinois traditionnel / Traditional Chinese / 繁體中文'],
      'ru-RU': ['китайский (упрощённый) / Simplified Chinese / 简体中文', 'китайский (традиционный) / Traditional Chinese / 繁體中文'],
      'es-ES': ['Chino simplificado / Simplified Chinese / 简体中文', 'Chino tradicional / Traditional Chinese / 繁體中文'],
    } as const;
    for (const {value: uiLanguage} of UI_LANGUAGE_OPTIONS) {
      const [simplified, traditional] = expectedChineseLabels[uiLanguage];
      for (const alias of ['zh', 'zh-CN', 'zh_SG', 'zh-Hans', 'ZH-hans-TW']) {
        expect(getMultilingualTargetLanguageLabel(alias, alias, uiLanguage)).toBe(simplified);
      }
      for (const alias of ['zh-Hant', 'zh-TW', 'zh_HK', 'zh-MO', 'ZH-hant-CN']) {
        expect(getMultilingualTargetLanguageLabel(alias, alias, uiLanguage)).toBe(traditional);
      }
    }
    for (const choices of [options.from, options.to, options.inputBoxTranslationTarget]) {
      expect(choices.filter(item => item.value.startsWith('zh-'))).toEqual([
        {value: 'zh-Hans', label: '简体中文'},
        {value: 'zh-Hant', label: '繁體中文'},
      ]);
    }
    expect(options.from).toEqual([{value: 'auto', label: '自动检测'}, ...options.to]);
    expect(getMultilingualTargetLanguageLabel('unknown')).toBe('unknown');
  });

  it('完整本地化 Chrome 具体语言对准备流程及参数化状态', () => {
    const actionByLanguage = {
      'zh-CN': '准备 Chrome 本地翻译',
      'en-US': 'Prepare Chrome local translation',
      'ja-JP': 'Chrome ローカル翻訳を準備',
      'ko-KR': 'Chrome 로컬 번역 준비',
      'fr-FR': 'Préparer la traduction locale de Chrome',
      'ru-RU': 'Подготовить локальный перевод Chrome',
      'es-ES': 'Preparar la traducción local de Chrome',
    } as const;
    for (const [language, expectedAction] of Object.entries(actionByLanguage)) {
      expect(translate('settings.services.chromePreparation.action', language as keyof typeof actionByLanguage))
        .toBe(expectedAction);
      const status = translate(
        'settings.services.chromePreparation.statusDownloadingProgress',
        language as keyof typeof actionByLanguage,
        {model: 'MODEL', percentage: 42, sourceLanguage: 'fr', targetLanguage: 'en'},
      );
      expect(status).toContain('MODEL');
      expect(status).toContain('42');
      expect(status).toContain('fr');
      expect(status).toContain('en');
      expect(status).not.toMatch(/\{(?:model|percentage|sourceLanguage|targetLanguage)\}/u);

      const activationError = translate(
        'settings.services.chromePreparation.error.userActivationRequired',
        language as keyof typeof actionByLanguage,
        {sourceLanguage: 'fr', targetLanguage: 'en'},
      );
      expect(activationError).toContain('fr');
      expect(activationError).toContain('en');
    }

    const englishChromeMessages = Object.entries(enUSMessages).filter(([key]) => (
      key.startsWith('settings.services.chromePreparation.')
    ));
    expect(englishChromeMessages.length).toBeGreaterThan(20);
    expect(englishChromeMessages.filter(([, value]) => /[\u3400-\u9fff]/u.test(value))).toEqual([]);
  });

  it.each(['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES'] as const)('图片翻译的准备与各阶段说明在 %s 中完整本地化', language => {
    for (const source of ["首次使用需准备识别语言包，下载后自动继续", "正在准备识别语言包…", "正在读取图片…", "正在识别图片文字…", "正在翻译文字…", "正在生成译图…", "已翻译 · 点击恢复原图", "查看译图", "翻译设置已更改，请重试", "译图加载超时", "图片读取超时", "图片加载超时"]) {
      const translated = translateLegacyText(source, language);
      expect(translated).not.toBe(source);
      if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u);
    }
    expect(translateLegacyText('图片翻译失败：图片读取超时',language)).toContain(translateLegacyText('图片读取超时',language));
    expect(translateLegacyText('图片翻译失败：NETWORK_ERROR_42',language)).toContain('NETWORK_ERROR_42');
  });

  it.each([
    ['en-US', 'Traditional Chinese', 'four language packs'],
    ['ja-JP', '中国語（繁体字）', '4 つの言語パック'],
    ['ko-KR', '중국어 번체', '네 언어 팩'],
    ['fr-FR', 'Chinois traditionnel', 'quatre packs de langue'],
    ['ru-RU', 'Китайский (традиционный)', 'четыре языковых пакета'],
    ['es-ES', 'Chino tradicional', 'cuatro paquetes de idiomas'],
  ] as const)('OCR 简繁语言包在 %s 界面中具有独立名称、说明和四包下载提示', (language, traditionalLabel, packCount) => {
    const simplified = IMAGE_OCR_LANGUAGE_PACKS.find(pack => pack.code === 'chi_sim')!;
    const traditional = IMAGE_OCR_LANGUAGE_PACKS.find(pack => pack.code === 'chi_tra')!;
    expect(translateLegacyText(traditional.label, language)).toBe(traditionalLabel);
    const simplifiedDescription = translateLegacyText(simplified.description, language);
    const traditionalDescription = translateLegacyText(traditional.description, language);
    expect(simplifiedDescription).not.toBe(traditionalDescription);
    const sourceCopy = [
      simplified.label,
      simplified.description,
      traditional.description,
      '推荐先下载简体中文、繁體中文、English 和日本語',
      '自动检测默认使用这四种语言包。识别其他语言图片前，请选择源语言并下载对应语言包。',
    ];
    sourceCopy.push(...IMAGE_OCR_LANGUAGE_PACKS.map(pack => pack.description));
    for (const source of sourceCopy) {
      const translated = translateLegacyText(source, language);
      expect(translated).not.toBe(source);
      if (language !== 'ja-JP') expect(translated).not.toMatch(/[\u3400-\u9fff]/u);
    }
    expect(translateLegacyText(sourceCopy[4]!, language)).toContain(packCount);
  });

  it('提供可继续扩展的语言选择器和参数插值', () => {
    expect(UI_LANGUAGE_OPTIONS.map((item) => item.value)).toEqual([
      'zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES',
    ]);
    expect(UI_LANGUAGE_OPTIONS.map((item) => getUiLanguageDisplayLabel(item.value, 'zh-CN'))).toEqual([
      '中文 / Chinese',
      'English / 英语',
      '日本語 / Japanese / 日语',
      '한국어 / Korean / 韩语',
      'Français / French / 法语',
      'Русский / Russian / 俄语',
      'Español / Spanish / 西班牙语',
    ]);
    expect(UI_LANGUAGE_OPTIONS.map((item) => getUiLanguageDisplayLabel(item.value, 'en-US'))).toEqual([
      'Chinese / 中文',
      'English / 英语',
      'Japanese / 日本語',
      'Korean / 한국어',
      'French / Français',
      'Russian / Русский',
      'Spanish / Español',
    ]);
    expect(getUiLanguageDisplayLabel('ja-JP', 'es-ES')).toBe('Japonés / Japanese / 日本語');
    expect(getUiLanguageDisplayLabel('en-US')).toBe('English / 英语');
    expect(getUiLanguageDisplayLabel('constructor' as never, 'en-US')).toBe('中文');
    expect(getUiLanguageDisplayLabel('ja-JP', 'constructor' as never)).toBe('日本語 / Japanese / 日语');
    expect(translate('popup.current', 'en-US', {value: 'Ctrl'})).toBe('Current: Ctrl');
    expect(translate('popup.current', 'zh-CN', {value: 'Ctrl'})).toBe('当前：Ctrl');
    expect(translate('popup.current', 'es-ES', {value: 'Ctrl'})).toBe('Actual: Ctrl');
    expect(translate('popup.current', 'ja-JP', {value: 'Ctrl'})).toBe('現在：Ctrl');
    expect(translate('popup.current', 'ko-KR', {value: 'Ctrl'})).toBe('현재: Ctrl');
    expect(translate('popup.current', 'fr-FR', {value: 'Ctrl'})).toBe('Actuel : Ctrl');
    expect(translate('popup.current', 'ru-RU', {value: 'Ctrl'})).toBe('Текущее: Ctrl');
    expect(translate('settings.general.bilingualSentenceHighlight', 'en-US')).toBe('Bilingual sentence highlighting');
    expect(translate('settings.general.bilingualSentenceHighlight', 'ja-JP')).toBe('二言語の文をハイライト');
    expect(translate('settings.general.bilingualSentenceHighlight', 'ko-KR')).toBe('이중 언어 문장 강조');
    expect(translate('settings.general.bilingualSentenceHighlight', 'fr-FR')).toBe('Surlignage bilingue par phrase');
    expect(translate('settings.general.bilingualSentenceHighlight', 'ru-RU')).toBe('Подсветка двуязычных предложений');
    expect(translate('settings.general.bilingualSentenceHighlight', 'es-ES')).toBe('Resaltado bilingüe por oración');
    expect(translate('language.onboardingTitle', 'es-ES')).toBe('Elige el idioma de la interfaz');
    expect(translate('language.onboardingTitle', 'ja-JP')).toBe('インターフェースの言語を選択');
    expect(translate('contextMenu.translatePage', 'en-US')).toBe('Translate the whole page');
    expect(renderContextMenuTitle(
        {menuItemId: 'preview', visible: true, action: 'translatePage',
            title: {role: 'standalone', state: 'translate', withTargetLanguage: true, withShortcut: true}},
        {language: 'en-US', targetLanguage: 'Simplified Chinese', shortcut: 'Alt+T'},
    )).toBe('Translate the whole page');
    expect(renderContextMenuTitle(
        {menuItemId: 'preview', visible: true, action: null,
            title: {role: 'standalone', state: 'enableSite', withTargetLanguage: false, withShortcut: false}},
        {language: 'en-US', targetLanguage: '', shortcut: ''},
    )).toBe('Turn back on for this site');
    expect(Object.keys(enUSMessages).sort()).toEqual(Object.keys(zhCNMessages).sort());
    expect(Object.keys(esESMessages).sort()).toEqual(Object.keys(enUSMessages).sort());
    for (const catalog of [jaJPMessages, koKRMessages, frFRMessages, ruRUMessages]) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(enUSMessages).sort());
    }
  });

  it('每种正式语言目录都完整，并保留相同的插值参数', () => {
    const chineseCatalog: Readonly<Record<string, string>> = zhCNMessages;
    for (const catalog of translatedCatalogs) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(chineseCatalog).sort());
      for (const key of Object.keys(chineseCatalog)) {
        expect(placeholders(catalog[key]), key).toEqual(placeholders(chineseCatalog[key]));
      }
    }
  });

  it('用稳定 key 为七种语言提供完整的翻译加载动画文案', () => {
    const expectedStyleLabels = {
      'zh-CN': ['柔和圆环', '简洁', '跳跃圆点', '行星轨道', '星光', '涟漪扩散', '起伏波形', '光线扫过', '流沙沙漏', '小彗星', '翻转方块', '弹跳小球', '打字光标', '扫描线', '信号柱'],
      'en-US': ['Soft ring', 'Minimal', 'Bouncing dots', 'Planet orbit', 'Sparkle', 'Ripple pulse', 'Waveform', 'Light sweep', 'Hourglass', 'Little comet', 'Flip square', 'Bouncing ball', 'Typing cursor', 'Scan line', 'Signal bars'],
      'ja-JP': ['やわらかなリング', 'シンプル', '跳ねるドット', '惑星の軌道', 'きらめき', '波紋パルス', '波形', '光のスイープ', '砂時計', '小さな彗星', '反転スクエア', '跳ねるボール', '入力カーソル', 'スキャンライン', '信号バー'],
      'ko-KR': ['부드러운 원형', '간결', '통통 튀는 점', '행성 궤도', '별빛', '물결 펄스', '파형', '빛 쓸기', '모래시계', '작은 혜성', '뒤집는 사각형', '통통 튀는 공', '입력 커서', '스캔 라인', '신호 막대'],
      'fr-FR': ['Anneau discret', 'Minimal', 'Points bondissants', 'Orbite planétaire', 'Étincelles', 'Ondulation', 'Forme d’onde', 'Balayage lumineux', 'Sablier', 'Petite comète', 'Carré retournant', 'Balle rebondissante', 'Curseur de saisie', 'Ligne de balayage', 'Barres de signal'],
      'ru-RU': ['Мягкое кольцо', 'Минимальный', 'Прыгающие точки', 'Планетарная орбита', 'Искры', 'Пульсация волн', 'Волна', 'Световой проход', 'Песочные часы', 'Маленькая комета', 'Переворачивающийся квадрат', 'Прыгающий шарик', 'Курсор набора', 'Линия сканирования', 'Сигнальные полосы'],
      'es-ES': ['Anillo suave', 'Minimalista', 'Puntos saltarines', 'Órbita planetaria', 'Destellos', 'Pulso de ondas', 'Forma de onda', 'Barrido de luz', 'Reloj de arena', 'Cometa pequeño', 'Cuadrado que gira', 'Pelota saltarina', 'Cursor de escritura', 'Línea de escaneo', 'Barras de señal'],
    } as const;

    for (const language of Object.keys(expectedStyleLabels) as Array<keyof typeof expectedStyleLabels>) {
      expect(translationLoadingStyleOptions.map((option) => translate(option.labelKey, language)))
        .toEqual(expectedStyleLabels[language]);
      for (const option of translationLoadingStyleOptions) {
        expect(translate(option.descriptionKey, language)).not.toBe(option.descriptionKey);
      }
      expect(translate('settings.advanced.performanceDescription', language))
        .not.toBe('settings.advanced.performanceDescription');
      expect(translate('settings.interface.animationLoading.label', language))
        .not.toBe('settings.interface.animationLoading.label');
      expect(translate('settings.interface.animationLoading.description', language))
        .not.toBe('settings.interface.animationLoading.description');
      expect(translate('settings.advanced.animationsAria', language))
        .not.toBe('settings.advanced.animationsAria');
      expect(translate('settings.advanced.translationLoadingStyleAria', language))
        .not.toBe('settings.advanced.translationLoadingStyleAria');
      expect(translate('settings.advanced.translationLoadingStyleOptionAria', language, {
        label: 'Style', description: 'Description',
      })).not.toMatch(/\{(?:label|description)\}/u);
    }

    for (const option of translationLoadingStyleOptions) {
      expect(translate(option.labelKey, 'zh-CN')).toBe(option.label);
      expect(translate(option.descriptionKey, 'zh-CN')).toBe(option.description);
    }
  });

  it('译文样式分组、外观微调与全部预设名称覆盖每种界面语言', () => {
    const styleKeys = Object.keys(zhCNMessages).filter((key) => key.startsWith('settings.translationStyle.'));
    expect(styleKeys.length).toBeGreaterThan(50);
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const key of styleKeys) {
        const value = translate(key, language);
        expect(value, `${language}: ${key}`).not.toBe(key);
        if (language !== 'ja-JP') expect(value, `${language}: ${key}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
      for (const preset of TRANSLATION_STYLE_PRESETS) {
        const localized = translateLegacyText(preset.label, language);
        expect(localized, `${language}: ${preset.label}`).not.toBe(preset.label);
        if (language !== 'ja-JP') expect(localized, `${language}: ${preset.label}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
    expect(translate('settings.translationStyle.currentPreset', 'en-US', {name: 'Bold'})).toBe('Current style: Bold');
    expect(translate('settings.translationStyle.title', 'fr-FR')).toBe('Style de la traduction');
    expect(translateLegacyText('模糊遮罩', 'en-US')).toBe('Blur until hover');
    expect(translateLegacyText('标记底色', 'es-ES')).toBe('Color de resaltado');
  });

  it('用稳定 key 完整本地化快捷翻译方案及其动态提示', () => {
    const cases: Array<{key: string; params?: Record<string, string | number>}> = [
      {key: 'quickTranslation.heading.hover'},
      {key: 'quickTranslation.heading.fullPage'},
      {key: 'quickTranslation.heading.section'},
      {key: 'quickTranslation.action.section'},
      {key: 'quickTranslation.sectionDescription'},
      {key: 'quickTranslation.description'},
      {key: 'quickTranslation.capacityReached'},
      {key: 'quickTranslation.capacityLimit', params: {count: 8}},
      {key: 'quickTranslation.clickEdit'},
      {key: 'quickTranslation.clickRecord'},
      {key: 'quickTranslation.systemConflict', params: {warning: 'Copy'}},
      {key: 'quickTranslation.followDefault', params: {value: 'Default service'}},
      {key: 'quickTranslation.translationServiceAria', params: {hotkey: 'Ctrl+T'}},
      {key: 'quickTranslation.serviceUnavailable', params: {service: 'Service'}},
      {key: 'quickTranslation.translationModelAria', params: {hotkey: 'Ctrl+T'}},
      {key: 'quickTranslation.pinServiceHint'},
      {key: 'quickTranslation.targetLanguageAria', params: {hotkey: 'Ctrl+T'}},
      {key: 'quickTranslation.displayModeAria', params: {hotkey: 'Ctrl+T'}},
      {key: 'quickTranslation.field.range'},
      {key: 'quickTranslation.fullPageRangeAria', params: {hotkey: 'Ctrl+T'}},
      {key: 'quickTranslation.delete'},
      {key: 'quickTranslation.deleteAria', params: {profile: 'Profile 1'}},
      {key: 'quickTranslation.defaultModel'},
      {key: 'quickTranslation.followServiceDefault'},
      {key: 'quickTranslation.followServiceDefaultModel', params: {model: 'Model'}},
      {key: 'quickTranslation.serviceRestriction'},
      {key: 'quickTranslation.useDefaults'},
      {key: 'quickTranslation.profileUnavailable', params: {detail: 'English · Bilingual'}},
      {key: 'quickTranslation.profilePaused', params: {detail: 'English · Bilingual'}},
      {key: 'quickTranslation.action.hover'},
      {key: 'quickTranslation.action.fullPage'},
      {key: 'quickTranslation.profileName', params: {action: 'Hover', index: 1, hotkey: 'Ctrl+T'}},
      {key: 'quickTranslation.profileNeedsHotkey', params: {profile: 'Profile 1'}},
      {key: 'quickTranslation.enableProfile', params: {profile: 'Profile 1'}},
      {key: 'quickTranslation.disableProfile', params: {profile: 'Profile 1'}},
      {key: 'quickTranslation.enableProfileUnavailable', params: {profile: 'Profile 1'}},
      {key: 'quickTranslation.disableProfileUnavailable', params: {profile: 'Profile 1'}},
      {key: 'quickTranslation.defaultHover'},
      {key: 'quickTranslation.defaultFullPage'},
      {key: 'quickTranslation.duplicate'},
      {key: 'quickTranslation.legacyConflictEdit', params: {feature: 'Default hover translation'}},
      {key: 'quickTranslation.legacyConflictEnable', params: {feature: 'Default hover translation'}},
      {key: 'quickTranslation.recordFirst'},
      {key: 'quickTranslation.setFirst'},
      {key: 'quickTranslation.selectionPrecedence'},
      {key: 'quickTranslation.googleNotice'},
      {key: 'quickTranslation.googleOnly'},
      {key: 'quickTranslation.conflictProfile', params: {group: 'Extra hover shortcuts'}},
      {key: 'quickTranslation.conflictProfilePopup', params: {group: 'Extra hover shortcuts'}},
      {key: 'quickTranslation.shortcutDisabled'},
      {key: 'quickTranslation.shortcutSet', params: {shortcut: 'Ctrl+T'}},
      {key: 'quickTranslation.selectionShortcutDisabled'},
      {key: 'quickTranslation.selectionShortcutSet', params: {shortcut: 'Ctrl+T'}},
      {key: 'quickTranslation.defaultServiceDescription'},
      {key: 'quickTranslation.commonHoverShortcut'},
      {key: 'quickTranslation.commonFullPageShortcut'},
      {key: 'popup.quickTranslation.defaultHoverShortcut'},
      {key: 'popup.quickTranslation.defaultOnly', params: {count: 2}},
      {key: 'popup.quickTranslation.defaultOff'},
      {key: 'popup.quickTranslation.toggleDefaultHover'},
      {key: 'popup.quickTranslation.extraProfiles'},
      {key: 'popup.quickTranslation.moreProfiles', params: {count: 2}},
      {key: 'popup.quickTranslation.profileCount', params: {count: 3}},
      {key: 'popup.quickTranslation.defaultNotSet'},
      {key: 'popup.quickTranslation.fullPageHint', params: {count: 2}},
    ];
    const languages = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const;

    for (const {key, params} of cases) {
      const chinese = translate(key, 'zh-CN', params);
      for (const language of languages) {
        const localized = translate(key, language, params);
        expect(localized, `${language}: ${key}`).not.toBe(key);
        expect(localized, `${language}: ${key}`).not.toMatch(/\{[a-zA-Z0-9_]+\}/u);
        if (language !== 'zh-CN') expect(localized, `${language}: ${key}`).not.toBe(chinese);
        if (['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'].includes(language)) {
          expect(localized, `${language}: ${key}`).not.toMatch(/[\u3400-\u9fff]/u);
        }
      }
    }

    expect(translate('quickTranslation.heading.hover', 'en-US')).toBe('More hover shortcuts');
    expect(translate('popup.quickTranslation.profileCount', 'ja-JP', {count: 3})).toContain('3');

    for (const language of languages) {
      expect(translate('quickTranslation.serviceRestriction', language)).not.toContain(' · ');
    }
    const chineseProfileName = translate('quickTranslation.profileName', 'zh-CN', {
      action: translate('quickTranslation.action.hover', 'zh-CN'), index: 1, hotkey: 'Ctrl+T',
    });
    expect(translate('quickTranslation.deleteAria', 'zh-CN', {profile: chineseProfileName}))
      .toBe('删除悬浮快捷方案 1 Ctrl+T');

    const countNeutralEnglish = {
      'popup.quickTranslation.defaultOnly': 'This switch only controls the default shortcut · independent profile count: 1',
      'popup.quickTranslation.moreProfiles': 'Additional profile count in full settings: 1.',
      'popup.quickTranslation.profileCount': 'Shortcut profile count: 1',
      'popup.quickTranslation.fullPageHint': 'Additional full-page profile count: 1. This badge only shows the default shortcut.',
    } as const;
    for (const [key, expected] of Object.entries(countNeutralEnglish)) {
      expect(translate(key, 'en-US', {count: 1})).toBe(expected);
    }
    for (const language of ['fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const key of Object.keys(countNeutralEnglish)) {
        const localized = translate(key, language, {count: 1});
        expect(localized, `${language}: ${key}`).toContain('1');
        expect(localized, `${language}: ${key}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('本地化快捷键冲突检测返回的系统操作名称', () => {
    const conflictReasons = [
      '复制', '粘贴', '剪切', '撤销', '重做', '全选', '保存', '打开', '新建', '关闭标签页',
      '新建标签页', '刷新页面', '查找', '历史记录', '添加书签', '关闭程序', '重新打开关闭的标签页',
      '无痕模式', '清除浏览数据', '退出程序', 'Spotlight搜索',
    ];
    const nonChineseLanguages = ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const;
    const malformedValidationMessages = ['Ctrl+', '+T', 'Ctrl++T'].map((hotkey) => {
      const message = parseHotkey(hotkey).errorMessage;
      if (!message) throw new Error(`预期 ${hotkey} 产生快捷键解析错误`);
      return message;
    });
    expect(malformedValidationMessages).toEqual([
      '不支持的按键: ',
      '不支持的修饰键: ',
      '不支持的修饰键: ',
    ]);
    const validationMessages = [
      '与系统快捷键冲突: 新建标签页',
      '与系统快捷键冲突: 重新打开关闭的标签页',
      '单个字母键需要与修饰键组合使用',
      'CMD 键已被禁用，请使用其他修饰键组合',
      '不支持的按键: mystery',
      '不支持的修饰键: mystery',
      '当前快捷键为 Alt+T',
      ...malformedValidationMessages,
    ];

    for (const language of nonChineseLanguages) {
      expect(translateLegacyText('新建标签页', language)).not.toBe('新建标签页');
      expect(translateLegacyText('重新打开关闭的标签页', language)).not.toBe('重新打开关闭的标签页');
      for (const message of validationMessages) {
        const localized = translateLegacyText(message, language);
        expect(localized, `${language}: ${message}`).not.toBe(message);
        if (language !== 'ja-JP') expect(localized, `${language}: ${message}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
      for (const reason of conflictReasons) {
        const localized = translateLegacyText(reason, language);
        if (language !== 'ja-JP') expect(localized, `${language}: ${reason}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('本地化动态凭据缺失提示并保留服务名称', () => {
    const credentialMessages = [
      getMissingCredentialMessage(services.deepseek, {token: {}}),
      getMissingCredentialMessage(services.youdao, {token: {}, youdaoAppKey: 'configured'}),
      getMissingCredentialMessage(services.tencent, {token: {}, tencentSecretId: 'configured'}),
    ];
    expect(credentialMessages.every((message): message is string => Boolean(message))).toBe(true);

    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const message of credentialMessages) {
        const localized = translateLegacyText(message!, language);
        expect(localized, `${language}: ${message}`).not.toBe(message);
        if (language !== 'ja-JP') expect(localized, `${language}: ${message}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('翻译动画导航关键词和配置差异文案在非中文 legacy 界面中不回显中文源文案', () => {
    const advancedNavigation = navigationItems.find((item) => item.id === 'settings-advanced');
    const diff = buildConfigDiff(
      {translationLoadingStyle: 'minimal'},
      {translationLoadingStyle: 'sparkle'},
    );
    const loadingStyleChange = diff.groups
      .flatMap((group) => group.changes)
      .find((change) => change.key === 'translationLoadingStyle');
    expect(advancedNavigation).toBeDefined();
    expect(loadingStyleChange).toBeDefined();

    const sourceCopy = [
      advancedNavigation!.summary,
      advancedNavigation!.searchDescription,
      loadingStyleChange!.label,
      ...translationLoadingStyleOptions.map((option) => option.label),
    ];
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of sourceCopy) {
        expect(translateLegacyText(source, language), `${language}: ${source}`).not.toBe(source);
      }
    }
    for (const language of ['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of sourceCopy) {
        expect(translateLegacyText(source, language), `${language}: ${source}`)
          .not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('圈选设置和结果说明提供明确的 English 文案与其他语言回退', () => {
    const areaKeys = Object.keys(zhCNMessages).filter(key => key.startsWith('area.settings.'));
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const key of areaKeys) expect(translate(key, language)).not.toBe(key);
    }
    expect(translate('area.settings.standardDescription', 'en-US')).toContain('recognized text');
    expect(translate('area.settings.aiDescription', 'en-US')).toContain('translation');
    expect(translate('area.settings.visionPrivacy', 'en-US')).toContain('uploads the selected image');
    expect(translate('area.settings.privacy', 'en-US')).toContain('screenshots are not uploaded');
    for (const copy of [
      'AI 仅处理识别文字，无法找回图片中的漏字；请核对名称和数字。',
      '当前服务或模型不支持 AI 文字增强，请选择通用 AI 模型或使用标准翻译',
      '无法打开设置，请从扩展菜单打开圈选设置',
    ]) expect(translateLegacyText(copy, 'en-US')).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('段落复制的设置与页内提示覆盖每种界面语言，并保留相同的插值参数', () => {
    const keys = Object.keys(zhCNMessages).filter(key => key.startsWith('paragraphCopy.'))
    expect(keys.length).toBeGreaterThan(0)
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const key of keys) {
        const localized = translate(key, language)
        expect(localized, `${language}: ${key}`).not.toBe(key)
        // 日语与中文共用"原文"等汉字词，其余语言不得回显中文原串。
        if (language !== 'ja-JP') {
          expect(localized, `${language}: ${key}`).not.toBe(zhCNMessages[key as keyof typeof zhCNMessages])
        }
      }
    }
    expect(translate('paragraphCopy.notice.copiedBilingual', 'zh-CN', {count: 12})).toBe('已复制原文和译文（12 字）')
    expect(translate('paragraphCopy.notice.copiedBilingual', 'en-US', {count: 12})).toBe('Original and translation copied (12 characters)')
    expect(translate('paragraphCopy.settings.enabledDescription', 'en-US', {shortcut: 'Alt+C'})).toContain('Alt+C')
    for (const label of ['段落复制', '段落复制快捷键', '自定义段落复制快捷键', '段落复制内容', '跟随页面显示', '原文和译文']) {
      for (const language of ['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
        expect(translateLegacyText(label, language), `${language}: ${label}`).not.toMatch(/[\u3400-\u9fff]/u)
      }
    }
  })

  it('独立界面布局导航、皮肤风格和通用设置文案覆盖每种界面语言', () => {
    const navigationCopy = navigationItems
      .filter((item) => ['settings-general', 'settings-interface'].includes(item.id))
      .flatMap(({id, icon, ...copy}) => Object.values(copy));
    const skinCopy = [...interfaceSkinGroups, ...interfaceSkinOptions]
      .flatMap(({label, description}) => [label, description]);
    const fontKeys = [
      'settings.interface.font.label',
      'settings.interface.font.description',
      'settings.interface.font.preview',
      ...interfaceFontOptions.flatMap(({labelKey, descriptionKey}) => [labelKey, descriptionKey]),
    ];
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of [...navigationCopy, ...skinCopy]) {
        const localized = translateLegacyText(source, language);
        expect(localized, `${language}: ${source}`).not.toBe(source);
        if (language !== 'ja-JP') expect(localized).not.toMatch(/[\u3400-\u9fff]/u);
      }
      for (const key of fontKeys) expect(translate(key, language), `${language}: ${key}`).not.toBe(key);
    }
  });

  it('学习中心的新导航、栏目和保存期限覆盖全部界面语言', () => {
    const item = navigationItems.find(value => value.id === 'settings-vocabulary')!;
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of [item.label, item.description, item.summary, item.detail, item.searchDescription]) {
        expect(translateLegacyText(source, language), `${language}: ${source}`).not.toBe(source);
      }
      for (const key of ['learning.saved', 'learning.history', 'learning.content', 'learning.retention', 'learning.savedDescription', 'learning.historyDescription', 'learning.memoryDescription', 'learning.memory', 'learning.memoryAdd', 'learning.memoryDisabled', 'learning.memoryClearConfirm', 'settings.memoryEnabled', 'settings.memoryDescription', 'settings.learningContext', 'learning.localStorage', 'learning.localStorageHelp', 'learning.backup', 'learning.collection.actions', 'learning.collection.reviewHelp', 'learning.collection.upToDate', 'learning.collection.review', 'learning.collection.reviewDone', 'learning.collection.manage', 'learning.collection.settingHelp', 'learning.collection.type', 'learning.collection.filter', 'learning.collection.reset', 'learning.collection.matches', 'learning.collection.noMatchesHelp', 'learning.collection.sentence', 'learning.collection.expression', 'learning.collection.listenLearn', 'learning.collection.learnUsage', 'learning.memorySettingsOpen', 'learning.collection.setting', 'learning.collection.enable', 'learning.collection.offEmptyTitle', 'learning.collection.emptyTitle', 'learning.collection.emptyHint', 'learning.collection.enableHelp', 'reading.saveNote', 'reading.noteSavedButton', 'reading.saveNoteTitle', 'reading.viewNotes', 'reading.noteSaved', 'reading.openNotesFailed', 'reading.noteSaveFailed', 'reading.saveSourceTitle', 'reading.viewSaved', 'reading.sourceSaved', 'reading.openSavedFailed', 'reading.savingSource']) {
        expect(translate(key, language)).not.toBe(translate(key, 'zh-CN'));
        expect(translate(key, language)).not.toBe(key);
      }
    }
    expect(translate('learning.saved', 'zh-CN')).toBe('单词与句子');
    expect(translate('learning.memory', 'zh-CN')).toBe('学习笔记');
    expect(translate('learning.history', 'en-US')).toBe('Reading history');
  });

  it('完整本地化菜单栏布局编辑器与布局差异顺序', () => {
    const layoutKeys = [
      'settings.interface.popupLayout.label',
      'settings.interface.popupLayout.description',
      'settings.interface.popupLayout.previewTitle',
      'settings.interface.popupLayout.previewDescription',
      'settings.interface.popupLayout.orderHint',
      'settings.interface.popupLayout.restoreDefault',
      'settings.interface.popupLayout.listAria',
      'settings.interface.popupLayout.handleAria',
      'settings.interface.popupLayout.showAria',
      'settings.interface.popupLayout.required',
      'settings.interface.popupLayout.moveUp',
      'settings.interface.popupLayout.moveDown',
      'settings.interface.popupLayout.help',
      'settings.interface.popupLayout.shown',
      'settings.interface.popupLayout.hidden',
      'settings.interface.popupLayout.moved',
      'settings.interface.popupLayout.restored',
      ...popupModuleOptions.flatMap((module) => [module.labelKey, module.descriptionKey]),
      'settings.interface.popupQuickFeatures.label',
      'settings.interface.popupQuickFeatures.description',
      ...popupQuickFeatureOptions.flatMap((feature) => [feature.labelKey, feature.descriptionKey]),
    ];
    const diff = buildConfigDiff(
      {popupModuleOrder: ['translation', 'siteRule', 'quickFeatures', 'footer']},
      {popupModuleOrder: ['quickFeatures', 'translation', 'siteRule', 'footer']},
    );
    const layoutChange = diff.groups
      .flatMap((group) => group.changes)
      .find((change) => change.key === 'popupModuleOrder');
    expect(layoutChange).toBeDefined();
    expect(layoutChange!.label).toBe('菜单栏布局顺序');
    expect(translate('settings.interface.popupLayout.label', 'zh-CN')).toBe('菜单栏布局');
    expect(translate('settings.interface.popupLayout.label', 'en-US')).toBe('Menu bar layout');

    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const key of layoutKeys) {
        expect(translate(key, language, {label: 'Module', position: 2}), `${language}: ${key}`)
          .not.toBe(key);
      }
      expect(translateLegacyText(layoutChange!.label, language)).not.toBe(layoutChange!.label);
      expect(translateLegacyText(layoutChange!.before, language)).not.toBe(layoutChange!.before);
      expect(translateLegacyText(layoutChange!.after, language)).not.toBe(layoutChange!.after);
    }
    for (const language of ['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      expect(translateLegacyText(layoutChange!.before, language)).not.toMatch(/[\u3400-\u9fff]/u);
      expect(translateLegacyText(layoutChange!.after, language)).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it('每种旧界面词典都覆盖 English 基线，且 English 界面不夹杂中文', () => {
    for (const catalog of translatedLegacyCatalogs) {
      expect(Object.keys(enUSLegacyText).filter((key) => !catalog[key])).toEqual([]);
    }

    const allowedNativeLabels = new Set(['中文', '日本語']);
    const unexpectedHan = Object.entries(enUSLegacyText).filter(([, value]) => (
      /[\u3400-\u9fff]/u.test(value) && !allowedNativeLabels.has(value)
    ));
    expect(unexpectedHan).toEqual([]);
  });

  it('逐段翻译复合状态，不把整行回退成 English', () => {
    const offWithIcon = {
      'en-US': 'Off · Show icon',
      'ja-JP': 'オフ · アイコンを表示',
      'ko-KR': '끔 · 아이콘 표시',
      'fr-FR': 'Désactivé · Afficher l’icône',
      'ru-RU': 'Выключено · Показывать значок',
      'es-ES': 'Desactivado · Mostrar icono',
    } as const;
    const bilingualBold = {
      'en-US': 'Bilingual · Bold',
      'ja-JP': '二言語 · 太字表示',
      'ko-KR': '이중 언어 · 굵게 표시',
      'fr-FR': 'Bilingue · Affichage en gras',
      'ru-RU': 'Двуязычный режим · Полужирный текст',
      'es-ES': 'Bilingüe · Negrita',
    } as const;

    for (const language of Object.keys(offWithIcon) as Array<keyof typeof offWithIcon>) {
      expect(translateLegacyText('已关闭 · 显示图标', language)).toBe(offWithIcon[language]);
      expect(translateLegacyText('双语 · 加粗显示', language)).toBe(bilingualBold[language]);
    }
  });

  it('翻译 AI 服务展开态中的动态字符上限', () => {
    expect(translateLegacyText('最多 8192 字符', 'en-US')).toBe('Up to 8192 characters');
    expect(translateLegacyText('最多 8192 字符', 'ja-JP')).toBe('最大 8192 文字');
    expect(translateLegacyText('最多 8192 字符', 'ko-KR')).toBe('최대 8192자');
    expect(translateLegacyText('最多 8192 字符', 'fr-FR')).toBe('8192 caractères maximum');
    expect(translateLegacyText('最多 8192 字符', 'ru-RU')).toBe('Не более 8192 символов');
    expect(translateLegacyText('最多 8192 字符', 'es-ES')).toBe('Máximo 8192 caracteres');
  });

  it('两点选取的设置、起终点和拒绝原因在六种外语中有真实译文', () => {
    const sources = [
      '两点选取',
      '编辑两点选取快捷键',
      '开启后按快捷键，再依次点击文字起点和终点，无需按住鼠标；完成自动退出，Esc 取消',
      '请选择带 Ctrl、Alt 或 Shift 的组合键',
      '点击文字起点',
      '点击文字终点',
      '未点中文字，请点击起点',
      '未点中文字，请点击终点',
      '起点与终点相同，请换一个位置',
      '选区过长，请点击较近的终点',
      '此范围不支持，请换一个终点',
      '额外翻译方案',
    ];
    expect(runtimeFeedbackRows.filter(row => sources.includes(row[0]))).toEqual([]);
    for (const source of sources) expect(correctionRows.filter(row => row[0] === source)).toHaveLength(1);
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of sources) {
        const localized = translateLegacyText(source, language);
        expect(localized, `${language}: ${source}`).not.toBe(source);
        if (language !== 'ja-JP') expect(localized, `${language}: ${source}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('两点选取复合提示翻译真实状态前缀与 Esc 后缀，并保留扫描占位数字', () => {
    const cancelSuffixes = {
      'en-US': 'Esc to cancel',
      'ja-JP': 'Esc でキャンセル',
      'ko-KR': 'Esc로 취소',
      'fr-FR': 'Échap pour annuler',
      'ru-RU': 'Esc — отмена',
      'es-ES': 'Esc para cancelar',
    } as const;
    for (const language of Object.keys(cancelSuffixes) as Array<keyof typeof cancelSuffixes>) {
      for (const source of ['点击文字起点', '点击文字终点', '未点中文字，请点击起点', '未点中文字，请点击终点',
        '起点与终点相同，请换一个位置', '选区过长，请点击较近的终点', '此范围不支持，请换一个终点']) {
        const localized = translateLegacyText(`${source} · Esc 取消`, language);
        expect(localized).toBe(`${translateLegacyText(source, language)} · ${cancelSuffixes[language]}`);
        expect(localized).not.toContain(source);
        const spacedSource = ` \t${source} · Esc 取消\n`;
        expect(translateLegacyText(spacedSource, language)).toBe(` \t${localized}\n`);
        expect(translateLegacyText(spacedSource, 'zh-CN')).toBe(spacedSource);
      }
      for (const count of [0, 1, 12, 125, 987654321]) {
        const source = `${count} · Esc 取消`;
        const localized = `${count} · ${cancelSuffixes[language]}`;
        expect(translateLegacyText(source, language)).toBe(localized);
        expect(translateLegacyText(` \t${source}\n`, language)).toBe(` \t${localized}\n`);
        expect(translateLegacyText(` \t${source}\n`, 'zh-CN')).toBe(` \t${source}\n`);
      }
    }
    expect(translateLegacyText('点击文字起点 · Esc 取消', 'zh-CN')).toBe('点击文字起点 · Esc 取消');
    expect(runtimeFeedbackRows.some(row => row[0] === '12 · Esc 取消')).toBe(false);
  });

  it('人工校正容易发生语义误判的高频设置文案', () => {
    expect(translateLegacyText('日本語', 'en-US')).toBe('Japanese');
    expect(translateLegacyText('显示 FluentRead 字幕', 'ja-JP')).toBe('FluentRead 字幕を表示');
    expect(translateLegacyText('显示 FluentRead 字幕', 'ko-KR')).toBe('FluentRead 자막 표시');
    expect(translateLegacyText('禁用扩展网站', 'fr-FR')).toBe('Sites où désactiver l’extension');
    expect(translateLegacyText('禁用扩展网站', 'ru-RU')).toBe('Сайты с отключённым расширением');
    expect(translateLegacyText('禁用扩展网站', 'es-ES')).toBe('Sitios con la extensión desactivada');
    expect(translateLegacyText('默认关闭；仅在已适配接口生效，无法关闭时使用最低档', 'ja-JP'))
      .toBe('デフォルトではオフです。対応済みの API でのみ有効になり、無効化できない場合は最小レベルを使用します。');
    expect(translateLegacyText('当前模型是否启用 Thinking', 'es-ES'))
      .toBe('Activar Thinking para el modelo actual');
  });

  it('为高级调度摘要按语言插值，不残留中文模板', () => {
    expect(translate('settings.advanced.schedulerSummary', 'en-US', {
      concurrency: 6,
      perSecond: '∞',
      perMinute: 60,
      retries: 3,
      baseDelay: '500ms',
      maxDelay: '8s',
    })).toBe('Up to 6 translation tasks at once; limits: ∞/s and 60/min; up to 3 retries; backoff: 500ms–8s.');
    expect(translate('settings.advanced.schedulerSummary', 'ja-JP', {
      concurrency: 6,
      perSecond: '∞',
      perMinute: 60,
      retries: 3,
      baseDelay: '500ms',
      maxDelay: '8s',
    })).toBe('翻訳タスクを最大 6 件同時に処理します。上限：毎秒 ∞ 件、毎分 60 件。再試行は最大 3 回、待機時間は 500ms～8s。');
    expect(translate('settings.sites.count', 'en-US', {count: 0})).toBe('Websites: 0');
    expect(translate('settings.sites.count', 'ko-KR', {count: 3})).toBe('사이트 3개');
  });

  it('只把显式登记的旧 UI 文案翻译为当前界面语言', () => {
    expect(translateLegacyText('翻译服务', 'en-US')).toBe('Translation services');
    expect(translateLegacyText('  翻译服务  ', 'en-US')).toBe('  Translation services  ');
    expect(translateLegacyText('微软翻译 · YouTube', 'en-US')).toBe('Microsoft Translator · YouTube');
    expect(translateLegacyText('已完成 3 次翻译', 'en-US')).toBe('3 translations completed');
    expect(translateLegacyText('用户自己的中文正文', 'en-US')).toBe('用户自己的中文正文');
    expect(translateLegacyText('翻译服务', 'zh-CN')).toBe('翻译服务');
    expect(translateLegacyText('软件语言', 'es-ES')).toBe('Idioma de la aplicación');
    expect(translateLegacyText('软件语言', 'ja-JP')).toBe('アプリの言語');
    expect(translateLegacyText('软件语言', 'ko-KR')).toBe('앱 언어');
    expect(translateLegacyText('双语逐句高亮', 'en-US')).toBe('Bilingual sentence highlighting');
    expect(translateLegacyText('双语逐句高亮', 'es-ES')).toBe('Resaltado bilingüe por oración');
    expect(translateLegacyText('软件语言', 'fr-FR')).toBe('Langue de l’application');
    expect(translateLegacyText('软件语言', 'ru-RU')).toBe('Язык приложения');
    expect(translateLegacyText('中文', 'es-ES')).toBe('中文');
    expect(translateLegacyText('已就绪', 'es-ES')).toBe('Listo');

    const interfaceAppearanceCopy = [
      '界面与弹窗',
      '从效率布局到传统色配色，选择适合自己的界面；也可以只留下常用栏目。',
      '弹窗风格',
      '风格只改变扩展界面的呈现，不影响网页翻译效果。',
      '快捷功能栏',
      '显示悬停、划词、图片、视频和文档等快捷入口。',
      '当前网站栏目',
      '当前网站的始终翻译和禁用扩展开关。',
      '底部信息栏',
      '显示翻译统计、开源项目入口和清除缓存操作。',
    ];
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of interfaceAppearanceCopy) {
        expect(translateLegacyText(source, language)).not.toBe(source);
      }
    }
    expect(translateLegacyText('界面与弹窗', 'en-US')).toBe('Interface and popup');
    expect(translateLegacyText('默认风格', 'es-ES')).toBe('Estilo predeterminado');
    expect(translateLegacyText('青花', 'en-US')).toBe('Blue and white (Qinghua)');
    expect(translateLegacyText('水墨', 'ja-JP')).toBe('水墨（すいぼく）');
    expect(translateLegacyText('传统色风格', 'fr-FR')).toBe('Couleurs traditionnelles chinoises');
  });

  it('把界面语言作为普通可迁移配置保留，并不触碰凭据边界', () => {
    const exported = prepareConfigForExport(normalizeConfig({uiLanguage: 'en-US'}));
    expect(exported.uiLanguage).toBe('en-US');

    const imported = prepareConfigForImport({
      ...new Config(),
      uiLanguage: 'en-US',
    }, new Config());
    expect(imported.uiLanguage).toBe('en-US');
    expect(imported.token).toEqual({});
    expect(toRestorableConfig({uiLanguageSetupCompleted: true})).not.toHaveProperty('uiLanguageSetupCompleted');
  });
});

// 扫描实际界面源文件，避免只检查词典自身而放过未登记的新文案。
describe('i18n 全量界面扫描', () => {
  it('Vue 文案和展示注册表在非中文界面有本地化结果', async () => {
    const {collectUiSourceCopy} = await import('../scripts/testing/i18n-source-audit.mjs');
    const audit = collectUiSourceCopy(process.cwd());
    // 固定的中英术语演示、语言自身名称和装饰图标不属于界面译文。
    const examples = new Set(['中文', 'A中', '語言', '言語', 'large language model → 大语言模型', 'source,target,tgt_lng large language model,大语言模型,zh-Hans']);
    const readingPreviewFile = 'src/features/settings/ui/VideoSubtitleAppearanceSettings.vue';
    // 日语原句用于固定排版示例；仅豁免该组件的这句话，并要求保留本地化的演示数据说明。
    expect(readFileSync(join(process.cwd(), readingPreviewFile), 'utf8'))
      .toMatch(/data-video-subtitle-reading-sample>\s*\{\{\s*t\('video\.readingAnnotation\.previewSample'\)\s*\}\}/u);
    const missing: string[] = [];
    for (const {source, files} of audit.sources) {
      if (examples.has(source)) continue;
      if (source === '今日はいい天気ですね。' && files.length === 1 && files[0] === readingPreviewFile) continue;
      for (const locale of ['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
        const result = translateLegacyText(source, locale);
        if (/[\u3400-\u9fff]/u.test(result)) missing.push(`${locale} ${files.join(', ')}: ${source}`);
      }
    }
    expect(audit.files.length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
    // 扫描器的插值占位不能成为固定译文；实际校订预览必须保留每次计算的句数。
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const count of [0, 1, 12, 125]) {
        const source = `当前网页有 ${count} 处相同原句。出现不同的已保存译法时，不会自动采用。`;
        const translated = translateLegacyText(source, locale);
        expect(translated, `${locale} ${count}`).not.toBe(source);
        expect(translated.match(/\d+/gu), `${locale} ${count}`).toEqual([String(count)]);
        if (locale !== 'ja-JP') expect(translated, `${locale} ${count}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('新增稳定资源必须提供实际译文，不能继承 English 掩盖遗漏', () => {
    // ms 是国际通用的毫秒符号，无需在法语或西班牙语中改写。
    const common = new Set(['inputTranslation.intervalUnit', 'common.brand', 'metadata.popupTitle', 'settings.advanced.translationLoadingStyleOptionAria', 'reading.generatingAction',
      // 品牌名与纯排版模板在多数语言下与英文一致，强行改写反而破坏菜单文案。
      'settings.interface.font.options.inter.label',
      'contextMenu.groupPlain', 'contextMenu.standalone', 'contextMenu.withShortcut', 'contextMenu.withLanguage', 'contextMenuSettings.withReason']);
    // “Original” 在法语与西班牙语中拼写与英文相同，视频字幕菜单的短标签沿用该词。
    const videoOriginalLabels = ['video.modeOriginal', 'video.downloadOriginalShort'];
    const frenchCognates = new Set(['learning.memoryNote', 'document.progressSegments', 'document.pageCount', 'document.pageNumber', 'options.aboutDocs', 'settings.advanced.animations', 'settings.advanced.translationLoadingStyle.minimal.label',
      // Style、Format、Original 同样是自然的法语短标签。
      'shareCard.style', 'shareCard.format', 'shareCard.original',
      // Page、Zoom 与 Original 也是 PDF 阅读器中自然的法语短标签。
      'document.pdfReading.pageLabel', 'document.pdfReading.pageNumber', 'document.pdfReading.zoom', 'document.pdfReading.original',
      'translationStats.filter.service', 'translationStats.source.network', 'translationStats.log.image', 'translationStats.routes.column.route', ...videoOriginalLabels]);
    const spanishCognates = new Set([...videoOriginalLabels, 'shareCard.original', 'shareCard.theme.coral', 'document.pdfReading.zoom', 'document.pdfReading.original',
      // Color 是自然的西班牙语短标签，与英文同形。
      'informationHighlight.color']);
    for (const [locale, catalog] of Object.entries({'ja-JP': jaJPMessages, 'ko-KR': koKRMessages, 'fr-FR': frFRMessages, 'ru-RU': ruRUMessages, 'es-ES': esESMessages})) {
      const untranslated = Object.entries(enUSMessages).filter(([key, source]) => (
        !key.startsWith('language.') && !common.has(key) && !(locale === 'fr-FR' && frenchCognates.has(key))
        && !(locale === 'es-ES' && spanishCognates.has(key))
        && catalog[key as keyof typeof catalog] === source
      )).map(([key]) => key);
      expect(untranslated, locale).toEqual([]);
    }
  });

  it('动态模板本地化并保留用户词条、数字及空格', () => {
    for (const locale of ['ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      const deleted = translateLegacyText('  已删除 阅读  ', locale);
      expect(deleted.startsWith('  ')).toBe(true);
      expect(deleted.endsWith('  ')).toBe(true);
      expect(deleted).toContain('阅读');
      expect(deleted).not.toContain('已删除');
      const summary = translateLegacyText('复习 3 个 · 记得 2 个 · 忘了 1 个', locale);
      expect(summary).not.toBe(translateLegacyText('复习 3 个 · 记得 2 个 · 忘了 1 个', 'en-US'));
      for (const number of ['1', '2', '3']) expect(summary).toContain(number);
      expect(translate('learning.writeSentenceHint', locale, {term: '保存'})).toContain('保存');
    }
  });
});


describe('动态旧文案资源契约', () => {
  it('每个模板的全部语言都保留捕获参数，未登记正文不被改写', () => {
    for (const {pattern, localizedCaptures, messages} of localizedLegacyPatterns) {
      const source = pattern.slice(1, -1).replaceAll('([\\d,.]+\\s?[A-Za-z]*)', '12').replaceAll('([\\d,.]+)', '12').replaceAll('(\\d+)', '12').replaceAll('(.+)', '「占位」').replaceAll('(.*)', '「占位」').replaceAll('\\/', '/');
      const captures = new RegExp(pattern, 'u').exec(source);
      expect(captures, source).not.toBeNull();
      for (const locale of ['ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
        const expected = messages[locale].replace(/\{(\d+)\}/gu, (_, index: string) => {
          expect(captures![Number(index)], `${locale} ${source}`).toBeDefined();
          return localizedCaptures.includes(Number(index)) ? translateLegacyText(captures![Number(index)], locale) : captures![Number(index)];
        });
        expect(translateLegacyText(source, locale), `${locale} ${source}`).toBe(expected);
      }
    }
    expect(translateLegacyText('不属于界面文案的原文', 'ja-JP')).toBe('不属于界面文案的原文');
  });

  it('按语言展开模板：早期模板只收录该语言译文，非 English 的兜底模板追加 English', () => {
    const english = createLegacyPatternSet('en-US');
    const japanese = createLegacyPatternSet('ja-JP');
    expect(english.early.every(([, template]) => !/[\u3040-\u30ff]/u.test(template))).toBe(true);
    expect(english.late.length).toBeLessThan(japanese.late.length);
    expect(japanese.late.slice(-english.late.length)).toEqual(english.late);
    for (const [pattern] of [...japanese.early, ...japanese.late]) expect(() => new RegExp(pattern, 'u')).not.toThrow();
  });

  it('资源包中的损坏模板被跳过，重新注册资源包后重新编译', () => {
    registerUiLanguageBundle('ko-KR', {
      messages: {},
      legacyText: {},
      legacyPatterns: {early: [['^(坏', '损坏'], ['^第 (\\d+) 行$', '행 {1} {2}', [1]]], late: [['^尾(.+)$', 'tail {1}']]},
    });
    expect(translateLegacyText('第 3 行', 'ko-KR')).toBe('행 3 ');
    expect(translateLegacyText('尾巴', 'ko-KR')).toBe('tail 巴');
    expect(translateLegacyText('(坏', 'ko-KR')).toBe('(坏');
    registerAllUiLanguageBundles();
    expect(translateLegacyText('尾巴', 'ko-KR')).toBe('尾巴');
  });
});

// 嵌套界面片段需要继续本地化，名称和正文参数仍保持原样。
describe('动态界面片段', () => {
  it('翻译嵌套进度和按钮标签，保留自定义模型名称', () => {
    for (const locale of ['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      for (const source of ['复制原文', '播放译文', '导入完成：模型用量新增 1、跳过 2；单词本新增 3、更新 4、跳过 5', '翻译进度：正在进行 2 个任务，剩余 3 个任务，其中 1 个任务将在滚动到附近时翻译']) {
        expect(translateLegacyText(source, locale)).not.toMatch(/[\u3400-\u9fff]/u);
      }
      expect(translateLegacyText('删除模型 保存', locale)).toContain('保存');
    }
    expect(translateLegacyText('1 分 2 秒', 'en-US')).toBe('1 min 2 sec');
  });
});

function collectSourceText(directory: string, include: (path: string) => boolean): string {
  return readdirSync(directory, {withFileTypes: true}).map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceText(path, include);
    return /\.(?:ts|vue)$/u.test(entry.name) && include(path) ? readFileSync(path, 'utf8') : '';
  }).join('\n');
}

// 后台和各功能抛出的中文反馈会原样到达页内通知与设置页，登记的原文必须仍存在于源码中且六种语言都有译文。
describe('运行期反馈文案资源', () => {
  const locales = ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const;
  const han = /[㐀-鿿]/u;

  it('每条精确反馈都来自真实源码，不重复，并在每种界面语言中完整本地化', () => {
    const sourceText = collectSourceText('src', (path) => !path.includes('/i18n/messages/'))
      + collectSourceText('userscript', () => true);
    const sources = runtimeFeedbackRows.map(row => row[0]);
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources.filter((source) => !sourceText.includes(source))).toEqual([]);
    for (const locale of locales) {
      const catalog = createRuntimeFeedbackLegacyText(locale);
      for (const source of sources) {
        const translated = translateLegacyText(source, locale);
        expect(translated, `${locale} ${source}`).toBe(catalog[source]);
        expect(translated.trim(), `${locale} ${source}`).not.toBe('');
        if (locale !== 'ja-JP') expect(translated, `${locale} ${source}`).not.toMatch(han);
      }
    }
  });

  it('参数化反馈模板保留捕获参数、优先于宽泛模板命中，并继续翻译嵌套原因', () => {
    const sampleOf = (pattern: string) => pattern.slice(1, -1)
      .replaceAll('(\\d+(?:\\.\\d+)?)', '12')
      .replaceAll('(\\d+)', '12')
      .replaceAll('(PDF|ePub|DOCX)', 'PDF')
      .replaceAll('(主网页 RPC|备用网页 RPC)', '主网页 RPC')
      .replaceAll('[：:]\\s*', '：')
      .replaceAll('([^：]+)', 'https://example.test/model.onnx')
      .replaceAll('([A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural)', 'en-US-AvaNeural')
      .replaceAll('(.+)', 'Zeta')
      .replaceAll('(.*)', 'Zeta')
      .replace(/\\([().*])/gu, '$1');
    for (const locale of locales) {
      const early = createLegacyPatternSet(locale).early.map(([pattern]) => new RegExp(pattern, 'u'));
      for (const {pattern, localizedCaptures, messages} of runtimeFeedbackPatterns) {
        const sample = sampleOf(pattern);
        expect(early.findIndex((candidate) => candidate.test(sample)), `${locale} ${sample}`).toBe(early.findIndex((candidate) => candidate.source === new RegExp(pattern, 'u').source));
        const captures = new RegExp(pattern, 'u').exec(sample)!;
        const translated = translateLegacyText(sample, locale);
        expect(translated, `${locale} ${sample}`).toBe(messages[locale]!.replace(/\{(\d+)\}/gu, (_, index: string) => (
          localizedCaptures.includes(Number(index)) ? translateLegacyText(captures[Number(index)], locale) : captures[Number(index)]
        )));
        expect(translated).not.toMatch(/\{\d+\}/u);
        if (locale !== 'ja-JP') expect(translated, `${locale} ${sample}`).not.toMatch(han);
      }
    }
    expect(translateLegacyText('在线 TTS 和本地 TTS 均失败：网络请求失败；本地 TTS 模型缓存不完整', 'fr-FR'))
      .toBe('Les voix en ligne et locale ont toutes deux échoué : La requête réseau a échoué ; Le cache du modèle vocal local est incomplet');
    expect(translateLegacyText('图片翻译失败：Offscreen 文档准备超时', 'en-US')).toBe('Image translation failed: Preparing the offscreen document timed out');
    expect(translateLegacyText('谷歌翻译所有匿名接口均失败：主网页 RPC: 请求超时（10 秒）；备用网页 RPC: 返回格式异常', 'es-ES'))
      .toBe('Fallaron todos los endpoints anónimos de Google Translate: RPC web principal: La solicitud agotó el tiempo de espera (10 s); RPC web de respaldo: Formato de respuesta inesperado');
  });
});

// 机器补齐的旧译文会人工校正；校正层必须对应仍在使用的界面原文，并在最终资源包中生效。
describe('旧界面译文人工校正', () => {
  const availableServiceOptions = options.services.filter((option) => !option.disabled);
  const unavailableServiceKey = 'quickTranslation.serviceUnavailable';

  it('不可用服务提示由七语键和完整服务目录生成，并保留本地化服务名称', () => {
    const catalogs = { 'zh-CN': zhCNMessages, 'en-US': enUSMessages, 'ja-JP': jaJPMessages,
      'ko-KR': koKRMessages, 'fr-FR': frFRMessages, 'ru-RU': ruRUMessages, 'es-ES': esESMessages };
    for (const {value: locale} of UI_LANGUAGE_OPTIONS) {
      const template = catalogs[locale][unavailableServiceKey];
      expect(template, locale).toBeTruthy();
      expect([...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]), locale).toEqual(['service']);
      for (const option of availableServiceOptions) {
        const label = translateServiceLabel(option.label, locale) ?? translateLegacyText(option.label, locale);
        const message = translate(unavailableServiceKey, locale, {service: label});
        expect(message, `${locale} ${option.value}`).toContain(label);
        expect(message, `${locale} ${option.value}`).not.toContain('{service}');
        expect(message, `${locale} ${option.value}`).not.toBe(label);
        if (locale !== 'zh-CN' && locale !== 'ja-JP') expect(message, `${locale} ${option.value}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });

  it('校正原文仍在界面源码中使用，不重复，并覆盖此前的译文', () => {
    const sourceText = collectSourceText('src', (path) => !path.includes('/i18n/messages/'));
    // QuickTranslationProfiles 将目录名称传给 key 化提示；完整句没有对应的源码字面量。
    // 从真实 key 与完整目录登记合成文案，而不是把校正字典本身当成使用证据。
    const generatedServiceSources = availableServiceOptions.map((option) => (
      translate(unavailableServiceKey, 'zh-CN', {service: option.label})
    ));
    const generatedSourceText = generatedServiceSources.join('\n');
    const sources = [...correctionRows, ...siteRuleTextRows].map(row => row[0]);
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources.filter((source) => !sourceText.includes(source) && !generatedSourceText.includes(source))).toEqual([]);
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      const catalog = createLegacyCorrectionText(locale);
      for (const source of sources) {
        expect(translateLegacyText(source, locale), `${locale} ${source}`).toBe(catalog[source]);
        if (locale !== 'ja-JP') expect(catalog[source], `${locale} ${source}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });
});

it('共享图片识别选择与下载提示在六种非中文界面有本地化文案', () => {
  const sources = ['图片识别方式', 'Tesseract（轻量模型）', 'PaddleOCR（标准模型）', '入口与缓存', '识别资源与下载', '正在准备图片识别模型…', 'PaddleOCR 文字识别', '悬停图片或右键翻译，随时对照原图。', '适合截图、图表与清晰排版文字。按原文语言准备语言包。', '适合普通图片、截图和漫画文字。首次翻译下载约 30 MB，与漫画共用，已下载无需重复下载。', '使用 PaddleOCR，当前页优先，只提前处理已加载的图片。', '图片文字识别', '识别普通图片与漫画中的文字'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
    for (const source of sources) expect(translateLegacyText(source, locale), `${locale} ${source}`).not.toBe(source);
    expect(translateLegacyText(sources[9], locale)).toContain('30 MB');
    expect(translateLegacyText(sources[2], locale)).toContain('PaddleOCR');
  }
});

import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';
it('localizes word-class labels and learning explanations from the shared registry', () => {
    for (const id of ['noun','verb','adjective','adverb','article','determiner','pronoun','preposition','conjunction','auxiliary','interjection','numeral','phrase','']) {
        const part = describePartOfSpeech(id);
        for (const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES'] as const) {
            expect(translateLegacyText(part.label, language)).not.toBe(part.label);
            expect(translateLegacyText(part.description, language)).not.toBe(part.description);
        }
    }
});

it('中文展示使用流畅阅读，首启七语品牌与正式目录一致并保留外部身份和技术路径', () => {
    const localizedKeys = [
        'settings.backup.restoreHint', 'options.userscriptUnavailableDescription', 'glossary.builtin.source',
        'language.settingsDescription', 'language.onboardingWelcomeTitle', 'language.onboardingDescription',
        'language.onboardingSuccessDescription', 'video.panelAriaLabel', 'video.translationOverlayAriaLabel',
        'video.buttonAriaLabel', 'video.globalDisabled', 'metadata.optionsTitle', 'metadata.popupTitle',
        'metadata.documentTitle', 'document.fileLimitNote', 'options.aboutThanks', 'popup.donationTitle',
        'shareCard.showBrand', 'learning.collection.fileReadFailed', 'settings.cloud.privacyWebDavStorage',
    ];
    for (const key of localizedKeys) {
        expect(translate(key, 'zh-CN'), key).toContain('流畅阅读');
        expect(translate(key, 'zh-CN'), key).not.toContain('FluentRead');
    }
    expect(translate('options.userscriptUnavailableDescription', 'zh-CN')).toBe('此功能需要浏览器扩展的运行环境。请安装流畅阅读浏览器扩展后使用。');
    expect(translate('metadata.optionsTitle', 'zh-CN')).toBe('流畅阅读 · 设置');
    expect(translate('metadata.popupTitle', 'zh-CN')).toBe('流畅阅读');
    expect(translate('metadata.documentTitle', 'zh-CN')).toBe('流畅阅读 · 文档翻译');
    expect(translate('settings.cloud.deleteManualDrive', 'zh-CN')).toBe('请前往 Google Drive 设置 → 管理应用 → FluentRead，清理该应用的数据。');
    expect(translate('settings.cloud.deleteManualWebDav', 'zh-CN')).toBe('请在 WebDAV 服务商页面手动删除 FluentRead/fluentread-config.encrypted.json，保留目录内其他文件。');
    for (const {value} of UI_LANGUAGE_OPTIONS) {
        expect(onboardingMessages.onboardingProductNames[value], value).toBe(translate('common.brand', value));
        expect(translate('common.brand', value)).toBe(value === 'zh-CN' ? '流畅阅读' : 'FluentRead');
        expect(translateLegacyText(translate('video.panelAriaLabel', 'zh-CN'), value), value).toBe(translate('video.panelAriaLabel', value));
    }
    expect(translateLegacyText('用户输入 FluentRead', 'zh-CN')).toBe('用户输入 FluentRead');
});


// 保留上方全部 i18n owner；仅补充源码审计对显式只读 locale 字面量表的边界。
describe('源码审计的只读本地语言表', () => {
  const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'];
  const importType = "import type {UiLanguage} from '@/src/core/i18n/language';";
  const entries = "'zh-CN': '清空', 'en-US': 'Clear', 'ja-JP': 'クリア', 'ko-KR': '초기화', 'fr-FR': 'Effacer', 'ru-RU': 'Очистить', 'es-ES': 'Despejar'";
  const table = `{${entries}}`;
  const readonlyType = 'Readonly<Record<UiLanguage, string>>';
  const standard = `const labels = ${table} as const satisfies ${readonlyType};`;
  async function auditFixture(script: string, template = '<div title="模板提示">模板正文</div>') {
    const {mkdtempSync, mkdirSync, writeFileSync, rmSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const {dirname} = await import('node:path');
    const {collectUiSourceCopy} = await import('../scripts/testing/i18n-source-audit.mjs');
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'fluentread-localized-source-audit-'));
    try {
      mkdirSync(join(fixtureRoot, 'src'), {recursive: true});
      writeFileSync(join(fixtureRoot, 'src/Fixture.vue'), `<template>${template}</template><script setup lang="ts">${script}</script>`);
      for (const relative of [
        'src/features/settings/model/navigation.ts', 'src/features/document-translation/ui/presentation.ts',
        'src/core/config/interfaceAppearance.ts', 'src/core/config/translationLoadingStyle.ts',
        'src/core/config/translationAppearance.ts', 'src/core/config/writingPreview.ts',
        'src/core/config/videoSubtitleAppearance.ts', 'src/core/config/harness.ts', 'src/core/config/diff.ts',
        'src/features/image-translation/content/controls.ts', 'src/features/video-subtitle/transcription.ts',
      ]) {
        const file = join(fixtureRoot, relative); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, '');
      }
      return collectUiSourceCopy(fixtureRoot);
    } finally {rmSync(fixtureRoot, {recursive: true, force: true});}
  }
  const accepted = [
    ['as const satisfies Readonly', `${importType}${standard}`],
    ['as const satisfies Record', `${importType}const labels = ${table} as const satisfies Record<UiLanguage, string>;`],
    ['Readonly variable annotation', `${importType}const labels: ${readonlyType} = ${table};`],
    ['canonical aliased types import', `import type {UiLanguage as DisplayLanguage} from '@/src/core/i18n/types';const labels = ${table} as const satisfies Record<DisplayLanguage, string>;`],
    ['canonical root import', `import type {UiLanguage} from '@/src/core/i18n';${standard}`],
    ['relative canonical import and Japanese kanji', `import type {UiLanguage} from './core/i18n/language';${standard.replace("'クリア'", "'消去'")}`],
  ];
  it.each(accepted)('%s 直接核完整七语且保留其他脚本与模板文案', async (_name, source) => {
    expect(UI_LANGUAGE_OPTIONS.map(option => option.value)).toEqual(locales);
    const audit = await auditFixture(`${source}const unrelated = '普通文案';`);
    expect(audit.sources.map(item => item.source).sort()).toEqual(['普通文案', '模板正文', '模板提示'].sort());
    expect(audit.files).toContain('src/Fixture.vue');
  });
  const rejected = [
    ['missing locale', standard.replace("'en-US': 'Clear', ", '')],
    ['duplicate locale', standard.replace("'es-ES': 'Despejar'", "'en-US': 'Another clear'")],
    ['extra locale', standard.replace(table, `{${entries}, 'de-DE': 'Leeren'}`)],
    ['spread', standard.replace(table, `{...otherLabels, ${entries}}`)],
    ['dynamic value', standard.replace("'en-US': 'Clear'", "'en-US': currentEnglish")],
    ['blank value', standard.replace("'en-US': 'Clear'", "'en-US': '   '")],
    ['foreign Chinese', standard.replace("'en-US': 'Clear'", "'en-US': '清空'")],
    ['computed locale key', standard.replace("'en-US':", "['en-US']:")],
    ['untyped map', `const labels = ${table};`],
    ['satisfies without as const', standard.replace(' as const', '')],
    ['mutable Record annotation', `const labels: Record<UiLanguage, string> = ${table};`],
    ['mutable annotation despite as const', `const labels: Record<UiLanguage, string> = ${table} as const satisfies ${readonlyType};`],
    ['let despite Readonly annotation', `let labels: ${readonlyType} = ${table};`],
    ['await using is not const', `await using labels: ${readonlyType} = ${table};`],
    ['Readonly assertion instead of const', `const labels = ${table} as ${readonlyType};`],
    ['nested same-name type shadow', `function nested() {type UiLanguage = string;${standard}}`],
    ['top-level same-name type shadow', `type UiLanguage = string;${standard}`],
    ['Readonly utility shadow', `type Readonly<T> = T;${standard}`],
  ];
  it.each(rejected)('%s 保守保留中文来源供原有本地化审计', async (_name, source) => {
    const audit = await auditFixture(`${importType}${source}`);
    expect(audit.sources.map(item => item.source)).toContain('清空');
  });
  it.each([
    ['fake local UiLanguage', `type UiLanguage = string;${standard}`],
    ['foreign module UiLanguage', `import type {UiLanguage} from './fake-language';${standard}`],
    ['wrong canonical export alias', `import type {OtherLanguage as UiLanguage} from '@/src/core/i18n/types';${standard}`],
    ['canonical import shadows Record', `import type {UiLanguage as Record} from '@/src/core/i18n/language';const labels = ${table} as const satisfies Record<Record, string>;`],
    ['canonical import shadows Readonly', `import type {UiLanguage as Readonly} from '@/src/core/i18n/language';const labels = ${table} as const satisfies Readonly<Record<Readonly, string>>;`],
  ])('%s 不靠同名类型豁免原有中文', async (_name, source) => {
    const audit = await auditFixture(source);
    expect(audit.sources.map(item => item.source)).toContain('清空');
  });
  it('完整表之外同字脚本与模板仍收集，不按字串或文件豁免', async () => {
    const audit = await auditFixture(`${importType}${standard}const rawLabel = '清空';`, '<button title="清空">清空</button>');
    expect(audit.sources.find(item => item.source === '清空')?.files).toEqual(['src/Fixture.vue']);
  });
});


describe('legacy compound whitespace boundaries', () => {
  it('preserves blank compound segments while translating their registered neighbors', () => {
    registerUiLanguageBundle('en-US', {messages: {}, legacyText: {'前': 'Before', '后': 'After'}, legacyPatterns: {early: [], late: []}});
    try {
      expect(translateLegacyText('前 ·  · 后', 'en-US')).toBe('Before ·  · After');
      expect(translateLegacyText(' \t前\n', 'en-US')).toBe(' \tBefore\n');
    } finally {registerAllUiLanguageBundles();}
  });
});
