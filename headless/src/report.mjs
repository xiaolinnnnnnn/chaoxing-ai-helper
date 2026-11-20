/**
 * 运行报告 —— 对齐 cidaren 的「每题归因」思路，这里按轮次归因：
 * 谁提的问、模型答了什么、AI 回了什么、耗时多少。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STOP_REASON_TEXT = {
  MAX_ROUNDS: '达到轮数上限',
  AI_FINISHED: 'AI 给出收尾语',
  NO_MORE_QUESTION: '不再有新提问（实践结束）',
  STUCK: '卡在同一个问题',
  SEND_FAILED: '发送失败',
  LLM_ERROR: '模型调用失败',
  TASK_TIMEOUT: '任务总时长超限',
  ABORTED: '用户中止',
  NO_CHAT_WINDOW: '未找到对话窗口',
  ERROR: '运行异常',
};

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function oneLine(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 渲染 Markdown 报告。 */
export function renderReport(report, config) {
  const lines = [];
  lines.push('# 学习通 AI 实践 · 运行报告');
  lines.push('');
  lines.push(`- 开始：${new Date(report.startedAt).toLocaleString('zh-CN')}`);
  lines.push(`- 时长：${fmtTime(report.durationMs ?? 0)}`);
  lines.push(`- 完成轮次：**${report.totalRounds}**`);
  lines.push(`- 结束原因：${STOP_REASON_TEXT[report.stoppedBy] ?? report.stoppedBy}`);
  if (report.url) lines.push(`- 页面：${report.url}`);
  if (report.error) lines.push(`- 错误：${report.error}`);
  if (report.usage?.calls) {
    lines.push(
      `- 模型调用：${report.usage.calls} 次，` +
        `tokens 输入 ${report.usage.promptTokens} / 输出 ${report.usage.completionTokens}`,
    );
  }
  lines.push('');
  lines.push('## 逐轮明细');
  lines.push('');

  if (!report.rounds?.length) {
    lines.push('_没有产生任何轮次。_');
  } else {
    for (const r of report.rounds) {
      lines.push(`### 第 ${r.round} 轮`);
      lines.push('');
      lines.push(`**AI 提问**：${oneLine(r.question, 300)}`);
      lines.push('');
      lines.push(`**我方作答**：${oneLine(r.answer, 300)}`);
      lines.push('');
      lines.push(`**AI 回复**：${r.reply ? oneLine(r.reply, 300) : '_(未捕获到稳定回复)_'}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`_由 chaoxing-headless 生成 · 模型 ${config.model} · 上限 ${config.maxRounds} 轮_`);
  return lines.join('\n');
}

/** 写报告到磁盘，返回路径。 */
export function writeReport(report, config) {
  const dir = resolve(config.logDir);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = resolve(dir, `report-${stamp}.md`);
  writeFileSync(path, renderReport(report, config), 'utf8');
  return path;
}
