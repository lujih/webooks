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
    expect(VERIFY, '没有对直链发请求 —— href 拼错会假绿').toMatch(/await fetch\(probe, \{ method: 'HEAD' \}\)/);
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
    expect(body, 'probeOverwrite 又没有 CAN_WRITE 守卫了').toMatch(/if \(!CAN_WRITE\)/);
    // 守卫必须**早退**，不能只是记个变量继续往下写文件
    const guardPos = body.indexOf('if (!CAN_WRITE)');
    const putPos = body.indexOf("call('PUT'");
    expect(guardPos, '找不到 CAN_WRITE 守卫').toBeGreaterThan(0);
    if (putPos > 0) {
      expect(guardPos, 'CAN_WRITE 守卫必须在任何落盘操作之前').toBeLessThan(putPos);
    }
    // 函数体里必须写明「无口令时 401 是规范行为」，否则下一个人还会把它改回 fail
    const lead = VERIFY.slice(Math.max(0, idx - 1200), idx);
    expect(lead + body).toMatch(/RFC 4918 §10\.6|§10\.6/);
  });
});
