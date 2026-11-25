/**
 * 答题引擎 —— 处理「作业 / 随堂练习 / 测试」这类题目型任务。
 *
 * 与情景对话的区别：
 * - 对话是开放式的，一轮一轮问答；
 * - 题目型是**结构化**的：题干 + 选项 + 一次提交。
 *
 * 所以流程是「解析题目 → 模型批量作答 → 回填选项 → 提交智能分析」，
 * 而不是逐轮对话。
 *
 * 支持题型：单选、多选、判断。填空/简答单独处理（文本框直接写）。
 */
import { createLogger } from './logger.mjs';

const log = createLogger('quiz');

/* ------------------------------------------------------------------ */
/* 题目解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从当前页面解析出所有题目。
 *
 * 学习通作业/测验页的通用特征：
 * - 每题一个容器，里面成组出现 `input[type=radio]`（单选）或 `checkbox`（多选）；
 * - 题干在容器内的标题节点里，选项文字紧跟在 input 的 label 里。
 *
 * 因为不同课程模板略有差异，这里做**结构启发式**：
 * 先按 input 的 name 分组，每组算一题；题干取该组容器里最长的那段非选项文本。
 *
 * @param {import('playwright').Page | import('playwright').Frame} target
 */
export async function extractQuestions(target) {
  return target.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // 1. 收集所有可选项 input，按 name 分组
    const inputs = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    if (!inputs.length) return [];

    const groups = new Map();
    for (const inp of inputs) {
      const name = inp.name || inp.getAttribute('data-name') || 'default';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(inp);
    }

    const questions = [];
    let idx = 0;

    for (const [name, group] of groups) {
      idx += 1;
      // 2. 找这组 input 的共同容器（往上爬，直到容器里包含了整组）
      let container = group[0].parentElement;
      for (let i = 0; i < 8 && container; i += 1) {
        const inside = group.filter((g) => container.contains(g)).length;
        if (inside === group.length) break;
        container = container.parentElement;
      }
      if (!container) continue;

      // 3. 选项：每个 input 对应的文字
      const options = group.map((inp, i) => {
        // label 优先，其次父节点文字
        const label = inp.closest('label') || inp.parentElement;
        let text = clean(label?.innerText || '');
        // 去掉前置的 "A." "A、" 之类
        text = text.replace(/^[A-Z][.、．)\s]+/, '').trim();
        if (!text) {
          // 退：找兄弟文本节点
          const sib = inp.nextSibling;
          text = clean(sib?.textContent || '');
        }
        return {
          index: i,
          letter: String.fromCharCode(65 + i),
          text,
          value: inp.value || String.fromCharCode(65 + i),
        };
      });

      // 4. 题干：容器全文去掉所有选项文字后，最长的一段
      const fullText = clean(container.innerText || '');
      let stem = fullText;
      for (const o of options) {
        if (o.text && o.text.length > 1) stem = stem.split(o.text).join(' ');
      }
      stem = clean(stem).slice(0, 400);

      const type = group[0].type === 'checkbox' ? 'multiple' : 'single';
      if (!stem) continue;

      questions.push({
        index: idx,
        name,
        type,
        stem,
        options,
      });
    }

    // 5. 判断题：radio 只有两个且选项是「对/错」「正确/错误」
    for (const q of questions) {
      if (q.options.length === 2 && q.options.every((o) => /^(对|错|正确|错误|是|否|true|false)$/i.test(o.text))) {
        q.type = 'judge';
      }
    }

    // 6. 填空题 / 简答题：独立 textarea
    const textareas = [...document.querySelectorAll('textarea')].filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width > 0 && !t.disabled;
    });
    for (const ta of textareas) {
      idx += 1;
      let container = ta.parentElement;
      for (let i = 0; i < 6 && container; i += 1) {
        if (clean(container.innerText || '').length > 10) break;
        container = container.parentElement;
      }
      questions.push({
        index: idx,
        name: '',
        type: 'text',
        stem: clean(container?.innerText || '').slice(0, 400),
        options: [],
        textarea: true,
      });
    }

    return questions;
  });
}

/* ------------------------------------------------------------------ */
/* 作答                                                                */
/* ------------------------------------------------------------------ */

const ANSWER_SYSTEM =
  '你是学科答题助手。你会收到若干道选择题，请逐题给出答案。' +
  '只输出 JSON 数组，不要任何解释、不要 markdown 代码块。' +
  '每项形如 {"index":1,"answer":"A"} 或 {"index":2,"answer":"AC"}（多选题按字母升序拼接）。';

/**
 * 用模型批量作答。
 *
 * @param {import('./llm.mjs').LlmClient} llm
 * @param {Array} questions
 * @param {object} config
 * @returns {Promise<Map<number, string>>} index → 答案字母串
 */
export async function solveQuestions(llm, questions, config) {
  const choice = questions.filter((q) => q.type !== 'text');
  const answers = new Map();
  if (!choice.length) return answers;

  // 分批，避免单次上下文过大
  const BATCH = 6;
  for (let i = 0; i < choice.length; i += BATCH) {
    const batch = choice.slice(i, i + BATCH);
    const payload = batch.map((q) => ({
      index: q.index,
      type: q.type === 'judge' ? '判断' : q.type === 'multiple' ? '多选' : '单选',
      stem: q.stem,
      options: q.options.map((o) => `${o.letter}. ${o.text}`),
    }));

    let raw;
    try {
      raw = await llm.chat({
        system: ANSWER_SYSTEM,
        user: JSON.stringify(payload) + '\n\n请按 {"index":n,"answer":"X"} 的数组返回全部答案。',
      });
    } catch (err) {
      log.warn(`批量作答失败：${err.message}`);
      continue;
    }

    // 从回复里抠 JSON 数组
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      log.warn(`模型未返回 JSON：${raw.slice(0, 120)}`);
      continue;
    }
    try {
      const arr = JSON.parse(m[0]);
      for (const item of arr) {
        const idx = Number(item.index);
        const ans = String(item.answer || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (Number.isFinite(idx) && ans) answers.set(idx, ans);
      }
    } catch {
      log.warn('答案 JSON 解析失败');
    }
  }

  log.info(`批量作答完成：${answers.size}/${choice.length} 题`);
  return answers;
}

/**
 * 把答案回填到页面（点选）。
 *
 * @returns {Promise<number>} 成功点选的题数
 */
export async function applyAnswers(target, questions, answers) {
  return target.evaluate(
    ({ qs, ans }) => {
      let filled = 0;
      const byName = new Map();
      for (const inp of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        const n = inp.name || 'default';
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(inp);
      }

      for (const q of qs) {
        const letters = ans[q.index];
        if (!letters) continue;
        const group = byName.get(q.name);
        if (!group?.length) continue;

        const wanted = letters.split('');
        let hit = 0;
        for (const inp of group) {
          const label = inp.closest('label') || inp.parentElement;
          const txt = (label?.innerText || '').replace(/\s+/g, ' ').trim();
          const letter = (txt.match(/^([A-Z])[.、．)/]/) || [])[1];
          if (!letter) continue;
          if (!wanted.includes(letter)) continue;
          if (!inp.checked) inp.click();
          hit += 1;
        }
        if (hit) filled += 1;
      }
      return filled;
    },
    { qs: questions, ans: Object.fromEntries(answers) },
  );
}

/** 找提交按钮并点击（可选二次确认）。 */
export async function submitWork(target) {
  return target.evaluate(() => {
    const cands = [...document.querySelectorAll('button, a, div[role=button], input[type=submit]')].filter((e) => {
      const t = (e.textContent || e.value || '').trim();
      return /^(提交|提交作业|交卷|保存并提交|立即提交)$/.test(t);
    });
    if (!cands.length) return false;
    cands[cands.length - 1].click();
    return true;
  });
}
