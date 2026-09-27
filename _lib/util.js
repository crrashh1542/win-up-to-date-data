/**
 * wutd 通用工具：路径、Git 信息、构建号比较、输出着色
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

let cachedRoot = null

function repoRoot() {
    if (cachedRoot) return cachedRoot
    const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' })
    if (res.status !== 0 || !res.stdout) {
        console.error('[ERROR] 无法定位仓库根目录，请在 wutd-data 仓库内运行')
        process.exit(1)
    }
    cachedRoot = res.stdout.trim().replace(/\r?\n$/, '')
    return cachedRoot
}

function git(args) {
    const res = spawnSync('git', args, { encoding: 'utf-8' })
    if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} 失败: ${(res.stderr || '').trim()}`)
    }
    return res.stdout.trim()
}

function readText(p) {
    return fs.readFileSync(p, 'utf-8')
}

function detectEol(text) {
    return text.includes('\r\n') ? '\r\n' : '\n'
}

function writeText(p, text) {
    fs.writeFileSync(p, text)
}

function readJson(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch (e) {
        throw new Error(`JSON 解析失败 ${p}: ${e.message}`)
    }
}

/**
 * 构建号比较：'28000.3086' vs '27982.1'，逐段数值比较
 * 返回 >0 / 0 / <0
 */
function cmpBuild(a, b) {
    const pa = String(a).split('.').map(Number)
    const pb = String(b).split('.').map(Number)
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0
        const y = pb[i] || 0
        if (x !== y) return x - y
    }
    return 0
}

function today() {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const useColor = process.stdout.isTTY !== false && process.env.NO_COLOR === undefined

function colorize(code, s) {
    return useColor ? `\x1b[${code}m${s}\x1b[0m` : s
}

const out = {
    info: (s) => console.log(colorize('36', `[INFO] ${s}`)),
    ok: (s) => console.log(colorize('32', `[OK] ${s}`)),
    warn: (s) => console.log(colorize('33', `[WARN] ${s}`)),
    error: (s) => console.log(colorize('31', `[ERROR] ${s}`)),
}

function die(msg) {
    out.error(msg)
    process.exit(1)
}

module.exports = { repoRoot, git, readText, writeText, detectEol, readJson, cmpBuild, today, out, die }
