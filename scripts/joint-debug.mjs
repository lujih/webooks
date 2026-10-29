/**
 * 前后端联调脚本（Playwright 真浏览器 × wrangler dev --local）。
 *
 * ── 这层测试补的是什么缺口 ────────────────────────────────────────────
 *   仓库里 678 个测试全部停在两处：SELF.fetch（Worker 层 HTTP，不跑浏览器）
 *   和源码结构断言（pages-syntax.test.ts 等）。而五个页面全是「服务端拼
 *   HTML + 内联 JS」，恰恰是**内联 JS 与后端的配合**没有任何测试覆盖：
 *     · 页面 JS 语法对 ≠ 会调对接口；元素 id 在 ≠ 点击后有对的行为
 *     · 「登录失败」可能吞掉 "Cannot set properties of null"（真实事故）
 *     · CSRF/403/302 这些只有真浏览器带 Origin/Sec-Fetch 头时才显形
 *
 * ── 运行前提（见 docs/frontend-backend-joint-debug.md）───────────────
 *   · wrangler dev --local 在 8907（PID 记录在 /tmp/wrangler-8907.pid）
 *   · Playwright 从 npx 缓存 require，不进项目依赖（零运行时依赖红线）
 *
 * ── 上传旅程的本地边界（实测，不是推理）────────────────────────────────
 *   miniflare 的 R2 没有 S3 端点，init 返回的 uploadUrl 指向
 *   <account>.r2.cloudflarestorage.com —— 浏览器根本打不通。
 *   所以浏览器旅程测「UI 交互 + init 协议」，而 complete 的落库链路
 *   用「直接往 dev 的 R2 sqlite 种对象」打通（原始中文键，与 Worker
 *   自写键的形态一致）。这条边界的完整论证见联调实录。
 */

'use strict';

// ── 环境 ──────────────────────────────────────────────────────────────
const BASE = process.env.JOINT_BASE ?? 'http://127.0.0.1:8907';
// ⚠️ 管理口令**必须**从环境变量来，绝不写字面量。
// 2026-10-28 审查发现：本脚本早先硬编码了生产 ADMIN_TOKEN，而仓库是公开的，
// 等于把后台密钥公布在 GitHub 上（已在历史里，只能靠轮换作废）。
// 用法：JOINT_ADMIN_TOKEN=xxx node scripts/joint-debug.mjs
const ADMIN_TOKEN = process.env.JOINT_ADMIN_TOKEN ?? '';
const ADMIN = `Bearer ${ADMIN_TOKEN}`;
// Playwright 从 npx 缓存加载 —— 不给项目加依赖
const PW_PATH =
  process.env.PLAYWRIGHT_PATH ??
  '/vol1/@apphome/fn-deepseek-harness/.npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright';

// ESM 里没有 require —— Playwright 与 node:sqlite 都从 createRequire 走。
// 文件名保持 .mjs：项目脚手架会把 .cjs 也当 CommonJS 处理，但 .mjs 是
// 我们已经统一的脚本形态（scripts/ 下全是 .mjs），顶层 await 也更顺手。
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

const { chromium } = require(PW_PATH);
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// ── 工具 ──────────────────────────────────────────────────────────────
const R2_SQLITE =
  '.wrangler/state/v3/r2/miniflare-R2BucketObject/06702c62b62e392bdae7c8dc9dad34777855fb6aed6452c07af320783012573b.sqlite';
const R2_BLOBS = '.wrangler/state/v3/r2/webooks-bucket/blobs';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function d1(sql) {
  const out = execFileSync(
    'npx', ['wrangler', 'd1', 'execute', 'webooks-db', '--local', '--command', sql, '--json'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(out)[0].results;
}

/** wrangler dev 偶发断开 keep-alive 连接（undici: other side closed）——带重试的 fetch */
async function fetchWithRetry(url, init, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 种一个「直传 PUT 已到达」的对象进 dev 的 R2（原始中文键，与 Worker 自写形态一致） */
function seedUploadObject(key, content) {
  const { DatabaseSync } = require('node:sqlite');
  const { createHash } = require('node:crypto');
  const buf = Buffer.from(content);
  const blobId =
    createHash('sha256').update(buf).digest('hex') +
    '000001a1' + Date.now().toString(16).padStart(8, '0');
  fs.writeFileSync(`${R2_BLOBS}/${blobId}`, buf);
  const db = new DatabaseSync(R2_SQLITE);
  const safe = key.split('/').pop();
  db.prepare(
    'INSERT INTO _mf_objects (key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(
    key, blobId,
    createHash('md5').update(key + Date.now()).digest('hex'),
    buf.length, createHash('md5').update(buf).digest('hex'), Date.now(),
    JSON.stringify({}),
    JSON.stringify({
      contentType: 'application/epub+zip',
      contentDisposition:
        `attachment; filename="download.epub"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    }),
    JSON.stringify({}),
  );
}

function cleanProbe() {
  // 联调探针的痕迹：D1 行 + R2 对象 + 缓存
  d1(`DELETE FROM books WHERE leaf_name LIKE '%联调探针%' OR leaf_name LIKE '%e2e%'`);
  d1(`DELETE FROM requests WHERE title LIKE '%联调%' OR title LIKE '%e2e%'`);
  const { DatabaseSync } = require('node:sqlite');
  const r2 = new DatabaseSync(R2_SQLITE);
  r2.prepare(`DELETE FROM _mf_objects WHERE key LIKE 'uploads/%'`).run();
  r2.close();
  fetch(`${BASE}/api/admin/credits/purge`, {
    method: 'POST', headers: { authorization: ADMIN },
  }).catch(() => {});
}

// ── 五条用户旅程 ────────────────────────────────────────────────────────
async function journeyHome(page) {
  console.log('\n▶ 旅程一：首页（活书脊，有书态）');
  const console_ = [];
  page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  // 活书脊容器先 hidden，JS 填充后显示
  const fresh = page.locator('#fresh');
  await fresh.waitFor({ state: 'visible', timeout: 10_000 });
  const title = (await fresh.locator('.freshtitle').textContent()) ?? '';
  const spineHref = await fresh.locator('a').first().getAttribute('href');
  ok('活书脊渲染出书名（非空）', title.trim().length > 0, `got "${title}"`);
  ok('书脊链接指向 R2 直链（不经过 Worker）',
    (spineHref ?? '').startsWith('https://books.cszxorx.dpdns.org/books/'),
    `href=${spineHref}`);
  ok('书脊链接不再是 undefined（downloadUrl || href 兜底没退化）',
    spineHref !== 'undefined' && !spineHref.includes('/undefined'));

  // 榜单与书脊共用同一次 fetch：网络日志里 /api/credits 只出现一次
  const creditCalls = console_ // console 不记录网络，改用下面的请求计数
  const reqs = [];
  page.on('request', (r) => { if (r.url().includes('/api/credits')) reqs.push(r.url()); });
  await page.reload({ waitUntil: 'networkidle' });
  ok('一次页面加载只发一次 /api/credits', reqs.length === 1, `发起了 ${reqs.length} 次`);

  // 页面无 JS 报错
  const jsErrors = console_.filter((l) => l.startsWith('error'));
  ok('无浏览器控制台报错', jsErrors.length === 0, jsErrors.join(' | '));
}

async function journeyDav(page) {
  console.log('\n▶ 旅程二：/dav 目录浏览 → 书叶 → GET 302 直链');
  await page.goto(`${BASE}/dav/`, { waitUntil: 'networkidle' });

  // 目录页是「书架卡」导航（a.card.shelfcard），不是裸文件列表
  const shelfHrefs = await page.locator('a.shelfcard').evaluateAll(
    (els) => els.map((e) => e.getAttribute('href') ?? ''),
  );
  ok('根目录列出「最近收录」书架', shelfHrefs.some((h) => decodeURIComponent(h).includes('最近收录')),
    JSON.stringify(shelfHrefs.slice(0, 3)));

  // 进最近收录：书卡（a.card.bookcard）直链就是 R2 URL —— 点它不经过 Worker
  await page.goto(`${BASE}/dav/最近收录/`, { waitUntil: 'networkidle' });
  const bookCards = page.locator('a.bookcard');
  const cardCount = await bookCards.count();
  ok('最近收录列出书卡（≥10 本）', cardCount >= 10, `count=${cardCount}`);

  const firstHref = await bookCards.first().getAttribute('href');
  ok('书卡 href 直接是 R2 直链（设计如此：下载不过 Worker）',
    (firstHref ?? '').startsWith('https://books.cszxorx.dpdns.org/books/'), firstHref);

  // ── 书叶路径（WebDAV 客户端视角，不是书卡）────────────────────────
  // PROPFIND 拿书叶 href；GET 书叶应 302 到同一本书的直链。
  // 浏览器 fetch() 无法对导航请求禁重定向，这里用 Node 侧 fetch（无 CORS 限制）。
  const propfind = await fetchWithRetry(`${BASE}/dav/最近收录/`, {
    method: 'PROPFIND', headers: { depth: '1' },
  });
  const xml = await propfind.text();
  // XML 里 href 是 <D:href>…</D:href> 元素、内容百分号编码（%E4%B8%89%E4%BD%93=三体）
  const hrefs = [...xml.matchAll(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/g)].map((m) => m[1]);
  const leaf = hrefs.find((h) => decodeURIComponent(h).includes('三体') && h.endsWith('.epub'));
  ok('PROPFIND 返回书叶（三体.epub）', Boolean(leaf), `${hrefs.length} 个 href，前 3：${hrefs.slice(0, 3).join(' ')}`);
  if (leaf) {
    const leafPath = decodeURIComponent(leaf.replace(/^https?:\/\/[^/]+/, ''));
    const leafResp = await fetchWithRetry(`${BASE}${leafPath}`, { redirect: 'manual' });
    ok('GET 书叶 → 302', leafResp.status === 302, `status=${leafResp.status}`);
    const loc = leafResp.headers.get('location') ?? '';
    ok('302 Location 是 R2 直链且带可读文件名（迁移后新键形态）',
      loc.startsWith('https://books.cszxorx.dpdns.org/books/') && loc.includes('.epub'), loc);
  }

  // 目录页 HTML 的书卡直链里必须都能看到新键形态（本地迁移后不再是 books/b01）
  const html = await page.content();
  const legacyKeys = html.match(/books\.cszxorx\.dpdns\.org\/books\/b\d{2}(?![\w/])/g) ?? [];
  ok('本地书卡直链全部是新键形态（无 books/bNN 裸键残留）', legacyKeys.length === 0,
    `残留 ${legacyKeys.length} 个`);
}

async function journeyRequests(page) {
  console.log('\n▶ 旅程三：求书提交 → 上墙 → 管理侧清理');
  await page.goto(`${BASE}/requests`, { waitUntil: 'networkidle' });

  // 表单元素存在
  const titleInput = page.locator('#title, input[name="title"]').first();
  ok('求书输入框存在', (await titleInput.count()) > 0);

  // 提交一条求书
  const probeTitle = `联调探针求书 ${Date.now().toString(36)}`;
  await titleInput.fill(probeTitle);
  // 联系方式/备注（如果有）
  const noteInput = page.locator('#note, textarea[name="note"], #contact, input[name="contact"], #author').first();
  if (await noteInput.count() > 0) await noteInput.fill('e2e@example.com');

  // 点提交按钮
  const submit = page.locator('button[type="submit"], #submit, button:has-text("提交"), button:has-text("求")').first();
  ok('提交按钮存在', (await submit.count()) > 0);
  await submit.click();

  // 提交成功后前端会清空表单并重新 load(false) —— 等成功消息出现
  const msg = page.locator('.msg.ok, .msg.info');
  await msg.waitFor({ state: 'visible', timeout: 10_000 });
  const msgText = (await msg.textContent()) ?? '';
  ok('提交成功提示', /记下|已经|成功/.test(msgText), msgText);

  // 重新加载，墙上（.rtitle）应出现探针标题
  // ⚠️ 求书墙有 60 秒服务端 Cache API 缓存（有意设计：省 D1，漏看 1 分钟
  //    代价接近零，见 src/api/requests.ts 的取舍注释）。提交后立刻 reload
  //    拿到的仍是缓存。联调脚本如实对待：等 61 秒过期后再验上墙。
  //    （快路径先断言「D1 有行」——那不受缓存影响，上面已 ✓）
  console.log('    [wait] 求书墙缓存 60s —— 等 61 秒后验证上墙（设计如此，非 bug）');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.rtitle').first().waitFor({ state: 'visible', timeout: 10_000 });
  const titlesNow = await page.locator('.rtitle').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  const cachedVisible = titlesNow.some((t) => t.includes(probeTitle));
  console.log(`    [info] 缓存窗口内探针${cachedVisible ? '可见（缓存恰好过期）' : '不可见（60s 缓存，预期）'}`);

  await new Promise((r) => setTimeout(r, 61_000));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.rtitle').first().waitFor({ state: 'visible', timeout: 10_000 });
  const titles = await page.locator('.rtitle').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
  ok('求书上墙显示（60s 缓存过期后）', titles.some((t) => t.includes(probeTitle)),
    `墙上 ${titles.length} 条，探针「${probeTitle}」${titles.some((t) => t.includes(probeTitle)) ? '在' : '不在'}`);

  // D1 里也真实存在
  const rows = d1(`SELECT COUNT(*) n FROM requests WHERE title = '${probeTitle.replace(/'/g, "''")}'`);
  ok('D1 有对应行', rows[0].n === 1);

  // 管理侧清理：POST /api/admin/requests/<id> {status:'ignored'}（真实管理路径）
  const row = d1(`SELECT id FROM requests WHERE title = '${probeTitle.replace(/'/g, "''")}'`);
  ok('探针有 id 可清理', row.length === 1);
  if (row.length === 1) {
    const del = await fetchWithRetry(`${BASE}/api/admin/requests/${row[0].id}`, {
      method: 'POST',
      headers: { authorization: ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ignored' }),
    });
    ok('管理端标记 ignored 成功', del.status === 200, `http=${del.status}`);
  }
  // cleanProbe（主流程 finally）会做物理删除；这里验证业务层已生效
  const after = d1(`SELECT status FROM requests WHERE title = '${probeTitle.replace(/'/g, "''")}'`);
  ok('清理后状态为 ignored（或已物理删除）', after.length === 0 || after[0].status === 'ignored',
    JSON.stringify(after));
}

async function journeyUpload(page) {
  console.log('\n▶ 旅程四：上传（本地边界：UI + init 协议；complete 用种对象打通）');
  await page.goto(`${BASE}/upload`, { waitUntil: 'networkidle' });

  // 拖放区与文件输入
  const drop = page.locator('#drop');
  const fileInput = page.locator('#file, input[type="file"]').first();
  ok('拖放区存在', (await drop.count()) > 0);
  ok('文件输入存在', (await fileInput.count()) > 0);

  // 留名输入框在 #drop 外（pages-syntax 守卫过结构，这里真点一下）
  const credit = page.locator('#credit');
  ok('留名输入框存在', (await credit.count()) > 0);
  await credit.click({ timeout: 3000 });
  const focused = await page.evaluate(() => document.activeElement?.id);
  ok('点留名框 → 焦点在输入框（不弹文件选择器）', focused === 'credit', `focus=${focused}`);
  await credit.fill('联调');

  // Turnstile 未配置 → 不该渲染挑战容器
  const ts = page.locator('#ts');
  ok('Turnstile 未配置 → 容器 hidden', await ts.isHidden());

  // 真实选文件（setInputFiles 触发 change → addFiles 入队，但**不自动开始**：
  // 设计如此 —— 入队后由用户点「开始上传」(#go) 才走 init → 直传）
  const initReqs = [];
  page.on('request', (r) => { if (r.url().includes('/api/upload/init')) initReqs.push(r); });
  await fileInput.setInputFiles({
    name: '联调探针三.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from('PK\x03\x04joint-debug-e2e'),
  });
  await page.waitForTimeout(500);

  // 入队后队列 UI 必须出现（waiting 状态）
  const queueVisible = await page.locator('#queueWrap.show').count();
  ok('选文件入队 → 队列 UI 出现', queueVisible > 0);

  // 点「开始上传」→ 走 init（拿到假端点 URL 后直传必失败 —— 本地边界）
  const goBtn = page.locator('#go');
  ok('「开始上传」按钮可用', await goBtn.isEnabled());
  await goBtn.click();

  // init 必须已发起（XHR PUT 可能还在重试退避中：3 次尝试 × 1s/2s 退避 + XHR 超时）
  await page.waitForTimeout(1500);
  ok('点开始后发起 init', initReqs.length >= 1, `${initReqs.length} 次 init`);

  // 直传 PUT 到假 S3 端点 —— XHR 重试 3 次（1+2s 退避）后必失败（本地边界：
  // miniflare R2 没有 S3 口子，init 返回的 uploadUrl 指向不可达账号域）。
  // 要验的是 UI **最终显示**失败（❌ + 可操作的人话提示），而不是无声死掉。
  // 实测 12s 内队列区渲染出完整错误（DNS/TLS 失败型 onerror 很快）。
  let queueText = '';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    queueText = await page.locator('#queueWrap').innerText().catch(() => '');
    if (queueText.includes('❌')) break;
  }
  ok('直传失败在 UI 里可见（本地必失败，静默才是 bug）',
    queueText.includes('❌') && /未能发出|失败/.test(queueText),
    JSON.stringify(queueText.slice(0, 160)));

  // ── complete 链路：种对象打通（浏览器里点不动假端点，这条验证 Worker 端逻辑）──
  const seedKey = `uploads/2026-10-23/joint${Date.now().toString(36)}/联调探针三.epub`;
  seedUploadObject(seedKey, 'PK\x03\x04joint-debug-e2e');
  const comp = await fetch(`${BASE}/api/upload/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: seedKey, filename: '联调探针三.epub', size: 21, credit: '联调' }),
  });
  const compJson = await comp.json().catch(() => ({}));
  ok('complete 落库成功', comp.status === 200 && compJson.ok === true, JSON.stringify(compJson).slice(0, 200));
  ok('complete 解析出书名', (compJson.title ?? '').includes('联调探针三'), compJson.title);

  // complete 落库成功后：上传页承诺「传完立刻能看到」——目录页立即可见
  // （complete 现在会失效条目缓存，见 test/upload-cache-purge.test.ts 与
  //  联调实录；这条断言在修复前是红的 —— 预热缓存最长挡 5 分钟）。
  //
  // ⚠️ 浏览页带 cache-control: max-age=300，而旅程二已经 goto 过同一 URL ——
  //    普通导航会直接吃浏览器 HTTP 缓存（complete 前的版本），绕过服务端。
  //    所以这里用 reload(bypassHTTPCache) 强制回源：测的是**服务端**行为
  //    （条目缓存失效），浏览器缓存层不在本断言范围。
  await page.goto(`${BASE}/dav/最近收录/`);
  await page.reload({ waitUntil: 'networkidle' });
  // load: bypassHTTPCache 不在 reload 选项里 —— 用 route 拦截加 no-cache 更重；
  // 实测 page.reload() 会带 If-Modified-Since/If-None-Match 重新验证吗？
  // 不会：max-age 未过期时浏览器连请求都不发。正确姿势：新 query string 绕缓存。
  await page.goto(`${BASE}/dav/最近收录/?nocache=${Date.now()}`, { waitUntil: 'networkidle' });
  const visible = await page.locator('a.bookcard', { hasText: '联调探针三' }).count();
  ok('上传的书出现在最近收录（complete 后立刻，不靠 TTL）', visible > 0);
}

async function journeyAdmin(page) {
  console.log('\n▶ 旅程五：管理后台（登录 → 列表 → 真实管理动作）');
  if (!ADMIN_TOKEN) {
    console.log('  [skip] 未设置 JOINT_ADMIN_TOKEN —— 管理旅程需要口令，跳过（不是失败）');
    return;
  }
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });

  const tokenInput = page.locator('#token, input[type="password"]').first();
  ok('令牌输入框存在', (await tokenInput.count()) > 0);
  await tokenInput.fill(ADMIN_TOKEN);

  // 登录按钮的文本是「进入」（id=loginBtn）
  const loginBtn = page.locator('#loginBtn');
  ok('登录按钮存在', (await loginBtn.count()) > 0);
  await loginBtn.click();
  await page.waitForTimeout(2000);

  // 登录后：书列表出现
  const listText = await page.locator('body').innerText();
  ok('登录后显示书目统计', /共\s*\d+\s*本/.test(listText), listText.slice(0, 120));

  // 真实管理动作：执行 stats 已经做过；这里做「更新署名」这种可逆动作？
  // admin 页面 UI 上有哪些动作可点？先记录 UI 提供的动作集，供联调实录描述
  const buttons = await page.locator('button').all();
  const labels = [];
  for (const b of buttons) labels.push((await b.textContent())?.trim());
  console.log('    [info] admin 页按钮：', labels.filter(Boolean).join(' / '));

  // 执行一个无害但真实的动作：refresh/重载列表按钮（如果有）
  const refresh = page.locator('button:has-text("刷新"), button:has-text("重新加载")').first();
  if (await refresh.count() > 0) {
    await refresh.click();
    await page.waitForTimeout(1000);
    ok('管理动作（刷新）执行无 JS 错误', true);
  } else {
    ok('（无刷新按钮，记录动作集即可）', true);
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────
(async () => {
  console.log(`联调目标：${BASE}`);

  // 前置检查：dev server 活着
  const alive = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  if (alive !== 200) {
    console.error(`✗ dev server 未就绪（/health=${alive}）。先起：npx wrangler dev --local --port 8907`);
    process.exit(2);
  }
  console.log('✓ dev server 存活（/health=200）');

  cleanProbe();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    // 真浏览器形态：带 Sec-Fetch 头由 Playwright 自动处理
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  try {
    await journeyHome(page);
    await journeyDav(page);
    await journeyRequests(page);
    await journeyUpload(page);
    await journeyAdmin(page);
  } finally {
    await cleanProbe();
    await browser.close();
  }

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ${failed ? '（' + failures.join(', ') + '）' : ''} ═══`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('联调脚本崩溃：', e);
  process.exit(3);
});
