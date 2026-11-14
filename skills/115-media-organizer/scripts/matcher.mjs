/**
 * 核心媒体集数解析、连续集数季度折算、自定义命名规范模板与外挂字幕配对模块
 *
 * 默认黄金准则：
 * 1. 当检测到外挂字幕时，支持：
 *    - 独立字幕对齐模式 (buildSubtitleMatchPlan)：不修改现有视频文件名，自动将散落字幕归位至对应视频同目录并严格对齐视频名；
 *    - TMDB 分季联动模式 (buildOrganizationPlan)：视频主文件 + 同集外挂字幕同步归类与改名。
 * 2. 外挂字幕自适应后缀策略（兼顾 115 原生播放器 100% 自动挂载与多语言防冲突）：
 *    - 同一视频仅有 1 个字幕（或 1 组同源 .idx+.sub）时：直接采用“视频同名.ext”（如 S01E01.ass）；
 *    - 同一视频存在多个字幕时：全部保留语言轨道标识（如 S01E01.sc.ass 与 S01E01.tc.ass）。
 * 3. 仅对实际存在匹配文件的季度生成建文件夹指令，默认绝不预建空文件夹。
 */

export const VIDEO_EXTENSIONS = new Set([
  'mkv',
  'mp4',
  'avi',
  'ts',
  'm2ts',
  'mov',
  'wmv',
  'flv',
  'rmvb',
  'webm',
  'iso',
  'mpg',
  'mpeg',
]);

export const SUBTITLE_EXTENSIONS = new Set([
  'ass',
  'ssa',
  'srt',
  'sup',
  'sub',
  'idx',
  'vtt',
]);

export const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
]);

// 排除多分卷压缩包的后续分卷（如 .part2.rar / .part02.rar / .r01 / .z01），仅对首卷或独立压缩包触发解压
const MULTI_PART_CONTINUATION_REGEX =
  /\.(?:part0*(?:[2-9]|\d{2,})\.rar|r\d{2,3}|z\d{2,3})$/i;

// 排除非字幕类常规附加包（如字体包 Fonts、原声集 OST/Music、扫图 Scans/Artbook、广播剧 Drama 等），避免无谓耗时解压
const NON_SUBTITLE_ARCHIVE_REGEX =
  /(?:^|[\s._\-\[(])(?:fonts?|ost|music|songs?|bgm|scans?|artbook|covers?|booklet|soundtrack|drama|bonus|menu|theme)(?:$|[\s._\-\])])/i;

export function isSubtitleArchiveCandidate(file, { maxArchiveSizeMB = 300 } = {}) {
  const name = String(file?.name || '');
  const ext = getExtension(name);
  if (!ARCHIVE_EXTENSIONS.has(ext)) return false;
  if (MULTI_PART_CONTINUATION_REGEX.test(name)) return false;
  if (NON_SUBTITLE_ARCHIVE_REGEX.test(stripExtension(name))) return false;
  const maxBytes = maxArchiveSizeMB * 1024 * 1024;
  if (Number(file?.size || 0) > maxBytes) return false;
  return true;
}

const BONUS_CLIP_REGEX =
  /(?:^|[\s._\-\[\]()])(?:NCOP\d*|NCED\d*|Creditless|Clean[\s._-]*OP|Clean[\s._-]*ED|Menu\d*|(?:PV|CM)(?:[\s._&-]*(?:PV|CM))?[\s._-]*\d+|PR[\s._-]*footage\d*|Promotiona?[_\s-]*Video|Preview|Trailer|Teaser|Making)(?:$|[\s._\-\[\]()])/i;

const KNOWN_SUB_LANG_REGEX =
  /(?:[._\-\s\[（(【])((?:zh[-_](?:CN|TW|HK|SG|Hans|Hant)|chs(?:[&_](?:jpn?|eng?))?|cht(?:[&_](?:jpn?|eng?))?|jpsc|jptc|scjp|tcjp|jp_sc|jp_tc|sc(?:[&_](?:jpn?|eng?))?|tc(?:[&_](?:jpn?|eng?))?|zh[&_]en|gb|big5|chi|zho|jpn?|ja|eng?|en|kor?|fre?|ger?|spa?|rus?|简体(?:中文)?|繁体(?:中文)?|简中|繁中|简日(?:双语)?|繁日(?:双语)?|简英(?:双语)?|繁英(?:双语)?|中英(?:双语)?|中文字幕|双语|简繁|国配|粤语|bili|default|forced))[)\]）】]?$/i;

export function getExtension(filename = '') {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

export function stripExtension(filename = '') {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return filename;
  return filename.slice(0, idx);
}

export function isBonusClip(filename = '') {
  return BONUS_CLIP_REGEX.test(stripExtension(filename));
}

/**
 * 规范化标题中的空格与数字排版：取消文字与数字/罗马数字之间的空格、点号与下划线
 * 例如 "地球脉动 2" / "地球脉动.2" -> "地球脉动2"，避免媒体服务器刮削器误判为季号或集号
 */
export function normalizeTitleSpacing(str = '') {
  if (!str) return '';
  return String(str)
    // 1. 中文/日文假名字符与后续数字/罗马数字之间的空格、点号、下划线（如 "地球脉动 2" -> "地球脉动2"、"地球脉动.2" -> "地球脉动2"）
    // 排除四位年份（1900-2099），避免把 "剧名 2024" 合并为 "剧名2024"
    .replace(/([\u4e00-\u9fa5\u3040-\u30ff])\s*[._\s]\s*(\d+|[IVXLCDM]+)(?=$|[\s._\-\]）)】\/:：])/g, (match, p1, p2) => {
      if (/^\d{4}$/.test(p2)) {
        const y = Number(p2);
        if (y >= 1900 && y <= 2099) return match;
      }
      return `${p1}${p2}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeFilenamePart(str = '') {
  return normalizeTitleSpacing(
    String(str)
      .replace(/[\/\\:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function stripTechnicalNoiseKeepLang(stem = '') {
  return stem
    .replace(/\[[0-9A-Fa-f]{8}\]/g, '')
    .replace(/[\s._\-\[(]*(?:3840x2160|1920x1080|1280x720|2160p|1080p|1080i|720p|576p|480p|4K|UHD)[\])]*/gi, '')
    .replace(/[\s._\-\[(]*(?:Ma10p|Hi10p|10bit|8bit|12bit|HDR10\+?|Dolby[\s._-]*Vision|DV)[\])]*/gi, '')
    .replace(/[\s._\-\[(]*(?:[xh]\.?264|[xh]\.?265|HEVC|AVC|AV1|VP9|MPEG[24]|XviD|DivX)[\])]*/gi, '')
    .replace(
      /[\s._\-\[(]*(?:AAC\d*(?:\.\d)?|FLAC(?:\s*\d\.\d)?|EAC3|AC3|DDP?\s*[257]\.[01]|DTS(?:-HD)?(?:\s*MA)?|TrueHD|LPCM|MP3|Opus)[\])]*/gi,
      ''
    )
    .replace(/[\s._\-\[(]*(?:WEB-?DL|WEBRip|BDRip|Blu-?ray|BD-?Remux|Remux|HDTV|DVDRip|TVRip)[\])]*/gi, '')
    .replace(/[\s._\-\[(]*(?:59\.94fps|23\.976fps|24fps|25fps|30fps|60fps|v2|v3)[\])]*/gi, '')
    .trim();
}

function escapeRegExp(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 清洗文件名中的视频编码、分辨率、CRC32 校验码、年份及剧名衍生续作乘号（如 ×2 / x2）等数字干扰项
 */
export function cleanFilenameForEpisodeParse(stem = '', showTitle = '') {
  let s = stem;

  if (showTitle) {
    const baseTitle = showTitle.split(/[：:·\-]/)[0].trim();
    for (const candidate of [showTitle.trim(), baseTitle]) {
      if (candidate.length >= 2) {
        const re = new RegExp(`${escapeRegExp(candidate)}(?:\\s*[×xX]\\s*\\d{1,2})?`, 'gi');
        s = s.replace(re, ' ');
      }
    }
  }

  return s
    .replace(KNOWN_SUB_LANG_REGEX, '')
    // 剥离紧贴在剧名/感叹号后的续作季标（如 Durarara!!x2 / 无头骑士异闻录×2），避免 2 被误判为集号；同时不影响 1x02
    .replace(/([A-Za-z\u3040-\u30ff\u4e00-\u9fff!！?？])\s*[×xX](\d{1,2})(?=$|[\s._\-\[\]()])/g, '$1 ')
    .replace(/\[[0-9A-Fa-f]{8}\]/g, ' ')
    .replace(/\b(?:3840x2160|1920x1080|1280x720|2160p|1080p|1080i|720p|576p|480p|4K|UHD)\b/gi, ' ')
    .replace(/\b(?:Ma10p|Hi10p|10bit|8bit|12bit|HDR10\+?|Dolby[\s._-]*Vision|DV)\b/gi, ' ')
    .replace(/\b(?:[xh]\.?264|[xh]\.?265|HEVC|AVC|AV1|VP9|MPEG[24]|XviD|DivX)\b/gi, ' ')
    .replace(
      /\b(?:AAC\d*(?:\.\d)?|FLAC(?:\s*\d\.\d)?|EAC3|AC3|DDP?\s*[257]\.[01]|DTS(?:-HD)?(?:\s*MA)?|TrueHD|LPCM|MP3|Opus)\b/gi,
      ' '
    )
    .replace(/\b(?:WEB-?DL|WEBRip|BDRip|Blu-?ray|BD-?Remux|Remux|HDTV|DVDRip|TVRip)\b/gi, ' ')
    .replace(/\b(?:59\.94fps|23\.976fps|24fps|25fps|30fps|60fps|v2|v3)\b/gi, ' ')
    .replace(/[\[(](?:19|20)\d{2}[\])]/g, ' ');
}

/**
 * 从单个文件名提取剧集标识（兼容标准 S01E01、中文第X话、全局集号及动画 BD 常见的 .5 半集番外如 12.5 / 4.5 / 13.5）
 */
export function parseEpisodeToken(filename, showTitle = '') {
  const stem = stripExtension(filename);
  if (isBonusClip(filename)) return null;

  const cleaned = cleanFilenameForEpisodeParse(stem, showTitle);

  // 优先识别带季号的 .5 半集（如 S01E12.5 / S02E04.5）
  const sxeHalfMatch =
    cleaned.match(/\bS(\d{1,2})\s*E(\d{1,3}\.5)\b/i) ||
    cleaned.match(/(?:^|[\s._\-\[])S(\d{1,2})\.?E(\d{1,3}\.5)(?:$|[\s._\-\]])/i);
  if (sxeHalfMatch) {
    const season = Number(sxeHalfMatch[1]);
    const epFloat = Number(sxeHalfMatch[2]);
    const epBase = Math.floor(epFloat);
    return {
      kind: 'fractional_episode',
      season,
      epFloat,
      epBase,
      epStart: epBase,
      epEnd: epBase,
    };
  }

  const sxeMatch =
    cleaned.match(/\bS(\d{1,2})\s*E(\d{1,4})(?:\s*[-~]\s*(?:E(\d{1,4})|(?!\b(?:19|20)\d{2}\b)(\d{1,3})))?\b/i) ||
    cleaned.match(/(?:^|[\s._\-\[])S(\d{1,2})\.?E(\d{1,4})(?:[-~](?:E(\d{1,4})|(?!\b(?:19|20)\d{2}\b)(\d{1,3})))?(?:$|[\s._\-\]])/i);
  if (sxeMatch) {
    const season = Number(sxeMatch[1]);
    const epStart = Number(sxeMatch[2]);
    const rawEpEnd = sxeMatch[3] ? Number(sxeMatch[3]) : sxeMatch[4] ? Number(sxeMatch[4]) : null;
    let epEnd = epStart;
    if (rawEpEnd !== null && rawEpEnd >= epStart && rawEpEnd - epStart <= 20) {
      if (!(rawEpEnd >= 1900 && rawEpEnd <= 2099)) {
        epEnd = rawEpEnd;
      }
    }
    return {
      kind: season === 0 ? 'special' : 'season_episode',
      season,
      epStart,
      epEnd,
    };
  }

  const parseChineseOrArabicNum = (str) => {
    if (!str) return null;
    const s = String(str).trim();
    if (/^\d+$/.test(s)) return Number(s);
    const cnMap = {
      '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
      '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
    };
    if (cnMap[s] !== undefined) return cnMap[s];
    if (s.startsWith('十') && s.length === 2 && cnMap[s[1]] !== undefined) {
      return 10 + cnMap[s[1]];
    }
    return null;
  };

  const cnSeasonEpMatch = cleaned.match(
    /第\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*季[\s\S]*?第\s*(\d{1,4}|[一二两三四五六七八九十]+)(?:\s*[-~]\s*(\d{1,4}|[一二两三四五六七八九十]+))?\s*[集话話]/i
  );
  if (cnSeasonEpMatch) {
    const season = parseChineseOrArabicNum(cnSeasonEpMatch[1]);
    const epStart = parseChineseOrArabicNum(cnSeasonEpMatch[2]);
    const rawEpEnd = cnSeasonEpMatch[3] ? parseChineseOrArabicNum(cnSeasonEpMatch[3]) : epStart;
    const epEnd = rawEpEnd !== null ? Math.max(epStart, rawEpEnd) : epStart;
    if (season !== null && epStart !== null) {
      return {
        kind: season === 0 ? 'special' : 'season_episode',
        season,
        epStart,
        epEnd,
      };
    }
  }

  // 识别无季号的 .5 半集番外（如 第12.5话 / [04.5] / EP13.5 / - 19.5），防止被后续整数规则误拆为第 12 或第 5 集
  const halfMatch =
    cleaned.match(/第\s*(\d{1,3}\.5)\s*[集话話期]/i) ||
    cleaned.match(/(?:^|[\s._\-\[])(?:EP?\.?|OVA|OAD|SP|Special)\s*(\d{1,3}\.5)(?:v\d)?(?:$|[\s._\-\]])/i) ||
    cleaned.match(/\[\s*(\d{1,3}\.5)(?:v\d)?\s*\]/i) ||
    cleaned.match(/-\s*(\d{1,3}\.5)(?:v\d)?(?:\s|$|\.|\[|\()/i) ||
    cleaned.match(/(?:^|[\s._\-])(\d{1,3}\.5)(?!\s*[Dd]\b)(?:$|[\s._\-])/);
  if (halfMatch) {
    const epFloat = Number(halfMatch[1]);
    const epBase = Math.floor(epFloat);
    return {
      kind: 'fractional_episode',
      epFloat,
      epBase,
      epStart: epBase,
      epEnd: epBase,
    };
  }

  const spMatch = cleaned.match(
    /(?:^|[\s._\-\[(（【])(?:SP|OVA|OAD|Special|特别篇|特別篇|番外篇?|总集篇|總集篇)\s*(?:第\s*)?(\d{1,3})(?:\s*[集话話期卷])?(?:$|[\s._\-\])）】:])/i
  );
  if (spMatch) {
    const ep = Number(spMatch[1]);
    return { kind: 'special', season: 0, epStart: ep, epEnd: ep };
  }

  const cnEpMatch = cleaned.match(/第\s*(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?\s*[集话話期]/i);
  if (cnEpMatch) {
    const epStart = Number(cnEpMatch[1]);
    const epEnd = cnEpMatch[2] ? Math.max(epStart, Number(cnEpMatch[2])) : epStart;
    return { kind: 'global_episode', epStart, epEnd };
  }

  const epPrefixMatch = cleaned.match(
    /(?:^|[\s._\-\[])EP?\.?\s*(\d{1,4})(?:\s*[-~]\s*EP?\.?\s*(\d{1,4}))?(?:v\d)?(?:$|[\s._\-\]])/i
  );
  if (epPrefixMatch) {
    const epStart = Number(epPrefixMatch[1]);
    const epEnd = epPrefixMatch[2] ? Math.max(epStart, Number(epPrefixMatch[2])) : epStart;
    return { kind: 'global_episode', epStart, epEnd };
  }

  const bracketMatches = [
    ...cleaned.matchAll(/\[\s*(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?(?:v\d)?\s*\]/gi),
  ];
  if (bracketMatches.length > 0) {
    const m = bracketMatches[bracketMatches.length - 1];
    const epStart = Number(m[1]);
    const epEnd = m[2] ? Math.max(epStart, Number(m[2])) : epStart;
    return { kind: 'global_episode', epStart, epEnd };
  }

  const dashMatch = cleaned.match(/-\s*(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?(?:v\d)?(?:\s|$|\.|\[|\()/);
  if (dashMatch) {
    const epStart = Number(dashMatch[1]);
    const epEnd = dashMatch[2] ? Math.max(epStart, Number(dashMatch[2])) : epStart;
    return { kind: 'global_episode', epStart, epEnd };
  }

  // 识别不含数字序号的纯描述型特别篇（如 "Show - OVA 温泉混浴篇.mkv"、"Show SP 总集篇.mkv"）
  const unnumberedSpMatch = cleaned.match(
    /(?:^|[\s._\-\[(（【])(?:SP|OVA|OAD|Special|特别篇|特別篇|番外篇|总集篇|總集篇|剧场版特典)(?:$|[\s._\-\])）】:])/i
  );
  if (unnumberedSpMatch) {
    return { kind: 'special', season: 0, epStart: 1, epEnd: 1, descriptiveOnly: true };
  }

  const standaloneMatches = [
    ...cleaned.matchAll(/(?:^|[\s._\-])(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?(?:$|[\s._\-])/g),
  ].filter((m) => {
    const n = Number(m[1]);
    return n >= 1 && (n < 1900 || n > 2099);
  });
  if (standaloneMatches.length > 0) {
    const m = standaloneMatches[standaloneMatches.length - 1];
    const epStart = Number(m[1]);
    const epEnd = m[2] ? Math.max(epStart, Number(m[2])) : epStart;
    return { kind: 'global_episode', epStart, epEnd };
  }

  return null;
}

export function foldGlobalEpisodeToSeason(globalEp, regularSeasons) {
  for (const s of regularSeasons) {
    if (globalEp >= s.globalStart && globalEp <= s.globalEnd) {
      return {
        seasonNumber: s.seasonNumber,
        episodeInSeason: globalEp - s.globalStart + 1,
        seasonEpisodeCount: s.episodeCount,
        seasonTitle: s.seasonTitle,
        year: s.year,
      };
    }
  }
  return null;
}

export function inferGlobalEpisodeOffset(parsedVideos, tmdbMeta, explicitOffset = null) {
  if (explicitOffset !== null && explicitOffset !== undefined) {
    return { offset: Number(explicitOffset), autoInferred: false };
  }

  const globalEps = [];
  for (const v of parsedVideos) {
    if (v.token?.kind === 'global_episode') {
      globalEps.push(v.token.epStart, v.token.epEnd);
    }
  }
  if (globalEps.length === 0) {
    return { offset: 0, autoInferred: false };
  }

  const minEp = Math.min(...globalEps);
  const maxEp = Math.max(...globalEps);
  const total = tmdbMeta.totalRegularEpisodes;

  if (minEp > 1 && maxEp > total) {
    const candidateOffset = -(minEp - 1);
    if (maxEp + candidateOffset <= total) {
      return {
        offset: candidateOffset,
        autoInferred: true,
        reason: `检测到连续集号区间 ${minEp}~${maxEp} 超出 TMDB 总集数 ${total}，平移 ${candidateOffset} 后恰好落入 1~${total}`,
      };
    }
  }

  return { offset: 0, autoInferred: false };
}

export function normalizeSubtitleLangTag(rawTag = '') {
  if (!rawTag) return '';
  const t = String(rawTag).trim();
  const lower = t.toLowerCase();
  if (lower === 'big5' || lower === '繁体' || lower === '繁体中文' || lower === '繁中' || lower === 'cht') {
    return 'tc';
  }
  if (lower === 'gb' || lower === '简体' || lower === '简体中文' || lower === '简中' || lower === 'chs') {
    return 'sc';
  }
  return t;
}

export function extractSubtitleLangSuffix(subFilename, pairedVideoFilename = null) {
  const subStem = stripExtension(subFilename);

  if (pairedVideoFilename) {
    const videoStem = stripExtension(pairedVideoFilename);
    if (subStem.length > videoStem.length && subStem.toLowerCase().startsWith(videoStem.toLowerCase())) {
      const rawTail = subStem.slice(videoStem.length).trim();
      const cleanedTail = rawTail
        .replace(/^[._\-\s\[（(【]+/, '')
        .replace(/[)\]）】\s]+$/, '')
        .replace(/[\/\\:*?"<>|]/g, '_');
      if (cleanedTail) {
        return `.${normalizeSubtitleLangTag(cleanedTail)}`;
      }
    }
  }

  const directLangMatch = subStem.match(KNOWN_SUB_LANG_REGEX);
  if (directLangMatch) {
    return `.${normalizeSubtitleLangTag(directLangMatch[1])}`;
  }

  const denoisedStem = stripTechnicalNoiseKeepLang(subStem);
  const denoisedLangMatch = denoisedStem.match(KNOWN_SUB_LANG_REGEX);
  if (denoisedLangMatch) {
    return `.${normalizeSubtitleLangTag(denoisedLangMatch[1])}`;
  }

  return '';
}

/**
 * 自适应分配字幕最终文件名：
 * - 同一视频仅匹配到 1 个逻辑字幕（同源 .idx+.sub 视为 1 个逻辑字幕）时：直接采用“视频名.ext”严格同名；
 * - 同一视频匹配到多个字幕时：全部保留语言标识“视频名.lang.ext”（若语言后缀仍重复则自动追加 .2 防覆盖）。
 */
function finalizeAdaptiveSubtitleNames(draftSubs) {
  const byVideoGroup = new Map();
  for (const d of draftSubs) {
    if (!byVideoGroup.has(d.videoGroupKey)) {
      byVideoGroup.set(d.videoGroupKey, []);
    }
    byVideoGroup.get(d.videoGroupKey).push(d);
  }

  const destCollisionCounter = new Map();
  const finalized = [];

  for (const [, group] of byVideoGroup) {
    const logicalUnits = new Set();
    for (const d of group) {
      const stemLower = stripExtension(d.sub.name).toLowerCase();
      if (d.sub.ext === 'idx' || d.sub.ext === 'sub') {
        logicalUnits.add(`vobsub:${stemLower}`);
      } else {
        logicalUnits.add(`sub:${d.sub.id}`);
      }
    }
    const isMultiSubtitle = logicalUnits.size > 1;

    for (const d of group) {
      const langSuffix = isMultiSubtitle
        ? extractSubtitleLangSuffix(d.sub.name, d.pairedVideoOldName)
        : '';

      let candidateName = `${d.baseName}${langSuffix}.${d.sub.ext}`;
      const collisionKey = `${d.destScopeKey}/${candidateName}`.toLowerCase();
      const seenCount = destCollisionCounter.get(collisionKey) ?? 0;
      destCollisionCounter.set(collisionKey, seenCount + 1);
      if (seenCount > 0) {
        candidateName = `${d.baseName}${langSuffix}.${seenCount + 1}.${d.sub.ext}`;
      }

      finalized.push({
        ...d,
        langSuffix,
        isMultiSubtitle,
        newName: candidateName,
      });
    }
  }

  return finalized;
}

/**
 * 格式化季度目录名：
 * - 默认模板 "Season {Season}"（第 0 季默认固定为 "Specials"）；
 * - 当采用 "{TmdbSeason}" 或 "{SeasonTitle}" 模板（例如按 TMDB 季度信息重新分类时），第 0 季采用 TMDB 特别篇名称（如 "特别篇"），正片采用 canonicalFolderName（如 "无头骑士异闻录"、"无头骑士异闻录×2"）。
 */
export function formatSeasonFolderName({
  seasonNumber,
  seasonTitle = '',
  canonicalFolderName = '',
  showTitle = '',
  seasonPattern = 'Season {Season}',
}) {
  const pat = String(seasonPattern || 'Season {Season}');
  const tmdbLabel =
    sanitizeFilenamePart(canonicalFolderName) ||
    sanitizeFilenamePart(seasonTitle) ||
    (seasonNumber === 0 ? '特别篇' : `Season ${String(seasonNumber).padStart(2, '0')}`);

  if (seasonNumber === 0) {
    if (pat.includes('{TmdbSeason}') || pat.includes('{SeasonTitle}')) {
      const renderedZero = pat
        .replaceAll('{TmdbSeason}', tmdbLabel)
        .replaceAll('{SeasonTitle}', sanitizeFilenamePart(seasonTitle) || tmdbLabel)
        .replaceAll('{Season}', '00')
        .replaceAll('{SeasonNum}', '0')
        .replaceAll('{Title}', sanitizeFilenamePart(showTitle))
        .replaceAll('{ShowTitle}', sanitizeFilenamePart(showTitle));
      return sanitizeFilenamePart(renderedZero) || '特别篇';
    }
    return 'Specials';
  }

  const sPad = String(seasonNumber).padStart(2, '0');
  const rendered = pat
    .replaceAll('{TmdbSeason}', tmdbLabel)
    .replaceAll('{Season}', sPad)
    .replaceAll('{SeasonNum}', String(seasonNumber))
    .replaceAll('{SeasonTitle}', sanitizeFilenamePart(seasonTitle) || tmdbLabel)
    .replaceAll('{Title}', sanitizeFilenamePart(showTitle))
    .replaceAll('{ShowTitle}', sanitizeFilenamePart(showTitle));
  return sanitizeFilenamePart(rendered) || `Season ${sPad}`;
}

export function toTitleCaseDots(str = '') {
  return String(normalizeTitleSpacing(str) || '')
    .replace(/[×✕✖]/g, ' x ')
    .replace(/[_.\-+&]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (w.toLowerCase() === 'x') return 'x';
      if (w.length <= 3 && /^[A-Z0-9]+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('.');
}

const TECH_TAG_START_REGEX = /\b(?:2160p|1080p|1080i|720p|576p|480p|4K|UHD|BDRip|BluRay|Blu-ray|WEB-DL|WEBRip|HDTV|DVDRip|Apple\.TV\+|NF|AMZN|DSNP|H\.265|H\.264|x265|x264|HEVC|AVC|AV1|DDP|Atmos|AAC|FLAC|TrueHD|DTS|DV|HDR|HDR10\+?|10bit|8bit|Ma10p|Hi10p)\b/i;

function cleanDots(s = '') {
  return String(s || '')
    .replace(/[\[\]()【】]/g, ' ')
    .replace(/\s+/g, '.')
    .replace(/-+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * 从原始文件名提取发布组、画质压制参数、音轨/字幕轨等技术 payload，剔除重复剧名、集号与单集标题
 */
export function extractReleasePayload(origStem, { showTitles = [] } = {}) {
  let s = String(origStem || '')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/\(([^)]*(?:BDrip|1080|720|2160|HEVC|x265|x264|FLAC|AAC|WEB-DL|BluRay)[^)]*)\)/gi, '[$1]');

  // 1. 如果包含多个中括号（动漫/压制组常见格式）
  const bracketMatches = [...s.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
  if (bracketMatches.length >= 2) {
    const isEpisode = (b) =>
      /^(?:S\d{1,2})?E?\d{1,4}(?:\.\d)?(?:-E?\d{1,4})?$/i.test(b) ||
      /^\d{1,3}$/.test(b) ||
      /^(?:OVA|SP|OAD)\s*\d*$/i.test(b);
    const isYear = (b) => /^(?:19|20)\d{2}$/.test(b);
    const isTitle = (b) => {
      const normB = b.toLowerCase().replace(/[._\-\s]/g, '');
      return showTitles.some((t) => {
        const normT = String(t || '').toLowerCase().replace(/[._\-\s]/g, '');
        return normT && (normB === normT || normB.includes(normT) || normT.includes(normB));
      });
    };

    const releaseBrackets = bracketMatches.filter((b) => !isEpisode(b) && !isYear(b) && !isTitle(b));
    if (releaseBrackets.length > 0) {
      return releaseBrackets
        .map((b) => b.trim().replace(/[\/\\／]/g, '.').replace(/\s+/g, '.'))
        .join('.');
    }
  }

  // 2. 如果是剧集 Scene 命名格式（如 Slow.Horses.S06E01.Circle.of.Life.2160p...-BlackTV）
  const sxeMatch = s.match(/(?:^|[._\-\s])S(\d{1,2})\.?E(\d{1,4})(?:-(?:E\d{1,4}|(?!\b(?:19|20)\d{2}\b)\d{1,3}))?(?:$|[._\-\s])/i);
  if (sxeMatch) {
    const afterSxe = s.slice(sxeMatch.index + sxeMatch[0].length);
    const techMatch = afterSxe.match(TECH_TAG_START_REGEX);
    if (techMatch) {
      const techPart = afterSxe.slice(techMatch.index);
      const withDotGroup = techPart.replace(/-([A-Za-z0-9_]+)$/, '.$1');
      return withDotGroup
        .replace(/\s+/g, '.')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+|\.+$/g, '');
    }
  }

  // 3. 如果是电影/单文件 Scene 命名格式（不含 SxxExx，直接从分辨率/编码/压制组等技术标签起始）
  const directTechMatch = s.match(TECH_TAG_START_REGEX);
  if (directTechMatch) {
    const techPart = s.slice(directTechMatch.index);
    const withDotGroup = techPart.replace(/-([A-Za-z0-9_]+)$/, '.$1');
    return withDotGroup
      .replace(/[()[\]{}]+$/g, '')
      .replace(/\s+/g, '.')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '');
  }

  // 4. 通用兜底：剥离剧名与集号
  for (const t of showTitles) {
    if (t && t.length >= 2) {
      s = s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    }
  }
  s = s.replace(/(?:^|[._\-\s])S\d{1,2}\.?E\d{1,4}(?:-E?\d{1,4})?(?:$|[._\-\s])/gi, ' ');
  s = s.replace(/(?:^|[._\-\s])(?:EP|E)?\d{1,4}(?:$|[._\-\s])/gi, ' ');
  return cleanDots(s);
}

/**
 * 计算全剧唯一的规范剧名前缀（同一部剧所有分集开头的剧名 100% 保持完全一致）
 * - 外语/动漫剧集：优先采用“中文名.英文/罗马音原名”（如 死亡笔记.Death.Note、流人.Slow.Horses）
 * - 纯国产中文剧集：采用“中文剧名”（如 庆余年），不重复拼接
 */
export function buildCanonicalSeriesTitle(tmdbMeta, sampleFiles = []) {
  const showTitle = normalizeTitleSpacing(String(tmdbMeta?.showTitle || '').trim());
  const origTitle = normalizeTitleSpacing(String(tmdbMeta?.originalTitle || '').trim());
  const userQuery = normalizeTitleSpacing(String(tmdbMeta?.userQuery || '').trim());

  const hasChinese = (s) => /[\u4e00-\u9fa5]/.test(s);
  const isLatin = (s) => /[a-zA-Z]{2,}/.test(s) && !hasChinese(s);

  let chinesePart = '';
  if (hasChinese(showTitle)) {
    chinesePart = showTitle.replace(/[\\/:*?"<>|]/g, ' ').trim();
  } else if (hasChinese(userQuery)) {
    chinesePart = userQuery.replace(/[\\/:*?"<>|]/g, ' ').trim();
  } else if (hasChinese(origTitle)) {
    chinesePart = origTitle.replace(/[\\/:*?"<>|]/g, ' ').trim();
  } else {
    for (const f of sampleFiles) {
      const match = f.name?.match(/[\u4e00-\u9fa5]{2,}/);
      if (match) {
        chinesePart = match[0];
        break;
      }
    }
  }

  if (chinesePart) {
    chinesePart = normalizeTitleSpacing(chinesePart);
  }

  let englishPart = '';
  if (isLatin(origTitle)) {
    englishPart = toTitleCaseDots(origTitle);
  } else if (isLatin(showTitle)) {
    englishPart = toTitleCaseDots(showTitle);
  }

  if (chinesePart && englishPart && chinesePart.toLowerCase() !== englishPart.toLowerCase()) {
    return `${chinesePart}.${englishPart}`;
  }
  if (chinesePart) return chinesePart;
  if (englishPart) return englishPart;
  return showTitle || 'Show';
}

/**
 * 计算全片唯一的规范电影名前缀：
 * - 外语/动漫电影：优先采用“中文名.英文/罗马音原名”（如 奥本海默.Oppenheimer、千与千寻.Spirited.Away）
 * - 纯国产中文电影：采用“中文片名”（如 流浪地球2），若资源文件名含英文亦可智能补充，不重复拼接
 */
export function buildCanonicalMovieTitle(tmdbMeta, sampleFiles = []) {
  return buildCanonicalSeriesTitle(
    {
      showTitle: tmdbMeta?.title || tmdbMeta?.showTitle || '',
      originalTitle: tmdbMeta?.originalTitle || '',
      userQuery: tmdbMeta?.userQuery || '',
    },
    sampleFiles
  );
}

/**
 * 按模板格式化媒体文件名主体（不含扩展名）
 * 默认采用标准规范：剧名.年份.SxxExx.原剧集压制信息
 */
export function formatMediaBaseName({
  seasonNumber,
  epStart,
  epEnd,
  seasonEpisodeCount = 99,
  showTitle = '',
  canonicalSeriesTitle = '',
  seasonTitle = '',
  canonicalFolderName = '',
  year = null,
  origStem = '',
  filePattern = '{Standard}',
  filePatternExplicit = false,
  withTitle = false,
  releaseInfo = '',
}) {
  const sPad = String(seasonNumber).padStart(2, '0');
  const padWidth = Math.max(2, seasonEpisodeCount >= 100 || epEnd >= 100 ? 3 : 2);
  const eStartStr = String(epStart).padStart(padWidth, '0');
  const epStr =
    epEnd && epEnd > epStart
      ? `${eStartStr}-${String(epEnd).padStart(padWidth, '0')}`
      : eStartStr;
  const sxxExx =
    epEnd && epEnd > epStart
      ? `S${sPad}E${eStartStr}-E${String(epEnd).padStart(padWidth, '0')}`
      : `S${sPad}E${eStartStr}`;

  const effectiveSeriesTitle = canonicalSeriesTitle || sanitizeFilenamePart(showTitle);

  let rendered;
  if (!filePatternExplicit && (!filePattern || filePattern === '{Standard}' || filePattern === '{SxxExx}')) {
    // 默认执行标准正片命名规范：剧名.年份.SxxExx.原剧集的压制信息
    const parts = [
      effectiveSeriesTitle,
      year ? String(year) : null,
      sxxExx,
      releaseInfo || null,
    ].filter(Boolean);
    rendered = parts.join('.');
  } else {
    // 用户显式指定的自定义 pattern
    const effectivePattern =
      withTitle && (!filePattern || filePattern === '{SxxExx}')
        ? '{Title} - {SxxExx}'
        : filePattern || '{Standard}';

    const tmdbLabel =
      sanitizeFilenamePart(canonicalFolderName) || sanitizeFilenamePart(seasonTitle);

    rendered = effectivePattern
      .replaceAll('{SeriesTitle}', effectiveSeriesTitle)
      .replaceAll('{SxxExx}', sxxExx)
      .replaceAll('{Title}', sanitizeFilenamePart(showTitle))
      .replaceAll('{ShowTitle}', sanitizeFilenamePart(showTitle))
      .replaceAll('{Season}', sPad)
      .replaceAll('{SeasonNum}', String(seasonNumber))
      .replaceAll('{Episode}', epStr)
      .replaceAll('{Year}', year ? String(year) : '')
      .replaceAll('{TmdbSeason}', tmdbLabel)
      .replaceAll('{SeasonTitle}', sanitizeFilenamePart(seasonTitle) || tmdbLabel)
      .replaceAll('{ReleaseInfo}', releaseInfo || '')
      .replaceAll('{OrigName}', sanitizeFilenamePart(origStem));
  }

  const cleaned = sanitizeFilenamePart(rendered)
    .replace(/\.{2,}/g, '.')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/^[\s.\-]+|[\s.\-]+$/g, '');

  return cleaned || sxxExx;
}

/**
 * 按模板格式化电影文件名主体（不含扩展名）
 * 默认采用标准规范：电影名.年份.原视频压制信息（如 流浪地球2.The.Wandering.Earth.II.2023.2160p.WEB-DL...）
 */
export function formatMovieMediaBaseName({
  canonicalMovieTitle,
  year = null,
  releaseInfo = '',
  partTag = '',
  origStem = '',
  filePattern = '{Standard}',
  filePatternExplicit = false,
}) {
  const effectiveTitle = sanitizeFilenamePart(canonicalMovieTitle);

  let rendered;
  if (!filePatternExplicit || !filePattern || filePattern === '{Standard}') {
    const parts = [
      effectiveTitle,
      year ? String(year) : null,
      partTag || null,
      releaseInfo || null,
    ].filter(Boolean);
    rendered = parts.join('.');
  } else {
    rendered = filePattern
      .replaceAll('{MovieTitle}', effectiveTitle)
      .replaceAll('{Title}', effectiveTitle)
      .replaceAll('{Year}', year ? String(year) : '')
      .replaceAll('{Part}', partTag || '')
      .replaceAll('{ReleaseInfo}', releaseInfo || '')
      .replaceAll('{OrigName}', sanitizeFilenamePart(origStem));
  }

  const cleaned = sanitizeFilenamePart(rendered)
    .replace(/\.{2,}/g, '.')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/^[\s.\-]+|[\s.\-]+$/g, '');

  return cleaned || effectiveTitle || 'Movie';
}

/**
 * 格式化影视资源根目录名称（适用于剧集与电影）：
 * 规范：
 * 1. 优先使用 TMDB 官方标题；若 TMDB 中无对应中文名称（纯英文/拉丁名，如 Slow Horses），则使用英文名；
 * 2. 必须附带上映/首播年份；
 * 3. 默认格式采用全角中文括号：剧名/电影名（年份），如 "Slow Horses（2022）"、"死亡笔记（2006）"、"流浪地球2（2023）"。
 */
export function formatResourceFolderName({
  title = '',
  showTitle = '',
  movieTitle = '',
  originalTitle = '',
  year = null,
  folderPattern = '{Title}（{Year}）',
} = {}) {
  const rawTitle = String(showTitle || movieTitle || title || originalTitle || '').trim();

  // 1. 判断是否含有中文，若无中文且有英文/原名，则以英文/原名为准
  let effectiveTitle = rawTitle;
  const hasChinese = /[\u4e00-\u9fa5]/.test(rawTitle);
  if (!hasChinese && originalTitle) {
    effectiveTitle = rawTitle || originalTitle;
  }

  // 2. 剥离可能已存在的年份后缀，例如 "流人（2022）" 或 " (2022)"
  effectiveTitle = effectiveTitle.replace(/[\s._-]*[（(](?:19|20)\d{2}[）)]$/, '').trim();
  const cleanTitle = sanitizeFilenamePart(effectiveTitle);

  if (!year) return cleanTitle;

  const pat = String(folderPattern || '{Title}（{Year}）');
  const rendered = pat
    .replaceAll('{Title}', cleanTitle)
    .replaceAll('{MovieTitle}', cleanTitle)
    .replaceAll('{SeriesTitle}', cleanTitle)
    .replaceAll('{Year}', String(year));

  return sanitizeFilenamePart(rendered) || cleanTitle;
}

/**
 * 格式化电影所在目录名，默认采用标准格式：电影名（年份）
 */
export function formatMovieFolderName({
  movieTitle = '',
  year = null,
  folderPattern = '{MovieTitle}（{Year}）',
} = {}) {
  return formatResourceFolderName({
    movieTitle,
    year,
    folderPattern,
  });
}

const CN_NUM_MAP = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseChineseSeasonNum(cnStr = '') {
  const s = cnStr.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.startsWith('十') && s.length === 2 && CN_NUM_MAP[s[1]] !== undefined) {
    return 10 + CN_NUM_MAP[s[1]];
  }
  if (s.endsWith('十') && s.length === 2 && CN_NUM_MAP[s[0]] !== undefined) {
    return CN_NUM_MAP[s[0]] * 10;
  }
  if (s.length === 3 && s[1] === '十' && CN_NUM_MAP[s[0]] && CN_NUM_MAP[s[2]] !== undefined) {
    return CN_NUM_MAP[s[0]] * 10 + CN_NUM_MAP[s[2]];
  }
  if (s.length === 1 && CN_NUM_MAP[s] !== undefined) {
    return CN_NUM_MAP[s];
  }
  return null;
}

/**
 * 从任意深度的多层文件夹路径（如 "外挂字幕/第二季 简繁/简体中文/ASS"）自内向外提取季号
 */
export function inferSeasonFromDirPath(relativeDir = '', parentFolderName = '') {
  const segments = [
    ...String(relativeDir || '')
      .split(/[\/\\]+/)
      .filter(Boolean)
      .reverse(),
    String(parentFolderName || '').trim(),
  ].filter(Boolean);

  for (const seg of segments) {
    if (/(?:^|[\s._\-\[(【（])(?:Specials|SPs?|OVA|OAD|特别篇|番外篇?)(?=$|[^0-9A-Za-z])/i.test(seg)) {
      return 0;
    }
    const enMatch =
      seg.match(/(?:^|[\s._\-\[(【（])Season\s*(\d{1,2})(?=$|[^0-9A-Za-z])/i) ||
      seg.match(/(?:^|[\s._\-\[(【（])S(\d{1,2})(?=E\d{1,4}\b|$|[^0-9A-Za-z])/i);
    if (enMatch) {
      return Number(enMatch[1]);
    }
    const cnMatch = seg.match(/第\s*([0-9一二两三四五六七八九十]{1,3})\s*季/i);
    if (cnMatch) {
      const parsed = parseChineseSeasonNum(cnMatch[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

/**
 * 沿任意深度的多层嵌套子文件夹向上逐层回溯（如 "盗梦空间/外挂字幕/特效/简英/ASS" -> ... -> "盗梦空间"），
 * 查找最近的含正片视频的祖先目录，支持深层嵌套的电影合集字幕自动提取归位
 */
function findNearestAncestorSingleVideo(subRelDir = '', indexedVideos = []) {
  const parts = String(subRelDir || '')
    .split(/[\/\\]+/)
    .filter(Boolean);

  for (let len = parts.length; len >= 0; len -= 1) {
    const ancestorRel = parts.slice(0, len).join('/');
    const vidsHere = indexedVideos.filter((v) => (v.relativeDir || '') === ancestorRel);
    if (vidsHere.length > 0) {
      if (vidsHere.length === 1 && !vidsHere[0].token) {
        return vidsHere[0];
      }
      return null;
    }
  }
  return null;
}

/**
 * 独立字幕对齐计划构建器（纯函数，无需查 TMDB，绝对不改动现有视频文件名与位置）：
 * 支持：
 * 1. 多层嵌套文件夹穿透提取与同目录归位；
 * 2. 视频主文件名精确前缀配对；
 * 3. 单部电影目录 / 电影合集深层子目录自动 1:1 配对；
 * 4. 标准剧集 (季+集) 匹配及多层目录季号推断（兼容 Season 01 / S01 / 第1季 / 第二季）；
 * 5. 跨季延续集号与季内重置集号双向折算（如视频 S02E53 对齐字幕 S02E01，或视频 S02E01 对齐全局字幕 [033]）。
 */
export function buildSubtitleMatchPlan({ files, maxArchiveSizeMB = 300 }) {
  const videoFiles = [];
  const subtitleFiles = [];
  const detectedArchives = [];
  const skippedBonus = [];
  const ignoredOther = [];

  for (const file of files) {
    const ext = getExtension(file.name);
    if (VIDEO_EXTENSIONS.has(ext)) {
      if (isBonusClip(file.name)) {
        skippedBonus.push({ ...file, reason: '特典/OP/ED/PV 视频保护跳过' });
      } else {
        videoFiles.push({ ...file, ext });
      }
    } else if (SUBTITLE_EXTENSIONS.has(ext)) {
      if (isBonusClip(file.name)) {
        skippedBonus.push({ ...file, reason: '特典/OP/ED/PV 字幕保护跳过' });
      } else {
        subtitleFiles.push({ ...file, ext });
      }
    } else if (isSubtitleArchiveCandidate(file, { maxArchiveSizeMB })) {
      detectedArchives.push({ ...file, ext });
    } else {
      ignoredOther.push(file);
    }
  }

  const indexedVideos = videoFiles.map((v) => {
    const token = parseEpisodeToken(v.name);
    const dirSeason = inferSeasonFromDirPath(v.relativeDir, v.parentFolderName);
    let effectiveSeason = null;
    if (token?.kind === 'special') effectiveSeason = 0;
    else if (token?.kind === 'season_episode') effectiveSeason = token.season;
    else if (dirSeason !== null) effectiveSeason = dirSeason;

    return {
      ...v,
      baseName: stripExtension(v.name),
      stemLower: stripExtension(v.name).toLowerCase(),
      token,
      effectiveSeason,
      relativeDir: v.relativeDir || '',
    };
  });

  const videosByStemDesc = [...indexedVideos].sort(
    (a, b) => b.stemLower.length - a.stemLower.length
  );

  // 构建按季分组与跨季累加区间索引（用于连续集号 <-> 分季集号双向折算）
  const videosBySeason = new Map();
  const videosByEpStart = new Map();
  for (const v of indexedVideos) {
    if (v.effectiveSeason !== null) {
      if (!videosBySeason.has(v.effectiveSeason)) videosBySeason.set(v.effectiveSeason, []);
      videosBySeason.get(v.effectiveSeason).push(v);
    }
    if (v.token) {
      const k = `${v.token.epStart}-${v.token.epEnd}`;
      if (!videosByEpStart.has(k)) videosByEpStart.set(k, []);
      videosByEpStart.get(k).push(v);

      const singleK = `ep:${v.token.epStart}`;
      if (!videosByEpStart.has(singleK)) videosByEpStart.set(singleK, []);
      videosByEpStart.get(singleK).push(v);
    }
  }

  for (const [, list] of videosBySeason) {
    list.sort((a, b) => (a.token?.epStart ?? 0) - (b.token?.epStart ?? 0));
  }

  // 构建本地剧集累加窗口（当视频是按季重置 S01E01..S02E01，而字幕是总集号 001..500 时自动折算）
  const regularSeasonNums = [...videosBySeason.keys()]
    .filter((s) => s >= 1)
    .sort((a, b) => a - b);
  const localCumulativeWindows = [];
  let runningCount = 0;
  for (const sNum of regularSeasonNums) {
    const sVids = videosBySeason.get(sNum).filter((v) => v.token);
    if (sVids.length === 0) continue;
    const minEp = sVids[0].token.epStart;
    if (minEp === 1) {
      const maxEp = sVids[sVids.length - 1].token.epEnd;
      const startGlobal = runningCount + 1;
      const endGlobal = runningCount + maxEp;
      localCumulativeWindows.push({
        seasonNumber: sNum,
        startGlobal,
        endGlobal,
        videos: sVids,
      });
      runningCount = endGlobal;
    }
  }

  const draftSubs = [];
  const unmatchedSubtitles = [];

  for (const sub of subtitleFiles) {
    const subStemLower = stripExtension(sub.name).toLowerCase();
    const subToken = parseEpisodeToken(sub.name);
    const subDirSeason = inferSeasonFromDirPath(sub.relativeDir, sub.parentFolderName);
    let subEffectiveSeason = null;
    if (subToken?.kind === 'special') subEffectiveSeason = 0;
    else if (subToken?.kind === 'season_episode') subEffectiveSeason = subToken.season;
    else if (subDirSeason !== null) subEffectiveSeason = subDirSeason;

    let pairedVideo = null;
    let matchReason = '';

    // Tier 1: 视频主文件名精确前缀匹配（同目录优先；跨目录时须校验季号兼容且唯一，防止跨季 01.mkv 串季）
    const stemCandidates = videosByStemDesc.filter((v) => {
      if (!subStemLower.startsWith(v.stemLower)) return false;
      if (subStemLower.length === v.stemLower.length) return true;
      return /[._\-\s\[（(【]/.test(subStemLower[v.stemLower.length]);
    });
    if (stemCandidates.length > 0) {
      const sameDirMatch = stemCandidates.find(
        (v) =>
          String(v.parentId) === String(sub.parentId) &&
          (subEffectiveSeason === null ||
            v.effectiveSeason === null ||
            v.effectiveSeason === subEffectiveSeason)
      );
      if (sameDirMatch) {
        pairedVideo = sameDirMatch;
        matchReason = '同目录原文件名前缀匹配';
      } else {
        const seasonCompatible =
          subEffectiveSeason !== null
            ? stemCandidates.filter((v) => v.effectiveSeason === subEffectiveSeason)
            : stemCandidates;
        if (seasonCompatible.length === 1) {
          pairedVideo = seasonCompatible[0];
          matchReason = '原文件名前缀匹配';
        }
      }
    }

    // Tier 2: 电影模式 1:1 匹配（支持多层嵌套外挂字幕文件夹逐级向上回溯定位唯一电影）
    if (!pairedVideo) {
      if (indexedVideos.length === 1 && (!indexedVideos[0].token || !subToken)) {
        pairedVideo = indexedVideos[0];
        matchReason = '单视频电影目录 1:1 匹配';
      } else if (!subToken) {
        const ancestorMovie = findNearestAncestorSingleVideo(sub.relativeDir, indexedVideos);
        if (ancestorMovie) {
          pairedVideo = ancestorMovie;
          matchReason = '多层子目录向上回溯电影 1:1 匹配';
        }
      }
    }

    // Tier 3: 剧集 (季+集) 精确匹配或全目录唯一集号匹配
    if (!pairedVideo && subToken) {
      if (subEffectiveSeason !== null && videosBySeason.has(subEffectiveSeason)) {
        const sList = videosBySeason.get(subEffectiveSeason);
        pairedVideo =
          sList.find(
            (v) => v.token?.epStart === subToken.epStart && v.token?.epEnd === subToken.epEnd
          ) ||
          sList.find((v) => v.token?.epStart === subToken.epStart) ||
          null;
        if (pairedVideo) {
          matchReason = `第 ${subEffectiveSeason} 季集号精确匹配`;
        }
      }

      if (!pairedVideo) {
        const exactRangeHits = videosByEpStart.get(`${subToken.epStart}-${subToken.epEnd}`) || [];
        const singleEpHits = videosByEpStart.get(`ep:${subToken.epStart}`) || [];
        const sameDirHit =
          exactRangeHits.find((v) => String(v.parentId) === String(sub.parentId)) ||
          singleEpHits.find((v) => String(v.parentId) === String(sub.parentId));
        if (sameDirHit && (subEffectiveSeason === null || sameDirHit.effectiveSeason === subEffectiveSeason)) {
          pairedVideo = sameDirHit;
          matchReason = '同目录集号匹配';
        } else if (subEffectiveSeason === null && exactRangeHits.length === 1) {
          pairedVideo = exactRangeHits[0];
          matchReason = '全局唯一集号匹配';
        } else if (subEffectiveSeason === null && singleEpHits.length === 1) {
          pairedVideo = singleEpHits[0];
          matchReason = '全局唯一集号匹配';
        } else if (subEffectiveSeason === null && subToken.kind !== 'special') {
          // 当字幕为正片集号（非特典），但全局命中同时包含正片 (Season >= 1) 与特典 (Season 0/SP) 时，
          // 优先排除特典，确保正片集号 1:1 精确匹配
          const regularRangeHits = exactRangeHits.filter(
            (v) => v.effectiveSeason === null || v.effectiveSeason > 0
          );
          const regularSingleHits = singleEpHits.filter(
            (v) => v.effectiveSeason === null || v.effectiveSeason > 0
          );
          if (regularRangeHits.length === 1) {
            pairedVideo = regularRangeHits[0];
            matchReason = '正片集号匹配 (自动排除特典/SP)';
          } else if (regularSingleHits.length === 1) {
            pairedVideo = regularSingleHits[0];
            matchReason = '正片集号匹配 (自动排除特典/SP)';
          }
        }
      }
    }

    // Tier 4: 跨季延续集号 <-> 季内重置集号双向智能折算
    if (!pairedVideo && subToken) {
      // 4a: 视频采用跨季延续集号 (如 S02E53..104)，而字幕采用季内集号 (如 S02E01..52)
      if (subEffectiveSeason !== null && subEffectiveSeason >= 1 && videosBySeason.has(subEffectiveSeason)) {
        const sList = videosBySeason.get(subEffectiveSeason).filter((v) => v.token);
        if (sList.length > 0 && sList[0].token.epStart > 1) {
          const baseOffset = sList[0].token.epStart - 1;
          const targetGlobalEp = baseOffset + subToken.epStart;
          const hit = sList.find((v) => v.token.epStart === targetGlobalEp);
          if (hit) {
            pairedVideo = hit;
            matchReason = `跨季延续集号自动对齐 (S${String(subEffectiveSeason).padStart(2, '0')} 第${subToken.epStart}集 -> E${targetGlobalEp})`;
          }
        }
      }

      // 4b: 视频采用按季重置集号 (S01E01..32, S02E01..21)，而字幕采用总集号 (001..500)
      if (!pairedVideo && subEffectiveSeason === null && localCumulativeWindows.length > 1) {
        const win = localCumulativeWindows.find(
          (w) => subToken.epStart >= w.startGlobal && subToken.epStart <= w.endGlobal
        );
        if (win) {
          const epInSeason = subToken.epStart - win.startGlobal + 1;
          const hit = win.videos.find((v) => v.token?.epStart === epInSeason);
          if (hit) {
            pairedVideo = hit;
            matchReason = `总集号自动折算分季 (#${subToken.epStart} -> S${String(win.seasonNumber).padStart(2, '0')}E${String(epInSeason).padStart(2, '0')})`;
          }
        }
      }
    }

    if (!pairedVideo) {
      unmatchedSubtitles.push({
        id: sub.id,
        parentId: sub.parentId,
        name: sub.name,
        relativeDir: sub.relativeDir || '',
        reason:
          indexedVideos.length === 0
            ? '目标目录内未扫描到任何视频文件'
            : subToken
              ? `未找到与集号 (${subToken.season !== undefined ? `S${subToken.season}` : ''}E${subToken.epStart}) 对应的视频文件`
              : '未能从字幕文件名识别出集数，且当前目录含多个视频无法唯一配对',
      });
      continue;
    }

    draftSubs.push({
      sub,
      pairedVideo,
      pairedVideoOldName: pairedVideo.name,
      baseName: pairedVideo.baseName,
      videoGroupKey: `vid:${pairedVideo.id}`,
      destScopeKey: `cid:${pairedVideo.parentId}`,
      matchReason,
    });
  }

  const namedSubs = finalizeAdaptiveSubtitleNames(draftSubs);

  const plannedItems = namedSubs
    .map((entry) => {
      const needsMove = String(entry.sub.parentId) !== String(entry.pairedVideo.parentId);
      const needsRename = entry.sub.name !== entry.newName;
      return {
        id: entry.sub.id,
        parentId: entry.sub.parentId,
        targetCid: entry.pairedVideo.parentId,
        sourceRelDir: entry.sub.relativeDir || '',
        targetRelDir: entry.pairedVideo.relativeDir || '',
        fromArchive: entry.sub.fromArchive || null,
        oldName: entry.sub.name,
        newName: entry.newName,
        ext: entry.sub.ext,
        langSuffix: entry.langSuffix,
        isMultiSubtitle: entry.isMultiSubtitle,
        pairedVideoId: entry.pairedVideo.id,
        pairedVideoName: entry.pairedVideo.name,
        matchReason: entry.matchReason,
        needsMove,
        needsRename,
        actionable: needsMove || needsRename,
      };
    })
    .sort((a, b) => {
      const dirCmp = a.targetRelDir.localeCompare(b.targetRelDir, undefined, { numeric: true });
      if (dirCmp !== 0) return dirCmp;
      return a.newName.localeCompare(b.newName, undefined, { numeric: true });
    });

  // 检测目标目录内是否与未被纳入计划的其他已有文件冲突
  const plannedSubIds = new Set(plannedItems.map((x) => String(x.id)));
  const untouchedFilesByKey = new Map();
  for (const f of files) {
    if (!plannedSubIds.has(String(f.id))) {
      untouchedFilesByKey.set(`${f.parentId}:${f.name.toLowerCase()}`, f);
    }
  }

  const seenDestMap = new Map();
  const conflicts = [];
  for (const item of plannedItems) {
    const destKey = `${item.targetCid}:${item.newName.toLowerCase()}`;
    if (seenDestMap.has(destKey)) {
      conflicts.push({
        targetPath: `${item.targetRelDir ? `${item.targetRelDir}/` : ''}${item.newName}`,
        firstFile: seenDestMap.get(destKey).oldName,
        secondFile: item.oldName,
      });
    } else if (untouchedFilesByKey.has(destKey)) {
      conflicts.push({
        targetPath: `${item.targetRelDir ? `${item.targetRelDir}/` : ''}${item.newName}`,
        firstFile: untouchedFilesByKey.get(destKey).name,
        secondFile: item.oldName,
      });
    } else {
      seenDestMap.set(destKey, item);
    }
  }

  const actionableItems = plannedItems.filter((x) => x.actionable);
  const alreadyAlignedCount = plannedItems.length - actionableItems.length;
  const crossDirMoveCount = actionableItems.filter((x) => x.needsMove).length;

  return {
    mode: 'SUBTITLE_MATCH_ONLY',
    plannedItems,
    actionableItems,
    detectedArchives,
    unmatchedSubtitles,
    skippedBonus,
    conflicts,
    stats: {
      totalScannedFiles: files.length,
      totalVideos: indexedVideos.length,
      totalSubtitles: subtitleFiles.length,
      detectedArchiveCount: detectedArchives.length,
      matchedSubtitles: plannedItems.length,
      actionableSubtitles: actionableItems.length,
      alreadyAlignedCount,
      crossDirMoveCount,
      unmatchedCount: unmatchedSubtitles.length,
      conflictCount: conflicts.length,
      skippedBonusCount: skippedBonus.length,
    },
  };
}

function normalizeTitleKey(str = '') {
  return String(str || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s：:·・\-—_!！?？《》<>()（）[\]【】'"“”‘’,，.。/\\]+/g, '');
}

function cleanFolderTagNoise(rawName = '') {
  let s = String(rawName || '')
    .replace(/_字幕解压_[^/\\]+_/g, ' ')
    .replace(/\[[0-9A-Fa-f]{8}\]/g, ' ')
    .replace(/[\s._\-\[(]*(?:3840x2160|1920x1080|1280x720|2160p|1080p|1080i|720p|576p|480p|4K|UHD)[\])]*/gi, ' ')
    .replace(/[\s._\-\[(]*(?:Ma10p|Hi10p|10bit|8bit|12bit|HDR10\+?|Dolby[\s._-]*Vision|DV)[\])]*/gi, ' ')
    .replace(/[\s._\-\[(]*(?:[xh]\.?264|[xh]\.?265|HEVC|AVC|AV1|VP9|MPEG[24]|XviD|DivX)[\])]*/gi, ' ')
    .replace(
      /[\s._\-\[(]*(?:AAC\d*(?:\.\d)?|FLAC(?:\s*\d\.\d)?|EAC3|AC3|DDP?\s*[257]\.[01]|DTS(?:-HD)?(?:\s*MA)?|TrueHD|LPCM|MP3|Opus)[\])]*/gi,
      ' '
    )
    .replace(/[\s._\-\[(]*(?:WEB-?DL|WEBRip|BDRip|Blu-?ray|BD-?Remux|Remux|HDTV|DVDRip|TVRip|BD)[\])]*/gi, ' ')
    .replace(/[\[(]\s*(?:19|20)\d{2}\s*[\])]/g, ' ')
    .trim();

  // 剥离句首字幕组方括号标签（如 "[VCB-Studio] 无头骑士异闻录" -> "无头骑士异闻录"），但若整串都在方括号内则保留内容
  while (/^\[[^\]]+\]\s*\S/.test(s)) {
    s = s.replace(/^\[[^\]]+\]\s*/, '').trim();
  }
  // 剥离尾部残留空括号或纯语言/压制组方括号
  s = s.replace(/(?:\s*\[[^\]]*\])+\s*$/, '').trim();
  return s.replace(/\s+/g, ' ').trim();
}

const PURE_STANDARD_SEASON_SEG_REGEX =
  /^(?:Season\s*\d{1,2}|S\d{1,2}|第\s*[0-9一二两三四五六七八九十]{1,3}\s*季|Specials?|SPs?|OVA|OAD|特别篇|特別篇|番外篇?)$/i;

/**
 * 提取子文件夹相对路径的季度/分割放送 Cour/篇章语义特征（在剥离主剧名后再识别 承/转/结 等单字标记，杜绝剧名本身含“转/结/承”造成误判）
 */
function analyzeSubfolderSemantics(relDir, tmdbMeta, contextFlags = {}) {
  const segments = String(relDir || '')
    .split(/[\/\\]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const topSeg = segments[0] || '';
  const leafSeg = segments[segments.length - 1] || '';

  const explicitSeason = inferSeasonFromDirPath(relDir, leafSeg);
  const isSpecialDir = explicitSeason === 0;

  // 提取目录名前导序号（如 "01.立志篇" / "02 无限列车篇"）与年份提示
  const leadingOrderMatch = topSeg.match(/^\s*(?:\[(\d{1,2})\]|(\d{1,2})\s*[.、\-_])\s*\S/);
  const leadingOrderNum = leadingOrderMatch
    ? Number(leadingOrderMatch[1] ?? leadingOrderMatch[2])
    : null;
  const yearMatch = relDir.match(/[([（【\s.]((?:19|20)\d{2})[)\]）】\s.]/);
  const yearHint = yearMatch ? Number(yearMatch[1]) : null;

  const cleanedTop = cleanFolderTagNoise(topSeg).replace(/^\d{1,2}\s*[.、\-_]\s*/, '').trim();
  const cleanedFull = segments
    .map((seg) => cleanFolderTagNoise(seg))
    .filter(Boolean)
    .join(' / ');

  const showTitle = String(tmdbMeta?.showTitle || '').trim();
  const baseShowTitle = showTitle ? showTitle.split(/[：:·\-]/)[0].trim() : '';

  const normCleanedTop = normalizeTitleKey(cleanedTop);
  const normShow = normalizeTitleKey(showTitle);
  const normBaseShow = normalizeTitleKey(baseShowTitle);

  const isBaseShowTitleDir = Boolean(
    normCleanedTop &&
      ((normShow && normCleanedTop === normShow) ||
        (normBaseShow && normBaseShow.length >= 2 && normCleanedTop === normBaseShow))
  );

  // 从清洗后的目录名中剥离主剧名，得到纯后缀残余文本（如 "无头骑士异闻录×转" -> "×转"；"关于我转生变成史莱姆这档事" -> ""）
  let residual = cleanedFull;
  for (const titleCandidate of [showTitle, baseShowTitle]) {
    if (titleCandidate && titleCandidate.length >= 2) {
      residual = residual.replace(new RegExp(escapeRegExp(titleCandidate), 'gi'), ' ');
    }
  }
  residual = residual.trim();

  // 识别续作乘号/罗马数字/英文序数季（如 ×2, x2, II, 2nd Season）
  let sequelNum = null;
  const multMatch = residual.match(/(?:^|[\s×xX])([2-9])(?=$|[^0-9A-Za-z])/);
  if (multMatch && /[×xX]/.test(residual)) {
    sequelNum = Number(multMatch[1]);
  }
  if (sequelNum === null) {
    const ordSeasonMatch = residual.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i);
    if (ordSeasonMatch) sequelNum = Number(ordSeasonMatch[1]);
  }
  if (sequelNum === null) {
    const romanMap = { II: 2, III: 3, IV: 4, V: 5, VI: 6 };
    const romanMatch = residual.match(/(?:^|[\s._\-\[(])(II|III|IV|V|VI)(?=$|[\s._\-\])])/);
    if (romanMatch) sequelNum = romanMap[romanMatch[1]] ?? null;
  }

  // 识别分割放送 Cour 序号（Part 1/2, 第1クール, 起/承/转/结, Shou/Ten/Ketsu, 上/中/下, 前篇/后篇）
  let courIndex = null;
  let courTotalHint = null;

  const partMatch =
    residual.match(/\b(?:Part|Cour)\s*(\d{1,2})\b/i) ||
    residual.match(/第\s*([0-9一二两三四])\s*(?:クール|部分|阶段)/i);
  if (partMatch) {
    courIndex = parseChineseSeasonNum(partMatch[1]) ?? Number(partMatch[1]);
  }

  if (courIndex === null) {
    const kishotenMatch = residual.match(
      /(?:^|[×xX·・\s._\-\[(【（/])([起承转轉结結合])(?=$|[\s._\-\])】）/])/
    );
    if (kishotenMatch) {
      const ch = kishotenMatch[1];
      if (contextFlags.hasQiMarker) {
        const map4 = { 起: 1, 承: 2, 转: 3, 轉: 3, 结: 4, 結: 4, 合: 4 };
        courIndex = map4[ch] ?? null;
        courTotalHint = 4;
      } else {
        const map3 = { 承: 1, 转: 2, 轉: 2, 结: 3, 結: 3, 合: 3 };
        courIndex = map3[ch] ?? null;
        courTotalHint = 3;
      }
    }
  }

  if (courIndex === null) {
    const romajiCourMatch = residual.match(/(?:^|[×xX·・\s._\-\[(/])(Shou|Ten|Ketsu)(?=$|[\s._\-\])/])/i);
    if (romajiCourMatch) {
      const key = romajiCourMatch[1].toLowerCase();
      courIndex = key === 'shou' ? 1 : key === 'ten' ? 2 : 3;
      courTotalHint = 3;
    }
  }

  if (courIndex === null) {
    const shangXiaMatch = residual.match(
      /(?:^|[\s._\-\[(【（/])([上中下])(?:篇|部|半|卷)?(?=$|[\s._\-\])】）/])/
    );
    if (shangXiaMatch) {
      const ch = shangXiaMatch[1];
      if (contextFlags.hasZhongMarker || ch === '中') {
        courIndex = ch === '上' ? 1 : ch === '中' ? 2 : 3;
        courTotalHint = 3;
      } else {
        courIndex = ch === '上' ? 1 : 2;
        courTotalHint = 2;
      }
    }
  }

  if (courIndex === null) {
    const qianHouMatch = residual.match(
      /(?:^|[\s._\-\[(【（/])([前后後])(?:篇|編|半|部)(?=$|[\s._\-\])】）/])/
    );
    if (qianHouMatch) {
      courIndex = qianHouMatch[1] === '前' ? 1 : 2;
      courTotalHint = 2;
    }
  }

  const isPureStandardSeasonDir =
    PURE_STANDARD_SEASON_SEG_REGEX.test(topSeg) && courIndex === null;

  // 比对 TMDB 各季 canonicalFolderName / seasonTitle
  let matchedTmdbSeasonNum = null;
  const normResidual = normalizeTitleKey(residual);
  if (Array.isArray(tmdbMeta?.regularSeasons)) {
    for (const s of tmdbMeta.regularSeasons) {
      const normCanon = normalizeTitleKey(s.canonicalFolderName);
      const normSeasonTitle = normalizeTitleKey(s.seasonTitle);
      if (
        (normCanon && normCleanedTop === normCanon) ||
        (normSeasonTitle && normCleanedTop === normSeasonTitle)
      ) {
        matchedTmdbSeasonNum = s.seasonNumber;
        break;
      }
      // 篇章名子串匹配（如目录为 "鬼灭之刃 游郭篇"，TMDB 季名为 "游郭篇"）
      if (
        courIndex === null &&
        normResidual.length >= 2 &&
        ((normCanon.length >= 2 &&
          (normResidual === normCanon ||
            normCanon.includes(normResidual) ||
            normResidual.includes(normCanon))) ||
          (normSeasonTitle.length >= 2 &&
            !/^第\d+季$|^season\d+$/i.test(normSeasonTitle) &&
            (normResidual === normSeasonTitle ||
              normSeasonTitle.includes(normResidual) ||
              normResidual.includes(normSeasonTitle))))
      ) {
        matchedTmdbSeasonNum = s.seasonNumber;
        break;
      }
    }
  }

  if (matchedTmdbSeasonNum === null && isBaseShowTitleDir && courIndex === null) {
    if (tmdbMeta?.regularSeasons?.some((s) => s.seasonNumber === 1)) {
      matchedTmdbSeasonNum = 1;
    }
  }

  return {
    topSeg,
    cleanedTop,
    residual,
    normCleanedTop,
    normResidual,
    explicitSeason,
    isSpecialDir,
    isPureStandardSeasonDir,
    isBaseShowTitleDir,
    sequelNum,
    courIndex,
    courTotalHint,
    leadingOrderNum,
    yearHint,
    matchedTmdbSeasonNum,
  };
}

/**
 * 尝试利用 TMDB 单集标题与视频文件名中的单集标题求交集共识，反推该子文件夹对应的 (seasonNumber, epOffset)
 */
function inferGroupByEpisodeTitles(group, regularSeasons = []) {
  const candidates = new Map();

  for (const s of regularSeasons) {
    if (!Array.isArray(s.episodes) || s.episodes.length === 0) continue;
    for (const v of group.regularVideos) {
      const normStem = normalizeTitleKey(stripExtension(v.name));
      if (!normStem) continue;
      for (const ep of s.episodes) {
        const normEpTitle = normalizeTitleKey(ep.title);
        if (
          !normEpTitle ||
          normEpTitle.length < 3 ||
          /^(?:第?\d+[集话話期]?|episode\d+)$/i.test(normEpTitle)
        ) {
          continue;
        }
        if (normStem.includes(normEpTitle)) {
          const offset = ep.episodeNumber - v.token.epStart;
          if (offset >= 0 && offset < s.episodeCount) {
            const key = `${s.seasonNumber}:${offset}`;
            candidates.set(key, (candidates.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }

  if (candidates.size === 0) return null;
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  const [bestKey, bestHits] = sorted[0];
  const secondHits = sorted[1]?.[1] ?? 0;
  const minRequired = group.regularVideos.length === 1 ? 1 : 2;
  if (bestHits >= minRequired && bestHits > secondHits) {
    const [sStr, offStr] = bestKey.split(':');
    return {
      seasonNumber: Number(sStr),
      epOffset: Number(offStr),
      matchSource: 'TMDB 单集标题精确对齐',
    };
  }
  return null;
}

/**
 * 核心重分类对齐引擎：
 * 检测本地视频子文件夹分类是否与 TMDB 季度结构不一致（如 无头骑士异闻录 / ×承 / ×转 / ×结、Part 1/2、多篇章目录、或错误拆分的 Season 01..04），
 * 并自动计算每个视频目录对应的 TMDB 目标季号、集数偏移量与分类依据。
 */
export function buildSubfolderReclassificationMap(parsedVideos, tmdbMeta) {
  const rawGroupsMap = new Map();
  for (const v of parsedVideos) {
    const relDir = v.relativeDir || '';
    if (!relDir) continue;
    if (!rawGroupsMap.has(relDir)) {
      rawGroupsMap.set(relDir, []);
    }
    rawGroupsMap.get(relDir).push(v);
  }

  if (rawGroupsMap.size === 0) {
    return { isMismatched: false, groupMappings: new Map(), summaryList: [] };
  }

  const showTitle = String(tmdbMeta?.showTitle || '').trim();
  const baseShowTitle = showTitle ? showTitle.split(/[：:·\-]/)[0].trim() : '';

  // 预扫描所有子目录残余名，判断是否存在 "起"（4分割：起承转合）或 "中"（3分割：上中下）
  let hasQiMarker = false;
  let hasZhongMarker = false;
  for (const relDir of rawGroupsMap.keys()) {
    let res = cleanFolderTagNoise(relDir);
    for (const tc of [showTitle, baseShowTitle]) {
      if (tc && tc.length >= 2) {
        res = res.replace(new RegExp(escapeRegExp(tc), 'gi'), ' ');
      }
    }
    if (/(?:^|[×xX·・\s._\-\[(【（/])起(?=$|[\s._\-\])】）/])/.test(res)) hasQiMarker = true;
    if (/(?:^|[\s._\-\[(【（/])中(?:篇|部|半|卷)?(?=$|[\s._\-\])】）/])/.test(res)) {
      hasZhongMarker = true;
    }
  }

  const subfolderGroups = [];
  let scanOrderIndex = 0;
  for (const [relDir, videos] of rawGroupsMap.entries()) {
    const regularVideos = videos.filter(
      (v) => v.token?.kind === 'global_episode' || v.token?.kind === 'season_episode'
    );
    const specialVideos = videos.filter(
      (v) => v.token?.kind === 'special' || v.token?.kind === 'fractional_episode'
    );

    const regEpNums = [];
    for (const rv of regularVideos) {
      for (let e = rv.token.epStart; e <= rv.token.epEnd; e += 1) {
        regEpNums.push(e);
      }
    }
    const uniqueSortedEps = [...new Set(regEpNums)].sort((a, b) => a - b);
    const minRegularEp = uniqueSortedEps.length > 0 ? uniqueSortedEps[0] : null;
    const maxRegularEp =
      uniqueSortedEps.length > 0 ? uniqueSortedEps[uniqueSortedEps.length - 1] : null;
    const rawRegCount = uniqueSortedEps.length;
    const effectiveRegCount =
      minRegularEp === 1 && maxRegularEp !== null && maxRegularEp >= rawRegCount && maxRegularEp - rawRegCount <= 2
        ? maxRegularEp
        : rawRegCount;

    const sem = analyzeSubfolderSemantics(relDir, tmdbMeta, { hasQiMarker, hasZhongMarker });
    subfolderGroups.push({
      relDir,
      scanOrderIndex: scanOrderIndex++,
      videos,
      regularVideos,
      specialVideos,
      minRegularEp,
      maxRegularEp,
      rawRegCount,
      effectiveRegCount,
      ...sem,
    });
  }

  const regularGroups = subfolderGroups.filter(
    (g) => !g.isSpecialDir && g.regularVideos.length > 0
  );
  const specialGroups = subfolderGroups.filter(
    (g) => g.isSpecialDir || (g.regularVideos.length === 0 && g.specialVideos.length > 0)
  );

  const groupMappings = new Map();
  for (const sg of specialGroups) {
    groupMappings.set(sg.relDir, {
      relDir: sg.relDir,
      topSeg: sg.topSeg,
      seasonNumber: 0,
      epOffset: 0,
      minRegularEp: sg.minRegularEp,
      maxRegularEp: sg.maxRegularEp,
      matchSource: '特别篇子目录识别',
    });
  }

  if (regularGroups.length === 0) {
    return { isMismatched: false, groupMappings, summaryList: [] };
  }

  const tmdbSeasonByNum = new Map(
    (tmdbMeta?.regularSeasons || []).map((s) => [s.seasonNumber, s])
  );
  const specialSlack = tmdbMeta?.specialSeason ? 2 : 0;

  // 严格判定：本地正片子目录是否已经与 TMDB 季度 1:1 标准对齐
  const seenExplicitSeasons = new Set();
  let isAlreadyAligned = true;
  for (const g of regularGroups) {
    if (g.explicitSeason === null || g.explicitSeason < 1 || g.courIndex !== null) {
      isAlreadyAligned = false;
      break;
    }
    const ts = tmdbSeasonByNum.get(g.explicitSeason);
    if (!ts) {
      isAlreadyAligned = false;
      break;
    }
    if (seenExplicitSeasons.has(g.explicitSeason)) {
      isAlreadyAligned = false;
      break;
    }
    seenExplicitSeasons.add(g.explicitSeason);

    if (
      g.rawRegCount > ts.episodeCount + specialSlack ||
      (g.minRegularEp === 1 && g.maxRegularEp > ts.episodeCount + specialSlack)
    ) {
      isAlreadyAligned = false;
      break;
    }
  }

  if (isAlreadyAligned) {
    return { isMismatched: false, groupMappings, summaryList: [] };
  }

  // ==================== 执行 TMDB 季度重分类映射 ====================
  const lockedSeasons = new Set();
  const assignGroup = (g, mapping) => {
    groupMappings.set(g.relDir, {
      relDir: g.relDir,
      topSeg: g.topSeg,
      minRegularEp: g.minRegularEp,
      maxRegularEp: g.maxRegularEp,
      effectiveRegCount: g.effectiveRegCount,
      ...mapping,
    });
  };

  // Pass A: 单集标题精确共识匹配（当文件名携带单集标题且已拉取 TMDB 单季详情时优先级最高）
  for (const g of regularGroups) {
    const epTitleHit = inferGroupByEpisodeTitles(g, tmdbMeta.regularSeasons);
    if (epTitleHit) {
      assignGroup(g, epTitleHit);
      const ts = tmdbSeasonByNum.get(epTitleHit.seasonNumber);
      if (ts && epTitleHit.epOffset === 0 && Math.abs(g.effectiveRegCount - ts.episodeCount) <= 2) {
        lockedSeasons.add(ts.seasonNumber);
      }
    }
  }

  // Pass B: 非分割目录的 TMDB 季名/主剧名锚点匹配（如 "无头骑士异闻录" -> S1, "立志篇" -> S1, "刀匠村篇" -> S3）
  const unmappedNonCourWithoutAnchor = regularGroups.filter(
    (g) =>
      !groupMappings.has(g.relDir) &&
      g.courIndex === null &&
      g.matchedTmdbSeasonNum === null &&
      g.explicitSeason === null
  );

  for (const g of regularGroups) {
    if (groupMappings.has(g.relDir) || g.courIndex !== null) continue;
    const anchorSeasonNum = g.matchedTmdbSeasonNum;
    if (anchorSeasonNum === null) continue;
    const ts = tmdbSeasonByNum.get(anchorSeasonNum);
    if (!ts || lockedSeasons.has(ts.seasonNumber)) continue;

    // 检查是否有其他目录也锚定到同一季
    const sameAnchorPeers = regularGroups.filter(
      (x) => !groupMappings.has(x.relDir) && x.matchedTmdbSeasonNum === anchorSeasonNum
    );
    if (sameAnchorPeers.length > 1) continue;

    const countMatchesFullSeason =
      g.effectiveRegCount >= ts.episodeCount - 1 &&
      g.effectiveRegCount <= ts.episodeCount + specialSlack + 1;

    // 若集数与整季吻合，或当前不存在未归属的神秘篇章目录需要并入本季（兼容用户只下载了部分剧集的场景）
    if (
      countMatchesFullSeason ||
      (unmappedNonCourWithoutAnchor.length === 0 && g.effectiveRegCount <= ts.episodeCount)
    ) {
      assignGroup(g, {
        seasonNumber: ts.seasonNumber,
        epOffset: 0,
        matchSource: 'TMDB 季名特征对齐',
      });
      lockedSeasons.add(ts.seasonNumber);
    }
  }

  // Pass C: 分割放送 Cour 目录对齐（如 ×承 / ×转 / ×结、Part 1 / Part 2、上篇 / 下篇）
  const unmappedCourGroups = regularGroups.filter(
    (g) => !groupMappings.has(g.relDir) && g.courIndex !== null
  );
  if (unmappedCourGroups.length > 0) {
    const courBucketsBySeason = new Map();

    for (const g of unmappedCourGroups) {
      let targetS = null;
      if (g.explicitSeason !== null && tmdbSeasonByNum.has(g.explicitSeason)) {
        targetS = tmdbSeasonByNum.get(g.explicitSeason);
      } else if (g.sequelNum !== null && tmdbSeasonByNum.has(g.sequelNum)) {
        targetS = tmdbSeasonByNum.get(g.sequelNum);
      } else if (g.matchedTmdbSeasonNum !== null && tmdbSeasonByNum.has(g.matchedTmdbSeasonNum)) {
        targetS = tmdbSeasonByNum.get(g.matchedTmdbSeasonNum);
      } else {
        const unlocked = tmdbMeta.regularSeasons.filter((s) => !lockedSeasons.has(s.seasonNumber));
        // 优先匹配具有自定义乘号/前缀关联或放送分割数吻合的季度（如 "无头骑士异闻录×承" 对应 "无头骑士异闻录×2"）
        targetS =
          unlocked.find(
            (s) =>
              Array.isArray(s.cours) &&
              s.cours.length >= (g.courTotalHint || g.courIndex) &&
              s.cours.length > 1
          ) ||
          unlocked.find(
            (s) =>
              /[×xX]/.test(g.cleanedTop) && /[×xX]/.test(s.canonicalFolderName || s.seasonTitle)
          ) ||
          unlocked.find(
            (s) =>
              g.courTotalHint &&
              s.episodeCount >= g.courTotalHint * Math.max(1, g.effectiveRegCount) &&
              s.episodeCount % g.courTotalHint === 0
          ) ||
          unlocked[0] ||
          tmdbMeta.regularSeasons[tmdbMeta.regularSeasons.length - 1];
      }

      if (targetS) {
        if (!courBucketsBySeason.has(targetS.seasonNumber)) {
          courBucketsBySeason.set(targetS.seasonNumber, { season: targetS, list: [] });
        }
        courBucketsBySeason.get(targetS.seasonNumber).list.push(g);
      }
    }

    for (const [sNum, { season: targetS, list }] of courBucketsBySeason.entries()) {
      list.sort((a, b) => a.courIndex - b.courIndex);
      const maxCourIdx = Math.max(...list.map((x) => x.courIndex));
      const totalCours = Math.max(
        list[0]?.courTotalHint || 0,
        maxCourIdx,
        list.length,
        targetS.cours?.length || 1
      );

      for (const g of list) {
        const k = g.courIndex;
        let epOffset = 0;

        if (Array.isArray(targetS.cours) && targetS.cours.length >= k && targetS.cours.length > 1) {
          epOffset = targetS.cours[k - 1].epOffset;
        } else {
          // 检查前序 1..k-1 部分是否齐全且具备完整单 Cour 集数（兼容 13+12=25 等不等长分割）
          const prevParts = [];
          let allPrevComplete = k > 1;
          for (let p = 1; p < k; p += 1) {
            const foundPrev = list.find((x) => x.courIndex === p);
            if (!foundPrev || foundPrev.effectiveRegCount < 5) {
              allPrevComplete = false;
              break;
            }
            prevParts.push(foundPrev);
          }

          if (allPrevComplete) {
            const sumPrev = prevParts.reduce((acc, x) => acc + x.effectiveRegCount, 0);
            if (sumPrev < targetS.episodeCount) {
              epOffset = sumPrev;
            }
          } else if (totalCours >= 2 && targetS.episodeCount % totalCours === 0) {
            const evenWidth = targetS.episodeCount / totalCours;
            if ((k - 1) * evenWidth < targetS.episodeCount) {
              epOffset = (k - 1) * evenWidth;
            }
          } else if ((k - 1) * 12 < targetS.episodeCount) {
            epOffset = (k - 1) * 12;
          }
        }

        assignGroup(g, {
          seasonNumber: sNum,
          epOffset,
          matchSource: `TMDB 分割放送第 ${k} 部分对齐`,
        });
      }
      lockedSeasons.add(sNum);
    }
  }

  // Pass D: 剩余未映射目录（如 Season 01..04 拆分季、或 无限列车篇 + 游郭篇 多篇章合并季、或单目录超长跨季）顺序划分
  const remainingGroups = regularGroups.filter((g) => !groupMappings.has(g.relDir));
  if (remainingGroups.length > 0) {
    const unlockedSeasons = tmdbMeta.regularSeasons.filter(
      (s) => !lockedSeasons.has(s.seasonNumber)
    );
    const targetBuckets =
      unlockedSeasons.length > 0 ? unlockedSeasons : tmdbMeta.regularSeasons;

    // 针对单季内的多篇章排序（若 TMDB seasonOverview 同时提及各篇章名，按简介出现先后顺序排列；否则按显式季号/序号/年份/原序排列）
    const findOverviewPos = (g, sObj) => {
      const ov = normalizeTitleKey(sObj?.seasonOverview || '');
      const key = g.normResidual || g.normCleanedTop;
      if (!ov || !key || key.length < 2) return null;
      const core = key.replace(/篇$/, '');
      const idx = ov.indexOf(core.length >= 2 ? core : key);
      return idx >= 0 ? idx : null;
    };

    remainingGroups.sort((a, b) => {
      if (a.explicitSeason !== null && b.explicitSeason !== null && a.explicitSeason !== b.explicitSeason) {
        return a.explicitSeason - b.explicitSeason;
      }
      if (a.leadingOrderNum !== null && b.leadingOrderNum !== null && a.leadingOrderNum !== b.leadingOrderNum) {
        return a.leadingOrderNum - b.leadingOrderNum;
      }
      if (targetBuckets.length === 1) {
        const posA = findOverviewPos(a, targetBuckets[0]);
        const posB = findOverviewPos(b, targetBuckets[0]);
        if (posA !== null && posB !== null && posA !== posB) return posA - posB;
      }
      if (a.yearHint !== null && b.yearHint !== null && a.yearHint !== b.yearHint) {
        return a.yearHint - b.yearHint;
      }
      return a.scanOrderIndex - b.scanOrderIndex;
    });

    // 特例：仅 1 个超长目录跨越了多个 TMDB 季度（如 Season 01 内含 01..36 集，而 TMDB 为 S1=12 + S2=24）
    if (
      remainingGroups.length === 1 &&
      targetBuckets.length > 1 &&
      remainingGroups[0].effectiveRegCount > targetBuckets[0].episodeCount + specialSlack + 1
    ) {
      const g = remainingGroups[0];
      assignGroup(g, {
        seasonNumber: targetBuckets[0].seasonNumber,
        epOffset: 0,
        overflowFold: true,
        baseGlobalOffset: targetBuckets[0].globalStart - 1,
        matchSource: '跨季合并目录按 TMDB 季度自动拆分',
      });
    } else {
      let bucketIdx = 0;
      let accInSeason = 0;

      for (let i = 0; i < remainingGroups.length; i += 1) {
        const g = remainingGroups[i];
        const curSeason = targetBuckets[Math.min(bucketIdx, targetBuckets.length - 1)];

        // 若当前季已有累积集数，且加入本目录会显著超出当前季容量，则推进至下一季桶
        if (
          accInSeason > 0 &&
          bucketIdx + 1 < targetBuckets.length &&
          accInSeason + g.effectiveRegCount > curSeason.episodeCount + 1
        ) {
          bucketIdx += 1;
          accInSeason = 0;
        }

        const activeSeason = targetBuckets[Math.min(bucketIdx, targetBuckets.length - 1)];
        assignGroup(g, {
          seasonNumber: activeSeason.seasonNumber,
          epOffset: accInSeason,
          matchSource:
            accInSeason > 0
              ? `TMDB 同季多篇章合并对齐 (偏移 +${accInSeason})`
              : 'TMDB 季度集数序列对齐',
        });

        accInSeason += g.effectiveRegCount;
        if (
          accInSeason >= activeSeason.episodeCount - 1 &&
          bucketIdx + 1 < targetBuckets.length
        ) {
          bucketIdx += 1;
          accInSeason = 0;
        }
      }
    }
  }

  const summaryList = regularGroups
    .map((g) => groupMappings.get(g.relDir))
    .filter(Boolean);

  return {
    isMismatched: true,
    groupMappings,
    summaryList,
  };
}

/**
 * 尝试利用 TMDB 官方单集标题比对视频文件名，进行单集精确对齐（Ground Truth Title Match）。
 * 杜绝本地资源假标季号（如明明是第一季第13集，却被标注为 S02E01）。
 */
export function findBestEpisodeTitleMatch(rawFileName = '', regularSeasons = []) {
  if (!rawFileName || !Array.isArray(regularSeasons) || regularSeasons.length === 0) {
    return null;
  }
  const normFileName = normalizeTitleKey(stripExtension(rawFileName));
  if (!normFileName || normFileName.length < 3) return null;

  let bestMatch = null;
  let maxMatchedLength = 0;

  for (const s of regularSeasons) {
    if (!Array.isArray(s.episodes) || s.episodes.length === 0) continue;
    for (const ep of s.episodes) {
      const epTitle = ep.title ? String(ep.title).trim() : '';
      const normEpTitle = normalizeTitleKey(epTitle);
      if (
        !normEpTitle ||
        normEpTitle.length < 3 ||
        /^(?:第?\d+[集话話期]?|episode\d+|ep\d+)$/i.test(normEpTitle)
      ) {
        continue;
      }
      if (normFileName.includes(normEpTitle)) {
        if (normEpTitle.length > maxMatchedLength) {
          maxMatchedLength = normEpTitle.length;
          bestMatch = {
            seasonNumber: s.seasonNumber,
            episodeNumber: ep.episodeNumber,
            season: s,
            episode: ep,
            matchedTitle: epTitle,
          };
        }
      }
    }
  }

  return bestMatch;
}

/**
 * 获取 TMDB 页面官方单集编号规范：
 * 优先以 TMDB 网站页面上的真实集号为准：
 * 1. 若 TMDB 该季官方起始集号 > 1（例如 S02 页面直接标注为 13..24，startEpisodeNumber === 13）：
 *    - 如果输入是 1-based 季内相对集号（1 <= epIndexOrNum <= episodeCount），则自动映射为真实集号（1 -> 13）；
 *    - 如果输入已经等于 TMDB 真实集号（13..24），则直接采用 13；
 * 2. 若 TMDB 该季官方从 1 开始编号（startEpisodeNumber === 1），则输出 S02E01。
 */
export function getTmdbSeasonEpisodeNumber(seasonObj, epIndexOrNum) {
  if (!seasonObj || typeof epIndexOrNum !== 'number') return epIndexOrNum;

  const eps = Array.isArray(seasonObj.episodes) ? seasonObj.episodes : [];
  const startNum =
    seasonObj.startEpisodeNumber ??
    (eps[0]?.episodeNumber ?? 1);
  const endNum =
    seasonObj.endEpisodeNumber ??
    (eps[eps.length - 1]?.episodeNumber ?? (startNum + Math.max(1, seasonObj.episodeCount || 1) - 1));

  // 1. 如果 epIndexOrNum 已经落在该季 TMDB 真实单集集号中（例如输入 13，且 TMDB 真实存在第 13 集）
  if (eps.length > 0) {
    const exactHit = eps.find((e) => e.episodeNumber === epIndexOrNum);
    if (exactHit) return exactHit.episodeNumber;
  } else if (startNum > 1 && epIndexOrNum >= startNum && epIndexOrNum <= endNum) {
    return epIndexOrNum;
  }

  // 2. 如果 TMDB 该季起始集号 > 1，而输入为相对序号（如 1 <= epIndexOrNum <= seasonCount）
  if (startNum > 1 && epIndexOrNum < startNum) {
    if (eps.length > 0 && epIndexOrNum >= 1 && epIndexOrNum <= eps.length) {
      return eps[epIndexOrNum - 1].episodeNumber;
    }
    return startNum + (epIndexOrNum - 1);
  }

  // 3. 起始集号为 1 或未配置特殊偏移
  return epIndexOrNum;
}

/**
 * 判断是否需要按需拉取 TMDB 单季剧集详情页（用于获取分割放送播出间隔、单集标题与特别篇 OVA 标题及简介）
 */
export function needsEpisodeEnrichment(files = [], tmdbMeta = null) {
  if (!tmdbMeta || !Array.isArray(files) || files.length === 0) return false;
  if ((tmdbMeta.regularSeasons?.length ?? 0) > 15) return false;

  const parsedVideos = [];
  let hasFractionalOrSpecial = false;
  let hasSeason2OrHigher = false;

  for (const f of files) {
    const ext = getExtension(f.name);
    if (!VIDEO_EXTENSIONS.has(ext) || isBonusClip(f.name)) continue;
    const token = parseEpisodeToken(f.name, tmdbMeta.showTitle);
    const dirSeason = inferSeasonFromDirPath(f.relativeDir, f.parentFolderName);
    if (
      token?.kind === 'fractional_episode' ||
      token?.kind === 'special' ||
      dirSeason === 0 ||
      /(?:^|[\s._\-\[(（【])(?:SP|OVA|OAD|Special|特别篇|特別篇|番外|总集篇|總集篇)/i.test(f.name)
    ) {
      hasFractionalOrSpecial = true;
    }
    if (token?.kind === 'season_episode' && token.season >= 2) {
      hasSeason2OrHigher = true;
    }
    parsedVideos.push({ ...f, ext, token });
  }

  if (hasFractionalOrSpecial && tmdbMeta.specialSeason) return true;
  // 当存在 S02 及以上的多季资源时，拉取 TMDB 单季页面以获取官方集号规范（判断 S02 是从 13 还是 1 开始）及单集标题
  if (hasSeason2OrHigher) return true;

  const reclass = buildSubfolderReclassificationMap(parsedVideos, tmdbMeta);
  return reclass.isMismatched;
}

/**
 * 从本地待处理文件列表中检测当前涉及的季度集合（用于精简 TMDB 单季拉取，避免无谓全剧拉取）
 */
export function detectActiveSeasonsFromFiles(files = [], tmdbMeta = null) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const seasons = new Set();
  for (const f of files) {
    const ext = getExtension(f.name);
    if (!VIDEO_EXTENSIONS.has(ext) && !SUBTITLE_EXTENSIONS.has(ext)) continue;
    const token = parseEpisodeToken(f.name, tmdbMeta?.showTitle);
    const dirSeason = inferSeasonFromDirPath(f.relativeDir, f.parentFolderName);
    if (token?.kind === 'season_episode' && Number.isInteger(token.season)) {
      seasons.add(token.season);
    } else if (
      token?.kind === 'fractional_episode' ||
      token?.kind === 'special' ||
      dirSeason === 0 ||
      /(?:^|[\s._\-\[(（【])(?:SP|OVA|OAD|Special|特别篇|特別篇|番外|总集篇|總集篇)/i.test(f.name)
    ) {
      seasons.add(0);
    }
    if (dirSeason !== null && dirSeason >= 1) {
      seasons.add(dirSeason);
    }
    const folderMatch = (f.relativeDir || f.parentFolderName || '').match(/\b(?:Season|S)\s*(\d{1,2})\b/i);
    if (folderMatch) {
      seasons.add(Number(folderMatch[1]));
    }
  }
  return seasons.size > 0 ? seasons : null;
}

/**
 * 为外挂字幕路径向上回溯或按同名段落匹配所属的视频重分类目录组
 * 兼容：
 * - "无头骑士异闻录×转/01.ass"
 * - "无头骑士异闻录×转/外挂字幕/_字幕解压_Subs_/ASS/01.ass"
 * - "外挂字幕/无头骑士异闻录×转/简体/01.ass"
 */
function findMappedGroupForPath(relDir = '', groupMappings = new Map()) {
  if (!relDir || groupMappings.size === 0) return null;
  if (groupMappings.has(relDir)) return groupMappings.get(relDir);

  const parts = String(relDir)
    .split(/[\/\\]+/)
    .filter(Boolean);

  for (let len = parts.length - 1; len >= 1; len -= 1) {
    const prefix = parts.slice(0, len).join('/');
    if (groupMappings.has(prefix)) return groupMappings.get(prefix);
  }

  // 检查字幕路径各层目录名是否嵌入了某个已映射视频目录的名称（如 "外挂字幕/无头骑士异闻录×转/CHS"）
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const normSeg = normalizeTitleKey(cleanFolderTagNoise(parts[i]));
    if (!normSeg) continue;
    for (const [, mapped] of groupMappings.entries()) {
      const normTop = normalizeTitleKey(cleanFolderTagNoise(mapped.topSeg));
      if (normTop && normSeg === normTop) {
        return mapped;
      }
    }
  }

  return null;
}

const CJK_STOP_BIGRAMS = new Set([
  '特别', '特別', '别篇', '別篇', '番外', '外篇', '剧场', '劇場', '场版', '場版',
  '动画', '動畫', '视频', '視頻', '中字', '字幕', '简体', '繁体', '双语', '内封',
  '外挂', '第一', '第二', '第三', '第四', '第五', '部分', '故事', '讲述', '收录',
]);

const LATIN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'part', 'vol', 'volume', 'episode',
  'special', 'specials', 'ova', 'oad', 'sp', 'bd', 'dvd', 'bluray', 'web', 'dl',
  'rip', 'remux', 'hevc', 'avc', 'aac', 'flac', 'chs', 'cht', 'eng', 'jpn', 'sub',
  'raw', 'raws', 'studio', 'vcb', 'ver', 'version', 'movie', 'tv', 'show',
]);

/**
 * 解析手动指定的特别篇映射字符串，例如 "SP01=3,SP02=5,12.5=2" 或 "1=3,2=5"
 */
export function parseExplicitSpMap(rawSpMap = '') {
  const map = new Map();
  if (!rawSpMap) return map;
  const pairs = String(rawSpMap)
    .split(/[,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const m = pair.match(/^(.+?)\s*[:=]\s*(?:S0*0?E)?0*(\d{1,3})$/i);
    if (!m) continue;
    const rawKey = m[1].trim().toLowerCase();
    const targetEp = Number(m[2]);
    if (!targetEp || Number.isNaN(targetEp)) continue;
    map.set(rawKey, targetEp);
    const numOnly = rawKey.match(/^(?:sp|ova|oad|s0*0e|ep?)?0*(\d+(?:\.\d+)?)$/i);
    if (numOnly) {
      map.set(`num:${Number(numOnly[1])}`, targetEp);
    }
  }
  return map;
}

/**
 * 从特别篇文件名及所属子目录名中提取用于对齐 TMDB Season 0 标题与简介（Overview）的语义特征
 */
export function extractSpecialDescriptiveFeatures(rawFileName = '', relativeDir = '', showTitles = []) {
  const stem = stripExtension(String(rawFileName || ''));
  const dirSegments = String(relativeDir || '')
    .split(/[\/\\]+/)
    .map((s) => cleanFolderTagNoise(s))
    .filter((s) => s && !PURE_STANDARD_SEASON_SEG_REGEX.test(s));

  const combinedRaw = [stem, ...dirSegments].join(' ');

  // 1. 提取 .5 半集号与显式话数标识（如 12.5, 第13.5话, 第25话, #25）
  const fractionalNums = [];
  for (const m of combinedRaw.matchAll(/(?:^|[^\d.])(\d{1,3}\.5)(?=$|[^\d.])/g)) {
    const val = Number(m[1]);
    if (!fractionalNums.includes(val)) fractionalNums.push(val);
  }

  const innerEpNums = [];
  for (const m of combinedRaw.matchAll(/第\s*(\d{1,3}(?:\.5)?)\s*[集话話期]/g)) {
    const val = Number(m[1]);
    if (!innerEpNums.includes(val)) innerEpNums.push(val);
  }
  for (const m of combinedRaw.matchAll(/(?:^|[\s._\-\[(#])(?:EP|Episode)\s*0*(\d{1,3}(?:\.5)?)(?=$|[\s._\-\])])/gi)) {
    const val = Number(m[1]);
    if (!innerEpNums.includes(val)) innerEpNums.push(val);
  }

  // 2. 提取特别篇子类型标签（OVA / OAD / 总集篇 / 剧场版特典）与类型内序号
  let spTypeTag = null;
  let spTypeIndex = null;

  const ovaIdxMatch = combinedRaw.match(/(?:^|[\s._\-\[(（【])(OVA|OAD)\s*(?:第\s*)?0*(\d{1,2})?(?:\s*[集话話期卷])?(?=$|[\s._\-\])）】])/i);
  const recapIdxMatch = combinedRaw.match(/(?:^|[\s._\-\[(（【])(总集篇|總集篇|回顾篇?|Recap|Summary)\s*(?:第\s*)?0*(\d{1,2}|[IⅠⅡⅢⅣ1-9])?(?=$|[\s._\-\])）】])/i);
  const spIdxMatch = combinedRaw.match(/(?:^|[\s._\-\[(（【])(?:SP|Special|特别篇|特別篇|番外篇?)\s*(?:第\s*)?0*(\d{1,2})?(?=$|[\s._\-\])）】])/i);

  const parseRomanOrInt = (s) => {
    if (!s) return null;
    const map = { I: 1, 'Ⅰ': 1, II: 2, 'Ⅱ': 2, III: 3, 'Ⅲ': 3, IV: 4, 'Ⅳ': 4 };
    if (map[s.toUpperCase()]) return map[s.toUpperCase()];
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  };

  if (ovaIdxMatch) {
    spTypeTag = 'OVA';
    spTypeIndex = parseRomanOrInt(ovaIdxMatch[2]);
  } else if (recapIdxMatch) {
    spTypeTag = 'RECAP';
    spTypeIndex = parseRomanOrInt(recapIdxMatch[2]);
  } else if (spIdxMatch) {
    spTypeTag = 'SP';
    spTypeIndex = parseRomanOrInt(spIdxMatch[1]);
  }

  // 3. 剥离剧名、压制组标签、技术参数与 SP/S00E01 外壳，提取纯净的剧情/副标题描述词
  let cleaned = stripTechnicalNoiseKeepLang(combinedRaw)
    .replace(KNOWN_SUB_LANG_REGEX, ' ')
    .replace(/^\[[^\]]+\]\s*/, ' ');

  // 剥离已知发布组/压制组方括号（保留含中文剧情词的括号内容）
  cleaned = cleaned.replace(/\[([A-Za-z0-9._\-\s&]+)\]/g, (full, inner) => {
    if (/^(?:OVA|OAD|SP|Special|Recap)/i.test(inner.trim())) return ' ';
    if (/^[A-Za-z0-9._\-&\s]+$/.test(inner) && (/studio|sub|raw|rip|team|group|vcb|kissaten|ank|reinforce|lilith|sakurato|lollipop/i.test(inner) || inner.trim().length <= 10)) {
      return ' ';
    }
    return ` ${inner} `;
  });

  // 按长度降序剥离剧名候选（防止短剧名切碎长剧名）
  const sortedShowTitles = [...new Set(showTitles.filter((t) => t && String(t).trim().length >= 2))]
    .map((t) => String(t).trim())
    .sort((a, b) => b.length - a.length);

  for (const st of sortedShowTitles) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(st), 'gi'), ' ');
    const dotForm = toTitleCaseDots(st);
    if (dotForm && dotForm.length >= 2) {
      cleaned = cleaned.replace(new RegExp(escapeRegExp(dotForm), 'gi'), ' ');
      cleaned = cleaned.replace(new RegExp(escapeRegExp(dotForm.replace(/\./g, ' ')), 'gi'), ' ');
    }
  }

  // 剥离 S00E01 / SP01 / OVA01 / 第X话 / 年份 等编号外壳
  cleaned = cleaned
    .replace(/\bS0*0\s*E\d{1,3}(?:\.5)?(?:-E?\d{1,3})?\b/gi, ' ')
    .replace(/(?:^|[\s._\-\[(（【])(?:SP|OVA|OAD|Special|特别篇|特別篇|番外篇?)\s*(?:第\s*)?\d{0,3}(?:\.5)?(?:\s*[集话話期卷])?(?=$|[\s._\-\])）】:])/gi, ' ')
    .replace(/第\s*\d{1,3}(?:\.5)?\s*[集话話期]/g, ' ')
    .replace(/(?:^|[\s._\-\[(])(?:19|20)\d{2}(?=$|[\s._\-\])])/g, ' ')
    .replace(/[._\-\[\]()（）【】「」『』《》：:、，,。!！?？/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const rawTokens = cleaned.split(/\s+/).filter(Boolean);
  const descPhrases = [];
  for (const tok of rawTokens) {
    if (/^\d+$/.test(tok)) continue;
    if (/^[A-Za-z0-9]+$/.test(tok) && LATIN_STOP_WORDS.has(tok.toLowerCase())) continue;
    if (tok.length >= 2) {
      descPhrases.push(tok);
    }
  }

  const cjkBigrams = [];
  const seenBigrams = new Set();
  for (const phrase of descPhrases) {
    const cjkRuns = phrase.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const run of cjkRuns) {
      // 剥离常见尾部虚词如 "篇"（除非整词仅 2 字如 "温泉"）
      const coreRun = run.length >= 3 ? run.replace(/[篇集话話期版]$/, '') : run;
      if (coreRun.length === 2 && !CJK_STOP_BIGRAMS.has(coreRun) && !seenBigrams.has(coreRun)) {
        seenBigrams.add(coreRun);
        cjkBigrams.push(coreRun);
      } else if (coreRun.length >= 3) {
        for (let i = 0; i <= coreRun.length - 2; i += 1) {
          const bg = coreRun.slice(i, i + 2);
          if (!CJK_STOP_BIGRAMS.has(bg) && !seenBigrams.has(bg)) {
            seenBigrams.add(bg);
            cjkBigrams.push(bg);
          }
        }
      }
    }
  }

  const latinKeywords = [];
  const seenLatin = new Set();
  for (const phrase of descPhrases) {
    const words = phrase.match(/[A-Za-z]{3,}/g) || [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!LATIN_STOP_WORDS.has(lower) && !seenLatin.has(lower)) {
        seenLatin.add(lower);
        latinKeywords.push(lower);
      }
    }
  }

  const normDesc = normalizeTitleKey(descPhrases.join(''));
  const hasDescriptiveContent =
    descPhrases.length > 0 && (cjkBigrams.length > 0 || latinKeywords.length > 0 || normDesc.length >= 2);

  return {
    fractionalNums,
    innerEpNums,
    spTypeTag,
    spTypeIndex,
    descPhrases,
    cjkBigrams,
    latinKeywords,
    normDesc,
    hasDescriptiveContent,
  };
}

/**
 * 综合评估本地特别篇特征与单个 TMDB Season 0 剧集（含 title 与 overview 描述内容）的匹配得分
 */
export function scoreSpecialAgainstTmdbEpisode(features, spEp) {
  let score = 0;
  const matchedClues = [];

  if (!spEp._normCache) {
    const titleText = String(spEp.title || '').trim();
    const enTitleText = String(spEp.enTitle || '').trim();
    const overviewText = String(spEp.overview || '').trim();
    const enOverviewText = String(spEp.enOverview || '').trim();

    const isGenericEpTitle = (t = '') =>
      !t ||
      /^(?:第\s*\d+\s*[集话話期]|Episode\s*\d+|EP\s*\d+|Special\s*\d*|OVA\s*\d*|OAD\s*\d*|SP\s*\d*|特别篇|特別篇|番外篇?)$/i.test(
        t.trim()
      );

    const combinedRaw = [titleText, enTitleText, overviewText, enOverviewText]
      .filter(Boolean)
      .join(' ');
    spEp._normCache = {
      titleText,
      enTitleText,
      overviewText,
      enOverviewText,
      normTitle: isGenericEpTitle(titleText) ? '' : normalizeTitleKey(titleText),
      normEnTitle: isGenericEpTitle(enTitleText) ? '' : normalizeTitleKey(enTitleText),
      normOverview: normalizeTitleKey(overviewText),
      normCombined: normalizeTitleKey(combinedRaw),
      rawCombinedLower: combinedRaw.toLowerCase(),
      combinedRaw,
    };
  }

  const {
    titleText,
    enTitleText,
    overviewText,
    enOverviewText,
    normTitle,
    normEnTitle,
    normOverview,
    normCombined,
    rawCombinedLower,
    combinedRaw,
  } = spEp._normCache;

  // 1. 副标题与 TMDB 特别篇标题 (title) 匹配
  if (features.normDesc) {
    for (const [label, nTitle] of [
      [titleText, normTitle],
      [enTitleText, normEnTitle],
    ]) {
      if (!nTitle || nTitle.length < 2) continue;
      if (features.normDesc === nTitle) {
        score += 110;
        matchedClues.push(`标题完全吻合《${label}》`);
        break;
      }
      if (features.normDesc.includes(nTitle) && nTitle.length >= 2) {
        score += 85 + Math.min(20, nTitle.length * 3);
        matchedClues.push(`包含TMDB标题《${label}》`);
        break;
      }
      if (nTitle.includes(features.normDesc) && features.normDesc.length >= 2) {
        score += 80 + Math.min(20, features.normDesc.length * 3);
        matchedClues.push(`命中TMDB标题《${label}》`);
        break;
      }
    }
  }

  // 2. 描述短语在 TMDB 标题或简介 (overview) 中直接命中
  for (const rawPhrase of features.descPhrases) {
    const corePhrase = rawPhrase.length >= 3 ? rawPhrase.replace(/[篇集话話期版]$/, '') : rawPhrase;
    const normP = normalizeTitleKey(corePhrase);
    if (!normP || normP.length < 2) continue;
    // 纯英文短词交由下方单词边界规则匹配，避免 2~3 字母子串误命中
    if (/^[a-z0-9]+$/.test(normP) && normP.length < 4) continue;

    if ((normTitle && normTitle.includes(normP)) || (normEnTitle && normEnTitle.includes(normP))) {
      score += 55 + Math.min(20, normP.length * 3);
      matchedClues.push(`标题含"${corePhrase}"`);
    } else if (normOverview && normOverview.includes(normP)) {
      score += 50 + Math.min(20, normP.length * 3);
      matchedClues.push(`简介描述含"${corePhrase}"`);
    }
  }

  // 3. CJK 二元词组 (Bigrams) 在 TMDB 标题+简介描述中的覆盖率打分（解决如“温泉合宿篇”匹配简介“前往温泉旅馆进行合宿训练”）
  if (features.cjkBigrams.length > 0 && normCombined) {
    const hitBigrams = features.cjkBigrams.filter((bg) => normCombined.includes(bg));
    if (hitBigrams.length >= 2 || (hitBigrams.length === 1 && features.cjkBigrams.length === 1)) {
      const coverage = hitBigrams.length / features.cjkBigrams.length;
      score += hitBigrams.length * 20 + Math.round(coverage * 25);
      matchedClues.push(`描述关键词(${hitBigrams.slice(0, 4).join('/')})`);
    }
  }

  // 4. 英文/罗马音实义词在标题+简介中的词边界匹配
  if (features.latinKeywords.length > 0) {
    const hitWords = features.latinKeywords.filter((w) => {
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(w)}(?=$|[^a-z0-9])`, 'i');
      return re.test(rawCombinedLower);
    });
    if (hitWords.length > 0) {
      score += hitWords.length * 35;
      matchedClues.push(`英文特征词(${hitWords.slice(0, 3).join('/')})`);
    }
  }

  // 5. 特别篇类型与序号（如 OVA 1 / OAD 2 / 总集篇 1）在标题或简介中的精确匹配
  if (features.spTypeTag === 'OVA') {
    const hasOvaMention = /\b(?:OVA|OAD)\b|原创动画|单行本.*(?:捆绑|附赠|特典)|BD.*番外/i.test(
      combinedRaw
    );
    if (hasOvaMention) {
      score += 12;
      if (features.spTypeIndex !== null) {
        const idxRe = new RegExp(
          `(?:OVA|OAD)\\s*(?:第\\s*|#\\s*)?0*${features.spTypeIndex}(?=$|[^0-9])|第\\s*0*${features.spTypeIndex}\\s*[弹卷期]`,
          'i'
        );
        if (idxRe.test(combinedRaw)) {
          score += 55;
          matchedClues.push(`OVA序号#${features.spTypeIndex}`);
        }
      }
    }
  } else if (features.spTypeTag === 'RECAP') {
    const hasRecapMention = /总集篇|總集篇|回顾|Recap|Summary/i.test(combinedRaw);
    if (hasRecapMention) {
      score += 25;
      matchedClues.push('总集篇特征');
      if (features.spTypeIndex !== null) {
        const idxRe = new RegExp(
          `(?:总集篇|總集篇|Recap)\\s*(?:第\\s*|#\\s*)?0*${features.spTypeIndex}(?=$|[^0-9])`,
          'i'
        );
        if (idxRe.test(`${titleText} ${overviewText}`)) {
          score += 45;
          matchedClues.push(`总集篇序号#${features.spTypeIndex}`);
        }
      }
    }
  }

  return {
    episodeNumber: spEp.episodeNumber,
    ep: spEp,
    score,
    matchedClues,
  };
}

/**
 * 五级特别篇（Season 0 / SP / OVA / .5半集）智能语义与简介描述对齐器：
 * 1. 手动映射 (--sp-map) 最优先；
 * 2. Tier 1：显式 .5 半集号或番外话数（如 12.5、第25话）在 TMDB Season 0 标题或简介中精确穿透匹配；
 * 3. Tier 2 & 3：文件名副标题/描述词与 TMDB Season 0 标题 (title) + 剧情简介 (overview) 综合语义评分匹配；
 * 4. Tier 4：同源类型子集（如 OVA 1..N、总集篇 1..N）在 TMDB Season 0 对应类型子集内的序数对齐；
 * 5. Tier 5：防盲目命名熔断保护 —— 若无法匹配任何标题/描述，且本地特别篇数量与 TMDB Season 0 集数不一致（且未传 --trust-sp-num），拒绝无脑按 SP01->S00E01 推进，转入待确认列表。
 */
function createSpecialEpisodeResolver(
  tmdbMeta,
  { localSpecialVideoCount = 0, trustSpNum = false, spMap = null, showTitles = [] } = {}
) {
  const specialSeason = tmdbMeta?.specialSeason;
  const spEpisodes = Array.isArray(specialSeason?.episodes) ? specialSeason.episodes : [];
  const explicitMap = spMap instanceof Map ? spMap : parseExplicitSpMap(spMap);
  const usedSpecialNums = new Set();
  const fileResolutionCache = new Map();

  // 预计算 TMDB Season 0 中的 OVA 子集与总集篇子集（供 Tier 4 同类型序数对齐使用）
  const ovaSubset = spEpisodes.filter((ep) =>
    /\b(?:OVA|OAD)\b|原创动画|单行本.*(?:捆绑|附赠|特典)|BD.*番外/i.test(
      `${ep.title || ''} ${ep.overview || ''} ${ep.enTitle || ''} ${ep.enOverview || ''}`
    )
  );
  const recapSubset = spEpisodes.filter((ep) =>
    /总集篇|總集篇|回顾|Recap|Summary/i.test(
      `${ep.title || ''} ${ep.overview || ''} ${ep.enTitle || ''} ${ep.enOverview || ''}`
    )
  );

  return function resolveToSpecial(token, fileName = '', mappedGroup = null) {
    const normFileKey = `${mappedGroup?.relDir || ''}:${String(fileName || '').toLowerCase()}:${token.kind}:${token.epFloat ?? token.epStart}`;
    if (fileResolutionCache.has(normFileKey)) {
      return fileResolutionCache.get(normFileKey);
    }

    const commitMatch = (epNum, matchReason, matchedEpTitle = '') => {
      usedSpecialNums.add(epNum);
      const res = {
        matched: true,
        epStart: epNum,
        epEnd: epNum,
        matchReason,
        matchedEpTitle,
      };
      fileResolutionCache.set(normFileKey, res);
      return res;
    };

    const commitReject = (unmatchedReason) => {
      const res = {
        matched: false,
        isUnverifiedSpecial: true,
        unmatchedReason,
      };
      fileResolutionCache.set(normFileKey, res);
      return res;
    };

    const rawVal = token.epFloat !== undefined ? token.epFloat : token.epStart;

    // Step 0: 检查用户是否通过 --sp-map 显式指定了映射
    if (explicitMap.size > 0) {
      const stemLower = stripExtension(fileName).toLowerCase();
      const spKeyCandidates = [
        stemLower,
        `sp${String(rawVal).padStart(2, '0')}`,
        `sp${rawVal}`,
        `ova${String(rawVal).padStart(2, '0')}`,
        `ova${rawVal}`,
        `num:${rawVal}`,
      ];
      for (const k of spKeyCandidates) {
        if (explicitMap.has(k)) {
          const targetEp = explicitMap.get(k);
          const epObj = spEpisodes.find((e) => e.episodeNumber === targetEp);
          return commitMatch(
            targetEp,
            `手动指定映射 (--sp-map -> S00E${String(targetEp).padStart(2, '0')})`,
            epObj?.title || ''
          );
        }
      }
    }

    // 兼容未拉取单集详情列表的离线模式/Mock 测试：当 spEpisodes 为空时保持原集号或顺序分配
    if (spEpisodes.length === 0) {
      if (token.kind === 'fractional_episode') {
        const maxSp = specialSeason?.episodeCount || 99;
        for (let candidate = 1; candidate <= maxSp; candidate += 1) {
          if (!usedSpecialNums.has(candidate)) {
            return commitMatch(candidate, '特别篇半集离线顺序分配');
          }
        }
      }
      if (Number.isInteger(token.epStart) && token.epStart >= 1) {
        return commitMatch(token.epStart, '特别篇序号直接映射 (未加载TMDB分集详情)');
      }
      return null;
    }

    const features = extractSpecialDescriptiveFeatures(fileName, mappedGroup?.relDir || '', showTitles);

    // Tier 1: 显式半集号 (如 12.5 / 04.5) 或番外话数 (如 第25话) 在 TMDB Season 0 标题或简介中精确穿透匹配
    const candidateNumLabels = [];
    if (token.epFloat !== undefined) {
      candidateNumLabels.push(String(token.epFloat));
      if (mappedGroup?.epOffset > 0 && token.epFloat < mappedGroup.epOffset) {
        candidateNumLabels.push(String(token.epFloat + mappedGroup.epOffset));
      }
    }
    for (const fn of features.fractionalNums) {
      if (!candidateNumLabels.includes(String(fn))) candidateNumLabels.push(String(fn));
    }
    for (const inNum of features.innerEpNums) {
      if (!candidateNumLabels.includes(String(inNum))) candidateNumLabels.push(String(inNum));
    }
    // 若是季末溢出番外（如 24 集正片后的第 25 话），将溢出集号纳入检索
    if (token.kind !== 'special' && token.kind !== 'fractional_episode' && token.epStart > 1) {
      const shifted = token.epStart + (mappedGroup?.epOffset || 0);
      if (!candidateNumLabels.includes(String(shifted))) candidateNumLabels.push(String(shifted));
    }

    for (const label of candidateNumLabels) {
      // 针对整数标签（如 25），要求 TMDB 标题/简介中带有话数/集号上下文或精确小数，防止匹配到日期“25日”或“25周年”
      const isDecimal = label.includes('.');
      const strictNumRe = isDecimal
        ? new RegExp(`(?:^|[^0-9.])0*${escapeRegExp(label)}(?=$|[^0-9.])`, 'i')
        : new RegExp(
            `(?:第\\s*0*${escapeRegExp(label)}\\s*[集话話期]|(?:EP|Episode|#)\\s*0*${escapeRegExp(label)}(?=$|[^0-9.]))`,
            'i'
          );

      const hit =
        spEpisodes.find((ep) => strictNumRe.test(`${ep.title || ''} ${ep.enTitle || ''}`)) ||
        spEpisodes.find((ep) => strictNumRe.test(`${ep.overview || ''} ${ep.enOverview || ''}`));
      if (hit) {
        return commitMatch(
          hit.episodeNumber,
          `TMDB特别篇话数/简介精确匹配 (#${label} -> S00E${String(hit.episodeNumber).padStart(2, '0')}《${hit.title}》)`,
          hit.title
        );
      }
    }

    // Tier 2 & Tier 3: 文件名副标题/描述词与 TMDB Season 0 标题 (title) + 描述内容 (overview) 综合评分匹配
    if (features.hasDescriptiveContent || features.spTypeTag === 'OVA' || features.spTypeTag === 'RECAP') {
      const scored = spEpisodes
        .map((ep) => scoreSpecialAgainstTmdbEpisode(features, ep))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          // 分数相同时优先选择尚未被占用的集号
          const aUsed = usedSpecialNums.has(a.episodeNumber) ? 1 : 0;
          const bUsed = usedSpecialNums.has(b.episodeNumber) ? 1 : 0;
          return aUsed - bUsed;
        });

      const best = scored[0];
      const second = scored[1];
      if (best && best.score >= 40) {
        const isUnambiguous = !second || best.score >= second.score + 12 || second.score < 40;
        if (isUnambiguous) {
          const clueText = best.matchedClues.slice(0, 2).join('，');
          return commitMatch(
            best.episodeNumber,
            `TMDB特别篇语义/描述匹配 (S00E${String(best.episodeNumber).padStart(2, '0')}《${best.ep.title}》| ${clueText})`,
            best.ep.title
          );
        }
      }
    }

    // Tier 4: 同类型子集序数对齐（例如文件名为纯 OVA1、OVA2，而 TMDB Season 0 简介中恰标注了哪些集是 OVA）
    if (features.spTypeTag === 'OVA' && features.spTypeIndex !== null && ovaSubset.length > 0) {
      if (features.spTypeIndex >= 1 && features.spTypeIndex <= ovaSubset.length) {
        const targetEp = ovaSubset[features.spTypeIndex - 1];
        return commitMatch(
          targetEp.episodeNumber,
          `TMDB特别篇OVA子集序号对齐 (OVA#${features.spTypeIndex} -> S00E${String(targetEp.episodeNumber).padStart(2, '0')}《${targetEp.title}》)`,
          targetEp.title
        );
      }
    }
    if (features.spTypeTag === 'RECAP' && features.spTypeIndex !== null && recapSubset.length > 0) {
      if (features.spTypeIndex >= 1 && features.spTypeIndex <= recapSubset.length) {
        const targetEp = recapSubset[features.spTypeIndex - 1];
        return commitMatch(
          targetEp.episodeNumber,
          `TMDB特别篇总集篇子集对齐 (总集篇#${features.spTypeIndex} -> S00E${String(targetEp.episodeNumber).padStart(2, '0')}《${targetEp.title}》)`,
          targetEp.title
        );
      }
    }

    // Tier 5: 防无脑命名置信度门禁（拒绝盲目将不匹配的 SP01 改为 S00E01）
    const canFallbackByCount =
      localSpecialVideoCount > 0 &&
      localSpecialVideoCount === spEpisodes.length &&
      !features.descriptiveOnly &&
      Number.isInteger(token.epStart) &&
      token.epStart >= 1 &&
      token.epStart <= spEpisodes.length;

    if (trustSpNum || canFallbackByCount) {
      if (Number.isInteger(token.epStart) && token.epStart >= 1) {
        const epObj = spEpisodes.find((e) => e.episodeNumber === token.epStart) || spEpisodes[token.epStart - 1];
        const targetNum = epObj ? epObj.episodeNumber : token.epStart;
        const reason = trustSpNum
          ? `显式开启 --trust-sp-num 按序号对齐 (S00E${String(targetNum).padStart(2, '0')})`
          : `特别篇总集数与TMDB完全一致 (${spEpisodes.length}集) 按序号对齐`;
        return commitMatch(targetNum, reason, epObj?.title || '');
      }
    }

    const spPreviewHint = spEpisodes
      .slice(0, 6)
      .map((e) => `S00E${String(e.episodeNumber).padStart(2, '0')}:${e.title}`)
      .join(' / ');
    return commitReject(
      `特别篇文件名与 TMDB Season 0 的标题及简介描述均未匹配（TMDB 含 ${spEpisodes.length} 个特别篇 [${spPreviewHint}${spEpisodes.length > 6 ? ' ...' : ''}]，已拦截无脑按 SP 序号改名；可核对后传 --sp-map "原名=集号" 或 --trust-sp-num）`
    );
  };
}

/**
 * 构建完整的 TMDB 归类与重命名计划（纯函数）
 * 支持：
 * - 本地子文件夹与 TMDB 季度结构不一致时自动按 TMDB 季度重新分类（含分割放送 承/转/结、Part 1/2、多篇章合并季、错误 Season 拆分季）；
 * - 默认季文件夹采用三大 NAS（绿联影视中心、极空间极影视、飞牛影视）100% 聚合兼容的标准 "Season 01" / "Specials"；当显式传入 useTmdbSeasonNames 或自定义 "--season-pattern" 时支持 TMDB 官方季名；
 * - 特别篇（Season 0）支持基于文件名与 TMDB 标题 + 简介描述（Overview）的五级智能对齐与防盲推拦截。
 */
export function buildOrganizationPlan({
  files,
  tmdbMeta,
  filePattern = '{Standard}',
  filePatternExplicit = false,
  seasonPattern = 'Season {Season}',
  seasonPatternExplicit = false,
  useTmdbSeasonNames = false,
  folderPattern = '{Title}（{Year}）',
  withTitle = false,
  explicitOffset = null,
  trustSpNum = false,
  spMap = null,
  maxArchiveSizeMB = 300,
}) {
  const canonicalSeriesTitle = buildCanonicalSeriesTitle(tmdbMeta, files);
  const suggestedFolderName = formatResourceFolderName({
    showTitle: tmdbMeta?.showTitle,
    originalTitle: tmdbMeta?.originalTitle,
    year: tmdbMeta?.year ?? (tmdbMeta?.regularSeasons?.[0]?.year ?? null),
    folderPattern,
  });
  const showTitleCandidates = [
    tmdbMeta?.showTitle,
    tmdbMeta?.originalTitle,
    tmdbMeta?.userQuery,
    canonicalSeriesTitle,
    ...canonicalSeriesTitle.split('.'),
  ].filter(Boolean);

  const videoFiles = [];
  const subtitleFiles = [];
  const detectedArchives = [];
  const skippedBonus = [];
  const ignoredOther = [];

  for (const file of files) {
    const ext = getExtension(file.name);
    if (VIDEO_EXTENSIONS.has(ext)) {
      if (isBonusClip(file.name)) {
        skippedBonus.push({ ...file, reason: '特典/OP/ED/PV 花絮保护跳过' });
      } else {
        videoFiles.push({ ...file, ext });
      }
    } else if (SUBTITLE_EXTENSIONS.has(ext)) {
      if (isBonusClip(file.name)) {
        skippedBonus.push({ ...file, reason: '特典/OP/ED/PV 字幕保护跳过' });
      } else {
        subtitleFiles.push({ ...file, ext });
      }
    } else if (isSubtitleArchiveCandidate(file, { maxArchiveSizeMB })) {
      detectedArchives.push({ ...file, ext });
    } else {
      ignoredOther.push(file);
    }
  }

  const activeStrategy = subtitleFiles.length > 0 ? 'MODE_2_SUBTITLE_LINKED' : 'MODE_1_VIDEO_ONLY';

  const parsedVideos = videoFiles.map((v) => ({
    ...v,
    token: parseEpisodeToken(v.name, tmdbMeta.showTitle),
  }));

  // 检测子文件夹分类是否与 TMDB 季度存在不一致，并构建重分类映射表
  const reclassification = buildSubfolderReclassificationMap(parsedVideos, tmdbMeta);

  // 为保证绿联影视中心、极空间（极影视）、飞牛影视三大 NAS 平台 100% 聚合不拆剧，
  // 默认季目录统一采用标准 "Season 01" / "Specials"；仅当用户显式开启 --tmdb-season-names 或自定义 --season-pattern 时采用 TMDB 季名
  const effectiveSeasonPattern = useTmdbSeasonNames ? '{TmdbSeason}' : seasonPattern;

  const unmappedVideosForOffset = reclassification.isMismatched
    ? parsedVideos.filter((v) => !findMappedGroupForPath(v.relativeDir || '', reclassification.groupMappings))
    : parsedVideos;
  const offsetInfo = inferGlobalEpisodeOffset(unmappedVideosForOffset, tmdbMeta, explicitOffset);
  const offset = offsetInfo.offset;

  // 统计本地属于特别篇范畴的视频总数，用于五级特别篇匹配器的置信度判断
  const localSpecialVideoCount = parsedVideos.filter((v) => {
    if (!v.token) return false;
    if (v.token.kind === 'special' || v.token.kind === 'fractional_episode') return true;
    const mg = reclassification.isMismatched
      ? findMappedGroupForPath(v.relativeDir || '', reclassification.groupMappings)
      : null;
    if (mg && mg.seasonNumber === 0) return true;
    const pSeason = inferSeasonFromDirPath(v.relativeDir || '', v.parentFolderName || '');
    return pSeason === 0;
  }).length;

  const resolveSpecialEp = createSpecialEpisodeResolver(tmdbMeta, {
    localSpecialVideoCount,
    trustSpNum,
    spMap,
    showTitles: showTitleCandidates,
  });

  // 检测扁平根目录（!relativeDir）是否存在伪拆季命名（例如根目录平铺 S01E01..12 与 S02E01..12），而 TMDB 实际为单季连续放送（例如 Season 1 共有 24 集，无独立 Season 2）
  const flatSeasonMappings = new Map();
  const flatSeasonVideos = parsedVideos.filter(
    (v) => !v.relativeDir && v.token?.kind === 'season_episode'
  );
  if (flatSeasonVideos.length > 0) {
    const seasonsMap = new Map();
    for (const v of flatSeasonVideos) {
      const s = v.token.season;
      if (!seasonsMap.has(s)) seasonsMap.set(s, []);
      seasonsMap.get(s).push(v);
    }

    if (seasonsMap.size >= 2) {
      const sortedSeasons = [...seasonsMap.keys()].sort((a, b) => a - b);
      const tmdbS1 = tmdbMeta.regularSeasons.find((s) => s.seasonNumber === 1);
      const tmdbHasS2 = tmdbMeta.regularSeasons.some((s) => s.seasonNumber === 2);

      // 如果 TMDB 只有 Season 1（没有 Season 2），或者 TMDB 仅有 1 个正片季度，且 TMDB 第 1 季集数能够容纳这些扁平季
      if (tmdbS1 && (!tmdbHasS2 || tmdbMeta.regularSeasons.length === 1)) {
        let cumulativeOffset = 0;
        for (const sNum of sortedSeasons) {
          const vList = seasonsMap.get(sNum);
          if (sNum === 1) {
            cumulativeOffset += vList.length;
          } else {
            if (cumulativeOffset + vList.length <= tmdbS1.episodeCount + 2) {
              flatSeasonMappings.set(sNum, {
                targetSeasonNumber: 1,
                epOffset: cumulativeOffset,
                targetSeason: tmdbS1,
              });
              cumulativeOffset += vList.length;
            }
          }
        }
      }
    }
  }

  const unmatchedFiles = [];
  const resolvedVideoItems = [];
  const videoByEpisodeKey = new Map();
  const videoByRawSpKey = new Map();
  const rejectedRawSpKeys = new Set();

  function buildFolderForSeason(seasonNum, tmdbSeasonObj) {
    return formatSeasonFolderName({
      seasonNumber: seasonNum,
      seasonTitle: tmdbSeasonObj?.seasonTitle ?? '',
      canonicalFolderName: tmdbSeasonObj?.canonicalFolderName ?? '',
      showTitle: tmdbMeta.showTitle,
      seasonPattern: effectiveSeasonPattern,
    });
  }

  function buildSpecialTarget(spEpStart, spEpEnd = spEpStart, extra = {}) {
    return {
      seasonNumber: 0,
      folderName: buildFolderForSeason(0, tmdbMeta.specialSeason),
      epStart: spEpStart,
      epEnd: spEpEnd,
      seasonEpisodeCount: tmdbMeta.specialSeason?.episodeCount ?? 99,
      seasonTitle: tmdbMeta.specialSeason?.seasonTitle ?? '特别篇',
      canonicalFolderName: tmdbMeta.specialSeason?.canonicalFolderName ?? '特别篇',
      year: tmdbMeta.specialSeason?.year ?? null,
      matchReason: extra.matchReason || '',
      matchedEpTitle: extra.matchedEpTitle || '',
    };
  }

  function resolveSpecialResultToTarget(spRes) {
    if (!spRes) return null;
    if (spRes.matched) {
      return buildSpecialTarget(spRes.epStart, spRes.epEnd, spRes);
    }
    return {
      unmatchedReason: spRes.unmatchedReason,
      isUnverifiedSpecial: Boolean(spRes.isUnverifiedSpecial),
    };
  }

  function resolveTokenToTarget(token, relativeDir = '', parentFolderHint = '', rawFileName = '') {
    const mappedGroup = reclassification.isMismatched
      ? findMappedGroupForPath(relativeDir, reclassification.groupMappings)
      : null;

    // 1. 优先处理 .5 半集番外（如 12.5 / 04.5 / 13.5 / 19.5）-> 归入 TMDB Season 0 特别篇
    if (token.kind === 'fractional_episode') {
      const spRes = resolveSpecialEp(token, rawFileName, mappedGroup);
      return resolveSpecialResultToTarget(spRes);
    }

    // 2. 若所属目录命中了 TMDB 季度重分类映射（如 ×承 / ×转 / ×结 / 篇章目录 / 错误拆分的 Season 03..04）
    if (mappedGroup) {
      if (mappedGroup.seasonNumber === 0) {
        const spRes = resolveSpecialEp(token, rawFileName, mappedGroup);
        return resolveSpecialResultToTarget(spRes);
      }

      if (mappedGroup.overflowFold) {
        const gStart = (mappedGroup.baseGlobalOffset || 0) + token.epStart;
        const gEnd = (mappedGroup.baseGlobalOffset || 0) + token.epEnd;
        const startFolded = foldGlobalEpisodeToSeason(gStart, tmdbMeta.regularSeasons);
        if (!startFolded) return null;
        const endFolded =
          gEnd > gStart ? foldGlobalEpisodeToSeason(gEnd, tmdbMeta.regularSeasons) : startFolded;
        const endEp =
          endFolded && endFolded.seasonNumber === startFolded.seasonNumber
            ? endFolded.episodeInSeason
            : startFolded.episodeInSeason + (gEnd - gStart);
        const ms = tmdbMeta.regularSeasons.find((s) => s.seasonNumber === startFolded.seasonNumber);
        return {
          seasonNumber: startFolded.seasonNumber,
          folderName: buildFolderForSeason(startFolded.seasonNumber, ms),
          epStart: startFolded.episodeInSeason,
          epEnd: endEp,
          seasonEpisodeCount: startFolded.seasonEpisodeCount,
          seasonTitle: startFolded.seasonTitle,
          canonicalFolderName: ms?.canonicalFolderName ?? '',
          year: startFolded.year,
        };
      }

      const targetSeason = tmdbMeta.regularSeasons.find(
        (s) => s.seasonNumber === mappedGroup.seasonNumber
      );
      if (targetSeason) {
        let epShift = mappedGroup.epOffset || 0;
        // 兼容子目录内文件本身已按季内延续集号（如 ×转 内直接标 13..24）或全剧总集号（如 37..48）命名的情况
        if (mappedGroup.minRegularEp !== null && mappedGroup.minRegularEp > 1) {
          if (mappedGroup.minRegularEp === epShift + 1) {
            epShift = 0;
          } else if (mappedGroup.minRegularEp === targetSeason.globalStart + epShift) {
            epShift = -(targetSeason.globalStart - 1);
          }
        }

        const newStart = token.epStart + epShift;
        const newEnd = token.epEnd + epShift;
        const finalStart = getTmdbSeasonEpisodeNumber(targetSeason, newStart);
        const finalEnd = getTmdbSeasonEpisodeNumber(targetSeason, newEnd);
        const maxAllowedEp = Math.max(
          targetSeason.episodeCount,
          targetSeason.endEpisodeNumber ?? targetSeason.episodeCount
        );

        if (finalStart >= 1 && finalEnd <= maxAllowedEp) {
          return {
            seasonNumber: targetSeason.seasonNumber,
            folderName: buildFolderForSeason(targetSeason.seasonNumber, targetSeason),
            epStart: finalStart,
            epEnd: finalEnd,
            seasonEpisodeCount: targetSeason.episodeCount,
            seasonTitle: targetSeason.seasonTitle,
            canonicalFolderName: targetSeason.canonicalFolderName ?? '',
            year: targetSeason.year,
          };
        }

        // 若单季 BD 目录末尾附带了超出正片集数的少量番外话（例如 24 集正片目录里的第 25 话），自动对齐至 Season 0 特别篇
        if (
          newStart > targetSeason.episodeCount &&
          newStart <= targetSeason.episodeCount + 4 &&
          tmdbMeta.specialSeason
        ) {
          const spRes = resolveSpecialEp(token, rawFileName, mappedGroup);
          if (spRes?.matched) {
            return resolveSpecialResultToTarget(spRes);
          }
        }
      }
    }

    // 3. 常规标准目录与扁平文件解析逻辑
    if (token.kind === 'global_episode') {
      const pSeason = inferSeasonFromDirPath(relativeDir, parentFolderHint);
      if (pSeason !== null) {
        if (pSeason === 0) {
          const spRes = resolveSpecialEp(token, rawFileName, mappedGroup);
          return resolveSpecialResultToTarget(spRes);
        }
        const targetSeason = tmdbMeta.regularSeasons.find((s) => s.seasonNumber === pSeason);
        if (targetSeason) {
          const finalStart = getTmdbSeasonEpisodeNumber(targetSeason, token.epStart);
          const finalEnd = getTmdbSeasonEpisodeNumber(targetSeason, token.epEnd);
          const maxAllowedEp = Math.max(
            targetSeason.episodeCount,
            targetSeason.endEpisodeNumber ?? targetSeason.episodeCount
          );
          if (finalStart >= 1 && finalEnd <= maxAllowedEp) {
            return {
              seasonNumber: pSeason,
              folderName: buildFolderForSeason(pSeason, targetSeason),
              epStart: finalStart,
              epEnd: finalEnd,
              seasonEpisodeCount: targetSeason.episodeCount,
              seasonTitle: targetSeason.seasonTitle,
              canonicalFolderName: targetSeason.canonicalFolderName ?? '',
              year: targetSeason.year,
            };
          }
        }
      }
    }

    if (token.kind === 'special') {
      const spRes = resolveSpecialEp(token, rawFileName, mappedGroup);
      return resolveSpecialResultToTarget(spRes);
    }

    if (token.kind === 'season_episode') {
      // 1. 优先尝试单集标题 Ground Truth 精确跨季对齐（杜绝资源 S02E01 假标，实为 TMDB S01E13）
      const titleMatch = findBestEpisodeTitleMatch(rawFileName, tmdbMeta.regularSeasons);
      if (titleMatch) {
        const tSeason = titleMatch.season;
        const epSpan = Math.max(0, token.epEnd - token.epStart);
        return {
          seasonNumber: tSeason.seasonNumber,
          folderName: buildFolderForSeason(tSeason.seasonNumber, tSeason),
          epStart: titleMatch.episodeNumber,
          epEnd: titleMatch.episodeNumber + epSpan,
          seasonEpisodeCount: tSeason.episodeCount,
          seasonTitle: tSeason.seasonTitle,
          canonicalFolderName: tSeason.canonicalFolderName ?? '',
          year: tSeason.year,
        };
      }

      // 2. 扁平根目录下拆季（如根目录下混放 S01E01..12 与 S02E01..12，但 TMDB 实际为单季连续 24 集）
      if (flatSeasonMappings.has(token.season)) {
        const mapping = flatSeasonMappings.get(token.season);
        const tSeason = mapping.targetSeason;
        const mappedStart = token.epStart + mapping.epOffset;
        const mappedEnd = token.epEnd + mapping.epOffset;
        const finalStart = getTmdbSeasonEpisodeNumber(tSeason, mappedStart);
        const finalEnd = getTmdbSeasonEpisodeNumber(tSeason, mappedEnd);
        return {
          seasonNumber: mapping.targetSeasonNumber,
          folderName: buildFolderForSeason(mapping.targetSeasonNumber, tSeason),
          epStart: finalStart,
          epEnd: finalEnd,
          seasonEpisodeCount: tSeason.episodeCount,
          seasonTitle: tSeason.seasonTitle,
          canonicalFolderName: tSeason.canonicalFolderName ?? '',
          year: tSeason.year,
        };
      }

      let matchedSeason = tmdbMeta.regularSeasons.find((s) => s.seasonNumber === token.season);
      let effectiveSeasonNum = token.season;
      let rawEpStart = token.epStart;
      let rawEpEnd = token.epEnd;

      // 若本地标 S02，但 TMDB 仅有 Season 1（例如 24 集长篇未在 TMDB 拆第二季），自动折算回 Season 1 Cour 2
      if (!matchedSeason && token.season === 2 && tmdbMeta.regularSeasons.length === 1) {
        const s1 = tmdbMeta.regularSeasons[0];
        if (s1.seasonNumber === 1 && s1.episodeCount >= 20) {
          matchedSeason = s1;
          effectiveSeasonNum = 1;
          const courOffset = s1.episodeCount >= 24 ? 12 : Math.floor(s1.episodeCount / 2);
          rawEpStart = token.epStart + courOffset;
          rawEpEnd = token.epEnd + courOffset;
        }
      }

      // 根据 TMDB 页面官方单集编号规范获取真实集号（若 TMDB Season 2 标 13 起始，则 S02E01 输出 S02E13）
      const finalEpStart = matchedSeason
        ? getTmdbSeasonEpisodeNumber(matchedSeason, rawEpStart)
        : rawEpStart;
      const finalEpEnd = matchedSeason
        ? getTmdbSeasonEpisodeNumber(matchedSeason, rawEpEnd)
        : rawEpEnd;

      return {
        seasonNumber: effectiveSeasonNum,
        folderName: buildFolderForSeason(effectiveSeasonNum, matchedSeason),
        epStart: finalEpStart,
        epEnd: finalEpEnd,
        seasonEpisodeCount: matchedSeason?.episodeCount ?? 99,
        seasonTitle: matchedSeason?.seasonTitle ?? '',
        canonicalFolderName: matchedSeason?.canonicalFolderName ?? '',
        year: matchedSeason?.year ?? null,
      };
    }

    if (token.kind === 'global_episode') {
      const adjStart = token.epStart + offset;
      const adjEnd = token.epEnd + offset;
      if (adjStart < 1) return null;

      const startFolded = foldGlobalEpisodeToSeason(adjStart, tmdbMeta.regularSeasons);
      if (!startFolded) {
        if (
          tmdbMeta.specialSeason &&
          adjStart > tmdbMeta.totalRegularEpisodes &&
          adjStart <= tmdbMeta.totalRegularEpisodes + (tmdbMeta.specialSeason.episodeCount || 4)
        ) {
          const spRes = resolveSpecialEp(token, rawFileName, mappedGroup);
          if (spRes?.matched) {
            return resolveSpecialResultToTarget(spRes);
          }
          const spOffset = adjStart - tmdbMeta.totalRegularEpisodes;
          const spEndOffset = adjEnd - tmdbMeta.totalRegularEpisodes;
          return buildSpecialTarget(spOffset, spEndOffset);
        }
        return null;
      }

      let endEpInSeason = startFolded.episodeInSeason;
      if (adjEnd > adjStart) {
        const endFolded = foldGlobalEpisodeToSeason(adjEnd, tmdbMeta.regularSeasons);
        if (endFolded && endFolded.seasonNumber === startFolded.seasonNumber) {
          endEpInSeason = endFolded.episodeInSeason;
        } else {
          endEpInSeason = startFolded.episodeInSeason + (adjEnd - adjStart);
        }
      }

      const matchedSeason = tmdbMeta.regularSeasons.find(
        (s) => s.seasonNumber === startFolded.seasonNumber
      );
      const finalEpStart = matchedSeason
        ? getTmdbSeasonEpisodeNumber(matchedSeason, startFolded.episodeInSeason)
        : startFolded.episodeInSeason;
      const finalEpEnd = matchedSeason
        ? getTmdbSeasonEpisodeNumber(matchedSeason, endEpInSeason)
        : endEpInSeason;

      return {
        seasonNumber: startFolded.seasonNumber,
        folderName: buildFolderForSeason(startFolded.seasonNumber, matchedSeason),
        epStart: finalEpStart,
        epEnd: finalEpEnd,
        seasonEpisodeCount: startFolded.seasonEpisodeCount,
        seasonTitle: startFolded.seasonTitle,
        canonicalFolderName: matchedSeason?.canonicalFolderName ?? '',
        year: startFolded.year,
      };
    }

    return null;
  }

  for (const v of parsedVideos) {
    if (!v.token) {
      unmatchedFiles.push({ ...v, reason: '未能从视频文件名识别出有效集数' });
      continue;
    }

    const resolved = resolveTokenToTarget(
      v.token,
      v.relativeDir || '',
      v.parentFolderName || '',
      v.name
    );
    if (!resolved || resolved.unmatchedReason) {
      if (resolved?.isUnverifiedSpecial && v.token.epStart !== undefined) {
        rejectedRawSpKeys.add(`${v.relativeDir || ''}:sp:${v.token.epFloat ?? v.token.epStart}`);
        rejectedRawSpKeys.add(`*:sp:${v.token.epFloat ?? v.token.epStart}`);
      }
      unmatchedFiles.push({
        ...v,
        isUnverifiedSpecial: Boolean(resolved?.isUnverifiedSpecial),
        reason:
          resolved?.unmatchedReason ||
          `折算后集号越界（超出 TMDB 正片上限 ${tmdbMeta.totalRegularEpisodes} 集）`,
      });
      continue;
    }

    const origStem = stripExtension(v.name);
    const releaseInfo = extractReleasePayload(origStem, {
      showTitles: showTitleCandidates,
    });

    const baseName = formatMediaBaseName({
      seasonNumber: resolved.seasonNumber,
      epStart: resolved.epStart,
      epEnd: resolved.epEnd,
      seasonEpisodeCount: resolved.seasonEpisodeCount,
      showTitle: tmdbMeta.showTitle,
      canonicalSeriesTitle,
      seasonTitle: resolved.seasonTitle,
      canonicalFolderName: resolved.canonicalFolderName,
      year: resolved.year ?? tmdbMeta.year,
      origStem,
      filePattern,
      filePatternExplicit,
      withTitle,
      releaseInfo,
    });

    const newName = `${baseName}.${v.ext}`;
    const item = {
      id: v.id,
      parentId: v.parentId,
      sourceRelDir: v.relativeDir || '',
      oldName: v.name,
      newName,
      mediaType: 'video',
      ext: v.ext,
      seasonNumber: resolved.seasonNumber,
      targetFolderName: resolved.folderName,
      epStart: resolved.epStart,
      epEnd: resolved.epEnd,
      matchReason: resolved.matchReason || '',
      matchedEpTitle: resolved.matchedEpTitle || '',
      baseName,
      stemLower: stripExtension(v.name).toLowerCase(),
    };

    resolvedVideoItems.push(item);
    const epKey = `${resolved.seasonNumber}:${resolved.epStart}-${resolved.epEnd}`;
    if (!videoByEpisodeKey.has(epKey)) {
      videoByEpisodeKey.set(epKey, item);
    }
    if (resolved.seasonNumber === 0 && v.token.epStart !== undefined) {
      const rawSpNum = v.token.epFloat ?? v.token.epStart;
      videoByRawSpKey.set(`${v.relativeDir || ''}:sp:${rawSpNum}`, item);
      if (!videoByRawSpKey.has(`*:sp:${rawSpNum}`)) {
        videoByRawSpKey.set(`*:sp:${rawSpNum}`, item);
      }
    }
  }

  const resolvedSubtitleItems = [];
  if (activeStrategy === 'MODE_2_SUBTITLE_LINKED') {
    const videosByStemDesc = [...resolvedVideoItems].sort(
      (a, b) => b.stemLower.length - a.stemLower.length
    );
    const draftOrgSubs = [];

    for (const sub of subtitleFiles) {
      const subStemLower = stripExtension(sub.name).toLowerCase();
      const subMappedGroup = reclassification.isMismatched
        ? findMappedGroupForPath(sub.relativeDir || '', reclassification.groupMappings)
        : null;
      const subEffectiveSeason = subMappedGroup
        ? subMappedGroup.seasonNumber
        : inferSeasonFromDirPath(sub.relativeDir || '', sub.parentFolderName || '');

      const stemCandidates = videosByStemDesc.filter((v) => {
        if (!subStemLower.startsWith(v.stemLower)) return false;
        if (subStemLower.length === v.stemLower.length) return true;
        const nextChar = subStemLower[v.stemLower.length];
        return /[._\-\s\[（(【]/.test(nextChar);
      });

      let pairedVideo =
        stemCandidates.find((v) => String(v.parentId) === String(sub.parentId)) || null;

      if (!pairedVideo && stemCandidates.length > 0) {
        if (subMappedGroup) {
          const sameGroupHits = stemCandidates.filter(
            (v) =>
              findMappedGroupForPath(v.sourceRelDir || '', reclassification.groupMappings)
                ?.relDir === subMappedGroup.relDir
          );
          if (sameGroupHits.length === 1) {
            pairedVideo = sameGroupHits[0];
          }
        }
        if (!pairedVideo) {
          const seasonCompatible =
            subEffectiveSeason !== null
              ? stemCandidates.filter((v) => v.seasonNumber === subEffectiveSeason)
              : stemCandidates;
          if (seasonCompatible.length === 1) {
            pairedVideo = seasonCompatible[0];
          }
        }
      }

      let resolved = null;
      if (pairedVideo) {
        resolved = {
          seasonNumber: pairedVideo.seasonNumber,
          folderName: pairedVideo.targetFolderName,
          epStart: pairedVideo.epStart,
          epEnd: pairedVideo.epEnd,
          baseName: pairedVideo.baseName,
        };
      } else {
        const subToken = parseEpisodeToken(sub.name, tmdbMeta.showTitle);
        if (!subToken) {
          unmatchedFiles.push({ ...sub, reason: '未能从外挂字幕文件名识别出集数' });
          continue;
        }

        // 若字幕为特别篇（如 SP01.ass，自身不含副标题），优先跟随同目录或全局已成功语义匹配的 SP01 视频
        const isSubSpecial =
          subToken.kind === 'special' ||
          subToken.kind === 'fractional_episode' ||
          subEffectiveSeason === 0;
        if (isSubSpecial && subToken.epStart !== undefined) {
          const rawSpNum = subToken.epFloat ?? subToken.epStart;
          const spVideoHit =
            videoByRawSpKey.get(`${sub.relativeDir || ''}:sp:${rawSpNum}`) ||
            videoByRawSpKey.get(`*:sp:${rawSpNum}`) ||
            null;
          if (spVideoHit) {
            pairedVideo = spVideoHit;
            resolved = {
              seasonNumber: spVideoHit.seasonNumber,
              folderName: spVideoHit.targetFolderName,
              epStart: spVideoHit.epStart,
              epEnd: spVideoHit.epEnd,
              baseName: spVideoHit.baseName,
            };
          } else if (
            rejectedRawSpKeys.has(`${sub.relativeDir || ''}:sp:${rawSpNum}`) ||
            rejectedRawSpKeys.has(`*:sp:${rawSpNum}`)
          ) {
            unmatchedFiles.push({
              ...sub,
              isUnverifiedSpecial: true,
              reason: '对应特别篇视频未通过 TMDB 标题/描述匹配，关联外挂字幕同步跳过防错配',
            });
            continue;
          }
        }

        if (!resolved) {
          const subTarget = resolveTokenToTarget(
            subToken,
            sub.relativeDir || '',
            sub.parentFolderName || '',
            sub.name
          );
          if (!subTarget || subTarget.unmatchedReason) {
            unmatchedFiles.push({
              ...sub,
              isUnverifiedSpecial: Boolean(subTarget?.isUnverifiedSpecial),
              reason:
                subTarget?.unmatchedReason ||
                `字幕折算集号越界（超出 TMDB 正片上限 ${tmdbMeta.totalRegularEpisodes} 集）`,
            });
            continue;
          }
          const epKey = `${subTarget.seasonNumber}:${subTarget.epStart}-${subTarget.epEnd}`;
          pairedVideo = videoByEpisodeKey.get(epKey) ?? null;
          const subStem = stripExtension(sub.name);
          const subReleaseInfo = extractReleasePayload(subStem, {
            showTitles: showTitleCandidates,
          });
          const baseName =
            pairedVideo?.baseName ??
            formatMediaBaseName({
              seasonNumber: subTarget.seasonNumber,
              epStart: subTarget.epStart,
              epEnd: subTarget.epEnd,
              seasonEpisodeCount: subTarget.seasonEpisodeCount,
              showTitle: tmdbMeta.showTitle,
              canonicalSeriesTitle,
              seasonTitle: subTarget.seasonTitle,
              canonicalFolderName: subTarget.canonicalFolderName,
              year: subTarget.year ?? tmdbMeta.year,
              origStem: subStem,
              filePattern,
              filePatternExplicit,
              withTitle,
              releaseInfo: subReleaseInfo,
            });
          resolved = {
            seasonNumber: subTarget.seasonNumber,
            folderName: subTarget.folderName,
            epStart: subTarget.epStart,
            epEnd: subTarget.epEnd,
            baseName,
          };
        }
      }

      draftOrgSubs.push({
        sub,
        resolved,
        baseName: resolved.baseName,
        pairedVideoOldName: pairedVideo?.oldName ?? null,
        videoGroupKey: `${resolved.folderName}/${resolved.baseName}`.toLowerCase(),
        destScopeKey: resolved.folderName,
      });
    }

    const finalizedOrgSubs = finalizeAdaptiveSubtitleNames(draftOrgSubs);
    for (const fSub of finalizedOrgSubs) {
      resolvedSubtitleItems.push({
        id: fSub.sub.id,
        parentId: fSub.sub.parentId,
        sourceRelDir: fSub.sub.relativeDir || '',
        fromArchive: fSub.sub.fromArchive || null,
        oldName: fSub.sub.name,
        newName: fSub.newName,
        mediaType: 'subtitle',
        ext: fSub.sub.ext,
        seasonNumber: fSub.resolved.seasonNumber,
        targetFolderName: fSub.resolved.folderName,
        epStart: fSub.resolved.epStart,
        epEnd: fSub.resolved.epEnd,
        pairedVideoOldName: fSub.pairedVideoOldName,
      });
    }
  }

  const allPlannedItems = [...resolvedVideoItems, ...resolvedSubtitleItems].sort((a, b) => {
    if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
    if (a.epStart !== b.epStart) return a.epStart - b.epStart;
    if (a.mediaType !== b.mediaType) return a.mediaType === 'video' ? -1 : 1;
    return a.newName.localeCompare(b.newName);
  });

  const targetPathMap = new Map();
  const conflicts = [];
  for (const item of allPlannedItems) {
    const fullTargetKey = `${item.targetFolderName}/${item.newName}`.toLowerCase();
    if (targetPathMap.has(fullTargetKey)) {
      conflicts.push({
        targetPath: `${item.targetFolderName}/${item.newName}`,
        firstFile: targetPathMap.get(fullTargetKey).oldName,
        secondFile: item.oldName,
      });
    } else {
      targetPathMap.set(fullTargetKey, item);
    }
  }

  const activeSeasonsMap = new Map();
  for (const item of allPlannedItems) {
    let entry = activeSeasonsMap.get(item.seasonNumber);
    if (!entry) {
      const allList = Array.isArray(tmdbMeta?.allSeasons)
        ? tmdbMeta.allSeasons
        : Array.isArray(tmdbMeta?.regularSeasons)
          ? tmdbMeta.regularSeasons
          : [];
      const tmdbSeason = allList.find((s) => s.seasonNumber === item.seasonNumber);
      entry = {
        seasonNumber: item.seasonNumber,
        folderName: item.targetFolderName,
        seasonTitle: tmdbSeason?.seasonTitle ?? item.targetFolderName,
        canonicalFolderName: tmdbSeason?.canonicalFolderName ?? item.targetFolderName,
        expectedEpisodes: tmdbSeason?.episodeCount ?? null,
        videoCount: 0,
        subtitleCount: 0,
      };
      activeSeasonsMap.set(item.seasonNumber, entry);
    }
    if (item.mediaType === 'video') entry.videoCount += 1;
    else entry.subtitleCount += 1;
  }

  const requiredSeasons = [...activeSeasonsMap.values()].sort(
    (a, b) => a.seasonNumber - b.seasonNumber
  );

  const reclassificationMappings = reclassification.isMismatched
    ? reclassification.summaryList.map((m) => {
        const ts = tmdbMeta.allSeasons.find((s) => s.seasonNumber === m.seasonNumber);
        return {
          sourceDir: m.relDir,
          targetSeasonNumber: m.seasonNumber,
          targetFolderName: buildFolderForSeason(m.seasonNumber, ts),
          epOffset: m.epOffset || 0,
          overflowFold: Boolean(m.overflowFold),
          matchSource: m.matchSource,
        };
      })
    : [];

  return {
    canonicalSeriesTitle,
    suggestedFolderName,
    strategy: activeStrategy,
    filePattern: withTitle && filePattern === '{SxxExx}' ? '{Title} - {SxxExx}' : filePattern,
    seasonPattern: effectiveSeasonPattern,
    reclassification: {
      isMismatched: reclassification.isMismatched,
      autoAppliedTmdbFolderNames:
        reclassification.isMismatched && effectiveSeasonPattern === '{TmdbSeason}',
      mappings: reclassificationMappings,
    },
    offsetInfo,
    requiredSeasons,
    plannedItems: allPlannedItems,
    detectedArchives,
    conflicts,
    unmatchedFiles,
    skippedBonus,
    ignoredOtherCount: ignoredOther.length,
    stats: {
      totalScannedFiles: files.length,
      matchedVideos: resolvedVideoItems.length,
      matchedSubtitles: resolvedSubtitleItems.length,
      detectedArchiveCount: detectedArchives.length,
      seasonsToCreateOrUse: requiredSeasons.length,
      conflictCount: conflicts.length,
      unmatchedCount: unmatchedFiles.length,
      skippedBonusCount: skippedBonus.length,
    },
  };
}

/**
 * 针对电影资源构建标准化归类、重命名与外挂字幕对齐规划
 * 执行标准规范：电影名.年份.原视频压制信息.ext
 */
export function buildMovieOrganizationPlan({
  files,
  tmdbMeta,
  filePattern = '{Standard}',
  filePatternExplicit = false,
  folderPattern = '{MovieTitle}（{Year}）',
  maxArchiveSizeMB = 300,
}) {
  const videoFiles = [];
  const subtitleFiles = [];
  const detectedArchives = [];
  const skippedBonus = [];
  const ignoredOther = [];

  for (const file of files) {
    const ext = getExtension(file.name);
    if (VIDEO_EXTENSIONS.has(ext)) {
      if (isBonusClip(file.name)) {
        skippedBonus.push({ ...file, reason: '预告片/特典/花絮保护跳过' });
      } else {
        videoFiles.push({ ...file, ext });
      }
    } else if (SUBTITLE_EXTENSIONS.has(ext)) {
      subtitleFiles.push({ ...file, ext });
    } else if (isSubtitleArchiveCandidate(file.name, file.size, maxArchiveSizeMB)) {
      detectedArchives.push(file);
    } else {
      ignoredOther.push(file);
    }
  }

  const canonicalMovieTitle = buildCanonicalMovieTitle(tmdbMeta, videoFiles);
  const showTitleCandidates = [
    tmdbMeta?.title,
    tmdbMeta?.originalTitle,
    tmdbMeta?.userQuery,
    canonicalMovieTitle,
  ].filter(Boolean);

  const resolvedVideoItems = [];
  const unmatchedFiles = [];

  // 按文件大小降序排序（电影主视频通常最大）
  const sortedVideos = [...videoFiles].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));

  for (const v of sortedVideos) {
    const origStem = stripExtension(v.name);

    // 检查分卷标签 (如 CD1, Part1, Disc2)
    const partMatch = origStem.match(
      /(?:^|[._\-\s\[(])(?:cd|part|pt|disc|disque)[._\-\s]*([0-9a-z]+)(?:$|[._\-\s\])])/i
    );
    const partTag = partMatch ? `Part${partMatch[1].toUpperCase()}` : '';

    const releaseInfo = extractReleasePayload(origStem, {
      showTitles: showTitleCandidates,
    });

    const baseName = formatMovieMediaBaseName({
      canonicalMovieTitle,
      year: tmdbMeta?.year ?? null,
      releaseInfo,
      partTag,
      origStem,
      filePattern,
      filePatternExplicit,
    });

    const newName = `${baseName}.${v.ext}`;
    resolvedVideoItems.push({
      id: v.id,
      parentId: v.parentId,
      sourceRelDir: v.relativeDir || '',
      oldName: v.name,
      newName,
      mediaType: 'video',
      ext: v.ext,
      baseName,
      size: v.size ?? 0,
      stemLower: origStem.toLowerCase(),
    });
  }

  // 外挂字幕对齐与同名联动
  const resolvedSubtitleItems = [];
  if (subtitleFiles.length > 0 && resolvedVideoItems.length > 0) {
    const primaryVideo = resolvedVideoItems[0];
    const draftOrgSubs = [];

    for (const sub of subtitleFiles) {
      const subStemLower = stripExtension(sub.name).toLowerCase();
      // 优先前缀或最近目录匹配，单视频则直接 1:1 对齐
      let pairedVideo =
        resolvedVideoItems.find(
          (v) => subStemLower.startsWith(v.stemLower) || String(sub.parentId) === String(v.parentId)
        ) || primaryVideo;

      draftOrgSubs.push({
        sub,
        resolved: {
          folderName: '',
          baseName: pairedVideo.baseName,
        },
        baseName: pairedVideo.baseName,
        pairedVideoOldName: pairedVideo.oldName,
        videoGroupKey: pairedVideo.baseName.toLowerCase(),
        destScopeKey: 'movie_root',
      });
    }

    const finalizedSubs = finalizeAdaptiveSubtitleNames(draftOrgSubs);
    for (const fSub of finalizedSubs) {
      const needsMove = String(fSub.sub.parentId) !== String(primaryVideo.parentId);
      resolvedSubtitleItems.push({
        id: fSub.sub.id,
        parentId: fSub.sub.parentId,
        sourceRelDir: fSub.sub.relativeDir || '',
        fromArchive: fSub.sub.fromArchive || null,
        oldName: fSub.sub.name,
        newName: fSub.newName,
        mediaType: 'subtitle',
        ext: fSub.sub.ext,
        needsMove,
        targetCid: primaryVideo.parentId, // 移至主视频同层
        pairedVideoOldName: fSub.pairedVideoOldName,
      });
    }
  }

  const allPlannedItems = [...resolvedVideoItems, ...resolvedSubtitleItems];

  const suggestedFolderName = formatMovieFolderName({
    movieTitle: tmdbMeta?.title || canonicalMovieTitle,
    year: tmdbMeta?.year ?? null,
    folderPattern,
  });

  const targetPathMap = new Map();
  const conflicts = [];
  for (const item of allPlannedItems) {
    const fullTargetKey = `${item.targetFolderName || ''}/${item.newName}`.toLowerCase();
    if (targetPathMap.has(fullTargetKey)) {
      conflicts.push({
        targetPath: `${item.targetFolderName ? `${item.targetFolderName}/` : ''}${item.newName}`,
        firstFile: targetPathMap.get(fullTargetKey).oldName,
        secondFile: item.oldName,
      });
    } else {
      targetPathMap.set(fullTargetKey, item);
    }
  }

  return {
    strategy: 'MOVIE_STANDARDIZED',
    mediaType: 'movie',
    canonicalMovieTitle,
    suggestedFolderName,
    filePattern,
    plannedItems: allPlannedItems,
    actionableItems: allPlannedItems.filter((x) => x.oldName !== x.newName || x.needsMove),
    detectedArchives,
    conflicts,
    unmatchedFiles,
    skippedBonus,
    ignoredOtherCount: ignoredOther.length,
    stats: {
      totalScannedFiles: files.length,
      matchedVideos: resolvedVideoItems.length,
      matchedSubtitles: resolvedSubtitleItems.length,
      detectedArchiveCount: detectedArchives.length,
      conflictCount: conflicts.length,
      unmatchedCount: unmatchedFiles.length,
      skippedBonusCount: skippedBonus.length,
    },
  };
}
