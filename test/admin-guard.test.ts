/**
 * 管理口令失败节流（2026-10-28 审查 S2 / `src/lib/admin-guard.ts`）。
 *
 * 这里测的是**窗口语义**，用注入时间而不是真等 5 分钟：
 *   · 未达阈值放行
 *   · 达到阈值后拦截
 *   · 窗口过期后重新放行，且计数归零
 *   · 按 IP 隔离（一个来源被拦不影响另一个）
 *
 * ⚠️ 能力边界（与实现里的注释一致）：计数在**单个 isolate 的内存**里，
 * 不跨实例。这些用例验证的是「单实例内的语义正确」，不代表全局防护。
 */

import { describe, expect, it } from 'vitest';
import {
  ADMIN_FAIL_LIMIT,
  ADMIN_FAIL_WINDOW_MS,
  isAdminRateLimited,
  noteAdminFailure,
} from '../src/lib/admin-guard';

const T0 = 1_700_000_000_000;

describe('管理口令失败节流', () => {
  it('未达阈值不拦截，达到阈值才拦', () => {
    const ip = 'test-ip-limit';
    for (let i = 0; i < ADMIN_FAIL_LIMIT - 1; i++) {
      noteAdminFailure(ip, T0);
      expect(isAdminRateLimited(ip, T0), `第 ${i + 1} 次失败不该被拦`).toBe(false);
    }
    noteAdminFailure(ip, T0);
    expect(isAdminRateLimited(ip, T0), `第 ${ADMIN_FAIL_LIMIT} 次后应拦截`).toBe(true);
  });

  it('窗口过期后重新放行，计数归零', () => {
    const ip = 'test-ip-window';
    for (let i = 0; i < ADMIN_FAIL_LIMIT; i++) noteAdminFailure(ip, T0);
    expect(isAdminRateLimited(ip, T0)).toBe(true);

    const afterWindow = T0 + ADMIN_FAIL_WINDOW_MS + 1;
    expect(isAdminRateLimited(ip, afterWindow)).toBe(false);
    // 过期后的第一次失败重新从 1 开始，而不是接着用旧的 count
    noteAdminFailure(ip, afterWindow);
    expect(isAdminRateLimited(ip, afterWindow)).toBe(false);
  });

  it('按 IP 隔离：一个来源被拦不影响另一个', () => {
    const bad = 'test-ip-bad';
    const good = 'test-ip-good';
    for (let i = 0; i < ADMIN_FAIL_LIMIT; i++) noteAdminFailure(bad, T0);
    expect(isAdminRateLimited(bad, T0)).toBe(true);
    expect(isAdminRateLimited(good, T0)).toBe(false);
  });
});
