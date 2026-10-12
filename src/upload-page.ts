/**
 * 上传页（/upload）—— 支持批量。
 *
 * 单文件、无构建步骤，内联 CSS/JS，直接由 Worker 提供。
 * 复用 lib/theme 的设计系统（「深夜图书馆」），与首页/目录页同一套视觉语言。
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

export function uploadHtml(turnstileSiteKey: string): string {
  // accept 用归一化后的格式列表；浏览器据此过滤文件选择框
  const accept = ALLOWED_UPLOAD_FORMATS.map((f) => `.${f}`).join(',');
  const formatList = [...EBOOK_FORMATS, ...COMIC_FORMATS].join(' / ');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>上架书籍 · webooks</title>
<style>
${themeCss()}
  /* ── 页头 ── */
  .bar-head{display:flex;align-items:baseline;gap:var(--s3);margin-bottom:var(--s5)}
  .mk{font-family:var(--serif);font-size:1.05rem;letter-spacing:.3em;color:var(--glow)}
  .mk a{color:inherit;text-decoration:none}
  .back{margin-left:auto;font-size:.8rem;font-family:var(--serif);letter-spacing:.08em}
  h1{font-family:var(--serif);font-weight:400;font-size:clamp(1.6rem,4.5vw,2.2rem);letter-spacing:.03em;margin-bottom:var(--s2)}
  .sub{color:var(--paper-dim);font-size:.92rem;line-height:1.75;margin-bottom:var(--s5);max-width:40rem}

  /* ── 拖放区 ── */
  #drop{
    border:2px dashed var(--line);border-radius:var(--r3);
    padding:var(--s7) var(--s4);text-align:center;cursor:pointer;
    background:rgba(0,0,0,.22);
    transition:border-color var(--dur) var(--ease),background var(--dur) var(--ease),transform var(--dur) var(--ease);
  }
  #drop:hover{border-color:var(--glow);background:rgba(255,180,77,.05)}
  #drop.drag,#drop.over{border-color:var(--glow);background:rgba(255,180,77,.1);transform:scale(1.008)}
  .dropmark{color:var(--glow);opacity:.85;margin-bottom:var(--s3)}
  .droptitle{font-family:var(--serif);font-size:1.15rem;letter-spacing:.05em}
  .droptitle a{color:var(--glow);border-bottom:1px solid var(--glow);text-decoration:none}
  .droptitle a:hover{color:#ffc978}
  .hint{color:var(--paper-dim);font-size:.83rem;margin-top:var(--s3)}
  input[type=file]{display:none}

  /* ── 队列 ── */
  #queueWrap{margin-top:var(--s5);display:none}
  #queueWrap.show{display:block;animation:up .4s var(--ease) forwards}
  .qhead{
    display:flex;align-items:baseline;gap:var(--s3);flex-wrap:wrap;
    padding-bottom:var(--s3);border-bottom:1px solid var(--line);margin-bottom:var(--s3);
  }
  .qhead .qt{font-family:var(--serif);font-size:1rem;letter-spacing:.04em}
  .qhead .qs{color:var(--paper-dim);font-size:.82rem;margin-left:auto}
  .qbar{height:4px;background:rgba(0,0,0,.5);border-radius:999px;overflow:hidden;border:1px solid var(--line-soft);margin-bottom:var(--s4)}
  .qbar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--glow-deep),var(--glow));transition:width .3s var(--ease)}

  ul.q{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:var(--s2)}
  li.qi{
    display:flex;gap:var(--s3);align-items:flex-start;
    padding:var(--s3);border:1px solid var(--line-soft);border-radius:var(--r2);
    background:rgba(0,0,0,.2);
  }
  li.qi.uploading{border-color:var(--line);background:rgba(255,180,77,.05)}
  li.qi.done{border-color:rgba(126,217,87,.35)}
  li.qi.error{border-color:rgba(255,107,107,.45);background:rgba(255,107,107,.05)}
  li.qi.skip{opacity:.6}
  .qmark{
    width:22px;height:22px;flex:0 0 auto;margin-top:1px;
    display:flex;align-items:center;justify-content:center;
    font-size:.72rem;font-family:var(--mono);border-radius:50%;
    border:1px solid var(--line-soft);color:var(--paper-dim);
  }
  li.qi.uploading .qmark{border-color:var(--glow);color:var(--glow)}
  li.qi.done .qmark{border-color:var(--ok);color:var(--ok)}
  li.qi.error .qmark{border-color:var(--er);color:var(--er)}
  .qbody{flex:1;min-width:0}
  .qname{font-size:.9rem;word-break:break-all;line-height:1.45}
  .qsub{color:var(--paper-dim);font-size:.78rem;margin-top:.15rem;line-height:1.5}
  .qsub.err{color:var(--er)}
  .qsub.ok{color:var(--ok)}
  .qbar2{height:4px;background:rgba(0,0,0,.5);border-radius:999px;overflow:hidden;margin-top:.4rem;display:none}
  li.qi.uploading .qbar2{display:block}
  .qbar2>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--glow-deep),var(--glow));transition:width .2s var(--ease)}
  .qcover{width:34px;height:46px;flex:0 0 auto;border-radius:2px;overflow:hidden;background:#1a1612;border:1px solid var(--line-soft)}
  .qcover img{width:100%;height:100%;object-fit:cover;display:block}

  /* ── 消息 ── */
  .msg{margin-top:var(--s4);font-size:.88rem;display:none;line-height:1.6}
  .msg.show{display:block;animation:up .3s var(--ease) forwards}
  .msg.err{color:var(--er)}
  .msg.ok{color:var(--ok)}

  /* ── 按钮区 ── */
  .actions{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-top:var(--s4)}
  #ts{margin-top:var(--s5);min-height:0}

  /* ── 提示 ── */
  .fineprint{
    margin-top:var(--s6);padding-top:var(--s4);
    border-top:1px solid var(--line);
    font-size:.79rem;color:var(--paper-dim);line-height:1.75;
  }
  .eligible{color:var(--paper-dim);font-size:.79rem;line-height:1.7;margin-top:var(--s3);word-break:break-word}
</style></head>
<body>
<div class="wrap">

  <div class="bar-head reveal" style="animation-delay:.03s">
    <span class="mk"><a href="/">we·books</a></span>
    <a class="back" href="/">← 回到书库</a>
  </div>

  <h1 class="reveal" style="animation-delay:.08s">上架书籍</h1>
  <p class="sub reveal" style="animation-delay:.12s">
    可以<b>一次选多本</b>。文件<b>直传 Cloudflare R2</b>，不经服务器中转；
    EPUB 会自动解析出真实封面、书名与作者。传完立刻能在 WebDAV 客户端与浏览器书架里看到。
  </p>

  <div id="drop" class="reveal" style="animation-delay:.18s" role="button" tabindex="0" aria-label="选择要上传的书籍文件，可多选">
    <div class="dropmark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
    </div>
    <div class="droptitle">把书籍文件拖到这里，或 <a href="#" id="pick">点此选择</a></div>
    <div class="hint">支持一次多选、连续拖入；只会接受电子书与漫画格式</div>
    <input type="file" id="file" multiple accept="${accept}">
  </div>

  <div class="eligible reveal" style="animation-delay:.2s">
    接受格式：<b>${formatList}</b>
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

  <div id="ts"></div>

  <p class="fineprint">
    这个书库是<b>匿名开放</b>的：任何人都能上传与下载，上传后自动上架、不经人工审核。<br>
    请勿上传你无权分发的作品。若文件涉及侵权，请联系站点管理员移除。
  </p>

</div>

<script>
const $ = (id) => document.getElementById(id);
const ACCEPT = ${JSON.stringify(ALLOWED_UPLOAD_FORMATS)};
let siteKey = ${JSON.stringify(turnstileSiteKey)};

// 队列项：{ file, status: waiting|uploading|done|error|skip, pct, error, result }
let queue = [];
let running = false;

const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
// 键盘可达：#drop 是 role="button" tabindex="0"，必须支持 Enter/Space
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); fileInput.click(); }
});
$('pick').onclick = (e) => { e.stopPropagation(); fileInput.click(); };
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

// ── Turnstile 令牌队列 ────────────────────────────────────────────────
// 令牌一次性：每个文件都要一个新令牌。维护「一个缓冲 + 一个等待者」即可，
// 因为上传是串行的。
let bufferedToken = null;
let tokenWaiter = null;

function onToken(t){
  if(tokenWaiter){ const r = tokenWaiter; tokenWaiter = null; r(t); }
  else bufferedToken = t;
}

/** 取一个可用令牌；没有就 reset 组件向 Turnstile 要一个新的。 */
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
  await loadTurnstile();
  window.turnstile.render('#ts', {
    sitekey: siteKey,
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

function tipFor(code, json){
  const map = {
    'turnstile-failed': '人机验证失败，正在换一个新令牌重试',
    'file-too-large': '文件超过服务器限制',
    'unsupported-format': '不支持的文件类型',
    'upload-not-configured': '服务器尚未配置上传功能：缺少 ' + ((json && json.missing) || []).join(', '),
    'bad-json': '请求格式错误',
  };
  return map[code] || code;
}

/** 上传一个队列项。返回 true 表示成功。 */
async function uploadOne(item){
  item.status = 'uploading'; item.pct = 0; item.error = null; item.result = null;
  render();

  const token = await takeToken();
  const initRes = await fetch('/api/upload/init', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({
      filename: item.file.name, size: item.file.size,
      contentType: item.file.type || '', turnstileToken: token,
    }),
  });
  const initJson = await initRes.json().catch(() => ({}));
  if(!initRes.ok){
    throw new Error(tipFor(initJson.error || ('HTTP ' + initRes.status), initJson));
  }

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
