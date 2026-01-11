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
exports.getOrPickWorkspaceRootUri = getOrPickWorkspaceRootUri;
const vscode = __importStar(require("vscode"));
async function getOrPickWorkspaceRootUri() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length)
        return folders[0].uri;
    const pick = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: "选择为工作区根目录"
    });
    if (!pick?.[0]) {
        throw new Error("当前没有打开的工作区文件夹。请先打开一个文件夹，或在弹窗中选择一个目录作为工作区根目录。");
    }
    const uri = pick[0];
    // 在 Extension Host 里动态添加 workspace folder
    vscode.workspace.updateWorkspaceFolders(0, 0, { uri, name: uri.path.split("/").filter(Boolean).pop() || "workspace" });
    return uri;
}
//# sourceMappingURL=workspaceRoot.js.map