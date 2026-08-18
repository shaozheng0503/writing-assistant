/**
 * E2E 测试：结果页编辑器风格改版
 * - 拦截 /llm-proxy 返回确定性 mock SSE（不耗 token、速度快）
 * - 拦截 /imagifly-proxy 返回 503（测试关闭配图，双保险）
 * 验证：列头扁平化 / ghost 按钮组 / 段落卡片排版 / sec-hint 独占一行 / 暗色主题 / 移动端
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
  // 按字符切片模拟流式；无 emoji 不涉及代理对问题
  const chunks = [...text].map((ch) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`
  );
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

async function setupPage(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/llm-proxy')) {
      req.respond({ status: 200, contentType: 'text/event-stream', body: mockSse(MOCK_TEXT) });
      return;
    }
    if (url.includes('/imagifly-proxy')) {
      req.respond({ status: 503, contentType: 'application/json', body: '{"error":"off in test"}' });
      return;
    }
    req.continue();
  });
  return page;
}

async function generateWithMock(page) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  // 关闭配图（若开关可见），避免走生图流程
  await page.evaluate(() => {
    const t = document.querySelector('#imgToggle');
    if (t) t.checked = false;
  });
  await page.evaluate((txt) => { document.querySelector('#rawInput').value = txt; }, MOCK_TEXT);
  await page.evaluate(() => document.querySelector('#generateBtn').click());
  // 等三列卡片全部渲染完成
  await page.waitForFunction(
    () => document.querySelectorAll('.col-skill .para-card').length >= 9,
    { timeout: 30000 }
  );
  // 等分段对比构建（sec-hint 注入列头）
  await page.waitForFunction(
    () => document.querySelectorAll('.col-head .sec-hint').length >= 3,
    { timeout: 30000 }
  ).catch(() => {}); // 构建失败不阻塞样式验证
  await new Promise((r) => setTimeout(r, 600));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
  });

  // ---------- T1 桌面端：生成流程 + 列结构 ----------
  console.log('T1 桌面端生成流程与列结构');
  const page = await setupPage(browser, 1440, 900);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await generateWithMock(page);
  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));

  const layout = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('#columnsWrap .col')].map((e) =>
      e.className.includes('col-gallery') ? 'gallery' :
      e.className.includes('col-stitch') ? 'stitch' : 'skill');
    return cols.join(',');
  });
  check('列布局 gallery,skill×3,stitch', layout === 'gallery,skill,skill,skill,stitch', layout);

  const resultVisible = await page.evaluate(() =>
    document.querySelector('#page-result').classList.contains('active'));
  check('结果页已激活', resultVisible);

  // ---------- T2 列头扁平化 ----------
  console.log('T2 列头扁平化（无渐变、ghost 按钮、sec-hint 独占一行）');
  const headStyle = await page.evaluate(() => {
    const head = document.querySelector('.col-skill .col-head');
    const cs = getComputedStyle(head);
    const firstBtn = head.querySelector('.btn-mini');
    const btnCs = getComputedStyle(firstBtn);
    const hint = head.querySelector('.sec-hint');
    return {
      bgImage: cs.backgroundImage,
      bgColor: cs.backgroundColor,
      btnBg: btnCs.backgroundColor,
      btnBorder: btnCs.borderColor,
      btnMarginLeft: parseFloat(btnCs.marginLeft),
      hintBasis: hint ? getComputedStyle(hint).flexBasis : null,
      hintOnOwnRow: hint ? hint.offsetTop > firstBtn.offsetTop : false,
    };
  });
  check('列头无渐变背景', headStyle.bgImage === 'none', headStyle.bgImage);
  check('列头为 surface 底色', headStyle.bgColor === 'rgb(255, 255, 255)', headStyle.bgColor);
  check('列头按钮 ghost（透明底）', headStyle.btnBg === 'rgba(0, 0, 0, 0)' || headStyle.btnBg === 'transparent', headStyle.btnBg);
  check('列头首按钮靠右（margin-left auto）', headStyle.btnMarginLeft > 0, `ml=${headStyle.btnMarginLeft}`);
  check('sec-hint 独占一行', headStyle.hintBasis === '100%' && headStyle.hintOnOwnRow,
    `basis=${headStyle.hintBasis} ownRow=${headStyle.hintOnOwnRow}`);

  // ---------- T3 段落卡片排版 ----------
  console.log('T3 段落卡片编辑器排版');
  const cardStyle = await page.evaluate(() => {
    const card = document.querySelector('.col-skill .para-card');
    const cs = getComputedStyle(card);
    return {
      fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      padding: `${cs.paddingTop} ${cs.paddingLeft}`,
      radius: cs.borderRadius, bg: cs.backgroundColor,
    };
  });
  check('卡片字号 15px', cardStyle.fontSize === '15px', cardStyle.fontSize);
  check('卡片行高 2.0（30px）', cardStyle.lineHeight === '30px', cardStyle.lineHeight);
  check('卡片内边距 16px/20px', cardStyle.padding === '16px 20px', cardStyle.padding);
  check('卡片圆角 10px', cardStyle.radius === '10px', cardStyle.radius);

  // ---------- T4 拼接区 ----------
  console.log('T4 拼接区（空态 + 工具栏 + 收入卡片）');
  const stitch = await page.evaluate(() => {
    const empty = document.querySelector('#col-stitch .stitch-empty');
    const toolbar = document.querySelector('.stitch-toolbar');
    const count = document.querySelector('#stitchCount');
    return {
      hasEmpty: !!empty,
      emptyColor: empty ? getComputedStyle(empty).color : null,
      countRight: count ? parseFloat(getComputedStyle(count).marginLeft) > 0 : false,
      toolbarBg: toolbar ? getComputedStyle(toolbar).backgroundColor : null,
    };
  });
  check('拼接区空态显示', stitch.hasEmpty);
  check('拼接区计数右对齐', stitch.countRight);
  // 双击第一张卡片收入拼接区
  await page.evaluate(() => {
    const card = document.querySelector('.col-skill .para-card');
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const stitchCard = await page.evaluate(() => {
    const c = document.querySelector('#col-stitch .stitch-card');
    if (!c) return null;
    const cs = getComputedStyle(c);
    return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, leftBorder: cs.borderLeftWidth };
  });
  check('收入后终稿卡片出现', !!stitchCard);
  check('终稿卡片 15px/2.0 排版', stitchCard && stitchCard.fontSize === '15px' && stitchCard.lineHeight === '30px',
    JSON.stringify(stitchCard));
  check('终稿卡片左侧 3px 色条', stitchCard && stitchCard.leftBorder === '3px', stitchCard && stitchCard.leftBorder);

  await page.screenshot({ path: 'test/shot-result-desktop.png' });

  // ---------- T5 暗色主题 ----------
  console.log('T5 暗色主题');
  await page.evaluate(() => window.toggleTheme());
  await new Promise((r) => setTimeout(r, 300));
  const dark = await page.evaluate(() => {
    const head = document.querySelector('.col-skill .col-head');
    const card = document.querySelector('.col-skill .para-card');
    return {
      theme: document.documentElement.dataset.theme || document.body.dataset.theme,
      headBg: getComputedStyle(head).backgroundColor,
      headBgImage: getComputedStyle(head).backgroundImage,
      cardBg: getComputedStyle(card).backgroundColor,
      cardColor: getComputedStyle(card).color,
    };
  });
  check('暗色列头无渐变', dark.headBgImage === 'none', dark.headBgImage);
  check('暗色列头底色为深色 surface', dark.headBg === 'rgb(22, 28, 38)', dark.headBg);
  check('暗色卡片底色为深色', dark.cardBg === 'rgb(22, 28, 38)', dark.cardBg);
  check('暗色卡片文字为浅色', dark.cardColor === 'rgb(221, 228, 238)', dark.cardColor);
  await page.screenshot({ path: 'test/shot-result-dark.png' });
  await page.evaluate(() => window.toggleTheme()); // 还原
  await page.close();

  // ---------- T6 移动端 ----------
  console.log('T6 移动端 375px（无横向溢出、纵向堆叠）');
  const mpage = await setupPage(browser, 375, 760);
  await generateWithMock(mpage);
  const mobile = await page.evaluate(() => ({})).catch(() => ({})); // noop 保持节奏
  const m = await mpage.evaluate(() => {
    const cols = document.querySelector('#columnsWrap');
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      colDir: getComputedStyle(cols).flexDirection,
      headBtnsVisible: [...document.querySelectorAll('.col-skill .col-head .btn-mini')].every((b) => b.offsetWidth > 0),
    };
  });
  check('移动端无横向溢出', !m.overflowX);
  check('移动端列纵向堆叠', m.colDir === 'column', m.colDir);
  check('移动端列头按钮可见', m.headBtnsVisible);
  await mpage.screenshot({ path: 'test/shot-result-mobile.png' });
  await mpage.close();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
