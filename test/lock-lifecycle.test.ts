/**
 * 锁的生命周期：**资源没了，锁就必须没了**（RFC 4918 §9.6 的 MUST）。
 *
 * 原文（refs/rfc4918.txt L2678-L2682）：
 *   > A server processing a successful DELETE request:
 *   >    **MUST destroy locks rooted on the deleted resource**
 *   >    MUST remove the mapping from the Request-URI to any resource.
 *
 * 这一条为什么值得单独一个文件：它坏掉的时候**不报错**。删除返回 204、R2 对象
 * 真的没了、D1 行真的没了，只有 locks 表里留下一行指向不存在资源的锁，然后在
 * TTL（最长 3600s）内禁止同一路径被重新创建 —— 客户端看到的是「我刚删掉的
 * 文件传不回去了」，而服务端日志里什么都没有。Lead 实测（修复前）：
 *
 *   PUT    /recent/dangle.epub                  → 201
 *   LOCK   /recent/dangle.epub (Second-300)     → 200  <urn:uuid:779d1491-…>
 *   DELETE /recent/dangle.epub  If: (<token>)   → 204
 *   SELECT * FROM locks                         → 行仍在！
 *   PUT    /recent/dangle.epub（同一路径重传）  → 423 Locked   ← 症状
 *
 * 第二条同类缺陷（把资源路径当 token 传）在 `0b8e38b` 修过一次（handleUnlock），
 * 又在 `9071c1b` 于 MOVE 分支复发。所以本文件的断言刻意钉在**两个互相独立的
 * 事实**上，缺一不可：
 *   1. `SELECT … FROM locks` 的行真的没了（DB 事实）；
 *   2. 同一路径再 PUT 得到 201 而不是 423（用户可见的状态码）。
 *
 * 只钉源码文本是抓不到「函数在、但不干活」的（task-11 的教训：把
 * newLockToken 改回带括号形态时，行为断言全绿、只有源码守卫变红），所以本文件
 * 三个变异组都能靠行为断言变红 —— 变异验证记录见报告。
 *
 * 另外必须同时存在**负向控制**（不带 If 令牌仍然 423）：否则「锁不生效了」
 * 会让上面所有断言一起变绿，看起来像修好了。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { rebuildBuckets, upsertBookStatement } from '../src/lib/db';
import { deriveMetadata } from '../src/lib/metadata';
import { canonicalDavPath } from '../src/lib/collections';
import { clearDavCache, resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const RECENT = '/最近收录/';
const CLEAR = ['/', '/按书名/', '/最近收录/', '/按格式/', '/按作者/'];

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  // 与 test/webdav-class2.test.ts 同一约定：以「已授权客户端」身份发请求。
  // 「没口令会被拒」由 test/security.test.ts 专门覆盖。
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-write-token',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function seed(leafNames: string[]): Promise<void> {
  const statements = leafNames.map((leaf, i) => {
    const meta = deriveMetadata(leaf);
    return upsertBookStatement(testEnv.DB, {
      id: `lc-${i}`,
      leafName: leaf,
      title: meta.title,
      author: meta.author,
      language: null,
      format: meta.format,
      contentType: meta.contentType,
      size: 100,
      sha256: null,
      r2Key: `books/lc-${i}`,
      etag: `lc-etag-${i}`,
      titleLetter: meta.title[0]?.toUpperCase() ?? 'Z',
      authorLetter: 'Z',
      formatBucket: meta.format,
      publishedAt: new Date().toISOString(),
    });
  });
  await testEnv.DB.batch(statements);
  await rebuildBuckets(testEnv.DB);
}

const LOCK_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>'
  + '<D:lockinfo xmlns:D="DAV:">'
  + '<D:lockscope><D:exclusive/></D:lockscope>'
  + '<D:locktype><D:write/></D:locktype>'
  + '<D:owner>lifecycle-tester</D:owner>'
  + '</D:lockinfo>';

/** 建锁并返回**带尖括号的头部形态**令牌（§10.5）。 */
async function lock(path: string, depth = '0'): Promise<{ status: number; token: string }> {
  const res = await dav(path, {
    method: 'LOCK',
    headers: { 'content-type': 'application/xml', timeout: 'Second-300', depth },
    body: LOCK_BODY,
  });
  await res.text();
  return { status: res.status, token: res.headers.get('lock-token') ?? '' };
}

async function lockRows(): Promise<Array<{ token: string; resource: string }>> {
  const { results } = await testEnv.DB
    .prepare('SELECT token, resource FROM locks ORDER BY resource')
    .all<{ token: string; resource: string }>();
  return results ?? [];
}

/** 直接往库里塞一行（模拟「旧代码留下的」或过期残留，绕过 HTTP 层）。 */
async function insertLockRow(resource: string, opts: { expired?: boolean } = {}): Promise<string> {
  const uuid = `urn:uuid:${Math.random().toString(16).slice(2, 10)}-1111-2222-3333-444444444444`;
  const now = Date.now();
  const expiresAt = new Date(opts.expired ? now - 60_000 : now + 300_000).toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(uuid, resource, 'seed', 'exclusive', '0', 300, new Date(now).toISOString(), expiresAt)
    .run();
  return uuid;
}

beforeEach(async () => {
  await resetLibrary();
  await clearDavCache(CLEAR);
});

describe('§9.6 资源被删除后锁必须销毁', () => {
  it('叶子 DELETE：带 If 令牌删掉被锁的文件 → 锁行消失，同一路径再 PUT 得 201（不是 423）', async () => {
    await dav(`${RECENT}dangle.epub`, { method: 'PUT', body: 'x' }).then((r) => r.text());
    const { status, token } = await lock(`${RECENT}dangle.epub`);
    expect(status).toBe(200);
    expect(token).toMatch(/^<urn:uuid:/);

    // 负向控制：不带 If 令牌 → 锁仍然有效（423）。这条同时防止
    // 「把锁检查一起删掉」让下面的断言假绿。
    const blocked = await dav(`${RECENT}dangle.epub`, { method: 'DELETE' });
    await blocked.text();
    expect(blocked.status, '不带 If 令牌时锁必须仍然挡住删除').toBe(423);
    expect((await lockRows()).length, '被拒的删除不该改动锁表').toBe(1);

    // 持锁者删除：应当成功，且锁必须一并销毁
    const del = await dav(`${RECENT}dangle.epub`, {
      method: 'DELETE',
      headers: { if: `(${token})` },
    });
    await del.text();
    expect(del.status, '持锁者带 If 令牌应能删除自己的资源').toBe(204);

    // ★ 断言 1：DB 事实 —— 行真的没了
    expect(
      await lockRows(),
      '§9.6 MUST destroy：资源没了，锁不能残留（残留 → TTL 内同路径无法重建）',
    ).toEqual([]);

    // ★ 断言 2：用户可见的状态码 —— 同一路径重新上传必须是 201
    const rePut = await dav(`${RECENT}dangle.epub`, { method: 'PUT', body: 'y' });
    await rePut.text();
    expect(rePut.status, '删除者不该被自己删掉的文件的残锁挡在门外').toBe(201);
  });

  it('别名路径：删书会清掉它在**其他集合路径**上的锁（§9.6 针对资源，不是这条 URL）', async () => {
    await dav(`${RECENT}alias.epub`, { method: 'PUT', body: 'x' }).then((r) => r.text());
    // 锁建在「按别名走的另一条路径」上：先确认 canonicalDavPath 把 /最近收录/x
    // 映射成的库内形态（锁表里存的是规范路径）。
    const { status, token } = await lock(`/recent/alias.epub`);
    expect(status).toBe(200);
    const canonical = canonicalDavPath('/recent/alias.epub');
    expect(canonical).toBe('/最近收录/alias.epub');
    expect((await lockRows()).some((r) => r.resource === canonical)).toBe(true);

    // 删除走「按书名」那条别名路径（同一本书，leaf_name 相同）
    const del = await dav('/按书名/alias.epub', {
      method: 'DELETE',
      headers: { if: `(${token})` },
    });
    await del.text();
    expect(del.status).toBe(204);

    expect(
      await lockRows(),
      '书没了，它在任何路径上的锁都该销毁（否则另一条路径会被残锁挡住）',
    ).toEqual([]);
  });

  it('集合 DELETE：集合自身的锁与残留的成员锁都被清掉', async () => {
    await seed(['in-coll.epub']);
    // 集合自身的 Depth:1 锁
    const { status, token } = await lock(RECENT, '1');
    expect(status).toBe(200);
    // 另插一行**已过期**的成员锁（过期 ⇒ 不触发成员锁 423 预检，但行仍是垃圾；
    // 它在 removed 的 leaf 名单里，必须被一起清掉）
    await insertLockRow('/最近收录/in-coll.epub', { expired: true });
    expect((await lockRows()).length).toBe(2);

    // 负向控制：不带 If → 集合自身锁挡住删除
    const blocked = await dav(RECENT, { method: 'DELETE' });
    await blocked.text();
    expect(blocked.status).toBe(423);

    const del = await dav(RECENT, { method: 'DELETE', headers: { if: `(${token})` } });
    await del.text();
    expect(del.status, '持锁者带 If 令牌可以删掉自己锁住的集合').toBe(204);

    expect(
      await lockRows(),
      '集合与它的成员都没了：集合锁 + 成员残留锁都必须清空',
    ).toEqual([]);

    // 集合可以重建（残锁会让这里的 PUT 变成 423）
    const rePut = await dav(`${RECENT}in-coll.epub`, { method: 'PUT', body: 'y' });
    await rePut.text();
    expect(rePut.status).toBe(201);
  });

  it('MOVE：源路径的资源没了，源锁必须销毁（且持锁者自己不被挡）', async () => {
    await dav(`${RECENT}mv-a.epub`, { method: 'PUT', body: 'x' }).then((r) => r.text());
    const { status, token } = await lock(`${RECENT}mv-a.epub`);
    expect(status).toBe(200);

    // 负向控制：不带 If 令牌 → 423（§7.5：锁挡住未授权写）
    const blocked = await dav(`${RECENT}mv-a.epub`, {
      method: 'MOVE',
      headers: { destination: `${ORIGIN}/dav${RECENT}mv-b.epub` },
    });
    await blocked.text();
    expect(blocked.status, '不带 If 令牌的 MOVE 必须被锁挡住').toBe(423);

    // §9.9.1 / §7.5：提交正确令牌的请求应当被授权 —— 修复前这里也是 423
    const moved = await dav(`${RECENT}mv-a.epub`, {
      method: 'MOVE',
      headers: { destination: `${ORIGIN}/dav${RECENT}mv-b.epub`, if: `(${token})` },
    });
    await moved.text();
    expect([201, 204], '持锁者的 MOVE 必须被授权').toContain(moved.status);

    expect(await lockRows(), '§9.6：MOVE 等价于 COPY+DELETE，源路径上的锁要销毁').toEqual([]);

    // 源路径可以重新创建（残锁会让这里 423）
    const rePut = await dav(`${RECENT}mv-a.epub`, { method: 'PUT', body: 'z' });
    await rePut.text();
    expect(rePut.status).toBe(201);
  });

  it('别名路径的集合锁：LOCK /recent/（别名）→ 带 If 的 DELETE /recent/ → 集合锁必须清空', async () => {
    // ★ 这条是**真机验证时抓到的漏网**，单测当时全绿也照样漏：
    //   入库的 `resource` 是规范形态 `/最近收录/`（LOCK 入口走 canonicalDavPath），
    //   而请求路径可能写成别名 `/recent/`。helper 原先只做 decodeDavPath ——
    //   它解决 `%E6%9C%80…` 这种百分号编码，但**解决不了别名**，于是
    //   `/recent/` 与 `/最近收录/` 字符串不等 → 匹配零行 → 集合自身的锁残留，
    //   删除者被自己刚删掉的集合的锁挡在门外（真机：DELETE 204 → PUT 423）。
    //   我原先的测试全都用规范形态（原始路径 == 规范路径），别名这条路一次都没走到。
    //   教训：端到端测试的路径要么取自**客户端真实会发的形态**，要么把两种都测。
    await seed(['alias-coll.epub']);
    const { status, token } = await lock('/recent/', '1');
    expect(status).toBe(200);
    expect(
      (await lockRows()).some((r) => r.resource === '/最近收录/'),
      '锁表里存的是规范形态（/recent/ 只是别名）',
    ).toBe(true);

    // 负向控制：不带 If → 集合锁仍然生效
    const blocked = await dav('/recent/', { method: 'DELETE' });
    await blocked.text();
    expect(blocked.status).toBe(423);

    const del = await dav('/recent/', { method: 'DELETE', headers: { if: `(${token})` } });
    await del.text();
    expect(del.status).toBe(204);

    expect(
      await lockRows(),
      '集合锁的 resource 是规范形态，按别名路径删除时也必须能匹配到',
    ).toEqual([]);

    const rePut = await dav('/recent/alias-coll.epub', { method: 'PUT', body: 'z' });
    await rePut.text();
    expect(rePut.status, '别名路径删除的集合必须能立刻重建').toBe(201);
  });

  it('管理后台按 leafNames 删书 → 该资源的锁一并销毁', async () => {
    await dav(`${RECENT}admin-del.epub`, { method: 'PUT', body: 'x' }).then((r) => r.text());
    const { status } = await lock(`${RECENT}admin-del.epub`);
    expect(status).toBe(200);
    expect((await lockRows()).length).toBe(1);

    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ leafNames: ['admin-del.epub'] }),
    });
    const body = (await res.json()) as { deleted: string[] };
    expect(res.status).toBe(200);
    expect(body.deleted).toEqual(['admin-del.epub']);

    expect(
      await lockRows(),
      '管理后台删书同样受 §9.6 约束（它不走 WebDAV 的 DELETE 分支）',
    ).toEqual([]);

    const rePut = await dav(`${RECENT}admin-del.epub`, { method: 'PUT', body: 'y' });
    await rePut.text();
    expect(rePut.status).toBe(201);
  });

  it('负向控制：资源存在时锁**仍然**生效（不是把锁一起删掉了）', async () => {
    await dav(`${RECENT}still-locked.epub`, { method: 'PUT', body: 'x' }).then((r) => r.text());
    const { status } = await lock(`${RECENT}still-locked.epub`);
    expect(status).toBe(200);

    // 资源还在 → 匿名/未提交令牌的写仍然 423，锁行仍在
    const put = await dav(`${RECENT}still-locked.epub`, { method: 'PUT', body: 'y' });
    await put.text();
    expect(put.status).toBe(423);
    expect((await lockRows()).length, '没有删除发生，锁不该被动过').toBe(1);

    // 正常的 UNLOCK 仍然能释放（确认上面的 204 不是靠「删锁」换来的）
    const unlock = await dav(`${RECENT}still-locked.epub`, {
      method: 'UNLOCK',
      headers: { 'lock-token': (await lockRows())[0]!.token.startsWith('<')
        ? (await lockRows())[0]!.token
        : `<${(await lockRows())[0]!.token}>` },
    });
    await unlock.text();
    expect(unlock.status).toBe(204);
    expect(await lockRows()).toEqual([]);
  });
});

/**
 * `%` 是**合法文件名字符**，而锁行里的 resource 是已解码的规范路径。
 *
 * 来路（不需要手工塞库，一条公开 API 请求就够）：
 *   canonicalDavPath('/最近收录/100%25.epub') → '/最近收录/100%.epub'
 *   canonicalDavPath('/最近收录/100%.epub')   → '/最近收录/100%.epub'（原样）
 *   canonicalDavPath('/最近收录/%E6.epub')    → '/最近收录/%E6.epub'（畸形转义，try/catch 原样返回）
 * 而 `sanitiseLeafName()` 不清洗 `%`，`handleLock()` 也不检查资源是否存在。
 *
 * 把这种末段交给裸 `decodeURIComponent()` 就是 `URIError: URI malformed`。
 * 这个缺陷为什么严重：decode 发生在「这一行是不是我要删的那本」**之前**，
 * 所以表里**只要存在一行**这样的锁，整个循环就中断 ——
 *   · 叶子 DELETE：书/R2 对象/D1 行都已删完，客户端收到 500（而锁残留恰好没清掉）
 *   · 集合 DELETE 的成员锁预检：位置在删除**之前** → 一个成员都删不掉
 *   · admin delete：rebuildBuckets / purgeEntries 被跳过 → 已删的书留在缓存里
 * 断言全部落在**行为**上（状态码 + 锁表事实），不是「try 包住了 decode」这种源码文本。
 */
describe('锁表里的 % 不是非法字符：删除路径不许抛 URIError', () => {
  it('LOCK 含 %25 的名字 → 库里存裸 %；带 If 令牌 DELETE 必须 204（不是 500）', async () => {
    const put = await dav(`${RECENT}100%25.epub`, { method: 'PUT', body: 'x' });
    await put.text();
    expect(put.status, '%25 解码后是裸 %，它是合法文件名字符').toBe(201);

    const { status, token } = await lock(`${RECENT}100%25.epub`);
    expect(status, 'LOCK 不做存在性检查，含 % 的路径照样能建锁').toBe(200);

    const rows = await lockRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.resource, 'canonicalDavPath 解掉 %25 → 库里是裸 %').toBe(
      '/最近收录/100%.epub',
    );

    // 持锁者删自己的资源（带 If 令牌才会走到清理逻辑；不带的话前面就 423 了）
    const del = await dav(`${RECENT}100%25.epub`, {
      method: 'DELETE',
      headers: { if: `(${token})` },
    });
    const delBody = await del.text();
    expect(
      del.status,
      `裸 decodeURIComponent 会抛 URIError → 500（书已删、锁没清）；响应体：${delBody}`,
    ).toBe(204);
    expect(await lockRows(), '§9.6：资源没了锁也必须没，含 % 的行同样要删掉').toEqual([]);

    const rePut = await dav(`${RECENT}100%25.epub`, { method: 'PUT', body: 'y' });
    await rePut.text();
    expect(rePut.status, '残锁会让这里变成 423').toBe(201);
  });

  it('半截转义 %E6（decodeDavPath 原样保留）也照样能删', async () => {
    const put = await dav(`${RECENT}%E6.epub`, { method: 'PUT', body: 'x' });
    await put.text();
    expect(put.status).toBe(201);

    const { status, token } = await lock(`${RECENT}%E6.epub`);
    expect(status).toBe(200);
    expect((await lockRows())[0]!.resource, '畸形转义不被解码，原样入库').toBe(
      '/最近收录/%E6.epub',
    );

    const del = await dav(`${RECENT}%E6.epub`, {
      method: 'DELETE',
      headers: { if: `(${token})` },
    });
    const delBody = await del.text();
    expect(del.status, `%E6 同样会让裸解码抛 URIError；响应体：${delBody}`).toBe(204);
    expect(await lockRows()).toEqual([]);
  });

  it('表里有一行别人的畸形锁，删另一本书仍必须 204（一行坏数据不许中断整批清理）', async () => {
    await seed(['normal.epub']);
    // 别人的锁、含裸 %，且与本次要删的 leaf_name 无关 ——
    // 关键在于解码发生在「是不是我要删的那本」之前，所以它照样能毒死整个循环。
    await insertLockRow('/最近收录/other%.epub');

    const del = await dav(`${RECENT}normal.epub`, { method: 'DELETE' });
    const delBody = await del.text();
    expect(del.status, `无关资源的坏锁行不该让删除 500；响应体：${delBody}`).toBe(204);

    expect(
      (await lockRows()).map((r) => r.resource),
      '无关资源的锁不该被顺手删掉（只清本次删除涉及的资源）',
    ).toEqual(['/最近收录/other%.epub']);
  });

  it('集合 DELETE：成员锁预检遇到含 % 的锁行不许 500（预检在删除之前，会让一个成员都删不掉）', async () => {
    await seed(['in-coll.epub']);
    await insertLockRow('/最近收录/weird%.epub'); // 活锁、含裸 %、不属于任何候选成员

    const del = await dav(RECENT, { method: 'DELETE' });
    const delBody = await del.text();
    expect(
      del.status,
      `成员锁预检里的裸解码会让整个集合删除 500；响应体：${delBody}`,
    ).toBe(204);

    expect(await lockRows(), '集合整棵子树都没了，成员锁（含含 % 的行）一并清空').toEqual([]);
  });

  it('名字里带「合法的转义序列」时，匹配要比对**库里原样的末段**（不能只比解码结果）', async () => {
    // `%2541` 解码一次是 `%41` —— 而 `%41` 本身又是一个合法转义（= 'A'）。
    // 库里的 resource / leaf_name 都是**解码一次**的规范形态（`100%41.epub`），
    // 所以拿它再解一次会得到 `100A.epub`，与 leaf_name 不等 → 按 leaf 匹配失效。
    // （不解码、或只比解码结果，都会在这里漏掉这把锁。）
    const put = await dav(`${RECENT}100%2541.epub`, { method: 'PUT', body: 'x' });
    await put.text();
    expect(put.status).toBe(201);

    const { status } = await lock(`${RECENT}100%2541.epub`);
    expect(status).toBe(200);
    const rows = await lockRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.resource, 'canonicalDavPath 只解码一次').toBe('/最近收录/100%41.epub');

    // 走管理后台删书：它**只**按 leaf_name 清锁（没有 releaseLocksForResource 兜底），
    // 所以这条路径完全依赖末段匹配。
    const leafName = rows[0]!.resource.slice(rows[0]!.resource.lastIndexOf('/') + 1);
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ leafNames: [leafName] }),
    });
    const body = (await res.json()) as { deleted: string[] };
    expect(res.status).toBe(200);
    expect(body.deleted, '前提：书确实被删掉了（否则这条用例证明不了锁的问题）').toEqual([
      leafName,
    ]);

    expect(
      await lockRows(),
      '书没了、锁还在 → TTL 内同名文件传不回来（§9.6 MUST destroy）',
    ).toEqual([]);
  });

  // ── 2026-10-28 审查（协议 🟠-8）：刷新令牌无效时曾**新造一把锁** ─────────
  it('LOCK 刷新带无效 If 令牌 → 412，且不得新造锁', async () => {
    // 先确认表里本来没有锁
    expect(await lockRows()).toHaveLength(0);

    const res = await dav('/recent/refresh.epub', {
      method: 'LOCK',
      headers: {
        'content-type': 'application/xml',
        timeout: 'Second-300',
        depth: '0',
        // 一个格式合法但库里不存在的令牌
        if: '(<urn:uuid:00000000-0000-0000-0000-000000000000>)',
      },
      body: LOCK_BODY,
    });
    expect(res.status, '无效刷新令牌必须 412，而不是 200 + 新锁').toBe(412);
    await res.text();

    // 修复前：这里会多出一把锁（200 + Lock-Token），客户端以为刷新成功。
    expect(await lockRows(), '失败的重启不能留下新锁').toHaveLength(0);
  });

});