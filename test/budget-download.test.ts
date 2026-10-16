import { describe, expect, it } from 'vitest';

import { testEnv } from './setup';

/**
 * 「下载路径」的记账守卫。
 *
 * 为什么单独一组：请求预算是本站最紧的硬指标（免费套餐每天 100,000 次，
 * 超额即停摆到次日 UTC 0 点），而这个项目**曾经因为模型算错而真的停摆过
 * 一次** —— 模型报「只用 16%」，现实打满。
 *
 * 所以每当「某条路径的请求成本」发生变化，就必须同时钉住三件事：
 *   ① 新成本被如实记账（不许再算成省的）
 *   ② 未被优化的路径不许被顺手「一起省掉」（那是自欺）
 *   ③ 线上探针要能发现回归
 *
 * 这里断言的是**源码文本**。测试跑在 workerd 里，读不到文件系统
 * （node:fs 是空壳，连 process.cwd() 都 readdir 不了），所以由
 * vitest.config.ts 在 Node 侧读好、以 TEST_STATIC_ASSETS binding 传进来。
 *
 * ⚠️ 不要 `import` 另一个 *.test.ts 拿快照 —— 那会把对方的 describe
 * 在本文件里再注册一遍，测试数虚增。快照直接从这里取。
 */

const SNAPSHOT = testEnv.TEST_STATIC_ASSETS;
const BUDGET = SNAPSHOT.budgetSource;
const VERIFY = SNAPSHOT.verifyDeploySource;

describe('预算模型：浏览页下载已改直链，记账要跟上', () => {
  it('源码读到了（否则下面的断言会假绿）', () => {
    expect(BUDGET.length, 'budget.mjs 没读到').toBeGreaterThan(1000);
    expect(VERIFY.length, 'verify-deploy.mjs 没读到').toBeGreaterThan(1000);
  });

  it('浏览会话的请求成本是 4（不是 4 + 3）', () => {
    // 书卡直链 R2 之后，点开一本书不再经过 Worker。
    // 曾经的写法是 `const browseRequests = 4 + 3;`（进 4 个目录 + 下 3 本书）。
    expect(BUDGET, 'browseRequests 又变回把下载也算成 Worker 请求了').not.toMatch(
      /const browseRequests = 4 \+ 3;/,
    );
    expect(BUDGET).toMatch(/const browseRequests = 4;/);
  });

  it('全库同步仍要算每本书一次请求（WebDAV 的 GET 302 没有变）', () => {
    // 这是本组最重要的一条：直链只省掉**浏览页**那条路。
    // rclone / Finder 走 WebDAV，`GET /dav/<书>` 仍然返回 302
    // （客户端依赖它），所以每个目录 1 次 PROPFIND + 每本书 1 次 GET 照旧。
    //
    // 如果哪天有人把这里的 `+ a.books` 也删掉（以为「下载已免费」），
    // 模型会立刻少报掉最大的一项开销 —— 正是上次停摆的形态。
    expect(BUDGET, 'syncRequests 被当成「下载已免费」而漏算每本书的 GET').toMatch(
      /const syncRequests = directories \+ a\.books;/,
    );
  });

  it('必须写明「省的是请求配额，不是 R2 的 Class B 计数」', () => {
    // 两本账不能混：直链省的是 Worker 请求，R2 的 GetObject 照旧计数。
    // 少了这句话，下一个人会把 downloadsPerDay 也一起删掉。
    expect(BUDGET).toMatch(/downloadsPerDay = a\.browse \* 3 \+ a\.syncs \* a\.books;/);
    expect(BUDGET, '没有说明直链省的是请求配额而不是 R2 读计数').toMatch(/请求配额/);
  });

  it('文件头不许再写「目录页可被 CDN 缓存，重复浏览不消耗 Worker 请求」', () => {
    // 那句话是错的（Cache API 命中时 Worker 照跑），也是「模型说 16%、
    // 现实打满」的原因之一。删过一次，不许写回来。
    expect(BUDGET, '那句被证伪的「目录页可被 CDN 缓存」又回来了').not.toMatch(
      /目录页 HTML 可被 CDN 缓存/,
    );
    expect(BUDGET).toMatch(/目录页 HTML \*\*不是\*\*免费的/);
  });
});

describe('线上探针：书卡直链回归要能被发现', () => {
  it('存在书卡直链探针，并且真的被调用', () => {
    expect(VERIFY, '探针函数没了').toMatch(/async function probeBookCardsLinkDirectToR2\(/);
    expect(VERIFY, '探针定义了却没在 main 序列里调用').toMatch(
      /await probeBookCardsLinkDirectToR2\(\);/,
    );
  });

  it('探针必须区分书卡与集合卡（只改书卡，目录仍要走 Worker）', () => {
    // bookcard = 书（要直链），shelfcard = 目录（必须继续走 /dav）。
    // 只抓卡片的 href，会把目录卡也算进来 → 探针永远报 fail。
    expect(VERIFY).toMatch(/card bookcard/);
  });

  it('探针必须真的去取那本书，不能只看 href 长得对', () => {
    // 「href 拼错了」和「href 是直链」在只看字符串时无法区分：
    // 两者都不是 /dav/ 开头。所以必须发一次请求确认拿得到字节。
    // （探针走 fetchRead —— 带 8s 超时 + 网络层瞬时失败的一次重试，
    //   见 scripts/verify-deploy.mjs 里的实测注释。写法可以变，
    //   「对 probe 发了请求」这件事不能变。）
    expect(VERIFY, '没有对直链发请求 —— href 拼错会假绿').toMatch(/fetchRead\(\s*probe\b/);
    expect(VERIFY).toMatch(/method: 'HEAD'/);
    expect(VERIFY).toMatch(/content-disposition/);
  });

  it('探针必须要求 http(s) 绝对地址，不能只排除 /dav/', () => {
    // 只排除 `/dav/` 的写法有个洞：`href=""` 和 `href="undefined"` 同样
    // 不以 /dav/ 开头，却都是相对路径 —— 点击 404，而探针会报 ✅。
    // 这正是 browse-page.ts 里那条回退分支要防的形态。
    const idx = VERIFY.indexOf('function probeBookCardsLinkDirectToR2');
    expect(idx, '找不到 probeBookCardsLinkDirectToR2').toBeGreaterThan(0);
    const tail = VERIFY.slice(idx);
    const end = tail.indexOf('\n}\n');
    const body = tail.slice(0, end > 0 ? end : 3000);
    // 源码里写的是正则 `!/^https?:\/\//i.test(h)`。这里用**纯字符串**定位，
    // 不再套一层正则 —— 上面已经踩过「用正则描述正则」把转义数错的坑。
    expect(body, '探针没有要求绝对地址 —— href="undefined" 会假绿').toContain('^https?:');
    expect(body, '绝对地址的判据必须是正则 test，不是别的小把戏').toMatch(/\/i\.test\(/);
    // 而且诊断顺序不能反：/dav/ 也匹配不上 http(s)，先判相对地址会把
    // 「还在花配额」这条准确提示吞掉。
    //
    // 用**代码标识符**定位，不用中文注释 —— 那段注释里同时提到了「/dav/」
    // 与「绝对地址」，按文案找会命中注释，断言就变成在测注释的措辞。
    const davPos = body.indexOf('const viaWorker');
    const absPos = body.indexOf('const relative');
    expect(davPos, '找不到 viaWorker 判定').toBeGreaterThan(0);
    expect(absPos, '找不到 relative 判定').toBeGreaterThan(0);
    expect(davPos, 'viaWorker 必须在 relative 之前判（否则 /dav/ 的诊断会被吞掉）')
      .toBeLessThan(absPos);
  });

  it('缺口令时不许把 Overwrite 探针判成 fail（RFC 4918 §10.6 + §8.1）', () => {
    // 401 是规范要求的行为：`The server MUST do authorization checks before
    // checking this or any conditional header`，且授权错误优先于其它错误。
    // 曾经这条探针在**完全正确的部署**上报 ❌，导致我照着一个不存在的问题
    // 去线上排查。
    const idx = VERIFY.indexOf('function probeOverwrite');
    expect(idx, '找不到 probeOverwrite').toBeGreaterThan(0);
    // 取到函数体结束（下一个顶层 `}` 后的换行 + 空行），别只切固定长度 ——
    // 那个函数上方还有一段很长的说明注释，切短了会切到别人的代码里。
    const tail = VERIFY.slice(idx);
    const end = tail.indexOf('\n}\n');
    const body = tail.slice(0, end > 0 ? end : 2000);
    expect(body, 'probeOverwrite 又没有写口令守卫了').toMatch(/if \(!canWrite\(\)\)/);
    // 守卫必须**早退**，不能只是记个变量继续往下写文件
    const guardPos = body.indexOf('if (!canWrite())');
    const putPos = body.indexOf("call('PUT'");
    expect(guardPos, '找不到写口令守卫').toBeGreaterThan(0);
    if (putPos > 0) {
      expect(guardPos, '写口令守卫必须在任何落盘操作之前').toBeLessThan(putPos);
    }
    // 函数体里必须写明「无口令时 401 是规范行为」，否则下一个人还会把它改回 fail
    const lead = VERIFY.slice(Math.max(0, idx - 1200), idx);
    expect(lead + body).toMatch(/RFC 4918 §10\.6|§10\.6/);
  });
});

describe('线上探针：口令配错不许伪装成「线上是旧代码」', () => {
  // 这是第四个真实缺陷。CI 的 WRITE_TOKEN secret 是个无效值（实测把
  // ADMIN_TOKEN 当写口令用），而探针只看「传没传」（TOKEN.length > 0），
  // 于是稳定打印 `❌ 实际 401` + `结论：线上仍是**旧代码**`。我照这个结论
  // 去线上追了两轮，而线上其实早就是新代码 ——
  // 判据：修复前 COPY 撞已有目标必然 201 并破坏目标，不可能返回 401。

  /** 取某个顶层函数的函数体（到下一个 `}` 后换行止） */
  function bodyOf(name: string): string {
    const idx = VERIFY.indexOf(`function ${name}(`);
    expect(idx, `找不到 ${name}`).toBeGreaterThan(0);
    const tail = VERIFY.slice(idx);
    const end = tail.indexOf('\n}\n');
    return tail.slice(0, end > 0 ? end : 3000);
  }

  it('必须有口令预检，并且排在三条写探针之前', () => {
    expect(VERIFY, '口令预检函数没了').toMatch(/async function probeWriteToken\(/);
    const callPos = VERIFY.indexOf('await probeWriteToken();');
    expect(callPos, '预检定义了却没被调用').toBeGreaterThan(0);
    for (const probe of ['await probeCopyWhitelist();', 'await probeUnlockNoToken();', 'await probeOverwrite();']) {
      const pos = VERIFY.indexOf(probe);
      expect(pos, `找不到 ${probe}`).toBeGreaterThan(0);
      expect(callPos, `预检必须排在 ${probe} 之前`).toBeLessThan(pos);
    }
  });

  it('预检必须用「DELETE 一个不存在的叶子」判定口令可用性', () => {
    const body = bodyOf('probeWriteToken');
    // 口令有效 → handleDelete 的 findBookByLeaf 拿 null → 404
    // 口令无效 → 分发层的 hasWriteToken 先拦成 401
    expect(body, '预检必须用 DELETE（GET 是匿名的，验不出写口令）').toMatch(/call\('DELETE'/);
    expect(body, '预检没判 404 —— 口令有效时就是 404').toContain('404');
    expect(body, '预检没判 401/403').toMatch(/401/);
  });

  it('预检路径必须落在叶子上，绝不能是集合（否则会删掉整个集合）', () => {
    // ⚠️ 最危险的一条：`/dav/<集合>/` 的 DELETE 等价于 Depth: infinity，
    // 会把整个集合连成员一起删掉。预检路径必须带叶子名。
    const body = bodyOf('probeWriteToken');
    const m = body.match(/call\('DELETE',\s*([^\n]+?)\)/);
    expect(m, '找不到预检的 DELETE 调用').not.toBeNull();
    const arg = m![1]!;
    expect(arg, '预检路径必须带叶子名（`${TMP}_tokencheck.txt` 之类），'
      + '不能只是一个集合路径 —— 那会走 Depth: infinity 分支删掉整个集合').not.toMatch(/^`\$\{DAV\}\/`$/);
    expect(arg, '预检的文件名必须是本次运行唯一的（含 TMP，即 base36 时间戳），'
      + '否则可能与真书重名').toContain('${TMP}');
  });

  it('口令被拒时要单独计类，不能算进「线上是旧代码」', () => {
    // 分开计类的意义：credential 类 fail 证明不了线上代码是新的，
    // 但也**证伪不了** —— 混在一起就会得出错误结论。
    expect(VERIFY, '预检结果没打 credential 标记').toContain("kind: 'credential'");
    expect(VERIFY, '结论区没有 credentialFail 分支').toMatch(/if \(credentialFail > 0\)/);
    // ⚠️ 变异验证抓到过：只断言「有 kind 标记」和「有 credentialFail 分支」
    // 是不够的 —— 汇总循环里若直接把 `fail++`（丢掉 `r.kind === 'credential'`
    // 的分流），凭据 fail 就又混回「旧代码」去了，而**所有断言照样绿**。
    // 这里必须钉住「汇总循环里真的分流了」。
    const loopStart = VERIFY.indexOf('for (const r of results)');
    const loopEnd = VERIFY.indexOf('console.log(`  结论：线上仍是**旧代码**');
    expect(loopStart, '找不到结果汇总循环').toBeGreaterThan(0);
    expect(loopEnd, '找不到结论区').toBeGreaterThan(loopStart);
    const loop = VERIFY.slice(loopStart, loopEnd);
    expect(loop, '汇总循环没有把 credential 类分流出去 —— 凭据问题会被读成「线上是旧代码」')
      .toMatch(/r\.kind === 'credential'/);
    expect(loop, 'credentialFail 没有被累加').toMatch(/credentialFail\+\+/);
    // 凭据分支必须排在「旧代码」分支**之后**（真 fail 优先报出来），
    // 但排在「新代码」分支**之前**（否则凭据错误会被 5 项 pass 掩盖成通过）
    const oldCode = VERIFY.indexOf('结论：线上仍是**旧代码**');
    const cred = VERIFY.indexOf('if (credentialFail > 0)');
    const newCode = VERIFY.indexOf('结论：线上是**新代码**');
    expect(oldCode, '找不到「旧代码」分支').toBeGreaterThan(0);
    expect(cred, '找不到凭据分支').toBeGreaterThan(0);
    expect(newCode, '找不到「新代码」分支').toBeGreaterThan(0);
    expect(cred, '凭据分支必须排在「旧代码」分支之后').toBeGreaterThan(oldCode);
    expect(cred, '凭据分支必须排在「新代码」分支之前 —— 否则凭据配错会被读成通过').toBeLessThan(newCode);
  });

  it('凭据分支的文案必须点明「不是代码问题」并说清怎么修', () => {
    const idx = VERIFY.indexOf('if (credentialFail > 0)');
    // 切到下一个顶层 `}` 为止，别用固定长度 —— 固定长度会切到后面
    // `if (pass > 0)` 那支里的 `process.exit(0)`，断言就变成在测别人的代码。
    const tail = VERIFY.slice(idx);
    const end = tail.indexOf('\n}\n');
    const body = tail.slice(0, end > 0 ? end : 1600);
    expect(body, '没点明这不是代码问题').toContain('不是代码问题');
    expect(body, '没说 ADMIN_TOKEN 不能当写口令用').toContain('ADMIN_TOKEN');
    expect(body, '没给出修复命令').toMatch(/wrangler secret put WRITE_TOKEN/);
    // 打 error annotation：Actions 页面上要一眼看到，不必翻日志。
    // 断言的是「调用了 emitFailureAnnotation」而不是字面量 `::error` ——
    // 那行 `console.log('::error …')` 现在被封在这个函数里（三个失败分支
    // 都在用它，内联三份会把同一段逻辑抄三遍）。
    expect(body, '没有打 GitHub error annotation').toContain('emitFailureAnnotation(');
    // 且必须是「如实报未验完」的语义 —— 绿灯比红灯危险：这个项目反复在打
    // 假绿（探针没跑却说「已验证通过」）。三条写探针没跑就是没验到。
    expect(body, '凭据分支必须照样 exit（--strict 下 exit 1），不能 exit 0 —— 那就是假绿')
      .toMatch(/process\.exit\(STRICT \? 1 : 0\)/);
    expect(body, '不能硬编码 exit 0').not.toMatch(/process\.exit\(0\)/);
  });

  it('canWrite() 必须真的取决于预检结果，不能恒真', () => {
    // 与 CAN_WRITE 那次同一个坑：只断言「存在一个叫 canWrite 的函数」不够，
    // 必须断言它真的绑在状态机上 —— 否则把 body 改成 `return true;` 也能绿。
    const body = bodyOf('canWrite');
    expect(body, 'canWrite 必须判 writeTokenState').toContain('writeTokenState');
    expect(body, "canWrite 必须要求 'ok'（预检通过），光传了口令不算")
      .toContain("'ok'");
    expect(body, 'canWrite 不能恒真').not.toMatch(/return\s+true\s*;/);
    // 状态机初值必须是 unverified/absent，不能直接是 ok
    expect(VERIFY, "writeTokenState 初值不能是 'ok' —— 那就等于没预检")
      .not.toMatch(/let writeTokenState = 'ok'/);
    expect(VERIFY, '状态机初值必须区分「没传」与「传了但没验」')
      .toMatch(/let writeTokenState = TOKEN\.length > 0 \? 'unverified' : 'absent';/);
  });
});

describe('线上探针：地址不可达不许伪装成「没什么可验的」', () => {
  // 这是第五个真实缺陷。旧版在「所有探针都 fetch failed」时打印
  // 「无法判定（所有探针都被跳过）」，听起来像「这儿没什么可验」，
  // 而真实情况是**一条探针都没跑起来**。两种情况的处置完全相反，
  // 混在一起就只能靠猜。
  //
  // ⚠️ 订正一处误判：这个缺陷是照着「CI 的 WORKER_URL 配错了」这条
  // 推断去修的，症状确实吻合（对着一个不存在的域名跑，全部 skip +
  // 「无法判定」+ exit 1，与 CI 一模一样）。但用户确认 WORKER_URL 没问题，
  // 本地连跑 14 次也全过 —— **症状吻合不等于假设成立**。
  // 仍然成立的是「区分这两种情况」这件事本身，所以测试只钉行为，不钉归因。

  /** 结论区（从汇总循环到文件末尾） */
  function tailAfterSummary(): string {
    const start = VERIFY.indexOf('for (const r of results)');
    expect(start, '找不到结果汇总循环').toBeGreaterThan(0);
    return VERIFY.slice(start);
  }

  it('必须能分辨「连不上站点」与「站点可连但没东西可验」', () => {
    const tail = tailAfterSummary();
    expect(tail, '结论区没有区分「连不上站点」').toMatch(/const siteDown =/);
    // 判据必须是「没有任何一条探针拿到过响应」，而不是「跳过数 > 0」——
    // 后者会把「三条写探针因缺口令而跳过、其余 5 条照常 pass」这种
    // 完全正常的组合也误判成站点不可达。
    expect(tail, 'siteDown 的判据必须是「一条都没拿到响应」，不能只看 skip>0')
      .toMatch(/results\.every\(\(r\) => r\.status !== 'pass' && r\.status !== 'fail'\)/);
  });

  it('「连不上」必须点明这不是代码问题，并说清改哪个变量', () => {
    const idx = VERIFY.indexOf('const siteDown =');
    expect(idx, '找不到 siteDown 判定').toBeGreaterThan(0);
    const tail = VERIFY.slice(idx);
    // 用结论文案本身定位，不用 `\nconsole.log('  结论：…` —— 那行前面还有
    // 两个缩进空格，按「换行紧接 console.log」去切会切不到（我就踩了）。
    const end = tail.indexOf('结论：无法判定（探针全部跳过');
    expect(end, '找不到「无法判定」分支').toBeGreaterThan(0);
    const body = tail.slice(0, end);
    expect(body, '「连不上」分支必须打印出那个连不上的地址').toContain('${SITE}');
    expect(body, '没点明这不是代码问题').toContain('不是代码问题');
    expect(body, '没说该改 WORKER_URL').toContain('WORKER_URL');
    expect(body, '没告诉读者怎么自己验一下地址通不通').toMatch(/curl -m 20/);
    // 同上：断言「调用了 emitFailureAnnotation」而不是字面量 `::error`。
    expect(body, '没有打 GitHub error annotation').toContain('emitFailureAnnotation(');
  });

  it('「连不上」分支必须排在「新代码」分支之后、且照样 exit 1', () => {
    // 排序理由：真实 fail 优先（它证明代码问题），凭据次之，
    // 连不上再次（配置问题），最后才是「连上了、有 pass」。
    // ⚠️ 绝不能让它 exit 0 —— 那正是这个项目反复在打的假绿。
    const newCode = VERIFY.indexOf('结论：线上是**新代码**');
    const siteDown = VERIFY.indexOf('const siteDown =');
    const fallback = VERIFY.indexOf('结论：无法判定（探针全部跳过');
    expect(newCode, '找不到「新代码」分支').toBeGreaterThan(0);
    expect(siteDown, '找不到「连不上」判定').toBeGreaterThan(0);
    expect(fallback, '找不到「无法判定」兜底分支').toBeGreaterThan(0);
    expect(siteDown, '「连不上」必须排在「新代码」之后 —— 有 pass 就不是连不上')
      .toBeGreaterThan(newCode);
    expect(fallback, '兜底分支必须排在「连不上」判定之后').toBeGreaterThan(siteDown);
    expect(VERIFY, '「连不上」必须照样 exit 1，不能 exit 0 —— 那就是假绿')
      .toMatch(/process\.exit\(STRICT \? 1 : 0\);?\s*$/);
  });

  it('三种「什么都不算 pass」的结局都要有独立的结论文案', () => {
    // 混在一起的话，读者只会看到同一个词，然后各自去猜是哪一种。
    for (const text of [
      '结论：线上仍是**旧代码**',
      '结论：**凭据配错**',
      '结论：**连不上',
      '结论：无法判定（探针全部跳过',
    ]) {
      expect(VERIFY, `缺少结论文案：${text}`).toContain(text);
    }
  });

  it('每个失败分支都必须发 error annotation，且带上探针明细', () => {
    // 为什么值得钉：本仓库 `/actions/jobs/<id>/logs` 返回
    // `403 Must have admin rights` —— 日志根本读不到，annotations 接口是
    // 唯一能看到的通道。少了它，CI 上就只剩一句
    // `Process completed with exit code 1`，排查只能靠猜。
    //
    // 前两个探针缺陷各查了两轮，正是因为 annotation 里只有 exit code。
    expect(VERIFY, 'emitFailureAnnotation 函数没了').toMatch(/function emitFailureAnnotation\(/);
    // 函数内部：只在 Actions 里发（本地跑别污染终端），且要压成一行
    // —— Actions 对单条 annotation 有长度上限，超了会截断。
    const fn = VERIFY.slice(VERIFY.indexOf('function emitFailureAnnotation('));
    const fnBody = fn.slice(0, fn.indexOf('\n}\n'));
    expect(fnBody, '没判断是否在 Actions 里运行').toContain("GITHUB_ACTIONS !== 'true'");
    expect(fnBody, '没把多行明细压成一行（超长会被 Actions 截断）').toMatch(/replace\(\/\\s\+\/g, ' '\)/);
    // ⚠️ 下面两条是补一个**实测存活**的变异：光断言「四个分支都调用了
    // emitFailureAnnotation」的话，把函数体改成开头就 `return;`（整个函数
    // 成了空壳、谁都没收到 annotation）依然 21 条全绿 —— 因为调用点还在，
    // 行为没了。所以必须断言函数体**真的会输出**那条 annotation。
    expect(fnBody, 'emitFailureAnnotation 没有真的输出 ::error —— 函数成了空壳')
      .toMatch(/console\.log\(`::error/);
    expect(fnBody, '没有截断上限：超长 annotation 会被 Actions 截掉后半段')
      .toMatch(/\.slice\(0, \d+\)/);

    // 四个结局里，前三个都是「判定失败」，各自都必须发 annotation。
    const branches: Array<[string, string]> = [
      ['结论：线上仍是**旧代码**', '旧代码分支'],
      ['if (credentialFail > 0)', '凭据分支'],
      ['const siteDown =', '连不上分支'],
      ['结论：无法判定（探针全部跳过', '兜底分支'],
    ];
    const tail = tailAfterSummary();
    for (const [anchor, label] of branches) {
      const idx = VERIFY.indexOf(anchor);
      expect(idx, `找不到${label}`).toBeGreaterThan(0);
      // 只看本分支：从锚点切到下一个分支的锚点
      const nexts = branches
        .map(([a]) => VERIFY.indexOf(a))
        .filter((i) => i > idx);
      const end = nexts.length > 0 ? Math.min(...nexts) : VERIFY.length;
      const body = VERIFY.slice(idx, end);
      expect(body, `${label}没有发 error annotation`).toContain('emitFailureAnnotation(');
    }
    // 明细必须具体到「哪条探针、判据是什么」，不能只写一句结论。
    const oldCode = tail.slice(tail.indexOf('结论：线上仍是**旧代码**'), tail.indexOf('if (credentialFail > 0)'));
    expect(oldCode, '旧代码分支必须点名是哪几条探针不符预期')
      .toContain("results.filter((r) => r.status === 'fail' && r.kind !== 'credential')");
    const fallback = tail.slice(tail.indexOf('结论：无法判定（探针全部跳过'));
    expect(fallback, '兜底分支必须带上每条探针的明细，否则无从排查')
      .toContain('results.map((r) =>');
  });
});
