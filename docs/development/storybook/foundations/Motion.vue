<script setup lang="ts">
import { ref } from 'vue'
const expanded = ref(false)
const pressedCount = ref(0)
</script>
<template>
  <div class="fr-story-stack">
    <section>
      <h2>动效物理与微交互（Emil Design Engineering）</h2>
      <p class="fr-story-note">只为明确的状态反馈与空间连续性使用动效；严禁全局 <code>* { transition }</code>、无意义悬停上浮与发光阴影。</p>
      <div class="fr-story-grid">
        <article class="fr-story-tile">
          <h3>Instant · 120ms</h3>
          <code>--fr-duration-instant</code>
          <small>按压缩放、边框与背景微态悬停</small>
        </article>
        <article class="fr-story-tile">
          <h3>Fast · 160ms</h3>
          <code>--fr-duration-fast</code>
          <small>选项切换、焦点环、箭头旋转</small>
        </article>
        <article class="fr-story-tile">
          <h3>Normal · 220ms</h3>
          <code>--fr-duration-normal</code>
          <small>抽屉滑入、弹窗显隐、折叠面板</small>
        </article>
      </div>
    </section>

    <section>
      <h2>物理按压 vs 展开缓出</h2>
      <div class="fr-story-tile fr-motion-lab">
        <div class="fr-story-row">
          <button type="button" class="fr-motion-primary" @click="pressedCount += 1">
            按压主按钮（scale 0.985） · {{ pressedCount }}
          </button>
          <button type="button" class="fr-motion-secondary" :aria-expanded="expanded" @click="expanded = !expanded">
            {{ expanded ? '收起示例浮层' : '展开示例浮层（ease-out）' }}
          </button>
        </div>
        <Transition name="fr-motion-pop">
          <div v-if="expanded" class="fr-motion-popover">
            <strong>cubic-bezier(0.23, 1, 0.32, 1)</strong>
            <p>仅动画化 <code>transform</code> 与 <code>opacity</code>，在 <code>prefers-reduced-motion: reduce</code> 下自动关闭。</p>
          </div>
        </Transition>
      </div>
    </section>
  </div>
</template>
<style scoped>
.fr-motion-lab { display: grid; gap: 14px; }
.fr-motion-primary {
  min-height: 38px; padding: 0 16px; border: 0; border-radius: var(--fr-control-radius, 8px);
  color: #fff; background: var(--fr-color-brand-action-gradient, var(--fr-color-brand-action, var(--brand-strong)));
  box-shadow: var(--fr-shadow-brand-action, none);
  font: inherit; font-size: var(--fr-text-base, 13px); font-weight: 600; cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), box-shadow var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), transform var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}
.fr-motion-primary:hover { background: var(--fr-color-brand-action-gradient-hover, var(--fr-color-brand-action-hover, var(--brand-strong))); box-shadow: var(--fr-shadow-brand-action-hover, var(--fr-shadow-brand-action, none)); }
.fr-motion-primary:active { transform: scale(.985); }
.fr-motion-secondary {
  min-height: 38px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--fr-control-radius, 8px);
  color: var(--ink); background: var(--surface); font: inherit; font-size: var(--fr-text-base, 13px); font-weight: 500; cursor: pointer;
  transition: background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), border-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), transform var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}
.fr-motion-secondary:hover { border-color: var(--fr-color-line-strong, var(--line)); background: var(--surface-soft); }
.fr-motion-secondary:active { transform: scale(.985); }
.fr-motion-primary:focus-visible, .fr-motion-secondary:focus-visible { outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong)); outline-offset: 2px; }
.fr-motion-popover {
  padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--fr-radius-md, 10px);
  background: var(--surface-soft); box-shadow: var(--fr-shadow-md);
}
.fr-motion-popover p { margin: 4px 0 0; color: var(--muted); font-size: var(--fr-text-sm, 12px); }
.fr-motion-pop-enter-active, .fr-motion-pop-leave-active { transition: opacity var(--fr-duration-normal, 220ms) var(--fr-ease-out, ease), transform var(--fr-duration-normal, 220ms) var(--fr-ease-out, ease); transform-origin: top left; }
.fr-motion-pop-enter-from, .fr-motion-pop-leave-to { opacity: 0; transform: translateY(-4px) scale(.98); }
@media (prefers-reduced-motion: reduce) {
  .fr-motion-primary, .fr-motion-secondary, .fr-motion-pop-enter-active, .fr-motion-pop-leave-active { transition: none; }
}
</style>
