/**
 * 网站首页（/）—— 公共电子书库入口。
 *
 * 设计方向：「深夜图书馆」—— 墨色纸页质感 + 琥珀色烛光强调色。
 * 不是通用 SaaS 模板，而是让访客一打开就像走进一间 24 小时亮着灯的书店：
 *   · 暖黑背景 + 纸张噪点纹理（纯 CSS，无图片）
 *   · 衬线展示字（宋体栈）配无衬线正文
 *   · 四组馆藏入口做成"书脊"卡片，悬停时微微"抽出"
 *   · 上传按钮做成"借书登记"的印章样式
 *   · 页面载入时逐行浮现（staggered reveal）
 *
 * 纯静态、零依赖、内联 CSS/JS，由 Worker 直接吐出（与 upload-page 同一模式）。
 * 所有链接指向 WebDAV 目录树与上传页，保持与后端路由一致。
 */

import { themeCss } from './lib/theme';
import { collectionSegment, type CollectionId } from './lib/collections';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export function indexHtml(mountPath: string, r2PublicBase: string | null): string {
  const mount = `${mountPath}/`;
  // 集合路径段用中文：WebDAV 客户端与浏览器都以「路径末段」作为文件夹显示名，
  // 所以想让它们显示中文，路径本身就必须是中文（displayname 属性很多客户端不读）。
  const seg = (id: CollectionId) => encodeURIComponent(collectionSegment(id));
  const shelves = [
    { path: `${mount}${seg('recent')}/`, title: '最近收录', sub: '新上架的书 · 倒序', icon: '新' },
    { path: `${mount}${seg('type')}/`, title: '按类型', sub: '电子书 / 漫画', icon: '类' },
    { path: `${mount}${seg('title')}/`, title: '按书名', sub: '中文按拼音 · 英文按字母', icon: '名' },
    { path: `${mount}${seg('author')}/`, title: '按作者', sub: '寻找同一位作者', icon: '著' },
    { path: `${mount}${seg('format')}/`, title: '按格式', sub: 'EPUB / PDF / CBZ…', icon: '式' },
  ];
  const shelfHtml = shelves
    .map((s, i) => {
      return `
  <a class="shelf" style="--i:${i}" href="${s.path}">
    <span class="spine" aria-hidden="true">${s.icon}</span>
    <span class="sbody">
      <span class="stitle">${s.title}</span>
      <span class="ssub">${s.sub}</span>
    </span>
    <span class="arrow" aria-hidden="true">→</span>
  </a>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- 显式声明图标：不声明时浏览器会自己去请求 /favicon.ico，
     而那个路径在加静态资源之前是个 404 —— 每次页面浏览都白花一次 Worker 请求。
     现在它是 public/favicon.ico，由静态资源层直接应答，不计入请求配额。 -->
<link rel="icon" href="/favicon.ico" sizes="32x32">
<title>webooks · 公共电子书库</title>
<meta name="description" content="webooks —— 架在 Cloudflare Workers Free + R2 上的开放 WebDAV 电子书库。任何人都可以上传、浏览、下载。">
<style>
${themeCss()}
  /* 顶栏：与其余页面统一用 .bar-head（browse / upload / admin / requests）
     —— 上一版这里自成一套 .mark/.tag/.est，导致同一站点有两种页头。 */
  .bar-head{display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;margin-bottom:var(--s5)}
  .mk{font-family:var(--serif);font-size:1.05rem;letter-spacing:.3em;color:var(--glow)}
  .mk a{color:inherit;text-decoration:none}
  /* 站点的一句自我说明，不是 eyebrow 标签。
     刻意**不加** uppercase + 大 letter-spacing ——
     那是模板腔（每个标题上面都顶一个 ALL-CAPS 小标签）。 */
  .tag{font-size:.82rem;color:var(--paper-dim)}
  .back{margin-left:auto;font-size:.8rem;font-family:var(--serif);letter-spacing:.08em}

  /* ── 首屏那张「活书脊」──
     全页唯一的记忆点。它的高度（约 120px）刻意略大于 h1，
     但字号更小 —— 用面积而不是字号来建立优先级，这样 h1 仍是标题。

     书脊用纯 CSS 画：一道 8px 宽的竖条 + 上下两道细边。
     不画完整书封 —— 那是浏览页的活（那里有真实封面）。 */
  .fresh{
    display:flex;align-items:stretch;gap:var(--s4);
    max-width:34rem;margin:var(--s5) 0 0;
    padding:var(--s3) var(--s4) var(--s3) var(--s3);
    text-decoration:none;color:var(--paper);
    border:1px solid var(--line-soft);
    border-radius:var(--r1);
    background:linear-gradient(100deg,rgba(255,180,77,.05) 0%,transparent 55%);
    position:relative;overflow:hidden;
    opacity:0;animation:up .7s var(--ease) forwards;
    transition:border-color var(--dur) var(--ease),background var(--dur) var(--ease);
  }
  .fresh:hover,.fresh:focus-visible{
    border-color:var(--line);background:linear-gradient(100deg,rgba(255,180,77,.1) 0%,transparent 60%);
    text-decoration:none;color:var(--paper);
  }
  /* 书脊：一条实心竖条，上下留出装订线的细边 */
  .freshspine{
    flex:0 0 auto;width:8px;border-radius:2px;
    background:linear-gradient(180deg,var(--glow) 0%,var(--glow-deep) 100%);
    box-shadow:0 0 14px rgba(255,180,77,.35);
  }
  .freshbody{display:flex;flex-direction:column;gap:.2rem;min-width:0}
  /* 「最近上架」是这条信息的**类别**，不是标题 —— 用最小号的次要色，
     不用 eyebrow 标签的全大写+大字距那套模板腔。 */
  .freshlabel{font-size:.72rem;color:var(--paper-dim);letter-spacing:.14em}
  .freshtitle{
    font-family:var(--serif);font-size:1.35rem;letter-spacing:.02em;
    line-height:1.3;word-break:break-word;
  }
  .freshmeta{font-size:.8rem;color:var(--paper-dim);font-variant-numeric:tabular-nums}

  /* ── 主标题 ── */
  .hero{margin:3rem 0 1rem}
  .hero h1{
    font-family:var(--serif);
    font-weight:400;
    font-size:clamp(2.6rem,7vw,4.4rem);
    line-height:1.05;
    letter-spacing:.02em;
    color:var(--paper);
  }
  /* ⚠️ 这里刻意**没有**「只给一个词上色」的规则。
     「一间<span class=glow>不熄灯</span>的公共书库」是最典型的模板腔 ——
     加粗一个词/短语来制造强调。中文标题靠**字号与留白**建立层级就够了。 */
  .hero p{margin-top:1.1rem;max-width:34rem;color:var(--paper-dim);font-size:1rem;line-height:1.85}
  .hero p b{color:var(--paper);font-weight:600}

  /* ── 印章按钮 ── */
  .cta{display:flex;gap:.8rem;margin:2rem 0 .5rem;flex-wrap:wrap}
  .seal{
    display:inline-flex;align-items:center;gap:.6rem;
    font-family:var(--serif);font-size:1.02rem;letter-spacing:.14em;
    color:var(--ink);background:var(--glow);
    padding:.85rem 1.5rem .8rem;
    border-radius:2px;
    text-decoration:none;
    box-shadow:0 0 0 1px var(--glow-deep),0 6px 24px rgba(255,150,40,.28);
    transform:rotate(-1.2deg);
    transition:transform .18s ease,box-shadow .18s ease,background .18s ease;
    position:relative;
  }
  .seal::after{content:"";position:absolute;inset:3px;border:1px solid rgba(20,15,10,.35);border-radius:1px;pointer-events:none}
  .seal:hover{transform:rotate(0deg) translateY(-2px);background:var(--glow-bright);box-shadow:0 0 0 1px var(--glow-deep),0 10px 34px rgba(255,150,40,.42)}
  .seal .dot{width:7px;height:7px;border-radius:50%;background:var(--ink);opacity:.7}
  .ghost{
    display:inline-flex;align-items:center;gap:.5rem;
    font-family:var(--serif);letter-spacing:.14em;font-size:1rem;
    color:var(--glow);text-decoration:none;
    padding:.85rem 1.3rem;border-radius:2px;
    border:1px solid var(--line);
    transition:border-color .18s ease,background .18s ease,letter-spacing .18s ease;
  }
  .ghost:hover{border-color:var(--glow);background:rgba(255,180,77,.07);letter-spacing:.2em}

  /* ── 书架区 ── */
  .shelves{
    margin:3rem 0 1rem;
    display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.9rem;
  }
  .shelf{
    display:flex;align-items:center;gap:.95rem;
    padding:1.15rem 1.2rem 1.1rem 1.05rem;
    background:linear-gradient(160deg,var(--ink2) 0%,#120f0c 100%);
    border:1px solid rgba(255,180,77,.1);
    border-radius:4px;
    text-decoration:none;color:var(--paper);
    position:relative;
    opacity:0;transform:translateY(16px);
    animation:up .7s cubic-bezier(.2,.7,.2,1) forwards;
    animation-delay:calc(.25s + var(--i)*.12s);
    transition:transform .2s ease,border-color .2s ease,background .2s ease;
    overflow:hidden;
  }
  .shelf::before{ /* 烛光扫过 */
    content:"";position:absolute;inset:0;
    background:linear-gradient(105deg,transparent 30%,rgba(255,190,90,.10) 50%,transparent 70%);
    transform:translateX(-120%);transition:transform .6s ease;pointer-events:none;
  }
  .shelf:hover{transform:translateY(-4px) rotate(-.3deg);border-color:var(--glow);background:linear-gradient(160deg,#221c15 0%,#161209 100%)}
  .shelf:hover::before{transform:translateX(120%)}
  .spine{
    flex:0 0 auto;
    width:46px;height:64px;border-radius:3px 6px 6px 3px;
    background:linear-gradient(90deg,#3a2e1f 0%,#5a4326 55%,#3a2e1f 100%);
    display:flex;align-items:center;justify-content:center;
    font-family:var(--serif);font-size:1.5rem;color:var(--glow);
    box-shadow:inset -3px 0 6px rgba(0,0,0,.5),2px 3px 8px rgba(0,0,0,.4);
    border-left:2px solid rgba(255,180,77,.4);
  }
  .sbody{display:flex;flex-direction:column;gap:.28rem;min-width:0}
  .stitle{font-family:var(--serif);font-size:1.12rem;letter-spacing:.06em}
  .ssub{font-size:.8rem;color:var(--paper-dim);letter-spacing:.02em}
  .arrow{margin-left:auto;color:var(--glow);font-size:1.1rem;opacity:0;transform:translateX(-6px);transition:.2s}
  .shelf:hover .arrow{opacity:1;transform:none}

  /* ── 上传者榜单 ──
     位置：书架之后、使用方式之前。
     「去哪找书」（功能导航）→ 「谁在维护这个库」（社区信号）→ 「怎么连」（技术说明）

     视觉：借阅卡。图书馆借书卡上是一行行手写/打印的借阅记录，
     这里用横线分隔的密集行，而不是一排圆角卡片 ——
     卡片是 SaaS 的默认语汇，而借阅卡是这个场景本来的东西。

     克制：颜色只用纸色，琥珀只用在「本数」上（那是唯一值得强调的数字）。
     榜单是配角，不能和书架抢注意力。 */
  .roll{margin:3rem 0 0;padding-top:1.5rem;border-top:1px solid var(--line)}
  .roll-head{display:flex;align-items:baseline;gap:.7rem;flex-wrap:wrap;margin-bottom:1rem}
  .roll-head h2{
    font-family:var(--serif);font-weight:400;font-size:1.1rem;
    letter-spacing:.12em;color:var(--paper);margin:0;
  }
  /* 说明文字用「分行小字」而不是 eyebrow 标签 —— 首页其它区块
     已经有 mark/tag 这套标签语汇了，这里再用一个就变成模板腔。 */
  .roll-head .note{font-size:.82rem;color:var(--paper-dim)}

  /* 借阅记录：每行一条，横向密排 */
  .roll-list{
    list-style:none;display:flex;flex-wrap:wrap;
    border-top:1px solid var(--line-soft);
  }
  .roll-list li{
    display:flex;align-items:baseline;gap:.5rem;
    padding:.55rem .9rem .5rem 0;
    border-bottom:1px solid var(--line-soft);
    /* 借阅卡的横向分隔感：每条占一格，右侧留白当"折线" */
    margin-right:.4rem;
    font-size:.92rem;
    opacity:0;animation:up .5s var(--ease) forwards;
  }
  .roll-list li:nth-child(1){animation-delay:.85s}
  .roll-list li:nth-child(2){animation-delay:.9s}
  .roll-list li:nth-child(3){animation-delay:.95s}
  .roll-list li:nth-child(4){animation-delay:1s}
  .roll-list li:nth-child(n+5){animation-delay:1.05s}
  /* 名字：纸色，衬线（是人名，与书名同类） */
  .roll-list .who{font-family:var(--serif);color:var(--paper);letter-spacing:.04em}
  /* 本数：琥珀，唯一的强调 —— 这是唯一值得被注意的数字 */
  .roll-list .n{
    font-family:var(--mono);font-size:.78rem;color:var(--glow);
    font-variant-numeric:tabular-nums;
  }
  .roll-list .n::before{content:"· ";opacity:.5}

  /* ── 雷锋：集体署名，单独一行，跨整行 ──
     它是「所有没有留名的人」的共同署名，必须永远在第一位。
     视觉上刻意与个人条目分开：
       · 独占一行（其他人是横向密排的）
       · 纸色而不是纸色加粗 —— 它不是「某个人」，不能被当成一个人看
       · 用「人人可署名」说明它的性质，而不是只写本数
     琥珀只用在「加入」链接上，那是唯一可点的地方。 */
  .roll-list li.collective{
    grid-column:1/-1;margin-right:0;padding:.7rem 0 .65rem;
    border-bottom:1px solid var(--line);
  }
  .roll-list li.collective .who{
    color:var(--paper);letter-spacing:.16em;
  }
  /* 「雷锋」两个字后面的点线引导，指向本数 */
  .roll-list li.collective .tail{
    flex:1;min-width:24px;height:1px;align-self:center;
    background:repeating-linear-gradient(90deg,var(--line-soft) 0 4px,transparent 4px 8px);
  }
  .roll-list li.collective .what{
    font-size:.78rem;color:var(--paper-dim);letter-spacing:.04em;
  }
  .roll-list li.collective .join{
    font-size:.8rem;color:var(--glow);text-decoration:none;
    border-bottom:1px solid var(--line);white-space:nowrap;
  }
  .roll-list li.collective .join:hover{color:var(--glow-bright);border-color:var(--glow)}
  /* 个人条目那一行的「留名」链接，弱化到几乎看不见 */
  .roll-list li.personal .n{color:var(--paper-dim);opacity:.75}

  /* 没有署名者时的说明 —— 措辞是邀请，不是陈述 */
  .roll-empty{
    padding:1.1rem 0;font-size:.9rem;color:var(--paper-dim);line-height:1.8;
  }
  .roll-empty a{color:var(--glow)}
  /* 加载中：留一个占位高度，避免内容到达时页面跳动 */
  .roll-skeleton{height:2.4rem}

  /* ── 使用方式 ── */
  .howto{margin:3.2rem 0 0;padding-top:1.6rem;border-top:1px solid var(--line)}
  .howto h2{font-family:var(--serif);font-weight:400;font-size:1.25rem;letter-spacing:.1em;color:var(--paper);margin-bottom:1.1rem}
  .howto ol{list-style:none;counter-reset:step;display:grid;gap:.75rem}
  .howto li{
    counter-increment:step;position:relative;padding-left:2.4rem;
    color:var(--paper-dim);font-size:.95rem;line-height:1.7;
    opacity:0;transform:translateY(10px);animation:up .6s ease forwards;animation-delay:.9s;
  }
  .howto li::before{
    content:counter(step,decimal-leading-zero);
    position:absolute;left:0;top:.1em;
    font-family:var(--serif);color:var(--glow);font-size:.95rem;letter-spacing:.05em;
  }
  .howto code{font-family:var(--mono);font-size:.85em;background:rgba(255,180,77,.1);color:var(--glow);padding:.12em .45em;border-radius:var(--r1)}

  /* ── 响应式 ── */
  @media (max-width:520px){
    .shelves{grid-template-columns:1fr 1fr}
    .spine{width:40px;height:56px;font-size:1.25rem}
    .est{display:none}
  }
  @media (max-width:360px){
    .shelves{grid-template-columns:1fr}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="bar-head reveal" style="animation-delay:.03s">
    <span class="mk"><a href="/">we·books</a></span>
    <span class="tag">公共电子书库 · 开架免审 · 匿名</span>
  </div>

  <section class="hero reveal" style="animation-delay:.1s">
    <h1>一间不熄灯的<br>公共书库</h1>
    <p>任何人随时能放一本书进来，<b>不需要注册，也不用等审核</b>。
       浏览器直接看，或用 WebDAV 客户端连上。</p>
  </section>
  <!-- 首屏「活书脊」：最近上架的那本书。数据由 /api/credits 提供
       （该接口缓存 1 小时），所以首页本身零 D1 读、可被 CDN 无限缓存。
       书库为空时 JS 会把这块整个移除。 -->
  <div class="fresh" id="fresh" hidden></div>

  <div class="cta reveal" style="animation-delay:.3s">
    <a class="seal" href="/upload"><span class="dot"></span>上架一本书</a>
    <a class="ghost" href="/requests">找不到想看的？挂求书</a>
    <a class="ghost" href="${mount}">进入书柜 →</a>
  </div>

  <section class="shelves">
${shelfHtml}
  </section>

  <section class="roll reveal" style="animation-delay:.8s">
    <div class="roll-head">
      <h2>谁在传书</h2>
      <span class="note" id="rollNote"></span>
    </div>
    <ul class="roll-list" id="rollList"></ul>
    <div class="roll-empty" id="rollEmpty" hidden></div>
  </section>

  <section class="howto">
    <h2>两种打开方式</h2>
    <ol>
      <li><b>浏览器直开</b> —— 点上方书架，或在地址栏访问 <code>${mount}</code>。</li>
      <li><b>WebDAV 客户端</b> —— rclone / RaiDrive / Cyberduck 连 <code>${mount}</code>（完整 Class 2 锁 + MS 扩展）。</li>
    </ol>
  </section>

  <footer class="site-foot reveal" style="animation-delay:1s">
    <span class="lamps" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>webooks · 免费层 · 匿名开放 · 无审核自动上架</span>
    <a href="/health">健康检查</a>
    <a href="/upload">上架一本</a>
    ${r2PublicBase ? `<a href="${r2PublicBase}">R2 直链</a>` : ''}
    <span style="margin-left:auto;font-family:var(--serif);letter-spacing:.08em">100,000 req/day</span>
  </footer>

</div>

<script>
/**
 * 上传者榜单。
 *
 * 为什么用 fetch 而不是服务端直出：
 *   首页是流量最大的入口，而榜单数据来自 D1 聚合查询。直出意味着
 *   **每次**首页访问都要查一次 —— 而 /api/credits 已经在服务端
 *   缓存 1 小时，客户端再取一次是零成本的。
 *
 * 失败时保持静默：榜单是配角，取不到就不显示，不能让它影响首页可用性。
 */
(function () {
  'use strict';
  var list = document.getElementById('rollList');
  var empty = document.getElementById('rollEmpty');
  var note = document.getElementById('rollNote');

  // XSS 防线：credit 是匿名用户自己填的，必须转义后再进 DOM。
  // 注意：这里用 textContent 而不是 innerHTML，天然免疫。
  var COLLECTIVE = '雷锋';

  /** 个人条目：一行一个名字 + 本数。 */
  function li(name, books) {
    var el = document.createElement('li');
    el.className = 'personal';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;
    var n = document.createElement('span');
    n.className = 'n';
    n.textContent = books + ' 本';
    el.appendChild(who);
    el.appendChild(n);
    return el;
  }

  /**
   * 雷锋那一行：所有没留名的人的共同署名。
   *
   * 单独一行、独占整行，因为它**不是一个人** —— 把它排成和别人的
   * 名字并列的一格，会让人误以为「雷锋」是个昵称。
   *
   * 文案用「人人可署名」而不是「集体」这类抽象词：这是这一行存在的
   * 全部意义 —— 它告诉每个路过的人，不留名也不会被记成nobody。
   */
  function collectiveLi(books) {
    var el = document.createElement('li');
    el.className = 'collective';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = COLLECTIVE;
    var tail = document.createElement('span');
    tail.className = 'tail';
    tail.setAttribute('aria-hidden', 'true');
    var what = document.createElement('span');
    what.className = 'what';
    what.textContent = books + ' 本 · 人人可署名';
    var join = document.createElement('a');
    join.className = 'join';
    join.href = '/upload';
    join.textContent = '加入';
    el.appendChild(who);
    el.appendChild(tail);
    el.appendChild(what);
    el.appendChild(join);
    return el;
  }

  /**
   * 首屏那张「活书脊」。
   *
   * 与榜单共用同一次 fetch（零额外请求）。书库为空（latest 为 null）时
   * 整个容器移除 —— 一个没有书的书库不该在首屏摆一张空卡片。
   *
   * 转义一律用 textContent，不用 innerHTML 拼字符串。
   */
  function renderFresh(latest) {
    var box = document.getElementById('fresh');
    if (!box) return;
    if (!latest || !latest.title) { box.remove(); return; }

    box.hidden = false;
    box.innerHTML = '';

    var spine = document.createElement('span');
    spine.className = 'freshspine';

    var body = document.createElement('span');
    body.className = 'freshbody';

    var label = document.createElement('span');
    label.className = 'freshlabel';
    label.textContent = '最近上架';

    var title = document.createElement('a');
    title.className = 'freshtitle';
    title.href = latest.href;
    title.textContent = latest.title;

    var meta = document.createElement('span');
    meta.className = 'freshmeta';
    // 署名缺失回落「雷锋」：那是集体署名，不是空值
    var credit = latest.credit || COLLECTIVE;
    var who = latest.author || '未署名作者';
    meta.textContent = who + ' · ' + credit + ' 传来 · ' + (latest.publishedAt || '').slice(0, 10);

    body.appendChild(label);
    body.appendChild(title);
    body.appendChild(meta);
    box.appendChild(spine);
    box.appendChild(body);
  }

  fetch('/api/credits', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;

      // ── 首屏活书脊 ──
      // 与榜单共用同一次 fetch —— 不额外发请求。
      // 服务端已把 href 拼好（含百分号编码），前端只负责填内容。
      renderFresh(d.latest);

      var cs = d.contributors || [];
      if (cs.length) {
        var frag = document.createDocumentFragment();
        cs.forEach(function (c) {
          if (c.name === COLLECTIVE) frag.appendChild(collectiveLi(c.books));
          else frag.appendChild(li(c.name, c.books));
        });
        list.appendChild(frag);
        // 说明的是「留了自己名字」的那部分 —— 雷锋不算在内，
        // 否则「18 / 19 本」会让人搞不清集体署名被算到了哪一边。
        var personal = cs.length - (cs.filter(function (c) {
          return c.name === COLLECTIVE;
        }).length);
        note.textContent = personal > 0
          ? personal + ' 人留了名 · 共 ' + (d.totalBooks || 0) + ' 本'
          : '共 ' + (d.totalBooks || 0) + ' 本';
      } else {
        list.hidden = true;
        empty.hidden = false;
        // 措辞是邀请而不是陈述 —— 这里没有数据不代表没有人在传
        empty.innerHTML = '';
        empty.appendChild(document.createTextNode('现在还没有人留名。'));
        var a = document.createElement('a');
        a.href = '/upload';
        a.textContent = '传第一本，让它记上你的名字';
        empty.appendChild(document.createTextNode(' —— '));
        empty.appendChild(a);
        empty.appendChild(document.createTextNode('。留空也会记成「雷锋」。'));
      }
    })
    .catch(function () {
      // 静默：榜单与活书脊都是配角，取不到就不显示，不影响首页可用性
      list.hidden = true;
      empty.hidden = true;
      var box = document.getElementById('fresh');
      if (box) box.remove();
    });
})();
</script>
</body>
</html>`;
}
