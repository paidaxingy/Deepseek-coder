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
exports.runToolCall = runToolCall;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const readFile_1 = require("./readFile");
const workspaceRoot_1 = require("./workspaceRoot");
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_RESULTS = 200;
function sanitizeRelPath(p) {
    const s = (p || "").trim();
    if (!s)
        return "";
    if (path.isAbsolute(s))
        throw new Error(`禁止使用绝对路径：${s}`);
    const norm = s.replace(/\\/g, "/");
    const clean = path.posix.normalize(norm);
    if (clean.startsWith(".."))
        throw new Error(`禁止访问工作区外路径：${s}`);
    return clean === "." ? "" : clean;
}
async function listDir(relPath, maxEntries) {
    const root = await (0, workspaceRoot_1.getOrPickWorkspaceRootUri)();
    const uri = relPath ? vscode.Uri.joinPath(root, relPath) : root;
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const shown = entries.slice(0, maxEntries);
    const lines = shown.map(([name, type]) => {
        const t = type === vscode.FileType.Directory ? "dir" : type === vscode.FileType.File ? "file" : "other";
        return `${t}\t${relPath ? relPath + "/" : ""}${name}`;
    });
    const more = entries.length > shown.length ? `\n... 还有 ${entries.length - shown.length} 项未显示` : "";
    return {
        tool: "listDir",
        ok: true,
        title: `listDir: ${relPath || "."}`,
        content: lines.join("\n") + more
    };
}
async function readFile(relPath) {
    const root = await (0, workspaceRoot_1.getOrPickWorkspaceRootUri)();
    const uri = vscode.Uri.joinPath(root, relPath);
    const text = await (0, readFile_1.readWorkspaceTextFile)(uri);
    return {
        tool: "readFile",
        ok: true,
        title: `readFile: ${relPath}`,
        content: text
    };
}
async function searchText(query, glob, maxResults) {
    // 不再使用“逐文件读全量文本扫描”的降级实现：改为 VSCode 原生 findTextInFiles，更快更稳。
    // 同时不对 maxResults 做上限截断（由调用方控制）；仅用于“收集结果多少”，并可提前 cancel。
    const max = Math.max(1, maxResults ?? DEFAULT_MAX_RESULTS);
    const results = [];
    const include = glob?.trim() || "**/*";
    const exclude = "**/{node_modules,dist,.git,.vscode}/**";
    const w = vscode.workspace;
    const findTextInFiles = w?.findTextInFiles;
    if (typeof findTextInFiles === "function") {
        const cts = new vscode.CancellationTokenSource();
        await new Promise((resolve) => {
            try {
                findTextInFiles({ pattern: query }, { include, exclude, previewOptions: { matchLines: 1, charsPerLine: 400 } }, (r) => {
                    if (!r || results.length >= max) {
                        if (results.length >= max)
                            cts.cancel();
                        return;
                    }
                    const uri = r.uri;
                    const previewText = String(r.preview?.text ?? "").trimEnd();
                    const firstRange = Array.isArray(r.ranges) ? r.ranges[0] : r.ranges;
                    const line = Number(firstRange?.start?.line ?? 0);
                    if (uri)
                        results.push({ uri, line, text: previewText });
                    if (results.length >= max)
                        cts.cancel();
                }, cts.token);
            }
            catch {
                // ignore, fallback below
            }
            finally {
                // findTextInFiles 是异步流式 API：用 token 取消后仍可能回调少量残留，稍后也会自然结束
                // 这里用一个短延迟收敛回调，再 resolve（避免永远不 resolve）
                setTimeout(() => resolve(), 200);
            }
        });
        cts.dispose();
    }
    else {
        // 极端兜底：API 不存在则回退到旧逻辑（仍保持可用）
        const candidates = await vscode.workspace.findFiles(include, exclude, 800);
        for (const uri of candidates) {
            if (results.length >= max)
                break;
            let text = "";
            try {
                text = await (0, readFile_1.readWorkspaceTextFile)(uri);
            }
            catch {
                continue;
            }
            if (text.startsWith("/* 文件过大："))
                continue;
            const linesArr = text.split(/\r?\n/);
            for (let i = 0; i < linesArr.length; i++) {
                if (results.length >= max)
                    break;
                const lineText = linesArr[i];
                if (lineText.includes(query))
                    results.push({ uri, line: i, text: lineText });
            }
        }
    }
    const lines = results.map((r) => `${vscode.workspace.asRelativePath(r.uri)}:${r.line + 1}\t${r.text}`);
    return {
        tool: "searchText",
        ok: true,
        title: `searchText: ${query}`,
        content: lines.join("\n") || "(无匹配)"
    };
}
async function runToolCall(call) {
    switch (call.tool) {
        case "listDir": {
            const rel = sanitizeRelPath(call.args.path);
            const maxEntries = Math.max(1, Math.min(call.args.maxEntries ?? DEFAULT_MAX_ENTRIES, 2000));
            return await listDir(rel, maxEntries);
        }
        case "readFile": {
            const rel = sanitizeRelPath(call.args.path);
            if (!rel)
                throw new Error("readFile.path 不能为空");
            return await readFile(rel);
        }
        case "searchText": {
            const q = (call.args.query || "").trim();
            if (!q)
                throw new Error("searchText.query 不能为空");
            return await searchText(q, call.args.glob, call.args.maxResults);
        }
    }
}
//# sourceMappingURL=tools.js.map