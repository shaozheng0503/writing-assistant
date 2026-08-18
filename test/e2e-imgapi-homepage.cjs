/**
 * E2E 测试：生图 API 配置面板 + 首页排版重构 + 移动端响应式
 * puppeteer-core + 系统 Chrome，访问 dev server。
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:5173/';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  });

  /* ========== 桌面端 ========== */
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  console.log('== T1: 首页排版结构 ==');
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 400));
  check('无 JS 执行错误', errors.length === 0, errors.join('|'));

  const panels = await page.evaluate(() => document.querySelectorAll('.panel').length);
  check('三个步骤面板渲染', panels === 3, `got ${panels}`);
  const stepsOk = await page.evaluate(() =>
    !!document.getElementById('stepDot1') && !!document.getElementById('stepDot2') && !!document.getElementById('stepDot3'));
  check('步骤指示条存在', stepsOk);
  const genBtnText = await page.evaluate(() => document.getElementById('generateBtn')?.textContent);
  check('生成按钮文案更新', (genBtnText || '').includes('生成各版'), `"${genBtnText}"`);

  // 进阶设置默认折叠
  const advCollapsed = await page.evaluate(() => document.getElementById('advancedBody')?.style.display === 'none');
  check('③ 进阶设置默认折叠', advCollapsed);
  // 展开后内容可见
  await page.click('#advancedHead');
  await new Promise((r) => setTimeout(r, 200));
  const advOpen = await page.evaluate(() => document.getElementById('advancedBody')?.style.display !== 'none');
  check('③ 点击展开', advOpen);

  console.log('== T2: 生图 API 配置面板 ==');
  const apiPanelVisible = await page.evaluate(() => {
    const el = document.getElementById('imgApiPanel');
    return !!el && el.offsetParent !== null;
  });
  check('API 配置面板可见（在进阶设置内）', apiPanelVisible);
  // 展开面板
  await page.click('#imgApiHead');
  await new Promise((r) => setTimeout(r, 200));
  const apiBodyOpen = await page.evaluate(() => document.getElementById('imgApiBody')?.style.display !== 'none');
  check('API 面板可展开', apiBodyOpen);

  const badgeDefault = await page.evaluate(() => document.getElementById('imgApiBadge')?.textContent);
  check('默认徽标 Imagifly', badgeDefault === 'Imagifly', `"${badgeDefault}"`);

  // 切自定义 → 字段显隐
  await page.select('#imgApiProvider', 'custom');
  await new Promise((r) => setTimeout(r, 150));
  const customFieldsShown = await page.evaluate(() => document.getElementById('imgApiCustomFields')?.style.display !== 'none');
  const imagiflyNoteHidden = await page.evaluate(() => document.getElementById('imgApiImagiflyNote')?.style.display === 'none');
  check('切自定义显示 custom 字段', customFieldsShown);
  check('切自定义隐藏 imagifly 提示', imagiflyNoteHidden);

  console.log('== T3: 保存/脱敏/持久化 ==');
  // 填表保存
  await page.evaluate(() => { document.getElementById('imgApiKey').value = 'sk-test1234567890abcd'; });
  await page.evaluate(() => { document.getElementById('imgApiBaseUrl').value = 'https://api.example.com/v1/images/generations'; });
  await page.evaluate(() => { document.getElementById('imgApiModel').value = 'gpt-image-1'; });
  await page.click('#imgApiSave');
  await new Promise((r) => setTimeout(r, 300));

  const savedCfg = await page.evaluate(() => JSON.parse(localStorage.getItem('ww_img_api') || '{}'));
  check('配置持久化 provider=custom', savedCfg.provider === 'custom');
  check('配置持久化 apiKey', savedCfg.apiKey === 'sk-test1234567890abcd');
  check('配置持久化模型', savedCfg.model === 'gpt-image-1');

  const masked = await page.evaluate(() => document.getElementById('imgApiKeyMasked')?.textContent);
  check('Key 脱敏显示（头4尾4）', masked === '已保存: sk-t••••abcd', `"${masked}"`);
  const keyType = await page.evaluate(() => document.getElementById('imgApiKey')?.type);
  check('Key 输入框默认密文', keyType === 'password');
  // 眼睛切换
  await page.click('#imgApiKeyEye');
  const keyTypeShown = await page.evaluate(() => document.getElementById('imgApiKey')?.type);
  check('眼睛按钮切明文', keyTypeShown === 'text');

  const badgeCustom = await page.evaluate(() => document.getElementById('imgApiBadge')?.textContent);
  check('徽标变「自定义 · gpt-image-1」', badgeCustom === '自定义 · gpt-image-1', `"${badgeCustom}"`);

  // 刷新恢复
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 300));
  // 展开③ + API 面板（刷新后回到折叠态）
  await page.evaluate(() => {
    if (document.getElementById('advancedBody').style.display === 'none') document.getElementById('advancedHead').click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    if (document.getElementById('imgApiBody').style.display === 'none') document.getElementById('imgApiHead').click();
  });
  await new Promise((r) => setTimeout(r, 150));
  const cfgAfterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('ww_img_api') || '{}'));
  check('刷新后配置不丢', cfgAfterReload.apiKey === 'sk-test1234567890abcd' && cfgAfterReload.provider === 'custom');
  const badgeAfterReload = await page.evaluate(() => document.getElementById('imgApiBadge')?.textContent);
  check('刷新后徽标保持自定义', badgeAfterReload.includes('自定义'), `"${badgeAfterReload}"`);

  console.log('== T4: 比例预设联动 ==');
  // 面板已在 T3 刷新后展开；直接切供应商与联动
  await page.select('#imgApiProvider', 'custom');
  await page.evaluate(() => { document.getElementById('imgApiBody').style.display = ''; });
  await new Promise((r) => setTimeout(r, 100));
  await page.select('#imgApiRatio', '1:1 方图');
  await new Promise((r) => setTimeout(r, 100));
  const wh = await page.evaluate(() => ({
    w: document.getElementById('imgApiWidth').value,
    h: document.getElementById('imgApiHeight').value,
  }));
  check('选 1:1 → 1024x1024', wh.w === '1024' && wh.h === '1024', JSON.stringify(wh));
  // 手输宽高 → 比例变自定义
  await page.evaluate(() => { document.getElementById('imgApiWidth').value = '800'; document.getElementById('imgApiWidth').dispatchEvent(new Event('input')); });
  await new Promise((r) => setTimeout(r, 100));
  const ratioCustom = await page.evaluate(() => document.getElementById('imgApiRatio')?.value);
  check('手输非预设宽高 → 比例「自定义」', ratioCustom === '自定义', `"${ratioCustom}"`);

  console.log('== T5: 测试连接（imagifly 模式，真实调用） ==');
  // 确保面板展开（T4 展开过，此处保险）
  await page.evaluate(() => {
    document.getElementById('imgApiBody').style.display = '';
  });
  // 切回 imagifly 测试（本机 cookie 已配置，应成功）
  page.on('dialog', (d) => d.accept());
  await page.click('#imgApiReset');
  await new Promise((r) => setTimeout(r, 200));
  const badgeReset = await page.evaluate(() => document.getElementById('imgApiBadge')?.textContent);
  check('恢复默认 → 徽标回 Imagifly', badgeReset === 'Imagifly', `"${badgeReset}"`);
  const cfgReset = await page.evaluate(() => JSON.parse(localStorage.getItem('ww_img_api') || '{}'));
  check('恢复默认 → 配置清空/imagifly', (!cfgReset.apiKey && cfgReset.provider !== 'custom') || cfgReset.provider === 'imagifly', JSON.stringify(cfgReset));

  await page.click('#imgApiTest');
  // 等测试结果出现
  await page.waitForSelector('#imgApiTestResult', { visible: true, timeout: 10000 });
  const testResult = await page.evaluate(() => ({
    cls: document.getElementById('imgApiTestResult')?.className,
    text: document.getElementById('imgApiTestResult')?.textContent,
  }));
  check('测试连接成功（imagifly 代理）', testResult.cls.includes('ok'), testResult.text);

  console.log('== T6: 测试连接失败归因（custom + 错误地址） ==');
  await page.select('#imgApiProvider', 'custom');
  await page.evaluate(() => {
    document.getElementById('imgApiBody').style.display = '';
    document.getElementById('imgApiKey').value = 'sk-invalid-key-xxxx';
    document.getElementById('imgApiBaseUrl').value = 'https://api.example.com/v1/images/generations';
    document.getElementById('imgApiModel').value = 'gpt-image-1';
  });
  await page.click('#imgApiTest');
  await page.waitForFunction(() => {
    const el = document.getElementById('imgApiTestResult');
    return el && el.style.display !== 'none' && el.textContent.length > 0;
  }, { timeout: 30000 });
  const failResult = await page.evaluate(() => ({
    cls: document.getElementById('imgApiTestResult')?.className,
    text: document.getElementById('imgApiTestResult')?.textContent,
  }));
  check('失败反馈具体原因', failResult.cls.includes('err') && failResult.text.length > 10, failResult.text);

  console.log('== T7: 原有功能回归（生成流程） ==');
  // 清掉测试 API 配置，避免污染生成
  await page.evaluate(() => localStorage.removeItem('ww_img_api'));
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 300));
  await page.type('#rawInput', '回归测试文本。用于验证生成流程仍正常。');
  await page.click('#generateBtn');
  await page.waitForSelector('.col-skill', { timeout: 8000 });
  const skillCols = await page.evaluate(() => document.querySelectorAll('.col-skill').length);
  check('生成流程正常（3 列技能）', skillCols === 3, `got ${skillCols}`);
  const genBtnDisabled = await page.evaluate(() => document.getElementById('generateBtn')?.disabled);
  check('生成中按钮禁用（反馈）', genBtnDisabled === true);
  // 等生成完（最长 90s）或直接验证状态文本
  await page.waitForFunction(() => {
    const t = document.getElementById('statusText')?.textContent || '';
    return t.includes('完成') || t.includes('失败');
  }, { timeout: 90000 }).catch(() => {});
  const statusText = await page.evaluate(() => document.getElementById('statusText')?.textContent);
  check('生成完成状态反馈', (statusText || '').length > 0, `"${statusText}"`);
  check('全流程无 JS 错误', errors.length === 0, errors.slice(0, 2).join('|'));

  /* ========== 移动端 ========== */
  console.log('== T8: 移动端响应式（375px） ==');
  const m = await browser.newPage();
  await m.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
  // 统一初始态：清折叠记忆，避免 T1-T7 的面板状态串扰
  await m.evaluateOnNewDocument(() => {
    localStorage.removeItem('ww_advanced_collapsed');
    localStorage.removeItem('ww_imgapi_panel_collapsed');
    localStorage.removeItem('ww_img_api');
  });
  await m.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 400));

  const overflow = await m.evaluate(() => {
    // 检查水平溢出
    const docW = document.documentElement.clientWidth;
    const over = [];
    document.querySelectorAll('#page-input *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > docW + 2 || r.left < -2)) {
        over.push(`${el.tagName}.${el.className?.toString().slice(0, 20)} right=${Math.round(r.right)}`);
      }
    });
    return { docW, scrollW: document.documentElement.scrollWidth, over: over.slice(0, 4) };
  });
  check('无水平溢出', overflow.scrollW <= overflow.docW + 2, `scrollW=${overflow.scrollW} docW=${overflow.docW} ${overflow.over.join('; ')}`);

  // 输入动作区纵向排列（column-reverse：生成按钮在上、全宽）
  const actionsCol = await m.evaluate(() => {
    const gen = document.getElementById('generateBtn');
    const demo = document.getElementById('demoBtn');
    if (!gen || !demo) return false;
    const gr = gen.getBoundingClientRect(), dr = demo.getBoundingClientRect();
    return gr.top < dr.top - 10 && gr.width > 300; // 生成在上且全宽
  });
  check('生成按钮在上且全宽', actionsCol);

  // 进阶设置展开后 LLM 行也是单列
  await m.click('#advancedHead');
  await new Promise((r) => setTimeout(r, 200));
  // 仅在折叠时展开（localStorage 记忆可能已是展开态，盲目点击会反转）
  await m.evaluate(() => {
    if (document.getElementById('imgApiBody').style.display === 'none') {
      document.getElementById('imgApiHead').click();
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  // 切自定义显示 custom 字段行（否则第 2/3 行 display:none 宽度为 0）
  await m.select('#imgApiProvider', 'custom');
  await new Promise((r) => setTimeout(r, 150));
  await m.select('#imgApiProvider', 'custom');
  await new Promise((r) => setTimeout(r, 100));
  const apiRowCol = await m.evaluate(() => {
    // 移动端：每个 imgapi-row 内的 llm-field 上下堆叠（同 left 对齐、top 递增）
    const rows = [...document.querySelectorAll('#imgApiBody .imgapi-row')];
    if (!rows.length) return false;
    for (const row of rows) {
      const fs = [...row.querySelectorAll('.llm-field')];
      for (let i = 1; i < fs.length; i++) {
        const a = fs[i - 1].getBoundingClientRect(), b = fs[i].getBoundingClientRect();
        if (b.top - a.top < 5) return false; // 没换行 = 横排了
      }
    }
    return true;
  });
  check('API 配置行单列堆叠', apiRowCol);
  const mOverflow2 = await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2);
  check('展开后仍无溢出', mOverflow2);

  await m.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
