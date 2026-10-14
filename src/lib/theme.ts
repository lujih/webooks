/**
 * 共享设计系统 —— 「深夜图书馆」。
 *
 * 三个页面（首页 / 目录浏览 / 上传）共用这一份 token + 基础组件，
 * 避免各页各写一套 CSS 导致视觉割裂（这是上一版最大的问题：
 * 首页是墨色烛光，目录页和上传页却是通用浅色 SaaS 风）。
 *
 * 设计决策：
 *   · 暖黑底（#0e0c0a）而非纯黑 —— 纯黑在 OLED 上刺眼，暖黑更像纸张/木柜
 *   · 琥珀单强调色（#ffb44d）—— 烛光。所有可交互元素共用它，形成统一语义
 *   · 衬线做展示、无衬线做正文 —— 中文衬线（宋体栈）自带书卷气
 *   · 全部尺寸走 4px 基准的间距节奏
 *   · 对比度：正文 --paper 对 --ink ≈ 15:1，次要文字 --paper-dim ≈ 8:1，
 *     均远超 WCAG AA 的 4.5:1；边框提升到 3:1 以上以保证可见性
 *   · 触控目标 ≥44px（按钮 padding 保证）
 *   · prefers-reduced-motion 全量降级
 *   · 焦点用琥珀色 outline，键盘可见
 */

export function themeCss(): string {
  return `
  :root{
    /* ── 色板 ── */
    --ink:#0e0c0a;          /* 墨黑底 */
    --ink-2:#1a1714;        /* 柜木（卡片面） */
    --ink-3:#221c15;        /* 卡片悬停面 */
    --paper:#f3ead8;        /* 纸（主文字） ≈15:1 */
    --paper-dim:#cfc4ad;    /* 旧纸（次要文字） ≈8:1 */
    --glow:#ffb44d;         /* 琥珀烛光（强调） */
    --glow-deep:#d97a1a;    /* 深琥珀（描边/阴影） */
    --glow-bright:#ffc978;  /* 烛光变亮（hover）—— 之前 4 处出现了 3 个不同的值 */
    --line:rgba(255,180,77,.5);       /* 交互控件/卡片边框 —— 3.3:1，满足 WCAG 1.4.11 */
    --line-soft:rgba(255,180,77,.18); /* 纯装饰分隔线（不承载识别功能） */
    --ok:#7dc98f;
    --er:#ff8a7a;

    /* ── 字体 ── */
    --serif:"Songti SC","STSong","Noto Serif SC","Source Han Serif SC",SimSun,serif;
    --sans:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;

    /* ── 间距（4px 基准） ── */
    --s1:4px; --s2:8px; --s3:12px; --s4:16px;
    --s5:24px; --s6:32px; --s7:48px; --s8:64px;

    /* ── 圆角 ── */
    --r1:3px; --r2:6px; --r3:10px;

    /* ── 动效 ── */
    --ease:cubic-bezier(.2,.7,.2,1);
    --dur:.2s;
  }

  *{box-sizing:border-box;margin:0;padding:0}

  html{scroll-behavior:smooth}
  @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}

  body{
    min-height:100vh;
    font-family:var(--sans);
    font-size:16px;
    line-height:1.7;
    color:var(--paper);
    background:
      radial-gradient(120% 80% at 50% -10%, #241d15 0%, transparent 55%),
      radial-gradient(90% 60% at 85% 110%, #1d1710 0%, transparent 60%),
      var(--ink);
    background-attachment:fixed;
    overflow-x:hidden;
    -webkit-font-smoothing:antialiased;
  }

  /* 纸张噪点纹理（纯 CSS，零图片） */
  body::before{
    content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
    background-image:
      repeating-linear-gradient(0deg,rgba(255,255,255,.012) 0 1px,transparent 1px 3px),
      repeating-linear-gradient(90deg,rgba(255,255,255,.01) 0 1px,transparent 1px 3px);
    mix-blend-mode:screen;
  }

  /* 顶部烛光呼吸 */
  body::after{
    content:"";position:fixed;z-index:0;pointer-events:none;
    width:60vmax;height:60vmax;left:50%;top:-18vmax;
    transform:translateX(-50%);
    background:radial-gradient(circle,rgba(255,170,60,.14) 0%,transparent 62%);
    filter:blur(30px);
    animation:breathe 7s ease-in-out infinite;
  }
  @keyframes breathe{
    0%,100%{opacity:.55;transform:translateX(-50%) scale(1)}
    50%{opacity:.9;transform:translateX(-50%) scale(1.06)}
  }

  /* ── 链接 ── */
  a{color:var(--glow);text-decoration:none;transition:color var(--dur) var(--ease)}
  a:hover{color:#ffc978;text-decoration:underline;text-underline-offset:.2em}

  /* ── 焦点可见（键盘可达性） ── */
  :focus-visible{
    outline:2px solid var(--glow);
    outline-offset:3px;
    border-radius:var(--r1);
  }
  /* 鼠标点击不显示焦点环 */
  :focus:not(:focus-visible){outline:none}

  /* ── 代码 ── */
  code{
    font-family:var(--mono);font-size:.88em;
    background:rgba(255,180,77,.1);color:var(--glow);
    padding:.12em .45em;border-radius:var(--r1);
  }
  pre{
    font-family:var(--mono);font-size:.85rem;line-height:1.6;
    background:rgba(0,0,0,.4);border:1px solid var(--line-soft);
    border-radius:var(--r2);padding:var(--s4);overflow-x:auto;
  }
  pre code{background:none;color:var(--paper);padding:0}

  /* ── 通用容器 ── */
  .wrap{position:relative;z-index:1;max-width:56rem;margin:0 auto;padding:var(--s7) var(--s4) var(--s6)}

  /* ── 通用按钮 ── */
  .btn{
    display:inline-flex;align-items:center;gap:var(--s2);
    min-height:44px;padding:.7rem 1.2rem;
    font-family:var(--serif);font-size:1rem;letter-spacing:.1em;
    border-radius:var(--r1);border:1px solid var(--line);
    background:transparent;color:var(--glow);
    cursor:pointer;text-decoration:none;
    transition:border-color var(--dur) var(--ease),background var(--dur) var(--ease),
               letter-spacing var(--dur) var(--ease),transform var(--dur) var(--ease);
  }
  .btn:hover{border-color:var(--glow);background:rgba(255,180,77,.08);letter-spacing:.14em}
  .btn:active{transform:translateY(1px)}
  .btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
  .btn-primary{
    background:var(--glow);color:var(--ink);border-color:var(--glow);
    box-shadow:0 0 0 1px var(--glow-deep),0 6px 20px rgba(255,150,40,.22);
  }
  .btn-primary:hover{background:#ffc978;box-shadow:0 0 0 1px var(--glow-deep),0 10px 28px rgba(255,150,40,.34)}

  /* ── 载入浮现 ── */
  .reveal{opacity:0;transform:translateY(14px);animation:up .7s var(--ease) forwards}
  @keyframes up{to{opacity:1;transform:none}}

  /* ── 页脚 ── */
  .site-foot{
    margin-top:var(--s7);padding-top:var(--s4);
    border-top:1px solid var(--line);
    display:flex;flex-wrap:wrap;gap:var(--s2) var(--s5);
    align-items:center;
    font-size:.8rem;color:var(--paper-dim);
  }
  .site-foot a{color:var(--paper-dim);border-bottom:1px dotted rgba(207,196,173,.4);text-decoration:none}
  .site-foot a:hover{color:var(--glow);border-color:var(--glow);text-decoration:none}
  .lamps{display:inline-flex;gap:var(--s1)}
  .lamps i{
    width:6px;height:6px;border-radius:50%;
    background:var(--glow);box-shadow:0 0 8px var(--glow);
    animation:flicker 3s ease-in-out infinite;
  }
  .lamps i:nth-child(2){animation-delay:.6s}
  .lamps i:nth-child(3){animation-delay:1.3s}
  @keyframes flicker{0%,100%{opacity:.5}50%{opacity:1}}

  /* ── 面包屑 ── */
  .crumbs{
    display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1);
    font-family:var(--serif);font-size:.9rem;letter-spacing:.06em;
    color:var(--paper-dim);margin-bottom:var(--s5);
  }
  .crumbs a{color:var(--paper-dim)}
  .crumbs a:hover{color:var(--glow)}
  .crumbs .sep{opacity:.45;user-select:none}
  .crumbs .here{color:var(--glow)}

  /* ── 降级：尊重系统减少动效 ── */
  @media (prefers-reduced-motion:reduce){
    .reveal,.lamps i,body::after{animation:none!important;opacity:1!important;transform:none!important}
    *{transition-duration:.01ms!important}
  }

  /* ── 响应式 ── */
  @media (max-width:520px){
    .wrap{padding:var(--s6) var(--s3) var(--s5)}
    body{font-size:15px}
  }
  `;
}
