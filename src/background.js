/**
 * src/background.js —— MV3 service worker
 *
 * 这里没有 DOM、没有 XHR，只有 fetch 与 storage。职责三件：
 *   1. 首次安装时写入默认设置；
 *   2. 第三方字幕接口的后台代理 —— 页面上下文发不出去（多半是 CORS）时走这里。
 *      后台 fetch 不受页面 CORS 限制，但需要用户在面板里授权该域名；
 *   3. 统计累加。
 */
importScripts('../lib/settings.js', '../lib/providers.js');

var SET = self.BASFSettings;
var PROV = self.BASFProviders;

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

/**
 * MAIN world 注入引擎（src/hook.js）不经过这里 —— 它由内容脚本
 * src/inject-hook.js 以 <script src> 方式送进页面（web_accessible_resources）。
 * 实测 Edge 153/154 上 manifest 的 world:"MAIN" 条目会吞掉其他 content_scripts，
 * chrome.scripting.registerContentScripts({world:'MAIN'}) 注册成功却不注入，
 * 都不可靠；这个经典手法是唯一在真机上验证通过的。
 */

chrome.runtime.onInstalled.addListener(function (details) {
  ensureDefaults();
  if (details && details.reason === 'install') {
    console.log('[BASF/bg] 安装完成');
  }
});

chrome.runtime.onStartup.addListener(ensureDefaults);

// ---------------------------------------------------------------- 工具

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error('超时：' + label));
    }, ms);
    promise.then(function (v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, function (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------- 第三方接口代理

/**
 * 与内容脚本里的同名逻辑一样，只是换到后台发请求。
 * 好处是不受页面 CORS 约束；代价是要用户先授权目标域名。
 */
function externalFetch(msg) {
  if (!PROV) return Promise.resolve({ ok: false, message: '适配模块未加载' });

  var cfg = msg && msg.config ? msg.config : {};
  var preset = PROV.EXTERNAL_PRESETS[cfg.preset] || PROV.EXTERNAL_PRESETS.generic;
  var built = PROV.buildExternalRequest(preset, msg && msg.ids, cfg);
  if (!built) return Promise.resolve({ ok: false, message: '第三方接口地址没填' });

  var headers = {};
  built.headers.forEach(function (h) {
    if (h && h.name && h.value) headers[h.name] = h.value;
  });

  return withTimeout(
    fetch(built.url, {
      method: built.method,
      headers: headers,
      credentials: 'omit'
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }),
    built.timeoutMs, 'external'
  ).then(function (json) {
    var p = PROV.parseExternalResponse(preset, cfg, json);
    if (!p.ok) return { ok: false, message: p.error, kind: p.kind };
    return {
      ok: true,
      kind: p.kind,
      entries: p.entries || null,
      url: p.url || null,
      cues: p.cues || null
    };
  }).catch(function (e) {
    return { ok: false, message: String(e && e.message || e) };
  });
}

// ---------------------------------------------------------------- 统计

var STAT_FIELDS = {
  injectedVideos: 1,
  injectedEntries: 1,
  conclusionReady: 1,
  externalReady: 1
};

function bumpStat(field, by) {
  if (!STAT_FIELDS[field]) return Promise.resolve(null);
  var amount = Number(by) || 0;
  if (!amount) return Promise.resolve(null);

  return new Promise(function (resolve) {
    chrome.storage.local.get(SET.STORAGE_KEY, function (obj) {
      var s = SET.normalize((obj && obj[SET.STORAGE_KEY]) || {});
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
    case 'external-fetch':
      externalFetch(msg).then(sendResponse);
      return true;

    case 'bump-stat':
      bumpStat(msg.field, msg.by).then(function () {
        sendResponse({ ok: true });
      });
      return true;

    default:
      return;
  }
});
