/**
 * wutd 打包与部署
 *
 * - pack:  生成 version.json（git hash/date）+ data-r<rev>-<hash>-<yymmdd>.zip
 *          内容：category/ detail/ viveid/ index/ download/ version.json
 * - zip:   打包数据压缩包
 * - deploy: 上传数据压缩包，成功后清理本地 zip
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
const zlib = require('zlib')
const { repoRoot, git, readText, today, out, die } = require('./util')

const BASE_URL = 'https://wutd.crrashh.com/v2'
const DEPLOY_PATH = '/admin/deploy'
const PACK_DIRS = ['category', 'detail', 'viveid', 'index', 'download']

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        t[n] = c >>> 0
    }
    return t
})()

function crc32(buf) {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

/* --------------------------- ZIP 容器 ------------------------------ */

function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    return { time, date }
}

/**
 * 构建zip（entries: [{ name, data(Buffer), mtime(Date) }]）
 * 返回 Buffer
 */
function buildZip(entries) {
    const localParts = []
    const centralParts = []
    let offset = 0
    const now = new Date()
    const { time, date } = dosDateTime(now)

    for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf-8')
        const raw = e.data
        const deflated = zlib.deflateRawSync(raw, { level: 9 })
        const useDeflate = deflated.length < raw.length
        const payload = useDeflate ? deflated : raw
        const method = useDeflate ? 8 : 0
        const crc = crc32(raw)

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4) // version needed
        local.writeUInt16LE(0x0800, 6) // UTF-8 flag
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(time, 10)
        local.writeUInt16LE(date, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(payload.length, 18)
        local.writeUInt32LE(raw.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        local.writeUInt16LE(0, 28)

        localParts.push(local, nameBuf, payload)

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4) // version made by
        central.writeUInt16LE(20, 6) // version needed
        central.writeUInt16LE(0x0800, 8)
        central.writeUInt16LE(method, 10)
        central.writeUInt16LE(time, 12)
        central.writeUInt16LE(date, 14)
        central.writeUInt32LE(crc, 16)
        central.writeUInt32LE(payload.length, 20)
        central.writeUInt32LE(raw.length, 24)
        central.writeUInt16LE(nameBuf.length, 28)
        central.writeUInt16LE(0, 30) // extra
        central.writeUInt16LE(0, 32) // comment
        central.writeUInt16LE(0, 34) // disk number
        central.writeUInt16LE(0, 36) // internal attrs
        central.writeUInt32LE(0, 38) // external attrs
        central.writeUInt32LE(offset, 42)

        centralParts.push(central, nameBuf)
        offset += 30 + nameBuf.length + payload.length
    }

    const centralBuf = Buffer.concat(centralParts)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([...localParts, centralBuf, eocd])
}

/* ------------------------------- pack ------------------------------ */

function collectEntries() {
    const root = repoRoot()
    const entries = []
    const walk = (dir, prefix) => {
        for (const f of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, f)
            const rel = prefix ? `${prefix}/${f}` : f
            if (fs.statSync(full).isDirectory()) walk(full, rel)
            else entries.push({ name: rel, data: fs.readFileSync(full) })
        }
    }
    for (const d of PACK_DIRS) walk(path.join(root, d), d)
    const hash = git(['rev-parse', '--short', 'HEAD'])
    const vdate = git(['log', '-1', '--format=%cs'])
    const versionJson = `{"hash":"${hash}","date":"${vdate}"}`
    fs.writeFileSync(path.join(root, 'version.json'), versionJson)
    entries.push({ name: 'version.json', data: Buffer.from(versionJson) })
    return entries
}

function cmdPack() {
    const root = repoRoot()
    const count = git(['rev-list', '--count', 'HEAD'])
    const hash = git(['rev-parse', '--short', 'HEAD'])
    const ymd = today().replace(/-/g, '').slice(2)
    const name = `data-r${count}-${hash}-${ymd}.zip`
    const entries = collectEntries()
    const zipPath = path.join(root, name)
    fs.writeFileSync(zipPath, buildZip(entries))
    const kb = (fs.statSync(zipPath).size / 1024).toFixed(1)
    out.ok(`打包完成: ${name} (${entries.length} 个文件, ${kb} KB)`)
    return zipPath
}

/* ------------------------------ deploy ----------------------------- */

function deployZip(zipPath, token) {
    return new Promise((resolve, reject) => {
        const zipBuffer = fs.readFileSync(zipPath)
        const url = new URL(BASE_URL + DEPLOY_PATH)
        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': zipBuffer.length,
                },
            },
            (res) => {
                let body = ''
                res.on('data', (c) => (body += c))
                res.on('end', () => {
                    let json
                    try {
                        json = JSON.parse(body)
                    } catch {
                        json = { raw: body }
                    }
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, json })
                    else reject(new Error(`部署失败 (${res.statusCode}): ${json.message || body}`))
                })
            }
        )
        req.on('error', reject)
        req.write(zipBuffer)
        req.end()
    })
}

async function cmdDeploy(flags = {}) {
    const root = repoRoot()
    const tokenFile = path.join(root, 'deploy.txt')
    if (!fs.existsSync(tokenFile)) {
        out.warn('deploy.txt 不存在，跳过自动部署')
        return
    }
    const token = readText(tokenFile).trim()
    if (!token) {
        out.warn('deploy.txt 为空，跳过自动部署')
        return
    }

    let zipPath
    if (flags['no-pack']) {
        const zips = fs.readdirSync(root).filter((f) => /^data-r.+\.zip$/.test(f))
        if (zips.length === 0) die('--no-pack 指定但未找到已打包的 zip')
        zipPath = path.join(root, zips[zips.length - 1])
        out.info(`复用现有数据包: ${zips[zips.length - 1]}`)
    } else {
        zipPath = cmdPack()
    }

    console.log('[INFO] 正在上传数据包...')
    console.log(`[INFO] 文件: ${path.basename(zipPath)}`)
    try {
        const { status, json } = await deployZip(zipPath, token)
        out.ok(`HTTP ${status} 部署成功`)
        if (json.data && json.data.current) {
            console.log(`[INFO] 当前版本: ${json.data.current.hash} (${json.data.current.date})`)
        }
        if (json.data && json.data.backup) {
            console.log(`[INFO] 备份: ${json.data.backup}`)
        }
        if (!flags['no-clean']) {
            fs.unlinkSync(zipPath)
            out.ok('已清理本地数据包')
        }
    } catch (e) {
        die(e.message)
    }
}

module.exports = { cmdPack, cmdDeploy, buildZip, crc32 }
