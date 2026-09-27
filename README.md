# B站 AI 字幕

> 让 B 站网页视频**真的出现 AI 字幕** —— 字幕由**服务端**产出，不是本地算出来的。

一个 Chrome / Edge 扩展（Manifest V3）。三条来源，按顺序试，谁先出结果就用谁：

| | 来源 | 字幕怎么来的 | 输出方式 |
|---|---|---|---|
| ① | **已有字幕轨** | B 站自己已经生成好、但前端没给你看的 | 注入播放器，走 **B 站原生字幕**（全屏/画中画/倍速都正常） |
| ② | **B 站服务端生成** | ★ 请求 B 站的 AI 视频总结接口，**让服务端为这个视频做 AI 识别**；没做过的会被排进处理队列，扩展轮询等它出结果 | 自建字幕层 |
| ③ | **第三方接口** | 把视频信息发给你自己配的服务，拿回字幕 | 自建字幕层（或注入播放器，看返回形态） |

---

## 1. 原理（决定了它什么时候有效、什么时候无效）

### ① 已有字幕轨：为什么"开关看不到"

B 站网页播放器的字幕语言列表，**完全由一条接口的响应决定**：

```
GET https://api.bilibili.com/x/player/v2?aid=<avid>&cid=<cid>
GET https://api.bilibili.com/x/player/wbi/v2?aid=<avid>&cid=<cid>
```

播放器只认响应里 `data.subtitle.subtitles[]` 这个数组，据此渲染出
`.bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]`。
**数组空了，字幕按钮就不出现** —— 而它在未登录时必定为空（`need_login_subtitle: true`）。

与此同时存在一条**不需要登录**的字幕通道：

```
GET https://api.bilibili.com/x/v2/dm/view?aid=<avid>&oid=<cid>&type=1
```

它返回的结构里同样有 `data.subtitle`，AI 字幕就在里面：

```json
{ "lan": "ai-zh", "lan_doc": "中文(自动生成)", "type": 1, "is_lock": false,
  "subtitle_url": "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/....?auth_key=..." }
```

所以扩展在 `document_start` 阶段预取这条通道，然后劫持页面的
`XMLHttpRequest` / `fetch`，等播放器请求 `x/player/v2` 时把字幕**合并进响应体**，
并拆掉两道闸门（顶层 `need_login_subtitle` 置 `false`、条目 `is_lock` 置 `false`）。
播放器收到被改过的 JSON，自己就渲染出「中文（自动生成）」，扩展再替你点开。

**注入的是播放器自己的数据源，所以字幕是 B 站自己渲染和播放的** —— 这正是它能用原生字幕的原因。

### ② B 站服务端生成：让服务端去干活

对**从没生成过 AI 字幕**的视频，上面那条路是空的（没数据可注入）。这时走 B 站自己的
AI 视频总结接口：

```
GET https://api.bilibili.com/x/web-interface/view/conclusion/get
    ?bvid=<bvid>&cid=<cid>&up_mid=<mid>&wts=<ts>&w_rid=<WBI 签名>
```

认证要 Cookie（SESSDATA）+ **WBI 签名**，所以扩展自带了一套 WBI 签名实现
（`lib/wbi.js`，含纯 JS 的 MD5，零依赖）。

关键在于**这条接口本身就是生成入口**：

| 返回 | 含义 | 扩展怎么办 |
|---|---|---|
| `data.code=0, result_type=2` | 服务端已生成，字幕在 `model_result.subtitle[0].part_subtitle[]` | 直接拿来显示 |
| `data.code=1, stid="0"` | ★ **已加入服务端 AI 处理队列** | **轮询等它**，前 6 次每 5 秒、之后每 12 秒 |
| `data.code=1, stid=""` | 没在这个视频里识别到语音 | 放弃这条线 |
| `data.code=-1` | 该视频不支持（敏感内容等） | 放弃这条线 |
| `code=-101` | 没登录 | 提示先登录 B 站 |

字幕结构是 `{content, start_timestamp, end_timestamp}`（秒），**没有字幕文件地址** ——
所以这类字幕只能由扩展的自建字幕层渲染，放不进播放器原生轨道。这是接口形态决定的，不是偷懒。

> 服务端处理需要时间，短视频通常几十秒内出结果。**超时也不丢**：刷新一次页面，
> 服务端处理完就能直接拿到（结果会缓存在服务端）。

### ③ 第三方接口：接你自己的服务

把 `{bvid} {aid} {cid} {token} {upMid}` 填进你配的 URL 模板，请求后按你指定的方式解读响应。
支持三种形态：

- `cues` —— 响应里直接是带时间轴的数组（字段名可配）
- `bili-subtitle-list` —— 响应里是 B 站格式的字幕条目（含 `subtitle_url`），拿到后再下载字幕文件
- `bili-subtitle-url` —— 响应里就一个字幕文件地址

内置了 **JustOneAPI** 的预设（`https://api.justoneapi.com/api/bilibili/get-video-caption/v2`，
地址里带 token 即可用），其余服务自己填模板。

请求优先在页面上下文发出；被 CORS 拦了就自动改用扩展后台重试
（后台不受 CORS 限制，但需要你在面板里点一下「授权该接口域名」）。

---

## 2. 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选中本目录（含 `manifest.json` 那一层）
4. 打开任意 B 站视频页，右下角会出现提示条告诉你进展

> 需要 **Chrome 111+**（`content_scripts` 的 `world: "MAIN"` 从这一版起支持）。

> **⚠️ 装好后必须刷新一次已经打开的 B 站页面**（F5），否则插件不会生效。
> 内容脚本要在页面加载的最开始就注入，装在已经打开的页面上是赶不上的 ——
> 这是 Chromium 扩展的固有行为，不是 bug。装完新开的页面不受影响。
>
> 忘了刷新也没事：点扩展图标面板会直接告诉你「扩展还没在这个页面上生效」，
> 并给一个**「刷新本页」**按钮，点一下就修好了。

也可以用打包好的 zip：`node tools/make-zip.js` → `dist-extension-v<版本>/BASFCaptions-v<版本>.zip`，
解压后再按上面加载（Chrome / Edge 都不接受直接拖 zip 进去装）。

---

## 3. 用起来是什么样

- 视频有现成字幕 → 几秒内弹出「已发现 中文（自动生成）」，播放器字幕栏自动选中
- 视频没有现成字幕 → 弹出「正在让 B 站服务端生成字幕…」，随后是
  「服务端生成中…（第 N 次查询，最多再等 M 秒）」，出结果后自动显示
- 一直没出 → 提示条会告诉你原因（没登录 / 不支持 / 没识别到语音 / 还在生成）

**点一下右下角那个提示条** = 手动催一次（没字幕时重新问服务端，有字幕时把它打开）。

打开扩展图标可以看到三条线各自的实时状态、服务端任务号、已拿到多少条字幕。

---

## 4. 设置项

| 分组 | 说明 |
|---|---|
| **字幕从哪里来** | 三条来源各自独立开关；服务端生成可设「最多等多少秒」（0 = 不限时） |
| **第三方接口配置** | 预设 / URL 模板 / token / 密钥位置 / 响应解读方式 / 字段映射 / 域名授权 |
| **输出与样式** | 是否强制注入已有字幕轨、是否自动打开；输出方式（只用原生 / 原生+自建 / 只用自建）；双语对照；字号、颜色、描边、底衬、位置、最大宽度 |

**为什么要两套输出？** B 站原生字幕渲染在播放器内部的 shadow DOM 里，样式改不动，
一次也只能显示一条轨 —— 所以**双语对照和样式自定义只能靠自建字幕层**；
而服务端生成的字幕没有文件地址，也只能走自建层。
反过来，已有字幕轨走原生是最稳的。两条都留着，你按视频情况选。

---

## 5. 已知限制与尚未验证的部分

**已经离线验证过的**（`node tools/selftest.js`，**208 项全通过**）：

- manifest 合法性：MV3 必填项、引用的文件是否都存在、`matches` 没有写成全站、
  `optional_host_permissions` 与 `host_permissions` 不重复、MAIN world 里装齐了依赖、
  没有申请全量 `tabs` 权限
- 全部 JS 的语法（用 `new Function` 解析，不起子进程）
- **运行时冒烟**：用 `vm` 造一个假的浏览器环境（document / chrome / XMLHttpRequest 全 mock），
  按 manifest 里的加载顺序**真的执行一遍**两个内容脚本。语法没问题不等于跑起来不炸 ——
  内容脚本初始化时抛错的表现是**静默失效**（扩展显示已加载、页面上什么都没发生），
  排查极费劲，所以这一步专门守它
- `popup.html` 的 `id` 与 `popup.js` 引用的是否对得上、本地资源是否存在
- **MD5 与 WBI 签名**：对照 RFC 1321 向量（含多块输入）与**官方文档给的 `w_rid` 权威值**逐位一致；
  中文/emoji 的 UTF-8 编码、空格编成 `%20`、`!'()*` 过滤都单测过
- **AI 总结接口**：八种状态判定（`ready` / `pending` / `no-speech` / `summary-only` /
  `unsupported` / `need-login` / `forbidden` / `v_voucher`）与字幕提取，
  用的是官方文档里的**真实响应样例**
- **第三方接口**：模板替换、三种响应解读、justoneapi 的业务错误码、坏数据不崩
- 注入核心 `mergeSubtitle` 的六种情形（新建 / 不覆盖只追加 / 幂等 / 报错不注入 / 空数据 / 关闸门）
- 语言选择、字幕 JSON 解析、时间轴二分查找（含切点边界）、设置越界钳制

**另有一步真机校验**：把扩展交给**浏览器本体**打包
（`msedge.exe --pack-extension=<目录>`），浏览器会完整校验 manifest 与它引用的每个文件。
能在 Edge 153 / 154 上打包成功，就等于确认了"点加载不会因为清单不合法而失败"。

**尚未验证的（请知悉）**：

- **没有在真实 B 站页面上做过端到端手测。** 所有验证都是离线的。
- **AI 总结接口对哪些视频开放、账号需要什么等级，没有实测过。** 它是 B 站「AI 视频总结」
  功能的底层接口，可能对部分账号/视频不开放（遇到会返回 `-1` 或 `403`，扩展会如实告诉你）。
- **Chrome 对这份 manifest 的实际接受度没有实机验证**，尤其 `optional_host_permissions`
  与 `content_scripts.world`。
- B 站接口随时可能变。失效时主要改这几处：`lib/bili-api.js` 的 `SUBTITLE_ENDPOINTS`、
  `lib/providers.js` 的 `CONCLUSION_URL` 与状态判定、`src/content.js` 顶部的 `SEL` 选择器。

---

## 6. 隐私与边界

- 所有请求直连 B 站自己的域名。只有你自己配置并启用第三方接口时，视频标识才会发往**你填的地址**。
- **不绕过付费内容**：只处理"字幕被前端隐藏"和"服务端生成"这两类事，
  不涉及充电专属视频、大会员画质、付费课程。
- 第三方接口的 token 存在 `chrome.storage.local`（本机），不使用 `sync`，不会同步到云端。
- 扩展只申请 `storage` 一项权限；对 B 站域名之外的可选权限要你手动点授权才会生效。

---

## 7. 常见问题

**要登录 B 站吗？**
「已有字幕轨」在未登录时也能工作（走的是免登录通道）。但**「服务端生成」必须登录** ——
那条接口强制要求 SESSDATA。没登录时扩展会明确提示。

**服务端一直在"生成中"，多久能好？**
短视频通常几十秒。接口返回的 `stid` 就是服务端任务号，面板里能看到。超时不会丢结果，
刷新页面即可。

**注入成功了但没自动点开字幕？**
点一下右下角提示条手动触发。仍不行说明播放器语言列表的结构变了，
需要更新 `src/content.js` 里的 `SEL` 选择器。

**装了没反应？**
先看扩展面板的状态：

| 面板显示 | 什么意思 | 怎么办 |
|---|---|---|
| 「扩展还没在这个页面上生效」 | 这是 B 站视频页，但页面比扩展先打开 | 点面板里的**「刷新本页」** |
| 「当前标签页不是 B 站视频页」 | 确实不是视频页 | 打开一个视频页再回来看 |
| 「当前是 B 站页面，但不是视频页」 | 是 B 站，但不是视频页 | 本扩展只匹配 `/video/`、`/bangumi/play/`、`/list/`、`/medialist/play/`、`/watchlater/`、`/cheese/play/` |

面板底部会显示它看到的当前页面地址，方便你确认插件看的是不是同一个页面。

**更新了扩展代码之后也要刷新页面** —— 在 `chrome://extensions` / `edge://extensions`
点该扩展卡片上的「重新加载」，然后刷新 B 站页面。

---

## 8. 开发

```bash
node tools/selftest.js      # 离线自检，208 项；失败退出码 1
node tools/make-zip.js      # 打包，产物在 dist-extension-v<版本>/
node tools/make-zip.js --out <目录>   # 指定输出目录
python tools/make-icons.py  # 重新生成图标（纯标准库，不需要 Pillow）
```

```
manifest.json
lib/
  bili-api.js    ← 字幕轨接口：地址构造、响应提取、注入合并、语言选择、字幕解析
  wbi.js         ← WBI 签名（含纯 JS MD5）
  providers.js   ← 数据源适配：AI 总结接口状态判定与字幕提取、第三方接口模板与解读
  settings.js    ← 设置模型：默认值 + 越界钳制
src/
  hook.js        ← MAIN world。劫持 XHR/fetch 做注入，所有网络请求都在这里发（带 Cookie）
  content.js     ← 隔离世界。编排三条来源、驱动输出、转发面板指令
  overlay.js     ← 自建字幕渲染层（双语 + 样式）
  background.js  ← service worker：第三方接口的后台代理、统计
  popup.*        ← 设置面板
tools/
  selftest.js    ← 离线自检
  make-zip.js    ← 零依赖 ZIP 打包器
  make-icons.py  ← 零依赖 PNG 图标生成
```

改代码时的三个"必须"：

1. `lib/*.js` 都写成**双出口**（既能被 Node `require`，又挂到 `globalThis`），
   这样纯逻辑才能被自检覆盖。新增纯函数请一并加测试。
2. 涉及页面请求与注入的代码放 `src/hook.js`（MAIN world），**不能**放 `content.js` ——
   隔离世界改不到页面自己的 `XMLHttpRequest`，也拿不到页面上下文的 Cookie。
3. 新增网络请求时**先想清楚 Referer 与 Cookie 对不对**。B 站多数接口要求登录态，
   必须在页面上下文发才行。

---

## 9. 免责声明

本项目仅用于**个人学习与研究浏览器扩展的请求拦截机制**。
它修改的是你自己浏览器收到的页面数据、调用的是你已登录账号本来就能用的接口，
不破坏 B 站服务端、不绕过任何付费权限。请自行评估使用风险；因使用产生的任何后果由使用者承担。

MIT License.
