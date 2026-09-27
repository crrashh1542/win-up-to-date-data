/**
 * wutd 格式保持文本手术
 *
 * 原则：只对目标值做最小文本替换，其余字节原样保留（含缩进、键序、行尾风格）。
 * 每个操作完成后重新解析并断言"仅预期的字段发生变化"，失败即回滚报错。
 */
const fs = require('fs')
const { readText, detectEol } = require('./util')

/** 类目名大小写在历史数据中不一致（27H1-Rubidium vs 27H1-rubidium），统一按不敏感比较 */
function sameCat(a, b) {
    return String(a).toLowerCase() === String(b).toLowerCase()
}

function parseSafe(text) {
    return JSON.parse(text)
}

/** 在 text 中查找 "key": 后面对象值的匹配大括号，返回 {start, end}（含两端） */
function findObjectSpan(text, keyLiteral, from = 0) {
    const keyStart = text.indexOf(keyLiteral, from)
    if (keyStart === -1) return null
    const colon = text.indexOf(':', keyStart + keyLiteral.length)
    const open = text.indexOf('{', colon)
    if (open === -1) return null
    let depth = 0
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') {
            depth--
            if (depth === 0) return { start: keyStart, end: i + 1 }
        }
    }
    return null
}

function replaceSpan(text, span, replacement) {
    return text.slice(0, span.start) + replacement + text.slice(span.end)
}

function findLiteral(text, literal, from = 0) {
    return text.indexOf(literal, from)
}

/** 执行手术的统一入口：transform(text) -> newText，验证通过才落盘 */
function operate(filePath, transform, verify) {
    const original = readText(filePath)
    const eol = detectEol(original)
    const modified = transform(original, eol)
    if (modified === original) {
        return { changed: false }
    }
    let doc
    try {
        doc = parseSafe(modified)
    } catch (e) {
        throw new Error(`${filePath} 手术后 JSON 不合法，已放弃写入: ${e.message}`)
    }
    verify(doc, parseSafe(original))
    fs.writeFileSync(filePath, modified)
    return { changed: true }
}

/**
 * category/<cat>.json：在 list 的指定位置插入 ["build", "date"]（list 按构建号降序）
 */
function insertCategoryListEntry(catPath, build, date, position = 0) {
    return operate(
        catPath,
        (text, eol) => {
            const lines = text.split(eol)
            const listIdx = lines.findIndex((l) => l.includes('"list": ['))
            if (listIdx === -1) throw new Error(`${catPath} 中未找到 "list": [ 行`)
            const entryRe = /^\s*\[".*"\],?\s*$/
            const entryLines = []
            for (let i = listIdx + 1; i < lines.length; i++) {
                if (entryRe.test(lines[i])) entryLines.push(i)
                else if (entryLines.length > 0) break
            }
            if (position >= entryLines.length) {
                // 插到末尾：加到最后一个条目行之后
                if (entryLines.length === 0) throw new Error(`${catPath} 的 list 无条目行`)
                const at = entryLines[entryLines.length - 1] + 1
                lines.splice(at, 0, `${'    '.repeat(2)}["${build}", "${date}"]`)
            } else {
                lines.splice(entryLines[position], 0, `${'    '.repeat(2)}["${build}", "${date}"],`)
            }
            return lines.join(eol)
        },
        (doc, before) => {
            if (before.list.length !== doc.list.length - 1) throw new Error('list 长度变化异常')
            const at = doc.list.findIndex((x) => String(x[0]) === build)
            if (at === -1) throw new Error(`插入后 list 中找不到 ${build}`)
            if (at !== position) throw new Error(`预期插入位置 ${position}，实际 ${at}`)
        }
    )
}

/**
 * detail 文件：整体重写 nav 对象（"nav": { ... }），其余部分不动
 */
function replaceNavObject(detailPath, newNav) {
    return operate(
        detailPath,
        (text) => {
            const span = findObjectSpan(text, '"nav"')
            if (!span) throw new Error(`${detailPath} 中未找到 "nav" 对象`)
            const { navObjectText } = require('./style')
            return replaceSpan(text, span, navObjectText(newNav))
        },
        (doc) => {
            const a = JSON.stringify(doc.nav)
            const b = JSON.stringify(newNav)
            if (a !== b) throw new Error(`nav 替换后不一致: ${a} != ${b}`)
        }
    )
}

/** 列出 index/category.json 中所有 (category, latestBuild) 对 */
function catIndexPairs(doc) {
    const pairs = []
    for (const plat of doc) {
        for (const pf of plat.platforms || []) {
            for (const it of pf.items || []) {
                pairs.push({ key: it.category || `@${pf.name}/${it.name}`, latestBuild: it.latestBuild })
            }
        }
    }
    return pairs
}

/**
 * index/category.json：推进类目条目的 latestBuild
 * - expectedOld 给定：只推进 latestBuild == expectedOld 的条目（被新构建取代的同线索条目）
 * - expectedOld 省略：要求该类目恰好一个条目（bump 类目模式）
 * 同类目的其他线索条目（如 server 线）不动。
 */
function replaceLatestBuild(indexPath, category, expectedOld, newBuild) {
    return operate(
        indexPath,
        (text) => {
            const before = parseSafe(text)
            const matches = catIndexPairs(before).filter((x) => sameCat(x.key, category))
            let expectedCount
            if (expectedOld === undefined) {
                if (matches.length !== 1) {
                    throw new Error(`${indexPath} 中 category=${category} 有 ${matches.length} 个条目，无法唯一定位，请改用 --from 模式`)
                }
                expectedCount = 1
            } else {
                expectedCount = matches.filter((x) => x.latestBuild === expectedOld).length
                if (expectedCount === 0) {
                    throw new Error(`${indexPath} 中未找到 category=${category} 且 latestBuild=${expectedOld} 的条目`)
                }
            }
            const lit = expectedOld === undefined ? null : `"latestBuild": "${expectedOld}"`
            let result = text
            let replaced = 0
            if (expectedOld === undefined) {
                // 唯一条目：直接定位 category 后的第一处 latestBuild
                const catLit = `"category": ${JSON.stringify(category)}`
                const catPos = findLiteral(result, catLit)
                if (catPos === -1) throw new Error(`${indexPath} 中未找到 category=${category}`)
                const lbLit = '"latestBuild": "'
                const lbPos = findLiteral(result, lbLit, catPos)
                if (lbPos === -1) throw new Error(`${indexPath} 中 category=${category} 条目缺少 latestBuild`)
                const vStart = lbPos + lbLit.length
                const vEnd = result.indexOf('"', vStart)
                result = result.slice(0, vStart) + newBuild + result.slice(vEnd)
                replaced = 1
            } else {
                let pos = 0
                while (true) {
                    const occ = result.indexOf(lit, pos)
                    if (occ === -1) break
                    const span = findEnclosingObjectSpan(result, lit, pos)
                    if (!span) break
                    const obj = parseSafe(result.slice(span.start, span.end))
                    if (sameCat(obj.category, category)) {
                        result = result.slice(0, occ) + `"latestBuild": "${newBuild}"` + result.slice(occ + lit.length)
                        replaced++
                    }
                    pos = span.end
                }
            }
            if (replaced !== expectedCount) {
                throw new Error(`预期推进 ${expectedCount} 处，实际 ${replaced} 处`)
            }
            return result
        },
        (doc, before) => {
            const a = catIndexPairs(doc)
            const b = catIndexPairs(before)
            if (a.length !== b.length) throw new Error('条目数量发生变化')
            let changed = 0
            for (let i = 0; i < a.length; i++) {
                if (a[i].latestBuild !== b[i].latestBuild) {
                    if (a[i].latestBuild !== newBuild) throw new Error(`意外变化: ${a[i].key} -> ${a[i].latestBuild}`)
                    changed++
                }
            }
            if (changed === 0) throw new Error('未产生任何 latestBuild 变化')
        }
    )
}

/** --from 锚点模式：index/category.json 中 latestBuild==old 的全部条目替换为 new
 * （同一版本号可被多条线索共用，如 LTSC 2019 与 Server 2019 共用 17763） */
function replaceLatestBuildByAnchor(indexPath, oldBuild, newBuild) {
    return operate(
        indexPath,
        (text) => {
            const lit = `"latestBuild": "${oldBuild}"`
            if (!text.includes(lit)) return text
            return text.split(lit).join(`"latestBuild": "${newBuild}"`)
        },
        (doc, before) => {
            const a = catIndexPairs(doc)
            const b = catIndexPairs(before)
            if (a.length !== b.length) throw new Error('条目数量发生变化')
            let changed = 0
            for (let i = 0; i < a.length; i++) {
                if (a[i].latestBuild !== b[i].latestBuild) {
                    if (a[i].latestBuild !== newBuild) throw new Error(`意外变化: ${a[i].key} -> ${a[i].latestBuild}`)
                    changed++
                }
            }
            if (changed === 0) throw new Error('未产生任何 latestBuild 变化')
        }
    )
}

function countOccurrences(text, lit) {
    let n = 0
    let pos = 0
    while ((pos = findLiteral(text, lit, pos)) !== -1) {
        n++
        pos += lit.length
    }
    return n
}

/** 展平 latest-builds.json 的所有 release 条目 */
function flatReleases(doc) {
    const list = []
    for (const g of doc) {
        for (const r of g.releases || []) list.push(r)
    }
    return list
}

/**
 * 定位包含 innerLiteral 的整个 JSON 对象 span：
 * 从 innerLiteral 向前找最近的 '{'（release 条目内部无嵌套对象），向后做括号配对
 */
function findEnclosingObjectSpan(text, innerLiteral, from = 0) {
    const litPos = text.indexOf(innerLiteral, from)
    if (litPos === -1) return null
    let open = -1
    for (let i = litPos; i >= 0; i--) {
        if (text[i] === '{') { open = i; break }
    }
    if (open === -1) return null
    let depth = 0
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') {
            depth--
            if (depth === 0) return { start: open, end: i + 1 }
        }
    }
    return null
}

/**
 * index/latest-builds.json：推进类目条目的 version/date/branch
 * - expectedOld 给定：只推进 version == expectedOld 的同线索条目（expectedOld = 新构建的 nav.previous）
 * - expectedOld 省略：要求该类目恰好一个条目（bump 类目模式）
 */
function replaceReleaseEntry(indexPath, { category, expectedOld, version, date, branch }) {
    return operate(
        indexPath,
        (text) => {
            const before = parseSafe(text)
            let targets
            if (expectedOld === undefined) {
                targets = flatReleases(before).filter((r) => sameCat(r.category, category))
                if (targets.length !== 1) {
                    throw new Error(
                        `${indexPath} 中 category=${category} 有 ${targets.length} 个条目，无法唯一定位，请改用 --from 模式`
                    )
                }
            } else {
                targets = flatReleases(before).filter(
                    (r) => sameCat(r.category, category) && r.version === expectedOld
                )
                if (targets.length === 0) {
                    throw new Error(`${indexPath} 中未找到 category=${category} 且 version=${expectedOld} 的条目`)
                }
            }
            let result = text
            let replaced = 0
            const rep = (lit, oldVal, newVal, spanStart, spanEnd) => {
                if (oldVal === undefined || newVal === undefined) return
                const search = `${lit}"${oldVal}"`
                const p = result.indexOf(search, spanStart)
                if (p === -1 || p >= spanEnd) return
                result = result.slice(0, p) + `${lit}"${newVal}"` + result.slice(p + search.length)
            }
            if (expectedOld === undefined) {
                const catLit = `"category": ${JSON.stringify(category)}`
                const span = findEnclosingObjectSpan(result, catLit)
                if (!span) throw new Error(`${indexPath} 中无法定位 category=${category} 条目`)
                const t = targets[0]
                rep('"version": ', t.version, version, span.start, span.end)
                rep('"date": ', t.date, date, span.start, span.end)
                rep('"branch": ', t.branch, branch, span.start, span.end)
                replaced = 1
            } else {
                const verLit = `"version": "${expectedOld}"`
                let pos = 0
                while (true) {
                    const occ = result.indexOf(verLit, pos)
                    if (occ === -1) break
                    const span = findEnclosingObjectSpan(result, verLit, pos)
                    if (!span) break
                    const obj = parseSafe(result.slice(span.start, span.end))
                    if (sameCat(obj.category, category)) {
                        rep('"version": ', obj.version, version, span.start, span.end)
                        rep('"date": ', obj.date, date, span.start, span.end)
                        rep('"branch": ', obj.branch, branch, span.start, span.end)
                        replaced++
                    }
                    pos = span.end
                }
            }
            if (replaced !== targets.length) {
                throw new Error(`预期推进 ${targets.length} 处，实际 ${replaced} 处`)
            }
            return result
        },
        (doc, before) => {
            const targetsLen = flatReleases(before).filter((r) =>
                expectedOld === undefined
                    ? sameCat(r.category, category)
                    : sameCat(r.category, category) && r.version === expectedOld
            ).length
            const a = flatReleases(doc)
            const b = flatReleases(before)
            if (a.length !== b.length) throw new Error('release 条目数量发生变化')
            let changed = 0
            for (let i = 0; i < a.length; i++) {
                if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) changed++
            }
            if (changed !== targetsLen) throw new Error(`预期 ${targetsLen} 处 release 条目变化，实际 ${changed}`)
            const t = flatReleases(doc).filter((r) => sameCat(r.category, category) && r.version === version)
            if (t.length === 0 || t[0].date !== date) throw new Error('version/date 替换未生效')
        }
    )
}

/**
 * index/latest-builds.json：--from 锚点模式（旧版本号定位，全部匹配条目一起推进；
 * 同版本号可被多条线索共用，如 LTSC 2019 与 Server 2019 共用 17763）
 */
function replaceReleaseByAnchor(indexPath, oldVersion, { version, date, branch }) {
    return operate(
        indexPath,
        (text) => {
            const verLit = `"version": "${oldVersion}"`
            const n = countOccurrences(text, verLit)
            if (n === 0) return text
            const before = parseSafe(text)
            const targets = flatReleases(before).filter((r) => r.version === oldVersion)
            let result = text
            let replaced = 0
            let pos = 0
            while (true) {
                const occ = result.indexOf(verLit, pos)
                if (occ === -1) break
                const span = findEnclosingObjectSpan(result, verLit, pos)
                if (!span) break
                const obj = parseSafe(result.slice(span.start, span.end))
                if (obj.version === oldVersion) {
                    const rep = (lit, oldVal, newVal) => {
                        if (oldVal === undefined || newVal === undefined) return
                        const search = `${lit}"${oldVal}"`
                        const p = result.indexOf(search, span.start)
                        if (p === -1 || p >= span.end) return
                        result = result.slice(0, p) + `${lit}"${newVal}"` + result.slice(p + search.length)
                    }
                    rep('"version": ', obj.version, version)
                    rep('"date": ', obj.date, date)
                    rep('"branch": ', obj.branch, branch)
                    replaced++
                }
                pos = span.end
            }
            if (replaced !== targets.length) {
                throw new Error(`预期推进 ${targets.length} 处，实际 ${replaced} 处`)
            }
            return result
        },
        (doc, before) => {
            const expected = flatReleases(before).filter((r) => r.version === oldVersion).length
            const a = flatReleases(doc)
            const b = flatReleases(before)
            if (a.length !== b.length) throw new Error('release 条目数量发生变化')
            let changed = 0
            for (let i = 0; i < a.length; i++) {
                if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) changed++
            }
            if (changed !== expected) throw new Error(`预期 ${expected} 处 release 条目变化，实际 ${changed}`)
        }
    )
}

/**
 * index/download.json：推进 self.mainline 主线条目
 * 条目须同时满足 semester == category 且 name 以 counterpart 开头（"Client 主线版本"/"Server 主线版本"）
 * 无匹配条目时返回 changed: false（多数类目没有主线）
 */
function advanceMainline(downloadPath, category, counterpart, newBuild) {
    return operate(
        downloadPath,
        (text) => {
            const before = parseSafe(text)
            const mainline = (before.self && before.self.mainline) || []
            const targets = mainline.filter(
                (m) => sameCat(m.semester, category) && String(m.name).startsWith(counterpart)
            )
            if (targets.length === 0) return text
            let result = text
            let replaced = 0
            for (const t of targets) {
                const buildLit = `"build": "${t.build}"`
                let pos = 0
                while (true) {
                    const occ = result.indexOf(buildLit, pos)
                    if (occ === -1) break
                    const span = findEnclosingObjectSpan(result, buildLit, pos)
                    if (!span) break
                    const obj = parseSafe(result.slice(span.start, span.end))
                    if (sameCat(obj.semester, category) && String(obj.name).startsWith(counterpart)) {
                        result =
                            result.slice(0, occ) +
                            `"build": "${newBuild}"` +
                            result.slice(occ + buildLit.length)
                        replaced++
                        pos = occ + `"build": "${newBuild}"`.length
                        continue
                    }
                    pos = span.end
                }
            }
            if (replaced !== targets.length) {
                throw new Error(`预期推进 ${targets.length} 处主线条目，实际 ${replaced} 处`)
            }
            return result
        },
        (doc, before) => {
            const a = (doc.self && doc.self.mainline) || []
            const b = (before.self && before.self.mainline) || []
            if (a.length !== b.length) throw new Error('主线条目数量发生变化')
            let changed = 0
            for (let i = 0; i < a.length; i++) {
                if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) changed++
            }
            if (changed === 0) throw new Error('未产生任何主线条目变化')
        }
    )
}

module.exports = {
    insertCategoryListEntry,
    replaceNavObject,
    replaceLatestBuild,
    replaceLatestBuildByAnchor,
    replaceReleaseEntry,
    replaceReleaseByAnchor,
    advanceMainline,
    findObjectSpan,
}
