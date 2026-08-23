import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspacePath } from '../lib/workspace-path.js'

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-acp-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  try {
    await run({ workspace, outside })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('resolveWorkspacePath', () => {
  it('resolves files inside the workspace', async () => {
    await withWorkspace(async ({ workspace }) => {
      const file = join(await realpath(workspace), 'nested', 'file.txt')
      assert.equal(await resolveWorkspacePath('nested/file.txt', workspace, 'write', false), file)
    })
  })

  it('rejects lexical traversal outside the workspace', async () => {
    await withWorkspace(async ({ workspace }) => {
      await assert.rejects(
        resolveWorkspacePath('../outside/file.txt', workspace, 'write', false),
        /escapes the session workspace/,
      )
    })
  })

  it('rejects symlinks that escape the workspace', async () => {
    await withWorkspace(async ({ workspace, outside }) => {
      const file = join(outside, 'secret.txt')
      await writeFile(file, 'secret')
      await symlink(outside, join(workspace, 'linked'))
      await assert.rejects(
        resolveWorkspacePath('linked/secret.txt', workspace, 'read', false),
        /escapes the session workspace/,
      )
    })
  })

  it('allows an explicit host-wide access mode', async () => {
    await withWorkspace(async ({ workspace, outside }) => {
      const file = join(outside, 'file.txt')
      assert.equal(await resolveWorkspacePath(file, workspace, 'write', true), file)
    })
  })
})
