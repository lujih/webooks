/**
 * 目录浏览页（GET /dav/**）的渲染回归测试。
 *
 * 锁住两类真实踩过的问题：
 *   1. 路径没解码 → 页面标题/面包屑显示 %E6%8C%89%E4%B9%A6%E5%90%8D 而不是「按书名」
 *   2. 路径没解码 → 与节点路径（已解码）比较不相等 → **目录把自己也列成子项**
 *   3. 路径规范化没解码 → 锁与缓存键在「中文路径 / 英文路径」之间对不上
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalDavPath, decodeDavPath, letterBucket } from '../src/lib/collections';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const ALL_PATHS = ['/', '/按书名/', '/按书名/其他/', '/最近收录/', '/title/', '/recent/'];

/** 请求目录页（浏览器身份） */
function browse(path: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, { headers: { accept: 'text/html' } });
}

async function seed(leafNames: string[]): Promise<void> {
  const statements = leafNames.map((leaf, i) => {
    const meta = deriveMetadata(leaf);
    return upsertBookStatement(testEnv.DB, {
      id: `bp-${i}`,
      leafName: leaf,
      title: meta.title,
      author: meta.author,
      language: null,
      format: meta.format,
      contentType: meta.contentType,
      size: 100,
      sha256: null,
      r2Key: `books/bp-${i}`,
      etag: `e-${i}`,
      // 必须用 letterBucket：中文书名会进 other 桶，直接取首字符会分错
      titleLetter: letterBucket(meta.title),
      authorLetter: letterBucket(meta.author ?? meta.title),
      formatBucket: meta.format,
      publishedAt: new Date().toISOString(),
    });
  });
  await testEnv.DB.batch(statements);
  await rebuildBuckets(testEnv.DB);
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(ALL_PATHS);
});

describe('canonicalDavPath 处理百分号编码', () => {
  it('编码形式与明文形式归一到同一个键', () => {
    const enc = encodeURIComponent('按书名');
    expect(canonicalDavPath(`/${enc}/`)).toBe('/按书名/');
    expect(canonicalDavPath('/按书名/')).toBe('/按书名/');
    // 英文别名也归一
    expect(canonicalDavPath('/title/')).toBe('/按书名/');
    // 三者必须完全相等，否则锁/缓存会分裂
    expect(canonicalDavPath(`/${enc}/`)).toBe(canonicalDavPath('/title/'));
  });

  it('叶子路径也归一', () => {
    const enc = encodeURIComponent('按书名');
    expect(canonicalDavPath(`/${enc}/其他/${encodeURIComponent('三体.epub')}`))
      .toBe('/按书名/其他/三体.epub');
    expect(canonicalDavPath('/title/other/三体.epub')).toBe('/按书名/其他/三体.epub');
  });

  it('decodeDavPath 还原可读文本', () => {
    expect(decodeDavPath(`/${encodeURIComponent('最近收录')}/`)).toBe('/最近收录/');
    expect(decodeDavPath('/')).toBe('/');
  });
});

describe('目录浏览页渲染', () => {
  it('标题与面包屑显示中文，不显示百分号编码', async () => {
    const res = await browse(`/${encodeURIComponent('按书名')}/`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('按书名');
    // 典型的「没解码」特征：HTML 正文里出现 %E6%8C%89 这种编码
    expect(html).not.toMatch(/>[^<]*%E[0-9A-F]{2}%[0-9A-F]{2}/i);
  });

  it('目录不会把自己列成子项（self 必须被过滤）', async () => {
    await seed(['三体.epub']);
    const res = await browse(`/${encodeURIComponent('按书名')}/S/`);
    const html = await res.text();

    // 面包屑里会提到自己，但卡片网格里不应再出现一次指向自己的「目录」卡
    const selfCards = html.match(/class="card shelfcard"/g) ?? [];
    expect(selfCards.length).toBe(0);
    // 这本书应该出现
    expect(html).toContain('三体');
  });

  it('英文旧路径同样能打开目录页（兼容）', async () => {
    const res = await browse('/title/');
    expect(res.status).toBe(200);
    const html = await res.text();
    // 显示用的是解码后的集合名，而不是路径原文
    expect(html).toContain('按书名');
  });

  it('书名里的特殊字符被转义（防 XSS）', async () => {
    const nasty = '<img src=x onerror=alert(1)>.epub';
    await seed([nasty]);
    // 分桶要按 letterBucket 算（这个书名首字母是 i -> I）
    const bucket = letterBucket(deriveMetadata(nasty).title);
    const res = await browse(`/${encodeURIComponent('按书名')}/${bucket}/`);
    const html = await res.text();
    // 原始标签不能出现在 HTML 里
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('书卡链接是百分号编码的可用 URL', async () => {
    await seed(['三体.epub']);
    const res = await browse(`/${encodeURIComponent('按书名')}/S/`);
    const html = await res.text();
    // href 必须编码（否则中文/特殊字符会破坏链接）；三体按拼音归 S 桶
    expect(html).toMatch(/href="\/dav\/%E6%8C%89%E4%B9%A6%E5%90%8D\/S\/%E4%B8%89%E4%BD%93\.epub"/);
  });

  it('中文书按拼音进入对应首字母桶，而不是全部堆在 other', async () => {
    await seed(['三体.epub', '呐喊.epub', '活着.epub']);
    await clearDavCache(ALL_PATHS);
    const nav = await browse(`/${encodeURIComponent('按书名')}/`);
    const navHtml = await nav.text();
    // 导航应列出 S / N / H 三个桶
    for (const b of ['S', 'N', 'H']) {
      expect(navHtml, `应有 ${b} 桶`).toContain(`href="/dav/${encodeURIComponent('按书名')}/${b}/"`);
    }
    // 不应出现「其他」桶（这批书都能定序）
    expect(navHtml).not.toContain(encodeURIComponent('其他'));

    const s = await browse(`/${encodeURIComponent('按书名')}/S/`);
    expect(await s.text()).toContain('三体');
  });
});
