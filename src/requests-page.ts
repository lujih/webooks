/**
 * 求书墙（/requests）—— 「还缺什么书」的公开清单。
 *
 * 为什么要有这个页面：
 *   公共书库最大的问题是「想找的书没有」。但让人私下联系上传者
 *   既不现实也不安全。公开的求书墙把需求显性化，也让上传者
 *   知道「该传什么」—— 这是书库从「谁传了什么」变成「大家需要什么」
 *   的关键一步。
 *
 * ── 版面：这是一本**登记簿**，不是一张表单 + 一个列表 ──
 *
 * 全站的身份是「目录页 / 借阅登记簿」：编号、纸色细线、右对齐的
 * 等宽数字列。这个页面把那一套语言推到最前面 ——
 *
 *   · 写下来：两行下划线字段 + 一颗按钮，像在登记簿上添一行；
 *   · 正在找的书：每行一个行号、书名、作者、时间，最右是**求的人数**。
 *     行号是真实的序号，不是装饰 —— 它让「第 14 个人在求这本书」读起来
 *     像一条记录，而不是一张卡片。
 *
 * 「N 人求」不做成徽章/药丸：那会让每行都变成一颗徽章，而求的人数是
 * 辅助信息，右对齐的数字列就够了。
 *
 * ⚠️ 上一版这里有一处隐形的坏味道：列表行写了 `opacity:0` +
 *   `animation:up .45s forwards`，而 `up` 这组 keyframes 在改版后的
 *   theme 里已经不存在了 —— 动画不会运行，`forwards` 也就不生效，
 *   于是 `opacity:0` **永久生效**，整张清单是隐形的。
 *   现在没有入场动画：静态页面就该立刻可读。
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
<style>
${themeCss()}

  /* ── 写下来 ── */
  .ask{border-top:1px solid var(--rule-strong);padding-top:var(--s4);margin:var(--s6) 0 var(--s8)}
  form{
    display:grid;gap:var(--s3) var(--s4);align-items:end;
    grid-template-columns:minmax(0,1.7fr) minmax(0,1.1fr) auto;
  }
  .field{display:flex;flex-direction:column;gap:var(--s1);min-width:0}
  label{font-size:var(--fz-sm);color:var(--paper-dim);letter-spacing:.04em}
  /* 不写「（必填）」「（不知道可以不填）」这类括号补充 ——
     前者由 required 属性表达，后者用「可留空」三个字更轻。 */
  .opt{color:var(--paper-faint)}
  input[type=text]{
    width:100%;min-height:44px;padding:.5rem 0;
    font:inherit;font-size:1rem;color:var(--paper);
    background:transparent;border:0;border-radius:0;
    border-bottom:1px solid var(--edge);
    transition:border-bottom-color var(--dur) var(--ease);
  }
  input[type=text]:hover{border-bottom-color:var(--brass)}
  input[type=text]:focus{outline:none;border-bottom-color:var(--brass)}
  /* 键盘焦点必须有可见形态，不能只改下划线颜色 */
  input[type=text]:focus-visible{outline:2px solid var(--brass);outline-offset:4px}
  form .btn{align-self:end}

  /* ── 消息 ── */
  .msg{margin-top:var(--s3);font-size:var(--fz-sm);line-height:1.7;min-height:1.4em}
  .msg.ok{color:var(--ok)}
  .msg.err{color:var(--er)}
  .msg.info{color:var(--paper-dim)}

  /* ── 清单 ── */
  .wall-head{
    display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;
    padding-bottom:var(--s2);border-bottom:1px solid var(--rule-strong);
  }
  .wall-head h2{
    font-family:var(--serif);font-weight:400;font-size:.95rem;
    letter-spacing:.12em;color:var(--paper-dim);
  }
  .count{font-size:var(--fz-xs);color:var(--paper-faint);font-variant-numeric:tabular-nums}
  /* 「看更多」是交互元素，所以用黄铜；它足够小，不抢主按钮 */
  .more{
    margin-left:auto;display:inline-flex;align-items:center;
    min-height:44px;padding:0;font:inherit;font-size:var(--fz-sm);
    color:var(--brass);background:none;border:0;cursor:pointer;
    /* 下划线用 text-decoration：它附着在文字上，
       而 min-height:44px 撑高的盒子若用 border-bottom，
       那条线会飘在文字下方二十像素处。 */
    text-decoration:underline;text-decoration-color:transparent;
    text-underline-offset:.34em;text-decoration-thickness:1px;
  }
  .more:hover{color:var(--brass-lift);text-decoration-color:var(--edge-warm)}

  ul{list-style:none}
  /* 一行 = 一条登记。行号是真实序号，不是装饰。 */
  li.rq{
    display:grid;grid-template-columns:2.4rem minmax(0,1fr) auto auto;
    align-items:baseline;gap:var(--s2) var(--s4);
    padding:.66rem 0;border-bottom:1px solid var(--rule);
  }
  .rn{
    font-family:var(--mono);font-size:.72rem;color:var(--paper-faint);
    font-variant-numeric:tabular-nums;letter-spacing:.04em;
  }
  .rmain{min-width:0}
  /* 书名：衬线，与书库里的书名同族 */
  .rtitle{font-family:var(--serif);font-size:1.02rem;letter-spacing:.01em;color:var(--paper);line-height:1.45;word-break:break-word}
  /* 作者是补充信息，用次要色，不加「· 」前缀（那是 meta 串的模板腔） */
  .rauthor{font-size:var(--fz-sm);color:var(--paper-dim);margin-left:var(--s2)}
  .rwhen{
    font-family:var(--mono);font-size:.72rem;color:var(--paper-faint);
    white-space:nowrap;font-variant-numeric:tabular-nums;
  }
  /* 「N 人求」是这一行里唯一值得被注意的信息 —— 也是全页唯一的黄铜数字 */
  .rhits{
    font-family:var(--mono);font-size:.78rem;color:var(--brass);
    white-space:nowrap;min-width:4.6em;text-align:right;
    font-variant-numeric:tabular-nums;
  }

  /* 空状态：说明「为什么空」并给出下一步 */
  .empty{margin-top:var(--s6)}
  .empty a{color:var(--brass)}

  /* ── 响应式：手机上把行号让给「时间」一行 ── */
  @media (max-width:640px){
    form{grid-template-columns:1fr;gap:var(--s3)}
    form .btn{width:100%}
    .ask{margin-bottom:var(--s7)}
  }
  @media (max-width:560px){
    li.rq{grid-template-columns:minmax(0,1fr) auto;gap:2px var(--s3);padding:.6rem 0}
    .rn{display:none}
    .rmain{grid-column:1;grid-row:1}
    .rhits{grid-column:2;grid-row:1}
    .rwhen{grid-column:1;grid-row:2}
    .rauthor{display:inline;margin-left:.5em}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="bar-head">
    <span class="mk"><a href="/">we·books</a></span>
    <a class="back" href="/">回到书库</a>
  </div>

  <h1>找不到想看的书</h1>
  <p class="lede">
    写下书名，它会出现在下面的清单里。有人手上有这本就会来上传 ——
    上架之后管理员会把它从清单里划掉。同一本书合并成一条，求的人越多越靠前。
  </p>

  <section class="ask">
    <form id="f">
      <div class="field">
        <label for="title">书名</label>
        <input type="text" id="title" name="title" required maxlength="120"
               placeholder="例如：三体" autocomplete="off">
      </div>
      <div class="field">
        <label for="author">作者 <span class="opt">可留空</span></label>
        <input type="text" id="author" name="author" maxlength="80"
               placeholder="例如：刘慈欣" autocomplete="off">
      </div>
      <button class="btn btn-primary" type="submit" id="btn">挂上去</button>
    </form>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </section>

  <section class="wall">
    <div class="wall-head">
      <h2>正在找的书</h2>
      <span class="count" id="count"></span>
      <button class="more" id="more" hidden>看更多</button>
    </div>
    <ul id="list"></ul>
    <div class="empty" id="empty" hidden>
      <b>清单还是空的</b>
      <span>上面写第一本 —— 有书的人看到就会传上来。</span>
    </div>
  </section>

  <footer class="site-foot">
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
    if (!append) listEl.textContent = '';
    var frag = document.createDocumentFragment();
    var base = append ? shown - rows.length : 0;
    rows.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'rq';

      // 行号：登记簿上的序号。它不是装饰 —— 它让「第几条」可被指认。
      var n = document.createElement('span');
      n.className = 'rn';
      n.textContent = String(base + i + 1).padStart(2, '0');
      li.appendChild(n);

      var main = document.createElement('span');
      main.className = 'rmain';

      // ⚠️ 求书内容是匿名提交的，**必须**转义。
      //   这里用 textContent 而不是 innerHTML —— 天然免疫，
      //   比「记得调 esc()」可靠得多。
      var title = document.createElement('span');
      title.className = 'rtitle';
      title.textContent = r.title;
      main.appendChild(title);

      if (r.author) {
        var author = document.createElement('span');
        author.className = 'rauthor';
        author.textContent = r.author;
        main.appendChild(author);
      }
      li.appendChild(main);

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
        listEl.textContent = '';
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
