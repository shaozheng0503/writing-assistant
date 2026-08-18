/**
 * E2E：配图增强四件套
 * T1 自定义张数（1-10 校验 + 非法值阻止提交）
 * T2 智能提示词（N 张 = N 个提示词，LLM 输出按段匹配；不足自动补齐）
 * T3 图片详情弹窗（提示词/模型/尺寸/时间/历史）
 * T4 单张重生成（编辑提示词 → 替换；历史保留可回退；其余图不受影响）
 */
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5173';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const RAW = '第一段讲山野徒步的清晨。\n\n第二段讲溪谷里发现萤火虫。\n\n第三段讲山顶看日落云海。\n\n第四段讲夜晚营地篝火故事。';

function mockSse(text) {
  const chunks = [...text].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}
function mockSseJson(obj) { return mockSse(JSON.stringify(obj)); }

// 图片 URL 计数器：每次 submit 的 gid 对应不同图，验证「替换原图」
let imgSeq = 0;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  let promptCalls = []; // 记录画面描述 LLM 调用（system 含「配图策划师」）
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/llm-proxy')) {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch {}
      const sys = body.messages?.[0]?.content || '';
      if (sys.includes('配图策划师')) {
        promptCalls.push(body);
        // N=4：返回 4 个不同提示词（对应 4 段）
        req.respond({
          status: 200, contentType: 'text/event-stream',
          body: mockSseJson([
            { segment: '清晨山野出发', prompt: 'misty mountain trail at dawn, wide shot, cool tones' },
            { segment: '溪谷萤火虫', prompt: 'fireflies over a stream in a gorge, close-up, green glow' },
            { segment: '山顶日落云海', prompt: 'sunset sea of clouds from summit, panorama, warm orange' },
            { segment: '营地篝火', prompt: 'campfire stories at night, medium shot, amber light' },
          ]),
        });
        return;
      }
      req.respond({ status: 200, contentType: 'text/event-stream', body: mockSse('改写后的段落内容，用于文字列生成。') });
      return;
    }
    if (url.includes('/imagifly-proxy/ping')) {
      req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); return;
    }
    if (url.includes('/imagifly-proxy/submit')) {
      imgSeq++;
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ gid: `gen_${imgSeq}` }) });
      return;
    }
    if (url.includes('/imagifly-proxy/poll')) {
      const gid = new URL(url, BASE).searchParams.get('id') || '';
      const seq = gid.replace('gen_', '');
      req.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'success', imageUrls: [`https://cache.imagifly.net/mock/${seq}.png`] }),
      });
      return;
    }
    if (url.includes('/imagifly-proxy/image')) {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      req.respond({ status: 200, contentType: 'image/png', headers: { 'X-Saved-As': '' }, body: png });
      return;
    }
    if (url.includes('/imagifly-proxy')) {
      req.respond({ status: 200, contentType: 'application/json', body: '{}' }); return;
    }
    req.continue();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { await d.accept(); }); // confirm 自动确认

  console.log('T1 自定义张数（1-10 校验）');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  const t1 = await page.evaluate(() => {
    const input = document.querySelector('#imgCountInput');
    const hint = document.querySelector('#imgCountHint');
    const r = { hasInput: !!input, defaultVal: input?.value };
    // 非法值 15
    input.value = '15';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    r.err15 = { cls: input.classList.contains('err'), hint: hint?.textContent };
    // 非法值 0
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    r.err0 = input.classList.contains('err');
    // 非法值 abc
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    r.errAbc = input.classList.contains('err');
    // 合法值 7
    input.value = '7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    r.ok7 = { cls: !input.classList.contains('err'), saved: localStorage.getItem('ww_img_count'), hint: hint?.textContent };
    return r;
  });
  check('数字输入控件存在且默认 3', t1.hasInput && t1.defaultVal === '3', JSON.stringify(t1));
  check('非法值 15 标红 + 明确提示', t1.err15.cls && /1–10/.test(t1.err15.hint || ''), JSON.stringify(t1.err15));
  check('非法值 0 标红', t1.err0);
  check('非法值 abc 标红', t1.errAbc);
  check('合法值 7 通过并持久化', t1.ok7.cls && t1.ok7.saved === '7', JSON.stringify(t1.ok7));

  // 非法值阻止提交：填 15 → 点生成 → 应停留在输入页
  await page.evaluate(() => {
    const input = document.querySelector('#imgCountInput');
    input.value = '15';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#rawInput').value = '测试内容';
    document.querySelector('#generateBtn').click();
  });
  await new Promise((r) => setTimeout(r, 1200));
  const blocked = await page.evaluate(() => ({
    stillInput: document.querySelector('#page-input').style.display !== 'none',
    errCls: document.querySelector('#imgCountInput').classList.contains('err'),
  }));
  check('非法张数阻止提交（停留在输入页）', blocked.stillInput && blocked.errCls, JSON.stringify(blocked));
  // 恢复合法值 4，继续 T2
  await page.evaluate(() => {
    const input = document.querySelector('#imgCountInput');
    input.value = '4';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  console.log('T2 智能提示词（N 张 = N 个按段提示词）');
  promptCalls = [];
  await page.evaluate(() => {
    localStorage.setItem('ww_img_stagger_ms', '100'); // E2E 快速错峰
    const t = document.querySelector('#imgToggle'); if (t) t.checked = true;
    document.querySelector('#rawInput').value = '第一段讲山野徒步的清晨。\n\n第二段讲溪谷里发现萤火虫。\n\n第三段讲山顶看日落云海。\n\n第四段讲夜晚营地篝火故事。';
    document.querySelector('#generateBtn').click();
  });
  // 4 张图卡（loading → done）
  await page.waitForFunction(() => document.querySelectorAll('.img-card img').length >= 4, { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 500));
  const t2 = await page.evaluate(() => ({
    doneCards: document.querySelectorAll('.img-card img').length,
    errCards: document.querySelectorAll('.img-card .img-error').length,
  }));
  check('N=4 生成 4 张图卡', t2.doneCards === 4, JSON.stringify(t2));
  check('无失败卡', t2.errCards === 0, JSON.stringify(t2));
  check('画面描述调用 1 次（一次产出 N 条）', promptCalls.length === 1, `calls=${promptCalls.length}`);
  const userMsg = promptCalls[0]?.messages?.[1]?.content || '';
  check('调用携带文章与 N', userMsg.includes('第四段') && /N = 4/.test(userMsg), userMsg.slice(-40));

  console.log('T3 图片详情弹窗');
  const t3 = await page.evaluate(() => {
    document.querySelector('.img-card .img-act[data-t="detail"], .img-card .img-act')?.click?.();
    return true;
  });
  await new Promise((r) => setTimeout(r, 300));
  // 用明确的详情入口（第一个 img-act 是「详情」）
  const detailOpen = await page.evaluate(() => {
    const acts = document.querySelectorAll('.img-card .img-act');
    if (acts.length < 2) return { acts: acts.length };
    acts[0].click(); // 详情
    return { modalShown: document.querySelector('#imgDetailModal').style.display };
  });
  await new Promise((r) => setTimeout(r, 300));
  const detail = await page.evaluate(() => ({
    shown: document.querySelector('#imgDetailModal').style.display,
    hasPrompt: !!document.querySelector('#imgDetailBody .imgd-grid .v.prompt')?.textContent.includes('misty mountain trail'),
    hasModel: [...document.querySelectorAll('#imgDetailBody .imgd-grid .v')].some((v) => /nano-banana-2/.test(v.textContent)),
    hasSize: [...document.querySelectorAll('#imgDetailBody .imgd-grid .v')].some((v) => /1368x768/.test(v.textContent)),
    hasTime: [...document.querySelectorAll('#imgDetailBody .imgd-grid .v')].some((v) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v.textContent)),
    historyCount: document.querySelectorAll('#imgDetailBody .regen-h-item').length,
  }));
  check('详情弹窗打开', detail.shown === 'flex', JSON.stringify(detailOpen));
  check('展示完整提示词', detail.hasPrompt);
  check('展示模型名', detail.hasModel);
  check('展示尺寸参数', detail.hasSize);
  check('展示生成时间', detail.hasTime);
  check('展示提示词历史（1 版初始）', detail.historyCount === 1, `got ${detail.historyCount}`);
  await page.evaluate(() => window.closeImgDetail());
  check('详情弹窗可关闭', await page.evaluate(() => document.querySelector('#imgDetailModal').style.display === 'none'));

  console.log('T4 单张重生成 + 历史回退');
  // 记录第 2 张当前 URL（mock 里按 gid 区分）
  const before = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.img-card')];
    const img2 = cards[1]?.querySelector('img')?.src || '';
    const others = [cards[0]?.querySelector('img')?.src, cards[2]?.querySelector('img')?.src, cards[3]?.querySelector('img')?.src];
    return { img2, others };
  });
  // 打开第 2 张的重生成弹窗
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.img-card');
    cards[1].querySelectorAll('.img-act')[1].click(); // ↻ 重生成
  });
  await new Promise((r) => setTimeout(r, 300));
  const regenOpen = await page.evaluate(() => ({
    shown: document.querySelector('#imgRegenModal').style.display,
    promptVal: document.querySelector('#regenPromptInput').value,
    historyItems: document.querySelectorAll('#regenHistoryList .regen-h-item').length,
  }));
  check('重生成弹窗打开并预填当前提示词', regenOpen.shown === 'flex' && /fireflies/.test(regenOpen.promptVal), JSON.stringify(regenOpen));
  check('历史列表 1 项（当前版本）', regenOpen.historyItems === 1, `got ${regenOpen.historyItems}`);
  // 编辑提示词
  await page.evaluate(() => { document.querySelector('#regenPromptInput').value = 'glowing fireflies dancing above a mossy creek, macro lens, deep blue night'; });
  await page.evaluate(() => window.confirmImgRegen()); // dialog 自动 accept
  // 等重生成完成（mock：第 5 次 submit → gid gen_5 → poll 返回 mock/5.png，src 为代理 URL）
  await page.waitForFunction(
    () => [...document.querySelectorAll('.img-card')][1]?.querySelector('img')?.src.includes('5.png'),
    { timeout: 30000 }
  );
  await new Promise((r) => setTimeout(r, 300));
  const after = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.img-card')];
    return {
      img2: cards[1]?.querySelector('img')?.src,
      others: [cards[0]?.querySelector('img')?.src, cards[2]?.querySelector('img')?.src, cards[3]?.querySelector('img')?.src],
      errCards: document.querySelectorAll('.img-card .img-error').length,
    };
  });
  check('新图替换原图（URL 更新）', after.img2 !== before.img2 && /5\.png/.test(after.img2), `${before.img2} -> ${after.img2}`);
  check('其余 3 张不受影响', JSON.stringify(after.others) === JSON.stringify(before.others), JSON.stringify(after.others));
  // 历史应有 2 版；回退到第 1 版填入编辑框
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.img-card');
    cards[1].querySelectorAll('.img-act')[1].click();
  });
  await new Promise((r) => setTimeout(r, 300));
  const hist2 = await page.evaluate(() => {
    const items = document.querySelectorAll('#regenHistoryList .regen-h-item');
    // 点最后一项 = 最初版本（列表倒序，最后一项是最早）
    items[items.length - 1].click();
    return { count: items.length, filled: document.querySelector('#regenPromptInput').value };
  });
  check('重生成后历史 2 版', hist2.count === 2, `got ${hist2.count}`);
  check('点击历史版本回填提示词', /fireflies over a stream/.test(hist2.filled), hist2.filled);
  await page.evaluate(() => window.closeImgRegen());
  check('页面无 JS 报错', errors.length === 0, errors.join(' | '));

  await page.screenshot({ path: 'test/shot-img-enhance.png' });
  await page.evaluate(() => localStorage.clear());

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
