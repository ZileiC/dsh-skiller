# dsh-skiller

> Skill 管理器 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：在左侧栏管理全部 skill —— 可视化、新建、手动编写、从本地文件/文件夹导入、编辑、删除。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

在 DeepSeek Harness 的 Web 界面左侧栏加一个「技能管理器」入口。打开后按**当前会话的 agent preset 视图**
列出所有 skill（项目 / 用户 / custom / bundled / runtime），并可直接新建、编写、导入、编辑、删除本地可写 skill。

## 功能

- 左侧栏入口 + 主面板，按当前会话的 agent preset 视图列出全部 skill。
- 搜索、来源筛选、详情与正文预览。
- 新建 / 手动编写 skill（写入 `<root>/<name>/SKILL.md`）。
- 从本地 `.md` 文件或技能文件夹导入。
- 编辑 / 删除本地可写 skill（删除需二次确认）。
- 中英文界面、明暗主题自动跟随；写盘失败、同名冲突、只读来源、目录尚未刷新都会如实显示。

## 可写根

| 根 | 路径 | 说明 |
|---|---|---|
| 项目 | `<projectRoot>/.agents/skills` | `projectRoot` = 最近的含 `.git` 祖先，否则当前 cwd |
| 用户 | `$DSH_HOME/skills` | 通常 `~/.dsh/skills` |

`project-dsh`（`.dsh/skills`）、`custom`、`user-agents`、`bundled`、`runtime` 来源的 skill 只读，
界面会给出具体原因。

## 安装

本插件零第三方依赖，直接以本地目录方式安装即可：

```powershell
git clone https://github.com/jharayden/dsh-skiller.git
```

然后在 DeepSeek Harness 里让 agent 执行：

```text
plugin_manager install_bundle target=<clone 下来的绝对路径>\dsh-skiller
```

安装完成（返回 `application: applied`）后刷新页面，左侧栏出现「技能管理器」图标。

> 需要在 Web/Desktop profile 中运行；宿主代码改动后需完全退出并重开 App 才生效。

## 卸载

```text
plugin_manager remove_bundle target=dsh-skiller
```

已创建的 skill 属于用户数据，卸载不会删除它们。

## 工作原理（简述）

- **读取**：Web profile 把 `skill-filesystem` 挂在 agent preset 层，因此宿主用
  `agentPresets.acquireScope(presetId)` + `ctx.skills.snapshot({ cwd, scope })` 读取会话视角下的目录，
  并用 `compositionInventory()` 判断 preset 是否挂载了 provider。
- **写入**：只允许写上面两个可写根；按 registry 返回的 realpath `path` 定位，做 realpath 包含检查、
  `lstat` 拒绝符号链接、`wx` / 非递归 `mkdir` 防覆盖、`mtime` 冲突检测。
- **frontmatter**：行级重建，保留未知键与注释，不引入 YAML 依赖；写入后用 provider 的目录发现结果
  判定合法性，失败恢复原文。
- **刷新**：监听 `skills/change` + 100 ms 轮询（≤2.5 s），超时如实显示「已写入，等待目录刷新」。

## HTTP 契约（宿主半边）

6 条同源 exact 路由。`Host` 必须是 loopback；`Origin`（若浏览器发送）必须同源；写请求要求
`application/json`；请求体 ≤ 1 MiB，技能正文 ≤ 256 KiB。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/skill-manager/state` | GET | 视图（preset/cwd/projectRoot）、可写根、全部 skill 摘要、limits、warnings |
| `/api/skill-manager/detail` | GET | 单个 skill 的正文、frontmatter 快照、`mtimeMs`/`deletePlan` |
| `/api/skill-manager/create` | POST | 新建 `<root>/<name>/SKILL.md`（同名 409） |
| `/api/skill-manager/update` | POST | 按 registry 的 `path` 原地重写；`baseMtimeMs` 冲突 409 |
| `/api/skill-manager/delete` | POST | 二次确认（`confirmName`，必须与 skill 名一致） |
| `/api/skill-manager/import` | POST | `mode:'file'` 写入上传正文；`mode:'directory'` 复制宿主文件夹 |

失败体统一 `{ ok:false, error:{ code, message } }`；错误码见 [lib/skills.js](lib/skills.js) 中的 `SkillError`。

## 安全边界

- 只写两个白名单根，路径经 realpath 归一后必须仍在根内。
- 同名绝不覆盖；导入/编辑写后若 provider 不接受则回滚。
- 导入上限：200 文件 / 单文件 2 MiB / 总计 10 MiB / 深度 10，符号链接与特殊文件跳过。
- 路由无内置鉴权（只接受 loopback Host 与同源 Origin），本机进程仍可调用——与 Harness 其他本地插件同级。

## 开发与验证

```powershell
node --check lib/index.js
node --check lib/skills.js
node --check lib/client.js
node test/host-test.mjs     # fake ctx + 临时 DSH_HOME/项目根，124 条断言
node test/client-test.mjs   # fake loader/React/ctx，99 条断言
```

测试全部使用 `mkdtemp` 临时目录并在退出时清理，不会触碰真实 `.agents/skills`。
宿主只 import Node 内置模块，客户端只 `require('react')`。

## 已知限制

- 技能目录由宿主 watcher 刷新，写入后可能短暂显示「等待目录刷新」；watcher 关闭时会一直停留在该状态。
- 不提供重命名、回收站、在线市场或自动生成 skill；删除不可恢复。
- 用户可写根固定为 `$DSH_HOME/skills`；若 profile 配置了非默认 `dshHome`，其用户级技能按只读处理。
- catalog 返回 realpath：指向可写根之外的 symlink/junction 一律只读；指向根内的 symlink 删除时会删除真实目标并可能留下悬空链接。
- 已在 DeepSeek Harness 0.2.2-rc.1（Windows desktop profile）验证；其他版本未测试。

## License

[Apache-2.0](LICENSE)
