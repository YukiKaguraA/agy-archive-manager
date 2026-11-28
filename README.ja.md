# セッション管理 · Session Manager

**Google Antigravity のセッションを検索、プレビュー、アーカイブし、Markdown に書き出せます。**

[**简体中文**](./README.md) · [**English**](./README.en.md) · [**繁體中文**](./README.zh-TW.md) · [**日本語**](./README.ja.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png" />
  <img src="docs/screenshots/hero-light.png" width="100%" alt="セッション管理パネル。既定ではアクティブ一覧を表示" />
</picture>

Google Antigravity 向けの独立したコミュニティ製プラグインです。画面は簡体字中国語、英語、繁体字中国語、日本語に対応し、選んだ言語を記憶します。セッション名、メッセージ、タグ、メモは原文のまま表示します。

## パネルの使い方

上部の「会話ライブラリ」「タグ」「設定」で画面を切り替えます。会話ライブラリには「アクティブ」「アーカイブ済み」「お気に入り」「すべて」「長期未使用」「ごみ箱」が並びます。起動時は「アクティブ」を開き、最も新しく更新されたワークスペースを展開します。各ワークスペースは一度に最大 50 件を読み込みます。カードにはユーザーのターン数、ステップ数、ファイル数、セッションの保存容量が表示されます。

| 目的 | 操作 |
| --- | --- |
| 過去のセッションを探す | 検索欄の右側で原文の一部または複数キーワードの検索を選びます。ワークスペースを展開し、グループやタグでも絞り込めます。該当箇所は強調表示されます。 |
| アーカイブ・復元する | セッションカードまたはプレビュー上部から操作します。一括アーカイブや一括復元も取り消せます。 |
| ゴミ箱を使う | ゴミ箱に移動するとセッションはアーカイブされます。復元すると元のアーカイブ状態に戻り、確認して完全に削除することもできます。既定の保存期間は 7 日です。設定で 1〜365 日を指定できます。期間を短くすると対象件数が表示され、定期チェックまたは手動確認で削除されます。 |
| 使っていないセッションを整理する | 未使用のセッションを 3、7、14、30 日で絞り込み、一括でアーカイブできます。実行直前に各セッションの状態を再確認します。 |
| 長い会話を読む | Markdown 表示と原文表示を切り替えられます。長いメッセージは必要に応じて展開できます。`F3` と `Shift+F3` で次または前の検索結果に移動します。 |
| メッセージやターンをコピーする | カードを右クリックし、「このメッセージ全文をコピー」または「このターン全体をコピー」を選びます。折りたたまれているメッセージも全文をコピーできます。 |
| 詳細統計を確認する | 「詳細統計」を開くと、ターン数、ツールの呼び出し、変更されたファイル、取得できるトークン数が表示されます。 |
| タグを管理する | 「タグ」から作成、検索、絞り込み、名前変更、統合、削除ができます。プレビューの「タグとメモ」から既存のタグを追加できます。 |
| メッセージカードの表示名を変更する | 「設定 → メッセージカード表示名」でユーザー側とアシスタント側の名前を変更します。カードと Markdown の書き出しに反映されます。空欄にすると現在の言語の既定名に戻ります。 |
| 整理して書き出す | ピン留め、スター、名前変更、タグ、メモを使えます。Markdown にはセッション情報、本文の取得元、タグ、メモが含まれます。 |

<img src="docs/screenshots/preview-archived.png" width="100%" alt="アーカイブ済みセッションの検索結果、会話プレビュー、復元ボタン" />

ワークスペースはホストのプロジェクト順を優先し、未割り当ては末尾に表示されます。プレビューでは `F3` と `Shift+F3` で検索結果を循環し、該当する折りたたみメッセージを開けます。ログフォルダーも開けます。

プレビューの「詳細統計」で、ターン数、ツールの呼び出し、ログに記録されたファイル変更を確認できます。現存するファイルはファイルマネージャーで表示できます。トークン数にはローカルの Usage Monitor 台帳、またはログの実測値を使用します。

タグにはセッションの状態別件数が表示されます。ローカルとホストのタグが異なるセッションは一括操作の対象から外れます。選択したテキストやメッセージ内のリンクを右クリックすると、ホストのメニューが表示されます。

## 🆕 v2.4.0 の変更点

- ワークスペースごとの展開と折りたたみ、ゴミ箱からの復元、設定画面に対応しました。
- タグの管理とセッションの詳細統計を追加しました。Usage Monitor のデータがあれば、追加の指標を確認できます。
- メッセージカードの表示名を変更でき、右クリックでメッセージ全文や対応するターン全体をコピーできます。

[変更履歴の詳細](./CHANGELOG.md)

## インストールと更新

Antigravity 2.35.0 以降に対応します。Sidecar から `node:sqlite` を読み込める Node.js が必要です。Node.js 22.13 以降の 22.x LTS または 24 LTS を使用してください。

**Windows（PowerShell）**

```powershell
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager
.\scripts\install.ps1
```

**macOS / Linux**

```bash
git clone https://github.com/YukiKaguraA/agy-archive-manager.git
cd agy-archive-manager
chmod +x scripts/install.sh
./scripts/install.sh
```

手動でインストールする場合は、`plugin.json`、`logo.svg`、4 種類の README、`CHANGELOG.md`、`LICENSE`、`docs/screenshots/`、`skills/`、`sidecars/` を `~/.gemini/config/plugins/archive-manager/` にコピーします。Windows では `%USERPROFILE%\.gemini\config\plugins\archive-manager\` です。

Antigravity の **Customizations → Plugins** で **会话管理 (Session Manager)** を有効にし、右側のプラグインメニューから開きます。言語はパネルの「設定」で変更できます。ローカルのソースから更新するときも、同じスクリプトを実行してください。

## よくある質問

**左サイドバーにボタンが表示されません**

左サイドバーのボタンとアーカイブ件数バッジには Chrome DevTools Protocol（CDP）が必要です。使用するときは Antigravity を `--remote-debugging-port=0` で起動してください。右側のプラグインメニューからもパネルを開けます。

**パネルが開きません。SQLite のエラーが出ます**

Sidecar が使う Node.js で `node:sqlite` が利用できるか確認します。次のコマンドが `function` を出力すれば利用できます。

```sh
node -e "import('node:sqlite').then(m => console.log(typeof m.DatabaseSync))"
```

**古いセッションで一部のメッセージしか表示されません**

プレビューは `transcript_full.jsonl` を優先して読み込み、利用できる場合は `transcript.jsonl` と照合します。両方から本文を取得できない場合は、全文検索インデックスにある抜粋を表示し、会話の一部であることを知らせます。

**書き出したファイル、タグ、メモはどこにありますか**

Markdown の既定の出力先は `~/Documents/Antigravity-Exports` です。設定からフォルダーを選ぶか、絶対パスを入力できます。書き出すたびに別のファイルが作られ、パネルからファイルの場所を表示できます。タグはホスト側で更新し、取得し直して反映を確認します。メモと旧版のローカルタグ情報は Sidecar のデータフォルダーに保存されます。ローカルとホストのタグが異なる場合は、プレビューで両方を確認して採用するタグを選べます。Antigravity 2.35.2 では最後のタグの削除が反映されない場合があります。その際は結果を通知し、ローカルの記録を保持します。

**Antigravity の更新後、一部の機能が動きません**

アーカイブなどの操作にはホスト内部の `ConversationService` を使います。検索は SQLite インデックスを読み取り専用で参照し、プレビューは会話ログを読み込みます。更新後の問題を報告する際は Antigravity のバージョンを添えてください。[問題を報告する](https://github.com/YukiKaguraA/agy-archive-manager/issues) · [Sidecar のドキュメント](https://antigravity.google/docs/sidecars/)

## 開発とテスト

リポジトリのルートで `node --test` を実行します。テストは模擬サービスと一時データを使用します。推奨するテスト環境は Node.js 22.15 以降の 22.x LTS または 24 LTS です。画面の変更後は `node tools/render-hero.mjs` でライトとダークのプレビューを作成できます。[履歴検索のベンチマーク](https://github.com/YukiKaguraA/agy-archive-manager/blob/v2.3.0/docs/benchmark-v2.3.0.md)

[変更履歴](./CHANGELOG.md) · [リリース](https://github.com/YukiKaguraA/agy-archive-manager/releases) · [MIT ライセンス](./LICENSE)
