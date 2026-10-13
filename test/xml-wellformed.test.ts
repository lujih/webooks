/**
 * WebDAV 响应必须是良构 XML。
 *
 * 真实事故（本文件的由来）：
 *   LOCK 响应里 `<D:locktoken>` 开了两次只关一次 → 不是合法 XML。
 *   .NET 的 XmlDocument 报 "The 'D:locktoken' start tag does not match
 *   the end tag of 'D:lock'"，所有严格客户端都会挂。
 *   而当时的测试只做 `expect(xml).toContain(...)`，字符串里有那个片段就通过了，
 *   完全测不出「它不是合法 XML」。
 *
 * 所以这里：先用**线上抓到的真实坏样本**证明检查器会报错，
 * 再对所有会产出 XML 的接口做检查。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkXmlWellFormed } from './xml-wellformed-lib';
import { testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const DIR = '/dav/最近收录/';
const LEAF = '/dav/最近收录/probe.epub';
const LOCKINFO =
  '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:">' +
  '<D:lockscope><D:exclusive/></D:lockscope>' +
  '<D:locktype><D:write/></D:locktype>' +
  '<D:owner>tester</D:owner></D:lockinfo>';

function dav(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { authorization: 'Bearer test-write-token', ...(init.headers as Record<string, string>) },
  });
}

/** 断言响应体是良构 XML，失败时打印出错位置，便于定位 */
async function expectWellFormedXml(res: Response, label: string): Promise<string> {
  const xml = await res.text();
  const r = checkXmlWellFormed(xml);
  if (!r.valid) {
    throw new Error(`${label} 的响应不是良构 XML：${r.err?.msg}（第 ${r.err?.line} 行）\n${xml}`);
  }
  return xml;
}

beforeEach(async () => {
  await testEnv.DB.exec('DELETE FROM books; DELETE FROM buckets; DELETE FROM locks;');
});

describe('检查器自身可信（先证明它会报错）', () => {
  it('能识别线上抓到的真实坏样本', () => {
    // 这是从生产环境 curl 下来的**原文**，曾被判为「合法」而漏过
    const realBad =
      '<D:lockdiscovery><D:lock><D:lockscope><D:exclusive/></D:lockscope>' +
      '<D:locktype><D:write/></D:locktype><D:depth>infinity</D:depth>' +
      '<D:timeout>Second-300</D:timeout>' +
      '<D:locktoken><D:locktoken><D:href>urn:uuid:x</D:href></D:locktoken>' +
      '<D:owner>test</D:owner></D:lock></D:lockdiscovery>';
    const r = checkXmlWellFormed(realBad);
    expect(r.valid, '检查器必须能抓出这个真实缺陷').toBe(false);
  });

  it('能识别 lockdiscovery 嵌套自身', () => {
    const nested =
      '<D:lockdiscovery><D:lockdiscovery><D:lock></D:lock></D:lockdiscovery>';
    expect(checkXmlWellFormed(nested).valid).toBe(false);
  });

  it('合法样本判为合法（避免误报）', () => {
    expect(checkXmlWellFormed('<D:prop xmlns:D="DAV:"><D:lockdiscovery/></D:prop>').valid).toBe(true);
    expect(checkXmlWellFormed('<?xml version="1.0" encoding="utf-8"?>\n<a b="c"><d/></a>').valid).toBe(true);
    expect(checkXmlWellFormed('<a>text &amp; more</a>').valid).toBe(true);
  });
});

describe('每个产出 XML 的接口都必须是良构 XML', () => {
  it('PROPFIND 根目录 (207)', async () => {
    const res = await dav('/dav/', {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    expect(res.status).toBe(207);
    await expectWellFormedXml(res, 'PROPFIND 根目录');
  });

  it('PROPFIND 列表页 (207)', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    const res = await dav(DIR, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    await expectWellFormedXml(res, 'PROPFIND 列表页');
  });

  it('LOCK 成功 (200) —— 曾是不合法 XML', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    const res = await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    });
    expect(res.status).toBe(200);
    await expectWellFormedXml(res, 'LOCK 成功');
  });

  it('LOCK 成功体把 lockdiscovery 放在 prop 里（RFC 4918 §9.10.1）', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    const res = await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    });
    const xml = await res.text();
    expect(xml).toMatch(/<D:prop[\s>]/);
    expect(xml).toContain('<D:lockdiscovery>');
  });

  it('LOCK 冲突 (423) —— 曾把 lockdiscovery 嵌进自己', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    }).then((r) => r.text());

    const res = await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    });
    expect(res.status).toBe(423);
    await expectWellFormedXml(res, 'LOCK 冲突');
  });

  it('PROPFIND 带活锁时 lockdiscovery 注入路径也是良构的', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    }).then((r) => r.text());

    const res = await dav(DIR, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/><D:getetag/></D:prop></D:propfind>',
    });
    await expectWellFormedXml(res, 'PROPFIND 带活锁');
  });

  it('被锁资源上写操作 (423) 也是良构的', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    }).then((r) => r.text());

    const res = await dav(LEAF, { method: 'PUT', body: 'y' });
    if (res.status === 423) await expectWellFormedXml(res, '被锁写入 423');
    else await res.text();
  });
});

describe('锁令牌在 XML 里的表示', () => {
  it('正文里的 href 是转义后的 URI；解析出来等于 Lock-Token 头的裸 URI', async () => {
    await dav(LEAF, { method: 'PUT', body: 'x' });
    const res = await dav(LEAF, {
      method: 'LOCK',
      headers: { 'content-type': 'application/xml' },
      body: LOCKINFO,
    });
    const xml = await res.text();
    const header = res.headers.get('lock-token') ?? '';
    expect(header).toMatch(/^<urn:uuid:[0-9a-f-]+>$/);
    const bare = header.slice(1, -1);

    // 令牌本身含尖括号，必须做 XML 转义，否则不是良构 XML（实测过）。
    // 转义是「文本层表示」，解析后客户端拿到的仍是裸 URI。
    expect(xml).toContain(`<D:href>&lt;${bare}&gt;</D:href>`);
    // 绝不能出现未转义的裸尖括号令牌（那会让 XML 非法）
    expect(xml).not.toContain(`<D:href><${bare}>`);

    // 用解析器确认：转义还原后正好等于响应头里的令牌
    const m = xml.match(/<D:locktoken><D:href>([^<]*)<\/D:href><\/D:locktoken>/);
    expect(m, '应能取出 locktoken/href').toBeTruthy();
    const decoded = m![1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(decoded).toBe(header);
  });
});

describe('Timeout 头按 RFC 4918 §10.7 解析（Second-<digits>）', () => {
  it('Second-600 真的被采纳（不是静默退回默认值）', async () => {
    const { parseTimeoutHeader, INFINITE_LOCK_SECONDS, DEFAULT_LOCK_SECONDS } =
      await import('../src/lib/locks');
    // RFC 4918 §10.7 的合法写法是 Second-<digits>
    expect(parseTimeoutHeader('Second-600')).toBe(600);
    expect(parseTimeoutHeader('Second-1200')).toBe(1200);
    // 旧实现写的是 Second-N=300（把 BNF 里的 N 当字面量），任何客户端超时都被忽略
    expect(parseTimeoutHeader('Second-N=300')).toBe(DEFAULT_LOCK_SECONDS);
    expect(parseTimeoutHeader('garbage')).toBe(DEFAULT_LOCK_SECONDS);
    expect(parseTimeoutHeader(null)).toBe(DEFAULT_LOCK_SECONDS);
    // Infinite 被有意钳到 1 小时，避免锁表无限膨胀
    expect(parseTimeoutHeader('Infinite')).toBe(INFINITE_LOCK_SECONDS);
    // 超过上限也钳住
    expect(parseTimeoutHeader('Second-99999999')).toBe(INFINITE_LOCK_SECONDS);
    // 逗号分隔的候选列表：取第一个服务端能接受的
    expect(parseTimeoutHeader('bogus, Second-600')).toBe(600);
    expect(parseTimeoutHeader('Infinite, Second-300')).toBe(INFINITE_LOCK_SECONDS);
  });
});
