# Changelog

## 0.3.0 — 本 fork

fork 自 QIN-SMART/dsh-quote-to-chat v0.2.0。核心增强：**引用从纯文本块升级为宿主原子 chip**。

- 通过 `ctx.inputTriggers.registerSource` 注册 `quote-ref` 引用 source（候选恒空，不污染 `@` 菜单）。
- 「添加到对话」以 `conversation.input.for(actx).insertReference(ref, span)` 落成宿主 `ReferenceChipNode`：原子、可整体删除、提交时由宿主 `codec.serialize` 展开成结构化引用块。
- `ref` 自包含（`q1|base64url(模型文本)`）：刷新/重连后仍可序列化，损坏 ref 明确 reject（宿主会因序列化失败拒绝该轮，故不能静默送空串）。
- 新增配置 `referenceMode`：`chip`（默认，原子引用）/ `quote`（旧的纯文本块，回归对照）。宿主缺少引用管线或 chip 写入被拒时自动降级纯文本，不静默丢内容。
- 测试：新增 5 条离线断言（source 契约、codec 自包含还原、chip 写入、拒绝降级、quote 强制纯文本）。
- 侧边提问改用**带结构化边界的引用文本**（`【引用 · 第 N 轮回复】` … `【/引用】`）。侧栏 composer 是 dsh-better-sidebar 自己的 `<textarea>`（useState 驱动），既渲染不了宿主 chip，也不经 `serializeReference`，故用显式边界让模型同样能切分引用与用户输入。
- 诊断：`window.__dshQuoteSideChat.probe()` 一次性报告引用管线各环节可达性（服务、shell、桥实例、侧栏 composer 形态）。
- **点击 chip 回跳原文**（缝 D）：ref 升级为 `q2`（携带 `sessionId` + `turn` 的定位载荷），实现宿主 source 的 `openReference` —— 单击 chip 滚动定位到原文轮次并短暂高亮。定位信息来自 ref 自身，刷新后仍可回跳。
  - `q1` 旧 ref 保持可解码（刷新前的草稿、跨版本粘贴不失效）；没有定位信息时明确提示。
  - 原文已被清理或不在当前会话时**接管点击并明确提示**，不静默无反应，也不跨会话乱跳。
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
