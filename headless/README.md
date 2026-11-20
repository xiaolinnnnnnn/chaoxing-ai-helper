# chaoxing-headless · 学习通 AI 实践无头引擎

不打开学习通页面，后台自动完成「AI 实践」任务并拿到分数。

原扩展（`../`）要求浏览器开着、扩展在线；这个模块把同一套 DOM 逻辑搬进
**Playwright 无头浏览器**，由 Node 编排，于是可以挂服务器上跑。

工程模式参考 [cidaren-ultimate](https://github.com/IRmsk/cidaren-ultimate)：
CLI + Web 控制台双入口、配置外置、断点/卡点/超时保护、Mock E2E。

---

## 一、它到底在做什么

学习通的「AI 实践」藏在很容易找错的地方，这里先讲清楚（都是实测结论）：

```
课程列表 mooc1.chaoxing.com/visit/interaction
  └ 课程页 → 「任务」tab（iframe: mobilelearn .../stuActiveList）
       └ 只筛 activetype="77" 的行 —— 这才是 AI 实践
            └ 行里 content JSON 给出 stuUrl / publishRelationUuid
                 └ stuUrl → situationalDialogue（准备页，有「开始对话」）
                      └ 点「开始对话」→ situationalDialogue/chat
                           └ 对话 10 轮 → 点 button.finish-button
                                └ 「结束练习并评估」→ 出分数
```

**几个反直觉的点**（踩过才知道）：

| 现象 | 真相 |
| --- | --- |
| 「任务」tab 显示「暂无任务」 | 那是课堂活动（签到/投票/通知）。AI 实践也在「任务」里，只是要筛 `activetype=77` |
| 「AI助教」里没有 AI 实践 | 那是 AI 工具集合（AI科研/陪练/查重），与 AI 实践无关 |
| 对话页找不到「结束」按钮 | `button.finish-button`，**只在对白里已有消息后才渲染**。空对话时不存在 |
| 关了页面不会自动评分 | 必须点「结束练习并评估」，否则不计分 |
| 榜单分数一直是旧的 | 达标分是「多次练习最高分」，多刷几次取最高 |

---

## 二、快速开始

```bash
cd headless
npm install
node esbuild.agent.mjs            # 构建页内 agent
npx playwright install chromium   # 首次
cp .env.example .env              # 填 API Key 与账号
node bin/cxai.mjs serve           # 打开 http://127.0.0.1:5173
```

浏览器打开 `http://127.0.0.1:5173`，四个页签走一遍：

```
① 接口   填 Base URL / API Key / 模型 → 测试连接
② 登录   填手机号 + 密码 → 登录学习通（无头提交）
③ 课程   加载课程 → 点某门课 → 看到 AI 实践任务与分数
④ 任务   跑单条 / 全部做完，看实时进度
```

---

## 三、登录

**账号密码（推荐，全程无头）**

`.env` 填 `CXAI_PHONE` / `CXAI_PASSWORD`，或在网页「② 登录」里填了点登录。

> 实测：`passport2.chaoxing.com` 登录页就是 `#phone` + `#pwd` + `#loginBtn`，
> 初始状态**没有图形验证码**，协议无需勾选，可直接脚本提交。

**短信验证码**

网页「② 登录」→ 切「验证码登录」→ 填手机号 → 获取验证码 → 填码。

> 注意：部分账号在发码前会被要求过滑块/图形验证，此时接口会返回
> `needCaptcha: true` 并提示改用密码。发码与填码必须同一个浏览器会话
> （服务端会保持 5 分钟）。

**登录态为什么会丢（已修）**

学习通的 `_uid` / `UID` / `uf` 全是 **session cookie（无 expires）**，
persistent profile 关闭时不落盘 → 下一个进程被弹回登录页。
现在登录成功会额外导出 `.session.json`（`storageState` 含 session cookie），
启动时自动 `addCookies` 灌回。

另外：判定登录**不能看 `fid`** —— 那是学校机构 ID，未登录也可能存在，
用它判定会伪造「登录成功」。

---

## 四、AI 实践任务的执行

### 单条任务

页面「③ 课程」→ 点课程 → 任务列表里点「跑」。

### 全部做完

点「全部做完」：只跑 `done === false` 的（未做 / 未达标），已 ≥ 达标分的自动跳过。

### 一轮任务的具体动作

```
1. 打开 stuUrl，读现状（分数 / 练习次数 / 达标线 / 情景说明）
2. 已达标 → 记录后跳过
3. 点「开始对话」→ 等 chat 窗口（agent 探测，confidence 0.9）
4. 判断谁先开口：
   - 等 15 秒有 AI 消息 → AI 先开口
   - 没有 → 我方按情景身份起头（如「我是接诊医生，请问您哪里不舒服」）
5. 循环 maxRounds 轮（默认 10）：等提问 → LLM 作答 → 写入 → 发送 → 等回复
   末尾两轮自动引导「给出诊断结论与防治建议」
6. 点 button.finish-button → 等评分
7. 抓分数 + 评语 → 写入反馈库 → 回报任务页核对最终分
```

### 提示词怎么定的

- `CXAI_SYSTEM_PROMPT`：基础人设（简洁、口语化、学生身份）
- 每轮附加**评分要点**：病原体形态 / 生活史 / 致病机制 / 临床表现 / 诊断 / 流行与防治
- 最后两轮附加**收束要求**：给明确诊断 + 治疗与防治
- 再叠加**历史高分评语**（见下节）

---

## 五、自学习：评分反馈闭环

每次评完分，学习通会给评语（优点/不足/建议）。这是免费的监督信号。

```
结束评估 → 抓分数与评语 → 写入 data/feedback.json
         → 下次同类任务，把历史「高分评语」注入提示词
```

- 任务按标题归一化成「类型键」（去掉剩余时间/日期），同一案例不同批次共享经验
- 只回灌 **≥80 分且有评语** 的记录 —— 低分评语说明的是失败做法，会把模型带偏
- 每个类型最多留 6 条，按分数优先

查看学习进度：`GET /api/feedback`，或网页里看。

---

## 六、CLI

| 命令 | 说明 |
| --- | --- |
| `login` | 登录（有账号密码则无头自动） |
| `test` | 测接口连通性 + 拉模型列表 |
| `once` / `run` | 跑对话（旧的单页模式） |
| `status` | 登录态 / 断点 / 配置 |
| `reset` | 清断点 |
| `serve` | Web 控制台 |

`run --predict`：只探测对话结构不作答，站点改版时用它验选择器。

---

## 七、配置（`.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CXAI_BASE_URL` | `https://api.deepseek.com` | 任意 OpenAI 兼容端点 |
| `CXAI_API_KEY` | — | 必填 |
| `CXAI_MODEL` | `deepseek-chat` | |
| `CXAI_PHONE` / `CXAI_PASSWORD` | — | 学习通账号，填了就无头登录 |
| `CXAI_MAX_ROUNDS` | 10 | 每个任务答几轮 |
| `CXAI_ROUND_INTERVAL_MS` | 3000 | 轮间隔，实际带 ±30% 抖动 |
| `CXAI_REPLY_TIMEOUT_MS` | 120000 | 等 AI 说完上限 |
| `CXAI_QUESTION_TIMEOUT_MS` | 180000 | 等下一个提问上限 |
| `CXAI_TASK_TIMEOUT_MS` | 3h | 整任务兜底 |
| `CXAI_HEADLESS` | true | false = 有头，排障用 |
| `CXAI_RESUME` | true | 断点续跑 |

> 手机 / 容器里没有 `DISPLAY`，有头模式起不来，CLI 会直接提示改用账号密码。

---

## 八、Web 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/status` | 运行状态 + 事件 + 断点 |
| GET | `/api/config` | 配置（密钥脱敏） |
| POST | `/api/config` | 保存配置到 `.env` |
| POST | `/api/test-llm` | 测接口 |
| POST | `/api/login` | 账号密码登录 |
| POST | `/api/send-code` / `/api/login-code` | 短信验证码两步登录 |
| GET | `/api/courses` | 课程列表（缓存 10 分钟） |
| POST | `/api/course/detail` | 某课的任务/章节 |
| POST | `/api/ai/tasks` | **某课的 AI 实践任务 + 分数** |
| POST | `/api/run-task` | 跑单条 |
| POST | `/api/run-todo` | 批量跑未达标 |
| POST | `/api/stop` | 停止 |
| GET | `/api/feedback` | 反馈学习库 |
| GET | `/api/reports` / `/api/report` | 运行报告 |

---

## 九、测试

```bash
node esbuild.agent.mjs
node test/mock-e2e.mjs
```

本地 fixture（复刻真实 DOM 结构 + 流式回复 + 收尾语）跑完整链路：
agent 注入 → 探测 → 读提问 → 写入发送 → 等流式回复 → 编排 2 轮 → 收尾判定。
**不需要账号，不联网。**

---

## 十、踩坑清单（给未来的自己）

1. **session cookie**：`_uid` 无 expires，必须 `storageState` 单独存。
2. **`fid` 不是登录凭证**：它是学校 ID，用它判登录会假成功。
3. **课程 URL 的 `enc` 是动态的**：不能手工拼 `stucoursemiddle`，要从课程列表点真实链接。
4. **`/vol/v1` 不是 API**：autodl 的正确端点是 `/api/v1`，`/vol/*` 全是前端路由兜底。
5. **AI 实践 = `activetype=77`**：不是「任务」里的全部条目。
6. **结束按钮只在有消息后出现**：空对话点不到，别以为是页面没有。
7. **不点结束不评分**：关页面等于白跑。
8. **AI 不一定先开口**：要先探测有无消息，没有就自己起头。

---

## 十一、边界

- 不含绕过验证码、伪造指纹、篡改签名的逻辑；登录态是你自己登录出来的。
- 轮间隔抖动只避免固定节奏，不保证任何风控结果。
- 回答质量取决于你接的模型与提示词；`CXAI_SYSTEM_PROMPT` 决定风格。
- 请遵守所在学校与平台的使用条款。
