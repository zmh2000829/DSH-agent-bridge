/** Project Grok ACP payloads into DSH transcript text. */

export function toAcpPrompt(content) {
  const blocks = []
  for (const block of content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push({ type: 'text', text: '[image attached]' })
    }
  }
  return blocks
}

export function renderRawOutput(output) {
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return '[unserializable ACP output]'
  }
}

export function renderToolOutput(update) {
  const parts = []
  const diffs = []
  for (const item of update.content ?? []) {
    if (item.type === 'content' && item.content?.type === 'text') parts.push(item.content.text)
    if (item.type === 'terminal' && typeof item.terminalId === 'string') {
      parts.push(`[terminal ${item.terminalId}]`)
    }
    if (item.type !== 'diff') continue
    const oldText = item.oldText ?? null
    diffs.push({ path: item.path, oldText, newText: item.newText })
    parts.push([
      `\`\`\`diff\n--- ${item.path}\n+++ ${item.path}`,
      ...(oldText === null ? [] : oldText.split('\n').map(line => `-${line}`)),
      ...String(item.newText ?? '').split('\n').map(line => `+${line}`),
      '```',
    ].join('\n'))
  }
  if (parts.length === 0) {
    const raw = renderRawOutput(update.rawOutput)
    if (raw.length > 0) parts.push(raw)
  }
  return { text: parts.join('\n\n'), diffs }
}

export function renderPlan(update) {
  const entries = update.entries ?? update.plan?.entries ?? []
  if (!Array.isArray(entries) || entries.length === 0) return ''
  return entries.map((entry) => {
    const status = entry.status ?? 'pending'
    const content = entry.content ?? entry.title ?? ''
    return `- [${status}] ${content}`
  }).join('\n')
}

export function renderBilling(response) {
  const config = response?.config ?? response?.result?.config
  const body = config === undefined || config === null ? response : { ...response, config }
  if (body?.config === undefined || body.config === null) {
    if (typeof response === 'string') return response
    const raw = renderRawOutput(response)
    return raw.length > 0 ? raw : 'Grok Build 没有返回额度信息。'
  }
  const lines = [`套餐：${body.subscription_tier ?? response?.subscription_tier ?? '未知'}`]
  if (typeof body.config.creditUsagePercent === 'number') {
    lines.push(`额度使用：${body.config.creditUsagePercent}%`)
  }
  const period = body.config.currentPeriod
  if (typeof period?.start === 'string' && typeof period?.end === 'string') {
    lines.push(`本期：${formatDate(period.start)} 至 ${formatDate(period.end)}`)
  }
  if (body.config.includedUsed !== undefined) lines.push(`套餐内使用：${renderScalar(body.config.includedUsed)}`)
  if (body.config.totalUsed !== undefined) lines.push(`总使用：${renderScalar(body.config.totalUsed)}`)
  if (body.config.onDemandUsed !== undefined) lines.push(`按量使用：${renderScalar(body.config.onDemandUsed)}`)
  if (body.config.prepaidBalance !== undefined) lines.push(`预付余额：${renderScalar(body.config.prepaidBalance)}`)
  return lines.join('\n')
}

export function renderContext(result) {
  const context = result?.context ?? result
  if (context === undefined || context === null || typeof context !== 'object') {
    return 'Grok Build 没有返回上下文信息。'
  }
  const lines = [
    `上下文：${formatInteger(context.used)} / ${formatInteger(context.total)} tokens（${context.usagePct ?? 0}%）`,
    `剩余：${formatInteger(context.freeTokens)} tokens`,
    `消息：${formatInteger(context.messageCount)} 条，${formatInteger(context.messageTokens)} tokens`,
    `工具定义：${formatInteger(context.toolDefinitionsCount)} 个，${formatInteger(context.toolDefinitionsTokens)} tokens`,
  ]
  for (const category of context.usageCategories ?? []) {
    lines.push(`${category.label}：${formatInteger(category.tokens)} tokens${category.detail ? `（${category.detail}）` : ''}`)
  }
  return lines.join('\n')
}

export function renderSessionInfo(result) {
  if (result === undefined || result === null) return 'Grok Build 没有返回会话信息。'
  const context = result.context
  return [
    `模型：${result.modelDisplayName ?? result.model ?? '未知'}`,
    `会话：${result.sessionId ?? '未知'}`,
    `工作目录：${result.cwd ?? '未知'}`,
    `轮次：${formatInteger(result.turnIndex ?? result.turns)}`,
    context
      ? `上下文：${formatInteger(context.used)} / ${formatInteger(context.total)} tokens（${context.usagePct ?? 0}%）`
      : '上下文：未知',
  ].join('\n')
}

export function renderScalar(value) {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (typeof value?.val === 'number' || typeof value?.val === 'string') return String(value.val)
  return renderRawOutput(value)
}

export function formatInteger(value) {
  return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : '未知'
}

export function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function permissionOutcome(dshOutcome, options) {
  const list = Array.isArray(options) ? options : []
  if (dshOutcome === 'allowed-once') {
    const option = list.find(candidate => candidate.kind === 'allow_once')
      ?? list.find(candidate => candidate.kind === 'allow_always')
    return option === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  if (dshOutcome === 'rejected') {
    const option = list.find(candidate => candidate.kind === 'reject_once')
      ?? list.find(candidate => candidate.kind === 'reject_always')
    return option === undefined
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

export function sessionBlank(session) {
  return !session.events.some(event => event.type === 'turn/start')
}
