import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { DeepSeekViewProvider } from "./views/DeepSeekViewProvider";
import { applyPatchTextWithPreviewAndConfirm } from "./workspace/applyPatch";
import { DeepSeekPlaywright } from "./deepseek/DeepSeekPlaywright";
import { rollbackLast } from "./workspace/rollback";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Deepseek Coder");
  try {
    // 让你一眼判断是否真的“加载并激活”了扩展
    console.log("[deepseek-coder] activate()");
    vscode.window.setStatusBarMessage("Deepseek Coder 已激活", 2500);
  } catch {
    // ignore
  }

  // 某些宿主（或较老版本）可能没有 webview view provider 能力；提前兜底提示
  if (typeof (vscode.window as any).registerWebviewViewProvider !== "function") {
    vscode.window.showErrorMessage(
      "当前 VSCode/Cursor 版本不支持 registerWebviewViewProvider：侧边栏 Webview 视图无法加载。请升级宿主版本。"
    );
    return;
  }

  const deepseek = new DeepSeekPlaywright(context.globalStorageUri);
  const provider = new DeepSeekViewProvider(context, deepseek);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DeepSeekViewProvider.viewType, provider, {
      // 需求：每次进入侧边栏不保留上次 UI（避免“回来还是上次对话”）
      webviewOptions: { retainContextWhenHidden: false }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekCoder.applyPatchFromClipboard", async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text?.trim()) {
        await provider.notify("⚠️ 剪贴板为空：没有可应用的补丁内容。");
        return;
      }
      await applyPatchTextWithPreviewAndConfirm(text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekCoder.addSelectionToContext", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await provider.notify("⚠️ 没有活动编辑器。");
        return;
      }
      const selection = editor.selection;
      const text = editor.document.getText(selection) || editor.document.getText();
      await provider.addContextSnippet({
        title: `选区: ${vscode.workspace.asRelativePath(editor.document.uri)}`,
        content: text
      });
      await provider.notify("✅ 已加入上下文（在菜单里可复制提示词/Playwright 发送）。");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekCoder.rollbackLastChange", async () => {
      const r = await rollbackLast();
      if (r.ok) vscode.window.showInformationMessage(r.message);
      else vscode.window.showWarningMessage(r.message);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseekCoder.installPlaywrightChromium", async () => {
      const cliJs = path.join(context.extensionPath, "node_modules", "playwright", "cli.js");
      output.show(true);
      output.appendLine(`[deepseek-coder] installing chromium via playwright cli: ${cliJs}`);

      // 基础检查：如果包里没带 playwright，这里会直接失败
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(cliJs));
      } catch {
        vscode.window.showErrorMessage("未找到 Playwright CLI（extension/node_modules/playwright/cli.js）。请重新安装扩展。");
        return;
      }

      // 需要联网下载 chromium 二进制；下载位置由 Playwright 管理（默认用户缓存目录）
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Deepseek Coder：正在安装 Playwright Chromium…", cancellable: false },
        async () => {
          await new Promise<void>((resolve, reject) => {
            const node = process.execPath;
            const child = spawn(node, [cliJs, "install", "chromium"], {
              cwd: context.extensionPath,
              env: { ...process.env }
            });
            child.stdout.on("data", (d) => output.appendLine(String(d).trimEnd()));
            child.stderr.on("data", (d) => output.appendLine(String(d).trimEnd()));
            child.on("error", (err) => reject(err));
            child.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`playwright install chromium exited with code ${code}`));
            });
          });
        }
      );

      vscode.window.showInformationMessage("✅ Playwright Chromium 安装完成。现在可以打开 Playwright 登录 DeepSeek 了。");
    })
  );

  context.subscriptions.push({ dispose: () => void deepseek.close() });
  context.subscriptions.push(output);
}

export function deactivate() {}


