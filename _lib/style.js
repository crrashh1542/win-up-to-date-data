/**
 * wutd 风格保持序列化
 *
 * 仓库 JSON 约定（依据现有文件归纳）：
 * - 4 空格缩进，CRLF 行尾，文件末尾无换行
 * - 小型标量数组内联：["AMD64", "ARM64"]、[27802, 28000]
 * - download/link 非空时采用 "key": [{ 紧凑起始风格
 * - updateId 采用标准多行数组风格
 */
const IND = '    '

function q(s) {
    return JSON.stringify(String(s))
}

function inlineArray(arr) {
    return `[${arr.map(q).join(', ')}]`
}

/** 对象字段行数组收尾：去掉最后一行的尾逗号（若有） */
function stripTrailing(lines) {
    if (lines.length && lines[lines.length - 1].endsWith(',')) {
        lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1)
    }
    return lines
}

function navLines(nav) {
    const L = []
    L.push('{')
    if (nav.previous) {
        L.push(`${IND}${IND}"previous": {`)
        L.push(`${IND}${IND}${IND}"category": ${q(nav.previous.category)},`)
        L.push(`${IND}${IND}${IND}"build": ${q(nav.previous.build)}`)
        L.push(`${IND}${IND}}${nav.next ? ',' : ''}`)
    }
    if (nav.next) {
        L.push(`${IND}${IND}"next": {`)
        L.push(`${IND}${IND}${IND}"category": ${q(nav.next.category)},`)
        L.push(`${IND}${IND}${IND}"build": ${q(nav.next.build)}`)
        L.push(`${IND}${IND}}`)
    }
    L.push(`${IND}}`)
    return L
}

function updateIdLines(list) {
    if (!list || list.length === 0) return [`${IND}"updateId": [],`]
    // 主流风格（88% 文件）："updateId": [{ 紧凑起始
    const L = []
    list.forEach((u, i) => {
        if (i === 0) {
            L.push(`${IND}"updateId": [{`)
        } else {
            L.push(`${IND}{`)
        }
        L.push(`${IND}${IND}"arch": ${q(u.arch)},`)
        L.push(`${IND}${IND}"id": ${q(u.id)}`)
        L.push(`${IND}}${i < list.length - 1 ? ',' : '],'}`)
    })
    return L
}

function linkLines(links, indent) {
    // links 非空；输出 "link": [{...},{...}], 整体（含尾逗号，由调用方处理）
    const L = []
    links.forEach((lk, j) => {
        if (j === 0) {
            L.push(`${indent}"link": [{`)
        } else {
            L.push(`${indent}{`)
        }
        L.push(`${indent}${IND}"url": ${q(lk.url)},`)
        L.push(`${indent}${IND}"source": ${q(lk.source)}`)
        L.push(`${indent}}${j < links.length - 1 ? '' : ']'},`)
    })
    return L
}

function downloadLines(list) {
    if (!list || list.length === 0) return [`${IND}"download": []`]
    const L = []
    list.forEach((item, i) => {
        if (i === 0) {
            L.push(`${IND}"download": [{`)
        } else {
            L.push(`${IND}{`)
        }
        const body = []
        body.push(`${IND}${IND}"name": ${q(item.name)},`)
        if (item.size) body.push(`${IND}${IND}"size": ${q(item.size)},`)
        if (item.link && item.link.length > 0) {
            body.push(...linkLines(item.link, `${IND}${IND}`))
        } else {
            body.push(`${IND}${IND}"link": [],`)
        }
        body.push(`${IND}${IND}"arch": ${q(item.arch)},`)
        if (item.md5) body.push(`${IND}${IND}"md5": ${q(item.md5)},`)
        if (item.sha256) body.push(`${IND}${IND}"sha256": ${q(item.sha256)}`)
        L.push(...stripTrailing(body))
        L.push(`${IND}}${i < list.length - 1 ? ',' : ']'}`)
    })
    return L
}

/**
 * 序列化 detail/<category>/<build>.json 全文
 */
function serializeDetail(d, eol = '\r\n') {
    const L = []
    L.push('{')
    L.push(`${IND}"build": {`)
    L.push(`${IND}${IND}"number": ${q(d.build.number)},`)
    L.push(`${IND}${IND}"branch": ${q(d.build.branch)},`)
    L.push(`${IND}${IND}"compileTime": ${q(d.build.compileTime)},`)
    L.push(`${IND}${IND}"arch": ${inlineArray(d.build.arch)},`)
    L.push(`${IND}${IND}"counterpart": ${q(d.build.counterpart)}`)
    L.push(`${IND}},`)
    const rel = []
    rel.push(`${IND}"release": {`)
    rel.push(`${IND}${IND}"channel": ${q(d.release.channel)},`)
    rel.push(`${IND}${IND}"time": ${q(d.release.time)},`)
    if (d.release.url) rel.push(`${IND}${IND}"url": ${q(d.release.url)},`)
    if (d.release.announcePlace) rel.push(`${IND}${IND}"announcePlace": ${q(d.release.announcePlace)}`)
    L.push(...stripTrailing(rel))
    L.push(`${IND}},`)
    L.push(`${IND}"nav": ${navLines(d.nav).join(eol)}` + ',')
    L.push(`${IND}"belongsTo": {`)
    L.push(`${IND}${IND}"path": ${q(d.belongsTo.path)},`)
    L.push(`${IND}${IND}"name": ${q(d.belongsTo.name)}`)
    L.push(`${IND}},`)
    L.push(...updateIdLines(d.updateId))
    L.push(...downloadLines(d.download))
    L.push('}')
    return L.join(eol)
}

/**
 * 手术用：返回替换整个 nav 对象的文本 "nav": { ... }（不含尾逗号），固定 CRLF
 */
function navObjectText(nav) {
    return `"nav": ${navLines(nav).join('\r\n')}`
}

module.exports = { serializeDetail, navObjectText, IND }
