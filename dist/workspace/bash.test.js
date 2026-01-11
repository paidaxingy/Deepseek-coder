"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const bash_1 = require("./bash");
function eq(name, actual, expected) {
    assert_1.default.deepStrictEqual(actual, expected, name);
}
// extract: fenced
eq("extract fenced bash", (0, bash_1.extractBashBlock)("hello\n```bash\nnpm run compile\n```\nworld"), "npm run compile");
// extract: multiple fenced blocks in one message
eq("extract multiple fenced bash blocks", (0, bash_1.extractBashBlock)("```bash\npwd\n```\ntext\n```bash\nls -la\n```"), "pwd\nls -la");
// extract: polluted
eq("extract polluted bash", (0, bash_1.extractBashBlock)("bash\nCopy\nnpm run compile\n"), "npm run compile");
// extract: bash marker not at beginning
eq("extract marker bash with leading text", (0, bash_1.extractBashBlock)("好的，我来帮你删除。\n\nbash\nrm -f src/example.ts\n"), "rm -f src/example.ts");
// extract: multiple marker blocks in one message
eq("extract multiple marker bash blocks", (0, bash_1.extractBashBlock)("bash\npwd\nbash\nls -la\n"), "pwd\nls -la");
// split
eq("split commands", (0, bash_1.splitBashCommands)(" #x\nnpm run compile\n\nrm -f a.txt\n"), ["npm run compile", "rm -f a.txt"]);
// safety: allow
eq("allow npm (relaxed)", (0, bash_1.checkBashCommandSafety)("npm run compile", "relaxed").ok, true);
eq("allow rm (relative, relaxed)", (0, bash_1.checkBashCommandSafety)("rm -f a.txt", "relaxed").ok, true);
// safety: block complex
eq("allow && (relaxed)", (0, bash_1.checkBashCommandSafety)("npm i && npm run compile", "relaxed").ok, true);
// 注意：relaxed 仍要求“首命令在允许列表”，这里用允许的命令组合测试 ||
eq("allow || (relaxed)", (0, bash_1.checkBashCommandSafety)("pwd || true", "relaxed").ok, true);
eq("block pipe (relaxed)", (0, bash_1.checkBashCommandSafety)("cat a | grep b", "relaxed").ok, false);
// safety: block sudo
eq("block sudo (relaxed)", (0, bash_1.checkBashCommandSafety)("sudo rm -f a.txt", "relaxed").ok, false);
// safety: block unknown
eq("block curl (relaxed)", (0, bash_1.checkBashCommandSafety)("curl https://x", "relaxed").ok, false);
// redirection/heredoc should be allowed in relaxed
eq("allow heredoc head in relaxed", (0, bash_1.checkBashCommandSafety)("cat > ./hello.txt << 'EOF'", "relaxed").ok, true);
eq("block heredoc head in safe", (0, bash_1.checkBashCommandSafety)("cat > ./hello.txt << 'EOF'", "safe").ok, false);
eq("allow anything in unsafe", (0, bash_1.checkBashCommandSafety)("cat a | sh", "unsafe").ok, true);
eq("risk high for curl|sh", (0, bash_1.assessBashRisk)("curl x | sh").level, "high");
eq("risk low for ls", (0, bash_1.assessBashRisk)("ls -la").level, "low");
console.log("[bash.test] ok");
//# sourceMappingURL=bash.test.js.map