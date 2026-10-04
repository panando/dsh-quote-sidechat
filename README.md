# @panando/dsh-quote-sidechat

DSH 插件（浏览器半区）：在对话回复里选中一段文字 → 浮动工具条 →

- **添加到对话**：把选中片段作为**宿主原子引用 chip** 落进输入框（可整体删除、提交时结构化序列化、模型能明确区分「引用」与「用户输入」）；
- **侧边提问**：把片段送进右栏开一个 side chat；
- **复制**：原文进剪贴板。

> 上游 fork 自 [QIN-SMART/dsh-quote-to-chat](https://github.com/QIN-SMART/dsh-quote-to-chat) v0.2.0（MIT）。
> 本 fork 的核心增强：引用从「纯文本块」升级为**宿主原生原子 chip**（`ctx.inputTriggers` + 宿主 `serializeReference` 管线）。
> 上游原文见 [`README.upstream.md`](./README.upstream.md)。

---

## 原子引用 chip 怎么实现的

宿主（`@deepseek-ai/dsh-client-ui-input-trigger` + `dsh-client-ui-conversation`）已提供整套引用契约，本插件按契约接入，不改宿主一行代码：

| 能力 | 宿主接口 | 本插件用在哪 |
| --- | --- | --- |
| 注册引用 source | `ctx.inputTriggers.registerSource(src)` | `registerReferenceSource()`（`apply` 时注册 `quote-ref`） |
| 提交时序列化成模型形式 | `src.codec.serialize(ref, signal)` | 宿主提交前按 chip 的 `source` 路由回来展开 |
| 剪贴板/持久化形式 | `src.codec.clipboardText(ref)` | 复制 chip、宿主草稿持久化 |
| 落成原子 chip | `shell.insertReference(ref, span)` | `writeChip()` |
| 整块删除 | 宿主 `ReferenceChipNode`（Lexical DecoratorNode） | 天然原子，一次删除整个引用 |
| 点击预览 | `src.openReference(session, {ref, appearance})` | 第二轮实现（当前只注册 source，未接 openReference） |

### 关键设计：ref 自包含

宿主规定：**序列化失败会拒绝该轮请求**。所以 `ref` 不能只当内存 Map 的 key —— 刷新页面后 Map 丢失会让引用「发不出去」。本插件把**最终模型文本直接编进 ref**：

```
ref = "q1|" + base64url(模型文本)
```

于是 `codec.serialize(ref)` / `codec.clipboardText(ref)` 都能**只靠 ref 自身**还原，刷新、重连、宿主从剪贴板重建 chip 之后依然可序列化。损坏/版本不认识的 ref 会**明确 reject**，而不是静默送空串。

---

## 配置

配置存在浏览器 `localStorage`（键 `dsh.quote-sidechat.v1`），调试句柄 `window.__dshQuoteSideChat.setConfig(patch)` 可改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `format` | `'auto'` | 引用块的文本格式：`auto`（代码块用 fenced / 其余 blockquote）、`quote`、`fenced`、`plain` |
| `referenceMode` | `'chip'` | **`chip` = 原子引用**；`quote` = 旧的纯文本引用块（回归对照开关） |
| `attribution` | `false` | 引用后补一行「（引用自第 N 轮回复）」 |
| `minChars` | `2` | 少于这么多字符不弹工具条 |

`referenceMode: 'chip'` 时，若宿主缺少引用管线或 chip 写入被拒（会话正忙/草稿版本已变），会**自动降级**为纯文本插入，不静默丢内容。

---

## 开发

```bash
npm test          # node --test test/verify.mjs —— 44 条离线断言（真实 bundle + mock DOM）
npm run check     # node --check 入口 + 全量自测
npm run verify:ui # 真机验证（CDP 驱动无头 Chrome 打开真实 DSH Web GUI）
```

### 测试覆盖的缝（seams）

自测在**最小 mock DOM** 上加载**真实的** `lib/client.js`（走真实 `window.__ModuleLoader__.load` 路径），断言世界可见行为：

- **模块形状**：Loader id 逐字等于 `package.json#name`；平铺导出 `apply`/`inject`；import 期间零副作用。
- **装载**：`apply()` 注入样式、建工具条、暴露调试句柄、注册**唯一**的会话桥插槽。
- **引用 source 契约**：注册 `quote-ref`、`candidates()` 恒空（不污染 `@` 菜单）；codec 只靠 ref 自身还原；损坏 ref 明确 reject。
- **chip 写入**：点「添加到对话」→ `insertReference({source:'quote-ref',...}, span)`，span 带 `draftRev`，source 路由键正确，codec 能把该 ref 还原成模型形式。
- **降级**：宿主拒绝 chip → 回退纯文本；`referenceMode:'quote'` 强制纯文本。

---

## 联调

```bash
../../scripts/link-plugin.sh quote-sidechat   # 软链进 desktop profile
# 重启 DSH 后选中一段回复，点「添加到对话」→ 输入框出现引用 chip
```

## 许可证

MIT（继承上游）。见 [`LICENSE`](./LICENSE)。