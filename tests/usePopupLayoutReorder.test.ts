import {describe, expect, it} from 'vitest'
import {usePopupLayoutReorder} from '@/src/features/settings/ui/usePopupLayoutReorder'

function dragEvent(clientX: number, clientY: number, rect = {
  left: 0,
  top: 0,
  width: 100,
  height: 40,
}) {
  return {
    clientX,
    clientY,
    currentTarget: {getBoundingClientRect: () => rect},
    preventDefault: () => undefined,
    dataTransfer: {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: () => undefined,
    },
  } as unknown as DragEvent
}

function dragEventWithoutTarget(clientX: number, clientY: number) {
  return {
    clientX,
    clientY,
    preventDefault: () => undefined,
    dataTransfer: {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: () => undefined,
    },
  } as unknown as DragEvent
}

function createController(order: string[], visibleIds: string[]) {
  const updates: Array<{order: string[]; movedId: string}> = []
  const controller = usePopupLayoutReorder({
    order: () => order,
    visibleIds: () => visibleIds,
    onUpdate: (nextOrder, movedId) => {
      updates.push({order: nextOrder, movedId})
      order.splice(0, order.length, ...nextOrder)
    },
  })
  return {controller, updates}
}

describe('usePopupLayoutReorder', () => {
  it('accepts dragover without a transfer object and skips saving an unchanged drop order', () => {
    const {controller,updates}=createController(['a','b','c'],['a','b','c'])
    controller.start(dragEvent(0,0),'a')
    const over=dragEvent(0,0);Object.defineProperty(over,'dataTransfer',{value:null})
    controller.over(over,'b');expect(controller.dropTarget.value).toBe('b')
    controller.drop(dragEvent(0,0),'b')
    expect(updates).toEqual([]);expect(controller.draggedItem.value).toBeNull()
  })
  it('reorders visible slots while preserving hidden entries in their slots', () => {
    const {controller, updates} = createController(
      ['translation', 'hidden-site', 'quickFeatures', 'footer'],
      ['translation', 'quickFeatures', 'footer'],
    )

    controller.start(dragEvent(10, 10), 'footer')
    controller.drop(dragEvent(10, 10), 'translation')

    expect(updates).toEqual([{
      order: ['footer', 'hidden-site', 'translation', 'quickFeatures'],
      movedId: 'footer',
    }])
    expect(controller.draggedItem.value).toBeNull()
    expect(controller.dropTarget.value).toBeNull()
  })

  it('uses the target midpoint to distinguish before and after drops on either axis', () => {
    const vertical = createController(['a', 'b', 'c'], ['a', 'b', 'c'])
    vertical.controller.start(dragEvent(0, 1), 'a')
    vertical.controller.drop(dragEvent(0, 39), 'b', 'y')
    expect(vertical.updates[0]?.order).toEqual(['b', 'a', 'c'])

    const horizontal = createController(['a', 'b', 'c'], ['a', 'b', 'c'])
    horizontal.controller.start(dragEvent(1, 0), 'c')
    horizontal.controller.drop(dragEvent(1, 0, {left: 0, top: 0, width: 100, height: 20}), 'a', 'x')
    expect(horizontal.updates[0]?.order).toEqual(['c', 'a', 'b'])
  })

  it('moves keyboard-visible items and leaves hidden slots untouched', () => {
    const {controller, updates} = createController(
      ['a', 'hidden', 'b', 'c'],
      ['a', 'b', 'c'],
    )

    controller.move('c', -1)

    expect(updates).toEqual([{
      order: ['a', 'hidden', 'c', 'b'],
      movedId: 'c',
    }])
  })

  it('ignores unknown ids and attempts beyond either visible boundary for keyboard moves', () => {
    const {controller, updates} = createController(['a', 'hidden', 'b'], ['a', 'b'])

    controller.move('external', 1)
    controller.move('a', -1)
    controller.move('b', 1)

    expect(updates).toEqual([])
  })

  it('filters visible ids that are absent from the order and duplicate registrations', () => {
    const {controller, updates} = createController(['a', 'b'], ['a', 'external', 'a', 'b'])

    controller.move('a', 1)

    expect(updates).toEqual([{
      order: ['b', 'a'],
      movedId: 'a',
    }])
  })

  it('rejects unknown or hidden external drag ids without updating', () => {
    const {controller, updates} = createController(
      ['a', 'hidden', 'b'],
      ['a', 'b'],
    )

    controller.start(dragEvent(0, 0), 'external')
    expect(controller.draggedItem.value).toBeNull()
    controller.start(dragEvent(0, 0), 'a')
    controller.over(dragEvent(0, 0), 'hidden')
    controller.drop(dragEvent(0, 0), 'hidden')

    expect(updates).toEqual([])
    expect(controller.draggedItem.value).toBeNull()
    expect(controller.dropTarget.value).toBeNull()
  })

  it('cancels an active drag without emitting a layout update', () => {
    const {controller, updates} = createController(['a', 'b'], ['a', 'b'])

    controller.start(dragEvent(0, 0), 'a')
    controller.over(dragEvent(0, 1), 'b')
    controller.finish()

    expect(updates).toEqual([])
    expect(controller.draggedItem.value).toBeNull()
    expect(controller.dropTarget.value).toBeNull()
    expect(controller.dropPosition.value).toBe('before')
  })

  it('uses a stable before fallback when a drag event has no measurable target', () => {
    const {controller, updates} = createController(['a', 'b'], ['a', 'b'])

    controller.start(dragEvent(0, 0), 'b')
    controller.over(dragEventWithoutTarget(0, 0), 'a')
    controller.drop(dragEventWithoutTarget(0, 0), 'a')

    expect(updates).toEqual([{
      order: ['b', 'a'],
      movedId: 'b',
    }])
  })
})
