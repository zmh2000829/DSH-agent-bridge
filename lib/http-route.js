/** Loopback-only HTTP transport for the composer bridge. */

const MAX_BODY_BYTES = 64 * 1024

export function isTrustedRequest(request, requireOrigin) {
  const rawHost = singleHeader(request.headers, 'host')
  if (rawHost === undefined) return false
  let host
  try {
    host = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  if (!loopback(host.hostname) || singleHeader(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = singleHeader(request.headers, 'origin')
  if (origin === undefined) return !requireOrigin
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}

export function sessionHandler(api) {
  return async (request, response) => {
    if (request.method === 'GET') {
      if (!isTrustedRequest(request, false)) return forbidden(response)
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return json(response, 400, { error: 'sessionId is required' })
      try {
        return json(response, 200, await api.read(sessionId))
      } catch (error) {
        return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
      return
    }
    if (!isTrustedRequest(request, true)) return forbidden(response)
    if (singleHeader(request.headers, 'content-type')?.split(';', 1)[0] !== 'application/json') {
      return json(response, 415, { error: 'content-type must be application/json' })
    }
    let input
    try {
      input = JSON.parse(await readBody(request))
    } catch (error) {
      if (error?.code === 'PAYLOAD_TOO_LARGE') return json(response, 413, { error: error.message })
      return json(response, 400, { error: 'invalid JSON' })
    }
    try {
      return json(response, 200, await api.write(input))
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function singleHeader(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function loopback(hostname) {
  const value = hostname.toLocaleLowerCase('en-US')
  if (value === 'localhost' || value.endsWith('.localhost') || value === '[::1]') return true
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function forbidden(response) {
  json(response, 403, { error: 'forbidden' })
}

function json(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  })
  response.end(payload)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    request.on('data', (chunk) => {
      length += chunk.length
      if (length > MAX_BODY_BYTES) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
        error.code = 'PAYLOAD_TOO_LARGE'
        reject(error)
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
