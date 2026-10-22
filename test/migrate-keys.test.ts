/**
 * `POST /api/admin/migrate-keys` —— 把存量对象从 `books/<id>` 搬到
 * `books/<id>/<书名>`。
 *
 * 这是**唯一会动线上真实数据**的端点（重写 R2 对象 + 更新 D1），所以这个
 * 文件重点不是「功能对不对」，而是**失败时会不会丢数据**：
 *   · 默认不传 apply 时必须一个字节都不写
 *   · 顺序必须是「先写新键、再更新 D1、最后删旧键」
 *   · 元数据必须整体带过去（否则文件会变成 octet-stream）
 *   · 幂等：重复跑不会把已经迁移的再搬一次、也不会删掉新对象
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { letterBucket, authorBucket } from '../src/lib/collections';
import { deriveMetadata } from '../src/lib/metadata';
import { upsertBookStatement } from '../src/lib/db';
import { bookObjectKey, r2HttpMetadata } from '../src/lib/r2';
import { resetLibrary, testEnv } from './setup';

// 与 vitest.config.ts 的 miniflare bindings 一致
const ORIGIN = 'https://webooks.test';
const ADMIN = `Bearer test-token`;

interface MigrateBody {
  action: string;
  apply: boolean;
  cleanup: boolean;
  scanned: number;
  migrated: number;
  alreadyReadable: number;
  orphanCleaned: number;
  missing: number;
  failed: number;
  bytesMoved: number;
  nextAfter: string | null;
  failures: Array<{ id: string; leafName: string; error: string }>;
  plan?: Array<{ id: string; from: string; to: string }>;
  note: string;
}

async function migrate(query = ''): Promise<MigrateBody> {
  const res = await SELF.fetch(`${ORIGIN}/api/admin/migrate-keys${query}`, {
    method: 'POST',
    headers: { authorization: ADMIN },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as MigrateBody;
}

/** 造一本**旧键**的书：D1 的 r2_key 是 `books/<id>`，R2 里也只有旧对象。 */
async function seedLegacyBook(id: string, leafName: string, body = 'EPUB-BYTES'): Promise<string> {
  const meta = deriveMetadata(leafName);
  const legacyKey = `books/${id}`;
  const bytes = new TextEncoder().encode(body).byteLength;

  await upsertBookStatement(testEnv.DB, {
    id,
    leafName,
    title: meta.title,
    author: meta.author,
    language: null,
    format: meta.format,
    contentType: meta.contentType,
    size: bytes,
    sha256: null,
    r2Key: legacyKey,
    etag: `etag-${id}`,
    titleLetter: letterBucket(meta.title),
    authorLetter: authorBucket(meta.author),
    formatBucket: meta.format,
    publishedAt: new Date().toISOString(),
  }).run();

  // 用真实写入路径的元数据，模拟存量对象（它们本来就带 disposition）
  await testEnv.BUCKET.put(legacyKey, body, { httpMetadata: r2HttpMetadata(leafName) });
  return legacyKey;
}

async function dbKeyOf(id: string): Promise<string | undefined> {
  const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE id = ?')
    .bind(id)
    .first<{ r2_key: string }>();
  return row?.r2_key;
}

beforeEach(async () => {
  await resetLibrary();
});

describe('migrate-keys：默认是预演，不许写', () => {
  it('不传 apply 时：一个对象都不搬、D1 不动、R2 不变', async () => {
    const legacy = await seedLegacyBook('m001', '三体.epub');
    const before = await testEnv.BUCKET.head(legacy);
    expect(before).not.toBeNull();

    const body = await migrate();

    // 统计上「看起来要迁移 1 本」
    expect(body.apply).toBe(false);
    expect(body.migrated).toBe(1);
    expect(body.plan).toHaveLength(1);
    const planned = body.plan![0]!;
    expect(planned.from).toBe('books/m001');
    expect(planned.to).toBe('books/m001/三体.epub');

    // 但实际什么都没动 —— 这是这个端点最重要的性质
    expect(await dbKeyOf('m001')).toBe(legacy);
    expect(await testEnv.BUCKET.head(legacy)).not.toBeNull();
    expect(await testEnv.BUCKET.head('books/m001/三体.epub')).toBeNull();
  });
});

describe('migrate-keys：apply=1 真正迁移', () => {
  it('搬到可读键、D1 指向新键、旧对象被删除、内容不变', async () => {
    const legacy = await seedLegacyBook('m002', '三体.epub', 'CONTENT-V1');

    const body = await migrate('?apply=1');

    expect(body.apply).toBe(true);
    expect(body.migrated).toBe(1);
    expect(body.failed).toBe(0);

    const wantKey = 'books/m002/三体.epub';
    // D1 指向新键
    expect(await dbKeyOf('m002')).toBe(wantKey);
    // 新对象在、内容一致
    const moved = await testEnv.BUCKET.get(wantKey);
    expect(await moved!.text()).toBe('CONTENT-V1');
    // 旧对象已删除（不是孤儿）
    expect(await testEnv.BUCKET.head(legacy)).toBeNull();
  });

  it('元数据必须整体带过去：Content-Type 与下载名都不能丢', async () => {
    // 这是最容易写错的一处：put 会用新 httpMetadata **整体替换**旧值。
    // 只搬字节就会出现「文件变成 octet-stream、下载名叫随机 id」——
    // 比不迁移更糟，而且不会报错。
    await seedLegacyBook('m003', '百年孤独.epub');
    await migrate('?apply=1');

    const head = await testEnv.BUCKET.head('books/m003/百年孤独.epub');
    expect(head).not.toBeNull();
    expect(head!.httpMetadata?.contentType).toBe('application/epub+zip');
    expect(head!.httpMetadata?.contentDisposition).toContain('attachment');
    expect(head!.httpMetadata?.contentDisposition).toContain('%E7%99%BE%E5%B9%B4%E5%AD%A4%E7%8B%AC');
  });

  it('453 本那种键里含空格/中文的名字也能正确编码往返', async () => {
    await seedLegacyBook('m004', '灌篮高手 Vol.01.cbz');
    await migrate('?apply=1');
    const key = await dbKeyOf('m004');
    expect(key).toBe('books/m004/灌篮高手 Vol.01.cbz');
    expect(await testEnv.BUCKET.head(key!)).not.toBeNull();
  });
});

describe('migrate-keys：幂等与边界', () => {
  it('重复跑不会重复搬，也不会把新对象删掉', async () => {
    await seedLegacyBook('m005', '活着.epub');
    await migrate('?apply=1');
    const key1 = await dbKeyOf('m005');

    const second = await migrate('?apply=1');
    expect(second.migrated).toBe(0);
    expect(second.alreadyReadable).toBe(1);
    // 键没变、对象还在
    expect(await dbKeyOf('m005')).toBe(key1);
    expect(await testEnv.BUCKET.head(key1!)).not.toBeNull();
  });

  it('已经是可读键的书直接跳过（不计入 migrated）', async () => {
    const want = bookObjectKey('m006', '新书.epub');
    const meta = deriveMetadata('新书.epub');
    await upsertBookStatement(testEnv.DB, {
      id: 'm006', leafName: '新书.epub', title: meta.title, author: meta.author,
      language: null, format: meta.format, contentType: meta.contentType, size: 3,
      sha256: null, r2Key: want, etag: 'e', titleLetter: letterBucket(meta.title),
      authorLetter: authorBucket(meta.author), formatBucket: meta.format,
      publishedAt: new Date().toISOString(),
    }).run();
    await testEnv.BUCKET.put(want, 'abc', { httpMetadata: r2HttpMetadata('新书.epub') });

    const body = await migrate('?apply=1');
    expect(body.migrated).toBe(0);
    expect(body.alreadyReadable).toBe(1);
    expect(await dbKeyOf('m006')).toBe(want);
  });

  it('D1 有行但 R2 没对象时计入 missing，不算失败', async () => {
    const legacy = await seedLegacyBook('m007', '孤行.epub');
    await testEnv.BUCKET.delete(legacy); // 制造数据不一致

    const body = await migrate('?apply=1');
    expect(body.missing).toBe(1);
    expect(body.migrated).toBe(0);
    expect(body.failed).toBe(0);
  });

  it('分页：带 after 时只处理后面那部分', async () => {
    await seedLegacyBook('m010', '书甲.epub');
    await seedLegacyBook('m011', '书乙.epub');
    await seedLegacyBook('m012', '书丙.epub');

    const page1 = await migrate('?apply=1&limit=2');
    expect(page1.scanned).toBe(2);
    expect(page1.migrated).toBe(2);
    expect(page1.nextAfter).toBe('m011');

    const page2 = await migrate(`?apply=1&limit=2&after=${page1.nextAfter}`);
    expect(page2.scanned).toBe(1);
    expect(page2.migrated).toBe(1);
    expect(page2.nextAfter).toBeNull();
  });

  it('幂等探针：页满但后面没数据时 nextAfter 必须为 null', async () => {
    // 与 backfill-disposition 同一个坑：用 rows.length === limit 推断
    // 「还有下一页」会让客户端白打一次请求。这里用多查一行避免。
    await seedLegacyBook('m020', '唯一.epub');
    const body = await migrate('?apply=1&limit=1');
    expect(body.scanned).toBe(1);
    expect(body.nextAfter, '刚好一页整时不该报还有下一页').toBeNull();
  });
});

describe('migrate-keys：写入顺序（这条靠源码结构守，不能靠行为）', () => {
  it('put 新键必须**早于** delete 旧键 —— 顺序反了就会丢数据', () => {
    // ⚠️ 为什么这条读源码而不是跑行为：
    //    变异测试实测过 —— 把 `delete` 提前到 `put` 之前，上面**全部 11 条
    //    行为用例依然全绿**。因为正常路径里 `source` 已经读进内存了，先删
    //    再写照样能写成功，行为上看不出差别。
    //
    //    但真实代价在**异常路径**上：
    //      · put 抛错（R2 限流 / 网络中断）→ 旧对象已被删 → **书没了**；
    //      · 读到一半进程被回收 → 同上；
    //      · 并发：另一个请求正按旧键 GET，对象消失 → 404。
    //    正确顺序下最坏结果是「旧对象变孤儿」（占空间但可读），
    //    而不是「数据丢失」。孤儿可以用 cleanup=1 清掉，丢失不可逆。
    //
    //    行为测试抓不到，就只能钉结构 —— 这类「顺序即安全」的地方，
    //    结构断言比行为断言更诚实。
    // 与 admin-reindex-safety.test.ts 同一套源码读取方式（Worker 里没有 node:fs）
    const SRC = import.meta.glob('../src/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const src = SRC['../src/api/admin.ts'] ?? '';
    expect(src.length, '?raw glob 失效了').toBeGreaterThan(1000);
    const start = src.indexOf('async function migrateKeys');
    expect(start, '找不到 migrateKeys 函数').toBeGreaterThan(-1);
    // 函数体到下一个顶层 async function 为止（admin.ts 里函数之间没有嵌套）
    const rest = src.slice(start);
    const end = rest.indexOf('\nasync function ', 10);
    const body = end > 0 ? rest.slice(0, end) : rest;

    const putAt = body.indexOf('env.BUCKET.put(wantKey');
    const delOldAt = body.indexOf('env.BUCKET.delete(row.r2_key)');
    expect(putAt, 'migrateKeys 里找不到写新键的 put').toBeGreaterThan(-1);
    expect(delOldAt, 'migrateKeys 里找不到删旧键的 delete').toBeGreaterThan(-1);
    expect(putAt, 'put 必须在 delete 旧键之前（顺序反了，一次 put 失败就是永久丢书）')
      .toBeLessThan(delOldAt);

    // D1 指向新键也必须早于删旧键：否则中间窗口里这本书指向一个不存在的键
    const updateAt = body.indexOf('UPDATE books SET r2_key');
    expect(updateAt).toBeGreaterThan(-1);
    expect(updateAt, 'D1 更新必须在删除旧对象之前').toBeLessThan(delOldAt);
  });
});

describe('migrate-keys：安全护栏', () => {
  it('没有 admin token 时 403，且不会改任何东西', async () => {
    await seedLegacyBook('m030', '受保护.epub');
    const res = await SELF.fetch(`${ORIGIN}/api/admin/migrate-keys?apply=1`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await dbKeyOf('m030')).toBe('books/m030');
  });

  it('covers/ 与 uploads/ 的脏数据不被当成书搬走', async () => {
    await seedLegacyBook('m031', '正常.epub');
    // 直接把某行的 r2_key 改成封面键（模拟脏数据）
    await testEnv.DB.prepare(`UPDATE books SET r2_key = 'covers/xxx.jpg' WHERE id = 'm031'`).run();

    const body = await migrate('?apply=1');
    expect(body.migrated).toBe(0);
    // 封面对象即便存在也不该被搬
    expect(await dbKeyOf('m031')).toBe('covers/xxx.jpg');
  });
});
