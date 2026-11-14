<!--
 @file src/features/image-translation/ui/ImageTranslationSettingsPreview.vue
 文件职责：用本地示意图说明图片和漫画翻译的原图、译图对照方式。
 主要内容：切换固定英文原图与中文译图样本，分别呈现清晰排版文字和漫画气泡；气泡均衡换行以减少窄屏中的孤立尾字，明确样本不随翻译语言变化。
 模块边界：不运行 OCR、不修补背景、不读取网页图片、不联网；仅供设置效果预览使用。
-->
<template>
  <div class="image-example">
    <div class="image-example-tabs" role="group" :aria-label="translateLegacy(manga ? '漫画示例对照' : '图片示例对照')">
      <button type="button" :aria-pressed="!translated" @click="translated = false">原图</button>
      <button type="button" :aria-pressed="translated" @click="translated = true">译图</button>
    </div>
    <div v-if="manga" class="image-example-comic" data-i18n-ignore>
      <div class="image-example-bubble">{{ translated ? '一起去看看更大的世界吧！' : 'Let’s explore a bigger world!' }}</div>
      <div class="image-example-landscape" aria-hidden="true"><i /><i /><b /></div>
      <div class="image-example-bubble image-example-reply">{{ translated ? '好呀，我们出发！' : 'Ready? Let’s go!' }}</div>
    </div>
    <div v-else class="image-example-paper" data-i18n-ignore>
      <span class="image-example-paper-tag">{{ translated ? '阅读笔记' : 'READING NOTES' }}</span>
      <strong>{{ translated ? '阅读，发现新的视角' : 'Read. Discover a new perspective.' }}</strong>
      <p>{{ translated ? '每一种语言，都带来一种看世界的新方式。' : 'Every language offers a new way to see the world.' }}</p>
      <div class="image-example-paper-lines" aria-hidden="true"><i /><i /><i /></div>
    </div>
    <p class="image-example-note">固定英中示例，仅说明原图与译图的对照方式</p>
  </div>
</template>
<script setup lang="ts">
import {ref} from 'vue'
import {useUiI18n} from '@/src/ui/i18n'
defineProps<{manga?: boolean}>()
const {translateLegacy} = useUiI18n()
const translated = ref(true)
</script>
<style scoped>
.image-example-tabs { display:flex; gap:6px; margin-bottom:16px; }
.image-example-tabs button { padding:6px 12px; border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--muted); font:inherit; font-size:12px; cursor:pointer; }
.image-example-tabs button[aria-pressed=true] { color:var(--brand); border-color:var(--brand); }
.image-example-tabs button:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
.image-example-paper { display:grid; gap:18px; padding:28px 24px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:var(--surface); }
.image-example-paper-tag { color:var(--brand); font-size:10px; letter-spacing:.1em; }
.image-example-paper strong { max-width:260px; font-size:22px; line-height:1.5; }
.image-example-paper p { margin:0; font-size:13px; line-height:1.8; }
.image-example-paper-lines { display:grid; gap:8px; }
.image-example-paper-lines i { width:85%; height:5px; border-radius:3px; background:var(--line); }
.image-example-paper-lines i:nth-child(2) { width:95%; }
.image-example-paper-lines i:last-child { width:55%; }
.image-example-comic { position:relative; display:grid; gap:14px; min-height:270px; padding:20px; overflow:hidden; border:2px solid var(--line); border-radius:8px; background:var(--surface); }
.image-example-bubble { position:relative; z-index:1; max-width:75%; padding:14px 18px; border:2px solid var(--ink); border-radius:50%; background:var(--surface); color:var(--ink); font-size:15px; font-weight:650; line-height:1.7; text-align:center; text-wrap:balance; }
.image-example-reply { justify-self:end; }
.image-example-landscape { position:absolute; inset:35% 0 0; overflow:hidden; background:color-mix(in srgb,var(--brand) 6%,var(--surface)); }
.image-example-landscape i { position:absolute; top:35%; left:-10%; width:75%; height:120%; border-radius:35% 70% 0 0; background:var(--surface-soft); transform:rotate(-20deg); }
.image-example-landscape i:nth-child(2) { left:40%; top:15%; background:var(--line); transform:rotate(25deg); }
.image-example-landscape b { position:absolute; top:8%; left:14%; width:28px; height:28px; border-radius:50%; background:color-mix(in srgb,var(--brand) 25%,var(--surface)); }
.image-example-note { margin:14px 0 0; color:var(--muted); font-size:11px; line-height:1.7; }
</style>
