<script setup lang="ts">
import { interfaceFontOptions } from '@/src/core/config/interfaceAppearance'
const sizes = [{ size: 26, title: '页面标题' }, { size: 18, title: '分区标题' }, { size: 14, title: '控件标题' }, { size: 13, title: '表单文字' }, { size: 12, title: '辅助说明' }, { size: 11, title: '进度详情' }]
</script>
<template>
  <div class="fr-story-stack">
    <section><h2>文字层级</h2><p class="fr-story-note">这些是现有设置页与组件使用的常见字号。字体继承当前界面的系统字体栈。</p>
      <div v-for="item in sizes" :key="item.size" class="fr-story-tile">
        <small>{{ item.title }} · {{ item.size }}px</small>
        <p :style="{ fontSize: `${item.size}px`, marginBottom: 0 }">让语言更近，让世界更大。 Closer languages. A bigger world.</p>
      </div>
    </section>
    <section><h2>字体方案</h2><p class="fr-story-note">元数据来自扩展字体注册表。此页不下载字体；未安装的字体会按列表回退，真实字体下载在扩展设置中进行。</p>
      <div v-for="font in interfaceFontOptions" :key="font.value" class="fr-story-tile">
        <code>{{ font.value }}</code><small>{{ font.fontFamily }}</small>
        <p :style="{ fontFamily: font.fontFamily, marginBottom: 0 }">阅读连接更大的世界。 Reading connects us.</p>
      </div>
    </section>
  </div>
</template>
