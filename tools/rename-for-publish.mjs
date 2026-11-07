#!/usr/bin/env node
// 改包名（发布前用）：包名同时是客户端 __ModuleLoader__ 的 id，必须一起改，否则宿主
// 找不到 factory，浮层与设置项都会消失。
//
//   node tools/rename-for-publish.mjs @your-name/dsh-memory-starmap
//   node tools/rename-for-publish.mjs dsh-memory-starmap --dry
//
// 只改本仓库里的字面量；改完记得同步 profile 里那份副本，或者干脆重新 plugin add。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = ['package.json', 'cordis.patch.yml', 'index.mjs', 'README.md', 'client/client.js', 'tools/clienttest.mjs']

const args = process.argv.slice(2)
const dry = args.includes('--dry') || args.includes('-n')
const next = args.find((a) => !a.startsWith('-'))

if (!next) {
  console.error('用法: node tools/rename-for-publish.mjs <新包名> [--dry]')
  process.exit(2)
}
if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(next)) {
  console.error('包名不合法（小写、可用 - . _，scoped 形如 @scope/name）：' + next)
  process.exit(2)
}

const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.name
if (prev === next) {
  console.log('包名没变：' + prev)
  process.exit(0)
}

let total = 0
const report = []
for (const rel of FILES) {
  const path = join(ROOT, rel)
  const before = readFileSync(path, 'utf8')
  const hits = before.split(prev).length - 1
  if (!hits) continue
  total += hits
  report.push(`${rel}: ${hits} 处`)
  if (!dry) writeFileSync(path, before.split(prev).join(next))
}

if (!dry) {
  // scoped 包默认私有，要显式声明 public 才能在 npm 上被搜索到
  pkg.name = next
  if (next.startsWith('@')) pkg.publishConfig = { access: 'public' }
  else delete pkg.publishConfig
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

console.log((dry ? '[dry] ' : '') + `改名 ${prev} → ${next}`)
for (const line of report) console.log('  ' + line)
console.log(`  共 ${total} 处${dry ? '（未写入）' : ''}`)
if (!dry) {
  console.log('\n接下来：')
  console.log('  1) node tools/selftest.mjs && node tools/clienttest.mjs')
  console.log('  2) 同步/重装 profile 里那份副本（改了 id，不重装的话旧入口会一直挂着）')
  console.log('  3) pnpm publish --access public')
}
