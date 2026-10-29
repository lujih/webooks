/**
 * COPY / MOVE 的数据安全（RFC 4918 §9.8 / §9.9）。
 *
 * 这个文件全部是**回归测试**：每一条都对应一个真实复现过的缺陷。
 * 它们的共同点是「看起来能跑，但会破坏数据」，而 253 个既有测试
 * （改动前）一个都拦不住 —— 因为那些测试断言的是「输出包含某字符串」，
 * 而不是「行为符合规范」。这里断言的是**数据在操作后是否完好**。
 *
 * 覆盖的四个缺陷：
 *   1. MOVE 到自身 → 书被彻底销毁，却回 201（§9.9.4 要求 403）
 *   2. 匿名 COPY 可零凭据覆盖任意已有书（绕过口令体系的核心承诺）
 *   3. Overwrite: F 被完全忽略（§9.8.3 要求 412）
 *   4. COPY 完全绕过扩展名白名单（.exe 能被塞进书库）
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

function dav(path: string, init: RequestInit = {}, withToken = true): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (withToken) headers.authorization = 'Bearer test-write-token';
  return SELF.fetch(`${ORIGIN}/dav${path}`, { ...init, headers });
}

function copyOrMove(
  method: 'COPY' | 'MOVE',
  from: string,
  to: string,
  extraHeaders: Record<string, string> = {},
  withToken = true,
) {
  const headers: Record<string, string> = {
    // Destination 必须是纯 ASCII，否则 fetch 的 Headers 校验会先拦下来
    // （真实客户端会用 %XX 编码，与 dav-probe 的线上实测一致）。
    destination: `${ORIGIN}/dav${encodeURI(to)}`,
    ...extraHeaders,
  };
  if (withToken) headers.authorization = 'Bearer test-write-token';
  return SELF.fetch(`${ORIGIN}/dav${from}`, { method, headers });
}

async function put(path: string, body: string, withToken = true): Promise<Response> {
  return dav(path, { method: 'PUT', body }, withToken);
}

async function bookRow(leaf: string): Promise<{ id: string; r2_key: string } | null> {
  return testEnv.DB.prepare('SELECT id, r2_key FROM books WHERE leaf_name = ?')
    .bind(leaf)
    .first<{ id: string; r2_key: string }>();
}

async function objectText(r2Key: string): Promise<string | null> {
  const obj = await testEnv.BUCKET.get(r2Key);
  return obj ? await obj.text() : null;
}

beforeEach(async () => {
  await resetLibrary();
});

describe('MOVE 到自身：必须拒绝，否则书会消失', () => {
  it('同一路径 → 403，且 D1 行、R2 对象、内容全部完好', async () => {
    const path = '/最近收录/自移动.epub';
    expect((await put(path, 'ORIGINAL-CONTENT')).status).toBe(201);
    const before = await bookRow('自移动.epub');
    expect(before).toBeTruthy();

    const res = await copyOrMove('MOVE', path, path);
    await res.text();
    expect(res.status, 'RFC 4918 §9.9.4 建议同源 MOVE 返回 403').toBe(403);

    // 关键断言：不是「状态码对」，而是「书还在、内容没变」
    const after = await bookRow('自移动.epub');
    expect(after, 'D1 行必须还在').toBeTruthy();
    expect(after?.id).toBe(before?.id);
    expect(await objectText(after!.r2_key), 'R2 对象内容必须没变').toBe('ORIGINAL-CONTENT');
  });

  it('中英文别名指向同一本书时同样要拒绝', async () => {
    await put('/最近收录/别名.epub', 'X').then((r) => r.text());
    // /recent/ 是 /最近收录/ 的英文兼容别名，leaf_name 相同即同一本书
    const res = await copyOrMove('MOVE', '/recent/别名.epub', '/最近收录/别名.epub');
    await res.text();
    expect(res.status).toBe(403);
    expect(await bookRow('别名.epub'), '不能因为路径写法不同就绕过同源判定').toBeTruthy();
  });

  it('真移动到别处仍然正常（修同源判定不能误伤正常路径）', async () => {
    await put('/最近收录/源.epub', 'PAYLOAD').then((r) => r.text());
    const res = await copyOrMove('MOVE', '/最近收录/源.epub', '/最近收录/目标.epub');
    await res.text();
    expect(res.status).toBe(201);

    expect(await bookRow('源.epub'), '源应被删掉').toBeNull();
    const moved = await bookRow('目标.epub');
    expect(moved).toBeTruthy();
    expect(await objectText(moved!.r2_key)).toBe('PAYLOAD');
  });
});

describe('COPY 覆盖已有书：需要口令', () => {
  it('匿名 COPY 不能改写他人书籍', async () => {
    await put('/最近收录/受害者.epub', 'VICTIM-ORIGINAL').then((r) => r.text());
    // 攻击者匿名上传自己的一本书（合法，作为复制源）
    await put('/最近收录/攻击者.epub', 'ATTACKER-PAYLOAD', false).then((r) => r.text());

    const before = await bookRow('受害者.epub');
    const res = await copyOrMove('COPY', '/最近收录/攻击者.epub', '/最近收录/受害者.epub', {}, false);
    await res.text();

    expect(res.status, '覆盖已有书需要口令').toBe(401);
    const after = await bookRow('受害者.epub');
    expect(after?.id).toBe(before?.id);
    expect(await objectText(after!.r2_key), '受害者的内容必须原封不动').toBe('VICTIM-ORIGINAL');
  });

  it('带口令时可以覆盖（口令不能把功能一起禁掉）', async () => {
    await put('/最近收录/src.epub', 'SOURCE').then((r) => r.text());
    await put('/最近收录/dst.epub', 'OLD').then((r) => r.text());

    const res = await copyOrMove('COPY', '/最近收录/src.epub', '/最近收录/dst.epub');
    await res.text();
    expect(res.status, 'RFC 4918 §9.8.5：覆盖已有目标回 204，不是 201').toBe(204);

    const dst = await bookRow('dst.epub');
    expect(await objectText(dst!.r2_key)).toBe('SOURCE');
    expect(await bookRow('src.epub'), 'COPY 不动源').toBeTruthy();
  });

  it('覆盖到新路径时回 201（201 是「创建」，不能一刀切成 204）', async () => {
    await put('/最近收录/s.epub', 'S').then((r) => r.text());
    const res = await copyOrMove('COPY', '/最近收录/s.epub', '/最近收录/新名字.epub', {}, false);
    await res.text();
    expect(res.status).toBe(201);
    expect(await bookRow('新名字.epub')).toBeTruthy();
  });

  it('If-None-Match: * 撞已有书时 412，且不改内容（无需口令）', async () => {
    await put('/最近收录/x.epub', 'X').then((r) => r.text());
    await put('/最近收录/y.epub', 'EXISTING').then((r) => r.text());

    const res = await copyOrMove(
      'COPY', '/最近收录/x.epub', '/最近收录/y.epub',
      { 'if-none-match': '*' }, false,
    );
    await res.text();
    expect(res.status).toBe(412);
    const y = await bookRow('y.epub');
    expect(await objectText(y!.r2_key), '412 之后内容必须没动').toBe('EXISTING');
  });
});

describe('Overwrite 头（RFC 4918 §9.8.3）', () => {
  it('Overwrite: F 且目标已存在 → 412 且目标完好', async () => {
    await put('/最近收录/s.epub', 'S').then((r) => r.text());
    await put('/最近收录/t.epub', 'TARGET').then((r) => r.text());

    const res = await copyOrMove('COPY', '/最近收录/s.epub', '/最近收录/t.epub', {
      overwrite: 'F',
    });
    await res.text();
    expect(res.status).toBe(412);
    const t = await bookRow('t.epub');
    expect(await objectText(t!.r2_key)).toBe('TARGET');
  });

  it('Overwrite: F 且目标不存在 → 正常创建', async () => {
    await put('/最近收录/s.epub', 'S').then((r) => r.text());
    const res = await copyOrMove('COPY', '/最近收录/s.epub', '/最近收录/新.epub', {
      overwrite: 'F',
    });
    await res.text();
    expect(res.status).toBe(201);
  });
});

describe('COPY 不得绕过扩展名白名单', () => {
  it('复制成 .exe 被拒（415），且不落库', async () => {
    await put('/最近收录/正常.txt', 'hello').then((r) => r.text());
    const res = await copyOrMove('COPY', '/最近收录/正常.txt', '/最近收录/注入.exe');
    await res.text();
    expect(res.status).toBe(415);
    expect(await bookRow('注入.exe'), '被拒的文件不能进 D1').toBeNull();
  });

  it('其他可执行/压缩格式同样被拒', async () => {
    await put('/最近收录/正常.txt', 'hello').then((r) => r.text());
    for (const bad of ['x.sh', 'x.zip', 'x.m4a', 'x.exe', 'x.bat']) {
      const res = await copyOrMove('COPY', '/最近收录/正常.txt', `/最近收录/${bad}`);
      await res.text();
      expect(res.status, `${bad} 必须被拒`).toBe(415);
    }
  });
});

describe('MOVE 覆盖：源消失、目标内容正确', () => {
  it('覆盖后只剩目标，且内容来自源', async () => {
    await put('/最近收录/mv-src.epub', 'MOVED-PAYLOAD').then((r) => r.text());
    await put('/最近收录/mv-dst.epub', 'REPLACED').then((r) => r.text());

    const res = await copyOrMove('MOVE', '/最近收录/mv-src.epub', '/最近收录/mv-dst.epub');
    await res.text();
    expect(res.status).toBe(204);

    expect(await bookRow('mv-src.epub'), '源应被删除').toBeNull();
    const dst = await bookRow('mv-dst.epub');
    expect(dst).toBeTruthy();
    expect(await objectText(dst!.r2_key)).toBe('MOVED-PAYLOAD');
  });

  it('覆盖不重置收录时间（否则每次覆盖都篡改馆藏顺序）', async () => {
    const seeded = await put('/最近收录/老书.epub', 'OLD');
    await seeded.text();
    expect(seeded.status).toBe(201);
    const first = await testEnv.DB.prepare('SELECT published_at FROM books WHERE leaf_name = ?')
      .bind('老书.epub').first<{ published_at: string }>();
    expect(first?.published_at).toBeTruthy();

    // 让新书的收录时间明确晚于老书，否则断言没有区分度
    await new Promise((r) => setTimeout(r, 1100));
    const newer = await put('/最近收录/新书.epub', 'NEW');
    await newer.text();
    expect(newer.status).toBe(201);

    const moved = await copyOrMove('MOVE', '/最近收录/新书.epub', '/最近收录/老书.epub');
    await moved.text();
    expect(moved.status).toBe(204);

    const after = await testEnv.DB.prepare('SELECT published_at FROM books WHERE leaf_name = ?')
      .bind('老书.epub').first<{ published_at: string }>();
    expect(after?.published_at, '覆盖不应把老书顶到「最近收录」最前').toBe(first?.published_at);
  });
});

// ── 2026-10-28 审查：COPY 到自身曾会用自身 body 覆写同一 R2 键 ────────────
describe('COPY 到同一资源（RFC 4918 §9.8.5）', () => {
  /** 读 D1 行 + R2 真实字节（不跟 302，否则读到的是跳转目标而不是对象） */
  async function snapshot(leaf: string) {
    const row = await testEnv.DB
      .prepare('SELECT size, etag, r2_key FROM books WHERE leaf_name = ?')
      .bind(leaf)
      .first<{ size: number; etag: string; r2_key: string }>();
    const obj = row ? await testEnv.BUCKET.get(row.r2_key) : null;
    return { row, bytes: obj ? new Uint8Array(await obj.arrayBuffer()) : null };
  }

  it('COPY 到自身 → 204，且**没有发生重写**（uploaded 时间戳不变）', async () => {
    await put('/最近收录/SelfCopy.epub', 'ORIGINAL-BYTES');
    const row = await testEnv.DB
      .prepare('SELECT size, etag, r2_key FROM books WHERE leaf_name = ?')
      .bind('SelfCopy.epub')
      .first<{ size: number; etag: string; r2_key: string }>();
    expect(row).not.toBeNull();
    const before = await testEnv.BUCKET.head(row!.r2_key);

    // 间隔 20ms：R2 的 uploaded 是毫秒时间戳，同毫秒内重写会看不出差异
    await new Promise((r) => setTimeout(r, 20));
    const res = await copyOrMove('COPY', '/最近收录/SelfCopy.epub', '/最近收录/SelfCopy.epub');
    expect(res.status, '同源 COPY 应当是 204 no-op').toBe(204);
    await res.text();

    const after = await testEnv.BUCKET.head(row!.r2_key);
    // ⚠️ 只比字节是**假绿**：同源重写会写回一模一样的字节，内容自然相等。
    // 真正的判别证据是对象被**重写**过 —— uploaded 时间戳 / size / etag。
    // 修复前这里会「读自己 → 写同一个键」，uploaded 必然前进。
    expect(after?.uploaded?.getTime(), '对象不能被重写（uploaded 不应前进）')
      .toBe(before?.uploaded?.getTime());
    expect(after?.size).toBe(before?.size);
    expect(after?.etag).toBe(before?.etag);

    const rowAfter = await testEnv.DB
      .prepare('SELECT size, etag, r2_key FROM books WHERE leaf_name = ?')
      .bind('SelfCopy.epub')
      .first<{ size: number; etag: string; r2_key: string }>();
    expect(rowAfter).toEqual(row);
  });

  it('COPY 到别名路径（同一本、不同集合路径）也按同源处理', async () => {
    await put('/最近收录/Alias.epub', 'ALIAS-BYTES');
    const before = await snapshot('Alias.epub');

    const res = await copyOrMove(
      'COPY',
      '/最近收录/Alias.epub',
      '/按作者/未知作者/Alias.epub',
    );
    expect(res.status).toBe(204);
    await res.text();

    const after = await snapshot('Alias.epub');
    expect(after.bytes).toEqual(before.bytes);
    expect(after.row).toEqual(before.row);
  });
});
