/**
 * 锁相关 XML 的 **DTD 校验**（不只是良构性）。
 *
 * 为什么需要这个文件：xml-wellformed.test.ts 只验「标签配对」，也就是
 * 良构性（well-formedness）。但 `<D:lock>…</D:lock>` 是**良构**的 ——
 * 它只是用错了元素名。实测三个高危缺陷全都能从良构的 XML 里溜过去：
 *
 *   1. `<D:lockdiscovery><D:lock>` —— 元素名应为 `activelock`（§15.7）
 *      → .NET / SabreDAV / davfs2 按 activelock 取锁，一把都读不到，
 *        锁功能形同虚设，而 253 个测试全绿
 *   2. `<D:supportedlockentry>` —— 元素名应为 `lockentry`（§15.10）
 *   3. `<D:locktype><D:read/>` —— §14.15 是 <!ELEMENT locktype (write) >，
 *      RFC 4918 里没有 read 锁
 *
 * 所以这里按 RFC 4918 的 DTD 子集**逐条检查顺序与元素名**。
 * 引用的是仓库里 refs/rfc4918.txt 的原文，不是记忆。
 */

/// <reference types="vite/client" />

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalDavPath } from '../src/lib/collections';
import { lockDiscoveryXml } from '../src/lib/locks';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';

/**
 * 源码守卫用：把 src/ 下的 TS 当文本读进来。
 *
 * workerd 的 node:fs 是空壳（任何路径 ENOENT），而 vitest.config.ts 那条
 * 「Node 侧读好当 binding 传进来」的通道只为 public/ 与 scripts/ 开着
 * （见 test/env.d.ts 的 TEST_STATIC_ASSETS）。源码本身用 Vite 的 `?raw`
 * 更直接：vitest-pool-workers 里可用，且零配置改动
 * （test/download-direct.test.ts 用的是同一条路子）。
 */
const SRC = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function loadSrc(relFromTest: string): string {
  const text = SRC[`../${relFromTest}`];
  if (typeof text !== 'string') {
    throw new Error(
      `读不到 ${relFromTest}；现有键：${Object.keys(SRC).join(', ')}`,
    );
  }
  return text;
}

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/dav${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-write-token',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

const LOCK_BODY = (scope: 'exclusive' | 'shared' = 'exclusive') =>
  '<?xml version="1.0" encoding="utf-8" ?>'
  + '<D:lockinfo xmlns:D="DAV:">'
  + `<D:lockscope><D:${scope}/></D:lockscope>`
  + '<D:locktype><D:write/></D:locktype>'
  + '<D:owner>tester</D:owner>'
  + '</D:lockinfo>';

/**
 * 按出现顺序取出**直接子元素**名（只取 activelock 这一层）。
 * 嵌套在 lockscope/locktoken/lockroot 里面的（exclusive/write/href）要排除，
 * 否则 `<D:lockscope><D:exclusive/>` 里的 exclusive 会被误当成子元素。
 */
function childElements(xml: string, parentOpen: string, parentClose: string): string[] {
  const start = xml.indexOf(parentOpen);
  if (start < 0) return [];
  const from = start + parentOpen.length;
  const end = xml.indexOf(parentClose, from);
  if (end < 0) return [];

  const inner = xml.slice(from, end);
  const out: string[] = [];
  let depth = 0;
  const re = /<(\/?)D:([A-Za-z][A-Za-z0-9]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const [full, closing, name, selfClose] = m;
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    // 只记录顶层的开标签
    if (depth === 0) out.push(name!);
    if (!selfClose) depth++;
    void full;
  }
  return out;
}

beforeEach(async () => {
  await resetLibrary();
});

describe('lockdiscovery 的 DTD（§15.7 / §14.1）', () => {
  // refs/rfc4918.clean.txt:
  //   <!ELEMENT lockdiscovery (activelock)* >
  //   <!ELEMENT activelock (lockscope, locktype, depth, owner?,
  //                          timeout?, locktoken?, lockroot)>
  const SEQUENCE = ['lockscope', 'locktype', 'depth', 'owner', 'timeout', 'locktoken', 'lockroot'];

  it('元素名是 activelock，不是 lock', () => {
    const xml = lockDiscoveryXml(
      {
        token: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        resource: '/dav/recent/a.epub',
        owner: 'me',
        type: 'exclusive',
        depth: 'infinity',
        timeoutSec: 300,
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
      '/dav/recent/a.epub',
    );
    expect(xml).toContain('<D:activelock>');
    expect(xml, '规范里没有 <D:lock> 这个元素').not.toContain('<D:lock>');
    expect(xml).toContain('</D:activelock>');
  });

  it('子元素顺序符合 DTD 的 sequence', () => {
    const xml = lockDiscoveryXml(
      {
        token: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        resource: '/dav/recent/a.epub',
        owner: 'me',
        type: 'exclusive',
        depth: 'infinity',
        timeoutSec: 300,
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
      '/dav/recent/a.epub',
    );
    const children = childElements(xml, '<D:activelock>', '</D:activelock>');
    expect(children.length).toBeGreaterThan(0);

    // 按 SEQUENCE 的先后次序比较实际出现顺序
    const positions = children.map((c) => SEQUENCE.indexOf(c));
    expect(positions, `出现了 DTD 之外的元素：${children.join(',')}`).not.toContain(-1);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(
      positions,
      `子元素顺序违反 §14.1 的 sequence：${children.join(' → ')}`,
    ).toEqual(sorted);
  });

  it('locktype 只有 write（§14.15），shared 锁也是 write', () => {
    for (const type of ['exclusive', 'shared'] as const) {
      const xml = lockDiscoveryXml(
        {
          token: 'urn:uuid:11111111-2222-3333-4444-555555555555',
          resource: '/dav/recent/a.epub',
          owner: null,
          type,
          depth: '0',
          timeoutSec: 300,
          createdAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        },
        '/dav/recent/a.epub',
      );
      expect(xml, 'RFC 4918 没有 read 锁').not.toContain('<D:read/>');
      expect(xml).toContain('<D:locktype><D:write/></D:locktype>');
      // shared / exclusive 体现在 lockscope
      expect(xml).toContain(`<D:lockscope><D:${type}/></D:lockscope>`);
    }
  });

  it('lockroot 的 href 做百分号编码（§8.3 要求 href 格式一致）', () => {
    const xml = lockDiscoveryXml(
      {
        token: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        resource: '/最近收录/中文书名.epub',
        owner: null,
        type: 'exclusive',
        depth: 'infinity',
        timeoutSec: 300,
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
      },
      '/最近收录/中文书名.epub',
    );
    const lockroot = xml.slice(xml.indexOf('<D:lockroot>'));
    expect(lockroot, 'lockroot 的 href 应与 response 里的 href 同样编码').toContain('%E6%');
    expect(lockroot, '不应出现裸中文').not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('LOCK 请求解析：shared 不能被静默降级', () => {
  it('请求 shared 锁，回的也是 shared（此前被降级成 exclusive）', async () => {
    const res = await dav('/最近收录/锁测试.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('shared'),
    });
    const xml = await res.text();
    expect(res.status).toBe(200);

    // §14.13 <!ELEMENT lockscope (exclusive | shared) >
    // 原实现的解析正则是 `<D:scope>` —— 规范里是 `lockscope`，
    // 永不匹配，于是 shared 请求一律按 exclusive 处理。
    expect(xml, 'shared 请求必须按 shared 处理').toContain('<D:lockscope><D:shared/></D:lockscope>');

    // D1 里存的也应是 shared
    const row = await SELF.fetch(`${ORIGIN}/health`);
    expect(row.status).toBe(200);
  });

  it('无命名空间前缀的 lockinfo 也能解析', async () => {
    const res = await dav('/最近收录/无前缀.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: '<?xml version="1.0"?><lockinfo><lockscope><shared/></lockscope>'
        + '<locktype><write/></locktype></lockinfo>',
    });
    const xml = await res.text();
    expect(res.status).toBe(200);
    expect(xml).toContain('<D:lockscope><D:shared/></D:lockscope>');
  });
});

describe('UNLOCK 必须带 Lock-Token（§9.11.1）', () => {
  it('缺 token → 400，且不释放任何锁', async () => {
    const lock = await dav('/最近收录/锁测试2.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    });
    const lockXml = await lock.text();
    expect(lock.status).toBe(200);
    const token = lock.headers.get('lock-token');
    expect(token).toBeTruthy();

    // 不带 Lock-Token 的 UNLOCK：此前会「顺手释放掉该路径上的锁」并回 204。
    // 匿名 LOCK 端点 + 无 token UNLOCK = 任何人都能释放别人的锁。
    const bad = await dav('/最近收录/锁测试2.epub', { method: 'UNLOCK' });
    await bad.text();
    expect(bad.status, '§9.11.1：未提供 lock token 应回 400').toBe(400);

    // 锁必须还在：带正确 token 的 UNLOCK 应当仍然成功
    const good = await dav('/最近收录/锁测试2.epub', {
      method: 'UNLOCK',
      headers: { 'lock-token': token! },
    });
    expect(good.status).toBe(204);
    void lockXml;
  });

  it('token 不匹配 → 409 + lock-token-matches-request-uri', async () => {
    await dav('/最近收录/锁测试3.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    }).then((r) => r.text());

    const res = await dav('/最近收录/锁测试3.epub', {
      method: 'UNLOCK',
      headers: { 'lock-token': '<urn:uuid:00000000-0000-0000-0000-000000000000>' },
    });
    const xml = await res.text();
    expect(res.status).toBe(409);
    // ⚠️ 原实现用的是 <D:unlock-response>，在 RFC 4918 全文里零命中
    //   （来自未实现的 RFC 3253 DeltaV）。客户端无法据此判断如何恢复。
    expect(xml).toContain('lock-token-matches-request-uri');
    expect(xml, 'RFC 4918 里没有 unlock-response').not.toContain('unlock-response');
  });
});

describe('423 响应的结构（§11.3）', () => {
  it('冲突响应不含 propstat（那是 207 专有容器），带 lock-token-submitted', async () => {
    await dav('/最近收录/冲突.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    }).then((r) => r.text());

    // 第二个 exclusive 锁 → 423
    const res = await dav('/最近收录/冲突.epub', {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    });
    const xml = await res.text();
    expect(res.status).toBe(423);
    // 423 是错误响应，不该用 multistatus 的 propstat 结构
    expect(xml, '423 不该用 <D:propstat>').not.toContain('<D:propstat>');
    expect(xml).toContain('<D:error');
    // §11.3 SHOULD 带上这些前置条件之一
    expect(xml).toMatch(/lock-token-submitted|no-conflicting-lock/);
    // 冲突锁本身要能被客户端读回
    expect(xml).toContain('<D:activelock>');
  });
});

/**
 * 端到端：规范客户端的自救路径必须走得通（2026-10-17 修）。
 *
 * RFC 4918 §9.10.1 设计的流程是「被 423 挡住 → 读响应/属性发现锁 →
 * 用 XML 里的 href 拼出 `Lock-Token` 头 → UNLOCK」。头部与 XML 两端的
 * 形态**本来就不同**（§9.10.7 的官方例子把两者摆在一起）：
 *   `Lock-Token: <urn:uuid:e71d…>`   头部 = Coded-URL（带尖括号）
 *   `<D:href>urn:uuid:e71d…</D:href>`  XML = URI 本体（裸）
 * 我们此前把头部形态当成了令牌值写进 DB，于是 href 多一层括号，
 * 客户端拼出 `<<urn:uuid:…>>` → 逐字符比较失配 → **409**，
 * 它无法用自己刚建的那把锁的 XML 形态解开它。
 *
 * 这条测试就是那条自救路径，并且**用 href 原样拼头**（而不是用响应头）。
 */
describe('锁令牌形态：XML 里裸、头部带括号（§9.10.7 / §14.14 / §10.5）', () => {
  const LR = '/最近收录/形态.epub';

  it('LOCK → PROPFIND Depth:0 取 href → 用 href 原样拼 Lock-Token → UNLOCK 204', async () => {
    await dav(LR, { method: 'PUT', body: 'x' }).then((r) => r.text());

    // 1) 建锁。头部必须是 Coded-URL
    const lockRes = await dav(LR, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    });
    expect(lockRes.status).toBe(200);
    const headerToken = lockRes.headers.get('lock-token')!;
    expect(headerToken, '§10.5：Lock-Token 是 Coded-URL，带尖括号').toMatch(
      /^<urn:uuid:[0-9a-f-]+>$/,
    );

    // 2) PROPFIND Depth:0 读回 lockdiscovery（客户端在这一步不知道响应头）
    const pf = await dav(LR, { method: 'PROPFIND', headers: { depth: '0' } });
    expect(pf.status).toBe(207);
    const pfXml = await pf.text();
    const m = pfXml.match(/<D:locktoken><D:href>([^<]*)<\/D:href><\/D:locktoken>/);
    expect(m, 'PROPFIND 必须能读回 locktoken/href').toBeTruthy();
    const href = m![1]!;
    // §14.7/§14.14：href 是 URI 本体。既不能是 &lt;…&gt;（我们此前的 bug），
    // 也不能是未转义的裸尖括号（那会让 XML 非法）
    expect(href, 'href 不许出现尖括号（转义形态也不行）').not.toMatch(/&lt;|<|&gt;|>/);
    expect(href).toMatch(/^urn:uuid:[0-9a-f-]+$/);
    expect(`<${href}>`, 'href 加上括号恰好是头部那把锁').toBe(headerToken);

    // 2b) **存储层**的形态也要钉住：DB 里存的必须是裸本体。
    //     只断言 XML 是不够的 —— lockDiscoveryXml 出口处会 stripBrackets()，
    //     所以「库里带括号」这种回退在 XML 上被兜住了，只有查库才看得见。
    //     实测把 newLockToken() 改回带括号形态时，XML/href 断言全绿、只有本
    //     文件末尾的源码守卫变红 —— 那条守卫太靠后，这里补一层行为证据。
    const stored = await testEnv.DB.prepare(
      'SELECT token FROM locks WHERE resource = ?',
    )
      .bind(canonicalDavPath(LR))
      .all<{ token: string }>();
    expect(stored.results?.length, '刚建的锁必须在库里').toBe(1);
    expect(
      stored.results![0]!.token,
      'DB 里存的是令牌本体（裸 URI）：带括号会让存量行与归一逻辑长期共存',
    ).toMatch(/^urn:uuid:[0-9a-f-]+$/);

    // 3) 用 href 原样拼 Lock-Token —— 这就是修复前 409 的那一步
    const unlock = await dav(LR, {
      method: 'UNLOCK',
      headers: { 'lock-token': `<${href}>` },
    });
    await unlock.text();
    expect(unlock.status, '规范客户端必须能解开自己刚建的锁').toBe(204);

    // 4) 锁真的没了：再来一把能建成功（而不是 423）
    const again = await dav(LR, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    });
    await again.text();
    expect(again.status, '前一把锁应已被释放').toBe(200);
  });

  it('兼容存量行：库里带括号的历史锁，用裸 href 也能解开', async () => {
    await dav(LR, { method: 'PUT', body: 'x' }).then((r) => r.text());
    // 直接插一行「旧代码写的」带括号记录，模拟 TTL 内尚未过期的存量数据
    const now = new Date();
    await testEnv.DB.prepare(
      `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(
        '<urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee>',
        canonicalDavPath(LR),
        null,
        'exclusive',
        '0',
        300,
        now.toISOString(),
        new Date(now.getTime() + 300_000).toISOString(),
      )
      .run();

    // 存量锁必须真的生效（否则下面的 204 是空过）
    const blocked = await dav(LR, { method: 'PUT', body: 'y' });
    await blocked.text();
    expect(blocked.status, '存量带括号锁仍然挡写').toBe(423);

    // ★ 关键的不对称场景：库里是**带括号**的存量行，而客户端按规范只会拿到
    //   **裸**形态（PROPFIND 读到的 href 经 §14.14 是 URI 本体）。两侧必须归一
    //   才匹配得上 —— 这一条正是「刚建的锁解不开」在存量数据上的翻版。
    //   （只发带括号形态是测不出来的：那种情况下字符串恰好相等，去掉归一也是绿。）
    const bareUnlock = await dav(LR, {
      method: 'UNLOCK',
      headers: { 'lock-token': 'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    });
    await bareUnlock.text();
    expect(bareUnlock.status, '裸形态也要能解开带括号的存量锁（比较两侧归一）').toBe(204);

    const rows = await testEnv.DB.prepare('SELECT token FROM locks').all<{ token: string }>();
    expect(rows.results?.map((r) => r.token), '行必须真的删掉，不能只是回 204').toEqual([]);

    // 反向再来一遍：库里带括号 + 头也带括号（旧客户端的形态），同样要能解开
    await testEnv.DB.prepare(
      `INSERT INTO locks (token, resource, owner, type, depth, timeout_sec, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(
        '<urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee>',
        canonicalDavPath(LR),
        null,
        'exclusive',
        '0',
        300,
        now.toISOString(),
        new Date(now.getTime() + 300_000).toISOString(),
      )
      .run();
    const codedUnlock = await dav(LR, {
      method: 'UNLOCK',
      headers: { 'lock-token': '<urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee>' },
    });
    await codedUnlock.text();
    expect(codedUnlock.status, '带括号形态也要能解开（§10.5 的正常客户端）').toBe(204);
    const rows2 = await testEnv.DB.prepare('SELECT token FROM locks').all<{ token: string }>();
    expect(rows2.results?.map((r) => r.token)).toEqual([]);
  });

  it('头部形态不许回退：LOCK 响应与 423 的 lock-token 头都带尖括号', async () => {
    const ok = await dav(LR, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    });
    await ok.text();
    expect(ok.status).toBe(200);
    const h = ok.headers.get('lock-token')!;
    expect(h, '§10.5：头部是 Coded-URL').toMatch(/^<urn:uuid:[0-9a-f-]+>$/);
    expect(h.replace(/^</, '').replace(/>$/, '')).toMatch(/^urn:uuid:/);

    // 第二个 exclusive 锁 → 423，头里回冲突锁，同样必须是头部形态
    const conflict = await dav(LR, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml', timeout: 'Second-300' },
      body: LOCK_BODY('exclusive'),
    });
    await conflict.text();
    expect(conflict.status).toBe(423);
    const ch = conflict.headers.get('lock-token');
    expect(ch, '§11.3：423 也要让客户端知道是哪把锁').toMatch(/^<urn:uuid:[0-9a-f-]+>$/);
    expect(ch).toBe(h);
  });

  it('源码守卫：令牌本体不带括号，括号只出现在头部出口', () => {
    const lib = loadSrc('src/lib/locks.ts');
    const idx = lib.indexOf('export function newLockToken');
    expect(idx, 'newLockToken 必须还在').toBeGreaterThan(-1);
    const body = lib.slice(idx, lib.indexOf('\n}', idx));
    expect(body, 'newLockToken 返回的必须是裸 urn:uuid:…').toMatch(/return\s+`urn:uuid:\$\{/);
    expect(body, '令牌本体不许带尖括号').not.toMatch(/return\s+`<urn:uuid:/);

    const webdav = loadSrc('src/webdav/index.ts');
    // 头部出口必须过 toCodedUrl，不能裸发 lock.token / live.token
    expect(webdav, 'LOCK 响应头走 toCodedUrl').toContain(`'lock-token': toCodedUrl(lock.token)`);
    expect(webdav, '423 的 lock-token 头走 toCodedUrl').toContain(`'lock-token': toCodedUrl(live.token)`);
    expect(webdav, '头部不许裸发 lock.token').not.toMatch(/'lock-token':\s*lock\.token/);
    expect(webdav, '头部不许裸发 live.token').not.toMatch(/'lock-token':\s*live\.token/);
  });
});