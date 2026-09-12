<!--
 * @file src/features/settings/ui/AlwaysTranslateSites.vue
 * 文件职责：实现“始终翻译”、“禁用扩展”与“不显示悬浮球”三类网站名单编辑器，接收域名数组并通过 v-model 更新规范化后的规则集合。
 * 主要内容：组件按 variant 选择成套文案与图标，解析用户输入或当前站点为 eTLD+1 基础域名，处理重复、无效域名、添加反馈、删除与输入聚焦，并展示网站数量和空状态。
 * 模块边界：它不直接读取当前标签页、不持久化配置也不决定规则优先级；调用方提供 currentDomain 和 labels，域名算法来自 core/site-rules，保存由 SettingsSections 统一触发。
 -->
<template>
  <section
    class="site-rules-editor"
    :data-setting="labels.settingId"
    :aria-labelledby="labels.titleId"
  >
    <header class="site-rules-heading">
      <div>
        <h3 :id="labels.titleId">{{ labels.title }}</h3>
        <p>{{ labels.description }}</p>
      </div>
      <span class="site-rules-count" :aria-label="labels.countLabel">{{ t('settings.sites.count', {count: domains.length}) }}</span>
    </header>

    <form class="site-rules-form" @submit.prevent="addDomain">
      <label class="site-rules-input-wrap">
        <span class="sr-only">{{ labels.inputLabel }}</span>
        <input
          ref="domainInput"
          v-model.trim="inputValue"
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          :aria-label="labels.inputLabel"
          :placeholder="labels.placeholder"
          :aria-invalid="Boolean(errorMessage)"
          :aria-describedby="labels.feedbackId"
          @input="clearFeedback"
        />
      </label>
      <button class="site-rules-add" type="submit">{{ labels.addButton }}</button>
    </form>

    <p :id="labels.feedbackId" class="site-rules-feedback" :class="{ error: errorMessage }" aria-live="polite">
      <template v-if="errorMessage">{{ errorMessage }}</template>
      <template v-else-if="statusMessage">{{ statusMessage }}</template>
      <template v-else-if="normalizedPreview">将保存为 <strong>{{ normalizedPreview }}</strong>，并包含所有子域。</template>
      <template v-else>支持粘贴完整 URL；端口、路径和参数不会进入规则。</template>
    </p>

    <div v-if="domains.length" class="site-rules-list" role="list" :aria-label="labels.listLabel">
      <article
        v-for="domain in domains"
        :key="domain"
        class="site-rule-item"
        role="listitem"
        :data-site-rule="domain"
      >
        <span class="site-rule-icon" aria-hidden="true"><UiIcon :name="iconName" /></span>
        <span class="site-rule-copy">
          <strong :title="domain">{{ domain }}</strong>
          <small>{{ labels.itemDescription }}</small>
        </span>
        <button class="site-rule-remove" type="button" :aria-label="`删除 ${domain}`" @click="removeDomain(domain)">
          删除
        </button>
      </article>
    </div>

    <div v-else class="site-rules-empty" data-site-rules-empty>
      <span aria-hidden="true"><UiIcon name="globe" :size="24" /></span>
      <strong>{{ labels.emptyTitle }}</strong>
      <small>{{ labels.emptyDescription }}</small>
    </div>
  </section>
</template>

<script lang="ts" setup>
import UiIcon from '@/src/ui/components/UiIcon.vue'
import { computed, nextTick, ref } from 'vue';
import { getSiteBaseDomain } from '@/src/core/site-rules/domain';
import {useUiI18n} from '@/src/ui/i18n';

type SiteRulesVariant = 'always-translate' | 'disable-extension' | 'disable-floating-ball';

interface SiteRulesLabels {
  settingId: string;
  titleId: string;
  feedbackId: string;
  title: string;
  description: string;
  countLabel: string;
  inputLabel: string;
  placeholder: string;
  addButton: string;
  listLabel: string;
  iconName: string;
  itemDescription: string;
  emptyTitle: string;
  emptyDescription: string;
  duplicateMessage: (domain: string) => string;
  addedMessage: (domain: string) => string;
  removedMessage: (domain: string) => string;
}

const props = withDefaults(defineProps<{
  modelValue?: string[];
  variant?: SiteRulesVariant;
}>(), {
  modelValue: () => [],
  variant: 'always-translate',
});

const emit = defineEmits<{
  'update:modelValue': [value: string[]];
}>();

const {t} = useUiI18n();
const inputValue = ref('');
const errorMessage = ref('');
const statusMessage = ref('');
const domainInput = ref<HTMLInputElement | null>(null);
const domains = computed(() => props.modelValue ?? []);
const normalizedPreview = computed(() => inputValue.value ? getSiteBaseDomain(inputValue.value) : null);
const VARIANT_LABELS: Record<SiteRulesVariant, SiteRulesLabels> = {
  'disable-extension': {
    settingId: 'disabled-extension-sites',
    titleId: 'disabled-extension-sites-title',
    feedbackId: 'disabled-extension-sites-feedback',
    title: '禁用扩展网站',
    description: '输入任意域名或网址，保存时统一归并到主域名；该网站及其所有子域都不会运行扩展功能。',
    countLabel: '禁用扩展网站数量',
    inputLabel: '添加禁用扩展网站',
    placeholder: '例如：https://docs.example.com/article',
    addButton: '添加网站',
    listLabel: '禁用扩展网站名单',
    iconName: 'shield',
    itemDescription: '该主域名及其所有子域不会运行扩展功能',
    emptyTitle: '还没有禁用扩展的网站',
    emptyDescription: '可从上方手动添加，也可在扩展弹窗中为当前网站快速禁用。',
    duplicateMessage: (domain: string) => `${domain} 已在禁用扩展名单中。`,
    addedMessage: (domain: string) => `已添加 ${domain}。`,
    removedMessage: (domain: string) => `已删除 ${domain}。`,
  },
  'disable-floating-ball': {
    settingId: 'disabled-floating-ball-sites',
    titleId: 'disabled-floating-ball-sites-title',
    feedbackId: 'disabled-floating-ball-sites-feedback',
    title: '不显示悬浮球的网站',
    description: '输入任意域名或网址，保存时统一归并到主域名；该网站及其所有子域不显示悬浮球，快捷键、右键菜单和其他功能仍然可用。',
    countLabel: '不显示悬浮球的网站数量',
    inputLabel: '添加不显示悬浮球的网站',
    placeholder: '例如：https://mail.example.com/inbox',
    addButton: '添加网站',
    listLabel: '不显示悬浮球的网站名单',
    iconName: 'close',
    itemDescription: '该主域名及其所有子域不显示悬浮球',
    emptyTitle: '所有网站都会显示悬浮球',
    emptyDescription: '在阅读工具、邮箱或编辑器等界面密集的网站上，可以只隐藏悬浮球而保留其他功能。',
    duplicateMessage: (domain: string) => `${domain} 已在不显示悬浮球名单中。`,
    addedMessage: (domain: string) => `已添加 ${domain}。`,
    removedMessage: (domain: string) => `已删除 ${domain}。`,
  },
  'always-translate': {
    settingId: 'always-translate-sites',
    titleId: 'always-translate-sites-title',
    feedbackId: 'always-translate-sites-feedback',
    title: '始终翻译网站',
    description: '输入任意域名或网址，保存时统一归并到主域名，并对它的所有子域生效。',
    countLabel: '始终翻译网站数量',
    inputLabel: '添加始终翻译网站',
    placeholder: '例如：https://docs.example.com/article',
    addButton: '添加网站',
    listLabel: '始终翻译网站名单',
    iconName: 'globe',
    itemDescription: '该主域名及其所有子域会自动翻译',
    emptyTitle: '还没有始终翻译的网站',
    emptyDescription: '可从上方手动添加，也可在扩展弹窗中为当前网站快速开启。',
    duplicateMessage: (domain: string) => `${domain} 已在始终翻译名单中。`,
    addedMessage: (domain: string) => `已添加 ${domain}。`,
    removedMessage: (domain: string) => `已删除 ${domain}。`,
  },
};

const labels = computed(() => VARIANT_LABELS[props.variant] ?? VARIANT_LABELS['always-translate']);
const iconName = computed(() => labels.value.iconName);

function clearFeedback() {
  errorMessage.value = '';
  statusMessage.value = '';
}

function addDomain() {
  const input = inputValue.value.trim();
  if (!input) {
    errorMessage.value = '请输入域名或网址。';
    return;
  }

  const domain = getSiteBaseDomain(input);
  if (!domain) {
    errorMessage.value = '无法识别有效的网站主域名，请检查输入内容。';
    return;
  }
  if (domains.value.includes(domain)) {
    errorMessage.value = labels.value.duplicateMessage(domain);
    return;
  }

  emit('update:modelValue', [...domains.value, domain]);
  inputValue.value = '';
  errorMessage.value = '';
  statusMessage.value = labels.value.addedMessage(domain);
}

function removeDomain(domain: string) {
  emit('update:modelValue', domains.value.filter(item => item !== domain));
  errorMessage.value = '';
  statusMessage.value = labels.value.removedMessage(domain);
  void nextTick(() => domainInput.value?.focus());
}
</script>

<style scoped>
.site-rules-editor {
  width: min(100%, 1080px);
  margin: 0 auto 16px;
  padding: 20px;
  border: 1px solid var(--line, #e5e8ef);
  border-radius: 20px;
  background: var(--surface-soft, #f7f8fb);
}

.site-rules-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.site-rules-heading > div {
  min-width: 0;
}

.site-rules-heading h3 {
  margin: 0 0 6px;
  color: var(--ink, #172033);
  font-size: 18px;
}

.site-rules-heading p {
  margin: 0;
  color: var(--muted, #737c8f);
  font-size: 11px;
  line-height: 1.55;
}

.site-rules-count {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(239, 71, 118, .2);
  border-radius: 999px;
  color: var(--brand-strong, #dc315f);
  background: var(--brand-soft, #fff0f4);
  font-size: 10px;
  font-weight: 750;
}

.site-rules-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  margin-top: 18px;
}

.site-rules-input-wrap {
  min-width: 0;
}

.site-rules-input-wrap input {
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid #dfe4ed;
  border-radius: 13px;
  outline: 0;
  color: var(--ink, #172033);
  background: var(--surface, #fff);
  font-size: 13px;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.site-rules-input-wrap input:hover {
  border-color: #ef9ab1;
}

.site-rules-input-wrap input:focus {
  border-color: var(--brand, #ef4776);
  box-shadow: 0 0 0 4px rgba(239, 71, 118, .1);
}

.site-rules-input-wrap input[aria-invalid="true"] {
  border-color: #d9345e;
}

.site-rules-input-wrap input::placeholder {
  color: #9299a8;
}

.site-rules-add,
.site-rule-remove {
  border-radius: 12px;
  font-weight: 750;
  cursor: pointer;
}

.site-rules-add {
  min-width: 92px;
  min-height: 44px;
  padding: 0 15px;
  border: 0;
  color: #fff;
  background: linear-gradient(135deg, #f35482, #e93267);
  box-shadow: 0 8px 18px rgba(233, 50, 103, .18);
}

.site-rules-add:hover {
  box-shadow: 0 10px 22px rgba(233, 50, 103, .26);
  transform: translateY(-1px);
}

.site-rules-feedback {
  min-height: 18px;
  margin: 7px 2px 0;
  color: var(--muted, #737c8f);
  font-size: 10px;
  line-height: 1.5;
}

.site-rules-feedback strong {
  color: var(--ink, #172033);
}

.site-rules-feedback.error {
  color: #d9345e;
}

.site-rules-list {
  display: grid;
  gap: 8px;
  max-height: 360px;
  margin-top: 14px;
  padding-right: 3px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.site-rule-item {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  min-height: 62px;
  padding: 10px 11px;
  border: 1px solid var(--line, #e5e8ef);
  border-radius: 15px;
  background: var(--surface, #fff);
}

.site-rule-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  color: var(--brand-strong, #dc315f);
  background: var(--brand-soft, #fff0f4);
  font-size: 13px;
  font-weight: 800;
}

.site-rule-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.site-rule-copy strong {
  overflow: hidden;
  color: var(--ink, #172033);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.site-rule-copy small {
  color: var(--muted, #737c8f);
  font-size: 10px;
}

.site-rule-remove {
  min-height: 32px;
  padding: 0 11px;
  border: 1px solid var(--line, #e5e8ef);
  color: var(--brand-strong, #dc315f);
  background: transparent;
  font-size: 10px;
}

.site-rule-remove:hover {
  border-color: rgba(239, 71, 118, .35);
  background: var(--brand-soft, #fff0f4);
}

.site-rules-empty {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: center;
  min-height: 84px;
  margin-top: 14px;
  padding: 14px 16px;
  border: 1px dashed #d9dde6;
  border-radius: 16px;
  color: var(--muted, #737c8f);
  background: var(--surface, #fff);
  column-gap: 11px;
  text-align: left;
}

.site-rules-empty > span {
  grid-row: 1 / span 2;
  color: var(--brand-strong, #dc315f);
  font-size: 21px;
}

.site-rules-empty strong {
  color: var(--ink, #172033);
  font-size: 13px;
}

.site-rules-empty small {
  max-width: 390px;
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.55;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

:root.dark .site-rules-editor,
:root.dark .site-rule-item,
:root.dark .site-rules-empty,
:root.dark .site-rules-input-wrap input {
  border-color: #30333c;
  background: #252830;
}

:root.dark .site-rules-editor {
  --brand-strong: #ff7aa2;
  --brand-soft: rgba(239, 71, 118, .16);
  --ink: #f4f5f8;
  --muted: #b7bdc9;
  --line: #3b3f49;
  --surface: #252830;
  --surface-soft: #20232a;
}

:root.dark .site-rules-input-wrap input:focus {
  border-color: #ef4776;
  background: #1d2027;
}

@media (max-width: 600px) {
  .site-rules-editor {
    padding: 16px;
  }

  .site-rules-heading {
    gap: 12px;
  }

  .site-rule-copy small {
    white-space: normal;
  }
}

@media (max-width: 480px) {
  .site-rules-heading {
    flex-direction: column;
  }

  .site-rules-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .site-rules-add {
    width: 100%;
  }

  .site-rule-item {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .site-rule-icon {
    width: 32px;
    height: 32px;
  }

  .site-rule-remove {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
