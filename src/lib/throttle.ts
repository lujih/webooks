/**
 * 写入节流（尽力而为）。
 *
 * 为什么需要：WebDAV PUT 是完全匿名开放的，没有验证码也没有账号。配合
 * 200MiB 的单文件上限，攻击者仍可少量多次把 10GB 免费配额写满并触发计费。
 * 大小上限管「单次伤害」，这里管「总量」。
 *
 * 为什么用 Cache API 而不是 D1/KV：
 *   · D1 每次 PUT 都写一行，写入配额（免费层 10 万行/天）会被自己吃光
 *   · KV 未绑定，且免费层写入 1000 次/天，比 D1 还紧
 *   · Cache API 读写不额外计费，且天然带 TTL，过期自动清理
 *
 * 诚实的局限（不要把它当强保证）：
 *   · Cache API 是**按数据中心**的，同一 IP 在多个边缘节点会有多份计数
 *   · 写入是「读-改-写」，非原子，并发下可能少计
 *   · 过期条目可能被提前淘汰，计数会重置
 * 所以它是「抬高滥用成本」的减速带，不是配额系统。真要严格限制必须上
 * Durable Object 或 KV + 账号体系 —— 那与「无需注册」的产品定位冲突。
 */

import { davCache } from './cache';

const THROTTLE_HOST = 'https://webooks.invalid'; // 保留域名，仅作缓存键

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 记一次写操作，返回是否仍在配额内。
 * @param limit 每日上限；≤0 表示不限制
 */
export async function allowWrite(ip: string, limit: number): Promise<boolean> {
  if (limit <= 0 || !ip) return true;
  const cache = davCache();
  if (!cache) return true; // 没有 Cache API 时不阻塞写入（宁可放开也不能误伤）

  const key = `${THROTTLE_HOST}/throttle/write?ip=${encodeURIComponent(ip)}&d=${utcDay()}`;
  let used = 0;
  try {
    const hit = await cache.match(key);
    if (hit) used = Number.parseInt(await hit.text(), 10) || 0;
  } catch {
    return true; // 缓存异常不应阻断正常上传
  }

  if (used >= limit) return false;

  try {
    await cache.put(
      key,
      new Response(String(used + 1), {
        headers: { 'cache-control': 'public, max-age=86400' },
      }),
    );
  } catch {
    // 写缓存失败就放行，避免因为计数失败挡住真实用户
  }
  return true;
}
