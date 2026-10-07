import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitChanges,
  listRows,
  resetRows,
  revisionOf,
} from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const TERMINAL_STATUSES: Record<string, string[]> = {
  // 过站监控：正常完成与已超时同为终局结论，只是一正一负，二者都不再继续流转。
  turnaround: ['正常完成', '已超时'],
  flight_ops: ['已就绪', '已延误'],
}

// 过站监控的合法流转：待监测/监测中可开始监测，监测中才能给出终局结论；终局不可再动作。
const TURNAROUND_TRANSITIONS: Record<string, string[]> = {
  待监测: ['监测中'],
  监测中: ['正常完成', '已超时'],
  正常完成: [],
  已超时: [],
}

// 过站终局要同步给航班保障：正常完成对应已就绪，已超时对应已延误。
const TURNAROUND_TO_FLIGHT: Record<string, string> = {
  正常完成: '已就绪',
  已超时: '已延误',
}

function terminalStatuses(meta: ModuleMeta): string[] {
  return TERMINAL_STATUSES[meta.key] ?? [meta.statuses[meta.statuses.length - 1]]
}

export function isTerminalStatus(meta: ModuleMeta, status: string): boolean {
  return terminalStatuses(meta).includes(status)
}

export function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  if (meta.key === 'turnaround') {
    // 过站只有超时算异常，正常完成即便排在「已超时」前面也是正常终局。
    return status === '已超时'
  }
  if (meta.key === 'flight_ops') {
    return status === '已延误'
  }
  // 未登记终局规则的模块沿用旧口径，不改变其历史结论。
  return false
}

function canTransit(meta: ModuleMeta, current: string, target: string): boolean {
  if (meta.key === 'turnaround') {
    return TURNAROUND_TRANSITIONS[current]?.includes(target) ?? false
  }
  // 其它模块只允许沿登记状态顺序向前流转，不允许退回或终局后继续操作。
  if (isTerminalStatus(meta, current)) {
    return false
  }
  const currentIndex = meta.statuses.indexOf(current)
  const targetIndex = meta.statuses.indexOf(target)
  return targetIndex > currentIndex
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 真实过站时长：动作落账时刻 − 实际到港，按分钟取整。
// 实际到港不是可解析的时间（含历史旧数据的占位文本）时返回 null，保留原值不伪造。
export function actualTurnaroundDuration(arrival: unknown, finishedAt: Date = new Date()): number | null {
  const raw = String(arrival ?? '').trim()
  if (!raw) {
    return null
  }
  // 兼容 "YYYY-MM-DD HH:mm:ss"（部分浏览器对带空格的本地时间解析不稳定，手工拆）。
  const match = raw.replace(/\//g, '-')
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  let arrived: Date
  if (match) {
    const [, y, mo, d, h, mi, se] = match
    arrived = new Date(
      Number(y), Number(mo) - 1, Number(d),
      Number(h ?? 0), Number(mi ?? 0), Number(se ?? 0),
    )
  } else {
    arrived = new Date(raw)
  }
  if (Number.isNaN(arrived.getTime())) {
    return null
  }
  const minutes = Math.round((finishedAt.getTime() - arrived.getTime()) / 60000)
  return minutes >= 0 ? minutes : null
}

type PreparedAction = {
  nextRows: EntryRow[]
  updated: EntryRow
  syncRows?: EntryRow[]
  synced?: EntryRow
  syncSkipped?: string
  revision: number
}

function prepareAction(meta: ModuleMeta, id: number, action: string): PreparedAction {
  const target = meta.actionTargets[action]
  if (!target) {
    throw { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` } as ActionResult
  }
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    throw { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` } as ActionResult
  }

  const currentRow = rows[index]
  const current = String(currentRow.status)
  if (current === target) {
    throw { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` } as ActionResult
  }
  if (!canTransit(meta, current, target)) {
    if (isTerminalStatus(meta, current)) {
      throw {
        ok: false,
        message: `${meta.entity}已终局为「${current}」，结论不可再变更`,
      } as ActionResult
    }
    throw { ok: false, message: `当前状态「${current}」不能执行「${action}」` } as ActionResult
  }

  const flagged = isAbnormalStatus(meta, target) ||
    NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))

  const updated: EntryRow = {
    ...currentRow,
    status: target,
    // 统一完成判定：待处理只看「是否终局」，异常只看「终局结论是否为负」。
    pending: !isTerminalStatus(meta, target),
    abnormal: flagged,
  }

  if (meta.key === 'turnaround') {
    // 镜像字段与状态保持同一结论，列表、详情、导出不再各读各的。
    updated['过站状态'] = target
    updated['异常事项'] = target === '已超时' ? '已超时' : '无'
    if (isTerminalStatus(meta, target)) {
      const minutes = actualTurnaroundDuration(currentRow['实际到港'])
      if (minutes !== null) {
        updated['过站时长'] = `${minutes}分钟`
      }
      // 历史旧数据没有真实到港时间：时长字段保留原值，只同步结论。
    }
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 过站终局同步最终结论到航班保障清单（不新增能力，只同步已有状态）。
  if (meta.key === 'turnaround' && target in TURNAROUND_TO_FLIGHT) {
    const flightTarget = TURNAROUND_TO_FLIGHT[target]
    const flightRows = listRows('flight_ops')
    const flightIndex = flightRows.findIndex(
      (row) => String(row['航班号']) === String(currentRow['关联航班'] ?? '').trim(),
    )
    if (flightIndex >= 0) {
      const flightRow = flightRows[flightIndex]
      const flightMeta = moduleMeta('flight_ops')
      const flightCurrent = String(flightRow.status)
      if (flightCurrent === flightTarget) {
        // 航班保障已是同一首份结论，无需重复同步。
        return { nextRows, updated, revision: revisionOf(currentRow) }
      }
      if (isTerminalStatus(flightMeta, flightCurrent)) {
        // 航班保障已被率先给出另一结论：首份保留、不覆盖；过站自身结论照常落账。
        return {
          nextRows,
          updated,
          revision: revisionOf(currentRow),
          syncSkipped: flightCurrent,
        }
      }
      const synced: EntryRow = {
        ...flightRow,
        status: flightTarget,
        pending: !isTerminalStatus(flightMeta, flightTarget),
        abnormal: isAbnormalStatus(flightMeta, flightTarget),
        保障状态: flightTarget,
      }
      const syncRows = [...flightRows]
      syncRows[flightIndex] = synced
      return { nextRows, updated, syncRows, synced, revision: revisionOf(currentRow) }
    }
  }

  return { nextRows, updated, revision: revisionOf(currentRow) }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  let prepared: PreparedAction
  try {
    prepared = prepareAction(meta, id, action)
  } catch (result) {
    return result as ActionResult
  }

  const changes = [
    { key: meta.key, rows: prepared.nextRows, base: [{ id, revision: prepared.revision }] },
  ]
  if (prepared.syncRows && prepared.synced) {
    changes.push({
      key: 'flight_ops',
      rows: prepared.syncRows,
      base: [{ id: Number(prepared.synced.id), revision: revisionOf(prepared.synced) }],
    })
  }

  // 并发只认首份、失败回滚不覆盖原记录。
  const committed = commitChanges(changes)
  if (!committed.ok) {
    return { ok: false, message: committed.reason ?? '本次操作未生效，原记录未改动' }
  }

  let message = `${meta.entity}已${action}，当前状态「${target}」`
  if (prepared.synced) {
    message += `，已同步航班保障结论为「${String(prepared.synced.status)}」`
  } else if (prepared.syncSkipped) {
    message += `；航班保障已有首份结论「${prepared.syncSkipped}」，按首份保留未覆盖`
  }
  return { ok: true, message }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// CSV 单元格转义：含逗号/引号/换行的内容必须加引号，否则导出列会整体错位。
function csvCell(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rowsByKey: Record<string, EntryRow[]> = {}
  for (const meta of MODULE_BY_KEY.values()) {
    rowsByKey[meta.key] = listRows(meta.key)
  }
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rowsByKey[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      // 直接数落账标志：新记录的标志在动作落账时已按统一完成判定写入；
      // 历史旧数据没经过新口径落账，标志维持原值，不在读取时改写其结论。
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
