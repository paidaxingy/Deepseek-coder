import * as vscode from "vscode";

export async function getOrPickWorkspaceRootUri(): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) return folders[0].uri;

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


