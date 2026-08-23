/** Resolve ACP file requests without escaping the session workspace by default. */

import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/**
 * Resolve a requested path and reject lexical or symlink traversal outside the workspace.
 *
 * @param {string} requestedPath ACP file path.
 * @param {string} cwd Absolute session workspace.
 * @param {'read' | 'write'} operation File operation.
 * @param {boolean} allowOutsideWorkspace Whether the caller explicitly permits host-wide access.
 * @returns {Promise<string>} Canonical path for the file operation.
 */
export async function resolveWorkspacePath(requestedPath, cwd, operation, allowOutsideWorkspace) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('ACP file path is missing')
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('ACP session workspace is not absolute')
  }
  const candidate = resolve(cwd, requestedPath)
  if (allowOutsideWorkspace) return candidate

  const workspace = await realpath(cwd)
  if (operation === 'read') {
    const target = await realpath(candidate)
    assertInside(workspace, target)
    return target
  }

  try {
    const target = await realpath(candidate)
    assertInside(workspace, target)
    return target
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const missing = [basename(candidate)]
  let ancestor = dirname(candidate)
  while (true) {
    try {
      const existing = await realpath(ancestor)
      assertInside(workspace, existing)
      return join(existing, ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function assertInside(workspace, target) {
  if (target !== workspace && !target.startsWith(`${workspace}${sep}`)) {
    throw new Error(`ACP file path escapes the session workspace: ${target}`)
  }
}
