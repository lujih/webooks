// WCAG 对比度核查：「开架目录」主题（深松绿 + 纸 + 黄铜 + 铜绿）
//
// 用法：node scripts/contrast-check.mjs
//   任一项不达标时以退出码 1 结束，因此可以直接挂进 CI。
//
// ⚠️ 这个文件是**手工维护**的：色值不从这里读，而是 src/lib/theme.ts 里
//   :root 的那一份。改配色时必须同步改下面的常量，否则脚本会安安静静地
//   检查一套已经不存在的颜色 —— 它自己不会发现（曾经就是这样：
//   theme 换成新色板后，脚本还在验旧色，全部「达标」，一次都没红过）。
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

// ── 与 src/lib/theme.ts 的 :root 一一对应 ───────────────────────────────
const INK = '#0b100e';         // --ink
const INK2 = '#121a16';        // --ink-2
const PAPER = '#efe6d4';       // --paper
const PAPER_DIM = '#a8a292';   // --paper-dim
const PAPER_FAINT = '#6f6b5f'; // --paper-faint（只用于行号等辅助位）
const BRASS = '#dca85f';       // --brass（交互与活态）
const BRASS_LIFT = '#eec183';  // --brass-lift（hover）
const JADE = '#8fb3a4';        // --jade（结构性信息）
const OK = '#8fc9a3';
const ER = '#ef8b7c';

const cases = [
  // 正文与次要文字：必须 4.5
  ['正文 --paper / --ink', PAPER, INK, 4.5],
  ['正文 --paper / --ink-2', PAPER, INK2, 4.5],
  ['次要 --paper-dim / --ink', PAPER_DIM, INK, 4.5],
  ['次要 --paper-dim / --ink-2', PAPER_DIM, INK2, 4.5],
  // 黄铜是链接色，必须按正文标准
  ['链接 --brass / --ink', BRASS, INK, 4.5],
  ['链接 --brass / --ink-2', BRASS, INK2, 4.5],
  ['hover --brass-lift / --ink', BRASS_LIFT, INK, 4.5],
  ['按钮底 --brass 上的 --ink 文字', INK, BRASS, 4.5],
  // 语义色
  ['成功 --ok / --ink', OK, INK, 4.5],
  ['错误 --er / --ink', ER, INK, 4.5],
  ['铜绿 --jade / --ink（计数/标记）', JADE, INK, 4.5],
  ['铜绿 --jade / --ink-2', JADE, INK2, 4.5],
  // 非文字：交互控件边框须 3:1（WCAG 1.4.11）
  ['交互边框 --edge(paper@.42) / --ink', over(PAPER, 0.42, INK), INK, 3.0],
  ['交互边框 --edge(paper@.42) / --ink-2', over(PAPER, 0.42, INK2), INK2, 3.0],
  ['暖边框 --edge-warm(brass@.6) / --ink', over(BRASS, 0.6, INK), INK, 3.0],
  // 装饰性分隔线：只要不是完全看不见即可
  ['分隔线 --rule(paper@.14) / --ink [装饰]', over(PAPER, 0.14, INK), INK, 1.0],
  ['分隔线 --rule-strong(paper@.24) / --ink [装饰]', over(PAPER, 0.24, INK), INK, 1.0],
  // 行号用的 faint：辅助文字，按 3:1 兜底
  ['行号 --paper-faint / --ink [辅助]', PAPER_FAINT, INK, 3.0],
];

console.log('WCAG 对比度核查（「开架目录」主题）');
console.log('='.repeat(74));
let fails = 0;
for (const [name, fg, bg, min] of cases) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) fails++;
  const level = r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA-large/UI' : '—';
  console.log(
    `${ok ? '  OK ' : '  NG '} ${r.toFixed(2).padStart(6)}:1  (需 ${min})  ${level.padEnd(11)} ${name}`,
  );
}
console.log('='.repeat(74));
if (fails === 0) {
  console.log('全部达标 ✅');
} else {
  console.log(`${fails} 项未达标 ⚠️`);
  process.exitCode = 1;
}
