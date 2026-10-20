/**
 * 共享设计系统 —— 「开架目录」。
 *
 * 五个页面（首页 / 目录浏览 / 上传 / 求书 / 后台）共用这一份 token + 基础组件。
 * 页面自己再写一套 CSS 就会变成「同一个域名下的两个产品」，这是上一版
 * 求书墙真实发生过的事（自造 .wrap / panel / button，宽度 960px）。
 *
 * ── 设计决策（每一处都有理由，别随手改） ──
 *
 * · 底色是**墨绿黑**（#0b100e）而不是暖黑。暖黑 + 单一橙色是"AI 默认深色站"
 *   的标准配方；偏冷的墨黑配黄铜，是旧图书馆里黄铜灯罩与铜绿配件的关系。
 *
 * · 黄铜（--brass）只用于**交互与活态**：链接、按钮、当前项、可点的数字。
 *   它绝不用于静态装饰边框 —— 上一版全站 1px 琥珀描边（--line .5）把
 *   每张卡都框成同一种强度，页面糊成一片「橙色描边汤」，层级全失。
 *   结构靠**纸色细线**（--rule）做，交互靠**纸色实线**（--edge）做，
 *   黄铜留给真正需要被点的东西。一页里黄铜出现在三处以内，它才有意义。
 *
 * · 第二种颜色是铜绿（--jade）。它只承担**结构性信息**（计数、分类标记、
 *   成功态），不做装饰。单一强调色的站点看起来像配色未完成；两种颜色但
 *   各有明确职责，才是克制的。
 *
 * · 字体不承载身份。中文衬线栈里"宋体"在 Linux/Android/部分 Windows 上
 *   根本不存在，回退成黑体后，靠衬线建立的"书卷气"会全部消失。
 *   本机的真实情况就是只有 DroidSansFallback 一个中文字体。
 *   所以身份由**版面**承担：书目式的行网格、齐整的右对齐数字列、
 *   纸色细线分隔、标题页式的留白节奏。这些在任何字体下都成立。
 *   衬线栈仍然保留并补齐 Noto Serif CJK / AR PL UMing（有则更好）。
 *
 * · 对比度（WCAG，scripts/contrast-check.mjs 可复核）：
 *   --paper 对 --ink ≈ 15.5:1，--paper-dim ≈ 7.5:1，--brass ≈ 9:1，
 *   --jade ≈ 8.4:1；交互边框 --edge 对底色 3.5:1（1.4.11 非文字 3:1）。
 *   --rule 是纯装饰分隔线，不承载识别功能，不适用 3:1。
 *
 * · 触控目标 ≥44px；prefers-reduced-motion 全量降级；焦点环 2px 黄铜。
 */

export function themeCss(): string {
  return `
  :root{
    /* ── 底色：墨绿黑，三档面 ── */
    --ink:#0b100e;          /* 页底 */
    --ink-2:#121a16;        /* 抬起的面（卡片 / 列表块） */
    --ink-3:#19221d;        /* 悬停面 */

    /* ── 纸 ── */
    --paper:#efe6d4;        /* 主文字 ≈15.5:1 */
    --paper-dim:#a8a292;    /* 次要文字 ≈7.5:1 */
    --paper-faint:#6f6b5f;  /* 极次要：仅用于装饰性标记，不承载信息 */

    /* ── 黄铜：交互与活态，仅此一用 ── */
    --brass:#dca85f;
    --brass-deep:#8a6428;
    --brass-lift:#eec183;   /* hover / 亮态 */

    /* ── 铜绿：结构性信息（计数、分类、成功） ── */
    --jade:#8fb3a4;
    --jade-deep:#4b6b60;

    /* ── 线 ──
       rule  纯装饰分隔（1.4~1.6:1）
       edge  交互控件边框，必须 ≥3:1（3.5:1）
       edge-warm  活态暖边（3.9:1） */
    --rule:rgba(239,230,212,.14);
    --rule-strong:rgba(239,230,212,.24);
    --edge:rgba(239,230,212,.42);
    --edge-warm:rgba(220,168,95,.6);

    /* ── 面 ── */
    --wash:rgba(239,230,212,.04);      /* 行 hover 洗色 */
    --wash-warm:rgba(220,168,95,.07);  /* 暖态洗色 */

    --ok:#8fc9a3;
    --er:#ef8b7c;

    /* ── 字体 ──
       补齐 Noto Serif CJK / Source Han / AR PL UMing：
       原栈只有 macOS/Windows 的名字，Linux 与多数 Android 全部落空。 */
    --serif:"Songti SC","STSong","Noto Serif CJK SC","Noto Serif SC","Source Han Serif SC","Source Han Serif CN","AR PL UMing CN","AR PL UMing TW","SimSun",serif;
    --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace;

    /* ── 字号 ──
       刻意用 px 而不是 rem：rem 会跟着 body 的 font-size 缩放，而
       移动端把 body 调到 15px —— 于是 0.72rem 的小字在手机上缩到
       10.9px。实测（见 docs/frontend-design.md）小标签成片掉到 11px 上下，
       那是「靠小字营造精致」，不是精致。

       px 还带来一个好处：下限是**写死的**。12px 是这条站能接受的最小字，
       任何需要更小的地方都不该用字解决。 */
    --fz-micro:12px;   /* 硬下限：序号、格式、大小、署名 */
    --fz-xs:12.5px;   /* 辅助说明 */
    --fz-sm:13.5px;   /* 次要正文 */
    --fz-md:15px;     /* 列表行正文 */
    --fz-lg:18px;     /* 强调 */
    --fz-title:clamp(1.6rem,3.6vw,2.05rem);
    --fz-hero:clamp(2.3rem,5.6vw,3.6rem);

    /* ── 间距（4px 基准） ── */
    --s1:4px; --s2:8px; --s3:12px; --s4:16px;
    --s5:24px; --s6:32px; --s7:48px; --s8:64px; --s9:96px;

    /* ── 圆角（刻意小：纸与木是方的，大圆角是 SaaS 语汇） ── */
    --r1:2px; --r2:4px; --r3:6px;

    /* ── 动效 ── */
    --ease:cubic-bezier(.2,.7,.2,1);
    --dur:.18s;
  }

  *{box-sizing:border-box;margin:0;padding:0}

  /* ── [hidden] 必须真的隐藏 ──
     UA 样式表里只有 [hidden]{display:none}，权重和作者样式表里的
     一条普通 display **同级但更早**，所以任何 .btn{display:inline-flex}
     或 .empty{display:flex} 都会把它盖掉 —— hidden 属性形同虚设。
     真实踩到：求书墙有 7 条记录时，「清单还是空的」空状态照样显示在
     列表下面；「看更多」在已经到底时也还亮着。
     在每个组件里各自记得写 display:none 是记不住的，这里一次性兜底。 */
  [hidden]{display:none!important}

  html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
  @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}

  /* 中文排版：避免末行只剩一两个字的孤字。
     实测上传页「只接受电子书与漫画格式。」在 390px 上末行只有「式。」两字
     （28px 宽）—— 那是断行算法的结果，不是排版者的意图。
     pretty 让浏览器在段落里重新找断点；balance 用在标题上。 */
  p,li,dd{text-wrap:pretty}
  h1,h2,h3,.hero h1{text-wrap:balance}

  body{
    min-height:100vh;
    font-family:var(--sans);
    font-size:16px;
    line-height:1.7;
    color:var(--paper);
    background:
      radial-gradient(110% 70% at 50% -12%, #16201b 0%, transparent 58%),
      radial-gradient(80% 55% at 88% 108%, #131a16 0%, transparent 62%),
      var(--ink);
    background-attachment:fixed;
    overflow-x:hidden;
    -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility;
  }

  /* 纸纹：极细的横纹，mix-blend 只提亮，不影响文字对比度 */
  body::before{
    content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
    background-image:
      repeating-linear-gradient(0deg,rgba(239,230,212,.014) 0 1px,transparent 1px 3px);
  }

  /* 顶部铜灯的一层薄光。只有它动，且慢、幅度小。 */
  body::after{
    content:"";position:fixed;z-index:0;pointer-events:none;
    width:70vmax;height:70vmax;left:50%;top:-26vmax;
    transform:translateX(-50%);
    background:radial-gradient(circle,rgba(220,168,95,.10) 0%,transparent 64%);
    filter:blur(24px);
    animation:breathe 9s ease-in-out infinite;
  }
  @keyframes breathe{
    0%,100%{opacity:.55}
    50%{opacity:.85}
  }

  /* ── 链接 ── */
  a{color:var(--brass);text-decoration:none;transition:color var(--dur) var(--ease)}
  a:hover{color:var(--brass-lift);text-decoration:underline;text-underline-offset:.22em;text-decoration-thickness:1px}

  /* ── 焦点可见 ── */
  :focus-visible{
    outline:2px solid var(--brass);
    outline-offset:3px;
    border-radius:var(--r1);
  }
  :focus:not(:focus-visible){outline:none}

  /* ── 表单基础 ──
     占位符必须显式上色：不写这一条，浏览器用 UA 默认的 #757575，
     压在墨底上只有 4.24:1 —— 低于 AA。全局统一一处，免得每页漏一个。 */
  ::placeholder{color:var(--paper-dim);opacity:1}
  input,select,textarea,button{font-family:inherit;font-size:inherit;color:inherit}

  /* ── 小点击目标的补偿 ──
     页脚链接、面包屑、返回链接在视觉上必须小（它们是配角），
     但**可点区域**不能小。用垂直 padding 撑到 44px 的可点高度，
     视觉尺寸不变，也不打乱 flex 基线对齐。

     ⚠️ 这些元素的「下划线」一律用 text-decoration，**不能用 border-bottom**。
        它们为了凑够 44px 触控高度被拉成了高盒子，而 border 画在盒子的下边缘 ——
        于是下划线会飘在文字下方二十来像素的地方，看起来像页面上散落的破折号。
        text-decoration 附着在文字上，盒子多高都不影响。

     ⚠️ 这条规则**曾经整段丢失**：注释还在，声明没了，于是页脚链接
        实测只有 20px 高（.site-foot a h=20），37 个小目标原样回归。
        注释不会让规则生效 —— 改这里时务必确认下面这行还在。 */
  .site-foot a,.crumbs a,.back,.mk a{
    display:inline-flex;align-items:center;min-height:44px;box-sizing:content-box;
  }
  /* 高度够了（44px），但「首页」两个字只有 26px 宽 ——
     横向 26px 的目标在手机上很难点中。给个最小宽度。 */
  .site-foot a,.crumbs a{min-width:44px;justify-content:center}

  /* ── 代码 ──
     用 px 不用 em：em 跟着父级字号缩放，父级一缩 code 就掉到 11px 上下
     （实测 /dav/ 与 ADMIN_TOKEN 都在 11.6~11.9px）。 */
  code{
    font-family:var(--mono);font-size:var(--fz-micro);
    background:var(--wash);color:var(--brass);
    padding:.1em .4em;border-radius:var(--r1);
    word-break:break-all;
  }
  pre{
    font-family:var(--mono);font-size:var(--fz-sm);line-height:1.6;
    background:rgba(0,0,0,.35);border:1px solid var(--rule);
    border-radius:var(--r2);padding:var(--s4);overflow-x:auto;
  }
  pre code{background:none;color:var(--paper);padding:0}

  /* ── 版心 ──
     52rem，全站唯一一档。

     原来是两档：首页/上传/后台 64rem，浏览页/求书墙 52rem。后果是
     从首页点「进入书库」，同一个站名从 x=232 跳到 x=328 ——
     整页内容在翻页时位移 96px。整站是一本书，版心不能中途换档。

     64rem 那档也不是更好：1024px 的行放「书名 + 作者 + 格式 + 大小」，
     右对齐的数字列被推到 x=976，视线要横跨整屏才能把书名和大小对上。
     52rem 才是一张目录该有的宽度。 */
  .wrap{position:relative;z-index:1;max-width:52rem;margin:0 auto;padding:var(--s7) var(--s5) var(--s6)}

  /* ── 页头（五页共用，别再各写一套） ── */
  .bar-head{
    display:flex;align-items:baseline;gap:var(--s4);flex-wrap:wrap;
    padding-bottom:var(--s3);border-bottom:1px solid var(--rule);
    margin-bottom:var(--s7);
  }
  /* 站名：小字 + 大字距。这是招牌，不是标题，所以它比 h1 小得多。 */
  .mk{font-family:var(--serif);font-size:var(--fz-sm);letter-spacing:.34em;color:var(--paper)}
  .mk a{color:inherit;text-decoration:none}
  .mk a:hover{color:var(--brass);text-decoration:none}
  .tag{font-size:var(--fz-sm);color:var(--paper-dim);letter-spacing:.02em}
  .back{
    margin-left:auto;font-size:var(--fz-sm);color:var(--paper-dim);
    text-decoration:underline;text-decoration-color:var(--rule);
    text-decoration-thickness:1px;text-underline-offset:.34em;
  }
  .back:hover{color:var(--brass);text-decoration-color:var(--edge-warm)}

  /* ── 页标题 ── */
  h1{
    font-family:var(--serif);font-weight:400;
    font-size:var(--fz-title);line-height:1.28;letter-spacing:.01em;
    color:var(--paper);margin-bottom:var(--s3);
    word-break:break-word;
  }
  .lede{
    max-width:40rem;color:var(--paper-dim);font-size:var(--fz-sm);line-height:1.9;
  }
  .lede b{color:var(--paper);font-weight:600}

  /* ── 按钮 ── */
  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);
    min-height:44px;padding:.62rem 1.1rem;
    font-family:var(--sans);font-size:var(--fz-sm);letter-spacing:.02em;
    border-radius:var(--r1);border:1px solid var(--edge);
    background:transparent;color:var(--paper);
    cursor:pointer;text-decoration:none;
    transition:border-color var(--dur) var(--ease),background var(--dur) var(--ease),color var(--dur) var(--ease);
  }
  .btn:hover{border-color:var(--brass);color:var(--brass-lift);background:var(--wash-warm);text-decoration:none}
  .btn:active{transform:translateY(1px)}
  .btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
  .btn:disabled:hover{border-color:var(--edge);color:var(--paper);background:transparent}
  /* 主按钮：黄铜底 + 墨色字。全站只有每页**一个**主按钮，多了就没有主次。 */
  .btn-primary{
    background:var(--brass);color:#0b100e;border-color:var(--brass);font-weight:600;
  }
  .btn-primary:hover{background:var(--brass-lift);border-color:var(--brass-lift);color:#0b100e}
  .btn.danger{color:var(--er);border-color:rgba(239,139,124,.42)}
  .btn.danger:hover{color:var(--er);border-color:var(--er);background:rgba(239,139,124,.08)}

  /* ── 页脚 ── */
  .site-foot{
    margin-top:var(--s8);padding-top:var(--s4);
    border-top:1px solid var(--rule);
    display:flex;flex-wrap:wrap;gap:var(--s2) var(--s5);
    align-items:center;
    font-size:var(--fz-xs);color:var(--paper-dim);
  }
  .site-foot a{
    color:var(--paper-dim);
    text-decoration:underline;text-decoration-color:var(--rule);
    text-decoration-thickness:1px;text-underline-offset:.34em;
  }
  .site-foot a:hover{color:var(--brass);text-decoration-color:var(--edge-warm)}

  /* 三盏小灯：全站唯一的装饰性动效，6px，位于页脚，不抢注意力 */
  .lamps{display:inline-flex;gap:5px}
  .lamps i{
    width:5px;height:5px;border-radius:50%;
    background:var(--brass);box-shadow:0 0 6px rgba(220,168,95,.8);
    animation:flicker 3.4s ease-in-out infinite;
  }
  .lamps i:nth-child(2){animation-delay:.7s}
  .lamps i:nth-child(3){animation-delay:1.5s}
  @keyframes flicker{0%,100%{opacity:.45}50%{opacity:1}}

  /* ── 面包屑 ── */
  .crumbs{
    display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);
    font-size:var(--fz-sm);color:var(--paper-dim);
    margin-bottom:var(--s4);
  }
  .crumbs a{color:var(--paper-dim)}
  .crumbs a:hover{color:var(--brass)}
  .crumbs .sep{color:var(--paper-faint);user-select:none}
  .crumbs .here{color:var(--paper)}

  /* ── 空状态（五页共用） ──
     只有一条顶线（承接上一段的分隔），不画底线 ——
     上下都画线会在版心两端各留一道孤零零的短横，像没画完。
     空的东西不需要框住，留白就够了。 */
  .empty{
    display:flex;flex-direction:column;align-items:center;gap:var(--s2);
    padding:var(--s8) var(--s4) var(--s7);text-align:center;
    border-top:1px solid var(--rule);
    color:var(--paper-dim);
  }
  .empty b{font-family:var(--serif);font-weight:400;font-size:1.1rem;color:var(--paper);letter-spacing:.04em}

  /* ── 降级 ── */
  @media (prefers-reduced-motion:reduce){
    .lamps i,body::after{animation:none!important;opacity:.8!important}
    *{transition-duration:.01ms!important}
  }

  /* ── 响应式 ──
     ⚠️ 这里**不能**再缩 body 的 font-size。字号已全部改成 px 之后，
        缩 body 只剩下一个副作用：让所有 em/rem 单位的旧规则继续变小 ——
        而那正是把小字压到 11px 的原因。手机端要更紧凑，靠间距调整，
        不靠缩小文字。 */
  @media (max-width:640px){
    .wrap{padding:var(--s5) var(--s4) var(--s6)}
    .bar-head{margin-bottom:var(--s5)}
  }
  `;
}
