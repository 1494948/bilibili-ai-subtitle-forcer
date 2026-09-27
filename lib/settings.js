/**
 * lib/settings.js —— 设置模型（默认值 + 规范化 + 变更校验）
 *
 * 存储位置：chrome.storage.local（不用 sync —— 里面可能含 ASR 接口密钥，
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

    /** 注入方式：player = 用 B站原生渲染 / overlay = 自建渲染层 / both = 都开
     *  默认 both：原生层让"AI 字幕开关"真正出现（核心诉求），
     *  自建层则撑起双语与样式自定义。自建层开启时会隐藏原生字幕，两层不会打架。 */
    injectInto: 'both',

    /** 注入成功后自动把 AI 字幕点开 */
    autoOpen: true,
    /** 自动点开的起始延迟（毫秒），太早点不到播放器的按钮 */
    autoOpenDelay: 900,
    /** 自动点开的最长重试时长（毫秒） */
    autoOpenTimeout: 12000,

    /** 双语：同时加载两条轨，上下两行 */
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

    /** ASR 兜底：服务端确实没有 AI 字幕时，现场识别音频 */
    asr: {
      enabled: false,
      endpoint: '',
      apiKey: '',
      model: 'whisper-1',
      language: 'zh',
      chunkSeconds: 20,
      maxMinutes: 20,
      prompt: ''
    },

    /** 调试日志 */
    debug: false,

    /** 统计（由插件自己累加，不给用户改） */
    stats: {
      injectedVideos: 0,
      injectedEntries: 0,
      asrRuns: 0
    }
  };

  var INJECT_MODES = ['player', 'overlay', 'both'];

  var STYLE_LIMITS = {
    fontSize: [10, 72],
    strokeWidth: [0, 8],
    bgOpacity: [0, 1],
    bottom: [0, 60],
    maxWidth: [20, 100],
    secondaryScale: [0.4, 1.5]
  };

  var ASR_LIMITS = {
    chunkSeconds: [5, 60],
    maxMinutes: [1, 120]
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

  function hexColor(v, dflt) {
    var s = str(v).trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : dflt;
  }

  /** 深拷贝默认值（避免调用方改到 DEFAULTS） */
  function defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  /**
   * 把任意外来对象规范成合法设置：缺项补默认、越界钳制、非法值丢弃。
   * 对 UI 传参与存储读回都用它，保证下游永远拿到完整可信的结构。
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

    if (INJECT_MODES.indexOf(patch.injectInto) >= 0) out.injectInto = patch.injectInto;

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

    if (isObj(patch.asr)) {
      var a = patch.asr;
      out.asr.enabled = bool(a.enabled, out.asr.enabled);
      out.asr.endpoint = str(a.endpoint, out.asr.endpoint).trim();
      out.asr.apiKey = str(a.apiKey, out.asr.apiKey);
      out.asr.model = str(a.model, out.asr.model) || 'whisper-1';
      out.asr.language = str(a.language, out.asr.language) || 'zh';
      out.asr.chunkSeconds = clampNum(a.chunkSeconds, ASR_LIMITS.chunkSeconds[0], ASR_LIMITS.chunkSeconds[1], out.asr.chunkSeconds);
      out.asr.maxMinutes = clampNum(a.maxMinutes, ASR_LIMITS.maxMinutes[0], ASR_LIMITS.maxMinutes[1], out.asr.maxMinutes);
      out.asr.prompt = str(a.prompt, out.asr.prompt);
    }

    if (isObj(patch.stats)) {
      out.stats.injectedVideos = clampNum(patch.stats.injectedVideos, 0, 1e9, 0);
      out.stats.injectedEntries = clampNum(patch.stats.injectedEntries, 0, 1e9, 0);
      out.stats.asrRuns = clampNum(patch.stats.asrRuns, 0, 1e9, 0);
    }

    return out;
  }

  /** ASR 配置是否完整到能跑 */
  function asrReady(settings) {
    var a = settings && settings.asr;
    if (!isObj(a) || !a.enabled) return false;
    return /^https?:\/\//i.test(str(a.endpoint));
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    INJECT_MODES: INJECT_MODES,
    STYLE_LIMITS: STYLE_LIMITS,
    ASR_LIMITS: ASR_LIMITS,
    defaults: defaults,
    normalize: normalize,
    asrReady: asrReady
  };
});
