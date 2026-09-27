/**
 * src/background.js —— MV3 service worker
 *
 * 这里没有 DOM、没有 XHR，只有 fetch 与 storage。职责三件：
 *   1. 首次安装时写入默认设置；
 *   2. ASR 转发：内容脚本把音频分片发过来，这里以扩展身份请求用户的
 *      OpenAI 兼容接口 —— 走后台的好处是不受页面 CORS 限制，用户自建的
 *      识别服务不必额外开跨域；
 *   3. 跨域兜底取字幕 JSON（页面上下文取不到时用），以及统计累加。
 */
importScripts('../lib/settings.js');

var SET = self.BASFSettings;

// ---------------------------------------------------------------- 设置

function ensureDefaults() {
  chrome.storage.local.get(SET.STORAGE_KEY, function (obj) {
    if (obj && obj[SET.STORAGE_KEY]) return;
    var d = SET.defaults();
    var patch = {};
    patch[SET.STORAGE_KEY] = d;
    chrome.storage.local.set(patch, function () {
      console.log('[BASF/bg] 已写入默认设置');
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  ensureDefaults();
  if (details && details.reason === 'install') {
    console.log('[BASF/bg] 安装完成');
  }
});

chrome.runtime.onStartup.addListener(ensureDefaults);

// ---------------------------------------------------------------- 工具

function guessExt(mime) {
  var m = String(mime || '');
  if (m.indexOf('ogg') >= 0) return 'ogg';
  if (m.indexOf('mp4') >= 0 || m.indexOf('m4a') >= 0) return 'mp4';
  if (m.indexOf('mpeg') >= 0 || m.indexOf('mp3') >= 0) return 'mp3';
  if (m.indexOf('wav') >= 0) return 'wav';
  return 'webm';
}

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error('超时：' + label));
    }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    }, function (e) {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------- ASR 转发

/**
 * 把一片音频交给用户配置的 ASR 接口。
 * 兼容 OpenAI 的 /v1/audio/transcriptions：multipart 上传，
 * 优先要 verbose_json 以拿到带时间轴的 segments（没有就退回纯文本）。
 */
function transcribe(msg) {
  var s = msg && msg.settings ? msg.settings : {};
  var a = s.asr || {};
  var endpoint = String(a.endpoint || '').trim();

  if (!/^https?:\/\//i.test(endpoint)) {
    return Promise.resolve({ ok: false, error: '接口地址无效：' + endpoint });
  }
  if (!msg.buffer || !msg.buffer.byteLength) {
    return Promise.resolve({ ok: false, error: '音频分片为空' });
  }

  var mime = msg.mime || 'audio/webm';
  var fd = new FormData();
  fd.append('file', new Blob([msg.buffer], { type: mime }), 'chunk.' + guessExt(mime));
  fd.append('model', a.model || 'whisper-1');
  if (a.language) fd.append('language', a.language);
  fd.append('response_format', 'verbose_json');
  if (a.prompt) fd.append('prompt', a.prompt);

  var headers = {};
  if (a.apiKey) headers.Authorization = 'Bearer ' + a.apiKey;

  return withTimeout(
    fetch(endpoint, { method: 'POST', headers: headers, body: fd })
      .then(function (res) {
        if (!res.ok) {
          return res.text().catch(function () { return ''; }).then(function (t) {
            throw new Error('HTTP ' + res.status + ' ' + String(t).slice(0, 200));
          });
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) throw new Error('返回内容不是 JSON');
        var segments = null;
        if (Array.isArray(data.segments) && data.segments.length) {
          segments = data.segments.map(function (sg) {
            return {
              start: Number(sg.start) || 0,
              end: Number(sg.end) || 0,
              text: String(sg.text || '').trim()
            };
          }).filter(function (sg) { return !!sg.text; });
        }
        return {
          ok: true,
          text: String(data.text || '').trim(),
          segments: segments && segments.length ? segments : null
        };
      }),
    120000, 'asr'
  ).catch(function (e) {
    return { ok: false, error: String(e && e.message || e) };
  });
}

// ---------------------------------------------------------------- 跨域兜底取 JSON

function fetchJson(url) {
  var u = String(url || '');
  if (!/^https?:\/\//i.test(u) && u.indexOf('//') !== 0) {
    return Promise.resolve({ ok: false, error: '地址无效' });
  }
  var abs = u.indexOf('//') === 0 ? 'https:' + u : u;
  return withTimeout(
    fetch(abs, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
    15000, 'fetch-json'
  ).then(function (j) {
    return { ok: true, json: j };
  }).catch(function (e) {
    return { ok: false, error: String(e && e.message || e) };
  });
}

// ---------------------------------------------------------------- 统计

var STAT_FIELDS = { injectedVideos: 1, injectedEntries: 1, asrRuns: 1 };

function bumpStat(field, by) {
  if (!STAT_FIELDS[field]) return Promise.resolve(null);
  var amount = Number(by) || 0;
  if (!amount) return Promise.resolve(null);

  return new Promise(function (resolve) {
    chrome.storage.local.get(SET.STORAGE_KEY, function (obj) {
      var raw = obj && obj[SET.STORAGE_KEY];
      var s = SET.normalize(raw || {});
      s.stats[field] = Math.max(0, Number(s.stats[field]) || 0) + amount;
      var patch = {};
      patch[SET.STORAGE_KEY] = s;
      chrome.storage.local.set(patch, function () {
        resolve(s.stats);
      });
    });
  });
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'asr-transcribe':
      transcribe(msg).then(sendResponse);
      return true;

    case 'fetch-json':
      fetchJson(msg.url).then(sendResponse);
      return true;

    case 'bump-stat':
      bumpStat(msg.field, msg.by).then(function () {
        sendResponse({ ok: true });
      });
      return true;

    case 'broadcast-status':
      // 转给 popup（若开着）以及本标签页之外并不需要，这里只做转发
      chrome.runtime.sendMessage({ type: 'status-update', status: msg.status }, function () {
        // 没有接收方时会报 lastError，吞掉即可
        void chrome.runtime.lastError;
      });
      sendResponse({ ok: true });
      return true;

    case 'open-options':
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
      sendResponse({ ok: true });
      return true;

    default:
      return;
  }
});
