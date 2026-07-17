// ====================
// 定数
// ====================
const SPREADSHEET_ID = '1tv3WyINPLComoybseAXIu-SOJ98DQ2C0NbCxieQEW3c';
const SHEET_NAME = 'Sheet1';

// スクリプトプロパティから取得
function getProps_() {
  const props = PropertiesService.getScriptProperties();
  return {
    consumerKey: props.getProperty('X_CONSUMER_KEY'),
    consumerSecret: props.getProperty('X_CONSUMER_SECRET'),
    accessToken: props.getProperty('X_ACCESS_TOKEN'),
    accessTokenSecret: props.getProperty('X_ACCESS_TOKEN_SECRET'),
  };
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
  const signingKey = percentEncode_(props.consumerSecret) + '&' + percentEncode_(props.accessTokenSecret);

  // HMAC-SHA1
  const signature = Utilities.base64Encode(
    Utilities.computeHmacSha256Signature(baseString, signingKey)
  );

  // ここで HMAC-SHA1 を使う
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
function uploadMedia_(blob, props) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
  const boundary = '----FormBoundary' + generateNonce_();

  const mediaData = Utilities.base64Encode(blob.getBytes());
  const mimeType = blob.getContentType();

  // multipart/form-data を手動構築
  const payload = Utilities.newBlob('').getBytes()
    .concat(Utilities.newBlob(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="media_data"\r\n\r\n' +
      mediaData + '\r\n' +
      '--' + boundary + '--\r\n'
    ).getBytes());

  const authHeader = buildOAuthHeader_('POST', url, {}, props);

  const options = {
    method: 'post',
    contentType: 'multipart/form-data; boundary=' + boundary,
    payload: payload,
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error('Media upload failed: ' + response.getContentText());
  }
  const result = JSON.parse(response.getContentText());
  return result.media_id_string;
}

// チャンク式アップロード（動画用）
function uploadVideoMedia_(blob, props) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
  const totalBytes = blob.getBytes().length;
  const mimeType = blob.getContentType();

  // INIT
  const initParams = {
    command: 'INIT',
    total_bytes: totalBytes.toString(),
    media_type: mimeType,
    media_category: 'tweet_video',
  };
  const initAuth = buildOAuthHeader_('POST', url, initParams, props);
  const initResp = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: initParams,
    headers: { Authorization: initAuth },
    muteHttpExceptions: true,
  });
  if (initResp.getResponseCode() !== 200 && initResp.getResponseCode() !== 202) {
    throw new Error('Video INIT failed: ' + initResp.getContentText());
  }
  const mediaId = JSON.parse(initResp.getContentText()).media_id_string;

  // APPEND (5MB chunks)
  const chunkSize = 5 * 1024 * 1024;
  const bytes = blob.getBytes();
  let segmentIndex = 0;
  for (let i = 0; i < totalBytes; i += chunkSize) {
    const chunk = bytes.slice(i, Math.min(i + chunkSize, totalBytes));
    const boundary = '----FormBoundary' + generateNonce_();
    const appendPayload = Utilities.newBlob('').getBytes()
      .concat(Utilities.newBlob(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="command"\r\n\r\nAPPEND\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="media_id"\r\n\r\n' + mediaId + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="segment_index"\r\n\r\n' + segmentIndex + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="media_data"\r\n\r\n' +
        Utilities.base64Encode(chunk) + '\r\n' +
        '--' + boundary + '--\r\n'
      ).getBytes());

    const appendAuth = buildOAuthHeader_('POST', url, {}, props);
    const appendResp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'multipart/form-data; boundary=' + boundary,
      payload: appendPayload,
      headers: { Authorization: appendAuth },
      muteHttpExceptions: true,
    });
    if (appendResp.getResponseCode() !== 204 && appendResp.getResponseCode() !== 200) {
      throw new Error('Video APPEND failed: ' + appendResp.getContentText());
    }
    segmentIndex++;
  }

  // FINALIZE
  const finalizeParams = { command: 'FINALIZE', media_id: mediaId };
  const finalizeAuth = buildOAuthHeader_('POST', url, finalizeParams, props);
  const finalizeResp = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: finalizeParams,
    headers: { Authorization: finalizeAuth },
    muteHttpExceptions: true,
  });
  if (finalizeResp.getResponseCode() !== 200 && finalizeResp.getResponseCode() !== 201) {
    throw new Error('Video FINALIZE failed: ' + finalizeResp.getContentText());
  }

  // STATUS チェック（処理待ち）
  const finalizeResult = JSON.parse(finalizeResp.getContentText());
  if (finalizeResult.processing_info) {
    waitForProcessing_(url, mediaId, props);
  }

  return mediaId;
}

function waitForProcessing_(url, mediaId, props) {
  for (let i = 0; i < 30; i++) {
    Utilities.sleep(5000);
    const statusParams = { command: 'STATUS', media_id: mediaId };
    const statusAuth = buildOAuthHeader_('GET', url, statusParams, props);
    const statusResp = UrlFetchApp.fetch(url + '?command=STATUS&media_id=' + mediaId, {
      method: 'get',
      headers: { Authorization: statusAuth },
      muteHttpExceptions: true,
    });
    const statusResult = JSON.parse(statusResp.getContentText());
    if (!statusResult.processing_info || statusResult.processing_info.state === 'succeeded') {
      return;
    }
    if (statusResult.processing_info.state === 'failed') {
      throw new Error('Video processing failed: ' + JSON.stringify(statusResult.processing_info.error));
    }
  }
  throw new Error('Video processing timed out');
}

// ====================
// Google Drive からファイル取得
// ====================
function getFileFromDriveUrl_(driveUrl) {
  const match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Invalid Drive URL: ' + driveUrl);
  const fileId = match[1];
  return DriveApp.getFileById(fileId).getBlob();
}

// ====================
// ツイート投稿 (v2)
// ====================
function postTweet_(text, mediaIds, props) {
  const url = 'https://api.twitter.com/2/tweets';
  const payload = { text: text };
  if (mediaIds && mediaIds.length > 0) {
    payload.media = { media_ids: mediaIds };
  }

  const jsonPayload = JSON.stringify(payload);
  const authHeader = buildOAuthHeader_('POST', url, {}, props);

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: jsonPayload,
    headers: { Authorization: authHeader },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('Tweet failed (' + code + '): ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

// ====================
// メイン: スケジュール投稿チェック
// ====================
function checkAndPost() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  const props = getProps_();

  // ヘッダー行をスキップ (row 0)
  for (let i = 1; i < data.length; i++) {
    const datetime = data[i][0]; // A列: datetime
    const text = data[i][1];     // B列: text
    const image = data[i][2];    // C列: image
    const video = data[i][3];    // D列: video
    const status = data[i][4];   // E列: status

    // 空行 or 投稿済みはスキップ
    if (!datetime || status === 'posted' || status === 'error') continue;

    const postTime = new Date(datetime);
    if (postTime > now) continue; // まだ時間じゃない

    try {
      const mediaIds = [];

      // 画像アップロード
      if (image) {
        const blob = getFileFromDriveUrl_(image);
        const mediaId = uploadMedia_(blob, props);
        mediaIds.push(mediaId);
      }

      // 動画アップロード
      if (video) {
        const blob = getFileFromDriveUrl_(video);
        const mediaId = uploadVideoMedia_(blob, props);
        mediaIds.push(mediaId);
      }

      // ツイート投稿
      postTweet_(text, mediaIds, props);

      // ステータス更新
      sheet.getRange(i + 1, 5).setValue('posted');
      sheet.getRange(i + 1, 6).setValue(new Date());
    } catch (e) {
      Logger.log('Row ' + (i + 1) + ' error: ' + e.message);
      sheet.getRange(i + 1, 5).setValue('error');
      sheet.getRange(i + 1, 6).setValue(e.message);
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
