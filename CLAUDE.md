# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Deepseek Coder is a VSCode extension that provides AI-assisted coding without using model APIs. It uses Playwright to automate the DeepSeek web interface (chat.deepseek.com) and provides local workspace tools (read files, apply diffs, execute bash commands).

## Build & Development Commands

```bash
# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Run linter
npm run lint

# Run tests (compiles first, then runs bash.test.js and toolcall.test.js)
npm run test

# Install Playwright Chromium browser
npm run playwright:install

# Install system dependencies for Playwright (Linux/WSL)
npm run playwright:install-deps

# Package as .vsix for distribution
npm run package
```

## Architecture

```
src/
├── extension.ts                 # VSCode extension entry point, command registration
├── deepseek/
│   └── DeepSeekPlaywright.ts   # Playwright automation for DeepSeek web interface
├── views/
│   └── DeepSeekViewProvider.ts # Webview sidebar UI provider
├── state/
│   └── threadStore.ts          # In-memory chat history & context management
└── workspace/
    ├── tools.ts                # Tool definitions (listDir, readFile, searchText)
    ├── toolcall.ts             # Tool call JSON parsing & normalization
    ├── bash.ts                 # Bash command extraction & safety validation
    ├── readFile.ts             # File reading utilities
    ├── applyPatch.ts           # Unified diff application
    ├── rollback.ts             # Undo last AI-applied changes
    └── workspaceRoot.ts        # Workspace root detection
```

**Key data flow:**
1. User input in sidebar chat → `DeepSeekViewProvider`
2. Playwright sends to DeepSeek web interface
3. Response parsed for toolplan/toolcall/diff/bash blocks
4. Workspace tools execute locally
5. Results displayed in sidebar

## Key Components

**DeepSeekPlaywright.ts**: Browser automation with persistent login profile, message streaming, response parsing (extracts toolplan, toolcall, diff, bash blocks from AI responses), DeepThink toggle control.

**DeepSeekViewProvider.ts**: Webview UI handling user interactions, context snippets, streaming display, tool execution confirmations.

**Workspace tools**: Path-validated file operations with traversal attack prevention. Bash execution has three safety modes (safe/relaxed/unsafe) with risk detection for dangerous commands.

## VSCode Settings

- `deepseekCoder.autoOpenPlaywright` - Auto-open browser on sidebar activation
- `deepseekCoder.defaultDeepThink` - Enable DeepThink by default
- `deepseekCoder.bashSafetyMode` - Bash execution safety level (safe/relaxed/unsafe)

## Testing

Tests are plain Node.js scripts in `src/workspace/`:
- `bash.test.ts` - Tests bash safety validation
- `toolcall.test.ts` - Tests tool call JSON parsing

Run individual test after compile:
```bash
node dist/workspace/bash.test.js
node dist/workspace/toolcall.test.js
```
