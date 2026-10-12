/**
 * 批量上传通行证（batch ticket）。
 *
 * 为什么需要它（真实反馈）：Turnstile 令牌是一次性的。早期实现「每个文件领一个
 * 新令牌」，结果**传 10 本书要点 10 次验证**，批量上传形同虚设。
 *
 * 现在：第一次带一次性令牌，服务端验完回一张限时通行证（HMAC 签名、绑定 IP），
 * 整批复用 —— **一批只验证一次**。
 *
 * 这里同时验证「能用」与「不能滥用」两侧。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintTicket, verifyTicket } from '../src/api/upload';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const IP = '203.0.113.7';

/** 把 siteverify 换成「成功」或「失败」的桩，避免真打 Cloudflare */
function stubTurnstile(success: boolean): void {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ success }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function init(body: Record<string, unknown>, ip = IP): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/upload/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ filename: 'a.epub', size: 100, ...body }),
  });
}

beforeEach(async () => {
  await resetLibrary();
  vi.unstubAllGlobals();
});

describe('通行证签发与校验', () => {
  it('签发的通行证能被验证通过（同一 IP）', async () => {
    const t = await mintTicket(testEnv, IP);
    expect(t).toBeTruthy();
    expect(await verifyTicket(testEnv, t as string, IP)).toBe(true);
  });

  it('换一个 IP 就不认（防止通行证被搬运）', async () => {
    const t = await mintTicket(testEnv, IP);
    expect(await verifyTicket(testEnv, t as string, '198.51.100.9')).toBe(false);
  });

  it('伪造/篡改的签名不通过', async () => {
    const t = (await mintTicket(testEnv, IP)) as string;
    const [exp, sig] = t.split('.');
    // 改签名
    expect(await verifyTicket(testEnv, `${exp}.${'0'.repeat(64)}`, IP)).toBe(false);
    // 改过期时间（等于延长时间，签名就对不上了）
    expect(await verifyTicket(testEnv, `${Number(exp) + 99999}.${sig}`, IP)).toBe(false);
    // 格式垃圾
    for (const bad of ['', '.', 'abc', '1.2', 'x.'.padEnd(70, 'a')]) {
      expect(await verifyTicket(testEnv, bad, IP), bad).toBe(false);
    }
  });

  it('过期的通行证不通过', async () => {
    // 只伪造 Date（不动 setTimeout 等），避免影响 crypto/网络
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const t = (await mintTicket(testEnv, IP)) as string;
      expect(await verifyTicket(testEnv, t, IP), '刚签发应有效').toBe(true);

      // 前进 9 分钟：仍在 TTL（10 分钟）内
      vi.setSystemTime(new Date('2026-01-01T00:09:00Z'));
      expect(await verifyTicket(testEnv, t, IP), '9 分钟后仍有效').toBe(true);

      // 前进 11 分钟：过期
      vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
      expect(await verifyTicket(testEnv, t, IP), '11 分钟后应失效').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('一批只验证一次', () => {
  it('第一次带令牌 → 返回通行证；后续用通行证可继续上传', async () => {
    stubTurnstile(true);
    try {
      const first = await init({ turnstileToken: 'one-shot' });
      expect(first.status).toBe(200);
      const j1 = (await first.json()) as { ticket?: string; uploadUrl?: string };
      expect(j1.uploadUrl).toBeTruthy();
      expect(j1.ticket, '应返回批量通行证').toBeTruthy();

      // 后续 9 个文件都用通行证，**不再需要任何 Turnstile 令牌**
      // （把 siteverify 设成失败，若还去验证就会 403）
      stubTurnstile(false);
      for (let i = 2; i <= 10; i++) {
        const res = await init({ ticket: j1.ticket });
        expect(res.status, `第 ${i} 个文件`).toBe(200);
        await res.text();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('没有令牌也没有通行证 → 拒绝', async () => {
    const res = await init({});
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe('turnstile-token-required');
  });

  it('通行证无效 → 403 ticket-invalid（客户端据此重新验证）', async () => {
    const res = await init({ ticket: '123.' + '0'.repeat(64) });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe('ticket-invalid');
  });

  it('别的 IP 的通行证不能用', async () => {
    const t = (await mintTicket(testEnv, IP)) as string;
    const res = await init({ ticket: t }, '198.51.100.9');
    expect(res.status).toBe(403);
    await res.text();
  });

  it('令牌验证失败时不发通行证', async () => {
    stubTurnstile(false);
    try {
      const res = await init({ turnstileToken: 'bad' });
      expect(res.status).toBe(403);
      const j = (await res.json()) as { error: string; ticket?: string };
      expect(j.error).toBe('turnstile-failed');
      expect(j.ticket).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('格式白名单仍然先生效（通行证不能绕过格式限制）', async () => {
    const t = (await mintTicket(testEnv, IP)) as string;
    const res = await SELF.fetch(`${ORIGIN}/api/upload/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': IP },
      body: JSON.stringify({ filename: 'evil.exe', size: 100, ticket: t }),
    });
    expect(res.status).toBe(415);
    await res.text();
  });
});
