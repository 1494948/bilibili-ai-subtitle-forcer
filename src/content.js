/**
 * src/content.js —— 内容脚本（ISOLATED world）／整个插件的编排层
 *
 * 它不直接改页面，而是：
 *   1. 与 MAIN world 的 hook 通过 postMessage 对话（真正的网络请求与注入都在那边）；
 *   2. 按「已有字幕轨 → B站服务端生成 → 第三方接口」的顺序找字幕；
 *   3. 把找到的字幕输出到视频上 —— 有 subtitle_url 的走播放器原生字幕，
 *      只有时间轴文本的（服务端生成的、第三方直接给的）走自建字幕层；
 *   4. 转发 popup 的指令。
 *
 * 三条来源的区别（重要）：
 *   · existing   B 站已有的字幕轨，能注入播放器 → 全屏/画中画都正常
 *   · server     B 站服务端 AI 识别生成的，只有时间轴文本 → 必须走自建层。
 *                没生成过的视频，请求一次就会让服务端把它排进处理队列，
 *                所以要轮询等待 —— 这是本插件最"重"的一条路径。
 *   · external   用户自配的第三方接口，返回什么形态都适配
 */
(function () {
  'use strict';

  var HAS_EXT = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  var NS = typeof globalThis !== 'undefined' ? globalThis.BASFBiliApi : null;
  var SET = typeof globalThis !== 'undefined' ? globalThis.BASFSettings : null;
  var OV = typeof globalThis !== 'undefined' ? globalThis.BASFOverlay : null;
  var PROV = typeof globalThis !== 'undefined' ? globalThis.BASFProviders : null;
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

  /** 轮询服务端生成：前几次密一点，之后放缓 */
  var POLL_FAST_MS = 5000;
  var POLL_SLOW_MS = 12000;
  var POLL_FAST_TIMES = 6;

  var settings = SET.defaults();

  var st = {
    href: '',
    ids: null,

    // —— 三条来源各自的进度 ——
    existing: { subtitle: null, pick: null, injected: false, injectedAt: 0 },
    server: {
      state: '', message: '', cues: [], summary: '', outline: [],
      stid: '', tries: 0, polling: false, startedAt: 0
    },
    external: { state: '', message: '', cues: [], kind: '' },

    // —— 输出 ——
    cues: { primary: [], secondary: [] },
    outputSource: '',
    overlayOn: false,

    // —— 杂项 ——
    pending: Object.create(null),
    reqSeq: 0,
    badge: null,
    badgeTimer: 0,
    autoOpenRunning: false
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

  function toHook(type, payload) {
    try {
      window.postMessage({ __basf: true, dir: 'to-hook', type: type, payload: payload || null }, '*');
    } catch (e) { /* noop */ }
  }

  /** 向 hook 发一个带 reqId 的请求，等它回同名结果消息 */
  function askHook(sendType, resultType, payload, timeoutMs) {
    return new Promise(function (resolve) {
      var id = 'q' + (++st.reqSeq);
      st.pending[id] = { resolve: resolve, expect: resultType };
      toHook(sendType, Object.assign({ reqId: id }, payload || {}));
      setTimeout(function () {
        var slot = st.pending[id];
        if (slot) {
          delete st.pending[id];
          slot.resolve(null);
        }
      }, timeoutMs || 30000);
    });
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
    // 带 reqId 的异步结果统一在这里配对
    if (payload && payload.reqId) {
      var slot = st.pending[payload.reqId];
      if (slot && slot.expect === type) {
        delete st.pending[payload.reqId];
        slot.resolve(payload);
        return;
      }
    }

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

      case 'subtitle-content': {
        var res = st.pending[payload && payload.reqId];
        if (res) {
          delete st.pending[payload.reqId];
          res.resolve(payload.ok ? payload.cues : null);
        }
        break;
      }

      case 'state':
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

  // ------------------------------------------------------------ 来源一：已有字幕轨

  function onSubtitleReady(payload) {
    var sub = payload && payload.subtitle;
    st.ids = (payload && payload.ids) || st.ids;

    var hasTracks = !!(sub && sub.subtitles && sub.subtitles.length);
    if (hasTracks) {
      st.existing.subtitle = sub;
      rebuildPick(sub.subtitles);
      log('已有字幕轨', NS.summarizeSubtitles(sub.subtitles));
      if (st.existing.pick && st.existing.pick.primary) {
        setBadge('ok', '已发现 ' + st.existing.pick.primary.lan_doc);
      }
    } else {
      st.existing.subtitle = null;
      st.existing.pick = null;
      log('这个视频没有现成字幕轨', payload && payload.tried);
      // 没有现成的，就去问服务端 —— 这正是"让服务端生成"的入口
      runServerFlow();
    }
  }

  function rebuildPick(subtitles) {
    st.existing.pick = NS.pickTracks(subtitles, {
      primary: settings.primaryLang,
      secondary: settings.secondaryLang,
      bilingual: settings.bilingual
    });
    return st.existing.pick;
  }

  function onInjected(payload) {
    st.existing.injected = true;
    st.existing.injectedAt = Date.now();
    log('注入成功', payload);

    if (settings.autoOpen) autoOpenSubtitle(false);

    if (st.existing.pick && st.existing.pick.primary) {
      var ai = NS.isAiEntry(st.existing.pick.primary);
      setBadge('ok', (ai ? 'AI 字幕已就绪：' : '字幕已就绪：') + st.existing.pick.primary.lan_doc);
    }

    if (payload && payload.first && HAS_EXT) {
      try {
        chrome.runtime.sendMessage({ type: 'bump-stat', field: 'injectedVideos', by: 1 });
        chrome.runtime.sendMessage({ type: 'bump-stat', field: 'injectedEntries', by: payload.added || 0 });
      } catch (e) { /* noop */ }
    }

    if (useOverlay()) loadExistingCues();
  }

  // ------------------------------------------------------------ 来源二：B站服务端生成

  /**
   * 走「AI 视频总结」接口。
   * 关键点：这个接口**本身就是生成入口** —— 没处理过的视频请求一次就进队列了，
   * 所以 pending 不是失败，而是"再等等"。
   */
  function runServerFlow() {
    if (!settings.sources.conclusion) {
      log('服务端生成这条线是关的');
      runExternalFlow();
      return;
    }
    if (st.server.polling) return;

    st.server = {
      state: 'querying', message: '正在询问 B 站服务端…', cues: [], summary: '', outline: [],
      stid: '', tries: 0, polling: true, startedAt: Date.now()
    };
    setBadge('info', '正在让 B 站服务端生成字幕…');
    pollConclusion();
  }

  function pollConclusion() {
    if (!settings.sources.conclusion) {
      st.server.polling = false;
      return;
    }

    var waitMs = Math.max(0, Number(settings.sources.conclusionWait) || 0) * 1000;
    if (waitMs > 0 && Date.now() - st.server.startedAt > waitMs) {
      st.server.polling = false;
      st.server.state = 'timeout';
      st.server.message = '服务端还在生成，稍后刷新本页就能拿到';
      setBadge('warn', '服务端还在生成中，刷新一次页面即可');
      runExternalFlow();
      return;
    }

    st.server.tries++;
    askHook('request-conclusion', 'conclusion-result', { ids: st.ids }, 25000)
      .then(function (res) {
        if (!res) {
          st.server.state = 'error';
          st.server.message = '请求超时';
          st.server.polling = false;
          runExternalFlow();
          return;
        }

        st.server.state = res.state || 'error';
        st.server.message = res.message || '';
        st.server.stid = res.stid || '';

        if (res.ok && res.cues && res.cues.length) {
          st.server.polling = false;
          st.server.cues = res.cues;
          st.server.summary = res.summary || '';
          st.server.outline = res.outline || [];
          log('服务端生成完成', res.cues.length, '条');
          bumpStat('conclusionReady');
          applyCues(res.cues, 'server', {
            label: 'B站服务端 AI 字幕',
            summary: res.summary,
            outline: res.outline
          });
          return;
        }

        if (res.state === 'pending') {
          // ★ 正常情况：服务端在排队/生成中，继续等
          var fast = st.server.tries <= POLL_FAST_TIMES;
          var left = Math.max(0, Math.round((waitMs - (Date.now() - st.server.startedAt)) / 1000));
          setBadge('info', '服务端生成中…（第 ' + st.server.tries + ' 次查询'
            + (waitMs ? '，最多再等 ' + left + ' 秒' : '') + ')');
          setTimeout(pollConclusion, fast ? POLL_FAST_MS : POLL_SLOW_MS);
          return;
        }

        // 其他状态都意味着这条线走不下去了
        st.server.polling = false;
        var hint = {
          'no-speech': '服务端未在这个视频里识别到语音',
          'summary-only': '服务端只产出了摘要，没有字幕',
          'unsupported': '这个视频不支持 AI 总结',
          'need-login': '需要先在浏览器里登录 B 站，服务端才会为它生成字幕',
          'forbidden': '账号权限不足，无法调用 AI 总结',
          'error': '调用服务端失败：' + (res.message || '未知原因')
        }[res.state] || ('服务端返回：' + (res.message || res.state));

        st.server.message = hint;
        setBadge('warn', hint);
        log('服务端这条线结束', res.state, hint);
        runExternalFlow();
      });
  }

  // ------------------------------------------------------------ 来源三：第三方接口

  function runExternalFlow() {
    if (!settings.sources.external) {
      finishWithNothing();
      return;
    }
    if (!SET.externalReady(settings)) {
      st.external.state = 'unconfigured';
      st.external.message = '第三方接口还没配置完整';
      finishWithNothing();
      return;
    }

    st.external.state = 'querying';
    st.external.message = '';
    setBadge('info', '正在请求第三方字幕接口…');

    var cfg = buildExternalConfig();
    askHook('request-external', 'external-result', { ids: st.ids, config: cfg }, 60000)
      .then(function (res) {
        if (!res) {
          st.external.state = 'error';
          st.external.message = '请求超时';
          finishWithNothing();
          return;
        }
        if (!res.ok) {
          if (res.retriable && HAS_EXT) {
            // 页面上下文发不出去（多半是 CORS）→ 让后台再试一次
            setBadge('info', '改用后台通道重试第三方接口…');
            retryExternalViaBackground(cfg).then(function (r2) {
              if (r2 && r2.ok) return handleExternalOk(r2);
              st.external.state = 'error';
              st.external.message = (r2 && r2.message) || res.message || '请求失败';
              finishWithNothing();
            });
            return;
          }
          st.external.state = 'error';
          st.external.message = res.message || '请求失败';
          finishWithNothing();
          return;
        }
        handleExternalOk(res);
      });
  }

  function buildExternalConfig() {
    var c = settings.sources;
    return {
      preset: c.externalPreset,
      urlTemplate: c.externalUrl,
      token: c.externalToken,
      tokenIn: c.externalTokenIn,
      tokenHeader: c.externalTokenHeader,
      mode: c.externalMode,
      listPath: c.externalListPath,
      textField: c.externalTextField,
      fromField: c.externalFromField,
      toField: c.externalToField
    };
  }

  function handleExternalOk(res) {
    if (res.kind === 'cues') {
      var cues = res.cues || [];
      if (!cues.length) {
        st.external.state = 'empty';
        st.external.message = '第三方接口没返回字幕';
        finishWithNothing();
        return;
      }
      st.external.cues = cues;
      st.external.kind = 'cues';
      st.external.state = 'ready';
      bumpStat('externalReady');
      applyCues(cues, 'external', { label: '第三方接口字幕' });
      return;
    }

    // 返回的是 B 站格式的字幕条目（含 subtitle_url）→ 可以注入播放器
    var entries = res.entries || [];
    var single = res.url
      ? [{ lan: 'external', lan_doc: '第三方字幕', subtitle_url: String(res.url).replace(/^https?:/i, ''), is_lock: false, type: 1 }]
      : [];
    var tracks = entries.length ? entries : single;
    if (!tracks.length) {
      st.external.state = 'empty';
      st.external.message = '第三方接口没返回可用的字幕地址';
      finishWithNothing();
      return;
    }

    st.external.kind = res.kind || 'subtitle-list';
    st.external.state = 'loading';
    var pick = NS.pickTracks(tracks, { primary: settings.primaryLang, bilingual: false });
    if (!pick.primary) {
      st.external.state = 'empty';
      st.external.message = '第三方字幕条目里没有可选的语言';
      finishWithNothing();
      return;
    }

    setBadge('info', '正在下载第三方字幕文件…');
    requestContent(pick.primary.subtitle_url).then(function (cues) {
      if (!cues || !cues.length) {
        st.external.state = 'empty';
        st.external.message = '第三方字幕文件取不到';
        finishWithNothing();
        return;
      }
      st.external.cues = cues;
      st.external.state = 'ready';
      bumpStat('externalReady');
      applyCues(cues, 'external', { label: '第三方接口字幕' });
    });
  }

  function retryExternalViaBackground(cfg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'external-fetch', ids: st.ids, config: cfg }, function (resp) {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function bumpStat(field) {
    if (!HAS_EXT) return;
    try { chrome.runtime.sendMessage({ type: 'bump-stat', field: field, by: 1 }); } catch (e) { /* noop */ }
  }

  function finishWithNothing() {
    var why = st.server.message || st.external.message || '没有找到可用的字幕';
    setBadge('warn', why);
    log('三条来源都没有结果', why);
  }

  // ------------------------------------------------------------ 输出

  /**
   * 把 cue 列表输出到视频上。
   * 只有带 subtitle_url 的来源才可能用播放器原生字幕；服务端生成与第三方直给的
   * 都只有时间轴文本，必须走自建层。
   */
  function applyCues(cues, source, meta) {
    if (!cues || !cues.length) return;
    st.cues.primary = cues;
    st.cues.secondary = [];
    st.outputSource = source;

    var label = (meta && meta.label) || source;
    log('输出字幕', label, cues.length, '条');

    if (source !== 'existing' && settings.injectInto === 'player') {
      setBadge('info', '这类字幕放不进播放器原生轨道，已自动切到自建字幕层');
    }
    mountOverlay();
    setBadge('ok', label + ' 已就绪（' + cues.length + ' 条字幕）');
  }

  // ------------------------------------------------------------ 自建渲染层

  function useOverlay() {
    return settings.injectInto === 'overlay' || settings.injectInto === 'both';
  }

  function requestContent(url) {
    if (!url) return Promise.resolve(null);
    return askHook('fetch-subtitle-content', 'subtitle-content', { url: url }, 25000)
      .then(function (res) { return res && res.ok ? res.cues : null; });
  }

  /** 已有字幕轨的双语加载 */
  function loadExistingCues() {
    var pick = st.existing.pick;
    if (!pick || !pick.primary) return;
    var secondary = settings.bilingual ? pick.secondary : null;

    requestContent(pick.primary.subtitle_url).then(function (cues) {
      if (!cues || !cues.length) return;
      st.cues.primary = cues;
      st.outputSource = 'existing';
      if (!secondary) {
        st.cues.secondary = [];
        mountOverlay();
        return;
      }
      requestContent(secondary.subtitle_url).then(function (sub2) {
        st.cues.secondary = sub2 || [];
        mountOverlay();
      });
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
    try { document.body.classList.add('basf-overlay-on'); } catch (e) { /* noop */ }
  }

  function unmountOverlay() {
    if (OV) OV.destroy();
    st.overlayOn = false;
    try { document.body.classList.remove('basf-overlay-on'); } catch (e) { /* noop */ }
  }

  // ------------------------------------------------------------ 打开 AI 字幕

  function autoOpenSubtitle(force) {
    if (st.autoOpenRunning) return;
    if (!force && (!settings.enabled || !settings.autoOpen)) return;
    var pick = st.existing.pick;
    if (!pick || !pick.primary) return;

    var target = pick.primary.lan || 'ai-zh';
    st.autoOpenRunning = true;
    var deadline = Date.now() + Math.max(2000, settings.autoOpenTimeout);

    (function attempt() {
      if (!force && (!settings.enabled || !settings.autoOpen)) {
        st.autoOpenRunning = false;
        return;
      }

      var item = findLangItem(target)
        || (target !== 'ai-zh' ? findLangItem('ai-zh') : null)
        || findAnyAiLangItem();

      if (item) {
        if (!isLangActive(item)) {
          try { item.click(); } catch (e) { /* noop */ }
          log('已点击字幕语言项', item.getAttribute('data-lan'));
        }
        setTimeout(function () {
          var again = findLangItem(target) || findAnyAiLangItem();
          if (again && !isLangActive(again)) {
            try { again.click(); } catch (e) { /* noop */ }
          }
          st.autoOpenRunning = false;
        }, 500);
        return;
      }

      var btn = document.querySelector(SEL.subtitleBtn);
      if (btn) {
        ['mouseenter', 'mouseover', 'mousemove'].forEach(function (t) {
          try {
            btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
          } catch (e) { /* noop */ }
        });
      }

      if (Date.now() > deadline) {
        st.autoOpenRunning = false;
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
      if (/^ai-/i.test(items[i].getAttribute('data-lan') || '')) return items[i];
    }
    return null;
  }

  function isLangActive(item) {
    if (!item) return false;
    return /bpx-state-active|active/.test(item.className || '');
  }

  // ------------------------------------------------------------ 状态浮标

  function ensureBadge() {
    if (st.badge && st.badge.parentNode) return st.badge;
    if (!document.body) return null;
    if (st.badge) {
      document.body.appendChild(st.badge);
      return st.badge;
    }
    var b = document.createElement('div');
    b.id = 'basf-badge';
    b.className = 'basf-badge';
    b.setAttribute('role', 'status');
    b.addEventListener('click', onBadgeClick);
    document.body.appendChild(b);
    st.badge = b;
    return b;
  }

  function onBadgeClick() {
    // 还没字幕：手动催一次服务端生成；已经有：把字幕打开
    if (!st.cues.primary.length) {
      setBadge('info', '正在重新让服务端生成…');
      st.server.polling = false;
      st.server.startedAt = Date.now();
      runServerFlow();
      return;
    }
    setBadge('info', '正在把字幕打开…');
    if (!st.overlayOn) mountOverlay();
    autoOpenSubtitle(true);
  }

  function setBadge(level, text) {
    if (!settings.enabled) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { setBadge(level, text); }, { once: true });
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
    }, 5200);
  }

  // ------------------------------------------------------------ 来自 popup 的指令

  if (HAS_EXT) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'get-status':
          sendResponse(reportStatus());
          return true;

        case 'force-open':
          onBadgeClick();
          sendResponse({ ok: true });
          return true;

        case 'retry-server':
          st.server.polling = false;
          st.server.startedAt = Date.now();
          runServerFlow();
          sendResponse({ ok: true });
          return true;

        case 'toggle-overlay':
          if (st.overlayOn) {
            unmountOverlay();
            sendResponse({ ok: true, overlay: false });
          } else {
            if (!st.cues.primary.length) loadExistingCues();
            else mountOverlay();
            sendResponse({ ok: true, overlay: true });
          }
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

  function reportStatus() {
    return {
      href: location.href,
      ids: st.ids,
      enabled: !!settings.enabled,

      existing: {
        tracks: st.existing.subtitle ? NS.summarizeSubtitles(st.existing.subtitle.subtitles) : null,
        pick: st.existing.pick && st.existing.pick.primary ? {
          lan: st.existing.pick.primary.lan,
          label: st.existing.pick.primary.lan_doc,
          isAi: NS.isAiEntry(st.existing.pick.primary),
          secondary: st.existing.pick.secondary ? st.existing.pick.secondary.lan : null
        } : null,
        injected: st.existing.injected
      },

      server: {
        enabled: !!settings.sources.conclusion,
        state: st.server.state,
        message: st.server.message,
        stid: st.server.stid,
        tries: st.server.tries,
        polling: st.server.polling,
        cues: st.server.cues.length,
        summary: st.server.summary,
        outline: st.server.outline
      },

      external: {
        enabled: !!settings.sources.external,
        state: st.external.state,
        message: st.external.message,
        kind: st.external.kind,
        cues: st.external.cues.length
      },

      output: {
        source: st.outputSource,
        cues: st.cues.primary.length,
        secondary: st.cues.secondary.length,
        overlay: st.overlayOn
      },

      currentText: OV && OV.currentText ? OV.currentText() : null
    };
  }

  function applyLiveChanges() {
    pushSettings();
    if (OV && st.overlayOn) OV.applySettings(settings);
    if (st.existing.subtitle) rebuildPick(st.existing.subtitle.subtitles);
    if (useOverlay() && !st.overlayOn && st.cues.primary.length) mountOverlay();
    if (!useOverlay() && st.overlayOn) unmountOverlay();
  }

  // ------------------------------------------------------------ 设置

  function loadSettings() {
    return new Promise(function (resolve) {
      if (!HAS_EXT) return resolve(settings);
      try {
        chrome.storage.local.get(SET.STORAGE_KEY, function (obj) {
          settings = SET.normalize((obj && obj[SET.STORAGE_KEY]) || {});
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
    setTimeout(function () { toHook('request-state'); }, 300);
    setTimeout(function () { toHook('request-state'); }, 1500);
  });

  // SPA 切视频后重置
  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    st.existing = { subtitle: null, pick: null, injected: false, injectedAt: 0 };
    st.server = {
      state: '', message: '', cues: [], summary: '', outline: [],
      stid: '', tries: 0, polling: false, startedAt: 0
    };
    st.external = { state: '', message: '', cues: [], kind: '' };
    st.cues = { primary: [], secondary: [] };
    st.outputSource = '';
    unmountOverlay();
    pushSettings();
    log('视频切换，状态已重置');
  }, 1500);
})();
