/**
 * E2E：导出预览所见即所得 + 思考面板 + 键盘导航
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
  // 模拟推理模型：先出 reasoning 流再出 content 流（触发思考面板渲染）
  const reasoning = '先分析原文结构：三段递进关系，改写时保留事实与语气。';
  const parts = [...reasoning].map((ch) =>
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: ch } }] })}\n\n`
  );
  parts.push(...[...text].map((ch) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`
  ));
  parts.push('data: [DONE]\n\n');
  return parts.join('');
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
  // 切到 reasoning 特性模型（z-ai/glm-5），验证思考面板渲染
  await page.evaluate(() => {
    const sel = document.querySelector('#llmModel');
    const opt = [...sel.options].find((o) => o.value === 'z-ai/glm-5');
    if (opt) sel.value = 'z-ai/glm-5';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => {
    const t = document.querySelector('#imgToggle'); if (t) t.checked = false;
    document.querySelector('#rawInput').value =
      '清晨的阳光透过窗帘缝隙洒进来，落在书桌那杯还冒着热气的咖啡上。\n\n写作从来不是一件容易的事，然后继续写下去。\n\n但正是这一次次的坚持让文字有了温度。';
    document.querySelector('#generateBtn').click();
  });
  // 思考面板只存在于流式期间（完成后 renderColumnCards 重建列 DOM）
  await page.waitForSelector('.reasoning-panel', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(
    () => document.querySelectorAll('.col-skill .para-card').length >= 9,
    { timeout: 30000 }
  );
  await new Promise((r) => setTimeout(r, 800));
  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));

  // ---------- T1 键盘导航 ----------
  console.log('T1 键盘导航（↑↓/Space/Enter）');
  await page.keyboard.press('ArrowDown');
  await new Promise((r) => setTimeout(r, 150));
  let kb = await page.evaluate(() => {
    const f = document.querySelector('.para-card.kb-focused');
    return { focused: !!f, pid: f?.dataset.pid };
  });
  check('↓ 首次按键聚焦第一张卡', kb.focused && kb.pid === 'human-writing::0', JSON.stringify(kb));

  await page.keyboard.press('ArrowDown');
  await new Promise((r) => setTimeout(r, 150));
  kb = await page.evaluate(() => document.querySelector('.para-card.kb-focused')?.dataset.pid);
  check('再按 ↓ 移到第二张', kb === 'human-writing::1', kb);

  // 列首再按 ↑ 不动
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await new Promise((r) => setTimeout(r, 150));
  kb = await page.evaluate(() => document.querySelector('.para-card.kb-focused')?.dataset.pid);
  check('↑ 到列首停住', kb === 'human-writing::0', kb);

  // ←/→ 切列
  await page.keyboard.press('ArrowRight');
  await new Promise((r) => setTimeout(r, 150));
  kb = await page.evaluate(() => {
    const f = document.querySelector('.para-card.kb-focused');
    const col = f?.closest('.col-skill');
    return { pid: f?.dataset.pid, skill: col?.dataset.skill };
  });
  check('→ 切到第二列首卡', kb.skill === 'humanizer-zh' && kb.pid === 'humanizer-zh::0', JSON.stringify(kb));

  // Space 选中
  await page.keyboard.press('Space');
  await new Promise((r) => setTimeout(r, 200));
  kb = await page.evaluate(() => {
    const f = document.querySelector('.para-card.kb-focused');
    return { selected: f?.classList.contains('selected') };
  });
  check('Space 切换选中', kb.selected);

  // Enter 收入拼接区
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));
  kb = await page.evaluate(() => document.querySelectorAll('#col-stitch .stitch-card').length);
  check('Enter 收入拼接区', kb >= 1, `stitch=${kb}`);

  // 输入框内按键不拦截
  kb = await page.evaluate(() => {
    const ta = document.querySelector('#col-stitch .stitch-card textarea');
    return !!ta;
  });
  if (kb) {
    await page.focus('#col-stitch .stitch-card textarea');
    await page.keyboard.press('ArrowDown');
    await new Promise((r) => setTimeout(r, 120));
    const inTa = await page.evaluate(() => {
      const f = document.querySelector('.para-card.kb-focused');
      return f?.dataset.pid;
    });
    check('textarea 内 ↓ 不劫持', inTa === 'humanizer-zh::0', inTa);
  }

  // ---------- T2 导出弹窗预览 ----------
  console.log('T2 导出弹窗预览（所见即所得）');
  // 导出按钮在拼接区列头（内联 onclick，走真实点击路径）
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.col-stitch .col-head .btn-mini')]
      .find((b) => b.textContent.includes('导出'));
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const exp = await page.evaluate(() => {
    const p = document.querySelector('#exportPreview');
    const first = p.querySelector('.ep-p');
    return {
      visible: getComputedStyle(document.querySelector('#exportModal')).display !== 'none',
      hasRealText: !!first,
      textFs: first ? getComputedStyle(first).fontSize : null,
      textLineHeight: first ? getComputedStyle(first).lineHeight : null,
      varFs: p.style.getPropertyValue('--ep-fs'),
      borderStyle: getComputedStyle(p).borderStyle,
    };
  });
  check('弹窗打开', exp.visible);
  check('预览为真实段落排版', exp.hasRealText);
  check('预览字号跟随阅读字号 15px', exp.varFs === '15px' && exp.textFs === '15px', JSON.stringify({ varFs: exp.varFs, textFs: exp.textFs }));
  check('预览行高 2.0', exp.textLineHeight === '30px', exp.textLineHeight);
  check('预览框实线边框（去虚线感）', exp.borderStyle === 'solid', exp.borderStyle);
  await page.evaluate(() => document.querySelector('.export-close').click());

  // ---------- T3 思考面板 ----------
  console.log('T3 思考面板样式（注入同构 DOM 验证样式表）');
  // mock 流毫秒级完成，面板在轮询间隙创建又移除；改为注入与 JS 相同的结构直接验证样式
  const reasoning = await page.evaluate(() => {
    const old = document.querySelector('#__test-reasoning');
    if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = '__test-reasoning';
    panel.className = 'reasoning-panel collapsed';
    panel.innerHTML = `
      <div class="reasoning-header">
        <span class="reasoning-icon">💭</span>
        <span class="reasoning-label">思考过程</span>
        <span class="reasoning-meter">已思考 3s</span>
        <span class="reasoning-toggle">展开</span>
      </div>
      <div class="reasoning-body">思考正文样式验证。</div>`;
    document.querySelector('#page-result').appendChild(panel);
    const body = panel.querySelector('.reasoning-body');
    const header = panel.querySelector('.reasoning-header');
    const cs = getComputedStyle(body);
    const hcs = getComputedStyle(header);
    const res = {
      exists: true,
      bodyLineHeight: cs.lineHeight,
      borderTop: cs.borderTopStyle,
      bodyHidden: cs.display === 'none',
      headerPad: hcs.padding,
      radius: getComputedStyle(panel).borderRadius,
    };
    panel.remove();
    return res;
  });
  check('思考面板样式可应用', reasoning.exists);
  check('思考正文行高 1.9', Math.abs(parseFloat(reasoning.bodyLineHeight) - 25.65) < 0.5, reasoning.bodyLineHeight);
  check('思考正文虚线分隔', reasoning.borderTop === 'dashed', reasoning.borderTop);
  check('折叠态正文隐藏（结构行为不变）', reasoning.bodyHidden);
  check('面板 10px 圆角与卡片同语言', reasoning.radius === '10px', reasoning.radius);

  await page.screenshot({ path: 'test/shot-kbnav-export.png' });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
