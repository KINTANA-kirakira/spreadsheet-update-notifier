# Google Apps Scriptによるスプレッドシート更新通知ツール

Googleスプレッドシートに新しい行が追加されたとき、Discord Webhook と Gmail へ自動通知するポートフォリオ用ツールです。問い合わせ・注文管理・在庫確認など、スプレッドシートを毎回開いて確認する手間を減らす目的で制作しました。

## English Summary

A Google Apps Script tool that checks a Google Spreadsheet on a time-driven trigger and sends notifications to Discord and Gmail when new rows are added.

## Features

- 時間主導トリガーでスプレッドシートを定期チェック
- 未通知の新規行だけを通知
- 通知文に `日時` / `名前` / `内容` を表示
- Discord と Gmail の両方に対応
- 初回実行時は既存行を大量通知せず、現在の最終行から監視開始
- `PropertiesService` で最後に通知した行番号を保存
- 宛先ごとの送信状態を保存し、部分失敗時は未送信の宛先だけ再試行
- `LockService` で同時実行による二重通知を抑制

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

シート名のデフォルトは `Responses` です。1行目に次の見出しを作成してください。このツールは追記専用のシートを想定しているため、通知済み行の並べ替えや途中への行挿入は避けてください。

| 日時 | 名前 | 内容 |
| --- | --- | --- |
| 2026/05/13 09:00 | 山田太郎 | 問い合わせフォームから資料請求が届きました |

サンプルデータは `samples/sample-sheet.csv` にあります。

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

`DISCORD_WEBHOOK_URL` または `EMAIL_TO` が空でも、もう片方が設定されていれば通知は継続します。両方空の場合は通知先がないため、行番号は更新されません。

## Trigger

Apps Script エディタで `installTimeDrivenTrigger()` を1回実行すると、`checkNewRows()` が5分ごとに実行されます。手動で設定する場合は、Apps Script の `トリガー` 画面から次の内容で作成してください。

| Item | Value |
| --- | --- |
| 実行する関数 | `checkNewRows` |
| イベントのソース | 時間主導型 |
| 時間ベースのトリガー | 分ベースのタイマー |
| 間隔 | 5分おき |

## How It Works

1. `checkNewRows()` が `LockService` のロックを取得し、対象シートの最終行を取得します。
2. `ScriptProperties` の `LAST_NOTIFIED_ROW` と比較します。
3. 初回実行時は既存行を通知せず、現在の最終行を保存します。
4. 2回目以降は `LAST_NOTIFIED_ROW` より下の行だけを読み取ります。
5. `名前` または `内容` が空の行は通知対象外として処理済みにします。
6. Discord / Gmail のどちらかだけ失敗した場合は、成功済みの宛先を `PENDING_NOTIFICATION_STATE` に保存します。
7. 次回実行時は未送信の宛先だけ再試行し、必要な通知が完了した行まで `LAST_NOTIFIED_ROW` を更新します。

## Verification

1. `checkNewRows()` を手動実行し、初回は通知されず `LAST_NOTIFIED_ROW` が保存されることを確認します。
2. スプレッドシートに新しい行を追加します。
3. `checkNewRows()` を再実行し、Discord と Gmail に通知が届くことを確認します。
4. `DISCORD_WEBHOOK_URL` を空にして Gmail だけ届くことを確認します。
5. `EMAIL_TO` を空にして Discord だけ届くことを確認します。
6. `名前` または `内容` が空の行を追加し、通知されないことを確認します。
7. Discord または Gmail の片方を一時的に失敗させ、復旧後に未送信の宛先だけ再試行されることを確認します。

## Portfolio Notes

タイトル例:

```text
Google Apps Scriptによるスプレッドシート更新通知ツール
```

説明文例:

```text
スプレッドシートに新しい行が追加された際、DiscordとGmailへ自動通知するツールです。問い合わせ・注文管理・在庫確認など、手動確認の手間を減らす目的で制作しました。
```

GitHubには次の内容を載せると伝わりやすくなります。

- `README.md`
- `src/Code.gs`
- `samples/sample-sheet.csv`

## License

MIT License
