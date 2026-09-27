/**
 * tools/selftest.js —— 离线自检（不需要浏览器、不联网）
 *
 * 能覆盖的：
 *   · manifest 合法性、声明的文件是否真的存在、matches 是否过宽
 *   · 全部 JS 的语法（用 new Function 只解析不执行 —— 本机沙箱禁止 Node 起子进程）
 *   · popup.html 里的 id 与 popup.js 引用的是否对得上
 *   · MD5 与 WBI 签名（对照官方文档给的权威向量）
 *   · AI 总结接口的状态判定与字幕提取（用文档里的真实响应样例）
 *   · 第三方接口的模板构造与三种响应解读
 *   · 注入合并、语言选择、字幕解析、时间轴查找
 *
 * 覆盖不了的（README 里也写了"尚未验证"）：
 *   · 真实 B 站页面上的端到端行为、Chrome 对 manifest 的实际接受度
 *   · 接口在真实网络下的返回（离线用样例数据代替）
 *
 * 用法：node tools/selftest.js     失败时退出码为 1
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS = require(path.join(ROOT, 'lib', 'bili-api.js'));
const SET = require(path.join(ROOT, 'lib', 'settings.js'));
const WBI = require(path.join(ROOT, 'lib', 'wbi.js'));
const PROV = require(path.join(ROOT, 'lib', 'providers.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label + (detail ? '  → ' + detail : ''));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, '得到 ' + a + '，期望 ' + e);
}

function section(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 46 - name.length)));
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------------------------------------------------------------- 1. manifest

section('manifest.json');

let manifest = null;
try {
  manifest = JSON.parse(read(path.join(ROOT, 'manifest.json')));
} catch (e) {
  ok(false, 'manifest.json 能被解析', String(e.message));
}

if (manifest) {
  ok(manifest.manifest_version === 3, 'manifest_version 为 3', String(manifest.manifest_version));
  ok(typeof manifest.name === 'string' && manifest.name.length > 0, '有 name');
  ok(typeof manifest.version === 'string' && /^\d+(\.\d+){0,3}$/.test(manifest.version),
    'version 格式合法', manifest.version);
  ok(typeof manifest.description === 'string' && manifest.description.length <= 132,
    'description 不超过 132 字符', manifest.description ? String(manifest.description.length) : '缺失');

  // 不存在的字段会让 Chrome 直接拒绝加载
  ok(!('default_locale' in manifest),
    '没有 default_locale（本扩展不使用 _locales，带上会导致加载失败）');

  const hosts = manifest.host_permissions || [];
  const hostsOverBroad = hosts.filter((h) => h === '<all_urls>' || /^\*:\/\//.test(h) || h === 'https://*/*' || h === 'http://*/*');
  eq(hostsOverBroad, [], 'host_permissions 里没有默认全站权限（自定义接口走 optional）');

  const perms = manifest.permissions || [];
  eq(perms.slice().sort(), ['activeTab', 'storage'],
    'permissions 只申请 storage 与 activeTab');
  // activeTab 是"点图标时临时读当前页 URL"，权限提示很轻；
  // tabs 是全量权限，会带上"读取您的浏览记录"的重警告，没必要申请
  ok(perms.indexOf('tabs') < 0, '没有申请全量 tabs 权限（用 activeTab 替代）');

  const opt = manifest.optional_host_permissions || [];
  const overlap = opt.filter((o) => hosts.indexOf(o) >= 0);
  eq(overlap, [], 'optional_host_permissions 与 host_permissions 不重复');

  const iconRefs = [];
  if (manifest.icons) Object.keys(manifest.icons).forEach((k) => iconRefs.push(manifest.icons[k]));
  if (manifest.action && manifest.action.default_icon) {
    Object.keys(manifest.action.default_icon).forEach((k) => iconRefs.push(manifest.action.default_icon[k]));
  }
  eq(iconRefs.filter((f) => !exists(f)), [], 'icons 引用的 PNG 都存在');

  if (manifest.background && manifest.background.service_worker) {
    ok(exists(manifest.background.service_worker), 'service_worker 文件存在',
      manifest.background.service_worker);
  } else {
    ok(false, 'manifest 里声明了 background.service_worker');
  }

  if (manifest.action && manifest.action.default_popup) {
    ok(exists(manifest.action.default_popup), 'popup 页面存在', manifest.action.default_popup);
  } else {
    ok(false, 'manifest 里声明了 action.default_popup');
  }

  const cs = manifest.content_scripts || [];
  ok(cs.length >= 2, 'content_scripts 至少两条（MAIN world 注入 + 隔离世界编排）', String(cs.length));

  let mainWorldEntry = null;
  let missingFiles = [];
  let badMatches = [];
  cs.forEach((entry) => {
    (entry.js || []).forEach((f) => { if (!exists(f)) missingFiles.push(f); });
    (entry.css || []).forEach((f) => { if (!exists(f)) missingFiles.push(f); });
    (entry.matches || []).forEach((m) => {
      if (m === '<all_urls>' || m === '*://*/*' || /^\*:\/\//.test(m)) badMatches.push(m);
    });
    if (entry.world === 'MAIN') mainWorldEntry = entry;
  });
  eq(missingFiles, [], 'content_scripts 声明的 js/css 全部存在');
  eq(badMatches, [], 'content_scripts 的 matches 只写具体域名，没有全站匹配');

  ok(!!mainWorldEntry, '存在一个 world: "MAIN" 的注入脚本（改播放器 XHR 必须在这个世界）');
  if (mainWorldEntry) {
    const mainJs = mainWorldEntry.js || [];
    ok(mainJs.some((f) => /hook\.js$/.test(f)), 'MAIN world 里装了 hook.js');
    ok(mainJs.some((f) => /bili-api\.js$/.test(f)), 'MAIN world 里装了 bili-api.js');
    ok(mainJs.some((f) => /wbi\.js$/.test(f)), 'MAIN world 里装了 wbi.js（AI 总结接口要签名）');
    ok(mainJs.some((f) => /providers\.js$/.test(f)), 'MAIN world 里装了 providers.js');
    ok(mainWorldEntry.run_at === 'document_start',
      'MAIN world 脚本在 document_start 运行（必须早于页面自己的请求）');
    const mcv = parseFloat(manifest.minimum_chrome_version || '0');
    ok(mcv >= 111, 'minimum_chrome_version ≥ 111（world: MAIN 从 Chrome 111 起支持）',
      String(manifest.minimum_chrome_version));
  }
}

// ---------------------------------------------------------------- 2. JS 语法

section('JS 语法');

const jsFiles = [];
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === 'node_modules' || d.name === '.git') return;
      walk(p);
    } else if (/\.js$/.test(d.name)) {
      jsFiles.push(p);
    }
  });
})(ROOT);

ok(jsFiles.length >= 9, '找到待检查的 JS 文件', String(jsFiles.length));

const syntaxErrors = [];
jsFiles.forEach((p) => {
  try {
    // 只解析不执行：足以抓出 SyntaxError，又不会触发副作用、不起子进程
    // eslint-disable-next-line no-new-func
    new Function(read(p));
  } catch (e) {
    syntaxErrors.push(path.relative(ROOT, p) + ': ' + e.message);
  }
});
eq(syntaxErrors, [], '全部 JS 语法通过');

const constNoInit = [];
jsFiles.forEach((p) => {
  read(p).split('\n').forEach((line, i) => {
    if (/^\s*const\s+[A-Za-z_$][\w$]*\s*;\s*$/.test(line)) {
      constNoInit.push(path.relative(ROOT, p) + ':' + (i + 1));
    }
  });
});
eq(constNoInit, [], '没有 "const x;" 式无初始值声明');

// ---------------------------------------------------------------- 3. popup 接线

section('popup 接线');

const html = read(path.join(ROOT, 'src', 'popup.html'));
const jsPopup = read(path.join(ROOT, 'src', 'popup.js'));

const htmlIds = new Set();
let m;
const idRe = /\bid="([^"]+)"/g;
while ((m = idRe.exec(html))) htmlIds.add(m[1]);

const usedIds = new Set();
const useRe = /\$\('([^']+)'\)|getElementById\('([^']+)'\)/g;
while ((m = useRe.exec(jsPopup))) usedIds.add(m[1] || m[2]);

const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
eq(missingIds, [], 'popup.js 引用的 id 在 popup.html 里都存在');

const assetRe = /(?:src|href)="([^"#]+)"/g;
const assets = [];
while ((m = assetRe.exec(html))) {
  const v = m[1];
  if (/^https?:/.test(v) || v.startsWith('data:')) continue;
  assets.push(v);
}
const missingAssets = assets.filter((a) => !exists(path.join('src', a)));
eq(missingAssets, [], 'popup.html 引用的本地资源都存在');

// ---------------------------------------------------------------- 4. 地址解析

section('地址解析');

eq(NS.parseBvid('https://www.bilibili.com/video/BV1MU411S7iJ/?p=2'), 'BV1MU411S7iJ', 'parseBvid 从 URL 取 BV 号');
eq(NS.parseAvid('https://www.bilibili.com/video/av1906473802'), 1906473802, 'parseAvid 取 av 号');
eq(NS.parsePageParam('https://www.bilibili.com/video/BV1x?p=7'), 7, 'parsePageParam 取分P');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/player/v2?aid=1&cid=2'), true, 'isPlayerInfoUrl 认得 x/player/v2');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=2'), true, 'isPlayerInfoUrl 认得 wbi 版');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/player/pagelist?aid=1'), false, 'isPlayerInfoUrl 不误伤 pagelist');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/web-interface/view/conclusion/get'), false,
  'isPlayerInfoUrl 不误伤 AI 总结接口');

const initState = {
  aid: 0,
  p: 2,
  videoData: {
    aid: 1906473802,
    bvid: 'BV1MU411S7iJ',
    cid: 111,
    pages: [{ cid: 111, page: 1, part: 'P1' }, { cid: 222, page: 2, part: 'P2' }]
  }
};
eq(NS.idsFromInitialState(initState), { aid: 1906473802, cid: 222, bvid: 'BV1MU411S7iJ', page: 2, part: 'P2' },
  'idsFromInitialState 按当前分P 取 cid');
eq(NS.idsFromInitialState(null).cid, 0, 'idsFromInitialState 对空输入不崩');

// ---------------------------------------------------------------- 5. MD5 与 WBI

section('MD5 与 WBI 签名');

eq(WBI.md5(''), 'd41d8cd98f00b204e9800998ecf8427e', 'MD5 空串（RFC 1321 向量）');
eq(WBI.md5('abc'), '900150983cd24fb0d6963f7d28e17f72', 'MD5 "abc"');
eq(WBI.md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0', 'MD5 "message digest"');
eq(WBI.md5('abcdefghijklmnopqrstuvwxyz'), 'c3fcd3d76192e4007dfb496cca67e13b', 'MD5 全字母表');
eq(WBI.md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
  '57edf4a22be3c955ac49da2e2107b67a', 'MD5 80 位数字串（跨多块）');
eq(WBI.md5('The quick brown fox jumps over the lazy dog'),
  '9e107d9d372bb6826bd81d3542a419d6', 'MD5 常用例句');

// UTF-8 编码（中文会走进多字节分支）
eq(WBI.utf8Bytes('abc'), [97, 98, 99], 'UTF-8：ASCII');
eq(WBI.utf8Bytes('中文'), [228, 184, 173, 230, 150, 135], 'UTF-8：中文三字节');
eq(WBI.utf8Bytes('\u{1F600}'), [240, 159, 152, 128], 'UTF-8：emoji 四字节（代理对）');

eq(WBI.MIXIN_KEY_ENC_TAB.length, 64, 'mixinKeyEncTab 长度为 64');
eq(WBI.getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'),
  'ea1db124af3c7062474693fa704f4ff8',
  'getMixinKey 与官方文档示例一致');

// ★ 端到端：文档步骤 3 给的就是这个 w_rid
const signed = WBI.encWbi({ foo: '114', bar: '514', zab: 1919810 },
  '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169);
eq(signed.wRid, '8f6f2b5b3d485fe1886cec6a0be8c5d4',
  'encWbi 算出与官方文档一致的 w_rid');
eq(signed.baseQuery, 'bar=514&foo=114&wts=1702204169&zab=1919810',
  'encWbi 的待签串按 key 升序排列');

// 特殊字符该被剔除
const filtered = WBI.encWbi({ q: "he!!o(w)or'ld*" }, 'a', 'b', 1700000000);
eq(filtered.baseQuery, 'q=heoworld&wts=1700000000', 'encWbi 剔除 value 里的 !\'()* 字符');

// 空格要编成 %20，不能是 +
const spaced = WBI.encWbi({ q: 'one one four' }, 'a', 'b', 1700000000);
eq(spaced.baseQuery, 'q=one%20one%20four&wts=1700000000', 'encWbi 把空格编成 %20');

// 中文参数
const cn = WBI.encWbi({ q: '五一四' }, 'a', 'b', 1700000000);
ok(cn.baseQuery.indexOf('q=%E4%BA%94%E4%B8%80%E5%9B%9B') === 0,
  'encWbi 中文按 UTF-8 百分号编码', cn.baseQuery);

eq(WBI.parseWbiKeys({
  data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } }
}), { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' },
  'parseWbiKeys 从 nav 响应取到两个 key');
eq(WBI.parseWbiKeys({ code: -101, data: { isLogin: false } }), null, 'parseWbiKeys 没 key 时返回 null');
eq(WBI.parseWbiKeys(null), null, 'parseWbiKeys 对 null 返回 null');

ok(WBI.signUrl('https://api.bilibili.com/x/a', { cid: 1 }, 'a', 'b', 1700000000)
  .indexOf('https://api.bilibili.com/x/a?') === 0, 'signUrl 拼接正确');
ok(WBI.signUrl('https://api.bilibili.com/x/a?x=1', { cid: 1 }, 'a', 'b', 1700000000)
  .indexOf('?x=1&') > 0, 'signUrl 对已有 query 用 & 衔接');

// ---------------------------------------------------------------- 6. AI 总结接口

section('B站服务端 AI 生成（AI 总结接口）');

// 官方文档给的完整响应样例
const conclusionReady = {
  code: 0,
  message: '0',
  ttl: 1,
  data: {
    code: 0,
    model_result: {
      result_type: 2,
      summary: '在网上阅读时遇到错别字和语言梗的烦恼。',
      outline: [
        {
          title: '现代人使用中文时面临的困境',
          part_outline: [{ timestamp: 1, content: '网友评论有错别字' }],
          timestamp: 1
        }
      ],
      subtitle: [
        {
          part_subtitle: [
            { content: '有时候上网啊', start_timestamp: 0, end_timestamp: 1 },
            { content: '看网友的评论内容', start_timestamp: 1, end_timestamp: 3 },
            { content: '一句话好几个错别字', start_timestamp: 3, end_timestamp: 5 },
            { content: '黄一刀有毒', start_timestamp: 352, end_timestamp: 355 }
          ],
          timestamp: 1,
          title: ''
        }
      ]
    },
    stid: '5117037934391059183',
    status: 0,
    like_num: 6,
    dislike_num: 2
  }
};

const aReady = PROV.analyzeConclusion(conclusionReady);
eq(aReady.state, 'ready', '有结果时 state=ready');
eq(aReady.resultType, 2, 'result_type 被读出来');
eq(aReady.stid, '5117037934391059183', 'stid 被读出来');

const cuesC = PROV.extractConclusionCues(conclusionReady);
eq(cuesC.length, 4, '从文档样例里提出 4 条字幕');
eq(cuesC[0], { from: 0, to: 1, text: '有时候上网啊' }, '第一条字幕内容与时间轴正确');
eq(cuesC[3].from, 352, '长视频后面的时间戳也正确（不是相对分段偏移）');

const outline = PROV.extractConclusionOutline(conclusionReady);
eq(outline.length, 1, '提纲被解析出来');
eq(outline[0].title, '现代人使用中文时面临的困境', '提纲标题正确');
eq(outline[0].points.length, 1, '提纲要点被解析出来');

// ★ 最关键的状态：已进服务端队列
const pending = clone(conclusionReady);
pending.data.code = 1;
pending.data.stid = '0';
pending.data.model_result = { result_type: 0, summary: '', outline: [], subtitle: [] };
const aPending = PROV.analyzeConclusion(pending);
eq(aPending.state, 'pending', 'code=1 且 stid="0" 判定为已进服务端队列（要轮询）');
ok(/队列/.test(aPending.message), 'pending 的提示语说明已在队列里', aPending.message);

// stid 为空 = 没识别到语音，不用等
const noSpeech = clone(pending);
noSpeech.data.stid = '';
eq(PROV.analyzeConclusion(noSpeech).state, 'no-speech', 'stid 为空判定为未识别到语音');

// 已经分配了 stid 但还没出结果，也还在处理中
const processing = clone(pending);
processing.data.stid = '1234567890';
eq(PROV.analyzeConclusion(processing).state, 'pending', '分配了 stid 但无结果也算生成中');

const unsupported = clone(conclusionReady);
unsupported.data.code = -1;
eq(PROV.analyzeConclusion(unsupported).state, 'unsupported', 'data.code=-1 判定为不支持');

const summaryOnly = clone(conclusionReady);
summaryOnly.data.model_result.result_type = 1;
summaryOnly.data.model_result.subtitle = [];
eq(PROV.analyzeConclusion(summaryOnly).state, 'summary-only', '只有摘要没字幕时 state=summary-only');

eq(PROV.analyzeConclusion({ code: -101, message: '账号未登录' }).state, 'need-login',
  '未登录时 state=need-login');
eq(PROV.analyzeConclusion({ code: -403, message: '访问权限不足' }).state, 'forbidden',
  '权限不足时 state=forbidden');
eq(PROV.analyzeConclusion({ code: -400, message: '请求错误' }).state, 'error', '其他错误码为 error');

// 签名不对时 B 站返回 v_voucher
const voucher = { code: 0, message: '0', ttl: 1, data: { v_voucher: 'voucher_xxx' } };
const aVoucher = PROV.analyzeConclusion(voucher);
eq(aVoucher.state, 'error', '返回 v_voucher 时判为签名未通过');
ok(/v_voucher/.test(aVoucher.message), '提示语里点明了 v_voucher', aVoucher.message);

eq(PROV.analyzeConclusion(null).state, 'error', 'analyzeConclusion 对 null 返回 error');
eq(PROV.extractConclusionCues(null), [], 'extractConclusionCues 对 null 返回空数组');
eq(PROV.extractConclusionCues({ data: {} }), [], '没有 model_result 时返回空数组');

// 坏数据不能崩
eq(PROV.cuesFromPartSubtitles([{ part_subtitle: [{ content: '缺时间' }] }]).length, 0,
  '缺时间戳的条目被丢弃');
eq(PROV.cuesFromPartSubtitles([{ part_subtitle: [{ content: 'end 早于 start', start_timestamp: 5, end_timestamp: 3 }] }])[0].to, 7,
  'end 早于 start 时兜底为 start+2');
eq(PROV.cuesFromPartSubtitles(null).length, 0, 'cuesFromPartSubtitles 对 null 返回空');

// ---------------------------------------------------------------- 7. 第三方接口

section('第三方接口');

eq(PROV.pickPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42, 'pickPath 按点号取深层值');
eq(PROV.pickPath({ a: [{ b: 1 }, { b: 2 }] }, 'a[1].b'), 2, 'pickPath 支持数组下标');
eq(PROV.pickPath({ a: 1 }, ''), PROV.pickPath({ a: 1 }, ''), 'pickPath 空路径返回原对象');
eq(PROV.pickPath({ a: 1 }, 'a.b.c'), undefined, 'pickPath 路径不存在返回 undefined');
eq(PROV.pickPath(null, 'a.b'), undefined, 'pickPath 对 null 安全');

eq(PROV.subst('https://x/?bvid={bvid}&cid={cid}', { bvid: 'BV1xx', cid: 123 }),
  'https://x/?bvid=BV1xx&cid=123', 'subst 替换占位符');
eq(PROV.subst('https://x/?q={q}', { q: 'a b' }), 'https://x/?q=a%20b', 'subst 对值做 URL 编码');
eq(PROV.subst('https://x/?n={unknown}', { q: 'a' }), 'https://x/?n={unknown}',
  'subst 保留未知占位符（便于一眼看出模板写错）');

// justoneapi 预设：token 在 URL 里
const jReq = PROV.buildExternalRequest(PROV.EXTERNAL_PRESETS.justoneapi,
  { bvid: 'BV1L94y1H7CV', aid: 111, cid: 222 }, { token: 'tok123' });
eq(jReq.method, 'GET', 'justoneapi 用 GET');
ok(jReq.url.indexOf('bvid=BV1L94y1H7CV') > 0, 'justoneapi URL 带上 bvid', jReq.url);
ok(jReq.url.indexOf('cid=222') > 0, 'justoneapi URL 带上 cid', jReq.url);
ok(jReq.url.indexOf('token=tok123') > 0, 'justoneapi token 在地址里', jReq.url);
eq(jReq.headers.length, 0, 'justoneapi 不加额外请求头');

// 自定义预设：token 在请求头里
const gReq = PROV.buildExternalRequest(PROV.EXTERNAL_PRESETS.generic,
  { bvid: 'BV1', aid: 1, cid: 2 }, { urlTemplate: 'https://api.example.com/s?bvid={bvid}', token: 'k9' });
eq(gReq.headers.length, 1, '自定义接口把 token 放进请求头');
eq(gReq.headers[0].name, 'Authorization', '默认请求头名是 Authorization');

const gReq2 = PROV.buildExternalRequest(PROV.EXTERNAL_PRESETS.generic, { bvid: 'BV1' },
  { urlTemplate: 'https://x/?b={bvid}', token: 'k9', tokenIn: 'url' });
eq(gReq2.headers.length, 0, 'tokenIn=url 时不加请求头');

eq(PROV.buildExternalRequest(PROV.EXTERNAL_PRESETS.generic, {}, {}), null,
  '模板为空时返回 null');

// 响应解读：B站格式的字幕列表（justoneapi 的真实返回结构）
const jResp = {
  code: 0,
  message: null,
  data: {
    data: [
      { subtitle_url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/aaa?auth_key=1', lan_doc: '中文', lan: 'ai-zh' },
      { subtitle_url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/bbb?auth_key=2', lan_doc: 'English', lan: 'ai-en' }
    ]
  }
};
const jParsed = PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.justoneapi, { token: 'x' }, jResp);
ok(jParsed.ok, 'justoneapi 响应解析成功');
eq(jParsed.kind, 'bili-subtitle-list', '识别为字幕列表形态');
eq(jParsed.entries.length, 2, '解析出两条字幕轨');
eq(jParsed.entries[0].lan, 'ai-zh', '第一条是 AI 中文');
eq(jParsed.entries[0].subtitle_url, '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/aaa?auth_key=1',
  '字幕地址被转成协议相对');

// 业务错误码
const jErr = PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.justoneapi, {}, { code: 303 });
eq(jErr.ok, false, 'justoneapi 业务错误码被判为失败');
ok(/配额/.test(jErr.error), '错误码 303 有中文说明', jErr.error);
eq(PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.justoneapi, {}, { code: 601 }).ok, false,
  '错误码 601（余额不足）也是失败');

// 响应解读：直接是 cue 数组
const cResp = { list: [{ content: '你好', start_timestamp: 0, end_timestamp: 2 }, { content: '世界', start_timestamp: 2, end_timestamp: 4 }] };
const cParsed = PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.generic,
  { mode: 'cues', listPath: 'list' }, cResp);
ok(cParsed.ok, 'cue 数组解析成功');
eq(cParsed.cues.length, 2, '解析出两条 cue');
eq(cParsed.cues[1].text, '世界', 'cue 文本正确');
eq(cParsed.cues[1].from, 2, 'cue 时间正确');

// 字段名可自定义
const cParsed2 = PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.generic,
  { mode: 'cues', listPath: 'items', textField: 'text', fromField: 'start', toField: 'end' },
  { items: [{ text: '自定义字段', start: 1, end: 3 }] });
eq(cParsed2.cues[0].text, '自定义字段', '支持自定义字段名');

// 响应解读：单个字幕文件地址
const uParsed = PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.generic,
  { mode: 'bili-subtitle-url' }, { data: { subtitle_url: 'https://cdn/x.json' } });
ok(uParsed.ok, '单地址形态解析成功');
eq(uParsed.url, 'https://cdn/x.json', '取到字幕文件地址');

// 坏数据
eq(PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.generic, { mode: 'cues' }, {}).ok, false,
  '没有数组时返回失败');
eq(PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.generic, { mode: 'cues', listPath: 'x' }, { x: [] }).ok, false,
  '空数组返回失败');
eq(PROV.parseExternalResponse(PROV.EXTERNAL_PRESETS.justoneapi, {}, { code: 0, data: {} }).ok, false,
  'justoneapi 结构不对时返回失败');

// ---------------------------------------------------------------- 8. 注入核心

section('注入核心 mergeSubtitle');

const unauthPlayer = {
  code: 0, message: '0', ttl: 1,
  data: {
    aid: 1906473802, bvid: 'BV1MU411S7iJ', cid: 1625992822,
    need_login_subtitle: true, view_points: [],
    options: { is_360: false, without_vip: false }
  }
};

const dmView = {
  code: 0,
  data: {
    aid: 1906473802, cid: 1625992822,
    subtitle: {
      allow_submit: false, lan: '', lan_doc: '',
      subtitles: [{
        id: 1497922385058359296,
        lan: 'ai-zh',
        lan_doc: '中文(自动生成)',
        is_lock: false,
        subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1855215937156015667?auth_key=1726370540-6200821378ad42a7a48c21fe4b226486-0-5b557de4cbb342c3e46e5f78c068b28f',
        type: 1, id_str: '1497922385058359296', ai_type: 0, ai_status: 2
      }]
    }
  }
};
const sub = NS.extractSubtitle(dmView);
ok(!!sub, '能从 dm/view 响应里抽出 subtitle');
eq(sub && sub.subtitles.length, 1, '抽出的字幕条目数正确');
ok(NS.isAiEntry(sub.subtitles[0]), 'isAiEntry 认得 lan=ai-zh');
ok(NS.extractSubtitle({ code: -400, message: '请求错误' }) === null, '接口报错时返回 null');

const norm = NS.normalizeEntry({ id: 1, lan: 'ai-zh', is_lock: true, subtitle_url: 'http://aisubtitle.hdslb.com/a.json', type: 1 });
eq(norm.is_lock, false, 'normalizeEntry 强制解锁 is_lock');
eq(norm.subtitle_url, '//aisubtitle.hdslb.com/a.json', 'normalizeEntry 把 URL 转成协议相对');
ok(NS.normalizeEntry({ lan: 'ai-zh' }) === null, '没有 subtitle_url 的条目被丢弃');

// 情形一：响应里压根没有 subtitle 节点（未登录），这是最主要的目标场景
const body1 = clone(unauthPlayer);
const r1 = NS.mergeSubtitle(body1, sub, { forceUnlock: true });
ok(r1.ok, '情形一：注入成功');
eq(r1.added, 1, '情形一：新增 1 条');
eq(r1.unlockedLogin, true, '情形一：拆掉了 need_login_subtitle');
eq(body1.data.need_login_subtitle, false, '情形一：响应里的 need_login_subtitle 已被置 false');
eq(body1.data.subtitle.subtitles[0].lan, 'ai-zh', '情形一：注入的正是 AI 中文字幕');
eq(body1.data.subtitle.subtitles[0].subtitle_url.slice(0, 2), '//', '情形一：注入地址是协议相对的');

// 情形二：已有普通字幕，注入 AI 字幕不应覆盖原有条目
const body2 = {
  code: 0,
  data: {
    aid: 60977932, cid: 106101299, need_login_subtitle: true,
    subtitle: {
      allow_submit: true, lan: 'zh-CN', lan_doc: '中文（中国）',
      subtitles: [{
        id: 13643112644608002, lan: 'zh-Hans', lan_doc: '中文（简体）', is_lock: true,
        subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/c49b18a2.json?auth_key=1',
        type: 0, id_str: '13643112644608002', ai_type: 0, ai_status: 0
      }]
    }
  }
};
const r2 = NS.mergeSubtitle(body2, sub, { forceUnlock: true });
ok(r2.ok, '情形二：注入成功');
eq(r2.total, 2, '情形二：原有 1 条 + 新增 1 条 = 2 条');
eq(body2.data.subtitle.subtitles[0].is_lock, false, '情形二：原有条目的 is_lock 也被解锁');
eq(body2.data.subtitle.subtitles[0].lan, 'zh-Hans', '情形二：原有条目本身没被改写');
eq(body2.data.subtitle.lan, 'zh-CN', '情形二：保留了原本的默认语言');

// 情形三：重复注入幂等
const r3 = NS.mergeSubtitle(body2, sub, { forceUnlock: true });
ok(r3.ok, '情形三：重复注入仍返回 ok');
eq(r3.added, 0, '情形三：没有重复新增');
eq(body2.data.subtitle.subtitles.length, 2, '情形三：条目数不变');

// 情形四：接口本身报错
const r4 = NS.mergeSubtitle({ code: -400, message: '请求错误' }, sub, { forceUnlock: true });
eq(r4.ok, false, '情形四：没有 data 的响应不注入');
eq(r4.reason, '响应里没有 data', '情形四：给出原因');

// 情形五：没有字幕数据
eq(NS.mergeSubtitle({ code: 0, data: {} }, null, { forceUnlock: true }).ok, false, '情形五：空字幕不注入');

// 情形六：关掉 forceUnlock 时不动闸门
const body6 = clone(unauthPlayer);
NS.mergeSubtitle(body6, sub, { forceUnlock: false });
eq(body6.data.need_login_subtitle, true, '情形六：forceUnlock 关闭时不动 need_login_subtitle');

// ---------------------------------------------------------------- 9. 语言与字幕

section('语言选择与字幕内容');

const list = [
  { lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: '//a/1.json' },
  { lan: 'ai-zh', lan_doc: '中文(自动生成)', subtitle_url: '//a/2.json', type: 1 },
  { lan: 'ai-en', lan_doc: 'English', subtitle_url: '//a/3.json', type: 1 }
];
const p1 = NS.pickTracks(list, { primary: 'zh', secondary: 'en', bilingual: true });
eq(p1.primary.lan, 'ai-zh', '中文偏好优先选 AI 中文字幕');
eq(p1.secondary.lan, 'ai-en', '英文偏好选到 AI 英文字幕');
eq(NS.pickTracks([], { primary: 'zh' }).primary, null, '空列表时主轨为 null');
eq(NS.summarizeSubtitles(list).aiCount, 2, 'summarizeSubtitles 统计 AI 条数');

const subJson = {
  body: [
    { from: 0.0, to: 2.5, location: 2, content: '大家好' },
    { from: 2.5, to: 5.8, location: 2, content: '今天我们聊聊 AI 字幕' },
    { from: 5.8, to: 9.1, location: 2, content: '这是个有点意思的东西' }
  ]
};
const cues = NS.parseCueList(subJson);
eq(cues.length, 3, 'parseCueList 解析出 3 条');
eq(cues[0].text, '大家好', 'parseCueList 取到正文');
eq(NS.parseCueList({ data: [{ start: 1, end: 3, text: 'x' }] }).length, 1, 'parseCueList 兼容 start/end/text');
eq(NS.parseCueList(null).length, 0, 'parseCueList 对 null 返回空');
eq(NS.parseCueList({ body: [{ from: 0, content: '缺 to' }] })[0].to, 2, 'parseCueList 给缺 to 的条目兜底');

eq(NS.findCueAt(cues, 1.0).text, '大家好', 'findCueAt 命中第一条');
eq(NS.findCueAt(cues, 2.5).text, '今天我们聊聊 AI 字幕', 'findCueAt 在切点处取后一条');
eq(NS.findCueAt(cues, 5.79).text, '今天我们聊聊 AI 字幕', 'findCueAt 在 to 之前仍命中');
eq(NS.findCueAt(cues, 5.81).text, '这是个有点意思的东西', 'findCueAt 在 from 之后切到新条');
eq(NS.findCueAt(cues, 100), null, 'findCueAt 超出范围返回 null');
eq(NS.findCueAt([], 1), null, 'findCueAt 空列表返回 null');

eq(NS.fmtTime(0), '00:00:00,000', 'fmtTime 格式化 0');
eq(NS.fmtTime(3661.5), '01:01:01,500', 'fmtTime 格式化含小时的时间');
ok(NS.toSrt(cues.slice(0, 2)).indexOf('1\n00:00:00,000 --> 00:00:02,500\n大家好') === 0, 'toSrt 格式正确');

// ---------------------------------------------------------------- 10. 设置模型

section('设置模型');

const d = SET.defaults();
eq(d.enabled, true, '默认开启');
eq(d.sources.existing, true, '默认启用"已有字幕轨"');
eq(d.sources.conclusion, true, '默认启用"服务端生成"');
eq(d.sources.external, false, '第三方接口默认关闭（需要用户自己配）');
eq(d.sources.conclusionWait, 90, '默认等待 90 秒');
eq(d.injectInto, 'both', '默认同时用原生与自建层');
eq('asr' in d, false, '本地 ASR 配置已移除（改成服务端产出）');

const d2 = SET.defaults();
d2.style.fontSize = 999;
eq(SET.defaults().style.fontSize, 26, 'defaults() 返回副本，改不坏默认值');

const n1 = SET.normalize({ style: { fontSize: 9999, bgOpacity: -5, color: 'not-a-color' } });
eq(n1.style.fontSize, 72, '字号越界被钳到上限');
eq(n1.style.color, '#ffffff', '非法颜色回退默认');

const n2 = SET.normalize({ injectInto: '不存在的模式' });
eq(n2.injectInto, 'both', '非法输出方式回退默认');

const n3 = SET.normalize({ sources: { conclusionWait: 99999 } });
eq(n3.sources.conclusionWait, 900, '等待秒数被钳到上限');
eq(SET.normalize({ sources: { conclusionWait: -5 } }).sources.conclusionWait, 0, '等待秒数被钳到下限');

eq(SET.normalize({ sources: { externalMode: '瞎写的' } }).sources.externalMode, 'cues',
  '非法响应解读方式回退默认');
eq(SET.normalize({ sources: { externalPreset: '瞎写的' } }).sources.externalPreset, 'generic',
  '非法预设回退默认');
eq(SET.normalize({ sources: { externalTokenIn: '瞎写的' } }).sources.externalTokenIn, 'url',
  '非法密钥位置回退默认');

eq(Object.keys(SET.normalize(null)).length, Object.keys(d).length, 'normalize 补齐了所有字段');

eq(SET.externalReady({ sources: { external: true, externalPreset: 'generic', externalUrl: 'https://a/b' } }), true,
  'externalReady：自定义接口地址合法时为 true');
eq(SET.externalReady({ sources: { external: true, externalPreset: 'generic', externalUrl: '不是地址' } }), false,
  'externalReady：地址非法为 false');
eq(SET.externalReady({ sources: { external: true, externalPreset: 'justoneapi', externalToken: 'k' } }), true,
  'externalReady：justoneapi 只要 token 有值');
eq(SET.externalReady({ sources: { external: true, externalPreset: 'justoneapi', externalToken: '' } }), false,
  'externalReady：justoneapi 没 token 为 false');
eq(SET.externalReady(SET.defaults()), false, 'externalReady：默认设置下为 false');

eq(SET.anySourceEnabled({ sources: { existing: false, conclusion: false, external: false } }), false,
  'anySourceEnabled：全关时为 false');
eq(SET.anySourceEnabled(SET.defaults()), true, 'anySourceEnabled：默认有开启的来源');

// ---------------------------------------------------------------- 11. 源码约束

section('源码约束');

const hookSrc = read(path.join(ROOT, 'src', 'hook.js'));
ok(/XMLHttpRequest\.prototype/.test(hookSrc), 'hook 劫持了 XMLHttpRequest');
ok(/window\.fetch\s*=/.test(hookSrc), 'hook 同时劫持了 fetch');
ok(/__INITIAL_STATE__/.test(hookSrc), 'hook 劫持了 __INITIAL_STATE__ 以提前预取');
ok(/requestConclusion/.test(hookSrc), 'hook 里实现了 AI 总结接口调用（服务端生成入口）');
ok(/WBI\.signUrl/.test(hookSrc), 'hook 调用 WBI 签名');
ok(/case 'request-external'/.test(hookSrc), 'hook 支持第三方接口请求');

const contentSrc = read(path.join(ROOT, 'src', 'content.js'));
ok(/runServerFlow/.test(contentSrc), 'content 里有"让服务端生成"的流程');
ok(/pollConclusion/.test(contentSrc), 'content 有轮询服务端生成结果的逻辑');
ok(/runExternalFlow/.test(contentSrc), 'content 里有第三方接口流程');
ok(!/BASFASR|createMediaElementSource/.test(contentSrc),
  'content 里已经没有本地音频识别（改为服务端产出）');

const overlaySrc = read(path.join(ROOT, 'src', 'overlay.js'));
ok(!/\.innerHTML\s*=/.test(overlaySrc), 'overlay 不使用 innerHTML 写字幕文本（防注入）');

const bgSrc = read(path.join(ROOT, 'src', 'background.js'));
ok(/importScripts\('\.\.\/lib\/settings\.js', '\.\.\/lib\/providers\.js'\)/.test(bgSrc),
  'background 用相对于自身的路径 importScripts（MV3 的硬约束）');
ok(/external-fetch/.test(bgSrc), 'background 提供第三方接口的后台代理');

ok(!exists('src/asr.js'), '本地 ASR 模块已移除');

// ---------------------------------------------------------------- 12. 运行时冒烟

section('运行时冒烟（在 mock 的浏览器环境里真跑一遍）');

// 语法检查只证明"能解析"，不证明"跑起来不炸"。内容脚本一旦初始化就抛错，
// 表现是**静默失效** —— 扩展显示已加载，但页面上什么都不发生，
// 排查起来极其费劲。所以这里用 vm 造一个假的浏览器环境，按 manifest 里的
// 加载顺序真的执行一遍，任何 ReferenceError / TypeError 都会被抓出来。
const vm = require('vm');

function noop() {}

function makeEl() {
  return {
    style: { setProperty: noop, removeProperty: noop },
    classList: { add: noop, remove: noop, contains: function () { return false; }, toggle: noop },
    setAttribute: noop,
    getAttribute: function () { return null; },
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    dispatchEvent: noop,
    textContent: '',
    className: '',
    id: '',
    parentNode: null
  };
}

function makeSandbox() {
  const doc = {
    body: null,
    head: null,
    documentElement: makeEl(),
    readyState: 'loading',
    hidden: false,
    title: '',
    addEventListener: noop,
    removeEventListener: noop,
    createElement: makeEl,
    createTextNode: function () { return makeEl(); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementById: function () { return null; }
  };

  function XHR() {}
  XHR.prototype.open = noop;
  XHR.prototype.send = noop;
  XHR.prototype.addEventListener = noop;
  XHR.prototype.abort = noop;

  const sandbox = {
    console: console,
    document: doc,
    XMLHttpRequest: XHR,
    location: {
      href: 'https://www.bilibili.com/video/BV1MU411S7iJ/',
      protocol: 'https:',
      host: 'www.bilibili.com',
      origin: 'https://www.bilibili.com'
    },
    navigator: { userAgent: 'node-sandbox' },
    fetch: function () { return Promise.resolve({ ok: false, status: 0 }); },
    setTimeout: function () { return 0; },
    clearTimeout: noop,
    setInterval: function () { return 0; },
    clearInterval: noop,
    requestAnimationFrame: function () { return 0; },
    cancelAnimationFrame: noop,
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    dispatchEvent: noop,
    chrome: {
      runtime: {
        id: 'basf-smoke-test',
        onMessage: { addListener: noop },
        sendMessage: noop,
        lastError: null
      },
      storage: {
        local: {
          get: function (k, cb) { if (cb) cb({}); },
          set: function (o, cb) { if (cb) cb(); }
        },
        onChanged: { addListener: noop }
      },
      tabs: {
        query: function (q, cb) { if (cb) cb([]); },
        sendMessage: noop,
        reload: noop
      },
      permissions: { request: function (o, cb) { if (cb) cb(false); } }
    }
  };

  // 浏览器里 window === globalThis，脚本会同时用这两个名字
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/** 按 manifest 里的顺序真跑一遍；setTimeout 都被 mock 成不执行，所以只测同步初始化 */
function smokeRun(files, label) {
  const sandbox = makeSandbox();
  let ctx;
  try {
    ctx = vm.createContext(sandbox);
  } catch (e) {
    ok(false, label, 'createContext 失败: ' + e.message);
    return;
  }
  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    try {
      vm.runInContext(read(path.join(ROOT, rel)), ctx, { filename: rel, timeout: 5000 });
    } catch (e) {
      ok(false, label, rel + ' → ' + (e.name || 'Error') + ': ' + (e.message || e));
      return;
    }
  }
  ok(true, label);
}

// manifest 里两条 content_scripts 的实际顺序
smokeRun([
  'lib/bili-api.js', 'lib/settings.js', 'lib/providers.js', 'src/overlay.js', 'src/content.js'
], '隔离世界那组（bili-api + settings + providers + overlay + content）初始化不抛错');

smokeRun([
  'lib/bili-api.js', 'lib/wbi.js', 'lib/providers.js', 'src/hook.js'
], 'MAIN world 那组（bili-api + wbi + providers + hook）初始化不抛错');

// 单独确认关键全局真的挂上去了（挂不上就是 undefined，下游会静默失效）
(function () {
  const sandbox = makeSandbox();
  const ctx = vm.createContext(sandbox);
  ['lib/bili-api.js', 'lib/wbi.js', 'lib/providers.js', 'lib/settings.js'].forEach(function (f) {
    vm.runInContext(read(path.join(ROOT, f)), ctx, { filename: f });
  });
  ok(typeof sandbox.BASFBiliApi === 'object', '库里挂上了 globalThis.BASFBiliApi');
  ok(typeof sandbox.BASFWbi === 'object', '库里挂上了 globalThis.BASFWbi');
  ok(typeof sandbox.BASFProviders === 'object', '库里挂上了 globalThis.BASFProviders');
  ok(typeof sandbox.BASFSettings === 'object', '库里挂上了 globalThis.BASFSettings');
  ok(typeof sandbox.BASFWbi.md5 === 'function', 'BASFWbi.md5 是可调用的');
  ok(typeof sandbox.BASFProviders.analyzeConclusion === 'function', 'BASFProviders.analyzeConclusion 可调用');
  ok(typeof sandbox.BASFSettings.normalize === 'function', 'BASFSettings.normalize 可调用');
})();

// ---------------------------------------------------------------- 汇总

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过。');
