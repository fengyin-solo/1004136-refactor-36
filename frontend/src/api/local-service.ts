import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commit, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  FLIGHT_OPS_KEY,
  TURNAROUND_KEY,
  applyTurnaroundAction,
  presentTurnaroundRow,
  syncFlightConclusion,
  versionOf,
} from '@/data/turnaround'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

/** 读取时按模块统一呈现口径：过站模块的列表/详情/导出共用，保证三个入口结论一致。 */
function presentRows(key: string, rows: EntryRow[]): EntryRow[] {
  return key === TURNAROUND_KEY ? rows.map(presentTurnaroundRow) : rows
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(presentRows(key, listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 单条详情读取：与列表、导出同一份判定，不会再读到残留的超时/旧状态痕迹。 */
export function getEntry(key: string, id: number): EntryRow | null {
  const row = listRows(key).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  return presentRows(key, [row])[0]
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedVersion?: number,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 过站监控走领域状态机：统一完成判定、真实时长、乐观锁首份生效与终态同步。
  if (key === TURNAROUND_KEY) {
    // 基于同一份快照构建过站与航班保障两套新数组，避免重复读缓存时拿到中途被替换的旧引用。
    const snapshotRows = allRows()
    const turnaroundSource = snapshotRows[TURNAROUND_KEY] ?? []
    const turnaroundIndex = turnaroundSource.findIndex((row) => Number(row.id) === id)
    if (turnaroundIndex < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const sourceRow = turnaroundSource[turnaroundIndex]

    const outcome = applyTurnaroundAction({
      row: sourceRow,
      target,
      expectedVersion:
        typeof expectedVersion === 'number' ? expectedVersion : versionOf(sourceRow),
    })
    if (!outcome.ok) {
      return { ok: false, message: outcome.message, currentVersion: outcome.currentVersion }
    }

    const patch: Record<string, EntryRow[]> = {
      [TURNAROUND_KEY]: turnaroundSource.map((row, rowIndex) =>
        rowIndex === turnaroundIndex ? outcome.row : row,
      ),
    }
    // 终态结论同步到航班保障清单；非终态不回写其它页面。
    if (outcome.syncedFlightStatus) {
      const syncedFlights = syncFlightConclusion(
        snapshotRows[FLIGHT_OPS_KEY] ?? [],
        outcome.row,
        outcome.row.status,
      )
      if (syncedFlights) {
        patch[FLIGHT_OPS_KEY] = syncedFlights
      }
    }

    // 先基于同一份快照完成全部计算，再一次性原子提交；提交前抛错不会覆盖任何原记录。
    try {
      commit(patch)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '过站结论保存失败，原记录未改动',
        currentVersion: versionOf(sourceRow),
      }
    }
    return { ok: true, message: `过站记录已${action}，当前状态「${target}」` }
  }

  // 其余模块沿用原口径（历史逻辑不动）。
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const currentRow = rows[index]
  const current = String(currentRow.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...currentRow,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出与列表/详情同口径：过站模块的「过站状态」字段也已在 present 时收敛到权威结论。
  for (const row of presentRows(key, listRows(key))) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = presentRows(meta.key, rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
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
