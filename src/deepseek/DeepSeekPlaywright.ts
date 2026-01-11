import * as vscode from "vscode";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

type SendResult = {
  assistantText: string;
};

export type PlaywrightDebugEvent = {
  level: "info" | "warn" | "error";
  msg: string;
  data?: Record<string, unknown>;
};

type DebugFn = (e: PlaywrightDebugEvent) => void;

export class DeepSeekPlaywright {
  private ctx?: BrowserContext;
  private page?: Page;

  constructor(private readonly storageDir: vscode.Uri) {}

  private isDefaultDeepThinkEnabled(): boolean {
    // 默认不启用（用户要求：默认不打开）
    return vscode.workspace.getConfiguration().get<boolean>("deepseekCoder.defaultDeepThink") ?? false;
  }

  private async ensureDeepThinkEnabled(page: Page, debug?: DebugFn, desired?: boolean) {
    const want = desired ?? this.isDefaultDeepThinkEnabled();
    // DeepSeek UI 经常改版：DeepThink 文本可能只是 <span>，真正可点的是祖先元素。
    // 关键：很多组件不响应 element.click()（缺少 pointer/mouse 事件链），所以这里用“算坐标 + page.mouse.click()”。
    const detect = async () => {
      return await page
        .evaluate(() => {
          const norm = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
          const isVisible = (el: Element) => {
            const h = el as HTMLElement;
            const r = h.getBoundingClientRect();
            const s = window.getComputedStyle(h as any);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          };
          const textMatches = (t: string) => {
            const x = norm(t);
            return x === "DeepThink" || x === "深度思考" || x === "深度 思考" || /DeepThink/i.test(x) || /深度思考/.test(x);
          };
          const pickClickable = (el: Element): HTMLElement | null => {
            const h = el as HTMLElement;
            const cand =
              (h.closest(
                "button,[role='button'],[aria-pressed],[aria-checked],[class*='ds-toggle-button'],[class*='toggle'],[class*='Toggle'],label"
              ) as HTMLElement | null) || h;
            return cand;
          };
          const getState = (clickEl: HTMLElement): "on" | "off" | "unknown" => {
            const aria =
              clickEl.getAttribute("aria-pressed") ||
              clickEl.getAttribute("aria-checked") ||
              clickEl.getAttribute("data-state") ||
              "";
            const cls = String(clickEl.getAttribute("class") || "");
            const hasChecked = !!clickEl.querySelector("input[type='checkbox']:checked,input[type='radio']:checked");
            const hasAny = !!clickEl.querySelector("input[type='checkbox'],input[type='radio']");
            const onByCls = /\b(ds-toggle-button--selected|selected|checked|is-active|active|on)\b/i.test(cls);
            const offByCls = /\b(ds-toggle-button--unselected|unselected|off)\b/i.test(cls);
            if (aria === "true") return "on";
            if (aria === "false") return "off";
            if (hasChecked) return "on";
            if (hasAny && !hasChecked) return "off";
            if (onByCls) return "on";
            if (offByCls) return "off";
            // DeepSeek 当前 UI：off 状态可能只是没有 --selected（不一定带 --unselected）
            if (/\bds-toggle-button\b/.test(cls) && !/\bds-toggle-button--selected\b/.test(cls)) return "off";
            return "unknown";
          };
          const centerOf = (el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
          };

          // 收集候选 label：优先 span._6dbc175，其次扫描短文本节点
          const labels: Element[] = [];
          for (const el of Array.from(document.querySelectorAll("span._6dbc175"))) {
            if (!isVisible(el)) continue;
            const t = norm(((el as any).innerText || (el as any).textContent || "") as string);
            if (!t || t.length > 40) continue;
            if (textMatches(t)) labels.push(el);
          }
          if (!labels.length) {
            const all = Array.from(document.querySelectorAll("span,button,[role='button'],div,label")).filter(isVisible);
            for (const el of all) {
              const t = norm(((el as any).innerText || (el as any).textContent || "") as string);
              if (!t || t.length > 40) continue;
              if (textMatches(t)) labels.push(el);
            }
      }
          if (!labels.length) return { found: false as const, state: "unknown" as const };

          // 选择最靠近页面底部的那个（通常是输入区旁边的开关）
          const ranked = labels
            .map((lab) => {
              const clickEl = pickClickable(lab);
              if (!clickEl) return null;
              const c = centerOf(clickEl);
              return {
                labTag: (lab as any).tagName,
                labClass: String((lab as any).getAttribute?.("class") || "").slice(0, 80),
                clickTag: clickEl.tagName,
                clickClass: String(clickEl.getAttribute("class") || "").slice(0, 120),
                aria:
                  clickEl.getAttribute("aria-pressed") ||
                  clickEl.getAttribute("aria-checked") ||
                  clickEl.getAttribute("data-state") ||
                  "",
                state: getState(clickEl),
                ...c
              };
            })
            .filter(Boolean) as any[];
          if (!ranked.length) return { found: false as const, state: "unknown" as const };

          ranked.sort((a, b) => (a.cy ?? 0) - (b.cy ?? 0));
          const best = ranked[ranked.length - 1];
          return { found: true as const, ...best };
        })
        .catch(() => ({ found: false as const, state: "unknown" as const } as any));
    };

    try {
      // 最多 3 次：每次都重新检测坐标与状态（避免 UI 变化/多候选）
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await detect();
        if (!cur?.found) {
          debug?.({ level: "warn", msg: "DeepThink toggle not found (by text scan)" });
        return;
      }
        debug?.({ level: "info", msg: "DeepThink detected", data: { attempt, ...cur } });

        const ok = (want && cur.state === "on") || (!want && cur.state === "off");
        if (ok) return;

        if (typeof (cur as any).cx === "number" && typeof (cur as any).cy === "number") {
          try {
            await page.mouse.click((cur as any).cx, (cur as any).cy, { delay: 20 });
          } catch {
            // ignore
          }
        }
        await this.safeWait(page, 260);
      }
    } catch (e) {
      debug?.({
        level: "warn",
        msg: "ensureDeepThinkEnabled failed (ignored)",
        data: { error: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  async openAndLetUserLogin() {
    if (this.ctx && this.page) {
      await this.page.bringToFront();
      return;
    }

    // 用持久化 profile，让用户登录一次后可复用 cookie
    const userDataDir = vscode.Uri.joinPath(this.storageDir, "playwright-profile").fsPath;

    this.ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false
    });
    this.page = await this.ctx.newPage();
    this.ctx.on("close", () => {
      this.ctx = undefined;
      this.page = undefined;
    });
    this.page.on("close", () => {
      this.page = undefined;
    });
    await this.page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded" });
    await this.page.bringToFront();
  }

  async close() {
    try {
      await this.ctx?.close();
    } finally {
      this.ctx = undefined;
      this.page = undefined;
    }
  }

  /**
   * 立即尝试在当前页面切换 DeepThink（用于 UI 勾选时实时生效）
   * 若页面未打开/未登录导致找不到开关，会静默失败（通过 debug 输出原因）。
   */
  async setDeepThink(desired: boolean, debug?: DebugFn) {
    const page = this.page;
    if (!page) {
      debug?.({ level: "warn", msg: "setDeepThink: no active page (open Playwright first)" });
      return;
    }
    await this.ensureDeepThinkEnabled(page, debug, !!desired);
  }

  /**
   * 等待 DeepSeek 准备好接收新消息（确保上一个回复已完成）
   * 检测：暂停按钮消失，发送按钮出现
   */
  private async waitForDeepSeekReady(page: Page, debug?: DebugFn) {
    debug?.({ level: "info", msg: "waiting for DeepSeek to be ready" });
    
    const start = Date.now();
    const maxWait = 120000; // 最多等待 2 分钟
    
    while (Date.now() - start < maxWait) {
      // 检查是否有"暂停"按钮（正在生成回复时会显示）
      // DeepSeek 的暂停按钮通常是一个正方形图标，或者 class 包含 stop/pause
      const stopButtonSelectors = [
        "div[class*='ds-icon-button'] svg rect",  // 正方形图标（暂停）
        "div[class*='stop']",
        "button[class*='stop']",
        "[aria-label*='stop']",
        "[aria-label*='暂停']"
      ];
      
      let isGenerating = false;
      
      // 检测是否有正方形 SVG（暂停图标通常是正方形）
      const hasStopIcon = await page.evaluate(() => {
        // 找到输入区域附近的 SVG
        const svgs = document.querySelectorAll("div[class*='ds-icon-button'] svg");
        for (let i = 0; i < svgs.length; i++) {
          const svg = svgs[i];
          // 暂停按钮通常包含一个 rect 元素（正方形）
          const rect = svg.querySelector("rect");
          if (rect) {
            const parent = svg.closest("div[class*='ds-icon-button']");
            if (parent) {
              const parentRect = parent.getBoundingClientRect();
              // 只检查可见的、在底部区域的按钮
              if (parentRect.width > 20 && parentRect.top > window.innerHeight * 0.5) {
                return true;  // 找到暂停按钮
              }
            }
          }
        }
        return false;
      }).catch(() => false);
      
      if (hasStopIcon) {
        isGenerating = true;
        debug?.({ level: "info", msg: "DeepSeek is generating, waiting...", data: { elapsed: Date.now() - start } });
      }
      
      // 如果没有检测到暂停按钮，检查发送按钮是否存在
      if (!isGenerating) {
        const sendBtn = page.locator("div[class*='_7436101']").last();
        const sendBtnCount = await sendBtn.count().catch(() => 0);
        if (sendBtnCount > 0) {
          const isVisible = await sendBtn.isVisible().catch(() => false);
          if (isVisible) {
            debug?.({ level: "info", msg: "DeepSeek is ready (send button visible)" });
            return;  // 可以发送了
          }
        }
      }
      
      // 等待一下再检查
      await this.safeWait(page, 1000);
    }
    
    debug?.({ level: "warn", msg: "timeout waiting for DeepSeek to be ready, proceeding anyway" });
  }

  /**
   * 专门针对 DeepSeek UI 的发送逻辑
   */
  private async sendPromptToDeepSeek(
    page: Page,
    prompt: string,
    debug?: DebugFn,
    deepThink?: boolean,
    messageLocator?: ReturnType<Page["locator"]>,
    baseCount?: number
  ) {
    // 0. 等待上一个回复完成（确保不是"暂停"按钮状态）
    await this.waitForDeepSeekReady(page, debug);
    await this.ensureDeepThinkEnabled(page, debug, deepThink);
    
    // 1. 找到输入框并填充内容
    const input = page.locator("textarea").first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    
    // 清空现有内容
    await input.fill("");
    await this.safeWait(page, 100);
    
    // 填充新内容
    await input.fill(prompt);
    debug?.({ level: "info", msg: "prompt filled", data: { promptChars: prompt.length } });
    
    // 等待一下让 UI 更新
    await this.safeWait(page, 500);
    
    const isGeneratingNow = async (): Promise<boolean> => {
      // 尽量与 waitForDeepSeekReady 的“stop icon”判定保持一致
      return await page
        .evaluate(() => {
          const svgs = document.querySelectorAll("div[class*='ds-icon-button'] svg");
          for (let i = 0; i < svgs.length; i++) {
            const svg = svgs[i];
            const rect = svg.querySelector("rect");
            if (!rect) continue;
            const parent = svg.closest("div[class*='ds-icon-button']");
            if (!parent) continue;
            const r = parent.getBoundingClientRect();
            if (r.width > 20 && r.top > window.innerHeight * 0.5) return true;
          }
          return false;
        })
        .catch(() => false);
    };

    const isMessageCountIncreased = async (): Promise<boolean> => {
      if (!messageLocator) return false;
      if (typeof baseCount !== "number") return false;
      const c = await messageLocator.count().catch(() => 0);
      return c > baseCount;
    };

    const confirmSent = async (): Promise<boolean> => {
      // 多信号确认：避免仅靠 textarea 清空导致误判
      if (await isGeneratingNow()) return true;
      if (await isMessageCountIncreased()) return true;
      const remaining = await input.inputValue().catch(() => prompt);
      if (remaining.length < prompt.length * 0.3) return true;
      return false;
    };

    // 2. 找到并点击发送按钮（DeepSeek 的发送按钮）
    // 通过诊断确认：发送按钮 class 包含 _7436101 和 ds-icon-button
    const sendButtonSelectors = [
      // DeepSeek 特有的发送按钮（已通过诊断确认）
      "div[class*='_7436101']",  // 发送按钮的特有 class
      "div.ds-icon-button.ds-icon-button--l:last-of-type",  // 输入区域的最后一个图标按钮
      // 备用选择器
      "div[class*='ds-icon-button'][class*='sizing-container']:last-child",
      "div[class*='bcc55ca1']",  // 另一个可能的 class
      // 通用选择器
      "button[type='submit']",
      "div[class*='send']"
    ];
    
    let sent = false;
    
    // 尝试各种发送按钮选择器
    for (const selector of sendButtonSelectors) {
      try {
        const btn = page.locator(selector).last();
        const count = await btn.count().catch(() => 0);
        if (count > 0) {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            await btn.click({ force: true });
            debug?.({ level: "info", msg: "clicked send button", data: { selector } });
            await this.safeWait(page, 800);
            
            // 检查是否发送成功（多信号确认：生成中 / 消息增量 / 输入框明显变短）
            if (await confirmSent()) {
              sent = true;
              debug?.({ level: "info", msg: "send confirmed (input cleared)" });
              break;
            }
          }
        }
      } catch {
        // 继续尝试下一个选择器
      }
    }
    
    // 3. 如果按钮点击没成功，尝试键盘快捷键
    if (!sent) {
      debug?.({ level: "warn", msg: "button click failed, trying keyboard shortcuts" });
      
      // 尝试 Enter
      await input.click();
      await input.press("Enter");
      await this.safeWait(page, 500);

      if (await confirmSent()) {
        sent = true;
        debug?.({ level: "info", msg: "sent via Enter key" });
      }
      
      if (!sent) {
        // 尝试 Ctrl+Enter
        await input.press("Control+Enter");
        await this.safeWait(page, 500);

        if (await confirmSent()) {
          sent = true;
          debug?.({ level: "info", msg: "sent via Ctrl+Enter" });
        }
      }
      
      if (!sent) {
        // 尝试 Meta+Enter (Mac)
        await input.press("Meta+Enter");
        await this.safeWait(page, 500);

        if (await confirmSent()) {
          sent = true;
          debug?.({ level: "info", msg: "sent via Meta+Enter" });
        }
      }
    }
    
    // 4. 最后的尝试：通过 JavaScript 直接触发
    if (!sent) {
      debug?.({ level: "warn", msg: "all methods failed, trying JS click on visible buttons" });
      
      // 在页面上找到所有可见的、可能是发送按钮的元素并点击
      await page.evaluate(() => {
        // 找到输入区域附近的可点击元素
        const textareas = document.querySelectorAll("textarea");
        if (textareas.length > 0) {
          const textarea = textareas[0];
          const parent = textarea.closest("div[class*='input'], div[class*='Input'], form, div[class*='chat']");
          if (parent) {
            // 找到父元素中的所有按钮和可点击元素
            const clickables = parent.querySelectorAll("button, div[role='button'], [class*='cursor-pointer']");
            for (let i = 0; i < clickables.length; i++) {
              const el = clickables[i];
              const rect = el.getBoundingClientRect();
              // 找到在输入框右侧的元素（可能是发送按钮）
              if (rect.width > 20 && rect.height > 20) {
                (el as HTMLElement).click();
                break;
              }
            }
          }
        }
      });
      
      await this.safeWait(page, 800);
      if (await confirmSent()) {
        sent = true;
        debug?.({ level: "info", msg: "sent via JS click" });
      }
    }
    
    if (!sent) {
      debug?.({ level: "error", msg: "failed to send prompt - all methods exhausted" });
      throw new Error("无法发送消息到 DeepSeek。请尝试在浏览器中手动发送。");
    }
  }

  /**
   * 诊断方法：获取页面 DOM 结构信息，帮助调试选择器问题
   */
  async diagnosePageStructure(): Promise<string> {
    if (!this.page) {
      return "Playwright 未连接。请先打开 DeepSeek。";
    }
    if (this.page.isClosed()) {
      this.page = undefined;
      return "Playwright 页面已关闭。";
    }

    const page = this.page;
    
    try {
      const info = await page.evaluate(() => {
        const result: string[] = [];
        
        // 1. 检查可能的消息容器
        const messageSelectors = [
          "[data-message-role]",
          "[data-message-author-role]",
          "[data-role]",
          "[data-testid*='message']",
          "[class*='message']",
          "[class*='assistant']",
          "[class*='chat']",
          "[class*='markdown']",
          "[class*='prose']",
          "[class*='conversation']"
        ];
        
        result.push("=== 消息容器检测 ===");
        for (const sel of messageSelectors) {
          try {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              const first = els[0];
              const last = els[els.length - 1];
              result.push(`${sel}: ${els.length} 个`);
              result.push(`  首个: ${first.tagName}.${first.className.slice(0, 100)}`);
              if (els.length > 1) {
                result.push(`  末个: ${last.tagName}.${last.className.slice(0, 100)}`);
              }
            }
          } catch {
            // 忽略无效选择器
          }
        }
        
        // 2. 检查代码块
        result.push("\n=== 代码块检测 ===");
        const preEls = document.querySelectorAll("pre");
        result.push(`pre: ${preEls.length} 个`);
        const codeEls = document.querySelectorAll("code");
        result.push(`code: ${codeEls.length} 个`);
        const preCodeEls = document.querySelectorAll("pre code");
        result.push(`pre code: ${preCodeEls.length} 个`);
        
        // 3. 获取最后一个代码块的内容预览
        if (preCodeEls.length > 0) {
          const lastPreCode = preCodeEls[preCodeEls.length - 1];
          const text = (lastPreCode.textContent || "").trim();
          result.push(`\n最后一个 pre code 内容预览 (${text.length} 字符):`);
          result.push(text.slice(0, 500));
        }
        
        // 4. 检查输入框
        result.push("\n=== 输入框检测 ===");
        const textareas = document.querySelectorAll("textarea");
        result.push(`textarea: ${textareas.length} 个`);
        const editables = document.querySelectorAll("[contenteditable='true']");
        result.push(`contenteditable: ${editables.length} 个`);
        
        // 5. 获取页面可见文本的一部分
        result.push("\n=== 页面文本预览 ===");
        const root = document.getElementById("root") || document.body;
        const text = (root.innerText || "").trim();
        result.push(`总长度: ${text.length} 字符`);
        result.push(`尾部 500 字符:\n${text.slice(-500)}`);
        
        return result.join("\n");
      });
      
      return info;
    } catch (e) {
      return `诊断失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * 诊断 Stop 按钮与 Thinking/Thought 文本（用于更新选择器与前端折叠规则）
   * - 会 best-effort 自动开启 DeepThink
   * - 不会发送新消息（避免污染对话）
   */
  async diagnoseStopAndThink(): Promise<string> {
    if (!this.page) return "Playwright 未连接。请先运行：Deepseek Coder: Playwright 打开 DeepSeek（可登录）";
    if (this.page.isClosed()) {
      this.page = undefined;
      return "Playwright 页面已关闭。请重新打开。";
    }
    const page = this.page;

    // 按你的要求：先确保 DeepThink 开启
    await this.ensureDeepThinkEnabled(page).catch(() => {});

    try {
      const info = await page.evaluate(() => {
        const out: string[] = [];
        const now = new Date().toISOString();
        out.push(`# Deepseek Stop/Think 诊断报告`);
        out.push(`- time: ${now}`);
        out.push(`- url: ${location.href}`);
        out.push("");

        const getText = (el: Element | null | undefined) => (el ? (el as any).innerText || (el as any).textContent || "" : "");
        const isVisible = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const style = window.getComputedStyle(el as any);
          return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };

        const describeEl = (el: Element) => {
          const h = el as HTMLElement;
          const r = h.getBoundingClientRect();
          const cls = (h.getAttribute("class") || "").trim();
          const aria = (h.getAttribute("aria-label") || "").trim();
          const role = (h.getAttribute("role") || "").trim();
          const tag = h.tagName.toLowerCase();
          const txt = (getText(h) || "").trim().replace(/\s+/g, " ").slice(0, 140);
          return {
            tag,
            role,
            class: cls.slice(0, 180),
            ariaLabel: aria.slice(0, 180),
            text: txt,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          };
        };

        // 1) DeepThink 按钮状态（尽可能多抓）
        out.push(`## DeepThink 开关候选`);
        const deepThinkCandidates = Array.from(document.querySelectorAll("button, [role='button']")).filter((el) => {
          const t = (getText(el) || "").trim();
          const aria = (el.getAttribute("aria-label") || "").trim();
          return /DeepThink/i.test(t) || /深度思考/.test(t) || /DeepThink/i.test(aria) || /深度思考/.test(aria);
        });
        if (!deepThinkCandidates.length) out.push(`(none)`);
        else {
          deepThinkCandidates.slice(0, 12).forEach((el, idx) => {
            const d = describeEl(el);
            out.push(`- [${idx}] ${JSON.stringify(d)}`);
          });
        }
        out.push("");

        // 2) Stop/停止生成按钮候选：优先抓“底部区域可见”的按钮
        out.push(`## Stop/停止生成 按钮候选（底部区域）`);
        const clickable = Array.from(document.querySelectorAll("button, [role='button'], div[class*='ds-icon-button']"));
        const stopLike = clickable.filter((el) => {
          if (!isVisible(el)) return false;
          const d = describeEl(el);
          const t = `${d.text} ${d.ariaLabel} ${d.class}`.toLowerCase();
          const inBottom = d.rect.y > window.innerHeight * 0.45;
          const hasStopWord = /停止生成|停止|stop generating|stop|pause|暂停/.test(t);
          // 兜底：暂停按钮常是 svg rect（正方形）在 ds-icon-button 内
          const hasRectIcon = !!(el as HTMLElement).querySelector?.("svg rect");
          return inBottom && (hasStopWord || hasRectIcon);
        });
        if (!stopLike.length) out.push(`(none)`);
        else {
          stopLike.slice(0, 18).forEach((el, idx) => {
            const d = describeEl(el);
            out.push(`- [${idx}] ${JSON.stringify(d)}`);
          });
        }
        out.push("");

        // 3) Thinking/Thought 标签候选：抓页面上可见的 badge/文本
        out.push(`## Thinking/Thought/思考 标签候选（可见文本匹配）`);
        const allEls = Array.from(document.querySelectorAll("*")).filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          if (!isVisible(el)) return false;
          const txt = (getText(el) || "").trim();
          if (!txt || txt.length > 80) return false;
          return /Thought for|Thinking|思考|推理/i.test(txt);
        });
        if (!allEls.length) out.push(`(none)`);
        else {
          allEls.slice(0, 30).forEach((el, idx) => {
            const d = describeEl(el);
            out.push(`- [${idx}] ${JSON.stringify(d)}`);
          });
        }
        out.push("");

        // 4) 最后一条消息 raw innerText（帮助定位“思考正文”在 innerText 里长什么样）
        out.push(`## 最后一条消息 innerText（尾部 1200 字符）`);
        const msg = Array.from(document.querySelectorAll(".ds-message, [class*='ds-message']")).slice(-1)[0] as any;
        const msgText = (msg?.innerText || "").trim();
        out.push(`len=${msgText.length}`);
        out.push("```text");
        out.push(msgText.slice(-1200));
        out.push("```");

        return out.join("\n");
      });

      return info;
    } catch (e) {
      return `诊断失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async send(prompt: string): Promise<SendResult> {
    return await this.sendWithDebug(prompt);
  }

  async sendWithDebug(prompt: string, debug?: DebugFn, opts?: { deepThink?: boolean }): Promise<SendResult> {
    if (!this.page) {
      throw new Error("Playwright 未连接。请先点击「Playwright 打开 DeepSeek（可登录）」。");
    }
    if (this.page.isClosed()) {
      this.page = undefined;
      throw new Error("Playwright 页面已关闭。请重新点击「Playwright 打开 DeepSeek（可登录）」。");
    }
    const page = this.page;

    // 下面选择器可能会随 DeepSeek 网页改版而失效——这是该方案的天然缺点
    // 策略：尽量宽松地找到一个可编辑输入框，然后回车发送。
    debug?.({ level: "info", msg: "send(): locating assistant blocks + input" });
    await this.ensureDeepThinkEnabled(page, debug, opts?.deepThink);
    const { locator: assistantLocator, count: baseCount } = await this.getAssistantLocatorAndCount(page, debug);
    debug?.({ level: "info", msg: "assistant baseCount", data: { baseCount } });
    const input = page.locator("textarea, [contenteditable='true']").first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    await input.fill(prompt);
    await input.press("Enter");
    debug?.({ level: "info", msg: "prompt sent", data: { promptChars: prompt.length } });

    // 等待“有新内容出现且稳定一会儿”
    const assistantText = await this.waitForAssistantTextFromIndex(page, assistantLocator, baseCount);
    return { assistantText };
  }

  async sendStreaming(
    prompt: string,
    onUpdate: (u: { text: string; done: boolean }) => void,
    opts?: { signal?: AbortSignal }
  ): Promise<SendResult> {
    return await this.sendStreamingWithDebug(prompt, onUpdate, opts);
  }

  async sendStreamingWithDebug(
    prompt: string,
    onUpdate: (u: { text: string; done: boolean }) => void,
    opts?: { signal?: AbortSignal; debug?: DebugFn; deepThink?: boolean }
  ): Promise<SendResult> {
    if (!this.page) {
      throw new Error("Playwright 未连接。请先点击「Playwright 打开 DeepSeek（可登录）」。");
    }
    if (this.page.isClosed()) {
      this.page = undefined;
      throw new Error("Playwright 页面已关闭。请重新点击「Playwright 打开 DeepSeek（可登录）」。");
    }
    const page = this.page;

    opts?.debug?.({ level: "info", msg: "sendStreaming(): using ds-message selector" });

    // 使用 .ds-message 选择器（已验证有效）
    const { locator: messageLocator, count: baseCount } = await this.getAssistantLocatorAndCount(page, opts?.debug);
    opts?.debug?.({ level: "info", msg: "message baseCount", data: { baseCount } });

    // 发送 prompt（专门针对 DeepSeek UI）
    await this.sendPromptToDeepSeek(page, prompt, opts?.debug, opts?.deepThink, messageLocator, baseCount);

    // 等待新消息并获取内容
    const assistantText = await this.waitForNewMessageStreaming(
      page,
      messageLocator,
      baseCount,
      onUpdate,
      opts?.signal,
      opts?.debug
    );
    return { assistantText };
  }

  /**
   * 尝试点击 DeepSeek 网页上的“停止生成/Stop generating”按钮。
   * 这是 best-effort：不同版本 UI 选择器可能变化，所以做多策略匹配 + 多次重试。
   */
  async stopGenerating(debug?: DebugFn): Promise<boolean> {
    if (!this.page) return false;
    if (this.page.isClosed()) {
      this.page = undefined;
      return false;
    }
    const page = this.page;

    // 可能出现的文本/按钮
    const selectors = [
      "button:has-text('停止生成')",
      "button:has-text('停止')",
      "button:has-text('Stop generating')",
      "button:has-text('Stop')",
      "[role='button']:has-text('停止生成')",
      "[role='button']:has-text('Stop generating')",
      "[aria-label*='停止生成']",
      "[aria-label*='Stop generating']"
    ];

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const sel of selectors) {
        try {
          const loc = page.locator(sel).first();
          const c = await loc.count().catch(() => 0);
          if (!c) continue;
          debug?.({ level: "info", msg: "stopGenerating: found candidate", data: { sel, attempt } });
          await loc.click({ timeout: 1200 });
          await this.safeWait(page, 200);
          return true;
        } catch {
          // try next selector
        }
      }
      // 有时第一次点击不生效，稍等再试
      await this.safeWait(page, 250);
    }

    // 兜底：stop 按钮可能是纯图标（无文字、无 aria-label），例如你截图里的：
    // <div class="_7436101 ds-icon-button ...">...</div>
    const iconSelectors = [
      "div[class*='_7436101'][class*='ds-icon-button']",
      "div.ds-icon-button",
      "div[class*='ds-icon-button']",
      "button.ds-icon-button",
      "button[class*='ds-icon-button']"
    ];

    for (let attempt = 0; attempt < 4; attempt++) {
      let clicked = false;
      for (const sel of iconSelectors) {
        try {
          const loc = page.locator(sel).filter({ hasNot: page.locator("textarea") }).last();
          const c = await loc.count().catch(() => 0);
          if (!c) continue;
          const vis = await loc.isVisible().catch(() => false);
          if (!vis) continue;
          debug?.({ level: "info", msg: "stopGenerating: click icon button (best-effort)", data: { sel, attempt } });
          await loc.click({ timeout: 1200, force: true });
          clicked = true;
          await this.safeWait(page, 250);
          break;
        } catch {
          // try next
        }
      }

      // 再兜底：直接在页面里找输入框附近“最右侧按钮”点击（对抗 class/hash 变化）
      if (!clicked) {
        const ok = await page
          .evaluate(() => {
            const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
            if (!textarea) return false;
            const isVisible = (el: Element) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              const s = window.getComputedStyle(el as any);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            };
            const host =
              textarea.closest("form") ||
              textarea.closest("div[class*='input']") ||
              textarea.closest("div[class*='Input']") ||
              textarea.closest("div[class*='chat']") ||
              textarea.parentElement ||
              document.body;
            const candidates = Array.from(
              host.querySelectorAll("div[class*='_7436101'], div.ds-icon-button, div[class*='ds-icon-button'], button, [role='button']")
            ).filter((el) => isVisible(el));
            if (!candidates.length) return false;
            // 选一个最靠右的可点击元素
            const pick = candidates
              .map((el) => ({ el, r: (el as HTMLElement).getBoundingClientRect() }))
              .sort((a, b) => (a.r.x + a.r.width) - (b.r.x + b.r.width))
              .slice(-1)[0]?.el as HTMLElement | undefined;
            if (!pick) return false;
            pick.click();
            return true;
          })
          .catch(() => false);
        if (ok) {
          debug?.({ level: "info", msg: "stopGenerating: clicked rightmost composer button (evaluate)", data: { attempt } });
          clicked = true;
          await this.safeWait(page, 250);
        }
      }

      if (clicked) return true;
      await this.safeWait(page, 250);
    }

    debug?.({ level: "warn", msg: "stopGenerating: no stop button matched" });
    return false;
  }

  /**
   * 等待新消息出现并流式获取内容（使用 ds-message 选择器）
   */
  private async waitForNewMessageStreaming(
    page: Page,
    messageLocator: ReturnType<Page["locator"]>,
    baseCount: number,
    onUpdate: (u: { text: string; done: boolean }) => void,
    signal?: AbortSignal,
    debug?: DebugFn
  ): Promise<string> {
    const start = Date.now();
    
    // 1. 等待新消息出现（消息数量增加）
    debug?.({ level: "info", msg: "waiting for new message to appear" });
    let gotNew = false;
    while (Date.now() - start < 30000) {
      if (signal?.aborted) throw new Error("已取消");
      const currentCount = await messageLocator.count().catch(() => 0);
      // DeepSeek 会同时添加用户消息和 AI 回复，所以数量会增加 2
      if (currentCount > baseCount) {
        debug?.({ level: "info", msg: "new message detected", data: { baseCount, currentCount } });
        gotNew = true;
        break;
      }
      await this.safeWait(page, 300, signal);
    }
    
    if (!gotNew) {
      debug?.({ level: "warn", msg: "no new message detected, using fallback" });
      return await this.waitForMainKeyContentStreaming(page, onUpdate, signal, debug);
    }
    
    // 2. 获取最后一条消息（AI 回复）并等待内容稳定
    const lastMessage = messageLocator.last();
    let lastText = "";
    let stableCount = 0;
    let actionableSeen = false;
    const start2 = Date.now();
    
    debug?.({ level: "info", msg: "waiting for message content to stabilize" });
    
    while (Date.now() - start2 < 90000) {
      if (signal?.aborted) throw new Error("已取消");
      
      const msgText = (await lastMessage.innerText().catch(() => ""))?.trim() ?? "";
      
      if (msgText && msgText !== lastText) {
        lastText = msgText;
        stableCount = 0;
        debug?.({ level: "info", msg: "message content updated", data: { chars: msgText.length, preview: msgText.slice(0, 100) } });
        
        // 1:1 提取：优先从 DOM 拆出 thinking/answer（网页端就是这么分的）
        const key = await this.extractStructuredAssistantTextFromMessage(lastMessage, msgText, debug);
        onUpdate({ text: key, done: false });

        // 记录：看到过可执行内容，但不要立刻结束。
        // 只有当网页端“生成结束”（stop 按钮消失/发送按钮回归）才返回，
        // 避免“回复还没结束就先执行 diff/bash/toolcall”。
        // 注意：key 可能包含 <<<DS_ANSWER>>>，这里只要检测到 fenced/bare diff/toolcall/bash 即算 actionable
        actionableSeen = actionableSeen || this.isActionableKeyContentComplete(key);
      } else if (msgText) {
        stableCount++;
      }
      
      // 连续多次相同且非空就认为稳定；如果已经看到过“可执行内容”，只要稳定 1 次就尝试判断是否已结束生成
      const stableNeed = actionableSeen ? 1 : 3;
      if (lastText && stableCount >= stableNeed) {
        const stillGenerating = await page
          .evaluate(() => {
            // 输入区附近出现“正方形 rect”通常代表 stop/pause
            const svgs = document.querySelectorAll("div[class*='ds-icon-button'] svg");
            for (let i = 0; i < svgs.length; i++) {
              const svg = svgs[i];
              const rect = svg.querySelector("rect");
              if (!rect) continue;
              const parent = svg.closest("div[class*='ds-icon-button']") as HTMLElement | null;
              if (!parent) continue;
              const r = parent.getBoundingClientRect();
              if (r.width > 20 && r.top > window.innerHeight * 0.5) return true;
            }
            return false;
          })
          .catch(() => false);

        if (stillGenerating) {
          debug?.({ level: "info", msg: "message stabilized but still generating; keep waiting" });
        } else {
          debug?.({ level: "info", msg: "message content finalized", data: { chars: lastText.length, actionableSeen } });
          const finalKey = await this.extractStructuredAssistantTextFromMessage(lastMessage, lastText, debug);
          onUpdate({ text: finalKey, done: true });
          return finalKey;
        }
      }
      
      await this.safeWait(page, 600, signal);
    }
    
    debug?.({ level: "error", msg: "timeout waiting for message content" });
    throw new Error("等待 DeepSeek 回复超时（90s）。你可以在浏览器窗口里确认是否已输出。");
  }

  private buildStructuredParts(thinkingHeader: string, thinkingBody: string, answer: string): string {
    const parts: string[] = [];
    parts.push("<<<DS_THINK_HEADER>>>");
    parts.push((thinkingHeader || "").trim() || "Thinking");
    parts.push("<<<DS_THINK_BODY>>>");
    parts.push((thinkingBody || "").trim());
    parts.push("<<<DS_ANSWER>>>");
    parts.push((answer || "").trim());
    return parts.join("\n");
  }

  private async extractStructuredAssistantTextFromMessage(
    lastMessage: ReturnType<Page["locator"]>,
    fallbackInnerText: string,
    debug?: DebugFn
  ): Promise<string> {
    // 优先通过 DOM 结构分离 thinking/answer，失败再回退到旧的纯文本提取
    try {
      const raw = await lastMessage
        .evaluate((el) => {
          const root = el as HTMLElement;
          const isVisible = (x: Element) => {
            const h = x as HTMLElement;
            const r = h.getBoundingClientRect();
            const s = window.getComputedStyle(h as any);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          };
          const txt = (x: Element) => ((x as any).innerText || (x as any).textContent || "").trim();

          const children = Array.from(root.children).filter((c) => isVisible(c));
          const thinkingLike = (s: string) => /(^|\n)\s*(Thinking|Thought for|思考|推理)\b/i.test(s);
          const idx = children.findIndex((c) => thinkingLike(txt(c)));
          if (idx === -1) {
            return { ok: false, thinkingHeader: "", thinkingBody: "", answer: "" };
          }

          const thinkEl = children[idx];
          const thinkText = txt(thinkEl);
          // header：取第一行中最像 “Thought for ...” 或 “Thinking”
          const lines = thinkText
            .split(/\r?\n/)
            .map((x: string) => x.trim())
            .filter(Boolean);
          const header =
            lines.find((l: string) => /^Thought for\b/i.test(l) || /^Thinking\b/i.test(l) || /^思考\b/.test(l) || /^推理\b/.test(l)) || "Thinking";
          // body：去掉重复的 Thinking 标记行
          const bodyLines = lines.filter(
            (l: string) => !/^Thinking\b/i.test(l) && !/^Thought for\b/i.test(l) && !/^思考\b/.test(l) && !/^推理\b/.test(l)
          );
          const thinkingBody = bodyLines.join("\n").trim();

          const answerParts = children
            .slice(idx + 1)
            .map((c) => txt(c))
            .filter(Boolean);
          const answer = answerParts.join("\n\n").trim();

          return { ok: true, thinkingHeader: header, thinkingBody, answer };
        })
        .catch(() => ({ ok: false, thinkingHeader: "", thinkingBody: "", answer: "" } as any));

      if (raw?.ok) {
        const thinkingHeader = String(raw.thinkingHeader || "");
        const thinkingBody = String(raw.thinkingBody || "");
        const answerRaw = String(raw.answer || "");
        // 关键：把 answer 部分归一化成我们可识别的 toolplan/toolcall/diff/bash（必要时包裹 fenced）
        // 这样 toolplan 才能被继续流程识别并执行，而不是停在“摘要”状态。
        const answer = this.extractKeyContentFromRawReply(answerRaw);
        // 若只有 thinking 没有 answer，也照样输出结构化文本（前端会按“思考中”渲染）
        return this.buildStructuredParts(thinkingHeader, thinkingBody, answer);
      }
    } catch (e) {
      debug?.({ level: "warn", msg: "structured extract failed; fallback to text", data: { error: e instanceof Error ? e.message : String(e) } });
    }

    // fallback：旧逻辑
    return this.extractKeyContentFromRawReply(fallbackInnerText);
  }

  /**
   * 从原始回复中提取有效内容（toolplan/toolcall/diff）
   * 如果没有特殊格式，返回原文
   */
  private extractKeyContentFromRawReply(rawReply: string): string {
    // 首先清理 DeepSeek 网页 UI 文本（Copy/Download 按钮等）
    const text = this.cleanDeepSeekUIText(rawReply);
    if (!text) return "";
    
    // 尝试提取 ```toolplan ... ```
    const toolplanMatch = /```toolplan\s*([\s\S]*?)```/m.exec(text);
    if (toolplanMatch) {
      const jsonStr = (toolplanMatch[1] || "").trim();
      if (this.isValidToolJson("toolplan", jsonStr)) {
        return toolplanMatch[0].trim();
      }
    }
    
    // 尝试提取 ```toolcall ... ```
    const toolcallMatch = /```toolcall\s*([\s\S]*?)```/m.exec(text);
    if (toolcallMatch) {
      const jsonStr = (toolcallMatch[1] || "").trim();
      if (this.isValidToolJson("toolcall", jsonStr)) {
        return toolcallMatch[0].trim();
      }
    }
    
    // 尝试提取裸 JSON（toolplan 格式）
    const jsonMatch = /\{[\s\S]*?"read"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/m.exec(text);
    if (jsonMatch && this.isValidToolJson("toolplan", jsonMatch[0])) {
      return ["```toolplan", jsonMatch[0].trim(), "```"].join("\n");
    }

    // 尝试提取裸 JSON（toolcall 格式）：DeepSeek 网页端有时会把 ```toolcall``` 渲染成
    // toolcall\nCopy\nDownload\n{...}（innerText 丢失围栏）。此处用括号深度匹配补回围栏。
    const toolKeyIdx = Math.max(text.toLowerCase().lastIndexOf("toolcall"), text.search(/"tool"\s*:/));
    if (toolKeyIdx !== -1) {
      const json = this.extractFirstJsonObjectFrom(text, toolKeyIdx);
      if (json && this.isValidToolJson("toolcall", json)) {
        return ["```toolcall", json.trim(), "```"].join("\n");
      }
    }
    
    // 尝试提取 diff --git
    const diffMatch = /(^|\n)(diff --git [\s\S]*)/m.exec(text);
    if (diffMatch) {
      const diffText = this.extractDiffBlock(diffMatch[2]);
      if (diffText.length > 20) {
        return diffText;
      }
    }

    // 尝试提取 ```diff ... ```
    const fencedDiff = /```diff\s*([\s\S]*?)```/m.exec(text);
    if (fencedDiff) {
      const inner = (fencedDiff[1] || "").trim();
      if (inner.startsWith("diff --git")) return ["```diff", inner, "```"].join("\n");
    }

    // 尝试提取 bash（fenced 或污染格式）
    const bashMatch = /```(?:bash|sh|shell)\s*([\s\S]*?)```/m.exec(text);
    if (bashMatch) {
      const inner = (bashMatch[1] || "").trim();
      if (inner) return ["```bash", inner, "```"].join("\n");
    }
    const bashMarker = /(^|\n)\s*bash\s*\n([\s\S]+)$/im.exec(text);
    if (bashMarker) {
      const inner = (bashMarker[2] || "").trim();
      if (inner) return ["```bash", inner, "```"].join("\n");
    }
    
    // 没有特殊格式，返回原文
    return text;
  }

  private isActionableKeyContentComplete(key: string): boolean {
    const s = (key || "").trim();
    if (!s) return false;
    // fenced tool blocks
    if (/^```toolplan\b[\s\S]*?```$/m.test(s)) return true;
    if (/^```toolcall\b[\s\S]*?```$/m.test(s)) return true;
    if (/^```diff\b[\s\S]*?```$/m.test(s)) return true;
    if (/^```bash\b[\s\S]*?```$/m.test(s)) return true;
    // bare diff
    if (s.startsWith("diff --git ")) return true;
    return false;
  }

  /**
   * 清理 DeepSeek 网页 UI 文本（Copy/Download 按钮、代码块标签等）
   */
  private cleanDeepSeekUIText(rawText: string): string {
    let text = (rawText || "").trim();
    if (!text) return "";
    
    // 移除 DeepSeek 代码块 UI 元素（Copy/Download 按钮文本）
    // 这些文本通常出现在代码块内容的开头或中间
    const uiPatterns = [
      /\nCopy\n/g,
      /\nDownload\n/g,
      /\nCopy$/gm,
      /\nDownload$/gm,
      /^Copy\n/gm,
      /^Download\n/gm,
      /\ntext\nCopy\nDownload\n/g,
      /\ntext\nCopy\nDownload$/gm,
      /^text\nCopy\nDownload\n/gm,
      // 代码块语言标签后的 Copy/Download
      /^(toolplan|toolcall|diff|json|javascript|typescript|python|bash|sh)\nCopy\nDownload\n/gm,
      // 单独的 "text" 行（通常是误抓的标签）
      /^text$/gm,
      // DeepSeek 网页端“浏览/检索”系统状态行（不是正文）
      /^Read\s+\d+\s+web\s+pages\s*$/gim
    ];
    
    for (const pattern of uiPatterns) {
      text = text.replace(pattern, "\n");
    }
    
    // 清理多余的空行
    text = text.replace(/\n{3,}/g, "\n\n");
    
    return text.trim();
  }

  private async waitForLatestAssistantText(page: Page): Promise<string> {
    // 尝试抓取对话中最后一条 assistant 的文本（容器类名可能变化）
    const candidates = [
      "[data-message-role='assistant']",
      ".assistant",
      ".message.assistant",
      "main"
    ];

    const locator = page.locator(candidates.join(",")).last();

    // 等待内容变化：最多等 90s
    const start = Date.now();
    let last = "";
    while (Date.now() - start < 90000) {
      const txt = (await locator.innerText().catch(() => ""))?.trim() ?? "";
      if (txt && txt !== last) {
        last = txt;
      }
      // 简单“稳定判定”：连续两次相同且非空就认为完成
      await this.safeWait(page, 1200);
      const txt2 = (await locator.innerText().catch(() => ""))?.trim() ?? "";
      if (txt2 && txt2 === last) return txt2;
    }
    throw new Error("等待 DeepSeek 回复超时（90s）。你可以在浏览器窗口里确认是否已输出。");
  }

  private async getAssistantLocatorAndCount(page: Page, debug?: DebugFn): Promise<{ locator: ReturnType<Page["locator"]>; count: number }> {
    // DeepSeek 使用的是 ds-message 类名
    // 注意：DeepSeek 的消息没有区分 user/assistant 的 class，所以我们用消息总数来判断
    const selectors = [
      // DeepSeek 专用选择器（最高优先级）
      ".ds-message",
      "[class*='ds-message']",
      // 备用选择器
      "[data-message-role='assistant']",
      "[data-message-author-role='assistant']",
      "[data-role='assistant']",
      ".message.assistant",
      ".assistant",
      "[class*='message'][class*='assistant']"
    ];
    for (const sel of selectors) {
      try {
        const l = page.locator(sel);
        const c = await l.count().catch(() => 0);
        if (c > 0) {
          debug?.({ level: "info", msg: "message selector matched", data: { selector: sel, count: c } });
          return { locator: l, count: c };
        }
      } catch {
        // 忽略无效选择器
      }
    }
    debug?.({ level: "warn", msg: "no message selector matched, using fallback" });
    // 兜底：没有任何匹配时，用组合选择器，但 baseCount=0
    const fallback = page.locator(selectors.slice(0, 2).join(","));
    return { locator: fallback, count: 0 };
  }

  private async waitForAssistantTextFromIndex(
    page: Page,
    assistantLocator: ReturnType<Page["locator"]>,
    baseCount: number
  ): Promise<string> {
    const start = Date.now();
    // 等待“新一条 assistant 出现”
    let gotNew = false;
    while (Date.now() - start < 30000) {
      const c = await assistantLocator.count().catch(() => 0);
      if (c >= baseCount + 1) {
        gotNew = true;
        break;
      }
      await this.safeWait(page, 300);
    }
    if (!gotNew) {
      // 很多时候页面结构变化/消息在 shadow DOM 里，导致 assistant 选择器永远匹配不到
      // 兜底：直接轮询 main 文本并提取关键块（toolplan/diff）
      return await this.waitForMainKeyContent(page);
    }
    const target = assistantLocator.nth(baseCount);

    // 等待内容变化：最多等 90s（沿用原逻辑）
    const start2 = Date.now();
    let last = "";
    while (Date.now() - start2 < 90000) {
      const txt = (await target.innerText().catch(() => ""))?.trim() ?? "";
      if (txt && txt !== last) {
        last = txt;
      }
      await this.safeWait(page, 1200);
      const txt2 = (await target.innerText().catch(() => ""))?.trim() ?? "";
      if (txt2 && txt2 === last) return txt2;
    }
    throw new Error("等待 DeepSeek 回复超时（90s）。你可以在浏览器窗口里确认是否已输出。");
  }

  private async waitForAssistantTextFromIndexStreaming(
    page: Page,
    assistantLocator: ReturnType<Page["locator"]>,
    baseCount: number,
    onUpdate: (u: { text: string; done: boolean }) => void,
    signal?: AbortSignal,
    debug?: DebugFn
  ): Promise<string> {
    // 等待"新一条 assistant 出现"
    const start = Date.now();
    let gotNew = false;
    const maxWait = baseCount === 0 ? 2500 : 30000;
    while (Date.now() - start < maxWait) {
      if (signal?.aborted) throw new Error("已取消");
      const c = await assistantLocator.count().catch(() => 0);
      if (c >= baseCount + 1) {
        gotNew = true;
        break;
      }
      await this.safeWait(page, 300, signal);
    }
    if (!gotNew) {
      debug?.({ level: "warn", msg: "assistant selector did not match new message; fallback to text container" });
      return await this.waitForMainKeyContentStreaming(page, onUpdate, signal, debug);
    }
    const target = assistantLocator.nth(baseCount);

    const start2 = Date.now();
    let last = "";
    let stableCount = 0;

    while (Date.now() - start2 < 90000) {
      if (signal?.aborted) throw new Error("已取消");

      const txt = (await target.innerText().catch(() => ""))?.trim() ?? "";
      if (txt && txt !== last) {
        last = txt;
        stableCount = 0;
        onUpdate({ text: last, done: false });
      } else if (txt && txt === last) {
        stableCount += 1;
      }

      // "稳定判定"：连续两次相同且非空就认为完成
      if (last && stableCount >= 2) {
        onUpdate({ text: last, done: true });
        return last;
      }

      await this.safeWait(page, 800, signal);
    }
    throw new Error("等待 DeepSeek 回复超时（90s）。你可以在浏览器窗口里确认是否已输出。");
  }

  /**
   * 从 current 文本中提取"真正的模型回复"（过滤掉提示词片段）
   * 策略：找到最后一个"提示词模板签名句"，只在其后提取 toolcall/toolplan/diff
   */
  private extractKeyContentFromDelta(delta: string, debug?: DebugFn): string {
    const raw = (delta || "").trim();
    if (!raw) return "";

    // 提示词模板签名句：这些句子出现在我们发出去的提示词里，模型回复不会包含它们
    // 找到最后一个签名句的位置，只在其后提取
    const PROMPT_SIGNATURES = [
      "【Deepseek-Coder Prompt v2】",
      "你是一个代码助手。请基于以下上下文修改我的 VSCode 工作区代码。",
      "强约束：你的输出只能是以下三种之一",
      "现在请直接输出 unified diff（以 diff --git 开头），不要输出任何解释。",
      "请先输出一个工具计划（toolplan），只输出一个代码块",
      "输出完 toolplan 代码块后立刻停止。"
    ];

    let lastSignatureEnd = 0;
    for (const sig of PROMPT_SIGNATURES) {
      const idx = raw.lastIndexOf(sig);
      if (idx !== -1) {
        const endPos = idx + sig.length;
        if (endPos > lastSignatureEnd) {
          lastSignatureEnd = endPos;
        }
      }
    }

    // 只在签名句之后的文本里提取
    const afterPrompt = lastSignatureEnd > 0 ? raw.slice(lastSignatureEnd) : raw;
    debug?.({ level: "info", msg: "prompt boundary", data: { lastSignatureEnd, afterPromptChars: afterPrompt.length } });

    type Candidate = { kind: "toolcall" | "toolplan" | "diff" | "bash"; idx: number; text: string; score: number };
    const candidates: Candidate[] = [];

    // 提取 ```toolcall ... ``` / ```toolplan ... ```
    const extractFencedBlock = (tag: "toolcall" | "toolplan") => {
      const re = new RegExp("```" + tag + "\\s*([\\s\\S]*?)```", "g");
      let m: RegExpExecArray | null = null;
      while ((m = re.exec(afterPrompt))) {
        const jsonStr = (m[1] || "").trim();
        if (this.isValidToolJson(tag, jsonStr)) {
          candidates.push({ kind: tag, idx: m.index, text: (m[0] || "").trim(), score: 10 });
          debug?.({ level: "info", msg: `found ${tag}`, data: { idx: m.index, score: 10 } });
        } else {
          debug?.({ level: "warn", msg: `invalid ${tag} JSON ignored`, data: { preview: jsonStr.slice(0, 80) } });
        }
      }
    };

    extractFencedBlock("toolcall");
    extractFencedBlock("toolplan");

    // bash fenced（```bash ...```）或“bash\n命令”污染格式
    const bashRe = /```(?:bash|sh|shell)\s*([\s\S]*?)```/g;
    let bm: RegExpExecArray | null = null;
    while ((bm = bashRe.exec(afterPrompt))) {
      const cmd = (bm[1] || "").trim();
      if (cmd) {
        candidates.push({ kind: "bash", idx: bm.index, text: ["```bash", cmd, "```"].join("\n"), score: 12 });
        debug?.({ level: "info", msg: "found bash fenced", data: { idx: bm.index, score: 12 } });
      }
    }
    const bashMarkerRe = /(^|\n)\s*bash\s*\n([\s\S]+)$/im;
    const bmm = bashMarkerRe.exec(afterPrompt);
    if (bmm) {
      const cmd = (bmm[2] || "").trim();
      if (cmd) {
        candidates.push({ kind: "bash", idx: bmm.index, text: ["```bash", cmd, "```"].join("\n"), score: 11 });
        debug?.({ level: "info", msg: "found bash marker", data: { idx: bmm.index, score: 11 } });
      }
    }

    // 兼容：无 ``` 的 toolplan JSON
    const jsonRe = /\{[\s\S]*?"read"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/g;
    let jm: RegExpExecArray | null = null;
    while ((jm = jsonRe.exec(afterPrompt))) {
      const jsonStr = (jm[0] || "").trim();
      if (this.isValidToolJson("toolplan", jsonStr)) {
        candidates.push({ kind: "toolplan", idx: jm.index, text: ["```toolplan", jsonStr, "```"].join("\n"), score: 10 });
      }
    }

    // diff --git（行首）
    const diffStartRe = /(^|\n)diff --git /g;
    let dsm: RegExpExecArray | null = null;
    const diffStarts: number[] = [];
    while ((dsm = diffStartRe.exec(afterPrompt))) {
      diffStarts.push(dsm.index + (dsm[1] ? dsm[1].length : 0));
    }
    for (const startIdx of diffStarts) {
      const diffText = this.extractDiffBlock(afterPrompt.slice(startIdx));
      if (diffText.length < 20) continue;
      const hasChanges = /\n[+-][^+-]/.test(diffText);
      const score = hasChanges ? 20 : 10;
      // 不对 diff 做长度截断：长文件/new file diff 需要完整保留，否则会出现“获取不全”
      candidates.push({ kind: "diff", idx: startIdx, text: diffText, score });
      debug?.({ level: "info", msg: "found diff", data: { idx: startIdx, hasChanges, score, preview: diffText.slice(0, 80) } });
    }

    // 按分数排序（高分优先），同分时取最后出现的
    if (candidates.length) {
      candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.idx - a.idx;
      });
      debug?.({ level: "info", msg: "candidates sorted", data: { count: candidates.length, bestKind: candidates[0].kind, bestScore: candidates[0].score } });
      return candidates[0].text;
    }

    // 兜底：检查 afterPrompt 是否是"页面 UI 文字"而不是真正的回复
    const trimmed = afterPrompt.trim();
    
    // UI 噪音模式：这些是 DeepSeek 页面上的 UI 文字，不是真正的回复内容
    // 注意：只有当 trimmed 完全是这些模式时才认为是噪音
    const UI_NOISE_PATTERNS = [
      /^DeepThink$/i,
      /^AI-generated$/i,
      /^Search$/i,
      /^for reference only$/i,
      /^This response is AI-generated$/i,
      /^复制$/,
      /^重新生成$/,
      /^编辑$/,
      /^DeepThinkSearchAI-generated$/i,
      /^停止生成$/,
      /^正在思考/,
      /^正在生成/
    ];
    
    // 只有当 trimmed 非常短（< 5 字符）或完全匹配 UI 噪音模式时才返回空
    // 放宽判断，避免误判有效内容
    const isUiNoise = UI_NOISE_PATTERNS.some(p => p.test(trimmed)) || trimmed.length < 5;
    if (isUiNoise) {
      debug?.({ level: "warn", msg: "fallback content looks like UI noise, returning empty", data: { preview: trimmed.slice(0, 50), length: trimmed.length } });
      return ""; // 返回空，让调用方知道没有有效回复
    }

    // 真正的兜底：取尾部（可能是普通文本回复）
    // 如果内容较长，可能是有效的回复
    debug?.({ level: "info", msg: "fallback to afterPrompt tail", data: { chars: afterPrompt.length, preview: trimmed.slice(0, 100) } });
    // 不对兜底内容做长度截断：避免长回答/长 diff 被裁掉导致“获取不全”
    return afterPrompt;
  }

  /**
   * 从 "diff --git ..." 开头的文本中提取一个完整的 diff 块
   * 策略：
   * - 一旦进入 hunk（看到 @@），就更宽容地继续读（DeepSeek 网页渲染可能丢失 +/- 前缀）
   * - 直到遇到明显的"非代码"行（如 DeepThink/AI-generated 等页面尾部文字）
   */
  private extractDiffBlock(text: string): string {
    // 先清理 UI 文本
    const cleanedText = this.cleanDeepSeekUIText(text);
    const lines = cleanedText.split("\n");
    const result: string[] = [];
    let inHunk = false;
    let nonCodeLineCount = 0;

    // 页面尾部的 UI 文字：必须尽量“保守判定”，避免误伤真实代码行（例如 searching = True）
    const isUiNoiseLine = (t: string) => {
      const s = String(t || "").trim();
      if (!s) return false;
      if (/^DeepThink$/i.test(s)) return true;
      if (/^AI-generated$/i.test(s)) return true;
      if (/^Search$/i.test(s)) return true;
      if (/^for reference only$/i.test(s)) return true;
      if (/^This response is AI-generated$/i.test(s)) return true;
      if (s === "复制" || s === "重新生成" || s === "编辑") return true;
      if (/^Copy$/i.test(s)) return true;
      if (/^Download$/i.test(s)) return true;
      if (/^text$/i.test(s)) return true;
      if (/^停止生成$/i.test(s)) return true;
      if (/^正在思考/.test(s) || /^正在生成/.test(s)) return true;
      return false;
    };

    // markdown fence：可能是模型把 diff 包在 ```diff ... ``` 里，或消息尾部的 fence
    // 注意：真实代码也可能出现 ```（markdown 文件），因此不能无条件当作终止符
    const isFenceLine = (t: string) => /^```[\w-]*$/i.test(String(t || "").trim());

    const nextNonEmptyTrimmed = (fromIdx: number): string => {
      for (let j = fromIdx + 1; j < lines.length; j++) {
        const s = String(lines[j] || "").trim();
        if (s) return s;
      }
      return "";
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 新的 diff --git 开头（且不是第一行）= 另一个 diff 块开始，结束当前块
      if (i > 0 && line.startsWith("diff --git ")) {
        break;
      }

      // UI 噪音/围栏：只有在“后续也呈现为 UI 片段 / fence / 结束”时才认为是终止符。
      // 否则（例如代码里真的出现 Search/Copy/```），继续按 diff/hunk 规则解析，避免误判截断。
      if (trimmed) {
        const next = nextNonEmptyTrimmed(i);
        const shouldTerminate =
          (!next && (isUiNoiseLine(trimmed) || isFenceLine(trimmed))) ||
          (next && (isUiNoiseLine(trimmed) || isFenceLine(trimmed)) && (isUiNoiseLine(next) || isFenceLine(next)));
        if (shouldTerminate) break;
      }

      // 进入 hunk 后，更宽容地接受内容
      if (line.startsWith("@@ ")) {
        inHunk = true;
      }

      // 判断这一行是否"像 diff 内容"
      const isDiffMeta =
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("@@ ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from") ||
        line.startsWith("rename to") ||
        line.startsWith("copy from") ||
        line.startsWith("copy to");

      const isDiffContent =
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith("\\") || // "\ No newline at end of file"
        trimmed === "";

      if (isDiffMeta || isDiffContent) {
        result.push(line);
        nonCodeLineCount = 0;
      } else if (inHunk) {
        // 在 hunk 内，即使不是标准 diff 行，也可能是代码内容（DeepSeek 丢失了 +/- 前缀）
        // 只要不是明显的非代码，就保留
        result.push(line);
        nonCodeLineCount = 0;
      } else {
        // 不在 hunk 内，不是 diff 元信息，跳过
        nonCodeLineCount++;
        if (nonCodeLineCount >= 2) {
          break;
        }
      }
    }

    // 去掉尾部的空行
    while (result.length > 0 && result[result.length - 1].trim() === "") {
      result.pop();
    }

    return result.join("\n");
  }

  /**
   * 校验 toolcall/toolplan JSON 是否有效
   */
  private isValidToolJson(kind: "toolcall" | "toolplan", jsonStr: string): boolean {
    try {
      const obj = JSON.parse(jsonStr);
      if (kind === "toolplan") {
        // toolplan 必须有 read 数组
        return Array.isArray(obj?.read);
      }
      if (kind === "toolcall") {
        // toolcall 必须有 tool 字段
        return typeof obj?.tool === "string" && obj.tool.length > 0;
      }
      return false;
    } catch {
      return false;
    }
  }

  private extractKeyContentFromMainText(text: string): string {
    const raw = (text || "").trim();
    if (!raw) return "";

    // 关键原则：抓"最后出现"的块，避免 diff 已出现但仍被 toolplan/toolcall 覆盖。
    type Candidate = { kind: "toolcall" | "toolplan" | "diff"; idx: number; text: string };
    const candidates: Candidate[] = [];

    const lastFence = (tag: "toolcall" | "toolplan") => {
      const re = new RegExp("```" + tag + "\\s*[\\s\\S]*?```", "g");
      let m: RegExpExecArray | null = null;
      let last: Candidate | undefined;
      while ((m = re.exec(raw))) {
        last = { kind: tag, idx: m.index, text: (m[0] || "").trim() };
      }
      return last;
    };

    const tc = lastFence("toolcall");
    if (tc) candidates.push(tc);
    const tp = lastFence("toolplan");
    if (tp) candidates.push(tp);

    // 兼容：网页渲染的代码块经常不会带 ```，只会出现 "toolplan" + 一段 JSON
    // 1) 先找最后一个包含 "read": [...] 的 JSON 对象（toolplan 常见结构）
    const jsonRe = /\{[\s\S]*?"read"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/g;
    let jm: RegExpExecArray | null = null;
    let lastJson: string | undefined;
    let lastJsonIdx = -1;
    while ((jm = jsonRe.exec(raw))) {
      const candidate = (jm[0] || "").trim();
      // 粗过滤：避免误匹配页面里别的 JSON
      if (/"read"\s*:/.test(candidate)) {
        lastJson = candidate;
        lastJsonIdx = jm.index;
      }
    }
    if (lastJson) {
      // 规范化成 toolplan fence，便于侧边栏识别并出现"确认工具计划"按钮
      candidates.push({ kind: "toolplan", idx: lastJsonIdx, text: ["```toolplan", lastJson, "```"].join("\n") });
    }

    // 2) 若页面里出现 "toolplan" 标签：用“括号匹配”提取其后最近的 JSON 对象（不做长度截断）
    const tpIdx = raw.toLowerCase().lastIndexOf("toolplan");
    if (tpIdx !== -1) {
      const json = this.extractFirstJsonObjectFrom(raw, tpIdx);
      if (json && this.isValidToolJson("toolplan", json)) {
        candidates.push({ kind: "toolplan", idx: tpIdx, text: ["```toolplan", json.trim(), "```"].join("\n") });
      }
    }

    // 次优：diff --git（必须是"行首 diff --git "，避免误命中提示词里的"diff --git 开头"描述）
    const diffRe = /(^|\n)diff --git /g;
    let dm: RegExpExecArray | null = null;
    let lastDiffIdx = -1;
    while ((dm = diffRe.exec(raw))) {
      lastDiffIdx = dm.index + (dm[1] ? dm[1].length : 0);
    }
    if (lastDiffIdx !== -1) {
      const tail = raw.slice(lastDiffIdx);
      // 不对 diff 做长度截断：避免长 diff 被裁掉
      candidates.push({ kind: "diff", idx: lastDiffIdx, text: tail });
    }

    if (candidates.length) {
      candidates.sort((a, b) => a.idx - b.idx);
      return candidates[candidates.length - 1].text;
    }

    // 兜底：只取最后一小段，避免整页噪音
    // 不做长度截断：避免长回答/长 diff 被裁掉
    return raw;
  }

  private async waitForMainKeyContent(page: Page, debug?: DebugFn): Promise<string> {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < 90000) {
      const txt = await this.getFallbackCombinedText(page, debug);
      const key = this.extractKeyContentFromMainText(txt);
      if (key && key !== last) last = key;
      await this.safeWait(page, 1200);
      const txt2 = await this.getFallbackCombinedText(page, debug);
      const key2 = this.extractKeyContentFromMainText(txt2);
      if (key2 && key2 === last) return key2;
    }
    debug?.({ level: "error", msg: "fallback text timeout" });
    throw new Error("等待 DeepSeek 回复超时（90s）。你可以在浏览器窗口里确认是否已输出。");
  }

  private async waitForMainKeyContentStreaming(
    page: Page,
    onUpdate: (u: { text: string; done: boolean }) => void,
    signal?: AbortSignal,
    debug?: DebugFn
  ): Promise<string> {
    const start = Date.now();
    let last = "";
    let stableCount = 0;

    while (Date.now() - start < 90000) {
      if (signal?.aborted) throw new Error("已取消");
      const txt = await this.getFallbackCombinedText(page, debug);
      debug?.({ level: "info", msg: "full text snapshot", data: { chars: txt.length } });
      // 直接在全文里提取，extractKeyContentFromDelta 会自动过滤提示词片段
      const key = this.extractKeyContentFromDelta(txt, debug);
      
      // key 为空说明没有有效内容（可能是 UI 噪音），继续等待
      if (!key) {
        stableCount = 0;
        await this.safeWait(page, 800, signal);
        continue;
      }

      if (key !== last) {
        last = key;
        stableCount = 0;
        debug?.({
          level: "info",
          msg: "fallback key updated",
          data: {
            mainChars: txt.length,
            keyChars: last.length,
            keyHead: last.slice(0, 120)
          }
        });
        onUpdate({ text: last, done: false });
      } else {
        stableCount += 1;
      }

      if (last && stableCount >= 2) {
        debug?.({ level: "info", msg: "fallback key stabilized", data: { keyChars: last.length } });
        onUpdate({ text: last, done: true });
        return last;
      }

      await this.safeWait(page, 800, signal);
    }
    debug?.({ level: "error", msg: "fallback text timeout" });
    throw new Error("等待 DeepSeek 回复超时（90s）。你可以在浏览器窗口里确认是否已输出。");
  }

  private async getFallbackTextLocator(page: Page, debug?: DebugFn): Promise<{ locator: ReturnType<Page["locator"]>; name: string }> {
    // DeepSeek 页面通常是 React 挂载在 #root，未必有 <main>
    const candidates: Array<{ name: string; selector: string }> = [
      { name: "main", selector: "main" },
      { name: "#root", selector: "#root" },
      // 代码块有时会被渲染成 pre/code，但 diff 可能不在最后一个 pre 内
      { name: "pre code(last)", selector: "pre code" },
      { name: "pre(last)", selector: "pre" },
      { name: "body", selector: "body" }
    ];
    for (const c of candidates) {
      const all = page.locator(c.selector);
      const cnt = await all.count().catch(() => 0);
      if (cnt > 0) {
        const l = (c.name.includes("(last)") ? all.last() : all.first());
        debug?.({ level: "info", msg: "fallback locator selected", data: { locator: c.name, count: cnt } });
        return { locator: l, name: c.name };
      }
    }
    // 理论上不会发生
    const body = page.locator("body").first();
    debug?.({ level: "warn", msg: "fallback locator defaulted to body" });
    return { locator: body, name: "body" };
  }

  private async getFallbackCombinedText(page: Page, debug?: DebugFn): Promise<string> {
    // 关键点：diff/toolplan/toolcall 可能只出现在某个 pre/code 里，而 #root 里不一定包含。
    // 所以这里把多个来源拼起来，再做"最后出现块"的提取，避免漏抓。
    const parts: string[] = [];

    // 不对单段做长度截断：避免长 diff/toolplan 被裁掉导致“获取不全”

    const tryRead = async (name: string, locator: ReturnType<Page["locator"]>, useInnerText = false) => {
      const t0 = Date.now();
      const cnt = await locator.count().catch(() => 0);
      if (cnt <= 0) return;
      // 使用 innerText 可以获取更准确的可见文本，但在复杂页面上可能较慢
      // textContent 更快但可能包含不可见内容
      const raw = useInnerText
        ? ((await locator.innerText().catch(() => "")) ?? "")
        : ((await locator
            .evaluate((el) => {
              const anyEl = el as any;
              return (anyEl?.textContent ?? "") as string;
            })
            .catch(() => "")) ?? "");
      let txt = raw.trim();
      if (!txt) return;
      parts.push(`\n\n<<<${name}>>>\n` + txt);
      debug?.({ level: "info", msg: "fallback read part", data: { name, ms: Date.now() - t0, chars: txt.length } });
    };

    // DeepSeek 网页可能的消息容器选择器（按优先级排序）
    const messageContainerSelectors = [
      // DeepSeek 专用选择器（最高优先级）
      ".ds-message",
      "[class*='ds-message']",
      // 其他可能的选择器
      "[class*='message-content']",
      "[class*='chat-message']",
      "[class*='markdown-body']",
      "[class*='prose']",
      "[class*='ds-markdown']",
      "[class*='conversation']",
      "[class*='chat-list']",
      "[class*='message-list']"
    ];

    // 首先尝试从聊天消息容器获取（使用 innerText 获取准确的文本）
    for (const sel of messageContainerSelectors) {
      try {
        const locator = page.locator(sel).last();
        const cnt = await locator.count().catch(() => 0);
        if (cnt > 0) {
          await tryRead(`${sel}(last)`, locator, true);
          break; // 找到一个就够了
        }
      } catch {
        // 忽略无效选择器
      }
    }

    // 然后读取代码块（通常更小、更快）
    await tryRead("pre code(last)", page.locator("pre code").last(), true);
    await tryRead("pre(last)", page.locator("pre").last(), true);
    
    // 最后读取整个页面内容作为兜底
    await tryRead("#root", page.locator("#root").first(), false);

    const combined = parts.join("\n");
    debug?.({
      level: "info",
      msg: "fallback combined snapshot",
      data: { parts: parts.length, chars: combined.length }
    });
    return combined;
  }

  /**
   * 从 text 中，从 startIdx 起向后找到第一个 JSON 对象（用括号深度匹配，不做长度截断）。
   */
  private extractFirstJsonObjectFrom(text: string, startIdx: number): string {
    const s = String(text || "");
    let i = Math.max(0, startIdx | 0);
    while (i < s.length && s[i] !== "{") i++;
    if (i >= s.length) return "";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(i, j + 1);
      }
    }
    return "";
  }

  private async safeWait(page: Page, ms: number, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("已取消");
    try {
      await page.waitForTimeout(ms);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Target page, context or browser has been closed/i.test(msg)) {
        // 清理内部状态，避免后续继续对已关闭页面操作
        this.page = undefined;
        throw new Error("Playwright 页面/浏览器已关闭。请重新点击“Playwright 打开 DeepSeek（可登录）”。");
      }
      throw e;
    }
  }
}


