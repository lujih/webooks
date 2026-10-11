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
  /** Turnstile 公钥（前端 widget 用），来自 Dashboard */
  TURNSTILE_SITE_KEY?: string;
  /** Turnstile 私钥（服务端 siteverify 用），必须是 secret */
  TURNSTILE_SECRET?: string;
  /** R2 API 凭据：Access Key ID，用于签发预签名 URL */
  R2_ACCESS_KEY_ID?: string;
  /** R2 API 凭据：Secret Access Key，用于签名（必须是 secret） */
  R2_SECRET_ACCESS_KEY?: string;
  /** Cloudflare Account ID，用于构造 S3 端点 */
  R2_ACCOUNT_ID?: string;
  /** R2 桶名（预签名 URL 里的 bucket） */
  R2_BUCKET_NAME?: string;
  /** 单文件大小上限（字节），默认 200 MiB */
  UPLOAD_MAX_BYTES?: string;
  /** 单文件大小上限（字节），WebDAV 与上传 API 共用；0 表示不限制 */
  MAX_UPLOAD_BYTES?: string;
  /** 每 IP 每日写操作上限；0 表示不限制 */
  DAILY_WRITE_QUOTA?: string;
  /** 每 IP 每天允许的上传次数（已由 DAILY_WRITE_QUOTA 取代，保留仅为兼容旧配置） */
  UPLOAD_DAILY_QUOTA?: string;
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
  /** 单文件大小上限（字节）。WebDAV PUT 与上传 API 共用；0 表示不限制 */
  maxUploadBytes: number;
  /** 每 IP 每日写操作上限（尽力而为，见 lib/throttle.ts）；0 表示不限制 */
  dailyWriteQuota: number;
}

/**
 * 硬上限。理由：Workers Free 每请求只有 10ms CPU，
 * 生成 200 条 PROPFIND XML 约 1–3ms，1000 条就会顶到上限并触发 Error 1102。
 * 这个值不允许被配置抬高。
 */
export const HARD_MAX_ENTRIES = 200;

/** 分页子目录最多展示多少个，避免把单目录子项数撑爆。 */
export const PAGINATION_MAX = 100;

/**
 * 单文件默认上限 200 MiB。
 * 免费层 R2 只有 10GB，而 WebDAV 是完全匿名开放的 —— 没有上限时
 * 一个脚本就能把配额写满（并触发超额计费）。200MiB 足够放任何正常电子书，
 * 又让滥用成本可控。可用 MAX_UPLOAD_BYTES 覆盖。
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * 每 IP 每日写操作默认上限。
 * 300 次对正常使用者绰绰有余（批量导入一整套书也就几十次），
 * 但让「脚本无限灌文件」变得不划算。设 0 可关闭。
 */
export const DEFAULT_DAILY_WRITE_QUOTA = 300;

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
    // 0 显式表示「不限制」；未配置走默认上限
    maxUploadBytes: env.MAX_UPLOAD_BYTES === '0'
      ? 0
      : intFrom(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES, 1, 5 * 1024 * 1024 * 1024),
    dailyWriteQuota: env.DAILY_WRITE_QUOTA === '0'
      ? 0
      : intFrom(env.DAILY_WRITE_QUOTA, DEFAULT_DAILY_WRITE_QUOTA, 1, 100_000),
  };
}
