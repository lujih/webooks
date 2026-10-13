/**
 * XML 良构性检查（严格模式）。
 *
 * 为什么不能只用 `expect(xml).toContain(...)`：
 *   真实事故 —— LOCK 响应里 `<D:locktoken><D:locktoken><D:href>…` 标签开了两次
 *   只关一次，产出的根本不是合法 XML，所有严格客户端都会解析失败
 *   （.NET 的原话："The 'D:locktoken' start tag does not match the end tag of 'D:lock'"）。
 *   而当时的测试全是字符串包含断言，一路绿灯。
 *
 * 为什么不用 HTMLRewriter 当检查器：
 *   试过了 —— 它是 **HTML** 解析器（lol-html），HTML 允许标签不闭合，
 *   对 `<a><a></a>` 和线上真实坏样本都返回「合法」，会给出**假通过**。
 *   一个会误判的检查器比没有检查器更危险。
 *
 * 本文件实现的是一个**保守**的严格检查：宁可漏报（返回 valid=true）也不误报，
 * 但必须能抓住真实的标签不配对。测试里先用线上坏样本证明它确实会报错。
 */

export interface XmlError {
  msg: string;
  line: number;
}

export interface XmlCheckResult {
  valid: boolean;
  err: XmlError | null;
}

/** 检查 XML 是否良构：标签配对、只有一个根元素、属性带引号。 */
export function checkXmlWellFormed(xml: string): XmlCheckResult {
  const src = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  let rootSeen = 0;
  let line = 1;

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;

    for (let k = i; k < lt; k++) if (src[k] === '\n') line++;

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end < 0) return fail('注释未闭合', line);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) return fail('CDATA 未闭合', line);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      if (end < 0) return fail('声明未闭合', line);
      i = end + 1;
      continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt < 0) return fail('标签未闭合', line);
    const inner = src.slice(lt + 1, gt).trim();

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      if (stack.length === 0) return fail(`多余的闭合标签 </${name}>`, line);
      const top = stack.pop() as string;
      if (top !== name) {
        return fail(`闭合 </${name}> 与开始 <${top}> 不匹配`, line);
      }
    } else if (inner.endsWith('/')) {
      if (stack.length === 0) rootSeen++;
      if (stack.length === 0 && rootSeen > 1) {
        return fail('存在多个根元素', line);
      }
      const attrErr = checkAttrs(inner.slice(0, -1), line);
      if (attrErr) return { valid: false, err: attrErr };
    } else {
      const name = inner.split(/[\s>/]/)[0] ?? '';
      if (!name) return fail('空标签名', line);
      if (stack.length === 0) {
        rootSeen++;
        if (rootSeen > 1) return fail('存在多个根元素', line);
      }
      const attrErr = checkAttrs(inner, line);
      if (attrErr) return { valid: false, err: attrErr };
      stack.push(name);
    }
    i = gt + 1;
  }

  if (stack.length > 0) {
    return fail(`未闭合的标签: <${stack.join('>, <')}>`, line);
  }
  if (rootSeen !== 1) {
    return fail(`根元素数量为 ${rootSeen}，应为 1`, 1);
  }
  return { valid: true, err: null };
}

function fail(msg: string, line: number): XmlCheckResult {
  return { valid: false, err: { msg, line } };
}

/**
 * 属性必须是 name="value" 形式。
 * 逐段消费 `key="value"`，剩余部分（去掉空白）必须为空。
 */
function checkAttrs(tagBody: string, line: number): XmlError | null {
  const nameMatch = tagBody.match(/^([A-Za-z_:][-A-Za-z0-9_:.]*)/);
  const name = nameMatch ? nameMatch[1]! : '';
  const rest = tagBody.slice(name.length);
  if (rest.trim() === '') return null;

  const re = /\s*([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  let pos = 0;
  const compact = rest;
  while (pos < compact.length) {
    re.lastIndex = pos;
    const m = re.exec(compact);
    if (!m) {
      return { msg: `标签 <${name}> 的属性格式不合法`, line };
    }
    pos = re.lastIndex;
  }
  return null;
}
