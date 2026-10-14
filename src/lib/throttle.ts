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

/**
 * 写操作的统一守卫：**每条**写路径都必须先过它。
 *
 * 为什么要有这个函数：曾经只有 handlePut 调 allowWrite，于是
 * 「匿名上传有每日写次数节流」这个承诺在其它入口上**完全落空** ——
 *   · 网页上传 /api/upload/init、/api/upload/complete：零节流
 *   · WebDAV COPY：零节流（分发处注释还写着「走与 PUT 相同的节流即可」）
 * 结果文档、注释、README 三处都说有节流，代码里却只有一处。
 *
 * 这类「文档声称有防护、实际只做了一半」比完全没有防护更危险：
 * 它让评审和运维都以为额度不会被打爆。
 *
 * 现在所有写路径统一走 guardWrite，新增入口时漏不掉 —— 因为
 * 「写路径必须调用 guardWrite」现在是一条可以在 review 里检查的规则。
 *
 * @param env   用于取 DAILY_WRITE_QUOTA（两条链路的配置来源一致）
 * @param request 用于取客户端 IP
 * @param limit 每日上限；≤0 表示不限制
 * @returns 允许时为 null，被拒时是一个可直接返回的 429 响应
 */
export async function guardWrite(
  env: { DAILY_WRITE_QUOTA?: string },
  request: Request,
  limit: number,
  allowHeaders?: { allow?: string; retryAfter?: string },
): Promise<Response | null> {
  const quota = Number.parseInt(env.DAILY_WRITE_QUOTA ?? '', 10);
  const effective = Number.isFinite(quota) ? quota : limit;
  const ip = clientIpFromRequest(request);
  if (await allowWrite(ip, effective)) return null;
  return new Response('Too Many Requests: daily write quota exceeded\n', {
    status: 429,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': allowHeaders?.retryAfter ?? '3600',
      ...(allowHeaders?.allow ? { allow: allowHeaders.allow } : {}),
    },
  });
}

/**
 * 取客户端 IP。
 *
 * ⚠️ **只信任 CF-Connecting-IP**，缺失时返回空串（→ 节流被跳过）。
 *
 * 原实现在 upload.ts 里是 `CF-Connecting-IP ?? X-Forwarded-For ?? ''`。
 * `X-Forwarded-For` 完全由客户端提供，一旦 Cloudflare 没设前者就回落到它，
 * 于是：批量上传通行证的 IP 绑定可以被 `X-Forwarded-For: <原IP>` 伪造绕过 ——
 * 通行证在 A 机签发，在 B 机上带上 A 的 XFF 就能用。
 * 回到规范：「无法被搬到别的 IP 上使用」这个承诺在那个回退分支下不成立。
 *
 * 空 IP 的后果是「不限流」而不是「拒绝」：宁可放过，也不误伤
 * 真正走 Cloudflare 边缘却拿不到头的请求（比如本地 wrangler dev）。
 */
export function clientIpFromRequest(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '';
}
