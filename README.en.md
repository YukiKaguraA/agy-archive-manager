# Session Manager (`archive-manager`)

A zero-invasion session & archive manager plugin (Sidecar + Skill) built for **Google Antigravity (v2.35.0+)**. Powered by the official `ConversationService` Connect API and a read-only SQLite FTS summary index, it **never modifies `app.asar` or writes directly to Antigravity's internal database**, keeping your workspace safe across app updates.

## Screenshots

**Main Workspace & Auto-Collapsed Long Replies (Active View · Amber Archive Buttons)**

![Main Workspace and Auto-Collapse Preview](docs/screenshots/preview-main.png)

**Archived View, Full-Text Search Highlighting & Expanded Markdown Preview (Green One-Click Restore)**

![Archived View and Search Highlight Preview](docs/screenshots/preview-archived.png)

## Key Features

- **5-Tab Categorized Views**: Switch seamlessly across **Archived**, **Active**, **Starred**, **Stale**, and **All** conversations with live counts.
- **Full-Text Search & Multi-Dimensional Filters**: Search across titles, project names, message bodies (via read-only FTS index), custom tags, and personal notes; filter by project or tag and sort by last updated, step count, or title.
- **Instant Native Archive / Restore with Undo**: Color-coded green **Restore** and amber **Archive** buttons switch state natively without jarring window jumps, paired with an Undo toast, multi-select batch operations, and one-click stale cleanup (3 / 7 / 14 / 30 days).
- **Full-Transcript Preview Without Restoring**:
  - Reads `transcript_full.jsonl` first (falling back to `transcript.jsonl` and FTS chunks) so long replies stay intact without compact-log truncation.
  - Smooth independent scrolling, automatic collapsing with a fade overlay for long replies (> 450px) and an **Expand / Collapse** toggle, plus toolbar shortcuts for **Expand All / Collapse All**, **Top**, **Bottom**, and **Markdown / Raw** view.
- **Inline Organization & Safe Deletion**: Rename conversations inline, pin (📌) or star (★) directly from list cards, attach custom `#tags` and auto-saved personal notes (stored cleanly in Sidecar data dir), and safely block/confirm deletion of running conversations.
- **One-Click Markdown Export**: Export full conversations (metadata, tags, notes, and all turns) to `~/Documents/Antigravity-Exports` as `.md` files with cross-platform **Reveal in Folder** support.
- **Optional Left-Sidebar Quick Entry**: When Antigravity is launched with `--remote-debugging-port=0`, mounts a native-styled **Session Manager** button with a live archived-count badge in the left sidebar. Without CDP, the panel still opens normally via the side-panel Plugins menu or skill prompts.

## Installation

### Option 1: Install Scripts (Recommended)

**Windows (PowerShell):**

```powershell
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager
.\scripts\install.ps1
```

**macOS / Linux:**

```bash
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager
chmod +x scripts/install.sh
./scripts/install.sh
```

### Option 2: Manual Installation

Copy the plugin payload into `~/.gemini/config/plugins/archive-manager/` (`%USERPROFILE%\.gemini\config\plugins\archive-manager\` on Windows):

- `plugin.json`
- `logo.svg`
- `README.md`
- `LICENSE`
- `skills/`
- `sidecars/`

Then enable **Session Manager (`archive-manager`)** in Antigravity under **Customizations → Plugins**.

## Requirements

- **Google Antigravity** `>= v2.35.0` (for the official `ConversationService` Connect API and `sidecar_sdk` runtime).
- Optional `--remote-debugging-port=0` launch flag for the left-sidebar quick-entry button and live badge.

## License

Licensed under the [MIT License](LICENSE).
