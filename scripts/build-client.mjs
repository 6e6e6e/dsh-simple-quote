#!/usr/bin/env node
/**
 * Bundle the browser half of dsh-simple-quote.
 *
 * The host's client-module loader only resolves registered package ids through
 * `require`; it cannot import relative ES modules from an installed bundle.
 * So `lib/quote-text.js` and `lib/selection-markdown.js` are the source of
 * truth (importable by node:test), and this script inlines them into the
 * single classic script the loader evaluates.
 *
 * Run via `npm run build`; `prepack` runs it automatically before a tarball is
 * produced, so the shipped `client.js` can never drift from `lib/`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

/** Strip the ES module surface; the code is inlined into one factory scope. */
function stripModule(source) {
  return source
    .replace(/^import[\s\S]*?from\s+'[^']+'\s*;?[ \t]*\n/gm, '')
    .replace(/^export\s+/gm, '')
    .trim()
}

function indent(source) {
  return source
    .split('\n')
    .map((line) => (line === '' ? line : `    ${line}`))
    .join('\n')
}

const injections = [
  ['    // @@inject:quote-text@@', 'lib/quote-text.js'],
  ['    // @@inject:selection-markdown@@', 'lib/selection-markdown.js'],
]

let output = read('lib/client.template.js')
for (const [marker, file] of injections) {
  if (!output.includes(marker)) throw new Error(`build-client: injection marker missing for ${file}`)
  // Function replacer: injected code contains `$$`/`` $` `` sequences that a
  // string replacement would expand as replacement patterns.
  const injected = indent(stripModule(read(file)))
  output = output.replace(marker, () => injected)
}

if (output.includes('@@inject:')) throw new Error('build-client: unresolved injection marker')
if (/^\s*(?:import|export)\s/m.test(output)) throw new Error('build-client: module syntax leaked into the bundle')

fs.writeFileSync(path.join(root, 'client.js'), output)
console.log(`build-client: wrote client.js (${output.length} bytes)`)
