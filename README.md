**🌐 语言 / Language:** [中文](README.md) | [English](README.en.md)

# 🔍 工程审计智能审读

> **工程资料智能解析，审计疑点自动溯源。**
>
> 一个面向建设工程审计场景的开源「智能审读 Agent」：上传合同、招投标、清单、结算、签证等资料，AI 自动完成要素结构化抽取、跨页表勾稽、三方签章核对，并支持证据溯源式问答，每条结论都可定位回原件页码，疑点一键导出 Excel/Word 台账。
>
> 内置 **🧹 清标分析**：上传 1 份招标控制价 + N 家投标报价文件，一键输出逐项比对的清标评审报告（算术性错误、不平衡报价、漏报/零报价、暂列金额与安全文明施工费、废标红线等），可直接用于评标辅助。

---

## 🌐 在线体验 & 开源地址

| 项目 | 内容 |
|------|------|
| 🚀 在线体验 | https://ai-audit.xunnan.net/pc/index.html |
| 👤 体验账号 | `admin` / `123456` |
| 📦 开源地址 | https://gitee.com/xiangxiang088/ai-smart-audit |

> 为了不影响其他人体验，请不要修改 admin 密码，感谢大家的支持！

---

## 📖 项目介绍

### 这是什么？

**工程审计智能审读** 是一套含前后端、可私有化部署的工程审计辅助系统。它把审计人员从「逐页翻阅、人工抄录、手工对账」中解放出来，让 AI 完成资料的结构化解析与初步核对，审计人员专注于专业判断与疑点复核。

整体工作流：

```
   资料上传  →  智能解析(OCR)  →  结构化要素入库  →  自动核对 / 溯源问答  →  疑点台账  →  导出报告
 PDF / 图片      PaddleOCR-VL      表格/印章/文本      勾稽·签章·跨文件      Excel/Word

   清标分析:  1 份招标控制价 + N 家投标报价  →  解析入库  →  逐项比对与合规核验  →  Markdown 清标报告
```

| 模块 | 说明 |
|------|------|
| 🧭 审计驾驶舱 | 全局统计、最近项目快捷继续、项目核对状态总览 |
| 📁 审计项目 | 多项目管理，卡片即项目上下文入口 |
| 📄 资料舱 | 合同 / 招投标 / 清单 / 结算 / 签证等上传、解析、原件查看 |
| ✅ 核对程序 | 清单↔结算跨页表自动勾稽、合同/签证三方签章核对 |
| 💬 智能问答 | 证据溯源式提问，Agent 多轮取证，结论附原件页码引用 |
| ⚠️ 疑点台账 | 自动汇总核对差异与签章异常，一键导出 Excel / Word |
| 🧹 清标分析 | 招标控制价 + 多家投标报价逐项比对，输出清标评审报告（独立功能，无需绑定项目） |
| 🤖 模型配置 | 审计大脑模型可视化配置：调用顺序、启停、单模型/整链超时、连通性测试 |

### 为什么做？

传统工程审计长期面临三大痛点：

- **资料厚、抄录累**：一个项目的合同、清单、结算动辄数百页，关键金额、日期、签章全靠人工逐页查找抄录。
- **对账繁、易出错**：清单与结算、签证与合同之间需要跨页、跨文件反复勾稽，人工核对耗时且易遗漏。
- **结论难溯源**：发现问题后要回到海量原件中翻找出处，底稿整理与台账汇总重复劳动多。

本项目用「OCR 眼睛 + Agent 大脑」自动完成上述机械性工作，让审计结论**可核对、可溯源、可导出**。

### 核心能力

- [x] PDF / 图片资料智能解析，表格、印章、文本要素结构化抽取
- [x] 清单 ↔ 结算跨页表自动勾稽，金额/工程量差异逐项标注
- [x] 合同 / 签证三方（建设、施工、监理）签章与齐全性核对
- [x] 证据溯源智能问答，多轮取证，每条结论定位原件页码
- [x] 疑点台账自动汇总，Excel / Word 一键导出
- [x] **清标分析**：算术性错误、不平衡报价、漏报/零报价、暂列金额、安全文明施工费、废标红线等 12 类逐项核验
- [x] **模型可配置**：调用链顺序可调、单模型可停用、超时与故障切换策略可视化设置
- [x] 全局记住当前审计项目，多项目随时切换
- [x] 完整 RBAC 权限体系、JWT 认证、接口限流与安全加固

---

## 🖼️ 产品预览

### 🔐 登录
品牌化登录页，支持账号注册，纯 PC 产品体验。

![登录](docs/screenshots/01-login.png)

### 🧭 审计驾驶舱
项目、资料、已解析、疑点四项统计一屏掌握，最近项目快捷继续。

![审计驾驶舱](docs/screenshots/02-cockpit.png)

### 📁 审计项目
多项目卡片管理，点击卡片即进入该项目上下文。

![审计项目](docs/screenshots/03-projects.png)

### 📄 资料舱
上传与解析状态一目了然，原件查看支持框选定位表格 / 标题区域。

![资料舱](docs/screenshots/04-documents.png)

### ✅ 核对程序
清单↔结算跨页表勾稽、三方签章核对结果分类呈现。

![核对程序](docs/screenshots/05-checks.png)

### ⚠️ 疑点台账
自动汇总差异与签章异常，支持 Excel / Word 一键导出。

![疑点台账](docs/screenshots/06-findings.png)

### 💬 智能问答
Agent 多轮取证后给出结论，附证据引用与原件页码，资料缺失明确列出。

**全链路流式**：整条问答走 SSE，取证进度（第几轮、调了什么工具、查到几条证据、耗时）与成稿正文实时推到浏览器。首条进展在**百毫秒级**即可见，用户不必盯着转圈等整轮跑完。成稿正文由服务端从模型的 JSON 强约束输出中**实时剥离 `answer` 字段**下发——用户看不到 `{"answer":"…"}` 外壳，也不会渲染出 `\u4e2` 这类半截转义乱码。模型长思考期间由 SSE 心跳保活，网络中断后前端会自动回服务端核对最新落库结果。

![智能问答](docs/screenshots/07-chat.png)

---

## 🏗️ 技术架构

### 「眼睛」与「大脑」分离

```
┌──────────────────────────────────────────────────────────────┐
│                        PC 前端（浏览器）                        │
│   原生 HTML / CSS / JS，无框架、无打包器，Express 静态托管       │
└───────────────────────────────┬──────────────────────────────┘
                                 │ JWT + REST API
┌───────────────────────────────▼──────────────────────────────┐
│                     Node.js + Express 后端                     │
│                                                                │
│   ┌──────────────────┐         ┌───────────────────────────┐  │
│   │   👁️ 眼睛：OCR     │         │   🧠 大脑：审计 Agent       │  │
│   │  PaddleOCR-VL 1.6 │         │  doubao-seed-evolving      │  │
│   │  官方云 API        │  结构化  │  (Seed-2.1-pro)           │  │
│   │  表格/印章/文本抽取  │ ─要素→  │  规划·工具调用·跨文件核验   │  │
│   └──────────────────┘         │  溯源问答·疑点判断           │  │
│                                └───────────────────────────┘  │
│                                        │                       │
│                                 mysql2 连接池                  │
└────────────────────────────────────────┼───────────────────────┘
                                         ▼
                              MySQL 8.0（兼容 5.7）
```

- **眼睛（OCR）**：百度 AI Studio **PaddleOCR-VL 1.6** 官方在线 API，负责把 PDF / 图片解析为表格、印章、文本等结构化要素。模型只看「图」，输出结构化 JSON。
- **大脑（Agent）**：火山方舟 **doubao-seed-evolving（Seed-2.1-pro）**，基于结构化要素做规划、函数调用取证、跨文件核验、溯源问答与疑点判断。**大脑不直接接触图片**，从而保证结论可结构化、可溯源。
- **模型故障转移**：大脑调用按「主模型 → 备用 → 兜底」顺序依次尝试，前一个失败（限流 / 欠费 / 超时 / 服务异常）才切换下一个。**调用顺序、启用状态、单模型与整链超时全程可在「🤖 模型配置」页调整，改完即生效、无需改代码**。长报告一律走**流式输出**——非流式在模型长思考期间不产生任何数据，易被中间代理按空闲超时掐断连接。

### 技术栈

| 层次 | 技术 |
|------|------|
| 前端 | 原生 HTML / CSS / JavaScript，无 Vue/React、无打包器 |
| 后端 | Node.js + Express，mysql2 连接池 |
| 数据库 | MySQL 8.0（兼容 5.7），雪花 ID 主键，`del_flag` 逻辑删除 |
| OCR（眼睛） | PaddleOCR-VL 1.6 官方云 API（AI Studio） |
| Agent（大脑） | doubao-seed-evolving / Seed-2.1-pro（火山方舟） |
| 模型容错 | 主→备用→兜底 故障转移链，流式输出，顺序/启停/超时可配（配置入库、免发版） |
| 文档处理 | xlsx、docx、mammoth（台账导入导出） |
| 认证 / 权限 | JWT + bcryptjs，完整 RBAC |
| 文件上传 | Multer，日期分类存储 |

---

## 🧹 清标分析

评标环节最耗时的机械性核对交给 AI：上传 **1 份招标控制价 + N 家投标报价文件**，系统逐项比对后输出一份可直接用于评审的 Markdown 清标报告。

一个清标任务 = 1 份招标控制价 + N 家投标方（每家可挂多份报价文件）。该功能与审计项目**解耦**（`project_id` 可为空），可独立使用。

**12 类核验项：**

| 章节 | 核验内容 |
|------|----------|
| 一、算术性错误 | 逐条核对「综合单价 × 数量 = 合价」；专项排查「单价为 0 但合价非零」等单价篡改手法，以及分部分项汇总价与投标总价不一致 |
| 二、清单编码与项目名称规范性 | 编码被擅自修改、名称/项目特征与招标文件不符、计量单位不一致 |
| 三、安全文明施工费费率 | 是否低于规定最低费率（该费用不得作为竞争性费用下压） |
| 四、暂列金额一致性 | 按专业核对暂列金额是否原数保留、不得变动 |
| 五、主要材料及设备价格 | 材料、设备报价是否明显偏离控制价同期水平 |
| 六、非实质性响应 | 工期承诺、质量标准、报价超限价、重大漏项/增项 |
| 七、不平衡报价 | 前重后轻 / 前轻后重、工程量可能增减项单价偏离，附偏差率与业主风险提示 |
| 八、其他问题及建议 | 措施项目费不合理、规费税金计取错误等 |
| 九、项目名称一致性 | 控制价与各投标文件载明的工程项目名称是否一致 |
| 十、废标红线 | 漏项、工程量擅自改动，以及**漏报**（单价空缺未填）与**零报价**（主动报 0）分列 |
| 十一、非标红线专区 | 汇总暂列金额变动、甲供材料异常、漏报、零报价等高风险项，按投标方成表 |
| 十二、报价规律性分析 | 总价分布、单价离散度、报价梯度（只做客观统计，不作围标串标的定性结论） |

报告末尾附「清标结论汇总」表，列出各投标方的问题项数量、风险等级（高/中/低）与总体建议。

**资料容量上限**：控制价单份 4 万字符、投标方单份 3 万字符、合计 16 万字符（超出部分截断）。

**测试资料**：仓库本地附有 3 组清标资料（`docs/bid-clearing-samples/`，含构造数据、未纳入版本库），覆盖清单级 / 小体量 / 总价级三种场景；其中控制价与各投标人的投标总价均为真实公开数据，可用于功能验证。

---

## 🤖 模型配置

「眼睛」固定使用 PaddleOCR-VL，而**审计大脑**（清标分析、智能问答）走的是可配置的模型链：按列表**从上往下依次尝试**，前一个失败才试下一个。

入口：侧边栏「🤖 模型配置」（`/pc/ai-model-config.html`，管理员可见）。默认内置三档：

| 顺序 | 模型 | 定位 |
|------|------|------|
| 1 | `doubao-seed-evolving`（Seed-2.1-pro） | 主模型，能力最强 |
| 2 | `doubao-seed-2-1-turbo-260628` | 备用 1 |
| 3 | `doubao-seed-2-0-lite-260215` | 备用 2 / 兜底 |

页面能力：

| 操作 | 说明 |
|------|------|
| ▲▼ 排序 | 调整降级顺序，想优先用的往上移 |
| 启用 / 停用 | 停用即**彻底跳过**，一次都不会调用 |
| 「仅用此模型」 | 一键设为主模型并关闭故障转移 |
| 单模型 / 整链超时 | 以分钟为单位，避免「单模型超时 × 模型数」无限等待 |
| 🔌 测试全部模型 | 逐个发一次极简请求，确认 Key / 额度 / 网络是否正常 |
| 生效顺序预览 | 直观显示实际会先试谁、跳过了谁、为什么 |

配置持久化在**统一配置中心**（`sl_sys_config` 表的 `audit.ai` 域，键 `model_chain`），**改完即生效，无需改代码或重启**；`baseUrl` / `apiKey` 留空时回退环境变量 `ARK_BASE_URL` / `ARK_API_KEY`。

几点实现说明（均为实测踩坑所得）：

- **长报告必须走流式**：非流式请求在模型长思考期间一个字节都不下发，实测会被中间代理按约 300 秒的空闲超时掐断连接（表现为 `fetch failed`），导致主模型必然失败、报告降级到弱模型。改为流式后每收到一段数据即重置空闲计时，主模型可稳定跑完 15 分钟级的清单级清标。
- **降级留痕**：一旦发生降级，会话的 `model_info` 会记录「已降级，失败：xxx」，并在报告顶部给出人工复核提示，避免把弱模型写下的「未发现异常」直接当作结论采信。
- **解析串行**：资料解析为规避在线 OCR 接口限流而串行执行，同批次的大 PDF 会阻塞其它文件的解析进度，属设计使然。

---

## ⚙️ 统一配置中心

系统配置不再各表一套，统一收在 `sl_sys_config`，按 `namespace` 分域存放：

| 配置域 | 内容 | 消费方 |
|--------|------|--------|
| `audit.ai` | 审计模型链（主模型 / 降级顺序 / 各模型超时 / 故障转移） | `utils/audit/arkClient.js` |
| `edu.ai` | 教育模块 AI 配置（智谱 GLM 的接口地址 / Key / 模型） | `routes/education/*` |

设计要点：

- **类型随值走**：`value_type` ∈ `string` / `number` / `boolean` / `json`，读取时自动解码 —— 不会再出现「`'false'` 是 truthy」这类坑。
- **密钥自动脱敏**：`is_secret=1` 的项对外一律输出 `9926****7tad` 形式，服务端内部读取才是明文；写入时留空表示「不修改」，避免把掩码当成新密钥写回去。
- **按域缓存 30 秒**，写操作立即失效该域 → 改配置即生效，不必重启。
- 原有接口（`/api/audit/ai-config`、`/api/settings/ai`）保留为**适配层**，外部契约不变，老页面零改动。

统一接口（管理员）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/config` | 列出所有配置域及条目数 |
| GET | `/api/admin/config/:namespace` | 读取某域全部配置（密钥脱敏） |
| PUT | `/api/admin/config/:namespace` | 写入某域，支持 `{ items: [...] }` 或 `{ key: value }` 两种提交形态 |
| DELETE | `/api/admin/config/:namespace/:key` | 删除某键 |

---

## 🚀 快速启动

### 环境要求

- Node.js >= 16（建议 18 LTS）
- MySQL >= 5.7（建议 8.0）
- 百度 AI Studio Access Token（OCR）：https://aistudio.baidu.com/account/accessToken
- 火山方舟 API Key（Agent）：https://console.volcengine.com/ark　（也可不写进环境变量，登录后在「🤖 模型配置」页逐个模型填写）

### 第一步：初始化数据库

```bash
mysql -u root -p
```

先执行基础库脚本，再按文件名日期顺序执行审计模块脚本：

```sql
-- 1) 基础系统表（用户/角色/菜单/通知等）
source /你的路径/ai-smart-audit/server/sql/v1.0.x/20260920-db-init-v1.0.x.sql;

-- 2) 工程审计模块（按文件名日期顺序全部执行）
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260920-audit-init.sql;                   -- 审计项目 / 资料 / 要素 / 问答 / 核对表
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260920-audit-ai-config.sql;               -- 模型配置表（数据随后迁入统一配置中心，该表仅作回滚快照）
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260921-audit-admin-rebrand.sql;           -- 后台管理审计化（停用教育类菜单）
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260921-audit-cockpit-rebrand.sql;         -- 驾驶舱改造
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260921-audit-bid-clearing.sql;            -- 清标分析（任务 / 投标方 / 资料关联 + 菜单）
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260922-audit-model-config-menu.sql;       -- 模型配置菜单
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260922-bid-clearing-decouple-project.sql; -- 清标解绑项目（project_id 允许为空）
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260922-remove-edu-menus.sql;              -- 清理教育模块残留菜单
source /你的路径/ai-smart-audit/server/sql/v1.1.x/20260922-unified-config-store.sql;          -- 统一配置中心（sl_sys_config 升级为分域结构 + 模型链迁入 audit.ai 域）
```

> 以上脚本必须按顺序执行。默认数据库名为 `ai_education`，如需改名请同步修改脚本与环境变量。
>
> 也可用仓库自带脚本逐条执行（免手输 `source` 路径）：`cd server && node scripts/exec-sql.js sql/v1.1.x/20260921-audit-bid-clearing.sql`

### 第二步：配置环境变量

```bash
cd server
cp .env.template .env.development
```

编辑 `server/.env.development`，重点填写以下项：

```env
# 数据库
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=ai_education

# JWT 密钥：node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=替换为本地生成的随机长字符串

PORT=3003
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3003,http://127.0.0.1:3003

# OCR（眼睛）：AI Studio Access Token
OCR_KEY=你的_aistudio_access_token
OCR_MODEL=PaddleOCR-VL-1.6

# Agent（大脑）：火山方舟
ARK_API_KEY=你的_ark_api_key
ARK_MODEL=doubao-seed-evolving
```

> 服务按 `NODE_ENV` 加载对应文件：production → `.env.production`，development → `.env.development`，未设置 → `.env`。

### 第三步：安装依赖并启动

```bash
cd server
npm install
npm start
```

Windows（PowerShell / CMD）指定开发环境：

```powershell
# PowerShell
$env:NODE_ENV="development"; npm start
```
```cmd
:: CMD
cmd /c "set NODE_ENV=development && npm start"
```

Linux / macOS：

```bash
NODE_ENV=development npm start
```

启动后访问：

- 应用入口：http://localhost:3003/ （自动跳转登录页）
- 默认管理员：`admin` / `123456`

### 怎么用？

**A. 项目维度的资料审读**

1. 在「📁 审计项目」新建项目并点击进入；
2. 在「📄 资料舱」上传合同 / 招投标 / 清单 / 结算 / 签证等 PDF 或图片，等待解析完成；
3. 在「✅ 核对程序」运行清单↔结算勾稽、三方签章核对；
4. 在「💬 智能问答」直接提问，例如：
   - `合同关键页里有哪几方签章？是否齐全？`
   - `清单和结算的工程量、单价有哪些差异？`
   - `签证金额与合同约定是否一致？依据在第几页？`
5. 在「⚠️ 疑点台账」查看汇总结果，并导出 Excel / Word。

**B. 清标分析（独立功能，无需绑定项目）**

1. 进入「🧹 清标分析」，点「+ 新建清标任务」并命名；
2. 上传本次清标资料（1 份招标控制价 + 各投标方报价文件，Excel / PDF / Word 均可），等待解析完成；
3. 指定其中哪一份是**招标控制价**；
4. 逐家「添加投标方」，填写投标单位名称，把对应报价文件挂到该家名下；
5. 页面提示「可分析」后点击「开始清标分析」，等待生成 Markdown 清标报告；
6. 报告按 12 类核验项分章呈现，每章先给结论再列明细表（清单编码、投标单位、金额差额、偏差率、风险等级）。

> 清标资料**不占用审计项目**，可独立使用；仓库本地另附 3 组清标测试资料（`docs/bid-clearing-samples/`，未纳入版本库）。

**C. 模型配置**

进入「🤖 模型配置」，可视化调整模型的调用顺序、启停与超时，并测试连通性，详见上方「🤖 模型配置」章节。

---

## 🐧 Linux 生产部署

推荐使用 PM2 守护进程：

```bash
npm install -g pm2
cd server
NODE_ENV=production pm2 start server.js --name ai-smart-audit --env production
pm2 save && pm2 startup
```

或使用 systemd（`/etc/systemd/system/ai-smart-audit.service`）：

```ini
[Unit]
Description=AI Smart Audit
After=network.target mysql.service

[Service]
Type=simple
WorkingDirectory=/opt/ai-smart-audit/server
ExecStart=/usr/bin/node /opt/ai-smart-audit/server/server.js
Environment=NODE_ENV=production
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-smart-audit
```

Nginx 反向代理（注意放开上传体积，审计 PDF 通常较大）：

```nginx
server {
    listen 80;
    server_name your.domain.com;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

生产环境请确保已创建 `.env.production` —— `.env*` 都在 `.gitignore` 里、不会随代码部署，
最省事的做法是 `cp .env.production.example .env.production` 再改值。

`ALLOWED_ORIGINS` **通常留空即可**：前端调用后端用的是相对路径 `/api`，与后端同源，
服务端对同源请求已自动放行，因此换域名、换 IP、上 HTTPS、走 Nginx 反代都无需改配置。
只有「前后端分离部署」（前端 A 域名、API B 域名）才需要登记前端来源，支持通配子域：

```ini
ALLOWED_ORIGINS=https://audit.example.com,https://*.example.com
```

### 部署后自检

一条命令看清「实际生效的配置」与 CORS 行为是否都如预期：

```bash
cd server && node scripts/check-deploy.mjs --host=your.domain.com
```

它会检查实际加载了哪个 env 文件、关键变量是否为空、端口是否在监听，
并模拟同源 / 跨域 / 通配 / 预检四类请求，逐条给出放行或拒绝的判定。

### 常见问题：登录报 `Not allowed by CORS`

这属于**部署配置问题**，不是业务错误 —— 请求来源未被放行，被服务端在进入业务逻辑前就拦掉了：

| 现象 | 原因 | 处理 |
|---|---|---|
| 换域名 / 上 HTTPS 后突然登录失败 | 服务端把同源请求也拿去套白名单 | 升级到含同源放行逻辑的版本并重启 |
| 自检提示「同源请求被拒」 | 进程跑的还是改动前的代码 | 重启服务 |
| 前后端确实分离部署 | 前端域名未登记 | 在 `ALLOWED_ORIGINS` 登记，支持 `*.example.com` |

> 另一个容易踩的点：`NODE_ENV` 决定加载哪个 env 文件，用 PM2 / systemd 启动时要通过**启动参数**传入
> （`--env production` / `Environment=NODE_ENV=production`），只写在文件里是无效的 —— 读哪个文件本身就取决于它。
> 配置没生效时，先看启动日志里的 `⚙️ 环境文件:` 与 `🌐 CORS:` 两行，一眼就能确认。

---

## 📁 项目结构

```
ai-smart-audit/
├── server/                              # 后端
│   ├── server.js                        # Express 入口：路由/安全中间件/限流/静态托管
│   ├── db.js                            # MySQL 连接池
│   ├── package.json
│   ├── .env.template                    # 环境变量模板（开发）
│   ├── .env.production.example          # 环境变量模板（生产：CORS / 反向代理 / 密钥）
│   ├── sql/
│   │   ├── v1.0.x/20260920-db-init-v1.0.x.sql   # 基础系统表
│   │   └── v1.1.x/                              # 工程审计模块（按文件名日期顺序执行）
│   │       ├── 20260920-audit-init.sql          # 审计项目/资料/要素/问答/核对表
│   │       ├── 20260920-audit-ai-config.sql     # 模型配置表初始化
│   │       ├── 20260921-audit-bid-clearing.sql  # 清标分析（任务/投标方/资料关联）
│   │       ├── 20260922-audit-model-config-menu.sql        # 模型配置菜单
│   │       ├── 20260922-bid-clearing-decouple-project.sql  # 清标解绑项目
│   │       └── 20260922-unified-config-store.sql          # 统一配置中心（分域键值）
│   ├── routes/
│   │   ├── admin-config.js              # 统一配置中心接口（分域读写）
│   │   └── audit/                       # 审计路由
│   │       ├── projects.js              # 项目
│   │       ├── documents.js             # 资料
│   │       ├── aiConfig.js              # 模型配置
│   │       ├── bidClearing.js           # 清标分析
│   │       ├── chat.js                  # 智能问答
│   │       └── checks.js                # 核对程序 / 台账导出
│   ├── utils/
│   │   ├── configStore.js               # 分域配置中心（类型解码 / 密钥脱敏 / 缓存）
│   │   └── audit/
│   │       ├── arkClient.js             # 火山方舟客户端：模型链 / 故障转移 / 流式输出
│   │       ├── parse/                   # OCR 客户端与解析服务（眼睛）
│   │       ├── chat/                    # Agent 编排与工具调用（大脑）
│   │       ├── bidclearing/             # 清标服务与专家提示词
│   │       └── check/                   # 勾稽 / 签章核对逻辑
│   └── scripts/
│       ├── exec-sql.js                  # SQL 脚本执行器
│       ├── check-deploy.mjs             # 部署自检（环境文件 / 关键变量 / CORS 行为）
│       ├── e2e-bid-clearing.mjs         # 清标分析端到端测试
│       ├── verify-model-config.mjs      # 模型配置接口回归测试
│       └── verify-config-store.mjs      # 统一配置中心接口回归测试
│
├── pc/                                  # PC 前端（原生 HTML/CSS/JS）
│   ├── login.html                       # 登录 / 注册
│   ├── index.html                       # 审计驾驶舱
│   ├── audit-project.html               # 审计项目
│   ├── audit-documents.html             # 资料舱
│   ├── audit-chat.html                  # 智能问答
│   ├── audit-checks.html                # 核对程序
│   ├── audit-findings.html              # 疑点台账
│   ├── audit-bid-clearing.html          # 清标分析
│   ├── audit-bid-clearing-detail.html   # 清标任务详情
│   ├── ai-model-config.html             # 模型配置
│   ├── css/
│   └── js/
│
├── docs/screenshots/                    # 产品预览截图
└── docs/bid-clearing-samples/           # 清标测试资料包（3 组）
```

---

## 🤝 参与贡献

欢迎通过 Issue 与 Pull Request 参与共建：

1. Fork 本仓库并克隆到本地；
2. 从 `master` 新建分支：`git checkout -b feature/your-feature`；
3. 提交改动，遵循现有代码风格（原生 JS、无打包器）；
4. 推送分支并在 Gitee 上提交 Pull Request，描述清楚改动内容与用途。

提交 Issue 时请尽量附上：复现步骤、期望与实际表现、环境（Node/MySQL 版本）与相关日志。

---

## 📞 联系方式

如有问题或合作意向，欢迎联系开发者：

- 微信服务号：**正在走向自律1**（ID：`xiaobawang114AI`）

![微信服务号二维码](docs/qrcode_for_gh.jpg)

---

## 📄 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源协议发布。商用、二次开发请遵循该协议条款，并保留原始版权与许可声明。
