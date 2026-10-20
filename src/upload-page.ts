/**
 * 上传页（/upload）—— 支持批量。
 *
 * 单文件、无构建步骤，内联 CSS/JS，直接由 Worker 提供。
 * 复用 lib/theme 的设计系统（「开架目录」），与首页/目录页同一套视觉语言。
 *
 * 每个文件的流程：
 *   人机验证取令牌 → init 拿预签名 URL → 浏览器直传 R2（进度）→ complete 登记元数据
 *
 * 批量上传的关键难点：**Turnstile 令牌是一次性的**。
 * 传 N 个文件就需要 N 个令牌，所以要维护一个「令牌队列」：
 * 用完一个就 reset 组件领下一个，失败时也要换新的（否则重试必然 403）。
 * 这里选择**串行**上传：令牌天然是串行的，串行也让进度和错误归属清晰。
 */

import { ALLOWED_UPLOAD_FORMATS, EBOOK_FORMATS, COMIC_FORMATS } from './lib/collections';
import { themeCss } from './lib/theme';

// mountPath 有默认值：测试直接调 uploadHtml(null) 不传第二参，
// 而页脚那条「进入书库」链接必须是真实的挂载路径（可以配成根挂载 ''）。
export function uploadHtml(turnstileSiteKey: string | null, mountPath = '/dav'): string {
  // accept 用归一化后的格式列表；浏览器据此过滤文件选择框
  const accept = ALLOWED_UPLOAD_FORMATS.map((f) => `.${f}`).join(',');
  // 格式：主格式在前（EPUB / PDF / CBZ 是绝大多数），其余弱色跟着。
  // 22 个格式全列出来是信息过载 —— 访客要的是「我这种行不行」，
  // 不是一张格式表。完整白名单在 accept 属性与后端校验里。
  const formatMain = EBOOK_FORMATS.slice(0, 3).concat(COMIC_FORMATS.slice(0, 1))
    .map((f) => f.toUpperCase()).join(' / ');
  const formatMore = '等 ' + ALLOWED_UPLOAD_FORMATS.length + ' 种';
  // 页脚「进入书库」：指向书库根目录。mountPath 可以是空串（根挂载），
  // 那样书库根就是站点根 '/', 否则是 '/dav/'。两种都要正确。
  const mountHref = mountPath === '' ? '/' : `${mountPath}/`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<title>上架书籍 · webooks</title>
<style>
${themeCss()}

  /* ── 页头（theme 里的 .bar-head / .mk / .back / h1 直接用，不再各写一套） ── */
  .sub{color:var(--paper-dim);font-size:var(--fz-sm);line-height:1.9;max-width:40rem;margin-bottom:var(--s6)}
  .sub b{color:var(--paper);font-weight:600}

  /* ── 拖放区 ──
     不是一个大虚线框：先用一条实线起头，标题写在左上，
     说明在下面，右端是「选择文件」这个动作。虚线只画在真正
     「把东西丢进来」的那块区域上，把它压到下方一行高的窄条里。 */
  /* 不用整块底色：深色底会让人把这块读成「一个容器」，
     而它其实只是一块可点的区域。改成一条暖色顶线 + 一条底线，
     里面是纸。 */
  /* 底色只铺到标题那一行，说明文字落在纸面上 ——
     深色块在说明文字下方断掉，那块深色就成了一个无意义的形状。
     底边不画线：下一段 .meta 的顶线就是它的收口（两条线不叠）。 */
  .dropwrap{
    border-top:2px solid var(--brass);
    background:linear-gradient(180deg,var(--wash-warm) 0%,transparent 100%);
    padding-bottom:var(--s2);
  }
  #drop{
    display:grid;grid-template-columns:minmax(0,1fr) auto;
    align-items:center;gap:var(--s4) var(--s5);
    padding:var(--s5) var(--s5) var(--s4) var(--s4);
    cursor:pointer;
  }
  #drop:hover{background:rgba(220,168,95,.1)}
  #drop.drag,#drop.over{background:rgba(220,168,95,.16)}
  #drop:focus-visible{outline:2px solid var(--brass);outline-offset:-3px}
  .droptitle{
    font-family:var(--serif);font-size:var(--fz-lg);letter-spacing:.03em;
    color:var(--paper);line-height:1.5;
  }
  .droptitle em{font-style:normal;color:var(--brass);border-bottom:1px solid var(--edge-warm)}
  /* 两句各自成行：句号处正是语义边界。
     之前是一整段让浏览器自己断，结果 390px 上末行只剩「式。」两个字
     （28px 宽）—— text-wrap: pretty 在当前 Chromium 不生效，手动断句更可靠。 */
  .dropsub{
    grid-column:1/-1;font-size:var(--fz-sm);color:var(--paper-dim);line-height:1.7;
    margin-top:calc(-1 * var(--s2));
    display:flex;flex-direction:column;gap:.1rem;
  }
  /* 「选择文件」是这一页唯一的主按钮，所以它是唯一的实心黄铜 */
  .droppick{
    display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);
    min-height:44px;padding:.6rem 1.2rem;
    font:inherit;font-size:var(--fz-sm);font-weight:600;white-space:nowrap;
    background:var(--brass);color:#0b100e;
    border:1px solid var(--brass);border-radius:var(--r1);
    cursor:pointer;
    transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease);
  }
  .droppick:focus-visible{outline:2px solid var(--brass-lift);outline-offset:3px}
  #drop:hover .droppick{background:var(--brass-lift);border-color:var(--brass-lift)}
  .dropmark{display:none}
  input[type=file]{display:none}

  /* ── 留名：可选，视觉上必须弱于拖放区 ──
     它与「接受格式」并排成两列，而不是各自占一整行 ——
     这两条都是附注，不该把主操作推下去。 */
  .meta{
    display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);
    gap:var(--s4) var(--s6);margin-top:var(--s5);
    padding-top:var(--s4);border-top:1px solid var(--rule);
  }
  .field{display:flex;flex-direction:column;gap:var(--s1);min-width:0}
  .field label{font-size:var(--fz-sm);color:var(--paper-dim);letter-spacing:.04em}
  .field .tip{font-size:var(--fz-xs);color:var(--paper-faint)}
  #credit{
    width:100%;min-height:44px;padding:.5rem 0;
    font:inherit;font-size:var(--fz-md);color:var(--paper);
    background:transparent;border:0;border-radius:0;
    border-bottom:1px solid var(--edge);
    transition:border-bottom-color var(--dur) var(--ease);
  }
  #credit:hover{border-bottom-color:var(--brass)}
  #credit:focus{outline:none;border-bottom-color:var(--brass)}
  #credit:focus-visible{outline:2px solid var(--brass);outline-offset:4px}

  /* ── 接受格式 ──
     上一版是 16 个小方块。那是全页最碎的元素，而且它和「留个名」
     并排 —— 两件附注抢了同等的视觉权重。
     现在收成一行：主格式在前，完整清单在后面以弱色跟着。
     格式是**约束**，不是需要读的内容。 */
  .fmtlabel{font-size:var(--fz-sm);color:var(--paper-dim);letter-spacing:.04em}
  /* 标签与值同一行内连着，值和「等 N 种」之间只差一点点 */
  .fmtline{display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
  .fmtmain{
    font-family:var(--mono);font-size:var(--fz-xs);color:var(--paper-dim);
    letter-spacing:.03em;
  }
  .fmtmore{
    font-family:var(--mono);font-size:var(--fz-micro);color:var(--paper-faint);
    letter-spacing:.03em;margin-left:.5em;
  }

  /* ── 队列 ── */
  #queueWrap{margin-top:var(--s7);display:none}
  #queueWrap.show{display:block}
  #queueWrap>.qhead{
    display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;
    padding-bottom:var(--s2);border-bottom:1px solid var(--rule-strong);
  }
  .qhead .qt{font-family:var(--serif);font-size:var(--fz-sm);letter-spacing:.12em;color:var(--paper-dim)}
  .qhead .qs{font-size:var(--fz-xs);color:var(--paper-faint);margin-left:auto;font-variant-numeric:tabular-nums}
  /* 总进度：一条细线，不是一根胶囊。走黄铜。 */
  .qbar{height:2px;background:var(--rule);overflow:hidden;margin-bottom:var(--s4)}
  .qbar>i{display:block;height:100%;width:0;background:var(--brass);transition:width .3s var(--ease)}

  ul.q{list-style:none;display:block;border-top:1px solid var(--rule)}
  li.qi{
    display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;
    gap:var(--s2) var(--s3);
    padding:.6rem 0;border-bottom:1px solid var(--rule);
  }
  .qmark{
    width:1.5rem;height:1.5rem;flex:0 0 auto;margin-top:1px;
    display:flex;align-items:center;justify-content:center;
    font-family:var(--mono);font-size:var(--fz-micro);
    color:var(--paper-faint);border:1px solid var(--rule-strong);border-radius:var(--r1);
  }
  li.qi.uploading .qmark{border-color:var(--brass);color:var(--brass)}
  li.qi.done .qmark{border-color:var(--jade-deep);color:var(--jade);background:rgba(143,179,164,.1)}
  li.qi.error .qmark{border-color:rgba(239,139,124,.5);color:var(--er)}
  li.qi.skip{opacity:.55}
  .qbody{min-width:0;display:flex;flex-direction:column;gap:1px}
  .qname{font-size:var(--fz-sm);word-break:break-all;line-height:1.45}
  .qsub{font-family:var(--mono);font-size:var(--fz-micro);color:var(--paper-dim);line-height:1.6;word-break:break-word}
  .qsub.err{color:var(--er)}
  .qsub.ok{color:var(--jade)}
  /* 单文件进度：1px 细线，不再是一条会撑宽的胶囊 */
  .qbar2{height:1px;background:var(--rule);overflow:hidden;margin-top:4px;display:none}
  li.qi.uploading .qbar2{display:block}
  .qbar2>i{display:block;height:100%;width:0;background:var(--brass);transition:width .2s var(--ease)}
  .qcover{
    grid-row:1/3;grid-column:1;width:34px;height:46px;flex:0 0 auto;
    border-radius:1px;overflow:hidden;background:var(--ink-2);
    border:1px solid var(--rule-strong);
  }
  .qcover img{width:100%;height:100%;object-fit:cover;display:block}
  /* 有封面时把序号让出去，封面占第一列 */
  li.qi:has(.qcover){grid-template-columns:auto minmax(0,1fr)}
  li.qi:has(.qcover) .qmark{display:none}

  /* ── 消息 ── */
  .msg{margin-top:var(--s4);font-size:var(--fz-sm);display:none;line-height:1.75}
  .msg.show{display:block}
  .msg.err{color:var(--er)}
  .msg.ok{color:var(--ok)}
  .msg.info{color:var(--paper-dim)}

  /* ── 按钮区 ── */
  .actions{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-top:var(--s4)}
  #ts{margin-top:var(--s5);min-height:0}

  /* ── 提示 ── */
  .fineprint{
    margin-top:var(--s8);padding-top:var(--s4);
    border-top:1px solid var(--rule);
    font-size:var(--fz-xs);color:var(--paper-dim);line-height:1.8;max-width:44rem;
  }
  .fineprint b{color:var(--paper);font-weight:600}

  @media (max-width:640px){
    /* 手机上按钮夹在标题与说明之间，把一句话劈成两截。
       顺序改成「标题 → 说明 → 按钮」，读起来是一句完整的话。 */
    #drop{grid-template-columns:1fr;gap:var(--s3);padding:var(--s4) var(--s4) var(--s5)}
    .droptitle{order:1}
    .dropsub{order:2}
    .droppick{order:3;justify-self:start;margin-top:var(--s1)}
    .meta{grid-template-columns:1fr}
  }
</style></head>
<body>
<div class="wrap">

  <div class="bar-head">
    <span class="mk"><a href="/">we·books</a></span>
    <a class="back" href="/">回到书库</a>
  </div>

  <h1>上架书籍</h1>
  <p class="sub">
    可以<b>一次选多本</b>。文件<b>直传 Cloudflare R2</b>，不经服务器中转；
    EPUB 会自动解析出真实封面、书名与作者。传完立刻能在 WebDAV 客户端与浏览器书架里看到。
  </p>

  <div class="dropwrap">
    <div id="drop" role="button" tabindex="0" aria-label="选择要上传的书籍文件，可多选">
      <div class="droptitle">把书拖到这里，或 <em id="pick">从电脑里选</em></div>
      <!-- 真 <button>：原来这是个 <span aria-hidden="true"> ——
           全页唯一看起来像按钮的东西读屏完全听不到，键盘也走不到。
           #drop 本身是 role="button" 的整块区域，Enter/Space 也能开文件框，
           但里面这个视觉主角必须是可聚焦的真按钮。 -->
      <button class="droppick" type="button" id="pickbtn">选择文件</button>
      <div class="dropsub"><span>支持一次多选、连续拖入。</span><span>只接受电子书与漫画格式。</span></div>
      <input type="file" id="file" multiple accept="${accept}">
    </div>
  </div>

  <!-- 留名：可选。留空统一记作「雷锋」（见 migrations/0007 的说明）

       ⚠️ 必须在 #drop **外面**。#drop 是 role="button" 的整块区域，
          任何落在它内部的点击都会打开文件选择器 ——
          而「在输入框里打字」正好是一次点击。
          （曾经放在 #drop 内部，于是点输入框就弹文件框，一个字都输不进去。
            这个 bug 只在真浏览器里看得见；结构测试查不出来，
            所以下面 pages-syntax.test.ts 里有一条断言盯着它。） -->
  <div class="meta">
    <div class="field">
      <label for="credit">留个名 <span class="tip">会显示在书卡上</span></label>
      <input id="credit" maxlength="32" placeholder="留空记作「雷锋」" autocomplete="nickname">
      <span class="tip">不填也行 —— 匿名上传统一记作「雷锋」，那是集体署名，不是没人。</span>
    </div>
    <div class="field">
      <span class="fmtlabel">接受格式</span>
      <span class="fmtline">
        <span class="fmtmain">${formatMain}</span>
        <span class="fmtmore">${formatMore}</span>
      </span>
    </div>
  </div>

  <div id="queueWrap">
    <div class="qhead">
      <span class="qt">上传队列</span>
      <span class="qs" id="qstat" role="status" aria-live="polite"></span>
    </div>
    <div class="qbar"><i id="qbar"></i></div>
    <ul class="q" id="queue"></ul>
    <div class="actions">
      <button class="btn btn-primary" id="go">开始上传</button>
      <button class="btn" id="retry" hidden>重试失败的</button>
      <button class="btn" id="clear">清空队列</button>
      <button class="btn" id="addmore">继续添加</button>
    </div>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </div>

  <!-- 人机验证容器。没配 siteKey 时整个隐藏，避免留一块空白 -->
  <div id="ts"${turnstileSiteKey ? '' : ' hidden'}></div>

  <p class="fineprint">
    这个书库是<b>匿名开放</b>的：任何人都能上传与下载，上传后自动上架、不经人工审核。<br>
    请勿上传你无权分发的作品。若文件涉及侵权，请联系站点管理员移除。
  </p>

  <footer class="site-foot">
    <span class="lamps" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>webooks · 匿名开放</span>
    <a href="/">首页</a>
    <a href="/requests">求书墙</a>
    <a href="${mountHref}">进入书库</a>
  </footer>

</div>

<script>
const $ = (id) => document.getElementById(id);
const creditEl = $('credit');
// BR = 换行符。用它而不是在字符串里写「反斜杠 + n」，是因为本文件
// 整体是一个模板字符串：那个组合会在渲染成页面时被解析成真实换行，
// 把 JS 字符串字面量拦腰截断。TS 完全检查不出来，只有页面脚本会炸。
const BR = String.fromCharCode(10);
const ACCEPT = ${JSON.stringify(ALLOWED_UPLOAD_FORMATS)};
let siteKey = ${JSON.stringify(turnstileSiteKey)};
// 是否需要人机验证。与服务端同一个判断依据：**有没有配 siteKey**。
// 两边不一致会导致「前端弹框、后端不要」的错位，所以刻意用同一个信号。
const NEED_TURNSTILE = !!siteKey;

// 队列项：{ file, status: waiting|uploading|done|error|skip, pct, error, result }
let queue = [];
let running = false;

const drop = $('drop'), fileInput = $('file');
// 第二道防线：即使将来有人把这个元素挪回 #drop 内部，点它也不会弹文件框。
//
// #drop 是一整块 role="button" 区域，onclick 会触发 fileInput.click()。
// 任何**可交互**的元素落在它内部都会被吞掉这次点击 —— 输入框、按钮、
// 甚至复选框。真实的 bug：留名输入框曾放在 #drop 里，于是点它就弹文件
// 选择器，一个字都输不进去。
//
// 为什么保留 stopPropagation 而不是只靠 DOM 结构：
//   · 结构正确是「约定」，约定会被下一个人打破
//   · 这里成本极低（一行），而失效后果是「输入框完全不能用」
const INTERACTIVE = 'input,button,select,textarea,a,label,[contenteditable]';
drop.onclick = (e) => {
  if (e.target && e.target.closest && e.target.closest(INTERACTIVE)) return;
  fileInput.click();
};
// 键盘路径同理：焦点在内部控件上时，Enter 应交给那个控件
drop.addEventListener('keydown', (e) => {
  if (e.target !== drop) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); fileInput.click(); }
});
$('pick').onclick = (e) => { e.stopPropagation(); fileInput.click(); };
// 真按钮：stopPropagation 防止 #drop 的 onclick 重复触发（fileInput.click() 两次）
$('pickbtn').onclick = (e) => { e.stopPropagation(); fileInput.click(); };
$('addmore').onclick = () => fileInput.click();

['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag','over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag','over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };

function fmtSize(b){ if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; if(b<1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB'; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/** 取扩展名（小写、不含点）。刻意不用正则，避免模板字符串吃掉转义反斜杠。 */
function extOf(name){
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// 与后端 deriveMetadata 同规则的轻量版，用于上传前预览
function derive(name){
  const i = name.lastIndexOf('.'), ext = extOf(name);
  let stem = (i>0?name.slice(0,i):name).replace(/_+/g,' ').trim();
  let author = null;
  for(const sep of [' - ',' – ',' — ',' by ']){ const k=stem.indexOf(sep); if(k>0&&k<stem.length-sep.length){ author=stem.slice(0,k).trim(); stem=stem.slice(k+sep.length).trim(); break; } }
  return { ext, title: stem||name, author };
}

/** 加入队列。格式不合规的直接标成 skip，不上传（前端先拦，反馈更快）。 */
function addFiles(list){
  if(running){ msg('正在上传中，请等这一批结束再添加', 'err'); return; }
  for(const f of list){
    const ext = extOf(f.name);
    // 同一批里同名同大小视为重复，避免误拖两次
    const dup = queue.some(q => q.file.name === f.name && q.file.size === f.size);
    if(dup) continue;
    const ok = ACCEPT.indexOf(ext) >= 0;
    queue.push({
      file: f,
      status: ok ? 'waiting' : 'skip',
      pct: 0,
      error: ok ? null : ('不支持的格式 .' + (ext || '(无扩展名)') + '，只接受电子书与漫画'),
      result: null,
    });
  }
  render();
  if(!running) msg('', '');
}

function render(){
  $('queueWrap').classList.add('show');
  const ul = $('queue');
  ul.innerHTML = queue.map((q, i) => {
    const d = derive(q.file.name);
    const mark = q.status==='done' ? '✓' : q.status==='error' ? '!' : q.status==='skip' ? '—' : (q.status==='uploading' ? '↑' : String(i+1));
    let sub = fmtSize(q.file.size) + ' · ' + (d.ext.toUpperCase() || '?');
    if(q.status==='uploading') sub += ' · 上传中 ' + Math.round(q.pct*100) + '%';
    if(q.status==='done') sub += ' · ✅ 已上架' + (q.result && q.result.title ? '：《' + q.result.title + '》' : '');
    if(q.status==='error') sub += ' · ❌ ' + (q.error || '失败');
    if(q.status==='skip') sub += ' · 已跳过';
    const subCls = q.status==='error' ? ' err' : (q.status==='done' ? ' ok' : '');
    const cover = (q.result && q.result.coverUrl)
      ? '<span class="qcover"><img src="' + escapeHtml(q.result.coverUrl) + '" alt="" loading="lazy"></span>'
      : '';
    return '<li class="qi ' + q.status + '">'
      + '<span class="qmark" aria-hidden="true">' + mark + '</span>'
      + cover
      + '<span class="qbody">'
      +   '<span class="qname">' + escapeHtml(q.file.name) + '</span>'
      +   '<span class="qsub' + subCls + '">' + escapeHtml(sub) + '</span>'
      +   '<span class="qbar2"><i style="width:' + Math.round(q.pct*100) + '%"></i></span>'
      + '</span>'
      + '</li>';
  }).join('');

  const total = queue.length;
  const done = queue.filter(q => q.status==='done').length;
  const fail = queue.filter(q => q.status==='error').length;
  const skip = queue.filter(q => q.status==='skip').length;
  const workable = queue.filter(q => q.status==='waiting' || q.status==='uploading').length;

  $('qbar').style.width = total ? (Math.round(((done+fail+skip)/total)*100) + '%') : '0%';
  $('qstat').textContent = total
    ? ('共 ' + total + ' 本 · 完成 ' + done + (fail?(' · 失败 '+fail):'') + (skip?(' · 跳过 '+skip):''))
    : '';
  $('go').disabled = running || workable === 0;
  $('go').textContent = running ? '上传中…' : (done > 0 && workable === 0 ? '再传一次' : '开始上传');
  $('retry').hidden = fail === 0 || running;
  $('addmore').disabled = running;
}

function msg(text, cls){ const m=$('msg'); m.textContent=text; m.className='msg'+(text?' show ':' ')+(cls||''); }

// ── 人机验证：一批只验证一次 ──────────────────────────────────────────
//
// Turnstile 令牌是**一次性**的。如果每本书都去领一个新令牌，用户就会
// 「传一本弹一次验证」—— 传 10 本要点 10 次，没法用（真实反馈）。
//
// 所以改成：第一次上传带一次性令牌，服务端验完**回一张限时通行证**；
// 这一批剩下的文件都用通行证，不再打扰用户。通行证过期（10 分钟）或
// 失效时才重新走一次验证。
//
// 同时把 widget 设成 interaction-only：正常用户根本看不到验证框，
// 只有 Cloudflare 判定可疑时才弹出来要求交互。

let ticket = null;       // 批量通行证（服务端签发，限时 + 绑定 IP）
let bufferedToken = null;
let tokenWaiter = null;

function onToken(t){
  if(tokenWaiter){ const r = tokenWaiter; tokenWaiter = null; r(t); }
  else bufferedToken = t;
}

/** 取一个一次性令牌；没有就 reset 组件向 Turnstile 要一个新的。 */
function takeToken(timeoutMs){
  if(bufferedToken){ const t = bufferedToken; bufferedToken = null; return Promise.resolve(t); }
  return new Promise((resolve, reject) => {
    tokenWaiter = resolve;
    try {
      if(window.turnstile && typeof window.turnstile.reset === 'function') window.turnstile.reset();
    } catch(e){ /* 忽略：下面有超时兜底 */ }
    setTimeout(() => {
      if(tokenWaiter === resolve){
        tokenWaiter = null;
        reject(new Error('人机验证超时。请确认页面上的验证组件已通过；若被拦截插件挡住，请对本站关闭拦截后刷新'));
      }
    }, timeoutMs || 60000);
  });
}

function loadTurnstile(){
  return new Promise((resolve, reject) => {
    if(!siteKey){ reject(new Error('服务器未配置 Turnstile（缺少 TURNSTILE_SITE_KEY），上传不可用')); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Turnstile 脚本加载失败（可能被网络拦截）'));
    document.head.appendChild(s);
  });
}
async function renderWidget(){
  // 人机验证默认关闭（服务端 UPLOAD_REQUIRE_TURNSTILE 控制）。
  // 关闭时连脚本都不加载 —— 省一次外部请求，也让上传页在
  // 「域名没在 Turnstile 控制台登记」时依然完全可用。
  if(!NEED_TURNSTILE){
    $('go').disabled = false;
    msg('直接点「开始上传」即可', 'info');
    return;
  }
  await loadTurnstile();
  window.turnstile.render('#ts', {
    sitekey: siteKey,
    // interaction-only：正常用户看不到验证框，只有被判可疑时才弹出来要求交互
    appearance: 'interaction-only',
    callback: onToken,
    'expired-callback': () => { bufferedToken = null; },
    'error-callback': () => { /* 交给 takeToken 的超时兜底 */ },
  });
}

// ── 单文件上传 ────────────────────────────────────────────────────────
// 用 XHR 以获得上传进度
function putToR2(url, blob, contentType, onProgress){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if(contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if(e.lengthComputable && onProgress) onProgress(e.loaded/e.total); };
    xhr.onload = () => { if(xhr.status>=200&&xhr.status<300) resolve(); else reject(new Error('R2 直传被拒绝 HTTP '+xhr.status)); };
    // onerror 拿不到具体原因（CSP 拦截、插件拦截、断网都会走到这里），
    // 所以给一条能实际解决问题的提示，而不是笼统的「网络中断」。
    xhr.onerror = () => reject(new Error(
      '上传请求未能发出：可能是广告拦截插件拦了 r2.cloudflarestorage.com，'
      + '或浏览器安全策略/公司防火墙拦截。可尝试关闭本站的拦截插件后重试，或换个浏览器'
    ));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.send(blob);
  });
}

/**
 * 带重试的直传。
 *
 * 实测 R2 预签名直传没有 100MB 上限（200MB 一次成功），但公网上传途中出现
 * ERR_CONNECTION_RESET 这类瞬时中断很常见，所以正确处置是「失败自动重试」，
 * 而不是设一个体积上限去拒绝大文件。预签名 URL 15 分钟内可重复使用。
 */
async function putToR2WithRetry(url, blob, contentType, onProgress, maxAttempts){
  maxAttempts = maxAttempts || 3;
  for(let attempt=1; attempt<=maxAttempts; attempt++){
    try { await putToR2(url, blob, contentType, onProgress); return; }
    catch(err){
      if(attempt === maxAttempts) throw err;
      const waitSec = Math.pow(2, attempt - 1); // 2s, 4s
      await new Promise(r => setTimeout(r, waitSec * 1000));
      if(onProgress) onProgress(0);
    }
  }
}

/**
 * 把服务端的错误码翻成人话。
 *
 * ⚠️ 原则：**说清「发生了什么 + 现在能做什么」**，而不是复述状态码。
 *   「不支持的文件类型」对用户没用 —— 他不知道该传什么。
 *   「.rar 不在允许的格式内，本站只接受 EPUB / PDF / …」才有用。
 */
function tipFor(code, json){
  const map = {
    'turnstile-failed': '人机验证没通过（可能是有扩展程序拦了验证码）。可以刷新页面重试，或直接用 WebDAV 上传。',
    'ticket-invalid': '通行证过期了，正在重新获取 —— 若反复出现请刷新页面。',
    'file-too-large': '文件太大' + (
      json && json.maxBytes
        ? '：本站单文件上限 ' + fmtSize(json.maxBytes) + '，你的文件 ' + fmtSize(json.size || 0) + '。'
        : '，超过了本站上限。'
    ),
    // ⚠️ 这里用 BR 而不是在字符串里直接写换行符：本文件整体是模板字符串，
    //   写成「反斜杠 + n」渲染时会变成真实换行，把 JS 字符串拦腰截断 ——
    //   页面脚本直接语法错误，报错还指向文件末尾，极难定位。
    //   （pages-syntax.test.ts 抓到的；TypeScript 层面完全看不出来。）
    'unsupported-format': '文件类型不支持'
      + (json && json.ext ? '：. ' + json.ext : '')
      + (json && json.allowed && json.allowed.length
          ? BR + '本站只接受：' + json.allowed.join('、')
          : BR + '本站只接受电子书与漫画格式。')
      + BR + '不确定的话，试试把书转成 EPUB 或 PDF。',
    'upload-not-configured': '服务器的上传功能还没配置好，缺少：'
      + ((json && json.missing) || []).join('、')
      + '。这是站点的问题，不是你的操作有误 —— 请过一会儿再试。',
    'bad-json': '请求格式错误，请刷新页面重试。',
    'filename-required': '没读到文件名，请重新选择文件。',
    'size-required': '没读到文件大小，请重新选择文件。',
    'bad-key': '上传凭证已失效，请刷新页面重新上传这批文件。',
    // 刻意用「斜杠」这种文字说法而非写出符号：反斜杠在模板字符串里会被
    //   解析掉一层，渲染出非法的转义序列，连注释里写都会让 TS 报错。
    'invalid-filename': '文件名不可用：请去掉路径分隔符（斜杠与反斜杠），也试试不要以空格或点开头结尾。',
    'already-exists': (json && json.message)
      || '这本书已经在书库里了。如果要新增另一本同名书，请改个文件名（加版本号或译者）。',
    'object-not-found': '临时文件已失效（可能超时被清理），请刷新页面重新上传这批文件。',
    'book-not-found': '找不到对应的书目记录，可能已被移除。请刷新页面重试。',
  };
  return map[code] || ('出错了：' + code);
}

/** 上传一个队列项。返回 true 表示成功。 */
async function uploadOne(item){
  item.status = 'uploading'; item.pct = 0; item.error = null; item.result = null;
  render();

  // 有通行证就复用它（整批只验证一次）；没有才去取一次性令牌
  const body = {
    filename: item.file.name, size: item.file.size,
    contentType: item.file.type || '',
  };
  if(ticket) body.ticket = ticket;
  else if(NEED_TURNSTILE) body.turnstileToken = await takeToken();
  // 都不需要 → 服务端直接放行（默认模式）

  let initRes = await fetch('/api/upload/init', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(body),
  });
  let initJson = await initRes.json().catch(() => ({}));

  // 通行证失效 → 换一次性令牌重试一次（不消耗用户的第二次手动操作：
  // interaction-only 下多数情况仍是静默通过）
  if(!initRes.ok && (initJson.error === 'ticket-invalid' || initJson.error === 'turnstile-failed')){
    ticket = null;
    bufferedToken = null;
    if(NEED_TURNSTILE) body.turnstileToken = await takeToken();
    delete body.ticket;
    initRes = await fetch('/api/upload/init', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify(body),
    });
    initJson = await initRes.json().catch(() => ({}));
  }

  if(!initRes.ok){
    throw new Error(tipFor(initJson.error || ('HTTP ' + initRes.status), initJson));
  }
  // 服务端每次都会回一张新通行证（等于续期），后续文件继续免验证
  if(initJson.ticket) ticket = initJson.ticket;

  await putToR2WithRetry(
    initJson.uploadUrl, item.file, initJson.headers['content-type'],
    (ratio) => { item.pct = ratio; render(); },
  );
  item.pct = 1; render();

  const doneRes = await fetch('/api/upload/complete', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({
      key: initJson.key, filename: item.file.name,
      size: item.file.size, contentType: item.file.type || '',
      // 留名：整批共用一个署名（在拖放区下方统一填），服务端会清洗
      credit: creditEl ? creditEl.value : '',
    }),
  });
  const doneJson = await doneRes.json().catch(() => ({}));
  if(!doneRes.ok) throw new Error(tipFor(doneJson.error || ('HTTP ' + doneRes.status), doneJson));

  item.result = doneJson;
  item.status = 'done';
  render();
  return true;
}

// ── 批量驱动 ──────────────────────────────────────────────────────────
$('go').onclick = async () => {
  if(running) return;
  const pending = queue.filter(q => q.status === 'waiting' || q.status === 'error');
  if(pending.length === 0) return;

  running = true;
  msg('', '');
  render();

  let ok = 0, fail = 0;
  for(const item of pending){
    try {
      // 每个文件都要新令牌；上传前先把上一个用掉的令牌位清干净
      if(item.status === 'error'){ item.status = 'waiting'; render(); }
      await uploadOne(item);
      ok++;
    } catch(e){
      item.status = 'error';
      item.error = (e && e.message) || String(e);
      fail++;
      render();
    }
  }

  running = false;
  render();
  if(fail === 0) msg('✅ 全部上传成功，共 ' + ok + ' 本已上架', 'ok');
  else if(ok === 0) msg('❌ 全部失败（' + fail + ' 本）。可点「重试失败的」再试一次', 'err');
  else msg('部分成功：' + ok + ' 本已上架，' + fail + ' 本失败。可点「重试失败的」再试一次', 'err');
};

$('retry').onclick = () => {
  for(const q of queue) if(q.status === 'error'){ q.status = 'waiting'; q.error = null; }
  render();
  $('go').click();
};

$('clear').onclick = () => {
  if(running) return;
  queue = [];
  render();
  $('queueWrap').classList.remove('show');
  msg('', '');
};

// 初始化
renderWidget().catch(e => { msg('❌ '+e.message, 'err'); $('go').disabled = true; });
</script>
</body></html>`;
}
