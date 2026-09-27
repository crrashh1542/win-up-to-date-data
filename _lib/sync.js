/**
 * wutd 同步命令：bump（旧版本线服务更新）与 index（索引派生值修复）
 */
const fs = require('fs')
const path = require('path')
const { repoRoot, readJson, cmpBuild, out, die } = require('./util')
const surgery = require('./surgery')

function p(...seg) {
    return path.join(repoRoot(), ...seg)
}

function DATE_RE() {
    return /^\d{4}-\d{2}-\d{2}$/
}

/**
 * wutd bump <category | --from <oldBuild>> <build> <date> [--branch <b>]
 *
 * category 模式：类目有 category 文件/index 指针时使用
 * --from 模式：旧版本线（index 条目无 category 字段）用旧版本号唯一定位
 */
function cmdBump(args, flags) {
    const branch = flags.branch
    const touched = []

    if (flags.from) {
        // wutd bump --from <oldBuild> <newBuild> <date> [--branch <b>]
        const oldBuild = flags.from
        const [newBuild, newDate] = args
        if (!newBuild || !newDate) die('用法: wu bump --from <旧版本号> <新版本号> <date> [--branch <b>]')
        if (!DATE_RE().test(newDate)) die(`date 格式应为 YYYY-MM-DD，当前: ${newDate}`)
        const catPath = p('index', 'category.json')
        const r1 = surgery.replaceLatestBuildByAnchor(catPath, oldBuild, newBuild)
        if (r1.changed) {
            touched.push('index/category.json')
            out.ok(`index/category.json: latestBuild ${oldBuild} -> ${newBuild}`)
        } else {
            out.info(`index/category.json 中无 ${oldBuild}，跳过`)
        }
        const r2 = surgery.replaceReleaseByAnchor(p('index', 'latest-builds.json'), oldBuild, {
            version: newBuild,
            date: newDate,
            branch,
        })
        if (r2.changed) {
            touched.push('index/latest-builds.json')
            out.ok(`index/latest-builds.json: ${oldBuild} -> ${newBuild} (${newDate})`)
        } else {
            out.info(`index/latest-builds.json 中无 ${oldBuild}，跳过`)
        }
        if (touched.length === 0) die(`两个索引中均未找到 ${oldBuild}，未做任何修改`)
    } else {
        // wutd bump <category> <build> <date> [--branch <b>]
        const [category, build, date] = args
        if (!category || !build || !date) die('用法: wu bump <category> <build> <date> [--branch <b>]')
        if (!DATE_RE().test(date)) die(`date 格式应为 YYYY-MM-DD，当前: ${date}`)
        const catFile = p('category', `${category}.json`)
        let hit = false
        try {
            const r = surgery.replaceLatestBuild(p('index', 'category.json'), category, undefined, build)
            if (r.changed) {
                touched.push('index/category.json')
                out.ok(`index/category.json: ${category} latestBuild -> ${build}`)
                hit = true
            }
        } catch (e) {
            out.info(`index/category.json 跳过: ${e.message}`)
        }
        try {
            const r = surgery.replaceReleaseEntry(p('index', 'latest-builds.json'), {
                category,
                version: build,
                date,
                branch,
            })
            if (r.changed) {
                touched.push('index/latest-builds.json')
                out.ok(`index/latest-builds.json: ${category} -> ${build} (${date})`)
                hit = true
            }
        } catch (e) {
            out.info(`index/latest-builds.json 跳过: ${e.message}`)
        }
        if (!hit) die(`索引中均未找到 ${category}，请确认类目名；旧版本线请用 --from <旧版本号> 模式`)
        // category 文件存在且其 list 会被本命令同步（可选 --list）
        if (fs.existsSync(catFile)) {
            if (flags.list) {
                const r = surgery.insertCategoryListEntry(catFile, build, date)
                if (r.changed) {
                    touched.push(`category/${category}.json`)
                    out.ok(`category/${category}.json list 头插 [${build}, ${date}]`)
                }
            } else {
                out.info(`category/${category}.json 未改动（[latest] 惯例不更新 list；如需同步加 --list）`)
            }
        }
    }

    console.log('')
    out.ok(`bump 完成，共 ${touched.length} 个文件`)
    touched.forEach((t) => console.log(`  ${t}`))
    console.log('\n多个类目的 bump 可连续执行后一次性提交（惯例信息: [latest] <日期> <星期>）')
}

/**
 * wutd index [--dry-run]：把两个索引文件中的派生值与 category/ 源数据同步
 * 只同步"索引落后"的条目（源数据更新）；索引超前（服务线未跟踪 list）仅提示
 */
function cmdIndex(flags = {}) {
    const catIndexPath = p('index', 'category.json')
    const lbPath = p('index', 'latest-builds.json')
    const catIndex = readJson(catIndexPath)
    const lb = readJson(lbPath)

    const headOfCategory = (category) => {
        const catFile = p('category', `${category}.json`)
        if (!fs.existsSync(catFile)) return null
        const doc = readJson(catFile)
        return doc.list && doc.list.length ? String(doc.list[0][0]) : null
    }

    const readBranch = (category, build) => {
        try {
            const d = readJson(p('detail', category, `${build}.json`))
            return d.build && d.build.branch ? String(d.build.branch) : null
        } catch {
            return null
        }
    }

    /**
     * 线索身份判断：head 构建的 branch 与被推进条目的 branch 一致才允许同步。
     * server/client 混编类目（如 27H1-rubidium）中，server 线条目不能被 client head 推进。
     */
    const sameLine = (category, oldBuild, oldBranch, head) => {
        const headBranch = readBranch(category, head)
        if (oldBranch && headBranch) return oldBranch === headBranch
        const oldBranchFromDetail = oldBuild ? readBranch(category, oldBuild) : null
        if (oldBranchFromDetail && headBranch) return oldBranchFromDetail === headBranch
        return true // 无法判定线索时允许同步
    }

    let changes = 0
    const dryRun = !!flags['dry-run']
    const note = (msg) => (dryRun ? out.warn(`[dry-run] ${msg}`) : msg && out.ok(msg))

    for (const plat of catIndex) {
        for (const pf of plat.platforms || []) {
            for (const it of pf.items || []) {
                if (!it.category) continue
                const head = headOfCategory(it.category)
                if (!head) continue
                const c = cmpBuild(head, it.latestBuild)
                if (c > 0) {
                    if (!sameLine(it.category, it.latestBuild, null, head)) {
                        out.info(`index/category.json ${it.category}: 条目(${it.latestBuild})与 head(${head})不同线索，跳过`)
                        continue
                    }
                    changes++
                    if (dryRun) {
                        note(`${it.category}: latestBuild ${it.latestBuild} -> ${head}`)
                    } else {
                        try {
                            surgery.replaceLatestBuild(catIndexPath, it.category, undefined, head)
                            out.ok(`index/category.json: ${it.category} latestBuild -> ${head}`)
                        } catch (e) {
                            out.error(`${it.category}: ${e.message}`)
                        }
                    }
                } else if (c < 0) {
                    out.info(`${it.category}: 索引(${it.latestBuild}) 超前 list head(${head})，属服务线未跟踪 list，跳过`)
                }
            }
        }
    }

    for (const g of lb) {
        for (const r of g.releases || []) {
            if (!r.category) continue
            const head = headOfCategory(r.category)
            if (!head) continue
            const c = cmpBuild(head, r.version)
            if (c > 0) {
                if (!sameLine(r.category, r.version, r.branch, head)) {
                    out.info(`latest-builds ${r.category}(${r.channel}): 条目(${r.version})与 head(${head})不同线索，跳过`)
                    continue
                }
                changes++
                if (dryRun) {
                    note(`latest-builds ${r.category}: ${r.version} -> ${head}`)
                } else {
                    try {
                        // 不自动推断 branch：仅同步 version/date，branch 由 bump --branch 显式更新
                        surgery.replaceReleaseEntry(lbPath, {
                            category: r.category,
                            expectedOld: r.version,
                            version: head,
                            date: headOfDate(r.category, head),
                        })
                        out.ok(`index/latest-builds.json: ${r.category} -> ${head}`)
                    } catch (e) {
                        out.error(`${r.category}: ${e.message}`)
                    }
                }
            }
        }
    }

    if (changes === 0) out.ok('索引与源数据一致，无需修改')
    else console.log(`\n共 ${changes} 处可同步${dryRun ? '（dry-run 未写入）' : ''}`)
}

function headOfDate(category, build) {
    const catFile = path.join(repoRoot(), 'category', `${category}.json`)
    const doc = readJson(catFile)
    const row = (doc.list || []).find((x) => String(x[0]) === build)
    return row ? String(row[1]) : undefined
}

module.exports = { cmdBump, cmdIndex }
