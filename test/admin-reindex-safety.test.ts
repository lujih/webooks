/**
 * 两个 admin 动作的边界守卫（都是**已核实**的真实缺陷，不是假想）。
 *
 * 一、`reindex` 绕过扩展名白名单
 *     网页上传（`src/api/upload.ts`）与 WebDAV PUT（`src/webdav/index.ts`）都卡
 *     扩展名白名单，`reindex` 是**第三个**入库入口，曾经只调 `sanitiseLeafName`
 *     + `deriveMetadata`。从 R2 控制台或任何别的通道把 `恶意.exe` 丢进
 *     `library/`，跑一次 reindex 就直接入库上架 —— 而且这条路上没有任何别的闸门
 *     （PUT 的 415 不经过这里，网页上传的 415 也不经过这里）。
 *
 *     这个缺陷的危险之处在于**它不会自己暴露**：白名单漏了，库里只是多了几个
 *     不该有的文件；没人会去数 `indexed` 和实际对象数差了几本，除非是被人塞了
 *     可执行文件之后。所以这里既钉行为（三类对象各一条），也钉响应里能看出原因
 *     （`rejectedByExt` 必须与 `skipped` 分开）。
 *
 * 二、`backfill-disposition` 的 `nextAfter` 假信号
 *     verify-r2 在线上实测到（全库 16 本、`limit=16`）：`scanned=16` 明明已经
 *     覆盖全库，响应却仍返回一个非 null 的 `nextAfter`；带上它再调一次才拿到
 *     `scanned=0`。成因是拿「这一页装满了」去推断「后面还有」——
 *     `rows.length === limit` 只说明页满，和「还有下一页」是两件事。
 *     数据没错（多打一次空请求就停了），但按 `nextAfter` 做分页的客户端
 *     （`while (nextAfter) …` 这种写法）会白打一跳。
 *
 *     修法是查询多取一行当探针。这里必须钉死两件事，否则修法本身会引入新 bug：
 *       (a) 探针那一行**不参与回填** —— 否则每页都会多改一本（边界上还会漏书）；
 *       (b) 探针说没有下一页时，`nextAfter` 必须是 `null` —— 这正是「白打一跳」的根。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authorBucket, letterBucket } from '../src/lib/collections';
import { upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ADMIN = `Bearer test-token`;

// ── 端到端辅助 ──────────────────────────────────────────────────────────

interface ReindexBody {
  prefix: string;
  indexed: number;
  skipped: number;
  rejectedByExt: number;
  truncated: boolean;
  nextCursor: string | null;
  bucketsRebuilt: boolean;
}

async function reindex(query = ''): Promise<{ status: number; body: ReindexBody }> {
  const res = await SELF.fetch(`${ORIGIN}/api/admin/reindex${query}`, {
    method: 'POST',
    headers: { authorization: ADMIN },
  });
  return { status: res.status, body: (await res.json()) as ReindexBody };
}

interface BackfillBody {
  action: string;
  after: string;
  limit: number;
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

async function backfill(query = ''): Promise<{ status: number; body: BackfillBody }> {
  const res = await SELF.fetch(`${ORIGIN}/api/admin/backfill-disposition${query}`, {
    method: 'POST',
    headers: { authorization: ADMIN },
  });
  return { status: res.status, body: (await res.json()) as BackfillBody };
}

/** 往 R2 直接丢一个对象（模拟「从 R2 控制台塞进来的文件」）。 */
async function putRaw(key: string, body = 'RAW-BYTES'): Promise<void> {
  await testEnv.BUCKET.put(key, body);
}

/** 同时登记 D1 行 + 写 R2 对象，返回 r2Key 与字节数。 */
async function seedBook(spec: {
  id: string;
  leafName: string;
  body?: string;
}): Promise<{ r2Key: string; bytes: number }> {
  const meta = deriveMetadata(spec.leafName);
  const r2Key = `books/${spec.id}`;
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
    titleLetter: letterBucket(meta.title),
    authorLetter: authorBucket(meta.author),
    formatBucket: meta.format,
    publishedAt: new Date().toISOString(),
  }).run();

  // 故意不带 contentDisposition：这正是「待回填」的状态
  await testEnv.BUCKET.put(r2Key, body);
  return { r2Key, bytes };
}

async function storedMeta(r2Key: string): Promise<R2HTTPMetadata | undefined> {
  const head = await testEnv.BUCKET.head(r2Key);
  return head?.httpMetadata;
}

/** D1 里某个 leaf_name 是否存在（判断 reindex 到底有没有入库）。 */
async function dbHasLeafName(leafName: string): Promise<boolean> {
  const row = await testEnv.DB.prepare(`SELECT id FROM books WHERE leaf_name = ?`)
    .bind(leafName)
    .first<{ id: string }>();
  return row !== null;
}

async function countBooks(): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM books`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await resetLibrary();
});

// ══════════════════════════════════════════════════════════════════════
// 一、reindex 必须卡扩展名白名单
// ══════════════════════════════════════════════════════════════════════

describe('reindex 的扩展名白名单', () => {
  it('三类对象：.exe / .m4a 被拒收，.epub 正常入库，计数各归各的', async () => {
    // 用独立前缀：reindex 的 prefix 是参数，别的测试或别的通道在 library/ 下放了
    // 什么都不该影响这一条。SanitiseLeafName 只看 basename，前缀深度无所谓。
    const prefix = 'library/t7-ext/';
    await putRaw(`${prefix}恶意.exe`); // 无 FORMAT_MAP 映射
    await putRaw(`${prefix}有声.m4a`); // 有映射（audio），但 audio 不在白名单
    await putRaw(`${prefix}正经.epub`);

    const { status, body } = await reindex(`?prefix=${prefix}`);
    expect(status).toBe(200);

    expect(body).toMatchObject({
      prefix,
      indexed: 1, // 只有 .epub
      skipped: 0,
      rejectedByExt: 2, // .exe + .m4a
      truncated: false,
      bucketsRebuilt: true,
    });

    // 行为层面的硬断言：被拒的两本**一个字都没进 D1**
    expect(await dbHasLeafName('恶意.exe')).toBe(false);
    expect(await dbHasLeafName('有声.m4a')).toBe(false);
    expect(await dbHasLeafName('正经.epub')).toBe(true);
    expect(await countBooks()).toBe(1);
  });

  it('大小写与别名不影响判定：.EXE / .M4A / .AZW 与 WebDAV PUT 同口径', async () => {
    // 与 src/webdav/index.ts 的 PUT 口径对齐：那边是
    // `leafName.split('.').pop()?.toLowerCase()` —— 大小写先归一化再判定。
    // 如果哪天改成对原始扩展名直接比较，`.EXE` 就会漏进来，这条会红。
    const prefix = 'library/t7-case/';
    await putRaw(`${prefix}大写.EXE`);
    await putRaw(`${prefix}大写.M4A`);
    await putRaw(`${prefix}别名.AZW`); // azw → azw3 是白名单内的别名，必须放行

    const { body } = await reindex(`?prefix=${prefix}`);
    expect(body).toMatchObject({ indexed: 1, rejectedByExt: 2, skipped: 0 });
    expect(await dbHasLeafName('大写.EXE')).toBe(false);
    expect(await dbHasLeafName('大写.M4A')).toBe(false);
    expect(await dbHasLeafName('别名.AZW')).toBe(true);
  });

  it('rejectedByExt 与 skipped 是两件事，不能互相吞掉', async () => {
    // skipped 的语义是「目录占位对象 / 文件名清洗后为空」这类**结构性**跳过；
    // 格式不允许是另一回事。混在一起运维就看不出「扫了 3 个只入库 1 本，
    // 另外 2 本去哪了」—— 「为什么少了几本」正是这个计数字段存在的理由。
    const prefix = 'library/t7-count/';
    await putRaw(`${prefix}`); // R2 控制台的目录占位对象（键以 / 结尾）
    await putRaw(`${prefix}脚本.sh`); // 另一个非白名单格式

    const { body } = await reindex(`?prefix=${prefix}`);
    expect(body).toMatchObject({ indexed: 0, rejectedByExt: 1, skipped: 1 });
  });

  it('返回 JSON 的字段一个不少（运维脚本按字段名取值）', async () => {
    const { body } = await reindex('?prefix=library/t7-empty/');
    expect(Object.keys(body).sort()).toEqual(
      [
        'bucketsRebuilt', 'indexed', 'nextCursor', 'prefix', 'rejectedByExt', 'skipped', 'truncated',
      ].sort(),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 二、backfill-disposition：nextAfter 必须是确定的答案
// ══════════════════════════════════════════════════════════════════════

describe('backfill-disposition 的 nextAfter 边界', () => {
  it('库里恰好剩最后一页（16 本 / limit=16）→ nextAfter 必须是 null', async () => {
    // 这条直接复刻 verify-r2 在线上实测到的假信号：
    //   $ curl '…/backfill-disposition?dryRun=1&limit=16'
    //   {"scanned":16, …, "nextAfter":"f53b106d412c6026"}   ← 全库就 16 本，却是非 null
    //   带上它再调 → {"after":"f53b106d412c6026","scanned":0,…}
    // 「整页装满」不等于「后面还有」，这里用恰好一页来钉住这个区别。
    const ids: string[] = [];
    let expectedBytes = 0;
    for (let i = 0; i < 16; i++) {
      const id = `t7-last-${String(i).padStart(2, '0')}`;
      ids.push(id);
      const { bytes } = await seedBook({ id, leafName: `第${i + 1}本.epub` });
      expectedBytes += bytes;
    }

    const { body } = await backfill('?limit=16');
    expect(body).toMatchObject({
      limit: 16,
      scanned: 16, // 全库都扫到了
      backfilled: 16,
      skipped: 0,
      missing: 0,
      failed: 0,
      bytesRewritten: expectedBytes,
      nextAfter: null, // ← 假信号就是错在这里
    });
    expect(body.note).toContain('已扫描完全部书');

    // 且这 16 本都真的补上了下载名（不是「报告说补了」）
    for (const id of ids) {
      expect((await storedMeta(`books/${id}`))?.contentDisposition).toContain('attachment');
    }
  });

  it('探针那一行不参与回填：整页 10 本 + 第 11 本，第 11 本必须原封不动', async () => {
    // 修法是 `LIMIT limit + 1` 多取一行判断 hasMore。风险在于忘了把探针行切掉 ——
    // 那就会每页多改一本，`scanned` 也会变成 11（对外语义是「本页处理了几本」）。
    const prefix = 't7-probe-';
    let firstTenBytes = 0;
    for (let i = 0; i < 10; i++) {
      const letter = String.fromCharCode(97 + i); // a..j，字典序与插入序一致
      const { bytes } = await seedBook({ id: `${prefix}${letter}`, leafName: `第${i + 1}本.epub` });
      firstTenBytes += bytes;
    }
    const eleventh = await seedBook({ id: `${prefix}k`, leafName: '第十一本.epub' });

    const page1 = await backfill('?limit=10');
    expect(page1.body).toMatchObject({
      scanned: 10, // 不是 11
      backfilled: 10, // 探针行没有被回填
      bytesRewritten: firstTenBytes,
      nextAfter: `${prefix}j`, // 指向本页最后一本，不是探针那本
    });

    // 决定性的那一条：第 11 本的对象此刻必须还是「没有 contentDisposition」
    expect((await storedMeta(eleventh.r2Key))?.contentDisposition).toBeUndefined();

    // 续跑能覆盖到它，并且到它为止
    const page2 = await backfill(`?after=${page1.body.nextAfter}&limit=10`);
    expect(page2.body).toMatchObject({
      scanned: 1,
      backfilled: 1,
      bytesRewritten: eleventh.bytes,
      nextAfter: null,
    });
    expect((await storedMeta(eleventh.r2Key))?.contentDisposition).toContain('attachment');
  });

  it('while (nextAfter) 循环：16 本恰好 1 跳、17 本恰好 2 跳，没有空请求', async () => {
    // 这是调用方真实会写的循环。它多打一次请求就是「白打一跳」，
    // 而 10 万次/天的请求额度下这种浪费是会累积的。
    async function drain(limit: number): Promise<{ requests: number; seen: number }> {
      let after = '';
      let requests = 0;
      let seen = 0;
      for (;;) {
        requests++;
        expect(requests, '分页没有收敛（nextAfter 永远非 null？）').toBeLessThanOrEqual(5);
        const { body } = await backfill(`?limit=${limit}${after ? `&after=${after}` : ''}`);
        seen += body.scanned;
        if (!body.nextAfter) break;
        after = body.nextAfter;
      }
      return { requests, seen };
    }

    for (let i = 0; i < 16; i++) {
      await seedBook({ id: `t7-drain16-${String(i).padStart(2, '0')}`, leafName: `A${i}.epub` });
    }
    const exact = await drain(16);
    expect(exact).toEqual({ requests: 1, seen: 16 });

    // 再加一本，同一页长就应该变成两跳（第二跳只有 1 本，且立刻收敛）
    await seedBook({ id: 't7-drain16-99', leafName: 'A99.epub' });
    const overflow = await drain(16);
    expect(overflow).toEqual({ requests: 2, seen: 17 });
  });

  it('after 游标本身仍然生效（修复没有把分页弄丢）', async () => {
    // 反向守卫：如果谁把 hasMore 写成恒 false（比如忘了 trim 探针行就直接比长度），
    // 上面「整页装满」那条会绿，但分页会彻底失效 —— 这条专门盯住它。
    for (let i = 0; i < 3; i++) {
      await seedBook({ id: `t7-cur-${i}`, leafName: `C${i}.epub` });
    }

    const page1 = await backfill('?limit=2');
    expect(page1.body).toMatchObject({ scanned: 2, nextAfter: 't7-cur-1' });

    const page2 = await backfill(`?after=${page1.body.nextAfter}&limit=2`);
    // 只剩最后一本 → 页没满，nextAfter 为 null
    expect(page2.body).toMatchObject({ scanned: 1, nextAfter: null });

    // 跳过第一本后从第二本开始扫
    const skippedFirst = await backfill('?after=t7-cur-0&limit=16');
    expect(skippedFirst.body).toMatchObject({ scanned: 2, nextAfter: null });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 三、源码守卫：白名单判定只允许有一份实现
// ══════════════════════════════════════════════════════════════════════

describe('源码守卫：reindex 的白名单判定必须复用同一个函数', () => {
  const SRC = import.meta.glob('../src/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  function srcFile(path: string): string {
    const text = SRC[path];
    if (typeof text !== 'string') throw new Error(`读不到源码：${path}（?raw glob 是否失效？）`);
    return text;
  }

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

  it('哨兵：源码确实读到了（否则下面全是假绿）', () => {
    expect(srcFile('../src/api/admin.ts').length).toBeGreaterThan(1000);
  });

  it('reindex 用的是 isAllowedUploadExt(extensionOf(...))', () => {
    const admin = codeOnly(srcFile('../src/api/admin.ts'));

    // 复用同一个判定函数 —— 全站白名单只有一份实现（历史上网页上传与 WebDAV
    // 各写一份，结果一边拦一边漏，是真实漏洞）。
    expect(admin).toMatch(/!isAllowedUploadExt\(extensionOf\(leafName\)\)/);
    expect(admin).toContain("from '../lib/collections'");
    expect(admin).toContain('isAllowedUploadExt');
  });

  it('reindex 不许自己另写一份白名单判定', () => {
    const admin = codeOnly(srcFile('../src/api/admin.ts'));

    // 直接对着格式数组查、或者内联一张扩展名表，都算另写一份
    expect(admin).not.toContain('ALLOWED_UPLOAD_FORMATS.includes');
    expect(admin).not.toMatch(/FORMAT_MAP\[/);
    // 也不许用「不含点就算合法」这类自造判据
    expect(admin).not.toMatch(/indexOf\('\.'\)\s*[<>]/);
  });

  /**
   * 只取某个函数的正文。
   *
   * 必须限定范围：`rows.length === limit` 这种「页满即还有」的推断在本文件里
   * 还有别的合法用处（`rebucket` 的 `nextOffset` 就是 offset 分页，那种分页
   * 里页满推断是可接受的近似）。全文件级断言会把无辜的函数一起判死。
   */
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    if (start < 0) throw new Error(`找不到函数 ${name}`);
    const rest = source.slice(start + 1);
    const next = rest.indexOf('\nasync function ');
    return next < 0 ? rest : rest.slice(0, next);
  }

  it('nextAfter 由探针（hasMore）决定，不许退回「页满即还有」的推断', () => {
    const fn = codeOnly(functionBody(srcFile('../src/api/admin.ts'), 'backfillDisposition'));

    // 这就是那个假信号的原始写法，退回去必须让测试变红
    expect(fn).not.toContain('rows.length === limit');
    expect(fn).toMatch(/const hasMore = fetched\.length > limit;/);
    expect(fn).toMatch(/const nextAfter = hasMore && last \? last\.id : null;/);
    // 查询必须多取一行当探针
    expect(fn).toMatch(/\.bind\(after, limit \+ 1\)/);
    // 探针行必须在处理前被切掉
    expect(fn).toMatch(/const rows = hasMore \? fetched\.slice\(0, limit\) : fetched;/);
  });
});
