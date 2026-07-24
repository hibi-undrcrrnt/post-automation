# Story Media Transformer

Google Driveの画像・動画をInstagram Stories用の1080×1920へ変換する
Cloud Run Jobです。

## 処理内容

- Drive APIで非公開ファイルを取得
- FFmpegで縦横比を維持したまま9:16へ余白付け
- 画像はJPEG、動画はH.264/AAC MP4へ正規化
- 動画のタイムコード・チャプター・データトラックを除去
- 非公開Cloud Storageへ保存
- V4署名URLと変換結果JSONを生成
- 同じ`STORY_JOB_ID`の再実行では既存出力を再利用

## 必要なAPI

- Cloud Run Admin API
- Cloud Build API
- Artifact Registry API
- Cloud Storage API
- IAM Service Account Credentials API
- Google Drive API

## 必要な変数

以下は例である。実際の値へ置き換えること。

```bash
PROJECT_ID="your-project-id"
REGION="asia-northeast1"
JOB_NAME="story-media-transformer"
BUCKET_NAME="${PROJECT_ID}-story-media"
SERVICE_ACCOUNT_NAME="story-media-transformer"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/story-media/transformer:latest"
APPS_SCRIPT_USER="user@example.com"
```

## 初期構築

### 1. APIを有効化

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  drive.googleapis.com \
  --project="${PROJECT_ID}"
```

### 2. Artifact Registryを作成

```bash
gcloud artifacts repositories create story-media \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}"
```

### 3. サービスアカウントとGCSバケットを作成

```bash
gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
  --display-name="Instagram Stories media transformer" \
  --project="${PROJECT_ID}"

gcloud storage buckets create "gs://${BUCKET_NAME}" \
  --location="${REGION}" \
  --uniform-bucket-level-access \
  --project="${PROJECT_ID}"

gcloud storage buckets update "gs://${BUCKET_NAME}" \
  --lifecycle-file=lifecycle.json

# 3日だけ保持する一時変換データのため、復元期間は設けない
gcloud storage buckets update "gs://${BUCKET_NAME}" \
  --clear-soft-delete
```

### 4. Cloud Runサービスアカウントへ権限を付与

出力バケットへ読み書きできるようにする。

```bash
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/storage.objectAdmin"
```

V4署名URLを生成するため、サービスアカウント自身へ
`iam.serviceAccounts.signBlob`を許可する。

```bash
gcloud iam service-accounts add-iam-policy-binding \
  "${SERVICE_ACCOUNT_EMAIL}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="${PROJECT_ID}"
```

サービスアカウント鍵ファイルは作成しない。

### 5. Drive入力フォルダを共有

Stories素材を置くGoogle Driveフォルダを
`SERVICE_ACCOUNT_EMAIL`へ閲覧者として共有する。

フォルダ外のファイルはCloud Run Jobから取得できないため、
入力素材は必ずこのフォルダ内へ置く。

### 6. コンテナをビルド

このディレクトリで実行する。

```bash
gcloud builds submit \
  --tag="${IMAGE}" \
  --project="${PROJECT_ID}"
```

### 7. Cloud Run Jobを作成

最大1GBの入力と変換中の出力を同時に保持できるよう、4GiBを割り当てる。

```bash
gcloud run jobs deploy "${JOB_NAME}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --service-account="${SERVICE_ACCOUNT_EMAIL}" \
  --cpu=2 \
  --memory=4Gi \
  --task-timeout=15m \
  --max-retries=2 \
  --set-env-vars="SERVICE_ACCOUNT_EMAIL=${SERVICE_ACCOUNT_EMAIL},SIGNED_URL_HOURS=30" \
  --project="${PROJECT_ID}"
```

## Apps Script実行ユーザーのIAM

Apps Scriptのインストール型トリガーを作成するユーザーへ、
次の権限を付与する。

- Cloud Run Jobs Executor With Overrides
- Cloud Run Viewer
- 対象バケットのStorage Object Viewer

```bash
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --region="${REGION}" \
  --member="user:${APPS_SCRIPT_USER}" \
  --role="roles/run.jobsExecutorWithOverrides" \
  --project="${PROJECT_ID}"

gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --region="${REGION}" \
  --member="user:${APPS_SCRIPT_USER}" \
  --role="roles/run.viewer" \
  --project="${PROJECT_ID}"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="user:${APPS_SCRIPT_USER}" \
  --role="roles/storage.objectViewer"
```

Apps Scriptは標準Google Cloudプロジェクトへ切り替え、
このCloud Run Jobと同じプロジェクトを利用する。

## Apps Script Properties

```text
STORY_TRANSFORM_MODE=legacy
STORY_TRANSFORM_PROJECT_ID=<PROJECT_ID>
STORY_TRANSFORM_REGION=asia-northeast1
STORY_TRANSFORM_JOB_NAME=story-media-transformer
STORY_TRANSFORM_BUCKET=<BUCKET_NAME>
STORY_TRANSFORM_BACKGROUND_COLOR=000000
STORY_TRANSFORM_LEAD_MINUTES=120
STORY_TRANSFORM_MAX_DELAY_MINUTES=30
```

`STORY_TRANSFORM_MODE`は次の3値を使用する。

- `legacy`: 従来どおり未変換で投稿する
- `enforce`: Storiesを必ず変換し、失敗時は投稿しない
- `pause`: Stories投稿を停止し、予約時刻に到達した対象行を`error`にする

Cloud RunとIAMの確認が完了するまでは`legacy`にしておく。
緊急停止時は`false`へ戻さず`pause`へ変更する。

設定後、Apps Scriptエディタから以下を順番に実行する。

1. `configureStoriesTransformForHibi()`で`legacy`設定と接続を確認
2. `prepareInstagramStoryFromSheetRow(rowNumber)`で変換だけを確認
3. `setStoriesTransformMode('enforce')`で有効化
4. `createStoriesTransformTrigger()`
5. 横長画像のテスト予約
6. 横長動画のテスト予約

緊急停止は`setStoriesTransformMode('pause')`、
従来動作へ戻す場合は`setStoriesTransformMode('legacy')`を使用する。

シート行を手動で進める場合は、
`postPreparedInstagramStoryFromSheetRow(rowNumber)`を繰り返し実行する。
初回は変換ジョブを開始し、変換完了後の実行でStoriesを投稿する。

`prepareInstagramStoryFromSheetRow(rowNumber)`は投稿を行わず、
過去・将来の予約日時ではなく実行時刻を基準に変換だけを検証する。

## Cloud Run Jobの実行時環境変数

Apps Scriptが実行ごとに次を上書きする。

```text
STORY_JOB_ID
DRIVE_FILE_ID
EXPECTED_SOURCE_MODIFIED_TIME
EXPECTED_SOURCE_SIZE
EXPECTED_SOURCE_MD5
MEDIA_KIND
BACKGROUND_COLOR
OUTPUT_BUCKET
OUTPUT_PREFIX
RESULT_OBJECT
```

静的設定としてJobへ設定する。

```text
SERVICE_ACCOUNT_EMAIL
SIGNED_URL_HOURS
```

## ローカルテスト

```bash
python3 -m unittest discover -s tests -v
```

FFmpegを含むコンテナの動作確認は、実ファイル用の環境変数と
Google Application Default Credentialsが必要になる。

## 更新

コード変更時は新しいイメージタグでビルドし、Cloud Run Jobを更新する。
ロールバックできるよう、`latest`だけでなくGit SHAタグも保持する。
