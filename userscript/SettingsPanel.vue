<!--
 * @file userscript/SettingsPanel.vue
 * 文件职责：提供 userscript 紧凑设置对话框，编辑翻译服务、触发方式、输入翻译与界面配置草稿。
 * 主要内容：以共享纯配置 editor 管理手动保存、外部快照和在途草稿所有权，后继编辑与默认恢复不被旧保存覆盖；编辑资源由应用卸载入口与组件正常卸载共用幂等清理，失败挂载也释放订阅；复用配置目录及模型删除命令，AI 超时按秒保留输入草稿并在确认或保存时规范化；只有已保存的运行时设置应用到当前页面；页面翻译动作等待时禁止重复触发，失败可重试；无变更保存的页面重应用也按会话隔离，后续编辑或卸载使旧反馈失效。
 * 模块边界：只管理设置草稿和保存反馈，不实现网页翻译或扩展专有能力。
-->
<template>
  <div ref="menuContainer" class="fr-userscript-settings-backdrop" :class="{ dark: isDark }" role="presentation" @click.self="close">
    <section class="fr-userscript-settings" role="dialog" aria-modal="true" aria-labelledby="fr-userscript-settings-title">
      <header>
        <div class="brand">
          <img v-if="iconUrl" :src="iconUrl" alt="" />
          <span><strong id="fr-userscript-settings-title">流畅阅读</strong><small>{{ versionLabel }}</small></span>
        </div>
        <button type="button" class="close" aria-label="关闭设置" @click="close">×</button>
      </header>

      <div class="notice">
        该版本复用流畅阅读当前翻译核心。截图 OCR、圈选翻译、Chrome 内置翻译和扩展右键菜单依赖浏览器扩展权限，userscript 中暂不提供。
      </div>

      <div v-if="hydrated" class="settings-grid">
        <fieldset>
          <legend>基础设置</legend>
          <label class="toggle"><span>启用流畅阅读</span><input v-model="draft.on" type="checkbox" /></label>
          <label><span>源语言</span><UiSelect v-model="draft.from" :append-to="menuContainer" filterable aria-label="源语言"><ElOption v-for="item in options.from" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <label><span>目标语言</span><UiSelect v-model="draft.to" :append-to="menuContainer" filterable aria-label="目标语言"><ElOption v-for="item in options.to" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <label><span>译文显示</span><UiSelect v-model="draft.display" :append-to="menuContainer" aria-label="译文显示"><ElOption v-for="item in options.display" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <label><span>双语样式</span><UiSelect :model-value="draft.style" :append-to="menuContainer" aria-label="双语样式" @update:model-value="selectTranslationStyle"><ElOption v-for="item in styleOptions" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <label class="toggle"><span>打开网页后自动翻译</span><input v-model="draft.autoTranslate" type="checkbox" /></label>
          <label class="toggle"><span>使用翻译缓存</span><input v-model="draft.useCache" type="checkbox" /></label>
        </fieldset>

        <fieldset>
          <legend>翻译服务</legend>
          <label><span>服务</span><UiSelect v-model="draft.service" :append-to="menuContainer" filterable search-placeholder="搜索翻译服务" aria-label="服务"><ElOption v-for="item in serviceOptions" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <p v-if="serviceDescription" class="hint">{{ serviceDescription }}</p>
          <label v-if="usesModel"><span>模型</span><UiSelect v-model="selectedServiceModel" :append-to="menuContainer" filterable aria-label="模型"><ElOption v-for="model in modelOptions" :key="model" :value="model" :label="model" /></UiSelect></label>
          <div v-if="usesModel" class="model-add-control">
            <button v-if="selectedModelIsRemovable" type="button" class="inline-action is-danger" @click="removeSelectedCustomModel">
              {{ isCustomOpenAIService ? '删除当前模型' : '删除当前自定义模型' }}
            </button>
            <button v-if="!addingCustomModel" type="button" class="inline-action" :disabled="customModelLimitReached" @click="beginAddCustomModel">
              {{ customModelLimitReached ? '已达到 50 个模型上限' : '+ 添加模型' }}
            </button>
            <template v-else>
              <input v-model="customModelDraft" :maxlength="MAX_CUSTOM_OPENAI_MODEL_LENGTH" autocomplete="off" placeholder="输入模型标识" @input="customModelError = ''" />
              <button type="button" class="inline-action" @click="submitCustomModel">添加</button>
              <button type="button" class="inline-action is-plain" @click="cancelAddCustomModel">取消</button>
            </template>
            <small v-if="customModelError" class="model-add-error" role="alert">{{ customModelError }}</small>
          </div>
          <label v-if="isAIService && usesToken" class="toggle"><span>当前模型需要 API Key</span><input v-model="requiresApiKey" type="checkbox" /></label>
          <label v-if="usesToken"><span>API Key / Token</span><input v-model.trim="draft.token[draft.service]" type="password" autocomplete="off" /></label>
          <label v-if="draft.service === services.deepL"><span>DeepL API 套餐</span><UiSelect v-model="draft.deeplApiPlan" :append-to="menuContainer" aria-label="DeepL API 套餐"><ElOption value="free" label="API Free（免费）" /><ElOption value="pro" label="API Pro（付费）" /></UiSelect></label>
          <p v-if="draft.service === services.deepL" class="hint">选择与 API Key 对应的套餐；代理地址优先于套餐默认接口。</p>
          <label v-if="isCustomOpenAIService"><span>自定义接口地址</span><input v-model.trim="customOpenAIEndpoint" inputmode="url" :maxlength="MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH" /></label>
          <label v-if="draft.service === services.deeplx"><span>DeepLX 地址</span><input v-model.trim="draft.deeplx" inputmode="url" /></label>
          <template v-if="draft.service === services.myMemory">
            <label><span>MyMemory 邮箱（可选）</span><input v-model.trim="draft.myMemoryEmail" type="email" /></label>
            <p class="hint">官方 API：匿名每天 5,000 字符，有效邮箱每天 50,000 字符。</p>
          </template>
          <details v-if="draft.service === services.freeTranslation">
            <summary>自动降级顺序与连接设置</summary>
            <p class="hint">无需填写密钥。优先使用快且稳定的服务，遇到问题自动切换。至少开启一个服务，MyMemory 邮箱可留空。</p>
            <label><span>选择模式</span><select v-model="draft.freeTranslationMode" aria-label="免费翻译选择模式"><option value="balanced">智能加速</option><option value="sequential">优先顺序</option></select></label>
            <div v-for="(id, index) in draft.freeTranslationOrder" :key="id" class="fallback-order-row">
              <span>{{ fallbackLabel(id) }}</span>
              <button v-if="draft.freeTranslationMode === 'sequential'" type="button" :disabled="index === 0" :aria-label="`上移 ${fallbackLabel(id)}`" @click="moveFallback(index, -1)">↑</button>
              <button v-if="draft.freeTranslationMode === 'sequential'" type="button" :disabled="index === draft.freeTranslationOrder.length - 1" :aria-label="`下移 ${fallbackLabel(id)}`" @click="moveFallback(index, 1)">↓</button>
              <button type="button" :disabled="draft.freeTranslationOrder.length === 1" @click="draft.freeTranslationOrder = draft.freeTranslationOrder.filter(value => value !== id)">停用</button>
            </div>
            <label v-for="item in availableFallbacks" :key="item.id"><span>{{ item.label }}</span><button type="button" @click="draft.freeTranslationOrder.push(item.id)">加入后备</button></label>
            <label><span>MyMemory 邮箱（可选）</span><input v-model.trim="draft.myMemoryEmail" type="email" /></label>
            <label><span>每路超时（ms）</span><input v-model.number="draft.freeTranslationTimeoutMs" type="number" min="1000" max="15000" step="1000" /></label>
            <p class="hint">失败后自动暂停服务：网络问题通常几分钟后重试，限流遵循服务提示，访问受阻等待数小时，日额度耗尽约一天后重试。暂停记录保存在本地。</p>
          </details>
          <label v-if="draft.service === services.newapi"><span>New API 地址</span><input v-model.trim="draft.newApiUrl" inputmode="url" /></label>
          <label v-if="draft.service === services.azureOpenai"><span>Azure 地址</span><input v-model.trim="draft.azureOpenaiEndpoint" inputmode="url" placeholder="https://your-resource.services.ai.azure.com/openai/v1/" /></label>
          <p v-if="draft.service === services.azureOpenai" class="hint">支持资源地址、v1 基础地址与完整 Chat Completions 地址；模型请填写 Azure 中的实际部署名称。</p>
          <label v-if="usesProxy"><span>代理地址（可选）</span><input v-model.trim="draft.proxy[draft.service]" inputmode="url" placeholder="留空使用默认接口" /></label>
          <template v-if="draft.service === services.youdao">
            <label><span>有道 App Key</span><input v-model.trim="draft.youdaoAppKey" autocomplete="off" /></label>
            <label><span>有道 App Secret</span><input v-model.trim="draft.youdaoAppSecret" type="password" autocomplete="off" /></label>
          </template>
          <template v-if="servicesType.isTencent(draft.service)">
            <label><span>腾讯 Secret ID</span><input v-model.trim="draft.tencentSecretId" autocomplete="off" /></label>
            <label><span>腾讯 Secret Key</span><input v-model.trim="draft.tencentSecretKey" type="password" autocomplete="off" /></label>
          </template>
          <p v-if="credentialWarning" class="warning">{{ credentialWarning }}</p>
          <label class="toggle"><span>AI 网页上下文</span><input v-model="draft.enableAIContext" type="checkbox" :disabled="!canUseAIContext" /></label>
        </fieldset>

        <fieldset>
          <legend>页面交互</legend>
          <label class="toggle"><span>显示全文翻译悬浮球</span><input v-model="floatingBallEnabled" type="checkbox" /></label>
          <label class="toggle"><span>显示翻译进度面板</span><input v-model="draft.translationProgressPanelEnabled" type="checkbox" /></label>
          <label><span>全文快捷键</span><UiSelect v-model="draft.floatingBallHotkey" :append-to="menuContainer" aria-label="全文快捷键"><ElOption v-for="item in options.floatingBallHotkeys" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <label><span>全文翻译范围</span><UiSelect v-model="draft.fullPageTranslationMode" :append-to="menuContainer" aria-label="全文翻译范围"><ElOption value="viewport" label="按阅读进度（推荐）" /><ElOption value="all" label="立即翻译到网页底部" /></UiSelect></label>
          <p class="hint">“立即翻译到网页底部”会处理当前已加载的整页内容，并持续翻译之后新增的内容；它不会自动滚动页面，但可能产生更多请求。</p>
          <label><span>悬浮翻译触发</span><UiSelect v-model="draft.hotkey" :append-to="menuContainer" aria-label="悬浮翻译触发"><ElOption v-for="item in hoverOptions" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <label><span>划词翻译</span><UiSelect v-model="draft.selectionTranslatorMode" :append-to="menuContainer" aria-label="划词翻译"><ElOption value="disabled" label="关闭" /><ElOption value="bilingual" label="原文 + 译文" /><ElOption value="translation-only" label="仅译文" /></UiSelect></label>
          <label v-if="draft.selectionTranslatorMode !== 'disabled'"><span>划词触发</span><UiSelect v-model="draft.selectionTranslatorTrigger" :append-to="menuContainer" aria-label="划词触发"><ElOption value="direct" label="直接显示" /><ElOption value="icon" label="翻译图标" /><ElOption value="dot" label="小圆点" /></UiSelect></label>
          <label><span>并发翻译数</span><input v-model.number="draft.maxConcurrentTranslations" type="number" min="1" max="20" /></label>
          <label>
            <span>段落加载样式</span>
            <div class="translation-loading-style-control">
              <UiSelect v-model="selectedLoadingStyle" :append-to="menuContainer" aria-label="段落加载样式"><ElOption v-for="item in translationLoadingStyleChoices" :key="item.value" :value="item.value" :label="item.label" /></UiSelect>
              <span class="translation-loading-style-reference" aria-label="当前动画参考" :title="selectedTranslationLoadingStyle?.description">
                <i aria-hidden="true" />
                <TranslationLoadingPreview :loading-style="draft.translationLoadingStyle" :animated="draft.animations" />
              </span>
            </div>
          </label>
          <label><span>主题</span><UiSelect v-model="draft.theme" :append-to="menuContainer" aria-label="主题"><ElOption v-for="item in options.theme" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
        </fieldset>

        <fieldset>
          <legend>输入框翻译</legend>
          <p class="hint">独立设置输入框的触发方式和翻译偏好。普通文本输入框可用，密码框和富文本编辑器不参与。</p>
          <label><span>触发方式</span><UiSelect v-model="draft.inputBoxTranslationTrigger" :append-to="menuContainer" aria-label="输入框翻译触发方式"><ElOption v-for="item in options.inputBoxTranslationTrigger" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
          <template v-if="draft.inputBoxTranslationTrigger !== 'disabled'">
            <template v-if="draft.inputBoxTranslationTrigger.startsWith('triple_')">
              <label><span>三击间隔（毫秒）</span><input v-model.number="draft.inputBoxTranslationInterval" type="number" min="200" max="2000" step="1" /></label>
              <p class="hint">相邻两次按键最多等待此时长；默认 1000 毫秒。</p>
              <button type="button" @click="draft.inputBoxTranslationInterval = 1000">恢复默认间隔</button>
            </template>
            <label><span>目标语言</span><UiSelect v-model="draft.inputBoxTranslationTarget" :append-to="menuContainer" filterable aria-label="输入框目标语言"><ElOption v-for="item in options.inputBoxTranslationTarget" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
            <label><span>输入框翻译服务</span><UiSelect v-model="draft.inputBoxTranslationService" :append-to="menuContainer" filterable aria-label="输入框翻译服务" @change="draft.inputBoxTranslationModel = ''"><ElOption v-for="item in serviceOptions" :key="item.value" :value="item.value" :label="item.label" /></UiSelect></label>
            <p class="hint">使用该服务已保存的连接设置。</p>
            <label v-if="servicesType.isUseModel(draft.inputBoxTranslationService)"><span>输入框翻译模型</span><input v-model="draft.inputBoxTranslationModel" :list="inputModelListId" placeholder="留空使用该服务的默认模型" /></label>
            <datalist :id="inputModelListId"><option v-for="model in inputModelOptions" :key="model" :value="model" /></datalist>
            <details v-if="inputSupportsPrompts">
              <summary>输入框翻译提示词</summary>
              <p class="hint">留空使用内置的输入框翻译提示词。可用变量：<code v-pre>{{origin}}</code>（原文）、<code v-pre>{{to}}</code>（目标语言）。</p>
              <label><span>系统提示词</span><textarea v-model="draft.inputBoxTranslationSystemPrompt" rows="4" /></label>
              <button type="button" @click="draft.inputBoxTranslationSystemPrompt = ''">恢复默认系统提示词</button>
              <label><span>翻译提示词</span><textarea v-model="draft.inputBoxTranslationPrompt" rows="5" /></label>
              <button type="button" @click="draft.inputBoxTranslationPrompt = ''">恢复默认翻译提示词</button>
            </details>
          </template>
        </fieldset>

        <fieldset>
          <legend>任务调度</legend>
          <label data-testid="ai-request-timeout-settings"><span>{{ t('settings.requestLimits.aiTimeout') }}（{{ t('settings.requestLimits.seconds') }}）</span><input :key="aiRequestTimeoutContext.revision.value" v-model.number="aiRequestTimeoutSecondsDraft" type="number" :min="MIN_AI_REQUEST_TIMEOUT_MS / 1000" :max="MAX_AI_REQUEST_TIMEOUT_MS / 1000" step="1" :aria-label="t('settings.requestLimits.aiTimeout')" :disabled="!aiRequestTimeoutContext.active.value" :onChange="aiRequestTimeoutActions.commit" :onBlur="aiRequestTimeoutActions.commit" /></label>
          <p class="hint">{{ t('settings.requestLimits.aiTimeoutHelp') }}</p>
          <label><span>每秒最多请求（0=不限）</span><input v-model.number="draft.translationRequestsPerSecond" type="number" min="0" max="1000" /></label>
          <label><span>每分钟最多请求（0=不限）</span><input v-model.number="draft.translationRequestsPerMinute" type="number" min="0" max="10000" /></label>
          <label><span>失败后最多重试</span><input v-model.number="draft.translationMaxRetries" type="number" min="0" max="10" /></label>
          <label><span>退避初始间隔（ms）</span><input v-model.number="draft.translationBackoffBaseMs" type="number" min="100" max="60000" step="100" /></label>
          <label><span>退避最大间隔（ms）</span><input v-model.number="draft.translationBackoffMaxMs" type="number" min="1000" max="300000" step="1000" /></label>
          <p class="hint">请求限制作用于 userscript 当前页面的共享翻译调度；普通服务重试使用指数退避，并尊重服务端 Retry-After。免费翻译每个服务最多尝试一次，整轮最多 20 秒，不重复全局重试。</p>
        </fieldset>

        <details>
          <summary>高级 AI 请求设置</summary>
          <label v-if="isAIService && usesModel" class="toggle"><span>当前模型 Thinking（仅在已适配接口生效，默认关闭）</span><input v-model="selectedModelThinking" type="checkbox" :disabled="!selectedServiceModel" aria-label="当前模型是否启用 Thinking" /></label>
          <label><span>自定义请求体（JSON）</span><textarea v-model="draft.customBody[draft.service]" rows="4" placeholder="可选：合并到请求体顶层" /></label>
          <label><span>System 提示词</span><textarea v-model="draft.system_role[draft.service]" rows="4" /></label>
          <label><span>User 提示词</span><textarea v-model="draft.user_role[draft.service]" rows="5" /></label>
        </details>
      </div>

      <footer>
        <span class="status" :class="{ error: statusIsError }">{{ status }}</span>
        <div>
          <button type="button" class="secondary" :disabled="!hydrated" @click="restoreDefaults">恢复默认</button>
          <button type="button" class="secondary" :disabled="pageTranslationPending || saving" @click="togglePageTranslation">翻译 / 恢复当前页</button>
          <button type="button" class="primary" :disabled="saving || !hydrated" @click="save">{{ !hydrated ? '加载设置中…' : saving ? '保存中…' : '保存设置' }}</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import {computed, getCurrentInstance, onMounted, onUnmounted, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {removeConfiguredModel} from '@/src/core/config/modelEditing';
import {Config, MIN_AI_REQUEST_TIMEOUT_MS, MAX_AI_REQUEST_TIMEOUT_MS, normalizeAiRequestTimeoutMs} from '@/src/core/config/model';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {applyTranslationLoadingStyleChoice, getTranslationLoadingStyleChoice, translationLoadingStyleChoices} from '@/src/core/config/translationLoadingStyle';
import {getTranslationPresetAppearance, getTranslationStylePreset} from '@/src/core/config/translationAppearance';
import TranslationLoadingPreview from '@/src/ui/components/TranslationLoadingPreview.vue';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption} from 'element-plus';
import {config as runtimeConfig, configReady, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import {createConfigEditor} from '@/src/services/config/editor';
import {customModelString, models, options, resolveConfiguredModel, services, servicesType} from '@/src/core/config/catalog';
import {supportsInputBoxTranslationPrompt} from '@/src/core/config/inputTranslation';
import {
  getCustomOpenAIProvider,
  isCustomOpenAIProviderId,
  CUSTOM_OPENAI_RESERVED_MODEL_ID,
  MAX_CUSTOM_OPENAI_MODEL_LENGTH,
  MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH,
  MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER,
  normalizeCustomOpenAIModels,
  withCustomOpenAIServiceOptions,
} from '@/src/core/config/customOpenAI';
import {
  getApiKeyRequirementKey,
  getMissingCredentialMessage,
  isApiKeyRequired,
} from '@/src/core/config/validation';
import {isUserscriptServiceSupported, normalizeUserscriptConfig} from './initialize';
import {
  isModelThinkingEnabled,
  withModelThinkingPreference,
} from '@/src/core/config/modelThinking';

const emit = defineEmits<{close: []}>();
const versionLabel = `流畅阅读 V${process.env.VUE_APP_VERSION} · Userscript V${process.env.VUE_APP_USERSCRIPT_VERSION}`;
const iconUrl = globalThis.__FLUENTREAD_ICON_DATA__ || '';
const menuContainer = ref<HTMLElement>();
const draft = ref(new Config());
const {t} = useUiI18n();
const hydrated = ref(false);
const aiRequestTimeoutSecondsDraft = ref<number | string>(draft.value.aiRequestTimeoutMs / 1000);
watch(() => [draft.value, draft.value.aiRequestTimeoutMs] as const, ([, value]) => {
  aiRequestTimeoutSecondsDraft.value = normalizeAiRequestTimeoutMs(value) / 1000;
}, {flush: 'sync'});
const aiRequestTimeoutContext = useSettingsActionContext(() => hydrated.value, () => [draft.value]);
const aiRequestTimeoutActions = computed(() => {
  const owns = aiRequestTimeoutContext.capture();
  return {commit: () => {
    if (!owns()) return;
    const value = aiRequestTimeoutSecondsDraft.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      draft.value.aiRequestTimeoutMs = normalizeAiRequestTimeoutMs(value * 1000);
    }
    aiRequestTimeoutSecondsDraft.value = normalizeAiRequestTimeoutMs(draft.value.aiRequestTimeoutMs) / 1000;
  }};
});
const fallbackLabel = (id: string) => FREE_TRANSLATION_PROVIDERS.find(item => item.id === id)?.label || id;
const availableFallbacks = computed(() => FREE_TRANSLATION_PROVIDERS.filter(item => !draft.value.freeTranslationOrder.includes(item.id)));
function moveFallback(index: number, delta: number) {
  const order = [...draft.value.freeTranslationOrder];
  [order[index], order[index + delta]] = [order[index + delta], order[index]];
  draft.value.freeTranslationOrder = order;
}


const saving = ref(false);
const pageTranslationPending = ref(false);
let pageFeedbackRevision = 0;
// 仅在保存或页面动作等待期间观察草稿；后续编辑撤销旧反馈，旧动作不得关闭当前编辑器。
watch(() => pageTranslationPending.value || saving.value ? draft.value : null, () => {
  if (pageTranslationPending.value || saving.value) pageFeedbackRevision += 1;
}, {deep: true, flush: 'sync'});
const status = ref('');
const statusIsError = ref(false);
const addingCustomModel = ref(false);
const customModelDraft = ref('');
const customModelError = ref('');

const styleOptions = options.styles.filter(item => !item.disabled && typeof item.value === 'number');
function selectTranslationStyle(value: unknown): void {
  const style = typeof value === 'string' ? Number(value) : value;
  const preset = getTranslationStylePreset(style);
  if (!preset) return;
  draft.value.style = preset.value;
  // 只处理用户在下拉中的选择；配置载入、导入和命名样式的外观不经过此处。
  if (preset.category === 'color') {
    draft.value.translationAppearance = getTranslationPresetAppearance(preset.value, draft.value.translationAppearance);
    draft.value.activeTranslationStyleProfileId = '';
  }
}
const hoverOptions = options.keys.filter(item => !item.disabled);
const selectedLoadingStyle = computed({
  get: () => getTranslationLoadingStyleChoice(draft.value),
  set: value => applyTranslationLoadingStyleChoice(draft.value, value),
});
const selectedTranslationLoadingStyle = computed(() => translationLoadingStyleChoices.find(
  item => item.value === selectedLoadingStyle.value,
));
const serviceOptions = computed(() => withCustomOpenAIServiceOptions(
  options.services,
  draft.value.customOpenAIProviders,
).filter(item => !item.disabled && isUserscriptServiceSupported(item.value)));
const selectedService = computed(() => serviceOptions.value.find(item => item.value === draft.value.service));
const serviceDescription = computed(() => selectedService.value && 'description' in selectedService.value ? selectedService.value.description : '');
const selectedCustomOpenAIProvider = computed(() => getCustomOpenAIProvider(
  draft.value.customOpenAIProviders,
  draft.value.service,
));
const isCustomOpenAIService = computed(() => Boolean(selectedCustomOpenAIProvider.value));
const builtInModelOptions = computed(() => (models.get(draft.value.service) || [])
  .filter((model) => model !== customModelString));
const modelOptions = computed(() => selectedCustomOpenAIProvider.value?.models || Array.from(new Set([
  ...builtInModelOptions.value,
  ...(draft.value.customModels[draft.value.service] || []),
  draft.value.model[draft.value.service] === customModelString
    ? draft.value.customModel[draft.value.service] || ''
    : '',
].filter(Boolean))));
const inputModelListId = 'fr-userscript-input-translation-models';
const inputSupportsPrompts = computed(() => supportsInputBoxTranslationPrompt(
  draft.value.inputBoxTranslationService,
  draft.value.inputBoxTranslationModel || resolveConfiguredModel(
    draft.value.model[draft.value.inputBoxTranslationService], draft.value.customModel[draft.value.inputBoxTranslationService],
  ),
));
const inputModelOptions = computed(() => Array.from(new Set([
  ...(getCustomOpenAIProvider(draft.value.customOpenAIProviders, draft.value.inputBoxTranslationService)?.models || []),
  ...(models.get(draft.value.inputBoxTranslationService) || []),
  ...(draft.value.customModels[draft.value.inputBoxTranslationService] || []),
].filter(model => model && model !== customModelString))));
const selectedServiceModel = computed({
  get: () => selectedCustomOpenAIProvider.value
    ? draft.value.model[draft.value.service] || modelOptions.value[0] || ''
    : resolveConfiguredModel(
      draft.value.model[draft.value.service],
      draft.value.customModel[draft.value.service],
    ) || modelOptions.value[0] || '',
  set: (model: string) => {
    const service = draft.value.service;
    if (selectedCustomOpenAIProvider.value || builtInModelOptions.value.includes(model)) {
      draft.value.model[service] = model;
      return;
    }
    draft.value.customModel[service] = model;
    draft.value.model[service] = customModelString;
  },
});
const selectedModelThinking = computed({
  get: () => isModelThinkingEnabled(
    draft.value.modelThinking,
    draft.value.service,
    selectedServiceModel.value,
  ),
  set: (enabled: boolean) => {
    draft.value.modelThinking = withModelThinkingPreference(
      draft.value.modelThinking,
      draft.value.service,
      selectedServiceModel.value,
      enabled,
    );
  },
});
const customModelLimitReached = computed(() => (
  selectedCustomOpenAIProvider.value?.models.length
  ?? draft.value.customModels[draft.value.service]?.length
  ?? 0
) >= MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER);
const selectedModelIsRemovable = computed(() => selectedCustomOpenAIProvider.value
  ? selectedCustomOpenAIProvider.value.models.includes(selectedServiceModel.value)
  : (draft.value.customModels[draft.value.service] || []).includes(selectedServiceModel.value));
const usesModel = computed(() => isCustomOpenAIService.value || servicesType.isUseModel(draft.value.service));
const usesToken = computed(() => isCustomOpenAIService.value || servicesType.isUseToken(draft.value.service));
const usesProxy = computed(() => isCustomOpenAIService.value || servicesType.isUseProxy(draft.value.service));
const isAIService = computed(() => isCustomOpenAIService.value || servicesType.isAI(draft.value.service));
const customOpenAIEndpoint = computed({
  get: () => selectedCustomOpenAIProvider.value?.endpoint || '',
  set: (endpoint: string) => {
    const service = draft.value.service;
    if (!isCustomOpenAIProviderId(service)) return;
    draft.value.customOpenAIProviders = draft.value.customOpenAIProviders.map(provider => (
      provider.id === service ? {...provider, endpoint} : provider
    ));
    // 旧 `custom` 字段继续镜像 legacy profile，保证旧 userscript 版本回退时仍能读取同一地址。
    if (service === services.custom) draft.value.custom = endpoint;
  },
});
const requiresApiKey = computed({
  get: () => isApiKeyRequired(draft.value.service, draft.value),
  set: (required: boolean) => {
    draft.value.requireApiKey[getApiKeyRequirementKey(draft.value.service, draft.value)] = required;
  },
});
const canUseAIContext = computed(() => isCustomOpenAIService.value || servicesType.isUseAIContext(
  draft.value.service,
  resolveConfiguredModel(
    draft.value.model[draft.value.service],
    draft.value.customModel[draft.value.service],
  ),
));
const credentialWarning = computed(() => getMissingCredentialMessage(draft.value.service, draft.value) || '');
const floatingBallEnabled = computed({
  get: () => !draft.value.disableFloatingBall,
  set: (enabled: boolean) => { draft.value.disableFloatingBall = !enabled; },
});
const isDark = computed(() => draft.value.theme === 'dark' || (
  draft.value.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches
));

function beginAddCustomModel(): void {
  if (customModelLimitReached.value) return;
  addingCustomModel.value = true;
  customModelDraft.value = '';
  customModelError.value = '';
}

function cancelAddCustomModel(): void {
  addingCustomModel.value = false;
  customModelDraft.value = '';
  customModelError.value = '';
}

function submitCustomModel(): void {
  if (customModelLimitReached.value) {
    customModelError.value = '已达到 50 个模型上限';
    return;
  }
  const model = customModelDraft.value.trim();
  if (!model) {
    customModelError.value = '请输入模型标识';
    return;
  }
  if (model === CUSTOM_OPENAI_RESERVED_MODEL_ID) {
    customModelError.value = `“${CUSTOM_OPENAI_RESERVED_MODEL_ID}”是界面保留名称`;
    return;
  }
  if (modelOptions.value.includes(model)) {
    customModelError.value = '该模型已经存在';
    return;
  }
  const service = draft.value.service;
  draft.value.modelThinking = withModelThinkingPreference(
    draft.value.modelThinking,
    service,
    model,
    false,
  );
  if (selectedCustomOpenAIProvider.value) {
    draft.value.customOpenAIProviders = draft.value.customOpenAIProviders.map((provider) => (
      provider.id === service
        ? {...provider, models: normalizeCustomOpenAIModels([...provider.models, model])}
        : provider
    ));
    selectedServiceModel.value = model;
    cancelAddCustomModel();
    return;
  }
  draft.value.customModels[service] = normalizeCustomOpenAIModels([
    ...(draft.value.customModels[service] || []),
    model,
  ]);
  selectedServiceModel.value = model;
  cancelAddCustomModel();
}

function removeSelectedCustomModel(): void {
  removeConfiguredModel(draft.value, draft.value.service, selectedServiceModel.value, builtInModelOptions.value[0] || '');
}

watch(() => draft.value.service, cancelAddCustomModel);

let disposed = false;
let submitted = false;
let pageApplied = false;
const configEditor = createConfigEditor({
  copySnapshot: normalizeUserscriptConfig,
  readDraft: () => draft.value,
  writeDraft: snapshot => {draft.value = snapshot;},
  async saveDraft(snapshot) {
    submitted = true;
    // 本地 patch 仍由 store 记录即时历史；失败回读权威状态，避免把乐观回声当成保存成功。
    await requestConfigPatch(snapshot);
    if (!disposed) pageApplied = await syncCurrentPage();
  },
  onEdited: () => {status.value = '';statusIsError.value = false;},
  onSaved: () => {statusIsError.value = !pageApplied; status.value = pageApplied ? '本次提交已保存，并已应用到当前页面。' : '设置已保存，当前页面应用状态未确认，请重试或刷新页面。';},
  onSaveError: error => {
    statusIsError.value = true;
    status.value = `保存失败：${error instanceof Error ? error.message : String(error)}`;
  },
});
const unsubscribeConfig = subscribeConfig(configEditor.hydrate);
const editorApp = getCurrentInstance()!.appContext.app;
const previousUnmount = editorApp.unmount;
function disposeEditor(): void {
  if (disposed) return;
  disposed = true;
  saving.value = false;
  try { unsubscribeConfig(); }
  finally {
    configEditor.dispose();
    if (editorApp.unmount === unmountEditor) editorApp.unmount = previousUnmount;
  }
}
function unmountEditor(): void {
  try { disposeEditor(); }
  finally { previousUnmount.call(editorApp); }
}
// mount 期间的 DOM 端口也可能抛错；Vue 此时不会运行 onUnmounted。
// 与 i18n 插件共用 app 的释放入口，失败构造和正常关闭都只释放本次编辑会话。
editorApp.unmount = unmountEditor;
onMounted(async () => {
  try {
    await configReady;
    if (disposed) return;
    configEditor.initialize(runtimeConfig);
    hydrated.value = true;
  } catch (error) {
    if (disposed) return;
    statusIsError.value = true;
    status.value = `设置加载失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
onUnmounted(disposeEditor);

function close(): void {
  emit('close');
}

async function syncCurrentPage(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      browser.tabs.sendMessage(1, {type: 'reconcileUserscriptPage'}),
      new Promise<undefined>(resolve => {timer = setTimeout(() => resolve(undefined), 2000);}),
    ]);
    return Boolean(response && typeof response === 'object' && 'status' in response && response.status === 'success');
  } catch {return false;}
  finally {if (timer !== undefined) clearTimeout(timer);}
}

async function save(): Promise<void> {
  if (disposed || saving.value || !hydrated.value) return;
  pageFeedbackRevision += 1;
  aiRequestTimeoutActions.value.commit();
  saving.value = true;
  status.value = '';
  statusIsError.value = false;
  submitted = false;
  const feedbackRevision = pageFeedbackRevision;
  try {
    await configEditor.save();
    // 无变化的手动保存仍允许把已有设置重新应用到页面，不生成空持久化请求。
    if (!submitted && !disposed) {
      const applied = await syncCurrentPage();
      if (!disposed && feedbackRevision === pageFeedbackRevision && !status.value) {
        statusIsError.value = !applied;
        status.value = applied ? '本次提交已保存，并已应用到当前页面。' : '设置已保存，当前页面应用状态未确认，请重试或刷新页面。';
      }
    }
  } catch (error) {
    if (!disposed && feedbackRevision === pageFeedbackRevision && !status.value) {
      statusIsError.value = true;
      status.value = `保存失败：${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (!disposed) saving.value = false;
  }
}

function restoreDefaults(): void {
  if (disposed || !hydrated.value) return;
  pageFeedbackRevision += 1;
  configEditor.invalidateFeedback();
  const next = new Config();
  next.disableFloatingBall = false;
  draft.value = normalizeUserscriptConfig(next);
  statusIsError.value = false;
  status.value = '已载入 userscript 默认设置，点击“保存设置”后生效。';
}

async function togglePageTranslation(): Promise<void> {
  if (disposed || pageTranslationPending.value || saving.value) return;
  pageTranslationPending.value = true;
  const revision = ++pageFeedbackRevision;
  status.value = '';
  statusIsError.value = false;
  try {
    await browser.tabs.sendMessage(1, {type: 'userscriptTogglePageTranslation'});
    if (!disposed && revision === pageFeedbackRevision) close();
  } catch (error) {
    if (!disposed && revision === pageFeedbackRevision) {
      statusIsError.value = true;
      status.value = `翻译操作失败：${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    pageTranslationPending.value = false;
  }
}
</script>

<style scoped>
.fallback-order-row { display: flex; align-items: center; gap: 6px; padding: 8px 0; }
.fallback-order-row > span { flex: 1; min-width: 0; }
.fallback-order-row input[type='number'] { flex: 0 1 72px; width: 72px; min-width: 0; }
.fallback-order-row button { flex: none; white-space: nowrap; }
.fallback-order-row > button { padding: 5px 9px; border-radius: 6px; }
.fallback-order-row > button:disabled { opacity: .4; cursor: default; }

.fr-userscript-settings-backdrop { --brand: #ef4776; --brand-strong: #d93d6b; --brand-soft: #fff0f4; --line: #e5e8ef; --ink: #182033; --surface: #fff; --surface-soft: #f7f8fb; --muted: #737c8f; position: fixed; inset: 0; z-index: 2147483647; display: grid; width: 100vw; height: 100vh; padding: 22px; place-items: center; box-sizing: border-box; background: rgba(20, 24, 34, .48); color: var(--ink); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; pointer-events: auto; backdrop-filter: blur(8px); }
.fr-userscript-settings { display: flex; width: min(980px, calc(100vw - 32px)); max-height: min(900px, calc(100vh - 32px)); overflow: hidden; border: 1px solid rgba(25, 35, 54, .12); border-radius: 22px; background: #f7f8fb; box-shadow: 0 28px 90px rgba(15, 20, 32, .32); flex-direction: column; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 20px; background: #fff; }
header { border-bottom: 1px solid #e5e8ef; }
footer { border-top: 1px solid #e5e8ef; }
.brand { display: flex; align-items: center; gap: 11px; }
.brand img { width: 38px; height: 38px; border-radius: 11px; }
.brand span { display: flex; flex-direction: column; }
.brand strong { font-size: 16px; }
.brand small { margin-top: 2px; color: #7c8493; font-size: 10px; }
button { border: 0; font: inherit; cursor: pointer; }
.close { width: 34px; height: 34px; border-radius: 10px; background: #f2f3f7; color: #727a88; font-size: 22px; line-height: 1; }
.notice { margin: 14px 18px 0; padding: 10px 13px; border: 1px solid #f0c7d4; border-radius: 11px; background: #fff4f7; color: #7a3148; font-size: 11px; line-height: 1.55; }
.settings-grid { display: grid; overflow: auto; padding: 16px 18px 20px; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
fieldset, details { min-width: 0; margin: 0; padding: 15px; border: 1px solid #e2e6ee; border-radius: 15px; background: #fff; }
fieldset:nth-of-type(3), details { grid-column: 1 / -1; }
legend, summary { color: #d93d6b; font-size: 12px; font-weight: 800; }
summary { cursor: pointer; }
label { display: grid; align-items: center; gap: 10px; margin-top: 11px; grid-template-columns: minmax(120px, .8fr) minmax(0, 1.4fr); color: #4d5668; font-size: 11px; }
label > span { line-height: 1.35; }
input, select, textarea { width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid #dfe3eb; border-radius: 9px; outline: none; box-sizing: border-box; background: #f8f9fb; color: #20283a; font: inherit; font-size: 12px; }
input:focus, select:focus, textarea:focus { border-color: #ef4776; box-shadow: 0 0 0 3px rgba(239, 71, 118, .1); background: #fff; }
textarea { resize: vertical; line-height: 1.45; }
.toggle input { justify-self: end; width: 38px; height: 20px; accent-color: #ef4776; }
.translation-loading-style-control { display: grid; grid-template-columns: minmax(0, 1fr) 62px; align-items: stretch; gap: 6px; }
.translation-loading-style-reference { display: inline-flex; min-height: 34px; align-items: center; justify-content: center; gap: 1px; border: 1px solid #dfe3eb; border-radius: 9px; background: #f8f9fb; }
.translation-loading-style-reference > i { display: block; width: 22px; height: 2px; border-radius: 999px; background: #aeb5c1; opacity: .55; }
.hint, .warning { margin: 8px 0 0; padding: 8px 10px; border-radius: 9px; font-size: 10px; line-height: 1.5; }
.hint { background: #f3f5f9; color: #70798a; }
.warning { background: #fff2e7; color: #8a4a1e; }
.model-add-control { display: flex; margin-top: 9px; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.model-add-control input { width: min(240px, 100%); padding: 7px 9px; }
.inline-action { padding: 7px 9px; border: 1px solid #ef9ab1; border-radius: 8px; color: #c72a56; background: #fff7f9; font-size: 10px; font-weight: 700; }
.inline-action.is-plain { border-color: transparent; color: #6f7888; background: transparent; }
.inline-action.is-danger { border-color: transparent; color: #a83d5b; background: transparent; }
.inline-action:disabled { border-color: #dfe3eb; color: #9aa2b1; background: #f5f6f8; cursor: not-allowed; }
.model-add-error { width: 100%; color: #b72f4e; font-size: 10px; text-align: right; }
footer > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
footer button { padding: 9px 13px; border-radius: 9px; font-size: 11px; font-weight: 700; }
.secondary { border: 1px solid #dfe3eb; background: #fff; color: #4c5567; }
.primary { background: #ef4776; color: #fff; }
.primary:disabled { opacity: .55; cursor: wait; }
.status { min-height: 16px; color: #2c7a55; font-size: 10px; }
.status.error { color: #b72f4e; }
.dark { --brand: #ff7097; --brand-strong: #ff9ab5; --brand-soft: #4d2d3a; --line: #50535f; --ink: #f2f3f7; --surface: #30323c; --surface-soft: #3a3d47; --muted: #bdc1cb; color: var(--ink); }
.dark .fr-userscript-settings { border-color: #444754; background: #272932; }
.dark header, .dark footer, .dark fieldset, .dark details { border-color: #444754; background: #30323c; }
.dark .notice { border-color: #6f4654; background: #3b2e35; color: #f0c0d0; }
.dark label { color: #d2d5dc; }
.dark input, .dark select, .dark textarea, .dark .close, .dark .secondary { border-color: #50535f; background: #3a3d47; color: #f1f2f5; }
.dark .translation-loading-style-reference { border-color: #50535f; background: #3a3d47; }
.dark .hint { background: #393c46; color: #bdc1cb; }
@media (max-width: 720px) {
  .fr-userscript-settings-backdrop { padding: 0; place-items: stretch; }
  .fr-userscript-settings { width: 100vw; max-height: 100vh; border: 0; border-radius: 0; }
  .settings-grid { grid-template-columns: 1fr; }
  fieldset:nth-of-type(3), details { grid-column: auto; }
  label { grid-template-columns: 1fr; gap: 5px; }
  footer { align-items: stretch; flex-direction: column; }
  footer > div { justify-content: stretch; }
  footer button { flex: 1; }
  .fallback-order-row { flex-wrap: wrap; }
  .fallback-order-row > span { flex: 1 1 100%; }
  .fallback-order-row input[type='number'] { flex: 1 1 96px; width: auto; }
}
</style>
