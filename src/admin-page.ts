/**
 * 管理后台（/admin）—— 「深夜图书馆」主题的站长控制台。
 *
 * 设计目标（面向不懂网络安全的站长）：
 *   · 一眼看到「安全防护哪些开着、哪些没开」—— 不用懂技术也能判断站点状态
 *   · 能看到全部书、搜索、批量删除 —— 遇到侵权/恶意内容能立刻处置
 *   · 口令只存在浏览器 sessionStorage，关闭标签即失效；不写 Cookie（免 CSRF）
 *
 * 技术约束：与其它页面一样，零依赖、内联 CSS/JS、Worker 直接吐出。
 * 安全要点：所有来自服务端的数据都经 esc() 转义后再插入 DOM（书名叫什么都有可能）。
 */

import { themeCss } from './lib/theme';

export function adminHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理后台 · webooks</title>
<meta name="robots" content="noindex,nofollow">
<style>
${themeCss()}
  .bar-head{display:flex;align-items:baseline;gap:var(--s3);margin-bottom:var(--s5)}
  .mk{font-family:var(--serif);font-size:1.05rem;letter-spacing:.3em;color:var(--glow)}
  .mk a{color:inherit;text-decoration:none}
  .back{margin-left:auto;font-size:.8rem;font-family:var(--serif);letter-spacing:.08em}
  h1{font-family:var(--serif);font-weight:400;font-size:clamp(1.5rem,4vw,2rem);letter-spacing:.03em;margin-bottom:var(--s4)}

  /* ── 登录 ── */
  .login{max-width:26rem;padding:var(--s5);border:1px solid var(--line);border-radius:var(--r3);
    background:linear-gradient(160deg,var(--ink-2) 0%,#120f0c 100%)}
  .login p{color:var(--paper-dim);font-size:.88rem;margin-bottom:var(--s4);line-height:1.7}
  label{display:block;font-size:.82rem;color:var(--paper-dim);margin-bottom:var(--s2);letter-spacing:.04em}
  input[type=password],input[type=text]{
    width:100%;padding:.7rem .8rem;font:inherit;font-size:.95rem;
    background:rgba(0,0,0,.45);color:var(--paper);
    border:1px solid var(--line);border-radius:var(--r2);
  }
  input:focus-visible{outline:2px solid var(--glow);outline-offset:2px}

  /* ── 安全状态卡 ── */
  .sec{display:grid;gap:var(--s2);grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-bottom:var(--s5)}
  .secitem{display:flex;gap:var(--s2);align-items:flex-start;padding:var(--s3);
    border:1px solid var(--line);border-radius:var(--r2);background:rgba(0,0,0,.25)}
  .dot2{flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:.45em}
  .dot2.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  .dot2.no{background:var(--er);box-shadow:0 0 8px var(--er);animation:flicker 1.6s ease-in-out infinite}
  .sectext{min-width:0}
  .sectitle{font-family:var(--serif);font-size:.92rem;letter-spacing:.03em}
  .sechint{font-size:.76rem;color:var(--paper-dim);line-height:1.6;word-break:break-word}

  /* ── 工具条 ── */
  .toolbar{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s4)}
  .toolbar input[type=text]{flex:1;min-width:12rem;max-width:24rem}
  .stat{font-family:var(--serif);font-size:.82rem;color:var(--paper-dim);letter-spacing:.06em;margin-left:auto}
  .stat b{color:var(--glow);font-weight:600}

  /* ── 书列表 ── */
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th,td{text-align:left;padding:.6rem .5rem;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  th{font-family:var(--serif);font-weight:400;font-size:.78rem;letter-spacing:.08em;color:var(--paper-dim)}
  tr:hover td{background:rgba(255,180,77,.04)}
  td.name{word-break:break-word;max-width:22rem}
  td.name .t{font-family:var(--serif)}
  td.name .a{color:var(--paper-dim);font-size:.78rem}
  .pill{display:inline-block;font-family:var(--mono);font-size:.68rem;letter-spacing:.04em;
    padding:.1rem .4rem;border-radius:999px;border:1px solid var(--line);color:var(--glow)}
  .muted{color:var(--paper-dim);font-size:.78rem;font-family:var(--mono)}
  .rowsel{width:1.5rem}
  input[type=checkbox]{width:1rem;height:1rem;accent-color:var(--glow);cursor:pointer}

  .danger{border-color:var(--er)!important;color:var(--er)!important}
  .danger:hover{background:rgba(255,138,122,.1)!important}
  .toast{margin-top:var(--s3);padding:var(--s3) var(--s4);border-radius:var(--r2);font-size:.86rem;display:none}
  .toast.show{display:block;animation:up .3s var(--ease) forwards}
  .toast.ok{background:rgba(125,201,143,.12);border-left:2px solid var(--ok);color:var(--ok)}
  /* 保存提示：浮在底部，不把列表顶下去 */
  #toast2{
    position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%);
    margin:0;padding:.5rem .9rem;font-size:.8rem;z-index:50;
    background:rgba(125,201,143,.16);border:1px solid rgba(125,201,143,.45);color:var(--ok);
    backdrop-filter:blur(6px);
  }
  #toast2.err{background:rgba(255,138,122,.16);border-color:rgba(255,138,122,.5);color:var(--er)}

  /* ── 行内编辑（作者 / 类型）── */
  .edit-a{
    width:100%;margin-top:.25rem;font-size:.78rem;
    background:rgba(0,0,0,.35);color:var(--paper);
    border:1px solid var(--line-soft);border-radius:var(--r1);
    padding:.2rem .4rem;
  }
  .edit-a::placeholder{color:var(--paper-dim);opacity:.75}
  .edit-a:focus,.edit-k:focus{outline:2px solid var(--glow);outline-offset:1px}
  .edit-k{
    font-size:.76rem;padding:.2rem .3rem;border-radius:var(--r1);
    background:rgba(0,0,0,.35);color:var(--paper);border:1px solid var(--line-soft);
  }
  .toast.err{background:rgba(255,138,122,.12);border-left:2px solid var(--er);color:var(--er)}
  .hide{display:none!important}
  .empty{padding:var(--s7) var(--s4);text-align:center;color:var(--paper-dim);
    border:1px dashed var(--line);border-radius:var(--r3)}
  @media (max-width:640px){
    th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}
    td.name{max-width:none}
  }
</style></head>
<body>
<div class="wrap">

  <div class="bar-head reveal" style="animation-delay:.03s">
    <span class="mk"><a href="/">we·books</a></span>
    <a class="back" href="/">← 回到书库</a>
  </div>

  <h1 class="reveal" style="animation-delay:.06s">管理后台</h1>

  <!-- 未登录 -->
  <section class="login reveal" id="loginBox" style="animation-delay:.1s">
    <p>请输入管理口令（<code>ADMIN_TOKEN</code>）。口令只保存在本标签页，关闭即失效，不会写入 Cookie。</p>
    <label for="tok">管理口令</label>
    <input type="password" id="tok" autocomplete="current-password" placeholder="粘贴 ADMIN_TOKEN">
    <div style="margin-top:var(--s4)">
      <button class="btn btn-primary" id="loginBtn">进入</button>
    </div>
    <div class="toast" id="loginMsg"></div>
  </section>

  <!-- 已登录 -->
  <section id="panel" class="hide">
    <h2 style="font-family:var(--serif);font-weight:400;font-size:1rem;letter-spacing:.08em;
               color:var(--paper-dim);margin-bottom:var(--s3)">安全防护状态</h2>
    <div class="sec" id="secGrid"></div>

    <div class="toolbar">
      <input type="text" id="q" placeholder="搜索书名 / 作者 / 文件名">
      <button class="btn" id="searchBtn">搜索</button>
      <button class="btn" id="refreshBtn">刷新</button>
      <button class="btn danger" id="delBtn" disabled>删除选中</button>
      <span class="stat" id="stat"></span>
    </div>

    <div id="listWrap"><div class="empty">加载中…</div></div>
    <div class="toast" id="msg"></div>
    <div class="toast save" id="toast2" role="status" aria-live="polite"></div>
  </section>

</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmtSize = (b) => b < 1024 ? b + ' B'
  : b < 1048576 ? (b/1024).toFixed(1) + ' KB'
  : b < 1073741824 ? (b/1048576).toFixed(1) + ' MB'
  : (b/1073741824).toFixed(2) + ' GB';

let TOKEN = '';
const selected = new Set();

function toast(el, text, ok) {
  el.textContent = text;
  el.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(() => { el.className = 'toast'; }, 6000);
}

async function api(path, init) {
  const res = await fetch(path, Object.assign({}, init, {
    headers: Object.assign(
      { 'authorization': 'Bearer ' + TOKEN },
      (init && init.headers) || {},
    ),
  }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
  return json;
}

function renderSecurity(items) {
  $('secGrid').innerHTML = items.map((s) =>
    '<div class="secitem">' +
      '<span class="dot2 ' + (s.ok ? 'ok' : 'no') + '" aria-hidden="true"></span>' +
      '<span class="sectext">' +
        '<span class="sectitle">' + esc(s.label) + '</span><br>' +
        '<span class="sechint">' + esc(s.hint) + '</span>' +
      '</span>' +
    '</div>').join('');
}

function renderList(data) {  $('stat').innerHTML = '共 <b>' + data.total + '</b> 本 · 占用 <b>' + fmtSize(data.usedBytes) + '</b>';
  if (!data.books.length) {
    $('listWrap').innerHTML = '<div class="empty">'
      + (data.query ? '没有匹配「' + esc(data.query) + '」的书' : '书库还是空的')
      + '</div>';
    return;
  }
  const KIND_LABEL = { ebook: '电子书', comic: '漫画', audio: '有声书' };
  const rows = data.books.map((b) => {
    const kind = b.kind || 'ebook';
    return '<tr>' +
      '<td class="rowsel"><input type="checkbox" data-leaf="' + esc(b.leafName) + '"' +
        (selected.has(b.leafName) ? ' checked' : '') + ' aria-label="选择 ' + esc(b.title) + '"></td>' +
      '<td class="name">' +
        '<div class="t">' + esc(b.title) + '</div>' +
        '<input class="edit-a" data-leaf="' + esc(b.leafName) + '" type="text" ' +
          'value="' + esc(b.author || '') + '" placeholder="（无作者 — 可在此补填）" ' +
          'aria-label="作者：' + esc(b.title) + '">' +
        '<div class="muted">' + esc(b.leafName) + '</div>' +
      '</td>' +
      '<td><span class="pill">' + esc((b.format || '').toUpperCase()) + '</span></td>' +
      '<td>' +
        // 内容嗅探可能有误（PDF 用对象流压缩、图集型 EPUB 等），给人一个改的入口
        '<select class="edit-k" data-leaf="' + esc(b.leafName) + '" aria-label="类型：' + esc(b.title) + '">' +
          Object.keys(KIND_LABEL).map((k) =>
            '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + KIND_LABEL[k] + '</option>',
          ).join('') +
        '</select>' +
      '</td>' +
      '<td class="muted">' + fmtSize(b.size) + '</td>' +
      '<td class="muted">' + esc((b.createdAt || '').slice(0, 10)) + '</td>' +
    '</tr>';
  }).join('');
  $('listWrap').innerHTML =
    '<table><thead><tr>' +
      '<th class="rowsel"><input type="checkbox" id="all" aria-label="全选"></th>' +
      '<th>书名 / 作者（可直接编辑）</th><th>格式</th><th>类型</th><th>大小</th><th>上架日期</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';

  // 作者：失焦或回车时保存
  document.querySelectorAll('input.edit-a').forEach((el) => {
    const save = () => saveEdit(el.dataset.leaf, { author: el.value });
    el.addEventListener('blur', save);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  });
  // 类型：下拉即保存
  document.querySelectorAll('select.edit-k').forEach((el) => {
    el.addEventListener('change', () => saveEdit(el.dataset.leaf, { kind: el.value }));
  });

  $('all').onchange = (e) => {
    document.querySelectorAll('input[data-leaf]').forEach((cb) => {
      cb.checked = e.target.checked;
      if (e.target.checked) selected.add(cb.dataset.leaf); else selected.delete(cb.dataset.leaf);
    });
    syncDel();
  };
  document.querySelectorAll('input[data-leaf]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) selected.add(cb.dataset.leaf); else selected.delete(cb.dataset.leaf);
      syncDel();
    };
  });
  syncDel();
}

function syncDel() {
  const n = selected.size;
  $('delBtn').disabled = n === 0;
  $('delBtn').textContent = n ? '删除选中 (' + n + ')' : '删除选中';
}

async function load() {
  const q = encodeURIComponent($('q').value.trim());
  const data = await api('/api/admin/books?limit=200&q=' + q);
  renderSecurity(data.security || []);
  renderList(data);
}

/**
 * 保存单本书的作者/类型修正。
 * 失败时提示并重新拉列表 —— 不能让人以为改成功了其实没写进去。
 */
async function saveEdit(leafName, patch) {
  try {
    const r = await fetch('/api/admin/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(Object.assign({ leafName: leafName }, patch)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    $('toast2').textContent = '已保存：' + leafName;
    $('toast2').classList.add('show');
    setTimeout(() => $('toast2').classList.remove('show'), 2200);
  } catch (e) {
    $('toast2').textContent = '保存失败：' + e.message;
    $('toast2').classList.add('show', 'err');
    setTimeout(() => $('toast2').classList.remove('show', 'err'), 5000);
    await load();
  }
}

$('loginBtn').onclick = async () => {
  TOKEN = $('tok').value.trim();
  if (!TOKEN) { toast($('loginMsg'), '请输入口令', false); return; }
  try {
    await load();
    sessionStorage.setItem('webooks_admin_token', TOKEN);
    $('loginBox').classList.add('hide');
    $('panel').classList.remove('hide');
  } catch (e) {
    toast($('loginMsg'), '登录失败：' + e.message, false);
    TOKEN = '';
  }
};
$('tok').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

$('refreshBtn').onclick = async () => {
  try { await load(); toast($('msg'), '已刷新', true); }
  catch (e) { toast($('msg'), '刷新失败：' + e.message, false); }
};
$('searchBtn').onclick = async () => {
  try { await load(); } catch (e) { toast($('msg'), '搜索失败：' + e.message, false); }
};
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('searchBtn').click(); });

$('delBtn').onclick = async () => {
  const names = [...selected];
  if (!names.length) return;
  if (!confirm('确定删除这 ' + names.length + ' 本书？此操作不可恢复。')) return;
  $('delBtn').disabled = true;
  try {
    const r = await api('/api/admin/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: names }),
    });
    selected.clear();
    toast($('msg'), '已删除 ' + r.deletedCount + ' 本'
      + (r.missing && r.missing.length ? '，' + r.missing.length + ' 本未找到' : ''), true);
    await load();
  } catch (e) {
    toast($('msg'), '删除失败：' + e.message, false);
    syncDel();
  }
};

// 自动恢复本标签页内的口令，避免刷新就重新登录
(async () => {
  const saved = sessionStorage.getItem('webooks_admin_token');
  if (!saved) return;
  TOKEN = saved;
  try {
    await load();
    $('loginBox').classList.add('hide');
    $('panel').classList.remove('hide');
  } catch {
    TOKEN = '';
    sessionStorage.removeItem('webooks_admin_token');
  }
})();
</script>
</body></html>`;
}
