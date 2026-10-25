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
  /**
   * 破坏性操作（DELETE / MOVE / 覆盖已有书）的共享口令。
   * 未设置时这些操作**不保护**（保持向后兼容），管理后台会明确告警。
   */
  WRITE_TOKEN?: string;
  /** Turnstile 公钥（前端 widget 用），来自 Dashboard */
  TURNSTILE_SITE_KEY?: string;
  /** Turnstile 私钥（服务端 siteverify 用）。⚠️ 仅在开启人机验证时才必填 */
  TURNSTILE_SECRET?: string;
  /**
   * 网页上传是否强制 Turnstile 人机验证。默认 false（关闭）。
   * 理由与取舍见 src/api/upload.ts 的 requireTurnstile()。
   */
  UPLOAD_REQUIRE_TURNSTILE?: string;
  /**
   * 批量上传通行证的签名密钥。**可选** —— 不配就退回 TURNSTILE_SECRET，
   * 不引入新的必填配置。想独立轮换通行证密钥时再单独设置。
   */
  UPLOAD_TICKET_SECRET?: string;
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
  /**
   * URL 导入的**域名白名单**（逗号分隔）。留空＝不启用白名单。
   *
   * 为什么需要它：Workers 运行时**没有 DNS 解析 API**，无法在 fetch 之前把
   * 域名解析成 IP 再判断是否内网，所以 SSRF 防护只能做到「拒绝 IP 字面量 +
   * 拒绝内网后缀 + 每跳重定向复查」。挡不住「公网域名解析到内网地址」的
   * DNS rebinding。配上白名单（如 `www.gutenberg.org,zh.wikisource.org`）
   * 才是真正可靠的形态；管理员手动导入时依赖人工看 URL。
   *
   * 详见 docs/source-ingest-design.md §5.2 —— 那里明写了这条防护不完整。
   */
  IMPORT_URL_ALLOWLIST?: string;
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
  /**
   * 破坏性操作口令。null 表示未启用保护（删除/覆盖对所有人开放）。
   * 注意永远是「仅比较，不回显」，因此不会被前端拿到。
   */
  writeToken: string | null;
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
 * Cloudflare 的请求体上限（Free / Pro 套餐，核实于 2026-10-14）。
 *
 * 来源：https://developers.cloudflare.com/workers/platform/limits/
 * 的 "Request body size limits"（原文：「Request body size limits depend
 * on your Cloudflare account plan, not your Workers plan」，
 * Free 100 MB / Pro 100 MB / Business 200 MB / Enterprise ≤ 5 GB）。
 *
 * ⚠️ Business 及以上可以调高，但那是**账户级**配置，代码无从得知 ——
 *   所以这里按最低的常见档（Free/Pro）clamp。Business 用户如果真的需要
 *   更大文件，应走网页上传通道（预签名直传，不经过 Worker）。
 */
export const CF_REQUEST_BODY_LIMIT = 100 * 1024 * 1024;

/**
 * 单文件默认上限 100 MiB。
 *
 * 与 CF_REQUEST_BODY_LIMIT 对齐 —— 见该常量的说明与下方「为什么不能
 * 设成 200 MiB」。
 *
 * 免费层 R2 只有 10GB，而 WebDAV 完全匿名开放 —— 没有上限时一个脚本
 * 就能把配额写满（并触发超额计费）。可用 MAX_UPLOAD_BYTES 覆盖，
 * 但超过 CF_REQUEST_BODY_LIMIT 的部分不会生效（会被 clamp）。
 */
export const DEFAULT_MAX_UPLOAD_BYTES = CF_REQUEST_BODY_LIMIT;

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
    //
    // ⚠️ 上限 clamp 到 CF_REQUEST_BODY_LIMIT：Cloudflare 的请求体上限按
    //   **账户套餐**决定（Free/Pro = 100MB），超限请求在代理层就被回 413，
    //   **根本到不了 Worker**。所以配一个更大的值不会「放宽限制」，
    //   只会造出一段永远走不到的死路径，且客户端拿到的是 Cloudflare 的
    //   裸 413 而不是我们的错误信息。写死在代码里而不是只改文档 ——
    //   否则改 wrangler.jsonc 的人很容易把它调回去。
    //
    //   注：网页上传走预签名直传、字节不过 Worker，不受此限，
    //   它的上限由 UPLOAD_MAX_BYTES 单独控制（见 api/upload.ts）。
    maxUploadBytes: env.MAX_UPLOAD_BYTES === '0'
      ? 0
      : intFrom(
        env.MAX_UPLOAD_BYTES,
        DEFAULT_MAX_UPLOAD_BYTES,
        1,
        CF_REQUEST_BODY_LIMIT,
      ),
    dailyWriteQuota: env.DAILY_WRITE_QUOTA === '0'
      ? 0
      : intFrom(env.DAILY_WRITE_QUOTA, DEFAULT_DAILY_WRITE_QUOTA, 1, 100_000),
    writeToken: env.WRITE_TOKEN?.trim() || null,
  };
}
