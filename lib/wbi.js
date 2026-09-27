/**
 * lib/wbi.js —— WBI 签名（B 站 Web 端风控签名，2023-03 起启用）
 *
 * 为什么需要它：本项目要调用的「AI 视频总结」接口
 * `x/web-interface/view/conclusion/get` 强制要求 WBI 签名 —— 而这条接口正是
 * **触发 B 站服务端为该视频生成 AI 字幕**的入口，所以签名是绕不过去的。
 *
 * 算法（以官方文档为准）：
 *   1. 从 `x/web-interface/nav` 的 `data.wbi_img.{img_url,sub_url}` 取文件名，
 *      分别得到 img_key 与 sub_key（这两个 url 是伪装的实时 token，不要真去访问）；
 *   2. 把 sub_key 拼在 img_key 后面，按 MIXIN_KEY_ENC_TAB 重排，取前 32 位 → mixin_key；
 *   3. 请求参数加上 wts、按 key 升序排序、过滤 value 里的 "!'()*" 字符、
 *      用 encodeURIComponent 规则编码拼接，再拼上 mixin_key，取 MD5 → w_rid。
 *
 * img_key / sub_key 每日更替，所以带缓存。
 *
 * 依赖：本文件自带纯 JS 的 MD5 实现（不引任何库，扩展里本来也没有 require）。
 * 双出口：Node `require()` / 浏览器 `globalThis.BASFWbi`
 */
(function (root, factory) {
  var API = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.BASFWbi = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------- MD5

  /** 把字符串按 UTF-8 编成字节数组 */
  function utf8Bytes(str) {
    var s = String(str);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        // 代理对（emoji 等）
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(
            0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)
          );
          i++;
          continue;
        }
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  // 每轮左移位数
  var MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  // K[i] = floor(abs(sin(i+1)) * 2^32)
  var MD5_K = (function () {
    var k = new Uint32Array(64);
    for (var i = 0; i < 64; i++) {
      k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }
    return k;
  })();

  function rotl(x, c) {
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }

  function md5Bytes(bytes) {
    var len = bytes.length;
    // 补一个 0x80，再补 0 到 56 mod 64，末尾 8 字节放原始比特长度（小端）
    var blockCount = Math.floor((len + 8) / 64) + 1;
    var total = blockCount * 64;
    var buf = new Uint8Array(total);
    for (var i = 0; i < len; i++) buf[i] = bytes[i];
    buf[len] = 0x80;

    var bitLen = len * 8;
    var lo = bitLen >>> 0;
    var hi = Math.floor(bitLen / 4294967296) >>> 0;
    buf[total - 8] = lo & 0xff;
    buf[total - 7] = (lo >>> 8) & 0xff;
    buf[total - 6] = (lo >>> 16) & 0xff;
    buf[total - 5] = (lo >>> 24) & 0xff;
    buf[total - 4] = hi & 0xff;
    buf[total - 3] = (hi >>> 8) & 0xff;
    buf[total - 2] = (hi >>> 16) & 0xff;
    buf[total - 1] = (hi >>> 24) & 0xff;

    var a0 = 0x67452301;
    var b0 = 0xefcdab89;
    var c0 = 0x98badcfe;
    var d0 = 0x10325476;

    for (var off = 0; off < total; off += 64) {
      var M = new Uint32Array(16);
      for (var j = 0; j < 16; j++) {
        var p = off + j * 4;
        M[j] = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
      }

      var A = a0;
      var B = b0;
      var C = c0;
      var D = d0;

      for (var r = 0; r < 64; r++) {
        var F;
        var g;
        if (r < 16) {
          F = (B & C) | (~B & D);
          g = r;
        } else if (r < 32) {
          F = (D & B) | (~D & C);
          g = (5 * r + 1) % 16;
        } else if (r < 48) {
          F = B ^ C ^ D;
          g = (3 * r + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * r) % 16;
        }
        var sum = (F + A + MD5_K[r] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl(sum, MD5_S[r])) >>> 0;
      }

      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    // MD5 输出是小端
    return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
  }

  function hexLE(n) {
    var s = '';
    for (var i = 0; i < 4; i++) {
      var b = (n >>> (i * 8)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  function md5(input) {
    return md5Bytes(utf8Bytes(input));
  }

  // ---------------------------------------------------------------- WBI

  /** 混入密钥重排表（长度 64） */
  var MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  /** 从 img_key + sub_key 算出 mixin_key（重排后取前 32 位） */
  function getMixinKey(imgKey, subKey) {
    var raw = String(imgKey || '') + String(subKey || '');
    var out = '';
    for (var i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
      var idx = MIXIN_KEY_ENC_TAB[i];
      out += raw.charAt(idx);
    }
    return out.slice(0, 32);
  }

  /** 从 nav 接口的响应里取 { imgKey, subKey }；拿不到返回 null */
  function parseWbiKeys(navResponse) {
    var img = navResponse && navResponse.data && navResponse.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) return null;
    var ik = String(img.img_url).split('/').pop().split('.')[0];
    var sk = String(img.sub_url).split('/').pop().split('.')[0];
    if (!ik || !sk) return null;
    return { imgKey: ik, subKey: sk };
  }

  /**
   * 计算签名并返回完整的 query string（含 w_rid 与 wts）。
   *
   * 注意：签名时参数要按 key 升序排序，但返回给请求用的 query **不排序**——
   * 文档明确说了"追加签名字段到原始请求参数编码得到的 URL Query 后即可，无需排序"。
   * 这里为了简单，请求也直接用排序后的顺序（B 站对此不敏感），
   * 但 wts 的值会被带回，调用方可直接用。
   *
   * @param {object} params  请求参数（不含 w_rid / wts）
   * @param {string} imgKey
   * @param {string} subKey
   * @param {number} [wts]   指定时间戳（测试用；默认取当前秒）
   * @returns {{query:string, wts:number, wRid:string, mixinKey:string}}
   */
  function encWbi(params, imgKey, subKey, wts) {
    var mixinKey = getMixinKey(imgKey, subKey);
    var ts = wts === undefined || wts === null ? Math.round(Date.now() / 1000) : wts;

    var merged = {};
    var k;
    for (k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) merged[k] = params[k];
    }
    merged.wts = ts;

    var keys = Object.keys(merged).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = merged[key];
      // 过滤 "!'()*" —— 文档要求，且 encodeURIComponent 本身也不会编码这些字符
      var clean = String(val === undefined || val === null ? '' : val).replace(/[!'()*]/g, '');
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(clean));
    }
    var query = parts.join('&');
    var wRid = md5(query + mixinKey);

    return {
      query: query + '&w_rid=' + wRid,
      baseQuery: query,
      wts: ts,
      wRid: wRid,
      mixinKey: mixinKey
    };
  }

  /** 直接拼出带签名的完整 URL */
  function signUrl(baseUrl, params, imgKey, subKey, wts) {
    var signed = encWbi(params, imgKey, subKey, wts);
    var sep = baseUrl.indexOf('?') >= 0 ? '&' : '?';
    return baseUrl + sep + signed.query;
  }

  return {
    md5: md5,
    md5Bytes: md5Bytes,
    utf8Bytes: utf8Bytes,
    MIXIN_KEY_ENC_TAB: MIXIN_KEY_ENC_TAB,
    getMixinKey: getMixinKey,
    parseWbiKeys: parseWbiKeys,
    encWbi: encWbi,
    signUrl: signUrl,
    VERSION: '2.1.0'
  };
});
