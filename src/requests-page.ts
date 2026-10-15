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
 *   · ⚠️ 样式**全部**来自 lib/theme.ts，不再自造一套。
 *     上一版这里自成体系（自造 .wrap/header/panel/button/输入框、
 *     19 个硬编码圆角、max-width 960px），结果是这个页面看起来
 *     像另一个产品 —— 而它和首页、浏览页是同一个站。
 *   · 数字「N 人求」不做成 badge/药丸：那会让每个条目都变成一颗
 *     徽章，而「有多少人在求」是辅助信息。改用右对齐的数字，
 *     与首页的上传者榜单同一套「记录行」语言。
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
<link rel="icon" href="/favicon.ico" sizes="32x32">
<title>求书墙 · webooks</title>
<style>${themeCss()}

  /* ── 页头：与其余页面统一用 .bar-head（见 browse/upload/admin）── */
  .bar-head{display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;margin-bottom:var(--s5)}
  .mk{font-family:var(--serif);font-size:1.05rem;letter-spacing:.3em;color:var(--glow)}
  .mk a{color:inherit;text-decoration:none}
  .back{margin-left:auto;font-size:.8rem;font-family:var(--serif);letter-spacing:.08em}

  h1{
    font-family:var(--serif);font-weight:400;
    font-size:clamp(1.6rem,4.5vw,2.2rem);letter-spacing:.03em;
    margin-bottom:var(--s3);
  }
  .lede{color:var(--paper-dim);max-width:38rem;line-height:1.8;margin-bottom:var(--s5)}

  /* ── 提交表单 ── */
  /* 用下划线而不是方框：这是页面上唯一的输入区，
     做成「写在纸上的两行」比做成卡片更轻，也符合书库的语气。 */
  .ask{border-top:1px solid var(--line);padding-top:var(--s4);margin-bottom:var(--s6)}
  form{
    display:grid;gap:var(--s3);align-items:end;
    grid-template-columns:minmax(0,2fr) minmax(0,1.4fr) auto;
  }
  @media(max-width:640px){form{grid-template-columns:1fr}}
  label{display:block;font-size:.8rem;color:var(--paper-dim);margin-bottom:var(--s2);letter-spacing:.04em}
  /* 不写「（必填）」「（不知道可以不填）」这类括号补充 ——
     第一个是 placeholder 里的示例，第二个用 optional 表达更轻。
     必填由 required 属性表达，不需要文案重复一遍。 */
  .opt{opacity:.6}
  input[type=text]{
    width:100%;padding:.7rem .2rem;font:inherit;font-size:1rem;color:var(--paper);
    background:transparent;
    border:0;border-bottom:1px solid var(--line-soft);
    border-radius:0;
    transition:border-color var(--dur) var(--ease);
  }
  input[type=text]::placeholder{color:var(--paper-dim);opacity:.55}
  input[type=text]:hover{border-bottom-color:var(--line)}
  input[type=text]:focus{outline:none;border-bottom-color:var(--glow)}
  /* 键盘焦点必须有可见形态 —— 下划线变琥珀 + 上方留出描边空间 */
  input[type=text]:focus-visible{outline:2px solid var(--glow);outline-offset:6px}

  /* ── 消息 ── */
  .msg{margin-top:var(--s4);font-size:.88rem;min-height:1.2em;line-height:1.6}
  .msg.ok{color:var(--ok)}
  .msg.err{color:var(--er)}
  .msg.info{color:var(--paper-dim)}

  /* ── 求书清单 ── */
  .wall-head{
    display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;
    border-top:1px solid var(--line);padding-top:var(--s4);
    margin-bottom:var(--s3);
  }
  .wall-head h2{
    font-family:var(--serif);font-weight:400;font-size:1.1rem;
    letter-spacing:.1em;margin:0;color:var(--paper);
  }
  .count{font-size:.8rem;color:var(--paper-dim);font-family:var(--serif);letter-spacing:.06em}
  .more{
    margin-left:auto;font-size:.82rem;color:var(--glow);
    background:none;border:0;padding:0;cursor:pointer;
    min-height:44px; /* 触控目标 */
  }
  .more:hover{color:var(--glow-bright)}

  /* 记录行：横线分隔的密集列表，与首页榜单同一套语言。
     刻意**不做成卡片** —— 每条一个圆角方框会让页面变成 SaaS 列表。 */
  ul{list-style:none;padding:0;margin:0}
  li.rq{
    display:flex;align-items:baseline;gap:var(--s3);
    padding:var(--s3) 0;
    border-bottom:1px solid var(--line-soft);
    opacity:0;animation:up .45s var(--ease) forwards;
  }
  /* 书名：衬线，与书库里的书名同族 */
  .rtitle{font-family:var(--serif);font-size:1.05rem;letter-spacing:.02em;color:var(--paper);line-height:1.4}
  /* 作者是补充信息，用次要色，不加「· 」前缀（那是 meta 串的模板腔） */
  .rauthor{font-size:.85rem;color:var(--paper-dim);margin-left:var(--s2)}
  .rwhen{font-size:.78rem;color:var(--paper-dim);white-space:nowrap;margin-left:auto;font-variant-numeric:tabular-nums}
  /* 「N 人求」用琥珀 —— 这是这一行里唯一值得被注意的信息 */
  .rhits{
    font-family:var(--mono);font-size:.78rem;color:var(--glow);
    white-space:nowrap;min-width:4.5em;text-align:right;
    font-variant-numeric:tabular-nums;
  }

  /* 空状态：说明「为什么空」并给出下一步 */
  .empty{
    padding:var(--s6) var(--s4);text-align:center;
    border:1px dashed var(--line-soft);border-radius:var(--r1);
    color:var(--paper-dim);line-height:1.9;
  }
  .empty b{font-family:var(--serif);color:var(--paper);font-weight:400;font-size:1.05rem;letter-spacing:.04em}
  .empty a{color:var(--glow)}

  @media(prefers-reduced-motion:reduce){
    li.rq{animation:none!important;opacity:1!important}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="bar-head reveal" style="animation-delay:.03s">
    <span class="mk"><a href="/">we·books</a></span>
    <a class="back" href="/">← 回到首页</a>
  </div>

  <h1 class="reveal" style="animation-delay:.08s">找不到想看的书</h1>
  <p class="lede reveal" style="animation-delay:.12s">
    写下书名，它会出现在下面的清单里。有人手上有这本就会来上传 ——
    上架之后管理员会把它从清单里划掉。同一本书会合并成一条，求的人越多越靠前。
  </p>

  <section class="ask reveal" style="animation-delay:.16s">
    <form id="f">
      <div>
        <label for="title">书名</label>
        <input type="text" id="title" name="title" required maxlength="120"
               placeholder="例如：三体" autocomplete="off">
      </div>
      <div>
        <label for="author">作者 <span class="opt">（不知道可以不填）</span></label>
        <input type="text" id="author" name="author" maxlength="80"
               placeholder="例如：刘慈欣" autocomplete="off">
      </div>
      <button class="btn btn-primary" type="submit" id="btn">挂上去</button>
    </form>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </section>

  <section class="wall">
    <div class="wall-head reveal" style="animation-delay:.2s">
      <h2>正在找的书</h2>
      <span class="count" id="count"></span>
      <button class="more" id="more" hidden>看更多</button>
    </div>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>
      <b>清单还是空的</b><br>
      上面写第一本 —— 有书的人看到就会传上来。
    </div>
  </section>

  <footer class="site-foot reveal" style="animation-delay:.5s">
    <span class="lamps" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>webooks · 匿名开放 · 无需注册</span>
    <a href="/">首页</a>
    <a href="/upload">我也传一本</a>
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

  // ⚠️ 这里刻意**没有** esc() 函数 —— 渲染一律用 textContent。
  //   上一版用 innerHTML + esc() 拼字符串，那是「需要记得调用」的防线；
  //   忘了调用就是 XSS。textContent 天然免疫，少一个能忘的东西。
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
    rows.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'rq';
      // 逐条浮现，但延迟封顶 —— 50 条各自 delay 会让最后一条等太久
      li.style.animationDelay = Math.min(i * 0.02, 0.4) + 's';

      // ⚠️ 求书内容是匿名提交的，**必须**转义。
      //   这里用 textContent 而不是 innerHTML —— 天然免疫，
      //   比「记得调 esc()」可靠得多。
      var title = document.createElement('span');
      title.className = 'rtitle';
      title.textContent = r.title;
      li.appendChild(title);

      if (r.author) {
        var author = document.createElement('span');
        author.className = 'rauthor';
        author.textContent = r.author;
        li.appendChild(author);
      }

      var when = document.createElement('span');
      when.className = 'rwhen';
      when.textContent = relTime(r.lastAt);
      li.appendChild(when);

      var hits = document.createElement('span');
      hits.className = 'rhits';
      // 单人求的时候「1 人求」是废话，直接写「1」
      hits.textContent = r.hits > 1 ? r.hits + ' 人求' : '1';
      hits.title = r.hits > 1 ? r.hits + ' 人在求这本书' : '有 1 人在求这本书';
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