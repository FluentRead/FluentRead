<!--
 @file src/ui/components/ServiceIcon.vue
 文件职责：为翻译服务和模型选项提供统一品牌图标组件，在没有专用品牌图形时输出统一几何图标。
 主要内容：根据 service、label、size 与 model props 选择尺寸和色调，读取固定版本 Lobe Icons 的单色路径，为品牌、内置及动态 OpenAI-compatible 服务渲染内联 SVG；路径与 MIT 许可来源见 docs/development/service-icons.md。
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
    <svg v-if="brandIcon" viewBox="0 0 24 24" class="service-brand-mark" role="img" data-brand-icon="true" fill-rule="evenodd">
      <path v-for="(attributes, index) in brandIcon" :key="index" v-bind="attributes" />
    </svg>
    <svg v-else-if="service === 'microsoft'" viewBox="0 0 24 24" role="img">
      <rect x="3" y="3" width="8" height="8" fill="#f35325" />
      <rect x="13" y="3" width="8" height="8" fill="#81bc06" />
      <rect x="3" y="13" width="8" height="8" fill="#05a6f0" />
      <rect x="13" y="13" width="8" height="8" fill="#ffba08" />
    </svg>
    <svg v-else-if="service === 'bilibili' || service === 'bilibiliFree'" viewBox="0 0 24 24" role="img"><path d="M7 6h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" /><path d="m8 2 3 4m5-4-3 4M8 11v4m8-4v4m-6 2h4" /></svg>
    <svg v-else-if="service === 'freeTranslation'" viewBox="0 0 24 24" role="img">
      <path d="M5 7h10M5 12h7M5 17h5" />
      <path d="m15 9 4 3-4 3M19 12H9" />
    </svg>
    <svg v-else-if="service === 'yandexFree'" viewBox="0 0 24 24" role="img"><path d="M15 4h-3a5 5 0 0 0 0 10h3M15 4v16M12 14l-5 6" /></svg>
    <svg v-else-if="service === 'volcengineFree'" viewBox="0 0 24 24" role="img"><path d="m4 19 7-14 2 7 3-4 4 11H4Z" /></svg>
    <svg v-else-if="['youdaoFree', 'sogouFree', 'reversoFree', 'lingvaFree', 'apertiumFree'].includes(service)" viewBox="0 0 24 24" role="img">
      <path d="M5 6h14M7 6v3a5 5 0 0 0 10 0V6M12 4v16M8 20h8" />
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
    <svg v-else-if="service === 'deeplx'" viewBox="0 0 24 24" role="img">
      <path d="M4.5 4.5h8.7a5.8 5.8 0 1 1 0 11.6H9.5l-5 3.4V4.5Z" />
      <path d="m10.5 10 5 6m0-6-5 6" />
    </svg>
    <svg v-else-if="service === 'xiaoniu'" viewBox="0 0 24 24" role="img">
      <path d="M7 8.5 4.3 5.6M17 8.5l2.7-2.9M6.1 10.5a5.9 5.9 0 0 1 11.8 0v4.1a5.9 5.9 0 0 1-11.8 0v-4.1Z" />
      <path d="M9 13h.1M15 13h.1M10 16c1.2.8 2.8.8 4 0" />
    </svg>
    <svg v-else-if="service === 'youdao'" viewBox="0 0 24 24" role="img">
      <path d="M5 5h10a3 3 0 0 1 3 3v9h-7l-6 3V5ZM8 9h7M8 12h5" />
    </svg>
    <svg v-else-if="service === 'transmart'" viewBox="0 0 24 24" role="img">
      <path d="M5 11.5c0-3.7 3.1-6.5 7-6.5s7 2.8 7 6.5-3.1 6.5-7 6.5c-1.1 0-2.2-.2-3.1-.7L5 19l1.2-3.1A6.2 6.2 0 0 1 5 11.5Z" />
      <path d="m12 7.2 1.1 2.2 2.4.4-1.7 1.7.4 2.4-2.2-1.1-2.2 1.1.4-2.4-1.7-1.7 2.4-.4L12 7.2Z" />
    </svg>
    <svg v-else-if="service === 'chromeTranslator'" viewBox="0 0 24 24" role="img">
      <path d="M12 4a8 8 0 0 1 6.9 4H12a4 4 0 0 0 0 8h.2A8 8 0 1 1 12 4Z" />
      <path d="M12 8h6.9M12 16l3.5-6" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
    <svg v-else-if="service === 'localTranslation'" viewBox="0 0 24 24" role="img">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M8 9h8M8 13h5M8 16h3" />
      <path d="m16 13 2 2-2 2" />
    </svg>
    <svg v-else-if="isCustomOpenAIService" viewBox="0 0 24 24" role="img">
      <path d="M12 5v14M5 12h14" />
    </svg>
    <svg v-else viewBox="0 0 24 24" role="img" data-service-icon-fallback="true">
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4 7.5l8 4.5 8-4.5M12 12v9" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import serviceBrandPaths from '@/src/ui/assets/serviceBrandPaths.json'
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
  if (['gemini', 'google', 'chromeTranslator', 'localTranslation', 'ollama', 'googleCloudTranslation'].includes(props.service)) return 'green'
  if (['azureTranslator', 'tencent', 'baiduTranslation'].includes(props.service)) return 'blue'
  if (['mistral', 'cohere', 'cerebras', 'togetherai', 'fireworks', 'deepinfra', 'perplexity'].includes(props.service)) return 'violet'
  return 'rose'
})

const brandIcon = computed(() => Object.hasOwn(serviceBrandPaths, props.service)
  ? serviceBrandPaths[props.service as keyof typeof serviceBrandPaths]
  : undefined)
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
.service-brand-icon[data-service='azureTranslator'],
.service-brand-icon[data-service='azureOpenai'] {
  color: #2f6fc3;
  background: #eaf2ff;
}

.service-brand-icon[data-service='googleCloudTranslation'] {
  color: #1a73e8;
  background: #edf3ff;
}

.service-brand-icon[data-service='aliyunTranslation'] {
  color: #e8681c;
  background: #fff1e8;
}

.service-brand-icon[data-service='baiduTranslation'] {
  color: #2932e1;
  background: #ecedff;
}

.service-brand-icon[data-service='volcTranslation'] {
  color: #d94a2a;
  background: #fff0ec;
}

.service-brand-icon[data-service='ollama'] {
  color: #2f3a48;
  background: #eef1f5;
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

.service-brand-icon svg rect {
  stroke: none;
}

.service-brand-icon svg circle:first-child {
  fill: none;
}

.service-brand-icon svg.service-brand-mark { fill: currentColor; stroke: none; }
</style>
