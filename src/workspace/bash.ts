export type BashSafetyMode = "safe" | "relaxed" | "unsafe";
export type BashSafety = { ok: true } | { ok: false; reason: string };

export type BashRiskLevel = "low" | "high";
export type BashRisk = { level: BashRiskLevel; reasons: string[] };

// 支持 fenced code block + “被 UI 污染”的 bash 格式
export function extractBashBlock(text: string): string {
  const raw = text || "";
  // 1) fenced：可能一条回复里有多个 ```bash ...```，需要全部拼起来
  const fencedRe = /```(?:bash|sh|shell)\s*([\s\S]*?)```/gim;
  const fencedParts: string[] = [];
  let fm: RegExpExecArray | null = null;
  while ((fm = fencedRe.exec(raw))) {
    const part = cleanBashBlock(fm[1] || "");
    if (part) fencedParts.push(part);
  }
  if (fencedParts.length) return fencedParts.join("\n");

  // 兼容：消息里出现 “bash” 标记（可能前面还有自然语言说明）
  // 例如：
  // 好的，我来...
  //
  // bash
  // rm -f src/example.ts
  // 2) marker：同一条回复里可能出现多段 “bash\n...”，要逐段提取并拼接
  const lines = String(raw).replace(/\r\n/g, "\n").split("\n");
  const parts: string[] = [];
  let buf: string[] = [];
  let inBlock = false;
  const flush = () => {
    const cleaned = cleanBashBlock(buf.join("\n"));
    buf = [];
    if (cleaned) parts.push(cleaned);
  };
  for (const line of lines) {
    if (/^\s*bash\s*$/i.test(line)) {
      if (inBlock) flush();
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    buf.push(line);
  }
  if (inBlock) flush();
  if (parts.length) return parts.join("\n");

  return "";
}

export function cleanBashBlock(block: string): string {
  return (block || "")
    .replace(/^Copy\n/gm, "")
    .replace(/^Download\n/gm, "")
    .replace(/\nCopy$/gm, "")
    .replace(/\nDownload$/gm, "")
    .trim();
}

export function splitBashCommands(block: string): string[] {
  return (block || "")
    .split("\n")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith("#"));
}

export function assessBashRisk(block: string): BashRisk {
  const s = (block || "").trim();
  if (!s) return { level: "low", reasons: [] };

  const reasons: string[] = [];

  // 典型高风险模式（不拦截，仅用于提示用户确认）
  if (/(^|\s)sudo(\s|$)/.test(s)) reasons.push("包含 sudo");
  if (/(^|\n)\s*rm\s+.*-rf(\s|$)/.test(s) || /(^|\n)\s*rm\s+-rf(\s|$)/.test(s)) reasons.push("包含 rm -rf");
  if (/(^|\n)\s*dd(\s|$)/.test(s)) reasons.push("包含 dd");
  if (/(^|\n)\s*(mkfs|fdisk|parted)\b/.test(s)) reasons.push("包含磁盘/分区相关命令（mkfs/fdisk/parted）");
  if (/(^|\n)\s*(chmod|chown)\b/.test(s)) reasons.push("包含权限/属主修改（chmod/chown）");
  // 复合操作只对“危险的组合符号”提示：; / 管道 / 后台 &
  // 注意：&&/|| 很常见（例如 “cmd || true”），仅凭它们不应弹确认
  if (/;/.test(s)) reasons.push("包含复合操作（;）");
  // 单管道（|）才算高风险提示；逻辑或（||）不算
  if (/(^|[^|])\|([^|]|$)/.test(s)) reasons.push("包含管道（|）");
  // 后台运行（&）提示；逻辑与（&&）不算
  if (/(^|[^&])&([^&]|$)/.test(s)) reasons.push("包含后台运行（&）");
  if (/`/.test(s) || /\$\(/.test(s)) reasons.push("包含命令替换（` 或 $()）");
  if (/(^|\n)\s*(curl|wget)\b[\s\S]*\|\s*(sh|bash)\b/.test(s)) reasons.push("包含 curl/wget | sh/bash");
  if (/(^|\n)\s*(sh|bash)\s+-c\b/.test(s)) reasons.push("包含 sh/bash -c");

  // 写入系统敏感目录
  if (/(^|\s)>\s*\/(etc|usr|bin|sbin|root)\b/.test(s) || /(^|\s)>\s*\/(etc|usr|bin|sbin|root)\//.test(s)) {
    reasons.push("可能写入系统目录（/etc,/usr,/bin,/sbin,/root）");
  }

  return reasons.length > 0 ? { level: "high", reasons } : { level: "low", reasons: [] };
}

export function checkBashCommandSafety(cmd: string, mode: BashSafetyMode = "relaxed"): BashSafety {
  const s = (cmd || "").trim();
  if (!s) return { ok: false, reason: "命令为空" };

  if (mode === "unsafe") return { ok: true };

  // safe: 拦截更严格（包含重定向/HereDoc）
  // relaxed: 放开重定向/HereDoc（支持 cat > file << 'EOF'），但仍拦截管道/复合/命令替换
  if (mode === "safe") {
    if (/[;&|<>`]/.test(s) || /\$\(/.test(s) || /\|\|/.test(s) || /&&/.test(s)) {
      return { ok: false, reason: "包含危险 shell 语法（; && || | > < ` $()）" };
    }
  } else {
    // relaxed：允许 && / || / 重定向 / HereDoc，但仍拦截：
    // - 分号 ;（串联多条命令）
    // - 单管道 |（可能把输出喂给未知命令；注意 || 不算管道）
    // - 后台 &（注意 && 不算后台）
    // - 命令替换 ` / $()
    if (/;/.test(s)) return { ok: false, reason: "包含危险 shell 语法（;）" };
    if (/(^|[^|])\|([^|]|$)/.test(s)) return { ok: false, reason: "包含危险 shell 语法（|）" };
    if (/(^|[^&])&([^&]|$)/.test(s)) return { ok: false, reason: "包含危险 shell 语法（&）" };
    if (/`/.test(s) || /\$\(/.test(s)) return { ok: false, reason: "包含危险 shell 语法（` 或 $()）" };
  }

  // token 化（允许 sudo 前缀，但默认仍拦截 sudo 直接执行）
  const parts = s.split(/\s+/);
  const first = parts[0] || "";
  const second = parts[1] || "";

  if (first === "sudo") {
    return { ok: false, reason: "出于安全原因，自动执行默认禁用 sudo（请手动在终端执行）" };
  }

  const allowed = new Set(["rm", "mv", "cp", "mkdir", "touch", "cat", "ls", "pwd", "npm", "yarn", "git"]);
  const tool = first;
  if (!allowed.has(tool)) {
    return { ok: false, reason: `不在允许列表：${tool}` };
  }

  // 防止误删系统路径（只做最小兜底）
  if (tool === "rm" && /\s\/(\s|$)/.test(s)) {
    return { ok: false, reason: "检测到 rm 可能作用于根目录 /，已拦截" };
  }

  // npm/yarn/git 允许，但不允许带重定向/管道（已在上面统一拦截）
  void second;
  return { ok: true };
}

