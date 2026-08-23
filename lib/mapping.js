/** Durable map from DSH session ids to Grok ACP session ids. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export class SessionMapping {
  constructor(path) {
    this.path = resolve(path)
    this.sessions = new Map()
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed?.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
        throw new Error('expected { version: 1, sessions: object }')
      }
      for (const [local, remote] of Object.entries(parsed.sessions)) {
        if (typeof remote === 'string') this.sessions.set(local, remote)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`cannot read Grok session mapping ${this.path}: ${error.message}`, { cause: error })
      }
    }
  }

  get(localId) {
    return this.sessions.get(localId)
  }

  set(localId, remoteId) {
    const previous = this.sessions.get(localId)
    this.sessions.set(localId, remoteId)
    try {
      this.flush()
    } catch (error) {
      if (previous === undefined) this.sessions.delete(localId)
      else this.sessions.set(localId, previous)
      throw error
    }
  }

  flush() {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    const sessions = Object.fromEntries([...this.sessions].sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(temp, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
  }
}
