/**
 * `POST /api/upload/complete` 的条目缓存失效回归测试。
 *
 * ── 为什么需要这个测试（联调实录抓出来的真实错配）───────────────────
 *   上传页文案承诺「传完立刻能在 WebDAV 客户端与浏览器书架里看到」，
 *   但 complete 原来只失效榜单缓存（/api/credits），**没有失效
 *   PROPFIND 条目缓存**。于是：预热过缓存的目录在 PROPFIND_TTL
 *   （默认 300s）内一直返回旧列表 —— 新书最长 5 分钟不可见。
 *
 *   单元测试抓不到它，因为测试之间 resetLibrary() 会清掉全部缓存；
 *   只有「先预热、再 complete、不清缓存、立刻再查」这个顺序才暴露
 *   （真浏览器联调 scripts/joint-debug.mjs 的原始复现）。
 *
 *   WebDAV PUT 早就有同款测试盯着（webdav.test.ts「PUT 后父列表的
 *   缓存立刻失效」）—— 网页上传是第二个写入口，同样的性质同样要钉。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

function propfind(path: string, depth: '0' | '1'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'PROPFIND',
    headers: { depth },
  });
}

async function complete(key: string, filename: string, size: number): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/upload/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, filename, size, credit: '联调测试' }),
  });
}

beforeEach(async () => {
  await resetLibrary();
});

/** XML 里的 href 是百分号编码的（%E5%9B%9E…）—— 断言要用编码后的形态 */
function enc(name: string): string {
  return encodeURIComponent(name);
}

describe('complete 必须失效它影响的条目缓存（上传页承诺「传完立刻能看到」）', () => {
  it('预热过的「最近收录」列表在 complete 后立刻出现新书', async () => {
    // ① 先把空列表写进缓存（模拟用户正开着目录页/同步客户端刚列过目录）
    const before = await propfind(`/dav/${enc('最近收录')}/`, '1');
    expect(before.headers.get('x-dav-cache')).toBe('MISS');
    expect((await before.text()).includes(enc('回归.epub'))).toBe(false);

    // ② 模拟浏览器直传已完成：对象已在 uploads/ 暂存区
    await testEnv.BUCKET.put('uploads/20260101/abc/回归.epub', 'EPUB-BYTES');

    // ③ complete 落库（真实写路径）
    const res = await complete('uploads/20260101/abc/回归.epub', '回归.epub', 10);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    // ④ 不清任何缓存，立刻再 PROPFIND —— 必须能看到新书。
    //    修复前：这里命中旧缓存，新书缺席（文案与行为矛盾）。
    const after = await propfind(`/dav/${enc('最近收录')}/`, '1');
    const xml = await after.text();
    expect(xml.includes(enc('回归.epub')), 'complete 后预热缓存里看不到新书').toBe(true);
  });

  it('新书的叶子路径在按书名集合的分桶下同样立刻可见', async () => {
    // complete 影响五个集合（按书名/作者/格式/最近/根），bookCacheTargets()
    // 返回全部路径。抽查按书名集合的分桶列表 + 叶子本身：
    // 任何一个入口还指旧数据就是漏失效。
    //
    // ⚠️ 必须先预热再 complete：不预热的路径第一次查询本来就会回源，
    //    缓存失效与否在那种顺序下不可判（变异测试实测过：不预热时
    //    删掉 purgeEntries 这条依然绿 —— 假阴性）。
    const warmTitle = await propfind(`/dav/${enc('按书名')}/K/`, '1');
    expect(warmTitle.headers.get('x-dav-cache')).toBe('MISS');
    await warmTitle.text();
    const warmFormat = await propfind(`/dav/${enc('按格式')}/epub/`, '1');
    await warmFormat.text();

    await testEnv.BUCKET.put('uploads/20260101/abc/可见性.epub', 'EPUB-BYTES');
    const res = await complete('uploads/20260101/abc/可见性.epub', '可见性.epub', 10);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; title: string };
    expect(json.ok).toBe(true);

    // 「可见性」的拼音首字母是 K —— 按书名/K/ 分桶列表
    const byTitle = await propfind(`/dav/${enc('按书名')}/K/`, '1');
    const xml = await byTitle.text();
    expect(xml.includes(enc('可见性.epub')), '按书名/K/ 分桶里看不到新书').toBe(true);

    // 按格式集合的 epub 分桶
    const byFormat = await propfind(`/dav/${enc('按格式')}/epub/`, '1');
    const xml2 = await byFormat.text();
    expect(xml2.includes(enc('可见性.epub')), '按格式/epub/ 分桶里看不到新书').toBe(true);
  });

  it('失效范围正确：complete 不做无差别的全量清空（代价控制）', async () => {
    // ⚠️ 反向断言：bookCacheTargets 只针对新书自己的路径。
    // 这里预热一个**与新书无关**的缓存条目，complete 之后它应当**仍然 HIT**
    // —— 证明失效是精准的，不是 purgeByPrefixes 那种全清（那会把
    // Cache API 调用次数放大到不可控）。
    const warmup = await propfind(`/dav/${enc('按作者')}/L/`, '0');
    expect(warmup.headers.get('x-dav-cache')).toBe('MISS');
    await warmup.text();

    await testEnv.BUCKET.put('uploads/20260101/abc/代价控制.epub', 'EPUB-BYTES');
    // 「代价控制」的作者是 null → 匿名桶不落在按作者/L/ 下
    const res = await complete('uploads/20260101/abc/代价控制.epub', '代价控制.epub', 10);
    expect(res.status).toBe(200);

    const unrelated = await propfind(`/dav/${enc('按作者')}/L/`, '0');
    expect(
      unrelated.headers.get('x-dav-cache'),
      '与新书无关的缓存条目不该被 complete 清掉（失效必须精准）',
    ).toBe('HIT');
  });
});
