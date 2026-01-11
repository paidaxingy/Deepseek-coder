"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepSeekViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const readFile_1 = require("../workspace/readFile");
const threadStore_1 = require("../state/threadStore");
const path = __importStar(require("path"));
const tools_1 = require("../workspace/tools");
const workspaceRoot_1 = require("../workspace/workspaceRoot");
const applyPatch_1 = require("../workspace/applyPatch");
const rollback_1 = require("../workspace/rollback");
const bash_1 = require("../workspace/bash");
const toolcall_1 = require("../workspace/toolcall");
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
class DeepSeekViewProvider {
    context;
    deepseek;
    static viewType = "deepseekCoder.sidebarView";
    WEB_PROMPT_SIGNATURE = "【Deepseek-Coder Prompt v2】";
    _view;
    store;
    currentThreadId;
    active;
    output = vscode.window.createOutputChannel("Deepseek Coder");
    debugBuf = [];
    DEBUG_MAX = 300;
    READONLY_KEY = "deepseekCoder.readOnlyMode";
    readOnlyMode = false;
    deepThinkMode = false;
    MOVED_AUX_KEY = "deepseekCoder.movedToAuxSidebarOnce";
    // 兜底：防止真正的无限自动链。不要太小（正常工作流会连续很多步）。
    MAX_AUTO_CHAIN = 30;
    autoChainCount = Object.create(null);
    // 用户点“停止”后：终止后续自动链（diff->continue / bash->continue / toolcall->continue / toolplan->continue）
    autoChainPaused = Object.create(null);
    // 死循环判定：连续重复的“同一种动作签名”达到阈值才暂停
    REPEAT_LIMIT = 3;
    lastRepeatSig = Object.create(null);
    repeatCount = Object.create(null);
    constructor(context, deepseek) {
        this.context = context;
        this.deepseek = deepseek;
        this.store = new threadStore_1.ThreadStore(context);
        this.readOnlyMode = this.context.workspaceState.get(this.READONLY_KEY) ?? false;
        this.deepThinkMode = false;
    }
    withSignature(body) {
        const s = (body || "").trim();
        if (!s)
            return this.WEB_PROMPT_SIGNATURE;
        if (s.startsWith(this.WEB_PROMPT_SIGNATURE))
            return s;
        return [this.WEB_PROMPT_SIGNATURE, "", s].join("\n");
    }
    formatSnippetBlock(snippets) {
        const parts = [];
        for (const s of snippets) {
            parts.push(`\n---\n# ${s.title}\n\n${s.content}\n`);
        }
        return parts.join("\n");
    }
    buildDeltaToolingPrompt(pendingSnippets, userText, mode, extraSection) {
        const parts = [];
        parts.push(this.WEB_PROMPT_SIGNATURE);
        const shouldIncludeRules = pendingSnippets.length > 0 || mode === "toolplan" || Boolean(extraSection?.trim());
        if (shouldIncludeRules) {
            parts.push([
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
            ].join("\n"));
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
            parts.push([
                "---",
                "# 强制指令",
                "现在你必须输出 toolplan 格式（只输出一个 ```toolplan``` 代码块，代码块内为 JSON，含 read 数组与 notes 字符串；代码块外无任何文字）。",
                "输出完 toolplan 代码块立刻停止。",
                "重要：toolplan 只是“读取清单/说明”，扩展会自动执行读取并把结果追加到上下文，然后会在同一对话中继续让你输出下一步（通常是 diff/bash/最终回答）。这一步不要输出 bash/diff/toolcall。",
            ].join("\n"));
        }
        return parts.join("\n\n");
    }
    async buildToolingPromptForThread(threadId, userText, mode, extraSection) {
        const thread = await this.store.getThread(threadId);
        const snippets = thread?.snippets ?? [];
        const webContext = await this.store.getWebContext(threadId);
        const sent = Math.max(0, Math.min(webContext.sentSnippetCount, snippets.length));
        const pending = snippets.slice(sent);
        const base = !webContext.bootstrapped
            ? mode === "toolplan"
                ? this.buildToolPlanPrompt(pending, userText)
                : this.buildPatchPrompt(pending, userText)
            : this.buildDeltaToolingPrompt(pending, userText, mode, extraSection);
        const prompt = this.withSignature(base);
        const after = { bootstrapped: true, sentSnippetCount: snippets.length };
        return { prompt, after };
    }
    async addContextSnippet(snippet) {
        const tid = await this.ensureThread();
        await this.store.addSnippet(tid, snippet.title, snippet.content);
        await this.pushState();
    }
    resolveWebviewView(view) {
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
            const movedState = this.context.globalState.get(this.MOVED_AUX_KEY);
            const movedOk = movedState === "success";
            if (movedOk)
                return;
            try {
                this.debug("info", "aux sidebar auto-move: start", { movedState });
                const cmds = await vscode.commands.getCommands(true);
                const has = (c) => cmds.includes(c);
                const tryCmd = async (c) => {
                    if (!has(c))
                        return false;
                    try {
                        await vscode.commands.executeCommand(c);
                        return true;
                    }
                    catch {
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
                }
                else {
                    await this.context.globalState.update(this.MOVED_AUX_KEY, "failed");
                    this.debug("warn", "no move-to-auxiliary-sidebar command available; leaving layout unchanged", {
                        found: cmds.filter((c) => /auxiliary|secondarySideBar|moveView/i.test(c)).slice(0, 40)
                    });
                }
            }
            catch (e) {
                this.debug("warn", "move to auxiliary sidebar failed (ignored)", { error: e instanceof Error ? e.message : String(e) });
            }
        })();
        view.webview.onDidReceiveMessage(async (msg) => {
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
                        }
                        catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            const missingBrowser = /Executable doesn't exist/i.test(msg) ||
                                /playwright install/i.test(msg) ||
                                /Looks like Playwright was just installed/i.test(msg);
                            const missingLib = /error while loading shared libraries:\s*([^\s:]+):/i.exec(msg)?.[1];
                            if (missingBrowser) {
                                const pick = await vscode.window.showWarningMessage([
                                    "Playwright Chromium 未安装或不可用。",
                                    "首次使用需要下载浏览器二进制（联网）。",
                                    "",
                                    "要现在安装吗？"
                                ].join("\n"), { modal: true }, "安装 Chromium");
                                if (pick) {
                                    await vscode.commands.executeCommand("deepseekCoder.installPlaywrightChromium");
                                }
                                await this.notify([
                                    "⚠️ Playwright Chromium 未就绪。",
                                    "",
                                    "你可以运行命令：",
                                    "Deepseek Coder: 安装 Playwright Chromium（首次使用）",
                                    "",
                                    `原始错误：${msg}`
                                ].join("\n"));
                            }
                            else if (missingLib) {
                                await this.notify([
                                    `❌ Playwright 打开失败：缺少系统依赖库 ${missingLib}`,
                                    "",
                                    "这通常是系统缺少 Chromium 运行依赖（Linux/WSL 常见）。",
                                    "请按你的发行版安装缺失库（可能需要 sudo）。",
                                    "",
                                    "常见（Debian/Ubuntu）示例：",
                                    "sudo apt-get update && sudo apt-get install -y libnspr4 libnss3"
                                ].join("\n"));
                            }
                            else {
                                await this.notify([
                                    `❌ Playwright 打开失败：${msg}`,
                                    "",
                                    "可尝试先运行命令安装浏览器：",
                                    "Deepseek Coder: 安装 Playwright Chromium（首次使用）"
                                ].join("\n"));
                            }
                        }
                        return;
                    case "rollbackLast": {
                        const r = await (0, rollback_1.rollbackLast)();
                        await this.notifyInChat(await this.ensureThread(), r.ok ? `↩️ ${r.message}` : `⚠️ ${r.message}`);
                        return;
                    }
                    case "setReadOnly": {
                        await this.setReadOnly(!!msg.enabled);
                        await this.notifyInChat(await this.ensureThread(), this.readOnlyMode ? "🔒 已开启只读模式：不自动应用 diff / 不自动执行 bash。" : "✅ 已关闭只读模式：允许自动应用 diff / 自动执行 bash。");
                        return;
                    }
                    case "setDeepThink": {
                        this.deepThinkMode = !!msg.enabled;
                        this.debug("info", "setDeepThink", { enabled: this.deepThinkMode });
                        await this.notifyInChat(await this.ensureThread(), `DeepThink：${this.deepThinkMode ? "开启" : "关闭"}`);
                        try {
                            await this.deepseek.setDeepThink(this.deepThinkMode, (e) => this.debug(e.level, e.msg, e.data));
                        }
                        catch (e) {
                            this.debug("warn", "setDeepThink failed (ignored)", { error: e instanceof Error ? e.message : String(e) });
                        }
                        return;
                    }
                    case "bashRun": {
                        const tid = await this.ensureThread();
                        const bashText = String(msg.bashText || "").trim();
                        if (!bashText)
                            return;
                        // 用户点击按钮视为“确认执行”，即便只读模式也允许执行这一条
                        await this.notifyInChat(tid, "▶️ 已确认：开始执行 bash…");
                        try {
                            await this.autoExecuteBash(tid, bashText, { bypassReadOnly: true });
                        }
                        catch (e) {
                            await this.notifyInChat(tid, `❌ bash 执行失败：${e instanceof Error ? e.message : String(e)}`);
                        }
                        return;
                    }
                    case "chatSend": {
                        const tid = await this.ensureThread();
                        this.resetAutoChain(tid);
                        const userText = msg.userText?.trim() || "";
                        if (!userText)
                            return;
                        this.deepThinkMode = !!msg.deepThink;
                        // 若已有在跑的请求，先取消（避免并发写同一线程）
                        if (this.active?.abort) {
                            this.debug("warn", "auto-cancel previous request (new send)");
                            this.active.abort.abort();
                        }
                        await this.store.addMessage(tid, "user", userText);
                        await this.pushState();
                        // 统一策略：去掉“做项目/介绍项目/查环境”等特殊判断，永远走同一套 tooling prompt。
                        // 让模型在 toolplan/toolcall/diff/bash/最终回答 中自选。
                        // toolplan 的“强制指令”只在确实需要本地信息时启用，
                        // 否则像“你好/今天星期几”这类会被误导强制输出 toolplan。
                        const needLocal = this.shouldAutoExecuteForUserText(userText);
                        const mode = needLocal && (msg.planFirst ?? false) ? "toolplan" : "patch";
                        const tooling = await this.buildToolingPromptForThread(tid, userText, mode);
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
                            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                                if (!this.active || this.active.threadId !== tid || this.active.messageId !== assistantId)
                                    return;
                                this.active.lastText = u.text;
                                this._post({ type: "assistantStream", threadId: tid, messageId: assistantId, text: u.text, done: u.done });
                            }, {
                                signal: abort.signal,
                                debug: (e) => this.debug(e.level, e.msg, e.data),
                                deepThink: this.deepThinkMode
                            });
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
                                await this.autoProcessReply(tid, finalOut, 0, userText);
                            }
                            catch (e) {
                                this.debug("error", "autoProcessReply failed (ignored)", { error: e instanceof Error ? e.message : String(e) });
                            }
                        }
                        catch (e) {
                            const last = this.active?.lastText || "";
                            const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
                            this.debug("error", "send failed", { error: e instanceof Error ? e.message : String(e) });
                            await this.store.updateMessageText(tid, assistantId, msgText);
                            await this.pushState();
                        }
                        finally {
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
                        if (!prompt)
                            return;
                        if (this.active?.abort) {
                            this.debug("warn", "auto-cancel previous request (new raw send)");
                            this.active.abort.abort();
                        }
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
                            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                                if (!this.active || this.active.threadId !== tid || this.active.messageId !== assistantId)
                                    return;
                                this.active.lastText = u.text;
                                this._post({ type: "assistantStream", threadId: tid, messageId: assistantId, text: u.text, done: u.done });
                            }, {
                                signal: abort.signal,
                                debug: (e) => this.debug(e.level, e.msg, e.data),
                                deepThink: this.deepThinkMode
                            });
                            await this.store.updateMessageText(tid, assistantId, r.assistantText);
                            await this.pushState();
                            // 如果该 raw prompt 明确表示“这是我们生成的上下文提示词”，则把进度标记为已发送
                            if (msg.markContextAsSent) {
                                const thread = await this.store.getThread(tid);
                                const snippets = thread?.snippets ?? [];
                                await this.store.updateWebContext(tid, { bootstrapped: true, sentSnippetCount: snippets.length });
                                await this.pushState();
                            }
                        }
                        catch (e) {
                            const last = this.active?.lastText || "";
                            const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
                            this.debug("error", "raw send failed", { error: e instanceof Error ? e.message : String(e) });
                            await this.store.updateMessageText(tid, assistantId, msgText);
                            await this.pushState();
                        }
                        finally {
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
                        if (this.active?.threadId)
                            this.pauseAutoChain(this.active.threadId);
                        this.active?.abort.abort();
                        try {
                            await this.deepseek.stopGenerating((e) => this.debug(e.level, `stopGenerating: ${e.msg}`, e.data));
                        }
                        catch {
                            // ignore
                        }
                        // 不用 VSCode 弹窗，直接在对话里提示
                        if (this.active?.threadId)
                            await this.notifyInChat(this.active.threadId, "⏹️ 已停止：终止自动链，并尝试停止网页端生成。");
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
                        // 精简模式：不暴露 applyPatchText 命令；直接预览并确认
                        await (0, applyPatch_1.applyPatchTextWithPreviewAndConfirm)(msg.patchText);
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
                        if (!pick?.[0])
                            return;
                        const uri = pick[0];
                        const rel = vscode.workspace.asRelativePath(uri);
                        const content = await (0, readFile_1.readWorkspaceTextFile)(uri);
                        await this.addContextSnippet({ title: `文件: ${rel}`, content });
                        return;
                    }
                    case "copyPrompt": {
                        await vscode.env.clipboard.writeText(msg.prompt);
                        await this.notifyInChat(await this.ensureThread(), "✅ 提示词已复制到剪贴板。");
                        return;
                    }
                    case "threadCreate": {
                        const title = typeof msg.title === "string" && msg.title.trim()
                            ? msg.title.trim()
                            : (await vscode.window.showInputBox({
                                title: "新建对话线程",
                                prompt: "可选：输入线程标题（留空则自动生成）",
                                placeHolder: "例如：修复 xxx bug / 实现 yyy 功能"
                            })) ?? "";
                        await this.store.createThread(title);
                        this.currentThreadId = undefined;
                        await this.ensureThread();
                        this.resetAutoChain(this.currentThreadId);
                        await this.pushState();
                        return;
                    }
                    case "threadSwitch": {
                        await this.store.setCurrentThread(msg.threadId);
                        this.currentThreadId = undefined;
                        await this.ensureThread();
                        this.resetAutoChain(this.currentThreadId);
                        await this.pushState();
                        return;
                    }
                    case "threadClear": {
                        const pick = await vscode.window.showWarningMessage("确认清空当前线程的消息和上下文？", { modal: true }, "清空", "取消");
                        if (pick !== "清空")
                            return;
                        await this.store.clearThread(msg.threadId);
                        await this.store.setCurrentThread(msg.threadId);
                        this.currentThreadId = undefined;
                        await this.ensureThread();
                        this.resetAutoChain(this.currentThreadId);
                        await this.pushState();
                        return;
                    }
                    case "threadDelete": {
                        const pick = await vscode.window.showWarningMessage("确认删除当前线程？此操作不可撤销。", { modal: true }, "删除", "取消");
                        if (pick !== "删除")
                            return;
                        await this.store.deleteThread(msg.threadId);
                        // 重新同步：删除的可能就是当前线程
                        this.currentThreadId = undefined;
                        await this.ensureThread();
                        this.resetAutoChain(this.currentThreadId);
                        await this.pushState();
                        return;
                    }
                    case "threadExport": {
                        const content = msg.format === "markdown"
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
                        this.debug("info", "toolPlanRun", { threadId: tid, planChars: msg.planText?.length ?? 0 });
                        await this.runToolPlanAndGeneratePatch(tid, msg.planText);
                        return;
                    }
                    case "toolCallRun": {
                        const tid = await this.ensureThread();
                        await this.runToolCallAndContinue(tid, msg.callText);
                        return;
                    }
                }
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                this._post({ type: "error", message });
            }
        });
    }
    async notifyInChat(threadId, text) {
        const msg = String(text || "").trim();
        if (!msg)
            return;
        await this.store.addMessage(threadId, "system", msg);
        await this.pushState();
    }
    async notify(text) {
        const tid = await this.ensureThread();
        await this.notifyInChat(tid, text);
    }
    _post(message) {
        this._view?.webview.postMessage(message);
    }
    setBusy(busy) {
        this._post({ type: "requestState", busy: !!busy });
    }
    async setReadOnly(enabled) {
        this.readOnlyMode = !!enabled;
        await this.context.workspaceState.update(this.READONLY_KEY, this.readOnlyMode);
        this._post({ type: "readOnlyState", enabled: this.readOnlyMode });
    }
    debug(level, msg, data) {
        const ts = new Date().toISOString();
        const tail = data ? ` ${JSON.stringify(data)}` : "";
        const line = `[${ts}] [${level}] ${msg}${tail}`;
        this.debugBuf.push(line);
        if (this.debugBuf.length > this.DEBUG_MAX)
            this.debugBuf.splice(0, this.debugBuf.length - this.DEBUG_MAX);
        this.output.appendLine(line);
        this._post({ type: "debugAppend", line });
    }
    resetAutoChain(threadId) {
        this.autoChainCount[threadId] = 0;
        this.lastRepeatSig[threadId] = "";
        this.repeatCount[threadId] = 0;
        this.autoChainPaused[threadId] = false;
    }
    pauseAutoChain(threadId) {
        this.autoChainPaused[threadId] = true;
    }
    shouldAutoExecuteForUserText(userText) {
        const t = String(userText || "").trim();
        if (!t)
            return false;
        // 用户明确提到“文件/目录/代码/命令/补丁/运行”等，就允许自动链
        if (/[\\/]/.test(t))
            return true;
        if (/(diff|patch|补丁|修改|改动|修复|实现|重构|重命名|删除|创建|新建|生成|安装|运行|执行|命令|终端|bash|toolplan|toolcall|读取|查看|列出|搜索|查找|文件|目录|工程|项目|build|test|npm|pnpm|yarn|git)/i.test(t)) {
            return true;
        }
        return false;
    }
    stableStringify(x) {
        const seen = new WeakSet();
        const norm = (v) => {
            if (v == null)
                return v;
            if (typeof v !== "object")
                return v;
            if (seen.has(v))
                return "[Circular]";
            seen.add(v);
            if (Array.isArray(v))
                return v.map(norm);
            const out = {};
            for (const k of Object.keys(v).sort())
                out[k] = norm(v[k]);
            return out;
        };
        return JSON.stringify(norm(x));
    }
    extractFirstJsonObjectFrom(text, startIdx) {
        const s = String(text || "");
        let i = Math.max(0, startIdx | 0);
        while (i < s.length && s[i] !== "{")
            i++;
        if (i >= s.length)
            return "";
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < s.length; j++) {
            const ch = s[j];
            if (inStr) {
                if (esc)
                    esc = false;
                else if (ch === "\\")
                    esc = true;
                else if (ch === "\"")
                    inStr = false;
                continue;
            }
            if (ch === "\"") {
                inStr = true;
                continue;
            }
            if (ch === "{")
                depth++;
            if (ch === "}") {
                depth--;
                if (depth === 0)
                    return s.slice(i, j + 1);
            }
        }
        return "";
    }
    normalizeTextToLines(text) {
        const s = String(text ?? "").replace(/\r\n/g, "\n");
        const lines = s.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "")
            lines.pop();
        return lines;
    }
    buildFullFileUnifiedDiff(opts) {
        const { relPath, oldText, newText, isNewFile } = opts;
        const oldLines = this.normalizeTextToLines(oldText);
        const newLines = this.normalizeTextToLines(newText);
        const oldCount = oldLines.length;
        const newCount = newLines.length;
        const header = [];
        header.push(`diff --git a/${relPath} b/${relPath}`);
        if (isNewFile)
            header.push("new file mode 100644");
        header.push(isNewFile ? "--- /dev/null" : `--- a/${relPath}`);
        header.push(`+++ b/${relPath}`);
        header.push(isNewFile ? `@@ -0,0 +1,${newCount} @@` : `@@ -1,${oldCount} +1,${newCount} @@`);
        const body = [];
        if (!isNewFile) {
            for (const l of oldLines)
                body.push(`-${l}`);
        }
        for (const l of newLines)
            body.push(`+${l}`);
        return [...header, ...body, ""].join("\n");
    }
    async buildWriteFileAsDiff(filePathRaw, content) {
        const relPath = this.sanitizeRelPath(filePathRaw) ?? this.sanitizeRelPath(filePathRaw.replace(/^[.][/\\\\]/, ""));
        if (!relPath)
            return undefined;
        const root = await (0, workspaceRoot_1.getOrPickWorkspaceRootUri)();
        const uri = vscode.Uri.joinPath(root, relPath);
        let exists = false;
        let oldText = "";
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            exists = Boolean(stat.type & vscode.FileType.File);
        }
        catch {
            exists = false;
        }
        if (exists) {
            const data = await vscode.workspace.fs.readFile(uri);
            oldText = Buffer.from(data).toString("utf8");
        }
        return this.buildFullFileUnifiedDiff({ relPath, oldText, newText: String(content ?? ""), isNewFile: !exists });
    }
    async tryRepairUnsupportedToolOutputs(threadId, replyText) {
        const raw = String(replyText || "");
        const idx = raw.search(/(^|\n)\s*toolcall\b/i);
        if (idx === -1)
            return undefined;
        const jsonText = this.extractFirstJsonObjectFrom(raw, idx);
        if (!jsonText)
            return undefined;
        let obj;
        try {
            obj = JSON.parse(jsonText);
        }
        catch {
            return undefined;
        }
        // 已支持的标准 toolcall：交给正常解析流程
        if (typeof obj?.tool === "string" && obj?.args != null)
            return undefined;
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
            if (!diffText)
                return undefined;
            // 记录一下：我们把“自造工具”纠正成了 diff（更像 Claude Code）
            this.debug("warn", "repaired unsupported toolcall(write_file)->diff", { filePath });
            return { kind: "diff", diffText };
        }
        void threadId;
        return undefined;
    }
    async stopIfRepeated(threadId, signature, reason) {
        const prev = this.lastRepeatSig[threadId] || "";
        const nextCount = prev === signature ? (this.repeatCount[threadId] ?? 0) + 1 : 1;
        this.lastRepeatSig[threadId] = signature;
        this.repeatCount[threadId] = nextCount;
        if (nextCount < this.REPEAT_LIMIT)
            return false;
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
    async tryConsumeAutoChain(threadId, reason) {
        if (this.autoChainPaused[threadId]) {
            this.debug("warn", "autoChain paused; skip", { threadId, reason });
            return false;
        }
        const n = (this.autoChainCount[threadId] ?? 0) + 1;
        this.autoChainCount[threadId] = n;
        if (n <= this.MAX_AUTO_CHAIN)
            return true;
        const message = `⏸️ 已暂停自动链式执行（防止循环）：超过上限 ${this.MAX_AUTO_CHAIN}（原因：${reason}）`;
        this.debug("warn", "autoChain: stopped", { threadId, reason, n, max: this.MAX_AUTO_CHAIN });
        // 不要 toast 弹条：只在对话框里输出 system
        await this.store.addMessage(threadId, "system", message);
        await this.pushState();
        return false;
    }
    async maybeAutoOpenPlaywright() {
        const enabled = vscode.workspace.getConfiguration().get("deepseekCoder.autoOpenPlaywright") ?? false;
        if (!enabled)
            return;
        try {
            this.debug("info", "autoOpenPlaywright: opening");
            await this.deepseek.openAndLetUserLogin();
            this.debug("info", "autoOpenPlaywright: opened");
        }
        catch (e) {
            this.debug("error", "autoOpenPlaywright: failed", { error: e instanceof Error ? e.message : String(e) });
            const msg = e instanceof Error ? e.message : String(e);
            const missingBrowser = /Executable doesn't exist/i.test(msg) ||
                /playwright install/i.test(msg) ||
                /Looks like Playwright was just installed/i.test(msg);
            if (missingBrowser) {
                const tid = await this.ensureThread();
                await this.notifyInChat(tid, [
                    "⚠️ Playwright Chromium 未就绪：自动打开失败。",
                    "请运行命令安装浏览器：`Deepseek Coder: 安装 Playwright Chromium（首次使用）`"
                ].join("\n"));
            }
        }
    }
    async ensureFreshThreadOnEnter() {
        // 需求：每次进入面板默认“清空上次对话”，但保留历史（可切换/可删除）。
        // 为避免把正在流式生成的线程切走，这里在 active 时不做自动切换。
        if (this.active?.abort)
            return await this.ensureThread();
        const tid = await this.store.ensureCurrentThread();
        const t = await this.store.getThread(tid);
        const hasContent = (t?.messages?.length ?? 0) > 0 || (t?.snippets?.length ?? 0) > 0;
        if (hasContent) {
            await this.store.createThread();
            this.currentThreadId = undefined;
        }
        return await this.ensureThread();
    }
    async ensureThread() {
        this.currentThreadId = await this.store.ensureCurrentThread();
        return this.currentThreadId;
    }
    async getStatePayload() {
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
    async pushInit() {
        const p = await this.getStatePayload();
        this._post({ type: "init", ...p });
    }
    async pushState() {
        const p = await this.getStatePayload();
        this._post({ type: "state", ...p });
    }
    async clearCurrentContext() {
        const tid = await this.ensureThread();
        await this.store.clearSnippets(tid);
    }
    buildPrompt(snippets, userText) {
        const parts = [];
        parts.push([
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
            "",
            "# Claude Code 风格的行为准则（必须遵守）",
            "- 优先最小动作：能直接回答就不要调用工具",
            "- 需要信息再动手：不确定文件路径/内容 → 先输出 toolplan 读取再继续",
            "- 你计划“新建”的文件：不要在 toolplan 里去 read（会读不到并产生噪音）；请用 bash 创建或用 diff new file 直接新增",
            "- bash 尽量简单：允许 &&/||；避免管道 |、命令替换 $() 等高风险语法（可能被安全策略拦截/要求确认）",
            "- 禁止使用 cd（扩展端逐条执行命令，cd 不会保留；请用相对路径例如 demo/index.html）",
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
            "【重要】只能输出这一个 ```diff``` 代码块；代码块外不能有任何文字！（禁止输出裸 diff，必须放进 ```diff 代码块）",
            "【重要】凡是“写代码/生成文件/修改文件内容”，必须使用 diff；禁止用 bash 的 cat/echo/heredoc 去写入源代码。",
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
        ].join("\n"));
        for (const s of snippets) {
            parts.push(`\n---\n# ${s.title}\n\n${s.content}\n`);
        }
        parts.push([
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
        ].join("\n"));
        return parts.join("\n");
    }
    buildPatchPrompt(snippets, userText) {
        return this.buildPrompt(snippets, userText);
    }
    buildToolPlanPrompt(snippets, userText) {
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
    sanitizeRelPath(p) {
        const s = (p || "").trim();
        if (!s)
            return undefined;
        if (path.isAbsolute(s))
            return undefined;
        const norm = s.replace(/\\/g, "/");
        const clean = path.posix.normalize(norm);
        if (clean.startsWith(".."))
            return undefined;
        return clean;
    }
    async readWorkspaceRelFile(relPath) {
        const root = await (0, workspaceRoot_1.getOrPickWorkspaceRootUri)();
        const uri = relPath ? vscode.Uri.joinPath(root, relPath) : root;
        let stat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return `/* 路径不存在或无法访问：${relPath || "."}\n${msg}\n*/`;
        }
        if (stat.type & vscode.FileType.Directory) {
            let entries;
            try {
                entries = await vscode.workspace.fs.readDirectory(uri);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return `/* 读取目录失败：${relPath || "."}\n${msg}\n*/`;
            }
            const lines = entries.slice(0, 300).map(([name, type]) => {
                const t = type === vscode.FileType.Directory ? "dir" : type === vscode.FileType.File ? "file" : "other";
                return `${t}\t${relPath ? relPath + "/" : ""}${name}`;
            });
            return lines.join("\n");
        }
        return await (0, readFile_1.readWorkspaceTextFile)(uri);
    }
    /**
     * 自动处理回复：检测回复类型并自动执行相应操作
     * @param retryCount 当前重试次数（用于 diff 应用失败时重试）
     */
    async autoProcessReply(threadId, replyText, retryCount = 0, originUserText) {
        const extractStructuredAnswer = (text) => {
            const s = String(text || "");
            const idx = s.indexOf("<<<DS_ANSWER>>>");
            if (idx === -1)
                return s;
            return s.slice(idx + "<<<DS_ANSWER>>>".length).trim();
        };
        // 0) 只执行“最后一个 fenced 动作块”（避免思考区夹带 diff/toolplan/toolcall/bash 被误触发）
        const pickLastFencedAction = (text) => {
            const raw = String(text || "");
            const patterns = [
                { kind: "diff", re: /```diff\s*([\s\S]*?)```/g },
                { kind: "bash", re: /```(?:bash|sh|shell)\s*([\s\S]*?)```/g },
                { kind: "toolcall", re: /```toolcall\s*([\s\S]*?)```/g },
                { kind: "toolplan", re: /```toolplan\s*([\s\S]*?)```/g }
            ];
            let best;
            for (const p of patterns) {
                let m = null;
                while ((m = p.re.exec(raw))) {
                    const body = (m[1] || "").trim();
                    const idx = m.index ?? 0;
                    if (!body)
                        continue;
                    if (!best || idx > best.idx)
                        best = { kind: p.kind, idx, body };
                }
            }
            return best ? { kind: best.kind, body: best.body } : undefined;
        };
        // 关键：如果存在 1:1 结构化文本，只从“最终回答区”执行（思考区永远不触发任何功能）
        const execText = extractStructuredAnswer(replyText);
        const lastFenced = pickLastFencedAction(execText);
        if (lastFenced) {
            try {
                if (lastFenced.kind === "diff") {
                    if (this.readOnlyMode) {
                        await this.notifyInChat(threadId, "🔒 只读模式：检测到 diff，未自动应用。你可以点击消息里的「预览并应用补丁」手动确认。");
                        return;
                    }
                    const sig = `diff:${lastFenced.body.slice(0, 800)}`;
                    if (await this.stopIfRepeated(threadId, sig, "diff(fenced,last,repeated)"))
                        return;
                    await this.autoApplyDiff(threadId, lastFenced.body);
                    return;
                }
                if (lastFenced.kind === "bash") {
                    if (this.readOnlyMode) {
                        await this.notifyInChat(threadId, "🔒 只读模式：检测到 bash，未自动执行。");
                        return;
                    }
                    const sig = `bash:${lastFenced.body.trim().slice(0, 500)}`;
                    if (await this.stopIfRepeated(threadId, sig, "bash(fenced,last,repeated)"))
                        return;
                    await this.autoExecuteBash(threadId, lastFenced.body);
                    return;
                }
                if (lastFenced.kind === "toolcall") {
                    const callJson = lastFenced.body;
                    const normalized = (0, toolcall_1.normalizeToolCallObject)(JSON.parse(callJson));
                    const sig = `toolcall:${normalized.tool}:${this.stableStringify(normalized.args)}`;
                    if (await this.stopIfRepeated(threadId, sig, "toolcall(fenced,last,repeated)"))
                        return;
                    await this.runToolCallAndContinueAuto(threadId, callJson);
                    return;
                }
                if (lastFenced.kind === "toolplan") {
                    // toolplan 仍按原逻辑执行
                    await this.runToolPlanAndGeneratePatch(threadId, lastFenced.body);
                    return;
                }
            }
            catch (e) {
                this.debug("error", "autoProcessReply: fenced action execution failed", { error: e instanceof Error ? e.message : String(e) });
                // 失败则继续走旧逻辑兜底
            }
        }
        // 0) OpenCoder 风格：先做“输出修复/归一化”，把模型的错误格式转成可执行的 bash/diff
        try {
            const repaired = await this.tryRepairUnsupportedToolOutputs(threadId, execText);
            if (repaired?.kind === "bash") {
                if (this.readOnlyMode) {
                    await this.notifyInChat(threadId, "🔒 只读模式：检测到 bash，未自动执行。");
                    return;
                }
                const sig = `bash:${repaired.cmd.trim().slice(0, 500)}`;
                if (await this.stopIfRepeated(threadId, sig, "bash(repaired,repeated)"))
                    return;
                await this.autoExecuteBash(threadId, repaired.cmd);
                return;
            }
            if (repaired?.kind === "diff") {
                if (this.readOnlyMode) {
                    await this.notifyInChat(threadId, "🔒 只读模式：检测到 diff，未自动应用。你可以点击消息里的「预览并应用补丁」手动确认。");
                    return;
                }
                const sig = `diff:${repaired.diffText.slice(0, 800)}`;
                if (await this.stopIfRepeated(threadId, sig, "diff(repaired,repeated)"))
                    return;
                await this.autoApplyDiff(threadId, repaired.diffText);
                return;
            }
        }
        catch (e) {
            this.debug("error", "autoProcessReply: repair failed", { error: e instanceof Error ? e.message : String(e) });
        }
        // 1. 检测是否是 toolplan
        const toolplanMatch = /```toolplan\s*([\s\S]*?)```/m.exec(execText);
        if (toolplanMatch) {
            const planJson = toolplanMatch[1].trim();
            this.debug("info", "autoProcessReply: detected toolplan, auto-executing");
            try {
                await this.runToolPlanAndGeneratePatch(threadId, planJson);
            }
            catch (e) {
                this.debug("error", "autoProcessReply: toolplan execution failed", { error: e instanceof Error ? e.message : String(e) });
            }
            return;
        }
        // 1.5. 检测裸 JSON toolplan（没有 ``` 包裹）
        const jsonMatch = /\{[\s\S]*?"read"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/m.exec(execText);
        if (jsonMatch) {
            try {
                const obj = JSON.parse(jsonMatch[0]);
                if (Array.isArray(obj?.read)) {
                    this.debug("info", "autoProcessReply: detected bare JSON toolplan, auto-executing");
                    await this.runToolPlanAndGeneratePatch(threadId, jsonMatch[0]);
                    return;
                }
            }
            catch {
                // 不是有效的 toolplan JSON，继续检查其他类型
            }
        }
        // 2. 检测是否是 toolcall（支持 fenced + 裸/污染格式）
        const callJson = (0, toolcall_1.extractToolCallJson)(execText);
        if (callJson) {
            this.debug("info", "autoProcessReply: detected toolcall, auto-executing");
            try {
                // 死循环判定：连续重复同一个 toolcall（归一化后）才停
                const normalized = (0, toolcall_1.normalizeToolCallObject)(JSON.parse(callJson));
                const sig = `toolcall:${normalized.tool}:${this.stableStringify(normalized.args)}`;
                if (await this.stopIfRepeated(threadId, sig, "toolcall(repeated)"))
                    return;
                await this.runToolCallAndContinueAuto(threadId, callJson);
            }
            catch (e) {
                this.debug("error", "autoProcessReply: toolcall execution failed", { error: e instanceof Error ? e.message : String(e) });
            }
            return;
        }
        // 3. 检测 bash 命令（支持 fenced + UI 污染格式）
        const bashCmd = (0, bash_1.extractBashBlock)(execText);
        if (bashCmd) {
            if (this.readOnlyMode) {
                await this.notifyInChat(threadId, "🔒 只读模式：检测到 bash，未自动执行。");
                return;
            }
            this.debug("info", "autoProcessReply: detected bash command, auto-executing", { cmd: bashCmd });
            try {
                const sig = `bash:${bashCmd.trim().slice(0, 500)}`;
                if (await this.stopIfRepeated(threadId, sig, "bash(repeated)"))
                    return;
                await this.autoExecuteBash(threadId, bashCmd);
            }
            catch (e) {
                this.debug("error", "autoProcessReply: bash execution failed", { error: e instanceof Error ? e.message : String(e) });
            }
            return;
        }
        // 4. 检测是否是 diff（支持 fenced ```diff ...``` 或裸 diff --git）
        const fencedDiff = /```diff\s*([\s\S]*?)```/m.exec(execText);
        const diffMatch = /(^|\n)(diff --git [\s\S]*)/m.exec(execText);
        const diffText = fencedDiff ? (fencedDiff[1] || "").trim() : diffMatch ? diffMatch[2] : "";
        if (diffText) {
            if (this.readOnlyMode) {
                await this.notifyInChat(threadId, "🔒 只读模式：检测到 diff，未自动应用。你可以点击消息里的「预览并应用补丁」手动确认。");
                return;
            }
            this.debug("info", "autoProcessReply: detected diff, auto-applying");
            try {
                const sig = `diff:${diffText.slice(0, 800)}`;
                if (await this.stopIfRepeated(threadId, sig, "diff(repeated)"))
                    return;
                await this.autoApplyDiff(threadId, diffText);
            }
            catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                this.debug("error", "autoProcessReply: diff apply failed", { error: errorMsg, retryCount });
                // 如果还没重试过，自动重新请求 diff
                if (retryCount < 2) {
                    this.debug("info", "autoProcessReply: retrying diff generation", { retryCount: retryCount + 1 });
                    await this.notifyInChat(threadId, `⚠️ 补丁应用失败：${errorMsg}，正在重新请求...`);
                    await this.retryDiffGeneration(threadId, errorMsg, retryCount + 1, originUserText);
                }
                else {
                    await this.notifyInChat(threadId, `❌ 补丁应用失败（已重试 ${retryCount} 次）：${errorMsg}`);
                }
            }
            return;
        }
        this.debug("info", "autoProcessReply: no actionable content detected");
    }
    /**
     * 自动执行 bash 命令
     */
    async autoExecuteBash(threadId, bashCmd, opts) {
        if (this.readOnlyMode && !(opts?.bypassReadOnly ?? false)) {
            const summary = "🔒 只读模式：已拦截自动执行 bash。";
            await this.store.addMessage(threadId, "system", [summary, "", bashCmd].join("\n"));
            await this.pushState();
            return { summary, resultText: bashCmd };
        }
        this.debug("info", "autoExecuteBash: starting", { cmd: bashCmd });
        // 获取工作区根目录
        const root = await (0, workspaceRoot_1.getOrPickWorkspaceRootUri)();
        const cwd = root.fsPath;
        const mode = vscode.workspace.getConfiguration().get("deepseekCoder.bashSafetyMode") ??
            "unsafe";
        // 分割多行命令
        const hasHereDoc = /(^|\s)<<\s*['"]?[A-Za-z0-9_]+['"]?/.test(bashCmd);
        let commands = (0, bash_1.splitBashCommands)(bashCmd);
        // 兜底：把“安全的 && 链”拆成多条命令，避免被安全策略拦截/误判为高风险
        // 典型：pwd && ls -la
        const expandSafeAndChain = (cmd) => {
            const s = (cmd || "").trim();
            if (!s.includes("&&"))
                return [cmd];
            // 只处理非常保守的一类：仅包含 &&，且不含管道/分号/重定向/命令替换/|| 等
            if (/[;|`]/.test(s) || /\$\(/.test(s) || /\|\|/.test(s) || /[<>]/.test(s))
                return [cmd];
            const parts = s
                .split("&&")
                .map((x) => x.trim())
                .filter(Boolean);
            return parts.length >= 2 ? parts : [cmd];
        };
        if (!hasHereDoc) {
            const expanded = [];
            for (const c of commands)
                expanded.push(...expandSafeAndChain(c));
            commands = expanded;
        }
        if (mode === "unsafe") {
            const riskText = hasHereDoc ? bashCmd : commands.join("\n");
            const risk = (0, bash_1.assessBashRisk)(riskText);
            if (risk.level === "high") {
                const pick = await vscode.window.showWarningMessage([
                    "检测到可能危险的 bash（不拦截，但需要你确认）。",
                    "",
                    "原因：",
                    ...risk.reasons.map((r) => `- ${r}`),
                    "",
                    "命令：",
                    bashCmd
                ].join("\n"), { modal: true }, "执行", "取消");
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
        const results = [];
        let allSuccess = true;
        let blocked = 0;
        if (hasHereDoc) {
            // HereDoc 需要整体作为脚本执行；逐行执行会把内容行当成命令跑
            if (mode === "safe") {
                const line = `⛔ 已拦截: (bash block)\n  原因: safe 模式下不允许 HereDoc/重定向`;
                results.push(line);
                blocked += 1;
                allSuccess = false;
            }
            else {
                // relaxed/unsafe：执行整个 block（仍保持 cwd=workspace root）
                this.debug("info", "autoExecuteBash: executing heredoc block", { cwd, mode });
                try {
                    const { stdout, stderr } = await execFileAsync("bash", ["-lc", bashCmd], {
                        cwd,
                        timeout: 60000,
                        maxBuffer: 10 * 1024 * 1024
                    });
                    const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
                    results.push(`✓ (bash block)\n${output || "(no output)"}`);
                }
                catch (e) {
                    allSuccess = false;
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    results.push(`✗ (bash block)\n  错误: ${errorMsg}`);
                }
            }
        }
        else {
            for (const cmd of commands) {
                this.debug("info", "autoExecuteBash: executing", { cmd, cwd });
                // 强制拦截 cd：逐条执行下 cd 不会保留，会让用户以为“进入目录了”但实际没效果
                if (/^\s*cd(\s|$)/.test(cmd)) {
                    const line = `⛔ 已拦截: ${cmd}\n  原因: 不支持 cd（逐条执行不会保留目录切换）；请改用相对路径或拆成多条命令（例如 ls -la demo/）`;
                    results.push(line);
                    blocked += 1;
                    allSuccess = false;
                    continue;
                }
                const safety = (0, bash_1.checkBashCommandSafety)(cmd, mode);
                if (!safety.ok) {
                    blocked += 1;
                    allSuccess = false;
                    const line = `⛔ 已拦截: ${cmd}\n  原因: ${safety.reason}`;
                    results.push(line);
                    this.debug("warn", "autoExecuteBash: blocked", { cmd, reason: safety.reason });
                    continue;
                }
                try {
                    const { stdout, stderr } = await execAsync(cmd, {
                        cwd,
                        timeout: 60000, // 60 秒超时
                        maxBuffer: 10 * 1024 * 1024 // 10MB 缓冲区
                    });
                    const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
                    results.push(`✓ ${cmd}${output ? `\n${output}` : ""}`);
                    this.debug("info", "autoExecuteBash: command succeeded", { cmd, outputLen: output.length });
                }
                catch (e) {
                    allSuccess = false;
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    results.push(`✗ ${cmd}\n  错误: ${errorMsg}`);
                    this.debug("error", "autoExecuteBash: command failed", { cmd, error: errorMsg });
                }
            }
        }
        // 显示执行结果
        const resultText = results.join("\n\n");
        const summary = blocked > 0
            ? `⚠️ bash 已处理：${commands.length} 条（${blocked} 条被拦截）`
            : allSuccess
                ? `✅ bash 已执行：${commands.length} 条`
                : `⚠️ bash 执行存在失败：${commands.length} 条`;
        await this.notifyInChat(threadId, summary);
        // 不要 toast 弹条：只在对话框里输出 system
        // 结果对用户可见：同时写入聊天消息 + 上下文（便于后续生成 diff）
        await this.store.addMessage(threadId, "system", ["[bash 执行结果]", "", resultText].join("\n"));
        await this.store.addSnippet(threadId, "bash 执行结果", resultText);
        await this.pushState();
        this.debug("info", "autoExecuteBash: completed", { success: allSuccess });
        // 像 Claude Code：把 bash 的输出回传给模型，让它基于结果继续下一步（diff/toolcall/bash）
        if (opts?.continueAfter ?? true) {
            await this.continueAfterBashAuto(threadId);
        }
        return { summary, resultText };
    }
    async continueAfterBashAuto(threadId) {
        if (!(await this.tryConsumeAutoChain(threadId, "bash->continue")))
            return;
        const t = await this.store.getThread(threadId);
        const lastUser = t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
        const extra = [
            "---",
            "# 工具结果已产生",
            "我已执行了你输出的 bash 命令，执行结果已追加到上下文片段（标题：bash 执行结果），并在聊天记录里以 system 消息记录。",
            "现在请基于用户需求 + 工具结果继续下一步：",
            "",
            "【选择规则】",
            "- 需要改代码：输出 diff --git 开头的 unified diff",
            "- 还需要再查/再跑：输出 ```toolcall``` 或 ```bash```（会自动继续执行并回传结果）",
            "",
            "【重要】严格遵守格式要求，不要输出解释文字。"
        ].join("\n");
        const tooling = await this.buildToolingPromptForThread(threadId, lastUser || "（继续基于最新工具结果完成用户需求）", "patch", extra);
        const prompt = tooling.prompt;
        const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        await this.store.addMessage(threadId, "assistant", "", assistantId);
        await this.pushState();
        if (this.active?.abort)
            this.active.abort.abort();
        const abort = new AbortController();
        this.active = { threadId, messageId: assistantId, abort, lastText: "" };
        try {
            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId)
                    return;
                this.active.lastText = u.text;
                this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
            }, { signal: abort.signal, debug: (e) => this.debug(e.level, `bashContinue: ${e.msg}`, e.data), deepThink: this.deepThinkMode });
            await this.store.updateMessageText(threadId, assistantId, r.assistantText);
            await this.store.updateWebContext(threadId, tooling.after);
            await this.pushState();
            this.debug("info", "continueAfterBashAuto: done", { assistantChars: r.assistantText.length });
            // 继续自动处理（可能再次触发 toolcall/bash/diff）
            await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
        }
        catch (e) {
            const last = this.active?.lastText || "";
            const msgText = `${last}${last ? "\n\n" : ""}[继续失败：${e instanceof Error ? e.message : String(e)}]`;
            await this.store.updateMessageText(threadId, assistantId, msgText);
            await this.pushState();
            this.debug("error", "continueAfterBashAuto: failed", { error: e instanceof Error ? e.message : String(e) });
        }
        finally {
            if (this.active?.threadId === threadId && this.active?.messageId === assistantId)
                this.active = undefined;
        }
    }
    /**
     * 重新请求 diff（当补丁应用失败时）
     */
    async retryDiffGeneration(threadId, errorMsg, retryCount, userText) {
        const t = await this.store.getThread(threadId);
        const lastUser = userText ?? t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
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
        if (this.active?.abort) {
            this.active.abort.abort();
        }
        const abort = new AbortController();
        this.active = { threadId, messageId: assistantId, abort, lastText: "" };
        try {
            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId)
                    return;
                this.active.lastText = u.text;
                this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
            }, { signal: abort.signal, debug: (e) => this.debug(e.level, `retryDiff: ${e.msg}`, e.data), deepThink: this.deepThinkMode });
            await this.store.updateMessageText(threadId, assistantId, r.assistantText);
            await this.store.updateWebContext(threadId, tooling.after);
            await this.pushState();
            this.debug("info", "retryDiffGeneration: done", { assistantChars: r.assistantText.length });
            // 继续处理回复（带重试计数）
            await this.autoProcessReply(threadId, r.assistantText, retryCount, lastUser);
        }
        catch (e) {
            const last = this.active?.lastText || "";
            const msgText = `${last}${last ? "\n\n" : ""}[重试失败：${e instanceof Error ? e.message : String(e)}]`;
            await this.store.updateMessageText(threadId, assistantId, msgText);
            await this.pushState();
            this.debug("error", "retryDiffGeneration: failed", { error: e instanceof Error ? e.message : String(e) });
        }
        finally {
            if (this.active?.threadId === threadId && this.active?.messageId === assistantId)
                this.active = undefined;
        }
    }
    /**
     * 自动应用 diff 补丁（不需要用户确认）
     */
    async autoApplyDiff(threadId, diffText) {
        if (this.readOnlyMode) {
            await this.notifyInChat(threadId, "🔒 只读模式：已拦截自动应用 diff。你可以点击消息里的「预览并应用补丁」手动确认。");
            return;
        }
        this.debug("info", "autoApplyDiff: starting", { diffChars: diffText.length });
        // 直接应用补丁，不需要确认
        const result = await (0, applyPatch_1.applyPatchTextDirectly)(diffText);
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
            this.debug("warn", "autoApplyDiff: some failed", { errors: result.failed });
            await this.notifyInChat(threadId, `⚠️ 部分补丁失败：${result.failed.join("; ")}`);
        }
        if (!result.success && result.applied.length === 0) {
            this.debug("error", "autoApplyDiff: all failed", { errors: result.failed });
            throw new Error(`补丁应用失败：${result.failed.join("; ")}`);
        }
        // 让结果可见 + 可用于后续继续（像 Claude Code）
        const summary = result.failed.length > 0 ? `⚠️ diff 已应用（部分失败）` : `✅ diff 已应用`;
        // 不要 toast 弹条：只在对话框里输出 system
        await this.notifyInChat(threadId, summary);
        await this.store.addMessage(threadId, "system", ["[diff 应用结果]", "", resultText].join("\n"));
        await this.store.addSnippet(threadId, "diff 应用结果", resultText);
        await this.pushState();
        await this.continueAfterDiffAuto(threadId);
    }
    async continueAfterDiffAuto(threadId) {
        if (!(await this.tryConsumeAutoChain(threadId, "diff->continue")))
            return;
        const t = await this.store.getThread(threadId);
        const lastUser = t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
        const extra = [
            "---",
            "# 补丁已应用",
            "我已自动应用你输出的 unified diff，应用结果已追加到上下文片段（标题：diff 应用结果），并在聊天记录里以 system 消息记录。",
            "现在请基于用户需求 + 应用结果继续下一步：",
            "",
            "【选择规则】",
            "- 若仍有失败项：优先输出一个新的 diff 修复失败（或必要时输出 toolcall/bash 进一步确认状态）",
            "- 若已完成：不要输出任何内容会导致执行；可输出一个最小 diff（空 diff 不允许）时请改用 toolcall 先确认",
            "",
            "【重要】严格遵守格式要求，不要输出解释文字。"
        ].join("\n");
        const tooling = await this.buildToolingPromptForThread(threadId, lastUser || "（继续基于最新工具结果完成用户需求）", "patch", extra);
        const prompt = tooling.prompt;
        const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        await this.store.addMessage(threadId, "assistant", "", assistantId);
        await this.pushState();
        if (this.active?.abort)
            this.active.abort.abort();
        const abort = new AbortController();
        this.active = { threadId, messageId: assistantId, abort, lastText: "" };
        try {
            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId)
                    return;
                this.active.lastText = u.text;
                this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
            }, { signal: abort.signal, debug: (e) => this.debug(e.level, `diffContinue: ${e.msg}`, e.data), deepThink: this.deepThinkMode });
            await this.store.updateMessageText(threadId, assistantId, r.assistantText);
            await this.store.updateWebContext(threadId, tooling.after);
            await this.pushState();
            this.debug("info", "continueAfterDiffAuto: done", { assistantChars: r.assistantText.length });
            await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
        }
        catch (e) {
            const last = this.active?.lastText || "";
            const msgText = `${last}${last ? "\n\n" : ""}[继续失败：${e instanceof Error ? e.message : String(e)}]`;
            await this.store.updateMessageText(threadId, assistantId, msgText);
            await this.pushState();
            this.debug("error", "continueAfterDiffAuto: failed", { error: e instanceof Error ? e.message : String(e) });
        }
        finally {
            if (this.active?.threadId === threadId && this.active?.messageId === assistantId)
                this.active = undefined;
        }
    }
    /**
     * 自动运行 toolcall 并继续（不需要用户确认）
     */
    async runToolCallAndContinueAuto(threadId, callText) {
        const call = this.parseToolCall(callText);
        this.debug("info", "runToolCallAndContinueAuto: parsed", { threadId, tool: call.tool });
        // 直接运行工具，不需要确认
        let result;
        try {
            result = await (0, tools_1.runToolCall)(call);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result = {
                tool: call.tool,
                ok: false,
                title: `${call.tool}: (failed)`,
                content: msg
            };
            this.debug("error", "runToolCallAndContinueAuto: tool failed", { tool: call.tool, error: msg });
        }
        await this.store.addSnippet(threadId, `工具结果: ${result.title}`, [
            `tool: ${result.tool}`,
            `ok: ${result.ok}`,
            "",
            result.content
        ].join("\n"));
        await this.pushState();
        if (!(await this.tryConsumeAutoChain(threadId, "toolcall->continue")))
            return;
        // 自动继续：让模型基于"工具结果"决定下一步
        const t = await this.store.getThread(threadId);
        const lastUser = t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
        const extra = [
            "---",
            "# 强制指令",
            "我已执行了你的 toolcall 并返回了结果（见上下文片段）。",
            "现在根据用户需求选择合适的格式输出：",
            "",
            "【选择规则】",
            "- 如果需要修改文件内容：输出 diff --git 开头的 unified diff",
            "- 如果需要执行命令（如删除文件、创建目录、安装依赖）：输出 ```bash``` 代码块",
            "- 如果还需要更多信息：输出 ```toolcall``` 代码块",
            "",
            "【格式要求】",
            "- diff：第一个字符必须是 d（diff --git 开头）",
            "- bash：必须是 ```bash\\n命令\\n``` 格式",
            "- 绝对禁止输出任何解释、前言、后语",
            "",
            "立刻输出！"
        ].join("\n");
        const tooling = await this.buildToolingPromptForThread(threadId, lastUser || "（继续基于最新工具结果完成用户需求）", "patch", extra);
        const prompt = tooling.prompt;
        const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        await this.store.addMessage(threadId, "assistant", "", assistantId);
        await this.pushState();
        if (this.active?.abort) {
            this.debug("warn", "runToolCallAndContinueAuto: auto-cancel previous request");
            this.active.abort.abort();
        }
        const abort = new AbortController();
        this.active = { threadId, messageId: assistantId, abort, lastText: "" };
        try {
            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId)
                    return;
                this.active.lastText = u.text;
                this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
            }, { signal: abort.signal, debug: (e) => this.debug(e.level, `runToolCallAndContinueAuto: ${e.msg}`, e.data) });
            await this.store.updateMessageText(threadId, assistantId, r.assistantText);
            await this.store.updateWebContext(threadId, tooling.after);
            await this.pushState();
            this.debug("info", "runToolCallAndContinueAuto: done", { assistantChars: r.assistantText.length });
            // 递归：继续自动处理回复
            await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
        }
        catch (e) {
            const last = this.active?.lastText || "";
            const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
            await this.store.updateMessageText(threadId, assistantId, msgText);
            await this.pushState();
            this.debug("error", "runToolCallAndContinueAuto: failed", { error: e instanceof Error ? e.message : String(e) });
        }
        finally {
            if (this.active?.threadId === threadId && this.active?.messageId === assistantId)
                this.active = undefined;
        }
    }
    async runToolPlanAndGeneratePatch(threadId, planText) {
        // 解析 toolplan JSON
        let plan;
        try {
            plan = JSON.parse(planText);
        }
        catch {
            this.debug("error", "toolPlanRun: invalid JSON");
            throw new Error("toolplan 不是合法 JSON。");
        }
        // 死循环判定：连续重复同一个 toolplan（read 列表 + notes）才停
        try {
            const sig = `toolplan:${this.stableStringify({ read: plan?.read ?? [], notes: plan?.notes ?? "" })}`;
            if (await this.stopIfRepeated(threadId, sig, "toolplan(repeated)"))
                return;
        }
        catch {
            // ignore repeat detection parse errors
        }
        const readList = Array.isArray(plan?.read) ? plan.read : [];
        const invalidReads = [];
        const relPaths = readList
            .map((x) => {
            if (typeof x !== "string")
                return undefined;
            const rp = this.sanitizeRelPath(x);
            if (!rp)
                invalidReads.push(x);
            return rp;
        })
            .filter(Boolean);
        this.debug("info", "toolPlanRun: parsed", { readCount: relPaths.length });
        if (invalidReads.length > 0) {
            await this.store.addSnippet(threadId, "工具读取: 被拦截的路径", [
                "以下路径被拦截（仅允许读取工作区内的相对路径）。",
                "如果你需要系统信息，请改用 bash（例如：```bash\\ncat /etc/issue\\n```）。",
                "",
                ...invalidReads.map((p) => `- ${p}`)
            ].join("\n"));
        }
        for (const rp of relPaths) {
            this.debug("info", "toolPlanRun: reading file", { path: rp });
            const content = await this.readWorkspaceRelFile(rp);
            await this.store.addSnippet(threadId, `工具读取: ${rp}`, content);
        }
        await this.pushState();
        if (!(await this.tryConsumeAutoChain(threadId, "toolplan->continue")))
            return;
        const t = await this.store.getThread(threadId);
        const lastUser = t?.messages?.slice().reverse().find((m) => m.role === "user")?.text ?? "";
        const extra = [
            "---",
            "# 强制指令",
            "我已按你的 toolplan 读取了文件（见上下文片段）。",
            "现在根据用户需求选择合适的格式输出：",
            "",
            "【选择规则】",
            "- 如果需要修改文件内容：输出 diff --git 开头的 unified diff",
            "- 如果需要执行命令（如删除文件、创建目录、安装依赖）：输出 ```bash``` 代码块",
            "- 如果还需要更多信息：输出 ```toolcall``` 代码块",
            "",
            "【格式要求】",
            "- diff：第一个字符必须是 d（diff --git 开头）",
            "- bash：必须是 ```bash\\n命令\\n``` 格式",
            "- 绝对禁止输出任何解释、前言、后语",
            "",
            "立刻输出！"
        ].join("\n");
        const tooling = await this.buildToolingPromptForThread(threadId, lastUser || "（继续基于最新工具结果完成用户需求）", "patch", extra);
        const prompt = tooling.prompt;
        const assistantId = `assistant_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        await this.store.addMessage(threadId, "assistant", "", assistantId);
        await this.pushState();
        const abort = new AbortController();
        this.active = { threadId, messageId: assistantId, abort, lastText: "" };
        this.debug("info", "toolPlanRun: generate diff start", { assistantId, promptChars: prompt.length });
        try {
            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId)
                    return;
                this.active.lastText = u.text;
                this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
            }, {
                signal: abort.signal,
                debug: (e) => this.debug(e.level, `toolPlanRun: ${e.msg}`, e.data),
                deepThink: this.deepThinkMode
            });
            this.debug("info", "toolPlanRun: generate diff done", { assistantChars: r.assistantText.length });
            await this.store.updateMessageText(threadId, assistantId, r.assistantText);
            await this.store.updateWebContext(threadId, tooling.after);
            await this.pushState();
            // 自动处理回复（可能是 diff 或其他 toolcall）
            await this.autoProcessReply(threadId, r.assistantText, 0, lastUser);
        }
        catch (e) {
            const last = this.active?.lastText || "";
            const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
            this.debug("error", "toolPlanRun: generate diff failed", { error: e instanceof Error ? e.message : String(e) });
            await this.store.updateMessageText(threadId, assistantId, msgText);
            await this.pushState();
        }
        finally {
            if (this.active?.threadId === threadId && this.active?.messageId === assistantId)
                this.active = undefined;
        }
    }
    parseToolCall(callText) {
        let obj;
        try {
            obj = JSON.parse(callText);
        }
        catch {
            throw new Error("toolcall 不是合法 JSON。");
        }
        const normalized = (0, toolcall_1.normalizeToolCallObject)(obj);
        return normalized;
    }
    async runToolCallAndContinue(threadId, callText) {
        const call = this.parseToolCall(callText);
        this.debug("info", "toolCallRun: parsed", { threadId, tool: call.tool });
        const confirm = await vscode.window.showWarningMessage(`确认在本地运行工具 ${call.tool} ?\n\n参数：${JSON.stringify(call.args ?? {}, null, 2)}`, { modal: true }, "运行", "取消");
        if (confirm !== "运行") {
            this.debug("warn", "toolCallRun: cancelled by user", { tool: call.tool });
            return;
        }
        // 运行工具并把结果写入上下文（失败也要变成“工具结果”，不要抛出中断）
        let result;
        try {
            result = await (0, tools_1.runToolCall)(call);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result = {
                tool: call.tool,
                ok: false,
                title: `${call.tool}: (failed)`,
                content: msg
            };
            this.debug("error", "toolCallRun: tool failed", { tool: call.tool, error: msg });
        }
        await this.store.addSnippet(threadId, `工具结果: ${result.title}`, [
            `tool: ${result.tool}`,
            `ok: ${result.ok}`,
            "",
            result.content
        ].join("\n"));
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
        if (this.active?.abort) {
            this.debug("warn", "toolCallRun: auto-cancel previous request (continue)");
            this.active.abort.abort();
        }
        const abort = new AbortController();
        this.active = { threadId, messageId: assistantId, abort, lastText: "" };
        try {
            const r = await this.deepseek.sendStreamingWithDebug(prompt, async (u) => {
                if (!this.active || this.active.threadId !== threadId || this.active.messageId !== assistantId)
                    return;
                this.active.lastText = u.text;
                this._post({ type: "assistantStream", threadId, messageId: assistantId, text: u.text, done: u.done });
            }, { signal: abort.signal, debug: (e) => this.debug(e.level, `toolCallRun: ${e.msg}`, e.data), deepThink: this.deepThinkMode });
            await this.store.updateMessageText(threadId, assistantId, r.assistantText);
            await this.store.updateWebContext(threadId, tooling.after);
            await this.pushState();
            this.debug("info", "toolCallRun: continue done", { assistantChars: r.assistantText.length });
        }
        catch (e) {
            const last = this.active?.lastText || "";
            const msgText = `${last}${last ? "\n\n" : ""}[已取消/失败：${e instanceof Error ? e.message : String(e)}]`;
            await this.store.updateMessageText(threadId, assistantId, msgText);
            await this.pushState();
            this.debug("error", "toolCallRun: continue failed", { error: e instanceof Error ? e.message : String(e) });
        }
        finally {
            if (this.active?.threadId === threadId && this.active?.messageId === assistantId)
                this.active = undefined;
        }
    }
    _getHtml(webview) {
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
exports.DeepSeekViewProvider = DeepSeekViewProvider;
//# sourceMappingURL=DeepSeekViewProvider.js.map