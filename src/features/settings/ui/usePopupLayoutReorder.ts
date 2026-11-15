/**
 * @file src/features/settings/ui/usePopupLayoutReorder.ts
 * 文件职责：为 Popup 布局编辑器和实时预览提供共享的拖放与键盘排序状态。
 * 主要内容：校验布局项目、根据放置几何位置计算插入方向，并在保留隐藏项目相对位置的前提下重排可见项目槽位；顺序未变化时不重复提交配置。
 * 模块边界：本模块只处理纯字符串顺序和浏览器拖放事件，不读取配置、不渲染界面，也不依赖具体 Popup 业务。
 */
import {ref} from 'vue'

export type PopupLayoutDropAxis = 'x' | 'y'
export type PopupLayoutDropPosition = 'before' | 'after'

export interface PopupLayoutReorderOptions {
  order: () => readonly string[]
  visibleIds: () => readonly string[]
  onUpdate: (order: string[], movedId: string) => void
}

export function usePopupLayoutReorder(options: PopupLayoutReorderOptions) {
  const draggedItem = ref<string | null>(null)
  const dropTarget = ref<string | null>(null)
  const dropPosition = ref<PopupLayoutDropPosition>('before')

  function currentOrder(): string[] {
    return [...options.order()]
  }

  function visibleOrder(order: readonly string[]): string[] {
    const orderIds = new Set(order)
    const seen = new Set<string>()
    return options.visibleIds().filter((id) => {
      if (!orderIds.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  function isValidVisibleId(id: string, order: readonly string[]): boolean {
    return visibleOrder(order).includes(id)
  }

  function eventTargetElement(event: DragEvent): {getBoundingClientRect: () => DOMRect} | null {
    const target = event.currentTarget
    if (!target || typeof (target as HTMLElement).getBoundingClientRect !== 'function') return null
    return target as HTMLElement
  }

  function getDropPosition(event: DragEvent, axis: PopupLayoutDropAxis): PopupLayoutDropPosition {
    const target = eventTargetElement(event)
    const bounds = target?.getBoundingClientRect()
    if (!bounds) return 'before'
    const coordinate = axis === 'x' ? event.clientX : event.clientY
    const midpoint = axis === 'x'
      ? bounds.left + bounds.width / 2
      : bounds.top + bounds.height / 2
    return coordinate < midpoint ? 'before' : 'after'
  }

  function reorderVisibleSlots(
    order: readonly string[],
    sourceId: string,
    targetId: string,
    position: PopupLayoutDropPosition,
  ): string[] | null {
    const visible = visibleOrder(order)
    const sourceIndex = visible.indexOf(sourceId)
    const targetIndex = visible.indexOf(targetId)

    const nextVisible = visible.filter((id) => id !== sourceId)
    const nextTargetIndex = targetIndex > sourceIndex ? targetIndex - 1 : targetIndex
    nextVisible.splice(nextTargetIndex + (position === 'after' ? 1 : 0), 0, sourceId)

    const visibleIds = new Set(visible)
    let nextVisibleIndex = 0
    const nextOrder = order.map((id) => visibleIds.has(id) ? nextVisible[nextVisibleIndex++] : id)
    return nextOrder.every((id, index) => id === order[index]) ? null : nextOrder
  }

  function start(event: DragEvent, id: string): void {
    const order = currentOrder()
    if (!isValidVisibleId(id, order)) {
      finish()
      return
    }
    draggedItem.value = id
    dropTarget.value = null
    dropPosition.value = 'before'
    event.dataTransfer?.setData('text/plain', id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function over(event: DragEvent, id: string, axis: PopupLayoutDropAxis = 'y'): void {
    const sourceId = draggedItem.value
    const order = currentOrder()
    if (!sourceId || sourceId === id || !isValidVisibleId(sourceId, order) || !isValidVisibleId(id, order)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropTarget.value = id
    dropPosition.value = getDropPosition(event, axis)
  }

  function drop(event: DragEvent, id: string, axis: PopupLayoutDropAxis = 'y'): void {
    event.preventDefault()
    const sourceId = draggedItem.value
    const order = currentOrder()
    if (!sourceId || sourceId === id || !isValidVisibleId(sourceId, order) || !isValidVisibleId(id, order)) {
      finish()
      return
    }
    const nextOrder = reorderVisibleSlots(order, sourceId, id, getDropPosition(event, axis))
    if (nextOrder) options.onUpdate(nextOrder, sourceId)
    finish()
  }

  function finish(): void {
    draggedItem.value = null
    dropTarget.value = null
    dropPosition.value = 'before'
  }

  function move(id: string, offset: -1 | 1): void {
    const order = currentOrder()
    const visible = visibleOrder(order)
    const currentIndex = visible.indexOf(id)
    if (currentIndex < 0) return
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex >= visible.length) return

    const nextVisible = [...visible]
    nextVisible.splice(currentIndex, 1)
    nextVisible.splice(targetIndex, 0, id)
    const visibleIds = new Set(visible)
    let nextVisibleIndex = 0
    options.onUpdate(
      order.map((orderId) => visibleIds.has(orderId) ? nextVisible[nextVisibleIndex++] : orderId),
      id,
    )
  }

  return {
    draggedItem,
    dropTarget,
    dropPosition,
    start,
    over,
    drop,
    finish,
    move,
  }
}
