import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrganizationPlan,
  buildSubtitleMatchPlan,
  isSubtitleArchiveCandidate,
  parseEpisodeToken,
} from '../matcher.mjs';

test('parses season episodes and fractional specials', () => {
  assert.deepEqual(parseEpisodeToken('Show.S02E03.mkv', 'Show'), {
    kind: 'season_episode',
    season: 2,
    epStart: 3,
    epEnd: 3,
  });
  assert.deepEqual(parseEpisodeToken('Show.12.5.mkv', 'Show'), {
    kind: 'fractional_episode',
    epFloat: 12.5,
    epBase: 12,
    epStart: 12,
    epEnd: 12,
  });
});

test('matches a subtitle to the only movie and moves it beside the video', () => {
  const plan = buildSubtitleMatchPlan({
    files: [
      { id: 'video-1', parentId: 'movie-dir', name: 'Movie.2024.mkv', size: 1 },
      {
        id: 'sub-1',
        parentId: 'subs-dir',
        relativeDir: 'Subs',
        parentFolderName: 'Subs',
        name: 'Movie.2024.chs.ass',
        size: 1,
      },
    ],
  });

  assert.equal(plan.stats.matchedSubtitles, 1);
  assert.equal(plan.plannedItems[0].newName, 'Movie.2024.ass');
  assert.equal(plan.plannedItems[0].targetCid, 'movie-dir');
  assert.equal(plan.conflicts.length, 0);
});

test('keeps language suffixes when one video has multiple subtitles', () => {
  const plan = buildSubtitleMatchPlan({
    files: [
      { id: 'video-1', parentId: 'movie-dir', name: 'Movie.2024.mkv', size: 1 },
      { id: 'sub-sc', parentId: 'subs-dir', name: 'Movie.2024.sc.ass', size: 1 },
      { id: 'sub-tc', parentId: 'subs-dir', name: 'Movie.2024.tc.ass', size: 1 },
    ],
  });

  assert.deepEqual(
    plan.plannedItems.map((item) => item.newName).sort(),
    ['Movie.2024.sc.ass', 'Movie.2024.tc.ass']
  );
});

test('filters non-subtitle and continuation archives', () => {
  assert.equal(isSubtitleArchiveCandidate({ name: 'subs.zip', size: 10 }), true);
  assert.equal(isSubtitleArchiveCandidate({ name: 'Fonts.zip', size: 10 }), false);
  assert.equal(isSubtitleArchiveCandidate({ name: 'subs.part2.rar', size: 10 }), false);
});

test('builds a standard season organization plan', () => {
  const season = {
    seasonNumber: 1,
    seasonTitle: 'Season 1',
    canonicalFolderName: 'Season 1',
    episodeCount: 2,
    globalStart: 1,
    globalEnd: 2,
    cours: [],
  };
  const plan = buildOrganizationPlan({
    files: [{ id: 'video-1', parentId: 'root', name: 'Show - 01.mkv', size: 1 }],
    tmdbMeta: {
      showTitle: 'Show',
      year: 2024,
      regularSeasons: [season],
      allSeasons: [season],
      totalRegularEpisodes: 2,
      specialSeason: null,
    },
  });

  assert.equal(plan.stats.matchedVideos, 1);
  assert.equal(plan.plannedItems[0].newName, 'Show.2024.S01E01.mkv');
  assert.equal(plan.plannedItems[0].targetFolderName, 'Season 01');
});

test('normalizes spaces/dots between show title and numbers (e.g. 地球脉动 2 -> 地球脉动2)', async () => {
  const { normalizeTitleSpacing, buildCanonicalSeriesTitle, formatMediaBaseName, formatSeasonFolderName } =
    await import('../matcher.mjs');

  // 1. 规范化函数验证
  assert.equal(normalizeTitleSpacing('地球脉动 2'), '地球脉动2');
  assert.equal(normalizeTitleSpacing('【地球脉动 2】'), '【地球脉动2】');
  assert.equal(normalizeTitleSpacing('地球脉动.2.xxxxx'), '地球脉动2.xxxxx');
  assert.equal(normalizeTitleSpacing('地球脉动_2'), '地球脉动2');
  assert.equal(normalizeTitleSpacing('全职猎人 1999'), '全职猎人 1999');
  assert.equal(normalizeTitleSpacing('地球脉动 II'), '地球脉动II');

  // 2. 剧集前缀验证（杜绝 .2. 误判为季号/集号）
  const canonicalTitle = buildCanonicalSeriesTitle({
    showTitle: '地球脉动 2',
    originalTitle: 'Planet Earth II',
  });
  assert.equal(canonicalTitle, '地球脉动2.Planet.Earth.II');

  // 3. 媒体文件名渲染验证
  const baseName = formatMediaBaseName({
    canonicalSeriesTitle: canonicalTitle,
    seasonNumber: 1,
    epStart: 1,
    year: 2016,
    releaseInfo: 'Apple.TV+.WEB-DL.2160p',
  });
  assert.equal(baseName, '地球脉动2.Planet.Earth.II.2016.S01E01.Apple.TV+.WEB-DL.2160p');

  // 4. 季度目录名称渲染验证
  const folderDefault = formatSeasonFolderName({ seasonNumber: 1 });
  assert.equal(folderDefault, 'Season 01');

  const folderTmdb = formatSeasonFolderName({
    seasonNumber: 1,
    canonicalFolderName: '地球脉动 2',
    seasonPattern: '{TmdbSeason}',
  });
  assert.equal(folderTmdb, '地球脉动2');
});

test('builds standard movie organization plan with subtitle alignment and spacing normalization', async () => {
  const { buildMovieOrganizationPlan, buildCanonicalMovieTitle, formatMovieFolderName } =
    await import('../matcher.mjs');

  const tmdbMovie = {
    movieId: '842675',
    title: '流浪地球 2',
    originalTitle: 'The Wandering Earth II',
    year: 2023,
    mediaType: 'movie',
  };

  // 1. 规范片名验证（双语 + 数字紧连）
  const canonicalTitle = buildCanonicalMovieTitle(tmdbMovie);
  assert.equal(canonicalTitle, '流浪地球2.The.Wandering.Earth.II');

  // 2. 目录名规范验证
  const folderName = formatMovieFolderName({
    movieTitle: tmdbMovie.title,
    year: tmdbMovie.year,
  });
  assert.equal(folderName, '流浪地球2（2023）');

  // 3. 规划生成（主视频 + 多语言外挂字幕）
  const files = [
    {
      id: 'v1',
      parentId: 'root',
      name: 'The.Wandering.Earth.II.2023.2160p.WEB-DL.DDP.5.1.Atmos.DV.H.265-BlackTV.mkv',
      size: 15 * 1024 * 1024 * 1024,
    },
    {
      id: 's1',
      parentId: 'sub_dir',
      relativeDir: 'Subs',
      name: 'The.Wandering.Earth.II.2023.zh-CN.ass',
      size: 100 * 1024,
    },
    {
      id: 's2',
      parentId: 'sub_dir',
      relativeDir: 'Subs',
      name: 'The.Wandering.Earth.II.2023.en.ass',
      size: 80 * 1024,
    },
    {
      id: 'bonus1',
      parentId: 'root',
      name: 'The.Wandering.Earth.II.Trailer.mp4',
      size: 200 * 1024 * 1024,
    },
  ];

  const plan = buildMovieOrganizationPlan({
    files,
    tmdbMeta: tmdbMovie,
  });

  assert.equal(plan.stats.matchedVideos, 1);
  assert.equal(plan.stats.matchedSubtitles, 2);
  assert.equal(plan.stats.skippedBonusCount, 1);
  assert.equal(plan.suggestedFolderName, '流浪地球2（2023）');

  // 视频重命名验证
  const videoItem = plan.plannedItems.find((x) => x.id === 'v1');
  assert.equal(
    videoItem.newName,
    '流浪地球2.The.Wandering.Earth.II.2023.2160p.WEB-DL.DDP.5.1.Atmos.DV.H.265.BlackTV.mkv'
  );

  // 字幕同名对齐与语言保留验证
  const subZh = plan.plannedItems.find((x) => x.id === 's1');
  assert.equal(
    subZh.newName,
    '流浪地球2.The.Wandering.Earth.II.2023.2160p.WEB-DL.DDP.5.1.Atmos.DV.H.265.BlackTV.zh-CN.ass'
  );
  assert.equal(subZh.needsMove, true); // 从 Subs 提取至根目录

  const subEn = plan.plannedItems.find((x) => x.id === 's2');
  assert.equal(
    subEn.newName,
    '流浪地球2.The.Wandering.Earth.II.2023.2160p.WEB-DL.DDP.5.1.Atmos.DV.H.265.BlackTV.en.ass'
  );
});

test('handles foreign film Oppenheimer and split-disc CD1/CD2 movie organization', async () => {
  const { buildMovieOrganizationPlan, buildCanonicalMovieTitle } = await import('../matcher.mjs');

  const tmdbMovie = {
    movieId: '872585',
    title: '奥本海默',
    originalTitle: 'Oppenheimer',
    year: 2023,
    mediaType: 'movie',
  };

  assert.equal(buildCanonicalMovieTitle(tmdbMovie), '奥本海默.Oppenheimer');

  const files = [
    {
      id: 'oppen-v1',
      parentId: 'root',
      name: 'Oppenheimer.2023.2160p.UHD.BluRay.x265.10bit.DTS-HD.MA.5.1-CHDBits.mkv',
      size: 30 * 1024 * 1024 * 1024,
    },
    {
      id: 'oppen-s1',
      parentId: 'root',
      name: 'Oppenheimer.2023.chs.srt',
      size: 50 * 1024,
    },
  ];

  const plan = buildMovieOrganizationPlan({
    files,
    tmdbMeta: tmdbMovie,
  });

  assert.equal(plan.stats.matchedVideos, 1);
  assert.equal(plan.stats.matchedSubtitles, 1);
  assert.equal(
    plan.plannedItems[0].newName,
    '奥本海默.Oppenheimer.2023.2160p.UHD.BluRay.x265.10bit.DTS-HD.MA.5.1.CHDBits.mkv'
  );
  // 单字幕时自适应对齐为纯视频同名（无多余语言后缀，保证 115 原生播放器 100% 自动挂载）
  assert.equal(
    plan.plannedItems[1].newName,
    '奥本海默.Oppenheimer.2023.2160p.UHD.BluRay.x265.10bit.DTS-HD.MA.5.1.CHDBits.srt'
  );
});

test('handles hyphen-year separation and full-width brackets in release payload', async () => {
  const { parseEpisodeToken, extractReleasePayload, buildOrganizationPlan } = await import('../matcher.mjs');

  // 1. 验证 S01E01-2023 不会误判为 E01 至 E2023 跨集
  const token = parseEpisodeToken('S01E01-2023.2160p.AMZN.WEB-DL.DDP5.1.H265.HDR.DV-年糕.mkv', 'V世代');
  assert.equal(token.season, 1);
  assert.equal(token.epStart, 1);
  assert.equal(token.epEnd, 1);

  // 2. 验证全角中括号【】被规范解析，不残留残破中括号
  const wRelease = extractReleasePayload(
    'S01E01-【CXRAW】【仮面ライダーW】【Wの検索／探偵は二人で一人】【BDrip】【1080P】【HEVC Main10P FLAC MKV】',
    { showTitles: ['假面骑士W', '仮面ライダーW'] }
  );
  assert.ok(!wRelease.includes('】'));
  assert.ok(!wRelease.includes('【'));
  assert.ok(wRelease.includes('BDrip.1080P.HEVC.Main10P.FLAC.MKV'));

  // 3. 验证特别篇继承全局主年份
  const tmdbMeta = {
    showTitle: '超感猎杀',
    originalTitle: 'Sense8',
    year: 2015,
    totalRegularEpisodes: 24,
    regularSeasons: [
      {
        seasonNumber: 1,
        seasonTitle: '第 1 季',
        episodeCount: 12,
        year: 2015,
        globalStart: 1,
        globalEnd: 12,
      },
    ],
    specialSeason: {
      seasonNumber: 0,
      seasonTitle: '特别篇',
      episodeCount: 2,
      year: null,
    },
    allSeasons: [
      {
        seasonNumber: 0,
        seasonTitle: '特别篇',
        episodeCount: 2,
        year: null,
      },
      {
        seasonNumber: 1,
        seasonTitle: '第 1 季',
        episodeCount: 12,
        year: 2015,
      },
    ],
  };

  const plan = buildOrganizationPlan({
    files: [
      {
        id: 'sp1',
        name: 'Sense8.Christmas.S00E01.1080p.NF.WEBRip.DD5.1.x264-SB.mkv',
        parentId: 'root',
        size: 2 * 1024 * 1024 * 1024,
      },
    ],
    tmdbMeta,
  });

  assert.equal(plan.canonicalSeriesTitle, '超感猎杀.Sense8');
  assert.equal(
    plan.plannedItems[0].newName,
    '超感猎杀.Sense8.2015.S00E01.1080p.NF.WEBRip.DD5.1.x264.SB.mkv'
  );
});

test('formats resource folder names: English when no Chinese, with year in full-width parentheses', async () => {
  const { formatResourceFolderName, buildOrganizationPlan } = await import('../matcher.mjs');

  // 1. TMDB 中无中文名（如 Slow Horses），直接使用英文名 + 上映年份（全角括号）
  const slowHorsesFolder = formatResourceFolderName({
    showTitle: 'Slow Horses',
    originalTitle: 'Slow Horses',
    year: 2022,
  });
  assert.equal(slowHorsesFolder, 'Slow Horses（2022）');

  // 2. TMDB 中有中文名（如 死亡笔记 / 萤火虫），使用中文名 + 年份
  const deathNoteFolder = formatResourceFolderName({
    showTitle: '死亡笔记',
    originalTitle: 'Death Note',
    year: 2006,
  });
  assert.equal(deathNoteFolder, '死亡笔记（2006）');

  // 3. 中文名 + 续作数字去空格（如 地球脉动 2 -> 地球脉动2（2016））
  const planetEarthFolder = formatResourceFolderName({
    showTitle: '地球脉动 2',
    year: 2016,
  });
  assert.equal(planetEarthFolder, '地球脉动2（2016）');

  // 4. 原名已带年份时不重复附加
  const alreadyWithYear = formatResourceFolderName({
    showTitle: '流人（2022）',
    year: 2022,
  });
  assert.equal(alreadyWithYear, '流人（2022）');

  // 5. 验证剧集规划 buildOrganizationPlan 生成 suggestedFolderName
  const tmdbSlowHorses = {
    showTitle: 'Slow Horses',
    originalTitle: 'Slow Horses',
    year: 2022,
    totalRegularEpisodes: 6,
    regularSeasons: [
      {
        seasonNumber: 1,
        seasonTitle: '第 1 季',
        episodeCount: 6,
        year: 2022,
        globalStart: 1,
        globalEnd: 6,
      },
    ],
    allSeasons: [
      {
        seasonNumber: 1,
        seasonTitle: '第 1 季',
        episodeCount: 6,
        year: 2022,
      },
    ],
  };

  const tvPlan = buildOrganizationPlan({
    files: [
      {
        id: 'sh-1',
        name: 'Slow.Horses.S01E01.mkv',
        parentId: 'root',
        size: 1024 * 1024 * 100,
      },
    ],
    tmdbMeta: tmdbSlowHorses,
  });

  assert.equal(tvPlan.suggestedFolderName, 'Slow Horses（2022）');
});

test('matches Special (SP/OVA) episodes via TMDB Season 0 title and overview description instead of blind SP01->S00E01', () => {
  const tmdbMeta = {
    showTitle: '测试动漫',
    originalTitle: 'Test Anime',
    year: 2024,
    totalRegularEpisodes: 12,
    regularSeasons: [
      {
        seasonNumber: 1,
        seasonTitle: '第 1 季',
        episodeCount: 12,
        year: 2024,
        globalStart: 1,
        globalEnd: 12,
      },
    ],
    specialSeason: {
      seasonNumber: 0,
      seasonTitle: '特别篇',
      episodeCount: 4,
      year: 2024,
      episodes: [
        {
          episodeNumber: 1,
          title: '前半总集篇：回忆的起点',
          overview: '回顾第一季第1集至第6集的主线剧情总集篇。',
        },
        {
          episodeNumber: 2,
          title: '第 2 集',
          overview: '广播剧特典小剧场：学园祭筹备日常。',
        },
        {
          episodeNumber: 3,
          title: '第 3 集',
          overview: 'BD附赠OVA番外：主角团前往箱根温泉旅馆合宿旅行的爆笑故事。',
        },
        {
          episodeNumber: 4,
          title: '锅物料理大决战',
          overview: '众人围绕火锅食材展开的料理对决特别篇。',
        },
      ],
    },
    allSeasons: [
      { seasonNumber: 0, seasonTitle: '特别篇', episodeCount: 4, year: 2024 },
      { seasonNumber: 1, seasonTitle: '第 1 季', episodeCount: 12, year: 2024 },
    ],
  };

  // SP01 带描述词 "箱根温泉合宿"（仅出现在 TMDB S00E03 的 overview 简介中，标题为占位符"第 3 集"）
  // SP02 带标题词 "锅物料理"（匹配 TMDB S00E04 标题）
  const files = [
    {
      id: 'v-sp1',
      parentId: 'root',
      name: '[SubGroup] Test Anime - SP01 箱根温泉合宿 [BDRip 1080p HEVC].mkv',
      size: 1000,
    },
    {
      id: 's-sp1',
      parentId: 'root',
      name: '[SubGroup] Test Anime - SP01 箱根温泉合宿 [BDRip 1080p HEVC].sc.ass',
      size: 10,
    },
    {
      id: 'v-sp2',
      parentId: 'root',
      name: '[SubGroup] Test Anime - SP02 锅物料理 [BDRip 1080p HEVC].mkv',
      size: 1000,
    },
  ];

  const plan = buildOrganizationPlan({ files, tmdbMeta });
  assert.equal(plan.stats.matchedVideos, 2);
  assert.equal(plan.stats.matchedSubtitles, 1);

  const sp1Video = plan.plannedItems.find((x) => x.id === 'v-sp1');
  const sp1Sub = plan.plannedItems.find((x) => x.id === 's-sp1');
  const sp2Video = plan.plannedItems.find((x) => x.id === 'v-sp2');

  // SP01 应通过简介语义命中 S00E03，而非盲目命名为 S00E01
  assert.equal(sp1Video.epStart, 3);
  assert.equal(sp1Video.targetFolderName, 'Specials');
  assert.match(sp1Video.newName, /\.S00E03\./);

  // 同集外挂字幕同步联动至 S00E03
  assert.equal(sp1Sub.epStart, 3);
  assert.match(sp1Sub.newName, /\.S00E03\./);

  // SP02 应命中 S00E04
  assert.equal(sp2Video.epStart, 4);
  assert.match(sp2Video.newName, /\.S00E04\./);
});

test('intercepts unverified pure-number SP files when local count mismatches TMDB Season 0 count, and supports --sp-map / --trust-sp-num', () => {
  const tmdbMeta = {
    showTitle: '测试剧集',
    originalTitle: 'Test Show',
    year: 2024,
    totalRegularEpisodes: 12,
    regularSeasons: [
      {
        seasonNumber: 1,
        seasonTitle: '第 1 季',
        episodeCount: 12,
        year: 2024,
        globalStart: 1,
        globalEnd: 12,
      },
    ],
    specialSeason: {
      seasonNumber: 0,
      seasonTitle: '特别篇',
      episodeCount: 6,
      year: 2024,
      episodes: [
        { episodeNumber: 1, title: '幕后花絮 1', overview: '访谈特辑' },
        { episodeNumber: 2, title: '幕后花絮 2', overview: '制作特辑' },
        { episodeNumber: 3, title: '总集篇', overview: '剧情回顾' },
        { episodeNumber: 4, title: 'OVA 1：异世界番外', overview: '番外故事一' },
        { episodeNumber: 5, title: 'OVA 2：夏日祭典', overview: '番外故事二' },
        { episodeNumber: 6, title: '完结纪念特别篇', overview: '最终章纪念' },
      ],
    },
    allSeasons: [
      { seasonNumber: 0, seasonTitle: '特别篇', episodeCount: 6, year: 2024 },
      { seasonNumber: 1, seasonTitle: '第 1 季', episodeCount: 12, year: 2024 },
    ],
  };

  // 纯序号 SP01.mkv 无任何描述词，且本地仅 1 个 SP（TMDB 有 6 个）
  const bareSpFiles = [
    { id: 'sp-bare', parentId: 'root', name: '[Group] Test Show - SP01 [1080p].mkv', size: 1000 },
  ];

  // 1. 默认应触发防盲改拦截，放入 unmatchedFiles 并标记 isUnverifiedSpecial
  const safePlan = buildOrganizationPlan({ files: bareSpFiles, tmdbMeta });
  assert.equal(safePlan.stats.matchedVideos, 0);
  assert.equal(safePlan.unmatchedFiles.length, 1);
  assert.equal(safePlan.unmatchedFiles[0].isUnverifiedSpecial, true);

  // 2. 传入 --sp-map "SP01=S00E06" 时精确映射至 S00E06
  const mappedPlan = buildOrganizationPlan({
    files: bareSpFiles,
    tmdbMeta,
    spMap: 'SP01=S00E06',
  });
  assert.equal(mappedPlan.stats.matchedVideos, 1);
  assert.equal(mappedPlan.plannedItems[0].epStart, 6);
  assert.match(mappedPlan.plannedItems[0].newName, /\.S00E06\./);

  // 3. 传入 --trust-sp-num 时信任原序号映射至 S00E01
  const trustedPlan = buildOrganizationPlan({
    files: bareSpFiles,
    tmdbMeta,
    trustSpNum: true,
  });
  assert.equal(trustedPlan.stats.matchedVideos, 1);
  assert.equal(trustedPlan.plannedItems[0].epStart, 1);

  // 4. OVA 子类型序号对齐：当本地有 OVA1、OVA2（共 2 个）且 TMDB Season 0 中恰好有 2 个 OVA (E04, E05) 时，自动按 OVA 顺位对齐到 S00E04 / S00E05
  const ovaFiles = [
    { id: 'ova-1', parentId: 'root', name: '[Group] Test Show - OVA1 [1080p].mkv', size: 1000 },
    { id: 'ova-2', parentId: 'root', name: '[Group] Test Show - OVA2 [1080p].mkv', size: 1000 },
  ];
  const ovaPlan = buildOrganizationPlan({ files: ovaFiles, tmdbMeta });
  assert.equal(ovaPlan.stats.matchedVideos, 2);
  assert.equal(ovaPlan.plannedItems.find((x) => x.id === 'ova-1').epStart, 4);
  assert.equal(ovaPlan.plannedItems.find((x) => x.id === 'ova-2').epStart, 5);
});

test('standardizes season folder names to Season 01 / Specials by default across UGREEN / ZSpace / fnOS even during folder reclassification', () => {
  const s1 = {
    seasonNumber: 1,
    seasonTitle: '无头骑士异闻录',
    canonicalFolderName: '无头骑士异闻录',
    episodeCount: 24,
    year: 2010,
    globalStart: 1,
    globalEnd: 24,
    cours: [],
  };
  const s2 = {
    seasonNumber: 2,
    seasonTitle: '无头骑士异闻录×2',
    canonicalFolderName: '无头骑士异闻录×2',
    episodeCount: 36,
    year: 2015,
    globalStart: 25,
    globalEnd: 60,
    cours: [
      { label: '承', epOffset: 0, epStart: 1, epEnd: 12, count: 12 },
      { label: '转', epOffset: 12, epStart: 13, epEnd: 24, count: 12 },
      { label: '结', epOffset: 24, epStart: 25, epEnd: 36, count: 12 },
    ],
  };
  const tmdbMeta = {
    showTitle: '无头骑士异闻录',
    originalTitle: 'デュラララ!!',
    year: 2010,
    totalRegularEpisodes: 60,
    regularSeasons: [s1, s2],
    allSeasons: [s1, s2],
    specialSeason: null,
  };

  const files = [
    {
      id: 'arc-1',
      parentId: 'dir-cheng',
      parentFolderName: '无头骑士异闻录×2 承',
      relativeDir: '无头骑士异闻录×2 承',
      name: '[ank] Durarara!!x2 Shou - 01 [1080p].mkv',
      size: 1000,
    },
    {
      id: 'arc-2',
      parentId: 'dir-zhuan',
      parentFolderName: '无头骑士异闻录×2 转',
      relativeDir: '无头骑士异闻录×2 转',
      name: '[ank] Durarara!!x2 Ten - 01 [1080p].mkv',
      size: 1000,
    },
  ];

  // 默认使用跨 NAS 标准英文目录名 Season 02（兼容绿联、极空间、飞牛）
  const defaultPlan = buildOrganizationPlan({ files, tmdbMeta });
  assert.equal(defaultPlan.reclassification.isMismatched, true);
  assert.equal(defaultPlan.plannedItems[0].targetFolderName, 'Season 02');
  assert.equal(defaultPlan.plannedItems[0].epStart, 1);
  assert.equal(defaultPlan.plannedItems[1].targetFolderName, 'Season 02');
  assert.equal(defaultPlan.plannedItems[1].epStart, 13);

  // 显式传入 useTmdbSeasonNames: true 时才采用 TMDB 中文季名
  const customSeasonNamePlan = buildOrganizationPlan({
    files,
    tmdbMeta,
    useTmdbSeasonNames: true,
  });
  assert.equal(customSeasonNamePlan.plannedItems[0].targetFolderName, '无头骑士异闻录×2');
});






