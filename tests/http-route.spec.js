import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { sessionHandler } from '../lib/http-route.js'

describe('sessionHandler', () => {
  let server
  let baseUrl

  before(async () => {
    server = createServer(sessionHandler({
      read: async sessionId => ({ sessionId }),
      write: async input => input,
    }))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  it('serves loopback reads', async () => {
    const response = await fetch(`${baseUrl}/grok-acp/session?sessionId=session-1`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessionId: 'session-1' })
  })

  it('requires a same-origin write', async () => {
    const response = await fetch(`${baseUrl}/grok-acp/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: '{}',
    })
    assert.equal(response.status, 403)
  })

  it('accepts a same-origin JSON write', async () => {
    const response = await fetch(`${baseUrl}/grok-acp/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ sessionId: 'session-1', harness: 'dsh' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { sessionId: 'session-1', harness: 'dsh' })
  })

  it('rejects oversized writes', async () => {
    const response = await fetch(`${baseUrl}/grok-acp/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ value: 'x'.repeat(70 * 1024) }),
    })
    assert.equal(response.status, 413)
  })
})
