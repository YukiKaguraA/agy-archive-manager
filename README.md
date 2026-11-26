# 会话管理 (`archive-manager`)

专为 **Google Antigravity (v2.35.0+)** 打造的零侵入全能会话管理插件（Sidecar + Skill）。基于官方 `ConversationService` Connect API 与只读 SQLite 摘要索引构建，**不修改 `app.asar`、不直接写入官方内部数据库**，客户端升级后依然安全稳定。

## 核心功能

- **多视图分类浏览**：一键切换「已归档」「未归档」「收藏」「闲置」「全部」五大视图并实时统计数量。
- **全文检索与多维筛选**：支持同时检索标题、项目名、历史消息正文（FTS 摘要索引）、自定义标签与个人备注；支持按项目、标签筛选及按最近更新 / 步数 / 标题排序。
- **无感归档与恢复（含撤回）**：绿色「恢复」与琥珀淡黄「归档」按钮直观区分，调用官方原生接口原地切换状态不跳窗，操作后提供 Toast「撤回」保护；支持多选批量归档/恢复，以及按闲置天数（3 / 7 / 14 / 30 天）一键清理。
- **完整对话免恢复预览**：
  - 优先读取 `transcript_full.jsonl`（缺失时自动回退至 `transcript.jsonl` 与 FTS 索引），避免长回复被紧凑日志截断；
  - 支持独立滚动、单条超长消息（> 450px）自动折叠并附带渐隐遮罩与「展开全文 / 收起」；
  - 预览工具栏提供「展开全部 / 全部折叠」「⬆ 顶部」「⬇ 底部」及「排版 / 原文」切换，长会话阅读跳转更顺手。
- **原生信息维护与安全删除**：支持原地重命名、卡片快捷置顶（📌）与星标收藏（★）、自定义标签（`#tag`）与自动保存个人备注（独立持久化于 Sidecar 数据目录），删除运行中会话前自动拦截并弹出二次确认。
- **一键导出 Markdown**：将完整对话（含元信息、标签、备注与全部轮次）一键导出为 `.md` 文件至 `~/Documents/Antigravity-Exports`，支持一键定位文件或打开导出目录。
- **左侧导航栏快捷入口（可选）**：当 Antigravity 以 `--remote-debugging-port=0` 启动时，自动在左侧栏挂载原生风格的「会话管理」入口与实时已归档徽标；未开启调试端口时，面板本身仍可通过右侧面板插件菜单或对话技能正常打开。

## 安装方法

### 方式一：使用安装脚本（推荐）

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

### 方式二：手动安装

将本仓库中的以下核心文件复制到 Antigravity 插件目录 `~/.gemini/config/plugins/archive-manager/`（Windows 为 `%USERPROFILE%\.gemini\config\plugins\archive-manager\`）：

- `plugin.json`
- `logo.svg`
- `README.md`
- `LICENSE`
- `skills/`
- `sidecars/`

安装完成后，在 Antigravity 的 **Customizations → Plugins** 中启用 **会话管理 (Session Manager)**，即可在右侧辅助面板或通过对话指令「打开会话管理面板」唤醒。

## 目录结构

```text
agy-archive-manager/
├── plugin.json                         # 插件清单与元信息
├── logo.svg                            # 插件图标
├── README.md                           # 说明文档
├── LICENSE                             # MIT 开源协议
├── scripts/
│   ├── install.ps1                     # Windows 一键安装 / 更新脚本
│   └── install.sh                      # macOS / Linux 一键安装 / 更新脚本
├── skills/
│   └── archive-manager/
│       └── SKILL.md                    # 对话唤醒技能定义
└── sidecars/
    └── archive_manager/
        ├── sidecar.json                # Sidecar 进程与面板入口配置
        ├── server.mjs                  # 本地 HTTP + ConversationService 后端
        ├── sidebar_injector.mjs        # 左侧栏快捷入口注入器（可选 CDP）
        └── index.html                  # 前端双栏管理面板
```

## 运行要求

- **Google Antigravity** `>= v2.35.0`（提供官方 `ConversationService` Connect API 与 `sidecar_sdk` 运行环境）
- 若需左侧栏自动挂载「会话管理」快捷入口与归档角标，请确保 Antigravity 启动时带有 `--remote-debugging-port=0`。

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
