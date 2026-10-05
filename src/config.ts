/**
 * 运行时配置。
 *
 * 所有可能影响「每天 10 万请求预算」的参数都在这里集中收口，
 * 并且对上限做硬性 clamp —— 配置写错不应该能把 CPU 预算炸掉。
 */

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  /** R2 桶的公开自定义域，例如 https://books.example.com（不要用 r2.dev） */
  R2_PUBLIC_BASE: string;
  /** 保护 /api/admin/* 的令牌；未设置时所有 admin 接口返回 404 */
  ADMIN_TOKEN?: string;
  MAX_ENTRIES?: string;
  PROPFIND_TTL?: string;
  DEPTH_INFINITY?: string;
  DAV_MOUNT?: string;
}

export interface Settings {
  r2PublicBase: string;
  adminToken: string | null;
  /** WebDAV 挂载前缀，默认 /dav。会原样出现在 207 响应的 D:href 里。 */
  mountPath: string;
  /** 单目录最大子项数 */
  maxEntries: number;
  /** PROPFIND 缓存 TTL（秒）；0 表示禁用缓存 */
  propfindTtl: number;
  depthInfinity: 'downgrade' | 'deny';
}

/**
 * 硬上限。理由：Workers Free 每请求只有 10ms CPU，
 * 生成 200 条 PROPFIND XML 约 1–3ms，1000 条就会顶到上限并触发 Error 1102。
 * 这个值不允许被配置抬高。
 */
export const HARD_MAX_ENTRIES = 200;

/** 分页子目录最多展示多少个，避免把单目录子项数撑爆。 */
export const PAGINATION_MAX = 100;

function intFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function settings(env: Env): Settings {
  const base = (env.R2_PUBLIC_BASE ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('R2_PUBLIC_BASE is not configured; GET would have nowhere to redirect');
  }
  const rawMount = (env.DAV_MOUNT ?? '/dav').trim();
  const mountPath = rawMount === '' || rawMount === '/' ? '' : `/${rawMount.replace(/^\/+|\/+$/g, '')}`;
  return {
    r2PublicBase: base,
    adminToken: env.ADMIN_TOKEN?.trim() || null,
    mountPath,
    maxEntries: intFrom(env.MAX_ENTRIES, 200, 1, HARD_MAX_ENTRIES),
    propfindTtl: intFrom(env.PROPFIND_TTL, 300, 0, 86_400),
    depthInfinity: env.DEPTH_INFINITY === 'deny' ? 'deny' : 'downgrade',
  };
}
