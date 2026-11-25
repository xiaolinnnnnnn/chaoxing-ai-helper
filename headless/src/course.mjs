/**
 * 刷课引擎 —— 遍历章节课时，把「任务点」逐个过掉。
 *
 * 学习通的任务点结构（实测 + 参考 ocsjs 的实现）：
 *
 * ```
 * 课程页 → 「章节」tab（iframe: studentcourse）
 *   └ .chapter_item[onclick="toOld(courseid, knowledgeid, clazzid, ...)"]
 *        └ 点击 → 主页面切到
 *           https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=…
 *             └ #iframe  ← 任务点内容（视频 / 文档 / 测验）
 *             └ #reportFrame ← 学习进度上报
 * ```
 *
 * 任务点类型靠内容判断，不靠提前知道：
 * - 有 `video` 元素 → 视频，设倍速播放直到结束
 * - 有 `iframe[src*=ananas]` → 可能是音视频模块
 * - 有大段文档正文 → 文档，停留 + 滚动
 * - 有题目 → 走 quiz 引擎
 *
 * ⚠️ 风控（来自 ocsjs 的实战警告）：
 *   高倍速、凌晨刷课、大量并发 都可能导致**学习记录被清空/回退**。
 *   所以倍速默认压到 1.5，并且不做并发。
 */
import { createLogger } from './logger.mjs';

const log = createLogger('course');

/* ------------------------------------------------------------------ */
/* 章节列表                                                            */
/* ------------------------------------------------------------------ */

/**
 * 抓某门课的章节目录（含 knowledgeid，用于跳转）。
 *
 * @param {import('./session.mjs').BrowserSession} session
 * @param {string} courseHref
 */
export async function listChapters(session, courseHref) {
  const page = session.page;
  await page.goto(courseHref, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(5000);

  // 点「章节」
  let frame = null;
  for (let attempt = 0; attempt < 3 && !frame; attempt += 1) {
    const ok = await page
      .evaluate(() => {
        const el = [...document.querySelectorAll('a,li,div,span')].filter(
          (e) => (e.textContent || '').trim() === '章节',
        );
        if (!el.length) return false;
        el[0].click();
        return true;
      })
      .catch(() => false);
    if (!ok) {
      await page.waitForTimeout(2000);
      continue;
    }
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(2000);
      frame = page.frames().find((f) => /studentcourse/.test(f.url()));
      if (frame) break;
    }
  }
  if (!frame) return [];

  // 等目录渲染
  for (let i = 0; i < 8; i += 1) {
    const n = await frame.evaluate(() => document.querySelectorAll('.chapter_item').length).catch(() => 0);
    if (n > 0) break;
    await page.waitForTimeout(2000);
  }

  return frame.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.chapter_item')) {
      const onclick = el.getAttribute('onclick') || '';
      // toOld('courseid', 'knowledgeid', 'clazzid', 0)
      const m = onclick.match(/toOld\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/);
      const title = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!m || !title) continue;
      out.push({
        title: title.slice(0, 60),
        knowledgeid: m[2],
        courseid: m[1],
        clazzid: m[3],
        // 已完成的小节通常带 icon 标记（不同模板类名不一，先按文本/属性兜底）
        done: /已完成|complete/i.test(el.className + ' ' + (el.getAttribute('data-status') || '')),
      });
    }
    // 去重
    const seen = new Set();
    return out.filter((x) => {
      if (seen.has(x.knowledgeid)) return false;
      seen.add(x.knowledgeid);
      return true;
    });
  });
}

/* ------------------------------------------------------------------ */
/* 单章节学习                                                          */
/* ------------------------------------------------------------------ */

/**
 * 学习一个章节（自动识别任务点类型并处理）。
 *
 * @param {import('./session.mjs').BrowserSession} session
 * @param {{ courseid: string, clazzid: string, knowledgeid: string, title: string }} chapter
 * @param {object} options
 * @param {number} [options.rate] 视频倍速，默认 1.5（超过 2 有清空进度风险）
 * @param {number} [options.maxMinutes] 单章节最长停留，默认 30
 * @param {number} [options.docSeconds] 文档停留秒数，默认 20
 * @param {(e: object) => void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 */
export async function studyChapter(session, chapter, options = {}) {
  const {
    rate = 1.5,
    maxMinutes = 30,
    docSeconds = 20,
    onEvent,
    signal,
  } = options;
  const emit = onEvent ?? (() => {});
  const page = session.page;

  const url =
    `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards` +
    `?clazzid=${chapter.clazzid}&courseid=${chapter.courseid}` +
    `&knowledgeid=${chapter.knowledgeid}&num=0&ut=s&cpi=` +
    `${(chapter.cpi || '')}&v=2025-0424-10`;

  emit({ type: 'status', phase: 'chapter-open', message: chapter.title });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6000);

  const result = { title: chapter.title, kind: 'unknown', finished: false, seconds: 0 };
  const startedAt = Date.now();
  const deadline = startedAt + maxMinutes * 60_000;

  /* ---- 定位内容 frame（视频常在子 frame 里） ---- */
  const findVideoFrame = async () => {
    // 主文档优先
    const inMain = await page.evaluate(() => document.querySelectorAll('video').length).catch(() => 0);
    if (inMain > 0) return page.mainFrame();
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.url().startsWith('about')) continue;
      try {
        const n = await f.evaluate(() => document.querySelectorAll('video').length);
        if (n > 0) return f;
      } catch {
        /* 跨域跳过 */
      }
    }
    return null;
  };

  let videoFrame = await findVideoFrame();
  // 有些播放器要等一会儿才挂上 video
  if (!videoFrame) {
    for (let i = 0; i < 4 && !videoFrame; i += 1) {
      await page.waitForTimeout(2500);
      videoFrame = await findVideoFrame();
    }
  }

  /* ---- 视频：设倍速 → 播放 → 等结束 ---- */
  if (videoFrame) {
    result.kind = 'video';
    emit({ type: 'status', phase: 'video', message: `${chapter.title} · 视频 ${rate}x` });

    const play = async () => {
      try {
        return await videoFrame.evaluate((r) => {
          const vids = [...document.querySelectorAll('video')];
          if (!vids.length) return { ok: false, count: 0, list: [] };
          for (const v of vids) {
            v.muted = true;
            try {
              v.playbackRate = r;
            } catch {
              /* ignore */
            }
            v.play().catch(() => {});
          }
          return {
            ok: true,
            count: vids.length,
            list: vids.map((v) => ({ t: v.currentTime || 0, d: v.duration || 0, ended: v.ended })),
          };
        }, rate);
      } catch (err) {
        return { ok: false, count: 0, list: [], error: err.message };
      }
    };

    const first = await play();
    if (!first.ok) {
      result.error = first.error || '播放器没响应';
      return result;
    }

    // 轮询播放进度
    for (;;) {
      if (signal?.aborted) break;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(5000);

      const st = await videoFrame
        .evaluate(() => {
          const vids = [...document.querySelectorAll('video')];
          if (!vids.length) return null;
          return vids.map((v) => ({
            t: Math.round(v.currentTime || 0),
            d: Math.round(v.duration || 0),
            ended: v.ended || (v.duration > 0 && v.currentTime >= v.duration - 1.5),
            paused: v.paused,
          }));
        })
        .catch(() => null);

      if (!st) {
        result.finished = true;
        break;
      }
      result.seconds = Math.round((Date.now() - startedAt) / 1000);
      emit({
        type: 'status',
        phase: 'video',
        message: `${chapter.title} · ${st.map((x) => `${x.t}/${x.d}s${x.paused ? '⏸' : ''}`).join(', ')}`,
      });

      // 被暂停就重新 play
      if (st.some((x) => x.paused && !x.ended)) {
        await play();
      }
      if (st.length && st.every((x) => x.ended || x.d === 0)) {
        result.finished = true;
        break;
      }
    }
    return result;
  }

  /* ---- 文档：停留 + 滚动 ---- */
  const bodyLen = await page
    .evaluate(() => (document.body.innerText || '').replace(/\s+/g, '').length)
    .catch(() => 0);
  if (bodyLen > 100) {
    result.kind = 'doc';
    emit({ type: 'status', phase: 'doc', message: `${chapter.title} · 文档停留 ${docSeconds}s` });

    const endAt = Date.now() + docSeconds * 1000;
    let step = 0;
    while (Date.now() < endAt && !signal?.aborted) {
      step += 1;
      await page.evaluate((n) => {
        window.scrollBy(0, Math.min(600, 200 + n * 30));
      }, step).catch(() => {});
      await page.waitForTimeout(2500);
    }
    result.finished = true;
    result.seconds = docSeconds;
    return result;
  }

  result.kind = 'unknown';
  result.seconds = Math.round((Date.now() - startedAt) / 1000);
  return result;
}
