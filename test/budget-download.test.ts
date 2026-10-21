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

  it('浏览会话的请求成本是 2（不是 4，也不是 4 + 3）', () => {
    // 书卡直链 R2 之后，点开一本书不再经过 Worker。
    // 曾经的写法是 `const browseRequests = 4 + 3;`（进 4 个目录 + 下 3 本书）。
    expect(BUDGET, 'browseRequests 又变回把下载也算成 Worker 请求了').not.toMatch(
      /const browseRequests = 4 \+ 3;/,
    );
    // 也不能回到 4：实测一次会话 = 4 次请求，但其中 **2 次是首页**
    // （GET / + GET /api/credits，由 homeRequests 单独记）。4 会把首页藏进来，
    // 于是 homeViews 再记一遍 → 首页被数了两次。
    expect(BUDGET, 'browseRequests 又变回 4 了 —— 那 4 里有 2 次是首页').not.toMatch(
      /const browseRequests = 4;/,
    );
    expect(BUDGET).toMatch(/const browseRequests = 2;/);
  });

  it('D1 行读必须复用 browseRequests，不许再写死 4', () => {
    // 同一个量纲两处计数：browseRequests 改 2 之后 browseReads 若还写着 4，
    // 请求数降了、D1 行读照旧，两行互相矛盾且相隔很远，没人会发现。
    expect(BUDGET, 'browseReads 又把目录页数写死了').toMatch(
      /const browseReads = a\.browse \* browseRequests;/,
    );
  });

  it('全库同步必须算「每本书 5 条路径」，不是 1 次（WebDAV 的 GET 302 没有变）', () => {
    // 这是本组最重要的一条：直链只省掉**浏览页**那条路。
    // rclone / Finder 走 WebDAV，`GET /dav/<书>` 仍然返回 302
    // （客户端依赖它），所以每个目录 1 次 PROPFIND + 每本书的 GET 照旧。
    //
    // ⚠️ 但「每本书 1 次」是错的（2026-10-20 修）：一本书同时挂在 5 个集合
    //    下（按书名/按作者/按类型/按格式/最近收录），5 条路径指向同一对象，
    //    而 rclone 按**路径**去重 → 同一本书被 GET **5 次**。
    //    实测放大 5.0×，且每本书路径数分布是 Counter({5: N})。
    //    源码佐证：src/lib/cache.ts 的 bookCacheTargets() 硬编码这 5 条叶子路径。
    //
    // 如果哪天有人把它改回 `directories + a.books`，模型会立刻少报掉
    // **最大的一项**（占默认总量 91%）—— 正是上次停摆的形态。
    expect(BUDGET, 'syncRequests 漏掉了「一本书 5 条路径」的放大').toMatch(
      /const syncRequests = directories \+ BOOK_PATH_COPIES_PER_SYNC \* a\.books;/,
    );
    expect(BUDGET, '放大倍数不是 5 了 —— 改之前请重新实测').toMatch(
      /const BOOK_PATH_COPIES_PER_SYNC = 5;/,
    );
  });

  it('必须写明「省的是请求配额，不是 R2 的 Class B 计数」', () => {
    // 两本账不能混：直链省的是 Worker 请求，R2 的 GetObject 照旧计数。
    // 少了这句话，下一个人会把 downloadsPerDay 也一起删掉。
    expect(BUDGET).toMatch(
      /downloadsPerDay =\s*a\.browse \* 3 \+ a\.syncs \* BOOK_PATH_COPIES_PER_SYNC \* a\.books;/,
    );
    expect(BUDGET, '没有说明直链省的是请求配额而不是 R2 读计数').toMatch(/请求配额/);
  });

  it('R2 Class B 必须与 Worker 请求同步乘 5，不许只修半本账', () => {
    // 一次 `GET /dav/<书>` = 1 次 Worker 请求 + 1 次 R2 Class B，是同一件事
    // 的两面。请求侧数了 5 次，字节侧就必须也是 5 次；只改一边会让表里两行
    // 互相矛盾，而且它们离得很远，肉眼看不出来。
    expect(BUDGET, 'downloadsPerDay 没跟上 5× 放大 —— 只修了 Worker 请求那一半').toMatch(
      /a\.syncs \* BOOK_PATH_COPIES_PER_SYNC \* a\.books/,
    );
  });

  it('叶子 GET 的定点行读不能与 PROPFIND 混在一起乘 201', () => {
    // 这是本轮修 5× 时顺带发现的第三处：`GET /dav/<书>` 会走
    // findBookByLeaf()（唯一索引，恰好 1 行），它不是「拉一页 200 行」。
    // 若把它塞进 cacheMisses 再乘 (1 + MAX_ENTRIES)，1 行会被放大成 201 行，
    // 默认场景算出来超过 1,000 万行/天，直接把 D1 误判为超标。
    expect(BUDGET, '叶子 GET 行读被混进 cacheMisses 了').toMatch(
      /const d1RowsReadPerDay = cacheMisses \* \(1 \+ MAX_ENTRIES\) \+ leafGetReads;/,
    );
    expect(BUDGET, '没有说明叶子 GET 是 1 行（唯一索引），不是一页').toMatch(
      /findBookByLeaf/,
    );
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

/**
 * 2026-10-16 那轮「拿实测替换拍脑袋的常数」的守卫。
 *
 * 背景：budget.mjs 里有两个数是估的，估错的方向都一样 —— **低估**：
 *   · `cacheHitRate: 0.9` 没有任何实测，而且被乘错了地方（见第三条）
 *   · `d1RowsWrittenPerDay = uploadsPerDay * 3` 漏掉了 D1 把每个被改写的
 *     二级索引条目都算一行；实测一次上传 22 行，**错约 7 倍**
 * 这两个数都不大，但错法很有代表性：常数一旦没写清「怎么测出来的」，
 * 下一个人既不敢改也不知道该不该信。所以这里不只钉数值，还钉**依据在不在**。
 */
describe('预算模型：缓存命中率与 D1 行写必须是实测值', () => {
  it('命中率拆成了两个参数，且都不是当年的 0.9', () => {
    // 实测四种场景差得极远（0% / 50% / 87.5% / 100%），一个数盖不住。
    expect(BUDGET, 'cacheHitRate 又变回那个没有依据的 0.9 了').toMatch(/cacheHitRate: 0\.5,/);
    expect(BUDGET, '遍历那一路的命中率参数被删了').toMatch(/cacheHitRateTraversal: 0\.0,/);
  });

  it('命中率注释里必须留着「怎么测的」—— 测法、清键前提与各档实测值', () => {
    // 只留数字、不留测法，下一个人无法判断它是否还成立。
    expect(BUDGET, '注释里没有实测日期').toMatch(/2026-10-16/);
    expect(BUDGET, '注释里没有观测点（x-dav-cache）').toMatch(/x-dav-cache/);
    expect(BUDGET, '注释里没有「先清键」这个前提 —— 不清会把冷测成热').toMatch(/purge/);
    // 四种场景里至少要留下遍历（0%）、热重跑（100%）、挂载会话（50%）。
    expect(BUDGET, '没写明遍历场景实测为 0%').toMatch(/0%/);
    expect(BUDGET, '没写明 TTL 内重跑可以到 100%').toMatch(/100%/);
    expect(BUDGET, '没写明挂载会话的形状（每目录列两次 → 50%）').toMatch(/50%/);
  });

  it('浏览页那几次不许乘任何命中率（它压根不查条目缓存）', () => {
    // 这是那轮实测最值钱的一条：浏览页走 `GET /dav/<目录>/`，而
    // handleGet 直接 collectDavEntries() 现算，全仓库只有
    // src/webdav/propfind.ts 会 cache.match(entriesCacheKey(...))。
    // 三路分解之前是 `propfindCount = a.browse * 4 + …` 整体乘
    // (1 - 0.9)，等于把 90% 的浏览页 D1 读取凭空抹掉。
    expect(BUDGET, 'browseReads 又被乘上命中率了').toMatch(
      /const browseReads = a\.browse \* browseRequests;/,
    );
    expect(BUDGET, '旧的「一锅端」写法又回来了').not.toMatch(
      /const cacheMisses = propfindCount \* \(1 - a\.cacheHitRate\);/,
    );
    // 三路必须各自独立出现，否则等于又合并成一笔糊涂账。
    expect(BUDGET, '挂载那一路没接命中率参数').toMatch(/const mountMisses = /);
    expect(BUDGET, '同步那一路没接遍历命中率参数').toMatch(/const syncMisses = /);
  });

  it('D1 行写按实测的 22 行/次上传，不许退回漏算索引的 ×3', () => {
    expect(BUDGET, 'd1RowsWrittenPerDay 又用那个漏算索引的 ×3 了').not.toMatch(
      /a\.uploadsPerDay \* 3; *\/\/ *upsert/,
    );
    expect(BUDGET, '没按实测的每次上传 22 行建模').toMatch(/const D1_ROWS_PER_UPLOAD = 22;/);
    expect(BUDGET, '行写没用常量乘').toMatch(
      /const d1RowsWrittenPerDay = a\.uploadsPerDay \* D1_ROWS_PER_UPLOAD;/,
    );
  });

  it('行写注释必须说清「22 是怎么来的」—— 索引放大才是主项', () => {
    // 22 里只有 1 行是书本身，其余 21 行全是索引。这个反直觉的点
    // 正是当年估成 3 的原因，必须写下来。
    expect(BUDGET, '没写明 rows_written = 1 表行 + 索引条目数').toMatch(/1 表行/);
    expect(BUDGET, '没写明 books 表有 16 个索引').toMatch(/16 个索引/);
    // 三种场景（新桶 / 稳态 / 覆盖）的数字都要在，否则 22 是孤证。
    expect(BUDGET, '没写明新桶首见的 27 行').toMatch(/27 行/);
    expect(BUDGET, '没写明稳态的 22 行').toMatch(/22 行/);
    expect(BUDGET, '没写明覆盖上传的 21 行').toMatch(/21 行/);
  });
});

/**
 * 2026-10-17 那轮「记账结构失真」的守卫。
 *
 * 背景：上一轮把**数字**换成了实测值（命中率、行写），但**结构**还是错的 ——
 * 一个量纲被数了两次、隐式请求挂错了乘数、一个真实存在的入口压根没进模型。
 * 数值错会让人算错，结构错则会让人**根本没机会算对**：参数名字摆在那儿，
 * 谁也不知道该填哪个、又该乘谁。
 *
 * 这里钉的是四件事：
 *   P1 `browse` 与 `pageViews` 重复计算同一种目录页 GET → 只留一个量纲
 *   P2 `implicitPerPageView` 只乘了 pageViews 那一路 → 必须乘页面浏览总数
 *   P3 首页 `GET /` + `GET /api/credits` 两次请求没进模型 → 显式记账
 *   P4 Speed Brain 预取没有记账位 → 有位置、默认 0、写清怎么观测
 */
describe('预算模型：页面浏览只能数一次，且每个乘数都要挂对', () => {
  /**
   * 去掉注释后的源码。
   *
   * 必须这么做：`pageViews` 这个名字在**解释历史错误的注释里**仍然出现
   * （「它以前写成 `a.pageViews * …`」），直接对全文断言 `not.toMatch`
   * 会被注释命中 —— 那种守卫会在「注释写得越清楚越红」的方向上失效。
   */
  const CODE = BUDGET.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, ''))
    .join('\n');

  /** 取某个 `const name = …;` 赋值的右值（到第一个分号为止）。 */
  const valueOf = (name: string): string => {
    const start = CODE.indexOf(`const ${name} =`);
    if (start < 0) return '';
    const from = start + `const ${name} =`.length;
    return CODE.slice(from, CODE.indexOf(';', from));
  };

  it('P1 只保留一个目录页浏览量纲：pageViews 参数已删除', () => {
    // 以前 defaults 里同时有 browse(×4) 与 pageViews(×1)，乘的都是
    // 「目录页 GET」。默认值下凭空多算 300 次/天。
    expect(CODE, 'pageViews 参数又回到 defaults 里了 —— 它和 browse 数的是同一件事').not.toMatch(
      /\bpageViews\s*:/,
    );
    // 整个代码里不许再出现 a.pageViews（属性访问；注释已在 CODE 里被剥掉）。
    expect(CODE, '又有人开始用 a.pageViews 了').not.toMatch(/a\.pageViews/);
    // 删掉参数还不够 —— 还得有**唯一**的那个量纲定义。
    expect(CODE, '页面浏览总数 pageViewCount 没了').toMatch(
      /const pageViewCount = a\.browse \* browseRequests \* pageViewRequests;/,
    );
  });

  it('P1 requestsPerDay 里目录页那一路只出现一次', () => {
    // 结构判据：数目录页 GET 的项只能有一个来源。
    // 老写法是 `a.browse * browseRequests + a.pageViews * (...)` —— 两项。
    const sum = valueOf('requestsPerDay');
    expect(sum, 'requestsPerDay 取不到').not.toBe('');
    const browseTerms = sum.match(/a\.browse\s*\*/g) ?? [];
    expect(
      browseTerms.length,
      `requestsPerDay 里 a.browse 出现 ${browseTerms.length} 次 —— 只该有 1 次（页面浏览那一路）`,
    ).toBe(1);
  });

  it('P1b 求和式必须精确等于这 7 项（防止「同一件事数两遍」无声复活）', () => {
    // ⚠️ 为什么要这条：上面 P1 只数 `a.browse` 出现**次数**，(m) 把
    //    `a.browse * browseRequests` 改成 `a.browse * 2 * browseRequests`
    //    —— 仍然只出现 1 次、仍然全绿，但请求数凭空翻倍。
    //
    //    更打脸的是 (p)：把 `a.homeViews * homeRequests` 写**两遍**，
    //    P3 那条 `toMatch(/a\.homeViews \* homeRequests/)` 也只查「存在」，
    //    照样绿 —— 而「同一件事数两遍」恰恰是本轮要修的那个缺陷。
    //    用整体精确比对，这两类都没有藏身处。
    //
    //    代价：以后**故意**增加一项时这条会红。那正是它该做的 ——
    //    加项的人必须来这里改一次，顺便想清楚「这是不是又一个重复计数」。
    const flat = valueOf('requestsPerDay').replace(/\s+/g, ' ').trim();
    expect(flat, 'requestsPerDay 的构成变了 —— 请确认不是重复计数，再同步这条守卫').toBe(
      'a.browse * browseRequests + '
      + 'a.mounts * mountRequests + '
      + 'a.syncs * syncRequests + '
      + 'implicitRequests + '
      + 'prefetchRequests + '
      + 'a.homeViews * homeRequests + '
      + 'a.uploadsPerDay + '
      + 'a.bots',
    );
  });

  it('P2 隐式请求必须乘页面浏览总数，不许只乘其中一部分', () => {
    // 老写法：`a.pageViews * (pageViewRequests + implicitPerPageView)`
    // —— 只乘了 pageViews 那 300，而 browse 那 1,200 次同样是页面浏览。
    // 当年 favicon 恰恰是每页一次：谁把 implicitPerPageView 设回 1，
    // browse 那一路立刻低估 4 倍，而模型会一本正经地报出一个偏小的百分比。
    expect(CODE, 'implicitRequests 没挂在 pageViewCount 上').toMatch(
      /const implicitRequests = pageViewCount \* implicitPerPageView;/,
    );
    // 它必须真的进 requestsPerDay，否则乘对了也没用。
    expect(valueOf('requestsPerDay'), 'implicitRequests 没进 requestsPerDay').toMatch(
      /\bimplicitRequests\b/,
    );
  });

  it('P3 首页两次请求必须显式记账（GET / 与 GET /api/credits）', () => {
    // 首页在模型里曾经零命中，而 src/index.ts 自称它是「流量最大的入口」。
    expect(CODE, '没有 homeViews 参数').toMatch(/\bhomeViews\s*:/);
    expect(CODE, '没有 homeRequests 常量').toMatch(/const homeRequests = 2;/);
    expect(CODE, '首页请求没进 requestsPerDay').toMatch(
      /a\.homeViews \* homeRequests/,
    );
    // 2 这个数字必须能被读者复核：两个 GET 各自是什么。
    expect(BUDGET, '没写清首页那 2 次请求分别是什么').toMatch(/\/api\/credits/);
    expect(BUDGET, '没写明首页是 2 次 Worker 请求').toMatch(/2 次/);
  });

  it('P4 Speed Brain 预取有记账位、默认 0、且写清了怎么观测', () => {
    // 线上每个 Worker 响应都带 speculation-rules；划过 /dav 链接会打 Worker。
    // 默认 0（没数据不猜），但位置必须在 —— 否则以后没人知道该填哪儿。
    expect(CODE, '没有 prefetchPerPageView 参数').toMatch(/\bprefetchPerPageView\s*:/);
    // ⚠️ 必须查「进没进 requestsPerDay」，不能只查名字存在 —— 变异测试
    //    实测过：把 `prefetchRequests +` 从求和式里删掉，只查名字的写法
    //    依然全绿（定义还在），等于守卫是装饰。
    expect(valueOf('requestsPerDay'), '预取那一路没进 requestsPerDay').toMatch(
      /\bprefetchRequests\b/,
    );
    expect(CODE, '预取必须按页面浏览总数算，别另开乘数').toMatch(
      /const prefetchRequests = pageViewCount \* prefetchPerPageView;/,
    );
    // 得让人能自己验：靠 speculation-rules + 悬停集合卡。
    expect(BUDGET, '没提 speculation-rules').toMatch(/speculation-rules/);
    expect(BUDGET, '没提预取只对 /dav 链接计费（书卡已是直链）').toMatch(/集合卡|shelfcard/);
  });

  it('P3/P4 的默认值都是 0 或可解释的假设，不许悄悄塞一个大数', () => {
    // homeViews 默认取与 browse 同值（假设每个浏览会话从首页开始），
    // 这是明写出来的**假设**；prefetchPerPageView 则必须是 0。
    expect(CODE, 'prefetchPerPageView 默认值不是 0 了').toMatch(/prefetchPerPageView: 0,/);
    expect(CODE, 'homeViews 默认值变了 —— 它应有明确依据').toMatch(/homeViews: 300,/);
    expect(BUDGET, '没说清 homeViews 是假设还是实测').toMatch(/假设/);
  });
});
