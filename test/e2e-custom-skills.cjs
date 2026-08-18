/**
 * E2E 测试：自定义技能 + 动态列渲染 + 生图配置
 * 用真实 Chrome（puppeteer-core）访问 dev server 验证。
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  console.log('== T1: 输入页加载与技能管理面板 ==');
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));

  const panelVisible = await page.evaluate(() => {
    const el = document.getElementById('skillManager');
    return !!el && el.offsetParent !== null;
  });
  check('技能管理面板可见', panelVisible);

  const builtinRows = await page.evaluate(() =>
    document.querySelectorAll('#skillManagerList .sm-builtin').length);
  check('内置三技能只读展示', builtinRows === 3, `got ${builtinRows}`);

  const skillCount = await page.evaluate(() =>
    document.getElementById('skillCount')?.textContent);
  check('面板计数「3 个技能」', skillCount === '3 个技能', `got "${skillCount}"`);

  console.log('== T2: 添加自定义技能 ==');
  // 打开添加表单
  await page.click('#skillFormToggle');
  await page.waitForSelector('#skillForm', { visible: true, timeout: 3000 });
  check('添加表单展开', true);

  await page.type('#skillName', '小红书风');
  await page.evaluate(() => {
    document.getElementById('skillPrompt').value =
      '你是一个小红书文案改写器。每段开头用 emoji 点题，句子口语化短促有网感，保留原文全部事实。';
  });
  // 提交（window.submitSkillForm 读表单值）
  await page.evaluate(() => window.submitSkillForm());
  await new Promise((r) => setTimeout(r, 300));

  const customRows = await page.evaluate(() =>
    document.querySelectorAll('#skillManagerList .sm-custom').length);
  check('自定义技能出现在列表', customRows === 1, `got ${customRows}`);

  const saved = await page.evaluate(() => {
    const arr = JSON.parse(localStorage.getItem('ww_custom_skills') || '[]');
    return arr[0] || null;
  });
  check('localStorage 持久化', !!saved && saved.name === '小红书风' && saved.enabled === true, JSON.stringify(saved));

  console.log('== T3: 动态列渲染（进入结果页） ==');
  // 点「生成三版」——会真实调 LLM。为了不耗 token，只验证列 DOM 生成：
  // 直接调用内部逻辑不暴露；改为验证：填入文本点生成后列出现 4 个技能列。
  await page.type('#rawInput', '测试文本。这是一段测试文本，用于验证动态列渲染。');
  await page.click('#generateBtn');
  await page.waitForSelector('.col-skill', { timeout: 5000 });
  const skillCols = await page.evaluate(() =>
    document.querySelectorAll('.col-skill').length);
  check('生成 4 个技能列（3 内置 + 1 自定义）', skillCols === 4, `got ${skillCols}`);

  const colIds = await page.evaluate(() =>
    [...document.querySelectorAll('.col-skill .col-body')].map((e) => e.id).sort());
  check('自定义技能列 id 存在', colIds.some((id) => id.startsWith('col-custom-')), JSON.stringify(colIds));

  const colOrder = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('#columnsWrap .col')].map((e) =>
      e.className.includes('col-gallery') ? 'gallery' :
      e.className.includes('col-stitch') ? 'stitch' : 'skill');
    return cols.join(',');
  });
  check('列布局顺序 gallery,skill×4,stitch', colOrder === 'gallery,skill,skill,skill,skill,stitch', colOrder);

  console.log('== T4: 停用自定义技能 ==');
  // 回输入页：Escape 或 backBtn
  const backBtn = await page.$('#backBtn');
  if (backBtn) await backBtn.click();
  await new Promise((r) => setTimeout(r, 300));
  // 刷新页面验证持久化恢复
  await page.reload({ waitUntil: 'networkidle0' });
  const customAfterReload = await page.evaluate(() =>
    document.querySelectorAll('#skillManagerList .sm-custom').length);
  check('刷新后自定义技能仍在（持久化）', customAfterReload === 1, `got ${customAfterReload}`);

  // 停用
  await page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('ww_custom_skills'))[0].id;
    window.toggleCustomSkill(id);
  });
  await new Promise((r) => setTimeout(r, 200));
  const countAfterDisable = await page.evaluate(() =>
    document.getElementById('skillCount')?.textContent);
  check('停用后计数 3/4 启用', countAfterDisable === '3/4 启用', `got "${countAfterDisable}"`);

  // 再生成验证只有 3 列
  await page.type('#rawInput', '再测一遍。');
  await page.click('#generateBtn');
  await page.waitForSelector('.col-skill', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 500));
  const skillCols2 = await page.evaluate(() =>
    document.querySelectorAll('.col-skill').length);
  check('停用后生成 3 列', skillCols2 === 3, `got ${skillCols2}`);

  console.log('== T5: 生图配置 ==');
  const imgRowVisible = await page.evaluate(() => {
    const el = document.getElementById('imgToggleRow');
    return el && el.style.display !== 'none';
  });
  check('生图配置行可见（imagifly 已启用）', imgRowVisible);
  const sizeOpts = await page.evaluate(() =>
    document.getElementById('imgSizeSelect')?.options.length);
  const countOpts = await page.evaluate(() =>
    document.getElementById('imgCountSelect')?.options.length);
  check('尺寸下拉 3 项', sizeOpts === 3, `got ${sizeOpts}`);
  check('张数下拉 3 项', countOpts === 3, `got ${countOpts}`);
  // 切换尺寸验证持久化
  await page.select('#imgSizeSelect', '1024x1024');
  await new Promise((r) => setTimeout(r, 200));
  const savedSize = await page.evaluate(() => localStorage.getItem('ww_img_size'));
  check('尺寸切换持久化', savedSize === '1024x1024', `got ${savedSize}`);

  console.log('== T6: 删除自定义技能 ==');
  const backBtn2 = await page.$('#backBtn');
  if (backBtn2) await backBtn2.click();
  page.on('dialog', (d) => d.accept()); // confirm 弹窗自动确认
  await page.evaluate(() => {
    const id = JSON.parse(localStorage.getItem('ww_custom_skills'))[0].id;
    window.deleteCustomSkill(id);
  });
  await new Promise((r) => setTimeout(r, 300));
  const afterDelete = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ww_custom_skills') || '[]').length);
  check('删除后 localStorage 清空', afterDelete === 0, `got ${afterDelete}`);

  // 清理测试残留
  await page.evaluate(() => {
    localStorage.removeItem('ww_img_size');
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
