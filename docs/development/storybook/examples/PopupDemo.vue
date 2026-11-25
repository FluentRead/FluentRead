<script setup lang="ts">
import { ref } from 'vue'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import UiIcon from '@/src/ui/components/UiIcon.vue'

const translated = ref(false)
const alwaysSite = ref(false)
const disableSite = ref(false)
const features = [
  { id: 'hover', label: '鼠标悬停翻译', summary: 'Ctrl', active: true },
  { id: 'selection', label: '划词翻译', summary: '已关闭', active: false },
  { id: 'image', label: '图片翻译', summary: 'Shift+Z', active: true },
  { id: 'document', label: '文档翻译', summary: 'PDF / Word / EPUB', external: true },
]
</script>
<template>
  <div class="fr-popup-spec-frame">
    <header class="fr-popup-spec-header">
      <div class="fr-popup-spec-brand">
        <span class="fr-popup-spec-logo" aria-hidden="true">A中</span>
        <div>
          <strong>流畅阅读</strong>
          <small>v0.0.42</small>
        </div>
      </div>
      <div class="fr-popup-spec-actions">
        <button type="button" class="fr-popup-spec-icon-btn" aria-label="支持与赞赏"><UiIcon name="star" :size="15" /></button>
        <button type="button" class="fr-popup-spec-settings-btn"><UiIcon name="settings" :size="15" /><span>设置</span></button>
      </div>
    </header>

    <section class="fr-popup-spec-card">
      <div class="fr-popup-spec-langs">
        <div class="fr-popup-spec-field"><span>源语言</span><div class="fr-popup-spec-select">自动检测</div></div>
        <span class="fr-popup-spec-arrow" aria-hidden="true">→</span>
        <div class="fr-popup-spec-field"><span>目标语言</span><div class="fr-popup-spec-select">简体中文</div></div>
      </div>
      <button type="button" class="fr-popup-spec-provider">
        <span><small>翻译服务</small><strong>免费翻译服务</strong></span>
        <ServiceIcon service="freeTranslation" label="免费翻译服务" size="small" />
      </button>
      <div class="fr-popup-spec-cta-row">
        <button type="button" class="fr-popup-spec-cta" :class="{ translated }" :aria-pressed="translated" @click="translated = !translated">
          {{ translated ? '恢复原文（⌥+T）' : '翻译（⌥+T）' }}
        </button>
        <button type="button" class="fr-popup-spec-sub-cta">局部</button>
      </div>
      <div class="fr-popup-spec-rules">
        <button type="button" class="fr-popup-spec-rule" :class="{ active: alwaysSite }" :aria-pressed="alwaysSite" @click="alwaysSite = !alwaysSite">
          <i aria-hidden="true" /><span>始终翻译此网站</span>
        </button>
        <button type="button" class="fr-popup-spec-rule" :class="{ active: disableSite }" :aria-pressed="disableSite" @click="disableSite = !disableSite">
          <i aria-hidden="true" /><span>在此网站禁用扩展</span>
        </button>
      </div>
    </section>

    <section class="fr-popup-spec-grid">
      <button v-for="item in features" :key="item.id" type="button" class="fr-popup-spec-feature">
        <span class="fr-popup-spec-feature-copy">
          <strong>{{ item.label }}</strong>
          <small>{{ item.summary }}</small>
        </span>
        <i v-if="!item.external" class="fr-popup-spec-dot" :class="{ active: item.active }" aria-hidden="true" />
        <span v-else class="fr-popup-spec-ext" aria-hidden="true">↗</span>
      </button>
    </section>

    <footer class="fr-popup-spec-footer">
      <span>128 次翻译</span>
      <span class="fr-popup-spec-gh">开源项目 ↗</span>
      <button type="button">清除缓存</button>
    </footer>
  </div>
</template>
<style scoped>
.fr-popup-spec-frame {
  width: 320px; padding: 12px 14px 8px; border: 1px solid var(--line); border-radius: var(--fr-radius-lg, 12px);
  background: var(--surface); color: var(--ink); font-family: var(--interface-font-family);
}
.fr-popup-spec-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.fr-popup-spec-brand { display: flex; align-items: center; gap: 8px; }
.fr-popup-spec-logo {
  display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--fr-radius-sm, 8px);
  background: var(--fr-color-brand-action, var(--brand)); color: #fff; font-size: 12px; font-weight: 700;
}
.fr-popup-spec-brand div { display: flex; flex-direction: column; }
.fr-popup-spec-brand strong { font-size: var(--fr-text-md, 14px); line-height: 1.25; font-weight: 600; }
.fr-popup-spec-brand small { color: var(--muted); font-size: var(--fr-text-xs, 11px); font-variant-numeric: tabular-nums; }
.fr-popup-spec-actions { display: flex; gap: 6px; }
.fr-popup-spec-icon-btn, .fr-popup-spec-settings-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 32px; padding: 0 9px;
  border: 1px solid var(--line); border-radius: var(--fr-control-radius, 8px); background: var(--surface); color: var(--ink);
  font: inherit; font-size: var(--fr-text-sm, 12px); font-weight: 500; cursor: pointer;
}
.fr-popup-spec-icon-btn { width: 32px; padding: 0; color: var(--muted); }
.fr-popup-spec-card { padding: 10px; border: 1px solid var(--line); border-radius: var(--fr-radius-lg, 12px); background: var(--surface); display: grid; gap: 8px; }
.fr-popup-spec-langs { display: grid; grid-template-columns: 1fr 16px 1fr; align-items: end; gap: 6px; }
.fr-popup-spec-field span { display: block; margin: 0 0 4px 2px; color: var(--muted); font-size: var(--fr-text-xs, 11px); font-weight: 500; }
.fr-popup-spec-select {
  display: flex; align-items: center; height: 34px; padding: 0 10px; border: 1px solid var(--line);
  border-radius: var(--fr-control-radius, 8px); background: var(--surface-soft); font-size: var(--fr-text-sm, 12px); font-weight: 500;
}
.fr-popup-spec-arrow { display: grid; place-items: center; height: 34px; color: var(--muted); font-size: 12px; }
.fr-popup-spec-provider {
  display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 40px; padding: 6px 10px;
  border: 1px solid var(--line); border-radius: var(--fr-control-radius, 8px); background: var(--surface-soft); color: var(--ink); cursor: pointer;
}
.fr-popup-spec-provider > span { display: flex; align-items: baseline; gap: 6px; font-size: var(--fr-text-sm, 12px); }
.fr-popup-spec-provider small { color: var(--muted); font-size: var(--fr-text-sm, 12px); }
.fr-popup-spec-cta-row { display: flex; gap: 6px; }
.fr-popup-spec-cta {
  flex: 1; min-height: 40px; border: 0; border-radius: var(--fr-control-radius, 8px);
  background: var(--fr-color-brand-action, var(--brand-strong)); color: #fff; font: inherit; font-size: var(--fr-text-base, 13px); font-weight: 600; cursor: pointer;
  transition: background-color var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease), transform var(--fr-duration-instant, 120ms) var(--fr-ease-out, ease);
}
.fr-popup-spec-cta:hover { background: var(--fr-color-brand-action-hover, var(--brand-strong)); }
.fr-popup-spec-cta:active { transform: scale(.985); }
.fr-popup-spec-cta.translated { border: 1px solid color-mix(in srgb, var(--brand) 38%, var(--line)); background: var(--brand-soft); color: var(--brand-strong); }
.fr-popup-spec-sub-cta {
  min-width: 48px; min-height: 40px; border: 1px solid var(--line); border-radius: var(--fr-control-radius, 8px);
  background: var(--surface-soft); color: var(--ink); font: inherit; font-size: var(--fr-text-xs, 11px); font-weight: 600; cursor: pointer;
}
.fr-popup-spec-rules { display: flex; flex-wrap: wrap; gap: 6px; }
.fr-popup-spec-rule {
  display: inline-flex; align-items: center; gap: 5px; min-height: 26px; padding: 0 8px;
  border: 1px solid var(--line); border-radius: var(--fr-radius-xs, 6px); background: var(--surface); color: var(--muted);
  font: inherit; font-size: var(--fr-text-xs, 11px); font-weight: 500; cursor: pointer;
}
.fr-popup-spec-rule i { width: 6px; height: 6px; border-radius: 50%; background: var(--fr-color-line-strong, var(--line)); }
.fr-popup-spec-rule.active { border-color: color-mix(in srgb, var(--brand) 36%, var(--line)); background: var(--brand-soft); color: var(--brand-strong); }
.fr-popup-spec-rule.active i { background: var(--brand-strong); }
.fr-popup-spec-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.fr-popup-spec-feature {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 48px; padding: 7px 10px;
  border: 1px solid var(--line); border-radius: var(--fr-radius-md, 10px); background: var(--surface); color: var(--ink); text-align: left; cursor: pointer;
}
.fr-popup-spec-feature-copy { display: flex; flex-direction: column; min-width: 0; }
.fr-popup-spec-feature-copy strong { font-size: var(--fr-text-sm, 12px); font-weight: 600; line-height: 1.35; }
.fr-popup-spec-feature-copy small { color: var(--muted); font-size: var(--fr-text-xs, 11px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-popup-spec-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--fr-color-line-strong, var(--line)); }
.fr-popup-spec-dot.active { background: var(--fr-success); }
.fr-popup-spec-ext { color: var(--muted); font-size: 12px; }
.fr-popup-spec-footer {
  display: flex; align-items: center; justify-content: space-between; margin-top: 10px; padding-top: 8px;
  border-top: 1px solid var(--line); color: var(--muted); font-size: var(--fr-text-xs, 11px); font-variant-numeric: tabular-nums;
}
.fr-popup-spec-gh { padding: 2px 8px; border-radius: var(--fr-radius-full, 9999px); background: var(--surface-soft); }
.fr-popup-spec-footer button { border: 0; padding: 0; background: none; color: var(--muted); font: inherit; font-weight: 500; cursor: pointer; }
.fr-popup-spec-footer button:hover { color: var(--ink); }
</style>
