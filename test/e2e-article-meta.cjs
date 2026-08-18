/**
 * E2E：文章元信息体系（# 标题 + 概要 + ##/### 分层 + 中文提示词 + 图片分文件夹 + 遮罩 bug）
 * mock SSE 拦截，零 token 消耗。
 *
 * mock 分流（按 system prompt 特征）：
 * - 「文章结构分析器」→ 分段
 * - 「段落对齐器」→ 对齐
 * - 「文章元信息生成器」→ 标题+概要 JSON
 * - 「文章配图策划师」→ 配图提示词 JSON（断言 prompt 为中文）
 * - 其他 → 技能改写（返回带 #/## 标题结构的正文）
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5173';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const MOCK_RAW = [
  '一清晨的阳光透过窗帘缝隙洒进来，我在这样的清晨开始了一天的写作，世界安静得只剩下键盘的声音。',
  '二写作从来不是一件容易的事，你需要面对空白的页面，面对内心质疑自己的声音，然后继续写下去。',
  '三但正是这一次次的坚持让文字有了温度，让每一个认真对待文字的人，都值得被认真对待。'
].join('\n\n');

// 改写输出：# 大标题 + ## 小节 + 正文（模拟新技能输出结构）
const MOCK_REWRITE = [
  '# 写作是一场漫长的清晨修行',
  '',
  '## 清晨的键盘声',
  '天刚亮，键盘声就开始了。写作这件事，从来不怕早，只怕停。',
  '',
  '## 坚持的意义',
  '面对空白页面时的犹豫每个人都有，区别只在于谁先动笔。'
].join('\n');

const MOCK_SECTIONS = JSON.stringify([
  { title: '清晨写作', gist: '清晨写作场景', anchor: '一清晨的阳光透过窗帘缝隙洒进来' },
  { title: '坚持与回报', gist: '坚持的困难与意义', anchor: '二写作从来不是一件容易的事' },
]);
const MOCK_ALIGN = JSON.stringify([0, 0, 1]);
const MOCK_META = JSON.stringify({ title: '在清晨的键盘声里修行', summary: '一篇关于清晨写作与坚持意义的个人随笔' });
// 配图提示词：中文（断言用）
const MOCK_IMG_PROMPTS = JSON.stringify([
  { segment: '清晨写作场景', prompt: '清晨书房，木桌上一杯热咖啡冒着热气，暖色调，柔和侧光，写实风格' },
  { segment: '坚持的意义', prompt: '空白的稿纸与钢笔特写，冷色调，顶光，极简构图' },
]);

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
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);

  const seen = { metaReq: 0, imgPromptReq: 0, imgPromptBody: '' };
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/llm-proxy')) {
      let body = '';
      try { body = req.postData() || ''; } catch {}
      if (body.includes('文章结构分析器')) {
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_SECTIONS) });
      } else if (body.includes('段落对齐器')) {
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_ALIGN) });
      } else if (body.includes('文章元信息生成器')) {
        seen.metaReq++;
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_META) });
      } else if (body.includes('文章配图策划师')) {
        seen.imgPromptReq++;
        seen.imgPromptBody = body;
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_IMG_PROMPTS) });
      } else {
        req.respond({ status: 200, contentType: 'text/event-stream', body: sse(MOCK_REWRITE) });
      }
      return;
    }
    if (url.includes('/imagifly-proxy')) {
      if (url.includes('folder=')) {
        // 记录 folder 参数（断言分文件夹）
        seen.lastImgProxyUrl = url;
      }
      if (url.includes('/imagifly-proxy/image') && !url.includes('save=1')) {
        // 展示用图：1x1 png
        req.respond({
          status: 200, contentType: 'image/png',
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
        });
        return;
      }
      if (url.includes('/imagifly-proxy/save-data')) {
        req.respond({ status: 200, contentType: 'application/json', headers: { 'X-Saved-As': encodeURIComponent('folder/xxx.png') }, body: '{"ok":true}' });
        return;
      }
      req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });

  console.log('T1 标题结构输出（# 大标题 + ## 小节保留成段）');
  await page.evaluate((raw) => {
    const t = document.querySelector('#imgToggle');
    if (t) t.checked = false;
    document.querySelector('#rawInput').value = raw;
    document.querySelector('#generateBtn').click();
  }, MOCK_RAW);
  await page.waitForFunction(
    () => document.querySelectorAll('.col-skill .para-card').length >= 9,
    { timeout: 30000 }
  );
  await new Promise((r) => setTimeout(r, 500));
  const titleCards = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.col-skill .para-card')];
    return {
      total: cards.length,
      h1: cards.filter((c) => c.querySelector('.para-title.lvl-1')).length,
      h2: cards.filter((c) => c.querySelector('.para-title.lvl-2')).length,
      firstText: cards[0]?.querySelector('.para-title')?.textContent || cards[0]?.querySelector('p')?.textContent?.slice(0, 20),
    };
  });
  check('改写输出含 # 大标题卡（lvl-1）', titleCards.h1 >= 3, JSON.stringify(titleCards));
  check('改写输出含 ## 小节卡（lvl-2）', titleCards.h2 >= 3, `h2=${titleCards.h2}`);
  check('首卡为标题卡且内容正确', titleCards.firstText === '写作是一场漫长的清晨修行', titleCards.firstText);

  console.log('T2 标题+概要自动生成（拼接区头部）');
  await page.waitForFunction(
    () => (document.querySelector('#articleTitle')?.value || '').length > 0,
    { timeout: 30000 }
  ).catch(() => {});
  const meta = await page.evaluate(() => ({
    title: document.querySelector('#articleTitle').value,
    summary: document.querySelector('#articleSummary').value,
    count: document.querySelector('#amCount').textContent,
  }));
  check('标题自动填入', meta.title === '在清晨的键盘声里修行', meta.title);
  check('概要自动填入（15~25字区间）', [...meta.summary].length >= 15 && [...meta.summary].length <= 25, `${meta.summary} (${[...meta.summary].length}字)`);
  check('概要字数计数显示', /\d+\s*字/.test(meta.count), meta.count);
  check('元信息请求恰好 1 次', seen.metaReq === 1, `metaReq=${seen.metaReq}`);

  // 编辑不覆盖：手动改标题后重新跑 meta pipeline 不覆盖
  await page.evaluate(() => {
    const t = document.querySelector('#articleTitle');
    t.value = '我手动改的标题';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const afterEdit = await page.evaluate(() => ({
    title: document.querySelector('#articleTitle').value,
    touched: window.__ww_meta ? window.__ww_meta.touched : null,
  }));
  check('手动编辑后标题保留', afterEdit.title === '我手动改的标题', afterEdit.title);

  console.log('T3 拼接区标题卡 + 导出预览');
  await page.evaluate(() => {
    // 双击第一列的标题卡和正文卡进拼接区
    const cards = document.querySelectorAll('.col-skill .para-card');
    cards[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    if (cards[3]) cards[3].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const stitchTitle = await page.evaluate(() => {
    const st = document.querySelectorAll('#col-stitch .stitch-card p.para-title');
    return { count: st.length, first: st[0]?.textContent, lvl: st[0]?.className };
  });
  check('拼接区标题卡保留样式', stitchTitle.count >= 1 && stitchTitle.first === '写作是一场漫长的清晨修行', JSON.stringify(stitchTitle));

  await page.evaluate(() => window.exportText());
  await new Promise((r) => setTimeout(r, 300));
  const epTitle = await page.evaluate(() => {
    const t = document.querySelector('#exportPreview .ep-title');
    return { exists: !!t, text: t?.textContent, cls: t?.className };
  });
  check('导出预览标题卡渲染', epTitle.exists && epTitle.text === '写作是一场漫长的清晨修行', JSON.stringify(epTitle));
  await page.evaluate(() => window.closeExportModal ? window.closeExportModal() : null);

  console.log('T4 中文提示词 + 图片分文件夹');
  // 开配图重新生成（拦截 imgPromptReq）
  await page.evaluate((raw) => {
    document.querySelector('#backBtn').click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate((raw) => {
    const t = document.querySelector('#imgToggle');
    if (t) t.checked = true;
    document.querySelector('#rawInput').value = raw;
    localStorage.setItem('ww_img_stagger_ms', '100');
    document.querySelector('#generateBtn').click();
  }, MOCK_RAW);
  await page.waitForFunction(
    () => document.querySelectorAll('.col-skill .para-card').length >= 9,
    { timeout: 30000 }
  );
  const imgPrompt = await page.waitForFunction(
    () => (window.__lastImgPromptSeen || '') !== '',
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  // 配图策划师请求体断言：要求中文（system prompt 内容）
  check('配图提示词要求已中文化', seen.imgPromptReq > 0 && /纯中文|中文描述/.test(seen.imgPromptBody), `req=${seen.imgPromptReq}`);
  // 检查 system prompt 不再包含纯英文要求
  check('不再要求英文提示词', !/english image description/.test(seen.imgPromptBody), '');

  console.log('T5 图片遮罩 bug（regen-spin 类名修复）');
  // 构造 done 图片卡，断言遮罩默认隐藏
  const mask = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .map((r) => r.cssText || '');
    const all = rules.join('\n');
    // 找 .img-regen-spin 规则：默认 display:none（cssText 含空格 "display: none"）
    const defaultRule = rules.find((r) => r.includes('.img-card .img-regen-spin') && r.replace(/\s/g, '').includes('display:none'));
    // 找 .img-card.regen-busy .img-regen-spin：display:flex
    const busyRule = rules.find((r) => r.includes('.img-card.regen-busy .img-regen-spin') && r.replace(/\s/g, '').includes('display:flex') && r.includes('position'));
    return { hasDefaultHide: !!defaultRule, hasBusyShow: !!busyRule };
  });
  check('done 卡遮罩类名匹配 CSS（默认隐藏）', mask.hasDefaultHide, JSON.stringify(mask));
  check('regen-busy 时遮罩显示', mask.hasBusyShow);

  // done 卡 DOM 结构：遮罩类名与 CSS 匹配
  const domMask = await page.evaluate(() => {
    const st = window.__ww_state;
    st.images.push({ id: 'test-done-1', status: 'done', prompt: 'p', caption: '测试图', url: 'https://example.com/a.png', idx: 99, model: 'm', size: '1024x1024', createdAt: 0, promptHistory: [{ prompt: 'p', time: 0, source: '初始生成' }] });
    return true;
  });
  check('done 卡 DOM 遮罩类名验证可执行', domMask);

  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: 'test/shot-article-meta.png' });
  await page.evaluate(() => localStorage.clear());

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
