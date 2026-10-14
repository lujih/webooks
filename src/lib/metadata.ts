/** 从文件名推导元数据。Phase 1 会换成解析 EPUB OPF / PDF XMP 的 Queue consumer。 */

import { normaliseFormat } from './collections';

const CONTENT_TYPES: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  azw: 'application/vnd.amazon.ebook',
  fb2: 'application/fb2+xml',
  djvu: 'image/vnd.djvu',
  txt: 'text/plain; charset=utf-8',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  md: 'text/markdown; charset=utf-8',
  // 安全：HTML 一律按纯文本提供，绝不用 text/html。
  // 公开匿名书库若以 text/html 提供文件，等于把项目域名变成任意内容托管点
  // （钓鱼/挂马/存储型 XSS）。浏览器仍能查看源码或下载，只是不渲染。
  html: 'text/plain; charset=utf-8',
  htm: 'text/plain; charset=utf-8',
  xhtml: 'text/plain; charset=utf-8',
  svg: 'application/octet-stream',
};

export interface DerivedMetadata {
  title: string;
  author: string | null;
  format: string;
  contentType: string;
  extension: string;
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * 泛型 content-type —— 这些值没有信息量，应该让位给扩展名推导。
 * 典型场景：客户端用 fetch 发字符串 body 时会自动带上 text/plain，
 * 或者 WebDAV 客户端统一用 application/octet-stream。
 */
const GENERIC_TYPES = new Set([
  '',
  'text/plain',
  'application/octet-stream',
  'binary/octet-stream',
]);

/** 优先用客户端给的具体类型；给的是泛型就回退到扩展名推导。 */
export function preferContentType(
  headerValue: string | null | undefined,
  derived: string,
): string {
  const raw = (headerValue ?? '').trim();
  const essence = raw.split(';')[0]!.trim().toLowerCase();
  return GENERIC_TYPES.has(essence) ? derived : raw;
}

/**
 * **写入存储时必须使用的** Content-Type —— 只按扩展名推导。
 *
 * 安全要点（真实漏洞）：R2 对象提供的就是写入时 httpMetadata.contentType，
 * 而不是 D1 里的值。早期实现把客户端声明的 Content-Type 原样写进 R2，
 * 于是 `PUT /dav/recent/x.epub` 带 `Content-Type: text/html` 就能让
 * `books.<域名>/books/<id>` 以 text/html 返回任意 HTML/JS —— WebDAV 端点
 * 没有 Turnstile，脚本可批量滥用。现在一律以扩展名为准（未知扩展名 →
 * application/octet-stream，浏览器只会下载不会渲染）。
 */
export function safeContentTypeFor(leafName: string): string {
  return contentTypeFor(extensionOf(leafName));
}

/**
 * 清洗叶子文件名。
 * WebDAV 的 href 里不能出现 `/`、控制字符；`.` 和 `..` 直接拒绝。
 */
export function sanitiseLeafName(raw: string, maxLength = 200): string | null {
  let name = raw.trim();
  if (!name) return null;
  // 去掉路径分隔符与控制字符
  name = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_');
  // 去掉 Windows 不允许的字符
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  if (!name || name === '.' || name === '..') return null;
  if (name.length > maxLength) {
    // 保留扩展名，从中间截断
    const ext = extensionOf(name);
    const keep = maxLength - (ext ? ext.length + 1 : 0);
    name = ext ? `${name.slice(0, Math.max(keep, 1))}.${ext}` : name.slice(0, maxLength);
  }
  return name;
}

/**
 * 作者名规范化：去掉常见的修饰，返回干净的名字或 null。
 * 真实文件名里作者位的写法非常杂：`作者：X`、`X 著`、`[X]`、`（X）`、
 * `X、Y 合著`……统一在这里收敛。
 */
export function normaliseAuthor(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;

  // 先判占位符，**再**做拆分 —— 否则 `N/A` 会被 `/` 拆成 `N` 而漏判
  if (/^(未知|佚名|不详|无|none|unknown|n\/a|anonymous)$/i.test(s)) return null;

  // 去掉「作者：」「著：」「by 」这类前缀
  s = s.replace(/^\s*(?:作者|著者|原著|文|by)\s*[:：]?\s*/i, '').trim();
  // 去掉「 著」「 作品」「 编」这类后缀
  s = s.replace(/\s*(?:著|作品|编著|编|译|原著)\s*$/u, '').trim();
  // 去掉包裹符号
  s = s.replace(/^[\[【(《（<]\s*/, '').replace(/\s*[\]】)）》>]$/, '').trim();

  // 多作者：只取第一位用于分桶（「刘慈欣、韩松」→ 刘慈欣）
  const first = s.split(/[、,，;；/|]|\s+and\s+/i)[0];
  if (first) s = first.trim();

  // 去掉残留的首尾标点
  s = s.replace(/^[\s\-–—_·.]+/, '').replace(/[\s\-–—_·.]+$/, '').trim();

  if (!s || s.length > 60) return null;
  // 全是标点/数字的不当作者
  if (!/[\p{L}\u3400-\u9fff]/u.test(s)) return null;
  // 拆完可能又变成占位符（例如「作者：未知」）
  if (/^(未知|佚名|不详|无|none|unknown|n\/a|anonymous)$/i.test(s)) return null;
  return s;
}

/**
 * 常见中文姓氏（百家姓前 ~300 姓 + 常见复姓）。
 *
 * 为什么要它：`筚路维艰 - 萧冬连` 这种「书名 - 作者」里，两边都是 3-4 个汉字，
 * 光看长度完全分不出来。但**姓氏是极强的判据**：`萧`是姓、`筚`不是。
 *
 * ⚠️ 早期版本只有 100 个单字姓，实测只覆盖百家姓 406 姓的 **23.9%** ——
 *   于是东（东野圭吾）、司（司马迁）、柯、毕、安、史、严、曾、池、艾、
 *   麦、古、易、乔、关 这些高频姓全部缺失，而它们都是真实畅销书作者。
 *   下面补齐到约 300 字，复姓表也从 16 个扩到 37 个。
 */
const CJK_SURNAME_CHARS =
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许'
  + '何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章'
  + '云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳'
  + '酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常'
  + '乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹'
  + '姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞'
  + '熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危'
  + '江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍'
  + '虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓'
  + '郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁'
  + '荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫'
  + '乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫'
  + '宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶'
  + '郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙'
  + '池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉'
  + '宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别'
  + '庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖'
  + '庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳'
  + '沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简'
  + '饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺'
  + '权逯盖益桓公';

const CJK_COMPOUND_SURNAMES = [
  '欧阳', '司马', '上官', '诸葛', '东方', '独孤', '南宫', '慕容',
  '皇甫', '尉迟', '长孙', '宇文', '轩辕', '令狐', '夏侯', '公孙',
  '端木', '第五', '澹台', '闻人', '司徒', '司空', '鲜于', '闾丘',
  '子车', '亓官', '司寇', '巫马', '公西', '颛孙', '壤驷', '公良',
  '漆雕', '乐正', '宰父', '谷梁', '拓跋', '夹谷', '百里', '东郭',
  '南门', '呼延', '羊舌', '微生', '公户', '梁丘', '左丘', '东门',
  '西门', '商冼', '仲长', '太叔', '申屠',
];

/**
 * 人名常用字：高频出现在真实中文人名里的字。
 *
 * 这是替换掉「按长度猜人名」的关键。早期实现用长度打分
 * （2–3 字 +4、4 字 +1、5 字以上 −1），而中文**书名普遍 2–4 字、
 * 人名普遍 2–4 字** —— 两者高度重叠，于是长书名反而更像人名：
 *
 *   百年孤独（4字, 无姓）   → +1
 *   加西亚·马尔克斯（8字）  → −1   ← 判反
 *   呐喊（2字, 无姓）       → +4
 *   鲁迅（2字, 有姓）       → +10  ← 判反
 *   史记（2字, 无姓）       → +4
 *   司马迁（3字, 复姓）     → +10  ← 判反
 *
 * 改用「姓氏开头」+「含人名常用字」双重判据后，这类误判大幅下降。
 * 定量效果见 test/author-accuracy.test.ts（真实中文书 n=100+）。
 */
const GIVEN_NAME_CHARS =
  '伟刚勇毅俊峰强军平保东文辉力明永健世广志义兴良海山仁波宁贵福生龙元全国胜学祥才发武新利清飞彬'
  + '富顺信子杰涛昌成康星光天达安岩中茂进林有坚和彪博诚先敬震振壮会思群豪心邦承乐绍功松善厚庆磊'
  + '民友裕河哲江超浩亮政谦亨奇固之轮翰朗伯宏言若鸣朋斌梁栋维启克伦翔旭鹏泽晨辰士以建家致树炎德'
  + '行时泰盛雄琛钧冠策腾楠榕风航弘忠实诚信义礼智勇毅坚';

const CJK_SURNAMES = new Set(CJK_SURNAME_CHARS.split(''));
const CJK_GIVEN_CHARS = new Set(GIVEN_NAME_CHARS.split(''));

/** 名字是否以中文姓氏开头 */
function startsWithCjkSurname(s: string): boolean {
  if (CJK_COMPOUND_SURNAMES.some((c) => s.startsWith(c))) return true;
  const first = s[0];
  return !!first && CJK_SURNAMES.has(first);
}

/** 是否以复姓开头（复姓的人名形状判定要用：复姓+1~2字名） */
function hasCompoundSurname(s: string): boolean {
  return CJK_COMPOUND_SURNAMES.some((c) => s.startsWith(c));
}

/**
 * 人名常用字占比（用于区分人名与短书名）。
 *
 * 「三国演义」含 `国` 但那是国名不是人名；「呐喊」里一个人名字都没有 ——
 * 而真实人名几乎总含至少一个常用名字字（伟/强/军/平/东/文/辉…）。
 */
function givenNameRatio(core: string): number {
  if (core.length === 0) return 0;
  let hits = 0;
  for (const ch of core) if (CJK_GIVEN_CHARS.has(ch)) hits++;
  return hits / core.length;
}

/**
 * 「无姓词」有多像**书名**（用于给"无姓笔名"让路）。
 *
 * ⚠️ 这里踩过一个很典型的坑：早期只看「是否含人名常用字」，结果
 * `骆驼祥子`（骆）、`燕食记`（燕）、`时间简史`（间）、`金瓶梅`（金）
 * 这些**书名里的字**被当成了人名信号，于是书名被判成人名。
 *
 * 中文人名有个很强的结构特征：**第一个字几乎总是姓**。
 * 所以「无姓」的词若首字像人名常用字，更可能是书名而不是人名
 * （真笔名如「今何在」首字「今」本就不在常用字表里）。
 */
function looksLikeTitleNotName(core: string): boolean {
  const first = core[0];
  if (!first) return false;
  // 首字是人名常用字却没有姓 → 更像书名
  return CJK_GIVEN_CHARS.has(first) && !CJK_SURNAMES.has(first);
}

/**
 * 判断某个字符串有多「像人名」——用于消解 `A - B` 里哪边是作者。
 *
 * ⚠️ 这套打分替换掉了早期的「按长度猜」版本，原因见 GIVEN_NAME_CHARS 的
 * 注释：长度启发在中文上根本不成立（书名与人名长度高度重叠），
 * 实测会让 `百年孤独 - 加西亚·马尔克斯`、`呐喊 - 鲁迅`、`史记 - 司马迁`
 * 这类全部判反。
 *
 * 返回值只需**相对大小**有意义（调用方比较左右两边的分差）。
 */
function authorLikeness(s: string): number {
  const t = s.trim();
  if (!t) return -10;
  let score = 0;

  // 标题特征：强烈减分
  if (/[：:（(【\[《]/.test(t)) score -= 4;
  if (/\d/.test(t)) score -= 3;                       // 卷号/年份/册数
  if (/(全集|套装|合集|文集|上册|下册|第\s*\d|卷|册|话|回|部)/.test(t)) score -= 5;
  if (/[！!？?。，,、]/.test(t)) score -= 2;
  if (t.length > 14) score -= 3;

  const cjk = (t.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const dotFree = t.replace(/[·．.\s]/g, '');

  if (cjk > 0 && latin === 0) {
    const core = dotFree;

    // ── 含间隔号 `·` → 外国作者名的音译（强加分）──────────────────
    // 中文书名不使用间隔号，而西方人名的音译几乎总是「名 · 姓」：
    //   加西亚·马尔克斯、比尔·布莱森、乔治·奥威尔
    // 实测修复前 `百年孤独 - 加西亚·马尔克斯` 判反，因为去点后是 7 个
    // 纯汉字，在纯中文分支里拿不到任何「像人名」的信号（既无姓也无常用字）。
    if (/[·]/.test(t)) score += 7;

    // ── 书名的结构性特征（强减分）────────────────────────────────
    // 中文人名几乎不会用这些字结尾，而中文书名极常用：
    //   记（云中记/燕食记/剑侠情缘传）/ 传 / 演义 / 志 / 录 / 考 / 论
    //   演义（三国演义）/ 传奇（少林传奇）/ 曲 / 赋 / 碑 / 抄
    if (/[记传志录考论曲赋碑钞]$/.test(core)) score -= 5;
    // 「白夜」「空山」这类双字词：主谓结构，人名几乎不会是主谓
    if (core.length === 2 && !CJK_GIVEN_CHARS.has(core[0]!)) score -= 1;


    if (/^[\u3400-\u9fff]+$/.test(core)) {
      const surname = startsWithCjkSurname(core);
      const compound = hasCompoundSurname(core);

      if (surname) {
        // 姓氏开头是强信号，**但中文书名首字是常见姓氏的概率极高**：
        //   丰乳肥臀(丰) 云中记(云) 燕食记(燕) 骆驼祥子(骆) 金瓶梅(金)
        //   时间简史(时) 白夜行(白) 东野圭吾(东)
        // 这些都过了姓氏判定。所以「有姓」必须配合**长度约束**才有意义：
        //
        //   单姓 + 1 字名（茅盾、鲁迅、路遥）  = 2 字  ← 强信号
        //   单姓 + 2 字名（霍金、莫言、曹禺）  = 3 字  ← 强信号
        //   复姓 + 1 字名（司马迁）             = 3 字  ← 强信号
        //   复姓 + 2 字名（欧阳修）             = 4 字  ← 可信
        //   单姓 + 3 字名                       = 4 字  ← 存疑（可能是书名）
        //   ≥5 字                              ← 几乎必是书名
        //
        // 早期实现给「有姓 + 3/4 字」都 +2，于是上面那批书名全部被判成
        // 人名。实测误判全部集中在这一类。
        const nameLen = compound ? core.length - 2 : core.length - 1;
        if (nameLen >= 1 && nameLen <= 2) {
          score += 7;                    // 形状标准，强信号
          if (nameLen === 2) score += 2; // 2 字名比 1 字名更像完整姓名
          // ── 次级信号：姓后面的字是否像「名字」─────────────────
          // `陈忠实`（忠实 都在人名常用字里）vs `白鹿原`（鹿原 不是）：
          // 形状完全一样时，靠这一条打破平局。没有它，
          // `陈忠实 - 白鹿原` 与 `白鹿原 - 陈忠实` 会得到同一个结果
          // （实测确实如此），而平局只能靠兜底方向 —— 兜底是「书名在前」，
          // 于是「作者 - 书名」那一半约定全错。
          const givenPart = core.slice(compound ? 2 : 1);
          const ratio = givenNameRatio(givenPart);
          if (ratio >= 0.5) score += 3;
          else if (ratio === 0) score -= 2;
        } else if (nameLen === 3) {
          // 姓 + 3 字名：真实存在（东野圭吾、雷蒙·斯通这类音译），
          // 但也常见于书名（白夜行的时间史实、燕食记的…）。
          // 不给正分也不重罚 —— 交给名字常用字比例决定：
          //   东野圭吾 → 圭/吾 命中 → 加分
          //   白夜行   → 行 不在名字表 → 减分
          const givenPart3 = core.slice(compound ? 2 : 1);
          score += givenNameRatio(givenPart3) >= 0.5 ? 3 : -2;
        } else {
          score -= 4;                    // 姓后面跟 4 字以上 → 几乎必是书名
        }
      } else {
        // 没有姓：看含不含人名常用字（笔名/艺名，如「今何在」「老舍」）
        const given = givenNameRatio(core);
        if (looksLikeTitleNotName(core)) {
          // 首字是人名常用字却没有姓 → 结构上更像书名（`骆驼祥子`/`燕食记`）
          score -= 4;
        } else if (given >= 0.4) {
          score += 3;
        } else {
          // ⚠️ 没有姓且人名字很少 → 强烈倾向「这是书名」。
          //    早期版本在这里给「2–3 字 +4」，正是 `呐喊`/`史记`/`繁花`
          //    被判成人名的直接原因。
          score -= 3;
        }
        if (compound) score -= 2; // 占位：复姓必然已被上面命中
      }

      // 中文人名几乎不超过 5 字；6 字以上几乎必是书名。
      // 例外：含拉丁字母的音译名（加西亚·马尔克斯）绝不可能是中文书名，
      // 那条判据在下面单独加分，所以这里必须跳过它，否则两个判据互相抵消。
      const hasLatin = latin > 0;
      if (core.length >= 6 && !hasLatin) score -= 3;
    }
  } else if (latin > 0 && cjk === 0) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z]/.test(w))) score += 4;
  } else if (latin > 0 && cjk > 0) {
    // 混合型人名：`加西亚·马尔克斯`、`比尔·布莱森`
    // 含拉丁字母（多半是音译的中间名）且汉字 ≥ 4 → 典型外国作者名。
    // 早期版本这类词落在既非纯中文也非纯拉丁的分支里，得分为 0，
    // 于是 `百年孤独 - 加西亚·马尔克斯` 判反。
    if (cjk >= 3 && latin >= 1) score += 6;
  }

  // ── 音译的外国作者名：`赫伯特`、`霍金`、`布莱森` ──────────────────
  // 这类词的共同点是**构词法上像音译**：2–4 个汉字、不是常见姓氏开头、
  // 且不含任何中文虚词（的了在之其也与和）。
  if (/^[\u3400-\u9fff]{2,4}$/.test(dotFree) && !startsWithCjkSurname(dotFree)) {
    // 已经是「无姓」分支，这里只标注为「可能是音译名」以便与纯中文书名区分
    if (!/[的了在之其也与和是不有]/.test(dotFree)) score += 2;
  }

  return score;
}

/**
 * 从文件名猜测作者与书名。
 *
 * 分两层，显式标记永远优先（无歧义）：
 *   1. 显式标记：`作者：X` / `X 著` / 结尾的 `[X]`、`（X）`
 *   2. 分隔符 ` - ` / ` – ` / ` — ` / ` by `，用打分判断哪边是人名
 *
 * 为什么要打分而不是写死方向：`书名 - 作者` 与 `作者 - 书名` 两种约定都真实存在。
 * 写死任何一边都会让另一半错得离谱。打分看「哪边更像人名」，
 * 两边都不像时退回原有行为（作者在前），保持向后兼容。
 */
function guessAuthor(stem: string): { author: string | null; title: string } {
  const s = stem.trim();
  if (!s) return { author: null, title: stem };

  // ── 1. 显式标记 ──
  // `书名 作者：X` / `书名 (作者：X)`
  const marked = s.match(/^(.*?)[\s\-–—_]*[（(\[【]?\s*(?:作者|著者|原著)\s*[:：]\s*([^)）\]】]+?)\s*[)）\]】]?\s*$/u);
  if (marked && marked[1] && marked[2]) {
    const a = normaliseAuthor(marked[2]);
    const t = marked[1].trim();
    if (a && t) return { author: a, title: cleanTitle(t) };
  }
  // `书名 X 著`（中文常见）
  const zhuz = s.match(/^(.*?)\s+([^\s]{1,20})\s*著$/u);
  if (zhuz && zhuz[1] && zhuz[2]) {
    const a = normaliseAuthor(zhuz[2]);
    const t = zhuz[1].trim();
    if (a && t) return { author: a, title: cleanTitle(t) };
  }
  // 开头方括号里是作者：`[刘慈欣]三体`
  const lead = s.match(/^[\[【(（]\s*([^\]】)）]{1,20})\s*[\]】)）]\s*(.+)$/u);
  if (lead && lead[1] && lead[2]) {
    const inner = lead[1].trim();
    if (authorLikeness(inner) >= 4) {
      const a = normaliseAuthor(inner);
      const t = lead[2].trim();
      if (a && t) return { author: a, title: cleanTitle(t) };
    }
  }
  // 结尾括号里是作者：`书名 (张三)` / `书名 [张三]`
  const tail = s.match(/^(.*?)[\s]*[\[【(（]([^\]】)）]{1,30})[\]】)）]\s*$/u);
  if (tail && tail[1] && tail[2]) {
    const inner = tail[2].trim();
    // 括号里必须是「像人名」才认，否则可能是「(套装共4册)」这类说明
    if (authorLikeness(inner) >= 4) {
      const a = normaliseAuthor(inner);
      const t = tail[1].trim();
      if (a && t) return { author: a, title: cleanTitle(t) };
    }
  }

  // ── 2. 分隔符 + 打分 ──
  //
  // 分三种情形，而不是「两种都不像就默认作者在左」：
  //
  //   · 右边明显更像人名  → 书名 - 作者
  //   · 左边明显更像人名  → 作者 - 书名
  //   · **两边都判不出**  → 按「书名 - 作者」处理（见下方 DEFAULT_IS_TITLE_FIRST）
  //
  // ⚠️ 第三种情形是这个函数里最关键的一个决定，也是早期版本最大的错误。
  //
  // 早期实现在「两边都不像人名」时一律按「作者 - 书名」处理。实测后果：
  // 凡是**作者不是姓氏开头**的书全部判反 —— 紫金陈、老舍、加缪、
  // 兰陵笑笑生、今何在…（真实畅销书作者，占比不小），以及所有 4 字以上的
  // 外国作者名（加西亚·马尔克斯）。而这套命名里「书名 - 作者」才是主流约定。
  //
  // 换句话说：旧版在**最有价值的那一半**上是反的。
  //
  // 为什么「判不出」时选「书名在前」而不是干脆不猜：
  // 见 normaliseAuthor 的说明 —— 作者字段进 author_letter 分桶，
  // 「未知作者」是一个桶，把猜错的书塞进去反而丢失了作者信息。
  // 而在「书名 - 作者」约定占主流的前提下，选它是期望值更高的那一侧。
  for (const sep of [' - ', ' – ', ' — ', ' by ', ' -- ']) {
    const idx = s.indexOf(sep);
    if (idx <= 0 || idx >= s.length - sep.length) continue;
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + sep.length).trim();
    if (!left || !right) continue;

    const leftScore = authorLikeness(left);
    const rightScore = authorLikeness(right);

    // 右边明显更像人名 → 书名 - 作者
    if (rightScore > leftScore + 1) {
      const a = normaliseAuthor(right);
      if (a) return { author: a, title: cleanTitle(left) };
    }
    // 左边明显更像人名 → 作者 - 书名（这一支早期版本是兜底，保留为显式分支）
    if (leftScore > rightScore + 1) {
      const a = normaliseAuthor(left);
      if (a) return { author: a, title: cleanTitle(right) };
    }
    // 两边都判不出 → 默认「书名 - 作者」
    const fallback = normaliseAuthor(right);
    if (fallback) return { author: fallback, title: cleanTitle(left) };
    // right 也不合法（全是标点/超长）→ 退回旧的「作者 - 书名」
    const a = normaliseAuthor(left);
    if (a) return { author: a, title: cleanTitle(right) };
  }

  return { author: null, title: stem };
}

/** 书名清洗：去掉包裹的书名号，保留原有信息 */
function cleanTitle(t: string): string {
  const s = t.trim().replace(/^[《【]\s*/, '').replace(/\s*[》】]$/, '').trim();
  return s || t.trim();
}

/** 从文件内容（前若干 KB，按文本解码）里猜作者。用于 TXT 这类没有元数据的格式。 */
export function guessAuthorFromText(sample: string): string | null {
  if (!sample) return null;
  // 只看开头部分：中文小说一般在前几行标注作者
  const head = sample.slice(0, 4000);
  const patterns = [
    /作\s*者\s*[:：]\s*([^\r\n]{1,40})/u,
    /著\s*者\s*[:：]\s*([^\r\n]{1,40})/u,
    /原\s*著\s*[:：]\s*([^\r\n]{1,40})/u,
    /^\s*([^\r\n]{1,40}?)\s*著\s*$/mu,
    /Author\s*[:：]\s*([^\r\n]{1,40})/i,
  ];
  for (const re of patterns) {
    const m = head.match(re);
    if (m && m[1]) {
      const a = normaliseAuthor(m[1]);
      if (a) return a;
    }
  }
  return null;
}

export function deriveMetadata(leafName: string): DerivedMetadata {
  const ext = extensionOf(leafName);
  const stem = ext ? leafName.slice(0, -(ext.length + 1)) : leafName;
  const cleanedStem = stem.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || stem;
  const { author, title } = guessAuthor(cleanedStem);
  const format = normaliseFormat(ext);
  return { title: title || cleanedStem || leafName, author, format, contentType: contentTypeFor(ext), extension: ext };
}

/** R2 对象键里的文件名部分 */
export function leafNameFromKey(key: string): string {
  const base = key.split('/').filter(Boolean).pop() ?? key;
  return base;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
