
/** 完整 WebDAV Class 2 + MS 扩展 + Depth1 锁 的端到端测试。 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, init);
}

async function seed(leafNames: string[]): Promise<void> {
  const statements = leafNames.map((leaf, i) => {
    const meta = deriveMetadata(leaf);
    return upsertBookStatement(testEnv.DB, {
      id: `test-${i}`,
      leafName: leaf,
      title: meta.title,
      author: meta.author,
      language: null,
      format: meta.format,
      contentType: meta.contentType,
      size: 100,
      sha256: null,
      r2Key: `books/${i}`,
      etag: `etag-${i}`,
      titleLetter: meta.title[0]?.toUpperCase() ?? 'Z',
      authorLetter: 'Z',
      formatBucket: meta.format,
      publishedAt: new Date().toISOString(),
    });
  });
  await testEnv.DB.batch(statements);
  await rebuildBuckets(testEnv.DB);
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(['/']);
});


describe('MS-WebDAV 扩展属性', () => {
  it('PROPFIND 目录返回 isdirectory=1 / iswriteable=1 / maxuploadpacketsize', async () => {
    await seed(['Dune.epub']);
    const res = await dav('/title/D/', { method: 'PROPFIND', headers: { depth: '0' } });
    const xml = await res.text();
    expect(xml).toContain('<D:isdirectory>1</D:isdirectory>');
    expect(xml).toContain('<D:iswriteable>1</D:iswriteable>');
    expect(xml).toContain('<D:maxuploadpacketsize>');
  });

  it('PROPFIND 叶子返回 isdirectory=0', async () => {
    await dav('/recent/Dune.epub', { method: 'PUT', body: 'x' });
    const res = await dav('/recent/Dune.epub', { method: 'PROPFIND', headers: { depth: '0' } });
    const xml = await res.text();
    expect(xml).toContain('<D:isdirectory>0</D:isdirectory>');
  });

  it('supportedlock 宣告 exclusive/write + shared/read', async () => {
    const res = await dav('/title/', { method: 'PROPFIND', headers: { depth: '0' } });
    const xml = await res.text();
    expect(xml).toContain('<D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype>');
    expect(xml).toContain('<D:lockscope><D:shared/></D:lockscope><D:locktype><D:read/></D:locktype>');
  });
});

describe('Depth:1 锁继承', () => {
  it('对目录加 Depth:1 锁后，子文件 PUT → 423', async () => {
    const lockRes = await dav('/recent/', {
      method: 'LOCK',
      headers: { timeout: 'Second-300' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>1</D:depth></D:lockinfo>',
    });
    expect(lockRes.status).toBe(200);

    const put = await dav('/recent/child.epub', { method: 'PUT', body: 'x' });
    expect(put.status).toBe(423);
  });

  it('释放目录锁后子文件 PUT 恢复 201', async () => {
    const lockRes = await dav('/recent/', {
      method: 'LOCK',
      headers: { timeout: 'Second-300' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype><D:depth>1</D:depth></D:lockinfo>',
    });
    expect(lockRes.status).toBe(200);
    const token = lockRes.headers.get('lock-token')!;
    expect(token).toBeTruthy();

    const unlock = await dav('/recent/', { method: 'UNLOCK', headers: { 'lock-token': token } });
    expect(unlock.status).toBe(204);

    const put = await dav('/recent/child2.epub', { method: 'PUT', body: 'x' });
    expect(put.status).toBe(201);
  });
});

describe('PROPFIND 活锁注入 lockdiscovery', () => {
  it('资源被锁时 PROPFIND 返回真实 lockdiscovery（含 token）', async () => {
    // 先 PUT 一个真实存在的叶子
    await dav('/recent/locked.epub', { method: 'PUT', body: 'x' });
    // 对它加锁
    const lockRes = await dav('/recent/locked.epub', {
      method: 'LOCK',
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(lockRes.status).toBe(200);
    const token = lockRes.headers.get('lock-token')!;
    expect(token).toBeTruthy();

    // 对该叶子自身 PROPFIND Depth:0
    const pf = await dav('/recent/locked.epub', { method: 'PROPFIND', headers: { depth: '0' } });
    expect(pf.status).toBe(207);
    const xml = await pf.text();
    if (!xml.includes('<D:lockdiscovery>')) {
      const { testEnv } = await import('./setup');
      const { results } = await testEnv.DB.prepare('SELECT resource, token FROM locks').all();
      throw new Error(`DIAG: pf has no lockdiscovery. token=${token} lockRows=${JSON.stringify(results)}`);
    }
    // lockdiscovery 里的 token 经 XML 转义（< 变 &lt;），所以匹配转义后的形式
    const escapedToken = token.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(xml).toContain(escapedToken);
  });
});
