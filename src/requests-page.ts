/**
 * 求书墙（/requests）—— 「还缺什么书」的公开清单。
 *
 * 为什么要有这个页面：
 *   公共书库最大的问题是「想找的书没有」。但让人私下联系上传者
 *   既不现实也不安全。公开的求书墙把需求显性化，也让上传者
 *   知道「该传什么」—— 这是书库从「谁传了什么」变成「大家需要什么」
 *   的关键一步。
 *
 * 设计取舍：
 *   · 页面本身静态（零依赖、内联 CSS/JS），列表用 fetch 拿 ——
 *     这样新增一条求书不需要重新生成 HTML，且列表可以分页
 *   · 表单用原生 fetch 提交，不刷新页面；提交后局部刷新列表
 *   · 沿用 lib/theme 的设计 token，与首页/上传页同一套视觉语言
 *
 * 数据来自 /api/requests（见 src/api/requests.ts）。
 */

import { themeCss } from './lib/theme';

export function requestsHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>求书墙 · webooks</title>
<link rel="stylesheet" href="data:text/css,">
<style>${themeCss()}

.wrap{max-width:960px;margin:0 auto;padding:0 20px 72px}
header{display:flex;align-items:baseline;gap:14px;padding:28px 0 8px;flex-wrap:wrap}
.mark{font-family:var(--serif);font-size:20px;letter-spacing:.06em;color:var(--glow)}
.tag{font-size:12px;color:var(--paper-dim);letter-spacing:.14em;text-transform:uppercase}
.est{margin-left:auto;font-size:12px;color:var(--paper-dim)}
.hero h1{font-family:var(--serif);font-size:34px;line-height:1.25;margin:18px 0 10px}
.hero p{color:var(--paper-dim);max-width:60ch;line-height:1.7;margin:0 0 4px}

.panel{
  margin-top:26px;padding:20px;border:1px solid var(--line-soft);
  border-radius:12px;background:var(--ink-2);
}
.panel h2{font-family:var(--serif);font-size:18px;margin:0 0 4px}
.panel .hint{color:var(--paper-dim);font-size:13px;margin:0 0 16px;line-height:1.6}

form{display:grid;gap:12px;grid-template-columns:1fr 1fr auto;align-items:end}
@media(max-width:640px){form{grid-template-columns:1fr}}
label{display:block;font-size:12px;color:var(--paper-dim);margin-bottom:6px;letter-spacing:.04em}
input{
  width:100%;padding:11px 13px;font:inherit;font-size:15px;color:var(--paper);
  background:var(--ink);border:1px solid var(--line-soft);border-radius:8px;
}
input:focus{outline:2px solid var(--glow);outline-offset:1px;border-color:transparent}
button{
  padding:11px 22px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;
  color:var(--ink);background:var(--glow);border:0;border-radius:8px;white-space:nowrap;
}
button:hover{background:#ffc76b}
button[disabled]{opacity:.55;cursor:default}

.msg{margin-top:12px;font-size:14px;min-height:20px;line-height:1.6}
.msg.ok{color:#8fd694}
.msg.err{color:#ff9d8a}
.msg.info{color:var(--paper-dim)}

.wall{margin-top:34px}
.wall-head{display:flex;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.wall-head h2{font-family:var(--serif);font-size:20px;margin:0}
.count{color:var(--paper-dim);font-size:13px}
.more{margin-left:auto;font-size:13px;color:var(--glow);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}

ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
li{
  display:flex;align-items:center;gap:14px;padding:13px 16px;
  border:1px solid var(--line-soft);border-radius:10px;background:var(--ink-2);
}
.rtitle{font-size:16px;color:var(--paper);font-weight:600}
.rauthor{font-size:13px;color:var(--paper-dim)}
.rauthor::before{content:"· "}
.rhits{
  margin-left:auto;font-size:12px;color:var(--glow);white-space:nowrap;
  border:1px solid var(--line-soft);border-radius:999px;padding:3px 11px;
}
.rwhen{font-size:12px;color:var(--paper-dim);white-space:nowrap}
.empty{color:var(--paper-dim);padding:28px;text-align:center;border:1px dashed var(--line-soft);border-radius:10px}

.site-foot{margin-top:44px;padding-top:18px;border-top:1px solid var(--line-soft);
  font-size:12px;color:var(--paper-dim);display:flex;gap:16px;flex-wrap:wrap}
.site-foot a{color:var(--paper-dim)}
@media(prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="mark"><b>we·books</b></div>
    <div class="tag">request wall</div>
    <div class="est">免注册 · 匿名</div>
  </header>

  <section class="hero">
    <h1>找不到想看的书？<br>挂在这里</h1>
    <p>写下书名（作者知道就一起写），它会出现在下面的清单里。
       有人手上有这本就会来上传 —— 上架之后管理员会把它从清单里划掉。</p>
  </section>

  <section class="panel">
    <h2>求一本书</h2>
    <p class="hint">不需要注册。同一本书会合并成一条，人数越多越靠前。</p>
    <form id="f">
      <div>
        <label for="title">书名（必填）</label>
        <input id="title" name="title" required maxlength="120"
               placeholder="例如：三体" autocomplete="off">
      </div>
      <div>
        <label for="author">作者（不知道可以不填）</label>
        <input id="author" name="author" maxlength="80"
               placeholder="例如：刘慈欣" autocomplete="off">
      </div>
      <button type="submit" id="btn">挂上去</button>
    </form>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </section>

  <section class="wall">
    <div class="wall-head">
      <h2>正在找的书</h2>
      <span class="count" id="count"></span>
      <button class="more" id="more" hidden>看更多 →</button>
    </div>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>还没有人求书 —— 上面写第一本？</div>
  </section>

  <footer class="site-foot">
    <a href="/">首页</a>
    <a href="/upload">我也传一本</a>
    <span style="margin-left:auto">webooks · 匿名开放书库</span>
  </footer>

</div>

<script>
(function(){
  "use strict";
  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var countEl = document.getElementById('count');
  var moreEl  = document.getElementById('more');
  var msgEl   = document.getElementById('msg');
  var form    = document.getElementById('f');
  var btn     = document.getElementById('btn');
  var shown   = 0;

  // XSS 防线：所有来自接口的文本都过这一道。
  // 求书内容是匿名提交的，绝不能直接拼进 innerHTML。
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function relTime(iso){
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s/60) + ' 分钟前';
    if (s < 86400) return Math.floor(s/3600) + ' 小时前';
    if (s < 86400*30) return Math.floor(s/86400) + ' 天前';
    return iso.slice(0,10);
  }

  function render(rows, append){
    if (!append) listEl.innerHTML = '';
    var frag = document.createDocumentFragment();
    rows.forEach(function(r){
      var li = document.createElement('li');
      var left = document.createElement('div');
      left.innerHTML =
        '<div class="rtitle">' + esc(r.title) + '</div>' +
        (r.author ? '<div class="rauthor">' + esc(r.author) + '</div>' : '');
      var when = document.createElement('span');
      when.className = 'rwhen';
      when.textContent = relTime(r.lastAt);
      var hits = document.createElement('span');
      hits.className = 'rhits';
      hits.textContent = r.hits + ' 人求';
      li.appendChild(left);
      li.appendChild(when);
      li.appendChild(hits);
      frag.appendChild(li);
    });
    listEl.appendChild(frag);
  }

  function load(append){
    var url = '/api/requests?limit=50' + (append ? '&offset=' + shown : '');
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.error) throw new Error(d.error);
        shown += (d.requests || []).length;
        render(d.requests || [], append);
        countEl.textContent = d.total ? '共 ' + d.total + ' 本' : '';
        emptyEl.hidden = (d.requests || []).length > 0 || shown > 0;
        moreEl.hidden = shown >= (d.total || 0);
      })
      .catch(function(){
        msgEl.className = 'msg err';
        msgEl.textContent = '加载失败，请刷新页面重试';
      });
  }

  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var title = document.getElementById('title').value.trim();
    if (!title) return;
    btn.disabled = true;
    msgEl.className = 'msg';
    msgEl.textContent = '提交中…';

    fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title, author: document.getElementById('author').value.trim() })
    })
      .then(function(r){ return r.json().then(function(d){ return { status: r.status, body: d }; }); })
      .then(function(res){
        btn.disabled = false;
        if (res.body.error) {
          msgEl.className = 'msg err';
          msgEl.textContent = res.body.message || '提交失败';
          return;
        }
        msgEl.className = res.status === 201 ? 'msg ok' : 'msg info';
        msgEl.textContent = res.body.message || '已经记下了';
        form.reset();
        document.getElementById('title').focus();
        shown = 0;
        listEl.innerHTML = '';
        load(false);
      })
      .catch(function(){
        btn.disabled = false;
        msgEl.className = 'msg err';
        msgEl.textContent = '网络错误，请再试一次';
      });
  });

  moreEl.addEventListener('click', function(){ load(true); });

  load(false);
})();
</script>
</body>
</html>`;
}