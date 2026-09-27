/**
 * wutd 草稿流程：new（建卡）→ check（校验）→ apply（投影落盘）
 *
 * 核心推导规则（依据历史提交归纳）：
 * - category list 按构建号降序排列，新构建插入自己的号位
 * - nav 链按构建号升序：previous = 号位下一位（更老的构建），next 继承它的 next
 * - 被取代构建的 next 改指新构建；其原 next 目标（可能跨类目）的 previous 回指新构建
 * - 索引条目只推进"当前值 == previous 构建"的同线索条目（server/client 线互不干扰）
 * - download.json 主线条目按 semester + counterpart 推进
 *
 * apply 时以仓库当前状态重新推导，草稿中的 nav 仅为预览。
 */
const fs = require('fs')
const path = require('path')
const { repoRoot, readText, readJson, writeText, cmpBuild, today, out, die } = require('./util')
const { serializeDetail } = require('./style')
const surgery = require('./surgery')

const DRAFT_DIR = '_drafts'
/** 类目名大小写不敏感比较（历史数据 27H1-Rubidium / 27H1-rubidium 混用） */
const sameCat = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

function p(...seg) {
    return path.join(repoRoot(), ...seg)
}

function loadCategory(category) {
    const catPath = p('category', `${category}.json`)
    if (!fs.existsSync(catPath)) return null
    return { catPath, doc: readJson(catPath) }
}

function detailPathOf(category, build) {
    return p('detail', category, `${build}.json`)
}

/**
 * 计算新构建在类目列表中的插入位置与链邻居
 * 返回 { position, above, below }；above/below 为相邻构建号（above 更新，below 更老），可为 null
 */
function insertionPoint(listBuilds, build) {
    let pos = listBuilds.length
    for (let i = 0; i < listBuilds.length; i++) {
        if (cmpBuild(listBuilds[i], build) < 0) {
            pos = i
            break
        }
    }
    return {
        position: pos,
        above: pos > 0 ? listBuilds[pos - 1] : null,
        below: pos < listBuilds.length ? listBuilds[pos] : null,
    }
}

/**
 * 从 index/category.json 读取类目标签，推导校验策略
 */
function policyFor(category) {
    const doc = readJson(p('index', 'category.json'))
    for (const plat of doc) {
        for (const pf of plat.platforms || []) {
            for (const it of pf.items || []) {
                if (it.category === category) {
                    const tags = (it.tag || []).map((t) => t.name)
                    const isStable = tags.some((t) => t === 'RP' || t === '正式')
                    return { tags, isStable }
                }
            }
        }
    }
    return { tags: [], isStable: false }
}

/* ------------------------------- new ------------------------------- */

/**
 * 预览新构建的插入位置、nav 推导与预填值（CLI new 与 UI 表单共用）
 */
function previewNew(category, build) {
    const cat = loadCategory(category)
    if (!cat) return { ok: false, error: `类目不存在: category/${category}.json` }
    if (!fs.existsSync(p('detail', category))) {
        return { ok: false, error: `类目 ${category} 尚无 detail 目录，属于结构性变更，请手动创建后重试` }
    }
    const listBuilds = (cat.doc.list || []).map((x) => String(x[0]))
    if (listBuilds.length === 0) return { ok: false, error: `类目 ${category} 的 list 为空，无法推导链，请手动处理首个构建` }
    if (listBuilds.includes(build)) return { ok: false, error: `构建 ${build} 已在 ${category} 的 list 中` }
    if (fs.existsSync(detailPathOf(category, build))) return { ok: false, error: `detail/${category}/${build}.json 已存在` }

    const { position, above, below } = insertionPoint(listBuilds, build)
    const belowDetail = below && fs.existsSync(detailPathOf(category, below)) ? readJson(detailPathOf(category, below)) : null

    const previewNext = belowDetail && belowDetail.nav && belowDetail.nav.next
        ? { category: belowDetail.nav.next.category, build: belowDetail.nav.next.build }
        : above ? { category, build: above } : null

    return {
        ok: true,
        category,
        build,
        position,
        above,
        below,
        prefill: {
            arch: belowDetail ? belowDetail.build.arch : [],
            counterpart: belowDetail ? belowDetail.build.counterpart : '',
            channel: belowDetail ? belowDetail.release.channel : '',
            announcePlace: belowDetail ? belowDetail.release.announcePlace : '',
        },
        navPreview: {
            previous: below ? { category, build: below } : null,
            next: previewNext,
        },
        policy: policyFor(category),
        headDetailMissing: below ? !fs.existsSync(detailPathOf(category, below)) : false,
    }
}

function cmdNew(category, build) {
    if (!category || !build) die('用法: wu new <category> <build>   例: wu new 26H1-bromine 28000.3086')
    const pv = previewNew(category, build)
    if (!pv.ok) die(pv.error)
    const { position, below, belowDetail } = pv

    const draft = {
        _meta: {
            note: 'wutd 草稿：字段可按任意顺序填写，缺失项由 wutd check --draft 列出；apply 时以仓库当前状态重新推导 nav',
            created: today(),
        },
        category,
        build: {
            number: build,
            branch: '',
            compileTime: '',
            arch: pv.prefill.arch,
            counterpart: pv.prefill.counterpart,
        },
        release: {
            channel: pv.prefill.channel,
            time: '',
            url: '',
            announcePlace: pv.prefill.announcePlace,
        },
        nav: pv.navPreview,
        updateId: [],
        download: [],
    }

    fs.mkdirSync(p(DRAFT_DIR), { recursive: true })
    const draftPath = p(DRAFT_DIR, `${category}-${build}.draft.json`)
    if (fs.existsSync(draftPath)) die(`草稿已存在: ${draftPath}`)
    writeText(draftPath, JSON.stringify(draft, null, 4) + '\n')

    const pol = pv.policy
    out.ok(`草稿已创建: ${path.relative(repoRoot(), draftPath)}`)
    console.log(`插入位置: list 第 ${position} 位${below ? `（previous 将指向 ${below}）` : '（将成为链头，无 previous）'}`)
    console.log(`
填写说明（可按任意顺序、分多次填写，随时用 check 查看进度）:
  build.branch        分支名，如 br_release_svc_prod3            [必填]
  build.compileTime   编译时间，格式 2026-09-17 17:39             [必填]
  build.arch          架构数组，已预填 ${JSON.stringify(draft.build.arch)}
  release.channel     渠道名，已预填 "${draft.release.channel}"    [必填]
  release.time        发布时间，格式 2026-09-22 17:00             [必填]
  release.url         ${pol.isStable ? '公告/KB 链接                                [必填: 正式渠道]' : '公告链接（Insider 构建可留空）'}
  release.announcePlace 公告来源，已预填 "${draft.release.announcePlace}"
  updateId            UUP ID，0..N 个 { arch, id }，arch 可省略
  download            MSU/ISO 下载项，0..N 个，可整体留空数组
完成后运行: node wu.js apply "${path.relative(repoRoot(), draftPath)}"`)
}

/* ------------------------------ check ------------------------------ */

function validateDraft(draftPath) {
    const problems = { errors: [], warns: [] }
    const draft = readJson(draftPath)
    const err = (m) => problems.errors.push(m)
    const warn = (m) => problems.warns.push(m)

    const category = draft.category
    const cat = loadCategory(category)
    if (!cat) err(`类目不存在: ${category}`)
    const build = String(draft.build && draft.build.number)
    if (!build || build === 'undefined') err('build.number 缺失')

    let below = null
    if (cat) {
        const listBuilds = (cat.doc.list || []).map((x) => String(x[0]))
        if (listBuilds.includes(build)) err(`构建 ${build} 已在 ${category} 的 list 中（可能已 apply）`)
        if (fs.existsSync(detailPathOf(category, build))) err(`detail/${category}/${build}.json 已存在（可能已 apply）`)
        if (!fs.existsSync(p('detail', category))) err(`类目 ${category} 缺少 detail 目录`)
        below = insertionPoint(listBuilds, build).below
        if (
            below &&
            draft.nav && draft.nav.previous && draft.nav.previous.build &&
            draft.nav.previous.build !== below
        ) {
            warn(`草稿的 previous 预览(${draft.nav.previous.build})与当前推导(${below})不一致，类目已有变动；apply 将以当前状态接线`)
        }
    }

    const b = draft.build || {}
    if (!b.branch) err('build.branch 缺失')
    else if (/_release_svc_prod$/.test(b.branch)) {
        warn(`branch("${b.branch}") 疑似只填了类目预填前缀，请补全 prod1/2/3、im 等实际后缀`)
    }
    if (!b.compileTime) err('build.compileTime 缺失')
    else if (!DATETIME_RE.test(b.compileTime)) err(`build.compileTime 格式应为 YYYY-MM-DD HH:mm，当前: ${b.compileTime}`)
    if (!Array.isArray(b.arch) || b.arch.length === 0) err('build.arch 不能为空')
    if (!b.counterpart) warn('build.counterpart 未填（部分构建没有对应版本；留空则 download.json 主线不推进）')

    const r = draft.release || {}
    if (!r.channel) err('release.channel 缺失')
    if (!r.time) err('release.time 缺失')
    else if (!DATETIME_RE.test(r.time)) err(`release.time 格式应为 YYYY-MM-DD HH:mm，当前: ${r.time}`)
    const pol = cat ? policyFor(category) : { isStable: false, tags: [] }
    if (!r.url) {
        if (pol.isStable) err('正式渠道（RP/正式）构建必须提供 release.url')
        else warn('release.url 未填（Insider 构建可接受）')
    }
    if (!r.announcePlace) warn('release.announcePlace 未填')

    const ids = draft.updateId || []
    const archSeen = new Set()
    ids.forEach((u, i) => {
        if (u.id && !GUID_RE.test(u.id)) err(`updateId[${i}].id 不是 GUID: ${u.id}`)
        if (u.arch && archSeen.has(u.arch)) err(`updateId[${i}].arch 重复: ${u.arch}`)
        if (u.arch) archSeen.add(u.arch)
    })
    if (ids.length === 0 && pol.isStable) warn('正式渠道构建通常有 updateId，当前为空')

    const dls = draft.download || []
    dls.forEach((item, i) => {
        if (!item.name) err(`download[${i}].name 缺失`)
        if (!Array.isArray(item.link) || item.link.length === 0) err(`download[${i}].link 不能为空`)
        else item.link.forEach((lk, j) => {
            if (!lk.url) err(`download[${i}].link[${j}].url 缺失`)
        })
        if (!item.arch) err(`download[${i}].arch 缺失`)
    })
    if (dls.length === 0 && pol.isStable) warn('正式渠道构建通常提供下载链接，当前 download 为空')

    return { draft, problems, pol, below }
}

function cmdCheckDraft(draftPath) {
    if (!draftPath || typeof draftPath !== 'string') {
        const dir = p(DRAFT_DIR)
        if (!fs.existsSync(dir)) die('_drafts 目录不存在，没有待检查的草稿')
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.draft.json'))
        if (files.length === 0) die('_drafts 目录下没有草稿')
        let exit = 0
        for (const f of files) {
            console.log(`--- ${f}`)
            if (!checkOne(path.join(dir, f))) exit = 1
        }
        process.exit(exit)
    }
    process.exit(checkOne(draftPath) ? 0 : 1)
}

function checkOne(draftPath) {
    const abs = path.isAbsolute(draftPath) ? draftPath : path.resolve(draftPath)
    let result
    try {
        result = validateDraft(abs)
    } catch (e) {
        out.error(`${path.basename(abs)}: ${e.message}`)
        return false
    }
    const { problems } = result
    const name = path.basename(abs)
    if (problems.errors.length === 0 && problems.warns.length === 0) {
        out.ok(`${name}: 可以 apply`)
        return true
    }
    problems.errors.forEach((m) => out.error(`${name}: ${m}`))
    problems.warns.forEach((m) => out.warn(`${name}: ${m}`))
    return problems.errors.length === 0
}

/* ------------------------------ apply ------------------------------ */

function cmdApply(draftPath, opts = {}) {
    if (!draftPath) die('用法: wu apply <draft.json> [--commit] [--keep-draft]')
    const abs = path.isAbsolute(draftPath) ? draftPath : path.resolve(draftPath)
    if (!fs.existsSync(abs)) die(`草稿不存在: ${draftPath}`)

    const { draft, problems } = validateDraft(abs)
    problems.warns.forEach((m) => out.warn(m))
    if (problems.errors.length) {
        problems.errors.forEach((m) => out.error(m))
        die('校验未通过，已取消 apply（错误必须修复；警告仅为提示不阻塞）')
    }

    const { category } = draft
    const build = String(draft.build.number)
    const cat = loadCategory(category)
    const listBuilds = (cat.doc.list || []).map((x) => String(x[0]))
    const { position, above, below } = insertionPoint(listBuilds, build)
    const date = String(draft.release.time).slice(0, 10)

    // 1. 推导 nav（以仓库当前状态为准）
    let nav
    let belowDetail = null
    const belowPath = below ? detailPathOf(category, below) : null
    if (below) {
        belowDetail = fs.existsSync(belowPath) ? readJson(belowPath) : null
        nav = { previous: { category, build: below } }
        if (belowDetail && belowDetail.nav && belowDetail.nav.next) {
            nav.next = { category: belowDetail.nav.next.category, build: belowDetail.nav.next.build }
        }
    } else {
        nav = {}
        if (above) nav.next = { category, build: above }
    }

    const touched = []

    // 2. 新 detail 文件
    const detail = {
        build: {
            number: build,
            branch: draft.build.branch,
            compileTime: draft.build.compileTime,
            arch: draft.build.arch,
            counterpart: draft.build.counterpart,
        },
        release: {
            channel: draft.release.channel,
            time: draft.release.time,
            url: draft.release.url,
            announcePlace: draft.release.announcePlace,
        },
        nav,
        belongsTo: { path: category, name: cat.doc.name },
        updateId: draft.updateId || [],
        download: draft.download || [],
    }
    const newDetailPath = detailPathOf(category, build)
    writeText(newDetailPath, serializeDetail(detail))
    touched.push(path.relative(repoRoot(), newDetailPath))
    out.ok(`创建 detail/${category}/${build}.json`)

    // 3. category list 按构建号插入
    surgery.insertCategoryListEntry(cat.catPath, build, date, position)
    touched.push(path.relative(repoRoot(), cat.catPath))
    out.ok(`${category}.json list 第 ${position} 位插入 [${build}, ${date}]`)

    // 4. 链接线：被取代构建的 next -> 新构建
    if (below) {
        if (belowDetail) {
            const belowNav = belowDetail.nav || {}
            const newBelowNav = {}
            if (belowNav.previous) newBelowNav.previous = belowNav.previous
            newBelowNav.next = { category, build }
            surgery.replaceNavObject(belowPath, newBelowNav)
            touched.push(path.relative(repoRoot(), belowPath))
            out.ok(`${below} 的 next -> ${build}`)

            // 5. 被取代构建的原 next 目标（同链或跨类目）previous 回指新构建
            if (belowNav.next && !(sameCat(belowNav.next.category, category) && belowNav.next.build === build)) {
                const targetPath = detailPathOf(belowNav.next.category, belowNav.next.build)
                if (fs.existsSync(targetPath)) {
                    const target = readJson(targetPath)
                    const tprev = target.nav && target.nav.previous
                    if (tprev && sameCat(tprev.category, category) && tprev.build === below) {
                        const tnav = { ...target.nav, previous: { category, build } }
                        surgery.replaceNavObject(targetPath, tnav)
                        touched.push(path.relative(repoRoot(), targetPath))
                        out.ok(`原 next 目标 ${belowNav.next.category}/${belowNav.next.build} 的 previous -> ${build}`)
                    } else {
                        out.warn(`原 next 目标 ${belowNav.next.category}/${belowNav.next.build} 的 previous 未指向 ${below}，已跳过`)
                    }
                } else {
                    out.info(`原 next 目标 ${belowNav.next.category}/${belowNav.next.build} 无 detail 文件，跳过回指`)
                }
            }
        } else {
            out.warn(`下位构建 ${below} 无 detail 文件，跳过链接线`)
        }
    } else if (above) {
        // 新构建成为链头：原链头（above）的 previous 回指新构建
        const abovePath = detailPathOf(category, above)
        if (fs.existsSync(abovePath)) {
            const aboveNav = readJson(abovePath).nav || {}
            const newAboveNav = { ...aboveNav, previous: { category, build } }
            surgery.replaceNavObject(abovePath, newAboveNav)
            touched.push(path.relative(repoRoot(), abovePath))
            out.ok(`原链头 ${above} 的 previous -> ${build}`)
        }
    }

    // 6. 索引推进（只推进被取代线索的条目）
    if (below) {
        try {
            surgery.replaceLatestBuild(p('index', 'category.json'), category, below, build)
            pushTouched(touched, path.join('index', 'category.json'))
            out.ok(`index/category.json: ${category} (${below}) -> ${build}`)
        } catch (e) {
            out.info(`index/category.json 未推进: ${e.message}`)
        }
        try {
            // 不自动写 branch：索引条目的 branch 是线索级属性，
            // 由用户通过 bump --branch 显式更新
            surgery.replaceReleaseEntry(p('index', 'latest-builds.json'), {
                category,
                expectedOld: below,
                version: build,
                date,
            })
            pushTouched(touched, path.join('index', 'latest-builds.json'))
            out.ok(`index/latest-builds.json: ${category} (${below}) -> ${build} (${date})`)
        } catch (e) {
            out.info(`index/latest-builds.json 未推进: ${e.message}`)
        }
        // download.json 主线条目
        if (draft.build.counterpart) {
            try {
                const r = surgery.advanceMainline(
                    p('index', 'download.json'),
                    category,
                    String(draft.build.counterpart),
                    build
                )
                if (r.changed) {
                    pushTouched(touched, path.join('index', 'download.json'))
                    out.ok(`index/download.json 主线: ${draft.build.counterpart} -> ${build}`)
                }
            } catch (e) {
                out.info(`index/download.json 未推进: ${e.message}`)
            }
        }
    } else {
        out.info('新构建为链头，索引不推进')
    }

    // 7. 草稿处理与提交
    if (!opts.keepDraft) fs.unlinkSync(abs)
    const shortCat = category.replace(/^\d+[Hh]\d-/, '')
    const msg = `[new] ${shortCat}: ${build}`
    console.log('')
    out.ok(`apply 完成，共 ${touched.length} 个文件:`)
    touched.forEach((t) => console.log(`  ${t}`))
    console.log(`\n建议提交信息: ${msg}`)

    if (opts.commit) {
        const { spawnSync } = require('child_process')
        const add = spawnSync('git', ['add', ...touched], { cwd: repoRoot(), encoding: 'utf-8' })
        if (add.status !== 0) die(`git add 失败: ${add.stderr}`)
        // 默认 Signed-off-by（-s）与 GPG 签名（-S），--no-signoff / --no-gpg 关闭
        const commitArgs = [
            'commit',
            ...(opts.signoff !== false ? ['-s'] : []),
            ...(opts.gpg !== false ? ['-S'] : []),
            '-m',
            msg,
        ]
        const ci = spawnSync('git', commitArgs, { cwd: repoRoot(), encoding: 'utf-8' })
        if (ci.status !== 0) die(`git commit 失败: ${(ci.stderr || ci.stdout)}`)
        out.ok(`已提交: ${msg}（${commitArgs.filter((a) => a.startsWith('-')).join(' ')}）`)
    } else {
        console.log('请用 git diff 复核后自行提交（或加 --commit 自动提交）')
    }
}

function pushTouched(touched, rel) {
    if (!touched.includes(rel)) touched.push(rel)
}

module.exports = { cmdNew, cmdCheckDraft, cmdApply, validateDraft, insertionPoint, previewNew }
