/**
 * src/popup.js —— 设置面板逻辑
 *
 * 面板只做两件事：读写 chrome.storage.local 里的设置，以及把指令转给当前标签页的
 * 内容脚本。真正的判定与执行都在内容脚本/注入层，面板不重复实现业务逻辑。
 */
(function () {
  'use strict';

  var SET = window.BASFSettings;
  var PROV = window.BASFProviders;
  if (!SET) return;

  var settings = SET.defaults();
  var tabId = null;
  var saveTimer = 0;

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
    saveTimer = setTimeout(function () { persist(true); }, 260);
  }

  // ---------------------------------------------------------------- 表单填充

  function fillForm() {
    $('enabled').checked = settings.enabled;
    $('hdSub').textContent = 'v2.0.0';

    var c = settings.sources;
    $('srcExisting').checked = c.existing;
    $('srcConclusion').checked = c.conclusion;
    setRange('conclusionWait', 'vWait', c.conclusionWait);
    $('srcExternal').checked = c.external;

    $('externalPreset').value = c.externalPreset;
    $('externalUrl').value = c.externalUrl;
    $('externalToken').value = c.externalToken;
    $('externalTokenIn').value = c.externalTokenIn;
    $('externalTokenHeader').value = c.externalTokenHeader;
    $('externalMode').value = c.externalMode;
    $('externalListPath').value = c.externalListPath;
    $('externalTextField').value = c.externalTextField;
    $('externalFromField').value = c.externalFromField;
    $('externalToField').value = c.externalToField;

    writePresetDefaults(false);

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

    $('debug').checked = settings.debug;
    renderStats();
  }

  /** 选了内置预设时，把该预设的默认值填进空着的输入框（不覆盖用户已填的） */
  function writePresetDefaults(force) {
    if (!PROV) return;
    var presetId = $('externalPreset').value;
    var preset = PROV.EXTERNAL_PRESETS[presetId];
    if (!preset || presetId === 'generic') return;

    if (force || !$('externalUrl').value) $('externalUrl').value = preset.url || '';
    if (force || !$('externalListPath').value) $('externalListPath').value = preset.listPath || '';
    if (preset.mode) $('externalMode').value = preset.mode;
    if (preset.tokenIn) $('externalTokenIn').value = preset.tokenIn;
  }

  function setRange(inputId, labelId, value) {
    var input = $(inputId);
    var label = $(labelId);
    if (input) input.value = value;
    if (label) label.textContent = value;
  }

  function renderStats() {
    var s = settings.stats || {};
    $('ftStats').textContent = '注入 ' + (s.injectedVideos || 0) + ' 个视频 · 服务端生成 '
      + (s.conclusionReady || 0) + ' 次 · 第三方 ' + (s.externalReady || 0) + ' 次';
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

    s.sources.existing = $('srcExisting').checked;
    s.sources.conclusion = $('srcConclusion').checked;
    s.sources.conclusionWait = Number($('conclusionWait').value);
    s.sources.external = $('srcExternal').checked;
    s.sources.externalPreset = $('externalPreset').value;
    s.sources.externalUrl = $('externalUrl').value.trim();
    s.sources.externalToken = $('externalToken').value;
    s.sources.externalTokenIn = $('externalTokenIn').value;
    s.sources.externalTokenHeader = $('externalTokenHeader').value.trim() || 'Authorization';
    s.sources.externalMode = $('externalMode').value;
    s.sources.externalListPath = $('externalListPath').value.trim();
    s.sources.externalTextField = $('externalTextField').value.trim() || 'content';
    s.sources.externalFromField = $('externalFromField').value.trim() || 'from';
    s.sources.externalToField = $('externalToField').value.trim() || 'to';

    s.style.fontSize = Number($('fontSize').value);
    s.style.bottom = Number($('bottom').value);
    s.style.strokeWidth = Number($('strokeWidth').value);
    s.style.bgOpacity = Number($('bgOpacity').value) / 100;
    s.style.maxWidth = Number($('maxWidth').value);
    s.style.color = $('color').value;
    s.style.strokeColor = $('strokeColor').value;

    s.debug = $('debug').checked;

    return s;
  }

  // ---------------------------------------------------------------- 绑定

  function bind() {
    var inputs = document.querySelectorAll('input, select');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.id === 'externalToken') {
        // 密钥改动也存，但不触发内容脚本重载
        el.addEventListener('change', function () {
          settings = collect();
          persist(false);
        });
        continue;
      }
      if (el.id === 'externalPreset') {
        el.addEventListener('change', function () {
          writePresetDefaults(true);
          onFormChange({ target: { id: 'externalPreset' } });
        });
        continue;
      }
      el.addEventListener('change', onFormChange);
      if (el.type === 'range') el.addEventListener('input', onFormChange);
    }

    $('btnRetryServer').addEventListener('click', function () {
      if (tabId === null) return;
      setStatusLine('warn', '已请求服务端重新生成…');
      sendToTab(tabId, { type: 'retry-server' }).then(function () {
        setTimeout(refreshStatus, 1200);
      });
    });

    $('btnOverlay').addEventListener('click', function () {
      if (tabId === null) return;
      sendToTab(tabId, { type: 'toggle-overlay' }).then(function () {
        setTimeout(refreshStatus, 700);
      });
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

    if (ev && ev.target) {
      var map = {
        fontSize: 'vFontSize',
        bottom: 'vBottom',
        strokeWidth: 'vStrokeWidth',
        bgOpacity: 'vBgOpacity',
        maxWidth: 'vMaxWidth',
        conclusionWait: 'vWait'
      };
      var labelId = map[ev.target.id];
      if (labelId) $(labelId).textContent = ev.target.value;
    }

    // 开双语时如果只要原生，就自动切到"原生 + 自建层" —— 原生做不到双语
    if (settings.bilingual && settings.injectInto === 'player') {
      settings.injectInto = 'both';
      document.querySelector('input[name="injectInto"][value="both"]').checked = true;
    }

    scheduleSave();
  }

  /**
   * 让用户把第三方接口的域名授权给扩展。
   * 授权后后台转发就不受跨域限制，服务方不必额外开 CORS。
   */
  function grantEndpoint() {
    var url = $('externalUrl').value.trim();
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
        else setStatusLine('warn', '授权被取消，第三方请求可能因跨域失败');
      });
    } catch (e) {
      setStatusLine('warn', '授权失败：' + String(e && e.message || e));
    }
  }

  // ---------------------------------------------------------------- 状态显示

  function setStatusLine(level, text) {
    $('statusDot').className = 'dot ' + (level || '');
    $('statusText').textContent = text;
  }

  function refreshStatus() {
    return withActiveTab().then(function (id) {
      tabId = id;
      return sendToTab(id, { type: 'get-status' });
    }).then(function (status) {
      render(status);
    });
  }

  function render(status) {
    var lines = $('statusLines');

    if (!status) {
      setStatusLine('', '当前标签页不是 B 站视频页');
      lines.textContent = '打开任意 bilibili.com/video 页面后再回到这里。';
      $('btnRetryServer').disabled = true;
      $('btnOverlay').disabled = true;
      return;
    }

    $('btnRetryServer').disabled = false;
    $('btnOverlay').disabled = false;

    var out = [];
    var level = '';
    var ex = status.existing || {};
    var sv = status.server || {};
    var xf = status.external || {};
    var op = status.output || {};

    // —— 主状态行 ——
    if (!status.enabled) {
      setStatusLine('', '插件已关闭');
    } else if (op.cues) {
      level = 'ok';
      var srcName = { existing: '已有字幕轨', server: 'B站服务端生成', external: '第三方接口' }[op.source] || op.source;
      setStatusLine('ok', srcName + ' · 已输出 ' + op.cues + ' 条字幕');
    } else if (sv.polling) {
      level = 'warn';
      setStatusLine('warn', '服务端正在生成字幕…（第 ' + (sv.tries || 0) + ' 次查询）');
    } else if (ex.injected) {
      level = 'ok';
      setStatusLine('ok', '字幕已注入播放器');
    } else {
      level = 'warn';
      setStatusLine('warn', '正在查找字幕来源…');
    }

    // —— 明细 ——
    if (ex.tracks && ex.tracks.total) {
      var langs = (ex.tracks.languages || []).map(function (l) { return l.label; }).join('、');
      out.push('① 已有字幕轨：' + langs + (ex.injected ? '（已注入播放器）' : ''));
    } else {
      out.push('① 已有字幕轨：没有');
    }

    if (sv.enabled) {
      var svText = {
        '': '还没开始查',
        'querying': '正在请求服务端…',
        'pending': '服务端正在生成中',
        'ready': '已完成，' + (sv.cues || 0) + ' 条',
        'timeout': '等待超时，刷新页面可继续',
        'no-speech': '服务端未识别到语音',
        'summary-only': '服务端只产出了摘要',
        'unsupported': '该视频不支持 AI 总结',
        'need-login': '需要先登录 B 站',
        'forbidden': '账号权限不足',
        'error': '调用失败'
      }[sv.state] || sv.state;
      out.push('② B站服务端生成：' + svText + (sv.stid && sv.stid !== '0' ? '（任务 ' + sv.stid + '）' : ''));
      if (sv.message) out.push('   ' + sv.message);
      if (sv.summary) out.push('   摘要：' + sv.summary.slice(0, 60) + (sv.summary.length > 60 ? '…' : ''));
    } else {
      out.push('② B站服务端生成：已关闭');
    }

    if (xf.enabled) {
      var xfText = {
        '': '还没开始查',
        'querying': '正在请求…',
        'loading': '正在下载字幕文件…',
        'ready': '已拿到，' + (xf.cues || 0) + ' 条',
        'empty': '没返回可用字幕',
        'unconfigured': '配置不完整',
        'error': '请求失败'
      }[xf.state] || xf.state;
      out.push('③ 第三方接口：' + xfText);
      if (xf.message) out.push('   ' + xf.message);
    } else {
      out.push('③ 第三方接口：已关闭');
    }

    if (status.ids) {
      out.push('aid ' + (status.ids.aid || '?') + ' · cid ' + (status.ids.cid || '?')
        + (status.ids.bvid ? ' · ' + status.ids.bvid : ''));
    }

    lines.textContent = out.join('\n');
  }

  // ---------------------------------------------------------------- 启动

  load().then(function (s) {
    settings = s;
    fillForm();
    bind();
    return refreshStatus();
  }).then(function () {
    setInterval(refreshStatus, 1800);
  });
})();
