<!--
 @file src/ui/components/ServiceIcon.vue
 文件职责：为翻译服务和模型选项提供统一品牌图标组件，在没有专用图形时仍输出稳定、可辨识的回退字形。
 主要内容：根据 service、label、size 与 model props 选择尺寸和色调，为 Microsoft、Google、DeepL、内置及动态 OpenAI-compatible 服务渲染内联 SVG，并计算 fallbackGlyph。
 模块边界：组件只负责装饰性视觉且 aria-hidden，不加载远程商标、不判断服务可用性，也不选择模型；服务目录和能力过滤由 core/catalog 与 services/capabilities 管理。
-->
<template>
  <span
    class="service-brand-icon"
    :class="[`service-brand-icon--${size}`, `service-brand-icon--${tone}`]"
    :data-service="service"
    :title="label || service"
    aria-hidden="true"
  >
    <svg v-if="service === 'microsoft'" viewBox="0 0 24 24" role="img">
      <rect x="3" y="3" width="8" height="8" fill="#f35325" />
      <rect x="13" y="3" width="8" height="8" fill="#81bc06" />
      <rect x="3" y="13" width="8" height="8" fill="#05a6f0" />
      <rect x="13" y="13" width="8" height="8" fill="#ffba08" />
    </svg>
    <svg v-else-if="service === 'freeTranslation'" viewBox="0 0 24 24" role="img">
      <path d="M5 7h10M5 12h7M5 17h5" />
      <path d="m15 9 4 3-4 3M19 12H9" />
    </svg>
    <svg v-else-if="service === 'apertium'" viewBox="0 0 24 24" role="img">
      <path d="m4 18 8-13 8 13M7 13h10M8 19h8" />
    </svg>
    <svg v-else-if="service === 'libreTranslate'" viewBox="0 0 24 24" role="img">
      <path d="M4 5h9v9H4zM11 10h9v9h-9M6 8h5M8 6v5M14 13l3 4M17 13l-3 4" />
    </svg>
    <svg v-else-if="service === 'myMemory'" viewBox="0 0 24 24" role="img">
      <path d="M4 5h6a3 3 0 0 1 3 3v12a4 4 0 0 0-3-2H4V5ZM13 8a3 3 0 0 1 3-3h4v13h-4a4 4 0 0 0-3 2" />
      <path d="M7 9h3M7 12h3M16 9h1M16 12h1" />
    </svg>
    <svg v-else-if="service === 'google'" viewBox="0 0 24 24" role="img">
      <path d="M23 12.245c0-.905-.075-1.565-.236-2.25h-10.54v4.083h6.186c-.124 1.014-.797 2.542-2.294 3.569l-.021.136 3.332 2.53.23.022C21.779 18.417 23 15.593 23 12.245z" fill="#4285F4" />
      <path d="M12.225 23c3.03 0 5.574-.978 7.433-2.665l-3.542-2.688c-.948.648-2.22 1.1-3.891 1.1a6.745 6.745 0 0 1-6.386-4.572l-.132.011-3.465 2.628-.045.124C4.043 20.531 7.835 23 12.225 23z" fill="#34A853" />
      <path d="M5.84 14.175A6.65 6.65 0 0 1 5.463 12c0-.758.138-1.491.361-2.175l-.006-.147-3.508-2.67-.115.054A10.831 10.831 0 0 0 1 12c0 1.772.436 3.447 1.197 4.938l3.642-2.763z" fill="#FBBC05" />
      <path d="M12.225 5.253c2.108 0 3.529.892 4.34 1.638l3.167-3.031C17.787 2.088 15.255 1 12.225 1 7.834 1 4.043 3.469 2.197 7.062l3.63 2.763a6.77 6.77 0 0 1 6.398-4.572z" fill="#EB4335" />
    </svg>
    <svg v-else-if="service === 'deepL'" viewBox="0 0 24 24" role="img">
      <path d="M5 4.5h8.5a6 6 0 1 1 0 12H10L5 20V4.5Z" />
      <path d="M9 8.5h5.5M9 12h4" />
    </svg>
    <svg v-else-if="service === 'deeplx'" viewBox="0 0 24 24" role="img">
      <path d="M4.5 4.5h8.7a5.8 5.8 0 1 1 0 11.6H9.5l-5 3.4V4.5Z" />
      <text x="13.3" y="15.4" text-anchor="middle">X</text>
    </svg>
    <svg v-else-if="service === 'xiaoniu'" viewBox="0 0 24 24" role="img">
      <path d="M7 8.5 4.3 5.6M17 8.5l2.7-2.9M6.1 10.5a5.9 5.9 0 0 1 11.8 0v4.1a5.9 5.9 0 0 1-11.8 0v-4.1Z" />
      <path d="M9 13h.1M15 13h.1M10 16c1.2.8 2.8.8 4 0" />
    </svg>
    <svg v-else-if="service === 'youdao'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">有</text>
    </svg>
    <svg v-else-if="service === 'tencent'" viewBox="0 0 24 24" role="img">
      <path d="M5 11.5c0-3.7 3.1-6.5 7-6.5s7 2.8 7 6.5-3.1 6.5-7 6.5c-1.1 0-2.2-.2-3.1-.7L5 19l1.2-3.1A6.2 6.2 0 0 1 5 11.5Z" />
      <path d="m12 7.2 1.1 2.2 2.4.4-1.7 1.7.4 2.4-2.2-1.1-2.2 1.1.4-2.4-1.7-1.7 2.4-.4L12 7.2Z" />
    </svg>
    <svg v-else-if="service === 'chromeTranslator'" viewBox="0 0 24 24" role="img">
      <path d="M12 4a8 8 0 0 1 6.9 4H12a4 4 0 0 0 0 8h.2A8 8 0 1 1 12 4Z" />
      <path d="M12 8h6.9M12 16l3.5-6" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
    <svg v-else-if="service === 'openai'" viewBox="0 0 24 24" role="img">
      <path d="M12 4.2a3.4 3.4 0 0 1 5.8 2.4 3.4 3.4 0 0 1 1.9 5.8 3.4 3.4 0 0 1-3.4 5.2 3.4 3.4 0 0 1-5.8 2.2 3.4 3.4 0 0 1-5.8-2.4 3.4 3.4 0 0 1-1.9-5.8A3.4 3.4 0 0 1 6.2 6.4 3.4 3.4 0 0 1 12 4.2Z" />
      <path d="m8.2 8.5 7.5 4.3M15.8 8.5l-7.5 4.3M12 6v8.7M12 18v-2.2" />
    </svg>
    <svg v-else-if="service === 'azureOpenai'" viewBox="0 0 24 24" role="img">
      <path d="m13.8 3.5 6.1 5.1-6.3 11.9-3.1-6.1 3.8-4.5-6.2 1.1 4.6-7.5 1.1 4.2Z" />
      <path d="m10.5 14.4 3.1-4.5" />
    </svg>
    <svg v-else-if="service === 'gemini'" viewBox="0 0 24 24" role="img">
      <path d="m12 2 2.1 7.9L22 12l-7.9 2.1L12 22l-2.1-7.9L2 12l7.9-2.1L12 2Z" />
    </svg>
    <svg v-else-if="service === 'yiyan'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">文</text>
    </svg>
    <svg v-else-if="service === 'tongyi'" viewBox="0 0 24 24" role="img">
      <path d="M5 13.5c.5-4.3 4.1-7.4 8.3-6.7 3 .5 5.1 3 5.1 5.8 0 3.4-2.8 6.1-6.2 6.1-2.4 0-4.5-1.4-5.5-3.5 1.3 1 3.1 1.1 4.6.4 1.9-.9 2.7-3.2 1.8-5.1" />
      <path d="M7.2 8.7c1.3-.9 3.1-.8 4.2.2" />
    </svg>
    <svg v-else-if="service === 'zhipu'" viewBox="0 0 24 24" role="img">
      <path d="m12 2.8 7.4 4.6v9.2L12 21.2l-7.4-4.6V7.4L12 2.8Z" />
      <path d="m8.5 9.2 3.5-2 3.5 2v5.6l-3.5 2-3.5-2V9.2ZM8.5 12h7" />
    </svg>
    <svg v-else-if="service === 'moonshot'" viewBox="0 0 24 24" role="img">
      <text x="11" y="16.5" text-anchor="middle">K</text>
      <path d="m18 4 .7 2.4L21 7l-2.3.6L18 10l-.7-2.4L15 7l2.3-.6L18 4Z" />
    </svg>
    <svg v-else-if="service === 'claude'" viewBox="0 0 24 24" role="img">
      <path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3 5.3 18.7" />
      <circle cx="12" cy="12" r="2.2" />
    </svg>
    <svg v-else-if="isCustomOpenAIService" viewBox="0 0 24 24" role="img">
      <path d="M12 5v14M5 12h14" />
    </svg>
    <svg v-else-if="service === 'infini'" viewBox="0 0 24 24" role="img">
      <path d="M4 12c0-2.6 2.2-4.6 4.8-4.6 3.1 0 4.1 4.6 6.4 4.6s4.8-2 4.8-4.6M4 12c0 2.6 2.2 4.6 4.8 4.6 3.1 0 4.1-4.6 6.4-4.6s4.8 2 4.8 4.6" />
    </svg>
    <svg v-else-if="service === 'baichuan'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">百</text>
    </svg>
    <svg v-else-if="service === 'deepseek'" viewBox="0 0 24 24" role="img">
      <path d="M4 15.2c2.6 3.6 7.8 5.1 12 2.5 2.3-1.4 3.4-3.7 3.1-5.8-.3-2.3-2.2-4-4.5-4.2-1.7-.2-3.2.5-4.2 1.8 1.7-.4 3.4.1 4.4 1.3-2.2-.8-4.7-.2-6.1 1.8-.8 1-2.5 1.7-4.7 2.6Z" />
      <circle cx="15.8" cy="10.6" r=".8" />
    </svg>
    <svg v-else-if="service === 'lingyi'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">01</text>
    </svg>
    <svg v-else-if="service === 'minimax'" viewBox="0 0 24 24" role="img">
      <path d="M4.5 17V7l4 5 3.5-5v10M13 17V7l3.2 4.2L19.5 7v10" />
    </svg>
    <svg v-else-if="service === 'mimo'" viewBox="0 0 24 24" role="img">
      <path d="M4.5 17V8l3.8 4.3L12 8v9M12 17V8l3.7 4.3L19.5 8v9" />
      <circle cx="12" cy="4.5" r="1.2" />
    </svg>
    <svg v-else-if="service === 'jieyue'" viewBox="0 0 24 24" role="img">
      <path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7L12 3Z" />
      <path d="M17.5 16.5 20 19" />
    </svg>
    <svg v-else-if="service === 'groq'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">G</text>
      <path d="M15.5 13.5H19v3.7" />
    </svg>
    <svg v-else-if="service === 'huanYuan'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">混</text>
    </svg>
    <svg v-else-if="service === 'huanYuanTranslation'" viewBox="0 0 24 24" role="img">
      <text x="12" y="16.5" text-anchor="middle">译</text>
    </svg>
    <svg v-else-if="service === 'doubao'" viewBox="0 0 24 24" role="img">
      <path d="M7.2 8.1c0-2.1 1.8-3.6 3.9-3.6 2 0 3.6 1.4 3.6 3.3 0 1.4-.7 2.5-1.8 3.2 1.5-.1 3.1.7 3.7 2.2.9 2.1-.6 4.3-2.9 4.8-2.3.5-4.4-.8-4.9-2.8-.3-1.2.1-2.4 1-3.3-1.4.1-2.6-.6-3.2-1.8-.3-.6-.4-1.3-.4-2Z" />
    </svg>
    <svg v-else-if="service === 'siliconCloud'" viewBox="0 0 24 24" role="img">
      <path d="M4 15.8c0-2.3 1.9-4.2 4.2-4.2.6-2.3 2.7-4 5.2-4 2.9 0 5.2 2.2 5.4 5 1.1.4 1.9 1.4 1.9 2.7 0 1.7-1.4 3.1-3.1 3.1H7.2A3.2 3.2 0 0 1 4 15.8Z" />
      <path d="M8 15.7c1.4-1.4 2.6-1.4 3.8 0 1.2 1.4 2.4 1.4 3.8 0" />
    </svg>
    <svg v-else-if="service === 'openrouter'" viewBox="0 0 24 24" role="img">
      <circle cx="8" cy="8" r="2.1" />
      <circle cx="16" cy="16" r="2.1" />
      <path d="M9.5 9.5 14.5 14.5M16.5 8.5 19 6M5 18l2.5-2.5" />
    </svg>
    <svg v-else-if="service === 'grok'" viewBox="0 0 24 24" role="img">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m7.8 7.8 8.4 8.4M16.8 7.3l-4.1 4.1" />
    </svg>
    <svg v-else-if="service === 'newapi'" viewBox="0 0 24 24" role="img">
      <path d="m12 3.5 7 4v9l-7 4-7-4v-9l7-4Z" />
      <text x="12" y="15.8" text-anchor="middle">N</text>
    </svg>
    <span v-else class="service-brand-fallback">{{ fallbackGlyph }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI'

const props = withDefaults(defineProps<{
  service: string
  label?: string
  size?: 'small' | 'medium' | 'large' | 'model'
}>(), {
  label: '',
  size: 'medium',
})

const isCustomOpenAIService = computed(() => isCustomOpenAIProviderId(props.service))

const tone = computed(() => {
  if (isCustomOpenAIService.value) return 'violet'
  if (['openai', 'azureOpenai', 'newapi'].includes(props.service)) return 'violet'
  if (['deepseek', 'deepL', 'deeplx', 'microsoft', 'freeTranslation', 'myMemory'].includes(props.service)) return 'blue'
  if (['gemini', 'google', 'chromeTranslator'].includes(props.service)) return 'green'
  return 'rose'
})

const fallbackGlyph = computed(() => {
  const glyphs: Record<string, string> = {
    microsoft: 'M',
    freeTranslation: '译',
    myMemory: 'MM',
    google: 'G',
    deepL: 'D',
    deeplx: 'DX',
    xiaoniu: '小',
    youdao: '有',
    tencent: '云',
    chromeTranslator: 'C',
    openai: 'OAI',
    azureOpenai: 'A',
    gemini: '✦',
    yiyan: '文',
    tongyi: '通',
    zhipu: '智',
    moonshot: 'K',
    claude: '✳',
    custom: '+',
    infini: '∞',
    baichuan: '百',
    deepseek: 'DS',
    lingyi: '01',
    minimax: 'MM',
    mimo: 'Mi',
    jieyue: '阶',
    groq: 'G',
    huanYuan: '混',
    huanYuanTranslation: '译',
    doubao: '豆',
    siliconCloud: 'S',
    openrouter: 'O',
    grok: 'X',
    newapi: 'N',
  }
  return glyphs[props.service] || props.service.slice(0, 2).toUpperCase()
})
</script>

<style scoped>
.service-brand-icon {
  display: grid;
  place-items: center;
  flex: none;
  border-radius: 11px;
  color: #d42f60;
  background: #ffeaf0;
}

.service-brand-icon--small {
  width: 25px;
  height: 25px;
  border-radius: 8px;
}

.service-brand-icon--medium {
  width: 40px;
  height: 40px;
}

.service-brand-icon--large {
  width: 48px;
  height: 48px;
  border-radius: 14px;
}

.service-brand-icon--model {
  width: 30px;
  height: 30px;
  border-radius: 9px;
}

.service-brand-icon--blue {
  color: #2c65bb;
  background: #eaf2ff;
}

.service-brand-icon--green {
  color: #18835d;
  background: #e9f8f1;
}

.service-brand-icon--violet {
  color: #694bc2;
  background: #f0ebff;
}

.service-brand-icon[data-service='microsoft'] {
  background: #edf3ff;
}

.service-brand-icon[data-service='google'] {
  color: #4285f4;
  background: #edf3ff;
}

.service-brand-icon[data-service='deepL'],
.service-brand-icon[data-service='deeplx'] {
  color: #0f5bda;
  background: #eaf2ff;
}

.service-brand-icon[data-service='xiaoniu'],
.service-brand-icon[data-service='youdao'],
.service-brand-icon[data-service='doubao'] {
  color: #e52b62;
  background: #ffeaf0;
}

.service-brand-icon[data-service='tencent'],
.service-brand-icon[data-service='azureOpenai'] {
  color: #2f6fc3;
  background: #eaf2ff;
}

.service-brand-icon[data-service='chromeTranslator'] {
  color: #16825c;
  background: #e8f8f0;
}

.service-brand-icon[data-service='openai'] {
  color: #252a31;
  background: #f0f2f5;
}

.service-brand-icon[data-service='gemini'] {
  color: #5b56d6;
  background: #f0efff;
}

.service-brand-icon[data-service='claude'] {
  color: #b66b43;
  background: #fff0e8;
}

.service-brand-icon[data-service='deepseek'] {
  color: #4d6cff;
  background: #edf1ff;
}

.service-brand-icon[data-service='tongyi'],
.service-brand-icon[data-service='zhipu'],
.service-brand-icon[data-service='newapi'] {
  color: #6847c6;
  background: #f0ebff;
}

.service-brand-icon[data-service='moonshot'],
.service-brand-icon[data-service='lingyi'],
.service-brand-icon[data-service='baichuan'] {
  color: #3f64c6;
  background: #eaf2ff;
}

.service-brand-icon[data-service='infini'],
.service-brand-icon[data-service='openrouter'] {
  color: #2877c7;
  background: #eaf4ff;
}

.service-brand-icon[data-service='minimax'],
.service-brand-icon[data-service='mimo'],
.service-brand-icon[data-service='jieyue'],
.service-brand-icon[data-service='huanYuan'],
.service-brand-icon[data-service='huanYuanTranslation'] {
  color: #d42f60;
  background: #ffeaf0;
}

.service-brand-icon[data-service='groq'],
.service-brand-icon[data-service='grok'] {
  color: #22252c;
  background: #f0f2f5;
}

.service-brand-icon[data-service='siliconCloud'] {
  color: #16825c;
  background: #e8f8f0;
}

.service-brand-icon svg {
  width: 57%;
  height: 57%;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
  overflow: visible;
}

.service-brand-icon--small svg,
.service-brand-icon--model svg {
  width: 62%;
  height: 62%;
}

.service-brand-icon svg text {
  fill: currentColor;
  stroke: none;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  font-size: 14px;
  font-weight: 800;
  dominant-baseline: middle;
}

.service-brand-icon--small svg text,
.service-brand-icon--model svg text {
  font-size: 12px;
}

.service-brand-icon svg rect {
  stroke: none;
}

.service-brand-icon svg circle:first-child {
  fill: none;
}

.service-brand-fallback {
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.04em;
}
</style>
