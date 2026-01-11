"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const toolcall_1 = require("./toolcall");
function eq(name, actual, expected) {
    assert_1.default.deepStrictEqual(actual, expected, name);
}
const polluted = `toolcall
Copy
Download
{"tool":"listDir","args":{"dirPath":"src"}}`;
const j1 = (0, toolcall_1.extractToolCallJson)(polluted);
eq("extract polluted toolcall json", j1.startsWith("{") && j1.endsWith("}"), true);
const obj1 = (0, toolcall_1.normalizeToolCallObject)(JSON.parse(j1));
eq("normalize listDir dirPath->path", obj1.tool, "listDir");
eq("normalize listDir path", obj1.args.path, "src");
const fenced = "```toolcall\n{\"tool\":\"readFile\",\"args\":{\"filePath\":\"README.md\"}}\n```";
const j2 = (0, toolcall_1.extractToolCallJson)(fenced);
const obj2 = (0, toolcall_1.normalizeToolCallObject)(JSON.parse(j2));
eq("normalize readFile filePath->path", obj2.args.path, "README.md");
console.log("[toolcall.test] ok");
//# sourceMappingURL=toolcall.test.js.map