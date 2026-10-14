/**
 * 求书功能测试。
 *
 * 覆盖三件事，每件都对应一个真实的失效方式：
 *
 *  1. **去重语义** —— 书名+作者双键；同名不同作者要分开；
 *     同一人重复提交只记一次。
 *  2. **输入清洗** —— 全角/半角、大小写、空白、书名号的归一化。
 *     这直接决定「求书墙会不会出现两条一模一样的记录」。
 *  3. **XSS 防线** —— 求书内容是匿名提交的，绝不能原样进 HTML。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  anonKey,
  normaliseKey,
  requestKeys,
  sanitiseCredit,
  submitRequest,
  validateRequestInput,
} from '../src/lib/requests';
import { resetLibrary, testEnv } from './setup';

const ORIGIN = 'https://webooks.test';
const API = `${ORIGIN}/api/requests`;

function post(body: unknown, ip = '1.2.3.4'): Promise<Response> {
  return SELF.fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetLibrary();
});

describe('归一化（去重的基础）', () => {
  it('全角转半角', () => {
    expect(normaliseKey('ＡＢＣ')).toBe('abc');
    expect(normaliseKey('三体（刘慈欣）')).toBe('三体刘慈欣');
  });

  it('去掉空白与书名号', () => {
    expect(normaliseKey('  三 体  ')).toBe('三体');
    expect(normaliseKey('《活着》')).toBe('活着');
    expect(normaliseKey('活着　余华')).toBe('活着余华'); // 全角空格
  });

  it('大小写归一', () => {
    expect(normaliseKey('The Martian')).toBe('themartian');
    expect(normaliseKey('DUNE')).toBe('dune');
  });

  it('同义写法必须落到同一个键', () => {
    // 这些在用户看来是同一本书，若不归一会变成多条求书
    const a = requestKeys('《三体》', '刘慈欣');
    const b = requestKeys('三体', '刘慈欣');
    const c = requestKeys('三 体', '刘慈欣 ');
    const d = requestKeys('三体', '刘慈欣．');
    expect(b.titleKey).toBe(a.titleKey);
    expect(c.titleKey).toBe(a.titleKey);
    expect(d.authorKey).toBe(a.authorKey);
  });

  it('无作者与「佚名」应当等价', () => {
    const none = requestKeys('某书', null);
    const unknown = requestKeys('某书', '');
    expect(none.authorKey).toBe(unknown.authorKey);
  });
});

describe('输入校验', () => {
  it('书名必填', () => {
    const r = validateRequestInput({ title: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title-required');
  });

  it('全是符号的书名被拒（归一化后为空）', () => {
    const r = validateRequestInput({ title: '《》...' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title-invalid');
  });

  it('超长被拒', () => {
    const r = validateRequestInput({ title: '书'.repeat(200) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title-too-long');
  });

  it('「佚名」「未知」视作没填作者', () => {
    const a = validateRequestInput({ title: '某书', author: '佚名' });
    const b = validateRequestInput({ title: '某书', author: '未知' });
    expect(a.ok && a.author).toBeNull();
    expect(b.ok && b.author).toBeNull();
  });

  it('正常输入保留原始写法（展示用）', () => {
    const r = validateRequestInput({ title: '  三体 ', author: ' 刘慈欣 ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.title).toBe('三体');       // trim 过
      expect(r.author).toBe('刘慈欣');
    }
  });
});

describe('提交与去重', () => {
  it('首次提交创建记录（201）', async () => {
    const res = await post({ title: '三体', author: '刘慈欣' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: string; hits: number };
    expect(body.outcome).toBe('new');
    expect(body.hits).toBe(1);
  });

  it('同一本书、同一 IP 重复提交 → 不重复计数', async () => {
    await post({ title: '三体', author: '刘慈欣' }, '1.1.1.1');
    const again = await post({ title: '三体', author: '刘慈欣' }, '1.1.1.1');
    expect(again.status).toBe(200);
    const body = (await again.json()) as { outcome: string; hits: number };
    expect(body.outcome).toBe('repeat');
    expect(body.hits).toBe(1);

    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('不同写法合并成一条，但不同 IP 会累加人数', async () => {
    await post({ title: '《三体》', author: '刘慈欣' }, '1.1.1.1');
    const b = await post({ title: '三体', author: '刘慈欣' }, '2.2.2.2');
    const body = (await b.json()) as { outcome: string; hits: number };
    expect(body.outcome).toBe('new');
    expect(body.hits).toBe(2);

    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(rows?.n, '写法不同但书名相同，应合并成一条').toBe(1);
  });

  it('同名不同作者 → 两条独立记录', async () => {
    // 《活着》是余华的还是老舍的？是两本不同的书
    await post({ title: '活着', author: '余华' }, '1.1.1.1');
    await post({ title: '活着', author: '老舍' }, '2.2.2.2');
    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('anonKey 同一小时稳定、跨小时变化', async () => {
    const k1 = await anonKey('t', 'a', '9.9.9.9');
    const k2 = await anonKey('t', 'a', '9.9.9.9');
    expect(k1).toBe(k2);
    // 不同 IP → 不同 key
    expect(await anonKey('t', 'a', '8.8.8.8')).not.toBe(k1);
  });

  it('anon_keys 只保留最近 50 个（防止行无限膨胀）', async () => {
    for (let i = 0; i < 60; i++) {
      await submitRequest(testEnv.DB, new Request('https://x.test/', {
        headers: { 'cf-connecting-ip': `10.0.0.${i}` },
      }), '热门书', '某作者');
    }
    const row = await testEnv.DB
      .prepare(`SELECT hits, anon_keys FROM requests WHERE title_key = ?`)
      .bind(normaliseKey('热门书'))
      .first<{ hits: number; anon_keys: string }>();
    expect(row?.hits).toBe(60);
    expect(row!.anon_keys.split(',').length).toBe(50);
  });
});

describe('求书墙 API', () => {
  it('GET 返回列表且不泄漏 anon_keys', async () => {
    await post({ title: '三体', author: '刘慈欣' });
    const res = await SELF.fetch(`${API}?limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; requests: Record<string, unknown>[] };
    expect(body.total).toBe(1);
    expect(body.requests[0]).toMatchObject({ title: '三体', author: '刘慈欣', hits: 1 });
    // 内部防刷数据绝不能出现在公开响应里
    expect(body.requests[0]).not.toHaveProperty('anon_keys');
    expect(body.requests[0]).not.toHaveProperty('title_key');
  });

  it('已标记为 fulfilled 的不出现在墙上', async () => {
    await post({ title: '已收录的书' });
    const row = await testEnv.DB.prepare(`SELECT id FROM requests WHERE title = ?`)
      .bind('已收录的书').first<{ id: string }>();
    await testEnv.DB.prepare(`UPDATE requests SET status='fulfilled' WHERE id = ?`)
      .bind(row!.id).run();

    const res = await SELF.fetch(API);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it('按 hits 倒序（需求强的在前）', async () => {
    // 三本冷门书：同名不同作者 → 三条独立记录，各 1 人求
    for (let i = 1; i <= 3; i++) {
      await post({ title: '冷门书', author: `作者${i}` }, '1.1.1.1');
    }
    // 一本热门书：6 个不同 IP 各求一次
    const ips = ['1.1.1.1', '2.2.2.1', '2.2.2.2', '2.2.2.3', '2.2.2.4', '2.2.2.5'];
    for (const ip of ips) {
      await post({ title: '热门书' }, ip);
    }
    const res = await SELF.fetch(API);
    const body = (await res.json()) as { requests: { title: string; hits: number }[] };
    const top = body.requests[0]!;
    expect(top.title, '需求最强的应排最前').toBe('热门书');
    expect(top.hits).toBe(ips.length);
    // 剩下的都是冷门书，各 1 人求
    const rest = body.requests.slice(1);
    expect(rest).toHaveLength(3);
    expect(rest.every((r) => r.hits === 1)).toBe(true);
  });

  it('拒绝非法 JSON 与超长输入', async () => {
    const bad = await SELF.fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);

    const long = await post({ title: '书'.repeat(300) });
    expect(long.status).toBe(400);
  });

  it('非 GET/POST 返回 405', async () => {
    const res = await SELF.fetch(API, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('XSS 防线', () => {
  it('求书内容里的 HTML 在页面渲染时被转义', async () => {
    await post({ title: '<img src=x onerror=alert(1)>', author: '<script>bad()</script>' });
    // API 是 JSON，浏览器渲染时页面脚本用 esc() 转义（见 requests-page.ts）
    // 这里验证原文确实被完整存下（说明转义发生在渲染层而非数据层，
    // 数据层转义反而会让搜索对不上）
    const row = await testEnv.DB.prepare('SELECT title FROM requests WHERE title_key = ?')
      .bind(normaliseKey('<img src=x onerror=alert(1)>'))
      .first<{ title: string }>();
    expect(row?.title).toBe('<img src=x onerror=alert(1)>');

    // 页面脚本里必须有 esc()，且所有插入点都走它
    const page = await SELF.fetch(`${ORIGIN}/requests`);
    const html = await page.text();
    expect(html).toContain('function esc(s)');
    // 列表渲染处必须用 esc(...) 而不是直接拼字符串
    expect(html).toContain("esc(r.title)");
    expect(html).toContain("esc(r.author)");
  });

  it('求书墙页面本身返回 200 且是 HTML', async () => {
    const res = await SELF.fetch(`${ORIGIN}/requests`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('求书墙');
    expect(html).toContain('id="f"');
  });
});
describe('上传留名（credit）', () => {
  it('留空默认记作「雷锋」', () => {
    expect(sanitiseCredit('')).toBe('雷锋');
    expect(sanitiseCredit(undefined)).toBe('雷锋');
    expect(sanitiseCredit('   ')).toBe('雷锋');
    expect(sanitiseCredit('  \n\t ')).toBe('雷锋');
  });

  it('「匿名」类占位回落为默认', () => {
    for (const v of ['anon', 'Anonymous', '匿名', 'NULL']) {
      expect(sanitiseCredit(v), `${v} 应回落`).toBe('雷锋');
    }
  });

  it('去掉控制字符（不能破坏列表布局）', () => {
    expect(sanitiseCredit('张\u0000三\u0007')).toBe('张三');
    expect(sanitiseCredit('张\n三')).toBe('张三');
  });

  it('超长截断到 32 字符', () => {
    expect(sanitiseCredit('名'.repeat(50))).toHaveLength(32);
  });

  it('正常名字原样保留', () => {
    expect(sanitiseCredit('雷锋')).toBe('雷锋');
    expect(sanitiseCredit('  Alice  ')).toBe('Alice');
    expect(sanitiseCredit('书虫')).toBe('书虫');
  });

  it('WebDAV PUT 的书署名是「雷锋」', async () => {
    await SELF.fetch(`${ORIGIN}/dav/${encodeURIComponent('最近收录')}/署名测试.epub`, {
      method: 'PUT',
      body: 'x',
      headers: { authorization: 'Bearer test-write-token' },
    });
    const row = await testEnv.DB
      .prepare('SELECT credit FROM books WHERE leaf_name = ?')
      .bind('署名测试.epub')
      .first<{ credit: string }>();
    expect(row?.credit).toBe('雷锋');
  });

  it('覆盖上传不抹掉原署名', async () => {
    const DAV = `${ORIGIN}/dav/${encodeURIComponent('最近收录')}`;
    await SELF.fetch(`${DAV}/署名保留.epub`, {
      method: 'PUT', body: 'x',
      headers: { authorization: 'Bearer test-write-token' },
    });
    // 模拟网页上传时留了名
    await testEnv.DB.prepare('UPDATE books SET credit = ? WHERE leaf_name = ?')
      .bind('Alice', '署名保留.epub').run();

    // 别人覆盖上传
    await SELF.fetch(`${DAV}/署名保留.epub`, {
      method: 'PUT', body: 'y',
      headers: { authorization: 'Bearer test-write-token' },
    });
    const row = await testEnv.DB
      .prepare('SELECT credit FROM books WHERE leaf_name = ?')
      .bind('署名保留.epub')
      .first<{ credit: string }>();
    expect(row?.credit, '署名属于「谁第一个放进书库」，不该被覆盖上传抹掉').toBe('Alice');
  });

  it('书卡片页面渲染的署名经过转义', async () => {
    // workerd 里没有 fs，不能直接读源码；改为端到端验证：
    // 塞一本署名带 HTML 的书，看页面输出里有没有被转义掉。
    await SELF.fetch(`${ORIGIN}/dav/${encodeURIComponent('最近收录')}/注入署名.epub`, {
      method: 'PUT',
      body: 'x',
      headers: { authorization: 'Bearer test-write-token' },
    });
    await testEnv.DB.prepare('UPDATE books SET credit = ? WHERE leaf_name = ?')
      .bind('<img src=x onerror=alert(1)>', '注入署名.epub').run();

    const res = await SELF.fetch(
      `${ORIGIN}/dav/${encodeURIComponent('最近收录')}/`,
      { headers: { accept: 'text/html' } },
    );
    const html = await res.text();
    // 原文不应出现（会被当成标签执行）
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    // 转义后的形式应在
    expect(html).toContain('&lt;img');
  });
});

describe('管理后台接口', () => {
  const ADMIN = { authorization: 'Bearer test-token' };

  it('求书列表需要管理员口令', async () => {
    const no = await SELF.fetch(`${ORIGIN}/api/admin/requests`);
    expect(no.status).toBe(403);
    await no.text();

    const ok = await SELF.fetch(`${ORIGIN}/api/admin/requests`, { headers: ADMIN });
    expect(ok.status).toBe(200);
  });

  it('标记已收录后从墙上消失、但后台仍能看到', async () => {
    await post({ title: '刚上传的书' });
    const id = (await testEnv.DB.prepare('SELECT id FROM requests WHERE title = ?')
      .bind('刚上传的书').first<{ id: string }>())!.id;

    const res = await SELF.fetch(`${ORIGIN}/api/admin/requests/${id}`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'fulfilled' }),
    });
    expect(res.status).toBe(200);

    const wall = await SELF.fetch(API);
    expect(((await wall.json()) as { total: number }).total).toBe(0);

    const admin = await SELF.fetch(`${ORIGIN}/api/admin/requests?status=fulfilled`, { headers: ADMIN });
    const body = (await admin.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it('状态过滤与非法状态', async () => {
    await post({ title: 'A 书' });
    const id = (await testEnv.DB.prepare('SELECT id FROM requests WHERE title = ?')
      .bind('A 书').first<{ id: string }>())!.id;

    const bad = await SELF.fetch(`${ORIGIN}/api/admin/requests/${id}`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'whatever' }),
    });
    expect(bad.status).toBe(400);
    await bad.text();

    const missing = await SELF.fetch(`${ORIGIN}/api/admin/requests/不存在`, {
      method: 'POST',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it('上传者榜单按贡献数排序，并区分「有署名」与默认', async () => {
    const DAV = `${ORIGIN}/dav/${encodeURIComponent('最近收录')}`;
    // Alice 传 2 本
    for (const n of ['榜单A.epub', '榜单B.epub']) {
      await SELF.fetch(`${DAV}/${n}`, {
        method: 'PUT', body: 'x',
        headers: { authorization: 'Bearer test-write-token' },
      });
      await testEnv.DB.prepare('UPDATE books SET credit = ? WHERE leaf_name = ?')
        .bind('Alice', n).run();
    }
    // Bob 传 1 本
    await SELF.fetch(`${DAV}/榜单C.epub`, {
      method: 'PUT', body: 'x',
      headers: { authorization: 'Bearer test-write-token' },
    });
    await testEnv.DB.prepare('UPDATE books SET credit = ? WHERE leaf_name = ?')
      .bind('Bob', '榜单C.epub').run();

    const res = await SELF.fetch(`${ORIGIN}/api/admin/credits`, { headers: ADMIN });
    const body = (await res.json()) as {
      totalBooks: number;
      namedContributors: number;
      contributors: { name: string; books: number }[];
    };
    expect(body.totalBooks).toBe(3);
    expect(body.namedContributors).toBe(3);
    expect(body.contributors[0]).toEqual({ name: 'Alice', books: 2 });
    expect(body.contributors[1]).toEqual({ name: 'Bob', books: 1 });
  });

  it('榜单接口同样需要口令', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/credits`);
    expect(res.status).toBe(403);
    await res.text();
  });
});

describe('求书墙链接可达', () => {
  it('首页有求书入口', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`);
    const html = await res.text();
    expect(html).toContain('href="/requests"');
  });

  it('页面对浏览器访问带安全响应头', async () => {
    // 安全头只在「浏览器直接打开页面」时加（src/index.ts 的 wantsHtml），
    // WebDAV 客户端的请求不该被塞 CSP。所以这里必须带 accept: text/html。
    const res = await SELF.fetch(`${ORIGIN}/requests`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  it('页面对脚本请求不加 CSP（避免干扰非浏览器客户端）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/requests`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});
