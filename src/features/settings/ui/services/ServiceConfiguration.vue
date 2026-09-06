<!--
 * @file src/features/settings/ui/services/ServiceConfiguration.vue
 * 文件职责：渲染当前翻译服务的详细连接配置，按服务能力显示模型、端点、区域、计费方式、密钥、代理、提示词和自定义请求体等字段。
 * 主要内容：组件派生字段可见性与 DeepL/MiniMax/MiMo endpoint，选择 DeepL API 套餐，共用 Azure 地址校验，校验 custom body，管理连接测试状态、Chrome 当前语言对的点击准备/进度/超时、官方帮助、模板重置与加密凭据保存提示，并通过配置 store 提交修改。
 * 模块边界：本组件不执行网页正文翻译或保存公开配置中的明文凭据；Chrome 内置翻译仅在当前点击页完成模型自检，其他连接测试经后台消息，字段规则来自 core/config，服务切换由 ServiceCatalog 和 SettingsSections 负责。
 -->
<template>
  <section
    class="settings-section service-connection-section"
    :data-service-configuration-service="service"
    :data-custom-service-configuration="compute.showCustomOpenAI ? 'true' : 'false'"
    :data-ai-advanced-settings="compute.showAI ? 'true' : 'false'"
  >
    <div class="subsection-heading">
      <div>
        <strong>连接配置</strong>
        <small class="connection-test-hint">修改会自动保存；凭据只保存在当前设备。</small>
      </div>
      <span
        v-if="compute.credentialWarning"
        class="setup-status is-warning"
        role="status"
        :aria-label="compute.credentialWarning"
      >待完成</span>
      <span v-else class="setup-status">{{ isChromeConnectionTest ? t('settings.services.chromePreparation.noKey') : '已就绪' }}</span>
    </div>

    <Teleport defer to=".detail-hero">
      <div class="detail-actions">
        <button
          v-if="compute.showCustomOpenAI"
          type="button"
          class="delete-service-button"
          data-testid="custom-service-delete"
          @click="confirmDeleteProvider"
        >
          删除服务
        </button>
        <button
          type="button"
          class="connection-test-button"
          data-connection-test-button
          :disabled="connectionTestBusy"
          @click="testConnection"
        >
          {{ isChromeConnectionTest
            ? (connectionTestBusy ? t('settings.services.chromePreparation.actionBusy') : t('settings.services.chromePreparation.action'))
            : (connectionTestBusy ? '检查中…' : '检查连接') }}
        </button>
      </div>
    </Teleport>

    <div
      v-if="connectionTestMessage"
      class="connection-test-result"
      :class="`is-${connectionTestState}`"
      data-connection-test-status
      role="status"
      aria-live="polite"
    >
      <strong>{{ connectionTestTitle }}</strong>
      <span>{{ connectionTestMessage }}</span>
      <details v-if="connectionTestDetails" class="connection-test-details">
        <summary>{{ t('settings.services.chromePreparation.errorDetailsSummary') }}</summary>
        <code>{{ connectionTestDetails }}</code>
      </details>
    </div>

    <FreeTranslationSettings v-if="service === services.freeTranslation" :config="config" />

    <template v-if="service === services.myMemory">
      <div class="connection-field" data-mymemory-email>
        <div class="connection-field-label"><strong>联系邮箱（可选）</strong><small>不填写也可以使用</small></div>
        <div class="connection-field-control">
          <el-input v-model="myMemoryEmailDraft" type="email" aria-label="MyMemory 联系邮箱" placeholder="不填写也可以使用" :aria-invalid="myMemoryEmailInvalid" @change="commitMyMemoryEmail" />
          <small v-if="myMemoryEmailInvalid" class="field-warning" role="status">请输入有效邮箱，或留空。</small>
        </div>
      </div>
      <div class="official-translation-help" data-mymemory-help>
        <p>匿名每天 5,000 字符；提供有效邮箱后每天 50,000 字符。邮箱会随请求发送给 MyMemory。</p>
        <p>自动识别来源语言时使用本地检测；无法可靠识别时，请手动选择来源语言。</p>
        <a href="https://mymemory.translated.net/doc/usagelimits.php" target="_blank" rel="noreferrer">官方额度说明</a>
      </div>
    </template>

    <div v-if="isChromeConnectionTest" class="chrome-preparation-help" data-chrome-preparation-help>
      <p class="chrome-preparation-pair" data-chrome-preparation-language-pair>
        <strong>{{ t('settings.services.chromePreparation.sourceLabel') }}</strong>
        <span>{{ currentChromePreparationPairLabel || t('settings.services.chromePreparation.invalidPair') }}</span>
      </p>
      <p>{{ t('settings.services.chromePreparation.sourceDescription') }}</p>
      <details>
        <summary>{{ t('settings.services.chromePreparation.helpSummary') }}</summary>
        <p>{{ t('settings.services.chromePreparation.helpBody') }}</p>
        <p>{{ t('settings.services.chromePreparation.helpLimitations') }}</p>
        <p><code>chrome://on-device-internals</code></p>
        <p class="chrome-preparation-help-links">
          <a href="https://developer.chrome.com/docs/ai/translator-api" target="_blank" rel="noreferrer">{{ t('settings.services.chromePreparation.helpApi') }}</a>
          <a href="https://developer.chrome.com/docs/ai/language-detection" target="_blank" rel="noreferrer">{{ t('settings.services.chromePreparation.helpDetector') }}</a>
          <a href="https://developer.chrome.com/docs/ai/debug-built-in-model" target="_blank" rel="noreferrer">{{ t('settings.services.chromePreparation.helpDebug') }}</a>
          <a href="https://chrome.dev/web-ai-demos/translation-language-detection-api-playground/" target="_blank" rel="noreferrer">{{ t('settings.services.chromePreparation.helpDemo') }}</a>
        </p>
      </details>
    </div>

    <template v-if="compute.showCustomOpenAI && customProvider">
      <div class="connection-field" data-testid="custom-service-name-row">
        <div class="connection-field-label"><strong>服务名称</strong><small>仅用于识别此接口</small></div>
        <div class="connection-field-control">
          <el-input
            :model-value="customProvider.name"
            aria-label="自定义服务名称"
            data-testid="custom-service-edit-name"
            placeholder="请输入服务名称"
            :maxlength="MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH"
            @update:model-value="updateCustomProvider('name', String($event))"
          />
        </div>
      </div>
      <div class="connection-field" data-testid="custom-service-endpoint-row">
        <div class="connection-field-label"><strong>接口地址</strong><small>OpenAI Chat Completions 兼容地址</small></div>
        <div class="connection-field-control">
          <el-input
            :model-value="customProvider.endpoint"
            aria-label="自定义服务接口地址"
            data-testid="custom-service-edit-endpoint"
            placeholder="http://localhost:11434/v1/chat/completions"
            :maxlength="MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH"
            @update:model-value="updateCustomProvider('endpoint', String($event))"
          />
        </div>
      </div>
    </template>

    <div v-if="service === services.deepL" class="connection-field" data-deepl-api-plan>
      <div class="connection-field-label">
        <strong>{{ t('settings.services.deepl.plan') }}</strong>
      </div>
      <div class="connection-field-control">
        <el-select v-model="config.deeplApiPlan" :aria-label="t('settings.services.deepl.plan')">
          <el-option value="free" :label="t('settings.services.deepl.free')" />
          <el-option value="pro" :label="t('settings.services.deepl.pro')" />
        </el-select>
        <p class="provider-field-help">{{ t('settings.services.deepl.planHelp') }}</p>
        <p class="provider-field-help" data-deepl-endpoint>
          {{ t('settings.services.deepl.endpoint') }}<br /><code>{{ deeplEndpoint }}</code>
        </p>
        <p v-if="config.proxy[service]?.trim()" class="provider-field-help" data-deepl-proxy-override>
          {{ t('settings.services.deepl.proxyOverride') }}
        </p>
      </div>
    </div>

    <div v-if="compute.showToken" class="connection-field credential-field">
      <div class="connection-field-label">
        <strong>API Key</strong>
        <small>{{ effectiveModelLabel || '当前模型' }}</small>
      </div>
      <div class="connection-field-control credential-control">
        <el-input v-model="config.token[service]" type="password" show-password placeholder="输入 API Key；留空表示尚未配置" />
        <div v-if="compute.showAI" class="api-key-requirement">
          <span>{{ compute.requireApiKey ? '此模型需要 API Key' : '允许无 Key 请求' }}</span>
          <el-switch v-model="compute.requireApiKey" aria-label="当前模型是否需要 API Key" size="small" />
        </div>
      </div>
    </div>
    <p v-if="compute.showMiniMaxRegion && minimaxKeyMismatch" class="minimax-key-note is-warning">
      {{ minimaxKeyMismatch }}
    </p>

    <el-row v-if="compute.showMiniMaxRegion" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="按量付费和 Token Plan 使用不同的账户权益；请按控制台中 Key 的来源选择。" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">MiniMax 计费方式<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
        </el-tooltip>
      </el-col>
      <el-col :span="12">
        <el-select v-model="config.minimaxBillingPlan" aria-label="MiniMax 计费方式" placeholder="请选择 MiniMax 计费方式">
          <el-option class="select-left" v-for="item in options.minimaxBillingPlan" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-col>
    </el-row>

    <el-row v-if="compute.showMiniMaxRegion" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="选择与 MiniMax Key 来源一致的 API 区域。Token Plan Key（sk-cp-）和按量付费 Key 不能互换。" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">MiniMax 区域<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
        </el-tooltip>
      </el-col>
      <el-col :span="12">
        <el-select v-model="config.minimaxRegion" aria-label="MiniMax API 区域" placeholder="请选择 MiniMax API 区域">
          <el-option class="select-left" v-for="item in options.minimaxRegion" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-col>
    </el-row>

    <div v-if="compute.showMiniMaxRegion" class="connection-field minimax-endpoint" data-minimax-endpoint>
      <div class="connection-field-label"><strong>当前 API 地址</strong></div>
      <div class="connection-field-control"><code>{{ minimaxEndpoint }}</code></div>
    </div>

    <p v-if="compute.showMiMoRegion && mimoKeyMismatch" class="mimo-key-note is-warning">
      {{ mimoKeyMismatch }}
    </p>

    <el-row v-if="compute.showMiMoRegion" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="按量付费和 Token Plan 使用不同的账户权益；请按小米 MiMo 控制台中 Key 的来源选择。" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">小米 MiMo 计费方式<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
        </el-tooltip>
      </el-col>
      <el-col :span="12">
        <el-select v-model="config.mimoBillingPlan" aria-label="小米 MiMo 计费方式" placeholder="请选择小米 MiMo 计费方式">
          <el-option class="select-left" v-for="item in options.mimoBillingPlan" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-col>
    </el-row>

    <el-row v-if="compute.showMiMoRegion" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="Token Plan 必须使用购买页面提供的集群地址；中国、新加坡和欧洲集群的 tp- Key 不能混用。按量付费统一使用 api.xiaomimimo.com。" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">MiMo API 集群<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
        </el-tooltip>
      </el-col>
      <el-col :span="12">
        <el-select v-model="config.mimoRegion" aria-label="小米 MiMo API 集群" placeholder="请选择小米 MiMo API 集群">
          <el-option class="select-left" v-for="item in options.mimoRegion" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-col>
    </el-row>

    <div v-if="compute.showMiMoRegion" class="connection-field mimo-endpoint" data-mimo-endpoint>
      <div class="connection-field-label"><strong>当前 API 地址</strong></div>
      <div class="connection-field-control"><code>{{ mimoEndpoint }}</code></div>
    </div>

    <div v-if="compute.showAzureOpenaiEndpoint" class="connection-field" data-azure-endpoint>
      <div class="connection-field-label">
        <strong>{{ t('settings.services.azure.endpoint') }}</strong>
      </div>
      <div class="connection-field-control">
        <el-input v-model="config.azureOpenaiEndpoint" :aria-label="t('settings.services.azure.endpoint')" placeholder="https://your-resource.services.ai.azure.com/openai/v1/" :class="{ 'input-error': config.azureOpenaiEndpoint && !isValidAzureEndpoint(config.azureOpenaiEndpoint) }" />
        <div v-if="config.azureOpenaiEndpoint && !isValidAzureEndpoint(config.azureOpenaiEndpoint)" class="error-text" role="alert">{{ t('settings.services.azure.endpointError') }}</div>
        <p class="provider-field-help">{{ t('settings.services.azure.endpointHelp') }}</p>
        <p class="provider-field-help">{{ t('settings.services.azure.deploymentHelp') }}</p>
      </div>
    </div>

    <el-row v-if="compute.showDeepLX" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="DeepLX API 服务地址，默认为本地地址。如果使用远程 DeepLX 服务，请修改为对应的服务地址" placement="top-start" :show-after="500"><span class="popup-text popup-vertical-left">服务地址</span></el-tooltip>
      </el-col>
      <el-col :span="12"><el-input v-model="config.deeplx" placeholder="http://localhost:1188/translate" /></el-col>
    </el-row>

    <el-row v-if="compute.showAkSk" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="服务商提供的访问密钥。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">API Key<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.ak" placeholder="请输入Access Key" /></el-col>
    </el-row>
    <el-row v-if="compute.showAkSk" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="服务商提供的私密密钥，请妥善保管。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">Secret Key<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.sk" type="password" placeholder="请输入Secret Key" /></el-col>
    </el-row>

    <el-row v-if="compute.showYoudao" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="有道翻译服务提供的 App Key。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">App Key<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.youdaoAppKey" placeholder="有道 AppKey" /></el-col>
    </el-row>
    <el-row v-if="compute.showYoudao" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="有道翻译服务提供的 App Secret。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">App Secret<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.youdaoAppSecret" type="password" show-password placeholder="有道 AppSecret" /></el-col>
    </el-row>

    <el-row v-if="compute.showTencent" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="腾讯云翻译服务提供的 SecretId。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">Secret ID<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.tencentSecretId" placeholder="腾讯云 SecretId" /></el-col>
    </el-row>
    <el-row v-if="compute.showTencent" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="腾讯云翻译服务提供的 SecretKey。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">Secret Key<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.tencentSecretKey" type="password" show-password placeholder="腾讯云 SecretKey" /></el-col>
    </el-row>

    <el-row v-if="compute.showNewAPI" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="填写 New API 服务的接口地址。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">NewAPI接口<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-input v-model="config.newApiUrl" placeholder="请输入您的New API接口地址" /></el-col>
    </el-row>

    <details v-if="compute.showAI" class="custom-advanced-settings" data-testid="custom-service-advanced">
      <summary>
        <strong>高级设置</strong>
        <svg class="advanced-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </summary>

      <div class="custom-advanced-content">
        <div v-if="compute.showModel" class="connection-field" data-testid="model-thinking-control">
          <div class="connection-field-label">
            <strong>Thinking</strong>
            <small>{{ effectiveModelLabel || '当前模型' }}</small>
          </div>
          <div class="connection-field-control model-thinking-setting">
            <small>默认关闭；仅在已适配接口生效，无法关闭时使用最低档</small>
            <el-switch
              :model-value="selectedModelThinking"
              :disabled="!effectiveModelLabel"
              aria-label="当前模型是否启用 Thinking"
              @update:model-value="$emit('update:model-thinking', Boolean($event))"
            />
          </div>
        </div>

        <el-row v-if="compute.showProxy" class="margin-bottom margin-left-2em">
          <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="可选的代理地址；填写后，当前 AI 服务请求会优先发送到这里。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">代理地址<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
          <el-col :span="12"><el-input v-model="config.proxy[service]" placeholder="默认直连自定义接口" /></el-col>
        </el-row>

        <div class="custom-template-heading">
          <div>
            <strong>请求模板</strong>
            <small>修改会自动保存到当前 AI 服务；可用变量可以一键插入。</small>
          </div>
          <el-button type="primary" link size="small" @click="resetCustomTemplate">恢复默认模板</el-button>
        </div>

        <div class="prompt-template-list" data-testid="prompt-template-list">
          <PromptTemplateEditor v-model="config.system_role[service]" role="system" />
          <PromptTemplateEditor v-model="config.user_role[service]" role="user" />
        </div>

        <el-row v-if="compute.showCustomBody" class="margin-bottom margin-left-2em">
          <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="填写要合并到翻译请求中的 JSON 参数对象。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">自定义请求体<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
          <el-col :span="12">
            <el-input v-model="config.customBody[service]" :class="{ 'input-error': !isValidCustomBody(config.customBody[service]) }" placeholder='例如：{"thinking": {"type": "disabled"}}' />
            <div v-if="!isValidCustomBody(config.customBody[service])" class="error-text">请输入合法的 JSON 对象，否则该配置将被忽略</div>
          </el-col>
        </el-row>
      </div>
    </details>

    <el-row v-if="compute.showDeepseekApiType" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="选择 DeepSeek 接口使用的 API 格式。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">API 格式<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12"><el-select v-model="config.deepseekApiType" placeholder="请选择 API 格式"><el-option class="select-left" v-for="item in options.deepseekApiType" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-col>
    </el-row>
    <el-row v-if="compute.showCustomBody && !compute.showAI" class="margin-bottom margin-left-2em">
      <el-col :span="12" class="lightblue rounded-corner"><el-tooltip effect="dark" content="填写要合并到翻译请求中的 JSON 参数对象。" placement="top-start" :show-after="300"><span class="popup-text popup-vertical-left">自定义请求体<el-icon class="icon-margin"><InfoFilled /></el-icon></span></el-tooltip></el-col>
      <el-col :span="12">
        <el-input v-model="config.customBody[service]" :class="{ 'input-error': !isValidCustomBody(config.customBody[service]) }" placeholder='例如：{"thinking": {"type": "disabled"}}' />
        <div v-if="!isValidCustomBody(config.customBody[service])" class="error-text">请输入合法的 JSON 对象，否则该配置将被忽略</div>
      </el-col>
    </el-row>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import type { Config } from '@/src/core/config/model'
import type { TranslationParams } from '@/src/core/i18n'
import { defaultOption, options as optionConfig, resolveConfiguredModel, services } from '@/src/core/config/catalog'
import {
  MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH,
  MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH,
  type CustomOpenAIProvider,
} from '@/src/core/config/customOpenAI'
import { isValidCustomBody } from '@/src/core/config/customBody'
import { normalizeMyMemoryEmail } from '@/src/core/config/freeTranslation'
import { getDeepLEndpoint } from '@/src/core/config/deepl'
import browser from 'webextension-polyfill'
import { requestConfigSave, waitForConfigPersistenceQueue } from '@/src/services/config/store'
import { CONNECTION_TEST_MESSAGE, getMimoEndpoint, MINIMAX_ENDPOINTS } from '@/src/core/config/constants'
import { chromeTranslationPreparationStore } from '@/src/platform/browser/chromeTranslationPreparationRequest'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
    ChromeTranslationPreparationError,
    getChromeTranslationPreparationLanguageLabel,
    prepareChromeTranslationInPage,
    resolveChromeTranslationPreparationPair,
    type ChromeTranslationPreparationErrorCode,
    type ChromeTranslationPreparationPair,
    type ChromeTranslationPreparationStatus,
} from '@/src/features/settings/model/chromeTranslationPreparation'
import { useUiI18n } from '@/src/ui/i18n'
import PromptTemplateEditor from './PromptTemplateEditor.vue'
import FreeTranslationSettings from './FreeTranslationSettings.vue'

const props = defineProps<{
  config: Config
  service: string
  selectedModelThinking: boolean
  compute: Record<string, any>
  options: typeof optionConfig
  isValidAzureEndpoint: (endpoint: string) => boolean
  customProvider?: CustomOpenAIProvider
}>()

const emit = defineEmits<{
  'update:model-thinking': [value: boolean]
  'update:custom-provider': [patch: Partial<Pick<CustomOpenAIProvider, 'name' | 'endpoint'>>]
  'delete:custom-provider': []
}>()

const config = toRef(props, 'config')
const service = toRef(props, 'service')
const compute = toRef(props, 'compute')
const options = toRef(props, 'options')
const isValidAzureEndpoint = toRef(props, 'isValidAzureEndpoint')
const customProvider = toRef(props, 'customProvider')
const { language, t } = useUiI18n()
const myMemoryEmailDraft = ref(config.value.myMemoryEmail)
const myMemoryEmailInvalid = computed(() => Boolean(myMemoryEmailDraft.value.trim() && !normalizeMyMemoryEmail(myMemoryEmailDraft.value)))
watch(() => config.value.myMemoryEmail, value => { myMemoryEmailDraft.value = value })

function commitMyMemoryEmail(): void {
  if (myMemoryEmailInvalid.value) return
  config.value.myMemoryEmail = normalizeMyMemoryEmail(myMemoryEmailDraft.value)
}

const deeplEndpoint = computed(() => config.value.proxy[service.value]?.trim() || getDeepLEndpoint(config.value.deeplApiPlan))
const pendingChromePreparation = ref<Awaited<ReturnType<typeof chromeTranslationPreparationStore.get>>>(null)
let pendingChromePreparationRevision = 0
let chromePreparationMounted = true
void chromeTranslationPreparationStore.get().then((request) => {
  if (chromePreparationMounted && pendingChromePreparationRevision === 0) pendingChromePreparation.value = request
})
const stopChromePreparationPendingWatch = chromeTranslationPreparationStore.subscribe((request) => {
  pendingChromePreparationRevision += 1
  pendingChromePreparation.value = request
})
const effectiveModelLabel = computed(() => resolveConfiguredModel(
  config.value.model[service.value],
  config.value.customModel[service.value],
))

function updateCustomProvider(field: 'name' | 'endpoint', value: string): void {
  emit('update:custom-provider', {[field]: value})
}

const minimaxKeyKind = computed(() => {
  const token = config.value.token[service.value]?.trim() || ''
  return token.startsWith('sk-cp-') ? 'token-plan' : token ? 'other' : 'empty'
})

const minimaxKeyMismatch = computed(() => {
  if (minimaxKeyKind.value === 'empty') return ''
  if (config.value.minimaxBillingPlan === 'token-plan' && minimaxKeyKind.value !== 'token-plan') {
    return '当前选择的是 Token Plan，但 Key 不是 sk-cp- 开头；请确认 Key 来源，Token Plan 订阅必须有效。'
  }
  if (config.value.minimaxBillingPlan === 'payg' && minimaxKeyKind.value === 'token-plan') {
    return '当前选择的是按量付费，但检测到 sk-cp- Token Plan Key；两类 Key 不能互换，请切换计费方式或更换 Key。'
  }
  return config.value.minimaxBillingPlan === 'token-plan'
    ? '当前使用 Token Plan Key；请确认 Token Plan 订阅有效。'
    : ''
})

const minimaxEndpoint = computed(() => {
  const plan = config.value.minimaxBillingPlan === 'token-plan' ? 'token-plan' : 'payg'
  const region = config.value.minimaxRegion === 'cn' ? 'cn' : 'global'
  return MINIMAX_ENDPOINTS[plan][region]
})

const mimoKeyKind = computed(() => {
  const token = config.value.token[service.value]?.trim() || ''
  if (token.startsWith('tp-')) return 'token-plan'
  if (token.startsWith('sk-')) return 'payg'
  return token ? 'other' : 'empty'
})

const mimoKeyMismatch = computed(() => {
  if (mimoKeyKind.value === 'empty') return ''
  if (config.value.mimoBillingPlan === 'token-plan' && mimoKeyKind.value !== 'token-plan') {
    return '当前选择的是 MiMo Token Plan，但 Key 不是 tp- 开头；请确认 Key 来源和订阅状态。'
  }
  if (config.value.mimoBillingPlan === 'payg' && mimoKeyKind.value === 'token-plan') {
    return '当前选择的是 MiMo 按量付费，但检测到 tp- Token Plan Key；两类 Key 不能互换，请切换计费方式或更换 Key。'
  }
  if (config.value.mimoBillingPlan === 'payg' && mimoKeyKind.value === 'other') {
    return 'MiMo 按量付费 Key 通常以 sk- 开头；请确认 Key 来自 API Keys 页面。'
  }
  return config.value.mimoBillingPlan === 'token-plan'
    ? '当前使用 MiMo Token Plan Key；请确认订阅仍在有效期内。'
    : ''
})

const mimoEndpoint = computed(() => {
  return getMimoEndpoint(config.value.mimoBillingPlan, config.value.mimoRegion)
})

type ConnectionTestState = 'idle' | 'testing' | 'success' | 'error'
type LocalizedConnectionTestMessage = {
  readonly key: string
  readonly params?: TranslationParams
}

const CHROME_PREPARATION_TIMEOUT_MS = 300_000
const CHROME_PREPARATION_ERROR_KEYS: Readonly<Record<ChromeTranslationPreparationErrorCode, string>> = {
  'invalid-language-code': 'settings.services.chromePreparation.error.invalidLanguageCode',
  'sample-unavailable': 'settings.services.chromePreparation.error.sampleUnavailable',
  aborted: 'settings.services.chromePreparation.error.aborted',
  'invalid-detection': 'settings.services.chromePreparation.error.invalidDetection',
  'api-unavailable': 'settings.services.chromePreparation.error.apiUnavailable',
  'user-activation-required': 'settings.services.chromePreparation.error.userActivationRequired',
  'unsupported-pair': 'settings.services.chromePreparation.error.unsupportedPair',
  'detection-mismatch': 'settings.services.chromePreparation.error.detectionMismatch',
  'invalid-translation': 'settings.services.chromePreparation.error.invalidTranslation',
  'preparation-failed': 'settings.services.chromePreparation.error.failed',
  'model-unavailable': 'settings.services.chromePreparation.error.modelUnavailable',
}
const connectionTestBusy = ref(false)
const connectionTestState = ref<ConnectionTestState>('idle')
const connectionTestMessageState = ref<LocalizedConnectionTestMessage | string | null>(null)
const connectionTestMessage = computed(() => {
  const message = connectionTestMessageState.value
  if (!message) return ''
  return typeof message === 'string' ? message : t(message.key, message.params)
})
const connectionTestDetails = computed(() => {
  const message = connectionTestMessageState.value
  if (!message || typeof message === 'string' || !message.params?.detail) return ''
  return String(message.params.detail)
})
const isChromeConnectionTest = computed(() => service.value === services.chromeTranslator)
const displayedChromePreparationPair = ref<ChromeTranslationPreparationPair | null>(null)
const currentChromePreparationPair = computed(() => {
  try {
    const fallbackPair = resolveChromeTranslationPreparationPair('auto', config.value.to)
    const configuredFrom = config.value.from.trim().toLowerCase()
    const pendingSource = configuredFrom === 'auto'
      && pendingChromePreparation.value?.targetLanguage === fallbackPair.targetLanguage
      ? pendingChromePreparation.value.sourceLanguage
      : undefined
    return resolveChromeTranslationPreparationPair(pendingSource || config.value.from, config.value.to)
  } catch {
    return null
  }
})
const currentChromePreparationPairLabel = computed(() => {
  const pair = displayedChromePreparationPair.value || currentChromePreparationPair.value
  if (!pair) return ''
  return `${getChromeTranslationPreparationLanguageLabel(pair.sourceLanguage, language.value)}（${pair.sourceLanguage}） → ${getChromeTranslationPreparationLanguageLabel(pair.targetLanguage, language.value)}（${pair.targetLanguage}）`
})
let connectionTestGeneration = 0
let activeChromePreparation: AbortController | undefined
const connectionTestTitle = computed(() => {
  if (isChromeConnectionTest.value) {
    return connectionTestState.value === 'testing'
      ? t('settings.services.chromePreparation.titlePreparing')
      : connectionTestState.value === 'success'
        ? t('settings.services.chromePreparation.titleReady')
        : t('settings.services.chromePreparation.titleIncomplete')
  }
  return connectionTestState.value === 'testing'
    ? '检查中'
    : connectionTestState.value === 'success' ? '连接正常' : '连接失败'
})

function resetConnectionTest(): void {
  displayedChromePreparationPair.value = null
  connectionTestState.value = 'idle'
  connectionTestMessageState.value = null
}

function invalidateConnectionTest(): void {
  connectionTestGeneration += 1
  activeChromePreparation?.abort()
  activeChromePreparation = undefined
  connectionTestBusy.value = false
  resetConnectionTest()
}

function localizedConnectionTestMessage(
  key: string,
  params?: TranslationParams,
): LocalizedConnectionTestMessage {
  return {key, ...(params ? {params} : {})}
}

function formatChromePreparationStatus(status: ChromeTranslationPreparationStatus): LocalizedConnectionTestMessage {
  const params = {
    sourceLanguage: status.sourceLanguage,
    targetLanguage: status.targetLanguage,
  }
  if (status.phase === 'downloading') {
    const model = status.model === 'language-detector'
      ? t('settings.services.chromePreparation.modelDetector')
      : t('settings.services.chromePreparation.modelTranslator')
    return localizedConnectionTestMessage(
      typeof status.loaded === 'number'
        ? 'settings.services.chromePreparation.statusDownloadingProgress'
        : 'settings.services.chromePreparation.statusDownloading',
      {
        ...params,
        model,
        ...(typeof status.loaded === 'number' ? {percentage: Math.round(status.loaded * 100)} : {}),
      },
    )
  }
  if (status.phase === 'verifying') {
    return localizedConnectionTestMessage('settings.services.chromePreparation.statusVerifying', params)
  }
  return localizedConnectionTestMessage('settings.services.chromePreparation.statusInitializing', params)
}

function formatChromePreparationError(error: unknown): LocalizedConnectionTestMessage | string {
  if (error instanceof ChromeTranslationPreparationError) {
    return localizedConnectionTestMessage(CHROME_PREPARATION_ERROR_KEYS[error.code], error.params)
  }
  return error instanceof Error ? error.message : String(error)
}

async function testConnection(): Promise<void> {
  if (connectionTestBusy.value) return

  const testedService = service.value
  const generation = ++connectionTestGeneration
  const chromeController = testedService === services.chromeTranslator ? new AbortController() : undefined
  if (chromeController) activeChromePreparation = chromeController
  let chromePreparationTimedOut = false
  const chromePreparationTimer = chromeController ? window.setTimeout(() => {
    chromePreparationTimedOut = true
    chromeController.abort()
  }, CHROME_PREPARATION_TIMEOUT_MS) : undefined
  const isCurrent = () => generation === connectionTestGeneration
  let acceptChromePreparationStatus = true
  connectionTestBusy.value = true
  connectionTestState.value = 'testing'
  connectionTestMessageState.value = testedService === services.chromeTranslator
    ? localizedConnectionTestMessage('settings.services.chromePreparation.statusStarting')
    : '正在保存当前配置并请求服务…'

  let chromePreparation: Promise<{ok: true; result: Awaited<ReturnType<typeof prepareChromeTranslationInPage>>} | {ok: false; error: unknown}> | undefined
  try {
    // Chrome 的模型下载要求用户激活；必须在 click handler 的首个 await 前直接调用。
    if (testedService === services.chromeTranslator) {
      const pair = currentChromePreparationPair.value
      if (!pair) throw new ChromeTranslationPreparationError('invalid-language-code', 'Chrome 本地翻译语言代码无效', {field: 'from/to'})
      displayedChromePreparationPair.value = pair
      chromePreparation = prepareChromeTranslationInPage({
        from: pair.sourceLanguage,
        to: pair.targetLanguage,
        signal: chromeController?.signal,
        onStatus(status) {
          if (acceptChromePreparationStatus && isCurrent()) {
            connectionTestMessageState.value = formatChromePreparationStatus(status)
          }
        },
      }).then(
        (result) => ({ok: true as const, result}),
        (error) => ({ok: false as const, error}),
      )
    }
    await waitForConfigPersistenceQueue()
    await requestConfigSave(config.value, browser.runtime.sendMessage.bind(browser.runtime))
    if (!isCurrent()) return
    if (chromePreparation) {
      const outcome = await chromePreparation
      if (!isCurrent()) return
      if (!outcome.ok) throw outcome.error
      await chromeTranslationPreparationStore.clear({
        sourceLanguage: outcome.result.sourceLanguage,
        targetLanguage: outcome.result.targetLanguage,
      })
      if (!isCurrent()) return
      connectionTestState.value = 'success'
      connectionTestMessageState.value = localizedConnectionTestMessage(
        'settings.services.chromePreparation.success',
        {
          sourceLanguage: outcome.result.sourceLanguage,
          targetLanguage: outcome.result.targetLanguage,
        },
      )
    } else {
      const response = await browser.runtime.sendMessage({
        type: CONNECTION_TEST_MESSAGE,
        service: testedService,
      }) as {success?: boolean; durationMs?: number; error?: string} | undefined

      if (!response?.success) {
        throw new Error(response?.error || '连接测试失败')
      }

      connectionTestState.value = 'success'
      connectionTestMessageState.value = `已完成真实翻译请求${typeof response.durationMs === 'number' ? `（${response.durationMs} ms）` : ''}。`
    }
  } catch (error) {
    if (!isCurrent()) return
    connectionTestState.value = 'error'
    connectionTestMessageState.value = chromePreparationTimedOut
      ? localizedConnectionTestMessage('settings.services.chromePreparation.error.timeout')
      : formatChromePreparationError(error)
  } finally {
    acceptChromePreparationStatus = false
    if (chromePreparationTimer !== undefined) window.clearTimeout(chromePreparationTimer)
    chromeController?.abort()
    if (isCurrent()) {
      if (activeChromePreparation === chromeController) activeChromePreparation = undefined
      connectionTestBusy.value = false
    }
  }
}

function resetCustomTemplate(): void {
  void ElMessageBox.confirm(
    '确定要恢复当前 AI 服务的默认 system 和 user 模板吗？此操作会覆盖当前模板。',
    '恢复默认模板',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    },
  ).then(() => {
    config.value.system_role[service.value] = defaultOption.system_role
    config.value.user_role[service.value] = defaultOption.user_role
    ElMessage.success('已恢复当前 AI 服务默认模板')
  }).catch(() => {
    // 用户取消操作，不做任何处理。
  })
}

function confirmDeleteProvider(): void {
  const providerName = customProvider.value?.name || '此自定义服务'
  void ElMessageBox.confirm(
    `确定要删除“${providerName}”吗？相关模型和连接配置也会一并清理。`,
    '删除自定义服务',
    {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
      type: 'warning',
    },
  ).then(() => emit('delete:custom-provider')).catch(() => {
    // 用户取消删除，不修改配置。
  })
}

watch(service, invalidateConnectionTest)
watch(() => [config.value.from, config.value.to], invalidateConnectionTest)
onBeforeUnmount(() => {
  chromePreparationMounted = false
  connectionTestGeneration += 1
  activeChromePreparation?.abort()
  activeChromePreparation = undefined
  stopChromePreparationPendingWatch()
})
</script>

<style scoped>
.official-translation-help { margin: 12px 0 16px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.official-translation-help p { margin: 0 0 8px; }
.official-translation-help a { color: var(--el-color-primary); }

.chrome-preparation-help {
  margin: 8px 0 16px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.chrome-preparation-help p {
  margin: 0 0 8px;
}

.chrome-preparation-help summary {
  cursor: pointer;
  color: var(--el-text-color-primary);
}

.chrome-preparation-help-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}

.chrome-preparation-help-links a {
  color: var(--el-color-primary);
}

.chrome-preparation-pair {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--el-text-color-primary);
}

.connection-test-details {
  grid-column: 1 / -1;
  min-width: 0;
  margin-top: 6px;
}

.connection-test-details code {
  display: block;
  margin-top: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.credential-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 16px;
  padding: 11px 13px;
  border: 1px solid #f3d19e;
  border-radius: 10px;
  color: #8a5a00;
  background: #fdf6ec;
  font-size: 12px;
  line-height: 1.5;
  animation: credential-warning-breathe 2.8s ease-in-out infinite;
}

.subsection-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 4px;
}

.subsection-heading > div:first-child {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 9px;
}

.connection-test-hint {
  color: #9098a8;
  font-size: 11px;
  font-weight: 400;
}

.setup-status {
  flex: 0 0 auto;
  padding: 3px 8px;
  border-radius: 999px;
  color: #287447;
  background: #edf8f1;
  font-size: 10px;
  font-weight: 750;
}

.setup-status.is-warning { color: #98600a; background: #fff5df; }

.connection-field {
  display: grid;
  grid-template-columns: minmax(150px, 190px) minmax(240px, 1fr);
  align-items: center;
  gap: 20px;
  min-height: 54px;
  padding: 10px 0;
  border-bottom: 1px solid #edf0f5;
}

.connection-field-label { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.connection-field-label strong { color: #263044; font-size: 12px; font-weight: 700; }
.connection-field-label small { overflow: hidden; color: #9299a8; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.connection-field-control { min-width: 0; }
.provider-field-help {
  margin: 6px 0 0;
  color: var(--muted, #6d7890);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.provider-field-help code { font-size: inherit; }
.model-thinking-setting { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.model-thinking-setting > small { color: #9098a8; font-size: 10px; line-height: 1.5; }
.model-thinking-setting :deep(.el-switch) { flex: 0 0 auto; --el-switch-on-color: #ef4776; --el-switch-off-color: #cfd5df; }
.connection-field-control :deep(.el-input),
.connection-field-control :deep(.el-select) { width: 100% !important; max-width: none !important; }
.credential-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 12px; }
.api-key-requirement { display: flex; align-items: center; gap: 8px; color: #747d8e; font-size: 10px; white-space: nowrap; }
.api-key-requirement :deep(.el-switch) { --el-switch-on-color: #ef4776; --el-switch-off-color: #cfd5df; }
.field-warning { grid-column: 1 / -1; color: #9a6208; font-size: 10px; text-align: right; }

.service-connection-section :deep(.el-row) {
  display: flex !important;
  gap: 20px;
  min-height: 50px !important;
  margin: 0 !important;
  padding: 9px 0 !important;
  border: 0 !important;
  border-bottom: 1px solid #edf0f5 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
.service-connection-section :deep(.el-row > .el-col:first-child) { max-width: 190px; flex: 0 0 190px; }
.service-connection-section :deep(.el-row > .el-col:last-child) { width: auto; max-width: none; flex: 1 1 auto; }
.service-connection-section :deep(.el-row > .el-col:last-child > .el-input),
.service-connection-section :deep(.el-row > .el-col:last-child > .el-select),
.service-connection-section :deep(.settings-control-field > .el-input),
.service-connection-section :deep(.settings-control-field > .el-select) { width: 100% !important; max-width: none !important; }

.custom-template-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin: 6px 0 10px;
  padding-top: 14px;
  border-top: 1px solid #eceef3;
}

.custom-template-heading > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.custom-template-heading strong {
  color: #46526a;
  font-size: 12px;
}

.custom-template-heading small {
  color: #9098a8;
  font-size: 11px;
  line-height: 1.5;
}

.prompt-template-list {
  display: grid;
  gap: 12px;
  margin-bottom: 12px;
}

.connection-test-button {
  flex: 0 0 auto;
  align-self: flex-start;
  margin-left: auto;
  padding: 8px 14px;
  border: 1px solid #ef4776;
  border-radius: 9px;
  color: #c52f58;
  background: #fff4f7;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: 160ms ease;
}

.detail-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.delete-service-button {
  padding: 8px 12px;
  border: 1px solid #e2a4b5;
  border-radius: 9px;
  color: #ad3657;
  background: #fff;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.delete-service-button:hover { border-color: #d9345e; background: #fff1f4; }

.custom-advanced-settings {
  margin-top: 14px;
  border: 0;
  background: transparent;
}

.custom-advanced-settings summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 8px 0;
  color: var(--ink, #263044);
  cursor: pointer;
  list-style: none;
}

.custom-advanced-settings summary::-webkit-details-marker { display: none; }
.custom-advanced-settings summary strong { font-size: 12px; font-weight: 600; }
.custom-advanced-settings summary:hover { color: var(--brand, #ef4776); }
.custom-advanced-settings summary:focus-visible { outline: 2px solid var(--brand, #ef4776); outline-offset: 3px; border-radius: 4px; }
.advanced-chevron { width: 16px; height: 16px; flex: none; color: var(--muted, #8993a5); transition: transform 150ms ease; }
.custom-advanced-settings[open] .advanced-chevron { transform: rotate(180deg); }
.custom-advanced-content { padding: 0 0 12px; border-top: 1px solid var(--line, #eceef3); }

.connection-test-button:hover:not(:disabled) {
  color: #fff;
  background: #ef4776;
  box-shadow: 0 6px 14px rgba(214, 50, 96, .18);
}

.connection-test-button:disabled {
  cursor: wait;
  opacity: .65;
}

.connection-test-result {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid #dfe3eb;
  border-radius: 10px;
  color: #667187;
  background: #f7f8fa;
  font-size: 12px;
  line-height: 1.5;
}

.connection-test-result > strong {
  white-space: nowrap;
}

.connection-test-result > span {
  overflow-wrap: anywhere;
}

.connection-test-result.is-testing {
  border-color: #c9d9f3;
  color: #45628c;
  background: #f2f7ff;
}

.connection-test-result.is-success {
  border-color: #b8e0cb;
  color: #287447;
  background: #effaf3;
}

.connection-test-result.is-error {
  border-color: #f2c0ca;
  color: #a52c48;
  background: #fff1f4;
}

.minimax-key-note {
  margin: -8px 0 14px 2em;
  color: #6d7890;
  font-size: 11px;
  line-height: 1.5;
}

.mimo-key-note {
  margin: -8px 0 14px 2em;
  color: #6d7890;
  font-size: 11px;
  line-height: 1.5;
}

.minimax-key-note.is-warning {
  color: #a52c48;
}

.mimo-key-note.is-warning {
  color: #a52c48;
}

.minimax-endpoint code,
.mimo-endpoint code {
  display: block;
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--surface-soft, #f7f8fb);
  overflow-wrap: anywhere;
  color: var(--muted, #59657b);
  font-size: 11px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}


@media (max-width: 700px) {
  .subsection-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .subsection-heading > div:first-child {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }

  .connection-test-button {
    width: 100%;
    margin-left: 0;
  }

  .detail-actions { width: 100%; margin-left: 0; }
  .detail-actions > button { flex: 1; }

  .custom-template-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .connection-field { grid-template-columns: 1fr; gap: 7px; }
  .credential-control { grid-template-columns: 1fr; }
  .api-key-requirement { justify-content: flex-start; }
  .field-warning { grid-column: auto; text-align: left; }
  .connection-field-label small { white-space: normal; }
  .service-connection-section :deep(.el-row) { gap: 7px; flex-direction: column; }
  .service-connection-section :deep(.el-row > .el-col:first-child),
  .service-connection-section :deep(.el-row > .el-col:last-child) { width: 100%; max-width: none; flex: 0 0 auto; }
}

.credential-warning strong {
  flex: 0 0 auto;
  font-weight: 750;
}

@keyframes credential-warning-breathe {
  0%, 100% { border-color: #f3d19e; box-shadow: 0 0 0 0 rgba(243, 209, 158, 0); }
  50% { border-color: #e8b468; box-shadow: 0 0 0 4px rgba(243, 209, 158, .2); }
}

@media (prefers-reduced-motion: reduce) {
  .credential-warning { animation: none; }
  .advanced-chevron { transition: none; }
}

.api-key-policy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 10px;
  padding: 12px 16px;
  border: 1px solid #edf0f5;
  border-radius: 16px;
  background: #fbfcfe;
  transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
}

.api-key-policy:hover {
  border-color: #e5b4c2;
  background: #fff;
  box-shadow: 0 8px 22px rgba(31, 40, 61, .04);
}

.api-key-policy-copy {
  min-width: 0;
}

.api-key-policy-title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: #172033;
  font-size: 13px;
}

.api-key-policy-title strong {
  font-weight: 650;
}

.api-key-policy-title .el-icon {
  color: #8b93a4;
  font-size: 13px;
}

.api-key-policy-status {
  display: inline-flex;
  align-items: center;
  margin-left: 3px;
  padding: 2px 7px;
  border: 1px solid #f4c5d2;
  border-radius: 999px;
  color: #c52f58;
  background: #fff2f5;
  font-size: 10px;
  font-weight: 750;
  line-height: 1.3;
}

.api-key-policy-status.is-off {
  border-color: #dfe3eb;
  color: #687286;
  background: #f5f6f8;
}

.api-key-policy-model {
  display: block;
  max-width: 100%;
  margin-top: 4px;
  overflow: hidden;
  color: #909399;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-key-policy :deep(.el-switch) {
  flex: 0 0 auto;
  --el-switch-on-color: #ef4776;
  --el-switch-off-color: #cfd5df;
}

:global(:root.dark .credential-warning) { border-color: #735c31; color: #f2d28f; background: #392f1f; }
:global(:root.dark .custom-advanced-settings) { background: transparent; }
:global(:root.dark .custom-advanced-settings summary) { color: var(--ink); }
:global(:root.dark .custom-advanced-content),
:global(:root.dark .custom-template-heading) { border-color: var(--line); }
:global(:root.dark .custom-template-heading strong),
:global(:root.dark .api-key-policy-title),
:global(:root.dark .connection-field-label strong) { color: var(--ink); }
:global(:root.dark .custom-template-heading small),
:global(:root.dark .custom-advanced-settings summary small),
:global(:root.dark .connection-test-hint),
:global(:root.dark .model-thinking-setting > small),
:global(:root.dark .api-key-policy-model),
:global(:root.dark .minimax-key-note),
:global(:root.dark .mimo-key-note),
:global(:root.dark .minimax-endpoint),
:global(:root.dark .mimo-endpoint) { color: var(--muted); }
:global(:root.dark .connection-field),
:global(:root.dark .service-connection-section .el-row) { border-color: var(--line) !important; }
:global(:root.dark .connection-test-button) { border-color: rgba(255, 138, 171, .52); color: var(--brand-strong); background: var(--brand-soft); }
:global(:root.dark .connection-test-result),
:global(:root.dark .api-key-policy) { border-color: var(--line); color: var(--muted); background: var(--surface-soft); }
:global(:root.dark .api-key-policy:hover) { border-color: rgba(255, 138, 171, .42); background: var(--surface); }
:global(:root.dark .connection-test-result.is-testing) { border-color: #405477; color: #b9cff2; background: #202c40; }
:global(:root.dark .connection-test-result.is-success) { border-color: #31594d; color: #9edcc8; background: #1c342d; }
:global(:root.dark .connection-test-result.is-error) { border-color: #6f3949; color: #f1a7bc; background: #3c222b; }
</style>
