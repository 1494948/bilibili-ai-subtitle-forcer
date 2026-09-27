/**
 * src/inject-hook.js —— 把"注入引擎"送进页面的 MAIN world（内容脚本环境）
 *
 * ★ 为什么用这个方式，而不是 manifest 的 world:"MAIN" 或 scripting API：
 *
 *   实测（Edge 153/154，headless 注入标记验证）两个都不可靠：
 *     1. manifest 的 content_scripts 里只要有一条 world:"MAIN"，
 *        同扩展的其他 content_scripts 条目就会被吞掉、不注入 ——
 *        编排层静默消失，表现是"装了没反应"；
 *     2. chrome.scripting.registerContentScripts({world:'MAIN'}) 注册成功
 *        却不注入。
 *
 *   而这一招是浏览器扩展几十年来的经典手法，完全由已验证可靠的
 *   ISOLATED 内容脚本驱动：
 *     在 document_start 同步创建 <script src>（资源在
 *     web_accessible_resources 里声明），插进文档根节点。
 *     本地扩展资源的加载是毫秒级的，远早于页面 JS 发出 player/v2 请求。
 *
 * 顺序用 s.async=false 保持：bili-api → wbi → providers → hook，
 * 后面的文件依赖前面挂到 window 上的 BASFxxx 全局。
 */
(function () {
  'use strict';

  var FILES = [
    'lib/bili-api.js',
    'lib/wbi.js',
    'lib/providers.js',
    'src/hook.js'
  ];

  // 诊断标记：F12 看 <html> 属性，或在 headless 测试里 grep，
  // 一眼确认"注入器"这个内容脚本本身有没有被注入
  try {
    document.documentElement.setAttribute('data-basf-injector', 'loaded');
  } catch (e) { /* noop */ }

  function injectOne(relPath) {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL(relPath);
    // 动态插入的脚本默认 async（谁先下载完谁先跑）；这里必须按序执行，
    // 否则 hook.js 找不到前面的 BASFxxx 全局
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
  }

  for (var i = 0; i < FILES.length; i++) {
    try {
      injectOne(FILES[i]);
    } catch (e) {
      try { console.log('[BASF/inject] 注入 ' + FILES[i] + ' 失败：' + e.message); } catch (e2) { /* noop */ }
    }
  }
})();
