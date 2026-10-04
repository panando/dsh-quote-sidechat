# Changelog

## 0.3.2

已发送消息中的引用不再显示为裸 blockquote。

宿主发送时把 chip 展开成 `codec.serialize` 返回的文本，并**原样存成用户消息**——所以这段文本既是消息气泡里显示的内容，也是模型收到的内容。此前它展开为裸 `> ` 引用块（与纯文本模式完全相同），气泡里看到的是多行 `>` 文本，模型也无法可靠切分引用与用户输入。

现展开为结构化围栏块：

```
引用自第 9 轮回复：

```
原文（逐字保留）
```
```

- 围栏长度自适应：原文含 ` ``` ` 时自动加长，不会提前闭合。
- `referenceMode: 'quote'` 与 chip 写入被拒时的降级路径仍走旧的纯文本引用块，行为不变。
- 消息气泡内仍不是 chip：宿主的消息渲染只支持纯文本（chip 是 composer 内Lexical 的 DecoratorNode，无法带进已发送的消息快照），这是宿主边界，非本插件可解。

## 0.3.1

修复「添加到对话」偶发退化为纯文本的回归。

- **修复引用 source 注册的加载顺序竞态**：此前只在 `apply()` 里注册一次引用 source；若那一刻宿主的 `inputTriggers` 服务尚未就绪，就**永久放弃注册**，此后所有引用静默降级为纯文本（真机表现为 chip 时好时坏）。现改为幂等的补注册——写入路径每次先尝试补注册，服务后来到达也能生效，不再受插件加载顺序影响。
- `probe()` 不再改写 `lastChipDiag`：它解析 shell 时会把「上次 chip 写入停在哪一环」覆盖成自己的结论，导致真机诊断被误导（本次回归排查中确实被带偏过一次）。现在 probe 先存后还原，且这条只读性由测试守住。
- 测试：版本断言改为从 `package.json#version` 读取（bump 版本不再让测试变红）；dispose 相关用例改为直接调用 `dispose()` 而非依赖 effect 顺序；新增竞态与 probe 只读两条断言。共 52 条。

## 0.3.0

**引用从纯文本块升级为宿主原子 chip**，并补齐点击回跳与侧边结构化边界。

- 通过 `ctx.inputTriggers.registerSource` 注册 `quote-ref` 引用 source（候选恒空，不污染 `@` 菜单）。
- 「添加到对话」以 `conversation.input.for(actx).insertReference(ref, span)` 落成宿主 `ReferenceChipNode`：原子、可整体删除、提交时由宿主 `codec.serialize` 展开成结构化引用块。
- `ref` 自包含（`q2|base64url({模型文本, 会话, 轮次})`）：刷新/重连后仍可序列化与回跳，损坏 ref 明确 reject（宿主会因序列化失败拒绝该轮，故不能静默送空串）。旧的 `q1` 保持可解码。
- **点击 chip 回跳原文**：实现宿主 source 的 `openReference` —— 单击 chip 滚动定位到原文轮次并短暂高亮。原文已被清理或不在当前会话时接管点击并明确提示，不静默无反应，也不跨会话乱跳。
- 新增配置 `referenceMode`：`chip`（默认，原子引用）/ `quote`（纯文本块，回归对照）。宿主缺少引用管线或 chip 写入被拒时自动降级纯文本，不静默丢内容。
- 侧边提问改用**带结构化边界的引用文本**：独立成行的「引用自第 N 轮回复：」标注 + 自适应长度围栏承载原文（原文含 ` ``` ` 时自动升级围栏，避免提前闭合）。侧栏 composer 是 dsh-better-sidebar 自己的 `<textarea>`（useState 驱动），既渲染不了宿主 chip，也不经 `serializeReference`，故用围栏边界让模型同样能切分引用与用户输入，且 Markdown 不错乱。
- 诊断：`window.__dshQuoteSideChat.probe()` 一次性报告引用管线各环节可达性（服务、shell、桥实例、侧栏 composer 形态）。
- 测试：50 条离线断言，覆盖 source 契约、codec 自包含还原、chip 写入与 span 坐标系、拒绝降级、quote 强制纯文本、点击回跳与跨会话守卫、侧边围栏完整性。
- 修正：跨会话判定改用宿主传入的会话投影（`openReference` 的第一个参数），不再从 `document.body` 往上找 `data-conversation-session`（那个属性在会话容器上，从 body 走永远找不到，等于死代码）。

## 0.2.0 — 2026-10-02

首个公开版本（GitHub: [QIN-SMART/dsh-quote-to-chat](https://github.com/QIN-SMART/dsh-quote-to-chat)）。

- 选中回复正文弹出浮动工具条：**添加到对话**（引用块写进草稿）、**侧边提问**（开/复用侧边线程并预填引用）、**复制**。
- 引用格式化：普通段落 → `> 每行` blockquote；代码块 → ` ```lang ` 围栏；多段选中按块级换行还原；可选来源行「（引用自第 N 轮回复）」。
- 工具条材质用原生菜单令牌，但铺在不透明应用层色上（原生 `--dsw-specific-menu` 只有 58% 不透明，浮在密集正文上会互相穿透）。
- 多会话并存时按「最近的共同容器」判定归属，无法唯一确定时明确提示而不写错输入框。
- 「侧边提问」是**可选依赖**（`dsh-better-sidebar`）：没装则整条隐藏；等不到它的输入框时退回剪贴板并明确提示。
- 七类不弹条件（输入框内选中、选区失效、只选中空白、低于 `minChars`、正在提交、被禁用、非对话正文区域）。
- 离线断言 + 真机断言两套；真实 GUI 用 CDP 驱动，验证材质 alpha、命中测试栈、草稿逐字节一致与侧边线程预填。
- 零运行时依赖；CI 覆盖 ubuntu / windows / macos × Node 22 / 24。

> 0.1.0 是未公开的本地开发版本。
