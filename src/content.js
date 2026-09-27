/**
 * src/content.js —— 内容脚本（ISOLATED world）／整个插件的编排层
 *
 * 它不直接改页面，而是：
 *   1. 与 MAIN world 的 hook 通过 postMessage 对话（hook 负责真正的注入）；
 *   2. 等注入成功后，**自动把 AI 字幕选项点开**（这才是用户看到的"能用"）；
 *   3. 需要双语或自定义样式时，拉字幕文件内容交给 overlay 渲染；
 *   4. 转发 popup 的指令（手动强制开启、启动 ASR 识别）。
 *
 * 状态机很关键：注入 → 播放器渲染语言列表 → 我们点开。
 * 中间每一步都有重试与超时，任何一个环节不成立都不应该影响视频播放。
 */
(function () {
  'use strict';

  var HAS_EXT = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  var NS = typeof globalThis !== 'undefined' ? globalThis.BASFBiliApi : null;
  var SET = typeof globalThis !== 'undefined' ? globalThis.BASFSettings : null;
  var OV = typeof globalThis !== 'undefined' ? globalThis.BASFOverlay : null;
  var ASR = typeof globalThis !== 'undefined' ? globalThis.BASFASR : null;
  if (!NS || !SET) return;

  var TAG = '[BASF/content]';

  // 播放器相关选择器（B站改版时主要改这里）
  var SEL = {
    videoWrap: '.bpx-player-video-wrap',
    videoArea: '.bpx-player-video-area',
    subtitleBtn: '.bpx-player-ctrl-btn.bpx-player-ctrl-subtitle',
    langItem: '.bpx-player-ctrl-subtitle-language-item',
    nativeSubtitle: '.bpx-player-subtitle-wrap'
  };

  var settings = SET.defaults();

  var st = {
    href: '',
    ids: null,
    subtitle: null,
    pick: null,
    injected: false,
    injectedAt: 0,
    cues: { primary: [], secondary: [] },
    overlayOn: false,
    reqSeq: 0,
    pending: Object.create(null),
    badge: null,
    badgeTimer: 0,
    autoOpenRunning: false,
    asrRunning: false,
    lastError: ''
  };

  // ------------------------------------------------------------ 基础工具

  function log() {
    if (!settings.debug) return;
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift(TAG);
      console.log.apply(console, a);
    } catch (e) { /* noop */ }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function toHook(type, payload) {
    try {
      window.postMessage({ __basf: true, dir: 'to-hook', type: type, payload: payload || null }, '*');
    } catch (e) { /* noop */ }
  }

  // ------------------------------------------------------------ 与 hook 通信

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__basf !== true || d.dir !== 'to-content') return;
    try {
      onHookMessage(d.type, d.payload);
    } catch (e) {
      log('处理 hook 消息出错', d.type, e);
    }
  });

  function onHookMessage(type, payload) {
    switch (type) {
      case 'hook-ready':
        log('hook 就绪', payload);
        pushSettings();
        toHook('request-state');
        break;

      case 'ids':
        st.ids = payload;
        break;

      case 'subtitle-ready':
        onSubtitleReady(payload);
        break;

      case 'injected':
        onInjected(payload);
        break;

      case 'subtitle-content':
        var res = st.pending[payload && payload.reqId];
        if (res) {
          delete st.pending[payload.reqId];
          res(payload.ok ? payload.cues : null);
        }
        break;

      case 'state':
        log('hook 状态', payload);
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  function pushSettings() {
    toHook('sync-settings', {
      forceInject: !!settings.forceInject,
      debug: !!settings.debug
    });
  }

  // ------------------------------------------------------------ 拿到字幕列表

  function onSubtitleReady(payload) {
    var sub = payload && payload.subtitle;
    st.ids = (payload && payload.ids) || st.ids;

    if (!sub || !sub.subtitles || !sub.subtitles.length) {
      st.subtitle = null;
      st.pick = null;
      setBadge('warn', '这个视频没有可用的 AI 字幕');
      log('没有预取到字幕', payload && payload.tried);
      maybeStartAsr();
      return;
    }

    st.subtitle = sub;
    rebuildPick(sub.subtitles);
    log('字幕列表就绪', NS.summarizeSubtitles(sub.subtitles));
    if (st.pick && st.pick.primary) {
      setBadge('ok', '已发现 ' + st.pick.primary.lan_doc);
    }
  }

  function rebuildPick(subtitles) {
    var pick = NS.pickTracks(subtitles, {
      primary: settings.primaryLang,
      secondary: settings.secondaryLang,
      bilingual: settings.bilingual
    });
    st.pick = pick;
    return pick;
  }

  // ------------------------------------------------------------ 注入成功

  function onInjected(payload) {
    st.injected = true;
    st.injectedAt = Date.now();
    st.lastError = '';
    log('注入成功', payload);

    if (st.pick && st.pick.primary) {
      var ai = NS.isAiEntry(st.pick.primary);
      setBadge('ok', (ai ? 'AI 字幕已就绪：' : '字幕已就绪：') + st.pick.primary.lan_doc);
    } else {
      setBadge('ok', '字幕数据已注入播放器');
    }

    if (payload && payload.first && HAS_EXT) {
      try {
        chrome.runtime.sendMessage({ type: 'bump-stat', field: 'injectedVideos', by: 1 });
        chrome.runtime.sendMessage({ type: 'bump-stat', field: 'injectedEntries', by: payload.added || 0 });
      } catch (e) { /* noop */ }
    }

    if (settings.autoOpen) {
      autoOpenSubtitle();
    }

    // 双语 / 自建渲染层需要字幕文件内容
    if (useOverlay()) {
      loadOverlayCues();
    }
  }

  // ------------------------------------------------------------ 打开 AI 字幕

  /**
   * 把注入出来的 AI 字幕真正"点开"。
   * 播放器的语言列表可能处于收起状态，所以先直接找 DOM；找不到就 hover 展开再找。
   * @param {boolean} [force] 跳过"是否开启自动打开"的检查（用户手动点了按钮）
   */
  function autoOpenSubtitle(force) {
    if (st.autoOpenRunning) return;
    if (!force && (!settings.enabled || !settings.autoOpen)) return;

    var target = st.pick && st.pick.primary ? st.pick.primary.lan : 'ai-zh';
    st.autoOpenRunning = true;

    var deadline = Date.now() + Math.max(2000, settings.autoOpenTimeout);
    var started = Date.now();
    var hovered = false;

    (function attempt() {
      if (!force && (!settings.enabled || !settings.autoOpen)) {
        st.autoOpenRunning = false;
        return;
      }

      var item = findLangItem(target);
      if (!item && target !== 'ai-zh') item = findLangItem('ai-zh');
      if (!item) item = findAnyAiLangItem();

      if (item) {
        if (!isLangActive(item)) {
          try { item.click(); } catch (e) { /* noop */ }
          log('已点击字幕语言项', item.getAttribute('data-lan'));
        }
        // 点完再确认一次状态，给播放器一点反应时间
        setTimeout(function () {
          var again = findLangItem(target) || findAnyAiLangItem();
          if (again && !isLangActive(again)) {
            try { again.click(); } catch (e) { /* noop */ }
          }
          st.autoOpenRunning = false;
        }, 500);
        return;
      }

      // 语言列表还没渲染出来：试着 hover 字幕按钮把菜单展开
      if (!hovered || Date.now() - started > 1500) {
        var btn = document.querySelector(SEL.subtitleBtn);
        if (btn) {
          hovered = true;
          ['mouseenter', 'mouseover', 'mousemove'].forEach(function (t) {
            try {
              btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
            } catch (e) { /* noop */ }
          });
        }
      }

      if (Date.now() > deadline) {
        st.autoOpenRunning = false;
        setBadge('warn', '字幕开关没等到，点一下播放器里的字幕图标试试');
        return;
      }
      setTimeout(attempt, 400);
    })();
  }

  function findLangItem(lan) {
    if (!lan) return null;
    try {
      return document.querySelector(SEL.langItem + '[data-lan="' + lan + '"]');
    } catch (e) {
      return null;
    }
  }

  function findAnyAiLangItem() {
    var items = document.querySelectorAll(SEL.langItem);
    for (var i = 0; i < items.length; i++) {
      var lan = items[i].getAttribute('data-lan') || '';
      if (/^ai-/i.test(lan)) return items[i];
    }
    return null;
  }

  function isLangActive(item) {
    if (!item) return false;
    var cls = item.className || '';
    return /bpx-state-active|active/.test(cls);
  }

  // ------------------------------------------------------------ 自建渲染层

  function useOverlay() {
    return settings.injectInto === 'overlay' || settings.injectInto === 'both';
  }

  function requestContent(url) {
    return new Promise(function (resolve) {
      var id = 'r' + (++st.reqSeq);
      st.pending[id] = resolve;
      toHook('fetch-subtitle-content', { url: url, reqId: id });
      setTimeout(function () {
        if (st.pending[id]) {
          delete st.pending[id];
          resolve(null);
        }
      }, 20000);
    });
  }

  function loadOverlayCues() {
    if (!st.pick || !st.pick.primary) return;
    var primary = st.pick.primary;
    var secondary = settings.bilingual ? st.pick.secondary : null;

    setBadge('info', '正在加载字幕内容…');

    requestContent(primary.subtitle_url).then(function (cues) {
      if (!cues || !cues.length) {
        setBadge('warn', '字幕内容取不到（可能已过期）');
        return;
      }
      st.cues.primary = cues;
      if (!secondary) {
        st.cues.secondary = [];
        mountOverlay();
        return;
      }
      return requestContent(secondary.subtitle_url).then(function (sub2) {
        st.cues.secondary = sub2 || [];
        if (!st.cues.secondary.length) {
          log('副语言字幕取不到，退化为单语');
        }
        mountOverlay();
      });
    }).catch(function (e) {
      log('加载字幕内容失败', e);
      setBadge('warn', '字幕内容加载失败');
    });
  }

  function mountOverlay() {
    if (!OV || !st.cues.primary.length) return;
    var wrap = document.querySelector(SEL.videoWrap) || document.querySelector(SEL.videoArea);
    if (!wrap) {
      setTimeout(function () {
        if (st.cues.primary.length) mountOverlay();
      }, 1000);
      return;
    }
    OV.mount(wrap, settings);
    OV.setCues(st.cues.primary, st.cues.secondary);
    OV.applySettings(settings);
    OV.setActive(true);
    st.overlayOn = true;
    document.body.classList.add('basf-overlay-on');
    setBadge('ok', '字幕渲染层已开启' + (settings.bilingual && st.cues.secondary.length ? '（双语）' : ''));
    log('overlay 已挂载', st.cues.primary.length, st.cues.secondary.length);
  }

  function unmountOverlay() {
    if (OV) OV.destroy();
    st.overlayOn = false;
    try { document.body.classList.remove('basf-overlay-on'); } catch (e) { /* noop */ }
  }

  // ------------------------------------------------------------ ASR 兜底

  /**
   * 服务端确实没字幕时：不自动开跑（那会消耗用户的接口额度），
   * 只给一个明确提示，由用户点浮标决定要不要现场识别。
   */
  function maybeStartAsr() {
    if (!settings.asr || !settings.asr.enabled) return;
    if (!SET.asrReady(settings)) {
      setBadge('warn', '这个视频没有 AI 字幕；ASR 兜底也还没配置好');
      return;
    }
    setBadge('warn', '这个视频没有 AI 字幕 —— 点这里现场识别');
  }

  function startAsr() {
    if (!ASR) return { ok: false, error: 'ASR 模块未加载' };
    if (st.asrRunning) return { ok: false, error: '识别已在运行' };
    var video = document.querySelector('video');
    if (!video) return { ok: false, error: '没有找到视频元素' };

    var r = ASR.start(video, settings, {
      onCue: function (cues) {
        st.cues.primary = cues;
        if (useOverlay() && !st.overlayOn) mountOverlay();
        else if (OV && st.overlayOn) OV.setCues(cues, st.cues.secondary);
      },
      onStatus: function (info) {
        setBadge(info.level === 'error' ? 'warn' : 'info', info.message);
        log('[ASR]', info.level, info.message, info.progress);
        if (HAS_EXT) {
          chrome.runtime.sendMessage({ type: 'broadcast-status', status: reportStatus(info) });
        }
      }
    });
    st.asrRunning = !!r.ok;
    if (r.ok && HAS_EXT) {
      chrome.runtime.sendMessage({ type: 'bump-stat', field: 'asrRuns', by: 1 });
    }
    return r;
  }

  function stopAsr() {
    if (!ASR) return { ok: false };
    var r = ASR.stop();
    st.asrRunning = false;
    return r;
  }

  // ------------------------------------------------------------ 状态浮标

  function ensureBadge() {
    if (st.badge && st.badge.parentNode) return st.badge;
    // document_start 时 body 还不存在，先等等
    if (!document.body) return null;
    if (st.badge) {
      document.body.appendChild(st.badge);
      return st.badge;
    }
    var b = document.createElement('div');
    b.id = 'basf-badge';
    b.className = 'basf-badge';
    b.setAttribute('role', 'status');
    b.addEventListener('click', function () {
      // 有注入结果就点开字幕；没有就看看能不能用 ASR 现场生成
      if (!st.injected && settings.asr && settings.asr.enabled && SET.asrReady(settings)) {
        setBadge('info', '开始识别音频，请保持视频播放…');
        var r = startAsr();
        if (!r.ok) setBadge('warn', r.error || '启动识别失败');
        return;
      }
      setBadge('info', '正在尝试打开 AI 字幕…');
      autoOpenSubtitle(true);
    });
    document.body.appendChild(b);
    st.badge = b;
    return b;
  }

  function setBadge(level, text) {
    if (!settings.enabled) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () {
        setBadge(level, text);
      }, { once: true });
      return;
    }
    var b = ensureBadge();
    if (!b) return;
    b.setAttribute('data-level', level || 'info');
    b.textContent = text || '';
    b.classList.add('basf-badge-show');
    clearTimeout(st.badgeTimer);
    st.badgeTimer = setTimeout(function () {
      if (st.badge) st.badge.classList.remove('basf-badge-show');
    }, 4200);
  }

  // ------------------------------------------------------------ 来自 popup 的指令

  if (HAS_EXT) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'get-status':
          sendResponse(reportStatus());
          return true;

        case 'reload-settings':
          loadSettings().then(function () {
            sendResponse(reportStatus());
          });
          return true;

        case 'force-open':
          autoOpenSubtitle(true);
          sendResponse({ ok: true });
          return true;

        case 'toggle-overlay':
          if (st.overlayOn) {
            unmountOverlay();
            sendResponse({ ok: true, overlay: false });
          } else {
            loadOverlayCues();
            sendResponse({ ok: true, overlay: true });
          }
          return true;

        case 'start-asr':
          sendResponse(startAsr());
          return true;

        case 'stop-asr':
          sendResponse(stopAsr());
          return true;

        case 'settings-applied':
          loadSettings().then(function () {
            applyLiveChanges();
            sendResponse(reportStatus());
          });
          return true;

        default:
          return;
      }
    });
  }

  function reportStatus(extra) {
    return {
      href: location.href,
      ids: st.ids,
      enabled: !!settings.enabled,
      injected: st.injected,
      injectedAt: st.injectedAt,
      subtitle: st.subtitle ? NS.summarizeSubtitles(st.subtitle.subtitles) : null,
      pick: st.pick && st.pick.primary
        ? {
            primary: st.pick.primary.lan,
            primaryLabel: st.pick.primary.lan_doc,
            secondary: st.pick.secondary ? st.pick.secondary.lan : null,
            isAi: NS.isAiEntry(st.pick.primary)
          }
        : null,
      overlay: st.overlayOn,
      overlayCues: st.cues.primary.length,
      asr: ASR ? { running: ASR.running, progress: ASR.progress() } : null,
      lastError: st.lastError,
      asrInfo: extra || null
    };
  }

  function applyLiveChanges() {
    pushSettings();
    if (OV && st.overlayOn) OV.applySettings(settings);
    if (st.pick) rebuildPick(st.subtitle ? st.subtitle.subtitles : []);
    if (useOverlay() && !st.overlayOn && st.subtitle) loadOverlayCues();
    if (!useOverlay() && st.overlayOn) unmountOverlay();
  }

  // ------------------------------------------------------------ 设置

  function loadSettings() {
    return new Promise(function (resolve) {
      if (!HAS_EXT) return resolve(settings);
      try {
        chrome.storage.local.get(SET.STORAGE_KEY, function (obj) {
          var raw = obj && obj[SET.STORAGE_KEY];
          settings = SET.normalize(raw || {});
          log('设置已载入', settings);
          resolve(settings);
        });
      } catch (e) {
        resolve(settings);
      }
    });
  }

  if (HAS_EXT && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[SET.STORAGE_KEY]) return;
      settings = SET.normalize(changes[SET.STORAGE_KEY].newValue || {});
      applyLiveChanges();
    });
  }

  // ------------------------------------------------------------ 启动

  loadSettings().then(function () {
    if (!settings.enabled) {
      log('插件已关闭');
      return;
    }
    pushSettings();
    // hook 可能比我们早装载完，主动握一次手
    setTimeout(function () { toHook('request-state'); }, 300);
    setTimeout(function () { toHook('request-state'); }, 1500);
  });

  // 视频切换（SPA）后重置状态
  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    st.injected = false;
    st.subtitle = null;
    st.pick = null;
    st.cues = { primary: [], secondary: [] };
    unmountOverlay();
    pushSettings();
    log('视频切换，状态已重置', location.href);
  }, 1500);
})();
