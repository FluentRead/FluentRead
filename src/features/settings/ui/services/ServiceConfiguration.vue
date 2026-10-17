<!--
 * @file src/features/settings/ui/services/ServiceConfiguration.vue
 * 文件职责：渲染当前翻译服务的详细连接配置：连接字段（密钥、区域、端点等）直接排在服务标题下方、不再单设“连接与密钥”标题，输入下方是添加密钥与密钥使用方式；其后用模型偏好、提示词、请求限制、接口兼容几个页签显示代理、密钥要求、提示词、自定义请求体与请求头、按域名移除来源头等字段，以及服务和模型的独立请求限制；只有一个页签的服务改用小节标题。
 * 主要内容：提示 MiMo 官方端点退役编号的请求兼容与新计费规则；Safari 免费连接检查只包含已授权线路，权限读取失败与未授权分别显示可响应语言包的安全状态；组件派生字段可见性与连接示例，密钥列表始终展示全部已保存的密钥并区分参与请求与备用的行，密钥要求放在接口兼容页签，提示词可在确认后一键同步到所有 AI 服务；原生支持多文本的服务在请求限制中独立编辑默认开启的合并请求开关，当前模型限额按自定义请求体覆盖后的真实模型显示、读取和保存，保留其他模型限额；将成对密钥 ID 同步到 apiKeys 和兼容 token，区分缺少必填 Key 与允许匿名的连接检查并管理等待超时；免费翻译检查完整目录中的已授权服务并逐服务展示结果，Chrome 在点击时准备当前语言对并用进度条显示模型下载比例，通过配置 store 提交修改；有效修复链接首次进入且未发生用户聚焦时直达连接按钮或当前标题；所有服务可手动停止等待；错误只保留共享诊断分类与可操作下一步，禁止展示原始错误详情，手动重试与字段定位保留当前选择；隐藏、缓存停用或配置变化取消所属等待，Chrome 状态只在活跃服务订阅，恢复、同步模板和删除共用当前操作所属确认，同步复验来源并按确认时刻重算目标。
 * 状态本地化：逐密钥、逐免费服务及独立失败状态保留安全资源 key，在展示时响应语言选择与异步语言包更新，不重新请求服务或翻译供应商原始错误。
 * 模块边界：组合服务交给独立草稿表单编辑，不展示普通服务的模型或凭据页签；无成员禁止连接测试，组合与各成员配置修改使旧测试失效，测试等待不早于逐路预算与整轮上限；本地模型设置只在对应服务首次呈现时异步加载，实例归属与后台下载由子组件维持；ChatGPT 套餐公开构建不渲染配置或确认窗口、不加载登录子模块，并停用全部设置动作，显式开发模式才通过独立子组件连接本机助手，不显示通用凭据或接口覆写；本组件不执行网页正文翻译或保存公开配置中的明文凭据；Chrome 内置翻译仅在当前点击页完成模型自检，其他连接测试经后台消息，字段规则来自 core/config，服务切换由 ServiceCatalog 和 SettingsSections 负责。
 -->
<template>
  <template v-if="!publicPlanBlocked">
  <section
    ref="configurationRoot"
    tabindex="-1"
    class="settings-section service-connection-section"
    :data-service-configuration-service="service"
    :data-custom-service-configuration="compute.showCustomOpenAI ? 'true' : 'false'"
    :data-ai-advanced-settings="compute.showAI && !publicPlanBlocked ? 'true' : 'false'"
  >
    <CompositeTranslationSettings v-if="isCompositeService" :key="service" :active="active" :config="config" :service="service" @remove="$emit('remove:service', service)" />
    <p v-if="isCompositeService && !compositeProvider?.services.length" class="configuration-scope" data-composite-test-empty role="status">{{ t('settings.services.composite.empty') }}</p>
    <FreeTranslationSettings v-if="service === services.freeTranslation" :active="active" :config="config" :advanced="false" :checks="freeProviderChecks" />

    <LocalTranslationModelSettings v-if="service === services.localTranslation" :active="active" :context="config" :config="config" :service="service" />
    <ChatGPTPlanSettings v-if="ChatGPTPlanSettings && service === services.chatgptPlan" :active="active" :config="config" />

    <Teleport v-if="connectionActionTarget && !publicPlanBlocked" :to="connectionActionTarget">
    <section class="service-connection-action">
    <div class="connection-test-inline">

        <button
          type="button"
          class="connection-test-button"
          data-connection-test-button
          ref="connectionTestButton"
          :disabled="connectionTestDisabled"
          @click="connectionTestBusy ? stopApiKeyChecks() : testConnection()"
        >
          <svg v-if="connectionTestBusy" class="connection-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
          <svg v-else class="connection-action-icon" :class="{ 'is-spinning': connectionTestBusy }" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
          {{ connectionTestBusy ? translateLegacy('停止检查') : t('settings.services.keys.checkConnection') }}
        </button>
    </div>

    <span
      v-if="service === services.freeTranslation || service === services.localTranslation"
      class="header-connection-status"
      :class="`is-${connectionTestState}`"
      :title="connectionTestMessage"
      data-connection-test-status
      role="status"
      aria-live="polite"
    >
      {{ connectionTestMessage ? connectionTestTitle : '' }}
    </span>

    </section>
    </Teleport>
    <section v-if="service !== services.freeTranslation && service !== services.localTranslation && service !== services.chatgptPlan && !isCompositeService" class="connection-card" data-configuration-group="connection">
      <p v-if="service === services.microsoft || service === services.google || service === services.bilibili" class="configuration-scope" data-service-no-setup>{{ t('settings.organization.noSetup') }}</p>
    <template v-if="service === services.myMemory">
      <div class="connection-field" data-mymemory-email>
        <div class="connection-field-label"><strong>联系邮箱（可选）</strong><small>不填写也可以使用</small></div>
        <div class="connection-field-control">
          <el-input v-model="myMemoryEmailDraft" type="email" aria-label="MyMemory 联系邮箱" placeholder="不填写也可以使用" :aria-invalid="myMemoryEmailInvalid" @change="commitMyMemoryEmail" />
          <small v-if="myMemoryEmailInvalid" class="field-warning" role="status">请输入有效邮箱，或留空</small>
        </div>
      </div>
      <div class="official-translation-help" data-mymemory-help>
        <p>匿名使用每天限 5,000 字符，提供有效邮箱后每天限 50,000 字符；邮箱会随请求发送给 MyMemory</p>
        <p>自动识别来源语言时使用本地检测；无法可靠识别时，请手动选择来源语言</p>
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
        <div class="connection-field-label"><strong>服务名称</strong><FieldHelp :content="translateLegacy('仅用于识别此接口')" /></div>
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
        <div class="connection-field-label"><strong>接口地址</strong><FieldHelp :content="t('settings.services.customEndpointHelp')" /></div>
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

    <div v-if="compute.showOllamaEndpoint" class="connection-field" data-ollama-endpoint>
      <div class="connection-field-label">
        <strong>服务地址</strong>
        <FieldHelp :content="translateLegacy('留空时使用本机默认地址；局域网主机请填写完整的 Chat Completions 地址')">
          <template #content>
            <p>{{ translateLegacy('留空时使用本机默认地址；局域网主机请填写完整的 Chat Completions 地址') }}</p>
            <code>{{ DEFAULT_OLLAMA_ENDPOINT }}</code>
            <p>{{ translateLegacy('浏览器扩展访问 Ollama 前，需要在启动 Ollama 时设置环境变量 OLLAMA_ORIGINS=*，否则会被跨域拒绝') }}</p>
          </template>
        </FieldHelp>
      </div>
      <div class="connection-field-control">
        <el-input v-model="config.proxy[service]" aria-label="Ollama 服务地址" :placeholder="DEFAULT_OLLAMA_ENDPOINT" />
      </div>
    </div>

    <div v-if="compute.showToken && compute.showServiceSecret" class="connection-field credential-field" :data-cloud-credential="compute.showCloudVendor ? 'token' : undefined">
      <div class="connection-field-label">
        <strong>{{ compute.showCloudVendor ? compute.cloudCredentialLabels.token : 'API Key' }}</strong>
        <small>{{ compute.showCloudVendor ? '来自厂商控制台' : (effectiveModelLabel || '当前模型') }}</small>
      </div>
      <div class="connection-field-control credential-control">
        <el-input
          :model-value="apiKeys[0] || ''"
          @update:model-value="updateApiKey(0, String($event))"
          type="password"
          show-password
          :aria-label="compute.showCloudVendor ? compute.cloudCredentialLabels.token : 'API Key'"
          :placeholder="compute.showCloudVendor ? `输入 ${compute.cloudCredentialLabels.token}；留空表示尚未配置` : '输入 API Key；留空表示尚未配置'"
        />
        <div v-if="compute.showAI" class="api-key-requirement">
          <span>{{ compute.requireApiKey ? '此模型需要 API Key' : '允许无 Key 请求' }}</span>
          <el-switch v-model="compute.requireApiKey" aria-label="当前模型是否需要 API Key" size="small" />
        </div>
      </div>
    </div>
    <div v-if="compute.showServiceSecret" class="connection-field credential-field" data-cloud-credential="secret">
      <div class="connection-field-label">
        <strong>{{ compute.cloudCredentialLabels.secret }}</strong>
        <small>与上方密钥成对使用</small>
      </div>
      <div class="connection-field-control credential-control">
        <el-input
          v-model="config.secret[service]"
          type="password"
          show-password
          :aria-label="compute.cloudCredentialLabels.secret"
          :placeholder="`输入 ${compute.cloudCredentialLabels.secret}；留空表示尚未配置`"
        />
      </div>
    </div>

    <div v-if="compute.showServiceRegion" class="connection-field" data-cloud-region>
      <div class="connection-field-label">
        <strong>服务区域</strong>
        <FieldHelp :content="translateLegacy('需与控制台资源所在区域一致')">
          <template #content>
            <div>{{ translateLegacy('需与控制台资源所在区域一致') }}</div>
            <code v-if="service === services.aliyunTranslation" data-cloud-region-endpoint>{{ getAliyunTranslationEndpoint(config.serviceRegion[service]) }}</code>
            <div v-else-if="service === services.azureTranslator">{{ translateLegacy('选择全球区域时不发送区域请求头；其余区域会通过 Ocp-Apim-Subscription-Region 请求头一并发送') }}</div>
          </template>
        </FieldHelp>
      </div>
      <div class="connection-field-control">
        <el-select
          :model-value="config.serviceRegion[service] || compute.defaultCloudRegion"
          aria-label="云服务区域"
          placeholder="请选择服务区域"
          @update:model-value="config.serviceRegion[service] = String($event)"
        >
          <el-option
            v-for="item in compute.cloudRegionOptions"
            :key="item.value"
            class="select-left"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
      </div>
    </div>
    <p v-if="compute.showMiniMaxRegion && minimaxKeyMismatch" class="minimax-key-note is-warning">
      {{ minimaxKeyMismatch }}
    </p>

    <div v-if="compute.showMiniMaxRegion" class="provider-account-fields">
    <div v-if="compute.showMiniMaxRegion" class="connection-field"><div class="connection-field-label"><strong>MiniMax 计费方式</strong><FieldHelp :content="translateLegacy('按量付费和 Token Plan 使用不同的账户权益；请按控制台中 Key 的来源选择')" /></div><div class="connection-field-control"><el-select v-model="config.minimaxBillingPlan" aria-label="MiniMax 计费方式" placeholder="请选择 MiniMax 计费方式">
          <el-option class="select-left" v-for="item in options.minimaxBillingPlan" :key="item.value" :label="item.label" :value="item.value" />
        </el-select></div></div>

    <div v-if="compute.showMiniMaxRegion" class="connection-field"><div class="connection-field-label"><strong>MiniMax 区域</strong><FieldHelp :content="translateLegacy('选择与 MiniMax Key 来源一致的 API 区域，Token Plan Key（sk-cp-）与按量付费 Key 不能互换')"><template #content><div>{{ translateLegacy('选择与 MiniMax Key 来源一致的 API 区域，Token Plan Key（sk-cp-）与按量付费 Key 不能互换') }}</div><code data-minimax-endpoint>{{ minimaxEndpoint }}</code></template></FieldHelp></div><div class="connection-field-control"><el-select v-model="config.minimaxRegion" aria-label="MiniMax API 区域" placeholder="请选择 MiniMax API 区域">
          <el-option class="select-left" v-for="item in options.minimaxRegion" :key="item.value" :label="item.label" :value="item.value" />
        </el-select></div></div>
    </div>


    <p v-if="compute.showMiMoRegion && mimoKeyMismatch" class="mimo-key-note is-warning">
      {{ mimoKeyMismatch }}
    </p>

    <p v-if="compute.showMiMoRegion" class="mimo-key-note" data-mimo-retirement-note>
      {{ translateLegacy('MiMo 旧编号将于北京时间 2026-10-21 10:00 失效。直连官方 API 时，自定义模型及请求体中的 mimo-v2.5 / mimo-v2.5-pro 会分别按 mimo-v2.6-flash / mimo-v2.6-pro 请求并按新模型计费；第三方网关请手动确认型号。') }}
    </p>

    <div v-if="compute.showMiMoRegion" class="provider-account-fields">
    <div v-if="compute.showMiMoRegion" class="connection-field"><div class="connection-field-label"><strong>小米 MiMo 计费方式</strong><FieldHelp :content="translateLegacy('按量付费和 Token Plan 使用不同的账户权益；请按小米 MiMo 控制台中 Key 的来源选择')" /></div><div class="connection-field-control"><el-select v-model="config.mimoBillingPlan" aria-label="小米 MiMo 计费方式" placeholder="请选择小米 MiMo 计费方式">
          <el-option class="select-left" v-for="item in options.mimoBillingPlan" :key="item.value" :label="item.label" :value="item.value" />
        </el-select></div></div>

    <div v-if="compute.showMiMoRegion" class="connection-field"><div class="connection-field-label"><strong>MiMo API 集群</strong><FieldHelp :content="translateLegacy('Token Plan 使用购买页面提供的集群地址，中国、新加坡和欧洲集群的 tp- Key 不能混用；按量付费统一使用 api.xiaomimimo.com')"><template #content><div>{{ translateLegacy('Token Plan 使用购买页面提供的集群地址，中国、新加坡和欧洲集群的 tp- Key 不能混用；按量付费统一使用 api.xiaomimimo.com') }}</div><code data-mimo-endpoint>{{ mimoEndpoint }}</code></template></FieldHelp></div><div class="connection-field-control"><el-select v-model="config.mimoRegion" aria-label="小米 MiMo API 集群" placeholder="请选择小米 MiMo API 集群">
          <el-option class="select-left" v-for="item in options.mimoRegion" :key="item.value" :label="item.label" :value="item.value" />
        </el-select></div></div>
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

    <div v-if="compute.showDeepLX" class="connection-field" data-deeplx-endpoint>
      <div class="connection-field-label"><strong>{{ t('settings.services.deeplx.endpoint') }}</strong></div>
      <div class="connection-field-control">
        <el-input v-model="config.deeplx" :aria-label="t('settings.services.deeplx.endpoint')" :placeholder="t('settings.services.deeplx.defaultRoute')" aria-describedby="deeplx-endpoint-help" />
        <div id="deeplx-endpoint-help">
          <p class="provider-field-help">{{ t('settings.services.deeplx.endpointHelp') }}</p>
          <p class="provider-field-help">无需密钥的接口可留空；需要验证时填写 Token</p>
          <details class="endpoint-token-help"><summary>Token 使用方式</summary>
          <p class="provider-field-help">{{ t('settings.services.deeplx.tokenHelp') }}</p>
          <p class="provider-field-help">{{ t('settings.services.deeplx.queryToken') }} <code v-pre>https://deeplx.example.com/translate?token={{apiKey}}</code></p>
          <p class="provider-field-help">{{ t('settings.services.deeplx.pathToken') }} <code v-pre>https://deeplx.example.com/{{apiKey}}/translate</code></p>
          <p class="provider-field-help">{{ t('settings.services.deeplx.placeholderHelp') }}</p>
          </details>
          <p v-if="config.proxy[service]?.trim()" class="provider-field-help">{{ t('settings.services.deeplx.proxyHelp') }}</p>
        </div>
      </div>
    </div>

    <div v-if="compute.showAkSk" class="connection-field"><div class="connection-field-label"><strong>API Key</strong></div><div class="connection-field-control"><el-input v-model="config.ak" aria-label="API Key" placeholder="请输入Access Key" /><p class="provider-field-help">服务商提供的访问密钥</p></div></div>
    <div v-if="compute.showAkSk" class="connection-field"><div class="connection-field-label"><strong>Secret Key</strong></div><div class="connection-field-control"><el-input v-model="config.sk" aria-label="Secret Key" type="password" placeholder="请输入Secret Key" /><p class="provider-field-help">服务商提供的私密密钥，请妥善保管</p></div></div>

    <div v-if="compute.showYoudao" class="connection-field"><div class="connection-field-label"><strong>App Key</strong></div><div class="connection-field-control"><el-input v-model="config.youdaoAppKey" aria-label="App Key" placeholder="有道 AppKey" /><p class="provider-field-help">有道翻译服务提供的 App Key</p></div></div>
    <div v-if="compute.showYoudao" class="connection-field"><div class="connection-field-label"><strong>App Secret</strong></div><div class="connection-field-control"><el-input v-model="config.youdaoAppSecret" aria-label="App Secret" type="password" show-password placeholder="有道 AppSecret" /><p class="provider-field-help">有道翻译服务提供的 App Secret</p></div></div>

    <div v-if="compute.showTencent" class="connection-field"><div class="connection-field-label"><strong>Secret ID</strong></div><div class="connection-field-control"><el-input v-model="config.tencentSecretId" aria-label="Secret ID" placeholder="腾讯云 SecretId" /><p class="provider-field-help">腾讯云翻译服务提供的 SecretId</p></div></div>
    <div v-if="compute.showTencent" class="connection-field"><div class="connection-field-label"><strong>Secret Key</strong></div><div class="connection-field-control"><el-input v-model="config.tencentSecretKey" aria-label="Secret Key" type="password" show-password placeholder="腾讯云 SecretKey" /><p class="provider-field-help">腾讯云翻译服务提供的 SecretKey</p></div></div>

    <div v-if="compute.showNewAPI" class="connection-field"><div class="connection-field-label"><strong>NewAPI接口</strong></div><div class="connection-field-control"><el-input v-model="config.newApiUrl" aria-label="接口地址" placeholder="请输入 New API 接口地址" /><p class="provider-field-help">填写 New API 服务的接口地址</p></div></div>

    <ApiKeyList :active="active" :context="config" :context-key="service"
      v-if="compute.showToken && !compute.showServiceSecret"
      :label="compute.showAI && !compute.requireApiKey || service === services.deeplx && !deepLXRequiresToken ? translateLegacy('API Key（可选）') : compute.showCloudVendor ? compute.cloudCredentialLabels.token : 'API Key'"
      :placeholder="compute.showAI && !compute.requireApiKey || service === services.deeplx && !deepLXRequiresToken ? t('settings.services.keys.optionalPlaceholder') : undefined"
      :data-cloud-credential="compute.showCloudVendor ? 'token' : undefined"
      :keys="apiKeys" :states="apiKeyChecks" :summary="apiKeySummary" :busy="connectionTestBusy"
      :standby-indexes="standbyApiKeys"
      :connection-state="standaloneApiKeyCheck" :check-mode="apiKeyCheckMode"
      @add="addApiKey" @update="updateApiKey" @remove="removeApiKey" @test="testSingleApiKey"
    >
      <template #help><FieldHelp v-if="compute.showAI" :content="t('settings.services.keys.listHelp')" /></template>
      <template v-if="usableApiKeyCount > 1" #tools>
        <div class="credential-usage" data-api-key-rotation-setting role="radiogroup" :aria-label="t('settings.services.keys.usage')">
          <span class="credential-usage-label" aria-hidden="true">{{ t('settings.services.keys.usage') }}</span>
          <div class="credential-modes">
            <label :class="{'is-selected': apiKeyRotationEnabled}"><input type="radio" :name="`api-key-mode-${service}`" value="rotation" :checked="apiKeyRotationEnabled" @change="setApiKeyRotationEnabled(true)" /><span>{{ t('settings.services.keys.rotate') }}</span></label>
            <label :class="{'is-selected': !apiKeyRotationEnabled}"><input type="radio" :name="`api-key-mode-${service}`" value="single" :checked="!apiKeyRotationEnabled" @change="setApiKeyRotationEnabled(false)" /><span>{{ t('settings.services.keys.firstOnly') }}</span></label>
          </div>
          <FieldHelp :content="t('settings.services.keys.usageHelp')" />
        </div>
      </template>
    </ApiKeyList>
    <p v-if="service === services.deeplx && deepLXRequiresToken && !apiKeyIndexes.length" class="field-warning" data-deeplx-key-required role="status">{{ deepLXTokenHelp }}</p>

    <div
      v-if="connectionTestMessage && !connectionTestDiagnostic && (!compute.showToken || compute.showServiceSecret)"
      class="connection-test-result"
      :class="`is-${connectionTestState}`"
      data-connection-test-status
      role="status"
      aria-live="polite"
    >
      <strong>{{ connectionTestTitle }}</strong>
      <span>{{ connectionTestMessage }}</span>
      <DownloadProgress v-if="chromeDownloadProgress" class="chrome-preparation-progress" detail="none" :progress="chromeDownloadProgress" :label="connectionTestMessage" data-chrome-preparation-progress />
    </div>
    </section>

    <div v-if="isCompositeService && connectionTestMessage && !connectionTestDiagnostic" class="connection-test-result" :class="`is-${connectionTestState}`" data-connection-test-status role="status" aria-live="polite"><strong>{{ connectionTestTitle }}</strong><span>{{ connectionTestMessage }}</span></div>
    <div v-if="service === services.chatgptPlan && !publicPlanBlocked && connectionTestMessage && !connectionTestDiagnostic" class="connection-test-result" :class="`is-${connectionTestState}`" data-connection-test-status role="status" aria-live="polite"><strong>{{ connectionTestTitle }}</strong><span>{{ connectionTestMessage }}</span></div>

    <div v-if="connectionTestState === 'error' && connectionTestDiagnostic" class="connection-test-result is-error connection-repair" data-connection-repair :data-diagnostic-code="connectionTestDiagnostic.code" role="status" aria-live="polite">
      <strong>{{ connectionRepairText.title }}</strong>
      <span>{{ connectionRepairText.detail }}</span>
      <div class="connection-repair-actions">
        <button type="button" class="connection-repair-button" data-connection-retry :disabled="connectionTestDisabled || connectionRetryWaiting" @click="testConnection()">{{ t('diagnostics.action.retry') }}</button>
        <button v-if="connectionTestDiagnostic.actions.includes('services')" type="button" class="connection-repair-button" data-connection-repair-config :disabled="!active" @click="focusConnectionConfiguration">{{ t('diagnostics.action.services') }}</button>
      </div>
    </div>

    <ServiceRepairReturn :active="active" :context="config" :context-key="service" @repair-ready="focusInitialRepair" />

    <header v-if="singleSettingsTab" class="configuration-group-heading settings-tabs-heading" data-service-settings-heading><h5>{{ singleSettingsTab }}</h5></header>
    <el-tabs v-if="settingsTabs.requests && !isCompositeService" v-model="activeSettingsTab" class="service-settings-tabs" :class="{ 'is-single-tab': singleSettingsTab }" data-service-settings-tabs>
    <el-tab-pane v-if="settingsTabs.translation" name="translation" :label="t(SETTINGS_TAB_LABELS.translation)">
      <section id="service-translation-settings" class="service-settings-panel" data-configuration-group="translation">

          <div v-if="compute.showModel" class="connection-field" data-testid="model-thinking-control">
            <div class="connection-field-label">
              <strong>{{ t('settings.services.reasoning') }}</strong>
              <FieldHelp :content="t('settings.organization.thinkingHelp')" />
            </div>
            <div class="connection-field-control model-thinking-setting">
              <el-switch
                :model-value="selectedModelThinking"
                :disabled="!effectiveModelLabel"
                aria-label="当前模型是否启用 Thinking"
                @update:model-value="$emit('update:model-thinking', Boolean($event))"
              />
            </div>
          </div>

          <div v-if="compute.showModel" class="connection-field" data-testid="model-vision-control">
            <div class="connection-field-label">
              <strong>{{ t('settings.services.visionCapability') }}</strong>
              <FieldHelp :content="`${t('settings.services.visionUnknown')} ${t('settings.services.visionProbeHelp')}`">
                <template #content>
                  <p class="field-help-line">{{ t('settings.services.visionUnknown') }}</p>
                  <p class="field-help-line">{{ t('settings.services.visionProbeHelp') }}</p>
                </template>
              </FieldHelp>
            </div>
            <ModelVisionSettings :config="config" :service="service" :model="effectiveModelLabel" :active="active && activeSettingsTab === 'translation'" />
          </div>

      </section>
    </el-tab-pane>
    <el-tab-pane v-if="settingsTabs.prompts" name="prompts" :label="t(SETTINGS_TAB_LABELS.prompts)">
      <section id="service-prompts-settings" class="service-settings-panel" data-configuration-group="prompts">
          <div class="custom-template-heading">
            <p class="configuration-scope">{{ t('settings.organization.promptsHelp') }}</p>
            <div class="custom-template-actions">
              <button type="button" class="prompt-sync-button" data-testid="prompt-sync-all" :disabled="!active || activeSettingsTab !== 'prompts' || serviceActionOpen || promptSyncTargets.length === 0" :onClick="syncPromptTemplates">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4 3 8l4 4M3 8h13a5 5 0 0 1 5 5M17 20l4-4-4-4M21 16H8a5 5 0 0 1-5-5" /></svg>
                {{ t('settings.services.prompts.syncAll') }}
              </button>
              <el-button type="primary" link size="small" @click="resetCustomTemplate">恢复默认模板</el-button>
            </div>
          </div>

          <div class="prompt-template-list" data-testid="prompt-template-list">
            <PromptTemplateEditor v-model="config.system_role[service]" role="system" :active="active && activeSettingsTab === 'prompts'" :context="config" :context-key="service" />
            <PromptTemplateEditor v-model="config.user_role[service]" role="user" :active="active && activeSettingsTab === 'prompts'" :context="config" :context-key="service" />
          </div>

      </section>
    </el-tab-pane>
    <el-tab-pane v-if="settingsTabs.requests" name="requests" :label="t(SETTINGS_TAB_LABELS.requests)">
      <section id="service-requests-settings" class="service-settings-panel" data-configuration-group="requests">
        <FreeTranslationSettings v-if="service === services.freeTranslation" :active="active && activeSettingsTab === 'requests'" :config="config" :advanced="true" />
        <div v-if="showNativeBatchTranslation" class="connection-field" :data-native-batch-service="service">
          <div class="connection-field-label">
            <strong>{{ t('settings.services.nativeBatch.label') }}</strong>
            <FieldHelp :content="t('settings.services.nativeBatch.help')" />
          </div>
          <div class="connection-field-control model-thinking-setting">
            <el-switch
              :model-value="nativeBatchTranslationEnabled"
              :disabled="!active || activeSettingsTab !== 'requests'"
              :aria-label="t('settings.services.nativeBatch.label')"
              data-native-batch-toggle
              :onUpdate:modelValue="setNativeBatchTranslationEnabled"
            />
          </div>
        </div>
        <RequestLimitSettings :active="active && activeSettingsTab === 'requests'" :config="config" :service="service" :model="compute.showModel ? requestLimitModel : undefined" />

      </section>
    </el-tab-pane>
    <el-tab-pane v-if="settingsTabs['custom-request']" name="custom-request" :label="t(SETTINGS_TAB_LABELS['custom-request'])">
      <section id="service-custom-request-settings" class="service-settings-panel" data-configuration-group="custom-request">
        <div v-if="compute.showDeepseekApiType" class="connection-field"><div class="connection-field-label"><strong>API 格式</strong><FieldHelp :content="translateLegacy('选择 DeepSeek 接口使用的 API 格式')" /></div><div class="connection-field-control"><el-select v-model="config.deepseekApiType" aria-label="API 格式" placeholder="请选择 API 格式"><el-option class="select-left" v-for="item in options.deepseekApiType" :key="item.value" :label="item.label" :value="item.value" /></el-select></div></div>

          <div v-if="compute.showAI && compute.showProxy" class="connection-field"><div class="connection-field-label"><strong>代理地址</strong><FieldHelp :content="translateLegacy('可选的代理地址；填写后，当前 AI 服务请求会优先发送到这里')" /></div><div class="connection-field-control"><el-input v-model="config.proxy[service]" aria-label="代理地址" placeholder="默认直连自定义接口" /></div></div>

        <div v-if="compute.showAI && usesApiKeyList" class="connection-field" data-api-key-requirement-row>
          <div class="connection-field-label"><strong>{{ t('settings.services.keys.requirement') }}</strong><FieldHelp :content="t('settings.services.keys.requirementHelp')" /></div>
          <div class="connection-field-control">
            <SegmentedControl
              compact class="credential-requirement" data-api-key-auth-policy
              :label="t('settings.services.keys.requirement')" :options="apiKeyRequirementOptions"
              :model-value="compute.requireApiKey ? 'required' : 'optional'"
              @update:model-value="setApiKeyRequirement"
            />
          </div>
        </div>

          <div v-if="customProvider" class="connection-field custom-headers-field" data-testid="custom-service-headers">
            <div class="connection-field-label"><strong>自定义请求头</strong><FieldHelp :content="translateLegacy('填写值为字符串的 JSON 对象，仅用于当前自定义服务，同名请求头会覆盖默认值；留空则不启用')" /></div>
            <div class="connection-field-control">
              <el-input v-model="config.customHeaders[service]" type="textarea" :rows="3"
                aria-label="自定义请求头" :spellcheck="false" :class="{ 'input-error': !isValidCustomHeaders(config.customHeaders[service]) }"
                placeholder='{"x-opencode-session": "your-stable-session-id"}' />
              <div v-if="!isValidCustomHeaders(config.customHeaders[service])" class="error-text">请输入有效的请求头 JSON 对象，名称和值必须符合 HTTP 格式</div>
            </div>
          </div>

          <RequestHeaderSettings v-if="compute.showAI" :active="active && activeSettingsTab === 'custom-request'" :config="config" />

          <div v-if="compute.showCustomBody" class="connection-field"><div class="connection-field-label"><strong>自定义请求体</strong><FieldHelp :content="translateLegacy('填写要合并到翻译请求中的 JSON 参数对象')" /></div><div class="connection-field-control"><el-input v-model="config.customBody[service]" type="textarea" :rows="3" aria-label="自定义请求体" :class="{ 'input-error': !isValidCustomBody(config.customBody[service]) }" placeholder='例如：{"thinking": {"type": "disabled"}}' />
              <div v-if="!isValidCustomBody(config.customBody[service])" class="error-text">请输入合法的 JSON 对象，否则该配置将被忽略</div></div></div>


      </section>
    </el-tab-pane>
    </el-tabs>
    <div v-if="compute.showCustomOpenAI" class="service-maintenance-actions">
      <button type="button" class="delete-service-button" data-testid="custom-service-delete" @click="confirmDeleteProvider"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></svg>删除服务</button>
    </div>
  </section>
  <el-dialog :key="serviceActionRevision" :model-value="serviceActionOpen" :onUpdate:modelValue="serviceActionButtons.open" :title="serviceActionTitle" width="min(460px, calc(100vw - 32px))" append-to-body destroy-on-close>
    <p>{{ serviceActionMessage }}</p>
    <template #footer>
      <el-button :onClick="serviceActionButtons.cancel">{{ t(pendingServiceAction?.kind === 'sync' ? 'settings.services.prompts.syncCancel' : 'common.cancel') }}</el-button>
      <el-button :type="pendingServiceAction?.kind === 'delete' ? 'danger' : 'primary'" :onClick="serviceActionButtons.confirm">{{ t(pendingServiceAction?.kind === 'sync' ? 'settings.services.prompts.syncConfirmAction' : 'common.confirm') }}</el-button>
    </template>
  </el-dialog>
  </template>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, shallowRef, toRef, watch } from 'vue'
import type { Config } from '@/src/core/config/model'
import {getCompositeTranslationProvider, isCompositeTranslationProviderId} from '@/src/core/config/compositeTranslation'
import type { TranslationParams } from '@/src/core/i18n'
import { defaultOption, options as optionConfig, resolveConfiguredModel, services, servicesType } from '@/src/core/config/catalog'
import {chatGPTPlanDevelopmentEnabled} from '@/src/platform/chatgpt-plan/buildMode'
import {
  MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH,
  MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH,
  type CustomOpenAIProvider,
} from '@/src/core/config/customOpenAI'
import { isValidCustomBody } from '@/src/core/config/customBody'
import { resolveTranslationRequestModel } from '@/src/core/config/requestModel'
import { isValidCustomHeaders } from '@/src/core/config/customHeaders'
import { createApiKeyCheckRevision } from '@/src/core/config/apiKeyCheckIdentity'
import { normalizeFreeTranslationOrder, normalizeMyMemoryEmail } from '@/src/core/config/freeTranslation'
import { isNativeBatchTranslationService, isNativeTranslationBatchEnabled } from '@/src/core/config/nativeBatch'
import { requiresDeepLXToken } from '@/src/core/config/deeplx'
import { getDeepLEndpoint } from '@/src/core/config/deepl'
import browser from 'webextension-polyfill'
import { normalizeDiagnostic, diagnoseFailure, type Diagnostic } from '@/src/services/diagnostics'
import { requestConfigSave, waitForConfigPersistenceQueue } from '@/src/services/config/store'
import { CONNECTION_TEST_MESSAGE, DEFAULT_OLLAMA_ENDPOINT, getAliyunTranslationEndpoint, getMimoEndpoint, MINIMAX_ENDPOINTS } from '@/src/core/config/constants'
import { chromeTranslationPreparationStore } from '@/src/platform/browser/chromeTranslationPreparationRequest'
import { ElMessage, ElTabs, ElTabPane } from 'element-plus'
import 'element-plus/es/components/tabs/style/css'
import FieldHelp from '../components/FieldHelp.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
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
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue'
import PromptTemplateEditor from './PromptTemplateEditor.vue'
import FreeTranslationSettings from './FreeTranslationSettings.vue'
import ApiKeyList from './ApiKeyList.vue'
import { normalizeApiKeyList, eligibleApiKeyIndexes, activeApiKeyIndexes, standbyApiKeyIndexes, summarizeApiKeyChecks, type ApiKeyCheckState, type ApiKeySummary } from './apiKeyTypes'
const LocalTranslationModelSettings = defineAsyncComponent(() => import('../LocalTranslationModelSettings.vue'))
import ModelVisionSettings from './ModelVisionSettings.vue'
import RequestLimitSettings from './RequestLimitSettings.vue'
import RequestHeaderSettings from './RequestHeaderSettings.vue'
import CompositeTranslationSettings from './CompositeTranslationSettings.vue'
import ServiceRepairReturn from './ServiceRepairReturn.vue'
import {createServiceRepairFocus} from './serviceRepairFocus'
const ChatGPTPlanSettings = chatGPTPlanDevelopmentEnabled ? defineAsyncComponent(() => import('./ChatGPTPlanSettings.vue')) : null
import { checkAllFreeTranslationProviders, type FreeTranslationChecks } from './freeTranslationChecks'
import {readFreePoolAccess} from '@/src/platform/browser/freeProviderPermissions'
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation'
import { listPromptTemplateSyncTargets, syncPromptTemplates as applyPromptTemplateSync } from './promptTemplateSync'
import {waitForSettingsTask} from '../../model/taskWait'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'

const props = withDefaults(defineProps<{
  config: Config
  service: string
  selectedModelThinking: boolean
  compute: Record<string, any>
  options: typeof optionConfig
  isValidAzureEndpoint: (endpoint: string) => boolean
  customProvider?: CustomOpenAIProvider
  connectionActionTarget?: HTMLElement | null
  active?: boolean
}>(), {active: true})

const emit = defineEmits<{
  'update:model-thinking': [value: boolean]
  'update:custom-provider': [patch: Partial<Pick<CustomOpenAIProvider, 'name' | 'endpoint'>>]
  'delete:custom-provider': []
  'remove:service': [service: string]
}>()

const config = toRef(props, 'config')
const service = toRef(props, 'service')
const publicPlanBlocked = computed(() => service.value === services.chatgptPlan && !chatGPTPlanDevelopmentEnabled)
const isCompositeService = computed(() => isCompositeTranslationProviderId(service.value))
const compositeProvider = computed(() => getCompositeTranslationProvider(config.value.compositeTranslationProviders, service.value))
const compute = toRef(props, 'compute')
const options = toRef(props, 'options')
const isValidAzureEndpoint = toRef(props, 'isValidAzureEndpoint')
const customProvider = toRef(props, 'customProvider')
const { language, t, translateLegacy } = useUiI18n()
const activeSettingsTab = ref('requests')
const serviceActionOpen = ref(false)
const sourcePromptProvider = computed(() => config.value.customOpenAIProviders.find(provider => provider.id === service.value))
const {active, capture: captureServiceActionContext, revision: serviceActionRevision} = useSettingsActionContext(() => props.active && !publicPlanBlocked.value, () => [
  config.value, service.value, customProvider.value, activeSettingsTab.value, Boolean(compute.value.showAI), serviceActionOpen.value,
  sourcePromptProvider.value, config.value.system_role[service.value], config.value.user_role[service.value],
])
const showNativeBatchTranslation = computed(() => isNativeBatchTranslationService(service.value))
const nativeBatchTranslationEnabled = computed(() => isNativeTranslationBatchEnabled(service.value, config.value.nativeBatchTranslationEnabled))
const setNativeBatchTranslationEnabled = computed(() => {
  const owner = config.value
  const ownerService = service.value
  const current = captureServiceActionContext()
  return (enabled: boolean): void => {
    if (!current() || activeSettingsTab.value !== 'requests' || !isNativeBatchTranslationService(ownerService)) return
    owner.nativeBatchTranslationEnabled[ownerService] = enabled === true
  }
})
watch(() => [service.value, Boolean(compute.value.showAI), Boolean(compute.value.showModel)], () => {
  activeSettingsTab.value = compute.value.showAI && compute.value.showModel ? 'translation' : compute.value.showAI ? 'prompts' : 'requests'
}, {immediate: true})
// 页签的可见条件与标题只在这里定义一次，模板和“单页签改用小节标题”的判断共用。
const SETTINGS_TAB_LABELS = {
  translation: 'settings.organization.model',
  prompts: 'settings.organization.prompts',
  requests: 'settings.organization.requests',
  'custom-request': 'settings.organization.compatibility',
} as const
const settingsTabs = computed<Record<keyof typeof SETTINGS_TAB_LABELS, boolean>>(() => ({
  translation: !publicPlanBlocked.value && Boolean(compute.value.showAI && compute.value.showModel),
  prompts: !publicPlanBlocked.value && Boolean(compute.value.showAI),
  requests: !publicPlanBlocked.value && service.value !== services.localTranslation && !isCompositeService.value,
  'custom-request': !publicPlanBlocked.value && service.value !== services.chatgptPlan && Boolean(compute.value.showDeepseekApiType || compute.value.showAI || compute.value.showCustomBody || customProvider.value),
}))
// 只有一个页签时（机器翻译服务只有“请求限制”）不显示孤立的页签条，改用小节标题。
const singleSettingsTab = computed(() => {
  const visible = (Object.keys(SETTINGS_TAB_LABELS) as Array<keyof typeof SETTINGS_TAB_LABELS>).filter(name => settingsTabs.value[name])
  return visible.length === 1 ? t(SETTINGS_TAB_LABELS[visible[0]]) : ''
})
const myMemoryEmailDraft = ref(config.value.myMemoryEmail)
const myMemoryEmailInvalid = computed(() => Boolean(myMemoryEmailDraft.value.trim() && !normalizeMyMemoryEmail(myMemoryEmailDraft.value)))
watch(() => config.value.myMemoryEmail, value => { myMemoryEmailDraft.value = value })

function commitMyMemoryEmail(): void {
  if (!active.value || myMemoryEmailInvalid.value) return
  config.value.myMemoryEmail = normalizeMyMemoryEmail(myMemoryEmailDraft.value)
}

const deepLXTokenHelp = computed(() => translateLegacy('DeepLX 地址包含 {{apiKey}} 或 {{token}} 占位符，请填写 API Key；无 Key 地址请移除占位符'))
const deepLXRequiresToken = computed(() => requiresDeepLXToken(config.value.deeplx, config.value.proxy[services.deeplx]))
const deeplEndpoint = computed(() => config.value.proxy[service.value]?.trim() || getDeepLEndpoint(config.value.deeplApiPlan))
const pendingChromePreparation = ref<Awaited<ReturnType<typeof chromeTranslationPreparationStore.get>>>(null)
let pendingChromePreparationRevision = 0
let chromePreparationGeneration = 0
let stopChromePreparationPendingWatch: (() => void) | undefined
const effectiveModelLabel = computed(() => resolveConfiguredModel(
  config.value.model[service.value],
  config.value.customModel[service.value],
))
// 请求体可覆盖实际模型；当前模型限额的标签、读取和保存都必须指向该真实身份。
const requestLimitModel = computed(() => resolveTranslationRequestModel(config.value, service.value))

const apiKeys = computed(() => {
  const configured = config.value.apiKeys?.[service.value]
  return normalizeApiKeyList(configured, config.value.token[service.value] || '')
})
const apiKeyRotationEnabled = computed<boolean>({
  get: () => {
    const explicit = config.value.apiKeyRotationEnabled?.[service.value]
    return explicit === true || (explicit === undefined && apiKeys.value.filter(Boolean).length > 1)
  },
  set: (value) => {
    if (!active.value) return
    config.value.apiKeyRotationEnabled = {
      ...(config.value.apiKeyRotationEnabled || {}),
      [service.value]: value,
    }
  },
})
function setApiKeyRotationEnabled(value: boolean): void {
  apiKeyRotationEnabled.value = value
}
function setApiKeyRequirement(value: string | number): void {
  if (!active.value) return
  compute.value.requireApiKey = value === 'required'
}
const apiKeyRequirementOptions = computed(() => [
  {value: 'required', label: t('settings.services.keys.required')},
  {value: 'optional', label: t('settings.services.keys.optional')},
])
// 列表始终展示全部已保存的密钥；“仅用首个”只改变参与请求的范围，其余行标为备用而不是隐藏。
const usableApiKeys = computed(() => eligibleApiKeyIndexes(apiKeys.value))
const usableApiKeyCount = computed(() => usableApiKeys.value.length)
const apiKeyIndexes = computed(() => activeApiKeyIndexes(usableApiKeys.value, apiKeyRotationEnabled.value))
const standbyApiKeys = computed(() => standbyApiKeyIndexes(usableApiKeys.value, apiKeyRotationEnabled.value))
const usesApiKeyList = computed(() => compute.value.showToken && !compute.value.showServiceSecret)
// 结果只保存本地化描述；在展示边界解析为既有子组件需要的字符串，语言包迟到时无需重新检查服务。
type LocalizedCheckState = Omit<ApiKeyCheckState, 'error'> & {error?: LocalizedConnectionTestMessage}
const apiKeyCheckStates = ref<Record<number, LocalizedCheckState>>({})
const apiKeyChecks = computed<Record<number, ApiKeyCheckState>>(() => Object.fromEntries(
  Object.entries(apiKeyCheckStates.value).map(([index, state]) => [index, localizeCheckState(state)]),
))
function localizeCheckState(state: LocalizedCheckState): ApiKeyCheckState {
  const {error, ...result} = state
  return {...result, ...(error ? {error: t(error.key, error.params)} : {})}
}
const apiKeySummary = ref<ApiKeySummary | null>(null)
const apiKeyCheckMode = ref<'single' | 'all'>('all')

function syncApiKeys(next: string[]): void {
  if (!active.value) return
  const storedValue = next.length > 0 ? next : ['']
  if (!config.value.apiKeys) config.value.apiKeys = {}
  config.value.apiKeys[service.value] = storedValue
  config.value.token[service.value] = storedValue.find(key => key.trim()) || ''
}

function addApiKey(): void {
  if (!active.value) return
  // 可用密钥不足两个时看不到使用方式，此前留下的“仅用首个”已无意义：清除它，新添加的密钥按默认轮换使用。
  // 已有多个密钥并明确选了“仅用首个”时保留该选择，新密钥作为备用。
  if (usableApiKeyCount.value < 2 && config.value.apiKeyRotationEnabled?.[service.value] === false) {
    const {[service.value]: _stale, ...rest} = config.value.apiKeyRotationEnabled
    config.value.apiKeyRotationEnabled = rest
  }
  // 空行是合法草稿：已有空行时也继续新增。
  syncApiKeys([...apiKeys.value, ''])
}
function updateApiKey(index: number, value: string): void {
  if (!active.value || !Number.isInteger(index) || index < 0 || index >= apiKeys.value.length) return
  const next = [...apiKeys.value]
  next[index] = value
  syncApiKeys(next)
}
function removeApiKey(index: number): void {
  if (!active.value || !Number.isInteger(index) || index < 0 || index >= apiKeys.value.length) return
  syncApiKeys(apiKeys.value.filter((_, itemIndex) => itemIndex !== index))
}

function resetApiKeyChecks(): void {
  apiKeyCheckStates.value = {}
  apiKeySummary.value = null
}

function setApiKeyState(index: number, state: LocalizedCheckState): void {
  apiKeyCheckStates.value = {...apiKeyCheckStates.value, [index]: state}
}

function updateApiKeySummary(): void {
  apiKeySummary.value = summarizeApiKeyChecks(apiKeyChecks.value)
}

function updateCustomProvider(field: 'name' | 'endpoint', value: string): void {
  if (!active.value) return
  emit('update:custom-provider', {[field]: value})
}

const minimaxKeyKind = computed(() => {
  const token = config.value.token[service.value]?.trim() || ''
  return token.startsWith('sk-cp-') ? 'token-plan' : token ? 'other' : 'empty'
})

const minimaxKeyMismatch = computed(() => {
  if (minimaxKeyKind.value === 'empty') return ''
  if (config.value.minimaxBillingPlan === 'token-plan' && minimaxKeyKind.value !== 'token-plan') {
    return '当前选择的是 Token Plan，但 Key 不是 sk-cp- 开头；请确认 Key 来源，Token Plan 订阅必须有效'
  }
  if (config.value.minimaxBillingPlan === 'payg' && minimaxKeyKind.value === 'token-plan') {
    return '当前选择的是按量付费，但检测到 sk-cp- Token Plan Key；两类 Key 不能互换，请切换计费方式或更换 Key'
  }
  return config.value.minimaxBillingPlan === 'token-plan'
    ? '当前使用 Token Plan Key；请确认 Token Plan 订阅有效'
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
    return '当前选择的是 MiMo Token Plan，但 Key 不是 tp- 开头；请确认 Key 来源和订阅状态'
  }
  if (config.value.mimoBillingPlan === 'payg' && mimoKeyKind.value === 'token-plan') {
    return '当前选择的是 MiMo 按量付费，但检测到 tp- Token Plan Key；两类 Key 不能互换，请切换计费方式或更换 Key'
  }
  if (config.value.mimoBillingPlan === 'payg' && mimoKeyKind.value === 'other') {
    return 'MiMo 按量付费 Key 通常以 sk- 开头；请确认 Key 来自 API Keys 页面'
  }
  return config.value.mimoBillingPlan === 'token-plan'
    ? '当前使用 MiMo Token Plan Key；请确认订阅仍在有效期内'
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
const CONNECTION_CONFIG_WAIT_TIMEOUT_MS = 10_000
// 后台翻译检查有 30 秒预算；页面多留出消息传递和结果保存时间。
const CONNECTION_RESPONSE_WAIT_TIMEOUT_MS = 45_000
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
const configurationRoot = ref<HTMLElement>()
const connectionTestButton = ref<HTMLButtonElement>()
const focusRepairEntry = createServiceRepairFocus(() => nextTick())
function focusInitialRepair(requestedService: string): void {
  if (requestedService !== service.value) return
  void focusRepairEntry(captureServiceActionContext(), () => ({button: connectionTestButton.value,
    fallback: configurationRoot.value?.closest('.service-detail')?.querySelector<HTMLElement>('h4') || configurationRoot.value}))
}
const connectionTestDisabled = computed(() => !active.value || (isCompositeService.value && !compositeProvider.value?.services.length) || (!connectionTestBusy.value && (connectionRetryWaiting.value || usesApiKeyList.value && apiKeyIndexes.value.length === 0
    && (service.value === services.deeplx ? deepLXRequiresToken.value : compute.value.requireApiKey))))
const freeProviderCheckStates = ref<{[Key in keyof FreeTranslationChecks]: LocalizedCheckState}>({})
const freeProviderChecks = computed<FreeTranslationChecks>(() => Object.fromEntries(
  Object.entries(freeProviderCheckStates.value).map(([providerId, state]) => [providerId, localizeCheckState(state)]),
))
const freeProviderRetryAt = new Map<string, number>()
const connectionTestState = ref<ConnectionTestState>('idle')
const connectionTestMessageState = ref<LocalizedConnectionTestMessage | string | null>(null)
const connectionTestDiagnostic = shallowRef<Diagnostic | null>(null)
// t 读取语言包修订号，异步资源到达后会刷新已显示的诊断。
const connectionRepairText = computed(() => connectionTestDiagnostic.value ? {title: t(connectionTestDiagnostic.value.titleKey), detail: t(connectionTestDiagnostic.value.detailKey)} : {title: '', detail: ''})
const connectionRetryWaiting = ref(false)
const MAX_CONNECTION_RETRY_TIMER_MS = 2_147_483_647
let connectionRetryDeadline = 0
let connectionRetryTimer: ReturnType<typeof setTimeout> | undefined
// 浏览器计时器只接受 32 位有符号延时；每段醒来都重新核对完整截止时间，不能把长冷却溢出成即时重试。
function scheduleConnectionRetryWake(): void {
  clearTimeout(connectionRetryTimer)
  connectionRetryTimer = undefined
  const remaining = connectionRetryDeadline - Date.now()
  connectionRetryWaiting.value = remaining > 0
  if (remaining > 0) connectionRetryTimer = setTimeout(scheduleConnectionRetryWake, Math.min(MAX_CONNECTION_RETRY_TIMER_MS, remaining))
  else connectionRetryDeadline = 0
}
function clearConnectionDiagnostic(): void {
  connectionTestDiagnostic.value = null
  connectionRetryWaiting.value = false
  connectionRetryDeadline = 0
  clearTimeout(connectionRetryTimer)
  connectionRetryTimer = undefined
}
// 原始供应商错误仅用于分类，从不进入组件展示状态、详情或 title 属性。
function describeConnectionFailure(error: unknown, applyCooldown = true): LocalizedConnectionTestMessage {
  const diagnostic = normalizeDiagnostic(error) || diagnoseFailure(error, {online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
    ...(error instanceof ConnectionConfigurationError ? {reason: 'configuration-save' as const} : {})})
  if (!connectionTestDiagnostic.value) connectionTestDiagnostic.value = diagnostic
  if (applyCooldown && diagnostic.retryAfterMs) {
    connectionRetryDeadline = Math.max(connectionRetryDeadline, Date.now() + diagnostic.retryAfterMs)
    scheduleConnectionRetryWake()
  }
  return localizedConnectionTestMessage(diagnostic.titleKey)
}
function focusConnectionConfiguration(): void {
  if (!active.value || !connectionTestDiagnostic.value) return
  const root = configurationRoot.value
  const modelFailure = connectionTestDiagnostic.value.code === 'model-configuration'
  const modelTarget = modelFailure ? root?.closest('.service-detail')?.querySelector<HTMLElement>('[data-testid="model-picker-trigger"]') : undefined
  const target = modelTarget || root?.querySelector<HTMLElement>('.connection-card input:not([type="hidden"]), .connection-card select, .connection-card textarea, [data-free-translation-settings] input, [data-composite-service-settings] input')
    || root?.closest('.service-detail')?.querySelector<HTMLElement>('[data-testid="model-picker-trigger"]')
    || findServiceDirectoryControl(root)
  target?.focus({preventScroll: true})
  target?.scrollIntoView({block: 'nearest', inline: 'nearest'})
}
function findServiceDirectoryControl(root?: HTMLElement): HTMLElement | undefined {
  const catalog = root?.closest('.service-catalog')
  const search = catalog?.querySelector<HTMLElement>('.catalog-search input')
  return search?.getClientRects().length ? search : catalog?.querySelector<HTMLElement>('.mobile-directory-toggle') || undefined
}
class ConnectionConfigurationError extends Error {}
onBeforeUnmount(clearConnectionDiagnostic)
// Chrome 只回报 0 到 1 的下载比例，不提供字节数；进度条用它的真实比例，文字里已有百分比。
const chromeDownloadFraction = ref<number>()
const chromeDownloadProgress = computed(() => isChromeConnectionTest.value && connectionTestState.value === 'testing' && chromeDownloadFraction.value !== undefined
  ? {loaded: Math.round(chromeDownloadFraction.value * 100), total: 100}
  : undefined)
const connectionTestMessage = computed(() => {
  const message = connectionTestMessageState.value
  if (!message) return ''
  return typeof message === 'string' ? message : t(message.key, message.params)
})
// 没有逐 Key 结果时，保存失败或免 Key 检查仍复用固定的行内状态区。
const standaloneApiKeyCheck = computed<ApiKeyCheckState | undefined>(() => {
  if (connectionTestState.value === 'idle') return undefined
  if (connectionTestState.value === 'testing') return {status: 'checking'}
  if (connectionTestState.value === 'success') return {status: 'success'}
  return {status: 'error', error: connectionTestMessage.value}
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
let activeConnection: AbortController | undefined

function waitForConnectionStep<T>(operation: Promise<T>, timeoutMs: number, timeoutKey: string, signal: AbortSignal): Promise<T> {
  return waitForSettingsTask(operation, signal, timeoutMs, t(timeoutKey)).catch(error => {
    if (timeoutKey === 'settings.services.keys.configTimeout' && !signal.aborted) throw new ConnectionConfigurationError()
    throw error
  })
}
const connectionTestTitle = computed(() => {
  if (service.value === services.freeTranslation && connectionTestState.value === 'idle') return connectionTestMessage.value
  if (service.value === services.freeTranslation && Object.keys(freeProviderChecks.value).length) {
    const checks = Object.values(freeProviderChecks.value)
    const passed = checks.filter(check => check.status === 'success').length
    const failed = checks.filter(check => check.status === 'error').length
    return connectionTestBusy.value
      ? t('settings.services.keys.progress', {done: passed + failed, total: checks.length})
      : t('settings.services.keys.summary', {passed, failed})
  }
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
  clearConnectionDiagnostic()
  freeProviderCheckStates.value = {}
  freeProviderRetryAt.clear()
  displayedChromePreparationPair.value = null
  chromeDownloadFraction.value = undefined
  connectionTestState.value = 'idle'
  connectionTestMessageState.value = null
  resetApiKeyChecks()
}

function invalidateConnectionTest(): void {
  connectionTestGeneration += 1
  activeConnection?.abort()
  activeConnection = undefined
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

function formatChromePreparationError(error: unknown): LocalizedConnectionTestMessage {
  if (error instanceof ChromeTranslationPreparationError) {
    const {detail: _privateDetail, ...safeParams} = error.params || {}
    return localizedConnectionTestMessage(CHROME_PREPARATION_ERROR_KEYS[error.code], safeParams)
  }
  return describeConnectionFailure(error)
}

async function runApiKeyCheck(index: number, generation: number, signal: AbortSignal): Promise<boolean> {
  if (!active.value || generation !== connectionTestGeneration || signal.aborted) return false
  const key = apiKeys.value[index]?.trim() || ''
  if (!key) {
    return false
  }
  setApiKeyState(index, {status: 'checking'})
  try {
    const response = await waitForConnectionStep(browser.runtime.sendMessage({
      type: CONNECTION_TEST_MESSAGE,
      service: service.value,
      keyIndex: index,
      keyRevision: createApiKeyCheckRevision(config.value, service.value),
    }), CONNECTION_RESPONSE_WAIT_TIMEOUT_MS, 'settings.services.keys.responseTimeout', signal) as {success?: boolean; durationMs?: number; error?: string; diagnostic?: unknown} | undefined
    if (generation !== connectionTestGeneration) return false
    if (!response?.success) throw normalizeDiagnostic(response?.diagnostic) || new Error(response?.error || '连接测试失败')
    setApiKeyState(index, {status: 'success', durationMs: response.durationMs})
    updateApiKeySummary()
    return true
  } catch (error) {
    if (generation !== connectionTestGeneration) return false
    setApiKeyState(index, {status: 'error', error: describeConnectionFailure(error)})
    updateApiKeySummary()
    return false
  }
}

function stopApiKeyChecks(): void {
  connectionTestGeneration += 1
  activeConnection?.abort()
  activeConnection = undefined
  connectionTestBusy.value = false
  connectionTestState.value = 'idle'
  connectionTestMessageState.value = null
  clearConnectionDiagnostic()
  apiKeyCheckStates.value = Object.fromEntries(Object.entries(apiKeyCheckStates.value).map(([index, state]) => [index,
    state.status === 'checking' || state.status === 'queued' ? {status: 'idle' as const} : state]))
  updateApiKeySummary()
}

async function testSingleApiKey(index: number): Promise<void> {
  // 备用密钥不参与全量检查，但仍可逐个验证。
  if (!active.value || connectionTestBusy.value || connectionRetryWaiting.value || !usableApiKeys.value.includes(index)) return
  clearConnectionDiagnostic()
  apiKeyCheckMode.value = 'single'
  const generation = ++connectionTestGeneration
  const controller = new AbortController()
  activeConnection = controller
  connectionTestBusy.value = true
  connectionTestState.value = 'testing'
  connectionTestMessageState.value = localizedConnectionTestMessage('settings.services.keys.checking')
  setApiKeyState(index, {status: 'checking'})
  updateApiKeySummary()
  try {
    await waitForConnectionStep(waitForConfigPersistenceQueue(), CONNECTION_CONFIG_WAIT_TIMEOUT_MS, 'settings.services.keys.configTimeout', controller.signal)
    if (generation !== connectionTestGeneration) return
    await waitForConnectionStep(requestConfigSave(config.value, browser.runtime.sendMessage.bind(browser.runtime)), CONNECTION_CONFIG_WAIT_TIMEOUT_MS, 'settings.services.keys.configTimeout', controller.signal)
    if (generation !== connectionTestGeneration) return
    const success = await runApiKeyCheck(index, generation, controller.signal)
    if (generation !== connectionTestGeneration) return
    connectionTestState.value = success ? 'success' : 'error'
    connectionTestMessageState.value = localizedConnectionTestMessage(success ? 'settings.services.keys.passed' : 'settings.services.keys.failed')
  } catch (error) {
    if (generation === connectionTestGeneration) {
      connectionTestState.value = 'error'
      connectionTestMessageState.value = describeConnectionFailure(error)
      setApiKeyState(index, {status: 'error', error: connectionTestMessageState.value})
      updateApiKeySummary()
    }
  } finally {
    controller.abort()
    if (activeConnection === controller) activeConnection = undefined
    if (generation === connectionTestGeneration) connectionTestBusy.value = false
  }
}

async function testConnection(): Promise<void> {
  if (!active.value || connectionTestBusy.value || connectionTestDisabled.value || connectionRetryWaiting.value) return
  clearConnectionDiagnostic()
  apiKeyCheckMode.value = 'all'

  const testedService = service.value
  if (testedService === services.freeTranslation) freeProviderCheckStates.value = {}
  const generation = ++connectionTestGeneration
  const controller = new AbortController()
  activeConnection = controller
  const chromePreparationDeadline = testedService === services.chromeTranslator ? Date.now() + CHROME_PREPARATION_TIMEOUT_MS : undefined
  const isCurrent = () => active.value && generation === connectionTestGeneration
  let acceptChromePreparationStatus = true
  connectionTestBusy.value = true
  connectionTestState.value = 'testing'
  chromeDownloadFraction.value = undefined
  if (compute.value.showToken) resetApiKeyChecks()
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
        signal: controller.signal,
        onStatus(status) {
          if (acceptChromePreparationStatus && isCurrent()) {
            connectionTestMessageState.value = formatChromePreparationStatus(status)
            chromeDownloadFraction.value = status.phase === 'downloading' ? status.loaded : undefined
          }
        },
      }).then(
        (result) => ({ok: true as const, result}),
        (error) => ({ok: false as const, error}),
      )
    }
    await waitForConnectionStep(waitForConfigPersistenceQueue(), CONNECTION_CONFIG_WAIT_TIMEOUT_MS, 'settings.services.keys.configTimeout', controller.signal)
    if (!isCurrent()) return
    await waitForConnectionStep(requestConfigSave(config.value, browser.runtime.sendMessage.bind(browser.runtime)), CONNECTION_CONFIG_WAIT_TIMEOUT_MS, 'settings.services.keys.configTimeout', controller.signal)
    if (!isCurrent()) return
    if (chromePreparation) {
      const outcome = await waitForConnectionStep(chromePreparation, Math.max(1, chromePreparationDeadline! - Date.now()), 'settings.services.chromePreparation.error.timeout', controller.signal)
      if (!isCurrent()) return
      if (!outcome.ok) throw outcome.error
      void chromeTranslationPreparationStore.clear({
        sourceLanguage: outcome.result.sourceLanguage,
        targetLanguage: outcome.result.targetLanguage,
      }).catch(() => undefined)
      if (!isCurrent()) return
      connectionTestState.value = 'success'
      connectionTestMessageState.value = localizedConnectionTestMessage(
        'settings.services.chromePreparation.success',
        {
          sourceLanguage: outcome.result.sourceLanguage,
          targetLanguage: outcome.result.targetLanguage,
        },
      )
    } else if (testedService === services.freeTranslation) {
      let access: Awaited<ReturnType<typeof readFreePoolAccess>>
      try {
        access = await waitForConnectionStep(readFreePoolAccess(FREE_TRANSLATION_PROVIDERS.map(provider => provider.id), {signal: controller.signal}), CONNECTION_RESPONSE_WAIT_TIMEOUT_MS, 'safari.freePool.error', controller.signal)
      } catch {
        if (!isCurrent()) return
        // 权限读取失败不归咎于供应商；保存安全 key，让迟到语言包仍可更新提示。
        connectionTestState.value = 'error'
        connectionTestMessageState.value = localizedConnectionTestMessage('safari.freePool.error')
        return
      }
      if (!isCurrent()) return
      const granted = new Set<string>(access.grantedIds)
      if (!granted.size) {
        connectionTestState.value = 'idle'
        connectionTestMessageState.value = localizedConnectionTestMessage('safari.freePool.permissionState')
        return
      }
      const providerDiagnostics = new Map<string, Diagnostic>()
      const failProvider = (providerId: string, error: unknown, durationMs?: number) => {
        const diagnostic = normalizeDiagnostic(error) || diagnoseFailure(error, {online: typeof navigator === 'undefined' ? undefined : navigator.onLine})
        providerDiagnostics.set(providerId, diagnostic)
        if (diagnostic.retryAfterMs) freeProviderRetryAt.set(providerId, Date.now() + diagnostic.retryAfterMs)
        return {success: false, ...(durationMs === undefined ? {} : {durationMs}), error: describeConnectionFailure(diagnostic, false).key}
      }
      await checkAllFreeTranslationProviders({
        check: async freeProviderId => {
          if (!granted.has(freeProviderId)) return undefined
          const remaining = (freeProviderRetryAt.get(freeProviderId) || 0) - Date.now()
          if (remaining > 0) return failProvider(freeProviderId, {kind: 'rate-limit', retryAfterMs: remaining})
          freeProviderRetryAt.delete(freeProviderId)
          try {
            const response = await waitForConnectionStep(browser.runtime.sendMessage({
              type: CONNECTION_TEST_MESSAGE,
              service: testedService,
              freeProviderId,
            }), CONNECTION_RESPONSE_WAIT_TIMEOUT_MS, 'settings.services.keys.responseTimeout', controller.signal) as {success?: boolean; durationMs?: number; error?: string; diagnostic?: unknown} | undefined
            if (!isCurrent()) return undefined
            return response?.success ? response : failProvider(freeProviderId, normalizeDiagnostic(response?.diagnostic) || response?.error, response?.durationMs)
          } catch (error) {
            return isCurrent() ? failProvider(freeProviderId, error) : undefined
          }
        },
        update: (providerId, state) => {
          if (!isCurrent() || !granted.has(providerId)) return
          const {error: _untrustedError, ...result} = state
          // 检查器的异常兜底可能携带原始错误；只用已归类诊断或固定失败 key，不把它翻译或展示。
          freeProviderCheckStates.value = {...freeProviderCheckStates.value, [providerId]: {...result,
            ...(state.status === 'error' ? {error: localizedConnectionTestMessage(providerDiagnostics.get(providerId)?.titleKey || 'settings.services.keys.failed')} : {}),
          }}
        },
        isCurrent,
        failureMessage: 'settings.services.keys.failed',
      })
      if (!isCurrent()) return
      const enabledProviders = normalizeFreeTranslationOrder(config.value.freeTranslationOrder)
      // 全目录包含停用服务；只要启用池仍有成功项，就保留逐路结果而不放大成整体故障。
      if (Object.entries(freeProviderChecks.value).some(([id, state]) => enabledProviders.includes(id) && state.status === 'success')) clearConnectionDiagnostic()
      else connectionTestDiagnostic.value = enabledProviders.map(id => providerDiagnostics.get(id)).find(Boolean) || connectionTestDiagnostic.value
      connectionTestState.value = Object.values(freeProviderChecks.value).every(check => check.status === 'success') ? 'success' : 'error'
      connectionTestMessageState.value = localizedConnectionTestMessage('settings.services.keys.summary', {
        passed: Object.values(freeProviderChecks.value).filter(check => check.status === 'success').length,
        failed: Object.values(freeProviderChecks.value).filter(check => check.status === 'error').length,
      })
    } else if (compute.value.showToken && !compute.value.showServiceSecret && apiKeyIndexes.value.length > 0) {
      const checks = [...apiKeyIndexes.value]
      apiKeyCheckStates.value = Object.fromEntries(checks.map(index => [index, {status: 'queued' as const}]))
      let successes = 0
      for (const index of checks) {
        if (!isCurrent()) return
        if (await runApiKeyCheck(index, generation, controller.signal)) successes += 1
        if (connectionRetryWaiting.value) {
          apiKeyCheckStates.value = Object.fromEntries(Object.entries(apiKeyCheckStates.value).map(([row, state]) => [row, state.status === 'queued' ? {status: 'idle' as const} : state]))
          break
        }
      }
      if (!isCurrent()) return
      const failures = checks.length - successes
      connectionTestState.value = failures === 0 ? 'success' : 'error'
      connectionTestMessageState.value = null
    } else {
      const testWaitMs = isCompositeService.value && compositeProvider.value
        ? Math.min(45000, compositeProvider.value.timeoutMs * Math.max(1, compositeProvider.value.services.length)) + 5000
        : CONNECTION_RESPONSE_WAIT_TIMEOUT_MS
      const response = await waitForConnectionStep(browser.runtime.sendMessage({
        type: CONNECTION_TEST_MESSAGE,
        service: testedService,
      }), testWaitMs, 'settings.services.keys.responseTimeout', controller.signal) as {success?: boolean; durationMs?: number; error?: string; diagnostic?: unknown} | undefined
      if (!isCurrent()) return
      if (!response?.success) throw normalizeDiagnostic(response?.diagnostic) || new Error(response?.error || '连接测试失败')
      connectionTestState.value = 'success'
      connectionTestMessageState.value = `已完成真实翻译请求${typeof response.durationMs === 'number' ? `（${response.durationMs} ms）` : ''}。`
    }
  } catch (error) {
    if (!isCurrent()) return
    connectionTestState.value = 'error'
    connectionTestMessageState.value = chromePreparationDeadline !== undefined && Date.now() >= chromePreparationDeadline
      ? localizedConnectionTestMessage('settings.services.chromePreparation.error.timeout')
      : formatChromePreparationError(error)
  } finally {
    acceptChromePreparationStatus = false
    controller.abort()
    if (isCurrent()) {
      if (activeConnection === controller) activeConnection = undefined
      connectionTestBusy.value = false
    }
  }
}

type ServiceAction = {kind: 'reset' | 'delete' | 'sync'; config: Config; service: string; provider: CustomOpenAIProvider | undefined; sourceProvider: CustomOpenAIProvider | undefined; system: string; user: string; name: string}
const pendingServiceAction = shallowRef<ServiceAction | null>(null)
const serviceActionTitle = computed(() => pendingServiceAction.value?.kind === 'sync'
  ? t('settings.services.prompts.syncConfirmTitle')
  : translateLegacy(pendingServiceAction.value?.kind === 'delete' ? '删除自定义服务' : '恢复默认模板'))
const serviceActionMessage = computed(() => pendingServiceAction.value?.kind === 'delete'
  ? `确定要删除“${pendingServiceAction.value.name}”吗？相关模型和连接配置也会一并清理。`
  : pendingServiceAction.value?.kind === 'sync'
    ? t('settings.services.prompts.syncConfirmMessage', {count: promptSyncTargets.value.length})
    : '确定要恢复当前 AI 服务的默认 system 和 user 模板吗？此操作会覆盖当前模板。')
const serviceActionButtons = computed(() => {
  const action = pendingServiceAction.value
  const cancel = () => {if (pendingServiceAction.value === action) closeServiceAction()}
  return {confirm: () => performServiceAction(action), cancel, open: (open: boolean) => {if (!open) cancel()}}
})
function closeServiceAction(): void {pendingServiceAction.value = null;serviceActionOpen.value = false}
function isCurrentServiceAction(action: ServiceAction): boolean {
  return active.value && action.config === config.value && action.service === service.value && action.provider === customProvider.value
    && (action.kind === 'delete' ? Boolean(compute.value.showCustomOpenAI && customProvider.value?.id === service.value && customProvider.value.name === action.name)
      : Boolean(compute.value.showAI && activeSettingsTab.value === 'prompts'
        && action.system === config.value.system_role[service.value] && action.user === config.value.user_role[service.value]
        && (action.kind !== 'sync' || (servicesType.AI.has(action.service)
          || Boolean(action.sourceProvider && action.sourceProvider === sourcePromptProvider.value)))))
}
function openServiceAction(kind: ServiceAction['kind']): void {
  if (serviceActionOpen.value || !active.value) return
  const action: ServiceAction = {kind, config: config.value, service: service.value, provider: customProvider.value,
    sourceProvider: sourcePromptProvider.value, system: config.value.system_role[service.value], user: config.value.user_role[service.value], name: customProvider.value?.name || '此自定义服务'}
  if (kind === 'sync' && promptSyncTargets.value.length === 0) return
  if (!isCurrentServiceAction(action)) return
  pendingServiceAction.value = action;serviceActionOpen.value = true
}
function performServiceAction(action: ServiceAction | null): void {
  if (!action || action !== pendingServiceAction.value || !serviceActionOpen.value || !isCurrentServiceAction(action)) return
  closeServiceAction()
  if (action.kind === 'reset') {
    action.config.system_role[action.service] = defaultOption.system_role
    action.config.user_role[action.service] = defaultOption.user_role
    ElMessage.success(translateLegacy('已恢复当前 AI 服务默认模板'))
  } else if (action.kind === 'sync') {
    // 来源仍属于这次确认；目标允许删增，保留 main 按确认时刻重新计算全部可用 AI 服务的语义。
    const count = listPromptTemplateSyncTargets(action.config, action.service).length
    const next = applyPromptTemplateSync(action.config, action.service)
    action.config.system_role = next.system_role
    action.config.user_role = next.user_role
    ElMessage.success(t('settings.services.prompts.syncDone', {count}))
  } else emit('delete:custom-provider')
}
function resetCustomTemplate(): void {
  openServiceAction('reset')
}

const promptSyncTargets = computed(() => listPromptTemplateSyncTargets(config.value, service.value))

const syncPromptTemplates = computed(() => {
  const current = captureServiceActionContext()
  return () => {if (current()) openServiceAction('sync')}
})

function confirmDeleteProvider(): void {
  openServiceAction('delete')
}

watch(() => active.value ? [config.value, service.value, config.value.from, config.value.to, createApiKeyCheckRevision(config.value, service.value),
  isCompositeService.value ? JSON.stringify([compositeProvider.value, compositeProvider.value?.services.map(member => [member, createApiKeyCheckRevision(config.value, member)])]) : '',
  config.value.ak, config.value.sk, config.value.appid, config.value.key, config.value.secret?.[service.value],
  config.value.apiKeyRotationEnabled?.[service.value], compute.value.requireApiKey,
  ...(service.value === services.freeTranslation ? [config.value.myMemoryEmail, config.value.freeTranslationTimeoutMs] : [])] : null,
  invalidateConnectionTest, {flush: 'sync'})
watch(() => active.value && isChromeConnectionTest.value, enabled => {
  const generation = ++chromePreparationGeneration
  const revision = ++pendingChromePreparationRevision
  stopChromePreparationPendingWatch?.();stopChromePreparationPendingWatch = undefined
  pendingChromePreparation.value = null
  if (!enabled) return
  stopChromePreparationPendingWatch = chromeTranslationPreparationStore.subscribe(request => {
    if (!active.value || !isChromeConnectionTest.value || generation !== chromePreparationGeneration) return
    pendingChromePreparationRevision++;pendingChromePreparation.value = request
  })
  void chromeTranslationPreparationStore.get().then(request => {
    if (active.value && isChromeConnectionTest.value && generation === chromePreparationGeneration && revision === pendingChromePreparationRevision) pendingChromePreparation.value = request
  }).catch(() => undefined)
}, {immediate: true, flush: 'sync'})
watch(() => pendingServiceAction.value && !isCurrentServiceAction(pendingServiceAction.value), invalid => {if (invalid) closeServiceAction()}, {flush: 'sync'})
watch(serviceActionOpen, open => {if (!open) pendingServiceAction.value = null}, {flush: 'sync'})
</script>

<style scoped>
.service-connection-section { container-type: inline-size; display: grid; gap: 0; color: var(--ink, #172033); }
.connection-card { min-width: 0; border: 1px solid var(--line, #e4e7ef); border-radius: 14px; background: var(--surface, #fff); }
.connection-card { padding: 20px; }
.configuration-group-heading { margin-bottom: 8px; }
.configuration-group-heading h5 { margin: 0; color: var(--ink); font-size: 14px; font-weight: 650; line-height: 1.5; }
.configuration-group-heading p { margin: 5px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.connection-field { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: start; gap: 16px; padding: 14px 0; }
.connection-field + .connection-field { border-top: 1px solid var(--line, #e4e7ef); }
.connection-field-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; min-height: 38px; }
.connection-field-label small { flex-basis: 100%; }
.connection-field-label strong { color: var(--ink); font-size: 13px; font-weight: 550; line-height: 1.5; }
.connection-field-label small, .provider-field-help, .custom-headers-help, .model-thinking-setting > small, .model-vision-setting > small { color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.connection-field-control { display: flex; flex-direction: column; align-items: stretch; justify-self: start; width: 100%; max-width: 640px; min-width: 0; }
.connection-field-control :deep(.el-input), .connection-field-control :deep(.el-select), .connection-field-control :deep(.el-textarea) { width: 100% !important; max-width: 640px !important; }
.connection-field-control :deep(.el-select) { max-width: 360px !important; }
.service-connection-section :deep(.el-input__wrapper), .service-connection-section :deep(.el-select:not(.fluentread-select) .el-select__wrapper) { min-height: 38px; padding: 0 11px; border-radius: 10px; background: var(--surface, #fff); border-color: var(--line); }
.service-connection-section :deep(.el-input__inner), .service-connection-section :deep(.el-select__selected-item) { font-size: 13px; }
.service-connection-section :deep(.el-textarea__inner) { border-radius: 10px; background: var(--surface); font-size: 13px; padding: 10px 12px; }
.service-connection-section :deep(.el-switch) { --el-switch-on-color: var(--brand, #ef4776); }
.provider-field-help, .custom-headers-help { display: block; align-self: stretch; margin: 7px 0 0; }
.provider-field-help code { font-size: 11px; }
.credential-control { display: grid; justify-items: end; gap: 8px; }
.api-key-requirement { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.model-vision-setting { gap: 6px; }
.field-help-line { margin: 0; }
.field-help-line + .field-help-line { margin-top: 6px; }
.model-thinking-setting { justify-content: center; align-items: flex-start; min-height: 38px; }
/* 开关自带 4px 的点击留白：向外抵消，让可见轨道与其他控件左对齐，并保持与输入框相同的行高。 */
.model-thinking-setting :deep(.el-switch) { flex: none; margin: -3px 0 -3px -4px; }
.service-settings-tabs { margin-top: 18px; min-width: 0; --el-color-primary: var(--brand-strong); }
.service-settings-tabs.is-single-tab { margin-top: 0; }
.service-settings-tabs.is-single-tab :deep(.el-tabs__header) { display: none; }
.service-settings-tabs.is-single-tab .service-settings-panel { padding-top: 0; }
.service-settings-tabs :deep(.el-tabs__header) { margin: 0; }
.service-settings-tabs :deep(.el-tabs__item) { height: 44px; padding: 0 18px; color: var(--muted); font-size: 13px; font-weight: 550; }
.service-settings-tabs :deep(.el-tabs__item.is-active) { color: var(--brand-strong); }
.service-settings-tabs :deep(.el-tabs__nav-wrap::after) { height: 1px; background: var(--line); }
.service-settings-panel { min-width: 0; padding-top: 12px; }
.configuration-scope { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.credential-usage { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.credential-usage-label { color: var(--muted); font-size: 12px; white-space: nowrap; }
.credential-modes { display: flex; flex-wrap: wrap; padding: 3px; gap: 2px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.credential-modes label { position: relative; display: inline-flex; align-items: center; min-height: 24px; padding: 2px 10px; border-radius: 7px; color: var(--muted); font-size: 11px; font-weight: 600; white-space: nowrap; cursor: pointer; transition: color 140ms ease, background 140ms ease, box-shadow 140ms ease; }
.credential-modes label:not(.is-selected):hover { color: var(--ink); }
.credential-modes label.is-selected { color: var(--brand-strong); background: var(--surface); box-shadow: 0 2px 7px rgba(31, 40, 61, .09); }
.credential-modes input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.credential-modes label:has(input:focus-visible) { outline: 2px solid var(--brand); outline-offset: 2px; }
.credential-requirement { max-width: 360px; }
.custom-template-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin: 2px 0 12px; }
.custom-template-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin-left: auto; }
.prompt-sync-button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); font-size: 12px; font-weight: 550; cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
.prompt-sync-button:hover:not(:disabled) { border-color: var(--brand-border, #f3c0ce); color: var(--brand-strong); background: var(--brand-soft); }
.prompt-sync-button:disabled { opacity: .5; cursor: not-allowed; }
.prompt-template-list { display: grid; gap: 14px; }
.service-connection-section :deep(.request-limit-settings) { width: 100%; }
/* 连接字段紧接服务标题或模型行，上方已有分隔线：首行不再重复画线。 */
.connection-card > :deep(.api-key-list:first-child) { border-top: 0; }
.connection-card > .configuration-scope { padding: 14px 0 6px; }
.connection-test-inline { display: flex; align-items: center; justify-content: flex-start; gap: 12px; flex-wrap: wrap; margin: 14px 0; }
.connection-test-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 7px 12px; border: 1px solid var(--brand-border, #f3c0ce); border-radius: 9px; color: var(--brand-strong, #bd2853); background: var(--brand-soft, #fff0f4); font-size: 12px; font-weight: 600; cursor: pointer; }
.connection-test-button:hover:not(:disabled) { border-color: var(--brand); }
.connection-test-button:disabled { cursor: wait; opacity: .65; }
.connection-action-icon { flex: none; }
.is-spinning { animation: connection-spin 1s linear infinite; }
@keyframes connection-spin { to { transform: rotate(360deg); } }
.service-connection-action { position: relative; }
.service-connection-action .connection-test-button { width: auto; min-width: 116px; white-space: nowrap; }
.header-connection-status { position: absolute; top: calc(100% + 3px); right: 0; color: var(--muted); font-size: 11px; line-height: 17px; white-space: nowrap; }
.header-connection-status.is-success { color: var(--el-color-success); }
.header-connection-status.is-error { color: var(--el-color-danger); }
.service-connection-action .connection-test-inline { margin: 0; justify-content: space-between; }
.connection-test-result { display: grid; gap: 4px; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); background: var(--surface-soft); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.chrome-preparation-progress { margin-top: 4px; }
.connection-test-result.is-success { border-color: var(--el-color-success-light-5); color: var(--el-color-success); background: var(--el-color-success-light-9); }
.connection-test-result.is-error { border-color: var(--el-color-danger-light-5); color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.connection-repair-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.connection-repair-button { min-height: 32px; padding: 4px 10px; border: 1px solid currentColor; border-radius: 7px; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.connection-repair-button:hover:not(:disabled) { background: var(--surface); }
.connection-repair-button:disabled { opacity: .6; cursor: default; }
.field-warning, .error-text, .minimax-key-note.is-warning, .mimo-key-note.is-warning { color: var(--el-color-danger); font-size: 12px; line-height: 1.6; margin-top: 7px; }
.minimax-key-note, .mimo-key-note { margin: 8px 0; }
.minimax-endpoint code, .mimo-endpoint code { display: block; color: var(--muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.official-translation-help, .chrome-preparation-help { margin: 12px 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.official-translation-help p, .chrome-preparation-help p { margin: 0 0 8px; }
.official-translation-help a, .chrome-preparation-help a { color: var(--brand-strong); }
.chrome-preparation-help summary { cursor: pointer; color: var(--ink); }
.chrome-preparation-help-links, .chrome-preparation-pair { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.service-maintenance-actions { display: flex; justify-content: flex-end; padding-top: 16px; margin-top: 16px; border-top: 1px solid var(--line); }
.delete-service-button { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 8px; border: 0; border-radius: 6px; color: var(--el-color-danger); background: transparent; font-size: 12px; cursor: pointer; }
.delete-service-button:hover { background: var(--el-color-danger-light-9); }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
@container (max-width: 600px) {
  .connection-card { padding: 16px; }
  .connection-field { grid-template-columns: 1fr; gap: 8px; }
  [data-configuration-group="translation"] .connection-field { grid-template-columns: minmax(0, 1fr); }
  [data-configuration-group="translation"] .model-thinking-setting { justify-self: start; }
  [data-configuration-group="translation"] .model-vision-setting { width: 100%; }
  .connection-field-label { min-height: 24px; }
  .connection-field-control { max-width: none; }
  .custom-template-heading { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .advanced-chevron { transition: none; } .is-spinning { animation: none; } }
.endpoint-token-help { margin-top: 10px; font-size: 12px; color: var(--muted); }
.endpoint-token-help summary { cursor: pointer; color: var(--brand-strong); }
/* 详情本身就是主卡片，内部按用途分组，不再嵌套大容器。 */
.connection-card { padding: 0; border: 0; border-radius: 0; }
.configuration-group-heading { margin: 0 0 10px; }
.configuration-group-heading h5 { font-size: 13px; font-weight: 650; }
/* 单页签标题：用分隔线和留白与上方连接区分成两个并列小节，下方直接接第一行字段。 */
.configuration-group-heading.settings-tabs-heading { margin: 20px 0 0; padding-top: 20px; border-top: 1px solid var(--line); }
.provider-account-fields { min-width: 0; }
@container (max-width: 520px) { .provider-account-fields { grid-template-columns: 1fr; gap: 8px; } }
</style>
