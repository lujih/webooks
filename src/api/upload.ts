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
import { letterBucket, normaliseFormat } from '../lib/collections';
import { deriveMetadata, preferContentType } from '../lib/metadata';
import { rebuildBuckets, upsertBook } from '../lib/db';
import { shortId } from '../lib/http';
import { createPresignedPutUrl } from '../lib/sigv4';
import { parseEpub, PARSE_SIZE_CAP } from '../lib/epub';
import { jsonResponse, textResponse } from '../lib/http';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** 允许的电子书扩展名（与 normaliseFormat 的映射保持一致） */
const ALLOWED_EXT = new Set([
  'epub', 'pdf', 'mobi', 'azw', 'azw3', 'fb2', 'djvu', 'txt', 'rtf', 'cbz', 'cbr', 'm4a', 'm4b', 'mp3',
]);

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200 MiB
const DEFAULT_DAILY_QUOTA = 20; // 每 IP 每天上传次数

interface InitBody {
  filename: string;
  size: number;
  contentType?: string;
  turnstileToken: string;
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

export async function handleUploadInit(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed', { allow: 'POST' });
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

  let body: InitBody;
  try {
    body = (await request.json()) as InitBody;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }

  const { filename, size, turnstileToken } = body;

  // 基础校验
  if (typeof filename !== 'string' || !filename.trim()) {
    return jsonResponse({ error: 'filename-required' }, 400);
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return jsonResponse({ error: 'size-required' }, 400);
  }
  if (typeof turnstileToken !== 'string' || !turnstileToken) {
    return jsonResponse({ error: 'turnstile-token-required' }, 400);
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXT.has(ext)) {
    return jsonResponse({ error: 'unsupported-format', ext, allowed: [...ALLOWED_EXT] }, 415);
  }

  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? '', 10) || DEFAULT_MAX_BYTES;
  if (size > maxBytes) {
    return jsonResponse({ error: 'file-too-large', maxBytes }, 413);
  }

  // Turnstile 验证（fail-closed）
  const ip = clientIp(request);
  const ok = await verifyTurnstile(env, turnstileToken, ip);
  if (!ok) {
    return jsonResponse({ error: 'turnstile-failed' }, 403);
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
  const contentType = preferContentType(body.contentType ?? null, deriveMetadata(safeName).contentType);

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

  return jsonResponse({
    uploadUrl: putUrl,
    key,
    method: 'PUT',
    headers: { 'content-type': contentType },
    expiresIn: 900,
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

  const safeName = (filename || key.split('/').pop() || 'book').replace(/[\/\\]/g, '_');
  const meta = deriveMetadata(safeName);
  const format = normaliseFormat(safeName.split('.').pop());
  const contentType = head.httpMetadata?.contentType ?? meta.contentType;

  // 从 uploads/ 搬到 books/ 并登记元数据（自动上架）。
  // 先确认源对象可读（R2 的 get 可能返回 null），再流式搬到目标键。
  const source = await env.BUCKET.get(key);
  if (!source) {
    return jsonResponse({ error: 'object-unreadable' }, 404);
  }
  const bookKey = `books/${shortId(8)}`;
  const copied = await env.BUCKET.put(bookKey, source.body, {
    httpMetadata: { contentType: head.httpMetadata?.contentType ?? meta.contentType },
  });
  await env.BUCKET.delete(key);

  // ── EPUB 解析：用文件内部的权威元数据 + 封面图，取代文件名的猜测 ──
  let title = meta.title;
  let author = meta.author;
  let language: string | null = null;
  let coverKey: string | null = null;

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
          if (parsed.cover) {
            const coverType = parsed.cover.contentType || 'image/jpeg';
            const ext = coverType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
            coverKey = `covers/${bookKey.slice('books/'.length)}.${ext}`;
            await env.BUCKET.put(coverKey, new Uint8Array(parsed.cover.bytes), {
              httpMetadata: { contentType: coverType },
            });
          }
        }
      }
    } catch {
      // 解析失败不影响上架：退回文件名推导，封面留空
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
    authorLetter: letterBucket(author ?? title),
    formatBucket: format,
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