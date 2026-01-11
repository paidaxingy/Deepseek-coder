## Deepseek Coder（免 API）

**Deepseek Coder** 是一个 VS Code 扩展：不走模型 API，而是通过 **Playwright 驱动 DeepSeek 网页版**，并在本地提供“读文件 / 应用 diff / 执行 bash”等工具能力，用来做代码协作与自动改动。

## 功能（以当前版本为准）

- **侧边栏 Chat UI**：在 VS Code 里直接聊天（扩展会用 Playwright 把提示发送到 DeepSeek 网页端，并流式回传）。
- **DeepThink 开关**：发送前可选开启/关闭（默认关闭）。
- **只读模式**：开启后不自动应用 diff / 不自动执行 bash（仍可手动点确认执行 bash）。
- **Bash 需要确认**：当助手输出 bash，会显示“确认并执行”按钮，避免误跑。
- **Diff 高亮**：diff 中 `-`/`+` 行在 UI 里高亮显示。
- **回滚**：可回滚上一次由 AI 修改/创建的文件改动。
- **命令**：
  - `Deepseek Coder: 从剪贴板应用补丁（预览确认）`
  - `Deepseek Coder: 将当前选区加入上下文`
  - `Deepseek Coder: 回滚上一次改动`

## 安装

- 推荐：直接安装发布的 `.vsix`
  - VS Code：命令面板 → `Extensions: Install from VSIX...`

## 使用（推荐流程）

1. 打开 Activity Bar 的 **Deepseek Coder** 视图
2. 需要登录时，点击菜单里的 **“Playwright 打开 DeepSeek（可登录）”**，在弹出的浏览器里完成登录
3. 在聊天框输入需求并发送
4. 如果助手输出 diff/b​ash：
   - diff：在“只读模式关闭”时可自动应用；你也可以用“从剪贴板应用补丁（预览确认）”
   - bash：必须点“确认并执行”
5. 如果改坏了：点击 **回滚上一次改动**

## 运行环境与注意事项

- **需要你能访问 DeepSeek 网页版**（账号登录由你在浏览器里完成）。
- **首次需要安装 Chromium**：运行命令  
  `Deepseek Coder: 安装 Playwright Chromium（首次使用）`（需要联网下载）。
- **WSL/Linux 系统库依赖**：如果提示缺少系统库（例如 `libnspr4`、`libnss3`），请按发行版安装对应依赖。
- 本扩展会在本机保存少量状态（比如只读模式开关、回滚历史）；不会把你的工作区文件上传到任何第三方服务（除非你主动把内容发给网页端）。


