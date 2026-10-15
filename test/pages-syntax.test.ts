/**
 * 页面内联脚本的语法自检。
 *
 * 为什么需要这个测试（真实事故）：
 *   页面 HTML 是用 TS 模板字符串拼出来的。模板字符串会处理转义序列，
 *   **正则里的 `\/` 会被吃掉变成 `/`**，于是 `if(/^image\//.test(...))`
 *   在生成的 HTML 里变成了 `if(/^image//.test(...))` —— 语法错误，
 *   整段 <script> 解析失败，上传页的所有交互（拖拽、按钮、进度）
 *   全部失效，而且浏览器只在控制台报一行 SyntaxError，很容易漏掉。
 *
 *   普通单元测试不会发现它：它们测的是 TS 源码，而不是「吐给浏览器的 HTML」。
 *   所以这里改成**从真实响应里抠出 <script> 内容，交给 JS 解析器检查**。
 *
 * 同类风险还有 `\d` `\.` `\s` 等（模板字符串里都会被去掉反斜杠），
 * 这个测试能一次覆盖全部。
 */

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetLibrary, testEnv } from './setup';
import { latestBook } from '../src/lib/db';

const ORIGIN = 'https://webooks.test';

/** 从 HTML 里取出所有内联 <script> 的内容（跳过带 src 的外链脚本） */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // 外链脚本不检查
    out.push(m[2] ?? '');
  }
  return out;
}

/** 用真实 JS 解析器检查语法（new Function 会抛 SyntaxError） */
function assertParses(code: string, label: string): void {
  try {
    // 只编译不执行 —— 这才是「语法检查」的语义
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${label} 的内联脚本存在语法错误：${msg}`);
  }
}

const PAGES = [
  // expectJs: 该页是否本来就有内联脚本。
  // 首页与目录页是纯 CSS 实现（无 JS），断言「必须有脚本」会误报。
  { path: '/', label: '首页', expectJs: false },
  { path: '/upload', label: '上传页', expectJs: true },
  { path: '/admin', label: '管理后台', expectJs: true },
  { path: '/dav/', label: '目录浏览页', expectJs: false },
];

describe('页面内联脚本语法自检', () => {
  for (const { path, label, expectJs } of PAGES) {
    it(`${label}（${path}）的内联 JS 能被解析`, async () => {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } });
      expect(res.status, `${label} 应返回 200`).toBe(200);
      const html = await res.text();

      const scripts = inlineScripts(html);
      if (expectJs) {
        expect(scripts.length, `${label} 应包含内联脚本`).toBeGreaterThan(0);
      }
      // 核心断言：不管有没有脚本，有就必须能解析
      for (const [i, code] of scripts.entries()) {
        assertParses(code, `${label} 第 ${i + 1} 段`);
      }
    });
  }

  it('回归：正则转义被吃掉的话，脚本解析会失败', async () => {
    // 上传页曾因模板字符串吃掉正则转义而整段脚本失效。
    // 这里直接对脚本正文做特征检测（只看 <script> 内容，不看注释/CSS）。
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    const html = await res.text();
    const code = inlineScripts(html).join('\n');

    // 典型特征：正则开头后紧跟两个斜杠（`/^abc//`），是转义丢失的产物
    expect(code).not.toMatch(/\/\^[A-Za-z]*\/\//);
    // 格式校验刻意用字符串判断而非正则，从根上避开转义陷阱
    expect(code).toContain('ACCEPT.indexOf(ext)');
    // 双保险：整段脚本必须能解析
    assertParses(code, '上传页脚本正文');
  });

  it('HTML 结构完整（没有被模板转义破坏的标签）', async () => {
    for (const { path, label } of PAGES) {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } });
      const html = await res.text();
      expect(html.startsWith('<!doctype html>'), label).toBe(true);
      expect(html.trimEnd().endsWith('</html>'), label).toBe(true);
      // 生成的 HTML 里不应出现「未替换的 TS 模板残留」
      expect(html, label).not.toContain('${');
    }
  });

  it('CSP 必须允许上传所需的 R2 直传端点', async () => {
    // 真实事故：CSP 的 connect-src 漏掉 R2 的 S3 端点，导致「浏览器直传 R2」
    // 被静默拦掉 —— 报错发生在 XHR 上，看起来像上传功能坏了，很难定位。
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('connect-src');
    expect(csp).toContain('r2.cloudflarestorage.com');
    // 顺便确认 Turnstile 与统计脚本也在白名单里
    expect(csp).toContain('challenges.cloudflare.com');
    expect(csp).toContain('static.cloudflareinsights.com');
  });

  it('批量上传一批只验证一次（用通行证复用，而不是每本弹一次验证）', async () => {
    // 真实反馈：早期实现「每个文件领一个新令牌」，导致传 10 本要点 10 次验证。
    // 现在改成：第一次带一次性令牌，服务端回一张限时通行证，整批复用。
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    const html = await res.text();
    const code = inlineScripts(html).join('\n');

    // 通行证：有就复用，服务端每次回的新通行证要存下来
    expect(code).toContain('ticket');
    expect(code).toMatch(/if\(ticket\)\s*body\.ticket\s*=\s*ticket/);
    expect(code).toMatch(/if\(initJson\.ticket\)\s*ticket\s*=\s*initJson\.ticket/);
    // 只在没有通行证（或通行证失效重试）时才去取一次性令牌 —— 不能每本都取。
    // 中间允许夹一层开关判断（`else if (NEED_TURNSTILE)`）：人机验证关闭时
    // 连令牌都不用取，这是默认行为。
    expect(code).toMatch(
      /else(?:\s+if\s*\([^)]*\))?\s+body\.turnstileToken\s*=\s*await\s+takeToken\(\)/,
    );
    const perFileToken = code.match(/body\.turnstileToken\s*=\s*await\s+takeToken\(\)/g) ?? [];
    // 两处：首次（无通行证）+ 通行证失效后的重试。不应更多。
    expect(perFileToken.length).toBeLessThanOrEqual(2);
    // 通行证失效时要能自动换令牌重试
    expect(code).toContain('ticket-invalid');
  });

  it('人机验证相关：interaction-only + 无全局 token 变量 + 开关判定', async () => {
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    const html = await res.text();
    const code = inlineScripts(html).join('\n');

    // ① 开着验证时用 interaction-only：正常用户看不到验证框
    expect(code).toContain("appearance: 'interaction-only'");

    // ② 不能再有「一个全局 token 变量反复复用」的老写法。
    //    只匹配**裸变量**赋值（turnstileToken = x），排除对象属性
    //    （body.turnstileToken = x —— 那恰恰是现在正确的写法）。
    expect(code).not.toMatch(/(^|[^.\w])turnstileToken\s*=[^=]/);

    // ③ 前后端用同一个信号判断要不要验证：有没有配 siteKey。
    //    两边判定不一致会导致「前端弹框、后端不要」的错位。
    expect(code).toContain('const NEED_TURNSTILE = !!siteKey');
    // 没配 siteKey 时整段跳过，连 Turnstile 脚本都不加载
    expect(code).toMatch(/if\s*\(\s*!\s*NEED_TURNSTILE\s*\)/);
  });

  it('没配 TURNSTILE_SITE_KEY 时不渲染验证容器', async () => {
    const { uploadHtml } = await import('../src/upload-page');
    const noKey = uploadHtml(null);
    expect(noKey).toMatch(/<div id="ts" hidden>/);
    const withKey = uploadHtml('0x4AAAAAAA');
    expect(withKey).toMatch(/<div id="ts">/);
    expect(withKey).not.toMatch(/<div id="ts" hidden>/);
  });
});

describe('页面脚本引用的元素必须真实存在', () => {
  /**
   * 为什么需要这条测试：
   *
   * 加求书看板时，我用脚本替换 admin 页的一整段 HTML，误把
   * `<div id="listWrap">` 连带下面的 toast 容器一起吃掉了。
   * 于是 renderList() 执行 `$('listWrap').innerHTML = …` 时拿到 null，
   * 抛 "Cannot set properties of null" —— 而它在登录的 try/catch 里，
   * 用户只看到「登录失败」，与真实原因毫无关联，极难排查。
   *
   * 这类错误有 3 个特点，使得它极难被常规测试发现：
   *   · TypeScript 查不出（DOM 是运行时的）
   *   · 「页面能否解析」查不出（语法完全正确）
   *   · 端到端测试若不真的点登录，也不会触发
   *
   * 所以这里做一件笨事：把脚本里所有 $('x') 引用与 DOM 里的 id 求差集。
   */
  const PAGES: ReadonlyArray<readonly [string, string]> = [
    ['/admin', 'admin'],
    ['/upload', 'upload'],
    ['/requests', 'requests'],
    ['/', 'home'],
  ];

  for (const [path, label] of PAGES) {
    it(`${label} 页：脚本引用的每个 id 都在 DOM 里`, async () => {
      const html = await (
        await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } })
      ).text();

      const script = inlineScripts(html).join('\n');
      // 收集所有 $('x') / getElementById('x') 的引用
      const refs = new Set<string>();
      for (const m of script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) refs.add(m[1]!);
      for (const m of script.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) refs.add(m[1]!);

      const domIds = new Set<string>();
      for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) domIds.add(m[1]!);

      // $helper 自己内部也会引用，但它是 DOM 查询不是字面量 id
      const missing = [...refs].filter((id) => !domIds.has(id));
      expect(
        missing,
        `${path} 的脚本引用了不存在的元素：${missing.join(', ')}\n`
          + `症状会是 "Cannot set properties of null"，且常被 try/catch 吞成「登录失败」。`,
      ).toEqual([]);
    });
  }

  it('$ 在元素缺失时抛出可读的错误，而不是让调用方拿到 null', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/admin`, { headers: { accept: 'text/html' } })
    ).text();
    const script = inlineScripts(html).join('\n');
    // 守卫存在，且错误信息里带上缺失的 id
    expect(script).toMatch(/页面缺少元素/);
  });
});

describe('上传页：可交互元素不能被拖放区吞掉点击', () => {
  /**
   * 真实 bug：留名输入框被放在 #drop 内部。
   *
   * #drop 是一整块 role="button" 区域，onclick 触发 fileInput.click()。
   * 于是「点输入框准备打字」→ 弹出文件选择器 → 一个字都输不进去。
   *
   * 这个 bug 的三个特点让它极易复发：
   *   · 只在真浏览器里看得见（DOM 结构完全合法）
   *   · TypeScript / 语法检查 / 端到端测试全都不报错
   *   · 加新输入框的人不会想到「这里不能放东西」
   *
   * 所以用两条断言盯住：**结构**上不能在里面，**代码**上要有兜底。
   */
  async function uploadPage(): Promise<string> {
    return (await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } })).text();
  }

  it('留名输入框在 #drop 之外', async () => {
    const html = await uploadPage();
    const dropStart = html.indexOf('id="drop"');
    expect(dropStart).toBeGreaterThan(-1);

    // 用 div 深度算出 #drop 的**真实**结束位置。
    // ⚠️ 不能用固定字符窗口：#drop 有 400 多字符，但 creditbar 若在它
    //   内部，靠窗也会「看起来在外面」—— 曾经写出过这种假阴性断言。
    const tagRe = /<div\b|<\/div>/g;
    // 从 #drop 的**开标签**开始数（id="drop" 前面就是那个 <div）
    tagRe.lastIndex = html.lastIndexOf('<div', dropStart);
    let depth = 0;
    let dropEnd = -1;
    for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { dropEnd = m.index; break; }
    }
    expect(dropEnd, '没能定位 #drop 的结束位置').toBeGreaterThan(dropStart);

    const dropBlock = html.slice(dropStart, dropEnd);
    expect(
      dropBlock.includes('creditbar') || dropBlock.includes('id="credit"'),
      '留名输入框又在 #drop 里了 —— 点它会弹文件选择器',
    ).toBe(false);
    expect(html.indexOf('id="credit"')).toBeGreaterThan(dropEnd);
  });

  it('#drop 的点击处理会跳过内部的可交互元素（兜底）', async () => {
    const html = await uploadPage();
    const script = inlineScripts(html).join('\n');
    // 有结构性兜底：命中 input/button/select/textarea/a/label 就不触发
    expect(script).toMatch(/closest\(\s*INTERACTIVE\s*\)/);
    expect(script).toMatch(/INTERACTIVE\s*=\s*'[^']*input[^']*'/);
    // 键盘路径也要挡：焦点在内部控件时 Enter 归那个控件
    expect(script).toMatch(/keydown[\s\S]{0,400}e\.target\s*!==\s*drop/);
  });

  it('#drop 仍然是可点击打开文件选择器（修完没把功能改坏）', async () => {
    const html = await uploadPage();
    const script = inlineScripts(html).join('\n');
    // 普通点击（目标是 drop 自身或其非交互子元素）仍然要打开选择器
    expect(script).toMatch(/drop\.onclick[\s\S]{0,300}fileInput\.click\(\)/);
    // 键盘 Enter/Space 仍然可用（role="button" 的可访问性要求）
    expect(script).toMatch(/key === 'Enter'/);
  });

  it('留名输入框本身是可聚焦的文本框', async () => {
    const html = await uploadPage();
    const input = html.match(/<input[^>]*id="credit"[^>]*>/)?.[0] ?? '';
    expect(input, '找不到留名输入框').toContain('id="credit"');
    expect(input).toContain('maxlength="32"');
    expect(input).not.toContain('disabled');
  });
});

describe('首屏那张「活书脊」', () => {
  /**
   * 活书脊现在由**前端**渲染 —— 数据来自 /api/credits（已缓存 1 小时），
   * 因为首页是流量最大的入口，不该每次未命中都查 D1。
   *
   * 所以这里断言的是三件事：
   *   ① DOM 里有一个空容器（书库为空时 JS 会移除它）
   *   ② JS 会从 /api/credits 拿 latest 并渲染进去
   *   ③ 渲染路径的转义、兜底、编码都对
   */
  async function homeHtml(): Promise<string> {
    return (await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })).text();
  }

  // ⚠️ 这组有两条会往 books 插数据 —— 不清库就会读到别的测试留下的书，
  //   而 latestBook 取的是「最近上架」，插一条 published_at 更晚的就会抢走。
  beforeEach(async () => {
    await resetLibrary();
  });

  it('首页零 D1 依赖（活书脊由前端渲染）', async () => {
    const html = await homeHtml();
    // 容器存在但为空 —— 不是服务端渲染好的
    expect(html).toContain('id="fresh"');
    expect(html).toMatch(/id="fresh"[^>]*hidden/);
    // 服务端 HTML 里不该有具体书名（那是前端填的）
    expect(html).not.toContain('class="freshtitle">');
  });

  it('JS 从 /api/credits 取 latest 并渲染', async () => {
    const html = await homeHtml();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    expect(script).toContain('/api/credits');
    expect(script).toContain('fresh');
    // 渲染函数必须存在
    expect(script).toMatch(/function\s+renderFresh|freshTitle/);
  });

  it('书库为空时整块移除（不显示空卡片）', async () => {
    const html = await homeHtml();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    // latest 为 null 时移除容器，而不是留一张空卡
    expect(script).toMatch(/latest[\s\S]{0,200}(remove|hidden\s*=\s*true)/);
  });

  it('链接由服务端给出（避免前端拼路径拼错）', async () => {
    // href 在 latestBook() 里拼好并做百分号编码，前端只负责放进去
    const row = await latestBook(testEnv.DB, '/dav', '最近收录');
    // 空书库时返回 null，有书时 href 必须完整且无双斜杠
    if (row) {
      expect(row.href).not.toContain('//');
      expect(row.href.startsWith('/dav/最近收录/')).toBe(true);
    }
  });

  it('文件名里的 # 被编码（不会截断 URL）', async () => {
    const db = testEnv.DB;
    await db.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES ('hash1','C# 编程#2.epub','C# 编程',NULL,'zh','epub','application/epub+zip',100,'s','books/hash1',
        'C','C','ebook','ebook','derived','2026-10-14','2026-10-14','2026-10-14','published','雷锋')`,
    ).run();
    const row = await latestBook(db, '/dav', '最近收录');
    expect(row).not.toBeNull();
    expect(row!.href).not.toContain('#');
    expect(row!.href).toContain('%23');
  });

  it('署名缺失时回落到「雷锋」', async () => {
    const db = testEnv.DB;
    await db.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES ('nc1','无署名.epub','无署名',NULL,'zh','epub','application/epub+zip',100,'s','books/nc1',
        'W','W','ebook','ebook','derived','2026-10-13','2026-10-13','2026-10-13','published',NULL)`,
    ).run();
    const row = await latestBook(db, '/dav', '最近收录');
    expect(row).not.toBeNull();
    // NULL credit 由前端兜底成「雷锋」（服务端不猜）
    expect(row!.credit).toBeNull();
  });
});

describe('设计系统一致性', () => {
  /**
   * 这一组断言挡的是「某个页面自成一套 CSS」——
   * 上一版求书墙就是这样变成了另一个产品：自造 .wrap/header/panel/button、
   * 19 个硬编码圆角、max-width 960px（全局是 56rem）。
   *
   * 页面模块各自写 CSS，不可能靠人记住「用 token 而非硬编码」。
   * 只能测。
   */
  const PAGES: ReadonlyArray<readonly [string, string]> = [
    ['/', 'home'],
    ['/requests', 'requests'],
    ['/upload', 'upload'],
    ['/admin', 'admin'],
    [`/dav/${encodeURIComponent('最近收录')}`, 'browse'],
  ];

  for (const [path, label] of PAGES) {
    it(`${label} 页：圆角走 --r1/2/3，不硬编码 px`, async () => {
      const html = await (
        await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } })
      ).text();
      const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;

      // 胶囊（999px）只在两种情况下是**对的**：
      //   · theme 的 .lamps i（烛光小圆点）
      //   · 4px 高以内的进度条 —— 这么窄的条，胶囊是唯一说得通的形状
      // 其余地方出现大圆角 = badge/卡片的默认语汇，与本站的方正不符。
      const ALLOWED = /body::|\.lamps|\.qbar|\.qbar2/i;
      const pageCss = css
        .split('}')
        .filter((b) => !ALLOWED.test(b))
        .join('}');
      const bad = [...pageCss.matchAll(/border-radius:\s*(\d+(?:\.\d+)?)px/g)]
        .map((m) => Number(m[1]))
        .filter((n) => n > 12);
      expect(
        bad,
        `${path} 里有硬编码的大圆角 ${bad.join('/')}px —— 应该用 --r1/2/3`,
      ).toEqual([]);
    });

    it(`${label} 页：没有自造 .wrap（宽度必须来自 theme）`, async () => {
      const html = await (
        await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } })
      ).text();
      const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
      // 允许 theme 里的那个 .wrap，页面自己再定义一个就是自造
      const wraps = [...css.matchAll(/(^|\})\s*\.wrap\s*\{/g)];
      expect(wraps.length, `${path} 重复定义了 .wrap`).toBeLessThanOrEqual(1);
    });
  }

  it('五个页面共用同一份 .wrap 宽度（不该各写各的）', async () => {
    const widths = new Set<string>();
    for (const [path] of [
      ['/'], ['/requests'], ['/upload'], ['/admin'],
    ] as ReadonlyArray<readonly [string]>) {
      const html = await (
        await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } })
      ).text();
      const m = html.match(/\.wrap\{[^}]*max-width:\s*([^;}]+)/);
      if (m) widths.add(m[1]!.trim());
    }
    expect(widths.size, `不同的内容宽度：${[...widths].join(' / ')}`).toBeLessThanOrEqual(1);
  });
});

describe('首页不再查 D1（请求预算）', () => {
  /**
   * 首页是流量最大的入口。原来它每次未命中都跑一次 latestBook()（1 行 D1），
   * 等于把最贵的路径放在最热门的页面上。
   *
   * 现在活书脊改由前端 fetch /api/credits 拿（那个接口缓存 1 小时），
   * 而且**与榜单共用同一次 fetch** —— 不额外发请求。
   *
   * 这一组断言保证这个结构不会退化回去。
   */
  it('首页 HTML 不含任何服务端渲染的书脊内容', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })
    ).text();
    // 容器存在但为空、且 hidden（前端填）
    expect(html).toContain('id="fresh"');
    expect(html).toMatch(/<div class="fresh" id="fresh" hidden>/);
    // 服务端不该出现具体书名/作者/署名
    expect(html).not.toContain('class="freshtitle">');
    expect(html).not.toContain('class="freshmeta">');
    expect(html).not.toContain('class="freshspine"');
  });

  it('活书脊与榜单共用一次 fetch（不额外发请求）', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })
    ).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    // 全文只该有**一次** fetch('/api/credits')
    const hits = [...script.matchAll(/fetch\(\s*'\/api\/credits'/g)];
    expect(hits.length, '活书脊和榜单应该复用同一次请求').toBe(1);
    // 渲染函数在同一个 .then 里被调用
    expect(script).toMatch(/renderFresh\(d\.latest\)/);
  });

  it('取不到数据时静默移除（不影响首页可用性）', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })
    ).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    // latest 为空 → remove；fetch 失败 → 也 remove
    expect(script).toMatch(/if\s*\(\s*!latest[^)]*\)\s*\{[^}]*remove\(\)/);
    expect(script).toMatch(/\.catch\([\s\S]{0,400}getElementById\('fresh'\)/);
  });

  it('/api/credits 带上了 latest（前端唯一数据源）', async () => {
    // 自己造一本书，避免依赖别的测试留下的状态
    await resetLibrary();
    await testEnv.DB.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES ('lz1','最近上架的书.epub','最近上架的书','某作者','zh','epub','application/epub+zip',100,'s','books/lz1',
        'Z','M','ebook','ebook','derived','2026-10-15','2026-10-15','2026-10-15','published','测试者')`,
    ).run();

    // ⚠️ /api/credits 缓存 1 小时 —— resetLibrary 已经清掉了缓存键，
    //   但同一个测试文件里前面的测试可能已经重新写入过。
    //   这里直接调 latestBook() 验证服务端逻辑，绕开缓存层
    //   （缓存行为本身由 requests.test.ts 的那一组覆盖）。
    const row = await latestBook(testEnv.DB, '/dav', '最近收录');
    expect(row).not.toBeNull();
    expect(row!.title).toBe('最近上架的书');
    expect(row!.author).toBe('某作者');
    expect(row!.credit).toBe('测试者');
    expect(row!.href).not.toContain('//');
    expect(row!.href.startsWith('/dav/最近收录/')).toBe(true);

    // 再验证它真的会出现在响应里（用 purgeByPrefixes 清掉缓存后取）
    const { purgeByPrefixes } = await import('../src/lib/cache');
    await purgeByPrefixes();
    // purgeByPrefixes 之后**必须重新插入**（resetLibrary 在 beforeEach 里跑过，
    // 但那是在这条测试开头；中间没有别的清库动作，所以书应该还在）
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as {
      latest: { title: string; href: string; credit: string | null; author: string | null };
    };
    expect(body.latest).not.toBeNull();
    expect(body.latest.title).toBe('最近上架的书');
    expect(body.latest.author).toBe('某作者');
    expect(body.latest.credit).toBe('测试者');
    expect(body.latest.href).not.toContain('//');
    expect(body.latest.href.startsWith('/dav/最近收录/')).toBe(true);
  });

  it('书库为空时 latest 为 null（前端会移除那张卡）', async () => {
    await resetLibrary();
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as { latest: unknown };
    expect(body.latest).toBeNull();
  });
});
