# X動画チャンクアップロード対応計画

## 1. 目的

Google Drive上の50MBを超える動画を、Google Apps Scriptの1リクエスト50MB制限に抵触せずXへ投稿できるようにする。

今回の直接的な対象は `guitar_teaser_2.mp4`（175,046,848 bytes、約167MiB）。現状は動画全体を `DriveApp.getFileById(fileId).getBlob()` で読み込んだ時点で失敗しており、その後のX向けチャンク処理まで到達していない。

## 2. 完了条件

- 50MBを超えるDrive動画を、全体Blobへ変換せず5MiB以下の範囲単位で読み出せる。
- Xの `INIT → APPEND → FINALIZE → STATUS` を通して動画を投稿できる。
- 1回のApps Script実行が時間上限へ近づいた場合、次回トリガーから同じアップロードを再開できる。
- 再開時に、送信済みチャンクや投稿済みのXポストを重複送信しない。
- XとInstagramの両方が選択された行で、X完了後にInstagramが失敗してもXを二重投稿しない。
- 小さい動画、画像投稿、Instagram投稿の既存動作を壊さない。
- 失敗時は、工程・HTTPステータス・対象チャンク・再試行可否をシートのエラーログから判別できる。

## 3. 採用方針

### 3.1 Driveから直接Range取得する

`getFileFromDriveUrl_()` で動画全体のBlobを返す方式をやめ、動画投稿では次の情報だけを先に取得する。

- DriveファイルID
- ファイル名
- MIMEタイプ
- ファイルサイズ
- 更新日時
- 動画の長さ、幅、高さ
- ダウンロード可否

チャンクごとにDrive APIの次のURLを呼ぶ。

```text
GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media
Range: bytes={start}-{end}
Authorization: Bearer {ScriptApp.getOAuthToken()}
```

1回のレスポンスを最大5MiBに限定し、取得したバイト列をそのままXのAPPENDへ渡す。ファイル全体のバイト配列は作らない。

参考:

- [Google Drive API: Download and export files](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive API: files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)

### 3.2 Xへの送信もチャンク単位にする

Xの動画アップロードは次の状態遷移で扱う。

```text
INIT
  ↓
APPEND segment 0..N
  ↓
FINALIZE
  ↓
STATUS pending / in_progress
  ↓
STATUS succeeded
  ↓
POST /2/tweets
```

最初の実装では、現在稼働実績のあるOAuth 1.0a認証と既存のv1.1 uploadエンドポイントを維持し、Drive側の取得方法だけを差し替える。併せて小容量動画による互換性確認を行う。

現行公式のX API v2 Media Uploadへの移行は別タスクとする。認証方式とレスポンス形式が変わるため、今回同時に移行すると原因切り分けが難しくなるためである。ただし、既存v1.1エンドポイントが利用できないことを互換性確認で検出した場合は、実装前にv2移行へ方針を切り替える。

参考:

- [X API: Chunked Media Upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [X API: Media best practices](https://docs.x.com/x-api/media/quickstart/best-practices)

## 4. 実装設計

### 4.1 Drive URLとメタデータ処理を分離する

追加・変更する関数の想定:

```js
extractDriveFileId_(driveUrl)
getDriveVideoMetadata_(fileId)
fetchDriveByteRange_(fileId, start, end)
```

要件:

- `/file/d/{id}/...` と `?id={id}` の両形式を扱う。
- メタデータ取得では `alt=media` を付けない。
- `size` は文字列から安全に数値化し、有限の正整数であることを検証する。
- `fetchDriveByteRange_()` はHTTP 206を期待する。
- `Content-Range` と実バイト数が要求範囲に一致することを検証する。
- HTTP 200でファイル全体が返った場合は処理を続けず、Rangeが無視されたことを明示して失敗させる。
- Drive権限エラー、ダウンロード禁止、ファイル更新を区別してログへ残す。

### 4.2 動画アップロード関数の入力をBlobからDrive参照へ変更する

現状:

```js
uploadVideoMedia_(blob, props)
```

変更後の想定:

```js
uploadVideoMediaFromDrive_(job, props, deadlineMs)
```

`job` は少なくとも次を保持する。

```js
{
  version: 1,
  rowNumber,
  fileId,
  fileName,
  mimeType,
  totalBytes,
  modifiedTime,
  mediaId,
  nextSegmentIndex,
  nextByteOffset,
  phase,
  completedTargets,
  tweetId,
  updatedAt
}
```

チャンクサイズは5MiBとする。

```js
const VIDEO_CHUNK_BYTES = 5 * 1024 * 1024;
```

各APPEND成功後にだけ `nextSegmentIndex` と `nextByteOffset` を保存する。失敗したチャンクは同じ番号で再試行し、成功済みチャンクを再送しない。

### 4.3 実行時間をまたぐ継続処理を追加する

Apps Scriptの通常実行上限は6分なので、1回の処理予算を約4分30秒に制限する。

```js
const EXECUTION_BUDGET_MS = 4.5 * 60 * 1000;
```

予算を超えそうな場合:

1. 現在のジョブ状態をScript Propertiesへ保存する。
2. シートのE列を `uploading` または `processing` にする。
3. エラーにはしない。
4. 次回の既存10分トリガーで処理を再開する。

状態保存キーは、スプレッドシート・シート・行番号を含む固定形式にする。

```text
X_UPLOAD_JOB:{spreadsheetId}:{sheetName}:{rowNumber}
```

Driveファイルの `modifiedTime` またはサイズが途中で変化した場合は、別ファイルとして扱ってジョブを安全に中止する。

参考:

- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Apps Script best practices: timeout handling](https://developers.google.com/apps-script/guides/support/best-practices)

### 4.4 トリガー重複実行を防止する

`checkAndPost()` の開始時に `LockService.getScriptLock()` を取得する。

- ロック取得済みなら処理を開始する。
- 取得できなければ、その回は何も変更せず終了する。
- `finally` で必ず解放する。

これにより、手動実行と定期トリガー、または複数トリガーが同じ行を同時処理することを防ぐ。

### 4.5 行単位の投稿状態を明確化する

E列の状態を次のように扱う。

| 状態 | 意味 | 次回トリガー |
| --- | --- | --- |
| 空欄 | 未処理 | 時刻到来後に開始 |
| `uploading` | Drive取得・X APPEND中 | 保存状態から再開 |
| `processing` | X FINALIZE後の変換待ち | STATUSから再開 |
| `posting` | メディア処理完了、ポスト作成前後 | 保存状態を確認 |
| `posted` | 全対象完了 | スキップ |
| `error` | 永続エラーまたは再試行上限到達 | スキップ |

一時的なHTTP 429、5xx、ネットワークエラーは即座に `error` にせず、再試行回数と次回実行時刻をジョブへ保存する。認証エラー、形式不正、Xの動画要件違反などは永続エラーとして扱う。

### 4.6 XとInstagramの二重投稿を防ぐ

現状はX完了後にInstagramが失敗すると、行を再実行した際にXをもう一度投稿する可能性がある。

対応:

- ターゲットごとの完了状態を `completedTargets` に保存する。
- X投稿成功後は、返されたTweet IDを保存してからInstagramへ進む。
- 再開時は完了済みターゲットをスキップする。
- 全ターゲット完了後にだけE列を `posted` にする。
- `posted` 設定後にジョブを削除する。

ポスト作成リクエスト送信後、応答受信前に実行が停止した場合だけは完全なexactly-once保証が難しい。この狭い区間については、投稿文・時刻・メディアIDを使った直近投稿確認を追加するか、手動確認が必要な `unknown` 状態にして自動再投稿しない方針とする。初期実装では安全側の `unknown` を採用する。

### 4.7 動画の事前検証を追加する

INIT前に次を検証し、明確なメッセージで停止する。

- MIMEタイプがXで扱える動画形式であること。
- ファイルサイズが対象media categoryの上限以内であること。
- 動画時間、解像度など、Driveメタデータで判定可能な要件。
- X APIキー4種が空でないこと。

Xからのレスポンスには必ずHTTPステータスと本文先頭の安全な範囲を含める。アクセストークンなどの秘密情報はログへ出さない。

### 4.8 STATUS待機を非ブロッキング化する

現状の `waitForProcessing_()` は最大150秒sleepする。これを次の方式へ変更する。

- Xの `check_after_secs` を尊重する。
- 同一実行内に十分な残り時間がある場合だけ再確認する。
- 残り時間が少なければ `processing` 状態と次回確認時刻を保存して終了する。
- 次回トリガーはSTATUS確認から再開する。

## 5. 変更対象

主な変更対象:

- `コード.js`
  - DriveファイルID抽出
  - Driveメタデータ取得
  - Range取得
  - X動画チャンクアップロード
  - ジョブ状態保存・復元
  - LockService
  - 行ステータス遷移
  - ターゲット別完了管理
- `appsscript.json`
  - 現行のDrive・外部通信スコープで足りる見込み。実装後に必要スコープを再確認する。

変更しない予定:

- `Instagram.js` のInstagram API処理本体
- スプレッドシートの列追加
- Xの画像アップロード処理

## 6. 実装手順

### Phase 1: 互換性確認と安全網

1. 現行X v1.1チャンクアップロードを小容量テスト動画で確認する。
2. `getProps_()` に必須キー検証を追加する。
3. `checkAndPost()` にScript Lockを追加する。
4. ジョブ状態の保存・読込・削除ヘルパーを追加する。
5. シート状態の定数と遷移ルールを追加する。

判断点:

- v1.1 uploadが成功する: 既存認証を維持してPhase 2へ進む。
- v1.1 uploadが廃止・権限不足: X API v2 Media UploadとOAuth 2.0 PKCE対応を先に設計し直す。

### Phase 2: Drive Range取得

1. Drive URL解析を独立関数へ切り出す。
2. Drive APIで動画メタデータを取得する。
3. 指定バイト範囲だけ取得する関数を追加する。
4. HTTP 206、Content-Range、取得バイト数を検証する。
5. 5MiB未満・超50MB・最終端数チャンクで単体確認する。

### Phase 3: Xアップロードの再開対応

1. INIT成功後にmedia IDを保存する。
2. Driveから1チャンク取得し、XへAPPENDする。
3. APPEND成功ごとに次のoffsetを保存する。
4. 実行予算到達時に安全終了する。
5. 全チャンク後にFINALIZEする。
6. STATUSを非ブロッキングで確認する。
7. succeeded後にポストを作成する。

### Phase 4: 複数投稿先の再開対応

1. 完了済みターゲットを保存する。
2. 再開時に完了済みターゲットをスキップする。
3. X完了後のInstagram失敗を人工的に発生させ、Xが再投稿されないことを確認する。
4. 全対象完了後にのみ `posted` を設定する。

### Phase 5: 既存エラー行の再実行

1. 本番コード反映前にテスト用行またはテスト用Xアカウントで確認する。
2. `guitar_teaser_2.mp4` のコーデック・時間・解像度を事前確認する。
3. 対象行の既存ジョブがないことを確認する。
4. E/F/J列を再実行可能な状態へ戻す。
5. トリガー実行を監視する。
6. XとInstagramの投稿結果、Tweet ID、最終 `posted` を確認する。

## 7. テスト計画

### 7.1 ユニット相当の確認

- Drive URLから正しいIDを抽出できる。
- 不正URLを明示的に拒否する。
- Rangeの開始・終了・最終端数を正しく計算する。
- 175,046,848 bytesを5MiBで34セグメントに分割する。
- ジョブの保存・復元・削除ができる。
- ファイル更新を検知できる。
- OAuth署名対象にmultipart本文を誤って含めない。

### 7.2 結合確認

| ケース | 期待結果 |
| --- | --- |
| 50MB未満の動画 | 従来どおり投稿成功 |
| 約167MiBの対象動画 | 全体Blob化せず34チャンクで完了 |
| 最終チャンクが5MiB未満 | 正しいContent-Rangeで成功 |
| 途中APPENDが一度500 | 同じsegmentだけ再試行 |
| 実行予算到達 | `uploading` のまま次回再開 |
| FINALIZE後の処理待ち | `processing` のまま次回STATUS再開 |
| トリガー同時起動 | 一方だけが処理 |
| X成功・Instagram失敗 | Xを再投稿せずInstagramから再開 |
| 認証エラー | 永続エラーとして詳細記録 |
| X動画要件違反 | INIT前またはAPI応答で明確に停止 |

### 7.3 本番確認で記録するもの

- Driveファイルサイズ
- チャンク総数
- media ID
- 各実行で完了したsegment範囲
- FINALIZE時刻
- STATUSの遷移
- Tweet ID
- 各投稿先の完了状態
- 行の最終ステータス

## 8. ロールバック

- 反映前のApps Scriptバージョンを記録する。
- 問題発生時は `コード.js` と `appsscript.json` を直前版へ戻す。
- `X_UPLOAD_JOB:` 接頭辞のScript Propertiesだけを削除し、APIキーなど他のプロパティは削除しない。
- `uploading`、`processing`、`posting`、`unknown` の行を一覧化し、投稿実績を確認してから空欄または `error` に戻す。
- 投稿済みか不明な `unknown` 行は自動再実行しない。

## 9. リスクと対策

| リスク | 対策 |
| --- | --- |
| Apps Scriptの6分上限 | 4分30秒で状態保存し次回再開 |
| DriveがRangeを無視 | HTTP 206とContent-Rangeを必須検証 |
| 同一segmentの重複送信 | APPEND成功後のみoffsetを進める |
| Xポストの二重作成 | Tweet ID保存、完了ターゲット記録、曖昧時は `unknown` |
| ファイルが途中で差し替わる | sizeとmodifiedTimeを照合して中止 |
| X API仕様変更 | Phase 1でv1.1互換性を確認し、必要ならv2へ切替 |
| STATUS待機で時間消費 | sleepループをやめ、次回トリガーへ継続 |
| エラー行が永久スキップ | 一時エラーと永続エラーを分類し、一時エラーは自動再試行 |

## 10. 実装後の運用

- 正常時のシート表示は最終的に従来どおり `posted` とする。
- 長時間動画では途中で `uploading` や `processing` が表示される。
- `error` を手動で消すだけの再試行は原則やめ、再試行関数でジョブ状態と投稿実績を確認してから再開する。
- 不要になった完了・期限切れジョブを定期的に掃除する保守関数を用意する。
- ログには秘密情報や動画本文を含めない。
