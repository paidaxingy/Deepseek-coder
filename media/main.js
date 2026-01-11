(function () {
  const vscode = acquireVsCodeApi();

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const tabs = $$(".tab");
  const panels = {
    chat: $("#tab-chat"),
  };

  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
    panels.chat.classList.toggle("is-active", name === "chat");
  }

  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      showTab(t.dataset.tab);
    })
  );

  // Cursor-like drawer menu
  const drawerEl = $("#drawer");
  const drawerOverlayEl = $("#drawerOverlay");
  const btnMenuEl = $("#btn-menu");
  const btnDrawerCloseEl = $("#btn-drawer-close");
  const btnNavChatEl = $("#btn-nav-chat");

  function setDrawer(open) {
    if (!drawerEl || !drawerOverlayEl) return;
    drawerEl.classList.toggle("hidden", !open);
    drawerOverlayEl.classList.toggle("hidden", !open);
  }

  function setNavActive(which) {
    if (btnNavChatEl) btnNavChatEl.classList.toggle("is-active", which === "chat");
  }

  if (btnMenuEl) btnMenuEl.addEventListener("click", () => setDrawer(true));
  if (btnDrawerCloseEl) btnDrawerCloseEl.addEventListener("click", () => setDrawer(false));
  if (drawerOverlayEl) drawerOverlayEl.addEventListener("click", () => setDrawer(false));

  if (btnNavChatEl) {
    btnNavChatEl.addEventListener("click", () => {
      showTab("chat");
      setNavActive("chat");
      setDrawer(false);
    });
  }
  const toastEl = $("#toast");
  const chatListEl = $("#chatList");
  const chatInputEl = $("#chatInput");
  const chkToolPlanEl = $("#chk-tool-plan");
  const chkReadOnlyEl = $("#chk-readonly");
  const chkDeepThinkEl = $("#chk-deepthink");
  const btnSendChatEl = $("#btn-send-chat");
  const btnCancelEl = $("#btn-cancel");

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    setTimeout(() => (toastEl.hidden = true), 2200);
  }

  function autosizeTextarea(el, maxPx) {
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight || 0, maxPx);
    el.style.height = `${Math.max(h, 64)}px`;
    el.style.overflowY = (el.scrollHeight || 0) > maxPx ? "auto" : "hidden";
  }

  let currentThreadId = "";
  let threads = [];
  let messages = [];
  let webContext = { bootstrapped: false, sentSnippetCount: 0 };
  const pendingStream = Object.create(null); // messageId -> latest text
  const thoughtOpenState = Object.create(null); // messageId -> boolean (用户折叠/展开选择)
  const thoughtAutoFollow = Object.create(null); // messageId -> boolean (是否自动滚动跟随)

  function stripUiArtifacts(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .filter((l) => {
        const t = String(l || "").trim();
        if (!t) return true;
        if (t === "Copy" || t === "Download") return false;
        // DeepSeek 网页端“浏览/检索”系统状态行（不是正文）
        if (/^Read\s+\d+\s+web\s+pages$/i.test(t)) return false;
        return true;
      });
    // Playwright 抓取时有时会出现首行 "text"
    if (lines[0] === "text") lines.shift();
    return lines.join("\n").trim();
  }

  function extractFirstJsonObjectFrom(text, startIdx) {
    const s = String(text || "");
    let i = Math.max(0, startIdx | 0);
    while (i < s.length && s[i] !== "{") i++;
    if (i >= s.length) return "";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(i, j + 1);
      }
    }
    return "";
  }

  function summarizeToolplan(raw) {
    const text = stripUiArtifacts(raw);
    const idx = text.search(/(^|\n)toolplan\b/);
    if (idx === -1 && !/```toolplan\b/.test(text)) return "";
    const fenced = /```toolplan\s*([\s\S]*?)```/m.exec(text);
    const jsonText = fenced ? stripUiArtifacts(fenced[1] || "") : extractFirstJsonObjectFrom(text, idx);
    // 流式阶段经常是“半截 JSON / fence 未闭合”，此时不要抢跑识别成工具计划
    // 让它按普通文本展示，等最终输出完整后再解析
    if (!jsonText) return "";
    try {
      const obj = JSON.parse(jsonText);
      const read = Array.isArray(obj?.read) ? obj.read.filter((x) => typeof x === "string") : [];
      const notes = typeof obj?.notes === "string" ? obj.notes.trim() : "";
      const shown = read.slice(0, 6).join(", ");
      const more = read.length > 6 ? ` ...（共 ${read.length} 个）` : "";
      return `【工具计划】将读取 ${read.length} 个文件${notes ? `；备注：${notes}` : ""}${read.length ? `\n- ${shown}${more}` : ""}`;
    } catch {
      // JSON 尚未完整/有污染：不要显示“解析失败”，避免误导；回退为普通文本
      return "";
    }
  }

  function summarizeToolcall(raw) {
    const text = stripUiArtifacts(raw);
    const idx = text.search(/(^|\n)toolcall\b/);
    if (idx === -1 && !/```toolcall\b/.test(text)) return "";
    const fenced = /```toolcall\s*([\s\S]*?)```/m.exec(text);
    const jsonText = fenced ? stripUiArtifacts(fenced[1] || "") : extractFirstJsonObjectFrom(text, idx);
    // 流式阶段可能是半截 JSON：不要抢跑识别，回退为普通文本
    if (!jsonText) return "";
    try {
      const obj = JSON.parse(jsonText);
      const tool = String(obj?.tool || "");
      const args = obj?.args || {};
      if (tool === "listDir") {
        const p = args.path ?? args.dirPath ?? args.dir ?? ".";
        return `【工具调用】listDir(path=${JSON.stringify(p)})`;
      }
      if (tool === "readFile") {
        const p = args.path ?? args.filePath ?? "";
        return `【工具调用】readFile(path=${JSON.stringify(p)})`;
      }
      if (tool === "searchText") {
        const q = args.query ?? args.q ?? "";
        const g = args.glob ?? args.include;
        return `【工具调用】searchText(query=${JSON.stringify(q)}${g ? `, glob=${JSON.stringify(g)}` : ""})`;
      }
      return `【工具调用】${tool || "(unknown)"}(${JSON.stringify(args)})`;
    } catch {
      // JSON 尚未完整/有污染：回退为普通文本，避免“解析失败”误导
      return "";
    }
  }

  function formatAssistantText(raw) {
    const text = stripUiArtifacts(raw);
    // toolplan/toolcall 这类结构化输出，用“对话摘要”展示，避免像复制粘贴
    const tp = summarizeToolplan(text);
    if (tp) return tp;
    const tc = summarizeToolcall(text);
    if (tc) return tc;
    return text;
  }

  function splitThoughtAndAnswer(raw) {
    const text = stripUiArtifacts(raw);
    if (!text) return null;

    // 1:1 模式：Playwright 若能从网页 DOM 拆出 thinking/answer，会注入稳定标记
    if (text.includes("<<<DS_THINK_BODY>>>") && text.includes("<<<DS_ANSWER>>>")) {
      const getBetween = (src, a, b) => {
        const i = src.indexOf(a);
        if (i === -1) return "";
        const j = src.indexOf(b, i + a.length);
        if (j === -1) return src.slice(i + a.length);
        return src.slice(i + a.length, j);
      };
      const header = getBetween(text, "<<<DS_THINK_HEADER>>>", "<<<DS_THINK_BODY>>>").trim() || "Thinking";
      const thought = getBetween(text, "<<<DS_THINK_BODY>>>", "<<<DS_ANSWER>>>").trim();
      const answer = text.split("<<<DS_ANSWER>>>").slice(1).join("<<<DS_ANSWER>>>").trim();
      return { header, thought, answer, trivial: false, onlyThinking: !!thought && !answer };
    }

    const lines = text.split("\n");
    const isThinkingLine = (l) => {
      const t = String(l || "").trim();
      if (!t) return false;
      return (
        /^Thinking\b/i.test(t) ||
        /^Deep\s*Think(ing)?\b/i.test(t) ||
        /^Thought\b/i.test(t) ||
        /^思考\b/.test(t) ||
        /^推理\b/.test(t)
      );
    };

    const isTrivialThought = (thoughtLines) => {
      const xs = (thoughtLines || []).map((x) => String(x || "").trim()).filter(Boolean);
      if (!xs.length) return true;
      // 这类“Thought for 1 second / Thinking”只是 UI 提示，没有实际推理内容，直接隐藏即可
      if (xs.length <= 2 && xs.every((x) => /^Thinking\b/i.test(x) || /^Thought\b/i.test(x) || /^Deep\s*Think(ing)?\b/i.test(x))) {
        return true;
      }
      return false;
    };

    const isAnswerStarter = (t) => {
      const s = String(t || "").trim();
      if (!s) return false;
      return /^(你好|好的|当然|可以|没问题|下面|先|让我们|总之|结论|答：|我们|当前|这里|首先|接下来)/.test(s);
    };

    const looksLikeThoughtParagraph = (para) => {
      const p = String(para || "").trim();
      if (!p) return false;
      // 结构化输出（diff/toolcall/toolplan/bash）永远不应被当成“思考正文”
      // 否则会出现“diff 在思考里 → 被识别并执行”的误判。
      if (/^```(diff|toolplan|toolcall|bash|sh|shell)\b/i.test(p)) return false;
      if (/^diff --git\b/.test(p)) return false;
      // “思考”段的典型特征：元叙述 + 规划 + 工具/规则/用户引用
      const thoughtHits = (p.match(/(用户|规则|根据|我应该|我需要|计划|工具|上下文|推理|思考|判断|可能|因此|所以我|listDir|readFile|searchText|toolplan|toolcall|bash|diff)/g) || [])
        .length;
      // “回答”段典型特征：直接对用户说话 / 给出步骤 / 结论 / 询问澄清
      const answerHits = (p.match(/(你好|可以|建议|结论|步骤|如下|请你|你可以|你要|需要你|是否|要不要|怎么做|下一步|我可以帮你)/g) || [])
        .length;
      // 过短的段落（例如“Thinking”重复提示）不当作正文
      if (p.length <= 12 && (/^Thinking\b/i.test(p) || /^Thought\b/i.test(p))) return false;
      // 强信号：提到用户/规则/工具 就更像 thought
      if (/(用户|规则|toolplan|toolcall|listDir|readFile|searchText|bash|diff)/.test(p)) return true;
      // 弱信号：thoughtHits 显著大于 answerHits
      return thoughtHits >= 2 && thoughtHits >= answerHits + 1;
    };

    // 特判：DeepSeek 常见输出是开头或中间出现多行 "Thinking/Thought..."（可能重复）
    const firstNonEmpty = lines.findIndex((l) => String(l || "").trim());
    const firstThinking = (() => {
      if (firstNonEmpty >= 0 && isThinkingLine(lines[firstNonEmpty])) return firstNonEmpty;
      for (let i = Math.max(0, firstNonEmpty); i < lines.length; i++) {
        if (isThinkingLine(lines[i])) return i;
      }
      return -1;
    })();

    if (firstThinking >= 0) {
      const thoughtLines = [];
      let i = firstThinking;
      for (; i < lines.length; i++) {
        const t = String(lines[i] || "").trim();
        if (!t) {
          // 遇到空行：如果后面马上是非 thinking 的内容，则认为回答开始
          let j = i + 1;
          while (j < lines.length && !String(lines[j] || "").trim()) j++;
          if (j < lines.length && !isThinkingLine(lines[j])) {
            i = j;
            break;
          }
          continue;
        }
        if (!isThinkingLine(lines[i])) break;
        thoughtLines.push(t);
      }
      // 折叠原理（更贴近网页端）：
      // - “Thinking/Thought...” 是一个 UI 标记，不等于思考正文。
      // - 思考正文通常是“元叙述/规划/规则/工具/用户引用”的段落。
      // - 最终回答是直接对用户输出的正文（不应被折叠进去）。
      //
      // 做法：把后续内容按段落（空行分隔）切开，前面连续“像思考”的段落归入 thought，
      // 遇到第一个“不像思考”的段落开始，剩余都视为 answer。
      const bodyText = lines.slice(i).join("\n").trim();
      const paras = bodyText ? bodyText.split(/\n{2,}/) : [];
      const thoughtParas = [];
      let splitIdx = 0;
      for (; splitIdx < paras.length; splitIdx++) {
        const para = (paras[splitIdx] || "").trim();
        if (!para) continue;
        // 若这一段明显是回答开头，则停止归入 thought
        if (isAnswerStarter(para)) break;
        if (!looksLikeThoughtParagraph(para)) break;
        thoughtParas.push(para);
      }
      const remainingParas = paras.slice(splitIdx).filter((p) => String(p || "").trim());
      const thoughtBody = thoughtParas.join("\n\n").trim();
      const answer = remainingParas.join("\n\n").trim();

      // trivial：只有提示行且没有任何正文
      const trivial = isTrivialThought(thoughtLines) && !thoughtBody && !answer;

      // 如果没有 thoughtBody，但有 answer：说明只有“Thinking 标记 + 正文”，直接当作回答，不渲染折叠
      if (!thoughtBody && answer) {
        return { header: thoughtLines[0] || "Thinking", thought: "", answer, trivial, onlyThinking: false };
      }

      // 只有思考（还没出最终回答）
      const onlyThinking = Boolean(thoughtBody) && !answer;
      const header = thoughtLines[0] || "Thinking";
      const thought = [thoughtLines.join("\n").trim(), thoughtBody].filter(Boolean).join("\n").trim();
      if (thought || answer) return { header, thought, answer, trivial, onlyThinking };
      return null;
    }

    const thoughtHeaderIdx = lines.findIndex((l) => /^Thought for\b/i.test(l.trim()) || /^思考\b/.test(l.trim()));
    if (thoughtHeaderIdx === -1) return null;

    // 找一个“像最终回答”的起始行（启发式）
    let answerStartIdx = (() => {
      for (let i = thoughtHeaderIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;
        if (isAnswerStarter(t)) return i;
      }
      return -1;
    })();

    // 兜底：很多模型会用“空行”分隔思考与回答
    if (answerStartIdx === -1) {
      for (let i = thoughtHeaderIdx + 1; i < lines.length; i++) {
        if (String(lines[i] || "").trim() !== "") continue;
        let j = i + 1;
        while (j < lines.length && !String(lines[j] || "").trim()) j++;
        if (j < lines.length) {
          answerStartIdx = j;
          break;
        }
      }
    }

    if (answerStartIdx === -1) return null;

    const header = lines[thoughtHeaderIdx].trim();
    const thought = lines.slice(thoughtHeaderIdx + 1, answerStartIdx).join("\n").trim();
    const answer = lines.slice(answerStartIdx).join("\n").trim();
    if (!thought || !answer) return null;
    const thoughtLines = thought.split("\n").map((x) => x.trim()).filter(Boolean);
    return { header, thought, answer, trivial: isTrivialThought(thoughtLines), onlyThinking: false };
  }

  function renderAssistantBody(containerEl, raw, messageId) {
    containerEl.innerHTML = "";

    const escapeHtml = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const renderDiffPretty = (text) => {
      const pre = document.createElement("pre");
      pre.className = "msgPre msgPreDiff";
      const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
      const html = lines
        .map((line) => {
          const t = String(line || "");
          let cls = "diffLine";
          if (t.startsWith("+++ ") || t.startsWith("--- ") || t.startsWith("diff --git ") || t.startsWith("index ") || t.startsWith("new file mode") || t.startsWith("deleted file mode") || t.startsWith("rename from") || t.startsWith("rename to") || t.startsWith("similarity index") || t.startsWith("old mode") || t.startsWith("new mode") || t.startsWith("copy from") || t.startsWith("copy to")) {
            cls += " diffMeta";
          } else if (t.startsWith("@@")) {
            cls += " diffHunk";
          } else if (t.startsWith("+") && !t.startsWith("+++")) {
            cls += " diffAdd";
          } else if (t.startsWith("-") && !t.startsWith("---")) {
            cls += " diffDel";
          }
          return `<span class="${cls}">${escapeHtml(t)}</span>`;
        })
        .join("\n");
      pre.innerHTML = html;
      return pre;
    };

    // 先处理 toolplan/toolcall 摘要
    const formatted = formatAssistantText(raw);
    // 若 formatAssistantText 已经变成摘要（toolplan/toolcall），则不做思考折叠
    if (/^【工具(计划|调用)】/.test(formatted)) {
      const pre = document.createElement("pre");
      pre.className = "msgPre";
      pre.textContent = formatted;
      containerEl.appendChild(pre);
      return;
    }

    const parts = splitThoughtAndAnswer(raw);
    if (!parts) {
      const head = String(formatted || "").trimStart();
      if (head.startsWith("diff --git ")) containerEl.appendChild(renderDiffPretty(formatted));
      else {
      const pre = document.createElement("pre");
      pre.className = "msgPre";
      pre.textContent = formatted;
      containerEl.appendChild(pre);
      }
      return;
    }

    // 注意：不再“隐藏 trivial 思考”，否则用户会觉得“有时能折叠有时不行”
    // 但如果根本没有思考正文（只有 Thinking 标记），则不显示折叠框，直接显示回答。
    if (!parts.thought && parts.answer) {
      const head = String(parts.answer || "").trimStart();
      if (head.startsWith("diff --git ")) containerEl.appendChild(renderDiffPretty(parts.answer));
      else {
      const answerPre = document.createElement("pre");
      answerPre.className = "msgPre";
      answerPre.textContent = parts.answer;
      containerEl.appendChild(answerPre);
      }
      return;
    }

    const details = document.createElement("details");
    details.className = "thought";
    const summary = document.createElement("summary");
    summary.textContent = parts.onlyThinking ? `思考中（折叠） · ${parts.header}` : `思考（折叠） · ${parts.header}`;
    const thoughtPre = document.createElement("pre");
    thoughtPre.className = "thoughtPre";
    thoughtPre.textContent = parts.thought;
    details.appendChild(summary);
    details.appendChild(thoughtPre);

    // 行为：思考阶段默认展开；最终回答出现后自动折叠；同时允许用户手动切换
    const key = messageId || "unknown";
    if (parts.onlyThinking) {
      if (thoughtOpenState[key] == null) thoughtOpenState[key] = true; // 默认展开
    } else {
      thoughtOpenState[key] = false; // 最终回答出现后折叠（像网页端）
    }
    details.open = !!thoughtOpenState[key];

    // 思考区滚动跟随：默认跟随（新内容追加时自动滚动到底部）
    if (thoughtAutoFollow[key] == null) thoughtAutoFollow[key] = true;
    const stickToBottom = () => {
      if (!details.open) return;
      if (!thoughtAutoFollow[key]) return;
      try {
        thoughtPre.scrollTop = thoughtPre.scrollHeight;
      } catch {
        // ignore
      }
    };
    // 关键：必须等 DOM append + layout 完成后再滚动，否则 scrollHeight 还没更新，会“看起来不跟随”
    function scheduleStickToBottom() {
      if (!details.open) return;
      if (!thoughtAutoFollow[key]) return;
      try {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            stickToBottom();
          });
        });
      } catch {
    stickToBottom();
      }
    }
    details.addEventListener("toggle", () => {
      thoughtOpenState[key] = !!details.open;
      // 用户手动展开时：若仍处于“自动跟随”，则滚到最新内容
      if (details.open) scheduleStickToBottom();
    });
    thoughtPre.addEventListener("scroll", () => {
      const gap = thoughtPre.scrollHeight - (thoughtPre.scrollTop + thoughtPre.clientHeight);
      // 用户手动往上翻超过阈值就停止自动跟随；回到底部则恢复
      thoughtAutoFollow[key] = gap < 20;
    });

    containerEl.appendChild(details);
    scheduleStickToBottom();
    if (!parts.onlyThinking && parts.answer) {
      const head = String(parts.answer || "").trimStart();
      if (head.startsWith("diff --git ")) containerEl.appendChild(renderDiffPretty(parts.answer));
      else {
      const answerPre = document.createElement("pre");
      answerPre.className = "msgPre";
      answerPre.textContent = parts.answer;
      containerEl.appendChild(answerPre);
    }
  }
  }

  function isUnifiedDiff(text) {
    return /(^|\n)diff --git /.test(text);
  }

  function extractUnifiedDiff(text) {
    const idx = text.search(/(^|\n)diff --git /);
    if (idx === -1) return "";
    return text.slice(idx).trim();
  }

  function getActionableTextFromAssistantRaw(raw) {
    const parts = splitThoughtAndAnswer(raw);
    if (!parts) return stripUiArtifacts(raw);
    // 只从“最终回答区”提取可执行内容，避免思考区误触发 diff/toolcall/toolplan/bash
    return (parts.answer || "").trim();
  }

  function updateMessageInDom(messageId, text) {
    const el = chatListEl.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) return false;
    const body = el.querySelector(".msgBody");
    if (!body) return false;
    const raw = text || "";
    if (el.classList.contains("msg-assistant")) renderAssistantBody(body, raw, messageId);
    else body.textContent = raw;
    chatListEl.scrollTop = chatListEl.scrollHeight;
    return true;
  }

  function extractToolPlan(text) {
    const m = /```toolplan\s*([\s\S]*?)```/m.exec(text || "");
    return m ? (m[1] || "").trim() : "";
  }

  function extractToolCall(text) {
    const m = /```toolcall\s*([\s\S]*?)```/m.exec(text || "");
    return m ? (m[1] || "").trim() : "";
  }

  function extractBash(text) {
    const s = String(text || "");
    // fenced bash/sh/shell
    const m = /```(?:bash|sh|shell)\s*([\s\S]*?)```/m.exec(s);
    if (m && (m[1] || "").trim()) return (m[1] || "").trim();
    // polluted form: "bash\n..."
    const m2 = /(^|\n)\s*bash\s*\n([\s\S]+)$/im.exec(s);
    if (m2 && (m2[2] || "").trim()) return (m2[2] || "").trim();
    return "";
  }

  function renderChat() {
    chatListEl.innerHTML = "";
    for (let idx = 0; idx < (messages || []).length; idx++) {
      const m = messages[idx];
      const item = document.createElement("div");
      item.className = `msg msg-${m.role}`;
      const stableId = m.id || `${m.role || "msg"}_${idx}`;
      item.dataset.messageId = stableId;

      const header = document.createElement("div");
      header.className = "msgHeader";
      header.textContent = m.role === "user" ? "你" : m.role === "assistant" ? "DeepSeek" : "System";

      const body = document.createElement("div");
      body.className = "msgBody";
      const pending = m.id && pendingStream[m.id];
      const raw = pending != null ? pending : m.text;
      if (m.role === "assistant") renderAssistantBody(body, raw, stableId);
      else body.textContent = raw;

      item.appendChild(header);
      item.appendChild(body);

      if (m.role === "assistant") {
        const actionable = getActionableTextFromAssistantRaw(m.text || "");
        const diffText = extractUnifiedDiff(actionable);
        const toolPlanText = extractToolPlan(actionable);
        const toolCallText = extractToolCall(actionable);
        const bashText = extractBash(actionable);
        if (diffText) {
          const actions = document.createElement("div");
          actions.className = "msgActions";
          const btn = document.createElement("button");
          btn.className = "btn btn-secondary";
          btn.textContent = "预览并应用补丁";
          btn.addEventListener("click", () => {
            vscode.postMessage({ type: "applyPatchText", patchText: diffText });
          });
          actions.appendChild(btn);
          item.appendChild(actions);
        }
        if (toolPlanText) {
          const actions = document.createElement("div");
          actions.className = "msgActions";
          const btn = document.createElement("button");
          btn.className = "btn btn-secondary";
          btn.textContent = "确认工具计划：读取文件并继续生成 diff";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            toast("已确认工具计划，开始读取文件并生成 diff…");
            vscode.postMessage({ type: "toolPlanRun", planText: toolPlanText });
          });
          actions.appendChild(btn);
          item.appendChild(actions);
        }
        if (toolCallText) {
          const actions = document.createElement("div");
          actions.className = "msgActions";
          const btn = document.createElement("button");
          btn.className = "btn btn-secondary";
          btn.textContent = "运行工具（本地）并继续";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            toast("开始运行本地工具…");
            vscode.postMessage({ type: "toolCallRun", callText: toolCallText });
          });
          actions.appendChild(btn);
          item.appendChild(actions);
        }
        if (bashText) {
          const actions = document.createElement("div");
          actions.className = "msgActions";
          const btn = document.createElement("button");
          btn.className = "btn btn-secondary";
          btn.textContent = "确认并执行 bash";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            toast("开始执行 bash…");
            vscode.postMessage({ type: "bashRun", bashText });
          });
          actions.appendChild(btn);
          item.appendChild(actions);
        }
      }

      chatListEl.appendChild(item);
    }
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }

  function applyState(payload) {
    threads = payload.threads || [];
    currentThreadId = payload.currentThreadId || "";
    messages = payload.messages || [];
    webContext = payload.webContext || { bootstrapped: false, sentSnippetCount: 0 };
    renderChat();
    // 尝试把之前因“渲染竞态”丢掉的流式更新补上
    for (const id of Object.keys(pendingStream)) {
      updateMessageInDom(id, pendingStream[id]);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === "init" || msg.type === "state") {
      applyState(msg);
      return;
    }
    if (msg.type === "requestState") {
      const busy = !!msg.busy;
      if (btnCancelEl) btnCancelEl.disabled = !busy;
      if (btnSendChatEl) btnSendChatEl.disabled = busy;
      return;
    }
    if (msg.type === "readOnlyState") {
      if (chkReadOnlyEl) chkReadOnlyEl.checked = !!msg.enabled;
      return;
    }
    if (msg.type === "toast") {
      toast(msg.message || "");
      return;
    }
    if (msg.type === "assistantStream") {
      const text = msg.text || "";
      if (msg.messageId) pendingStream[msg.messageId] = text;
      if (updateMessageInDom(msg.messageId, text)) {
        // 不要因为 done 就禁用“停止”：DeepSeek 网页端可能还在继续生成（尤其是 early-stop 场景）
        if (btnSendChatEl && msg.done) btnSendChatEl.disabled = false;
      } else {
        // DOM 还没渲染出这条消息：等下一次 renderChat/applyState 再补写
      }
      return;
    }
    if (msg.type === "error") {
      toast(msg.message || "发生错误");
      return;
    }
  });

  $("#btn-open-playwright").addEventListener("click", () => {
    vscode.postMessage({ type: "openPlaywright" });
  });
  const btnRollbackEl = $("#btn-rollback");
  if (btnRollbackEl) {
    btnRollbackEl.addEventListener("click", () => {
      vscode.postMessage({ type: "rollbackLast" });
  });
  }
  if (chkReadOnlyEl) {
    chkReadOnlyEl.addEventListener("change", () => {
      vscode.postMessage({ type: "setReadOnly", enabled: !!chkReadOnlyEl.checked });
  });
  }
  if (chkDeepThinkEl) {
    chkDeepThinkEl.addEventListener("change", () => {
      vscode.postMessage({ type: "setDeepThink", enabled: !!chkDeepThinkEl.checked });
  });
  }

  btnSendChatEl.addEventListener("click", () => {
    const userText = (chatInputEl.value || "").trim();
    if (!userText) return;
    chatInputEl.value = "";
    autosizeTextarea(chatInputEl, 160);

    const planFirst = chkToolPlanEl ? !!chkToolPlanEl.checked : true;
    if (btnCancelEl) btnCancelEl.disabled = false;
    if (btnSendChatEl) btnSendChatEl.disabled = true;
    const deepThink = chkDeepThinkEl ? !!chkDeepThinkEl.checked : false;
    vscode.postMessage({ type: "chatSend", userText, planFirst, deepThink });
  });

  chatInputEl.addEventListener("keydown", (e) => {
    // Enter 发送；Shift+Enter 换行；输入法合成中不触发
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      btnSendChatEl.click();
      return;
    }
  });

  chatInputEl.addEventListener("input", () => {
    autosizeTextarea(chatInputEl, 160);
  });
  autosizeTextarea(chatInputEl, 160);

  if (btnCancelEl) {
    btnCancelEl.addEventListener("click", () => {
      // 允许多次点击（有些情况下网页端需要多次 stop 才能停住）
      if (btnSendChatEl) btnSendChatEl.disabled = false;
      vscode.postMessage({ type: "chatCancel" });
    });
  }

  vscode.postMessage({ type: "ready" });
})();


