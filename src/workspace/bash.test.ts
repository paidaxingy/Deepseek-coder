import assert from "assert";
import { assessBashRisk, checkBashCommandSafety, extractBashBlock, splitBashCommands } from "./bash";

function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, name);
}

// extract: fenced
eq(
  "extract fenced bash",
  extractBashBlock("hello\n```bash\nnpm run compile\n```\nworld"),
  "npm run compile"
);

// extract: multiple fenced blocks in one message
eq(
  "extract multiple fenced bash blocks",
  extractBashBlock("```bash\npwd\n```\ntext\n```bash\nls -la\n```"),
  "pwd\nls -la"
);

// extract: polluted
eq("extract polluted bash", extractBashBlock("bash\nCopy\nnpm run compile\n"), "npm run compile");

// extract: bash marker not at beginning
eq(
  "extract marker bash with leading text",
  extractBashBlock("好的，我来帮你删除。\n\nbash\nrm -f src/example.ts\n"),
  "rm -f src/example.ts"
);

// extract: multiple marker blocks in one message
eq(
  "extract multiple marker bash blocks",
  extractBashBlock("bash\npwd\nbash\nls -la\n"),
  "pwd\nls -la"
);

// split
eq("split commands", splitBashCommands(" #x\nnpm run compile\n\nrm -f a.txt\n"), ["npm run compile", "rm -f a.txt"]);

// safety: allow
eq("allow npm (relaxed)", checkBashCommandSafety("npm run compile", "relaxed").ok, true);
eq("allow rm (relative, relaxed)", checkBashCommandSafety("rm -f a.txt", "relaxed").ok, true);

// safety: block complex
eq("allow && (relaxed)", checkBashCommandSafety("npm i && npm run compile", "relaxed").ok, true);
// 注意：relaxed 仍要求“首命令在允许列表”，这里用允许的命令组合测试 ||
eq("allow || (relaxed)", checkBashCommandSafety("pwd || true", "relaxed").ok, true);
eq("block pipe (relaxed)", checkBashCommandSafety("cat a | grep b", "relaxed").ok, false);

// safety: block sudo
eq("block sudo (relaxed)", checkBashCommandSafety("sudo rm -f a.txt", "relaxed").ok, false);

// safety: block unknown
eq("block curl (relaxed)", checkBashCommandSafety("curl https://x", "relaxed").ok, false);

// redirection/heredoc should be allowed in relaxed
eq(
  "allow heredoc head in relaxed",
  checkBashCommandSafety("cat > ./hello.txt << 'EOF'", "relaxed").ok,
  true
);
eq(
  "block heredoc head in safe",
  checkBashCommandSafety("cat > ./hello.txt << 'EOF'", "safe").ok,
  false
);
eq(
  "allow anything in unsafe",
  checkBashCommandSafety("cat a | sh", "unsafe").ok,
  true
);

eq("risk high for curl|sh", assessBashRisk("curl x | sh").level, "high");
eq("risk low for ls", assessBashRisk("ls -la").level, "low");

console.log("[bash.test] ok");

