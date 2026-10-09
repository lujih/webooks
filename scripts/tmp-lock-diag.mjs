// 临时：看线上 LOCK 对叶子/目录到底返回什么
const base = 'https://webooks.cszxorx.dpdns.org/dav';
const lockBody = '<D:lockinfo xmlns:D="DAV:"><D:locktype><D:write/></D:locktype></D:lockinfo>';

async function hit(path, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'LOCK',
    headers: { 'content-type': 'application/xml', ...extraHeaders },
    body: lockBody,
  });
  const txt = await res.text();
  console.log(`LOCK ${path} -> ${res.status}`);
  console.log(`  lock-token: ${res.headers.get('lock-token')}`);
  console.log(`  body: ${txt.slice(0, 120).replace(/\n/g, ' ')}`);
  return res;
}

await hit('/recent/locked.epub');
await hit('/recent/');
