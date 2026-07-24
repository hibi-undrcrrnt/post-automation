const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'コード.js'),
  'utf8'
);

const context = {
  console,
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(algorithm, value) {
      return Array.from(
        crypto.createHash(algorithm).update(value, 'utf8').digest()
      );
    },
    base64EncodeWebSafe(bytes) {
      return Buffer.from(bytes)
        .toString('base64url');
    },
  },
};
vm.createContext(context);
vm.runInContext(source, context);

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n`);
    throw error;
  }
}

test('Drive URLからファイルIDを抽出する', () => {
  assert.equal(
    context.extractDriveFileId_(
      'https://drive.google.com/file/d/abcDEF_123-xyz/view?usp=sharing'
    ),
    'abcDEF_123-xyz'
  );
  assert.equal(
    context.extractDriveFileId_(
      'https://drive.google.com/open?id=abcDEF_123-xyz'
    ),
    'abcDEF_123-xyz'
  );
  assert.equal(
    context.extractDriveFileId_('abcDEF_123-xyz'),
    'abcDEF_123-xyz'
  );
  assert.throws(
    () => context.extractDriveFileId_('https://example.com/video.mp4'),
    /Invalid Drive URL/
  );
});

test('5MiB単位のバイト範囲を計算する', () => {
  const chunkBytes = 5 * 1024 * 1024;
  assert.deepEqual(
    { ...context.calculateByteRange_(0, 175046848, chunkBytes) },
    { start: 0, end: 5242879 }
  );
  assert.deepEqual(
    {
      ...context.calculateByteRange_(
        33 * chunkBytes,
        175046848,
        chunkBytes
      ),
    },
    { start: 173015040, end: 175046847 }
  );
  assert.throws(
    () => context.calculateByteRange_(100, 100, chunkBytes),
    /Invalid byte range input/
  );
});

test('対象動画は欠落や重複なく34セグメントになる', () => {
  const totalBytes = 175046848;
  const chunkBytes = 5 * 1024 * 1024;
  let offset = 0;
  let segments = 0;
  let coveredBytes = 0;

  while (offset < totalBytes) {
    const range = context.calculateByteRange_(
      offset,
      totalBytes,
      chunkBytes
    );
    assert.equal(range.start, offset);
    coveredBytes += range.end - range.start + 1;
    offset = range.end + 1;
    segments += 1;
  }

  assert.equal(segments, 34);
  assert.equal(coveredBytes, totalBytes);
  assert.equal(offset, totalBytes);
});

test('HTTP再試行対象を分類する', () => {
  assert.equal(context.isRetryableHttpStatus_(408), true);
  assert.equal(context.isRetryableHttpStatus_(429), true);
  assert.equal(context.isRetryableHttpStatus_(500), true);
  assert.equal(context.isRetryableHttpStatus_(401), false);
  assert.equal(context.isRetryableHttpStatus_(422), false);
});

test('X動画メタデータ要件を検証する', () => {
  assert.doesNotThrow(() => context.validateXVideoMetadata_({
    mimeType: 'video/mp4',
    totalBytes: 175046848,
    durationMillis: 30000,
  }));
  assert.throws(
    () => context.validateXVideoMetadata_({
      mimeType: 'video/webm',
      totalBytes: 175046848,
      durationMillis: 30000,
    }),
    /MP4\/MOV/
  );
  assert.throws(
    () => context.validateXVideoMetadata_({
      mimeType: 'video/mp4',
      totalBytes: 175046848,
      durationMillis: 141000,
    }),
    /140秒/
  );
});

test('行フィンガープリントは投稿内容の変更を検出する', () => {
  const targets = [{ header: 'x_post' }];
  const row = [
    '2026/07/25 11:00:00',
    'caption',
    '',
    'https://drive.google.com/file/d/abcDEF_123-xyz/view',
  ];
  const first = context.buildRowFingerprint_(row, targets);
  const second = context.buildRowFingerprint_(row.slice(), targets);
  const changed = row.slice();
  changed[1] = 'changed caption';

  assert.equal(first, second);
  assert.notEqual(
    first,
    context.buildRowFingerprint_(changed, targets)
  );
});

test('投稿済みXジョブは外部APIを再呼び出さない', () => {
  const result = context.processXTarget_(
    {
      x: { postState: 'posted' },
    },
    'text',
    '',
    'video',
    Date.now() + 60000
  );
  assert.equal(result.completed, true);
});

test('Drive Rangeから全チャンクを送りprocessing状態を保存する', () => {
  const totalBytes = 12 * 1024 * 1024 + 123;
  const ranges = [];
  const segments = [];
  let saves = 0;

  context.getDriveVideoMetadata_ = fileId => ({
    fileId,
    fileName: 'large.mp4',
    mimeType: 'video/mp4',
    totalBytes,
    modifiedTime: '2026-07-25T00:00:00.000Z',
    durationMillis: 30000,
    width: 1280,
    height: 720,
  });
  context.fetchDriveByteRange_ = (fileId, start, end) => {
    ranges.push({ fileId, start, end });
    return { length: end - start + 1 };
  };
  context.initializeXVideoUpload_ = () => ({
    media_id_string: 'media-1',
    expires_after_secs: 3600,
  });
  context.appendXVideoChunk_ = video => {
    segments.push(video.nextSegmentIndex);
  };
  context.finalizeXVideoUpload_ = () => ({
    processing_info: {
      state: 'pending',
      check_after_secs: 5,
    },
  });
  context.savePostJob_ = () => {
    saves += 1;
  };

  const job = {
    rowNumber: 5,
    retryCount: 0,
    retryAfterAt: null,
    x: { video: null },
  };
  const result = context.processXVideoUpload_(
    job,
    'https://drive.google.com/file/d/abcDEF_123-xyz/view',
    {},
    Date.now() + 180000
  );

  assert.equal(result.completed, false);
  assert.equal(result.status, 'processing');
  assert.deepEqual(segments, [0, 1, 2]);
  assert.equal(ranges.length, 3);
  assert.equal(ranges[2].end, totalBytes - 1);
  assert.equal(job.x.video.nextByteOffset, totalBytes);
  assert.equal(job.x.video.phase, 'processing');
  assert.ok(job.x.video.checkAfterAt > Date.now());
  assert.ok(saves >= 5);
});

test('processing再開後にSTATUS succeededでreadyになる', () => {
  const video = {
    fileId: 'abcDEF_123-xyz',
    fileName: 'large.mp4',
    mimeType: 'video/mp4',
    totalBytes: 175046848,
    modifiedTime: '2026-07-25T00:00:00.000Z',
    durationMillis: 30000,
    width: 1280,
    height: 720,
    phase: 'processing',
    mediaId: 'media-1',
    nextSegmentIndex: 34,
    nextByteOffset: 175046848,
    expiresAt: Date.now() + 3600000,
    checkAfterAt: 0,
  };
  context.getDriveVideoMetadata_ = () => ({
    fileId: video.fileId,
    fileName: video.fileName,
    mimeType: video.mimeType,
    totalBytes: video.totalBytes,
    modifiedTime: video.modifiedTime,
    durationMillis: video.durationMillis,
    width: video.width,
    height: video.height,
  });
  context.getXVideoUploadStatus_ = () => ({
    processing_info: { state: 'succeeded' },
  });
  context.savePostJob_ = () => {};

  const result = context.processXVideoUpload_(
    {
      rowNumber: 5,
      retryCount: 0,
      retryAfterAt: null,
      x: { video },
    },
    'unused',
    {},
    Date.now() + 60000
  );

  assert.equal(result.completed, true);
  assert.equal(result.mediaId, 'media-1');
  assert.equal(video.phase, 'ready');
});

test('TweetのHTTPエラーは既知失敗としてreadyへ戻す', () => {
  context.getProps_ = () => ({});
  context.hasRequestTime_ = () => true;
  context.savePostJob_ = () => {};
  context.postTweet_ = () => {
    const error = new Error('rate limited');
    error.httpStatus = 429;
    error.retryable = true;
    throw error;
  };
  const job = {
    rowNumber: 5,
    x: {
      postState: 'not_started',
      imageMediaId: null,
      video: null,
    },
  };

  assert.throws(
    () => context.processXTarget_(
      job,
      'text',
      '',
      '',
      Date.now() + 60000
    ),
    /rate limited/
  );
  assert.equal(job.x.postState, 'ready');
});
