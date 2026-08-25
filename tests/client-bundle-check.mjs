import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])

assert.deepEqual(
  [...new Set(requires)].sort(),
  ['@deepseek-ai/cordis', 'react', 'react/jsx-runtime'],
  'the client bundle may require only DSH platform seed modules',
)
assert.doesNotMatch(bundle, /dsh-client-ui-model-selection/)
assert.match(
  bundle,
  /\[data-chat-call-id\]:has\(\[data-grok-activity\]\[data-expanded=\\?"false\\?"\]\) > \[data-subcalls\]/,
  'a collapsed Grok activity group must hide its nested tool timeline',
)

console.log('client bundle module table check passed')
