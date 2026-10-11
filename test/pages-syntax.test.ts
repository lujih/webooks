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
    // 应当使用无转义的写法
    expect(code).toContain("f.type.startsWith('image/')");
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
});
