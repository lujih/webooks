/**
 * 上传页（/upload）。
 *
 * 单文件、无构建步骤，内联 CSS/JS，直接由 Worker 提供。
 * 交互：拖拽/选择 → 客户端预览（封面/书名/作者/大小）→ Turnstile 无感验证
 *      → init 拿预签名 URL → 浏览器直传 R2（进度条）→ complete 登记元数据。
 *
 * 客户端预览说明：EPUB/PDF 的真实封面与元数据需要解压/解析文件，属于 Phase 1。
 * 当前用文件名推导书名/作者（与后端 deriveMetadata 同一套规则），并用浏览器
 * 内置能力对图片类文件做缩略预览。PDF/EPUB 的封面解析见 README「Phase 1」。
 */
export function uploadHtml(turnstileSiteKey: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>上传书籍 · webooks</title>
<style>
  :root{--bd:#e4e4e7;--mut:#71717a;--ac:#0b62d0;--ok:#177245;--er:#c62828}
  *{box-sizing:border-box}
  body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin:2.5rem auto;padding:0 1rem;color:#18181b}
  h1{font-size:1.25rem;margin-bottom:.2rem}
  .sub{color:var(--mut);margin-bottom:1.5rem;font-size:.92rem}
  #drop{border:2px dashed var(--bd);border-radius:12px;padding:2.2rem 1rem;text-align:center;cursor:pointer;transition:.15s;background:#fafafa}
  #drop.drag{border-color:var(--ac);background:#f0f6ff}
  #drop.over{border-color:var(--ac);background:#e8f1ff}
  .hint{color:var(--mut);font-size:.9rem;margin-top:.6rem}
  input[type=file]{display:none}
  .card{margin-top:1.2rem;border:1px solid var(--bd);border-radius:12px;padding:1rem;display:none}
  .card.show{display:block}
  .row{display:flex;gap:1rem;align-items:flex-start}
  .cover{width:88px;height:120px;flex:0 0 auto;border:1px solid var(--bd);border-radius:6px;object-fit:cover;background:#f4f4f5;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:.75rem;text-align:center;overflow:hidden}
  .meta{flex:1;min-width:0}
  .fname{font-weight:600;word-break:break-all}
  .kv{color:var(--mut);font-size:.9rem;margin-top:.35rem}
  .kv b{color:#3f3f46;font-weight:600}
  .bar{height:8px;background:#ececee;border-radius:999px;overflow:hidden;margin-top:.9rem}
  .bar>i{display:block;height:100%;width:0;background:var(--ac);transition:width .15s}
  .msg{margin-top:.9rem;font-size:.92rem;display:none}
  .msg.show{display:block}
  .msg.err{color:var(--er)}
  .msg.ok{color:var(--ok)}
  button{font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid var(--ac);background:var(--ac);color:#fff;cursor:pointer}
  button.ghost{background:#fff;color:var(--ac)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .steps{margin:1rem 0;padding:0;list-style:none;font-size:.9rem;color:var(--mut)}
  .steps li{padding:.15rem 0}
  .steps li.on{color:var(--ac);font-weight:600}
  .steps li.ok{color:var(--ok)}
  #ts{margin-top:1rem}
  a{color:var(--ac)}
</style></head>
<body>
<h1>上传书籍</h1>
<p class="sub">支持 EPUB / PDF / MOBI / AZW3 / CBZ / 有声书等。大文件直传 Cloudflare R2，不经服务器。</p>

<div id="drop">
  <div>把文件拖到这里，或 <a href="#" id="pick">点击选择</a></div>
  <div class="hint">单文件上限由服务器决定；上传后立即可在 WebDAV /opds 中检索</div>
  <input type="file" id="file">
</div>

<div class="card" id="card">
  <div class="row">
    <div class="cover" id="cover">无封面</div>
    <div class="meta">
      <div class="fname" id="fname"></div>
      <div class="kv">类型：<b id="ftype"></b></div>
      <div class="kv">大小：<b id="fsize"></b></div>
      <div class="kv" id="derived" hidden>识别书名：<b id="ftitle"></b> · 作者：<b id="fauthor"></b></div>
    </div>
  </div>
  <div class="bar" id="bar"><i id="pct"></i></div>
  <div class="msg" id="msg"></div>
  <ol class="steps" id="steps">
    <li id="s1">1. 获取上传地址</li>
    <li id="s2">2. 上传到 R2</li>
    <li id="s3">3. 写入书库</li>
  </ol>
  <button id="go">开始上传</button>
  <button class="ghost" id="reset" style="margin-left:.5rem">换一个</button>
</div>

<div id="ts"></div>

<script>
const $ = (id) => document.getElementById(id);
let picked = null, turnstileToken = null, siteKey = ${JSON.stringify(turnstileSiteKey)};

const drop = $('drop'), file = $('file');
drop.onclick = () => file.click();
$('pick').onclick = (e) => { e.stopPropagation(); file.click(); };
file.onchange = () => file.files[0] && preview(file.files[0]);

['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag','over'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag','over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) preview(f); });

$('reset').onclick = () => { picked = null; file.value=''; $('card').classList.remove('show'); $('msg').className='msg'; turnstileToken=null; };

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
  $('fname').textContent = f.name;
  $('fsize').textContent = fmtSize(f.size);
  const d = derive(f.name);
  $('ftype').textContent = d.ext.toUpperCase()||'?';
  $('derived').hidden = false;
  $('ftitle').textContent = d.title;
  $('fauthor').textContent = d.author || '（未识别）';
  // 图片类给真实预览，其余给占位
  const cov = $('cover');
  if(/^image\\//.test(f.type)){ const url=URL.createObjectURL(f); cov.innerHTML='<img src="'+url+'" style="width:100%;height:100%;object-fit:cover">'; }
  else { cov.textContent = d.ext.toUpperCase() || '无封面'; }
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
    await putToR2(init.json.uploadUrl, picked, init.json.headers['content-type']);

    setStep(3); msg('正在写入书库…');
    const done = await fetch('/api/upload/complete', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ key: init.json.key, filename: picked.name, size: picked.size, contentType: picked.type }),
    }).then(async r => ({ ok:r.ok, status:r.status, json: await r.json().catch(()=>({})) }));
    if(!done.ok) throw new Error(done.json.error || ('HTTP '+done.status));
    markStep(3);

    msg('✅ 上传成功：《'+done.json.title+'》已上架', 'ok');
    $('pct').style.width='100%';
  }catch(e){
    msg('❌ ' + (e.message||e), 'err');
    $('go').disabled=false;
  }
};

// 用 XHR 以获得上传进度
function putToR2(url, blob, contentType){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if(contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if(e.lengthComputable) $('pct').style.width = (e.loaded/e.total*100)+'%'; };
    xhr.onload = () => { if(xhr.status>=200&&xhr.status<300) resolve(); else reject(new Error('R2 直传失败 HTTP '+xhr.status)); };
    xhr.onerror = () => reject(new Error('R2 直传网络错误'));
    xhr.send(blob);
  });
}

// 初始化
renderWidget().catch(e => { msg('❌ '+e.message, 'err'); $('go').disabled=true; });
</script>
</body></html>`;
}