import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CdpManager,
  CdpPageSession,
  DRIVE_PROVIDERS,
  ensureDebugChrome,
  normalizeDriveType,
  validateCdpPort,
} from './cdp-client.mjs';
import { Cloud115Bridge } from './115-api.mjs';
import { BaiduDriveBridge } from './baidu-api.mjs';
import { QuarkDriveBridge } from './quark-api.mjs';
import {
  enrichTmdbSeasonsWithEpisodes,
  fetchTmdbMovie,
  fetchTmdbSeasons,
  normalizeTmdbMovieUrl,
  normalizeTmdbSeasonsUrl,
  searchTmdbMovies,
  searchTmdbTvShows,
  detectTmdbMediaTypeFromUrl,
} from './tmdb-parser.mjs';
import {
  buildMovieOrganizationPlan,
  buildOrganizationPlan,
  buildSubtitleMatchPlan,
  detectActiveSeasonsFromFiles,
  getExtension,
  isSubtitleArchiveCandidate,
  needsEpisodeEnrichment,
  parseEpisodeToken,
  stripExtension,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './matcher.mjs';

const REAL_SCRIPT_PATH = fsSync.realpathSync(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(path.dirname(REAL_SCRIPT_PATH), '..');

/**
 * 隐私物理隔离：将运行期浏览器会话缓存 (chrome-profile) 与本地操作快照 (snapshots)
 * 统一存储于操作系统级本地应用目录，确保 Skill 代码仓库 100% 纯净无个人痕迹，可直接开源发布。
 */
function resolveUserRuntimeRootDir() {
  if (process.env.CLOUD_MEDIA_ORGANIZER_HOME) {
    return path.resolve(process.env.CLOUD_MEDIA_ORGANIZER_HOME);
  }
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'cloud-media-organizer');
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdgCache, 'cloud-media-organizer');
}

const RUNTIME_ROOT_DIR = resolveUserRuntimeRootDir();
const DEFAULT_PROFILE_DIR = path.join(RUNTIME_ROOT_DIR, 'chrome-profile');
const SNAPSHOT_DIR = path.join(RUNTIME_ROOT_DIR, 'snapshots');

function migrateLegacyRuntimeDirsIfNeeded() {
  try {
    fsSync.mkdirSync(RUNTIME_ROOT_DIR, { recursive: true });
    const legacyProfile = path.join(PROJECT_ROOT, '.chrome-debug-profile');
    if (fsSync.existsSync(legacyProfile) && !fsSync.existsSync(DEFAULT_PROFILE_DIR)) {
      fsSync.renameSync(legacyProfile, DEFAULT_PROFILE_DIR);
    }
    const legacySnapshots = path.join(PROJECT_ROOT, 'snapshots');
    if (fsSync.existsSync(legacySnapshots) && !fsSync.existsSync(SNAPSHOT_DIR)) {
      fsSync.renameSync(legacySnapshots, SNAPSHOT_DIR);
    }
  } catch {
    // 忽略跨盘符或占用导致的自动迁移异常
  }
}

export async function pruneOldSnapshots(
  snapshotDir = SNAPSHOT_DIR,
  { maxAgeDays = 30, maxRollbackFiles = 20 } = {}
) {
  try {
    const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
    const nowMs = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const rollbackFiles = [];

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const fullPath = path.join(snapshotDir, ent.name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (nowMs - stat.mtimeMs > maxAgeMs) {
        await fs.rm(fullPath, { force: true }).catch(() => {});
        continue;
      }
      if (ent.name.startsWith('rollback-')) {
        rollbackFiles.push({ fullPath, mtimeMs: stat.mtimeMs });
      }
    }

    if (rollbackFiles.length > maxRollbackFiles) {
      rollbackFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const oldFile of rollbackFiles.slice(maxRollbackFiles)) {
        await fs.rm(oldFile.fullPath, { force: true }).catch(() => {});
      }
    }
  } catch {
    // 忽略快照清理异常，不阻断主流程
  }
}

async function writeSnapshotJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  await pruneOldSnapshots(path.dirname(filePath));
}

function sanitizeCidForFilename(cid = '') {
  const cleaned = String(cid || 'root')
    .replace(/^[\/\\]+|[\/\\]+$/g, '')
    .replace(/[\\/:*?"<>|\s]+/g, '_');
  return cleaned.slice(-90) || 'root';
}

function createDriveBridge(driveType, session) {
  if (driveType === 'baidu') return new BaiduDriveBridge(session);
  if (driveType === 'quark') return new QuarkDriveBridge(session);
  return new Cloud115Bridge(session);
}

function parseCliOptions() {
  const { values } = parseArgs({
    options: {
      'launch-chrome': { type: 'boolean', default: false },
      drive: { type: 'string', default: 'auto' },
      search: { type: 'string' },
      'tmdb-search': { type: 'string' },
      'tmdb-query': { type: 'string' },
      query: { type: 'string' },
      name: { type: 'string' },
      'tmdb-id': { type: 'string' },
      'match-subs': { type: 'boolean', default: false },
      'subs-only': { type: 'boolean', default: false },
      'align-subs': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      execute: { type: 'boolean', default: false },
      rollback: { type: 'string' },
      'tmdb-url': { type: 'string' },
      url: { type: 'string' },
      path: { type: 'string' },
      cid: { type: 'string' },
      pattern: { type: 'string', default: '{Standard}' },
      'season-pattern': { type: 'string', default: 'Season {Season}' },
      'folder-pattern': { type: 'string', default: '{Title}（{Year}）' },
      type: { type: 'string', default: 'auto' },
      'media-type': { type: 'string' },
      'rename-folder': { type: 'boolean', default: false },
      'tmdb-season-names': { type: 'boolean', default: false },
      'with-title': { type: 'boolean', default: false },
      offset: { type: 'string' },
      'sp-map': { type: 'string' },
      'trust-sp-num': { type: 'boolean', default: false },
      port: { type: 'string', default: '9222' },
      'max-depth': { type: 'string', default: '8' },
      'archive-password': { type: 'string', default: '' },
      'no-extract-archives': { type: 'boolean', default: false },
      'delete-archives': { type: 'boolean', default: false },
      'clean-empty-dirs': { type: 'boolean', default: false },
      'clean-ads': { type: 'boolean', default: false },
      'clean-snapshots': { type: 'boolean', default: false },
      'allow-root': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const filePatternExplicit = process.argv.some(
    (arg) => arg === '--pattern' || arg.startsWith('--pattern=')
  );
  const seasonPatternExplicit = process.argv.some(
    (arg) => arg === '--season-pattern' || arg.startsWith('--season-pattern=')
  );

  const dryRunRequested = Boolean(values['dry-run']);
  const executeRequested = Boolean(values.execute);
  if (dryRunRequested && executeRequested) {
    throw new Error('--dry-run 与 --execute 不能同时使用，请二选一');
  }

  const rawTmdbUrl = values['tmdb-url'] || values.url ? String(values['tmdb-url'] || values.url).trim() : null;
  const rawTmdbId = values['tmdb-id'] ? String(values['tmdb-id']).trim() : null;
  const rawQuery =
    values['tmdb-query'] || values.query || values.name
      ? String(values['tmdb-query'] || values.query || values.name).trim()
      : null;

  let tmdbUrl = rawTmdbUrl;
  let tmdbQuery = rawQuery;

  const rawMediaType = values['media-type'] || values.type;
  let mediaType = rawMediaType ? String(rawMediaType).toLowerCase().trim() : 'auto';

  if (!tmdbUrl && tmdbQuery) {
    const queryDetectedType = detectTmdbMediaTypeFromUrl(tmdbQuery);
    if (queryDetectedType) {
      tmdbUrl = tmdbQuery;
      tmdbQuery = null;
      mediaType = queryDetectedType;
    }
  }

  if (tmdbUrl) {
    const detectedType = detectTmdbMediaTypeFromUrl(tmdbUrl);
    if (detectedType) {
      mediaType = detectedType;
    }
  }

  if (!tmdbUrl && rawTmdbId && /^\d+$/.test(rawTmdbId)) {
    if (mediaType === 'movie') {
      tmdbUrl = `https://www.themoviedb.org/movie/${rawTmdbId}?language=zh-CN`;
    } else {
      tmdbUrl = `https://www.themoviedb.org/tv/${rawTmdbId}/seasons`;
    }
  } else if (tmdbUrl && /^\d+$/.test(tmdbUrl)) {
    if (mediaType === 'movie') {
      tmdbUrl = `https://www.themoviedb.org/movie/${tmdbUrl}?language=zh-CN`;
    } else {
      tmdbUrl = `https://www.themoviedb.org/tv/${tmdbUrl}/seasons`;
    }
  }

  if (mediaType === 'auto') {
    mediaType = 'tv';
  }

  if (tmdbUrl) {
    tmdbUrl =
      mediaType === 'movie'
        ? normalizeTmdbMovieUrl(tmdbUrl)
        : normalizeTmdbSeasonsUrl(tmdbUrl).canonicalUrl;
  }

  const folderPatternExplicit = process.argv.some(
    (arg) => arg === '--folder-pattern' || arg.startsWith('--folder-pattern=')
  );

  return {
    help: Boolean(values.help),
    launchChromeOnly: Boolean(values['launch-chrome']),
    drive: normalizeDriveType(values.drive),
    searchKeyword: values.search ? String(values.search) : null,
    tmdbSearchOnly: values['tmdb-search'] ? String(values['tmdb-search']).trim() : null,
    matchSubs: Boolean(values['match-subs'] || values['subs-only'] || values['align-subs']),
    dryRun: dryRunRequested || !executeRequested,
    execute: executeRequested,
    rollbackFile: values.rollback ? String(values.rollback) : null,
    mediaType,
    tmdbUrl,
    tmdbQuery,
    targetPath: values.path ? String(values.path) : null,
    explicitCid: values.cid ? String(values.cid) : null,
    filePattern: String(values.pattern || '{Standard}'),
    filePatternExplicit,
    seasonPattern: String(values['season-pattern'] || 'Season {Season}'),
    seasonPatternExplicit,
    folderPattern: String(values['folder-pattern'] || '{Title}（{Year}）'),
    folderPatternExplicit,
    renameFolder: Boolean(values['rename-folder']),
    useTmdbSeasonNames: Boolean(values['tmdb-season-names']),
    withTitle: Boolean(values['with-title']),
    explicitOffset: values.offset !== undefined ? Number(values.offset) : null,
    spMap: values['sp-map'] ? String(values['sp-map']) : '',
    trustSpNum: Boolean(values['trust-sp-num']),
    port: validateCdpPort(values.port || 9222),
    maxDepth: Number(values['max-depth'] ?? 8),
    archivePassword: values['archive-password']
      ? String(values['archive-password'])
      : String(process.env.CLOUD_MEDIA_ARCHIVE_PASSWORD || ''),
    noExtractArchives: Boolean(values['no-extract-archives']),
    deleteArchives: Boolean(values['delete-archives']),
    cleanEmptyDirs: Boolean(values['clean-empty-dirs']),
    cleanAds: Boolean(values['clean-ads']),
    cleanSnapshots: Boolean(values['clean-snapshots']),
    allowRoot: Boolean(values['allow-root']),
  };
}

function printHelp() {
  console.log(`
多网盘 (115网盘 / 百度网盘 / 夸克网盘) TMDB 季度归类、特别篇语义匹配、标准重命名与字幕对齐编排器 (CDP 零凭证泄露版)
兼容 NAS 媒体库：绿联影视中心 (UGREEN) / 极空间极影视 (ZSpace) / 飞牛影视 (fnOS)

核心用法:
  1. 多网盘切换参数 (--drive auto|115|baidu|quark，默认 auto 自动识别当前打开的网盘标签页):
     [115网盘]  node organizer.mjs --drive 115 --tmdb-query "无头骑士异闻录" --path "根目录/云下载/无头骑士异闻录"
     [百度网盘] node organizer.mjs --drive baidu --tmdb-query "庆余年" --path "/影视/剧集/庆余年"
     [夸克网盘] node organizer.mjs --drive quark --tmdb-query "葬送的芙莉莲" --path "全部文件/动漫/葬送的芙莉莲"

  2. 独立外挂字幕对齐模式 (--match-subs，无需 TMDB，不改现有视频名，兼容电影与已整理剧集):
     [预览] node organizer.mjs --match-subs --path "根目录/云下载/目标影视目录"
     [执行] node organizer.mjs --match-subs --execute --clean-empty-dirs --cid "<对账确认的目录id/路径>"

  3. TMDB 剧集分季整理与特别篇 (Season 0 / SP / OVA) 五级语义匹配模式:
     [预览] node organizer.mjs --tmdb-query "无头骑士异闻录" --path "根目录/云下载/无头骑士异闻录"
     [执行] node organizer.mjs --execute --clean-empty-dirs --tmdb-url "https://www.themoviedb.org/tv/31798/seasons" --cid "<对账确认的目录id/路径>"
     * 跨 NAS 季度目录标准化：默认统一采用 "Season 01"、"Season 02"、"Specials" 英文标准目录名，100% 兼容绿联、极空间、飞牛影视；
     * 特别篇智能防错匹配：自动提取文件名中的副标题/关键词与 TMDB Season 0 的单集标题 (title) 及剧情简介 (overview) 进行语义比对，拒绝无脑按 SP01->S00E01 盲目递增：
       --sp-map "SP01=S00E04,SP02=S00E09"   手动锁定指定特别篇序号映射
       --trust-sp-num                       强制信任原文件 SP 序号直接映射为 S00Exx

  4. TMDB 电影标准化命名与字幕对齐模式 (--type movie):
     [预览] node organizer.mjs --type movie --tmdb-query "流浪地球 2" --path "根目录/云下载/流浪地球2"
     [执行] node organizer.mjs --type movie --execute --clean-empty-dirs --tmdb-query "流浪地球 2" --cid "<对账确认的目录id/路径>"

  5. 字幕压缩包在线解压与深层文件夹穿透参数:
     --dry-run                    显式执行只读预览（默认未传 --execute 时即为预览）
     --max-depth <N>              多层嵌套子文件夹穿透深度 (默认 8 层)
     --archive-password "<密码>"   115 云解压密码（推荐优先设置环境变量 CLOUD_MEDIA_ARCHIVE_PASSWORD 避免明文留痕）
     --delete-archives            解压并提取字幕成功后，将原字幕压缩包移入回收站 (默认保留原压缩包)
     --no-extract-archives        禁用压缩包自动检测与云端解压
     --clean-empty-dirs           提取归位完成后，自底向上逐层校验并清理已腾空的旧拆分目录与多层字幕文件夹
     --clean-ads                  自动识别并清理影视目录中夹带的推广海报/引流文档/广告伪装视频至网盘回收站
     --rename-folder              将剧集/电影主目录同步重命名为标准格式（默认 "片名（年份）"）
     --tmdb-season-names          显式使用 TMDB 官方季名称命名季度目录 (注意：极空间/飞牛建议使用默认 Season 01)

  6. 辅助检索与运维命令:
     --tmdb-search "<片名 [年份]>"   单独在 TMDB 搜索剧集或电影候选列表
     --search "<关键词>"             按关键词搜索当前网盘目录并输出候选完整路径与标识
     --rollback "<快照json路径>"     根据本地快照一键还原文件名与原始目录
     --clean-snapshots              清空本地 snapshots 目录下的历史预览与回滚快照文件
`);
}

function printArchiveSummaryBanner(archiveSummary) {
  if (!archiveSummary) return;
  if (archiveSummary.mode === 'dry_run_inspect') {
    console.log('\n------------------------------------------------------------');
    console.log(
      `【字幕压缩包云端预检 (Dry-Run 未写入目录)】共检测到候选压缩包: ${archiveSummary.detectedCount} 个`
    );
    for (const item of archiveSummary.inspected) {
      const loc = item.relativeDir ? `${item.relativeDir}/${item.name}` : item.name;
      if (!item.ok) {
        console.log(`  [!] ${loc} -> 预检失败: ${item.error}`);
      } else if (item.subtitleCount === 0 && item.nestedArchiveCount === 0 && !item.hitMaxDepth) {
        console.log(`  [-] ${loc} -> 非字幕压缩包 (内部未含字幕，执行时将自动跳过)`);
      } else {
        const nestedNote =
          item.nestedArchiveCount > 0
            ? `，另含嵌套子压缩包 ${item.nestedArchiveCount} 个（正式 --execute 时将自动双层拆包）`
            : '';
        console.log(
          `  [+] ${loc} -> 发现内部字幕 ${item.subtitleCount} 个${nestedNote}（下方已纳入模拟配对预览）`
        );
      }
    }
    console.log('------------------------------------------------------------');
  }
}

function printSubtitleMatchSummary({ treeInfo, subPlan, archiveSummary = null, driveLabel = '115网盘' }) {
  printArchiveSummaryBanner(archiveSummary);
  const { stats } = subPlan;
  console.log('\n============================================================');
  console.log('运行工作模式 : 独立外挂字幕解压、多层提取与名称对齐 (--match-subs，现有视频保持不变)');
  console.log(`${driveLabel}目标目录 : ${treeInfo.fullPathText} (id=${treeInfo.rootCid})`);
  console.log('字幕后缀策略 : 单字幕严格与视频同名 (<视频名>.ext) | 多字幕保留语言后缀 (<视频名>.sc.ext)');
  console.log('------------------------------------------------------------');
  console.log(
    `扫描视频: ${stats.totalVideos} 个 | 扫描字幕: ${stats.totalSubtitles} 个` +
      (stats.detectedArchiveCount > 0 ? ` | 发现压缩包: ${stats.detectedArchiveCount} 个` : '') +
      ` | 成功配对: ${stats.matchedSubtitles} 个`
  );
  console.log(
    `待执行修改: ${stats.actionableSubtitles} 个 (其中跨多层目录提取归位: ${stats.crossDirMoveCount} 个) | 已对齐无需改动: ${stats.alreadyAlignedCount} 个`
  );
  if (stats.unmatchedCount > 0) {
    console.log(`未配对跳过: ${stats.unmatchedCount} 个 (原位保留不修改)`);
  }
  console.log('============================================================\n');

  if (subPlan.actionableItems.length > 0) {
    console.log('【1. 待执行的字幕提取、归位与对齐预览】');
    const list = subPlan.actionableItems;
    const samples =
      list.length <= 16
        ? list
        : [
            ...list.slice(0, 8),
            { ellipsis: list.length - 12 },
            ...list.slice(list.length - 4),
          ];
    for (const item of samples) {
      if (item.ellipsis) {
        console.log(`    ... (中间省略 ${item.ellipsis} 条字幕映射，完整明细见预览 JSON) ...`);
      } else {
        const srcPrefix = item.fromArchive
          ? `[包:${item.fromArchive}] `
          : item.sourceRelDir
            ? `${item.sourceRelDir}/`
            : '';
        const dstPrefix = item.targetRelDir ? `${item.targetRelDir}/` : '';
        const moveTag = item.fromArchive
          ? '[解压+提取归位+对齐]'
          : item.needsMove
            ? '[提取移入同目录+对齐]'
            : '[同目录原位改名]';
        console.log(
          `  ${moveTag} ${srcPrefix}${item.oldName}  ==>  ${dstPrefix}${item.newName}  (配对视频: ${item.pairedVideoName} | ${item.matchReason})`
        );
      }
    }
  } else if (stats.alreadyAlignedCount > 0) {
    console.log('【提示】当前目录下所有已匹配字幕均已与对应视频同目录且严格同名，无需重复修改。');
  }

  if (subPlan.unmatchedSubtitles.length > 0) {
    console.log('\n【2. 未能自动配对的字幕文件（保持原样不动）】');
    for (const u of subPlan.unmatchedSubtitles.slice(0, 20)) {
      const prefix = u.relativeDir ? `${u.relativeDir}/` : '';
      console.log(`  - ${prefix}${u.name} (${u.reason})`);
    }
  }

  if (subPlan.conflicts.length > 0) {
    console.error('\n【! 检测到目标字幕重名冲突，已触发熔断阻断 !】');
    for (const c of subPlan.conflicts) {
      console.error(`  冲突目标 ${c.targetPath}: "${c.firstFile}" vs "${c.secondFile}"`);
    }
  }
}

function printTmdbCandidatesBanner(searchRes, { maxDisplay = 5 } = {}) {
  const { rawQuery, yearHint, rankedCandidates, selected, ambiguousExactTie } = searchRes;
  const isMovie = selected?.mediaType === 'movie' || rankedCandidates[0]?.mediaType === 'movie';
  const typeLabel = isMovie ? '电影' : '剧名';
  console.log('\n------------------------------------------------------------');
  console.log(
    `【TMDB ${typeLabel}自动检索】查询词: "${rawQuery}"` +
      (yearHint ? ` (年份偏好: ${yearHint})` : '') +
      ` | 命中候选: ${rankedCandidates.length} 个`
  );
  const topList = rankedCandidates.slice(0, maxDisplay);
  for (let i = 0; i < topList.length; i += 1) {
    const c = topList[i];
    const isChosen =
      selected &&
      ((c.tvId && c.tvId === selected.tvId) || (c.movieId && c.movieId === selected.movieId));
    const prefix = isChosen ? '  ★' : '   ';
    const origPart = c.originalTitle && c.originalTitle !== c.title ? ` [原名: ${c.originalTitle}]` : '';
    const yearPart = c.year ? `(${c.year})` : '(年份未知)';
    const chosenPart = isChosen ? '  <== [当前选用]' : '';
    const idDesc = c.movieId ? `movie/${c.movieId}` : `tv/${c.tvId}`;
    console.log(`${prefix} [${i + 1}] 《${c.title}》 ${yearPart}${origPart} -> ${idDesc}${chosenPart}`);
    if (c.movieUrl) {
      console.log(`        详情页: ${c.movieUrl}`);
    } else if (c.seasonsUrl) {
      console.log(`        季度页: ${c.seasonsUrl}`);
    }
    if (c.overview) {
      const brief = c.overview.length > 90 ? `${c.overview.slice(0, 90)}...` : c.overview;
      console.log(`        简介  : ${brief}`);
    }
  }
  if (rankedCandidates.length > maxDisplay) {
    console.log(`    ... 其余 ${rankedCandidates.length - maxDisplay} 个低相关度候选已省略`);
  }
  if (ambiguousExactTie) {
    console.log(
      `  [!] 同名多版本提示: 检测到多个完全同名的${typeLabel}条目，请核对上方首播/上映年份与简介；确认执行时请显式传入对应的 --tmdb-url！`
    );
  }
  console.log('------------------------------------------------------------');
}

function printMoviePlanSummary({
  tmdbMeta,
  treeInfo,
  plan,
  archiveSummary = null,
  renameFolder = false,
  driveLabel = '115网盘',
}) {
  printArchiveSummaryBanner(archiveSummary);
  console.log('\n============================================================');
  console.log(
    `TMDB 电影识别: 《${tmdbMeta.title}》` +
      (tmdbMeta.year ? ` (${tmdbMeta.year})` : '') +
      (tmdbMeta.originalTitle && tmdbMeta.originalTitle !== tmdbMeta.title
        ? ` [原名: ${tmdbMeta.originalTitle}]`
        : '')
  );
  console.log(`${driveLabel}目标目录 : ${treeInfo.fullPathText} (id=${treeInfo.rootCid})`);
  console.log(
    `规范片名前缀 : ${plan.canonicalMovieTitle}` +
      ` | 文件模板="${plan.filePattern === '{Standard}' ? '{电影名}.{年份}.{原压制信息}' : plan.filePattern}.<ext>"`
  );
  console.log(
    `电影目录建议 : ${plan.suggestedFolderName}` +
      (renameFolder ? ' [已启用 --rename-folder 同步重命名]' : ' [未启用 --rename-folder，仅改内部文件]')
  );

  const videos = plan.plannedItems.filter((x) => x.mediaType === 'video');
  const subtitles = plan.plannedItems.filter((x) => x.mediaType === 'subtitle');

  if (videos.length > 0) {
    console.log('\n【1. 电影视频文件重命名预览】');
    for (const v of videos) {
      console.log(`  [视频] ${v.oldName}  ==>  ${v.newName}`);
    }
  }

  if (subtitles.length > 0) {
    console.log('\n【2. 外挂字幕同名对齐与提取预览】');
    for (const s of subtitles) {
      const srcPrefix = s.fromArchive
        ? `[包:${s.fromArchive}] `
        : s.sourceRelDir
          ? `${s.sourceRelDir}/`
          : '';
      const moveTag = s.fromArchive
        ? '[解压+归位+对齐]'
        : s.needsMove
          ? '[提取移入视频同层+对齐]'
          : '[同目录原位对齐]';
      console.log(`  ${moveTag} ${srcPrefix}${s.oldName}  ==>  ${s.newName}`);
    }
  }

  if (plan.skippedBonus.length > 0) {
    console.log('\n【3. 跳过处理的预告片/花絮视频（保持原样不动）】');
    for (const b of plan.skippedBonus) {
      console.log(`  [-] ${b.name} (${b.reason})`);
    }
  }

  if (plan.unmatchedFiles.length > 0) {
    console.log('\n【4. 未能自动匹配的文件】');
    for (const u of plan.unmatchedFiles) {
      console.log(`  - ${u.name} (${u.reason})`);
    }
  }

  if (plan.conflicts.length > 0) {
    console.error('\n【! 检测到目标文件名冲突，已触发熔断阻断 !】');
    for (const c of plan.conflicts) {
      console.error(`  冲突目标 ${c.targetPath}: "${c.firstFile}" vs "${c.secondFile}"`);
    }
  }
}

function printPlanSummary({
  tmdbMeta,
  treeInfo,
  plan,
  archiveSummary = null,
  renameFolder = false,
  driveLabel = '115网盘',
}) {
  printArchiveSummaryBanner(archiveSummary);
  console.log('\n============================================================');
  console.log(`TMDB 媒体识别: 《${tmdbMeta.showTitle}》`);
  console.log(
    `TMDB 季度统计: 正片共 ${tmdbMeta.regularSeasons.length} 季（合计 ${tmdbMeta.totalRegularEpisodes} 集）` +
      (tmdbMeta.specialSeason ? `，另含 Special 特别篇 ${tmdbMeta.specialSeason.episodeCount} 集` : '')
  );
  console.log(`${driveLabel}目标目录 : ${treeInfo.fullPathText} (id=${treeInfo.rootCid})`);
  if (plan.suggestedFolderName) {
    console.log(
      `建议资源根目录: ${plan.suggestedFolderName}` +
        (renameFolder ? ' [已传入 --rename-folder 同步更名]' : ' [未传入 --rename-folder，仅处理内部文件]')
    );
  }
  console.log(
    `命名规范模板 : 季目录="${plan.seasonPattern}"` +
      (plan.reclassification?.autoAppliedTmdbFolderNames
        ? ' (显式启用 --tmdb-season-names 按 TMDB 官方季名分类)'
        : ' (兼容绿联/极空间/飞牛 NAS 标准 Season 01 / Specials 目录)') +
      ` | 文件="${plan.filePattern === '{Standard}' ? '{剧名}.{年份}.{SxxExx}.{原压制信息}' : plan.filePattern}.<ext>"`
  );
  console.log(
    `启用匹配策略 : ${
      plan.strategy === 'MODE_2_SUBTITLE_LINKED'
        ? '策略 2（检测到外挂字幕 -> 视频主文件 + 同集外挂字幕多层提取联动）'
        : '策略 1（未检测到外挂字幕 -> 纯视频季度折算与重命名）'
    }`
  );
  if (plan.offsetInfo.offset !== 0) {
    console.log(
      `集数偏移修正 : ${plan.offsetInfo.offset} (${
        plan.offsetInfo.autoInferred ? `自动识别: ${plan.offsetInfo.reason}` : '手动指定'
      })`
    );
  }
  console.log('------------------------------------------------------------');
  console.log(
    `扫描文件总数: ${plan.stats.totalScannedFiles} | 匹配视频: ${plan.stats.matchedVideos} | 匹配字幕: ${plan.stats.matchedSubtitles}` +
      (plan.stats.detectedArchiveCount > 0
        ? ` | 发现压缩包: ${plan.stats.detectedArchiveCount}`
        : '') +
      ` | 涉及季度目录: ${plan.stats.seasonsToCreateOrUse}（不预建空目录）`
  );
  if (plan.stats.skippedBonusCount > 0) {
    console.log(`特典保护跳过: ${plan.stats.skippedBonusCount} 个 (OP/ED/PV/Menu 原位保留)`);
  }
  if (plan.stats.unmatchedCount > 0) {
    console.log(`未匹配跳过项: ${plan.stats.unmatchedCount} 个 (原位保留不修改)`);
  }
  console.log('============================================================\n');

  if (plan.reclassification?.isMismatched && plan.reclassification.mappings.length > 0) {
    console.log('【0. 本地文件夹 -> TMDB 季度重新分类映射】');
    for (const m of plan.reclassification.mappings) {
      const offsetDesc = m.overflowFold
        ? '跨季自动拆分折算'
        : m.epOffset > 0
          ? `集号偏移 +${m.epOffset} (E${String(m.epOffset + 1).padStart(2, '0')} 起)`
          : '集号偏移 +0';
      console.log(
        `  - "${m.sourceDir}"  ==>  "${m.targetFolderName}" (TMDB 第 ${m.targetSeasonNumber} 季, ${offsetDesc} | ${m.matchSource})`
      );
    }
    console.log('');
  }

  console.log('【1. 待创建/复用的季度文件夹汇总（仅含非空季度）】');
  for (const s of plan.requiredSeasons) {
    const existTag = treeInfo.existingSeasonFolders.has(s.folderName.toLowerCase())
      ? '[已存在-直接复用]'
      : '[待新建]';
    console.log(
      `  - ${s.folderName.padEnd(11)} ${existTag} | 视频 ${String(s.videoCount).padStart(3)} 个` +
        (s.subtitleCount > 0 ? ` | 字幕 ${String(s.subtitleCount).padStart(3)} 个` : '') +
        ` | TMDB 对应: ${s.seasonTitle} (共 ${s.expectedEpisodes ?? '?'} 集)`
    );
  }

  console.log('\n【2. 文件归类与重命名映射抽样预览】');
  const bySeason = new Map();
  for (const item of plan.plannedItems) {
    if (!bySeason.has(item.targetFolderName)) bySeason.set(item.targetFolderName, []);
    bySeason.get(item.targetFolderName).push(item);
  }
  for (const [folderName, list] of bySeason) {
    const isSpecialSeason = list[0]?.seasonNumber === 0;
    const samples =
      isSpecialSeason || list.length <= 4
        ? list
        : [list[0], list[1], { ellipsis: list.length - 4 }, list[list.length - 2], list[list.length - 1]];
    for (const entry of samples) {
      if (entry.ellipsis) {
        console.log(`    ... (${folderName} 中间省略 ${entry.ellipsis} 个条目) ...`);
      } else {
        const srcPrefix = entry.fromArchive
          ? `[包:${entry.fromArchive}] `
          : entry.sourceRelDir
            ? `${entry.sourceRelDir}/`
            : '';
        const reasonSuffix =
          entry.seasonNumber === 0 && entry.matchReason ? `  (${entry.matchReason})` : '';
        console.log(
          `  [${entry.mediaType === 'video' ? '视频' : '字幕'}] ${srcPrefix}${entry.oldName}  ==>  ${folderName}/${entry.newName}${reasonSuffix}`
        );
      }
    }
  }

  if (plan.unmatchedFiles.length > 0) {
    console.log('\n【3. 未匹配/特别篇待核对跳过文件列表（保持原样不动）】');
    for (const u of plan.unmatchedFiles.slice(0, 20)) {
      console.log(`  - ${u.name} (${u.reason})`);
    }
    if (plan.unmatchedFiles.length > 20) {
      console.log(`  ... 其余 ${plan.unmatchedFiles.length - 20} 个未匹配文件已记录至预览 JSON`);
    }

    const hasUnverifiedSpecial = plan.unmatchedFiles.some((u) => u.isUnverifiedSpecial);
    const spEpisodes = tmdbMeta.specialSeason?.episodes || [];
    if (hasUnverifiedSpecial && spEpisodes.length > 0) {
      console.log('\n【4. TMDB Season 0 (Specials) 官方特别篇目录与简介对照表】');
      console.log('  提示：检测到本地特别篇缺少标题特征词且集数与 TMDB Season 0 不一致，已自动拦截防错。');
      console.log('  请对照下方 TMDB 官方特别篇标题与剧情简介，使用 --sp-map "SP01=S00E03,..." 或 --trust-sp-num 指定映射：');
      for (const ep of spEpisodes.slice(0, 30)) {
        const code = `S00E${String(ep.episodeNumber).padStart(2, '0')}`;
        const datePart = ep.airDate ? ` [${ep.airDate}]` : '';
        const brief = ep.overview
          ? ` — ${ep.overview.length > 65 ? `${ep.overview.slice(0, 65)}...` : ep.overview}`
          : '';
        console.log(`    • ${code}${datePart} 《${ep.title || '无标题'}》${brief}`);
      }
      if (spEpisodes.length > 30) {
        console.log(`    ... 其余 ${spEpisodes.length - 30} 集特别篇详见 TMDB 网页`);
      }
    }
  }

  if (plan.conflicts.length > 0) {
    console.error('\n【! 检测到目标重名冲突，已触发熔断阻断 !】');
    for (const c of plan.conflicts) {
      console.error(`  冲突目标 ${c.targetPath}: "${c.firstFile}" vs "${c.secondFile}"`);
    }
  }
}

/**
 * 统一处理目录树扫描与字幕压缩包（Dry-Run 非破坏性云端预检模拟 / Execute 真实在线解压 + 二次深层扫描）
 */
async function prepareArchivesAndFiles({ bridge, targetCid, scanOpts, opts }) {
  let treeInfo = await bridge.scanTargetResourceTree(targetCid, scanOpts);
  const detectedArchives = treeInfo.files.filter((f) => isSubtitleArchiveCandidate(f));

  if (detectedArchives.length === 0 || opts.noExtractArchives) {
    return {
      treeInfo,
      effectiveFiles: treeInfo.files,
      archiveSummary: null,
    };
  }

  if (opts.dryRun) {
    console.log(
      `检测到 ${detectedArchives.length} 个候选压缩包，正在进行云端非破坏性字幕目录预检 ...`
    );
    const inspected = [];
    const virtualSubFiles = [];

    for (const arch of detectedArchives) {
      const res = await bridge.inspectArchiveSubtitles(arch, {
        secret: opts.archivePassword,
        maxDepth: 6,
      });
      inspected.push({
        name: arch.name,
        relativeDir: arch.relativeDir || '',
        ok: res.ok,
        error: res.error,
        hitMaxDepth: Boolean(res.hitMaxDepth),
        subtitleCount: res.subtitleEntries.length,
        nestedArchiveCount: res.nestedArchiveEntries.length,
      });

      if (res.ok && res.subtitleEntries.length > 0) {
        const stem = arch.name
          .replace(/\.(?:tar\.(?:gz|bz2|xz)|part0*1\.rar|[^.]+)$/i, '')
          .replace(/[\\/:*?"<>|]+/g, '_')
          .trim();
        const stagingSeg = `_字幕解压_${stem || 'subs'}_`;
        const archDisplay = arch.relativeDir ? `${arch.relativeDir}/${arch.name}` : arch.name;

        res.subtitleEntries.forEach((entry, idx) => {
          const virtualRelDir = [arch.relativeDir, stagingSeg, entry.innerDir]
            .filter(Boolean)
            .join('/');
          virtualSubFiles.push({
            id: `archive-preview:${arch.id}:${idx}`,
            parentId: `archive-staging:${arch.id}`,
            name: entry.fileName,
            size: entry.size,
            parentFolderName: entry.parentFolderName || stagingSeg,
            relativeDir: virtualRelDir,
            fromArchive: archDisplay,
          });
        });
      }
    }

    return {
      treeInfo,
      effectiveFiles: [...treeInfo.files, ...virtualSubFiles],
      archiveSummary: {
        mode: 'dry_run_inspect',
        detectedCount: detectedArchives.length,
        inspected,
      },
    };
  }

  console.log(
    `\n--- 前置步骤: 在线解压字幕压缩包 (共检测到 ${detectedArchives.length} 个候选压缩包) ---`
  );
  const unpackRes = await bridge.extractSubtitleArchives(detectedArchives, {
    secret: opts.archivePassword,
    maxPasses: 2,
    deleteArchives: opts.deleteArchives,
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  if (unpackRes.unpackedCount > 0) {
    console.log(
      `已完成 ${unpackRes.unpackedCount} 个字幕压缩包解压，正在重新穿透扫描多层目录提取字幕文件 ...`
    );
    treeInfo = await bridge.scanTargetResourceTree(targetCid, scanOpts);
  }

  return {
    treeInfo,
    effectiveFiles: treeInfo.files,
    archiveSummary: {
      mode: 'executed_unpack',
      detectedCount: detectedArchives.length,
      unpackedCount: unpackRes.unpackedCount,
      skippedNonSubCount: unpackRes.skippedNonSubCount,
      failedArchives: unpackRes.failedArchives,
    },
  };
}

function selectFoldersForCleanup(treeInfo, cleanEmptyDirs = false, protectedCids = new Set()) {
  const all = (treeInfo?.scannedSubfolders || []).filter(
    (sf) => !protectedCids.has(String(sf.id))
  );
  if (cleanEmptyDirs) return all;
  return all.filter((sf) =>
    String(sf.relPath || '')
      .split('/')
      .some((seg) => seg.startsWith('_字幕解压_'))
  );
}

const PROTECTED_MEDIA_ASSET_EXTENSIONS = new Set([
  'nfo',
  'lrc',
  'ttf',
  'otf',
  'ttc',
  'woff',
  'woff2',
]);
const PROTECTED_ARTWORK_STEM_REGEX =
  /^(?:poster|fanart|backdrop|banner|clearlogo|clearart|logo|landscape|thumb|folder|cover|disc|cd\d+|theme|season[\s._-]*(?:\d+|all|specials)(?:[\s._-]*(?:poster|banner|fanart))?|(?:movie|show|tvshow)[\s._-]*(?:poster|fanart|banner))$/i;
const COMPANION_ARCHIVE_STEM_REGEX =
  /(?:^|[\s._\-\[(])(?:fonts?|ost|music|songs?|bgm|scans?|artbook|covers?|booklet|soundtrack|drama|bonus|menu|theme)(?:$|[\s._\-\])])/i;
const AD_PROMO_PHRASE_REGEX =
  /(?:www\.|https?:\/\/|高清剧集网|下载请访问|高品质资源|更多.*资源|扫码|公众号|防走丢|最新地址|最新网址|宣传)/i;
const AD_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const AD_DOC_AND_LINK_EXTENSIONS = new Set(['doc', 'docx', 'txt', 'url', 'html', 'htm', 'lnk']);

export function filterAdFiles(files, { enabled = false } = {}) {
  if (!enabled) return { ads: [], cleanFiles: files };
  const ads = [];
  const cleanFiles = [];
  for (const file of files) {
    const ext = getExtension(file.name);
    const stem = stripExtension(file.name).trim();
    const token = parseEpisodeToken(file.name);
    const isMedia = SUBTITLE_EXTENSIONS.has(ext) || isSubtitleArchiveCandidate(file);

    if (token !== null || isMedia) {
      cleanFiles.push(file);
      continue;
    }

    const hasPromoPhrase = AD_PROMO_PHRASE_REGEX.test(file.name);
    const isProtectedAsset =
      !hasPromoPhrase &&
      (PROTECTED_MEDIA_ASSET_EXTENSIONS.has(ext) ||
        PROTECTED_ARTWORK_STEM_REGEX.test(stem) ||
        COMPANION_ARCHIVE_STEM_REGEX.test(stem));

    if (isProtectedAsset) {
      cleanFiles.push(file);
      continue;
    }

    const isTinyVideo = VIDEO_EXTENSIONS.has(ext) && Number(file.size || 0) < 5 * 1024 * 1024;
    const isAdFile =
      hasPromoPhrase || AD_IMAGE_EXTENSIONS.has(ext) || AD_DOC_AND_LINK_EXTENSIONS.has(ext);

    if (isTinyVideo || isAdFile) {
      ads.push(file);
    } else {
      cleanFiles.push(file);
    }
  }
  return { ads, cleanFiles };
}

async function executeAdsCleanup(bridge, ads, rootCid) {
  if (!ads || ads.length === 0) return 0;
  console.log(`\n--- 前置步骤: 清理广告引流垃圾文件 (共 ${ads.length} 个) ---`);
  const byParent = new Map();
  for (const a of ads) {
    const pid = String(a.parentId || rootCid);
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(String(a.id));
  }
  let totalDeleted = 0;
  for (const [pid, fids] of byParent) {
    const delRes = await bridge.deleteItemsToRecycleBin(pid, fids);
    if (delRes?.state) {
      totalDeleted += fids.length;
    }
  }
  console.log(`  已成功将 ${totalDeleted} 个引流广告文件移入网盘回收站。`);
  return totalDeleted;
}

async function runRollback(rollbackPath, bridge) {
  const raw = await fs.readFile(path.resolve(rollbackPath), 'utf8');
  const parsed = JSON.parse(raw);
  const legacyItems = Array.isArray(parsed) ? parsed : null;
  const snapshot = legacyItems
    ? {
        schemaVersion: 0,
        fullPathText: '(legacy snapshot)',
        rootCid: null,
        items: legacyItems,
      }
    : parsed;
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new Error('回滚快照格式无效：缺少非空 items 数组');
  }
  const workingItems = snapshot.items.map((item, index) => {
    const oldPid = item.oldPid ?? item.parentId;
    if (!item.id || !oldPid || item.oldName === undefined || item.newName === undefined) {
      throw new Error(`回滚快照第 ${index + 1} 项缺少 id、旧目录或文件名字段`);
    }
    return {
      ...item,
      id: item.currentId || item.id,
      name: item.newName,
      oldName: item.newName,
      newName: item.oldName,
      oldPid,
      parentId: item.currentPid || '',
    };
  });
  console.log(`正在执行回滚快照: ${rollbackPath}`);
  console.log(`目标恢复目录: ${snapshot.fullPathText} (共 ${workingItems.length} 个文件)`);

  const byOldPid = new Map();
  for (const item of workingItems) {
    if (!byOldPid.has(item.oldPid)) byOldPid.set(item.oldPid, []);
    byOldPid.get(item.oldPid).push(item);
  }
  for (const [oldPid, group] of byOldPid) {
    await bridge.batchMoveToFolder(oldPid, group, {
      onProgress: (msg) => console.log(`  [回滚移动] ${msg}`),
    });
  }

  await bridge.batchRename(workingItems, {
    onProgress: (msg) => console.log(`  [回滚改名] ${msg}`),
  });

  await bridge.reloadView(snapshot.rootCid);
  console.log('回滚已完成，所有文件已恢复原目录与原文件名。');
}

export async function cleanAllSnapshots(snapshotDir = SNAPSHOT_DIR) {
  let removed = 0;
  try {
    const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith('.json')) {
        await fs.rm(path.join(snapshotDir, ent.name), { force: true });
        removed += 1;
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return removed;
}

async function main() {
  migrateLegacyRuntimeDirsIfNeeded();
  const opts = parseCliOptions();
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.cleanSnapshots) {
    const removed = await cleanAllSnapshots(SNAPSHOT_DIR);
    console.log(`已清理本地快照文件 ${removed} 个 (${SNAPSHOT_DIR})。`);
    return;
  }

  if (opts.tmdbSearchOnly) {
    let searchRes;
    const doSearch = async (cdp) =>
      opts.mediaType === 'movie'
        ? searchTmdbMovies(opts.tmdbSearchOnly, cdp)
        : searchTmdbTvShows(opts.tmdbSearchOnly, cdp);
    try {
      searchRes = await doSearch(null);
    } catch {
      await ensureDebugChrome({
        port: opts.port,
        profileDir: DEFAULT_PROFILE_DIR,
        initialUrls: ['https://www.themoviedb.org/'],
      });
      const fallbackCdp = new CdpManager(opts.port);
      searchRes = await doSearch(fallbackCdp);
    }
    printTmdbCandidatesBanner(searchRes, { maxDisplay: 10 });
    console.log(
      JSON.stringify(
        {
          query: searchRes.rawQuery,
          cleanQuery: searchRes.cleanQuery,
          yearHint: searchRes.yearHint,
          ambiguousExactTie: searchRes.ambiguousExactTie,
          selected: searchRes.selected,
          candidates: searchRes.rankedCandidates.slice(0, 10),
        },
        null,
        2
      )
    );
    return;
  }

  const defaultHomeUrl =
    opts.drive !== 'auto' && DRIVE_PROVIDERS[opts.drive]
      ? DRIVE_PROVIDERS[opts.drive].homeUrl
      : 'https://115.com/';
  const initialUrls = [defaultHomeUrl];
  if (opts.tmdbUrl) {
    initialUrls.push(`${opts.tmdbUrl}${opts.tmdbUrl.includes('?') ? '&' : '?'}language=zh-CN`);
  }

  const chromeStatus = await ensureDebugChrome({
    port: opts.port,
    profileDir: DEFAULT_PROFILE_DIR,
    initialUrls,
  });

  if (opts.launchChromeOnly) {
    if (opts.drive !== 'auto' && DRIVE_PROVIDERS[opts.drive]) {
      const cdp = new CdpManager(opts.port);
      const tab = await cdp.findOrOpenSingleDriveTab(opts.drive);
      await fetch(`http://127.0.0.1:${opts.port}/json/activate/${tab.id}`).catch(() => {});
    }
    console.log(
      `调试 Chrome 已就绪 (${chromeStatus.browser}, port=${chromeStatus.port}, newlyLaunched=${chromeStatus.newlyLaunched})。`
    );
    return;
  }

  const cdpManager = new CdpManager(opts.port);
  const { driveType, tab: driveTab } = await cdpManager.findOrOpenDriveTab(opts.drive);

  const session = new CdpPageSession(driveTab.webSocketDebuggerUrl);
  try {
    await session.connect();
    const bridge = createDriveBridge(driveType, session);

    if (opts.searchKeyword) {
      const hits = await bridge.searchFolders(opts.searchKeyword);
      console.log(
        JSON.stringify(
          { drive: bridge.driveType, driveLabel: bridge.driveLabel, keyword: opts.searchKeyword, count: hits.length, hits },
          null,
          2
        )
      );
      return;
    }

    if (opts.rollbackFile) {
      await runRollback(opts.rollbackFile, bridge);
      return;
    }

    if (!opts.matchSubs && !opts.tmdbUrl && !opts.tmdbQuery) {
      throw new Error(
        '缺少必选参数：请传 --match-subs 执行独立外挂字幕对齐，或传 --tmdb-query "<剧名>" / --tmdb-url "<链接>" 执行 TMDB 分季整理（可传 --help 查看完整用法）'
      );
    }

    // 1. 解析目标目录标识：优先级 --cid > --path > 当前打开标签页活跃目录
    let targetCid = opts.explicitCid;
    if (!targetCid && opts.targetPath) {
      console.log(`正在按路径寻址 ${bridge.driveLabel} 目录: "${opts.targetPath}" ...`);
      const resolved = await bridge.resolvePathToCid(opts.targetPath);
      targetCid = resolved.cid;
      console.log(`已定位目标目录: ${resolved.fullPathText} (id=${targetCid})`);
    }
    if (!targetCid) {
      const detected = await bridge.detectActiveCid();
      targetCid = detected.cid;
    }

    if (!targetCid || targetCid === '0' || targetCid === '/') {
      if (!opts.allowRoot) {
        throw new Error(
          `未指定有效 ${bridge.driveLabel} 目标文件夹（可通过 --path "目录路径"、--search "关键词" 或 --cid 指定，严禁默认操作网盘根目录）`
        );
      }
    }

    const safeFileCid = sanitizeCidForFilename(targetCid);

    // 分支 A：独立外挂字幕解压、多层提取与同目录名称对齐模式 (--match-subs)
    if (opts.matchSubs) {
      const effectiveDepth = Math.max(opts.maxDepth, 4);
      console.log(
        `正在穿透扫描 ${bridge.driveLabel} 目标影视目录及多层子目录 (id=${targetCid}, maxDepth=${effectiveDepth}) ...`
      );
      const { treeInfo, effectiveFiles, archiveSummary } = await prepareArchivesAndFiles({
        bridge,
        targetCid,
        scanOpts: {
          maxSubfolderDepth: effectiveDepth,
          includeSeasonFolders: true,
        },
        opts,
      });

      const { ads: detectedAds, cleanFiles } = filterAdFiles(effectiveFiles, { enabled: opts.cleanAds });
      const workingFiles = opts.cleanAds ? cleanFiles : effectiveFiles;

      const subPlan = buildSubtitleMatchPlan({ files: workingFiles });
      printSubtitleMatchSummary({
        treeInfo,
        subPlan,
        archiveSummary,
        driveLabel: bridge.driveLabel,
      });
      if (detectedAds.length > 0) {
        console.log(`\n【广告引流垃圾清理预览】(待移入回收站，共 ${detectedAds.length} 个):`);
        for (const a of detectedAds) {
          console.log(`  - 🗑️ [待清理] ${a.name} (${((a.size || 0) / (1024 * 1024)).toFixed(2)} MB)`);
        }
      }

      const latestSubPlanFile = path.join(SNAPSHOT_DIR, `latest-sub-match-${safeFileCid}.json`);
      await writeSnapshotJson(latestSubPlanFile, {
        generatedAt: new Date().toISOString(),
        driveType: bridge.driveType,
        mode: 'SUBTITLE_MATCH_ONLY',
        rootCid: treeInfo.rootCid,
        fullPathText: treeInfo.fullPathText,
        archiveSummary,
        subPlan,
      });
      console.log(`完整字幕配对明细已保存至: ${latestSubPlanFile}`);

      if (opts.dryRun) {
        console.log(`\n当前为 Dry-Run 预览模式，未对 ${bridge.driveLabel} 发起任何写入修改。`);
        return;
      }

      if (subPlan.conflicts.length > 0) {
        throw new Error(`存在 ${subPlan.conflicts.length} 处目标字幕重名冲突，已中止执行！`);
      }

      let movedCount = 0;
      let renamedCount = 0;
      let rollbackFile = null;

      if (subPlan.actionableItems.length === 0) {
        console.log('未发现需要改名或移动的外挂字幕。');
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        rollbackFile = path.join(SNAPSHOT_DIR, `rollback-subs-${safeFileCid}-${stamp}.json`);
        const initialSnapshotItems = subPlan.actionableItems.map((x) => ({
          id: x.id,
          oldName: x.oldName,
          newName: x.newName,
          oldPid: x.parentId,
        }));
        await writeSnapshotJson(rollbackFile, {
          createdAt: new Date().toISOString(),
          driveType: bridge.driveType,
          mode: 'SUBTITLE_MATCH_ONLY',
          rootCid: treeInfo.rootCid,
          fullPathText: treeInfo.fullPathText,
          items: initialSnapshotItems,
        });
        console.log(`\n已生成本地回滚保护快照: ${rollbackFile}`);

        if (opts.cleanAds && detectedAds.length > 0) {
          await executeAdsCleanup(bridge, detectedAds, treeInfo.rootCid);
        }

        const hasSameSourceNewName = (() => {
          const seen = new Set();
          for (const x of subPlan.actionableItems) {
            const k = `${x.parentId}:${x.newName.toLowerCase()}`;
            if (seen.has(k)) return true;
            seen.add(k);
          }
          return false;
        })();

        const moveGroups = new Map();
        for (const item of subPlan.actionableItems) {
          if (item.needsMove) {
            if (!moveGroups.has(item.targetCid)) moveGroups.set(item.targetCid, []);
            moveGroups.get(item.targetCid).push(item);
          }
        }

        const runMovePhase = async () => {
          if (moveGroups.size === 0) return 0;
          console.log('\n--- 字幕多层提取与跨目录归位（移入对应视频所在目录） ---');
          let movedTotal = 0;
          for (const [destCid, group] of moveGroups) {
            const label = group[0]?.targetRelDir || '目标根目录';
            const res = await bridge.batchMoveToFolder(destCid, group, {
              batchSize: 150,
              onProgress: (msg) => console.log(`  [${label}] ${msg}`),
            });
            movedTotal += res.movedCount;
          }
          return movedTotal;
        };

        const runRenamePhase = async () => {
          console.log('\n--- 字幕对齐重命名（严格匹配视频文件名） ---');
          const res = await bridge.batchRename(subPlan.actionableItems, {
            batchSize: 120,
            onProgress: (msg) => console.log(`  ${msg}`),
          });
          console.log(`  字幕重命名完成：已改名 ${res.renamedCount} 个。`);
          return res.renamedCount;
        };

        if (hasSameSourceNewName) {
          movedCount = await runMovePhase();
          renamedCount = await runRenamePhase();
        } else {
          renamedCount = await runRenamePhase();
          movedCount = await runMovePhase();
        }

        // 同步记录最终 currentId，支持百度网盘等路径主键网盘的无损回滚
        await fs.writeFile(
          rollbackFile,
          JSON.stringify(
            {
              createdAt: new Date().toISOString(),
              driveType: bridge.driveType,
              mode: 'SUBTITLE_MATCH_ONLY',
              rootCid: treeInfo.rootCid,
              fullPathText: treeInfo.fullPathText,
              items: subPlan.actionableItems.map((x, idx) => ({
                ...initialSnapshotItems[idx],
                currentId: x.id,
                currentPid: x.parentId,
              })),
            },
            null,
            2
          ),
          'utf8'
        );
      }

      let cleanedDirCount = 0;
      const protectedTopLevelCids = new Set(
        [...treeInfo.existingSeasonFolders.values()].map((folder) => String(folder.id))
      );
      const candidateCleanupDirs = selectFoldersForCleanup(
        treeInfo,
        opts.cleanEmptyDirs,
        protectedTopLevelCids
      );
      if (candidateCleanupDirs.length > 0) {
        console.log('\n--- 自底向上逐层校验并清理已腾空的多层字幕文件夹/解压暂存目录 ---');
        const cleanRes = await bridge.cleanVerifiedEmptySubfolders(
          candidateCleanupDirs,
          (msg) => console.log(`  ${msg}`)
        );
        cleanedDirCount = cleanRes.deletedCount;
      }

      await bridge.reloadView(treeInfo.rootCid);
      console.log('\n============================================================');
      console.log(
        `外挂字幕处理全部完成！` +
          (archiveSummary?.unpackedCount ? `在线解压压缩包 ${archiveSummary.unpackedCount} 个，` : '') +
          `改名 ${renamedCount} 个，多层提取归位 ${movedCount} 个` +
          (candidateCleanupDirs.length > 0 ? `，清理已腾空目录 ${cleanedDirCount} 个。` : '。')
      );
      if (rollbackFile) {
        console.log(`本地回滚快照: "${rollbackFile}"`);
      }
      console.log('============================================================\n');
      return;
    }

    // 分支 B-1：TMDB 电影标准化整理模式 (opts.mediaType === 'movie')
    if (opts.mediaType === 'movie') {
      let resolvedMovieUrl = opts.tmdbUrl;
      let tmdbSearchSummary = null;

      if (!resolvedMovieUrl && opts.tmdbQuery) {
        console.log(`正在按电影名检索 TMDB 媒体库: "${opts.tmdbQuery}" ...`);
        const searchRes = await searchTmdbMovies(opts.tmdbQuery, cdpManager);
        if (!searchRes.selected) {
          throw new Error(
            `未在 TMDB 搜索到与 "${opts.tmdbQuery}" 匹配的电影，请核对片名（或尝试英文原名），也可直接传入 --tmdb-url`
          );
        }
        printTmdbCandidatesBanner(searchRes, { maxDisplay: 5 });

        if (opts.execute && searchRes.ambiguousExactTie) {
          const tieDesc = searchRes.rankedCandidates
            .slice(0, 3)
            .map((c) => `《${c.title}》(${c.year ?? '年份未知'} -> ${c.movieUrl})`)
            .join(' / ');
          throw new Error(
            `检测到完全同名多版本电影歧义 [${tieDesc}]，为防止误改名，正式执行 (--execute) 请显式锁定对应的 --tmdb-url！`
          );
        }

        resolvedMovieUrl = searchRes.selected.movieUrl;
        tmdbSearchSummary = {
          rawQuery: searchRes.rawQuery,
          yearHint: searchRes.yearHint,
          ambiguousExactTie: searchRes.ambiguousExactTie,
          selected: searchRes.selected,
          topCandidates: searchRes.rankedCandidates.slice(0, 5),
        };
      }

      console.log(
        `正在并行解析 TMDB 电影详情页 (${resolvedMovieUrl}) 与穿透扫描 ${bridge.driveLabel} 目标目录 (id=${targetCid}, maxDepth=${opts.maxDepth}) ...`
      );
      const [tmdbMeta, { treeInfo, effectiveFiles, archiveSummary }] = await Promise.all([
        fetchTmdbMovie(resolvedMovieUrl, cdpManager),
        prepareArchivesAndFiles({
          bridge,
          targetCid,
          scanOpts: {
            maxSubfolderDepth: opts.maxDepth,
            includeSeasonFolders: false,
          },
          opts,
        }),
      ]);
      if (opts.tmdbQuery) {
        tmdbMeta.userQuery = opts.tmdbQuery;
      }

      const { ads: detectedAds, cleanFiles } = filterAdFiles(effectiveFiles, { enabled: opts.cleanAds });
      const workingFiles = opts.cleanAds ? cleanFiles : effectiveFiles;

      const plan = buildMovieOrganizationPlan({
        files: workingFiles,
        tmdbMeta,
        filePattern: opts.filePattern,
        filePatternExplicit: opts.filePatternExplicit,
        folderPattern: opts.folderPattern,
        folderPatternExplicit: opts.folderPatternExplicit,
      });

      printMoviePlanSummary({
        tmdbMeta,
        treeInfo,
        plan,
        archiveSummary,
        renameFolder: opts.renameFolder,
        driveLabel: bridge.driveLabel,
      });

      if (detectedAds.length > 0) {
        console.log(`\n【广告引流垃圾清理预览】(待移入回收站，共 ${detectedAds.length} 个):`);
        for (const a of detectedAds) {
          console.log(`  - 🗑️ [待清理] ${a.name} (${((a.size || 0) / (1024 * 1024)).toFixed(2)} MB)`);
        }
      }

      const latestPlanFile = path.join(SNAPSHOT_DIR, `latest-movie-dry-run-${safeFileCid}.json`);
      await writeSnapshotJson(latestPlanFile, {
        generatedAt: new Date().toISOString(),
        driveType: bridge.driveType,
        mediaType: 'movie',
        movieUrl: resolvedMovieUrl,
        tmdbSearch: tmdbSearchSummary,
        movieTitle: tmdbMeta.title,
        rootCid: treeInfo.rootCid,
        fullPathText: treeInfo.fullPathText,
        archiveSummary,
        plan,
      });
      console.log(`完整规划明细已保存至: ${latestPlanFile}`);

      if (opts.dryRun) {
        console.log(`\n当前为 Dry-Run 预览模式，未对 ${bridge.driveLabel} 发起任何写入修改。`);
        console.log('若预览无误，可追加 --execute 正式写入；若需一并规范重命名电影文件夹，可追加 --rename-folder。');
        return;
      }

      if (plan.conflicts.length > 0) {
        throw new Error(`存在 ${plan.conflicts.length} 处目标文件名冲突，已中止执行！`);
      }
      if (plan.plannedItems.length === 0) {
        console.log('未发现需要处理的电影文件，无需执行写入。');
        return;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rollbackFile = path.join(SNAPSHOT_DIR, `rollback-movie-${safeFileCid}-${stamp}.json`);
      const initialSnapshotItems = plan.plannedItems.map((x) => ({
        id: x.id,
        oldName: x.oldName,
        newName: x.newName,
        oldPid: x.parentId,
      }));
      await writeSnapshotJson(rollbackFile, {
        createdAt: new Date().toISOString(),
        driveType: bridge.driveType,
        mediaType: 'movie',
        rootCid: treeInfo.rootCid,
        fullPathText: treeInfo.fullPathText,
        movieTitle: tmdbMeta.title,
        items: initialSnapshotItems,
      });
      console.log(`\n已生成本地回滚保护快照: ${rollbackFile}`);

      if (opts.cleanAds && detectedAds.length > 0) {
        await executeAdsCleanup(bridge, detectedAds, treeInfo.rootCid);
      }

      const moveItems = plan.plannedItems.filter((x) => x.needsMove);
      let movedCount = 0;
      if (moveItems.length > 0) {
        console.log('\n--- 外挂字幕跨目录归位（移至主视频同层） ---');
        const moveRes = await bridge.batchMoveToFolder(targetCid, moveItems, {
          batchSize: 150,
          onProgress: (msg) => console.log(`  ${msg}`),
        });
        movedCount = moveRes.movedCount;
      }

      console.log('\n--- 分批执行电影与字幕标准重命名 ---');
      const renameStats = await bridge.batchRename(plan.plannedItems, {
        batchSize: 120,
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(
        `  重命名完成：已改名 ${renameStats.renamedCount} 个，原名已符合规范跳过 ${renameStats.skippedSameNameCount} 个。`
      );

      await fs.writeFile(
        rollbackFile,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            driveType: bridge.driveType,
            mediaType: 'movie',
            rootCid: treeInfo.rootCid,
            fullPathText: treeInfo.fullPathText,
            movieTitle: tmdbMeta.title,
            items: plan.plannedItems.map((x, idx) => ({
              ...initialSnapshotItems[idx],
              currentId: x.id,
              currentPid: x.parentId,
            })),
          },
          null,
          2
        ),
        'utf8'
      );

      let renamedFolder = false;
      let finalRootCid = treeInfo.rootCid;
      if (opts.renameFolder && plan.suggestedFolderName && treeInfo.rootCid) {
        const currentFolderName = treeInfo.fullPathText.split('/').map((s) => s.trim()).filter(Boolean).pop() || '';
        if (currentFolderName && currentFolderName !== plan.suggestedFolderName) {
          console.log(`\n--- 电影目录规范重命名 ---`);
          console.log(`  ${currentFolderName} -> ${plan.suggestedFolderName}`);
          try {
            await bridge.batchRename([
              {
                id: treeInfo.rootCid,
                newName: plan.suggestedFolderName,
                oldName: currentFolderName,
              },
            ]);
            renamedFolder = true;
            finalRootCid = bridge.resolveRenamedFolderId(treeInfo.rootCid, plan.suggestedFolderName);
          } catch (e) {
            console.warn(`  [!] 目录重命名提示: ${e.message}`);
          }
        }
      }

      let cleanedDirCount = 0;
      const candidateCleanupDirs = selectFoldersForCleanup(treeInfo, opts.cleanEmptyDirs, new Set());
      if (candidateCleanupDirs.length > 0) {
        console.log('\n--- 清理空目录与旧解压临时文件夹 ---');
        const cleanRes = await bridge.cleanVerifiedEmptySubfolders(
          candidateCleanupDirs,
          (msg) => console.log(`  ${msg}`)
        );
        cleanedDirCount = cleanRes.deletedCount;
      }

      await bridge.reloadView(finalRootCid);
      console.log('\n============================================================');
      console.log(
        `电影资源整理全部完成！` +
          `改名 ${renameStats.renamedCount} 个，字幕归位 ${movedCount} 个` +
          (renamedFolder ? `，电影目录已更新为《${plan.suggestedFolderName}》` : '') +
          (candidateCleanupDirs.length > 0 ? `，清理腾空目录 ${cleanedDirCount} 个。` : '。')
      );
      if (rollbackFile) {
        console.log(`本地回滚快照: "${rollbackFile}"`);
      }
      console.log('============================================================\n');
      return;
    }

    // 分支 B-2：TMDB 剧集分季整理模式
    let resolvedTmdbUrl = opts.tmdbUrl;
    let tmdbSearchSummary = null;

    if (!resolvedTmdbUrl && opts.tmdbQuery) {
      console.log(`正在按剧名检索 TMDB 媒体库: "${opts.tmdbQuery}" ...`);
      const searchRes = await searchTmdbTvShows(opts.tmdbQuery, cdpManager);
      if (!searchRes.selected) {
        throw new Error(
          `未在 TMDB 搜索到与 "${opts.tmdbQuery}" 匹配的电视节目，请核对剧名（或尝试英文/日文原名），也可直接传入 --tmdb-url`
        );
      }
      printTmdbCandidatesBanner(searchRes, { maxDisplay: 5 });

      if (opts.execute && searchRes.ambiguousExactTie) {
        const tieDesc = searchRes.rankedCandidates
          .slice(0, 3)
          .map((c) => `《${c.title}》(${c.year ?? '年份未知'} -> ${c.seasonsUrl})`)
          .join(' / ');
        throw new Error(
          `检测到完全同名多版本剧集歧义 [${tieDesc}]，为防止误改名，正式执行 (--execute) 请显式锁定对应的 --tmdb-url！`
        );
      }

      resolvedTmdbUrl = searchRes.selected.seasonsUrl;
      tmdbSearchSummary = {
        rawQuery: searchRes.rawQuery,
        yearHint: searchRes.yearHint,
        ambiguousExactTie: searchRes.ambiguousExactTie,
        selected: searchRes.selected,
        topCandidates: searchRes.rankedCandidates.slice(0, 5),
      };
    }

    // 3. 并行获取 TMDB 季度信息与网盘目录文件树（含压缩包自动预检/解压与多层穿透）
    console.log(
      `正在并行解析 TMDB 季度页面 (${resolvedTmdbUrl}) 与穿透扫描 ${bridge.driveLabel} 目标目录 (id=${targetCid}, maxDepth=${opts.maxDepth}) ...`
    );
    const [tmdbMeta, { treeInfo, effectiveFiles, archiveSummary }] = await Promise.all([
      fetchTmdbSeasons(resolvedTmdbUrl, cdpManager),
      prepareArchivesAndFiles({
        bridge,
        targetCid,
        scanOpts: {
          maxSubfolderDepth: opts.maxDepth,
          includeSeasonFolders: true,
          protectTopSeasonDirs: false,
        },
        opts,
      }),
    ]);
    if (opts.tmdbQuery) {
      tmdbMeta.userQuery = opts.tmdbQuery;
    }

    const { ads: detectedAds, cleanFiles } = filterAdFiles(effectiveFiles, { enabled: opts.cleanAds });
    const workingFiles = opts.cleanAds ? cleanFiles : effectiveFiles;

    // 当检测到本地子目录分类与 TMDB 季度结构不一致（如 承/转/结、Part 1/2、多篇章或含 .5 番外 / SP / OVA 特别篇）时，补充拉取单季详情与双语简介以精确对齐
    if (needsEpisodeEnrichment(workingFiles, tmdbMeta)) {
      console.log(
        '检测到本地文件夹分类与 TMDB 季度存在差异或包含特别篇/番外，正在拉取 TMDB 单集标题与剧情简介以精确对齐 ...'
      );
      const activeSeasonNumbers = detectActiveSeasonsFromFiles(workingFiles, tmdbMeta);
      await enrichTmdbSeasonsWithEpisodes(tmdbMeta, cdpManager, 'zh-CN', { activeSeasonNumbers });
    }

    // 4. 生成归类与重命名计划
    const plan = buildOrganizationPlan({
      files: workingFiles,
      tmdbMeta,
      filePattern: opts.filePattern,
      filePatternExplicit: opts.filePatternExplicit,
      seasonPattern: opts.seasonPattern,
      seasonPatternExplicit: opts.seasonPatternExplicit,
      useTmdbSeasonNames: opts.useTmdbSeasonNames,
      folderPattern: opts.folderPattern,
      withTitle: opts.withTitle,
      explicitOffset: opts.explicitOffset,
      trustSpNum: opts.trustSpNum,
      spMap: opts.spMap,
    });

    printPlanSummary({
      tmdbMeta,
      treeInfo,
      plan,
      archiveSummary,
      renameFolder: opts.renameFolder,
      driveLabel: bridge.driveLabel,
    });

    if (detectedAds.length > 0) {
      console.log(`\n【广告引流垃圾清理预览】(待移入回收站，共 ${detectedAds.length} 个):`);
      for (const a of detectedAds) {
        console.log(`  - 🗑️ [待清理] ${a.name} (${((a.size || 0) / (1024 * 1024)).toFixed(2)} MB)`);
      }
    }

    const latestPlanFile = path.join(SNAPSHOT_DIR, `latest-dry-run-${safeFileCid}.json`);
    await writeSnapshotJson(latestPlanFile, {
      generatedAt: new Date().toISOString(),
      driveType: bridge.driveType,
      tmdbUrl: resolvedTmdbUrl,
      tmdbSearch: tmdbSearchSummary,
      showTitle: tmdbMeta.showTitle,
      rootCid: treeInfo.rootCid,
      fullPathText: treeInfo.fullPathText,
      archiveSummary,
      plan,
    });
    console.log(`完整映射明细已保存至: ${latestPlanFile}`);

    if (opts.dryRun) {
      console.log(`\n当前为 Dry-Run 预览模式，未对 ${bridge.driveLabel} 发起任何写入修改。`);
      return;
    }

    if (plan.conflicts.length > 0) {
      throw new Error(`存在 ${plan.conflicts.length} 处目标文件名冲突，已中止执行！`);
    }
    if (plan.plannedItems.length === 0) {
      console.log('未发现需要处理的媒体文件，无需执行写入。');
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rollbackFile = path.join(SNAPSHOT_DIR, `rollback-${safeFileCid}-${stamp}.json`);
    const initialSnapshotItems = plan.plannedItems.map((x) => ({
      id: x.id,
      oldName: x.oldName,
      newName: x.newName,
      oldPid: x.parentId,
      targetFolderName: x.targetFolderName,
    }));
    await writeSnapshotJson(rollbackFile, {
      createdAt: new Date().toISOString(),
      driveType: bridge.driveType,
      rootCid: treeInfo.rootCid,
      fullPathText: treeInfo.fullPathText,
      showTitle: tmdbMeta.showTitle,
      items: initialSnapshotItems,
    });
    console.log(`\n已生成本地回滚保护快照: ${rollbackFile}`);

    if (opts.cleanAds && detectedAds.length > 0) {
      await executeAdsCleanup(bridge, detectedAds, treeInfo.rootCid);
    }

    console.log('\n--- Step 1: 创建/复用季度文件夹 ---');
    const seasonCidMap = await bridge.ensureSeasonFolders(
      treeInfo.rootCid,
      plan.requiredSeasons,
      treeInfo.existingSeasonFolders,
      (msg) => console.log(`  ${msg}`)
    );

    const hasSameSourceNewName = (() => {
      const seen = new Set();
      for (const x of plan.plannedItems) {
        const k = `${x.parentId}:${x.newName.toLowerCase()}`;
        if (seen.has(k)) return true;
        seen.add(k);
      }
      return false;
    })();

    const itemsByFolder = new Map();
    for (const item of plan.plannedItems) {
      if (!itemsByFolder.has(item.targetFolderName)) {
        itemsByFolder.set(item.targetFolderName, []);
      }
      itemsByFolder.get(item.targetFolderName).push(item);
    }

    const executeSeasonMoves = async () => {
      console.log('\n--- 按季度分批提取与归类移动 ---');
      let moved = 0;
      for (const [folderName, groupItems] of itemsByFolder) {
        const destCid = seasonCidMap.get(folderName);
        if (!destCid) {
          throw new Error(`未找到目标季度目录 "${folderName}" 的标识`);
        }
        const res = await bridge.batchMoveToFolder(destCid, groupItems, {
          batchSize: 150,
          onProgress: (msg) => console.log(`  [${folderName}] ${msg}`),
        });
        moved += res.movedCount;
      }
      return moved;
    };

    const executeStandardRenames = async () => {
      console.log('\n--- 分批执行标准重命名 ---');
      const renameStats = await bridge.batchRename(plan.plannedItems, {
        batchSize: 120,
        onProgress: (msg) => console.log(`  ${msg}`),
      });
      console.log(
        `  重命名完成：已改名 ${renameStats.renamedCount} 个，原名已符合规范跳过 ${renameStats.skippedSameNameCount} 个。`
      );
      return renameStats;
    };

    let totalMoved = 0;
    if (hasSameSourceNewName) {
      totalMoved = await executeSeasonMoves();
      await executeStandardRenames();
    } else {
      await executeStandardRenames();
      totalMoved = await executeSeasonMoves();
    }

    // 同步记录最终 currentId，支持百度网盘等路径主键网盘的无损回滚
    await fs.writeFile(
      rollbackFile,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          driveType: bridge.driveType,
          rootCid: treeInfo.rootCid,
          fullPathText: treeInfo.fullPathText,
          showTitle: tmdbMeta.showTitle,
          items: plan.plannedItems.map((x, idx) => ({
            ...initialSnapshotItems[idx],
            currentId: x.id,
            currentPid: x.parentId,
          })),
        },
        null,
        2
      ),
      'utf8'
    );

    let cleanedDirCount = 0;
    const activeTargetSeasonCids = new Set([...seasonCidMap.values()].map(String));
    const candidateCleanupDirs = selectFoldersForCleanup(
      treeInfo,
      opts.cleanEmptyDirs,
      activeTargetSeasonCids
    );
    if (candidateCleanupDirs.length > 0) {
      console.log('\n--- Step 4: 自底向上逐层校验并清理已腾空的旧拆分目录/多层目录/解压暂存夹 ---');
      const cleanRes = await bridge.cleanVerifiedEmptySubfolders(
        candidateCleanupDirs,
        (msg) => console.log(`  ${msg}`)
      );
      cleanedDirCount = cleanRes.deletedCount;
    }

    let renamedFolder = false;
    let finalRootCid = treeInfo.rootCid;
    if (opts.renameFolder && plan.suggestedFolderName && treeInfo.rootCid) {
      const currentFolderName = treeInfo.fullPathText.split('/').map((s) => s.trim()).filter(Boolean).pop() || '';
      if (currentFolderName && currentFolderName !== plan.suggestedFolderName) {
        console.log(`\n--- 资源根目录规范化重命名 ---`);
        console.log(`  ${currentFolderName} -> ${plan.suggestedFolderName}`);
        try {
          await bridge.batchRename([
            {
              id: treeInfo.rootCid,
              newName: plan.suggestedFolderName,
              oldName: currentFolderName,
            },
          ]);
          renamedFolder = true;
          finalRootCid = bridge.resolveRenamedFolderId(treeInfo.rootCid, plan.suggestedFolderName);
        } catch (e) {
          console.warn(`  [!] 资源目录重命名提示: ${e.message}`);
        }
      }
    }

    await bridge.reloadView(finalRootCid);
    console.log('\n============================================================');
    console.log(
      `全部执行完毕！` +
        (archiveSummary?.unpackedCount ? `在线解压字幕压缩包 ${archiveSummary.unpackedCount} 个，` : '') +
        `共建立/复用 ${seasonCidMap.size} 个季度目录，移动归类 ${totalMoved} 个文件` +
        (candidateCleanupDirs.length > 0 ? `，校验并清理空目录 ${cleanedDirCount} 个` : '') +
        (renamedFolder ? `，资源目录已规范为“${plan.suggestedFolderName}”。` : '。')
    );
    console.log(`本地回滚快照: "${rollbackFile}"`);
    console.log('============================================================\n');
  } finally {
    await session.close().catch(() => {});
    await cdpManager.close().catch(() => {});
  }
}

const IS_MAIN_MODULE = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      fsSync.realpathSync(path.resolve(process.argv[1])) === REAL_SCRIPT_PATH
    );
  } catch {
    return false;
  }
})();

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(`\n[执行异常] ${err.message}`);
    process.exitCode = 1;
  });
}
