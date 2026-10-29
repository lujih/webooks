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

/**
 * R2 公开域基址（来自 vitest.config.ts 的 bindings）。
 *
 * 不写死字符串：测的就是「同一个 env 值被正确地拼进直链」，
 * 写死会让「配置改了但代码没跟上」这类问题在测试里看不出来。
 */
const R2_BASE = testEnv.R2_PUBLIC_BASE.replace(/\/+$/, '');

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

  /**
   * 插一本「最近上架」的书，让 latestBook() 一定有东西可返回。
   *
   * ⚠️ 显式插而不是依赖「库里碰巧有书」：resetLibrary() 之后库是空的，
   *   靠 `if (row)` 包住断言会让整条测试在空库时**静默通过**。
   */
  async function seedLatest(leafName: string, r2Key: string): Promise<void> {
    await testEnv.DB.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES (?,?,?,'某作者','zh','epub','application/epub+zip',100,'s',?,
        'L','M','ebook','ebook','derived','2026-12-31','2026-12-31','2026-12-31','published','测试者')`,
    )
      .bind(`seed-${r2Key}`, leafName, leafName.replace(/\.[^.]+$/, ''), r2Key)
      .run();
  }

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
    // ⚠️ 必须先插书：这组每条测试开头都是 resetLibrary()，
    //   不插的话 latestBook() 返回 null，整条测试**静默空转**（看着绿，其实什么都没验）。
    await seedLatest('链接.epub', 'books/link1');
    const row = await latestBook(testEnv.DB, '/dav', '最近收录', R2_BASE);
    expect(row).not.toBeNull();
    // href 在 latestBook() 里拼好并做百分号编码，前端只负责放进去
    expect(row!.href).not.toContain('//');
    expect(row!.href.startsWith('/dav/最近收录/')).toBe(true);
    // 直链是**绝对**地址，指向 R2 公开域 —— 点它不经过 Worker
    expect(row!.downloadUrl).toBe(`${R2_BASE}/books/link1`);
  });

  it('latestBook() 只返回公开字段 —— 内部对象键 r2_key 不许跟出来', async () => {
    await seedLatest('字段白名单.epub', 'books/keys1');
    const row = await latestBook(testEnv.DB, '/dav', '最近收录', R2_BASE);
    expect(row).not.toBeNull();
    // db.ts 里是**逐字段**构造而不是 `{ ...row }` 展开 —— 后者会把 SELECT
    // 出来的 r2_key 一起带进返回值。
    //
    // ⚠️ 这条测试是「变异测试漏网」后补的：把 db.ts 改成 `...row` 展开时，
    //   全套测试**一条都没红**。因为 /api/credits 自带一层白名单（它只挑
    //   title/author/credit/publishedAt/href/downloadUrl 六个字段输出），
    //   把泄漏挡在了 HTTP 之外。但 latestBook() 是导出的公共函数，
    //   将来多一个调用方（比如 RSS、OPDS）就会直接把内部键暴露出去，
    //   而且**不会有人报错**，只是静静多一个字段。所以在这里钉住返回值结构。
    expect(Object.keys(row!).sort()).toEqual([
      'author',
      'credit',
      'downloadUrl',
      'href',
      'leaf_name',
      'published_at',
      'title',
    ]);
    expect(row!).not.toHaveProperty('r2_key');
  });

  it('前端优先用直链，且**保留**回退（否则会渲染出 href="undefined"）', async () => {
    const html = await homeHtml();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    // 必须是 `downloadUrl || href` 这个形状：直链缺席时回退 /dav 路径。
    //
    // ⚠️ 这条挡的是一次真实事故的形状（browse-page.ts 的书卡上踩过）：
    //   直接写 `title.href = latest.downloadUrl;` 在字段缺席时会赋值
    //   **字符串 "undefined"** —— 浏览器把 `href="undefined"` 当成相对路径，
    //   点下去变成 `https://站点/undefined`，看起来只是一次普通的下载失败，
    //   极难定位。所以回退不许省。
    expect(script, '活书脊必须 downloadUrl 优先、href 兜底').toMatch(
      /title\.href\s*=\s*latest\.downloadUrl\s*\|\|\s*latest\.href/,
    );
  });

  it('没配 R2_PUBLIC_BASE 时 downloadUrl 为 null（而不是 undefined/空串）', async () => {
    await seedLatest('无直链.epub', 'books/nobase1');
    // 前端靠 `downloadUrl || href` 回退，null 才会走回退分支；
    // 空串虽然也是 falsy，但显式 null 让「没配」这件事在 JSON 里可见
    // （undefined 会被 JSON.stringify 整个丢掉，字段直接消失）。
    const row = await latestBook(testEnv.DB, '/dav', '最近收录', null);
    expect(row).not.toBeNull();
    expect(row!.downloadUrl).toBeNull();
    // 回退目标仍在：href 照旧拼好
    expect(row!.href.startsWith('/dav/最近收录/')).toBe(true);
  });

  it('文件名里的 # 被编码（不会截断 URL）', async () => {
    const db = testEnv.DB;
    await db.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES ('hash1','C# 编程#2.epub','C# 编程',NULL,'zh','epub','application/epub+zip',100,'s','books/hash1',
        'C','C','ebook','ebook','derived','2026-10-14','2026-10-14','2026-10-14','published','雷锋')`,
    ).run();
    const row = await latestBook(db, '/dav', '最近收录', R2_BASE);
    expect(row).not.toBeNull();
    expect(row!.href).not.toContain('#');
    expect(row!.href).toContain('%23');
    // ⚠️ 直链里**不含书名** —— 对象键是 books/<随机 id>（见 src/lib/r2.ts 顶部
    //   的论证）。所以 `#` 这类字符根本进不了直链，也就没有截断问题；
    //   这条断言是钉住那个性质，而不是钉住某个编码结果。
    expect(row!.downloadUrl).not.toContain('#');
    expect(row!.downloadUrl).toContain('/books/hash1');
    expect(row!.downloadUrl).not.toContain('编程');
  });

  it('署名缺失时回落到「雷锋」', async () => {
    const db = testEnv.DB;
    await db.prepare(
      `INSERT INTO books (id,leaf_name,title,author,language,format,content_type,size,sha256,r2_key,
        title_letter,author_letter,format_bucket,kind_bucket,kind_source,published_at,created_at,updated_at,status,credit)
       VALUES ('nc1','无署名.epub','无署名',NULL,'zh','epub','application/epub+zip',100,'s','books/nc1',
        'W','W','ebook','ebook','derived','2026-10-13','2026-10-13','2026-10-13','published',NULL)`,
    ).run();
    const row = await latestBook(db, '/dav', '最近收录', R2_BASE);
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
      // ⚠️ 2026-10-28 审查 T-01：旧正则 `(^|\})\s*\.wrap\s*\{` 依赖「前一个字符
      // 是行首或 }」—— 而 theme 的 `.wrap{` 前面是**注释结尾 `*/`**，于是
      // theme 那一条根本匹配不到，计数恒为 0；页面再自造一条 .wrap 也只算 1，
      // `<= 1` 照样通过（变异实验实测：加 `.wrap{max-width:60rem}` 后仍全绿）。
      // 修法：先剥掉 CSS 注释，再直接数 `.wrap{` 选择器 —— 不依赖前一个字符。
      const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      // 判定标准是「带 max-width 的 .wrap」而不是「出现过 .wrap{」：
      // theme 自己就有两处（基础规则 + 移动端只改 padding 的覆盖），
      // 按出现次数会误报。宽度才是「版心」的唯一声明点。
      const wraps = [...cssNoComments.matchAll(/\.wrap\s*\{([^}]*)\}/g)]
        .filter((m) => /max-width\s*:/.test(m[1] ?? ''));
      expect(wraps.length, `${path} 重复定义了 .wrap 的版心宽度`).toBeLessThanOrEqual(1);
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
      // ⚠️ 2026-10-28 审查 T-02：旧写法只取**第一个** match（theme 的 52rem），
      // 页面在后面覆盖 `.wrap{max-width:60rem}` 永远看不到。
      // 改为收集**每一处**声明：两处不同宽度就该红。
      const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/\.wrap\s*\{[^}]*max-width:\s*([^;}]+)/g)) {
        widths.add(m[1]!.trim());
      }
    }
    expect(widths.size, '一个 .wrap 宽度都没读到 —— 断言在空集上成立，是假绿')
      .toBeGreaterThan(0);
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
    const row = await latestBook(testEnv.DB, '/dav', '最近收录', R2_BASE);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('最近上架的书');
    expect(row!.author).toBe('某作者');
    expect(row!.credit).toBe('测试者');
    expect(row!.href).not.toContain('//');
    expect(row!.href.startsWith('/dav/最近收录/')).toBe(true);
    expect(row!.downloadUrl).toBe(`${R2_BASE}/books/lz1`);

    // 再验证它真的会出现在响应里（用 purgeByPrefixes 清掉缓存后取）
    const { purgeByPrefixes } = await import('../src/lib/cache');
    await purgeByPrefixes();
    // purgeByPrefixes 之后**必须重新插入**（resetLibrary 在 beforeEach 里跑过，
    // 但那是在这条测试开头；中间没有别的清库动作，所以书应该还在）
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as {
      latest: {
        title: string;
        href: string;
        downloadUrl: string | null;
        credit: string | null;
        author: string | null;
      };
    };
    expect(body.latest).not.toBeNull();
    expect(body.latest.title).toBe('最近上架的书');
    expect(body.latest.author).toBe('某作者');
    expect(body.latest.credit).toBe('测试者');
    // ⚠️ href 的语义**没变**：它仍是书库内的相对路径（WebDAV 路径）。
    //   直链走的是新字段 downloadUrl —— 前端 `downloadUrl || href`。
    //   这条断言是防「有人图省事把 href 直接改成直链」，那会让
    //   href 不再是站内路径，而文档和别的调用方都按站内路径依赖它。
    expect(body.latest.href).not.toContain('//');
    expect(body.latest.href.startsWith('/dav/最近收录/')).toBe(true);
    // 首页那张卡真正会去的地方：绝对地址、R2 公开域、点它不经过 Worker
    expect(body.latest.downloadUrl).toBe(`${R2_BASE}/books/lz1`);
  });

  it('书库为空时 latest 为 null（前端会移除那张卡）', async () => {
    await resetLibrary();
    const res = await SELF.fetch(`${ORIGIN}/api/credits`);
    const body = (await res.json()) as { latest: unknown };
    expect(body.latest).toBeNull();
  });
});

describe('每个页面都要声明站点图标（请求预算）', () => {
  /**
   * 这一组挡的是「每打开一个页面就白花一次 Worker 请求」。
   *
   * 浏览器在页面里没找到 <link rel="icon"> 时，会自己去猜 `/favicon.ico`。
   * 加静态资源之前，那个路径不存在 —— 于是**每次页面浏览**都多一次请求
   * 换回一个 404。而 favicon 现在是 public/favicon.ico，由静态资源层
   * 直接应答（官方：静态资源请求 free and unlimited），不计入配额。
   *
   * 但这条链路有个前提：**页面必须显式声明它**。只放一个文件在 public/
   * 也能被浏览器猜中，但一旦将来改了文件名（比如换成 /icon.svg），
   * 所有页面的隐式猜测就会一起失效 —— 显式声明让这件事在测试里可见。
   *
   * 另外：静态资源不经过 Worker，所以 withSecurityHeaders() 管不到它，
   * 它的 Cache-Control 写在 public/_headers（见 static-assets.test.ts）。
   */
  const PAGES: ReadonlyArray<readonly [string, string]> = [
    ['/', 'home'],
    ['/requests', 'requests'],
    ['/upload', 'upload'],
    ['/admin', 'admin'],
    [`/dav/${encodeURIComponent('最近收录')}`, 'browse'],
  ];

  for (const [path, label] of PAGES) {
    it(`${label} 页声明了 /favicon.ico`, async () => {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { accept: 'text/html' } });
      const html = await res.text();
      expect(html, `${label} 页缺少图标声明，浏览器会去请求一个不存在的路径`).toMatch(
        /<link\s+rel="icon"[^>]*href="\/favicon\.ico"/,
      );
    });
  }

  it('图标声明在 <head> 里（放 body 里浏览器可能忽略）', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })
    ).text();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('rel="icon"');
  });

  it('声明的大小与产物一致（sizes 写着 32x32，图标就得真是 32×32）', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/`, { headers: { accept: 'text/html' } })
    ).text();
    expect(html).toMatch(/rel="icon"[^>]*sizes="32x32"/);
    // 产物尺寸由 static-assets.test.ts 读真实字节校验；这里只保证两处声明一致
  });
});
