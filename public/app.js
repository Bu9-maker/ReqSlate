'use strict';

const $ = (s) => document.querySelector(s);
const token = location.pathname.split('/')[2];

/* 每个标签页一个身份：在线人数按「谁开着这个页面」算，同一台电脑开两个标签页
   就是两个人。用 sessionStorage，刷新不变、关掉标签页就消失。 */
const clientId = (() => {
  let v = sessionStorage.getItem('rb_cid');
  if (!v) {
    v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    sessionStorage.setItem('rb_cid', v);
  }
  return v;
})();

/* 每个「浏览器」一个身份，存在 localStorage：同一台电脑的所有标签页共用同一个
   browserId，不同电脑一定不同。用它来区分「同一个人开了两个窗口」和
   「两个重名的人」——光看名字这两种情况长得一模一样。 */
const browserId = (() => {
  let v = localStorage.getItem('rb_bid');
  if (!v) {
    v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem('rb_bid', v);
  }
  return v;
})();

let CFG = {
  appName: 'ReqSlate',
  overviewTitle: '项目总览',
  boardTitle: '工作任务清单',
  titleSeparator: ' · ',
  footerText: 'ReqSlate',
  footerSub: 'designed by zhouwh',
  loginHint: '请输入管理密码'
};

let state = {
  project: null,
  items: [],
  groups: [],          // [{name,total,done,allDone,sortOrder,virtual}]
  today: '',
  stats: { total: 0, todo: 0, doing: 0, done: 0, overdue: 0 },
  filter: 'all',
  todayOnly: false,
  owner: ''            // 只看某个负责人，空串=不限
};

const STATUS_TEXT = { todo: '未开始', doing: '进行中', done: '已完成' };
const STATUS_KEYS = ['todo', 'doing', 'done'];
/* 「未分类」按任务的新增日期分桶：10月25日加的任务一直留在「10月25日新增」里，
   过了零点也不会跳到今天那一组、更不会消失。桶名是内部名 未分类@2026-10-25。 */
const UNCAT = '未分类';
const UNCAT_SEP = '@';
const uncatName = (date) => UNCAT + UNCAT_SEP + date;
const uncatDate = (n) => String(n || '').split(UNCAT_SEP)[1] || '';
const isUncatName = (n) => {
  const s = String(n || '');
  return s === UNCAT || s.startsWith(UNCAT + UNCAT_SEP);
};

/* 折叠状态 */
const collapsedGroups = new Set();   // 内容区：手动收起的分类
const expandedGroups = new Set();    // 内容区：手动展开的分类（压过「任务全收起则分类收起」的自动规则）
const navCollapsed = new Set();      // 左侧目录：收起的分类
const collapsedItems = new Set();    // 手动收起的非「已完成」任务
const expandedItems = new Set();     // 手动展开的「已完成」任务
const histOpen = new Set();          // 变更记录展开着的任务
const renamingGroups = new Set();    // 目录里已进入重命名状态的分类
let newGroupPending = '';            // 刚新建的分类：载入后自动进入重命名
let lastGroups = [];                 // 当前内容区实际渲染的分类（含筛选）
let addingItem = false;
let addPanelBusy = false;
let creatingGroup = false;
let activeItemId = null;
let activeGroup = null;
let presence = { count: 0, people: [] };   // 当前页面里有几个人
let serverRev = 0;                          // 我读到的是哪一版
let pollBusy = false;                       // 轮询重入保护
let pendingEdit = null;                     // 正在输入、还没落库的字段，轮询先别重排

/* 轮询间隔。一次请求只有几百字节，内网里 2 秒和 5 秒的差别几乎不影响服务器，
   但「别人改了我多久能看到」是能明显感觉到的，所以取 2.5 秒。 */
const POLL_MS = 2500;

/* 正在输入时把轮询的整页重拉挡一挡：否则别人一改，用户打了一半的字就被冲掉。
   一直打字就一直挡着，停手 3 秒后放行，最多挡 12 秒，避免永远不同步。 */
let editSince = 0;
function markEditing(id, field) {
  pendingEdit = { id, field };
  editSince = editSince || Date.now();
  clearTimeout(markEditing.timer);
  markEditing.timer = setTimeout(() => { pendingEdit = null; editSince = 0; }, 3000);
}

/* ---------------- 小工具 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2200);
}

function today() {
  if (state.today) return state.today;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || ('请求失败 ' + r.status));
    // 冲突响应带着最新的任务内容和版本号，调用方要用它把界面刷成最新
    if (j.conflict) { err.conflict = true; err.field = j.field; err.item = j.item; err.rev = j.rev; }
    throw err;
  }
  return j;
}

function whoami() {
  return localStorage.getItem('rb_name') || '';
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/* 滚动到某个元素：先把它所在分类和它自己展开，再滚 */
function scrollToEl(el, opts = {}) {
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top: Math.max(0, top), behavior: opts.instant ? 'auto' : 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

/* 跳到某条任务，并把高亮钉在它身上：
   平滑滚动过程中「跟随屏幕中线」的探测会不断改写高亮，滚停后再补一次，
   否则用户跳过去看到的却是旁边那条。滚动一停（220ms 无滚动）就交还探测。 */
let jumpPin = null;
let jumpTimer = 0;
function armJumpPin() {
  clearTimeout(jumpTimer);
  jumpTimer = setTimeout(() => {
    const id = jumpPin;
    jumpPin = null;
    // -1 是「只保分类高亮」的哨兵，不是真的任务 id
    if (id !== null && id !== -1) setActive(id, true);
  }, 220);
}
function jumpToItem(id) {
  const el = document.getElementById('it-' + id);
  if (!el) return;
  jumpPin = id;
  activeItemId = id;
  const it = state.items.find((x) => x.id === id);
  if (it) activeGroup = groupOf(it);
  scrollToEl(el);
  armJumpPin();
  paintNavActive();          // 目录也跟着高亮并滚到能看见这条
}

/* 跳到某个分类（新建分类后用）。
   新建的分类下面还没有任务，屏幕中线上压着的是别的分类的任务，
   所以这里要把高亮钉住一小段时间，否则刚跳过去就被中线探测改回上一个分类。 */
let pinGroupUntil = 0;
function jumpToGroup(name) {
  const el = document.querySelector(`.group[data-grp="${CSS.escape(name)}"]`);
  activeItemId = null;
  activeGroup = name;
  pinGroupUntil = Date.now() + 1000;
  if (el) scrollToEl(el);
  paintNavActive();
}

/* ---------------- 统计 ---------------- */

function statsOf(items) {
  const t = today();
  const s = { total: items.length, todo: 0, doing: 0, done: 0, overdue: 0 };
  for (const it of items) {
    if (s[it.status] !== undefined) s[it.status]++;
    if (it.status !== 'done' && it.due && it.due < t) s.overdue++;
  }
  return s;
}

/* ---------------- 渲染：统计卡片 ---------------- */

function renderSummary() {
  const s = state.stats;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const width = (n) => (s.total ? (n / s.total) * 100 : 0);

  const card = (key, label, val, cls) => `
    <div class="metric ${cls} ${state.filter === key ? 'on' : ''}" data-filter="${key}">
      <div class="k">${label}</div><div class="v">${val}</div>
    </div>`;

  $('#summary').innerHTML = `
    <div class="metrics">
      ${card('all', '任务总数', s.total, 'all')}
      ${card('done', '已完成', s.done, 'done')}
      ${card('doing', '进行中', s.doing, 'doing')}
      ${card('todo', '未开始', s.todo, 'todo')}
      ${card('overdue', '已逾期', s.overdue, 'overdue' + (s.overdue ? ' hit' : ''))}
      <div class="metric"><div class="k">完成率</div><div class="v">${pct}%</div></div>
    </div>
    <div class="progress">
      <i class="done" style="width:${width(s.done)}%"></i>
      <i class="doing" style="width:${width(s.doing)}%"></i>
    </div>`;

  $('#summary').querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      const f = el.dataset.filter;
      state.filter = (state.filter === f) ? 'all' : f;
      renderSummary();
      renderItems();
    });
  });
}

/* ---------------- 渲染：任务 ---------------- */

function isOverdue(it) {
  return it.status !== 'done' && !!it.due && it.due < today();
}

function matchFilter(it) {
  if (state.todayOnly && !it.changedToday) return false;
  if (state.owner && (it.owner || '').trim() !== state.owner) return false;
  const f = state.filter;
  if (!f || f === 'all') return true;
  if (f === 'overdue') return isOverdue(it);
  return it.status === f;
}

/* 负责人筛选下拉：选项按现有任务的负责人现算，不写死。
   每次都重建会打断正在展开的下拉框，所以先比一遍有没有变化。 */
function renderOwnerFilter() {
  const sel = $('#f-owner');
  if (!sel) return;
  const names = [...new Set(state.items.map((x) => (x.owner || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

  // 当前选的人如果已经被改掉/删干净了，就退回「全部负责人」
  if (state.owner && !names.includes(state.owner)) state.owner = '';

  const want = JSON.stringify(names) + '|' + state.owner;
  if (sel._sig === want) return;
  sel._sig = want;

  sel.innerHTML = [
    `<option value=""${state.owner ? '' : ' selected'}>全部负责人</option>`,
    ...names.map((n) => `<option value="${esc(n)}"${state.owner === n ? ' selected' : ''}>${esc(n)}</option>`)
  ].join('');
  sel.classList.toggle('on', !!state.owner);
}

/* 日期框下面那行小字：日期本身已经显示在框里了，这里只说「还剩几天」，
   不再重复一遍日期，省一行宽度。 */
function dueTip(it) {
  if (!it.due) return '未设期限';
  if (it.status === 'done') return '已完成';
  const t = today();
  if (it.due < t) return `逾期 ${daysBetween(it.due, t)} 天`;
  const left = daysBetween(t, it.due);
  return left === 0 ? '今天到期' : `剩 ${left} 天`;
}

/* 任务展开状态：已完成默认收起，其它默认展开 */
function isOpen(it) {
  return it.status === 'done' ? expandedItems.has(it.id) : !collapsedItems.has(it.id);
}

/* 未分类的任务按它「新增那一天」分桶，桶名是内部名 未分类@2026-10-25 */
function groupOf(it) {
  const g = (it.grp || '').trim();
  if (g) return g;
  return uncatName(String(it.createdAt || '').slice(0, 10) || today());
}

/* 未分类的桶显示成「10月25日新增」；普通分类就用它自己的名字。 */
function uncatLabel(date) {
  const t = date || today();               // YYYY-MM-DD
  const [, m, d] = t.split('-');
  return `${Number(m)}月${Number(d)}日新增`;
}

function groupLabel(nameOrGroup) {
  if (nameOrGroup && typeof nameOrGroup === 'object') {
    return nameOrGroup.label || (nameOrGroup.virtual ? uncatLabel(nameOrGroup.date) : nameOrGroup.name);
  }
  return isUncatName(nameOrGroup) ? uncatLabel(uncatDate(nameOrGroup)) : nameOrGroup;
}

function badgesHTML(it) {
  const od = isOverdue(it);
  return [
    od ? '<span class="badge overdue">逾期</span>' : '',
    it.changedToday ? '<span class="badge changed">今日有变动</span>' : ''
  ].join('');
}

function historyHTML(it) {
  const h = it.history || [];
  if (!h.length) return '<div class="hempty">暂无记录</div>';
  return h.map((x) => `
    <div class="h">
      <span class="at">${esc(x.at.slice(5, 16))}</span>
      <span class="who">${esc(x.who || '匿名')}</span>
      <span class="fld">${esc(x.text)}</span>
    </div>`).join('');
}

function imagesHTML(it, lock) {
  const imgs = (it.images || []).map((g) => `
    <div class="thumb" data-img="${esc(g.url)}" title="点击放大">
      <img src="${esc(g.url)}" alt="" loading="lazy">
      ${lock ? '' : `<button class="x" data-delimg="${g.id}" title="删除">×</button>`}
    </div>`).join('');

  const adder = lock ? '' : `
      <label class="thumb add" title="上传图片">
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-up="${it.id}" hidden>
        <span>+</span>
      </label>`;

  if (!imgs && !adder) return '';
  return `<div class="fblock">
    <label class="flabel">图片</label>
    <div class="fval"><div class="thumbs">${imgs}${adder}</div></div>
  </div>`;
}

function statusSelect(it) {
  return `<select class="stsel st-${it.status}" data-st="${it.id}" data-id="${it.id}" title="修改状态">
      ${STATUS_KEYS.map((k) =>
        `<option value="${k}"${it.status === k ? ' selected' : ''}>${STATUS_TEXT[k]}</option>`
      ).join('')}
    </select>`;
}

/* 所属分类：下拉框，列出全部已有分类 + 它自己那个未分类日期桶，随时可改 */
function grpSelect(it, dis) {
  const cur = (it.grp || '').trim();
  const names = state.groups.map((g) => g.name).filter((n) => !isUncatName(n));
  if (cur && !names.includes(cur)) names.push(cur);
  names.sort((a, b) => a.localeCompare(b, 'zh'));

  // 未分类选项写它自己那一桶的日期名，挪回来时才知道会落在哪一天
  const ownDay = String(it.createdAt || '').slice(0, 10) || today();
  const opts = [`<option value=""${cur === '' ? ' selected' : ''}>${esc(uncatLabel(ownDay))}</option>`]
    .concat(names.map((n) => `<option value="${esc(n)}"${cur === n ? ' selected' : ''}>${esc(n)}</option>`))
    .join('');

  return `<select class="ie grpsel" data-f="grp" data-id="${it.id}" ${dis} title="修改所属分类">${opts}</select>`;
}

function itemHTML(it) {
  const od = isOverdue(it);
  const done = it.status === 'done';
  const open = isOpen(it);
  const lock = done;

  /* ---------- 收起态：一行 ---------- */
  if (!open) {
    return `
      <div class="item st-${it.status} compact ${od ? 'overdue' : ''}" data-item="${it.id}" id="it-${it.id}">
        <div class="ihead">
          <button class="caret" data-act="toggle" data-id="${it.id}" title="展开">▸</button>
          <span class="seq">${it.seq}</span>
          <span class="ctitle" title="${esc(it.title)}">${esc(it.title)}</span>
          <span class="badges">${badgesHTML(it)}</span>
          <div class="iacts">${statusSelect(it)}</div>
        </div>
      </div>`;
  }

  /* ---------- 展开态 ---------- */
  const ro = lock ? 'readonly' : '';
  const dis = lock ? 'disabled' : '';
  const ho = histOpen.has(it.id);

  return `
    <div class="item st-${it.status} ${od ? 'overdue' : ''}" data-item="${it.id}" id="it-${it.id}">
      <div class="ihead">
        <button class="caret" data-act="toggle" data-id="${it.id}" title="收起">▾</button>
        <span class="seq">${it.seq}</span>
        <textarea class="ie title" rows="1" data-f="title" data-id="${it.id}" ${ro}
          placeholder="请输入任务内容">${esc(it.title)}</textarea>
        <span class="badges">${badgesHTML(it)}</span>
        <div class="iacts">
          ${statusSelect(it)}
          <button class="delx" data-act="del" data-id="${it.id}" title="删除这条任务">删除</button>
        </div>
      </div>

      <div class="ifields">
        ${lock ? '<div class="locked">已完成的任务已锁定。如需修改内容，请先把状态改回「进行中」或「未开始」。</div>' : ''}

        <div class="cols">
          <div class="colL">
            <div class="fblock">
              <label class="flabel">补充说明</label>
              <div class="fval">
                <textarea class="ie" rows="1" data-f="detail" data-id="${it.id}" ${ro}
                  placeholder="请输入补充说明">${esc(it.detail || '')}</textarea>
              </div>
            </div>
            <div class="fblock">
              <label class="flabel">进展情况</label>
              <div class="fval">
                <textarea class="ie prog ${it.progressToday ? 'hit' : ''}" rows="1" data-f="progress" data-id="${it.id}" ${ro}
                  placeholder="请输入进展情况">${esc(it.progress || '')}</textarea>
              </div>
            </div>
            ${imagesHTML(it, lock)}
          </div>
          <div class="colR">
            <div class="fblock">
              <label class="flabel">负责人</label>
              <div class="fval">
                <input type="text" class="ie" data-f="owner" data-id="${it.id}" value="${esc(it.owner || '')}" ${dis} placeholder="请输入负责人">
              </div>
            </div>
            <div class="fblock">
              <label class="flabel">完成期限</label>
              <div class="fval">
                <div class="datewrap">
                  <input type="text" class="ie datein" data-f="due" data-id="${it.id}" value="${esc(it.due || '')}"
                    ${ro} placeholder="年-月-日" maxlength="12" autocomplete="off">
                  <button class="dpbtn" type="button" data-dp-open="${it.id}" ${dis} title="选择日期" aria-label="选择日期">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
                      stroke-linecap="round"><rect x="2.2" y="3.2" width="11.6" height="10.6" rx="2"/><path d="M2.2 6.6h11.6M5.6 1.9v2.5M10.4 1.9v2.5"/></svg>
                  </button>
                </div>
                <span class="duetip ${od ? 'od' : ''}">${esc(dueTip(it))}</span>
              </div>
            </div>
            <div class="fblock">
              <label class="flabel">所属分类</label>
              <div class="fval">${grpSelect(it, dis)}</div>
            </div>
          </div>
        </div>

        <div class="hwrap">
          <button class="linkbtn" data-act="hist" data-id="${it.id}">变更记录（${(it.history || []).length}）</button>
          <div class="hist" ${ho ? '' : 'hidden'}>${historyHTML(it)}</div>
        </div>
      </div>
    </div>`;
}

/* ---------------- 渲染：内容区 ---------------- */

function buildGroups() {
  const map = new Map();
  for (const it of state.items) {
    const g = groupOf(it);
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(it);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.seq - b.seq || a.id - b.id);

  const out = [];
  for (const g of state.groups) {
    out.push({
      name: g.name,
      label: groupLabel(g),
      date: g.date || uncatDate(g.name),
      items: map.get(g.name) || [],
      allDone: !!g.allDone,
      virtual: !!g.virtual || isUncatName(g.name)
    });
    map.delete(g.name);
  }
  for (const [name, items] of map) {
    out.push({
      name,
      label: groupLabel(name),
      date: uncatDate(name),
      items,
      allDone: !isUncatName(name) && items.length > 0 && items.every((x) => x.status === 'done'),
      virtual: isUncatName(name)
    });
  }
  return out;
}

function renderItems() {
  dpClose();   // 重绘会替换掉日期输入框，选择器跟着关掉
  const q = ($('#f-q').value || '').trim().toLowerCase();

  let list = state.items.filter(matchFilter);
  if (q) {
    list = list.filter((x) =>
      ['title', 'detail', 'progress', 'owner', 'grp'].some((f) => (x[f] || '').toLowerCase().includes(q))
    );
  }

  const box = $('#items');
  const keep = new Set(list.map((x) => x.id));
  const plain = !q && !state.todayOnly && !state.owner && (state.filter === 'all' || !state.filter);

  const groups = buildGroups()
    .map((g) => ({ ...g, items: g.items.filter((x) => keep.has(x.id)) }))
    .filter((g) => g.items.length > 0 || plain);
  lastGroups = groups;

  if (!groups.length) {
    box.innerHTML = `<div class="empty-state">${
      state.items.length ? '没有符合筛选条件的任务。' : '还没有任务。点右上角「＋ 新增任务」开始。'
    }</div>`;
    renderNav([]);
    return;
  }

  box.innerHTML = groups.map((g, gi) => {
    const arr = g.items;
    const doneN = arr.filter((x) => x.status === 'done').length;
    const allCollapsed = arr.length > 0 && arr.every((x) => !isOpen(x));
    // 手动展开过的分类，不再因为「任务都收起」而自动收起
    const collapsed = !expandedGroups.has(g.name) && (collapsedGroups.has(g.name) || allCollapsed);

    return `
      <div class="group ${collapsed ? 'collapsed' : ''} ${g.allDone ? 'all-done' : ''} ${g.virtual ? 'is-uncat' : ''}"
           data-grp="${esc(g.name)}" data-gi="${gi}" id="grp-${gi}">
        <div class="ghead">
          ${g.allDone || g.virtual ? '' : '<span class="gdrag" draggable="true" title="按住拖动可调整分类顺序">⠿</span>'}
          <button class="caret" data-gtoggle="${esc(g.name)}" title="${collapsed ? '展开分类' : '收起分类'}">${collapsed ? '▸' : '▾'}</button>
          <input class="gname" data-gname="${esc(g.name)}" value="${esc(g.label)}" title="${g.virtual ? '给这批任务起个分类名，改完就变成普通分类，可以拖动了' : '点击可修改分类名称，该分类下所有任务会一起改'}" maxlength="40">
          <span class="gcount">${arr.length} 项${doneN ? ` · 已完成 ${doneN}` : ''}</span>
          <button class="gadd" data-addgrp="${esc(g.name)}" title="在这个分类下新建任务">＋ 新建任务</button>
        </div>
        <div class="gbody">${arr.map(itemHTML).join('')}</div>
        <button class="gaddfoot" data-addgrp="${esc(g.name)}" title="在这个分类末尾新建任务">＋ 新建任务</button>
      </div>`;
  }).join('');

  bindItemEvents(box);
  bindGroupDrag(box);
  renderNav(groups);
}

/* ---------------- 左侧目录 ---------------- */

/* 目录里分类行的三个图标按钮（重命名 / 删除 / 新建任务），平时隐藏，鼠标移上去才出现 */
const ICON = {
  rename: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.3l2.4 2.4-8.1 8.1-3.2.8.8-3.2 8.1-8.1z"/></svg>',
  del: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 4.3h10.8M6 4.3V2.6h4v1.7M4 4.3l.6 8.2h6.8l.6-8.2M6.6 6.9v3.4M9.4 6.9v3.4"/></svg>',
  add: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2"/></svg>'
};

function renderNav(groups) {
  const nav = $('#navlist');
  if (!groups.length) {
    nav.innerHTML = '<div class="navempty">暂无分类，点下面「＋ 新建分类」开始</div>';
    return;
  }

  if (newGroupPending) {
    renamingGroups.add(newGroupPending);
    newGroupPending = '';
  }

  nav.innerHTML = groups.map((g, gi) => {
    const collapsed = navCollapsed.has(g.name);
    const kids = g.items.map((it) => `
      <div class="navitem st-${it.status} ${activeItemId === it.id ? 'active' : ''}" data-jump="it-${it.id}" data-nid="${it.id}" title="${esc(it.title)}" role="button" tabindex="0">
        ${it.changedToday ? '<span class="ndot" title="今日有变动"></span>' : '<span class="ndot ghost"></span>'}
        <span class="nseq">${it.seq}</span><span class="ntxt">${esc(it.title || '（未填内容）')}</span>
        <span class="navacts">
          <button class="navicon navdel" data-navdelitem="${it.id}" title="删除这条任务" aria-label="删除这条任务">${ICON.del}</button>
        </span>
      </div>`).join('');

    return `
      <div class="navgroup ${collapsed ? 'collapsed' : ''}">
        <div class="navgrp ${activeGroup === g.name ? 'active' : ''}" data-jump="grp-${gi}" data-gname-nav="${esc(g.name)}">
          <span class="caret" data-navtoggle="${esc(g.name)}" title="${collapsed ? '展开' : '收起'}">${collapsed ? '▸' : '▾'}</span>
          ${!renamingGroups.has(g.name)
            ? `<span class="ntxt nstatic">${esc(g.label)}</span>`
            : `<input class="ntxt navname" data-navname="${esc(g.name)}" value="${esc(g.label)}" title="修改分类名称，回车保存，Esc 取消" maxlength="40">`}
          <span class="ncount">${g.items.length}</span>
          <span class="navacts">
            ${renamingGroups.has(g.name) ? '' : `<button class="navicon" data-navrename="${esc(g.name)}" title="重命名分类" aria-label="重命名分类">${ICON.rename}</button>`}
            ${g.virtual ? '' : `<button class="navicon navdel" data-navdel="${esc(g.name)}" title="删除分类" aria-label="删除分类">${ICON.del}</button>`}
            <button class="navicon" data-navadditem="${esc(g.name)}" title="在这个分类下新建任务" aria-label="新建任务">${ICON.add}</button>
          </span>
        </div>
        <div class="navkids">${kids}</div>
      </div>`;
  }).join('');

  /* 目录分类折叠 */
  nav.querySelectorAll('[data-navtoggle]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const g = el.dataset.navtoggle;
      if (navCollapsed.has(g)) navCollapsed.delete(g);
      else navCollapsed.add(g);
      renderNav(lastGroups);
    });
  });

  /* 默认文字不进入编辑；只有点「重命名」才显示输入框 */
  nav.querySelectorAll('[data-navrename]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      renamingGroups.add(btn.dataset.navrename);
      renderNav(lastGroups);
      const inp = nav.querySelector(`input[data-navname="${CSS.escape(btn.dataset.navrename)}"]`);
      if (inp) { inp.focus(); inp.select(); }
    });
  });
  nav.querySelectorAll('input[data-navname]').forEach((inp) => {
    bindGroupRename(inp, inp.dataset.navname, () => inp.value);
  });

  /* 目录分类右边的 ＋：在这个分类下新建一条任务 */
  nav.querySelectorAll('[data-navadditem]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await addItem(btn.dataset.navadditem);
    });
  });

  /* 目录分类右边的垃圾桶：删除分类（分类下还有任务时后端会拒绝） */
  nav.querySelectorAll('[data-navdel]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeGroup(btn.dataset.navdel);
    });
  });

  /* 目录里每条任务右边的垃圾桶：删除这条任务 */
  nav.querySelectorAll('[data-navdelitem]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeItem(Number(btn.dataset.navdelitem));
    });
  });

  /* 跳转 */
  nav.querySelectorAll('[data-jump]').forEach((b) => {
    const go = (e) => {
      if (e.target.closest('input, .caret, .navacts')) return;

      const gname = b.dataset.gnameNav;

      if (gname) {
        /* 点分类：展开该分类（内容区 + 目录），跳到分类头并高亮 */
        expandGroup(gname);
        activeGroup = gname;
        activeItemId = null;
        renderItems();
        scrollToEl(document.querySelector(`.group[data-grp="${CSS.escape(gname)}"]`));
        return;
      }

      /* 点任务：展开它所属分类 + 它自己，跳过去 */
      const nid = Number(b.dataset.nid);
      const it = state.items.find((x) => x.id === nid);
      if (!it) return;

      expandGroup(groupOf(it));
      if (it.status === 'done') expandedItems.add(it.id);
      else collapsedItems.delete(it.id);

      setActive(nid, true);
      renderItems();
      jumpToItem(nid);
    };

    b.addEventListener('click', go);
    // 目录里的任务行现在是 div（里面要放按钮），键盘可达性自己补上
    if (b.getAttribute('role') === 'button') {
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); }
      });
    }
  });
}

/* 展开一个分类（内容区 + 目录），并把其中非已完成任务展开 */
function expandGroup(gname) {
  expandedGroups.add(gname);
  collapsedGroups.delete(gname);
  navCollapsed.delete(gname);
  for (const it of state.items) {
    if (groupOf(it) === gname && it.status !== 'done') collapsedItems.delete(it.id);
  }
}

/* 分类改名（内容区与目录共用） */
function bindGroupRename(inp, from, getVal) {
  let busy = false;
  // 未分类的日期桶在界面上叫「10月25日新增」，名字没被改动时应该什么都不做
  const shownName = isUncatName(from) ? uncatLabel(uncatDate(from)) : from;

  const commit = async () => {
    if (busy) return;
    const to = String(getVal() ?? inp.value).trim();
    if (to === from || to === shownName) {
      // 目录里点了「重命名」又没改就离开：退回普通文字
      if (inp.matches('[data-navname]')) { renamingGroups.delete(from); renderNav(lastGroups); }
      else inp.value = shownName;
      return;
    }
    if (!to) {
      toast('分类名称不能为空');
      inp.value = shownName;
      if (inp.matches('[data-navname]')) { renamingGroups.delete(from); renderNav(lastGroups); }
      return;
    }

    busy = true;
    try {
      const r = await api(`/api/p/${token}/groups`, {
        method: 'PATCH',
        body: JSON.stringify({ from, to, who: whoami() })
      });
      renamingGroups.delete(from);
      // 折叠状态跟着改名迁移（合并到已有分类时，这些状态直接作废）
      if (!r.merged) {
        for (const set of [collapsedGroups, expandedGroups, navCollapsed]) {
          if (set.has(from)) { set.delete(from); set.add(to); }
        }
        if (activeGroup === from) activeGroup = to;
      }

      if (r.merged) {
        // 名字撞上已有分类 = 两个分类合并了。把目标分类展开、滚到刚并进去的第一条，
        // 让用户接着改，而不用自己去那个分类里翻。
        collapsedGroups.delete(to);
        navCollapsed.delete(to);
        expandGroup(to);
        toast(`「${groupLabel(from)}」已并入「${to}」，${r.changed} 条任务接在原有任务后面`);
        await load();
        if (r.firstId) {
          expandedItems.add(r.firstId);
          collapsedItems.delete(r.firstId);
          setActive(r.firstId, true);
          renderItems();
          jumpToItem(r.firstId);
        }
      } else {
        toast(`分类已改为「${to}」，${r.changed} 条任务同步更新`);
        await load();
      }
    } catch (e) {
      toast(e.message);
      inp.value = shownName;
      renamingGroups.delete(from);
      if (inp.matches('[data-navname]')) renderNav(lastGroups);
    } finally {
      busy = false;
    }
  };

  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      inp.value = shownName;
      renamingGroups.delete(from);
      inp.blur();
      if (inp.matches('[data-navname]')) renderNav(lastGroups);
    }
  });
  inp.addEventListener('click', (e) => e.stopPropagation());
}

/* 选中某条任务：更新高亮状态并刷目录 */
function setActive(id, forceGroup) {
  if (id === activeItemId && !forceGroup) return;
  activeItemId = id;
  const it = state.items.find((x) => x.id === id);
  if (it || forceGroup) activeGroup = it ? groupOf(it) : activeGroup;
  paintNavActive();
}

/* 滚动时高亮目录：以屏幕中线为准，取正压在中线上的那条任务 */
let spyTick = false;
function onScrollSpy() {
  // 正在「跳转到某条任务」的平滑滚动途中：先让高亮跟着走，别被中线探测抢走
  if (jumpPin !== null) { armJumpPin(); return; }
  // 刚跳到某个分类，滚动途中先别抢（新分类下面没任务，中线上压的是别人）
  if (Date.now() < pinGroupUntil) return;
  if (spyTick) return;
  spyTick = true;
  requestAnimationFrame(() => {
    spyTick = false;

    const vh = window.innerHeight;
    const mid = vh / 2;
    const els = [...document.querySelectorAll('.item')].filter((el) => el.getClientRects().length);
    if (!els.length) return;

    let cur = null;
    let best = Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;          // 完全在屏幕外的先排除
      // 正压在中线上的优先级最高；否则取离中线最近的那条
      const d = (r.top <= mid && r.bottom >= mid)
        ? 0
        : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < best) {
        best = d;
        cur = el;
        if (d === 0) break;                              // 已经压在中线上，不用再看后面的
      }
    }
    if (!cur) return;

    // 滚到最底下时，强制高亮最后一条
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      cur = els[els.length - 1];
    }

    setActive(Number(cur.dataset.item));
  });
}

/* 只改 class，不重建 DOM，滚动时不闪 */
function paintNavActive() {
  const nav = $('#navlist');
  nav.querySelectorAll('.navitem').forEach((n) => {
    n.classList.toggle('active', Number(n.dataset.nid) === activeItemId);
  });
  nav.querySelectorAll('.navgrp').forEach((n) => {
    n.classList.toggle('active', n.dataset.gnameNav === activeGroup);
  });
  revealInNav();
}

/* 目录是独立滚动的（.sidenav 自己带滚动条），页面往下滚时它不会自己动，
   高亮的那条一旦落到可视区外就看不见了。这里把目录滚到能看见高亮项为止。 */
let revealAt = 0;
function revealInNav() {
  const box = $('.sidenav');
  if (!box) return;
  // 平滑滚动还没停就别再发指令，否则每帧都重启动画，看起来是卡住的
  if (Date.now() - revealAt < 260) return;

  const nav = $('#navlist');
  const cur = nav.querySelector('.navitem.active') || nav.querySelector('.navgrp.active');
  if (!cur) return;

  const b = box.getBoundingClientRect();
  const r = cur.getBoundingClientRect();
  if (!r.height) return;                       // 所在分类是收起的，没得滚

  const pad = 10;
  if (r.top >= b.top + pad && r.bottom <= b.bottom - pad) return;

  // 目标是让高亮项落在目录可视区的正中间，滚到头时自然夹住
  const top = r.top - b.top + box.scrollTop - (box.clientHeight - r.height) / 2;
  box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  revealAt = Date.now();
}

/* ---------------- 事件绑定：任务 ---------------- */

function bindItemEvents(box) {
  /* 分类折叠：任何分类都能展开/收起（包括全部完成的） */
  box.querySelectorAll('[data-gtoggle]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const g = el.dataset.gtoggle;
      const arr = state.items.filter((x) => groupOf(x) === g);
      const allCollapsed = arr.length > 0 && arr.every((x) => !isOpen(x));
      const isCollapsed = !expandedGroups.has(g) && (collapsedGroups.has(g) || allCollapsed);

      if (isCollapsed) {
        expandedGroups.add(g);
        collapsedGroups.delete(g);
        for (const it of arr) if (it.status !== 'done') collapsedItems.delete(it.id);
      } else {
        collapsedGroups.add(g);
        expandedGroups.delete(g);
      }
      renderItems();
    });
  });

  /* 分类内新建任务（头部按钮 + 底部按钮，都直接建） */
  box.querySelectorAll('[data-addgrp]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await addItem(el.dataset.addgrp);
    });
  });

  /* 分类改名 */
  box.querySelectorAll('input[data-gname]').forEach((inp) => {
    bindGroupRename(inp, inp.dataset.gname, () => inp.value);
  });

  /* 动作按钮 */
  box.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onAction(b.dataset.act, Number(b.dataset.id));
    });
  });

  /* 下拉框（状态）：统一走 PATCH + 重载 */
  const onSelect = (sel, build, msg) => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.id);
      const it = state.items.find((x) => x.id === id);
      const body = build(sel.value);
      if (!body) return;
      // base 只带这次改的那个字段的旧值，别人改别的字段不会被误判成冲突
      const field = Object.keys(body)[0];
      const base = it ? { [field]: it[field] ?? null } : undefined;
      try {
        const r = await api(`/api/p/${token}/items/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...body, base, who: whoami() })
        });
        if (typeof r.rev === 'number') serverRev = r.rev;
        toast(typeof msg === 'function' ? msg(sel.value) : msg);
        await load();
      } catch (e) {
        toast(e.message);
        await load();
      }
    });
  };

  box.querySelectorAll('select[data-st]').forEach((sel) =>
    onSelect(sel, (v) => ({ status: v }), () => '状态已改为「' + STATUS_TEXT[sel.value] + '」'));

  box.querySelectorAll('select.grpsel').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.id);
      const it = state.items.find((x) => x.id === id);
      const from = it ? (it.grp || '') : '';
      const to = sel.value;
      if (to === from) return;                 // 没动就不发请求

      // 挪回未分类时，它会回到自己「新增那一天」的桶里，展开的应该是那一桶
      const target = to || uncatName(String(it && it.createdAt || '').slice(0, 10) || today());

      try {
        const r = await api(`/api/p/${token}/items/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ grp: to, base: { grp: from }, who: whoami() })
        });
        if (typeof r.rev === 'number') serverRev = r.rev;
        // 任务换了分类：把新分类和它自己都展开，然后跳过去并高亮，
        // 否则它会跑到别的分组里，用户还得自己找
        expandGroup(target);
        expandedGroups.add(target);
        if (it && it.status === 'done') expandedItems.add(id);
        else collapsedItems.delete(id);
        activeItemId = id;
        activeGroup = target;
        toast('已移动到「' + groupLabel(target) + '」');
        await load();
        setActive(id, true);
        renderItems();
        jumpToItem(id);
      } catch (e) {
        toast(e.message);
        await load();
      }
    });
  });

  /* 内联编辑：只在「输入完、点到外面」时保存并记一条变更 */
  box.querySelectorAll('textarea.ie, input.ie').forEach((el) => {
    if (el.tagName === 'TEXTAREA') autoGrow(el);
    if (el.readOnly || el.disabled) return;

    const field = el.dataset.f;
    if (!field) return;

    let saved = el.value;          // 上次落库的值
    let pending = false;           // 有没有改过但还没存

    el.addEventListener('input', () => {
      if (el.tagName === 'TEXTAREA') autoGrow(el);
      if (el.value !== saved) { pending = true; markEditing(Number(el.dataset.id), field); }
    });

    const commit = () => {
      if (!pending) return;
      pending = false;
      pendingEdit = null;
      editSince = 0;
      clearTimeout(markEditing.timer);

      // 日期：允许 2026-1-2 / 2026/1/2 / 2026.1.2 / 2026年1月2日 / 20260102，统一成 YYYY-MM-DD
      if (field === 'due') {
        const v = parseDate(el.value);
        if (v === null) {
          toast('日期格式不对，请用 2026-12-02 这样写');
          el.value = saved;
          return;
        }
        el.value = v;
        if (v === saved) return;
        const old = saved;
        saved = v;
        saveField(Number(el.dataset.id), field, v, old);
        return;
      }

      const v = el.value;
      if (v === saved) return;
      const old = saved;
      saved = v;
      saveField(Number(el.dataset.id), field, v, old);
    };

    el.addEventListener('blur', commit);
    el._commit = commit;                    // 日期选择器等外部组件可以直接提交
    el._mark = () => { pending = true; };   // 程序改值不会触发 input，得手动标脏

    el.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+Enter 手动提交并失焦
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el.blur(); }
    });
  });

  /* 日期：点日历按钮打开自绘选择器 */
  box.querySelectorAll('[data-dp-open]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const inp = btn.closest('.fblock').querySelector('input[data-f="due"]');
      if (!inp) return;
      if (dp.input === inp) { dpClose(); return; }
      dpOpen(inp);
    });
  });

  /* 图片放大 */
  box.querySelectorAll('.thumb[data-img]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-delimg]')) return;
      $('#lbimg').src = el.dataset.img;
      $('#lightbox').classList.add('on');
    });
  });

  /* 删图 */
  box.querySelectorAll('[data-delimg]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const itemId = Number(el.closest('.item').dataset.item);
      if (!confirm('删除这张图片？')) return;
      try {
        await api(`/api/p/${token}/items/${itemId}/images/${el.dataset.delimg}`, { method: 'DELETE' });
        toast('已删除');
        await load();
      } catch (err) { toast(err.message); }
    });
  });

  /* 上传 */
  box.querySelectorAll('[data-up]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('单张图片不能超过 8MB'); inp.value = ''; return; }
      const itemId = Number(inp.dataset.up);
      try {
        const dataUrl = await fileToDataURL(f);
        await api(`/api/p/${token}/items/${itemId}/images`, {
          method: 'POST',
          body: JSON.stringify({ dataUrl })
        });
        toast('图片已上传');
        await load();
      } catch (err) {
        toast(err.message);
      } finally {
        inp.value = '';
      }
    });
  });
}

/* 分类拖动排序（「未分类」钉在最上面，不参与拖动） */
function bindGroupDrag(box) {
  let dragName = null;

  box.querySelectorAll('.group:not(.all-done):not(.is-uncat) .ghead').forEach((head) => {
    const group = head.closest('.group');
    const name = group.dataset.grp;

    head.addEventListener('dragstart', (e) => {
      dragName = name;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', name); } catch { }
      group.classList.add('dragging');
    });
    head.addEventListener('dragend', () => {
      dragName = null;
      box.querySelectorAll('.group').forEach((g) => g.classList.remove('dragging', 'dropbefore', 'dropafter'));
    });
    head.addEventListener('dragover', (e) => {
      if (!dragName || dragName === name) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = dropAfter(head, e);
      group.classList.toggle('dropbefore', !after);
      group.classList.toggle('dropafter', after);
    });
    head.addEventListener('dragleave', () => {
      group.classList.remove('dropbefore', 'dropafter');
    });
    head.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragName || dragName === name) return;
      const after = dropAfter(head, e);

      // 拖动时可能正处在筛选状态，隐藏的分类也要保留在完整顺序里，否则会被写坏。
      // 未分类的日期桶固定在最上面，不参与排序，所以这里把它们排除掉。
      const allActive = state.groups
        .filter((g) => !g.allDone && !isUncatName(g.name))
        .map((g) => g.name);
      const allDone = state.groups.filter((g) => g.allDone).map((g) => g.name);
      const active = allActive.slice();
      const from = active.indexOf(dragName);
      if (from < 0) return;
      active.splice(from, 1);
      let to = active.indexOf(name);
      if (to < 0) return;
      active.splice(after ? to + 1 : to, 0, dragName);
      const order = active.concat(allDone);
      try {
        await api(`/api/p/${token}/groups/order`, {
          method: 'POST',
          body: JSON.stringify({ order })
        });
        await load();
      } catch (err) { toast(err.message); }
    });
  });
}

/* 拖放落点：指针在分类头下半部时算「放到它后面」 */
function dropAfter(head, e) {
  const r = head.getBoundingClientRect();
  return (e.clientY - r.top) > r.height / 2;
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/* ---------------- 新建任务：直接生成一条，标题自动起名 ---------------- */

/* 新建之前先把筛选清掉。
   否则用户正筛着「已完成」去点「＋新建任务」，新建的是一条「未开始」，
   立刻被筛掉，界面上什么都看不到，像没建成功一样。
   清完还要把「任务总数」这张卡片重新点亮（filter 回到 all）。 */
function clearFilters() {
  const had = state.filter !== 'all' || state.todayOnly || state.owner || ($('#f-q').value || '').trim();
  state.filter = 'all';
  state.todayOnly = false;
  state.owner = '';
  $('#f-q').value = '';
  $('#f-today').classList.remove('on');
  const sel = $('#f-owner');
  if (sel) { sel._sig = ''; renderOwnerFilter(); }
  renderSummary();
  return !!had;
}

async function addItem(grpName) {
  if (addingItem) return;
  addingItem = true;
  const grp = (!grpName || isUncatName(grpName)) ? '' : grpName;
  // 未分类的新任务会落到「今天」这一桶
  const target = grp || uncatName(today());
  try {
    const r = await api(`/api/p/${token}/items`, {
      method: 'POST',
      body: JSON.stringify({ grp, who: whoami() })
    });

    clearFilters();
    expandGroup(target);
    await load();

    // 新任务展开、滚动到它，并把标题选中，直接就能改
    const it = state.items.find((x) => x.id === r.id);
    if (it) {
      if (it.status === 'done') expandedItems.add(it.id);
      else collapsedItems.delete(it.id);
      activeItemId = it.id;
      activeGroup = groupOf(it);
      renderItems();
      const el = document.getElementById('it-' + r.id);
      scrollToEl(el);
      paintNavActive();          // 目录高亮到这条，并把目录滚到能看见它
      const ta = el && el.querySelector('textarea[data-f="title"]');
      if (ta) { ta.focus(); ta.select(); }
    }
    toast('已新建「' + (r.title || '') + '」');
  } catch (e) {
    toast(e.message);
  } finally {
    addingItem = false;
  }
}

/* ---------------- 删除任务（内容区的「删除」和目录里的垃圾桶共用） ---------------- */

async function removeItem(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  const name = it.title || '这条任务';
  if (!confirm(`删除任务「${name}」？删除后无法恢复。`)) return;

  try {
    await api(`/api/p/${token}/items/${id}`, { method: 'DELETE' });
    // 删掉的可能正是当前高亮的那条
    if (activeItemId === id) { activeItemId = null; activeGroup = null; }
    collapsedItems.delete(id);
    expandedItems.delete(id);
    histOpen.delete(id);
    toast('已删除');
    await load();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 删除分类 ---------------- */

async function removeGroup(name) {
  // 未分类的日期桶是系统按任务新增日期自动生成的，删了也会立刻重建
  if (!name || isUncatName(name)) return;
  const n = state.items.filter((x) => groupOf(x) === name).length;
  if (n > 0) {
    toast(`「${name}」下还有 ${n} 项任务，先把任务删掉或移走`);
    return;
  }
  if (!confirm(`删除分类「${name}」？这个分类是空的，删除后无法恢复。`)) return;

  try {
    await api(`/api/p/${token}/groups`, { method: 'DELETE', body: JSON.stringify({ name }) });
    for (const set of [collapsedGroups, expandedGroups, navCollapsed, renamingGroups]) set.delete(name);
    if (activeGroup === name) activeGroup = '';
    toast(`已删除分类「${name}」`);
    await load();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------------- 动作 ---------------- */

function onAction(act, id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;

  if (act === 'toggle') {
    if (isOpen(it)) {
      if (it.status === 'done') expandedItems.delete(id);
      else collapsedItems.add(id);
    } else {
      if (it.status === 'done') expandedItems.add(id);
      else collapsedItems.delete(id);
    }
    return renderItems();
  }

  if (act === 'hist') {
    const wrap = document.querySelector(`.item[data-item="${id}"] .hist`);
    if (!wrap) return;
    wrap.hidden = !wrap.hidden;
    if (wrap.hidden) histOpen.delete(id); else histOpen.add(id);
    return;
  }

  if (act === 'del') {
    removeItem(id);
  }
}

/* ---------------- 日期选择器（自绘，全中文，禁滚轮） ---------------- */

const dp = {
  el: null, input: null, view: ''         // view = 'YYYY-MM'
};

const pad2 = (n) => String(n).padStart(2, '0');

/* 把用户输入的日期串规整成 YYYY-MM-DD；空串表示清空；非法返回 null */
function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/) || s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

function dpRender() {
  const [y, m] = dp.view.split('-').map(Number);
  $('#dp-ym').textContent = `${y} 年 ${m} 月`;

  const first = new Date(y, m - 1, 1);
  const startPad = first.getDay();                 // 周日开头
  const days = new Date(y, m, 0).getDate();
  const prevDays = new Date(y, m - 1, 0).getDate();
  const cur = dp.input ? dp.input.value : '';
  const t = today();

  const cells = [];
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  for (let i = startPad - 1; i >= 0; i--) {
    cells.push(`<button type="button" class="dpd out" data-dpd="${py}-${pad2(pm)}-${pad2(prevDays - i)}">${prevDays - i}</button>`);
  }
  for (let d = 1; d <= days; d++) {
    const v = `${y}-${pad2(m)}-${pad2(d)}`;
    const cls = ['dpd'];
    if (v === cur) cls.push('on');
    if (v === t) cls.push('today');
    cells.push(`<button type="button" class="${cls.join(' ')}" data-dpd="${v}">${d}</button>`);
  }
  const tail = (7 - ((startPad + days) % 7)) % 7;
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  for (let i = 1; i <= tail; i++) {
    cells.push(`<button type="button" class="dpd out" data-dpd="${ny}-${pad2(nm)}-${pad2(i)}">${i}</button>`);
  }
  $('#dp-grid').innerHTML = cells.join('');
}

function dpPlace() {
  const el = dp.el, inp = dp.input;
  if (!el || !inp) return;
  // 输入框被滚动出视口（比如上面的卡片收起了）：直接关掉，别让日历飘在别处
  const r = inp.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) { dpClose(); return; }

  const w = el.offsetWidth || 268;
  const h = el.offsetHeight || 300;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  let top = r.bottom + 6;
  // 下面放不开就翻到上面；上下都放不开就贴边，至少保证整块可见
  if (top + h > window.innerHeight - 8) {
    const up = r.top - h - 6;
    top = up >= 8 ? up : Math.max(8, window.innerHeight - h - 8);
  }
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = top + 'px';
}

function dpOpen(input) {
  const el = $('#dpicker');
  dp.el = el;
  dp.input = input;

  const base = parseDate(input.value) || today();
  dp.view = base.slice(0, 7);

  el.hidden = false;
  dpRender();
  dpPlace();
  requestAnimationFrame(dpPlace);
}

function dpClose() {
  if (!dp.el) return;
  dp.el.hidden = true;
  dp.el = null;
  dp.input = null;
}

function dpCommit(v) {
  const inp = dp.input;
  if (!inp) return;
  dpClose();
  if (inp.value === v) return;
  inp.value = v;
  if (inp._mark) inp._mark();
  if (inp._commit) inp._commit();
}

$('#dpicker').addEventListener('mousedown', (e) => e.preventDefault());   // 不抢焦点，避免先触发 blur 提交

$('#dpicker').addEventListener('click', (e) => {
  const nav = e.target.closest('[data-dp]');
  if (nav) {
    const act = nav.dataset.dp;
    if (act === 'today') { dpCommit(today()); return; }
    if (act === 'clear') { dpCommit(''); return; }
    const [y, m] = dp.view.split('-').map(Number);
    const d = new Date(y, m - 1 + (act === 'prev' ? -1 : 1), 1);
    dp.view = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    dpRender();
    return;
  }
  const cell = e.target.closest('[data-dpd]');
  if (cell) dpCommit(cell.dataset.dpd);
});

/* 鼠标滚轮：既不翻月，也不让页面跟着滚 */
$('#dpicker').addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
}, { passive: false });

window.addEventListener('scroll', dpClose, { passive: true });
window.addEventListener('resize', dpClose);

/* 点到别处就关掉 */
document.addEventListener('mousedown', (e) => {
  if (!dp.el) return;
  if (dp.el.contains(e.target)) return;
  if (e.target.closest && e.target.closest('[data-dp-open]')) return;
  if (dp.input && e.target === dp.input) return;
  dpClose();
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dp.el) { e.stopPropagation(); dpClose(); }
}, true);

/* 内联保存：只在失焦时调用一次，不整页重绘 */
async function saveField(id, field, value, oldValue) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;

  // 与后端一致：文本字段去首尾空格，日期空值按 null 处理
  const next = field === 'due' ? (value || null) : String(value ?? '').trim();
  if (String(it[field] ?? '') === String(next ?? '')) return;

  // base = 我看到的旧值。后端拿它和库里的比，对不上说明别人先改了同一个字段
  const base = oldValue === undefined ? undefined : { [field]: oldValue };

  try {
    const r = await api(`/api/p/${token}/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: next, base, who: whoami() })
    });

    const cur = state.items.find((x) => x.id === id) || it;
    cur[field] = next;

    // 状态、分类会改变分组与序号，必须整页重排
    if (field === 'status' || field === 'grp') { await load(); return; }

    if (r.changed > 0 && Array.isArray(r.history)) {
      cur.history = r.history;
      cur.changedToday = true;
      if (field === 'progress') cur.progressToday = true;
    }
    if (typeof r.rev === 'number') serverRev = r.rev;

    state.stats = statsOf(state.items);
    renderSummary();
    refreshItemChrome(cur);

    if (field === 'title') {
      const navBtn = document.querySelector(`.navitem[data-nid="${cur.id}"] .ntxt`);
      if (navBtn) navBtn.textContent = cur.title || '（未填内容）';
      const ct = document.querySelector(`.item[data-item="${cur.id}"] .ctitle`);
      if (ct) { ct.textContent = cur.title; ct.title = cur.title; }
    }
  } catch (e) {
    // 409 + conflict：别人先改了同一个字段。后端已经把最新值退回来，
    // 这里把界面刷成最新的，让用户看着新内容再决定要不要重改。
    if (e.conflict && e.item) {
      const cur = state.items.find((x) => x.id === id);
      if (cur) Object.assign(cur, e.item);
      if (typeof e.rev === 'number') serverRev = e.rev;
      state.stats = statsOf(state.items);
      renderSummary();
      renderItems();
      toast(e.message);
      return;
    }
    toast(e.message);
    try { await load(); } catch { /* 网络也断了就保留当前画面 */ }
  }
}

function refreshItemChrome(it) {
  const el = document.querySelector(`.item[data-item="${it.id}"]`);
  if (!el) return;

  const btn = el.querySelector('[data-act=hist]');
  if (btn) btn.textContent = `变更记录（${(it.history || []).length}）`;

  const hb = el.querySelector('.hist');
  if (hb) hb.innerHTML = historyHTML(it);

  const bs = el.querySelector('.badges');
  if (bs) bs.innerHTML = badgesHTML(it);

  const tip = el.querySelector('.duetip');
  if (tip) {
    tip.textContent = dueTip(it);
    tip.classList.toggle('od', isOverdue(it));
  }
  const prog = el.querySelector('textarea[data-f="progress"]');
  if (prog) prog.classList.toggle('hit', !!it.progressToday);
  el.classList.toggle('overdue', isOverdue(it));

  // 目录里的「今日有变动」小圆点也要立刻跟上，不必等整页重载
  const dot = document.querySelector(`.navitem[data-nid="${it.id}"] .ndot`);
  if (dot) {
    dot.classList.toggle('ghost', !it.changedToday);
    dot.title = it.changedToday ? '今日有变动' : '';
  }
}

/* ---------------- 顶部新增任务：弹表单，分类名与任务内容都预填 ---------------- */

function nextName(prefix, existing) {
  let i = 1;
  while (existing.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

function syncAddGroupInput() {
  const custom = $('#a-grp').value === '__new__';
  $('#a-grp-new').style.display = custom ? '' : 'none';
  if (custom) $('#a-grp-new').focus();
}

function openAddPanel() {
  const groups = state.groups.filter((g) => !g.virtual);
  const names = new Set(groups.map((g) => g.name));
  const autoName = nextName('新建分类', names);
  // 默认落在「未分类」（也就是今天日期那个分类），想归到别处再改
  $('#a-grp').innerHTML = [
    `<option value="" selected>${esc(uncatLabel())}</option>`,
    ...groups.map((g) => `<option value="${esc(g.name)}">${esc(g.name)}</option>`),
    '<option value="__new__">＋ 新建分类</option>'
  ].join('');
  $('#a-grp-new').value = autoName;
  $('#a-grp-new').style.display = 'none';
  $('#a-title').value = nextName('新建任务', new Set(state.items.map((x) => x.title || '')));
  $('#addpanel').style.display = '';
  $('#a-title').focus();
  $('#a-title').select();
}

function closeAddPanel() {
  $('#addpanel').style.display = 'none';
}

async function submitAddPanel() {
  if (addPanelBusy) return;
  const grp = ($('#a-grp').value === '__new__' ? $('#a-grp-new').value : $('#a-grp').value || '').trim();
  const title = ($('#a-title').value || '').trim();
  if ($('#a-grp').value === '__new__' && !grp) { toast('请输入新分类名称'); $('#a-grp-new').focus(); return; }
  if (isUncatName(grp)) { toast('「未分类」是系统分类，不能手工新建'); $('#a-grp-new').focus(); return; }
  if (!title) { toast('任务内容不能为空'); $('#a-title').focus(); return; }

  addPanelBusy = true;
  $('#a-save').disabled = true;
  try {
    if (grp && !state.groups.some((g) => !g.virtual && g.name === grp)) {
      await api(`/api/p/${token}/groups`, { method: 'POST', body: JSON.stringify({ name: grp }) });
    }
    const r = await api(`/api/p/${token}/items`, {
      method: 'POST',
      body: JSON.stringify({ grp, title, who: whoami() })
    });

    closeAddPanel();
    clearFilters();
    expandGroup(grp || uncatName(today()));

    await load();
    setActive(r.id, true);
    renderItems();
    jumpToItem(r.id);
    toast('已新建「' + (r.title || title) + '」');
  } catch (e) {
    toast(e.message);
  } finally {
    addPanelBusy = false;
    $('#a-save').disabled = false;
  }
}

const addPanelKeys = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitAddPanel(); }
  if (e.key === 'Escape') closeAddPanel();
};

$('#addItem').addEventListener('click', () => {
  if ($('#addpanel').style.display === 'none') openAddPanel();
  else closeAddPanel();
});
$('#a-save').addEventListener('click', submitAddPanel);
$('#a-cancel').addEventListener('click', closeAddPanel);
$('#a-title').addEventListener('keydown', addPanelKeys);
$('#a-grp-new').addEventListener('keydown', addPanelKeys);
$('#a-grp').addEventListener('change', syncAddGroupInput);
$('#a-grp').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAddPanel(); });

/* 新建一个分类，名字自动为「新建分类N」，建完直接把光标落到名字上 */
async function createGroup() {
  if (creatingGroup) return;
  creatingGroup = true;
  try {
    const r = await api(`/api/p/${token}/groups`, { method: 'POST', body: JSON.stringify({}) });

    clearFilters();
    newGroupPending = r.name;
    expandGroup(r.name);
    await load();
    toast(`已新建「${r.name}」，名称已选中，输入新名字后回车保存`);

    // 跳到这个分类：内容区滚到分类头并高亮，目录也高亮到它
    renderItems();
    jumpToGroup(r.name);

    const inp = document.querySelector(`#navlist input[data-navname="${CSS.escape(r.name)}"]`);
    if (inp) { inp.focus(); inp.select(); }
  } catch (e) {
    toast(e.message);
  } finally {
    creatingGroup = false;
  }
}

$('#navAddGrp').addEventListener('click', createGroup);

/* ---------------- 导入 / 导出 ----------------
   导出直接走浏览器的下载，不需要前端读文件；导入要先把文件读成 base64
   再 POST 上去 —— 内网没有大文件，一个表单就够，不必上 multipart。 */

function downloadUrl(path) {
  // 用 a[download] 而不是 location.href：出错时不会把当前页面顶掉
  const a = document.createElement('a');
  a.href = path;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function closeXportMenu() {
  const menu = $('#xportMenu');
  if (menu) menu.hidden = true;
}

function openImportModal() {
  $('#impModal').hidden = false;
  $('#impRes').hidden = true;
  $('#impRes').innerHTML = '';
  $('#impFile').value = '';
  $('#impPick').textContent = '点击选择文件，或把文件拖到这里';
  $('#impGo').disabled = true;
  document.querySelector('input[name="impmode"][value="append"]').checked = true;
  $('#impReplaceWarn').hidden = true;
}

function closeImportModal() {
  $('#impModal').hidden = true;
}

function setPickedFile(file) {
  if (!file) return;
  if (!/\.(xlsx|csv)$/i.test(file.name)) {
    toast('只能导入 .xlsx 或 .csv 文件');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast('文件太大，请控制在 8MB 以内');
    return;
  }
  pickedFile = file;
  $('#impPick').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
  $('#impGo').disabled = false;
}

let pickedFile = null;

async function doImport() {
  if (!pickedFile || $('#impGo').disabled) return;
  const mode = document.querySelector('input[name="impmode"]:checked').value;

  // 覆盖是破坏性操作，前端先弹一次确认；接口那边也会要 confirmReplace
  if (mode === 'replace') {
    const yes = confirm('覆盖导入会删掉当前项目里的全部任务、分类和变更记录，只保留表格里的内容，且无法撤销。\n\n确定继续吗？');
    if (!yes) return;
  }

  $('#impGo').disabled = true;
  $('#impGo').textContent = '正在导入…';
  try {
    const dataUrl = await fileToDataURL(pickedFile);
    const r = await api(`/api/p/${token}/import`, {
      method: 'POST',
      body: JSON.stringify({ dataUrl, mode, confirmReplace: mode === 'replace', who: whoami() })
    });

    const box = $('#impRes');
    box.hidden = false;
    const warn = Array.isArray(r.warnings) && r.warnings.length
      ? `<div class="mreswarn"><b>有 ${r.warnings.length} 处需要留意：</b><ul>${
          r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
      : '';
    const skipped = r.skipped ? `，跳过 ${r.skipped} 行空内容` : '';
    box.innerHTML =
      `<div class="mresok">导入完成：新增 ${r.created} 条任务${skipped}${r.replaced ? '（原有任务已清空）' : ''}。</div>` +
      (r.newGroups && r.newGroups.length ? `<div class="mresline">新建分类：${r.newGroups.map(esc).join('、')}</div>` : '') +
      warn;

    clearFilters();
    await load();
    toast(`已导入 ${r.created} 条任务`);
  } catch (e) {
    const box = $('#impRes');
    box.hidden = false;
    box.innerHTML = `<div class="mreserr">导入失败：${esc(e.message)}</div>`;
  } finally {
    $('#impGo').textContent = '开始导入';
    $('#impGo').disabled = !pickedFile;
  }
}

$('#xportBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#xportMenu');
  menu.hidden = !menu.hidden;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.xport')) closeXportMenu();
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-xp]');
  if (!b) return;
  const what = b.dataset.xp;
  closeXportMenu();
  if (what === 'xlsx') downloadUrl(`/api/p/${token}/export.xlsx`);
  else if (what === 'csv') downloadUrl(`/api/p/${token}/export.csv`);
  else if (what === 'md') downloadUrl(`/api/p/${token}/export.md`);
  else if (what === 'jsonl') downloadUrl(`/api/p/${token}/export.jsonl`);
  else if (what === 'tpl') downloadUrl(`/api/p/${token}/template.xlsx`);
  else if (what === 'import') openImportModal();
});

$('#impClose').addEventListener('click', closeImportModal);
$('#impCancel').addEventListener('click', closeImportModal);
$('#impGo').addEventListener('click', doImport);
$('#impFile').addEventListener('change', (e) => setPickedFile(e.target.files && e.target.files[0]));

$('#impDrop').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#impDrop').classList.add('over');
});
$('#impDrop').addEventListener('dragleave', () => $('#impDrop').classList.remove('over'));
$('#impDrop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#impDrop').classList.remove('over');
  setPickedFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

document.querySelectorAll('input[name="impmode"]').forEach((r) => {
  r.addEventListener('change', () => {
    $('#impReplaceWarn').hidden = document.querySelector('input[name="impmode"]:checked').value !== 'replace';
  });
});

$('#impModal').addEventListener('click', (e) => {
  if (e.target === $('#impModal')) closeImportModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#impModal').hidden) closeImportModal();
  closeXportMenu();
});

/* ---------------- 全部展开 / 全部收起 ---------------- */

$('#expandAll').addEventListener('click', () => {
  collapsedGroups.clear();
  navCollapsed.clear();
  collapsedItems.clear();
  for (const g of buildGroups()) expandedGroups.add(g.name);
  renderItems();
});

$('#collapseAll').addEventListener('click', () => {
  expandedGroups.clear();
  for (const g of buildGroups()) {
    collapsedGroups.add(g.name);
    navCollapsed.add(g.name);
  }
  for (const it of state.items) {
    if (it.status === 'done') expandedItems.delete(it.id);
    else collapsedItems.add(it.id);
  }
  renderItems();
});

/* ---------------- 今日有变动筛选 ---------------- */

$('#f-today').addEventListener('click', () => {
  state.todayOnly = !state.todayOnly;
  $('#f-today').classList.toggle('on', state.todayOnly);
  renderItems();
});

/* ---------------- 回到顶部 ---------------- */

const toTop = $('#toTop');
window.addEventListener('scroll', () => {
  toTop.classList.toggle('on', window.scrollY > 380);
  onScrollSpy();
}, { passive: true });
window.addEventListener('resize', onScrollSpy);

toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/* 点到/聚焦到某条任务的任何地方，都高亮它和它的目录项 */
function highlightFromEvent(e) {
  const item = e.target.closest && e.target.closest('.item');
  if (item) setActive(Number(item.dataset.item), true);
}
document.addEventListener('focusin', highlightFromEvent);
$('#items').addEventListener('mousedown', highlightFromEvent);

/* ---------------- 署名 ---------------- */

$('#setName').addEventListener('click', () => {
  const bar = $('#signbar');
  bar.style.display = '';
  $('#signname').value = whoami();
  $('#signname').focus();
  $('#signname').select();
});

$('#signsave').addEventListener('click', () => {
  const v = $('#signname').value.trim();
  if (!v) { toast('名字不能为空'); return; }
  localStorage.setItem('rb_name', v);
  $('#signbar').style.display = 'none';
  renderWho();
  toast('已保存署名：' + v);
});

$('#signname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#signsave').click();
});

function renderWho() {
  const n = whoami();
  $('#whoami').textContent = n ? '我是 ' + n : '未署名';
}

/* ---------------- 载入 ---------------- */

async function load(opts = {}) {
  const qs = new URLSearchParams({ cid: clientId, bid: browserId, name: whoami() });
  const j = await api(`/api/p/${token}?${qs}`);
  state.project = j.project;
  state.items = j.items;
  state.groups = Array.isArray(j.groups) ? j.groups : [];
  state.stats = j.stats;
  if (j.today) state.today = j.today;
  if (typeof j.rev === 'number') serverRev = j.rev;
  if (j.presence) presence = j.presence;

  // 选中项如果还在，分类可能已经变了（比如刚换了所属分类）
  if (activeItemId !== null) {
    const act = state.items.find((x) => x.id === activeItemId);
    if (act) activeGroup = groupOf(act);
    else { activeItemId = null; activeGroup = null; }
  }

  document.title = j.project.name + CFG.titleSeparator + CFG.boardTitle;
  $('#ptitle').textContent = j.project.name + CFG.titleSeparator + CFG.boardTitle;
  $('#boardTitle').textContent = CFG.boardTitle;
  $('#foot').textContent = CFG.footerText;
  $('#footsub').textContent = CFG.footerSub || '';

  renderPresence();
  renderSummary();
  renderOwnerFilter();
  renderItems();

  // 整页重拉会把正在输入的框重建掉，光标和没落库的字都会丢。
  // 所以重拉后把焦点还给原来那个输入框，并把光标放回末尾。
  if (opts.keepFocus) restoreFocus();
}

/* ---------------- 多人协同：轮询版本号 + 在线人数 ---------------- */

let focusMemo = null;

function rememberFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.f) { focusMemo = null; return; }
  focusMemo = {
    f: el.dataset.f,
    id: el.dataset.id,
    pos: typeof el.selectionStart === 'number' ? el.selectionStart : null
  };
}

function restoreFocus() {
  const m = focusMemo;
  focusMemo = null;
  if (!m || !m.id) return;
  const el = document.querySelector(`[data-f="${m.f}"][data-id="${m.id}"]`);
  if (!el || el.readOnly || el.disabled) return;
  el.focus();
  if (m.pos !== null && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(m.pos, m.pos); } catch { /* 某些类型不支持，忽略 */ }
  }
}

function renderPresence() {
  const box = $('#presence');
  if (!box) return;
  const all = presence.people || [];
  if (!all.length) { box.innerHTML = ''; return; }

  /* 同一个人开多个标签页时，不该被算成好几个人。
     按 browserId 分组：同一台电脑的多个标签页合成「张伟 ×2」，
     不同电脑即使重名也是两个人，会分别显示。没填名字的标签页各算一个。 */
  const groups = new Map();
  for (const p of all) {
    const nm = (p.name || '').trim();
    const key = nm ? (p.bid ? 'b:' + p.bid : 'n:' + nm) : 'c:' + p.clientId;
    const rec = groups.get(key);
    if (rec) rec.n += 1;
    else groups.set(key, { label: nm || '未署名', n: 1 });
  }
  const labels = [...groups.values()].map((r) => (r.n > 1 ? `${r.label} ×${r.n}` : r.label));
  const people = labels.length;
  const shown = labels.slice(0, 4).join('、');
  const more = labels.length > 4 ? ` 等 ${people} 人` : '';

  box.innerHTML =
    `<span class="pdot" title="当前有 ${people} 人在这个页面"></span>` +
    `<span class="ptxt">${people} 人在线</span>` +
    `<span class="pnames" title="${esc(labels.join('、'))}">${esc(shown)}${more}</span>`;
}

/* 轮询：只问「版本号变了吗、现在几个人」。
   版本号对不上就说明别人刚改过，这才去整页重拉。 */
async function pollState() {
  if (pollBusy) return;
  // 正在输入时先不重拉，等这一笔落库，否则会把用户正在打的字冲掉；
  // 但最多挡 12 秒，免得用户一直在打字时永远看不到别人的修改
  if (pendingEdit && Date.now() - editSince < 12000) return;
  pollBusy = true;
  try {
    const qs = new URLSearchParams({ cid: clientId, bid: browserId, name: whoami() });
    const j = await api(`/api/p/${token}/state?${qs}`);

    presence = j.presence || { count: 0, people: [] };
    renderPresence();

    if (typeof j.rev === 'number' && j.rev !== serverRev) {
      rememberFocus();
      await load({ keepFocus: true });
      // 别人改了东西，提示一句，但别打断正在输入的节奏
      if (!pendingEdit) toast('已同步其他人的修改');
    }
    // 跨过零点：日期分桶和「今天」都要跟着变
    if (j.today && state.today && j.today !== state.today) {
      await load({ keepFocus: true });
    }
  } catch { /* 网络抖一下不打扰用户，下一轮再说 */ } finally {
    pollBusy = false;
  }
}

function startPolling() {
  pollState();
  setInterval(pollState, POLL_MS);
  // 切回这个标签页时立刻问一次，不用等下一个间隔
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollState();
  });
  window.addEventListener('focus', pollState);
}

/* 关页面/刷新时立刻销号，别让别人看着「幽灵在线」等 30 秒。
   sendBeacon 是唯一能在卸载过程中可靠发出的方式（fetch 会被浏览器掐断）。 */
function leavePage() {
  try {
    navigator.sendBeacon(`/api/p/${token}/leave?cid=${encodeURIComponent(clientId)}`, '');
  } catch { /* 老浏览器不支持就算了，靠 TTL 兜底 */ }
}
window.addEventListener('pagehide', leavePage);

$('#f-q').addEventListener('input', renderItems);

$('#f-owner').addEventListener('change', (e) => {
  state.owner = e.target.value;
  renderOwnerFilter();
  renderItems();
});

$('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('on'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#lightbox').classList.remove('on');
});

async function boot() {
  try {
    CFG = { ...CFG, ...(await api('/api/config')) };
  } catch { /* 用默认值 */ }

  renderWho();
  if (!whoami()) $('#signbar').style.display = '';

  try {
    await load();
    onScrollSpy();
    startPolling();
  } catch (e) {
    document.querySelector('.main').innerHTML =
      `<div class="empty-state">打不开这个项目：${esc(e.message)}<br><br>请确认链接完整，或联系项目负责人。</div>`;
  }
}

boot();
