<!--
 @file src/app/options/OptionsApp.vue
 文件职责：实现扩展 Options 页的顶层布局，组织设置导航、全局搜索结果和学习中心入口，并把选中分区交给对应 feature UI。
 主要内容：页面名称由 main 辅助技术标签提供，内容直接从统一的紧凑页内导航或表单开始，不再渲染重复页面标题；侧栏展示品牌与多语言宣传语；关于页以随界面语言显示产品名的宽幅品牌介绍、项目链接卡片、开源项目下方的微信交流按钮和独立赞赏区组织内容，联系二维码与赞赏码在当前页弹窗展示；渲染默认展开的分组侧栏、窄屏分类选择和全局搜索，搜索只在同次派生内复用原始查询的小写值和语言入口判断，语言恢复查询优先展示现有软件语言入口并定位选择控件；普通设置连续展示并提供顶部滚动定位导航，统计保留任务视图切换，智能高亮锚点及搜索入口随脚本版能力隐藏，服务目录使用完整工作区，复用 settingsNavigation 的项目解析/过滤逻辑，在 SettingsSections 与 LearningCenter 之间切换并重置内容区滚动，通过当前导航 getter 向迟到学习面板提供可见性，同步 URL hash 的深链接与前进后退导航，URL 目标仅接受当前分区登记的具体设置或可用分类并复用已有滚动定位，兼容模型用量迁入翻译统计后的旧链接；界面根节点注册在卸载时只释放本页面句柄。
 模块边界：组件负责页面壳、导航状态和主题、界面皮肤根属性同步，不定义具体配置字段、不直接写 browser.storage，也不实现词汇仓库；设置表单、收藏与阅读记录业务由各 feature 组件拥有；学习栏目加载失败的重载动作在普通设置页保留栏目参数，页内设置只重载宿主文档。
-->
<template>
  <div class="settings-app" :class="{'has-overlay-close': Boolean(props.onClose)}">
    <aside class="sidebar">
      <a class="brand" :href="websiteUrl" target="_blank" rel="noopener noreferrer" :aria-label="t('options.aboutWebsite')" :title="t('options.aboutWebsite')">
        <img :src="iconUrl" alt="" />
        <div class="brand-copy">
          <strong data-i18n-ignore>{{ t('common.brand') }}</strong>
          <p class="sidebar-tagline" data-testid="brand-tagline" data-i18n-ignore>{{ t('brand.tagline') }}</p>
        </div>
      </a>

          <label class="search-box">
            <UiIcon name="search" :size="16" />
            <input v-model.trim="query" type="search" :placeholder="t('options.search')" :aria-label="t('options.search')" @keydown.esc="query = ''" />
          </label>

      <nav ref="navigationElement" :aria-label="t('options.navLabel')">
        <section v-for="(group, index) in localizedNavigationGroups" :key="group.label" class="nav-group">
          <button type="button" class="nav-group-toggle" :aria-expanded="isGroupOpen(index)" :aria-controls="`settings-nav-group-${index}`" @click="toggleGroup(index)">
            <span>{{ group.label }}</span><span class="nav-chevron" :class="{open: isGroupOpen(index)}" aria-hidden="true">›</span>
          </button>
          <div v-show="isGroupOpen(index)" :id="`settings-nav-group-${index}`" class="nav-group-items">
          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            :data-section="item.id"
            :class="{ active: activeSection === item.id }"
            :aria-current="activeSection === item.id ? 'page' : undefined"
            @click="selectSection(item.id)"
          >
            <span class="nav-icon"><SettingsNavigationIcon :section="item.id" /></span>
            <strong>{{ item.label }}</strong>
          </button>
          </div>
        </section>
      </nav>
      <select class="mobile-settings-navigation" :value="activeSection" :aria-label="t('options.navLabel')" @change="selectSection(($event.target as HTMLSelectElement).value)">
        <optgroup v-for="group in localizedNavigationGroups" :key="group.label" :label="group.label">
          <option v-for="item in group.items" :key="item.id" :value="item.id">{{ item.label }}</option>
        </optgroup>
      </select>
    </aside>

    <main class="workspace" :aria-label="activeItem.title">
      <header v-show="((activePanels.length || hasSectionAnchors) && !userscriptUnavailableSection) || props.onClose" class="topbar">
        <nav v-if="activePanels.length && !userscriptUnavailableSection" class="settings-page-tabs settings-subnavigation" :aria-label="t('options.categories')">
        <button v-for="panel in activePanels" :key="panel.id" type="button" :data-settings-category="panel.id" :aria-current="activePanel === panel.id ? 'true' : undefined" @click="selectPanel(panel.id)">{{ t(panel.labelKey) }}</button>
      </nav>
        <SettingsSectionNavigation
          v-else-if="!userscriptUnavailableSection"
          ref="sectionNavigationElement"
          :container="settingsContentElement"
          :section-id="activeSection"
          :panels="sectionPanels"
          @availability-change="hasSectionAnchors = $event"
          @navigate="cancelPendingSearchReveal?.()"
        />
        <button v-if="props.onClose" type="button" class="userscript-settings-close" :aria-label="t('common.close')" :title="t('common.close')" @click="props.onClose()">
          <UiIcon name="close" :size="18" />
        </button>
      </header>

      <div v-if="query && filteredResults.length" class="search-results">
        <button v-for="result in filteredResults" :key="result.id" type="button" @click="selectResult(result)">
          <span><strong>{{ result.label }}</strong><small>{{ result.searchDescription }}</small></span><b>{{ t('options.open') }} →</b>
        </button>
      </div>
      <div v-else-if="query" class="search-empty">{{ t('options.searchEmpty', {query}) }}</div>



      <section ref="settingsContentElement" class="settings-card" :class="{ 'services-view': activeSection === 'settings-services', 'translation-center-view': activeSection === 'settings-translation-center', 'vocabulary-view': activeSection === 'settings-vocabulary' }" :aria-label="activeItem.heading">
        <KeepAlive>
        <section v-if="userscriptUnavailableSection" :id="activeSection" class="userscript-unavailable" role="status">
          <h2>{{ t('options.userscriptUnavailableTitle') }}</h2>
          <p>{{ t('options.userscriptUnavailableDescription') }}</p>
        </section>
        <section v-else-if="activeSection === 'settings-about'" id="settings-about" class="about-page" :aria-label="t('options.aboutTitle')">
          <header class="about-hero">
            <div class="about-intro">
              <div class="about-identity">
                <img class="about-logo" :src="iconUrl" alt="" />
                <div>
                  <strong>{{ t('common.brand') }}</strong>
                  <span class="about-version">V{{ version }} · {{ t('options.aboutHeroDescription') }}</span>
                </div>
              </div>
              <h2 data-i18n-ignore>{{ t('brand.tagline') }}</h2>
            </div>
          </header>
          <div class="about-grid">
            <section class="about-panel about-links-panel" :aria-label="t('options.aboutLearnMore')">
              <h3>{{ t('options.aboutLearnMore') }}</h3>
              <p class="about-panel-description">{{ t('options.aboutLinksDescription') }}</p>
              <div class="about-links">
                <a v-for="link in aboutLinks" :key="link.label" :class="{ 'about-website': link.href === websiteUrl }" :href="link.href" target="_blank" rel="noopener noreferrer">
                  <span class="about-link-icon"><UiIcon :name="link.icon" :size="23" /></span>
                  <span class="about-link-copy"><strong>{{ t(link.label) }}</strong><small>{{ t(link.description) }}</small></span>
                  <UiIcon name="external" :size="16" />
                </a>
                <button
                  ref="wechatContactTrigger"
                  class="about-wechat-contact"
                  type="button"
                  aria-haspopup="dialog"
                  @click="openQrPreview('contact')"
                >
                  <span class="about-link-icon"><UiIcon name="scan" :size="23" /></span>
                  <span class="about-link-copy"><strong>{{ t('options.aboutWechatContact') }}</strong><small>{{ t('options.aboutWechatContactDescription') }}</small></span>
                  <UiIcon name="arrow-right" :size="16" />
                </button>
              </div>
            </section>
            <article class="about-panel about-support-panel">
              <h3>{{ t('popup.donationTitle') }}</h3>
              <p class="about-panel-description">{{ t('options.aboutThanks') }}</p>
              <div class="about-support-options">
                <button
                  ref="approvePreviewTrigger"
                  class="about-support-method about-support-wechat"
                  data-support-method="wechat"
                  type="button"
                  :aria-label="t('options.aboutEnlargeCode')"
                  :title="t('options.aboutEnlargeCode')"
                  @click="openQrPreview('support')"
                >
                  <!-- 绑定表达式让模板编译器保留 public 路径，避免再打包一份带 hash 的同图。 -->
                  <img class="about-support-qr" :src="getSupportImageUrl(approveUrl)" :alt="t('popup.donationCodeAlt')" width="1152" height="1152" />
                  <span>{{ t('popup.donationWechat') }}</span>
                </button>
                <a class="about-support-method about-support-kofi-link" data-support-method="kofi" href="https://ko-fi.com/thinkstu" target="_blank" rel="noopener noreferrer">
                  <span class="about-support-mark" aria-hidden="true"><UiIcon name="star" :size="26" /></span>
                  <span class="about-support-kofi-label">{{ t('popup.donationKofi') }}<UiIcon name="external" :size="15" /></span>
                </a>
              </div>
            </article>
          </div>

        </section>
          <component
            v-else
            :is="activeSection === 'settings-vocabulary' ? LearningCenter : SettingsSections"
            :key="activeSection === 'settings-vocabulary' ? 'learning' : 'settings'"
            v-bind="contentComponentProps"
          />
        </KeepAlive>
      </section>

    </main>
    <el-dialog
      v-model="approvePreviewVisible"
      class="about-qr-dialog"
      :class="qrPreviewKind === 'contact' ? 'about-wechat-contact-dialog' : 'about-approve-dialog'"
      :title="qrPreviewKind === 'contact' ? t('options.aboutWechatContact') : t('popup.donationWechat')"
      width="min(560px, calc(100vw - 32px))"
      align-center
      :close-on-click-modal="true"
      :close-on-press-escape="true"
      destroy-on-close
      @closed="restoreApprovePreviewFocus"
    >
      <img
        class="about-approve-preview"
        :src="qrPreviewUrl"
        :alt="qrPreviewKind === 'contact' ? t('options.aboutWechatContactCodeAlt') : t('popup.donationCodeAlt')"
        :width="qrPreviewKind === 'contact' ? 888 : 1152"
        :height="qrPreviewKind === 'contact' ? 1131 : 1152"
      />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import '@/src/features/settings/ui/components/settings-navigation.css'
import UiIcon from '@/src/ui/components/UiIcon.vue'
import {getSupportImageUrl, getContactImageUrl} from './aboutImages'
import {SETTINGS_TABBED_SECTION_IDS, settingsPagePanels, resolveSettingsPanel, filterNavigationItems, filterSettingsSearchTargets, isUiLanguageSearch, settingsSearchTargets} from '@/src/features/settings/model/navigation';
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SettingsNavigationIcon from '@/src/features/settings/ui/SettingsNavigationIcon.vue'
import SettingsSectionNavigation from '@/src/features/settings/ui/components/SettingsSectionNavigation.vue'
const SettingsSections = defineAsyncComponent(() => import('@/src/features/settings/ui/SettingsSections.vue'))
const LearningCenter = defineAsyncComponent(() => import('@/src/features/settings/ui/LearningCenter.vue'))
import {useUiI18n} from '@/src/ui/i18n'
import {
  navigationGroups,
  navigationItems,
  resolveNavigationItem,
  resolveRequestedSection,
} from '@/src/features/settings/model/navigation'
import {
  config as runtimeConfig,
  configReady,
  subscribeConfig,
} from '@/src/services/config/store'
import {applyInterfaceFont, applyInterfaceSkin, applyInterfaceTheme, registerInterfaceAppearanceRoot} from '@/src/ui/interfaceAppearance'
import {browserCapabilities} from '@/src/platform/browser/capabilities'

const props = defineProps<{
  appearanceRoot?: HTMLElement | null
  queryRoot?: ParentNode | null
  settingsHashPrefix?: string
  initialSection?: string
  locationRouting?: 'internal'
  onClose?: () => void
}>()
let disposed = false
const version = process.env.VUE_APP_VERSION
const websiteUrl = 'https://read.thinkstu.com'
const iconUrl = globalThis.__FLUENTREAD_ICON_DATA__ || '/icon/128.png'
const approveUrl = globalThis.__FLUENTREAD_APPROVE_DATA__ || '/misc/approve.jpg'
const approvePreviewVisible = ref(false)
const qrPreviewUrl = ref<string>()
const approvePreviewTrigger = ref<HTMLButtonElement | null>(null)
const wechatContactTrigger = ref<HTMLButtonElement | null>(null)
const qrPreviewKind = ref<'contact' | 'support'>('support')
function openQrPreview(kind: 'contact' | 'support') {
  const nextUrl = kind === 'contact' ? getContactImageUrl() : getSupportImageUrl(approveUrl)
  qrPreviewKind.value = kind
  qrPreviewUrl.value = nextUrl
  approvePreviewVisible.value = true
}
function restoreApprovePreviewFocus() {
  if (disposed || activeSection.value !== 'settings-about') return
  const trigger = qrPreviewKind.value === 'contact' ? wechatContactTrigger : approvePreviewTrigger
  trigger.value?.focus({preventScroll: true})
}
const aboutLinks = [
  {href: websiteUrl, icon: 'globe', label: 'options.aboutWebsite', description: 'options.aboutWebsiteDescription'},
  {href: 'https://read.thinkstu.com/', icon: 'book', label: 'options.aboutDocs', description: 'options.aboutDocsDescription'},
  {href: 'https://github.com/Bistutu/FluentRead', icon: 'card', label: 'options.aboutProject', description: 'options.aboutProjectDescription'},
  {href: 'https://github.com/Bistutu/FluentRead/issues', icon: 'info', label: 'options.aboutFeedback', description: 'options.aboutFeedbackDescription'},
]
const {t, translateLegacy} = useUiI18n()
const query = ref('')
function sectionFromHash(hash: string): string {
  if (!props.settingsHashPrefix) return hash.replace(/^#/, '')
  const prefix = `${props.settingsHashPrefix}/`
  return hash.startsWith(prefix) ? hash.slice(prefix.length) : ''
}

function hashForSection(section: string): string {
  return props.settingsHashPrefix ? `${props.settingsHashPrefix}/${section}` : `#${section}`
}

const initialDestination = props.initialSection || sectionFromHash(window.location.hash)
const activeSection = ref(resolveRequestedSection(initialDestination))
const expandedGroups = ref(new Set<number>(navigationGroups.map((_, index) => index)))
function isGroupOpen(index: number): boolean {
  return expandedGroups.value.has(index)
}
function toggleGroup(index: number): void {
  const next = new Set(expandedGroups.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  expandedGroups.value = next
}
const selectedPanels = ref<Record<string, string>>({[activeSection.value]: resolveSettingsPanel(initialDestination)})
const informationHighlightAvailable = import.meta.env.BROWSER !== 'userscript' && browserCapabilities.browser !== 'userscript'
const isAvailableSettingsEntry = (entry: {id: string}) => entry.id !== 'information-highlight' || informationHighlightAvailable
const sectionPanels = computed(() => (settingsPagePanels[activeSection.value] || [])
  .filter(isAvailableSettingsEntry))
const activePanels = computed(() => SETTINGS_TABBED_SECTION_IDS.has(activeSection.value) ? settingsPagePanels[activeSection.value] : [])
const activePanel = computed(() => resolveSettingsPanel(activeSection.value, selectedPanels.value[activeSection.value]))
function selectPanel(id: string): void {
  selectSection(activeSection.value, id)
}
const userscriptUnavailableSections = new Set([
  'settings-image-translation',
  'settings-area-translation',
  'settings-video',
  'settings-writing',
  'settings-translation-stats',
  'settings-model-usage',
])
const userscriptUnavailableSection = computed(() => browserCapabilities.browser === 'userscript'
  && userscriptUnavailableSections.has(activeSection.value))
const navigationElement = ref<HTMLElement | null>(null)
const settingsContentElement = ref<HTMLElement | null>(null)
const hasSectionAnchors = ref(false)
const sectionNavigationElement = ref<{cancelPendingAnchor: () => void; highlightAnchor: (id: string) => void} | null>(null)
const mobileNavigationMedia = window.matchMedia('(max-width: 700px)')
const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
function syncInterfaceTheme(theme: string | undefined): void {
  if (disposed) return
  applyInterfaceTheme(theme === 'dark' || ((!theme || theme === 'auto') && systemThemeMedia.matches), props.appearanceRoot)
}
function handleSystemThemeChange(): void {
  syncInterfaceTheme(runtimeConfig.theme)
}
let searchRevealGeneration = 0
let cancelPendingSearchReveal: (() => void) | null = null

const releaseInterfaceAppearanceRoot = props.appearanceRoot ? registerInterfaceAppearanceRoot(props.appearanceRoot) : () => {}

const navigation = navigationItems
function reloadLearningPage(tab: string): void {
  if (props.locationRouting !== 'internal') {
    const url = new URL(window.location.href)
    url.searchParams.set('learningTab', tab)
    window.history.replaceState(window.history.state, '', url)
  }
  window.location.reload()
}
// getter 在旧 KeepAlive VNode 中仍读取当前导航，异步面板迟到挂载时不会使用过期的布尔快照。
function isLearningVisible(): boolean {return activeSection.value === 'settings-vocabulary'}
const contentComponentProps = computed(() => activeSection.value === 'settings-vocabulary'
  ? {onNavigate: selectSection, onReload: reloadLearningPage, isVisible: isLearningVisible, initialTab: new URLSearchParams(window.location.search).get('learningTab') || 'saved'}
  : {
      activeSection: activeSection.value,
      activePanel: activePanels.value.length ? activePanel.value : undefined,
      appearanceRoot: props.appearanceRoot,
      queryRoot: props.queryRoot,
      settingsHashPrefix: props.settingsHashPrefix,
      onNavigateSection: selectSection,
    })
const localizedNavigationGroups = computed(() => navigationGroups.map((group) => ({
  ...group,
  label: translateLegacy(group.label),
  items: group.items.map((item) => ({
    ...item,
    label: translateLegacy(item.label),
    description: translateLegacy(item.description),
    heading: translateLegacy(item.heading).replace('FluentRead', t('common.brand')),
    summary: translateLegacy(item.summary),
    kicker: translateLegacy(item.kicker),
    title: translateLegacy(item.title),
    detail: translateLegacy(item.detail),
    searchDescription: item.id === 'settings-interface'
      ? `${translateLegacy(item.searchDescription)} ${t('settings.interface.font.label')} Inter Noto Sans SC Roboto Source Sans 3 IBM Plex Sans Manrope Nunito Sans LXGW WenKai Noto Serif SC`
      : translateLegacy(item.searchDescription),
  })),
})))
const localizedNavigationItems = computed(() => localizedNavigationGroups.value.flatMap((group) => group.items))
const localizedSearchTargets = computed(() => settingsSearchTargets.filter(isAvailableSettingsEntry).map((target) => ({
  ...target,
  label: target.id === 'information-highlight' ? t('informationHighlight.title') : translateLegacy(target.label),
  description: translateLegacy(target.description),
  searchTerms: `${target.label} ${target.searchTerms}`,
})))
const activeItem = computed(() => localizedNavigationItems.value.find((item) => item.id === resolveNavigationItem(activeSection.value).id)
  || localizedNavigationItems.value[0])
const unsubscribeInterfaceConfig = subscribeConfig((nextConfig) => {
  if (disposed) return
  syncInterfaceTheme(nextConfig.theme)
  applyInterfaceSkin(nextConfig.interfaceSkin, props.appearanceRoot)
  applyInterfaceFont(nextConfig.interfaceFont, props.appearanceRoot)
})

void configReady
  .then(() => {
    if (disposed) return
    syncInterfaceTheme(runtimeConfig.theme)
    applyInterfaceSkin(runtimeConfig.interfaceSkin, props.appearanceRoot)
    applyInterfaceFont(runtimeConfig.interfaceFont, props.appearanceRoot)
  })
  .catch(() => {
    if (disposed) return
    syncInterfaceTheme('auto')
    applyInterfaceSkin('default', props.appearanceRoot)
    applyInterfaceFont('system', props.appearanceRoot)
  })

type SearchResult = {id: string; sectionId: string; targetId?: string; panelId?: string; label: string; searchDescription: string}
const filteredResults = computed<SearchResult[]>(() => {
  const searchQuery = query.value
  const keyword = searchQuery ? searchQuery.toLocaleLowerCase() : ''
  const languageSearch = isUiLanguageSearch(searchQuery)
  const results: SearchResult[] = [
    ...Object.entries(settingsPagePanels).flatMap(([sectionId, panels]) => panels
      .filter(panel => isAvailableSettingsEntry(panel) && searchQuery && `${t(panel.labelKey)} ${panel.searchTerms}`.toLocaleLowerCase().includes(keyword))
      .map(panel => ({id: `${sectionId}/${panel.id}`, sectionId, panelId: panel.id, label: t(panel.labelKey), searchDescription: localizedNavigationItems.value.find(item => item.id === sectionId)?.label ?? ''}))),
    ...filterSettingsSearchTargets(searchQuery, localizedSearchTargets.value).map(target => ({
      id: target.id,
      sectionId: target.sectionId,
      targetId: target.targetId,
      label: target.label,
      searchDescription: target.description,
    })),
    ...filterNavigationItems(searchQuery, localizedNavigationItems.value).map(item => ({
      id: item.id,
      sectionId: item.id,
      label: item.id === 'settings-general' && languageSearch
        ? `${t('language.selectorLabel')} / Language`
        : item.label,
      searchDescription: item.id === 'settings-general' && languageSearch
        ? t('language.settingsDescription')
        : item.description,
    })),
  ]
  if (languageSearch) {
    const languageIndex = results.findIndex(result => result.id === 'settings-general')
    if (languageIndex > 0) results.unshift(...results.splice(languageIndex, 1))
  }
  return results
})

function selectSection(requestedId: string, panelOrTargetId?: string) {
  if (disposed) return
  const id = resolveRequestedSection(requestedId)
  if (requestedId === 'settings-model-usage') panelOrTargetId = 'usage'
  if (requestedId === 'settings-area-translation') panelOrTargetId = 'area'
  if (!navigation.some((item) => item.id === id)) return
  sectionNavigationElement.value?.cancelPendingAnchor()
  searchRevealGeneration += 1
  cancelPendingSearchReveal?.()
  selectedPanels.value[id] = resolveSettingsPanel(id, panelOrTargetId)
  expandedGroups.value = new Set([...expandedGroups.value, navigationGroups.findIndex(group => group.items.some(item => item.id === id))])
  activeSection.value = id
  query.value = ''
  if (props.locationRouting !== 'internal') {
    const nextHash = hashForSection(id === 'settings-translation-stats' && selectedPanels.value[id] === 'usage' ? 'settings-model-usage' : id)
    if (window.location.hash !== nextHash) {
      history.replaceState(null, '', nextHash)
    }
  }
  // 分区 DOM 更新后归零真正的内容滚动区，避免切换菜单仍停留在上个长表单的底部。
  const generation = searchRevealGeneration
  void nextTick(() => {
    if (!disposed && generation === searchRevealGeneration) settingsContentElement.value?.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  })
  if (panelOrTargetId && !SETTINGS_TABBED_SECTION_IDS.has(id)) {
    void revealSettingsTarget({id, sectionId: id, targetId: settingsPagePanels[id]?.some(panel => panel.id === panelOrTargetId) ? undefined : panelOrTargetId, panelId: selectedPanels.value[id], label: '', searchDescription: ''})
  }
}

// 同页定位保留懒加载：目标挂载后滚动，用户开始操作即停止定位。
async function revealSettingsTarget(result: SearchResult) {
  if (result.targetId || result.panelId) {
    const generation = searchRevealGeneration
    await nextTick()
    if (disposed || generation !== searchRevealGeneration) return
    const content = settingsContentElement.value
    if (!content) return
    let timeoutId: number | undefined
    const stop = () => {
      observer.disconnect()
      sizeObserver.disconnect()
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        content.removeEventListener(event, stop, true)
      }
      if (cancelPendingSearchReveal === stop) cancelPendingSearchReveal = null
    }
    const revealTarget = () => {
      if (disposed || generation !== searchRevealGeneration || query.value || activeSection.value !== result.sectionId) {
        stop()
        return
      }
      const selector = result.targetId ? `#${result.targetId}` : `[data-settings-panel="${result.panelId}"]`
      // 连续表单可能由多个同级 section 组成，目标不一定是首个 section 的后代。
      const target = Array.from(content.querySelectorAll<HTMLElement>(selector)).find(element => element.getClientRects().length)
      if (!target?.getClientRects().length) return
      if (target.tagName === 'DETAILS' && !target.hasAttribute('open')) target.setAttribute('open', '')
      const targetRect = target.getBoundingClientRect()
      const contentTop = content.getBoundingClientRect().top
      const centerOffset = result.targetId && !target.matches('.settings-section, .settings-page-panel') && targetRect.height < content.clientHeight
        ? (content.clientHeight - targetRect.height) / 2
        : 0
      content.scrollTo({
        top: Math.max(0, content.scrollTop + targetRect.top - contentTop - centerOffset),
        behavior: 'instant',
      })
      if (result.panelId) sectionNavigationElement.value?.highlightAnchor(result.panelId)
      target.querySelector<HTMLElement>('[role="switch"]')?.focus({preventScroll: true})
    }
    const observer = new MutationObserver(revealTarget)
    const sizeObserver = new ResizeObserver(revealTarget)
    observer.observe(content, {subtree: true, childList: true, attributes: true, attributeFilter: ['style']})
    sizeObserver.observe(content.firstElementChild ?? content)
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      content.addEventListener(event, stop, {capture: true, passive: true})
    }
    cancelPendingSearchReveal = stop
    timeoutId = window.setTimeout(stop, 3000)
    revealTarget()
  }
}

async function selectResult(result: SearchResult) {
  const revealLanguage = result.id === 'settings-general' && isUiLanguageSearch(query.value)
  selectSection(result.sectionId, result.targetId || result.panelId)
  const generation = searchRevealGeneration
  if (revealLanguage) {
    await nextTick()
    if (disposed || generation !== searchRevealGeneration) return
    const control = (props.queryRoot || document).querySelector<HTMLElement>('[data-testid="ui-language-select"] input')
    control?.scrollIntoView({block: 'center'})
    control?.focus()
  }
}

async function revealActiveNavigation() {
  const section = activeSection.value
  await nextTick()
  if (disposed || section !== activeSection.value) return
  navigationElement.value
    ?.querySelector<HTMLElement>(`button[data-section="${activeSection.value}"]`)
    ?.scrollIntoView({
      block: 'nearest',
      inline: mobileNavigationMedia.matches ? 'center' : 'nearest',
    })
}

watch(activeSection, () => {
  approvePreviewVisible.value = false
  void revealActiveNavigation()
})

function handleMobileNavigationChange() {
  void revealActiveNavigation()
}

function syncSectionFromHash() {
  const requested = sectionFromHash(window.location.hash)
  const section = resolveRequestedSection(requested)
  const targetId = new URLSearchParams(window.location.search).get('target')
  // 优先具体设置，再接受当前分区已登记且可用的分类；URL 永远不能成为任意 CSS 或跨分区目标。
  const target = localizedSearchTargets.value.find(item => item.sectionId === section && item.targetId === targetId)
  const panel = settingsPagePanels[section]?.find(item => item.id === targetId && isAvailableSettingsEntry(item))
  selectSection(requested, target?.targetId ?? panel?.id)
}

onMounted(() => {
  if (props.locationRouting !== 'internal') {
    syncSectionFromHash()
    window.addEventListener('hashchange', syncSectionFromHash)
  }
  mobileNavigationMedia.addEventListener('change', handleMobileNavigationChange)
  systemThemeMedia.addEventListener('change', handleSystemThemeChange)
  void revealActiveNavigation()
})

onBeforeUnmount(() => {
  disposed = true
  searchRevealGeneration += 1
  releaseInterfaceAppearanceRoot()
  cancelPendingSearchReveal?.()
  unsubscribeInterfaceConfig()
  window.removeEventListener('hashchange', syncSectionFromHash)
  mobileNavigationMedia.removeEventListener('change', handleMobileNavigationChange)
  systemThemeMedia.removeEventListener('change', handleSystemThemeChange)
})
</script>
