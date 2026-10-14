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
import { describe, expect, it } from 'vitest';

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
