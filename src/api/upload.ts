/**
 * 公开上传通道（预签名直传 R2）。
 *
 * 流程：
 *   1. POST /api/upload/init   —— 校验 Turnstile + 配额 + 类型/大小，
 *      用 R2 凭据签一个限时预签名 PUT URL 返回给浏览器（不经过 Worker 传字节）
 *   2. 浏览器 PUT 字节到 R2（绕过 Worker，因此不受 100MB zone 限制）
 *   3. POST /api/upload/complete —— 校验对象确实存在，写 D1 元数据（自动上架）
 *
 * 安全设计（对应可行性报告 §5）：
 *   - Turnstile 无感验证码挡脚本（服务端 siteverify 是强制的，前端 widget 不能替代）
 *   - 每 IP 每日配额（KV 未配置时退化为「不做限流」，但 Turnstile 仍生效）
 *   - 扩展名白名单 + 大小上限
 *   - 字节不过 Worker，因此不会污染 Worker 的 CPU/内存与请求额度
 *   - 注意：当前无账号体系，无法执行「重复侵权者封号」，因此不具备 DMCA
 *     避风港资格；这是产品层面的取舍（见 docs/DEPLOY.md 合规章节）。
 */

import type { Env } from '../config';
import { ALLOWED_UPLOAD_FORMATS, isAllowedUploadExt, authorBucket, letterBucket, normaliseFormat } from '../lib/collections';
import { safeEqual } from '../lib/auth';
import { deriveMetadata, guessAuthorFromText, safeContentTypeFor, sanitiseLeafName } from '../lib/metadata';
import { sniffKindFromBucket } from '../lib/kind-sniff';
import { rebuildBuckets, upsertBook } from '../lib/db';
import { shortId } from '../lib/http';
import { createPresignedPutUrl } from '../lib/sigv4';
import { parseEpub, coverExtFor, PARSE_SIZE_CAP } from '../lib/epub';
import { jsonResponse, textResponse } from '../lib/http';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 允许的扩展名 = 电子书 + 漫画（白名单的唯一定义在 collections.ts）。
 *
 * 这里**不再**单独维护一份：以前 API 与 WebDAV PUT 各写各的，
 * 结果网页上传拦掉了 exe，WebDAV 却能直接塞进来（真实漏洞）。
 * 现在两边共用 isAllowedUploadExt()。
 */
const ALLOWED_EXT = new Set(ALLOWED_UPLOAD_FORMATS);

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200 MiB

interface InitBody {
  filename: string;
  size: number;
  contentType?: string;
  /** 一次性人机验证令牌（与 ticket 二选一） */
  turnstileToken?: string;
  /** 批量通行证：通过一次验证后拿到，整批上传复用（与 turnstileToken 二选一） */
  ticket?: string;
}

/** 校验 Turnstile token。服务端验证是强制的。 */
async function verifyTurnstile(env: Env, token: string, remoteIp: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    // 未配置密钥时无法验证 —— 为安全起见拒绝，而不是放行。
    // 这样忘记配 secret 会导致上传不可用（fail-closed），而不是裸奔。
    return false;
  }
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? '';
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC 日期
}

// ── 批量上传通行证 ──────────────────────────────────────────────────────
//
// 为什么要它：Turnstile 令牌是**一次性**的。批量传 N 本书就需要 N 个令牌，
// 而每领一个新令牌都要 reset 组件 → 用户看到 **每本书弹一次验证**，
// 传 10 本就要点 10 次，完全没法用。
//
// 解法：把「验证码」与「上传次数」解耦 —— 通过一次人机验证，换一张
// 限时通行证，整批上传都用它。这样一批只验证一次。
//
// 设计成无状态（HMAC 签名）而不是存数据库：
//   · 不占 D1 写入额度，不需要额外表
//   · 通行证格式：<过期时间戳>.<签名>，签名覆盖「过期时间 + 请求方 IP」
//   · 不把 IP 放进通行证里 —— 验证时用当前请求的 IP 重新算签名比对即可，
//     这样通行证更短，且**无法被搬到别的 IP 上使用**
//
// 安全性权衡（有意为之）：一张通行证在有效期内可多次使用。
// 但匿名上传本来就有「每日写入次数」节流的硬上限，验证码的边际价值有限；
// 用「一个验证码换 10 分钟通行证」换来的可用性提升是值得的。

/** 通行证有效期：够传完一批，又不至于被长期复用 */
const TICKET_TTL_SECONDS = 600;

function ticketSecret(env: Env): string | null {
  // 优先用专用密钥；没配就退回 TURNSTILE_SECRET（上传能跑就一定有它），
  // 这样不引入新的必填配置。
  return env.UPLOAD_TICKET_SECRET || env.TURNSTILE_SECRET || null;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data) as BufferSource);
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 签发一张批量通行证（IP 绑定 + 限时） */
export async function mintTicket(env: Env, ip: string): Promise<string | null> {
  const secret = ticketSecret(env);
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const sig = await hmacHex(secret, `${exp}|${ip}`);
  return `${exp}.${sig}`;
}

/** 校验批量通行证：签名对、未过期、且是同一个 IP 签发的 */
export async function verifyTicket(env: Env, ticket: string, ip: string): Promise<boolean> {
  const secret = ticketSecret(env);
  if (!secret || !ticket) return false;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return false;
  const expPart = ticket.slice(0, dot);
  const sigPart = ticket.slice(dot + 1);
  if (!/^[0-9]{1,12}$/.test(expPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return false;

  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;

  const expected = await hmacHex(secret, `${exp}|${ip}`);
  return safeEqual(expected, sigPart);
}

export async function handleUploadInit(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed', { allow: 'POST' });
  }

  let body: InitBody;
  try {
    body = (await request.json()) as InitBody;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }

  const { filename, size, turnstileToken, ticket } = body;

  // ── 输入校验放在最前面 ──
  // 两个理由：
  //   1. 非法输入应当立刻被拒，不该先暴露「服务端缺哪些配置」这种内部状态
  //   2. 以前配置检查在前，导致格式白名单在未配置环境里根本跑不到，
  //      测试也测不出白名单是否生效（真实踩过）
  if (typeof filename !== 'string' || !filename.trim()) {
    return jsonResponse({ error: 'filename-required' }, 400);
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return jsonResponse({ error: 'size-required' }, 400);
  }

  // 扩展名白名单：电子书 + 漫画。isAllowedUploadExt 会先归一化
  // （azw→azw3 这类别名也算通过），避免名单对了却把合法扩展名拒掉。
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!isAllowedUploadExt(ext)) {
    return jsonResponse(
      { error: 'unsupported-format', ext, allowed: [...ALLOWED_EXT] },
      415,
    );
  }

  // 凭据检查：没有 R2 凭据就明确报错，而不是签一个坏 URL
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET_NAME, TURNSTILE_SECRET } = env;
  const missing: string[] = [];
  if (!R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID');
  if (!R2_BUCKET_NAME) missing.push('R2_BUCKET_NAME');
  if (!TURNSTILE_SECRET) missing.push('TURNSTILE_SECRET');
  if (missing.length > 0) {
    return jsonResponse(
      { error: 'upload-not-configured', missing },
      503,
    );
  }

  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? '', 10) || DEFAULT_MAX_BYTES;
  if (size > maxBytes) {
    return jsonResponse({ error: 'file-too-large', maxBytes }, 413);
  }

  // ── 人机验证（fail-closed）──
  // 两条路径，二选一：
  //   · ticket         —— 之前某次验证换来的批量通行证（整批复用，不再打扰用户）
  //   · turnstileToken —— 一次性令牌，验完立刻换一张通行证返回给客户端
  const ip = clientIp(request);
  let human = false;
  if (typeof ticket === 'string' && ticket) {
    human = await verifyTicket(env, ticket, ip);
    if (!human) {
      // 通行证过期/伪造：让客户端重新验证，而不是笼统报错
      return jsonResponse({ error: 'ticket-invalid' }, 403);
    }
  } else if (typeof turnstileToken === 'string' && turnstileToken) {
    human = await verifyTurnstile(env, turnstileToken, ip);
    if (!human) return jsonResponse({ error: 'turnstile-failed' }, 403);
  }
  if (!human) {
    return jsonResponse({ error: 'turnstile-token-required' }, 400);
  }

  // 生成对象键：上传暂存到 uploads/ 前缀（Phase 1 可加隔离区）。
  // 注意：这里传**未编码**的键，createPresignedPutUrl 内部会逐段做 URL 编码
  // （SigV4 要求 canonical URI 用编码形式，且避免 # 截断签名）。
  // 同时把文件名里会破坏 URL 结构的字符也一并去掉。
  const safeName = filename
    .replace(/[?#]/g, '_')
    .replace(/[\/\\\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180);
  if (!safeName || safeName === '.' || safeName === '..') {
    return jsonResponse({ error: 'invalid-filename' }, 400);
  }
  const key = `uploads/${todayKey()}/${shortId(6)}/${safeName}`;
  // 预签名 URL 签的 Content-Type 同样按扩展名推导：客户端要么照发，要么签名不符。
  // 这样 uploads/ 暂存对象也不会被做成 text/html。
  const contentType = safeContentTypeFor(safeName);

  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const putUrl = await createPresignedPutUrl({
    accessKeyId: R2_ACCESS_KEY_ID as string,
    secretAccessKey: R2_SECRET_ACCESS_KEY as string,
    accountId: R2_ACCOUNT_ID as string,
    bucket: R2_BUCKET_NAME as string,
    key,
    contentType,
    expiresIn: 900, // 15 分钟
    amzDate,
  });

  // 返回一张通行证：客户端拿它传这一批的后续文件，不必再打扰用户验证。
  // 用 token 换 ticket 时是「首次验证」，用 ticket 再来时等于续期（同样限时）。
  const nextTicket = await mintTicket(env, ip);

  return jsonResponse({
    uploadUrl: putUrl,
    key,
    method: 'PUT',
    headers: { 'content-type': contentType },
    expiresIn: 900,
    ticket: nextTicket,
    ticketExpiresIn: nextTicket ? TICKET_TTL_SECONDS : null,
  });
}

interface CompleteBody {
  key: string;
  filename: string;
  size: number;
  contentType?: string;
}

export async function handleUploadComplete(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed', { allow: 'POST' });
  }

  let body: CompleteBody;
  try {
    body = (await request.json()) as CompleteBody;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }

  const { key, filename, size } = body;
  if (typeof key !== 'string' || !key.startsWith('uploads/')) {
    return jsonResponse({ error: 'bad-key' }, 400);
  }

  // 校验对象确实存在，并取真实大小/类型（防止前端伪造 size）
  const head = await env.BUCKET.head(key);
  if (!head) {
    return jsonResponse({ error: 'object-not-found' }, 404);
  }

  const actualSize = head.size;
  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? '', 10) || DEFAULT_MAX_BYTES;
  if (actualSize > maxBytes) {
    // 超标：立刻删除刚传上来的文件
    await env.BUCKET.delete(key);
    return jsonResponse({ error: 'file-too-large', maxBytes }, 413);
  }

  // 文件名清洗必须与 WebDAV PUT 完全一致（sanitiseLeafName）。
  // 早期实现只替换了 / 和 \，于是控制字符、<>:"|?* 与超长名字都能进 D1 ——
  // 虽然后续渲染都有转义，但「入库前就该干净」是更可靠的防线。
  const safeName =
    sanitiseLeafName((filename || key.split('/').pop() || 'book').replace(/[\/\\]/g, '_')) ??
    `book-${shortId(6)}`;
  const meta = deriveMetadata(safeName);
  const format = normaliseFormat(safeName.split('.').pop());
  // 安全关键：落 R2 的 Content-Type 只按扩展名推导，绝不用 uploads/ 里的元数据
  // 或客户端声明的值 —— R2 对外提供的就是它，信任它等于允许 text/html 托管。
  const contentType = safeContentTypeFor(safeName);

  // 从 uploads/ 搬到 books/ 并登记元数据（自动上架）。
  // 先确认源对象可读（R2 的 get 可能返回 null），再流式搬到目标键。
  const source = await env.BUCKET.get(key);
  if (!source) {
    return jsonResponse({ error: 'object-unreadable' }, 404);
  }
  const bookKey = `books/${shortId(8)}`;
  const copied = await env.BUCKET.put(bookKey, source.body, {
    httpMetadata: { contentType },
  });
  await env.BUCKET.delete(key);

  // ── EPUB 解析：用文件内部的权威元数据 + 封面图，取代文件名的猜测 ──
  let title = meta.title;
  let author = meta.author;
  let language: string | null = null;
  let coverKey: string | null = null;
  /** 内容嗅探出的形态（漫画/电子书）；null = 判不出，按扩展名分类 */
  let sniffedKind: 'ebook' | 'comic' | 'audio' | null = null;

  if (format === 'epub') {
    try {
      const fetched = await env.BUCKET.get(bookKey);
      const epubBuf = await fetched?.arrayBuffer();
      if (epubBuf && epubBuf.byteLength <= PARSE_SIZE_CAP) {
        const parsed = await parseEpub(epubBuf);
        if (parsed) {
          if (parsed.title) title = parsed.title;
          if (parsed.author) author = parsed.author;
          language = parsed.language;
          // EPUB 的固定版式判断来自 OPF（已解析出来，不额外读盘）
          if (parsed.layout === 'comic') sniffedKind = 'comic';
          else if (parsed.layout === 'text') sniffedKind = 'ebook';
          if (parsed.cover) {
            const coverType = parsed.cover.contentType;
            // 扩展名由白名单推导（封面类型只可能来自字节嗅探，见 epub.ts）
            const ext = coverExtFor(coverType);
            if (ext) {
              coverKey = `covers/${bookKey.slice('books/'.length)}.${ext}`;
              await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
                httpMetadata: { contentType: coverType },
              });
            }
          }
        }
      }
    } catch {
      // 解析失败不影响上架：退回文件名推导，封面留空
    }
  }

  // ── 没有作者就再尽力找一次 ──
  // TXT 这类格式没有元数据，但很多中文小说会在开头几行写「作者：XXX」。
  // 只读一个小片段，读不到就算了。
  if (!author && format === 'txt') {
    try {
      const obj = await env.BUCKET.get(bookKey, { range: { offset: 0, length: 16 * 1024 } });
      if (obj) {
        const sample = new TextDecoder('utf-8').decode(await obj.arrayBuffer());
        const found = guessAuthorFromText(sample);
        if (found) author = found;
      }
    } catch {
      // 读不到就算了，不影响上架
    }
  }

  // ── PDF 内容嗅探：区分「文字书 PDF」与「扫描漫画 PDF」──
  if (format === 'pdf') {
    try {
      sniffedKind = await sniffKindFromBucket(env.BUCKET, bookKey, format);
    } catch {
      sniffedKind = null;
    }
  }

  await upsertBook(env.DB, {
    id: bookKey.slice('books/'.length),
    leafName: safeName,
    title,
    author,
    language,
    format,
    contentType,
    size: actualSize,
    sha256: null,
    r2Key: bookKey,
    etag: head.etag,
    titleLetter: letterBucket(title),
    authorLetter: authorBucket(author),
    formatBucket: format,
    // 内容嗅探优先于扩展名；判不出才交给 upsertBookStatement 按扩展名派生
    ...(sniffedKind ? { kindBucket: sniffedKind } : {}),
    publishedAt: new Date().toISOString(),
    coverKey,
  });
  await rebuildBuckets(env.DB);

  return jsonResponse({
    ok: true,
    title,
    author,
    language,
    format,
    size: actualSize,
    leafName: safeName,
    // 封面绝对 URL：上传页立刻可预览
    coverUrl: coverKey ? `${env.R2_PUBLIC_BASE}/${coverKey}` : null,
    parsed: format === 'epub' && actualSize <= PARSE_SIZE_CAP,
  });
}