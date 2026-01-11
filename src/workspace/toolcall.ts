export type ToolName = "listDir" | "readFile" | "searchText";

function stripUiPollution(s: string): string {
  return (s || "")
    .replace(/^Copy\n/gm, "")
    .replace(/^Download\n/gm, "")
    .replace(/\nCopy$/gm, "")
    .replace(/\nDownload$/gm, "")
    .trim();
}

function extractFirstJsonObjectFrom(text: string, startIdx: number): string {
  const s = text || "";
  let i = Math.max(0, startIdx | 0);
  while (i < s.length && s[i] !== "{") i++;
  if (i >= s.length) return "";

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === "\"") {
        inStr = false;
      }
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

export function extractToolCallJson(text: string): string {
  const raw = stripUiPollution(text || "");

  const fenced = /```toolcall\s*([\s\S]*?)```/m.exec(raw);
  if (fenced) return stripUiPollution(fenced[1] || "");

  const idx = raw.search(/(^|\n)toolcall\b/);
  if (idx !== -1) {
    const json = extractFirstJsonObjectFrom(raw, idx);
    if (json) return json.trim();
  }

  // 兜底：整段里找第一个像 toolcall 的 JSON
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const json = extractFirstJsonObjectFrom(raw, i);
    if (!json) continue;
    if (/"tool"\s*:/.test(json) && /"args"\s*:/.test(json)) return json.trim();
    i += Math.max(0, json.length - 1);
  }

  return "";
}

export function normalizeToolCallObject(obj: unknown): { tool: ToolName; args: any } {
  const o = obj as any;
  const tool = String(o?.tool || "");
  const args = (o?.args ?? {}) as any;

  if (tool !== "listDir" && tool !== "readFile" && tool !== "searchText") {
    throw new Error(`不支持的 tool：${tool || "(empty)"}`);
  }

  if (tool === "listDir") {
    const path = (args.path ?? args.dirPath ?? args.dir ?? args.directory ?? "") as string;
    const maxEntries = args.maxEntries ?? args.max ?? args.limit;
    return { tool, args: { path, maxEntries } };
  }
  if (tool === "readFile") {
    const path = (args.path ?? args.filePath ?? args.filename ?? "") as string;
    return { tool, args: { path } };
  }
  // searchText
  const query = (args.query ?? args.q ?? args.text ?? args.keyword ?? "") as string;
  const glob = args.glob ?? args.include;
  const maxResults = args.maxResults ?? args.max ?? args.limit;
  return { tool, args: { query, glob, maxResults } };
}

