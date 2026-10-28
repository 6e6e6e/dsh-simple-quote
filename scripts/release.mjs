#!/usr/bin/env node
/**
 * Cut the GitHub release for the current package version.
 *
 * Two tarballs go up: the versioned file `npm pack` produces, and a copy named
 * `dsh-simple-quote.tgz`. Storefronts link to
 * `releases/latest/download/dsh-simple-quote.tgz`, and `latest` resolves at
 * request time while the filename is taken literally — so the version-free name
 * has to be uploaded to every release, or that link quietly keeps serving the
 * previous version.
 *
 * Usage: npm run release
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { name, version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tag = `v${version}`
const versioned = path.join(root, `${name}-${version}.tgz`)

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options })
}

function releaseExists() {
  try {
    execFileSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Always repack so a stale tarball from an earlier run can never be published.
run('npm', ['pack'])
if (!existsSync(versioned)) throw new Error(`pack did not produce ${path.basename(versioned)}`)

// Stage the version-free copy under a temporary directory so the working tree
// never holds two identical 40 KB tarballs.
const staging = mkdtempSync(path.join(tmpdir(), 'dsh-release-'))
const alias = path.join(staging, `${name}.tgz`)
copyFileSync(versioned, alias)

try {
  if (!releaseExists()) {
    run('gh', ['release', 'create', tag, '--title', tag, '--generate-notes'])
  }
  run('gh', ['release', 'upload', tag, versioned, alias, '--clobber'])
} finally {
  rmSync(staging, { recursive: true, force: true })
}

console.log(`\n${tag} published with both ${name}-${version}.tgz and ${name}.tgz`)
