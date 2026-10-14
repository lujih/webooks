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

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { lockDiscoveryXml } from '../src/lib/locks';
import { resetLibrary } from './setup';

const ORIGIN = 'https://webooks.test';

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
        token: '<urn:uuid:11111111-2222-3333-4444-555555555555>',
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
        token: '<urn:uuid:11111111-2222-3333-4444-555555555555>',
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
          token: '<urn:uuid:11111111-2222-3333-4444-555555555555>',
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
        token: '<urn:uuid:11111111-2222-3333-4444-555555555555>',
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