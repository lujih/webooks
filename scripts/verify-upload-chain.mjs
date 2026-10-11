#!/usr/bin/env node
/**
 * 上传链路完整自检 —— 像浏览器一样把「网页上传」从头走一遍。
 *
 * 为什么需要这个脚本（真实踩坑）：
 *   网页上传有三层，任何一层坏了，浏览器给出的报错都可能是**误导性**的：
 *     1. CSP 的 connect-src 漏掉 R2 端点 → 报「violates Content Security Policy」
 *     2. R2 密钥对不配对（签名错）→ R2 返 403，而该响应没有 CORS 头
 *        → 浏览器报成「blocked by CORS policy」，让人以为是 CORS 配置问题
 *     3. R2 CORS 规则没放行站点域名 → 预检失败
 *   结果就是：报错信息指向 A，真正原因却是 B。
 *   这个脚本直接测每一层，把「猜」变成「看」。
 *
 * 用法（凭据从环境变量读，不落盘）：
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *   R2_BUCKET_NAME=... node scripts/verify-upload-chain.mjs \
 *     [--site https://webooks.example.org] [--log-signature <sig> --log-date <20261011T160337Z> --log-key <key>]
 *
 * 退出码：0 = 全通；1 = 有问题。
 */

import { createPresignedPutUrl } from '../src/lib/sigv4.ts';

const args = process.argv.slice(2);
const getArg = (n, d = '') => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const {
  R2_ACCOUNT_ID: accountId,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
  R2_BUCKET_NAME: bucket,
} = process.env;

const SITE = getArg('--site', 'https://webooks.cszxorx.dpdns.org').replace(/\/+$/, '');

const C = { r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m' };
let failed = 0;

function ok(name, detail = '') {
  console.log(`  ${C.g}✅${C.r} ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}`);
}
function bad(name, detail = '', hint = '') {
  failed++;
  console.log(`  ${C.red}❌${C.r} ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}`);
  if (hint) console.log(`      ${C.dim}→ ${hint}${C.r}`);
}
function info(name, detail = '') {
  console.log(`  ${C.y}ℹ${C.r}  ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}`);
}

const missing = Object.entries({ accountId, accessKeyId, secretAccessKey, bucket })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`缺少环境变量: ${missing.join(', ')}`);
  process.exit(2);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

console.log(`上传链路自检  ${SITE}`);
console.log('='.repeat(74));

// ── 1. 站点侧配置 ─────────────────────────────────────────────────────
console.log('\n▸ 1. 站点侧配置');
{
  const res = await fetch(`${SITE}/api/upload/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'probe.epub', size: 10, turnstileToken: 'x' }),
  }).catch(() => null);
  const json = res ? await res.json().catch(() => ({})) : {};
  if (json.error === 'turnstile-failed') {
    ok('上传接口已配置齐全', '只差真人验证码（预期行为）');
  } else if (json.error === 'upload-not-configured') {
    bad('上传接口缺配置', `missing: ${(json.missing ?? []).join(', ')}`,
      '用 wrangler secret put 补齐这些密钥');
  } else {
    bad('上传接口返回意外结果', JSON.stringify(json).slice(0, 120));
  }

  const cfg = await fetch(`${SITE}/api/turnstile-config`).then((r) => r.json()).catch(() => ({}));
  cfg.siteKey ? ok('Turnstile 公钥已配置') : bad('Turnstile 公钥缺失', '', '设置 TURNSTILE_SITE_KEY');

  const html = await fetch(`${SITE}/upload`).then((r) => r.text()).catch(() => '');
  const csp = /content-security-policy/i.test(html) ? '' : '';
  const hdr = await fetch(`${SITE}/upload`).then((r) => r.headers.get('content-security-policy') ?? '').catch(() => '');
  void csp;
  hdr.includes('r2.cloudflarestorage.com')
    ? ok('CSP 允许 R2 直传端点')
    : bad('CSP 未允许 R2 直传端点', hdr.slice(0, 80),
        '在 connect-src 里加 https://*.r2.cloudflarestorage.com，否则上传会被安全策略拦掉');
}

// ── 2. 密钥对是否配对（用真实 PUT 验证） ──────────────────────────────
console.log('\n▸ 2. R2 密钥对');
const probeKey = `upload-chain-probe/${Date.now()}/${'中文测试：书名 - 作者.epub'}`;
const ct = 'application/epub+zip';
let signedUrl = '';
try {
  signedUrl = await createPresignedPutUrl({
    accessKeyId, secretAccessKey, accountId, bucket,
    key: probeKey, contentType: ct, expiresIn: 900, amzDate: stamp(),
  });
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'content-type': ct, origin: SITE },
    body: 'probe',
  });
  if (res.status === 200) {
    ok('预签名 PUT 成功（签名有效）', `含中文文件名，status=200`);
  } else {
    const body = (await res.text().catch(() => '')).slice(0, 120);
    bad('预签名 PUT 被拒', `status=${res.status} ${body}`,
      '最常见原因：access key 与 secret 不是一对（签名校验失败）。'
        + '注意 R2 的 403 响应不带 CORS 头，浏览器会把它显示成 CORS 错误，别被误导。');
  }
} catch (e) {
  bad('预签名 PUT 抛错', e.message);
}

// ── 3. CORS 预检（浏览器实际会先发这个） ──────────────────────────────
console.log('\n▸ 3. CORS 预检');
if (signedUrl) {
  const res = await fetch(signedUrl, {
    method: 'OPTIONS',
    headers: {
      origin: SITE,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    },
  }).catch(() => null);
  const acao = res?.headers.get('access-control-allow-origin') ?? '';
  const acam = res?.headers.get('access-control-allow-methods') ?? '';
  if (acao) {
    ok('预检通过', `${res.status} · allow-origin=${acao} · methods=${acam}`);
  } else {
    bad('预检失败（缺 Access-Control-Allow-Origin）', `status=${res?.status ?? '请求失败'}`,
      `用 wrangler r2 bucket cors set ${bucket} --file r2-cors.json 添加规则，`
        + `origins 必须包含 ${SITE}`);
  }
} else {
  info('跳过（上一步没拿到有效签名）');
}

// ── 4. 可选：比对日志里的签名 ─────────────────────────────────────────
const logSig = getArg('--log-signature');
if (logSig) {
  console.log('\n▸ 4. 与日志签名比对');
  const logDate = getArg('--log-date');
  const logKey = getArg('--log-key');
  if (!logDate || !logKey) {
    info('需要同时提供 --log-date 与 --log-key 才能比对');
  } else {
    const u = await createPresignedPutUrl({
      accessKeyId, secretAccessKey, accountId, bucket,
      key: logKey, contentType: ct, expiresIn: 900, amzDate: logDate,
    });
    const mine = new URL(u).searchParams.get('X-Amz-Signature');
    if (mine === logSig) {
      ok('签名一致', '线上 Worker 用的密钥对与本机相同');
    } else {
      bad('签名不一致', `本机 ${mine?.slice(0, 16)}… vs 日志 ${logSig.slice(0, 16)}…`,
        '线上 Worker 存的 secret 与 access key 不配对 → 所有上传都会被 R2 拒 403。'
          + '用 wrangler secret put R2_SECRET_ACCESS_KEY 更新为已验证的值。');
    }
  }
}

// ── 清理 ──────────────────────────────────────────────────────────────
try {
  const del = await createPresignedPutUrl({
    accessKeyId, secretAccessKey, accountId, bucket,
    key: probeKey, amzDate: stamp(), expiresIn: 900,
  });
  // 预签名只签 PUT，删除需要另行授权；这里仅提示
  void del;
  info('测试对象留在 R2', `前缀 upload-chain-probe/（可在 Dashboard 批量删除）`);
} catch { /* ignore */ }

console.log('\n' + '='.repeat(74));
if (failed === 0) {
  console.log(`${C.g}全部通过${C.r} —— 上传链路在配置层面是通的（真人验证码需在浏览器里完成）`);
} else {
  console.log(`${C.red}${failed} 项有问题${C.r} —— 见上面的 → 提示`);
  process.exitCode = 1;
}
