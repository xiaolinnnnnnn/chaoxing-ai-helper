# 学习通 AI 实践助手（Chaoxing AI Helper）

一个 **Microsoft Edge / Chrome Manifest V3 扩展**，用于自动完成学习通（超星）「AI 实践 / AI 对话」任务：

```
探测对话窗口 → 抓取最新 AI 提问 → 调用 DeepSeek(或任意 OpenAI 兼容端点) 作答
            → 自动写入输入框 → 触发发送 → 检测流式回复完成 → 轮次 +1 → 循环
```

达到设定轮数上限、或 AI 明确收尾后自动停止。

> **免责声明**：本项目仅用于个人学习与技术研究。请遵守所在学校与学习通平台的使用条款。
> 扩展**不包含**任何绕过验证码、伪造浏览器指纹、篡改请求签名的反检测逻辑（详见文末「合规边界」）。

---

## 两种运行形态

本项目现在有两条独立入口，共用同一套 DOM 适配层：

| | 浏览器扩展（本目录） | 无头引擎（[`headless/`](headless/)） |
| --- | --- | --- |
| 运行形态 | Edge / Chrome 扩展 | Node 进程 + Playwright 无头 Chromium |
| 需要打开学习通 | 是 | **否**（首次登录除外） |
| 关掉浏览器 | 任务中断 | 不受影响 |
| 适合 | 边看边跑、临时用 | 挂服务器/手机后台批量跑 |
| 入口 | 工具栏扩展图标 | `node bin/cxai.mjs serve` |

无头引擎把 `src/content/` 下那套已经验证过的 DOM 逻辑（三级选择器探测、侧别判定、
Vue 受控输入框适配、发送三通道校验、流式回复稳定检测）打包成 IIFE 注入页面，
Node 侧只负责编排、LLM 调用、断点与报告。

### 无头引擎能做什么

```
登录（账号密码 / 短信验证码，全程无头）
  → 列出课程 → 进某门课 → 扒出「任务」里的 AI 实践（activetype=77）
       → 读每个任务的当前得分（≥达标分自动跳过）
            → 依次跑：10 轮角色扮演 → 点「结束练习并评估」→ 抓分数与评语
                 → 评语入库，同类任务下次自动参考高分评语
```

详细文档见 [`headless/README.md`](headless/README.md)，其中记录了完整链路和 8 条踩坑清单。

> **实测要点**：AI 实践在「任务」tab 里标记为 `activetype="77"`；作答页是
> `situationalDialogue`（**不是**本文档下文描述的 `taskChain`，那个路径已过时）；
> 评分必须点 `button.finish-button`「结束练习并评估」，且该按钮只在对话有消息后才渲染。

---

## 目录

- [一、核心特性](#一核心特性)
- [二、技术栈](#二技术栈)
- [三、目录结构](#三目录结构)
- [四、快速开始](#四快速开始)
- [五、配置说明](#五配置说明)
- [六、工作原理](#六工作原理)
- [七、本地验证台](#七本地验证台)
- [八、选择器失效排查流程](#八选择器失效排查流程)
- [九、常见问题](#九常见问题)
- [十、验收标准自查](#十验收标准自查)
- [十一、合规边界](#十一合规边界)

---

## 一、核心特性

| 能力 | 说明 |
| --- | --- |
| **跑完整条任务流** | 自动逐个节点推进：情景对话 → 结束评估 → 上传作品 → 下一节点，全程无需手动点击 |
| **自动生成并上传 Word** | 上传节点按页面要求 + 前序节点成果生成 `.docx`，并自动驱动附件选择器上传 |
| **节点类型自动判定** | 以页面类型文案为准（情景对话 / 上传作品），**不假设顺序** —— 第一个节点也可能是上传作品 |
| **跨节点上下文** | 每个节点的问答与作品都会被记录，供后续节点衔接引用 |
| **iframe 全帧注入** | `all_frames: true`，AI 实践窗口无论嵌套多深都能探测到 |
| **三级 DOM 探测** | 用户自定义选择器 → 多级回退候选表 → 结构启发式嗅探 |
| **「最后一条消息是谁发的」判定** | 取最后一条非空消息：是 AI 才读取作答，是我方就等待 —— 不会自己答复自己 |
| **嵌套消息安全** | 只剔除同侧嵌套；`.userAnswer` 嵌在 `.agent` 内也能拆成两条独立消息 |
| **一键诊断** | 面板「诊断」按钮：探测结果 + 每条消息侧别与 DOM 路径，全部打到控制台 |
| **自定义选择器体检 + 自愈** | 失效/点错的配置会被自动忽略，必要时自动清空；不会再把消息解析搞成 0 条 |
| **正文精准提取** | 只取 `.agentAnswer` 正文容器，提问里不会混进「测评专家」这类发言人名 |
| **整页背景资料** | 不只读对话框：把任务介绍、出场角色、完成条件、任务流等页面文字一并交给模型 |
| **免手动刷新** | 扩展加载/更新后自动把内容脚本补注入已打开的学习通标签页（带重复注入护栏） |
| **路由感知探测** | 命中 `taskDialogue/pcDialogue` 等 AI 实践路由时放宽探测门槛并加分，打开页面即可自动开始 |
| **可视化选择器调试** | 页面改版后，点选元素即可保存自定义选择器，无需改代码 |
| **框架受控组件适配** | 原生 value setter + `execCommand('insertText')`，兼容 Vue/React 受控输入框 |
| **写入校验 + 三级重试** | 写入后回读比对，最多 3 次升级重试（含逐字插入） |
| **发送双通道** | 优先点击发送按钮，失败退化 Enter 键（覆写 `keyCode=13` 兼容旧式判断） |
| **回复完成检测** | 文本长度连续稳定 3 次（800ms 间隔）判定流式输出结束，另有超时兜底 |
| **多轮上下文** | 保留最近 20 条对话，回答连贯；Service Worker 重启不丢 |
| **可拖拽悬浮面板** | 状态灯 + 轮次进度 + 开始/暂停/停止/单次触发，Shadow DOM 样式隔离 |
| **自定义端点** | Base URL 可改，一键拉取 `/models` 模型列表，兼容任意 OpenAI 协议端点 |
| **最小权限** | 自定义域名走 `optional_host_permissions` 按需授权，不默认申请 `<all_urls>` |
| **隐私安全** | API Key 仅存于本机 `chrome.storage.local`，源码中不出现任何密钥，也不随账号同步 |

---

## 二、技术栈

选型目标是「当前构建 MV3 扩展最成熟的企业级组合」：

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 构建 | **Vite 7** | 秒级构建、原生 ESM、生态最成熟 |
| 扩展集成 | **@crxjs/vite-plugin 3** | MV3 官方生态事实标准，自动解析 `defineManifest` 并处理多入口 / HMR / `web_accessible_resources` |
| 语言 | **TypeScript 5.9**（`strict`） | 类型安全，跨三层共享协议定义 |
| UI | **React 19** | Popup 与悬浮面板；面板挂载到 Shadow DOM，样式与宿主页面完全隔离 |
| 样式 | 原生 CSS + `?inline` 注入 | 零运行时开销，避免给扩展产物增加体积 |

构建产物 `dist/` 可直接被 `edge://extensions` 以「加载解压缩的扩展」方式加载，**无需任何额外运行时**。

---

## 三、目录结构

```
chaoxing-ai-helper/
├── package.json
├── tsconfig.json                 # 扩展源码类型配置（chrome + DOM）
├── tsconfig.node.json            # 构建脚本类型配置（node）
├── vite.config.ts                # 扩展构建配置
├── vite.mock.config.ts           # Mock 验证台构建配置（与扩展构建隔离）
├── vite.ui.config.ts             # UI 预览台构建配置（含 React 插件）
├── vite.diag.config.ts           # 真实页面诊断包构建配置（IIFE，可 CDP 注入）
├── .gitignore
├── README.md
│
├── public/
│   └── icons/                    # 扩展图标 16/32/48/128
│
├── scripts/
│   ├── gen_icons.py              # 图标生成（可选，产物已入库）
│   ├── inline-html.mjs           # 把构建产物内联成自包含单文件 HTML
│   ├── serve.mjs                 # 零依赖静态服务（显式 MIME，规避 Windows 的 .js 误判）
│   ├── verify-mock.mjs           # 零依赖 CDP 验证器：无头跑 Mock 并断言（npm run verify）
│   ├── probe-real.mjs            # 直连用户浏览器的 DevTools，在真实页面跑诊断（npm run probe:real）
│   ├── _snap.mjs                 # 单次快照：任务流节点 / 对话轮次 / 面板状态
│   └── _verify-live.mjs          # 重载扩展 + 重载页面 + 断言 storage/面板（在线确认测试用）
│   ├── check-ui.mjs              # 无头读真实 DOM 断言面板/弹窗（npm run check:ui）
│   └── zip.mjs                   # 零依赖 zip 打包（发版用）
│
├── mock/                         # Mock 验证台（不参与扩展产物）
│   ├── index.html
│   ├── style.css
│   ├── mock-chat.ts              # 两种类名风格的模拟聊天 DOM + 流式回复
│   └── main.ts                   # 自动化验证脚本
│
├── diag/                         # 真实页面诊断包（不参与扩展产物）
│   └── main.ts                   # 调生产代码跑探测，结果挂到 window.__cxaiDiag()
│
├── preview/                      # UI 预览台（不参与扩展产物）
│   ├── index.html                # 含 chrome.* API 桩
│   ├── preview.css
│   └── main.tsx                  # 渲染真实的 Panel 与 Popup
│
└── src/
    ├── manifest.ts               # MV3 manifest（defineManifest）
    ├── vite-env.d.ts
    │
    ├── types/
    │   └── index.ts              # 全局契约：状态、配置、消息、探测结果
    │
    ├── common/                   # 三层共享的工具层
    │   ├── constants.ts          # 默认配置、存储键、超时与重试常量
    │   ├── logger.ts             # 统一日志（[CX-AI][scope]）+ 环形缓冲
    │   ├── errors.ts             # 带 code / retryable 的业务错误体系
    │   ├── selectors.ts          # 多级回退选择器候选表 + 侧别关键字表
    │   ├── dom-utils.ts          # 查找 / 可见性 / 侧别判定 / 选择器生成 / 等待原语
    │   ├── storage.ts            # chrome.storage 封装 + 字段级强制校验
    │   ├── messages.ts           # 三层通信协议（sendMessage + Port）
    │   └── url-utils.ts          # 课程 ID 解析 / URL 脱敏
    │
    ├── background/               # Service Worker
    │   ├── index.ts              # 通信中枢：worker 注册、指令转发、状态广播
    │   ├── llm-client.ts         # OpenAI 兼容客户端：超时、指数退避重试、模型列表
    │   └── context.ts            # 多轮上下文（chrome.storage.session 持久化）
    │
    ├── content/                  # Content Script（注入到每个 frame）
    │   ├── index.tsx             # 入口：角色划分（worker / panel）、探测循环
    │   ├── detector.ts           # 三级 DOM 探测 + 启发式嗅探 + 置信度打分
    │   ├── observer.ts           # 消息枚举、待答问题抓取、回复完成检测
    │   ├── injector.ts           # 写值（受控组件适配）、发送、结果校验
    │   ├── state-machine.ts      # 轮次状态机
    │   ├── picker.ts             # 选择器调试模式（可视化点选）
    │   ├── bridge.ts             # 与 background 的长连接（含心跳与自动重连）
    │   ├── content.css           # 唯一注入宿主文档的全局样式（十字光标）
    │   └── panel/
    │       ├── Panel.tsx         # 悬浮面板（React）
    │       └── panel.css         # 面板样式（Shadow DOM 内）
    │
    └── popup/                    # 设置弹窗
        ├── index.html
        ├── main.tsx
        ├── App.tsx               # 编排：配置、测试、模型列表、状态轮询、日志导出
        ├── popup.css
        └── components/
            ├── Field.tsx         # 表单字段容器（标签/必填/错误）
            ├── Switch.tsx        # 开关
            ├── StatusCard.tsx    # 运行状态与探测诊断
            ├── ApiSection.tsx    # 接口配置
            ├── BehaviorSection.tsx  # 作答行为
            └── AdvancedSection.tsx  # 调试模式与日志
```

---

## 四、快速开始

### 1. 环境要求

- Node.js **≥ 20.19**（推荐 22 LTS）
- Microsoft Edge **≥ 114**（或 Chrome ≥ 114）
- 一个可用的 API Key（默认为 [DeepSeek 官方](https://platform.deepseek.com/)，也支持任意 OpenAI 兼容端点）

### 2. 构建

```bash
cd chaoxing-ai-helper
npm install
npm run build        # 类型检查 + 产出 dist/
```

其他常用脚本：

```bash
npm run dev          # 监听模式，改代码自动重建
npm run typecheck    # 仅类型检查
npm run ui:build     # 构建 UI 预览台 → ui-preview-dist/index.html（双击即可打开）
npm run mock:build   # 构建 Mock 验证台 → mock-dist/index.html（双击即可打开）
npm run zip          # 打包 dist/ 为 release/chaoxing-ai-helper-2.0.1.zip
```

> 两个预览台的详细用法见 [第七节](#七本地验证台)。

### 3. 加载到 Edge

1. 地址栏打开 `edge://extensions`
2. 打开左下角 **「开发人员模式」**
3. 点击 **「加载解压缩的扩展」**，选择 `chaoxing-ai-helper/dist` 目录
4. 工具栏点击扩展图标 → 打开设置页，填写 **Base URL / API Key / 模型** → 点击「测试连接」→「保存配置」

> ⚠️ **首次安装或重新加载扩展后，请刷新已打开的学习通页面（F5）**。
> Content Script 只在页面加载时注入，未刷新时扩展无法感知该页面。

### 4. 使用

1. 打开学习通 AI 实践页面（例如 `https://mooc2-ans.chaoxing.com/mooc2-ans-vue/taskChain/student/answer?...`）
2. 页面右下角出现**悬浮球**，变成**绿色**表示已探测到对话窗口
3. 点击悬浮球展开面板 → 点击 **「开始」**
4. 面板实时显示：状态灯、当前轮次 `3 / 10`、最近一次提问与作答
5. 达到轮数上限或 AI 收尾后自动停止，面板显示「已完成 N 轮」

面板按钮：

| 按钮 | 行为 |
| --- | --- |
| **开始 / 继续** | 从当前进度连续作答直到上限；出错或暂停后点击可恢复 |
| **暂停** | 中断当前等待，保留轮次进度 |
| **停止** | 中断并回到空闲 |
| **单次** | 只跑一轮，方便先验证效果 |
| **重试 / 跳过本轮** | 出错时出现：重试 = 重跑本轮；跳过 = 放弃当前问题继续 |
| **调试选择器** | 打开可视化点选面板 |
| **清空计数** | 清空当前课程的轮次计数与对话上下文 |

---

## 五、配置说明

全部配置位于扩展弹窗（点击工具栏图标）。

### 接口配置

| 字段 | 必填 | 说明 |
| --- | :---: | --- |
| **Base URL** | ✅ | 接口根地址。默认 `https://api.deepseek.com`。扩展会自动补 `/chat/completions`；填成 `https://api.deepseek.com/chat/completions` 或 `.../v1` 也能被正确规整。 |
| **API Key** | ✅ | 仅保存到本机 `chrome.storage.local`。输入框带「显示/隐藏」切换。 |
| **模型** | ✅ | 输入框带下拉候选。点击 **「获取列表」** 会请求 `{Base URL}/models` 拉取账号可用模型，之后可从下拉框直接选；也可手动输入任意模型名。 |
| **温度** | | 0 ~ 2，默认 `1.0`。越低越稳定。 |
| **单次请求超时** | | 默认 60 秒。 |
| **测试连接** | | 走一次最小对话请求（顺带尝试拉模型列表），返回结果与耗时。 |

> **权限说明**：若 Base URL 不是 DeepSeek 官方域名，点击「保存配置 / 测试连接 / 获取列表」时浏览器会弹出授权提示，请选择**允许**。扩展只为该域名申请权限（最小权限原则），不会申请全站访问。

### 作答行为

> **v1.4.0 起默认值有变化**：`最大轮数` **30**、`打开页面后自动开始` **默认开启**。
> 改默认值只改代码是不够的 —— 老用户浏览器里那份已落盘的旧默认值会继续生效。
> 因此项目内建了**配置版本迁移**（`CONFIG_VERSION` + `LEGACY_DEFAULTS`）：
> 只有当字段值仍等于旧默认值时才升级，不会覆盖用户显式改过的设置。

> 轮数语义：达到「最大轮数」即停止；若 AI 提前收尾（判定不到新提问），
> 则按**实际轮数**结束，不会硬凑到 30 轮。

| 字段 | 默认 | 说明 |
| --- | :---: | --- |
| **System Prompt** | 见下 | 决定回答风格，可一键恢复默认。 |
| **最大轮数** | `10` | 达到即停止，不会再产生新轮次。 |
| **每轮间隔** | `3` 秒 | 两轮之间的最小间隔，用于规避风控。前后端双重限速。 |
| **回复超时** | `90` 秒 | 等待 AI 流式回复的上限。 |
| **等提问超时** | `120` 秒 | 等待 AI 抛出下一个问题的上限；超时视为实践已结束。 |
| **打开页面后自动开始** | 关 | 开启后探测到窗口即自动运行。 |

默认 System Prompt：

```text
你是学习通 AI 实践课的对话助手。请用简洁、口语化、符合学生身份的中文回答，控制在 100-200 字，不要使用 Markdown 列表。
```

### 高级

| 项 | 说明 |
| --- | --- |
| **选择器调试模式** | 开启后**刷新学习通页面**会自动弹出可视化拾取面板（详见[第八节](#八选择器失效排查流程)）。 |
| **导出日志** | 复制最近 400 条 `[CX-AI]` 日志到剪贴板（失败则下载 `.txt`）。 |
| **清空日志** | 清空内存日志缓冲。 |

---

## 六、工作原理

### 三层架构

```
┌──────────────┐  sendMessage   ┌────────────────────┐   Port   ┌─────────────────────────┐
│  Popup (UI)  │ ─────────────► │ Background Service │ ───────► │ Content Script (worker) │
│  设置 / 状态  │ ◄───────────── │  Worker（中枢）     │ ◄─────── │  对话窗口所在 iframe     │
└──────────────┘   轮询状态      └────────────────────┘  状态上报  └─────────────────────────┘
                                        ▲   │
                                        │   │ Port（状态推送 / 指令）
                                        │   ▼
                                 ┌──────────────────┐
                                 │ Content (panel)  │  ← 顶层 frame：悬浮面板
                                 └──────────────────┘
```

**为什么需要 background 做中枢？**

1. **跨域请求**：Content Script 受页面 CORS 限制，无法直连大模型 API；Background 有 `host_permissions`，可以。
2. **iframe 定位**：AI 实践窗口可能在任意子 frame，面板在顶层 frame。指令必须精确转发给「对话窗口所在的 frame」。
3. **SW 存活**：MV3 的 Service Worker 会被回收。长连接（Port）+ 20 秒心跳让它在多轮长任务中保持存活。

**角色划分**：Content Script 注入所有 frame，但——

- 探测到对话窗口的 frame 成为 **worker**，独占驱动状态机（避免多 frame 争抢）；
- 顶层 frame 额外承担 **panel** 角色，渲染悬浮面板；
- 两者可以是同一个 frame（对话就在主文档里）。

### 轮次状态机

```
IDLE → DETECTING → WAITING_QUESTION → CALLING_DEEPSEEK
     → FILLING → SENDING → WAITING_REPLY → (轮次+1) → 循环 or DONE
```

任意环节异常 → `ERROR`（面板变红，提供「重试 / 跳过本轮」）；用户暂停 → `PAUSED`。

### 消息模型：只看「最后一条消息是谁发的」

全部判定收敛到一句话 —— **取最后一条非空消息，看它是我方还是 AI**：

| 最后一条非空消息 | 含义 | 动作 |
| --- | --- | --- |
| **AI** | 这是待作答的提问 | 读取 → 生成答案 → 解锁 → 写入 → 发送 |
| **我方** | 已经作答，正在等 AI 回复 | 什么都不做，继续等 |
| **无** | 页面还没渲染出消息 | 继续等 |

侧别由「**命中哪一组选择器**」直接决定，而不是猜：`.agent` ⇒ AI，`.userAnswer` ⇒ 我方。
选择器全部失效时才退回「关键字加权打分 + 几何位置（左 AI / 右我）」兜底。

### 真实 DOM 结构（CDP 直连实测，2026-09）

学习通 AI 实践的真实对话界面在**同源 iframe** 里：
`…/mooc2-ans-vue/taskChain/student/answer` → 内嵌 `…/taskDialogue/pcDialogue`。
实测结构：

```
.dialogueMain
 ├ .chat > .wrap1000                       ← 消息列表
 │   ├ h3.chapterName                      ← 章节名（非消息）
 │   ├ div.agent                           ← AI 消息（与我方消息是**兄弟节点**）
 │   │   ├ span.agentHead > img            ← 头像
 │   │   └ div.agentRight
 │   │       ├ div.agentName               ← 「测评专家」＝发言人名，不是正文
 │   │       └ div.agentAnswer             ← ★ AI 正文容器
 │   │           └ div.answer_content > p
 │   └ div.user-chat-item                  ← 我方消息包裹层
 │       ├ div.userRight
 │       │   ├ div.userName                ← 「初级分析师」
 │       │   └ div.userAnswer              ← ★ 我方正文
 │       └ span.userHead > img
 └ .bottom.relativeClass
     ├ .roundBx                            ← 轮次提示
     ├ .dialogChapterRoleList              ← 出场角色
     └ .sendMessage.sendMessageActive
         ├ div > textarea.messageInput     ← 输入框（锁定时加 messageInputLock + disabled）
         └ div.sendOptionBtn > span.sendBtn ← 发送
```

两个容易踩的点：

1. **AI 条目里含发言人名**。若直接取整条 `.agent` 的文本，送给大模型的「提问」会变成
   「测评专家 项目启动会现场气氛严肃…」。因此新增 `CONTENT_SELECTORS`：优先只取
   `.agentAnswer` 正文容器；命中不到时退回「取整条但跳过 `.agentName` / 头像 / 时间戳」（`META_SELECTOR`）。
2. **列表容器类名不含任何聊天关键字**（是 `.wrap1000`）。它靠「已识别出消息条目后取共同父级」
   这条结构化推断命中，而不是靠关键字。

### ⚠️ 自定义选择器要做「结构体检」（v1.3.0 修复）

用可视化调试器点选时，很容易点到**最内层的正文段落**（`… > .answer_content > p`）。
如果这种选择器被存成「消息列表」，`collectMessageItems` 会永远返回 0 条 ——
症状正是**「探测成功了，但读不到任何提问、也不作答，什么都不发生」**。

现在保存与加载时都会做体检，不合理的直接忽略并告警：

| 目标 | 体检规则 |
| --- | --- |
| 消息列表 / 根容器 | 不能是 `p / span / a / i / img / h1-h6` 等叶子标签；根容器还必须**真正包含输入框** |
| AI / 用户消息 | 选择器最后一段不能是叶子文本标签（`… > p` 直接判掉）；命中元素必须是有效文本容器 |
| 发送 / 继续按钮 | 文案长度 ≤ 20 且内部不含 `p`/`textarea`/`contenteditable`（挡住「把整块消息当按钮」） |
| 输入框 | 必须是 `textarea` 或 `contenteditable`（原有逻辑） |

另外还有一层**自愈**：若探测到了窗口却解析出 0 条消息，扩展会自动忽略全部自定义选择器重探一次；
只要重探能解析出消息，就说明这份配置确实有害，会**自动清空**并在面板提示
（弹窗「高级」里也有「清除自定义选择器」按钮可手动清）。

### 任务流编排（v2.0 新增）

AI 实践不是单页对话，而是一串**节点**（`…/taskChain/student/answer`）：

```
.flow-card-list
 ├ article.flow-card.is-completed      ← 已完成（含 .task-score）
 ├ article.flow-card.is-current        ← 当前节点（.task-index + .task-type + .task-status）
 └ .unlock-condition                   ← 解锁下一节点条件
      └ .unlock-target > <p>类型</p><h4>标题</h4>   ← 后续节点（尚未渲染成卡片！）
.right-content                          ← 随当前节点切换
 ├ iframe.dialogue-frame                ← 情景对话节点
 ├ .upload-content                      ← 上传作品节点（Vue 组件，不是 iframe）
 └ .completed-view                      ← 评估完成
```

两个**必须知道**的坑：

1. **卡片列表只渲染到当前节点**。后面的节点藏在「解锁下一节点条件」的
   `.unlock-target` 里（`<p>` 是类型、`<h4>` 是标题）。不把它们算进来，
   就无法判断「整条任务流是否真的做完了」。
2. **节点类型文案夹着序号**：`.task-type` 内部是
   `<span class="task-index">02</span><span>情景对话</span>`，
   直接取外层文本会得到「02情景对话」，必须剔除序号那一节。

编排流程（`content/flow-runner.ts`）：

```
扫描任务流 → 逐个节点
   ├ 对话节点：确保对话 iframe 存在 → 让对话 frame 开始对话
   │            → 轮询其状态到 DONE → 下发 FINISH_DIALOGUE 触发评估
   └ 上传节点：按「作品要求 + 前序节点记录 + 整页文字」生成 .docx
                → 点「选择文件」→ 附件选择器里自动上传 → 点「开始评估」
→ 等节点被标记「已完成」→ 切到下一个未完成节点 → 循环
```

### 上传作品节点是怎么自动化的

上传节点**没有** `input[type=file]`：它的「选择文件」只是
`$emit('open-file-picker')`，父组件把 `iframe.file-picker-iframe` 指向超星通用附件选择器：

```
{origin}/mooc2-ans/attCommon/s?courseId=…&cpi=…&type=0&fileTypes=doc,docx&visibleTabs
```

那个页面（标题「添加附件」）里才有真正的文件输入：

```
#attCommonApp > .modal > .modal-cont
 ├ .tab-box > .tab-item（本地上传 / 云盘）
 ├ .upload-box > input[type=file].attCommonUploadBtn   ← ★ accept=".doc,.docx"
 └ .modal-btn.flex.modal-btn-tip > .flex（取消 / 确定）
```

点「确定」时页面会调用全局 `attCommonConfirm(json)`，其实现是
`window.parent.postMessage({ type: 'attachmentConfirm', data }, '*')` ——
所以只要把文件写进输入框、再点「确定」，宿主页面就会自己把文件挂到作品卡片上，
**不需要伪造上传请求**。

选择器页面与主站**同源**，因此 `all_frames: true` 的内容脚本会被注入进去，
`content/file-picker-frame.ts` 可以直接接管它：

```
base64 → File → DataTransfer 写进 input.files → 派发 change
      → 等列表出现该文件 → 勾选 → 点「确定」
```

### Word 文档怎么生成

用成熟库 **`docx`（dolanmiu）** 生成，而不是手写 ZIP + XML
（手写容易产出 Word 打不开的残次品，而站点还会对文档做智能批注解析）。

生成位置在 **background（Service Worker）**：

- 内容脚本会注入到页面每个 frame，把几百 KB 的打包体积摊到每个 frame 是浪费；
- background 只有一个实例，且 `docx` 不依赖 DOM（`Packer.toBase64String` 在无 DOM 环境已验证可用）。

模型只负责产出**内容结构**（JSON：标题 + 若干小节 + 段落/列表），
渲染交给 `buildDocx()`。模型偶尔会忘记 JSON、直接给 Markdown，
`parseDocumentSpec()` 会退化为轻量 Markdown 解析，避免整条链路因格式问题失败。

生成结果暂存到 `chrome.storage.session`（而非走消息通道），
文件选择器 frame 自行读取 —— 不必把几十 KB 的 base64 来回搬。

### 页面背景资料（不只读对话框）

AI 实践的评分依据常常写在对话框之外：任务介绍、出场角色说明、任务完成条件、
任务流 / 章节名。只把「最后一条提问」丢给模型，回答容易偏离任务要求。

因此每轮请求前会采集一次**整页文字**：

- 取整个 frame 的可见文本，**排除消息列表子树**（否则会和「提问 + 历史」重复吃 token）；
- 按行去重、截断到 `PAGE_CONTEXT_MAX_CHARS`（默认 1600 字）；
- 拼进 **system 消息**（不额外加一条 system —— 部分兼容 OpenAI 协议的端点只接受一条）；
- 每轮重新采集，所以「已完成 3 / 25 轮」这类动态内容也是最新的。

> 排除消息列表这一步很容易漏：如果只做「取 body 文本」，整段对话会被重复塞进提示词，
> 既浪费 token 又可能让模型误以为要复述历史。测试里专门有一条断言反向校验这一点。

### 进入「即将作答」的节点（不能点卡片）

任务流里后续节点会被渲染成 `article.flow-card.is-upcoming`，状态文案是「即将作答」。
**点卡片是无效的** —— 页面的 `selectTask(task)` 第一行就是 `if (task.upcoming) return;`。
唯一入口是卡片上的 `button.flow-card-enter-btn`「进入任务」，点完会弹出初始化提示，
点其中的 `.init-dialog__btn--primary`「**直接来吧**」才会调 `taskChainInit` 接口，
之后任务流刷新、该节点才变成当前节点。

> ⚠️ 注意：初始化提示的确认按钮文案是「直接来吧」，**不是**「确定」。
> 而且**不要**用「取 footer 里第一个按钮」这种写法 —— 那会点到
> `.init-dialog__btn--secondary`「我再想想」（等于取消）。

### 对话节点：开场页与「同文档路由变化」

选中对话节点后，iframe 先停在**开场页** `pcStudentIndex`（只有角色介绍和一个
「开始对话」按钮），点掉之后才会切到真正的对话界面 `pcDialogue`。

这里有三个必须知道的事实：

1. **开场页没有输入框**，所以 `detectChat()` 返回 `null`。如果只在「探测到对话窗口」
   时才把自己登记成 worker，那么开场页这一帧根本不会被编排器看见，
   编排器下发 `START` 时会直接失败 —— 表现是「对话节点进去了，但永远不开始」。
   因此只要 URL 命中 `taskDialogue/(pcStudentIndex|pcDialogue)` 就先登记为 worker。
2. **切换是 vue-router 的同文档路由变化**，不是重新加载：
   内容脚本**不会**重新注入。所以点完「开始对话」不能「等新文档接管」，
   必须自己轮询等对话界面出现并把状态机拉起来。
3. **注册消息可能早于端口就绪**：内容脚本是同步做探测+注册的，而
   `bridge.connect()` 常在 `reloadSettings()` 之后。所以注册消息会被缓存，
   在端口每次建立/重连后**补发一次**；否则 registration 静默丢失，
   而 `amWorker` 已被置 true，再也不会重试。

4. **被动自动开始**：无论走哪条路径，只要「探测到对话窗口」且「已要求自动开始」，
   内容脚本就会自己把状态机拉起来（每个文档只做一次，用户点过「结束」后不再拉起）。
   这样即使某条指令打在了旧文档上，对话也不会干等。

### 状态槽位必须按 frame 分开

`background` 里原来只有一份 `entry.status`，而**同一个标签页里的任务流宿主与对话 iframe
都会上报状态**，互相覆盖。编排器查询「对话状态」时会读到宿主自己的状态，
于是误判「对话还没开始」并反复重发 START。

现在分为 `entry.workerStatus`（对话 frame）与 `entry.flowStatus`（任务流宿主），
`GET_DIALOGUE_STATE` 只读 `workerStatus`。

### 标签页 ID 要走端口回执，不能靠 `tabs.query` 猜

编排器需要 tabId 才能把指令路由到本标签页的对话 frame。
`chrome.tabs.query({ url: ['*://*.chaoxing.com/*'] })[0]` 在同时开着
「个人空间 / 课程页 / AI 实践」等多个学习通标签页时**可能返回别的标签页**（顺序不保证），
指令就被发到错误的地方。现在端口建立时 background 会回执 `tabId`
（`PORT_MSG.WELCOME`），内容脚本优先使用它。

### 输入框解锁（学习通真实站点必需）

学习通 AI 实践的输入框**默认是锁定的**：

| 元素 | 未锁定 | 锁定 |
| --- | --- | --- |
| 输入框 | `textarea.messageInput` | `textarea.messageInput.messageInputLock`（且 `disabled`） |
| 发送按钮 | `span.sendBtn` | `span.sendBtn.optionBtnLock`（点击无效） |
| 解锁按钮 | — | `span.goOnBtnSpan`「继续」 |

因此每轮流程实际是：

```
等待 AI 提问 → ensureInputReady()（检测到锁定就点「继续」，轮询等解锁）
             → 写入 → 发送 → 等待回复
```

**不点「继续」的典型症状就是：探测成功、但什么都不发生。** 扩展会自动处理，
无需手工干预；面板上会显示「输入框已锁定，正在点击「继续」解锁…」。

### 回复完成检测

AI 回复是流式打字机效果，检测策略：

```text
每 800ms 采样「最新一条 AI 消息」的文本长度
连续 3 次长度不变且 > 0  →  判定输出结束
另有 replyTimeoutSec 超时兜底
```

### 输入框写值（受控组件适配）

学习通是 Vue 应用，直接 `el.value = x` **不会**触发框架的 `onChange`。因此：

- `textarea`：通过 `HTMLTextAreaElement.prototype` 上的原生 `value` setter 赋值，再派发 `input` + `change` 事件；
- `contenteditable`：`document.execCommand('insertText')`（这是唯一能触发框架监听的写入路径），失败时降级为直接写 DOM + 手动派发 `InputEvent`；第三次尝试升级为**逐 12 字分段插入（间隔 20ms）**，最接近真人输入。

写入后**回读比对**（归一化换行与空白），最多重试 3 次，全部失败则进入 `ERROR`。

### 发送触发

```text
1. 点击发送按钮（完整 pointerdown/mousedown/pointerup/mouseup/click 事件序列）
2. 未生效 → 派发 Enter 键（keydown/keypress/keyup，并覆写 keyCode=13 兼容旧式判断）
3. 仍未生效 → 先 blur 输入框再点一次发送按钮
4. 全部失败 → SEND_FAILED，进入 ERROR
```

发送成功判据：**消息列表签名变化** 或 **输入框内容被清空/接管**。

---

## 七、本地验证台

项目内置**两个互相独立的预览台**，都不参与扩展产物，也不需要目标站点登录态。

```bash
npm run mock:build && npm run ui:build   # 或 npm run preview:build 一次全建
```

产物是**自包含单文件 HTML**，直接双击用浏览器打开即可（无需起服务）：

| 预览台 | 产物 | 作用 |
| --- | --- | --- |
| **Mock 验证台** | `mock-dist/index.html` | 验证 content 层核心链路（探测 → 写入 → 发送 → 回复检测 → 轮次） |
| **UI 预览台** | `ui-preview-dist/index.html` | 渲染真实的 Popup 与悬浮面板，覆盖全部状态分支 |

### 7.1 Mock 验证台

- **左：模拟对话窗口** —— 可直接手动输入，体验流式回复；
- **右：自动化测试** —— 点击「跑完整 3 轮」会真实调用 content 层模块完成 3 轮闭环并输出逐步日志。

顶部下拉框可切换**六种** DOM 风格：

| 模式 | 用途 |
| --- | --- |
| **学习通真实结构**（默认） | **1:1 还原 `taskDialogue/pcDialogue` 实测结构**（`.wrap1000` / `.agent` / `.agentName` / `.agentAnswer` / `.user-chat-item` / `.userAnswer` / `.sendOptionBtn`），并还原「继续」解锁门禁 —— 这是**回归基准** |
| 对方条目内嵌我方消息 | 另一种可能的层级（我方消息嵌在对方条目内部），用于验证「只剔除同侧嵌套」的规则 |
| 早期猜测结构 | `.agent` / `.userAnswer` 为兄弟节点的简化版 |
| **任务流 + 上传作品** | 复刻任务流页面（卡片 + 解锁条件 + 上传节点）与附件选择器，验证**节点解析**与**附件上传**两条新链路 |
| 类名含关键字 | 走 `SELECTORS` 候选表（`.message-item.left`、`textarea[placeholder*="输入"]` …） |
| 混淆类名 | 类名替换为构建产物哈希，**只**能靠启发式嗅探命中 |

五种模式都会：初始上锁 → 点「继续」解锁 → 写入 → 发送 → 流式回复 → **重新上锁**，
并且每轮断言两件事：

1. 发送后「最后一条消息」必须是我方 → 不得再判定出待答问题（防止自己答复自己）；
2. 回复到达后「最后一条消息」重新变成 AI → 可作为下一轮提问。

另外还会跑两条自检：

1. **失效选择器拦截**：注入一份「把正文段落当成消息列表」的伪配置，断言仍能解析出消息
   （这正是线上踩过的坑）；
2. **页面背景资料**：断言能采集到对话之外的页面文字，且**没有把对话正文混进去**。

自动化脚本会把结果写入 `window.__cxaiMock = { pass, steps }`，便于 CI 或外部工具断言。

#### 无头一行命令跑全部回归

不想开浏览器时，用内置的零依赖 CDP 验证器（Node 22 自带 WebSocket，不需要任何浏览器自动化 CLI）：

```bash
npm run verify:all                          # 六种模式全跑
npm run verify -- realNested                # 只跑某一种模式
CHROME_PATH=/path/to/edge npm run verify    # 指定浏览器
```

它会自己拉起无头浏览器、切模式、跑 3 轮、把逐步日志打印到终端，
并**用退出码表示结果**（0 = 通过），可直接接进 CI。

#### 在「真实学习通页面」上验证（需要一次授权）

Mock 再像也不是真页面。想用**生产代码**直接对着用户真实页面跑，
用 `scripts/probe-real.mjs`：它直连浏览器 DevTools（CDP），在目标 frame 里注入
`diag-dist/diag.js`（由 `diag/main.ts` 打包，内部就是 `detectChat` / `getMessages` 那套生产代码）。

前置条件：用户在自己浏览器打开 `edge://inspect/#remote-debugging`
（Chrome 是 `chrome://inspect/#remote-debugging`），勾选
*Allow remote debugging for this browser instance*。

```bash
npm run diag:build && npm run probe:real
```

> 该模式的浏览器**不提供** `/json/*` HTTP 端点，只开放浏览器级 WebSocket；
> 端口与路径写在 profile 的 `DevToolsActivePort` 里，脚本会自己读。
> 目标页面里 AI 实践对话是**同源 iframe**，所以脚本会逐个候选页面取 frame 树，
> 按 frame 关键字（默认 `pcDialogue`）定位到真正的执行上下文。

### 7.2 UI 预览台

用「扩展 API 桩」替换 `chrome.*`，在普通网页里直接渲染**生产组件**（不改任何业务代码）：

- **左：Popup 设置弹窗** —— 按真实宽度 384px 渲染，可实际输入、触发校验与保存；
- **右：悬浮控制面板** —— 挂载在 Shadow DOM 中（与运行时一致），顶部按钮可切换
  空闲 / 等待回复 / 请求 AI / 已暂停 / 出错 / 已完成 / 未探测到 七种状态，
  面板按钮点击会打印到下方日志区。

改完 `panel.css` / `popup.css` 后跑一次 `npm run ui:build` 打开即可做视觉回归，
不用反复「加载解压缩的扩展 → 打开学习通 → 刷新」。

---

## 八、选择器失效排查流程

学习通前端是构建产物，类名一旦改版，默认候选表可能失效。此时扩展的**启发式嗅探**通常仍能工作；若两者都失败，请按以下流程处理。

### 步骤 0：先看状态

**最省事的一步：点悬浮面板上的「诊断」**。它会把探测结果、消息列表解析结果、
以及**每一条消息的 DOM 路径与识别出的侧别**打印到页面控制台（DevTools → Console，
按 `CX-AI` 过滤）。把以 `[CX-AI]` 开头的行复制出来，问题基本就定位完了。

运行状态下，面板的状态文案会**实时显示「最后一条消息：AI / 我方 / 未知 / 无消息」** ——
这一行就是整个识别逻辑的结论，一眼能确认是否正常：

| 面板显示 | 含义 |
| --- | --- |
| `最后一条消息：AI「…」` | 识别正常，正在读取这条提问并作答 |
| `最后一条消息：我方「…」` | 识别正常，已经答过，正在等 AI 回复 |
| `最后一条消息：无消息` | 消息列表没解析出内容 → 走步骤 2 |
| `最后一条消息：未知` | 侧别判不出来 → 走步骤 2 |

点击扩展图标，看「运行状态」卡片：

- **未探测到对话窗口** → 走步骤 1
- **探测到的消息条数 / AI 与我的条数明显不对**（例如 AI 全是 0）→ 走步骤 2
- **输入框写入失败 / 未检测到新消息** → 走步骤 3

### 步骤 1：打开选择器调试模式

1. 弹窗 → 高级 → 打开 **「选择器调试模式」**
2. **刷新学习通页面（F5）**，页面顶部会自动出现拾取工具条
3. 工具条上的目标顺序建议为：**输入框 → 消息列表 → 对话根容器 → 发送按钮 → 「继续」按钮**
   （带 ● 的为必需项）
   - 先点击工具条上的目标，再点击页面上对应的元素
   - 鼠标悬停时有蓝色高亮框，并实时显示生成的选择器
   - 每点一次会自动跳到下一个未采集的目标
4. 点击 **「保存并应用」** → 选择器写入本地存储并立即重新探测

> 工具条上的 **「自动探测」** 按钮会执行一次启发式嗅探并把命中的选择器直接填入，可作为起点。
> 按 `Esc` 可退出调试模式。工具条上的 **「清空」** 只清空本次采集，不影响已保存的值。

### 步骤 2：AI / 用户消息分不清 / 读不到提问

在调试模式下额外点选 **「AI 消息」** 和 **「用户消息」** 两个目标（各自点一条典型消息即可）。

**学习通真实页的层级要注意**：一轮问答是**一个** `div.agent`，`.userAnswer` 嵌在它**内部**。
所以：

- 「AI 消息」应当点**整条 AI 气泡**（`.agent`），不要点里面的 `.answer_content > p`；
  若点到最内层的 `p`，扩展读到的是段落而不是条目，侧别与顺序都会失准。
- 「用户消息」点 `.userAnswer` 即可。

扩展判定消息侧别的优先级是：

1. **命中哪一组选择器**（`.agent` ⇒ AI，`.userAnswer` ⇒ 我方）—— 最可靠，优先使用；
2. 兜底：类名 / `data-*` / `aria-*` 关键字**加权**打分（自身 ×3 / 父 ×1 / 祖父 ×0.3），
   避免共用容器（如 `.answerList`）主导判定；
3. 再兜底：**几何位置** —— 以消息列表水平中心为界，左 ⇢ AI，右 ⇢ 我方。

若页面把 AI 消息放在右侧（少见），请用自定义选择器强制指定 `messageItemAI` / `messageItemUser`。

> 顺带一提：消息收集**只剔除同侧嵌套**。跨侧嵌套（`.userAnswer` 在 `.agent` 里）必须保留成
> 两条独立消息，否则用户消息会被整片吞掉 —— 这正是 v1.1.0「能探测却读不对」的根因。

### 步骤 3：输入框或发送按钮失效

- 调试模式下重新点选「输入框」与「发送按钮」后保存；
- 若发送按钮命中失败，扩展会自动退化为 **Enter 键发送**，一般无需处理；
- 若页面使用 UEditor 等**在 iframe 内**渲染的编辑器，请确认注入范围：本扩展已声明 `all_frames: true`，编辑器 frame 内同样会运行探测；此时请在**该 iframe 内**打开调试模式点选（先用 DevTools 的 frame 选择器切到对应 frame）。

### 步骤 4：仍然失败？

1. 点面板上的 **「诊断」**（或在弹窗里导出日志），得到 `[CX-AI]` 全链路日志
2. 关注这几行：
   - `[CX-AI][content:detector] 探测完成 source=... confidence=...` —— 是否命中、置信度多少
   - `[CX-AI][content:observer] 消息解析：…` —— **消息条数与每条消息的侧别**（最关键）
   - `[CX-AI][content:state] 等待提问超时，对话快照：…` —— 等不到提问时自动打印的现场
   - `[CX-AI][content:detector] 启发式消息列表打分不足（best=...）` —— 打分与阈值（18）的差距
   - `[CX-AI][content:injector] 第 N 次写入校验不一致` —— 写入是否被框架吞掉
3. 在 `src/common/selectors.ts` 的对应候选数组里**追加**（而不是替换）新的选择器，然后 `npm run build` + 在 `edge://extensions` 点「重新加载」

### 步骤 5：给开发者一份「页面结构快照」

如果上面都定位不出来，把 `docs/console-probe.js` 的全部内容粘到
**AI 实践对话页面**的 DevTools Console 里回车。它会输出一份结构快照
（输入框祖先链、消息条目路径、每条消息的左右侧别与文本、列表容器直接子元素），
只读 DOM、不改动页面、不发网络请求。

把以 `[CX-PROBE]` 开头的输出复制出来即可 —— 有了这份快照，选择器问题基本可以一次修好。

> 候选表的匹配是「按顺序取首个可见命中」，因此**把最精确的选择器放在数组前面**即可提高优先级。

---

## 九、常见问题

**Q：悬浮球不出现 / 一直是灰色？**
A：① 确认是学习通域名页面且 URL 含 AI 实践对话；② 刚安装/重新加载扩展后需 **F5 刷新页面**；③ 弹窗里看「探测」诊断信息，若 `confidence` 为 0 说明确实没找到对话 DOM，走第八节排查。

**Q：弹窗里 Base URL / 模型的下拉点了不展开？**
A：已在 v1.1.0 修复。原生 `<datalist>` 在 Chromium 的扩展弹窗里**不会渲染**，现已改为自绘下拉（点输入框右侧的 ▾ 展开）。若你用的是旧产物，请重新 `npm run build` 并重新加载扩展。

**Q：探测到了对话窗口，但点开始后什么都不发生？**
按顺序查这三点：

1. **自定义选择器被点错了**（最常见，v1.3.0 已修）。
   用可视化调试器点选时很容易点到最内层的正文段落
   （`… > .answer_content > p`）。这种选择器一旦被存成「消息列表」，
   消息解析永远是 0 条 —— 表现正是「探测成功、但什么都不发生」。
   v1.3.0 起会自动体检并忽略这类失效配置，必要时还会自动清空；
   你也可以在弹窗「高级」里手动点 **「清除自定义选择器」**。
2. **输入框锁定**（v1.1.0 已修）。轮到作答前输入框可能是
   `textarea.messageInput.messageInputLock` + `disabled`，并出现 `span.goOnBtnSpan`「继续」，
   必须先点它才能输入，发送按钮此时也是灰的。扩展已内置自动解锁。
3. **消息层级**。真实页面里 AI 消息是 `div.agent`、我方消息是
   `div.user-chat-item > div.userRight > div.userAnswer`，两者是**兄弟节点**；
   AI 条目里还带发言人名（`div.agentName`＝「测评专家」），
   扩展会只取 `div.agentAnswer` 作为提问正文。

**Q：上传作品节点被识别到了，附件选择器也弹出来了，但文件永远传不上去？**
A：已在 v2.0.1 修复，根因有两个，都在「内容脚本读不到会话存储」这一层：
① `chrome.storage.session` 默认只允许可信上下文访问，内容脚本读写会抛
`Access to storage is not allowed from this context`，旧实现 catch 掉之后静默返回 null，
附件选择器 frame 就永远等不到待上传文档；
② 选择器 iframe 由宿主用 `v-show` 控制，弹层没被正常关闭时再次打开**不会重新导航**，
内容脚本也就不会二次注入 —— 只查一次的实现必然错过后面才生成的文档。
现在 background 会调用 `setAccessLevel` 放开权限（并带 local 兜底），
选择器 frame 也会持续轮询等待文档出现。

**Q：上传成功了，但下一个节点进去了却一直不开始？**
A：两点都在 v2.0.1 修了：① 后续节点的卡片是 `is-upcoming`，点卡片无效，
必须点卡片上的「进入任务」并在提示里点「直接来吧」；
② 对话开场页（`pcStudentIndex`）没有输入框，以前不会被登记为 worker，
编排器的 START 无处可去。现在开场页会先登记、点掉「开始对话」、
等对话界面就绪后自行启动状态机。

**Q：消息条数明显不对（AI 全是 0），或面板一直显示「最后一条消息：无消息 / 未知」？**
A：说明消息条目选择器没命中，或点选时点到了过深的节点。用调试模式分别点选
**「AI 消息」**（点整条 AI 气泡的**容器** `div.agent`，**不要**点里面的 `div.answer_content > p`）
与 **「用户消息」**（点 `div.userAnswer`）保存即可。
也可以先点面板上的 **「诊断」**，把控制台里 `[CX-AI]` 开头的行贴出来。

**Q：装好扩展后必须刷新页面（F5）才生效吗？**
A：正常不需要。v1.4.0 起扩展在加载/更新时会主动把内容脚本补注入到**已打开**的学习通标签页
   （`chrome.scripting.executeScript` + 重复注入护栏）。若某次补注入失败（页面还在加载等），
   手动 F5 一次即可。

**Q：为什么回答看起来更贴合任务了？**
A：因为每轮都会把「对话之外的整页文字」（任务介绍、出场角色、完成条件、任务流）作为背景资料
   一起交给模型，而不是只发最后一句提问。背景资料会出现在 system 消息里的
   `【页面背景资料】` 段落中。

**Q：提示「尚未获得 https://xxx 的访问权限」？**
A：你在使用第三方/自建端点。回到弹窗，重新点击「保存配置」并在浏览器弹窗中允许授权即可。

**Q：提示「未配置 API Key」？**
A：点击扩展图标 → 接口配置 → 填写 API Key → 「保存配置」。API Key 是必填项。

**Q：401 / 403？**
A：API Key 无效或已过期。点击「测试连接」复核；注意不要复制到多余空格（校验会直接拦截）。

**Q：429 或频繁失败？**
A：请求过于频繁或余额不足。把「每轮间隔」调到 5~10 秒。

**Q：回复一直显示「AI 正在回复…」然后超时？**
A：学习通侧限流或 AI 回复真的很久。调大「回复超时」；若消息列表里其实已经有完整回复，说明「回复完成检测」没识别到流式结束，请用调试模式重新指定「消息列表」。

**Q：刷新页面后轮次会重置吗？**
A：不会。轮次按课程 ID 分桶保存在 `chrome.storage.local`，刷新/重开浏览器都会恢复。需要归零时点面板或弹窗的「清空当前课程计数」。

**Q：能同时开多个课程页面吗？**
A：可以。轮次计数与对话上下文都按课程 ID 分桶，互不干扰。但同一时间建议只在一个页面上点「开始」。

**Q：会不会把我的 API Key 或答案上传到别处？**
A：不会。除了你配置的那个 Base URL，扩展不向任何第三方发起请求；API Key 只存于本机 `chrome.storage.local`（不参与浏览器账号同步）。

**Q：为什么我的 Edge 提示扩展需要「读取和更改你在 chaoxing.com 上的数据」？**
A：因为要注入 Content Script 才能操作对话 DOM。这是所有同类扩展的必要权限；自定义 API 域名则走按需授权。

---

## 十、验收标准自查

| 验收项 | 实现位置 |
| --- | :--- |
| ☑ 进入 AI 实践页面，扩展自动识别对话窗口（悬浮球变绿） | `content/detector.ts` 三级探测 + `content/index.tsx` 探测循环 |
| ☑ 点击「开始」后自动完成 ≥ 3 轮完整问答，输入框内容与返回一致 | `content/state-machine.ts` + `injector.ts`（写入后回读比对） |
| ☑ `maxRounds=3` 时第 3 轮结束自动停止，不产生第 4 轮 | `state-machine.ts` 主循环 `round >= maxRounds → DONE` |
| ☑ 中途断网进入 ERROR 并提示，恢复网络后可「重试」继续 | `errors.ts` 错误分类 + `state-machine.ts` ERROR 分支 + 面板「重试/跳过本轮」 |
| ☑ API Key 不出现在任何源码文件中 | 仅存 `chrome.storage.local`；全仓可 `git grep "sk-"` 验证 |
| ☑ 页面刷新后配置与轮次计数保留 | `storage.ts`（配置）+ 按课程分桶的计数器 |
| ☑ 多级回退选择器 + 运行时探测 | `common/selectors.ts` + `content/detector.ts` |
| ☑ 选择器调试模式（点选并保存自定义选择器） | `content/picker.ts` + `storage.setOverrides` |
| ☑ 悬浮控制面板（状态灯 / 轮次 / 开始暂停停止 / 折叠悬浮球） | `content/panel/Panel.tsx`；7 种状态已在 UI 预览台逐一渲染验证 |
| ☑ Popup 配置（必填校验 / 模型列表 / 测试连接 / 清空计数 / 调试开关） | `popup/App.tsx` + `popup/components/*`；必填拦截已在 UI 预览台验证（清空 API Key 后保存 → 红字提示 + 字段标红） |
| ☑ 指数退避重试（1s / 3s） | `background/llm-client.ts` `withRetry` |
| ☑ 上下文数组（system + 历史，超 20 条截断） | `background/context.ts` |
| ☑ 代码注释中文 + 关键函数 JSDoc | 全仓 |
| ☑ README（安装 / 配置 / 选择器排查流程） | 本文件 |
| ☑ **识别「最后一条消息是我方还是 AI」，仅当为 AI 时读取并作答** | `content/observer.ts` `getPendingQuestion()`；四种 DOM 模式全部断言通过（含发送后必须判为「我方」、不得重复作答） |
| ☑ **真实层级（`.userAnswer` 嵌在 `.agent` 内）不再丢消息** | `common/dom-utils.ts` `collectMessageItems()` 只剔除同侧嵌套 + `messageTextOf()` 排除对侧子树；回归用例 `mock` 的 `realNested` 模式 |
| ☑ **一键诊断**（探测结果 + 消息侧别 + 每条消息 DOM 路径） | 面板「诊断」按钮 → `content/index.tsx` `runDiagnose()` |
| ☑ **失效自定义选择器不会拖垮识别**（体检 + 自愈 + 手动清除） | `dom-utils.ts` `isPlausible*` / `content/index.tsx` 自愈重探 / 弹窗「清除自定义选择器」；五种模式均含拦截自检 |
| ☑ **提问正文不含发言人名**（只取 `.agentAnswer`） | `selectors.ts` `CONTENT_SELECTORS` + `dom-utils.ts` `messageTextOf()` |
| ☑ **真实页面实测通过**（生产代码 + CDP 注入） | `diag/main.ts` + `scripts/probe-real.mjs`；实测解析出 7 条消息（AI 4 / 我方 3），待答问题正确 |
| ☑ **无头回归验证**（退出码即结果，可接 CI） | `scripts/verify-mock.mjs` + `npm run verify:all` |
| ☑ 默认轮数 30，且 AI 提前收尾时按实际轮数结束 | `constants.ts` `DEFAULT_CONFIG.maxRounds` + 状态机 `DONE` 分支 |
| ☑ 「打开页面后自动开始」默认开启（含老配置迁移） | `constants.ts` + `storage.getConfig` 的 `CONFIG_VERSION` 迁移 |
| ☑ 悬浮面板仅保留 开始 / 暂停 / 结束，去掉「单次」与未探测提示条 | `content/panel/Panel.tsx`；已用无头浏览器读取真实 DOM 校验按钮集合 |
| ☑ 整页背景资料进入提示词，且不吃重复 token | `observer.getPageContext()` + `background/context.buildMessages()`；五种模式均有断言 |
| ☑ 免手动刷新（补注入已打开标签页） | `background/index.ts` `injectIntoOpenTabs()` + `content/index.tsx` 重复注入护栏 |
| ☑ **自动跑完整条任务流**（对话 + 上传，任意顺序） | `content/flow-runner.ts`（编排）+ `content/flow-dom.ts`（解析） |
| ☑ **自动判定节点类型**（情景对话 / 上传作品） | `flow-selectors.classifyNodeType()`；真实页面实测：3 个节点（2 对话 + 1 上传）全部读对 |
| ☑ **自动生成 Word 并上传** | `background/docx.ts`（`docx` 库）+ `content/file-picker-frame.ts`；Mock 断言「文件写入 + 确定回传」 |
| ☑ **未渲染的后续节点也能识别** | `readUpcomingNodes()` 解析 `.unlock-target`；Mock 断言「全部完成」不会误判 |
| ☑ 跨节点上下文衔接 | `storage.getFlowRecords/saveFlowRecord` + `flow-runner.buildPreviousSummary()` |
| ☑ UI 无头回归 | `scripts/check-ui.mjs` + `npm run check:ui`（11 项断言） |

---

## 十一、合规边界

本项目**明确不做**以下事情（与原始需求文档「注意事项」一节一致）：

- ❌ 不绕过任何验证码、人机校验
- ❌ 不伪造浏览器指纹、不修改请求签名
- ❌ 不注入反检测脚本、不模拟设备特征
- ❌ 不内置任何题库、不代刷视频/考试
- ❌ 不收集、不上传用户数据；API Key 不离开本机

扩展只是把「读题 → 调你自己的模型 → 填入输入框 → 点发送」这条**人类本来就会做的操作**自动化。
回答质量取决于你自己的模型与提示词，请以学习为目的合理使用。

---

## 附：开发速查

```bash
npm run dev              # 监听重建（改完到 edge://extensions 点「重新加载」+ F5）
npm run typecheck        # 类型检查（扩展源码 + 构建脚本两份 tsconfig）
npm run build            # 生产构建
npm run build:only       # 跳过类型检查直接构建

npm run mock:build       # 构建 Mock 验证台 → mock-dist/index.html（单文件）
npm run mock:preview     # 起本地服务预览（file:// 打不开时用）
npm run ui:build         # 构建 UI 预览台 → ui-preview-dist/index.html（单文件）
npm run preview:build    # 一次构建两个预览台

npm run verify -- realSite   # 无头跑 Mock 验证台（指定模式），退出码即结果
npm run verify:all           # 六种 DOM 模式全跑，用于回归
npm run check:ui             # 无头读真实 DOM，断言面板按钮/文案/节点行
npm run diag:build           # 构建真实页面诊断包 → diag-dist/diag.js
npm run probe:real           # 用生产代码在真实学习通页面上跑一遍诊断（需浏览器已开远程调试）

npm run zip              # 打包 release/*.zip
npm run icons            # 重新生成图标（需 Pillow）
```

### 维护 `scripts/inline-html.mjs` 时的两个坑

1. **字符串形式的 `String.replace` 会把 `$$` 折叠成 `$`。**
   内联脚本时必须用**函数形式**的替换：
   ```js
   html.replace('</body>', () => `${scriptTag}</body>`);   // ✅
   html.replace('</body>', `${scriptTag}</body>`);         // ❌ 会把 React 的 $$typeof 改成 $typeof
   ```
   这个 bug 不会报错，只会让整个 bundle 在解析时抛出 `Unexpected token '<'`，极难定位。

2. **内联脚本必须插到 `</body>` 之前。** 经典脚本没有 `defer`，留在 `<head>` 会在 body 解析前执行，
   `document.getElementById` 全部返回 `null`。同时脚本里的 `</script` 需要转义成 `<\/script`
   （JS 中 `\/` 与 `/` 等价），否则会提前闭合标签。

调试技巧：

- **Service Worker 日志**：`edge://extensions` → 找到本扩展 → 点击「Service Worker」打开 DevTools
- **Content Script 日志**：在页面 DevTools Console 里按 `CX-AI` 过滤
- **查看存储**：页面 DevTools → Application → Storage → Extension Storage，或 Service Worker DevTools 的 Console 执行 `chrome.storage.local.get(null).then(console.log)`
