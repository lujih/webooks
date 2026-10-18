/**
 * 网站首页（/）—— 公共电子书库入口。
 *
 * ── 这一版的身份从哪来 ──
 *
 * 上一版靠「深色底 + 一道琥珀光 + 宋体标题」建立「深夜图书馆」的感觉。
 * 但这个组合有三个硬伤：
 *   1. 深色 + 单一暖强调色是 AI 生成深色站点的默认配方，谁都在用；
 *   2. 宋体在 Linux/Android 上根本不存在（本机只有 DroidSansFallback），
 *      回退成黑体后，「书卷气」全部蒸发，只剩一个普通的深色落地页；
 *   3. 那五张「书脊卡片」用渐变画假的棕色书脊 —— 装饰在冒充信息。
 *
 * 所以这一版的版面语言取自**图书馆里真实存在的东西**：
 *
 *   · 目录页（table of contents）—— 编号 + 名称 + 说明，右对齐成列，
 *     细线分行。这是五个入口现在的形态，它天然能容纳 5 条，也能容纳 50 条。
 *   · 卡片目录（card catalogue）—— 首屏那张「最近上架」是一张平放着的
 *     目录卡：一道暖边压在上沿，标签、书名、著录分行。
 *   · 借阅记录（charging ledger）—— 「谁在传书」是盖章登记簿的样子：
 *     名字一列、本数右对齐、底下一条细线。
 *
 * 这些形态在任何字体下都成立 —— 版面本身的秩序就是身份，不依赖宋体。
 *
 * 黄铜只给「能点的东西」：链接、按钮、悬停态。静态的框线一律用纸色细线。
 * 这是上一版最大的视觉问题（全站 1px 琥珀描边，所有卡片一个强度，
 * 层级全糊），修法不是调淡边框，而是**换掉边框的语义**。
 *
 * 纯静态、零依赖、内联 CSS/JS，由 Worker 直接吐出。
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
  // 所以想让它们显示中文，路径本身就必须是中文。
  const seg = (id: CollectionId) => encodeURIComponent(collectionSegment(id));
  const shelves = [
    { path: `${mount}${seg('recent')}/`, title: '最近收录', sub: '新上架的书，按时间倒序', icon: '新' },
    { path: `${mount}${seg('type')}/`, title: '按类型', sub: '电子书 / 漫画', icon: '类' },
    { path: `${mount}${seg('title')}/`, title: '按书名', sub: '中文按拼音首字母，英文按字母', icon: '名' },
    { path: `${mount}${seg('author')}/`, title: '按作者', sub: '同一个作者的书挨在一起', icon: '著' },
    { path: `${mount}${seg('format')}/`, title: '按格式', sub: 'EPUB / PDF / CBZ…', icon: '式' },
  ];
  const shelfHtml = shelves
    .map((s, i) => {
      // 编号是目录页的真实语汇（01…05），不是装饰性序号。
      // 汉字索引（新/类/名/著/式）保留在可访问名里，供屏幕阅读器与快速扫读。
      const n = String(i + 1).padStart(2, '0');
      return `
  <a class="shelf" href="${s.path}" title="${esc(s.title)}">
    <span class="sn" aria-hidden="true">${n}</span>
    <span class="st">${esc(s.title)}<span class="sg" aria-hidden="true">${s.icon}</span></span>
    <span class="ss">${esc(s.sub)}</span>
  </a>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- 显式声明图标：不声明时浏览器会自己去请求 /favicon.ico，
     而那个路径在加静态资源之前是个 404 —— 每次页面浏览都白花一次 Worker 请求。 -->
<link rel="icon" href="/favicon.ico" sizes="32x32">
<title>webooks · 公共电子书库</title>
<meta name="description" content="webooks —— 架在 Cloudflare Workers Free + R2 上的开放 WebDAV 电子书库。任何人都可以上传、浏览、下载。">
<style>
${themeCss()}

  /* ── 主标题区 ──
     这一版的 h1 不再独占一屏。左侧标题 + 引言 + 三个动作，右侧留白 ——
     留白是版面的组成部分，不是「没填满」。 */
  .hero{padding:var(--s6) 0 var(--s5)}
  .hero h1{
    font-family:var(--serif);font-weight:400;
    font-size:var(--fz-hero);line-height:1.16;letter-spacing:.01em;
    color:var(--paper);max-width:20ch;
  }
  /* 引言里的 <b> 不是「给一个词上色」那种模板腔 ——
     它标的是这句话里唯一的硬信息（不用注册、不用等审核）。 */
  .hero p{
    margin-top:var(--s5);max-width:36rem;
    color:var(--paper-dim);font-size:1rem;line-height:1.95;
  }
  .hero p b{color:var(--paper);font-weight:600}

  .cta{display:flex;flex-wrap:wrap;gap:var(--s3);margin-top:var(--s6)}
  /* 主按钮只有一颗。其余是描边按钮，宽度由内容决定，不拉伸。 */
  .cta .btn{flex:0 0 auto}

  /* ── 最近上架：一张平放的目录卡 ──
     上沿一道暖边（唯一用暖色的静态元素，因为它标记「新」），
     下面三行著录。没有封面、没有叠加的卡片阴影 —— 它是一张纸。 */
  .fresh{
    display:grid;grid-template-columns:1fr auto;
    gap:var(--s1) var(--s5);align-items:baseline;
    margin-top:var(--s6);
    padding:var(--s4) var(--s5) var(--s4) var(--s4);
    border-top:2px solid var(--brass);
    border-bottom:1px solid var(--rule);
    background:linear-gradient(180deg,var(--wash-warm) 0%,transparent 100%);
    text-decoration:none;color:var(--paper);
    transition:background var(--dur) var(--ease),border-bottom-color var(--dur) var(--ease);
  }
  .fresh:hover,.fresh:focus-visible{
    background:linear-gradient(180deg,rgba(220,168,95,.13) 0%,transparent 100%);
    border-bottom-color:var(--edge-warm);
    text-decoration:none;color:var(--paper);
  }
  .freshlabel{
    grid-column:1/-1;
    font-size:var(--fz-xs);color:var(--paper-dim);letter-spacing:.16em;
  }
  .freshtitle{
    font-family:var(--serif);font-size:1.32rem;letter-spacing:.01em;
    line-height:1.35;word-break:break-word;min-width:0;
  }
  .fresh:hover .freshtitle{color:var(--brass-lift)}
  .freshmeta{
    font-size:var(--fz-sm);color:var(--paper-dim);
    font-variant-numeric:tabular-nums;white-space:nowrap;
  }

  /* ── 分段标题 ──
     每一段上面一条细线 + 左侧标题 + 右侧说明。
     全站统一这个节奏，页面就有「书页」的分栏感。 */
  /* 每一段自己带上下间距：它们不是同一种「卡片区块」，
     共用 .sec 会让人以为可以随手加一段。 */
  .shelves-sec,.roll,.howto{margin-top:var(--s8)}
  .sec-head{
    display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;
    padding-bottom:var(--s3);border-bottom:1px solid var(--rule-strong);
    margin-bottom:0;
  }
  .sec-head h2{
    font-family:var(--serif);font-weight:400;font-size:1.06rem;
    letter-spacing:.1em;color:var(--paper);
  }
  .sec-note{font-size:var(--fz-sm);color:var(--paper-dim);margin-left:auto}

  /* ── 目录（五个入口）──
     编号 + 名称 + 说明，右对齐成列，细线分行。
     没有卡片、没有图标块、没有 hover 位移 —— 它是一页目录，不是五张卡。 */
  .shelves{display:block}
  .shelf{
    display:grid;grid-template-columns:2.4rem minmax(0,auto) 1fr;
    align-items:baseline;gap:var(--s4);
    padding:.72rem var(--s2);
    border-bottom:1px solid var(--rule);
    color:var(--paper);text-decoration:none;
    transition:background var(--dur) var(--ease),border-bottom-color var(--dur) var(--ease),
               box-shadow var(--dur) var(--ease);
  }
  .shelf:hover,.shelf:focus-visible{
    background:var(--wash);border-bottom-color:var(--edge-warm);
    box-shadow:inset 2px 0 0 var(--brass);
    text-decoration:none;color:var(--paper);
  }
  .sn{
    font-family:var(--mono);font-size:.72rem;color:var(--paper-faint);
    font-variant-numeric:tabular-nums;transition:color var(--dur) var(--ease);
  }
  .shelf:hover .sn{color:var(--brass)}
  .st{font-family:var(--serif);font-size:1.06rem;letter-spacing:.05em;white-space:nowrap}
  /* 汉字索引：只在大屏出现，且做得很小 —— 它是个提示，不是图标 */
  .sg{
    font-size:.74rem;color:var(--paper-faint);margin-left:.6em;
    letter-spacing:0;transition:color var(--dur) var(--ease);
  }
  .shelf:hover .sg{color:var(--jade)}
  .ss{
    font-size:var(--fz-sm);color:var(--paper-dim);
    text-align:right;justify-self:end;min-width:0;
  }

  /* ── 谁在传书：借阅登记簿 ──
     雷锋那一条独占整行（它不是一个人，不能和别人的名字并排），
     其余名字排成几列，每格下面一条细线 —— 盖章登记簿的样子。 */
  .roll-list{
    list-style:none;display:grid;
    /* auto-fit：名字少时会撑满整行，不会在右边留一段空白 */
    grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));
    border-bottom:1px solid var(--rule);
  }
  .roll-list li{
    display:flex;align-items:baseline;gap:var(--s2);
    padding:.62rem var(--s3) .58rem 0;
    border-bottom:1px solid var(--rule);
    min-width:0;
  }
  .roll-list li:nth-last-child(-n+1){border-bottom:0}
  /* 集体署名行：跨满整行，上方一条实线把它与个人条目分开 */
  .roll-list li.collective{
    grid-column:1/-1;
    margin-right:0;padding:.7rem 0 .65rem;
    border-bottom:1px solid var(--rule-strong);border-top:1px solid var(--rule-strong);
    align-items:baseline;
  }
  .roll-list li.collective:first-child{border-top:0}
  .roll-list .who{
    font-family:var(--serif);color:var(--paper);letter-spacing:.04em;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;
  }
  /* 本数：右对齐、等宽数字。琥珀只在这一处出现，因为它是唯一值得看的数字。 */
  .roll-list .n{
    font-family:var(--mono);font-size:.74rem;color:var(--brass);
    font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto;
  }
  /* 集体行：名字与说明之间拉一条点线（借书卡上的引导线） */
  .roll-list li.collective .who{letter-spacing:.18em;flex:0 0 auto}
  .roll-list li.collective .tail{
    flex:1;min-width:20px;height:1px;align-self:center;
    background:repeating-linear-gradient(90deg,var(--rule-strong) 0 3px,transparent 3px 7px);
  }
  .roll-list li.collective .what{
    font-size:var(--fz-sm);color:var(--paper-dim);white-space:nowrap;
  }
  .roll-list li.collective .join{
    font-size:var(--fz-sm);color:var(--brass);
    border-bottom:1px solid var(--edge-warm);padding-bottom:1px;
    white-space:nowrap;margin-left:var(--s3);
  }
  .roll-list li.collective .join:hover{color:var(--brass-lift);text-decoration:none}
  /* 个人条目的本数退后半步：集体那一条才是重点 */
  .roll-list li.personal .n{color:var(--paper-dim)}

  .roll-empty{padding:var(--s5) 0;font-size:.92rem;color:var(--paper-dim);line-height:1.85}
  .roll-empty a{color:var(--brass)}

  /* ── 两种打开方式 ── */
  .howto ol{list-style:none;counter-reset:step}
  .howto li{
    counter-increment:step;position:relative;
    padding:var(--s4) 0 var(--s4) 3.2rem;
    border-bottom:1px solid var(--rule);
    color:var(--paper-dim);font-size:.95rem;line-height:1.85;
  }
  .howto li:last-child{border-bottom:0}
  .howto li::before{
    content:counter(step,decimal-leading-zero);
    position:absolute;left:0;top:var(--s4);
    font-family:var(--mono);font-size:.75rem;color:var(--paper-faint);
    letter-spacing:.06em;
  }
  .howto li b{color:var(--paper);font-weight:600}
  .howto code{background:none;padding:0;color:var(--brass)}

  /* ── 响应式 ── */
  @media (max-width:720px){
    .hero h1{max-width:none}
    .shelf{grid-template-columns:1.9rem minmax(0,1fr);gap:var(--s2) var(--s3);row-gap:0}
    /* 手机上没有横向空间放右对齐的说明，让它掉到第二行、靠左 */
    .ss{grid-column:2;text-align:left;justify-self:start;font-size:.78rem;padding-bottom:.55rem}
    .st{white-space:normal}
    .sg{display:none}
    .fresh{grid-template-columns:1fr}
    .freshmeta{white-space:normal}
    .roll-list{grid-template-columns:1fr 1fr}
  }
  @media (max-width:420px){
    .roll-list{grid-template-columns:1fr}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="bar-head">
    <span class="mk"><a href="/">we·books</a></span>
    <span class="tag">公共电子书库 · 开架免审 · 匿名</span>
  </div>

  <section class="hero">
    <h1>一间不熄灯的<br>公共书库</h1>
    <p>任何人随时能放一本书进来，<b>不需要注册，也不用等审核</b>。
       浏览器直接看，或者用 WebDAV 客户端把它挂成本地盘。</p>
    <div class="cta">
      <a class="btn btn-primary" href="/upload">上架一本书</a>
      <a class="btn" href="/requests">找不到想看的？挂个求书</a>
      <a class="btn" href="${mount}">进入书库</a>
    </div>
  </section>

  <!-- 首屏「最近上架」：数据由 /api/credits 提供（该接口缓存 1 小时），
       所以首页本身零 D1 读、可被 CDN 无限缓存。书库为空时 JS 把整块移除。 -->
  <div class="fresh" id="fresh" hidden></div>

  <section class="shelves-sec">
    <div class="sec-head">
      <h2>从哪里找</h2>
      <span class="sec-note">点开任意一条，或用上面的 WebDAV 地址挂载</span>
    </div>
    <nav class="shelves" aria-label="书库入口">
${shelfHtml}
    </nav>
  </section>

  <section class="roll">
    <div class="sec-head">
      <h2>谁在传书</h2>
      <span class="sec-note" id="rollNote"></span>
    </div>
    <ul class="roll-list" id="rollList"></ul>
    <div class="roll-empty" id="rollEmpty" hidden></div>
  </section>

  <section class="howto">
    <div class="sec-head">
      <h2>两种打开方式</h2>
    </div>
    <ol>
      <li><b>浏览器直开</b> —— 点上方的入口，或者在地址栏访问 <code>${esc(mount)}</code>。点书名直接从 R2 下载，不经过本站服务器。</li>
      <li><b>WebDAV 客户端</b> —— rclone / RaiDrive / Cyberduck 连 <code>${esc(mount)}</code>，完整 Class 2 锁 + MS 扩展，和本地文件夹一样用。</li>
    </ol>
  </section>

  <footer class="site-foot">
    <span class="lamps" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>webooks · 匿名开放 · 无审核自动上架</span>
    <a href="/health">健康检查</a>
    <a href="/upload">上架一本</a>
    ${r2PublicBase ? `<a href="${esc(r2PublicBase)}">R2 直链</a>` : ''}
  </footer>

</div>

<script>
/**
 * 上传者榜单 + 首屏最近上架。
 *
 * 为什么用 fetch 而不是服务端直出：
 *   首页是流量最大的入口，而榜单数据来自 D1 聚合查询。直出意味着
 *   **每次**首页访问都要查一次 —— 而 /api/credits 已经在服务端
 *   缓存 1 小时，客户端再取一次是零成本的。两条信息共用这一次请求。
 *
 * 失败时保持静默：榜单是配角，取不到就不显示，不能影响首页可用性。
 */
(function () {
  'use strict';
  var list = document.getElementById('rollList');
  var empty = document.getElementById('rollEmpty');
  var note = document.getElementById('rollNote');

  // XSS 防线：credit 是匿名用户自己填的，必须转义后再进 DOM。
  // 这里一律用 textContent 而不是 innerHTML —— 天然免疫。
  var COLLECTIVE = '雷锋';

  /** 个人条目：一个名字 + 本数。 */
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
   * 全部意义 —— 它告诉每个路过的人，不留名也不会被记成 nobody。
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
    join.textContent = '留个名';
    el.appendChild(who);
    el.appendChild(tail);
    el.appendChild(what);
    el.appendChild(join);
    return el;
  }

  /**
   * 首屏那张「最近上架」。
   *
   * 与榜单共用同一次 fetch（零额外请求）。书库为空（latest 为 null）时
   * 整个容器移除 —— 一个没有书的书库不该在首屏摆一张空卡片。
   */
  function renderFresh(latest) {
    var box = document.getElementById('fresh');
    if (!box) return;
    if (!latest || !latest.title) { box.remove(); return; }

    box.hidden = false;
    box.innerHTML = '';

    var label = document.createElement('span');
    label.className = 'freshlabel';
    label.textContent = '最近上架';

    var title = document.createElement('a');
    title.className = 'freshtitle';
    // 直链优先：R2 公开域是绝对地址，点一下直接命中 R2，**不经过 Worker**。
    //
    // ⚠️ 回退**不能**省。真正会用到它的场景不是「没配 R2_PUBLIC_BASE」
    //   —— 那种情况下全站早就 500 了，根本轮不到这里。会用到它的是
    //   **缓存错配**：这段脚本由站点根路径提供、max-age 一小时；而
    //   /api/credits 那份 JSON 也各自缓存 1 小时。于是一个刚部署完的窗口里，
    //   新脚本可能配上一份**部署前**缓存的响应 —— 那份 JSON 里压根没有
    //   downloadUrl 字段，取出来是 undefined。少了回退就会把「undefined」
    //   四个字当路径塞进 DOM，点下去变成 /dav/undefined 这种死链。
    //
    // ⚠️⚠️ 本文件整体是一个模板字符串：**注释里绝对不许出现反引号**。
    //   它会提前闭合外层模板串。引号请一律用「」。
    title.href = latest.downloadUrl || latest.href;
    title.textContent = latest.title;

    var meta = document.createElement('span');
    meta.className = 'freshmeta';
    // 署名缺失回落「雷锋」：那是集体署名，不是空值
    var credit = latest.credit || COLLECTIVE;
    var who = latest.author || '未署名作者';
    var day = (latest.publishedAt || '').slice(0, 10);
    // 作者与上传者是同一个人时（上传时顺手填了自己的名字），
    // 「刘慈欣 · 刘慈欣 传来」是同一句话说两遍 —— 只留一次。
    var by = who === credit ? who : who + ' · ' + credit;
    meta.textContent = by + ' 传来' + (day ? ' · ' + day : '');

    box.appendChild(label);
    box.appendChild(title);
    box.appendChild(meta);
  }

  fetch('/api/credits', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;

      // ── 首屏最近上架 ──
      // 与榜单共用同一次 fetch —— 不额外发请求。
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
      // 静默：榜单与最近上架都是配角，取不到就不显示，不影响首页可用性
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
