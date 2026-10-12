#!/usr/bin/env node
/**
 * 生成拼音首字母表（src/lib/pinyin-table.ts）。
 *
 * 为什么需要它：
 *   中文书库最大的分类缺陷是「所有中文书都挤进 other 桶」——按书名/作者浏览时
 *   等于没有分类。按拼音首字母分桶是中文书库的标准做法（豆瓣、微信读书都这样）。
 *
 * 为什么用「开发时生成、运行时零依赖」：
 *   项目原则是运行时不引入任何依赖（Worker 免费层有体积限制，且少一个依赖少一份风险）。
 *   所以这里用 pinyin-pro 在开发期把数据烘成一张静态表，提交进仓库，
 *   运行时只读表，不带任何库。
 *
 * 表的结构（追求最小体积 + 最快查找）：
 *   把所有汉字按首字母分组、组内按码点排序，拼成**一个长字符串**，
 *   再记录每个字母的 [起, 止) 偏移。运行时一次 indexOf 定位字符位置，
 *   再用二分/线性扫 26 个区间得出首字母 —— 比 26 次 substring 搜索快得多。
 *
 * 用法：node scripts/gen-pinyin-table.mjs
 */

import { pinyin } from 'pinyin-pro';
import { writeFileSync } from 'node:fs';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** 扫描范围：CJK 统一表意文字主区 + 扩展 A（覆盖几乎所有中文书名用字） */
const RANGES = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
];

const groups = Object.fromEntries(LETTERS.map((l) => [l, []]));
let scanned = 0;
let mapped = 0;

for (const [start, end] of RANGES) {
  for (let cp = start; cp <= end; cp++) {
    const ch = String.fromCodePoint(cp);
    scanned++;
    let first;
    try {
      const r = pinyin(ch, { pattern: 'first', toneType: 'none', type: 'array' });
      first = Array.isArray(r) ? r[0] : r;
    } catch {
      continue;
    }
    if (!first) continue;
    const upper = first.toUpperCase();
    if (!LETTERS.includes(upper)) continue;
    groups[upper].push(ch);
    mapped++;
  }
}

// 组内按码点排序 → 生成结果稳定，重复运行不会产生 diff
for (const l of LETTERS) groups[l].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));

const ALL = LETTERS.map((l) => groups[l].join('')).join('');
const offsets = [];
let cursor = 0;
for (const l of LETTERS) {
  offsets.push([l, cursor, cursor + groups[l].length]);
  cursor += groups[l].length;
}

const lines = [];
lines.push('/**');
lines.push(' * 汉字拼音首字母表 —— **自动生成，请勿手改**。');
lines.push(' *');
lines.push(' * 重新生成：node scripts/gen-pinyin-table.mjs');
lines.push(' * （需要 devDependency pinyin-pro，运行时不需要它）');
lines.push(' *');
lines.push(` * 覆盖：CJK 主区 + 扩展 A，共扫描 ${scanned} 个码位，收录 ${mapped} 个有拼音的汉字。`);
lines.push(` * 结构：单一长字符串 + 每个首字母的 [起, 止) 偏移，运行时一次 indexOf 定位。`);
lines.push(' */');
lines.push('');
lines.push('/** 所有汉字按首字母分组后拼接（组内按码点排序） */');
lines.push(`export const PINYIN_BLOB = ${JSON.stringify(ALL)};`);
lines.push('');
lines.push('/** 每个首字母在 BLOB 中的区间 [字母, 起, 止) */');
lines.push(`const OFFSETS: ReadonlyArray<readonly [string, number, number]> = [`);
for (const [l, s, e] of offsets) {
  lines.push(`  ['${l}', ${s}, ${e}],`);
}
lines.push('];');
lines.push('');
lines.push('/**');
lines.push(' * 取汉字的拼音首字母（大写 A–Z）；非汉字或表里没有的返回 null。');
lines.push(' * 实现要点：一次 indexOf 定位字符位置，再线性扫 26 个区间（区间数极少，比二分更快）。');
lines.push(' */');
lines.push('export function pinyinInitial(ch: string): string | null {');
lines.push('  if (ch.length === 0) return null;');
lines.push('  const i = PINYIN_BLOB.indexOf(ch);');
lines.push('  if (i < 0) return null;');
lines.push('  for (const [letter, start, end] of OFFSETS) {');
lines.push('    if (i >= start && i < end) return letter;');
lines.push('  }');
lines.push('  return null;');
lines.push('}');
lines.push('');

const out = lines.join('\n');
writeFileSync('src/lib/pinyin-table.ts', out, 'utf8');

const bytes = Buffer.byteLength(out, 'utf8');
console.log(`扫描码位: ${scanned}`);
console.log(`收录汉字: ${mapped}`);
console.log(`表体积: ${(bytes / 1024).toFixed(1)} KiB`);
console.log('各组字数:');
for (const [l, s, e] of offsets) {
  process.stdout.write(`${l}:${e - s} `);
}
console.log('');
