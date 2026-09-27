/**
 * lib/settings.js —— 设置模型（默认值 + 规范化 + 越界钳制）
 *
 * 存储位置：chrome.storage.local（不用 sync —— 里面含第三方接口的密钥，
 * 不应该被同步到云端与其他设备）。
 *
 * 双出口：Node `require()` / 浏览器 `globalThis.BASFSettings`
 */
(function (root, factory) {
  var API = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.BASFSettings = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'basf_settings';

  var DEFAULTS = {
    /** 总开关 */
    enabled: true,

    /** 强制注入：在播放器接口响应里补上字幕列表并拆掉登录闸门 */
    forceInject: true,

    /** 输出方式：player = 只在 B 站原生字幕上输出 / overlay = 只用自建字幕层 /
     *  both = 都开。自建层开启时会隐藏原生字幕，两层不打架。 */
    injectInto: 'both',

    /** 注入成功后自动把 AI 字幕点开 */
    autoOpen: true,
    autoOpenDelay: 900,
    autoOpenTimeout: 12000,

    /** 双语：同时加载两条轨，上下两行显示 */
    bilingual: false,
    primaryLang: 'zh',
    secondaryLang: 'en',

    /** 自建渲染层样式 */
    style: {
      fontSize: 26,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 2,
      bgColor: '#000000',
      bgOpacity: 0.45,
      bottom: 8,
      maxWidth: 84,
      fontFamily: '',
      secondaryScale: 0.82,
      shadow: true
    },

    /**
     * 字幕来源。三条线各自独立开关，按 existing → conclusion → external 的顺序尝试，
     * 前一条拿到结果就不再往下走。
     */
    sources: {
      /** B 站已有的字幕轨（player/v2、dm/view）。这类能注入播放器、用原生字幕渲染 */
      existing: true,
      /** ★ B 站服务端 AI 生成：调 AI 视频总结接口，没生成过的会被服务端排队处理 */
      conclusion: true,
      /** 等待服务端生成的最长秒数（超时就先放着，下次打开视频还能拿到） */
      conclusionWait: 90,
      /** 第三方字幕接口 */
      external: false,
      externalPreset: 'generic',
      externalUrl: '',
      externalToken: '',
      externalTokenIn: 'url',
      externalTokenHeader: 'Authorization',
      externalMode: 'cues',
      externalListPath: '',
      externalTextField: 'content',
      externalFromField: 'start_timestamp',
      externalToField: 'end_timestamp'
    },

    /** 调试日志 */
    debug: false,

    /** 统计（插件自己累加，不给用户改） */
    stats: {
      injectedVideos: 0,
      injectedEntries: 0,
      conclusionReady: 0,
      externalReady: 0
    }
  };

  var INJECT_MODES = ['player', 'overlay', 'both'];

  /** 第三方接口解读响应的方式 */
  var EXTERNAL_MODES = ['bili-subtitle-list', 'bili-subtitle-url', 'cues'];

  /** 内置的第三方接口预设 */
  var EXTERNAL_PRESETS = ['generic', 'justoneapi'];

  /** 密钥在 URL 里还是在请求头里 */
  var TOKEN_IN = ['url', 'header'];

  var STYLE_LIMITS = {
    fontSize: [10, 72],
    strokeWidth: [0, 8],
    bgOpacity: [0, 1],
    bottom: [0, 60],
    maxWidth: [20, 100],
    secondaryScale: [0.4, 1.5]
  };

  var SOURCE_LIMITS = {
    conclusionWait: [0, 900]
  };

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function clampNum(v, lo, hi, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return dflt;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function bool(v, dflt) {
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return dflt;
  }

  function str(v, dflt) {
    return typeof v === 'string' ? v : (v === undefined || v === null ? (dflt || '') : String(v));
  }

  function oneOf(v, allowed, dflt) {
    return allowed.indexOf(v) >= 0 ? v : dflt;
  }

  function hexColor(v, dflt) {
    var s = str(v).trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : dflt;
  }

  function defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  /**
   * 把任意外来对象规范成合法设置：缺项补默认、越界钳制、非法值丢弃。
   * UI 传参与存储读回都走它，保证下游永远拿到完整可信的结构。
   */
  function normalize(patch) {
    var out = defaults();
    if (!isObj(patch)) return out;

    out.enabled = bool(patch.enabled, out.enabled);
    out.forceInject = bool(patch.forceInject, out.forceInject);
    out.bilingual = bool(patch.bilingual, out.bilingual);
    out.autoOpen = bool(patch.autoOpen, out.autoOpen);
    out.debug = bool(patch.debug, out.debug);

    out.autoOpenDelay = clampNum(patch.autoOpenDelay, 0, 10000, out.autoOpenDelay);
    out.autoOpenTimeout = clampNum(patch.autoOpenTimeout, 1000, 60000, out.autoOpenTimeout);

    out.injectInto = oneOf(patch.injectInto, INJECT_MODES, out.injectInto);
    out.primaryLang = str(patch.primaryLang, out.primaryLang) || 'zh';
    out.secondaryLang = str(patch.secondaryLang, out.secondaryLang) || 'en';

    if (isObj(patch.style)) {
      var s = patch.style;
      out.style.fontSize = clampNum(s.fontSize, STYLE_LIMITS.fontSize[0], STYLE_LIMITS.fontSize[1], out.style.fontSize);
      out.style.color = hexColor(s.color, out.style.color);
      out.style.strokeColor = hexColor(s.strokeColor, out.style.strokeColor);
      out.style.strokeWidth = clampNum(s.strokeWidth, STYLE_LIMITS.strokeWidth[0], STYLE_LIMITS.strokeWidth[1], out.style.strokeWidth);
      out.style.bgColor = hexColor(s.bgColor, out.style.bgColor);
      out.style.bgOpacity = clampNum(s.bgOpacity, STYLE_LIMITS.bgOpacity[0], STYLE_LIMITS.bgOpacity[1], out.style.bgOpacity);
      out.style.bottom = clampNum(s.bottom, STYLE_LIMITS.bottom[0], STYLE_LIMITS.bottom[1], out.style.bottom);
      out.style.maxWidth = clampNum(s.maxWidth, STYLE_LIMITS.maxWidth[0], STYLE_LIMITS.maxWidth[1], out.style.maxWidth);
      out.style.secondaryScale = clampNum(s.secondaryScale, STYLE_LIMITS.secondaryScale[0], STYLE_LIMITS.secondaryScale[1], out.style.secondaryScale);
      out.style.fontFamily = str(s.fontFamily, out.style.fontFamily);
      out.style.shadow = bool(s.shadow, out.style.shadow);
    }

    if (isObj(patch.sources)) {
      var c = patch.sources;
      out.sources.existing = bool(c.existing, out.sources.existing);
      out.sources.conclusion = bool(c.conclusion, out.sources.conclusion);
      out.sources.conclusionWait = clampNum(c.conclusionWait, SOURCE_LIMITS.conclusionWait[0], SOURCE_LIMITS.conclusionWait[1], out.sources.conclusionWait);
      out.sources.external = bool(c.external, out.sources.external);
      out.sources.externalPreset = oneOf(c.externalPreset, EXTERNAL_PRESETS, out.sources.externalPreset);
      out.sources.externalUrl = str(c.externalUrl, out.sources.externalUrl).trim();
      out.sources.externalToken = str(c.externalToken, out.sources.externalToken);
      out.sources.externalTokenIn = oneOf(c.externalTokenIn, TOKEN_IN, out.sources.externalTokenIn);
      out.sources.externalTokenHeader = str(c.externalTokenHeader, out.sources.externalTokenHeader) || 'Authorization';
      out.sources.externalMode = oneOf(c.externalMode, EXTERNAL_MODES, out.sources.externalMode);
      out.sources.externalListPath = str(c.externalListPath, out.sources.externalListPath).trim();
      out.sources.externalTextField = str(c.externalTextField, out.sources.externalTextField) || 'content';
      out.sources.externalFromField = str(c.externalFromField, out.sources.externalFromField) || 'from';
      out.sources.externalToField = str(c.externalToField, out.sources.externalToField) || 'to';
    }

    if (isObj(patch.stats)) {
      out.stats.injectedVideos = clampNum(patch.stats.injectedVideos, 0, 1e9, 0);
      out.stats.injectedEntries = clampNum(patch.stats.injectedEntries, 0, 1e9, 0);
      out.stats.conclusionReady = clampNum(patch.stats.conclusionReady, 0, 1e9, 0);
      out.stats.externalReady = clampNum(patch.stats.externalReady, 0, 1e9, 0);
    }

    return out;
  }

  /** 第三方接口配置是否完整到能发请求 */
  function externalReady(settings) {
    var c = settings && settings.sources;
    if (!isObj(c) || !c.external) return false;
    if (c.externalPreset === 'justoneapi') return !!c.externalToken;
    return /^https?:\/\//i.test(str(c.externalUrl));
  }

  /** 是否至少开了一条来源 */
  function anySourceEnabled(settings) {
    var c = settings && settings.sources;
    if (!isObj(c)) return false;
    return !!(c.existing || c.conclusion || c.external);
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    INJECT_MODES: INJECT_MODES,
    EXTERNAL_MODES: EXTERNAL_MODES,
    EXTERNAL_PRESETS: EXTERNAL_PRESETS,
    TOKEN_IN: TOKEN_IN,
    STYLE_LIMITS: STYLE_LIMITS,
    SOURCE_LIMITS: SOURCE_LIMITS,
    defaults: defaults,
    normalize: normalize,
    externalReady: externalReady,
    anySourceEnabled: anySourceEnabled
  };
});
