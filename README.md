# ReqSlate

**一个单文件后端、零依赖的多人协作任务清单，用于跟踪信息化项目中的需求与待办事项。**

[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

信息化项目在建设过程中，需求往往没有完整的规格说明，而是在使用中不断提出、不断调整。这类项目真正难的不是排计划，是**让每一条需求变成一张有编号、有状态、有历史、能导出的单据**，让参与项目的各方在同一张单子上对齐。

ReqSlate 就做这一件事。它长得像一张表，用起来比 Excel 少一半动作，但每条任务背后有版本号、有变更历史、有冲突检测、有 Excel/Markdown/JSONL 三种出口。

![任务清单](docs/board.png)

> 这份 README 讲「它是什么、怎么搭起来、为什么这么做」。**日常怎么用、每个按钮干什么、部署时要注意什么**，在同目录的 [使用手册.md](使用手册.md) 里。

---

## 目录

- [为什么不是 Excel](#为什么不是-excel)
- [功能](#功能)
- [快速开始](#快速开始)
- [架构](#架构)
- [数据模型](#数据模型)
- [多人协作是怎么做的](#多人协作是怎么做的)
- [导入导出](#导入导出)
- [配置](#配置)
- [目录结构](#目录结构)
- [接口](#接口)
- [设计取舍](#设计取舍)
- [已知边界](#已知边界)
- [开发](#开发)

---

## 为什么不是 Excel

用 Excel 管这类项目的典型一天：维护一份工期倒排表，有人在群里问「第 7 条到底要改什么」，另一处又提「那个字段再加一个」，然后表格发来发去，谁也说不清哪版是最新的。

换成 ReqSlate 之后，同样是「填一条需求」，但它带上了 Excel 给不了的东西：

| | Excel 传文件 | ReqSlate |
|---|---|---|
| 谁改的 | 看不出来 | 每条变更记名字和时间 |
| 改之前是什么 | 被覆盖了 | 逐字段的旧值 → 新值 |
| 两个人同时改 | 后保存的覆盖先保存的 | 字段级冲突检测，后到的收到提示 |
| 完成期限 | 手填，容易过期没人管 | 到期自动标红「逾期 N 天」 |
| 对外汇报 | 截图或另做 PPT | 一键导出 Excel，顺序和界面一致 |
| 供本地模型分析 | 导不出干净文本 | 一键导出 Markdown / JSONL |

---

## 功能

**任务**

- 就地编辑，不用点「编辑」：内容、补充说明、进展情况、负责人、完成期限、所属分类全是输入框，**失焦才保存**并记一条变更，打字过程中不会刷屏。
- 状态一个下拉框：未开始 / 进行中 / 已完成，按状态配色（灰 / 蓝 / 绿）。
- 已完成自动锁定（后端强制，不只是藏按钮），要改先改回进行中。
- 完成期限自带全中文日历，也认 `2026/3/5`、`2026.3.5`、`2026年3月5日`、`20260305`，写成 `2026-02-30` 会当场拦下。
- 每条任务可传图（png/jpg/gif/webp，单张 8MB）。

**分类**

- 分类可拖动排序；**某个分类下任务全部完成时自动沉到底部**，按完成先后像栈一样堆起来。
- 序号在分类内部编，增删任务、换分类都自动压实，不会断号。
- 分类名可直接改；改成已有分类名会**合并**，任务接在目标分类末尾，不打乱原有顺序。
- 没填分类的任务按**新增日期**分组成「10月24日新增」，永远钉在最上面，不参与沉底。**跨天不会换组、不会消失**——某天没来得及归类的活，第二天还在原地提醒你。给这一组改个名字，它就变成普通分类，那一批任务一起跟着走。

**看全局**

- 顶部六张统计卡片（总数 / 已完成 / 进行中 / 未开始 / 已逾期 / 完成率），点任一张只看那一类，再点一下取消。
- 「全部负责人」下拉按负责人筛，选项从现有任务里自动收集。
- 「今日有变动」一键筛出今天动过的任务，左侧目录里这些任务前面有小圆点。
- 左侧目录跟着滚动高亮当前正在看的那条；**高亮的那条一旦滚出目录可视区，目录自己也会跟着滚**。点任务任意位置也会高亮。
- 目录可整列收起、可单独收起某个分类、可一键全部展开/收起。
- **只要动过筛选，新建任务或新建分类时会先自动清掉筛选回到「任务总数」**，然后滚到并高亮刚建的那一条——不会出现「建完了却看不见」。

**协作**

- 顶栏显示当前有几个人在这个页面，**按人算不按标签页算**。
- 别人改了东西，2.5 秒内自动刷新；切回标签页立刻刷一次。
- 两人同时改同一条任务的**同一个字段**时，后到的收到提示并看到对方刚写的内容，不会互相覆盖；改不同字段互不影响。
- 打字期间自动同步会让路（最多 12 秒），不会把你打了一半的字冲掉。

---

## 快速开始

**Docker（推荐）**

```bash
cd ReqSlate
# 先改 docker-compose.yml 里的 ADMIN_PASSWORD
docker compose up -d --build
```

打开 `http://服务器IP:3000`。

**直接跑 Node**（需要 Node ≥ 22.5，推荐 24）

```bash
cd ReqSlate
ADMIN_PASSWORD=你的密码 PORT=3000 node server.js
```

Windows 双击 `start.bat`，Linux/macOS 跑 `./start.sh`（两者都会先自检 Node 版本）。

**没有任何第三方依赖**——不用 `npm install`，不用装数据库，不用编译原生模块。把目录拷过去就能跑，x86 和 ARM、Windows 和 Linux 之间可以直接拷。

### 下载现成的版本

不想自己 clone 的话，去 [Releases](https://github.com/Bu9-maker/ReqSlate/releases) 下载 `ReqSlate-x.y.z.zip`，解压后 `./start.sh` 或 `start.bat` 直接跑。每个版本都附了 sha256，可以校验下载是否完整。

镜像也发布在 `ghcr.io/bu9-maker/reqslate`，同一个标签里同时有 amd64 和 arm64，docker 会按机器架构自动挑：

```bash
docker run -d --name reqslate -p 3000:3000 \
  -v reqslate-data:/data \
  -e ADMIN_PASSWORD=换成你自己的密码 \
  ghcr.io/bu9-maker/reqslate:1.0.1
```

---

## 架构

```
                 浏览器（三个静态页 + 一个 app.js）
                              │
                    HTTP / JSON（无框架、无打包）
                              │
        ┌─────────────────────┴─────────────────────┐
        │              server.js  (单进程)           │
        │  ┌──────────┬──────────┬────────────────┐ │
        │  │ 路由分发  │ 会话鉴权  │ 业务逻辑        │ │
        │  └──────────┴──────────┴────────────────┘ │
        │  ┌──────────────────┬───────────────────┐ │
        │  │ node:sqlite      │ xlsx.js（自研）    │ │
        │  │ 五张表 + WAL      │ zip 读写 + 表格    │ │
        │  └──────────────────┴───────────────────┘ │
        └─────────────────────┬─────────────────────┘
                              │
                    data/board.db  +  data/uploads/
```

整个后端是一个 1700 行的 `server.js`，前端是一个 1900 行的 `app.js` 加一份 CSS。**没有构建步骤**：改完文件刷新浏览器就是最新的，不需要 `npm run build`、不需要 watch、不需要 sourcemap。

选择「单文件 + 零依赖」不是因为懒，是因为这个系统要部署在没有外网、没有运维、可能连 npm 都装不上的内网机器上。任何一个第三方包都会带来 `node_modules`、带来锁文件、带来「在开发机上好好的，拷过去跑不起来」。

### 为什么自己写 Excel 读写

`.xlsx` 本质是装着几个 XML 的 zip，Node 自带的 `node:zlib` 就够了。`xlsx.js`（557 行）支持多工作表、共享字符串、内联字符串、日期单元格（靠 `styles.xml` 的 `numFmtId` 认）、数字与文本自动区分、列宽、冻结首行、自动筛选。引入 SheetJS 或 ExcelJS 就得带 `node_modules`，和「拷几个文件就能跑」直接冲突。

读取做了边界防护：条目超 64MB 跳过、单条目解压失败不影响其它、最多 20000 行 × 200 列，防止畸形文件把内存吃光。

---

## 数据模型

SQLite 单文件，WAL 模式，五张表：

```sql
projects  (id, token, name, note, created_at, rev)
items     (id, project_id, grp, seq, title, detail, progress,
           owner, due, status, created_at, updated_at)
groups    (id, project_id, name, sort_order, done_since, done_seq)
history   (id, project_id, item_id, at, who, title, field, old, new, text)
images    (id, item_id, file, created_at)
```

几个值得说的点：

**`groups` 是独立的表，不是 `SELECT DISTINCT grp`。** 因为空分类要能存在（先建分类再往里加任务），而且分类的排序、完成时间得有个地方存。

**`items.grp` 冗余存分类名。** 这样改一条任务的分类就是一次 `UPDATE`，不用查 group id。代价是分类改名要连带改所有任务（一个事务里做完）。

**完成栈靠 `done_seq` 而不是时间戳。** 分类下任务全完成时写 `done_since`（显示用）和一个**单调递增**的 `done_seq`（排序用）。用时间戳会有精度问题——同一秒完成两个分类就分不出先后了。

**「N 月 N 日新增」是虚拟分类。** `items.grp` 存空串表示未分类，`groups` 表里给每个出现过的日期留一行占位，名字是内部名 `未分类@2026-10-24`，`sort_order` 固定 0。**显示名不落库**，由 `uncatLabel(date)` 渲染成「10月24日新增」。桶名带日期，所以任务跨天不会换组。`syncGroups` 按 `SUBSTR(created_at,1,10)` 现算需要哪些桶，缺的补上、空了的删掉。

**老库自动迁移。** 启动时用 `PRAGMA table_info` 检查，缺列就 `ALTER TABLE` 补上（`progress`、`grp`、`done_since`、`sort_order`、`done_seq` 都是这么加的）。升级不用手工改库。

---

## 多人协作是怎么做的

不是 WebSocket，不是 CRDT，是**版本号轮询 + 字段级冲突检测**。

**版本号。** `projects.rev` 只增不减，任何一次写操作（建/改/删任务、建/改/删分类、分类排序、传/删图片）都 `rev = rev + 1` 并随响应带回。前端每 2.5 秒打一次 `GET /api/p/:token/state`，这个接口只回 `{rev, today, presence}`，不返任务数据——**对不上才去整页重拉**。平时几乎不耗流量，有变化 2.5 秒内跟上。切回标签页或窗口重新获得焦点时立刻问一次。

**冲突检测。** `PATCH /items/:id` 可以带 `base: { 字段: 我以为的旧值 }`，后端拿它和库里当前值逐个比。**只比这次要改的字段**，所以一个人改进展、另一个人改负责人不会互相挡。同一个字段被两人先后改，后到的拿 409：

```json
{ "conflict": true, "field": "progress", "item": { ...最新内容... }, "rev": 42 }
```

前端据此把界面刷成最新并提示「这条任务的『进展情况』刚被别人改过，已帮你刷新成最新内容，请确认后再改一次」。

**打字时让路。** 前端记着「我正在改哪个字段」，这期间轮询到的整页重拉会跳过（最多挡 12 秒）；重拉后把焦点和光标位置还原回原来那个输入框。

**在线人数。** 只在内存 `Map` 里，重启即清空，不落库。每个标签页一个 `clientId`（`sessionStorage`，刷新不变、关掉即消失），每个浏览器一个 `browserId`（`localStorage`，同一台电脑所有标签页共用）——界面按 `browserId` 合并，所以同一浏览器开多个标签页只算一个人（显示「张三 ×2」），不同电脑上重名的人仍分开算。正常关页面时 `sendBeacon` 打一次 `POST /leave` 立刻销号；异常断开最多 20 秒后自动清掉。

### 为什么不用 WebSocket

内网环境里，反向代理、防火墙、老旧负载均衡都可能掐掉长连接，而轮询只要 HTTP 能过就能用。2.5 秒的延迟对「填需求变更单」这种一人管一条、各改各的字段的用法完全够——它不是文档协同，不需要看到对方正在敲的每一个字。省下来的复杂度是：不用管重连、不用管心跳、不用管代理超时、不用管服务重启时一堆半死不活的连接。

---

## 导入导出

工具条上的「导入导出」菜单：

| 动作 | 说明 |
|---|---|
| 导出 Excel | 两张工作表：「任务清单」9 列 +「变更历史」5 列。日期是真日期格式（Excel 里能排序、算差值），首行冻结、带筛选箭头 |
| 导出 CSV | UTF-8 带 BOM，Excel 双击打开不乱码 |
| 导出 Markdown | 项目标题+统计、按分类列出任务、附最近 300 条变更。整篇贴进对话框就能问 |
| 导出 JSONL | 一行一条 JSON，首行项目概要，其余每行一条任务。`jq`、Python 都能直接吃 |
| 下载导入模板 | 示例 3 行 +「填写说明」表 |
| 从表格导入 | 追加或覆盖（覆盖需二次确认） |

**导出的顺序永远和界面一致**——两者都复用 `exportRows`，日期桶在前、分类按你排的顺序、分类内按序号。

**导入很宽容**：表头中英文都认（`任务内容` / `title` / `内容`），状态写中文或 `todo/doing/done` 都行，日期认 `2026-11-10`、`2026/11/10`、`2026.11.10`、`2026年11月10日`、`20261110`，分类名不用先建（自动建）。CSV 的 GBK 编码会自动识别——从 Excel「另存为 CSV」出来的就是 GBK，直接用。单行有问题只跳过那一行并在结果里告警，不会整批失败。

JSONL 的字段：

```json
{"type":"item","grp":"公文流转","seq":1,"title":"收文登记模块","detail":"...","progress":"...","owner":"王芳","due":"2026-11-03","status":"doing","statusText":"进行中","overdue":false,"updatedAt":"2026-10-26 10:12:33"}
```

`statusText` 和 `overdue` 是派生字段，模型和脚本都不用自己算。

---

## 配置

`config.json`，改完刷新浏览器即生效（不用重启）：

```json
{
  "appName": "ReqSlate",
  "overviewTitle": "项目总览",
  "boardTitle": "工作任务清单",
  "titleSeparator": " · ",
  "footerText": "ReqSlate",
  "footerSub": "designed by zhouwh",
  "loginHint": "请输入管理密码"
}
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，反代后面设 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据目录（数据库、密钥、图片） |
| `ADMIN_PASSWORD` | `admin123` | 首页登录密码。**用默认值启动会打警告** |
| `TZ_OFFSET` | `8` | 时区偏移小时数。不用系统时区库，服务器时区设成什么都不影响 |

---

## 目录结构

```
ReqSlate/
├── server.js              # 全部后端逻辑（路由/鉴权/业务/导入导出），零依赖
├── xlsx.js                # 自研 Excel 读写（zip + XML），零依赖
├── config.json            # 界面文案
├── README.md              # 本文件
├── 使用手册.md            # 日常用法与部署细节
├── CHANGELOG.md           # 每个版本改了什么
├── docs/                  # 本文件引用的截图
├── .github/
│   ├── smoke.mjs          # 冒烟测试（65 项断言，本地和 CI 都跑这一份）
│   └── workflows/
│       ├── ci.yml         # 每次推送跑语法检查 + 冒烟测试 + Docker 构建
│       └── release.yml    # 打 tag 时自动打包、推镜像、建 Release
├── public/
│   ├── login.html         # 管理密码登录页
│   ├── index.html         # 项目总览
│   ├── project.html       # 工作任务清单
│   ├── app.js             # 项目页全部交互
│   ├── style.css          # 全部样式
│   └── favicon.svg        # 标签页图标
├── start.bat              # Windows 启动
├── start.sh               # Linux/macOS 启动
├── Dockerfile
├── docker-entrypoint.sh   # 容器入口：把 /data 交给 app 用户再降权跑 node
├── docker-compose.yml
└── data/                  # 运行时生成：board.db + .secret + uploads/
```

**要拷到另一台机器**：`server.js`、`xlsx.js`、`config.json`、`public/`，有 `data/` 就接着原来的数据用。

---

## 接口

全部 JSON，除登录外无鉴权头——项目 token 本身就是凭证。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 界面配置（免登录） |
| POST | `/api/login` | 密码登录，下发会话 cookie（HMAC-SHA256，30 天） |
| POST | `/api/logout` | 退出 |
| GET | `/api/projects` | 项目列表（需登录） |
| POST | `/api/projects` | 新建项目 |
| PATCH | `/api/projects/:id` | 改名 / 改备注 |
| DELETE | `/api/projects/:id` | 删除项目及其全部任务与图片 |
| GET | `/api/p/:token` | 读整个项目：任务 + 分类 + 统计 + `rev` + `presence` |
| GET | `/api/p/:token/state` | 轻量轮询：只回 `{rev, today, presence}` |
| POST | `/api/p/:token/leave` | 关页面销号（`sendBeacon`，只收 POST） |
| POST | `/api/p/:token/groups` | 新建分类，`{name?, after?}` |
| PATCH | `/api/p/:token/groups` | 分类改名 `{from, to}`，撞名则合并 |
| DELETE | `/api/p/:token/groups` | 删除空分类 |
| POST | `/api/p/:token/groups/order` | 保存分类顺序 `{order:[name,...]}` |
| POST | `/api/p/:token/items` | 新增任务 `{grp, title?}` |
| PATCH | `/api/p/:token/items/:id` | 改任务，可带 `base` 做冲突检测（409） |
| DELETE | `/api/p/:token/items/:id` | 删除任务 |
| POST | `/api/p/:token/items/:id/images` | 上传图片（dataURL） |
| DELETE | `/api/p/:token/items/:id/images/:imgId` | 删除图片 |
| GET | `/api/p/:token/export.xlsx` | 导出 Excel |
| GET | `/api/p/:token/export.csv` | 导出 CSV |
| GET | `/api/p/:token/export.md` | 导出 Markdown |
| GET | `/api/p/:token/export.jsonl` | 导出 JSONL |
| GET | `/api/p/:token/template.xlsx` | 下载导入模板 |
| POST | `/api/p/:token/import` | 从表格导入 |

---

## 设计取舍

**不做账号体系。** 做账号意味着维护用户表、密码重置、离职停用、以及「谁能看哪个项目」的授权矩阵。实际用起来大家只是在同一个内网里协作填单子，多一道登录，参与的人就会嫌麻烦不填了。现在的做法是项目链接本身当凭证（12 位随机码，猜不出来），改动记在「你的名字」上（第一次打开填一次，存浏览器里）。**代价是没有权限区分**，谁拿到链接都能删任务，所以链接只发给相关的人。真要分权限，在 nginx 那层做认证更省事。

**不做实时协同。** 见上面「为什么不用 WebSocket」。

**不做通知。** 逾期只在页面标红，不发邮件、不发企业微信。内网环境里配 SMTP 往往比这个系统本身还麻烦。

**失焦保存而不是防抖保存。** 防抖会在你打字停顿时偷偷提交，产生一堆「改成一半」的历史记录。失焦保存的语义是「我改完了」，历史更干净。

**序号按分类内部编。** 全局序号在换分类时必然要重排，跨分类看序号也没意义；分类内从 1 开始，一眼知道这一组有几条。

---

## 已知边界

- 没有通知（逾期只在页面标红）。
- 没有权限区分（拿到链接权限一样）。
- 不支持附件（除图片）。
- 删除项目不可恢复，没有回收站。导入的「覆盖」模式也一样。
- 导入不做增量比对——同一份表格导两次就是两份任务。
- 协同是「秒级同步 + 字段级冲突提示」，不是字对字实时协同。
- 在线人数只在内存里，服务重启就清空。
- 登录限流按单个 IP 记，同一 NAT 后面的人会互相连累（正常用碰不到）。
- 导入上限 5000 行 / 8MB；导出「变更历史」最多 5000 条，Markdown 里的变更最多 300 条。

---

## 开发

改完代码想确认没改坏，不用起浏览器，跑一遍冒烟测试就行：

```bash
ADMIN_PASSWORD=ci-pass PORT=3000 node server.js &
ADMIN_PASSWORD=ci-pass node .github/smoke.mjs
```

它用真的 HTTP 请求走一遍：登录、建项目、建分类、建任务、改字段、冲突检测、完成锁定、
四种导出、导入、在线状态、以及一批异常输入（畸形 JSON、不存在的日期、畸形 Host）。
65 项断言，跑完大约 3 秒。

推送到 GitHub 后 CI 会自动跑同一份脚本，另外还检查：

- `node --check` 三个 JS 文件
- `config.json` 是合法 JSON
- **没有引入第三方依赖**（有人误加 `require('lodash')` 会红）
- 在 Node 22.5 和 24 上各跑一遍（22.5 是文档写的最低版本）
- Docker 镜像能构建、容器健康检查能过、镜像里跑一遍冒烟测试

### 发布新版本

1. 在 [CHANGELOG.md](CHANGELOG.md) 里加一节 `## [x.y.z] — 日期`
2. 打 tag 并推送：

```bash
git tag v1.0.1
git push origin v1.0.1
```

Release 工作流会自动：跑测试 → 打一个解压即用的 zip → 构建 amd64/arm64 镜像推到 ghcr.io →
创建 Release 并把 zip 和 sha256 挂上去，正文从 CHANGELOG 里取。

如果 CHANGELOG 里没有对应版本，工作流会直接失败，避免发出去一个没有说明的版本。

---

## License

MIT
