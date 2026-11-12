<!--
 * @file src/features/image-translation/ui/MangaModelSettings.vue
 * 运行信息按需显示当前阶段、最近成功会话配置的执行提供程序与自动 CPU 回退状态。
 * 文件职责：提供图片与漫画共用本地模型的准备状态、真实进度、离线导入和缓存清理。
 * 主要内容：供漫画与单图共用，突出当前资源用途和准备状态，离线导入及清理收进次要入口；关闭漫画时只展示识别资源；图片识别的可选文字分割模型只在管理入口说明离线导入和就绪状态，不计入基础资源准备条件；定时读取后台模型缓存和下载快照，下载期间加快读取并显示进度条、百分比和已下载体积，错误会展开管理入口，离线文件经过资源服务校验才入库，保留部分成功并显示错误反馈；自动下载的来源与回退细节不进入用户界面。
 * 模块边界：不运行 OCR/修补、不下载远程代码、不上传选中文件；页面关闭只清理状态订阅，正在处理漫画的任务仍由 Offscreen 和页面取消入口管理。
 -->
<template>
  <section class="manga-model-settings" :class="{'is-embedded': embedded}" data-testid="manga-model-manager">
    <header class="manga-resource-heading" :class="{'settings-card-heading': !embedded}">
      <div><h2>{{ translateLegacy('标准识别') }}</h2><small>PaddleOCR · {{ translateLegacy(imageRecognition ? showInpainting ? '用于图片与漫画' : '用于图片翻译' : '用于漫画翻译') }}</small></div>
      <span class="manga-resource-current">{{ translateLegacy('当前使用') }}</span>
    </header>
    <div class="manga-resource-list">
      <div class="manga-resource"><div><strong>{{ translateLegacy('图片文字识别') }}</strong><small>{{ translateLegacy('约 30 MB') }}</small></div><span class="manga-resource-state" :class="{ready: status?.ready}">{{ translateLegacy(!status ? '正在检查' : status.ready ? '已就绪' : '未下载') }}</span></div>
      <div v-if="showInpainting" class="manga-resource"><div><strong>{{ translateLegacy('背景文字清除') }}</strong><small>{{ translateLegacy('约 197 MB') }}</small></div><span class="manga-resource-state" :class="{ready: status?.inpaintingReady}">{{ translateLegacy(!status ? '正在检查' : status.inpaintingReady ? '已就绪' : '需要时下载') }}</span></div>
    </div>
    <p class="manga-resource-hint">{{ translateLegacy('首次翻译时自动准备资源') }}</p>
    <div v-if="status?.download" class="manga-model-progress" role="status" data-i18n-ignore>
      <strong>{{ translateLegacy(phaseLabel) }}</strong><span>{{ Math.min(100, Math.floor(status.download.loaded * 100 / status.download.total)) }}% · {{ Math.round(status.download.loaded / 1048576) }} / {{ Math.round(status.download.total / 1048576) }} MB</span>
      <progress v-if="downloading" :value="status.download.loaded" :max="status.download.total" />
    </div>
    <small v-if="error || statusError" class="manga-model-error" role="alert" data-i18n-ignore>{{ error || statusError }}</small>
    <details class="manga-download-settings" :open="!!error || !!statusError || status?.download?.phase === 'error'">
      <summary>{{ translateLegacy('下载与管理') }}</summary>
      <div v-if="imageRecognition" class="manga-resource manga-optional-segmentation" data-testid="manga-optional-segmentation">
        <div><strong>{{ translateLegacy('精确文字分割（可选）') }}</strong><small>{{ translateLegacy('约 90 MB · 仅离线导入') }}</small><code data-i18n-ignore>{{ MANGA_TEXT_SEGMENTATION_ASSET.file }}</code></div>
        <span class="manga-resource-state" :class="{ready: status?.segmentationReady}">{{ translateLegacy(!status ? '正在检查' : status.segmentationReady ? '已就绪' : '未导入') }}</span>
      </div>
      <div class="manga-model-controls"><button type="button" :disabled="busy || downloading" @click="input?.click()">{{ translateLegacy('导入已下载文件') }}</button><input ref="input" hidden type="file" multiple accept=".onnx,.txt" @change="importFiles" /></div>
      <div v-if="status?.bytes" class="manga-model-storage"><small>{{ translateLegacy('已占用空间') }} · {{ Math.round(status.bytes / 1048576) }} MB</small><button type="button" :disabled="busy || downloading" @click="remove">{{ translateLegacy('清除已下载资源') }}</button></div>
    </details>
    <details v-if="status?.inference" class="manga-inference-diagnostics">
      <summary>{{ translateLegacy('运行信息') }}</summary>
      <p>{{ translateLegacy('当前处理阶段') }} · {{ translateLegacy(stageLabel) }}</p>
      <p>{{ translateLegacy('最近会话后端') }} · <span data-i18n-ignore>{{ status.inference.executionProviders.join(' / ') || '—' }}</span></p>
      <p v-if="status.inference.cpuFallback">{{ translateLegacy('已自动回退 CPU（WASM）') }}</p>
    </details>
  </section>
</template>
<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import browser from 'webextension-polyfill';
import {useUiI18n} from '@/src/ui/i18n';
import {importMangaModel,MANGA_TEXT_SEGMENTATION_ASSET,type MangaDownloadState} from '../services/mangaOcrAssets';
import type {MangaInferenceDiagnostics} from '../services/mangaInferenceClient';
withDefaults(defineProps<{showInpainting?: boolean; embedded?: boolean; imageRecognition?: boolean}>(),{showInpainting:true,embedded:false,imageRecognition:true});
const {translateLegacy}=useUiI18n();
const status=ref<{ready:boolean;inpaintingReady?:boolean;segmentationReady?:boolean;bytes:number;download?:MangaDownloadState;inference?:MangaInferenceDiagnostics}|null>(null);
const stageLabel=computed(()=>({idle:'等待任务',preparing:'正在准备资源',initializing:'正在初始化本地模型…',recognizing:'正在处理图片',completed:'处理完成',canceled:'已取消',error:'处理失败'}[status.value?.inference?.stage ?? 'idle']));
const busy=ref(false),error=ref(''),statusError=ref(''),input=ref<HTMLInputElement>();
const downloading=computed(()=>['downloading','verifying'].includes(status.value?.download?.phase??''));
const phaseLabel=computed(()=>({downloading:'正在下载漫画模型',verifying:'正在校验漫画模型',paused:'漫画模型下载已暂停',error:'漫画模型下载未完成'}[status.value?.download?.phase??'downloading']));
let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
async function load(){
  const response=await browser.runtime.sendMessage({type:'fluentReadMangaModelStatus'}) as {success?:boolean;error?:string;ready:boolean;inpaintingReady?:boolean;segmentationReady?:boolean;bytes:number;download?:MangaDownloadState;inference?:MangaInferenceDiagnostics};
  if(!response?.success)throw new Error(response?.error||'漫画识别模型状态读取失败');
  if(!disposed){
    status.value=response;statusError.value='';
  }
}
async function refresh(){
  if(document.visibilityState==='hidden'){timer=setTimeout(()=>void refresh(),1500);return;}
  try {await load();}catch{if(!disposed)statusError.value=translateLegacy('漫画识别模型状态读取失败');}
  // 下载期间读得更勤，让进度条跟上真实字节数；空闲时保持原来的低频读取。
  finally {if(!disposed)timer=setTimeout(()=>void refresh(),downloading.value?500:1500);}
}
async function importFiles(event:Event){
  const files=Array.from((event.target as HTMLInputElement).files??[]);busy.value=true;error.value='';
  try{for(const file of files)await importMangaModel(file);}
  catch(cause){
    // 保留用户可以直接修正的文件校验提示，存储或网络边界的原始错误不暴露资源地址。
    const message=cause instanceof Error?cause.message:'';
    error.value=translateLegacy(['请选择配套的漫画模型文件','漫画识别模型文件不完整，请重试','漫画识别模型校验失败，请重试'].includes(message)?message:'漫画识别模型导入失败，请重试');
  }
  finally{busy.value=false;if(input.value)input.value.value='';await load().catch(()=>{error.value=translateLegacy('漫画识别模型状态读取失败');});}
}
async function remove(){
  busy.value=true;error.value='';
  try{const response=await browser.runtime.sendMessage({type:'fluentReadMangaModelRemove'}) as {success?:boolean;error?:string};
    if(!response?.success)throw new Error(response?.error||'漫画识别模型清除失败');await load();
  }catch{error.value=translateLegacy('漫画识别模型清除失败');}
  finally{busy.value=false;}
}
onMounted(()=>{void refresh();});
onBeforeUnmount(()=>{disposed=true;clearTimeout(timer);});
</script>
<style scoped>
.manga-model-settings{padding:20px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}
.manga-model-settings header{display:flex;align-items:center;justify-content:space-between;gap:12px}.manga-model-settings h2{margin:0;font-size:16px}.manga-model-settings header>span{font-size:12px;color:var(--el-text-color-secondary)}.manga-model-settings p{margin:6px 0;font-size:13px;line-height:1.6;color:var(--el-text-color-secondary)}.manga-model-settings small{display:block;font-size:12px;color:var(--el-text-color-secondary)}
.manga-resource-list{margin-top:12px}.manga-resource{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--el-border-color-lighter)}.manga-resource strong{font-size:14px}.manga-resource>span{font-size:12px;color:var(--el-text-color-secondary);flex-shrink:0}.manga-resource>span.ready{color:var(--el-color-success)}.manga-resource small{margin-top:3px}
.manga-model-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:12px 0 6px}.manga-model-settings button{border:1px solid var(--el-border-color);border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);cursor:pointer;flex-shrink:0}.manga-model-settings button:disabled{opacity:.5;cursor:default}.manga-model-settings :is(button,summary):focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}
.manga-model-progress{display:grid;gap:6px;margin-top:12px;padding:12px;border-radius:8px;background:var(--el-color-primary-light-9);font-size:13px}.manga-model-progress progress{width:100%;accent-color:var(--el-color-primary)}.manga-model-settings .manga-model-error{color:var(--el-color-danger);margin-top:8px}.manga-model-settings details{font-size:13px;margin-top:14px}.manga-model-settings summary{cursor:pointer}.manga-model-storage{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}.manga-download-settings>summary{font-weight:600}
@media(max-width:600px){.manga-model-settings{padding:16px}.manga-model-settings header{align-items:flex-start;flex-direction:column}.manga-resource{gap:8px}.manga-model-storage{align-items:flex-start;flex-direction:column}}

.manga-model-settings > header.settings-card-heading { margin: -20px -20px 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); border-radius: 11px 11px 0 0; }
.manga-model-settings.is-embedded { padding:0; border:0; border-radius:0; background:transparent; }
.is-embedded > header h2 { font-size:14px; }
.manga-resource-heading h2 { font-size:15px; }
.manga-resource-heading small { margin-top:4px; }
.manga-resource-heading > .manga-resource-current { padding:4px 9px; border-radius:6px; color:var(--brand-strong); background:var(--brand-soft); font-size:11px; }
.manga-resource { padding:14px 0; }
.manga-resource:last-child { border-bottom:0; }
.manga-resource-state { padding:4px 9px; border-radius:6px; background:var(--surface-soft); }
.manga-resource-state.ready { background:var(--el-color-success-light-9); }
.manga-model-settings .manga-resource-hint { margin:4px 0 12px; font-size:12px; }
.manga-download-settings { border-top:1px solid var(--line); }
:global(.settings-app .workspace .settings-card .manga-model-settings details > summary) { min-height:36px; padding:10px 0; border:0; border-radius:0; background:transparent; font-weight:550; }
.manga-model-settings .manga-model-controls { margin:4px 0 8px; }
.manga-optional-segmentation code { display:block; margin-top:5px; overflow-wrap:anywhere; font-size:11px; color:var(--el-text-color-secondary); }
</style>
