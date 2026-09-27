# wu 数据仓库维护工具

芝士用于是取代手工编辑 JSON 的命令行工具。

:::note
此文档的多数内容和相关工具链由 AI 生成。
:::

```
node wu.js <command> ...
```

## 表单更新 UI 界面

```
node wu.js ui          # 启动本地表单并自动打开浏览器（--port 可切换端口，--no-open 不自动打开浏览器）
```

- **新构建**：选类目、填构建号 → 页面即时显示插入位置与 nav 链预览并预填类别元数据 →
  填 branch/时间/公告/updateId/下载（可动态增删行）→「校验草稿」或直接「应用」
  （apply 前自动先校验，ERROR 会拦截；可勾选自动 git commit，Signed-off-by 与 GPG 签名默认启用）；
- **旧版本线 bump**：类目模式 / `--from` 锚点模式，date/branch 显式填写；
- **校验与部署**：全库内容检查并打包部署
- **自动补全**：详情请见 `_lib/autofill.json`。以类目为主对象，含三类预填：
  `releaseNotesChannel`（release.url 的 Learn 链接频道）、
  `releaseChannel`、`branch`

所有动作在服务端通过子进程调用 `wu.js` 自身执行，UI 与 CLI 行为完全一致；UI 提交的草稿临时写入 `_drafts/ui-*.draft.json`，apply 成功后自动删除。

## 推导规则

- `category/*.json` 的 list 按**构建号降序**排列，新构建插入自己的号位（不一定是头部）；
- nav 链按构建号升序：新构建的 `previous` = 号位下一位（更老的构建），`next` 继承它的 `next`；
- 被取代构建的 `next` 改指新构建；其原 `next` 目标（可能跨类目）的 `previous` 回指新构建；
- 索引条目（index/category.json、index/latest-builds.json）只推进**当前值 == previous 构建**的同线索条目——
  server/client 混编类目（如 27H1-rubidium）中两条线互不干扰；
- `index/download.json` 主线条目按 semester + counterpart（"Client 主线版本"/"Server 主线版本"）推进；
- branch 是线索身份：`wutd index` 同步时 branch 不同的条目不会被别的线推进。

## CLI 流程

### 新构建（原 `[new]` 提交）

```
node wu.js new 26H1-bromine 28000.3086      # 1. 生成 _drafts/26H1-bromine-28000.3086.draft.json
# 2. 随时用编辑器填写草稿字段（顺序随意，可分多次、可多张草稿并行）
node wu.js check --draft                     # 3. 查看缺失项/问题（不带参数检查全部草稿）
node wu.js apply _drafts/26H1-bromine-28000.3086.draft.json --commit
                                                     # 4. 校验、投影、生成规范提交
```

apply 自动完成：创建 `detail/<cat>/<build>.json`、category list 按号位插入、
nav 链双向接线、两个 index 的 version/date 推进（branch 不自动改写，由 bump --branch 显式更新）、download.json 主线推进，
并输出 `[new] <codename>: <build>` 规范提交信息（`--commit` 直接提交）。

提交默认带 **Signed-off-by（`-s`）与 GPG 签名（`-S`）**，需要关闭时加 `--no-signoff` / `--no-gpg`。

### 旧版本线服务更新（原 `[latest]` 提交）

```
node wu.js bump 26H1-bromine 28000.3086 2026-09-22          # 类目模式
node wu.js bump --from 22631.7582 22631.7584 2026-09-14    # 锚点模式（旧线无 category 指针）
node wu.js bump 26H1-bromine 28000.3086 2026-09-22 --list  # 需要同步 category list 时
```

只更新两个 index 文件（惯例不更新 category list 与 detail）。多个类目可连续 bump 后一次提交。

### 索引修复

```
node wu.js index --dry-run   # 预览索引落后于源数据的条目
node wu.js index             # 同步 index/category.json 与 index/latest-builds.json
```

### 校验

```
node wu.js check             # 全库一致性（JSON 可解析、nav 链自引用/对称性、索引与 list 一致性等）
```

### 打包与部署

```
node wu.js pack              # 生成 version.json + data-r<rev>-<hash>-<yymmdd>.zip
node wu.js deploy            # pack + 上传（读 deploy.txt），成功后清理本地 zip
node wu.js deploy --no-pack  # 复用已有 zip
```

zip 使用纯 Node 实现打包，具体内容包括 `category/` `detail/` `viveid/` `index/` `download/` `version.json`。`deploy.txt` 不存在或为空时 deploy 自动跳过。

## 草稿卡字段

| 字段 | 必填 | 说明 |
|---|---|---|
| build.branch | ✓ | 分支名，如 `br_release_svc_prod3` |
| build.compileTime | ✓ | 编译时间 `YYYY-MM-DD HH:mm` |
| build.arch | ✓ | 发布的构建的架构 |
| build.counterpart | - | Client / Server / CloudPC |
| release.channel | ✓ | 渠道名 |
| release.time | ✓ | 发布时间 `YYYY-MM-DD HH:mm`|
| release.url | - | 更新公告发布 URL |
| release.announcePlace | - | 更新公告发布地点 |
| updateId | - | UUP 更新 ID，可为空 |
| download | - | 下载链接，可为空 |

nav 链（previous/next）不在草稿中填写：apply 时以仓库当前状态重新推导
（previous = 按构建号排序的下一位，next 继承其现有 next 并回改对方 previous）。
草稿中的 nav 仅为预览，创建后类目若有变动，check 会提示。

## 注意事项
本工具仅用作日常添加新数据或校正功能，部分其它变更还是需要手动操作 JSON 修改的。
