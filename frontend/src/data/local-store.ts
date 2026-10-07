import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 直接读存储里的权威数据，不做播种副作用：并发校验时必须以它为准，不能拿内存缓存当底稿。
function readRawMap(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(SEED_ROWS)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return clone(SEED_ROWS)
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 与读缓存保持同一兜底：存储里缺模块时补示例模块，但已存模块一律以存储为准。
    return { ...clone(SEED_ROWS), ...parsed }
  } catch {
    return clone(SEED_ROWS)
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 每条记录带一个行版本号：历史旧数据没有版本号，按 0 看待；每次落账 +1。
// 并发更新时拿「动笔前看到的版本」和存储里的首份版本比对，不一致就整笔拒绝。
export function revisionOf(row: EntryRow): number {
  const revision = Number(row._v ?? 0)
  return Number.isFinite(revision) ? revision : 0
}

export type StoreChange = {
  key: string
  rows: EntryRow[]
  // 本次落账涉及的记录，以及动笔前看到的版本（并发只认首份的依据）。
  base: { id: number; revision: number }[]
}

export type CommitResult = { ok: boolean; reason?: string }

// 跨模块原子落账：先校验全部行版本，再一次性写入。
// 版本对不上（已有首份更新）或写入抛错，都不切换缓存、不覆盖原记录。
export function commitChanges(changes: StoreChange[]): CommitResult {
  let authoritative: Record<string, EntryRow[]>
  try {
    authoritative = readRawMap()
  } catch {
    return { ok: false, reason: '本地数据读取失败，已保留原记录' }
  }

  for (const change of changes) {
    const before = authoritative[change.key] ?? []
    for (const { id, revision } of change.base) {
      const row = before.find((item) => Number(item.id) === id)
      if (!row) {
        cache = authoritative
        return { ok: false, reason: '原记录已不存在，本次操作未落账' }
      }
      if (revisionOf(row) !== revision) {
        // 以存储里率先落账的首份结论为准，后续读取立即看到它。
        cache = authoritative
        return { ok: false, reason: '该记录已被率先确认，按首份结论保留，本次未覆盖原记录' }
      }
    }
  }

  // 以权威数据为底稿合入，避免顺手覆盖掉其它模块的并发更新；
  // 通过校验的行统一加盖下一版本号，后续并发就能比对出来。
  const next: Record<string, EntryRow[]> = { ...authoritative }
  for (const change of changes) {
    next[change.key] = change.rows.map((row, rowIndex) => {
      const stamped = change.base.some((item) => item.id === Number(row.id))
      if (!stamped) {
        return row
      }
      const previous = change.rows[rowIndex]
      const stampedRow: EntryRow = { ...row, _v: revisionOf(previous) + 1 }
      return stampedRow
    })
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch {
    // 写失败（如配额异常）：缓存不切换，调用方读到的仍是原记录。
    return { ok: false, reason: '落账失败已回滚，原记录未改动' }
  }
  cache = next
  return { ok: true }
}

// 其它标签页先落账时让本地缓存失效，下次读取直接拿存储里的首份结论。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}
