/**
 * src/hook.js —— MAIN world / document_start
 *
 * ★ 这是整个插件的技术核心。它要"强行让 AI 字幕开关出现"：
 *
 *   播放器的字幕语言列表完全由 `x/player/v2`（或 `x/player/wbi/v2`）响应里的
 *   `data.subtitle.subtitles[]` 决定。该字段在未登录时为空，且条目上的
 *   `is_lock` / 响应顶层的 `need_login_subtitle` 会进一步把 UI 关掉。
 *
 *   于是本脚本做三件事：
 *     1. 用免登录字幕通道 `x/v2/dm/view?aid=&oid=<cid>&type=1` 预取字幕列表；
 *     2. 劫持 XHR / fetch，在播放器接口的响应体里合并这些字幕条目，
 *        并把 `is_lock` 与 `need_login_subtitle` 一并拆掉；
 *     3. 播放器收到被改过的 JSON，自己就渲染出「中文（自动生成）」并在点击后
 *        正常加载 —— 不需要我们再碰它的 UI。
 *
 * 为什么必须在 MAIN world：要改的是页面自己的 XMLHttpRequest 与响应对象。
 * MAIN world 里没有 `chrome.*` API，所以与内容脚本之间用 postMessage 通信。
 *
 * 时序要点：`x/player/v2` 的 URL 里本身就带着 aid 与 cid，
 * 所以在 `open()` 里就能知道"这一条请求对应哪个视频"，
 * 再在 `send()` 里"先取字幕、后放行"，天然解决首次加载与分P切换的时序问题。
 */
(function () {
  'use strict';

  var NS = typeof globalThis !== 'undefined' ? globalThis.BASFBiliApi : null;
  if (!NS) return;                                   // lib/bili-api.js 没加载就先别动
  if (window.__BASF_HOOK_INSTALLED__) return;
  window.__BASF_HOOK_INSTALLED__ = true;

  // ------------------------------------------------------------ 常量

  var TAG = '[BASF/hook]';
  /** 单条 fetch 请求的超时（毫秒） */
  var ENDPOINT_TIMEOUT = 2500;
  /** 放行播放器请求前，最多愿意等多久（毫秒）。等不到就放行，不阻塞播放 */
  var HARD_DEADLINE = 1800;
  /** 字幕列表缓存上限（按 aid:cid 记） */
  var CACHE_MAX = 40;

  // ------------------------------------------------------------ 状态

  var debug = false;

  /** 字幕列表缓存：`${aid}:${cid}` → { promise, data, at } */
  var cache = new Map();
  /** 字幕文件内容缓存：url → cues */
  var contentCache = new Map();
  /** 已成功注入过的 cid，用于统计去重 */
  var injectedCids = Object.create(null);

  var settings = { forceInject: true, debug: false };

  function log() {
    if (!debug) return;
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift(TAG);
      console.log.apply(console, a);
    } catch (e) { /* noop */ }
  }

  // ------------------------------------------------------------ 与内容脚本通信

  function toContent(type, payload) {
    try {
      window.postMessage({ __basf: true, dir: 'to-content', type: type, payload: payload || null }, '*');
    } catch (e) { /* noop */ }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__basf !== true || d.dir !== 'to-hook') return;
    try {
      handleFromContent(d);
    } catch (e) {
      log('handleFromContent 出错', e);
    }
  });

  function handleFromContent(msg) {
    switch (msg.type) {
      case 'sync-settings':
        settings = Object.assign({}, settings, msg.payload || {});
        debug = !!settings.debug;
        log('设置已同步', settings);
        break;

      case 'request-state':
        toContent('state', stateSnapshot());
        break;

      case 'fetch-subtitle-content':
        // 由页面上下文去取字幕 JSON：Referer 正确、CORS 已被页面自身授权
        fetchSubtitleContent(msg.payload && msg.payload.url)
          .then(function (cues) {
            toContent('subtitle-content', {
              reqId: msg.payload && msg.payload.reqId,
              ok: true,
              cues: cues
            });
          })
          .catch(function (err) {
            toContent('subtitle-content', {
              reqId: msg.payload && msg.payload.reqId,
              ok: false,
              error: String(err && err.message || err)
            });
          });
        break;

      case 'ping':
        toContent('pong', { href: location.href });
        break;

      default:
        break;
    }
  }

  function stateSnapshot() {
    var keys = [];
    cache.forEach(function (v, k) {
      keys.push({ key: k, has: !!(v && v.data), entries: v && v.data && v.data.subtitles ? v.data.subtitles.length : 0 });
    });
    return { href: location.href, cache: keys, injected: Object.keys(injectedCids) };
  }

  // ------------------------------------------------------------ 取字幕

  function cacheKey(aid, cid) {
    return String(aid || 0) + ':' + String(cid || 0);
  }

  function getCached(aid, cid) {
    var k = cacheKey(aid, cid);
    var hit = cache.get(k);
    if (hit) return hit;
    return null;
  }

  function putCache(aid, cid, entry) {
    var k = cacheKey(aid, cid);
    cache.set(k, entry);
    if (cache.size > CACHE_MAX) {
      var firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    return entry;
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('timeout:' + label));
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

  /**
   * 用 bvid 换 aid（预取通道需要 aid）。结果按 bvid 缓存。
   */
  var aidByBvid = Object.create(null);

  function resolveAid(ids) {
    if (ids.aid) return Promise.resolve(ids.aid);
    if (!ids.bvid) return Promise.resolve(0);
    if (aidByBvid[ids.bvid]) return Promise.resolve(aidByBvid[ids.bvid]);
    var url = NS.API_HOST + '/x/web-interface/view?bvid=' + encodeURIComponent(ids.bvid);
    return withTimeout(fetch(url, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var aid = j && j.data ? Number(j.data.aid) || 0 : 0;
        if (aid) aidByBvid[ids.bvid] = aid;
        return aid;
      }), ENDPOINT_TIMEOUT, 'view').catch(function () { return 0; });
  }

  /**
   * 依次尝试所有字幕数据源，返回第一个含条目的 subtitle 对象。
   * 命中后按 (aid,cid) 缓存整个 promise —— 同一个视频的并发请求共享一次网络往返。
   */
  function prefetchSubtitle(rawIds) {
    var ids = { aid: Number(rawIds.aid) || 0, cid: Number(rawIds.cid) || 0, bvid: rawIds.bvid || '' };
    if (!ids.cid) return Promise.resolve(null);

    var hit = getCached(ids.aid, ids.cid);
    if (hit) return hit.promise;

    var entry = { data: null, promise: null, at: Date.now(), tried: [], done: false };

    entry.promise = resolveAid(ids).then(function (aid) {
      ids.aid = aid || ids.aid;
      if (!ids.aid && !ids.cid) return null;

      var eps = NS.SUBTITLE_ENDPOINTS.filter(function (ep) {
        // dm/web/subtitles 只要 cid；其余要 aid
        if (ep.id === 'dm-web-subtitles') return !!ids.cid;
        return !!ids.aid && !!ids.cid;
      });

      var i = 0;
      function next() {
        if (i >= eps.length) return Promise.resolve(null);
        var ep = eps[i++];
        var url;
        try {
          url = ep.build(ids);
        } catch (e) {
          return next();
        }
        entry.tried.push(ep.id);
        return withTimeout(
          fetch(url, { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { return NS.extractSubtitle(j); }),
          ENDPOINT_TIMEOUT, ep.id
        ).then(function (sub) {
          if (sub) {
            log('预取命中', ep.id, '条目数=' + sub.subtitles.length, 'aid=' + ids.aid, 'cid=' + ids.cid);
            return sub;
          }
          return next();
        }, function () {
          return next();
        });
      }

      return next();
    }).then(function (sub) {
      entry.data = sub;
      entry.done = true;
      if (!sub) log('预取未命中任何源', ids);
      toContent('subtitle-ready', {
        ids: ids,
        subtitle: sub,
        tried: entry.tried,
        aiCount: sub ? sub.subtitles.filter(NS.isAiEntry).length : 0,
        total: sub ? sub.subtitles.length : 0
      });
      return sub;
    }).catch(function (e) {
      entry.done = true;
      log('预取出错', e);
      return null;
    });

    return putCache(ids.aid, ids.cid, entry).promise;
  }

  /** 取字幕文件内容并解析成 cue 数组 */
  function fetchSubtitleContent(rawUrl) {
    var url = String(rawUrl || '');
    if (!url) return Promise.reject(new Error('空字幕地址'));
    if (contentCache.has(url)) return Promise.resolve(contentCache.get(url));

    var abs = url.indexOf('//') === 0 ? (location.protocol + url) : url;
    return withTimeout(
      fetch(abs, { credentials: 'omit' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          var cues = NS.parseCueList(j);
          contentCache.set(url, cues);
          if (contentCache.size > 20) {
            contentCache.delete(contentCache.keys().next().value);
          }
          return cues;
        }),
      15000, 'subtitle-file'
    );
  }

  // ------------------------------------------------------------ XHR 劫持

  var proto = XMLHttpRequest.prototype;
  var rawOpen = proto.open;
  var rawSend = proto.send;
  var descResponseText = Object.getOwnPropertyDescriptor(proto, 'responseText');
  var descResponse = Object.getOwnPropertyDescriptor(proto, 'response');

  function idsFromApiUrl(url) {
    var out = { aid: 0, cid: 0, bvid: '' };
    var u = String(url || '');
    var m = /[?&]aid=(\d+)/.exec(u);
    if (m) out.aid = parseInt(m[1], 10) || 0;
    m = /[?&]cid=(\d+)/.exec(u);
    if (m) out.cid = parseInt(m[1], 10) || 0;
    m = /[?&]bvid=(BV[0-9A-Za-z]{10})/.exec(u);
    if (m) out.bvid = m[1];
    if (!out.bvid) out.bvid = NS.parseBvid(u);
    return out;
  }

  proto.open = function (method, url) {
    try {
      var u = typeof url === 'string' ? url : String(url || '');
      this.__basf_url = u;
      if (NS.isPlayerInfoUrl(u)) {
        this.__basf_patch = true;
        this.__basf_ids = idsFromApiUrl(u);
        // ★ 在 open 阶段就注册监听：早于页面任何注册，保证我们的改写先执行
        this.addEventListener('readystatechange', onPlayerApiState);
      }
    } catch (e) { /* noop */ }
    return rawOpen.apply(this, arguments);
  };

  /** 读原始响应（绕开我们稍后覆盖的实例 getter） */
  function readRawResponse(xhr) {
    var type = xhr.responseType;
    if (type === '' || type === 'text') {
      return { kind: 'text', value: descResponseText.get.call(xhr) };
    }
    if (type === 'json') {
      return { kind: 'json', value: descResponse.get.call(xhr) };
    }
    return { kind: 'other', value: null };
  }

  /**
   * 播放器接口响应就绪时调用：把预取到的字幕并进去，再覆盖实例 getter，
   * 使页面后续读到的就是"带着 AI 字幕的那份 JSON"。
   */
  function onPlayerApiState() {
    var xhr = this;
    if (xhr.readyState !== 4) return;
    if (xhr.__basf_done) return;
    xhr.__basf_done = true;

    try {
      if (!settings.forceInject) return;
      if (xhr.status !== 200) return;

      var entry = xhr.__basf_sub
        ? { data: xhr.__basf_sub }
        : getCached(xhr.__basf_ids && xhr.__basf_ids.aid, xhr.__basf_ids && xhr.__basf_ids.cid);
      var subtitle = entry && entry.data;
      if (!subtitle || !subtitle.subtitles || !subtitle.subtitles.length) return;

      var raw = readRawResponse(xhr);
      if (raw.kind === 'other') return;

      var body;
      if (raw.kind === 'json') {
        body = raw.value;
      } else {
        if (typeof raw.value !== 'string' || !raw.value) return;
        try {
          body = JSON.parse(raw.value);
        } catch (e) {
          log('响应不是 JSON，跳过', xhr.__basf_url);
          return;
        }
      }

      var result = NS.mergeSubtitle(body, subtitle, { forceUnlock: true });
      if (!result.ok) {
        log('未注入', result.reason, xhr.__basf_url);
        return;
      }

      if (raw.kind === 'json') {
        // responseType='json' 时，播放器读 xhr.response
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () { return body; }
        });
      } else {
        var text = JSON.stringify(body);
        Object.defineProperty(xhr, 'responseText', {
          configurable: true,
          get: function () { return text; }
        });
        Object.defineProperty(xhr, 'response', {
          configurable: true,
          get: function () { return text; }
        });
      }

      var cid = xhr.__basf_ids && xhr.__basf_ids.cid;
      var first = cid && !injectedCids[cid];
      if (first) injectedCids[cid] = 1;

      log('已注入', result, xhr.__basf_url);
      toContent('injected', {
        ids: xhr.__basf_ids,
        added: result.added,
        total: result.total,
        unlockedLogin: result.unlockedLogin,
        first: !!first,
        via: 'xhr'
      });
    } catch (e) {
      log('注入异常', e);
    }
  }

  proto.send = function (body) {
    var xhr = this;
    if (!xhr.__basf_patch) return rawSend.apply(xhr, arguments);

    // 非强制注入模式：直接放行，不增加任何延迟
    if (!settings.forceInject) return rawSend.apply(xhr, arguments);

    var ids = xhr.__basf_ids || { aid: 0, cid: 0, bvid: '' };
    var cached = getCached(ids.aid, ids.cid);
    if (cached && cached.done) {
      // 已经有结论（成功或失败）：不等待，立即放行，零额外延迟
      xhr.__basf_sub = cached.data;
      return rawSend.apply(xhr, arguments);
    }

    // ★ 先取字幕、后放行：保证响应到达时改写所需的数据已经就位
    var settled = false;
    var fire = function () {
      if (settled) return;
      settled = true;
      rawSend.apply(xhr, arguments);
    };

    var prefetch = prefetchSubtitle(ids).then(function (sub) {
      xhr.__basf_sub = sub;
      return sub;
    });

    // 硬超时保护：宁可少注入，也不能卡住视频
    setTimeout(fire, HARD_DEADLINE);
    Promise.race([
      prefetch,
      new Promise(function (r) { setTimeout(r, HARD_DEADLINE); })
    ]).then(fire, fire);
  };

  // ------------------------------------------------------------ fetch 劫持

  var rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      try {
        url = typeof input === 'string' ? input
          : (input && input.url ? input.url : String(input));
      } catch (e) { /* noop */ }

      var p = rawFetch.apply(this, arguments);
      if (!NS.isPlayerInfoUrl(url) || !settings.forceInject) return p;

      var ids = idsFromApiUrl(url);
      return p.then(function (res) {
        var hit = getCached(ids.aid, ids.cid);
        var ready = hit && hit.done ? Promise.resolve(hit.data) : prefetchSubtitle(ids);
        return withTimeout(ready, HARD_DEADLINE, 'fetch-inject').catch(function () { return null; })
          .then(function (subtitle) {
            if (!subtitle || !subtitle.subtitles || !subtitle.subtitles.length) return res;
            var clone;
            try {
              clone = res.clone();
            } catch (e) {
              return res;
            }
            return clone.json().then(function (body) {
              var result = NS.mergeSubtitle(body, subtitle, { forceUnlock: true });
              if (!result.ok) return res;
              var headers = new Headers();
              try {
                res.headers.forEach(function (v, k) {
                  var lk = k.toLowerCase();
                  // 长度与编码都变了，必须丢掉，否则浏览器会按旧值解析
                  if (lk === 'content-length' || lk === 'content-encoding') return;
                  headers.set(k, v);
                });
              } catch (e) { /* noop */ }
              var first = ids.cid && !injectedCids[ids.cid];
              if (first) injectedCids[ids.cid] = 1;
              toContent('injected', {
                ids: ids,
                added: result.added,
                total: result.total,
                unlockedLogin: result.unlockedLogin,
                first: !!first,
                via: 'fetch'
              });
              return new Response(JSON.stringify(body), {
                status: res.status,
                statusText: res.statusText,
                headers: headers
              });
            }).catch(function () { return res; });
          });
      });
    };
  }

  // ------------------------------------------------------------ 提前预取（提速）

  /** 抢在页面脚本之前拿到 __INITIAL_STATE__，用于提前预取，省掉 send 时的等待 */
  var initState = null;

  function onInitialState(v) {
    try {
      var ids = NS.idsFromInitialState(v);
      if (ids.cid) {
        log('从 __INITIAL_STATE__ 拿到', ids);
        prefetchSubtitle(ids);
        toContent('ids', ids);
      }
    } catch (e) { /* noop */ }
  }

  try {
    Object.defineProperty(window, '__INITIAL_STATE__', {
      configurable: true,
      enumerable: true,
      get: function () { return initState; },
      set: function (v) {
        initState = v;
        try { onInitialState(v); } catch (e) { /* noop */ }
      }
    });
  } catch (e) {
    log('__INITIAL_STATE__ 劫持失败，走 URL 解析兜底', e);
  }

  // 兜底：SSR 脚本若在别处赋值，或页面直接读 URL，就按 BV 号预取
  function bootstrapFromUrl() {
    var bvid = NS.parseBvid(location.href);
    if (!bvid) return;
    if (aidByBvid[bvid]) return;
    if (window.__BASF_LAST_BOOTSTRAP__ === location.href) return;
    window.__BASF_LAST_BOOTSTRAP__ = location.href;
    var p = NS.parsePageParam(location.href);
    // 换 P 时要重新按 cid 预取：先拿 pages 列表定位当前 cid
    withTimeout(fetch(NS.API_HOST + '/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.data) return null;
        var d = j.data;
        aidByBvid[bvid] = Number(d.aid) || aidByBvid[bvid];
        var pages = Array.isArray(d.pages) ? d.pages : [];
        var pg = pages[p - 1] || pages[0];
        if (!pg) return null;
        log('URL 兜底预取 aid=' + d.aid + ' cid=' + pg.cid);
        return prefetchSubtitle({ aid: Number(d.aid) || 0, cid: Number(pg.cid) || 0, bvid: bvid });
      }), ENDPOINT_TIMEOUT, 'bootstrap').catch(function () { /* noop */ });
  }

  try { bootstrapFromUrl(); } catch (e) { /* noop */ }

  // SPA 路由变化（站内跳转 / 换 P）后重新兜底一次
  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    try { bootstrapFromUrl(); } catch (e) { /* noop */ }
  }, 1200);

  // ------------------------------------------------------------ 对外自述

  toContent('hook-ready', { version: NS.VERSION, href: location.href });
  log('已装载 v' + NS.VERSION);
})();
