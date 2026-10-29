/**
 * 分类体系测试：拼音分桶、按类型、以及「规则变更后重算存量数据」。
 *
 * 最后一条尤其重要：分类规则改了（中文从 other 改成拼音首字母）之后，
 * **已存在的书不会自动跟上** —— 必须由 rebucket 重算，
 * 否则新功能上线了但按书名浏览仍然只有一个 other 桶，看起来像没生效（真实踩过）。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { authorBucket, letterBucket, mediaKindOfFormat, normaliseFormat } from '../src/lib/collections';
import {
  adjustBuckets,
  bucketDeltas,
  bucketIdentityOf,
  deleteBook,
  rebuildBuckets,
  upsertBook,
  upsertBookStatement,
} from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const COL = encodeURIComponent('按书名');
const KIND = encodeURIComponent('按类型');

async function seed(leafNames: string[], opts: { legacyLetter?: string } = {}): Promise<void> {
  const statements = leafNames.map((leaf, i) => {
    const meta = deriveMetadata(leaf);
    return upsertBookStatement(testEnv.DB, {
      id: `cl-${i}`,
      leafName: leaf,
      title: meta.title,
      author: meta.author,
      language: null,
      format: meta.format,
      contentType: meta.contentType,
      size: 1024,
      sha256: null,
      r2Key: `books/cl-${i}`,
      etag: `e-${i}`,
      // legacyLetter 用来模拟「拼音规则上线前入库的老数据」
      titleLetter: opts.legacyLetter ?? letterBucket(meta.title),
      authorLetter: opts.legacyLetter ?? authorBucket(meta.author),
      formatBucket: meta.format,
      publishedAt: new Date().toISOString(),
    });
  });
  await testEnv.DB.batch(statements);
  await rebuildBuckets(testEnv.DB);
}

function propfind(path: string, depth = '1'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    method: 'PROPFIND',
    headers: { depth, 'content-type': 'application/xml' },
    body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
  });
}

function admin(path: string): Promise<Response> {
  // 2026-10-28：破坏性/写动作改成**只接受 POST**（S5：GET 可被
  // <img src> 或预取零交互触发）。这里统一用 POST。
  return SELF.fetch(`${ORIGIN}/api/admin/${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  });
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(['/', '/按书名/', '/按类型/', '/按格式/']);
});

describe('拼音分桶（中文书不再堆在 other）', () => {
  it('中文书名按拼音首字母进入对应桶', async () => {
    await seed(['三体.epub', '呐喊.epub', '活着.epub']);
    const res = await propfind('/按书名/');
    const xml = await res.text();
    for (const b of ['S', 'N', 'H']) {
      expect(xml, `${b} 桶`).toContain(`<D:href>/dav/${COL}/${b}/</D:href>`);
    }
    expect(xml).not.toContain(encodeURIComponent('其他'));
  });

  it('作者也按拼音分桶', async () => {
    // 命名约定是「作者 - 书名」（见 deriveMetadata）
    await seed(['刘慈欣 - 三体.epub', '东野圭吾 - 解忧杂货店.epub']);
    const res = await propfind('/按作者/');
    const xml = await res.text();
    expect(xml).toContain('L'); // 刘慈欣
    expect(xml).toContain('D'); // 东野圭吾
  });
});

describe('按类型集合', () => {
  it('电子书与漫画分到不同桶', async () => {
    await seed(['三体.epub', '航海王.cbz']);
    const nav = await propfind('/按类型/');
    const xml = await nav.text();
    expect(xml).toContain(`<D:href>/dav/${KIND}/ebook/</D:href>`);
    expect(xml).toContain(`<D:href>/dav/${KIND}/comic/</D:href>`);
    expect(xml).toContain('<D:displayname>漫画</D:displayname>');
    expect(xml).toContain('<D:displayname>电子书</D:displayname>');

    const comic = await propfind('/按类型/comic/');
    const comicXml = await comic.text();
    expect(comicXml).toContain(encodeURIComponent('航海王.cbz'));
    expect(comicXml).not.toContain(encodeURIComponent('三体.epub'));
  });

  it('kind_bucket 由 format_bucket 自动派生（调用方不会忘记传）', async () => {
    await seed(['a.cbz']);
    const row = await testEnv.DB
      .prepare(`SELECT kind_bucket FROM books WHERE leaf_name = 'a.cbz'`)
      .first<{ kind_bucket: string }>();
    expect(row?.kind_bucket).toBe('comic');
    expect(mediaKindOfFormat(normaliseFormat('cbz'))).toBe('comic');
  });
});

describe('rebucket：规则变更后重算存量数据', () => {
  it('把停在 other 的老数据重算到拼音桶', async () => {
    // 模拟拼音规则上线前入库的书：title_letter 全是 other
    await seed(['三体.epub', '活着.epub'], { legacyLetter: 'other' });

    // 重算前：只有 other 桶
    const before = await (await propfind('/按书名/')).text();
    expect(before).toContain(encodeURIComponent('其他'));
    expect(before).not.toContain(`<D:href>/dav/${COL}/S/</D:href>`);

    await clearDavCache(['/', '/按书名/']);
    const res = await admin('rebucket');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scanned: number; changed: number; nextOffset: number | null };
    expect(json.scanned).toBe(2);
    expect(json.changed).toBe(2);
    expect(json.nextOffset).toBeNull();

    // 重算后：出现 S / H 桶，且没有 other
    const after = await (await propfind('/按书名/')).text();
    expect(after).toContain(`<D:href>/dav/${COL}/S/</D:href>`);
    expect(after).toContain(`<D:href>/dav/${COL}/H/</D:href>`);
    expect(after).not.toContain(encodeURIComponent('其他'));
  });

  it('没有变化时不写库（省 D1 写入额度）', async () => {
    await seed(['三体.epub']);
    await clearDavCache(['/', '/按书名/']);
    const res = await admin('rebucket');
    const json = (await res.json()) as { scanned: number; changed: number };
    expect(json.scanned).toBe(1);
    expect(json.changed).toBe(0); // 入库时已按新规则算过，无需再改
  });

  it('默认不动 type：不能用扩展名覆盖内容嗅探的结果', async () => {
    // 扫描漫画 PDF：内容嗅探出 comic，但扩展名是 pdf（按扩展名会判成 ebook）。
    // rebucket 若不保护这个值，就会把正确的分类打回错误的（真实踩过）。
    await seed(['三体.epub']);
    await testEnv.DB.prepare(`UPDATE books SET kind_bucket = 'comic' WHERE leaf_name = '三体.epub'`).run();
    await clearDavCache(['/', '/按书名/']);

    const json = (await (await admin('rebucket')).json()) as { changed: number };
    expect(json.changed).toBe(0);

    const row = await testEnv.DB
      .prepare(`SELECT kind_bucket FROM books WHERE leaf_name = '三体.epub'`)
      .first<{ kind_bucket: string }>();
    expect(row?.kind_bucket, '内容嗅探出的类型必须被保留').toBe('comic');
  });

  it('需要管理员口令', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/rebucket`);
    expect(res.status).toBe(403);
  });

  it('支持分页（limit=1 时返回 nextOffset）', async () => {
    await seed(['三体.epub', '活着.epub'], { legacyLetter: 'other' });
    await clearDavCache(['/', '/按书名/']);
    const res = await admin('rebucket?limit=1');
    const json = (await res.json()) as { scanned: number; nextOffset: number | null };
    expect(json.scanned).toBe(1);
    expect(json.nextOffset).toBe(1);

    const second = await admin('rebucket?limit=1&offset=1');
    const json2 = (await second.json()) as { scanned: number; nextOffset: number | null };
    expect(json2.scanned).toBe(1);
    // 取满一页时无法断定后面还有没有，所以仍给出 nextOffset；
    // 再取一页拿到 0 条才算到底。
    expect(json2.nextOffset).toBe(2);

    const third = await admin('rebucket?limit=1&offset=2');
    const json3 = (await third.json()) as { scanned: number; nextOffset: number | null };
    expect(json3.scanned).toBe(0);
    expect(json3.nextOffset).toBeNull();
  });
});

/**
 * 查询计划的回归防线。
 *
 * D1 按「扫描行数」计费，所以「有没有走对索引」直接决定这个项目能不能
 * 在免费额度内跑住 —— 它不是微优化，而是核心约束。
 *
 * 两处曾经退化（都由 sqlite 复刻真实索引后 EXPLAIN QUERY PLAN 实测确认）：
 *
 *   1. `/最近收录/`：idx_books_recent(published_at) 无法与
 *      `status='published'` 组合 → 退化成 idx_books_status（匹配全部 N 行）
 *      + USE TEMP B-TREE FOR ORDER BY → **rows_read = N**
 *      20,000 本时仅 250 次缓存未命中就会打满 D1 的 500 万行/天额度，
 *      而 budget.mjs 一直假设恒定 200 行。
 *      修复：idx_books_recent2(status, published_at DESC, id)（迁移 0005）
 *
 *   2. allLiveLocks：idx_locks_resource 的前导列是 resource，
 *      而查询只按 expires_at 过滤 → 前导列用不上 → SCAN locks
 *      修复：idx_locks_expiry(expires_at)（迁移 0005）
 *
 * 这里断言的是**索引存在**，而不是执行计划本身 ——
 * D1（SQLite 兼容层）的计划可能与本地 sqlite 有细微差别，
 * 但「该有的索引在不在」是稳定且可断言的事实。
 */
describe('查询计划依赖的索引', () => {
  it('idx_books_recent2 存在且前导列是 status', async () => {
    const rows = await testEnv.DB
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='books'`)
      .all<{ name: string; sql: string }>();
    const byName = new Map(rows.results.map((r) => [r.name, r.sql ?? '']));

    expect(byName.has('idx_books_recent2'), 'migrations/0005 必须已应用').toBe(true);
    const sql = byName.get('idx_books_recent2')!.replace(/\s+/g, ' ');
    // 前导列必须是 status，否则退化成对全部 published 行排序
    expect(sql).toMatch(/ON books\s*\(\s*status/);
    expect(sql).toContain('published_at');
  });

  it('idx_locks_expiry 存在（allLiveLocks 只按 expires_at 过滤）', async () => {
    const rows = await testEnv.DB
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='locks'`)
      .all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    // idx_locks_resource 的前导列是 resource，对 expires_at 过滤毫无帮助
    expect(names).toContain('idx_locks_expiry');
    expect(names).toContain('idx_locks_resource');
  });

  it('/最近收录/ 的查询确实能返回最新的一批', async () => {
    // 索引不能只「存在」还得能用：写入几条不同 published_at 的书，
    // 确认 recent 集合按时间倒序取。
    const now = Date.now();
    // upsertBookStatement 只**构造**语句，返回 D1PreparedStatement，
    // 要用 db.batch 执行 —— 直接 await 它什么都不会发生（写不进去）。
    await testEnv.DB.batch(
      [0, 1, 2].map((i) =>
        upsertBookStatement(testEnv.DB, {
          id: `rec-${i}`,
          leafName: `最近书${i}.epub`,
          title: `最近书${i}`,
          author: null,
          language: null,
          format: 'epub',
          contentType: 'application/epub+zip',
          size: 100,
          sha256: null,
          r2Key: `books/rec-${i}`,
          etag: `e${i}`,
          titleLetter: letterBucket(`最近书${i}`),
          authorLetter: authorBucket(null),
          formatBucket: 'epub',
          publishedAt: new Date(now - i * 60_000).toISOString(),
        }),
      ),
    );
    await rebuildBuckets(testEnv.DB);
    // 必须清缓存：目录条目被缓存 300s，写完书不失效缓存的话
    // PROPFIND 读到的仍是写入前的空列表
    await clearDavCache(['/', '/最近收录/']);

    const res = await SELF.fetch(`${ORIGIN}/dav/最近收录/`, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
    });
    const xml = await res.text();
    expect(res.status).toBe(207);

    // href 里的中文是百分号编码的，所以要比编码后的文件名
    const newest = xml.indexOf(encodeURIComponent('最近书0'));
    const oldest = xml.indexOf(encodeURIComponent('最近书2'));
    expect(newest, '最新的书必须出现在响应里').toBeGreaterThan(-1);
    expect(oldest, '最旧的书也必须出现').toBeGreaterThan(-1);
    expect(newest, '应按 published_at 倒序').toBeLessThan(oldest);
  });
});

/**
 * kind_bucket 的**来源**不能被自动化覆盖（迁移 0006 的回归测试）。
 *
 * kind_bucket 有三种来源，而其中「人工标注」是不可恢复的：
 *   · 内容嗅探在两种真实情况下必然失效 ——
 *     ① PDF 1.5+ 用对象流把字典压起来 → 标记看不到，判不出
 *     ② 带 OCR 层的扫描漫画引入字体资源 → 「零字体」判据直接崩
 *   这两类书只能靠人判断，所以人工标注恰恰是最脆弱的数据。
 *
 * 修复前实测到的静默丢失：
 *   人工把扫描漫画 PDF 标成 comic
 *   → 跑 `POST /api/admin/rebucket?sniff=1` → 变回 ebook
 * 根因是 `kindBucket = sniffed ?? mediaKindOfFormat(...)` 的回退分支
 * **丢弃了原值**而不是保留它。
 */
describe('kind_bucket 来源：人工标注不被覆盖', () => {
  const adminHeaders = { authorization: 'Bearer test-token' };

  async function seedBook(id: string, leaf: string): Promise<void> {
    const meta = deriveMetadata(leaf);
    await upsertBook(testEnv.DB, {
      id,
      leafName: leaf,
      title: meta.title,
      author: meta.author,
      language: null,
      format: 'pdf',
      contentType: 'application/pdf',
      size: 1000,
      sha256: null,
      r2Key: `books/${id}`,
      etag: `e-${id}`,
      titleLetter: letterBucket(meta.title),
      authorLetter: authorBucket(meta.author),
      formatBucket: 'pdf',
      publishedAt: new Date().toISOString(),
    });
  }

  async function kindOf(leaf: string): Promise<{ kind_bucket: string; kind_source: string } | null> {
    return testEnv.DB
      .prepare('SELECT kind_bucket, kind_source FROM books WHERE leaf_name = ?')
      .bind(leaf)
      .first<{ kind_bucket: string; kind_source: string }>();
  }

  it('人工改类型后标记为 manual，并被 rebucket?sniff=1 跳过', async () => {
    await seedBook('ks-1', '人工修正.pdf');

    // 管理员把一本 PDF 标成漫画
    const upd = await SELF.fetch(`${ORIGIN}/api/admin/update`, {
      method: 'POST',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ leafName: '人工修正.pdf', kind: 'comic' }),
    });
    expect(upd.status).toBe(200);
    await upd.text();

    const afterManual = await kindOf('人工修正.pdf');
    expect(afterManual?.kind_bucket).toBe('comic');
    expect(afterManual?.kind_source, '人工改过必须标记为 manual').toBe('manual');

    // 跑 rebucket?sniff=1 —— 修复前这里会把它打回 ebook
    const reb = await SELF.fetch(`${ORIGIN}/api/admin/rebucket?sniff=1`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(reb.status).toBe(200);
    const body = (await reb.json()) as { scanned: number; skippedManual?: number };
    expect(body.scanned).toBeGreaterThan(0);
    // 跳过的数量要报告出来，否则管理员会误以为全都重新判定过
    expect(body.skippedManual, '跳过的书数必须可见，不能静默').toBeGreaterThanOrEqual(1);

    const afterSniff = await kindOf('人工修正.pdf');
    expect(afterSniff?.kind_bucket, '人工标注不能被 sniff 覆盖').toBe('comic');
    expect(afterSniff?.kind_source).toBe('manual');
  });

  it('覆盖上传同一本书也不会重置人工标注', async () => {
    await seedBook('ks-2', '覆盖测试.pdf');
    await SELF.fetch(`${ORIGIN}/api/admin/update`, {
      method: 'POST',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ leafName: '覆盖测试.pdf', kind: 'comic' }),
    }).then((r) => r.text());
    expect((await kindOf('覆盖测试.pdf'))?.kind_bucket).toBe('comic');

    // 重新 PUT 同一本书（已存在 → 204 覆盖，不是 201 新建）
    const put = await SELF.fetch(`${ORIGIN}/dav/最近收录/${encodeURI('覆盖测试.pdf')}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test-write-token' },
      body: '%PDF-1.4 new content',
    });
    expect([201, 204], `PUT 覆盖应返回 201 或 204，实际 ${put.status}`).toContain(put.status);
    await put.text();

    const after = await kindOf('覆盖测试.pdf');
    expect(after?.kind_bucket, '覆盖上传不应把人工标注打回扩展名派生的 ebook').toBe('comic');
    expect(after?.kind_source).toBe('manual');
  });

  it('非人工标注的书仍可被 sniff 覆盖（不能把功能一起禁掉）', async () => {
    await seedBook('ks-3', '普通书.pdf');
    const before = await kindOf('普通书.pdf');
    // 上传路径没做嗅探时应该是 derived
    expect(before?.kind_source).toBe('derived');

    const reb = await SELF.fetch(`${ORIGIN}/api/admin/rebucket?sniff=1`, {
      method: 'POST',
      headers: adminHeaders,
    });
    await reb.text();
    // 普通书会被正常处理（不一定变化，但不能被当成 manual 跳过）
    const after = await kindOf('普通书.pdf');
    expect(after?.kind_source, '非人工标注的书仍应可被自动更新').not.toBe('manual');
  });
});

/**
 * 分桶计数：增量更新 vs 全量重算（等价性测试）。
 *
 * 写路径原本每次都调 rebuildBuckets —— `DELETE FROM buckets` + 5 条
 * `GROUP BY`，每条都扫一遍 books 全表。实测 @5000 本时约 25,000 行读 +
 * 205 行写，而 D1 Free 只有 500 万行读/天、10 万行写/天（都是硬停）。
 * WebDAV PUT 是匿名入口，这条路径的写放大最容易被放大利用。
 *
 * 改成 adjustBuckets（只重算受影响桶）之后，**最怕的是计数漂移**：
 * 增量算错不会报错，只会让导航页的页数慢慢对不上。这类 bug 极难发现，
 * 所以这里用「增量结果必须与全量重算逐桶相同」来断言。
 */
describe('分桶计数：增量与全量等价', () => {
  async function seedMany(n: number): Promise<void> {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      const leaf = `测试书${i}.epub`;
      const title = `测试书${i}`;
      const meta = deriveMetadata(leaf);
      stmts.push(
        upsertBookStatement(testEnv.DB, {
          id: `blk-${i}`,
          leafName: leaf,
          title,
          author: i % 3 === 0 ? '余华' : i % 3 === 1 ? '刘慈欣' : null,
          language: null,
          format: i % 2 === 0 ? 'epub' : 'pdf',
          contentType: 'application/epub+zip',
          size: 100,
          sha256: null,
          r2Key: `books/blk-${i}`,
          etag: `e${i}`,
          titleLetter: letterBucket(title),
          authorLetter: authorBucket(i % 3 === 0 ? '余华' : i % 3 === 1 ? '刘慈欣' : null),
          formatBucket: i % 2 === 0 ? 'epub' : 'pdf',
          publishedAt: new Date().toISOString(),
        }),
      );
      void meta;
    }
    await testEnv.DB.batch(stmts);
  }

  async function snapshot(): Promise<Map<string, number>> {
    const { results } = await testEnv.DB.prepare('SELECT collection, bucket, total FROM buckets').all<{
      collection: string;
      bucket: string;
      total: number;
    }>();
    return new Map((results ?? []).map((r) => [`${r.collection}/${r.bucket}`, r.total]));
  }

  it('新增一本书后，增量结果与全量重算逐桶相同', async () => {
    await seedMany(9);
    await rebuildBuckets(testEnv.DB);
    const before = await snapshot();

    // 用增量路径新增一本
    const id = await upsertBookLike('blk-new', '增量新增.epub', '增量新增', '老舍', 'epub');
    await adjustBuckets(
      testEnv.DB,
      bucketDeltas(null, bucketIdentityOf(id)),
    );
    const incremental = await snapshot();

    // 全量重算作为「正确答案」
    await rebuildBuckets(testEnv.DB);
    const full = await snapshot();

    expect([...incremental.entries()].sort()).toEqual([...full.entries()].sort());
    expect(full.get('recent/all')).toBe(10);
    // 且确实相对 before 增加了
    expect(full.get('recent/all')).toBe((before.get('recent/all') ?? 0) + 1);
  });

  it('删除一本书后，增量结果与全量重算相同（不能减成负数）', async () => {
    await seedMany(5);
    await rebuildBuckets(testEnv.DB);
    const id = await upsertBookLike('blk-del', '待删除.epub', '待删除', null, 'epub');
    await adjustBuckets(testEnv.DB, bucketDeltas(null, bucketIdentityOf(id)));
    await rebuildBuckets(testEnv.DB);
    const before = await snapshot();

    await deleteBook(testEnv.DB, 'blk-del');
    await adjustBuckets(
      testEnv.DB,
      bucketDeltas(bucketIdentityOf(id), null),
    );
    const incremental = await snapshot();

    await rebuildBuckets(testEnv.DB);
    const full = await snapshot();

    expect([...incremental.entries()].sort()).toEqual([...full.entries()].sort());
    expect(
      [...incremental.values()].every((v) => v >= 0),
      '计数不能变成负数',
    ).toBe(true);
    expect(full.get('recent/all')).toBe((before.get('recent/all') ?? 0) - 1);
  });

  it('改分桶（旧桶 -1、新桶 +1），结果与全量重算相同', async () => {
    await seedMany(3);
    const id = await upsertBookLike('blk-mv', '甲书.epub', '甲书', '余华', 'epub');
    await adjustBuckets(testEnv.DB, bucketDeltas(null, bucketIdentityOf(id)));
    await rebuildBuckets(testEnv.DB);

    // 改名 + 改作者 + 改格式 → 三个桶都要迁移
    const before = bucketIdentityOf(id);
    const after = { titleLetter: letterBucket('乙书'), authorLetter: authorBucket('刘慈欣'), formatBucket: 'pdf' };
    await adjustBuckets(testEnv.DB, bucketDeltas(before, after));

    // 直接改 D1 模拟「书的分桶变了」
    await testEnv.DB.prepare('UPDATE books SET title_letter = ?, author_letter = ?, format_bucket = ? WHERE id = ?')
      .bind(after.titleLetter, after.authorLetter, after.formatBucket, 'blk-mv').run();

    const incremental = await snapshot();
    await rebuildBuckets(testEnv.DB);
    const full = await snapshot();

    expect([...incremental.entries()].sort()).toEqual([...full.entries()].sort());
  });

  it('空增量数组是安全的 no-op', async () => {
    await seedMany(3);
    await rebuildBuckets(testEnv.DB);
    const before = await snapshot();
    await adjustBuckets(testEnv.DB, bucketDeltas(null, null));
    expect(await snapshot()).toEqual(before);
  });

  /** 插入一本书并返回它的分桶身份（便于测试里比对） */
  async function upsertBookLike(
    id: string,
    leaf: string,
    title: string,
    author: string | null,
    format: string,
  ): Promise<{ titleLetter: string; authorLetter: string; formatBucket: string }> {
    await upsertBook(testEnv.DB, {
      id,
      leafName: leaf,
      title,
      author,
      language: null,
      format,
      contentType: 'application/epub+zip',
      size: 100,
      sha256: null,
      r2Key: `books/${id}`,
      etag: id,
      titleLetter: letterBucket(title),
      authorLetter: authorBucket(author),
      formatBucket: format,
      publishedAt: new Date().toISOString(),
    });
    return { titleLetter: letterBucket(title), authorLetter: authorBucket(author), formatBucket: format };
  }
});
