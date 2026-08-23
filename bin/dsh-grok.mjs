#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshCommand = process.env.DSH_COMMAND || 'dsh'
const grokCommand = process.env.GROK_COMMAND || 'grok'
const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const supportedDshVersion = '0.1.1-rc.2'

function printHelp() {
  process.stdout.write(`dsh-grok: DeepSeek Harness Web with an in-page DSH / Grok Build switcher\n\nUsage:\n  dsh-grok web [args...]       start DSH Web on port 3080\n  dsh-grok setup               install or refresh the plugin Bundle\n  dsh-grok doctor              check installation\n  dsh-grok grok [args...]      original Grok terminal UI\n`)
}

function commandOutput(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd, env })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

function run(command, args, env = process.env) {
  const child = spawn(command, args, { stdio: 'inherit', cwd: process.cwd(), env })
  child.once('error', (error) => {
    process.stderr.write(`dsh-grok: cannot start ${command}: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

function setup() {
  const version = commandOutput(dshCommand, ['--version'])
  if (version !== supportedDshVersion) {
    process.stderr.write(`dsh-grok: warning: developed against dsh ${supportedDshVersion}; found ${version}\n`)
  }
  const grokVersion = commandOutput(grokCommand, ['--version'])
  process.stdout.write(`Installing for dsh ${version}; ${grokVersion}\n`)
  commandOutput('npm', ['install', '--legacy-peer-deps'], packageRoot)
  commandOutput('npm', ['run', 'build'], packageRoot)
  commandOutput(dshCommand, ['plugin', '--profile', 'web', 'add', `link:${packageRoot}`])
  process.stdout.write(`Installed Grok Build ACP in ${dshHome}.\nRun "dsh-grok web" and choose DSH or Grok Build in the composer.\n`)
}

function doctor() {
  const dshVersion = commandOutput(dshCommand, ['--version'])
  const grokVersion = commandOutput(grokCommand, ['--version'])
  const profile = JSON.parse(readFileSync(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  const bundles = profile.dsh?.profile?.bundles ?? []
  const grokPreset = existsSync(join(packageRoot, 'presets', 'grok-build', 'agent.cordis.yml'))
  const client = existsSync(join(packageRoot, 'lib', 'client.js'))
  process.stdout.write(`dsh: ${dshVersion}${dshVersion === supportedDshVersion ? '' : ` (expected ${supportedDshVersion})`}\ngrok: ${grokVersion}\nDSH home: ${dshHome}\nHarness router Bundle: ${bundles.includes('dsh-grok-acp') ? 'installed' : 'not installed'}\nGrok preset: ${grokPreset ? 'installed' : 'missing'}\nClient bundle: ${client ? 'built' : 'missing'}\n`)
  if (!bundles.includes('dsh-grok-acp') || !grokPreset || !client) {
    throw new Error('Harness router installation is not ready; run dsh-grok setup')
  }
}

function runGrokWeb(args = []) {
  run(dshCommand, ['web', ...args])
}

async function choose() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printHelp()
    process.exitCode = 2
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question('选择运行方式：\n  1. DSH Web（页面内选择 DSH / Grok Build）\n  2. Grok Build TUI\n请输入 1 或 2：')).trim()
    if (answer === '1') runGrokWeb()
    else if (answer === '2') run(grokCommand, [])
    else {
      process.stderr.write('请输入 1 或 2。\n')
      process.exitCode = 2
    }
  } finally {
    rl.close()
  }
}

const [action, ...args] = process.argv.slice(2)
try {
  if (action === undefined) await choose()
  else if (action === 'web' || action === 'grok-web') runGrokWeb(args)
  else if (action === 'dsh') runGrokWeb(args)
  else if (action === 'grok') run(grokCommand, args)
  else if (action === 'setup') setup()
  else if (action === 'doctor') doctor()
  else if (action === '--help' || action === '-h' || action === 'help') printHelp()
  else {
    printHelp()
    process.exitCode = 2
  }
} catch (error) {
  process.stderr.write(`dsh-grok: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
