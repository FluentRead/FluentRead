<script setup lang="ts">
import { computed, ref } from 'vue'

// Local, deterministic examples: never read visitor text or call a provider.
const props = withDefaults(
  defineProps<{ en?: boolean; variant?: 'reader' | 'card' | 'subtitles' | 'input' }>(),
  { en: false, variant: 'reader' }
)
const mode = ref('bilingual')
const revision = ref(0)
const action = ref(0)
const cue = ref(0)
const inserted = ref(false)
const wordOpen = ref(false)
const t = (zh: string, en: string) => (props.en ? en : zh)
const modes = computed(() => [
  { id: 'bilingual', label: t('双语对照', 'Bilingual') },
  { id: 'translation', label: t('仅译文', 'Translation') },
  { id: 'selection', label: t('划词翻译', 'Selection') },
])
const paragraphs = computed(() =>
  props.en
    ? [
        ['好奇心，让世界变得更大。', 'Curiosity makes your world bigger.'],
        [
          '每一种语言，都带来一种看世界的新方式。',
          'Every language offers a new way to see the world.',
        ],
        [
          '从一篇文章、一句话开始。让理解跟上你的好奇心。',
          'Start with an article or a sentence. Let understanding follow your curiosity.',
        ],
      ]
    : [
        ['Curiosity makes your world bigger.', '好奇心，让世界变得更大。'],
        [
          'Every language offers a new way to see the world.',
          '每一种语言，都带来一种看世界的新方式。',
        ],
        [
          'Start with an article or a sentence. Let understanding follow your curiosity.',
          '从一篇文章、一句话开始。让理解跟上你的好奇心。',
        ],
      ]
)
const actions = computed(() => [
  t('读懂', 'Meaning'),
  t('句法', 'Structure'),
  t('用法', 'Usage'),
  t('练习', 'Practice'),
])
const answers = computed(() => [
  t(
    '这里的 offers 表示“提供”。整句话在说：学习另一种语言，也是在发现另一种观察世界的方式。',
    '“Offers” means “provides.” The sentence suggests that a new language can also give you a new perspective.'
  ),
  t(
    'Every language 是主语；offers 是谓语；a new way 是宾语；to see the world 补充说明是哪一种方式。',
    'Subject: Every language. Verb: offers. Object: a new way. “To see the world” describes that way.'
  ),
  t(
    'a new way to + 动词：做某件事的新方式。例如：Reading offers a new way to learn.',
    'Use “a new way to” followed by a verb: Reading offers a new way to learn.'
  ),
  t(
    '试着补全这句话：Reading offers a new way to _____. 想好之后，点击下方查看一个参考答案。',
    'Complete this sentence: Reading offers a new way to _____. Choose the button below to see one possible answer.'
  ),
])
const practiceShown = ref(false)
const cues = [
  ['A small step can open a whole new world.', '一小步，也能打开一个全新的世界。'],
  ['Stay curious. There is always more to discover.', '保持好奇，总有新的发现。'],
  ['Let understanding follow your curiosity.', '让理解跟上你的好奇心。'],
]
function changeMode(next: string) {
  mode.value = next
  wordOpen.value = false
  revision.value++
}
function changeAction(index: number) {
  action.value = index
  practiceShown.value = false
}
</script>

<template>
  <div class="fr-demo" :class="`fr-demo-${variant}`" :data-demo="variant">
    <div class="fr-demo-chrome" aria-hidden="true">
      <span class="fr-window-dots"><i></i><i></i><i></i></span
      ><span>{{
        t('在熟悉的内容里，读懂另一种语言', 'Understand another language in the content you love')
      }}</span
      ><span class="fr-demo-brand">F<span>R</span></span>
    </div>

    <template v-if="variant === 'reader'">
      <div
        class="fr-demo-controls"
        role="group"
        :aria-label="t('演示显示方式', 'Demo display mode')"
      >
        <button
          v-for="option in modes"
          :key="option.id"
          type="button"
          :aria-pressed="mode === option.id"
          @click="changeMode(option.id)"
        >
          {{ option.label }}
        </button>
        <button
          type="button"
          class="fr-demo-restore"
          :aria-pressed="mode === 'original'"
          @click="changeMode('original')"
        >
          {{ t('原文', 'Original') }}
        </button>
      </div>
      <article class="fr-demo-article" :key="revision">
        <p class="fr-demo-kicker">THE READING ROOM <span>01 / 03</span></p>
        <h3>{{ t('A world worth exploring.', '值得探索的世界。') }}</h3>
        <div
          v-for="(paragraph, index) in paragraphs"
          :key="index"
          class="fr-demo-paragraph"
          :style="{ '--fr-delay': `${index * 160}ms` }"
        >
          <p v-if="mode !== 'translation'" class="fr-demo-original">
            <template v-if="mode === 'selection' && index === 1"
              ><button
                class="fr-demo-selected"
                type="button"
                :aria-expanded="wordOpen"
                @click="wordOpen = !wordOpen"
              >
                {{ paragraph[0] }}
              </button></template
            >
            <template v-else>{{ paragraph[0] }}</template>
          </p>
          <p v-if="mode === 'bilingual' || mode === 'translation'" class="fr-demo-translated">
            {{ paragraph[1] }}
          </p>
          <div
            v-if="mode === 'selection' && index === 1 && wordOpen"
            class="fr-demo-selection-result"
          >
            <strong>{{ t('划词翻译', 'Selection translation') }}</strong>
            <p>{{ paragraph[1] }}</p>
            <small>{{
              t('选中一句，就能看懂这一句。', 'Understand just the sentence you need.')
            }}</small>
          </div>
        </div>
      </article>
      <div class="fr-demo-bottom">
        <span aria-live="polite">{{
          mode === 'selection'
            ? t('点击高亮句子，查看译文', 'Select the highlighted sentence')
            : mode === 'original'
            ? t('已恢复原文', 'Original restored')
            : t('原文与译文，始终一目了然', 'Keep the original and translation in view')
        }}</span
        ><button type="button" @click="changeMode('bilingual')">
          {{ t('重播演示', 'Replay') }}
        </button>
      </div>
    </template>

    <template v-else-if="variant === 'card'">
      <div class="fr-demo-card-content">
        <p class="fr-demo-kicker">
          {{ t('划词翻译 · AI 深入讲解', 'SELECTION · AI EXPLANATION') }}
        </p>
        <blockquote>Every language offers a new way to see the world.</blockquote>
        <p class="fr-demo-card-translation">每一种语言，都带来一种看世界的新方式。</p>
        <div
          class="fr-demo-controls"
          role="group"
          :aria-label="t('学习动作示例', 'Example learning action')"
        >
          <button
            v-for="(label, index) in actions"
            :key="label"
            type="button"
            :aria-pressed="action === index"
            @click="changeAction(index)"
          >
            {{ label }}
          </button>
        </div>
        <div class="fr-demo-answer" :key="action" aria-live="polite">
          <strong>{{ actions[action] }}</strong>
          <p>{{ answers[action] }}</p>
          <template v-if="action === 3"
            ><button type="button" @click="practiceShown = !practiceShown">
              {{
                practiceShown ? t('收起答案', 'Hide answer') : t('查看参考答案', 'Show an answer')
              }}
            </button>
            <p v-if="practiceShown">Reading offers a new way to understand others.</p></template
          >
        </div>
        <p class="fr-demo-footnote">
          {{
            t(
              '先看懂，再学会表达。真实 AI 讲解需要配置服务。',
              'Understand first, then learn to express yourself. AI explanations require a configured service.'
            )
          }}
        </p>
      </div>
    </template>

    <template v-else-if="variant === 'subtitles'">
      <div class="fr-demo-video">
        <span class="fr-video-label">THE WORLD IN WORDS</span>
        <div class="fr-video-type">
          {{ t('保持好奇。', 'Stay curious.') }}<br /><span>{{
            t('继续探索。', 'Keep exploring.')
          }}</span>
        </div>
        <div class="fr-demo-caption" :key="cue">
          <p>{{ cues[cue][0] }}</p>
          <p>{{ cues[cue][1] }}</p>
        </div>
      </div>
      <div class="fr-demo-bottom">
        <span>{{ t('双语字幕演示', 'Bilingual subtitle demo') }}</span>
        <div
          class="fr-cue-controls"
          role="group"
          :aria-label="t('切换字幕片段', 'Choose a subtitle')"
        >
          <button
            v-for="(_, index) in cues"
            :key="index"
            type="button"
            :aria-pressed="cue === index"
            :aria-label="t(`第 ${index + 1} 句`, `Line ${index + 1}`)"
            @click="cue = index"
          >
            {{ index + 1 }}
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="fr-demo-input-content">
        <p class="fr-demo-kicker">
          {{ t('写好想法，再换一种语言', 'YOUR THOUGHTS, ANOTHER LANGUAGE') }}
        </p>
        <div class="fr-input-example">
          <p>感谢你的回复，我们明天继续讨论。</p>
          <p v-if="inserted" class="fr-demo-translated">
            Thank you for your reply. Let's continue our discussion tomorrow.
          </p>
        </div>
        <div class="fr-demo-input-actions">
          <span>{{ t('原文在前 · 译文在后', 'Original first · translation below') }}</span
          ><button type="button" :aria-pressed="inserted" @click="inserted = !inserted">
            {{ inserted ? t('恢复原文', 'Restore original') : t('翻译示例', 'Translate example') }}
          </button>
        </div>
      </div>
    </template>
    <p class="fr-demo-disclosure">
      {{ t('交互示例 · 不调用翻译服务', 'Interactive example · no translation requests') }}
    </p>
  </div>
</template>
