# Windows Up-to-Date 数据仓库

这里是 [Windows Up-to-Date](https://wutd.crrashh.com) 的数据仓库，存储网站展示的全部构建数据，网站前后端源码位于 [win-up-to-date](https://github.com/crrashh1542/win-up-to-date)。

## 目录结构

| 路径 | 内容 |
|---|---|
| `wu.js` + `_lib/` + `WU.md` | 仓库维护工具 `wu` 及其文档 |
| `category/` | 各类目版本线的元数据与构建列表，`list` 按构建号降序 |
| `detail/` | 按类目分目录的构建详情 |
| `index/` | 站点索引文件，由 `wu` 工具维护，非必要勿手改 |
| `viveid/` | ViVeID 库 |
| `download/` | ESD / ISO 下载源列表 |
| `version.json` | 部署时自动生成的数据版本标识 |
| `deploy.txt` | 部署 token |

## 数据约定

- `category/*.json` 的 `list` 按构建号降序排列
- `detail` 的 nav 链按构建号升序双向接线，可跨类目
- 完整推导规则见 [WU.md](./WU.md)。

## 维护工具 wu

日常维护推荐使用本地表单界面，可一次性完成录入、校验、提交、部署。

```bash
node wu.js ui
```

CLI 等价流程与全部命令（`new` / `apply` / `bump` / `index` / `check` / `pack` / `deploy`）见 [WU.md](./WU.md)。

## 部署

```bash
node wu.js deploy        # 打包 data-r<提交数>-<hash>-<日期>.zip 并上传，成功后清理本地 zip
```

服务端（`win-up-to-date/server`）校验令牌后解压到其数据目录并整体替换。数据目录默认为 `server/data`，可用 `WUTD_DATA_DIR` 指向任意位置的数据仓库 checkout。

## commit 约定

| 前缀 | 场景 |
|---|---|
| `[new] <代号>: <构建号>` | 新增构建（可使用工具自动生成） |
| `[latest] <日期> <星期>` | 旧版本线服务通道更新 |
| `[detail]` / `[category]` / `[download]` | 构建修正 / 类目结构 / 下载源调整 |
