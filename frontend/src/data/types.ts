/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 乐观锁版本号：历史旧数据没有这个字段，读取时按首份（0）处理。
  __v?: number
  // 过站监测的内部时间戳：仅新口径记录写入，历史旧数据保持原样。
  __monitoredAt?: string
  __completedAt?: string
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  // 并发首份（乐观锁）判定时回传当前版本，供页面刷新后重试。
  currentVersion?: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
