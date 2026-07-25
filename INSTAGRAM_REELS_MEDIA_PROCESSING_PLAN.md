# Instagram通常動画（Reels）正規化・非同期投稿計画

> 実装状況（2026-07-25）: 変換器、Apps Script連携、新Cloud Run Job、
> 行7の投稿なしGCP E2Eまで完了。現在は安全のため`legacy`既定。
> 次は新規テスト行によるReelsカナリア投稿。

## 1. 目的

Google Drive上の動画をInstagram通常投稿へ送る前に、
MetaのReels要件へ正規化し、コンテナ処理を非同期で管理する。

対象はシートの`instagram_post=TRUE`かつD列に動画がある行。
画像投稿、X投稿、Instagram Stories投稿は既存経路を維持する。

## 2. 行7の失敗分析

行7の`間に合わせ.mov`は、Instagramのメディアコンテナ作成後に
`status_code=ERROR`となった。

2026-07-25に元ファイルを`ffprobe`した結果は以下。

| 項目 | 値 |
| --- | --- |
| コンテナ | QuickTime MOV |
| 長さ | 56.192秒 |
| 解像度 | 1440×1080 |
| 映像 | H.264 High / yuv420p / 24fps / 約4.51Mbps |
| 音声 | AAC-LC / 48kHz / stereo / 約320kbps |
| 追加トラック | `TimeCodeHandler`データトラック |
| ファイルサイズ | 33,897,461 bytes |

Meta公式のReels Publishing仕様では、MOVまたはMP4、H.264またはHEVC、
AAC 48kHz、23〜60fps、横幅最大1920px、映像最大25Mbps、
音声128kbps、3秒〜15分、最大1GBが示されている。

行7は主要な映像要件を満たす。一方、次が不安定要因である。

- `TimeCodeHandler`データトラックが含まれる
- 音声ビットレートが約320kbps
- QuickTime固有のメタデータや配置をそのままMetaへ渡している
- Metaのエラー応答には原因詳細が含まれない

したがって、エラー原因はデータトラック、音声条件、またはMOVの
パッケージングにある可能性が高い。これは入力と公式要件からの推定であり、
Metaから個別原因が返されたものではない。

### 2.1 ローカル変換検証

既存Stories変換器のFFmpegプロファイルを行7へ適用し、
Reels正規化方式の実現性を確認した。

| 項目 | 変換後 |
| --- | --- |
| コンテナ | MP4 / fast start |
| 長さ | 56.148秒 |
| 解像度 | 1080×1920 |
| 映像 | H.264 High / yuv420p / 24fps / 約2.43Mbps |
| 音声 | AAC-LC / 48kHz / stereo / 約128.9kbps |
| トラック | 映像1本、音声1本 |
| ファイルサイズ | 17,987,520 bytes |

`TimeCodeHandler`を含むデータトラックは除去され、
Meta仕様内の出力を生成できた。実際のReelsコンテナ処理は
カナリア実装後に確認する。

## 3. 採用方式

### 3.1 Stories基盤を分離して再利用

Cloudinaryなど別サービスは追加せず、既存のGCP基盤を再利用する。
ただし、検証済みStories Jobへ直接変更を入れず、
新しいCloud Run Jobを並行構築する。

- Job名: `instagram-reel-transformer`
- リージョン: `asia-northeast1`
- サービスアカウント: 既存の変換用サービスアカウント
- GCSバケット: 既存の非公開一時バケット
- オブジェクト接頭辞: `instagram-reels/`
- 保持期間: 3日
- コンテナイメージ: Stories版から派生した別のimmutable digest

Cloud Run Jobにはアイドル料金がなく、分離による運用コスト増を抑えながら、
Storiesの安定版をロールバック先として維持できる。

### 3.2 Reels用の出力仕様

出力は常にMP4とし、Metaが処理しやすい保守的な形式へ揃える。

| 項目 | 出力 |
| --- | --- |
| キャンバス | 1080×1920（9:16） |
| 画面配置 | 縦横比を維持して中央配置、余白は黒 |
| 映像 | H.264 High Level 4.2 / yuv420p / progressive |
| フレームレート | 23〜60fps CFR。適合入力は維持 |
| 映像ビットレート | 最大10Mbps |
| 音声 | AAC-LC / 48kHz / stereo / 128kbps |
| コンテナ | MP4 |
| MP4配置 | `moov` atomを先頭へ移動（fast start） |
| トラック | 先頭の映像1本と音声1本だけ |
| 除去対象 | タイムコード、データ、字幕、チャプター、元メタデータ |

横長動画はクロップせず、全体を9:16キャンバス内へ表示する。
通常Instagram動画はAPI上`media_type=REELS`として投稿されるため、
フィード表示だけを狙った4:5より、Meta推奨の9:16を採用する。

FFmpegでは概ね次を行う。

```text
-map 0:v:0 -map 0:a:0?
-vf scale=1080:1920:force_original_aspect_ratio=decrease,
    pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1
-c:v libx264 -profile:v high -level 4.2 -pix_fmt yuv420p
-fps_mode cfr -maxrate 10M -bufsize 20M
-c:a aac -ar 48000 -ac 2 -b:a 128k
-map_metadata -1 -map_chapters -1 -dn
-movflags +faststart
```

## 4. 投稿フロー

### 4.1 事前変換

予約時刻の2時間前から、10分間隔の準備処理が対象行を確認する。

1. DriveファイルID、更新日時、サイズ、MD5を取得
2. 行内容と投稿先を含むフィンガープリントを生成
3. Cloud Run JobへReels変換を投入
4. 非公開GCSへMP4と結果manifestを保存
5. 署名URLをApps Scriptの保存ジョブへ保持

同じ入力と設定では同じ出力を再利用し、Drive差し替え時は再変換する。

### 4.2 Metaコンテナの事前準備

変換完了後、投稿前にMetaの`REELS`コンテナを作成する。

1. `POST /media`へ`media_type=REELS`、署名付き`video_url`、
   caption、`share_to_feed=true`を送信
2. コンテナIDを保存
3. 後続トリガーで`status_code`を取得
4. `FINISHED`になるまで投稿しない

現在のようにApps Script内で2.5秒ごとに最大60秒待つ方式は廃止する。
Meta公式はコンテナ状態のポーリングを推奨しているため、
トリガーをまたいで状態を保存する。

### 4.3 予定時刻の公開

予定時刻を過ぎ、コンテナが`FINISHED`の場合だけ
`POST /media_publish`を実行する。

- 成功後に`published`とメディアIDを保存
- シートを`posted`へ更新
- 通信断などで結果が曖昧なら`unknown`として自動再投稿を停止
- コンテナが準備中なら最大30分まで待機
- `ERROR`または`EXPIRED`なら原因情報を保存して`error`

X投稿には元のDrive動画を使い、Instagram用MP4を流用しない。

## 5. 状態モデル

保存ジョブへ`instagram.reel`を追加する。

```text
not_started
  -> submitted
  -> processing
  -> ready
  -> container_processing
  -> container_ready
  -> publishing
  -> published
```

例外状態は次のとおり。

- `error`: 既知の失敗。自動再試行上限後に停止
- `unknown`: 公開要求後の通信断など。二重投稿防止のため手動確認

Storiesの状態とは分離し、同じ行でStoriesとReelsが有効でも
それぞれの完了状態を保持する。

## 6. 設定と安全切替

Script Propertiesへ次を追加する。

```text
REEL_TRANSFORM_MODE=legacy
REEL_TRANSFORM_PROJECT_ID=hibi-452314
REEL_TRANSFORM_REGION=asia-northeast1
REEL_TRANSFORM_JOB_NAME=instagram-reel-transformer
REEL_TRANSFORM_BUCKET=hibi-452314-story-media
REEL_TRANSFORM_BACKGROUND_COLOR=000000
REEL_TRANSFORM_LEAD_MINUTES=120
REEL_TRANSFORM_MAX_DELAY_MINUTES=30
```

モードはStoriesと同じ考え方を使う。

- `legacy`: 現在の未変換投稿
- `canary`: 指定行だけ新方式
- `enforce`: 全Instagram動画投稿を新方式へ強制
- `pause`: Instagram動画投稿だけを停止

画像、Stories、XはReels用`pause`の影響を受けない。

## 7. ロールアウト

### Phase 1: 変換器

1. [完了] Reels用FFmpegプロファイルを実装
2. [完了] 行7の実ファイルでMP4を生成
3. [完了] `ffprobe`で映像・音声以外のトラックがないことを確認
4. [完了] 匿名Range GETとContent-Typeを確認

### Phase 2: Apps Script連携

1. [完了] `instagram.reel`状態管理を追加
2. [完了] Reels専用の事前変換トリガーを追加
3. [完了] Metaコンテナ処理を非同期化
4. [完了] `published` / `unknown`の二重投稿防止を追加

### Phase 3: カナリア

1. 行7はX投稿済みかつ`error`なので履歴として残す
2. 新しいテスト行へ行7の動画をコピーし、変換用共有フォルダへ配置
3. `x_post=FALSE`
4. `instagram_post=TRUE`
5. `instagram_stories=FALSE`
6. 変換だけを確認
7. Reelsへ1件投稿
8. 映像全体、音声、caption、フィード表示を実機確認
9. 24時間監視後に`enforce`

## 7.1 2026-07-25 デプロイ・E2E結果

- Cloud Run Job:
  `instagram-reel-transformer`（`asia-northeast1`）
- デプロイイメージdigest:
  `sha256:6ffa55667ae23c7a1e5f575614b87920b8866b9d9e92c3779e09d939e55dd27d`
- リソース: 2 CPU / 4GiB / timeout 30分 / max retries 2
- 既存`story-media-transformer`は`transformer:97bf7f2`のまま
- Apps Scriptへ`ReelsMedia.js`を含む5ファイルをpush済み
- Script Properties未設定時も`legacy`として動作し、既存投稿経路を維持

行7を新Jobへ直接投入した投稿なしE2E
`instagram-reel-transformer-w2vq2`は成功した。manifestは次の値を返した。

| 項目 | 結果 |
| --- | --- |
| status / target | `ready` / `reels` |
| output | `instagram-reels/output/row7-e2e-final-20260725.mp4` |
| 解像度 | 1080×1920 |
| 映像 | H.264 / yuv420p / 24fps CFR |
| 音声 | AAC / 48kHz / 2ch |
| 長さ | 56.148秒 |

このE2EではInstagram APIを呼んでおらず、Reels投稿は発生していない。

## 7.2 カナリア前の手動操作

`clasp run`はこのApps Scriptの実行権限構成では利用できないため、
Apps Scriptエディタから次を実行する。

1. `configureInstagramReelTransformForHibi()`
2. 必要なら`verifyInstagramReelTransformForHibi()`

   行7を変換するだけで、Metaコンテナ作成・投稿は行わない。
3. 新規カナリア行を1行だけ作成後、
   `startInstagramReelCanaryForHibi()`

   D列動画あり、X=FALSE、Instagram=TRUE、Stories=FALSE、
   終端status以外の行を自動選択する。
4. `prepareInstagramReels()`を実行し、変換・コンテナ準備を確認
5. 予約時刻に公開し、実機表示を確認

カナリア中の手動確認には次を使う。署名URLやアクセストークンは
ログへ出さない。

- `prepareInstagramReelCanaryForHibi()`:
  準備を1段階進め、行・phase・コンテナ状態をログ出力
- `inspectInstagramReelCanaryForHibi()`:
  外部処理を進めず、保存済み状態だけをログ出力

## 7.3 行10 実投稿カナリア結果

2026-07-25、行10を`REEL_TRANSFORM_MODE=canary`の対象として
実際にReelsへ1件投稿した。

| 確認項目 | 結果 |
| --- | --- |
| Cloud Run変換 | 成功 |
| Metaコンテナ | `FINISHED`確認後に公開 |
| Instagram公開 | 成功 |
| シートstatus | `posted` |
| error_log | 空欄 |
| 横長映像 | クロップなしで全体表示 |
| 音声 | 正常 |
| caption | 正常 |
| X / Stories誤投稿 | なし |

行7は既存の`error`履歴として維持し、再投稿していない。
これにより、変換、署名URL、非同期コンテナ準備、予約時刻公開、
シート完了処理までの本番E2Eが合格した。

次の切替候補は`enableInstagramReelTransformForHibi()`による
`enforce`である。切替後に問題があれば、投稿を止める場合は
`pauseInstagramReelTransformForHibi()`、従来経路へ戻す場合は
`useLegacyInstagramReelTransformForHibi()`を使う。

## 8. 受け入れ条件

- 行7のMOVからMeta処理可能なMP4を生成できる
- `TimeCodeHandler`を含むデータトラックが除去される
- 音声がAAC-LC、48kHz、stereo、128kbpsになる
- 横長映像がクロップされず全体表示される
- Metaコンテナを`FINISHED`確認前に公開しない
- Apps Scriptの実行時間を待機処理で浪費しない
- 同じ行を再実行しても二重投稿しない
- X投稿へ影響しない
- Storiesの検証済みJobへ影響しない
- 変換失敗時に元MOVをフォールバック投稿しない

## 9. 採用判断

Cloudinaryの追加は不要である。

既存GCP環境にはDrive取得、FFmpeg変換、GCS署名URL、manifest、
冪等化、IAM、Lifecycleが揃っている。新しいCloud Run Jobとして
分離すれば、Storiesの安定性を保ちつつ同じ運用モデルをReelsへ適用できる。

## 10. 参考資料

- Meta公式 Instagram Publish Content:
  https://www.postman.com/meta/instagram/folder/23987686-bc459e67-42aa-4ea0-ad25-e5a6e42c3a83
- Meta公式 Instagram API Reels Publishing:
  https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
- Meta公式 Create a video container:
  https://www.postman.com/meta/instagram/request/23987686-8d93f052-4c50-4cef-b23e-57732bf370f3
