<!--
 @file .agents/skills/fluentread-ui/examples/popup-drawer-example.vue
 文件职责：展示符合 FluentRead 设计体系的 320px Popup 快捷抽屉片段，体现同心圆角、≥11px 可读底线、纯色高对比交互与可访问语义。
 主要内容：头部标题与总开关同行，核心模式切换与操作示意居前，次要高级配置通过底部链接直达设置中心。
 模块边界：本文件为设计技能参考示例，不参与运行时打包。
-->
<template>
  <div class="fr-example-drawer">
    <header class="fr-example-drawer-header">
      <div class="fr-example-drawer-title">
        <h2>划词翻译</h2>
        <button
          type="button"
          class="fr-example-switch"
          role="switch"
          aria-label="启用划词翻译"
          :aria-checked="enabled"
          @click="enabled = !enabled"
        >
          <i aria-hidden="true" />
        </button>
      </div>
      <button type="button" class="fr-example-close" aria-label="关闭" @click="$emit('close')">×</button>
    </header>

    <div class="fr-example-choices" role="group" aria-label="划词翻译模式">
      <button
        v-for="item in modes"
        :key="item.value"
        type="button"
        :class="{ selected: mode === item.value }"
        :aria-pressed="mode === item.value"
        :disabled="!enabled"
        @click="mode = item.value"
      >
        {{ item.label }}
      </button>
    </div>

    <button type="button" class="fr-example-more" @click="$emit('open-settings')">
      <span>更多划词设置</span>
      <span aria-hidden="true">↗</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineEmits<{ close: []; 'open-settings': [] }>()

const enabled = ref(true)
const mode = ref<'bilingual' | 'translation-only'>('bilingual')
const modes = [
  { value: 'bilingual' as const, label: '双语对照' },
  { value: 'translation-only' as const, label: '仅译文' },
]
</script>

<style scoped>
.fr-example-drawer {
  padding: 14px 16px;
  border-radius: 16px 16px 0 0;
  background: var(--surface);
  color: var(--ink);
  font-family: var(--interface-font-family);
}
.fr-example-drawer-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fr-example-drawer-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fr-example-drawer-title h2 { margin: 0; font-size: var(--fr-text-xl, 18px); font-weight: 600; }
.fr-example-close {
  display: grid; place-items: center; width: 32px; height: 32px; border: 0;
  border-radius: var(--fr-control-radius, 8px); background: var(--surface-soft); color: var(--muted);
  font-size: 20px; cursor: pointer;
}
.fr-example-close:hover { color: var(--brand-strong); background: var(--brand-soft); }
.fr-example-switch {
  position: relative; width: 40px; height: 24px; padding: 3px; border: 0;
  border-radius: var(--fr-radius-full, 9999px); background: var(--fr-color-line-strong); cursor: pointer;
  transition: background-color var(--fr-duration-fast, 160ms) var(--fr-ease-out, ease);
}
.fr-example-switch[aria-checked="true"] { background: var(--brand); }
.fr-example-switch i {
  display: block; width: 18px; height: 18px; border-radius: 50%; background: #fff;
  transition: transform var(--fr-duration-normal, 220ms) var(--fr-ease-in-out, ease);
}
.fr-example-switch[aria-checked="true"] i { transform: translateX(16px); }
.fr-example-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.fr-example-choices button {
  min-height: 36px; padding: 6px 10px; border: 1px solid var(--line);
  border-radius: var(--fr-control-radius, 8px); background: var(--surface); color: var(--ink);
  font: inherit; font-size: var(--fr-text-sm, 12px); font-weight: 500; cursor: pointer;
  transition: border-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), transform var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}
.fr-example-choices button.selected { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-strong); font-weight: 600; }
.fr-example-choices button:active:not(:disabled) { transform: scale(.985); }
.fr-example-choices button:disabled { opacity: .5; cursor: not-allowed; }
.fr-example-more {
  display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 36px;
  margin-top: 14px; padding: 10px 2px 0; border: 0; border-top: 1px solid var(--line);
  background: transparent; color: var(--muted); font: inherit; font-size: var(--fr-text-sm, 12px); cursor: pointer;
}
.fr-example-more:hover { color: var(--ink); }
.fr-example-drawer button:focus-visible {
  outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong));
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .fr-example-switch, .fr-example-switch i, .fr-example-choices button { transition: none; }
}
</style>
