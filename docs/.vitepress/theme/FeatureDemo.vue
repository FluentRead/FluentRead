<script setup lang="ts">
import { computed, ref } from 'vue'
import { withBase } from 'vitepress'
import { useDemoPlayback } from './useDemoPlayback'
import DocumentDemo from './DocumentDemo.vue'
import DemoSteps from './DemoSteps.vue'
const props = defineProps<{
  kind: 'webpage' | 'selection' | 'document' | 'image' | 'video'
  en?: boolean
}>()
const t = (zh: string, english: string) => (props.en ? english : zh)
const root = ref<HTMLElement | null>(null)
const translationDemo = props.kind === 'webpage' || props.kind === 'image'
const { step, playing, running, reduced, choose, select, playThrough, replay } = useDemoPlayback(
  root,
  props.kind === 'selection' ? 11 : 6,
  true,
  props.kind === 'selection'
    ? [550, 400, 1400, 1600, 1600, 1300, 1300, 1300, 650, 1800, 1300]
    : props.kind === 'document'
    ? [1400, 1000, 1100, 1100, 2200, 2600]
    : translationDemo
    ? [600, 1200, 900, 1600, 1600, 1800]
    : [600, 450, 900, 1600, 1600, 1800]
)
const revealed = computed(() => step.value >= 2)
const loading = computed(
  () => translationDemo && step.value >= 1 && step.value < (props.kind === 'webpage' ? 3 : 2)
)
const workflow = computed(
  () =>
    ({
      webpage: [
        t('打开网页', 'Open a page'),
        t('翻译网页', 'Translate'),
        t('双语阅读', 'Read both'),
      ],
      selection: [
        t('选中文字', 'Select text'),
        t('查看译文', 'See translation'),
        t('查词与朗读', 'Look up & listen'),
      ],
      document: [],
      image: [
        t('打开图片', 'Open an image'),
        t('识别并翻译', 'Read & translate'),
        t('查看译图', 'See the result'),
      ],
      video: [
        t('播放视频', 'Play a video'),
        t('翻译字幕', 'Translate captions'),
        t('双语观看', 'Watch both'),
      ],
    }[props.kind])
)
const activeStage = computed(() => {
  if (props.kind === 'selection') return step.value < 2 ? 0 : step.value === 2 ? 1 : 2
  if (props.kind === 'webpage') return step.value === 0 ? 0 : step.value < 3 ? 1 : 2
  return Math.min(step.value, 2)
})
const stageStarts = computed(() => {
  if (props.kind === 'selection') return [0, 2, 3]
  if (props.kind === 'webpage') return [0, 1, 3]
  if (props.kind === 'document') return [0, 1, 4]
  return [0, 1, 2]
})
function selectStage(index: number) {
  if (translationDemo && index === 1) {
    playThrough(1, stageStarts.value[2])
  } else {
    select(index, stageStarts.value)
  }
}
const word = computed(() => props.kind === 'selection' && step.value >= 8)
const structure = computed(() => props.kind === 'selection' && step.value >= 5 && step.value <= 7)
const activePart = computed(() => Math.min(2, Math.max(0, step.value - 5)))
const audioPreview = computed(() => {
  if (props.kind !== 'selection') return null
  return step.value === 3 ? 'original' : step.value === 4 ? 'translation' : null
})
const parts = [
  {
    text: 'A good book',
    role: t('主语', 'Subject'),
    type: t('名词短语', 'Noun phrase'),
    meaning: t('一本好书', 'a good book'),
    explanation: t('这句话在说什么？在说“一本好书”。', 'What is the sentence about? A good book.'),
  },
  {
    text: 'opens',
    role: t('谓语', 'Predicate'),
    type: t('动词', 'Verb'),
    meaning: t('打开', 'opens'),
    explanation: t(
      '这本书做了什么？为你“打开”新的世界。',
      'What does the book do? It opens something new.'
    ),
  },
  {
    text: 'a new world.',
    role: t('宾语', 'Object'),
    type: t('名词短语', 'Noun phrase'),
    meaning: t('一个新世界', 'a new world'),
    explanation: t('打开什么？“一个新世界”。', 'What does it open? A new world.'),
  },
]
const contexts = {
  webpage: t('阅读一篇英文文章', 'Read an article'),
  selection: t('选中词句，查看卡片', 'Select text, see a card'),
  document: t(
    '文档翻译 · 从文件到双语阅读',
    'Document translation · from file to bilingual reading'
  ),
  image: t('翻译漫画中的气泡', 'Translate a comic bubble'),
  video: t('视频字幕，双语呈现', 'Bilingual video captions'),
}
</script>
<template>
  <div
    ref="root"
    class="fd"
    :class="`fd-${kind}`"
    :data-demo="kind === 'webpage' ? 'brand-reader' : undefined"
    :data-visual="kind !== 'webpage' ? kind : undefined"
    :data-step="step"
    :data-playing="playing"
    :data-running="running"
    :data-loading="loading"
    :data-revealed="revealed"
    :data-word="word"
    :data-structure="structure"
  >
    <div class="fd-header">
      <span class="bv-dots" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
      </span>
      <span>{{ contexts[kind] }}</span>
      <img :src="withBase('/brand-icon.webp')" width="24" height="24" alt="" />
    </div>
    <DemoSteps
      v-if="kind !== 'document'"
      :labels="workflow"
      :active="activeStage"
      :label="t('操作流程', 'Workflow')"
      :playing="playing"
      :reduced="reduced"
      :en="en"
      :run-stages="translationDemo ? [1] : undefined"
      @select="selectStage"
    />
    <div class="fd-stage" :aria-busy="loading">
      <template v-if="kind === 'webpage'">
        <div class="fd-meta">
          <span>{{ t('英语 → 简体中文', 'Chinese → English') }}</span>
          <span class="fd-status" role="status">
            <i v-if="loading" class="fd-spinner" aria-hidden="true"></i>
            {{
              loading
                ? t('正在翻译…', 'Translating…')
                : revealed
                ? t('双语对照', 'Bilingual result')
                : t('等待翻译', 'Ready to translate')
            }}
          </span>
        </div>
        <article class="fd-article">
          <h3>{{ t('The joy of reading.', '阅读的乐趣。') }}</h3>
          <div class="fd-paragraph">
            <p>
              {{ t('Reading opens a window to the world.', '阅读为我们打开一扇了解世界的窗。') }}
            </p>
            <p
              class="fd-translation fd-reveal"
              :class="{ 'fd-loading-line': loading && !revealed }"
              :aria-hidden="!revealed"
            >
              <span
                v-if="loading && !revealed"
                class="fd-loading-bar"
                aria-hidden="true"
              ></span>
              <template v-else>
                {{ t('阅读为我们打开一扇了解世界的窗。', 'Reading opens a window to the world.') }}
              </template>
            </p>
          </div>
          <div class="fd-paragraph">
            <p>
              {{ t('A good book can take you somewhere new.', '一本好书能带你发现新的天地。') }}
            </p>
            <p
              class="fd-translation fd-reveal fd-second"
              :class="{ 'fd-loading-line': loading }"
              :aria-hidden="step < 3"
            >
              <span v-if="loading" class="fd-loading-bar" aria-hidden="true"></span>
              <template v-else>
                {{ t('一本好书能带你发现新的天地。', 'A good book can take you somewhere new.') }}
              </template>
            </p>
          </div>
        </article>
      </template>
      <template v-else-if="kind === 'selection'">
        <p class="fd-selection-source">
          <span v-if="word">
            Stay
            <mark class="selected">curious</mark>
            . Keep exploring.
          </span>
          <mark v-else :class="{ selected: step >= 1 }">A good book opens a new world.</mark>
        </p>
        <div class="fd-card-stack">
          <section
            class="fd-selection-card fd-sentence-card fd-reveal"
            :class="{ 'fd-hidden': word || structure }"
            :aria-hidden="!revealed || word || structure"
            :aria-label="t('句子翻译卡片示例', 'Sentence translation card example')"
          >
            <div class="fd-card-bar">
              <strong>{{ t('简体中文', 'Simplified Chinese') }}</strong>
              <span>{{ t('卡片模式', 'Card mode') }}</span>
            </div>
            <div class="fd-study-bar">
              {{ t('词性与句法 · 用法 · 练习', 'Sentence structure · Usage · Practice') }}
            </div>
            <div class="fd-card-body">
              <small>{{ t('原文', 'Original') }}</small>
              <p>A good book opens a new world.</p>
              <small>{{ t('译文', 'Translation') }}</small>
              <p class="fd-card-translation">一本好书为你打开一个新世界。</p>
            </div>
          </section>
          <section
            class="fd-selection-card fd-structure-card"
            :class="{ 'fd-hidden': !structure }"
            :aria-hidden="!structure"
            :aria-label="t('句子结构卡片示例', 'Sentence structure card example')"
          >
            <div class="fd-card-bar">
              <strong>{{ t('词性与句法', 'Sentence structure') }}</strong>
              <span>{{ t('卡片模式', 'Card mode') }}</span>
            </div>
            <div class="fd-card-body">
              <div
                class="fd-structure-parts"
                :aria-label="t('句子的三个部分', 'Three sentence parts')"
              >
                <button
                  v-for="(part, index) in parts"
                  :key="part.role"
                  type="button"
                  :class="[`fd-part-${index}`, { 'fd-part-active': activePart === index }]"
                  :aria-pressed="activePart === index"
                  :tabindex="structure ? 0 : -1"
                  @click="choose(5 + index)"
                >
                  <span>{{ part.text }}</span>
                  <small>{{ part.role }}</small>
                  <small>{{ part.type }}</small>
                </button>
              </div>
              <p class="fd-structure-translation">一本好书为你打开一个新世界。</p>
              <div class="fd-structure-explanation" aria-live="polite">
                <p>
                  <b>{{ parts[activePart].text }}</b>
                  {{ parts[activePart].meaning }}
                </p>
                <p>{{ parts[activePart].explanation }}</p>
              </div>
            </div>
          </section>
          <section
            class="fd-selection-card fd-word-card"
            :class="{ 'fd-hidden': !word }"
            :aria-hidden="!word"
            :aria-label="t('单词学习卡片示例', 'Word learning card example')"
          >
            <div class="fd-card-bar">
              <strong>{{ t('简体中文', 'Simplified Chinese') }}</strong>
              <span>{{ t('卡片模式', 'Card mode') }}</span>
            </div>
            <div class="fd-card-body">
              <h3>curious</h3>
              <div class="fd-phonetic">
                /ˈkjʊəriəs/
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4Z" />
                  <path d="M16 9.5a4.5 4.5 0 0 1 0 5" />
                </svg>
              </div>
              <p class="fd-word-meaning">
                <b>adj.</b>
                好奇的；求知欲强的
              </p>
              <p class="fd-definition">Eager to know or learn.</p>
              <small>{{ t('例句', 'Example') }}</small>
              <p>Stay curious about the world.</p>
              <p class="fd-card-translation">对世界保持好奇。</p>
            </div>
          </section>
        </div>
        <div class="fd-audio-actions" :aria-label="t('朗读动作示意', 'Read-aloud preview')">
          <button
            v-for="target in (['original', 'translation'] as const)"
            :key="target"
            type="button"
            :class="{ 'fd-audio-active': audioPreview === target }"
            :aria-pressed="audioPreview === target"
            :aria-label="
              target === 'original'
                ? t('演示朗读原文', 'Preview reading the original')
                : t('演示朗读译文', 'Preview reading the translation')
            "
            @click="choose(target === 'original' ? 3 : 4)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9v6h4l5 4V5L8 9H4Z" />
              <path d="M16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12" />
            </svg>
            {{
              target === 'original'
                ? t('朗读原文', 'Read original')
                : t('朗读译文', 'Read translation')
            }}
            <span class="fd-sound-wave" aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
            </span>
          </button>
        </div>
        <p class="fd-audio-note">
          {{ t('朗读动作示意，不播放声音', 'Read-aloud preview · no sound') }}
        </p>
      </template>
      <DocumentDemo
        v-else-if="kind === 'document'"
        :step="step"
        :en="en"
        :playing="playing"
        :reduced="reduced"
        @select="select($event, stageStarts)"
      />
      <template v-else-if="kind === 'image'">
        <div class="fd-meta">
          <span>{{ t('漫画原图', 'Comic image') }}</span>
          <span class="fd-status" role="status">
            <i v-if="loading" class="fd-spinner" aria-hidden="true"></i>
            {{
              loading
                ? t('识别并翻译中…', 'Reading & translating…')
                : revealed
                ? t('译文回到原图', 'Translation on the image')
                : t('等待识别', 'Ready to read the text')
            }}
          </span>
        </div>
        <div class="fd-comic">
          <div class="fd-bubble">
            <span v-if="loading" class="fd-comic-scan" aria-hidden="true"></span>
            <span class="fd-layer" :class="{ 'fd-hidden': revealed }" :aria-hidden="revealed">
              Let's explore the world!
            </span>
            <span class="fd-layer fd-reveal" :aria-hidden="!revealed">一起探索世界吧！</span>
          </div>
          <svg
            viewBox="0 0 380 160"
            role="img"
            :aria-label="t('一个正在读书的漫画人物', 'A comic character reading a book')"
          >
            <path d="M20 138h340M30 45h76v80M44 63h47M44 83h47M302 62h42v64M306 79h32M305 99h32" />
            <circle cx="190" cy="61" r="27" />
            <path
              d="M164 55q25-42 51 1M181 65h1M199 65h1M183 78q7 5 14-1M157 139v-32q7-18 33-18t33 18v32M154 113l19 18M226 113l-19 18"
            />
            <path class="fd-comic-book" d="m174 104 16 5 16-5v30l-16 5-16-5Zm16 5v30" />
          </svg>
        </div>
      </template>
      <template v-else>
        <div class="fd-meta">
          <span>YouTube · X · {{ t('网页会议', 'Web meetings') }}</span>
          <span>
            {{
              revealed ? t('双语字幕', 'Bilingual captions') : t('读取字幕…', 'Reading captions…')
            }}
          </span>
        </div>
        <div class="fd-player">
          <svg viewBox="0 0 500 260" aria-hidden="true">
            <path
              d="M0 200 140 70l100 90L350 40l150 160M0 220h500M250 22v32M210 34l14 12M290 34l-14 12"
            />
            <circle cx="250" cy="85" r="20" />
          </svg>
          <div class="fd-captions">
            <p>There is so much to discover.</p>
            <p class="fd-reveal" :aria-hidden="!revealed">还有那么多值得发现的事。</p>
          </div>
        </div>
      </template>
    </div>
    <div class="fd-footer">
      <small>
        {{
          reduced
            ? t('示例内容', 'Sample content')
            : t('自动演示 · 示例内容', 'Auto demo · sample content')
        }}
      </small>
      <div>
        <button
          v-if="!reduced"
          type="button"
          @click="playing = !playing"
          :aria-label="
            playing
              ? t('暂停自动演示', 'Pause automatic demo')
              : t('播放自动演示', 'Play automatic demo')
          "
        >
          {{ playing ? t('Ⅱ 暂停', 'Ⅱ Pause') : t('▷ 播放', '▷ Play') }}
        </button>
        <button type="button" @click="replay">
          {{ t('↻ 重播', '↻ Replay') }}
        </button>
      </div>
    </div>
  </div>
</template>
