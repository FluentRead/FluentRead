<!--
 * @file src/features/settings/ui/services/ServiceCatalog.vue
 * 文件职责：以服务目录和分层配置工作区呈现翻译服务，并独立管理服务启用状态与默认服务。
 * 主要内容：侧栏展示未移除的内置及自定义服务，提供移除按钮、独立的加回列表、搜索及分组折叠；目录搜索文本与几何按需缓存，活跃上下文限定操作并取消过期焦点、滚动与帧回调。
 * 模块边界：移除、加回与默认切换通过事件交给 SettingsSections 确认及持久化；公开构建隐藏 ChatGPT 登录模块，详细表单归 ServiceConfiguration.vue；折叠和加回列表是页面状态，卸载时清理观察器与监听。
 -->
<template>
  <section
    v-if="!publicPlanBlocked"
    class="service-catalog"
    aria-label="翻译服务配置"
    :data-default-service="defaultService"
    :data-editing-service="service"
  >
    <nav v-if="directoryGroups.length > 1" ref="groupNavigation" class="service-group-navigation settings-subnavigation" :aria-label="t('options.categories')">
      <button
        v-for="group in directoryGroups"
        :key="group.id"
        type="button"
        :data-service-group-link="group.id"
        :aria-current="activeGroup === group.id ? 'location' : undefined"
        :disabled="!active"
        :onClick="actions.revealGroup.bind(null, group.id)"
      >{{ group.label }}</button>
    </nav>
    <div class="catalog-layout">
      <aside class="service-rail" :class="{ 'is-expanded': directoryOpen }" :aria-label="t('settings.services.library.shortlist')">
        <button ref="directoryToggle" type="button" class="mobile-directory-toggle" :disabled="!active" :aria-expanded="directoryOpen" :aria-controls="directoryId" :onClick="actions.toggleDirectory">
          <ServiceIcon :service="isCustomOpenAIProviderId(service) ? 'custom' : service" :label="selectedService?.label" size="small" />
          <span class="mobile-directory-name">{{ selectedService?.label }}</span><small>{{ t('settings.organization.chooseService') }}</small>
          <UiIcon name="chevron-down" :size="16" />
        </button>
        <div :id="directoryId" class="service-directory-content">
        <div class="rail-heading">
          <div>
            <strong>{{ t('settings.services.library.shortlist') }}</strong>
            <span class="service-count">{{ allServices.length }}</span>
          </div>
          <el-tooltip :content="t('settings.services.library.addHelp')" placement="bottom" :show-after="250" :trigger="['hover', 'focus']" :disabled="!active || addServiceFeedbackVisible">
          <button ref="addButton" type="button" class="service-add-button" data-testid="custom-service-add" :disabled="!active" :aria-label="t('settings.services.library.add')" :onClick="actions.addService">
            <UiIcon name="plus" :size="15" />
            <span>{{ t('settings.services.library.add') }}</span>
          </button>
          </el-tooltip>
        </div>
        <slot name="add-service-status" />
        <button v-if="removedServices.length" type="button" class="service-restore-menu" data-service-restore-menu
          :aria-pressed="restoreOpen" :disabled="!active" :onClick="actions.toggleRestore">
          <UiIcon name="plus" :size="14" />{{ t('settings.services.library.restoreDirectory') }}
        </button>
        <label class="catalog-search">
          <UiIcon name="search" :size="16" />
          <input :value="serviceQuery" :disabled="!active" :onInput="actions.updateQuery" type="search" :aria-label="directorySearchLabel" :placeholder="directorySearchLabel" />
        </label>
        <div ref="groupsElement" class="service-groups" :onScrollPassive="actions.syncActiveGroup" :onWheelPassive="actions.releasePinnedGroup" :onTouchstartPassive="actions.releasePinnedGroup" :onPointerdown="actions.releasePinnedGroup" :onKeydown="actions.releasePinnedGroup" :onFocusin="actions.releasePinnedGroup">
          <template v-if="restoreOpen">
            <button v-for="item in matchingRemovedServices" :key="item.value" type="button" class="service-restore-item"
              :data-service-restore="item.value" :aria-label="t('settings.services.library.addNamedService', {service: item.label})"
              :disabled="!active" :onClick="actions.restoreService.bind(null, item.value)">
              <ServiceIcon :service="item.value" :label="item.label" size="small" />
              <span class="service-restore-label">{{ item.label }}</span><UiIcon name="plus" :size="16" />
            </button>
            <p v-if="!matchingRemovedServices.length" class="catalog-empty" role="status">{{ t('settings.services.library.empty') }}</p>
          </template>
          <template v-else>
          <section v-for="group in visibleDirectoryGroups" :key="group.id" :data-service-section="group.id" class="directory-section" :class="{ 'is-collapsed': !isGroupOpen(group.id) }">
            <h4>
              <button type="button" class="directory-section-toggle" :aria-expanded="isGroupOpen(group.id)" :aria-controls="`${directoryId}-${group.id}`" :disabled="!active || searching" :onClick="actions.toggleGroup.bind(null, group.id)">
                <span>{{ group.label }}</span><small>{{ group.items.length }}</small>
                <UiIcon v-if="!searching" class="directory-section-chevron" name="chevron-down" :size="14" />
              </button>
            </h4>
            <div v-show="isGroupOpen(group.id)" :id="`${directoryId}-${group.id}`" class="directory-items">
                <ServiceCatalogItem v-for="item in group.items" :key="item.value" :item="item"
                :selected="service === item.value" :is-default="defaultService === item.value"
                :is-configured="configuredSet.has(item.value)" :is-favorite="favoriteSet.has(item.value)"
                :remove-disabled="!active || item.disabled || enabledServiceCount <= 1"
                :onSelect="actions.selectService" :onRemove="actions.removeService" />
            </div>
          </section>
          <p v-if="!visibleDirectoryGroups.length" class="catalog-empty" role="status">{{ t('settings.services.library.empty') }}</p>
          </template>
        </div>
        </div>
      </aside>

      <section class="service-detail" aria-label="当前翻译服务详情">
        <div class="detail-hero">
          <ServiceIcon :service="isCustomOpenAIProviderId(service) ? 'custom' : service" :label="selectedService?.label" size="large" />
          <div class="detail-heading">
            <div class="detail-title-row">
              <h4 tabindex="-1">{{ selectedService?.label || '尚未配置服务' }}</h4>
              <ServiceNatureBadge :service="service" />
              <a
                v-if="website && !publicPlanBlocked"
                class="service-website-link"
                data-testid="service-website-link"
                :href="website.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="website.url"
                :aria-label="t('settings.services.openExternal', { service: selectedService?.label || service, action: t(`settings.services.${website.kind}`) })"
              >
                {{ t(`settings.services.${website.kind}`) }}
                <UiIcon name="external" :size="14" />
              </a>
            </div>
          </div>
          <div class="hero-service-actions">
            <button
              v-if="!publicPlanBlocked && (!isCompositeTranslationProviderId(service) || service !== defaultService)"
              type="button"
              class="service-default-button"
              data-set-default-service-button
              :disabled="!active || service === defaultService || !selectedService || selectedService.disabled"
              :onClick="actions.setDefaultService"
            >
              <UiIcon name="check" :size="16" />
              {{ t(service === defaultService ? 'settings.services.library.default' : 'settings.services.library.setDefault') }}
            </button>
            <div ref="connectionActionTarget" class="hero-connection-action" />
          </div>
        </div>

        <p v-if="!publicPlanBlocked && selectedService?.description && !credentialGuide && service !== 'freeTranslation' && !isCustomOpenAIProviderId(service)" class="service-description">{{ selectedService.description }}</p>

        <details
          v-if="credentialGuide && !publicPlanBlocked"
          :key="service"
          class="credential-guide"
          data-testid="service-credential-guide"
          aria-label="免费额度与开通步骤"
        >
          <summary class="credential-guide-summary">
            <span class="credential-guide-summary-copy">
              <span class="credential-guide-badge">{{ t('settings.organization.guide') }}</span>
              <strong>{{ credentialGuide.freeQuota }}</strong>
            </span>
            <UiIcon class="credential-guide-chevron" name="chevron-down" :size="16" />
          </summary>
          <div class="credential-guide-body">
            <small>免费额度与超额处理以厂商控制台和当前套餐为准</small>
            <ol class="credential-guide-steps">
              <li v-for="(step, index) in credentialGuide.steps" :key="index">{{ step }}</li>
            </ol>
            <div class="credential-guide-links">
              <a
                class="credential-guide-link is-primary"
                data-testid="service-credential-console"
                :href="credentialGuide.consoleUrl"
                target="_blank"
                rel="noopener noreferrer"
                :title="credentialGuide.consoleUrl"
              >
                {{ credentialGuide.consoleLabel }}
                <UiIcon name="external" :size="13" />
              </a>
              <a
                class="credential-guide-link"
                data-testid="service-credential-docs"
                :href="credentialGuide.docsUrl"
                target="_blank"
                rel="noopener noreferrer"
                :title="credentialGuide.docsUrl"
              >{{ credentialGuide.docsLabel }}</a>
            </div>
          </div>
        </details>

        <div v-if="!publicPlanBlocked && showModel && service !== 'localTranslation' && !isCompositeTranslationProviderId(service)" class="model-section">
          <div class="model-heading">
            <strong>模型</strong>
          </div>
          <ModelPicker :active="active" :context="props.context" :context-key="service"
            :options="modelOptions"
            :selected-model="selectedModel"
            :maximum-models="maximumModels"
            :maximum-model-length="maximumModelLength"
            :custom-model-count="customModelCount"
            :allow-custom-models="allowCustomModels"
            :onSelect="actions.selectModel"
            :onAdd="actions.addModel"
            :onRemove="actions.removeModel"
          />
        </div>

        <div class="service-configuration-slot" :class="{'local-model-configuration': service === 'localTranslation'}" aria-label="当前服务配置">
          <slot name="configuration" :connection-action-target="connectionActionTarget" />
        </div>

      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import '../components/settings-navigation.css'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import UiIcon from '@/src/ui/components/UiIcon.vue'
import ServiceNatureBadge from './ServiceNatureBadge.vue'
import { useUiI18n } from '@/src/ui/i18n'
import { isCustomOpenAIProviderId } from '@/src/core/config/customOpenAI'
import { isCompositeTranslationProviderId } from '@/src/core/config/compositeTranslation'
import {options as catalogOptions, services} from '@/src/core/config/catalog'
import {chatGPTPlanDevelopmentEnabled} from '@/src/platform/chatgpt-plan/buildMode'
import {
  buildServiceSections,
  type ServiceCredentialGuide,
  type ServiceOption,
  type ServiceWebsite,
} from '@/src/ui/view-model/serviceCatalog'
import ModelPicker from './ModelPicker.vue'
import ServiceCatalogItem from './ServiceCatalogItem.vue'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'

interface ModelPickerOption {
  value: string
  label?: string
  removable?: boolean
}

const props = withDefaults(defineProps<{
  active?: boolean
  addServiceFeedbackVisible?: boolean
  context?: unknown
  service: string
  defaultService: string
  website?: ServiceWebsite
  credentialGuide?: ServiceCredentialGuide
  selectedModel?: string
  services: ServiceOption[]
  favoriteServices: string[]
  disabledServices?: string[]
  configuredServices: string[]
  modelOptions: ModelPickerOption[]
  showModel: boolean
  maximumModels: number
  maximumModelLength: number
  customModelCount: number
  allowCustomModels: boolean
}>(), {active: true, addServiceFeedbackVisible: false, disabledServices: () => []})

const emit = defineEmits<{
  'update:service': [value: string]
  'update:default-service': [value: string]
  'toggle-availability': [service: string, enabled: boolean]
  'update:model': [value: string]
  'add:service': []
  'add:model': [value: string]
  'remove:model': [value: string]
}>()

const { t, translateLegacy } = useUiI18n()
const {active, capture} = useSettingsActionContext(() => props.active, () => [props.context, props.service])
const serviceQuery = ref('')
const directoryOpen = ref(false)
const restoreOpen = ref(false)
const directoryToggle = ref<HTMLButtonElement | null>(null)
const directoryId = useId()
const addButton = ref<HTMLButtonElement | null>(null)
const connectionActionTarget = ref<HTMLElement | null>(null)
const configuredSet = computed(() => new Set(props.configuredServices))
const favoriteSet = computed(() => new Set(props.favoriteServices))
const disabledServiceSet = computed(() => new Set(props.disabledServices))
const customServices = computed(() => props.services.filter((item) => isCustomOpenAIProviderId(item.value) || isCompositeTranslationProviderId(item.value)))
const builtInServices = computed(() => props.services.filter((item) => !isCustomOpenAIProviderId(item.value) && !isCompositeTranslationProviderId(item.value)
  && (item.value !== services.chatgptPlan || chatGPTPlanDevelopmentEnabled)))
const sections = computed(() => buildServiceSections(builtInServices.value))
const catalogGroups = computed(() => [
  ...sections.value.flatMap(section => section.groups.map(group => ({ ...group, label: group.label || section.label }))),
  ...(customServices.value.length ? [{ id: 'custom', label: t('settings.services.library.custom'), items: customServices.value }] : []),
])
const directoryGroups = computed(() => catalogGroups.value
  .map(group => ({...group, items: group.items.filter(item => !disabledServiceSet.value.has(item.value))}))
  .filter(group => group.items.length))
const allServices = computed(() => directoryGroups.value.flatMap(group => group.items))
const enabledServiceCount = computed(() => allServices.value.filter(item => !item.disabled).length)
const removedServices = computed(() => catalogGroups.value.flatMap(group => group.items)
  .filter(item => !item.disabled && disabledServiceSet.value.has(item.value)))
const directorySearchLabel = computed(() => t(restoreOpen.value ? 'common.search' : 'settings.services.library.search'))
// 延迟建立索引，空搜索不读取或规范化逐项文本；连续输入复用同一目录索引。
const directorySearchText = computed(() => new Map(catalogGroups.value.flatMap(group => group.items).map(item => [item,
  [item.label, item.value, item.description, ...(item.searchTerms || [])].join(' ').normalize('NFKC').toLocaleLowerCase(),
])))
const keyword = computed(() => serviceQuery.value.trim().normalize('NFKC').toLocaleLowerCase())
const matchesSearch = (item: ServiceOption) => !keyword.value || directorySearchText.value.get(item)!.includes(keyword.value)
const visibleDirectoryGroups = computed(() => {
  if (!keyword.value) return directoryGroups.value
  return directoryGroups.value
    .map(group => ({ ...group, items: group.items.filter(matchesSearch) }))
    .filter(group => group.items.length)
})
const matchingRemovedServices = computed(() => removedServices.value.filter(matchesSearch))
const selectedService = computed(() => allServices.value.find(item => item.value === props.service)
  || (props.service === services.chatgptPlan && chatGPTPlanDevelopmentEnabled ? (() => {
    const saved = catalogOptions.services.find(item => item.value === services.chatgptPlan)!
    return {...saved, label: translateLegacy(saved.label)}
  })() : undefined))
const publicPlanBlocked = computed(() => props.service === services.chatgptPlan && !chatGPTPlanDevelopmentEnabled)
const searching = computed(() => Boolean(serviceQuery.value.trim()))
const groupsElement = ref<HTMLElement | null>(null)
const collapsedGroups = ref<ReadonlySet<string>>(new Set())
const activeGroup = ref('')
const groupNavigation = ref<HTMLElement | null>(null)
// 与连续表单导航一致：长语言标签横向滚动时，当前分组保持在导航可见范围内。
watch(activeGroup, async () => {
  const current = capture()
  await nextTick()
  const nav = groupNavigation.value
  const button = nav?.querySelector<HTMLElement>('[aria-current]')
  if (!current() || !nav || !button || !nav.getClientRects().length) return
  const navRect = nav.getBoundingClientRect()
  const buttonRect = button.getBoundingClientRect()
  if (buttonRect.left < navRect.left || buttonRect.right > navRect.right) {
    nav.scrollTo({left: nav.scrollLeft + buttonRect.left - navRect.left - (nav.clientWidth - buttonRect.width) / 2, behavior: 'instant'})
  }
})
// 末尾的短分组无法滚到目录顶部；点击导航后保持指向目标，直到用户自己操作目录。
let pinnedGroup = ''

// 搜索时展开全部匹配分组，避免结果藏在已收起的分组里。
function isGroupOpen(id: string): boolean {
  return searching.value || !collapsedGroups.value.has(id)
}
function setGroupOpen(id: string, open: boolean): void {
  if (collapsedGroups.value.has(id) === !open) return
  const next = new Set(collapsedGroups.value)
  if (open) next.delete(id)
  else next.add(id)
  collapsedGroups.value = next
}
function toggleGroup(id: string): void {
  if (!active.value || searching.value || !directoryGroups.value.some(group => group.id === id)) return
  setGroupOpen(id, !isGroupOpen(id))
}
function expandGroupOf(service: string): void {
  if (!active.value) return
  const group = directoryGroups.value.find(candidate => candidate.items.some(item => item.value === service))
  if (group) setGroupOpen(group.id, true)
}
interface DirectoryLayout {
  scroller: HTMLElement
  groups: {id: string; top: number}[]
  viewportHeight: number
  scrollHeight: number
}
let directoryLayout: DirectoryLayout | undefined
let directoryLayoutDirty = true
let directoryFrame: number | undefined
let directoryFrameRevision = 0
let pendingGroupReveal: {id: string; current: () => boolean} | undefined
let directoryVisible = false
let directoryObserver: ResizeObserver | undefined
let observedSections = new Set<HTMLElement>()
let stopFontObserver: (() => void) | undefined

function releasePinnedGroup(): void {
  pinnedGroup = ''
  pendingGroupReveal = undefined
  // 用户接管时可能已在滚动边界，仍要按当前位置恢复高亮，不依赖下一次 scroll。
  scheduleDirectoryFrame()
}
// 所有布局读取都在同一帧完成；滚动事件仅排队，复用结构/尺寸变化时缓存的相对位置。
function scheduleDirectoryFrame(refreshLayout = false): void {
  const current = capture(), scroller = groupsElement.value
  if (!current() || !scroller) return
  directoryLayoutDirty ||= refreshLayout
  if (directoryFrame !== undefined) return
  const revision = ++directoryFrameRevision
  directoryFrame = requestAnimationFrame(() => {
    // 取消后浏览器仍可能交付旧回调；不能清掉新上下文已经排队的帧。
    if (revision !== directoryFrameRevision) return
    directoryFrame = undefined
    if (!current() || groupsElement.value !== scroller || !directoryObserver) return
    updateDirectoryFrame(scroller, current)
  })
}
function updateDirectoryFrame(scroller: HTMLElement, current: () => boolean): void {
  const scrollTop = scroller.scrollTop
  if (directoryLayoutDirty || directoryLayout?.scroller !== scroller) {
    directoryLayoutDirty = false
    const visible = scroller.getClientRects().length > 0
    const becameVisible = visible && !directoryVisible
    directoryVisible = visible
    if (!visible) {
      directoryLayout = {scroller, groups: [], viewportHeight: 0, scrollHeight: 0}
      pendingGroupReveal = undefined
      return
    }
    if (becameVisible) {
      const previous = collapsedGroups.value
      expandGroupOf(props.service)
      if (previous !== collapsedGroups.value) {
        // 展开先交给 Vue 更新 v-show，再在下一帧读取新高度。
        directoryLayout = undefined
        void nextTick(() => {if (current()) scheduleDirectoryFrame(true)})
        return
      }
    }
    const elements = [...scroller.querySelectorAll<HTMLElement>('[data-service-section]')]
    const scrollerTop = scroller.getBoundingClientRect().top
    directoryLayout = {
      scroller,
      groups: elements.map(element => ({id: element.dataset.serviceSection || '', top: scrollTop + element.getBoundingClientRect().top - scrollerTop})),
      viewportHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    }
    // 固定高度容器不会因内部字体/行数改变而缩放，分组本身也必须观察。
    const next = new Set(elements)
    observedSections.forEach(element => {if (!next.has(element)) directoryObserver?.unobserve(element)})
    next.forEach(element => {if (!observedSections.has(element)) directoryObserver?.observe(element)})
    observedSections = next
  }
  const layout = directoryLayout
  if (!directoryVisible || !layout) return
  const reveal = pendingGroupReveal
  pendingGroupReveal = undefined
  if (reveal?.current()) {
    const target = layout.groups.find(group => group.id === reveal.id)
    if (target) scroller.scrollTo({
      top: target.top,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  }
  if (layout.groups.some(group => group.id === pinnedGroup)) {
    activeGroup.value = pinnedGroup
    return
  }
  let selected = layout.groups[0]?.id || ''
  if (scrollTop > 0 && scrollTop + layout.viewportHeight >= layout.scrollHeight - 2) {
    selected = layout.groups.at(-1)?.id || ''
  } else {
    layout.groups.forEach(group => {if (group.top <= scrollTop + 8) selected = group.id})
  }
  activeGroup.value = selected
}
function syncActiveGroup(): void {
  scheduleDirectoryFrame()
}
async function revealGroup(id: string) {
  const current = capture()
  if (!current() || !directoryGroups.value.some(group => group.id === id)) return
  // 导航始终列出全部分组；搜索中点击即回到完整目录。
  restoreOpen.value = false
  serviceQuery.value = ''
  setGroupOpen(id, true)
  pinnedGroup = id
  activeGroup.value = id
  await nextTick()
  if (!current() || pinnedGroup !== id) return
  pendingGroupReveal = {id, current}
  scheduleDirectoryFrame(true)
}
// 同步执行，保证 revealGroup 清空搜索后设置的目标不会被随后的回调清掉。
watch(serviceQuery, releasePinnedGroup, {flush: 'sync'})
// post 时模板的搜索/v-show 已更新，只把本帧布局标为失效，避免重复 nextTick 测量。
function scheduleActiveGroupSync(): void {
  scheduleDirectoryFrame(true)
}
watch([visibleDirectoryGroups, collapsedGroups, directoryOpen, restoreOpen], scheduleActiveGroupSync, {flush: 'post'})
function stopDirectoryObserver(): void {
  directoryFrameRevision += 1
  if (directoryFrame !== undefined) cancelAnimationFrame(directoryFrame)
  directoryFrame = undefined
  directoryLayout = undefined
  directoryLayoutDirty = true
  pendingGroupReveal = undefined
  const previous = directoryObserver
  directoryObserver = undefined
  directoryVisible = false
  observedSections = new Set()
  previous?.disconnect()
  stopFontObserver?.()
  stopFontObserver = undefined
}
function refreshDirectoryObserver(): void {
  stopDirectoryObserver()
  const current = capture(), scroller = groupsElement.value
  if (!current() || !scroller) return
  expandGroupOf(props.service)
  const refresh = () => {
    if (current() && directoryObserver === observer) scheduleDirectoryFrame(true)
  }
  const observer = new ResizeObserver(refresh)
  directoryObserver = observer
  observer.observe(scroller)
  // 字体加载完成可能改变条目换行；复用相同帧队列并拒绝旧页面的迟到事件。
  const fonts = typeof document === 'undefined' ? undefined : document.fonts
  fonts?.addEventListener('loadingdone', refresh)
  stopFontObserver = () => fonts?.removeEventListener('loadingdone', refresh)
  scheduleDirectoryFrame(true)
}
onMounted(refreshDirectoryObserver)
watch(() => [active.value, props.context, props.service], refreshDirectoryObserver, {flush: 'post'})
onBeforeUnmount(stopDirectoryObserver)

let pendingConfigurationReset: {current: () => boolean; restoreFocus: boolean} | undefined
function resetConfigurationScroll(restoreDirectoryFocus: boolean): void {
  if (pendingConfigurationReset?.current()) {
    pendingConfigurationReset.restoreFocus ||= restoreDirectoryFocus
    return
  }
  const pending = {current: capture(), restoreFocus: restoreDirectoryFocus}
  pendingConfigurationReset = pending
  // 同服务事件可能没有待渲染变更；再等一轮，让父层本批 active/context 更新先提交。
  void nextTick().then(() => nextTick(() => {
    if (pendingConfigurationReset !== pending) return
    pendingConfigurationReset = undefined
    if (!pending.current()) return
    if (pending.restoreFocus) directoryToggle.value?.focus({preventScroll: true})
    // 窄屏滚动区是整个工作区，桌面滚动区是详情；两者都从配置入口开始。
    const workspace = addButton.value?.closest<HTMLElement>('.catalog-layout')
    workspace?.scrollTo({top: 0, behavior: 'instant'})
    workspace?.querySelector<HTMLElement>('.service-detail')?.scrollTo({top: 0, behavior: 'instant'})
  }))
}
// 重新进入缓存页才回到关键字段；活跃时替换配置属于表单编辑，应保留阅读位置。
watch(active, (enabled, previous) => {
  if (enabled && !previous) resetConfigurationScroll(false)
}, {flush: 'post'})
function selectService(service: string): void {
  if (!active.value || !allServices.value.some(item => item.value === service && !item.disabled)) return
  expandGroupOf(service)
  if (service === props.service) {
    const restoreFocus = directoryOpen.value
    directoryOpen.value = false
    resetConfigurationScroll(restoreFocus)
    return
  }
  emit('update:service', service)
}
function setDefaultService(): void {
  if (!active.value || publicPlanBlocked.value || props.service === props.defaultService || !selectedService.value || selectedService.value.disabled) return
  emit('update:default-service', props.service)
}
const actions = computed(() => {
  const current = capture()
  return {
    selectService: (value: string) => {if (current()) selectService(value)},
    removeService: (service: string) => {
      if (current() && enabledServiceCount.value > 1 && allServices.value.some(item => item.value === service && !item.disabled)) emit('toggle-availability', service, false)
    },
    restoreService: (service: string) => {
      if (current() && restoreOpen.value && removedServices.value.some(item => item.value === service)) emit('toggle-availability', service, true)
    },
    toggleRestore: () => {
      if (!current() || !removedServices.value.length) return
      restoreOpen.value = !restoreOpen.value
      serviceQuery.value = ''
      groupsElement.value?.scrollTo({top: 0, behavior: 'instant'})
    },
    setDefaultService: () => {if (current()) setDefaultService()},
    revealGroup: (id: string) => {if (current()) return revealGroup(id)},
    toggleGroup: (id: string) => {if (current()) toggleGroup(id)},
    syncActiveGroup: () => {if (current()) syncActiveGroup()},
    releasePinnedGroup: () => {if (current()) releasePinnedGroup()},
    toggleDirectory: () => {if (current()) directoryOpen.value = !directoryOpen.value},
    updateQuery: (event: Event) => {const value = (event.currentTarget as HTMLInputElement | null)?.value;if (current() && typeof value === 'string') serviceQuery.value = value},
    addService: () => {if (current()) emit('add:service')},
    selectModel: (value: string) => {if (current()) emit('update:model', value)},
    addModel: (value: string) => {if (current()) emit('add:model', value)},
    removeModel: (value: string) => {if (current()) emit('remove:model', value)},
  }
})
watch(() => [active.value, props.context], () => {directoryOpen.value = false;restoreOpen.value = false;serviceQuery.value = '';pinnedGroup = ''}, {flush: 'sync'})
watch(removedServices, items => {if (!items.length) restoreOpen.value = false}, {flush: 'sync'})
// 外部跳转和新建服务沿用同一编辑工作区，并从表单顶部开始。
watch(() => props.service, (service) => {
  expandGroupOf(service)
  const restoreDirectoryFocus = directoryOpen.value
  directoryOpen.value = false
  resetConfigurationScroll(restoreDirectoryFocus)
}, {flush: 'sync'})

</script>

<style scoped>
.service-catalog { display: flex; flex-direction: column; height: min(650px, 70dvh); min-height: 0; color: var(--ink, #172033); background: transparent; }
.service-group-navigation { margin: 0 var(--settings-navigation-inset, 12px) var(--settings-navigation-gap, 18px); }
.catalog-layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 0; flex: 1; overflow: hidden; background: var(--surface, #fff); }
.service-rail { display: flex; flex-direction: column; min-height: 0; padding: 12px 10px; border-right: 1px solid var(--line, #e4e7ef); background: var(--surface-soft, #fafbfc); }
.rail-heading { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 6px 10px; }
.rail-heading > div { display: flex; flex: none; align-items: baseline; gap: 5px; min-width: 0; }
.rail-heading strong { color: var(--ink, #172033); font-size: 13px; font-weight: 700; }
.service-add-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 34px; padding: 7px 11px; border: 1.5px solid color-mix(in srgb, var(--brand) 65%, var(--line)); border-radius: 10px; color: var(--brand-strong); background: var(--surface); font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s; }
.service-add-button:hover, .service-add-button:focus-visible { border-color: var(--brand); background: var(--brand-soft); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 10%, transparent); }
.service-restore-menu { display: flex; flex-shrink: 0; align-self: flex-end; align-items: center; gap: 4px; min-height: 30px; padding: 3px 8px; margin-bottom: 4px; border: 0; border-radius: 6px; background: transparent; color: var(--brand-strong); font-size: 12px; cursor: pointer; }
.service-restore-menu:hover, .service-restore-menu[aria-pressed="true"] { background: var(--brand-soft); }
.service-restore-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--ink); font: inherit; font-size: 13px; text-align: start; cursor: pointer; }
.service-restore-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.service-restore-item:hover { background: var(--brand-soft); }

.service-count { margin-left: 4px; font-variant-numeric: tabular-nums; }
.service-groups { overflow-y: auto; min-height: 0; flex: 1; margin-top: 12px; overscroll-behavior: contain; }
.directory-items { display: grid; gap: 1px; }
.service-detail { container: service-detail / inline-size; display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 0; padding: 20px; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; border: 0; border-radius: 0; background: var(--surface); overscroll-behavior: contain; }
.detail-hero { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.detail-hero > :deep(.service-icon) { margin-top: 2px; }
.detail-heading { flex: 1 1 160px; min-width: 0; }
.hero-service-actions { display: flex; align-items: stretch; flex-wrap: wrap; gap: 8px; max-width: 100%; margin-left: auto; }
.hero-connection-action { display: flex; min-width: 0; }
.service-default-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; max-width: 100%; min-height: 36px; padding: 7px 12px; border: 1px solid var(--brand-border, #f3c0ce); border-radius: 8px; color: var(--brand-strong, #bd2853); background: var(--surface, #fff); font-size: 12px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; cursor: pointer; }
.service-default-button > svg { flex: none; }
.service-default-button:hover:not(:disabled) { border-color: var(--brand); background: var(--brand-soft); }
.service-default-button:disabled { border-color: var(--line); color: var(--muted); cursor: default; }
@container service-detail (max-width: 600px) {
  .hero-service-actions { width: 100%; margin-left: 0; }
}
.detail-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.detail-title-row h4 { margin: 0; font-size: 20px; line-height: 1.4; overflow-wrap: anywhere; }
.detail-hero p { margin: 5px 0 0; color: var(--muted, #737c8f); font-size: 12px; line-height: 1.6; }
.service-description { max-width: 760px; margin: 0 0 12px; color: var(--muted, #737c8f); font-size: 12px; line-height: 1.65; }
.service-website-link { display: inline-flex; align-items: center; gap: 4px; color: var(--brand-strong); font-size: 12px; font-weight: 550; text-decoration: none; }
.service-website-link:hover { color: var(--brand-strong, #bd2853); text-decoration: underline; }
.model-section { display: grid; grid-template-columns: var(--fr-service-label-width, 140px) minmax(0, 1fr); align-items: center; gap: var(--fr-service-column-gap, 16px); padding: 0 0 12px; margin: 0 0 12px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; flex-shrink: 0; }
.model-section > :deep(.model-picker) { width: 100%; max-width: 640px; justify-self: start; }
.model-heading strong { font-size: 13px; font-weight: 550; }
.service-configuration-slot { flex-shrink: 0; padding-bottom: 12px; }
.catalog-search { flex-shrink: 0; display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 10px; border: 1px solid var(--line, #dfe3eb); border-radius: 8px; color: var(--muted, #737c8f); background: var(--surface, #fff); }
.catalog-search:focus-within { border-color: var(--brand-strong, #bd2853); }
.catalog-search input { width: 100%; min-width: 0; padding: 9px 0; border: 0; outline: none; color: var(--ink, #172033); background: transparent; font-size: 13px; }
.directory-section + .directory-section { margin-top: 12px; }
.directory-section.is-collapsed + .directory-section { margin-top: 8px; }
.directory-section h4 { margin: 0 0 6px; }
.directory-section.is-collapsed h4 { margin-bottom: 0; }
.directory-section-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 0; border-bottom: 1px solid var(--line); border-radius: 8px 8px 0 0; background: color-mix(in srgb, var(--line) 22%, transparent); color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.directory-section-toggle:disabled { cursor: default; }
.directory-section-toggle:focus-visible { outline-offset: -2px; }
.directory-section-toggle:not(:disabled):hover { background: color-mix(in srgb, var(--line) 40%, transparent); }
.directory-section-toggle > span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.directory-section-toggle small { color: var(--muted); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; }
.directory-section-chevron { color: var(--muted); transform: rotate(-90deg); transition: transform 150ms ease; }
.directory-section-toggle[aria-expanded="true"] .directory-section-chevron { transform: none; }
.directory-section.is-collapsed .directory-section-toggle { border-radius: 8px; }
@media (prefers-reduced-motion: reduce) { .directory-section-chevron { transition: none; } }
.catalog-empty { padding: 32px 0; color: var(--muted, #737c8f); text-align: center; font-size: 13px; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }
.credential-guide { margin: 0 0 12px; border: 0; border-radius: 10px; background: var(--surface-soft, #fff8fa); }
.credential-guide-summary { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 10px 12px; cursor: pointer; list-style: none; }
.credential-guide-summary::-webkit-details-marker { display: none; }
.credential-guide-summary-copy { display: flex; min-width: 0; align-items: center; gap: 8px; }
.credential-guide-summary-copy strong { min-width: 0; overflow-wrap: anywhere; color: #172033; font-size: 13px; }
.credential-guide-summary-action { margin-left: auto; color: var(--brand-strong, #bd2853); font-size: 11px; white-space: nowrap; }
.credential-guide-chevron { margin-left: auto; width: 16px; height: 16px; flex: none; color: var(--muted, #8991a2); transition: transform 150ms ease; }
.credential-guide[open] .credential-guide-chevron { transform: rotate(180deg); }
.credential-guide-body { display: grid; gap: 12px; padding: 14px 16px 16px; border-top: 1px solid var(--line); }
.credential-guide-body > small { color: var(--muted); font-size: 12px; line-height: 1.5; }
.credential-guide-badge { flex-shrink: 0; padding: 3px 8px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.credential-guide-steps { display: grid; gap: 6px; margin: 0; padding-left: 20px; color: var(--ink); font-size: 12px; line-height: 1.6; }
.credential-guide-steps li::marker { color: #c72a56; font-weight: 800; }
.credential-guide-links { display: flex; flex-wrap: wrap; gap: 8px; }
.credential-guide-link { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 12px; border: 1px solid #e2e5ec; border-radius: 9px; color: #46526a; background: #fff; font-size: 12px; font-weight: 650; text-decoration: none; transition: 150ms ease; }
.credential-guide-link:hover { border-color: #f3c4d1; color: var(--brand-strong, #bd2853); background: var(--brand-soft, #fff0f4); }
.credential-guide-link.is-primary { border-color: var(--brand-border, #f3c0ce); color: var(--brand-strong); background: var(--brand-soft); }
.credential-guide-link.is-primary:hover { color: #fff; background: var(--brand-strong, #bd2853); filter: brightness(.92); box-shadow: 0 6px 16px rgba(214, 50, 96, .18); }
.credential-guide-link:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }

:global(:root.dark .credential-guide) { border-color: var(--line); background: var(--surface-soft); }
:global(:root.dark .credential-guide-summary-copy strong), :global(:root.dark .credential-guide-steps) { color: var(--ink); }
:global(:root.dark .credential-guide-body) { border-color: var(--line); }
:global(:root.dark .credential-guide-link) { border-color: var(--line); color: var(--ink); background: var(--surface); }
:global(:root.dark .credential-guide-link.is-primary) { color: var(--brand-strong); background: var(--brand-soft); }
@media (max-width: 1100px) {
  .catalog-layout { grid-template-columns: 220px minmax(0, 1fr); }
  .service-rail { padding-inline: 4px; }
  .service-detail { padding: 16px; }
  .model-section { grid-template-columns: 1fr; gap: 8px; }
}
@media (max-width: 700px) {
  .service-catalog { height: auto; min-height: 0; }
  .service-group-navigation { display: none; }
  .catalog-layout { display: block; }
  .service-rail { border-right: 0; border-bottom: 1px solid var(--line, #e4e7ef); padding: 10px 12px; }
  .rail-heading { margin-bottom: 6px; }
  .service-groups { min-height: 80px; }
  .directory-items { grid-template-columns: minmax(0, 1fr); }
  .service-detail { margin: 0; padding: 14px; border: 0; border-radius: 0; overflow: visible; }
  .detail-hero { flex-wrap: wrap; gap: 10px; }
  .detail-title-row h4 { font-size: 18px; }
  .model-section { grid-template-columns: 1fr; gap: 7px; }

}
@media (min-width: 701px) and (max-width: 1250px) { .model-section { grid-template-columns: 1fr; gap: 8px; } }
@media (max-width: 700px) { .credential-guide-summary-copy { align-items: flex-start; flex-direction: column; gap: 6px; } }
.service-directory-content { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.mobile-directory-toggle { display: none; }
@media (max-width: 700px) {
  .mobile-directory-toggle { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 44px; padding: 6px 2px; border: 0; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
  .mobile-directory-name { min-width: 0; flex: 1; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .mobile-directory-toggle > small { color: var(--brand-strong); font-size: 12px; }
  .mobile-directory-toggle > svg { flex: none; width: 16px; height: 16px; }
  .mobile-directory-toggle[aria-expanded="true"] > svg { transform: rotate(180deg); }
  .service-rail:not(.is-expanded) .service-directory-content { display: none; }
  .service-rail.is-expanded .service-directory-content { height: 280px; max-height: 40dvh; padding-top: 12px; flex: none; }
  .service-groups { max-height: 240px; }
  .hero-service-actions { margin-left: 0; }
  .detail-hero { margin-bottom: 12px; padding-bottom: 12px; }
}
@media (max-width: 700px), (any-pointer: coarse) {
  .service-add-button { min-width: 44px; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
}
</style>
