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
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
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
  return SELF.fetch(`${ORIGIN}/api/admin/${path}`, {
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
