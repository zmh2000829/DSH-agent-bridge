export const GROK_ACTIVITY_TOOL: 'grok_build_activity'

export type ActivityCategory = 'read' | 'command' | 'search' | 'edit' | 'other'
export interface ActivityMeta {
  total: number
  failed: number
  counts: Record<ActivityCategory, number>
}

export function classifyActivityTool(update: { kind?: unknown; title?: unknown }): ActivityCategory
export function activityFallback(meta: ActivityMeta): string
