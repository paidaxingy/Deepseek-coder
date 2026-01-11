import assert from "assert";
import { extractToolCallJson, normalizeToolCallObject } from "./toolcall";

function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, name);
}

const polluted = `toolcall
Copy
Download
{"tool":"listDir","args":{"dirPath":"src"}}`;

const j1 = extractToolCallJson(polluted);
eq("extract polluted toolcall json", j1.startsWith("{") && j1.endsWith("}"), true);

const obj1 = normalizeToolCallObject(JSON.parse(j1));
eq("normalize listDir dirPath->path", obj1.tool, "listDir");
eq("normalize listDir path", obj1.args.path, "src");

const fenced = "```toolcall\n{\"tool\":\"readFile\",\"args\":{\"filePath\":\"README.md\"}}\n```";
const j2 = extractToolCallJson(fenced);
const obj2 = normalizeToolCallObject(JSON.parse(j2));
eq("normalize readFile filePath->path", obj2.args.path, "README.md");

console.log("[toolcall.test] ok");

