// ====================
// 定数
// ====================
const SPREADSHEET_ID = '1tv3WyINPLComoybseAXIu-SOJ98DQ2C0NbCxieQEW3c';
const SHEET_NAME = 'config';
const X_MEDIA_UPLOAD_URL =
  'https://upload.twitter.com/1.1/media/upload.json';
const X_POST_URL = 'https://api.twitter.com/2/tweets';
const DRIVE_FILES_API_URL = 'https://www.googleapis.com/drive/v3/files/';
const VIDEO_CHUNK_BYTES = 5 * 1024 * 1024;
const X_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const EXECUTION_BUDGET_MS = 4.5 * 60 * 1000;
const MIN_REQUEST_TIME_MS = 30 * 1000;
const MIN_CHUNK_TIME_MS = 90 * 1000;
const MAX_TRANSIENT_RETRIES = 5;
const POST_JOB_PREFIX = 'X_UPLOAD_JOB:';
const POST_JOB_VERSION = 1;

const POST_STATUS = {
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  POSTING: 'posting',
  POSTED: 'posted',
  ERROR: 'error',
  UNKNOWN: 'unknown',
};

// スクリプトプロパティから取得
function getProps_() {
  const props = PropertiesService.getScriptProperties();
  const propertyNames = {
    consumerKey: 'X_CONSUMER_KEY',
    consumerSecret: 'X_CONSUMER_SECRET',
    accessToken: 'X_ACCESS_TOKEN',
    accessTokenSecret: 'X_ACCESS_TOKEN_SECRET',
  };
  const values = {};
  Object.keys(propertyNames).forEach(key => {
    values[key] = props.getProperty(propertyNames[key]);
  });
  const missing = Object.keys(values)
    .filter(key => !values[key])
    .map(key => propertyNames[key]);
  if (missing.length > 0) {
    throw new Error(
      'X APIのScript Propertiesが不足しています: ' +
      missing.join(', ')
    );
  }
  return values;
}

// ====================
// OAuth 1.0a 署名
// ====================
function generateNonce_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function percentEncode_(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function buildOAuthHeader_(method, url, params, props) {
  const oauthParams = {
    oauth_consumer_key: props.consumerKey,
    oauth_nonce: generateNonce_(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: props.accessToken,
    oauth_version: '1.0',
  };

  // 全パラメータを結合してソート
  const allParams = Object.assign({}, params, oauthParams);
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(k => percentEncode_(k) + '=' + percentEncode_(allParams[k]))
    .join('&');

  // Signature Base String
  const baseString = [
    method.toUpperCase(),
    percentEncode_(url),
    percentEncode_(paramString),
  ].join('&');

  // Signing Key
  const signingKey =
    percentEncode_(props.consumerSecret) + '&' +
    percentEncode_(props.accessTokenSecret);

  const signatureBytes = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1,
    baseString,
    signingKey
  );
  const oauthSignature = Utilities.base64Encode(signatureBytes);

  oauthParams['oauth_signature'] = oauthSignature;

  // Authorization ヘッダー組み立て
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map(k => percentEncode_(k) + '="' + percentEncode_(oauthParams[k]) + '"');
  return 'OAuth ' + headerParts.join(', ');
}

// ====================
// メディアアップロード (v1.1)
// ====================
function isRetryableHttpStatus_(statusCode) {
  return statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500;
}

function responseSummary_(response) {
  const text = String(response.getContentText() || '');
  return text.length > 1000 ? text.slice(0, 1000) + '…' : text;
}

function createHttpError_(operation, response) {
  const statusCode = response.getResponseCode();
  const error = new Error(
    operation + ' failed (' + statusCode + '): ' +
    responseSummary_(response)
  );
  error.httpStatus = statusCode;
  error.retryable = isRetryableHttpStatus_(statusCode);
  return error;
}

function fetchWithContext_(url, options, operation, retryableOnTransport) {
  try {
    return UrlFetchApp.fetch(url, options);
  } catch (cause) {
    const error = new Error(
      operation + ' transport error: ' +
      (cause && cause.message ? cause.message : String(cause))
    );
    error.retryable = Boolean(retryableOnTransport);
    error.transportError = true;
    throw error;
  }
}

function parseJsonResponse_(response, operation) {
  const text = response.getContentText();
  try {
    return text ? JSON.parse(text) : {};
  } catch (cause) {
    const error = new Error(
      operation + ' returned invalid JSON: ' +
      String(text || '').slice(0, 1000)
    );
    error.retryable = false;
    throw error;
  }
}

function uploadMedia_(blob, props) {
  const boundary = '----FormBoundary' + generateNonce_();

  const mediaData = Utilities.base64Encode(blob.getBytes());

  // multipart/form-data を手動構築
  const payload = Utilities.newBlob('').getBytes()
    .concat(Utilities.newBlob(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="media_data"\r\n\r\n' +
      mediaData + '\r\n' +
      '--' + boundary + '--\r\n'
    ).getBytes());

  const authHeader = buildOAuthHeader_(
    'POST',
    X_MEDIA_UPLOAD_URL,
    {},
    props
  );

  const options = {
    method: 'post',
    contentType: 'multipart/form-data; boundary=' + boundary,
    payload: payload,
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  };

  const response = fetchWithContext_(
    X_MEDIA_UPLOAD_URL,
    options,
    'Media upload',
    true
  );
  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Media upload', response);
  }
  const result = parseJsonResponse_(response, 'Media upload');
  if (!result.media_id_string) {
    throw new Error('Media upload response has no media_id_string.');
  }
  return result.media_id_string;
}

function initializeXVideoUpload_(video, props) {
  const initParams = {
    command: 'INIT',
    total_bytes: String(video.totalBytes),
    media_type: video.mimeType,
    media_category: 'tweet_video',
  };
  const initAuth = buildOAuthHeader_(
    'POST',
    X_MEDIA_UPLOAD_URL,
    initParams,
    props
  );
  const response = fetchWithContext_(X_MEDIA_UPLOAD_URL, {
    method: 'post',
    payload: initParams,
    headers: { Authorization: initAuth },
    muteHttpExceptions: true,
  }, 'Video INIT', true);
  const statusCode = response.getResponseCode();
  if (statusCode !== 200 && statusCode !== 202) {
    throw createHttpError_('Video INIT', response);
  }

  const result = parseJsonResponse_(response, 'Video INIT');
  if (!result.media_id_string) {
    throw new Error('Video INIT response has no media_id_string.');
  }
  return result;
}

function appendXVideoChunk_(video, chunkBytes, props) {
  const authHeader = buildOAuthHeader_(
    'POST',
    X_MEDIA_UPLOAD_URL,
    {},
    props
  );
  const chunkBlob = Utilities.newBlob(
    chunkBytes,
    video.mimeType,
    video.fileName + '.part-' + video.nextSegmentIndex
  );
  const response = fetchWithContext_(X_MEDIA_UPLOAD_URL, {
    method: 'post',
    payload: {
      command: 'APPEND',
      media_id: video.mediaId,
      segment_index: String(video.nextSegmentIndex),
      media: chunkBlob,
    },
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  }, 'Video APPEND segment ' + video.nextSegmentIndex, true);
  const statusCode = response.getResponseCode();
  if (statusCode !== 200 && statusCode !== 204) {
    throw createHttpError_(
      'Video APPEND segment ' + video.nextSegmentIndex,
      response
    );
  }
}

function finalizeXVideoUpload_(video, props) {
  const params = { command: 'FINALIZE', media_id: video.mediaId };
  const authHeader = buildOAuthHeader_(
    'POST',
    X_MEDIA_UPLOAD_URL,
    params,
    props
  );
  const response = fetchWithContext_(X_MEDIA_UPLOAD_URL, {
    method: 'post',
    payload: params,
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  }, 'Video FINALIZE', true);
  const statusCode = response.getResponseCode();
  if (statusCode !== 200 && statusCode !== 201) {
    throw createHttpError_('Video FINALIZE', response);
  }
  return parseJsonResponse_(response, 'Video FINALIZE');
}

function getXVideoUploadStatus_(video, props) {
  const params = { command: 'STATUS', media_id: video.mediaId };
  const authHeader = buildOAuthHeader_(
    'GET',
    X_MEDIA_UPLOAD_URL,
    params,
    props
  );
  const query =
    '?command=STATUS&media_id=' + encodeURIComponent(video.mediaId);
  const response = fetchWithContext_(X_MEDIA_UPLOAD_URL + query, {
    method: 'get',
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  }, 'Video STATUS', true);
  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Video STATUS', response);
  }
  return parseJsonResponse_(response, 'Video STATUS');
}

function getProcessingState_(result) {
  return result && result.processing_info
    ? String(result.processing_info.state || '')
    : '';
}

function updateXVideoProcessingState_(video, result) {
  const processingInfo = result.processing_info;
  const state = getProcessingState_(result);

  if (!processingInfo || state === 'succeeded') {
    video.phase = 'ready';
    video.checkAfterAt = null;
    return true;
  }

  if (state === 'failed') {
    const error = new Error(
      'Video processing failed: ' +
      JSON.stringify(processingInfo.error || processingInfo)
    );
    error.retryable = false;
    throw error;
  }

  const checkAfterSeconds = Math.max(
    1,
    Number(processingInfo.check_after_secs) || 5
  );
  video.phase = 'processing';
  video.checkAfterAt = Date.now() + checkAfterSeconds * 1000;
  return false;
}

function resetExpiredXVideoSession_(video) {
  if (!video.expiresAt || Date.now() < video.expiresAt - 60 * 1000) {
    return false;
  }

  video.phase = 'init';
  video.mediaId = null;
  video.nextSegmentIndex = 0;
  video.nextByteOffset = 0;
  video.expiresAt = null;
  video.checkAfterAt = null;
  return true;
}

function processXVideoUpload_(job, videoUrl, props, deadlineMs) {
  let video = job.x.video;
  if (!video) {
    const fileId = extractDriveFileId_(videoUrl);
    const metadata = getDriveVideoMetadata_(fileId);
    validateXVideoMetadata_(metadata);
    video = {
      fileId: metadata.fileId,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      totalBytes: metadata.totalBytes,
      modifiedTime: metadata.modifiedTime,
      durationMillis: metadata.durationMillis,
      width: metadata.width,
      height: metadata.height,
      phase: 'init',
      mediaId: null,
      nextSegmentIndex: 0,
      nextByteOffset: 0,
      expiresAt: null,
      checkAfterAt: null,
    };
    job.x.video = video;
    savePostJob_(job);
  } else {
    const currentMetadata = getDriveVideoMetadata_(video.fileId);
    if (
      currentMetadata.totalBytes !== video.totalBytes ||
      currentMetadata.modifiedTime !== video.modifiedTime
    ) {
      const error = new Error(
        'Drive動画がアップロード途中で更新されました。' +
        'ジョブを破棄せず手動確認してください。'
      );
      error.retryable = false;
      throw error;
    }
    if (resetExpiredXVideoSession_(video)) {
      savePostJob_(job);
    }
  }

  if (video.phase === 'init') {
    if (!hasRequestTime_(deadlineMs)) {
      return { completed: false, status: POST_STATUS.UPLOADING };
    }
    const initResult = initializeXVideoUpload_(video, props);
    video.mediaId = initResult.media_id_string;
    video.expiresAt = initResult.expires_after_secs
      ? Date.now() + Number(initResult.expires_after_secs) * 1000
      : null;
    video.phase = 'appending';
    job.retryCount = 0;
    job.lastTransientError = null;
    savePostJob_(job);
  }

  while (
    video.phase === 'appending' &&
    video.nextByteOffset < video.totalBytes
  ) {
    if (!hasRequestTime_(deadlineMs, MIN_CHUNK_TIME_MS)) {
      return { completed: false, status: POST_STATUS.UPLOADING };
    }

    const range = calculateByteRange_(
      video.nextByteOffset,
      video.totalBytes,
      VIDEO_CHUNK_BYTES
    );
    const chunk = fetchDriveByteRange_(
      video.fileId,
      range.start,
      range.end
    );
    appendXVideoChunk_(video, chunk, props);

    video.nextByteOffset = range.end + 1;
    video.nextSegmentIndex += 1;
    job.retryCount = 0;
    job.retryAfterAt = null;
    job.lastTransientError = null;
    savePostJob_(job);
  }

  if (
    video.phase === 'appending' &&
    video.nextByteOffset >= video.totalBytes
  ) {
    video.phase = 'finalizing';
    savePostJob_(job);
  }

  if (video.phase === 'finalizing') {
    if (!hasRequestTime_(deadlineMs)) {
      return { completed: false, status: POST_STATUS.UPLOADING };
    }
    const finalizeResult = finalizeXVideoUpload_(video, props);
    updateXVideoProcessingState_(video, finalizeResult);
    job.retryCount = 0;
    job.lastTransientError = null;
    savePostJob_(job);
  }

  if (video.phase === 'processing') {
    if (video.checkAfterAt && Date.now() < video.checkAfterAt) {
      return { completed: false, status: POST_STATUS.PROCESSING };
    }
    if (!hasRequestTime_(deadlineMs)) {
      return { completed: false, status: POST_STATUS.PROCESSING };
    }

    const statusResult = getXVideoUploadStatus_(video, props);
    updateXVideoProcessingState_(video, statusResult);
    job.retryCount = 0;
    job.lastTransientError = null;
    savePostJob_(job);
  }

  if (video.phase !== 'ready') {
    return {
      completed: false,
      status: video.phase === 'processing'
        ? POST_STATUS.PROCESSING
        : POST_STATUS.UPLOADING,
    };
  }

  return { completed: true, mediaId: video.mediaId };
}

// ====================
// Google Drive からファイル取得
// ====================
function extractDriveFileId_(driveUrl) {
  const value = String(driveUrl || '').trim();
  const pathMatch = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const queryMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const rawIdMatch = value.match(/^([a-zA-Z0-9_-]{10,})$/);
  const fileId = pathMatch
    ? pathMatch[1]
    : (queryMatch ? queryMatch[1] : (rawIdMatch ? rawIdMatch[1] : ''));

  if (!fileId) {
    throw new Error('Invalid Drive URL: ' + value);
  }
  return fileId;
}

function getHeaderCaseInsensitive_(headers, targetName) {
  const target = String(targetName).toLowerCase();
  const key = Object.keys(headers || {}).find(
    headerName => String(headerName).toLowerCase() === target
  );
  return key ? headers[key] : null;
}

function getDriveVideoMetadata_(fileId) {
  const fields = [
    'id',
    'name',
    'mimeType',
    'size',
    'modifiedTime',
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
  }, 'Drive metadata', true);

  if (response.getResponseCode() !== 200) {
    throw createHttpError_('Drive metadata', response);
  }

  const result = parseJsonResponse_(response, 'Drive metadata');
  const totalBytes = Number(result.size);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error(
      'Drive動画のファイルサイズを取得できません: ' +
      String(result.size)
    );
  }
  if (
    result.capabilities &&
    result.capabilities.canDownload === false
  ) {
    throw new Error('Drive動画はダウンロードが禁止されています。');
  }

  const videoMetadata = result.videoMediaMetadata || {};
  return {
    fileId: result.id || fileId,
    fileName: result.name || fileId,
    mimeType: String(result.mimeType || ''),
    totalBytes: totalBytes,
    modifiedTime: String(result.modifiedTime || ''),
    durationMillis: videoMetadata.durationMillis != null
      ? Number(videoMetadata.durationMillis)
      : null,
    width: videoMetadata.width != null
      ? Number(videoMetadata.width)
      : null,
    height: videoMetadata.height != null
      ? Number(videoMetadata.height)
      : null,
  };
}

function validateXVideoMetadata_(metadata) {
  const supportedMimeTypes = [
    'video/mp4',
    'video/quicktime',
  ];
  const issues = [];

  if (supportedMimeTypes.indexOf(metadata.mimeType) === -1) {
    issues.push(
      'MIMEタイプがMP4/MOVではありません (' +
      metadata.mimeType + ')'
    );
  }
  if (metadata.totalBytes > X_VIDEO_MAX_BYTES) {
    issues.push(
      'ファイルサイズがXの512MiB上限を超えています (' +
      (metadata.totalBytes / 1024 / 1024).toFixed(2) + 'MiB)'
    );
  }
  if (
    Number.isFinite(metadata.durationMillis) &&
    (
      metadata.durationMillis < 500 ||
      metadata.durationMillis > 140 * 1000
    )
  ) {
    issues.push(
      '動画時間が0.5秒以上140秒以内ではありません (' +
      (metadata.durationMillis / 1000).toFixed(2) + '秒)'
    );
  }

  if (issues.length > 0) {
    const error = new Error(
      'X動画の事前検証NG: ' + issues.join(' / ')
    );
    error.retryable = false;
    throw error;
  }
}

function calculateByteRange_(start, totalBytes, chunkBytes) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(totalBytes) ||
    !Number.isSafeInteger(chunkBytes) ||
    start < 0 ||
    totalBytes <= 0 ||
    chunkBytes <= 0 ||
    start >= totalBytes
  ) {
    throw new Error(
      'Invalid byte range input: start=' + start +
      ', totalBytes=' + totalBytes +
      ', chunkBytes=' + chunkBytes
    );
  }
  return {
    start: start,
    end: Math.min(start + chunkBytes - 1, totalBytes - 1),
  };
}

function fetchDriveByteRange_(fileId, start, end) {
  const url =
    DRIVE_FILES_API_URL + encodeURIComponent(fileId) +
    '?alt=media&supportsAllDrives=true';
  const response = fetchWithContext_(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      Range: 'bytes=' + start + '-' + end,
    },
    muteHttpExceptions: true,
  }, 'Drive range ' + start + '-' + end, true);

  if (response.getResponseCode() !== 206) {
    if (response.getResponseCode() === 200) {
      const error = new Error(
        'Drive APIがRangeを無視してファイル全体を返しました。' +
        '安全のためアップロードを中止します。'
      );
      error.retryable = false;
      throw error;
    }
    throw createHttpError_(
      'Drive range ' + start + '-' + end,
      response
    );
  }

  const headers = response.getAllHeaders();
  const contentRange = String(
    getHeaderCaseInsensitive_(headers, 'Content-Range') || ''
  );
  const rangeMatch = contentRange.match(
    /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i
  );
  if (
    !rangeMatch ||
    Number(rangeMatch[1]) !== start ||
    Number(rangeMatch[2]) !== end
  ) {
    throw new Error(
      'Drive APIのContent-Rangeが要求と一致しません: ' +
      contentRange + ' (expected ' + start + '-' + end + ')'
    );
  }

  const bytes = response.getContent();
  const expectedLength = end - start + 1;
  if (bytes.length !== expectedLength) {
    throw new Error(
      'Drive APIの取得バイト数が一致しません: actual=' +
      bytes.length + ', expected=' + expectedLength
    );
  }
  return bytes;
}

function getFileFromDriveUrl_(driveUrl) {
  const fileId = extractDriveFileId_(driveUrl);
  return DriveApp.getFileById(fileId).getBlob();
}

// ====================
// ツイート投稿 (v2)
// ====================
function postTweet_(text, mediaIds, props) {
  const payload = { text: text };
  if (mediaIds && mediaIds.length > 0) {
    payload.media = { media_ids: mediaIds };
  }

  const jsonPayload = JSON.stringify(payload);
  const authHeader = buildOAuthHeader_('POST', X_POST_URL, {}, props);

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: jsonPayload,
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  };

  const response = fetchWithContext_(
    X_POST_URL,
    options,
    'Tweet',
    false
  );
  const code = response.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw createHttpError_('Tweet', response);
  }
  const result = parseJsonResponse_(response, 'Tweet');
  if (!result.data || !result.data.id) {
    throw new Error('Tweet response has no data.id.');
  }
  return result;
}

// ====================
// メイン: スケジュール投稿チェック
// ====================
const POST_TARGET_COLUMNS = [
  { index: 6, header: 'x_post', label: 'X' },
  { index: 7, header: 'instagram_post', label: 'Instagram' },
  { index: 8, header: 'instagram_stories', label: 'Stories' },
];
const ERROR_LOG_COLUMN = 10;
const ERROR_LOG_HEADER = 'error_log';

function isPostTargetEnabled_(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

function validatePostTargetColumns_(headers) {
  const invalidColumns = POST_TARGET_COLUMNS.filter(
    target => headers[target.index] !== target.header
  );

  if (invalidColumns.length > 0) {
    throw new Error(
      '投稿形式の列見出しが一致しません。' +
      ' G列=x_post、H列=instagram_post、I列=instagram_stories にしてください。'
    );
  }
}

function getEnabledPostTargets_(row) {
  return POST_TARGET_COLUMNS.filter(
    target => isPostTargetEnabled_(row[target.index])
  );
}

function ensureErrorLogColumn_(sheet) {
  if (sheet.getMaxColumns() < ERROR_LOG_COLUMN) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      ERROR_LOG_COLUMN - sheet.getMaxColumns()
    );
  }

  const headerCell = sheet.getRange(1, ERROR_LOG_COLUMN);
  const currentHeader = String(headerCell.getValue() || '').trim();

  if (!currentHeader) {
    headerCell.setValue(ERROR_LOG_HEADER);
  } else if (currentHeader !== ERROR_LOG_HEADER) {
    throw new Error(
      'J列の見出しは「' + ERROR_LOG_HEADER + '」にしてください。'
    );
  }
}

function buildPostErrorLog_(rowNumber, error) {
  const timestamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd HH:mm:ss'
  );
  const errorName =
    error && error.name ? String(error.name) : 'Error';
  const errorMessage =
    error && error.message ? String(error.message) : String(error);

  return (
    '[' + timestamp + '] ' +
    'Row ' + rowNumber + ' / ' +
    errorName + ': ' + errorMessage
  );
}

function getPostJobKey_(rowNumber) {
  return (
    POST_JOB_PREFIX +
    SPREADSHEET_ID + ':' +
    SHEET_NAME + ':' +
    rowNumber
  );
}

function loadPostJob_(rowNumber) {
  const value = PropertiesService
    .getScriptProperties()
    .getProperty(getPostJobKey_(rowNumber));
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(
      '保存済み投稿ジョブを読み込めません。Row ' +
      rowNumber + ': ' + cause.message
    );
  }
}

function savePostJob_(job) {
  job.updatedAt = new Date().toISOString();
  PropertiesService
    .getScriptProperties()
    .setProperty(getPostJobKey_(job.rowNumber), JSON.stringify(job));
}

function deletePostJob_(rowNumber) {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(getPostJobKey_(rowNumber));
}

function normalizeDateForFingerprint_(value) {
  return value instanceof Date
    ? value.toISOString()
    : String(value || '');
}

function buildRowFingerprint_(row, enabledTargets) {
  const source = JSON.stringify({
    datetime: normalizeDateForFingerprint_(row[0]),
    text: String(row[1] || ''),
    image: String(row[2] || ''),
    video: String(row[3] || ''),
    targets: enabledTargets.map(target => target.header),
  });
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    source,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest);
}

function createPostJob_(row, rowNumber, enabledTargets) {
  return {
    version: POST_JOB_VERSION,
    rowNumber: rowNumber,
    sourceFingerprint: buildRowFingerprint_(row, enabledTargets),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryCount: 0,
    retryAfterAt: null,
    lastTransientError: null,
    completedTargets: [],
    x: {
      imageMediaId: null,
      video: null,
      postState: 'not_started',
      tweetId: null,
    },
  };
}

function getOrCreatePostJob_(row, rowNumber, enabledTargets, status) {
  let job = loadPostJob_(rowNumber);
  if (!job) {
    if (
      status === POST_STATUS.UPLOADING ||
      status === POST_STATUS.PROCESSING ||
      status === POST_STATUS.POSTING
    ) {
      throw new Error(
        '進行中ステータスですが保存済みジョブがありません。' +
        '自動再開せず手動確認してください。'
      );
    }
    job = createPostJob_(row, rowNumber, enabledTargets);
    savePostJob_(job);
    return job;
  }

  if (job.version !== POST_JOB_VERSION) {
    throw new Error(
      '保存済み投稿ジョブのバージョンが一致しません。' +
      '自動再開せず手動確認してください。'
    );
  }

  const currentFingerprint = buildRowFingerprint_(row, enabledTargets);
  if (job.sourceFingerprint !== currentFingerprint) {
    throw new Error(
      '投稿途中で対象行の日時・本文・メディア・投稿先が変更されました。' +
      '自動再開せず手動確認してください。'
    );
  }
  return job;
}

function hasRequestTime_(deadlineMs, minimumMs) {
  return Date.now() + (minimumMs || MIN_REQUEST_TIME_MS) < deadlineMs;
}

function getCompletedTargetLabels_(job) {
  return (job.completedTargets || []).map(header => {
    const target = POST_TARGET_COLUMNS.find(item => item.header === header);
    return target ? target.label : header;
  });
}

function addCompletedTarget_(job, targetHeader) {
  if (job.completedTargets.indexOf(targetHeader) === -1) {
    job.completedTargets.push(targetHeader);
  }
  job.retryCount = 0;
  job.retryAfterAt = null;
  job.lastTransientError = null;
  savePostJob_(job);
}

function wrapTargetError_(error, target, mediaLabel, job) {
  const completedLabels = getCompletedTargetLabels_(job);
  const wrapped = new Error(
    target.label + ' / ' + mediaLabel +
    (
      completedLabels.length > 0
        ? ' / 完了済み=' + completedLabels.join(',')
        : ''
    ) +
    ': ' + (error && error.message ? error.message : String(error))
  );
  wrapped.retryable = error && error.retryable === true;
  wrapped.httpStatus = error && error.httpStatus;
  wrapped.transportError = error && error.transportError === true;
  return wrapped;
}

function processXTarget_(job, text, image, video, deadlineMs) {
  if (job.x.postState === 'posted') {
    return { completed: true };
  }
  if (job.x.postState === 'posting') {
    job.x.postState = 'unknown';
    savePostJob_(job);
  }
  if (job.x.postState === 'unknown') {
    const error = new Error(
      'Xポスト作成結果が不明です。二重投稿防止のため自動再試行しません。' +
      'X上の投稿有無を確認してください。'
    );
    error.retryable = false;
    throw error;
  }

  const props = getProps_();
  const mediaIds = [];

  if (image && video) {
    const error = new Error(
      'Xには画像と動画を同じポストへ同時添付できません。' +
      'C列またはD列のどちらか一方にしてください。'
    );
    error.retryable = false;
    throw error;
  }

  if (image) {
    if (!job.x.imageMediaId) {
      if (!hasRequestTime_(deadlineMs)) {
        return { completed: false, status: POST_STATUS.UPLOADING };
      }
      const blob = getFileFromDriveUrl_(image);
      job.x.imageMediaId = uploadMedia_(blob, props);
      savePostJob_(job);
    }
    mediaIds.push(job.x.imageMediaId);
  }

  if (video) {
    const videoResult = processXVideoUpload_(
      job,
      video,
      props,
      deadlineMs
    );
    if (!videoResult.completed) {
      return videoResult;
    }
    mediaIds.push(videoResult.mediaId);
  }

  if (!hasRequestTime_(deadlineMs)) {
    return { completed: false, status: POST_STATUS.POSTING };
  }

  job.x.postState = 'posting';
  savePostJob_(job);

  let tweetResult;
  try {
    tweetResult = postTweet_(text, mediaIds, props);
  } catch (error) {
    if (error && error.httpStatus) {
      // HTTPエラー応答を受信できた場合、ポストは作成されていない。
      job.x.postState = 'ready';
    } else {
      // 通信断や2xx応答の解析失敗は作成結果を断定できない。
      job.x.postState = 'unknown';
      error.retryable = false;
    }
    savePostJob_(job);
    throw error;
  }

  job.x.postState = 'posted';
  job.x.tweetId = tweetResult.data.id;
  savePostJob_(job);
  return { completed: true };
}

function processInstagramTarget_(target, text, image, video) {
  if (target.header === 'instagram_post') {
    if (video) {
      postInstagramVideoByUrl(video, text);
    } else if (image) {
      postInstagramImageByUrl(image, text);
    } else {
      throw new Error(
        'Instagram投稿用のC列画像またはD列動画がありません。'
      );
    }
    return;
  }

  if (target.header === 'instagram_stories') {
    if (video) {
      postInstagramVideoStoryByUrl(video);
    } else if (image) {
      postInstagramImageStoryByUrl(image);
    } else {
      throw new Error(
        'Stories投稿用のC列画像またはD列動画がありません。'
      );
    }
  }
}

function postRowToEnabledTargets_(
  row,
  rowNumber,
  status,
  deadlineMs
) {
  const text = row[1];
  const image = row[2];
  const video = row[3];
  const enabledTargets = getEnabledPostTargets_(row);
  const job = getOrCreatePostJob_(
    row,
    rowNumber,
    enabledTargets,
    status
  );

  if (job.retryAfterAt && Date.now() < job.retryAfterAt) {
    return {
      completed: false,
      status: getPendingStatus_(job),
      job: job,
    };
  }

  for (let i = 0; i < enabledTargets.length; i++) {
    const target = enabledTargets[i];
    if (job.completedTargets.indexOf(target.header) !== -1) {
      continue;
    }

    const mediaLabel = video
      ? 'D列動画'
      : (image ? 'C列画像' : 'メディアなし');

    try {
      if (target.header === 'x_post') {
        const xResult = processXTarget_(
          job,
          text,
          image,
          video,
          deadlineMs
        );
        if (!xResult.completed) {
          return {
            completed: false,
            status: xResult.status,
            job: job,
          };
        }
      } else {
        if (!hasRequestTime_(deadlineMs)) {
          return {
            completed: false,
            status: POST_STATUS.POSTING,
            job: job,
          };
        }
        processInstagramTarget_(target, text, image, video);
      }
    } catch (e) {
      throw wrapTargetError_(e, target, mediaLabel, job);
    }

    addCompletedTarget_(job, target.header);
  }

  return {
    completed: true,
    completedTargets: getCompletedTargetLabels_(job),
    job: job,
  };
}

function getPendingStatus_(job) {
  if (
    job.x &&
    job.x.video &&
    job.x.video.phase === 'processing'
  ) {
    return POST_STATUS.PROCESSING;
  }
  if (
    job.x &&
    (
      job.x.postState === 'posting' ||
      job.x.postState === 'ready' ||
      job.x.postState === 'posted'
    )
  ) {
    return POST_STATUS.POSTING;
  }
  return POST_STATUS.UPLOADING;
}

function buildProgressMessage_(job, status) {
  if (job.retryAfterAt && Date.now() < job.retryAfterAt) {
    const retryAt = Utilities.formatDate(
      new Date(job.retryAfterAt),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss'
    );
    return (
      '一時エラーの再試行待ち (' +
      job.retryCount + '/' + MAX_TRANSIENT_RETRIES +
      ', 次回=' + retryAt + ')'
    );
  }

  const video = job.x && job.x.video;
  if (video && status === POST_STATUS.UPLOADING) {
    const totalSegments = Math.ceil(
      video.totalBytes / VIDEO_CHUNK_BYTES
    );
    return (
      'X動画アップロード中: ' +
      video.nextSegmentIndex + '/' + totalSegments +
      ' segments'
    );
  }
  if (video && status === POST_STATUS.PROCESSING) {
    return 'X動画処理待ち: media_id=' + video.mediaId;
  }
  if (status === POST_STATUS.POSTING) {
    return '投稿先処理中: 完了済み=' +
      (getCompletedTargetLabels_(job).join(',') || 'なし');
  }
  return '投稿処理中';
}

function writePendingRow_(sheet, rowNumber, result) {
  sheet.getRange(rowNumber, 5).setValue(result.status);
  sheet
    .getRange(rowNumber, 6)
    .setValue(buildProgressMessage_(result.job, result.status));

  if (result.job.lastTransientError) {
    sheet
      .getRange(rowNumber, ERROR_LOG_COLUMN)
      .setValue(result.job.lastTransientError);
  } else {
    sheet.getRange(rowNumber, ERROR_LOG_COLUMN).clearContent();
  }
}

function scheduleTransientRetry_(job, rowNumber, error) {
  if (!job || !error || error.retryable !== true) {
    return false;
  }

  job.retryCount = Number(job.retryCount || 0) + 1;
  if (job.retryCount > MAX_TRANSIENT_RETRIES) {
    return false;
  }

  const delayMs = Math.min(
    30 * 60 * 1000,
    Math.pow(2, job.retryCount - 1) * 60 * 1000
  );
  job.retryAfterAt = Date.now() + delayMs;
  job.lastTransientError = buildPostErrorLog_(rowNumber, error);
  savePostJob_(job);
  return true;
}

function checkAndPost() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('checkAndPost skipped: another execution is running.');
    return;
  }

  try {
    checkAndPostLocked_();
  } finally {
    lock.releaseLock();
  }
}

function checkAndPostLocked_() {
  const deadlineMs = Date.now() + EXECUTION_BUDGET_MS;
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }

  ensureErrorLogColumn_(sheet);

  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return;

  validatePostTargetColumns_(data[0]);

  const now = new Date();

  // ヘッダー行をスキップ (row 0)
  for (let i = 1; i < data.length; i++) {
    if (!hasRequestTime_(deadlineMs)) {
      Logger.log('checkAndPost paused before the execution deadline.');
      break;
    }

    const datetime = data[i][0]; // A列: datetime
    const status = data[i][4];   // E列: status
    const enabledTargets = getEnabledPostTargets_(data[i]);

    // 空行、投稿形式未選択、完了済み、要手動確認行はスキップ
    if (
      !datetime ||
      enabledTargets.length === 0 ||
      status === POST_STATUS.POSTED ||
      status === POST_STATUS.ERROR ||
      status === POST_STATUS.UNKNOWN
    ) continue;

    const postTime = new Date(datetime);
    if (Number.isNaN(postTime.getTime())) {
      const dateError = new Error(
        'A列のdatetimeを日付として解釈できません: ' + datetime
      );
      const dateErrorLog = buildPostErrorLog_(i + 1, dateError);
      sheet.getRange(i + 1, 5).setValue(POST_STATUS.ERROR);
      sheet.getRange(i + 1, 6).setValue(dateError.message);
      sheet.getRange(i + 1, ERROR_LOG_COLUMN).setValue(dateErrorLog);
      continue;
    }
    if (postTime > now) continue; // まだ時間じゃない

    try {
      const result = postRowToEnabledTargets_(
        data[i],
        i + 1,
        status,
        deadlineMs
      );
      if (!result.completed) {
        writePendingRow_(sheet, i + 1, result);
        continue;
      }

      Logger.log(
        'Row ' + (i + 1) + ' posted: ' +
        result.completedTargets.join(', ')
      );

      // ステータス更新
      sheet.getRange(i + 1, 5).setValue(POST_STATUS.POSTED);
      sheet.getRange(i + 1, 6).setValue(new Date());
      sheet.getRange(i + 1, ERROR_LOG_COLUMN).clearContent();
      deletePostJob_(i + 1);
    } catch (e) {
      const job = loadPostJob_(i + 1);
      if (scheduleTransientRetry_(job, i + 1, e)) {
        const retryResult = {
          completed: false,
          status: getPendingStatus_(job),
          job: job,
        };
        writePendingRow_(sheet, i + 1, retryResult);
        Logger.log(job.lastTransientError);
        continue;
      }

      const errorLog = buildPostErrorLog_(i + 1, e);
      Logger.log(errorLog);
      const finalStatus =
        job && job.x && job.x.postState === 'unknown'
          ? POST_STATUS.UNKNOWN
          : POST_STATUS.ERROR;
      sheet.getRange(i + 1, 5).setValue(finalStatus);
      sheet.getRange(i + 1, 6).setValue(e.message);
      sheet.getRange(i + 1, ERROR_LOG_COLUMN).setValue(errorLog);
    }
  }
}

// ====================
// トリガー設定
// ====================
function createTrigger() {
  // 既存トリガー削除
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // 10分おきに実行
  ScriptApp.newTrigger('checkAndPost')
    .timeBased()
    .everyMinutes(10)
    .create();
  Logger.log('Trigger created: checkAndPost every 10 minutes');
}

function deleteTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('All triggers deleted');
}

// ====================
// 初期設定ヘルパー
// ====================
function getConfigSheet_() {
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }
  return sheet;
}

function validateDataRowNumber_(rowNumber) {
  const value = Number(rowNumber);
  if (!Number.isInteger(value) || value < 2) {
    throw new Error('行番号は2以上の整数で指定してください。');
  }
  return value;
}

function inspectPostJob(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const job = loadPostJob_(targetRow);
  const result = {
    rowNumber: targetRow,
    found: Boolean(job),
    job: job,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function retryPostRow(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const sheet = getConfigSheet_();
  const status = String(sheet.getRange(targetRow, 5).getValue() || '');
  const job = loadPostJob_(targetRow);

  if (status === POST_STATUS.UNKNOWN) {
    throw new Error(
      'この行は投稿結果が不明です。X上の投稿有無を確認してから、' +
      '保存ジョブを手動処理してください。'
    );
  }
  if (job && job.x && job.x.postState === 'unknown') {
    throw new Error(
      '保存ジョブのX投稿結果が不明です。二重投稿防止のため再試行できません。'
    );
  }
  if (status !== POST_STATUS.ERROR) {
    throw new Error(
      'retryPostRowはstatus=errorの行だけに使用できます。現在=' +
      (status || '空欄')
    );
  }

  if (job) {
    job.retryCount = 0;
    job.retryAfterAt = null;
    job.lastTransientError = null;
    savePostJob_(job);
  }
  sheet.getRange(targetRow, 5).clearContent();
  sheet.getRange(targetRow, 6).clearContent();
  sheet.getRange(targetRow, ERROR_LOG_COLUMN).clearContent();

  const result = {
    rowNumber: targetRow,
    resumedExistingJob: Boolean(job),
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function resetPostRow(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const sheet = getConfigSheet_();
  const status = String(sheet.getRange(targetRow, 5).getValue() || '');
  const job = loadPostJob_(targetRow);

  if (status !== POST_STATUS.ERROR) {
    throw new Error(
      'resetPostRowはstatus=errorの行だけに使用できます。現在=' +
      (status || '空欄')
    );
  }
  if (
    job &&
    (
      (job.completedTargets && job.completedTargets.length > 0) ||
      (
        job.x &&
        (
          job.x.postState === 'posting' ||
          job.x.postState === 'posted' ||
          job.x.postState === 'unknown'
        )
      )
    )
  ) {
    throw new Error(
      '完了済みまたは結果不明の投稿先があります。' +
      '二重投稿防止のためジョブをリセットできません。'
    );
  }

  deletePostJob_(targetRow);
  sheet.getRange(targetRow, 5).clearContent();
  sheet.getRange(targetRow, 6).clearContent();
  sheet.getRange(targetRow, ERROR_LOG_COLUMN).clearContent();

  const result = {
    rowNumber: targetRow,
    deletedJob: Boolean(job),
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function testDriveVideoRangeFromSheetRow(rowNumber) {
  const targetRow = validateDataRowNumber_(rowNumber);
  const sheet = getConfigSheet_();
  const videoUrl = sheet.getRange(targetRow, 4).getValue();
  if (!videoUrl) {
    throw new Error('D列に動画URLがありません。Row ' + targetRow);
  }

  const fileId = extractDriveFileId_(videoUrl);
  const metadata = getDriveVideoMetadata_(fileId);
  validateXVideoMetadata_(metadata);

  const firstRange = calculateByteRange_(
    0,
    metadata.totalBytes,
    VIDEO_CHUNK_BYTES
  );
  const lastStart =
    Math.floor((metadata.totalBytes - 1) / VIDEO_CHUNK_BYTES) *
    VIDEO_CHUNK_BYTES;
  const lastRange = calculateByteRange_(
    lastStart,
    metadata.totalBytes,
    VIDEO_CHUNK_BYTES
  );
  const firstBytes = fetchDriveByteRange_(
    fileId,
    firstRange.start,
    firstRange.end
  );
  const lastBytes = fetchDriveByteRange_(
    fileId,
    lastRange.start,
    lastRange.end
  );

  const result = {
    rowNumber: targetRow,
    fileId: fileId,
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    totalBytes: metadata.totalBytes,
    totalSegments: Math.ceil(
      metadata.totalBytes / VIDEO_CHUNK_BYTES
    ),
    firstRange: firstRange,
    firstBytes: firstBytes.length,
    lastRange: lastRange,
    lastBytes: lastBytes.length,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function testDriveVideoRangeRow5() {
  return testDriveVideoRangeFromSheetRow(5);
}

function setApiKeys() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const keys = ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  keys.forEach(key => {
    const result = ui.prompt('Enter ' + key);
    if (result.getSelectedButton() === ui.Button.OK) {
      props.setProperty(key, result.getResponseText().trim());
    }
  });
  ui.alert('API keys saved to Script Properties.');
}
