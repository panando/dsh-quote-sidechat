# dsh-quote-sidechat

选中 DeepSeek Harness 回复里的一段文字，浮出工具条：**把引用作为原子 chip 写进输入框**、**就这段内容开侧边线程提问**、或**复制原文**。

引用不再是展开成一大段纯文本，而是宿主 composer 里的**一个原子节点**——可整体删除、点击跳回原文、提交时展开成结构化引用块，模型能明确区分「这是引用的原文」和「这是用户自己说的话」。

---

## 特性

### 原子引用 chip

选中文本 → 点「添加到对话」→ 输入框里出现一个 chip，而不是多行引用文本：

| | 行为 |
|---|---|
| **原子** | chip 是宿主的原子节点，一次 Backspace 整个删除，不留残缺引用 |
| **可回跳** | 单击 chip → 正文滚动定位到被引用的那一轮并短暂高亮 |
| **结构化提交** | 发送时由宿主展开成带边界的引用块，模型不会把引用和提问混为一谈 |
| **可撤销** | 与普通输入一样走编辑器的撤销栈 |

### 侧边提问

点「侧边提问」把选中片段送进右栏开一个独立线程（需要 `dsh-better-sidebar`）。侧栏输入框是第三方组件的 `<textarea>`，渲染不了 chip，因此改用**带结构化边界的引用文本**：

````
引用自第 9 轮回复：

```
第一段。

第二段。
```
````

边界由围栏保证——即使原文含空行、代码块或 ` ``` `，Markdown 也不会错乱。

### 其他

- **复制**：原文进剪贴板（`⌘C` 兜底，兼容非安全上下文）
- **多会话**：选中哪条对话的文本，就写回那条对话的输入框；无法唯一判定时明确提示而不写错地方
- **克制**：七类情况不弹工具条（输入框内选中、选区失效、只选中空白、低于 `minChars`、正在提交、被禁用、非对话正文区域）
- **原生材质**：工具条使用 DSH 原生菜单 token，明暗主题自适应
- **零副作用**：未选中文本时页面上不存在任何可见 DOM

---

## 安装

把包加进 profile 的 `dsh.profile.bundles` 并安装依赖，或直接让插件管理器装。

插件是一个**浏览器半区**插件：`cordis.patch.yml` 里的条目是 Loader entry，宿主据此把 `exports["./client"]` 发布给浏览器，`lib/client.js` 在页面启动时 materialize。

---

## 配置

配置存在浏览器 `localStorage`（键 `dsh.quote-sidechat.v1`），调试句柄可改：

```js
window.__dshQuoteSideChat.setConfig({ referenceMode: 'quote' })
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `format` | `'auto'` | 引用块文本格式：`auto`（代码块用 fenced / 其余 blockquote）、`quote`、`fenced`、`plain` |
| `referenceMode` | `'chip'` | **`chip`** = 原子引用；**`quote`** = 纯文本引用块（回归对照开关） |
| `attribution` | `false` | 引用后补一行来源说明 |
| `minChars` | `2` | 少于这么多字符不弹工具条 |

宿主缺少引用管线、或 chip 写入被拒（会话正忙 / 草稿版本已变）时，会**自动降级**为纯文本插入并明确提示，不静默丢内容。

---

## 诊断

真机排查时，DevTools 里跑这一行，一次看清整条引用管线：

```js
JSON.stringify(window.__dshQuoteSideChat.probe(), null, 2)
```

它会报告引用 source 是否注册、`inputTriggers` / `conversation` / `sessions` 三个服务是否可达、会话 shell 是否解析、每个桥实例的会话身份，以及最近一次 chip 写入停在了哪一环。

---

## 它是怎么实现的

宿主（`@deepseek-ai/dsh-client-ui-input-trigger` + `dsh-client-ui-conversation`）已经提供整套引用契约，本插件按契约接入，**不改宿主一行代码**：

| 能力 | 宿主接口 |
| --- | --- |
| 注册引用 source | `ctx.inputTriggers.registerSource(src)` |
| 落成原子 chip | `shell.insertReference(ref, span)` |
| 提交时序列化成模型形式 | `src.codec.serialize(ref, signal)` |
| 点击预览 | `src.openReference(session, {ref, appearance})` |
| 整块删除 / 渲染 | 宿主的 `ReferenceChipNode`（Lexical DecoratorNode） |

### 关键设计：ref 自包含

宿主规定：**序列化失败会拒绝该轮请求**。所以 `ref` 不能只当内存 Map 的 key——刷新页面后 Map 丢失会让引用「发不出去」。

本插件把引用的全部信息编进 `ref`：

```
q2|<base64url({ t: 模型文本, s: 会话 id, n: 轮次 })>
```

于是 `codec.serialize` / `codec.clipboardText` 只靠 `ref` 自身就能还原，点击回跳也不依赖内存态。损坏或版本不认识的 `ref` 会**明确 reject**，而不是静默送空串。旧的 `q1`（只带模型文本）保持可解码，刷新前的草稿与跨版本粘贴不受影响。

---

## 开发

```bash
npm test          # 50 条离线断言：真实 bundle + mock DOM，跑真实的 ModuleLoader 装载路径
npm run check     # 语法体检 + 全量自测
```

自测断言的是**世界可见行为**，不是内部结构：模块 id 逐字等于包名、注册进插槽的桥、`insertReference` 收到的 `source`/`span`/`ref`、codec 能否只靠 ref 还原、拒绝后的降级、以及侧边载荷的围栏完整性。

---

## 致谢

本项目基于 [QIN-SMART/dsh-quote-to-chat](https://github.com/QIN-SMART/dsh-quote-to-chat) v0.2.0（MIT）开发，在此致谢；引用写入路径已重构为宿主原子 chip。

## 许可证

MIT。见 [LICENSE](./LICENSE)。