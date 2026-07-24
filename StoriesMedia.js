// ====================
// Instagram Stories用メディア事前変換
// ====================
const STORY_TRANSFORM_VERSION = '1';
const STORY_TRANSFORM_RUN_ORIGIN = 'https://run.googleapis.com/v2/';
const STORY_TRANSFORM_GCS_ORIGIN =
  'https://storage.googleapis.com/storage/v1/';
const STORY_TRANSFORM_DEFAULT_LEAD_MINUTES = 120;
const STORY_TRANSFORM_DEFAULT_MAX_DELAY_MINUTES = 30;
const STORY_TRANSFORM_MIN_URL_REMAINING_MS = 60 * 60 * 1000;
const STORY_TRANSFORM_TRIGGER_MINUTES = 10;
const STORY_TRANSFORM_WIDTH = 1080;
const STORY_TRANSFORM_HEIGHT = 1920;

function parseStoryTransformInteger_(value, fallback, minimum, maximum, name) {
  const number = value == null || value === ''
    ? fallback
    : Number(value);
  if (
    !Number.isInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new Error(
      name + 'は' + minimum + '〜' + maximum + 'の整数で指定してください。'
    );
  }
  return number;
}

function getStoriesTransformConfig_(requireInfrastructureConfig) {
  const props = PropertiesService.getScriptProperties();
  const legacyEnabled =
    String(props.getProperty('STORY_TRANSFORM_ENABLED') || '')
      .trim()
      .toLowerCase() === 'true';
  const configuredMode = String(
    props.getProperty('STORY_TRANSFORM_MODE') || ''
  ).trim().toLowerCase();
  const mode = configuredMode || (
    legacyEnabled ? 'enforce' : 'legacy'
  );
  if (['legacy', 'enforce', 'pause'].indexOf(mode) === -1) {
    throw new Error(
      'STORY_TRANSFORM_MODEはlegacy、enforce、pauseのいずれかで指定してください。'
    );
  }

  if (mode !== 'enforce' && !requireInfrastructureConfig) {
    return {
      enabled: false,
      mode: mode,
    };
  }

  const config = {
    enabled: mode === 'enforce',
    mode: mode,
    projectId: String(
      props.getProperty('STORY_TRANSFORM_PROJECT_ID') || ''
    ).trim(),
    region: String(
      props.getProperty('STORY_TRANSFORM_REGION') || ''
    ).trim(),
    jobName: String(
      props.getProperty('STORY_TRANSFORM_JOB_NAME') || ''
    ).trim(),
    bucket: String(
      props.getProperty('STORY_TRANSFORM_BUCKET') || ''
    ).trim(),
    backgroundColor: String(
      props.getProperty('STORY_TRANSFORM_BACKGROUND_COLOR') || '000000'
    ).replace(/^#/, '').trim().toLowerCase(),
    leadMinutes: parseStoryTransformInteger_(
      props.getProperty('STORY_TRANSFORM_LEAD_MINUTES'),
      STORY_TRANSFORM_DEFAULT_LEAD_MINUTES,
      10,
      24 * 60,
      'STORY_TRANSFORM_LEAD_MINUTES'
    ),
    maxDelayMinutes: parseStoryTransformInteger_(
      props.getProperty('STORY_TRANSFORM_MAX_DELAY_MINUTES'),
      STORY_TRANSFORM_DEFAULT_MAX_DELAY_MINUTES,
      10,
      24 * 60,
      'STORY_TRANSFORM_MAX_DELAY_MINUTES'
    ),
  };

  const missing = [
    ['STORY_TRANSFORM_PROJECT_ID', config.projectId],
    ['STORY_TRANSFORM_REGION', config.region],
    ['STORY_TRANSFORM_JOB_NAME', config.jobName],
    ['STORY_TRANSFORM_BUCKET', config.bucket],
  ].filter(item => !item[1]).map(item => item[0]);
  if (missing.length > 0) {
    throw new Error(
      'Stories変換用Script Propertiesが不足しています: ' +
      missing.join(', ')
    );
  }
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.projectId)) {
    throw new Error('STORY_TRANSFORM_PROJECT_IDの形式が不正です。');
  }
  if (!/^[a-z][a-z0-9-]+$/.test(config.region)) {
    throw new Error('STORY_TRANSFORM_REGIONの形式が不正です。');
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.jobName)) {
    throw new Error('STORY_TRANSFORM_JOB_NAMEの形式が不正です。');
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)) {
    throw new Error('STORY_TRANSFORM_BUCKETの形式が不正です。');
  }
  if (!/^[0-9a-f]{6}$/.test(config.backgroundColor)) {
    throw new Error(
      'STORY_TRANSFORM_BACKGROUND_COLORは6桁の16進色で指定してください。'
    );
  }

  return config;
}

function isStoriesTransformEnabled_() {
  return getStoriesTransformConfig_().enabled;
}

function configureStoriesTransformForHibi() {
  PropertiesService.getScriptProperties().setProperties(
    {
      STORY_TRANSFORM_MODE: 'legacy',
      STORY_TRANSFORM_PROJECT_ID: 'hibi-452314',
      STORY_TRANSFORM_REGION: 'asia-northeast1',
      STORY_TRANSFORM_JOB_NAME: 'story-media-transformer',
      STORY_TRANSFORM_BUCKET: 'hibi-452314-story-media',
      STORY_TRANSFORM_BACKGROUND_COLOR: '000000',
      STORY_TRANSFORM_LEAD_MINUTES: '120',
      STORY_TRANSFORM_MAX_DELAY_MINUTES: '30',
    },
    false
  );
  return checkStoriesTransformSetup();
}

function setStoriesTransformMode(mode) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (['legacy', 'enforce', 'pause'].indexOf(normalizedMode) === -1) {
    throw new Error(
      'Stories変換モードはlegacy、enforce、pauseのいずれかで指定してください。'
    );
  }
  PropertiesService
    .getScriptProperties()
    .setProperty('STORY_TRANSFORM_MODE', normalizedMode);
  return {
    mode: normalizedMode,
    enabled: normalizedMode === 'enforce',
  };
}

function createStoriesPausedError_() {
  const error = new Error(
    'Instagram Stories投稿はSTORY_TRANSFORM_MODE=pauseにより停止中です。'
  );
  error.retryable = false;
  return error;
}

function getStoryDriveMetadata_(mediaUrl, mediaKind) {
  const fileId = extractDriveFileId_(mediaUrl);
  const fields = [
    'id',
    'name',
    'mimeType',
    'size',
    'modifiedTime',
    'md5Checksum',
    'capabilities(canDownload)',
    'imageMediaMetadata(width,height)',
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
  }, 'Stories Drive metadata', true);

  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Stories Drive metadata', response);
  }

  const result = parseJsonResponse_(response, 'Stories Drive metadata');
  const totalBytes = Number(result.size);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error(
      'Stories素材のファイルサイズを取得できません: ' +
      String(result.size)
    );
  }
  if (
    mediaKind === 'video' &&
    totalBytes > INSTAGRAM_MAX_VIDEO_BYTES
  ) {
    throw new Error(
      'Stories動画サイズが1GB上限を超えています: ' +
      (totalBytes / 1024 / 1024).toFixed(2) + 'MB'
    );
  }
  if (
    result.capabilities &&
    result.capabilities.canDownload === false
  ) {
    throw new Error('Stories素材はDriveからダウンロードできません。');
  }

  const supportedMimeTypes = mediaKind === 'video'
    ? ['video/mp4', 'video/quicktime']
    : ['image/jpeg', 'image/png', 'image/webp'];
  const mimeType = String(result.mimeType || '').toLowerCase();
  if (supportedMimeTypes.indexOf(mimeType) === -1) {
    throw new Error(
      'Stories変換で未対応のMIMEタイプです: ' +
      (mimeType || '不明')
    );
  }

  const mediaMetadata = mediaKind === 'video'
    ? (result.videoMediaMetadata || {})
    : (result.imageMediaMetadata || {});
  const durationMillis =
    mediaMetadata.durationMillis != null
      ? Number(mediaMetadata.durationMillis)
      : null;
  if (
    mediaKind === 'video' &&
    (
      !Number.isFinite(durationMillis) ||
      durationMillis <= 0 ||
      durationMillis > INSTAGRAM_STORY_MAX_VIDEO_SECONDS * 1000
    )
  ) {
    throw new Error(
      'Stories動画は0秒より長く60秒以内である必要があります: ' +
      String(durationMillis)
    );
  }

  return {
    fileId: String(result.id || fileId),
    fileName: String(result.name || fileId),
    mimeType: mimeType,
    totalBytes: totalBytes,
    modifiedTime: String(result.modifiedTime || ''),
    md5Checksum: String(result.md5Checksum || '').toLowerCase(),
    width: mediaMetadata.width != null
      ? Number(mediaMetadata.width)
      : null,
    height: mediaMetadata.height != null
      ? Number(mediaMetadata.height)
      : null,
    durationMillis: durationMillis,
  };
}

function buildStoryTransformFingerprint_(metadata, mediaKind, config) {
  const source = JSON.stringify({
    version: STORY_TRANSFORM_VERSION,
    fileId: metadata.fileId,
    modifiedTime: metadata.modifiedTime,
    totalBytes: metadata.totalBytes,
    md5Checksum: metadata.md5Checksum,
    mediaKind: mediaKind,
    backgroundColor: config.backgroundColor,
  });
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    source,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function createInstagramStoryTransformState_(
  metadata,
  mediaKind,
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
    mediaKind: mediaKind,
    scheduledAt: new Date(scheduledAt).toISOString(),
    transformVersion: STORY_TRANSFORM_VERSION,
    operationName: '',
    resultObject: 'instagram-stories/results/' + fingerprint + '.json',
    outputObject: '',
    outputUrl: '',
    outputUrlExpiresAt: '',
    startedAt: '',
    completedAt: '',
    attempts: 0,
    lastError: '',
  };
}

function ensureInstagramStoryTransformState_(
  job,
  metadata,
  mediaKind,
  scheduledAt,
  config
) {
  if (!job.instagram) job.instagram = {};
  const fingerprint = buildStoryTransformFingerprint_(
    metadata,
    mediaKind,
    config
  );
  const current = job.instagram.story;

  if (current && current.fingerprint === fingerprint) {
    return current;
  }
  if (
    current &&
    current.fingerprint !== fingerprint &&
    (job.completedTargets || []).length > 0
  ) {
    const error = new Error(
      '他の投稿先が完了した後にStories素材が更新されました。' +
      '投稿内容の不一致を防ぐため手動確認してください。'
    );
    error.retryable = false;
    throw error;
  }

  job.instagram.story = createInstagramStoryTransformState_(
    metadata,
    mediaKind,
    scheduledAt,
    fingerprint
  );
  return job.instagram.story;
}

function getStoryRunJobUrl_(config) {
  return (
    STORY_TRANSFORM_RUN_ORIGIN +
    'projects/' + encodeURIComponent(config.projectId) +
    '/locations/' + encodeURIComponent(config.region) +
    '/jobs/' + encodeURIComponent(config.jobName)
  );
}

function invokeStoryTransformJob_(state, config) {
  const environment = {
    STORY_JOB_ID: state.fingerprint,
    DRIVE_FILE_ID: state.sourceFileId,
    EXPECTED_SOURCE_MODIFIED_TIME: state.sourceModifiedTime,
    EXPECTED_SOURCE_SIZE: state.sourceSize,
    EXPECTED_SOURCE_MD5: state.sourceMd5Checksum,
    MEDIA_KIND: state.mediaKind,
    BACKGROUND_COLOR: config.backgroundColor,
    OUTPUT_BUCKET: config.bucket,
    OUTPUT_PREFIX: 'instagram-stories/output',
    RESULT_OBJECT: state.resultObject,
  };
  const env = Object.keys(environment).map(name => ({
    name: name,
    value: String(environment[name]),
  }));
  const url = getStoryRunJobUrl_(config) + ':run';
  const response = fetchWithContext_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    payload: JSON.stringify({
      overrides: {
        containerOverrides: [{ env: env }],
        taskCount: 1,
        timeout: '900s',
      },
    }),
    muteHttpExceptions: true,
  }, 'Stories Cloud Run Job start', true);

  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Stories Cloud Run Job start', response);
  }
  const result = parseJsonResponse_(
    response,
    'Stories Cloud Run Job start'
  );
  if (!result.name) {
    throw new Error('Cloud Run Jobs APIからoperation名を取得できません。');
  }
  return String(result.name);
}

function readStoryTransformManifest_(state, config) {
  const url =
    STORY_TRANSFORM_GCS_ORIGIN +
    'b/' + encodeURIComponent(config.bucket) +
    '/o/' + encodeURIComponent(state.resultObject) +
    '?alt=media';
  const response = fetchWithContext_(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    muteHttpExceptions: true,
  }, 'Stories transform manifest', true);
  const statusCode = response.getResponseCode();
  if (statusCode === 404) return null;
  if (statusCode !== 200) {
    throw createHttpError_('Stories transform manifest', response);
  }
  return parseJsonResponse_(response, 'Stories transform manifest');
}

function getStoryRunOperation_(operationName) {
  if (!operationName) return null;
  const url = STORY_TRANSFORM_RUN_ORIGIN + operationName;
  const response = fetchWithContext_(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    muteHttpExceptions: true,
  }, 'Stories Cloud Run operation', true);
  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Stories Cloud Run operation', response);
  }
  return parseJsonResponse_(response, 'Stories Cloud Run operation');
}

function createStoryManifestError_(manifest) {
  const error = new Error(
    'Storiesメディア変換に失敗しました: ' +
    String(manifest.error || manifest.error_type || 'unknown error')
  );
  error.retryable = false;
  return error;
}

function applyReadyStoryManifest_(state, manifest) {
  if (manifest.job_id !== state.fingerprint) {
    throw new Error('Stories変換結果のジョブIDが一致しません。');
  }
  if (String(manifest.source_file_id || '') !== state.sourceFileId) {
    throw new Error('Stories変換結果のDriveファイルIDが一致しません。');
  }
  if (
    String(manifest.source_modified_time || '') !==
    state.sourceModifiedTime
  ) {
    throw new Error('Stories変換結果のDrive更新日時が一致しません。');
  }
  if (Number(manifest.source_size) !== Number(state.sourceSize)) {
    throw new Error('Stories変換結果のDriveファイルサイズが一致しません。');
  }
  if (
    state.sourceMd5Checksum &&
    String(manifest.source_md5_checksum || '').toLowerCase() !==
      state.sourceMd5Checksum
  ) {
    throw new Error('Stories変換結果のDriveチェックサムが一致しません。');
  }
  if (
    Number(manifest.width) !== STORY_TRANSFORM_WIDTH ||
    Number(manifest.height) !== STORY_TRANSFORM_HEIGHT
  ) {
    throw new Error(
      'Stories変換結果が1080x1920ではありません: ' +
      manifest.width + 'x' + manifest.height
    );
  }
  const expectedContentType = state.mediaKind === 'video'
    ? 'video/mp4'
    : 'image/jpeg';
  if (String(manifest.content_type || '') !== expectedContentType) {
    throw new Error(
      'Stories変換結果のContent-Typeが不正です: ' +
      String(manifest.content_type || '')
    );
  }
  const expiresAt = new Date(manifest.output_url_expires_at).getTime();
  if (
    !manifest.output_url ||
    !Number.isFinite(expiresAt)
  ) {
    throw new Error('Stories変換結果に有効な署名URLがありません。');
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

function isStoryOutputUrlUsable_(state, scheduledAt) {
  if (state.phase !== 'ready' || !state.outputUrl) return false;
  const expiresAt = new Date(state.outputUrlExpiresAt).getTime();
  const requiredUntil = Math.max(
    Date.now(),
    new Date(scheduledAt).getTime()
  ) + STORY_TRANSFORM_MIN_URL_REMAINING_MS;
  return Number.isFinite(expiresAt) && expiresAt > requiredUntil;
}

function assertStoryPreparationWithinDelay_(state, config) {
  const scheduledAt = new Date(state.scheduledAt).getTime();
  if (
    Number.isFinite(scheduledAt) &&
    Date.now() >
      scheduledAt + config.maxDelayMinutes * 60 * 1000
  ) {
    const error = new Error(
      'Stories変換が予約時刻から' +
      config.maxDelayMinutes + '分以内に完了しませんでした。'
    );
    error.retryable = false;
    throw error;
  }
}

function advanceInstagramStoryPreparation_(
  job,
  mediaUrl,
  mediaKind,
  scheduledAt,
  deadlineMs,
  providedConfig
) {
  const config = providedConfig || getStoriesTransformConfig_();
  if (config.mode === 'pause') {
    throw createStoriesPausedError_();
  }
  if (!config.enabled) {
    return {
      completed: true,
      mediaUrl: mediaUrl,
      mediaKind: mediaKind,
      transformed: false,
    };
  }

  const metadata = getStoryDriveMetadata_(mediaUrl, mediaKind);
  const state = ensureInstagramStoryTransformState_(
    job,
    metadata,
    mediaKind,
    scheduledAt,
    config
  );

  if (state.phase === 'publishing') {
    state.phase = 'unknown';
    state.lastError =
      'Instagram Stories投稿中に実行が中断され、結果を確認できません。';
    savePostJob_(job);
  }
  if (state.phase === 'unknown') {
    const error = new Error(
      state.lastError ||
      'Instagram Storiesの投稿結果が不明です。手動確認してください。'
    );
    error.retryable = false;
    throw error;
  }
  if (state.phase === 'published') {
    return {
      completed: true,
      mediaUrl: state.outputUrl,
      mediaKind: mediaKind,
      transformed: true,
      alreadyPublished: true,
    };
  }
  if (state.phase === 'error') {
    throw createStoryManifestError_({
      error: state.lastError || 'stored transform error',
    });
  }
  if (isStoryOutputUrlUsable_(state, scheduledAt)) {
    return {
      completed: true,
      mediaUrl: state.outputUrl,
      mediaKind: mediaKind,
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
    const manifest = readStoryTransformManifest_(state, config);
    if (manifest && manifest.status === 'ready') {
      applyReadyStoryManifest_(state, manifest);
      savePostJob_(job);
      return {
        completed: true,
        mediaUrl: state.outputUrl,
        mediaKind: mediaKind,
        transformed: true,
      };
    }
    let operation = null;
    if (manifest && manifest.status === 'error') {
      state.lastError = String(
        manifest.error || manifest.error_type || 'unknown error'
      );
      operation = state.operationName
        ? getStoryRunOperation_(state.operationName)
        : null;
      if (!operation || operation.done !== true) {
        // Cloud Run側のタスク再試行中は一時的なerror manifestを
        // 最終失敗として扱わない。
        state.phase = 'processing';
        savePostJob_(job);
      } else {
        state.phase = 'error';
        savePostJob_(job);
        throw createStoryManifestError_(manifest);
      }
    }
    if (manifest && manifest.status === 'processing') {
      state.phase = 'processing';
      savePostJob_(job);
    } else if (state.operationName && !operation) {
      operation = getStoryRunOperation_(state.operationName);
      if (operation && operation.done && operation.error) {
        state.phase = 'error';
        state.lastError = String(
          operation.error.message || JSON.stringify(operation.error)
        ).slice(0, 1000);
        savePostJob_(job);
        throw createStoryManifestError_({ error: state.lastError });
      }
    }
  }

  assertStoryPreparationWithinDelay_(state, config);

  if (state.phase === 'not_started' && hasRequestTime_(deadlineMs)) {
    state.operationName = invokeStoryTransformJob_(state, config);
    state.phase = 'submitted';
    state.startedAt = new Date().toISOString();
    state.attempts += 1;
    state.lastError = '';
    savePostJob_(job);
  }

  return {
    completed: false,
    status: POST_STATUS.PROCESSING,
    mediaKind: mediaKind,
    transformed: true,
  };
}

function getOrCreateStoriesPreparationJob_(row, rowNumber, enabledTargets) {
  let job = loadPostJob_(rowNumber);
  const currentFingerprint = buildRowFingerprint_(row, enabledTargets);
  if (!job) {
    job = createPostJob_(row, rowNumber, enabledTargets);
    job.preparationOnly = true;
    savePostJob_(job);
    return job;
  }
  if (job.sourceFingerprint === currentFingerprint) return job;

  const hasExternalProgress =
    (job.completedTargets || []).length > 0 ||
    (
      job.x &&
      job.x.postState &&
      job.x.postState !== 'not_started'
    );
  if (hasExternalProgress) {
    throw new Error(
      '投稿処理開始後に予約行が変更されました。手動確認してください。'
    );
  }

  job = createPostJob_(row, rowNumber, enabledTargets);
  job.preparationOnly = true;
  savePostJob_(job);
  return job;
}

function prepareStories() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('prepareStories skipped: another execution is running.');
    return;
  }

  try {
    prepareStoriesLocked_();
  } finally {
    lock.releaseLock();
  }
}

function prepareStoriesLocked_() {
  const config = getStoriesTransformConfig_();
  if (!config.enabled) {
    Logger.log(
      'prepareStories skipped: STORY_TRANSFORM_MODE=' + config.mode
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
      !isPostTargetEnabled_(row[8])
    ) {
      continue;
    }

    const scheduledAt = new Date(row[0]);
    const scheduledTime = scheduledAt.getTime();
    if (
      !Number.isFinite(scheduledTime) ||
      scheduledTime < earliest ||
      scheduledTime > horizon
    ) {
      continue;
    }

    const image = String(row[2] || '').trim();
    const video = String(row[3] || '').trim();
    if (!image && !video) continue;
    const mediaKind = video ? 'video' : 'image';
    const mediaUrl = video || image;
    const enabledTargets = getEnabledPostTargets_(row);

    try {
      const job = getOrCreateStoriesPreparationJob_(
        row,
        index + 1,
        enabledTargets
      );
      advanceInstagramStoryPreparation_(
        job,
        mediaUrl,
        mediaKind,
        scheduledAt,
        deadlineMs,
        config
      );
    } catch (error) {
      Logger.log(
        'Stories preparation failed. Row ' + (index + 1) + ': ' +
        (error && error.message ? error.message : String(error))
      );
    }
  }
}

function postPreparedInstagramStoryFromSheetRow(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const config = getStoriesTransformConfig_();
  if (!config.enabled) {
    throw new Error(
      'STORY_TRANSFORM_MODE=enforceにしてから実行してください。'
    );
  }

  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }
  const row = sheet.getRange(targetRow, 1, 1, 9).getValues()[0];
  const image = String(row[2] || '').trim();
  const video = String(row[3] || '').trim();
  if (!image && !video) {
    throw new Error(
      'Row ' + targetRow + 'のC列画像またはD列動画がありません。'
    );
  }

  const enabledTargets = getEnabledPostTargets_(row);
  const job = getOrCreateStoriesPreparationJob_(
    row,
    targetRow,
    enabledTargets
  );
  job.preparationOnly = false;
  savePostJob_(job);

  const result = processInstagramTarget_(
    { header: 'instagram_stories', label: 'Stories' },
    row[1],
    image,
    video,
    job,
    row[0] || new Date(),
    Date.now() + EXECUTION_BUDGET_MS
  );
  if (!result.completed) {
    return {
      rowNumber: targetRow,
      completed: false,
      status: result.status,
      phase: job.instagram.story.phase,
    };
  }

  addCompletedTarget_(job, 'instagram_stories');
  return {
    rowNumber: targetRow,
    completed: true,
    phase: job.instagram.story
      ? job.instagram.story.phase
      : 'published',
  };
}

function prepareInstagramStoryFromSheetRow(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const config = getStoriesTransformConfig_(true);
  config.enabled = true;
  config.mode = 'enforce';

  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }
  const row = sheet.getRange(targetRow, 1, 1, 9).getValues()[0];
  if (!isPostTargetEnabled_(row[8])) {
    throw new Error(
      'Row ' + targetRow + 'はinstagram_storiesが有効ではありません。'
    );
  }

  const scheduledAt = new Date(row[0]);
  if (!row[0] || !Number.isFinite(scheduledAt.getTime())) {
    throw new Error(
      'Row ' + targetRow + 'のA列datetimeが有効ではありません。'
    );
  }
  const image = String(row[2] || '').trim();
  const video = String(row[3] || '').trim();
  if (!image && !video) {
    throw new Error(
      'Row ' + targetRow + 'のC列画像またはD列動画がありません。'
    );
  }

  const mediaKind = video ? 'video' : 'image';
  const mediaUrl = video || image;
  const enabledTargets = getEnabledPostTargets_(row);
  const job = getOrCreateStoriesPreparationJob_(
    row,
    targetRow,
    enabledTargets
  );
  const result = advanceInstagramStoryPreparation_(
    job,
    mediaUrl,
    mediaKind,
    // 投稿を伴わない手動検証では、過去行の遅延上限や
    // 遠い将来の署名URL期限に影響されないよう現在時刻を使う。
    new Date(),
    Date.now() + EXECUTION_BUDGET_MS,
    config
  );

  return {
    rowNumber: targetRow,
    completed: result.completed,
    mediaKind: mediaKind,
    phase: job.instagram.story.phase,
    outputObject: job.instagram.story.outputObject || '',
  };
}

function createStoriesTransformTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(
    trigger => trigger.getHandlerFunction() === 'prepareStories'
  );
  if (exists) {
    Logger.log('prepareStories trigger already exists.');
    return;
  }
  ScriptApp.newTrigger('prepareStories')
    .timeBased()
    .everyMinutes(STORY_TRANSFORM_TRIGGER_MINUTES)
    .create();
  Logger.log('prepareStories trigger created.');
}

function deleteStoriesTransformTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'prepareStories')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  Logger.log('prepareStories triggers deleted.');
}

function checkStoriesTransformSetup() {
  const config = getStoriesTransformConfig_(true);

  const authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  const jobResponse = fetchWithContext_(getStoryRunJobUrl_(config), {
    method: 'get',
    headers: { Authorization: authorization },
    muteHttpExceptions: true,
  }, 'Stories Cloud Run setup check', true);
  if (jobResponse.getResponseCode() !== 200) {
    throw createHttpError_('Stories Cloud Run setup check', jobResponse);
  }

  const bucketUrl =
    STORY_TRANSFORM_GCS_ORIGIN +
    'b/' + encodeURIComponent(config.bucket) +
    '/o?prefix=' + encodeURIComponent('instagram-stories/') +
    '&maxResults=1';
  const bucketResponse = fetchWithContext_(bucketUrl, {
    method: 'get',
    headers: { Authorization: authorization },
    muteHttpExceptions: true,
  }, 'Stories GCS setup check', true);
  if (bucketResponse.getResponseCode() !== 200) {
    throw createHttpError_('Stories GCS setup check', bucketResponse);
  }

  return {
    enabled: config.enabled,
    mode: config.mode,
    projectId: config.projectId,
    region: config.region,
    jobName: config.jobName,
    bucket: config.bucket,
    backgroundColor: config.backgroundColor,
    leadMinutes: config.leadMinutes,
    maxDelayMinutes: config.maxDelayMinutes,
  };
}
