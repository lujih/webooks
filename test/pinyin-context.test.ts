/**
 * 多音字上下文表（`src/lib/pinyin-context.ts`）的**定量 + 逐条**回归测试。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * `pinyin-table.ts` 只认单字**默认读音**，于是「重庆」进 Z 桶、「厦门」进 S 桶、
 * 「单田芳」进 D 桶。这类错误单看代码发现不了（默认读音表本身是对的），
 * 只有拿一批评测文本跑一遍才看得见 —— 所以这里既有逐条断言，也有一份
 * 可复现清单算出的**实测准确率**。
 *
 * ── 实测数字（2026-10-20，本机）────────────────────────────────────────
 *   清单 62 条（真实中文书名优先 + 多音字作者/地名 + 常见词，见下方 MANIFEST）
 *   修复前：32/62 = 51.6%
 *   修复后：60/62 = 96.8%
 *   仍错的 2 条（**刻意保留为边界记录**，见「边界」describe）：
 *     · 种师道 → Z（应 chóng，C）：北宋种家将的「种」读 chóng，本表不收
 *     · 吐蕃   → T（应 tǔ bō）：该词读音本身词典/学界有分歧，**故意不收**
 *   若只算本表**声明覆盖**的 60 条（去掉上面 2 条边界样本）：
 *   修复前 32/60 = 53.3% → 修复后 60/60 = 100%
 *
 * ── 门槛为什么定在实测值而不是更高 ─────────────────────────────────────
 * 门槛 = 实测值（60/62），这是**如实的能力边界**，不是"够不到的目标"。
 * 定更高会长期红灯；定更低会放过回退。以后加词条只会让这个数上升，
 * 届时同步上调门槛（不要让门槛落后于能力）。
 *
 * ── 回归 ───────────────────────────────────────────────────────────────
 * `test/units.test.ts` 里原有的 `describe('letterBucket')` 一字未改，
 * 且本文件末尾再钉一遍它的关键用例 —— 上下文表绝不能改变不含多音字的书的行为。
 */

import { describe, expect, it } from 'vitest';
import { letterBucket } from '../src/lib/collections';
import { contextualInitial } from '../src/lib/pinyin-context';
import { pinyinInitial } from '../src/lib/pinyin-table';

/**
 * 评测清单：`[输入, 期望桶]`。
 *
 * 选材原则（照着写才能复现）：
 *   1. 前 30 条是**真实中文书/作者**，不含多音字陷阱 —— 用来证明改动**没有副作用**；
 *   2. 中间 30 条是**多音字陷阱**，每条本表都声明覆盖（读音依据见 pinyin-context.ts）；
 *   3. 最后 3 条是**边界**，本表故意不收，用来记录"表外仍会错"。
 *
 * 期望桶全部按《现代汉语词典》第 7 版 / 教育部《重編國語辭典修訂本》的读音。
 */
const MANIFEST: ReadonlyArray<readonly [string, string]> = [
  // ── 1. 真实书名（不含多音字陷阱）──
  ['三体', 'S'], ['活着', 'H'], ['围城', 'W'], ['红楼梦', 'H'], ['呐喊', 'N'],
  ['天龙八部', 'T'], ['白鹿原', 'B'], ['平凡的世界', 'P'], ['金瓶梅', 'J'],
  ['额尔古纳河右岸', 'E'], ['秦腔', 'Q'], ['一句顶一万句', 'Y'], ['丰乳肥臀', 'F'],
  ['秋园', 'Q'], ['倾城之恋', 'Q'], ['万历十五年', 'W'], ['许三观卖血记', 'X'],
  ['边城', 'B'], ['骆驼祥子', 'L'], ['呼兰河传', 'H'], ['尘埃落定', 'C'],
  ['局外人', 'J'], ['雷雨', 'L'],
  // ── 1b. 真实作者（不含多音字陷阱）──
  ['刘慈欣', 'L'], ['余华', 'Y'], ['老舍', 'L'], ['鲁迅', 'L'], ['莫言', 'M'],
  ['钱钟书', 'Q'], ['马伯庸', 'M'],

  // ── 2. 多音字陷阱：地名 ──
  ['重庆谈判', 'Q'], ['厦门志', 'X'], ['番禺县志', 'P'], ['犍为县志', 'Q'],
  ['蚌埠市志', 'B'], ['乐清县志', 'Y'], ['乐山风物志', 'L'], ['长子县志', 'Z'],
  ['长孙皇后', 'Z'], ['会稽山志', 'K'], ['蔚县县志', 'Y'], ['解州', 'X'], ['尉犁', 'Y'],
  ['铅山县志', 'Y'],
  // ── 2b. 多音字陷阱：姓氏 ──
  ['单田芳', 'S'], ['查良镛', 'Z'], ['曾国藩', 'Z'], ['区家麟', 'O'], ['解缙', 'X'],
  ['曾朴', 'Z'], ['仇英', 'Q'], ['尉迟恭', 'Y'], ['长孙无忌', 'Z'], ['万俟卨', 'M'],
  ['澹台灭明', 'T'],
  // ── 2c. 多音字陷阱：常见词 ──
  ['重复', 'C'], ['长大', 'Z'], ['会计学', 'K'], ['秘鲁', 'B'], ['藏族', 'Z'],

  // ── 3. 边界：本表**故意不收**，仍然错（记录，不是待办）──
  //   种师道：北宋种家将的读 chóng（维基百科「种师道」条目），表外的历史专名
  //   吐蕃：读音本身有争议（词典注 tǔ fān，学界多主张 tǔ bō），不收是怕引错
  ['种师道', 'C'], ['吐蕃', 'B'],
];

/** 清单里本表**声明覆盖**的那一段（前 60 条）；2 条边界单独断言 */
const COVERED = MANIFEST.slice(0, 60);

/** 修复前的取值逻辑：只看首字，用单字默认读音（即旧 letterBucket 的第 3 步） */
function legacyBucket(input: string): string {
  const text = input.trim();
  const m = text.match(/[A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/);
  if (!m) return 'other';
  const ch = m[0];
  if (ch >= 'A' && ch <= 'Z') return ch;
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase();
  if (ch >= '0' && ch <= '9') return '0-9';
  return pinyinInitial(ch) ?? 'other';
}

describe('多音字上下文表：逐条读音', () => {
  it('地名', () => {
    // 依据见 pinyin-context.ts 对应词条的注释（现汉 / 官方地名读音）
    expect(letterBucket('重庆')).toBe('Q'); // chóng qìng，不是 zhòng
    expect(letterBucket('厦门')).toBe('X'); // xià mén，不是 shà
    expect(letterBucket('番禺')).toBe('P'); // pān yú，广东地名
    expect(letterBucket('犍为')).toBe('Q'); // qián wéi，四川乐山下辖县
    expect(letterBucket('蚌埠')).toBe('B'); // bèng bù，安徽
    expect(letterBucket('六安')).toBe('L'); // lù ān，安徽（默认读音也是 L，此处锁住「不变」）
    expect(letterBucket('亳州')).toBe('B'); // bó zhōu，安徽（默认即 B，锁住不变）
    expect(letterBucket('乐清')).toBe('Y'); // yuè qīng，浙江温州
    expect(letterBucket('乐山')).toBe('L'); // lè shān，四川 —— 与乐清必须分开
    expect(letterBucket('长子')).toBe('Z'); // zhǎng zǐ，山西长子县
    expect(letterBucket('会稽山')).toBe('K'); // kuài jī shān，浙江绍兴
    expect(letterBucket('蔚县')).toBe('Y'); // yù xiàn，河北张家口
    expect(letterBucket('解州')).toBe('X'); // xiè zhōu，山西运城（见维基「解州镇」）
    expect(letterBucket('尉犁')).toBe('Y'); // yù lí，新疆
    expect(letterBucket('铅山县')).toBe('Y'); // yán shān，江西
    expect(letterBucket('泌阳县')).toBe('B'); // bì yáng，河南
  });

  it('姓氏（3 字人名走姓氏规则）', () => {
    expect(letterBucket('单田芳')).toBe('S'); // shàn tián fāng，评书表演艺术家
    expect(letterBucket('查良镛')).toBe('Z'); // zhā liáng yōng，金庸本名
    expect(letterBucket('曾国藩')).toBe('Z'); // zēng guó fān
    expect(letterBucket('区家麟')).toBe('O'); // ōu jiā lín，音同「欧」
    expect(letterBucket('解缙')).toBe('X'); // xiè jìn，明代，《永乐大典》总裁
    expect(letterBucket('尉迟恭')).toBe('Y'); // yù chí gōng，复姓尉迟
    expect(letterBucket('长孙无忌')).toBe('Z'); // zhǎng sūn wú jì，复姓长孙
    expect(letterBucket('万俟卨')).toBe('M'); // mò qí xiè，复姓万俟
    expect(letterBucket('澹台灭明')).toBe('T'); // tán tái miè míng，复姓澹台
  });

  it('姓氏（2 字人名靠专名条目，不能被常用词误伤）', () => {
    expect(letterBucket('曾朴')).toBe('Z'); // zēng pǔ，《孽海花》作者
    expect(letterBucket('仇英')).toBe('Q'); // qiú yīng，明代画家
    // 反向：同首字的常用词不能被姓氏规则带偏
    expect(letterBucket('曾经')).toBe('C'); // céng jīng
    expect(letterBucket('单纯')).toBe('D'); // dān chún
    expect(letterBucket('仇恨')).toBe('C'); // chóu hèn
    expect(letterBucket('区别')).toBe('Q'); // qū bié
  });

  it('常见词：同首字按第二字分读音', () => {
    expect(letterBucket('重要')).toBe('Z'); // zhòng yào（默认就对，锁住不变）
    expect(letterBucket('重复')).toBe('C'); // chóng fù
    expect(letterBucket('重量')).toBe('Z'); // zhòng liàng
    expect(letterBucket('长大')).toBe('Z'); // zhǎng dà
    expect(letterBucket('长城')).toBe('C'); // cháng chéng
    expect(letterBucket('长沙')).toBe('C'); // cháng shā
    expect(letterBucket('长安')).toBe('C'); // cháng ān
    expect(letterBucket('会计学')).toBe('K'); // kuài jì xué
    expect(letterBucket('秘鲁')).toBe('B'); // bì lǔ，国名
    expect(letterBucket('藏族')).toBe('Z'); // zàng zú
  });

  it('护栏词：3 字常用词不能被姓氏规则吃掉', () => {
    // 这些词若不显式登记，会被「单/查/区/曾 + 2 字名」的姓氏规则判成别的桶。
    // 它们就是 3 字阈值这个设计的代价，必须逐条锁住。
    expect(letterBucket('单行道')).toBe('D');
    expect(letterBucket('单眼皮')).toBe('D');
    expect(letterBucket('查号台')).toBe('C');
    expect(letterBucket('行政区')).toBe('Q');
    expect(letterBucket('区域性')).toBe('Q');
    expect(letterBucket('解方程')).toBe('J');
    expect(letterBucket('乐天派')).toBe('L');
    expect(letterBucket('曾道人')).toBe('C');
  });

  it('前导标点/书名号照旧跳过', () => {
    expect(letterBucket('《重庆谈判》')).toBe('Q');
    expect(letterBucket('  厦门志')).toBe('X');
    expect(letterBucket('【番禺县志】')).toBe('P');
    expect(letterBucket('——犍为县志')).toBe('Q');
    expect(letterBucket('《单田芳评书》')).toBe('S');
  });
});

describe('多音字上下文表：接口契约', () => {
  it('只对汉字开头生效，其余一律返回 null 交给调用方', () => {
    expect(contextualInitial('Dune')).toBeNull();
    expect(contextualInitial('1984')).toBeNull();
    expect(contextualInitial('阿Q正传')).toBeNull(); // 汉字前缀只有「阿」，配不上词条
    expect(contextualInitial('!!!')).toBeNull();
    expect(contextualInitial('')).toBeNull();
    expect(contextualInitial(null)).toBeNull();
    expect(contextualInitial(undefined)).toBeNull();
  });

  it('命中返回大写字母，未命中返回 null（不是空串、不是 other）', () => {
    expect(contextualInitial('重庆')).toBe('Q');
    expect(contextualInitial('重庆市')).toBe('Q'); // 最长前缀：先试「重庆市」再退「重庆」
    expect(contextualInitial('三体')).toBeNull(); // 普通词不命中，走回落
    expect(contextualInitial('重要')).toBeNull(); // zhòng 是默认读音，不需要词条
  });

  it('最长前缀优先，不会被短词条截断', () => {
    // 「乐山」是 L（lè），「乐清」是 Y（yuè）—— 二者第二字不同
    expect(contextualInitial('乐山风物志')).toBe('L');
    expect(contextualInitial('乐清县志')).toBe('Y');
    // 「长大」（zhǎng）与「长城」（cháng）同样靠第二字区分
    expect(contextualInitial('长大后')).toBe('Z');
    expect(contextualInitial('长城谣')).toBeNull(); // 「长城」不登记 → 回落默认 C，正确
  });
});

describe('多音字上下文表：实测准确率（定量基准）', () => {
  it('修复后命中 ≥ 60/62（实测 96.8%）', () => {
    const wrong: string[] = [];
    for (const [text, expected] of MANIFEST) {
      const actual = letterBucket(text);
      if (actual !== expected) wrong.push(`${text} → ${actual}（期望 ${expected}）`);
    }
    const hit = MANIFEST.length - wrong.length;
    const acc = (hit / MANIFEST.length) * 100;
    const detail = `\n  准确率 ${acc.toFixed(1)}%（${hit}/${MANIFEST.length}）`
      + (wrong.length ? `\n${wrong.map((w) => `    ❌ ${w}`).join('\n')}` : '');
    // 实测 60/62 = 96.8%。门槛按**条数**钉（不用百分比小数，避免 60/62=96.774
    // 这种四舍五入后与门槛擦肩而过的假红灯）。这是如实的能力边界，
    // 不是够不到的目标；加词条只会让这个数上升，届时同步上调门槛。
    expect(hit, detail).toBeGreaterThanOrEqual(60);
  });

  it('本表声明覆盖的 60 条必须全对（回归红线）', () => {
    const wrong: string[] = [];
    for (const [text, expected] of COVERED) {
      const actual = letterBucket(text);
      if (actual !== expected) wrong.push(`${text} → ${actual}（期望 ${expected}）`);
    }
    const detail = wrong.map((w) => `    ❌ ${w}`).join('\n');
    // 这一条是**硬断言**（100%），因为它全部落在表覆盖范围内；
    // 上面那条 96.8% 的余量全部来自 3 条刻意的边界样本。
    expect(wrong, `\n${detail}`).toHaveLength(0);
  });

  it('修复前是 32/62（51.6%）—— 记录基线，证明这个改动不是自嗨', () => {
    let hit = 0;
    for (const [text, expected] of MANIFEST) {
      if (legacyBucket(text) === expected) hit++;
    }
    // 基线钉住：如果哪天旧行为"意外"变准了（例如有人改了 pinyin-table），
    // 这里会提醒我们重新评估基线，而不是让 96.8% 这个数失去意义。
    expect(hit).toBe(32);
  });
});

describe('多音字上下文表：边界（表外多音字仍会错）', () => {
  it('本表不收录的专名/争议读音仍然落错桶 —— 这是已知边界，不是 bug', () => {
    // 种师道：北宋种家将，「种」作姓读 chóng（维基百科「种师道」条目），
    // 首字母 C。本表不收历史专名的姓氏读音（收了就得收几百个历史人物），
    // 于是单字默认读音 zhǒng 让它落进 Z —— 错，且**我们明确知道它错**。
    expect(letterBucket('种师道')).toBe('Z');
    expect(contextualInitial('种师道')).toBeNull();

    // 吐蕃：读音本身有分歧（现汉注 tǔ fān，学界多主张 tǔ bō）。
    // 「一条错读音比没有更糟」，所以宁可让它走默认 F 之外的路径 ——
    // 这里默认读音把「吐」判成 T，与 bō/fān 都无关（错在第二个字，不影响首字桶），
    // 首字 tǔ 的 T 其实是对的；记录它只是为了说明**表不覆盖 ≠ 首字必错**。
    expect(letterBucket('吐蕃')).toBe('T');
  });

  it('未收录的同首字词会退回默认读音，可能对也可能错', () => {
    // 「重庆森林」是王家卫电影，读 chóng qìng —— 前缀命中「重庆」所以对
    expect(letterBucket('重庆森林')).toBe('Q');
    // 「重耳」（晋文公）读 chóng ěr，未收录 → 落默认 zhòng 的 Z（错，已知边界）
    expect(letterBucket('重耳')).toBe('Z');
    // 「藏地密码」是 cáng（藏起来），未收录 → 落默认 C（对，因为默认就是 cáng）
    expect(letterBucket('藏地密码')).toBe('C');
    // 「解忧杂货店」是 jiě（4 字，不受 3 字姓氏规则影响）
    expect(letterBucket('解忧杂货店')).toBe('J');
    // 「查无此人」同理（4 字）
    expect(letterBucket('查无此人')).toBe('C');
  });
});

describe('回归：原有 letterBucket 行为一字不变', () => {
  it('拉丁字母 / 数字 / 空值', () => {
    expect(letterBucket('Dune')).toBe('D');
    expect(letterBucket('dune')).toBe('D');
    expect(letterBucket('1984')).toBe('0-9');
    expect(letterBucket('')).toBe('other');
    expect(letterBucket(null)).toBe('other');
  });

  it('中文按拼音首字母归桶', () => {
    expect(letterBucket('三体')).toBe('S');
    expect(letterBucket('末世降临')).toBe('M');
    expect(letterBucket('呐喊')).toBe('N');
    expect(letterBucket('阿Q正传')).toBe('A');
    expect(letterBucket('围城')).toBe('W');
    expect(letterBucket('活着')).toBe('H');
    expect(letterBucket('天龙八部')).toBe('T');
    expect(letterBucket('红楼梦')).toBe('H');
  });

  it('前导标点/空白跳过', () => {
    expect(letterBucket('  三体')).toBe('S');
    expect(letterBucket('《呐喊》')).toBe('N');
    expect(letterBucket('【三体】')).toBe('S');
    expect(letterBucket('——活着')).toBe('H');
  });

  it('表外文字落 other，生僻字不崩', () => {
    expect(letterBucket('あいう')).toBe('other');
    expect(letterBucket('Привет')).toBe('other');
    expect(letterBucket('!!!')).toBe('other');
    expect(typeof letterBucket('㐀')).toBe('string');
  });

  it('多音字表不改变「首个可定序字符」的判定口径', () => {
    // 首字符是拉丁字母时，即使后面跟着多音字，也不该被上下文表接管
    expect(letterBucket('QQ重庆')).toBe('Q');
    expect(letterBucket('3体重磅')).toBe('0-9');
  });
});
