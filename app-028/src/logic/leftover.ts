/**
 * 余料登记与消耗的纯逻辑（不依赖响应式状态，便于自检断言）。
 * 规则：
 * - 登记带来源（哪个任务、第几张纸、纸上位置），同一来源同一位置只保留一条；
 * - 太窄的条（任一边 < LEFTOVER_MIN_USABLE_MM）也登记，但标记不可再当相纸；
 * - 被任务排样用掉后整张记为「已用完」（物理上已裁开），已用完的不许再选、不再消耗。
 */
import type { Leftover } from './types'

/** 余料能再当相纸用的最小边长（mm）：任一边不足即记为「太窄」，只登记占位 */
export const LEFTOVER_MIN_USABLE_MM = 8

export type LeftoverStatus = 'usable' | 'narrow' | 'exhausted'

export function leftoverStatus(l: Leftover): LeftoverStatus {
  if (l.exhausted) return 'exhausted'
  if (l.unusable) return 'narrow'
  return 'usable'
}

/** 剩余可用面积 mm²：已用完归 0；太窄的仍占地方，面积照算但不可再选 */
export function leftoverRemainingAreaMm2(l: Leftover): number {
  return l.exhausted ? 0 : l.wMm * l.hMm
}

/** 排样剩下的纸边是否够尺寸再当相纸（兼容早期没有 usable 标记的数据） */
export function wasteRectUsable(r: { w: number; h: number; usable?: boolean }): boolean {
  return r.usable ?? (r.w >= LEFTOVER_MIN_USABLE_MM && r.h >= LEFTOVER_MIN_USABLE_MM)
}

const r1 = (v: number | undefined): number => Math.round((v ?? 0) * 10) / 10

type SourceKey = Pick<
  Leftover,
  'name' | 'wMm' | 'hMm' | 'sourceTaskId' | 'sourceSheetNo' | 'sourceX' | 'sourceY'
>

/** 同一块余料的判定：有来源的按「任务 + 第几张 + 位置 + 尺寸」，无来源的按「名称 + 尺寸」 */
export function sameLeftoverSource(a: SourceKey, b: SourceKey): boolean {
  if (a.sourceTaskId && b.sourceTaskId) {
    return (
      a.sourceTaskId === b.sourceTaskId &&
      (a.sourceSheetNo ?? 0) === (b.sourceSheetNo ?? 0) &&
      r1(a.sourceX) === r1(b.sourceX) &&
      r1(a.sourceY) === r1(b.sourceY) &&
      r1(a.wMm) === r1(b.wMm) &&
      r1(a.hMm) === r1(b.hMm)
    )
  }
  if (a.sourceTaskId || b.sourceTaskId) return false
  return a.name === b.name && r1(a.wMm) === r1(b.wMm) && r1(a.hMm) === r1(b.hMm)
}

export type LeftoverInput = Omit<Leftover, 'id' | 'createdAt' | 'usedCount'>

/** 登记：同一张纸上同一位置的余料只保留一条，重复登记返回已存在的那条 */
export function addLeftoverTo(
  list: Leftover[],
  input: LeftoverInput,
  id: string,
  now: number,
): { list: Leftover[]; item: Leftover; duplicated: boolean } {
  const dup = list.find((x) => sameLeftoverSource(x, input))
  if (dup) return { list, item: dup, duplicated: true }
  const item: Leftover = { ...input, id, createdAt: now, usedCount: 0 }
  return { list: [item, ...list], item, duplicated: false }
}

/** 消耗：被任务排样用掉后记为已用完并记录去向；已用完的不能再被消耗 */
export function consumeLeftoverIn(
  list: Leftover[],
  id: string,
  task: { id: string; name: string },
): Leftover[] {
  return list.map((l) =>
    l.id === id && !l.exhausted
      ? {
          ...l,
          usedCount: l.usedCount + 1,
          exhausted: true,
          consumedByTaskId: task.id,
          consumedByTaskName: task.name,
        }
      : l,
  )
}
