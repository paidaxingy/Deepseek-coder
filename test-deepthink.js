/* eslint-disable no-console */
const path = require("path");
const { chromium } = require("playwright");

// 用法：
//   node test-deepthink.js
// 可选环境变量：
//   PW_PROFILE=/abs/path/to/profile_dir
//   PW_HEADLESS=1
//   PW_DEEPTHINK=1   # 想要开启 deepthink（否则默认关闭）

async function main() {
  const headless = process.env.PW_HEADLESS === "1";
  const want = process.env.PW_DEEPTHINK === "1";
  const userDataDir =
    process.env.PW_PROFILE && process.env.PW_PROFILE.trim()
      ? process.env.PW_PROFILE.trim()
      : path.resolve(__dirname, ".playwright-profile");

  console.log("[test-deepthink] headless =", headless);
  console.log("[test-deepthink] want =", want);
  console.log("[test-deepthink] userDataDir =", userDataDir);

  const ctx = await chromium.launchPersistentContext(userDataDir, { headless });
  const page = await ctx.newPage();
  await page.goto("https://chat.deepseek.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);

  const detect = async () => {
    return await page.evaluate(() => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const textMatches = (t) => {
        const x = norm(t);
        return x === "DeepThink" || x === "深度思考" || x === "深度 思考" || /DeepThink/i.test(x) || /深度思考/.test(x);
      };
      const pickClickable = (el) => {
        const cand = el.closest(
          "button,[role='button'],[aria-pressed],[aria-checked],[class*='ds-toggle-button'],[class*='toggle'],[class*='Toggle'],label"
        );
        return cand || el;
      };
      const getState = (clickEl) => {
        const aria = clickEl.getAttribute("aria-pressed") || clickEl.getAttribute("aria-checked") || clickEl.getAttribute("data-state") || "";
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
        return "unknown";
      };
      const centerOf = (el) => {
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      };

      const labels = [];
      for (const el of Array.from(document.querySelectorAll("span._6dbc175"))) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || "");
        if (!t || t.length > 40) continue;
        if (textMatches(t)) labels.push(el);
      }
      if (!labels.length) {
        const all = Array.from(document.querySelectorAll("span,button,[role='button'],div,label")).filter(isVisible);
        for (const el of all) {
          const t = norm(el.innerText || el.textContent || "");
          if (!t || t.length > 40) continue;
          if (textMatches(t)) labels.push(el);
        }
      }
      const ranked = labels
        .map((lab) => {
          const clickEl = pickClickable(lab);
          const c = centerOf(clickEl);
          return {
            labelText: norm(lab.innerText || lab.textContent || ""),
            labTag: lab.tagName,
            labClass: String(lab.getAttribute("class") || "").slice(0, 120),
            clickTag: clickEl.tagName,
            clickClass: String(clickEl.getAttribute("class") || "").slice(0, 160),
            aria: clickEl.getAttribute("aria-pressed") || clickEl.getAttribute("aria-checked") || clickEl.getAttribute("data-state") || "",
            state: getState(clickEl),
            ...c,
          };
        })
        .sort((a, b) => (a.cy || 0) - (b.cy || 0));
      return { count: ranked.length, best: ranked[ranked.length - 1] || null, ranked: ranked.slice(-5) };
    });
  };

  const before = await detect();
  console.log("[detect] before:", JSON.stringify(before, null, 2));
  if (before.best && typeof before.best.cx === "number") {
    console.log("[click] at", before.best.cx, before.best.cy);
    await page.mouse.click(before.best.cx, before.best.cy, { delay: 20 });
    await page.waitForTimeout(300);
  } else {
    console.log("[click] no candidate found; maybe not logged in / UI changed");
  }
  const after = await detect();
  console.log("[detect] after:", JSON.stringify(after, null, 2));

  await page.screenshot({ path: path.resolve(__dirname, "deepthink-debug.png"), fullPage: true }).catch(() => {});
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

