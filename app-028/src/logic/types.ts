/** 数据模型（对应规格书 §7） */

export type PaperKind = 'sheet' | 'roll'

export interface Paper {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  kind: PaperKind
}

export interface PhotoSize {
  id: string
  name: string
  wMm: number
  hMm: number
  rotateByDefault: boolean
}

/** 本机读取的照片文件信息（只读尺寸与方向，不上传） */
export interface PhotoRef {
  name: string
  wPx: number
  hPx: number
  landscape: boolean
}

export interface Item {
  id: string
  sizeId: string
  qty: number
  rotateAllowed: boolean
  /** true = 同一张照片重复排；false = 一张照片只出现一次（每张各需一张底片） */
  repeatSamePhoto: boolean
  /** true = 该尺寸的照片尽量不拆散，排在同一张相纸上 */
  keepTogether: boolean
  photo?: PhotoRef
}

/** 实际照片矩形（mm，含旋转后的宽高） */
export interface Placement {
  itemId: string
  sheetIndex: number
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
  seq: number
}

export type CutAxis = 'v' | 'h'

/** 贯通切割线；axis='v' 时 at 为 x，from/to 为 y 区间 */
export interface CutStep {
  sheetIndex: number
  axis: CutAxis
  at: number
  from: number
  to: number
  /** 该步由共边合并而来 */
  merged: boolean
}

export interface Sheet {
  index: number
  placements: Placement[]
  cutSteps: CutStep[]
  /** 合并前的切割步数（用于共边合并的对比断言） */
  rawCutCount: number
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
  wasteRects: WasteRect[]
}

export interface WasteRect {
  x: number
  y: number
  w: number
  h: number
  /** 是否大到还能再排照片（窄纸边为 false：登记后标为不可复用） */
  reusable: boolean
}

export interface PackStats {
  totalPhotos: number
  sheets: number
  avgUtilization: number
  elapsedMs: number
  keepTogetherBroken: string[]
}

export interface PackResult {
  sheets: Sheet[]
  stats: PackStats
}

export interface CostReport {
  paperName: string
  sheets: number
  totalCents: number
  perPhotoCents: number
  totalPhotoCount: number
  /** 本方案浪费率 */
  wasteRate: number
  /** 不排样逐张打印的浪费率 */
  naiveWasteRate: number
  naiveTotalCents: number
  savedCents: number
}

export interface Task {
  id: string
  name: string
  paperId: string
  /** 自定义相纸（paperId 为 'custom' 时生效） */
  customPaper?: Paper
  items: Item[]
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  headerText: string
  footerText: string
  createdAt: number
  /** 手工微调过的排样（存在时优先于自动排样结果） */
  manual?: {
    placements: Placement[]
    valid: boolean
    message: string
    validationMs: number
    stepCount: number
  }
  /** 用掉这块余料的任务（余料被用作相纸时记录） */
  consumedLeftoverId?: string
  /** 选中的余料可复用块在原余料上的偏移（mm）；未用余料时为 0 */
  leftoverOffsetMm?: { x: number; y: number }
  result?: PackResult
}

/**
 * 余料状态：
 *  - usable：至少还有一块大到能再排照片的矩形
 *  - unusable：登记时就是窄纸边（两边都不够最小可复用尺寸），只能记账、不能选
 *  - used_up：被排样用过后，剩余区域没有可复用块了
 */
export type LeftoverStatus = 'usable' | 'unusable' | 'used_up'

/** 余料内一个矩形区域（整块登记时只有一个；被用过后按废料几何扣减为多个） */
export interface LeftoverRect {
  x: number
  y: number
  w: number
  h: number
  /** false = 太窄（纸边/刀缝条），只登记占地，不可再排照片 */
  reusable: boolean
}

/** 余料来源：哪张任务的哪张纸上、哪块位置 */
export interface LeftoverSource {
  kind: 'task'
  taskId: string
  taskName: string
  sheetIndex: number
  paperName: string
  /** 该纸原始尺寸 */
  paperWMm: number
  paperHMm: number
}

export interface LeftoverUse {
  taskId: string
  taskName: string
  /** 本次用掉的区域（余料坐标系，mm） */
  rect: LeftoverRect
  at: number
}

export interface Leftover {
  id: string
  name: string
  /** 当前有效尺寸：登记时的尺寸；被用过后取最大剩余块（同时也是可用区） */
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  createdAt: number
  usedCount: number
  status: LeftoverStatus
  /** 来源（手工补录的老数据可能没有） */
  source?: LeftoverSource
  /** 形状/位置：一个或多个剩余矩形，坐标相对原纸 */
  rects: LeftoverRect[]
  /** 被哪些任务用过（每次排样消耗记一条） */
  uses: LeftoverUse[]
}

export interface Settings {
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  exportDpi: number
}

export interface PaperTemplate {
  id: string
  name: string
  paperId: string
  items: Array<{
    sizeId: string
    qty: number
    rotateAllowed: boolean
    keepTogether: boolean
  }>
}
