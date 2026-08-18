/**
 * E2E：同步滚动重构（驱动者锁 + 段内插值 + -1 段就近映射）
 *      + 分段对比流水线（前置分段 + 逐列对齐 + 进度组件 + 导出提醒）
 * mock SSE 拦截，零 token 消耗。
 *
 * mock 策略：按 system prompt 特征区分请求类型
 * - 「文章结构分析器」→ 分段请求（返回 JSON sections，带逐字 anchor）
 * - 「段落对齐器」→ 对齐请求（返回 JSON 数字数组）
 * - 其他 → 技能改写请求（返回正文）
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5173';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// 原文：6 个自然段，确保分段后各列卡片高度有滚动空间
const PARAS = [
  '一清晨的阳光透过窗帘缝隙洒进来，落在书桌那杯还冒着热气的咖啡上，世界安静得只剩下键盘敲击的声音，我在这样的清晨开始了一天的写作。',
  '二写作从来不是一件容易的事，你需要面对空白的页面，面对内心那个不断质疑自己的声音，然后继续写下去，哪怕一天只能写出几百个字。',
  '三有时候我会想起刚开始写作的日子，那时候每一句话都要改十几遍，删了又写，写了又删，纸篓里堆满了揉皱的草稿纸。',
  '四但正是这一次次的坚持让文字有了温度，让每一个认真对待文字的人，最终都值得被认真对待，这是时间给出的答案。',
  '五后来我明白，写作的意义不在于被多少人看见，而在于你是否诚实地面对了自己的内心，把想说的话说清楚了。',
  '六如今我依然每天写作，不为别的，只为在喧嚣的世界里给自己留一片安静的角落，让思想慢慢地沉淀下来。'
];
const MOCK_RAW = PARAS.join('\n\n');

// 改写输出（三列相同即可）：每段重复加长保证滚动空间
const MOCK_REWRITE = PARAS.map((p, i) => `${p}（改写第${i + 1}版，这段文字被刻意加长以产生足够的滚动空间。` + '内容填充。'.repeat(20) + '）').join('\n\n');

// 分段结果：3 段，anchor 逐字摘自原文
const MOCK_SECTIONS = JSON.stringify([
  { title: '清晨写作', gist: '清晨开始写作的场景', anchor: '一清晨的阳光透过窗帘缝隙洒进来' },
  { title: '坚持的困难', gist: '写作的困难与坚持', anchor: '二写作从来不是一件容易的事' },
  { title: '意义与沉淀', gist: '写作的意义', anchor: '五后来我明白' },
]);

// 对齐结果：6 段落 → [0,0,1,1,2,2]
const MOCK_ALIGN = JSON.stringify([0, 0, 1, 1, 2, 2]);

function sse(text) {
  const chunks = [...text].map((ch) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`
  );
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 600 }); // 矮视口确保列可滚动
  await page.setRequestInterception(true);

  const reqLog = { sections: 0, align: 0, rewrite: 0 };
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/llm-proxy')) {
      let body = '';
      try { body = req.postData() || ''; } catch {}
      if (body.includes('文章结构分析器')) {
        reqLog.sections++;
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_SECTIONS) });
      } else if (body.includes('段落对齐器')) {
        reqLog.align++;
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_ALIGN) });
      } else {
        reqLog.rewrite++;
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_REWRITE) });
      }
      return;
    }
    if (url.includes('/imagifly-proxy')) {
      req.respond({ status: 503, contentType: 'application/json', body: '{"error":"off"}' });
      return;
    }
    req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { await d.dismiss(); }); // 默认取消 confirm

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });

  console.log('T1 分段对比流水线（前置分段 + 进度组件）');
  await page.evaluate((raw) => {
    const t = document.querySelector('#imgToggle');
    if (t) t.checked = false;
    document.querySelector('#rawInput').value = raw;
    document.querySelector('#generateBtn').click();
  }, MOCK_RAW);

  // 生成后立即应有进度组件可见（分段前置启动）
  const earlyChip = await page.evaluate(() => {
    const c = document.querySelector('#cmpProgress');
    return c ? { display: c.style.display, label: c.querySelector('.cmp-label').textContent } : null;
  });
  check('生成开始即显示分段进度组件', !!earlyChip && earlyChip.display !== 'none', JSON.stringify(earlyChip));

  // 等 compare 就绪（列头 sec-hint 出现 = 流水线完成）
  const cmpOk = await page.waitForFunction(
    () => document.querySelectorAll('.col-head .sec-hint').length >= 3,
    { timeout: 30000 }
  ).then(() => true).catch(() => false);
  check('流水线在 30s 内完成（分段+3列对齐）', cmpOk);
  await new Promise((r) => setTimeout(r, 500));

  // 进度组件就绪后隐藏
  const chipAfter = await page.evaluate(() => document.querySelector('#cmpProgress').style.display);
  check('就绪后进度组件隐藏', chipAfter === 'none', chipAfter);

  // 分段请求次数 = 1（前置只跑一次）
  check('分段请求恰好 1 次（前置去重）', reqLog.sections === 1, `sections=${reqLog.sections}`);
  // 对齐请求 ≥3（每列一次）
  check('对齐请求 ≥3 次（逐列触发）', reqLog.align >= 3, `align=${reqLog.align}`);

  const cmpData = await page.evaluate(() => {
    const hints = [...document.querySelectorAll('.sec-hint')].map((h) => h.textContent);
    const badges = document.querySelectorAll('.sec-badge').length;
    return { hints, badges };
  });
  check('三列均有段指示条', cmpData.hints.length === 3, JSON.stringify(cmpData.hints));
  check('卡片带段号徽标', cmpData.badges >= 18, `badges=${cmpData.badges}`);

  console.log('T2 同步滚动：快速拖拽连续跟踪（段内插值）');
  // 模拟快速拖拽：连续多次设置 scrollTop（不等驱动者锁释放）
  const drag = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.col-skill .col-body')];
    const scrollable = bodies.filter((e) => e.scrollHeight > e.clientHeight + 100);
    if (scrollable.length < 2) return { skip: true, info: bodies.map((c) => ({ sh: c.scrollHeight, ch: c.clientHeight })) };
    const src = scrollable[0];
    const dst = scrollable[1];
    src.scrollTop = 0; dst.scrollTop = 0;
    // 快速连续滚动（模拟拖拽滚动条：多个位置一气呵成）
    src.scrollTop = Math.floor(src.scrollHeight * 0.3);
    src.scrollTop = Math.floor(src.scrollHeight * 0.5);
    src.scrollTop = Math.floor(src.scrollHeight * 0.8);
    src.scrollTop = src.scrollHeight; // 拖到底
    return new Promise((resolve) => setTimeout(() => {
      // 检查目标列是否跟到接近底部（驱动者锁不丢事件 + 到底联动）
      const dstRatio = dst.scrollTop / Math.max(1, dst.scrollHeight - dst.clientHeight);
      resolve({ skip: false, dstTop: dst.scrollTop, dstMax: dst.scrollHeight - dst.clientHeight, dstRatio });
    }, 400));
  });
  check('快速拖到底后其余列跟随到底', !drag.skip && drag.dstRatio > 0.85, JSON.stringify(drag));

  // 段内插值：源列滚到段中间，目标列应处于对应段区间内（非段首）
  const interp = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.col-skill .col-body')];
    const scrollable = bodies.filter((e) => e.scrollHeight > e.clientHeight + 100);
    if (scrollable.length < 2) return { skip: true };
    const src = scrollable[0];
    const dst = scrollable[1];
    src.scrollTop = Math.floor(src.scrollHeight * 0.45);
    return new Promise((resolve) => setTimeout(() => {
      resolve({ skip: false, srcTop: src.scrollTop, dstTop: dst.scrollTop });
    }, 350));
  });
  check('中段滚动目标列连续跟随（非冻结）', !interp.skip && interp.dstTop > 0, JSON.stringify(interp));

  console.log('T3 -1 段就近映射（同步不冻结）');
  const negOne = await page.evaluate(() => {
    // 构造：把第一列 assigns 的最后一段改为 -1（新增内容），驱动同步
    const st = window.__ww_state;
    if (!st || !st.compare) return { skip: true, reason: 'no-compare' };
    const skills = Object.keys(st.compare.assigns);
    const sk = skills[0];
    st.compare.assigns[sk][st.compare.assigns[sk].length - 1] = -1;
    const bodies = [...document.querySelectorAll('.col-skill .col-body')];
    const src = document.getElementById('col-' + sk);
    const dst = bodies.find((e) => e.id !== src.id && e.scrollHeight > e.clientHeight);
    src.scrollTop = 0; dst.scrollTop = 0;
    const before = dst.scrollTop;
    // 滚到最后一卡（-1 段）
    src.scrollTop = src.scrollHeight;
    return new Promise((resolve) => setTimeout(() => resolve({ skip: false, before, after: dst.scrollTop, hint: document.getElementById('secHint-' + sk)?.textContent }), 400));
  });
  check('-1 段可见时其余列仍同步（就近映射）', !negOne.skip && negOne.after > 50, JSON.stringify(negOne));
  check('-1 段指示条标注就近同步', !negOne.skip && /新增|就近/.test(negOne.hint || ''), negOne.hint);

  console.log('T4 导出提醒（构建中 confirm）');
  // 清空 compare 模拟构建中，验证 confirm 弹出（dialog handler 默认 dismiss = 取消 → 弹窗不打开）
  const exportBlocked = await page.evaluate(() => {
    const st = window.__ww_state;
    // 模拟构建中：compare 为空 + pipeline 未完成
    st.compare = null;
    window.__ww_pipeline.finished = false;
    return document.querySelectorAll('.para-card').length;
  });
  // 先放一张卡进拼接区
  await page.evaluate(() => {
    const card = document.querySelector('.col-skill .para-card');
    if (card) card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  let dialogSeen = false;
  page.once('dialog', () => { dialogSeen = true; });
  await page.evaluate(() => window.exportText());
  await new Promise((r) => setTimeout(r, 200));
  check('构建中导出弹 confirm 提醒', dialogSeen);
  // confirm 取消 → 弹窗未打开
  const modalOpen = await page.evaluate(() => document.querySelector('#exportModal').style.display !== 'none');
  check('confirm 取消后导出弹窗不打开', !modalOpen);
  // 恢复 compare 后导出无 confirm
  await page.evaluate(() => { window.__ww_pipeline.finished = true; window.__ww_state.compare = { sections: [], assigns: {} }; });
  await page.evaluate(() => window.exportText());
  await new Promise((r) => setTimeout(r, 250));
  const modalOpen2 = await page.evaluate(() => document.querySelector('#exportModal').style.display !== 'none');
  check('compare 就绪后导出直接打开弹窗', modalOpen2);

  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: 'test/shot-sync-pipeline.png' });
  await page.evaluate(() => localStorage.clear());

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
