import { describe, expect, it, vi } from 'vitest'
import { getHarnessModelCacheKey, getHarnessRequestConfigKey, resolveHarnessModel, HARNESS_ACTIONS, DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH, isHarnessService, isReadingService, isReadingActionSupported, isReadingFollowUpSupported, normalizeHarnessPreferences } from '@/src/core/config/harness'
import {UI_LANGUAGE_OPTIONS} from '@/src/core/i18n/language'
import {getDefaultHarnessPrompt, resolveHarnessPrompt, renderHarnessPrompt} from '@/src/core/harness/prompts'
import {type HarnessPromptKind} from '@/src/core/harness/promptDefaults'
import { Config, normalizeConfig } from '@/src/core/config/model'
import {getApiKeyRequirementKey, isApiKeyRequired} from '@/src/core/config/validation'
import {customModelString, services, servicesType} from '@/src/core/config/catalog'
import {BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation'

describe('Harness config contract', () => {
  it('纯配置默认值与规范化不初始化多语言提示词数据或 resolver', async () => {
    const locales = vi.fn(() => {throw new Error('pure configuration initialized locale prompts');});
    const resolver = vi.fn(() => {throw new Error('pure configuration initialized prompt resolver');});
    vi.resetModules();
    vi.doMock('@/src/core/harness/promptLocales', locales);
    vi.doMock('@/src/core/harness/prompts', resolver);
    try {
      const {Config, normalizeConfig} = await import('@/src/core/config/model');
      expect(new Config().harness.systemPrompt).toBe(DEFAULT_HARNESS_SYSTEM_PROMPT);
      const normalized = normalizeConfig({uiLanguage: 'en-US', harness: {systemPrompt: '', actionPrompts: {meaning: '  custom {{to}}  ', grammar: ''}}});
      expect(normalized.harness).toMatchObject({systemPrompt: '', actionPrompts: {meaning: '  custom {{to}}  ', grammar: '', usage: DEFAULT_HARNESS_ACTION_PROMPTS.usage}});
      expect(locales).not.toHaveBeenCalled();expect(resolver).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@/src/core/harness/promptLocales');vi.doUnmock('@/src/core/harness/prompts');vi.resetModules();
    }
  });

  it('defaults to quiet dismissal while preserving an explicit opt-out and trigger choice', () => {
    expect(new Config().selectionTranslatorAutoDismiss).toBe(true);
    for (const value of [undefined, null, 'false', 0, true]) {
      expect(normalizeConfig({selectionTranslatorAutoDismiss: value}).selectionTranslatorAutoDismiss).toBe(true);
    }
    expect(normalizeConfig({selectionTranslatorAutoDismiss: false, selectionTranslatorTrigger: 'direct'})).toMatchObject({
      selectionTranslatorAutoDismiss: false, selectionTranslatorTrigger: 'direct',
    });
  });
  it('preserves opt-in triggers and falls back safely for legacy or malformed settings', () => {
    expect(normalizeHarnessPreferences({})).toMatchObject({trigger: 'click', customHotkey: 'Alt+R', hoverDelay: 600});
    expect(normalizeHarnessPreferences({trigger: 'shortcut', customHotkey: ' Ctrl+Shift+R ', hoverDelay: 875.4})).toMatchObject({trigger: 'shortcut', customHotkey: 'Ctrl+Shift+R', hoverDelay: 875});
    expect(normalizeHarnessPreferences({trigger: 'hover', customHotkey: 'r', hoverDelay: 0})).toMatchObject({trigger: 'hover', customHotkey: 'Alt+R', hoverDelay: 200});
    for (const hoverDelay of [undefined, null, '500', NaN, Infinity]) {
      expect(normalizeHarnessPreferences({trigger: 'invalid', customHotkey: null, hoverDelay})).toMatchObject({trigger: 'click', customHotkey: 'Alt+R', hoverDelay: 600});
    }
    expect(normalizeHarnessPreferences({hoverDelay: 9999}).hoverDelay).toBe(3000);
  });

  it('keeps the feature disabled and follows the active service by default', () => {
    const config = new Config()
    expect(config.harness).toMatchObject({
      enabled: false,
      memoryEnabled: false,
      service: '',
      model: '',
      defaultAction: 'meaning',
      contextMode: 'paragraph',
      maxContextChars: 1500,
      explanationDepth: 'concise',
      learningLevel: 'intermediate',
    })
    expect(config.harness.actions).toEqual(HARNESS_ACTIONS.map((action) => action.id))
  })

  it('normalizes action whitelist, bounds, enums and arbitrary model names', () => {
    const harness = normalizeHarnessPreferences({
      enabled: 1,
      service: '  openai  ',
      model: `  ${'x'.repeat(200)}  `,
      defaultAction: 'unknown',
      actions: ['practice', 'practice', 'unknown', 'grammar'],
      contextMode: 'bad',
      maxContextChars: 99999,
      explanationDepth: 'bad',
      learningLevel: 'bad',
    })
    expect(harness).toMatchObject({
      enabled: false,
      service: 'openai',
      model: 'x'.repeat(128),
      defaultAction: 'meaning',
      actions: ['meaning', 'practice', 'grammar'],
      contextMode: 'paragraph',
      maxContextChars: 4000,
      explanationDepth: 'concise',
      learningLevel: 'intermediate',
    })
  })

  it('adds the nested field when normalizing legacy config', () => {
    const config = normalizeConfig({ service: 'openai' })
    expect(config.harness.enabled).toBe(false)
    expect(config.harness.actions).toContain('meaning')
    expect(config.harness.memoryEnabled).toBe(false)
    expect(normalizeHarnessPreferences({memoryEnabled: true}).memoryEnabled).toBe(true)
    expect(normalizeHarnessPreferences({memoryEnabled: 'true'}).memoryEnabled).toBe(false)
  })

  it('accepts only gateway-supported services and configured custom providers', () => {
    expect(isHarnessService('openai')).toBe(true)
    expect(isHarnessService('gemini')).toBe(true)
    expect(isHarnessService('claude')).toBe(true)
    expect(isHarnessService('google')).toBe(false)
    expect(isHarnessService('custom:study')).toBe(false)
    expect(isHarnessService('custom:study', [{ id: 'custom:study', name: 'Study', endpoint: '', models: ['study'] }])).toBe(true)
  })

  it('accepts anonymous B站 reading without changing translation classification or opt-in defaults', () => {
    expect(isReadingService(services.bilibili)).toBe(true)
    expect(isHarnessService(services.bilibili)).toBe(false)
    expect(isReadingService(services.openai)).toBe(true)
    expect(isReadingService(services.microsoft)).toBe(false)
    expect(isReadingService('custom:study')).toBe(false)
    expect(isReadingService('custom:study', [{id: 'custom:study', name: 'Study', endpoint: '', models: ['study']}])).toBe(true)
    expect(servicesType.isAI(services.bilibili)).toBe(false)
    expect(servicesType.isMachine(services.bilibili)).toBe(true)
    expect(normalizeHarnessPreferences({service: ` ${services.bilibili} `})).toMatchObject({enabled: false, service: services.bilibili})
    expect(normalizeConfig({harness: {service: services.bilibili}}).harness).toMatchObject({enabled: false, service: services.bilibili})
  })

  it('limits B站 to verified basic actions and preserves full AI actions and follow-ups', () => {
    expect(HARNESS_ACTIONS.filter(({id}) => isReadingActionSupported(services.bilibili, id)).map(({id}) => id)).toEqual(['meaning', 'usage'])
    expect(isReadingFollowUpSupported(services.bilibili)).toBe(false)
    const provider = {id: 'custom:study', name: 'Study', endpoint: 'https://example.test/v1/chat/completions', models: ['reader']}
    for (const service of [services.openai, services.gemini, services.claude, provider.id]) {
      expect(isHarnessService(service, [provider])).toBe(true)
      expect(HARNESS_ACTIONS.every(({id}) => isReadingActionSupported(service, id))).toBe(true)
      expect(isReadingFollowUpSupported(service)).toBe(true)
    }
  })

  it('keeps B站 reading eligibility out of persisted writing configuration', () => {
    const config = normalizeConfig({harness: {service: services.bilibili}, writing: {service: services.bilibili, model: 'unused'}})
    expect(config.harness.service).toBe(services.bilibili)
    expect(config.writing.service).toBe('')
    expect(isHarnessService(services.bilibili)).toBe(false)
  })

  it('resolves the fixed anonymous model and preserves ordinary inherited, custom and overridden models', () => {
    const config = new Config()
    config.service = services.bilibili
    config.harness.model = 'unused-override'
    config.model.bilibili = 'unused-service-model'
    config.customModel.bilibili = 'unused-custom-model'
    expect(resolveHarnessModel(config)).toEqual({service: services.bilibili, model: BILIBILI_FREE_TRANSLATION_MODEL})
    config.harness.service = services.bilibili; config.service = services.openai
    expect(resolveHarnessModel(config)).toEqual({service: services.bilibili, model: BILIBILI_FREE_TRANSLATION_MODEL})
    config.harness.service = ''; config.harness.model = ''; config.model.openai = 'inherited-reader'
    expect(resolveHarnessModel(config)).toEqual({service: services.openai, model: 'inherited-reader'})
    config.model.openai = customModelString; config.customModel.openai = 'custom-reader'
    expect(resolveHarnessModel(config)).toEqual({service: services.openai, model: 'custom-reader'})
    config.harness.service = services.deepseek; config.harness.model = 'specific-reader'
    expect(resolveHarnessModel(config)).toEqual({service: services.deepseek, model: 'specific-reader'})
  })

  it('preserves the supported advanced learning level', () => {
    expect(normalizeHarnessPreferences({ learningLevel: 'advanced' }).learningLevel).toBe('advanced')
  })

  it('covers selection context, detailed output and invalid service bounds', () => {
    expect(isHarnessService('x'.repeat(129))).toBe(false)
    expect(normalizeHarnessPreferences({ contextMode: 'selection', explanationDepth: 'detailed', maxContextChars: 2000 })).toMatchObject({
      contextMode: 'selection', explanationDepth: 'detailed', maxContextChars: 2000,
    })
  })
  it('normalizes custom providers before accepting their Harness selection', () => {
    const provider = {id: 'custom:study', name: 'Study', endpoint: 'https://example.test/v1/chat/completions', models: ['reader']}
    const config = normalizeConfig({customOpenAIProviders: [null, provider], harness: {enabled: true, service: 'custom:study', model: 'reader'}})
    expect(config.harness.service).toBe('custom:study')
    expect(normalizeConfig({customOpenAIProviders: 'broken', harness: {service: 'custom:study'}}).harness.service).toBe('')
  })

  it('keeps editable nested preferences separate from the persistence baseline', () => {
    const baseline = new Config()
    const edited = normalizeConfig(baseline)
    edited.harness.enabled = true
    edited.harness.contextMode = 'selection'
    edited.harness.actions.pop()
    expect(baseline.harness.enabled).toBe(false)
    expect(baseline.harness.contextMode).toBe('paragraph')
    expect(baseline.harness.actions).toHaveLength(4)
  })

})


describe('翻译卡片提示词配置', () => {
  it('默认数据边界保留空白和自定义正文，系统与各动作只按4000字符截断', () => {
    for (const value of ['', ' \n\t ', '  custom {{to}} {{unknown}}  ', '😀'.repeat(1999), 'x'.repeat(3999), 'x'.repeat(4000), 'x'.repeat(4001)]) {
      const expected = value.slice(0, HARNESS_PROMPT_MAX_LENGTH);
      const actionPrompts = Object.fromEntries(HARNESS_ACTIONS.map(({id}) => [id, value]));
      for (const preferences of [normalizeHarnessPreferences({systemPrompt: value, actionPrompts}), normalizeConfig({harness: {systemPrompt: value, actionPrompts}}).harness]) {
        expect(preferences.systemPrompt).toBe(expected);
        for (const {id} of HARNESS_ACTIONS) expect(preferences.actionPrompts[id]).toBe(expected);
      }
    }
  });

  it('旧配置使用实际默认提示词，非法类型回退且动作白名单和长度限制生效', () => {
    for (const actionPrompts of [undefined, null, [], false, 'bad']) {
      expect(normalizeHarnessPreferences({systemPrompt: 123, actionPrompts})).toMatchObject({systemPrompt: DEFAULT_HARNESS_SYSTEM_PROMPT, actionPrompts: DEFAULT_HARNESS_ACTION_PROMPTS});
    }
    const prefs = normalizeHarnessPreferences({systemPrompt: '', actionPrompts: {meaning: ' x ', grammar: 1, usage: 'z'.repeat(5000), practice: '', unknown: 'bad'}});
    expect(prefs.systemPrompt).toBe('');
    expect(prefs.actionPrompts).toEqual({meaning: ' x ', grammar: DEFAULT_HARNESS_ACTION_PROMPTS.grammar, usage: 'z'.repeat(HARNESS_PROMPT_MAX_LENGTH), practice: ''});
    prefs.actionPrompts.grammar = 'edited';
    expect(normalizeHarnessPreferences({}).actionPrompts.grammar).toBe(DEFAULT_HARNESS_ACTION_PROMPTS.grammar);
  });
  it('占位符只替换登记变量，不递归解析替换值、不执行表达式', () => {
    expect(renderHarnessPrompt('{{to}} {{to}} {{learningLevel}} {{explanationDepth}} {{unknown}} {{constructor}}', {to: '{{learningLevel}}', learningLevel: 'beginner', explanationDepth: 'concise'}))
      .toBe('{{learningLevel}} {{learningLevel}} beginner concise {{unknown}} {{constructor}}');
  });
});


describe('localized Harness defaults', () => {
  const kinds: HarnessPromptKind[] = ['system', ...HARNESS_ACTIONS.map(action => action.id)]
  it.each(UI_LANGUAGE_OPTIONS)('provides all five templates in $value and preserves placeholders', ({value: locale}) => {
    for (const kind of kinds) {
      const template = getDefaultHarnessPrompt(kind, locale)
      expect(template.length).toBeGreaterThan(50)
      expect(template.length).toBeLessThanOrEqual(HARNESS_PROMPT_MAX_LENGTH)
      if (kind === 'system') {
        expect(template.match(/\{\{[^}]+\}\}/gu)?.sort()).toEqual(['{{to}}', '{{learningLevel}}', '{{explanationDepth}}'].sort())
      } else expect(template).toContain('### ')
      for (const {value: previous} of UI_LANGUAGE_OPTIONS) {
        expect(resolveHarnessPrompt(getDefaultHarnessPrompt(kind, previous), kind, locale)).toBe(template)
      }
      expect(resolveHarnessPrompt('', kind, locale)).toBe(template)
      expect(resolveHarnessPrompt(' \n ', kind, locale)).toBe(template)
      const custom = '  自定义 / My prompt / 私の指示 {{to}} {{unknown}}  '
      expect(resolveHarnessPrompt(custom, kind, locale)).toBe(custom)
      expect(resolveHarnessPrompt(template + ' ', kind, locale)).toBe(template + ' ')
    }
  })
  it('retains original Chinese defaults and safely resolves unknown languages', () => {
    expect(getDefaultHarnessPrompt('system', undefined)).toBe(DEFAULT_HARNESS_SYSTEM_PROMPT)
    for (const {id} of HARNESS_ACTIONS) expect(getDefaultHarnessPrompt(id, 'unknown')).toBe(DEFAULT_HARNESS_ACTION_PROMPTS[id])
    for (const kind of kinds) expect(new Set(UI_LANGUAGE_OPTIONS.map(({value}) => getDefaultHarnessPrompt(kind, value))).size).toBe(8)
  })
})

describe('reading model cache identity', () => {
  it('keeps B站 answers when editing unused credentials, endpoints or model fields', () => {
    const config = new Config(); config.harness.service = services.bilibili
    const original = getHarnessModelCacheKey(config)
    config.harness.model = 'ignored'; config.model.bilibili = 'ignored'; config.customModel.bilibili = 'ignored'
    config.token.bilibili = 'test-only-ignored'; config.proxy.bilibili = 'https://unused.test/v1'
    config.apiKeys.bilibili = ['test-only-unused']; config.apiKeyRotationEnabled.bilibili = false
    config.customHeaders.bilibili = '{"x-unused":"test"}'; config.service = services.openai
    config.custom = 'https://unused.test'; config.newApiUrl = 'https://unused.test'; config.azureOpenaiEndpoint = 'https://unused.test'
    config.deepseekApiType = 'responses'; config.customOpenAIProviders = [{id: 'custom:unused', name: 'Unused', endpoint: 'https://unused.test', models: ['unused']}]
    expect(getHarnessModelCacheKey(config)).toBe(original)
    config.uiLanguage = 'en-US'
    const translatedUi = getHarnessModelCacheKey(config); expect(translatedUi).not.toBe(original)
    config.on = !config.on; expect(getHarnessModelCacheKey(config)).not.toBe(translatedUi)
    config.harness.service = services.openai; expect(getHarnessModelCacheKey(config)).not.toBe(original)
  })
  it('does not access ignored anonymous credential and endpoint objects', () => {
    const config = new Config(); config.harness.service = services.bilibili
    for (const key of ['token', 'proxy', 'apiKeys', 'apiKeyRotationEnabled', 'customHeaders', 'customOpenAIProviders', 'modelThinking']) {
      Object.defineProperty(config, key, {get() {throw new Error(`unexpected read: ${key}`)}})
    }
    expect(() => getHarnessModelCacheKey(config)).not.toThrow()
  })
  it('ignores unrelated configuration notifications but tracks inherited and overridden model inputs', () => {
    const config = new Config();
    config.service = 'openai'; config.model.openai = 'reader';
    const original = getHarnessModelCacheKey(config);
    config.animations = !config.animations;
    config.token.deepseek = 'unrelated-token';
    expect(getHarnessModelCacheKey(config)).toBe(original);
    config.model.openai = 'new-reader';
    expect(getHarnessModelCacheKey(config)).not.toBe(original);
    config.harness.service = 'deepseek'; config.harness.model = 'fixed-reader';
    const fixed = getHarnessModelCacheKey(config);
    config.service = 'gemini'; config.model.deepseek = 'unused-default';
    expect(getHarnessModelCacheKey(config)).toBe(fixed);
    config.proxy.deepseek = 'https://example.test/v1';
    expect(getHarnessModelCacheKey(config)).not.toBe(fixed);
    const endpoint = getHarnessModelCacheKey(config);
    config.token.deepseek = 'changed-token';
    expect(getHarnessModelCacheKey(config)).not.toBe(endpoint);
  });
});

// 统一入口迁移必须是一次性的，不能在关闭划词后被旧学习开关重新开启。
describe('explicit learning request configuration identity', () => {
  it('retains request identity through unrelated notifications and identical normalized snapshots', () => {
    const config = new Config();
    const original = getHarnessRequestConfigKey(config);
    config.count += 1; config.theme = config.theme === 'dark' ? 'light' : 'dark';
    config.animations = !config.animations; config.glossaryEnabled = !config.glossaryEnabled;
    expect(getHarnessRequestConfigKey(config)).toBe(original);
    expect(getHarnessRequestConfigKey(normalizeConfig(config))).toBe(original);
  });

  const requestOnlyChanges: Array<[string, (config: Config) => void]> = [
    ['target language', config => {config.to = 'ja';}],
    ['learning preferences', config => {config.harness.learningLevel = 'advanced';}],
    ['credential recovery', config => {config.apiKeyRecoveryMs += 60000;}],
    ['credential requirement', config => {config.requireApiKey[getApiKeyRequirementKey('deepseek',config)] = false;}],
    ['request header rules', config => {config.requestHeaderRules = [{domain:'synthetic.test',removeOrigin:true,removeReferer:false}];}],
  ];
  it.each(requestOnlyChanges)('invalidates a %s change while preserving the existing model key scope', (name, change) => {
    const config = new Config(); config.service = 'deepseek';
    const original = getHarnessRequestConfigKey(config), modelKey = getHarnessModelCacheKey(config);
    if (name === 'credential requirement') expect(isApiKeyRequired('deepseek',config)).toBe(true);
    change(config);
    if (name === 'credential requirement') expect(isApiKeyRequired('deepseek',config)).toBe(false);
    expect(getHarnessRequestConfigKey(config)).not.toBe(original);
    expect(getHarnessModelCacheKey(config)).toBe(modelKey);
  });
});

describe('unified selection preferences', () => {
  it('uses one card presentation while preserving activation and legacy preferences', () => {
    expect(normalizeConfig({}).selectionTranslatorPresentation).toBe('card');
    expect(normalizeConfig({selectionTranslatorPresentation: 'simple'}).selectionTranslatorPresentation).toBe('card');
    expect(normalizeConfig({selectionTranslatorMode: 'translation-only'})).toMatchObject({selectionTranslatorPresentation: 'card', selectionTranslatorMode: 'translation-only'});
    const migrated = normalizeConfig({selectionTranslatorMode: 'disabled', harness: {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R', service: 'deepseek', model: 'custom-reader'}});
    expect(migrated).toMatchObject({selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false, selectionTranslatorPresentation: 'card', selectionTranslatorTrigger: 'custom', customSelectionTranslatorHotkey: 'Alt+R'});
    expect(migrated.harness).toMatchObject({service: 'deepseek', model: 'custom-reader'});
    expect(normalizeConfig({...migrated, selectionTranslatorMode: 'disabled'})).toMatchObject({selectionTranslatorMode: 'disabled', disableSelectionTranslator: true, harness: {enabled: true}});
  });
  it('migrates hover without overriding an existing selection shortcut', () => {
    expect(normalizeConfig({harness: {enabled: true, trigger: 'hover', hoverDelay: 950}})).toMatchObject({selectionTranslatorTrigger: 'hover', harness: {hoverDelay: 950}});
    expect(normalizeConfig({selectionTranslatorMode: 'bilingual', selectionTranslatorTrigger: 'Shift', harness: {enabled: true, trigger: 'shortcut', customHotkey: 'Alt+R'}}).selectionTranslatorTrigger).toBe('Shift');
    expect(normalizeConfig({selectionTranslatorPresentation: 'invalid', harness: {enabled: true}}).selectionTranslatorMode).toBe('disabled');
    expect(normalizeConfig({selectionTranslatorPresentation: 'simple', selectionTranslatorTrigger: 'hover'}).selectionTranslatorTrigger).toBe('hover');
  });
  it('updates exact built-in grammar prompts but retains custom instructions', () => {
    const template = getDefaultHarnessPrompt('grammar', 'en-US');
    expect(template).toContain('Text | POS | Role | Meaning');
    const old = template.split('\n\nFor grammar analysis')[0];
    expect(resolveHarnessPrompt(old, 'grammar', 'en-US')).toBe(template);
    expect(resolveHarnessPrompt('My grammar instructions', 'grammar', 'zh-CN')).toBe('My grammar instructions');
  });
});

it('groups meaningful phrases in the built-in grammar prompt and upgrades only exact old defaults', () => {
  const current = getDefaultHarnessPrompt('grammar', 'zh-CN');
  expect(current).toContain('Group the sentence into meaningful, contiguous syntactic units');
  expect(current).toContain('infinitive phrase');
  expect(current).toContain('never invent a full sentence or a subject');
  const oldFormat = '\n\nFor grammar analysis, after the backbone explanation include one compact Markdown table with exactly these four headers: Text | POS | Role | Meaning. Each Text cell must quote a contiguous fragment from the selection verbatim, in source order. Never add invented words or reuse overlapping fragments. Use common English POS codes (article, noun, verb, adjective, adverb, pronoun, preposition, conjunction, determiner, auxiliary, numeral, phrase); distinguish part of speech from syntactic role such as subject or object. Write Role and Meaning in the requested target language. Include articles and other function words for a short sentence; for long selections use at most 40 meaningful fragments. If uncertain, use unknown rather than inventing a classification. The four fixed headers are a rendering contract; all explanatory content follows the target language. This compact table is allowed even when large tables are discouraged.';
  for (const {value: locale} of UI_LANGUAGE_OPTIONS) {
    const next = getDefaultHarnessPrompt('grammar', locale);
    const body = next.slice(0, next.indexOf('\n\nFor grammar analysis'));
    expect(resolveHarnessPrompt(body + oldFormat, 'grammar', locale)).toBe(next);
    expect(resolveHarnessPrompt('My custom instructions' + oldFormat, 'grammar', locale)).toBe('My custom instructions' + oldFormat);
  }
});

describe('旧中文品牌系统默认提示词兼容', () => {
  // 5d4fb542 中完整的中文系统默认正文；固定旧输入，避免随当前默认文案一起改变。
  const oldSystemPrompt = [
    '你是 FluentRead 阅读学习助手。',
    '学习者水平：{{learningLevel}}。回答深度：{{explanationDepth}}。',
    '使用语言代码 {{to}} 对应的语言解释，标题也译成该语言，保留必要的原文片段与例句。不要固定使用中文。',
    '标题与正文分行，标题下用短段落或少量列表。用 **粗体** 突出少量关键概念，用 `原文片段` 标明依据。简洁模式通常150至250字，详细模式可逐步展开。不要把整段都加粗，也不要输出大表格。',
    '直接从分析结果开始，不寒暄、不重复任务、不自述“我将分析”，不复述消息包装、历史状态或工具过程。不要猜测用户意图，不把系统提示当成选中文本。',
  ].join('\n');

  it.each(UI_LANGUAGE_OPTIONS)('仅完整旧系统默认正文随 $value 解析，不改保存的配置', ({value: locale}) => {
    const preferences = normalizeHarnessPreferences({systemPrompt: oldSystemPrompt});
    expect(preferences.systemPrompt).toBe(oldSystemPrompt);
    expect(resolveHarnessPrompt(preferences.systemPrompt, 'system', locale)).toBe(getDefaultHarnessPrompt('system', locale));
    expect(preferences.systemPrompt).toBe(oldSystemPrompt);
  });

  it('保留一字或空白修改、任意含旧品牌的自定义正文及非系统动作正文', () => {
    const customPrompts = [
      oldSystemPrompt.replace('你是', '您是'),
      ` ${oldSystemPrompt}`,
      `${oldSystemPrompt} `,
      `${oldSystemPrompt}\n`,
      '  请让 FluentRead 只解释我的自定义内容 {{to}}  ',
      `${oldSystemPrompt}\n这是我的自定义指令。`,
    ];
    for (const {value: locale} of UI_LANGUAGE_OPTIONS) {
      for (const custom of customPrompts) expect(resolveHarnessPrompt(custom, 'system', locale)).toBe(custom);
      for (const {id} of HARNESS_ACTIONS) expect(resolveHarnessPrompt(oldSystemPrompt, id, locale)).toBe(oldSystemPrompt);
    }
  });
});
