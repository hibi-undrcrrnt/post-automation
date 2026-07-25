# Instagram Storiesメディア全体表示の運用計画

作成日: 2026-07-25

## 1. 目的

横長の画像・動画をInstagram Storiesへ投稿したときに中央クロップせず、
素材全体を9:16の画面内へ表示する。

以下も同時に満たす。

- 画像・動画の縦横比を維持する
- タイムアウトや一時障害から自動再開できる
- 同じ投稿を重複送信しない
- Drive上の非公開素材を必要以上に公開しない
- 変換結果を期限付きで削除する
- 変換未完了時に未加工の横長素材を誤投稿しない

## 2. 結論

恒久構成には、**Cloud Run Job + FFmpeg + Cloud Storage**を採用する。

Cloudinaryは変換機能そのものには適しているが、次の理由から第一候補にはしない。

- 現在の実装は、予約時刻になってから同期的にFetch変換している
- Apps Scriptには1実行6分の制限がある
- Cloudinary無料プランの最大動画サイズは100MBで、現行コードの最大1GBと一致しない
- Fetchキャッシュ、署名、利用量、削除を追加管理する必要がある
- 本プロジェクトで必要なのは、DAMやCDNではなく固定された1種類の変換である

Cloudinaryを利用する場合は、後述の「Cloudinary代替案」の条件をすべて満たすこと。

## 2.1 実装状況

`feature/instagram-stories-full-frame`ブランチへ以下を実装した。

| 項目 | 状況 |
| --- | --- |
| Cloud Run Job本体 | 実装済み |
| FFmpeg画像・動画変換 | 実装済み |
| GCS署名URL・結果manifest | 実装済み |
| Apps Script事前準備トリガー | 実装済み |
| Apps Script状態保存・再開 | 実装済み |
| 二重投稿防止用`published` / `unknown`管理 | 実装済み |
| `legacy` / `enforce` / `pause`安全切替 | 実装済み |
| 投稿なしの1行変換確認 | 実装済み |
| 単体テスト | 実装済み |
| GCPリソース作成 | `hibi-452314`へ作成済み |
| Cloud Runデプロイ | デプロイ・実ファイル検証済み |
| Apps Scriptデプロイ | 標準GCP接続・コード反映・E2E変換確認済み、`legacy` |
| Instagram実投稿テスト | 未実施 |

### 2.2 GCP構築状況

2026-07-25時点で、`hibi-452314`へ次を構築済み。

- リージョン: `asia-northeast1`
- Artifact Registry: `story-media`
- Cloud Run Job: `story-media-transformer`
- 専用サービスアカウント: `story-media-transformer`
- 非公開GCSバケット: `hibi-452314-story-media`
- GCS Lifecycle: 3日後に削除
- GCS soft delete: 一時変換データのため無効
- Cloud Run再試行: 最大2回
- Cloud Run実行上限: 15分

Apps Scriptの実行ユーザーには、Jobの実行・参照と対象バケットの
参照に必要なIAMロールを付与済み。

実ファイル検証用の画像・動画は、フォルダ全体ではなく各ファイルだけを
サービスアカウントへ閲覧共有している。本番運用では素材ごとの共有漏れを
防ぐため、専用入力フォルダを作成してサービスアカウントへ閲覧共有する。

Apps Scriptコードは本番プロジェクトへ反映済みだが、
設定未実行時は従来動作の`legacy`となる。

`configureStoriesTransformForHibi()`は、hibi用の非秘密設定を
`legacy`として保存し、Cloud Run Jobとバケットの接続確認まで行う。
有効化・緊急停止・従来動作への復帰は
`setStoriesTransformMode('enforce' | 'pause' | 'legacy')`で明示的に行う。

Apps Scriptは標準GCPプロジェクト`hibi-452314`へ接続済み。
OAuth同意画面は外部・テストユーザー限定で初期設定済みである。
定期トリガーを有効化する前に、OAuthの公開ステータスを本番へ変更する。

### 2.3 実ファイル検証結果

2026-07-25に投稿を伴わないCloud Run実行で確認済み。

| 素材 | 入力 | 出力 | 結果 |
| --- | --- | --- | --- |
| 横長JPEG | 225,230 bytes | 1080×1920 JPEG | 全体を中央表示し、上下へ黒余白 |
| 縦長MOV | 48,582,370 bytes / 32.491秒 | H.264/AAC MP4 | 1080×1920へ正常化 |
| 横長MP4 | 175,046,848 bytes / 31.508秒 | 11,376,862 bytes H.264/AAC MP4 | 全体を中央表示し、上下へ黒余白 |

横長MP4の初回検証で元ファイルの`tmcd`タイムコードトラックが
出力へ残ることを検出したため、メタデータ・チャプター・データトラックを
除去するよう修正した。最終出力は映像と音声の2トラックだけである。

画像・動画とも署名URLを値を表示せず匿名Range GETし、
HTTP 206と正しいContent-Typeを確認済み。

Apps ScriptからCloud Run Jobを起動するE2E検証でも、
行3の画像と行5の横長動画が`submitted`から`ready`へ遷移し、
同じ出力条件と匿名取得を確認済み。

主な実装ファイルは以下。

- `StoriesMedia.js`
- `コード.js`
- `Instagram.js`
- `cloud-run/story-media-transformer/main.py`
- `cloud-run/story-media-transformer/transformer/core.py`
- `cloud-run/story-media-transformer/README.md`
- `tests/stories-media.test.cjs`

## 3. 選択肢の比較

| 方式 | 評価 | 長所 | 短所 |
| --- | --- | --- | --- |
| Cloud Run Job + FFmpeg | 推奨 | サイズと処理内容を制御できる。非同期・再試行・冪等化が容易 | GCPリソースとコンテナの管理が必要 |
| Cloudinary | 条件付き | 画像・動画変換と公開URL生成が容易 | サイズ・クレジット・キャッシュ・署名・外部依存の管理が必要 |
| Google Transcoder API | 非推奨 | 動画変換のマネージドサービスとして優秀 | 画像処理が別系統になり、入力もGCSへ移す必要がある |
| 手動で9:16化 | 非推奨 | システム変更が少ない | 自動投稿の目的と合わず、作業漏れが発生する |

## 4. 推奨アーキテクチャ

```mermaid
flowchart LR
    A["Google Sheet<br>予約行"] --> B["T-120分<br>prepareStories"]
    B --> C["Cloud Run Job"]
    C --> D["Google Driveから取得"]
    D --> E["FFmpegで<br>1080×1920へ余白付け"]
    E --> F["非公開Cloud Storage"]
    F --> G["期限付き署名URL"]
    G --> H["予約時刻にInstagram投稿"]
    H --> I["72時間後に自動削除"]
```

### 4.1 Google Apps Script

Apps Scriptは次の責務だけを持つ。

- 予約行の検出
- 変換ジョブの開始
- Cloud Run Jobの状態確認
- 変換済みURLによるInstagram投稿
- 投稿ジョブ状態とエラーの記録

Apps Script内では画像・動画本体の変換を行わない。

### 4.2 Cloud Run Job

Cloud Run Jobは次の処理を行う。

1. 指定されたDriveファイルを取得する
2. 入力形式、サイズ、解像度、長さを検証する
3. FFmpegで1080×1920へ変換する
4. 出力を非公開Cloud Storageへ保存する
5. 期限付き署名URLを生成する
6. Apps Scriptが確認できる結果JSONを保存する

### 4.3 Google Drive

- 入力用フォルダだけをCloud Runのサービスアカウントへ共有する
- Driveファイルを「リンクを知っている全員」へ変更しない
- ファイルID、更新日時、サイズ、MD5を入力リビジョンとして扱う
- Apps Scriptで確認したリビジョンとCloud Runが取得した実体を照合する

### 4.4 Cloud Storage

- バケットは非公開にする
- 出力URLは署名付きURLとする
- URLの有効期限は投稿予定時刻から24時間以上とする
- Lifecycle Ruleで出力と結果JSONを72時間後に削除する

## 5. 変換仕様

### 5.1 共通

- 出力解像度: 1080×1920
- 出力比率: 9:16
- 元素材の縦横比を維持
- 素材全体が収まるように縮小または拡大
- 空いた領域へ均等に余白を追加
- 背景色の初期値: 黒 `#000000`
- 背景色は設定値で変更可能
- すでに9:16要件を満たす素材は原則として再変換しない

### 5.2 画像

- 出力形式: JPEG
- カラースペース: sRGB
- EXIF Orientationを反映
- 出力後に1080×1920であることを検証

### 5.3 動画

- 映像: H.264
- 音声: AAC
- Pixel Format: `yuv420p`
- `faststart`を有効化
- タイムコードなど映像・音声以外のトラックを除去
- 元のフレームレートを維持し、Instagram上限を超える場合だけ制限
- 出力後に解像度、再生時間、コーデックを検証

FFmpegの映像フィルターは、次の考え方を使用する。

```text
scale=1080:1920:force_original_aspect_ratio=decrease,
pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black
```

## 6. 予約投稿の状態管理

既存の投稿ジョブへ、Stories変換状態を追加する。

```text
instagram.story.phase
  not_started
  submitted
  processing
  ready
  publishing
  published
  unknown
  error
```

保存対象は以下とする。

```text
instagram.story.sourceFileId
instagram.story.sourceModifiedTime
instagram.story.sourceSize
instagram.story.sourceMd5Checksum
instagram.story.transformVersion
instagram.story.operationName
instagram.story.outputObject
instagram.story.outputUrl
instagram.story.outputUrlExpiresAt
instagram.story.attempts
instagram.story.lastError
```

### 6.1 冪等キー

次の値からSHA-256を生成し、Cloud Run実行と出力オブジェクトのキーにする。

- DriveファイルID
- Drive更新日時
- Driveファイルサイズ
- DriveファイルMD5
- メディア種別
- 背景色
- 変換設定バージョン

同じジョブを再実行しても、同一の出力を再利用する。

入力ファイルが更新された場合はキーが変わるため、古い変換結果を使用しない。

## 7. トリガー運用

### 7.1 `prepareStories`

10分間隔で実行し、現在時刻から2時間以内に予約されたStories行を準備する。

- 対象は`instagram_stories`が有効な行だけ
- 行の`status`は予約時刻まで空欄のまま維持
- Script Properties内へ変換状態を保存
- 未開始ならCloud Run Jobを開始
- 実行中なら状態を確認
- 完了なら署名URLを保存

### 7.2 `checkAndPost`

予約時刻になったときの動作は次のとおり。

| 変換状態 | 動作 |
| --- | --- |
| `ready` | 変換済みURLでInstagramへ投稿 |
| `submitted` / `processing` | 投稿せず次回トリガーへ持ち越す |
| `not_started` | 変換を開始し、完成まで投稿を遅らせる |
| `error` | 行を`error`にして理由を記録 |

変換が未完了の場合、未加工の横長素材は投稿しない。

### 7.3 運用モード

`STORY_TRANSFORM_MODE`で次を切り替える。

| モード | 動作 |
| --- | --- |
| `legacy` | 従来どおり未変換で投稿 |
| `enforce` | 変換済み素材だけを投稿し、変換失敗時は投稿しない |
| `pause` | Stories投稿を停止し、予約時刻に到達した対象行を`error`にする |

障害時に`legacy`へ戻すと未加工素材が投稿されるため、
緊急停止には`pause`を使用する。

## 8. 再試行と障害対応

### 8.1 自動再試行

- Cloud Runタスク失敗: 最大2回
- HTTP 408、425、429、5xx: 一時障害として再試行
- 通信タイムアウト: 一時障害として再試行
- 入力更新検出: 古いジョブを無効化し、新しいジョブを開始

### 8.2 恒久エラー

次の場合は自動再試行せず`error`とする。

- 未対応ファイル形式
- 破損ファイル
- Instagramの長さ上限超過
- Driveアクセス権不足
- 変換結果の検証NG
- 予約時刻から30分以上経過しても変換未完了

### 8.3 ログ

J列の`error_log`へ以下を記録する。

- 行番号
- 投稿先とメディア列
- エラー概要
- 発生日時

Cloud Run operation名と変換フェーズは、再開に使う投稿ジョブ状態として
Script Propertiesへ保存する。

秘密情報、OAuthトークン、署名URL全体は記録しない。

## 9. セキュリティ

- Cloud Run Jobは専用サービスアカウントで実行する
- サービスアカウントには必要なDriveフォルダとGCSバケットだけを許可する
- GCSバケットを公開しない
- Apps ScriptからCloud Run Jobs APIをOAuthで呼び出す
- APIキーやサービスアカウント秘密鍵をApps Scriptへ保存しない
- 署名URLは短期間だけ有効にする
- Cloud Loggingへアクセストークンや署名URLを出力しない

## 10. 実装フェーズ

### Phase 0: 現行変更の扱い

- Cloudinary同期Fetchの試作変更は復元済み
- Cloudinary試作はデプロイしない
- 本計画の方式が動作確認できるまで本番Stories処理を変更しない

### Phase 1: Cloud Run検証

- FFmpegコンテナを作成
- 横長JPEGを1080×1920へ変換
- 横長MP4を1080×1920へ変換
- 出力メタデータを検証
- GCS署名URLから匿名取得できることを確認

### Phase 2: GCPリソース

- 専用Cloud Run Job
- 専用サービスアカウント
- 非公開Cloud Storageバケット
- Lifecycle Rule
- 必要最小限のIAM権限
- Cloud Logging

### Phase 3: Apps Script連携

- `prepareStories()`を追加
- 投稿ジョブへInstagram Stories変換状態を追加
- Cloud Run Job開始処理を追加
- 実行状態の確認処理を追加
- 署名URL期限の確認を追加
- `checkAndPost()`を変換状態対応に変更

### Phase 4: テスト

- 状態遷移の単体テスト
- 冪等キーの単体テスト
- Drive更新時の再変換テスト
- 一時障害の再試行テスト
- 画像・動画の実ファイル変換テスト
- Apps Scriptタイムアウト後の再開テスト
- Instagramテスト投稿

### Phase 5: 本番移行

1. テスト用アカウントで画像1件を投稿
2. テスト用アカウントで動画1件を投稿
3. 本番で画像1件をカナリア投稿
4. 本番で動画1件をカナリア投稿
5. 24時間監視
6. 全Stories投稿へ有効化

## 11. 受け入れ条件

- 横長画像の全体が表示される
- 横長動画の全体が表示される
- 余白が上下または左右へ均等に入る
- 9:16素材が不要に劣化しない
- タイムアウト後に変換を再開できる
- 同じ行を複数回実行しても二重投稿しない
- Driveファイル更新後に古い素材を投稿しない
- 変換失敗時に未加工素材を投稿しない
- 投稿後に変換結果が自動削除される
- ログへ秘密情報を出力しない

## 12. Cloudinary代替案

Cloud Runを構築せずCloudinaryを採用する場合は、次を必須とする。

- 投稿時刻の2時間前に変換を開始する
- 署名付きUpload APIを使用する
- Eager asynchronous transformationを使用する
- 変換完了をポーリングする
- 動画を契約プランのファイルサイズ上限以内に制限する
- Drive更新日時をCloudinary Public IDへ含める
- Strict Transformationsを有効化する
- 投稿後72時間で素材と派生変換を削除する
- クレジット使用量を監視する
- 70%到達時に警告、90%到達時に新規変換を停止する

署名なしFetchを投稿時刻に直接実行する現在の方式は採用しない。

## 13. 参考資料

- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Cloud Run jobs](https://cloud.google.com/run/docs/create-jobs)
- [Cloud Run job timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Cloudinary pricing](https://cloudinary.com/pricing)
- [Cloudinary upload guide](https://cloudinary.com/documentation/upload_images)
- [Cloudinary eager transformations](https://cloudinary.com/documentation/eager_and_incoming_transformations)
- [Cloudinary remote fetch](https://cloudinary.com/documentation/fetch_remote_images)
- [Google Cloud Transcoder API overview](https://docs.cloud.google.com/transcoder/docs/concepts/overview)
