<!--
 * @file src/features/settings/ui/HarnessPromptSettings.vue
 * 文件职责：提供翻译卡通用指令和四种学习动作的提示词编辑界面。
 * 主要内容：使用可折叠编辑器切换模板、插入已登记占位符、显示字符限制并恢复当前模板的默认内容。
 * 模块边界：仅编辑传入的 HarnessPreferences，保存沿用设置页配置流程；不调用模型，不翻译或执行用户提示词内容。
 -->
<template>
  <SettingsGroup title="提示词" description="自定义通用指令和各个学习动作，调整翻译卡的回答方式。">
    <details class="harness-prompts">
      <summary>编辑提示词</summary>
      <div class="harness-prompt-body">
        <SegmentedControl v-model="selected" :options="promptOptions" label="选择提示词" />
        <div class="harness-prompt-toolbar">
          <small>选中文本和追问会自动提供，无需写入提示词。留空使用默认内容。</small>
          <button type="button" @click="restore">恢复默认</button>
        </div>
        <textarea ref="editor" v-model="prompt" data-i18n-ignore :maxlength="HARNESS_PROMPT_MAX_LENGTH"
          :placeholder="defaultPrompt" :aria-label="translateLegacy('提示词内容')" spellcheck="false" />
        <div class="harness-prompt-variables">
          <span>点击插入占位符</span>
          <button v-for="variable in HARNESS_PROMPT_VARIABLES" :key="variable.token" type="button"
            @mousedown.prevent @click="insertVariable(variable.token)">
            <code data-i18n-ignore>{{ variable.token }}</code><span>{{ translateLegacy(variable.label) }}</span>
          </button>
        </div>
        <small class="harness-prompt-count" data-i18n-ignore>{{ prompt.length }} / {{ HARNESS_PROMPT_MAX_LENGTH }}</small>
      </div>
    </details>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, nextTick, ref} from 'vue';
import {getDefaultHarnessPrompt, resolveHarnessPrompt, type HarnessPromptKind, HARNESS_ACTIONS, HARNESS_PROMPT_MAX_LENGTH, HARNESS_PROMPT_VARIABLES, type HarnessActionId, type HarnessPreferences} from '@/src/core/config/harness';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SegmentedControl from './components/SegmentedControl.vue';

const props = defineProps<{preferences: HarnessPreferences}>();
const {translateLegacy, language} = useUiI18n();
const selected = ref<string | number>('system');
const editor = ref<HTMLTextAreaElement | null>(null);
const promptOptions = computed(() => [{value: 'system', label: translateLegacy('通用指令')}, ...HARNESS_ACTIONS.map(action => ({value: action.id, label: translateLegacy(action.label)}))]);
const defaultPrompt = computed(() => getDefaultHarnessPrompt(selected.value as HarnessPromptKind, language.value));
const prompt = computed({
  get: () => {
    const stored = selected.value === 'system' ? props.preferences.systemPrompt : props.preferences.actionPrompts[selected.value as HarnessActionId];
    // 编辑时允许清空；默认占位文本和运行时回退都使用当前界面语言。
    return stored.trim() ? resolveHarnessPrompt(stored, selected.value as HarnessPromptKind, language.value) : stored;
  },
  set: (value: string) => {
    if (selected.value === 'system') props.preferences.systemPrompt = value;
    else props.preferences.actionPrompts[selected.value as HarnessActionId] = value;
  },
});
function restore() { prompt.value = defaultPrompt.value; }
async function insertVariable(token: string) {
  const field = editor.value!;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  const next = prompt.value.slice(0, start) + token + prompt.value.slice(end);
  if (next.length > HARNESS_PROMPT_MAX_LENGTH) return;
  prompt.value = next;
  await nextTick();
  field.focus();
  field.setSelectionRange(start + token.length, start + token.length);
}
</script>

<style scoped>
.harness-prompts { padding:16px; color:var(--ink); }
.harness-prompts summary { cursor:pointer; font-size:13px; font-weight:700; }
.harness-prompts summary:focus-visible { outline:2px solid var(--brand); outline-offset:4px; }
.harness-prompt-body { display:grid; gap:12px; margin-top:16px; }
.harness-prompt-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.harness-prompt-toolbar small { color:var(--muted); font-size:11px; line-height:1.6; }
.harness-prompts button { border:1px solid var(--line); border-radius:8px; padding:6px 10px; color:var(--ink); background:var(--surface); cursor:pointer; font:inherit; font-size:11px; }
.harness-prompt-toolbar button { flex-shrink:0; color:var(--brand); }
.harness-prompts textarea { display:block; width:100%; min-height:220px; max-height:440px; resize:vertical; border:1px solid var(--line); border-radius:10px; padding:14px; background:var(--surface-soft); color:var(--ink); font:12px/1.8 ui-monospace,monospace; }
.harness-prompts textarea:focus { outline:2px solid color-mix(in srgb,var(--brand) 45%,transparent); outline-offset:1px; }
.harness-prompt-variables { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.harness-prompt-variables > span { color:var(--muted); font-size:11px; }
.harness-prompt-variables button { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.harness-prompt-variables code { color:var(--brand); }
.harness-prompt-count { justify-self:end; color:var(--muted); font-size:10px; }
@media(max-width:480px) { .harness-prompts { padding:12px; } .harness-prompt-toolbar { align-items:flex-start; flex-direction:column; } }
</style>
