/**
 * lib/providers.js —— 字幕数据源适配（全部是纯函数，不联网，可离线单测）
 *
 * 本项目有三类"服务端产出"的字幕来源，这个文件负责把它们的响应
 * 统一成同一种 cue 结构 `{from, to, text}`：
 *
 *   1. bili-conclusion  B 站「AI 视频总结」接口
 *      `x/web-interface/view/conclusion/get`
 *      —— ★ 这是**触发 B 站服务端为该视频生成 AI 字幕**的入口。
 *      没生成过的视频，请求它会把它丢进服务端 AI 处理队列（data.code=1 且 stid="0"），
 *      轮询到处理完成即可拿到 `model_result.subtitle[0].part_subtitle[]`。
 *
 *   2. bili-subtitle    B 站字幕轨接口（player/v2、dm/view 等）
 *      —— 返回的是"字幕列表"，每条含 subtitle_url，仍需再取一次字幕文件。
 *      这类字幕可以注入播放器，用 B 站原生字幕渲染。
 *
 *   3. external         第三方字幕接口（用户自配）
 *      —— 三种约定：返回 B 站格式的字幕列表 / 返回单个字幕文件地址 / 直接返回 cue 数组。
 *
 * 双出口：Node `require()` / 浏览器 `globalThis.BASFProviders`
 */
(function (root, factory) {
  var API = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.BASFProviders = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function str(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  // ================================================================ 1. AI 视频总结

  var CONCLUSION_URL = 'https://api.bilibili.com/x/web-interface/view/conclusion/get';

  /**
   * 判定 AI 总结接口返回的状态。
   *
   * @returns {{state:string, message:string, stid:string, resultType:number, summary:string}}
   *   state 取值：
   *     'ready'        已有服务端生成的字幕
   *     'summary-only' 只有摘要和提纲，服务端没产出字幕（可能视频无人声）
   *     'pending'      ★ 已加入服务端 AI 处理队列，值得等 —— 调用方应轮询
   *     'no-speech'    明确未识别到语音（stid 为空），再等也没用
   *     'unsupported'  该视频不支持（敏感内容等）
   *     'need-login'   未登录（这个接口强制要求 SESSDATA）
   *     'forbidden'    访问权限不足
   *     'error'        其他错误
   */
  function analyzeConclusion(json) {
    var out = {
      state: 'error', message: '', stid: '', resultType: 0, summary: '', dataCode: null
    };

    if (!isObj(json)) {
      out.message = '响应不是对象';
      return out;
    }

    if (num(json.code, -1) !== 0) {
      out.message = str(json.message) || ('code=' + json.code);
      if (num(json.code) === -101) out.state = 'need-login';
      else if (num(json.code) === -403) out.state = 'forbidden';
      else out.state = 'error';
      return out;
    }

    // 未签名/签名错误时 B 站会返回 v_voucher 而不是正常结构
    if (json.data && json.data.v_voucher) {
      out.state = 'error';
      out.message = 'WBI 签名未通过（返回 v_voucher）';
      return out;
    }

    var data = json.data;
    if (!isObj(data)) {
      out.message = 'data 缺失';
      return out;
    }

    out.dataCode = num(data.code, 0);
    out.stid = str(data.stid);
    out.summary = isObj(data.model_result) ? str(data.model_result.summary) : '';
    out.resultType = isObj(data.model_result) ? num(data.model_result.result_type, 0) : 0;

    if (out.dataCode === -1) {
      out.state = 'unsupported';
      out.message = '该视频不支持 AI 摘要（敏感内容或其他原因）';
      return out;
    }

    // 有结果：result_type 2 才带字幕
    if (out.dataCode === 0) {
      if (out.resultType === 2 && extractConclusionCues(json).length) {
        out.state = 'ready';
        return out;
      }
      out.state = 'summary-only';
      out.message = '服务端只产出了摘要，没有字幕';
      return out;
    }

    // data.code === 1：还没有结果
    if (out.dataCode === 1) {
      if (out.stid === '' || out.stid === 'null' || out.stid === 'undefined') {
        // stid 为空 = 未识别到语音，等下去也不会有
        out.state = 'no-speech';
        out.message = '服务端未识别到语音';
        return out;
      }
      // stid === "0" 或已分配 id 但还没出结果 —— 都在服务端队列里
      out.state = 'pending';
      out.message = out.stid === '0'
        ? '已加入服务端 AI 处理队列'
        : '服务端正在生成（任务 ' + out.stid + '）';
      return out;
    }

    out.message = '未知的 data.code=' + data.code;
    return out;
  }

  /**
   * 从 AI 总结响应里抽出字幕 cue。
   * 结构：model_result.subtitle[0].part_subtitle[] = {content, start_timestamp, end_timestamp}
   */
  function extractConclusionCues(json) {
    var mr = json && json.data && json.data.model_result;
    if (!isObj(mr)) return [];
    return cuesFromPartSubtitles(mr.subtitle);
  }

  /** 与上面解耦，方便单测直接喂 subtitle 数组 */
  function cuesFromPartSubtitles(subtitle) {
    var list = arr(subtitle);
    var cues = [];
    for (var i = 0; i < list.length; i++) {
      var parts = arr(list[i] && list[i].part_subtitle);
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        if (!isObj(p)) continue;
        var text = str(p.content).trim();
        if (!text) continue;
        var from = num(p.start_timestamp, NaN);
        var to = num(p.end_timestamp, NaN);
        if (!isFinite(from)) continue;
        if (!isFinite(to) || to < from) to = from + 2;
        cues.push({ from: from, to: to, text: text });
      }
    }
    cues.sort(function (a, b) { return a.from - b.from; });
    return cues;
  }

  /** 把 AI 总结的提纲也提出来（顺带的增值信息，面板里可以展示） */
  function extractConclusionOutline(json) {
    var mr = json && json.data && json.data.model_result;
    if (!isObj(mr)) return [];
    var out = [];
    arr(mr.outline).forEach(function (sec) {
      if (!isObj(sec)) return;
      out.push({
        title: str(sec.title),
        timestamp: num(sec.timestamp, 0),
        points: arr(sec.part_outline).map(function (p) {
          return { timestamp: num(p && p.timestamp, 0), content: str(p && p.content) };
        })
      });
    });
    return out;
  }

  // ================================================================ 2. 第三方接口

  /**
   * 占位符替换。已知变量做 URL 编码后填入；未知占位符原样保留
   * （保留比替换成空串好 —— 用户能一眼看出模板写错了）。
   */
  function subst(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (whole, name) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
      return encodeURIComponent(String(vars[name]));
    });
  }

  /** 只替换已知变量，不做编码（给 header 值用） */
  function fillTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (whole, name) {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole;
      return String(vars[name]);
    });
  }

  /** 按点号路径取值，如 pickPath(obj, 'data.data') */
  function pickPath(obj, path) {
    if (!path) return obj;
    var cur = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i];
      if (key === '') continue;
      if (cur === null || cur === undefined) return undefined;
      // 支持 data[0] 这种写法
      var m = /^([^\[\]]*)\[(\d+)\]$/.exec(key);
      if (m) {
        if (m[1]) cur = cur[m[1]];
        cur = cur ? cur[Number(m[2])] : undefined;
      } else {
        cur = cur[key];
      }
    }
    return cur;
  }

  /**
   * 内置的第三方接口预设。
   *
   * mode 决定怎么解读响应：
   *   'bili-subtitle-list' 响应里是一组 B 站格式的字幕条目（含 subtitle_url / lan），
   *                        拿到后还需要再取一次字幕文件 —— justoneapi 就是这种
   *   'bili-subtitle-url'  响应里直接是一个字幕文件的 URL
   *   'cues'               响应里直接是 cue 数组，字段名可配
   */
  var EXTERNAL_PRESETS = {
    justoneapi: {
      id: 'justoneapi',
      label: 'JustOneAPI · B站视频字幕',
      method: 'GET',
      url: 'https://api.justoneapi.com/api/bilibili/get-video-caption/v2?token={token}&bvid={bvid}&aid={aid}&cid={cid}',
      tokenIn: 'url',
      mode: 'bili-subtitle-list',
      listPath: 'data.data',
      /** 该服务的业务错误码 */
      errorCodes: {
        '0': null,
        '100': 'Token 无效或已失效',
        '301': '采集失败，请重试',
        '302': '触发限流',
        '303': '超出每日配额',
        '400': '参数错误',
        '600': '无权限',
        '601': '账户余额不足',
        '602': '该 Token 预算已用尽'
      },
      timeoutMs: 120000
    },
    generic: {
      id: 'generic',
      label: '自定义接口（模板）',
      method: 'GET',
      url: '',
      tokenIn: 'header',
      tokenHeader: 'Authorization',
      tokenPrefix: 'Bearer ',
      mode: 'cues',
      listPath: '',
      textField: 'content',
      fromField: 'start_timestamp',
      toField: 'end_timestamp',
      timeoutMs: 30000
    }
  };

  /**
   * 构造第三方请求。
   * @returns {{url:string, method:string, headers:Array<{name,value}>}|null}
   */
  function buildExternalRequest(preset, ids, config) {
    var p = preset || EXTERNAL_PRESETS.generic;
    var cfg = config || {};
    var tpl = cfg.urlTemplate || p.url;
    if (!tpl) return null;

    var vars = {
      bvid: str(ids && ids.bvid),
      aid: str(ids && ids.aid),
      cid: str(ids && ids.cid),
      upMid: str(ids && ids.upMid),
      token: str(cfg.token)
    };

    var headers = [];
    var tokenIn = cfg.tokenIn || p.tokenIn || 'header';
    var prefix = p.tokenPrefix === undefined ? '' : p.tokenPrefix;

    if (tokenIn === 'header') {
      var headerName = cfg.tokenHeader || p.tokenHeader || 'Authorization';
      headers.push({ name: headerName, value: fillTemplate(prefix + '{token}', vars) });
    }
    // tokenIn === 'url' 时 token 已经在模板里了

    if (isObj(cfg.extraHeaders)) {
      Object.keys(cfg.extraHeaders).forEach(function (k) {
        headers.push({ name: k, value: String(cfg.extraHeaders[k]) });
      });
    }

    return {
      url: subst(tpl, vars),
      method: (cfg.method || p.method || 'GET').toUpperCase(),
      headers: headers,
      timeoutMs: num(cfg.timeoutMs, num(p.timeoutMs, 30000))
    };
  }

  /**
   * 解读第三方响应。
   * @returns {{ok:boolean, kind:string, entries?:Array, url?:string, cues?:Array, error?:string}}
   *   kind: 'subtitle-list' | 'subtitle-url' | 'cues'
   */
  function parseExternalResponse(preset, config, json) {
    var p = preset || EXTERNAL_PRESETS.generic;
    var cfg = config || {};
    var mode = cfg.mode || p.mode || 'cues';

    // 业务错误码
    var codes = p.errorCodes;
    if (isObj(codes) && isObj(json) && json.code !== undefined) {
      var key = String(json.code);
      if (Object.prototype.hasOwnProperty.call(codes, key)) {
        var msg = codes[key];
        if (msg) return { ok: false, kind: mode, error: msg };
      }
    }

    if (mode === 'bili-subtitle-list') {
      var list = pickPath(json, cfg.listPath || p.listPath || '');
      if (!Array.isArray(list)) {
        return { ok: false, kind: mode, error: '按路径 ' + (cfg.listPath || p.listPath) + ' 没取到字幕数组' };
      }
      var entries = list.map(function (it) {
        if (!isObj(it)) return null;
        var url = str(it.subtitle_url || it.url);
        if (!url) return null;
        return {
          lan: str(it.lan) || 'external',
          lan_doc: str(it.lan_doc) || str(it.lan) || '第三方字幕',
          subtitle_url: url.replace(/^https?:/i, ''),
          is_lock: false,
          type: 1
        };
      }).filter(Boolean);
      if (!entries.length) return { ok: false, kind: mode, error: '字幕数组为空' };
      return { ok: true, kind: mode, entries: entries };
    }

    if (mode === 'bili-subtitle-url') {
      var rawUrl = pickPath(json, cfg.urlPath || p.urlPath || '');
      // 注意：空路径会把整个对象原样返回，所以必须先确认拿到的是字符串
      if (typeof rawUrl !== 'string') rawUrl = '';
      if (!rawUrl) {
        var cands = ['url', 'subtitle_url', 'data.subtitle_url', 'data.url', 'data.data.subtitle_url'];
        for (var ci = 0; ci < cands.length; ci++) {
          var v = pickPath(json, cands[ci]);
          if (typeof v === 'string' && v) { rawUrl = v; break; }
        }
      }
      if (!rawUrl && typeof json === 'string') rawUrl = json;
      if (!rawUrl) return { ok: false, kind: mode, error: '响应里没有字幕文件地址' };
      return { ok: true, kind: mode, url: rawUrl };
    }

    // mode === 'cues'：直接是数组
    var raw = pickPath(json, cfg.listPath || p.listPath || '');
    if (!Array.isArray(raw)) raw = Array.isArray(json) ? json : null;
    if (!raw) return { ok: false, kind: 'cues', error: '响应里没有找到字幕数组' };

    var textField = cfg.textField || p.textField || 'content';
    var fromField = cfg.fromField || p.fromField || 'from';
    var toField = cfg.toField || p.toField || 'to';
    var cues = [];
    raw.forEach(function (it) {
      if (!isObj(it)) return;
      var text = str(it[textField]).trim();
      var from = num(it[fromField], NaN);
      var to = num(it[toField], NaN);
      if (!text || !isFinite(from)) return;
      if (!isFinite(to) || to < from) to = from + 2;
      cues.push({ from: from, to: to, text: text });
    });
    if (!cues.length) return { ok: false, kind: 'cues', error: '解析后没有有效字幕' };
    cues.sort(function (a, b) { return a.from - b.from; });
    return { ok: true, kind: 'cues', cues: cues };
  }

  /** 把第三方返回的字幕条目也要能转成 cue —— 复用 bili-api 的解析器 */
  function subtitleEntriesToTracks(entries, BiliApi) {
    if (!BiliApi || !Array.isArray(entries)) return { primary: null, secondary: null, list: [] };
    return BiliApi.pickTracks(entries, { primary: 'zh', bilingual: false });
  }

  return {
    CONCLUSION_URL: CONCLUSION_URL,

    analyzeConclusion: analyzeConclusion,
    extractConclusionCues: extractConclusionCues,
    cuesFromPartSubtitles: cuesFromPartSubtitles,
    extractConclusionOutline: extractConclusionOutline,

    EXTERNAL_PRESETS: EXTERNAL_PRESETS,
    subst: subst,
    fillTemplate: fillTemplate,
    pickPath: pickPath,
    buildExternalRequest: buildExternalRequest,
    parseExternalResponse: parseExternalResponse,
    subtitleEntriesToTracks: subtitleEntriesToTracks,

    VERSION: '1.0.0'
  };
});
