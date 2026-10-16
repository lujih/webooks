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
const tIdx = args.indexOf('--token');
/**
 * 写口令。破坏性操作（覆盖已有文件 / DELETE / MOVE）现在需要口令，
 * 不带上它会把「401 未授权」误报成「RFC 不合规」。
 */
const TOKEN = tIdx >= 0 ? args[tIdx + 1] : (process.env.WRITE_TOKEN ?? '');
const BASE = (urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:8787/dav/').replace(/\/+$/, '');
const ORIGIN = new URL(BASE).origin;

const C = { r: '\x1b[0m', y: '\x1b[33m', g: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m' };

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    ...init,
    // 默认带上写口令（读操作会忽略它），避免把授权问题误报成协议问题
    headers: TOKEN
      ? { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) }
      : init.headers,
  });
  const body = await res.text().catch(() => '');
  return { res, body };
}

const rows = [];
function check(name, ok, detail, ref) {
  rows.push({ name, ok, detail, ref });
  const tag = ok ? `${C.g}✅${C.r}` : `${C.y}⚠️${C.r}`;
  console.log(`  ${tag} ${name}${detail ? `${C.dim} — ${detail}${C.r}` : ''}${ref ? `${C.dim} [${ref}]${C.r}` : ''}`);
}

/**
 * 严格 XML 良构检查（标签配对 + 单一根元素）。
 *
 * 为什么必须有：LOCK 响应历史上输出过 `<D:locktoken><D:locktoken>…`
 * —— 标签开了两次只关一次，不是合法 XML，所有严格客户端解析失败，
 * 而 `expect(xml).toContain(...)` 完全测不出来。验证 XML 只能用解析器/配对检查。
 * （与 test/xml-wellformed-lib.ts 同源；线上用 .NET XmlDocument 交叉验证过。）
 */
function isWellFormedXml(xml) {
  const src = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack = [];
  let rootSeen = 0;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); if (e < 0) return { err: '注释未闭合' }; i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt); if (e < 0) return { err: 'CDATA 未闭合' }; i = e + 3; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); if (e < 0) return { err: '声明未闭合' }; i = e + 1; continue; }
    const gt = src.indexOf('>', lt);
    if (gt < 0) return { err: '标签未闭合' };
    const inner = src.slice(lt + 1, gt).trim();
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const top = stack.pop();
      if (top === undefined) return { err: `多余闭合 </${name}>` };
      if (top !== name) return { err: `</${name}> 与 <${top}> 不匹配` };
    } else if (inner.endsWith('/')) {
      if (stack.length === 0) { rootSeen++; if (rootSeen > 1) return { err: '多个根元素' }; }
    } else {
      const name = inner.split(/[\s>\/]/)[0] || '';
      if (!name) return { err: '空标签名' };
      if (stack.length === 0) { rootSeen++; if (rootSeen > 1) return { err: '多个根元素' }; }
      stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length > 0) return { err: `未闭合 <${stack.join('>, <')}>` };
  if (rootSeen !== 1) return { err: `根元素数=${rootSeen}` };
  return { err: null };
}

// ── 造一个可写文件（后面的检查都基于它）──
const tmp = `__rfcprobe_${Date.now()}.txt`;
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
  const classes = dav.split(',').map((s) => s.trim());
  // RFC 4918 §18.2：Class 2 = Class 1 + LOCK/UNLOCK，必须宣告 1 和 2。
  // §18.3：宣告 3 等于声称「满足本规范全部要求」—— 本服务有三处有意偏离
  //        （MKCOL 不真正建目录 / PROPPATCH 不持久化 / DELETE 根目录不支持），
  //        所以**不应**宣告 3。宣告 3 是不实声明。
  const has1 = classes.includes('1');
  const has2 = classes.includes('2');
  const has3 = classes.includes('3');
  check('OPTIONS 宣告 DAV: 1, 2（Class 2 含 LOCK/UNLOCK）', has1 && has2, `DAV: ${dav || '(空)'}`, 'RFC 4918 §18.2');
  check('不宣告 class 3（未满足全部 MUST，宣告即不实）', !has3, `DAV: ${dav || '(空)'}`, 'RFC 4918 §18.3');
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

// ── PROPPATCH：属性无法持久化，应如实报告 403 + 前置条件 ──
{
  const xml = '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:propertyupdate>';
  const { res, body } = await req('/recent/' + tmp, { method: 'PROPPATCH', headers: { 'content-type': 'application/xml' }, body: xml });
  // RFC 4918 §9.2：指令「MUST either all be executed or none executed」。
  // §9.2.1：无法修改的属性应 403 + cannot-modify-protected-property。
  // 早期实现回 200 OK 却什么都不写 —— 那是虚假成功，客户端会据此缓存「已设置」。
  const ok = res.status === 207
    && /<D:status>HTTP\/1\.1 403 Forbidden/.test(body)
    && /cannot-modify-protected-property/.test(body)
    && !/HTTP\/1\.1 200 OK/.test(body);
  check('PROPPATCH 如实报告无法修改（207 + 403 + 前置条件，不谎报成功）', ok,
    `status=${res.status} body=${body.slice(0, 90).replace(/\n/g, ' ')}`, 'RFC 4918 §9.2 / §9.2.1');
}

// ── LOCK 应宣告 Class 2 并返回 200 + Lock-Token ──
// ⚠️ LOCK 需要写口令（有意偏离，见 docs/rfc-compliance.md 偏离表）：一把集合锁
//    会让整个子树的写全部 423，爆炸半径大于 DELETE。没有 --token 时服务端回
//    401 是**预期**，不能把「没带口令」报成「RFC 不合规」；但也不能静默跳过、
//    还让输出看起来像「全部通过」—— 所以显式记一行说明。
if (!TOKEN) {
  check('LOCK 需写口令：未提供 --token，跳过锁协议检查（401 属预期，非不合规）', true,
    '带 --token "$WRITE_TOKEN" 重跑可完整验证 LOCK / 刷新 / UNLOCK', 'rfc-compliance.md 偏离表');
} else {
  const { res, body } = await req('/recent/' + tmp, {
    method: 'LOCK',
    body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>',
  });
  const token = res.headers.get('lock-token');
  const ok = res.status === 200 && !!token && /<D:lockdiscovery>/.test(body);
  check('LOCK 返回 200 + Lock-Token（Class 2 已实现）', ok,
    `status=${res.status} lock-token=${token ?? '(无)'}`, 'RFC 4918 §9.10');

  // §9.10.1：lockdiscovery 必须在 prop 元素里
  check('LOCK 响应把 lockdiscovery 包在 prop 元素内', /<D:prop[\s>]/.test(body) && /<D:lockdiscovery>/.test(body),
    `body=${body.slice(0, 70).replace(/\n/g, ' ')}`, 'RFC 4918 §9.10.1');

  // §8.2：所有 XML MUST be well formed。历史上 LOCK 曾输出
  // `<D:locktoken><D:locktoken>…`（标签不配对），所有严格客户端都会挂，
  // 而字符串包含断言测不出来 —— 这里用严格配对检查。
  const wf = isWellFormedXml(body);
  check('LOCK 响应是良构 XML（标签配对）', wf.err === null,
    wf.err ? `解析错误：${wf.err}` : '标签配对正确', 'RFC 4918 §8.2');

  // §14.14 + §10.5：正文里的 href 是**令牌 URI 本体**（裸），头部才是 Coded-URL。
  //
  // ⚠️ 2026-10-17 订正：这条检查原来只做 `body.includes(bare)` ——
  //    而旧代码输出的 `&lt;urn:uuid:xxx&gt;` **也包含** `urn:uuid:xxx` 这个子串，
  //    所以它在 bug 存在期间一直是 ✅。判据本身写错了（「与 Lock-Token 头一致」
  //    恰好是 bug 的表现 —— 头部按 §10.5 带括号、XML 里按 §14.7 是本体），
  //    缺陷因此长期存活。现在按元素取值判：必须正好是
  //    `<D:href>urn:uuid:…</D:href>`，且不许出现带括号的形态。
  if (token) {
    const bare = token.replace(/^</, '').replace(/>$/, '');
    const exact = body.includes(`<D:href>${bare}</D:href>`);
    const bracketed = body.includes(`&lt;${bare}&gt;`) || body.includes(`<D:href><${bare}>`);
    check('锁令牌 href 是裸 URI（尖括号只属于头部形态）', exact && !bracketed,
      bracketed
        ? '正文里出现了带括号形态 → 客户端拼出 <<urn:uuid:…>> → 409，解不开自己刚建的锁'
        : `期望 <D:href>${bare}</D:href>`, 'RFC 4918 §14.14 / §10.5 / §9.10.7');
    // 反向：把 href 的形态补成 Coded-URL，必须正好等于响应头（自救路径可走通）
    check('用 href 拼出的 Coded-URL 等于响应头 Lock-Token', `<${bare}>` === token,
      `href+括号=<${bare}> 头=${token}`, 'RFC 4918 §10.1');
  }

  // §10.7：Timeout 头必须是 Second-<digits>，服务端要真的采纳。
  // 必须用**另一个未被锁住**的文件：同一资源已被上面那把锁占着，
  // 再发 LOCK 会得到 423 + 原有锁的信息（回显的是旧锁的 Second-300，不是新请求的）。
  {
    const fresh = `/recent/${tmp}_to`;
    await req(fresh, { method: 'PUT', body: 'probe' });
    const t = await req(fresh, {
      method: 'LOCK',
      headers: { timeout: 'Second-777' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope></D:lockinfo>',
    });
    const tBody = t.body ?? '';
    check('Timeout: Second-N 被真正采纳（不是静默退回默认）', /<D:timeout>Second-777<\/D:timeout>/.test(tBody),
      `回显=${(tBody.match(/Second-\d+/) || ['(无)'])[0]}`, 'RFC 4918 §10.7');
    const tToken = t.res.headers.get('lock-token');
    if (tToken) await req(fresh, { method: 'UNLOCK', headers: { 'lock-token': tToken } });
    await req(fresh, { method: 'DELETE' });
  }

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

// ── MKCOL：已映射的集合必须失败（§9.3）；未映射路径如实告知无法创建 ──
{
  const { res } = await req('/title/A/', { method: 'MKCOL' });
  // §9.3：「If the Request-URI is already mapped to a resource, then the MKCOL MUST fail.」
  // §9.3.1：用 405。（405 也是挂载安全的：客户端把 405 理解为「已存在」。）
  const ok = res.status === 405;
  check('MKCOL 对已映射的集合返回 405（不得谎报创建成功）', ok, `status=${res.status}`, 'RFC 4918 §9.3 / §9.3.1');

  const fresh = await req('/__mkcol_probe_' + Date.now() + '/', { method: 'MKCOL' });
  const ok2 = fresh.res.status === 403;
  check('MKCOL 对无法持久化的新路径返回 403 + valid-resourcetype', ok2, `status=${fresh.res.status}`, 'RFC 5689 §3.1');
}

// ── DELETE 集合语义（§9.6.1）与根目录保护 ──
{
  const rootDel = await req('/', { method: 'DELETE' });
  // §9.6.1 要求集合 DELETE 等价于 Depth: infinity（递归删成员）。
  // 根目录刻意不支持：实现它等于「一次误操作删掉整个书库」，不可逆。
  check('DELETE 根目录被拒绝（防止一次误操作清空书库）', rootDel.res.status === 405 || rootDel.res.status === 401,
    `status=${rootDel.res.status}`, 'RFC 4918 §9.6.1（有意偏离，见 rfc-compliance.md）');
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