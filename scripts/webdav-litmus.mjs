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
const tIdx = args.indexOf('--token');
const KEEP = args.includes('--keep');
/**
 * 写口令。破坏性操作（DELETE / MOVE / 覆盖已有文件）现在需要口令，
 * 所以这个探针必须能带上它，否则测的是「未授权路径」而不是协议本身。
 */
const TOKEN = tIdx >= 0 ? args[tIdx + 1] : (process.env.WRITE_TOKEN ?? '');
const BASE = (urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8787/dav/').replace(/\/+$/, '');

const C = { r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m' };
const steps = [];

function record(ok, name, detail = '', ref = '') {
  steps.push({ ok, name, detail, ref });
  const tag = ok ? `${C.g}✅${C.r}` : `${C.red}✘${C.r}`;
  console.log(`  ${tag} ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}${ref ? `${C.dim} [${ref}]${C.r}` : ''}`);
  return ok;
}

/** 带写口令的请求（破坏性操作用） */
function authHeaders(extra = {}) {
  return TOKEN ? { authorization: `Bearer ${TOKEN}`, ...extra } : extra;
}

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    ...init,
  });
  const body = await res.text().catch(() => '');
  return { res, body };
}

/** 破坏性请求：自动带上口令（若有） */
async function reqAuth(path, init = {}) {
  return req(path, { ...init, headers: authHeaders(init.headers ?? {}) });
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
    const classes = dav.split(',').map((s) => s.trim());
    // RFC 4918 §18.2：宣告 1 + 2（Class 2 = 有锁）。
    // 刻意**不**宣告 3：§18.3 说宣告 3 等于声称满足全部 MUST，
    // 而本服务有三处有意偏离（MKCOL 不真正建目录 / PROPPATCH 不持久化 /
    // DELETE 根目录不支持），宣告 3 是不实声明。
    const ok =
      res.status === 200 &&
      classes.includes('1') && classes.includes('2') &&
      allow.includes('PROPFIND') && allow.includes('LOCK') &&
      msVia === 'DAV';
    record(ok, 'OPTIONS 宣告 DAV:1,2（Class 2，不宣告 3）+ Allow + ms-author-via',
      `dav=[${dav}] allow=[${allow}] ms-author-via=[${msVia}]`, 'RFC 4918 §18.2 / MS-WebDAV');
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
    const putRes = await req('/recent/' + tmp, { method: 'PUT', body: 'litmus' });
    if (putRes.res.status !== 201 && putRes.res.status !== 204) {
      record(false, 'PUT 新建测试文件（前置条件）',
        `status=${putRes.res.status}（环境不健康，停止）`);
      return cleanup(tmp);
    }
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
    // RFC 4918 §9.3：URI 已映射到资源时 MKCOL MUST fail（§9.3.1 规定用 405）。
    // 405 同时是**挂载安全**的：客户端把 405 理解为「集合已存在」并继续挂载，
    // 所以不像返回 201 那样需要额外的兼容判断。
    record(res.status === 405, 'MKCOL 根目录 → 405（已映射，规范要求失败）',
      `status=${res.status}`, 'RFC 4918 §9.3 / §9.3.1');
  }

  // 6) LOCK 根
  //    LOCK 是「承载写入权威」的操作：§14.15 规定 locktype 只有 write 一种，
  //    而一把集合锁会让整个子树的写全部 423 —— 爆炸半径大于 DELETE，所以和
  //    DELETE/MOVE 一样需要写口令（有意偏离，见 docs/rfc-compliance.md 偏离表）。
  //    没带 --token 时 401 是**预期**，如实记一条通过并说明，而不是记成失败：
  //    既不能把「按设计拒绝」算作协议退化，也不能悄悄跳过（那会让「锁协议真的
  //    坏掉」和「只是没带口令」在输出里长得一模一样）。
  let lockToken = null;
  {
    const { res, body } = await reqAuth('/', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth></D:lockinfo>',
    });
    // 统一归一成**令牌本体**（裸 URI）存着；该补括号的地方（step 7 的 If 头、
    // step 8 的 Lock-Token 头）各自按 §10.1 的 Coded-URL 补回来。
    // 这样两条路径（200 响应头 / 423 正文）拿到的东西形态一致，
    // 也不会出现「头里发了裸 URI」这种依赖服务端宽容度的写法。
    lockToken = res.headers.get('lock-token');
    lockToken = lockToken ? lockToken.replace(/^</, '').replace(/>$/, '') : null;
    let ok = res.status === 200 && !!lockToken && body.includes('<D:lockdiscovery>');
    // 若已有锁（423），从 lockdiscovery 里提取 token 供后续 unlock。
    //
    // ⚠️ 2026-10-17 修两处：
    //   ① 旧正则 `/<urn:uuid:[0-9a-f-]+/` 是**死正则** —— 正文里的令牌要么是
    //      转义形态 `&lt;urn:uuid:…&gt;`（旧代码的产物），要么是裸 URI
    //      `urn:uuid:…`（§14.14 要求的形态），两种都匹配不到开头那个 `<`。
    //   ② 旧代码匹配到之后无条件写 `ok = true`，是**掩盖式赋值**：无论 423 的
    //      真实原因是什么，只要 body 里凑巧出现令牌片段就记成通过，把失败
    //      伪装成成功。现在 ok 只在**确实取到这把锁的令牌**时才置真。
    //   注意取出的必须是**本体**（裸 URI）：step 7 拼 If 头、step 8 拼
    //   Lock-Token 头时会各自补回该有的括号形态。
    if (!ok && res.status === 423) {
      const m = body.match(/&lt;(urn:uuid:[0-9a-f-]+)&gt;|(urn:uuid:[0-9a-f-]+)/);
      if (m) {
        lockToken = m[1] ?? m[2] ?? null;
        ok = !!lockToken && body.includes('<D:activelock>');
      }
    }
    if (!TOKEN && res.status === 401) {
      record(true, '未提供 --token：LOCK → 401（本站要求写口令，属预期不是退化）',
        `status=${res.status}，带 --token 重跑可完整验证锁流程`, 'rfc-compliance.md 偏离表');
    } else {
      record(ok, 'LOCK 根（Depth:infinity）→ 200 + Lock-Token',
        `status=${res.status} token=${lockToken ?? '(无)'}`, 'RFC 4918 §9.10');
    }
  }

  // 7) LOCK 刷新
  //    If 头按 §10.4 是 `(<Coded-URL>)`：lockToken 存的是本体，这里补回尖括号。
  //    旧写法 `(${lockToken})` 在裸形态下会发出 `(urn:uuid:…)`，缺一层尖括号 ——
  //    服务端宽容能吃下，但探针本身就成了不规范客户端的样本，失去验证价值。
  if (lockToken) {
    const { res } = await reqAuth('/', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', if: `(<${lockToken}>)`, timeout: 'Second-300' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    record(res.status === 200, 'LOCK 刷新（If: (<token>)）→ 200',
      `status=${res.status}`, 'RFC 4918 §9.10.2');
  } else {
    console.log(`      ${C.dim}（无锁令牌，跳过刷新 —— 未提供 --token 时锁流程无法验证）${C.r}`);
  }

  // 8) UNLOCK —— 必须释放，否则 Depth:infinity 根锁会挡死后续所有写操作
  //    §10.5：Lock-Token 头是 Coded-URL，本体外面必须包一层尖括号。
  if (lockToken) {
    const { res } = await req('/', { method: 'UNLOCK', headers: { 'lock-token': `<${lockToken}>` } });
    record(res.status === 204, 'UNLOCK → 204（释放根锁）', `status=${res.status}`, 'RFC 4918 §9.11');
  }

  // 9) PUT 已存在 + If-None-Match:* → 412
  {
    const { res } = await req('/recent/' + tmp, {
      method: 'PUT',
      headers: { 'if-none-match': '*', 'content-type': 'application/octet-stream' },
      body: 'overwrite',
    });
    // 文件在步骤 4 已 PUT，If-None-Match: * 要求"目标不存在"才写 → 应 412
    // 若被锁挡住会是 423（步骤 8 已释放根锁，正常不应出现）
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
    record(res.status === 207 && body.includes('403 Forbidden') && body.includes('cannot-modify-protected-property'),
      'PROPPATCH → 207 + 403 + 前置条件（如实报告，不谎报成功）',
      `status=${res.status}`, 'RFC 4918 §9.2 / §9.2.1');
  }

  // 12) MOVE（破坏性操作 → 带口令）
  const tmp2 = `__litmus_moved_${Date.now()}.txt`;
  {
    const { res } = await reqAuth('/recent/' + tmp, {
      method: 'MOVE',
      headers: { destination: `${BASE}/recent/${tmp2}` },
    });
    const ok = res.status === 201 && res.headers.get('location')?.includes(tmp2);
    record(ok, 'MOVE 到另一叶子 → 201 + Location',
      `status=${res.status} location=${res.headers.get('location') ?? '(无)'}` +
      (TOKEN ? '' : '（未提供 --token，401 属预期）'), 'RFC 4918 §9.8');
  }

  // 13) COPY
  {
    const { res } = await req('/recent/' + tmp2, {
      method: 'COPY',
      headers: { destination: `${BASE}/recent/__litmus_copy_${Date.now()}.txt` },
    });
    record(res.status === 201, 'COPY → 201', `status=${res.status}`, 'RFC 4918 §9.9');
  }

  // 14) DELETE（破坏性操作 → 带口令）
  {
    const { res } = await reqAuth('/recent/' + tmp2, { method: 'DELETE' });
    record(res.status === 204, 'DELETE → 204', `status=${res.status}`, 'RFC 4918 §9.7');
  }

  // 14b) 未授权防护：无口令的 DELETE 必须被拒（安全回归）
  {
    const probeName = `__litmus_authprobe_${Date.now()}.txt`;
    await req('/recent/' + probeName, { method: 'PUT', body: 'x' });
    const anon = await req('/recent/' + probeName, { method: 'DELETE' });
    const anonStatus = anon.res.status;
    // 配了口令时必须是 401；没配口令时探针无法验证该项，跳过
    const ok = TOKEN ? anonStatus === 401 : true;
    record(ok, TOKEN ? '无口令 DELETE → 401（口令保护生效）' : '口令未配置，跳过删除防护检查',
      `status=${anonStatus}`, '安全策略');
    await reqAuth('/recent/' + probeName, { method: 'DELETE' });
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
  // 删除现在需要口令；没有口令时会留下少量探针文件，明确提示而不是静默残留
  try {
    await reqAuth('/recent/' + tmp, { method: 'DELETE' });
    const listing = await req('/recent/', {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const leftovers = [...listing.body.matchAll(/<D:href>[^<]*\/(__litmus[^<]*)<\/D:href>/g)].map((m) => m[1]);
    for (const name of leftovers) {
      await reqAuth('/recent/' + decodeURIComponent(name), { method: 'DELETE' });
    }
    if (leftovers.length > 0 && !TOKEN) {
      console.log(`\n${C.y}提示${C.r}：删除需要口令，${leftovers.length} 个探针文件可能残留；` +
        `带 --token 重跑可自动清理。`);
    }
  } catch { /* 忽略 */ }
}

main().catch((e) => {
  console.error(`${C.red}探针自身错误：${e.message}${C.r}`);
  process.exitCode = 2;
});
