# dsh-skiller

> 给你的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 配一个技能管理器：左侧栏一个入口，看得到、建得了、改得动全部 skill。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

装好之后，Web 界面左侧栏会多一个「技能管理器」图标。点开就是当前会话能看到的所有 skill（项目、用户、custom、内置），可以新建、手写、从本地导入，也能改和删本地可写的那些。以前这些都得自己去磁盘上建目录、写 `SKILL.md`，然后干等目录监听生效。这个插件省掉那步。

## 它能干什么

- 按当前会话的 agent preset 列出 skill，搜索、按来源筛选、展开看正文。
- 新建或手写 skill，直接写到 `<root>/<name>/SKILL.md`。
- 导入：单个 `.md` 文件，或者一个现成的技能文件夹。
- 编辑和删除本地可写 skill。删除要点两次确认，因为删了没法撤销。
- 中英文界面，跟随明暗主题。写盘失败、同名冲突、来源只读、目录还没刷新，这些情况都照实告诉你，不会假装成功。

## 能写哪儿

只有这两处：

| 根 | 路径 | 说明 |
|---|---|---|
| 项目 | `<projectRoot>/.agents/skills` | `projectRoot` 是最近的含 `.git` 祖先目录，没有就用当前 cwd |
| 用户 | `$DSH_HOME/skills` | 一般是 `~/.dsh/skills` |

来自 `project-dsh`（`.dsh/skills`）、`custom`、`user-agents`、`bundled`、`runtime` 的 skill 一律只读，界面上会写明原因。

## 安装

插件没有任何第三方依赖，直接装本地目录就行：

```powershell
git clone https://github.com/ZileiC/dsh-skiller.git
```

然后在 DeepSeek Harness 里让 agent 跑：

```text
plugin_manager install_bundle target=<clone 下来的绝对路径>\dsh-skiller
```

返回 `application: applied` 之后刷新页面，左侧栏就有图标了。

需要在 Web 或 Desktop profile 下用。以后改了宿主代码，得完全退出 App 再重开，只刷新页面不生效。

## 卸载

```text
plugin_manager remove_bundle target=dsh-skiller
```

卸载不会动你已经建好的 skill，那些是你的数据。

## 几个实现上的坑

写这个插件的时候踩到的东西，别人想改它大概率也会踩：

- **读目录得走 preset scope。** Web profile 把 `skill-filesystem` 从宿主层挪到了各 agent preset 里，所以宿主层直接 `ctx.skills.list()` 只能看到全局那几项，项目目录一个都看不见。正确做法是 `agentPresets.acquireScope(presetId)` 拿到租约，再 `ctx.skills.snapshot({ cwd, scope })`，用完释放。preset 有没有挂 provider 用 `compositionInventory()` 判断。
- **可写根不能从 skill 路径反推。** catalog 给的 `path` 是 realpath。早先我按它反推用户目录，结果在 `~/.dsh/skills` 里放个指向外面的 symlink，就能把删除操作引到根外去。现在根是写死的，路径先 realpath 再判断是否仍在根内，符号链接直接拒绝。
- **frontmatter 不引 YAML 依赖。** 编辑时按行重建，未知键和注释原样留着。写得对不对交给 provider 自己判断：写完轮询目录，没被发现就恢复原文。
- **写盘之后别急着说成功。** registry 没有 TTL，全靠 watcher 失效缓存。实测发现延迟通常在几十到几百毫秒，偶尔更久。所以会监听 `skills/change` 再轮询，超时就老实显示「已写入，等待目录刷新」。

## HTTP 契约

宿主一边是 6 条同源 exact 路由。`Host` 必须是 loopback，浏览器带了 `Origin` 就必须同源；写请求要求 `application/json`；请求体最多 1 MiB，技能正文最多 256 KiB。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/skill-manager/state` | GET | 当前视图（preset、cwd、projectRoot）、可写根、全部 skill 摘要、limits、warnings |
| `/api/skill-manager/detail` | GET | 单个 skill 的正文、frontmatter、`mtimeMs`、删除预览 |
| `/api/skill-manager/create` | POST | 新建 `<root>/<name>/SKILL.md`，同名返回 409 |
| `/api/skill-manager/update` | POST | 按 registry 的 `path` 原地重写，`baseMtimeMs` 对不上返回 409 |
| `/api/skill-manager/delete` | POST | 要传 `confirmName` 且和 skill 名一致 |
| `/api/skill-manager/import` | POST | `mode:'file'` 写上传正文；`mode:'directory'` 复制宿主文件夹 |

失败统一返回 `{ ok:false, error:{ code, message } }`。错误码都在 [lib/skills.js](lib/skills.js) 的 `SkillError` 里。

## 安全边界

- 只写两个白名单根，路径 realpath 之后必须还在根里。
- 同名不覆盖。导入或编辑之后 provider 不认，就回滚。
- 导入限制：最多 200 个文件、单文件 2 MiB、总共 10 MiB、深度 10 层，符号链接和特殊文件直接跳过。
- 路由没有鉴权，只认 loopback Host 和同源 Origin。本机其他进程还是能调，这跟 Harness 里其他本地插件一个水平，别指望它当安全边界。

## 开发

```powershell
node --check lib/index.js
node --check lib/skills.js
node --check lib/client.js
node test/host-test.mjs     # 伪造 ctx + 临时 DSH_HOME/项目根，124 条断言
node test/client-test.mjs   # 伪造 loader/React/ctx，99 条断言
```

测试全在 `mkdtemp` 临时目录里跑，退出时清理，不会碰到你真实的 `.agents/skills`。宿主只用 Node 内置模块，客户端只 `require('react')`。

## 已知限制

- watcher 没刷新时面板会停在「等待目录刷新」。watcher 要是关着，它就永远是那个状态，这个我没法绕。
- 不支持重命名，没有回收站，没有在线市场，也不会帮你自动生成 skill。删除不可恢复。
- 用户可写根写死是 `$DSH_HOME/skills`。如果你的 profile 配置了别的 `dshHome`，那边现有的技能会显示成只读。
- 指向根内的 symlink，删除时会删掉真实目标，原链接可能变成悬空链接。用 symlink 管理技能的话要注意。
- 只在 DeepSeek Harness 0.2.2-rc.1（Windows desktop profile）上验证过，其他版本没测。

## License

[Apache-2.0](LICENSE)
