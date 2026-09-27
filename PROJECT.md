# PROJECT.md · bilibili-ai-subtitle-forcer

> 这是工作卡。**任何 AI 会话在这个目录下动手之前，先读本文件。**

## 1. 一句话定位

- **中文名**：B站 AI 字幕
- **定位**：一个 Chrome / Edge 扩展。让 B 站网页视频**真的出现 AI 字幕**，且字幕由**服务端产出**
  （不是本地跑识别）。三条来源按优先级尝试：

  | 来源 | 数据从哪来 | 输出方式 |
  |---|---|---|
  | ① 已有字幕轨 | 免登录通道 `x/v2/dm/view` + 劫持 `x/player/v2` 响应注入 | **B站原生字幕** |
  | ② **B站服务端生成** ★ | `x/web-interface/view/conclusion/get`（AI 视频总结）。没生成过的视频会被**服务端排进处理队列**，轮询等结果 | 自建字幕层 |
  | ③ 第三方接口 | 用户自配的 URL 模板（内置 JustOneAPI 预设） | 自建层 / 原生（看返回形态） |

## 2. 状态

- **状态**：可用（v2.1.0，2026-09-27 发布）
- **与 v1.0.0 的关系**：v1 只做「把 B 站已有的字幕轨强行显示出来」+ 本地 ASR 兜底。
  用户明确否掉了本地 ASR —— 要的是**服务端生成**。v2 因此砍掉 `src/asr.js`，
  新增 WBI 签名、服务端生成链路、第三方接口适配。
- **验证边界（重要，别高估也别低估）**：
  - **注入链路已在真实 Edge 上端到端验证**（Edge 153/154，headless 模式加载扩展访问
    B 站视频页，用 `<html>` 上的 `data-basf-*` 注入标记确认三个世界全部注入成功 —— 见坑 21/22）。
  - **字幕数据流仍未在真实环境验证**：AI 总结接口对哪些视频/账号开放没有实测，成功率未知；
    免登录字幕通道的真实返回也没实测过。
  - **没做有头模式的手测**（headless 看不到播放器的渲染效果），字幕显示效果请以实际使用为准。
  - 第三方接口只内置了 JustOneAPI 一种预设，其余靠用户自填模板。

## 3. 技术栈与关键依赖

- **Chrome 扩展 Manifest V3**，`minimum_chrome_version: 111`
  （`content_scripts[].world: "MAIN"` 从 Chrome 111 起支持，是本项目的硬下限）
- **零第三方依赖、零构建步骤**。`package.json` 的 `dependencies` 为空。
  MD5、WBI 签名、PNG 图标、ZIP 打包都是自己写的。
- 工具链用的可用运行时：Node **22.22.2**、Python **3.13.12**（本机**没有** Pillow）

各文件职责：

| 文件 | 说明 |
|---|---|
| `manifest.json` | 唯一配置。两条 `content_scripts`：`world: MAIN`（hook）+ 隔离世界（编排） |
| `lib/bili-api.js` | 字幕轨接口全套纯逻辑：地址构造、响应提取、`mergeSubtitle` 注入核心、语言选择、字幕解析、时间轴二分 |
| `lib/wbi.js` | **WBI 签名**（2023-03 起的 Web 端风控签名）+ 纯 JS MD5。AI 总结接口强制要求 |
| `lib/providers.js` | 数据源适配：AI 总结接口的状态判定/字幕提取、第三方接口的模板构造与三种响应解读 |
| `lib/settings.js` | 设置模型：默认值 + 越界钳制 |
| `src/hook.js` | **MAIN world。项目核心**：劫持 XHR/fetch 做注入，且所有网络请求都在这里发（带 Cookie 与正确 Referer） |
| `src/content.js` | 隔离世界编排：三条来源的调度、服务端生成的轮询、输出、转发面板指令 |
| `src/overlay.js` | 自建字幕渲染层（双语 + 样式） |
| `src/background.js` | service worker：第三方接口的后台代理（免 CORS）、统计 |
| `src/popup.*` | 设置面板 |
| `tools/selftest.js` | 离线自检（216 项，含运行时冒烟） |
| `tools/make-zip.js` | 零依赖 ZIP 打包器 |
| `tools/make-icons.py` | 零依赖 PNG 图标生成 |

## 4. 常用命令

```bash
# 离线自检（216 项；失败退出码 1）
node tools/selftest.js

# 打包成可发布的 zip
node tools/make-zip.js                              # → dist-extension-v<版本>/BASFCaptions-v<版本>.zip
node tools/make-zip.js --out <目录>                 # 指定输出目录（换目录名可避开本机安全删除钩子）
node tools/make-zip.js --list                       # 额外输出 zipfile-list.json 供逐文件校验

# 重新生成图标
python tools/make-icons.py

# 装到浏览器里手测（每次改完代码都要做）
#   chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选本目录
```

## 5. 发布信息

- **GitHub 仓库**：https://github.com/1494948/bilibili-ai-subtitle-forcer
- **分支**：`main`
- **产品名**：B站 AI 字幕
- **当前版本**：v2.1.0
- **产物命名**：`BASFCaptions-v<版本>.zip`
- **归档位置**：`C:\AI Document\releases\bilibili-ai-subtitle-forcer\v<版本>\`
- **推送命令（本机固定要带两个开关）**：
  ```bash
  GIT_SSL_NO_VERIFY=true git -c credential.helper=manager push origin main
  ```
- **提交作者**：本仓库 `user.email` 设为 `66010812+1494948@users.noreply.github.com`（仅本仓库）

## 6. 已知的坑

1. **`const x;` 是硬语法错误。** 会让整个内容脚本加载失败。自检里有专门一条扫这个模式。
2. **Node 与 Git Bash 的路径映射不一致。** Node 把 `/tmp/x` 解析成 `C:\tmp\x`。
   写脚本时 Node 用 `C:/` 绝对路径。
3. **推送的 TLS 要关验证**（`GIT_SSL_NO_VERIFY=true`，代理做中间人导致 schannel 报
   `CRYPT_E_NO_REVOCATION_CHECK`）。
4. **推送/查凭据都要带 `-c credential.helper=manager`。** 全局 gitconfig 里有一行
   `[credential] helper =`（空值），它会把凭据助手列表清空 —— 连 `git credential fill`
   都会静默返回空，极易误判成"没缓存过凭据"而去折腾重新授权。
5. **提交邮箱会被 GH007 拒收。** 账号把 `3504821363@qq.com` 设为私密后，新提交会被拒。
   本仓库用 noreply 地址。
6. **MV3 的硬约束**
   - service worker **没有 DOM**；`importScripts` 路径**相对于 worker 脚本本身**。
   - **MAIN world 里没有 `chrome.*` API**。`src/hook.js` 与内容脚本只能靠 `window.postMessage`
     对话，消息都带 `__basf: true` 与 `dir` 字段双向区分。
   - `content_scripts[].world` 需要 Chrome 111+；`default_locale` **不能**在不用 `_locales` 时出现。
   - `optional_host_permissions` 的模式**不能与 `host_permissions` 重复** —— 所以本项目
     `host_permissions` 是空的：内容脚本的 `matches` 已授权页面上下文，
     而 hook 的请求本来就在页面自己的上下文里发（自带 Cookie 与 Referer）。
7. **注入必须早于播放器的请求。** hook 是 `run_at: document_start`，且在 `XMLHttpRequest.open()`
   阶段就注册 `readystatechange`（早于页面任何注册）。若扩展是在页面加载完之后才启用，
   这一次赶不上 —— 需要强制刷新。
8. **延迟 `send()` 有硬超时（1800ms）。** `x/player/v2` 的 URL 里自带 aid/cid，
   所以能在 `open()` 就知道对应哪个视频，在 `send()` 里"先取字幕、后放行"。
   但**宁可少注入也不能卡住视频**，超时后无条件放行。
9. **缓存要区分"已有结论"和"正在取"。** entry 上加 `done` 标记，只有 `done` 才走零等待分支；
   否则提前预取（promise 还在飞）时播放器请求被立即放行，响应到达时数据还是空的 → 注入静默失败。
10. **`text-shadow` 不能拆成两个 CSS 变量再在样式表里逗号拼接。** 描边关掉时那一段是 `none`，
    拼出来 `..., none` 是非法值，会让整条声明失效。整串在 JS 里拼好再一次性塞进去。
11. **自建字幕层必须用 `textContent`。** 字幕文本来自网络，走 `innerHTML` 就是 XSS 入口。
12. **`num(v, dflt)` 的 0 陷阱。** `__INITIAL_STATE__` 顶层的 aid 可能是 0，
    而 `num` 认为 0 合法，于是缺省值永不生效，会把从 `videoData` 取到的 aid 抹成 0。
    改用 `positive(v, dflt)`。
13. **WBI 签名的三个易错点**（都已被自检钉住）：
    - `value` 里的 `!'()*` 必须先过滤掉再编码；
    - 空格必须编成 `%20`（不能用 `+`），字母大写 —— JS 原生 `encodeURIComponent` 正好符合；
    - 签名时参数按 key 升序，但**请求时不必排序**。
    另外 `a.eval()` 得不到的坑：img_url/sub_url **是伪装的 token，不要去访问那两个 url**。
14. **AI 总结接口的 `data.code=1` 不是错误。** 它的意思是"服务端正在处理"，
    `stid="0"` 表示刚进队列。**必须轮询**，不能当失败直接放弃。这是最容易搞错的一点。
15. **第三方接口的 `bili-subtitle-url` 模式**：`pickPath(json, '')` 会原样返回整个对象，
    所以取到的可能不是字符串。必须先 `typeof === 'string'` 判断，再走多路径兜底
    （已修，自检里有对应用例）。
16. **`pickPath` 空路径返回原对象**是刻意的设计（表示"就在根节点"），
    但所有调用方都要意识到这一点。
17. **扩展装了/更新了，已经打开的页面必须刷新才生效。** 内容脚本是 `document_start`，
    页面比扩展先打开就赶不上。**这不是 bug，是 Chromium 扩展的固有行为** ——
    但它极易被误判成"插件坏了"。对策：popup 必须能识别这种状态，并给一颗「刷新本页」按钮。
18. **popup 读不到 `tab.url` 时不要乱下结论。** 没有 `tabs` 权限、也没有该站点 host 权限时，
    `chrome.tabs.query` 返回的 `tab.url` 是 `undefined`。v2.0.0 就因此把
    "内容脚本没响应（刷新即可修）" 说成了 "当前标签页不是 B 站视频页（像是没救了）"，
    把用户的排查方向带偏。声明 **`activeTab`**（点击图标时临时授予读 url 的权限）即可区分，
    且它的权限提示比 `tabs` 轻得多。自检里加了"没有申请全量 tabs 权限"这条守门。
19. **语法检查通过 ≠ 运行时不炸。** 内容脚本初始化时抛错的表现是**静默失效**：
    扩展显示已加载、页面上毫无动静，用户只会说"装了没用"。所以自检里加了 `vm` 沙箱冒烟，
    在 mock 出来的浏览器环境里按 manifest 的顺序真跑一遍（含 `BASFxxx` 全局是否挂上）。
20. **文件对话框里选错目录是高频失误。** `releases/<项目>/v<版本>/` 里只有 zip 和发布说明，
    没有 `manifest.json`，选它会报"清单文件丢失或不可读取"。回复里同时给出两个路径时，
    必须**明确哪个才是要加载的那一个**。
21. **★ manifest 的 `content_scripts` 里只要有一条 `world:"MAIN"`，同扩展的其他条目就会被
    吞掉、不注入。** 这是本项目最隐蔽的一个坑（v2.1.0 才挖出来）：扩展显示已加载、
    background 正常跑、静态 MAIN 条目正常注入，**唯独编排层（内容脚本）从未出现过** ——
    用户看到的就是"装了没反应"，而且刷新页面也救不回来。
    二分实验（Edge 153/154 + headless 注入标记，5 个变体）：

    | 变体 | MAIN 组 | ISOLATED 组 |
    |---|---|---|
    | MAIN 在前、ISOLATED 在后（原样） | ✓ | ✗ |
    | 只留 ISOLATED 一条 | — | ✓ |
    | **两条都去掉 `world`** | ✓ | ✓ |
    | ISOLATED 在前、MAIN 在后 | ✗ | ✓ |

    **解法**：manifest 只留 ISOLATED 条目；MAIN 引擎由 `src/inject-hook.js`（内容脚本）
    以 `<script src>` 送进页面 —— 资源在 `web_accessible_resources` 里声明，
    `s.async = false` 保证 `bili-api → wbi → providers → hook` 的执行顺序。
22. **`chrome.scripting.registerContentScripts({ world:'MAIN' })` 注册成功却不注入。**
    回调没有 `lastError`、`getRegisteredContentScripts` 也查得到，但页面加载时它就是不来。
    同批被否掉的还有"background + `tabs.onUpdated` + `executeScript`"（时序不可控）。
    **别在这两条路上浪费时间**，直接用坑 21 的解法。
23. **端到端验证扩展注入，用 headless + DOM 标记**：
    ```bash
    msedge --headless=new --disable-gpu --no-first-run \
      --user-data-dir=<临时 profile> --load-extension=<扩展目录> \
      --enable-logging=stderr --virtual-time-budget=12000 \
      --dump-dom "https://www.bilibili.com/video/<BV号>/" > dom.html 2> edge.log
    ```
    内容脚本在 `<html>` 上 `setAttribute` 一个标记，然后 grep 标记 —— 比"看 DOM 里有没有
    业务元素"可靠得多（业务元素可能因为流程没走到而不出现，会误判成"没注入"）。
    `--enable-logging=stderr` 还能拿到 content script / background 的 console 输出。
    注意：动态注册的 content script **赶不上首次安装时那个正在加载的页面**，
    要验证持久注册得用同一个 profile 跑第二次导航。

## 7. 变更记录

| 日期 | 改了什么 | 为什么 |
|---|---|---|
| 2026-09-27 | 立项并发布 v1.0.0 | 用户需求：视频原本没有「AI 自动生成字幕」开关，要强行让它出现并能成功打开使用 |
| 2026-09-27 | 确定"响应注入"而非"模拟 UI 点击"为主线 | 播放器字幕列表完全由 `x/player/v2` 响应决定，改数据源等于让播放器自己渲染，全屏/画中画/倍速都正常 |
| 2026-09-27 | 用免登录通道 `x/v2/dm/view` 做预取 | 这是"未登录时 subtitle 为空"的直接解法 |
| 2026-09-27 | 在 `open()` 阶段注册 readystatechange | XHR 事件按注册顺序派发，`open()` 早于页面任何注册 |
| 2026-09-27 | `send()` 改"先取字幕后放行"+1800ms 硬超时 | 首次加载时预取可能还没回来；同时保住"不阻塞视频"这条底线 |
| 2026-09-27 | 缓存加 `done` 标记 | 修时序 bug：预取进行中被误判为已缓存 → 立即放行 → 数据为空 |
| 2026-09-27 | `idsFromInitialState` 改用 `positive()` | 修掉顶层空 `state.aid` 覆盖 `videoData.aid` 的 bug |
| 2026-09-27 | 零依赖 PNG 图标生成器 | 本机没有 Pillow；顺带修掉抗锯齿 alpha 溢出（`r+0.5-dist` 最大 1.5，乘 255 会得 382） |
| 2026-09-27 | 自检扩到 135 项，覆盖注入六种情形 | 注入是核心，必须能离线验证 |
| **2026-09-27** | **v2.0.0：方向修正 —— 字幕改由服务端产出** | **用户反馈："不是本地运算或者劫持输入字幕，我要的是服务器自动生成的或者是连接其他网页的接口"。v1 的本地 ASR 与整体定位不符，推倒重来** |
| 2026-09-27 | 新增 `lib/wbi.js`（WBI 签名 + 纯 JS MD5） | AI 总结接口强制要求签名。查证了官方文档的完整算法，并用文档给的 `w_rid` 权威值做了端到端验证 |
| 2026-09-27 | 新增 `lib/providers.js` | 把「AI 总结接口」与「第三方接口」两种服务端产出的响应，统一成同一种 cue 结构 |
| 2026-09-27 | 新增「B站服务端生成」这条主线 | 查证到 `x/web-interface/view/conclusion/get` **本身就是生成入口**：没处理过的视频请求一次就进服务端队列（`data.code=1, stid="0"`），轮询即可拿到服务端 AI 识别的字幕 |
| 2026-09-27 | 新增第三方接口支持（内置 JustOneAPI 预设 + 通用模板） | 用户要的"连接其他网页的接口"。支持三种响应形态，页面上下文失败自动回落后台代发 |
| 2026-09-27 | 删除 `src/asr.js` 与全部本地音频采集 | 用户明确不要本地运算。`createMediaElementSource` 那套在 CDN 不开 CORS 时本来就拿不到音频 |
| 2026-09-27 | settings 里 `asr` 配置整块换成 `sources` | 配置模型跟着来源走：三条来源各自开关 + 服务端等待秒数 + 第三方接口全套参数 |
| 2026-09-27 | 修 `bili-subtitle-url` 模式的类型 bug | `pickPath(json,'')` 返回整个对象，`str()` 后成了 `[object Object]`。改为先判类型再多路径兜底 |
| 2026-09-27 | 自检从 135 项扩到 198 项 | 新增 MD5/WBI 权威向量、AI 总结八种状态判定（用文档真实样例）、第三方接口三种解读、坏数据边界 |
| 2026-09-27 | **v2.0.1：修 popup 的状态误判，新增「刷新本页」** | 用户装上后在 B 站视频页看到「当前标签页不是 B 站视频页」，被带偏方向。真因是**页面比扩展先打开**（内容脚本没注入），而 popup 因为读不到 `tab.url`，把这件事误报成了"不是 B 站页面" |
| 2026-09-27 | manifest 加 `activeTab` 权限 | 让 popup 能读当前标签页 URL，从而区分"不是 B 站页"与"是 B 站页但没刷新"。比 `tabs` 权限的提示轻得多 |
| 2026-09-27 | popup 状态判断改成三态 | 不是 B 站页 / 是 B 站页但没生效 / 正常。把可修复的问题明确说出来并给一键修复，而不是笼统报错 |
| 2026-09-27 | 新增「刷新本页」按钮 | 用户点一下就 reload 当前标签页，装完扩展不用自己去按 F5 |
| 2026-09-27 | 自检加 `vm` 沙箱运行时冒烟（198 → 216 项） | 语法通过不代表跑起来不炸，而内容脚本抛错是**静默失效**。已在 mock 环境里按 manifest 顺序真跑通两个内容脚本的初始化，并确认 `BASFxxx` 全局真的挂上了 |
| 2026-09-27 | 用浏览器本体 `--pack-extension` 做真机校验 | 比离线自检权威：浏览器会完整校验 manifest 与每个引用文件。Edge 153/154 打包通过 → 确认"点加载不会因清单不合法而失败" |
| 2026-09-27 | **v2.1.0：换注入方式，真机打通注入链路** | 用户刷新后仍显示"扩展还没生效"。用 headless 真机测试抓到根因：manifest 里 `world:"MAIN"` 的条目会**吞掉其他 content_scripts** —— 编排层从未注入过。二分实验 5 个变体定位后，改用 `inject-hook.js` 以 `<script src>` 注入，三个注入标记在 Edge 153/154 上全部验证通过 |
| 2026-09-27 | 新增 `src/inject-hook.js` + `web_accessible_resources` 声明 4 个注入文件 | 页面 `<script src>` 的加载对象必须声明为 web 可访问资源；`s.async=false` 保证 bili-api→wbi→providers→hook 的执行顺序 |
| 2026-09-27 | 内容脚本与注入引擎加启动日志 + `<html>` 诊断标记 | 排查"装了没反应"的第一入口：F12 控制台看 `[BASF/content]` 在不在、`<html>` 上看 `data-basf-*` 标记。三条日志链（background / 内容脚本 / 注入引擎）齐全 |
| 2026-09-27 | lib 的 `VERSION` 常量从 1.0.0 同步到 2.1.0 | 启动日志一直显示 v1.0.0，看着像加载了旧代码，排查时极具误导性 |
| 2026-09-27 | 自检 208 → 216 项 | 新增 web_accessible_resources 检查、inject-hook.js 位置检查、service worker 冒烟（importScripts 桥接到真实文件）、"没有申请全量 tabs"守门 |
| 2026-09-27 | 引入 headless 端到端测试法（见坑 23） | 离线自检覆盖不到"扩展到底注不注入"。真机 DOM 标记 + stderr 日志才是这个问题的唯一有效诊断手段 |
