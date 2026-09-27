/**
 * src/overlay.js —— 自建字幕渲染层（内容脚本环境）
 *
 * 为什么需要它：
 *  - B 站原生字幕渲染在播放器内部的 shadow DOM 里，样式（字号/描边/背景/位置）改不动；
 *  - 原生层一次只显示一条轨，做不到中英对照的双语显示。
 *
 * 所以这里在视频容器上盖一层自己的字幕层，由 `video.currentTime` 驱动，
 * 支持双语上下两行，以及一整套可调样式（走 CSS 变量，改动即时生效）。
 *
 * 字幕文本一律用 textContent 写入 —— 内容来自网络，绝不能走 innerHTML。
 */
(function (root) {
  'use strict';

  var NS = root.BASFBiliApi || null;

  var CLS_ROOT = 'basf-overlay';
  var CLS_MAIN = 'basf-overlay-line basf-overlay-main';
  var CLS_SUB = 'basf-overlay-line basf-overlay-sub';

  /** 基准播放器宽度：设置里的字号是按这个宽度校准的，实际渲染按比例缩放 */
  var BASE_WIDTH = 1000;
  var MIN_FONT = 11;
  var MAX_FONT = 64;

  var state = {
    root: null,
    video: null,
    mainEl: null,
    subEl: null,
    primaryCues: [],
    secondaryCues: [],
    settings: null,
    active: false,
    running: false,
    lastRaf: 0,
    lastMain: null,
    lastSub: null,
    lastTime: -1
  };

  // ---------------------------------------------------------------- 工具

  function el(tag, cls) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    return d;
  }

  function num(v, dflt, lo, hi) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) n = dflt;
    if (lo !== undefined && n < lo) n = lo;
    if (hi !== undefined && n > hi) n = hi;
    return n;
  }

  /** #rrggbb + 不透明度 → rgba() */
  function rgba(hex, alpha) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (!/^[0-9a-fA-F]{6}/.test(h)) h = '000000';
    var r = parseInt(h.substr(0, 2), 16);
    var g = parseInt(h.substr(2, 2), 16);
    var b = parseInt(h.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + num(alpha, 0.45, 0, 1) + ')';
  }

  // ---------------------------------------------------------------- 挂载

  /**
   * 把字幕层挂到视频容器里。
   * @param {HTMLElement} container 通常是 .bpx-player-video-wrap
   */
  function mount(container, settings) {
    if (!container) return false;
    if (state.root && state.root.parentNode === container) {
      applySettings(settings);
      return true;
    }
    destroy();

    var rt = el('div', CLS_ROOT);
    rt.setAttribute('aria-hidden', 'true');
    var main = el('div', CLS_MAIN);
    var sub = el('div', CLS_SUB);
    rt.appendChild(main);
    rt.appendChild(sub);
    container.appendChild(rt);

    state.root = rt;
    state.mainEl = main;
    state.subEl = sub;
    state.video = container.querySelector('video') || document.querySelector('video');
    applySettings(settings);
    return true;
  }

  function destroy() {
    stopLoop();
    if (state.root && state.root.parentNode) {
      state.root.parentNode.removeChild(state.root);
    }
    state.root = null;
    state.mainEl = null;
    state.subEl = null;
    state.video = null;
    state.active = false;
  }

  // ---------------------------------------------------------------- 样式

  function applySettings(settings) {
    if (!settings || !state.root) return;
    state.settings = settings;
    var s = settings.style || {};
    var rt = state.root;

    rt.style.setProperty('--basf-bottom', num(s.bottom, 8, 0, 60) + '%');
    rt.style.setProperty('--basf-max-width', num(s.maxWidth, 84, 20, 100) + '%');
    rt.style.setProperty('--basf-color', String(s.color || '#ffffff'));
    rt.style.setProperty('--basf-bg', rgba(s.bgColor || '#000000', s.bgOpacity));
    rt.style.setProperty('--basf-sub-scale', String(num(s.secondaryScale, 0.82, 0.4, 1.5)));
    rt.style.setProperty('--basf-font-family',
      s.fontFamily ? String(s.fontFamily) : '"Microsoft YaHei","PingFang SC",system-ui,sans-serif');

    var fontPx = computedFont(num(s.fontSize, 26, 10, 72));
    rt.style.setProperty('--basf-font-size', fontPx + 'px');

    var strokeW = num(s.strokeWidth, 2, 0, 8);
    rt.style.setProperty('--basf-stroke-width', strokeW + 'px');
    // 整条 text-shadow 一次性拼好再设进去：
    // 拆成两个变量再在 CSS 里逗号拼接，会让 `..., none` 成为非法值而整条声明失效。
    if (strokeW > 0) {
      var c = String(s.strokeColor || '#000000');
      var offs = [];
      var dx, dy;
      for (dx = -strokeW; dx <= strokeW; dx += strokeW) {
        for (dy = -strokeW; dy <= strokeW; dy += strokeW) {
          if (dx === 0 && dy === 0) continue;
          offs.push(dx + 'px ' + dy + 'px 0 ' + c);
        }
      }
      rt.style.setProperty('--basf-text-shadow', offs.join(','));
    } else {
      rt.style.setProperty('--basf-text-shadow',
        s.shadow === false ? 'none' : '0 1px 3px rgba(0,0,0,.75)');
    }
  }

  /** 按容器实际宽度缩放字号，保证小窗与全屏的比例观感一致 */
  function computedFont(basePx) {
    var w = BASE_WIDTH;
    try {
      if (state.root && state.root.clientWidth) w = state.root.clientWidth;
    } catch (e) { /* noop */ }
    var scaled = basePx * (w / BASE_WIDTH);
    if (scaled < MIN_FONT) scaled = MIN_FONT;
    if (scaled > MAX_FONT) scaled = MAX_FONT;
    return Math.round(scaled * 10) / 10;
  }

  // ---------------------------------------------------------------- 数据

  function setCues(primary, secondary) {
    state.primaryCues = Array.isArray(primary) ? primary : [];
    state.secondaryCues = Array.isArray(secondary) ? secondary : [];
    state.lastMain = null;
    state.lastSub = null;
    state.lastTime = -1;
  }

  function hasData() {
    return state.primaryCues.length > 0;
  }

  // ---------------------------------------------------------------- 循环

  function setActive(on) {
    state.active = !!on;
    if (!state.root) return;
    if (state.active && hasData()) {
      state.root.classList.add('basf-visible');
      startLoop();
    } else {
      state.root.classList.remove('basf-visible');
      stopLoop();
      clearLines();
    }
  }

  function clearLines() {
    if (state.mainEl) state.mainEl.textContent = '';
    if (state.subEl) state.subEl.textContent = '';
    state.lastMain = null;
    state.lastSub = null;
  }

  function startLoop() {
    if (state.running) return;
    state.running = true;
    state.lastRaf = 0;
    tick();
  }

  function stopLoop() {
    state.running = false;
    if (state.lastRaf) {
      try { cancelAnimationFrame(state.lastRaf); } catch (e) { /* noop */ }
    }
    state.lastRaf = 0;
  }

  function tick() {
    if (!state.running) return;
    state.lastRaf = requestAnimationFrame(tick);
    refresh();
  }

  /** 按当前播放时间刷新两行文本；时间没变就什么都不做 */
  function refresh() {
    if (!state.active || !state.root || !state.mainEl) return;

    var video = state.video;
    if (!video || !video.parentNode) {
      var rt = state.root;
      if (rt && rt.parentNode) {
        video = rt.parentNode.querySelector('video') || document.querySelector('video');
        state.video = video;
      }
      if (!video) return;
    }

    var t = video.currentTime;
    if (t === state.lastTime) return;
    state.lastTime = t;

    var mainCue = NS && NS.findCueAt ? NS.findCueAt(state.primaryCues, t) : null;
    var mainText = mainCue ? mainCue.text : '';
    if (mainText !== state.lastMain) {
      state.mainEl.textContent = mainText;
      state.lastMain = mainText;
    }

    var subText = '';
    if (state.secondaryCues.length) {
      var subCue = NS && NS.findCueAt ? NS.findCueAt(state.secondaryCues, t) : null;
      subText = subCue ? subCue.text : '';
    }
    if (subText !== state.lastSub) {
      state.subEl.textContent = subText;
      state.lastSub = subText;
    }
  }

  /** 当前正在显示的两行文本（供内容脚本对外报告 / 复制） */
  function currentText() {
    return {
      main: state.mainEl ? state.mainEl.textContent : '',
      sub: state.subEl ? state.subEl.textContent : ''
    };
  }

  root.BASFOverlay = {
    mount: mount,
    destroy: destroy,
    applySettings: applySettings,
    setCues: setCues,
    setActive: setActive,
    hasData: hasData,
    refresh: refresh,
    currentText: currentText,
    get root() { return state.root; },
    get active() { return state.active; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
