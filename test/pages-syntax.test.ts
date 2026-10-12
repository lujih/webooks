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

  it('每个文件都领取新的人机验证令牌（否则第 2 本起必定 403）', async () => {
    // Turnstile 令牌是一次性的。批量上传时如果只取一次令牌，
    // 第 2 个文件必然拿到 403 turnstile-failed，看起来像"批量上传坏了"。
    // 所以上传页必须有「取令牌」的封装，并在其中 reset 组件领取新令牌。
    const res = await SELF.fetch(`${ORIGIN}/upload`, { headers: { accept: 'text/html' } });
    const html = await res.text();
    const code = inlineScripts(html).join('\n');
    expect(code).toContain('takeToken');
    expect(code).toContain('turnstile.reset');
    // 队列里每个文件都要单独取令牌
    expect(code).toMatch(/await\s+takeToken\(\)/);
    // 不能再有「一个全局 token 变量反复复用」的老写法
    // （turnstileToken 作为 API 请求体的字段名仍会出现，所以只禁止赋值）
    expect(code).not.toMatch(/turnstileToken\s*=[^=]/);
  });
});
