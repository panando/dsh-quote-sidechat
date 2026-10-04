// @panando/dsh-quote-sidechat — browser half.
// （fork 自 QIN-SMART/dsh-quote-sidechat v0.2.0；本 fork 把引用升级为宿主原子 chip。）
//
// 在 DSH Web GUI 里选中回复内容，弹出浮动工具条：「添加到对话」把选中片段
// 作为**原子引用 chip** 写进输入框（composer）草稿，另一个动作是「复制」。
// 默认外观完全使用 DSH 原生菜单材质（--dsw-specific-menu / --dsw-menu-backdrop-filter /
// --dsw-elevation-prominent），未选中文本时不存在任何可见 DOM。
//
// 约束与做法（全部来自 DSH 0.2.0-rc.1 的真实契约，见 README「落地依据」）：
//  1. 本文件按 dsh-client-modules 的 lazy-CJS 模型编写：顶层只允许注册 factory，
//     任何副作用都必须留在 factory 闭包内、由 apply() 在 materialization 时触发。
//  2. `id` 必须等于 package.json 的 name，否则浏览器侧永远 materialize 不出来。
//  3. 模块对象用平铺导出（exports.apply / exports.inject），不要 export default：
//     loader 的 unwrapExports 会用 default 整个替换命名空间，写在一起的 inject 会静默丢失。
//  4. 写回输入框只走公开 API：会话 scope 的插槽组件会自动拿到 `inputActions`
//     （ui-conversation 的 `ctx.uiSession.provide({ props: ['inputActions'] })`），
//     `captureInsertion()` 给出带 draftRev 的插入位置，`insertText(text, span)`
//     执行一次原子插入；draftRev 不匹配或输入框处于 adjudicating/submitting 时
//     它返回 false（不会破坏草稿），我们据此提示重试。
//  5. 因此本插件必须注册**一个**会话级插槽条目（conversation.input.overlay）当桥，
//     它只渲染一个 display:none 的锚点 span，用来把 inputActions 和「本会话的
//     DOM 子树的归属」交给工具条；浮层本体是纯 DOM，直接挂 document.body。
//  6. 选区识别不依赖任何构建期哈希类名：消息轮次用 `[data-chat-turn]`，对话正文
//     容器用插槽渲染器固定输出的 `[data-slot="conversation.session"]`。
//  7. 注入样式表必须自己打 `data-plugin` / `data-plugin-css`，否则可能被后一个
//     materialize 的插件「认领」，并在它卸载时被删掉。
//  8. 【本 fork 新增】原子引用走宿主引用管线：`ctx.inputTriggers.registerSource`
//     注册 `quote-ref`，chip 由 `conversation.input.for(actx).insertReference(ref, span)`
//     落下（宿主 ReferenceChipNode，天然可整体删除），提交前宿主按 chip.source 路由回
//     `codec.serialize` 展开成模型可见形式。ref 自包含（q1|base64url(模型文本)），
//     保证刷新后仍可序列化——否则宿主会因序列化失败拒绝该轮。缺少管线时自动降级纯文本。

window.__ModuleLoader__.load({
  id: '@panando/dsh-quote-sidechat',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    // ======================================================================
    // 一、常量
    // ======================================================================

    var PKG = '@panando/dsh-quote-sidechat';
    var VERSION = '0.3.0';
    var STYLE_TAG_ID = PKG + '/style';
    var GLOBAL_KEY = '__dshQuoteSideChat';
    var STORAGE_KEY = 'dsh.quote-sidechat.v1';

    /** 本插件所有 DOM 都带这个属性；值是它在工具条里的角色（bar / add / side / copy / flash / anchor）。 */
    var MARK = 'data-dsh-quote-sidechat';

    /** 会话级插槽：resident composer card 里的浮层座位，官方 feedback 弹窗也用这一格。 */
    var SLOT_OVERLAY = 'conversation.input.overlay';

    /** 插槽渲染器给每个 outlet 输出的固定锚点（renderer 里 ANCHOR_STYLE 的那层 div）。 */
    var TRANSCRIPT_SLOT = '[data-slot="conversation.session"]';
    var COMPOSER_BAR_SLOT = 'conversation.composer.bar';
    /** 官方自己在用的会话身份钩子（ui-conversation 的 Escape 处理就是这么取 sessionId 的）。 */
    var SESSION_ATTR = 'data-conversation-session';
    /** 右侧栏的插槽 outlet；第三方侧边对话 tab 的输入框落在它里面。 */
    var RIGHTBAR_SLOT = '[data-slot="rightbar.session"]';

    /** Lexical contenteditable 宿主：role/aria-multiline 由 lexical-react 固定输出。 */
    var EDITOR_SELECTOR = 'div[contenteditable="true"][role="textbox"]';
    var EDITOR_FALLBACK = 'div[contenteditable="true"]';

    /** dsh-better-sidebar 的侧边对话 tab 类型与它的客户端服务名（可选依赖，用 ctx.get 读）。 */
    var SIDE_TAB_TYPE = 'sidechat';
    var SIDE_SERVICE = 'betterSidebar';
    var SIDE_WAIT_MS = 5000;
    var SIDE_POLL_MS = 120;

    var GAP = 8;
    var MARGIN = 8;
    var BAR_FALLBACK_WIDTH = 176;
    var BAR_FALLBACK_HEIGHT = 30;

    var DEFAULTS = {
      enabled: true,
      /** auto = 代码块用 fenced、其余用 blockquote；可强制 quote / fenced / plain。 */
      format: 'auto',
      /** chip = 宿主原子引用（可整体删除、提交时结构化序列化）；quote = 旧的纯文本引用块。 */
      referenceMode: 'chip',
      /** 打开后会在引用块后补一行来源（第 N 轮回复）。 */
      attribution: false,
      /** 少于这么多字符不弹（避免点选几个字就冒泡）。 */
      minChars: 2
    };

    /** 块级标签：Range.cloneContents() 的片段按它们补换行。 */
    var BLOCK_TAGS = {
      P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, PRE: 1, BLOCKQUOTE: 1, H1: 1, H2: 1, H3: 1,
      H4: 1, H5: 1, H6: 1, TR: 1, TABLE: 1, SECTION: 1, ARTICLE: 1, FIGURE: 1,
      FIGCAPTION: 1, DETAILS: 1, SUMMARY: 1, DL: 1, DT: 1, DD: 1, HR: 1
    };

    /**
     * 工具条材质：与原生菜单同一组 token（MenuSurface / stat-dialog / panel 都是这套）。
     *
     * 关键一条：原生菜单填充 --dsw-specific-menu 只有 **58% 不透明**（浅色 #f8f9fa94 /
     * 深色 #43454a73），它是给「浮在平面背景上的菜单」设计的；工具条却正好浮在密集正文上，
     * 用它单独做底会让前后两层互相穿透、两边都看不清（实测：正文笔画直接压在标签上）。
     * theme 里确实存在一个 94% 的 macOS 版本（#f8f9faf0），但它的选择器是
     * `html[data-platform=darwin] body`，而这个构建从不设置 data-platform（实测 html 与
     * body 上都没有该属性）——那条规则是死代码。
     *
     * 所以做法是：把原生填充铺在**一层不透明的应用层色**上。色相仍是原生菜单色（浅色下
     * 合成 ≈ #fbfbfc，深色下 ≈ #313235），但任何内容都不会再透上来。backdrop-filter 保留，
     * 既与原生材质声明一致，将来填充若变透也能自动回落到毛玻璃。
     */
    var CSS = [
      '.dshqc-bar{position:fixed;z-index:1140;box-sizing:border-box;display:flex;align-items:center;padding:2px;',
      'border-radius:var(--dsw-radius-lg,10px);',
      'background-color:var(--dsw-alias-bg-layer-1,#fff);',
      'background-image:linear-gradient(var(--dsw-specific-menu,rgba(248,249,250,.94)),var(--dsw-specific-menu,rgba(248,249,250,.94)));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,none);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.18));',
      'color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,inherit);',
      'font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'white-space:nowrap;user-select:none;-webkit-user-select:none;',
      'opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease,visibility .12s ease}',
      '.dshqc-bar[data-open="1"]{opacity:1;visibility:visible;pointer-events:auto}',
      '.dshqc-item{display:inline-flex;align-items:center;box-sizing:border-box;border:0;background:0 0;font:inherit;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;padding:3px 10px;border-radius:var(--dsw-radius-md,6px);',
      'white-space:nowrap;-webkit-user-select:none;user-select:none}',
      '.dshqc-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshqc-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dshqc-item[data-dsh-quote-sidechat="add"]{color:var(--dsw-alias-label-primary)}',
      '.dshqc-sep{flex:none;width:1px;height:14px;margin:0 2px;background:var(--dsw-alias-border-l1)}',
      '.dshqc-flash{display:none;padding:3px 10px;color:var(--dsw-alias-label-secondary)}',
      '.dshqc-bar[data-flash="1"] .dshqc-item,.dshqc-bar[data-flash="1"] .dshqc-sep{display:none}',
      '.dshqc-bar[data-flash="1"] .dshqc-flash{display:inline-flex}',
      // 没装侧边对话（dsh-better-sidebar）时，整条动作连同它前面的分隔线一起消失。
      '.dshqc-bar[data-sidechat="0"] [data-dsh-quote-sidechat="side"],',
      '.dshqc-bar[data-sidechat="0"] [data-dsh-quote-sidechat="sep-side"]{display:none}',
      // 点击 chip 回跳时，给原文所在轮次一个短暂的高亮。
      '[data-quote-flash="1"]{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:6px;border-radius:8px;transition:outline-color .2s ease}'
    ].join('');

    // ======================================================================
    // 二、纯函数区（离线单测直接覆盖）
    // ======================================================================

    /**
     * 归一化选区文本：统一换行、去零宽字符、去行尾空白与首尾空行。
     * @param raw - Selection/Range 的原始文本。
     * @returns 干净的引用文本（可能为空串）。
     */
    function normalizeText(raw) {
      if (typeof raw !== 'string') return '';
      return raw
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/^\n+/, '')
        .replace(/\s+$/, '');
    }

    /**
     * 把 Range.cloneContents() 的片段还原成带块级换行的纯文本。
     * 浏览器 Selection.toString() 不保证块级元素之间补换行，多段选中会粘成一行。
     * @param fragment - DocumentFragment 或任意带 childNodes 的节点。
     * @returns 纯文本（未归一化）。
     */
    function extractText(fragment) {
      var out = '';
      var walk = function (node) {
        var kids = node && node.childNodes ? node.childNodes : [];
        for (var i = 0; i < kids.length; i += 1) {
          var child = kids[i];
          if (child.nodeType === 3) { out += child.nodeValue || ''; continue; }
          if (child.nodeType !== 1) continue;
          var name = String(child.nodeName || '').toUpperCase();
          if (name === 'BR') { out += '\n'; continue; }
          var block = !!BLOCK_TAGS[name];
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
          walk(child);
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        }
      };
      walk(fragment);
      return out.replace(/^\n+/, '').replace(/\n+$/, '');
    }

    /**
     * 引用正文的三种形态。
     * @param text - 归一化后的文本。
     * @param mode - quote / fenced / plain。
     * @param lang - fenced 模式下的语言标记（可空）。
     * @returns 正文。
     */
    function quoteBody(text, mode, lang) {
      if (mode === 'plain') return text;
      if (mode === 'fenced') return '```' + (lang || '') + '\n' + text + '\n```';
      return String(text).split('\n').map(function (line) {
        return line.length ? '> ' + line : '>';
      }).join('\n');
    }

    /**
     * 最终写进输入框的文本：引用本体 + 尾随一个空行（光标落在这里，接着就能写）。
     * @param text - 原始选区文本。
     * @param cfg - 归一化后的配置。
     * @param meta - { isCode, lang, turn }。
     * @returns 写进草稿的字符串；空选区返回空串。
     */
    function buildPayload(text, cfg, meta) {
      var body = normalizeText(text);
      if (!body) return '';
      var info = meta || {};
      var mode = cfg.format === 'auto' ? (info.isCode ? 'fenced' : 'quote') : cfg.format;
      var out = quoteBody(body, mode, info.lang);
      if (cfg.attribution && info.turn !== null && info.turn !== undefined) {
        out += '\n\n（引用自第 ' + info.turn + ' 轮回复）';
      }
      return out + '\n\n';
    }

    /**
     * 侧边对话专用载荷：**带结构化边界的引用块**。
     *
     * 为什么主路径不用它：主会话走宿主原子 chip，chip 自带身份与删除语义，
     * 提交时由宿主 codec.serialize 展开，模型能明确区分引用与用户输入。
     *
     * 而侧边对话的 composer 是 dsh-better-sidebar 自己的 <textarea>（useState 驱动），
     * 既渲染不了 chip，也不走宿主的序列化管线——只能塞文本。于是这里改用**显式边界**
     * 来达到同样的可区分性：`【引用 · 第 N 轮回复】` 起、`【/引用】` 止，
     * 中间逐行 `> ` 前缀。模型据此能把引用原文与用户随后写的提问切开，
     * 而不是把两者混成一坨纯文本。
     *
     * @param text - 原始选区文本。
     * @param cfg - 归一化后的配置。
     * @param meta - { isCode, lang, turn }。
     * @returns 写进侧边输入框的字符串；空选区返回空串。
     */
    function buildSidePayload(text, cfg, meta) {
      var body = normalizeText(text);
      if (!body) return '';
      var info = meta || {};
      var label = info.turn === null || info.turn === undefined
        ? '引用自选中的回复：'
        : '引用自第 ' + info.turn + ' 轮回复：';
      // 围栏比原文里最长的连续反引号串更长，保证原文自带的 ``` 不会提前闭合外层围栏。
      var longest = 0;
      var runs = String(body).match(/`+/g) || [];
      for (var i = 0; i < runs.length; i += 1) longest = Math.max(longest, runs[i].length);
      var fence = '`'.repeat(Math.max(3, longest + 1));
      return label + '\n\n' + fence + '\n' + body + '\n' + fence + '\n\n';
    }

    /**
     * 工具条定位：默认贴选区首行上方，上方放不下就落到末行下方，横向居中并夹进视口。
     * @param rects - 选区各行的 {top,left,width,bottom}（顺序即文档顺序）。
     * @param size - 工具条 {width,height}。
     * @param viewport - {top,left,right,bottom}。
     * @param gap - 与选区的间距。
     * @param margin - 与视口边缘的最小距离。
     * @returns {left, top, placement}。
     */
    function placeBar(rects, size, viewport, gap, margin) {
      var head = rects[0];
      var tail = rects[rects.length - 1];
      var w = size.width;
      var h = size.height;
      var above = head.top - h - gap;
      var below = tail.bottom + gap;
      var placement = 'above';
      var top = above;
      if (above < viewport.top + margin) {
        if (below + h <= viewport.bottom - margin) {
          placement = 'below';
          top = below;
        } else {
          top = Math.max(viewport.top + margin, above);
        }
      }
      // 两个方向都要夹进视口：选区本身可能正好跨在边界上。
      top = Math.min(Math.max(top, viewport.top + margin), Math.max(viewport.top + margin, viewport.bottom - margin - h));
      var center = head.left + head.width / 2;
      var left = center - w / 2;
      var minLeft = viewport.left + margin;
      var maxLeft = viewport.right - w - margin;
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = Math.max(minLeft, maxLeft);
      return { left: Math.round(left), top: Math.round(top), placement: placement };
    }

    /**
     * 该不该弹工具条（纯判定，所有否决分支都能离线覆盖）。
     * @param input - { enabled, hasRange, hasRects, inViewport, text, minChars, insideEditable, insideOwnUi, insideTranscript }。
     * @returns 是否显示。
     */
    function shouldShow(input) {
      if (!input.enabled) return false;
      if (!input.hasRange || !input.hasRects) return false;
      if (!input.inViewport) return false;
      if (!input.text || input.text.length < input.minChars) return false;
      if (input.insideEditable) return false;
      if (input.insideOwnUi) return false;
      if (!input.insideTranscript) return false;
      return true;
    }

    /**
     * 选区是否还在视口里：整段滚出屏幕时不该在空处悬一条工具条。
     * @param rects - 选区各行矩形。
     * @param viewport - 视口。
     * @returns 至少有一行与视口相交。
     */
    function rectsInViewport(rects, viewport) {
      for (var i = 0; i < rects.length; i += 1) {
        if (rects[i].bottom > viewport.top && rects[i].top < viewport.bottom) return true;
      }
      return false;
    }

    /**
     * `data-chat-turn` 的值解析成轮次号。
     * @param value - 属性原文。
     * @returns 非负整数或 null。
     */
    function parseTurn(value) {
      if (value === null || value === undefined || value === '') return null;
      var n = Number(value);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }

    /**
     * 从元素往上找第一个「也包含目标节点」的祖先（= 同一个对话面板），body/html 不算。
     * @param fromEl - 起点（通常是某个 composer 的锚点）。
     * @param target - 选区所在的节点。
     * @returns 共同容器或 null。
     */
    function commonContainer(fromEl, target) {
      var node = fromEl;
      while (node) {
        if (node === document.body || node === document.documentElement) return null;
        if (typeof node.contains === 'function' && target && node.contains(target)) return node;
        node = node.parentNode;
      }
      return null;
    }

    /** 节点深度，用于在多个候选里挑最近的那个共同容器。 */
    function depthOf(node) {
      var depth = 0;
      var cursor = node;
      while (cursor) { depth += 1; cursor = cursor.parentNode; }
      return depth;
    }

    // ======================================================================
    // 三、运行态
    // ======================================================================

    var config = defaultConfig();
    var installed = false;
    var barEl = null;
    var flashEl = null;
    var flashTimer = null;
    var rafId = null;
    var sideChatPoll = null;
    /** 客户端根上下文：只用来 ctx.get 那个可选服务（inject-free，缺了不抛）。 */
    var rootContext = null;
    var state = { snapshot: null, flashing: false };

    /** 每个会话一个桥实例：锚点 DOM + 该会话的 inputActions。 */
    var instances = [];
    var instanceSeq = 0;
    /** 引用 source 是否已成功注册到宿主（决定写入路径能否走原子 chip）。 */
    var referenceSourceRegistered = false;
    /** 最近一次 chip 写入尝试的诊断（供真机排查；不参与功能判断）。 */
    var lastChipDiag = { attempted: false, ok: false, stage: null, detail: null };

    function defaultConfig() {
      var cfg = {};
      for (var key in DEFAULTS) cfg[key] = DEFAULTS[key];
      return cfg;
    }

    /**
     * 读配置（localStorage 坏数据一律回落到默认值）。
     * @returns 归一化配置。
     */
    function readConfig() {
      var cfg = defaultConfig();
      var raw = null;
      try {
        raw = window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null;
      } catch (err) { raw = null; }
      if (!raw) return cfg;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (err) { return cfg; }
      if (!parsed || typeof parsed !== 'object') return cfg;
      if (typeof parsed.enabled === 'boolean') cfg.enabled = parsed.enabled;
      if (parsed.format === 'auto' || parsed.format === 'quote' || parsed.format === 'fenced' || parsed.format === 'plain') {
        cfg.format = parsed.format;
      }
      if (typeof parsed.attribution === 'boolean') cfg.attribution = parsed.attribution;
      if (parsed.referenceMode === 'chip' || parsed.referenceMode === 'quote') {
        cfg.referenceMode = parsed.referenceMode;
      }
      if (typeof parsed.minChars === 'number' && isFinite(parsed.minChars) && parsed.minChars >= 0) {
        cfg.minChars = Math.floor(parsed.minChars);
      }
      return cfg;
    }

    /**
     * 写配置（只接受白名单字段）。
     * @param patch - 部分配置。
     * @returns 归一化后的新配置。
     */
    function writeConfig(patch) {
      var next = defaultConfig();
      for (var key in config) next[key] = config[key];
      if (patch && typeof patch === 'object') {
        if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
        if (patch.format === 'auto' || patch.format === 'quote' || patch.format === 'fenced' || patch.format === 'plain') {
          next.format = patch.format;
        }
        if (typeof patch.attribution === 'boolean') next.attribution = patch.attribution;
        if (patch.referenceMode === 'chip' || patch.referenceMode === 'quote') {
          next.referenceMode = patch.referenceMode;
        }
        if (typeof patch.minChars === 'number' && isFinite(patch.minChars) && patch.minChars >= 0) {
          next.minChars = Math.floor(patch.minChars);
        }
      }
      config = next;
      try {
        if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch (err) { /* 隐私模式等：内存态照常生效 */ }
      return config;
    }

    // ======================================================================
    // 四、DOM：样式、工具条
    // ======================================================================

    function installStyle() {
      if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = PKG;
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function removeStyle() {
      var tag = document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]');
      if (tag && tag.parentNode) tag.remove();
    }

    function buildBar() {
      if (barEl) return;
      var bar = document.createElement('div');
      bar.className = 'dshqc-bar';
      bar.setAttribute(MARK, 'bar');
      bar.setAttribute('data-open', '0');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '选中文本操作');

      var add = document.createElement('button');
      add.className = 'dshqc-item';
      add.setAttribute(MARK, 'add');
      add.setAttribute('type', 'button');
      add.setAttribute('aria-label', '添加到对话');
      add.textContent = '添加到对话';

      var sep = document.createElement('span');
      sep.className = 'dshqc-sep';
      sep.setAttribute(MARK, 'sep-side');
      sep.setAttribute('aria-hidden', 'true');

      var side = document.createElement('button');
      side.className = 'dshqc-item';
      side.setAttribute(MARK, 'side');
      side.setAttribute('type', 'button');
      side.setAttribute('aria-label', '在侧边对话中提问');
      side.textContent = '侧边提问';

      var sep2 = document.createElement('span');
      sep2.className = 'dshqc-sep';
      sep2.setAttribute(MARK, 'sep-copy');
      sep2.setAttribute('aria-hidden', 'true');

      var copy = document.createElement('button');
      copy.className = 'dshqc-item';
      copy.setAttribute(MARK, 'copy');
      copy.setAttribute('type', 'button');
      copy.setAttribute('aria-label', '复制');
      copy.textContent = '复制';

      var flash = document.createElement('span');
      flash.className = 'dshqc-flash';
      flash.setAttribute(MARK, 'flash');
      flash.setAttribute('role', 'status');

      bar.appendChild(add);
      bar.appendChild(sep);
      bar.appendChild(side);
      bar.appendChild(sep2);
      bar.appendChild(copy);
      bar.appendChild(flash);

      // 保住选区：点工具条不能把 DOM 选区清掉。
      bar.addEventListener('mousedown', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      });
      bar.addEventListener('click', onBarClick);

      document.body.appendChild(bar);
      barEl = bar;
      flashEl = flash;
    }

    function onBarClick(event) {
      var target = event ? event.target : null;
      var hit = target && typeof target.closest === 'function' ? target.closest('[' + MARK + ']') : null;
      if (!hit || typeof hit.getAttribute !== 'function') return;
      var action = hit.getAttribute(MARK);
      if (action === 'add') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        addToConversation();
      } else if (action === 'side') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        openSideChat();
      } else if (action === 'copy') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        copySelection();
      }
    }

    /**
     * 把一个会话的 inputActions 绑到它的锚点上。
     * @param anchorEl - 该会话 composer 卡片内的锚点元素。
     * @param inputActions - 会话公开输入动作面（可能缺失，缺失时动作会明确报错而不是静默）。
     * @returns 解绑函数。
     */
    function bindInstance(anchorEl, inputActions) {
      if (!anchorEl) return function () {};
      var instance = { id: (instanceSeq += 1), anchor: anchorEl, inputActions: inputActions || null };
      instances.push(instance);
      return function () {
        var index = instances.indexOf(instance);
        if (index >= 0) instances.splice(index, 1);
      };
    }

    function liveInstances() {
      return instances.filter(function (instance) {
        return instance.anchor && instance.anchor.isConnected !== false;
      });
    }

    /**
     * 选中哪条对话的文本，就写回那条对话的输入框。
     * @param selEl - 选区所在元素。
     * @returns 目标实例；无法唯一确定时返回 null（宁可报错也不写错地方）。
     */
    function pickInstance(selEl) {
      var live = liveInstances();
      if (!live.length) return null;
      var best = null;
      var bestDepth = -1;
      for (var i = 0; i < live.length; i += 1) {
        var container = commonContainer(live[i].anchor, selEl);
        if (!container) continue;
        var depth = depthOf(container);
        if (depth > bestDepth) { best = live[i]; bestDepth = depth; }
      }
      if (best) return best;
      return live.length === 1 ? live[0] : null;
    }

    /** 找到某个会话 composer 的 Lexical 宿主（先缩到该会话的 composer 卡片，避免抓到别的会话）。 */
    function composerEditorOf(instance) {
      var host = null;
      var node = instance && instance.anchor;
      while (node) {
        if (typeof node.getAttribute === 'function' && node.getAttribute('data-slot') === COMPOSER_BAR_SLOT) {
          host = node;
          break;
        }
        node = node.parentNode;
      }
      if (!host) host = document;
      return host.querySelector(EDITOR_SELECTOR) || host.querySelector(EDITOR_FALLBACK) || null;
    }

    // ======================================================================
    // 五、选区 → 工具条
    // ======================================================================

    function elementOf(node) {
      if (!node) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement || node.parentNode || null;
    }

    function elementInEditable(el) {
      var node = el;
      while (node) {
        if (node.isContentEditable === true) return true;
        if (typeof node.getAttribute === 'function' && node.getAttribute('contenteditable') === 'true') return true;
        node = node.parentNode;
      }
      return false;
    }

    function rectToPlain(rect) {
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width || 0,
        bottom: rect.bottom !== undefined ? rect.bottom : rect.top + (rect.height || 0)
      };
    }

    /**
     * 读取当前 DOM 选区，组装成快照。
     * @returns 快照或 null（折叠/空文本/没有几何信息）。
     */
    function readSelection() {
      var selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      var range = null;
      try { range = selection.getRangeAt(0); } catch (err) { return null; }
      if (!range) return null;

      var raw = '';
      try {
        raw = typeof range.cloneContents === 'function'
          ? extractText(range.cloneContents())
          : (selection.toString ? selection.toString() : range.toString());
      } catch (err) {
        raw = selection.toString ? selection.toString() : '';
      }
      var text = normalizeText(raw);
      if (!text) return null;

      var rects = [];
      if (typeof range.getClientRects === 'function') {
        var list = range.getClientRects();
        for (var i = 0; i < (list ? list.length : 0); i += 1) {
          var rect = list[i];
          if (rect && (rect.width || rect.bottom - rect.top)) rects.push(rectToPlain(rect));
        }
      }
      if (!rects.length && typeof range.getBoundingClientRect === 'function') {
        var box = range.getBoundingClientRect();
        if (box && (box.width || box.height)) rects.push(rectToPlain(box));
      }
      if (!rects.length) return null;

      var el = elementOf(range.commonAncestorContainer || range.startContainer);
      // 只有块级 <pre> 才算代码：行内 <code> 保持引用块，避免一个词被包成围栏。
      var preEl = el && el.closest ? el.closest('pre') : null;
      var lang = '';
      if (preEl) {
        var langSources = [];
        if (typeof preEl.querySelector === 'function') {
          var codeChild = preEl.querySelector('code');
          if (codeChild) langSources.push(codeChild);
        }
        langSources.push(preEl);
        for (var s = 0; s < langSources.length && !lang; s += 1) {
          var source = langSources[s];
          var named = String(source.className || '').match(/language-([\w+#.-]+)/);
          if (named) lang = named[1];
          else if (typeof source.getAttribute === 'function') lang = source.getAttribute('data-language') || '';
        }
      }
      var turnEl = el && el.closest ? el.closest('[data-chat-turn]') : null;
      var turn = turnEl && typeof turnEl.getAttribute === 'function'
        ? parseTurn(turnEl.getAttribute('data-chat-turn'))
        : null;

      return {
        text: text,
        rects: rects,
        el: el,
        meta: { isCode: !!preEl, lang: lang || '', turn: turn }
      };
    }

    function schedule(fn) {
      if (rafId !== null) return;
      var run = function () { rafId = null; fn(); };
      if (typeof window.requestAnimationFrame === 'function') rafId = window.requestAnimationFrame(run);
      else rafId = setTimeout(run, 0);
    }

    function evaluate() {
      if (!installed) return;
      // 结果提示期间不改动工具条：写回草稿会让光标落进 composer，
      // 那次 selectionchange 不该把「已添加到对话」当场抹掉。
      if (state.flashing) return;
      if (!config.enabled) { hideBar(); return; }
      var snapshot = readSelection();
      if (!snapshot) { hideBar(); return; }
      var el = snapshot.el;
      var insideOwnUi = !!(el && el.closest && el.closest('[' + MARK + ']'));
      var insideTranscript = !!(el && el.closest && el.closest(TRANSCRIPT_SLOT));
      var ok = shouldShow({
        enabled: config.enabled,
        hasRange: true,
        hasRects: snapshot.rects.length > 0,
        inViewport: rectsInViewport(snapshot.rects, viewportBox()),
        text: snapshot.text,
        minChars: config.minChars,
        insideEditable: elementInEditable(el),
        insideOwnUi: insideOwnUi,
        insideTranscript: insideTranscript
      });
      if (!ok) { hideBar(); return; }
      state.snapshot = snapshot;
      showBar(snapshot);
    }

    function viewportBox() {
      var width = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024;
      var height = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
      return { top: 0, left: 0, right: width, bottom: height };
    }

    function showBar(snapshot) {
      if (!barEl) return;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      barEl.removeAttribute('data-flash');
      // 没装侧边对话就把那条动作藏掉——不留一个点了没用的按钮。
      barEl.setAttribute('data-sidechat', sideService() ? '1' : '0');
      var size = {
        width: barEl.offsetWidth || BAR_FALLBACK_WIDTH,
        height: barEl.offsetHeight || BAR_FALLBACK_HEIGHT
      };
      var spot = placeBar(snapshot.rects, size, viewportBox(), GAP, MARGIN);
      barEl.style.left = spot.left + 'px';
      barEl.style.top = spot.top + 'px';
      barEl.setAttribute('data-placement', spot.placement);
      barEl.setAttribute('data-open', '1');
    }

    function hideBar() {
      state.snapshot = null;
      state.flashing = false;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      if (!barEl) return;
      barEl.removeAttribute('data-flash');
      barEl.setAttribute('data-open', '0');
    }

    function flash(message, ms) {
      if (!barEl || !flashEl) return;
      state.flashing = true;
      flashEl.textContent = message;
      barEl.setAttribute('data-flash', '1');
      barEl.setAttribute('data-open', '1');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        flashTimer = null;
        hideBar();
      }, typeof ms === 'number' && ms > 0 ? ms : 1600);
    }

    /** 滚动/缩放时若选区还在就跟着挪，选区没了就收起。 */
    function reposition() {
      if (state.flashing) return;
      if (!barEl || barEl.getAttribute('data-open') !== '1') return;
      var snapshot = readSelection();
      if (!snapshot) { hideBar(); return; }
      state.snapshot = snapshot;
      showBar(snapshot);
    }

    // ======================================================================
    // 六、动作：添加到对话 / 复制
    // ======================================================================

    function focusComposer(instance) {
      var editor = composerEditorOf(instance);
      if (!editor || typeof editor.focus !== 'function') return;
      try { editor.focus({ preventScroll: true }); } catch (err) {
        try { editor.focus(); } catch (err2) { /* 拿不到焦点不影响已写入的草稿 */ }
      }
    }

    /**
     * chip 上显示的短标签：取正文首行、压成一行、限长。
     * @param modelText - 最终模型文本（引用块全文）。
     * @returns 短标签。
     */
    function chipLabelOf(modelText) {
      var first = String(modelText || '').split('\n')[0] || '';
      var body = first.replace(/^>\s?/, '').replace(/^`{1,3}[a-zA-Z0-9]*\s?/, '').trim();
      if (!body) body = '引用';
      return body.length > 24 ? body.slice(0, 24) + '…' : body;
    }

    /**
     * 取该会话的 input shell（宿主会话作用域）。
     * @param sessionId - 目标会话 id。
     * @returns shell 或 null。
     */
    function inputShellOf(sessionId) {
      if (!sessionId) { lastChipDiag.stage = 'no-session-id'; lastChipDiag.detail = 'instance.anchor 上没有 data-conversation-session'; return null; }
      if (!rootContext || typeof rootContext.get !== 'function') { lastChipDiag.stage = 'no-root-ctx'; return null; }
      var services = null;
      try { services = rootContext.get('conversation'); } catch (err) { lastChipDiag.stage = 'get-conversation-threw'; lastChipDiag.detail = String(err && err.message || err); return null; }
      var sessions = null;
      try { sessions = rootContext.get('sessions'); } catch (err) { lastChipDiag.stage = 'get-sessions-threw'; lastChipDiag.detail = String(err && err.message || err); return null; }
      if (!services) { lastChipDiag.stage = 'no-conversation-service'; return null; }
      if (!services.input || typeof services.input.for !== 'function') { lastChipDiag.stage = 'conversation-no-input-for'; return null; }
      if (!sessions) { lastChipDiag.stage = 'no-sessions-service'; return null; }
      var binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : null;
      var actx = binding && binding.ctx ? binding.ctx : (typeof sessions.scope === 'function' ? sessions.scope(sessionId) : null);
      if (!actx) { lastChipDiag.stage = 'no-session-binding'; lastChipDiag.detail = 'sessionId=' + sessionId; return null; }
      try {
        var shell = services.input.for(actx);
        if (!shell) { lastChipDiag.stage = 'input-for-null'; return null; }
        if (typeof shell.insertReference !== 'function') { lastChipDiag.stage = 'shell-no-insertReference'; lastChipDiag.detail = Object.keys(shell).slice(0, 12).join(','); return null; }
        lastChipDiag.stage = 'shell-ok';
        return shell;
      } catch (err) {
        lastChipDiag.stage = 'input-for-threw';
        lastChipDiag.detail = String(err && err.message || err);
        return null;
      }
    }

    /**
     * 把引用以原子 chip 写进会话输入框。
     *
     * span 一律取自会话桥手上的 `inputActions.captureInsertion()`——那是宿主自己
     * 认可的插入位置，且与纯文本路径同源同坐标系（detect 坐标）。**不能**用
     * `state.draft.length` 去拼：state.draft 是 clipboard 投影，草稿里只要已有
     * 一个引用 chip，两者长度就不同，拼出来的位置会把新 chip 插错位置甚至插进
     * 别的 chip 中间。宿主 shell 上没有 captureInsertion（它只在 actions 面上），
     * 所以这里依赖桥组件传下来的 inputActions；拿不到就返回 false 让调用方降级纯文本。
     *
     * @param instance - 目标会话实例（带 inputActions 与带会话身份的锚点）。
     * @param modelText - 最终模型文本。
     * @param turn - 被引用文本所在的轮次（编进 ref，点击 chip 时据此回跳）。
     * @returns true 已写入；false 未写入（调用方负责降级或提示）。
     */
    function writeChip(instance, modelText, turn) {
      var actions = instance.inputActions;
      if (!actions || typeof actions.captureInsertion !== 'function') return false;
      var sessionId = sessionIdOf(instance.anchor);
      var shell = inputShellOf(sessionId);
      if (!shell) return false;
      var span;
      try {
        span = actions.captureInsertion();
      } catch (err) {
        lastChipDiag.stage = 'capture-insertion-threw';
        lastChipDiag.detail = String(err && err.message || err);
        return false;
      }
      if (!span || typeof span.draftRev !== 'number') { lastChipDiag.stage = 'bad-span'; lastChipDiag.detail = JSON.stringify(span); return false; }
      var ref = {
        source: SOURCE_NAME,
        ref: encodeRef(modelText, { sessionId: sessionIdOf(instance.anchor), turn: turn }),
        label: chipLabelOf(modelText),
        clipboardText: modelText
      };
      try {
        var applied = shell.insertReference(ref, span) === true;
        lastChipDiag.stage = 'insert-reference';
        lastChipDiag.detail = 'returned ' + String(applied);
        lastChipDiag.ok = applied;
        return applied;
      } catch (err) {
        lastChipDiag.stage = 'insert-reference-threw';
        lastChipDiag.detail = String(err && err.message || err);
        return false;
      }
    }

    function addToConversation() {
      var snapshot = state.snapshot;
      if (!snapshot) return;
      var payload = buildPayload(snapshot.text, config, snapshot.meta);
      if (!payload) { flash('没有可引用的内容'); return; }
      var instance = pickInstance(snapshot.el);
      if (!instance) { flash('找不到对应的输入框'); return; }
      var actions = instance.inputActions;
      if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
        flash('当前界面不支持写入输入框');
        return;
      }
      // chip 模式优先：引用作为宿主原子节点落进输入框（可整体删除、提交时结构化序列化）。
      if (config.referenceMode === 'chip') {
        lastChipDiag = { attempted: true, ok: false, stage: referenceSourceRegistered ? 'start' : 'source-not-registered', detail: null };
        if (referenceSourceRegistered) {
          if (writeChip(instance, payload, snapshot.meta ? snapshot.meta.turn : null)) {
            flash('已添加引用 chip');
            focusComposer(instance);
            return;
          }
          // chip 写入被拒（会话正忙/版本已变）：明确降级为纯文本，不静默丢内容。
        }
      }
      var applied = false;
      try {
        var span = actions.captureInsertion();
        applied = actions.insertText(payload, span) === true;
      } catch (err) {
        applied = false;
      }
      if (!applied) { flash('输入框正忙，稍后再试'); return; }
      flash('已添加到对话');
      focusComposer(instance);
    }

    function legacyCopy(text) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        if (area.remove) area.remove();
        flash(ok ? '已复制' : '复制失败');
      } catch (err) {
        flash('复制失败');
      }
    }

    function copySelection() {
      var snapshot = state.snapshot;
      if (!snapshot) return;
      var text = snapshot.text;
      var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(text).then(
          function () { flash('已复制'); },
          function () { legacyCopy(text); }
        );
        return;
      }
      legacyCopy(text);
    }

    // ----------------------------------------------------------------------
    // 侧边提问：交给 dsh-better-sidebar 的侧边对话（可选依赖）
    //
    // 为什么是「可选依赖 + ctx.get」：侧边线程的宿主能力（继承主会话上下文、独立
    // 运行、可提升为顶层会话）由 dsh-better-sidebar 提供，本插件只做两件事——
    //   ① 用它的公开服务开一个 sidechat tab：ctx.betterSidebar.openTab({type:'sidechat'}, {sessionId})
    //      （官方 openTab 会连带把右栏展开，内容不可见就不算打开）；
    //   ② 把引用块写进那个线程的输入框。
    // 第 ② 步它没有公开 API（sidechat.start/prompt 只能「发」不能「存草稿」），
    // 所以走 DOM：它的输入框是一个标准 React 受控 <textarea>，用原生 value setter +
    // 冒泡 input 事件即可让 React 的 onChange 收到，这比伪造键盘事件可靠得多。
    // 找不到输入框时兜底：把引用放进剪贴板并明确告知，绝不让操作静默失败。
    // ----------------------------------------------------------------------

    /** 取可选服务：ctx.get 是 inject-free 读法，缺了返回 undefined 而不是抛错。 */
    function sideService() {
      if (!rootContext || typeof rootContext.get !== 'function') return null;
      var service = null;
      try { service = rootContext.get(SIDE_SERVICE); } catch (err) { service = null; }
      return service && typeof service.openTab === 'function' ? service : null;
    }

    /** 选区所属会话的 id（沿用官方自己的 data-conversation-session 读法）。 */
    function sessionIdOf(el) {
      var node = el;
      while (node && node.nodeType === 1) {
        if (typeof node.getAttribute === 'function') {
          var id = node.getAttribute(SESSION_ATTR);
          if (id) return id;
        }
        node = node.parentNode;
      }
      return null;
    }

    /** 元素是否真的可见（display:none / hidden / 零尺寸都不算）。 */
    function isElementVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.hidden) return false;
        if (node.style && (node.style.display === 'none' || node.style.visibility === 'hidden')) return false;
        node = node.parentNode;
      }
      var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      return !!(rect && (rect.width || rect.height));
    }

    /**
     * 侧边对话的输入框判定：右栏里成尺寸的 textarea。
     * 排除 xterm 的隐藏 helper textarea —— 它是 1×1 且被挪到屏幕外。
     */
    function isSideChatComposer(el) {
      if (!el || String(el.tagName || '').toUpperCase() !== 'TEXTAREA') return false;
      if (typeof el.closest === 'function' && el.closest('.xterm')) return false;
      var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (!rect || rect.width < 80 || rect.height < 14) return false;
      return isElementVisible(el);
    }

    /**
     * 找一个可用的侧边对话输入框。
     * @param before - 点开之前就存在的 textarea 列表；新出现的那个优先（那就是我们刚开的 tab）。
     * @returns textarea 或 null。
     */
    function findSideChatComposer(before) {
      var all = document.querySelectorAll('textarea');
      var fallback = null;
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i];
        if (!isSideChatComposer(el)) continue;
        if (before && before.indexOf(el) === -1) return el;
        if (!fallback && typeof el.closest === 'function' && el.closest(RIGHTBAR_SLOT)) fallback = el;
      }
      return fallback;
    }

    function sideChatSnapshotNow() {
      var all = document.querySelectorAll('textarea');
      var out = [];
      for (var i = 0; i < all.length; i += 1) out.push(all[i]);
      return out;
    }

    /** React 受控组件吃「原生 setter + input 事件」这一套；拿不到原型描述符就退回直接赋值。 */
    function setNativeValue(el, value) {
      var proto = typeof window.HTMLTextAreaElement === 'function' ? window.HTMLTextAreaElement.prototype : null;
      var descriptor = proto && typeof Object.getOwnPropertyDescriptor === 'function'
        ? Object.getOwnPropertyDescriptor(proto, 'value')
        : null;
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
      else el.value = value;
    }

    /** 把引用块写进侧边对话输入框：追加在已有草稿后面，光标落到末尾。 */
    function commitSideQuote(el, payload) {
      var current = typeof el.value === 'string' ? el.value : '';
      var head = current.replace(/\s+$/, '');
      var next = head ? head + '\n\n' + payload : payload;
      setNativeValue(el, next);
      try {
        if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err) { /* 事件构造失败不影响已经写进去的值 */ }
      try { if (typeof el.focus === 'function') el.focus(); } catch (err) { /* ignore */ }
      try { if (typeof el.setSelectionRange === 'function') el.setSelectionRange(next.length, next.length); } catch (err) { /* ignore */ }
      flash('已在侧边对话中引用');
    }

    function waitForSideChat(before, payload, raw, deadline) {
      if (!installed) return;
      var composer = findSideChatComposer(before);
      if (composer) { sideChatPoll = null; commitSideQuote(composer, payload); return; }
      if (Date.now() >= deadline) {
        sideChatPoll = null;
        // 兜底：引用进剪贴板，绝不静默失败。
        var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (clipboard && typeof clipboard.writeText === 'function') {
          try {
            clipboard.writeText(raw).then(null, function () {
              legacyCopy(raw);
              flash('侧边对话已打开，引用已复制');
            });
          } catch (err) {
            legacyCopy(raw);
          }
        } else {
          legacyCopy(raw);
        }
        flash('侧边对话已打开，引用已复制');
        return;
      }
      sideChatPoll = setTimeout(function () {
        waitForSideChat(before, payload, raw, deadline);
      }, SIDE_POLL_MS);
    }

    function openSideChat() {
      var snapshot = state.snapshot;
      if (!snapshot) return;
      // 侧栏是第三方 <textarea>，用带结构化边界的文本载荷（见 buildSidePayload）。
      var payload = buildSidePayload(snapshot.text, config, snapshot.meta);
      if (!payload) { flash('没有可引用的内容'); return; }
      var service = sideService();
      if (!service) { flash('未安装 dsh-better-sidebar'); return; }

      // 右栏已经开着侧边对话就直接用，不再造一个新线程。
      var existing = findSideChatComposer(null);
      if (existing) { commitSideQuote(existing, payload); return; }

      var sessionId = sessionIdOf(snapshot.el);
      var before = sideChatSnapshotNow();
      try {
        service.openTab({ type: SIDE_TAB_TYPE }, sessionId ? { sessionId: sessionId } : undefined);
      } catch (err) {
        flash('打开侧边对话失败');
        return;
      }
      flash('正在打开侧边对话…', SIDE_WAIT_MS + 800);
      waitForSideChat(before, payload, snapshot.text, Date.now() + SIDE_WAIT_MS);
    }

    // ======================================================================
    // 七、监听器
    // ======================================================================

    function onSelectionChange() { schedule(evaluate); }

    function onMouseUp(event) {
      var target = event ? event.target : null;
      if (target && typeof target.closest === 'function' && target.closest('[' + MARK + ']')) return;
      schedule(evaluate);
    }

    function onKeyDown(event) {
      if (event && event.key === 'Escape' && barEl && barEl.getAttribute('data-open') === '1') {
        hideBar();
      }
    }

    function onViewportChange() { schedule(reposition); }

    function attachListeners() {
      document.addEventListener('selectionchange', onSelectionChange, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('touchend', onMouseUp, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onViewportChange, true);
      window.addEventListener('resize', onViewportChange, true);
    }

    function detachListeners() {
      document.removeEventListener('selectionchange', onSelectionChange, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('touchend', onMouseUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange, true);
    }

    // ======================================================================
    // 八、会话桥：唯一一个插槽条目，只为拿 inputActions
    // ======================================================================

    /**
     * conversation.input.overlay 的常驻条目。渲染一个 display:none 的锚点，
     * 把本会话的 inputActions 和「哪个 DOM 子树是这个会话」交给工具条。
     * @param props - 会话标准工具包（含 inputActions）。
     * @returns 隐藏锚点。
     */
    function OverlayBridge(props) {
      var ref = React.useRef(null);
      var actions = props ? props.inputActions : null;
      React.useEffect(function () {
        return bindInstance(ref.current, actions);
      }, [actions]);
      return React.createElement('span', {
        ref: ref,
        'data-dsh-quote-sidechat': 'anchor',
        'aria-hidden': 'true',
        style: { display: 'none' }
      });
    }

    // ======================================================================
    // 九、引用 source：让引用以原子 chip 落进输入框
    //
    // 宿主契约（dsh-client-ui-input-trigger + dsh-client-ui-conversation）：
    //   · ctx.inputTriggers.registerSource(src)：src.name 是 chip 的序列化路由键，
    //     src.codec.serialize(ref) 决定「模型看到的引用形式」，src.codec.clipboardText(ref)
    //     决定剪贴板/持久化形式；src.openReference(session, {ref, appearance}) 负责点击预览。
    //   · chip 本身是宿主的 ReferenceChipNode（Lexical DecoratorNode），原子、可整体删除，
    //     宿主负责渲染；提交前宿主按 chip.source 路由回 src.codec.serialize 展开。
    //
    // 关键设计：ref **自包含**——把最终模型文本编进 ref（q1|<base64url(模型文本)>）。
    // 这样刷新页面、宿主从剪贴板/持久化重建 chip 之后，serialize 仍能从 ref 还原，
    // 不会因为内存 Map 丢失而让宿主「序列化失败 → 拒绝该轮」。
    // ======================================================================

    /** 注册到宿主的引用 source 名（也是 chip 的 data-composer-chip 值与序列化路由键）。 */
    var SOURCE_NAME = 'quote-ref';
    /** ref 版本前缀：q1 只带模型文本；q2 额外携带定位信息（会话 + 轮次）。 */
    var REF_VERSION = 'q2';
    /** 旧版本：仍可解码，保证刷新前的草稿/跨版本粘贴不失效。 */
    var REF_VERSION_LEGACY = 'q1';
    /** 单条引用的模型文本上限，防止超长选区把 ref 撑爆（超出会截断并标注）。 */
    var REF_MAX_CHARS = 4000;

    /**
     * 把引用编成自包含 ref。
     * @param modelText - 提交时模型应看到的引用块全文。
     * @param locate - { sessionId, turn } 定位信息；缺省时退化为 q1 形态。
     * @returns 'q2|<base64url(JSON)>' 或 'q1|<base64url(模型文本)>'。
     */
    function encodeRef(modelText, locate) {
      var text = String(modelText == null ? '' : modelText);
      if (text.length > REF_MAX_CHARS) text = text.slice(0, REF_MAX_CHARS) + '\n…（引用已截断）';
      if (!locate || (locate.sessionId == null && locate.turn == null)) {
        return REF_VERSION_LEGACY + '|' + base64UrlEncode(text);
      }
      var payload = { t: text, s: locate.sessionId == null ? null : String(locate.sessionId) };
      if (locate.turn != null) payload.n = locate.turn;
      return REF_VERSION + '|' + base64UrlEncode(JSON.stringify(payload));
    }

    /**
     * 解码 ref 为 { modelText, sessionId, turn }。
     * q1 只有模型文本（无定位信息，点击 chip 只能提示而不能回跳）。
     * @param ref - 自包含 ref。
     * @returns { modelText, sessionId, turn }。
     */
    function decodeRefPayload(ref) {
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new Error('quote-ref: 引用 ref 为空，无法解码');
      }
      var sep = ref.indexOf('|');
      if (sep < 0) throw new Error('quote-ref: 无法识别的引用 ref');
      var version = ref.slice(0, sep);
      var raw;
      try {
        raw = base64UrlDecode(ref.slice(sep + 1));
      } catch (err) {
        throw new Error('quote-ref: 引用 ref 解码失败');
      }
      if (!raw) throw new Error('quote-ref: 引用 ref 解出空内容');
      if (version === REF_VERSION_LEGACY) {
        return { modelText: raw, sessionId: null, turn: null };
      }
      if (version !== REF_VERSION) throw new Error('quote-ref: 不支持的引用 ref 版本 ' + version);
      var payload;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        throw new Error('quote-ref: 引用 ref 载荷不是合法 JSON');
      }
      if (!payload || typeof payload.t !== 'string' || !payload.t) {
        throw new Error('quote-ref: 引用 ref 载荷缺少模型文本');
      }
      return { modelText: payload.t, sessionId: payload.s == null ? null : payload.s, turn: payload.n == null ? null : payload.n };
    }

    /**
     * 从 ref 还原模型文本。ref 损坏/版本不认识时抛错——宿主规定序列化失败会拒绝该轮，
     * 明确失败远好过静默送空串。
     * @param ref - 自包含 ref。
     * @returns 模型可见的引用块全文。
     */
    function decodeRef(ref) {
      return decodeRefPayload(ref).modelText;
    }

    /** UTF-8 → base64url。 */
    function base64UrlEncode(text) {
      var bytes = utf8Bytes(text);
      var binary = '';
      for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /** base64url → UTF-8 文本。 */
    function base64UrlDecode(encoded) {
      var padded = String(encoded).replace(/-/g, '+').replace(/_/g, '/');
      while (padded.length % 4 !== 0) padded += '=';
      var binary = atob(padded);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return utf8Decode(bytes);
    }

    /** 字符串 → UTF-8 字节数组（手工实现，避免 TextEncoder 在旧 realm 缺席）。 */
    function utf8Bytes(text) {
      var out = [];
      for (var i = 0; i < text.length; i += 1) {
        var code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          var next = text.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
            i += 1;
          }
        }
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
      return out;
    }

    /** UTF-8 字节数组 → 字符串。 */
    function utf8Decode(bytes) {
      var out = '';
      var i = 0;
      while (i < bytes.length) {
        var b = bytes[i];
        var code;
        if (b < 0x80) { code = b; i += 1; }
        else if (b >= 0xc0 && b < 0xe0) { code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
        else if (b >= 0xe0 && b < 0xf0) { code = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
        else { code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); i += 4; }
        if (code > 0xffff) {
          code -= 0x10000;
          out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
        } else {
          out += String.fromCharCode(code);
        }
      }
      return out;
    }

    /**
     * 构造注册到 ctx.inputTriggers 的引用 source。
     *
     * candidates 恒空：这个 source 不提供 @ 菜单候选（它只服务于 chip 的序列化与点击），
     * 但宿主按 name 路由 chip，所以注册后 chip 提交仍能展开成结构化引用块。
     * @returns 一个符合宿主 source 契约的对象。
     */
    function buildReferenceSource() {
      return {
        trigger: '@',
        name: SOURCE_NAME,
        order: 100,
        candidates: function () { return Promise.resolve([]); },
        onPick: function () { return undefined; },
        /**
         * 点击 chip → 回到正文定位并高亮原文。
         *
         * 宿主契约（registerReferenceActivation）：单击 chip 且当前没有折叠外的选区时，
         * 它把 { ref, appearance } 交给本方法；返回 true 表示接管，返回 false 则保留
         * 编辑器原有手势处理。
         *
         * 定位信息来自 ref 自身（q2 携带 sessionId + turn），不依赖内存态——
         * 刷新后 chip 依然能跳回原文。q1 老 ref 没有定位信息，明确提示而不是静默。
         */
        openReference: function (session, reference) {
          if (!reference || !reference.ref) return false;
          var payload;
          try {
            payload = decodeRefPayload(reference.ref);
          } catch (err) {
            flash('这条引用已失效');
            return true;
          }
          if (payload.turn === null || payload.turn === undefined) {
            flash('这条引用没有原文定位信息');
            return true;
          }
          // 宿主把当前 chip 所属会话的投影传进来（{ sessionId }），用它判断是否跨会话——
          // 不从 DOM 反推（data-conversation-session 在会话容器上，从 body 往上走找不到）。
          var currentSessionId = session && session.sessionId ? String(session.sessionId) : null;
          if (payload.sessionId && currentSessionId && payload.sessionId !== currentSessionId) {
            flash('原文在另一个会话里，请先切回去');
            return true;
          }
          var row = document.querySelector('[data-chat-turn="' + String(payload.turn) + '"]');
          if (!row) {
            flash('找不到原文（可能已被清理）');
            return true;
          }
          flashOriginal(row);
          return true;
        },
        codec: {
          clipboardText: function (ref) { return decodeRef(ref); },
          serialize: function (ref) {
            // 始终返回 Promise：宿主以 await/Promise.all 消费，同步抛会打乱它的错误路径。
            try {
              return Promise.resolve(decodeRef(ref));
            } catch (err) {
              return Promise.reject(err);
            }
          }
        }
      };
    }

    /** 高亮样式 id（与样式表里的规则配对）。 */
    var FLASH_STYLE_ID = PKG + '/flash';
    var FLASH_MS = 1600;

    /**
     * 滚动定位到原文所在轮次并短暂高亮。
     * @param row - 原文所在的轮次元素。
     */
    function flashOriginal(row) {
      if (!row) return;
      try {
        if (typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      } catch (err) { /* 滚动失败也要给出高亮反馈 */ }
      row.setAttribute('data-quote-flash', '1');
      if (typeof window.setTimeout === 'function') {
        window.setTimeout(function () {
          row.removeAttribute('data-quote-flash');
        }, FLASH_MS);
      }
    }

    /**
     * 向宿主注册引用 source（若 inputTriggers 服务缺失则跳过，写入路径自动降级纯文本）。
     * @param ctx 客户端 root context。
     * @returns 是否注册成功。
     */
    function registerReferenceSource(ctx) {
      var inputTriggers = ctx && typeof ctx.get === 'function' ? ctx.get('inputTriggers') : null;
      if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') {
        referenceSourceRegistered = false;
        return false;
      }
      ctx.effect(function () {
        referenceSourceRegistered = true;
        var off = inputTriggers.registerSource(buildReferenceSource());
        return function () {
          referenceSourceRegistered = false;
          if (typeof off === 'function') off();
        };
      }, 'quote-to-chat: quote-ref source');
      return true;
    }

    // ======================================================================
    // 十、生命周期
    // ======================================================================

    function install() {
      if (installed) return;
      installed = true;
      config = readConfig();
      installStyle();
      buildBar();
      attachListeners();
      exposeApi();
    }

    function dispose() {
      if (!installed) return;
      installed = false;
      detachListeners();
      if (barEl) {
        barEl.removeEventListener('click', onBarClick);
        if (barEl.parentNode) barEl.remove();
      }
      barEl = null;
      flashEl = null;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      if (sideChatPoll) { clearTimeout(sideChatPoll); sideChatPoll = null; }
      if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      state.snapshot = null;
      removeStyle();
      if (window[GLOBAL_KEY] && window[GLOBAL_KEY].__installed) delete window[GLOBAL_KEY];
    }

    function debugState() {
      var live = liveInstances();
      return {
        open: !!(barEl && barEl.getAttribute('data-open') === '1'),
        text: state.snapshot ? state.snapshot.text : null,
        turn: state.snapshot ? state.snapshot.meta.turn : null,
        instances: live.length,
        hasActions: live.some(function (instance) { return !!instance.inputActions; }),
        sideChat: !!sideService(),
        config: { enabled: config.enabled, format: config.format, referenceMode: config.referenceMode, attribution: config.attribution, minChars: config.minChars },
        chip: {
          sourceRegistered: referenceSourceRegistered,
          last: lastChipDiag
        }
      };
    }

    /** 调试/自动化句柄；也给 CDP 验证脚本一条不依赖真实选区的路径。 */
    function exposeApi() {
      var api = {
        __installed: true,
        version: VERSION,
        config: function () { return debugState().config; },
        setConfig: function (patch) { return writeConfig(patch); },
        state: debugState,
        /**
         * 一次性诊断 chip 管线（真机排查用）：不改变任何状态，只报告每个环节的可达性。
         * 在 DevTools 里执行 JSON.stringify(window.__dshQuoteSideChat.probe(), null, 2)。
         * @returns 各环节诊断。
         */
        probe: function () {
          var services = {};
          ['inputTriggers', 'conversation', 'sessions'].forEach(function (name) {
            var value = null;
            var threw = null;
            try { value = rootContext && rootContext.get ? rootContext.get(name) : null; } catch (err) { threw = String(err && err.message || err); }
            services[name] = { present: !!value, threw: threw, shape: value ? Object.keys(value).slice(0, 12) : null };
          });
          var live = liveInstances();
          var inst = live[0] || null;
          var sessionId = inst ? sessionIdOf(inst.anchor) : null;
          var shell = sessionId ? inputShellOf(sessionId) : null;
          // 每个活着的桥实例（一个会话一份）及其会话身份与 inputActions 状态。
          var bridges = live.map(function (item) {
            var sid = sessionIdOf(item.anchor);
            return {
              sessionId: sid,
              hasInputActions: !!item.inputActions,
              inRightSidebar: !!(item.anchor && typeof item.anchor.closest === 'function' && item.anchor.closest(RIGHTBAR_SLOT))
            };
          });
          // 侧边对话 composer 的真实形态：textarea（可设 value）还是 contenteditable（Lexical）。
          var sideComposer = null;
          var sideList = [];
          var areas = document.querySelectorAll('textarea');
          for (var i = 0; i < areas.length; i += 1) {
            if (!isSideChatComposer(areas[i])) continue;
            sideList.push({ tag: 'TEXTAREA', value: (areas[i].value || '').slice(0, 40) });
          }
          var eds = document.querySelectorAll(EDITOR_SELECTOR);
          for (var j = 0; j < eds.length; j += 1) {
            if (typeof eds[j].closest === 'function' && eds[j].closest(RIGHTBAR_SLOT)) {
              sideList.push({ tag: 'CONTENTEDITABLE', text: (eds[j].textContent || '').slice(0, 40) });
            }
          }
          sideComposer = sideList;
          return {
            config: debugState().config,
            sourceRegistered: referenceSourceRegistered,
            services: services,
            instances: live.length,
            bridges: bridges,
            sideComposer: sideComposer,
            hasInputActions: !!(inst && inst.inputActions),
            sessionId: sessionId,
            shellResolved: !!shell,
            shellHasInsertReference: !!(shell && typeof shell.insertReference === 'function'),
            lastChip: lastChipDiag
          };
        },
        show: function () { evaluate(); },
        hide: hideBar,
        instances: function () { return liveInstances().length; },
        /**
         * 绕过选区直接把文本写进当前会话草稿（自动化/排查用）。
         * @param text - 原文，按当前配置转成引用块。
         * @returns 是否写入成功。
         */
        insert: function (text) {
          var instance = liveInstances()[0];
          if (!instance || !instance.inputActions) return false;
          var payload = buildPayload(text, config, { isCode: false, lang: '', turn: null });
          if (!payload) return false;
          var span = instance.inputActions.captureInsertion();
          return instance.inputActions.insertText(payload, span) === true;
        },
        /** 侧边对话现状（真机验证与排查用）。 */
        sideChat: function () {
          var all = sideChatSnapshotNow();
          var composers = [];
          for (var i = 0; i < all.length; i += 1) if (isSideChatComposer(all[i])) composers.push(all[i]);
          return {
            available: !!sideService(),
            composers: composers.length,
            drafts: composers.map(function (el) { return el.value || ''; })
          };
        },
        __internals: {
          normalizeText: normalizeText,
          extractText: extractText,
          buildPayload: buildPayload,
          placeBar: placeBar,
          shouldShow: shouldShow,
          parseTurn: parseTurn,
          bindInstance: bindInstance,
          liveInstances: liveInstances,
          pickInstance: pickInstance,
          readSelection: readSelection,
          evaluate: evaluate,
          install: install,
          dispose: dispose
        }
      };
      window[GLOBAL_KEY] = api;
    }

    /**
     * 装载浏览器侧行为：注入样式、建工具条、装监听、注册会话桥。
     * @param ctx 客户端 root context（`inject: ['slots']` 保证 ctx.slots 存在）。
     */
    function apply(ctx) {
      rootContext = ctx || null;
      install();
      registerReferenceSource(ctx);
      ctx.effect(function () { return dispose; }, 'quote-to-chat: toolbar, listeners, session bridge');
      ctx.slots.inject(SLOT_OVERLAY, function () {
        return ctx.slots.register(
          { name: SLOT_OVERLAY, id: PKG + ':bridge', order: 40 },
          OverlayBridge
        );
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];

    exports.__internals = {
      PKG: PKG,
      VERSION: VERSION,
      MARK: MARK,
      STYLE_TAG_ID: STYLE_TAG_ID,
      GLOBAL_KEY: GLOBAL_KEY,
      STORAGE_KEY: STORAGE_KEY,
      SLOT_OVERLAY: SLOT_OVERLAY,
      TRANSCRIPT_SLOT: TRANSCRIPT_SLOT,
      SESSION_ATTR: SESSION_ATTR,
      RIGHTBAR_SLOT: RIGHTBAR_SLOT,
      SIDE_TAB_TYPE: SIDE_TAB_TYPE,
      SIDE_SERVICE: SIDE_SERVICE,
      SIDE_WAIT_MS: SIDE_WAIT_MS,
      SIDE_POLL_MS: SIDE_POLL_MS,
      DEFAULT_CONFIG: DEFAULTS,
      CSS: CSS,
      OverlayBridge: OverlayBridge,
      normalizeText: normalizeText,
      extractText: extractText,
      quoteBody: quoteBody,
      buildPayload: buildPayload,
      buildSidePayload: buildSidePayload,
      encodeRef: encodeRef,
      decodeRef: decodeRef,
      decodeRefPayload: decodeRefPayload,
      flashOriginal: flashOriginal,
      placeBar: placeBar,
      shouldShow: shouldShow,
      rectsInViewport: rectsInViewport,
      parseTurn: parseTurn,
      commonContainer: commonContainer,
      bindInstance: bindInstance,
      liveInstances: liveInstances,
      pickInstance: pickInstance,
      readSelection: readSelection,
      evaluate: evaluate,
      addToConversation: addToConversation,
      openSideChat: openSideChat,
      waitForSideChat: waitForSideChat,
      commitSideQuote: commitSideQuote,
      findSideChatComposer: findSideChatComposer,
      isSideChatComposer: isSideChatComposer,
      isElementVisible: isElementVisible,
      sessionIdOf: sessionIdOf,
      sideService: sideService,
      install: install,
      dispose: dispose,
      debugState: debugState,
      readConfig: readConfig,
      writeConfig: writeConfig
    };

    return module.exports;
  }
});
