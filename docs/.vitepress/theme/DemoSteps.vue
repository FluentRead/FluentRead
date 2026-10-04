<script setup lang="ts">
const props = defineProps<{
  labels: string[]
  active: number
  label: string
  playing: boolean
  reduced?: boolean
  en?: boolean
  runStages?: readonly number[]
}>()
defineEmits<{ select: [index: number] }>()
function action(index: number) {
  if (props.runStages?.includes(index)) {
    if (props.reduced) return props.en ? 'View the translation result' : '查看翻译结果'
    return props.en ? 'Play the translation' : '演示翻译过程'
  }
  if (props.reduced) return props.en ? 'View this step' : '查看此步骤'
  if (index !== props.active) return props.en ? 'Go to this step and pause' : '跳转到此步骤并暂停'
  if (props.playing) return props.en ? 'Pause at this step' : '暂停在此步骤'
  return props.en ? 'Resume autoplay' : '继续自动播放'
}
</script>
<template>
  <ol class="ds" :aria-label="label">
    <li
      v-for="(text, index) in labels"
      :key="text"
      :class="{ 'ds-current': index === active, 'ds-done': index < active }"
      :aria-current="index === active ? 'step' : undefined"
    >
      <button
        type="button"
        :title="action(index)"
        :aria-label="`${text}${en ? ': ' : '，'}${action(index)}`"
        @click="$emit('select', index)"
      >
        <span aria-hidden="true">{{ index < active ? '✓' : index + 1 }}</span>
        {{ text }}
      </button>
    </li>
  </ol>
</template>
<style scoped>
.ds {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 24px;
  margin: 0;
  padding: 14px 20px;
  list-style: none;
  color: var(--fr-muted);
  font-size: 11px;
  line-height: 1.5;
}
.ds li {
  min-width: 0;
  margin: 0;
}
.ds button {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 28px;
  margin: 0;
  padding: 4px 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ds button:hover {
  color: var(--vp-c-brand-1);
}
.ds button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.ds button > span {
  display: grid;
  place-items: center;
  flex: none;
  width: 17px;
  height: 17px;
  border: 1px solid var(--fr-line);
  border-radius: 50%;
  font-size: 9px;
}
.ds .ds-current {
  color: var(--vp-c-brand-1);
  font-weight: 650;
}
.ds-current button > span {
  border-color: #ecc2cf !important;
  background: #fff4f7;
}
.ds-done button > span {
  color: #39796c;
}
@container (max-width: 470px) {
  .ds {
    gap: 12px;
    padding-inline: 12px;
    font-size: 10px;
  }
}
@container (max-width: 320px) {
  .ds {
    gap: 8px;
    font-size: 9px;
  }
  .ds button {
    gap: 4px;
  }
}
</style>
