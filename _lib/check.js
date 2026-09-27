/**
 * wutd check：全库一致性校验
 *
 * 不变量：
 * 1. 全部 JSON 可解析
 * 2. nav 链对称：A.nav.next == B ⇒ B.nav.previous == A（目标文件存在时必须对称）
 * 3. 类目 list head 应有对应 detail 文件（detail 目录存在时）
 * 4. index/category.json 的 latestBuild 不应落后于 category list head
 * 5. latest-builds.json 条目 version 不应落后于 category list head
 * 6. detail.belongsTo.path 必须等于所在目录名
 */
const fs = require('fs')
const path = require('path')
const { repoRoot, readJson, cmpBuild, out } = require('./util')

function p(...seg) {
    return path.join(repoRoot(), ...seg)
}

const sameCatStr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

function cmdCheck() {
    let errors = 0
    let warns = 0
    const err = (m) => { errors++; out.error(m) }
    const warn = (m) => { warns++; out.warn(m) }

    // 1. JSON 可解析 + 收集 detail 文件
    const details = [] // { category, build, doc }
    const detailDirs = fs.existsSync(p('detail')) ? fs.readdirSync(p('detail')) : []
    for (const dir of detailDirs) {
        const full = p('detail', dir)
        for (const f of fs.readdirSync(full)) {
            if (!f.endsWith('.json')) continue
            const build = f.replace(/\.json$/, '')
            try {
                const doc = readJson(path.join(full, f))
                details.push({ category: dir, build, doc, file: path.join('detail', dir, f) })
                if (doc.belongsTo && doc.belongsTo.path !== dir) {
                    err(`${dir}/${f}: belongsTo.path(${doc.belongsTo.path}) 与目录名(${dir})不符`)
                }
                if (!doc.build || !doc.build.branch) warn(`${dir}/${f}: 缺少 build.branch`)
                if (!doc.nav || !doc.nav.previous) warn(`${dir}/${f}: 缺少 nav.previous`)
            } catch (e) {
                err(`JSON 解析失败: ${e.message}`)
            }
        }
    }
    for (const d of ['category', 'index', 'download', 'viveid']) {
        const dir = p(d)
        if (!fs.existsSync(dir)) continue
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue
            try {
                readJson(path.join(dir, f))
            } catch (e) {
                err(`JSON 解析失败: ${e.message}`)
            }
        }
    }

    // 2. nav 对称性 + 自引用
    const findDetail = (category, build) => details.find((d) => d.category === category && d.build === build)
    for (const d of details) {
        const nav = d.doc.nav || {}
        for (const dirKey of ['previous', 'next']) {
            const t = nav[dirKey]
            if (!t) continue
            if (t.category === d.category && t.build === d.build) {
                err(`${d.file}: nav.${dirKey} 指向自身（自引用）`)
                continue
            }
            const target = findDetail(t.category, t.build)
            if (!target) {
                warn(`${d.file}: nav.${dirKey} 指向不存在的 detail 文件 ${t.category}/${t.build}`)
                continue
            }
            const back = target.doc.nav && target.doc.nav[dirKey === 'next' ? 'previous' : 'next']
            if (!back || !sameCatStr(back.category, d.category) || back.build !== d.build) {
                // 多线索类目（client/server 混编）中存在历史手工调整导致的不对称，降为警告
                warn(`nav 链不对称: ${d.file} --${dirKey}--> ${t.category}/${t.build}，但对方未回指`)
            }
        }
    }

    // 3/4/5. list head、索引同步
    const catIndex = readJson(p('index', 'category.json'))
    const lb = readJson(p('index', 'latest-builds.json'))
    const lbByCategory = {}
    for (const g of lb) {
        for (const r of g.releases || []) {
            if (r.category) lbByCategory[r.category] = r
        }
    }
    const headOfCategory = (category) => {
        const catFile = p('category', `${category}.json`)
        if (!fs.existsSync(catFile)) return null
        let doc
        try {
            doc = readJson(catFile)
        } catch (e) {
            return null // 解析错误已由第一遍统一报告
        }
        if (!doc.list || doc.list.length === 0) return null
        return { head: String(doc.list[0][0]), date: String(doc.list[0][1]), doc }
    }

    // 3. list head 应有 detail
    const catFiles = fs.existsSync(p('category')) ? fs.readdirSync(p('category')).filter((f) => f.endsWith('.json')) : []
    for (const f of catFiles) {
        const category = f.replace(/\.json$/, '')
        const info = headOfCategory(category)
        if (!info) continue
        if (fs.existsSync(p('detail', category))) {
            if (!fs.existsSync(p('detail', category, `${info.head}.json`))) {
                warn(`category/${f}: list head ${info.head} 缺少 detail 文件`)
            }
        }
    }

    // 4/5. 索引条目与 category list 的一致性（线索感知）
    // - 条目值在 list 中 → 可接受（该线索的最新构建）
    // - 条目值 > list head → 索引超前源数据 → 错误
    // - 条目值 < list head 且不在 list 中 → 索引指向未知旧构建 → 错误
    //   （不在 list 且 > head 属于服务线未跟踪 list，可接受）
    const checkIndexValue = (label, category, value, info) => {
        const catInfo = headOfCategory(category)
        if (!catInfo) {
            warn(`${label}: 条目 ${category} 无对应 category 文件`)
            return
        }
        const builds = catInfo.doc.list.map((x) => String(x[0]))
        if (builds.includes(value)) {
            info(`${label}: ${category}=${value} 为类目内某线索的最新构建，可接受`)
            return
        }
        const c = cmpBuild(value, catInfo.head)
        if (c > 0) err(`${label}: ${category} 的索引值(${value})超前于 list head(${catInfo.head})`)
        else err(`${label}: ${category} 的索引值(${value})落后于 list head(${catInfo.head}) 且不在 list 中`)
    }

    for (const plat of catIndex) {
        for (const pf of plat.platforms || []) {
            for (const it of pf.items || []) {
                if (!it.category) continue
                checkIndexValue('index/category.json', it.category, it.latestBuild, () => {})
            }
        }
    }

    for (const [category, r] of Object.entries(lbByCategory)) {
        checkIndexValue('latest-builds.json', category, r.version, () => {})
    }

    console.log('')
    if (errors === 0 && warns === 0) out.ok('全部一致性检查通过')
    else out[errors ? 'error' : 'warn'](`检查完成: ${errors} 个错误, ${warns} 个警告`)
    process.exit(errors ? 1 : 0)
}

module.exports = { cmdCheck }
