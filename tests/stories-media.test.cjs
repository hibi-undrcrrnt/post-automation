const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {
  console,
  Logger: {
    log() {},
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(algorithm, value) {
      return Array.from(
        crypto.createHash(algorithm).update(value, 'utf8').digest()
      );
    },
    base64EncodeWebSafe(bytes) {
      return Buffer.from(bytes).toString('base64url');
    },
  },
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'コード.js'), 'utf8'),
  context
);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'StoriesMedia.js'), 'utf8'),
  context
);

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n`);
    throw error;
  }
}

function metadata(overrides = {}) {
  return {
    fileId: 'drive-file-123',
    fileName: 'landscape.mp4',
    mimeType: 'video/mp4',
    totalBytes: 20 * 1024 * 1024,
    modifiedTime: '2026-07-25T00:00:00.000Z',
    md5Checksum: '0123456789abcdef0123456789abcdef',
    width: 1920,
    height: 1080,
    durationMillis: 30000,
    ...overrides,
  };
}

const config = {
  enabled: true,
  projectId: 'sample-project',
  region: 'asia-northeast1',
  jobName: 'story-transform',
  bucket: 'sample-story-output',
  backgroundColor: '000000',
  leadMinutes: 120,
  maxDelayMinutes: 30,
};

function newJob() {
  return {
    rowNumber: 2,
    completedTargets: [],
    x: { postState: 'not_started' },
    instagram: { story: null },
  };
}

test('変換フィンガープリントはDrive更新を検出する', () => {
  const first = context.buildStoryTransformFingerprint_(
    metadata(),
    'video',
    config
  );
  const second = context.buildStoryTransformFingerprint_(
    metadata(),
    'video',
    config
  );
  const changed = context.buildStoryTransformFingerprint_(
    metadata({ modifiedTime: '2026-07-25T01:00:00.000Z' }),
    'video',
    config
  );
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test('未開始ジョブをCloud Runへ投入してsubmittedを保存する', () => {
  const job = newJob();
  let saves = 0;
  context.getStoryDriveMetadata_ = () => metadata();
  context.hasRequestTime_ = () => true;
  context.invokeStoryTransformJob_ = () =>
    'projects/sample/locations/region/operations/op-1';
  context.savePostJob_ = () => {
    saves += 1;
  };

  const result = context.advanceInstagramStoryPreparation_(
    job,
    'https://drive.google.com/file/d/drive-file-123/view',
    'video',
    new Date(Date.now() + 60 * 60 * 1000),
    Date.now() + 60000,
    config
  );

  assert.equal(result.completed, false);
  assert.equal(result.status, 'processing');
  assert.equal(job.instagram.story.phase, 'submitted');
  assert.equal(job.instagram.story.attempts, 1);
  assert.equal(saves, 1);
});

test('ready manifestを適用して署名URLを返す', () => {
  const job = newJob();
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
  context.getStoryDriveMetadata_ = () => metadata();
  context.hasRequestTime_ = () => true;
  context.invokeStoryTransformJob_ = () => 'operations/op-1';
  context.savePostJob_ = () => {};

  context.advanceInstagramStoryPreparation_(
    job,
    'drive-file-123',
    'video',
    scheduledAt,
    Date.now() + 60000,
    config
  );
  context.readStoryTransformManifest_ = state => ({
    status: 'ready',
    job_id: state.fingerprint,
    source_file_id: state.sourceFileId,
    source_modified_time: state.sourceModifiedTime,
    source_size: state.sourceSize,
    source_md5_checksum: state.sourceMd5Checksum,
    width: 1080,
    height: 1920,
    content_type: 'video/mp4',
    output_object: 'instagram-stories/output/video.mp4',
    output_url: 'https://storage.example/signed-video',
    output_url_expires_at:
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    completed_at: new Date().toISOString(),
  });

  const result = context.advanceInstagramStoryPreparation_(
    job,
    'drive-file-123',
    'video',
    scheduledAt,
    Date.now() + 60000,
    config
  );

  assert.equal(result.completed, true);
  assert.equal(result.transformed, true);
  assert.equal(result.mediaUrl, 'https://storage.example/signed-video');
  assert.equal(job.instagram.story.phase, 'ready');
});

test('投稿済み状態の再開時はInstagramへ再投稿しない印を返す', () => {
  const job = newJob();
  const scheduledAt = new Date();
  context.getStoryDriveMetadata_ = () => metadata();
  const state = context.ensureInstagramStoryTransformState_(
    job,
    metadata(),
    'video',
    scheduledAt,
    config
  );
  state.phase = 'published';
  state.outputUrl = 'https://storage.example/signed-video';

  const result = context.advanceInstagramStoryPreparation_(
    job,
    'drive-file-123',
    'video',
    scheduledAt,
    Date.now() + 60000,
    config
  );
  assert.equal(result.completed, true);
  assert.equal(result.alreadyPublished, true);
});

test('publishing中断は結果不明として再投稿を止める', () => {
  const job = newJob();
  const scheduledAt = new Date();
  context.getStoryDriveMetadata_ = () => metadata();
  context.savePostJob_ = () => {};
  const state = context.ensureInstagramStoryTransformState_(
    job,
    metadata(),
    'video',
    scheduledAt,
    config
  );
  state.phase = 'publishing';

  assert.throws(
    () => context.advanceInstagramStoryPreparation_(
      job,
      'drive-file-123',
      'video',
      scheduledAt,
      Date.now() + 60000,
      config
    ),
    /結果を確認できません/
  );
  assert.equal(state.phase, 'unknown');
});

test('Instagram publishの通信断をunknownとして保存する', () => {
  const job = newJob();
  job.instagram.story = {
    phase: 'ready',
    outputUrl: 'https://storage.example/signed-video',
  };
  const originalAdvance = context.advanceInstagramStoryPreparation_;
  context.advanceInstagramStoryPreparation_ = () => ({
    completed: true,
    mediaUrl: 'https://storage.example/signed-video',
    mediaKind: 'video',
    transformed: true,
  });
  context.savePostJob_ = () => {};
  context.postInstagramVideoStoryByUrl = () => {
    const error = new Error('connection lost');
    error.instagramPublishAttempt = true;
    error.transportError = true;
    throw error;
  };

  try {
    assert.throws(
      () => context.processInstagramTarget_(
        { header: 'instagram_stories' },
        '',
        '',
        'drive-file-123',
        job,
        new Date(),
        Date.now() + 60000
      ),
      /connection lost/
    );
    assert.equal(job.instagram.story.phase, 'unknown');
  } finally {
    context.advanceInstagramStoryPreparation_ = originalAdvance;
  }
});

test('Cloud Run再試行中のerror manifestは処理中として扱う', () => {
  const job = newJob();
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
  context.getStoryDriveMetadata_ = () => metadata();
  context.hasRequestTime_ = () => true;
  context.invokeStoryTransformJob_ = () => 'operations/op-retry';
  context.savePostJob_ = () => {};

  context.advanceInstagramStoryPreparation_(
    job,
    'drive-file-123',
    'video',
    scheduledAt,
    Date.now() + 60000,
    config
  );
  context.readStoryTransformManifest_ = () => ({
    status: 'error',
    error: 'first task attempt failed',
  });
  context.getStoryRunOperation_ = () => ({ done: false });

  const result = context.advanceInstagramStoryPreparation_(
    job,
    'drive-file-123',
    'video',
    scheduledAt,
    Date.now() + 60000,
    config
  );
  assert.equal(result.completed, false);
  assert.equal(job.instagram.story.phase, 'processing');
});

test('他投稿先完了後のDrive差し替えを拒否する', () => {
  const job = newJob();
  context.ensureInstagramStoryTransformState_(
    job,
    metadata(),
    'video',
    new Date(),
    config
  );
  job.completedTargets.push('x_post');

  assert.throws(
    () => context.ensureInstagramStoryTransformState_(
      job,
      metadata({ modifiedTime: '2026-07-25T02:00:00.000Z' }),
      'video',
      new Date(),
      config
    ),
    /手動確認/
  );
});

test('不正な解像度のmanifestを拒否する', () => {
  const job = newJob();
  const state = context.ensureInstagramStoryTransformState_(
    job,
    metadata(),
    'video',
    new Date(),
    config
  );
  assert.throws(
    () => context.applyReadyStoryManifest_(state, {
      job_id: state.fingerprint,
      source_file_id: state.sourceFileId,
      source_modified_time: state.sourceModifiedTime,
      source_size: state.sourceSize,
      source_md5_checksum: state.sourceMd5Checksum,
      width: 1920,
      height: 1080,
      content_type: 'video/mp4',
      output_url: 'https://storage.example/video',
      output_url_expires_at:
        new Date(Date.now() + 86400000).toISOString(),
    }),
    /1080x1920/
  );
});

test('異なるDriveリビジョンのmanifestを拒否する', () => {
  const job = newJob();
  const state = context.ensureInstagramStoryTransformState_(
    job,
    metadata(),
    'video',
    new Date(),
    config
  );
  assert.throws(
    () => context.applyReadyStoryManifest_(state, {
      job_id: state.fingerprint,
      source_file_id: state.sourceFileId,
      source_modified_time: state.sourceModifiedTime,
      source_size: state.sourceSize,
      source_md5_checksum: 'ffffffffffffffffffffffffffffffff',
      width: 1080,
      height: 1920,
      content_type: 'video/mp4',
      output_url: 'https://storage.example/video',
      output_url_expires_at:
        new Date(Date.now() + 86400000).toISOString(),
    }),
    /チェックサム/
  );
});

test('pauseモードでは未加工素材を投稿経路へ返さない', () => {
  const job = newJob();
  assert.throws(
    () => context.advanceInstagramStoryPreparation_(
      job,
      'drive-file-123',
      'video',
      new Date(),
      Date.now() + 60000,
      { enabled: false, mode: 'pause' }
    ),
    /停止中/
  );
  assert.equal(job.instagram.story, null);
});

test('canaryモードは指定行だけを変換する', () => {
  const canaryConfig = {
    ...config,
    mode: 'canary',
    canaryRow: 8,
  };
  const otherRowJob = newJob();
  otherRowJob.rowNumber = 7;
  const canaryJob = newJob();
  canaryJob.rowNumber = 8;
  let metadataReads = 0;
  context.getStoryDriveMetadata_ = () => {
    metadataReads += 1;
    return metadata();
  };
  context.hasRequestTime_ = () => true;
  context.invokeStoryTransformJob_ = () => 'operations/op-canary';
  context.savePostJob_ = () => {};

  const otherRowResult = context.advanceInstagramStoryPreparation_(
    otherRowJob,
    'drive-file-123',
    'video',
    new Date(),
    Date.now() + 60000,
    canaryConfig
  );
  const canaryResult = context.advanceInstagramStoryPreparation_(
    canaryJob,
    'drive-file-123',
    'video',
    new Date(),
    Date.now() + 60000,
    canaryConfig
  );

  assert.equal(otherRowResult.completed, true);
  assert.equal(otherRowResult.transformed, false);
  assert.equal(otherRowJob.instagram.story, null);
  assert.equal(canaryResult.completed, false);
  assert.equal(canaryResult.transformed, true);
  assert.equal(canaryJob.instagram.story.phase, 'submitted');
  assert.equal(metadataReads, 1);
});

test('hibi検証関数は画像行3と横長動画行5を投稿なしで準備する', () => {
  const originalSetup = context.checkStoriesTransformSetup;
  const originalPrepare = context.prepareInstagramStoryFromSheetRow;
  const preparedRows = [];
  context.checkStoriesTransformSetup = () => ({
    mode: 'legacy',
    projectId: 'hibi-452314',
  });
  context.prepareInstagramStoryFromSheetRow = rowNumber => {
    preparedRows.push(rowNumber);
    return {
      rowNumber,
      completed: false,
      phase: 'submitted',
    };
  };

  try {
    const result = context.verifyStoriesTransformForHibi();
    assert.deepEqual(preparedRows, [3, 5]);
    assert.equal(result.setup.mode, 'legacy');
    assert.equal(result.imageRow3.rowNumber, 3);
    assert.equal(result.landscapeVideoRow5.rowNumber, 5);
  } finally {
    context.checkStoriesTransformSetup = originalSetup;
    context.prepareInstagramStoryFromSheetRow = originalPrepare;
  }
});

test('hibi行8カナリア関数は接続確認後にトリガーと対象行を設定する', () => {
  const originalSetup = context.checkStoriesTransformSetup;
  const originalCreateTrigger = context.createStoriesTransformTrigger;
  const originalSetCanary = context.setStoriesTransformCanaryRow_;
  const calls = [];
  context.checkStoriesTransformSetup = () => {
    calls.push('setup');
  };
  context.createStoriesTransformTrigger = () => {
    calls.push('trigger');
  };
  context.setStoriesTransformCanaryRow_ = rowNumber => {
    calls.push('canary:' + rowNumber);
    return {
      mode: 'canary',
      enabled: true,
      canaryRow: rowNumber,
    };
  };

  try {
    const result = context.startStoriesRow8CanaryForHibi();
    assert.deepEqual(calls, ['setup', 'trigger', 'canary:8']);
    assert.equal(result.mode, 'canary');
    assert.equal(result.canaryRow, 8);
  } finally {
    context.checkStoriesTransformSetup = originalSetup;
    context.createStoriesTransformTrigger = originalCreateTrigger;
    context.setStoriesTransformCanaryRow_ = originalSetCanary;
  }
});

test('hibi行8即時投稿関数はcanary対象行だけを呼び出す', () => {
  const originalConfig = context.getStoriesTransformConfig_;
  const originalPost = context.postPreparedInstagramStoryFromSheetRow;
  const postedRows = [];
  context.getStoriesTransformConfig_ = () => ({
    enabled: true,
    mode: 'canary',
    canaryRow: 8,
  });
  context.postPreparedInstagramStoryFromSheetRow = rowNumber => {
    postedRows.push(rowNumber);
    return {
      rowNumber,
      completed: false,
      status: 'processing',
      phase: 'submitted',
    };
  };

  try {
    const result = context.postStoriesRow8CanaryNowForHibi();
    assert.deepEqual(postedRows, [8]);
    assert.equal(result.rowNumber, 8);
    assert.equal(result.phase, 'submitted');
  } finally {
    context.getStoriesTransformConfig_ = originalConfig;
    context.postPreparedInstagramStoryFromSheetRow = originalPost;
  }
});

test('hibi運用関数はStoriesモードを明示値で切り替える', () => {
  const originalSetMode = context.setStoriesTransformMode;
  const modes = [];
  context.setStoriesTransformMode = mode => {
    modes.push(mode);
    return { mode };
  };

  try {
    assert.equal(context.enableStoriesTransformForHibi().mode, 'enforce');
    assert.equal(context.pauseStoriesTransformForHibi().mode, 'pause');
    assert.equal(context.useLegacyStoriesTransformForHibi().mode, 'legacy');
    assert.deepEqual(modes, ['enforce', 'pause', 'legacy']);
  } finally {
    context.setStoriesTransformMode = originalSetMode;
  }
});
