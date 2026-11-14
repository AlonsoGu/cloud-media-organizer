import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const organizer = path.join(scriptsDir, 'organizer.mjs');

test('rejects conflicting dry-run and execute flags before browser startup', () => {
  const result = spawnSync(process.execPath, [organizer, '--dry-run', '--execute'], {
    cwd: scriptsDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--dry-run 与 --execute 不能同时使用/);
});

test('rejects unknown CLI flags strictly before browser startup', () => {
  const result = spawnSync(process.execPath, [organizer, '--exectue'], {
    cwd: scriptsDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option '--exectue'/i);
});

test('rejects spoofed --tmdb-url and invalid --port before browser startup', () => {
  const badUrlRes = spawnSync(
    process.execPath,
    [organizer, '--tmdb-url', 'https://evil.com/themoviedb.org/tv/123'],
    { cwd: scriptsDir, encoding: 'utf8' }
  );
  assert.equal(badUrlRes.status, 1);
  assert.match(badUrlRes.stderr, /仅允许 themoviedb\.org 域名链接/);

  const badPortRes = spawnSync(
    process.execPath,
    [organizer, '--port', '99999', '--help'],
    { cwd: scriptsDir, encoding: 'utf8' }
  );
  assert.equal(badPortRes.status, 1);
  assert.match(badPortRes.stderr, /非法的 CDP 端口号/);
});

test('help command uses the installed script path without browser startup', () => {
  const result = spawnSync(process.execPath, [organizer, '--help'], {
    cwd: scriptsDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--drive/);
  assert.match(result.stdout, /--sp-map/);
  assert.match(result.stdout, /CLOUD_MEDIA_ARCHIVE_PASSWORD/);
  assert.match(result.stdout, /--clean-snapshots/);
});

test('normalizes multi-drive provider names and Baidu Netdisk paths', async () => {
  const { normalizeDriveType } = await import('../cdp-client.mjs');
  const { normalizeBaiduPath, splitBaiduParentAndName, joinBaiduPath, BaiduDriveBridge } =
    await import('../baidu-api.mjs');

  assert.equal(normalizeDriveType('115'), '115');
  assert.equal(normalizeDriveType('baidu'), 'baidu');
  assert.equal(normalizeDriveType('百度网盘'), 'baidu');
  assert.equal(normalizeDriveType('quark'), 'quark');
  assert.equal(normalizeDriveType('夸克网盘'), 'quark');
  assert.equal(normalizeDriveType('auto'), 'auto');

  assert.equal(normalizeBaiduPath('全部文件/影视/剧集/庆余年/'), '/影视/剧集/庆余年');
  assert.equal(normalizeBaiduPath('根目录\\动漫\\葬送的芙莉莲'), '/动漫/葬送的芙莉莲');
  assert.deepEqual(splitBaiduParentAndName('/影视/剧集/庆余年/01.mkv'), {
    parentPath: '/影视/剧集/庆余年',
    name: '01.mkv',
  });
  assert.equal(joinBaiduPath('/影视/剧集/庆余年', 'Season 01'), '/影视/剧集/庆余年/Season 01');

  const baiduBridge = new BaiduDriveBridge(null);
  assert.equal(
    baiduBridge.resolveRenamedFolderId('/影视/剧集/庆余年_2019', '庆余年（2019）'),
    '/影视/剧集/庆余年（2019）'
  );
});

test('validates CDP ports, Chrome initial URLs, and PowerShell start script safely', async () => {
  const { validateCdpPort, validateChromeInitialUrls, buildWindowsStartChromeScript } =
    await import('../cdp-client.mjs');

  assert.equal(validateCdpPort('9222'), 9222);
  assert.throws(() => validateCdpPort('80'), /非法的 CDP 端口号/);
  assert.throws(() => validateCdpPort('9222&calc.exe'), /非法的 CDP 端口号/);

  assert.deepEqual(validateChromeInitialUrls(['https://115.com/', 'https://www.themoviedb.org/tv/1']), [
    'https://115.com/',
    'https://www.themoviedb.org/tv/1',
  ]);
  assert.throws(() => validateChromeInitialUrls(['javascript:alert(1)']), /仅允许 https 协议/);
  assert.throws(() => validateChromeInitialUrls(['https://evil.example.com/']), /不在白名单内/);
  assert.throws(() => validateChromeInitialUrls(['https://115.com/\ncalc.exe']), /非法控制字符/);

  const psScript = buildWindowsStartChromeScript("C:\\Program Files\\Google\\Chrome's\\chrome.exe", [
    '--remote-debugging-port=9222',
    'https://115.com/?a=1&b=2',
  ]);
  assert.match(psScript, /Start-Process -FilePath 'C:\\Program Files\\Google\\Chrome''s\\chrome\.exe'/);
  assert.match(psScript, /'https:\/\/115\.com\/\?a=1&b=2'/);
});

test('validates TMDB URLs and challenge cookie tokens strictly', async () => {
  const {
    normalizeTmdbSeasonsUrl,
    normalizeTmdbMovieUrl,
    detectTmdbMediaTypeFromUrl,
    sanitizeChallengeCookiePair,
  } = await import('../tmdb-parser.mjs');

  assert.equal(
    normalizeTmdbSeasonsUrl('https://www.themoviedb.org/tv/31798/seasons').canonicalUrl,
    'https://www.themoviedb.org/tv/31798/seasons?language=zh-CN'
  );
  assert.equal(
    normalizeTmdbMovieUrl('https://www.themoviedb.org/movie/842675'),
    'https://www.themoviedb.org/movie/842675?language=zh-CN'
  );
  assert.throws(
    () => normalizeTmdbSeasonsUrl('https://evil.com/themoviedb.org/tv/31798'),
    /仅允许 themoviedb\.org 域名链接/
  );
  assert.throws(
    () => normalizeTmdbMovieUrl('https://evil.com/movie/842675'),
    /仅允许 themoviedb\.org 域名链接/
  );
  assert.equal(detectTmdbMediaTypeFromUrl('https://evil.com/movie/842675'), null);

  assert.equal(sanitizeChallengeCookiePair('tmdb_challenge', 'abc123_xyz'), 'tmdb_challenge=abc123_xyz');
  assert.equal(sanitizeChallengeCookiePair('bad\ncookie', '123'), null);
  assert.equal(sanitizeChallengeCookiePair('tmdb_challenge', 'val; Path=/'), null);
});

test('filterAdFiles cleans promo junk while protecting metadata, artwork, and font packs', async () => {
  const { filterAdFiles } = await import('../organizer.mjs');

  const files = [
    { id: '1', name: 'poster.jpg', size: 120 * 1024 },
    { id: '2', name: 'fanart.png', size: 450 * 1024 },
    { id: '3', name: 'tvshow.nfo', size: 4 * 1024 },
    { id: '4', name: 'Fonts.zip', size: 3 * 1024 * 1024 },
    { id: '5', name: 'Show.S01E01.mkv', size: 2 * 1024 * 1024 },
    { id: '6', name: 'promo_sample.mp4', size: 2 * 1024 * 1024 },
    { id: '7', name: '最新网址扫码关注.png', size: 80 * 1024 },
    { id: '8', name: '更多资源下载必看.txt', size: 1024 },
    { id: '9', name: 'poster_高清剧集网.jpg', size: 90 * 1024 },
  ];

  const { ads, cleanFiles } = filterAdFiles(files, { enabled: true });
  assert.deepEqual(
    cleanFiles.map((f) => f.id),
    ['1', '2', '3', '4', '5']
  );
  assert.deepEqual(
    ads.map((f) => f.id),
    ['6', '7', '8', '9']
  );
});

test('prunes old snapshots and supports --clean-snapshots CLI flag', async () => {
  const { pruneOldSnapshots } = await import('../organizer.mjs');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cmo-snap-test-'));
  const snapDir = path.join(tmpRoot, 'snapshots');
  await fs.mkdir(snapDir, { recursive: true });

  try {
    for (let i = 1; i <= 5; i += 1) {
      const p = path.join(snapDir, `rollback-test-${i}.json`);
      await fs.writeFile(p, '{}', 'utf8');
      const t = new Date(Date.now() - (10 - i) * 1000);
      await fs.utimes(p, t, t);
    }
    const expired = path.join(snapDir, 'latest-dry-run-old.json');
    await fs.writeFile(expired, '{}', 'utf8');
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(expired, oldDate, oldDate);

    await pruneOldSnapshots(snapDir, { maxAgeDays: 30, maxRollbackFiles: 3 });
    const remaining = (await fs.readdir(snapDir)).sort();
    assert.deepEqual(remaining, [
      'rollback-test-3.json',
      'rollback-test-4.json',
      'rollback-test-5.json',
    ]);

    const cleanRes = spawnSync(process.execPath, [organizer, '--clean-snapshots'], {
      cwd: scriptsDir,
      env: { ...process.env, CLOUD_MEDIA_ORGANIZER_HOME: tmpRoot },
      encoding: 'utf8',
    });
    assert.equal(cleanRes.status, 0);
    assert.match(cleanRes.stdout, /已清理本地快照文件 3 个/);
    assert.deepEqual(await fs.readdir(snapDir), []);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

