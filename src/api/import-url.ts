/**
 * 从网址导入一本书（管理员通道，期 1）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────
 *
 * 书要进库，此前必须先下载到本机、再点上传或挂 WebDAV。URL 导入把这段
 * 手工搬运删掉：给一个直链，服务端拉一次、入库、完事。
 *
 * ── 为什么先只给管理员 ────────────────────────────────────────────────
 *
 * 这个端点是「把任意 URL 的内容写进公开书库」，等于同时打开 SSRF 与版权
 * 两个口。朋友的入口要等**邀请码 + inbox 隔离**都就位（设计稿 §3）再开。
 *
 * ── SSRF：说清楚它做到什么、做不到什么 ───────────────────────────────
 *
 * ⚠️ Workers 运行时**没有 DNS 解析 API**，没法在 fetch 之前把域名解析成
 *    IP 再判断内网。所以这里做的是：
 *      1. 只允许 http/https，拒绝 URL 里带账号口令
 *      2. 拒绝 IP 字面量（含内网段）、拒绝 localhost/.local/.internal 等后缀
 *      3. `redirect: 'manual'` 手动跟随，**每一跳都重做 1、2**
 *      4. 可选域名白名单 IMPORT_URL_ALLOWLIST（配了才是真可靠的形态）
 *    做不到的：公网域名解析到内网地址（DNS rebinding）。
 *    所以：默认只给管理员用，且文档里不假装这条已经解决
 *    （见 docs/source-ingest-design.md §5.2）。
 *
 * ── 配额 ──────────────────────────────────────────────────────────────
 *
 * 1 本书 = 1 次 Worker 请求（fetch + put + head + get + D1 若干都在这一次里）。
 * 走 guardWrite 与匿名上传共用 DAILY_WRITE_QUOTA —— 管理员批量导入超过
 * 300 本/天需要单独配额，这是**有意保留**的上限，不做特例。
 */

import type { Env } from '../config';
import { extensionOf, safeContentTypeFor, sanitiseLeafName } from '../lib/metadata';
import { isAllowedUploadExt } from '../lib/collections';
import { guardWrite } from '../lib/throttle';
import { sanitiseCredit } from '../lib/requests';
import {
  DEFAULT_MAX_BYTES,
  LICENSE_BASIS_VALUES,
  ingestBook,
  ingestFailureResponse,
  type LicenseBasis,
} from '../lib/ingest';
import { jsonResponse, shortId, textResponse } from '../lib/http';

/** 最多跟随几跳重定向。3 跳足够过 CDN 的偶发跳转，再多就是异常。 */
const MAX_REDIRECTS = 3;

/** 上游拉取的超时。Worker 本身没有硬超时，但客户端 100s 会断。 */
const FETCH_TIMEOUT_MS = 25_000;

/**
 * 内网/保留地址判定（不含 DNS 解析，只针对**字面量**与明显的内网后缀）。
 *
 * IPv6 字面量一律拒绝：这个场景用不上 IPv6-only 的公网源，
 * 而 `::ffff:127.0.0.1` 这类映射写法逐个放行太容易漏。
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;

  // 主机名后缀
  for (const suffix of ['.local', '.internal', '.lan', '.home.arpa', '.localdomain']) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
  }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv6 字面量：直接拒
  if (h.includes(':')) return true;

  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts as [number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // 纯数字主机（`http://2130706433/` 这种十进制写法会被运行时不解析，
  // 但拒掉不亏）
  if (/^\d+$/.test(h)) return true;
  return false;
}

function parseAllowlist(env: Env): string[] {
  return (env.IMPORT_URL_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 校验一个目标 URL 是否允许被拉取。返回 null 表示通过。 */
function rejectTarget(url: URL, allowlist: string[]): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'bad-protocol';
  if (url.username || url.password) return 'credentials-not-allowed';
  if (isBlockedHost(url.hostname)) return 'would-be-internal';
  if (allowlist.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!ok) return 'host-not-allowed';
  }
  return null;
}

/** 从 URL 的 pathname 取文件名（解码失败就原样用）。 */
function filenameFromUrl(u: URL): string {
  const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!last) return '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** multipart 的分片大小。必须 ≥ 5 MiB（R2 对非末片的下限），这里留余量。 */
const PART_BYTES = 8 * 1024 * 1024;

type PutResult = { ok: true } | { ok: false; reason: 'too-large' | 'read-failed' };

/**
 * 把上游流写进 R2，同时**边写边计数**。
 *
 * 为什么不能直接 `BUCKET.put(key, upstream.body)`：
 *   workerd 对 R2 的流式写入要求「已知长度」（请求/响应体或 FixedLengthStream）。
 *   上游经常不发 Content-Length（chunked），而且中间只要经过一层
 *   `pipeThrough`，长度信息就丢了 —— 实测报错：
 *   「Provided readable stream must have a known length」。
 *   所以这里用 multipart：分片上传不需要预先知道总长度，
 *   同时天然满足「超过上限就中断」——不会把 200MB 错误页写进桶里。
 *
 * 内存占用：只有 `buffer` 一处分片（≤ 8 MiB + 一个 chunk），
 * 不会把整本书读进 isolate（Free 版 128 MB 内存）。
 */
async function putLimitedStream(
  env: Env,
  key: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  contentType: string,
): Promise<PutResult> {
  const reader = body.getReader();
  const httpMetadata = { contentType };
  // 用对象持有引用：TS 的控制流分析看不到闭包里的赋值，直接写 `let upload`
  // 会在 catch 里被窄化成 never（编译不过）。
  const state: { upload: R2MultipartUpload | null } = { upload: null };
  const parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(0);
  let total = 0;

  const ensureUpload = async (): Promise<R2MultipartUpload> => {
    if (!state.upload) state.upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata });
    return state.upload;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('too-large');
      }

      // 拼到分片缓冲（单次拷贝，最大 8 MiB + chunk）
      const merged = new Uint8Array(buffer.byteLength + value.byteLength);
      merged.set(buffer, 0);
      merged.set(value, buffer.byteLength);
      buffer = merged;

      if (buffer.byteLength >= PART_BYTES) {
        const up = await ensureUpload();
        parts.push(await up.uploadPart(parts.length + 1, buffer));
        buffer = new Uint8Array(0);
      }
    }

    if (!state.upload && buffer.byteLength === 0) {
      // 空对象：长度 0 是已知的，普通 put 即可（不为此开一次 multipart）
      await env.BUCKET.put(key, new Uint8Array(0), { httpMetadata });
      return { ok: true };
    }

    const up = await ensureUpload();
    if (buffer.byteLength > 0) {
      parts.push(await up.uploadPart(parts.length + 1, buffer));
    }
    await up.complete(parts);
    return { ok: true };
  } catch (err) {
    if (state.upload) {
      try {
        await state.upload.abort();
      } catch {
        /* 中断失败不影响返回值：对象本来就不该存在 */
      }
    }
    try {
      await env.BUCKET.delete(key);
    } catch {
      /* 忽略 */
    }
    return { ok: false, reason: (err as Error)?.message === 'too-large' ? 'too-large' : 'read-failed' };
  }
}

/**
 * 二进制格式的魔数检查（只覆盖「声明与内容必然不一致」的硬判据）。
 *
 * 为什么只查这几个：EPUB/CBZ 必然是 ZIP（PK）、PDF 必然以 %PDF 开头。
 * TXT/MD/HTML 没有固定魔数，查不了也不该硬查 —— 猜错的代价比不查更大
 * （项目一贯的「判不出就返回 null」）。
 */
const MAGIC: Record<string, string> = {
  epub: 'PK',
  cbz: 'PK',
  cbt: 'PK',
  cba: 'PK',
  pdf: '%PDF',
  cbr: 'Rar!',
  cb7: '7z',
};

async function magicMismatch(env: Env, key: string, ext: string): Promise<string | null> {
  const want = MAGIC[ext];
  if (!want) return null;
  const head = await env.BUCKET.get(key, { range: { offset: 0, length: 8 } });
  if (!head) return null;
  const bytes = new Uint8Array(await head.arrayBuffer());
  const ascii = String.fromCharCode(...bytes);
  return ascii.startsWith(want) ? null : want;
}

interface ImportBody {
  url?: unknown;
  filename?: unknown;
  credit?: unknown;
  licenseBasis?: unknown;
}

export async function handleImportUrl(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed', { allow: 'POST' });
  }

  // 与匿名上传共用同一个日配额：管理员身份不是「无限写」的许可证。
  const blocked = await guardWrite(env, request, 300);
  if (blocked) return blocked;

  let body: ImportBody;
  try {
    body = (await request.json()) as ImportBody;
  } catch {
    return jsonResponse({ error: 'bad-json' }, 400);
  }

  if (typeof body.url !== 'string' || !body.url.trim()) {
    return jsonResponse({ error: 'url-required' }, 400);
  }

  // 授权依据是**必填**，且不接受 unknown：
  // 「不知道凭什么」的书不该走导入通道（隔离区尚未实现，见设计稿 §3）。
  const basis = typeof body.licenseBasis === 'string' ? body.licenseBasis : '';
  if (!LICENSE_BASIS_VALUES.includes(basis as LicenseBasis) || basis === 'unknown') {
    return jsonResponse(
      {
        error: 'license-basis-required',
        allowed: ['public-domain', 'authorized', 'user-declared'],
        hint: '导入必须声明依据：公版 / 已获授权 / 上传者自称有权。说不清来源的书不进库。',
      },
      400,
    );
  }

  let target: URL;
  try {
    target = new URL(body.url.trim());
  } catch {
    return jsonResponse({ error: 'bad-url' }, 400);
  }

  const allowlist = parseAllowlist(env);
  const rejected = rejectTarget(target, allowlist);
  if (rejected) {
    return jsonResponse(
      {
        error: rejected,
        host: target.hostname,
        hint:
          rejected === 'host-not-allowed'
            ? '本站配置了 IMPORT_URL_ALLOWLIST，只允许名单内的域名。'
            : '只允许公网 http/https 地址；内网、IP 字面量与本机地址一律拒绝。',
      },
      422,
    );
  }

  // 文件名：显式给的优先，否则从 URL 取。两者都要过扩展名白名单 ——
  // 这一关放在 fetch **之前**，避免为一个 .zip 白下载 200MB。
  const rawName =
    (typeof body.filename === 'string' && body.filename.trim()) || filenameFromUrl(target);
  const ext = extensionOf(rawName);
  if (!isAllowedUploadExt(ext)) {
    return jsonResponse(
      {
        error: 'unsupported-format',
        ext,
        hint: 'URL 无法判断格式时请显式传 filename（含扩展名）。',
      },
      415,
    );
  }

  const maxBytes = Number.parseInt(env.UPLOAD_MAX_BYTES ?? '', 10) || DEFAULT_MAX_BYTES;

  // ── 拉取（手动跟随重定向，每跳复检）────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream!: Response;
  let finalUrl = target;
  try {
    let current = target;
    for (let hop = 0; ; hop++) {
      upstream = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/epub+zip, application/pdf, application/octet-stream, */*',
          'user-agent': 'webooks-import/1.0 (+admin)',
        },
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        await upstream.body?.cancel();
        if (!location) {
          return jsonResponse({ error: 'bad-redirect', status: upstream.status }, 502);
        }
        if (hop >= MAX_REDIRECTS) {
          return jsonResponse({ error: 'too-many-redirects', max: MAX_REDIRECTS }, 422);
        }
        const next = new URL(location, current);
        // ⚠️ 每一跳都要重做校验：重定向到内网是 SSRF 最常见的绕过方式
        const bad = rejectTarget(next, allowlist);
        if (bad) return jsonResponse({ error: bad, host: next.hostname }, 422);
        current = next;
        finalUrl = next;
        continue;
      }
      finalUrl = current;
      break;
    }
  } catch {
    return jsonResponse({ error: 'upstream-unreachable' }, 502);
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status !== 200) {
    await upstream.body?.cancel();
    return jsonResponse({ error: 'upstream-status', status: upstream.status }, 502);
  }

  // 上游声明的长度先判一次（能省下整段下载）
  const declared = Number.parseInt(upstream.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel();
    return jsonResponse({ error: 'file-too-large', maxBytes, size: declared }, 413);
  }

  // 上游说是 HTML 就直接拒（除非书名本身就是 HTML —— 那是合法的电子书格式）。
  // 为什么需要这一条：错误页 / 登录页 / 404 页几乎都是 200 + text/html，
  // 不拦的话会被当成「一本没有封面的书」入库。
  const upstreamType = (upstream.headers.get('content-type') ?? '').toLowerCase();
  const htmlLike = upstreamType.includes('text/html') || upstreamType.includes('application/xhtml');
  if (htmlLike && !['html', 'htm', 'xhtml', 'txt', 'md'].includes(ext)) {
    await upstream.body?.cancel();
    return jsonResponse({ error: 'upstream-is-html', contentType: upstreamType }, 415);
  }

  // ── 落到暂存区，再交给唯一的入库管道 ───────────────────────────────
  const safeName =
    sanitiseLeafName(rawName.replace(/[\/\\]/g, '_')) ?? `book-${shortId(6)}`;
  const stagingKey = `uploads/import/${new Date().toISOString().slice(0, 10)}/${shortId(6)}/${safeName
    .replace(/[?#]/g, '_')
    .slice(0, 180)}`;

  const upstreamBody = upstream.body;
  if (!upstreamBody) {
    return jsonResponse({ error: 'upstream-empty' }, 502);
  }

  const put = await putLimitedStream(
    env,
    stagingKey,
    upstreamBody,
    maxBytes,
    safeContentTypeFor(safeName),
  );
  if (!put.ok) {
    return put.reason === 'too-large'
      ? jsonResponse({ error: 'file-too-large', maxBytes }, 413)
      : jsonResponse({ error: 'upstream-read-failed' }, 502);
  }

  // 魔数校验：声明 .epub 却拿到 HTML/纯文本时，这里拦下来
  const wantMagic = await magicMismatch(env, stagingKey, ext);
  if (wantMagic) {
    await env.BUCKET.delete(stagingKey);
    return jsonResponse(
      {
        error: 'magic-mismatch',
        ext,
        expected: wantMagic,
        hint: `内容与扩展名不符（.${ext} 应以 ${wantMagic} 开头）。可能拉到了错误页，或链接已失效。`,
      },
      415,
    );
  }

  const result = await ingestBook(env, {
    stagingKey,
    filename: safeName,
    credit: sanitiseCredit(body.credit),
    sourceKind: 'url',
    sourceUrl: finalUrl.toString(),
    licenseBasis: basis as LicenseBasis,
    ingestedBy: 'admin',
  });

  if (!result.ok) return ingestFailureResponse(result);

  const book = result.book;
  return jsonResponse({
    ok: true,
    title: book.title,
    author: book.author,
    format: book.format,
    size: book.size,
    leafName: book.leafName,
    coverUrl: book.coverKey ? `${env.R2_PUBLIC_BASE}/${book.coverKey}` : null,
    sourceKind: 'url',
    sourceUrl: finalUrl.toString(),
    licenseBasis: basis,
  });
}
