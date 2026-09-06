<!--
 * @file src/features/settings/ui/SettingsSections.vue
 * 文件职责：承载 FluentRead Options 页面各业务设置分区，连接运行时配置、服务选择、快捷键、站点规则、翻译中心、OCR、词书以及导入导出和历史恢复。
 * 主要内容：包含正文/全部节点识别范围；模板按 activeSection 展示业务分区，图片与圈选分别复用仅在当前分区挂载的 OCR 管理组件，在界面布局页组织风格与菜单栏布局，仅在高级选项激活时挂载缓存管理；脚本以独立配置副本隔离编辑与全局差分基线，协调网站入口、配置及凭据保存、历史恢复、能力过滤和离页补丁交接。
 * 模块边界：该组件负责设置 UI 编排但不实现 provider 网络、配置仓库或 feature 运行时；校验与迁移来自 core/config，持久化经 services/config，复杂子界面保持在各自 feature/组件内。
 -->
<template>
  <section v-show="props.activeSection === 'settings-general'" id="settings-general" class="settings-section">
    <SettingsGroup>
      <SettingsItem label="插件状态" :description="config.on ? '网页翻译和快捷功能正在运行。' : '当前已暂停，其他偏好仍可继续调整。'">
        <el-switch v-model="config.on" class="settings-switch" aria-label="插件状态" @change="handlePluginStateChange" />
      </SettingsItem>
      <SettingsItem :label="t('settings.general.language')" :description="t('language.settingsDescription')"><UiLanguageSelector compact /></SettingsItem>
      <SettingsItem label="界面主题" description="只影响扩展界面，不会改变网页本身的配色。">
        <SegmentedControl v-model="config.theme" :options="options.theme" label="界面主题" />
      </SettingsItem>
    </SettingsGroup>
    <SettingsGroup title="选择翻译服务" description="设置网页翻译默认使用的服务；模型和凭据仍在“翻译服务”页配置。">
      <SettingsItem label="默认网页翻译服务" :description="t('quickTranslation.defaultServiceDescription')">
        <div
          class="service-default-control"
          data-testid="default-translation-service-card"
          :data-default-service="config.service"
        >
          <ServiceIcon :service="config.service" :label="defaultTextServiceLabel" size="medium" />
          <el-select v-model="config.service" aria-label="默认网页翻译服务" placeholder="请选择翻译服务">
            <el-option v-if="selectedTextServiceUnavailableMessage" label="Chrome内置AI翻译（当前浏览器不可用）" :value="config.service" disabled />
            <el-option v-for="item in availableServiceOptions" :key="item.value" class="select-left" :label="item.label" :value="item.value" :disabled="item.disabled" />
          </el-select>
        </div>
      </SettingsItem>
    </SettingsGroup>
    <div v-if="selectedTextServiceUnavailableMessage" class="disabled-section" role="status">
      <strong>当前默认服务在此浏览器不可用</strong>
      <p>{{ selectedTextServiceUnavailableMessage }}请在上方选择可用服务。</p>
    </div>
  </section>
  <section v-show="props.activeSection === 'settings-sites'" id="settings-sites" class="settings-section site-settings-section">
    <SettingsGroup>
      <SettingsItem label="所有网站自动翻译" description="每个支持的网页加载完成后自动开始翻译；关闭后仍保留下面的名单。">
        <el-switch v-model="config.autoTranslate" class="settings-toggle" aria-label="所有网站自动翻译" />
      </SettingsItem>
    </SettingsGroup>
    <AlwaysTranslateSites v-model="config.alwaysTranslateDomains" />
    <AlwaysTranslateSites v-model="config.disabledExtensionDomains" variant="disable-extension" />
    <SiteAdaptationSettings :model-value="config.siteAdaptation" :save-settings="saveSiteAdaptationSettings" />
  </section>
  <section v-show="props.activeSection === 'settings-translation-center'" id="settings-translation-center" class="settings-section translation-center-section">
    <TranslationCenter />
  </section>
  <section v-show="props.activeSection === 'settings-harness'" id="settings-harness" class="settings-section">
    <HarnessSettings :config="config" />
  </section>
  <section v-if="props.activeSection === 'settings-glossary'" id="settings-glossary" class="settings-section">
    <GlossarySettings />
  </section>
  <div class="settings-main-sections">
    <!-- 翻译服务 -->
    <section v-show="props.activeSection === 'settings-services'" id="settings-services" class="settings-section">
      <ServiceCatalog
        :service="selectedConfigurationService"
        :default-service="config.service"
        :website="selectedConfigurationWebsite"
        :selected-model="selectedConfigurationModel"
        :services="configurationCompute.filteredServices"
        :model-options="configurationModelOptions"
        :show-model="configurationCompute.showModel"
        :maximum-custom-services="MAX_CUSTOM_OPENAI_PROVIDERS"
        :maximum-models="MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER"
        :maximum-model-length="MAX_CUSTOM_OPENAI_MODEL_LENGTH"
        :custom-model-count="selectedConfigurationCustomModelCount"
        @update:service="setConfigurationService"
        @update:model="selectConfigurationModel"
        @add:service="openCustomProviderDialog"
        @add:model="addConfigurationModel"
        @remove:model="removeConfigurationModel"
      >
        <template #configuration>
          <ServiceConfiguration
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
      <CustomOpenAIProviderDialog
        v-model="customProviderDialogOpen"
        @submit="createCustomProvider"
      />
    </section>
    <section v-show="props.activeSection === 'settings-image-translation'" id="settings-image-translation" class="settings-section image-translation-settings">
      <SettingsGroup title="功能状态">
        <SettingsItem label="网页图片翻译">
          <el-switch v-model="imageTranslationEnabled" class="settings-toggle" aria-label="网页图片翻译" :disabled="!browserCapabilities.imageTranslation" />
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup :title="t('image.entries')">
        <SettingsItem :label="t('image.hover')" :description="t('image.hoverDescription')">
          <el-switch v-model="config.imageTranslationHoverEnabled" class="settings-toggle" :aria-label="t('image.hover')" :disabled="!imageTranslationEnabled || !browserCapabilities.imageTranslation" />
        </SettingsItem>
        <SettingsItem :label="t('image.context')" :description="t('image.contextDescription')">
          <el-switch v-model="config.imageTranslationContextMenuEnabled" class="settings-toggle" :aria-label="t('image.context')" :disabled="!imageTranslationEnabled || !browserCapabilities.imageTranslation" />
        </SettingsItem>
      </SettingsGroup>
      <ImageOcrSettings v-if="props.activeSection === 'settings-image-translation'" />
    </section>
    <section v-show="props.activeSection === 'settings-area-translation'" id="settings-area-translation" class="settings-section">
      <AreaTranslationSettings
        v-if="props.activeSection === 'settings-area-translation'"
        :config="config"
        :service-options="availableServiceOptions"
        :enabled="selectionAreaTranslationEnabled"
        @update:enabled="selectionAreaTranslationEnabled = $event"
      />
    </section>
    <section v-show="props.activeSection === 'settings-video'" id="settings-video" class="settings-section">
      <SettingsGroup>
        <SettingsItem label="视频字幕翻译" description="翻译 YouTube 或 X 播放器中的字幕，不上传音频或视频内容。">
          <el-switch v-model="config.videoTranslationEnabled" class="settings-switch" aria-label="视频字幕翻译" />
        </SettingsItem>
        <SettingsItem label="视频翻译服务" description="与网页翻译服务相互独立；AI 服务会提前预取字幕。" :disabled="!config.videoTranslationEnabled">
          <el-select v-model="config.videoService" aria-label="视频字幕翻译服务" :disabled="!config.videoTranslationEnabled" placeholder="请选择服务">
            <el-option v-if="selectedVideoServiceUnavailableMessage" label="Chrome内置AI翻译（当前浏览器不可用）" :value="config.videoService" disabled />
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
        <SettingsItem label="显示 FluentRead 字幕" description="临时隐藏扩展字幕时保留当前翻译设置。" :disabled="!config.videoTranslationEnabled">
          <el-switch v-model="config.videoSubtitleVisible" class="settings-toggle" aria-label="显示 FluentRead 视频字幕" :disabled="!config.videoTranslationEnabled" />
        </SettingsItem>
        <SettingsItem label="字幕显示模式" description="选择同时显示原文和译文，或只显示其中一种。" :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible">
          <SegmentedControl
            v-model="config.videoSubtitleDisplayMode"
            :options="videoSubtitleDisplayModeOptions"
            label="视频字幕显示模式"
            :disabled="!config.videoTranslationEnabled || !config.videoSubtitleVisible"
          />
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup title="X 本地 AI 字幕" description="仅 X 无原生字幕时使用；模型和音频留在当前浏览器，下载后可离线识别。">
        <VideoLocalModelSettings :config="config" />
      </SettingsGroup>
      <VideoSubtitleAppearanceSettings :config="config" />
      <details class="feature-help">
        <summary>使用说明</summary>
        <p>打开 YouTube 原生字幕后，FluentRead 会在播放器中显示译文。机器翻译约提前 10 秒、AI 服务约提前 30 秒准备字幕；播放器菜单可分别下载原文或译文 SRT。</p>
      </details>
    </section>
    <!-- 鼠标悬浮快捷键 -->
    <section v-show="props.activeSection === 'settings-translation'" id="settings-translation" class="settings-section">
    <SettingsGroup title="鼠标悬浮翻译" description="按住快捷键并把鼠标移到文本上，等待设定时间后开始翻译。">
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
        <el-tooltip class="box-item" effect="dark" content="按住鼠标悬浮快捷键并移动鼠标后，等待指定时间再翻译；调高可以减少 Ctrl+C 等组合键带来的误触。松开快捷键触发的单次翻译不受影响。" placement="top-start" :show-after="500">
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
          controls-position="right"
          @change="handleMouseHoverTranslationDelayChange"
        />
        <span class="input-suffix">ms</span>
      </el-col>
    </el-row>
    <QuickTranslationProfiles :config="config" action="hover" :profiles="config.quickTranslationProfiles"
      @update:profiles="config.quickTranslationProfiles = $event" />
    </SettingsGroup>
    </section>

    <section v-show="props.activeSection === 'settings-translation'" class="settings-section settings-section-continuation">
    <SettingsGroup title="划词翻译" description="选中文字后的展示内容、触发方式和等待时间。">
    <!-- 划词翻译模式选择 -->
    <el-row class="settings-control-row">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="选中文本后显示翻译入口；可选择直接弹出、图标、小点、预设快捷键或自定义快捷键。" placement="top-start" :show-after="500">
      <span class="popup-text popup-vertical-left">
        划词翻译
        <el-icon class="icon-margin">
          <InfoFilled />
        </el-icon>
      </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end">
        <SegmentedControl v-model="config.selectionTranslatorMode" :options="selectionTranslatorModeOptions" label="划词翻译模式" />
      </el-col>
    </el-row>
    <el-row v-if="config.selectionTranslatorMode !== 'disabled'" class="settings-control-row" :class="{ 'custom-hotkey-row': config.selectionTranslatorTrigger === 'custom' }">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="快捷键与直接弹出、显示图标和显示小点是并列的触发方式；选择快捷键后，选中文字时不会显示图标或小点。" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            划词触发方式
            <el-icon class="icon-margin"><InfoFilled /></el-icon>
          </span>
        </el-tooltip>
      </el-col>
      <el-col :span="10" class="settings-control-field flex-end">
        <div class="hotkey-config">
          <el-select :model-value="config.selectionTranslatorTrigger" aria-label="划词翻译触发方式" placeholder="选择触发方式" size="small" style="width: 100%" @change="handleSelectionTriggerChange">
            <el-option v-for="item in options.selectionTranslatorTriggers" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
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
    <el-row v-if="config.selectionTranslatorMode !== 'disabled'" class="settings-control-row">
      <el-col :span="14" class="settings-control-label lightblue rounded-corner">
        <el-tooltip class="box-item" effect="dark" content="从选区稳定后开始计时，再显示图标、小点或翻译面板；快捷键在等待结束后按下会立即显示。" placement="top-start" :show-after="500">
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
          controls-position="right"
          @change="handleSelectionTranslatorDelayChange"
        />
        <span class="input-suffix">ms</span>
      </el-col>
    </el-row>
    </SettingsGroup>
    </section>

    <!-- 高级选项 -->
    <section v-show="props.activeSection === 'settings-advanced'" id="settings-advanced" class="settings-section">
      <SettingsGroup :title="t('settings.pageRecognition.title')">
        <SettingsItem :label="t('settings.pageRecognition.allNodes')" :description="t('settings.pageRecognition.description')">
          <el-switch v-model="config.translationScope" active-value="all" inactive-value="content" class="settings-toggle" :aria-label="t('settings.pageRecognition.allNodes')" />
        </SettingsItem>
      </SettingsGroup>
      <TranslationCacheSettings v-if="props.activeSection === 'settings-advanced'" :config="config" />
    </section>

    <section v-show="props.activeSection === 'settings-general'" class="settings-section settings-section-continuation">
      <SettingsGroup title="译文显示" description="设置网页翻译后的内容形式和双语译文样式。">
        <SettingsItem :label="t('settings.general.defaultTargetLanguage')" :description="t('settings.general.defaultTargetLanguageDescription')">
          <el-select v-model="config.to" data-config-field="to" :aria-label="t('settings.general.defaultTargetLanguage')" :placeholder="t('settings.general.targetLanguagePlaceholder')">
            <el-option v-for="item in options.to" :key="item.value" data-i18n-ignore class="select-left" :label="getMultilingualTargetLanguageLabel(item.value, item.label, language)" :value="item.value" />
          </el-select>
        </SettingsItem>
        <SettingsItem label="翻译模式" description="双语对照保留原文，仅译文模式会替换原文显示。">
          <SegmentedControl v-model="config.display" :options="options.display" label="翻译模式" />
        </SettingsItem>
        <SettingsItem v-show="config.display === 1" label="译文样式" description="选择后可在下方立即查看效果。">
          <el-select v-model="config.style" aria-label="译文样式" placeholder="请选择译文显示样式">
            <el-option-group v-for="group in styleGroups" :key="group.value" :label="group.label">
              <el-option v-for="item in group.options" :key="item.value" :label="item.label" :value="item.value" :class="item.class" />
            </el-option-group>
          </el-select>
        </SettingsItem>
        <SettingsItem v-show="config.display === 1" :label="t('settings.general.bilingualSentenceHighlight')" :description="t('settings.general.bilingualSentenceHighlightDescription')">
          <el-switch v-model="config.bilingualSentenceHighlightEnabled" class="settings-toggle" :aria-label="t('settings.general.bilingualSentenceHighlight')" />
        </SettingsItem>
        <div v-show="config.display === 1" class="style-preview-card" aria-live="polite">
          <div
            class="style-preview-example bilingual-highlight-preview"
            :class="{ 'is-bilingual-highlight-enabled': config.bilingualSentenceHighlightEnabled }"
            :data-bilingual-highlight-enabled="String(config.bilingualSentenceHighlightEnabled)"
            data-testid="bilingual-highlight-preview"
            :tabindex="config.bilingualSentenceHighlightEnabled ? 0 : -1"
            :aria-label="t('settings.general.bilingualSentenceHighlightDescription')"
          >
            <p class="style-preview-source" data-testid="bilingual-highlight-preview-source">Reading should feel calm and effortless.</p>
            <p :key="config.style" class="style-preview-text" :class="currentStyleClass" data-testid="bilingual-highlight-preview-translation">阅读应该轻松、自然，不打断你的节奏。</p>
          </div>
        </div>
      </SettingsGroup>
    </section>

    <section v-show="props.activeSection === 'settings-general'" class="settings-section settings-section-continuation">
      <SettingsGroup title="网页辅助" description="控制全文翻译时显示的工具和 AI 语境增强。">
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
            <small class="settings-control-hint">可提前开启；仅在支持的 AI 服务下采集网页语境并生效，其他服务会保留此偏好但不会发送上下文。</small>
          </el-col>

          <el-col :span="4" class="settings-control-field flex-end">
            <el-switch v-model="config.enableAIContext" class="settings-toggle" :aria-label="t('popup.aiContext.settingsTitle')" />
          </el-col>
        </el-row>

        <!-- 悬浮球开关 -->
      <el-row class="settings-control-row">
        <el-col :span="20" class="settings-control-label lightblue rounded-corner">
          <el-tooltip class="box-item" effect="dark" content="控制是否显示屏幕边缘的即时翻译悬浮球，用于对整个网页进行翻译" placement="top-start" :show-after="500">
          <span class="popup-text popup-vertical-left">
            全文翻译悬浮球
            <el-icon class="icon-margin">
              <InfoFilled />
            </el-icon>
          </span>
          </el-tooltip>
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
              content="全文翻译时，在网页右下角显示正在翻译和等待中的任务数量；任务结束后自动隐藏。"
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
    </section>

    <section v-show="props.activeSection === 'settings-interface'" id="settings-interface" class="settings-section">
      <InterfaceSettings :config="config" />
    </section>

    <section v-show="props.activeSection === 'settings-translation'" class="settings-section settings-section-continuation">
      <SettingsGroup title="输入框翻译" description="仅支持普通文本 input、textarea 与 plaintext-only 编辑区；密码框和富文本编辑器不参与。">
        <!-- 输入框翻译功能 -->
        <el-row class="settings-control-row">
          <el-col :span="12" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark"
                        content="输入框翻译仅作用于普通文本 input、textarea 与 plaintext-only 编辑区；密码框和富文本编辑器不参与。"
                        placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">输入框翻译<el-icon class="icon-margin">
                  <InfoFilled />
                </el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="12" class="settings-control-field">
            <el-select :model-value="config.inputBoxTranslationTrigger" aria-label="输入框翻译触发方式" placeholder="请选择触发方式" @change="handleInputBoxTranslationTriggerChange">
              <el-option class="select-left" v-for="item in options.inputBoxTranslationTrigger" :key="item.value" 
                         :label="item.label" :value="item.value" />
            </el-select>
          </el-col>
        </el-row>

        <!-- 输入框翻译目标语言 -->
        <el-row v-if="config.inputBoxTranslationTrigger !== 'disabled'" class="settings-control-row">
          <el-col :span="12" class="settings-control-label lightblue rounded-corner">
            <span class="popup-text popup-vertical-left">翻译目标语言</span>
          </el-col>
          <el-col :span="12" class="settings-control-field">
            <el-select v-model="config.inputBoxTranslationTarget" aria-label="输入框翻译目标语言" placeholder="请选择目标语言">
              <el-option class="select-left" data-i18n-ignore v-for="item in options.inputBoxTranslationTarget" :key="item.value"
                         :label="getMultilingualTargetLanguageLabel(item.value, item.label, language)" :value="item.value" />
            </el-select>
          </el-col>
        </el-row>

      </SettingsGroup>
    </section>

    <section v-show="props.activeSection === 'settings-translation'" class="settings-section settings-section-continuation">
      <SettingsGroup title="全文翻译" description="设置启动全文翻译的方式、处理范围和网页内入口。">
        <el-row class="settings-control-row" :class="{ 'custom-hotkey-row': config.floatingBallHotkey === 'custom' }">
          <el-col :span="14" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark" content="设置快捷键以便快速切换全文翻译状态，无需鼠标点击悬浮球" placement="top-start" :show-after="500">
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
            <el-tooltip class="box-item" effect="dark" content="开启后，使用支持通用提示词的 AI 服务进行全文翻译时，会把相邻短段合并为一次请求；机器翻译、悬浮、划词和输入框翻译不受影响。" placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">AI 多段翻译<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="4" class="settings-control-field flex-end">
            <el-switch v-model="config.enableAIMultiSegment" class="settings-toggle" aria-label="AI 多段翻译" />
          </el-col>
        </el-row>

        <el-row class="settings-control-row">
          <el-col :span="14" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark" content="按阅读进度会预翻译视口附近内容；立即翻译到网页底部会处理当前已加载的整页内容，并持续翻译之后新增的内容。它不会自动滚动页面，但在无限滚动页面可能产生较多翻译请求和服务费用。设置会在下次启动全文翻译时生效。" placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">全文翻译范围<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="10" class="settings-control-field flex-end">
            <SegmentedControl v-model="config.fullPageTranslationMode" :options="fullPageTranslationModeOptions" label="全文翻译范围" />
          </el-col>
        </el-row>

        <el-row class="settings-control-row">
          <el-col :span="20" class="settings-control-label lightblue rounded-corner">
            <el-tooltip class="box-item" effect="dark" content="在网页右键菜单中显示“流畅阅读翻译”或“流畅阅读取消翻译”入口；关闭后不会影响全文翻译快捷键和悬浮球" placement="top-start" :show-after="500">
              <span class="popup-text popup-vertical-left">右键全文翻译<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
            </el-tooltip>
          </el-col>
          <el-col :span="4" class="settings-control-field flex-end">
            <el-switch v-model="config.contextMenuEnabled" class="settings-toggle" aria-label="右键全文翻译" />
          </el-col>
        </el-row>
        <QuickTranslationProfiles :config="config" action="full-page" :profiles="config.quickTranslationProfiles"
          @update:profiles="config.quickTranslationProfiles = $event" />
      </SettingsGroup>
    </section>

    <section v-show="props.activeSection === 'settings-advanced'" class="settings-section settings-section-continuation">
      <SettingsGroup title="任务调度" description="控制并发数量、请求速率和失败重试的退避范围。" class="task-scheduler-group">
        <div class="task-scheduler-grid" data-testid="translation-scheduler-settings">
          <div class="scheduler-setting-row">
            <div class="settings-control-label">
              <el-tooltip class="box-item" effect="dark" content="控制同时进行的最大翻译任务数，数值越高翻译速度越快，但可能占用更多系统资源" placement="top-start" :show-after="500">
                <span class="popup-text popup-vertical-left">翻译并发数<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
              </el-tooltip>
            </div>
            <div class="settings-control-field">
              <div class="scheduler-number-field">
                <el-input-number
                  v-model="config.maxConcurrentTranslations"
                  aria-label="翻译并发数"
                  :min="1"
                  :max="100"
                  :step="1"
                  :controls="false"
                  @change="handleConcurrentChange"
                />
              </div>
            </div>
          </div>
          <div class="scheduler-setting-row">
            <div class="settings-control-label">
              <el-tooltip class="box-item" effect="dark" content="限制所有翻译服务每秒启动的真实请求数；设为 0 表示不限速。设置会在下一次请求调度时生效。" placement="top-start" :show-after="500">
                <span class="popup-text popup-vertical-left">每秒最多请求数<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
              </el-tooltip>
            </div>
            <div class="settings-control-field">
              <div class="scheduler-number-field">
                <el-input-number
                  v-model="config.translationRequestsPerSecond"
                  aria-label="每秒最多请求数"
                  :min="MIN_TRANSLATION_REQUESTS_PER_SECOND"
                  :max="MAX_TRANSLATION_REQUESTS_PER_SECOND"
                  :step="1"
                  :controls="false"
                  @change="handleTranslationRequestsPerSecondChange"
                />
              </div>
            </div>
          </div>
          <div class="scheduler-setting-row">
            <div class="settings-control-label">
              <el-tooltip class="box-item" effect="dark" content="限制所有翻译服务每分钟启动的真实请求数；设为 0 表示不限速。与每秒限制同时满足。" placement="top-start" :show-after="500">
                <span class="popup-text popup-vertical-left">每分钟最多请求数<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
              </el-tooltip>
            </div>
            <div class="settings-control-field">
              <div class="scheduler-number-field">
                <el-input-number
                  v-model="config.translationRequestsPerMinute"
                  aria-label="每分钟最多请求数"
                  :min="MIN_TRANSLATION_REQUESTS_PER_MINUTE"
                  :max="MAX_TRANSLATION_REQUESTS_PER_MINUTE"
                  :step="1"
                  :controls="false"
                  @change="handleTranslationRequestsPerMinuteChange"
                />
              </div>
            </div>
          </div>
          <div class="scheduler-setting-row">
            <div class="settings-control-label">
              <el-tooltip class="box-item" effect="dark" content="请求失败且错误可重试时，最多额外发送多少次；设为 0 表示不自动重试。" placement="top-start" :show-after="500">
                <span class="popup-text popup-vertical-left">失败后最多重试<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
              </el-tooltip>
            </div>
            <div class="settings-control-field">
              <div class="scheduler-number-field">
                <el-input-number
                  v-model="config.translationMaxRetries"
                  aria-label="失败后最多重试"
                  :min="MIN_TRANSLATION_MAX_RETRIES"
                  :max="MAX_TRANSLATION_MAX_RETRIES"
                  :step="1"
                  :controls="false"
                  @change="handleTranslationMaxRetriesChange"
                />
              </div>
            </div>
          </div>
          <div class="scheduler-setting-row">
            <div class="settings-control-label">
              <el-tooltip class="box-item" effect="dark" content="第一次自动重试前等待的时间；之后按指数退避逐步增加，受最大退避间隔限制。" placement="top-start" :show-after="500">
                <span class="popup-text popup-vertical-left">退避初始间隔<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
              </el-tooltip>
            </div>
            <div class="settings-control-field">
              <div class="scheduler-number-field" data-unit="ms">
                <el-input-number
                  v-model="config.translationBackoffBaseMs"
                  aria-label="退避初始间隔"
                  :min="MIN_TRANSLATION_BACKOFF_BASE_MS"
                  :max="MAX_TRANSLATION_BACKOFF_BASE_MS"
                  :step="100"
                  :controls="false"
                  @change="handleTranslationBackoffBaseChange"
                />
              </div>
            </div>
          </div>
          <div class="scheduler-setting-row">
            <div class="settings-control-label">
              <el-tooltip class="box-item" effect="dark" content="指数退避的本地最大等待时间；服务端返回 Retry-After 时会优先遵守服务端要求。" placement="top-start" :show-after="500">
                <span class="popup-text popup-vertical-left">退避最大间隔<el-icon class="icon-margin"><InfoFilled /></el-icon></span>
              </el-tooltip>
            </div>
            <div class="settings-control-field">
              <div class="scheduler-number-field" data-unit="ms">
                <el-input-number
                  v-model="config.translationBackoffMaxMs"
                  aria-label="退避最大间隔"
                  :min="Math.max(MIN_TRANSLATION_BACKOFF_MAX_MS, config.translationBackoffBaseMs)"
                  :max="MAX_TRANSLATION_BACKOFF_MAX_MS"
                  :step="1000"
                  :controls="false"
                  @change="handleTranslationBackoffMaxChange"
                />
              </div>
            </div>
          </div>
          <div class="scheduler-effect-row" role="status" aria-live="polite">
            <span class="scheduler-effect-label">当前效果</span>
            <p>{{ translationSchedulerEffect }}</p>
          </div>
        </div>
      </SettingsGroup>
    </section>

    <ModelUsageDashboard
      v-show="props.activeSection === 'settings-model-usage'"
      :active="props.activeSection === 'settings-model-usage'"
    />
    <ConfigManagement v-show="props.activeSection === 'settings-data'" id="settings-data" :config="config" />
  </div>

  <!-- 自定义快捷键对话框 -->
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

<script lang="ts" setup>

// Main 处理配置信息
import { computed, ref, watch, onUnmounted } from 'vue'
import {isValidAzureEndpoint} from '@/src/core/config/azure';
import { customModelString, defaultOption, getMultilingualTargetLanguageLabel, models, options, resolveConfiguredModel, services, servicesType } from '@/src/core/config/catalog';
import GlossaryLibrarySelect from '@/src/ui/components/GlossaryLibrarySelect.vue';
import {
  createNextCustomOpenAIProviderId,
  getCustomOpenAIProvider,
  isCustomOpenAIProviderId,
  LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
  MAX_CUSTOM_OPENAI_MODEL_LENGTH,
  MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER,
  MAX_CUSTOM_OPENAI_PROVIDERS,
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
import {useServiceModelOptions} from './services/modelOptions';
import {
  Config,
  DEFAULT_MAX_CONCURRENT_TRANSLATIONS,
  MOUSE_HOVER_TRANSLATION_DELAY_MAX,
  MOUSE_HOVER_TRANSLATION_DELAY_MIN,
  MOUSE_HOVER_TRANSLATION_DELAY_STEP,
  MAX_TRANSLATION_BACKOFF_BASE_MS,
  MAX_TRANSLATION_BACKOFF_MAX_MS,
  MAX_TRANSLATION_MAX_RETRIES,
  MAX_TRANSLATION_REQUESTS_PER_MINUTE,
  MAX_TRANSLATION_REQUESTS_PER_SECOND,
  MIN_TRANSLATION_BACKOFF_BASE_MS,
  MIN_TRANSLATION_BACKOFF_MAX_MS,
  MIN_TRANSLATION_MAX_RETRIES,
  MIN_TRANSLATION_REQUESTS_PER_MINUTE,
  MIN_TRANSLATION_REQUESTS_PER_SECOND,
  SELECTION_TRANSLATOR_DELAY_MAX,
  SELECTION_TRANSLATOR_DELAY_MIN,
  SELECTION_TRANSLATOR_DELAY_STEP,
  normalizeConfig,
  normalizeMouseHoverTranslationDelay,
  normalizeSelectionTranslatorDelay,
  normalizeTranslationBackoffBaseMs,
  normalizeTranslationBackoffMaxMs,
  normalizeTranslationMaxRetries,
  normalizeTranslationRequestsPerMinute,
  normalizeTranslationRequestsPerSecond,
} from '@/src/core/config/model';
import { InfoFilled, Edit } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import browser from 'webextension-polyfill';
import {isBrowserTabId} from '@/src/platform/browser/ids';
import { defineAsyncComponent } from 'vue';
const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
import UiLanguageSelector from '@/src/ui/components/UiLanguageSelector.vue';
import ServiceCatalog from './services/ServiceCatalog.vue';
import {getServiceWebsite} from '@/src/ui/view-model/serviceCatalog';
import ServiceConfiguration from './services/ServiceConfiguration.vue';
import CustomOpenAIProviderDialog from './services/CustomOpenAIProviderDialog.vue';
import {TranslationCenter} from '@/src/features/translation-center/public';
import HarnessSettings from './HarnessSettings.vue';
import {GlossarySettings} from '@/src/features/glossary/public';
import AlwaysTranslateSites from './AlwaysTranslateSites.vue';
import SiteAdaptationSettings from './SiteAdaptationSettings.vue';
import type {SiteAdaptationSettings as SiteAdaptationConfig} from '@/src/core/site-adaptation/types';
import {
  createApiKeyRequirementKey,
  getApiKeyRequirementKey,
  getLegacyApiKeyRequirementKey,
  getMissingCredentialMessage,
  isApiKeyRequired,
} from '@/src/core/config/validation';
import {ImageOcrSettings} from '@/src/features/image-translation/public';
import VideoLocalModelSettings from './VideoLocalModelSettings.vue';
import VideoSubtitleAppearanceSettings from './VideoSubtitleAppearanceSettings.vue';
import {ModelUsageDashboard} from '@/src/features/model-usage/public';
import InterfaceSettings from './InterfaceSettings.vue';
import AreaTranslationSettings from './AreaTranslationSettings.vue';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import TranslationCacheSettings from './TranslationCacheSettings.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import {localizeServiceOptions, useUiI18n} from '@/src/ui/i18n';
import ConfigManagement from './ConfigManagement.vue';
import QuickTranslationProfiles from './QuickTranslationProfiles.vue';
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
}>(), {
  activeSection: 'settings-general',
})
const {language, t, translateLegacy} = useUiI18n();

// 初始化深色模式媒体查询
const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
// 更新主题函数
function updateTheme(theme: string) {
  if (theme === 'auto') {
    // 自动模式下，直接使用系统主题
    document.documentElement.classList.toggle('dark', darkModeMediaQuery.matches);
  } else {
    // 手动模式下，使用选择的主题
    document.documentElement.classList.toggle('dark', theme === 'dark');
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
const translationLimit = (value: number) => value === 0 ? '∞' : value;
const translationDuration = (value: number) => value >= 1000 && value % 1000 === 0 ? `${value / 1000} s` : `${value} ms`;
const translationSchedulerEffect = computed(() => t('settings.advanced.schedulerSummary', {
  concurrency: config.value.maxConcurrentTranslations, perSecond: translationLimit(config.value.translationRequestsPerSecond),
  perMinute: translationLimit(config.value.translationRequestsPerMinute), retries: config.value.translationMaxRetries,
  baseDelay: translationDuration(config.value.translationBackoffBaseMs), maxDelay: translationDuration(config.value.translationBackoffMaxMs), }));

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
const defaultTextServiceLabel = computed(() => (
  serviceOptionsWithCustomProviders.value.find((item: any) => item.value === config.value.service)?.label || config.value.service
));
const videoServiceOptions = computed(() => availableServiceOptions.value.filter((item: any) => !item.disabled));
const videoGlossaryDescription = computed(() => {
  if (!config.value.glossaryEnabled) return t('glossary.disabledHint');
  const service = config.value.videoService;
  const model = resolveConfiguredModel(config.value.model[service], config.value.customModel[service]);
  return t(supportsTranslationGlossary(service, model) ? 'glossary.scopeHint' : 'glossary.unsupportedHint');
});
const selectedTextServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(config.value.service));
const selectedVideoServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(config.value.videoService));
const fullPageTranslationModeOptions = [
  {value: 'viewport', label: '按阅读进度'},
  {value: 'all', label: '翻译到页底'},
];
const selectionTranslatorModeOptions = [
  {value: 'disabled', label: '已关闭'},
  {value: 'bilingual', label: '双语'},
  {value: 'translation-only', label: '仅译文'},
];
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
  if (config.value.customOpenAIProviders.length >= MAX_CUSTOM_OPENAI_PROVIDERS) {
    ElMessage.warning(`最多只能保存 ${MAX_CUSTOM_OPENAI_PROVIDERS} 个自定义服务`);
    return;
  }
  customProviderDialogOpen.value = true;
}

function createCustomProvider(draft: CustomProviderDraft): void {
  if (config.value.customOpenAIProviders.length >= MAX_CUSTOM_OPENAI_PROVIDERS) return;
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
    ]) delete mapping[service];
    // normalizeConfig 会根据删除后的 profile 列表精确保留仍可达的鉴权键。
    // 不能用 `${service}:` 做前缀删除：旧 ID `custom` 也是新 ID
    // `custom:*` 的前缀，会误删其他自定义服务的免 Key 偏好。
    if (next.service === service) next.service = defaultOption.service;
    if (next.documentService === service) next.documentService = defaultOption.service;
    if (next.videoService === service) next.videoService = services.microsoft;
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

// 计算样式分组
const styleGroups = computed(() => {
  const groups = options.styles.filter(item => item.disabled);
  return groups.map(group => ({
    ...group,
    options: options.styles.filter(item => !item.disabled && item.group === group.value)
  }));
});

const currentStyleClass = computed(() =>
  options.styles.find(item => item.value === config.value.style && !item.disabled)?.class || 'fluent-display-default'
);

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
    const conflictMessage = value ? quickTranslationConflictMessage('Shift+Z') : '';
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

// 处理并发数量变化
const handleConcurrentChange = (currentValue: number | undefined) => {
  // 验证并发数量的有效性
  if (currentValue === undefined || currentValue < 1 || currentValue > 100) {
    ElMessage({
      message: '并发数量必须在 1-100 之间',
      type: 'warning',
      duration: 2000
    });
    // 恢复默认值
    config.value.maxConcurrentTranslations = DEFAULT_MAX_CONCURRENT_TRANSLATIONS;
    return;
  }
  
  ElMessage({
    message: `并发数量已更新为 ${currentValue}`,
    type: 'success',
    duration: 2000
  });
};

const handleTranslationRequestsPerSecondChange = (currentValue: number | undefined) => {
  config.value.translationRequestsPerSecond = normalizeTranslationRequestsPerSecond(currentValue);
};

const handleTranslationRequestsPerMinuteChange = (currentValue: number | undefined) => {
  config.value.translationRequestsPerMinute = normalizeTranslationRequestsPerMinute(currentValue);
};

const handleTranslationMaxRetriesChange = (currentValue: number | undefined) => {
  config.value.translationMaxRetries = normalizeTranslationMaxRetries(currentValue);
};

const handleTranslationBackoffBaseChange = (currentValue: number | undefined) => {
  const nextBase = normalizeTranslationBackoffBaseMs(currentValue);
  config.value.translationBackoffBaseMs = nextBase;
  if (config.value.translationBackoffMaxMs < nextBase) {
    config.value.translationBackoffMaxMs = nextBase;
  }
};

const handleTranslationBackoffMaxChange = (currentValue: number | undefined) => {
  const normalized = normalizeTranslationBackoffMaxMs(currentValue);
  config.value.translationBackoffMaxMs = Math.max(
    config.value.translationBackoffBaseMs,
    normalized,
  );
};

</script>

<style scoped src="./settings-sections.css"></style>
