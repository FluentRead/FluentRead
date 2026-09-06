import { describe, expect, it } from 'vitest'
import { HARNESS_ACTIONS, DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH, renderHarnessPrompt, isHarnessService, normalizeHarnessPreferences } from '@/src/core/config/harness'
import { Config, normalizeConfig } from '@/src/core/config/model'

describe('Harness config contract', () => {
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


describe('翻译卡提示词配置', () => {
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
