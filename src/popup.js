/**
 * src/popup.js —— 设置面板逻辑
 *
 * 面板只做两件事：读写 chrome.storage.local 里的设置，以及把指令转给当前标签页的
 * 内容脚本。真正的判定与执行都在内容脚本/注入层，面板不重复实现业务逻辑。
 */
(function () {
  'use strict';

  var SET = window.BASFSettings;
  if (!SET) return;

  var settings = SET.defaults();
  var tabId = null;
  var saveTimer = 0;
  var lastStatus = null;

  function $(id) {
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------- 与标签页通信

  function withActiveTab() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          var t = tabs && tabs[0];
          resolve(t && t.id ? t.id : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sendToTab(id, msg) {
    return new Promise(function (resolve) {
      if (id === null || id === undefined) return resolve(null);
      try {
        chrome.tabs.sendMessage(id, msg, function (resp) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------- 读写设置

  function load() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(SET.STORAGE_KEY, function (obj) {
        resolve(SET.normalize((obj && obj[SET.STORAGE_KEY]) || {}));
      });
    });
  }

  function persist(notify) {
    settings = SET.normalize(settings);
    var patch = {};
    patch[SET.STORAGE_KEY] = settings;
    chrome.storage.local.set(patch, function () {
      if (notify) sendToTab(tabId, { type: 'settings-applied' });
    });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      persist(true);
    }, 260);
  }

  // ---------------------------------------------------------------- 表单填充

  function fillForm() {
    $('enabled').checked = settings.enabled;
    $('hdSub').textContent = 'v1.0.0';

    $('forceInject').checked = settings.forceInject;
    $('autoOpen').checked = settings.autoOpen;

    var radios = document.querySelectorAll('input[name="injectInto"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = radios[i].value === settings.injectInto;
    }

    $('bilingual').checked = settings.bilingual;
    $('primaryLang').value = settings.primaryLang;
    $('secondaryLang').value = settings.secondaryLang;

    setRange('fontSize', 'vFontSize', settings.style.fontSize);
    setRange('bottom', 'vBottom', settings.style.bottom);
    setRange('strokeWidth', 'vStrokeWidth', settings.style.strokeWidth);
    setRange('bgOpacity', 'vBgOpacity', Math.round(settings.style.bgOpacity * 100));
    setRange('maxWidth', 'vMaxWidth', settings.style.maxWidth);

    $('color').value = settings.style.color;
    $('strokeColor').value = settings.style.strokeColor;

    $('asrEnabled').checked = settings.asr.enabled;
    $('asrEndpoint').value = settings.asr.endpoint;
    $('asrApiKey').value = settings.asr.apiKey;
    $('asrModel').value = settings.asr.model;
    $('asrLanguage').value = settings.asr.language;
    setRange('asrChunkSeconds', 'vChunk', settings.asr.chunkSeconds);

    $('debug').checked = settings.debug;
    renderStats();
  }

  function setRange(inputId, labelId, value) {
    var input = $(inputId);
    var label = $(labelId);
    if (input) input.value = value;
    if (label) label.textContent = value;
  }

  function renderStats() {
    var s = settings.stats || {};
    $('ftStats').textContent = '已生效 ' + (s.injectedVideos || 0) + ' 个视频 · '
      + (s.injectedEntries || 0) + ' 条字幕';
  }

  // ---------------------------------------------------------------- 表单读取

  function collect() {
    var s = JSON.parse(JSON.stringify(settings));

    s.enabled = $('enabled').checked;
    s.forceInject = $('forceInject').checked;
    s.autoOpen = $('autoOpen').checked;

    var radios = document.querySelectorAll('input[name="injectInto"]');
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) s.injectInto = radios[i].value;
    }

    s.bilingual = $('bilingual').checked;
    s.primaryLang = $('primaryLang').value;
    s.secondaryLang = $('secondaryLang').value;

    s.style.fontSize = Number($('fontSize').value);
    s.style.bottom = Number($('bottom').value);
    s.style.strokeWidth = Number($('strokeWidth').value);
    s.style.bgOpacity = Number($('bgOpacity').value) / 100;
    s.style.maxWidth = Number($('maxWidth').value);
    s.style.color = $('color').value;
    s.style.strokeColor = $('strokeColor').value;

    s.asr.enabled = $('asrEnabled').checked;
    s.asr.endpoint = $('asrEndpoint').value.trim();
    s.asr.apiKey = $('asrApiKey').value;
    s.asr.model = $('asrModel').value.trim() || 'whisper-1';
    s.asr.language = $('asrLanguage').value.trim();
    s.asr.chunkSeconds = Number($('asrChunkSeconds').value);

    s.debug = $('debug').checked;

    return s;
  }

  // ---------------------------------------------------------------- 绑定

  function bind() {
    var inputs = document.querySelectorAll('input, select');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.id === 'asrApiKey') {
        // 密钥改动也存，但不触发内容脚本重载（避免无谓的整页重算）
        el.addEventListener('change', function () {
          settings = collect();
          persist(false);
        });
        continue;
      }
      el.addEventListener('change', onFormChange);
      if (el.type === 'range') el.addEventListener('input', onFormChange);
    }

    $('btnForce').addEventListener('click', function () {
      if (tabId === null) return;
      sendToTab(tabId, { type: 'force-open' }).then(function () {
        setStatusLine('warn', '已发出指令，正在尝试打开字幕…');
        setTimeout(refreshStatus, 1200);
      });
    });

    $('btnOverlay').addEventListener('click', function () {
      if (tabId === null) return;
      sendToTab(tabId, { type: 'toggle-overlay' }).then(function () {
        setTimeout(refreshStatus, 900);
      });
    });

    $('btnAsr').addEventListener('click', function () {
      if (tabId === null) return;
      sendToTab(tabId, { type: 'start-asr' }).then(function (r) {
        if (r && r.ok) setStatusLine('warn', '已开始识别，请保持视频播放');
        else setStatusLine('err', (r && r.error) || '无法启动识别');
      });
    });

    $('btnAsrStop').addEventListener('click', function () {
      if (tabId === null) return;
      sendToTab(tabId, { type: 'stop-asr' }).then(refreshStatus);
    });

    $('btnGrant').addEventListener('click', grantEndpoint);

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[SET.STORAGE_KEY]) return;
        settings = SET.normalize(changes[SET.STORAGE_KEY].newValue || {});
        renderStats();
      });
    }
  }

  function onFormChange(ev) {
    settings = collect();

    // 滑块的数值回显
    if (ev && ev.target) {
      var map = {
        fontSize: 'vFontSize',
        bottom: 'vBottom',
        strokeWidth: 'vStrokeWidth',
        bgOpacity: 'vBgOpacity',
        maxWidth: 'vMaxWidth',
        asrChunkSeconds: 'vChunk'
      };
      var labelId = map[ev.target.id];
      if (labelId) $(labelId).textContent = ev.target.value;
    }

    // 开双语时如果没有自建层，就自动切过去 —— 原生层做不到双语
    if (settings.bilingual && settings.injectInto === 'player') {
      settings.injectInto = 'both';
      document.querySelector('input[name="injectInto"][value="both"]').checked = true;
    }

    scheduleSave();
  }

  /**
   * 让用户把 ASR 接口的域名授权给扩展。
   * 授权后后台转发音频就不受跨域限制，自建服务不必额外开 CORS。
   */
  function grantEndpoint() {
    var url = $('asrEndpoint').value.trim();
    var origin = null;
    try {
      origin = new URL(url).origin + '/*';
    } catch (e) {
      origin = null;
    }
    if (!origin) {
      setStatusLine('err', '先把接口地址填成完整的 http(s) 链接');
      return;
    }
    try {
      chrome.permissions.request({ origins: [origin] }, function (granted) {
        if (granted) setStatusLine('ok', '已授权 ' + origin);
        else setStatusLine('warn', '授权被取消，ASR 可能因跨域失败');
      });
    } catch (e) {
      setStatusLine('warn', '授权失败：' + String(e && e.message || e));
    }
  }

  // ---------------------------------------------------------------- 状态显示

  function setStatusLine(level, text) {
    var dot = $('statusDot');
    dot.className = 'dot ' + (level || '');
    $('statusText').textContent = text;
  }

  function refreshStatus() {
    return withActiveTab().then(function (id) {
      tabId = id;
      return sendToTab(id, { type: 'get-status' });
    }).then(function (status) {
      lastStatus = status;
      render(status);
    });
  }

  function render(status) {
    var meta = $('statusMeta');

    if (!status) {
      setStatusLine('', '当前标签页不是 B 站视频页');
      meta.textContent = '打开任意 bilibili.com/video 页面后再回到这里。';
      $('btnForce').disabled = true;
      $('btnOverlay').disabled = true;
      $('btnAsr').disabled = true;
      $('btnAsrStop').disabled = true;
      return;
    }

    $('btnForce').disabled = false;
    $('btnOverlay').disabled = false;
    $('btnAsr').disabled = false;
    $('btnAsrStop').disabled = false;

    var lines = [];
    var level = '';

    if (!status.enabled) {
      setStatusLine('', '插件已关闭');
    } else if (status.injected) {
      level = 'ok';
      var label = status.pick && status.pick.primaryLabel ? status.pick.primaryLabel : '字幕';
      setStatusLine('ok', (status.pick && status.pick.isAi ? 'AI 字幕已注入：' : '字幕已注入：') + label);
    } else if (status.subtitle && status.subtitle.total) {
      level = 'warn';
      setStatusLine('warn', '已取到字幕列表，等待播放器响应…');
    } else {
      level = 'warn';
      setStatusLine('warn', '正在等待播放器请求…');
    }

    if (status.subtitle) {
      var langs = status.subtitle.languages.map(function (l) { return l.label; }).join('、');
      lines.push('字幕轨：' + (langs || '无'));
    }
    if (status.ids) {
      lines.push('aid ' + (status.ids.aid || '?') + ' · cid ' + (status.ids.cid || '?') + (status.ids.bvid ? ' · ' + status.ids.bvid : ''));
    }
    if (status.overlay) {
      lines.push('自建渲染层：已开启（' + status.overlayCues + ' 条）');
    }
    if (status.asr && status.asr.running) {
      var p = status.asr.progress || {};
      lines.push('识别中：已提交 ' + (p.submitted || 0) + ' 片，完成 ' + (p.done || 0)
        + '，失败 ' + (p.failed || 0) + '，字幕 ' + (p.cues || 0) + ' 条');
    }
    if (status.lastError) lines.push('最近错误：' + status.lastError);

    meta.textContent = lines.join('\n');
    meta.style.whiteSpace = 'pre-line';
    if (level === 'ok') { /* 保持上面的 ok 状态 */ }
  }

  // ---------------------------------------------------------------- 启动

  load().then(function (s) {
    settings = s;
    fillForm();
    bind();
    return refreshStatus();
  }).then(function () {
    setInterval(refreshStatus, 1600);
  });
})();
