/**
 * 作者识别优化 + 电子书/漫画精准识别。
 *
 * 两类需求都建立在「实证」而不是猜测上：
 *   · 作者：显式标记优先；`A - B` 用**姓氏表**判断方向
 *     （中文姓名 2-3 字、以常见姓氏开头这一点，比长度可靠得多）
 *   · 漫画：用真实漫画 PDF 的字节特征 —— 零字体 + 每页一图
 *
 * 判不出一律返回 null / 落到「未知作者」桶，**绝不硬猜**：
 * 猜错比不猜更糟（用户会以为分类功能坏了）。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUCKET_RESOLVERS,
  UNKNOWN_AUTHOR_BUCKET,
  authorBucket,
  bucketFromSegment,
  bucketLabel,
  bucketSegment,
} from '../src/lib/collections';
import { sniffEpubLayout } from '../src/lib/epub';
import { sniffPdfLayout } from '../src/lib/kind-sniff';
import { deriveMetadata, guessAuthorFromText, normaliseAuthor } from '../src/lib/metadata';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const AUTHOR_COL = encodeURIComponent('按作者');

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(['/', '/按作者/']);
});

describe('作者解析（文件名）', () => {
  it('显式标记优先（无歧义）', () => {
    expect(deriveMetadata('我的老婆是执政官 作者：录事参军.epub').author).toBe('录事参军');
    expect(deriveMetadata('明朝那些事儿 当年明月 著.epub').author).toBe('当年明月');
    expect(deriveMetadata('三体 by 刘慈欣.epub').author).toBe('刘慈欣');
  });

  it('括号里的作者', () => {
    expect(deriveMetadata('搜神记 (干宝).epub').author).toBe('干宝');
    expect(deriveMetadata('[刘慈欣]三体.epub').author).toBe('刘慈欣');
    expect(deriveMetadata('三体【刘慈欣】.epub').author).toBe('刘慈欣');
  });

  it('括号里是说明文字时不当作作者', () => {
    const r = deriveMetadata('毛泽东选集(套装共4册).epub');
    expect(r.author).toBeNull();
    expect(r.title).toContain('毛泽东选集');
  });

  it('「书名 - 作者」与「作者 - 书名」两种约定都能判对', () => {
    // 姓氏表是关键判据：萧/刘/余 是姓，筚/三/活 不是
    expect(deriveMetadata('筚路维艰 - 萧冬连.epub')).toMatchObject({ title: '筚路维艰', author: '萧冬连' });
    expect(deriveMetadata('三体 - 刘慈欣.epub')).toMatchObject({ title: '三体', author: '刘慈欣' });
    expect(deriveMetadata('活著 - 余华.epub')).toMatchObject({ title: '活著', author: '余华' });
    // 反过来（作者在前）也要对：Frank Herbert 像人名，Dune 不像
    expect(deriveMetadata('Frank Herbert - Dune.epub')).toMatchObject({ title: 'Dune', author: 'Frank Herbert' });
  });

  it('多作者只取第一位', () => {
    expect(normaliseAuthor('刘慈欣、韩松')).toBe('刘慈欣');
    expect(normaliseAuthor('刘慈欣 / 韩松')).toBe('刘慈欣');
  });

  it('占位符等同于没有作者', () => {
    for (const s of ['未知', '佚名', '不详', 'none', 'unknown', 'N/A', 'anonymous']) {
      expect(normaliseAuthor(s), s).toBeNull();
    }
  });

  it('猜不到就返回 null，不硬猜', () => {
    expect(deriveMetadata('乱入西游.txt').author).toBeNull();
    expect(deriveMetadata('Dune.epub').author).toBeNull();
  });
});

describe('作者解析（文件内容）', () => {
  it('从 TXT 开头识别「作者：XXX」', () => {
    expect(guessAuthorFromText('书名：神秘复苏\n作者：佛前献花\n\n第一章')).toBe('佛前献花');
    expect(guessAuthorFromText('   张三 著\n\n内容')).toBe('张三');
    expect(guessAuthorFromText('Author: Frank Herbert\n\nChapter 1')).toBe('Frank Herbert');
  });

  it('内容里没有作者信息就返回 null', () => {
    expect(guessAuthorFromText('第一章 风起\n\n正文…')).toBeNull();
    expect(guessAuthorFromText('')).toBeNull();
  });
});

describe('「未知作者」桶', () => {
  it('没有作者时不再拿书名首字母顶替', () => {
    // 以前是 letterBucket(author ?? title)：书会「冒充」成作者姓某字
    expect(BUCKET_RESOLVERS.author({ title: '乱入西游', author: null, format_bucket: 'txt' }))
      .toBe(UNKNOWN_AUTHOR_BUCKET);
    expect(BUCKET_RESOLVERS.author({ title: '三体', author: '  ', format_bucket: 'epub' }))
      .toBe(UNKNOWN_AUTHOR_BUCKET);
    expect(authorBucket(null)).toBe(UNKNOWN_AUTHOR_BUCKET);
    // 有作者时照常按拼音分桶
    expect(authorBucket('刘慈欣')).toBe('L');
  });

  it('路径段显示为中文「未知作者」，且旧的英文 id 仍可解析', () => {
    expect(bucketSegment(UNKNOWN_AUTHOR_BUCKET)).toBe('未知作者');
    expect(bucketFromSegment('未知作者')).toBe(UNKNOWN_AUTHOR_BUCKET);
    expect(bucketFromSegment('unknown')).toBe(UNKNOWN_AUTHOR_BUCKET);
    expect(bucketLabel(UNKNOWN_AUTHOR_BUCKET)).toBe('未知作者');
  });

  it('按作者浏览时，无作者的书集中在「未知作者」目录里', async () => {
    const rows = [
      { leaf: '乱入西游.txt', title: '乱入西游', author: null },
      { leaf: '三体.epub', title: '三体', author: '刘慈欣' },
    ];
    await testEnv.DB.batch(rows.map((r, i) =>
      upsertBookStatement(testEnv.DB, {
        id: `ak-${i}`, leafName: r.leaf, title: r.title, author: r.author, language: null,
        format: 'epub', contentType: 'application/epub+zip', size: 100, sha256: null,
        r2Key: `books/ak-${i}`, etag: `e${i}`,
        titleLetter: 'A', authorLetter: authorBucket(r.author), formatBucket: 'epub',
        publishedAt: new Date().toISOString(),
      }),
    ));
    await rebuildBuckets(testEnv.DB);

    const nav = await SELF.fetch(`${ORIGIN}/dav/按作者/`, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const xml = await nav.text();
    expect(xml).toContain(`<D:href>/dav/${AUTHOR_COL}/${encodeURIComponent('未知作者')}/</D:href>`);
    expect(xml).toContain(`<D:href>/dav/${AUTHOR_COL}/L/</D:href>`);
    expect(xml).toContain('<D:displayname>未知作者</D:displayname>');

    const unknown = await SELF.fetch(`${ORIGIN}/dav/按作者/${encodeURIComponent('未知作者')}/`, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const ux = await unknown.text();
    expect(ux).toContain(encodeURIComponent('乱入西游.txt'));
    expect(ux).not.toContain(encodeURIComponent('三体.epub'));
  });
});

describe('电子书 / 漫画精准识别', () => {
  it('PDF：零字体 + 每页一图 → 漫画（真实漫画 PDF 的字节特征）', () => {
    // 取自用户书库里那本 86MB 的扫描漫画：/Type/Page 17、/Subtype/Image 17、/DCTDecode 17、无字体
    const comic = '/Type/Page /Subtype/Image /DCTDecode '.repeat(17);
    expect(sniffPdfLayout(comic)).toBe('comic');
  });

  it('PDF：有字体资源的文字书 → 电子书', () => {
    const text = '/Type/Page /Type/Font /Type/Font /Type/Font '.repeat(5) + '/Subtype/Image';
    expect(sniffPdfLayout(text)).toBe('text');
  });

  it('PDF：页数与图片数写法带空格也认（PDF 两种写法都合法）', () => {
    expect(sniffPdfLayout('/Type /Page /Subtype /Image /DCTDecode '.repeat(10))).toBe('comic');
  });

  it('PDF：判不出的返回 null，不硬猜', () => {
    expect(sniffPdfLayout('')).toBeNull();
    expect(sniffPdfLayout('%PDF-1.4 很短')).toBeNull();
    // 信号矛盾：每页一张图、却又有 1 个字体 → 说不准，交给扩展名回退
    expect(sniffPdfLayout('/Type/Page /Subtype/Image '.repeat(10) + '/Type/Font')).toBeNull();
    // 信息全无（对象流把字典压缩了）→ 也不猜
    expect(sniffPdfLayout('/Type/ObjStm '.repeat(20))).toBeNull();
  });

  it('EPUB：固定版式声明 → 漫画', () => {
    expect(sniffEpubLayout('<meta property="rendition:layout">pre-paginated</meta>')).toBe('comic');
    expect(sniffEpubLayout('<meta name="fixed-layout" content="true"/>')).toBe('comic');
    expect(sniffEpubLayout('<meta name="original-resolution" content="1200x1800"/>')).toBe('comic');
  });

  it('EPUB：图片项远多于文档项 → 漫画', () => {
    const items = Array.from({ length: 40 }, (_, i) => `<item id="i${i}" media-type="image/jpeg" href="p${i}.jpg"/>`).join('')
      + Array.from({ length: 3 }, (_, i) => `<item id="d${i}" media-type="application/xhtml+xml" href="c${i}.xhtml"/>`).join('');
    expect(sniffEpubLayout(items)).toBe('comic');
  });

  it('EPUB：文字书（章节多、图片少）→ 电子书', () => {
    const items = Array.from({ length: 30 }, (_, i) => `<item id="d${i}" media-type="application/xhtml+xml" href="c${i}.xhtml"/>`).join('')
      + '<item id="cover" media-type="image/jpeg" href="cover.jpg"/>';
    expect(sniffEpubLayout(items)).toBe('text');
  });

  it('EPUB：信息不足 → null', () => {
    expect(sniffEpubLayout('<package></package>')).toBeNull();
    expect(sniffEpubLayout('')).toBeNull();
  });
});

describe('管理后台手动修正（启发式的兜底）', () => {
  function admin(path: string, body?: unknown): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/api/admin/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body ?? {}),
    });
  }

  async function seedOne(leaf: string, title: string, author: string | null, kind = 'ebook') {
    await testEnv.DB.batch([
      upsertBookStatement(testEnv.DB, {
        id: 'fx-1', leafName: leaf, title, author, language: null,
        format: 'pdf', contentType: 'application/pdf', size: 100, sha256: null,
        r2Key: 'books/fx-1', etag: 'e1',
        titleLetter: 'A', authorLetter: authorBucket(author), formatBucket: 'pdf',
        kindBucket: kind, publishedAt: new Date().toISOString(),
      }),
    ]);
    await rebuildBuckets(testEnv.DB);
  }

  it('补填作者：写进 D1 并重算分桶', async () => {
    await seedOne('敖丙传.pdf', '敖丙传', null);
    expect(authorBucket(null)).toBe(UNKNOWN_AUTHOR_BUCKET);

    const res = await admin('update', { leafName: '敖丙传.pdf', author: '饺子' });
    expect(res.status).toBe(200);
    await res.text();

    const row = await testEnv.DB
      .prepare(`SELECT author, author_letter FROM books WHERE leaf_name = '敖丙传.pdf'`)
      .first<{ author: string; author_letter: string }>();
    expect(row?.author).toBe('饺子');
    expect(row?.author_letter).toBe('J');
  });

  it('修正类型：把判错的 PDF 改成漫画', async () => {
    await seedOne('敖丙传.pdf', '敖丙传', null, 'ebook');
    const res = await admin('update', { leafName: '敖丙传.pdf', kind: 'comic' });
    expect(res.status).toBe(200);
    await res.text();
    const row = await testEnv.DB
      .prepare(`SELECT kind_bucket FROM books WHERE leaf_name = '敖丙传.pdf'`)
      .first<{ kind_bucket: string }>();
    expect(row?.kind_bucket).toBe('comic');
  });

  it('拒绝非法类型值', async () => {
    await seedOne('x.pdf', 'x', null);
    const res = await admin('update', { leafName: 'x.pdf', kind: 'virus' });
    expect(res.status).toBe(400);
    await res.text();
  });

  it('不存在的书返回 404；需要管理员口令', async () => {
    const r1 = await admin('update', { leafName: '不存在.pdf', author: '张三' });
    expect(r1.status).toBe(404);
    await r1.text();

    const r2 = await SELF.fetch(`${ORIGIN}/api/admin/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leafName: 'x.pdf', author: '张三' }),
    });
    expect(r2.status).toBe(403);
    await r2.text();
  });
});
