/**
 * 浏览器目录页（GET /dav/**）—— 书目视图。
 *
 * ── 这一版为什么是「列表」而不是「卡片网格」 ──
 *
 * 上一版把目录和书都渲染成同一种 300px 卡片：同样的 1px 琥珀边框、
 * 同样的渐变底、同样的内边距。结果是 15 本书 = 15 个一模一样的方框，
 * 眼睛无法在页面上停留 —— 没有主次，也就没有信息。
 *
 * 现在按**真实的信息结构**分成两种形态：
 *
 *   · 子目录 → 目录索引（编号 + 名称 + 说明），和首页同一套语汇。
 *     它们少（通常 3~9 条），是导航，不该占用和书一样的视觉权重。
 *
 *   · 书     → 书目行。左：封面或首字；中：书名 + 作者；右：格式与大小，
 *              等宽、右对齐成列。署名退成一个极小的标记，贴在作者后面 ——
 *              它是「谁传的」，不是作品信息，不该出现在视觉主体里。
 *
 * 右对齐的单据式数字列（格式 · 大小）是这一页的身份：它像一本印刷目录，
 * 而不是一个卡片瀑布。
 *
 * ⚠️ 以下两处 class 与属性顺序被测试锁死，改动会让测试变红：
 *   · <a class="card bookcard" href="${bookHref}"
 *   · <a class="card shelfcard" href="${davHref}"
 *   · bookHref 的三元写法 e.meta.downloadUrl ? esc(...) : davHref
 *   它们承载的是「书卡直连 R2，省一次 Worker 请求」这个预算约束。
 *
 * 注意：这是给人看的 HTML。WebDAV 客户端走 PROPFIND，不解析这里。
 */

import type { Entry } from './webdav/propfind';
import { themeCss } from './lib/theme';
import { encodeHref } from './lib/xml';

/** 格式 → 中文短标（不用 emoji，用文字） */
const FORMAT_LABEL: Record<string, string> = {
  epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', azw3: 'AZW3', txt: 'TXT',
  cbz: 'CBZ', cbr: 'CBR', fb2: 'FB2', djvu: 'DJVU', m4b: 'M4B', mp3: 'MP3',
  m4a: 'M4A', rtf: 'RTF', doc: 'DOC', docx: 'DOCX', md: 'MD', html: 'HTML',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 集合路径段 → 中文标签。路径段现在本身就是中文，这里同时兼容旧的英文链接 */
const COLLECTION_LABEL: Record<string, string> = {
  title: '按书名', author: '按作者', format: '按格式', recent: '最近收录',
  按书名: '按书名', 按作者: '按作者', 按格式: '按格式', 最近收录: '最近收录',
};

/** 桶名 → 展示名（other 桶装的是中文书，路径段已改为「其他」） */
function bucketName(b: string): string {
  return b === 'other' || b === '其他' ? '其他' : b;
}

/** 由 davPath 生成友好标题，避免把裸路径当标题 */
function friendlyTitle(davPath: string): string {
  const segs = davPath.split('/').filter(Boolean);
  if (segs.length === 0) return '全部藏书';
  const col = COLLECTION_LABEL[segs[0]!] ?? segs[0]!;
  if (segs.length === 1) return col;
  // 分页目录：/<collection>/<bucket>/<page>/
  const isLastPage = /^[1-9][0-9]{0,4}$/.test(segs[segs.length - 1]!);
  const bucket = isLastPage ? segs[segs.length - 2] : segs[segs.length - 1];
  const page = isLastPage ? segs[segs.length - 1] : null;
  // recent 的 bucket 恒为 'all'，不展示
  const showBucket = bucket && bucket !== 'all';
  return [col, showBucket ? bucketName(bucket!) : null, page ? `第 ${page} 页` : null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * 把 davPath 拆成面包屑层级（每段带累计链接）。
 * href 统一走 encodeHref 做百分号编码 —— 路径段是中文，且文件名可能含 `#`
 * 这类会截断 URL 的字符，不编码就会产生坏链。
 */
function crumbs(davPath: string, mountPath: string): string {
  const segs = davPath.split('/').filter(Boolean);
  const parts: string[] = [
    `<a href="/">书库首页</a>`,
  ];
  if (segs.length === 0) {
    parts.push(`<span class="sep">/</span><span class="here">全部藏书</span>`);
    return parts.join('');
  }
  parts.push(`<span class="sep">/</span><a href="${esc(mountPath)}/">全部藏书</a>`);
  let acc = '';
  segs.forEach((seg, i) => {
    acc += `/${seg}`;
    const isLast = i === segs.length - 1;
    // 末段可能是文件名（含扩展名），标签用原名；中间段是集合/桶/页码
    const label = COLLECTION_LABEL[seg] ?? seg;
    parts.push(`<span class="sep">/</span>`);
    if (isLast) {
      parts.push(`<span class="here">${esc(label)}</span>`);
    } else {
      parts.push(
        `<a href="${esc(mountPath)}${encodeHref(acc, true)}">${esc(label)}</a>`,
      );
    }
  });
  return parts.join('');
}

export function renderBrowsePage(
  davPath: string,
  entries: Entry[],
  mountPath: string,
  extra: { truncatedNote?: string } = {},
): string {
  const children = entries.filter((e) => e.path !== davPath);
  const collections = children.filter((e) => e.isCollection);
  const files = children.filter((e) => !e.isCollection);

  /** 子目录：目录索引行（编号 + 名称 + 「目录」）。 */
  const collectionsHtml = collections
    .map((e, i) => {
      const davHref = esc(`${mountPath}${encodeHref(e.path, e.isCollection)}`);
      const label = e.meta.displayName.replace(/\/$/, '');
      const n = String(i + 1).padStart(2, '0');
      // 右侧写「几本」而不是「目录」：
      // 每个子目录后面都跟着同一个词「目录」，等于什么都没说 ——
      // 而读者真正想知道的是「这一格里有几本书，值不值得点开」。
      // childCount 由 collectDavEntries 从 buckets 表直接带上来，
      // 不额外查询。缺席时（旧缓存）退回「目录」。
      // ⚠️ 「没有本数」和「零本」是两件不同的事，不能都渲染成「空」。
      //   根目录的五个集合刻意不带 childCount（算法要额外查一次 D1，
      //   而 PROPFIND / 是客户端挂载时打得最频繁的一枪），
      //   若把 undefined 当 0 显示，就会把「全部藏书」谎报成空的。
      const cc = e.meta.childCount;
      const meta = typeof cc !== 'number'
        ? ''
        : cc > 0
          ? `<span class="cn">${cc}</span><span class="cu">本</span>`
          : `<span class="cu">空</span>`;
      return `
      <a class="card shelfcard" href="${davHref}">
        <span class="sn" aria-hidden="true">${n}</span>
        <span class="ctitle">${esc(label)}</span>
        <span class="cmeta">${meta}</span>
      </a>`;
    })
    .join('\n');

  /** 书：书目行。左封面，中书名/作者/署名，右格式与大小。 */
  const filesHtml = files
    .map((e) => {
      // 服务器上的规范路径：百分号编码（路径段是中文，且文件名可能含 #
      // 之类会截断 URL 的字符）。回退分支用它。
      const davHref = esc(`${mountPath}${encodeHref(e.path, e.isCollection)}`);
      // 书卡直接指向 R2 公开域：点一次下载不再消耗一次 Worker 请求。
      // 这是免费套餐（10 万次/天）下最值钱的一处优化 —— 每次点击原本
      // 都要经过 Worker 拿一个 302，而那个 302 还带 no-store，缓存不上。
      //
      // ⚠️ 不能想当然：downloadUrl 缺席时必须回退到 /dav 路径。
      // 直接渲染 href="${e.meta.downloadUrl}" 会在 undefined 时产出
      // href="undefined" —— 一个相对路径，点击后跳到 /dav/undefined，
      // 比慢一点糟得多。目录卡永远走 /dav（它必须由 Worker 生成 HTML）。
      const bookHref = e.meta.downloadUrl
        ? esc(e.meta.downloadUrl)
        : davHref;
      const fmt = FORMAT_LABEL[e.meta.format ?? ''] ?? (e.meta.format ?? '').toUpperCase();
      const size = formatSize(e.meta.contentLength ?? 0);
      // 封面缺席时不留灰方块（那是「图挂了」的样子），也不写格式字母 ——
      // 格式在右列已经写清楚了，左边再写一遍「E」只是把一个空盒子填满。
      // 这里放**书名的第一个字**：它是这一行唯一还没被重复表达的信息。
      const initial = Array.from(e.meta.displayName.trim())[0] ?? '书';
      const cover = e.meta.coverUrl
        ? `<img src="${esc(e.meta.coverUrl)}" alt="" loading="lazy" decoding="async">`
        : `<span class="mk2" aria-hidden="true">${esc(initial)}</span>`;
      // 作者与署名合成一行：署名是「谁传的」，附在作者后面，不占独立一行。
      const byline = e.meta.author
        ? `<span class="cauthor">${esc(e.meta.author)}</span>`
        : '';
      const creditName = e.meta.credit || '雷锋';
      // ⚠️ 作者和上传者是同一个人时（上传时顺手填了自己的名字），
      //   渲染成「刘慈欣 · 刘慈欣」是纯噪音 —— 三体的那一行正是如此。
      //   同名就只留作者，不重复。
      const credit = byline && creditName === e.meta.author
        ? ''
        : `<span class="ccredit" title="上传：${esc(creditName)}">${esc(creditName)}</span>`;
      return `
      <a class="card bookcard" href="${bookHref}" title="${esc(e.meta.displayName)}">
        <span class="cover">${cover}</span>
        <span class="cbody">
          <span class="ctitle">${esc(e.meta.displayName)}</span>
          <span class="cline">${byline}${credit}</span>
        </span>
        <span class="cend"><b class="fmt">${esc(fmt)}</b><span class="csize">${size}</span></span>
      </a>`;
    })
    .join('\n');

  const hasAny = children.length > 0;
  const empty = `
    <div class="empty">
      <b>这一格还空着</b>
      <span>还没有书被放到这里。第一本可以由你来放。</span>
      <a class="btn btn-primary" href="/upload">上架一本</a>
    </div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<title>${esc(davPath)} — webooks</title>
<meta name="robots" content="noindex">
<style>
${themeCss()}
  /* ── 页头 ── */
  .count{
    margin-left:auto;font-size:var(--fz-sm);color:var(--paper-dim);
    font-variant-numeric:tabular-nums;
  }

  /* ── 两种视图 ── */
  .sec{margin-top:var(--s6)}
  .sec-head{
    display:flex;align-items:baseline;gap:var(--s3);
    padding-bottom:var(--s2);border-bottom:1px solid var(--rule-strong);
  }
  .sec-head h2{
    font-family:var(--serif);font-weight:400;font-size:.95rem;
    letter-spacing:.12em;color:var(--paper-dim);
  }

  /* ── 子目录：目录索引 ──
     单字母/单页的格子很少（按书名 13 个字母），一条一行会把页面拉成
     一页空表格。多列排布后它读起来像**索引页**，而不是数据集。
     auto-fill + minmax：列数随宽度走，13 条在桌面上排成 4 列 4 行。 */
  .dirs{
    display:grid;
    /* auto-fit 而不是 auto-fill：只有 2 个条目时（「按类型」就是
       漫画 + 电子书两条），auto-fill 会保留两列空轨道，把两条挤在
       左半边；auto-fit 把空轨道收掉，两条各占一半，读起来是一张表。 */
    grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));
    column-gap:var(--s6);
    border-bottom:1px solid var(--rule);
  }
  .shelfcard{
    display:grid;grid-template-columns:2.4rem minmax(0,1fr) auto;
    align-items:baseline;gap:var(--s4);
    padding:.62rem var(--s2);
    border-bottom:1px solid var(--rule);
    color:var(--paper);text-decoration:none;
    transition:background var(--dur) var(--ease),box-shadow var(--dur) var(--ease),
               border-bottom-color var(--dur) var(--ease);
  }
  .shelfcard:hover,.shelfcard:focus-visible{
    background:var(--wash);border-bottom-color:var(--edge-warm);
    box-shadow:inset 2px 0 0 var(--brass);
    text-decoration:none;color:var(--paper);
  }
  .sn{
    font-family:var(--mono);font-size:.72rem;color:var(--paper-faint);
    font-variant-numeric:tabular-nums;
  }
  .shelfcard:hover .sn{color:var(--brass)}
  .shelfcard .ctitle{font-family:var(--serif);font-size:1.05rem;letter-spacing:.05em}
  .shelfcard .cmeta{
    display:inline-flex;align-items:baseline;gap:.15em;
    font-family:var(--mono);font-size:.72rem;color:var(--paper-faint);
    letter-spacing:.06em;
  }
  /* 本数是这一行唯一的信息，用纸色而不是灰 —— 灰到看不见就等于没写 */
  .shelfcard .cn{color:var(--paper-dim);font-variant-numeric:tabular-nums}
  .shelfcard .cu{font-size:.68rem;color:var(--paper-faint)}

  /* ── 书：书目行 ──
     三列：封面 / 主体 / 右对齐的数字列。
     行与行之间只有一条纸色细线，没有边框、没有卡片底 ——
     15 本书排下来是一页目录，不是 15 个方框。 */
  .books{display:block;border-top:1px solid var(--rule)}
  .bookcard{
    display:grid;grid-template-columns:auto minmax(0,1fr) auto;
    align-items:center;gap:var(--s4);
    padding:var(--s3) var(--s2);
    border-bottom:1px solid var(--rule);
    color:var(--paper);text-decoration:none;
    transition:background var(--dur) var(--ease),box-shadow var(--dur) var(--ease),
               border-bottom-color var(--dur) var(--ease);
  }
  .bookcard:hover,.bookcard:focus-visible{
    background:var(--wash);border-bottom-color:var(--edge-warm);
    box-shadow:inset 2px 0 0 var(--brass);
    text-decoration:none;color:var(--paper);
  }
  .bookcard:hover .ctitle{color:var(--brass-lift)}

  /* 封面：小、竖、贴边。它是缩略图，不是主角。 */
  .cover{
    flex:0 0 auto;width:38px;height:52px;border-radius:1px;
    overflow:hidden;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(150deg,#1d2621,#131a16);
    border:1px solid var(--rule-strong);
  }
  .cover img{width:100%;height:100%;object-fit:cover;display:block}
  /* 无封面：格式首字母。字号够大（13px），不是一个看不清的小疙瘩。 */
  .mk2{
    font-family:var(--mono);font-size:.8rem;letter-spacing:0;
    color:var(--paper-dim);line-height:1;
  }

  .cbody{min-width:0;display:flex;flex-direction:column;gap:2px}
  .ctitle{
    font-family:var(--serif);font-size:1.02rem;letter-spacing:.01em;line-height:1.4;
    /* 最多两行，超出省略 —— 避免长书名破坏行节奏 */
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
    word-break:break-word;
  }
  /* 作者 + 署名同一行。署名是一个「谁传的」的小标记，
     用铜绿的极小字＋前置一个小方块，而不是一条横贯卡片的琥珀色条。 */
  .cline{display:flex;align-items:center;gap:var(--s2);min-width:0;flex-wrap:wrap}
  .cauthor{
    font-size:var(--fz-sm);color:var(--paper-dim);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;
  }
  .ccredit{
    display:inline-flex;align-items:center;gap:4px;
    font-size:.72rem;color:var(--jade);white-space:nowrap;flex:0 0 auto;
  }
  .ccredit::before{
    content:"";width:5px;height:5px;background:var(--jade-deep);
    border-radius:1px;flex:0 0 auto;
  }

  /* 右对齐的数字列：格式 + 大小。
     等宽、tabular-nums，让整列在垂直方向对齐 —— 这是目录的秩序感来源。 */
  .cend{
    display:flex;flex-direction:column;align-items:flex-end;gap:1px;
    text-align:right;flex:0 0 auto;
  }
  .cend .fmt{
    font-family:var(--mono);font-size:.72rem;font-weight:400;
    letter-spacing:.06em;color:var(--paper-dim);
  }
  .csize{
    font-family:var(--mono);font-size:.72rem;color:var(--paper-faint);
    font-variant-numeric:tabular-nums;white-space:nowrap;
  }

  /* ── 空状态：共用 .empty，只补一个按钮间距 ── */
  .empty .btn{margin-top:var(--s4)}
  .empty span{font-size:.9rem}

  /* ── 提示条 ── */
  .note{
    margin-top:var(--s5);padding:var(--s3) var(--s4);
    border-left:2px solid var(--jade-deep);background:var(--wash);
    font-size:var(--fz-sm);color:var(--paper-dim);
  }

  /* ── 响应式 ──
     手机上把「目录」和「大小」隐去：它们是补充信息，
     占地比它们传达的内容多。 */
  @media (max-width:640px){
    .bookcard{gap:var(--s3);padding:var(--s3) 0}
    .cover{width:34px;height:46px}
    .ctitle{font-size:.97rem}
    /* 大小不在手机上藏起来：48.8 MB 这类数字是「点不点开」的判断依据，
       而它只占约 50px 宽的一列。挤不下的其实只有格式名，所以改小一点。 */
    .cend{gap:0}
    .cend .fmt,.csize{font-size:.68rem}
    /* 手机上保留本数：它恰恰是「点不点开」的判断依据，
       不该和装饰性的「目录」二字一起被藏掉。 */
    .dirs{grid-template-columns:1fr;border-bottom:0}
    .shelfcard{grid-template-columns:1.9rem minmax(0,1fr) auto;gap:var(--s3)}
  }
</style></head>
<body>
<div class="wrap">

  <div class="bar-head">
    <span class="mk"><a href="/">we·books</a></span>
    <span class="count">${children.length} 项${extra.truncatedNote ? ` · ${esc(extra.truncatedNote)}` : ''}</span>
  </div>

  <nav class="crumbs" aria-label="面包屑">${crumbs(davPath, mountPath)}</nav>

  <h1>${esc(friendlyTitle(davPath))}</h1>

  ${hasAny ? `
  ${collections.length ? `<section class="sec dirs">
${collectionsHtml}
  </section>` : ''}
  ${files.length ? `<section class="sec books">
${filesHtml}
  </section>` : ''}` : empty}

  ${extra.truncatedNote ? `<p class="note">只显示本页条目。用下一页继续，或用 WebDAV 客户端挂载获取完整列表。</p>` : ''}

  <footer class="site-foot">
    <span class="lamps" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>webooks · 匿名开放</span>
    <a href="/">首页</a>
    <a href="/upload">上架一本</a>
    <a href="${esc(mountPath)}/">根目录</a>
  </footer>

</div>
</body></html>`;
}
