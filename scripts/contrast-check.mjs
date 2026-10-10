// WCAG 对比度核查：验证「深夜图书馆」主题的配色达标
const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
// 半透明色叠加到背景上（用于边框等）
const over = (fg, alpha, bg) => {
  const f = hex(fg), b = hex(bg);
  const m = f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)));
  return '#' + m.map((c) => c.toString(16).padStart(2, '0')).join('');
};

const INK = '#0e0c0a', INK2 = '#1a1714';
const cases = [
  ['正文 --paper  / 底 --ink',        '#f3ead8', INK,         4.5],
  ['正文 --paper  / 卡片 --ink-2',    '#f3ead8', INK2,        4.5],
  ['次要 --paper-dim / --ink',        '#cfc4ad', INK,         4.5],
  ['次要 --paper-dim / --ink-2',      '#cfc4ad', INK2,        4.5],
  ['强调 --glow / --ink（链接/文字）', '#ffb44d', INK,         4.5],
  ['强调 --glow / --ink-2',           '#ffb44d', INK2,        4.5],
  ['成功 --ok / --ink',               '#7dc98f', INK,         4.5],
  ['错误 --er / --ink',               '#ff8a7a', INK,         4.5],
  ['按钮底 --glow 上的 --ink 文字',    INK,       '#ffb44d',   4.5],
  ['边框 --line(.5) / --ink  [非文字 3:1]', over('#ffb44d', 0.5, INK), INK, 3.0],
  ['边框 --line(.5) / --ink-2 [非文字 3:1]', over('#ffb44d', 0.5, INK2), INK2, 3.0],
  ['弱分隔 --line-soft(.18) / --ink [装饰性]', over('#ffb44d', 0.18, INK), INK, 1.0],
];

console.log('WCAG 对比度核查（「深夜图书馆」主题）');
console.log('='.repeat(72));
let fails = 0;
for (const [name, fg, bg, min] of cases) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) fails++;
  const verdict = ok ? 'PASS' : 'FAIL';
  const level = r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA-large/UI' : '—';
  console.log(
    `${ok ? '  OK ' : '  NG '} ${r.toFixed(2).padStart(6)}:1  (需 ${min})  ${level.padEnd(11)} ${name}`,
  );
}
console.log('='.repeat(72));
console.log(fails === 0 ? '全部达标 ✅' : `${fails} 项未达标 ⚠️`);
