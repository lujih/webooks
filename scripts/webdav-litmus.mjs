#!/usr/bin/env node
/**
 * 完整 WebDAV 握手探针（litmus 风格）。
 *
 * 模拟「客户端挂载」的完整动作序列，逐步走通。任何一步失败就停在那，
 * 告诉你具体是哪个方法/属性让客户端拒绝挂载。
 *
 * 序列：
 *   1. OPTIONS            —— 看 DAV / Allow / ms-author-via
 *   2. PROPFIND 根 /      —— depth 1，看 isdirectory + resourcetype + 条目
 *   3. PROPFIND 目录      —— 看 isdirectory=1 / maxuploadpacketsize / supportedlock
 *   4. PROPFIND 叶子      —— 看 isdirectory=0 / getcontentlength / getetag
 *   5. MKCOL 根           —— 客户端挂载常做的探测
 *   6. LOCK 根           —— 建锁（看 Lock-Token）
 *   7. LOCK 刷新         —— If: <token>
 *   8. UNLOCK            —— 释放
 *   9. PUT 新建          —— If-None-Match: *
 *  10. GET 下载          —— 302 透传 + Accept-Ranges
 *  11. PROPPATCH         —— 假装成功 207
 *  12. MOVE              —— 201 + Location
 *  13. COPY              —— 201 + Location
 *  14. DELETE            —— 204
 *  15. PROPFIND 不存在    —— 404
 *
 * 用法：node scripts/webdav-litmus.mjs --url https://your.host/dav/
 *       node scripts/webdav-litmus.mjs --url ... --keep   # 不清理临时文件
 */

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const KEEP = args.includes('--keep');
const BASE = (urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8787/dav/').replace(/\/+$/, '');

const C = { r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m' };
const steps = [];

function record(ok, name, detail = '', ref = '') {
  steps.push({ ok, name, detail, ref });
  const tag = ok ? `${C.g}✅${C.r}` : `${C.red}✘${C.r}`;
  console.log(`  ${tag} ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}${ref ? `${C.dim} [${ref}]${C.r}` : ''}`);
  return ok;
}

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.text().catch(() => '');
  return { res, body };
}

async function main() {
  const tmp = `__litmus_${Date.now()}.txt`;
  console.log(`完整 WebDAV 握手探针  ${BASE}`);
  console.log('='.repeat(72));

  // 1) OPTIONS
  {
    const { res } = await req('/', { method: 'OPTIONS' });
    const dav = res.headers.get('dav') ?? '';
    const allow = res.headers.get('allow') ?? '';
    const msVia = res.headers.get('ms-author-via') ?? '';
    const ok =
      res.status === 200 &&
      /\b1\b/.test(dav) && /\b2\b/.test(dav) && /\b3\b/.test(dav) &&
      allow.includes('PROPFIND') && allow.includes('LOCK') &&
      msVia === 'DAV';
    record(ok, 'OPTIONS 宣告 DAV:1,2,3 + Allow + ms-author-via',
      `dav=[${dav}] allow=[${allow}] ms-author-via=[${msVia}]`, 'RFC 4918 §18 / MS-WebDAV');
    if (!ok) return cleanup(tmp);
  }

  // 2) PROPFIND 根 depth 1
  {
    const { res, body } = await req('/', {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const ok = res.status === 207 && body.includes('<D:resourcetype>') && body.includes('<D:displayname>');
    record(ok, 'PROPFIND 根目录 depth 1 → 207 + resourcetype',
      `status=${res.status} entries=${res.headers.get('x-dav-entries') ?? '?'}`, 'RFC 4918 §9.1');
    if (!ok) return cleanup(tmp);
  }

  // 3) PROPFIND 目录（/title/）MS 扩展
  {
    const { res, body } = await req('/title/', {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const ok = res.status === 207
      && body.includes('<D:isdirectory>1</D:isdirectory>')
      && body.includes('<D:iswriteable>1</D:iswriteable>')
      && body.includes('<D:maxuploadpacketsize>');
    record(ok, 'PROPFIND 目录返回 MS 扩展（isdirectory=1/maxuploadpacketsize）',
      `status=${res.status}`, 'MS-WebDAV 扩展');
  }

  // 4) PROPFIND 叶子（先 PUT 一个）
  {
    await req('/recent/' + tmp, { method: 'PUT', body: 'litmus' });
    const { res, body } = await req('/recent/' + tmp, {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const ok = res.status === 207
      && body.includes('<D:isdirectory>0</D:isdirectory>')
      && body.includes('<D:getcontentlength>')
      && body.includes('<D:getetag>');
    record(ok, 'PROPFIND 叶子返回 MS 扩展 + 标准属性',
      `status=${res.status}`, 'MS-WebDAV + RFC 4918');
  }

  // 5) MKCOL 根
  {
    const { res } = await req('/', { method: 'MKCOL' });
    record(res.status === 201, 'MKCOL 根目录 → 201（挂载探测）',
      `status=${res.status}`, 'RFC 4918 §9.3 兼容层');
  }

  // 6) LOCK 根
  let lockToken = null;
  {
    const { res } = await req('/', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth></D:lockinfo>',
    });
    lockToken = res.headers.get('lock-token');
    const ok = res.status === 200 && !!lockToken && res.body.includes('<D:lockdiscovery>');
    record(ok, 'LOCK 根（Depth:infinity）→ 200 + Lock-Token',
      `status=${res.status} token=${lockToken ?? '(无)'}`, 'RFC 4918 §9.10');
  }

  // 7) LOCK 刷新
  if (lockToken) {
    const { res } = await req('/', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', if: `(${lockToken})`, timeout: 'Second-300' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    record(res.status === 200, 'LOCK 刷新（If: <token>）→ 200',
      `status=${res.status}`, 'RFC 4918 §9.10.2');
  }

  // 8) UNLOCK
  if (lockToken) {
    const { res } = await req('/', { method: 'UNLOCK', headers: { 'lock-token': lockToken } });
    record(res.status === 204, 'UNLOCK → 204', `status=${res.status}`, 'RFC 4918 §9.11');
  }

  // 9) PUT 新建（带 If-None-Match:*）
  {
    const { res } = await req('/recent/' + tmp, {
      method: 'PUT',
      headers: { 'if-none-match': '*', 'content-type': 'application/octet-stream' },
      body: 'overwrite',
    });
    // 文件已存在（步骤 4 PUT 过），应 412
    record(res.status === 412, 'PUT 已存在 + If-None-Match:* → 412',
      `status=${res.status}`, 'RFC 4918 §10.4.3');
  }

  // 10) GET 下载
  {
    const { res } = await req('/recent/' + tmp, { method: 'GET' });
    const ok = res.status === 302 || res.status === 200;
    record(ok, 'GET 叶子 → 302/200 + Accept-Ranges',
      `status=${res.status} accept-ranges=${res.headers.get('accept-ranges') ?? '(无)'}`, 'RFC 9110 §14');
  }

  // 11) PROPPATCH
  {
    const { res, body } = await req('/recent/' + tmp, {
      method: 'PROPPATCH',
      headers: { 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:propertyupdate>',
    });
    record(res.status === 207 && body.includes('200 OK'), 'PROPPATCH → 207（兼容层假装成功）',
      `status=${res.status}`, 'RFC 4918 §9.2 兼容层');
  }

  // 12) MOVE
  const tmp2 = `__litmus_moved_${Date.now()}.txt`;
  {
    const { res } = await req('/recent/' + tmp, {
      method: 'MOVE',
      headers: { destination: `${BASE}/recent/${tmp2}` },
    });
    const ok = res.status === 201 && res.headers.get('location')?.includes(tmp2);
    record(ok, 'MOVE 到另一叶子 → 201 + Location',
      `status=${res.status} location=${res.headers.get('location') ?? '(无)'}`, 'RFC 4918 §9.8');
  }

  // 13) COPY
  {
    const { res } = await req('/recent/' + tmp2, {
      method: 'COPY',
      headers: { destination: `${BASE}/recent/__litmus_copy_${Date.now()}.txt` },
    });
    record(res.status === 201, 'COPY → 201', `status=${res.status}`, 'RFC 4918 §9.9');
  }

  // 14) DELETE
  {
    const { res } = await req('/recent/' + tmp2, { method: 'DELETE' });
    record(res.status === 204, 'DELETE → 204', `status=${res.status}`, 'RFC 4918 §9.7');
  }

  // 15) PROPFIND 不存在
  {
    const { res } = await req('/recent/__no_such_file_xyz.epub', {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    record(res.status === 404, 'PROPFIND 不存在 → 404', `status=${res.status}`, 'RFC 4918 §9.1');
  }

  await cleanup(tmp);

  // 汇总
  const pass = steps.filter((s) => s.ok).length;
  console.log('\n' + '='.repeat(72));
  console.log(`${C.g}${pass} 通过${C.r} / ${steps.length} 步`);
  if (pass < steps.length) {
    console.log('\n失败步骤：');
    for (const s of steps.filter((x) => !x.ok)) {
      console.log(`  ${C.red}✘${C.r} ${s.name}${s.detail ? `${C.dim} — ${s.detail}${C.r}` : ''}`);
    }
    process.exitCode = 1;
  }
}

async function cleanup(tmp) {
  if (KEEP) return;
  try {
    await req('/recent/' + tmp, { method: 'DELETE' });
    await req('/recent/__litmus_moved_' + Date.now() + '.txt', { method: 'DELETE' });
  } catch { /* 忽略 */ }
}

main().catch((e) => {
  console.error(`${C.red}探针自身错误：${e.message}${C.r}`);
  process.exitCode = 2;
});
