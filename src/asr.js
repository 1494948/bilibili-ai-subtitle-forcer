/**
 * src/asr.js —— 可选的 ASR 兜底（内容脚本环境）
 *
 * 什么时候用：预取与注入都没拿到字幕，说明**服务端根本没有为这个视频生成 AI 字幕**。
 * 此时唯一的"无中生有"办法是自己识别音频。
 *
 * 做法：
 *   AudioContext 抓 video 的音轨 → MediaStreamDestination → MediaRecorder 分片
 *   → 每片交给 background 转发到用户自配的 OpenAI 兼容 ASR 接口
 *   → 拿回文本，按分片起止时间拼成 cue 列表交给渲染层。
 *
 * ⚠ 这是实验性路径，已知限制（README 里也写了）：
 *   1. 必须保持标签页在前台且视频在播放，切走或暂停就断片；
 *   2. 若视频源 CDN 未开放 CORS，createMediaElementSource 会输出静音，
 *      这里用 AnalyserNode 检测到全静音会直接报错而不是空转；
 *   3. 时间戳精度受分片秒数限制（默认 20 秒一片，片内按标点再均分）。
 */
(function (root) {
  'use strict';

  var NS = root.BASFBiliApi || null;

  var state = {
    running: false,
    ctx: null,
    source: null,
    dest: null,
    analyser: null,
    analyserBuf: null,
    recorder: null,
    video: null,
    cues: [],
    chunkStart: 0,
    seq: 0,
    submitted: 0,
    done: 0,
    failed: 0,
    settings: null,
    onCue: null,
    onStatus: null,
    silentSince: 0,
    timer: null
  };

  function report(level, message, extra) {
    if (typeof state.onStatus === 'function') {
      try {
        state.onStatus({ level: level, message: message, extra: extra || null, progress: progress() });
      } catch (e) { /* noop */ }
    }
  }

  function progress() {
    return {
      submitted: state.submitted,
      done: state.done,
      failed: state.failed,
      cues: state.cues.length,
      running: state.running
    };
  }

  function pickMime() {
    var cands = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    for (var i = 0; i < cands.length; i++) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(cands[i])) return cands[i];
      } catch (e) { /* noop */ }
    }
    return '';
  }

  /** 片内按标点均分，把 20 秒一整段拆成若干条更贴近口播的 cue */
  function splitChunkText(text, from, to) {
    var raw = String(text || '').trim();
    if (!raw) return [];
    var parts = raw
      .split(/(?<=[。！？；!?;.])\s*/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (parts.length <= 1) {
      return [{ from: from, to: to, text: raw }];
    }
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var span = Math.max(0.1, to - from);
    var out = [];
    var t = from;
    for (i = 0; i < parts.length; i++) {
      var share = span * (parts[i].length / total);
      var end = i === parts.length - 1 ? to : t + share;
      out.push({ from: round3(t), to: round3(end), text: parts[i] });
      t = end;
    }
    return out;
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function submitChunk(blob, from, to) {
    var seq = ++state.seq;
    state.submitted++;
    blob.arrayBuffer().then(function (buf) {
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({
          type: 'asr-transcribe',
          seq: seq,
          buffer: buf,
          mime: blob.type || 'audio/webm',
          settings: state.settings
        }, function (resp) {
          resolve(resp || { ok: false, error: '后台无响应' });
        });
      });
    }).then(function (resp) {
      if (!resp.ok) {
        state.failed++;
        report('warn', '第 ' + seq + ' 片识别失败：' + (resp.error || '未知错误'));
        return;
      }
      state.done++;
      var cues = [];
      if (Array.isArray(resp.segments) && resp.segments.length) {
        // 服务端给了真实时间轴，按分片起点平移
        for (var i = 0; i < resp.segments.length; i++) {
          var sg = resp.segments[i];
          var s = Number(sg.start);
          var e = Number(sg.end);
          var tx = String(sg.text || '').trim();
          if (!tx) continue;
          cues.push({
            from: round3(from + (isFinite(s) ? s : 0)),
            to: round3(from + (isFinite(e) ? e : (isFinite(s) ? s + 2 : 2))),
            text: tx
          });
        }
      } else {
        cues = splitChunkText(resp.text, from, to);
      }
      if (cues.length) {
        state.cues = state.cues.concat(cues).sort(function (a, b) { return a.from - b.from; });
        report('ok', '已识别 ' + state.cues.length + ' 条', { cues: cues.slice() });
        if (typeof state.onCue === 'function') {
          try { state.onCue(state.cues.slice()); } catch (e) { /* noop */ }
        }
      } else {
        report('info', '第 ' + seq + ' 片没有识别出文字');
      }
    }).catch(function (e) {
      state.failed++;
      report('warn', '第 ' + seq + ' 片处理异常：' + String(e && e.message || e));
    });
  }

  /** 检测音轨是否真的有声：CDN 不给 CORS 时这里会是纯静音 */
  function startSilenceWatch() {
    if (!state.analyser) return;
    var buf = state.analyserBuf;
    var quietTicks = 0;
    state.timer = setInterval(function () {
      if (!state.running || !state.analyser) return;
      try {
        state.analyser.getByteTimeDomainData(buf);
      } catch (e) {
        return;
      }
      var peak = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = Math.abs(buf[i] - 128);
        if (v > peak) peak = v;
      }
      if (peak > 2) {
        quietTicks = 0;
        return;
      }
      quietTicks++;
      // 连续约 4 秒完全静音 → 判定音轨拿不到，直接报错停下
      if (quietTicks === 20 && state.video && !state.video.paused) {
        report('error', '取到的音轨是静音：该视频源可能未开放 CORS，无法在浏览器内识别');
        stop();
      }
    }, 200);
  }

  function start(video, settings, handlers) {
    if (state.running) return { ok: false, error: '已经在运行' };
    if (!video) return { ok: false, error: '没有找到视频元素' };
    if (!window.MediaRecorder) return { ok: false, error: '浏览器不支持 MediaRecorder' };
    if (!settings || !settings.asr || !settings.asr.endpoint) {
      return { ok: false, error: '还没配置 ASR 接口地址' };
    }

    var mime = pickMime();
    if (!mime) return { ok: false, error: '浏览器不支持任何可用的录音编码' };

    state.settings = settings;
    state.onCue = handlers && handlers.onCue;
    state.onStatus = handlers && handlers.onStatus;
    state.cues = [];
    state.seq = 0;
    state.submitted = 0;
    state.done = 0;
    state.failed = 0;
    state.video = video;

    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!state.ctx) state.ctx = new Ctx();
      if (state.ctx.state === 'suspended') state.ctx.resume();

      // 对同一个 media 元素只能建一次 source，必须复用
      if (!video.__basfMediaSource) {
        video.__basfMediaSource = state.ctx.createMediaElementSource(video);
      }
      state.source = video.__basfMediaSource;

      state.dest = state.ctx.createMediaStreamDestination();
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 512;
      state.analyserBuf = new Uint8Array(state.analyser.fftSize);

      // 原音仍要正常从扬声器出来，否则用户会因为"没声音"以为坏了
      state.source.connect(state.ctx.destination);
      state.source.connect(state.dest);
      state.source.connect(state.analyser);
    } catch (e) {
      return { ok: false, error: '创建音频管线失败：' + String(e && e.message || e) };
    }

    try {
      state.recorder = new MediaRecorder(state.dest.stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      return { ok: false, error: '创建录音器失败：' + String(e && e.message || e) };
    }

    var chunkMs = Math.max(5, Number(settings.asr.chunkSeconds) || 20) * 1000;

    state.recorder.ondataavailable = function (ev) {
      if (!state.running) return;
      if (!ev.data || !ev.data.size) return;
      var now = Number(state.video && state.video.currentTime) || 0;
      var from = state.chunkStart;
      var to = now > from ? now : from + chunkMs / 1000;
      state.chunkStart = to;
      submitChunk(ev.data, from, to);
    };

    state.recorder.onerror = function (ev) {
      report('error', '录音出错：' + String(ev && ev.error && ev.error.name || 'unknown'));
    };

    try {
      state.recorder.start(chunkMs);
    } catch (e) {
      return { ok: false, error: '启动录音失败：' + String(e && e.message || e) };
    }

    state.running = true;
    state.chunkStart = Number(video.currentTime) || 0;
    startSilenceWatch();
    report('info', '已开始识别，每 ' + (chunkMs / 1000) + ' 秒提交一片');
    return { ok: true };
  }

  function stop() {
    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    try {
      if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    } catch (e) { /* noop */ }
    state.recorder = null;
    try {
      if (state.source) {
        state.source.disconnect(state.dest);
        state.source.disconnect(state.analyser);
      }
    } catch (e) { /* noop */ }
    state.dest = null;
    state.analyser = null;
    report('info', '已停止识别');
    return { ok: true, cues: state.cues.length };
  }

  function getCues() {
    return state.cues.slice();
  }

  root.BASFASR = {
    start: start,
    stop: stop,
    getCues: getCues,
    progress: progress,
    get running() { return state.running; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
