<template>
  <div class="fr-story-stack">
    <h2>圆角与层次</h2>
    <p class="fr-story-note">设置卡片使用轻边框与克制阴影，菜单浮层使用更高层级。品牌色留给选中状态和主操作。</p>
    <div class="fr-story-grid">
      <article class="fr-story-tile" style="border-color: var(--fr-card-border); border-radius: var(--fr-card-radius); box-shadow: var(--fr-card-shadow)"><h3>设置卡片</h3><code>--fr-card-radius · 14px</code><code>--fr-card-shadow</code><small>SettingsGroup / SettingsDisclosure</small></article>
      <article class="fr-story-tile" style="border-radius: 12px"><h3>下拉控件</h3><code>12px</code><small>UiSelect.vue</small></article>
      <article class="fr-story-tile" style="border-radius: var(--fr-menu-radius); box-shadow: var(--fr-menu-shadow)"><h3>菜单浮层</h3><code>--fr-menu-radius</code><code>--fr-menu-shadow</code><small>tokens.css</small></article>
    </div>
  </div>
</template>
