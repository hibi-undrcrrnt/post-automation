// ====================
// Instagram画像・動画投稿
// ====================
const INSTAGRAM_DEFAULT_API_VERSION = 'v23.0';
const INSTAGRAM_GRAPH_ORIGIN = 'https://graph.instagram.com';
const INSTAGRAM_STORY_MAX_VIDEO_SECONDS = 60;
const INSTAGRAM_REEL_MIN_VIDEO_SECONDS = 3;
const INSTAGRAM_REEL_MAX_VIDEO_SECONDS = 15 * 60;
const INSTAGRAM_MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

function getInstagramConfig_() {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty('INSTAGRAM_ACCESS_TOKEN');

  if (!accessToken) {
    throw new Error(
      'Script Property「INSTAGRAM_ACCESS_TOKEN」が設定されていません。'
    );
  }

  return {
    accessToken: accessToken,
    apiVersion:
      props.getProperty('INSTAGRAM_API_VERSION') ||
      INSTAGRAM_DEFAULT_API_VERSION,
  };
}

function instagramRequest_(path, method, params, config) {
  const requestMethod = (method || 'get').toLowerCase();
  const requestParams = params || {};
  let url =
    INSTAGRAM_GRAPH_ORIGIN +
    '/' + config.apiVersion +
    '/' + String(path).replace(/^\/+/, '');

  const options = {
    method: requestMethod,
    headers: {
      Authorization: 'Bearer ' + config.accessToken,
    },
    muteHttpExceptions: true,
  };

  if (requestMethod === 'get') {
    const query = Object.keys(requestParams)
      .filter(key => requestParams[key] !== '' && requestParams[key] != null)
      .map(key =>
        encodeURIComponent(key) + '=' +
        encodeURIComponent(String(requestParams[key]))
      )
      .join('&');
    if (query) url += '?' + query;
  } else {
    options.payload = requestParams;
  }

  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  let result;

  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch (e) {
    throw new Error(
      'Instagram APIがJSON以外を返しました (' + statusCode + '): ' +
      responseText.slice(0, 500)
    );
  }

  if (statusCode < 200 || statusCode >= 300 || result.error) {
    const error = result.error || {};
    const details = [
      error.message || responseText || 'Unknown error',
      error.type ? 'type=' + error.type : '',
      error.code != null ? 'code=' + error.code : '',
      error.error_subcode != null
        ? 'subcode=' + error.error_subcode
        : '',
      error.fbtrace_id ? 'fbtrace_id=' + error.fbtrace_id : '',
    ].filter(Boolean).join(', ');
    throw new Error(
      'Instagram API request failed (' + statusCode + '): ' + details
    );
  }

  return result;
}

function getInstagramAccount() {
  const config = getInstagramConfig_();
  const account = instagramRequest_(
    'me',
    'get',
    { fields: 'id,user_id,username' },
    config
  );

  return {
    userId: account.user_id || account.id,
    username: account.username,
    apiVersion: config.apiVersion,
  };
}

function assertPublicInstagramImageUrl_(imageUrl) {
  const response = UrlFetchApp.fetch(imageUrl, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
  });
  const statusCode = response.getResponseCode();
  const contentType = String(
    response.getHeaders()['Content-Type'] ||
    response.getHeaders()['content-type'] ||
    ''
  ).toLowerCase();

  if (statusCode !== 200 || contentType.indexOf('image/jpeg') !== 0) {
    throw new Error(
      '画像URLを匿名でJPEGとして取得できません。' +
      ' HTTP ' + statusCode + ', Content-Type: ' + contentType
    );
  }
}

function normalizeInstagramImageUrl_(imageUrl) {
  const value = String(imageUrl || '').trim();
  const fileId = getGoogleDriveFileId_(value);

  if (!fileId) return value;

  return (
    'https://drive.google.com/uc?export=download&id=' +
    encodeURIComponent(fileId)
  );
}

function getGoogleDriveFileId_(driveUrl) {
  const value = String(driveUrl || '').trim();
  const pathMatch = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const queryMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return pathMatch ? pathMatch[1] : (queryMatch ? queryMatch[1] : '');
}

function getInstagramDriveVideoMetadata_(videoUrl) {
  const fileId = getGoogleDriveFileId_(videoUrl);
  if (!fileId) return null;

  const fields =
    'id,name,mimeType,size,' +
    'videoMediaMetadata(durationMillis,width,height)';
  const url =
    'https://www.googleapis.com/drive/v3/files/' +
    encodeURIComponent(fileId) +
    '?fields=' + encodeURIComponent(fields);
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    muteHttpExceptions: true,
  });
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      'Drive動画メタデータの取得に失敗しました。' +
      ' HTTP ' + statusCode + ': ' + responseText.slice(0, 500)
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(
      'Drive動画メタデータがJSONではありません: ' +
      responseText.slice(0, 500)
    );
  }
}

function formatInstagramVideoMetadata_(metadata) {
  if (!metadata) return '';

  const video = metadata.videoMediaMetadata || {};
  const durationSeconds =
    video.durationMillis != null
      ? Number(video.durationMillis) / 1000
      : null;
  const details = [
    metadata.name ? 'ファイル=' + metadata.name : '',
    metadata.mimeType ? 'MIME=' + metadata.mimeType : '',
    Number.isFinite(durationSeconds)
      ? '長さ=' + durationSeconds.toFixed(2) + '秒'
      : '',
    video.width && video.height
      ? '解像度=' + video.width + 'x' + video.height
      : '',
    metadata.size
      ? 'サイズ=' +
        (Number(metadata.size) / 1024 / 1024).toFixed(2) + 'MB'
      : '',
  ].filter(Boolean);

  return details.join(', ');
}

function validateInstagramVideoForTarget_(videoUrl, mediaType) {
  const metadata = getInstagramDriveVideoMetadata_(videoUrl);
  if (!metadata) return null;

  const video = metadata.videoMediaMetadata || {};
  const durationSeconds =
    video.durationMillis != null
      ? Number(video.durationMillis) / 1000
      : null;
  const fileSize = Number(metadata.size);
  const targetLabel =
    mediaType === 'STORIES' ? 'Instagram Stories' : 'Instagram Reels';
  const issues = [];

  if (
    metadata.mimeType !== 'video/mp4' &&
    metadata.mimeType !== 'video/quicktime'
  ) {
    issues.push(
      '動画形式がMP4/MOVではありません (' +
      String(metadata.mimeType || '不明') + ')'
    );
  }

  if (Number.isFinite(durationSeconds)) {
    if (
      mediaType === 'STORIES' &&
      durationSeconds > INSTAGRAM_STORY_MAX_VIDEO_SECONDS
    ) {
      issues.push(
        '動画がStories上限60秒を超えています (' +
        durationSeconds.toFixed(2) + '秒)'
      );
    }

    if (
      mediaType === 'REELS' &&
      (
        durationSeconds < INSTAGRAM_REEL_MIN_VIDEO_SECONDS ||
        durationSeconds > INSTAGRAM_REEL_MAX_VIDEO_SECONDS
      )
    ) {
      issues.push(
        '動画がReelsの長さ要件3秒以上15分以内を満たしていません (' +
        durationSeconds.toFixed(2) + '秒)'
      );
    }
  }

  if (Number.isFinite(fileSize) && fileSize > INSTAGRAM_MAX_VIDEO_BYTES) {
    issues.push(
      '動画サイズが上限1GBを超えています (' +
      (fileSize / 1024 / 1024).toFixed(2) + 'MB)'
    );
  }

  if (video.width && Number(video.width) > 1920) {
    issues.push(
      '動画の横幅が上限1920pxを超えています (' +
      video.width + 'px)'
    );
  }

  if (issues.length > 0) {
    throw new Error(
      targetLabel + '動画の事前検証NG: ' +
      issues.join(' / ') +
      ' [' + formatInstagramVideoMetadata_(metadata) + ']'
    );
  }

  return metadata;
}

function buildPublicGoogleDriveDownloadUrl_(file) {
  let url =
    'https://drive.google.com/uc?export=download&id=' +
    encodeURIComponent(file.getId());
  const resourceKey = file.getResourceKey();

  if (resourceKey) {
    url += '&resourcekey=' + encodeURIComponent(resourceKey);
  }
  return url;
}

function ensurePublicInstagramMediaUrl_(mediaUrl) {
  const value = String(mediaUrl || '').trim();
  const fileId = getGoogleDriveFileId_(value);
  if (!fileId) return value;

  const file = DriveApp.getFileById(fileId);
  const sharingAccess = file.getSharingAccess();
  const isPublic =
    sharingAccess === DriveApp.Access.ANYONE ||
    sharingAccess === DriveApp.Access.ANYONE_WITH_LINK;

  if (!isPublic) {
    file.setSharing(
      DriveApp.Access.ANYONE_WITH_LINK,
      DriveApp.Permission.VIEW
    );
    Logger.log(
      'Instagram投稿用にDriveファイルをリンク公開しました: ' + fileId
    );
    Utilities.sleep(1000);
  }

  return buildPublicGoogleDriveDownloadUrl_(file);
}

function normalizeInstagramVideoUrl_(videoUrl) {
  return normalizeInstagramImageUrl_(videoUrl);
}

function assertPublicInstagramVideoUrl_(videoUrl) {
  const response = UrlFetchApp.fetch(videoUrl, {
    method: 'get',
    headers: {
      Range: 'bytes=0-0',
    },
    followRedirects: true,
    muteHttpExceptions: true,
  });
  const statusCode = response.getResponseCode();
  const contentType = String(
    response.getHeaders()['Content-Type'] ||
    response.getHeaders()['content-type'] ||
    ''
  ).toLowerCase();
  const supportedContentType =
    contentType.indexOf('video/') === 0 ||
    contentType.indexOf('application/octet-stream') === 0;

  if (statusCode < 200 || statusCode >= 300 || !supportedContentType) {
    throw new Error(
      '動画URLを匿名で動画ファイルとして取得できません。' +
      ' HTTP ' + statusCode + ', Content-Type: ' + contentType
    );
  }
}

function createInstagramImageContainer_(imageUrl, caption, config) {
  const result = instagramRequest_(
    'me/media',
    'post',
    {
      image_url: imageUrl,
      caption: caption || '',
    },
    config
  );

  if (!result.id) {
    throw new Error('Instagram画像コンテナIDを取得できませんでした。');
  }
  return result.id;
}

function createInstagramImageStoryContainer_(imageUrl, config) {
  const result = instagramRequest_(
    'me/media',
    'post',
    {
      image_url: imageUrl,
      media_type: 'STORIES',
    },
    config
  );

  if (!result.id) {
    throw new Error('InstagramストーリーズコンテナIDを取得できませんでした。');
  }
  return result.id;
}

function createInstagramVideoContainer_(videoUrl, caption, config) {
  const result = instagramRequest_(
    'me/media',
    'post',
    {
      video_url: videoUrl,
      media_type: 'REELS',
      caption: caption || '',
      share_to_feed: 'true',
    },
    config
  );

  if (!result.id) {
    throw new Error('Instagram動画コンテナIDを取得できませんでした。');
  }
  return result.id;
}

function createInstagramVideoStoryContainer_(videoUrl, config) {
  const result = instagramRequest_(
    'me/media',
    'post',
    {
      video_url: videoUrl,
      media_type: 'STORIES',
    },
    config
  );

  if (!result.id) {
    throw new Error(
      'Instagram動画ストーリーズコンテナIDを取得できませんでした。'
    );
  }
  return result.id;
}

function waitForInstagramContainer_(containerId, config) {
  for (let i = 0; i < 24; i++) {
    const result = instagramRequest_(
      containerId,
      'get',
      { fields: 'status_code,status' },
      config
    );
    const statusCode = result.status_code;

    if (statusCode === 'FINISHED') return result;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(
        'Instagramメディア処理に失敗しました: ' +
        (result.status || statusCode) +
        ' (containerId=' + containerId +
        ', response=' + JSON.stringify(result) + ')'
      );
    }

    Utilities.sleep(2500);
  }

  throw new Error('Instagramメディア処理が60秒以内に完了しませんでした。');
}

function publishInstagramContainer_(containerId, config) {
  const result = instagramRequest_(
    'me/media_publish',
    'post',
    { creation_id: containerId },
    config
  );

  if (!result.id) {
    throw new Error('Instagram投稿IDを取得できませんでした。');
  }
  return result.id;
}

function getInstagramMedia_(mediaId, config) {
  return instagramRequest_(
    mediaId,
    'get',
    {
      fields:
        'id,media_type,media_product_type,permalink,timestamp,username',
    },
    config
  );
}

function postInstagramImageByUrl(imageUrl, caption) {
  const normalizedImageUrl = ensurePublicInstagramMediaUrl_(imageUrl);
  if (!normalizedImageUrl) {
    throw new Error('Instagramへ投稿する画像URLが空です。');
  }

  assertPublicInstagramImageUrl_(normalizedImageUrl);

  const config = getInstagramConfig_();
  const containerId = createInstagramImageContainer_(
    normalizedImageUrl,
    caption,
    config
  );
  waitForInstagramContainer_(containerId, config);
  const mediaId = publishInstagramContainer_(containerId, config);

  let media = { id: mediaId };
  try {
    media = getInstagramMedia_(mediaId, config);
  } catch (e) {
    Logger.log(
      'Instagram投稿後の詳細取得に失敗しました: ' + e.message
    );
  }

  return {
    mediaId: mediaId,
    containerId: containerId,
    permalink: media.permalink || '',
    username: media.username || '',
    timestamp: media.timestamp || '',
  };
}

function postInstagramImageStoryByUrl(imageUrl) {
  const normalizedImageUrl = ensurePublicInstagramMediaUrl_(imageUrl);
  if (!normalizedImageUrl) {
    throw new Error('Instagramストーリーズへ投稿する画像URLが空です。');
  }

  assertPublicInstagramImageUrl_(normalizedImageUrl);

  const config = getInstagramConfig_();
  const containerId = createInstagramImageStoryContainer_(
    normalizedImageUrl,
    config
  );
  waitForInstagramContainer_(containerId, config);
  const mediaId = publishInstagramContainer_(containerId, config);

  let media = { id: mediaId };
  try {
    media = getInstagramMedia_(mediaId, config);
  } catch (e) {
    Logger.log(
      'Instagramストーリーズ投稿後の詳細取得に失敗しました: ' + e.message
    );
  }

  return {
    mediaId: mediaId,
    containerId: containerId,
    permalink: media.permalink || '',
    username: media.username || '',
    timestamp: media.timestamp || '',
  };
}

function postInstagramVideoByUrl(videoUrl, caption) {
  const normalizedVideoUrl = ensurePublicInstagramMediaUrl_(videoUrl);
  if (!normalizedVideoUrl) {
    throw new Error('Instagramへ投稿する動画URLが空です。');
  }

  const videoMetadata = validateInstagramVideoForTarget_(
    normalizedVideoUrl,
    'REELS'
  );
  assertPublicInstagramVideoUrl_(normalizedVideoUrl);

  const config = getInstagramConfig_();
  const containerId = createInstagramVideoContainer_(
    normalizedVideoUrl,
    caption,
    config
  );
  try {
    waitForInstagramContainer_(containerId, config);
  } catch (e) {
    throw new Error(
      e.message +
      (
        videoMetadata
          ? ' [' + formatInstagramVideoMetadata_(videoMetadata) + ']'
          : ''
      )
    );
  }
  const mediaId = publishInstagramContainer_(containerId, config);

  let media = { id: mediaId };
  try {
    media = getInstagramMedia_(mediaId, config);
  } catch (e) {
    Logger.log(
      'Instagram動画投稿後の詳細取得に失敗しました: ' + e.message
    );
  }

  return {
    mediaId: mediaId,
    containerId: containerId,
    permalink: media.permalink || '',
    mediaProductType: media.media_product_type || '',
    username: media.username || '',
    timestamp: media.timestamp || '',
  };
}

function postInstagramVideoStoryByUrl(videoUrl) {
  const normalizedVideoUrl = ensurePublicInstagramMediaUrl_(videoUrl);
  if (!normalizedVideoUrl) {
    throw new Error('Instagramストーリーズへ投稿する動画URLが空です。');
  }

  const videoMetadata = validateInstagramVideoForTarget_(
    normalizedVideoUrl,
    'STORIES'
  );
  assertPublicInstagramVideoUrl_(normalizedVideoUrl);

  const config = getInstagramConfig_();
  const containerId = createInstagramVideoStoryContainer_(
    normalizedVideoUrl,
    config
  );
  try {
    waitForInstagramContainer_(containerId, config);
  } catch (e) {
    throw new Error(
      e.message +
      (
        videoMetadata
          ? ' [' + formatInstagramVideoMetadata_(videoMetadata) + ']'
          : ''
      )
    );
  }
  const mediaId = publishInstagramContainer_(containerId, config);

  let media = { id: mediaId };
  try {
    media = getInstagramMedia_(mediaId, config);
  } catch (e) {
    Logger.log(
      'Instagram動画ストーリーズ投稿後の詳細取得に失敗しました: ' +
      e.message
    );
  }

  return {
    mediaId: mediaId,
    containerId: containerId,
    permalink: media.permalink || '',
    username: media.username || '',
    timestamp: media.timestamp || '',
  };
}

function postInstagramImageFromSheetRow(rowNumber) {
  const targetRow = Number(rowNumber);
  if (!Number.isInteger(targetRow) || targetRow < 2) {
    throw new Error('投稿対象の行番号は2以上の整数で指定してください。');
  }

  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }

  const row = sheet.getRange(targetRow, 1, 1, 7).getValues()[0];
  const caption = row[1];
  const imageUrl = row[2];

  if (!imageUrl) {
    throw new Error(
      SHEET_NAME + '!' + targetRow + '行目のC列に画像URLがありません。'
    );
  }

  const result = postInstagramImageByUrl(imageUrl, caption);
  return Object.assign(
    {
      sheet: SHEET_NAME,
      row: targetRow,
    },
    result
  );
}

function postInstagramImageStoryFromSheetRow(rowNumber) {
  const targetRow = Number(rowNumber);
  if (!Number.isInteger(targetRow) || targetRow < 2) {
    throw new Error('投稿対象の行番号は2以上の整数で指定してください。');
  }

  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');
  }

  const imageUrl = sheet.getRange(targetRow, 3).getValue();
  if (!imageUrl) {
    throw new Error(
      SHEET_NAME + '!' + targetRow + '行目のC列に画像URLがありません。'
    );
  }

  const result = postInstagramImageStoryByUrl(imageUrl);
  return Object.assign(
    {
      sheet: SHEET_NAME,
      row: targetRow,
    },
    result
  );
}

function checkInstagramSetup() {
  const account = getInstagramAccount();
  const sheet = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(SHEET_NAME);

  return {
    tokenConfigured: true,
    account: account,
    sheetFound: Boolean(sheet),
    sheetName: SHEET_NAME,
  };
}

function testDriveSharingPermission() {
  let testFile;

  try {
    testFile = DriveApp.createFile(
      'instagram-drive-sharing-permission-test.txt',
      'This temporary file can be deleted.'
    );
    testFile.setSharing(
      DriveApp.Access.ANYONE_WITH_LINK,
      DriveApp.Permission.VIEW
    );

    const sharingAccess = testFile.getSharingAccess();
    const success =
      sharingAccess === DriveApp.Access.ANYONE ||
      sharingAccess === DriveApp.Access.ANYONE_WITH_LINK;
    const result = {
      success: success,
      sharingAccess: String(sharingAccess),
    };

    console.log(JSON.stringify(result));

    if (!success) {
      throw new Error(
        'Driveファイルをリンク公開に変更できませんでした: ' +
        String(sharingAccess)
      );
    }

    return result;
  } finally {
    if (testFile) {
      testFile.setTrashed(true);
      console.log('権限テスト用の一時ファイルをゴミ箱へ移動しました。');
    }
  }
}
