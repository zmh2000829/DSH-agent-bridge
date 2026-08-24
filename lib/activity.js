/** Durable activity-group vocabulary shared by the ACP bridge and Web row. */

export const GROK_ACTIVITY_TOOL = 'grok_build_activity'

const MUTATION_KIND = /^(edit|delete|move)$/i
const MUTATION_NAME = /(^|[_\s])(write|edit|patch|create|delete|remove|move|rename)([_\s]|$)/i
const READ_KIND = /^(read)$/i
const READ_NAME = /(^|[_\s])(read|list|inspect)([_\s]|$)/i
const SEARCH_KIND = /^(search|fetch)$/i
const SEARCH_NAME = /(^|[_\s])(search|grep|glob|find|fetch)([_\s]|$)/i
const COMMAND_KIND = /^(execute)$/i
const COMMAND_NAME = /(^|[_\s])(run|terminal|command|shell|bash|exec)([_\s]|$)/i

/** Classify one ACP tool for summary counts and diff-safe presentation. */
export function classifyActivityTool(update) {
  const kind = String(update.kind ?? '')
  const name = String(update.title ?? update.kind ?? 'tool')
  if (MUTATION_KIND.test(kind) || MUTATION_NAME.test(name)) return 'edit'
  if (READ_KIND.test(kind) || READ_NAME.test(name)) return 'read'
  if (SEARCH_KIND.test(kind) || SEARCH_NAME.test(name)) return 'search'
  if (COMMAND_KIND.test(kind) || COMMAND_NAME.test(name)) return 'command'
  return 'other'
}

/** Create the mutable accumulator owned by one Grok turn. */
export function createActivityState(turn, step) {
  return {
    callId: `grok-activity:${turn}:${step}`,
    opened: false,
    closed: false,
    failed: 0,
    counts: { read: 0, command: 0, search: 0, edit: 0, other: 0 },
  }
}

/** Freeze the small metadata object consumed by the activity row. */
export function activityMeta(activity) {
  const counts = { ...activity.counts }
  return {
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    failed: activity.failed,
    counts,
  }
}

/** Plain-text fallback for clients that do not load the custom row. */
export function activityFallback(meta) {
  const parts = [`Grok Build · ${meta.failed > 0 ? `失败 ${meta.failed}` : `已完成 ${meta.total} 个操作`}`]
  const labels = { read: '读文件', command: '命令', search: '搜索', edit: '修改', other: '其他' }
  for (const key of Object.keys(labels)) {
    if (meta.counts[key] > 0) parts.push(`${labels[key]} ${meta.counts[key]}`)
  }
  return parts.join(' · ')
}
