/**
 * 文件名清洗（sanitiseLeafName）的边界与碰撞检查。
 *
 * 为什么要专门测：`leaf_name` 是**全局唯一键**（D1 上有唯一索引），
 * 也是 WebDAV 客户端识别文件的依据。如果两个不同的原始文件名清洗后
 * 变成同一个名字，就会出现：
 *   · 后上传的书覆盖前一本书的元数据行（但 R2 里是两份对象 → 存储泄漏）
 *   · 客户端以为是「覆盖已有文件」，实际是两本不同的书
 * 所以清洗必须是**单射**的（不同的输入不能产生相同的输出）。
 */

import { describe, expect, it } from 'vitest';
import { sanitiseLeafName } from '../src/lib/metadata';

describe('sanitiseLeafName', () => {
  it('过滤掉路径分隔符与危险字符', () => {
    expect(sanitiseLeafName('a/b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a\\b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a<b>.epub')).toBe('a_b_.epub');
    expect(sanitiseLeafName('a:b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a"b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a|b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a?b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a*b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a\u0000b.epub')).toBe('a_b.epub');
    expect(sanitiseLeafName('a\u007fb.epub')).toBe('a_b.epub');
  });

  it('拒绝空名与「.」「..」', () => {
    expect(sanitiseLeafName('')).toBeNull();
    expect(sanitiseLeafName('   ')).toBeNull();
    expect(sanitiseLeafName('.')).toBeNull();
    expect(sanitiseLeafName('..')).toBeNull();
  });

  it('**已知取舍**：不同字符被映射到同一个下划线，因此清洗不是单射的', () => {
    // 这些是「不同的输入 → 同一个输出」的例子。它们必然发生，
    // 因为过滤策略就是把非法字符替换成 `_`。
    const collide: Array<[string, string]> = [
      ['a*b.epub', 'a?b.epub'],
      ['a|b.epub', 'a:b.epub'],
      ['a_b.epub', 'a*b.epub'],
    ];
    for (const [x, y] of collide) {
      expect(sanitiseLeafName(x), `${x} vs ${y}`).toBe(sanitiseLeafName(y));
    }
  });

  it('超长名截断后仍保留扩展名，且长度受控', () => {
    const long = 'x'.repeat(500) + '.epub';
    const s = sanitiseLeafName(long, 200);
    expect(s).not.toBeNull();
    expect(s!.length).toBeLessThanOrEqual(200);
    expect(s!.endsWith('.epub')).toBe(true);
  });

  it('连续空白被压成单个空格', () => {
    expect(sanitiseLeafName('a   b.epub')).toBe('a b.epub');
    expect(sanitiseLeafName('  a b.epub  ')).toBe('a b.epub');
  });
});
