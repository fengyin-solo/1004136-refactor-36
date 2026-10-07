import type { EntryRow } from './types'

/**
 * 过站监控领域规则：完成判定、真实过站时长与字段口径统一在这里算。
 *
 * 列表、详情读取、导出三个入口此前各自取数（有的看 status、有的看「过站状态」字段、
 * 有的还残留「异常事项」里的超时痕迹），同一条记录三个结果对不上。本模块是唯一事实来源：
 * - presentTurnaroundRow 供所有只读入口使用；
 * - applyTurnaroundAction 供动作流转使用，落库即按同一口径收敛。
 *
 * 历史旧数据（无 __v 版本戳，且实际到港不是可解析时间）保留原口径，不做迁移、不改原值。
 */

export const TURNAROUND_KEY = 'turnaround'
export const FLIGHT_OPS_KEY = 'flight_ops'

export const STATUS_PENDING = '待监测'
export const STATUS_MONITORING = '监测中'
export const STATUS_DONE = '正常完成'
export const STATUS_TIMEOUT = '已超时'

/** 终态：正常完成与已超时都是「有最终结论」，pending 一律按是否终态判定，不再按状态枚举位置。 */
export const FINAL_STATUSES: ReadonlySet<string> = new Set([STATUS_DONE, STATUS_TIMEOUT])

const TIMEOUT_NOTE = '已超时'

/** 只允许向前流转；终态仅保留「超时 → 正常完成」的终局更正，不允许退回监测中。 */
const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  [STATUS_PENDING]: new Set([STATUS_MONITORING]),
  [STATUS_MONITORING]: new Set([STATUS_DONE, STATUS_TIMEOUT]),
  [STATUS_TIMEOUT]: new Set([STATUS_DONE]),
  [STATUS_DONE]: new Set(),
}

/** 过站终态同步到航班保障清单时的目标状态。 */
const FLIGHT_SYNC_TARGET: Record<string, string> = {
  [STATUS_DONE]: '已就绪',
  [STATUS_TIMEOUT]: '已延误',
}

const FIELD_DURATION = '过站时长'
const FIELD_PROGRESS = '保障进度'
const FIELD_ABNORMAL_NOTE = '异常事项'
const FIELD_STATUS = '过站状态'

export function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status)
}

export function versionOf(row: EntryRow): number {
  return typeof row.__v === 'number' ? row.__v : 0
}

/** 兼容「2026-10-01 08:30」与「2026-10-01T08:30:00」，解析失败返回 null。 */
export function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const normalized = value.trim().replace(' ', 'T')
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function nowStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 历史旧数据：没有版本戳，且「实际到港」不是可解析时间（示例数据是占位文本），
 * 无法计算真实过站时长，按要求保留原口径，读取与导出都呈现原值。
 */
export function isLegacyRow(row: EntryRow): boolean {
  return typeof row.__v !== 'number' && parseTime(row['实际到港']) === null
}

/** 真实过站时长 = 确认完成/确认超时的时间 − 实际到港时间；条件不齐返回 null。 */
export function realDurationMinutes(row: EntryRow, completedAt: unknown = row.__completedAt): number | null {
  const arrival = parseTime(row['实际到港'])
  const end = parseTime(completedAt)
  if (!arrival || !end) {
    return null
  }
  const minutes = Math.round((end.getTime() - arrival.getTime()) / 60000)
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) {
    return `${rest}分钟`
  }
  return rest === 0 ? `${hours}小时` : `${hours}小时${rest}分钟`
}

/**
 * 统一呈现：所有只读入口（列表/详情/导出）都经过这里。
 * 不修改入参；历史旧数据原样返回。
 */
export function presentTurnaroundRow(row: EntryRow): EntryRow {
  if (isLegacyRow(row)) {
    return row
  }
  const status = String(row.status)
  const duration = realDurationMinutes(row)
  const presentedNote = status === STATUS_TIMEOUT ? TIMEOUT_NOTE : ''

  return {
    ...row,
    pending: !isFinalStatus(status),
    abnormal: status === STATUS_TIMEOUT,
    [FIELD_DURATION]: duration === null ? (row[FIELD_DURATION] ?? '') : formatDuration(duration),
    [FIELD_PROGRESS]: status === STATUS_DONE ? '100%' : row[FIELD_PROGRESS] ?? '',
    [FIELD_ABNORMAL_NOTE]: presentedNote,
    // 「过站状态」字段与权威 status 收敛，避免详情/导出再读到旧值。
    [FIELD_STATUS]: status,
  }
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: string }

/** 校验状态机：非法/回退动作一律拒绝。 */
export function checkTransition(current: string, target: string): TransitionCheck {
  if (current === target) {
    return { ok: false, reason: `过站记录已经是「${target}」，不用重复操作` }
  }
  const allowed = ALLOWED_TRANSITIONS[current]
  if (!allowed || !allowed.has(target)) {
    if (isFinalStatus(current)) {
      return { ok: false, reason: `过站记录已是终态「${current}」，不能再改为「${target}」` }
    }
    return { ok: false, reason: `过站记录不能从「${current}」直接改为「${target}」` }
  }
  return { ok: true }
}

export type TurnaroundActionInput = {
  row: EntryRow
  target: string
  /** 页面持有的版本；与落库版本不一致说明已有并发更新，只认首份。 */
  expectedVersion: number
  /** 可注入时钟，默认当前时间。 */
  now?: Date
}

export type TurnaroundActionResult =
  | { ok: true; row: EntryRow; syncedFlightStatus: string | null }
  | { ok: false; message: string; currentVersion: number }

/**
 * 过站动作流转：状态机校验 + 乐观锁（首份生效）+ 落库字段按统一口径收敛。
 * 只产出新记录，不落库；由服务层连同航班保障清单一并原子提交，失败不覆盖原记录。
 */
export function applyTurnaroundAction(input: TurnaroundActionInput): TurnaroundActionResult {
  const { row, target } = input
  const current = String(row.status)
  const currentVersion = versionOf(row)

  if (currentVersion !== input.expectedVersion) {
    return {
      ok: false,
      currentVersion,
      message: '过站记录已被其他操作更新，请刷新后以最新记录为准',
    }
  }

  const transition = checkTransition(current, target)
  if (!transition.ok) {
    return { ok: false, message: transition.reason, currentVersion }
  }

  const now = input.now ?? new Date()
  const stamp = nowStamp(now)
  const monitoredAt =
    typeof row.__monitoredAt === 'string' && parseTime(row.__monitoredAt)
      ? row.__monitoredAt
      : stamp
  const completedAt = isFinalStatus(target) ? stamp : row.__completedAt

  const updated: EntryRow = {
    ...row,
    status: target,
    __v: currentVersion + 1,
    __monitoredAt: target === STATUS_MONITORING ? stamp : monitoredAt,
    __completedAt: completedAt,
  }

  // 落库记录同样按统一呈现口径收敛，保证旧字段（过站状态/异常事项/过站时长）不再残留。
  return {
    ok: true,
    row: presentTurnaroundRow(updated),
    syncedFlightStatus: FLIGHT_SYNC_TARGET[target] ?? null,
  }
}

/**
 * 过站终态同步到其它页面的航班保障清单：按关联航班号匹配。
 * 只接受终态结论，覆盖该航班此前的保障状态，保证各页面看到的最终结论一致。
 * 返回需要落库的新数组副本；没有匹配时返回 null。
 */
export function syncFlightConclusion(
  flightRows: EntryRow[],
  turnaroundRow: EntryRow,
  targetStatus: string,
): EntryRow[] | null {
  const flightStatus = FLIGHT_SYNC_TARGET[targetStatus]
  const flightNo = String(turnaroundRow['关联航班'] ?? '').trim()
  if (!flightStatus || flightNo === '') {
    return null
  }
  let changed = false
  const next = flightRows.map((flight) => {
    if (String(flight['航班号'] ?? '').trim() !== flightNo) {
      return flight
    }
    const abnormal = targetStatus === STATUS_TIMEOUT
    if (
      String(flight.status) === flightStatus &&
      flight.abnormal === abnormal &&
      String(flight['保障状态'] ?? '') === flightStatus
    ) {
      return flight
    }
    changed = true
    return {
      ...flight,
      // 已就绪/已延误都是航班保障的最终结论，不再挂起。
      status: flightStatus,
      pending: false,
      abnormal,
      ['保障状态']: flightStatus,
    }
  })
  return changed ? next : null
}
