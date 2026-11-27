# Changelog

本文件记录 **会话管理 (`archive-manager`)** 的版本变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

All notable changes to **Session Manager (`archive-manager`)** are documented here. Each release is listed in Simplified Chinese first, followed by English.

## [Unreleased]

### 文档 / Docs

- 重写中英文 README：居中 Hero、徽章墙、亮 / 暗双主题主图、功能速查表与 FAQ；更新日志迁移至本文件。
- 新增 `tools/render-hero.mjs`，基于真实面板源码与虚构演示数据渲染亮 / 暗主图。
- Rewrote both READMEs with a centered hero, badges, light/dark hero screenshots, a feature cheat sheet, and an FAQ. Release notes moved to this file.
- Added `tools/render-hero.mjs`, which renders the light/dark hero images from the real panel source with fictional demo data.

## 2.3.0 - 2026-11-27

- 会话分页以 50 个会话为一页。预览及 Markdown 导出按 ID 读取。增加多关键词检索、稳定项目标识和原生分组筛选。
- 面板显示旧本地标签与原生标签的差异，更新后核对宿主结果。在归档箱批量永久删除时逐条复查归档及运行状态，并展示各项结果。
- Page through 50 conversations at a time, preview or export a single chat by ID, search across messages with keywords, and filter by project identity or native group.
- Reconcile legacy local tags with verified host tags. Review selected archived chats before permanent deletion and inspect each outcome afterward.

## [2.2.0] - 2026-11-27

### 新增 / Added

- 面板顶部可切换 **简体中文 / English**。首次打开时根据面板浏览器的语言选择，手动切换后由插件记住所选语言。
- 面板操作、确认与失败提示、Markdown 导出的固定字段随所选语言显示；左栏快捷入口同步按当前语言精简展示，消息时间戳按本地时区显示。会话正文、标题、标签和备注保留原文。
- Use the **简体中文 / English** menu at the top of the panel to change languages. The browser language decides the initial language, and the plugin remembers your choice.
- The selected language applies to panel controls, confirmations, errors, concise left-sidebar labels, and labels in Markdown exports. Timestamps follow your local timezone. Conversation text, titles, tags, and notes stay in their original language.

### 变更 / Changed

- 通用适配主流 Antigravity 宿主主题与美化插件：主色、表面层次、字体与深色代码块 / Toast 优先跟随宿主语义变量，并加固自定义浮岛布局下的左侧栏唤起稳定性。
- Universal host theme and UI pack compatibility: accent, surfaces, fonts, and dark-safe code blocks and toasts follow host semantic variables. Left-sidebar entry matching is hardened for custom layouts.

## [2.1.1] - 2026-11-26

### 修复 / Fixed

- 修复快速切换会话或筛选条件时，较晚返回的旧请求覆盖当前预览或列表的问题。
- 无法确认会话已停止时，阻止永久删除。标签和备注采用原子保存，读取异常时保留原文件。
- 仅在发现可用的调试页面后读取左栏归档计数。归档状态变更后刷新角标。
- When conversations or filters change quickly, older responses no longer overwrite the current preview or list.
- Permanent deletion requires an explicit idle state. Tags and notes are saved atomically, and unreadable metadata files are preserved.
- The optional sidebar only reads the archive count after finding a usable debugging page. Archive changes refresh the badge.

### 变更 / Changed

- 批量归档与恢复支持撤回已成功变更的会话。部分操作失败时，面板会显示处理结果。
- 批量归档闲置会话时，后端按当前会话状态重新判断资格，跳过已归档、已收藏、已置顶、正在运行或尚未达到闲置天数的会话。
- Markdown 导出记录内容来源，并在适用时标注警告。每次导出生成独立文件。
- Undo is available for successful changes in a batch. The panel reports partial failures.
- Before archiving stale conversations in bulk, the backend rechecks their current state and skips conversations that are archived, starred, pinned, running, or below the selected inactivity threshold.
- Markdown exports record the content source and include warnings where appropriate. Each export creates a separate file.

### 测试 / Tests

- 新增本地回归测试套件（`node --test`），使用模拟的 Antigravity 服务与临时会话数据。
- Added a local regression test suite (`node --test`) with mock Antigravity services and temporary conversation data.

## [2.1.0] - 2026-11-26

### 新增 / Added

- 首个公开版本：五大视图浏览、全文检索、免恢复预览、原地归档与恢复、置顶 / 星标 / 重命名 / 删除、标签与备注、Markdown 导出，以及可选的左侧栏快捷入口。
- First public release: five-tab browsing, full-text search, preview without restoring, in-place archive and restore, pin / star / rename / delete, tags and notes, Markdown export, and an optional left-sidebar quick entry.

[Unreleased]: https://github.com/YukiKaguraA/agy-archive-manager/compare/35361be...HEAD
[2.2.0]: https://github.com/YukiKaguraA/agy-archive-manager/commit/35361be
[2.1.1]: https://github.com/YukiKaguraA/agy-archive-manager/commit/552f8cc
[2.1.0]: https://github.com/YukiKaguraA/agy-archive-manager/commit/a31e68d
