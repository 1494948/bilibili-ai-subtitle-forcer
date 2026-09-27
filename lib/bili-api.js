/**
 * lib/bili-api.js —— B站字幕相关的全部纯逻辑（不碰 DOM、不发请求，可离线单测）
 *
 * 关键事实（本项目所有注入行为的依据）：
 *  1. B站 Web 播放器只认 `x/player/v2`（或 `x/player/wbi/v2`）响应中的
 *     `data.subtitle.subtitles[]`，并据此渲染字幕语言列表
 *     （DOM: `.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]`）。
 *  2. 该字段在未登录时为空（响应里 `need_login_subtitle` 为 true），
 *     所以大量用户看到的是"根本没有 AI 字幕这个开关"。
 *  3. 存在免登录字幕通道 `x/v2/dm/view?aid=&oid=<cid>&type=1`，
 *     返回结构里同样有 `data.subtitle`，可用于预取后注入。
 *  4. AI 字幕条目特征：`lan` 以 `ai-` 开头（如 `ai-zh`），
 *     `lan_doc` 形如「中文(自动生成)」，`type` 为 1，
 *     `subtitle_url` 指向 `//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/...`。
 *
 * 双出口：Node `require()` / 浏览器 `globalThis.BASFBiliApi`
 */
(function (root, factory) {
  var API = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.BASFBiliApi = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 常量

  var API_HOST = 'https://api.bilibili.com';

  /** 字幕数据源，按「成功率与免登录程度」排序，逐个尝试取第一个有字幕的 */
  var SUBTITLE_ENDPOINTS = [
    {
      id: 'dm-view',
      label: '弹幕/字幕视图（免登录通道）',
      needLogin: false,
      build: function (ids) {
        return API_HOST + '/x/v2/dm/view?aid=' + ids.aid + '&oid=' + ids.cid + '&type=1';
      }
    },
    {
      id: 'dm-web-subtitles',
      label: '字幕列表（免登录通道）',
      needLogin: false,
      build: function (ids) {
        return API_HOST + '/x/v2/dm/web/subtitles?oid=' + ids.cid + '&type=1';
      }
    },
    {
      id: 'player-v2',
      label: '播放器信息（需登录态）',
      needLogin: true,
      build: function (ids) {
        return API_HOST + '/x/player/v2?aid=' + ids.aid + '&cid=' + ids.cid;
      }
    },
    {
      id: 'player-wbi-v2',
      label: '播放器信息 WBI（需登录态）',
      needLogin: true,
      build: function (ids) {
        return API_HOST + '/x/player/wbi/v2?aid=' + ids.aid + '&cid=' + ids.cid;
      }
    }
  ];

  /** 播放器用来渲染字幕列表的接口特征 */
  var PLAYER_INFO_RE = /\/x\/player\/(?:wbi\/)?v2\b/;

  var AI_LAN_RE = /^ai(?:[-_]|$)/i;

  /** 语言偏好 → 候选 lan 列表（前面优先） */
  var LANG_ALIASES = {
    zh: ['ai-zh', 'zh-Hans', 'zh-CN', 'zh-Hant', 'zh-TW', 'zh'],
    en: ['ai-en', 'en-US', 'en-GB', 'en'],
    ja: ['ai-ja', 'ja-JP', 'ja'],
    ko: ['ai-ko', 'ko-KR', 'ko']
  };

  var LANG_LABEL = {
    'ai-zh': '中文（AI 自动生成）',
    'ai-en': 'English（AI 自动生成）',
    'ai-ja': '日本語（AI 自动生成）',
    'ai-ko': '한국어（AI 自动生成）',
    'zh-Hans': '中文（简体）',
    'zh-Hant': '中文（繁體）',
    'zh-CN': '中文（中国）',
    'zh-TW': '中文（台湾）',
    'en-US': '英语（美国）',
    'en-GB': '英语（英国）',
    'ja-JP': '日语',
    'ko-KR': '韩语'
  };

  // ---------------------------------------------------------------- 工具

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function str(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  /**
   * 只在取到正整数时才覆盖，否则保留原值。
   * 不能直接用 num(v, dflt)：aid/cid 里 0 表示"没有"，但 num 认为 0 是合法数字，
   * 于是缺省值永远不生效 —— 顶层那个空的 state.aid 会把已经取到的 aid 抹成 0。
   */
  function positive(v, dflt) {
    var n = num(v, 0);
    return n > 0 ? n : dflt;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 协议相对化：//aisubtitle... 这样在 https 页面里不会触发混合内容拦截 */
  function toProtocolRelative(url) {
    return str(url).replace(/^https?:/i, '');
  }

  // ---------------------------------------------------------------- 地址解析

  /** 从任意文本里抓 BV 号（BV + 10 位 base58 字符） */
  function parseBvid(text) {
    var m = /BV[0-9A-Za-z]{10}/.exec(str(text));
    return m ? m[0] : '';
  }

  /** 从任意文本里抓 av 号（返回数字，无则 0） */
  function parseAvid(text) {
    var m = /\bav(\d{1,12})\b/i.exec(str(text));
    return m ? num(m[1]) : 0;
  }

  /** 分P 参数 p（1-based），无则 1 */
  function parsePageParam(url) {
    var m = /[?&]p=(\d{1,4})/.exec(str(url));
    var p = m ? num(m[1], 1) : 1;
    return p >= 1 ? p : 1;
  }

  function isBiliVideoUrl(url) {
    var u = str(url);
    return /^https:\/\/www\.bilibili\.com\/(video|bangumi\/play|list|medialist\/play|watchlater)\//.test(u)
      || /^https:\/\/www\.bilibili\.com\/video\//.test(u);
  }

  /**
   * 从页面 SSR 数据 `window.__INITIAL_STATE__` 里抽 aid / cid / bvid。
   * 结构随页面类型变化（普通投稿 / 番剧 / 合集），所以按多路径尝试。
   */
  function idsFromInitialState(state) {
    var out = { aid: 0, cid: 0, bvid: '', page: 1, part: '' };
    if (!isObj(state)) return out;

    // 分P 序号（普通投稿的当前 P，1-based）
    var page = num(state.p, 1);
    if (page >= 1) out.page = page;

    // 路径 1：普通投稿 videoData
    if (isObj(state.videoData)) {
      var vd = state.videoData;
      out.aid = positive(vd.aid, out.aid);
      out.bvid = str(vd.bvid) || out.bvid;
      out.cid = positive(vd.cid, out.cid);
      if (Array.isArray(vd.pages) && vd.pages.length) {
        var pg = vd.pages[out.page - 1] || vd.pages[0];
        if (isObj(pg)) {
          out.cid = positive(pg.cid, out.cid);
          out.part = str(pg.part);
        }
      }
    }

    // 路径 2：番剧/剧集 epInfo
    if (isObj(state.epInfo)) {
      out.aid = positive(state.epInfo.aid, out.aid);
      out.bvid = str(state.epInfo.bvid) || out.bvid;
      out.cid = positive(state.epInfo.cid, out.cid);
    }
    if (isObj(state.epList) && Array.isArray(state.epList)) {
      var epId = positive(state.epInfo && state.epInfo.ep_id, 0);
      for (var i = 0; i < state.epList.length; i++) {
        var ep = state.epList[i];
        if (isObj(ep) && num(ep.ep_id) === epId) {
          out.aid = positive(ep.aid, out.aid);
          out.cid = positive(ep.cid, out.cid);
          out.bvid = str(ep.bvid) || out.bvid;
          break;
        }
      }
    }

    // 路径 3：合集/播放列表
    if (isObj(state.mediaListInfo) && isObj(state.mediaListInfo.media_list)) {
      var ml = state.mediaListInfo.media_list;
      out.aid = positive(ml.aid, out.aid);
      out.bvid = str(ml.bvid) || out.bvid;
      if (Array.isArray(ml.pages) && ml.pages.length) {
        var mp = ml.pages[out.page - 1] || ml.pages[0];
        if (isObj(mp)) out.cid = positive(mp.cid, out.cid);
      }
    }

    // 顶层兜底
    out.aid = positive(state.aid, out.aid);
    out.bvid = str(state.bvid) || out.bvid;
    out.cid = positive(state.cid, out.cid);
    if (isObj(state.videoInfo)) {
      out.aid = positive(state.videoInfo.aid, out.aid);
      out.bvid = str(state.videoInfo.bvid) || out.bvid;
      out.cid = positive(state.videoInfo.cid, out.cid);
    }

    return out;
  }

  // ---------------------------------------------------------------- 接口判定

  /** 是否是"播放器信息"接口（字幕列表就藏在这个响应里） */
  function isPlayerInfoUrl(url) {
    var u = str(url);
    if (!u) return false;
    // 去掉 query 后判断，避免误伤 player/v2 之外的接口
    var path = u.split('#')[0].split('?')[0];
    return PLAYER_INFO_RE.test(path);
  }

  /** 是否是字幕/播放器相关接口（预取时用不到，调试与日志用） */
  function isSubtitleRelatedUrl(url) {
    var u = str(url);
    return isPlayerInfoUrl(u) || /\/x\/v2\/dm\/(?:view|web\/subtitles)/.test(u);
  }

  // ---------------------------------------------------------------- 字幕提取

  /**
   * 从任意一个候选接口的响应体里抽出 subtitle 对象。
   * 兼容：{data:{subtitle}} / {data:{data:{subtitle}}} / {subtitle}
   */
  function extractSubtitle(payload) {
    if (!isObj(payload)) return null;
    if (payload.code !== undefined && num(payload.code, 0) !== 0) return null;

    var candidates = [];
    if (isObj(payload.data)) {
      candidates.push(payload.data.subtitle);
      candidates.push(payload.data);
      if (isObj(payload.data.data)) {
        candidates.push(payload.data.data.subtitle);
      }
    }
    candidates.push(payload.subtitle);

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!isObj(c)) continue;
      if (Array.isArray(c.subtitles) && c.subtitles.length) return c;
    }
    return null;
  }

  /** 是不是 AI 自动生成字幕 */
  function isAiEntry(entry) {
    if (!isObj(entry)) return false;
    if (AI_LAN_RE.test(str(entry.lan))) return true;
    return /自动生成/.test(str(entry.lan_doc));
  }

  /**
   * 规范化一个字幕条目。
   * 注意两处「强行」：
   *  - `is_lock` 一律置 false：否则播放器把该语言标为锁定、不给点。
   *  - `subtitle_url` 转协议相对：与 B 站前端写法一致，避免 https 页面混合内容拦截。
   */
  function normalizeEntry(raw) {
    if (!isObj(raw)) return null;
    var lan = str(raw.lan);
    var url = str(raw.subtitle_url || raw.url);
    if (!lan || !url) return null;
    return {
      id: num(raw.id),
      id_str: str(raw.id_str) || str(raw.id),
      lan: lan,
      lan_doc: str(raw.lan_doc) || langLabel(lan),
      is_lock: false,
      subtitle_url: toProtocolRelative(url),
      type: raw.type === undefined ? (isAiEntry(raw) ? 1 : 0) : num(raw.type),
      ai_type: num(raw.ai_type),
      ai_status: num(raw.ai_status)
    };
  }

  /**
   * ★ 核心：把预取到的字幕合并进播放器接口的响应体，就地修改并返回结果。
   *
   * 这是整个插件"强行让 AI 字幕开关出现"的落点：
   * 播放器拿到这份被改过的 JSON 后，会自己渲染出字幕语言列表（含 AI 字幕），
   * 点击即可加载，无需我们再插手 UI。
   *
   * @param {object} body     播放器接口响应（会被就地修改）
   * @param {object} subtitle 预取到的 subtitle 对象
   * @param {object} [opts]   { forceUnlock:boolean }
   * @returns {{ok:boolean, added:number, total:number, reason:string}}
   */
  function mergeSubtitle(body, subtitle, opts) {
    var o = opts || {};
    var forceUnlock = o.forceUnlock !== false;

    if (!isObj(body)) return fail('响应不是对象');
    var data = body.data;
    if (!isObj(data)) return fail('响应里没有 data');

    var incoming = isObj(subtitle) && Array.isArray(subtitle.subtitles)
      ? subtitle.subtitles : [];
    if (!incoming.length) return fail('没有可注入的字幕数据');

    var cur = isObj(data.subtitle) ? data.subtitle : {};
    var list = Array.isArray(cur.subtitles) ? cur.subtitles.slice() : [];

    // 去重键：优先 id_str，没有就按 lan
    var seenId = Object.create(null);
    var seenLan = Object.create(null);
    var existing = list.length;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!isObj(e)) continue;
      if (e.id_str) seenId[str(e.id_str)] = 1;
      if (e.lan) seenLan[str(e.lan)] = 1;
      // 已存在的条目也顺手解锁（有的视频字幕条目本身被标了 lock）
      if (forceUnlock && e.is_lock) e.is_lock = false;
    }

    var added = 0;
    for (var j = 0; j < incoming.length; j++) {
      var ne = normalizeEntry(incoming[j]);
      if (!ne) continue;
      if (ne.id_str && seenId[ne.id_str]) {
        if (forceUnlock) unlockExisting(list, ne);
        continue;
      }
      if (seenLan[ne.lan]) continue;
      list.push(ne);
      if (ne.id_str) seenId[ne.id_str] = 1;
      seenLan[ne.lan] = 1;
      added++;
    }

    if (added === 0 && !forceUnlock) return fail('没有新增字幕条目');

    data.subtitle = {
      allow_submit: cur.allow_submit === undefined ? true : cur.allow_submit,
      lan: str(cur.lan),
      lan_doc: str(cur.lan_doc),
      subtitles: list
    };

    // ★ 拆掉"必须登录才能看字幕"的闸门：
    //   数据已经在我们手里了，这个标记若留着，播放器会拒绝渲染字幕 UI。
    var unlockedLogin = false;
    if (forceUnlock && data.need_login_subtitle) {
      data.need_login_subtitle = false;
      unlockedLogin = true;
    }

    return {
      ok: true,
      added: added,
      total: list.length,
      existing: existing,
      unlockedLogin: unlockedLogin,
      reason: added ? 'ok' : 'already-present'
    };

    function fail(reason) {
      return { ok: false, added: 0, total: 0, existing: 0, unlockedLogin: false, reason: reason };
    }

    function unlockExisting(arr, entry) {
      for (var k = 0; k < arr.length; k++) {
        var it = arr[k];
        if (isObj(it) && (str(it.id_str) === entry.id_str || str(it.lan) === entry.lan)) {
          it.is_lock = false;
        }
      }
    }
  }

  /** 读出响应体里的字幕列表（调试/状态展示用） */
  function readSubtitles(body) {
    if (!isObj(body) || !isObj(body.data) || !isObj(body.data.subtitle)) return [];
    var arr = body.data.subtitle.subtitles;
    return Array.isArray(arr) ? arr : [];
  }

  // ---------------------------------------------------------------- 语言选择

  function langLabel(lan) {
    var l = str(lan);
    if (LANG_LABEL[l]) return LANG_LABEL[l];
    if (AI_LAN_RE.test(l)) return l.replace(/^ai-/i, '').toUpperCase() + '（AI 自动生成）';
    return l;
  }

  /** 语言偏好名 → 该偏好的候选 lan 列表 */
  function langCandidates(pref) {
    var p = str(pref).toLowerCase();
    if (LANG_ALIASES[p]) return LANG_ALIASES[p].slice();
    // 允许直接写具体语言码，如 "ai-zh"
    return p ? [p] : ['ai-zh'];
  }

  /**
   * 从字幕列表里按偏好挑轨道。
   * @returns {{primary:object|null, secondary:object|null, list:Array}}
   */
  function pickTracks(subtitles, prefs) {
    var p = prefs || {};
    var list = (Array.isArray(subtitles) ? subtitles : [])
      .map(normalizeEntry)
      .filter(Boolean);

    var primary = findByPref(list, p.primary || 'zh') || list[0] || null;
    var secondary = null;
    if (p.bilingual) {
      secondary = findByPref(list, p.secondary || 'en', primary);
      if (!secondary) {
        // 没有副语言偏好时，退而取任意不同语言的另一条
        for (var i = 0; i < list.length; i++) {
          if (primary && list[i].lan === primary.lan) continue;
          secondary = list[i];
          break;
        }
      }
    }
    return { primary: primary, secondary: secondary, list: list };
  }

  function findByPref(list, pref, exclude) {
    var cands = langCandidates(pref);
    var i, j;
    // 1) 精确匹配候选码
    for (i = 0; i < cands.length; i++) {
      for (j = 0; j < list.length; j++) {
        if (list[j].lan.toLowerCase() === cands[i].toLowerCase()) {
          if (exclude && list[j].lan === exclude.lan) continue;
          return list[j];
        }
      }
    }
    // 2) 前缀匹配（zh 命中 zh-Hans 之类）
    for (i = 0; i < cands.length; i++) {
      var base = cands[i].replace(/^ai-/i, '').split('-')[0].toLowerCase();
      for (j = 0; j < list.length; j++) {
        if (exclude && list[j].lan === exclude.lan) continue;
        if (list[j].lan.toLowerCase().replace(/^ai-/i, '').split('-')[0] === base) {
          return list[j];
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 字幕文件解析

  /**
   * B站字幕 JSON → 统一 cue 数组。
   * 标准形态：{ "body": [ {"from":0.0,"to":2.5,"content":"...","location":2}, ... ] }
   * 兼容 AI 字幕的几种变体（data / 直接数组 / start-end 命名）。
   */
  function parseCueList(json) {
    var arr = null;
    if (Array.isArray(json)) arr = json;
    else if (isObj(json)) {
      if (Array.isArray(json.body)) arr = json.body;
      else if (Array.isArray(json.data)) arr = json.data;
      else if (isObj(json.data) && Array.isArray(json.data.body)) arr = json.data.body;
    }
    if (!arr) return [];

    var cues = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!isObj(it)) continue;
      var from = pickNum(it.from, it.start, it.startTime, it.begin);
      var to = pickNum(it.to, it.end, it.endTime, it.finish);
      var text = str(it.content || it.text || it.body).replace(/\s+$/, '');
      if (from === null || !text) continue;
      if (to === null || to < from) to = from + 2;
      cues.push({
        from: from,
        to: to,
        text: text,
        location: it.location === undefined ? 2 : num(it.location, 2),
        sid: it.sid === undefined ? 0 : num(it.sid)
      });
    }
    cues.sort(function (a, b) { return a.from - b.from; });
    return cues;
  }

  function pickNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
      if (typeof v === 'string' && v !== '' && isFinite(parseFloat(v))) return parseFloat(v);
    }
    return null;
  }

  /**
   * 在按 from 升序排好的 cues 上二分查找 time 时刻应显示的条目。
   * 同一时刻可能有多条（AI 字幕会拆得很碎），返回最后一个匹配。
   */
  function findCueAt(cues, time) {
    if (!Array.isArray(cues) || !cues.length) return null;
    var lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].from <= time) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    for (var i = idx; i >= 0 && i > idx - 8; i--) {
      var c = cues[i];
      if (c.from <= time && time < c.to) return c;
    }
    return null;
  }

  function fmtTime(sec, sep) {
    var s = Math.max(0, Number(sec) || 0);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = Math.floor(s % 60);
    var ms = Math.round((s - Math.floor(s)) * 1000);
    if (ms === 1000) { ms = 0; ss += 1; }
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(ss, 2) + (sep || ',') + pad(ms, 3);
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function toSrt(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      out.push(String(i + 1));
      out.push(fmtTime(c.from, ',') + ' --> ' + fmtTime(c.to, ','));
      out.push(c.text);
      out.push('');
    }
    return out.join('\n');
  }

  function toPlainText(cues, joiner) {
    var j = joiner === undefined ? '' : joiner;
    var parts = [];
    for (var i = 0; i < cues.length; i++) parts.push(cues[i].text);
    return parts.join(j);
  }

  /** 把中英两条轨按时间轴合并成双语条目（用于双语显示） */
  function mergeBilingual(primary, secondary) {
    if (!Array.isArray(primary) || !primary.length) return [];
    if (!Array.isArray(secondary) || !secondary.length) {
      return primary.map(function (c) { return { from: c.from, to: c.to, text: c.text, sub: '' }; });
    }
    return primary.map(function (c) {
      var mid = (c.from + c.to) / 2;
      var other = findCueAt(secondary, mid) || findCueAt(secondary, c.from);
      return { from: c.from, to: c.to, text: c.text, sub: other ? other.text : '' };
    });
  }

  function summarizeSubtitles(subtitles) {
    var list = (Array.isArray(subtitles) ? subtitles : []).map(normalizeEntry).filter(Boolean);
    return {
      total: list.length,
      aiCount: list.filter(isAiEntry).length,
      languages: list.map(function (e) {
        return { lan: e.lan, label: e.lan_doc, ai: isAiEntry(e) };
      })
    };
  }

  // ---------------------------------------------------------------- 导出

  return {
    // 常量
    API_HOST: API_HOST,
    SUBTITLE_ENDPOINTS: SUBTITLE_ENDPOINTS,
    LANG_ALIASES: LANG_ALIASES,
    LANG_LABEL: LANG_LABEL,

    // 工具
    isObj: isObj,
    toProtocolRelative: toProtocolRelative,
    clamp: clamp,

    // 地址解析
    parseBvid: parseBvid,
    parseAvid: parseAvid,
    parsePageParam: parsePageParam,
    isBiliVideoUrl: isBiliVideoUrl,
    idsFromInitialState: idsFromInitialState,

    // 接口判定
    isPlayerInfoUrl: isPlayerInfoUrl,
    isSubtitleRelatedUrl: isSubtitleRelatedUrl,

    // 提取与注入
    extractSubtitle: extractSubtitle,
    isAiEntry: isAiEntry,
    normalizeEntry: normalizeEntry,
    mergeSubtitle: mergeSubtitle,
    readSubtitles: readSubtitles,

    // 语言
    langLabel: langLabel,
    langCandidates: langCandidates,
    pickTracks: pickTracks,

    // 字幕内容
    parseCueList: parseCueList,
    findCueAt: findCueAt,
    fmtTime: fmtTime,
    toSrt: toSrt,
    toPlainText: toPlainText,
    mergeBilingual: mergeBilingual,
    summarizeSubtitles: summarizeSubtitles,

    // 元信息
    VERSION: '1.0.0'
  };
});
