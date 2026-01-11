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
exports.readWorkspaceTextFile = readWorkspaceTextFile;
const vscode = __importStar(require("vscode"));
const MAX_TEXT_BYTES = 1024 * 1024; // 1MB，避免误把大文件塞进提示词
const NOT_FOUND_PREFIX = "/* 文件不存在：";
function isNotFoundError(e) {
    const anyE = e;
    const code = anyE?.code ?? anyE?.name;
    return code === "FileNotFound" || code === "ENOENT";
}
async function readWorkspaceTextFile(uri) {
    let stat;
    try {
        stat = await vscode.workspace.fs.stat(uri);
    }
    catch (e) {
        if (isNotFoundError(e)) {
            return `${NOT_FOUND_PREFIX} ${vscode.workspace.asRelativePath(uri)} */`;
        }
        const msg = e instanceof Error ? e.message : String(e);
        return `/* 读取文件失败：${vscode.workspace.asRelativePath(uri)}\n${msg}\n*/`;
    }
    if (stat.size > MAX_TEXT_BYTES) {
        return `/* 文件过大：${stat.size} bytes，已跳过内容注入。建议只选择关键片段或手动复制。 */`;
    }
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(data).toString("utf8");
    }
    catch (e) {
        if (isNotFoundError(e)) {
            return `${NOT_FOUND_PREFIX} ${vscode.workspace.asRelativePath(uri)} */`;
        }
        const msg = e instanceof Error ? e.message : String(e);
        return `/* 读取文件失败：${vscode.workspace.asRelativePath(uri)}\n${msg}\n*/`;
    }
}
//# sourceMappingURL=readFile.js.map