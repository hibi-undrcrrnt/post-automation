// ====================
// Instagram Reels用動画事前変換・非同期コンテナ準備
// ====================
const REEL_TRANSFORM_VERSION = '1';
const REEL_TRANSFORM_RUN_ORIGIN = 'https://run.googleapis.com/v2/';
const REEL_TRANSFORM_GCS_ORIGIN =
  'https://storage.googleapis.com/storage/v1/';
const REEL_TRANSFORM_DEFAULT_LEAD_MINUTES = 120;
const REEL_TRANSFORM_DEFAULT_MAX_DELAY_MINUTES = 30;
const REEL_TRANSFORM_MIN_URL_REMAINING_MS = 60 * 60 * 1000;
const REEL_TRANSFORM_TRIGGER_MINUTES = 10;
const REEL_TRANSFORM_WIDTH = 1080;
const REEL_TRANSFORM_HEIGHT = 1920;

function getInstagramReelTransformConfig_(requireInfrastructureConfig) {
  const props = PropertiesService.getScriptProperties();
  const configuredMode = String(
    props.getProperty('REEL_TRANSFORM_MODE') || ''
  ).trim().toLowerCase();
  const mode = configuredMode || 'legacy';
  if (['legacy', 'canary', 'enforce', 'pause'].indexOf(mode) === -1) {
    throw new Error(
      'REEL_TRANSFORM_MODEはlegacy、canary、enforce、pauseの' +
      'いずれかで指定してください。'
    );
  }

  if (
    mode !== 'canary' &&
    mode !== 'enforce' &&
    !requireInfrastructureConfig
  ) {
    return {
      enabled: false,
      mode: mode,
      canaryRow: null,
    };
  }

  const config = {
    enabled: mode === 'canary' || mode === 'enforce',
    mode: mode,
    canaryRow: null,
    projectId: String(
      props.getProperty('REEL_TRANSFORM_PROJECT_ID') || ''
    ).trim(),
    region: String(
      props.getProperty('REEL_TRANSFORM_REGION') || ''
    ).trim(),
    jobName: String(
      props.getProperty('REEL_TRANSFORM_JOB_NAME') || ''
    ).trim(),
    bucket: String(
      props.getProperty('REEL_TRANSFORM_BUCKET') || ''
    ).trim(),
    backgroundColor: String(
      props.getProperty('REEL_TRANSFORM_BACKGROUND_COLOR') || '000000'
    ).replace(/^#/, '').trim().toLowerCase(),
    leadMinutes: parseStoryTransformInteger_(
      props.getProperty('REEL_TRANSFORM_LEAD_MINUTES'),
      REEL_TRANSFORM_DEFAULT_LEAD_MINUTES,
      10,
      24 * 60,
      'REEL_TRANSFORM_LEAD_MINUTES'
    ),
    maxDelayMinutes: parseStoryTransformInteger_(
      props.getProperty('REEL_TRANSFORM_MAX_DELAY_MINUTES'),
      REEL_TRANSFORM_DEFAULT_MAX_DELAY_MINUTES,
      10,
      24 * 60,
      'REEL_TRANSFORM_MAX_DELAY_MINUTES'
    ),
  };
  if (mode === 'canary') {
    config.canaryRow = parseStoryTransformInteger_(
      props.getProperty('REEL_TRANSFORM_CANARY_ROW'),
      0,
      2,
      1000000,
      'REEL_TRANSFORM_CANARY_ROW'
    );
  }

  const missing = [
    ['REEL_TRANSFORM_PROJECT_ID', config.projectId],
    ['REEL_TRANSFORM_REGION', config.region],
    ['REEL_TRANSFORM_JOB_NAME', config.jobName],
    ['REEL_TRANSFORM_BUCKET', config.bucket],
  ].filter(item => !item[1]).map(item => item[0]);
  if (missing.length > 0) {
    throw new Error(
      'Reels変換用Script Propertiesが不足しています: ' +
      missing.join(', ')
    );
  }
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.projectId)) {
    throw new Error('REEL_TRANSFORM_PROJECT_IDの形式が不正です。');
  }
  if (!/^[a-z][a-z0-9-]+$/.test(config.region)) {
    throw new Error('REEL_TRANSFORM_REGIONの形式が不正です。');
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.jobName)) {
    throw new Error('REEL_TRANSFORM_JOB_NAMEの形式が不正です。');
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)) {
    throw new Error('REEL_TRANSFORM_BUCKETの形式が不正です。');
  }
  if (!/^[0-9a-f]{6}$/.test(config.backgroundColor)) {
    throw new Error(
      'REEL_TRANSFORM_BACKGROUND_COLORは6桁の16進色で指定してください。'
    );
  }
  return config;
}

function isInstagramReelTransformEnabledForRow_(config, rowNumber) {
  if (!config.enabled) return false;
  return (
    config.mode !== 'canary' ||
    Number(rowNumber) === config.canaryRow
  );
}

function configureInstagramReelTransformForHibi() {
  PropertiesService.getScriptProperties().setProperties(
    {
      REEL_TRANSFORM_MODE: 'legacy',
      REEL_TRANSFORM_PROJECT_ID: 'hibi-452314',
      REEL_TRANSFORM_REGION: 'asia-northeast1',
      REEL_TRANSFORM_JOB_NAME: 'instagram-reel-transformer',
      REEL_TRANSFORM_BUCKET: 'hibi-452314-story-media',
      REEL_TRANSFORM_BACKGROUND_COLOR: '000000',
      REEL_TRANSFORM_LEAD_MINUTES: '120',
      REEL_TRANSFORM_MAX_DELAY_MINUTES: '30',
    },
    false
  );
  return checkInstagramReelTransformSetup();
}

function setInstagramReelTransformMode(mode) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (
    ['legacy', 'canary', 'enforce', 'pause']
      .indexOf(normalizedMode) === -1
  ) {
    throw new Error(
      'Reels変換モードはlegacy、canary、enforce、pauseの' +
      'いずれかで指定してください。'
    );
  }
  PropertiesService
    .getScriptProperties()
    .setProperty('REEL_TRANSFORM_MODE', normalizedMode);
  return {
    mode: normalizedMode,
    enabled:
      normalizedMode === 'canary' ||
      normalizedMode === 'enforce',
  };
}

function setInstagramReelTransformCanaryRow_(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  PropertiesService.getScriptProperties().setProperties(
    {
      REEL_TRANSFORM_CANARY_ROW: String(targetRow),
      REEL_TRANSFORM_MODE: 'canary',
    },
    false
  );
  return {
    mode: 'canary',
    enabled: true,
    canaryRow: targetRow,
  };
}

function startInstagramReelCanaryForSheetRow_(rowNumber) {
  checkInstagramReelTransformSetup();
  createInstagramReelTransformTrigger();
  const result = setInstagramReelTransformCanaryRow_(rowNumber);
  Logger.log(JSON.stringify(result));
  return result;
}

function findInstagramReelCanaryRow_() {
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    throw new Error('Reelsカナリア候補行がありません。');
  }
  validatePostTargetColumns_(data[0]);
  const candidates = [];
  for (let index = 1; index < data.length; index++) {
    const row = data[index];
    const status = String(row[4] || '');
    if (
      row[0] &&
      String(row[3] || '').trim() &&
      isPostTargetEnabled_(row[7]) &&
      !isPostTargetEnabled_(row[6]) &&
      !isPostTargetEnabled_(row[8]) &&
      status !== POST_STATUS.POSTED &&
      status !== POST_STATUS.ERROR &&
      status !== POST_STATUS.UNKNOWN
    ) {
      candidates.push(index + 1);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      'Reelsカナリア候補は1行だけ必要です。' +
      '条件はD列動画あり、X=FALSE、Instagram=TRUE、Stories=FALSE、' +
      '終端status以外です。候補=' +
      (candidates.join(',') || 'なし')
    );
  }
  return candidates[0];
}

function startInstagramReelCanaryForHibi() {
  return startInstagramReelCanaryForSheetRow_(
    findInstagramReelCanaryRow_()
  );
}

function enableInstagramReelTransformForHibi() {
  return setInstagramReelTransformMode('enforce');
}

function pauseInstagramReelTransformForHibi() {
  return setInstagramReelTransformMode('pause');
}

function useLegacyInstagramReelTransformForHibi() {
  return setInstagramReelTransformMode('legacy');
}

function createInstagramReelsPausedError_() {
  const error = new Error(
    'Instagram Reels投稿はREEL_TRANSFORM_MODE=pauseにより停止中です。'
  );
  error.retryable = false;
  return error;
}

function getInstagramReelDriveMetadata_(mediaUrl) {
  const fileId = extractDriveFileId_(mediaUrl);
  const fields = [
    'id',
    'name',
    'mimeType',
    'size',
    'modifiedTime',
    'md5Checksum',
    'capabilities(canDownload)',
    'videoMediaMetadata(durationMillis,width,height)',
  ].join(',');
  const url =
    DRIVE_FILES_API_URL + encodeURIComponent(fileId) +
    '?supportsAllDrives=true&fields=' + encodeURIComponent(fields);
  const response = fetchWithContext_(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    muteHttpExceptions: true,
  }, 'Reels Drive metadata', true);
  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Reels Drive metadata', response);
  }

  const result = parseJsonResponse_(response, 'Reels Drive metadata');
  const totalBytes = Number(result.size);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error(
      'Reels素材のファイルサイズを取得できません: ' +
      String(result.size)
    );
  }
  if (totalBytes > INSTAGRAM_MAX_VIDEO_BYTES) {
    throw new Error(
      'Reels動画サイズが1GB上限を超えています: ' +
      (totalBytes / 1024 / 1024).toFixed(2) + 'MB'
    );
  }
  if (
    result.capabilities &&
    result.capabilities.canDownload === false
  ) {
    throw new Error('Reels素材はDriveからダウンロードできません。');
  }
  const mimeType = String(result.mimeType || '').toLowerCase();
  if (['video/mp4', 'video/quicktime'].indexOf(mimeType) === -1) {
    throw new Error(
      'Reels変換で未対応のMIMEタイプです: ' +
      (mimeType || '不明')
    );
  }
  const videoMetadata = result.videoMediaMetadata || {};
  const durationMillis = Number(videoMetadata.durationMillis);
  if (
    !Number.isFinite(durationMillis) ||
    durationMillis < INSTAGRAM_REEL_MIN_VIDEO_SECONDS * 1000 ||
    durationMillis > INSTAGRAM_REEL_MAX_VIDEO_SECONDS * 1000
  ) {
    throw new Error(
      'Reels動画は3秒以上15分以内である必要があります: ' +
      String(videoMetadata.durationMillis)
    );
  }
  return {
    fileId: String(result.id || fileId),
    fileName: String(result.name || fileId),
    mimeType: mimeType,
    totalBytes: totalBytes,
    modifiedTime: String(result.modifiedTime || ''),
    md5Checksum: String(result.md5Checksum || '').toLowerCase(),
    width: videoMetadata.width != null
      ? Number(videoMetadata.width)
      : null,
    height: videoMetadata.height != null
      ? Number(videoMetadata.height)
      : null,
    durationMillis: durationMillis,
  };
}

function buildInstagramReelTransformFingerprint_(metadata, config) {
  const source = JSON.stringify({
    version: REEL_TRANSFORM_VERSION,
    target: 'reels',
    fileId: metadata.fileId,
    modifiedTime: metadata.modifiedTime,
    totalBytes: metadata.totalBytes,
    md5Checksum: metadata.md5Checksum,
    backgroundColor: config.backgroundColor,
  });
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    source,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function createInstagramReelTransformState_(
  metadata,
  scheduledAt,
  fingerprint
) {
  return {
    phase: 'not_started',
    fingerprint: fingerprint,
    sourceFileId: metadata.fileId,
    sourceFileName: metadata.fileName,
    sourceMimeType: metadata.mimeType,
    sourceModifiedTime: metadata.modifiedTime,
    sourceSize: metadata.totalBytes,
    sourceMd5Checksum: metadata.md5Checksum,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    sourceDurationMillis: metadata.durationMillis,
    scheduledAt: new Date(scheduledAt).toISOString(),
    transformVersion: REEL_TRANSFORM_VERSION,
    operationName: '',
    resultObject: 'instagram-reels/results/' + fingerprint + '.json',
    outputObject: '',
    outputUrl: '',
    outputUrlExpiresAt: '',
    containerId: '',
    containerCreatedAt: '',
    containerStatus: '',
    mediaId: '',
    startedAt: '',
    completedAt: '',
    attempts: 0,
    lastError: '',
  };
}

function ensureInstagramReelTransformState_(
  job,
  metadata,
  scheduledAt,
  config
) {
  if (!job.instagram) job.instagram = {};
  const fingerprint = buildInstagramReelTransformFingerprint_(
    metadata,
    config
  );
  const current = job.instagram.reel;
  if (current && current.fingerprint === fingerprint) {
    return current;
  }
  if (
    current &&
    current.fingerprint !== fingerprint &&
    (job.completedTargets || []).length > 0
  ) {
    const error = new Error(
      '他の投稿先が完了した後にReels素材が更新されました。' +
      '投稿内容の不一致を防ぐため手動確認してください。'
    );
    error.retryable = false;
    throw error;
  }
  job.instagram.reel = createInstagramReelTransformState_(
    metadata,
    scheduledAt,
    fingerprint
  );
  return job.instagram.reel;
}

function getInstagramReelRunJobUrl_(config) {
  return (
    REEL_TRANSFORM_RUN_ORIGIN +
    'projects/' + encodeURIComponent(config.projectId) +
    '/locations/' + encodeURIComponent(config.region) +
    '/jobs/' + encodeURIComponent(config.jobName)
  );
}

function invokeInstagramReelTransformJob_(state, config) {
  const environment = {
    MEDIA_JOB_ID: state.fingerprint,
    MEDIA_TARGET: 'reels',
    DRIVE_FILE_ID: state.sourceFileId,
    EXPECTED_SOURCE_MODIFIED_TIME: state.sourceModifiedTime,
    EXPECTED_SOURCE_SIZE: state.sourceSize,
    EXPECTED_SOURCE_MD5: state.sourceMd5Checksum,
    MEDIA_KIND: 'video',
    BACKGROUND_COLOR: config.backgroundColor,
    OUTPUT_BUCKET: config.bucket,
    OUTPUT_PREFIX: 'instagram-reels/output',
    RESULT_OBJECT: state.resultObject,
  };
  const env = Object.keys(environment).map(name => ({
    name: name,
    value: String(environment[name]),
  }));
  const response = fetchWithContext_(
    getInstagramReelRunJobUrl_(config) + ':run',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      },
      payload: JSON.stringify({
        overrides: {
          containerOverrides: [{ env: env }],
          taskCount: 1,
          timeout: '1800s',
        },
      }),
      muteHttpExceptions: true,
    },
    'Reels Cloud Run Job start',
    true
  );
  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Reels Cloud Run Job start', response);
  }
  const result = parseJsonResponse_(
    response,
    'Reels Cloud Run Job start'
  );
  if (!result.name) {
    throw new Error('Cloud Run Jobs APIからoperation名を取得できません。');
  }
  return String(result.name);
}

function readInstagramReelTransformManifest_(state, config) {
  const url =
    REEL_TRANSFORM_GCS_ORIGIN +
    'b/' + encodeURIComponent(config.bucket) +
    '/o/' + encodeURIComponent(state.resultObject) +
    '?alt=media';
  const response = fetchWithContext_(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    muteHttpExceptions: true,
  }, 'Reels transform manifest', true);
  const statusCode = response.getResponseCode();
  if (statusCode === 404) return null;
  if (statusCode !== 200) {
    throw createHttpError_('Reels transform manifest', response);
  }
  return parseJsonResponse_(response, 'Reels transform manifest');
}

function getInstagramReelRunOperation_(operationName) {
  if (!operationName) return null;
  const response = fetchWithContext_(
    REEL_TRANSFORM_RUN_ORIGIN + operationName,
    {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      },
      muteHttpExceptions: true,
    },
    'Reels Cloud Run operation',
    true
  );
  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Reels Cloud Run operation', response);
  }
  return parseJsonResponse_(response, 'Reels Cloud Run operation');
}

function createInstagramReelPreparationError_(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

function applyReadyInstagramReelManifest_(state, manifest) {
  if (manifest.job_id !== state.fingerprint) {
    throw new Error('Reels変換結果のジョブIDが一致しません。');
  }
  if (String(manifest.media_target || '') !== 'reels') {
    throw new Error('Reels変換結果のmedia_targetが一致しません。');
  }
  if (String(manifest.source_file_id || '') !== state.sourceFileId) {
    throw new Error('Reels変換結果のDriveファイルIDが一致しません。');
  }
  if (
    String(manifest.source_modified_time || '') !==
    state.sourceModifiedTime
  ) {
    throw new Error('Reels変換結果のDrive更新日時が一致しません。');
  }
  if (Number(manifest.source_size) !== Number(state.sourceSize)) {
    throw new Error('Reels変換結果のDriveファイルサイズが一致しません。');
  }
  if (
    state.sourceMd5Checksum &&
    String(manifest.source_md5_checksum || '').toLowerCase() !==
      state.sourceMd5Checksum
  ) {
    throw new Error('Reels変換結果のDriveチェックサムが一致しません。');
  }
  if (
    Number(manifest.width) !== REEL_TRANSFORM_WIDTH ||
    Number(manifest.height) !== REEL_TRANSFORM_HEIGHT
  ) {
    throw new Error(
      'Reels変換結果が1080x1920ではありません: ' +
      manifest.width + 'x' + manifest.height
    );
  }
  if (String(manifest.content_type || '') !== 'video/mp4') {
    throw new Error(
      'Reels変換結果のContent-Typeが不正です: ' +
      String(manifest.content_type || '')
    );
  }
  const durationSeconds = Number(manifest.duration_seconds);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < INSTAGRAM_REEL_MIN_VIDEO_SECONDS ||
    durationSeconds > INSTAGRAM_REEL_MAX_VIDEO_SECONDS
  ) {
    throw new Error(
      'Reels変換結果の動画時間が不正です: ' +
      String(manifest.duration_seconds)
    );
  }
  const expiresAt = new Date(manifest.output_url_expires_at).getTime();
  if (!manifest.output_url || !Number.isFinite(expiresAt)) {
    throw new Error('Reels変換結果に有効な署名URLがありません。');
  }
  state.phase = 'ready';
  state.outputObject = String(manifest.output_object || '');
  state.outputUrl = String(manifest.output_url);
  state.outputUrlExpiresAt = new Date(expiresAt).toISOString();
  state.completedAt = String(
    manifest.completed_at || new Date().toISOString()
  );
  state.lastError = '';
}

function isInstagramReelOutputUrlUsable_(state, scheduledAt) {
  if (!state.outputUrl) return false;
  const usablePhases = [
    'ready',
    'container_processing',
    'container_ready',
    'publishing',
    'published',
  ];
  if (usablePhases.indexOf(state.phase) === -1) return false;
  if (state.containerId) return true;
  const expiresAt = new Date(state.outputUrlExpiresAt).getTime();
  const requiredUntil = Math.max(
    Date.now(),
    new Date(scheduledAt).getTime()
  ) + REEL_TRANSFORM_MIN_URL_REMAINING_MS;
  return Number.isFinite(expiresAt) && expiresAt > requiredUntil;
}

function assertInstagramReelPreparationWithinDelay_(state, config) {
  const scheduledAt = new Date(state.scheduledAt).getTime();
  if (
    Number.isFinite(scheduledAt) &&
    Date.now() >
      scheduledAt + config.maxDelayMinutes * 60 * 1000
  ) {
    throw createInstagramReelPreparationError_(
      'Reels準備が予約時刻から' +
      config.maxDelayMinutes + '分以内に完了しませんでした。'
    );
  }
}

function advanceInstagramReelTransform_(
  job,
  mediaUrl,
  scheduledAt,
  deadlineMs,
  providedConfig
) {
  const config =
    providedConfig || getInstagramReelTransformConfig_();
  if (config.mode === 'pause') {
    throw createInstagramReelsPausedError_();
  }
  if (!isInstagramReelTransformEnabledForRow_(config, job.rowNumber)) {
    return {
      completed: true,
      mediaUrl: mediaUrl,
      transformed: false,
    };
  }

  const metadata = getInstagramReelDriveMetadata_(mediaUrl);
  const state = ensureInstagramReelTransformState_(
    job,
    metadata,
    scheduledAt,
    config
  );
  if (state.phase === 'publishing') {
    state.phase = 'unknown';
    state.lastError =
      'Instagram Reels公開中に実行が中断され、結果を確認できません。';
    savePostJob_(job);
  }
  if (state.phase === 'unknown') {
    throw createInstagramReelPreparationError_(
      state.lastError ||
      'Instagram Reelsの投稿結果が不明です。手動確認してください。'
    );
  }
  if (state.phase === 'published') {
    return {
      completed: true,
      mediaUrl: state.outputUrl,
      transformed: true,
      alreadyPublished: true,
    };
  }
  if (state.phase === 'error') {
    throw createInstagramReelPreparationError_(
      'Reels準備に失敗しました: ' +
      (state.lastError || 'stored error')
    );
  }
  if (isInstagramReelOutputUrlUsable_(state, scheduledAt)) {
    return {
      completed: true,
      mediaUrl: state.outputUrl,
      transformed: true,
    };
  }
  if (state.phase === 'ready') {
    state.phase = 'not_started';
    state.operationName = '';
    state.outputUrl = '';
    state.outputUrlExpiresAt = '';
    savePostJob_(job);
  }

  if (
    (state.phase === 'submitted' || state.phase === 'processing') &&
    hasRequestTime_(deadlineMs)
  ) {
    const manifest = readInstagramReelTransformManifest_(
      state,
      config
    );
    if (manifest && manifest.status === 'ready') {
      applyReadyInstagramReelManifest_(state, manifest);
      savePostJob_(job);
      return {
        completed: true,
        mediaUrl: state.outputUrl,
        transformed: true,
      };
    }
    let operation = null;
    if (manifest && manifest.status === 'error') {
      state.lastError = String(
        manifest.error || manifest.error_type || 'unknown error'
      );
      operation = state.operationName
        ? getInstagramReelRunOperation_(state.operationName)
        : null;
      if (!operation || operation.done !== true) {
        state.phase = 'processing';
        savePostJob_(job);
      } else {
        state.phase = 'error';
        savePostJob_(job);
        throw createInstagramReelPreparationError_(
          'Reelsメディア変換に失敗しました: ' + state.lastError
        );
      }
    }
    if (manifest && manifest.status === 'processing') {
      state.phase = 'processing';
      savePostJob_(job);
    } else if (state.operationName && !operation) {
      operation = getInstagramReelRunOperation_(state.operationName);
      if (operation && operation.done && operation.error) {
        state.phase = 'error';
        state.lastError = String(
          operation.error.message || JSON.stringify(operation.error)
        ).slice(0, 1000);
        savePostJob_(job);
        throw createInstagramReelPreparationError_(
          'Reelsメディア変換に失敗しました: ' + state.lastError
        );
      }
    }
  }

  assertInstagramReelPreparationWithinDelay_(state, config);
  if (state.phase === 'not_started' && hasRequestTime_(deadlineMs)) {
    state.operationName = invokeInstagramReelTransformJob_(
      state,
      config
    );
    state.phase = 'submitted';
    state.startedAt = new Date().toISOString();
    state.attempts += 1;
    state.lastError = '';
    savePostJob_(job);
  }
  return {
    completed: false,
    status: POST_STATUS.PROCESSING,
    transformed: true,
  };
}

function advanceInstagramReelPreparation_(
  job,
  mediaUrl,
  caption,
  scheduledAt,
  deadlineMs,
  providedConfig
) {
  const config =
    providedConfig || getInstagramReelTransformConfig_();
  const transform = advanceInstagramReelTransform_(
    job,
    mediaUrl,
    scheduledAt,
    deadlineMs,
    config
  );
  if (!transform.completed || !transform.transformed) return transform;
  if (transform.alreadyPublished) return transform;

  const state = job.instagram.reel;
  const instagramConfig = getInstagramConfig_();
  if (state.phase === 'ready' && hasRequestTime_(deadlineMs)) {
    assertPublicInstagramVideoUrl_(state.outputUrl);
    state.containerId = createInstagramVideoContainer_(
      state.outputUrl,
      caption,
      instagramConfig
    );
    state.containerCreatedAt = new Date().toISOString();
    state.containerStatus = 'IN_PROGRESS';
    state.phase = 'container_processing';
    state.lastError = '';
    savePostJob_(job);
  }
  if (
    state.phase === 'container_processing' &&
    hasRequestTime_(deadlineMs)
  ) {
    const container = getInstagramContainerStatus_(
      state.containerId,
      instagramConfig
    );
    state.containerStatus = String(container.status_code || '');
    if (state.containerStatus === 'FINISHED') {
      state.phase = 'container_ready';
      state.lastError = '';
      savePostJob_(job);
    } else if (state.containerStatus === 'PUBLISHED') {
      state.phase = 'published';
      savePostJob_(job);
      return {
        completed: true,
        transformed: true,
        alreadyPublished: true,
        mediaUrl: state.outputUrl,
        containerId: state.containerId,
      };
    } else if (
      state.containerStatus === 'ERROR' ||
      state.containerStatus === 'EXPIRED'
    ) {
      state.phase = 'error';
      state.lastError =
        String(container.status || state.containerStatus) +
        ' (containerId=' + state.containerId + ')';
      savePostJob_(job);
      throw createInstagramReelPreparationError_(
        'Instagram Reelsコンテナ処理に失敗しました: ' +
        state.lastError
      );
    } else {
      savePostJob_(job);
    }
  }
  if (state.phase === 'container_ready') {
    return {
      completed: true,
      transformed: true,
      mediaUrl: state.outputUrl,
      containerId: state.containerId,
    };
  }
  assertInstagramReelPreparationWithinDelay_(state, config);
  return {
    completed: false,
    status: POST_STATUS.PROCESSING,
    transformed: true,
  };
}

function getOrCreateInstagramReelPreparationJob_(
  row,
  rowNumber,
  enabledTargets
) {
  return getOrCreateStoriesPreparationJob_(
    row,
    rowNumber,
    enabledTargets
  );
}

function prepareInstagramReels() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log(
      'prepareInstagramReels skipped: another execution is running.'
    );
    return;
  }
  try {
    prepareInstagramReelsLocked_();
  } finally {
    lock.releaseLock();
  }
}

function prepareInstagramReelsLocked_() {
  const config = getInstagramReelTransformConfig_();
  if (!config.enabled) {
    Logger.log(
      'prepareInstagramReels skipped: REEL_TRANSFORM_MODE=' +
      config.mode
    );
    return;
  }
  const deadlineMs = Date.now() + EXECUTION_BUDGET_MS;
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return;
  validatePostTargetColumns_(data[0]);

  const now = Date.now();
  const horizon = now + config.leadMinutes * 60 * 1000;
  const earliest =
    now - config.maxDelayMinutes * 60 * 1000;
  for (let index = 1; index < data.length; index++) {
    if (!hasRequestTime_(deadlineMs)) break;
    const row = data[index];
    const status = String(row[4] || '');
    if (
      !row[0] ||
      status === POST_STATUS.POSTED ||
      status === POST_STATUS.ERROR ||
      status === POST_STATUS.UNKNOWN ||
      !isPostTargetEnabled_(row[7]) ||
      !String(row[3] || '').trim()
    ) {
      continue;
    }
    const scheduledAt = new Date(row[0]);
    const scheduledTime = scheduledAt.getTime();
    if (
      !Number.isFinite(scheduledTime) ||
      scheduledTime < earliest ||
      scheduledTime > horizon ||
      !isInstagramReelTransformEnabledForRow_(config, index + 1)
    ) {
      continue;
    }
    try {
      const enabledTargets = getEnabledPostTargets_(row);
      const job = getOrCreateInstagramReelPreparationJob_(
        row,
        index + 1,
        enabledTargets
      );
      advanceInstagramReelPreparation_(
        job,
        String(row[3]).trim(),
        String(row[1] || ''),
        scheduledAt,
        deadlineMs,
        config
      );
    } catch (error) {
      Logger.log(
        'Reels preparation failed. Row ' + (index + 1) + ': ' +
        (error && error.message ? error.message : String(error))
      );
    }
  }
}

function prepareInstagramReelFromSheetRow(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const config = getInstagramReelTransformConfig_(true);
  config.enabled = true;
  config.mode = 'enforce';
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }
  const row = sheet.getRange(targetRow, 1, 1, 9).getValues()[0];
  if (!isPostTargetEnabled_(row[7])) {
    throw new Error(
      'Row ' + targetRow + 'はinstagram_postが有効ではありません。'
    );
  }
  const video = String(row[3] || '').trim();
  if (!video) {
    throw new Error(
      'Row ' + targetRow + 'のD列動画がありません。'
    );
  }
  const enabledTargets = getEnabledPostTargets_(row);
  const job = getOrCreateInstagramReelPreparationJob_(
    row,
    targetRow,
    enabledTargets
  );
  const result = advanceInstagramReelTransform_(
    job,
    video,
    new Date(),
    Date.now() + EXECUTION_BUDGET_MS,
    config
  );
  return {
    rowNumber: targetRow,
    completed: result.completed,
    phase: job.instagram.reel.phase,
    outputObject: job.instagram.reel.outputObject || '',
    containerCreated: Boolean(job.instagram.reel.containerId),
  };
}

function verifyInstagramReelTransformForHibi() {
  const result = {
    setup: checkInstagramReelTransformSetup(),
    row7: prepareInstagramReelFromSheetRow(7),
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function inspectInstagramReelCanaryForHibi() {
  const config = getInstagramReelTransformConfig_();
  if (
    config.mode !== 'canary' ||
    !Number.isInteger(config.canaryRow)
  ) {
    throw new Error('Reelsカナリア行が設定されていません。');
  }
  const job = loadPostJob_(config.canaryRow);
  const state = job && job.instagram && job.instagram.reel;
  const result = {
    mode: config.mode,
    canaryRow: config.canaryRow,
    jobFound: Boolean(job),
    phase: state ? state.phase : 'not_started',
    outputObject: state ? (state.outputObject || '') : '',
    containerCreated: Boolean(state && state.containerId),
    containerStatus: state ? (state.containerStatus || '') : '',
    published: Boolean(state && state.phase === 'published'),
    lastError: state ? (state.lastError || '') : '',
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function prepareInstagramReelCanaryForHibi() {
  const config = getInstagramReelTransformConfig_();
  if (
    config.mode !== 'canary' ||
    !Number.isInteger(config.canaryRow)
  ) {
    throw new Error('Reelsカナリア行が設定されていません。');
  }
  prepareInstagramReels();
  return inspectInstagramReelCanaryForHibi();
}

function createInstagramReelTransformTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(
    trigger =>
      trigger.getHandlerFunction() === 'prepareInstagramReels'
  );
  if (exists) {
    Logger.log('prepareInstagramReels trigger already exists.');
    return;
  }
  ScriptApp.newTrigger('prepareInstagramReels')
    .timeBased()
    .everyMinutes(REEL_TRANSFORM_TRIGGER_MINUTES)
    .create();
  Logger.log('prepareInstagramReels trigger created.');
}

function deleteInstagramReelTransformTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(
      trigger =>
        trigger.getHandlerFunction() === 'prepareInstagramReels'
    )
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  Logger.log('prepareInstagramReels triggers deleted.');
}

function checkInstagramReelTransformSetup() {
  const config = getInstagramReelTransformConfig_(true);
  const authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  const jobResponse = fetchWithContext_(
    getInstagramReelRunJobUrl_(config),
    {
      method: 'get',
      headers: { Authorization: authorization },
      muteHttpExceptions: true,
    },
    'Reels Cloud Run setup check',
    true
  );
  if (jobResponse.getResponseCode() !== 200) {
    throw createHttpError_(
      'Reels Cloud Run setup check',
      jobResponse
    );
  }
  const bucketUrl =
    REEL_TRANSFORM_GCS_ORIGIN +
    'b/' + encodeURIComponent(config.bucket) +
    '/o?prefix=' + encodeURIComponent('instagram-reels/') +
    '&maxResults=1';
  const bucketResponse = fetchWithContext_(bucketUrl, {
    method: 'get',
    headers: { Authorization: authorization },
    muteHttpExceptions: true,
  }, 'Reels GCS setup check', true);
  if (bucketResponse.getResponseCode() !== 200) {
    throw createHttpError_(
      'Reels GCS setup check',
      bucketResponse
    );
  }
  return {
    enabled: config.enabled,
    mode: config.mode,
    canaryRow: config.canaryRow,
    projectId: config.projectId,
    region: config.region,
    jobName: config.jobName,
    bucket: config.bucket,
    backgroundColor: config.backgroundColor,
    leadMinutes: config.leadMinutes,
    maxDelayMinutes: config.maxDelayMinutes,
  };
}
