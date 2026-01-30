import * as vscode from "vscode";
import { readWorkspaceTextFile } from "../workspace/readFile";
import { ThreadStore, type ChatMessage, type ContextSnippet, type ThreadSummary, type WebContextMeta } from "../state/threadStore";
import type { DeepSeekPlaywright } from "../deepseek/DeepSeekPlaywright";
import * as path from "path";
import { runToolCall, type ToolCall } from "../workspace/tools";
import { getOrPickWorkspaceRootUri } from "../workspace/workspaceRoot";
import { applyPatchTextDirectly, applyPatchTextWithPreviewAndConfirm } from "../workspace/applyPatch";
import { rollbackLast } from "../workspace/rollback";
import { assessBashRisk, checkBashCommandSafety, extractBashBlock, splitBashCommands, type BashSafetyMode } from "../workspace/bash";
import { extractToolCallJson, normalizeToolCallObject } from "../workspace/toolcall";
import { spawn } from "child_process";
import * as crypto from "crypto";

type WebviewInbound =
  | { type: "ready" }
  | { type: "openExternal"; url: string }
  | { type: "openPlaywright" }
  | { type: "rollbackLast" }
  | { type: "setReadOnly"; enabled: boolean }
  | { type: "setDeepThink"; enabled: boolean }
  | { type: "bashRun"; bashText: string }
  | { type: "chatSend"; userText: string; planFirst?: boolean; deepThink?: boolean }
  | { type: "chatSendRaw"; prompt: string; markContextAsSent?: boolean }
  | { type: "chatCancel" }
  | { type: "openOutput" }
  | { type: "debugClear" }
  | { type: "applyPatchText"; patchText: string }
  | { type: "pickFileAndAddContext" }
  | { type: "clearContext" }
  | { type: "copyPrompt"; prompt: string }
  | { type: "threadCreate"; title?: string }
  | { type: "threadSwitch"; threadId: string }
  | { type: "threadClear"; threadId: string }
  | { type: "threadDelete"; threadId: string }
  | { type: "threadExport"; threadId: string; format: "json" | "markdown" }
  | { type: "toolPlanRun"; planText: string }
  | { type: "toolCallRun"; callText: string };

type WebviewOutbound =
  | {
      type: "init";
      threads: ThreadSummary[];
      currentThreadId: string;
      messages: ChatMessage[];
      snippets: ContextSnippet[];
      webContext: WebContextMeta;
    }
  | {
      type: "state";
      threads: ThreadSummary[];
      currentThreadId: string;
      messages: ChatMessage[];
      snippets: ContextSnippet[];
      webContext: WebContextMeta;
    }
  | { type: "requestState"; busy: boolean }
  | { type: "readOnlyState"; enabled: boolean }
  | { type: "assistantStream"; threadId: string; messageId: string; text: string; done: boolean }
  | { type: "debugInit"; lines: string[] }
  | { type: "debugAppend"; line: string }
  | { type: "error"; message: string };

export class DeepSeekViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "deepseekCoder.sidebarView";

  private readonly WEB_PROMPT_SIGNATURE = "【Deepseek-Coder Prompt v2】";
  // 防卡死：限制写入 webview state 的单段文本长度（messages/snippets 都会进入 state）。
  // 过长的 bash/toolcall/readFile 输出会导致 postMessage 卡顿甚至卡死。
  private readonly MAX_STATE_TEXT_CHARS = 60_000;
  private readonly MAX_STATE_TEXT_HEAD = 30_000;
  private readonly MAX_STATE_TEXT_TAIL = 20_000;
  /**
   * 只保存“提取后的用户意图”（而不是用户粘贴的整段大 prompt/日志），用于自动链继续时避免重复塞入历史内容。
   * 由于 ThreadStore 是单会话内存态，这里也只做内存缓存即可。
   */
  private readonly lastUserIntent: Record<string, string> = Object.create(null);
  private readonly lastUserIntentSig: Record<string, string> = Object.create(null);
  private readonly lastUserIntentTs: Record<string, number> = Object.create(null);

  private _view?: vscode.WebviewView;
  private readonly store: ThreadStore;
  private currentThreadId?: string;
  private active?: { threadId: string; messageId: string; abort: AbortController; lastText: string };
  private activeBash?: { threadId: string; messageId: string; abort: AbortController; kill?: () => void };
  private readonly output = vscode.window.createOutputChannel("Deepseek Coder");
  private readonly debugBuf: string[] = [];
  private readonly DEBUG_MAX = 300;
  private readonly READONLY_KEY = "deepseekCoder.readOnlyMode";
  private readOnlyMode = false;
  private deepThinkMode = false;
  private readonly MOVED_AUX_KEY = "deepseekCoder.movedToAuxSidebarOnce";
  // 兜底：防止真正的无限自动链。不要太小（正常工作流会连续很多步）。
  private readonly MAX_AUTO_CHAIN = 30;
  private readonly autoChainCount: Record<string, number> = Object.create(null);
  // 用户点“停止”后：终止后续自动链（diff->continue / bash->continue / toolcall->continue / toolplan->continue）
  private readonly autoChainPaused: Record<string, boolean> = Object.create(null);
  // 死循环判定：连续重复的“同一种动作签名”达到阈值才暂停
  private readonly REPEAT_LIMIT = 3;
  private readonly lastRepeatSig: Record<string, string> = Object.create(null);
  private readonly repeatCount: Record<string, number> = Object.create(null);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deepseek: DeepSeekPlaywright
  ) {
    this.store = new ThreadStore(context);
    this.readOnlyMode = this.context.workspaceState.get<boolean>(this.READONLY_KEY) ?? false;
    this.deepThinkMode = false;
  }

  private withSignature(body: string): string {
    const s = (body || "").trim();
    if (!s) return this.WEB_PROMPT_SIGNATURE;
    if (s.startsWith(this.WEB_PROMPT_SIGNATURE)) return s;
    return [this.WEB_PROMPT_SIGNATURE, "", s].join("\n");
  }

  private resetUserIntentCache(threadId: string) {
    delete this.lastUserIntent[threadId];
    delete this.lastUserIntentSig[threadId];
    delete this.lastUserIntentTs[threadId];
  }

  private hashTextShort(s: string): string {
    try {
      return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
    } catch {
      // fallback：不依赖 crypto 的极简 hash
      const str = String(s || "");
      let h = 0;
      for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
      return String(h >>> 0);
    }
  }

  private normalizeUserText(s: string): string {
    return String(s || "").replace(/\r\n/g, "\n").trim();
  }

  private truncateForState(text: string, title: string): string {
    const s = String(text ?? "");
    const n = s.length;
    if (n <= this.MAX_STATE_TEXT_CHARS) return s;
    const head = s.slice(0, Math.max(0, this.MAX_STATE_TEXT_HEAD));
    const tail = s.slice(Math.max(0, n - this.MAX_STATE_TEXT_TAIL));
    const note = [
      `[已截断：${title}]`,
      `原始长度：${n} chars`,
      `已保留：head ${head.length} + tail ${tail.length}`,
      "完整输出已写入「Deepseek Coder」输出面板。"
    ].join("\n");
    return [note, "", head, "", "…（中间内容已省略）…", "", tail].join("\n");
  }

  private writeLargeToOutput(title: string, text: string) {
    try {
      const s = String(text ?? "");
      const n = s.length;
      if (!s) return;
      // OutputChannel 可承受较大输出；这里做个简单分隔，方便检索。
      this.output.appendLine(`[${new Date().toISOString()}] ${title} (${n} chars)`);
      this.output.appendLine(s);
      this.output.appendLine("");
    } catch {
      // ignore
    }
  }

  /**
   * 目标：把用户“重复粘贴的 Prompt v2 + 日志 + 系统说明”压缩成“本次真正要解决的新增问题/报错”。
   * 这样自动链 continue/retry 时不会反复把历史内容塞回 prompt，避免 DeepSeek 每步都重新分析同一大段。
   */
  private extractUserIntent(rawText: string): string {
    const raw = this.normalizeUserText(rawText);
    if (!raw) return "";

    let s = raw;

    // 如果用户把整段 web prompt 粘贴进来了：只从最后一次签名后开始取（避免重复段落）
    const sigIdx = s.lastIndexOf(this.WEB_PROMPT_SIGNATURE);
    if (sigIdx >= 0) {
      s = s.slice(sigIdx + this.WEB_PROMPT_SIGNATURE.length).trim();
    }

    // 优先取最后一段“用户需求”块（Prompt v2 通常用这个标题）
    try {
      const reNeed = /^#?\s*用户需求\b.*$/gim;
      let last: RegExpExecArray | null = null;
      let m: RegExpExecArray | null;
      while ((m = reNeed.exec(s))) last = m;
      if (last) {
        const lineEnd = s.indexOf("\n", last.index);
        s = (lineEnd === -1 ? "" : s.slice(lineEnd + 1)).trim();
      }
    } catch {
      // ignore
    }

    // 若仍包含“你的任务/补丁已应用”等系统性说明：截断，只保留用户这次要做的事
    const cutMarkers = [
      /^#\s*你的任务\b/m,
      /^#\s*补丁已应用\b/m,
      /^【选择规则】/m,
      /^#\s*强制指令\b/m
    ];
    for (const re of cutMarkers) {
      const mm = re.exec(s);
      if (mm && mm.index >= 0) {
        s = s.slice(0, mm.index).trim();
      }
    }

    // 兜底：如果用户只贴了“补丁已应用/系统提示”，保证至少有点内容
    if (!s) s = raw;

    // 过长时只保留尾部（通常尾部才是最新报错）
    const MAX = 8000;
    if (s.length > MAX) s = s.slice(s.length - MAX);

    s = s.replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }

  private isLikelyPastedWebPrompt(rawText: string): boolean {
    const s = String(rawText || "");
    if (!s) return false;
    return s.includes(this.WEB_PROMPT_SIGNATURE) || /#\s*续写规则\b/i.test(s);
  }

  private async getLastUserIntent(threadId: string): Promise<string> {
    const cached = this.lastUserIntent[threadId];
    if (cached) return cached;
    const t = await this.store.getThread(threadId);
    const lastRaw = t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
    const intent = this.extractUserIntent(lastRaw);
    this.lastUserIntent[threadId] = intent;
    this.lastUserIntentSig[threadId] = this.hashTextShort(intent);
    this.lastUserIntentTs[threadId] = Date.now();
    return intent;
  }

  private formatSnippetBlock(snippets: ContextSnippet[]): string {
    const parts: string[] = [];
    for (const s of snippets) {
      parts.push(`\n---\n# ${s.title}\n\n${s.content}\n`);
    }
    return parts.join("\n");
  }

  private buildDeltaToolingPrompt(
    pendingSnippets: ContextSnippet[],
    userText: string,
    mode: "toolplan" | "patch",
    extraSection?: string
  ): string {
    const parts: string[] = [];
    parts.push(this.WEB_PROMPT_SIGNATURE);
    const shouldIncludeRules = pendingSnippets.length > 0 || mode === "toolplan" || Boolean(extraSection?.trim());
    if (shouldIncludeRules) {
      parts.push(
        [
          "# 续写规则（简版）",
          "- 网页对话自带上下文：不要重复输出我发过的提示词/上下文内容",
          "- 你正在用户的 VSCode 工作区环境中协作：用户说“补全/完善/修复/实现/生成代码”，通常意味着需要先读取工作区文件，再输出 unified diff 来创建/修改文件",
          "- 你的输出只能是以下五种之一：toolplan / toolcall / unified diff / bash / 最终回答",
          "- 当你选择输出 toolplan/toolcall/diff/bash 时：整个回复必须**只有一个**对应的 markdown 代码块（代码块外绝对不要任何文字）；diff 必须放进 ```diff 代码块且以 diff --git 开头",
          "- 允许使用 DeepSeek 网页端的联网能力（搜索/阅读网页）。注意：网页端可能显示 `Read N web pages`/`Search` 等系统状态行，请忽略，不要把它们当正文复述；把检索到的信息融入最终输出。",
          "- toolcall 路径必须是工作区相对路径（禁止 / 开头）；searchText.query 必须非空",
          "- 重要：生成/修改源代码文件时，文件内容里禁止出现 ``` markdown fence；也不要输出 `\\ No newline at end of file`；所有文件以换行符结尾（末尾必须有 \\n）",
          "- bash 尽量简单：允许 &&/||；避免管道 |、命令替换 $() 等高风险语法",
          "- 当你确认已完成任务且不需要任何工具/补丁：输出“最终回答”（纯中文总结，不要任何代码块）",
          "- 只有当用户明确要求本地操作（读文件/查找/改代码/执行命令），或你的回答必须依赖本地信息时，才使用 toolplan/toolcall/diff/bash；否则请直接“最终回答”。",
        ].join("\n")
      );
    }
    if (pendingSnippets.length) {
      parts.push("# 新增上下文（增量）");
      parts.push(this.formatSnippetBlock(pendingSnippets));
    }
    parts.push(["# 用户需求", userText].join("\n"));
    if (extraSection?.trim()) {
      parts.push(extraSection.trim());
    }
    if (mode === "toolplan") {
      parts.push(
        [
          "---",
          "# 强制指令",
          "现在你必须输出 toolplan 格式（只输出一个 ```toolplan``` 代码块，代码块内为 JSON，含 read 数组与 notes 字符串；代码块外无任何文字）。",
          "输出完 toolplan 代码块立刻停止。",
          "重要：toolplan 只是“读取清单/说明”，扩展会自动执行读取并把结果追加到上下文，然后会在同一对话中继续让你输出下一步（通常是 diff/bash/最终回答）。这一步不要输出 bash/diff/toolcall。",
        ].join("\n")
      );
    }
    return parts.join("\n\n");
  }

  private async buildToolingPromptForThread(
    threadId: string,
    userText: string,
    mode: "toolplan" | "patch",
    extraSection?: string
  ): Promise<{ prompt: string; after: WebContextMeta }> {
    const thread = await this.store.getThread(threadId);
    const snippets = thread?.snippets ?? [];
    const webContext = await this.store.getWebContext(threadId);

    const sent = Math.max(0, Math.min(webContext.sentSnippetCount, snippets.length));
    const pending = snippets.slice(sent);

    const base =
      !webContext.bootstrapped
        ? mode === "toolplan"
          ? this.buildToolPlanPrompt(pending, userText)
          : this.buildPatchPrompt(pending, userText)
        : this.buildDeltaToolingPrompt(pending, userText, mode, extraSection);

    const prompt = this.withSignature(base);
    const after: WebContextMeta = { bootstrapped: true, sentSnippetCount: snippets.length };
    return { prompt, after };
  }

  async addContextSnippet(snippet: { title: string; content: string }) {
    const tid = await this.ensureThread();
    await this.store.addSnippet(tid, snippet.title, snippet.content);
    await this.pushState();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    view.webview.html = this._getHtml(view.webview);

    // 尝试把视图默认移动到“辅助侧边栏/Secondary Side Bar”（只做一次，避免每次都打扰用户布局）
    // 注意：不同 VS Code 版本命令可能不存在；失败则忽略。
    void (async () => {
      // 兼容旧版本：曾经把它写成 boolean=true（即使实际没移动成功）
      // 新版本用 "success" / "failed"：只有 success 才会跳过后续尝试。
      const movedState = this.context.globalState.get<unknown>(this.MOVED_AUX_KEY);
      const movedOk = movedState === "success";
      if (movedOk) return;
      try {
        this.debug("info", "aux sidebar auto-move: start", { movedState });
        const cmds = await vscode.commands.getCommands(true);
        const has = (c: string) => cmds.includes(c);
        const tryCmd = async (c: string) => {
          if (!has(c)) return false;
          try {
            await vscode.commands.executeCommand(c);
            return true;
          } catch {
            return false;
          }
        };

        // 不同版本的 VS Code 命令名可能不同：按候选依次尝试
        const moveCandidates = [
          "workbench.action.moveViewToSecondarySideBar",
          "workbench.action.moveFocusedViewToSecondarySideBar",
          "workbench.action.moveViewToAuxiliaryBar",
          "workbench.action.moveFocusedViewToAuxiliaryBar",
          "workbench.action.moveViewContainerToSecondarySideBar",
          "workbench.action.moveFocusedViewContainerToSecondarySideBar",
          "workbench.action.moveViewContainerToAuxiliaryBar",
          "workbench.action.moveFocusedViewContainerToAuxiliaryBar"
        ];

        // 若当前版本根本没有任何 move-to-aux 命令，就不要去打开/聚焦辅助侧边栏（避免误打开 Cursor 自带聊天面板）
        const hasAnyMoveCmd = moveCandidates.some(has);
        if (!hasAnyMoveCmd) {
          await this.context.globalState.update(this.MOVED_AUX_KEY, "failed");
          this.debug("warn", "no move-to-auxiliary-sidebar command available; leaving layout unchanged", {
            found: cmds.filter((c) => /auxiliary|secondarySideBar|moveView/i.test(c)).slice(0, 40)
          });
          return;
        }

        // 先确保 view 获得焦点（部分 move* 命令依赖当前焦点 view）
        view.show?.(true);
        await new Promise((r) => setTimeout(r, 120));
        let ok = false;
        for (const c of moveCandidates) {
          if (await tryCmd(c)) {
            ok = true;
            this.debug("info", "moved view to auxiliary sidebar (candidate)", { cmd: c });
            break;
          }
        }

        if (ok) {
          await this.context.globalState.update(this.MOVED_AUX_KEY, "success");
        } else {
          await this.context.globalState.update(this.MOVED_AUX_KEY, "failed");
          this.debug("warn", "no move-to-auxiliary-sidebar command available; leaving layout unchanged", {
            found: cmds.filter((c) => /auxiliary|secondarySideBar|moveView/i.test(c)).slice(0, 40)
          });
        }
      } catch (e) {
        this.debug("warn", "move to auxiliary sidebar failed (ignored)", { error: e instanceof Error ? e.message : String(e) });
      }
    })();

    view.webview.onDidReceiveMessage(async (msg: WebviewInbound) => {
      try {
        switch (msg.type) {
          case "ready":
            await this.ensureFreshThreadOnEnter();
            await this.pushInit();
            this._post({ type: "debugInit", lines: this.debugBuf.slice() });
            await this.maybeAutoOpenPlaywright();
            this.setBusy(false);
            this._post({ type: "readOnlyState", enabled: this.readOnlyMode });
            return;
          case "openExternal":
            await vscode.env.openExternal(vscode.Uri.parse(msg.url));
            return;
          case "openPlaywright":
            // 精简模式：不通过命令面板暴露 Playwright 命令；这里直接调用
            try {
              await this.deepseek.openAndLetUserLogin();
              await this.notify("✅ 已打开 DeepSeek（Playwright）。请在弹出的浏览器窗口里自行登录。");
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const missingBrowser =
                /Executable doesn't exist/i.test(msg) ||
                /playwright install/i.test(msg) ||
                /Looks like Playwright was just installed/i.test(msg);
              const missingLib = /error while loading shared libraries:\s*([^\s:]+):/i.exec(msg)?.[1];
              if (missingBrowser) {
                const pick = await vscode.window.showWarningMessage(
                  [
                    "Playwright Chromium 未安装或不可用。",
                    "首次使用需要下载浏览器二进制（联网）。",
                    "",
                    "要现在安装吗？"
                  ].join("\n"),
                  { modal: true },
                  "安装 Chromium"
                );
                if (pick) {
                  await vscode.commands.executeCommand("deepseekCoder.installPlaywrightChromium");
                }
                await this.notify(
                  [
                    "⚠️ Playwright Chromium 未就绪。",
                    "",
                    "你可以运行命令：",
                    "Deepseek Coder: 安装 Playwright Chromium（首次使用）",
                    "",
                    `原始错误：${msg}`
                  ].join("\n")
                );
              } else if (missingLib) {
                await this.notify(
                  [
                    `❌ Playwright 打开失败：缺少系统依赖库 ${missingLib}`,
                    "",
                    "这通常是系统缺少 Chromium 运行依赖（Linux/WSL 常见）。",
                    "请按你的发行版安装缺失库（可能需要 sudo）。",
                    "",
                    "常见（Debian/Ubuntu）示例：",
                    "sudo apt-get update && sudo apt-get install -y libnspr4 libnss3"
                  ].join("\n")
                );
              } else {
                await this.notify(
                  [
                    `❌ Playwright 打开失败：${msg}`,
                    "",
                    "可尝试先运行命令安装浏览器：",
                    "Deepseek Coder: 安装 Playwright Chromium（首次使用）"
                  ].join("\n")
                );
              }
            }
            return;
          case "rollbackLast": {
            const r = await rollbackLast();
            await this.notifyInChat(await this.ensureThread(), r.ok ? `↩️ ${r.message}` : `⚠️ ${r.message}`);
            return;
          }
          case "setReadOnly": {
            await this.setReadOnly(!!msg.enabled);
            await this.notifyInChat(
              await this.ensureThread(),
              this.readOnlyMode ? "🔒 已开启只读模式：不自动应用 diff / 不自动执行 bash。" : "✅ 已关闭只读模式：允许自动应用 diff / 自动执行 bash。"
            );
            return;
          }
          case "setDeepThink": {
            this.deepThinkMode = !!msg.enabled;
            this.debug("info", "setDeepThink", { enabled: this.deepThinkMode });
            await this.notifyInChat(await this.ensureThread(), `DeepThink：${this.deepThinkMode ? "开启" : "关闭"}`);
            try {
              await this.deepseek.setDeepThink(this.deepThinkMode, (e) => this.debug(e.level, e.msg, e.data));
            } catch (e) {
              this.debug("warn", "setDeepThink failed (ignored)", { error: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
          case "bashRun": {
            const tid = await this.ensureThread();
            if (await this.rejectIfBusy("执行 bash", tid)) return;
            const bashText = String(msg.bashText || "").trim();
            if (!bashText) return;
            // 用户点击按钮视为“确认执行”，即便只读模式也允许执行这一条
            await this.notifyInChat(tid, "▶️ 已确认：开始执行 bash…");
            try {
              await this.autoExecuteBash(tid, bashText, { bypassReadOnly: true });
            } catch (e) {
              await this.notifyInChat(tid, `❌ bash 执行失败：${e instanceof Error ? e.message : String(e)}`);
            }
            return;
          }
          case "chatSend": {
            const tid = await this.ensureThread();
            this.resetAutoChain(tid);
            const userTextRaw = msg.userText?.trim() || "";
            if (!userTextRaw) return;
            this.deepThinkMode = !!msg.deepThink;
            // busy 时不自动中断：避免“操作快就自己中断”
            if (await this.rejectIfBusy("发送消息", tid)) return;

            const intent = this.extractUserIntent(userTextRaw);
            if (!intent) return;

            // 同线程去重：当用户反复粘贴同一段 Prompt v2/日志时，直接忽略以避免模型反复分析历史内容
            const intentSig = this.hashTextShort(intent);
            const lastSig = this.lastUserIntentSig[tid];
            const lastTs = this.lastUserIntentTs[tid] ?? 0;
            if (this.isLikelyPastedWebPrompt(userTextRaw) && lastSig === intentSig && Date.now() - lastTs < 5 * 60 * 1000) {
              await this.store.addMessage(
                tid,
                "system",
                "⏭️ 检测到重复的用户需求（已忽略）：为避免 DeepSeek 反复分析同一段粘贴的历史内容。\n如需强制重发，请在末尾添加任意新字符。"
              );
              await this.pushState();
              return;
            }

            // UI 里仍保留用户原始输入（便于回看），但后续 prompt/自动链都只使用 intent
            await this.store.addMessage(tid, "user", userTextRaw);
            this.lastUserIntent[tid] = intent;
            this.lastUserIntentSig[tid] = intentSig;
            this.lastUserIntentTs[tid] = Date.now();
            await this.pushState();
            // 统一策略：去掉“做项目/介绍项目/查环境”等特殊判断，永远走同一套 tooling prompt。
            // 让模型在 toolplan/toolcall/diff/bash/最终回答 中自选。
            // toolplan 的“强制指令”只在确实需要本地信息时启用，
            // 否则像“你好/今天星期几”这类会被误导强制输出 toolplan。
            const needLocal = this.shouldAutoExecuteForUserText(intent);
            const mode: "toolplan" | "patch" = needLocal && (msg.planFirst ?? false) ? "toolplan" : "patch";
            const tooling = await this.buildToolingPromptForThread(tid, intent, mode);
            const prompt = tooling.prompt;
            const afterWebContext = tooling.after;

            const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            await this.store.addMessage(tid, "assistant", "", assistantId);
            await this.pushState();

            const abort = new AbortController();
            this.active = { threadId: tid, messageId: assistantId, abort, lastText: "" };
            this.debug("info", "send start", { threadId: tid, assistantId, planFirst: (msg.planFirst ?? true) });

            try {
              this.setBusy(true);
              const r = await this.deepseek.sendStreamingWithDebug(
                prompt,
                async (u) => {
                  if (!this.active || this.active.threadId !== tid || this.active.messageId !== assistantId) return;
                  this.active.lastText = u.text;
                  this._post({ type: "assistantStream", threadId: tid, messageId: assistantId, text: u.text, done: u.done });
                },
                {
                  signal: abort.signal,
                  debug: (e) => this.debug(e.level, e.msg, e.data),
                  deepThink: this.deepThinkMode
                }
              );

              const finalText = r.assistantText;

              this.debug("info", "send done", { assistantChars: finalText.length });
              // 不再做 nonToolRetry：是否需要工具/补丁由模型自行判断（通过输出 toolplan/toolcall/diff/bash 来表达）
              const finalOut = finalText;

              await this.store.updateMessageText(tid, assistantId, finalOut);
              if (afterWebContext) {
                await this.store.updateWebContext(tid, afterWebContext);
              }
              await this.pushState();
              
              // 自动执行：不再基于 userText 猜测是否需要工具；由模型输出决定（非 toolplan/toolcall/diff/bash 将不会触发任何动作）
              try {
                await this.autoProcessReply(tid, finalOut, 0, intent);
              } catch (e) {
                this.debug("error", "autoProcessReply failed (ignored)", { error: e instanceof Error ? e.message : String(e) });
              }
            } catch (e) {
              const last = this.active?.lastText || "";
              const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
              this.debug("error", "send failed", { error: e instanceof Error ? e.message : String(e) });
              await this.store.updateMessageText(tid, assistantId, msgText);
              await this.pushState();
            } finally {
              if (this.active?.threadId === tid && this.active?.messageId === assistantId) {
                this.active = undefined;
              }
              this.setBusy(false);
            }
            return;
          }
          case "chatSendRaw": {
            const tid = await this.ensureThread();
            this.resetAutoChain(tid);
            const prompt = msg.prompt?.trim() || "";
            if (!prompt) return;
            if (await this.rejectIfBusy("发送 Raw Prompt", tid)) return;

            await this.store.addMessage(tid, "user", prompt);
            await this.pushState();

            const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            await this.store.addMessage(tid, "assistant", "", assistantId);
            await this.pushState();

            const abort = new AbortController();
            this.active = { threadId: tid, messageId: assistantId, abort, lastText: "" };
            this.debug("info", "raw send start", { threadId: tid, assistantId, promptChars: prompt.length });

            try {
              this.setBusy(true);
              const r = await this.deepseek.sendStreamingWithDebug(
                prompt,
                async (u) => {
                  if (!this.active || this.active.threadId !== tid || this.active.messageId !== assistantId) return;
                  this.active.lastText = u.text;
                  this._post({ type: "assistantStream", threadId: tid, messageId: assistantId, text: u.text, done: u.done });
                },
                {
                  signal: abort.signal,
                  debug: (e) => this.debug(e.level, e.msg, e.data),
                  deepThink: this.deepThinkMode
                }
              );
              await this.store.updateMessageText(tid, assistantId, r.assistantText);
              await this.pushState();

              // 如果该 raw prompt 明确表示“这是我们生成的上下文提示词”，则把进度标记为已发送
              if (msg.markContextAsSent) {
                const thread = await this.store.getThread(tid);
                const snippets = thread?.snippets ?? [];
                await this.store.updateWebContext(tid, { bootstrapped: true, sentSnippetCount: snippets.length });
                await this.pushState();
              }
            } catch (e) {
              const last = this.active?.lastText || "";
              const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
              this.debug("error", "raw send failed", { error: e instanceof Error ? e.message : String(e) });
              await this.store.updateMessageText(tid, assistantId, msgText);
              await this.pushState();
            } finally {
              if (this.active?.threadId === tid && this.active?.messageId === assistantId) {
                this.active = undefined;
              }
              this.setBusy(false);
            }
            return;
          }
          case "chatCancel": {
            this.debug("warn", "user cancel");
            // 终止后续自动链（避免 diff->continue/toolcall->continue 继续跑）
            const tid = this.active?.threadId ?? this.activeBash?.threadId;
            if (tid) this.pauseAutoChain(tid);
            this.active?.abort.abort();
            // 终止正在执行的 bash（如果有）
            if (this.activeBash) {
              try {
                this.activeBash.abort.abort();
                this.activeBash.kill?.();
              } catch {
                // ignore
              }
              try {
                await this.store.updateMessageText(
                  this.activeBash.threadId,
                  this.activeBash.messageId,
                  ["[bash 已停止]", "", "用户手动停止了正在执行的 bash。"].join("\n")
                );
                await this.pushState();
              } catch {
                // ignore
              } finally {
                this.activeBash = undefined;
              }
            }
            try {
              await this.deepseek.stopGenerating((e) => this.debug(e.level, `stopGenerating: ${e.msg}`, e.data));
            } catch {
              // ignore
            }
            // 不用 VSCode 弹窗，直接在对话里提示
            if (tid) await this.notifyInChat(tid, "⏹️ 已停止：终止自动链，并尝试停止网页端生成/本地 bash。");
            this.setBusy(false);
            return;
          }
          case "openOutput": {
            this.output.show(true);
            return;
          }
          case "debugClear": {
            this.debugBuf.splice(0, this.debugBuf.length);
            this.output.clear();
            this._post({ type: "debugInit", lines: [] });
            return;
          }
          case "applyPatchText":
            if (await this.rejectIfBusy("应用补丁")) return;
            // 精简模式：不暴露 applyPatchText 命令；直接预览并确认
            await applyPatchTextWithPreviewAndConfirm(msg.patchText);
            return;
          case "clearContext":
            await this.clearCurrentContext();
            await this.pushState();
            return;
          case "pickFileAndAddContext": {
            const pick = await vscode.window.showOpenDialog({
              canSelectMany: false,
              canSelectFiles: true,
              canSelectFolders: false,
              openLabel: "加入上下文"
            });
            if (!pick?.[0]) return;
            const uri = pick[0];
            const rel = vscode.workspace.asRelativePath(uri);
            const content = await readWorkspaceTextFile(uri);
            await this.addContextSnippet({ title: `文件: ${rel}`, content });
            return;
          }
          case "copyPrompt": {
            await vscode.env.clipboard.writeText(msg.prompt);
            await this.notifyInChat(await this.ensureThread(), "✅ 提示词已复制到剪贴板。");
            return;
          }
          case "threadCreate": {
            const title =
              typeof msg.title === "string" && msg.title.trim()
                ? msg.title.trim()
                : (await vscode.window.showInputBox({
                    title: "新建对话线程",
                    prompt: "可选：输入线程标题（留空则自动生成）",
                    placeHolder: "例如：修复 xxx bug / 实现 yyy 功能"
                  })) ?? "";
            await this.store.createThread(title);
            this.currentThreadId = undefined;
            await this.ensureThread();
            this.resetAutoChain(this.currentThreadId!);
            this.resetUserIntentCache(this.currentThreadId!);
            await this.pushState();
            return;
          }
          case "threadSwitch": {
            await this.store.setCurrentThread(msg.threadId);
            this.currentThreadId = undefined;
            await this.ensureThread();
            this.resetAutoChain(this.currentThreadId!);
            this.resetUserIntentCache(this.currentThreadId!);
            await this.pushState();
            return;
          }
          case "threadClear": {
            const pick = await vscode.window.showWarningMessage(
              "确认清空当前线程的消息和上下文？",
              { modal: true },
              "清空",
              "取消"
            );
            if (pick !== "清空") return;
            await this.store.clearThread(msg.threadId);
            await this.store.setCurrentThread(msg.threadId);
            this.currentThreadId = undefined;
            await this.ensureThread();
            this.resetAutoChain(this.currentThreadId!);
            this.resetUserIntentCache(this.currentThreadId!);
            await this.pushState();
            return;
          }
          case "threadDelete": {
            const pick = await vscode.window.showWarningMessage(
              "确认删除当前线程？此操作不可撤销。",
              { modal: true },
              "删除",
              "取消"
            );
            if (pick !== "删除") return;
            await this.store.deleteThread(msg.threadId);
            // 重新同步：删除的可能就是当前线程
            this.currentThreadId = undefined;
            await this.ensureThread();
            this.resetAutoChain(this.currentThreadId!);
            this.resetUserIntentCache(this.currentThreadId!);
            await this.pushState();
            return;
          }
          case "threadExport": {
            const content =
              msg.format === "markdown"
                ? await this.store.exportThreadMarkdown(msg.threadId)
                : await this.store.exportThreadJson(msg.threadId);
            await vscode.env.clipboard.writeText(content);
            const language = msg.format === "markdown" ? "markdown" : "json";
            const doc = await vscode.workspace.openTextDocument({ content, language });
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
            await this.notifyInChat(msg.threadId, "✅ 已导出到新文档并复制到剪贴板。");
            return;
          }
          case "toolPlanRun": {
            const tid = await this.ensureThread();
            if (await this.rejectIfBusy("执行 toolplan", tid)) return;
            this.debug("info", "toolPlanRun", { threadId: tid, planChars: msg.planText?.length ?? 0 });
            await this.runToolPlanAndGeneratePatch(tid, msg.planText);
            return;
          }
          case "toolCallRun": {
            const tid = await this.ensureThread();
            if (await this.rejectIfBusy("执行 toolcall", tid)) return;
            await this.runToolCallAndContinue(tid, msg.callText);
            return;
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this._post({ type: "error", message });
      }
    });
  }

  private async notifyInChat(threadId: string, text: string) {
    const msg = String(text || "").trim();
    if (!msg) return;
    await this.store.addMessage(threadId, "system", msg);
    await this.pushState();
  }

  public async notify(text: string) {
    const tid = await this.ensureThread();
    await this.notifyInChat(tid, text);
  }

  private _post(message: WebviewOutbound) {
    this._view?.webview.postMessage(message);
  }

  private setBusy(busy: boolean) {
    this._post({ type: "requestState", busy: !!busy });
  }

  private isBusy(): boolean {
    return Boolean(this.active?.abort);
  }

  private isBusyOtherThread(threadId: string): boolean {
    if (!this.isBusy()) return false;
    const cur = this.active?.threadId;
    return Boolean(cur && cur !== threadId);
  }

  private async rejectIfBusy(actionName: string, threadId?: string): Promise<boolean> {
    if (!this.isBusy()) return false;
    const tid = threadId ?? (await this.ensureThread());
    await this.notifyInChat(tid, `⏳ 正在处理中（${actionName}）。请先等待完成，或点击「停止」后再试。`);
    return true;
  }

  private async setReadOnly(enabled: boolean) {
    this.readOnlyMode = !!enabled;
    await this.context.workspaceState.update(this.READONLY_KEY, this.readOnlyMode);
    this._post({ type: "readOnlyState", enabled: this.readOnlyMode });
  }

  private debug(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const tail = data ? ` ${JSON.stringify(data)}` : "";
    const line = `[${ts}] [${level}] ${msg}${tail}`;
    this.debugBuf.push(line);
    if (this.debugBuf.length > this.DEBUG_MAX) this.debugBuf.splice(0, this.debugBuf.length - this.DEBUG_MAX);
    this.output.appendLine(line);
    this._post({ type: "debugAppend", line });
  }

  private resetAutoChain(threadId: string) {
    this.autoChainCount[threadId] = 0;
    this.lastRepeatSig[threadId] = "";
    this.repeatCount[threadId] = 0;
    this.autoChainPaused[threadId] = false;
  }

  private pauseAutoChain(threadId: string) {
    this.autoChainPaused[threadId] = true;
  }

  private buildNeutralContinueUserText(): string {
    return "继续（不要复述之前的用户需求/提示词；已解决的问题直接跳过；只基于最新上下文片段/工具结果推进；若你确认已完成，请输出“最终回答”（不要任何代码块）以结束自动链）。";
  }

  private shouldAutoExecuteForUserText(userText: string): boolean {
    const t = String(userText || "").trim();
    if (!t) return false;
    // 用户明确提到“文件/目录/代码/命令/补丁/运行”等，就允许自动链
    if (/[\\/]/.test(t)) return true;
    if (/(diff|patch|补丁|修改|改动|修复|实现|重构|重命名|删除|创建|新建|生成|安装|运行|执行|命令|终端|bash|toolplan|toolcall|读取|查看|列出|搜索|查找|文件|目录|工程|项目|build|test|npm|pnpm|yarn|git)/i.test(t)) {
      return true;
    }
    return false;
  }

  private stableStringify(x: unknown): string {
    const seen = new WeakSet<object>();
    const norm = (v: any): any => {
      if (v == null) return v;
      if (typeof v !== "object") return v;
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    };
    return JSON.stringify(norm(x));
  }

  private extractFirstJsonObjectFrom(text: string, startIdx: number): string {
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
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") {
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

  private extractFirstJsonValueFrom(text: string, startIdx: number): string {
    const s = String(text || "");
    let i = Math.max(0, startIdx | 0);
    while (i < s.length && s[i] !== "{" && s[i] !== "[") i++;
    if (i >= s.length) return "";

    const open = s[i];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") {
        inStr = true;
        continue;
      }
      if (ch === open) depth++;
      if (ch === close) {
        depth--;
        if (depth === 0) return s.slice(i, j + 1);
      }
    }
    return "";
  }

  private normalizeToolPlanJson(plan: unknown): { read: string[]; notes: string } {
    // 新格式：{"read":["a","b"],"notes":"..."}
    if (plan && typeof plan === "object" && !Array.isArray(plan)) {
      const p: any = plan as any;
      const read = Array.isArray(p?.read) ? p.read.filter((x: any) => typeof x === "string") : [];
      const notes = typeof p?.notes === "string" ? p.notes : "";
      return { read, notes };
    }

    // 兼容旧格式：toolplan [ {type:"readFile", path:"xx"} , ... ]
    if (Array.isArray(plan)) {
      const read: string[] = [];
      for (const item of plan) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const t = String((item as any).type ?? "").trim();
        const p = (item as any).path ?? (item as any).file ?? (item as any).filepath;
        if (typeof p !== "string" || !p.trim()) continue;
        if (!/^readfile$/i.test(t) && !/^read_file$/i.test(t) && !/^listdir$/i.test(t) && !/^list_dir$/i.test(t)) continue;
        read.push(p.trim());
      }
      return { read, notes: "（已从旧版 toolplan 数组格式自动转换）" };
    }

    return { read: [], notes: "" };
  }

  private normalizeTextToLines(text: string): string[] {
    const s = String(text ?? "").replace(/\r\n/g, "\n");
    const lines = s.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  private buildFullFileUnifiedDiff(opts: { relPath: string; oldText: string; newText: string; isNewFile: boolean }): string {
    const { relPath, oldText, newText, isNewFile } = opts;
    const oldLines = this.normalizeTextToLines(oldText);
    const newLines = this.normalizeTextToLines(newText);
    const oldCount = oldLines.length;
    const newCount = newLines.length;

    const header: string[] = [];
    header.push(`diff --git a/${relPath} b/${relPath}`);
    if (isNewFile) header.push("new file mode 100644");
    header.push(isNewFile ? "--- /dev/null" : `--- a/${relPath}`);
    header.push(`+++ b/${relPath}`);
    header.push(isNewFile ? `@@ -0,0 +1,${newCount} @@` : `@@ -1,${oldCount} +1,${newCount} @@`);

    const body: string[] = [];
    if (!isNewFile) {
      for (const l of oldLines) body.push(`-${l}`);
    }
    for (const l of newLines) body.push(`+${l}`);

    return [...header, ...body, ""].join("\n");
  }

  private async buildWriteFileAsDiff(filePathRaw: string, content: string): Promise<string | undefined> {
    const relPath = this.sanitizeRelPath(filePathRaw) ?? this.sanitizeRelPath(filePathRaw.replace(/^[.][/\\\\]/, ""));
    if (!relPath) return undefined;
    const root = await getOrPickWorkspaceRootUri();
    const uri = vscode.Uri.joinPath(root, relPath);
    let exists = false;
    let oldText = "";
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      exists = Boolean(stat.type & vscode.FileType.File);
    } catch {
      exists = false;
    }
    if (exists) {
      const data = await vscode.workspace.fs.readFile(uri);
      oldText = Buffer.from(data).toString("utf8");
    }
    return this.buildFullFileUnifiedDiff({ relPath, oldText, newText: String(content ?? ""), isNewFile: !exists });
  }

  private async tryRepairUnsupportedToolOutputs(
    threadId: string,
    replyText: string
  ): Promise<{ kind: "bash"; cmd: string } | { kind: "diff"; diffText: string } | undefined> {
    const raw = String(replyText || "");
    const idx = raw.search(/(^|\n)\s*toolcall\b/i);
    if (idx === -1) return undefined;
    const jsonText = this.extractFirstJsonObjectFrom(raw, idx);
    if (!jsonText) return undefined;
    let obj: any;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      return undefined;
    }

    // 已支持的标准 toolcall：交给正常解析流程
    if (typeof obj?.tool === "string" && obj?.args != null) return undefined;

    // 兼容一些模型会“自造”的 toolcall：{type:"bash", command:"..."}
    const type = String(obj?.type ?? obj?.kind ?? "");
    const command = obj?.command ?? obj?.cmd;
    if (/^bash$/i.test(type) && typeof command === "string" && command.trim()) {
      return { kind: "bash", cmd: command.trim() };
    }

    // 兼容：write_file / file_path + content
    const filePath = obj?.file_path ?? obj?.path ?? obj?.filename;
    const content = obj?.content ?? obj?.text ?? obj?.data;
    const looksLikeWriteFile = /^write_?file$/i.test(type) || (typeof filePath === "string" && typeof content === "string");
    if (looksLikeWriteFile && typeof filePath === "string" && typeof content === "string") {
      const diffText = await this.buildWriteFileAsDiff(filePath, content);
      if (!diffText) return undefined;
      // 记录一下：我们把“自造工具”纠正成了 diff（更像 Claude Code）
      this.debug("warn", "repaired unsupported toolcall(write_file)->diff", { filePath });
      return { kind: "diff", diffText };
    }

    void threadId;
    return undefined;
  }

  private async stopIfRepeated(threadId: string, signature: string, reason: string): Promise<boolean> {
    const prev = this.lastRepeatSig[threadId] || "";
    const nextCount = prev === signature ? (this.repeatCount[threadId] ?? 0) + 1 : 1;
    this.lastRepeatSig[threadId] = signature;
    this.repeatCount[threadId] = nextCount;

    if (nextCount < this.REPEAT_LIMIT) return false;

    const message = `⏸️ 已暂停自动链式执行：检测到重复动作 ${nextCount} 次（原因：${reason}）`;
    this.debug("warn", "autoChain: repeated action stopped", {
      threadId,
      reason,
      repeat: nextCount,
      limit: this.REPEAT_LIMIT
    });
    // 不要 toast 弹条：只在对话框里输出 system
    await this.store.addMessage(threadId, "system", message);
    await this.pushState();
    return true;
  }

  private async tryConsumeAutoChain(threadId: string, reason: string): Promise<boolean> {
    if (this.autoChainPaused[threadId]) {
      this.debug("warn", "autoChain paused; skip", { threadId, reason });
      return false;
    }
    const n = (this.autoChainCount[threadId] ?? 0) + 1;
    this.autoChainCount[threadId] = n;
    if (n <= this.MAX_AUTO_CHAIN) return true;

    const message = `⏸️ 已暂停自动链式执行（防止循环）：超过上限 ${this.MAX_AUTO_CHAIN}（原因：${reason}）`;
    this.debug("warn", "autoChain: stopped", { threadId, reason, n, max: this.MAX_AUTO_CHAIN });
    // 不要 toast 弹条：只在对话框里输出 system
    await this.store.addMessage(threadId, "system", message);
    await this.pushState();
    return false;
  }

  private async maybeAutoOpenPlaywright() {
    const enabled = vscode.workspace.getConfiguration().get<boolean>("deepseekCoder.autoOpenPlaywright") ?? false;
    if (!enabled) return;
    try {
      this.debug("info", "autoOpenPlaywright: opening");
      await this.deepseek.openAndLetUserLogin();
      this.debug("info", "autoOpenPlaywright: opened");
    } catch (e) {
      this.debug("error", "autoOpenPlaywright: failed", { error: e instanceof Error ? e.message : String(e) });
      const msg = e instanceof Error ? e.message : String(e);
      const missingBrowser =
        /Executable doesn't exist/i.test(msg) ||
        /playwright install/i.test(msg) ||
        /Looks like Playwright was just installed/i.test(msg);
      if (missingBrowser) {
        const tid = await this.ensureThread();
        await this.notifyInChat(
          tid,
          [
            "⚠️ Playwright Chromium 未就绪：自动打开失败。",
            "请运行命令安装浏览器：`Deepseek Coder: 安装 Playwright Chromium（首次使用）`"
          ].join("\n")
        );
      }
    }
  }

  private async ensureFreshThreadOnEnter(): Promise<string> {
    // 需求：每次进入面板默认“清空上次对话”，但保留历史（可切换/可删除）。
    // 为避免把正在流式生成的线程切走，这里在 active 时不做自动切换。
    if (this.active?.abort) return await this.ensureThread();
    const tid = await this.store.ensureCurrentThread();
    const t = await this.store.getThread(tid);
    const hasContent = (t?.messages?.length ?? 0) > 0 || (t?.snippets?.length ?? 0) > 0;
    if (hasContent) {
      await this.store.createThread();
      this.currentThreadId = undefined;
    }
    return await this.ensureThread();
  }

  private async ensureThread(): Promise<string> {
    this.currentThreadId = await this.store.ensureCurrentThread();
    return this.currentThreadId;
  }

  private async getStatePayload() {
    const tid = await this.ensureThread();
    const [threads, t] = await Promise.all([this.store.listThreads(), this.store.getThread(tid)]);
    const webContext = await this.store.getWebContext(tid);
    return {
      threads,
      currentThreadId: tid,
      messages: t?.messages ?? [],
      snippets: t?.snippets ?? [],
      webContext
    };
  }

  private async pushInit() {
    const p = await this.getStatePayload();
    this._post({ type: "init", ...p });
  }

  private async pushState() {
    const p = await this.getStatePayload();
    this._post({ type: "state", ...p });
  }

  private async clearCurrentContext() {
    const tid = await this.ensureThread();
    await this.store.clearSnippets(tid);
  }

  private buildPrompt(snippets: ContextSnippet[], userText: string) {
    const parts: string[] = [];
    parts.push(
      [
        "# 角色",
        "你是一个严格遵循格式的代码助手。你只能输出以下格式之一，绝对禁止输出任何其他内容。",
        "",
        "# 运行环境与边界（必须遵守）",
        "- 你运行在 VSCode 扩展环境中：可以通过 toolplan/toolcall/bash 让扩展读取工作区文件/执行命令",
        "- 你正在用户的工作区环境中协作：用户说“生成/写/实现 XXX 代码”，通常意味着在工作区**创建/修改文件**（必须用 unified diff；新文件用 diff header + new file mode）",
        "- 允许使用 DeepSeek 网页端的联网能力（搜索/阅读网页）。注意：网页端可能显示 `Read N web pages`/`Search` 等系统状态行，请忽略，不要把它们当正文复述；把检索到的信息融入最终输出。",
        "- toolcall 只支持：listDir/readFile/searchText（参数见下方）",
        "- toolcall 的路径必须是**工作区相对路径**（禁止 /、/home 这类绝对路径；否则会失败）",
        "- 如果用户要看系统目录（例如 / 或 /home），请改用 bash 执行 ls/pwd 等命令",
        "- 重要：生成/修改任何源代码文件时，文件内容里**禁止出现 markdown fence**（``` 或 ```python 等）；也不要输出补丁元行 `\\ No newline at end of file`",
        "- 重要：所有文本文件请确保以换行符结尾（文件末尾必须有 \\n），避免补丁应用时上下文不匹配",
        "- 重要：当你选择输出 toolplan/toolcall/diff/bash 时，必须把内容放在对应的 markdown 代码块里，并且整个回复**只能包含这一个代码块**（代码块外一个字都不许有）",
        "- 重要：禁止输出 DeepSeek 网页 UI 噪音（Copy/Download/text/Reading/Read N web pages/Search 等），也不要把这些词粘进 diff/toolcall 里",
        "- 重要：禁止在 diff 代码块外额外输出一行 \"diff\"（必须让 diff 代码块的第一行直接是 diff --git）",
        "",
        "# Claude Code 风格的行为准则（必须遵守）",
        "- 优先最小动作：能直接回答就不要调用工具",
        "- 需要信息再动手：不确定文件路径/内容 → 先输出 toolplan 读取再继续",
        "- 你计划“新建”的文件：不要在 toolplan 里去 read（会读不到并产生噪音）；请用 bash 创建或用 diff new file 直接新增",
        "- bash 尽量简单：允许 &&/||；避免管道 |、命令替换 $() 等高风险语法（可能被安全策略拦截/要求确认）",
        "- 允许使用 cd，但请把需要保持目录切换的操作写在同一个 bash 代码块里（扩展会把含 cd 的 bash 作为脚本整体执行）",
        "- 禁止发明不存在的工具/字段：toolcall 的 JSON 顶层只能有 tool 和 args；不要输出 type/write_file/command/file_path/content 等字段",
        "- 工具结果足够后就停：不要无限继续调用工具",
        "",
        "# 输出格式（五选一，严格遵守）",
        "",
        "## 格式 A: toolplan（需要读取文件时使用）",
        "输出一个 markdown 代码块，语言标识为 `toolplan`，内容为 JSON：",
        "```toolplan",
        '{"read":["文件路径1","文件路径2"],"notes":"说明"}',
        "```",
        "【重要】整个回复只能包含这一个 ```toolplan``` 代码块；代码块外不能有任何文字！",
        "【重要】read 里的路径必须是工作区相对路径（例如 README.md、src/index.ts）。禁止以 / 开头。",
        "",
        "## 格式 B: toolcall（需要执行工具时使用）",
        "输出一个 markdown 代码块，语言标识为 `toolcall`，内容为 JSON：",
        "```toolcall",
        '{"tool":"listDir|readFile|searchText","args":{...}}',
        "```",
        "【重要】整个回复只能包含这一个 ```toolcall``` 代码块；代码块外不能有任何文字！",
        "【重要】searchText 必须提供非空 query；glob 可选（如 \"**/*.{ts,tsx}\"）",
        "【重要】toolcall JSON 的顶层字段只能是 tool 和 args（不要输出 type/command/file_path/content 这类字段）。",
        "【允许但不推荐】如果你必须一次做多个工具：可以输出一个 JSON，对应多个工具名 key，例如 {\"readFile\":{...},\"searchText\":{...}}（仍然必须放在同一个 ```toolcall``` 代码块里，且代码块外不能有任何文字）。",
        "",
        "## 格式 C: unified diff（修改代码时使用）",
        "必须输出一个 markdown 代码块，语言标识为 `diff`，代码块内是 unified diff：",
        "```diff",
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,3 +1,4 @@",
        " 保持的行",
        "-删除的行",
        "+新增的行",
        "```",
        "【重要】只能输出这一个 ```diff``` 代码块；代码块外不能有任何文字！（禁止输出裸 diff，也禁止在代码块外单独输出一行 diff）",
        "【重要】diff 代码块里第一行必须是 `diff --git ...`（不能出现 `diffCopyDownload...` / `diff Copy Download ...` / `text` 等污染行）。",
        "【重要】凡是“写代码/生成文件/修改文件内容”，必须使用 diff；禁止用 bash 的 cat/echo/heredoc 去写入源代码。",
        "【重要】每次只能修改/新增 **一个文件**：一个 diff 代码块里只允许出现 **一段** `diff --git a/... b/...`（不要把多个文件的 diff 拼在一起）。",
        "【重要】如果需要修改多个文件：请分多轮输出；每轮只输出一个文件的 diff，等待系统应用并继续追问后，再输出下一个文件的 diff。",
        "【禁止】不要在 diff 代码块里嵌入任何 markdown 代码块（例如 ```bash/```json 等），也不要输出 ``` 这类 fence 行。",
        "",
        "## 格式 D: bash（需要执行 Linux 命令时使用，如删除文件、安装依赖等）",
        "输出一个 markdown 代码块，语言标识为 `bash`：",
        "```bash",
        "rm -f src/example.ts",
        "```",
        "支持的命令：rm、mv、cp、mkdir、touch、cat、npm、yarn、git 等常用命令",
        "【重要】整个回复只能包含这一个 ```bash``` 代码块；代码块外不能有任何文字！",
        "【重要】删除文件请使用 rm 命令而不是 diff！",
        "【重要】bash 尽量简单：允许 &&/||；避免管道 |、命令替换 $() 等高风险语法",
        "",
        "## 格式 E: 最终回答（当你确认已完成任务且不需要任何工具/补丁时）",
        "直接输出中文总结（可以用要点/步骤/下一步建议）。",
        "【重要】不要输出 toolplan/toolcall/diff/bash，也不要输出任何代码块。",
        "",
        "# 重要行为约束（防止乱用工具）",
        "- 只有当用户明确要求本地操作（读文件/查找/改代码/执行命令），或你的回答必须依赖本地信息时，才使用 toolplan/toolcall/diff/bash。",
        "- 否则请直接输出“格式 E 最终回答”（中文说明/结论/澄清问题）。",
        "",
        "# 禁止事项",
        "- 禁止在代码块外写任何解释、前言、后语",
        "- 禁止写「以下是...」「这是...」之类的引导语",
        "- 禁止复述用户需求",
        "- 禁止输出示例/模板/占位符"
      ].join("\n")
    );
    for (const s of snippets) {
      parts.push(`\n---\n# ${s.title}\n\n${s.content}\n`);
    }
    parts.push(
      [
        "\n---\n",
        "# 用户需求",
        userText,
        "",
        "# 你的任务",
        "根据上下文和用户需求，选择合适的格式输出。",
        "- 不确定文件路径/内容：使用 toolplan 先读取。",
        "- 需要改文件：输出 diff。",
        "- 需要执行命令：输出 bash。",
        "- 如果你确认已完成且不需要任何工具/补丁：输出“格式 E 最终回答”。"
      ].join("\n")
    );
    return parts.join("\n");
  }

  private buildPatchPrompt(snippets: ContextSnippet[], userText: string) {
    return this.buildPrompt(snippets, userText);
  }

  private buildToolPlanPrompt(snippets: ContextSnippet[], userText: string) {
    const base = this.buildPrompt(snippets, userText);
    return [
      base,
      "",
      "---",
      "# 强制指令",
      "现在你必须输出 toolplan 格式（格式 A）。",
      "只输出一个 ```toolplan``` 代码块，代码块内是 JSON，包含 read 数组和 notes 字符串。",
      "代码块外绝对不能有任何文字！输出完代码块立刻停止！",
      "",
      "# 重要说明（避免误解）",
      "toolplan 只是“要读哪些文件/为什么读”的清单，不是最终解决方案。",
      "扩展会执行读取，并把读取结果追加到上下文，然后会在同一对话里自动继续让你输出下一步（通常是 diff/bash/最终回答）。",
      "因此你不需要在 toolplan 里同时输出 bash/diff/toolcall。"
    ].join("\n");
  }

  private sanitizeRelPath(p: string): string | undefined {
    const s = (p || "").trim();
    if (!s) return undefined;
    if (path.isAbsolute(s)) return undefined;
    const norm = s.replace(/\\/g, "/");
    const clean = path.posix.normalize(norm);
    if (clean.startsWith("..")) return undefined;
    return clean;
  }

  private async readWorkspaceRelFile(relPath: string): Promise<string> {
    const root = await getOrPickWorkspaceRootUri();
    const uri = relPath ? vscode.Uri.joinPath(root, relPath) : root;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `/* 路径不存在或无法访问：${relPath || "."}\n${msg}\n*/`;
    }
    if (stat.type & vscode.FileType.Directory) {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `/* 读取目录失败：${relPath || "."}\n${msg}\n*/`;
      }
      const lines = entries.slice(0, 300).map(([name, type]) => {
        const t = type === vscode.FileType.Directory ? "dir" : type === vscode.FileType.File ? "file" : "other";
        return `${t}\t${relPath ? relPath + "/" : ""}${name}`;
      });
      return lines.join("\n");
    }
    return await readWorkspaceTextFile(uri);
  }

  /**
   * 自动处理回复：检测回复类型并自动执行相应操作
   * @param retryCount 当前重试次数（用于 diff 应用失败时重试）
   */
  private async autoProcessReply(threadId: string, replyText: string, retryCount = 0, originUserText?: string) {
    const extractStructuredAnswer = (text: string): string => {
      const s = String(text || "");
      const idx = s.indexOf("<<<DS_ANSWER>>>");
      if (idx === -1) return s;
      return s.slice(idx + "<<<DS_ANSWER>>>".length).trim();
    };

    // 关键：如果存在 1:1 结构化文本，只从“最终回答区”执行（思考区永远不触发任何功能）
    const execText = extractStructuredAnswer(replyText);
    const trimmed = String(execText || "").trim();

    // 安全策略：只有当“整条回复严格等于一个动作块”（或裸 diff / 裸 JSON）时才自动执行。
    // 目的：避免模型回显我们发送的提示词（里面包含示例 ```diff/toolcall/toolplan```）导致误触发执行。
    type StrictAction =
      | { kind: "diff"; body: string }
      | { kind: "diffBatch"; body: string }
      | { kind: "bash"; body: string }
      | { kind: "toolcall"; body: string }
      | { kind: "toolcallBatch"; body: string }
      | { kind: "toolplan"; body: string };

    // 兼容模型“自造”的 toolcall 结构：
    // - 标准：{"tool":"searchText","args":{...}}
    // - 变体：{"searchText":{...}}（顶层 key=tool，value=args）
    // - 批量：{"readFile":{...},"searchText":{...}}（多个工具，按顺序执行）
    const normalizeLooseToolCalls = (obj: any): Array<{ tool: string; args: any }> => {
      if (!obj || typeof obj !== "object") return [];
      // 标准
      if (typeof (obj as any).tool === "string" && String((obj as any).tool).trim()) {
        return [{ tool: String((obj as any).tool), args: (obj as any).args ?? {} }];
      }

      // 变体/批量：顶层 key=工具名
      const allowed = new Set(["listDir", "readFile", "searchText"]);
      const calls: Array<{ tool: string; args: any }> = [];
      const keys = Object.keys(obj);
      // 固定顺序：先读/列，再搜，避免“先搜再读”导致重复
      const order = ["readFile", "listDir", "searchText"];
      const sorted = keys.slice().sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
      for (const k of sorted) {
        if (!allowed.has(k)) continue;
        const v = (obj as any)[k];
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        calls.push({ tool: k, args: v });
      }
      return calls;
    };

    const parseStrictAction = (s0: string): StrictAction | undefined => {
      const s = String(s0 || "").trim();
      if (!s) return undefined;

      // DeepSeek 网页端常见污染格式：
      // toolcall\nCopy\nDownload\n{...}  或  toolplan\nCopy\nDownload\n{...}
      // 围栏被 UI 吞掉时，做一次“关键词 + JSON 括号匹配”归一化。
      const lower = s.toLowerCase();
      const idxToolcall = lower.lastIndexOf("toolcall");
      if (idxToolcall !== -1) {
        const json = this.extractFirstJsonObjectFrom(s, idxToolcall);
        if (json) {
          try {
            const obj = JSON.parse(json);
            const calls = normalizeLooseToolCalls(obj);
            if (calls?.length === 1) return { kind: "toolcall", body: JSON.stringify({ tool: calls[0].tool, args: calls[0].args ?? {} }) };
            if (calls?.length > 1) return { kind: "toolcallBatch", body: JSON.stringify({ calls }) };
          } catch {
            // ignore
          }
        }
      }
      const idxToolplan = lower.lastIndexOf("toolplan");
      if (idxToolplan !== -1) {
        const json = this.extractFirstJsonValueFrom(s, idxToolplan);
        if (json) {
          try {
            const obj = JSON.parse(json);
            const norm = this.normalizeToolPlanJson(obj);
            if (Array.isArray(norm?.read) && norm.read.length > 0) {
              return { kind: "toolplan", body: JSON.stringify(norm) };
            }
          } catch {
            // ignore
          }
        }
      }

      const mDiff = /^```diff\s*([\s\S]*?)```$/.exec(s);
      if (mDiff) {
        const body = String(mDiff[1] || "").trim();
        if (!body.startsWith("diff --git ")) return undefined;
        return { kind: "diff", body };
      }
      // 多个连续 diff 代码块：允许整条回复只由多个 ```diff``` 组成
      const diffBlocks = Array.from(s.matchAll(/```diff\s*([\s\S]*?)```/g));
      if (diffBlocks.length >= 2) {
        const stripped = s.replace(/```diff\s*[\s\S]*?```/g, "").trim();
        if (!stripped) {
          const diffs = diffBlocks
            .map((m) => String(m[1] || "").trim())
            .filter((x) => x.startsWith("diff --git "));
          if (diffs.length === diffBlocks.length) {
            return { kind: "diffBatch", body: JSON.stringify({ diffs }) };
          }
        }
      }
      const mBash = /^```(?:bash|sh|shell)\s*([\s\S]*?)```$/.exec(s);
      if (mBash) {
        const body = String(mBash[1] || "").trim();
        if (!body) return undefined;
        return { kind: "bash", body };
      }
      const mToolcall = /^```toolcall\s*([\s\S]*?)```$/.exec(s);
      if (mToolcall) {
        const body = String(mToolcall[1] || "").trim();
        if (!body) return undefined;
        try {
          const obj = JSON.parse(body);
          if (typeof obj?.tool === "string" && obj.tool) return { kind: "toolcall", body: JSON.stringify(obj) };
          const calls = normalizeLooseToolCalls(obj);
          if (calls?.length === 1) return { kind: "toolcall", body: JSON.stringify({ tool: calls[0].tool, args: calls[0].args ?? {} }) };
          if (calls?.length > 1) return { kind: "toolcallBatch", body: JSON.stringify({ calls }) };
          return undefined;
        } catch {
          return undefined;
    }
      }
      const mToolplan = /^```toolplan\s*([\s\S]*?)```$/.exec(s);
      if (mToolplan) {
        const body = String(mToolplan[1] || "").trim();
        if (!body) return undefined;
        try {
          const obj = JSON.parse(body);
          const norm = this.normalizeToolPlanJson(obj);
          if (!Array.isArray(norm?.read) || norm.read.length === 0) return undefined;
          return { kind: "toolplan", body: JSON.stringify(norm) };
        } catch {
          return undefined;
        }
      }

      if (s.startsWith("diff --git ") && /\n--- /.test(s) && /\n\+\+\+ /.test(s)) {
        return { kind: "diff", body: s };
      }

      if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
        try {
          const obj = JSON.parse(s);
          const normPlan = this.normalizeToolPlanJson(obj);
          if (Array.isArray(normPlan?.read) && normPlan.read.length > 0) return { kind: "toolplan", body: JSON.stringify(normPlan) };
          const calls = normalizeLooseToolCalls(obj);
          if (calls?.length === 1) return { kind: "toolcall", body: JSON.stringify({ tool: calls[0].tool, args: calls[0].args ?? {} }) };
          if (calls?.length > 1) return { kind: "toolcallBatch", body: JSON.stringify({ calls }) };
        } catch {
          // ignore
        }
      }
      return undefined;
    };

    const action = parseStrictAction(trimmed);
    if (!action) {
      // 常见违规输出：多文件 diff / toolplan+diff 混合 / 旧 toolplan 数组格式
      const maybeMultiDiff = (() => {
        const m = trimmed.match(/^diff --git /gm);
        return (m?.length ?? 0) >= 2;
      })();
      const maybeMixedToolplanAndDiff = /\btoolplan\b/i.test(trimmed) && /(^|\n)diff --git /m.test(trimmed);
      const maybeLegacyToolplanArray = /\btoolplan\b/i.test(trimmed) && /\[\s*\{\s*"type"\s*:\s*"readFile"/i.test(trimmed);
      const maybeDiffWithUiNoise = /(diff\s*Copy\s*Download\s*diff\s*--git|diffCopyDownloaddiff\s*--git)/i.test(trimmed);
      const maybeHasStandaloneTextNoise = /(^|\n)\s*text\s*($|\n)/i.test(trimmed);
      const maybeHasStandaloneDiffLabel = /(^|\n)\s*diff\s*($|\n)\s*diff --git /i.test(trimmed);

      if (maybeMultiDiff || maybeMixedToolplanAndDiff || maybeLegacyToolplanArray || maybeDiffWithUiNoise || maybeHasStandaloneTextNoise || maybeHasStandaloneDiffLabel) {
        const sig = `formatfix:${this.hashTextShort(trimmed.slice(0, 2000))}`;
        if (!(await this.stopIfRepeated(threadId, sig, "formatfix(repeated)"))) {
          await this.notifyInChat(
            threadId,
            [
              "⚠️ 检测到 DeepSeek 回复不符合“单块/单文件”规则，已暂停自动执行。",
              "我会自动请求它按规则重写（只输出一个 toolplan 或一个单文件 diff）。"
            ].join("\n")
          );
          const reason = maybeMultiDiff
            ? "你输出了多个文件的 diff（出现了多个 `diff --git`）。每次只能输出一个文件的 diff。"
            : maybeMixedToolplanAndDiff
              ? "你把 toolplan 和 diff 混在同一条回复里了。一次只能输出一种动作块。"
              : maybeLegacyToolplanArray
                ? "你使用了旧版 toolplan 数组格式。toolplan 必须是 {\"read\":[...],\"notes\":\"\"}。"
                : maybeDiffWithUiNoise
                  ? "你的 diff 被 DeepSeek 网页 UI 文本污染（Copy/Download 粘连），必须清理后只输出 `diff --git` 开头的内容。"
                  : maybeHasStandaloneTextNoise
                    ? "你输出了无关的 `text` 噪音行。回复里禁止出现这种 UI 标签行。"
                    : "你在 diff 代码块外额外输出了单独一行 `diff`。diff 代码块第一行必须直接是 `diff --git`。";

          await this.requestStrictReformat(threadId, trimmed, reason);
      }
        return;
      }

      this.debug("info", "autoProcessReply: no strict actionable content detected; skip auto-exec");
        return;
      }

    if (action.kind === "toolplan") {
      await this.runToolPlanAndGeneratePatch(threadId, action.body);
          return;
        }

    if (action.kind === "toolcall") {
      const normalized = normalizeToolCallObject(JSON.parse(action.body));
        const sig = `toolcall:${normalized.tool}:${this.stableStringify(normalized.args)}`;
      if (await this.stopIfRepeated(threadId, sig, "toolcall(strict,repeated)")) return;
      await this.runToolCallAndContinueAuto(threadId, action.body);
      return;
    }

    if (action.kind === "toolcallBatch") {
      let calls: Array<{ tool: string; args: any }> = [];
      try {
        const obj = JSON.parse(action.body);
        calls = Array.isArray(obj?.calls) ? obj.calls : [];
      } catch {
        calls = [];
      }
      const cleaned = calls
        .filter((c) => c && typeof c.tool === "string" && c.tool)
        .map((c) => normalizeToolCallObject({ tool: c.tool, args: c.args ?? {} }));
      const sig = `toolcallBatch:${this.stableStringify(cleaned)}`;
      if (await this.stopIfRepeated(threadId, sig, "toolcallBatch(strict,repeated)")) return;
      await this.runToolCallBatchAndContinueAuto(threadId, cleaned as any);
      return;
    }

    if (action.kind === "bash") {
      if (this.readOnlyMode) {
        await this.notifyInChat(threadId, "🔒 只读模式：检测到 bash，未自动执行。");
          return;
        }
      const sig = `bash:${action.body.trim().slice(0, 500)}`;
      if (await this.stopIfRepeated(threadId, sig, "bash(strict,repeated)")) return;
      await this.autoExecuteBash(threadId, action.body);
      return;
    }

    if (action.kind === "diffBatch") {
      let diffs: string[] = [];
      try {
        const obj = JSON.parse(action.body);
        diffs = Array.isArray(obj?.diffs) ? obj.diffs.map((x: any) => String(x ?? "")).filter(Boolean) : [];
      } catch {
        diffs = [];
      }
      if (!diffs.length) return;

      if (this.readOnlyMode) {
        await this.notifyInChat(threadId, "🔒 只读模式：检测到 diff，未自动应用。你可以点击消息里的「预览并应用补丁」手动确认。");
        return;
      }

      if (diffs.length > 6) {
        await this.notifyInChat(threadId, `⚠️ 检测到连续 ${diffs.length} 个 diff 代码块：为避免误操作，请让 DeepSeek 分多轮（每轮 1 个文件）重写。`);
        const sig = `diffBatchTooMany:${this.hashTextShort(action.body.slice(0, 2000))}`;
        if (!(await this.stopIfRepeated(threadId, sig, "diffBatch(tooMany,repeated)"))) {
          await this.requestStrictReformat(
            threadId,
            diffs.slice(0, 2).join("\n\n"),
            `你输出了多个 diff 代码块（${diffs.length} 个）。请分多轮，每轮只输出一个文件的 diff（一个 \`\`\`diff\`\`\` 代码块）。`
          );
      }
      return;
    }

      for (let i = 0; i < diffs.length; i++) {
        const d = diffs[i];
        const count = (d.match(/^diff --git /gm) || []).length;
        if (count >= 2) {
          await this.notifyInChat(threadId, "⚠️ 检测到某个 diff 代码块包含多个文件：已拦截并请求按单文件重写。");
          const sig = `diffBatchMultiFile:${this.hashTextShort(d.slice(0, 2000))}`;
          if (!(await this.stopIfRepeated(threadId, sig, "diffBatch(multifile,repeated)"))) {
            await this.requestStrictReformat(
              threadId,
              d,
              `你的某个 diff 代码块包含多个文件（出现了 ${count} 段 diff --git）。请拆成多轮，每轮只输出一个文件的 diff。`
            );
          }
          return;
        }
        await this.autoApplyDiff(threadId, d, { continueAfter: i === diffs.length - 1 });
      }
      return;
    }

    if (action.kind !== "diff") return;

    const diffText = action.body;
    if (this.readOnlyMode) {
      await this.notifyInChat(threadId, "🔒 只读模式：检测到 diff，未自动应用。你可以点击消息里的「预览并应用补丁」手动确认。");
      return;
    }

    // 强制：单文件 diff（一个 diff 里只能有一段 diff --git）
    const diffCount = (diffText.match(/^diff --git /gm) || []).length;
    if (diffCount >= 2) {
      const files = Array.from(diffText.matchAll(/^diff --git a\/(\S+)\s+b\/(\S+)/gm))
        .map((m) => m[2] || m[1])
        .filter(Boolean)
        .slice(0, 10);
      const head = files.length ? `（检测到：${files.join(", ")}）` : "";
      await this.notifyInChat(threadId, `⚠️ 检测到多文件 diff，已拦截自动应用${head}。我会请求 DeepSeek 按“单文件 diff”重写。`);
      const sig = `multidiff:${this.hashTextShort(diffText.slice(0, 2000))}`;
      if (!(await this.stopIfRepeated(threadId, sig, "diff(multifile,repeated)"))) {
        await this.requestStrictReformat(
          threadId,
          diffText,
          `你输出了多文件 diff（出现了 ${diffCount} 段 diff --git）。请只输出其中一个文件的 diff（推荐先输出 ${files[0] ?? "第一个文件"}），且回复只能包含一个 \`\`\`diff\`\`\` 代码块。`
        );
      }
      return;
    }

    this.debug("info", "autoProcessReply: detected strict diff, auto-applying");
      try {
        const sig = `diff:${diffText.slice(0, 800)}`;
      if (await this.stopIfRepeated(threadId, sig, "diff(strict,repeated)")) return;
      await this.autoApplyDiff(threadId, diffText, { continueAfter: true });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        this.debug("error", "autoProcessReply: diff apply failed", { error: errorMsg, retryCount });
        if (retryCount < 2) {
          this.debug("info", "autoProcessReply: retrying diff generation", { retryCount: retryCount + 1 });
          await this.notifyInChat(threadId, `⚠️ 补丁应用失败：${errorMsg}，正在重新请求...`);
          await this.retryDiffGeneration(threadId, errorMsg, retryCount + 1, originUserText);
        } else {
          await this.notifyInChat(threadId, `❌ 补丁应用失败（已重试 ${retryCount} 次）：${errorMsg}`);
        }
    }

  }

  /**
   * 自动执行 bash 命令
   */
  private async autoExecuteBash(
    threadId: string,
    bashCmd: string,
    opts?: { continueAfter?: boolean; bypassReadOnly?: boolean }
  ): Promise<{ summary: string; resultText: string } | undefined> {
    if (this.readOnlyMode && !(opts?.bypassReadOnly ?? false)) {
      const summary = "🔒 只读模式：已拦截自动执行 bash。";
      await this.store.addMessage(threadId, "system", [summary, "", bashCmd].join("\n"));
      await this.pushState();
      return { summary, resultText: bashCmd };
    }
    this.debug("info", "autoExecuteBash: starting", { cmd: bashCmd });
    
    // 获取工作区根目录
    const root = await getOrPickWorkspaceRootUri();
    const cwd = root.fsPath;

    const mode =
      (vscode.workspace.getConfiguration().get<string>("deepseekCoder.bashSafetyMode") as BashSafetyMode | undefined) ??
      "unsafe";

    // 分割多行命令
    const hasHereDoc = /(^|\s)<<\s*['"]?[A-Za-z0-9_]+['"]?/.test(bashCmd);
    const hasCd = /(^|\n)\s*cd(\s|$)/m.test(bashCmd);
    let commands = splitBashCommands(bashCmd);

    // 兜底：把“安全的 && 链”拆成多条命令，避免被安全策略拦截/误判为高风险
    // 典型：pwd && ls -la
    const expandSafeAndChain = (cmd: string): string[] => {
      const s = (cmd || "").trim();
      if (!s.includes("&&")) return [cmd];
      // 只处理非常保守的一类：仅包含 &&，且不含管道/分号/重定向/命令替换/|| 等
      if (/[;|`]/.test(s) || /\$\(/.test(s) || /\|\|/.test(s) || /[<>]/.test(s)) return [cmd];
      const parts = s
        .split("&&")
        .map((x) => x.trim())
        .filter(Boolean);
      return parts.length >= 2 ? parts : [cmd];
    };

    if (!hasHereDoc && !hasCd) {
      const expanded: string[] = [];
      for (const c of commands) expanded.push(...expandSafeAndChain(c));
      commands = expanded;
    }

    // 支持 cd：当命令里包含 cd 时，必须作为一个整体脚本执行（否则逐条执行下 cd 不会保留）
    const runAsBlock = hasHereDoc || hasCd;

    if (mode === "unsafe") {
      const riskText = runAsBlock ? bashCmd : commands.join("\n");
      const risk = assessBashRisk(riskText);
      if (risk.level === "high") {
        const pick = await vscode.window.showWarningMessage(
          [
            "检测到可能危险的 bash（不拦截，但需要你确认）。",
            "",
            "原因：",
            ...risk.reasons.map((r) => `- ${r}`),
            "",
            "命令：",
            bashCmd
          ].join("\n"),
          { modal: true },
          "执行",
          "取消"
        );
        if (pick !== "执行") {
          const summary = "⏭️ 已取消执行：危险 bash 需人工确认";
          // 不要 toast 弹条：只在对话框里输出 system
          await this.store.addMessage(threadId, "system", [summary, "", bashCmd].join("\n"));
          await this.store.addSnippet(threadId, "bash 执行结果", `用户取消执行（unsafe 模式下的高风险确认弹窗）。\n\n${bashCmd}`);
          await this.pushState();
          if (opts?.continueAfter ?? true) {
            await this.continueAfterBashAuto(threadId);
          }
          return { summary, resultText: bashCmd };
        }
      }
    }
    
    const BASH_STREAM_FULL_CAP = 2_000_000; // 仅用于内存拼接，完整内容始终写入 OutputChannel
    const BASH_STREAM_UPDATE_MS = 250; // 节流：避免频繁 pushState 卡 UI

    const bashMsgId = `system_bash_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const bashAbort = new AbortController();
    this.activeBash = { threadId, messageId: bashMsgId, abort: bashAbort, kill: undefined };
    let fullText = "";
    let fullTruncated = false;
    let lastUpdateAt = 0;
    let scheduled: NodeJS.Timeout | undefined;
    let lastShown = "";

    const outTs = new Date().toISOString();
    this.output.appendLine(`[${outTs}] [bash] stream start (${threadId})`);
    this.output.appendLine(bashCmd);
    this.output.appendLine("");

    const appendToBuffers = (s: string) => {
      if (!s) return;
      // OutputChannel：永远写全量
      try {
        this.output.append(s);
      } catch {
        // 旧版本没有 append 也没关系：退化到 appendLine（可能多换行）
        this.output.appendLine(String(s));
      }

      // 内存：只保留上限，用于聊天/上下文（仍会再做 truncateForState）
      if (fullText.length < BASH_STREAM_FULL_CAP) {
        const remain = BASH_STREAM_FULL_CAP - fullText.length;
        fullText += s.length <= remain ? s : s.slice(0, remain);
        if (s.length > remain && !fullTruncated) {
          fullTruncated = true;
          fullText += "\n...[output truncated in memory; see OutputChannel for full]...\n";
        }
      } else if (!fullTruncated) {
        fullTruncated = true;
        fullText += "\n...[output truncated in memory; see OutputChannel for full]...\n";
      }
    };

    const scheduleStateUpdate = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastUpdateAt < BASH_STREAM_UPDATE_MS) {
        if (!scheduled) {
          scheduled = setTimeout(() => {
            scheduled = undefined;
            void scheduleStateUpdate(false);
          }, BASH_STREAM_UPDATE_MS);
        }
        return;
      }
      lastUpdateAt = now;
      const shown = this.truncateForState(fullText, "bash 执行中");
      const nextText = ["[bash 执行中]", "", shown].join("\n");
      if (nextText === lastShown) return;
      lastShown = nextText;
      await this.store.updateMessageText(threadId, bashMsgId, nextText);
      await this.pushState();
    };

    await this.store.addMessage(threadId, "system", ["[bash 执行中]", "", this.truncateForState(bashCmd, "bash 命令")].join("\n"), bashMsgId);
    await this.pushState();

    const runBashStreaming = async (cmd: string): Promise<{ ok: boolean; exitCode: number | null; error?: string }> => {
      return await new Promise((resolve) => {
        if (bashAbort.signal.aborted) {
          return resolve({ ok: false, exitCode: null, error: "已停止" });
        }
        const child = spawn("bash", ["-lc", cmd], {
          cwd,
          env: process.env,
          detached: true
        });

        let done = false;
        const finish = (res: { ok: boolean; exitCode: number | null; error?: string }) => {
          if (done) return;
          done = true;
          resolve(res);
        };

        const killTree = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        };
        // 让“停止”按钮能杀掉当前子进程组
        if (this.activeBash && this.activeBash.threadId === threadId && this.activeBash.messageId === bashMsgId) {
          this.activeBash.kill = killTree;
        }

        const onAbort = () => {
          appendToBuffers(`\n[stopped] killed by user\n`);
          killTree();
          finish({ ok: false, exitCode: null, error: "已停止" });
        };
        bashAbort.signal.addEventListener("abort", onAbort, { once: true });

        // 默认超时放宽（开发服务器/长任务需要手动停止）
        const timer = setTimeout(() => {
          appendToBuffers(`\n[timeout] exceeded 30min; killing process\n`);
          killTree();
          finish({ ok: false, exitCode: null, error: "超时（30min）" });
        }, 30 * 60_000);

        child.stdout?.on("data", (buf) => {
          appendToBuffers(String(buf));
          void scheduleStateUpdate(false);
        });
        child.stderr?.on("data", (buf) => {
          appendToBuffers(String(buf));
          void scheduleStateUpdate(false);
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          try {
            bashAbort.signal.removeEventListener("abort", onAbort);
          } catch {
            // ignore
          }
          finish({ ok: false, exitCode: null, error: e instanceof Error ? e.message : String(e) });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          try {
            bashAbort.signal.removeEventListener("abort", onAbort);
          } catch {
            // ignore
          }
          finish({ ok: code === 0, exitCode: code ?? null });
        });
      });
    };
    
    const results: string[] = [];
    let allSuccess = true;
    let blocked = 0;

    if (runAsBlock) {
      // HereDoc / cd 都需要整体作为脚本执行（保持 shell 状态与工作目录）
      if (mode === "safe") {
        const line = `⛔ 已拦截: (bash block)\n  原因: safe 模式下不允许脚本块执行（例如包含 cd/HereDoc/重定向/复合语法）。请改用 relaxed/unsafe，或拆成不含 cd 的单条命令。`;
        results.push(line);
        blocked += 1;
        allSuccess = false;
        appendToBuffers(`${line}\n\n`);
        await scheduleStateUpdate(true);
      } else {
        // relaxed/unsafe：执行整个 block（仍保持 cwd=workspace root）
        this.debug("info", "autoExecuteBash: executing bash block", { cwd, mode, hasHereDoc, hasCd });
        try {
          // relaxed 模式仍按行做一次安全检查（避免管道/后台/命令替换等）
          if (mode === "relaxed") {
            const linesToCheck = splitBashCommands(bashCmd);
            for (const line0 of linesToCheck) {
              const safety = checkBashCommandSafety(line0, mode);
              if (!safety.ok) {
                blocked += 1;
                allSuccess = false;
                results.push(`⛔ 已拦截: (bash block)\n  原因: ${safety.reason}\n  命令: ${line0}`);
                appendToBuffers(`${results[results.length - 1]}\n\n`);
                await scheduleStateUpdate(true);
                // 不中断 UI：继续走统一收尾逻辑
                throw new Error(`脚本块被拦截（relaxed）：${safety.reason}`);
              }
            }
          }
          appendToBuffers(`$ (bash block)\n`);
          const r = await runBashStreaming(bashCmd);
          results.push(r.ok ? `✓ (bash block)` : `✗ (bash block)\n  错误: ${r.error || "exit non-zero"}`);
          appendToBuffers(`\n[exit] ${r.exitCode ?? "?"}\n\n`);
          await scheduleStateUpdate(true);
        } catch (e) {
          allSuccess = false;
          const errorMsg = e instanceof Error ? e.message : String(e);
          results.push(`✗ (bash block)\n  错误: ${errorMsg}`);
          appendToBuffers(`\n✗ (bash block)\n  错误: ${errorMsg}\n\n`);
          await scheduleStateUpdate(true);
        }
      }
    } else {
      for (const cmd of commands) {
        this.debug("info", "autoExecuteBash: executing", { cmd, cwd });

        const safety = checkBashCommandSafety(cmd, mode);
        if (!safety.ok) {
          blocked += 1;
          allSuccess = false;
          const line = `⛔ 已拦截: ${cmd}\n  原因: ${safety.reason}`;
          results.push(line);
          appendToBuffers(`${line}\n\n`);
          await scheduleStateUpdate(true);
          this.debug("warn", "autoExecuteBash: blocked", { cmd, reason: safety.reason });
          continue;
        }
        
        try {
          appendToBuffers(`$ ${cmd}\n`);
          const r = await runBashStreaming(cmd);
          if (r.ok) {
            results.push(`✓ ${cmd}`);
            this.debug("info", "autoExecuteBash: command succeeded", { cmd });
          } else {
            allSuccess = false;
            results.push(`✗ ${cmd}\n  错误: ${r.error || "exit non-zero"}`);
            this.debug("error", "autoExecuteBash: command failed", { cmd, error: r.error || "exit non-zero" });
          }
          appendToBuffers(`\n[exit] ${r.exitCode ?? "?"}\n\n`);
          await scheduleStateUpdate(true);
        } catch (e) {
          allSuccess = false;
          const errorMsg = e instanceof Error ? e.message : String(e);
          results.push(`✗ ${cmd}\n  错误: ${errorMsg}`);
          this.debug("error", "autoExecuteBash: command failed", { cmd, error: errorMsg });
          appendToBuffers(`\n✗ ${cmd}\n  错误: ${errorMsg}\n\n`);
          await scheduleStateUpdate(true);
        }
      }
    }
    
    // 显示执行结果
    const resultTextFull = fullText || results.join("\n\n");
    this.output.appendLine("");
    this.output.appendLine(`[${new Date().toISOString()}] [bash] stream end (${threadId})`);
    const resultText = this.truncateForState(resultTextFull, "bash 执行结果");
    const summary =
      blocked > 0
        ? `⚠️ bash 已处理：${commands.length} 条（${blocked} 条被拦截）`
        : allSuccess
          ? `✅ bash 已执行：${commands.length} 条`
          : `⚠️ bash 执行存在失败：${commands.length} 条`;
    await this.notifyInChat(threadId, summary);
    // 不要 toast 弹条：只在对话框里输出 system
    
    // 结果对用户可见：同时写入聊天消息 + 上下文（便于后续生成 diff）
    await this.store.updateMessageText(threadId, bashMsgId, ["[bash 执行结果]", "", resultText].join("\n"));
    await this.store.addSnippet(threadId, "bash 执行结果", resultText);
    await this.pushState();
    
    this.debug("info", "autoExecuteBash: completed", { success: allSuccess });

    // 像 Claude Code：把 bash 的输出回传给模型，让它基于结果继续下一步（diff/toolcall/bash）
    if ((opts?.continueAfter ?? true) && !bashAbort.signal.aborted) {
      await this.continueAfterBashAuto(threadId);
    }
    if (this.activeBash?.threadId === threadId && this.activeBash?.messageId === bashMsgId) {
      this.activeBash = undefined;
    }
    return { summary, resultText };
  }

  private async continueAfterBashAuto(threadId: string) {
    if (!(await this.tryConsumeAutoChain(threadId, "bash->continue"))) return;
    // 若“其他线程”正在忙，不要打断它；本线程内的自动链继续允许执行
    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "continueAfterBashAuto: skip because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }
    const lastUser = await this.getLastUserIntent(threadId);
    const extra = [
      "---",
      "# 工具结果已产生",
      "我已执行了你输出的 bash 命令，执行结果已追加到上下文片段（标题：bash 执行结果），并在聊天记录里以 system 消息记录。",
      "现在请继续推进（不要复述用户需求）：",
      "",
      "【选择规则】",
      "- 需要改代码：输出 diff --git 开头的 unified diff",
      "- 还需要再查/再跑：输出 ```toolcall``` 或 ```bash```（会自动继续执行并回传结果）",
      "- 若你确认已完成：输出“最终回答”（不要任何代码块）",
      "",
      "【重要】严格遵守格式要求，不要输出解释文字。"
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(
      threadId,
      this.buildNeutralContinueUserText(),
      "patch",
      extra
    );
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `bashContinue: ${e.msg}`, e.data), deepThink: this.deepThinkMode }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "continueAfterBashAuto: done", { assistantChars: r.assistantText.length });

      // 继续自动处理（可能再次触发 toolcall/bash/diff）
      await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[继续失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "continueAfterBashAuto: failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  /**
   * 重新请求 diff（当补丁应用失败时）
   */
  private async retryDiffGeneration(threadId: string, errorMsg: string, retryCount: number, userText?: string) {
    const t = await this.store.getThread(threadId);
    const lastRaw = userText ?? t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
    const lastUser = this.extractUserIntent(lastRaw);
    if (lastUser) {
      this.lastUserIntent[threadId] = lastUser;
      this.lastUserIntentSig[threadId] = this.hashTextShort(lastUser);
      this.lastUserIntentTs[threadId] = Date.now();
    }
    const extra = [
      "---",
      "# 重要：上一次的 diff 补丁应用失败",
      `错误信息：${errorMsg}`,
      "",
      "请重新生成 unified diff 补丁，注意：",
      "- 确保 diff 格式正确（以 diff --git 开头）",
      "- 确保上下文行与当前文件内容匹配",
      "- 直接输出 diff，不要有任何解释",
      "",
      "现在直接输出正确的 diff --git 补丁："
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(threadId, lastUser, "patch", extra);
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    // 若“其他线程”正在忙，不要打断它；本线程内允许继续重试
    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "retryDiffGeneration: skip because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }
    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `retryDiff: ${e.msg}`, e.data), deepThink: this.deepThinkMode }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "retryDiffGeneration: done", { assistantChars: r.assistantText.length });

      // 继续处理回复（带重试计数）
      await this.autoProcessReply(threadId, r.assistantText, retryCount, lastUser);
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[重试失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "retryDiffGeneration: failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  /**
   * 自动应用 diff 补丁（不需要用户确认）
   */
  private async autoApplyDiff(threadId: string, diffText: string, opts?: { continueAfter?: boolean }) {
    if (this.readOnlyMode) {
      await this.notifyInChat(threadId, "🔒 只读模式：已拦截自动应用 diff。你可以点击消息里的「预览并应用补丁」手动确认。");
      return;
    }
    this.debug("info", "autoApplyDiff: starting", {
      diffChars: diffText.length,
      diffPreview: diffText.slice(0, 500),
      diffTail: diffText.slice(-200),
    });

    // 直接应用补丁，不需要确认
    const result = await applyPatchTextDirectly(diffText);

    const resultText = [
      `success: ${result.success}`,
      `applied(${result.applied.length}): ${result.applied.join(", ") || "-"}`,
      `failed(${result.failed.length}): ${result.failed.join("; ") || "-"}`,
    ].join("\n");

    if (result.applied.length > 0) {
      this.debug("info", "autoApplyDiff: applied", { files: result.applied });
      await this.notifyInChat(threadId, `✅ 已自动应用补丁：${result.applied.join(", ")}`);
    }

    if (result.failed.length > 0) {
      this.debug("warn", "autoApplyDiff: some failed", { errors: result.failed, failureDetails: result.failureDetails });
      await this.notifyInChat(threadId, `⚠️ 部分补丁失败：${result.failed.join("; ")}`);
    }

    if (!result.success && result.applied.length === 0) {
      this.debug("error", "autoApplyDiff: all failed", { errors: result.failed, failureDetails: result.failureDetails });

      // 构建详细错误信息，用于发送给 DeepSeek 重试
      let detailedError = `补丁应用失败：${result.failed.join("; ")}`;
      if (result.failureDetails.length > 0) {
        const details = result.failureDetails.map(d => {
          const lines = [`文件: ${d.file}`, `原因: ${d.reason}`];
          if (d.hunkInfo) lines.push(`位置: ${d.hunkInfo}`);
          if (d.patchContextLines?.length) {
            lines.push(`diff 中的上下文行:`);
            d.patchContextLines.forEach(l => lines.push(`  "${l}"`));
          }
          if (d.actualFileLines?.length) {
            lines.push(`文件实际内容:`);
            d.actualFileLines.forEach(l => lines.push(`  "${l}"`));
          }
          return lines.join("\n");
        }).join("\n---\n");
        detailedError += `\n\n详细信息:\n${details}`;
      }

      throw new Error(detailedError);
    }

    // 让结果可见 + 可用于后续继续（像 Claude Code）
    const summary =
      result.failed.length > 0 ? `⚠️ diff 已应用（部分失败）` : `✅ diff 已应用`;
    // 不要 toast 弹条：只在对话框里输出 system
    await this.notifyInChat(threadId, summary);
    await this.store.addMessage(threadId, "system", ["[diff 应用结果]", "", resultText].join("\n"));
    await this.store.addSnippet(threadId, "diff 应用结果", resultText);
    await this.pushState();

    // 根据用户要求：diff 成功也继续自动链，直到模型输出“最终回答”或用户点击停止。
    if (opts?.continueAfter ?? true) {
    await this.continueAfterDiffAuto(threadId);
    }
  }

  private async continueAfterDiffAuto(threadId: string) {
    if (!(await this.tryConsumeAutoChain(threadId, "diff->continue"))) return;
    // 若“其他线程”正在忙，不要打断它；本线程内的自动链继续允许执行
    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "continueAfterDiffAuto: skip because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }
    const lastUser = await this.getLastUserIntent(threadId);
    const extra = [
      "---",
      "# 补丁已应用",
      "我已自动应用你输出的 unified diff，应用结果已追加到上下文片段（标题：diff 应用结果），并在聊天记录里以 system 消息记录。",
      "现在请继续推进（不要复述用户需求）：",
      "",
      "【选择规则】",
      "- 若仍有失败项：优先输出一个新的 diff 修复失败（或必要时输出 toolcall/bash 进一步确认状态）",
      "- 若你确认已完成：输出“最终回答”（不要任何代码块）",
      "",
      "【重要】严格遵守格式要求，不要输出解释文字。"
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(
      threadId,
      this.buildNeutralContinueUserText(),
      "patch",
      extra
    );
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `diffContinue: ${e.msg}`, e.data), deepThink: this.deepThinkMode }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "continueAfterDiffAuto: done", { assistantChars: r.assistantText.length });

      await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[继续失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "continueAfterDiffAuto: failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  /**
   * 自动运行 toolcall 并继续（不需要用户确认）
   */
  private async runToolCallAndContinueAuto(threadId: string, callText: string) {
    const call = this.parseToolCall(callText);
    this.debug("info", "runToolCallAndContinueAuto: parsed", { threadId, tool: call.tool });

    // 直接运行工具，不需要确认
    let result: { tool: string; ok: boolean; title: string; content: string };
    try {
      result = await runToolCall(call);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = {
        tool: call.tool,
        ok: false,
        title: `${call.tool}: (failed)`,
        content: msg
      };
      this.debug("error", "runToolCallAndContinueAuto: tool failed", { tool: call.tool, error: msg });
    }
    await this.store.addSnippet(
      threadId,
      `工具结果: ${result.title}`,
      this.truncateForState(
      [
        `tool: ${result.tool}`,
        `ok: ${result.ok}`,
        "",
        result.content
        ].join("\n"),
        `工具结果: ${result.title}`
      )
    );
    await this.pushState();

    if (!(await this.tryConsumeAutoChain(threadId, "toolcall->continue"))) return;
    // 若“其他线程”正在忙，不要打断它；本线程内的自动链继续允许执行
    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "runToolCallAndContinueAuto: skip because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }

    // 自动继续：让模型基于"工具结果"决定下一步
    const lastUser = await this.getLastUserIntent(threadId);
    const extra = [
      "---",
      "# 强制指令",
      "我已执行了你的 toolcall 并返回了结果（见上下文片段）。",
      "现在请继续推进（不要复述用户需求）：",
      "",
      "【选择规则】",
      "- 如果需要修改文件内容：输出 diff --git 开头的 unified diff",
      "- 如果需要执行命令（如删除文件、创建目录、安装依赖）：输出 ```bash``` 代码块",
      "- 如果还需要更多信息：输出 ```toolcall``` 代码块",
      "- 若你确认已完成：输出“最终回答”（不要任何代码块）",
      "",
      "【格式要求】",
      "- diff：第一个字符必须是 d（diff --git 开头）",
      "- bash：必须是 ```bash\\n命令\\n``` 格式",
      "- 绝对禁止输出任何解释、前言、后语",
      "",
      "立刻输出！"
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(threadId, this.buildNeutralContinueUserText(), "patch", extra);
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `runToolCallAndContinueAuto: ${e.msg}`, e.data) }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "runToolCallAndContinueAuto: done", { assistantChars: r.assistantText.length });
      
      // 递归：继续自动处理回复
      await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "runToolCallAndContinueAuto: failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  private async runToolCallBatchAndContinueAuto(threadId: string, calls: ToolCall[]) {
    this.debug("info", "runToolCallBatchAndContinueAuto: start", { threadId, count: calls.length });

    // 依次执行多个 toolcall；只在最后继续一次，避免中间多轮“继续”打断/重入。
    for (const call of calls) {
      this.debug("info", "runToolCallBatchAndContinueAuto: running", { tool: call.tool });
      let result: { tool: string; ok: boolean; title: string; content: string };
      try {
        result = await runToolCall(call);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result = { tool: call.tool, ok: false, title: `${call.tool}: (failed)`, content: msg };
        this.debug("error", "runToolCallBatchAndContinueAuto: tool failed", { tool: call.tool, error: msg });
      }
      await this.store.addSnippet(
        threadId,
        `工具结果: ${result.title}`,
        this.truncateForState(
          [
            `tool: ${result.tool}`,
            `ok: ${result.ok}`,
            "",
            result.content
          ].join("\n"),
          `工具结果: ${result.title}`
        )
      );
      await this.pushState();
    }

    if (!(await this.tryConsumeAutoChain(threadId, "toolcall->continue"))) return;
    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "runToolCallBatchAndContinueAuto: skip because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }

    const lastUser = await this.getLastUserIntent(threadId);
    const extra = [
      "---",
      "# 强制指令",
      "我已执行了你输出的多条 toolcall 并返回了结果（见上下文片段）。",
      "现在请继续推进（不要复述用户需求）：",
      "",
      "【选择规则】",
      "- 如果需要修改文件内容：输出 diff --git 开头的 unified diff",
      "- 如果需要执行命令（如删除文件、创建目录、安装依赖）：输出 ```bash``` 代码块",
      "- 如果还需要更多信息：输出 ```toolcall``` 代码块",
      "- 若你确认已完成：输出“最终回答”（不要任何代码块）",
      "",
      "【格式要求】",
      "- diff：第一个字符必须是 d（diff --git 开头）",
      "- bash：必须是 ```bash\\n命令\\n``` 格式",
      "- 绝对禁止输出任何解释、前言、后语",
      "",
      "立刻输出！"
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(threadId, this.buildNeutralContinueUserText(), "patch", extra);
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `runToolCallBatchAndContinueAuto: ${e.msg}`, e.data) }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "runToolCallBatchAndContinueAuto: done", { assistantChars: r.assistantText.length });

      await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "runToolCallBatchAndContinueAuto: failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  private async runToolPlanAndGeneratePatch(threadId: string, planText: string) {
    // 解析 toolplan JSON
    let plan: any;
    try {
      plan = JSON.parse(planText);
    } catch {
      this.debug("error", "toolPlanRun: invalid JSON");
      throw new Error("toolplan 不是合法 JSON。");
    }
    const norm = this.normalizeToolPlanJson(plan);
    // 死循环判定：连续重复同一个 toolplan（read 列表 + notes）才停
    try {
      const sig = `toolplan:${this.stableStringify({ read: norm.read ?? [], notes: norm.notes ?? "" })}`;
      if (await this.stopIfRepeated(threadId, sig, "toolplan(repeated)")) return;
    } catch {
      // ignore repeat detection parse errors
    }
    const readList = Array.isArray(norm?.read) ? norm.read : [];
    const invalidReads: string[] = [];
    const relPaths = readList
      .map((x: unknown) => {
        if (typeof x !== "string") return undefined;
        const rp = this.sanitizeRelPath(x);
        if (!rp) invalidReads.push(x);
        return rp;
      })
      .filter(Boolean) as string[];

    this.debug("info", "toolPlanRun: parsed", { readCount: relPaths.length });
    if (invalidReads.length > 0) {
      await this.store.addSnippet(
        threadId,
        "工具读取: 被拦截的路径",
        [
          "以下路径被拦截（仅允许读取工作区内的相对路径）。",
          "如果你需要系统信息，请改用 bash（例如：```bash\\ncat /etc/issue\\n```）。",
          "",
          ...invalidReads.map((p) => `- ${p}`)
        ].join("\n")
      );
    }

    for (const rp of relPaths) {
      this.debug("info", "toolPlanRun: reading file", { path: rp });
      const contentFull = await this.readWorkspaceRelFile(rp);
      this.writeLargeToOutput(`工具读取(full): ${rp}`, contentFull);
      const content = this.truncateForState(contentFull, `工具读取: ${rp}`);
      await this.store.addSnippet(threadId, `工具读取: ${rp}`, content);
    }
    await this.pushState();

    if (!(await this.tryConsumeAutoChain(threadId, "toolplan->continue"))) return;

    const lastUser = await this.getLastUserIntent(threadId);
    const extra = [
      "---",
      "# 强制指令",
      "我已按你的 toolplan 读取了文件（见上下文片段）。",
      "现在请继续推进（不要复述用户需求）：",
      "",
      "【选择规则】",
      "- 如果需要修改文件内容：输出 diff --git 开头的 unified diff",
      "- 如果需要执行命令（如删除文件、创建目录、安装依赖）：输出 ```bash``` 代码块",
      "- 如果还需要更多信息：输出 ```toolcall``` 代码块",
      "- 若你确认已完成：输出“最终回答”（不要任何代码块）",
      "",
      "【格式要求】",
      "- diff：第一个字符必须是 d（diff --git 开头）",
      "- bash：必须是 ```bash\\n命令\\n``` 格式",
      "- 绝对禁止输出任何解释、前言、后语",
      "",
      "立刻输出！"
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(threadId, this.buildNeutralContinueUserText(), "patch", extra);
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };
    this.debug("info", "toolPlanRun: generate diff start", { assistantId, promptChars: prompt.length });
    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        {
          signal: abort.signal,
          debug: (e) => this.debug(e.level, `toolPlanRun: ${e.msg}`, e.data),
          deepThink: this.deepThinkMode
        }
      );
      this.debug("info", "toolPlanRun: generate diff done", { assistantChars: r.assistantText.length });
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      
      // 自动处理回复（可能是 diff 或其他 toolcall）
      await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
      this.debug("error", "toolPlanRun: generate diff failed", { error: e instanceof Error ? e.message : String(e) });
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  private async requestStrictReformat(threadId: string, badReply: string, reason: string) {
    // 不要把旧“用户需求”再塞回去（避免 DeepSeek 重新分析已解决问题）；
    // 这里只做“格式纠正”，让模型把上一条输出改成合规的单块输出。
    const extra = [
      "---",
      "# 格式纠正（只修格式，不要重新分析需求）",
      `原因：${reason}`,
      "",
      "你现在必须把上一条回复改写成合规输出：",
      "- 只允许输出：toolplan 或 diff 或 toolcall 或 bash 或 最终回答（五选一）",
      "- 当你选择输出 toolplan/toolcall/diff/bash：整条回复必须且只能包含一个对应的 markdown 代码块；代码块外一个字都不许有",
      "- diff：必须放进 ```diff``` 且以 diff --git 开头；并且一个 diff 里只允许一个文件（只允许一段 diff --git）",
      "- toolplan：必须是 {\"read\":[\"a\",\"b\"],\"notes\":\"\"}；禁止旧数组格式",
      "",
      "# 参考（这是需要你改写的原始内容，勿复述）",
      badReply.slice(0, 6000),
      "",
      "立刻输出合规内容："
    ].join("\n");

    const tooling = await this.buildToolingPromptForThread(threadId, "（格式纠正：只需按规则重排输出）", "patch", extra);
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    // 若“其他线程”正在忙，不要打断它；本线程内允许继续纠错
    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "requestStrictReformat: skip because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }
    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `formatFix: ${e.msg}`, e.data), deepThink: this.deepThinkMode }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "requestStrictReformat: done", { assistantChars: r.assistantText.length });

      await this.autoProcessReply(threadId, r.assistantText, 0, "（格式纠正：不再重复旧需求）");
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[格式纠正失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "requestStrictReformat: failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  private parseToolCall(callText: string): ToolCall {
    let obj: any;
    try {
      obj = JSON.parse(callText);
    } catch {
      throw new Error("toolcall 不是合法 JSON。");
    }
    const normalized = normalizeToolCallObject(obj);
    return normalized as ToolCall;
  }

  private async runToolCallAndContinue(threadId: string, callText: string) {
    const call = this.parseToolCall(callText);
    this.debug("info", "toolCallRun: parsed", { threadId, tool: call.tool });

    const confirm = await vscode.window.showWarningMessage(
      `确认在本地运行工具 ${call.tool} ?\n\n参数：${JSON.stringify(call.args ?? {}, null, 2)}`,
      { modal: true },
      "运行",
      "取消"
    );
    if (confirm !== "运行") {
      this.debug("warn", "toolCallRun: cancelled by user", { tool: call.tool });
      return;
    }

    // 运行工具并把结果写入上下文（失败也要变成“工具结果”，不要抛出中断）
    let result: { tool: string; ok: boolean; title: string; content: string };
    try {
      result = await runToolCall(call);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = {
        tool: call.tool,
        ok: false,
        title: `${call.tool}: (failed)`,
        content: msg
      };
      this.debug("error", "toolCallRun: tool failed", { tool: call.tool, error: msg });
    }
    await this.store.addSnippet(
      threadId,
      `工具结果: ${result.title}`,
      this.truncateForState(
      [
        `tool: ${result.tool}`,
        `ok: ${result.ok}`,
        "",
        result.content
        ].join("\n"),
        `工具结果: ${result.title}`
      )
    );
    await this.pushState();

    // 自动继续：让模型基于"工具结果"决定下一步（再 toolcall 或直接 diff）
    const t = await this.store.getThread(threadId);
    const lastUser = t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
    const extra = [
      "---",
      "# 强制指令",
      "我已执行了你的 toolcall 并返回了结果（见上下文片段）。",
      "",
      "【下一步规则】二选一：",
      "A) 如果仍需更多信息：输出 ```toolcall``` 代码块（JSON 在代码块内）",
      "B) 如果信息足够：直接输出 diff --git 开头的 unified diff",
      "",
      "【格式要求】",
      "- 选 A：整个 JSON 必须在 ```toolcall``` 代码块内，代码块外无任何文字",
      "- 选 B：第一个字符必须是 d（diff --git 开头），无任何前言后语",
      "",
      "绝对禁止输出任何解释！立刻输出！"
    ].join("\n");
    const tooling = await this.buildToolingPromptForThread(threadId, lastUser || "（继续基于最新工具结果完成用户需求）", "patch", extra);
    const prompt = tooling.prompt;

    const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await this.store.addMessage(threadId, "assistant", "", assistantId);
    await this.pushState();

    if (this.isBusyOtherThread(threadId)) {
      this.debug("warn", "toolCallRun: skip continue because busy(other thread)", { activeThreadId: this.active?.threadId });
      return;
    }
    const abort = new AbortController();
    this.active = { threadId, messageId: assistantId, abort, lastText: "" };

    try {
      const r = await this.deepseek.sendStreamingWithDebug(
        prompt,
        async (u) => {
          if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId) return;
          this.active.lastText = u.text;
          this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
        },
        { signal: abort.signal, debug: (e) => this.debug(e.level, `toolCallRun: ${e.msg}`, e.data), deepThink: this.deepThinkMode }
      );
      await this.store.updateMessageText(threadId, assistantId, r.assistantText);
      await this.store.updateWebContext(threadId, tooling.after);
      await this.pushState();
      this.debug("info", "toolCallRun: continue done", { assistantChars: r.assistantText.length });
    } catch (e) {
      const last = this.active?.lastText || "";
      const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
      await this.store.updateMessageText(threadId, assistantId, msgText);
      await this.pushState();
      this.debug("error", "toolCallRun: continue failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.active?.threadId === threadId && this.active?.messageId === assistantId) this.active = undefined;
    }
  }

  private _getHtml(webview: vscode.Webview) {
    const nonce = String(Date.now());
    const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const stylesCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "styles.css"));
    const iconSvg = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg"));

    // 注意：很多网站会用 X-Frame-Options / CSP 禁止被 iframe。
    // 所以我们以“插件内嵌聊天 UI”为主，Playwright 负责打开真实浏览器用于登录/会话。

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'none';
      img-src ${webview.cspSource} https: data:;
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      frame-src https:;
    " />
    <link rel="stylesheet" href="${stylesCss}" />
    <title>Deepseek Coder</title>
  </head>
  <body>
    <header class="headerSlim">
      <div class="headerLeft">
        <img class="appIcon" src="${iconSvg}" alt="Deepseek Coder" />
        <div class="appTitle">Deepseek Coder</div>
      </div>
      <div class="headerRight">
        <button id="btn-menu" class="iconBtn" title="菜单">☰</button>
      </div>
    </header>

    <div id="drawerOverlay" class="drawerOverlay hidden"></div>
    <aside id="drawer" class="drawer hidden" aria-label="menu">
      <div class="drawerHeader">
        <div class="drawerTitle">菜单</div>
        <button id="btn-drawer-close" class="iconBtn" title="关闭">✕</button>
      </div>
      <div class="drawerBody">
        <div class="drawerSection">
          <div class="drawerRow">
            <button id="btn-nav-chat" class="pill is-active" type="button">Chat</button>
          </div>
          <div class="muted">精简模式：仅保留 Chat</div>
        </div>

        <!-- 单页会话：不提供线程历史/导出/切换 -->

        <div class="drawerSection">
          <div class="drawerRow">
            <button id="btn-open-playwright" class="btn btn-sm" type="button">Playwright 打开 DeepSeek（可登录）</button>
            <button id="btn-rollback" class="btn btn-secondary btn-sm" type="button">回滚上一次改动</button>
          </div>
          <label class="check">
            <input id="chk-readonly" type="checkbox" />
            <span>只读模式（不自动应用 diff / 执行 bash）</span>
          </label>
          <label class="check">
            <input id="chk-tool-plan" type="checkbox" checked />
            <span>需要时先输出工具计划（读文件前需要确认）</span>
          </label>
          <div class="muted">上下文将自动按增量注入（仅首次/新增片段时发送）。</div>
        </div>

        <!-- 已移除“提示（可折叠）”UI：保持界面极简 -->
      </div>
    </aside>

    <section class="panel is-active" id="tab-chat">
      <div class="chatWrap">
        <div id="chatList" class="chatList" aria-label="chat messages"></div>
        <div class="chatComposer">
          <div class="composerBar">
            <textarea id="chatInput" class="chatInput" placeholder="输入你的需求…" spellcheck="false"></textarea>
            <div class="composerRight">
              <div class="composerTop">
                <label class="check check-compact" title="启用 DeepThink（更强推理，可能更慢）">
                  <input id="chk-deepthink" type="checkbox" />
                  <span>DeepThink</span>
                </label>
              </div>
              <div class="composerBtns">
            <button id="btn-send-chat" class="iconBtn iconBtnPrimary" title="发送">↑</button>
            <button id="btn-cancel" class="iconBtn" title="停止" disabled>■</button>
          </div>
        </div>
      </div>
      </div>
      </div>
    </section>

    <div id="toast" class="toast" hidden></div>
    <script nonce="${nonce}" src="${mainJs}"></script>
  </body>
</html>`;
  }
}


