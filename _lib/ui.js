/**
 * wutd ui —— 本地表单界面：一站式完成 建卡 → 校验 → apply/提交 → 部署
 *
 * 启动: node wu.js ui [--port 9880] [--no-open]
 * 仅绑定 127.0.0.1；所有动作都通过子进程调用 wu.js 本身，保证 UI 与 CLI 行为一致。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { repoRoot, out, die } = require('./util')
const { previewNew } = require('./draft')

const CAT_RE = /^[A-Za-z0-9._-]{1,64}$/
const BUILD_RE = /^[0-9]{1,7}(\.[0-9]{1,7})+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BRANCH_RE = /^[\w./-]{0,80}$/

function wutdCli() {
    return path.join(__dirname, '..', 'wu.js')
}

function runCli(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [wutdCli(), ...args], { cwd: repoRoot() })
        let text = ''
        child.stdout.on('data', (d) => (text += d))
        child.stderr.on('data', (d) => (text += d))
        child.on('close', (code) => resolve({ code, output: text }))
        child.on('error', (e) => resolve({ code: -1, output: String(e) }))
    })
}

function send(res, code, data) {
    const body = JSON.stringify(data)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let text = ''
        req.on('data', (c) => {
            text += c
            if (text.length > 2 * 1024 * 1024) reject(new Error('请求体过大'))
        })
        req.on('end', () => {
            try {
                resolve(text ? JSON.parse(text) : {})
            } catch (e) {
                reject(new Error('请求体不是合法 JSON'))
            }
        })
        req.on('error', reject)
    })
}

function listCategories() {
    const dir = path.join(repoRoot(), 'category')
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            const name = f.replace(/\.json$/, '')
            let head = null
            let codename = name
            let count = 0
            try {
                const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
                codename = doc.codename || doc.name || name
                count = (doc.list || []).length
                head = doc.list && doc.list.length ? String(doc.list[0][0]) : null
            } catch {} // 空/损坏文件照样列出，previewNew 会给出错误信息
            return { name, codename, head, count }
        })
}

function listDrafts() {
    const dir = path.join(repoRoot(), '_drafts')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter((f) => f.endsWith('.draft.json'))
}

function draftPathFor(category, build) {
    return path.join(repoRoot(), '_drafts', `ui-${category}-${build}.draft.json`)
}

async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')

    // 页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'ui.html'))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
    }

    // 全局状态：类目列表 + 已有草稿
    if (req.method === 'GET' && url.pathname === '/api/state') {
        send(res, 200, { categories: listCategories(), drafts: listDrafts() })
        return
    }

    // 新构建预览：插入位置/预填/策略
    if (req.method === 'GET' && url.pathname === '/api/preview') {
        const category = url.searchParams.get('category') || ''
        const build = url.searchParams.get('build') || ''
        if (!CAT_RE.test(category)) return send(res, 200, { ok: false, error: '类目名不合法' })
        if (!BUILD_RE.test(build)) return send(res, 200, { ok: false, error: '构建号格式应为 主版本.修订号，如 28000.3099' })
        send(res, 200, previewNew(category, build))
        return
    }

    // 全库一致性校验
    if (req.method === 'GET' && url.pathname === '/api/check') {
        send(res, 200, await runCli(['check']))
        return
    }

    const body = req.method === 'POST' ? await readBody(req) : null

    // 校验 / 应用草稿
    if (req.method === 'POST' && url.pathname === '/api/apply') {
        const { draft, commit, signoff, gpg, validateOnly } = body || {}
        if (!draft || typeof draft !== 'object') return send(res, 400, { code: -1, output: '缺少 draft 数据' })
        const category = String(draft.category || '')
        const build = String((draft.build && draft.build.number) || '')
        if (!CAT_RE.test(category) || !BUILD_RE.test(build)) {
            return send(res, 400, { code: -1, output: 'category 或 build.number 不合法' })
        }
        fs.mkdirSync(path.join(repoRoot(), '_drafts'), { recursive: true })
        const draftPath = draftPathFor(category, build)
        fs.writeFileSync(draftPath, JSON.stringify(draft, null, 4) + '\n')
        const rel = path.relative(repoRoot(), draftPath)
        // 签名选项：未明确关闭时走 CLI 默认（-s -S）
        const commitArgs = commit
            ? ['--commit', ...(signoff === false ? ['--no-signoff'] : []), ...(gpg === false ? ['--no-gpg'] : [])]
            : []
        const result = validateOnly
            ? await runCli(['check', '--draft', rel])
            : await runCli(['apply', rel, ...commitArgs])
        send(res, 200, result)
        return
    }

    // 旧版本线 bump
    if (req.method === 'POST' && url.pathname === '/api/bump') {
        const { mode, category, from, build, date, branch, list } = body || {}
        const d = String(date || '')
        if (!DATE_RE.test(d)) return send(res, 400, { code: -1, output: 'date 格式应为 YYYY-MM-DD' })
        if (branch && !BRANCH_RE.test(String(branch))) return send(res, 400, { code: -1, output: 'branch 名不合法' })
        let args
        if (mode === 'from') {
            if (!BUILD_RE.test(String(from)) || !BUILD_RE.test(String(build))) {
                return send(res, 400, { code: -1, output: '版本号格式不合法' })
            }
            args = ['bump', '--from', String(from), String(build), d]
        } else {
            if (!CAT_RE.test(String(category))) return send(res, 400, { code: -1, output: '类目名不合法' })
            if (!BUILD_RE.test(String(build))) return send(res, 400, { code: -1, output: '构建号格式不合法' })
            args = ['bump', String(category), String(build), d]
        }
        if (branch) args.push('--branch', String(branch))
        if (list) args.push('--list')
        send(res, 200, await runCli(args))
        return
    }

    // 打包部署（上传生产，必须显式确认）
    if (req.method === 'POST' && url.pathname === '/api/deploy') {
        if (!(body && body.confirm === true)) {
            return send(res, 400, { code: -1, output: '缺少部署确认' })
        }
        send(res, 200, await runCli(['deploy']))
        return
    }

    send(res, 404, { error: 'not found' })
}

function cmdUi(flags = {}) {
    const port = Number(flags.port) || 9880
    const server = http.createServer((req, res) => {
        handle(req, res).catch((e) => send(res, 500, { error: String(e.message || e) }))
    })
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') die(`端口 ${port} 已被占用（可能已有一个 wu ui 在运行），可用 --port 切换端口`)
        die(String(e.message || e))
    })
    server.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${port}`
        out.ok(`wu ui 已启动: ${url}`)
        if (!flags['no-open'] && process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
        }
    })
}

module.exports = { cmdUi }
