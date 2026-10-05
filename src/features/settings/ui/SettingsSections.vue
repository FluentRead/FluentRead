<!--
 * @file src/features/settings/ui/SettingsSections.vue
 * 文件职责：承载 FluentRead Options 页面各业务设置分区，连接运行时配置、服务选择、快捷键、站点规则、翻译中心、OCR、词书以及导入导出和历史恢复。
 * 主要内容：图片设置优先展示语言、服务与识别选择，资源与入口按需展开；翻译设置首先展示带交互示例的阅读辅助，普通页面连续展示任务分组并标记顶部导航的滚动定位目标，统计与网站规则保留按任务切换的视图，集中分配功能服务并将模型用量合并到翻译统计，保留已访问表单实例；包含正文/全部节点识别范围；模板按 activeSection 展示业务分区，通用设置首先展示全局翻译开关，再按基础配置、网页辅助、基本偏好组织控件，软件语言保留固定英文标题与说明以便选错语言后恢复，提供当前默认服务的配置入口并保留译文样式跨页入口；图片与圈选合并在同页，共享仅在当前分区挂载的 OCR 管理组件；服务连接在主页面的服务目录内编辑，在界面风格页组织译文样式、风格与菜单栏布局，仅在高级选项激活时挂载缓存管理；脚本以独立配置副本隔离编辑与全局差分基线，协调网站入口、配置及凭据保存、历史恢复、能力过滤和离页补丁交接。
 * 模块边界：该组件负责设置 UI 编排但不实现 provider 网络、配置仓库或 feature 运行时；校验与迁移来自 core/config，持久化经 services/config，复杂子界面保持在各自 feature/组件内。
 -->
<template>
  <section v-if="hasVisitedSection('settings-general')" v-show="props.activeSection === 'settings-general'" id="settings-general" class="settings-section general-settings-section">
    <SettingsGroup class="plugin-master-setting" data-testid="plugin-master-setting">
      <FeatureEnableCard v-model="config.on" :title="t('settings.general.masterTitle')" :description="t('settings.general.masterHelp')" @update:model-value="handlePluginStateChange" />
    </SettingsGroup>
    <SettingsGroup
      title="基础配置"
      data-testid="translation-display-settings"
      data-settings-anchor="basics" data-settings-anchor-label="基础配置"
    >
      <SettingsItem label="默认网页翻译服务" :description="t('quickTranslation.defaultServiceDescription')">
        <div
          class="service-default-control general-service-control"
          data-testid="default-translation-service-card"
          :data-default-service="config.service"
        >
          <el-select v-model="config.service" aria-label="默认网页翻译服务" placeholder="请选择翻译服务" :search-placeholder="t('select.searchService')" filterable>
            <template #prefix><ServiceIcon :service="config.service" :label="defaultTextServiceLabel" size="small" /></template>
            <el-option v-if="selectedTextServiceUnavailableMessage" label="Chrome内置AI翻译（当前浏览器不可用）" :value="config.service" disabled />
            <el-option-group v-for="group in textServiceGroups" :key="group.value" :label="group.label">
              <el-option v-for="item in group.options" :key="item.value" :label="item.label" :value="item.value" :disabled="item.disabled">
                <span class="fluentread-service-option"><ServiceIcon :service="item.value" :label="item.label" size="small" /><span>{{ item.label }}</span></span>
              </el-option>
            </el-option-group>
          </el-select>
          <button
            type="button"
            class="general-service-configure"
            data-testid="configure-default-translation-service"
            @click="openInputServiceSettings(config.service)"
          >
            配置服务
          </button>
        </div>
      </SettingsItem>
      <SettingsItem
        data-testid="translation-language-setting"
        :label="t('settings.general.defaultTargetLanguage')"
        :description="t('settings.general.defaultTargetLanguageDescription')"
      >
        <el-select v-model="config.to" data-config-field="to" :aria-label="t('settings.general.defaultTargetLanguage')" :placeholder="t('settings.general.targetLanguagePlaceholder')" filterable>
          <el-option v-for="item in options.to" :key="item.value" data-i18n-ignore class="select-left" :label="getMultilingualTargetLanguageLabel(item.value, item.label, language)" :value="item.value" />
        </el-select>
      </SettingsItem>
      <SettingsItem label="翻译模式" description="双语对照保留原文，仅译文模式会替换原文显示">
        <SegmentedControl v-model="config.display" :options="options.display" label="翻译模式" />
      </SettingsItem>
      <SettingsItem :label="t('settings.translationStyle.title')" :description="t('settings.translationStyle.description')">
        <button
          type="button"
          class="settings-navigation-link"
          data-testid="open-translation-style-settings"
          @click="openSettingsSection('settings-interface')"
        >
          <span>{{ t('settings.translationStyle.openFromGeneral') }}</span>
          <el-icon aria-hidden="true"><ArrowRight /></el-icon>
        </button>
      </SettingsItem>
    </SettingsGroup>
    <div v-if="selectedTextServiceUnavailableMessage" class="disabled-section" role="status">
      <strong>当前默认服务在此浏览器不可用</strong>
      <p>{{ selectedTextServiceUnavailableMessage }}请在上方选择可用服务。</p>
    </div>
    <section id="feature-services" class="service-assignments-section" data-settings-anchor="services" :data-settings-anchor-label="t('featureServices.assignments')" :aria-label="t('featureServices.assignments')">
      <FeatureServiceSettings :config="config" :service-options="availableServiceOptions" @configure-service="openInputServiceSettings" />
    </section>
  </section>
  <section v-if="hasVisitedSection('settings-sites')" v-show="props.activeSection === 'settings-sites'" id="settings-sites" class="settings-section site-settings-section">
    <SettingsPanel name="rules" :active="props.activePanel">
      <SitePreferencesSettings :settings="config" :save-preferences="persistConfigPatch" />
</SettingsPanel>
    <SettingsPanel name="adaptation" :active="props.activePanel">
      <SiteAdaptationSettings :model-value="config.siteAdaptation" :save-settings="saveSiteAdaptationSettings" :inspect-rule-id="siteRuleInspectId" />
</SettingsPanel>
    <SettingsPanel name="preview" :active="props.activePanel">
      <SiteRulePreview :settings="config" :adaptation="config.siteAdaptation" :scope="config.translationScope" @inspect-rule="inspectSiteRule" />
    </SettingsPanel>
  </section>
  <section v-if="hasVisitedSection('settings-translation-center')" v-show="props.activeSection === 'settings-translation-center'" id="settings-translation-center" class="settings-section translation-center-section">
    <TranslationCenter @configure-service="openInputServiceSettings" />
  </section>
  <section v-if="hasVisitedSection('settings-writing')" v-show="props.activeSection === 'settings-writing'" id="settings-writing" class="settings-section">
    <WritingSettings :config="config" @configure-service="openWritingServiceSettings()" />
  </section>
  <section v-if="hasVisitedSection('settings-selection')" v-show="props.activeSection === 'settings-selection'" id="settings-selection" class="settings-section">
    <SelectionSettings :config="config">
    <SettingsGroup v-if="config.selectionTranslatorMode !== 'disabled'" title="触发与显示" data-settings-anchor="trigger" data-settings-anchor-label="触发与显示" description="推荐选择“点击图标”，选中文字后点击入口再翻译；选择快捷键或仅右键菜单时不显示浮动入口">
    <SettingsItem v-if="config.selectionTranslatorMode !== 'disabled'" label="显示内容" description="两种呈现均可保留原文或只显示译文">
      <SegmentedControl v-model="config.selectionTranslatorMode" :options="selectionTranslatorModeOptions.filter(item => item.value !== 'disabled')" label="划词显示内容" />
    </SettingsItem>
    <el-row v-if="config.selectionTranslatorMode !== 'disabled'" class="settings-control-row" :class="{ 'custom-hotkey-row': config.selectionTranslatorTrigger === 'custom' }">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" :content="t('selectionTrigger.modeDescription')" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            划词触发方式
            <el-icon class="icon-margin"><InfoFilled /></el-icon>
          </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end">
        <div class="hotkey-config">
          <el-select :model-value="config.selectionTranslatorTrigger" aria-label="划词翻译触发方式" placeholder="选择触发方式" size="small" style="width: 100%" @change="handleSelectionTriggerChange">
            <el-option v-for="item in options.selectionTranslatorTriggers" :key="item.value" :label="item.value === 'contextMenu' ? t('selectionTrigger.contextMenu') : item.label" :value="item.value" />
          </el-select>
          <small v-if="config.selectionTranslatorTrigger === 'direct'" class="selection-context-menu-hint">直接弹出会在每次划词后打开译文，容易打断阅读</small>
          <small v-if="config.selectionTranslatorTrigger === 'contextMenu'" class="selection-context-menu-hint" :class="{ 'is-unavailable': config.contextMenuEnabled === false || config.contextMenuEntries?.translateSelection === false }">
            {{ t(config.contextMenuEnabled === false || config.contextMenuEntries?.translateSelection === false ? 'selectionTrigger.contextMenuUnavailable' : 'selectionTrigger.contextMenuHint') }}
          </small>
          <div v-if="config.selectionTranslatorTrigger === 'custom'" class="custom-hotkey-display">
            <span class="hotkey-text" v-if="config.customSelectionTranslatorHotkey">
              {{ getCustomSelectionHotkeyDisplayName() }}
            </span>
            <span class="hotkey-text placeholder-text" v-else>
              点击设置自定义快捷键
            </span>
            <el-button
              size="small"
              type="text"
              class="edit-button"
              aria-label="编辑划词翻译快捷键"
              title="编辑划词翻译快捷键"
              @click="openCustomSelectionHotkeyDialog"
            >
              <el-icon><Edit /></el-icon>
            </el-button>
          </div>
        </div>
      </el-col>
    </el-row>
    <SettingsItem v-if="config.selectionTranslatorMode !== 'disabled'" label="继续阅读时自动收起" description="滚动页面或复制原文时自动收起，鼠标移开后隐藏未点击的入口；卡片内的滚动和复制不受影响">
      <el-switch v-model="config.selectionTranslatorAutoDismiss" class="settings-toggle" aria-label="继续阅读时自动收起" />
    </SettingsItem>
    <el-row v-if="config.selectionTranslatorMode !== 'disabled'" class="settings-control-row">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="从选区稳定后开始计时，再显示图标、小点或翻译面板；快捷键在等待结束后按下会立即显示" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            划词显示延迟
            <el-icon class="icon-margin"><InfoFilled /></el-icon>
          </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end translation-delay-field">
        <el-input-number
          v-model="config.selectionTranslatorDelay"
          aria-label="划词翻译显示延迟"
          :min="SELECTION_TRANSLATOR_DELAY_MIN"
          :max="SELECTION_TRANSLATOR_DELAY_MAX"
          :step="SELECTION_TRANSLATOR_DELAY_STEP"
          @change="handleSelectionTranslatorDelayChange"
        />
        <span class="input-suffix">ms</span>
      </el-col>
    </el-row>
    <SettingsItem
      v-if="config.selectionTranslatorMode !== 'disabled' && ['en', 'zh-Hans', 'zh-Hant'].includes(config.to)"
      label="中英双向划词"
      description="选中中文或英文时，即使与目标语言相同也会显示划词入口，并自动译成另一种语言；卡片内可临时切换语言，默认设置保持不变"
    >
      <el-switch v-model="config.selectionTranslatorBidirectional" class="settings-toggle" aria-label="中英双向划词" />
    </SettingsItem>
    <SettingsItem v-if="config.selectionTranslatorTrigger === 'hover'" label="悬停等待" description="将鼠标停在划词图标上，等待设定时间后打开译文；移开鼠标则取消">
      <el-input-number v-model="config.harness.hoverDelay" :min="200" :max="3000" :step="100" aria-label="悬停等待时间" />
    </SettingsItem>
    </SettingsGroup>
    <template #advanced><SettingsGroup title="朗读声音">
    <el-row v-if="config.selectionTranslatorMode !== 'disabled'" class="settings-control-row">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="朗读失败时按这里的顺序依次尝试；留空则根据当前语言自动选择" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            备用音色顺序
            <el-icon class="icon-margin"><InfoFilled /></el-icon>
          </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end">
        <div class="selection-tts-voice-control">
          <el-select
            v-model="config.selectionTtsVoices"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            aria-label="划词翻译备用音色顺序"
            placeholder="自动按语言选择"
            no-data-text="没有可用音色"
          >
            <el-option v-for="item in selectionTtsVoiceOptions" :key="item.value" :label="`${item.label} · ${item.locale}`" :value="item.value" />
          </el-select>
          <small>留空时根据语言自动尝试免费 Edge 音色；选择多个音色后，朗读失败时按此顺序尝试，无需 API Key</small>
        </div>
      </el-col>
    </el-row>
    </SettingsGroup><LocalTtsSettings :config="config" /></template>
    </SelectionSettings>
  </section>
  <section v-if="hasVisitedSection('settings-glossary')" v-show="props.activeSection === 'settings-glossary'" id="settings-glossary" class="settings-section">
    <GlossarySettings />
  </section>
  <div class="settings-main-sections">
    <!-- 翻译服务 -->
    <section v-if="hasVisitedSection('settings-services')" v-show="props.activeSection === 'settings-services'" id="settings-services" class="settings-section">
      <SettingsPanel name="connections" :active="props.activePanel">
      <ServiceCatalog
        :service="selectedConfigurationService"
        :default-service="config.service"
        :website="selectedConfigurationWebsite"
        :credential-guide="selectedConfigurationCredentialGuide"
        :selected-model="selectedConfigurationModel"
        :services="configurationCompute.filteredServices"
        :favorite-services="config.favoriteServices"
        :configured-services="configuredServiceIds"
        :model-options="configurationModelOptions"
        :show-model="configurationCompute.showModel"
        :maximum-models="MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER"
        :maximum-model-length="MAX_CUSTOM_OPENAI_MODEL_LENGTH"
        :custom-model-count="selectedConfigurationCustomModelCount"
        :allow-custom-models="configurationCompute.allowCustomModels"
        @update:service="setConfigurationService"
        @update:favorites="config.favoriteServices = $event"
        @update:model="selectConfigurationModel"
        @add:service="openCustomProviderDialog"
        @add:model="addConfigurationModel"
        @remove:model="removeConfigurationModel"
      >
        <template #configuration="{ connectionActionTarget }">
          <ServiceConfiguration
            :connection-action-target="connectionActionTarget"
            :config="config"
            :service="selectedConfigurationService"
            :selected-model-thinking="selectedConfigurationModelThinking"
            :compute="configurationCompute"
            :options="options"
            :is-valid-azure-endpoint="isValidAzureEndpoint"
            :custom-provider="selectedCustomProvider"
            @update:model-thinking="updateSelectedConfigurationModelThinking"
            @update:custom-provider="updateSelectedCustomProvider"
            @delete:custom-provider="deleteSelectedCustomProvider"
          />
        </template>
      </ServiceCatalog>
      </SettingsPanel>
    </section>
    <section v-if="hasVisitedSection('settings-image-translation')" v-show="props.activeSection === 'settings-image-translation'" id="settings-image-translation" class="settings-section image-translation-settings">
      <MangaSettings v-if="props.activeSection === 'settings-image-translation'" v-model:image-enabled="imageTranslationEnabled" :settings="config" :available="browserCapabilities.imageTranslation" :service-options="availableServiceOptions">
        <div id="settings-area-translation" data-settings-anchor="area" :data-settings-anchor-label="t('area.settings.title')">
          <AreaTranslationSettings :config="config" :service-options="availableServiceOptions" :enabled="selectionAreaTranslationEnabled" :active="props.activeSection === 'settings-image-translation'" :show-ocr="false" compact @update:enabled="selectionAreaTranslationEnabled = $event" />
        </div>
      <template #resources><ImageOcrSettings v-if="props.activeSection === 'settings-image-translation'" compact v-model:source-language="config.from" /></template>
      </MangaSettings>
    </section>
    <section v-if="hasVisitedSection('settings-video')" v-show="props.activeSection === 'settings-video'" id="settings-video" class="settings-section">
      <SettingsPanel name="general" :active="props.activePanel">
      <SettingsGroup>
        <FeatureEnableCard v-model="config.videoTranslationEnabled" title="视频字幕翻译" description="翻译 YouTube、X、Udemy、Disney+ 视频和 Teams、Zoom、Google Meet 网页会议中的字幕，不上传音频或视频内容"  />
        <SettingsItem label="会议平台自动开启双语字幕" description="在 Teams、Zoom、Google Meet 网页会议中自动开启可用字幕；平台或主持人需允许字幕" :disabled="!config.videoTranslationEnabled">
          <el-switch v-model="config.videoMeetingAutoEnabled" class="settings-toggle" aria-label="会议平台自动开启双语字幕" :disabled="!config.videoTranslationEnabled" />
        </SettingsItem>
        <SettingsItem label="优先使用人工字幕" description="YouTube、Udemy、Disney+ 有目标语言人工字幕时优先使用；不可用时继续翻译原字幕" :disabled="!config.videoTranslationEnabled">
          <el-switch v-model="config.videoPreferHumanSubtitles" class="settings-toggle" aria-label="优先使用人工字幕" :disabled="!config.videoTranslationEnabled" />
        </SettingsItem>
        <SettingsItem label="视频翻译服务" description="默认跟随网页翻译服务，也可单独选择；AI 服务会提前预取字幕" :disabled="!config.videoTranslationEnabled">
          <el-select v-model="config.videoService" :empty-values="[null, undefined]" aria-label="视频字幕翻译服务" :disabled="!config.videoTranslationEnabled" placeholder="请选择服务" filterable>
            <el-option :label="t('featureServices.followDefault')" value="" />
            <el-option v-if="config.videoService && selectedVideoServiceUnavailableMessage" label="Chrome内置AI翻译（当前浏览器不可用）" :value="config.videoService" disabled />
            <el-option v-for="item in videoServiceOptions" :key="item.value" class="select-left" :label="item.label" :value="item.value" />
          </el-select>
          <p v-if="selectedVideoServiceUnavailableMessage" class="capability-warning">{{ selectedVideoServiceUnavailableMessage }}</p>
        </SettingsItem>
        <SettingsItem
          v-if="config.glossaryLibraries.length || config.glossaryEnabled"
          :label="t('glossary.title')"
          :description="videoGlossaryDescription"
          :disabled="!config.videoTranslationEnabled"
        >
          <GlossaryLibrarySelect
            v-model="config.videoGlossaryIds"
            :libraries="config.glossaryLibraries"
            :enabled="config.glossaryEnabled"
            :disabled="!config.videoTranslationEnabled"
            :show-copy="false"
          >
            <template #mode-control="{mode, changeMode}">
              <el-select
                :model-value="mode"
                :aria-label="t('glossary.mode')"
                :disabled="!config.videoTranslationEnabled"
                @update:model-value="changeMode"
              >
                <el-option value="inherit" :label="t('glossary.inherit')" />
                <el-option value="none" :label="t('glossary.none')" />
                <el-option value="selected" :label="t('glossary.choose')" :disabled="!config.glossaryLibraries.length" />
              </el-select>
            </template>
          </GlossaryLibrarySelect>
        </SettingsItem>
        <SettingsItem label="显示 FluentRead 字幕" description="临时隐藏扩展字幕时保留当前翻译设置" :disabled="!config.videoTranslationEnabled">
          <el-switch v-model="config.videoSubtitleVisible" class="settings-toggle" aria-label="显示 FluentRead 视频字幕" :disabled="!config.videoTranslationEnabled" />
        </SettingsItem>
        <SettingsItem label="字幕显示模式" description="选择同时显示原文和译文，或只显示其中一种" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible">
          <SegmentedControl
            v-model="config.videoSubtitleDisplayMode"
            :options="videoSubtitleDisplayModeOptions"
            label="视频字幕显示模式"
            :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible"
          />
        </SettingsItem>
      </SettingsGroup>
      </SettingsPanel>
      <SettingsPanel name="appearance" :active="props.activePanel">
<VideoSubtitleAppearanceSettings :config="config" />
</SettingsPanel>
      <SettingsPanel name="local" :active="props.activePanel">
<SettingsGroup title="X 本地 AI 字幕" description="仅 X 无原生字幕时使用；模型和音频留在当前浏览器，下载后可离线识别">
        <SettingsItem label="视频原语言" description="仅用于 X 没有原生字幕时的本地识别；自动检测适合大多数视频" :disabled="!config.videoTranslationEnabled || !browserCapabilities.extensionDom">
          <el-select v-model="config.videoSourceLanguage" aria-label="视频原语言" :disabled="!config.videoTranslationEnabled || !browserCapabilities.extensionDom" placeholder="请选择视频原语言">
            <el-option v-for="item in VIDEO_SOURCE_LANGUAGE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </SettingsItem>
        <VideoLocalModelSettings :config="config" />
      </SettingsGroup>
</SettingsPanel>
      <details class="feature-help">
        <summary>使用说明</summary>
        <p>开启 YouTube 原生字幕后显示译文，机器翻译约提前 10 秒、AI 服务约提前 30 秒准备；可从播放器菜单下载原文或译文 SRT</p>
      </details>
    </section>
    <!-- 鼠标悬浮快捷键 -->
    <section v-if="hasVisitedSection('settings-translation')" v-show="props.activeSection === 'settings-translation'" id="settings-translation" class="settings-section">
<SettingsPanel name="reading" :active="props.activePanel">
  <ReadingAssistanceSettings :config="config" @configure-style="openSettingsSection('settings-interface', 'translation-sentence-highlight-style')" />
</SettingsPanel>
<SettingsPanel name="hover" :active="props.activePanel">
    <SettingsGroup title="鼠标悬浮翻译" description="按住快捷键并把鼠标移到文本上，等待设定时间后开始翻译">
    <el-row class="settings-control-row" :class="{ 'custom-hotkey-row': config.hotkey === 'custom' }">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="按住指定快捷键并悬停在文本上进行翻译" placement="top-start" :show-after="500">
        <span class="popup-text popup-vertical-left">
          {{ t('quickTranslation.commonHoverShortcut') }}
          <el-icon class="icon-margin">
            <InfoFilled />
          </el-icon>
        </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end">
        <div class="hotkey-config">
          <el-select
            :model-value="config.hotkey"
            aria-label="鼠标悬浮快捷键"
            placeholder="请选择快捷键"
            size="small"
            style="width: 100%"
            @change="handleMouseHotkeyChange"
          >
            <el-option v-for="item in options.keys" :key="item.value" :label="item.label" :value="item.value" :disabled="item.disabled" :class="{ 'select-divider': item.disabled }" />
          </el-select>

          <!-- 自定义快捷键显示（选择自定义时总是显示） -->
          <div v-if="config.hotkey === 'custom'" class="custom-hotkey-display">
            <span class="hotkey-text" v-if="config.customHotkey">
              {{ getCustomMouseHotkeyDisplayName() }}
            </span>
            <span class="hotkey-text placeholder-text" v-else>
              点击设置自定义快捷键
            </span>
            <el-button
              size="small"
              type="text"
              class="edit-button"
              aria-label="编辑鼠标悬浮快捷键"
              title="编辑鼠标悬浮快捷键"
              @click="openCustomMouseHotkeyDialog"
            >
              <el-icon><Edit /></el-icon>
            </el-button>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-row class="settings-control-row">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="按住悬浮快捷键并移动鼠标后，等待设定时间再翻译；增加延迟可减少 Ctrl+C 等组合键的误触，松开快捷键触发的单次翻译不受影响" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            悬浮翻译延迟
            <el-icon class="icon-margin"><InfoFilled /></el-icon>
          </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end translation-delay-field">
        <el-input-number
          v-model="config.mouseHoverTranslationDelay"
          aria-label="悬浮翻译延迟"
          :min="MOUSE_HOVER_TRANSLATION_DELAY_MIN"
          :max="MOUSE_HOVER_TRANSLATION_DELAY_MAX"
          :step="MOUSE_HOVER_TRANSLATION_DELAY_STEP"
          @change="handleMouseHoverTranslationDelayChange"
        />
        <span class="input-suffix">ms</span>
      </el-col>
    </el-row>
    <QuickTranslationProfiles :config="config" action="hover" :profiles="config.quickTranslationProfiles"
      @update:profiles="config.quickTranslationProfiles = $event" />
    </SettingsGroup>
    </SettingsPanel>
</section>



    <!-- 高级选项 -->
    <section v-if="hasVisitedSection('settings-advanced')" v-show="props.activeSection === 'settings-advanced'" id="settings-advanced" class="settings-section">
      <SettingsPanel name="recognition" :active="props.activePanel">
<SettingsGroup :title="t('settings.pageRecognition.title')">
        <SettingsItem :label="t('settings.pageRecognition.allNodes')" :description="t('settings.pageRecognition.description')">
          <el-switch v-model="config.translationScope" active-value="all" inactive-value="content" class="settings-toggle" :aria-label="t('settings.pageRecognition.allNodes')" />
        </SettingsItem>
        <SettingsItem :label="t('settings.pageRecognition.pageTitle')" :description="t('settings.pageRecognition.pageTitleDescription')">
          <el-switch v-model="config.pageTitleTranslationEnabled" class="settings-toggle" :aria-label="t('settings.pageRecognition.pageTitle')" />
        </SettingsItem>
        <SettingsItem :label="t('settings.pageRecognition.sidebar')" :description="t('settings.pageRecognition.sidebarDescription')">
          <el-switch v-model="config.sidebarTranslationEnabled" class="settings-toggle" :aria-label="t('settings.pageRecognition.sidebar')" />
        </SettingsItem>
      </SettingsGroup>
      <ParagraphHandlingSettings :config="config" />
</SettingsPanel>
      <SettingsPanel name="cache" :active="props.activePanel">
<TranslationCacheSettings :config="config" />
</SettingsPanel>
    </section>

    <section v-if="hasVisitedSection('settings-general')" v-show="props.activeSection === 'settings-general'" class="settings-section settings-section-continuation">
      <SettingsGroup title="网页辅助" data-settings-anchor="assistance" data-settings-anchor-label="网页辅助">
        <SettingsItem
          :label="t('settings.general.translationSettingsShortcut')"
          :description="t('settings.general.translationSettingsShortcutDescription')"
        >
          <button
            type="button"
            class="settings-navigation-link"
            data-testid="open-translation-settings"
            @click="openSettingsSection('settings-translation')"
          >
            <span>{{ t('settings.general.translationSettingsShortcutAction') }}</span>
            <el-icon aria-hidden="true"><ArrowRight /></el-icon>
          </button>
        </SettingsItem>
        <!-- AI 智能上下文 -->
        <el-row class="settings-control-row">
          <el-col :span="20" class="settings-control-label ai-context-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark"
                        :content="t('popup.aiContext.how')"
                        placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">{{ t('popup.aiContext.settingsTitle') }}<el-icon class="icon-margin">
                  <InfoFilled />
                </el-icon></span>
            </el-tooltip>
            <small class="settings-control-hint">可提前开启；仅在支持的 AI 服务下采集网页语境并生效，其他服务会保留此偏好但不会发送上下文</small>
          </el-col>

          <el-col :span="4" class="settings-control-field flex-end">
            <el-switch v-model="config.enableAIContext" class="settings-toggle" :aria-label="t('popup.aiContext.settingsTitle')" />
          </el-col>
        </el-row>

        <!-- 悬浮球开关 -->
      <el-row id="floating-ball-toggle" class="settings-control-row">
        <el-col :span="20" class="settings-control-label floating-ball-control-label lightblue rounded-corner">
          <el-tooltip class="box-item" effect="dark" content="在屏幕边缘显示悬浮球，点击即可翻译整个网页" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            全文翻译悬浮球
            <el-icon class="icon-margin">
              <InfoFilled />
            </el-icon>
          </span>
          </el-tooltip>
          <small class="floating-ball-settings-hint">
            <button type="button" class="settings-inline-link" data-testid="open-floating-ball-settings" @click="openSettingsSection('settings-translation', 'floating-ball-settings')">
              {{ t('settings.general.floatingBallSettingsAction') }}
            </button>
          </small>
        </el-col>

        <el-col :span="4" class="settings-control-field flex-end">
          <el-switch v-model="floatingBallEnabled" class="settings-toggle" aria-label="全文翻译悬浮球" />
        </el-col>
      </el-row>

        <!-- 翻译进度面板 -->
        <el-row class="settings-control-row">
          <el-col :span="20" class="settings-control-label lightblue rounded-corner">
            <el-tooltip
              class="box-item"
              effect="dark"
              content="全文翻译时，在网页右下角显示正在翻译和等待中的任务数量；任务结束后自动隐藏"
              placement="top-start"
              :show-after="500"
            >
              <span class="popup-text popup-vertical-left">
                显示翻译进度面板
                <el-icon class="icon-margin"><InfoFilled /></el-icon>
              </span>
            </el-tooltip>
          </el-col>
          <el-col :span="4" class="settings-control-field flex-end">
            <el-switch
              v-model="config.translationProgressPanelEnabled"
              class="settings-toggle"
              aria-label="显示翻译进度面板"
              @change="handleTranslationProgressPanelChange"
            />
          </el-col>
        </el-row>

      </SettingsGroup>
      <SettingsGroup title="基本偏好" data-settings-anchor="preferences" data-settings-anchor-label="基本偏好">
        <SettingsItem data-testid="ui-language-setting" :label="t('settings.general.language')" :description="t('language.settingsDescription')">
          <template #copy>
            <strong data-i18n-ignore>{{ t('settings.general.language') }}<span v-if="language !== 'en-US'" lang="en"> / App language</span></strong>
            <small data-i18n-ignore>{{ t('language.settingsDescription') }}</small>
            <small v-if="language !== 'en-US'" lang="en" data-i18n-ignore>Choose the language used across FluentRead.</small>
          </template>
          <UiLanguageSelector compact />
        </SettingsItem>
        <SettingsItem label="界面主题" description="只影响扩展界面，不会改变网页本身的配色">
          <SegmentedControl v-model="config.theme" :options="options.theme" label="界面主题" />
        </SettingsItem>
      </SettingsGroup>
    </section>

    <section v-if="hasVisitedSection('settings-interface')" v-show="props.activeSection === 'settings-interface'" id="settings-interface" class="settings-section">
      <InterfaceSettings :config="config" :active-panel="props.activePanel" />
    </section>

    <section v-if="hasVisitedSection('settings-translation')" v-show="props.activeSection === 'settings-translation'" class="settings-section settings-section-continuation">
<SettingsPanel name="input" :active="props.activePanel">
      <InputTranslationSettings
        :config="config"
        :service-options="availableServiceOptions"
        @trigger-change="handleInputBoxTranslationTriggerChange"
      />
    </SettingsPanel>
</section>

    <section v-if="hasVisitedSection('settings-translation')" v-show="props.activeSection === 'settings-translation'" class="settings-section settings-section-continuation">
<SettingsPanel name="page" :active="props.activePanel">
      <SettingsGroup title="全文翻译" description="设置启动全文翻译的方式、处理范围和网页内入口">
        <el-row class="settings-control-row" :class="{ 'custom-hotkey-row': config.floatingBallHotkey === 'custom' }">
          <el-col :span="14" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark" content="设置快捷键，用于在全文翻译和原文之间切换" placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">{{ t('quickTranslation.commonFullPageShortcut') }}<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="10" class="settings-control-field flex-end">
            <div class="hotkey-config">
              <el-select :model-value="config.floatingBallHotkey" aria-label="全文翻译快捷键" placeholder="选择快捷键" size="small" style="width: 100%" @change="handleHotkeyChange">
                <el-option v-for="item in options.floatingBallHotkeys" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <div v-if="config.floatingBallHotkey === 'custom'" class="custom-hotkey-display">
                <span v-if="config.customFloatingBallHotkey" class="hotkey-text">{{ getCustomHotkeyDisplayName() }}</span>
                <span v-else class="hotkey-text placeholder-text">点击设置自定义快捷键</span>
                <el-button size="small" type="text" class="edit-button" aria-label="编辑全文翻译快捷键" title="编辑全文翻译快捷键" @click="openCustomHotkeyDialog">
                  <el-icon><Edit /></el-icon>
                </el-button>
              </div>
            </div>
          </el-col>
        </el-row>
        <el-row class="settings-control-row">
          <el-col :span="20" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark" content="开启后，使用支持通用提示词的 AI 服务进行全文翻译时，会把相邻短段合并为一次请求；机器翻译、悬浮、划词和输入框翻译不受影响" placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">AI 多段翻译<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="4" class="settings-control-field flex-end">
            <el-switch v-model="config.enableAIMultiSegment" class="settings-toggle" aria-label="AI 多段翻译" />
          </el-col>
        </el-row>

        <el-row class="settings-control-row">
          <el-col :span="14" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark" content="“按阅读进度”预翻译可视区域附近的内容；“立即翻译到网页底部”处理已加载的整页及后续新增内容，无需自动滚动，可能增加无限滚动页面的请求量和费用；下次启动全文翻译时生效" placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">全文翻译范围<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="10" class="settings-control-field flex-end">
            <SegmentedControl v-model="config.fullPageTranslationMode" :options="fullPageTranslationModeOptions" label="全文翻译范围" />
          </el-col>
        </el-row>

        <QuickTranslationProfiles :config="config" action="full-page" :profiles="config.quickTranslationProfiles"
          @update:profiles="config.quickTranslationProfiles = $event" />
      </SettingsGroup>
      <SettingsGroup
        v-if="browserCapabilities.browser === 'userscript'"
        data-userscript-unavailable="context-menu"
        :title="t('contextMenuSettings.title')"
        :description="t('options.userscriptUnavailableDescription')"
      />
      <ContextMenuSettings v-else :config="config" />
    </SettingsPanel>
</section>

    <section v-if="hasVisitedSection('settings-translation')" v-show="props.activeSection === 'settings-translation'" id="floating-ball-settings" class="settings-section settings-section-continuation">
<SettingsPanel name="tools" :active="props.activePanel">
      <FloatingBallSettings :config="config" />
    </SettingsPanel>
</section>

    <section v-if="hasVisitedSection('settings-translation')" v-show="props.activeSection === 'settings-translation'" class="settings-section settings-section-continuation">
<SettingsPanel name="tools" :active="props.activePanel">
      <ParagraphCopySettings :config="config" />
      <SectionTranslationSettings :config="config" />
      <ExcludedLanguageSettings v-model="config.excludedLanguages" />
    </SettingsPanel>
</section>

    <section v-if="hasVisitedSection('settings-advanced')" v-show="props.activeSection === 'settings-advanced'" class="settings-section settings-section-continuation">
      <SettingsPanel name="requests" :active="props.activePanel">
<SettingsGroup :title="t('settings.requestLimits.globalTitle')" :description="t('settings.requestLimits.globalHelp')">
        <div data-testid="translation-scheduler-settings">
          <RequestLimitFields :model-value="config" @update:model-value="Object.assign(config, $event)" />
          <SettingsItem label="失败后最多重试">
            <div class="request-default-number"><el-input-number :model-value="config.translationMaxRetries" aria-label="失败后最多重试" :min="0" :max="10" :controls="false" @change="handleTranslationMaxRetriesChange" /></div>
          </SettingsItem>
          <SettingsItem
            :label="t('settings.requestLimits.apiKeyRecovery')"
            :description="t('settings.requestLimits.apiKeyRecoveryHelp')"
          >
            <div class="api-key-recovery-control" data-testid="api-key-recovery-setting">
              <el-input-number
                :model-value="apiKeyRecoveryMinutes"
                :aria-label="t('settings.requestLimits.apiKeyRecovery')"
                :min="MIN_API_KEY_RECOVERY_MINUTES"
                :max="MAX_API_KEY_RECOVERY_MINUTES"
                :step="1"
                :controls="false"
                @change="handleApiKeyRecoveryChange"
              />
              <span class="api-key-recovery-unit" aria-hidden="true">{{ t('settings.requestLimits.minutes') }}</span>
            </div>
          </SettingsItem>
          <details class="request-retry-settings" data-testid="translation-retry-settings">
            <summary>{{ t('settings.requestLimits.retryIntervals') }}</summary>
            <SettingsItem :label="t('settings.requestLimits.initialRetryWait')">
              <div class="request-default-number"><el-input-number :model-value="config.translationBackoffBaseMs" :aria-label="t('settings.requestLimits.initialRetryWait')" :min="MIN_TRANSLATION_BACKOFF_BASE_MS" :max="MAX_TRANSLATION_BACKOFF_BASE_MS" :step="100" :controls="false" @change="handleTranslationBackoffBaseChange" /><span>ms</span></div>
            </SettingsItem>
            <SettingsItem :label="t('settings.requestLimits.maximumRetryWait')">
              <div class="request-default-number"><el-input-number :model-value="config.translationBackoffMaxMs" :aria-label="t('settings.requestLimits.maximumRetryWait')" :min="Math.max(MIN_TRANSLATION_BACKOFF_MAX_MS, config.translationBackoffBaseMs)" :max="MAX_TRANSLATION_BACKOFF_MAX_MS" :step="1000" :controls="false" @change="handleTranslationBackoffMaxChange" /><span>ms</span></div>
            </SettingsItem>
          </details>
        </div>
      </SettingsGroup>
</SettingsPanel>
    </section>

    <div v-if="hasVisitedSection('settings-translation-stats')" v-show="props.activeSection === 'settings-translation-stats'">
      <SettingsPanel name="overview" :active="props.activePanel">
        <TranslationStatsDashboard :active="props.activeSection === 'settings-translation-stats' && props.activePanel !== 'usage'" />
      </SettingsPanel>
      <SettingsPanel name="usage" :active="props.activePanel">
        <ModelUsageDashboard :active="props.activeSection === 'settings-translation-stats' && props.activePanel === 'usage'" :query-root="props.queryRoot" />
      </SettingsPanel>
    </div>
    <ConfigManagement v-if="hasVisitedSection('settings-data')" v-show="props.activeSection === 'settings-data'" id="settings-data" :config="config" :active="props.activeSection === 'settings-data'" :active-panel="props.activePanel" />
  </div>

  <!-- 自定义快捷键对话框 -->
  <template v-if="hasVisitedSection('settings-translation')">
    <CustomHotkeyInput
      v-model="showCustomHotkeyDialog"
      :current-value="config.customFloatingBallHotkey"
      :validate="validateCustomFullPageHotkey"
      @confirm="handleCustomHotkeyConfirm"
      @cancel="handleCustomHotkeyCancel"
    />

    <!-- 自定义鼠标悬浮快捷键对话框 -->
    <CustomHotkeyInput
      v-model="showCustomMouseHotkeyDialog"
      :current-value="config.customHotkey"
      :validate="validateCustomMouseHotkey"
      @confirm="handleCustomMouseHotkeyConfirm"
      @cancel="handleCustomMouseHotkeyCancel"
    />
    <CustomHotkeyInput
      v-model="showCustomSelectionHotkeyDialog"
      :current-value="config.customSelectionTranslatorHotkey"
      @confirm="handleCustomSelectionHotkeyConfirm"
      @cancel="handleCustomSelectionHotkeyCancel"
    />
  </template>
  <CustomOpenAIProviderDialog v-model="customProviderDialogOpen" @submit="createCustomProvider" />
</template>

<script lang="ts" setup>
import SettingsPanel from './components/SettingsPanel.vue';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';

// Main 处理配置信息
import { computed, defineAsyncComponent, nextTick, ref, watch, onUnmounted } from 'vue'

import {isValidAzureEndpoint} from '@/src/core/config/azure';
import { cloudRegionOptions, customModelString, defaultOption, getCloudCredentialLabels, getDefaultCloudRegion, getMultilingualTargetLanguageLabel, models, options, resolveConfiguredModel, services, servicesType } from '@/src/core/config/catalog';
import GlossaryLibrarySelect from '@/src/ui/components/GlossaryLibrarySelect.vue';
import {
  createNextCustomOpenAIProviderId,
  getCustomOpenAIProvider,
  isCustomOpenAIProviderId,
  LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
  MAX_CUSTOM_OPENAI_MODEL_LENGTH,
  MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER,
  normalizeCustomOpenAIModels,
  normalizeCustomOpenAIProviders,
  removeCustomOpenAIProvider,
  withCustomOpenAIServiceOptions,
  type CustomOpenAIProvider,
} from '@/src/core/config/customOpenAI';
import {
  withModelThinkingPreference,
  withoutModelThinkingPreference,
} from '@/src/core/config/modelThinking';
import {withoutModelRequestLimit} from '@/src/core/config/requestLimits';
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {useServiceModelOptions} from './services/modelOptions';
import {
  Config,
  MOUSE_HOVER_TRANSLATION_DELAY_MAX,
  MOUSE_HOVER_TRANSLATION_DELAY_MIN,
  MOUSE_HOVER_TRANSLATION_DELAY_STEP,
  MAX_TRANSLATION_BACKOFF_BASE_MS,
  MAX_TRANSLATION_BACKOFF_MAX_MS,
  API_KEY_RECOVERY_MINUTE_MS,
  MAX_API_KEY_RECOVERY_MINUTES,
  MIN_API_KEY_RECOVERY_MINUTES,
  MIN_TRANSLATION_BACKOFF_BASE_MS,
  MIN_TRANSLATION_BACKOFF_MAX_MS,
  SELECTION_TRANSLATOR_DELAY_MAX,
  SELECTION_TRANSLATOR_DELAY_MIN,
  SELECTION_TRANSLATOR_DELAY_STEP,
  VIDEO_SOURCE_LANGUAGE_OPTIONS,
  normalizeConfig,
  normalizeMouseHoverTranslationDelay,
  normalizeSelectionTranslatorDelay,
  normalizeApiKeyRecoveryMs,
  normalizeTranslationBackoffBaseMs,
  normalizeTranslationBackoffMaxMs,
} from '@/src/core/config/model';
import {SELECTION_TTS_VOICE_OPTIONS} from '@/src/core/config/selectionTts';
import { ArrowRight, InfoFilled, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import browser from 'webextension-polyfill';
import {isBrowserTabId} from '@/src/platform/browser/ids';

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
import UiLanguageSelector from '@/src/ui/components/UiLanguageSelector.vue';
import FeatureServiceSettings from './FeatureServiceSettings.vue';
import { hasSavedServiceConfiguration } from '@/src/ui/view-model/serviceLibrary';
import {getServiceCredentialGuide, getServiceWebsite} from '@/src/ui/view-model/serviceCatalog';
const ServiceCatalog = defineAsyncComponent(() => import('./services/ServiceCatalog.vue'));
const ServiceConfiguration = defineAsyncComponent(() => import('./services/ServiceConfiguration.vue'));
const CustomOpenAIProviderDialog = defineAsyncComponent(() => import('./services/CustomOpenAIProviderDialog.vue'));
const TranslationCenter = defineAsyncComponent(() => import('@/src/features/translation-center/public').then(module => module.TranslationCenter));
const openInputServiceSettings = (service: string) => { setConfigurationService(service); openSettingsSection('settings-services', 'connections'); };
const openWritingServiceSettings = () => openInputServiceSettings(config.value.writing.service || config.value.service);
const WritingSettings = defineAsyncComponent(() => import('./WritingSettings.vue'));
const SelectionSettings = defineAsyncComponent(() => import('./SelectionSettings.vue'));
const GlossarySettings = defineAsyncComponent(() => import('@/src/features/glossary/public').then(module => module.GlossarySettings));
const FloatingBallSettings = defineAsyncComponent(() => import('./FloatingBallSettings.vue'));
const SiteAdaptationSettings = defineAsyncComponent(() => import('./SiteAdaptationSettings.vue'));
const SitePreferencesSettings = defineAsyncComponent(() => import('./SitePreferencesSettings.vue'));
const SiteRulePreview = defineAsyncComponent(() => import('./SiteRulePreview.vue'));
const siteRuleInspectId = ref('');
async function inspectSiteRule(id: string) {
  siteRuleInspectId.value = '';
  await nextTick();
  siteRuleInspectId.value = id;
  openSettingsSection('settings-sites', 'adaptation');
}
import type {SiteAdaptationSettings as SiteAdaptationConfig} from '@/src/core/site-adaptation/types';
import {
  createApiKeyRequirementKey,
  getApiKeyRequirementKey,
  getLegacyApiKeyRequirementKey,
  getMissingCredentialMessage,
  isApiKeyRequired,
} from '@/src/core/config/validation';
const ImageOcrSettings = defineAsyncComponent(() => import('@/src/features/image-translation/public').then(module => module.ImageOcrSettings));
const MangaSettings = defineAsyncComponent(() => import('@/src/features/image-translation/public').then(module => module.MangaSettings));
const VideoLocalModelSettings = defineAsyncComponent(() => import('./VideoLocalModelSettings.vue'));
const LocalTtsSettings = defineAsyncComponent(() => import('./LocalTtsSettings.vue'));
const VideoSubtitleAppearanceSettings = defineAsyncComponent(() => import('./VideoSubtitleAppearanceSettings.vue'));
const ModelUsageDashboard = defineAsyncComponent(() => import('@/src/features/model-usage/public').then(module => module.ModelUsageDashboard));
const TranslationStatsDashboard = defineAsyncComponent(() => import('@/src/features/translation-stats/public').then(module => module.TranslationStatsDashboard));
const InterfaceSettings = defineAsyncComponent(() => import('./InterfaceSettings.vue'));
const AreaTranslationSettings = defineAsyncComponent(() => import('./AreaTranslationSettings.vue'));
const InputTranslationSettings = defineAsyncComponent(() => import('./InputTranslationSettings.vue'));
import {browserCapabilities} from '@/src/platform/browser/capabilities';
const ParagraphCopySettings = defineAsyncComponent(() => import('./ParagraphCopySettings.vue'));
const SectionTranslationSettings = defineAsyncComponent(() => import('./SectionTranslationSettings.vue'));
const ParagraphHandlingSettings = defineAsyncComponent(() => import('./ParagraphHandlingSettings.vue'));
const TranslationCacheSettings = defineAsyncComponent(() => import('./TranslationCacheSettings.vue'));
import SettingsGroup from './components/SettingsGroup.vue';
import ExcludedLanguageSettings from './ExcludedLanguageSettings.vue';
import ReadingAssistanceSettings from './ReadingAssistanceSettings.vue';
import SettingsItem from './components/SettingsItem.vue';
import RequestLimitFields from './services/RequestLimitFields.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import {localizeServiceOptions, useUiI18n} from '@/src/ui/i18n';
import {applyInterfaceTheme} from '@/src/ui/interfaceAppearance';
const ConfigManagement = defineAsyncComponent(() => import('./ConfigManagement.vue'));
const QuickTranslationProfiles = defineAsyncComponent(() => import('./QuickTranslationProfiles.vue'));
const ContextMenuSettings = defineAsyncComponent(() => import('./ContextMenuSettings.vue'));
import {useTranslationShortcutSettings} from './useTranslationShortcutSettings';
import {
  config as runtimeConfig,
  configReady,
  requestConfigPatch,
  handoffPendingConfigPatches,
  subscribeConfig,
} from '@/src/services/config/store';
import {
  filterAvailableTranslationServices,
  getTranslationServiceUnavailableMessage,
  supportsTranslationGlossary,
} from '@/src/services/translation/capabilities';

const props = withDefaults(defineProps<{
  activeSection?: string
  activePanel?: string
  /** userscript 的 Options 页面把路由放在原网页 URL 的 hash 前缀后。 */
  settingsHashPrefix?: string
  /** 在 closed ShadowRoot 内定位需要滚动到的设置项。 */
  queryRoot?: ParentNode | null
  /** 主题类应写到 Shadow host，而不是宿主网页的 documentElement。 */
  appearanceRoot?: HTMLElement | null
  /** Options 根组件处理导航；页内回退时不能改写宿主网页的 hash。 */
  onNavigateSection?: (section: string, targetId?: string) => void
}>(), {
  activeSection: 'settings-general',
})
// 分区首次访问后继续保留实例，避免切换菜单时销毁未保存的编辑副本或异步组件状态。
const visitedSections = ref(new Set<string>())
const hasVisitedSection = (section: string): boolean => visitedSections.value.has(section)
watch(() => props.activeSection, (section) => {
  if (!section || visitedSections.value.has(section)) return
  visitedSections.value = new Set([...visitedSections.value, section])
}, {immediate: true})
const {language, t, translateLegacy} = useUiI18n();

function openSettingsSection(section: string, targetId?: string): void {
  if (props.onNavigateSection) props.onNavigateSection(section, targetId);
  else {
    const nextHash = props.settingsHashPrefix
      ? `${props.settingsHashPrefix}/${section}`
      : `#${section}`;
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
  }
  if (!targetId) return;
  let attempts = 0;
  const scrollWhenMounted = () => {
    const target = (props.queryRoot || document).querySelector<HTMLElement>(`#${targetId}`);
    if (target) {
      target.scrollIntoView({block: 'start'});
      return;
    }
    attempts += 1;
    if (attempts < 20) window.requestAnimationFrame(scrollWhenMounted);
  };
  window.requestAnimationFrame(scrollWhenMounted);
}

// 初始化深色模式媒体查询
const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
// 更新主题函数
function updateTheme(theme: string) {
  if (theme === 'auto') {
    // 自动模式下，直接使用系统主题
    applyInterfaceTheme(darkModeMediaQuery.matches, props.appearanceRoot);
  } else {
    // 手动模式下，使用选择的主题
    applyInterfaceTheme(theme === 'dark', props.appearanceRoot);
  }
}
// 配置信息
const config = ref(new Config());
const {
  getCustomHotkeyDisplayName,
  getCustomMouseHotkeyDisplayName,
  getCustomSelectionHotkeyDisplayName,
  handleCustomHotkeyCancel,
  handleCustomHotkeyConfirm,
  handleCustomMouseHotkeyCancel,
  handleCustomMouseHotkeyConfirm,
  handleCustomSelectionHotkeyCancel,
  handleCustomSelectionHotkeyConfirm,
  handleHotkeyChange,
  handleInputBoxTranslationTriggerChange,
  handleMouseHotkeyChange,
  handleSelectionTriggerChange,
  openCustomHotkeyDialog,
  openCustomMouseHotkeyDialog,
  openCustomSelectionHotkeyDialog,
  quickTranslationConflictMessage,
  showCustomHotkeyDialog,
  showCustomMouseHotkeyDialog,
  showCustomSelectionHotkeyDialog,
  validateCustomFullPageHotkey,
  validateCustomMouseHotkey,
} = useTranslationShortcutSettings(config);
const customProviderDialogOpen = ref(false);
const sendConfigMessage = browser.runtime.sendMessage.bind(browser.runtime);
const persistConfigPatch = (value: unknown) => requestConfigPatch(value, sendConfigMessage);
// 适配器有显式 JSON 保存动作，等待后台提交后才确认；订阅会同步权威状态，避免触发另一份全量快照保存。
const saveSiteAdaptationSettings = (value: SiteAdaptationConfig): Promise<void> =>
  persistConfigPatch({siteAdaptation: value});
let lastSerialized = '';
let hydrated = false;
let applyingExternalConfig = false;
let pageExitSaveStarted = false;
const unsubscribeConfig = subscribeConfig((nextConfig) => {
  const serialized = JSON.stringify(nextConfig);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  applyingExternalConfig = true;
  try {
    Object.assign(config.value, normalizeConfig(nextConfig));
  } finally {
    applyingExternalConfig = false;
  }
});
void configReady
  .then(() => {
    // 编辑副本不能共享嵌套对象，否则修改 Harness 等字段会先污染 patch 的比较基线。
    Object.assign(config.value, normalizeConfig(runtimeConfig));
    lastSerialized = JSON.stringify(config.value);
    hydrated = true;
    updateTheme(config.value.theme || 'auto');
  })
  .catch((error) => console.warn('[FluentRead] 无法读取本地配置', error));

watch(() => JSON.stringify(config.value), (serialized) => {
  if (!hydrated || applyingExternalConfig) return;
  if (serialized === lastSerialized) return;
  // 若关闭被外部原因取消，后续真实编辑应能再次交接；外部水合不会重置退出去重。
  pageExitSaveStarted = false;
  lastSerialized = serialized;
  const snapshot = normalizeConfig(config.value);
  void persistConfigPatch(snapshot).catch((error) => {
    // 失败时释放去重标记，下一次修改或 pagehide 仍能提交最新快照。
    if (lastSerialized === serialized) lastSerialized = '';
    console.warn('[FluentRead] 保存设置失败', error);
  });
}, { flush: 'sync' });

// 设置页关闭前同步交接尚未确认的字段补丁链，后台继续按 sequence 去重和字段 CAS 保存。
// beforeunload 在扩展消息通道仍可用时先交接，pagehide/unmounted 回退且只交接一次。
// 不阻止关闭或弹出确认；空队列不发送消息或新增历史。
// 先捕获最终草稿，再交接完整前驱链，不能把整份替换排入即将随页面销毁的本地队列。
function persistOnPageExit() {
  if (!hydrated || pageExitSaveStarted) return;
  pageExitSaveStarted = true;
  void persistConfigPatch(config.value).catch((error) => console.warn('[FluentRead] 设置页关闭前后台保存失败', error));
  void handoffPendingConfigPatches(sendConfigMessage, sendConfigMessage)
    .catch((error) => console.warn('[FluentRead] 设置页关闭前交接设置失败', error));
}

onUnmounted(() => {
  persistOnPageExit();
  window.removeEventListener('beforeunload', persistOnPageExit);
  window.removeEventListener('pagehide', saveOnPageHide);
});

function saveOnPageHide() {
  persistOnPageExit();
}
window.addEventListener('beforeunload', persistOnPageExit);
window.addEventListener('pagehide', saveOnPageHide);

// 设置页左侧列表只切换正在编辑的服务，不改变网页翻译实际使用的默认服务。
const configurationService = ref<string | null>(null);
const selectedConfigurationService = computed(
  () => configurationService.value ?? config.value.service,
);
const selectedConfigurationWebsite = computed(() => {
  const service = selectedConfigurationService.value;
  const endpoint = isCustomOpenAIProviderId(service)
    ? getCustomOpenAIProvider(config.value.customOpenAIProviders, service)?.endpoint
    : service === services.newapi ? config.value.newApiUrl : config.value.custom;
  return getServiceWebsite(service, {endpoint, minimaxRegion: config.value.minimaxRegion});
});
const selectedConfigurationCredentialGuide = computed(
  () => getServiceCredentialGuide(selectedConfigurationService.value),
);

// 导入、撤销或恢复可能在当前页面仍打开时删除正在编辑的 profile。
// 失效的 custom:* 选择应立即回退到新的默认服务，避免渲染孤儿配置字段。
watch(
  () => [configurationService.value, config.value.customOpenAIProviders.map((provider) => provider.id)] as const,
  ([service]) => {
    if (service && isCustomOpenAIProviderId(service)
      && !getCustomOpenAIProvider(config.value.customOpenAIProviders, service)) {
      configurationService.value = null;
    }
  },
  {flush: 'sync'},
);

const setConfigurationService = (value: string) => {
  configurationService.value = value;
};

type ServiceSource = { value: string };

const serviceOptionsWithCustomProviders = computed(() => localizeServiceOptions(
  withCustomOpenAIServiceOptions(options.services, config.value.customOpenAIProviders),
  config.value.customOpenAIProviders,
  translateLegacy,
));
const availableServiceOptions = computed(() => filterAvailableTranslationServices(serviceOptionsWithCustomProviders.value));
// 目录中的机器 / AI 标记只用于分组，不再作为不可选择的菜单选项。
const textServiceGroups = computed(() => {
  const groups: {value: string; label: string; options: typeof availableServiceOptions.value}[] = [];
  for (const item of availableServiceOptions.value) {
    if (item.value === 'machine' || item.value === 'ai') {
      groups.push({value: item.value, label: item.label, options: []});
    } else {
      groups.at(-1)?.options.push(item);
    }
  }
  return groups.filter(group => group.options.length > 0);
});
const defaultTextServiceLabel = computed(() => (
  serviceOptionsWithCustomProviders.value.find((item: any) => item.value === config.value.service)?.label || config.value.service
));
const configuredServiceIds = computed(() => availableServiceOptions.value
  .filter(item => !item.disabled && hasSavedServiceConfiguration(item.value, config.value))
  .map(item => item.value));
const videoServiceOptions = computed(() => availableServiceOptions.value.filter((item: any) => !item.disabled));
const videoGlossaryDescription = computed(() => {
  if (!config.value.glossaryEnabled) return t('glossary.disabledHint');
  const service = config.value.videoService || config.value.service;
  const model = resolveConfiguredModel(config.value.model[service], config.value.customModel[service]);
  return t(supportsTranslationGlossary(service, model) ? 'glossary.scopeHint' : 'glossary.unsupportedHint');
});
const selectedTextServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(config.value.service));
const selectedVideoServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(config.value.videoService || config.value.service));
const fullPageTranslationModeOptions = [
  {value: 'viewport', label: '按阅读进度'},
  {value: 'all', label: '翻译到页底'},
];
const selectionTranslatorModeOptions = [
  {value: 'disabled', label: '已关闭'},
  {value: 'bilingual', label: '双语'},
  {value: 'translation-only', label: '仅译文'},
];
const selectionTtsVoiceOptions = SELECTION_TTS_VOICE_OPTIONS;
const videoSubtitleDisplayModeOptions = [
  {value: 'bilingual', label: '双语'},
  {value: 'translation-only', label: '仅译文'},
  {value: 'original-only', label: '仅原文'},
];
const filteredServices = computed(() =>
  availableServiceOptions.value.filter((item: any) =>
    !([item.google].includes(item.value) && config.value.display !== 1),
  ),
);

interface CustomProviderDraft {
  name: string
  endpoint: string
  apiKey: string
  model: string
}

/**
 * 需要同时改变 profile 与其模型/凭据映射的操作必须只发布一个完整快照。
 * 全局配置监听使用 flush: sync；逐字段修改会让中间态先被 normalize 后回灌，
 * 既产生多条历史，也可能把刚删除的当前模型重新补回列表。
 */
function updateConfigAtomically(update: (draft: Config) => void): void {
  const draft = normalizeConfig(config.value);
  update(draft);
  config.value = normalizeConfig(draft);
}

const {
  builtInModels: builtInConfigurationModels,
  customModelCount: selectedConfigurationCustomModelCount,
  modelOptions: configurationModelOptions,
  selectedCustomProvider,
  selectedModel: selectedConfigurationModel,
  selectedModelThinking: selectedConfigurationModelThinking,
} = useServiceModelOptions(config, selectedConfigurationService);

function openCustomProviderDialog(): void {
  customProviderDialogOpen.value = true;
}

function createCustomProvider(draft: CustomProviderDraft): void {
  const id = createNextCustomOpenAIProviderId(config.value.customOpenAIProviders);
  const provider: CustomOpenAIProvider = {
    id,
    name: draft.name,
    endpoint: draft.endpoint,
    models: [draft.model],
  };
  updateConfigAtomically((next) => {
    next.customOpenAIProviders = normalizeCustomOpenAIProviders([
      ...next.customOpenAIProviders,
      provider,
    ]);
    next.model[id] = draft.model;
    next.documentModel[id] = draft.model;
    next.system_role[id] = defaultOption.system_role;
    next.user_role[id] = defaultOption.user_role;
    if (draft.apiKey) next.token[id] = draft.apiKey;
    next.modelThinking = withModelThinkingPreference(next.modelThinking, id, draft.model, false);
  });
  configurationService.value = id;
  ElMessage({message: '自定义服务已添加', type: 'success', grouping: true, duration: 1800});
}

function updateSelectedCustomProvider(patch: Partial<Pick<CustomOpenAIProvider, 'name' | 'endpoint'>>): void {
  const service = selectedConfigurationService.value;
  config.value.customOpenAIProviders = config.value.customOpenAIProviders.map((provider) => (
    provider.id === service ? {...provider, ...patch} : provider
  ));
}

function deleteSelectedCustomProvider(): void {
  const service = selectedConfigurationService.value;
  if (!getCustomOpenAIProvider(config.value.customOpenAIProviders, service)) return;
  updateConfigAtomically((next) => {
    next.customOpenAIProviders = removeCustomOpenAIProvider(next.customOpenAIProviders, service);
    for (const mapping of [
      next.token,
      next.model,
      next.documentModel,
      next.customModel,
      next.customModels,
      next.modelThinking,
      next.documentCustomModel,
      next.proxy,
      next.system_role,
      next.user_role,
      next.customBody,
      next.customHeaders,
    ]) delete mapping[service];
    // normalizeConfig 会根据删除后的 profile 列表精确保留仍可达的鉴权键。
    // 不能用 `${service}:` 做前缀删除：旧 ID `custom` 也是新 ID
    // `custom:*` 的前缀，会误删其他自定义服务的免 Key 偏好。
    if (next.service === service) next.service = defaultOption.service;
    if (next.documentService === service) next.documentService = '';
    if (next.videoService === service) next.videoService = '';
    next.translationCenterServices = next.translationCenterServices.filter((item) => item !== service);
    if (service === LEGACY_CUSTOM_OPENAI_PROVIDER_ID) next.custom = defaultOption.custom;
  });
  configurationService.value = config.value.service;
  ElMessage({message: '自定义服务已删除', type: 'success', grouping: true, duration: 1800});
}

function selectConfigurationModel(model: string): void {
  const service = selectedConfigurationService.value;
  if (selectedCustomProvider.value) {
    config.value.model[service] = model;
    return;
  }
  if (builtInConfigurationModels.value.includes(model)) {
    config.value.model[service] = model;
    return;
  }
  updateConfigAtomically((next) => {
    next.customModel[service] = model;
    next.model[service] = customModelString;
  });
}

function updateSelectedConfigurationModelThinking(enabled: boolean): void {
  const service = selectedConfigurationService.value;
  const model = selectedConfigurationModel.value;
  if (!model) return;
  config.value.modelThinking = withModelThinkingPreference(
    config.value.modelThinking,
    service,
    model,
    enabled,
  );
}

function addConfigurationModel(model: string): void {
  const service = selectedConfigurationService.value;
  const provider = selectedCustomProvider.value;
  if (provider) {
    updateConfigAtomically((next) => {
      next.customOpenAIProviders = normalizeCustomOpenAIProviders(
        next.customOpenAIProviders.map((item) => item.id === service
          ? {...item, models: [...item.models, model]}
          : item),
      );
      next.model[service] = model;
      next.modelThinking = withModelThinkingPreference(next.modelThinking, service, model, false);
    });
    return;
  }
  updateConfigAtomically((next) => {
    next.customModels[service] = normalizeCustomOpenAIModels([
      ...(next.customModels[service] || []),
      model,
    ]);
    next.customModel[service] = model;
    next.model[service] = customModelString;
    next.modelThinking = withModelThinkingPreference(next.modelThinking, service, model, false);
  });
}

function removeConfigurationModel(model: string): void {
  const service = selectedConfigurationService.value;
  const provider = selectedCustomProvider.value;
  if (provider) {
    const remainingModels = provider.models.filter((item) => item !== model);
    const fallback = remainingModels[0] || '';
    updateConfigAtomically((next) => {
      next.customOpenAIProviders = normalizeCustomOpenAIProviders(
        next.customOpenAIProviders.map((item) => item.id === service
          ? {...item, models: remainingModels}
          : item),
      );
      if (next.model[service] === model) {
        if (fallback) next.model[service] = fallback;
        else delete next.model[service];
      }
      if (next.documentModel[service] === model) {
        if (fallback) next.documentModel[service] = fallback;
        else delete next.documentModel[service];
      }
      next.modelThinking = withoutModelThinkingPreference(next.modelThinking, service, model);
      next.modelRequestLimits = withoutModelRequestLimit(next.modelRequestLimits, service, model);
    });
    return;
  }
  updateConfigAtomically((next) => {
    const remainingModels = (next.customModels[service] || []).filter((item) => item !== model);
    if (remainingModels.length > 0) next.customModels[service] = remainingModels;
    else delete next.customModels[service];
    const fallbackCustomModel = remainingModels[0];
    const fallbackBuiltInModel = builtInConfigurationModels.value[0] || '';
    const pageUsesRemovedModel = next.model[service] === customModelString
      && next.customModel[service] === model;
    if (next.customModel[service] === model) {
      if (!pageUsesRemovedModel) {
        delete next.customModel[service];
      } else if (fallbackCustomModel) {
        next.customModel[service] = fallbackCustomModel;
        next.model[service] = customModelString;
      } else {
        delete next.customModel[service];
        next.model[service] = fallbackBuiltInModel;
      }
    }
    const documentUsesRemovedModel = next.documentModel[service] === customModelString
      && next.documentCustomModel[service] === model;
    if (next.documentCustomModel[service] === model) {
      if (!documentUsesRemovedModel) {
        delete next.documentCustomModel[service];
      } else if (fallbackCustomModel) {
        next.documentCustomModel[service] = fallbackCustomModel;
        next.documentModel[service] = customModelString;
      } else {
        delete next.documentCustomModel[service];
        next.documentModel[service] = fallbackBuiltInModel;
      }
    }
    delete next.requireApiKey[createApiKeyRequirementKey(service, model)];
    delete next.requireApiKey[getLegacyApiKeyRequirementKey(service, model)];
    next.modelThinking = withoutModelThinkingPreference(next.modelThinking, service, model);
    next.modelRequestLimits = withoutModelRequestLimit(next.modelRequestLimits, service, model);
  });
}

// 两个页面都需要相同的服务能力判断，但数据源不同：实际翻译使用默认服务，
// 设置页右侧表单使用正在配置的服务。统一从这里生成，避免两套逻辑继续漂移。
const createServiceCompute = (serviceSource: ServiceSource) => ({
  showAI: computed(() => isCustomOpenAIProviderId(serviceSource.value) || servicesType.isAI(serviceSource.value)),
  showMachine: computed(() => servicesType.isMachine(serviceSource.value)),
  showProxy: computed(() => isCustomOpenAIProviderId(serviceSource.value) || servicesType.isUseProxy(serviceSource.value)),
  showModel: computed(() => isCustomOpenAIProviderId(serviceSource.value) || servicesType.isUseModel(serviceSource.value)),
  showCustomBody: computed(() => isCustomOpenAIProviderId(serviceSource.value) || servicesType.isUseCustomBody(serviceSource.value)),
  showToken: computed(() => isCustomOpenAIProviderId(serviceSource.value) || servicesType.isUseToken(serviceSource.value)),
  allowCustomModels: computed(() => serviceSource.value !== services.localTranslation),
  requireApiKey: computed({
    get: () => isApiKeyRequired(serviceSource.value, config.value),
    set: (value: boolean) => {
      config.value.requireApiKey[getApiKeyRequirementKey(serviceSource.value, config.value)] = value;
    },
  }),
  credentialWarning: computed(() => getMissingCredentialMessage(serviceSource.value, config.value)),
  showAkSk: computed(() => servicesType.isUseAkSk(serviceSource.value)),
  showYoudao: computed(() => servicesType.isYoudao(serviceSource.value)),
  showTencent: computed(() => servicesType.isTencent(serviceSource.value)),
  // 云服务厂商：主密钥沿用 token[service]，第二段密钥与地域分别来自 secret/serviceRegion。
  showCloudVendor: computed(() => servicesType.isCloudVendor(serviceSource.value)),
  showServiceSecret: computed(() => servicesType.isUseSecret(serviceSource.value)),
  showServiceRegion: computed(() => servicesType.isUseRegion(serviceSource.value)),
  cloudCredentialLabels: computed(() => getCloudCredentialLabels(serviceSource.value)),
  cloudRegionOptions: computed(() => cloudRegionOptions[serviceSource.value] || []),
  defaultCloudRegion: computed(() => getDefaultCloudRegion(serviceSource.value)),
  showOllamaEndpoint: computed(() => serviceSource.value === services.ollama),
  model: computed(() => models.get(serviceSource.value) || []),
  showCustom: computed(() => isCustomOpenAIProviderId(serviceSource.value)),
  showCustomOpenAI: computed(() => Boolean(getCustomOpenAIProvider(config.value.customOpenAIProviders, serviceSource.value))),
  showDeepLX: computed(() => serviceSource.value === 'deeplx'),
  showMiniMaxRegion: computed(() => serviceSource.value === services.minimax),
  showMiMoRegion: computed(() => serviceSource.value === services.mimo),
  showCustomModel: computed(
    () =>
      servicesType.isAI(serviceSource.value) &&
      config.value.model[serviceSource.value] === customModelString,
  ),
  filteredServices,
  showNewAPI: computed(() => servicesType.isNewApi(serviceSource.value)),
  showAzureOpenaiEndpoint: computed(() => servicesType.isAzureOpenai(serviceSource.value)),
  showDeepseekApiType: computed(() => serviceSource.value === 'deepseek'),
});

// config.service 仍表示实际默认翻译服务；这里仅用于设置页正在编辑的服务。
const configurationCompute = ref(createServiceCompute(selectedConfigurationService));

// 监听主题变化
watch(() => config.value.theme, (newTheme) => {
  updateTheme(newTheme || 'auto');
});

// 使用 onchange 监听系统主题变化
darkModeMediaQuery.onchange = () => {
  if (config.value.theme === 'auto') {
    updateTheme('auto');
  }
};

// 组件卸载时清理
onUnmounted(() => {
  darkModeMediaQuery.onchange = null;
  unsubscribeConfig();
});

// 悬浮球开关的计算属性
const floatingBallEnabled = computed({
  get: () => !config.value.disableFloatingBall,
  set: (value) => {
    config.value.disableFloatingBall = !value;
    // 向所有激活的标签页发送消息
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (isBrowserTabId(tab.id)) {
          browser.tabs.sendMessage(tab.id, {
            type: 'toggleFloatingBall',
            isEnabled: value && config.value.on,
          }).catch(() => {
            // 忽略发送失败的错误（可能是页面未加载内容脚本）
          });
        }
      });
    });
  }
});

const imageTranslationEnabled = computed({
  get: () => !config.value.disableImageTranslator,
  set: (value) => {
    config.value.disableImageTranslator = !value;
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (!isBrowserTabId(tab.id)) return;
        browser.tabs.sendMessage(tab.id, {
          type: 'toggleImageTranslator',
          isEnabled: value && config.value.on,
        }).catch(() => undefined);
      });
    }).catch(() => undefined);
  },
});

const selectionAreaTranslationEnabled = computed({
  get: () => config.value.selectionAreaEnabled,
  set: (value) => {
    const conflictMessage = value
      ? quickTranslationConflictMessage(resolveAreaTranslationHotkey(config.value.selectionAreaHotkey, config.value.customSelectionAreaHotkey))
      : '';
    if (conflictMessage) {
      ElMessage.warning(conflictMessage);
      return;
    }
    config.value.selectionAreaEnabled = value;
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (!isBrowserTabId(tab.id)) return;
        browser.tabs.sendMessage(tab.id, {
          type: 'toggleSelectionAreaTranslator',
          isEnabled: value && config.value.on,
        }).catch(() => undefined);
      });
    }).catch(() => undefined);
  },
});

const handleTranslationProgressPanelChange = (isEnabled: boolean) => {
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (!isBrowserTabId(tab.id)) return;
      browser.tabs.sendMessage(tab.id, {
        type: 'toggleTranslationProgressPanel',
        isEnabled,
      }).catch(() => {
        // 忽略发送失败的错误（可能是页面未加载内容脚本）
      });
    });
  }).catch(() => {
    // 忽略无法查询标签页的错误，配置仍会通过统一存储链路保存
  });
};

// 监听划词翻译模式变化
watch(() => config.value.selectionTranslatorMode, (newMode) => {
  config.value.disableSelectionTranslator = newMode === 'disabled';
  // 向所有激活的标签页发送消息
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (isBrowserTabId(tab.id)) {
        browser.tabs.sendMessage(tab.id, {
        type: 'updateSelectionTranslatorMode',
        mode: config.value.on ? newMode : 'disabled',
        }).catch(() => {
          // 忽略发送失败的错误（可能是页面未加载内容脚本）
        });
      }
    });
  });
});

// 处理插件状态变化
const handlePluginStateChange = (val: boolean) => {
  // 总开关只控制当前运行状态，不覆盖用户对悬浮球和划词翻译的偏好。
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (!isBrowserTabId(tab.id)) return;
      browser.tabs.sendMessage(tab.id, {
        type: 'toggleFloatingBall',
        isEnabled: val && !config.value.disableFloatingBall,
      }).catch(() => {
        // 忽略发送失败的错误（可能是页面未加载内容脚本）
      });
      browser.tabs.sendMessage(tab.id, {
        type: 'updateSelectionTranslatorMode',
        mode: val ? config.value.selectionTranslatorMode : 'disabled',
      }).catch(() => {
        // 忽略发送失败的错误（可能是页面未加载内容脚本）
      });
      browser.tabs.sendMessage(tab.id, {
        type: 'toggleSelectionAreaTranslator',
        isEnabled: val && config.value.selectionAreaEnabled,
      }).catch(() => {
        // 忽略发送失败的错误（可能是页面未加载内容脚本）
      });
    });
  });
};

const handleMouseHoverTranslationDelayChange = (value: number | undefined) => {
  config.value.mouseHoverTranslationDelay = normalizeMouseHoverTranslationDelay(value);
};

const handleSelectionTranslatorDelayChange = (value: number | undefined) => {
  config.value.selectionTranslatorDelay = normalizeSelectionTranslatorDelay(value);
};

const handleTranslationMaxRetriesChange = (currentValue: number | undefined) => {
  if (currentValue === undefined || !Number.isSafeInteger(currentValue) || currentValue < 0 || currentValue > 10) return;
  config.value.translationMaxRetries = currentValue;
};

const apiKeyRecoveryMinutes = computed(() => Math.round(
  normalizeApiKeyRecoveryMs(config.value.apiKeyRecoveryMs) / API_KEY_RECOVERY_MINUTE_MS,
));

const handleApiKeyRecoveryChange = (currentValue: number | undefined) => {
  if (currentValue === undefined || !Number.isFinite(currentValue)) return;
  config.value.apiKeyRecoveryMs = normalizeApiKeyRecoveryMs(currentValue * API_KEY_RECOVERY_MINUTE_MS);
};

const handleTranslationBackoffBaseChange = (currentValue: number | undefined) => {
  if (currentValue === undefined || !Number.isSafeInteger(currentValue)) return;
  const nextBase = normalizeTranslationBackoffBaseMs(currentValue);
  config.value.translationBackoffBaseMs = nextBase;
  if (config.value.translationBackoffMaxMs < nextBase) {
    config.value.translationBackoffMaxMs = nextBase;
  }
};

const handleTranslationBackoffMaxChange = (currentValue: number | undefined) => {
  if (currentValue === undefined || !Number.isSafeInteger(currentValue)) return;
  const normalized = normalizeTranslationBackoffMaxMs(currentValue);
  config.value.translationBackoffMaxMs = Math.max(
    config.value.translationBackoffBaseMs,
    normalized,
  );
};

</script>

<style scoped src="./settings-sections.css"></style>
