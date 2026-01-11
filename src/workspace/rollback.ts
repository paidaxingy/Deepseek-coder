import * as vscode from "vscode";
import * as path from "path";

type RollbackFile = {
  relPath: string;
  beforeExists: boolean;
  beforeText?: string; // only when beforeExists=true and captured
  note?: string; // optional info when not captured
};

type RollbackEntry = {
  id: string;
  ts: number;
  title: string;
  files: RollbackFile[];
};

// 回滚快照上限：默认保留最近 5 次改动（可连续回滚最多 5 步）
// 注意：快照保存在扩展宿主内存中；容量上限见下方。
const MAX_HISTORY = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file snapshot
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64MB per rollback entry

const history: RollbackEntry[] = [];

function now() {
  return Date.now();
}

function genId() {
  return `rb_${now()}_${Math.random().toString(16).slice(2)}`;
}

function normRelPath(p: string): string {
  const s = String(p || "").trim().replace(/\\/g, "/");
  const clean = path.posix.normalize(s);
  return clean === "." ? "" : clean;
}

async function getWorkspaceFileUri(relPath: string): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;
  const rp = normRelPath(relPath);
  if (!rp || rp.startsWith("..") || path.isAbsolute(rp)) return undefined;
  return vscode.Uri.joinPath(folders[0].uri, rp);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(uri: vscode.Uri) {
  const parentPath = path.posix.dirname(uri.path);
  const parent = uri.with({ path: parentPath });
  await vscode.workspace.fs.createDirectory(parent);
}

async function writeUtf8(uri: vscode.Uri, text: string) {
  await ensureParentDir(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text ?? "", "utf8"));
}

export function pushRollbackEntry(entry: RollbackEntry) {
  if (!entry.files.length) return;
  history.push(entry);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

export function beginRollbackCapture(title: string) {
  const entry: RollbackEntry = { id: genId(), ts: now(), title: String(title || "rollback"), files: [] };
  let totalBytes = 0;
  const seen = new Set<string>();

  const addFile = async (relPathRaw: string): Promise<RollbackFile | undefined> => {
    const relPath = normRelPath(relPathRaw);
    if (!relPath) return undefined;
    if (seen.has(relPath)) return undefined;
    seen.add(relPath);

    const uri = await getWorkspaceFileUri(relPath);
    if (!uri) {
      const f: RollbackFile = { relPath, beforeExists: false, note: "no-workspace-or-invalid-path" };
      entry.files.push(f);
      return f;
    }

    const beforeExists = await exists(uri);
    if (!beforeExists) {
      const f: RollbackFile = { relPath, beforeExists: false };
      entry.files.push(f);
      return f;
    }

    // capture text (best-effort with caps)
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(uri);
    } catch (e) {
      const f: RollbackFile = { relPath, beforeExists: true, note: `read-failed:${e instanceof Error ? e.message : String(e)}` };
      entry.files.push(f);
      return f;
    }

    if (data.byteLength > MAX_FILE_BYTES || totalBytes + data.byteLength > MAX_TOTAL_BYTES) {
      const f: RollbackFile = { relPath, beforeExists: true, note: `snapshot-too-large:${data.byteLength}` };
      entry.files.push(f);
      return f;
    }

    const text = Buffer.from(data).toString("utf8");
    totalBytes += data.byteLength;
    const f: RollbackFile = { relPath, beforeExists: true, beforeText: text };
    entry.files.push(f);
    return f;
  };

  const finalize = () => {
    // remove entries which are impossible to rollback (no snapshot AND file existed)
    pushRollbackEntry(entry);
    return entry;
  };

  return { addFile, finalize, entry };
}

export async function rollbackLast(): Promise<{ ok: boolean; message: string }> {
  const last = history.pop();
  if (!last) return { ok: false, message: "没有可回滚的记录。" };

  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const f of last.files) {
    const uri = await getWorkspaceFileUri(f.relPath);
    if (!uri) {
      skipped.push(`${f.relPath}: 无工作区/非法路径`);
      continue;
    }

    try {
      if (!f.beforeExists) {
        // was created by patch => rollback by deleting if exists
        const ex = await exists(uri);
        if (ex) {
          await vscode.workspace.fs.delete(uri, { useTrash: false });
          removed.push(f.relPath);
        } else {
          skipped.push(`${f.relPath}: 文件不存在（已视为回滚完成）`);
        }
        continue;
      }

      if (typeof f.beforeText !== "string") {
        skipped.push(`${f.relPath}: 未保存快照（${f.note || "unknown"}）`);
        continue;
      }

      await writeUtf8(uri, f.beforeText);
      restored.push(f.relPath);
    } catch (e) {
      failed.push(`${f.relPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const parts: string[] = [];
  parts.push(`已回滚：${last.title}（剩余可回滚 ${history.length} 次）`);
  if (restored.length) parts.push(`恢复(${restored.length}): ${restored.join(", ")}`);
  if (removed.length) parts.push(`删除(${removed.length}): ${removed.join(", ")}`);
  if (skipped.length) parts.push(`跳过(${skipped.length}): ${skipped.slice(0, 8).join("; ")}${skipped.length > 8 ? " ..." : ""}`);
  if (failed.length) parts.push(`失败(${failed.length}): ${failed.slice(0, 8).join("; ")}${failed.length > 8 ? " ..." : ""}`);

  return { ok: failed.length === 0, message: parts.join("\n") };
}

