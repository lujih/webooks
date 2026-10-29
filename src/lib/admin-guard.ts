/**
 * 管理口令失败节流（2026-10-28 审查 S2）。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 * 这段逻辑带**模块级状态**，如果直接写在 `api/admin.ts` 里，测试会互相污染：
 * 一整轮测试里所有 403 都记在同一个 IP 上，跑到后面就变成 429，
 * 于是「无 token 应该 403」的用例开始随机失败。抽出来后 `now` 可以注入，
 * 测试既能精确验证窗口过期，又能在 setup 里整体重置。
 *
 * ── 边界（如实声明）──────────────────────────────────────────────────
 * 计数表在**单个 isolate 的内存里**，不跨实例、不持久：
 *   · 它能挡住「同一个 isolate 上的连续爆破」，并让每次尝试都有代价；
 *   · 它**挡不住**分布式慢速爆破（换实例/换 IP 即可绕过）。
 * 真正的防线是足够长的随机口令（本轮已建议轮换 ADMIN_TOKEN）。
 * 要做到全局计数需要 D1/KV，而那是「每次鉴权都写一次」的成本 ——
 * 对免费额度不划算，故不做，并把这条写在这里而不是含糊过去。
 */

/** 同一 IP 在窗口内允许的失败次数 */
export const ADMIN_FAIL_LIMIT = 10;

/** 计数窗口 */
export const ADMIN_FAIL_WINDOW_MS = 5 * 60_000;

interface FailureRecord {
  count: number;
  resetAt: number;
}

const failures = new Map<string, FailureRecord>();

/**
 * 该 IP 是否已被节流。
 * @param now 可注入的时间（测试用；生产不传）
 */
export function isAdminRateLimited(ip: string, now: number = Date.now()): boolean {
  const rec = failures.get(ip);
  if (!rec) return false;
  if (now > rec.resetAt) {
    failures.delete(ip);
    return false;
  }
  return rec.count >= ADMIN_FAIL_LIMIT;
}

/** 记一次失败（只在鉴权失败时调用） */
export function noteAdminFailure(ip: string, now: number = Date.now()): void {
  const rec = failures.get(ip);
  if (!rec || now > rec.resetAt) {
    // 表本身也要有界：正常流量远达不到；超过 1000 个来源就整体清空，
    // 避免一个扫描器用海量源 IP 把内存撑大。
    if (failures.size > 1000) failures.clear();
    failures.set(ip, { count: 1, resetAt: now + ADMIN_FAIL_WINDOW_MS });
    return;
  }
  rec.count += 1;
}

/** 鉴权成功后清掉该 IP 的失败计数（成功登录者不应被历史失败拖累） */
export function clearAdminFailures(ip: string): void {
  failures.delete(ip);
}

/** 仅供测试：整体重置（测试之间会互相污染，见文件头注释） */
export function resetAdminFailures(): void {
  failures.clear();
}
