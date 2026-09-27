/**
 * tools/selftest.js —— 离线自检（不需要浏览器、不联网）
 *
 * 能覆盖的：
 *   · manifest 合法性、声明的文件是否真的存在、matches 是否过宽
 *   · 全部 JS 的语法（用 new Function 只解析不执行 —— 本机沙箱禁止 Node 起子进程）
 *   · popup.html 里的 id 与 popup.js 引用的是否对得上
 *   · lib 纯逻辑：注入合并、语言选择、字幕解析、时间轴查找
 *
 * 覆盖不了的（README 里也写了"尚未验证"）：
 *   · 真实 B 站页面上的端到端行为、Chrome 对 manifest 的实际接受度
 *
 * 用法：node tools/selftest.js     失败时退出码为 1
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS = require(path.join(ROOT, 'lib', 'bili-api.js'));
const SET = require(path.join(ROOT, 'lib', 'settings.js'));

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

  // 绝对不能默认索取全站权限
  const hosts = manifest.host_permissions || [];
  const hostsOverBroad = hosts.filter((h) => h === '<all_urls>' || /^\*:\/\//.test(h) || h === 'https://*/*' || h === 'http://*/*');
  eq(hostsOverBroad, [], 'host_permissions 里没有默认全站权限（自定义接口走 optional）');

  const perms = manifest.permissions || [];
  eq(perms, ['storage'], 'permissions 只申请 storage');

  // optional 与 host 重叠会让 Chrome 报错
  const opt = manifest.optional_host_permissions || [];
  const overlap = opt.filter((o) => hosts.indexOf(o) >= 0);
  eq(overlap, [], 'optional_host_permissions 与 host_permissions 不重复');

  // 图标与脚本文件真实存在
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

  // content_scripts
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
    ok((mainWorldEntry.js || []).some((f) => /hook\.js$/.test(f)),
      'MAIN world 里装了 hook.js');
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

ok(jsFiles.length >= 8, '找到待检查的 JS 文件', String(jsFiles.length));

const syntaxErrors = [];
jsFiles.forEach((p) => {
  const src = read(p);
  try {
    // 只解析不执行：足以抓出 SyntaxError，又不会触发副作用、不起子进程
    // eslint-disable-next-line no-new-func
    new Function(src);
  } catch (e) {
    syntaxErrors.push(path.relative(ROOT, p) + ': ' + e.message);
  }
});
eq(syntaxErrors, [], '全部 JS 语法通过');

// 本机已知坑：const 声明没初始值是硬语法错误，会让整个内容脚本加载失败
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

const htmlPath = path.join(ROOT, 'src', 'popup.html');
const html = read(htmlPath);
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

// popup.html 里引用的本地资源
const assetRe = /(?:src|href)="([^"#]+)"/g;
const assets = [];
while ((m = assetRe.exec(html))) {
  const v = m[1];
  if (/^https?:/.test(v) || v.startsWith('data:')) continue;
  assets.push(v);
}
const missingAssets = assets.filter((a) => !exists(path.join('src', a)));
eq(missingAssets, [], 'popup.html 引用的本地资源都存在');

// ---------------------------------------------------------------- 4. lib 地址解析

section('地址解析');

eq(NS.parseBvid('https://www.bilibili.com/video/BV1MU411S7iJ/?p=2'), 'BV1MU411S7iJ', 'parseBvid 从 URL 取 BV 号');
eq(NS.parseBvid('没有 BV 号的字符串'), '', 'parseBvid 取不到时返回空串');
eq(NS.parseAvid('https://www.bilibili.com/video/av1906473802'), 1906473802, 'parseAvid 取 av 号');
eq(NS.parsePageParam('https://www.bilibili.com/video/BV1x?p=7'), 7, 'parsePageParam 取分P');
eq(NS.parsePageParam('https://www.bilibili.com/video/BV1x'), 1, 'parsePageParam 缺省为 1');

eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/player/v2?aid=1&cid=2'), true,
  'isPlayerInfoUrl 认得 x/player/v2');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/player/wbi/v2?aid=1&cid=2'), true,
  'isPlayerInfoUrl 认得 x/player/wbi/v2');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/player/pagelist?aid=1'), false,
  'isPlayerInfoUrl 不误伤 pagelist');
eq(NS.isPlayerInfoUrl('https://api.bilibili.com/x/v2/dm/view?aid=1&oid=2&type=1'), false,
  'isPlayerInfoUrl 不误伤 dm/view');

const initState = {
  aid: 0,
  p: 2,
  videoData: {
    aid: 1906473802,
    bvid: 'BV1MU411S7iJ',
    cid: 111,
    pages: [
      { cid: 111, page: 1, part: 'P1' },
      { cid: 222, page: 2, part: 'P2' }
    ]
  }
};
eq(NS.idsFromInitialState(initState), { aid: 1906473802, cid: 222, bvid: 'BV1MU411S7iJ', page: 2, part: 'P2' },
  'idsFromInitialState 按当前分P 取 cid');

eq(NS.idsFromInitialState({ epInfo: { aid: 5, cid: 6, bvid: 'BV1xx411c7mD' } }),
  { aid: 5, cid: 6, bvid: 'BV1xx411c7mD', page: 1, part: '' },
  'idsFromInitialState 支持番剧 epInfo');

eq(NS.idsFromInitialState(null).cid, 0, 'idsFromInitialState 对空输入不崩');

// ---------------------------------------------------------------- 5. 字幕提取

section('字幕提取');

// 未登录的 x/player/v2：subtitle 整个缺失，这正是"没有 AI 字幕开关"的成因
const unauthPlayer = {
  code: 0,
  message: '0',
  ttl: 1,
  data: {
    aid: 1906473802,
    bvid: 'BV1MU411S7iJ',
    cid: 1625992822,
    need_login_subtitle: true,
    view_points: [],
    options: { is_360: false, without_vip: false }
  }
};
eq(NS.extractSubtitle(unauthPlayer), null, '未登录响应里抽不到字幕（符合预期）');

// 免登录通道 dm/view 的返回：带 AI 字幕
const dmView = {
  code: 0,
  data: {
    aid: 1906473802,
    cid: 1625992822,
    subtitle: {
      allow_submit: false,
      lan: '',
      lan_doc: '',
      subtitles: [{
        id: 1497922385058359296,
        lan: 'ai-zh',
        lan_doc: '中文(自动生成)',
        is_lock: false,
        subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/18552159371560156670a544e45bb1c1fcbc749444766bcfdce1?auth_key=1726370540-6200821378ad42a7a48c21fe4b226486-0-5b557de4cbb342c3e46e5f78c068b28f',
        type: 1,
        id_str: '1497922385058359296',
        ai_type: 0,
        ai_status: 2
      }]
    }
  }
};
const sub = NS.extractSubtitle(dmView);
ok(!!sub, '能从 dm/view 响应里抽出 subtitle');
eq(sub && sub.subtitles.length, 1, '抽出的字幕条目数正确');
ok(NS.isAiEntry(sub.subtitles[0]), 'isAiEntry 认得 lan=ai-zh');
eq(NS.isAiEntry({ lan: 'zh-Hans', lan_doc: '中文（简体）' }), false, 'isAiEntry 不误判普通字幕');

ok(NS.extractSubtitle({ code: -400, message: '请求错误' }) === null, '接口报错时返回 null');
ok(NS.extractSubtitle({ code: 0, data: { data: { subtitle: { subtitles: [{ lan: 'ai-en', subtitle_url: '//x/y.json' }] } } } }) !== null,
  '兼容 data.data.subtitle 这种多嵌一层的结构');

const norm = NS.normalizeEntry({
  id: 1,
  lan: 'ai-zh',
  is_lock: true,
  subtitle_url: 'http://aisubtitle.hdslb.com/a.json',
  type: 1
});
eq(norm.is_lock, false, 'normalizeEntry 强制解锁 is_lock');
eq(norm.subtitle_url, '//aisubtitle.hdslb.com/a.json', 'normalizeEntry 把 URL 转成协议相对');
eq(norm.lan_doc, '中文（AI 自动生成）', 'normalizeEntry 缺 lan_doc 时补一个中文名');
ok(NS.normalizeEntry({ lan: 'ai-zh' }) === null, '没有 subtitle_url 的条目被丢弃');
ok(NS.normalizeEntry(null) === null, 'normalizeEntry 对 null 返回 null');

// ---------------------------------------------------------------- 6. 注入核心

section('注入核心 mergeSubtitle');

// 情形一：响应里压根没有 subtitle 节点（未登录），这是最主要的目标场景
const body1 = JSON.parse(JSON.stringify(unauthPlayer));
const r1 = NS.mergeSubtitle(body1, sub, { forceUnlock: true });
ok(r1.ok, '情形一：注入成功');
eq(r1.added, 1, '情形一：新增 1 条');
eq(r1.unlockedLogin, true, '情形一：拆掉了 need_login_subtitle');
eq(body1.data.need_login_subtitle, false, '情形一：响应里的 need_login_subtitle 已被置 false');
eq(body1.data.subtitle.subtitles.length, 1, '情形一：响应里出现了 subtitles');
eq(body1.data.subtitle.subtitles[0].lan, 'ai-zh', '情形一：注入的正是 AI 中文字幕');
eq(body1.data.subtitle.subtitles[0].subtitle_url.slice(0, 2), '//', '情形一：注入地址是协议相对的');
ok(body1.data.subtitle.allow_submit === true, '情形一：allow_submit 被补成 true');

// 情形二：已有普通字幕，注入 AI 字幕不应覆盖原有条目
const body2 = {
  code: 0,
  data: {
    aid: 60977932,
    cid: 106101299,
    need_login_subtitle: true,
    subtitle: {
      allow_submit: true,
      lan: 'zh-CN',
      lan_doc: '中文（中国）',
      subtitles: [{
        id: 13643112644608002,
        lan: 'zh-Hans',
        lan_doc: '中文（简体）',
        is_lock: true,
        subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/c49b18a284739d99df1e3723cdf72c0c82db98e0.json?auth_key=1',
        type: 0,
        id_str: '13643112644608002',
        ai_type: 0,
        ai_status: 0
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
eq(body2.data.subtitle.allow_submit, true, '情形二：保留了原本的 allow_submit');

// 情形三：重复注入（同一条请求被处理两次）不应产生副本
const r3 = NS.mergeSubtitle(body2, sub, { forceUnlock: true });
ok(r3.ok, '情形三：重复注入仍返回 ok（幂等）');
eq(r3.added, 0, '情形三：没有重复新增');
eq(body2.data.subtitle.subtitles.length, 2, '情形三：条目数不变');

// 情形四：接口本身报错，不该硬塞数据进去
const badBody = { code: -400, message: '请求错误' };
const r4 = NS.mergeSubtitle(badBody, sub, { forceUnlock: true });
eq(r4.ok, false, '情形四：没有 data 的响应不注入');
eq(r4.reason, '响应里没有 data', '情形四：给出原因');

// 情形五：没有任何字幕数据可注入
const r5 = NS.mergeSubtitle({ code: 0, data: {} }, null, { forceUnlock: true });
eq(r5.ok, false, '情形五：空字幕不注入');
eq(r5.reason, '没有可注入的字幕数据', '情形五：给出原因');

// 情形六：关掉 forceUnlock 时不应改动闸门
const body6 = JSON.parse(JSON.stringify(unauthPlayer));
NS.mergeSubtitle(body6, sub, { forceUnlock: false });
eq(body6.data.need_login_subtitle, true, '情形六：forceUnlock 关闭时不动 need_login_subtitle');

// ---------------------------------------------------------------- 7. 语言选择

section('语言选择');

const list = [
  { lan: 'zh-Hans', lan_doc: '中文（简体）', subtitle_url: '//a/1.json' },
  { lan: 'ai-zh', lan_doc: '中文(自动生成)', subtitle_url: '//a/2.json', type: 1 },
  { lan: 'ai-en', lan_doc: 'English', subtitle_url: '//a/3.json', type: 1 }
];
const p1 = NS.pickTracks(list, { primary: 'zh', secondary: 'en', bilingual: true });
eq(p1.primary.lan, 'ai-zh', '中文偏好优先选 AI 中文字幕');
eq(p1.secondary.lan, 'ai-en', '英文偏好选到 AI 英文字幕');
eq(p1.list.length, 3, '候选列表完整');

const p2 = NS.pickTracks(list, { primary: 'en', bilingual: false });
eq(p2.primary.lan, 'ai-en', '英文偏好能选到 ai-en');
eq(p2.secondary, null, '不开双语时没有副轨');

const p3 = NS.pickTracks([{ lan: 'zh-Hant', subtitle_url: '//a/4.json' }], { primary: 'zh', bilingual: true });
eq(p3.primary.lan, 'zh-Hant', '没有 AI 中文字幕时退回到普通中文字幕');
eq(p3.secondary, null, '只有一条轨时副轨为 null');

const p4 = NS.pickTracks([], { primary: 'zh' });
eq(p4.primary, null, '空列表时主轨为 null');
eq(p4.secondary, null, '空列表时副轨为 null');

const sum = NS.summarizeSubtitles(list);
eq(sum.total, 3, 'summarizeSubtitles 统计总数');
eq(sum.aiCount, 2, 'summarizeSubtitles 统计 AI 条数');

// ---------------------------------------------------------------- 8. 字幕内容

section('字幕内容解析');

const subJson = {
  font_size: 0.4,
  font_color: '#FFFFFF',
  background_alpha: 0.5,
  Stroke: 'none',
  body: [
    { from: 0.0, to: 2.5, location: 2, content: '大家好' },
    { from: 2.5, to: 5.8, location: 2, content: '今天我们聊聊 AI 字幕' },
    { from: 5.8, to: 9.1, location: 2, content: '这是个有点意思的东西' }
  ]
};
const cues = NS.parseCueList(subJson);
eq(cues.length, 3, 'parseCueList 解析出 3 条');
eq(cues[0].text, '大家好', 'parseCueList 取到正文');
eq(cues[2].from, 5.8, 'parseCueList 取到时间戳');

eq(NS.parseCueList({ data: [{ start: 1, end: 3, text: 'x' }] }).length, 1,
  'parseCueList 兼容 start/end/text 命名');
eq(NS.parseCueList([]).length, 0, 'parseCueList 对空数组返回空');
eq(NS.parseCueList(null).length, 0, 'parseCueList 对 null 返回空');
eq(NS.parseCueList({ body: [{ content: '没有时间戳' }] }).length, 0,
  'parseCueList 丢弃没有时间戳的条目');
eq(NS.parseCueList({ body: [{ from: 0, content: '缺 to' }] })[0].to, 2,
  'parseCueList 给缺 to 的条目兜底 2 秒');

eq(NS.findCueAt(cues, 1.0).text, '大家好', 'findCueAt 命中第一条');
eq(NS.findCueAt(cues, 3.0).text, '今天我们聊聊 AI 字幕', 'findCueAt 命中第二条');
eq(NS.findCueAt(cues, 100), null, 'findCueAt 超出范围返回 null');
eq(NS.findCueAt(cues, -1), null, 'findCueAt 负数时间返回 null');
eq(NS.findCueAt([], 1), null, 'findCueAt 空列表返回 null');
// 边界：正好落在 to 上，应该已经不属于这一条
eq(NS.findCueAt(cues, 2.5).text, '今天我们聊聊 AI 字幕', 'findCueAt 在切点处取后一条');
// 相邻时间点反复查询（模拟播放抖动）
eq(NS.findCueAt(cues, 5.79).text, '今天我们聊聊 AI 字幕', 'findCueAt 在 to 之前仍命中');
eq(NS.findCueAt(cues, 5.81).text, '这是个有点意思的东西', 'findCueAt 在 from 之后切到新条');

eq(NS.fmtTime(0), '00:00:00,000', 'fmtTime 格式化 0');
eq(NS.fmtTime(3661.5), '01:01:01,500', 'fmtTime 格式化含小时的时间');
eq(NS.fmtTime(2.5, '.'), '00:00:02.500', 'fmtTime 支持自定义分隔符');

const srt = NS.toSrt(cues.slice(0, 2));
ok(srt.indexOf('1\n00:00:00,000 --> 00:00:02,500\n大家好') === 0, 'toSrt 序号与时间轴格式正确');
ok(srt.indexOf('\n\n2\n') > 0, 'toSrt 每条之间空行分隔');

eq(NS.toPlainText(cues.slice(0, 2)), '大家好今天我们聊聊 AI 字幕', 'toPlainText 拼接正文');

// 双语合并
const bi = NS.mergeBilingual(cues, [
  { from: 0.0, to: 2.4, text: 'Hello' },
  { from: 2.6, to: 5.7, text: 'Today we talk about AI captions' }
]);
eq(bi.length, 3, 'mergeBilingual 以主轨条数为准');
eq(bi[0].sub, 'Hello', 'mergeBilingual 给第一条配上副语言');
eq(bi[1].sub, 'Today we talk about AI captions', 'mergeBilingual 给第二条配上副语言');
eq(bi[2].sub, '', 'mergeBilingual 副轨没覆盖到时留空');
eq(NS.mergeBilingual([], cues).length, 0, 'mergeBilingual 主轨为空返回空');

// ---------------------------------------------------------------- 9. 设置模型

section('设置模型');

const d = SET.defaults();
eq(d.enabled, true, '默认开启');
eq(d.forceInject, true, '默认强制注入');
eq(d.injectInto, 'both', '默认同时用原生与自建层');
eq(d.primaryLang, 'zh', '默认主语言中文');
eq(d.style.bgOpacity, 0.45, '默认底衬不透明度');
eq(d.asr.enabled, false, 'ASR 默认关闭');

// defaults() 必须每次返回新对象，否则调用方会改到共享默认值
const d2 = SET.defaults();
d2.style.fontSize = 999;
eq(SET.defaults().style.fontSize, 26, 'defaults() 返回的是副本，改不坏默认值');

// 越界与垃圾输入要被钳制或丢弃
const n1 = SET.normalize({ style: { fontSize: 9999, bgOpacity: -5, color: 'not-a-color' } });
eq(n1.style.fontSize, 72, '字号越界被钳到上限');
eq(n1.style.bgOpacity, 0, '不透明度越界被钳到下限');
eq(n1.style.color, '#ffffff', '非法颜色回退到默认值');

const n2 = SET.normalize({ injectInto: '不存在的模式' });
eq(n2.injectInto, 'both', '非法渲染方式回退到默认值');

const n3 = SET.normalize({ enabled: 'false', bilingual: 'true' });
eq(n3.enabled, false, '字符串 "false" 被识别为 false');
eq(n3.bilingual, true, '字符串 "true" 被识别为 true');

const n4 = SET.normalize(null);
eq(n4.injectInto, 'both', 'normalize(null) 返回完整默认设置');
eq(Object.keys(n4).length, Object.keys(d).length, 'normalize 补齐了所有字段');

const n5 = SET.normalize({ asr: { chunkSeconds: 9999 } });
eq(n5.asr.chunkSeconds, 60, '分片长度越界被钳到上限');
eq(n5.asr.model, 'whisper-1', 'ASR 模型有默认值');

eq(SET.asrReady({ asr: { enabled: true, endpoint: 'https://a/b' } }), true, 'asrReady：配置完整时为 true');
eq(SET.asrReady({ asr: { enabled: true, endpoint: '不是地址' } }), false, 'asrReady：地址非法为 false');
eq(SET.asrReady({ asr: { enabled: false, endpoint: 'https://a/b' } }), false, 'asrReady：未启用为 false');
eq(SET.asrReady(SET.defaults()), false, 'asrReady：默认设置下为 false');

// ---------------------------------------------------------------- 10. 源码里的关键约束

section('源码约束');

const hookSrc = read(path.join(ROOT, 'src', 'hook.js'));
ok(/XMLHttpRequest\.prototype/.test(hookSrc), 'hook 劫持了 XMLHttpRequest');
ok(/window\.fetch\s*=/.test(hookSrc), 'hook 同时劫持了 fetch');
ok(/__INITIAL_STATE__/.test(hookSrc), 'hook 劫持了 __INITIAL_STATE__ 以提前预取');
ok(/isPlayerInfoUrl/.test(hookSrc), 'hook 用 isPlayerInfoUrl 精确判定要改哪条响应');

const contentSrc = read(path.join(ROOT, 'src', 'content.js'));
ok(/readystatechange|data-lan/.test(contentSrc), 'content 会去点播放器的字幕语言项');
ok(!/\.innerHTML\s*=/.test(read(path.join(ROOT, 'src', 'overlay.js'))),
  'overlay 不使用 innerHTML 写字幕文本（内容来自网络，必须防注入）');

const bgSrc = read(path.join(ROOT, 'src', 'background.js'));
ok(/importScripts\('\.\.\/lib\/settings\.js'\)/.test(bgSrc),
  'background 用相对于自身的路径 importScripts（MV3 的硬约束）');

// ---------------------------------------------------------------- 汇总

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过。');
