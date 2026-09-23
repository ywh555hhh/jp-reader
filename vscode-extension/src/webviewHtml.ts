// 单词本 / 复习 Webview 的 HTML + 前端 JS
export function webviewHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", sans-serif; font-size: 13px; margin: 0; padding: 0 10px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; position: sticky; top: 0; background: var(--vscode-sideBar-background); padding-top: 6px; z-index: 5; }
  .tab { padding: 6px 12px; cursor: pointer; border-radius: 4px 4px 0 0; opacity: .75; }
  .tab.active { opacity: 1; border-bottom: 2px solid var(--vscode-focusBorder); font-weight: 600; }
  .head { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 6px 0; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; margin-bottom: 8px; background: var(--vscode-editor-background); }
  .lemma-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
  .lemma { font-size: 16px; font-weight: 700; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; opacity: .85; }
  .b-new { background: #f59e0b33; color: #f59e0b; }
  .b-seen { background: #3b82f633; color: #3b82f6; }
  .b-mastered { background: #22c55e33; color: #22c55e; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .ctx { border-left: 3px solid var(--vscode-panel-border); padding-left: 8px; margin: 6px 0; color: var(--vscode-foreground); }
  .src { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .note { width: 100%; box-sizing: border-box; margin-top: 4px; font-size: 12px; }
  .btnrow { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.danger { background: #dc2626aa; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 24px; }
  /* 复习 */
  .review-box { text-align: center; margin-top: 16px; }
  .review-sentence { font-size: 18px; line-height: 2; padding: 12px; }
  .blank { background: var(--vscode-editor-selectionBackground); border-radius: 4px; padding: 0 6px; }
  .reveal { font-size: 16px; margin-top: 10px; }
  .rev-actions { margin-top: 14px; }
  .rev-progress { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  ruby { ruby-align: center; }
  rt { font-size: 0.55em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" id="tab-wordbook">单词本</div>
    <div class="tab" id="tab-review">语境复习</div>
    <div class="tab" id="tab-settings">设置</div>
  </div>
  <div id="view-wordbook">
    <div class="head" id="wordbook-head"></div>
    <div id="wordbook-list"></div>
  </div>
  <div id="view-review" style="display:none">
    <div class="review-box" id="review-box"></div>
  </div>
  <div id="view-settings" style="display:none">
    <div class="head">Provider 配置（翻译 / 朗读 / AI讲解）</div>
    <div id="settings-list"></div>
    <div style="margin-top:12px">
      <button id="btn-open-providers">打开 providers_config.json</button>
    </div>
  </div>

<script>
(function(){
  const vscode = acquireVsCodeApi();
  const $ = (id)=>document.getElementById(id);
  let groups = [];

  // ---- tabs ----
  $('tab-wordbook').onclick = ()=>{ show('wordbook'); };
  $('tab-review').onclick = ()=>{ show('review'); startReview(); };
  $('tab-settings').onclick = ()=>{ show('settings'); vscode.postMessage({type:'loadSettings'}); };
  function show(name){
    $('tab-wordbook').classList.toggle('active', name==='wordbook');
    $('tab-review').classList.toggle('active', name==='review');
    $('tab-settings').classList.toggle('active', name==='settings');
    $('view-wordbook').style.display = name==='wordbook'?'':'none';
    $('view-review').style.display = name==='review'?'':'none';
    $('view-settings').style.display = name==='settings'?'':'none';
  }

  // ---- render wordbook ----
  function renderWordbook(){
    if(!groups.length){ $('wordbook-list').innerHTML='<div class="empty">尚未收集词条。在课文里划选单词 → 右键「语境收集」。</div>'; $('wordbook-head').textContent=''; return; }
    const total = groups.reduce((a,g)=>a+g.entries.length,0);
    $('wordbook-head').textContent = '共 '+groups.length+' 个词条 · '+total+' 条语境';
    let html='';
    for(const g of groups){
      const st = mostStatus(g.entries);
      const cls = 'b-'+st;
      html += '<div class="card">';
      html += '<div class="lemma-row"><span class="lemma">'+esc(g.lemma)+'</span><span class="badge '+cls+'">'+label(st)+'</span></div>';
      html += '<div class="meta">'+esc(g.wtype||'')+' ｜ '+esc(g.pos||'')+' ｜ '+g.entries.length+' 语境</div>';
      for(const e of g.entries){
        html += '<div class="ctx">'+esc(e.sentence)+'<div class="src">'+esc(e.source)+' · '+esc(e.timestamp.slice(0,10))+'</div></div>';
        html += '<input class="note" data-id="'+e.id+'" data-key="note" value="'+escAttr(e.note)+'" placeholder="笔记…">';
        html += '<div class="btnrow">';
        html += '<button data-id="'+e.id+'" data-st="new">新词</button>';
        html += '<button data-id="'+e.id+'" data-st="seen">接触过</button>';
        html += '<button data-id="'+e.id+'" data-st="mastered">已掌握</button>';
        html += '<button class="danger" data-id="'+e.id+'" data-del="1">删除</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    $('wordbook-list').innerHTML = html;
  }

  function mostStatus(entries){
    const c={new:0,seen:0,mastered:0};
    for(const e of entries) c[e.status||'new']++;
    let best='new'; for(const k of ['new','seen','mastered']) if(c[k]>c[best]) best=k;
    return best;
  }
  function label(s){ return {new:'新词',seen:'接触过',mastered:'已掌握'}[s]||s; }
  function esc(s){ return String(s||'').replace(/[&<>"]/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
  function escAttr(s){ return String(s||'').replace(/[&<>"]/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])).replace(/\\n/g,'&#10;'); }

  // ---- event delegation ----
  document.body.addEventListener('click',(ev)=>{
    const b = ev.target.closest('button'); if(!b) return;
    const id = b.getAttribute('data-id');
    if(b.hasAttribute('data-del')){ vscode.postMessage({type:'delete',id}); return; }
    const st = b.getAttribute('data-st'); if(st) vscode.postMessage({type:'setStatus',id,status:st});
  });
  document.body.addEventListener('change',(ev)=>{
    const inp = ev.target;
    if(inp && inp.classList.contains('note')){
      vscode.postMessage({type:'setNote', id:inp.getAttribute('data-id'), note:inp.value});
    }
  });

  // ---- review ----
  function startReview(){ vscode.postMessage({type:'reviewStart'}); }
  let review = null;
  function renderReview(item){
    if(!item){ $('review-box').innerHTML='<div class="empty">暂无复习词条。</div>'; return; }
    const progress = item.done + ' / ' + item.total;
    $('review-box').innerHTML =
      '<div class="rev-progress">'+progress+'</div>'+
      '<div class="review-sentence">'+item.sentenceHidden+'</div>'+
      '<div class="reveal" id="reveal"></div>'+
      '<div class="rev-actions">'+
        '<button id="rev-reveal">显示答案</button> '+
        '<button id="rev-ok">记住了</button> '+
        '<button id="rev-no">忘了</button>'+
      '</div>';
    $('rev-reveal').onclick = ()=>{ $('reveal').innerHTML = esc(item.lemma)+' <span class="meta">'+esc(item.reading||'')+' ｜ '+esc(item.wtype||'')+'</span>'; };
    $('rev-ok').onclick = ()=>{ vscode.postMessage({type:'reviewAnswer', ok:true}); };
    $('rev-no').onclick = ()=>{ vscode.postMessage({type:'reviewAnswer', ok:false}); };
  }

  // ---- messages from extension ----
  window.addEventListener('message', (ev)=>{
    const msg = ev.data;
    if(msg.type==='data'){ groups = msg.groups; renderWordbook(); }
    else if(msg.type==='reviewItem'){ review = msg.item; renderReview(review); }
    else if(msg.type==='reviewEmpty'){ renderReview(null); }
    else if(msg.type==='settings'){ renderSettings(msg); }
  });

  function renderSettings(msg){
    const items = [
      { key:'translate', label:'翻译', active: msg.translate },
      { key:'speak', label:'朗读', active: msg.speak },
      { key:'explain', label:'AI讲解', active: msg.explain }
    ];
    let html = '';
    for(const it of items){
      html += '<div class="card">';
      html += '<div class="lemma-row"><span class="lemma">'+it.label+'</span>';
      html += '<span class="badge b-'+(it.active==='off'?'new':'mastered')+'">'+esc(it.active)+'</span></div>';
      html += '<div class="meta">当前 provider：'+esc(it.active)+'</div>';
      html += '</div>';
    }
    html += '<div class="meta" style="margin-top:8px">配置文件：providers_config.json<br>支持 builtin / http / command 三种 provider</div>';
    $('settings-list').innerHTML = html;
  }

  $('btn-open-providers').onclick = ()=>{ vscode.postMessage({type:'openProviders'}); };

  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
}
