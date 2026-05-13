# Google Apps Scriptによるスプレッドシート更新通知ツール

Googleスプレッドシートに新しい行が追加されたとき、Discord Webhook と Gmail へ自動通知するツールです。問い合わせ・注文管理・在庫確認など、スプレッドシートを毎回開いて確認する手間を減らす目的で制作しました。

## English Summary

A Google Apps Script tool that checks a Google Spreadsheet on a time-driven trigger and sends notifications to Discord and Gmail when new rows are added.

## Features

- 時間主導トリガーでスプレッドシートを定期チェック
- 未通知の新規行だけを通知
- 通知文に `日時` / `名前` / `内容` を表示
- Discord と Gmail の両方に対応
- 初回実行時は既存行を大量通知せず、現在の最終行から監視開始
- `通知ID` 列で行を識別し、並べ替えや途中挿入後も重複通知を防止
- 宛先ごとの送信状態をシートに保存し、部分失敗時は未送信の宛先だけ再試行
- 通知開始時の内容をスナップショット保存し、部分失敗後の再試行でも同じ内容を送信
- `LockService` で同時実行による二重通知を抑制
- 管理列を自動で非表示・保護して、手動編集による状態破損を防止

## Files

```text
spreadsheet-update-notifier/
├── .gitignore
├── LICENSE
├── README.md
├── samples/
│   └── sample-sheet.csv
└── src/
    ├── Code.gs
    └── appsscript.json
```

## Spreadsheet Format

シート名のデフォルトは `Responses` です。1行目に次の見出しを作成してください。

| 日時 | 名前 | 内容 |
| --- | --- | --- |
| 2026/05/13 09:00 | 山田太郎 | 問い合わせフォームから資料請求が届きました |

サンプルデータは `samples/sample-sheet.csv` にあります。

## Operational Notes

- 初回実行時に既存の完成済み行は通知済みとして扱い、新規通知は次回以降に追加・更新された未通知行から始まります。
- `通知ID` / `Discord通知済み` / `Gmail通知済み` / `通知スナップショット` はスクリプトが自動追加し、非表示・保護する管理列です。
- 行を並べ替えたり途中に挿入したりしても、管理列が行と一緒に移動していれば通知状態は保たれます。
- 管理列を含めずに一部の列だけを並べ替えると、行と通知状態がずれる可能性があります。並べ替えやコピーは行全体に対して行ってください。
- `名前` または `内容` が空の行は処理済みにせず、あとから値が入った時点で通知対象になります。
- 通知が始まった行は `通知スナップショット` の内容で再試行されます。通知後に本文を編集しても再通知はされません。
- 通知済み行をコピーすると `通知ID` の重複を検知し、コピー側には新しいIDを割り当てて通知対象にします。

## Setup

1. Googleスプレッドシートを作成し、シート名を `Responses` にします。
2. 1行目に `日時` / `名前` / `内容` を追加します。
3. メニューから `拡張機能` -> `Apps Script` を開きます。
4. `src/Code.gs` の内容を Apps Script の `Code.gs` に貼り付けます。
5. プロジェクト設定で `appsscript.json` を表示し、`src/appsscript.json` の内容を反映します。
6. Apps Script の `プロジェクトの設定` -> `スクリプト プロパティ` に設定値を追加します。

## ScriptProperties

| Key | Example | Description |
| --- | --- | --- |
| `SHEET_NAME` | `Responses` | 監視するシート名。未設定時は `Responses` |
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/...` | Discord Webhook URL |
| `EMAIL_TO` | `sample@example.com` | 通知先メールアドレス。カンマ区切りで複数指定可 |
| `ENABLE_DISCORD` | `true` | Discord通知を有効化 |
| `ENABLE_EMAIL` | `true` | Gmail通知を有効化 |

`DISCORD_WEBHOOK_URL` または `EMAIL_TO` が空でも、もう片方が設定されていれば通知は継続します。両方空の場合は通知先がないため、通知処理は行われません。

## Trigger

Apps Script エディタで `installTimeDrivenTrigger()` を1回実行すると、`checkNewRows()` が5分ごとに実行されます。手動で設定する場合は、Apps Script の `トリガー` 画面から次の内容で作成してください。

| Item | Value |
| --- | --- |
| 実行する関数 | `checkNewRows` |
| イベントのソース | 時間主導型 |
| 時間ベースのトリガー | 分ベースのタイマー |
| 間隔 | 5分おき |

## How It Works

1. `checkNewRows()` が `LockService` のロックを取得します。
2. 管理列がなければ自動で追加し、管理列を非表示・保護します。
3. 初回実行時は既存の完成済み行に `INITIAL_SYNC` を記録し、大量通知を防ぎます。
4. 2回目以降は全データ行を読み取り、`通知ID` がない行にはIDを割り当てます。
5. `名前` または `内容` が空の行は通知せず、次回以降もチェックします。
6. 通知対象になった行は現在の内容を `通知スナップショット` に保存します。
7. Discord / Gmail の成功状態をそれぞれの管理列に保存し、失敗した宛先だけ次回再試行します。

## Verification

1. `checkNewRows()` を手動実行し、初回は通知されず管理列が追加・非表示・保護されることを確認します。
2. スプレッドシートに新しい行を追加します。
3. `checkNewRows()` を再実行し、Discord と Gmail に通知が届くことを確認します。
4. `DISCORD_WEBHOOK_URL` を空にして Gmail だけ届くことを確認します。
5. `EMAIL_TO` を空にして Discord だけ届くことを確認します。
6. `名前` または `内容` が空の行を追加し、あとから値を入れると通知されることを確認します。
7. Discord または Gmail の片方を一時的に失敗させ、復旧後に未送信の宛先だけ再試行されることを確認します。
8. 通知前の行を並べ替えたり途中に挿入したりしても、重複通知されないことを確認します。

## License

MIT License
