<!--
 * @file src/features/settings/ui/WritingSettings.vue
 * 文件职责：让用户了解并配置写作助手，管理网页回复场景的使用偏好。
 * 主要内容：统一开关、服务模型、回复入口、快捷键、语言语气及禁用网站，展示简洁使用流程。
 * 模块边界：只编辑传入配置，由设置中心持久化；写作面板通过独立后台协议生成。
 -->
<template>
  <div class="writing-settings">
    <div class="writing-intro">
      <div><span class="writing-kicker">从阅读，到表达</span><h3>想好怎么说，剩下的交给写作助手</h3><p>起草邮件、润色文字，或根据对话整理一份回复。<br />在 Gmail 和 GitHub 中，点「写作助手」即可开始。</p>

      </div>
      <div class="writing-example" aria-label="写作助手使用示例"><small>使用示例</small><p>感谢建议，说明下周会继续跟进。</p><span>↓  整理为自然的表达</span><blockquote>感谢你的建议，对我很有帮助。我会在下周继续跟进，并及时与你分享进展。</blockquote><div><span>润色</span><span>续写</span><span>帮我回复</span></div></div>
    </div>
    <SettingsGroup>
      <FeatureEnableCard v-model="config.writing.enabled" title="启用写作助手" description="点击生成才会调用 AI 服务；生成内容由你确认后使用。" />
      <SettingsItem label="网页回复入口" description="在 Gmail 和 GitHub 的回复框旁显示“写作助手”。">
        <el-switch v-model="config.writing.replyButtons" aria-label="网页回复入口" :disabled="!config.writing.enabled" />
      </SettingsItem>
    </SettingsGroup>
    <SettingsGroup title="写作服务" description="使用已有 AI 服务和密钥，可以与网页翻译独立选择。">
      <SettingsItem label="AI 服务" description="留空时跟随默认服务；机器翻译服务不支持写作。">
        <el-select v-model="config.writing.service" clearable aria-label="写作服务" placeholder="跟随默认服务" @change="config.writing.model = ''"><el-option v-for="item in serviceOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select>
      </SettingsItem>
      <SettingsItem label="写作模型" description="沿用服务模型，也可以选择或输入模型名称。">
        <el-select v-model="config.writing.model" clearable filterable allow-create default-first-option aria-label="写作模型" placeholder="跟随服务模型"><el-option v-for="item in modelOptions" :key="item" :label="item" :value="item" /></el-select>
      </SettingsItem>
      <p v-if="!supported" class="writing-setting-notice" role="status">当前默认服务不支持写作，请选择一个 AI 服务。</p>
      <button class="writing-settings-link" type="button" @click="emit('configure-service')">配置服务连接与密钥 →</button>
    </SettingsGroup>
    <SettingsGroup title="使用偏好">
      <SettingsItem label="打开面板的快捷键" description="仅在 Gmail 和 GitHub 的 Issue、Pull Request 回复页面使用。">
        <div class="writing-hotkey"><input v-model="hotkey" aria-label="写作快捷键" placeholder="Alt+W" @change="saveHotkey" /><button type="button" @click="hotkey = ''; saveHotkey()">清除</button><small v-if="hotkeyError" role="alert">{{ hotkeyError }}</small></div>
      </SettingsItem>
      <SettingsItem label="默认输出语言" description="每次打开面板时使用，生成前仍可调整。"><el-select v-model="config.writing.language" aria-label="写作默认语言"><el-option v-for="item in WRITING_LANGUAGES" :key="item.value" :value="item.value" :label="item.label" /></el-select></SettingsItem>
      <SettingsItem label="默认语气"><el-select v-model="config.writing.tone" aria-label="写作默认语气"><el-option v-for="item in WRITING_TONES" :key="item.value" :value="item.value" :label="item.label" /></el-select></SettingsItem>
    </SettingsGroup>
    <SettingsGroup title="在这些网站停用" description="不显示回复入口，写作快捷键也不会触发；包含对应网站的子域。">
      <form class="writing-site-form" @submit.prevent="addSite"><input v-model="site" aria-label="写作助手禁用网站" placeholder="例如 github.com" /><el-button native-type="submit">添加</el-button></form>
      <p v-if="siteError" class="writing-setting-notice" role="alert">{{ siteError }}</p>
      <div class="writing-sites"><el-tag v-for="domain in config.writing.disabledDomains" :key="domain" closable @close="config.writing.disabledDomains = config.writing.disabledDomains.filter(item => item !== domain)">{{ domain }}</el-tag><span v-if="!config.writing.disabledDomains.length">未添加禁用网站</span></div>
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import {computed, ref, toRef, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {models, options} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {WRITING_LANGUAGES, WRITING_TONES} from '@/src/core/config/writing';
import {getSiteBaseDomain} from '@/src/core/site-rules/domain';
import {parseHotkey, validateHotkeyConflicts} from '@/src/core/hotkey';
import {getCustomOpenAIProviderModels, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
const props = defineProps<{config: Config}>(); const config = toRef(props, 'config');
const emit = defineEmits<{'configure-service': []}>();
const site = ref(''); const siteError = ref('');
const hotkey = ref(config.value.writing.hotkey); const hotkeyError = ref('');
watch(() => config.value.writing.hotkey, value => { hotkey.value = value; });
const serviceOptions = computed(() => [...options.services.filter(item => !item.disabled && isHarnessService(item.value)), ...config.value.customOpenAIProviders.map(item => ({value: item.id, label: item.name}))]);
const service = computed(() => config.value.writing.service || config.value.service);
const supported = computed(() => isHarnessService(service.value, config.value.customOpenAIProviders));
const modelOptions = computed(() => (isCustomOpenAIProviderId(service.value) ? getCustomOpenAIProviderModels(config.value.customOpenAIProviders, service.value) : models.get(service.value) ?? []).filter(item => item !== '自定义模型'));
function saveHotkey() {
  hotkeyError.value = '';
  if (!hotkey.value.trim()) { config.value.writing.hotkey = ''; return; }
  const parsed = parseHotkey(hotkey.value);
  if (!parsed.isValid || parsed.modifiers.length === 0 || validateHotkeyConflicts(parsed).hasConflict) { hotkeyError.value = '请输入包含修饰键的组合，例如 Alt+W。'; return; }
  config.value.writing.hotkey = parsed.displayName;
}
function addSite() {
  const domain = getSiteBaseDomain(site.value); siteError.value = '';
  if (!domain) { siteError.value = '请输入有效的网站域名或网址。'; return; }
  if (config.value.writing.disabledDomains.includes(domain)) { siteError.value = '这个网站已在名单中。'; return; }
  config.value.writing.disabledDomains = [...config.value.writing.disabledDomains, domain]; site.value = '';
}
</script>
<style scoped>
.writing-settings{width:min(100%,1080px);margin:auto}.writing-intro{display:grid;grid-template-columns:1.1fr 1fr;align-items:center;gap:40px;padding:28px 28px 34px;margin-bottom:24px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(120deg,color-mix(in srgb,var(--brand) 5%,var(--surface)),var(--surface))}.writing-kicker{font-size:11px;color:var(--brand)}.writing-intro h3{font-size:21px;line-height:1.5;color:var(--ink);margin:10px 0 12px;font-weight:700}.writing-intro p{font-size:12px;line-height:1.9;color:var(--muted);margin:0 0 18px}.writing-example{padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:0 7px 25px #223c4c06}.writing-example small{color:var(--muted);font-size:10px}.writing-example p{padding:10px 12px;margin:10px 0;background:var(--surface-soft);border-radius:8px;color:var(--ink);font-size:12px}.writing-example>span{color:var(--muted);font-size:10px}.writing-example blockquote{margin:10px 0 15px;padding:0 0 0 12px;border-left:2px solid var(--brand);font-size:12px;line-height:1.9;color:var(--ink)}.writing-example>div{display:flex;gap:8px}.writing-example>div span{font-size:10px;border:1px solid var(--line);border-radius:6px;padding:3px 8px;color:var(--muted)}.writing-setting-notice{font-size:12px;color:var(--warning,#b16b34);padding:0 18px}.writing-settings-link{margin:0 18px 16px;padding:0;background:none;border:0;color:var(--brand);font:inherit;font-size:12px;cursor:pointer}.writing-hotkey{display:flex;flex-wrap:wrap;gap:8px}.writing-hotkey input,.writing-site-form input{min-width:0;flex:1;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:12px;padding:9px 12px}.writing-hotkey button{background:var(--surface-soft);border:1px solid var(--line);border-radius:8px;color:var(--muted);cursor:pointer}.writing-hotkey small{width:100%;color:var(--warning,#b16b34)}.writing-site-form{display:flex;gap:10px;padding:0 18px}.writing-sites{display:flex;flex-wrap:wrap;gap:8px;padding:15px 18px}.writing-sites>span{font-size:12px;color:var(--muted)}
@media(max-width:760px){.writing-intro{grid-template-columns:1fr;gap:22px;padding:20px}.writing-intro h3{font-size:19px}}
</style>
