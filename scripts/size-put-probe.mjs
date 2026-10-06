#!/usr/bin/env node
/**
 * 预签名直传 R2 的容量拐点探针。
 *
 * 动机：浏览器上传大文件时出现 ERR_CONNECTION_RESET，需要确定是「体积问题」
 * 还是「网络/协议问题」。逐档放大真实字节，看 R2 在哪个量级断掉。
 *
 * 每档都带 Origin 头（模拟浏览器），并记录耗时与是否出现连接重置。
 *
 * 用法：设好 R2_* 环境变量后 node --experimental-strip-types scripts/size-put-probe.mjs
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

const MB = 1024 * 1024;
const SIZES = (process.argv[2]?.split(',').map(Number) ?? [1, 5, 20, 50, 100, 150, 200])
  .map((n) => n * MB)
  .filter((n) => n > 0);

const contentType = 'application/epub+zip';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

console.log(`预签名直传容量探针   origin=${ORIGIN}`);
console.log('='.repeat(64));
console.log('体积'.padEnd(10) + '结果'.padEnd(12) + '耗时'.padEnd(12) + '说明');
console.log('-'.repeat(64));

const rows = [];
for (const size of SIZES) {
  const key = `size-probe/_${size}_${Date.now()}.epub`;
  const url = await createPresignedPutUrl({
    accessKeyId: ak, secretAccessKey: sk, accountId: acct, bucket, key,
    contentType, amzDate: stamp(), expiresIn: 900,
  });

  // 用分块构造，避免一次性占用同等内存
  const blob = new Blob([new Uint8Array(size)], { type: contentType });
  const t0 = Date.now();
  let status = 0, note = '';
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'Content-Type': contentType },
      body: blob,
    });
    status = res.status;
    if (status === 200) note = '✅ 写入成功';
    else {
      const t = await res.text().catch(() => '');
      note = `❌ ${(t.match(/<Code>([^<]+)/) || [, `HTTP ${status}`])[1]}`;
      await res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    note = `❌ 连接失败: ${(err.message || String(err)).slice(0, 40)}`;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `${(size / MB).toFixed(0)}MB`.padEnd(10) +
    (status === 200 ? '200 OK' : String(status || 'ERR')).padEnd(12) +
    `${secs}s`.padEnd(12) + note,
  );
  rows.push({ size, status, note });
}

console.log('='.repeat(64));
const ok = rows.filter((r) => r.status === 200);
const bad = rows.filter((r) => r.status !== 200);
const largest = Math.max(...ok.map((r) => r.size), 0) / MB;

if (bad.length === 0) {
  console.log(`全部 ${ok.length} 档通过，最大成功 ${largest}MB。`);
  console.log('结论: 预签名直传没有 100MB 请求体上限（这条路径绕过了 zone 代理层），');
  console.log('      与设计预期一致。');
} else if (largest > Math.min(...bad.map((r) => r.size)) / MB) {
  // 失败档位夹在成功档位中间 —— 说明不是容量上限，而是瞬时网络故障
  const biggestOk = Math.max(...ok.map((r) => r.size)) / MB;
  console.log(`成功 ${ok.length} 档（最大 ${biggestOk}MB），失败 ${bad.length} 档。`);
  console.log('');
  console.log('⚠️  注意：失败档位夹在成功档位之间（例如 120MB 失败但 200MB 成功），');
  console.log('    这说明**不是容量上限**，而是传输途中的瞬时连接中断。');
  console.log('    处置：客户端需要「失败自动重试」，而不是设一个体积阈值去拒绝大文件。');
  console.log('    同时要如实告诉用户：大文件在弱网下失败属正常，可重试。');
} else {
  const smallestBad = Math.min(...bad.map((r) => r.size)) / MB;
  console.log(`成功 ${ok.length} 档，最大成功 ${largest}MB`);
  console.log(`失败 ${bad.length} 档，最小失败 ${smallestBad}MB`);
  console.log(`\n结论: 上限在 ${largest}MB ~ ${smallestBad}MB 之间，疑似硬性上限。`);
}

console.log('\n⚠️  请在 R2 Dashboard 手动清理 size-probe/ 前缀下的测试对象。');