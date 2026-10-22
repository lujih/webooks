/**
 * 防倒退守卫：**下载路径不许再回到「每次都经过 Worker」**。
 *
 * 免费套餐每天只有 10 万次 Worker 请求。浏览页书卡改成 R2 公开域直链之后，
 * 「点开一本书」不再撞 Worker 的 302；但这次优化有个特点 —— **它坏掉的时候
 * 不会报错，只会变慢、变贵**：
 *
 *   1. 书卡 href 改回 `/dav/...`（或 downloadUrl 的回退分支被删掉）→ 每次点击
 *      又重新消耗一次请求，而且老缓存条目会渲染出 `href="undefined"`。
 *   2. 某条写入路径自己写一份 Content-Disposition（或干脆不写）→ 有的书下载
 *      下来叫 `95e860d26bd874cf`，有的叫书名。**只在用户下载时才暴露**。
 *   3. 回填动作写错 → 把 Content-Type 一起清掉（比不回填更糟），或者把封面也
 *      带上 `attachment`（封面在浏览页是 `<img>` 内联展示的，会变成下载）。
 *
 * 行为层面的断言在 `test/r2-download.test.ts`（那条路径真的返回什么）；这里钉的
 * 是**源码结构与回填动作**这两件 `SELF.fetch()` 看不到的事 —— 同一个 helper、
 * 回退分支必须存在、封面不许带 attachment、直链不许漏进 PROPFIND 的 XML。
 *
 * 源码怎么读进来的：`?raw` 导入。workerd 的 `node:fs` 是空壳（任何路径 ENOENT），
 * 所以 `test/static-assets.test.ts` 走的是「vitest.config.ts 在 Node 侧读好当
 * binding 传进来」那条通道 —— 那条通道只为 public/ 与 scripts/ 开，源码本身用
 * Vite 的 `?raw` 更直接：它在 vitest-pool-workers 里可用，且零配置改动。
 */

/// <reference types="vite/client" />

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authorBucket, letterBucket } from '../src/lib/collections';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const SRC = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ORIGIN = 'https://webooks.test';
const R2_BASE = 'https://books.test';
const ALL_PATHS = ['/', '/按书名/', '/按书名/其他/', '/最近收录/', '/recent/', '/title/', '/title/S/'];

/** 取源码文本；文件缺失时抛错，而不是让断言悄悄对着空串跑绿。 */
function srcFile(path: string): string {
  const text = SRC[path];
  if (typeof text !== 'string') throw new Error(`读不到源码：${path}（?raw glob 是否失效？）`);
  return text;
}

/**
 * 去掉注释行再做文本断言。
 *
 * 必须去注释：`r2HttpMetadata` 与 `Content-Disposition` 在注释里被大量提及
 * （「两者统一由 r2HttpMetadata 生成」这种），按原文计数会把注释算进去。
 * 只删「整行都是注释」的行与 `/* *​/` 块 —— 够用，且不会像「找 // 就截断」
 * 那样把 `https://…` 这类字符串切断。
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

/** 在一段文本里数正则命中次数（每次新建正则，避免 /g 的 lastIndex 状态）。 */
function countMatches(text: string, pattern: string): number {
  return (text.match(new RegExp(pattern, 'g')) ?? []).length;
}

// ── 端到端用的辅助 ──────────────────────────────────────────────────────

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-write-token',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function propfind(path: string, depth?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/xml' };
  if (depth !== undefined) headers.depth = depth;
  return dav(path, { method: 'PROPFIND', headers, body: '' });
}

interface BackfillBody {
  action: string;
  after: string;
  limit: number;
  dryRun: boolean;
  scanned: number;
  backfilled: number;
  skipped: number;
  missing: number;
  failed: number;
  bytesRewritten: number;
  nextAfter: string | null;
  failures: Array<{ id: string; leafName: string; error: string }>;
  note: string;
}

async function backfill(
  query = '',
  init: RequestInit = {},
): Promise<{ status: number; body: BackfillBody }> {
  const res = await SELF.fetch(`${ORIGIN}/api/admin/backfill-disposition${query}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as BackfillBody };
}

interface SeedSpec {
  id: string;
  leafName: string;
  /** 默认 `books/<id>` */
  r2Key?: string;
  body?: string;
  httpMetadata?: R2HTTPMetadata;
  /** false = 只在 D1 登记、R2 不放对象（制造数据不一致） */
  putObject?: boolean;
}

/** 登记一行书 + 往 R2 写一个对象，返回实际写进去的字节数。 */
async function seedBook(spec: SeedSpec): Promise<{ r2Key: string; bytes: number }> {
  const meta = deriveMetadata(spec.leafName);
  const r2Key = spec.r2Key ?? `books/${spec.id}`;
  const body = spec.body ?? 'EPUB-BYTES';
  const bytes = new TextEncoder().encode(body).byteLength;

  await upsertBookStatement(testEnv.DB, {
    id: spec.id,
    leafName: spec.leafName,
    title: meta.title,
    author: meta.author,
    language: null,
    format: meta.format,
    contentType: meta.contentType,
    size: bytes,
    sha256: null,
    r2Key,
    etag: `etag-${spec.id}`,
    // 必须用 letterBucket：中文书名会进 other 桶，直接取首字符会分错
    titleLetter: letterBucket(meta.title),
    authorLetter: authorBucket(meta.author),
    formatBucket: meta.format,
    publishedAt: new Date().toISOString(),
  }).run();

  if (spec.putObject !== false) {
    await testEnv.BUCKET.put(
      r2Key,
      body,
      spec.httpMetadata ? { httpMetadata: spec.httpMetadata } : undefined,
    );
  }
  return { r2Key, bytes };
}

async function rebuild(): Promise<void> {
  await rebuildBuckets(testEnv.DB);
}

async function storedMeta(r2Key: string): Promise<R2HTTPMetadata | undefined> {
  const head = await testEnv.BUCKET.head(r2Key);
  return head?.httpMetadata;
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(ALL_PATHS);
});

// ══════════════════════════════════════════════════════════════════════
// 一、源码守卫：书卡必须直连 R2，且必须有回退
// ══════════════════════════════════════════════════════════════════════

describe('源码守卫：书卡 href 的直链与回退', () => {
  it('哨兵：src/ 的源码确实读到了（否则下面全是假绿）', () => {
    expect(Object.keys(SRC).length).toBeGreaterThanOrEqual(30);
    for (const path of [
      '../src/browse-page.ts',
      '../src/lib/r2.ts',
      '../src/webdav/index.ts',
      '../src/webdav/propfind.ts',
      '../src/api/upload.ts',
      '../src/api/admin.ts',
    ]) {
      expect(srcFile(path).length, `${path} 是空的`).toBeGreaterThan(200);
    }
  });

  it('书卡分支：用 meta.downloadUrl，且为 undefined/空串时回退到 davHref', () => {
    const browse = codeOnly(srcFile('../src/browse-page.ts'));

    // 三元的「真分支」必须走 downloadUrl（这是省下那次 Worker 请求的唯一原因）
    // 「假分支」必须是 davHref —— 删掉回退就会渲染出 href="undefined"
    expect(browse).toMatch(
      /e\.meta\.downloadUrl\s*\?\s*esc\(e\.meta\.downloadUrl\)\s*:\s*davHref/,
    );
    // 防呆：不许直接内插 downloadUrl（那样 undefined 会变成字符串 "undefined"）
    expect(browse).not.toContain('href="${e.meta.downloadUrl}"');
  });

  it('书卡的 href 取 bookHref（不是 davHref）；集合卡仍走 /dav', () => {
    const browse = codeOnly(srcFile('../src/browse-page.ts'));

    expect(browse).toMatch(/class="card bookcard" href="\$\{bookHref\}"/);
    // 集合卡永远走 /dav：目录 HTML 必须由 Worker 生成，不存在「目录直链」
    expect(browse).toMatch(/class="card shelfcard" href="\$\{davHref\}"/);
  });

  it('WebDAV 客户端的 GET 302 仍在（rclone / Finder 依赖，本次故意没动）', () => {
    const webdav = codeOnly(srcFile('../src/webdav/index.ts'));

    // 302 的目标必须是 R2 公开域 + 同一个 encodeR2Key 拼法（两处编码规则分裂
    // 会让同一本书出现两个 URL：缓存劈裂、rclone 把一本书认成两个文件）
    expect(webdav).toMatch(/location:[^\n]*encodeR2Key\(book\.r2_key\)/);
  });

  it('downloadUrl 不许进 PROPFIND 的属性白名单', () => {
    const propfind = codeOnly(srcFile('../src/webdav/propfind.ts'));

    // 它只是 ResourceMeta 上的展示字段，书卡渲染时读
    expect(propfind).toMatch(/downloadUrl\?: string \| null;/);
    // 属性白名单是带引号的字面量数组，加进去就等于改了 WebDAV 协议输出
    expect(propfind).not.toMatch(/'downloadUrl'/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 二、源码守卫：三条写入路径必须共用同一个 helper
// ══════════════════════════════════════════════════════════════════════

describe('源码守卫：R2 写入只允许有一份元数据实现', () => {
  it('contentDisposition 只在 lib/r2.ts 里被写出来', () => {
    // 这是「同一个 helper」的最硬判据：任何地方自己写一份
    // `contentDisposition: '...'`，这个断言就红。
    // 读（`head.httpMetadata?.contentDisposition`）不算 —— 回填动作要读它来判幂等。
    const writers = Object.entries(SRC)
      .filter(([, text]) => codeOnly(text).includes('contentDisposition:'))
      .map(([path]) => path);

    expect(writers).toEqual(['../src/lib/r2.ts']);
  });

  it('三条写入路径 + 回填动作都调用 r2HttpMetadata（新增写入路径时请更新本条）', () => {
    const counts = Object.fromEntries(
      Object.entries(SRC)
        .map(([path, text]) => [path, countMatches(codeOnly(text), 'r2HttpMetadata\\s*\\(')] as const)
        .filter(([, n]) => n > 0),
    );

    expect(counts).toEqual({
      // 定义处
      '../src/lib/r2.ts': 1,
      // COPY/MOVE 一处 + WebDAV PUT 一处（PUT 的「可解析」与「流式」两个分支
      // 共用同一个 httpMetadata 常量，所以这里是 2 而不是 3）
      '../src/webdav/index.ts': 2,
      // 网页上传 complete 的搬运
      '../src/api/upload.ts': 1,
      // 已存在对象的回填
      //（+2026-10-21 的 migrate-keys：把存量对象搬到可读键，
      // 搬的过程中 put 必须带完整 httpMetadata，否则文件变 octet-stream）
      '../src/api/admin.ts': 2,
    });
  });

  it('封面写入只给 contentType —— 带上 attachment 封面就变成下载了', () => {
    const sites = Object.entries(SRC)
      .map(([path, text]) => [path, countMatches(codeOnly(text), '\\{ contentType: coverType \\}')] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));

    expect(sites).toEqual([
      ['../src/api/upload.ts', 1],
      ['../src/webdav/index.ts', 1],
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 三、直链不许漏进 WebDAV 协议输出
// ══════════════════════════════════════════════════════════════════════

describe('PROPFIND 不许泄露 R2 直链', () => {
  it('响应里有这本书，但没有 downloadUrl，也没有 R2 公开域', async () => {
    await seedBook({ id: 'pf-1', leafName: '三体.epub' });
    await rebuild();

    const res = await propfind('/recent/', '1');
    const xml = await res.text();

    expect(res.status).toBe(207);
    // 哨兵：确认这个响应真的列了内容（否则下面的 not.toContain 全是假绿）
    expect(xml).toContain('</D:multistatus>');
    expect(countMatches(xml, '<D:response>')).toBeGreaterThanOrEqual(2);

    expect(xml).not.toContain('downloadUrl');
    // 直链是「浏览器书卡专用」的展示字段：WebDAV 客户端拿到的必须是
    // /dav/... 的 href，它才能继续走鉴权 + 配额 + Range 透传那条路
    expect(xml).not.toContain(R2_BASE);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 四、回填动作：给已经存在的对象补上 Content-Disposition
// ══════════════════════════════════════════════════════════════════════
// 为什么需要它：R2 的 httpMetadata 只在**写入时**生效，且不支持 S3 的
// response-content-disposition 覆盖参数（实测无效）。helper 落地之前写进去的
// 对象，直链下载下来会叫 95e860d26bd874cf —— 没有扩展名。

describe('回填动作 backfill-disposition', () => {
  it('没带 token 进不去', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/backfill-disposition`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('dryRun 只统计不写：对象元数据一个字节都不动', async () => {
    const a = await seedBook({ id: 'bf-a', leafName: '甲.epub', body: 'AAAAAAAAAA' });
    const b = await seedBook({ id: 'bf-b', leafName: '乙.epub', body: 'BBBBBBBBBBBB' });

    const { status, body } = await backfill('?dryRun=1');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      action: 'backfill-disposition',
      dryRun: true,
      scanned: 2,
      backfilled: 2,
      skipped: 0,
      missing: 0,
      failed: 0,
      bytesRewritten: a.bytes + b.bytes,
      nextAfter: null,
    });
    expect(body.note).toContain('没有写入任何对象');

    // dryRun 之后对象必须还是「没有 contentDisposition」的原样
    expect((await storedMeta(a.r2Key))?.contentDisposition).toBeUndefined();
    expect((await storedMeta(b.r2Key))?.contentDisposition).toBeUndefined();
  });

  it('真跑：补上下载名、纠正历史 Content-Type，且内容与体积不变', async () => {
    // 模拟迁移前的脏对象：只有客户端声明的 text/html（真实踩过的漏洞），没有下载名
    const bad = await seedBook({
      id: 'bf-legacy',
      leafName: '搜神记.epub',
      body: 'LEGACY-EPUB-BYTES',
      httpMetadata: { contentType: 'text/html' },
    });

    const { body } = await backfill();
    expect(body).toMatchObject({ scanned: 1, backfilled: 1, skipped: 0, bytesRewritten: bad.bytes });
    expect(body.note).toContain('已扫描完全部书');

    const meta = await storedMeta(bad.r2Key);
    // 下载名来自 D1 的 leaf_name，不是对象键里的随机 id
    expect(meta?.contentDisposition).toContain('attachment; filename=');
    expect(meta?.contentDisposition).toContain('filename*=UTF-8');
    // Content-Type 一起给全了：只写 contentDisposition 会把 text/html 之外
    // 的值也清成默认值（比不回填更糟），所以这里同时钉住「被纠正」与「没被清空」
    expect(meta?.contentType).toBe('application/epub+zip');

    // 只重写元数据、不真的重传内容：字节必须原样回来，size 不变
    const object = await testEnv.BUCKET.get(bad.r2Key);
    expect(await object?.text()).toBe('LEGACY-EPUB-BYTES');
    const head = await testEnv.BUCKET.head(bad.r2Key);
    expect(head?.size).toBe(bad.bytes);
  });

  it('幂等：再跑一次全部跳过，不会重复搬运', async () => {
    const a = await seedBook({ id: 'bf-idem-a', leafName: '甲.epub', body: 'AAAAAAAAAA' });
    await seedBook({ id: 'bf-idem-b', leafName: '乙.epub', body: 'BBBBBBBBBBBB' });

    const first = await backfill();
    expect(first.body).toMatchObject({ scanned: 2, backfilled: 2, skipped: 0 });

    const second = await backfill();
    expect(second.body).toMatchObject({
      scanned: 2,
      backfilled: 0,
      skipped: 2,
      failed: 0,
      bytesRewritten: 0,
    });
    // 第二次没有再写一遍
    expect((await storedMeta(a.r2Key))?.contentDisposition).toContain('attachment');
  });

  it('返回 JSON 能分清「处理 / 跳过 / 缺失 / 失败」四类，字段一个不少', async () => {
    await seedBook({ id: 'bf-f-a', leafName: '甲.epub' });
    // 跳过：封面键永远不该带 attachment（它在浏览页是 <img> 内联展示的）
    await seedBook({
      id: 'bf-f-cover',
      leafName: '封面.jpg',
      r2Key: 'covers/bf-f-cover.jpg',
      httpMetadata: { contentType: 'image/jpeg' },
    });
    // 跳过：上传暂存区
    await seedBook({ id: 'bf-f-up', leafName: '暂存.epub', r2Key: 'uploads/bf-f-up' });
    // 缺失：D1 有行、R2 没对象
    await seedBook({ id: 'bf-f-gone', leafName: '丢了.epub', putObject: false });

    const { body } = await backfill();
    expect(body).toMatchObject({ scanned: 4, backfilled: 1, skipped: 2, missing: 1, failed: 0 });

    expect(Object.keys(body).sort()).toEqual(
      [
        'action', 'after', 'backfilled', 'bytesRewritten', 'dryRun', 'failed', 'failures',
        'limit', 'missing', 'nextAfter', 'note', 'scanned', 'skipped',
      ].sort(),
    );

    // 封面与暂存区对象必须仍然不带下载名（否则封面在浏览器里变成下载）
    expect((await storedMeta('covers/bf-f-cover.jpg'))?.contentDisposition).toBeUndefined();
  });

  it('分页：limit 生效，nextAfter 能一路走到底', async () => {
    await seedBook({ id: 'bf-p-a', leafName: 'A.epub' });
    await seedBook({ id: 'bf-p-b', leafName: 'B.epub' });
    await seedBook({ id: 'bf-p-c', leafName: 'C.epub' });

    const page1 = await backfill('?limit=2');
    expect(page1.body).toMatchObject({ scanned: 2, backfilled: 2, nextAfter: 'bf-p-b' });

    const page2 = await backfill(`?after=${page1.body.nextAfter}&limit=2`);
    expect(page2.body).toMatchObject({ scanned: 1, backfilled: 1, nextAfter: null });
  });

  it('上限被硬 clamp 到 16（Free 的子请求上限是 50/次）', async () => {
    // R2 的 ListObjects 属 Class A 计费，且一本最坏要 head + get + put 三个
    // 子请求；limit 调大不会更快，只会撞上子请求上限。
    const { body } = await backfill('?limit=1000');
    expect(body.limit).toBe(16);
    expect(body.action).toBe('backfill-disposition');
  });
});
