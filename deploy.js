/**
 * Windows Up-to-Date 数据部署脚本
 * 
 * 注：需要本目录生成 data zip 包后再执行部署
 */

const https = require('https')
const fs = require('fs')
const path = require('path')

const BASE_URL = 'https://wutd.crrashh.com/v2'
const DEPLOY_PATH = '/admin/deploy'

function deploy(zipPath, token) {
    return new Promise((resolve, reject) => {
        const zipBuffer = fs.readFileSync(zipPath)

        const url = new URL(BASE_URL + DEPLOY_PATH)
        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/octet-stream',
                'Content-Length': zipBuffer.length,
            },
        }

        const req = https.request(options, (res) => {
            let body = ''
            res.on('data', (chunk) => { body += chunk })
            res.on('end', () => {
                const status = res.statusCode
                let json
                try {
                    json = JSON.parse(body)
                } catch {
                    json = { raw: body }
                }

                if (status >= 200 && status < 300) {
                    resolve({ status, json })
                } else {
                    reject(new Error(`Deploy failed (${status}): ${json.message || body}`))
                }
            })
        })

        req.on('error', reject)
        req.write(zipBuffer)
        req.end()
    })
}

async function main() {
    // 1. 校验 token
    const tokenFile = path.join(__dirname, 'deploy.txt')
    if (!fs.existsSync(tokenFile)) {
        console.log('[WARN] deploy.txt 不存在，跳过自动部署')
        process.exit(0)
    }
    const token = fs.readFileSync(tokenFile, 'utf-8').trim()
    if (!token) {
        console.log('[WARN] deploy.txt 为空，跳过自动部署')
        process.exit(0)
    }

    // 2. 查找生成的 zip 文件（匹配 data-r*-*.zip）
    const files = fs.readdirSync(__dirname)
    const zipFile = files.find((f) => /^data-r.+\.zip$/.test(f))
    if (!zipFile) {
        console.log('[ERROR] 未找到数据包文件，请确认打包步骤已执行')
        process.exit(1)
    }
    const zipPath = path.join(__dirname, zipFile)

    // 3. 执行部署
    console.log('[INFO] 正在上传数据包...')
    console.log(`[INFO] 文件: ${zipFile}`)

    try {
        const { status, json } = await deploy(zipPath, token)
        console.log(`[INFO] HTTP ${status} 部署成功`)
        if (json.data?.current) {
            console.log(`[INFO] 当前版本: ${json.data.current.hash} (${json.data.current.date})`)
        }
        if (json.data?.backup) {
            console.log(`[INFO] 备份: ${json.data.backup}`)
        }

        // 部署成功后删除本地 zip 包
        fs.unlinkSync(zipPath)
        console.log('[INFO] 已清理本地数据包')
    } catch (err) {
        console.log(`[ERROR] 部署失败: ${err.message}`)
        process.exit(1)
    }
}

main()
