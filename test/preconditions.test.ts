/**
 * 条件请求（RFC 9110 §13.1）单元测试。
 *
 * 这是防误覆盖的核心逻辑，必须覆盖各种边界：
 * 弱比较、多个 ETag、星号通配、资源不存在时的行为。
 */

import { describe, expect, it } from 'vitest';
import { checkPreconditions } from '../src/lib/preconditions';

const h = (obj: Record<string, string>): Headers => new Headers(obj);

describe('checkPreconditions', () => {
  it('无条件头时始终放行', () => {
    expect(checkPreconditions(h({}), null).ok).toBe(true);
    expect(checkPreconditions(h({}), '"abc"').ok).toBe(true);
  });

  it('If-None-Match: * 在目标不存在时放行、在存在时拒绝', () => {
    expect(checkPreconditions(h({ 'if-none-match': '*' }), null).ok).toBe(true);
    const blocked = checkPreconditions(h({ 'if-none-match': '*' }), '"abc"');
    expect(blocked.ok).toBe(false);
  });

  it('If-None-Match: * 是防覆盖的关键路径', () => {
    // 这是同步客户端「只新建不覆盖」依赖的语义
    const r = checkPreconditions(h({ 'if-none-match': '*' }), '"exists"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/已存在/);
  });

  it('If-Match: * 在目标存在时放行', () => {
    expect(checkPreconditions(h({ 'if-match': '*' }), '"abc"').ok).toBe(true);
  });

  it('If-Match 在目标不存在时拒绝（任何值都拒绝）', () => {
    expect(checkPreconditions(h({ 'if-match': '*' }), null).ok).toBe(false);
    expect(checkPreconditions(h({ 'if-match': '"abc"' }), null).ok).toBe(false);
  });

  it('If-Match 精确匹配 ETag', () => {
    expect(checkPreconditions(h({ 'if-match': '"abc"' }), '"abc"').ok).toBe(true);
    expect(checkPreconditions(h({ 'if-match': '"abc"' }), '"xyz"').ok).toBe(false);
  });

  it('If-Match 支持多个 ETag，命中任一即放行', () => {
    expect(checkPreconditions(h({ 'if-match': '"a", "abc", "z"' }), '"abc"').ok).toBe(true);
    expect(checkPreconditions(h({ 'if-match': '"a", "b"' }), '"abc"').ok).toBe(false);
  });

  it('弱比较：If-None-Match 的 W/ 前缀等价于强比较（RFC 9110 §13.1.2）', () => {
    // If-None-Match 使用弱比较，所以 W/"abc" 应命中 "abc"
    expect(checkPreconditions(h({ 'if-none-match': 'W/"abc"' }), '"abc"').ok).toBe(false);
    expect(checkPreconditions(h({ 'if-none-match': 'W/"abc"' }), '"xyz"').ok).toBe(true);
  });

  it('If-None-Match 显式列出未命中的 ETag 时放行', () => {
    expect(checkPreconditions(h({ 'if-none-match': '"other"' }), '"abc"').ok).toBe(true);
  });

  it('If-Match 与 If-None-Match 同时出现时都要满足', () => {
    // 两者都通过
    expect(checkPreconditions(h({ 'if-match': '"abc"', 'if-none-match': '"zzz"' }), '"abc"').ok).toBe(true);
    // If-Match 失败
    expect(checkPreconditions(h({ 'if-match': '"nope"', 'if-none-match': '"zzz"' }), '"abc"').ok).toBe(false);
    // If-None-Match 失败
    expect(checkPreconditions(h({ 'if-match': '"abc"', 'if-none-match': '*' }), '"abc"').ok).toBe(false);
  });

  it('容错：非法 ETag 列表不应崩溃', () => {
    expect(checkPreconditions(h({ 'if-match': 'garbage' }), '"abc"').ok).toBe(false);
    expect(checkPreconditions(h({ 'if-none-match': ',,,' }), '"abc"').ok).toBe(true);
  });
});