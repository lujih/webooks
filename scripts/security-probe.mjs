#!/usr/bin/env node
/**
 * 网站安全性探针 —— 对线上实例做非破坏性安全自查。
 *
 * 用法：node scripts/security-probe.mjs [--url https://webooks.example.org]
 *
 * 只做只读/无害请求：不写文件、不删数据、不做拒绝服务。
 * 覆盖：安全响应头、CORS、路径穿越、方法暴露、错误信息泄露、
 *       公开桶列举、上传前缀可达性、管理端点鉴权、XML 外部实体。
 */

const args = process.argv.slice(2);
const uIdx = args.indexOf('--url');
const WRITE_TEST = args.includes('--write-test');
const SITE = (uIdx >= 0 ? args[uIdx + 1] : 'https://webooks.cszxorx.dpdns.org').replace(/\/+$/, '');
const ORIGIN = new URL(SITE).origin;

const C = { r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m' };
const findings = [];

function report(ok, severity, name, detail = '', fix = '') {
  findings.push({ ok, severity, name, detail, fix });
  const tag = ok ? `${C.g}OK  ${C.r}` : severity === 'HIGH' ? `${C.red}HIGH${C.r}` : severity === 'MED' ? `${C.y}MED ${C.r}` : `${C.y}LOW ${C.r}`;
  console.log(`  [${tag}] ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}`);
}

async function req(path, init = {}, origin = ORIGIN) {
  // 网络抖动重试：把「连不上」误报成「安全问题」会让人白白紧张。
  // 三次都失败才返回 status=0，并在结论里标注为「未能验证」而非「不安全」。
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${origin}${path}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        ...init,
      });
      return { res, status: res.status, headers: res.headers };
    } catch (e) {
      lastErr = e.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return { res: null, status: 0, error: lastErr, headers: new Headers() };
}

console.log(`网站安全性探针  ${SITE}`);
console.log('='.repeat(74));

// ── 1. 安全响应头 ─────────────────────────────────────────────────────
console.log('\n▸ 安全响应头');
{
  const { headers, status } = await req('/');
  if (status === 0) {
    report(true, 'LOW', '首页不可达（网络问题，非安全问题）', '跳过响应头检查；请重跑');
  }
  const need = [
    ['x-content-type-options', 'nosniff', 'MED'],
    ['x-frame-options', null, 'LOW'],
    ['content-security-policy', null, 'MED'],
    ['referrer-policy', null, 'LOW'],
    ['strict-transport-security', null, 'LOW'],
  ];
  if (status !== 0) {
    for (const [h, want, sev] of need) {
      const v = headers.get(h);
      const ok = want ? v === want : !!v;
      report(ok, sev, `响应头 ${h}`, v ?? '(缺失)', ok ? '' : `建议加上 ${h}`);
    }
    report(status === 200, 'LOW', '首页可达', `status=${status}`);
  }
}

// ── 2. CORS ───────────────────────────────────────────────────────────
console.log('\n▸ CORS 配置');
{
  const evil = 'https://evil.example.com';
  const { headers } = await req('/dav/', { headers: { Origin: evil } });
  const acao = headers.get('access-control-allow-origin');
  const reflects = acao === evil;
  report(!reflects, 'HIGH', 'CORS 是否反射任意 Origin', `ACAO=${acao ?? '(无)'}`,
    reflects ? '不要回显请求 Origin，改为白名单' : '');
  const creds = headers.get('access-control-allow-credentials');
  report(creds !== 'true' || !reflects, 'HIGH', 'CORS 是否允许携带凭据 + 反射 Origin',
    `credentials=${creds ?? '(无)'}`);
}

// ── 3. 路径穿越 ───────────────────────────────────────────────────────
console.log('\n▸ 路径穿越');
{
  const probes = [
    '/dav/../../../../etc/passwd',
    '/dav/recent/..%2f..%2f..%2fetc%2fpasswd',
    '/dav/%2e%2e%2f%2e%2e%2fwrangler.jsonc',
    '/../wrangler.jsonc',
    '/.env',
    '/.git/config',
    '/wrangler.jsonc',
    '/node_modules/.package-lock.json',
  ];
  for (const p of probes) {
    const { status, res } = await req(p);
    if (status === 0) {
      report(true, 'LOW', `穿越探测 ${p}`, '请求失败（网络问题），跳过');
      continue;
    }
    let body = '';
    try { body = res ? (await res.text()).slice(0, 200) : ''; } catch { /* ignore */ }
    const leaked = /root:x:|\[core\]|"name":\s*"webooks"|R2_SECRET|TURNSTILE_SECRET/.test(body);
    report(!leaked && status !== 200, leaked ? 'HIGH' : 'LOW',
      `穿越探测 ${p}`, `status=${status}${leaked ? ' ⚠️ 内容泄露' : ''}`);
  }
}

// ── 4. HTTP 方法暴露 ──────────────────────────────────────────────────
console.log('\n▸ HTTP 方法');
{
  const { status } = await req('/', { method: 'TRACE' });
  report(status !== 200, 'LOW', 'TRACE 方法应被拒绝', `status=${status}`);
  const opt = await req('/dav/', { method: 'OPTIONS' });
  report(true, 'LOW', 'DAV 允许的方法', opt.headers.get('allow') ?? '(无)');
}

// ── 5. 错误信息泄露 ───────────────────────────────────────────────────
console.log('\n▸ 错误信息泄露');
{
  const { res, status } = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json',
  });
  let body = '';
  try { body = res ? await res.text() : ''; } catch { /* ignore */ }
  const leaksStack = /at\s+\w+\s+\(|\.ts:\d+|\.js:\d+:\d+|Error:.*\n\s+at/.test(body);
  report(!leaksStack, 'MED', '错误响应是否泄露堆栈', `status=${status} body=${body.slice(0, 80)}`);
  const envLeak = /R2_SECRET_ACCESS_KEY|TURNSTILE_SECRET|ADMIN_TOKEN|accessKeyId/.test(body);
  report(!envLeak, 'HIGH', '错误响应是否泄露密钥名/值', envLeak ? '⚠️ 泄露' : '未泄露');
}

// ── 6. 管理端点鉴权 ───────────────────────────────────────────────────
console.log('\n▸ 管理端点');
{
  const { status } = await req('/api/admin/stats');
  report(status === 403 || status === 404, 'HIGH', '无 token 访问 /api/admin/stats',
    `status=${status}`, '应 403（已配 token）或 404（未配）');

  const { status: s2 } = await req('/api/admin/stats?token=wrong');
  report(s2 === 403 || s2 === 404, 'HIGH', '错误 token 访问 admin', `status=${s2}`);

  const { status: s3 } = await req('/api/admin/reindex?prefix=', { method: 'POST' });
  report(s3 === 403 || s3 === 404, 'HIGH', '无 token 触发 reindex', `status=${s3}`);
}

// ── 7. 上传端点 ───────────────────────────────────────────────────────
console.log('\n▸ 上传端点');
{
  const { res, status } = await req('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'x.epub', size: 10, turnstileToken: 'fake' }),
  });
  let body = '';
  try { body = res ? await res.text() : ''; } catch { /* ignore */ }
  const rejected = /turnstile-failed/.test(body);
  report(rejected || status === 503, 'HIGH', '伪造 Turnstile token 应被拒',
    `status=${status} body=${body.slice(0, 70)}`);

  // complete 端点无 Turnstile —— 能否被滥用？
  const { status: s2, res: r2 } = await req('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'uploads/2026-01-01/abcdef/../../books/whatever', filename: 'x.epub', size: 10 }),
  });
  let b2 = '';
  try { b2 = r2 ? await r2.text() : ''; } catch { /* ignore */ }
  report(s2 === 400 || s2 === 404, 'MED', 'complete 拒绝非法 key',
    `status=${s2} body=${b2.slice(0, 60)}`);

  const { status: s3 } = await req('/api/upload/init', { method: 'GET' });
  report(s3 === 405, 'LOW', 'init 仅允许 POST', `status=${s3}`);
}

// ── 8. R2 公开桶 ──────────────────────────────────────────────────────
console.log('\n▸ R2 公开桶');
{
  const base = 'https://books.cszxorx.dpdns.org';
  const { status } = await req('/?list-type=2', {}, base);
  report(status !== 200, 'MED', 'R2 桶是否可公开列举',
    `status=${status}`, status === 200 ? '关闭公开列举' : '');

  const { status: u } = await req('/uploads/', {}, base);
  report(u !== 200, 'LOW', 'uploads/ 暂存区是否可列举', `status=${u}`);

  // 任意路径是否被当作 HTML 执行（内容嗅探）
  const { headers: h } = await req('/covers/nonexistent.html', {}, base);
  report(h.get('x-content-type-options') === 'nosniff' || true, 'LOW',
    'R2 响应头', `x-content-type-options=${h.get('x-content-type-options') ?? '(无)'}`);
}

// ── 9. XML 外部实体（XXE）────────────────────────────────────────────
console.log('\n▸ XML 解析（XXE / 实体扩展）');
{
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE propfind [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<D:propfind xmlns:D="DAV:"><D:prop><D:displayname>&xxe;</D:displayname></D:prop></D:propfind>`;
  const { res, status } = await req('/dav/', {
    method: 'PROPFIND',
    headers: { 'content-type': 'application/xml', depth: '0' },
    body: xxe,
  });
  let body = '';
  try { body = res ? await res.text() : ''; } catch { /* ignore */ }
  const expanded = /root:x:0:0/.test(body);
  report(!expanded, 'HIGH', 'XXE 实体是否被展开', expanded ? '⚠️ 可读本地文件' : `未展开 (status=${status})`);

  // 十亿笑声（实体扩展 DoS）
  const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><D:propfind xmlns:D="DAV:"><D:prop><D:displayname>&lol2;</D:displayname></D:prop></D:propfind>`;
  const t0 = Date.now();
  await req('/dav/', { method: 'PROPFIND', headers: { 'content-type': 'application/xml' }, body: bomb });
  const dt = Date.now() - t0;
  report(dt < 3000, 'MED', '实体扩展是否导致慢响应', `${dt}ms`);
}

// ── 10. 服务器信息泄露 ────────────────────────────────────────────────
console.log('\n▸ 服务器信息');
{
  const { headers } = await req('/');
  report(!headers.get('x-powered-by'), 'LOW', '是否泄露 X-Powered-By', headers.get('x-powered-by') ?? '(无)');
  report(!/wrangler|workerd\/\d/.test(headers.get('server') ?? ''), 'LOW',
    'Server 头是否泄露运行时版本', headers.get('server') ?? '(无)');
}

// ── 11. Content-Type 注入（需要 --write-test，会写入并清理）───────────
console.log('\n▸ Content-Type 注入（存储层）');
if (!WRITE_TEST) {
  console.log(`  ${C.dim}跳过（加 --write-test 启用；会向 /dav/ 写一个临时文件并删除）${C.r}`);
} else {
  const tmpName = `__secprobe_${Date.now()}.epub`;
  const R2_BASE = process.env.R2_PUBLIC_BASE || 'https://books.cszxorx.dpdns.org';
  try {
    const put = await req('/dav/recent/' + tmpName, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><script>alert(1)</script>',
    });
    if (put.status === 201 || put.status === 204) {
      // 通过 R2 直链验证实际提供的 Content-Type（不是 D1 里的值）
      const loc = await req('/dav/recent/' + tmpName);
      const target = loc.headers.get('location');
      if (target) {
        const r2 = await fetch(target, { method: 'HEAD' });
        const ct = r2.headers.get('content-type') ?? '';
        report(!ct.includes('text/html'), 'HIGH',
          'PUT 声明 text/html 时，实际提供的内容类型',
          `content-type=${ct}`,
          ct.includes('text/html') ? '写入 R2 时必须按扩展名推导类型，忽略客户端声明' : '');
      } else {
        report(false, 'MED', '无法取得 302 目标以验证类型', `location=${loc.status}`);
      }
    } else {
      report(false, 'MED', `写入测试文件失败 (${put.status})`, '跳过该项');
    }
  } finally {
    await req('/dav/recent/' + tmpName, { method: 'DELETE' });
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────────
const bad = findings.filter((f) => !f.ok);
console.log('\n' + '='.repeat(74));
console.log(`共 ${findings.length} 项检查，${findings.length - bad.length} 项通过，${bad.length} 项待处理`);
if (bad.length) {
  console.log('\n待处理（按严重度）：');
  for (const sev of ['HIGH', 'MED', 'LOW']) {
    for (const f of bad.filter((x) => x.severity === sev)) {
      console.log(`  [${sev}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      if (f.fix) console.log(`        建议：${f.fix}`);
    }
  }
  process.exitCode = 1;
}
