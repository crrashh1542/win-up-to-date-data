#!/usr/bin/env node
/**
 * wutd —— Windows Up-to-Date 数据仓库维护工具
 *
 * 命令:
 *   ui [--port 8321] [--no-open]                    本地表单界面（一站式录入/校验/提交/部署）
 *   new <category> <build>                          创建新构建草稿卡
 *   check [--draft <file>]                          全库一致性校验 / 草稿校验（无参数检查全部草稿）
 *   apply <draft.json> [--commit] [--keep-draft]    草稿投影落盘（生成 detail + 推导链 + 索引）
 *                                                   提交默认带 Signed-off-by（-s）与 GPG 签名（-S），
 *                                                   可用 --no-signoff / --no-gpg 关闭
 *   bump <category> <build> <date> [--branch b]     旧版本线服务更新（[latest] 场景）
 *   bump --from <oldBuild> <build> <date>           同上，用旧版本号定位（索引条目无 category 时）
 *   index [--dry-run]                               索引派生值与源数据同步
 *   pack                                            打包数据 zip（含 version.json）
 *   deploy [--no-pack] [--no-clean]                 打包并上传部署（读 deploy.txt token）
 *   version                                         显示工具版本
 */

const version = '1.0.0'

const { cmdNew, cmdCheckDraft, cmdApply } = require('./_lib/draft')
const { cmdBump, cmdIndex } = require('./_lib/sync')
const { cmdCheck } = require('./_lib/check')
const { cmdPack, cmdDeploy } = require('./_lib/pack')
const { cmdUi } = require('./_lib/ui')
const { out, die } = require('./_lib/util')

function parseFlags(argv) {
    const flags = {}
    const rest = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a.startsWith('--')) {
            const key = a.slice(2)
            const next = argv[i + 1]
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next
                i++
            } else {
                flags[key] = true
            }
        } else {
            rest.push(a)
        }
    }
    return { flags, rest }
}

function main() {
    const [, , command, ...argv] = process.argv
    const { flags, rest } = parseFlags(argv)

    switch (command) {
        case 'version':
            console.log(version)
            break
        case 'ui':
            cmdUi(flags)
            break
        case 'new':
            cmdNew(rest[0], rest[1])
            break
        case 'check':
            if (flags.draft) cmdCheckDraft(flags.draft === true ? undefined : flags.draft)
            else cmdCheck()
            break
        case 'apply':
            cmdApply(rest[0], {
                commit: !!flags.commit,
                keepDraft: !!flags['keep-draft'],
                signoff: !flags['no-signoff'],
                gpg: !flags['no-gpg'],
            })
            break
        case 'bump':
            cmdBump(rest, flags)
            break
        case 'index':
            cmdIndex(flags)
            break
        case 'pack':
            cmdPack()
            break
        case 'deploy':
            cmdDeploy(flags).catch((e) => die(e.message))
            break
        case 'help':
        case '--help':
        case '-h':
        case undefined:
            console.log(require('fs').readFileSync(require('path').join(__dirname, 'WU.md'), 'utf-8'))
            break
        default:
            out.error(`未知命令: ${command}`)
            console.log('可用命令: ui / new / check / apply / bump / index / pack / deploy / help')
            process.exit(1)
    }
}

main()
