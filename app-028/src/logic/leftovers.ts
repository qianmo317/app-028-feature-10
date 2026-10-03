/**
 * 余料领域逻辑：
 *  - 来源与形状：每块余料记录它来自哪张任务的哪张纸、在纸上的位置与形状
 *  - 按来源去重：同一张纸同一位置的废料重复登记时复用原记录
 *  - 窄条登记：小于最小可复用尺寸的纸边照样入库，但 reusable=false、不可再选
 *  - 用后扣减：余料被排样用过后，按第一张相纸（即该余料）的废料几何扣减剩余区域，
 *    没有可复用块时标记 used_up，禁止再次选用
 */
import { newId } from './library'
import { round } from './units'
import type {
  Leftover,
  LeftoverRect,
  LeftoverSource,
  LeftoverStatus,
  LeftoverUse,
  Sheet,
  WasteRect,
} from './types'

/** 最小可复用尺寸（mm）：窄于此值的纸边只登记占地，不能再排照片 */
export const MIN_REUSABLE_MM = 8
/** 小于该尺寸的碎块（刀缝/浮点残渣）不登记 */
const MIN_REGISTER_MM = 0.5
/** 扣减时匹配用掉区域的容差（mm） */
const CONSUME_EPS = 0.6

export interface LeftoverDraft {
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  source?: LeftoverSource
  rects?: LeftoverRect[]
}

export function isReusableRect(r: Pick<LeftoverRect, 'w' | 'h'>): boolean {
  return r.w >= MIN_REUSABLE_MM && r.h >= MIN_REUSABLE_MM
}

export function leftoverStatus(rects: LeftoverRect[]): LeftoverStatus {
  if (rects.some((r) => r.reusable)) return 'usable'
  // 没有任何可复用块：原本就是窄条记为 unusable；被用过后剩下窄条/用完记为 used_up
  return rects.length === 0 ? 'used_up' : 'unusable'
}

/** 登记后又被用过：unusable 会升级为 used_up（“用完的不许再选”对两者效果一致） */
export function effectiveStatus(l: Leftover): LeftoverStatus {
  if (l.status === 'usable') return 'usable'
  return l.uses.length > 0 ? 'used_up' : l.status
}

export function canUseLeftover(l: Leftover): boolean {
  return effectiveStatus(l) === 'usable'
}

/** 把废料矩形规整为 0.1mm，避免浮点噪声影响去重 */
function toLeftoverRect(r: WasteRect): LeftoverRect {
  return {
    x: round(r.x, 1),
    y: round(r.y, 1),
    w: round(r.w, 1),
    h: round(r.h, 1),
    reusable: r.reusable,
  }
}

/** 找最大的可复用块（用作新任务的相纸尺寸） */
export function pickReusableRect(l: Leftover): LeftoverRect | undefined {
  return l.rects
    .filter((r) => r.reusable)
    .slice()
    .sort((a, b) => b.w * b.h - a.w * a.h)[0]
}

export function largestRect(rects: LeftoverRect[]): LeftoverRect | undefined {
  return rects.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0]
}

export function totalAreaMm2(l: Leftover): number {
  return l.rects.reduce((acc, r) => acc + r.w * r.h, 0)
}

export interface RegisterResult {
  leftover: Leftover
  /** true = 已按来源去重，没有新建记录 */
  duplicated: boolean
}

/** 登记一块余料；同源同位置已存在时直接复用（按来源去重） */
export function buildLeftover(draft: LeftoverDraft): Leftover {
  const rects: LeftoverRect[] =
    draft.rects && draft.rects.length
      ? draft.rects.map((r) => ({ ...r, reusable: r.reusable && isReusableRect(r) }))
      : [
          {
            x: 0,
            y: 0,
            w: draft.wMm,
            h: draft.hMm,
            reusable: isReusableRect({ w: draft.wMm, h: draft.hMm }),
          },
        ]
  return {
    id: newId('leftover'),
    name: draft.name,
    wMm: round(draft.wMm, 1),
    hMm: round(draft.hMm, 1),
    marginMm: draft.marginMm,
    priceCents: draft.priceCents,
    createdAt: Date.now(),
    usedCount: 0,
    status: leftoverStatus(rects),
    source: draft.source,
    rects,
    uses: [],
  }
}

/** 在已有列表里登记；返回（新/旧）记录与是否重复 */
export function registerLeftover(list: Leftover[], draft: LeftoverDraft): RegisterResult {
  const rects =
    draft.rects && draft.rects.length
      ? draft.rects.map(toLeftoverRect).map((r) => ({
          ...r,
          reusable: r.reusable && isReusableRect(r),
        }))
      : [
          {
            x: 0,
            y: 0,
            w: round(draft.wMm, 1),
            h: round(draft.hMm, 1),
            reusable: isReusableRect({ w: draft.wMm, h: draft.hMm }),
          },
        ]
  if (draft.source) {
    for (const r of rects) {
      const found = list.find(
        (l) =>
          l.source &&
          l.source.taskId === draft.source!.taskId &&
          l.source.sheetIndex === draft.source!.sheetIndex &&
          l.rects.some((x) => rectEqualLoose(x, r)),
      )
      if (found) return { leftover: found, duplicated: true }
    }
  }
  const item = buildLeftover({ ...draft, rects })
  return { leftover: item, duplicated: false }
}

/**
 * 排样消耗余料后的扣减。
 * @param leftover 被用作相纸的余料
 * @param usedRect 选中的可复用块（在余料坐标系中），即本次相纸的全尺寸
 * @param firstSheet 排样结果的第一张相纸（坐标系与 usedRect 相同，原点在相纸左上）
 */
export function consumeLeftover(
  leftover: Leftover,
  usedRect: LeftoverRect,
  firstSheet: Sheet | undefined,
  taskId: string,
  taskName: string,
): Leftover {
  const now = Date.now()
  const use: LeftoverUse = {
    taskId,
    taskName,
    rect: { ...usedRect },
    at: now,
  }

  // 排样失败/没有版面：整块算用完
  if (!firstSheet) {
    return finalize(leftover, [], use)
  }

  // 第一张纸的废料块换算回余料原纸坐标
  const waste: LeftoverRect[] = firstSheet.wasteRects
    .filter((r) => r.w >= MIN_REGISTER_MM && r.h >= MIN_REGISTER_MM)
    .map((r) => ({
      x: round(usedRect.x + r.x, 1),
      y: round(usedRect.y + r.y, 1),
      w: round(r.w, 1),
      h: round(r.h, 1),
      reusable: r.reusable,
    }))

  // 几何健全性检查：用掉区域必须与登记的某块可复用块吻合，
  // 对不上（例如手工改了自定义相纸尺寸）时保守地标成用完，避免同一块被反复选
  const matched = leftover.rects.some(
    (r) =>
      r.reusable &&
      Math.abs(r.x - usedRect.x) < CONSUME_EPS &&
      Math.abs(r.y - usedRect.y) < CONSUME_EPS &&
      Math.abs(r.w - usedRect.w) < CONSUME_EPS &&
      Math.abs(r.h - usedRect.h) < CONSUME_EPS,
  )
  if (!matched) {
    return finalize(leftover, [], use)
  }

  // 保留：未被本次使用触及的其它块 + 用掉区域内扣出的废料块
  const untouched = leftover.rects.filter((r) => r !== usedRect && !rectEqualLoose(r, usedRect))
  const nextRects = [...untouched, ...waste]
  return finalize(leftover, nextRects, use)
}

function finalize(leftover: Leftover, rects: LeftoverRect[], use: LeftoverUse): Leftover {
  const next: Leftover = {
    ...leftover,
    rects,
    uses: [...leftover.uses, use],
    usedCount: leftover.usedCount + 1,
  }
  const largest = largestRect(rects)
  next.wMm = largest ? round(largest.w, 1) : 0
  next.hMm = largest ? round(largest.h, 1) : 0
  if (rects.some((r) => r.reusable)) {
    next.status = 'usable'
  } else {
    // 被排样消耗过：剩下窄条或整块用完都归入 used_up（不许再选）
    next.status = 'used_up'
  }
  return next
}

function rectEqualLoose(a: LeftoverRect, b: LeftoverRect): boolean {
  return (
    Math.abs(a.x - b.x) < CONSUME_EPS &&
    Math.abs(a.y - b.y) < CONSUME_EPS &&
    Math.abs(a.w - b.w) < CONSUME_EPS &&
    Math.abs(a.h - b.h) < CONSUME_EPS
  )
}

/** 旧版本数据（v1：只有尺寸/价钱/usedCount）迁移成带来源与形状的记录 */
export function migrateLeftover(raw: Partial<Leftover>): Leftover {
  const w = raw.wMm ?? 0
  const h = raw.hMm ?? 0
  const rects: LeftoverRect[] = raw.rects?.length
    ? raw.rects.map((r) => ({ ...r, reusable: r.reusable ?? isReusableRect(r) }))
    : [{ x: 0, y: 0, w, h, reusable: isReusableRect({ w, h }) }]
  const status: LeftoverStatus = raw.status ?? leftoverStatus(rects)
  const largest = largestRect(rects)
  return {
    id: raw.id ?? newId('leftover'),
    name: raw.name ?? '未命名余料',
    wMm: raw.wMm ?? (largest ? round(largest.w, 1) : 0),
    hMm: raw.hMm ?? (largest ? round(largest.h, 1) : 0),
    marginMm: raw.marginMm ?? 0,
    priceCents: raw.priceCents ?? 0,
    createdAt: raw.createdAt ?? Date.now(),
    usedCount: raw.usedCount ?? 0,
    status,
    source: raw.source,
    rects,
    uses: raw.uses ?? [],
  }
}

/** 列表里人类可读的来源描述 */
export function sourceLabel(l: Leftover): string {
  if (!l.source) return '手工补录'
  const s = l.source
  return `${s.taskName} · 第 ${s.sheetIndex + 1} 张（${s.paperName} ${s.paperWMm}×${s.paperHMm}mm）`
}

export function statusLabel(l: Leftover): string {
  switch (effectiveStatus(l)) {
    case 'usable':
      return '可复用'
    case 'unusable':
      return '不可复用（窄条）'
    case 'used_up':
      return '已用完'
  }
}
