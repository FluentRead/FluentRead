import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

// 可见时播放本地示例；普通步骤可暂停查看，翻译动作可播放到结果后停留。
export function useDemoPlayback(
  root: Ref<HTMLElement | null>,
  count: number,
  autoplay = true,
  delay: number | readonly number[] = 2200
) {
  const step = ref(0)
  const playing = ref(autoplay)
  const reduced = ref(false)
  const running = ref(false)
  let visible = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopAt: number | undefined
  let observer: IntersectionObserver | undefined
  let preference: MediaQueryList | undefined
  function stopTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  function sync() {
    stopTimer()
    running.value = playing.value && !reduced.value && visible && !document.hidden
    if (running.value)
      timer = setTimeout(
        () => {
          step.value = (step.value + 1) % count
          if (step.value === stopAt) {
            stopAt = undefined
            playing.value = false
          }
          sync()
        },
        typeof delay === 'number' ? delay : delay[step.value]
      )
  }
  function choose(index: number) {
    stopAt = undefined
    playing.value = false
    step.value = index
  }
  function playThrough(start: number, end: number) {
    if (start < 0 || end <= start || end >= count) return
    stopAt = reduced.value ? undefined : end
    step.value = reduced.value ? end : start
    playing.value = !reduced.value
    sync()
  }
  function select(index: number, stages?: readonly number[]) {
    const start = stages ? stages[index] : index
    if (start === undefined || start < 0 || start >= count) return
    // 流程中的一个阶段可能包含多个动画帧。点击当前阶段时保留细分动作的位置。
    const end = stages ? stages[index + 1] ?? count : start + 1
    if (step.value >= start && step.value < end) {
      playing.value = !playing.value && !reduced.value
    } else {
      choose(start)
    }
    sync()
  }
  function replay() {
    stopAt = undefined
    step.value = reduced.value ? count - 1 : 0
    playing.value = !reduced.value
    sync()
  }
  function motion() {
    reduced.value = Boolean(preference?.matches)
    if (reduced.value) {
      stopAt = undefined
      playing.value = false
      step.value = count - 1
    }
    sync()
  }
  onMounted(() => {
    preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    motion()
    preference.addEventListener('change', motion)
    document.addEventListener('visibilitychange', sync)
    if (root.value) {
      observer = new IntersectionObserver(
        (entries) => {
          visible = entries[0].isIntersecting && entries[0].intersectionRatio >= 0.15
          sync()
        },
        { threshold: 0.15 }
      )
      observer.observe(root.value)
    }
  })
  const unwatch = watch(playing, sync)
  onBeforeUnmount(() => {
    stopTimer()
    observer?.disconnect()
    unwatch()
    preference?.removeEventListener('change', motion)
    document.removeEventListener('visibilitychange', sync)
  })
  return { step, playing, running, reduced, choose, select, playThrough, replay }
}
