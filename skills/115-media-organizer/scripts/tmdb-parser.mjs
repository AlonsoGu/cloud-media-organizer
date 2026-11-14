/**
 * TMDB 剧集搜索与季度页采集解析模块
 * 支持：
 * 1. 按剧名（含可选年份）自动搜索 TMDB 剧集条目并智能排序消歧；
 * 2. 解析 /tv/{id}/seasons 季度列表与正片集数累加区间；
 * 3. 双通道拉取：带 tmdb_challenge 自动握手的 HTTP 直连 + Chrome CDP 真实标签页兜底。
 */

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&nbsp;': ' ',
};

const DEFAULT_TMDB_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

let cachedChallengeCookie = '';

export function decodeHtmlEntities(str = '') {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&(amp|lt|gt|quot|#39|apos|mdash|ndash|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function stripTags(html = '') {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComparableTitle(text = '') {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s：:·・\-—_!！?？《》<>()（）[\]【】'"“”‘’,，.。/\\]+/g, '');
}

const SAFE_COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_COOKIE_VAL_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

export function sanitizeChallengeCookiePair(cookieName = '', cookieVal = '') {
  const name = String(cookieName || '').trim();
  const val = String(cookieVal || '').trim();
  if (!SAFE_COOKIE_NAME_RE.test(name) || !SAFE_COOKIE_VAL_RE.test(val)) {
    return null;
  }
  return `${name}=${val}`;
}

/**
 * 直连拉取 TMDB HTML，自动处理轻量级 data-cookie="tmdb_challenge" 质询握手；
 * 若仍被 WAF 拦截则降级使用 Chrome CDP 真实标签页读取。
 */
async function fetchTmdbHtmlDualChannel(
  targetUrl,
  { cdpManager = null, urlMatch = targetUrl, readySelector = 'body', validateHtml } = {}
) {
  try {
    const reqHeaders = cachedChallengeCookie
      ? { ...DEFAULT_TMDB_HEADERS, Cookie: cachedChallengeCookie }
      : { ...DEFAULT_TMDB_HEADERS };

    let res = await fetch(targetUrl, {
      headers: reqHeaders,
      signal: AbortSignal.timeout(4000),
    });
    let html = await res.text();

    const challengeMatch =
      html.match(/data-cookie="([^"]+)"\s+data-token="([^"]+)"/i) ||
      html.match(/data-token="([^"]+)"\s+data-cookie="([^"]+)"/i);

    if (challengeMatch) {
      const isCookieFirst = /data-cookie=/i.test(challengeMatch[0].slice(0, 15));
      const cookieName = isCookieFirst ? challengeMatch[1] : challengeMatch[2];
      const cookieVal = isCookieFirst ? challengeMatch[2] : challengeMatch[1];
      const safePair = sanitizeChallengeCookiePair(cookieName, cookieVal);

      if (safePair) {
        cachedChallengeCookie = safePair;
        res = await fetch(targetUrl, {
          headers: { ...DEFAULT_TMDB_HEADERS, Cookie: cachedChallengeCookie },
          signal: AbortSignal.timeout(4000),
        });
        html = await res.text();
      }
    }

    if (res.ok && (!validateHtml || validateHtml(html))) {
      return html;
    }
  } catch {
    // 忽略直连网络异常，降级走浏览器 CDP 通道
  }

  if (!cdpManager) {
    throw new Error(
      `直连拉取 TMDB 页面失败（可能受网络或 WAF 限制），且未提供可用的 Chrome CDP 会话: ${targetUrl}`
    );
  }

  return await cdpManager.fetchHtmlViaBrowserTab(targetUrl, {
    urlMatch,
    readySelector,
  });
}

function assertTmdbHostnameIfUrl(rawInput = '') {
  const trimmed = String(rawInput || '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`无效的 TMDB URL: "${rawInput}"`);
    }
    const host = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (host !== 'themoviedb.org' && host !== 'www.themoviedb.org')
    ) {
      throw new Error(`仅允许 themoviedb.org 域名链接，已拒绝: "${rawInput}"`);
    }
    return parsed.pathname;
  }
  return trimmed;
}

/**
 * 规范化 TMDB 季度链接，默认附加 ?language=zh-CN 获取标准中文剧名与季信息
 */
export function normalizeTmdbSeasonsUrl(inputUrl, language = 'zh-CN') {
  const pathPart = assertTmdbHostnameIfUrl(inputUrl);
  const match = pathPart.match(/(?:^|\/)tv\/(\d+)/i) || (!/^[a-zA-Z]+:/.test(String(inputUrl)) ? String(inputUrl).trim().match(/^(\d+)$/) : null);
  if (!match) {
    throw new Error(`无法从链接识别 TMDB TV ID: ${inputUrl}`);
  }
  const tvId = match[1];
  const canonicalUrl = `https://www.themoviedb.org/tv/${tvId}/seasons?language=${encodeURIComponent(language)}`;
  return { tvId, canonicalUrl };
}

/**
 * 规范化 TMDB 电影链接，默认附加 ?language=zh-CN
 */
export function normalizeTmdbMovieUrl(inputUrl, language = 'zh-CN') {
  if (!inputUrl) return '';
  const pathPart = assertTmdbHostnameIfUrl(inputUrl);
  const idMatch = pathPart.match(/(?:^|\/)movie\/(\d+)/i) || (!/^[a-zA-Z]+:/.test(String(inputUrl)) ? String(inputUrl).trim().match(/^(\d+)$/) : null);
  if (!idMatch) {
    throw new Error(`无法从输入中提取有效的 TMDB 电影 ID: "${inputUrl}"`);
  }
  const movieId = idMatch[1];
  return `https://www.themoviedb.org/movie/${movieId}?language=${encodeURIComponent(language)}`;
}

/**
 * 自动从 TMDB URL 检测媒体类型：'tv' | 'movie' | null
 */
export function detectTmdbMediaTypeFromUrl(inputUrl = '') {
  if (!inputUrl) return null;
  if (/^https?:\/\//i.test(String(inputUrl).trim())) {
    try {
      const u = new URL(String(inputUrl).trim());
      const host = u.hostname.toLowerCase();
      if (host !== 'themoviedb.org' && host !== 'www.themoviedb.org') {
        return null;
      }
      if (/\/movie\/\d+/i.test(u.pathname)) return 'movie';
      if (/\/tv\/\d+/i.test(u.pathname)) return 'tv';
      return null;
    } catch {
      return null;
    }
  }
  if (/\/movie\/\d+/i.test(inputUrl)) return 'movie';
  if (/\/tv\/\d+/i.test(inputUrl)) return 'tv';
  return null;
}

/**
 * 解析用户输入的剧名查询词，支持提取可选年份提示：
 * 例如："火影忍者（2002）"、"凡人修仙传 2020"、"星球大战 y:1977"、"《庆余年》"
 * 同时保护纯年份剧名（如 "1923"）与紧贴数字剧名（如 "请回答1988"）不被误拆。
 */
export function parseSearchQueryInput(rawInput = '') {
  let text = String(rawInput).trim().replace(/^[《「『]+|[》」』]+$/g, '').trim();
  if (!text) {
    throw new Error('TMDB 搜索剧名不能为空');
  }

  let yearHint = null;

  // 1. 显式 y:2020 或 year:2020 语法
  const yFilterMatch = text.match(/\s*\b(?:y|year)\s*[:：]\s*((?:19|20)\d{2})\b\s*/i);
  if (yFilterMatch) {
    const candidateClean = text.replace(yFilterMatch[0], ' ').trim();
    if (candidateClean) {
      yearHint = Number(yFilterMatch[1]);
      text = candidateClean;
    }
  }

  // 2. 括号包裹的尾部年份，如 "火影忍者 (2002)" / "火影忍者（2002）" / "三体 [2023]"
  if (yearHint === null) {
    const bracketYearMatch = text.match(/\s*[([（【]\s*((?:19|20)\d{2})\s*(?:年)?\s*[)\]）】]\s*$/);
    if (bracketYearMatch) {
      const candidateClean = text.slice(0, bracketYearMatch.index).trim();
      if (candidateClean) {
        yearHint = Number(bracketYearMatch[1]);
        text = candidateClean;
      }
    }
  }

  // 3. 空格分隔的尾部四位年份，如 "凡人修仙传 2020"（注意保留无空格的 "请回答1988" 及纯数字剧名 "1923"）
  if (yearHint === null) {
    const spaceYearMatch = text.match(/^(.+?)\s+((?:19|20)\d{2})$/);
    if (spaceYearMatch && spaceYearMatch[1].trim()) {
      yearHint = Number(spaceYearMatch[2]);
      text = spaceYearMatch[1].trim();
    }
  }

  return {
    rawQuery: String(rawInput).trim(),
    cleanQuery: text,
    yearHint,
  };
}

/**
 * 解析 TMDB /search/tv 页面 HTML，提取所有电视节目候选卡片（严格限定在 #tv_results 区域内）
 */
export function parseTmdbSearchTvHtml(html, searchUrl = '') {
  if (!html || (!html.includes('id="tv_results"') && !html.includes('search_results'))) {
    throw new Error('TMDB 搜索页未包含有效结果容器 (#tv_results)，可能触发了 WAF 质询或响应异常');
  }

  // 限定在 #tv_results 容器内，防止误扫同页隐藏的电影/合集卡片
  let scopeHtml = html;
  const tvStart = html.indexOf('id="tv_results"');
  if (tvStart !== -1) {
    const nextPanelMatch = html
      .slice(tvStart + 20)
      .match(/<div\s+id="(?:movie|person|collection|company|keyword|network|award)_results"/i);
    scopeHtml = nextPanelMatch
      ? html.slice(tvStart, tvStart + 20 + nextPanelMatch.index)
      : html.slice(tvStart);
  }

  // 兼容新版 Tailwind (comp:media-card) 与旧版 (card v4 tight) 两种卡片结构
  const cardBlocks = scopeHtml
    .split(/<div[^>]+class="[^"]*(?:comp:media-card|\bcard\s+v4\b)[^"]*"[^>]*>/i)
    .slice(1);

  const results = [];
  const seenIds = new Set();

  for (const card of cardBlocks) {
    // 兼容 <a href="/tv/31910..."><h2>...</h2></a> 以及 <h2><a href="/tv/31910...">...</a></h2>
    const linkWrapsH2 = card.match(
      /<a[^>]+href="\/tv\/(\d+)(?:-[^"?/]*)?(?:\?[^"]*)?"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<\/a>/i
    );
    const h2WrapsLink = !linkWrapsH2
      ? card.match(
          /<h2[^>]*>\s*<a[^>]+href="\/tv\/(\d+)(?:-[^"?/]*)?(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/h2>/i
        )
      : null;

    const match = linkWrapsH2 || h2WrapsLink;
    if (!match) continue;

    const tvId = match[1];
    if (seenIds.has(tvId)) continue;
    seenIds.add(tvId);

    const h2Content = linkWrapsH2 ? match[2] : `${match[2]} ${match[3] || ''}`;

    // 分离主标题与括号内的原名（如 <span class="font-light"> (ナルト 疾風伝)</span>）
    let originalTitle = null;
    let mainTitleHtml = h2Content;
    const origSpanMatch = h2Content.match(
      /<span[^>]+class="[^"]*\b(?:font-light|original_title)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    if (origSpanMatch) {
      originalTitle =
        stripTags(origSpanMatch[1])
          .replace(/^\(\s*|\s*\)$/g, '')
          .trim() || null;
      mainTitleHtml = h2Content.replace(origSpanMatch[0], '');
    }

    const title = normalizeTitleSpacing(stripTags(mainTitleHtml));
    if (!title) continue;

    const releaseMatch = card.match(
      /<span[^>]+class="[^"]*\brelease_date\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const releaseDate = releaseMatch ? stripTags(releaseMatch[1]) || null : null;
    const yearMatch = releaseDate ? releaseDate.match(/\b((?:19|20)\d{2})\b/) : null;
    const year = yearMatch ? Number(yearMatch[1]) : null;

    const overviewMatch =
      card.match(
        /<div[^>]+class="[^"]*(?:\boverview\b|\bmt-4\b)[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
      ) || card.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const overview = overviewMatch ? stripTags(overviewMatch[1]) : '';

    results.push({
      tvId,
      title,
      originalTitle,
      year,
      releaseDate,
      overview,
      tvUrl: `https://www.themoviedb.org/tv/${tvId}?language=zh-CN`,
      seasonsUrl: `https://www.themoviedb.org/tv/${tvId}/seasons?language=zh-CN`,
      sourceSearchUrl: searchUrl,
    });
  }

  return results;
}

/**
 * 对 TMDB 搜索候选结果进行相关度与年份加权排序，并检测是否存在“同名不同版”歧义
 */
export function selectBestTmdbCandidate(candidates, queryInput) {
  const { rawQuery, cleanQuery, yearHint } =
    typeof queryInput === 'string' ? parseSearchQueryInput(queryInput) : queryInput;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      selected: null,
      rankedCandidates: [],
      rawQuery,
      cleanQuery,
      yearHint,
      ambiguousExactTie: false,
    };
  }

  const normQuery = normalizeComparableTitle(cleanQuery);
  const normRaw = normalizeComparableTitle(rawQuery);

  const scored = candidates.map((item, index) => {
    const normTitle = normalizeComparableTitle(item.title);
    const normOrig = item.originalTitle ? normalizeComparableTitle(item.originalTitle) : '';

    let score = 0;
    let isExactTitle = false;

    if (normTitle === normQuery || (normOrig && normOrig === normQuery) || normTitle === normRaw) {
      score += 100;
      isExactTitle = true;
    } else if (
      normTitle.startsWith(normQuery) ||
      normQuery.startsWith(normTitle) ||
      (normOrig && normOrig.startsWith(normQuery))
    ) {
      score += 45;
    } else if (normTitle.includes(normQuery) || (normOrig && normOrig.includes(normQuery))) {
      score += 25;
    }

    if (yearHint !== null) {
      if (item.year === yearHint) {
        score += 80;
      } else if (item.year !== null) {
        score -= 50;
      }
    }

    // 保留 TMDB 原生搜索相关度顺序作为微弱平局决胜权重
    const rankScore = score - index * 2;
    return {
      ...item,
      _baseScore: score,
      _rankScore: rankScore,
      _isExactTitle: isExactTitle,
    };
  });

  scored.sort((a, b) => b._rankScore - a._rankScore);

  // 检测是否存在未指定年份（或同一年份）的完全同名多版本剧集（例如动画版 vs 真人版《凡人修仙传》）
  const top = scored[0];
  const second = scored[1];
  const ambiguousExactTie = Boolean(
    top &&
      second &&
      top._isExactTitle &&
      second._isExactTitle &&
      top._baseScore === second._baseScore
  );

  const rankedCandidates = scored.map(({ _baseScore, _rankScore, _isExactTitle, ...clean }) => clean);

  return {
    selected: rankedCandidates[0],
    rankedCandidates,
    rawQuery,
    cleanQuery,
    yearHint,
    ambiguousExactTie,
  };
}

/**
 * 按剧名自动搜索 TMDB 电视节目并返回排序后的候选列表与首选条目
 */
export async function searchTmdbTvShows(queryInput, cdpManager = null, language = 'zh-CN') {
  const parsedQuery = parseSearchQueryInput(queryInput);
  const buildSearchUrl = (q) =>
    `https://www.themoviedb.org/search/tv?query=${encodeURIComponent(q)}&language=${encodeURIComponent(language)}`;

  const primaryUrl = buildSearchUrl(parsedQuery.cleanQuery);
  const html = await fetchTmdbHtmlDualChannel(primaryUrl, {
    cdpManager,
    urlMatch: primaryUrl,
    readySelector: '#tv_results',
    validateHtml: (h) => h.includes('id="tv_results"') || h.includes('search_results'),
  });

  let candidates = parseTmdbSearchTvHtml(html, primaryUrl);

  // 兜底：若拆出尾部四位数字后查无结果（例如搜 "请回答 1988" 拆成了 "请回答" 未命中），回退使用原始完整词重搜
  if (candidates.length === 0 && parsedQuery.cleanQuery !== parsedQuery.rawQuery) {
    const fallbackUrl = buildSearchUrl(parsedQuery.rawQuery);
    const fallbackHtml = await fetchTmdbHtmlDualChannel(fallbackUrl, {
      cdpManager,
      urlMatch: fallbackUrl,
      readySelector: '#tv_results',
      validateHtml: (h) => h.includes('id="tv_results"') || h.includes('search_results'),
    });
    candidates = parseTmdbSearchTvHtml(fallbackHtml, fallbackUrl);
  }

  return selectBestTmdbCandidate(candidates, parsedQuery);
}

/**
 * 解析 TMDB /search/movie 页面 HTML，提取所有电影候选卡片（严格限定在 #movie_results 区域内）
 */
export function parseTmdbSearchMovieHtml(html, searchUrl = '') {
  if (!html || (!html.includes('id="movie_results"') && !html.includes('search_results'))) {
    throw new Error('TMDB 搜索页未包含有效电影结果容器 (#movie_results)，可能触发了 WAF 质询或响应异常');
  }

  let scopeHtml = html;
  const movieStart = html.indexOf('id="movie_results"');
  if (movieStart !== -1) {
    const nextPanelMatch = html
      .slice(movieStart + 20)
      .match(/<div\s+id="(?:tv|person|collection|company|keyword|network|award)_results"/i);
    scopeHtml = nextPanelMatch
      ? html.slice(movieStart, movieStart + 20 + nextPanelMatch.index)
      : html.slice(movieStart);
  }

  const cardBlocks = scopeHtml
    .split(/<div[^>]+class="[^"]*(?:comp:media-card|\bcard\s+v4\b)[^"]*"[^>]*>/i)
    .slice(1);

  const results = [];
  const seenIds = new Set();

  for (const card of cardBlocks) {
    const linkWrapsH2 = card.match(
      /<a[^>]+href="\/movie\/(\d+)(?:-[^"?/]*)?(?:\?[^"]*)?"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<\/a>/i
    );
    const h2WrapsLink = !linkWrapsH2
      ? card.match(
          /<h2[^>]*>\s*<a[^>]+href="\/movie\/(\d+)(?:-[^"?/]*)?(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/h2>/i
        )
      : null;
    const tailwindLink = (!linkWrapsH2 && !h2WrapsLink)
      ? card.match(
          /<a[^>]+(?:data-media-type="movie"[^>]+)?href="\/movie\/(\d+)(?:-[^"?/]*)?(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/i
        )
      : null;

    const match = linkWrapsH2 || h2WrapsLink || tailwindLink;
    if (!match) continue;

    const movieId = match[1];
    if (seenIds.has(movieId)) continue;
    seenIds.add(movieId);

    let h2Content = linkWrapsH2 ? match[2] : h2WrapsLink ? `${match[2]} ${match[3] || ''}` : '';
    if (!h2Content && tailwindLink) {
      const titleLinkMatch =
        card.match(/<a[^>]+class="[^"]*hover:underline[^"]*"[^>]*href="\/movie\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
        card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
        card.match(/<img[^>]+alt="([^"]+)"/i);
      h2Content = titleLinkMatch ? titleLinkMatch[1] : '';
    }

    let originalTitle = null;
    let mainTitleHtml = h2Content;
    const origSpanMatch = h2Content.match(
      /<span[^>]+class="[^"]*\b(?:font-light|original_title)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    if (origSpanMatch) {
      originalTitle =
        stripTags(origSpanMatch[1])
          .replace(/^\(\s*|\s*\)$/g, '')
          .trim() || null;
      mainTitleHtml = h2Content.replace(origSpanMatch[0], '');
    }

    const title = normalizeTitleSpacing(stripTags(mainTitleHtml));
    if (!title) continue;

    const releaseMatch = card.match(
      /<span[^>]+class="[^"]*\brelease_date\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const releaseDate = releaseMatch ? stripTags(releaseMatch[1]) || null : null;
    const yearMatch = releaseDate ? releaseDate.match(/\b((?:19|20)\d{2})\b/) : null;
    const year = yearMatch ? Number(yearMatch[1]) : null;

    const overviewMatch =
      card.match(
        /<div[^>]+class="[^"]*(?:\boverview\b|\bmt-4\b)[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
      ) || card.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const overview = overviewMatch ? stripTags(overviewMatch[1]) : '';

    results.push({
      movieId,
      title,
      originalTitle,
      year,
      releaseDate,
      overview,
      movieUrl: `https://www.themoviedb.org/movie/${movieId}?language=zh-CN`,
      sourceSearchUrl: searchUrl,
      mediaType: 'movie',
    });
  }

  return results;
}

/**
 * 按电影名自动搜索 TMDB 电影并返回排序后的候选列表与首选条目
 */
export async function searchTmdbMovies(queryInput, cdpManager = null, language = 'zh-CN') {
  const parsedQuery = parseSearchQueryInput(queryInput);
  const buildSearchUrl = (q) =>
    `https://www.themoviedb.org/search/movie?query=${encodeURIComponent(q)}&language=${encodeURIComponent(language)}`;

  const primaryUrl = buildSearchUrl(parsedQuery.cleanQuery);
  const html = await fetchTmdbHtmlDualChannel(primaryUrl, {
    cdpManager,
    urlMatch: primaryUrl,
    readySelector: '#movie_results',
    validateHtml: (h) => h.includes('id="movie_results"') || h.includes('search_results'),
  });

  let candidates = parseTmdbSearchMovieHtml(html, primaryUrl);

  if (candidates.length === 0 && parsedQuery.cleanQuery !== parsedQuery.rawQuery) {
    const fallbackUrl = buildSearchUrl(parsedQuery.rawQuery);
    const fallbackHtml = await fetchTmdbHtmlDualChannel(fallbackUrl, {
      cdpManager,
      urlMatch: fallbackUrl,
      readySelector: '#movie_results',
      validateHtml: (h) => h.includes('id="movie_results"') || h.includes('search_results'),
    });
    candidates = parseTmdbSearchMovieHtml(fallbackHtml, fallbackUrl);
  }

  return selectBestTmdbCandidate(candidates, parsedQuery);
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

function sanitizeSeasonFolderTitle(str = '') {
  return normalizeTitleSpacing(
    String(str)
      .replace(/[\/\\:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function isGenericTmdbSeasonTitle(title = '') {
  const t = String(title).trim();
  if (!t) return true;
  return /^(?:第\s*[0-9一二两三四五六七八九十]+\s*季|Season\s*\d+|Series\s*\d+|Specials?|特别篇|特別篇)$/i.test(
    t
  );
}

/**
 * 解析多样化的 TMDB 播出日期文本（兼容中文 "2015 年 01 月 10 日"、ISO "2015-01-10" 及英文 "January 10, 2015"）
 */
export function parseFlexibleAirDate(rawDate = '') {
  const s = String(rawDate || '').trim();
  if (!s) return null;

  const cnOrIso =
    s.match(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
    s.match(/\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (cnOrIso) {
    const year = Number(cnOrIso[1]);
    const month = Number(cnOrIso[2]);
    const day = Number(cnOrIso[3]);
    const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return {
      isoDate,
      timestamp: Date.UTC(year, month - 1, day),
      year,
    };
  }

  const parsedMs = Date.parse(s);
  if (!Number.isNaN(parsedMs)) {
    const d = new Date(parsedMs);
    const year = d.getUTCFullYear();
    if (year >= 1900 && year <= 2099) {
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      return {
        isoDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        timestamp: Date.UTC(year, month - 1, day),
        year,
      };
    }
  }

  return null;
}

/**
 * 根据单季内各集播出时间间隔（默认 >= 35 天视为跨季度分割放送 Break）自动切分 Broadcast Cours（如 承/转/结、Part 1/Part 2）
 * 同时要求切分两侧各至少含 3 集（防止第 1 集先行上映导致单集误切）
 */
export function splitEpisodesIntoBroadcastCours(
  episodes = [],
  totalEpisodeCount = 0,
  fallbackYear = null,
  gapDaysThreshold = 35
) {
  const count = Number(totalEpisodeCount) || episodes.length;
  if (count <= 0) return [];

  const validDated = [...episodes]
    .filter((e) => e.episodeNumber >= 1 && e.episodeNumber <= count && e.airTimestamp !== null)
    .sort((a, b) => a.episodeNumber - b.episodeNumber);

  if (validDated.length < 4) {
    return [
      {
        courIndex: 1,
        epStart: 1,
        epEnd: count,
        count,
        epOffset: 0,
        year: validDated[0]?.year ?? fallbackYear,
      },
    ];
  }

  const minCourSize = count >= 6 ? 3 : 2;
  const thresholdMs = gapDaysThreshold * 24 * 3600 * 1000;
  const breakEpStarts = [1];

  for (let i = 1; i < validDated.length; i += 1) {
    const prev = validDated[i - 1];
    const curr = validDated[i];
    const gapMs = curr.airTimestamp - prev.airTimestamp;
    const prevSpan = curr.episodeNumber - breakEpStarts[breakEpStarts.length - 1];
    const remainingSpan = count - curr.episodeNumber + 1;

    if (gapMs >= thresholdMs && prevSpan >= minCourSize && remainingSpan >= minCourSize) {
      breakEpStarts.push(curr.episodeNumber);
    }
  }

  return breakEpStarts.map((epStart, idx) => {
    const epEnd = idx + 1 < breakEpStarts.length ? breakEpStarts[idx + 1] - 1 : count;
    const firstDatedInCour = validDated.find(
      (e) => e.episodeNumber >= epStart && e.episodeNumber <= epEnd
    );
    return {
      courIndex: idx + 1,
      epStart,
      epEnd,
      count: epEnd - epStart + 1,
      epOffset: epStart - 1,
      year: firstDatedInCour?.year ?? fallbackYear,
    };
  });
}

/**
 * 解析 TMDB 单季剧集详情页 (/tv/{id}/season/{seasonNumber}?language=zh-CN)，提取每集标题、播出日期与简介
 */
export function parseTmdbSeasonEpisodesHtml(html = '') {
  if (!html) return [];

  let scopeHtml = html;
  const listIdx = html.indexOf('episode_list');
  if (listIdx !== -1) {
    scopeHtml = html.slice(Math.max(0, listIdx - 50));
  }

  const cardBlocks = scopeHtml
    .split(/<div[^>]+class="[^"]*\bcard\b[^"]*"[^>]*>/i)
    .slice(1);

  const episodesByNum = new Map();

  for (const card of cardBlocks) {
    const epLinks = [
      ...card.matchAll(
        /<a[^>]+href="\/tv\/\d+\/season\/\d+\/episode\/(\d+)(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi
      ),
    ];

    let epNum = null;
    let title = '';
    for (const m of epLinks) {
      const candidateNum = Number(m[1]);
      const candidateTitle = stripTags(m[2]);
      if (epNum === null) epNum = candidateNum;
      if (candidateTitle) {
        epNum = candidateNum;
        title = candidateTitle;
        break;
      }
    }

    if (epNum === null) {
      const numSpan = card.match(
        /<span[^>]+class="[^"]*\bepisode_number\b[^"]*"[^>]*>(\d+)<\/span>/i
      );
      if (numSpan) epNum = Number(numSpan[1]);
    }
    if (epNum === null || Number.isNaN(epNum)) continue;

    const dateSpanMatch = card.match(
      /<span[^>]+class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const rawDateText = dateSpanMatch ? stripTags(dateSpanMatch[1]) : '';
    const parsedDate = parseFlexibleAirDate(rawDateText);

    const overviewMatch = card.match(
      /<div[^>]+class="[^"]*\boverview\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    );
    const overview = overviewMatch ? stripTags(overviewMatch[1]) : '';

    if (!episodesByNum.has(epNum) || (!episodesByNum.get(epNum).title && title)) {
      episodesByNum.set(epNum, {
        episodeNumber: epNum,
        title,
        airDate: parsedDate?.isoDate ?? null,
        airTimestamp: parsedDate?.timestamp ?? null,
        year: parsedDate?.year ?? null,
        overview,
      });
    }
  }

  return [...episodesByNum.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/**
 * 解析 TMDB /tv/{id}/seasons 页面 HTML，输出剧集名称、特别篇信息、正片各季集数、TMDB 官方季目录名与累加区间
 */
export function parseTmdbSeasonsHtml(html, sourceUrl = '') {
  if (!html || !html.includes('season_wrapper')) {
    throw new Error('TMDB 页面未包含有效的季度列表 (.season_wrapper)，可能触发了 WAF 质询或链接无效');
  }

  let tvId = null;
  const urlIdMatch = String(sourceUrl).match(/\/tv\/(\d+)/i);
  if (urlIdMatch) tvId = urlIdMatch[1];

  // 1. 提取剧名：优先从 header 标题链接提取，其次 og:title，最后 <title>
  let showTitle = '';
  const headerTitleMatch =
    html.match(/<div[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) ||
    html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (headerTitleMatch) {
    showTitle = normalizeTitleSpacing(stripTags(headerTitleMatch[1]));
  } else {
    const docTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (docTitleMatch) {
      showTitle = normalizeTitleSpacing(
        stripTags(docTitleMatch[1]).replace(/\s*\(.*?\)\s*-.*$/, '').trim()
      );
    }
  }

  // 2. 按 .season_wrapper 切分季度卡片
  const rawBlocks = html.split(/<div\s+class="season_wrapper"\s*>/i).slice(1);
  const draftSeasons = [];

  for (const block of rawBlocks) {
    const seasonLinkMatch = block.match(
      /<h2[^>]*>\s*<a[^>]+href="\/tv\/(\d+)[^/]*\/season\/(\d+)(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i
    );
    if (!seasonLinkMatch) continue;

    if (!tvId) tvId = seasonLinkMatch[1];
    const seasonNumber = Number(seasonLinkMatch[2]);
    const seasonTitle = stripTags(seasonLinkMatch[3]);

    // 提取 h4 中的集数（兼容缺失年份如 "&mdash; • 共 20 集" 以及英文 "2007 • 32 Episodes"）
    const h4Match = block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const h4Text = h4Match ? stripTags(h4Match[1]) : '';

    const epCountMatch = h4Text.match(/(?:共\s*(\d+)\s*集|(\d+)\s*Episodes?)/i);
    const episodeCount = epCountMatch ? Number(epCountMatch[1] ?? epCountMatch[2]) : 0;

    const yearMatch = h4Text.match(/\b((?:19|20)\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : null;

    const overviewMatch = block.match(
      /<div[^>]+class="[^"]*\bseason_overview\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    );
    const seasonOverview = overviewMatch ? stripTags(overviewMatch[1]) : '';

    draftSeasons.push({
      seasonNumber,
      seasonTitle,
      seasonOverview,
      episodeCount,
      year,
    });
  }

  draftSeasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

  // 判断正片季度中是否存在非通用的自定义季名（如 "无头骑士异闻录×2"、"游郭篇"）
  const hasCustomRegularSeasonTitle = draftSeasons.some(
    (s) => s.seasonNumber >= 1 && s.episodeCount > 0 && !isGenericTmdbSeasonTitle(s.seasonTitle)
  );

  const allSeasons = draftSeasons.map((s) => {
    let canonicalFolderName;
    if (s.seasonNumber === 0) {
      canonicalFolderName = sanitizeSeasonFolderTitle(s.seasonTitle) || '特别篇';
    } else if (
      s.seasonNumber === 1 &&
      isGenericTmdbSeasonTitle(s.seasonTitle) &&
      hasCustomRegularSeasonTitle &&
      showTitle
    ) {
      // 当第 2 季+ 使用如 "无头骑士异闻录×2" 的剧名衍生季名，而第 1 季仍为默认 "第 1 季" 时，自动对齐为主剧名 "无头骑士异闻录"
      canonicalFolderName = sanitizeSeasonFolderTitle(showTitle);
    } else {
      canonicalFolderName =
        sanitizeSeasonFolderTitle(s.seasonTitle) || `第 ${s.seasonNumber} 季`;
    }

    return {
      ...s,
      canonicalFolderName,
      folderName: s.seasonNumber === 0 ? 'Specials' : `Season ${String(s.seasonNumber).padStart(2, '0')}`,
      episodes: [],
      cours:
        s.episodeCount > 0
          ? [
              {
                courIndex: 1,
                epStart: 1,
                epEnd: s.episodeCount,
                count: s.episodeCount,
                epOffset: 0,
                year: s.year,
              },
            ]
          : [],
    };
  });

  const specialSeason = allSeasons.find((s) => s.seasonNumber === 0) ?? null;
  const regularSeasons = [];
  let cumulative = 0;

  for (const s of allSeasons) {
    if (s.seasonNumber >= 1 && s.episodeCount > 0) {
      const globalStart = cumulative + 1;
      const globalEnd = cumulative + s.episodeCount;
      cumulative = globalEnd;
      regularSeasons.push({
        ...s,
        globalStart,
        globalEnd,
      });
    }
  }

  if (regularSeasons.length === 0) {
    throw new Error('未从 TMDB 季度页解析到任何正片季度（season >= 1 且集数 > 0）');
  }

  const mainYear = regularSeasons.find((s) => s.year)?.year ?? null;

  return {
    tvId,
    sourceUrl,
    showTitle,
    year: mainYear,
    hasCustomRegularSeasonTitle,
    specialSeason,
    regularSeasons,
    allSeasons,
    totalRegularEpisodes: cumulative,
  };
}

/**
 * 双通道获取 TMDB 季度数据
 */
export async function fetchTmdbSeasons(tmdbUrl, cdpManager = null) {
  const { tvId, canonicalUrl } = normalizeTmdbSeasonsUrl(tmdbUrl, 'zh-CN');

  const html = await fetchTmdbHtmlDualChannel(canonicalUrl, {
    cdpManager,
    urlMatch: `themoviedb.org/tv/${tvId}/seasons`,
    readySelector: '.season_wrapper',
    validateHtml: (h) => h.includes('season_wrapper'),
  });

  return parseTmdbSeasonsHtml(html, canonicalUrl);
}

/**
 * 按需拉取 TMDB 各季单集详情页 (/tv/{id}/season/{s})，补充每集标题、播出时间与分割放送 Cour 区间
 * 用于解决本地文件夹分类（如 承/转/结、Part 1/2、篇章目录）与 TMDB 季度合并分类不一致时的精确对齐
 */
export async function enrichTmdbSeasonsWithEpisodes(
  tmdbMeta,
  cdpManager = null,
  language = 'zh-CN',
  { activeSeasonNumbers = null, concurrency = 4 } = {}
) {
  const tvId =
    tmdbMeta?.tvId ||
    (String(tmdbMeta?.sourceUrl || '').match(/\/tv\/(\d+)/i)?.[1] ?? null);
  if (!tvId) return tmdbMeta;

  const activeSet = activeSeasonNumbers
    ? new Set([...activeSeasonNumbers].map(Number))
    : null;

  const targets = [];
  if (
    tmdbMeta.specialSeason &&
    tmdbMeta.specialSeason.episodeCount > 0 &&
    tmdbMeta.specialSeason.episodeCount <= 300 &&
    (!activeSet || activeSet.has(0))
  ) {
    targets.push(tmdbMeta.specialSeason);
  }
  if (tmdbMeta.regularSeasons.length <= 15) {
    for (const s of tmdbMeta.regularSeasons) {
      if (s.episodeCount > 0 && s.episodeCount <= 200) {
        if (!activeSet || activeSet.has(s.seasonNumber)) {
          targets.push(s);
        }
      }
    }
  }

  const isGenericEpTitle = (t = '') =>
    !t || /^(?:第\s*\d+\s*[集话話期]|Episode\s*\d+|EP\s*\d+)$/i.test(String(t).trim());
  const isPlaceholderOverview = (ov = '') =>
    !ov || /^(?:抱歉|暂无|没有|We don't have an overview)/i.test(String(ov).trim());

  const fetchSeason = async (seasonObj) => {
    const seasonUrl = `https://www.themoviedb.org/tv/${tvId}/season/${seasonObj.seasonNumber}?language=${encodeURIComponent(language)}`;
    try {
      const epHtml = await fetchTmdbHtmlDualChannel(seasonUrl, {
        cdpManager,
        urlMatch: `themoviedb.org/tv/${tvId}/season/${seasonObj.seasonNumber}`,
        readySelector: '.episode_list, .card',
        validateHtml: (h) => h.includes('/episode/') || h.includes('episode_list'),
      });
      const episodes = parseTmdbSeasonEpisodesHtml(epHtml);

      // 当 Season 0 特别篇存在“第 X 集”占位标题或缺失中文简介时，补充拉取英文版以扩充双语标题与描述匹配词库
      if (
        seasonObj.seasonNumber === 0 &&
        language !== 'en-US' &&
        episodes.length > 0 &&
        episodes.some((e) => isGenericEpTitle(e.title) || isPlaceholderOverview(e.overview))
      ) {
        try {
          const enUrl = `https://www.themoviedb.org/tv/${tvId}/season/0?language=en-US`;
          const enHtml = await fetchTmdbHtmlDualChannel(enUrl, {
            cdpManager,
            urlMatch: `themoviedb.org/tv/${tvId}/season/0`,
            readySelector: '.episode_list, .card',
            validateHtml: (h) => h.includes('/episode/') || h.includes('episode_list'),
          });
          const enEpisodes = parseTmdbSeasonEpisodesHtml(enHtml);
          const enMap = new Map(enEpisodes.map((e) => [e.episodeNumber, e]));
          for (const ep of episodes) {
            if (isPlaceholderOverview(ep.overview)) ep.overview = '';
            const enEp = enMap.get(ep.episodeNumber);
            if (!enEp) continue;
            if (!isGenericEpTitle(enEp.title)) {
              ep.enTitle = enEp.title;
              if (isGenericEpTitle(ep.title)) {
                ep.title = enEp.title;
              }
            }
            if (!isPlaceholderOverview(enEp.overview)) {
              ep.enOverview = enEp.overview;
              if (!ep.overview) {
                ep.overview = enEp.overview;
              }
            }
          }
        } catch {
          // 英文补充拉取失败不影响主流程
        }
      } else {
        for (const ep of episodes) {
          if (isPlaceholderOverview(ep.overview)) ep.overview = '';
        }
      }

      seasonObj.episodes = episodes;
      if (episodes.length > 0) {
        seasonObj.startEpisodeNumber = episodes[0].episodeNumber;
        seasonObj.endEpisodeNumber = episodes[episodes.length - 1].episodeNumber;
      }
      if (seasonObj.seasonNumber >= 1) {
        seasonObj.cours = splitEpisodesIntoBroadcastCours(
          episodes,
          seasonObj.episodeCount,
          seasonObj.year
        );
      }
      // 同步回 allSeasons 中的同一季对象
      const mirror = tmdbMeta.allSeasons.find(
        (x) => x.seasonNumber === seasonObj.seasonNumber
      );
      if (mirror && mirror !== seasonObj) {
        mirror.episodes = seasonObj.episodes;
        mirror.cours = seasonObj.cours;
        mirror.startEpisodeNumber = seasonObj.startEpisodeNumber;
        mirror.endEpisodeNumber = seasonObj.endEpisodeNumber;
      }
    } catch {
      // 单季拉取异常时保持已有 episodeCount 兜底结构，不阻断整体流程
    }
  };

  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    await Promise.all(chunk.map((item) => fetchSeason(item)));
  }

  return tmdbMeta;
}

/**
 * 解析 TMDB 电影详情页 HTML，提取电影中英文标题、上映年份、原名及简介
 */
export function parseTmdbMovieHtml(html, sourceUrl = '') {
  if (!html || !html.includes('The Movie Database')) {
    throw new Error('TMDB 电影详情页响应异常或未包含完整元数据');
  }

  const idMatch = sourceUrl.match(/\/movie\/(\d+)/i) || html.match(/data-id="(\d+)"/i);
  const movieId = idMatch ? idMatch[1] : '';

  // 1. 标题提取与规范化空格
  let title = '';
  const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (ogTitleMatch) {
    title = normalizeTitleSpacing(stripTags(ogTitleMatch[1]));
  } else {
    const h2Match =
      html.match(/<h2[^>]*>\s*<a[^>]+>([\s\S]*?)<\/a>\s*<\/h2>/i) ||
      html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      title = normalizeTitleSpacing(stripTags(h2Match[1]));
    } else {
      const docTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      if (docTitleMatch) {
        title = normalizeTitleSpacing(
          stripTags(docTitleMatch[1]).replace(/\s*\(.*?\)\s*-.*$/, '').trim()
        );
      }
    }
  }

  // 2. 年份与上映日期提取
  let year = null;
  const yearMatch =
    html.match(/<span\s+class="[^"]*tag[^"]*release_date[^"]*">\s*\((\d{4})\)\s*<\/span>/i) ||
    html.match(/<span\s+class="tag[^"]*year[^"]*">\s*\((\d{4})\)\s*<\/span>/i) ||
    html.match(/<span\s+class="tag[^"]*">\s*\((\d{4})\)\s*<\/span>/i) ||
    html.match(/\((\d{4})\)\s*—\s*The Movie Database/i);
  if (yearMatch) {
    year = Number(yearMatch[1]);
  }

  const releaseDateMatch = html.match(/<span\s+class="release">\s*([\d-]+)/i);
  const releaseDate = releaseDateMatch ? releaseDateMatch[1].trim() : null;
  if (!year && releaseDate) {
    const yMatch = releaseDate.match(/^((?:19|20)\d{2})/);
    if (yMatch) year = Number(yMatch[1]);
  }

  // 3. 原名提取
  let originalTitle = null;
  const origTitleMatch =
    html.match(/<p\s+class="wrap">\s*<strong>\s*(?:原名|Original Title)\s*<\/strong>\s*([\s\S]*?)<\/p>/i) ||
    html.match(/<strong>\s*(?:原名|Original Title)\s*<\/strong>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ||
    html.match(/<strong>\s*(?:原名|Original Title)\s*<\/strong>\s*([^<]+)/i);

  if (origTitleMatch) {
    originalTitle = normalizeTitleSpacing(stripTags(origTitleMatch[1]).trim()) || null;
  }
  if (!originalTitle) {
    originalTitle = title;
  }

  // 4. 简介提取
  let overview = '';
  const overviewMatch =
    html.match(/<div\s+class="[^"]*\boverview\b[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/<h3>(?:简述|Overview)<\/h3>\s*<div[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (overviewMatch) {
    overview = stripTags(overviewMatch[1]);
  }

  return {
    movieId,
    title,
    originalTitle,
    year,
    releaseDate,
    overview,
    movieUrl: `https://www.themoviedb.org/movie/${movieId}?language=zh-CN`,
    mediaType: 'movie',
  };
}

/**
 * 拉取并解析 TMDB 电影详情页
 */
export async function fetchTmdbMovie(movieUrl, cdpManager = null) {
  const normUrl = normalizeTmdbMovieUrl(movieUrl);
  const html = await fetchTmdbHtmlDualChannel(normUrl, {
    cdpManager,
    urlMatch: normUrl,
    readySelector: 'h2, .title, [data-media-type]',
    validateHtml: (h) => h.includes('The Movie Database') || h.includes('og:title'),
  });

  return parseTmdbMovieHtml(html, normUrl);
}
