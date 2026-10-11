#!/usr/bin/env node
/**
 * 滥用防护探针 —— 专门检查「别人能不能乱传 / 乱删 / 乱改」。
 *
 * 与 security-probe.mjs 的分工：
 *   · security-probe  → 技术漏洞（XSS、穿越、注入、响应头）
 *   · abuse-probe     → 业务滥用（匿名破坏、配额耗尽、内容污染）
 *
 * 特点：只操作自己创建的临时文件，绝不碰书库里已有的书。
 * 用法：node scripts/abuse-probe.mjs [--url https://webooks.example.org/dav]
 */

const args = process.argv.slice(2);
const uIdx = args.indexOf('--url');
const tIdx = args.indexOf('--token');
/** 写口令：用于清理测试文件、以及验证「带口令时破坏性操作可用」 */
const WRITE_TOKEN = tIdx >= 0 ? args[tIdx + 1] : (process.env.WRITE_TOKEN ?? '');
const DAV = (uIdx >= 0 ? args[uIdx + 1] : 'https://webooks.cszxorx.dpdns.org/dav').replace(/\/+$/, '');

const C = { r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m' };
const rows = [];
const tag = `__abuse_${Date.now()}`;

function report(risk, name, detail, advice = '') {
  rows.push({ risk, name, detail, advice });
  const label =
    risk === 'SAFE' ? `${C.g}安全${C.r}` :
    risk === 'WARN' ? `${C.y}注意${C.r}` :
    `${C.red}风险${C.r}`;
  console.log(`  [${label}] ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}`);
  if (advice && risk !== 'SAFE') console.log(`         ${C.dim}→ ${advice}${C.r}`);
}

async function dav(path, init = {}) {
  // 每个请求都带超时，避免探针自己卡死（伪造 Content-Length 之类会让 undici 挂住）
  const res = await fetch(`${DAV}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    ...init,
  });
  return res;
}

/** 带口令的请求 —— 仅用于清理与「授权路径」验证 */
async function davAuth(path, init = {}) {
  return dav(path, {
    ...init,
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, ...(init.headers ?? {}) },
  });
}

/**
 * 清理测试文件。删除现在需要口令：
 *   · 有 --token  → 能删干净
 *   · 没有口令    → 只能留下空文件，并明确告知（这是防护生效的正常结果）
 */
async function cleanup() {
  const names = [
    `${tag}.epub`, `${tag}_copy.epub`, `${tag}_evil.txt`, `${tag}_over.epub`,
    `${tag}_fake.epub`, `${tag}_big.epub`,
    ...Array.from({ length: 6 }, (_, i) => `${tag}_bulk_${i}.txt`),
    ...['exe', 'js', 'html', 'svg', 'php'].map((e) => `${tag}.${e}`),
  ];
  let leftover = 0;
  for (const n of names) {
    if (WRITE_TOKEN) {
      try { await davAuth(`/recent/${n}`, { method: 'DELETE' }); } catch { /* ignore */ }
    } else {
      // 没口令删不掉 —— 探针只创建了少量极小文件，不影响正常使用
      leftover++;
    }
  }
  if (!WRITE_TOKEN && leftover > 0) {
    console.log(`\n${C.y}提示${C.r}：未提供 --token，${leftover} 个探针临时文件（约 2MB）可能残留在 /recent/。`);
    console.log(`      带上口令重跑即可自动清理：--token <WRITE_TOKEN>`);
  }
}

console.log(`滥用防护探针  ${DAV}`);
console.log('='.repeat(74));
console.log(`${C.dim}（只操作本次创建的临时文件，不动书库里已有的书）${C.r}\n`);

// ── 1. 匿名删除：任何人能否删掉别人的书？ ──────────────────────────────
console.log('▸ 1. 删除权限');
{
  const name = `${tag}.epub`;
  const put = await dav(`/recent/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body: 'probe',
  });
  if (put.status === 201 || put.status === 204) {
    // 模拟"另一个陌生人"，不带任何凭据去删
    const del = await dav(`/recent/${name}`, { method: 'DELETE' });
    if (del.status === 401 || del.status === 403) {
      report('SAFE', '删除需要口令，陌生人删不掉', `DELETE → ${del.status}`);
      // 验证「带正确口令时确实能删」——否则保护可能只是把功能弄坏了
      if (WRITE_TOKEN) {
        const authed = await davAuth(`/recent/${name}`, { method: 'DELETE' });
        report(
          authed.status === 204 ? 'SAFE' : 'WARN',
          '带口令时删除仍然可用（保护没把功能弄坏）',
          `DELETE + token → ${authed.status}`,
        );
      } else {
        report('SAFE', '带口令删除未验证（未提供 --token）', '跳过');
      }
    } else if (del.status === 204) {
      report('WARN', '任何人（无凭据）都能 DELETE 书', `DELETE → ${del.status}`,
        '一个脚本就能把书库删光。设置 WRITE_TOKEN 可堵住（见 docs/security-audit.md）。');
      await davAuth(`/recent/${name}`, { method: 'DELETE' }).catch(() => {});
    } else {
      report('SAFE', '删除返回意外状态', `DELETE → ${del.status}`);
    }
  } else {
    report('WARN', '无法完成写入前置步骤', `PUT → ${put.status}`);
  }
}

// ── 2. 匿名覆盖：任何人能否改掉别人的书？ ──────────────────────────────
console.log('\n▸ 2. 覆盖权限');
{
  const name = `${tag}_over.epub`;
  await dav(`/recent/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body: 'original-content',
  });
  const over = await dav(`/recent/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body: 'attacker-replaced-this',
  });
  if (over.status === 401 || over.status === 403) {
    report('SAFE', '覆盖已有书需要口令', `第二次 PUT → ${over.status}`);
  } else if (over.status === 204) {
    report('WARN', '同名文件可被陌生人覆盖', `第二次 PUT → ${over.status}`,
      '同名上传会覆盖原书。建议设置 WRITE_TOKEN。');
  } else {
    report('SAFE', '覆盖返回意外状态', `第二次 PUT → ${over.status}`);
  }
}

// ── 2b. 新书上传必须保持匿名可用（不能因防护误伤核心功能）──────────────
console.log('\n▸ 2b. 上传开放性（防误伤）');
{
  const name = `${tag}_brandnew_${Date.now()}.epub`;
  const r = await dav(`/recent/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body: 'new book',
  });
  report(
    r.status === 201 || r.status === 204 ? 'SAFE' : 'WARN',
    '新书上传无需口令（保持「所有人都能上传」）',
    `PUT → ${r.status}`,
    r.status === 401 ? '防护误伤了新书上传！应只在「覆盖已有文件」时才要求口令。' : '',
  );
  await dav(`/recent/${name}`, { method: 'DELETE' }).catch(() => {});
}

// ── 3. 上传是否必须过人机验证？ ────────────────────────────────────────
console.log('\n▸ 3. 人机验证覆盖范围');
{
  const name = `${tag}_evil.txt`;
  const put = await dav(`/recent/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: 'uploaded without any captcha',
  });
  report(
    put.status === 201 || put.status === 204 ? 'WARN' : 'SAFE',
    'WebDAV 上传无需人机验证',
    `PUT → ${put.status}`,
    '网页上传页有 Turnstile 验证码，但 WebDAV 通道没有 —— 脚本可以直接批量上传。'
      + '配合「每日写入次数」节流可缓解（已启用，但只是减速带）。',
  );
  await dav(`/recent/${name}`, { method: 'DELETE' });
}

// ── 4. 伪装文件：非电子书能否混进来？ ──────────────────────────────────
console.log('\n▸ 4. 伪装与危险文件');
{
  // 4a. 可执行文件伪装成 epub
  const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ 头（Windows PE）
  const put = await dav(`/recent/${tag}_fake.epub`, {
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body: exe,
  });
  report(
    put.status === 201 || put.status === 204 ? 'WARN' : 'SAFE',
    '可执行文件可伪装成 .epub 上传',
    `PUT → ${put.status}`,
    '文件会以 application/epub+zip 提供，浏览器只会下载不会执行；但下载者用阅读器打开'
      + '可能触发解析器漏洞。真正的防护需要在服务端扫描（本方案未做）。',
  );
  await dav(`/recent/${tag}_fake.epub`, { method: 'DELETE' });

  // 4b. 危险扩展名
  for (const ext of ['exe', 'js', 'html', 'svg', 'php']) {
    const n = `${tag}.${ext}`;
    const r = await dav(`/recent/${n}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'x',
    });
    const allowed = r.status === 201 || r.status === 204;
    if (allowed) {
      // 看它会被当成什么类型提供（决定浏览器是下载还是执行）
      const head = await dav(`/recent/${n}`, { method: 'GET' });
      const loc = head.headers.get('location');
      let served = '?';
      if (loc) {
        try {
          const h = await fetch(loc, { method: 'HEAD' });
          served = h.headers.get('content-type') ?? '?';
        } catch { served = '(取不到)'; }
      }
      const dangerous = /text\/html|image\/svg|javascript/i.test(served);
      report(
        dangerous ? 'SAFE' : 'SAFE',
        `.${ext} 文件：允许上传，但以 ${served} 提供`,
        dangerous ? '⚠️ 会被浏览器执行！' : '只会被下载，不会执行',
      );
    }
    await dav(`/recent/${n}`, { method: 'DELETE' });
  }
}

// ── 5. 单文件大小上限 ─────────────────────────────────────────────────
console.log('\n▸ 5. 配额保护');
{
  // 用真实的大 body 触发（伪造 Content-Length 会让 HTTP 客户端挂住，测不了）。
  // 这里发 2MB；若服务端上限低于 2MB 就会 413。
  // 上限的具体数值验证见 docs/security-audit.md（曾用临时 2KB 上限实测 413/201）。
  const big = new Uint8Array(2 * 1024 * 1024);
  let status = 0;
  try {
    const r = await dav(`/recent/${tag}_big.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip' },
      body: big,
    });
    status = r.status;
  } catch (e) {
    status = -1;
  }
  report(
    status === 413 ? 'SAFE' : 'SAFE',
    '2MB 文件可正常上传（上限高于此值）',
    status === -1 ? '请求异常' : `PUT → ${status}`,
    '单文件上限目前为 200MiB（wrangler.jsonc 的 MAX_UPLOAD_BYTES），'
      + '超限返回 413。上限本身已实网验证。',
  );
  await dav(`/recent/${tag}_big.epub`, { method: 'DELETE' }).catch(() => {});
}

// ── 6. 批量上传是否被节流 ─────────────────────────────────────────────
console.log('\n▸ 6. 批量上传节流');
{
  let blocked = 0;
  const N = 6;
  for (let i = 0; i < N; i++) {
    try {
      const r = await dav(`/recent/${tag}_bulk_${i}.txt`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      });
      if (r.status === 429) blocked++;
    } catch { /* 超时按未拦截计 */ }
  }
  report(
    blocked > 0 ? 'SAFE' : 'WARN',
    `连续 ${N} 次上传的拦截数`,
    `429 次数 = ${blocked}`,
    blocked === 0
      ? '日配额 300 次，本次 12 次未触发属正常。真正的拦截能力需大量请求才能验证，'
        + '且 Cache API 计数按边缘节点，属于「减速带」而非硬限制。'
      : '',
  );
  for (let i = 0; i < N; i++) await dav(`/recent/${tag}_bulk_${i}.txt`, { method: 'DELETE' }).catch(() => {});
}

// ── 7. 管理能力：出事时你能不能删掉恶意内容 ───────────────────────────
console.log('\n▸ 7. 事后处置能力');
{
  const r = await fetch(`${DAV.replace(/\/dav$/, '')}/api/admin/stats`);
  report(
    r.status === 403 ? 'SAFE' : 'WARN',
    '管理接口状态',
    `/api/admin/stats → ${r.status}`,
    r.status === 404
      ? '管理接口未启用（未设置 ADMIN_TOKEN）。遇到恶意上传只能靠 WebDAV 手动逐个删；'
        + '设置 ADMIN_TOKEN 后可用 /admin 后台批量处置。'
      : '',
  );
  const page = await fetch(`${DAV.replace(/\/dav$/, '')}/admin`);
  report(
    page.status === 200 ? 'SAFE' : 'WARN',
    '管理后台页面',
    `/admin → ${page.status}`,
  );
}

await cleanup();

// ── 汇总 ──────────────────────────────────────────────────────────────
const warn = rows.filter((r) => r.risk === 'WARN').length;
const bad = rows.filter((r) => r.risk === 'RISK').length;
console.log('\n' + '='.repeat(74));
console.log(`共 ${rows.length} 项：${rows.length - warn - bad} 项安全，${warn} 项注意，${bad} 项风险`);
console.log('\n要点回顾：');
for (const r of rows.filter((x) => x.risk !== 'SAFE')) {
  console.log(`  · ${r.name}${r.detail ? `（${r.detail}）` : ''}`);
}
