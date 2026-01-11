"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThreadStore = void 0;
const STORAGE_KEY = "deepseekCoder.threadState";
const MAX_MESSAGES = 200;
const MAX_SNIPPETS = 50;
const SINGLE_THREAD_ID = "thread_single";
const SINGLE_THREAD_TITLE = "当前会话";
function now() {
    return Date.now();
}
function genId(prefix) {
    return `${prefix}_${now()}_${Math.random().toString(16).slice(2)}`;
}
function defaultTitle(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `对话 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ensureState(raw) {
    const s = raw;
    if (!s || s.version !== 1 || !Array.isArray(s.threads)) {
        return { version: 1, threads: [] };
    }
    const normalizeWebContext = (x) => {
        const bootstrapped = Boolean(x?.bootstrapped);
        const sentSnippetCount = Number.isFinite(Number(x?.sentSnippetCount)) ? Math.max(0, Number(x.sentSnippetCount)) : 0;
        return { bootstrapped, sentSnippetCount };
    };
    return {
        version: 1,
        currentThreadId: typeof s.currentThreadId === "string" ? s.currentThreadId : undefined,
        threads: s.threads.map((t) => ({
            id: String(t.id),
            title: String(t.title ?? "对话"),
            updatedAt: Number(t.updatedAt ?? 0),
            messages: Array.isArray(t.messages) ? t.messages : [],
            snippets: Array.isArray(t.snippets) ? t.snippets : [],
            webContext: normalizeWebContext(t?.webContext)
        }))
    };
}
class ThreadStore {
    context;
    mem;
    constructor(context) {
        this.context = context;
        // 用户要求“取消历史记录功能”：不再持久化到 globalState。
        // 改为仅内存保存（扩展重载/宿主重启后即清空），并固定为单会话线程，贴近网页端单页聊天体验。
        const rec = {
            id: SINGLE_THREAD_ID,
            title: SINGLE_THREAD_TITLE,
            updatedAt: now(),
            messages: [],
            snippets: [],
            webContext: { bootstrapped: false, sentSnippetCount: 0 }
        };
        this.mem = { version: 1, currentThreadId: rec.id, threads: [rec] };
        void this.context;
    }
    _defaultWebContext() {
        return { bootstrapped: false, sentSnippetCount: 0 };
    }
    _load() {
        return this.mem;
    }
    async _save(s) {
        this.mem = s;
    }
    async ensureCurrentThread() {
        const s = this._load();
        if (!s.threads.some((t) => t.id === SINGLE_THREAD_ID)) {
            s.threads = [
                {
                    id: SINGLE_THREAD_ID,
                    title: SINGLE_THREAD_TITLE,
                    updatedAt: now(),
                    messages: [],
                    snippets: [],
                    webContext: this._defaultWebContext()
                }
            ];
            s.currentThreadId = SINGLE_THREAD_ID;
            await this._save(s);
        }
        return SINGLE_THREAD_ID;
    }
    async listThreads() {
        const s = this._load();
        const t = s.threads.find((x) => x.id === SINGLE_THREAD_ID);
        return t ? [{ id: t.id, title: t.title, updatedAt: t.updatedAt }] : [];
    }
    async setCurrentThread(threadId) {
        void threadId;
        // 单会话：忽略切换
    }
    async createThread(title) {
        // 单会话：createThread 语义改为“清空当前会话并重置标题”
        const s = this._load();
        const t = s.threads.find((x) => x.id === SINGLE_THREAD_ID);
        if (!t)
            return await this.ensureCurrentThread();
        t.title = title?.trim() || SINGLE_THREAD_TITLE;
        t.messages.splice(0, t.messages.length);
        t.snippets.splice(0, t.snippets.length);
        t.webContext = this._defaultWebContext();
        t.updatedAt = now();
        await this._save(s);
        return t.id;
    }
    async deleteThread(threadId) {
        void threadId;
        // 单会话：忽略删除
    }
    async clearThread(threadId) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            return;
        t.messages.splice(0, t.messages.length);
        t.snippets.splice(0, t.snippets.length);
        t.webContext = this._defaultWebContext();
        t.updatedAt = now();
        await this._save(s);
    }
    async clearSnippets(threadId) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            return;
        t.snippets.splice(0, t.snippets.length);
        // 清空上下文后，网页对话里仍可能保留旧信息；这里至少重置“已发送进度”，避免逻辑错位。
        t.webContext = this._defaultWebContext();
        t.updatedAt = now();
        await this._save(s);
    }
    async getThread(threadId) {
        const s = this._load();
        return s.threads.find((t) => t.id === threadId);
    }
    async addMessage(threadId, role, text, id) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            throw new Error("线程不存在");
        const msg = { id: id ?? genId("msg"), role, text, ts: now() };
        t.messages.push(msg);
        if (t.messages.length > MAX_MESSAGES)
            t.messages.splice(0, t.messages.length - MAX_MESSAGES);
        t.updatedAt = msg.ts;
        await this._save(s);
        return msg;
    }
    async updateMessageText(threadId, messageId, text) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            return;
        const m = t.messages.find((x) => x.id === messageId);
        if (!m)
            return;
        m.text = text;
        t.updatedAt = now();
        await this._save(s);
    }
    async addSnippet(threadId, title, content) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            throw new Error("线程不存在");
        const sn = { id: genId("snip"), title, content, ts: now() };
        t.snippets.push(sn);
        if (t.snippets.length > MAX_SNIPPETS)
            t.snippets.splice(0, t.snippets.length - MAX_SNIPPETS);
        t.updatedAt = sn.ts;
        await this._save(s);
        return sn;
    }
    async getWebContext(threadId) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            return this._defaultWebContext();
        // clamp，避免用户清空 snippets 或历史数据异常导致越界
        const sentSnippetCount = Math.max(0, Math.min(Number(t.webContext?.sentSnippetCount ?? 0), t.snippets.length));
        return {
            bootstrapped: Boolean(t.webContext?.bootstrapped),
            sentSnippetCount
        };
    }
    async updateWebContext(threadId, patch) {
        const s = this._load();
        const t = s.threads.find((x) => x.id === threadId);
        if (!t)
            return;
        const next = {
            bootstrapped: patch.bootstrapped ?? t.webContext.bootstrapped,
            sentSnippetCount: patch.sentSnippetCount != null
                ? Math.max(0, Math.min(Number(patch.sentSnippetCount), t.snippets.length))
                : t.webContext.sentSnippetCount
        };
        t.webContext = next;
        t.updatedAt = now();
        await this._save(s);
    }
    async exportThreadMarkdown(threadId) {
        const t = await this.getThread(threadId);
        if (!t)
            throw new Error("线程不存在");
        const lines = [];
        lines.push(`# ${t.title}`);
        lines.push("");
        lines.push(`- id: ${t.id}`);
        lines.push(`- updatedAt: ${new Date(t.updatedAt).toISOString()}`);
        lines.push("");
        lines.push("## Context Snippets");
        lines.push("");
        for (const s of t.snippets) {
            lines.push(`### ${s.title}`);
            lines.push("");
            lines.push("```");
            lines.push(s.content);
            lines.push("```");
            lines.push("");
        }
        lines.push("## Messages");
        lines.push("");
        for (const m of t.messages) {
            const who = m.role === "user" ? "你" : m.role === "assistant" ? "DeepSeek" : "System";
            lines.push(`### ${who} (${new Date(m.ts).toLocaleString()})`);
            lines.push("");
            lines.push("```");
            lines.push(m.text);
            lines.push("```");
            lines.push("");
        }
        return lines.join("\n");
    }
    async exportThreadJson(threadId) {
        const t = await this.getThread(threadId);
        if (!t)
            throw new Error("线程不存在");
        return JSON.stringify(t, null, 2);
    }
}
exports.ThreadStore = ThreadStore;
//# sourceMappingURL=threadStore.js.map