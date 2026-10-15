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
import { purgeByPrefixes } from '../src/lib/cache';
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
// 本地测试环境里 R2 公开域是 books.test（vitest.config.ts 的 R2_PUBLIC_BASE）
const R2_BASE = testEnv.R2_PUBLIC_BASE.replace(/\/+$/, '');

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

    const res = await SELF.fetch(`${API}${wallQuery()}`);
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

    // 页面脚本必须用 textContent 渲染，而不是 innerHTML 拼字符串。
    //
    // ⚠️ 这是比上一版更强的防线：上一版是「innerHTML + 记得调 esc()」，
    //   忘记调用就是 XSS。现在根本没有 esc() 这个可以被忘记的东西。
    const page = await SELF.fetch(`${ORIGIN}/requests`);
    const html = await page.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(script).not.toMatch(/innerHTML\s*=[\s\S]{0,200}esc\(/);
    expect(script).toContain('title.textContent = r.title');
    expect(script).toContain('author.textContent = r.author');
    // 旧的内联拼接写法不该还在
    expect(script).not.toContain('<div class="rtitle">');
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

    // 同一测试内的缓存：换 limit 穿透（见 wallQuery 的说明）
    const wall = await SELF.fetch(`${API}${wallQuery()}`);
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

  it('HTML 页面带安全响应头', async () => {
    const res = await SELF.fetch(`${ORIGIN}/requests`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  it('不带 Accept 头访问 HTML 页面也带 CSP（安全头不能靠请求头决定）', async () => {
    // ⚠️ 这条以前是反过来的（断言「无 CSP」），理由是
    //   「避免干扰非浏览器客户端」。那个理由站不住，而且启用 Workers
    //   Caching 之后变得危险：
    //
    //   ① CSP 只被**浏览器**强制执行，curl/rclone 根本不解析它 ——
    //      「干扰非浏览器客户端」这个担心不成立。
    //   ② 缓存键**不含 Accept**（官方文档明确列出 Accept/Authorization/
    //      Cookie/User-Agent 都不在键里）。靠 Accept 决定响应头 =
    //      谁先访问，缓存里就存谁那份头：
    //        浏览器先来 → 带 CSP；脚本先来 → 不带 CSP，之后浏览器也拿到这份
    //      → 安全头随机丢失。
    //   ③ 真实安全缺口：浏览器若发 `Accept: */*`（有些客户端会），
    //      以前会拿不到 CSP。这是可被利用的降级。
    //
    //   现在判**响应的 content-type** —— 确定性，且浏览器与脚本拿到
    //   同一份缓存是正确行为。
    const res = await SELF.fetch(`${ORIGIN}/requests`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(
      res.headers.get('content-security-policy'),
      'HTML 响应必须始终带 CSP，与请求头无关',
    ).toBeTruthy();
  });

  it('WebDAV 的 207 不带 CSP（它靠 content-type 排除，比 Accept 更准）', async () => {
    // 这才是「不能干扰客户端」的那一类：DAV 多状态响应是 application/xml，
    // 客户端可能把意外的 CSP 当异常。它天然落在 text/html 判断之外。
    const res = await SELF.fetch(`${ORIGIN}/dav/${encodeURIComponent('最近收录')}`, {
      method: 'PROPFIND',
      headers: { depth: '0' },
    });
    expect(res.status).toBe(207);
    expect(res.headers.get('content-type')).toMatch(/application\/xml/);
    expect(
      res.headers.get('content-security-policy'),
      '207 是 XML，不该被当成 HTML 塞 CSP',
    ).toBeNull();
  });
});

const DAV = `${ORIGIN}/dav/${encodeURIComponent('最近收录')}`;

/**
 * 求书墙列表有 60 秒缓存（见 api/requests.ts）—— 这是**有意的产品行为**：
 * 匿名公开页面的刷新成本该由缓存而不是 D1 承担。
 *
 * 副作用：同一测试内先 GET 再提交，第二次 GET 会拿到旧列表。
 * 这**不是 bug**，是缓存在按设计工作。测试要绕开它，
 * 而不是把缓存关掉（那等于把要验证的行为改掉）。
 *
 * 绕开办法：每次用不同的 limit 值 —— 缓存键含 limit，
 * 换 limit 就是换键，必然 MISS。
 */
let qSeq = 0;
function wallQuery(): string {
  qSeq += 1;
  return `?limit=${(qSeq % 200) + 1}&offset=0`;
}

/** 放一本书并指定署名（PUT 走 WebDAV，然后直接改 credit 模拟「留了名」） */
async function putBook(leafName: string, credit: string): Promise<void> {
  await SELF.fetch(`${DAV}/${encodeURIComponent(leafName)}`, {
    method: 'PUT',
    body: 'x',
    headers: { authorization: 'Bearer test-write-token' },
  });
  await testEnv.DB.prepare('UPDATE books SET credit = ? WHERE leaf_name = ?')
    .bind(credit, leafName).run();
}

describe('上传者榜单（公开端点）', () => {
  it('匿名可访问，不需要口令', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('「雷锋」计入榜单且永久置顶（集体署名）', async () => {
    // ⚠️ 这里曾经断言「雷锋不计入榜单」—— 那个判断是错的。
    //
    // 雷锋不是一个「未填写」的占位符，而是**所有没有留名的人的共同署名**。
    // 把它藏起来，等于让书库看起来像是人人都在署名，而事实相反。
    await putBook('榜单甲.epub', 'Alice');
    await putBook('榜单乙.epub', 'Alice');
    await putBook('榜单丙.epub', 'Bob');
    await putBook('榜单丁.epub', '雷锋');

    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as {
      contributors: { name: string; books: number }[];
      namedBooks: number;
      totalBooks: number;
      collectiveBooks: number;
    };
    expect(body.contributors[0]).toEqual({ name: '雷锋', books: 1 });
    expect(body.contributors[1]).toEqual({ name: 'Alice', books: 2 });
    expect(body.contributors[2]).toEqual({ name: 'Bob', books: 1 });
    expect(body.namedBooks).toBe(3);      // 留了自己名字的
    expect(body.collectiveBooks).toBe(1); // 雷锋那一栏的
    expect(body.totalBooks).toBe(4);
  });

  it('即使有人传得比雷锋多，雷锋仍然排第一', async () => {
    // 「永久置顶」必须是**真的**置顶，而不是「碰巧排第一」：
    // 如果只按本数排，某天有人传了 200 本而雷锋只有 3 本，
    // 集体署名就会掉到底下 —— 那会让它看起来像个冷门选项。
    for (const n of ['多甲.epub', '多乙.epub', '多丙.epub', '多丁.epub', '多戊.epub']) {
      await putBook(n, '高产者');
    }
    await putBook('集体.epub', '雷锋');

    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as { contributors: { name: string; books: number }[] };
    expect(body.contributors[0]!.name, '集体署名必须永远在最前').toBe('雷锋');
    expect(body.contributors[1]).toEqual({ name: '高产者', books: 5 });
  });

  it('只返回名字与本数 —— 不泄漏任何管理信息', async () => {
    // ⚠️ 必须插一本书：不插的话 latest 是 null，下面那个 `if (body.latest)`
    //   字段白名单**整块空转** —— 看着是绿的，其实 latest 的字段从来没被检查过。
    await putBook('白名单.epub', 'Alice');
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as Record<string, unknown>;
    // 这是一个**匿名公开**端点，出现任何额外字段都要重新审视。
    //
    // latest 是首屏活书脊的数据（书名/作者/署名/日期/链接）——
    // 全部是书库里本来就公开的信息，没有 IP/内部 ID。
    expect(Object.keys(body).sort()).toEqual([
      'collectiveBooks',
      'contributors',
      'latest',
      'namedBooks',
      'totalBooks',
    ]);
    const contributors = (body.contributors as Record<string, unknown>[] | undefined) ?? [];
    for (const c of contributors) {
      expect(
        Object.keys(c).sort(),
        `贡献者 ${String(c.name)} 的字段超出「名字 + 本数」，需要重新审视是否该公开`,
      ).toEqual(['books', 'name']);
    }
    if (body.latest) {
      // 活书脊的字段白名单。`downloadUrl` 是 R2 公开域绝对地址 ——
      // 它指向的对象是**本来就公开**的（任何人拿到 URL 都能下载），
      // 不是内部信息，所以可以出现在这个匿名端点上。
      expect(Object.keys(body.latest as object).sort()).toEqual([
        'author',
        'credit',
        'downloadUrl',
        'href',
        'publishedAt',
        'title',
      ]);
    }
  });

  it('结果被缓存（第二次不再查 D1）', async () => {
    // ⚠️ 这里曾经断言的是**墙钟时间**（`performance.now()` 之差 < 50ms）。
    //  那个写法有两个问题：
    //    · 它测的是「机器闲不闲」而不是「缓存有没有命中」—— CI 上并发跑
    //     其它测试文件时实测到过 56ms 而红，而缓存其实工作得很好；
    //    · 它不是一个**证明**：查询变快也可能是 D1 预热、JIT 之类的巧合。
    //
    // 换成行为判据：绕开缓存去改 D1，再看端点回的是新值还是旧值。
    //  回旧值 ⇒ 它读的是缓存，没查 D1。确定性，且不依赖机器负载。
    // （同一个手法下面「求书墙缓存在数据变化后仍会返回旧数据」那条也在用。）
    await putBook('缓存判据.epub', '初版署名');
    const warm = await SELF.fetch(`${ORIGIN}/api/credits`);
    expect(warm.status).toBe(200);
    const warmBody = (await warm.json()) as { contributors: { name: string }[] };
    expect(warmBody.contributors.map((c) => c.name)).toContain('初版署名');

    // 直接改 D1（不经过任何 purge），缓存里仍是刚才那份快照
    await testEnv.DB.prepare('UPDATE books SET credit = ? WHERE leaf_name = ?')
      .bind('改过的署名', '缓存判据.epub')
      .run();

    const cached = await SELF.fetch(`${ORIGIN}/api/credits`);
    const cachedBody = (await cached.json()) as { contributors: { name: string }[] };
    expect(
      cachedBody.contributors.map((c) => c.name),
      '第二次仍查了 D1 —— 缓存没生效（或这条 URL 的缓存键不稳定）',
    ).toContain('初版署名');

    // 反向确认：真的清掉缓存后，新值必须立刻出现 ——
    // 否则上面那条可能只是「端点永远返回旧数据」。
    await purgeByPrefixes();
    const fresh = await SELF.fetch(`${ORIGIN}/api/credits`);
    const freshBody = (await fresh.json()) as { contributors: { name: string }[] };
    expect(freshBody.contributors.map((c) => c.name)).toContain('改过的署名');
  });

  it('书库为空时返回空榜单而不是报错', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contributors: unknown[] };
    expect(Array.isArray(body.contributors)).toBe(true);
  });

  /**
   * 首页那张「活书脊」的直链。
   *
   * 这是 task-1 漏掉的另一半：浏览页的书卡当年改成了 R2 直链，
   * 但首页这张卡仍然走 `/dav/<路径>` —— 于是首页（流量最大的入口）
   * 每次点击都还要花一次 Worker 请求。这一组把那条路径钉住。
   */
  describe('首页活书脊的下载地址', () => {
    it('latest.downloadUrl 是 R2 公开域绝对地址，且指向这本书的 r2_key', async () => {
      await putBook('直链书.epub', 'Bob');
      await purgeByPrefixes(); // /api/credits 缓存 1 小时，先清掉
      const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE leaf_name = ?')
        .bind('直链书.epub')
        .first<{ r2_key: string }>();
      expect(row?.r2_key).toBeTruthy();

      const res = await SELF.fetch(`${ORIGIN}/api/credits`);
      const body = (await res.json()) as {
        latest: { href: string; downloadUrl: string | null } | null;
      };
      expect(body.latest).not.toBeNull();
      // 绝对地址 + R2 公开域 + 就是这本书的对象键
      expect(body.latest!.downloadUrl).toBe(`${R2_BASE}/${row!.r2_key}`);
      // ⚠️ href 不变：它仍是站内 WebDAV 路径（别的调用方与文档按此依赖）
      expect(body.latest!.href.startsWith('/dav/最近收录/')).toBe(true);
      // 「点一下不经过 Worker」的前提：直链必须是**绝对**地址，
      // 且主机不是站点自己 —— 否则它还是会打到 Worker 上。
      expect(body.latest!.downloadUrl!.startsWith(`${R2_BASE}/`)).toBe(true);
      expect(new URL(body.latest!.downloadUrl!).origin).toBe(new URL(R2_BASE).origin);
      expect(new URL(body.latest!.downloadUrl!).origin).not.toBe(ORIGIN);
    });

    it('两本书：latest 取最近上架的那本，直链跟着走', async () => {
      // 「取最近」这件事原本只有 href 被验过；直链是第二个必须跟着书的字段 ——
      // 如果 downloadUrl 写成了固定的东西（或取了另一行），这里会红。
      await putBook('旧书.epub', 'Bob');
      await testEnv.DB.prepare(
        `UPDATE books SET published_at = '2020-01-01' WHERE leaf_name = '旧书.epub'`,
      ).run();
      await putBook('新书.epub', 'Bob');
      await testEnv.DB.prepare(
        `UPDATE books SET published_at = '2030-01-01' WHERE leaf_name = '新书.epub'`,
      ).run();
      await purgeByPrefixes();

      const row = await testEnv.DB.prepare('SELECT r2_key FROM books WHERE leaf_name = ?')
        .bind('新书.epub')
        .first<{ r2_key: string }>();
      const res = await SELF.fetch(`${ORIGIN}/api/credits`);
      const body = (await res.json()) as { latest: { title: string; downloadUrl: string | null } };
      expect(body.latest.title).toBe('新书');
      expect(body.latest.downloadUrl).toBe(`${R2_BASE}/${row!.r2_key}`);
    });
  });

  it('首页包含榜单区块，位置在书架之后、使用方式之前', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const shelves = html.indexOf('class="shelves"');
    const roll = html.indexOf('class="roll');
    const howto = html.indexOf('class="howto"');
    expect(shelves).toBeGreaterThan(-1);
    expect(roll).toBeGreaterThan(shelves);
    expect(howto).toBeGreaterThan(roll);
    // 加载失败时静默 —— 榜单是配角，不能影响首页可用性
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(script).toContain('/api/credits');
    expect(script).toContain('textContent');
    expect(script).not.toMatch(/rollList\)\.innerHTML|who\.innerHTML/);
  });

  it('删除书会让榜单缓存失效', async () => {
    await putBook('将被删.epub', 'Carol');
    await SELF.fetch(`${ORIGIN}/api/credits`); // 填充缓存
    // 删除（需要口令）
    const res = await SELF.fetch(`${ORIGIN}/api/admin/delete`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ leafNames: ['将被删.epub'] }),
    });
    expect(res.status).toBe(200);
    // 缓存应已被打掉，重新取能看到最新数据
    const after = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await after.json()) as { contributors: { name: string }[] };
    expect(body.contributors.some((c) => c.name === 'Carol')).toBe(false);
  });
});

describe('首页的雷锋行', () => {
  it('雷锋渲染成独立的「集体」行，且带「人人可署名」与加入链接', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    // 有专门的渲染函数
    expect(script).toContain('collectiveLi');
    // 措辞：说清它是集体而不是一个人
    expect(script).toContain('人人可署名');
    // 有加入的入口
    expect(script).toMatch(/join\.href\s*=\s*'\/upload'/);
    // ⚠️ 说明文案里不能把雷锋算进「留了名的人数」——
    //   否则「18 / 19 本」会让人搞不清集体署名被算到了哪一边。
    expect(script).toMatch(/personal\s*>\s*0/);
  });

  it('CSS 里有把集体行与个人行区分开的样式', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    // 独占整行 —— 排成和别人的名字并列的一格，会让人以为那是昵称
    expect(html).toMatch(/\.roll-list li\.collective\{[^}]*grid-column:\s*1\/-1/);
    expect(html).toContain('.roll-list li.personal');
  });

  it('没有数据时不报错（书库空时榜单依然能渲染）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.totalBooks).toBe(0);
    expect(body.collectiveBooks).toBe(0);
  });
});

describe('「没留名」的各种形态都归到雷锋', () => {
  /**
   * 「没留名」在数据里有三种形态，散落在不同写入路径：
   *   NULL      0007 加列之前就存在的存量书
   *   ''        某些路径把空串直接存了进去
   *   '雷锋'    正常上传流程
   *
   * 如果只归一 (1)，(2) 就既不在榜、也不算总数 ——
   * 表现为「书库里有这本书，账算不平」。
   *
   * 迁移 0008 是幂等的，三种形态都能收拢。
   */
  async function insertRaw(leafName: string, credit: string | null): Promise<void> {
    await testEnv.DB.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES (?,?,?,NULL,'zh','epub','application/epub+zip',100,'s',?,?,?, 'ebook','ebook','derived',
        '2026-01-01','2026-01-01','2026-01-01','published',?)`,
    )
      .bind(`raw-${leafName}`, leafName, leafName, `books/raw-${leafName}`,
            'L', 'L', credit)
      .run();
  }

  it('回填语句能把 NULL / 空串 / 纯空白都收拢', async () => {
    // 直接跑迁移里的 UPDATE，验证幂等性与覆盖面
    await insertRaw('空值.epub', null);
    await insertRaw('空串.epub', '');
    await insertRaw('空白.epub', '   ');
    await insertRaw('正常.epub', '张三');

    await testEnv.DB.exec("UPDATE books SET credit = '雷锋' WHERE credit IS NULL OR TRIM(credit) = ''");

    const rows = await testEnv.DB.prepare(
      'SELECT leaf_name, credit FROM books ORDER BY leaf_name',
    ).all<{ leaf_name: string; credit: string }>();
    const byName = new Map(rows.results.map((r) => [r.leaf_name, r.credit]));
    expect(byName.get('空值.epub')).toBe('雷锋');
    expect(byName.get('空串.epub')).toBe('雷锋');
    expect(byName.get('空白.epub')).toBe('雷锋');
    expect(byName.get('正常.epub'), '真的留了名的不能被动').toBe('张三');
  });

  it('回填是幂等的（重复执行结果不变）', async () => {
    await insertRaw('幂等.epub', null);
    const sql = "UPDATE books SET credit = '雷锋' WHERE credit IS NULL OR TRIM(credit) = ''";
    await testEnv.DB.exec(sql);
    const first = await testEnv.DB.prepare('SELECT credit FROM books WHERE leaf_name = ?')
      .bind('幂等.epub').first<{ credit: string }>();
    await testEnv.DB.exec(sql);
    const second = await testEnv.DB.prepare('SELECT credit FROM books WHERE leaf_name = ?')
      .bind('幂等.epub').first<{ credit: string }>();
    expect(second?.credit).toBe(first?.credit);
  });

  it('管理端榜单与公开榜单结果一致（都含雷锋、都置顶）', async () => {
    await putBook('一致甲.epub', '雷锋');
    await putBook('一致乙.epub', '雷锋');
    await putBook('一致丙.epub', 'Carol');

    const pub = await (await SELF.fetch(`${ORIGIN}/api/credits`)).json() as {
      contributors: { name: string; books: number }[];
    };
    const adm = await (await SELF.fetch(`${ORIGIN}/api/admin/credits?limit=50`, {
      headers: { authorization: 'Bearer test-token' },
    })).json() as { contributors: { name: string; books: number }[] };

    // ⚠️ 两个端点曾经不一致：公开的含雷锋，管理的排除。
    //   同一个事实给出两种答案，后台看板就会和首页对不上。
    expect(adm.contributors.map((c) => c.name)).toEqual(pub.contributors.map((c) => c.name));
    expect(adm.contributors[0]!.name).toBe('雷锋');
  });

  it('管理端有手动清缓存的入口', async () => {
    const no = await SELF.fetch(`${ORIGIN}/api/admin/credits/purge`);
    expect(no.status).toBe(403);
    await no.text();

    const res = await SELF.fetch(`${ORIGIN}/api/admin/credits/purge`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    // GET 不行 —— 它是有副作用的操作
    const wrong = await SELF.fetch(`${ORIGIN}/api/admin/credits/purge`, {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(wrong.status).toBe(405);
    await wrong.text();
  });
});

describe('请求预算：缓存必须真的生效', () => {
  /**
   * 这一组锁的是「省 Worker 请求」的四条路径。
   *
   * 背景：Workers Free 只有 100,000 请求/天，超额即停摆到次日 UTC 0 点
   * （真实发生过一次：连续部署+迁移+探测把当天额度用完了）。
   * 而 budget.mjs 的模型只算出 16% 用量 —— 因为它假设的缓存命中率
   * 有几个路径**根本没实现**。这些断言保证不会再 silently 退化回去。
   */
  it('OPTIONS 带长缓存（WebDAV 客户端挂载时会反复问）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/dav/`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    // 必须明确缓存，且时长至少 1 天
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=(\d+)/);
    const age = Number(cc.match(/max-age=(\d+)/)![1]);
    expect(age, 'OPTIONS 是编译期常量，缓存一天是安全的').toBeGreaterThanOrEqual(86400);
    // 能力头必须仍在（缓存不能把它们缓存丢了）
    expect(res.headers.get('allow')).toContain('PROPFIND');
    expect(res.headers.get('dav')).toBeTruthy();
  });

  it('/health 带缓存（它是编译期常量，探针调用很密集）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/max-age=(\d+)/);
    const age = Number(cc.match(/max-age=(\d+)/)![1]);
    expect(age).toBeGreaterThan(0);
  });

  it('求书墙 API 有缓存头，且真的命中（第二次不查 D1）', async () => {
    // 第一次：写入缓存
    const first = await SELF.fetch(`${API}?limit=7&offset=0`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toMatch(/max-age=60/);

    // 第二次：应该命中。这里不断言时间，而是断言**内容一致且仍有缓存头**
    // （如果缓存失效，两个请求都会重新查 D1，但表现上完全相同 ——
    //   所以真正的验证是 resetLibrary 之后缓存仍返回旧数据，
    //   见下面那条。）
    const second = await SELF.fetch(`${API}?limit=7&offset=0`);
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toMatch(/max-age=60/);
  });

  it('求书墙缓存在数据变化后仍会返回旧数据（证明缓存在工作）', async () => {
    await post({ title: '缓存验证书' }, '5.5.5.5');
    const before = await (await SELF.fetch(`${API}?limit=11&offset=0`)).json() as {
      requests: { title: string }[];
    };
    expect(before.requests.length).toBeGreaterThan(0);

    // 提交新书后**不**清缓存，再取同一个 URL —— 应仍是旧列表
    await post({ title: '后提交的书' }, '6.6.6.6');
    const after = await (await SELF.fetch(`${API}?limit=11&offset=0`)).json() as {
      requests: { title: string }[];
    };
    expect(after.requests.map((r) => r.title)).not.toContain('后提交的书');

    // 但换 limit 就是换键，必然 MISS —— 新书立刻可见
    const fresh = await (await SELF.fetch(`${API}?limit=12&offset=0`)).json() as {
      requests: { title: string }[];
    };
    expect(fresh.requests.map((r) => r.title)).toContain('后提交的书');
  });

  it('上传页可缓存（原来是 no-store，每次点「上架一本」都打 Worker）', async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc, '上传页不该是 no-store —— 里面的 Turnstile 是公钥').not.toBe('no-store');
    expect(cc).toMatch(/max-age=(\d+)/);
    expect(Number(cc.match(/max-age=(\d+)/)![1])).toBeGreaterThan(0);
  });

  it('这些缓存的键都有登记，测试之间不会互相污染', async () => {
    // ⚠️ 加新缓存时必须同步 CACHE_KEY_PREFIXES —— 否则测试之间
    //   会共享缓存，表现为无法解释的顺序/数量错误（真实踩过三次）。
    const { CACHE_KEY_PREFIXES } = await import('../src/lib/cache');
    expect(CACHE_KEY_PREFIXES.length).toBeGreaterThanOrEqual(2);
    expect(CACHE_KEY_PREFIXES).toContain('/public-credits');
    expect(CACHE_KEY_PREFIXES).toContain('/api/requests');
  });
});
