/**
 * 阅读视图的 HTML 外壳 + 前端脚本。
 *
 * 单独拆出来有两个原因：
 *   1. 它是纯字符串拼接，不依赖 vscode —— 留在 readingView 里会把那个文件顶过 350 行预警线
 *      （模块变胖是"拆不动"的信号，见否命题 A19）
 *   2. 高亮样式**不再写在这里**：共用 preview/jp-reader.css，由 wrapHtml 的 sharedCss 注入。
 *      以前这里内联了第三份高亮样式，改一处忘一处。
 */

export function loadingHtml(): string {
    return `<!doctype html><html><body style="font-family:sans-serif;padding:2em;color:#888">JP Reader：日语分词器加载中…</body></html>`;
}

export function wrapHtml(bodyHtml: string, css: string): string {
    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src https://translate.google.com https://*.translate.google.com; img-src data:;" />
<title>JP Reader</title>
<style>
/* 与预览视图共用同一份文件（preview/jp-reader.css）；
   这里不再重复写高亮样式——以前内联了第三份，改一处忘一处。 */
${css}
</style>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif;
    line-height: 1.9;
    max-width: 780px;
    margin: 0 auto;
    padding: 2.5em 1.5em 6em;
    font-size: 16px;
  }
  h1, h2, h3 { line-height: 1.4; }
  #jpcontent { min-height: 60vh; }
  .jpcover {
    font-size: 12px; color: rgba(140,140,140,.95);
    border-bottom: 1px solid rgba(128,128,128,.25);
    padding: 6px 0 8px; margin-bottom: 12px;
  }
  .jpcover .words { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .jpcover .w { cursor: default; }
  .jpcover .w i { font-style: normal; opacity: .55; font-size: 10px; margin-left: 2px; }
  .jpcover .w.pri { color: #4ade80; }

  /* 划词悬浮工具栏 */
  #jpbar {
    position: absolute; display:none; z-index:100;
    background: rgba(40,40,45,.96); color:#eee;
    border-radius:8px; padding:4px; box-shadow:0 4px 16px rgba(0,0,0,.4);
    font-size:13px; font-family: inherit;
  }
  #jpbar button {
    background:transparent; border:none; color:#eee; cursor:pointer;
    padding:5px 9px; border-radius:5px; font-size:13px;
  }
  #jpbar button:hover { background: rgba(255,255,255,.15); }

  /* 结果弹窗 */
  #jppop {
    position:absolute; display:none; z-index:101; max-width:420px;
    background: rgba(30,30,35,.98); color:#eee; border-radius:10px;
    padding:12px 14px; box-shadow:0 6px 24px rgba(0,0,0,.5);
    font-size:13px; line-height:1.6; white-space:pre-wrap;
  }
  #jppop .row { margin-bottom:4px; }
  #jppop .label { color:#9ecbff; }
</style>
</head>
<body>
<div id="jpcover" class="jpcover"></div>
<div id="jpcontent">${bodyHtml}</div>

<div id="jpbar"></div>
<div id="jppop"></div>

<script>
(function () {
  const vscode = acquireVsCodeApi();

  // 课文是自己的内容，但它终究是用户可编辑的文本；进 innerHTML 前一律转义
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderCoverage(m) {
    const el = document.getElementById('jpcover');
    if (!el) return;
    let html = esc(m.summary);
    if (m.unknown && m.unknown.length) {
      html += '<div class="words">' + m.unknown.map(function (u) {
        return '<span class="w' + (u.priority ? ' pri' : '') + '">' + esc(u.lemma) +
          '<i>' + u.count + '</i></span>';
      }).join('') + '</div>';
    }
    el.innerHTML = html;
  }
  const bar = document.getElementById('jpbar');
  const pop = document.getElementById('jppop');
  let currentAudio = null;

  // 朗读：URL 由宿主给出（出网只有一个出口），这里只负责顺序播放。
  // 以前这里自己拼 Google TTS 的 URL、还自带一份切分逻辑，与宿主那份重复。
  function playTTS(urls) {
    if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
    if (!urls || urls.length === 0) { showPop('⚠ 朗读失败（没有可用音频）', window.scrollX + window.innerWidth/2, window.scrollY + 80); return; }
    let i = 0;
    function next() {
      if (i >= urls.length) { showPop('▶ 朗读结束', window.scrollX + window.innerWidth/2, window.scrollY + 80); return; }
      const a = new Audio(urls[i]);
      currentAudio = a;
      a.onended = () => { i++; next(); };
      a.onerror = () => { showPop('⚠ 朗读失败（检查网络/代理）', window.scrollX + window.innerWidth/2, window.scrollY + 80); };
      a.play().catch(() => showPop('⚠ 无法播放音频', window.scrollX + window.innerWidth/2, window.scrollY + 80));
    }
    next();
  }

  function hidePop() { pop.style.display = 'none'; }

  // 划词时从选区起点向上找最近的、带 offset 的 span。
  // 每个日语词都会被包成 .jp（不只是命中规则的），所以只要选中落在词内就能定位。
  function offsetFromSelection(sel) {
    try {
      let node = sel.anchorNode;
      if (node && node.nodeType === 3) node = node.parentElement;
      const span = node && node.closest ? node.closest('.jp[data-offset]') : null;
      return span ? Number(span.dataset.offset) : null;
    } catch (e) {
      return null;
    }
  }

  function showBar(x, y, text, offset) {
    bar.innerHTML =
      '<button data-a="speak" title="朗读">🔊</button>' +
      '<button data-a="lookup" title="查词">📖</button>' +
      '<button data-a="translate" title="翻译">🌐</button>' +
      '<button data-a="ai" title="AI讲解">🤖</button>' +
      '<button data-a="collect" title="语境收集">➕</button>';
    bar.style.display = 'block';
    bar.style.left = Math.min(x, window.innerWidth - 240) + 'px';
    bar.style.top = (y - 46) + 'px';
    bar.dataset.text = text;
    bar.dataset.offset = (offset === null || Number.isNaN(offset)) ? '' : String(offset);
    bar.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.a;
        const t = bar.dataset.text;
        // 真实 offset：原句由宿主按 offset 从源文切出来，而不是用词形反查（否命题 A6）
        const off = bar.dataset.offset === '' ? null : Number(bar.dataset.offset);
        if (a === 'speak') { bar.style.display = 'none'; vscode.postMessage({ type:'speak', text: t }); }
        else if (a === 'lookup') vscode.postMessage({ type:'lookup', surface: t });
        else if (a === 'translate') vscode.postMessage({ type:'translate', text: t });
        else if (a === 'ai') vscode.postMessage({ type:'aiExplain', text: t, offset: off });
        else if (a === 'collect') vscode.postMessage({ type:'collect', surface: t, offset: off });
      };
    });
  }

  function showPop(html, x, y) {
    pop.innerHTML = html;
    pop.style.display = 'block';
    pop.style.left = Math.min(x, window.innerWidth - 440) + 'px';
    pop.style.top = (y + 14) + 'px';
  }

  document.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text && /[\\u3040-\\u30ff\\u3400-\\u9fff]/.test(text)) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        showBar(rect.left + window.scrollX, rect.top + window.scrollY, text, offsetFromSelection(sel));
      } else {
        bar.style.display = 'none';
      }
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (!bar.contains(e.target) && !pop.contains(e.target)) {
      hidePop();
    }
  });

  // 点高亮词直接查词
  document.addEventListener('click', (e) => {
    const el = e.target.closest('.jp');
    if (el && !window.getSelection().toString()) {
      const s = el.dataset.surface || el.textContent;
      vscode.postMessage({ type:'lookup', surface: s });
    }
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    const anchor = { x: window.scrollX + window.innerWidth/2, y: window.scrollY + 80 };
    if (m.type === 'lookupResult') {
      if (!m.items || m.items.length === 0) { showPop('（未识别为日语词）', anchor.x, anchor.y); return; }
      const rows = m.items.map((it) =>
        '<div class="row"><span class="label">'+it.surface+'</span> → lemma:'+it.lemma+
        '｜品詞:'+it.pos+'｜語種:'+it.wtype+(it.reading?('｜読'+it.reading):'')+'</div>'
      ).join('');
      showPop(rows, anchor.x, anchor.y);
    } else if (m.type === 'translateResult') {
      showPop((m.result ? ('翻译：'+m.result) : ('出错：'+(m.error||''))), anchor.x, anchor.y);
    } else if (m.type === 'aiResult') {
      showPop((m.result ? m.result : ('出错：'+(m.error||''))), anchor.x, anchor.y);
    } else if (m.type === 'speakUrls') {
      if (m.error) { showPop('⚠ ' + m.error, anchor.x, anchor.y); return; }
      playTTS(m.urls);
    } else if (m.type === 'collectResult') {
      showPop(m.error ? ('⚠ ' + m.error) : ('已收集 ' + m.count + ' 个词条。\\n句：' + m.sentence), anchor.x, anchor.y);
    } else if (m.type === 'coverage') {
      renderCoverage(m);
    } else if (m.type === 'updateBody') {
      // 局部替换正文：不重载页面，所以滚动位置、弹窗与正在播放的音频都不受影响
      const y = window.scrollY;
      const host = document.getElementById('jpcontent');
      if (host) host.innerHTML = m.html;
      window.scrollTo(0, y);
    }
  });
})();
</script>
</body>
</html>`;
}
