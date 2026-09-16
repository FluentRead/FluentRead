import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createLegacyPatternSet, localizedLegacyPatterns} from '@/src/core/i18n/messages/legacy-patterns';
import {createRuntimeFeedbackLegacyText, getRuntimeFeedbackSources} from '@/src/core/i18n/messages/runtime-feedback';
import {createLegacyCorrectionText, getLegacyCorrectionSources} from '@/src/core/i18n/messages/legacy-corrections';
import {runtimeFeedbackPatterns} from '@/src/core/i18n/messages/runtime-feedback-patterns';

import {
  DEFAULT_UI_LANGUAGE,
  getUiLanguageBilingualLabel,
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
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';

// 扩展运行时按需加载界面语言；本文件验证全部语言的文案契约，因此一次注册全部资源包。
registerAllUiLanguageBundles();

describe('界面 i18n 契约', () => {
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
      'Chinese', 'English', 'Japanese', 'Korean', 'French', 'Russian', 'Spanish',
    ]);
    expect(UI_LANGUAGE_OPTIONS.map((item) => getUiLanguageBilingualLabel(item.value))).toEqual([
      '中文 / Chinese',
      '英语 / English',
      '日语 / Japanese',
      '韩语 / Korean',
      '法语 / French',
      '俄语 / Russian',
      '西班牙语 / Spanish',
    ]);
    expect(getUiLanguageDisplayLabel('ja-JP', 'es-ES')).toBe('Japonés / Japanese / 日本語');
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

  it('用稳定 key 完整本地化快捷翻译方案及其动态提示', () => {
    const cases: Array<{key: string; params?: Record<string, string | number>}> = [
      {key: 'quickTranslation.heading.hover'},
      {key: 'quickTranslation.heading.fullPage'},
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
      for (const key of ['learning.saved', 'learning.history', 'learning.content', 'learning.retention', 'learning.memory', 'learning.memoryAdd', 'learning.memoryDisabled', 'learning.memoryClearConfirm', 'settings.memoryEnabled', 'settings.memoryDescription']) {
        expect(translate(key, language)).not.toBe(translate(key, 'zh-CN'));
        expect(translate(key, language)).not.toBe(key);
      }
    }
    expect(translate('learning.saved', 'zh-CN')).toBe('收藏');
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
      '从效率布局、趣味配色到夜间和护眼方案，选择适合自己的界面；也可以只留下常用栏目。',
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
    expect(translateLegacyText('奶酪 🧀', 'en-US')).toBe('Cheese 🧀');
    expect(translateLegacyText('夜幕 🌙', 'ja-JP')).toBe('ミッドナイト 🌙');
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
    const missing: string[] = [];
    for (const {source, files} of audit.sources) {
      if (examples.has(source)) continue;
      for (const locale of ['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
        const result = translateLegacyText(source, locale);
        if (/[\u3400-\u9fff]/u.test(result)) missing.push(`${locale} ${files.join(', ')}: ${source}`);
      }
    }
    expect(audit.files.length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
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
      'translationStats.filter.service', 'translationStats.source.network', 'translationStats.log.image', 'translationStats.routes.column.route', ...videoOriginalLabels]);
    const spanishCognates = new Set(videoOriginalLabels);
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
    const sourceText = collectSourceText('src', (path) => !path.includes('/i18n/messages/'));
    const sources = getRuntimeFeedbackSources();
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
      .replaceAll('(主网页 RPC|备用网页 RPC|旧版 gtx 接口)', '主网页 RPC')
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
    expect(translateLegacyText('谷歌翻译所有匿名接口均失败：主网页 RPC: 请求超时（10 秒）；旧版 gtx 接口: 返回格式异常', 'es-ES'))
      .toBe('Fallaron todos los endpoints anónimos de Google Translate: RPC web principal: La solicitud agotó el tiempo de espera (10 s); Endpoint gtx antiguo: Formato de respuesta inesperado');
  });
});

// 机器补齐的旧译文会人工校正；校正层必须对应仍在使用的界面原文，并在最终资源包中生效。
describe('旧界面译文人工校正', () => {
  it('校正原文仍在界面源码中使用，不重复，并覆盖此前的译文', () => {
    const sourceText = collectSourceText('src', (path) => !path.includes('/i18n/messages/'));
    const sources = getLegacyCorrectionSources();
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources.filter((source) => !sourceText.includes(source))).toEqual([]);
    for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      const catalog = createLegacyCorrectionText(locale);
      for (const source of sources) {
        expect(translateLegacyText(source, locale), `${locale} ${source}`).toBe(catalog[source]);
        if (locale !== 'ja-JP') expect(catalog[source], `${locale} ${source}`).not.toMatch(/[\u3400-\u9fff]/u);
      }
    }
  });
});
