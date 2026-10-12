/**
 * wutd ui —— 本地表单界面：一站式完成 建卡 → 校验 → apply/提交 → 部署
 *
 * 启动: node wu.js ui [--port 9880] [--no-open]
 * 仅绑定 127.0.0.1；所有动作都通过子进程调用 wu.js 本身，保证 UI 与 CLI 行为一致。
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { repoRoot, out, die } = require('./util')
const { previewNew } = require('./draft')

const CAT_RE = /^[A-Za-z0-9._-]{1,64}$/
const BUILD_RE = /^[0-9]{1,7}(\.[0-9]{1,7})+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BRANCH_RE = /^[\w./-]{0,80}$/

// 自动填充配置（外置 JSON，每次请求时重新读取，改完即生效）
const AUTOFILL_PATH = path.join(__dirname, 'autofill.json')
function readAutofill() {
    try {
        return JSON.parse(fs.readFileSync(AUTOFILL_PATH, 'utf-8'))
    } catch {
        return { releaseNotesChannels: {}, announcePlaceByHost: {} }
    }
}

/**
 * 探测候选发布说明链接是否真实存在。
 * learn.microsoft.com 对存在与不存在的构建都先 302（补 /en-us/ 前缀），
 * 因此必须跟随重定向（最多 3 跳），以终态状态码为准：仅 200 视为存在。
 * 读取到响应头即断开，不下载正文。
 */
function fetchStatus(url, depth = 0) {
    return new Promise((resolve) => {
        try {
            const req = https.request(
                url,
                { method: 'GET', timeout: 8000, headers: { 'User-Agent': 'wutd-autofill/1.0' } },
                (res) => {
                    const status = res.statusCode
                    const loc = res.headers.location
                    res.destroy()
                    if ((status === 301 || status === 302) && loc && depth < 3) {
                        resolve(fetchStatus(new URL(loc, url).toString(), depth + 1))
                        return
                    }
                    resolve({ status, finalUrl: url })
                }
            )
            req.on('timeout', () => {
                req.destroy()
                resolve(null)
            })
            req.on('error', () => resolve(null))
            req.end()
        } catch {
            resolve(null)
        }
    })
}

async function probeUrl(url) {
    const r = await fetchStatus(url)
    return r || { status: null, finalUrl: url }
}

/* --------------------------- git 同步（差异/推送） --------------------------- */

function gitOut(args, opts = {}) {
    const r = spawnSync('git', args, { cwd: repoRoot(), encoding: 'utf-8', ...opts })
    return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

/** 本地与云端（远端跟踪分支）的差异信息；fetch=true 时先刷新远端状态（20s 超时） */
function gitSyncInfo(doFetch) {
    let fetchNote = ''
    if (doFetch) {
        const f = spawnSync('git', ['fetch'], { cwd: repoRoot(), encoding: 'utf-8', timeout: 20000 })
        fetchNote =
            f.status === 0
                ? 'fetch 成功，远端状态已刷新'
                : `fetch 失败（${(f.stderr || f.error || '超时').trim().slice(0, 160)}）`
    }
    const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']).stdout
    const head = gitOut(['log', '-1', '--format=%h %s']).stdout
    const remoteRef = gitOut([
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/remotes/origin/${branch}`,
    ]).stdout
    const dirty = gitOut(['status', '--porcelain']).stdout.split('\n').filter(Boolean).length
    if (!remoteRef) {
        return { branch, head, remoteRef: null, fetchNote, dirty }
    }
    const remoteHead = gitOut(['log', '-1', '--format=%h %s', remoteRef]).stdout
    const counts = gitOut(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]).stdout.split(/\s+/)
    const behind = Number(counts[0]) || 0
    const ahead = Number(counts[1]) || 0
    const localOnly = gitOut(['log', '--oneline', '--no-decorate', `${remoteRef}..HEAD`]).stdout.split('\n').filter(Boolean)
    const remoteOnly = gitOut(['log', '--oneline', '--no-decorate', `HEAD..${remoteRef}`]).stdout.split('\n').filter(Boolean)
    return { branch, head, remoteRef, remoteHead, ahead, behind, localOnly, remoteOnly, dirty, fetchNote }
}

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
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'ui.html'))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : html)
        return
    }

    // 全局状态：类目列表 + 已有草稿
    if (req.method === 'GET' && url.pathname === '/api/state') {
        const autofill = readAutofill()
        send(res, 200, {
            categories: listCategories(),
            drafts: listDrafts(),
            autofill: autofill.categories || {},
            announcePlaceByHost: autofill.announcePlaceByHost || {},
        })
        return
    }

    // 发布说明链接候选探测：类目有映射时构造 Learn 候选 URL 并探活。
    // learn 对存在/不存在的构建都先 302，故跟随重定向后仅终态 200 才算存在
    if (req.method === 'GET' && url.pathname === '/api/autofill-url') {
        const category = url.searchParams.get('category') || ''
        const build = url.searchParams.get('build') || ''
        if (!CAT_RE.test(category) || !BUILD_RE.test(build)) {
            return send(res, 200, { ok: false, reason: '参数不合法' })
        }
        const slug = readAutofill().categories?.[category]?.releaseNotesChannel
        if (!slug) return send(res, 200, { ok: false, reason: 'no-slug' })
        const candidate = `https://learn.microsoft.com/windows-insider/release-notes/${slug}/preview-build-${build.replace(/\./g, '-')}`
        const { status } = await probeUrl(candidate)
        send(res, 200, { ok: status === 200, status, url: candidate })
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

    // Git 同步：本地与云端差异（fetch=1 时先刷新远端状态）
    if (req.method === 'GET' && url.pathname === '/api/git-status') {
        send(res, 200, gitSyncInfo(url.searchParams.get('fetch') === '1'))
        return
    }

    // Git 推送（外发操作，需显式确认；远端领先时拒绝）
    if (req.method === 'POST' && url.pathname === '/api/git-push') {
        const body = await readBody(req)
        if (!(body && body.confirm === true)) return send(res, 400, { code: 1, output: '缺少推送确认' })
        const info = gitSyncInfo(false)
        if (!info.remoteRef) return send(res, 200, { code: 1, output: '无远端跟踪分支，请先 git push -u 建立关联' })
        if (info.behind > 0) {
            return send(res, 200, {
                code: 1,
                output: `远端领先 ${info.behind} 个提交（本地缺失：\n${info.remoteOnly.join('\n')}）\n请先在终端处理分叉（git pull --rebase）后再推送`,
            })
        }
        if (info.ahead === 0) return send(res, 200, { code: 0, output: '本地与云端一致，无待推送提交' })
        const pushed = spawnSync('git', ['push'], { cwd: repoRoot(), encoding: 'utf-8', timeout: 120000 })
        const output = `git push exit ${pushed.status}\n${(pushed.stdout || '') + (pushed.stderr || '')}`.trim()
        send(res, 200, { code: pushed.status === 0 ? 0 : 1, output })
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
