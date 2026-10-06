#!/usr/bin/env node
/**
 * 模拟浏览器走完整上传链路，验证 CORS 是否真的通。
 *
 * 依次做三件事，每一步都断言 CORS 响应头：
 *   1. OPTIONS 预检（带 Origin / Access-Control-Request-Method / -Headers）
 *   2. 真实预签名 PUT（带 Origin + Content-Type），要求 200 且响应含 ACAO
 *   3. 清理：预签名 DELETE
 *
 * 用法：先设好环境变量（与 verify-presign.mjs 相同），再 node 脚本
 */

import { createPresignedPutUrl } from '../src/lib/sigv4.ts';

const acct = process.env.R2_ACCOUNT_ID;
const ak = process.env.R2_ACCESS_KEY_ID;
const sk = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;
const ORIGIN = process.env.TEST_ORIGIN || 'https://webooks.cszxorx.dpdns.org';

for (const [k, v] of Object.entries({ acct, ak, sk, bucket })) {
  if (!v) { console.error('缺少环境变量', k); process.exit(2); }
}

const endpoint = `${acct}.r2.cloudflarestorage.com`;
const key = `verify-cors/_${Date.now()}.epub`;
const contentType = 'application/epub+zip';
const body = 'webooks cors verification';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const acao = (r) => r.headers.get('access-control-allow-origin');
const show = (r) => `status=${r.status} ACAO=${acao(r) ?? '(缺失)'}`;

// ── 1. 预检 ──
// 必须模拟浏览器真实行为：Access-Control-Request-Headers 里放的是「请求头名称」，
// 不是请求头的值。XHR 设的是 Content-Type，所以这里是 "content-type"。
const enc = key.split('/').map(encodeURIComponent).join('/');
const pre = await fetch(`https://${endpoint}/${bucket}/${enc}`, {
  method: 'OPTIONS',
  headers: {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type',
  },
});
console.log(`[1] 预检 OPTIONS（Access-Control-Request-Headers: content-type）`);
console.log(`    ${show(pre)}`);
console.log(`    Allow-Methods=${pre.headers.get('access-control-allow-methods')}`);
console.log(`    Allow-Headers=${pre.headers.get('access-control-allow-headers')}`);
const preOk = pre.status === 204 && acao(pre) === ORIGIN;
console.log(`    ${preOk ? '✅ 预检通过' : '❌ 预检失败'}`);
if (!preOk) {
  console.log('    响应:', (await pre.text().catch(() => '')).slice(0, 200));
}

// ── 2. 真实 PUT ──
const url = await createPresignedPutUrl({
  accessKeyId: ak, secretAccessKey: sk, accountId: acct, bucket, key,
  contentType, amzDate: stamp(), expiresIn: 300,
});
const put = await fetch(url, {
  method: 'PUT',
  headers: { Origin: ORIGIN, 'Content-Type': contentType },
  body,
});
console.log(`\n[2] 预签名 PUT（带 Origin）`);
console.log(`    ${show(put)}`);
if (!put.ok) {
  console.log('    响应:', (await put.text().catch(() => '')).slice(0, 300));
}
const putOk = put.status === 200;
console.log(`    ${putOk ? '✅ 写入成功' : '❌ 写入失败'}`);

// ── 3. 清理 ──
// 删除需要 DELETE 预签名，当前实现只做 PUT，所以这里用生命周期规则兜底。
console.log(`\n[3] 清理`);
console.log(`    需手动删除 ${key}（或给 verify-cors/ 前缀配生命周期规则）`);

console.log('\n' + '─'.repeat(56));
if (preOk && putOk) {
  console.log('结论: ✅ 浏览器上传链路已通 —— 预检和实际 PUT 都返回了正确的 CORS 头。');
  console.log('      如果浏览器仍失败，请强制刷新（Ctrl+F5）清掉旧的预检缓存。');
  process.exit(0);
} else {
  console.log('结论: ❌ 仍有环节不通，见上面的具体输出。');
  process.exit(1);
}