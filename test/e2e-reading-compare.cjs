/**
 * E2E：阅读字号调节 + 分段对比视图改版 + 卡片选中态
 * 复用 mock SSE 拦截（不耗 token）。
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5173';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const MOCK_TEXT =
  '清晨的阳光透过窗帘缝隙洒进来，落在书桌那杯还冒着热气的咖啡上，世界安静得只剩下键盘敲击的声音。\n\n' +
  '写作从来不是一件容易的事，你需要面对空白的页面，面对内心那个不断质疑自己的声音，然后继续写下去。\n\n' +
  '但正是这一次次的坚持让文字有了温度，让每一个认真对待文字的人都值得被认真对待。';

function mockSse(text) {
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
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/llm-proxy')) {
      req.respond({ status: 200, contentType: 'text/event-stream', body: mockSse(MOCK_TEXT) });
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

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    const t = document.querySelector('#imgToggle');
    if (t) t.checked = false;
    document.querySelector('#rawInput').value = `
清晨的阳光透过窗帘缝隙洒进来，落在书桌那杯还冒着热气的咖啡上，世界安静得只剩下键盘敲击的声音。

写作从来不是一件容易的事，你需要面对空白的页面，面对内心那个不断质疑自己的声音，然后继续写下去。

但正是这一次次的坚持让文字有了温度，让每一个认真对待文字的人都值得被认真对待。`;
    document.querySelector('#generateBtn').click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.col-skill .para-card').length >= 9,
    { timeout: 30000 }
  );
  await page.waitForFunction(
    () => document.querySelector('#viewSwitch').style.display !== 'none',
    { timeout: 30000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));

  // ---------- T1 阅读字号调节 ----------
  console.log('T1 阅读字号调节（A-/A+）');
  const fsInit = await page.evaluate(() => ({
    val: document.querySelector('#fsVal').textContent,
    cardFs: getComputedStyle(document.querySelector('.col-skill .para-card')).fontSize,
    downDisabled: document.querySelector('#fsDown').disabled,
    upDisabled: document.querySelector('#fsUp').disabled,
  }));
  check('默认字号 15', fsInit.val === '15' && fsInit.cardFs === '15px', JSON.stringify(fsInit));
  check('默认两键可用', !fsInit.downDisabled && !fsInit.upDisabled);

  await page.click('#fsDown');
  await new Promise((r) => setTimeout(r, 150));
  const fs14 = await page.evaluate(() => ({
    val: document.querySelector('#fsVal').textContent,
    cardFs: getComputedStyle(document.querySelector('.col-skill .para-card')).fontSize,
    lineHeight: getComputedStyle(document.querySelector('.col-skill .para-card')).lineHeight,
    saved: localStorage.getItem('ww_reading_fs'),
    downDisabled: document.querySelector('#fsDown').disabled,
  }));
  check('A− 后 14px 且行高联动 28px', fs14.val === '14' && fs14.cardFs === '14px' && fs14.lineHeight === '28px', JSON.stringify(fs14));
  check('字号持久化 localStorage', fs14.saved === '14', fs14.saved);
  check('到底部档位 A− 禁用', fs14.downDisabled);

  // 连点 A+ 到顶
  for (let i = 0; i < 5; i++) { await page.click('#fsUp'); await new Promise((r) => setTimeout(r, 80)); }
  const fsMax = await page.evaluate(() => ({
    val: document.querySelector('#fsVal').textContent,
    cardFs: getComputedStyle(document.querySelector('.col-skill .para-card')).fontSize,
    upDisabled: document.querySelector('#fsUp').disabled,
  }));
  check('到顶部档位 18 且 A+ 禁用', fsMax.val === '18' && fsMax.cardFs === '18px' && fsMax.upDisabled, JSON.stringify(fsMax));

  // 刷新后持久化
  await page.reload({ waitUntil: 'networkidle0' });
  const fsPersist = await page.evaluate(() => ({
    val: document.querySelector('#fsVal').textContent,
    cssVar: document.querySelector('#page-result').style.getPropertyValue('--reading-fs'),
  }));
  check('刷新后字号保持 18', fsPersist.val === '18' && fsPersist.cssVar === '18px', JSON.stringify(fsPersist));
  // 还原 15 便于截图；刷新会清空生成状态（内存态），重新 mock 生成一次
  await page.evaluate(() => { localStorage.setItem('ww_reading_fs', '15'); window.adjustReadingFs(0); });
  await page.evaluate(() => {
    const t = document.querySelector('#imgToggle');
    if (t) t.checked = false;
    document.querySelector('#rawInput').value = `
清晨的阳光透过窗帘缝隙洒进来，落在书桌那杯还冒着热气的咖啡上，世界安静得只剩下键盘敲击的声音。

写作从来不是一件容易的事，你需要面对空白的页面，面对内心那个不断质疑自己的声音，然后继续写下去。

但正是这一次次的坚持让文字有了温度，让每一个认真对待文字的人都值得被认真对待。`;
    document.querySelector('#generateBtn').click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.col-skill .para-card').length >= 9,
    { timeout: 30000 }
  );
  await page.waitForFunction(
    () => document.querySelector('#viewSwitch').style.display !== 'none',
    { timeout: 30000 }
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));

  // ---------- T2 分段对比视图 ----------
  console.log('T2 分段对比视图（段色导航卡 + ghost 按钮）');
  await page.evaluate(() => document.querySelector('#viewCompareBtn').click());
  await new Promise((r) => setTimeout(r, 400));
  const cmp = await page.evaluate(() => {
    const view = document.querySelector('#compareView');
    const rows = view.querySelectorAll('.cmp-row');
    const sec = view.querySelector('.cmp-sec');
    const btn = view.querySelector('.cmp-row-btn');
    const secCs = sec ? getComputedStyle(sec) : null;
    return {
      visible: getComputedStyle(view).display !== 'none',
      rowCount: rows.length,
      secLeft: secCs ? secCs.borderLeftWidth : null,
      secLeftColor: secCs ? secCs.borderLeftColor : null,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
      btnFull: btn && sec ? Math.abs(btn.offsetWidth - (sec.offsetWidth - 32)) < 24 : false,
    };
  });
  check('对比视图可见', cmp.visible);
  check('对比行数 ≥3', cmp.rowCount >= 3, `rows=${cmp.rowCount}`);
  check('段导航卡左色条 3px 有色', cmp.secLeft === '3px' && !/rgba\(0, 0, 0, 0\)/.test(cmp.secLeftColor), `${cmp.secLeft} ${cmp.secLeftColor}`);
  check('整行收入按钮 ghost 透明底', cmp.btnBg === 'rgba(0, 0, 0, 0)' || cmp.btnBg === 'transparent', cmp.btnBg);
  check('整行收入按钮全宽贴底', cmp.btnFull);
  await page.screenshot({ path: 'test/shot-compare-view.png' });

  // ---------- T3 卡片选中态 ----------
  console.log('T3 卡片选中态（细描边 + 轻底）');
  await page.evaluate(() => document.querySelector('#viewFreeBtn').click());
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    document.querySelector('.col-skill .para-card').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  const sel = await page.evaluate(() => {
    const card = document.querySelector('.col-skill .para-card.selected');
    if (!card) return null;
    const cs = getComputedStyle(card);
    return { boxShadow: cs.boxShadow, bg: cs.backgroundColor, borderColor: cs.borderColor };
  });
  check('点击后卡片进入选中态', !!sel);
  check('选中为 1.5px 细描边', sel && sel.boxShadow.includes('1.5px'), sel && sel.boxShadow);
  check('选中底为轻 accent 底', sel && sel.bg.replace(/\s/g, '') === 'rgba(37,99,235,0.1)', sel && sel.bg);
  await page.screenshot({ path: 'test/shot-result-selected.png' });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
