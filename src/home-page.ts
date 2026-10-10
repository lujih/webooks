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

export function indexHtml(mountPath: string, r2PublicBase: string | null): string {
  const mount = `${mountPath}/`;
  const shelves = [
    { path: `${mount}recent/`, title: '最近收录', sub: '新上架的书 · 倒序', icon: '新' },
    { path: `${mount}title/`, title: '按书名', sub: 'A–Z 分桶浏览', icon: '名' },
    { path: `${mount}author/`, title: '按作者', sub: '寻找同一位作者', icon: '著' },
    { path: `${mount}format/`, title: '按格式', sub: 'EPUB / PDF / 有声书', icon: '式' },
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
<title>webooks · 公共电子书库</title>
<meta name="description" content="webooks —— 架在 Cloudflare Workers Free + R2 上的开放 WebDAV 电子书库。任何人都可以上传、浏览、下载。">
<style>
  :root{
    --ink:#0e0c0a;          /* 墨黑 */
    --ink2:#1a1714;         /* 柜木 */
    --paper:#f3ead8;        /* 纸 */
    --paper-dim:#cfc4ad;    /* 旧纸 */
    --glow:#ffb44d;         /* 琥珀烛光 */
    --glow-deep:#d97a1a;
    --line:rgba(255,180,77,.18);
    --serif:"Songti SC","STSong","SimSun","Noto Serif SC",serif;
    --sans:-apple-system,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  }
  *{box-sizing:border-box;margin:0}
  html{scroll-behavior:smooth}
  body{
    min-height:100vh;
    font-family:var(--sans);
    color:var(--paper);
    background:
      radial-gradient(120% 80% at 50% -10%, #241d15 0%, transparent 55%),
      radial-gradient(90% 60% at 85% 110%, #1d1710 0%, transparent 60%),
      var(--ink);
    position:relative;
    overflow-x:hidden;
  }
  /* 纸张噪点 + 烛光呼吸 */
  body::before{
    content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
    background-image:
      repeating-linear-gradient(0deg,rgba(255,255,255,.012) 0 1px,transparent 1px 3px),
      repeating-linear-gradient(90deg,rgba(255,255,255,.01) 0 1px,transparent 1px 3px);
    mix-blend-mode:screen;
  }
  body::after{
    content:"";position:fixed;z-index:0;pointer-events:none;
    width:60vmax;height:60vmax;left:50%;top:-18vmax;
    transform:translateX(-50%);
    background:radial-gradient(circle,rgba(255,170,60,.14) 0%,transparent 62%);
    filter:blur(30px);
    animation:breathe 7s ease-in-out infinite;
  }
  @keyframes breathe{0%,100%{opacity:.55;transform:translateX(-50%) scale(1)}50%{opacity:.9;transform:translateX(-50%) scale(1.06)}}

  .wrap{position:relative;z-index:1;max-width:56rem;margin:0 auto;padding:4.5rem 1.4rem 3rem}

  /* ── 载入浮现 ── */
  .reveal{opacity:0;transform:translateY(14px);animation:up .7s cubic-bezier(.2,.7,.2,1) forwards}
  @keyframes up{to{opacity:1;transform:none}}

  /* ── 顶栏 ── */
  header{display:flex;align-items:baseline;gap:.8rem;flex-wrap:wrap}
  .mark{font-family:var(--serif);font-size:1.15rem;letter-spacing:.35em;color:var(--glow)}
  .mark b{font-weight:400}
  .tag{font-size:.72rem;letter-spacing:.18em;color:var(--paper-dim);text-transform:uppercase}
  .est{margin-left:auto;font-family:var(--serif);font-size:.72rem;color:var(--paper-dim);letter-spacing:.1em}

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
  .hero h1 .glow{color:var(--glow)}
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
  .seal:hover{transform:rotate(0deg) translateY(-2px);background:#ffc36d;box-shadow:0 0 0 1px var(--glow-deep),0 10px 34px rgba(255,150,40,.42)}
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
  .howto code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;background:rgba(255,180,77,.1);color:var(--glow);padding:.12em .45em;border-radius:3px}

  /* ── 页脚 ── */
  footer{margin-top:3.4rem;padding-top:1.4rem;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.6rem 1.4rem;font-size:.78rem;color:var(--paper-dim)}
  footer a{color:var(--paper-dim);text-decoration:none;border-bottom:1px dotted rgba(207,196,173,.4)}
  footer a:hover{color:var(--glow);border-color:var(--glow)}
  .lamps{display:inline-flex;gap:.4rem}
  .lamps i{width:6px;height:6px;border-radius:50%;background:var(--glow);box-shadow:0 0 8px var(--glow);animation:flicker 3s ease-in-out infinite}
  .lamps i:nth-child(2){animation-delay:.6s}.lamps i:nth-child(3){animation-delay:1.3s}
  @keyframes flicker{0%,100%{opacity:.5}50%{opacity:1}}

  @media (prefers-reduced-motion:reduce){
    .reveal,.shelf,.howto li,body::after,.lamps i{animation:none!important;opacity:1!important;transform:none!important}
  }
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

  <header class="reveal" style="animation-delay:.05s">
    <div class="mark"><b>we·books</b></div>
    <div class="tag">public ebook library</div>
    <div class="est">开架 · 免审 · 匿名</div>
  </header>

  <section class="hero reveal" style="animation-delay:.15s">
    <h1>一间<span class="glow">不熄灯</span>的<br>公共书库</h1>
    <p>架在 Cloudflare Workers + R2 上的开放电子书库。<b>任何人都能上传、浏览、下载</b> —— 无需注册、无需密码，WebDAV / 网页 / 阅读器直连。</p>
  </section>

  <div class="cta reveal" style="animation-delay:.3s">
    <a class="seal" href="/upload"><span class="dot"></span>上架一本书</a>
    <a class="ghost" href="${mount}">进入书柜 →</a>
  </div>

  <section class="shelves">
${shelfHtml}
  </section>

  <section class="howto">
    <h2>两种打开方式</h2>
    <ol>
      <li><b>浏览器直开</b> —— 点上方书架，或在地址栏访问 <code>${mount}</code>。</li>
      <li><b>WebDAV 客户端</b> —— rclone / RaiDrive / Cyberduck 连 <code>${mount}</code>（完整 Class 2 锁 + MS 扩展）。</li>
    </ol>
  </section>

  <footer class="reveal" style="animation-delay:1s">
    <span class="lamps" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>webooks · 免费层 · 匿名开放 · 无审核自动上架</span>
    <a href="/health">健康检查</a>
    <a href="/upload">上传页</a>
    ${r2PublicBase ? `<a href="${r2PublicBase}">R2 直链</a>` : ''}
    <span style="margin-left:auto;font-family:var(--serif);letter-spacing:.1em">100,000 req/day 免费额度</span>
  </footer>

</div>
</body>
</html>`;
}
