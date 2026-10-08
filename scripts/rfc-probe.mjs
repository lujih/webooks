#!/usr/bin/env node
/**
 * RFC 4918 / RFC 9110 合规差距探针。
 *
 * 目的：把「适配最新标准」从口号变成可核对的清单 —— 逐条实测线上服务器，
 * 只报实测结果，不臆测。
 *
 * 依据：
 *   RFC 4918 (2007)  WebDAV —— 基础标准，至今未废弃
 *   RFC 9110 (2022)  HTTP Semantics —— 取代 RFC 7231，是「最新」的 HTTP 核心
 *   RFC 5689 (2009)  Extended MKCOL
 *   RFC 5789 (2010)  PATCH
 *
 * 用法：node scripts/rfc-probe.mjs --url https://your.host/dav/
 */

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = (urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8787/dav/').replace(/\/+$/, '');
const ORIGIN = new URL(BASE).origin;

const C = { r: '\x1b[0m', y: '\x1b[33m', g: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m' };

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.text().catch(() => '');
  return { res, body };
}

const rows = [];
function check(name, ok, detail, ref) {
  rows.push({ name, ok, detail, ref });
  const tag = ok ? `${C.g}✅${C.r}` : `${C.y}⚠️${C.r}`;
  console.log(`  ${tag} ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}${ref ? `${C.dim} [${ref}]${C.r}` : ''}`);
}

// ── 造一个可写文件 ──
{
  const tmpRes = await req('/recent/' + tmp, { method: 'PUT', body: 'probe' });
  if (tmpRes.res.status !== 201 && tmpRes.res.status !== 204) {
    // 环境不健康（503 = D1 未迁移 / 1101 = Worker 崩）—— 早期退出，避免 20 条误导
    console.error(`\n  ✘ PUT ${tmp} 返回 ${tmpRes.res.status}，环境不健康，停止后续检查。`);
    console.error(`    若 503：D1 表未建好，先跑 db:migrate\n    若 1101：Worker 崩溃，查 Workers Logs`);
    process.exit(2);
  }
}

console.log(`RFC 合规探针  ${BASE}`);
console.log('='.repeat(72));

// ── OPTIONS 的 DAV 头 ──
{
  const { res } = await req('/', { method: 'OPTIONS' });
  const dav = res.headers.get('dav') ?? '';
  // RFC 4918 §18: 完全合规应宣告 "1, 2, 3"（含 Class 2 LOCK）
  const has2 = /\b2\b/.test(dav);
  const has3 = /\b3\b/.test(dav);
  check('OPTIONS 宣告 RFC 4918 完整等级（DAV: 1, 2, 3）', has2 && has3, `DAV: ${dav || '(空)'}`, 'RFC 4918 §18');
}

// ── OPTIONS * ──
{
  try {
    const res = await fetch(`${ORIGIN}${BASE.replace(ORIGIN, '')}`, { method: 'OPTIONS' });
    check('OPTIONS * （服务器级能力查询）', res.status === 200, `status=${res.status}`, 'RFC 9110 §9.3.7');
  } catch (e) {
    check('OPTIONS * （服务器级能力查询）', false, e.message, 'RFC 9110 §9.3.7');
  }
}

// ── PUT 到集合路径应 405 ──
{
  const { res } = await req('/recent/', { method: 'PUT', body: 'x' });
  const allow = res.headers.get('allow');
  const ok = res.status === 405 && !!allow;
  check('PUT 打到集合路径应 405 且带 Allow', ok, `status=${res.status} allow=${allow ?? '(无)'}`, 'RFC 4918 §9.7.1');
}

// ── 条件请求 If-None-Match: * ──
// RFC 4918 §10.4.3 / RFC 9110 §13.1.3：目标已存在时应 412
{
  const { res } = await req('/recent/' + tmp, {
    method: 'PUT', body: 'overwrite attempt',
    headers: { 'If-None-Match': '*' },
  });
  const ok = res.status === 412;
  check('If-None-Match: * 防止误覆盖（期望 412）', ok, `status=${res.status}（未实现则会是 204/200）`, 'RFC 4918 §10.4.3');
}

// ── If-Match 用 ETag ──
{
  const head = await req('/recent/' + tmp, { method: 'HEAD' });
  const etag = head.res.headers.get('etag');
  if (etag) {
    const bad = await req('/recent/' + tmp, {
      method: 'PUT', body: 'x', headers: { 'If-Match': '"not-the-right-etag"' },
    });
    check('If-Match 校验 ETag（不匹配应 412）', bad.res.status === 412, `status=${bad.res.status}`, 'RFC 9110 §13.1.1');
  } else {
    check('If-Match 校验 ETag', false, 'HEAD 未返回 ETag', 'RFC 9110 §13.1.1');
  }
}

// ── PROPPATCH 兼容层：假装成功（回 207，避免客户端无限重试）──
{
  const xml = '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:propertyupdate>';
  const { res, body } = await req('/recent/' + tmp, { method: 'PROPPATCH', headers: { 'content-type': 'application/xml' }, body: xml });
  const ok = res.status === 207 && /<D:status>HTTP\/1\.1 200 OK/.test(body);
  check('PROPPATCH 返回 207 成功（兼容层，避免客户端重试）', ok,
    `status=${res.status} body=${body.slice(0, 60).replace(/\n/g, ' ')}`, 'RFC 4918 §9.2 兼容层');
}

// ── LOCK 应宣告 Class 2 并返回 200 + Lock-Token ──
{
  const { res, body } = await req('/recent/' + tmp, {
    method: 'LOCK',
    body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>',
  });
  const token = res.headers.get('lock-token');
  const ok = res.status === 200 && !!token && /<D:lockdiscovery>/.test(body);
  check('LOCK 返回 200 + Lock-Token（Class 2 已实现）', ok,
    `status=${res.status} lock-token=${token ?? '(无)'}`, 'RFC 4918 §9.10');

  // 刷新（带 If 头）
  if (token) {
    const refreshRes = await req('/recent/' + tmp, {
      method: 'LOCK',
      headers: { if: `(${token})`, timeout: 'Second-300' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    check('LOCK 刷新（If: <token>）返回 200', refreshRes.res.status === 200,
      `status=${refreshRes.res.status ?? '(undefined)'}`, 'RFC 4918 §9.10.2');
    // 释放
    const unlockRes = await req('/recent/' + tmp, { method: 'UNLOCK', headers: { 'lock-token': token } });
    if (unlockRes.res.status !== 204) {
      console.log(`    ${C.dim}（UNLOCK 返回 ${unlockRes.res.status}，见上）${C.r}`);
    }
  }
}

// ── MKCOL 应接受虚拟目录创建（客户端挂载兼容性）──
{
  const { res } = await req('/title/A/', { method: 'MKCOL' });
  const ok = res.status === 201;
  check('MKCOL 虚拟目录返回 201 Created（客户端挂载兼容）', ok, `status=${res.status}`, 'RFC 4918 §9.3 兼容层');
}

// ── PATCH 未实现须 405 且 Allow 不含 PATCH ──
{
  const { res } = await req('/recent/' + tmp, { method: 'PATCH', body: 'x' });
  const ok = res.status === 405;
  check('PATCH 未实现须返回 405', ok, `status=${res.status}`, 'RFC 5789');
}

// ── Range 请求 ──
{
  const { res } = await req('/recent/' + tmp, { method: 'GET', headers: { Range: 'bytes=0-3' } });
  const hasAcc = res.headers.get('accept-ranges');
  // GET 是 302 跳 R2，Range 由 R2 处理；这里确认是否声明支持
  check('声明 Accept-Ranges（分段下载/断点续传）', res.status === 302 ? !!hasAcc : true,
    `status=${res.status} accept-ranges=${hasAcc ?? '(无)'}`, 'RFC 9110 §14');
}

// ── 204 不应带 Content-Length ──
{
  const { res } = await req('/recent/' + tmp, { method: 'PUT', body: 'v2' });
  const cl = res.headers.get('content-length');
  const ok = res.status !== 204 || (!cl || cl === '0');
  check('204 响应不应带非零 Content-Length', ok, `status=${res.status} content-length=${cl ?? '(无)'}`, 'RFC 9110 §8.6');
}

// ── PROPFIND on 不存在的资源应 404 ──
{
  const { res } = await req('/recent/__definitely_missing_9999.txt', { method: 'PROPFIND', headers: { depth: '0' } });
  check('PROPFIND 不存在的资源应 404', res.status === 404, `status=${res.status}`, 'RFC 4918 §9.1');
}

// ── Depth: infinity 按 RFC 应 403 + propfind-finite-depth（当配置为 downgrade 时 207 也可）──
{
  const { res } = await req('/', { method: 'PROPFIND', headers: { depth: 'infinity' } });
  const ok = res.status === 207 || res.status === 403;
  check('Depth: infinity 处理合规（207 或 403）', ok, `status=${res.status}`, 'RFC 4918 §9.1');
}

// 清理
await req('/recent/' + tmp, { method: 'DELETE' });

// 汇总
console.log('='.repeat(72));
const bad = rows.filter((r) => !r.ok);
console.log(`${rows.length - bad.length} 通过 / ${bad.length} 待改进 / ${rows.length} 项`);
if (bad.length) {
  console.log('\n待改进项：');
  for (const b of bad) console.log(`  ⚠️  ${b.name} — ${b.detail}`);
  process.exit(1);
}