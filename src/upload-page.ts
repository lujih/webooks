/**
 * 上传页（/upload）。
 *
 * 单文件、无构建步骤，内联 CSS/JS，直接由 Worker 提供。
 * 复用 lib/theme 的设计系统（「深夜图书馆」），与首页/目录页同一套视觉语言。
 *
 * 交互：拖拽/选择 → 客户端预览（封面/书名/作者/大小）→ Turnstile 无感验证
 *      → init 拿预签名 URL → 浏览器直传 R2（进度条）→ complete 登记元数据
 *      → 展示服务器解析出的真实封面与元数据。
 */

import { themeCss } from './lib/theme';

export function uploadHtml(turnstileSiteKey: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>上架一本书 · webooks</title>
<style>
${themeCss()}
  /* ── 页头 ── */
  .bar-head{display:flex;align-items:baseline;gap:var(--s3);margin-bottom:var(--s5)}
  .mk{font-family:var(--serif);font-size:1.05rem;letter-spacing:.3em;color:var(--glow)}
  .mk a{color:inherit;text-decoration:none}
  .back{margin-left:auto;font-size:.8rem;font-family:var(--serif);letter-spacing:.08em}
  h1{font-family:var(--serif);font-weight:400;font-size:clamp(1.6rem,4.5vw,2.2rem);letter-spacing:.03em;margin-bottom:var(--s2)}
  .sub{color:var(--paper-dim);font-size:.92rem;line-height:1.75;margin-bottom:var(--s5);max-width:38rem}

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

  /* ── 结果卡 ── */
  .card{
    margin-top:var(--s4);padding:var(--s4);
    background:linear-gradient(160deg,var(--ink-2) 0%,#120f0c 100%);
    border:1px solid var(--line);border-radius:var(--r3);
    display:none;
  }
  .card.show{display:block;animation:up .45s var(--ease) forwards}
  .row{display:flex;gap:var(--s4);align-items:flex-start}
  .cover{
    width:92px;height:126px;flex:0 0 auto;border-radius:var(--r1);
    overflow:hidden;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(150deg,#2a231a,#181410);
    border:1px solid var(--line-soft);
    box-shadow:3px 4px 14px rgba(0,0,0,.5);
    color:var(--paper-dim);font-size:.7rem;text-align:center;
  }
  .cover img{width:100%;height:100%;object-fit:cover;display:block}
  .cover-empty{padding:6px;word-break:break-word;font-family:var(--mono);font-size:.62rem;letter-spacing:.03em}
  .meta{flex:1;min-width:0}
  .fname{font-family:var(--serif);font-size:1.02rem;letter-spacing:.02em;word-break:break-all;line-height:1.4}
  .kv{color:var(--paper-dim);font-size:.85rem;margin-top:.3rem}
  .kv b{color:var(--paper);font-weight:600}
  .kv.parsed{margin-top:var(--s3);padding-top:var(--s3);border-top:1px dashed var(--line)}
  .badge{
    display:inline-block;font-size:.68rem;font-weight:600;letter-spacing:.08em;
    padding:.15rem .5rem;border-radius:999px;
    background:rgba(255,180,77,.14);color:var(--glow);
    border:1px solid var(--line);margin-bottom:var(--s2);
  }

  /* ── 进度 ── */
  .bar{height:6px;background:rgba(0,0,0,.5);border-radius:999px;overflow:hidden;margin-top:var(--s4);border:1px solid var(--line-soft)}
  .bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--glow-deep),var(--glow));transition:width .2s var(--ease)}

  /* ── 消息 ── */
  .msg{margin-top:var(--s3);font-size:.88rem;display:none;line-height:1.6}
  .msg.show{display:block;animation:up .3s var(--ease) forwards}
  .msg.err{color:var(--er)}
  .msg.ok{color:var(--ok)}

  /* ── 步骤 ── */
  .steps{
    margin:var(--s4) 0;padding:0;list-style:none;
    font-size:.86rem;color:var(--paper-dim);
    display:flex;flex-wrap:wrap;gap:var(--s2) var(--s5);
  }
  .steps li{display:flex;align-items:center;gap:var(--s2)}
  .steps li::before{
    content:"";width:7px;height:7px;border-radius:50%;
    background:var(--paper-dim);opacity:.4;flex:0 0 auto;
    transition:background var(--dur) var(--ease),opacity var(--dur) var(--ease),box-shadow var(--dur) var(--ease);
  }
  .steps li.on{color:var(--glow);font-weight:600}
  .steps li.on::before{background:var(--glow);opacity:1;box-shadow:0 0 8px var(--glow)}
  .steps li.ok{color:var(--ok)}
  .steps li.ok::before{background:var(--ok);opacity:1}

  /* ── 按钮区 ── */
  .actions{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center}
  #ts{margin-top:var(--s5);min-height:0}

  /* ── 隐私提示 ── */
  .fineprint{
    margin-top:var(--s6);padding-top:var(--s4);
    border-top:1px solid var(--line);
    font-size:.79rem;color:var(--paper-dim);line-height:1.75;
  }
</style></head>
<body>
<div class="wrap">

  <div class="bar-head reveal" style="animation-delay:.03s">
    <span class="mk"><a href="/">we·books</a></span>
    <a class="back" href="/">← 回到书库</a>
  </div>

  <h1 class="reveal" style="animation-delay:.08s">上架一本书</h1>
  <p class="sub reveal" style="animation-delay:.12s">
    支持 EPUB / PDF / MOBI / AZW3 / CBZ / 有声书等。文件<b>直传 Cloudflare R2</b>，
    不经服务器中转；EPUB 会自动解析出真实封面、书名与作者。
  </p>

  <div id="drop" class="reveal" style="animation-delay:.18s" role="button" tabindex="0" aria-label="选择要上传的书籍文件">
    <div class="dropmark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
    </div>
    <div class="droptitle">把文件拖到这里，或 <a href="#" id="pick">点此选择</a></div>
    <div class="hint">上传后立即可在 WebDAV 客户端与浏览器书架中看到</div>
    <input type="file" id="file">
  </div>

  <div class="card" id="card">
    <div class="row">
      <div class="cover" id="cover"><div class="cover-empty">无封面</div></div>
      <div class="meta">
        <div class="fname" id="fname"></div>
        <div class="kv">类型：<b id="ftype"></b></div>
        <div class="kv">大小：<b id="fsize"></b></div>
        <div class="kv" id="derived" hidden>推测书名：<b id="ftitle"></b> · 推测作者：<b id="fauthor"></b></div>
        <div class="kv parsed" id="parsed" hidden>
          <span class="badge" id="parsedBadge">已解析 EPUB</span>
          真实书名：<b id="ptitle"></b><br>真实作者：<b id="pauthor"></b>
        </div>
      </div>
    </div>
    <div class="bar" id="bar"><i id="pct"></i></div>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
    <ol class="steps" id="steps">
      <li id="s1">获取上传地址</li>
      <li id="s2">上传到 R2</li>
      <li id="s3">写入书库</li>
    </ol>
    <div class="actions">
      <button class="btn btn-primary" id="go">开始上传</button>
      <button class="btn" id="reset">换一个文件</button>
    </div>
  </div>

  <div id="ts"></div>

  <p class="fineprint">
    这个书库是<b>匿名开放</b>的：任何人都能上传与下载，上传后自动上架、不经人工审核。<br>
    请勿上传你无权分发的作品。若文件涉及侵权，请联系站点管理员移除。
  </p>

</div>

<script>
const $ = (id) => document.getElementById(id);
let picked = null, turnstileToken = null, siteKey = ${JSON.stringify(turnstileSiteKey)};

const drop = $('drop'), file = $('file');
drop.onclick = () => file.click();
// 键盘可达：#drop 是 role="button" tabindex="0"，必须支持 Enter/Space
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); file.click(); }
});
$('pick').onclick = (e) => { e.stopPropagation(); file.click(); };
file.onchange = () => file.files[0] && preview(file.files[0]);

['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag','over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag','over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) preview(f); });

$('reset').onclick = () => {
  picked = null; file.value='';
  $('card').classList.remove('show');
  $('msg').className='msg';
  $('pct').style.width='0%';
  for(let i=1;i<=3;i++){ const el=$('s'+i); el.classList.remove('on','ok'); }
  turnstileToken=null;
  file.click();
};

function fmtSize(b){ if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; if(b<1073741824) return (b/1048576).toFixed(1)+' MB'; return (b/1073741824).toFixed(2)+' GB'; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 与后端 deriveMetadata 同规则的轻量版，用于上传前预览
function derive(name){
  const i = name.lastIndexOf('.'), ext = (i>0?name.slice(i+1):'').toLowerCase();
  let stem = (i>0?name.slice(0,i):name).replace(/_+/g,' ').trim();
  let author = null;
  for(const sep of [' - ',' – ',' — ',' by ']){ const k=stem.indexOf(sep); if(k>0&&k<stem.length-sep.length){ author=stem.slice(0,k).trim(); stem=stem.slice(k+sep.length).trim(); break; } }
  return { ext, title: stem||name, author };
}

function preview(f){
  picked = f;
  $('card').classList.add('show');
  // 清掉上一次上传留下的「已解析」区
  $('parsed').hidden = true;
  $('fname').textContent = f.name;
  $('fsize').textContent = fmtSize(f.size);
  const d = derive(f.name);
  $('ftype').textContent = d.ext.toUpperCase()||'?';
  $('derived').hidden = false;
  $('ftitle').textContent = d.title;
  $('fauthor').textContent = d.author || '（未识别）';
  // 图片类给真实预览，其余给占位
  const cov = $('cover');
  // 注意：这里是 TS 模板字符串，正则里的转义反斜杠会被模板字符串吃掉，
  // 生成出语法非法的正则（连续两个斜杠），整段脚本解析失败、上传页彻底失效（真实事故）。
  // 改用 startsWith，从根上避开反斜杠转义陷阱。
  if(f.type.startsWith('image/')){ const url=URL.createObjectURL(f); cov.innerHTML='<img src="'+url+'" style="width:100%;height:100%;object-fit:cover">'; }
  else { cov.innerHTML='<div class="cover-empty">'+ (d.ext.toUpperCase() || '无封面') +'</div>'; }
  $('go').disabled = false;
  setStep(1);
}

// Turnstile
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
  turnstileToken = null;
  window.turnstile.render('#ts', {
    sitekey: siteKey,
    callback: (token) => { turnstileToken = token; $('go').disabled=false; },
    'expired-callback': () => { turnstileToken = null; },
  });
}

function setStep(n){ for(let i=1;i<=3;i++){ const el=$('s'+i); el.classList.toggle('on', i===n); } }
function markStep(n){ const el=$('s'+n); el.classList.remove('on'); el.classList.add('ok'); }
function msg(text, cls){ const m=$('msg'); m.textContent=text; m.className='msg show '+(cls||''); }

$('go').onclick = async () => {
  if(!picked) return;
  if(!turnstileToken){ msg('请先完成人机验证', 'err'); return; }
  $('go').disabled = true;
  try{
    setStep(1); msg('正在获取上传地址…');
    const init = await fetch('/api/upload/init', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ filename: picked.name, size: picked.size, contentType: picked.type, turnstileToken }),
    }).then(async r => ({ ok:r.ok, status:r.status, json: await r.json().catch(()=>({})) }));
    if(!init.ok){
      const code = init.json.error || ('HTTP '+init.status);
      const tip = { 'turnstile-failed':'人机验证失败，请重试', 'file-too-large':'文件超过服务器限制', 'unsupported-format':'不支持的文件类型', 'upload-not-configured':'服务器尚未配置上传功能：缺少 '+(init.json.missing||[]).join(', ') }[code] || code;
      throw new Error(tip);
    }
    markStep(1);

    setStep(2); msg('正在上传到 R2…');
    await putToR2WithRetry(init.json.uploadUrl, picked, init.json.headers['content-type']);

    setStep(3); msg('正在写入书库…');
    const done = await fetch('/api/upload/complete', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ key: init.json.key, filename: picked.name, size: picked.size, contentType: picked.type }),
    }).then(async r => ({ ok:r.ok, status:r.status, json: await r.json().catch(()=>({})) }));
    if(!done.ok) throw new Error(done.json.error || ('HTTP '+done.status));
    markStep(3);

    // 展示服务器解析出的真实封面与元数据（EPUB 且 < 50MB 时 available）
    const j = done.json;
    if (j.coverUrl) {
      $('cover').innerHTML = '<img src="'+j.coverUrl+'" style="width:100%;height:100%;object-fit:cover" alt="cover">';
      $('parsed').hidden = false;
      $('ptitle').textContent = j.title || '—';
      $('pauthor').textContent = j.author || '（未识别）';
      $('parsedBadge').textContent = '已解析 EPUB 封面';
    }
    msg('✅ 上传成功：《'+(j.title||j.leafName)+'》已上架', 'ok');
    $('pct').style.width='100%';
  }catch(e){
    const detail = e.message||String(e);
    // 连接类错误在公网上传很常见，明确告诉用户可以重试，而不是让他以为坏了
    const retryable = /中断|超时|ERR_|网络|CSP|Content Security|blocked/.test(detail);
    msg('❌ ' + detail + (retryable ? '（大文件在弱网下中断属常见情况，再点一次「开始上传」即可）' : ''), 'err');
    // 关键：Turnstile 令牌是**一次性**的，上一次 init 已经把它消费掉了。
    // 不重置的话，用户再点一次只会拿到 403 turnstile-failed，看起来像"坏了"，
    // 实际是令牌已被用掉（真实踩过：CSP 拦掉上传后重试永远 403）。
    turnstileToken = null;
    if (window.turnstile && typeof window.turnstile.reset === 'function') {
      try { window.turnstile.reset(); } catch {}
    }
    $('go').disabled = true; // 等新的令牌回来再启用（callback 里会解除）
  }
};

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
 * 带重试的上传。
 *
 * 为什么要重试：实测 R2 预签名直传**没有 100MB 上限**（200MB 一次成功），
 * 但传输途中出现 ERR_CONNECTION_RESET 这类瞬时中断是公网上传家常便饭 ——
 * 实测 120MB 档就偶发断在 41 秒处，而更大的 200MB 却一次过。
 * 说明这是瞬时故障而非体积阈值，所以正确处置是「失败自动重试」，
 * 而不是设一个体积上限去拒绝大文件。
 *
 * 预签名 URL 15 分钟内可重复使用，重试不需要重新签发。
 */
async function putToR2WithRetry(url, blob, contentType, maxAttempts){
  maxAttempts = maxAttempts || 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++){
    try {
      await putToR2(url, blob, contentType, (ratio) => {
        // 重试时把进度条回退，避免显示成 100% 却失败
        $('pct').style.width = (ratio * 100) + '%';
      });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const waitSec = Math.pow(2, attempt - 1); // 2s, 4s, 8s
      msg('第 ' + attempt + '/' + maxAttempts + ' 次上传中断（' + (err.message||err) + '），' + waitSec + ' 秒后自动重试…', '');
      await new Promise(r => setTimeout(r, waitSec * 1000));
      $('pct').style.width = '0%';
    }
  }
}

// 初始化
renderWidget().catch(e => { msg('❌ '+e.message, 'err'); $('go').disabled=true; });
</script>
</body></html>`;
}