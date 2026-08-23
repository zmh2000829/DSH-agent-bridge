/** Resolve DeepSeek Harness packages from the running profile, not this checkout. */

import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function candidateRoots() {
  const roots = []
  const cwd = process.cwd()
  roots.push(cwd)
  const home = process.env.DSH_HOME
  if (home) roots.push(join(home, 'profiles', 'web'))
  try {
    roots.push(dirname(dirname(realpathSync(process.argv[1]))))
  } catch {
    // The process was not launched from a DSH binary.
  }
  return [...new Set(roots.filter(root => existsSync(join(root, 'package.json'))))]
}

export function requireFromDsh(packageName) {
  const errors = []
  for (const root of candidateRoots()) {
    try {
      return createRequire(join(root, 'package.json')).resolve(packageName)
    } catch (error) {
      errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    return createRequire(import.meta.url).resolve(packageName)
  } catch (error) {
    errors.push(`plugin: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`dsh-grok-acp cannot resolve ${packageName}:\n${errors.join('\n')}`)
}

export async function importFromDsh(packageName) {
  return import(pathToFileURL(requireFromDsh(packageName)).href)
}

export const CORDIS_ORIGINAL = Symbol.for('cordis.original')

export function unwrapService(service) {
  return service?.[CORDIS_ORIGINAL] ?? service
}
