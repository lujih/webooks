#!/usr/bin/env node
/**
 * 一次性把上传所需的 Worker secrets 配好。
 *
 * 凭据从环境变量读，**不会写入任何文件、不进 git、不打印明文**。
 * 用法（把下面的值替换成你自己的）：
 *
 *   R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  R2_ACCOUNT_ID=... \
 *   R2_BUCKET_NAME=...    TURNSTILE_SITE_KEY=...    TURNSTILE_SECRET=... \
 *   node scripts/set-upload-secrets.mjs
 *
 * 需要先 `npx wrangler login`。
 */

import { execFileSync } from 'node:child_process';

const SECRETS = {
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET,
};

const missing = Object.entries(SECRETS).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('缺少环境变量:', missing.join(', '));
  process.exit(2);
}

try {
  execFileSync('npx', ['wrangler', 'whoami'], { stdio: 'pipe' });
} catch {
  console.error('wrangler 未登录，请先运行: npx wrangler login');
  process.exit(1);
}

for (const [name, value] of Object.entries(SECRETS)) {
  process.stdout.write(`设置 ${name} ... `);
  try {
    execFileSync('npx', ['wrangler', 'secret', 'put', name], {
      input: value,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('✅');
  } catch (err) {
    console.log('❌');
    console.error(String(err.stderr ?? err.message).slice(0, 300));
    process.exit(1);
  }
}

console.log('\n全部设置完成。接下来：');
console.log('  1) 等 Workers 自动重新部署（secret 变更会触发）');
console.log('  2) 打开 https://<你的域名>/upload 实际上传测试');
console.log('  3) 或运行 curl -s <域名>/api/turnstile-config 应返回 {"siteKey":"0x4..."}');
console.log('\n⚠️  这些凭据曾以明文出现在对话里，建议测试完成后轮换一遍。');