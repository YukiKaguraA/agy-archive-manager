<div align="center">

<img src="logo.svg" width="96" height="96" alt="会话管理 Logo" />

# 会话管理 · Session Manager

**为 Google Antigravity 打造的会话归档 / 检索 / 预览 / 导出面板**

五大视图 · 全文检索 · 免恢复预览 · 批量归档（可撤回） · 标签与备注 · Markdown 导出 · 四种界面语言

[**简体中文**](./README.md) · [**English**](./README.en.md) · [**繁體中文**](./README.zh-TW.md) · [**日本語**](./README.ja.md) · [**更新日志**](./CHANGELOG.md) · [**版本发布**](https://github.com/YukiKaguraA/agy-archive-manager/releases) · [**问题反馈**](https://github.com/YukiKaguraA/agy-archive-manager/issues)

<p>
  <a href="https://github.com/YukiKaguraA/agy-archive-manager/releases"><img src="https://img.shields.io/github/v/release/YukiKaguraA/agy-archive-manager?style=flat-square&color=3186ff&label=Release" alt="Latest Release" /></a>
  <img src="https://img.shields.io/badge/Antigravity-%E2%89%A5%202.35.0-0f172a?style=flat-square" alt="Antigravity 2.35.0+" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-1e293b?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Node.js-22.13%2B%20%7C%2024%20LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.13+ or 24 LTS" />
  <img src="https://img.shields.io/badge/i18n-4_languages-8b5cf6?style=flat-square" alt="简体中文 | English | 繁體中文 | 日本語" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-2563eb?style=flat-square" alt="License: MIT" /></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/hero-light.png" />
  <img src="docs/screenshots/hero-light.png" width="100%" alt="会话管理面板预览" />
</picture>

<sub>主图由 <code>tools/render-hero.mjs</code> 直接渲染本仓库面板源码，亮 / 暗版本跟随 GitHub 主题切换；会话内容均为虚构示例。</sub>

</div>

> **非官方社区项目声明 (Non-Affiliation Disclaimer)**
>
> 本项目为独立的开源社区插件，与 Google LLC 无任何隶属、赞助或官方背书关系；文中提及的 “Antigravity” 与 “Google” 仅用于说明兼容性。

---

## ✨ 亮点

- **工作区列表**：会话库包含活跃、已归档、收藏、全部、闲置、回收站。默认进入活跃视图并展开最近更新的工作区。每个工作区每次加载最多 50 条。
- **组合搜索框**：输入文字后可从右侧切换原文片段或多关键词。支持按原生分组和标签筛选，命中处高亮。
- **会话统计**：卡片显示用户轮次、步数，以及会话文件数和占用大小。
- **回收站**：删除时先归档，支持恢复到原先的归档状态。默认保留七天，可在设置调整为 1–365 天。缩短期限会提示到期数量，清理由例行检查或手动确认触发。
- **不恢复也能看**：直接预览历史对话，超长消息自动折叠，排版视图和原文视图一键切换。
- **归档后悔了？撤回**：支持批量归档 / 恢复、按闲置天数一键归档，操作都能撤回。
- **整理顺手**：置顶 📌、星标 ★、`#标签`、自动保存的备注、原地重命名。
- **一键导出 Markdown**：连同会话信息、标签和备注一起导出到 `~/Documents/Antigravity-Exports`。
- **四种界面语言**：可切换简体中文、English、繁體中文或日本語。面板会记住所选语言，配色跟随宿主主题。
- **安全兜底**：运行中的会话禁止删除，SQLite 只读打开，本地备注原子保存。

---

## 🖼️ 界面预览

### 1. 工作区列表与会话预览

活跃视图下，琥珀色「归档」按钮随手可点；单条超过 450px 的消息自动折叠，附带渐隐遮罩和「展开全文 / 收起」。

<p align="center">
  <img src="docs/screenshots/preview-main.png" width="100%" alt="活跃会话按工作区折叠列表，会话卡片显示统计" />
</p>

### 2. 已归档视图与全文检索高亮

在已归档视图中检索，命中词高亮显示；Markdown 预览可展开阅读，绿色「恢复」一键放回活跃视图。

<p align="center">
  <img src="docs/screenshots/preview-archived.png" width="100%" alt="已归档视图、全文检索高亮与 Markdown 预览" />
</p>

### 3. 功能速查表

| 场景 | 操作 | 入口 |
| :--- | :--- | :--- |
| 找旧会话 | 原文片段 / 多关键词检索，配合工作区折叠、分组 / 标签筛选与排序 | 面板顶部 |
| 归档 / 恢复 | 琥珀色「归档」/ 绿色「恢复」，可撤回 | 会话卡片、预览工具栏 |
| 批量处理 | 多选后归档或恢复，在已归档视图可将所选会话移入回收站 | 「批量」按钮 |
| 恢复或彻底删除 | 在回收站选择单条或多条会话，彻底删除需确认 | 回收站 |
| 清理闲置 | 按 3 / 7 / 14 / 30 天批量归档闲置会话 | 闲置视图 |
| 阅读长会话 | 展开全部 / 全部折叠、⬆ 顶部、⬇ 底部、排版 / 原文 | 预览工具栏 |
| 整理 | 置顶、星标、重命名、`#标签`、备注 | 卡片与预览区 |
| 导出 | 导出 `.md`，可定位文件或打开导出目录 | 预览工具栏、设置 |
| 打开面板 | 左侧栏入口（需 CDP）/ 右侧插件菜单 / 对话指令 | 多处 |

---

工作区优先按宿主项目栏顺序排列，未归属固定在末尾。预览中可按 `F3` 和 `Shift+F3` 循环跳转并展开命中的折叠消息，也可打开原始日志目录。

## 🚀 快速安装

### 方式一：安装脚本（推荐 · 普通用户）

**Windows (PowerShell)：**

```powershell
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager
.\scripts\install.ps1
```

**macOS / Linux：**

```bash
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager
chmod +x scripts/install.sh
./scripts/install.sh
```

再次运行同一脚本即可更新到仓库中的最新版本。

### 方式二：手动复制（开发者 / 离线环境）

将以下文件复制到 `~/.gemini/config/plugins/archive-manager/`（Windows 为 `%USERPROFILE%\.gemini\config\plugins\archive-manager\`）：

- `plugin.json`、`logo.svg`、`LICENSE`
- `README.md`、`README.en.md`、`README.zh-TW.md`、`README.ja.md`、`CHANGELOG.md`
- `docs/screenshots/`（文档预览图）
- `skills/`、`sidecars/`

安装完成后，在 Antigravity 的 **Customizations → Plugins** 中启用 **会话管理 (Session Manager)**，即可在右侧辅助面板打开，或在对话中说「打开会话管理面板」。

### 让 AI 助手代装

使用 Antigravity Agent、Claude Code、Cursor 等 AI 助手安装时，可直接让它执行以下步骤：

```bash
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager

# 1. 运行对应系统的安装脚本（Windows 用 .\scripts\install.ps1）
./scripts/install.sh

# 2. 确认 Sidecar 运行时支持 node:sqlite（应输出 function）
node -e "import('node:sqlite').then(m => console.log(typeof m.DatabaseSync))"
```

然后提醒用户在 **Customizations → Plugins** 中启用插件。

---

## 🆕 v2.3.1

- 「活跃」成为首个视图，打开面板时默认显示全部未归档会话。
- 新增繁體中文和日本語。界面、操作提示及 Markdown 导出的固定字段随所选语言切换。
- GitHub README 新增繁體中文版和日文版。

[查看完整更新日志](./CHANGELOG.md)

---

## ❓ 常见问题

<details>
<summary><strong>左侧栏没有出现「会话管理」入口？</strong></summary>

左侧栏入口和归档角标依赖 Chrome DevTools Protocol（CDP），需要用 `--remote-debugging-port=0` 启动 Antigravity。不开启也没关系，右侧插件菜单和对话指令都能打开面板。

</details>

<details>
<summary><strong>面板打不开，或者提示 <code>node:sqlite</code> 相关错误？</strong></summary>

Sidecar 通过 `node` 命令启动，要求 Antigravity 实际使用的 Node.js 默认启用 `node:sqlite`，例如 Node.js 22.13+（22.x LTS）或 Node.js 24 LTS。可以用上面「让 AI 助手代装」中的命令自检。

</details>

<details>
<summary><strong>预览只显示了一部分消息？</strong></summary>

预览优先读取 `transcript_full.jsonl`，可用时结合 `transcript.jsonl`；两者都缺失时回退到 FTS 摘要。较早的会话如果没有留下完整转录，就只能看到部分消息或摘要，面板会给出提示。

</details>

<details>
<summary><strong>Antigravity 更新后功能异常？</strong></summary>

归档等操作通过 Antigravity 内部的 `ConversationService` 完成，检索与预览读取内部数据文件，宿主更新可能改变这些接口。请附上 Antigravity 版本号到 [Issues](https://github.com/YukiKaguraA/agy-archive-manager/issues) 反馈。

</details>

<details>
<summary><strong>导出的 Markdown 文件在哪里？标签和备注存在哪里？</strong></summary>

导出文件默认保存在 `~/Documents/Antigravity-Exports`，可在设置选取或输入绝对路径，每次导出生成独立文件，面板里可以一键定位。面板通过宿主服务更新原生标签，并读回核对。备注与旧版本留下的本地标签记录保存在 Sidecar 数据目录。Antigravity 2.35.2 可能忽略清空最后一个标签的请求，面板会读回核对，未生效时提示并保留本地记录。

</details>

---

<details>
<summary><strong>🔧 运行要求与数据来源（点击展开）</strong></summary>

- **Google Antigravity**：设计目标为 Antigravity 2.35.0。面板和进程生命周期使用公开的 Sidecar 机制，参见 [Antigravity Sidecar 文档](https://antigravity.google/docs/sidecars/)。
- **会话数据**：归档等操作通过内部 `ConversationService` 提交；搜索和预览读取内部 SQLite 摘要索引和转录文件，其中 SQLite 以只读方式打开。Antigravity 更新可能改变这些接口和数据格式。
- **Node.js**：Sidecar 启动命令是 `node`，要求 Antigravity 实际启动的 Node.js 默认启用 `node:sqlite`，例如 Node.js 22.13+（22.x LTS 分支）或 Node.js 24 LTS。详见 [Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)。
- **左侧栏快捷入口（可选）**：入口和归档角标依赖 Antigravity 的界面结构和 CDP，使用时以 `--remote-debugging-port=0` 启动 Antigravity。

</details>

<details>
<summary><strong>📁 目录结构、回归测试与主图渲染（点击展开）</strong></summary>

#### 目录结构

```text
agy-archive-manager/
├── plugin.json                         # 插件清单与元信息
├── agy-market.json                     # AGY Market 市场伴随配置
├── logo.svg                            # 插件图标
├── README*.md                          # 四语说明文档
├── CHANGELOG.md                        # 更新日志
├── LICENSE                             # MIT 开源协议
├── docs/
│   ├── benchmark-v2.3.0.md             # v2.3.0 历史库基准测试报告
│   └── screenshots/                    # 主图与界面预览截图
├── scripts/
│   ├── install.ps1                     # Windows 一键安装 / 更新脚本
│   └── install.sh                      # macOS / Linux 一键安装 / 更新脚本
├── skills/
│   └── archive-manager/
│       └── SKILL.md                    # 对话唤醒技能定义
├── sidecars/
│   └── archive_manager/
│       ├── sidecar.json                # Sidecar 进程与面板入口配置
│       ├── server.mjs                  # 本地 HTTP + ConversationService 后端
│       ├── server-locale.mjs           # 后端提示与 Markdown 导出文案
│       ├── search.mjs                  # 检索调度与取消控制
│       ├── search-worker.mjs           # FTS5 / 流式正文检索工作线程
│       ├── sidebar_injector.mjs        # 左侧栏快捷入口注入器（可选 CDP）
│       └── index.html                  # 前端双栏管理面板
├── tools/
│   ├── benchmark-history.mjs           # 万条历史库性能基准脚本
│   └── render-hero.mjs                 # README 亮 / 暗主图渲染脚本
└── test/                               # 本地回归测试套件
```

#### 本地回归测试

测试使用 Node.js 22.15+（22.x LTS 分支）或 Node.js 24 LTS，在仓库根目录运行：

```sh
node --test
```

测试仅使用模拟的 Antigravity 服务和临时会话数据。

#### 重新渲染主图

面板 UI 改动后，可用本机的 Chrome 或 Edge 重新生成 `docs/screenshots/hero-{light,dark}.png`：

```sh
node tools/render-hero.mjs
# 找不到浏览器时手动指定：
node tools/render-hero.mjs --browser "/path/to/chrome"
```

</details>

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。欢迎通过 [Issues](https://github.com/YukiKaguraA/agy-archive-manager/issues) 和 [Pull Requests](https://github.com/YukiKaguraA/agy-archive-manager/pulls) 一起打磨。
