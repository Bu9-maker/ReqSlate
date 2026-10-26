/**
 * ReqSlate 冒烟测试
 *
 * CI 里在服务启动后跑一遍：登录、建项目、建分类、建任务、改任务、冲突检测、
 * 四种导出、模板下载、导入、下线、删除。任何一项不符合预期就以非 0 退出。
 *
 * 不引入任何测试框架，只用 Node 内置的 fetch / http。
 * 本地也能跑：先起服务，再 node .github/smoke.mjs
 *
 * 环境变量：
 *   BASE            服务地址，默认 http://127.0.0.1:3000
 *   ADMIN_PASSWORD  管理密码，默认 ci-pass
 */

import http from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'ci-pass';

let passed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function call(method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 导出文件不是 JSON，正常 */ }
  return { status: res.status, buf, text, json, headers: res.headers };
}

/* 用裸 http 发请求，才能构造畸形 Host —— fetch 不允许改这个头 */
function rawGet(path, hostHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const r = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error('超时')));
    r.end();
  });
}

/* ================= 1. 基础 ================= */

section('1. 健康检查与静态资源');
{
  const h = await call('GET', '/healthz');
  ok('/healthz 返回 200 ok', h.status === 200 && h.text === 'ok', `实际 ${h.status} ${h.text.slice(0, 40)}`);

  const c = await call('GET', '/api/config');
  ok('/api/config 返回 200 且带 appName', c.status === 200 && !!c.json?.appName);

  for (const [p, what] of [['/style.css', '样式'], ['/app.js', '前端脚本'], ['/favicon.svg', '图标']]) {
    const r = await call('GET', p);
    ok(`${p} 返回 200（${what}）`, r.status === 200 && r.buf.length > 100, `实际 ${r.status} ${r.buf.length} 字节`);
  }

  const idx = await call('GET', '/');
  ok('未登录访问 / 返回登录页', idx.status === 200 && idx.text.includes('id="pw"'));
  ok('未登录时登录页不暴露项目列表', !idx.text.includes('新建项目'));
}

/* ================= 2. 登录 ================= */

section('2. 登录');
let cookie = '';
{
  const bad = await call('POST', '/api/login', { body: { password: '肯定不对' } });
  ok('密码错误返回 401', bad.status === 401, `实际 ${bad.status}`);

  const good = await call('POST', '/api/login', { body: { password: PASSWORD } });
  const setCookie = good.headers.get('set-cookie') || '';
  ok('密码正确返回 200', good.status === 200, `实际 ${good.status}`);
  ok('登录后下发 rb_sid cookie', setCookie.startsWith('rb_sid='));
  ok('cookie 带 HttpOnly', /HttpOnly/i.test(setCookie));
  cookie = setCookie.split(';')[0];

  const noAuth = await call('GET', '/api/projects');
  ok('未登录访问管理接口返回 401', noAuth.status === 401, `实际 ${noAuth.status}`);

  const list = await call('GET', '/api/projects', { cookie });
  ok('登录后能读项目列表', list.status === 200 && Array.isArray(list.json?.projects));
}

/* ================= 3. 项目与任务 ================= */

section('3. 项目 / 分类 / 任务');
let token = '';
let projectId = 0;
let itemId = 0;
let groupName = '';
{
  const p = await call('POST', '/api/projects', { cookie, body: { name: 'CI 冒烟项目', note: '自动创建' } });
  ok('新建项目返回 id 和 token', p.status === 200 && !!p.json?.id && !!p.json?.token, `实际 ${p.status}`);
  token = p.json?.token || '';
  projectId = p.json?.id || 0;

  const empty = await call('POST', '/api/projects', { cookie, body: { name: '   ' } });
  ok('项目名为空返回 400', empty.status === 400, `实际 ${empty.status}`);

  const payload = await call('GET', `/api/p/${token}`);
  ok('读项目返回 items/groups/stats/rev',
    payload.status === 200 && Array.isArray(payload.json?.items) &&
    Array.isArray(payload.json?.groups) && !!payload.json?.stats && payload.json?.rev !== undefined);

  const g = await call('POST', `/api/p/${token}/groups`, { body: {} });
  ok('新建分类返回自动生成的名称', g.status === 200 && !!g.json?.name);
  groupName = g.json?.name || '';

  const reserved = await call('POST', `/api/p/${token}/groups`, { body: { name: '未分类' } });
  ok('「未分类」是保留名，手工创建返回 400', reserved.status === 400, `实际 ${reserved.status}`);

  const it = await call('POST', `/api/p/${token}/items`, { body: { title: 'CI 任务一', grp: groupName, status: 'todo' } });
  ok('新建任务返回 id 和 seq', it.status === 200 && !!it.json?.id && it.json?.seq === 1, `实际 ${it.status} seq=${it.json?.seq}`);
  itemId = it.json?.id || 0;

  const badStatus = await call('POST', `/api/p/${token}/items`, { body: { title: 'x', status: '瞎写' } });
  ok('状态不合法返回 400', badStatus.status === 400, `实际 ${badStatus.status}`);

  const badDue = await call('POST', `/api/p/${token}/items`, { body: { title: 'x', due: '2026-02-30' } });
  ok('不存在的日期返回 400', badDue.status === 400, `实际 ${badDue.status}`);

  const seq2 = await call('POST', `/api/p/${token}/items`, { body: { title: 'CI 任务二', grp: groupName } });
  ok('同分类第二条序号为 2', seq2.json?.seq === 2, `实际 ${seq2.json?.seq}`);
}

/* ================= 4. 修改与冲突检测 ================= */

section('4. 修改 / 冲突检测 / 完成锁定');
{
  const patch = await call('PATCH', `/api/p/${token}/items/${itemId}`, {
    body: { progress: '进行到一半', base: { progress: '' } }
  });
  ok('改进展返回 changed=1', patch.status === 200 && patch.json?.changed === 1, `实际 ${patch.status} changed=${patch.json?.changed}`);
  ok('修改后带回变更记录数组', Array.isArray(patch.json?.history) && patch.json.history.length > 0);

  const stale = await call('PATCH', `/api/p/${token}/items/${itemId}`, {
    body: { detail: '别人写的内容', base: { detail: '别人读到的旧值' } }
  });
  ok('用过期旧值改字段返回 409 冲突', stale.status === 409 && stale.json?.conflict === true, `实际 ${stale.status}`);

  const due = await call('PATCH', `/api/p/${token}/items/${itemId}`, {
    body: { due: '2026-12-01', base: { due: '' } }
  });
  ok('给没有期限的任务补期限不被误判冲突', due.status === 200, `实际 ${due.status} ${due.json?.error || ''}`);

  await call('PATCH', `/api/p/${token}/items/${itemId}`, { body: { status: 'done' } });
  const locked = await call('PATCH', `/api/p/${token}/items/${itemId}`, { body: { detail: '已完成还想改' } });
  ok('已完成的任务改内容返回 409', locked.status === 409, `实际 ${locked.status}`);

  const unlock = await call('PATCH', `/api/p/${token}/items/${itemId}`, { body: { status: 'doing' } });
  ok('已完成的任务可以改回进行中', unlock.status === 200, `实际 ${unlock.status}`);
}

/* ================= 5. 导出 ================= */

section('5. 导出与模板');
{
  const x = await call('GET', `/api/p/${token}/export.xlsx`);
  ok('导出 xlsx 返回 200', x.status === 200, `实际 ${x.status}`);
  ok('xlsx 是合法的 zip（PK 头）', x.buf[0] === 0x50 && x.buf[1] === 0x4b, `头两字节 ${x.buf[0]},${x.buf[1]}`);
  ok('xlsx 的 Content-Type 正确',
    (x.headers.get('content-type') || '').includes('spreadsheetml.sheet'));

  const csv = await call('GET', `/api/p/${token}/export.csv`);
  ok('导出 csv 返回 200', csv.status === 200);
  ok('csv 带 UTF-8 BOM（Excel 不乱码）',
    csv.buf[0] === 0xef && csv.buf[1] === 0xbb && csv.buf[2] === 0xbf, `头三字节 ${csv.buf.slice(0, 3).join(',')}`);

  const md = await call('GET', `/api/p/${token}/export.md`);
  ok('导出 markdown 返回 200', md.status === 200);
  ok('markdown 含项目名标题', md.text.includes('CI 冒烟项目'));
  ok('markdown 含任务条目', md.text.includes('CI 任务一'));

  const jl = await call('GET', `/api/p/${token}/export.jsonl`);
  ok('导出 jsonl 返回 200', jl.status === 200);
  const lines = jl.text.split('\n').filter((l) => l.trim());
  let allJson = true;
  let firstIsProject = false;
  let itemCount = 0;
  for (let i = 0; i < lines.length; i++) {
    let o = null;
    try { o = JSON.parse(lines[i]); } catch { allJson = false; break; }
    if (i === 0) firstIsProject = o.type === 'project' && !!o.stats;
    else if (o.type === 'item') itemCount++;
  }
  ok('jsonl 每一行都是合法 JSON', allJson);
  ok('jsonl 首行是项目概要且带 stats', firstIsProject);
  ok('jsonl 含 2 条任务', itemCount === 2, `实际 ${itemCount}`);

  const tpl = await call('GET', `/api/p/${token}/template.xlsx`);
  ok('下载导入模板返回 200', tpl.status === 200);
  ok('模板是合法的 zip（PK 头）', tpl.buf[0] === 0x50 && tpl.buf[1] === 0x4b);

  const notGet = await call('POST', `/api/p/${token}/export.md`, { body: {} });
  ok('导出接口只接受 GET（POST 返回 404）', notGet.status === 404, `实际 ${notGet.status}`);
}

/* ================= 6. 导入 ================= */

section('6. 导入');
{
  const csvText = '分类,任务内容,负责人,完成期限,状态\nCI 导入分类,导入的第一条,张三,2026-12-31,进行中\nCI 导入分类,导入的第二条,李四,,未开始\n';
  const dataUrl = 'data:text/csv;base64,' + Buffer.from(csvText, 'utf8').toString('base64');

  const before = await call('GET', `/api/p/${token}`);
  const beforeCount = before.json?.items?.length || 0;

  const imp = await call('POST', `/api/p/${token}/import`, { body: { dataUrl, mode: 'append', who: 'CI' } });
  ok('导入 csv 返回 200', imp.status === 200, `实际 ${imp.status} ${imp.json?.error || ''}`);
  ok('导入报告创建了 2 条', imp.json?.created === 2, `实际 created=${imp.json?.created}`);

  const after = await call('GET', `/api/p/${token}`);
  ok('导入后任务数增加 2', (after.json?.items?.length || 0) === beforeCount + 2,
    `导入前 ${beforeCount}，导入后 ${after.json?.items?.length}`);
  ok('导入自动建出了分类',
    (after.json?.groups || []).some((g) => g.name === 'CI 导入分类'));

  const replaceNoConfirm = await call('POST', `/api/p/${token}/import`, { body: { dataUrl, mode: 'replace' } });
  ok('覆盖导入未二次确认返回 400', replaceNoConfirm.status === 400, `实际 ${replaceNoConfirm.status}`);

  const noFile = await call('POST', `/api/p/${token}/import`, { body: {} });
  ok('没传文件返回 400', noFile.status === 400, `实际 ${noFile.status}`);
}

/* ================= 7. 协作相关 ================= */

section('7. 在线状态 / 下线 / 版本号');
{
  // presence 的形状是 { count, people: [{ clientId, name, bid, self }] }
  // 注意：count 是「标签页数」，按浏览器合并人数是前端 renderPresence() 做的，
  // 所以这里断言的是「服务端有没有如实带上 bid」——前端靠它去重。
  const s1 = await call('GET', `/api/p/${token}/state?cid=ci-a&bid=b1&name=甲`);
  ok('/state 返回 rev 和 presence',
    s1.status === 200 && s1.json?.rev !== undefined &&
    typeof s1.json?.presence?.count === 'number' && Array.isArray(s1.json?.presence?.people));
  ok('一个人在线时 people 有 1 条', s1.json?.presence?.people?.length === 1, `实际 ${s1.json?.presence?.people?.length}`);
  ok('自己的那条记录 self=true', s1.json?.presence?.people?.[0]?.self === true);
  ok('在线记录带上 bid（前端靠它按浏览器合并）', s1.json?.presence?.people?.[0]?.bid === 'b1');

  // 同一个 bid 的第二个标签页：换了 cid，但 bid 相同 —— 前端会合成「甲 ×2」
  const s2 = await call('GET', `/api/p/${token}/state?cid=ci-b&bid=b1&name=甲`);
  const sameBid = (s2.json?.presence?.people || []).filter((p) => p.bid === 'b1');
  ok('同一浏览器的两个标签页 bid 相同（前端据此合并）', sameBid.length === 2, `实际 ${sameBid.length}`);

  // 换一个 bid 才是另一个人
  const s3 = await call('GET', `/api/p/${token}/state?cid=ci-c&bid=b2&name=乙`);
  const otherBid = (s3.json?.presence?.people || []).filter((p) => p.bid === 'b2');
  ok('不同浏览器 bid 不同（前端据此区分两个人）', otherBid.length === 1, `实际 ${otherBid.length}`);

  const leave = await call('POST', `/api/p/${token}/leave?cid=ci-a`);
  ok('/leave 返回 200（关页面即时下线）', leave.status === 200, `实际 ${leave.status}`);

  const leaveGet = await call('GET', `/api/p/${token}/leave?cid=ci-a`);
  ok('/leave 只接受 POST', leaveGet.status === 404, `实际 ${leaveGet.status}`);
}

/* ================= 8. 异常输入不能把服务搞挂 ================= */

section('8. 异常输入');
{
  const noProj = await call('GET', '/api/p/zzzzzzzzzzzz');
  ok('不存在的项目 token 返回 404（不是 500）', noProj.status === 404, `实际 ${noProj.status}`);

  const badJson = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{这不是 JSON'
  });
  ok('畸形 JSON 返回 400（不是 500）', badJson.status === 400, `实际 ${badJson.status}`);

  const notObject = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '"就是一个字符串"'
  });
  ok('合法 JSON 但不是对象返回 400', notObject.status === 400, `实际 ${notObject.status}`);

  /* 这一条守着一个真实踩过的坑：以前用 req.headers.host 拼 base URL，
     Host 畸形时 new URL 抛 ERR_INVALID_URL，整个进程崩掉。 */
  let hostStatus = 0;
  try {
    hostStatus = await rawGet('/healthz', '[');
  } catch (e) {
    ok('畸形 Host 不会导致连接被重置', false, e.message);
  }
  ok('畸形 Host 仍能返回响应（服务没崩）', hostStatus > 0, `实际 ${hostStatus}`);

  const stillAlive = await call('GET', '/healthz');
  ok('畸形 Host 之后服务依然存活', stillAlive.status === 200 && stillAlive.text === 'ok');
}

/* ================= 9. 清理 ================= */

section('9. 删除');
{
  const delItem = await call('DELETE', `/api/p/${token}/items/${itemId}`);
  ok('删除任务返回 200', delItem.status === 200, `实际 ${delItem.status}`);

  const delProj = await call('DELETE', `/api/projects/${projectId}`, { cookie });
  ok('删除项目返回 200', delProj.status === 200, `实际 ${delProj.status}`);

  const gone = await call('GET', `/api/p/${token}`);
  ok('删除后项目不可访问', gone.status === 404, `实际 ${gone.status}`);
}

/* ================= 汇总 ================= */

console.log(`\n${'='.repeat(50)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项`);
  process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
