import * as vscode from "vscode";

const MAX_TEXT_BYTES = 1024 * 1024; // 1MB，避免误把大文件塞进提示词
const NOT_FOUND_PREFIX = "/* 文件不存在：";

function isNotFoundError(e: unknown) {
  const anyE = e as any;
  const code = anyE?.code ?? anyE?.name;
  return code === "FileNotFound" || code === "ENOENT";
}

export async function readWorkspaceTextFile(uri: vscode.Uri): Promise<string> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (e) {
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
  } catch (e) {
    if (isNotFoundError(e)) {
      return `${NOT_FOUND_PREFIX} ${vscode.workspace.asRelativePath(uri)} */`;
    }
    const msg = e instanceof Error ? e.message : String(e);
    return `/* 读取文件失败：${vscode.workspace.asRelativePath(uri)}\n${msg}\n*/`;
  }
}


