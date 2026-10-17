<!--
 @file src/app/popup/PopupApp.vue
 文件职责：实现浏览器 Popup 的主交互界面，连接当前标签页状态、翻译配置、可插拔皮肤、功能抽屉和高频操作，让现场开关与显示操作保持简短，将长期偏好引导到对应设置页。
 主要内容：复用真实全文完成状态呈现首次翻译指引和就地自助诊断，配置修复定位当前服务，本地报告由用户预览并手动导出；在配置 hydration 后汇总翻译服务，直接展示网页默认服务与适用的配置模型；翻译与局部同排，主操作用短标题合并平台快捷键并保留加载状态，长组合在悬停提示中完整显示，站点开关保留独立按钮；赞赏码在当前弹窗内切换放大与还原，关闭后重置；悬停、划词与图片抽屉优先展示开关和操作示意，首次单屏语言选择独占内容，保存后立即显示主菜单；页面操作、抽屉和导航绑定活跃会话，等待期间独占请求，关闭和配置切换使旧回复失效；网站规则写前复验标签页，等待后台确认并呈现保存忙碌、暂停与失败反馈；Safari 免费池精确授权，撤权取消待发操作，授权事件合并刷新，错误随语言资源更新；打开的实际 teleport 抽屉复用平台可见视口订阅跟随键盘与缩放，极矮区域由同一订阅派生紧凑布局，整页遮罩保持背景拦截，可见高度扩大时仅修正当前聚焦服务搜索被吸顶标题遮住的外框，关闭、缓存失活和卸载立即释放，根画布保持固有尺寸。
 模块边界：组件编排 UI、浏览器导航事件与生命周期；页内面板通过授权来源固定发起网页，页面消息归属由 pageActions 管理，不实现翻译 provider、缓存存储或 content 挂载；公共配置由 services/config 管理；配置草稿复用共享编辑会话，保留 post 合并和关闭补丁交接。
-->
<!-- Popup 页面归 app 层所有；WXT 入口只负责调用挂载函数。 -->
<template>
  <main
    class="popup-shell"
    :class="{ 'config-loading': !hydrated, 'language-onboarding-shell': showLanguageOnboarding }"
    :aria-busy="!hydrated"
    :data-config-ready="hydrated ? 'true' : 'false'"
    :data-interface-skin="config.interfaceSkin"
    :data-popup-module-order="config.popupModuleOrder.join(',')"
    :data-popup-quick-feature-order="config.popupQuickFeatureOrder.join(',')"
    :data-popup-quick-features="visiblePopupQuickFeatureIds.join(',')"
    :data-popup-quick-features-visible="String(config.interfaceVisibility.popupQuickFeatures)"
    :data-popup-site-rule-visible="String(config.interfaceVisibility.popupSiteRule)"
    :data-popup-footer-visible="String(config.interfaceVisibility.popupFooter)"
    :inert="!hydrated"
  >
    <UiLanguageOnboarding
      v-if="showLanguageOnboarding"
      :initial-language="onboardingLanguage"
      @confirmed="handleLanguageOnboardingConfirmed"
    />

    <div v-show="!showLanguageOnboarding" class="popup-content" :inert="showLanguageOnboarding">
    <header class="popup-header">
      <div class="brand">
        <img src="/icon/128.png" alt="" />
        <div>
          <strong>流畅阅读</strong>
          <small class="brand-version" data-testid="popup-version">v{{ version }}</small>
          <small v-if="!config.on">{{ t('popup.heroDisabled') }}</small>
        </div>
      </div>
      <div class="header-actions">
        <button ref="donationTrigger" class="donation-button" type="button" :title="t('popup.donationTitle')" :aria-label="t('popup.donationTitle')" :onClick="donationActions.open">
          <Coffee />
          <span>{{ t('popup.donationButton') }}</span>
        </button>
        <button class="settings-button" type="button" title="完整设置" aria-label="打开完整设置" :onClick="popupActions.settings">
          <Setting />
          <span>设置</span>
        </button>
      </div>
    </header>

    <Transition name="donation-fade">
      <div
        v-if="donationVisible"
        class="donation-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="donation-title"
        :onClick="donationActions.overlay"
      >
        <section ref="donationCard" class="donation-card" tabindex="-1">
          <button class="donation-close" type="button" :aria-label="t('popup.donationClose')" :onClick="donationActions.close">×</button>
          <h2 id="donation-title">{{ t('popup.donationTitle') }}</h2>
          <p class="donation-description">{{ t('popup.donationDescription') }}</p>
          <section class="donation-method donation-wechat">
            <div class="donation-method-heading"><h3>{{ t('popup.donationWechat') }}</h3><span>WeChat Support</span></div>
            <button
              class="donation-qr-frame"
              :class="{ 'is-enlarged': donationQrEnlarged }"
              type="button"
              :aria-pressed="donationQrEnlarged"
              :aria-label="t(donationQrEnlarged ? 'popup.donationRestoreCode' : 'popup.donationEnlargeCode')"
              @click="donationQrEnlarged = !donationQrEnlarged"
            >
              <!-- 绑定表达式让模板编译器保留 public 路径，避免再打包一份带 hash 的同图。 -->
              <img :src="'/misc/approve.jpg'" :alt="t('popup.donationCodeAlt')" width="1152" height="1152" />
            </button>
            <p class="donation-method-note">{{ t(donationQrEnlarged ? 'popup.donationScanEnlarged' : 'popup.donationScan') }}</p>
          </section>
          <a class="donation-method donation-kofi" href="https://ko-fi.com/thinkstu" target="_blank" rel="noopener noreferrer">
            <span class="donation-kofi-mark" aria-hidden="true"><Coffee /></span>
            <span class="donation-kofi-copy"><strong>Ko-fi <span aria-hidden="true">↗</span></strong><span>{{ t('popup.donationKofi') }}</span><small>ko-fi.com/thinkstu</small></span>
          </a>
        </section>
      </div>
    </Transition>

    <template v-for="moduleId in visiblePopupModuleOrder" :key="moduleId">
    <section v-if="moduleId === 'translation'" class="hero-card" data-popup-module="translation">
      <div class="language-pair">
        <label>
          <span>源语言</span>
          <PopupLanguageSelect aria-label="源语言" source v-model="config.from" :disabled="!config.on" />
        </label>
        <span class="arrow">→</span>
        <label>
          <span>目标语言</span>
          <PopupLanguageSelect aria-label="目标语言" v-model="config.to" :disabled="!config.on" />
        </label>
      </div>

      <button class="provider-summary" type="button" data-testid="popup-feature-services" data-i18n-ignore
        :aria-label="providerSummaryLabel" :title="providerSummaryTitle" aria-haspopup="dialog"
        :aria-expanded="drawerVisible && activeDrawer === 'services'" :onClick="popupActions.services">
        <span class="provider-summary-copy">
          <span class="provider-summary-heading"><small>{{ t('popup.providers.title') }}</small><strong>{{ providerLabel(config.service) }}</strong></span>
          <small v-if="providerSummaryModel" class="provider-summary-model" :title="providerSummaryModelLabel">{{ providerSummaryModel }}</small>
        </span>
        <span class="provider-summary-icons" aria-hidden="true">
          <span class="provider-avatar">
            <ServiceIcon :service="config.service" :label="providerLabel(config.service)" size="small" />
          </span>
          <span v-if="assignedProviders.length > 1" class="provider-avatar provider-overflow">+{{ assignedProviders.length - 1 }}</span>
          <span class="provider-summary-chevron">›</span>
        </span>
      </button>
      <div v-if="credentialWarning" class="credential-warning" role="alert">
        <span><strong>配置提醒</strong>{{ credentialWarning }}</span>
        <button type="button" :onClick="popupActions.serviceSettings">去设置</button>
      </div>
      <p v-if="safariFreePool" class="safari-free-pool-note" data-testid="safari-free-pool" role="status">
        {{ t('safari.freePool.policy') }} · {{ freePoolStatus }}
      </p>

      <div class="translate-action">
        <button class="translate-button" :class="{ translated: pageTranslated }" type="button"
          data-testid="page-translation" :aria-pressed="pageTranslated" :aria-busy="translating"
          :aria-label="pageTranslationLabel" :title="pageTranslationTitle"
          :disabled="!config.on || currentSiteExtensionDisabled || translating || pageState.savingRule || (!pageTranslated && !currentPdfSource && safariFreePool && (freePoolLoading || freePoolBusy))" :onClick="pageButtons.toggle">
          <span v-if="translating" class="spinner" aria-hidden="true" />
          <span class="translate-label">{{ pageTranslationButtonLabel }}</span>
        </button>
        <button v-if="!isThunderbird && !currentPdfSource" class="section-translate-button" type="button" data-testid="section-translation"
          :disabled="!config.on || currentSiteExtensionDisabled || translating || pageState.savingRule || (safariFreePool && (freePoolLoading || freePoolBusy))" :aria-label="sectionTranslationLabel" :title="sectionTranslationLabel"
          :onClick="pageButtons.section">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M10 10l7 2.6-3 1.1-1.1 3z" /></svg>
          <span>{{ t('popup.sectionTranslation') }}</span>
        </button>
      </div>

      <template v-if="!pageDiagnostic">
        <p v-if="pageResultStatus === 'translating'" class="first-use-hint" role="status" data-i18n-ignore>{{ diagnosticUi('first-use-translating') }}</p>
        <p v-else-if="pageResultStatus === 'translated'" class="first-use-hint" role="status" data-i18n-ignore>{{ diagnosticUi('first-use-ready') }}</p>
        <p v-else-if="config.count === 0 && config.on && !currentSiteExtensionDisabled && !credentialWarning" class="first-use-hint" data-testid="first-translation-hint" data-i18n-ignore>{{ diagnosticUi('first-use-start') }}</p>
      </template>

      <div v-if="(siteModuleNestedInTranslation && isSiteModuleVisible) || pageDiagnostic" class="translation-meta">
        <PopupSiteRule
        v-if="siteModuleNestedInTranslation && isSiteModuleVisible"
        v-bind="siteRuleModuleProps"
        :onSetAlwaysTranslated="pageButtons.always"
        :onSetExtensionDisabled="pageButtons.disabled"
        />
        <DiagnosticNotice v-if="pageDiagnostic" :diagnostic="pageDiagnostic" :language="config.uiLanguage" :busy="translating" :version="version" @action="diagnosticAction" />
      </div>

      <p v-if="notice" class="notice" :class="noticeType" :role="noticeType === 'error' ? 'alert' : 'status'" :aria-live="noticeType === 'error' ? 'assertive' : 'polite'">{{ notice }}</p>
    </section>

    <PopupSiteRule
      v-else-if="moduleId === 'siteRule' && !siteModuleNestedInTranslation"
      v-bind="siteRuleModuleProps"
      :onSetAlwaysTranslated="pageButtons.always"
      :onSetExtensionDisabled="pageButtons.disabled"
    />

    <section
      v-else-if="moduleId === 'quickFeatures'"
      class="features"
      data-popup-module="quickFeatures"
    >
      <div class="feature-grid">
        <button
          v-for="feature in visiblePopupQuickFeatures"
          :key="feature.id"
          class="feature-card"
          :class="feature.className"
          :data-feature="feature.dataFeature"
          :data-popup-quick-feature="feature.id"
          type="button"
          :disabled="!config.on"
          :aria-label="feature.ariaLabel || `${translateLegacy(feature.label)} · ${translateLegacy(feature.summary)}`"
          :title="`${translateLegacy(feature.label)} · ${translateLegacy(feature.summary)}`"
          @click="feature.open()"
        >
          <span class="feature-icon" :class="feature.iconTone" aria-hidden="true">
            <svg class="feature-line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path :d="popupQuickFeatureIconPaths[feature.id]" />
            </svg>
          </span>
          <span class="feature-copy">
            <strong>{{ feature.label }}</strong>
            <small>{{ feature.summary }}</small>
          </span>
          <i v-if="feature.showStatus" :class="{active: feature.active}" />
          <b v-else aria-hidden="true">↗</b>
        </button>
      </div>
    </section>

    <footer
      v-else-if="moduleId === 'footer'"
      data-popup-module="footer"
      :data-popup-module-last="lastVisiblePopupModule === 'footer'"
    >
      <span class="popup-translation-count" data-i18n-ignore>{{ t('popup.translationCount', {count: config.count}) }}</span>
      <a
        class="opensource-link"
        href="https://github.com/Bistutu/FluentRead"
        target="_blank"
        rel="noreferrer"
        aria-label="在 GitHub 查看流畅阅读开源项目"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.26c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.62-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .3" />
        </svg>
        <span>开源项目</span>
        <span class="external-mark" aria-hidden="true">↗</span>
      </a>
      <button type="button" :disabled="clearingCache" :onClick="popupActions.cache">{{ clearingCache ? '清理中…' : '清除缓存' }}</button>
    </footer>
    </template>

    <el-drawer
      v-if="drawerMounted"
      v-model="drawerVisible"
      :title="drawerTitle"
      direction="btt"
      size="auto"
      :with-header="false"
      :append-to-body="true"
      modal-class="popup-drawer-modal"
      class="popup-drawer"
      :class="{ 'popup-quick-drawer': ['hover', 'selection', 'image'].includes(activeDrawer), 'popup-services-drawer': activeDrawer === 'services' }"
    >
      <div ref="drawerSurface" class="drawer-surface">
        <div class="drawer-handle" />
        <header v-if="activeDrawer !== 'services'" class="drawer-header">
        <div class="drawer-heading"><button v-if="activeDrawer === 'aiContext'" type="button" :aria-label="t('popup.providers.title')" :onClick="drawerActions.services">←</button><div><h2>{{ drawerTitle }}</h2><p v-if="!['image', 'services'].includes(activeDrawer)">{{ drawerDescription }}</p></div></div>
        <button type="button" aria-label="关闭" :onClick="drawerActions.close">×</button>
        </header>

      <div v-if="activeDrawer === 'services'" class="drawer-content provider-drawer-content">
        <PopupServices ref="servicesPanel" :config="config" :service-options="allServiceOptions" :active="drawerVisible && activeDrawer === 'services'" :onClose="drawerActions.close" />
      </div>
      <div v-else-if="activeDrawer === 'aiContext'" class="drawer-content ai-context-details" data-i18n-ignore>
        <div class="ai-context-detail-state" :data-ai-context-state="aiContextPresentation.state">
          <span class="ai-context-status" role="status">{{ t(`popup.aiContext.status.${aiContextPresentation.state}`) }}</span>
          <p data-testid="ai-context-description">{{ t(aiContextPresentation.descriptionKey) }}</p>
        </div>
        <p v-if="credentialWarning" class="ai-context-setup-details" role="alert">{{ translateLegacy(credentialWarning) }}</p>
        <div class="setting-row">
          <span><strong>{{ t('popup.aiContext.preference') }}</strong><small>{{ t('popup.aiContext.preferenceHint') }}</small></span>
          <button
            class="switch compact ai-context-detail-switch"
            type="button"
            role="switch"
            :aria-label="t('popup.aiContext.preference')"
            :aria-checked="config.enableAIContext"
            :disabled="aiContextPresentation.toggleDisabled"
            :onClick="drawerActions.aiContext"
          ><i /></button>
        </div>
        <dl class="ai-context-explanation">
          <div><dt>{{ t('popup.aiContext.howTitle') }}</dt><dd>{{ t('popup.aiContext.how') }}</dd></div>
          <div><dt>{{ t('popup.aiContext.costTitle') }}</dt><dd>{{ t('popup.aiContext.cost') }}</dd></div>
          <div><dt>{{ t('popup.aiContext.applyTitle') }}</dt><dd>{{ t('popup.aiContext.apply') }}</dd></div>
        </dl>
        <button class="secondary-action" type="button" data-testid="ai-context-settings" :onClick="drawerActions.serviceSettings">{{ t('popup.aiContext.configure') }} ↗</button>
      </div>

      <div v-else-if="activeDrawer === 'hover'" class="drawer-content">
        <div class="setting-row quick-enable-row">
          <span>
            <strong>{{ t('popup.quickTranslation.defaultHoverShortcut') }}</strong>
            <small v-if="quickHoverProfiles.length" class="independent-profile-note">{{ t('popup.quickTranslation.defaultOnly', {count: quickHoverProfiles.length}) }}</small>
          </span>
          <button class="switch compact" type="button" role="switch" :aria-label="t('popup.quickTranslation.defaultHoverShortcut')" :aria-checked="defaultHoverEnabled" data-testid="hover-enable" :onClick="drawerActions.hover"><i /></button>
        </div>
        <div class="interaction-preview hover-translation-preview" :class="{'preview-disabled': !hoverProfileCount}">
          <span class="cursor" aria-hidden="true">↖</span><span aria-hidden="true">＋</span>
          <button class="hover-keycap" type="button" :aria-label="t('popup.quickSettings.chooseHoverShortcut')" :title="t('popup.quickSettings.chooseHoverShortcut')" :onClick="drawerActions.translationSettings" data-i18n-ignore>{{ hoverPreviewKey }}</button>
          <span aria-hidden="true">＝</span><strong>即时翻译</strong>
        </div>
        <div v-if="quickHoverProfiles.length" class="quick-profile-preview" data-testid="popup-quick-hover-profiles">
          <label>{{ t('popup.quickTranslation.extraProfiles') }}</label>
          <div v-for="profile in quickHoverProfiles.slice(0, 3)" :key="profile.id" class="quick-profile-preview-row">
            <kbd>{{ profile.hotkey }}</kbd>
            <span>{{ quickProfileSummary(profile) }}</span>
          </div>
          <small v-if="quickHoverProfiles.length > 3">{{ t('popup.quickTranslation.moreProfiles', {count: quickHoverProfiles.length - 3}) }}</small>
        </div>
      </div>

      <div v-else-if="activeDrawer === 'selection'" class="drawer-content">
        <div>
          <div class="setting-row quick-enable-row">
            <span><strong>{{ t('popup.selectionTranslation') }}</strong></span>
            <button class="switch compact" type="button" role="switch" :aria-label="t('popup.selectionTranslation')" :aria-checked="config.selectionTranslatorMode !== 'disabled'" data-testid="selection-enable" :onClick="drawerActions.selection"><i /></button>
          </div>
          <div class="choice-block">
            <label>翻译模式</label>
            <div class="chips two" role="group" aria-label="划词翻译模式">
              <button v-for="item in drawerSelectionModes" :key="item.value" type="button" :class="{ selected: (config.selectionTranslatorMode === 'disabled' ? config.selectionTranslatorModeBeforeDisable : config.selectionTranslatorMode) === item.value }" :aria-pressed="(config.selectionTranslatorMode === 'disabled' ? config.selectionTranslatorModeBeforeDisable : config.selectionTranslatorMode) === item.value" :disabled="config.selectionTranslatorMode === 'disabled'" :onClick="item.choose">{{ item.label }}</button>
            </div>
          </div>

        </div>

      </div>

      <div v-else-if="activeDrawer === 'image'" class="drawer-content image-methods">
        <div v-if="!browserCapabilities.imageTranslation" class="capability-unavailable" role="status">
          <strong>当前浏览器暂不支持图片翻译与 OCR</strong>
          <small>原有开关偏好已保留；请在 Chrome 中使用此功能。</small>
        </div>
        <button v-if="browserCapabilities.imageTranslation" class="image-method" :class="{enabled: !config.disableImageTranslator}" type="button" role="switch" :aria-checked="!config.disableImageTranslator" aria-label="启用或关闭图片翻译" :onClick="drawerActions.image">
          <svg class="image-method-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg>
          <span class="image-method-copy"><strong>{{ t('popup.image.web') }}</strong><small>{{ t('popup.image.webHint') }}</small></span>
          <span class="switch compact" :aria-checked="!config.disableImageTranslator" aria-hidden="true"><i /></span>
        </button>
        <div v-if="!browserCapabilities.areaTranslation" class="capability-unavailable" role="status">
          <strong>当前浏览器暂不支持圈选翻译</strong>
          <small>原有开关偏好已保留；回到 Chrome 后仍会按原设置生效。</small>
        </div>
        <button v-else class="image-method" :class="{enabled: config.selectionAreaEnabled}" type="button" role="switch" :aria-checked="config.selectionAreaEnabled" aria-label="启用或关闭圈选翻译" :onClick="drawerActions.area">
          <svg class="image-method-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>
          <span class="image-method-copy"><strong>{{ t('popup.image.area') }}</strong><small class="image-method-shortcut"><kbd data-i18n-ignore>{{ areaHotkeyDisplayName }}</kbd><span>{{ t('popup.image.areaHint') }}</span></small></span>
          <span class="switch compact" :aria-checked="config.selectionAreaEnabled" aria-hidden="true"><i /></span>
        </button>
        <div v-if="browserCapabilities.areaTranslation" class="area-translation-preview quick-area-preview" :class="{'preview-disabled': !config.selectionAreaEnabled}" data-testid="area-translation-demo">
          <span class="area-hotkey"><kbd v-for="(key, index) in areaPreviewKeys" :key="index" data-i18n-ignore>{{ key }}</kbd></span>
          <span aria-hidden="true">＋</span><span class="area-ring" aria-hidden="true" /><span aria-hidden="true">＝</span><strong>翻译选中区域</strong>
        </div>
      </div>

      <div v-else class="drawer-content">
        <div class="choice-block">
          <label>翻译模式</label>
          <div class="chips two" role="group" aria-label="翻译模式">
            <button v-for="item in drawerDisplayModes" :key="item.value" type="button" :class="{ selected: config.display === item.value }" :aria-pressed="config.display === item.value" :disabled="item.disabled" :onClick="item.choose">{{ item.label }}</button>
          </div>
        </div>
      </div>

        <p v-if="notice && noticeType === 'error'" class="notice error" role="alert">{{ notice }}</p>
        <button v-if="!['aiContext', 'services'].includes(activeDrawer)" class="drawer-settings-link" type="button" data-i18n-ignore :onClick="drawerActions.options">
          <span><strong>{{ t('popup.quickSettings.moreSettings') }}</strong></span>
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </el-drawer>

    </div>
  </main>
</template>

<script lang="ts" setup>
import PopupLanguageSelect from './PopupLanguageSelect.vue';
import DiagnosticNotice from '@/src/features/self-help/ui/DiagnosticNotice.vue';
import {getDiagnosticUiText, diagnoseFailure, normalizeDiagnostic, type Diagnostic, type DiagnosticAction, type DiagnosticUiTextKey} from '@/src/services/diagnostics';
import {normalizeTranslationToolbarStatus, type TranslationToolbarStatus} from '@/src/features/full-page-translation/toolbarStatus';

import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, toRefs, watch } from 'vue';
import browser from 'webextension-polyfill';
import type {Tabs} from 'webextension-polyfill';
import {
  config as runtimeConfig,
  configReady,
  handoffPendingConfigPatches,
  requestConfigPatch,
  subscribeConfig,
} from '@/src/services/config/store';
import { Setting } from '@element-plus/icons-vue';
import {getVisualViewportRect, observeVisualViewport} from '@/src/platform/dom/visualViewport';
import {normalizeConfig} from '@/src/core/config/model';
import {createApiKeyCheckRevision} from '@/src/core/config/apiKeyCheckIdentity';
import {resolveUiLanguageFromLocale, type UiLanguage} from '@/src/core/i18n';
import {
  options,
  services,
  resolveConfiguredModel,
  servicesType,
} from '@/src/core/config/catalog';
import {
  enabledQuickTranslationProfiles,
  findEnabledQuickTranslationHotkeyConflict,
    quickTranslationActionKey,
  type QuickTranslationProfile,
} from '@/src/core/config/quickTranslation';
import {parseHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {areaTranslationHotkeyDisplayName, resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {sectionTranslationHotkeyDisplayName} from '@/src/core/config/sectionTranslation';
import {
  getCustomOpenAIProvider,
  withCustomOpenAIServiceOptions,
} from '@/src/core/config/customOpenAI';
import {withCompositeTranslationServiceOptions} from '@/src/core/config/compositeTranslation';
import { getMissingCredentialMessage } from '@/src/core/config/validation';
import {
  interfaceSkinUsesContentHeight,
  type PopupQuickFeatureId,
} from '@/src/core/config/interfaceAppearance';
import { resolveAIContextPresentation } from '@/src/ui/view-model/aiContext';
import {createPopupPageActions, type PopupPageState, type PopupSiteRulePatch} from './pageActions';
import {createPopupTabSource} from './sourceTab';
import {getEmbeddedPopupTabId, closePopupSurface} from './embedded';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {waitForSettingsTask} from '@/src/features/settings/model/taskWait';
import {useConfigEditor} from '@/src/features/settings/model/useConfigEditor';
import {applyInterfaceFont, applyInterfaceSkin} from '@/src/ui/interfaceAppearance';
import { requestTranslationCacheClear } from './cache';
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
import {popupQuickFeatureIconPaths, popupQuickFeatureIconTones, type PopupQuickFeatureIconTone} from '@/src/ui/popupQuickFeatureIcons';
import {useUiI18n} from '@/src/ui/i18n';
import PopupSiteRule from './PopupSiteRule.vue';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {readFreePoolAccess, requestFreeProviderAccess, subscribeFreeProviderAccessChanges, type FreePoolAccess} from '@/src/platform/browser/freeProviderPermissions';
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {createPdfReaderUrl, getPdfSourceUrl} from '@/src/features/document-translation/core/pdfSource';
import {
  getTranslationServiceUnavailableMessage,
  isTranslationServiceAvailable,
} from '@/src/services/translation/capabilities';

type DrawerName = 'services' | 'hover' | 'selection' | 'appearance' | 'image' | 'aiContext';
type SettingsSection = 'settings-selection' | 'settings-general' | 'settings-interface' | 'settings-image-translation' | 'settings-area-translation' | 'settings-translation' | 'settings-services' | 'settings-sites' | 'settings-video' | 'settings-vocabulary';
interface PopupQuickFeatureViewModel {
  id: PopupQuickFeatureId;
  label: string;
  summary: string;
  icon: string;
  iconTone: PopupQuickFeatureIconTone;
  showStatus: boolean;
  active?: boolean;
  className?: string;
  dataFeature?: string;
  ariaLabel?: string;
  open: () => void | Promise<void>;
}
import {featureServiceDefinitions, getFeatureService} from '@/src/core/config/featureServices';
const PopupServices = defineAsyncComponent(() => import('./PopupServices.vue'));
const ElDrawer = defineAsyncComponent(() => import('./PopupDrawer'));
const UiLanguageOnboarding = defineAsyncComponent(() => import('@/src/ui/components/UiLanguageOnboarding.vue'));
const {language, bundleRevision, t, translateLegacy} = useUiI18n();
function diagnosticUi(key: DiagnosticUiTextKey): string {
  void bundleRevision.value;
  return getDiagnosticUiText(key, config.value.uiLanguage);
}
const version = browser.runtime.getManifest().version;
// composition root 已等待配置服务；首次渲染直接使用完整快照，不能先暴露默认布局。
const config = ref(normalizeConfig(runtimeConfig));
const onboardingLanguage = ref<UiLanguage>('zh-CN');
const drawerVisible = ref(false);
const drawerMounted = ref(false);
const drawerSurface = shallowRef<HTMLElement | null>(null);
const servicesPanel = shallowRef<{revealFocusedSearch: (current: () => boolean) => void} | null>(null);
let releaseDrawerViewport: (() => void) | undefined;
const activeDrawer = ref<DrawerName>('hover');
const pageState = reactive<PopupPageState>({tabId: null, url: '', domain: '', translated: false, busy: false, savingRule: false});
const {busy: translating, translated: pageTranslated, tabId: currentTabId, domain: currentSiteDomain} = toRefs(pageState);
const currentPdfSource = computed(() => getPdfSourceUrl(pageState.url));
const pageTranslationLabel = computed(() => t(currentPdfSource.value ? 'document.pdfReading.openReader' : pageTranslated.value ? 'popup.restoreCurrentPage' : 'popup.translateCurrentPage'));
const clearingCache = ref(false);
const donationVisible = ref(false);
const donationQrEnlarged = ref(false);
const donationCard = shallowRef<HTMLElement | null>(null);
const donationTrigger = shallowRef<HTMLButtonElement | null>(null);
const pageDiagnostic = shallowRef<Diagnostic>();
const pageResultStatus = ref<TranslationToolbarStatus>('idle');
function readPageResult(value: unknown) {
  const response = value as {isTranslated?: unknown; toolbarStatus?: unknown; diagnostic?: unknown} | undefined;
  pageResultStatus.value = normalizeTranslationToolbarStatus(response?.toolbarStatus);
  pageDiagnostic.value = normalizeDiagnostic(response?.diagnostic);
  if (pageResultStatus.value === 'error' && !pageDiagnostic.value) pageDiagnostic.value = diagnoseFailure(undefined);
}
const notice = ref('');
const noticeType = ref<'success' | 'error'>('success');
const hydrated = ref(false);
const showLanguageOnboarding = ref(false);
let pageExitSaveStarted = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const darkMode = window.matchMedia('(prefers-color-scheme: dark)');
const drawerSettingsSection: Record<DrawerName, SettingsSection> = {
  services: 'settings-services',
  aiContext: 'settings-general',
  hover: 'settings-translation',
  selection: 'settings-selection',
  appearance: 'settings-interface',
  image: 'settings-image-translation',
};
const sendConfigMessage = browser.runtime.sendMessage.bind(browser.runtime);
const persistConfigPatch = (value: unknown) => requestConfigPatch(value, sendConfigMessage);

function readBrowserUiLocale(): unknown {
  const browserI18n = (browser as unknown as {i18n?: {getUILanguage?: () => unknown}}).i18n;
  try {
    const extensionLocale = browserI18n?.getUILanguage?.();
    if (typeof extensionLocale === 'string' && extensionLocale.trim()) return extensionLocale;
  } catch {
    // navigator.language remains a reliable fallback in extension pages.
  }
  if (typeof navigator === 'undefined') return '';
  return navigator.languages?.find(locale => typeof locale === 'string' && locale.trim())
    || navigator.language
    || '';
}

// 圈选快捷键可自定义；抽屉提示、按键贴片和冲突检查都读取同一份解析结果。
const areaHotkey = computed(() => resolveAreaTranslationHotkey(
  config.value.selectionAreaHotkey,
  config.value.customSelectionAreaHotkey,
));
const areaHotkeyDisplayName = computed(() => areaTranslationHotkeyDisplayName(
  config.value.selectionAreaHotkey,
  config.value.customSelectionAreaHotkey,
));
// 局部翻译按钮只有图标和短标签，完整用途与已开启的快捷键放在提示与无障碍名称里。
const sectionTranslationLabel = computed(() => {
  const title = t('popup.sectionTranslationTitle');
  if (!config.value.sectionTranslationHotkeyEnabled) return title;
  const shortcut = sectionTranslationHotkeyDisplayName(config.value.sectionTranslationHotkey, config.value.customSectionTranslationHotkey);
  return `${title} · ${t('popup.sectionTranslationShortcut', {shortcut})}`;
});
// 自定义接口名称属于用户配置；内置服务才复用旧 UI 名称的本地化。
const customProviderNames = computed(() => new Map([...config.value.customOpenAIProviders, ...config.value.compositeTranslationProviders].map(provider => [provider.id, provider.name])));
const allServiceOptions = computed(() => withCompositeTranslationServiceOptions(withCustomOpenAIServiceOptions(
  options.services,
  config.value.customOpenAIProviders,
), config.value.compositeTranslationProviders).filter((item: any) => !item.disabled).map((item: any) => ({
  ...item,
  label: customProviderNames.value.get(item.value) ?? translateLegacy(item.label),
  description: item.description ? translateLegacy(item.description) : item.description,
  searchTerms: [...(item.searchTerms || []), customProviderNames.value.get(item.value) ?? translateLegacy(item.label)],
})));
const providerLabels = computed(() => new Map(allServiceOptions.value.map(item => [item.value, item.label])));
const providerLabel = (service: string) => providerLabels.value.get(service) || service;
const assignedProviders = computed(() => [...new Set([
  config.value.service,
  ...featureServiceDefinitions.map(feature => getFeatureService(config.value, feature) || config.value.service),
  ...enabledQuickTranslationProfiles(config.value.quickTranslationProfiles).map(profile => profile.service).filter(Boolean),
])]);
const selectedServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(config.value.service));
const selectedCustomOpenAIProvider = computed(() => getCustomOpenAIProvider(
  config.value.customOpenAIProviders,
  config.value.service,
));
const aiContextModel = computed(() => selectedCustomOpenAIProvider.value
  ? config.value.model[config.value.service] || selectedCustomOpenAIProvider.value.models[0] || ''
  : resolveConfiguredModel(
    config.value.model[config.value.service],
    config.value.customModel[config.value.service],
  ));
// 服务摘要只呈现该服务支持的配置模型；附加请求体仍可能覆盖最终请求模型。
const providerSummaryModel = computed(() => servicesType.isUseModel(config.value.service) ? aiContextModel.value : '');
const providerSummaryModelLabel = computed(() => providerSummaryModel.value
  ? t('featureServices.configuredModel', {model: providerSummaryModel.value}) : '');
const providerSummaryLabel = computed(() => [t('featureServices.open'), t('featureServices.default'),
  providerLabel(config.value.service), providerSummaryModelLabel.value].filter(Boolean).join(' · '));
const providerSummaryTitle = computed(() => `${providerSummaryLabel.value}\n${t('featureServices.shortHelp')}\n${assignedProviders.value.map(providerLabel).join(' · ')}`);
const canUseAIContext = computed(() => servicesType.isUseAIContext(
  selectedCustomOpenAIProvider.value ? 'custom' : config.value.service,
  aiContextModel.value,
));
const missingCredentialMessage = computed(() => getMissingCredentialMessage(config.value.service, config.value));
const credentialWarning = computed(() => selectedServiceUnavailableMessage.value || missingCredentialMessage.value);
const isThunderbird = browserCapabilities.browser === 'thunderbird';
const currentSiteSupported = computed(() => !isThunderbird && currentTabId.value !== null && Boolean(currentSiteDomain.value));
const currentSiteRuleEnabled = computed(() => currentSiteSupported.value
  && (config.value.alwaysTranslateDomains ?? []).includes(currentSiteDomain.value));
const currentSiteExtensionDisabled = computed(() => currentSiteSupported.value
  && (config.value.disabledExtensionDomains ?? []).includes(currentSiteDomain.value));
const currentSiteAlwaysTranslated = computed(() => currentSiteSupported.value && !currentSiteExtensionDisabled.value
  && (config.value.autoTranslate || currentSiteRuleEnabled.value));
const aiContextPresentation = computed(() => resolveAIContextPresentation({
  enabled: config.value.enableAIContext,
  supported: canUseAIContext.value,
  pluginEnabled: config.value.on,
  siteDisabled: currentSiteExtensionDisabled.value,
  unavailable: Boolean(selectedServiceUnavailableMessage.value),
  missingCredentials: Boolean(missingCredentialMessage.value),
  translating: translating.value,
}));
const isSiteModuleVisible = computed(() => config.value.interfaceVisibility.popupSiteRule && !isThunderbird);
const pageTranslationHotkey = computed(() => {
  const shortcut = resolveConfiguredHotkey(config.value.floatingBallHotkey, config.value.customFloatingBallHotkey);
  if (!shortcut || shortcut === 'none') return '';
  let displayName = parseHotkey(shortcut).displayName;
  if (/Mac|iPod|iPhone|iPad/u.test(navigator.platform)) {
    displayName = displayName.replace(/Control(?=\+)/gu, '⌃').replace(/Option(?=\+)/gu, '⌥')
      .replace(/Shift(?=\+)/gu, '⇧').replace(/Cmd(?=\+)/gu, '⌘');
  }
  return displayName.replace(/Pageup$/u, 'PgUp').replace(/Pagedown$/u, 'PgDn');
});
const pageTranslationButtonLabel = computed(() => {
  if (currentPdfSource.value) return pageTranslationLabel.value;
  const action = t(pageTranslated.value ? 'popup.compact.restore' : 'popup.compact.translate');
  // 超长组合完整保留在提示中；短组合直接并入标题，不另占按键胶囊或一行。
  const shortcut = pageTranslationHotkey.value;
  if (!shortcut || shortcut.length > 10) return action;
  return language.value === 'zh-CN' ? `${action}（${shortcut}）` : `${action} (${shortcut})`;
});
const pageTranslationTitle = computed(() => currentPdfSource.value || !pageTranslationHotkey.value
  ? pageTranslationLabel.value : `${pageTranslationLabel.value} · ${pageTranslationHotkey.value}`);
const visiblePopupQuickFeatureIds = computed(() => config.value.popupQuickFeatureOrder.filter(
  (featureId) => config.value.popupQuickFeatureVisibility[featureId]
    && (!isThunderbird || ['hover', 'selection', 'appearance'].includes(featureId)),
));
const visiblePopupModuleOrder = computed(() => config.value.popupModuleOrder.filter((moduleId) => {
  if (moduleId === 'translation') return true;
  if (moduleId === 'siteRule') return isSiteModuleVisible.value;
  if (moduleId === 'quickFeatures') {
    return config.value.interfaceVisibility.popupQuickFeatures
      && visiblePopupQuickFeatureIds.value.length > 0;
  }
  return config.value.interfaceVisibility.popupFooter;
}));
const siteModuleNestedInTranslation = computed(() => {
  const translationIndex = visiblePopupModuleOrder.value.indexOf('translation');
  return translationIndex >= 0 && visiblePopupModuleOrder.value[translationIndex + 1] === 'siteRule';
});
const lastVisiblePopupModule = computed(() => visiblePopupModuleOrder.value.at(-1));
const popupUsesContentHeight = computed(() => interfaceSkinUsesContentHeight(config.value.interfaceSkin)
  || !config.value.interfaceVisibility.popupQuickFeatures
  || !config.value.interfaceVisibility.popupSiteRule
  || !config.value.interfaceVisibility.popupFooter
  || Object.values(config.value.popupQuickFeatureVisibility).some((visible) => !visible));
const currentSiteSwitchLabel = computed(() => currentSiteSupported.value
  ? currentSiteExtensionDisabled.value
    ? `${currentSiteDomain.value} 已禁用扩展，无法开启始终翻译 · ${config.value.autoTranslate || currentSiteRuleEnabled.value ? '恢复扩展后继续自动翻译' : '请先恢复扩展'}`
    : config.value.autoTranslate
    ? `所有网站自动翻译已开启，${currentSiteDomain.value} 会自动翻译`
    : `始终翻译 ${currentSiteDomain.value}`
  : '始终翻译当前网站（当前页面不可用）');
const currentSiteExtensionSwitchLabel = computed(() => currentSiteSupported.value
  ? currentSiteExtensionDisabled.value
    ? `恢复 ${currentSiteDomain.value} 的扩展`
    : `在 ${currentSiteDomain.value} 禁用扩展`
  : '在此网站禁用扩展（当前页面不可用）');
const siteRuleModuleProps = computed(() => ({
  active: popupContext.active.value,
  context: pageContext.revision.value,
  domain: currentSiteDomain.value,
  supported: currentSiteSupported.value,
  alwaysTranslated: currentSiteAlwaysTranslated.value,
  alwaysPaused: currentSiteExtensionDisabled.value && (config.value.autoTranslate || currentSiteRuleEnabled.value),
  extensionDisabled: currentSiteExtensionDisabled.value,
  autoTranslate: config.value.autoTranslate,
  translating: translating.value,
  saving: pageState.savingRule,
  switchLabel: currentSiteSwitchLabel.value,
  extensionSwitchLabel: currentSiteExtensionSwitchLabel.value,
}));
const styleLabel = computed(() => options.styles.find((item: any) => item.value === config.value.style)?.label || '默认样式');
const defaultHoverHotkey = computed(() => resolveConfiguredHotkey(config.value.hotkey, config.value.customHotkey));
const defaultHoverEnabled = computed(() => Boolean(defaultHoverHotkey.value && defaultHoverHotkey.value !== 'none'));
const hoverKey = computed(() => defaultHoverEnabled.value ? defaultHoverHotkey.value : '未设置');
const quickHoverProfiles = computed(() => enabledQuickTranslationProfiles(config.value.quickTranslationProfiles, 'hover')
  .filter((profile) => isTranslationServiceAvailable(profile.service || config.value.service)));
const hoverProfileCount = computed(() => quickHoverProfiles.value.length + (defaultHoverEnabled.value ? 1 : 0));
const hoverPreviewKey = computed(() => resolveConfiguredHotkey(defaultHoverEnabled.value ? config.value.hotkey
  : quickHoverProfiles.value.length ? 'custom' : config.value.hoverShortcutBeforeDisable,
  !defaultHoverEnabled.value && quickHoverProfiles.value.length ? quickHoverProfiles.value[0].hotkey : config.value.customHotkey) || t('common.notSet'));
const hoverSummary = computed(() => quickHoverProfiles.value.length
  ? t('popup.quickTranslation.profileCount', {count: hoverProfileCount.value})
  : defaultHoverEnabled.value ? hoverKey.value.replace('Control', 'Ctrl') : '已关闭');
function quickProfileSummary(profile: QuickTranslationProfile): string {
  const service = profile.service || config.value.service;
  const serviceName = providerLabel(service);
  if (!servicesType.isUseModel(service)) return serviceName;
  const model = profile.model || resolveConfiguredModel(config.value.model[service], config.value.customModel[service]);
  return model ? `${serviceName} · ${model}` : serviceName;
}
const selectionSummary = computed(() => config.value.selectionTranslatorMode === 'disabled'
  ? '已关闭' : config.value.selectionTranslatorTrigger === 'contextMenu'
    ? t('selectionTrigger.contextMenu')
    : options.selectionTranslatorTriggers.find(item => item.value === config.value.selectionTranslatorTrigger)?.label || '显示图标');
const displaySummary = computed(() => config.value.display === 1 ? `双语 · ${styleLabel.value}` : '仅显示译文');
const imageTranslationSummary = computed(() => !browserCapabilities.imageTranslation
  ? '当前浏览器不可用'
  : config.value.selectionAreaEnabled ? areaHotkeyDisplayName.value : config.value.disableImageTranslator ? '已关闭' : '悬停图片');
const popupQuickFeatureViewModels = computed<Record<PopupQuickFeatureId, PopupQuickFeatureViewModel>>(() => {
  const current = popupContext.capture();
  return {
  hover: {
    id: 'hover',
    label: '鼠标悬停翻译',
    summary: hoverSummary.value,
    icon: '↖',
    iconTone: popupQuickFeatureIconTones.hover,
    showStatus: true,
    active: hoverProfileCount.value > 0,
    open: () => {if (current()) openDrawer('hover')},
  },
  selection: {
    id: 'selection',
    label: '划词翻译',
    summary: selectionSummary.value,
    icon: 'I',
    iconTone: popupQuickFeatureIconTones.selection,
    showStatus: true,
    active: config.value.selectionTranslatorMode !== 'disabled',
    open: () => {if (current()) openDrawer('selection')},
  },
  appearance: {
    id: 'appearance',
    label: '译文显示',
    summary: displaySummary.value,
    icon: 'Aa',
    iconTone: popupQuickFeatureIconTones.appearance,
    showStatus: false,
    open: () => {if (current()) openDrawer('appearance')},
  },
  image: {
    id: 'image',
    label: '图片翻译',
    summary: imageTranslationSummary.value,
    icon: '▧',
    iconTone: popupQuickFeatureIconTones.image,
    showStatus: true,
    active: (browserCapabilities.imageTranslation && !config.value.disableImageTranslator) || (browserCapabilities.areaTranslation && config.value.selectionAreaEnabled),
    open: () => {if (current()) openDrawer('image')},
  },
  document: {
    id: 'document',
    label: '文档翻译',
    summary: 'PDF / Word / …',
    icon: '文',
    iconTone: popupQuickFeatureIconTones.document,
    showStatus: false,
    className: 'document-feature-card',
    dataFeature: 'document-translation',
    ariaLabel: '打开文档翻译',
    open: () => {if (current()) return openDocumentTranslation()},
  },
};});
const visiblePopupQuickFeatures = computed(() => visiblePopupQuickFeatureIds.value
  .map((featureId) => popupQuickFeatureViewModels.value[featureId]));
const drawerTitle = computed(() => ({ services: t('popup.providers.title'), aiContext: t('popup.aiContext.title'), hover: '鼠标悬停翻译设置', selection: '划词翻译设置', appearance: '译文显示设置', image: '图片翻译' }[activeDrawer.value]));
const drawerDescription = computed(() => ({
  services: '',
  aiContext: t('popup.aiContext.intro'),
  hover: '将鼠标停在段落上，按快捷键查看译文。',
  selection: '选中网页文字，按你的偏好获取译文。',
  appearance: t('popup.quickSettings.appearanceDescription'),
  image: '把鼠标移到图片上，从图片左下角打开翻译入口。',
}[activeDrawer.value]));
const selectionModes = [
  { value: 'bilingual', label: '双语显示' },
  { value: 'translation-only', label: '仅译文' },
] as const;
const areaPreviewKeys = computed(() => {
  const label = areaHotkeyDisplayName.value;
  return label.endsWith('+') ? [...label.slice(0, -1).split('+').filter(Boolean), '+'] : label.split('+').filter(Boolean);
});

const pageExited = ref(false);
const popupContext = useSettingsActionContext(() => hydrated.value && !showLanguageOnboarding.value && !pageExited.value,
  () => [config.value, config.value.on]);
// 权威计数同步会重新分配配置中的对象；比较实际值与安全连接指纹，不能因此撤销当前诊断。
const pageConfigurationIdentity = computed(() => JSON.stringify([config.value.on, config.value.service,
  config.value.from, config.value.to, config.value.display, config.value.model[config.value.service],
  config.value.customModel[config.value.service], config.value.disabledExtensionDomains.join(','), config.value.alwaysTranslateDomains.join(','),
  config.value.autoTranslate, credentialWarning.value, createApiKeyCheckRevision(config.value, config.value.service)]));
const pageContext = useSettingsActionContext(() => popupContext.active.value, () => [pageConfigurationIdentity.value]);
const safariFreePool = computed(() => browserCapabilities.browser === 'safari' && config.value.service === services.freeTranslation);
const freePoolAccess = shallowRef<FreePoolAccess | null>(null);
const freePoolLoading = ref(false), freePoolBusy = ref(false), freePoolError = ref<'' | 'safari.freePool.error' | 'safari.freePool.requestDenied'>('');
let freePoolGeneration = 0;
let freePoolReadController: AbortController | undefined;
let freePoolRefreshQueued = false;
let stopFreePoolEvents: (() => void) | undefined;
const freePoolStatus = computed(() => {
  if (freePoolLoading.value || freePoolBusy.value) return t('safari.freePool.loading');
  if (freePoolError.value) return t(freePoolError.value);
  const access = freePoolAccess.value;
  if (access?.grantedIds.length) return t('safari.freePool.availableCount', {count: access.grantedIds.length, total: config.value.freeTranslationOrder.length});
  const provider = FREE_TRANSLATION_PROVIDERS.find(item => item.id === access?.preferredGrant?.id);
  return t('safari.freePool.needsAccess', {provider: provider ? translateLegacy(provider.label) : ''});
});
function refreshFreePoolAccess(clearError = true): void {
  const generation = ++freePoolGeneration, current = popupContext.capture();
  freePoolReadController?.abort();freePoolReadController = undefined;
  freePoolAccess.value = null;if (clearError) freePoolError.value = '';freePoolBusy.value = false;freePoolRefreshQueued = false;
  freePoolLoading.value = popupContext.active.value && safariFreePool.value;
  if (!freePoolLoading.value) return;
  const controller = new AbortController();freePoolReadController = controller;
  void waitForSettingsTask(readFreePoolAccess(config.value.freeTranslationOrder, {signal: controller.signal}), controller.signal, 10_000, t('safari.freePool.error')).then(access => {
    if (current() && generation === freePoolGeneration) freePoolAccess.value = access;
  }).catch(() => {
    if (current() && generation === freePoolGeneration) freePoolError.value = 'safari.freePool.error';
  }).finally(() => {if (generation === freePoolGeneration) freePoolLoading.value = false;});
}
watch(() => [popupContext.active.value, popupContext.revision.value, safariFreePool.value, config.value.freeTranslationOrder.join('\0')], () => refreshFreePoolAccess(), {flush: 'sync', immediate: true});
function freePoolAccessChanged(change: 'added' | 'removed' = 'added'): void {
  // 自己授权时的 added/focus 不能淘汰最初点击；removed 始终取消迟到的继续操作。
  if (change === 'added' && freePoolBusy.value) {freePoolRefreshQueued = true;return;}
  if (change === 'removed' && freePoolBusy.value) pageActions.invalidate();
  refreshFreePoolAccess();
}
function freePoolPageFocused(): void {freePoolAccessChanged();}
function freePoolPageVisible(): void {if (document.visibilityState === 'visible') freePoolAccessChanged();}
onMounted(() => {
  if (browserCapabilities.browser !== 'safari') return;
  stopFreePoolEvents = subscribeFreeProviderAccessChanges(freePoolAccessChanged);
  window.addEventListener('focus', freePoolPageFocused);
  document.addEventListener('visibilitychange', freePoolPageVisible);
});
onUnmounted(() => {
  stopFreePoolEvents?.();
  window.removeEventListener('focus', freePoolPageFocused);
  document.removeEventListener('visibilitychange', freePoolPageVisible);
});
const cacheContext = useSettingsActionContext(() => popupContext.active.value, () => []);
const tabSource = createPopupTabSource(window.location?.search || '', {
  get: id => browser.tabs.get(id), query: () => browser.tabs.query({active: true, currentWindow: true}),
}, getEmbeddedPopupTabId());
const pageActions = createPopupPageActions({state: pageState, config: () => config.value, active: () => pageContext.active.value,
  warning: () => credentialWarning.value || '', getTab: tabSource.getTab,
  persistRule: persistSiteRulePatch,
  openPdf: source => browser.tabs.create({url: createPdfReaderUrl(browser.runtime.getURL('document.html'), source)}),
  onStatus: readPageResult, onFailure: diagnostic => {pageDiagnostic.value = diagnostic;notice.value = ''},
  send: (id, message) => browser.tabs.sendMessage(id, message, {frameId: 0}), notice: showNotice, close: closePopupSurface, translate: t, thunderbird: isThunderbird});
const {hydrate: hydrateCurrentSite, toggle: togglePageTranslation, section: startSectionTranslation,
  setAlways: setCurrentSiteAlwaysTranslated, setDisabled: setCurrentSiteExtensionDisabled} = pageActions;
watch(pageContext.revision, () => {pageActions.invalidate();readPageResult(undefined);if (!config.value.on || currentSiteExtensionDisabled.value) pageTranslated.value = false}, {flush: 'sync'});
const pageRenderRevision = ref(0);
watch(() => [pageState.tabId, pageState.url, pageState.translated, pageState.busy, pageState.savingRule], () => {pageRenderRevision.value += 1}, {flush: 'sync'});
const pageButtons = computed(() => {
  const current = pageContext.capture(), version = pageRenderRevision.value;
  const owns = () => current() && version === pageRenderRevision.value;
  return {toggle: () => {if (owns()) return runPageWithFreePoolAccess('toggle')}, section: () => {if (owns()) return runPageWithFreePoolAccess('section')},
    always: (value: boolean) => {if (owns()) return setCurrentSiteAlwaysTranslated(value)},
    disabled: (value: boolean) => {if (owns()) return setCurrentSiteExtensionDisabled(value)}};
});
function runPageWithFreePoolAccess(action: 'toggle' | 'section' | 'retry'): Promise<void> | void {
  const run = () => action === 'retry' ? pageActions.retry() : action === 'toggle' ? togglePageTranslation() : startSectionTranslation();
  // 恢复原文与打开 PDF 阅读器不产生新的免费池请求，不能被授权状态阻挡。
  if ((action === 'toggle' && (pageTranslated.value || currentPdfSource.value)) || !safariFreePool.value) return run();
  if (!pageContext.active.value || !config.value.on || translating.value || pageState.savingRule || currentSiteExtensionDisabled.value
      || freePoolBusy.value || freePoolLoading.value) return;
  const access = freePoolAccess.value;
  if (access?.grantedIds.length) {
    // 已授权路径同样持有待发页面操作，撤权时不能让旧标签页查询继续发送翻译。
    const generation = freePoolGeneration;
    freePoolBusy.value = true;
    return (async () => {try {await run();} finally {finishFreePoolAction(generation);}})();
  }
  const provider = access?.preferredGrant;
  if (!provider) {freePoolError.value = 'safari.freePool.error';return;}
  const current = pageContext.capture(), generation = freePoolGeneration, owner = config.value, render = pageRenderRevision.value;
  const identity = [owner.service, owner.from, owner.to, owner.freeTranslationOrder.join('\0'), pageState.tabId, pageState.url];
  const owns = () => current() && generation === freePoolGeneration && config.value === owner && render === pageRenderRevision.value
    && identity.every((value, index) => value === [owner.service, owner.from, owner.to, owner.freeTranslationOrder.join('\0'), pageState.tabId, pageState.url][index]);
  let request: Promise<boolean>;
  // request 必须在实际 click 中同步调用；此处之前不能 await、查询标签页或转交 background。
  freePoolBusy.value = true;freePoolError.value = '';
  try {request = requestFreeProviderAccess(provider.id);} catch {
    if (owns()) {freePoolError.value = 'safari.freePool.error';freePoolBusy.value = false;}
    return;
  }
  return (async () => {
    try {
      if (!await request) {if (owns()) freePoolError.value = 'safari.freePool.requestDenied';return;}
      if (!owns()) return;
      const refreshed = await waitForSettingsTask(readFreePoolAccess(owner.freeTranslationOrder, {signal: freePoolReadController!.signal}), freePoolReadController!.signal, 10_000, t('safari.freePool.error'));
      if (!owns()) return;
      freePoolAccess.value = refreshed;
      if (!refreshed.grantedIds.includes(provider.id)) {freePoolError.value = 'safari.freePool.requestDenied';return;}
      freePoolError.value = '';
      // pageActions 仍复验实际标签页；授权等待中导航不能把旧翻译意图移交到新网页。
      return await run();
    } catch {if (owns()) freePoolError.value = 'safari.freePool.error';}
    finally {finishFreePoolAction(generation);}
  })();
}
function finishFreePoolAction(generation: number): void {
  if (generation !== freePoolGeneration) return;
  freePoolBusy.value = false;
  if (freePoolRefreshQueued) refreshFreePoolAccess(false);
}
const donationRevision = ref(0);
watch(donationVisible, () => {donationRevision.value += 1}, {flush: 'sync'});

const donationActions = computed(() => {
  const current = popupContext.capture(), sequence = donationRevision.value;
  const close = () => {if (current() && sequence === donationRevision.value) closeDonation()};
  return {open: () => {if (current() && sequence === donationRevision.value) return openDonation()},
    close, overlay: (event: MouseEvent) => {if (event.target === event.currentTarget) close()}};
});
const popupActions = computed(() => {
  const current = popupContext.capture();
  const bind = (run: () => void | Promise<void>) => () => {if (current()) return run()};
  return {settings: bind(() => openOptions()), serviceSettings: bind(() => openOptions('settings-services', undefined, config.value.service)),
    services: bind(() => openDrawer('services')), cache: bind(clearCache)};
});
const drawerContext = useSettingsActionContext(() => popupContext.active.value && drawerVisible.value,
  () => [config.value, activeDrawer.value, config.value.on, config.value.hotkey, config.value.customHotkey,
    config.value.selectionTranslatorMode, config.value.selectionTranslatorPresentation, config.value.selectionAreaEnabled,
    config.value.disableImageTranslator, config.value.display, config.value.service, config.value.enableAIContext,
    browserCapabilities.areaTranslation, browserCapabilities.imageTranslation]);
const drawerActions = computed(() => {
  const current = drawerContext.capture(), section = drawerSettingsSection[activeDrawer.value];
  const bind = (run: () => void | Promise<void>) => () => {if (current()) return run()};
  return {close: bind(() => {drawerVisible.value = false}), aiContext: bind(toggleAIContext), hover: bind(toggleDefaultHoverShortcut),
    selection: bind(toggleSelectionTranslation), image: bind(() => setImageTranslatorEnabled(config.value.disableImageTranslator)),
    area: bind(() => setAreaEnabled(!config.value.selectionAreaEnabled)), options: bind(() => openOptions(section)),
    services: bind(() => openDrawer('services')), serviceSettings: bind(() => openOptions('settings-services', undefined, config.value.service)),
    translationSettings: bind(() => openOptions('settings-translation'))};
});
const drawerSelectionModes = computed(() => {
  const current = drawerContext.capture();
  return selectionModes.map(item => ({...item, choose: () => {if (current() && config.value.on && config.value.selectionTranslatorMode !== 'disabled') setSelectionMode(item.value)}}));
});
const drawerDisplayModes = computed(() => {
  const current = drawerContext.capture();
  return options.display.map(item => ({...item, disabled: !config.value.on || (config.value.service === 'google' && item.value === 0),
    choose: () => {if (current() && config.value.on && (config.value.service !== 'google' || item.value !== 0)) config.value.display = item.value}}));
});
watch(popupContext.active, enabled => {if (!enabled) {drawerVisible.value = false;donationVisible.value = false;notice.value = '';if (noticeTimer) clearTimeout(noticeTimer)}}, {flush: 'sync'});
// 只向自己实际 teleport 的遮罩提供内部抽屉定位变量；遮罩仍覆盖整页，键盘视口不参与根 popup 尺寸协商。
watch([drawerVisible, drawerSurface, popupContext.active], ([visible, surface, active]) => {
  releaseDrawerViewport?.();
  releaseDrawerViewport = undefined;
  const overlay = surface?.closest<HTMLElement>('.popup-drawer-modal');
  if (!visible || !active || !overlay) return;
  const properties = ['left', 'top', 'width', 'height'] as const;
  let previousHeight: number | undefined;
  const update = () => {
    if (!drawerVisible.value || !popupContext.active.value || !overlay.isConnected) return;
    const viewport = getVisualViewportRect();
    for (const property of properties) overlay.style.setProperty(`--fluent-read-drawer-${property}`, `${viewport[property]}px`);
    overlay.setAttribute('data-fluent-read-popup-viewport', '');
    overlay.toggleAttribute('data-fluent-read-popup-short', viewport.height < 224);
    // 同一视口订阅负责展开后的焦点外框；不重置服务列表，也不移动宿主页面。
    if (previousHeight !== undefined && viewport.height > previousHeight) servicesPanel.value?.revealFocusedSearch?.(drawerContext.capture());
    previousHeight = viewport.height;
  };
  update();
  const stop = observeVisualViewport(update);
  releaseDrawerViewport = () => {
    stop();
    overlay.removeAttribute('data-fluent-read-popup-viewport');
    overlay.removeAttribute('data-fluent-read-popup-short');
    for (const property of properties) overlay.style.removeProperty(`--fluent-read-drawer-${property}`);
  };
}, {flush: 'sync'});
watch(() => config.value.on, enabled => {if (!enabled && activeDrawer.value !== 'services' && activeDrawer.value !== 'aiContext') drawerVisible.value = false}, {flush: 'sync'});
watch(cacheContext.active, enabled => {if (!enabled) clearingCache.value = false}, {flush: 'sync'});

function applyTheme(theme: string) {
  document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'auto' && darkMode.matches));
}

function applyPopupHeightMode(usesContentHeight: boolean) {
  document.documentElement.dataset.popupHeight = usesContentHeight ? 'content' : 'fixed';
}

async function hydrate() {
  if (!config.value.uiLanguageSetupCompleted) {
    onboardingLanguage.value = resolveUiLanguageFromLocale(readBrowserUiLocale());
  }
  showLanguageOnboarding.value = !config.value.uiLanguageSetupCompleted;
  applyTheme(config.value.theme || 'auto');
  applyInterfaceSkin(config.value.interfaceSkin);
  applyInterfaceFont(config.value.interfaceFont);
  applyPopupHeightMode(popupUsesContentHeight.value);
  hydrated.value = true;
  if (!showLanguageOnboarding.value) await hydrateCurrentSite();
}
void hydrate();

function handleLanguageOnboardingConfirmed(language: UiLanguage): void {
  onboardingLanguage.value = language;
  showLanguageOnboarding.value = false;
  void hydrateCurrentSite();
}

const configEditor = useConfigEditor({
  copySnapshot: normalizeConfig,
  readDraft: () => config.value,
  writeDraft: snapshot => {Object.assign(config.value, snapshot);},
  saveDraft: snapshot => persistConfigPatch(snapshot),
  subscribe: subscribeConfig,
  ready: configReady,
  readAuthority: () => runtimeConfig,
  flush: 'post',
  onEdited: () => {pageExitSaveStarted = false;},
  onSaved: () => {},
  onSaveError: error => console.warn('[FluentRead] 保存 popup 设置失败', error),
  onReady: () => {},
  onReadyError: error => console.warn('[FluentRead] 无法读取 popup 配置', error),
});

// 站点操作等待后台确认；捕获完整当前草稿，让共享 store 同步归一化并计算字段差量，
// 同 tick 尚未提交的其他用户修改也随补丁保留，避免窄补丁的乐观订阅覆盖草稿。
// 配置订阅与 post watcher 继续使用原去重，关闭前继续交接待确认补丁。
async function persistSiteRulePatch(patch: PopupSiteRulePatch): Promise<void> {
  await persistConfigPatch({...config.value, ...patch});
}
watch(() => config.value.theme, theme => applyTheme(theme || 'auto'));
watch(() => config.value.interfaceSkin, skin => applyInterfaceSkin(skin));
watch(() => config.value.interfaceFont, font => applyInterfaceFont(font));
watch(popupUsesContentHeight, applyPopupHeightMode, {immediate: true});
darkMode.onchange = () => { if (config.value.theme === 'auto') applyTheme('auto'); };

async function openDonation() {
  if (!popupContext.active.value || donationVisible.value) return;
  const current = popupContext.capture(), before = document.activeElement;
  donationQrEnlarged.value = false;
  donationVisible.value = true;const sequence = donationRevision.value;
  await nextTick();
  if (current() && donationVisible.value && sequence === donationRevision.value
    && (document.activeElement === before || document.activeElement === document.body)) {
    donationCard.value?.querySelector<HTMLButtonElement>('.donation-close')?.focus({preventScroll: true});
  }
}
function closeDonation() {
  if (!popupContext.active.value || !donationVisible.value) return;
  const before = document.activeElement, restore = donationCard.value?.contains(before) || before === document.body;
  donationVisible.value = false;
  donationQrEnlarged.value = false;
  if (restore && donationTrigger.value?.isConnected) donationTrigger.value.focus({preventScroll: true});
}
function handleDonationKeydown(event: KeyboardEvent) {
  if (!popupContext.active.value || !donationVisible.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDonation();
  } else if (event.key === 'Tab') {
    const controls = donationCard.value?.querySelectorAll<HTMLElement>('button, a[href]');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const outside = !donationCard.value?.contains(document.activeElement);
    if (outside || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
}
function toggleAIContext() {
  if (aiContextPresentation.value.toggleDisabled) return;
  config.value.enableAIContext = !config.value.enableAIContext;
}
function handleTabUpdated(tabId: number, change: Tabs.OnUpdatedChangeInfoType, tab: Tabs.Tab) {
  // loading 时内容脚本可能尚未接管；complete 再握手，才能绑定同 URL 刷新后的新文档令牌。
  if (popupContext.active.value && (typeof change.url === 'string' || change.status === 'loading' || change.status === 'complete')
    && (tabSource.fixed ? tabId === tabSource.sourceTabId
      : tabId === currentTabId.value || (tab.active && (pageState.windowId === undefined || tab.windowId === pageState.windowId)))) void hydrateCurrentSite();
}
function handleTabActivated(info: Tabs.OnActivatedActiveInfoType) {
  if (!tabSource.fixed && popupContext.active.value && (pageState.windowId === undefined || info.windowId === pageState.windowId) && info.tabId !== currentTabId.value) void hydrateCurrentSite();
}
async function diagnosticAction(action: DiagnosticAction) {
  if (!popupContext.active.value || !pageDiagnostic.value) return;
  if (action === 'dismiss') {
    const current = popupContext.capture();pageDiagnostic.value = undefined;
    await nextTick();if (current()) document.querySelector<HTMLButtonElement>('[data-testid="page-translation"]')?.focus();
    return;
  }
  if (action === 'services') return openOptions('settings-services', undefined, config.value.service);
  if (action === 'site-settings') return openOptions('settings-sites', 'adaptation', undefined, true);
  if (action === 'refresh') {
    const current = pageContext.capture();
    try {
    const tab = await tabSource.getTab();
    if (current() && tab?.id === currentTabId.value && (tab.pendingUrl || tab.url || '') === pageState.url) {
      try {await browser.tabs.reload(tab.id);if (current()) closePopupSurface();} catch {if (current()) showNotice(diagnosticUi('refresh-failed'), 'error');}
    }
    } catch {if (current()) showNotice(diagnosticUi('source-closed'), 'error');}
    return;
  }
  if (action === 'retry') {pageDiagnostic.value = undefined;await runPageWithFreePoolAccess('retry');}
}
function handlePageResultMessage(message: unknown, sender: {id?: string; url?: string; tab?: {id?: number; url?: string; pendingUrl?: string}; frameId?: number}): undefined {
  const response = message as {type?: unknown; isTranslated?: unknown; documentToken?: unknown} | undefined;
  if (!pageContext.active.value || sender.id !== browser.runtime.id || (sender.url !== undefined && sender.url !== pageState.url) || sender.tab?.id !== currentTabId.value || (sender.frameId !== undefined && sender.frameId !== 0) || response?.type !== 'fullPageTranslationState') return;
  pageActions.receiveStatus(sender.tab.id, sender.tab.pendingUrl || sender.tab.url, response);
  return undefined;
}
function handleTabRemoved(tabId: number) {
  if (popupContext.active.value && tabId === (tabSource.fixed ? tabSource.sourceTabId : currentTabId.value)) void hydrateCurrentSite();
}
onMounted(() => {
  browser.runtime.onMessage.addListener(handlePageResultMessage);
  document.addEventListener('keydown', handleDonationKeydown);
  browser.tabs.onUpdated.addListener(handleTabUpdated);
  browser.tabs.onActivated.addListener(handleTabActivated);
  browser.tabs.onRemoved.addListener(handleTabRemoved);
});
onUnmounted(() => {
  releaseDrawerViewport?.();
  releaseDrawerViewport = undefined;
  persistOnPageExit();
  pageExited.value = true;
  window.removeEventListener('pagehide', saveOnPageHide);
  configEditor.dispose();
  browser.runtime.onMessage.removeListener(handlePageResultMessage);
  document.removeEventListener('keydown', handleDonationKeydown);
  browser.tabs.onUpdated.removeListener(handleTabUpdated);
  browser.tabs.onActivated.removeListener(handleTabActivated);
  browser.tabs.onRemoved.removeListener(handleTabRemoved);
  darkMode.onchange = null;
  delete document.documentElement.dataset.popupHeight;
  if (noticeTimer) clearTimeout(noticeTimer);
});

function saveOnPageHide() {
  persistOnPageExit();
  pageExited.value = true;
}
window.addEventListener('pagehide', saveOnPageHide);

// Firefox 可能同时触发 pagehide 和 unmounted；只执行一次关闭交接。
// 乐观配置相等不代表补丁已交给后台：先捕获尚未触发 watcher 的修改，
// 再把未确认补丁链同步交给后台接续，避免页面销毁后本地排队的下一次修改丢失。
// 空补丁链不发送消息，普通查看后关闭仍不重复保存。
function persistOnPageExit() {
  if (!hydrated.value || !config.value.uiLanguageSetupCompleted || pageExitSaveStarted) return;
  pageExitSaveStarted = true;
  void persistConfigPatch(config.value).catch((error) => console.warn('[FluentRead] popup 关闭前后台保存设置失败', error));
  void handoffPendingConfigPatches(sendConfigMessage, sendConfigMessage)
    .catch((error) => console.warn('[FluentRead] popup 关闭前交接设置失败', error));
}

function showNotice(message: string, type: 'success' | 'error' = 'success') {
  if (!popupContext.active.value) return;
  notice.value = message;
  noticeType.value = type;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, type === 'error' ? 5000 : 2800);
}

// 配置订阅是内容功能的唯一状态来源；避免无 revision 的广播晚到后覆盖新快照。
function openDrawer(name: DrawerName) {if (!popupContext.active.value || (!config.value.on && name !== 'services' && name !== 'aiContext')) return;activeDrawer.value = name;drawerMounted.value = true;drawerVisible.value = true;}
async function openOptions(section?: SettingsSection, target?: string, service?: string, repairSource = false) {
  if (!popupContext.active.value) return;
  const current = popupContext.capture();
  try {
    if (section) {
      const query = new URLSearchParams();
      if (service) query.set('service', service);
      if (target) query.set('target', target);
      if ((service || repairSource) && currentTabId.value !== null) query.set('returnTabId', String(currentTabId.value));
      const search = query.toString();
      await browser.tabs.create({url: `${browser.runtime.getURL('options.html')}${search ? `?${search}` : ''}#${section}`});
    } else {
      await browser.runtime.openOptionsPage();
    }
    if (current()) closePopupSurface();
  } catch {
    if (current()) showNotice(translateLegacy('无法打开设置，请从扩展菜单打开设置后重试'), 'error');
  }
}

async function openDocumentTranslation() {
  if (!popupContext.active.value || !config.value.on) return;
  const current = popupContext.capture();
  try {
    const tab = await tabSource.getTab();
    if (!current()) return;
    const source = getPdfSourceUrl(tab?.pendingUrl || tab?.url || '');
    const readerUrl = browser.runtime.getURL('document.html');
    await browser.tabs.create({ url: source ? createPdfReaderUrl(readerUrl, source) : readerUrl });
    if (current()) closePopupSurface();
  } catch {if (current()) showNotice(t('translationCenter.requestError'), 'error');}
}

async function clearCache() {
  if (!popupContext.active.value || clearingCache.value) return;
  const current = cacheContext.capture();
  clearingCache.value = true;
  try {
    await requestTranslationCacheClear((message) => browser.runtime.sendMessage(message));
    if (current()) showNotice('全部翻译缓存已清除');
  } catch (error) {
    if (current()) {console.error(error);showNotice('缓存清除失败', 'error');}
  } finally { if (current()) clearingCache.value = false; }
}

function quickTranslationConflictMessage(hotkey: string): string {
  const conflict = findEnabledQuickTranslationHotkeyConflict(config.value.quickTranslationProfiles, hotkey);
  if (!conflict) return '';
  const group = t(`quickTranslation.heading.${quickTranslationActionKey(conflict.action)}`);
  return t('quickTranslation.conflictProfilePopup', {group});
}
function toggleDefaultHoverShortcut() {
  if (defaultHoverEnabled.value) {
    config.value.hoverShortcutBeforeDisable = config.value.hotkey;
    config.value.hotkey = 'none';
    return;
  }
  const previous = config.value.hoverShortcutBeforeDisable;
  const resolved = resolveConfiguredHotkey(previous, config.value.customHotkey);
  const restored = resolved && resolved !== 'none' ? previous : 'Control';
  const conflictMessage = quickTranslationConflictMessage(resolveConfiguredHotkey(restored, config.value.customHotkey));
  if (conflictMessage) {showNotice(conflictMessage, 'error'); return;}
  config.value.hotkey = restored;
}
function toggleSelectionTranslation() {
  setSelectionMode(config.value.selectionTranslatorMode === 'disabled'
    ? config.value.selectionTranslatorModeBeforeDisable : 'disabled');
}
function setSelectionMode(mode: 'disabled' | 'bilingual' | 'translation-only') {
  if (mode === 'disabled' && config.value.selectionTranslatorMode !== 'disabled') {
    config.value.selectionTranslatorModeBeforeDisable = config.value.selectionTranslatorMode === 'translation-only' ? 'translation-only' : 'bilingual';
  } else if (mode !== 'disabled') {
    config.value.selectionTranslatorModeBeforeDisable = mode;
  }
  config.value.selectionTranslatorMode = mode;
  config.value.disableSelectionTranslator = mode === 'disabled';
}
function setAreaEnabled(enabled: boolean) {
  if (!browserCapabilities.areaTranslation) {
    showNotice('当前浏览器暂不支持圈选翻译', 'error');
    return;
  }
  const conflictMessage = enabled ? quickTranslationConflictMessage(areaHotkey.value) : '';
  if (conflictMessage) {
    showNotice(conflictMessage, 'error');
    return;
  }
  config.value.selectionAreaEnabled = enabled;
}
function setImageTranslatorEnabled(enabled: boolean) {
  if (!browserCapabilities.imageTranslation) {
    showNotice('当前浏览器暂不支持图片翻译与 OCR', 'error');
    return;
  }
  config.value.disableImageTranslator = !enabled;
}
</script>
