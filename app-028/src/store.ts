/** 全局状态（Vue 自带 ref / computed / watch，不引入任何状态库） */
import { computed, ref, watch } from 'vue'
import {
  BUILTIN_PAPERS,
  BUILTIN_PHOTO_SIZES,
  BUILTIN_TEMPLATES,
  groupsFromTask,
  newId,
  optionsFromTask,
  resolvePaper,
} from './logic/library'
import { pack, sheetsFromPlacements } from './logic/packer'
import { loadJSON, saveJSON } from './logic/storage'
import {
  canUseLeftover,
  consumeLeftover,
  migrateLeftover,
  pickReusableRect,
  registerLeftover,
  type LeftoverDraft,
} from './logic/leftovers'
import type {
  Leftover,
  LeftoverRect,
  LeftoverSource,
  Paper,
  PaperTemplate,
  PhotoRef,
  PhotoSize,
  Placement,
  Settings,
  Sheet,
  Task,
} from './logic/types'

const KEY = {
  customPapers: 'ppis.customPapers.v1',
  customSizes: 'ppis.customSizes.v1',
  settings: 'ppis.settings.v1',
  tasks: 'ppis.tasks.v1',
  leftovers: 'ppis.leftovers.v1',
}

export const DEFAULT_SETTINGS: Settings = {
  gapMm: 0,
  kerfMm: 0.5,
  safeEdgeMm: 3,
  allowRotate: true,
  exportDpi: 300,
}

export const customPapers = ref<Paper[]>(loadJSON<Paper[]>(KEY.customPapers, []))
export const customSizes = ref<PhotoSize[]>(loadJSON<PhotoSize[]>(KEY.customSizes, []))
export const settings = ref<Settings>({ ...DEFAULT_SETTINGS, ...loadJSON(KEY.settings, {}) })
export const tasks = ref<Task[]>(loadJSON<Task[]>(KEY.tasks, []))
export const leftovers = ref<Leftover[]>(
  loadJSON<Partial<Leftover>[]>(KEY.leftovers, []).map(migrateLeftover),
)

watch(customPapers, (v) => saveJSON(KEY.customPapers, v), { deep: true })
watch(customSizes, (v) => saveJSON(KEY.customSizes, v), { deep: true })
watch(settings, (v) => saveJSON(KEY.settings, v), { deep: true })
watch(tasks, (v) => saveJSON(KEY.tasks, v), { deep: true })
watch(leftovers, (v) => saveJSON(KEY.leftovers, v), { deep: true })

export const allPapers = computed<Paper[]>(() => [...BUILTIN_PAPERS, ...customPapers.value])
export const allSizes = computed<PhotoSize[]>(() => [...BUILTIN_PHOTO_SIZES, ...customSizes.value])
export const templates = computed<PaperTemplate[]>(() => BUILTIN_TEMPLATES)

/** 照片文件只在本机内存里保留，绝不写入存储、绝不上传 */
const photoCache = new Map<string, { url: string; ref: PhotoRef }>()
/** 内存照片变化计数（Map 本身不是响应式的，用它触发重绘） */
export const photoVersion = ref(0)

export function photoKey(itemId: string, copyIndex: number): string {
  return `${itemId}#${copyIndex}`
}

export function setItemPhoto(key: string, url: string, ref: PhotoRef): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.set(key, { url, ref })
  photoVersion.value++
}

export function getItemPhoto(key: string): { url: string; ref: PhotoRef } | undefined {
  return photoCache.get(key)
}

export function clearItemPhoto(key: string): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.delete(key)
  photoVersion.value++
}

/** 每张照片（placement）对应第几张底片 */
export function copyIndexMap(sheets: Sheet[]): Map<number, number> {
  const counter = new Map<string, number>()
  const out = new Map<number, number>()
  for (const s of sheets) {
    for (const p of s.placements) {
      const n = counter.get(p.itemId) ?? 0
      out.set(p.seq, n)
      counter.set(p.itemId, n + 1)
    }
  }
  return out
}

/** placement -> 本机照片（key + objectURL），未导入照片时返回 undefined */
export function makePhotoResolver(task: Task, sheets: Sheet[]) {
  const map = copyIndexMap(sheets)
  const repeat = new Map(task.items.map((i) => [i.id, i.repeatSamePhoto]))
  return (p: Placement): { key: string; url: string } | undefined => {
    const ci = repeat.get(p.itemId) === false ? map.get(p.seq) ?? 0 : 0
    const k = photoKey(p.itemId, ci)
    const ph = getItemPhoto(k)
    return ph ? { key: k, url: ph.url } : undefined
  }
}

/** 生成「placement -> 本机缩略图 URL」的解析函数 */
export function makeThumbResolver(task: Task, sheets: Sheet[]) {
  const resolve = makePhotoResolver(task, sheets)
  return (p: Placement): string | undefined => resolve(p)?.url
}

export function getTask(id: string): Task | undefined {
  return tasks.value.find((t) => t.id === id)
}

export function createTask(partial: Partial<Task> = {}): Task {
  const task: Task = {
    id: newId('task'),
    name: partial.name ?? `拼版任务 ${tasks.value.length + 1}`,
    paperId: partial.paperId ?? 'p5x7',
    customPaper: partial.customPaper,
    items: partial.items ?? [],
    gapMm: partial.gapMm ?? settings.value.gapMm,
    kerfMm: partial.kerfMm ?? settings.value.kerfMm,
    safeEdgeMm: partial.safeEdgeMm ?? settings.value.safeEdgeMm,
    allowRotate: partial.allowRotate ?? settings.value.allowRotate,
    headerText: partial.headerText ?? '',
    footerText: partial.footerText ?? '',
    createdAt: Date.now(),
  }
  tasks.value.unshift(task)
  return task
}

export function deleteTask(id: string): void {
  tasks.value = tasks.value.filter((t) => t.id !== id)
}

export function touch(): void {
  tasks.value = tasks.value.slice()
}

/** 执行排样；返回错误提示（无错误时返回 undefined） */
export function runPack(task: Task): string | undefined {
  const paper = resolvePaper(task, allPapers.value)
  const groups = groupsFromTask(task, allSizes.value)
  if (!groups.length) {
    task.result = undefined
    return '照片清单为空，请先添加照片尺寸与数量'
  }
  const out = pack(groups, optionsFromTask(task, paper))
  if (out.error) {
    task.result = undefined
    return out.error
  }
  task.result = out.result
  task.manual = undefined
  // 用余料做相纸：排样成功后按第一张纸（即该余料）的废料几何扣减
  if (task.consumedLeftoverId) {
    consumeTaskLeftover(task, out.result.sheets[0])
  }
  touch()
  return undefined
}

/** 排样后扣减被用作相纸的余料：用掉区域 -> 废料块，耗尽则标记 used_up */
function consumeTaskLeftover(task: Task, firstSheet: Sheet | undefined): void {
  const id = task.consumedLeftoverId
  if (!id) return
  const l = leftovers.value.find((x) => x.id === id)
  if (!l) return
  // 优先按提交时记录的块偏移精确选中；找不到再退回最大可复用块
  const off = task.leftoverOffsetMm
  let rect: LeftoverRect | undefined
  if (off) {
    rect = l.rects.find(
      (r) => r.reusable && Math.abs(r.x - off.x) < 0.2 && Math.abs(r.y - off.y) < 0.2,
    )
  }
  rect = rect ?? pickReusableRect(l) ?? l.rects[0]
  if (!rect) return
  const next = consumeLeftover(l, rect, firstSheet, task.id, task.name)
  leftovers.value = leftovers.value.map((x) => (x.id === id ? next : x))
}

/** 当前生效的相纸版面：手工微调优先于自动排样 */
export function sheetsOf(task: Task): Sheet[] {
  if (task.manual) {
    const paper = resolvePaper(task, allPapers.value)
    const count = Math.max(1, task.result?.sheets.length ?? 1)
    return sheetsFromPlacements(task.manual.placements, optionsFromTask(task, paper), count).sheets
  }
  return task.result?.sheets ?? []
}

export function manualPlacementsOf(task: Task): Placement[] {
  if (task.manual) return task.manual.placements
  return (task.result?.sheets ?? []).flatMap((s) => s.placements)
}

/** 写入手工微调结果并做增量校验（不重新排样） */
export function setManual(task: Task, placements: Placement[]): void {
  const paper = resolvePaper(task, allPapers.value)
  const count = Math.max(1, task.result?.sheets.length ?? 1)
  const t0 = performance.now()
  const { sheets, errors } = sheetsFromPlacements(placements, optionsFromTask(task, paper), count)
  const ms = performance.now() - t0
  const stepCount = sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  task.manual = {
    placements,
    valid: errors.length === 0,
    message: errors.length
      ? errors[0]
      : `guillotine 校验通过：${stepCount} 刀全部贯通，用时 ${ms.toFixed(1)}ms`,
    validationMs: Math.round(ms * 100) / 100,
    stepCount,
  }
  touch()
}

export function resetManual(task: Task): void {
  task.manual = undefined
  touch()
}

export function addCustomPaper(p: Omit<Paper, 'id'>): Paper {
  const paper: Paper = { ...p, id: newId('paper') }
  customPapers.value = [...customPapers.value, paper]
  return paper
}

export function addCustomSize(s: Omit<PhotoSize, 'id'>): PhotoSize {
  const size: PhotoSize = { ...s, id: newId('size') }
  customSizes.value = [...customSizes.value, size]
  return size
}

export function removeCustomPaper(id: string): void {
  customPapers.value = customPapers.value.filter((p) => p.id !== id)
}

export function removeCustomSize(id: string): void {
  customSizes.value = customSizes.value.filter((s) => s.id !== id)
}

export interface RegisterLeftoverOutcome {
  leftover: Leftover
  duplicated: boolean
}

/** 登记余料（带来源与形状）；同源同位置重复登记时去重 */
export function addLeftover(draft: LeftoverDraft): RegisterLeftoverOutcome {
  const { leftover, duplicated } = registerLeftover(leftovers.value, draft)
  if (!duplicated) leftovers.value = [leftover, ...leftovers.value]
  return { leftover, duplicated }
}

export function removeLeftover(id: string): void {
  leftovers.value = leftovers.value.filter((l) => l.id !== id)
}

/** 选出余料中最大的可复用块作为新任务的相纸；不可选时返回 undefined */
export function selectLeftoverPaper(
  id: string,
): { leftover: Leftover; rect: LeftoverRect } | undefined {
  const l = leftovers.value.find((x) => x.id === id)
  if (!l || !canUseLeftover(l)) return undefined
  const rect = pickReusableRect(l)
  if (!rect) return undefined
  return { leftover: l, rect }
}

export function makeLeftoverSource(task: Task, sheetIndex: number): LeftoverSource {
  const paper = resolvePaper(task, allPapers.value)
  return {
    kind: 'task',
    taskId: task.id,
    taskName: task.name,
    sheetIndex,
    paperName: paper.name,
    paperWMm: paper.wMm,
    paperHMm: paper.hMm,
  }
}
