import * as vscode from "vscode";
import { applyPatch } from "diff";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { beginRollbackCapture } from "./rollback";

const execAsync = promisify(exec);

function isProbablyUnifiedDiff(text: string) {
  return /(^|\n)diff --git /.test(text) || /(^|\n)\*\*\* Begin Patch/.test(text);
}

function stripMarkdownFences(text: string): string {
  // 允许模型把 diff 放进 ```diff ...``` 代码块里（更易复制/显示）
  // 这里统一剥掉 fence 行，避免 diff 库报 Unknown line。
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*```(?:diff|patch|udiff|unified-diff)?\s*$/i.test(l.trim()));
  return lines.join("\n").trim() + "\n";
}

async function getWorkspaceFileUri(pathFromRepoRoot: string): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;
  // 只支持第一个 workspace folder（最小实现）
  return vscode.Uri.joinPath(folders[0].uri, pathFromRepoRoot);
}

async function createUntitledDoc(content: string, nameHint: string) {
  const uri = vscode.Uri.parse(`untitled:${nameHint}`);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  await editor.edit((eb) => {
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    eb.replace(full, content);
  });
  return doc.uri;
}

async function pathExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function ensureParentDir(uri: vscode.Uri) {
  // 注意：Uri.joinPath(uri,"..") 不是“父目录”，而是拼出一个子路径。
  const parentPath = path.posix.dirname(uri.path);
  const parent = uri.with({ path: parentPath });
  await vscode.workspace.fs.createDirectory(parent);
}

async function writeFileUtf8(uri: vscode.Uri, content: string) {
  await ensureParentDir(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

function ensureTrailingNewline(s: string) {
  const t = String(s ?? "");
  return t.endsWith("\n") ? t : t + "\n";
}

function stripWholeFileMarkdownFencesIfLikely(opts: { targetPath: string; text: string }): { text: string; changed: boolean } {
  const targetPath = String(opts.targetPath || "");
  const ext = path.posix.extname(targetPath).toLowerCase();
  // 仅对“代码文件”做保护；markdown 本身允许 fences
  const allowFences = new Set([".md", ".markdown", ".mdx", ".txt"]);
  if (allowFences.has(ext)) return { text: opts.text, changed: false };

  const lines = String(opts.text ?? "").replace(/\r\n/g, "\n").split("\n");
  const isFence = (l: string) => /^```[\w-]*\s*$/.test(String(l || "").trim());
  const firstNonEmpty = lines.findIndex((l) => String(l || "").trim() !== "");
  if (firstNonEmpty === -1) return { text: opts.text, changed: false };
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && String(lines[lastNonEmpty] || "").trim() === "") lastNonEmpty--;
  if (lastNonEmpty < 0) return { text: opts.text, changed: false };

  let changed = false;

  // 情况 1：整文件被 ```lang ... ``` 包裹
  if (isFence(lines[firstNonEmpty]) && isFence(lines[lastNonEmpty]) && lastNonEmpty > firstNonEmpty) {
    lines.splice(lastNonEmpty, 1);
    lines.splice(firstNonEmpty, 1);
    changed = true;
  } else {
    // 情况 2：只在末尾多了一个 ```（模型常见“关闭 fence”遗留）
    if (isFence(lines[lastNonEmpty])) {
      lines.splice(lastNonEmpty, 1);
      changed = true;
    }
  }

  const out = lines.join("\n");
  return { text: out, changed };
}

type FileBlock = {
  aPath: string;
  bPath: string;
  text: string;
};

function normalizeHunksForDiffLib(patchText: string): string {
  // diff 库的 applyPatch 解析非常严格：
  // - hunk header 的行数必须与实际 +/-/空格 行数完全一致，否则会把“多出来的行”当成非法行（Unknown line）
  // - hunk 内若出现缺少前缀的行，也会直接报错
  //
  // 这里做一个最小的“容错归一化”：
  // - 自动修正每个 hunk header 的 oldCount/newCount
  // - 对 hunk 内的“无前缀行”补前缀：新增文件场景补 '+'；其他场景补 ' '
  const lines = String(patchText || "").replace(/\r\n/g, "\n").split("\n");
  // split 会在文本以 '\n' 结尾时产生最后一个空元素；这不是补丁内容的一行
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];

  const hunkHeaderRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
  const isValidHunkLine = (l: string) => l.startsWith(" ") || l.startsWith("+") || l.startsWith("-") || l.startsWith("\\");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = hunkHeaderRe.exec(line);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }

    const oldStart = Number(m[1]);
    const oldCount = m[2] != null ? Number(m[2]) : 1;
    const newStart = Number(m[3]);
    const newCount = m[4] != null ? Number(m[4]) : 1;
    const suffix = m[5] || "";

    // 收集 hunk 内容直到下一个 hunk header 或文件结束
    const hunkLines: string[] = [];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (hunkHeaderRe.test(next)) break;
      if (next.startsWith("diff --git ")) break;
      // 允许空行出现在 hunk 内：补成新增/上下文行
      hunkLines.push(next);
      i++;
    }

    // 判定“新增文件 hunk”：oldStart=0 且 oldCount=0 是最典型的 new file patch
    const preferAdd = oldStart === 0 && oldCount === 0;
    let computedOld = 0;
    let computedNew = 0;

    const fixedHunkLines = hunkLines.map((hl) => {
      if (!hl) {
        // 空行：新增文件用 '+'，其他用 ' '
        const pref = preferAdd ? "+" : " ";
        computedOld += pref === " " ? 1 : 0;
        computedNew += 1;
        return pref;
      }
      if (!isValidHunkLine(hl)) {
        const pref = preferAdd ? "+" : " ";
        const fixed = pref + hl;
        computedOld += pref === " " ? 1 : 0;
        computedNew += 1;
        return fixed;
      }
      const c = hl[0];
      if (c === " ") {
        computedOld += 1;
        computedNew += 1;
      } else if (c === "+") {
        computedNew += 1;
      } else if (c === "-") {
        computedOld += 1;
      } else {
        // '\ No newline at end of file' 不计入行数
      }
      return hl;
    });

    const safeOldCount = Number.isFinite(computedOld) ? computedOld : oldCount;
    const safeNewCount = Number.isFinite(computedNew) ? computedNew : newCount;
    out.push(`@@ -${oldStart},${safeOldCount} +${newStart},${safeNewCount} @@${suffix}`);
    out.push(...fixedHunkLines);
  }

  return out.join("\n").trimEnd() + "\n";
}

function splitDiffIntoFileBlocks(patchText: string): FileBlock[] {
  const re = /^diff --git a\/(.+?) b\/(.+?)\s*$/gm;
  const matches: Array<{ index: number; aPath: string; bPath: string }> = [];
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(patchText))) {
    matches.push({ index: m.index, aPath: m[1], bPath: m[2] });
  }
  if (!matches.length) return [];
  const blocks: FileBlock[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : patchText.length;
    blocks.push({ aPath: matches[i].aPath, bPath: matches[i].bPath, text: patchText.slice(start, end).trimEnd() + "\n" });
  }
  return blocks;
}

function isCreateBlock(text: string) {
  return /(^|\n)---\s+\/dev\/null\s*($|\n)/.test(text);
}

function isDeleteBlock(text: string) {
  return /(^|\n)\+\+\+\s+\/dev\/null\s*($|\n)/.test(text);
}

/**
 * 直接应用补丁（不需要确认，完全自动化）
 * @returns 应用结果 { success: boolean, applied: string[], failed: string[] }
 */
export async function applyPatchTextDirectly(patchText: string): Promise<{ success: boolean; applied: string[]; failed: string[] }> {
  const applied: string[] = [];
  const failed: string[] = [];

  patchText = stripMarkdownFences(patchText);
  if (!isProbablyUnifiedDiff(patchText)) {
    return { success: false, applied, failed: ["不是有效的 unified diff"] };
  }

  const blocks = splitDiffIntoFileBlocks(patchText);
  if (!blocks.length) {
    return { success: false, applied, failed: ["未解析到任何补丁内容"] };
  }

  const rb = beginRollbackCapture("自动应用补丁（diff）");

  for (const b of blocks) {
    const isCreate = isCreateBlock(b.text);
    const isDelete = isDeleteBlock(b.text);
    const targetPath = (isDelete ? b.aPath : b.bPath)?.trim();

    if (!targetPath || targetPath === "/dev/null") {
      failed.push("异常补丁路径");
      continue;
    }

    const uri = await getWorkspaceFileUri(targetPath);
    if (!uri) {
      failed.push(`${targetPath}: 无工作区`);
      continue;
    }

    // 记录回滚快照：应用前的文件状态（新增文件 beforeExists=false，会在 rollback 时删除）
    await rb.addFile(targetPath);

    const exists = await pathExists(uri);
    let oldText = "";
    if (exists) {
      const data = await vscode.workspace.fs.readFile(uri);
      oldText = Buffer.from(data).toString("utf8");
    }
    // 兼容：旧文件末尾缺少换行会导致 diff 库严格匹配失败
    const oldTextForPatch = exists ? ensureTrailingNewline(oldText) : oldText;

    const actionLabel = isDelete ? "删除" : isCreate ? "新增" : "修改";

    if (isDelete) {
      if (!exists) {
        failed.push(`${targetPath}: 文件不存在`);
        continue;
      }
      try {
        // 先尝试用回收站删除
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        applied.push(`${actionLabel}: ${targetPath}`);
      } catch {
        // 回收站不支持（如 WSL），尝试直接删除
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: false });
          applied.push(`${actionLabel}: ${targetPath}`);
        } catch {
          // VSCode API 也失败，使用 Linux rm 命令
          try {
            const filePath = uri.fsPath;
            await execAsync(`rm -f "${filePath}"`);
            applied.push(`${actionLabel}: ${targetPath}`);
          } catch (e3) {
            failed.push(`${targetPath}: ${e3 instanceof Error ? e3.message : String(e3)}`);
          }
        }
      }
      continue;
    }

    // create / modify
    let newText: string | false = false;
    const normalized = normalizeHunksForDiffLib(b.text);
    try {
      newText = applyPatch(oldTextForPatch, normalized);
    } catch (e) {
      // 多数是 hunk header 行数不匹配或 hunk 内缺少前缀导致的 Unknown line
      failed.push(`${targetPath}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (newText === false) {
      failed.push(`${targetPath}: 补丁上下文不匹配`);
      continue;
    }

    try {
      // 兜底：防止模型把 ``` fence 混进代码文件内容
      const stripped = stripWholeFileMarkdownFencesIfLikely({ targetPath, text: newText });
      await writeFileUtf8(uri, stripped.text);
      applied.push(`${actionLabel}: ${targetPath}`);
    } catch (e) {
      failed.push(`${targetPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 只有当实际应用过文件时才入栈
  if (applied.length > 0) rb.finalize();

  return {
    success: failed.length === 0 && applied.length > 0,
    applied,
    failed
  };
}

export async function applyPatchTextWithPreviewAndConfirm(patchText: string) {
  patchText = stripMarkdownFences(patchText);
  if (!isProbablyUnifiedDiff(patchText)) {
    vscode.window.showWarningMessage("看起来不是 unified diff（建议让模型输出以 diff --git 开头的补丁）。");
  }

  const blocks = splitDiffIntoFileBlocks(patchText);
  if (!blocks.length) {
    vscode.window.showErrorMessage("未解析到任何补丁内容。");
    return;
  }

  const rb = beginRollbackCapture("手动确认应用补丁（diff）");
  let appliedCount = 0;

  for (const b of blocks) {
    const isCreate = isCreateBlock(b.text);
    const isDelete = isDeleteBlock(b.text);
    const targetPath = (isDelete ? b.aPath : b.bPath)?.trim();

    if (!targetPath || targetPath === "/dev/null") {
      vscode.window.showWarningMessage("检测到异常补丁路径，已跳过一段。");
      continue;
    }

    const uri = await getWorkspaceFileUri(targetPath);
    if (!uri) {
      vscode.window.showErrorMessage("当前没有打开的工作区文件夹（workspaceFolders 为空）。");
      return;
    }

    const exists = await pathExists(uri);
    let oldText = "";
    if (exists) {
      const data = await vscode.workspace.fs.readFile(uri);
      oldText = Buffer.from(data).toString("utf8");
    } else {
      oldText = "";
    }
    const oldTextForPatch = exists ? ensureTrailingNewline(oldText) : oldText;

    const actionLabel = isDelete ? "删除" : isCreate ? "新增" : "修改";

    if (isDelete) {
      const left = exists ? uri : await createUntitledDoc("", `${targetPath} (missing)`);
      const right = await createUntitledDoc("", `${targetPath} (deleted)`);
      await vscode.commands.executeCommand("vscode.diff", left, right, `Patch Preview: ${actionLabel} ${targetPath}`);

      const pick = await vscode.window.showWarningMessage(
        `确认删除文件 ${targetPath} ?`,
        { modal: true },
        "删除",
        "跳过"
      );
      if (pick !== "删除") continue;
      await rb.addFile(targetPath);
      if (!exists) {
        vscode.window.showWarningMessage(`文件不存在，跳过删除：${targetPath}`);
        continue;
      }
      try {
        // 先尝试用回收站删除
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch {
        try {
          // 回收站不支持（如 WSL），直接删除
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        } catch {
          // VSCode API 也失败，使用 Linux rm 命令
          const filePath = uri.fsPath;
          await execAsync(`rm -f "${filePath}"`);
        }
      }
      vscode.window.showInformationMessage(`已删除：${targetPath}`);
      appliedCount += 1;
      continue;
    }

    // create / modify：用 applyPatch 应用单文件 patch
    let newText: string | false = false;
    const normalized = normalizeHunksForDiffLib(b.text);
    try {
      newText = applyPatch(oldTextForPatch, normalized);
    } catch (e) {
      vscode.window.showErrorMessage(`补丁应用失败：${targetPath}（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    if (newText === false) {
      vscode.window.showErrorMessage(`补丁应用失败：${targetPath}（可能上下文不匹配）`);
      continue;
    }

    const left = exists ? uri : await createUntitledDoc("", `${targetPath} (new file)`);
    const right = await createUntitledDoc(newText, `${targetPath} (patched)`);
    await vscode.commands.executeCommand("vscode.diff", left, right, `Patch Preview: ${actionLabel} ${targetPath}`);

    const pick = await vscode.window.showWarningMessage(
      `确认${actionLabel}文件 ${targetPath} ?`,
      { modal: true },
      "应用",
      "跳过"
    );
    if (pick !== "应用") continue;

    await rb.addFile(targetPath);
    const stripped = stripWholeFileMarkdownFencesIfLikely({ targetPath, text: newText });
    await writeFileUtf8(uri, stripped.text);
    vscode.window.showInformationMessage(`已${actionLabel}：${targetPath}`);
    appliedCount += 1;
  }

  if (appliedCount > 0) rb.finalize();
}


