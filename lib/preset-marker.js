/** Grok Build Web commands mounted only beneath Grok-backed agents. */

export const name = 'grok-build-harness-marker'
export const inject = ['commands']

/** Client contributions that must never appear as host commands, or `/` dies. */
export const CLIENT_OWNED_COMMANDS = new Set(['model'])

export const WEB_COMMANDS = [
  { name: 'compact', description: '压缩 Grok 会话上下文', input: { hint: '[需要保留的内容]' } },
  { name: 'always-approve', description: '切换 Grok 自动批准模式', input: { hint: '[on|off]' } },
  { name: 'context', description: '显示 Grok 上下文占用' },
  { name: 'session-info', description: '显示 Grok 会话信息' },
  { name: 'deep-research', description: '启动 Grok 深度研究工作流', input: { hint: '<问题>' } },
  { name: 'workflow', description: '启动或管理 Grok 工作流', input: { hint: '<名称或操作>' } },
  { name: 'goal', description: '设置或管理 Grok 自主目标', input: { hint: '<目标或操作>' } },
  { name: 'usage', description: '查看 Grok 套餐和额度使用情况' },
  { name: 'cost', description: '查看 Grok 套餐和额度使用情况（/usage 的别名）' },
  { name: 'btw', description: '向 Grok 提问旁支问题，不打断或写入主对话', input: { hint: '<问题>' } },
  { name: 'home', description: '返回 Web 的新会话入口' },
  { name: 'welcome', description: '返回 Web 的新会话入口（/home 的别名）' },
  { name: 'status', description: '显示 Grok 会话信息（/session-info 的别名）' },
  { name: 'info', description: '显示 Grok 会话信息（/session-info 的别名）' },
  { name: 'effort', description: '设置 Grok 推理力度', input: { hint: '[low|medium|high|xhigh]' } },
]

export function apply(ctx) {
  for (const command of WEB_COMMANDS) {
    if (CLIENT_OWNED_COMMANDS.has(command.name)) continue
    ctx.commands.register({
      ...command,
      handler: invocation => invocation.agent.runWebCommand(command.name, invocation.rawInput),
    })
  }
}
