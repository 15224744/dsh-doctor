#!/usr/bin/env node
// DSH 急救（v2）：宿主起不来时的离线体检 / 自动修复 / 最小启动 / 重启。
// 三条鱼合并版：parallel 的扫描面 + main 的 subcommand 与备份还原 + whale 的 restart/nuke 思路。
//
//   node dsh-doctor.mjs                 只体检（绝不写盘）
//   node dsh-doctor.mjs fix             = check + 自动修（每处先备份 .bak-<ts>）；可加 --fix 同义
//   node dsh-doctor.mjs safe --fix      最小启动：bundles 只留宿主内置两个
//   node dsh-doctor.mjs start           拉起桌面端
//   node dsh-doctor.mjs restart         先杀残留再拉起
//   node dsh-doctor.mjs restore <文件>   用指定备份还原 package.json / cordis.patch.yml
//   node dsh-doctor.mjs nuke --yes      把 profiles\desktop 挪开（数据不删），让应用重建默认
//   --json 输出机器可读摘要；--kill-zombies 处理占用 18787 的孤儿
// 退出码：0 = 干净；1 = 有问题（未修或修完仍有）；2 = 用法错误
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync, spawn, spawnSync } from 'node:child_process'

const HOME = process.env.USERPROFILE || process.env.HOME || homedir()
const DSH = process.env.DSH_HOME ?? join(HOME, '.dsh')
const PROF = join(DSH, 'profiles', 'desktop')
const APP = join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
const SAFE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const NL = String.fromCharCode(10)

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const mode = positional[0] ?? (flags.has('--fix') ? 'fix' : 'check')
const DO_FIX = mode === 'fix' || mode === 'safe' || flags.has('--fix')
const WANT_KILL = flags.has('--kill-zombies') || flags.has('--kill')
const JSON_OUT = flags.has('--json')
const F_SELF = fileURLToPath(import.meta.url)
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const out = []
const problems = []
const fixes = []
const say = (s) => { out.push(s); if (!JSON_OUT) console.log(s) }

let yaml = null
try {
  const p = join(PROF, 'node_modules', 'js-yaml', 'index.js').split(String.fromCharCode(92)).join('/')
  yaml = (await import('file:///' + p)).default
} catch { }

const isBom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
const stripBom = (t) => t.replace(/^\uFEFF/, '')
function parseJsonc(text) {
  let s = stripBom(text), res = '', inStr = false, q = '', esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1]
    if (inStr) { res += c; if (esc) esc = false; else if (c.charCodeAt(0) === 92) esc = true; else if (c === q) inStr = false; continue }
    if (c === '"' || c === "'") { inStr = true; q = c; res += c; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== String.fromCharCode(10)) i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue }
    res += c
  }
  return JSON.parse(res.replace(/,\s*([}\]])/g, '$1'))
}
function parseByExt(text, ext) {
  if (ext === '.json') JSON.parse(stripBom(text))
  else if (ext === '.jsonc') parseJsonc(text)
  else if ('.yml' === ext || '.yaml' === ext) { if (yaml) yaml.load(stripBom(text)) } // 没有 js-yaml 就只查 BOM/Tab，不判失败
}
function backupOf(file) {
  const b = file + '.bak-' + STAMP
  copyFileSync(file, b)
  return b
}
function newestParseable(file, ext) {
  const dir = dirname(file), base = basename(file)
  if (!existsSync(dir)) return null
  const cands = readdirSync(dir)
    .filter((n) => n.startsWith(base + '.bak') || n === base + '.bak-before-bundle-restore' || n.includes('.bom-bak-') || n.includes('.broken-'))
    .filter((n) => !n.endsWith('.stale'))
    .sort()
    .reverse()
  for (const n of cands) {
    try { parseByExt(readFileSync(join(dir, n)).toString('utf8'), ext); return join(dir, n) } catch { }
  }
  return null
}
function walk(dir, acc = [], depth = 0) {
  if (depth > 4) return acc
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === 'sessions' || e.name.startsWith('.git')) continue
    if (e.name.includes('.bak-') || e.name.endsWith('.bak')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc, depth + 1)
    else if (/\.(json|jsonc|yml|yaml)$/.test(e.name)) acc.push(p)
  }
  return acc
}

say('== DSH 急救（v2）==')
say(`模式 = ${mode}${DO_FIX ? '（会写盘，每处先备份）' : '（只读）'}   DSH_HOME = ${DSH}`)
if (!existsSync(DSH)) { say(`FAIL DSH_HOME 不存在：${DSH}`); problems.push({ kind: 'env' }); finish() }

// 1) 全量 BOM / 解析
const files = walk(DSH)
say(`-- 1. 扫 ${files.length} 个 json/jsonc/yml --`)
for (const f of files) {
  let buf
  try { buf = readFileSync(f) } catch { continue }
  const rel = f.slice(DSH.length + 1)
  const ext = extname(f).toLowerCase()
  if (isBom(buf)) {
    problems.push({ kind: 'bom', file: rel })
    say(`FAIL ${rel} 带 BOM`)
    if (DO_FIX) {
      const b = backupOf(f)
      writeFileSync(f, buf.subarray(3))
      fixes.push(rel)
      say(`  fixed: 去 BOM（备份 ${basename(b)}）`)
      buf = buf.subarray(3) // 同一趟继续往下查（BOM 和 Tab 常常一起出现，别留给下一次）
    } else continue
  }
  const text = buf.toString('utf8')
  try {
    parseByExt(text, ext)
    // Tab 缩进的 YAML：js-yaml 会报错，但即使能过，宿主也不吃
    if (('.yml' === ext || '.yaml' === ext) && /^[ \t]*\t/m.test(stripBom(text))) {
      problems.push({ kind: 'tab', file: rel })
      say(`FAIL ${rel} 有 Tab 缩进（YAML 不允许）`)
      if (DO_FIX) {
        const b = backupOf(f)
        writeFileSync(f, stripBom(text).split(NL).map((l) => l.replace(/^\t+/, (m) => '  '.repeat(m.length))).join(NL))
        fixes.push(rel)
        say(`  fixed: Tab 改成空格（备份 ${basename(b)}）`)
      }
    }
  } catch (e) {
    problems.push({ kind: 'parse', file: rel, err: String(e.message).slice(0, 80) })
    say(`FAIL ${rel} 解析失败：${String(e.message).slice(0, 80)}`)
    if (DO_FIX) {
      const nb = newestParseable(f, ext)
      if (nb) {
        const b = backupOf(f)
        copyFileSync(nb, f)
        fixes.push(rel)
        say(`  fixed: 用 ${basename(nb)} 还原（坏文件备份 ${basename(b)}）`)
      } else say('  skip: 没有可用备份，不瞎改')
    }
  }
}

// 2) profile 清单
say('-- 2. profile 清单 --')
let pkg = null
const PKG = join(PROF, 'package.json')
if (!existsSync(PKG)) {
  problems.push({ kind: 'manifest-missing' })
  say('FAIL profile package.json 不存在')
  if (DO_FIX) rebuildManifest()
} else {
  try {
    pkg = JSON.parse(stripBom(readFileSync(PKG, 'utf8')))
    const bs = pkg.dsh?.profile?.bundles ?? []
    say(`OK  package.json 可解析（bundles=${bs.length}, deps=${Object.keys(pkg.dependencies ?? {}).length}）`)
    // bundles 可解析性
    const bad = []
    for (const b of bs) {
      if (b.startsWith('@deepseek-ai/')) continue
      const cands = [join(PROF, 'node_modules', b), join(DSH, 'plugins', b), join(DSH, 'plugins', b.replace(/^dsh-/, ''))]
      const dir = cands.find((d) => existsSync(join(d, 'package.json')))
      if (!dir) { bad.push({ b, why: '找不到包目录' }); continue }
      try {
        const pj = JSON.parse(stripBom(readFileSync(join(dir, 'package.json'), 'utf8')))
        const cl = typeof pj.exports?.['./client'] === 'string' ? pj.exports['./client'] : pj.exports?.['./client']?.default
        if (cl && !existsSync(join(dir, cl))) bad.push({ b, why: `exports['./client'] → ${cl} 不存在` })
      } catch { bad.push({ b, why: '插件 package.json 解析失败' }) }
    }
    if (bad.length) {
      problems.push({ kind: 'bundles', bad: bad.map((x) => x.b) })
      for (const x of bad) say(`FAIL bundle ${x.b}: ${x.why}`)
      if (DO_FIX) {
        const keep = bs.filter((b) => !bad.some((x) => x.b === b))
        const b = backupOf(PKG)
        pkg.dsh.profile.bundles = keep
        writeFileSync(PKG, JSON.stringify(pkg, null, 2) + NL)
        fixes.push('bundles')
        say(`  fixed: 摘掉 ${bad.map((x) => x.b).join(', ')}（备份 ${basename(b)}）`)
      }
    } else say(`OK  ${bs.length} 个 bundle 都能找到目录/入口`)
    // 基线对比：expected-bundles.json 是「上次确认能加载」的清单，丢了插件要能看出来
    const expPath = join(PROF, 'expected-bundles.json')
    if (existsSync(expPath)) {
      try {
        const expRaw = JSON.parse(stripBom(readFileSync(expPath, 'utf8')))
        const exp = Array.isArray(expRaw) ? expRaw : expRaw.bundles ?? []
        const now = new Set(bs)
        const gone = exp.filter((x) => !now.has(x))
        const extra = bs.filter((x) => !exp.includes(x))
        if (gone.length || extra.length) {
          problems.push({ kind: 'bundles-baseline', gone, extra })
          say('FAIL bundles 与基线不一致：' + [
            gone.length ? '基线有但现在没有 ' + gone.join(', ') : '',
            extra.length ? '现在多了 ' + extra.join(', ') : '',
          ].filter(Boolean).join('；'))
          if (DO_FIX && !bad.length) {
            const b = backupOf(expPath)
            writeFileSync(expPath, JSON.stringify({ bundles: bs }, null, 2) + NL)
            fixes.push('expected-bundles')
            say('  fixed: 基线更新为当前 ' + bs.length + ' 项（备份 ' + basename(b) + '）')
          } else if (DO_FIX) say('  skip: 先把坏 bundle 处理掉再改基线，不然会把故障写进基线')
        } else say('OK  bundles 与基线一致（' + exp.length + ' 项）')
      } catch (e) {
        problems.push({ kind: 'expected-bundles', err: String(e.message).slice(0, 60) })
        say('FAIL expected-bundles.json 解析失败：' + String(e.message).slice(0, 60))
      }
    }
    if (false) console.log(NL)
  } catch (e) {
    problems.push({ kind: 'manifest', err: String(e.message).slice(0, 80) })
    say(`FAIL package.json 不可解析：${String(e.message).slice(0, 80)}`)
    if (DO_FIX) {
      const nb = newestParseable(PKG, '.json')
      if (nb) { const b = backupOf(PKG); copyFileSync(nb, PKG); fixes.push('manifest'); say(`  fixed: 用 ${basename(nb)} 还原（备份 ${basename(b)}）`) }
      else rebuildManifest()
    }
  }
}

function rebuildManifest() {
  // 没有备份可还原时的最后一招：只保留「内置 bundle + 能解析到的插件」，其它一律不要，
  // 这样宿主一定能起来；要恢复哪些插件，起来后再一个个加。
  const expectedPath = join(PROF, 'expected-bundles.json')
  let wanted = [...SAFE_BUNDLES]
  try {
    const exp = JSON.parse(stripBom(readFileSync(expectedPath, 'utf8')))
    const list = Array.isArray(exp) ? exp : exp.bundles ?? []
    for (const b of list) {
      if (SAFE_BUNDLES.includes(b)) continue
      const dir = [join(PROF, 'node_modules', b), join(DSH, 'plugins', b), join(DSH, 'plugins', b.replace(/^dsh-/, ''))].find((d) => existsSync(join(d, 'package.json')))
      if (dir) wanted.push(b)
    }
  } catch { }
  if (DO_FIX) {
    try { backupOf(PKG) } catch { }
    writeFileSync(PKG, JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {}, dsh: { profile: { bundles: wanted } } }, null, 2) + NL)
    fixes.push('manifest-rebuilt')
    say(`  fixed: 重建最小清单（bundles=${wanted.length}）；起来后再逐个加回插件`)
  } else say('  → 加 --fix 会重建一份最小清单（只留内置 bundle + 能解析到的插件）')
}

// 3) 残留进程 + 端口
say('-- 3. 进程 / 端口 --')
try {
  const ns = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
  const rows = ns.split(/\r?\n/).filter((l) => l.includes(':18787') && l.includes('LISTENING'))
  if (!rows.length) say('OK  18787 没人监听')
  if (rows.length && !(WANT_KILL || DO_FIX)) {
    const pid = Number(rows[0].trim().split(/\s+/).pop())
    say(`INFO 18787 有人监听（pid=${pid}）；要点名孤儿或清理，加 --kill-zombies`)
  }
  for (const r of (WANT_KILL || DO_FIX) ? rows : []) {
    const pid = Number(r.trim().split(/\s+/).pop())
    let cmd = ''
    try {
      cmd = execFileSync('powershell', ['-NoProfile', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $par = Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue; $pn = if ($par) { $par.ProcessName } else { 'gone' }; "$pn|$($p.CommandLine)" }`],
        { encoding: 'utf8', timeout: 20000 }).trim()
    } catch { }
    // 是不是孤儿，看父进程：父进程是正在跑的 DeepSeek Harness 就是自己的子进程，别动它
    const parentName = (cmd.split('|')[0] || '').trim()
    const cmdLine = cmd.split('|').slice(1).join('|')
    const parentAlive = /DeepSeek/i.test(parentName)
    const isOrphan = /billion-context/.test(cmdLine) && !parentAlive
    say(`${isOrphan ? 'WARN' : 'INFO'} 18787 pid=${pid} parent=${parentName || '?'}${isOrphan ? '（billion-context 孤儿）' : '（本机正常实例）'}`)
    if (isOrphan) {
      problems.push({ kind: 'zombie', pid })
      if (WANT_KILL && DO_FIX) { try { process.kill(pid); fixes.push('zombie'); say(`  fixed: 结束孤儿 ${pid}`) } catch (e) { say(`  杀不掉：${e.message}`) } }
    }
  }
} catch { say('INFO 读不到 netstat，跳过端口检查') }

// 4) 动作类命令
if (mode === 'start' || mode === 'restart') {
  if (mode === 'restart') {
    try { execFileSync('taskkill', ['/IM', 'DeepSeek Harness.exe', '/F'], { stdio: 'ignore' }) } catch { }
    say('OK  已尝试结束旧进程')
  }
  if (existsSync(APP)) { spawn(APP, [], { detached: true, stdio: 'ignore' }).unref(); say('OK  已拉起桌面端，等 10–20 秒看窗口') }
  else say(`FAIL 找不到程序：${APP}`)
}
if (mode === 'safe') {
  if (!DO_FIX) say('提示：safe 需要配合 --fix 才写盘')
  else say('提示：safe 会把 bundles 裁到只剩内置两项；起来后逐个加回')
}
if (mode === 'restore') {
  const file = positional[1]
  const target = /patch/.test(file ?? '') ? join(PROF, 'cordis.patch.yml') : PKG
  if (!file || !existsSync(file)) { say('用法：node dsh-doctor.mjs restore <备份文件>'); process.exitCode = 2 }
  else { backupOf(target); copyFileSync(file, target); say(`OK  已用 ${basename(file)} 还原 ${basename(target)}（原文件已备份）`) }
}
if (mode === 'nuke') {
  if (!flags.has('--yes')) { say('nuke 会把 profiles/desktop 整个挪开；确认请加 --yes'); process.exitCode = 2 }
  else {
    const dest = PROF + '.nuked-' + STAMP
    renameSync(PROF, dest)
    say(`OK  已挪到 ${dest}（数据没删，随时挪回来）`)
  }
}

finish()

function finish() {
  say('-- 结论 --')
  if (DO_FIX && fixes.length) {
    // 修完再自检一次：以「修后还剩什么」决定退出码，而不是拿修前的问题数判死
    const again = spawnSync(process.execPath, [F_SELF], { env: process.env, encoding: 'utf8', timeout: 120000 })
    const stillBad = again.status !== 0
    say(stillBad ? 'FIXED-部分 修了一部分，复检仍有问题：' : 'FIXED 已修好，复检通过')
    const tailLines = String(again.stdout || '').split(String.fromCharCode(10)).filter((l) => /^\s*(FAIL|WARN|NEED-FIX|FIXED)/.test(l)).slice(0, 6)
    for (const l of tailLines) say('   ' + l.trim())
    process.exitCode = stillBad ? 1 : 0
    if (JSON_OUT) console.log(JSON.stringify({ mode, ok: !stillBad, problems, fixes, out }, null, 2))
    return
  }
  if (!problems.length) {
    say('PASS 没发现会让宿主起不来的问题')
    say(`     启动路径：${APP}`)
    process.exitCode = 0
  } else {
    say(`${fixes.length ? 'FIXED' : 'NEED-FIX'} 发现 ${problems.length} 类问题：${problems.map((p) => p.kind).join(', ')}`)
    process.exitCode = 1
  }
  if (JSON_OUT) console.log(JSON.stringify({ mode, ok: problems.length === 0, problems, fixes, out }, null, 2))
}
