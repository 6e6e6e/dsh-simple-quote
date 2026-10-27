import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

test('the built bundle has no injection markers left', () => {
  assert.ok(!bundle.includes('@@inject:'))
})

test('the built bundle registers and materializes under the host loader contract', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://localhost/',
  })
  let definition = null
  dom.window.__ModuleLoader__ = {
    load(value) {
      definition = value
    },
  }
  dom.window.eval(bundle)

  assert.notEqual(definition, null, 'the loader received a registration')
  assert.equal(definition.id, 'dsh-simple-quote')

  const react = {
    createElement: () => null,
    Fragment: 'Fragment',
    useEffect: () => {},
    useLayoutEffect: () => {},
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
  }
  const plugin = definition.factory((name) => (name === 'react' ? react : {}))
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'sessions'])
})
