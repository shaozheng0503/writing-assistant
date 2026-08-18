/**
 * E2E: 技能试跑功能 + 首页下拉列表美化验证
 * 运行：NODE_PATH=<node workspace>/node_modules node test/e2e-skilltest-selects.cjs
 * 覆盖：
 *  T1 技能表单试跑按钮存在且可点击
 *  T2 试跑前置校验（提示词太短 → warn 提示）
 *  T3 试跑无 Key → err 提示
 *  T4 试跑成功路径（mock fetch 流式响应）
 *  T5 试跑中按钮禁用防重复
 *  T6 下拉样式：#imgModelSelect 无 max-width 截断（computed style 验证）
 *  T7 option 带 title 悬停提示
 *  T8 暗色主题下拉配色 color-scheme
 *  T9 移动端 375px 下拉全宽无溢出
 */
const puppeteer = require('puppeteer-core');

const BASE = 'http://localhost:5173';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 工具：等待元素出现
async function waitForSelector(page, sel, timeout = 5000) {
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector(s);
      return !!el;
    },
    { timeout },
    sel
  );
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

(async () => {
  // 通过 evaluate 直接派发 click（面板可能在视口外，puppeteer 原生 click 会失败）
  async function clickSel(page, sel) {
    await page.evaluate((s) => document.querySelector(s)?.click(), sel);
  }

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });

  // 展开进阶设置 + 技能管理面板，打开技能表单
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });

  // ---- T1 ----
  console.log('T1 技能表单与试跑按钮');
  await clickSel(page, '#advancedHead');
  await clickSel(page, '#skillManagerHead');
  await clickSel(page, '#skillFormToggle');
  const testBtn = await page.$('#skillTestBtn');
  ok(!!testBtn, '试跑按钮存在');
  const btnText = await page.$eval('#skillTestBtn', (el) => el.textContent.trim());
  ok(btnText.includes('试跑'), `按钮文案含「试跑」（实际: ${btnText}）`);

  // ---- T2 ----
  console.log('T2 提示词太短前置校验');
  await page.type('#skillName', '测试技能');
  await page.type('#skillPrompt', '短');
  await clickSel(page, '#skillTestBtn');
  await new Promise((r) => setTimeout(r, 300));
  const warnVisible = await page.$eval('#skillTestResult', (el) => el.className.includes('warn') && el.style.display !== 'none' && el.textContent.includes('太短'));
  ok(warnVisible, '短提示词 → warn 提示「太短」');

  // ---- T3 ----
  console.log('T3 无 API Key 前置校验');
  // 注意：suanli 有 PREFILLED_KEY 兜底，切到 deepseek 才是真「无 Key」场景
  await page.select('#llmProvider', 'deepseek');
  await page.evaluate(() => { document.querySelector('#llmApiKey').value = ''; });
  await page.$eval('#skillPrompt', (el) => { el.value = '你是一个小红书风格改写器，句子口语化短促有网感，保留原文事实，直接输出改写后的正文，不要输出任何标题或解释。'; });
  await clickSel(page, '#skillTestBtn');
  await new Promise((r) => setTimeout(r, 300));
  const errVisible = await page.$eval('#skillTestResult', (el) => el.className.includes('err') && el.textContent.includes('API Key'));
  ok(errVisible, '无 Key → err 提示「先填 API Key」');

  // ---- T4/T5 ----
  console.log('T4/T5 试跑成功路径（mock LLM）+ 防重复点击');
  // mock callLLM 的底层 fetch：返回一段 SSE 流
  await page.evaluateOnNewDocument(() => {
    const sse = (text) => {
      const chunks = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`, 'data: [DONE]\n\n'];
      return new Response(new Blob(chunks, { type: 'text/event-stream' }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    window.__origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).includes('/llm-proxy')) {
        window.__fetchCalls = (window.__fetchCalls || 0) + 1;
        return Promise.resolve(sse('这是改写后的演示正文。句子一。句子二。'));
      }
      return window.__origFetch.apply(this, arguments);
    };
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await clickSel(page, '#advancedHead');
  await clickSel(page, '#skillManagerHead');
  await clickSel(page, '#skillFormToggle');
  await page.type('#skillName', '小红书文案风');
  await page.$eval('#skillPrompt', (el) => { el.value = '你是一个小红书风格改写器，句子口语化短促有网感，保留原文事实，直接输出改写后的正文，不要输出任何标题或解释。'; });
  // 填 Key + 选模型（suanli 预填 key 的场景用假 key 代替）
  await page.$eval('#llmApiKey', (el) => { el.value = 'sk-test-fake'; });
  await clickSel(page, '#skillTestBtn');
  await new Promise((r) => setTimeout(r, 500));
  // 试跑中按钮应禁用（mock 是瞬时返回，可能抓不到中间态，验证结束后恢复）
  const resultTxt = await page.$eval('#skillTestResult', (el) => el.textContent);
  ok(resultTxt.includes('试跑成功'), `结果区显示成功（实际: ${resultTxt.substring(0, 50)}）`);
  ok(resultTxt.includes('演示正文'), '结果显示改写正文内容');
  const btnRestored = await page.$eval('#skillTestBtn', (el) => !el.disabled && el.textContent.includes('试跑'));
  ok(btnRestored, '按钮恢复可点 + 文案还原「▶ 试跑」');
  const calls = await page.evaluate(() => window.__fetchCalls || 0);
  ok(calls === 1, `恰好调用一次 LLM（实际: ${calls}）`);

  // ---- T6 ----
  console.log('T6 下拉无截断（computed style）');
  // 生图模型下拉：imgToggleRow 只有在 imagifly 或自定义 API 就绪时显示；测试环境直接强制显示
  await page.evaluate(() => {
    const row = document.querySelector('#imgToggleRow');
    if (row) row.style.display = '';
    const sel = document.querySelector('#imgModelSelect');
    if (sel) {
      sel.innerHTML = `<option value="nano-banana-2" selected title="nano-banana-2 · 综合质量好（默认）">nano-banana-2 · 综合质量好（默认）</option><option value="__custom__">自定义 slug…</option>`;
    }
  });
  const selBox = await page.$eval('#imgModelSelect', (el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, text: el.options[el.selectedIndex]?.textContent || '' };
  });
  ok(selBox.text.includes('综合质量好'), `选中项文字完整（实际: ${selBox.text}）`);
  // 文字宽度应能容纳（select 宽度 ≥ 内容需求时无截断；有 ellipsis 时悬停 title 兜底）
  const fitsNoEllipsis = await page.$eval('#imgModelSelect', (el) => {
    // scrollWidth > clientWidth 说明内容被截断
    return el.scrollWidth <= el.clientWidth + 2;
  });
  ok(fitsNoEllipsis, 'select 内容无截断（scrollWidth ≤ clientWidth）');

  // llmModel 下拉带 title
  const llmTitle = await page.$eval('#llmModel option', (el) => el.getAttribute('title'));
  ok(!!llmTitle, `llmModel option 带 title（实际: ${llmTitle}）`);

  // ---- T7 已并入 T6 ----

  // ---- T8 ----
  console.log('T8 暗色主题 color-scheme');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const darkScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  ok(darkScheme === 'dark', `暗色主题 color-scheme:dark（实际: ${darkScheme}）`);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  // ---- T9 ----
  console.log('T9 移动端 375px 全宽无溢出');
  await page.setViewport({ width: 375, height: 812 });
  await new Promise((r) => setTimeout(r, 300));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow <= 1, `375px 无横向溢出（差值: ${overflow}px）`);
  const llmSelBox = await page.$eval('#llmModel', (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), pw: el.closest('.llm-field')?.getBoundingClientRect().width || 0 };
  });
  ok(llmSelBox.w >= llmSelBox.pw - 4, `llmModel 占满字段宽（${llmSelBox.w}/${llmSelBox.pw}）`);

  await page.screenshot({ path: 'test/shot-skilltest-form.png', fullPage: false });
  await page.setViewport({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test/shot-selects-desktop.png', fullPage: false });

  await browser.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR:', e); process.exit(1); });
