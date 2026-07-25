const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {
  console,
  Logger: { log() {} },
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
for (const file of [
  'コード.js',
  'Instagram.js',
  'StoriesMedia.js',
  'ReelsMedia.js',
]) {
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    context
  );
}

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
    fileId: 'row-7-drive-file',
    fileName: '間に合わせ.mov',
    mimeType: 'video/quicktime',
    totalBytes: 33897461,
    modifiedTime: '2026-07-25T00:00:00.000Z',
    md5Checksum: '0123456789abcdef0123456789abcdef',
    width: 1440,
    height: 1080,
    durationMillis: 56192,
    ...overrides,
  };
}

const config = {
  enabled: true,
  mode: 'enforce',
  canaryRow: null,
  projectId: 'hibi-452314',
  region: 'asia-northeast1',
  jobName: 'instagram-reel-transformer',
  bucket: 'hibi-452314-story-media',
  backgroundColor: '000000',
  leadMinutes: 120,
  maxDelayMinutes: 30,
};

function newJob(rowNumber = 7) {
  return {
    rowNumber,
    completedTargets: [],
    x: { postState: 'not_started' },
    instagram: { story: null, reel: null },
  };
}

test('Reels変換フィンガープリントはDrive更新を検出する', () => {
  const first = context.buildInstagramReelTransformFingerprint_(
    metadata(),
    config
  );
  const second = context.buildInstagramReelTransformFingerprint_(
    metadata(),
    config
  );
  const changed = context.buildInstagramReelTransformFingerprint_(
    metadata({ modifiedTime: '2026-07-25T01:00:00.000Z' }),
    config
  );
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test('行7をReels用Cloud Run Jobへ投入する', () => {
  const job = newJob();
  let saves = 0;
  context.getInstagramReelDriveMetadata_ = () => metadata();
  context.hasRequestTime_ = () => true;
  context.invokeInstagramReelTransformJob_ = () =>
    'projects/sample/locations/region/operations/reel-op-1';
  context.savePostJob_ = () => {
    saves += 1;
  };

  const result = context.advanceInstagramReelTransform_(
    job,
    'https://drive.google.com/file/d/row-7-drive-file/view',
    new Date(),
    Date.now() + 60000,
    config
  );
  assert.equal(result.completed, false);
  assert.equal(result.status, 'processing');
  assert.equal(job.instagram.reel.phase, 'submitted');
  assert.equal(job.instagram.reel.attempts, 1);
  assert.equal(saves, 1);
});

test('Reels ready manifestは1080x1920 MP4だけを受理する', () => {
  const job = newJob();
  const state = context.ensureInstagramReelTransformState_(
    job,
    metadata(),
    new Date(),
    config
  );
  context.applyReadyInstagramReelManifest_(state, {
    status: 'ready',
    job_id: state.fingerprint,
    media_target: 'reels',
    source_file_id: state.sourceFileId,
    source_modified_time: state.sourceModifiedTime,
    source_size: state.sourceSize,
    source_md5_checksum: state.sourceMd5Checksum,
    width: 1080,
    height: 1920,
    duration_seconds: 56.148,
    content_type: 'video/mp4',
    output_object: 'instagram-reels/output/row7.mp4',
    output_url: 'https://storage.example/signed-row7',
    output_url_expires_at:
      new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(state.phase, 'ready');
  assert.equal(
    state.outputObject,
    'instagram-reels/output/row7.mp4'
  );
});

test('Reelsコンテナは1回だけ確認して次回トリガーへ継続する', () => {
  const job = newJob();
  job.instagram.reel = {
    phase: 'ready',
    outputUrl: 'https://storage.example/signed-row7',
    containerId: '',
    lastError: '',
  };
  const originalAdvance = context.advanceInstagramReelTransform_;
  context.advanceInstagramReelTransform_ = () => ({
    completed: true,
    transformed: true,
    mediaUrl: job.instagram.reel.outputUrl,
  });
  context.getInstagramConfig_ = () => ({ accessToken: 'test' });
  context.assertPublicInstagramVideoUrl_ = () => {};
  context.createInstagramVideoContainer_ = () => 'container-7';
  context.getInstagramContainerStatus_ = () => ({
    status_code: 'IN_PROGRESS',
    status: 'processing',
  });
  context.hasRequestTime_ = () => true;
  context.savePostJob_ = () => {};

  try {
    const result = context.advanceInstagramReelPreparation_(
      job,
      'drive-row7',
      'caption',
      new Date(),
      Date.now() + 60000,
      config
    );
    assert.equal(result.completed, false);
    assert.equal(job.instagram.reel.phase, 'container_processing');
    assert.equal(job.instagram.reel.containerId, 'container-7');
  } finally {
    context.advanceInstagramReelTransform_ = originalAdvance;
  }
});

test('FINISHEDコンテナだけを公開可能として返す', () => {
  const job = newJob();
  job.instagram.reel = {
    phase: 'container_processing',
    outputUrl: 'https://storage.example/signed-row7',
    containerId: 'container-7',
    lastError: '',
  };
  const originalAdvance = context.advanceInstagramReelTransform_;
  context.advanceInstagramReelTransform_ = () => ({
    completed: true,
    transformed: true,
    mediaUrl: job.instagram.reel.outputUrl,
  });
  context.getInstagramConfig_ = () => ({ accessToken: 'test' });
  context.getInstagramContainerStatus_ = () => ({
    status_code: 'FINISHED',
    status: 'ready',
  });
  context.hasRequestTime_ = () => true;
  context.savePostJob_ = () => {};

  try {
    const result = context.advanceInstagramReelPreparation_(
      job,
      'drive-row7',
      'caption',
      new Date(),
      Date.now() + 60000,
      config
    );
    assert.equal(result.completed, true);
    assert.equal(job.instagram.reel.phase, 'container_ready');
  } finally {
    context.advanceInstagramReelTransform_ = originalAdvance;
  }
});

test('Reels公開の通信断はunknownとして二重投稿を止める', () => {
  const job = newJob();
  job.instagram.reel = {
    phase: 'container_ready',
    containerId: 'container-7',
    lastError: '',
  };
  const originalAdvance = context.advanceInstagramReelPreparation_;
  context.advanceInstagramReelPreparation_ = () => ({
    completed: true,
    transformed: true,
    containerId: 'container-7',
  });
  context.getInstagramConfig_ = () => ({ accessToken: 'test' });
  context.savePostJob_ = () => {};
  context.publishInstagramContainer_ = () => {
    const error = new Error('connection lost');
    error.instagramPublishAttempt = true;
    error.transportError = true;
    throw error;
  };

  try {
    assert.throws(
      () => context.processInstagramTarget_(
        { header: 'instagram_post' },
        'caption',
        '',
        'drive-row7',
        job,
        new Date(),
        Date.now() + 60000
      ),
      /connection lost/
    );
    assert.equal(job.instagram.reel.phase, 'unknown');
  } finally {
    context.advanceInstagramReelPreparation_ = originalAdvance;
  }
});

test('canaryモードは指定行以外を従来経路へ返す', () => {
  const job = newJob(8);
  const result = context.advanceInstagramReelTransform_(
    job,
    'drive-row8',
    new Date(),
    Date.now() + 60000,
    {
      ...config,
      mode: 'canary',
      canaryRow: 9,
    }
  );
  assert.equal(result.completed, true);
  assert.equal(result.transformed, false);
  assert.equal(job.instagram.reel, null);
});

test('hibi検証関数は行7を投稿なしで変換する', () => {
  const originalSetup = context.checkInstagramReelTransformSetup;
  const originalPrepare = context.prepareInstagramReelFromSheetRow;
  const preparedRows = [];
  context.checkInstagramReelTransformSetup = () => ({
    mode: 'legacy',
    projectId: 'hibi-452314',
  });
  context.prepareInstagramReelFromSheetRow = rowNumber => {
    preparedRows.push(rowNumber);
    return {
      rowNumber,
      completed: false,
      phase: 'submitted',
      containerCreated: false,
    };
  };
  try {
    const result = context.verifyInstagramReelTransformForHibi();
    assert.deepEqual(preparedRows, [7]);
    assert.equal(result.row7.containerCreated, false);
  } finally {
    context.checkInstagramReelTransformSetup = originalSetup;
    context.prepareInstagramReelFromSheetRow = originalPrepare;
  }
});

test('hibiカナリア関数は安全条件を満たす単一候補行を設定する', () => {
  const originalFind = context.findInstagramReelCanaryRow_;
  const originalStart = context.startInstagramReelCanaryForSheetRow_;
  context.findInstagramReelCanaryRow_ = () => 12;
  context.startInstagramReelCanaryForSheetRow_ = rowNumber => ({
    mode: 'canary',
    canaryRow: rowNumber,
  });
  try {
    const result = context.startInstagramReelCanaryForHibi();
    assert.equal(result.mode, 'canary');
    assert.equal(result.canaryRow, 12);
  } finally {
    context.findInstagramReelCanaryRow_ = originalFind;
    context.startInstagramReelCanaryForSheetRow_ = originalStart;
  }
});

test('hibiカナリア確認は署名URLを含めず状態だけを返す', () => {
  const originalConfig = context.getInstagramReelTransformConfig_;
  const originalLoad = context.loadPostJob_;
  context.getInstagramReelTransformConfig_ = () => ({
    mode: 'canary',
    canaryRow: 10,
  });
  context.loadPostJob_ = () => ({
    instagram: {
      reel: {
        phase: 'container_processing',
        outputObject: 'instagram-reels/output/video.mp4',
        outputUrl: 'https://signed.example/secret',
        containerId: 'container-10',
        containerStatus: 'IN_PROGRESS',
        lastError: '',
      },
    },
  });
  try {
    const result = context.inspectInstagramReelCanaryForHibi();
    assert.equal(result.canaryRow, 10);
    assert.equal(result.phase, 'container_processing');
    assert.equal(result.containerCreated, true);
    assert.equal(result.containerStatus, 'IN_PROGRESS');
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, 'outputUrl'),
      false
    );
  } finally {
    context.getInstagramReelTransformConfig_ = originalConfig;
    context.loadPostJob_ = originalLoad;
  }
});

test('hibiカナリア準備は1回進めてから状態を返す', () => {
  const originalConfig = context.getInstagramReelTransformConfig_;
  const originalPrepare = context.prepareInstagramReels;
  const originalInspect = context.inspectInstagramReelCanaryForHibi;
  const calls = [];
  context.getInstagramReelTransformConfig_ = () => ({
    mode: 'canary',
    canaryRow: 10,
  });
  context.prepareInstagramReels = () => {
    calls.push('prepare');
  };
  context.inspectInstagramReelCanaryForHibi = () => {
    calls.push('inspect');
    return { canaryRow: 10, phase: 'container_processing' };
  };
  try {
    const result = context.prepareInstagramReelCanaryForHibi();
    assert.deepEqual(calls, ['prepare', 'inspect']);
    assert.equal(result.phase, 'container_processing');
  } finally {
    context.getInstagramReelTransformConfig_ = originalConfig;
    context.prepareInstagramReels = originalPrepare;
    context.inspectInstagramReelCanaryForHibi = originalInspect;
  }
});
