'use strict';

/**
 * ReqSlate —— 零依赖单文件服务
 * 依赖：Node.js >= 22.5（内置 node:sqlite）
 * 启动：node server.js
 * 配置：config.json（同目录，改完刷新页面即可生效）
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* 环境自检：数据用 Node 内置的 node:sqlite 存，不装任何第三方包。
   版本不够时 require 只会抛一句「Cannot find module 'node:sqlite'」，
   运维看了不知道该怎么办，所以这里提前拦住并说清楚。 */
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  /* Node 22.5–23.x 也有这个模块，只是默认关着，加个参数就能用。
     与其让用户自己去查文档，不如自己带上参数重跑一遍。 */
  const { spawnSync } = require('node:child_process');
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const canFlag = major === 22 && minor >= 5;
  if (canFlag && !process.execArgv.includes('--experimental-sqlite') && !process.env.RB_REEXEC) {
    const r = spawnSync(
      process.execPath,
      ['--experimental-sqlite', __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, RB_REEXEC: '1' } }
    );
    process.exit(r.status === null ? 1 : r.status);
  }

  console.error('');
  console.error('  ReqSlate 启动失败：当前 Node.js 版本 ' + process.version + ' 不带 node:sqlite。');
  console.error('');
  console.error('  需要 Node.js 24 或更高版本。');
  console.error('  （Node 22.5 以上会自动加 --experimental-sqlite 重试，你这里是 ' + process.version + '。）');
  console.error('  下载地址： https://nodejs.org/zh-cn/download');
  console.error('');
  console.error('  或者用 Docker 跑，镜像里已经带好 Node 24：见 README「部署」一节。');
  console.error('');
  process.exit(1);
}

const XLSX = require('./xlsx.js');

/* ================= 配置 ================= */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
// 时区偏移（小时）：默认 +8，即北京时间。改这里可适配其它时区。
const TZ_OFFSET = Number(process.env.TZ_OFFSET ?? 8);

const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  appName: 'ReqSlate',
  overviewTitle: '项目总览',
  boardTitle: '工作任务清单',
  titleSeparator: ' · ',
  footerText: 'ReqSlate',
  footerSub: 'designed by zhouwh',
  loginHint: '请输入管理密码'
};

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (typeof parsed[k] === 'string' && parsed[k] !== '') cfg[k] = parsed[k];
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[config] 读取失败，使用默认值：', e.message);
  }
  return cfg;
}

const CONFIG = loadConfig();

/* 数据目录建不出来时，报「EACCES: permission denied」对运维没用，
   直接说清楚是哪个目录、要什么权限。 */
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error('');
  console.error('  ReqSlate 启动失败：数据目录不可写');
  console.error('  目录： ' + DATA_DIR);
  console.error('  原因： ' + e.message);
  console.error('');
  console.error('  请换一个当前用户能写的目录：');
  console.error('    Linux/macOS:  DATA_DIR=/var/lib/reqslate node server.js');
  console.error('    Windows:      set DATA_DIR=D:\\reqslate-data  然后 node server.js');
  console.error('  用 Docker 时，把 docker-compose.yml 里 ./data 换成一个可写路径。');
  console.error('');
  process.exit(1);
}
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (e) {
  console.error('');
  console.error('  ReqSlate 启动失败：图片目录建不出来');
  console.error('  目录： ' + UPLOAD_DIR);
  console.error('  原因： ' + e.message);
  console.error('');
  process.exit(1);
}

/* ================= 时间 ================= */

function now() {
  // 固定东八区（UTC+8），不依赖服务器系统时区，也不依赖 ICU/Intl 数据，
  // 内网离线机器上表现一致。中国自 1991 年起无夏令时，直接用固定偏移即可。
  const d = new Date(Date.now() + TZ_OFFSET * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const todayStr = () => now().slice(0, 10);

/* ================= 数据库 ================= */

const db = new DatabaseSync(path.join(DATA_DIR, 'board.db'));

/* Node 22.5.x 的 node:sqlite 有个早期实现缺陷：get() 查不到行时返回的是
   「每一列都是 null 的对象」，而不是文档写的 undefined。这个对象是真值，
   于是 `if (!row)` 永远不成立、`while (db.prepare(...).get(x))` 会死循环。
   （22.5 之后某个小版本改对了，24 上也正常。）

   与其在启动时判断版本号——版本号是间接指标，将来还会变——不如直接问一句
   「查不到行时你返回什么」，就地判断，然后把 prepare 包一层，
   用 all()[0] 实现 get()。all() 在两边都稳定返回空数组。 */
(function patchSqliteGet() {
  const probe = db.prepare('SELECT 1 AS x WHERE 0');
  if (probe.get() === undefined) return;   // 行为正确，什么都不做

  const rawPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = rawPrepare(sql);
    return {
      run: (...a) => st.run(...a),
      all: (...a) => st.all(...a),
      // 空数组取 [0] 就是 undefined，和有缺陷的版本之外的语义一致
      get: (...a) => st.all(...a)[0]
    };
  };
  console.log('[compat] 当前 Node ' + process.version + ' 的 node:sqlite 无行时返回空对象，已自动修正 get() 语义');
})();

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    rev        INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    title      TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    progress   TEXT NOT NULL DEFAULT '',
    grp        TEXT NOT NULL DEFAULT '',
    due        TEXT,
    owner      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'todo',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    at      TEXT NOT NULL,
    who     TEXT NOT NULL DEFAULT '',
    text    TEXT NOT NULL,
    field   TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    file       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    done_since TEXT,
    done_seq   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_proj ON items(project_id);
  CREATE INDEX IF NOT EXISTS idx_hist_item ON history(item_id);
  CREATE INDEX IF NOT EXISTS idx_img_item ON images(item_id);
  CREATE INDEX IF NOT EXISTS idx_grp_proj ON groups(project_id);
`);

/* --- 老库升级：补列（新库建表已含，已存在则跳过） --- */

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[migrate] ${table}.${column} 已补齐`);
}

ensureColumn('items', 'progress', "progress TEXT NOT NULL DEFAULT ''");
ensureColumn('items', 'grp', "grp TEXT NOT NULL DEFAULT ''");
ensureColumn('groups', 'done_since', 'done_since TEXT');
ensureColumn('groups', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
// 完成顺序序号：done_since 只到秒，同一秒完成两个分类就分不出先后，
// 加一个单调递增的计数，保证「新完成的压在旧完成的上面」永远成立
ensureColumn('groups', 'done_seq', 'done_seq INTEGER NOT NULL DEFAULT 0');
// 项目版本号：任何一次写入都 +1，别的浏览器靠它发现自己该刷新了
ensureColumn('projects', 'rev', 'rev INTEGER NOT NULL DEFAULT 0');

/* ================= 会话（HMAC 签名 cookie，重启不掉线） ================= */

const SECRET_FILE = path.join(DATA_DIR, '.secret');

function loadSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}

const SECRET = loadSecret();
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天

/* 登录失败限流：管理密码是「一个密码进全部项目」，被脚本慢慢试是真实风险。
   按 IP 记，连续失败攒够就锁一段时间。只放内存，重启即清零——重启后
   攻击者还得从头来，够用了，也省得写库。 */
const LOGIN_MAX_FAILS = 8;          // 连续失败几次开始拒绝
const LOGIN_LOCK_MS = 5 * 60 * 1000; // 锁多久
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 多久没失败就把计数清掉
const LOGIN_FAILS = new Map(); // ip -> { n, firstAt, lockedUntil }

function loginLockLeft(ip) {
  const rec = LOGIN_FAILS.get(ip);
  if (!rec) return 0;
  const left = (rec.lockedUntil || 0) - Date.now();
  return left > 0 ? left : 0;
}

function noteLoginFail(ip) {
  const t = Date.now();
  let rec = LOGIN_FAILS.get(ip);
  if (!rec || t - rec.firstAt > LOGIN_WINDOW_MS) rec = { n: 0, firstAt: t, lockedUntil: 0 };
  rec.n += 1;
  if (rec.n >= LOGIN_MAX_FAILS) rec.lockedUntil = t + LOGIN_LOCK_MS;
  LOGIN_FAILS.set(ip, rec);
  // 顺手清一清过期记录，避免 Map 无限长
  if (LOGIN_FAILS.size > 2000) {
    for (const [k, v] of LOGIN_FAILS) {
      if (t - v.firstAt > LOGIN_WINDOW_MS && !(v.lockedUntil > t)) LOGIN_FAILS.delete(k);
    }
  }
}

function noteLoginOk(ip) { LOGIN_FAILS.delete(ip); }

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

const newSession = () => {
  const exp = String(Date.now() + SESSION_TTL);
  return exp + '.' + sign(exp);
};

function getSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)rb_sid=([^;]+)/);
  if (!m) return null;

  let val;
  try {
    val = decodeURIComponent(m[1]);
  } catch {
    return null; // 畸形 cookie（非法 % 序列）直接当未登录，别抛成 500
  }
  const i = val.lastIndexOf('.');
  if (i < 1) return null;

  const exp = val.slice(0, i);
  if (!/^\d+$/.test(exp) || !safeEqual(val.slice(i + 1), sign(exp))) return null;
  if (Number(exp) < Date.now()) return null;

  return val;
}

/* ================= HTTP 工具 ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

/* 所有响应都带上的安全头：
   - nosniff：别让浏览器把上传的图片当成脚本执行
   - SAMEORIGIN：防止别人用 iframe 套住这个页面做点击劫持
   - no-referrer：项目链接就是凭据，别顺着外链泄露出去 */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer'
};

function sendJSON(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SEC_HEADERS,
    ...extraHeaders
  });
  res.end(body);
}

const sendText = (res, code, text, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, ...SEC_HEADERS });
  res.end(text);
};

const sendPublic = (res, name) => {
  fs.readFile(path.join(PUBLIC_DIR, name), (err, buf) => {
    if (err) return sendText(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SEC_HEADERS
    });
    res.end(buf);
  });
};

function sendImageFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache,
      ...SEC_HEADERS
    });
    res.end(buf);
  });
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // 先看声明长度：超限就别读了，把剩余数据排空后直接回 413，
    // 避免读到一半 destroy 连接导致前端只看到「连接被重置」。
    if (Number(req.headers['content-length'] || 0) > limit) {
      req.resume();
      const e = new Error('内容过大，单次不超过 12MB');
      e.statusCode = 413;
      return reject(e);
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) {
        const e = new Error('内容过大，单次不超过 12MB');
        e.statusCode = 413;
        return reject(e);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return reject(badRequest('JSON 格式错误')); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(badRequest('请求内容必须是 JSON 对象'));
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // 长度不等直接 false（长度不算机密）；等长才走 timing-safe 比较
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const str = (v) => String(v ?? '').trim();

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

function normalizeDue(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const v = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('日期格式应为 YYYY-MM-DD');
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw badRequest('完成期限不是有效日期');
  }
  return v;
}

function newToken() {
  // 12 位定长随机码，去除易混字符 0/O/1/l/I
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/* ================= 业务：统计 ================= */

const STATUSES = ['todo', 'doing', 'done'];

/* 「未分类」是虚拟分类：任务的 grp 为空串就归到它。
   它按任务的新增日期分桶——10月25日加的任务一直留在「10月25日新增」里，
   不会因为过了零点就变成「10月26日新增」，也不会自己消失。
   所有桶都钉在最上面，归完类（改个分类名）才变成普通分类。
   桶名用 `未分类@2026-10-25` 这种内部名，只在内存里算，不落库。 */
const UNCAT = '未分类';
const UNCAT_SEP = '@';

const uncatName = (date) => `${UNCAT}${UNCAT_SEP}${date}`;
const isUncatName = (n) => {
  const s = String(n || '');
  return s === UNCAT || s.startsWith(UNCAT + UNCAT_SEP);
};
const uncatDate = (n) => String(n || '').split(UNCAT_SEP)[1] || '';

/* 桶的显示名：10月25日新增 */
function uncatLabel(date) {
  const d = date || todayStr();
  const [, m, dd] = d.split('-');
  return `${Number(m)}月${Number(dd)}日新增`;
}

function statsOf(projectId) {
  const t = todayStr();
  const s = { total: 0, todo: 0, doing: 0, done: 0, overdue: 0 };
  for (const r of db.prepare('SELECT status, due FROM items WHERE project_id = ?').all(projectId)) {
    s.total++;
    if (s[r.status] !== undefined) s[r.status]++;
    if (r.status !== 'done' && r.due && r.due < t) s.overdue++;
  }
  return s;
}

/* ================= 业务：分类 ================= */

/* 分类存在 groups 表里（可排序、可改名、可记录「什么时候全部完成」）。
   items.grp 是分类名（冗余存储，便于单条任务直接改分类）。
   未分类 = grp 为空串，靠占位行参与排序。 */

const groupRows = (projectId) => db.prepare(
  'SELECT id, name, sort_order AS sortOrder, done_since AS doneSince, done_seq AS doneSeq FROM groups WHERE project_id = ?'
).all(projectId);

/* 新分类的排序号：排在所有已有分类后面 */
const nextGroupOrder = (projectId) => db.prepare(
  'SELECT COALESCE(MAX(sort_order), 0) AS m FROM groups WHERE project_id = ?'
).get(projectId).m + 1;

/* 把 items.grp 里出现过、但 groups 表里还没有的分类补建出来；
   并维护「未分类」占位行：有未分类任务就补上（排最前，方便拖），
   没有了就清掉，别留个空分类。 */
function syncGroups(projectId) {
  const ts = now();
  const names = db.prepare(
    "SELECT DISTINCT TRIM(grp) AS g FROM items WHERE project_id = ? AND TRIM(grp) <> ''"
  ).all(projectId).map((r) => r.g);

  const have = new Set(groupRows(projectId).map((g) => g.name));
  let maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM groups WHERE project_id = ?'
  ).get(projectId).m;

  const ins = db.prepare('INSERT INTO groups (project_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)');
  for (const n of names) {
    if (have.has(n)) continue;
    ins.run(projectId, n, ++maxOrder, ts);
    have.add(n);
  }

  const uncatDates = db.prepare(
    "SELECT DISTINCT SUBSTR(created_at, 1, 10) AS d FROM items WHERE project_id = ? AND TRIM(grp) = ''"
  ).all(projectId).map((r) => r.d);

  // 未归类的任务按「新增那一天」分桶，一天一个占位分类，谁也不会因为过了零点而消失
  const want = new Set(uncatDates.map(uncatName));
  for (const n of want) {
    if (have.has(n)) continue;
    ins.run(projectId, n, 0, ts);
    have.add(n);
  }
  // 这一桶里的任务都归完类了，占位行跟着清掉，别留空分类
  for (const n of [...have]) {
    if (isUncatName(n) && !want.has(n)) {
      db.prepare('DELETE FROM groups WHERE project_id = ? AND name = ?').run(projectId, n);
      have.delete(n);
    }
  }
}

/* 分类下任务全部完成时记一个时间点 + 递增序号，用于「完成栈」排序；
   恢复成未全部完成会清空 */
function refreshDoneSince(projectId) {
  const rows = db.prepare(`
    SELECT g.id, g.name, g.done_since AS doneSince,
      (SELECT COUNT(*) FROM items i
        WHERE i.project_id = g.project_id AND TRIM(i.grp) = g.name) AS total,
      (SELECT COUNT(*) FROM items i
        WHERE i.project_id = g.project_id AND TRIM(i.grp) = g.name AND i.status = 'done') AS done
    FROM groups g WHERE g.project_id = ?
  `).all(projectId);

  let maxSeq = db.prepare(
    'SELECT COALESCE(MAX(done_seq), 0) AS m FROM groups WHERE project_id = ?'
  ).get(projectId).m;

  // 按 id 顺序处理，保证同一批里后处理的序号更大（更靠上）
  for (const r of rows.sort((a, b) => a.id - b.id)) {
    // 「未分类」是收纳筐，不参与完成栈
    const allDone = !isUncatName(r.name) && r.total > 0 && r.done === r.total;
    if (allDone && !r.doneSince) {
      db.prepare('UPDATE groups SET done_since = ?, done_seq = ? WHERE id = ?').run(now(), ++maxSeq, r.id);
    } else if (!allDone && r.doneSince) {
      db.prepare('UPDATE groups SET done_since = NULL, done_seq = 0 WHERE id = ?').run(r.id);
    }
  }
}

/* 分类内序号：每个分类从 1 开始，按当前顺序压实。
   未分类没有分类名，按「新增那一天」分桶，每个桶各自从 1 编。 */
function renumberGroup(projectId, grpName) {
  const g = str(grpName);
  const upd = db.prepare('UPDATE items SET seq = ? WHERE id = ?');

  if (!g) {
    for (const { d } of db.prepare(
      "SELECT DISTINCT SUBSTR(created_at, 1, 10) AS d FROM items WHERE project_id = ? AND TRIM(grp) = ''"
    ).all(projectId)) {
      db.prepare(`
        SELECT id FROM items
        WHERE project_id = ? AND TRIM(grp) = '' AND SUBSTR(created_at, 1, 10) = ?
        ORDER BY seq ASC, id ASC
      `).all(projectId, d).forEach((r, i) => upd.run(i + 1, r.id));
    }
    return;
  }

  db.prepare(`
    SELECT id FROM items WHERE project_id = ? AND TRIM(grp) = ? ORDER BY seq ASC, id ASC
  `).all(projectId, g).forEach((r, i) => upd.run(i + 1, r.id));
}

/* 某个分类（或未分类的某个日期桶）里下一个序号 */
function nextSeqFor(projectId, grp, day) {
  const g = str(grp);
  if (!g) {
    return db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS m FROM items
      WHERE project_id = ? AND TRIM(grp) = '' AND SUBSTR(created_at, 1, 10) = ?
    `).get(projectId, day).m + 1;
  }
  return db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM items WHERE project_id = ? AND TRIM(grp) = ?'
  ).get(projectId, g).m + 1;
}

function renumberAll(projectId) {
  for (const r of db.prepare("SELECT DISTINCT TRIM(grp) AS g FROM items WHERE project_id = ?").all(projectId)) {
    renumberGroup(projectId, r.g);
  }
}

/* 分类显示顺序：进行中的按 sort_order；全部完成的沉到下面，
   按「完成时间倒序」堆叠——新完成的压在旧完成的上面 */
function orderedGroups(projectId) {
  syncGroups(projectId);
  refreshDoneSince(projectId);

  const stat = new Map();
  for (const s of db.prepare(`
    SELECT CASE WHEN TRIM(grp) = ''
                THEN ? || SUBSTR(created_at, 1, 10)
                ELSE TRIM(grp) END AS g,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM items WHERE project_id = ?
    GROUP BY g
  `).all(UNCAT + UNCAT_SEP, projectId)) {
    stat.set(s.g, { total: s.total, done: Number(s.done || 0) });
  }

  const active = [];
  const stacked = [];
  for (const g of groupRows(projectId)) {
    const st = stat.get(g.name) || { total: 0, done: 0 };
    // 未分类的每一个日期桶都不参与完成栈沉底：它是收纳筐，永远待在最上面
    const isUncat = isUncatName(g.name);
    const allDone = !isUncat && st.total > 0 && st.done === st.total;
    const rec = {
      ...g,
      ...st,
      allDone,
      virtual: isUncat,
      date: isUncat ? uncatDate(g.name) : '',
      // 界面显示名：未分类的桶显示成「10月25日新增」
      label: isUncat ? uncatLabel(uncatDate(g.name)) : g.name
    };
    (allDone ? stacked : active).push(rec);
  }

  // 未分类的日期桶永远钉在最上面，新的日期在上；其余按手工顺序
  active.sort((a, b) =>
    (b.virtual ? 1 : 0) - (a.virtual ? 1 : 0) ||
    (a.virtual ? (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) : 0) ||
    a.sortOrder - b.sortOrder);
  // 新完成的在上：done_seq 降序（单调递增，不受同秒影响）；
  // 老数据没有 done_seq 的退回 done_since 降序，再退回 sort_order
  stacked.sort((a, b) => {
    const da = String(a.doneSince || '');
    const dbb = String(b.doneSince || '');
    return ((b.doneSeq || 0) - (a.doneSeq || 0)) ||
      (da < dbb ? 1 : da > dbb ? -1 : 0) ||
      (a.sortOrder - b.sortOrder);
  });

  return active.concat(stacked);
}

/* ================= 业务：历史 ================= */

const STATUS_CN = { todo: '未开始', doing: '进行中', done: '已完成' };

const FIELD_LABEL = {
  title: '内容',
  detail: '补充说明',
  progress: '进展情况',
  grp: '所属分类',
  due: '完成期限',
  owner: '负责人',
  status: '状态'
};

const displayVal = (field, v) => {
  if (v === null || v === undefined || v === '') return '（空）';
  if (field === 'status') return STATUS_CN[v] || v;
  return String(v);
};

const INSERT_HIST = 'INSERT INTO history (item_id, at, who, text, field) VALUES (?, ?, ?, ?, ?)';

/* at 允许外部传入：这样 items.updated_at 和这一批历史用同一个时间戳，
   前端拿 updated_at 当「我读到的是哪一版」的基准才不会有 1 秒的错位。 */
function recordHistory(itemId, who, changes, at = now()) {
  const stmt = db.prepare(INSERT_HIST);
  for (const c of changes) {
    stmt.run(itemId, at, who,
      `${c.verb || '修改了'}${FIELD_LABEL[c.field] || c.field}：${displayVal(c.field, c.old)} → ${displayVal(c.field, c.new)}`,
      c.field);
  }
}

/* ================= 业务：图片 ================= */

const IMG_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const IMG_MAX = 8 * 1024 * 1024; // 单张 8MB

function saveImage(projToken, itemId, dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!m || !IMG_TYPES[m[1].toLowerCase()]) throw badRequest('图片格式不对，只支持 PNG / JPG / GIF / WebP');
  const buf = Buffer.from(m[2], 'base64');
  const type = sniffImage(buf);
  if (!buf.length || !type || type !== m[1].toLowerCase()) throw badRequest('图片内容与声明格式不一致');
  if (buf.length > IMG_MAX) throw new Error('单张图片不能超过 8MB');

  const dir = path.join(UPLOAD_DIR, projToken);
  fs.mkdirSync(dir, { recursive: true });

  const file = crypto.randomBytes(10).toString('hex') + IMG_TYPES[type];
  fs.writeFileSync(path.join(dir, file), buf);

  const r = db.prepare(
    'INSERT INTO images (item_id, file, mime, size, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(itemId, file, m[1].toLowerCase(), buf.length, now());

  return { id: Number(r.lastInsertRowid), file, size: buf.length };
}

const deleteImageFile = (projToken, file) => {
  try { fs.unlinkSync(path.join(UPLOAD_DIR, projToken, file)); } catch { /* 文件已不在就算了 */ }
};

/* ================= 业务：Excel / CSV 导入导出 ================= */

/* 导出的列。序号也导出去，人看着方便；导回来时序号不采信，
   一律按分类重新编，免得外部改乱了导致同号。 */
const XLSX_HEADER = ['分类', '序号', '任务内容', '补充说明', '进展情况', '负责人', '完成期限', '状态', '最后更新'];

/* 导入时认这些列名（大小写、全半角不管，去空格后比） */
const IMPORT_COLUMNS = {
  grp: ['分类', '所属分类', '分组', '分类名', 'group', 'grp'],
  seq: ['序号', 'seq'],
  title: ['任务内容', '内容', '标题', '任务', 'title'],
  detail: ['补充说明', '说明', '备注', 'detail', 'description'],
  progress: ['进展情况', '进展', 'progress'],
  owner: ['负责人', '责任人', 'owner'],
  due: ['完成期限', '期限', '截止日期', '截止时间', 'due', 'deadline'],
  status: ['状态', 'status'],
  updatedAt: ['最后更新', '更新时间', 'updatedat']
};

const STATUS_ALIAS = {
  '未开始': 'todo', '待办': 'todo', '未启动': 'todo', 'todo': 'todo', 'notstarted': 'todo',
  '进行中': 'doing', '在做': 'doing', '处理中': 'doing', 'doing': 'doing', 'inprogress': 'doing',
  '已完成': 'done', '完成': 'done', '已结束': 'done', 'done': 'done', 'finished': 'done'
};

const MAX_IMPORT_ROWS = 5000;

const rowToArray = (it) => [it.grp || '', it.seq, it.title, it.detail, it.progress, it.owner, it.due, STATUS_CN[it.status] || it.status, it.updatedAt];

/* 一个项目的完整任务表（按分类顺序、分类内序号） */
function exportRows(projectId) {
  const items = db.prepare(`
    SELECT id, seq, title, detail, progress, grp, due, owner, status,
           created_at AS createdAt, updated_at AS updatedAt
    FROM items WHERE project_id = ? ORDER BY seq ASC, id ASC
  `).all(projectId);

  // 按 orderedGroups 的顺序排，导出后和界面看到的次序一致。
  // 未分类的日期桶也要进 map——它们在 orderedGroups 里已经按日期倒序在最前，
  // 漏掉的话多个日期桶之间会按 seq 交错，和界面不一致。
  const order = new Map();
  orderedGroups(projectId).forEach((g, i) => order.set(g.name, i));
  const bucketOf = (it) => (it.grp || '').trim() || uncatName(String(it.createdAt || '').slice(0, 10));
  // 兜底：真遇到没登记的分类，排到最后，别跑到最前面挡住正常顺序
  const rank = (it) => (order.has(bucketOf(it)) ? order.get(bucketOf(it)) : order.size);
  items.sort((a, b) => rank(a) - rank(b) || a.seq - b.seq || a.id - b.id);

  return items.map((it) => ({
    ...it,
    grp: (it.grp || '').trim() || uncatLabel(String(it.createdAt || '').slice(0, 10))
  }));
}

function exportWorkbook(proj) {
  const items = exportRows(proj.id);

  const hist = db.prepare(`
    SELECT h.at, h.who, h.text, h.field, i.title, i.grp
    FROM history h JOIN items i ON i.id = h.item_id
    WHERE i.project_id = ? ORDER BY h.id DESC LIMIT 5000
  `).all(proj.id);

  return XLSX.writeWorkbook([
    {
      name: '任务清单',
      header: XLSX_HEADER,
      rows: items.map(rowToArray),
      widths: [18, 6, 34, 40, 40, 16, 13, 9, 19],
      freeze: true,
      filter: true
    },
    {
      name: '变更历史',
      header: ['时间', '谁', '分类', '任务内容', '变更内容'],
      rows: hist.map((h) => [h.at, h.who || '', h.grp || '', h.title || '', h.text || '']),
      widths: [19, 16, 18, 34, 60],
      freeze: true,
      filter: true
    }
  ]);
}

function exportCsv(proj) {
  return XLSX.toCsv([XLSX_HEADER, ...exportRows(proj.id).map(rowToArray)]);
}

/* 喂本地大模型用：Markdown 和 JSONL 两种。
   内网跑 7B 那类小模型时，xlsx 它读不了，把清单摊成纯文本最省事。
   Markdown 给人看/贴进对话；JSONL 一行一条，方便脚本分批喂。 */
function exportMarkdown(proj) {
  const items = exportRows(proj.id);
  const s = statsOf(proj.id);
  const out = [];

  out.push(`# ${proj.name} · ${loadConfig().boardTitle}`);
  out.push('');
  out.push(`> 导出时间 ${now()}　共 ${s.total} 项：已完成 ${s.done}、进行中 ${s.doing}、未开始 ${s.todo}、已逾期 ${s.overdue}${proj.note ? `　备注：${proj.note}` : ''}`);
  out.push('');

  // 按分类分组输出，和界面上看到的一致
  let cur = null;
  let idx = 0;
  for (const it of items) {
    if (it.grp !== cur) {
      cur = it.grp;
      out.push('');
      out.push(`## ${cur || '未分类'}`);
      out.push('');
    }
    idx++;
    const flag = it.status === 'done'
      ? '✅ 已完成'
      : (it.due && it.due < todayStr() ? `⚠️ 逾期（期限 ${it.due}）` : STATUS_CN[it.status]);
    out.push(`${idx}. **${it.title}**　${flag}${it.owner ? `　负责人：${it.owner}` : ''}${it.due ? `　期限：${it.due}` : ''}`);
    if (it.detail) out.push(`   - 补充说明：${it.detail.replace(/\n/g, ' ')}`);
    if (it.progress) out.push(`   - 进展：${it.progress.replace(/\n/g, ' ')}`);
  }

  const hist = db.prepare(`
    SELECT h.at, h.who, h.text, i.title
    FROM history h JOIN items i ON i.id = h.item_id
    WHERE i.project_id = ? ORDER BY h.id DESC LIMIT 300
  `).all(proj.id);
  if (hist.length) {
    out.push('');
    out.push('## 最近变更（最多 300 条，新的在上）');
    out.push('');
    for (const h of hist) out.push(`- ${h.at}　${h.who || '未署名'}　【${h.title}】${h.text}`);
  }

  out.push('');
  return out.join('\n');
}

function exportJsonl(proj) {
  const items = exportRows(proj.id);
  const s = statsOf(proj.id);
  const lines = [];

  // 第一行是项目概要，后面一行一条任务。都是合法 JSON，便于 jq / python 逐行读
  lines.push(JSON.stringify({
    type: 'project',
    name: proj.name,
    note: proj.note || '',
    exportedAt: now(),
    today: todayStr(),
    stats: s
  }));

  for (const it of items) {
    lines.push(JSON.stringify({
      type: 'item',
      grp: it.grp || '',
      seq: it.seq,
      title: it.title,
      detail: it.detail || '',
      progress: it.progress || '',
      owner: it.owner || '',
      due: it.due || null,
      status: it.status,
      statusText: STATUS_CN[it.status] || it.status,
      overdue: !!(it.due && it.status !== 'done' && it.due < todayStr()),
      updatedAt: it.updatedAt
    }));
  }

  return lines.join('\n') + '\n';
}

/* 导入模板：表头 + 两行示例 + 一页填写说明。
   示例行故意写得很像真实数据，用户照着填就行。 */
function templateWorkbook() {
  return XLSX.writeWorkbook([
    {
      name: '任务清单',
      header: XLSX_HEADER,
      rows: [
        ['公文流转模块', 1, '收文登记模块', '按来文单位、文号、密级登记，支持扫描件上传', '', '王芳（乙方）', '2026-11-10', '进行中', ''],
        ['公文流转模块', 2, '发文拟稿模块', '', '已出原型，等甲方确认', '李娜（甲方）', '2026-11-20', '未开始', ''],
        ['会议管理', 1, '会议通知分发', '支持按参会人批量发通知', '本周联调', '张伟（甲方）', '2026-12-05', '进行中', '']
      ],
      widths: [18, 6, 34, 40, 40, 16, 13, 9, 19],
      freeze: true,
      filter: true
    },
    {
      name: '填写说明',
      header: ['列名', '怎么填', '必填'],
      rows: [
        ['分类', '这条任务归到哪个分类。留空就进「今天新增」那一组，之后再改分类名就扶正成普通分类', '否'],
        ['序号', '不用填。导入时一律按分类重新从 1 编，填了也会被忽略', '否'],
        ['任务内容', '一句话说清要做什么，最多 200 字。空行的整行会被跳过', '是'],
        ['补充说明', '背景、依据、验收标准等，可以多行', '否'],
        ['进展情况', '当前做到哪一步', '否'],
        ['负责人', '建议写成「姓名（甲方/乙方）」，方便区分是哪一方', '否'],
        ['完成期限', '写成 2026-11-10 这样。也认 2026/11/10、2026年11月10日、20261110', '否'],
        ['状态', '只能填：未开始 / 进行中 / 已完成。留空按「未开始」处理', '否'],
        ['最后更新', '导出时自动带上，导入时忽略', '否']
      ],
      widths: [12, 70, 6]
    }
  ]);
}

/* 上传的文件是 xlsx 还是 csv：xlsx 就是 zip，头 4 字节 PK\x03\x04 */
function decodeUpload(body) {
  const du = str(body.dataUrl);
  const m = du.match(/^data:[\w.+\/-]+;base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!m) throw badRequest('没有收到文件内容');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) throw badRequest('文件是空的');
  if (buf.length > 8 * 1024 * 1024) throw badRequest('文件太大，请控制在 8MB 以内');
  return buf;
}

/* Excel 在中文 Windows 上另存的 CSV 是 GBK；UTF-8 解出来有替换符就换 GBK 再试 */
function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

function sheetRows(buf) {
  if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    let wb;
    try {
      wb = XLSX.readWorkbook(buf);
    } catch (e) {
      throw badRequest('这个 xlsx 打不开：' + e.message);
    }
    const first = wb.sheets.find((s) => s.rows.some((r) => r.some((c) => String(c ?? '').trim())));
    if (!first) throw badRequest('表格里没有内容');
    return first.rows;
  }
  return XLSX.parseCsv(decodeText(buf));
}

/* 宽松日期：认 2026-11-10 / 2026/11/10 / 2026.11.10 / 2026年11月10日 / 20261110 */
function looseDate(value) {
  const s = str(value);
  if (!s) return null;
  let m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function importTable(proj, rows, opts) {
  const warnings = [];
  const warn = (msg) => { if (warnings.length < 20) warnings.push(msg); };

  if (!rows.length) throw badRequest('表格里没有内容');

  /* 找表头：前 10 行里第一行能认出「任务内容」的就是表头 */
  let headIdx = -1;
  let map = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = (rows[i] || []).map((c) => str(c).replace(/\s+/g, ''));
    const found = {};
    cells.forEach((c, ci) => {
      for (const [field, aliases] of Object.entries(IMPORT_COLUMNS)) {
        if (found[field] !== undefined) continue;
        if (aliases.some((a) => a.toLowerCase() === c.toLowerCase())) found[field] = ci;
      }
    });
    if (found.title !== undefined) { headIdx = i; map = found; break; }
  }
  if (headIdx < 0) throw badRequest('没找到表头。请用「下载导入模板」拿到的表头，至少要有「任务内容」这一列');

  const body = rows.slice(headIdx + 1).filter((r) => (r || []).some((c) => str(c) !== ''));
  if (body.length > MAX_IMPORT_ROWS) throw badRequest(`一次最多导入 ${MAX_IMPORT_ROWS} 行，请拆成几份`);

  const cell = (r, field) => (map[field] === undefined ? '' : str(r[map[field]]));

  /* 覆盖模式：先清空这个项目的任务（图片文件一起删掉） */
  if (opts.replace) {
    for (const it of db.prepare('SELECT id FROM items WHERE project_id = ?').all(proj.id)) {
      for (const g of db.prepare('SELECT file FROM images WHERE item_id = ?').all(it.id)) {
        deleteImageFile(proj.token, g.file);
      }
      db.prepare('DELETE FROM images WHERE item_id = ?').run(it.id);
      db.prepare('DELETE FROM history WHERE item_id = ?').run(it.id);
      db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
    }
    db.prepare('DELETE FROM groups WHERE project_id = ?').run(proj.id);
  }

  const ts = now();
  const today = todayStr();
  const who = str(opts.who) || '导入';
  const haveGroups = new Set(groupRows(proj.id).map((g) => g.name));
  const newGroups = [];
  const touched = new Set();
  let created = 0;
  let skipped = 0;

  const ensureGroup = (name) => {
    if (!name || isUncatName(name)) return;
    if (haveGroups.has(name)) return;
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM groups WHERE project_id = ?').get(proj.id).m + 1;
    db.prepare('INSERT INTO groups (project_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)')
      .run(proj.id, name, order, ts);
    haveGroups.add(name);
    newGroups.push(name);
  };

  body.forEach((r, i) => {
    const lineNo = headIdx + 2 + i;
    const title = cell(r, 'title').slice(0, 200);
    if (!title) { skipped++; return; }

    let grp = cell(r, 'grp').slice(0, 40);
    // 模板里的「10月26日新增」这种日期组名，导回来当未分类处理（它本来就是虚拟分类）
    if (/^\d{1,2}月\d{1,2}日新增$/.test(grp) || grp === UNCAT) grp = '';
    ensureGroup(grp);

    const rawStatus = cell(r, 'status').replace(/\s+/g, '');
    const status = rawStatus ? (STATUS_ALIAS[rawStatus.toLowerCase()] || STATUS_ALIAS[rawStatus]) : 'todo';
    if (rawStatus && !status) warn(`第 ${lineNo} 行状态「${cell(r, 'status')}」认不出，已按「未开始」处理`);

    const rawDue = cell(r, 'due');
    const due = rawDue ? looseDate(rawDue) : null;
    if (rawDue && !due) warn(`第 ${lineNo} 行期限「${rawDue}」不是有效日期，已留空`);

    const seq = nextSeqFor(proj.id, grp, today);
    const ins = db.prepare(`
      INSERT INTO items (project_id, seq, title, detail, progress, grp, due, owner, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proj.id, seq, title,
      cell(r, 'detail').slice(0, 4000),
      cell(r, 'progress').slice(0, 4000),
      grp, due,
      cell(r, 'owner').slice(0, 40),
      status || 'todo', ts, ts
    );
    const newId = Number(ins.lastInsertRowid);
    db.prepare(INSERT_HIST).run(newId, ts, who, `从表格导入，初始状态：${STATUS_CN[status || 'todo']}`, 'create');
    touched.add(grp);
    created++;
  });

  for (const g of touched) renumberGroup(proj.id, g);
  syncGroups(proj.id);
  refreshDoneSince(proj.id);
  if (created || opts.replace) bumpRev(proj.id);

  return { ok: true, created, skipped, replaced: !!opts.replace, newGroups, warnings, rev: curRev(proj.id) };
}

/* 下载响应：中文文件名用 RFC 5987 的 filename*，否则 Chrome 会显示成乱码 */
function sendDownload(res, buf, type, filename) {
  // 项目名是用户自己填的，可能带引号或反斜杠，直接拼进 header 会把
  // Content-Disposition 拆坏（引号提前闭合）。这里把 ASCII 里的 " 和 \ 也换掉；
  // 中文等非 ASCII 走标准的 filename*=UTF-8''，不受影响。
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // encodeURIComponent 不转义单引号，而 RFC 5987 的 attr-char 里没有 '，补一下
  const utf8 = encodeURIComponent(filename).replace(/'/g, '%27');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    'Cache-Control': 'no-store',
    ...SEC_HEADERS
  });
  res.end(buf);
}

/* ================= 业务：项目内接口 ================= */

const projByToken = (token) => db.prepare('SELECT * FROM projects WHERE token = ?').get(token);

/* ================= 并发：版本号 + 在线人数 ================= */

/* 任何一次写入都把项目的 rev +1。别人的浏览器每隔几秒问一次 rev，
   对不上就整页重拉，于是「一个人改了，另一个人那里也跟着变」。 */
const bumpRev = (projectId) => db.prepare('UPDATE projects SET rev = rev + 1 WHERE id = ?').run(projectId);
const curRev = (projectId) => db.prepare('SELECT rev FROM projects WHERE id = ?').get(projectId).rev;

/* 在线名单只放内存：进程重启就清空，本来也不需要持久化。
   每个浏览器标签页一个 clientId，超过 PRESENCE_TTL 没心跳就算离开。
   TTL 是「兜底」：正常关页面时前端会用 sendBeacon 打 /leave 立刻销号，
   只有浏览器被强杀、断网这类来不及打招呼的情况才靠 TTL 慢慢过期。 */
const PRESENCE_TTL = 20 * 1000;
const PRESENCE = new Map();   // `${projectId}:${clientId}` -> { name, bid, at }

function presenceOf(projectId, clientId, name, bid) {
  const t = Date.now();
  for (const [k, v] of PRESENCE) if (t - v.at > PRESENCE_TTL) PRESENCE.delete(k);
  if (clientId) PRESENCE.set(`${projectId}:${clientId}`, { name: str(name), bid: str(bid), at: t });

  const people = [];
  for (const [k, v] of PRESENCE) {
    if (!k.startsWith(projectId + ':')) continue;
    people.push({
      clientId: k.slice(String(projectId).length + 1),
      name: v.name,
      bid: v.bid,                      // 同一个浏览器（同一台电脑）的所有标签页共用一个 bid
      self: k === `${projectId}:${clientId}`
    });
  }
  // 自己排最前，其余按名字排，界面上顺序稳定不跳
  people.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || a.name.localeCompare(b.name, 'zh'));
  return { count: people.length, people };
}

/* 关页面时立刻销号。sendBeacon 在页面卸载过程中也能发出去，
   比等 TTL 过期快得多（用户反馈「关掉页面在线状态反应慢」就是 TTL 造成的）。 */
function leavePresence(projectId, clientId) {
  if (clientId) PRESENCE.delete(`${projectId}:${clientId}`);
}


function projectPayload(proj, clientId = '', name = '', bid = '') {
  const items = db.prepare(`
    SELECT id, seq, title, detail, progress, grp, due, owner, status,
           created_at AS createdAt, updated_at AS updatedAt
    FROM items WHERE project_id = ? ORDER BY seq ASC, id ASC
  `).all(proj.id);

  const t = todayStr();
  const histStmt = db.prepare(
    'SELECT at, who, text, field FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 60'
  );
  const imgStmt = db.prepare('SELECT id, file, mime, size FROM images WHERE item_id = ? ORDER BY id ASC');

  for (const it of items) {
    const h = histStmt.all(it.id);
    it.history = h;
    it.images = imgStmt.all(it.id).map((g) => ({
      id: g.id,
      url: `/uploads/${proj.token}/${g.file}`,
      size: g.size
    }));
    // 「今日有变动」：今天动过任何字段都算；但「创建」不算，
    // 否则一天录入十几条，满屏都是标
    it.changedToday = h.some((x) => x.field !== 'create' && x.at.slice(0, 10) === t);
    it.progressToday = h.some((x) => x.field === 'progress' && x.at.slice(0, 10) === t);
  }

  return {
    project: { id: proj.id, name: proj.name, note: proj.note },
    items,
    // 分类：进行中的按手工顺序，全部完成的沉底堆叠
    groups: orderedGroups(proj.id),
    // 以服务器时间为准，避免各人电脑时区不一致导致「今天」不同
    today: t,
    stats: statsOf(proj.id),
    // 当前版本号：前端记住它，轮询时对不上就说明别人改过了
    rev: db.prepare('SELECT rev FROM projects WHERE id = ?').get(proj.id).rev,
    presence: presenceOf(proj.id, clientId, name, bid)
  };
}

function nextName(prefix, usedSet) {
  let i = 1;
  while (usedSet.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

function handleProjectApi(res, tail, method, proj, body, query) {
  /* ---------- /state：轻量轮询 ----------
     只回版本号和在线名单，不回任务数据。别人改过（rev 变了）前端才去整页重拉，
     没人动的时候每 5 秒就这一小段 JSON，内网几乎不占带宽。 */
  if (tail === '/state') {
    if (method !== 'GET') return sendJSON(res, 404, { error: '接口不存在' });
    const clientId = str(query.get('cid'));
    const name = str(query.get('name'));
    return sendJSON(res, 200, {
      rev: curRev(proj.id),
      today: todayStr(),
      presence: presenceOf(proj.id, clientId, name, query.get('bid'))
    });
  }

  /* ---------- /leave：关页面时销号 ----------
     前端用 navigator.sendBeacon 打这个接口，所以它必须接受 POST 且不读 body
     （sendBeacon 的 content-type 是 text/plain，走 readBody 会因为 JSON 解析失败报 400）。 */
  if (tail === '/leave') {
    if (method !== 'POST') return sendJSON(res, 404, { error: '接口不存在' });
    leavePresence(proj.id, str(query.get('cid')));
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- 导出 / 模板下载 / 导入 ---------- */
  if (tail === '/export.xlsx') {
    if (method !== 'GET') return sendJSON(res, 404, { error: '接口不存在' });
    const buf = exportWorkbook(proj);
    return sendDownload(res, buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `${proj.name}-任务清单-${todayStr()}.xlsx`);
  }

  if (tail === '/export.csv') {
    if (method !== 'GET') return sendJSON(res, 404, { error: '接口不存在' });
    const buf = Buffer.from(exportCsv(proj), 'utf8');
    return sendDownload(res, buf, 'text/csv; charset=utf-8', `${proj.name}-任务清单-${todayStr()}.csv`);
  }

  /* 给本地大模型分析的格式：Markdown 好读，JSONL 好程序处理 */
  if (tail === '/export.md') {
    if (method !== 'GET') return sendJSON(res, 404, { error: '接口不存在' });
    const buf = Buffer.from(exportMarkdown(proj), 'utf8');
    return sendDownload(res, buf, 'text/markdown; charset=utf-8', `${proj.name}-任务清单-${todayStr()}.md`);
  }

  if (tail === '/export.jsonl') {
    if (method !== 'GET') return sendJSON(res, 404, { error: '接口不存在' });
    const buf = Buffer.from(exportJsonl(proj), 'utf8');
    return sendDownload(res, buf, 'application/x-ndjson; charset=utf-8', `${proj.name}-任务清单-${todayStr()}.jsonl`);
  }

  if (tail === '/template.xlsx') {
    if (method !== 'GET') return sendJSON(res, 404, { error: '接口不存在' });
    return sendDownload(res, templateWorkbook(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ReqSlate-任务清单-导入模板.xlsx');
  }

  if (tail === '/import') {
    if (method !== 'POST') return sendJSON(res, 404, { error: '接口不存在' });
    // 覆盖模式会清空整个项目，多要一道显式确认，避免误触或脚本手滑
    if (body.mode === 'replace' && body.confirmReplace !== true) {
      return sendJSON(res, 400, { error: '覆盖导入需要二次确认（confirmReplace: true）' });
    }
    const buf = decodeUpload(body);
    const rows = sheetRows(buf);
    return sendJSON(res, 200, importTable(proj, rows, {
      replace: body.mode === 'replace',
      who: body.who
    }));
  }

  /* ---------- /groups/order ---------- */
  if (tail === '/groups/order') {
    if (method !== 'POST') return sendJSON(res, 404, { error: '接口不存在' });
    const order = Array.isArray(body.order) ? body.order.map(str) : [];
    const upd = db.prepare('UPDATE groups SET sort_order = ? WHERE project_id = ? AND name = ?');
    // 未分类的日期桶钉在最上面，前端不传它们；万一传了也跳过，避免被写坏
    order.forEach((name, i) => { if (name && !isUncatName(name)) upd.run(i + 1, proj.id, name); });
    bumpRev(proj.id);
    return sendJSON(res, 200, { ok: true, changed: order.length, rev: curRev(proj.id) });
  }

  /* ---------- /groups：新建 / 改名 / 删除 ---------- */
  if (tail === '/groups') {
    if (method === 'POST') {
      let name = str(body.name);
      if (isUncatName(name)) return sendJSON(res, 400, { error: '「未分类」是系统保留名，不能手工创建' });
      syncGroups(proj.id);

      // 没给名字就自动生成「新建分类N」，N 从已有里挑最小的空位
      if (!name) name = nextName('新建分类', new Set(groupRows(proj.id).map((g) => g.name)));

      const exist = db.prepare('SELECT id FROM groups WHERE project_id = ? AND name = ?').get(proj.id, name);
      if (exist) return sendJSON(res, 200, { ok: true, id: exist.id, name, existed: true });

      // 插到 after 指定分类的后面：把 after 之后的所有分类序号整体后移
      let order;
      const after = str(body.after);
      if (after) {
        const a = db.prepare('SELECT sort_order AS o FROM groups WHERE project_id = ? AND name = ?').get(proj.id, after);
        if (a) {
          order = a.o + 1;
          db.prepare('UPDATE groups SET sort_order = sort_order + 1 WHERE project_id = ? AND sort_order >= ?')
            .run(proj.id, order);
        }
      }
      if (order === undefined) {
        order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM groups WHERE project_id = ?').get(proj.id).m + 1;
      }

      const r = db.prepare('INSERT INTO groups (project_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)')
        .run(proj.id, name, order, now());
      bumpRev(proj.id);
      return sendJSON(res, 200, { ok: true, id: Number(r.lastInsertRowid), name, existed: false, rev: curRev(proj.id) });
    }

    if (method === 'PATCH') {
      const who = str(body.who);
      const from = str(body.from);
      const to = str(body.to);
      if (!to) return sendJSON(res, 400, { error: '分类名称不能为空' });
      if (isUncatName(to)) return sendJSON(res, 400, { error: '「未分类」是系统保留名，不能占用' });
      if (to === from) return sendJSON(res, 200, { ok: true, changed: 0 });

      // 给「未分类」的某个日期桶改名 = 把这个桶扶正成普通分类：
      // 只动这一桶（这一天的）任务，其它日期的桶不受影响
      const fromIsUncat = isUncatName(from);
      const rows = db.prepare('SELECT id, grp, SUBSTR(created_at, 1, 10) AS d FROM items WHERE project_id = ? ORDER BY seq ASC, id ASC').all(proj.id)
        .filter((r) => fromIsUncat
          ? (r.grp || '').trim() === '' && uncatName(r.d) === from
          : (r.grp || '').trim() === from);

      // 改成一个已经存在的分类名 = 两个分类合并。合并时把源分类的任务
      // 接在目标分类现有任务后面（保持它们自己的先后），而不是按原序号插进去，
      // 否则两边都从 1 开始编号，压实时会互相穿插打乱顺序。
      const dup = db.prepare('SELECT id FROM groups WHERE project_id = ? AND name = ?').get(proj.id, to);
      const old = db.prepare('SELECT id FROM groups WHERE project_id = ? AND name = ?').get(proj.id, from);
      const merged = !!dup && rows.length > 0 && !(old && dup.id === old.id);

      const ts = now();
      const upd = db.prepare('UPDATE items SET grp = ?, updated_at = ? WHERE id = ?');
      const seqUpd = db.prepare('UPDATE items SET seq = ? WHERE id = ?');
      const hist = db.prepare(INSERT_HIST);
      let nextSeq = merged
        ? db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM items WHERE project_id = ? AND TRIM(grp) = ?').get(proj.id, to).m
        : 0;
      for (const r of rows) {
        upd.run(to, ts, r.id);
        if (merged) seqUpd.run(++nextSeq, r.id);
        hist.run(r.id, ts, who, `修改了${FIELD_LABEL.grp}：${displayVal('grp', r.grp)} → ${to}`, 'grp');
      }

      if (old) {
        if (dup && dup.id !== old.id) {
          db.prepare('DELETE FROM groups WHERE id = ?').run(old.id);
        } else if (fromIsUncat) {
          // 未分类被扶正：换成普通分类的序号，从此可以拖动
          db.prepare('UPDATE groups SET name = ?, sort_order = ? WHERE id = ?')
            .run(to, nextGroupOrder(proj.id), old.id);
        } else {
          db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(to, old.id);
        }
      } else if (!dup && from) {
        db.prepare('INSERT INTO groups (project_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)')
          .run(proj.id, to, nextGroupOrder(proj.id), ts);
      }
      // 合并两个已有分类后，原来各从 1 开始的序号会撞号，必须重新压实
      if (dup) renumberGroup(proj.id, to);

      if (rows.length || old || dup) bumpRev(proj.id);

      return sendJSON(res, 200, {
        ok: true,
        changed: rows.length,
        merged,
        to,
        // 合并后第一项落在目标分类的哪个位置：前端据此跳过去，接着编辑
        firstId: merged ? rows[0].id : null,
        rev: curRev(proj.id)
      });
    }

    if (method === 'DELETE') {
      const name = str(body.name);
      if (!name) return sendJSON(res, 400, { error: '分类名称不能为空' });
      // 「未分类」的日期桶是系统生成的，删掉会立刻被重建，不该让用户点
      if (isUncatName(name)) return sendJSON(res, 400, { error: '「未分类」不能删除' });
      const n = db.prepare("SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND TRIM(grp) = ?").get(proj.id, name).n;
      if (n > 0) return sendJSON(res, 400, { error: `这个分类下还有 ${n} 项任务，先删任务或移走` });
      db.prepare('DELETE FROM groups WHERE project_id = ? AND name = ?').run(proj.id, name);
      bumpRev(proj.id);
      return sendJSON(res, 200, { ok: true, rev: curRev(proj.id) });
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  }

  /* ---------- /items ---------- */
  const mItem = tail.match(/^\/items(?:\/(\d+)(?:\/(images)(?:\/(\d+))?)?)?$/);
  if (!mItem) return sendJSON(res, 404, { error: '接口不存在' });

  const itemId = mItem[1] ? Number(mItem[1]) : null;
  const isImages = !!mItem[2];
  const imageId = mItem[3] ? Number(mItem[3]) : null;

  // 新增
  if (!itemId && method === 'POST') {
    let title = str(body.title);
    if (body.status !== undefined && !STATUSES.includes(body.status)) {
      return sendJSON(res, 400, { error: '状态不合法' });
    }
    const status = body.status || 'todo';
    const grp = str(body.grp);
    const due = normalizeDue(body.due);
    if (!title && body.title !== undefined) return sendJSON(res, 400, { error: '内容不能为空' });

    // 序号在分类内编：取该分类当前最大序号 + 1。
    // 未分类按「新增那一天」分桶，序号只看今天这一桶。
    const seq = nextSeqFor(proj.id, grp, todayStr());

    // 没给内容就自动起名：统一为「新建任务N」，N 取项目里最小的空位
    if (!title) {
      title = nextName('新建任务',
        new Set(db.prepare("SELECT title FROM items WHERE project_id = ? AND title LIKE '新建任务%'")
          .all(proj.id).map((r) => r.title)));
    }

    const ts = now();
    const r = db.prepare(`
      INSERT INTO items (project_id, seq, title, detail, progress, grp, due, owner, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proj.id, seq, title,
      str(body.detail), str(body.progress), grp,
      due,
      str(body.owner), status, ts, ts
    );

    const newId = Number(r.lastInsertRowid);
    db.prepare(INSERT_HIST).run(newId, ts, str(body.who), `创建任务，初始状态：${STATUS_CN[status]}`, 'create');

    syncGroups(proj.id);
    refreshDoneSince(proj.id);
    bumpRev(proj.id);

    return sendJSON(res, 200, { id: newId, seq, title, rev: curRev(proj.id) });
  }

  // 单条：修改 / 删除
  if (itemId && !isImages) {
    const it = db.prepare('SELECT * FROM items WHERE id = ? AND project_id = ?').get(itemId, proj.id);
    if (!it) return sendJSON(res, 404, { error: '任务不存在' });

    if (method === 'PATCH') {
      const next = {
        title: body.title === undefined ? it.title : str(body.title),
        detail: body.detail === undefined ? it.detail : str(body.detail),
        progress: body.progress === undefined ? it.progress : str(body.progress),
        grp: body.grp === undefined ? it.grp : str(body.grp),
        due: normalizeDue(body.due, it.due),
        owner: body.owner === undefined ? it.owner : str(body.owner),
        status: body.status === undefined ? it.status : body.status
      };

      if (!next.title) return sendJSON(res, 400, { error: '内容不能为空' });
      if (!STATUSES.includes(next.status)) return sendJSON(res, 400, { error: '状态不合法' });

      const changes = [];
      for (const f of ['title', 'detail', 'progress', 'grp', 'due', 'owner', 'status']) {
        if ((it[f] ?? null) !== (next[f] ?? null)) changes.push({ field: f, old: it[f] ?? null, new: next[f] ?? null });
      }

      /* 冲突检测（按字段比）：
         前端带上它读到的旧值 base[f]，如果服务器上这个字段已经不是那个值，
         说明别人先改了同一个字段 —— 拒绝这次写入，把最新的值退回去，
         让用户看着新值再决定怎么改，而不是把别人的修改静默覆盖掉。
         只比「这次要改的字段」，所以甲改进展、乙改负责人可以并存。 */
      const base = body.base && typeof body.base === 'object' ? body.base : null;
      if (base) {
        for (const c of changes) {
          const mine = base[c.field];
          if (mine === undefined) continue;
          /* 空值口径必须统一：完成期限清空后库里存的是 NULL，而前端 input 读到的是空串。
             以前这里拿 null 和 '' 直接比，两者不相等，于是「给一条没有期限的任务补上期限」
             永远被判成「刚被别人改过」，怎么改都改不了。统一按空串比。 */
          if (String(it[c.field] ?? '') !== String(mine ?? '')) {
            return sendJSON(res, 409, {
              error: '这条任务的「' + (FIELD_LABEL[c.field] || c.field) +
                '」刚被别人改过，已帮你刷新成最新内容，请确认后再改一次',
              conflict: true,
              field: c.field,
              item: {
                id: it.id, title: it.title, detail: it.detail, progress: it.progress,
                grp: it.grp, due: it.due, owner: it.owner, status: it.status,
                updatedAt: it.updated_at,
                history: db.prepare('SELECT at, who, text, field FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 60').all(it.id)
              },
              rev: curRev(proj.id)
            });
          }
        }
      }

      // 已完成的条目锁定其它字段：只允许先把状态改回去，再改内容
      if (it.status === 'done' && changes.some((c) => c.field !== 'status')) {
        return sendJSON(res, 409, { error: '已完成的任务不能修改，请先把状态改回进行中或未开始' });
      }

      if (changes.length) {
        const ts = now();
        db.prepare(`
          UPDATE items SET title = ?, detail = ?, progress = ?, grp = ?, due = ?, owner = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(next.title, next.detail, next.progress, next.grp, next.due, next.owner, next.status, ts, itemId);

        // 用同一个时间戳记历史，前端的「我读到的是哪一版」才对得上
        recordHistory(itemId, str(body.who), changes, ts);

        // 换了分类：旧分类要压实序号，新分类追加到末尾。
        // 挪回未分类时，它回到自己「新增那一天」的桶里（created_at 不变）
        const oldGrp = str(it.grp);
        const newGrp = str(next.grp);
        if (oldGrp !== newGrp) {
          const day = String(it.created_at || '').slice(0, 10) || todayStr();
          db.prepare('UPDATE items SET seq = ? WHERE id = ?')
            .run(nextSeqFor(proj.id, newGrp, day), itemId);
          renumberGroup(proj.id, oldGrp);
          renumberGroup(proj.id, newGrp);
          syncGroups(proj.id);
        }
        refreshDoneSince(proj.id);
      }

      if (changes.length) bumpRev(proj.id);

      return sendJSON(res, 200, {
        ok: true,
        changed: changes.length,
        updatedAt: db.prepare('SELECT updated_at FROM items WHERE id = ?').get(itemId).updated_at,
        rev: curRev(proj.id),
        // 让前端在失焦瞬间就能刷新「变更记录」，不必整页重拉
        history: db.prepare('SELECT at, who, text, field FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 60').all(itemId)
      });
    }

    if (method === 'DELETE') {
      for (const g of db.prepare('SELECT file FROM images WHERE item_id = ?').all(itemId)) {
        deleteImageFile(proj.token, g.file);
      }
      db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
      renumberGroup(proj.id, str(it.grp));
      // 最后一条未分类任务删除后，同步清掉虚拟分类占位行
      syncGroups(proj.id);
      refreshDoneSince(proj.id);
      bumpRev(proj.id);
      return sendJSON(res, 200, { ok: true, rev: curRev(proj.id) });
    }

    return sendJSON(res, 404, { error: '接口不存在' });
  }

  // 图片上传
  if (itemId && isImages && !imageId && method === 'POST') {
    const imageItem = db.prepare('SELECT id, status FROM items WHERE id = ? AND project_id = ?').get(itemId, proj.id);
    if (!imageItem) return sendJSON(res, 404, { error: '任务不存在' });
    if (imageItem.status === 'done') {
      return sendJSON(res, 409, { error: '已完成的任务不能修改，请先把状态改回进行中或未开始' });
    }
    try {
      const saved = saveImage(proj.token, itemId, body.dataUrl);
      bumpRev(proj.id);
      return sendJSON(res, 200, {
        id: saved.id,
        url: `/uploads/${proj.token}/${saved.file}`,
        size: saved.size,
        rev: curRev(proj.id)
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // 图片删除
  if (itemId && isImages && imageId && method === 'DELETE') {
    const g = db.prepare(`
      SELECT i.file, t.status FROM images i
      JOIN items t ON t.id = i.item_id
      WHERE i.id = ? AND i.item_id = ? AND t.project_id = ?
    `).get(imageId, itemId, proj.id);
    if (!g) return sendJSON(res, 404, { error: '图片不存在' });
    if (g.status === 'done') {
      return sendJSON(res, 409, { error: '已完成的任务不能修改，请先把状态改回进行中或未开始' });
    }
    deleteImageFile(proj.token, g.file);
    db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
    bumpRev(proj.id);
    return sendJSON(res, 200, { ok: true, rev: curRev(proj.id) });
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

/* ================= 路由 ================= */

const server = http.createServer(async (req, res) => {
  let p = '/';
  let mApi = null;
  const method = req.method;

  try {
    // 不信任 Host：它可能畸形，也可能被反向代理改写；路由只需要原始路径
    const url = new URL(req.url || '/', 'http://localhost');
    p = url.pathname.replace(/\/+$/, '') || '/';

    // 路径解析完成后才能判断是否该读 body，否则登录等接口会被当成 GET 空参数
    mApi = p.match(/^\/api\/p\/([A-Za-z0-9]+)((?:\/items(?:\/\d+(?:\/images(?:\/\d+)?)?)?)|\/groups(?:\/order)?|\/state|\/leave|\/export\.(?:xlsx|csv|md|jsonl)|\/template\.xlsx|\/import)?$/);
    const needBody = ((mApi && !p.endsWith('/leave')) || p === '/api/login' || p.startsWith('/api/projects')) && method !== 'GET';
    const body = needBody ? await readBody(req) : {};

    /* ---------- 健康检查 / 配置 / 静态 ---------- */
    if (method === 'GET' && p === '/healthz') return sendText(res, 200, 'ok');
    // 每次读取，和 README 约定一致：改完 config.json 刷新页面即可生效
    if (method === 'GET' && p === '/api/config') return sendJSON(res, 200, loadConfig());
    if (method === 'GET' && p === '/style.css') return sendPublic(res, 'style.css');
    if (method === 'GET' && p === '/app.js') return sendPublic(res, 'app.js');
    if (method === 'GET' && (p === '/favicon.svg' || p === '/favicon.ico')) {
      return sendPublic(res, 'favicon.svg');
    }

    /* ---------- 图片 ---------- */
    const mImg = method === 'GET' && p.match(/^\/uploads\/([A-Za-z0-9]+)\/([a-f0-9]{20}\.(?:png|jpg|gif|webp))$/);
    if (mImg) {
      return sendImageFile(res, path.join(UPLOAD_DIR, mImg[1], mImg[2]), 'private, max-age=86400');
    }

    /* ---------- 首页 / 登录 ---------- */
    if (method === 'GET' && p === '/') {
      return sendPublic(res, getSession(req) ? 'index.html' : 'login.html');
    }

    if (method === 'POST' && p === '/api/login') {
      const ip = str(req.socket && req.socket.remoteAddress) || 'unknown';
      const lockLeft = loginLockLeft(ip);
      if (lockLeft > 0) {
        const mins = Math.ceil(lockLeft / 60000);
        return sendJSON(res, 429, { error: `密码试错次数太多了，请 ${mins} 分钟后再试` });
      }
      if (!safeEqual(str(body.password), ADMIN_PASSWORD)) {
        noteLoginFail(ip);
        return sendJSON(res, 401, { error: '密码不对' });
      }
      noteLoginOk(ip);
      return sendJSON(res, 200, { ok: true }, {
        'Set-Cookie': `rb_sid=${encodeURIComponent(newSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
      });
    }

    if (method === 'POST' && p === '/api/logout') {
      return sendJSON(res, 200, { ok: true }, {
        'Set-Cookie': 'rb_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
      });
    }

    /* ---------- 项目空间页（凭 token，无需登录） ---------- */
    const mPage = method === 'GET' && p.match(/^\/p\/([A-Za-z0-9]+)$/);
    if (mPage) {
      if (!projByToken(mPage[1])) return sendText(res, 404, '项目不存在或链接已失效', 'text/html; charset=utf-8');
      return sendPublic(res, 'project.html');
    }

    /* ---------- 管理接口（需登录） ---------- */
    if (p.startsWith('/api/projects')) {
      if (!getSession(req)) return sendJSON(res, 401, { error: '请先登录' });

      if (method === 'GET' && p === '/api/projects') {
        const projects = db.prepare(
          'SELECT id, token, name, note, created_at AS createdAt FROM projects ORDER BY id DESC'
        ).all();
        for (const pr of projects) pr.stats = statsOf(pr.id);
        return sendJSON(res, 200, { projects });
      }

      if (method === 'POST' && p === '/api/projects') {
        const name = str(body.name);
        if (!name) return sendJSON(res, 400, { error: '项目名称不能为空' });

        let token = newToken();
        while (db.prepare('SELECT 1 FROM projects WHERE token = ?').get(token)) token = newToken();

        const r = db.prepare('INSERT INTO projects (token, name, note, created_at) VALUES (?, ?, ?, ?)')
          .run(token, name, str(body.note), now());
        return sendJSON(res, 200, { id: Number(r.lastInsertRowid), token });
      }

      const mProj = p.match(/^\/api\/projects\/(\d+)$/);
      if (mProj) {
        const id = Number(mProj[1]);
        const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
        if (!proj) return sendJSON(res, 404, { error: '项目不存在' });

        if (method === 'PATCH') {
          const name = body.name === undefined ? proj.name : str(body.name);
          const note = body.note === undefined ? proj.note : str(body.note);
          if (!name) return sendJSON(res, 400, { error: '项目名称不能为空' });
          db.prepare('UPDATE projects SET name = ?, note = ? WHERE id = ?').run(name, note, id);
          return sendJSON(res, 200, { ok: true });
        }

        if (method === 'DELETE') {
          db.prepare('DELETE FROM projects WHERE id = ?').run(id);
          try { fs.rmSync(path.join(UPLOAD_DIR, proj.token), { recursive: true, force: true }); } catch { }
          return sendJSON(res, 200, { ok: true });
        }
      }
      return sendJSON(res, 404, { error: '接口不存在' });
    }

    /* ---------- 项目内接口（凭 token） ---------- */
    if (mApi) {
      const proj = projByToken(mApi[1]);
      if (!proj) return sendJSON(res, 404, { error: '项目不存在或链接已失效' });
      if (!mApi[2] && method === 'GET') {
        return sendJSON(res, 200, projectPayload(
          proj,
          str(url.searchParams.get('cid')),
          str(url.searchParams.get('name')),
          str(url.searchParams.get('bid'))
        ));
      }
      return handleProjectApi(res, mApi[2] || '', method, proj, body, url.searchParams);
    }

    return sendJSON(res, 404, { error: '页面不存在' });
  } catch (err) {
    // 参数不对（400/409 那些）是用户输入问题，不是服务出故障，
    // 混进日志会让人以为程序挂了，所以只留一行淡淡的提示。
    // 真正的 5xx 才打完整堆栈，方便排查。
    const code = err.statusCode || 500;
    if (code >= 500) {
      console.error('[ERR]', method, p, err.message, err.stack || '');
    } else {
      console.log('[bad]', method, p, code, err.message);
    }
    return sendJSON(res, code, { error: err.message || '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ' + CONFIG.appName + ' 已启动');
  console.log('  ───────────────────────────────');
  console.log('  本机访问： http://127.0.0.1:' + PORT);
  console.log('  数据目录： ' + DATA_DIR);
  console.log('  配置文件： ' + CONFIG_FILE);
  console.log('  管理密码： ' + (process.env.ADMIN_PASSWORD ? '（来自环境变量）' : ADMIN_PASSWORD));
  if (!process.env.ADMIN_PASSWORD && ADMIN_PASSWORD === 'admin123') {
    console.log('');
    console.log('  ⚠ 正在使用默认管理密码 admin123，请改成自己的：');
    console.log('    docker-compose.yml 里改 ADMIN_PASSWORD，或启动前设环境变量。');
  }
  console.log('');
});

/* 端口被占用、没有权限绑定端口这类错误，给一句人话，别只抛一串栈 */
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error('  端口 ' + PORT + ' 已经被别的程序占用了。');
    console.error('  换个端口：PORT=3100 node server.js，或改 docker-compose.yml 里的端口映射。');
    console.error('');
  } else if (e.code === 'EACCES') {
    console.error('');
    console.error('  没有权限绑定端口 ' + PORT + '。1024 以下的端口需要管理员权限，建议换用 3000 以上。');
    console.error('');
  } else {
    console.error('[启动失败]', e.message);
  }
  process.exit(1);
});
