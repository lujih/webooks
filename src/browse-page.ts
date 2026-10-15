/**
 * 浏览器目录页（GET /dav/**）—— 「深夜图书馆」书架视图。
 *
 * 上一版是裸 <ul> + 浅色主题，与首页完全割裂。这一版：
 *   · 复用 lib/theme 的设计 token，与首页/上传页同一套语言
 *   · 面包屑导航（每段可点，回到上级/首页）
 *   · 文件卡片显示真实 EPUB 封面（有封面时）+ 书名 + 作者 + 格式 + 大小
 *   · 集合卡片用「抽屉」形态（书脊 + 名称 + 数量暗示）
 *   · 空状态、分页导航、键盘可达、对比度达标
 *
 * 注意：这是给人看的 HTML。WebDAV 客户端走 PROPFIND，不解析这里。
 */

import type { Entry } from './webdav/propfind';
import { themeCss } from './lib/theme';
import { encodeHref } from './lib/xml';

/** 格式 → 中文短标（不用 emoji，用文字/矢量） */
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

  const gridOf = (list: Entry[]): string =>
    list
      .map((e, i) => {
        // encodeHref 做百分号编码：路径段是中文，且文件名可能含 # 之类会截断 URL 的字符
        const href = esc(`${mountPath}${encodeHref(e.path, e.isCollection)}`);
        const delay = `calc(.05s + ${i} * .035s)`;
        if (e.isCollection) {
          const label = e.meta.displayName.replace(/\/$/, '');
          return `
      <a class="card shelfcard" href="${href}" style="animation-delay:${delay}">
        <span class="shelfmark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l.8 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        </span>
        <span class="cbody">
          <span class="ctitle">${esc(label)}</span>
          <span class="cmeta">目录</span>
        </span>
      </a>`;
        }
        const cover = e.meta.coverUrl
          ? `<img src="${esc(e.meta.coverUrl)}" alt="" loading="lazy" decoding="async">`
          : `<span class="nocover">${esc(FORMAT_LABEL[e.meta.format ?? ''] ?? (e.meta.format ?? '').toUpperCase() ?? '书')}</span>`;
        const fmt = FORMAT_LABEL[e.meta.format ?? ''] ?? (e.meta.format ?? '').toUpperCase();
        const size = formatSize(e.meta.contentLength ?? 0);
        const author = e.meta.author ? `<span class="cauthor">${esc(e.meta.author)}</span>` : '';
        // 署名：留名上传的显示真实名字，其余显示「雷锋」（服务端已归一，
        // 这里只做兜底 —— 数据可能是迁移前的老行，credit 为 null）
        const creditName = e.meta.credit || '雷锋';
        const credit = `<span class="ccredit" title="上传：${esc(creditName)}">${esc(creditName)}</span>`;
        return `
      <a class="card bookcard" href="${href}" style="animation-delay:${delay}" title="${esc(e.meta.displayName)}">
        <span class="cover">${cover}</span>
        <span class="cbody">
          <span class="ctitle">${esc(e.meta.displayName)}</span>
          ${author}
          ${credit}
          <span class="cmeta"><b class="fmt">${esc(fmt)}</b> · ${size}</span>
        </span>
      </a>`;
      })
      .join('\n');

  const hasAny = children.length > 0;
  const empty = `
    <div class="empty">
      <div class="emptymark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h7a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-3a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H20z"/></svg>
      </div>
      <p class="emptytitle">这一格还空着</p>
      <p class="emptysub">还没有书被放到这里。</p>
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
  .bar-head{display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;margin-bottom:var(--s2)}
  .mk{font-family:var(--serif);font-size:1.05rem;letter-spacing:.3em;color:var(--glow)}
  .mk a{color:inherit;text-decoration:none}
  .count{margin-left:auto;font-size:.78rem;color:var(--paper-dim);font-family:var(--serif);letter-spacing:.08em}
  h1{
    font-family:var(--serif);font-weight:400;
    font-size:clamp(1.5rem,4vw,2.1rem);letter-spacing:.03em;
    word-break:break-word;margin-bottom:var(--s5);
  }

  /* ── 卡片网格 ── */
  .grid{
    display:grid;gap:var(--s3);
    grid-template-columns:repeat(auto-fill,minmax(300px,1fr));
  }
  .card{
    display:flex;align-items:center;gap:var(--s3);
    min-height:76px;padding:var(--s3);
    background:linear-gradient(160deg,var(--ink-2) 0%,#120f0c 100%);
    /* 卡片本身是链接（交互元素），边框必须满足 WCAG 1.4.11 的 3:1 */
    border:1px solid var(--line);border-radius:var(--r2);
    color:var(--paper);text-decoration:none;
    position:relative;overflow:hidden;
    opacity:0;transform:translateY(12px);
    animation:up .5s var(--ease) forwards;
    transition:transform var(--dur) var(--ease),border-color var(--dur) var(--ease),
               background var(--dur) var(--ease);
    /* 触控目标远超 44px */
  }
  .card::before{ /* 烛光扫过 */
    content:"";position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(105deg,transparent 32%,rgba(255,190,90,.09) 50%,transparent 68%);
    transform:translateX(-130%);transition:transform .65s var(--ease);
  }
  .card:hover,.card:focus-visible{
    transform:translateY(-2px);border-color:var(--glow);
    background:linear-gradient(160deg,var(--ink-3) 0%,#161209 100%);
    text-decoration:none;color:var(--paper);
  }
  .card:hover::before,.card:focus-visible::before{transform:translateX(130%)}

  /* 目录卡 */
  .shelfmark{
    flex:0 0 auto;width:44px;height:56px;border-radius:var(--r1) var(--r2) var(--r2) var(--r1);
    background:linear-gradient(90deg,#3a2e1f 0%,#5a4326 55%,#3a2e1f 100%);
    display:flex;align-items:center;justify-content:center;color:var(--glow);
    box-shadow:inset -3px 0 6px rgba(0,0,0,.5),2px 3px 8px rgba(0,0,0,.35);
    border-left:2px solid rgba(255,180,77,.45);
  }

  /* 书卡封面 */
  .cover{
    flex:0 0 auto;width:46px;height:62px;border-radius:var(--r1);
    overflow:hidden;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(150deg,#2a231a,#181410);
    border:1px solid var(--line-soft);
    box-shadow:2px 3px 10px rgba(0,0,0,.45);
  }
  .cover img{width:100%;height:100%;object-fit:cover;display:block}
  .nocover{
    font-family:var(--mono);font-size:.6rem;letter-spacing:.04em;
    color:var(--paper-dim);text-align:center;padding:2px;word-break:break-all;line-height:1.3;
  }

  .cbody{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
  .ctitle{
    font-family:var(--serif);font-size:1rem;letter-spacing:.02em;line-height:1.35;
    /* 标题最多两行，超出省略 —— 避免破坏网格节奏 */
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
    word-break:break-word;
  }
  .cauthor{font-size:.8rem;color:var(--paper-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 署名：刻意做得比作者更淡 —— 它是「谁传的」，不是作品信息。

     用方角（--r1）而不是胶囊：整个站是纸与木的方正语汇，
     胶囊只留给两个地方 —— 上传进度条（4px 高，胶囊是唯一合理形状）
     与首页的集体署名行。 */
  .ccredit{
    display:inline-block;margin-top:.3rem;padding:0 .4rem;font-size:.72rem;
    color:var(--glow);background:rgba(255,180,77,.09);
    border-left:2px solid rgba(255,180,77,.45);
    max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .cmeta{font-size:.75rem;color:var(--paper-dim);font-family:var(--mono);letter-spacing:.02em}
  .cmeta .fmt{color:var(--glow);font-weight:600}

  /* ── 空状态 ── */
  .empty{
    display:flex;flex-direction:column;align-items:center;gap:var(--s2);
    padding:var(--s8) var(--s4);text-align:center;
    border:1px dashed var(--line);border-radius:var(--r3);
    color:var(--paper-dim);
  }
  .emptymark{color:var(--glow);opacity:.75}
  .emptytitle{font-family:var(--serif);font-size:1.15rem;color:var(--paper);letter-spacing:.06em}
  .emptysub{font-size:.88rem;margin-bottom:var(--s3)}

  /* ── 提示条 ── */
  .note{
    margin-top:var(--s5);padding:var(--s3) var(--s4);
    border-left:2px solid var(--glow);background:rgba(255,180,77,.06);
    border-radius:0 var(--r1) var(--r1) 0;
    font-size:.85rem;color:var(--paper-dim);
  }

  /* ── 移动端 ── */
  @media (max-width:560px){
    .grid{grid-template-columns:1fr}
    .ctitle{font-size:.95rem}
  }
</style></head>
<body>
<div class="wrap">

  <div class="bar-head reveal" style="animation-delay:.03s">
    <span class="mk"><a href="/">we·books</a></span>
    <span class="count">${children.length} 项${extra.truncatedNote ? ` · ${esc(extra.truncatedNote)}` : ''}</span>
  </div>

  <nav class="crumbs reveal" style="animation-delay:.08s" aria-label="面包屑">${crumbs(davPath, mountPath)}</nav>

  <h1 class="reveal" style="animation-delay:.12s">${esc(friendlyTitle(davPath))}</h1>

  ${hasAny ? `<div class="grid">
${collections.length ? gridOf(collections) : ''}
${files.length ? gridOf(files) : ''}
  </div>` : empty}

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
