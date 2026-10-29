/**
 * 安全回归测试 —— 锁住已修复的漏洞，防止回退。
 *
 * 覆盖：
 *   · 安全响应头（HTML 带 CSP，协议响应带 nosniff）
 *   · 封面类型白名单（防任意内容托管到公开域名）
 *   · WebDAV PUT 大小上限（防存储配额耗尽）
 *   · 上传完成接口的文件名清洗（与 WebDAV 一致）
 *   · 过期锁清扫（防 D1 表无限膨胀）
 *   · 匿名 LOCK 阻断写入（可用性 DoS）
 */

/// <reference types="vite/client" />

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweepExpiredLocks } from '../src/lib/locks';
import { davCache } from '../src/lib/cache';
import { guardWrite } from '../src/lib/throttle';
import { DEFAULT_MAX_UPLOAD_BYTES, settings } from '../src/config';
import { safeContentTypeFor } from '../src/lib/metadata';
import { extractTagNames, readDavBody } from '../src/lib/xml';
import { parsePropfindBody } from '../src/webdav/propfind';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

/**
 * 源码快照（`?raw` 导入）。
 *
 * workerd 的 node:fs 是空壳（任何路径 ENOENT），而 `TEST_STATIC_ASSETS`
 * binding 那条通道只为 public/ 与 scripts/ 开 —— 读源码本身用 Vite 的
 * `?raw` 更直接，vitest-pool-workers 里可用且零配置改动。
 * 与 test/download-direct.test.ts 同一写法。
 */
const SRC = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function loadSrc(relFromTest: string): string {
  // 调用方按仓库根写路径（'src/webdav/index.ts'），glob 的键是相对本文件的
  const key = `../${relFromTest}`;
  const src = SRC[key];
  if (!src) {
    throw new Error(`源码快照里没有 ${key}；现有键：${Object.keys(SRC).slice(0, 5).join(', ')}…`);
  }
  return src;
}

beforeEach(async () => {
  await resetLibrary();
});

describe('安全响应头', () => {
  it('HTML 页面带 CSP / nosniff / frame-options / referrer-policy', async () => {
    for (const path of ['/', '/upload']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('referrer-policy'), path).toBeTruthy();
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("object-src 'none'");
    }
  });

  it('WebDAV 协议响应带 nosniff，但不带 CSP（避免客户端误判）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/`, {
      method: 'PROPFIND',
      headers: { depth: '0' },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('JSON 接口带 nosniff', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/turnstile-config`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('WebDAV PUT 大小上限', () => {
  it('声明超过上限时返回 413 且不写库', async () => {
    // 造一个超过上限的请求：只声明 Content-Length，不带真实 body
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/huge.epub`, {
      method: 'PUT',
      headers: { 'content-length': String(300 * 1024 * 1024), 'content-type': 'application/epub+zip' },
      body: 'x',
    });
    expect([413, 400]).toContain(res.status);
  });

  it('正常大小仍可写入（回归）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/normal.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip' },
      body: 'small',
    });
    expect([201, 204]).toContain(res.status);
  });
});

describe('上传完成接口的文件名清洗', () => {
  it('危险字符与超长名被清洗，与 WebDAV 规则一致', async () => {
    const key = 'uploads/2026-01-01/abc123/raw.epub';
    await testEnv.BUCKET.put(key, new TextEncoder().encode('x'), {
      httpMetadata: { contentType: 'application/epub+zip' },
    });

    const nasty = `<script>alert(1)</script>${'A'.repeat(500)}.epub`;
    const res = await SELF.fetch(`${ORIGIN}/api/upload/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, filename: nasty, size: 1, contentType: 'application/epub+zip' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { leafName: string };

    // 尖括号等必须被替换成下划线
    expect(json.leafName).not.toContain('<');
    expect(json.leafName).not.toContain('>');
    // 长度受 sanitiseLeafName 的 200 字符上限约束
    expect(json.leafName.length).toBeLessThanOrEqual(200);
    // 扩展名保留
    expect(json.leafName.endsWith('.epub')).toBe(true);
  });

  it('D1 里存的 leaf_name 也是清洗后的值', async () => {
    const key = 'uploads/2026-01-01/def456/raw2.epub';
    await testEnv.BUCKET.put(key, new TextEncoder().encode('x'), {
      httpMetadata: { contentType: 'application/epub+zip' },
    });
    await SELF.fetch(`${ORIGIN}/api/upload/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, filename: 'bad<>name.epub', size: 1 }),
    });
    const row = await testEnv.DB.prepare(
      `SELECT leaf_name FROM books ORDER BY rowid DESC LIMIT 1`,
    ).first<{ leaf_name: string }>();
    expect(row?.leaf_name).not.toContain('<');
    expect(row?.leaf_name).not.toContain('>');
  });
});

describe('Content-Type 注入防护（存储层）', () => {
  /** 取某本书在 R2 里的实际对象元数据（这才是对外提供的类型） */
  async function storedType(leafName: string): Promise<string> {
    const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE leaf_name = ?')
      .bind(leafName).first<{ r2_key: string }>();
    expect(row?.r2_key, `D1 里找不到 ${leafName}`).toBeTruthy();
    const head = await testEnv.BUCKET.head(row!.r2_key);
    return head?.httpMetadata?.contentType ?? '';
  }

  it('PUT 声明 text/html 时，R2 里存的仍是扩展名推导的安全类型', async () => {
    // 真实漏洞：R2 对外提供的 Content-Type 来自写入时的 httpMetadata，
    // 早期实现信任客户端声明，于是 PUT 一个 Content-Type: text/html 的 .epub
    // 就能让 books.<域名>/books/<id> 以 text/html 返回任意 HTML/JS。
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/xsstest.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><script>alert(1)</script>',
    });
    expect([201, 204]).toContain(res.status);

    const stored = await storedType('xsstest.epub');
    expect(stored).not.toContain('text/html');
    expect(stored).toBe('application/epub+zip');
  });

  it('.html 文件按纯文本存储，不以 text/html 提供', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/page.html`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<h1>hi</h1>',
    });
    expect(await storedType('page.html')).toBe('text/plain; charset=utf-8');
  });

  it('伪造任意类型都被忽略（application/javascript 也不行）', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/tricky.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/javascript' },
      body: 'alert(1)',
    });
    expect(await storedType('tricky.txt')).toBe('text/plain; charset=utf-8');
  });

  it('safeContentTypeFor：未知扩展名退回 application/octet-stream', () => {
    expect(safeContentTypeFor('a.epub')).toBe('application/epub+zip');
    expect(safeContentTypeFor('a.pdf')).toBe('application/pdf');
    expect(safeContentTypeFor('a.html')).toBe('text/plain; charset=utf-8');
    expect(safeContentTypeFor('a.svg')).toBe('application/octet-stream');
    expect(safeContentTypeFor('noext')).toBe('application/octet-stream');
    expect(safeContentTypeFor('weird.xyz')).toBe('application/octet-stream');
  });
});

describe('破坏性操作的写口令保护', () => {
  /** 不带任何凭据的原始请求（path 为完整路径，含 /dav 前缀） */
  function anon(path: string, init: RequestInit = {}): Promise<Response> {
    // redirect: 'manual' —— 否则 fetch 会跟随 GET 叶子的 302 跳到 R2 公开域
    return SELF.fetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  }
  /** 带正确口令 */
  function auth(path: string, init: RequestInit = {}): Promise<Response> {
    return SELF.fetch(`${ORIGIN}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { authorization: 'Bearer test-write-token', ...(init.headers as Record<string, string> | undefined) },
    });
  }
  const put = (body = 'x'): RequestInit => ({
    method: 'PUT',
    headers: { 'content-type': 'application/epub+zip' },
    body,
  });

  it('新书上传保持匿名可用（不能误伤核心功能）', async () => {
    const res = await anon('/dav/recent/newbook.epub', put());
    expect([201, 204]).toContain(res.status);
  });

  it('覆盖已有书：无口令 → 401，且有 WWW-Authenticate（客户端才会弹密码框）', async () => {
    await auth('/dav/recent/existing.epub', put());
    const res = await anon('/dav/recent/existing.epub', put('replaced'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('覆盖已有书：带口令 → 204', async () => {
    await auth('/dav/recent/existing2.epub', put());
    const res = await auth('/dav/recent/existing2.epub', put('replaced'));
    expect(res.status).toBe(204);
  });

  it('带 If-None-Match: * 的「只新建」请求无需口令（它不会改动任何东西）', async () => {
    await auth('/dav/recent/guard.epub', put());
    const res = await anon('/dav/recent/guard.epub', {
      ...put('nope'),
      headers: { 'content-type': 'application/epub+zip', 'if-none-match': '*' },
    });
    expect(res.status).toBe(412); // 已存在 → 前置条件失败，而不是 401
  });

  it('删除：无口令 → 401，且书仍然在', async () => {
    await auth('/dav/recent/keepme.epub', put());
    const del = await anon('/dav/recent/keepme.epub', { method: 'DELETE' });
    expect(del.status).toBe(401);
    const still = await anon('/dav/recent/keepme.epub', { method: 'PROPFIND', headers: { depth: '0' } });
    expect(still.status).toBe(207);
  });

  it('删除：带口令 → 204，书消失', async () => {
    await auth('/dav/recent/deleteme.epub', put());
    const del = await auth('/dav/recent/deleteme.epub', { method: 'DELETE' });
    expect(del.status).toBe(204);
    const gone = await anon('/dav/recent/deleteme.epub', { method: 'PROPFIND', headers: { depth: '0' } });
    expect(gone.status).toBe(404);
  });

  it('改名（MOVE）：无口令 → 401', async () => {
    await auth('/dav/recent/moveme.epub', put());
    const res = await anon('/dav/recent/moveme.epub', {
      method: 'MOVE',
      headers: { destination: `${ORIGIN}/dav/recent/renamed.epub` },
    });
    expect(res.status).toBe(401);
  });

  it('口令错误 → 401（且不能靠长度差异绕过）', async () => {
    await auth('/dav/recent/len.epub', put());
    for (const bad of ['wrong', 'test-write-toke', 'test-write-tokenX']) {
      const res = await SELF.fetch(`${ORIGIN}/dav/recent/len.epub`, {
        ...put('x'),
        headers: { 'content-type': 'application/epub+zip', authorization: `Bearer ${bad}` },
      });
      expect(res.status, bad).toBe(401);
    }
  });

  it('Basic 认证也接受（WebDAV 客户端用这种方式）', async () => {
    await auth('/dav/recent/basic.epub', put());
    const b64 = btoa('anyuser:test-write-token');
    const res = await SELF.fetch(`${ORIGIN}/dav/recent/basic.epub`, {
      ...put('via basic'),
      headers: { 'content-type': 'application/epub+zip', authorization: `Basic ${b64}` },
    });
    expect(res.status).toBe(204);
  });

  it('读操作完全不受口令影响（挂载后能正常浏览）', async () => {
    const created = await auth('/dav/recent/readable.epub', put());
    expect([201, 204]).toContain(created.status);

    // 目录列表可匿名读取
    const pf = await anon('/dav/recent/', { method: 'PROPFIND', headers: { depth: '1' } });
    expect(pf.status).toBe(207);

    // 叶子可匿名下载（302 → R2 公开域）
    const get = await anon('/dav/recent/readable.epub', { method: 'GET' });
    expect(get.status).toBe(302);
    expect(get.headers.get('location')).toContain('/books/');

    // 元数据可匿名读取
    const head = await anon('/dav/recent/readable.epub', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('accept-ranges')).toBe('bytes');
  });

  // ── LOCK 也属于「破坏性操作」（修复：匿名锁 DoS）─────────────────────
  //
  // 修复前 `case 'LOCK'` 是**唯一**既不要求口令、又能改变其他请求命运的
  // 方法。线上实测（Lead 复现）：
  //
  //   匿名 LOCK /dav/按书名/ (Timeout: Second-300, Depth: 1)  → 200 + lock-token
  //   此后匿名 PUT 子路径                                      → 423
  //   一条脚本给 5 个顶层集合各加一把锁                        → 全库 WebDAV 写入瘫痪
  //
  // 写口令挡不住它：`liveLockForResource()` 只按资源路径找活锁、不看 owner，
  // `handleLockedWrite()` 比的是 `If:` 里的锁令牌 —— 与写口令是两套凭据。
  // 所以闸门只有加在**建锁**这一步才有效。
  const LOCK_INFO =
    '<D:lockinfo xmlns:D="DAV:">'
    + '<D:lockscope><D:exclusive/></D:lockscope>'
    + '<D:locktype><D:write/></D:locktype>'
    + '<D:owner>tester</D:owner>'
    + '</D:lockinfo>';

  const lockInit = (extra: Record<string, string> = {}): RequestInit => ({
    method: 'LOCK',
    headers: { 'content-type': 'application/xml', timeout: 'Second-300', depth: '1', ...extra },
    body: LOCK_INFO,
  });

  it('加锁（LOCK）：无口令 → 401，且**真的没有建出锁**', async () => {
    const res = await anon('/dav/recent/', lockInit());
    expect(res.status).toBe(401);
    // 错误响应不该泄漏一把锁令牌
    expect(res.headers.get('lock-token')).toBeNull();
    // 客户端要知道怎么补凭据（与其他破坏性操作一致）
    expect(res.headers.get('www-authenticate')).toBeTruthy();

    // ⚠️ 状态码只是**一半**的断言。必须证明 D1 的 locks 表里真的没有行 ——
    //    「回 401 但顺手把锁建了」这种写法能满足状态码断言却毫无防护。
    const rows = await testEnv.DB.prepare('SELECT token, resource FROM locks').all<{
      token: string; resource: string;
    }>();
    expect(rows.results ?? [], '匿名 LOCK 不该在锁表里留下任何行').toEqual([]);

    // 还要证明资源**没被锁住**：匿名 PUT 新书仍然可写
    const after = await anon('/dav/recent/after-anon-lock.epub', put());
    expect([201, 204]).toContain(after.status);
  });

  it('加锁（LOCK）：带口令 → 200 + Lock-Token（合法客户端没被连带打死）', async () => {
    const res = await auth('/dav/recent/', lockInit());
    expect(res.status, '口令正确时 LOCK 必须照常工作').toBe(200);
    const token = res.headers.get('lock-token');
    expect(token, '§9.10.1 必须回 Lock-Token').toBeTruthy();
    expect(token!).toMatch(/^<urn:uuid:/);

    // 锁确实生效了：子路径匿名 PUT 被 423 挡住
    // （锁的**语义**没变，变的只是「谁能建锁」）
    const blocked = await anon('/dav/recent/while-locked.epub', put());
    expect(blocked.status).toBe(423);

    // UNLOCK **刻意不要求口令**：没有 LOCK 就建不出锁，攻击面已消失；
    // 强加口令会破坏「持锁者释放自己的锁」语义（§9.11 用 token 表达所有权）。
    const unlock = await anon('/dav/recent/', { method: 'UNLOCK', headers: { 'lock-token': token! } });
    expect(unlock.status).toBe(204);

    // 锁释放后写入恢复，且锁表清空（不留残留影响后面的测试）
    const released = await anon('/dav/recent/after-unlock.epub', put());
    expect([201, 204]).toContain(released.status);
    const rows = await testEnv.DB.prepare('SELECT token FROM locks').all();
    expect(rows.results ?? []).toEqual([]);
  });

  it('匿名 LOCK 不影响读路径（PROPFIND 仍 207，锁未泄漏出去）', async () => {
    await anon('/dav/recent/', lockInit());
    const pf = await anon('/dav/recent/', { method: 'PROPFIND', headers: { depth: '0' } });
    expect(pf.status).toBe(207);
    // 修复前匿名 LOCK 成功后，Depth:0 的 PROPFIND 会把 locktoken 公开读出来
    // （拿它带 `If:` 就能绕过 423）—— 现在连锁都建不出来，自然读不到。
    const xml = await pf.text();
    expect(xml).not.toContain('locktoken');
    expect(xml).not.toContain('activelock');
  });

  /**
   * 源码守卫：上面三条是**行为**断言，这条钉住**结构**。
   *
   * 为什么两条都要：行为测试可以用任何方式绕过（比如在别处加一个
   * `if (isLockPath(...))` 的特例），而源码守卫能保证「口令检查就在
   * 建锁的那个分支里」。反过来，源码守卫能防止有人把 LOCK 从
   * `case` 里挪走。
   */
  it('源码守卫：case LOCK 分支必须检查 hasWriteToken，且建锁路径走 guardWrite', async () => {
    const source = await loadSrc('src/webdav/index.ts');
    const start = source.indexOf("case 'LOCK'");
    expect(start, "src/webdav/index.ts 里找不到 case 'LOCK' 分支").toBeGreaterThan(-1);
    const end = source.indexOf("case 'UNLOCK'", start);
    expect(end, "case 'LOCK' 后面应当紧跟着 case 'UNLOCK'").toBeGreaterThan(start);
    const lockCase = source.slice(start, end);
    expect(lockCase, 'LOCK 分支必须先校验写口令').toContain('hasWriteToken');
    expect(lockCase, '未授权要走统一的 401 响应').toContain('unauthorizedResponse');

    // 纵深防御：handleLock 内部还要过 guardWrite（防口令泄漏后的锁表膨胀）
    const fnStart = source.indexOf('async function handleLock(');
    expect(fnStart).toBeGreaterThan(-1);
    const handleLockBody = source.slice(fnStart, source.indexOf('async function handleUnlock(', fnStart));
    expect(handleLockBody, 'handleLock 必须过写节流').toContain('guardWrite');
  });
});

describe('管理后台 API', () => {
  it('无 token 一律 403/404', async () => {
    for (const p of ['/api/admin/books', '/api/admin/stats']) {
      const res = await SELF.fetch(`${ORIGIN}${p}`);
      expect([403, 404]).toContain(res.status);
    }
  });

  it('带 token 可列出书并返回安全状态', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/adminlist.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip', authorization: 'Bearer test-write-token' },
      body: 'x',
    });
    const res = await SELF.fetch(`${ORIGIN}/api/admin/books`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      total: number; books: Array<{ leafName: string }>;
      security: Array<{ key: string; ok: boolean }>;
    };
    expect(json.total).toBeGreaterThan(0);
    expect(json.books.some((b) => b.leafName === 'adminlist.epub')).toBe(true);
    // 安全状态里必须能看到写口令已启用
    expect(json.security.find((s) => s.key === 'writeToken')?.ok).toBe(true);
  });

  it('带 token 可批量删除（同时清理 R2 对象）', async () => {
    await SELF.fetch(`${ORIGIN}/dav/recent/todelete.epub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/epub+zip', authorization: 'Bearer test-write-token' },
      body: 'x',
    });
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: ['todelete.epub'] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deletedCount: number; deleted: string[] };
    expect(json.deletedCount).toBe(1);
    expect(json.deleted).toContain('todelete.epub');

    const row = await testEnv.DB.prepare('SELECT id FROM books WHERE leaf_name = ?')
      .bind('todelete.epub').first();
    expect(row).toBeNull();
  });

  it('删除不存在的书不报错，只在 missing 里列出', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: ['never-existed.epub'] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deletedCount: number; missing: string[] };
    expect(json.deletedCount).toBe(0);
    expect(json.missing).toContain('never-existed.epub');
  });

  // ── 2026-10-28 审查：批量删除曾接受 200 个 leafName，约 17 本即撞 50 子请求上限 ──
  it('批量删除超过单请求上限时整体拒绝（400），一本书都不能少', async () => {
    const names: string[] = [];
    for (let i = 0; i < 9; i++) {
      const leaf = `bulkcap${i}.epub`;
      names.push(leaf);
      await SELF.fetch(`${ORIGIN}/dav/recent/${leaf}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/epub+zip', authorization: 'Bearer test-write-token' },
        body: 'x',
      });
    }
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: names }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; limit: number };
    expect(json.error).toBe('too-many-leaf-names');
    expect(json.limit).toBe(8);

    // 关键：拒绝必须是**整体**的，不能删掉前 8 本
    const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM books WHERE leaf_name LIKE ?')
      .bind('bulkcap%').first<{ n: number }>();
    expect(row?.n, '超限请求不得删除任何书').toBe(9);
  });

  it("fail-closed：未配置 WRITE_TOKEN 时破坏性操作一律拒绝", async () => {
    // 直接测 auth 层（生产配置状态无法在 SELF.fetch 里伪造）
    const { hasWriteToken } = await import('../src/lib/auth');
    const req = new Request(`${ORIGIN}/dav/x.epub`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer anything' },
    });
    // 旧实现 `if (!expected) return true` —— 忘配口令的部署对所有人开放删除。
    expect(hasWriteToken(req, null), '未配置 ≠ 不设防').toBe(false);
    expect(hasWriteToken(req, '')).toBe(false);
    expect(hasWriteToken(req, 'anything')).toBe(true);
    expect(hasWriteToken(req, 'wrong-value')).toBe(false);
  });

  // ── 2026-10-28 审查 S5：口令不得走 URL；破坏性动作必须 POST ──────────────
  it('管理口令只认 Authorization 头：?token= 不再被接受', async () => {
    // 查询参数会进浏览器历史 / 访问日志 / Referer，且能被 <img src> 触发。
    // 旧实现 `bearer || searchParams.get('token')` 两条路等价，这条测试钉死移除。
    const res = await SELF.fetch(`${ORIGIN}/api/admin/stats?token=test-token`);
    expect(res.status, 'URL 里的口令必须被忽略').toBe(403);
  });

  it('破坏性动作只接受 POST：GET /api/admin/delete 返回 405', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete?leafNames=x.epub`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(405);
    const allow = res.headers.get('allow');
    expect(allow).toContain('POST');
  });

  it('只读动作仍然允许 GET（不能把管理页一起禁掉）', async () => {
    for (const p of ['/api/admin/stats', '/api/admin/books', '/api/admin/credits']) {
      const res = await SELF.fetch(`${ORIGIN}${p}`, {
        headers: { authorization: 'Bearer test-token' },
      });
      expect(res.status, `${p} 应当允许 GET`).toBe(200);
    }
  });

  it('/admin 页面可访问，且不带任何敏感数据', async () => {
    const res = await SELF.fetch(`${ORIGIN}/admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // 后台页面绝不能进共享缓存
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).not.toContain('test-token');
    expect(html).not.toContain('test-write-token');
  });
});

describe('过期锁清扫', () => {  it('sweepExpiredLocks 删除过期行、保留活锁', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('<urn:uuid:expired>', '/expired', null, 'exclusive', '0', 1, past, past),
      testEnv.DB.prepare(
        `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind('<urn:uuid:live>', '/live', null, 'exclusive', '0', 300, past, future),
    ]);

    const removed = await sweepExpiredLocks(testEnv.DB);
    expect(removed).toBe(1);

    const rows = await testEnv.DB.prepare('SELECT token FROM locks').all<{ token: string }>();
    expect(rows.results?.map((r) => r.token)).toEqual(['<urn:uuid:live>']);
  });

  it('LOCK 请求会顺带清理过期锁', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind('<urn:uuid:stale>', '/stale', null, 'exclusive', '0', 1, past, past).run();

    await SELF.fetch(`${ORIGIN}/dav/recent/x.epub`, {
      method: 'LOCK',
      // LOCK 现在要求写口令（见 src/webdav/index.ts 分发处的 case 'LOCK'）：
      // 匿名锁能让整棵子树不可写。这条测试验的是「LOCK 顺带清扫过期锁」，
      // 不是「匿名 LOCK 被拒」—— 后者在下面 describe('LOCK 需要写口令') 里。
      // 所以这里只给请求侧补口令头，断言一个字都没放宽。
      headers: { 'content-type': 'application/xml', authorization: 'Bearer test-write-token' },
      body: '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });

    const stale = await testEnv.DB.prepare(`SELECT token FROM locks WHERE token = ?`)
      .bind('<urn:uuid:stale>').first();
    expect(stale).toBeNull();
  });
});

/**
 * 匿名请求的 CPU 消耗（ReDoS 防御）。
 *
 * PROPFIND / PROPPATCH 完全匿名且请求体由攻击者控制，而 Workers Free
 * 只有 10ms CPU/请求。原实现用含嵌套量词的正则提取属性名：
 *
 *   /<(?:ns:)?([A-Za-z][A-Za-z0-9_.-]*)(?:\s[^>]*)?(?:\/>|>[^<]*<\/)/
 *
 * 对「大量 `<a ` 但没有 `>`」的输入，回溯量与长度平方成正比。实测：
 *
 *   6KB → 23ms    12KB → 91ms    24KB → 362ms    48KB → 1448ms
 *
 * 也就是说一个几百 KB 的请求体就足以让单个 Worker 实例长时间不可用，
 * 且不需要任何凭据 —— 这是本项目里最容易触发的 DoS。
 *
 * 修复是双保险：① `readDavBody` 在读取阶段就限长 8KB（同时挡住内存与 CPU）
 * ② 标签提取改成线性扫描。下面两条测试分别锁住这两半。
 */
describe('DAV 请求体：限长 + 线性解析', () => {
  const DAV_BODY_LIMIT = 8 * 1024;

  it('超过上限的请求体被截断（读阶段就挡，不进解析器）', async () => {
    const huge = '<a '.repeat(500000); // ~1.5 MB
    const req = new Request('https://x.test/', { method: 'PROPPATCH', body: huge });
    const { text, truncated } = await readDavBody(req);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(DAV_BODY_LIMIT);
  });

  it('chunked 传输（无 content-length）同样被截断', async () => {
    // 没有 content-length 时只能靠流式截断 —— 这条路径最容易漏
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('y'.repeat(500000)));
        c.close();
      },
    });
    const req = new Request('https://x.test/', {
      method: 'PROPPATCH', body: stream, duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    const { text, truncated } = await readDavBody(req);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(DAV_BODY_LIMIT);
  });

  it('解析耗时不随输入长度二次方增长', () => {
    // 修复前：n=16000（约 48KB）就要 1448ms
    // 修复后应保持线性。阈值取 200ms —— 足以拦住二次方回归，
    // 又不会因为 CI 比边缘慢而误报。
    const adversarial = '<a '.repeat(64000); // 约 192KB
    const t0 = Date.now();
    parsePropfindBody(adversarial);
    const elapsed = Date.now() - t0;
    expect(elapsed, '对抗性输入的解析必须是线性的').toBeLessThan(200);
  });

  it('线性扫描仍要正确识别嵌套标签与命名空间', () => {
    // 换掉正则之后最容易出的错：把标签名读成命名空间前缀（"D"），
    // 或者跳过子树导致 <prop> 里的属性名被吞掉。这两个都曾经真实发生过。
    expect(extractTagNames('<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>'))
      .toEqual(['propfind', 'prop', 'getetag']);
    expect(parsePropfindBody('<D:propfind><D:prop><D:getetag/><D:getcontentlength/></D:prop></D:propfind>'))
      .toEqual({ mode: 'prop', names: ['getcontentlength', 'getetag'] });
    expect(parsePropfindBody('<D:propfind><D:propname/></D:propfind>').mode).toBe('propname');
    expect(parsePropfindBody('<D:propfind><D:allprop/></D:propfind>').mode).toBe('allprop');
  });
});

/**
 * 写节流的覆盖面（回归测试）。
 *
 * 修复前 `allowWrite` 的**唯一**调用点在 handlePut 里，于是：
 *   · 网页上传 /api/upload/init、/complete：零节流
 *   · WebDAV COPY：零节流（分发处注释还写着「走与 PUT 相同的节流即可」）
 * 而 README、docs/security-audit.md、本文件上方的注释都声称
 * 「匿名上传仍有每日写入次数节流兜底」—— 文档声称有防护，代码只做了一半。
 * 这种「假防护」比没有防护更危险：它让评审与运维都以为额度不会被打爆。
 *
 * 现在所有写路径统一走 lib/throttle.ts 的 guardWrite，
 * 并且 guardWrite 只信任 CF-Connecting-IP（不再回落到 X-Forwarded-For，
 * 否则批量通行证的 IP 绑定可被伪造绕过）。
 *
 * 注：vitest.config.ts 里 DAILY_WRITE_QUOTA='0'（测试默认关节流），
 * 所以这里显式传 limit 来验证逻辑本身。
 */
describe('写节流：覆盖面与 IP 来源', () => {
  /**
   * 清掉节流计数。
   *
   * 不能用 `cache.keys()` —— workerd 的 Cache 没实现这个方法（实测抛
   * "the method is not implemented"）。节流键的格式是确定的
   * （见 lib/throttle.ts 的 allowWrite），所以按 IP 直接构造键来删。
   */
  const HOST = 'https://webooks.invalid';
  const today = () => new Date().toISOString().slice(0, 10);

  async function clearThrottle(ips: string[]): Promise<void> {
    const cache = davCache();
    if (!cache) return;
    await Promise.all(
      ips.map((ip) =>
        cache.delete(`${HOST}/throttle/write?ip=${encodeURIComponent(ip)}&d=${today()}`),
      ),
    );
  }

  it('guardWrite 在配额内放行、超出后拒绝', async () => {
    await clearThrottle(['1.2.3.4']);
    const req = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
    // 前 3 次放行
    for (let i = 0; i < 3; i++) {
      expect(await guardWrite({}, req, 3), `第 ${i + 1} 次应在配额内`).toBeNull();
    }
    // 第 4 次被拒
    const blocked = await guardWrite({}, req, 3);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get('retry-after')).toBeTruthy();
  });

  it('limit ≤ 0 表示不限制（wrangler.jsonc 里的 "0" 语义）', async () => {
    await clearThrottle(['5.6.7.8']);
    const req = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '5.6.7.8' } });
    for (let i = 0; i < 20; i++) {
      expect(await guardWrite({}, req, 0)).toBeNull();
    }
  });

  it('不同 IP 的配额相互独立', async () => {
    await clearThrottle(['10.0.0.1', '10.0.0.2']);
    const a = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '10.0.0.1' } });
    const b = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '10.0.0.2' } });
    for (let i = 0; i < 3; i++) await guardWrite({}, a, 3);
    expect(await guardWrite({}, a, 3)).not.toBeNull();
    // b 完全没被 a 的消耗影响
    expect(await guardWrite({}, b, 3)).toBeNull();
  });

  it('只信任 CF-Connecting-IP，不用 X-Forwarded-For（否则通行证绑定可被伪造）', async () => {
    await clearThrottle(['9.9.9.9', '8.8.8.8']);
    // 只有 XFF、没有 CF-Connecting-IP → 视为无 IP → 不限流
    const spoofed = new Request('https://x.test/', {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    for (let i = 0; i < 10; i++) {
      expect(
        await guardWrite({}, spoofed, 2),
        '仅有 XFF 时不应被当作真实 IP 计数',
      ).toBeNull();
    }

    // 反过来：同一个伪造 XFF 不应影响真实 IP 的配额
    await clearThrottle(['8.8.8.8']);
    const real = new Request('https://x.test/', {
      headers: { 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '9.9.9.9' },
    });
    for (let i = 0; i < 3; i++) await guardWrite({}, real, 3);
    expect(await guardWrite({}, real, 3), '真实 IP 的配额只按 CF-Connecting-IP 计').not.toBeNull();
  });
});

/**
 * 上传体积上限必须与 Cloudflare 的平台上限对齐。
 *
 * Cloudflare 的请求体上限按**账户套餐**决定（不是 Workers 套餐）：
 *   Free / Pro = 100 MB · Business = 200 MB · Enterprise ≤ 5 GB
 *   来源：https://developers.cloudflare.com/workers/platform/limits/
 *          的 "Request body size limits"（核实日期 2026-10-14，Last updated Oct 12, 2026）
 *
 * 超限的请求在**代理层**就被拦掉并回 413，根本到不了 Worker。所以
 * WebDAV 通道的上限设成 200 MiB 时，100–200 MiB 这一段是「配置说支持、
 * 实际永远失败」的死路径 —— 客户端还拿不到我们的错误信息与 `Allow` 头。
 *
 * 网页上传不受这个约束：它预签名直传 R2，字节不过 Worker。
 */
describe('上传体积上限与平台对齐', () => {
  // Cloudflare Free/Pro 的请求体上限
  const CF_FREE_MAX_BODY = 100 * 1024 * 1024;

  it('WebDAV 的默认上限不超过 Cloudflare 请求体上限', () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBeLessThanOrEqual(CF_FREE_MAX_BODY);
  });

  it('配置上限不能被调回超过平台上限的值', async () => {
    // 直接读 wrangler.jsonc 不可行（jsonc 带注释，且 vitest 环境没有 fs），
    // 改为验证「配置值被正确解析」—— settings() 会 clamp 到合法区间，
    // 而 handlePut 用的是解析后的值。这里断言解析结果仍 ≤ 平台上限。
    const cfg = settings({
      R2_PUBLIC_BASE: 'https://books.example.com',
      MAX_UPLOAD_BYTES: '209715200',
    } as never);
    expect(cfg.maxUploadBytes, '即便环境变量写了 200MiB，也不该大于平台上限对应的默认档')
      .toBeLessThanOrEqual(CF_FREE_MAX_BODY);
  });

  it('超限的 PUT 返回 413 且带说明（而不是 Cloudflare 的裸 413）', async () => {
    // vitest.config.ts 里 MAX_UPLOAD_BYTES='1048576'（1 MiB），便于测边界
    const res = await SELF.fetch(`${ORIGIN}/dav/最近收录/超大.epub`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test-write-token', 'content-length': '2000000' },
      body: 'x',
    });
    const text = await res.text();
    expect(res.status).toBe(413);
    // 提示要说明「实际多大 / 上限多大 / 接下来怎么办」，
    // 而不是干巴巴一句 "limit is 1048576 bytes"。
    expect(text).toMatch(/文件太大/);
    expect(text).toMatch(/1\.0 MB|1048576/);
    // 最关键：说清这个上限**不是本站随便定的**，改大也没用，
    // 并指向可行的替代通道。
    expect(text).toContain('100MB');
    expect(text).toContain('/upload');
    // 客户端要能知道该怎么做
    expect(res.headers.get('allow'), '413 应带回可用的方法').toBeTruthy();
  });
});
