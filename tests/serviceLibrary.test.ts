import { describe, expect, it } from 'vitest'
import { Config, normalizeConfig } from '@/src/core/config/model'
import { services } from '@/src/core/config/catalog'
import { createApiKeyRequirementKey } from '@/src/core/config/validation'
import { hasSavedServiceConfiguration } from '@/src/ui/view-model/serviceLibrary'

const provider = { id: 'custom:work', name: '工作接口', endpoint: 'http://localhost:11434/v1', models: ['local-model'] }

describe('personal translation service library', () => {
  it('keeps a saved combination discoverable even when deleted members leave it empty', () => {
    const config = new Config()
    config.compositeTranslationProviders = [{id: 'composite:daily', name: 'Daily', strategy: 'sequential', services: [], timeoutMs: 12000}]
    expect(hasSavedServiceConfiguration('composite:daily', config)).toBe(true)
    expect(hasSavedServiceConfiguration('composite:gone', config)).toBe(false)
  })
  it('does not classify prefilled models or default local endpoints as saved user configuration', () => {
    const config = new Config()
    for (const service of Object.values(services)) expect(hasSavedServiceConfiguration(service, config), service).toBe(false)
    config.token.openai = '   '
    config.newApiUrl = ' '
    expect(hasSavedServiceConfiguration('openai', config)).toBe(false)
    expect(hasSavedServiceConfiguration('newapi', config)).toBe(false)
  })

  it('keeps saved and partial configurations discoverable without claiming a connection check', () => {
    const cases: [string, Partial<Config>][] = [
      ['openai', {token: {openai: 'fixture-key'}}],
      ['baiduTranslation', {secret: {baiduTranslation: 'partial-secret'}}],
      ['ollama', {proxy: {ollama: 'http://localhost:11435/v1'}}],
      ['rapidmlx', {proxy: {rapidmlx: 'http://127.0.0.1:8012/v1/chat/completions'}}],
      ['rapidmlx', {customModel: {rapidmlx: 'mlx-community/Qwen3.5-4B-MLX-4bit'}}],
      ['gemini', {customBody: {gemini: '{}'}}],
      ['newapi', {customHeaders: {newapi: '{}'}}],
      ['openai', {customModel: {openai: 'private-model'}}],
      ['deepseek', {customModels: {deepseek: ['another-model']}}],
      ['deepseek', {model: {deepseek: 'deepseek-reasoner'}}],
      ['openai', {requireApiKey: {[createApiKeyRequirementKey('openai', new Config().model.openai)]: false}}],
      ['tencent', {tencentSecretId: 'id-only'}],
      ['huanYuanTranslation', {tencentSecretKey: 'key-only'}],
      ['youdao', {youdaoAppKey: 'app-only'}],
      ['youdao', {youdaoAppSecret: 'secret-only'}],
      ['azureOpenai', {azureOpenaiEndpoint: 'https://example.com'}],
      ['newapi', {newApiUrl: 'http://localhost:5000'}],
      ['custom:work', {customOpenAIProviders: [provider]}],
    ]
    for (const [service, patch] of cases) {
      expect(hasSavedServiceConfiguration(service, Object.assign(new Config(), patch)), service).toBe(true)
    }
  })

  it('normalizes favorites without changing saved credentials, models, defaults or custom names', () => {
    const config = normalizeConfig({favoriteServices: ['deepseek', 'deepseek', null, 'machine', '__proto__', 'unknown', 'custom:gone', 'custom:work', 'chromeTranslator'], customOpenAIProviders: [provider], token: {deepseek: 'fixture-secret'}, service: 'freeTranslation'})
    expect(config.favoriteServices).toEqual(['deepseek', 'custom:work', 'chromeTranslator'])
    expect(config.token.deepseek).toBe('fixture-secret')
    expect(config.customOpenAIProviders[0].name).toBe('工作接口')
    expect(config.service).toBe('freeTranslation')
    expect(normalizeConfig(JSON.parse(JSON.stringify(config))).favoriteServices).toEqual(config.favoriteServices)
    expect(normalizeConfig({...config, customOpenAIProviders: []}).favoriteServices).toEqual(['deepseek', 'chromeTranslator'])
    expect(normalizeConfig({...config, favoriteServices: 'deepseek'}).favoriteServices).toEqual([])
    expect(normalizeConfig({}).favoriteServices).toEqual([])
  })

  it('removing a favorite does not remove its saved configuration', () => {
    const config = normalizeConfig({favoriteServices: ['openai'], token: {openai: 'fixture-key'}})
    const next = normalizeConfig({...config, favoriteServices: []})
    expect(hasSavedServiceConfiguration('openai', next)).toBe(true)
    expect(next.token).toEqual(config.token)
  })
})
