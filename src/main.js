/**
 * main.js — 写作辅助工作台核心逻辑
 *
 * 流程：
 *   1. 用户在首页选 LLM Provider + 填 API Key + 粘贴原文
 *   2. 点「生成三版」→ 三个 SKILL.md 作为 system prompt 并行调用 LLM
 *   3. 流式输出逐字渲染，完成后按空行拆成多段卡片
 *   4. 同时从原文分段提取 3-5 个画面描述 → Imagifly 生图 → 配图库
 *   5. 文字段落双击收入拼接区，图片拖拽到拼接区指定位置
 *   6. 拼接区文字+图片混合排布，可拖拽排序、编辑、导出，自动存 localStorage
 */
import { DEMO_TEXT, SKILL_META, LLM_PROVIDERS, PREFILLED_KEY, getModelTrait, getModelLabel } from './skills.js';

import skillHumanWriting from '../skills/human-writing/SKILL.md?raw';
import skillHumanizerZh from '../skills/humanizer-zh/SKILL.md?raw';
import skillLjgPlain from '../skills/ljg-plain/SKILL.md?raw';

/* imagifly 是否可用（.env 配置了 cookie 才开启） */
const IMAGIFLY_ENABLED = !!import.meta.env.VITE_IMAGIFLY_ENABLED;

const SKILL_PROMPTS = {
  'human-writing':
    skillHumanWriting +
    '\n\n## 当前任务\n你是 human-writing 技能。用户会给你一段文字，请按本 SKILL.md 的规则改写它。直接输出改写后的正文，不要输出标题、不要展示内部提纲、不要解释你做了什么。\n\n## 思考约束\n如果你有思考过程，请控制在 500 字以内：只快速确认改写要点（语气/口吻/关键改法），不要逐句分析原文，不要预写草稿。把篇幅留给正文输出。',
  'humanizer-zh':
    skillHumanizerZh +
    '\n\n## 当前任务\n你是 humanizer-zh 技能。用户会给你一段文字，请按本 SKILL.md 的 24 条 AI 写作特征清单逐条检查并改写。直接输出改写后的正文，不要附更改总结、不要评分、不要解释。\n\n## 思考约束\n如果你有思考过程，请控制在 500 字以内：只标记命中的特征（如「第3条 排比、第7条 空洞总结」），不要逐条复述规则全文，不要预写草稿。把篇幅留给正文输出。',
  'ljg-plain':
    skillLjgPlain +
    '\n\n## 当前任务\n你是 ljg-plain 技能。用户会给你一段文字，请按本 SKILL.md 的 9 条红线改写它，让一个 12 岁孩子能懂。直接输出改写后的正文，不要写文件、不要附修改清单。\n\n## 思考约束\n如果你有思考过程，请控制在 500 字以内：只圈出需要降维的术语和长句，不要解释每条红线，不要预写草稿。把篇幅留给正文输出。',
};

/* ===== 状态 ===== */
const state = {
  rawText: '',
  generated: { 'human-writing': '', 'humanizer-zh': '', 'ljg-plain': '' },
  paragraphs: { 'human-writing': [], 'humanizer-zh': [], 'ljg-plain': [] },
  selectedPicks: new Set(),
  images: [],          // {id, status: 'loading'|'done'|'error', prompt, url, caption}
  stitch: [],          // {type:'text', skill, text, editing} | {type:'image', imgId, prompt, url, caption}
  selectedStitchIdx: null,
  busy: { 'human-writing': false, 'humanizer-zh': false, 'ljg-plain': false },
  imgBusy: false,
  compare: null,       // {sections:[{title,gist}], assigns:{skill:[paraIdx→secIdx|-1]}}
  compareBuilding: false,
  viewMode: 'free',    // 'free' | 'compare'
};

let imgIdCounter = 0;

const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ===== 页面切换 ===== */
function showInputPage() {
  $('page-input').style.display = 'flex';
  $('page-result').classList.remove('active');
}
function showResultPage() {
  $('page-input').style.display = 'none';
  $('page-result').classList.add('active');
}

/* ===== LLM 配置 ===== */
function getLLMConfig() {
  const provider = $('llmProvider').value;
  const useCustomModel = $('llmModelCustom').style.display !== 'none';
  const model = useCustomModel ? $('llmModelCustom').value.trim() : $('llmModel').value;
  let apiKey = $('llmApiKey').value.trim();
  if (!apiKey && provider === 'suanli' && PREFILLED_KEY) {
    apiKey = PREFILLED_KEY;
  }
  let baseUrl;
  if (provider === 'custom') baseUrl = $('llmBaseUrl').value.trim();
  else baseUrl = LLM_PROVIDERS[provider].baseUrl;
  return { provider, model, apiKey, baseUrl };
}
function saveKey() {
  const { provider, model, apiKey, baseUrl } = getLLMConfig();
  if (!apiKey) { toast('请先填 API Key'); return; }
  localStorage.setItem('ww_llm', JSON.stringify({ provider, model, apiKey, baseUrl }));
  $('clearKeyBtn').style.display = '';
  $('keyStatus').textContent = `已保存 · ${provider} / ${model}`;
  toast('配置已保存');
}
function loadKey() {
  const raw = localStorage.getItem('ww_llm');
  if (!raw) {
    if (PREFILLED_KEY) {
      $('llmProvider').value = 'suanli';
      updateModelOptions();
      $('llmApiKey').value = PREFILLED_KEY;
      $('keyStatus').textContent = '已通过 .env 预填共绩算力 API Key，可直接生成';
    }
    return;
  }
  try {
    const cfg = JSON.parse(raw);
    $('llmProvider').value = cfg.provider || 'suanli';
    updateModelOptions();
    if (cfg.provider === 'custom') {
      $('llmModelCustom').style.display = '';
      $('llmModel').style.display = 'none';
      $('llmModelCustom').value = cfg.model || '';
      $('llmBaseUrl').value = cfg.baseUrl || '';
      $('baseUrlWrap').style.display = '';
    } else {
      $('llmModel').value = cfg.model || '';
    }
    $('llmApiKey').value = cfg.apiKey || '';
    $('clearKeyBtn').style.display = '';
    $('keyStatus').textContent = `已保存 · ${cfg.provider} / ${cfg.model}`;
  } catch {}
}
function clearKey() {
  localStorage.removeItem('ww_llm');
  $('llmApiKey').value = '';
  $('clearKeyBtn').style.display = 'none';
  $('keyStatus').textContent = 'API Key 仅存在本地 localStorage，不会上传';
  toast('已清除');
}
function updateModelOptions() {
  const provider = $('llmProvider').value;
  const p = LLM_PROVIDERS[provider];
  if (provider === 'custom') {
    $('llmModel').style.display = 'none';
    $('llmModelCustom').style.display = '';
    $('baseUrlWrap').style.display = '';
  } else {
    $('llmModel').style.display = '';
    $('llmModelCustom').style.display = 'none';
    $('baseUrlWrap').style.display = 'none';
    $('llmModel').innerHTML = p.models.map((m) => `<option value="${m}">${getModelLabel(m)}</option>`).join('');
  }
}

/* ===== 调用 LLM（流式 + 超时 + 重试 + 模型特性适配 + 空闲看门狗） ===== */
/**
 * onRetryReset（可选第 6 参）：重试开始前回调，调用方用它清空已渲染的残留输出，
 * 防止「第一次流式输出一半失败 → 重试成功 → 正文出现两遍」。
 */
async function callLLM(systemPrompt, userText, config, onChunk, onReasoning, onRetryReset) {
  const { model, apiKey, baseUrl } = config;
  const url = baseUrl.replace(/\/$/, '');
  const proxyUrl = `/llm-proxy?target=${encodeURIComponent(url)}`;
  const trait = getModelTrait(model); // 'normal' | 'reasoning' | 'reasoning_only'
  const MAX_RETRIES = 2;
  const RETRY_DELAYS = [1000, 3000]; // 递增间隔：1s → 3s
  // 推理模型（GLM-5/5.1/5.2 等）思考过程可能很长
  const isReasoning = trait !== 'normal';
  const TIMEOUT_MS = isReasoning ? 300000 : 120000; // 推理 300s / 普通 120s
  const IDLE_TIMEOUT_MS = 60000; // 流空闲看门狗：60s 无任何 chunk 判定连接挂起
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 重试前重置：调用方清掉上次残留的半截输出（第一次尝试时也调用是安全的）
    if (onRetryReset) onRetryReset();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    // 空闲看门狗：流式传输中若长时间无新数据，主动断开（防代理静默挂起）
    let idleTimedOut = false;
    let idleTimer = setTimeout(() => { idleTimedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS);
    const kickIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS);
    };
    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText },
          ],
          stream: true,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        let friendly = errText.substring(0, 300);
        try {
          const errJson = JSON.parse(errText);
          friendly = errJson.error?.message || errJson.message || friendly;
        } catch {}
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`HTTP ${response.status}: ${friendly}`);
        }
        lastErr = new Error(`HTTP ${response.status}: ${friendly}`);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] || 3000));
          continue;
        }
        throw lastErr;
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')) {
        const body = await response.text();
        let msg = body.substring(0, 300);
        try {
          const j = JSON.parse(body);
          msg = j.error?.message || j.message || msg;
        } catch {}
        throw new Error(`服务端返回非流式响应: ${msg}`);
      }
      clearTimeout(timeout);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let reasoning = '';
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        kickIdle(); // 收到数据，重置空闲看门狗
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
              // 根据模型特性决定如何处理 reasoning_content
              if (trait === 'reasoning_only') {
                // 正文全部在 reasoning_content 里（glm-5.1/5.2, flash-0731）
                // reasoning_content 当正文渲染，忽略 content
                if (delta.reasoning_content) {
                  full += delta.reasoning_content;
                  if (onChunk) onChunk(delta.reasoning_content);
                }
              } else if (trait === 'reasoning') {
                // 推理模型：先思考后正文（glm-5, deepseek-v4-pro）
                // reasoning_content → 思考面板，content → 正文
                if (delta.reasoning_content) {
                  reasoning += delta.reasoning_content;
                  if (onReasoning) onReasoning(delta.reasoning_content);
                }
                if (delta.content) {
                  full += delta.content;
                  if (onChunk) onChunk(delta.content);
                }
              } else {
                // 普通模型：只有 content
                if (delta.content) {
                  full += delta.content;
                  if (onChunk) onChunk(delta.content);
                }
                // 兜底：如果普通模型也输出了 reasoning_content 但没有 content
                if (!delta.content && delta.reasoning_content) {
                  full += delta.reasoning_content;
                  if (onChunk) onChunk(delta.reasoning_content);
                }
              }
            }
          } catch {}
        }
      }
      clearTimeout(idleTimer);
      // 空结果兜底：流正常结束但一个字都没有（异常空响应）→ 触发重试
      if (!full && !reasoning) {
        lastErr = new Error('模型返回了空响应');
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] || 3000));
          continue;
        }
        throw lastErr;
      }
      return { text: full, reasoning };
    } catch (err) {
      clearTimeout(timeout);
      clearTimeout(idleTimer);
      if (err.name === 'AbortError') {
        // 区分总超时 vs 空闲挂起，给出针对性提示
        lastErr = new Error(
          idleTimedOut
            ? `连接挂起（${IDLE_TIMEOUT_MS / 1000}s 无数据），网络或代理中断`
            : `请求超时（${TIMEOUT_MS / 1000}秒），推理模型思考可能较慢，建议换 flash 版本`
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] || 3000));
          continue;
        }
        throw lastErr;
      }
      if (err.message && !err.message.startsWith('HTTP 4')) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] || 3000));
          continue;
        }
      }
      throw err;
    }
  }
  throw lastErr || new Error('未知错误');
}

/* ===== 统一分段 + 横向对比 ===== */

/**
 * 第一步：从原文提取「标准分段」——三个 skill 改写的是同一段原文，
 * 原文的语义分段就是天然的对齐锚点。
 * 返回 [{title, gist}, ...]（3~8 段）
 */
async function deriveSections(rawText, config) {
  const systemPrompt = `你是一个文章结构分析器。用户给你一篇原文，请把它按语义拆分成 3~8 个「标准段落」。

输出格式严格为 JSON 数组，不要输出任何其他内容：
[{"title":"该段小标题(6~12字)","gist":"该段内容概要(30字内)"}]

要求：
- 按行文逻辑分段（如：引入/背景/展开/案例/转折/收尾），段数依文章长度定，3 到 8 段
- title 概括该段主题；gist 是该段讲了什么
- 保持原文的段落顺序
- 不要输出解释、代码块标记`;

  try {
    const result = await callLLM(systemPrompt, rawText, config, () => {});
    const text = result.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr) && arr.length >= 2) {
        return arr.map((s) => ({ title: s.title || '', gist: s.gist || '' }));
      }
    }
  } catch {}
  // 回退：按原文空行分段
  const paras = splitParagraphs(rawText);
  if (paras.length >= 2) {
    return paras.slice(0, 8).map((p) => ({ title: p.substring(0, 10), gist: p.substring(0, 30) }));
  }
  return [{ title: '全文', gist: rawText.substring(0, 30) }];
}

/**
 * 第二步：把某个 skill 的输出段落「分配」到标准分段上。
 * 只让 LLM 输出段落编号 → 标准段编号的映射（数字数组），
 * 文字本身原样保留（不丢任何细节）。
 * 返回 number[]，第 i 项 = 该段落归属的标准段 idx；-1 = 无法归属（新增内容）
 */
async function alignSkillToSections(sections, skillParas, config) {
  const sectionList = sections.map((s, i) => `${i}. ${s.title}：${s.gist}`).join('\n');
  const paraList = skillParas.map((p, i) => `${i}. ${p.substring(0, 120)}`).join('\n');

  const systemPrompt = `你是一个段落对齐器。有一份「标准分段」（从原文提取）和一份「改写稿的段落列表」（某个改写技能的输出，已按空行拆分并编号）。

标准分段：
${sectionList}

改写稿段落：
${paraList}

请判断：改写稿的每个段落分别对应当文中的哪个标准段（按内容对应，改写可能合并/拆分/调序/增删，请按主要内容判断归属）。

输出格式严格为 JSON 数字数组，长度必须等于改写稿段落数，不要输出任何其他内容：
[段0对应的标准段编号, 段1对应的编号, ...]

规则：
- 每项是 0 到 ${sections.length - 1} 的整数
- 若某段是改写稿新增的内容（原文没有对应部分），填 -1
- 不要输出解释`;

  try {
    const result = await callLLM(systemPrompt, '开始对齐', config, () => {});
    const text = result.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr) && arr.length === skillParas.length) {
        return arr.map((n) => {
          const v = parseInt(n);
          return Number.isInteger(v) && v >= -1 && v < sections.length ? v : -1;
        });
      }
    }
  } catch {}
  // 回退：顺序平均分配（至少保证视图可用）
  return skillParas.map((_, i) =>
    sections.length === 1 ? 0 : Math.min(Math.floor((i / skillParas.length) * sections.length), sections.length - 1)
  );
}

/**
 * 构建对比数据：原文标准分段 + 各 skill 段落映射。
 * 在三列文字都完成后调用。
 */
async function buildCompare(config) {
  state.compareBuilding = true;
  updateCompareUI();
  const prevStatus = $('statusText').textContent;
  $('statusText').textContent = '正在构建分段对比（快速模型，几秒~十几秒）…';
  try {
    // 分段/对齐是结构化小任务，强制用快速非推理模型，
    // 避免用户选了推理模型（如 glm-5）后对比构建慢到像卡死
    const fastConfig = { ...config, model: 'deepseek/deepseek-v4-flash' };
    const sections = await deriveSections(state.rawText, fastConfig);
    const assigns = {};
    for (const skill of Object.keys(state.generated)) {
      const paras = state.paragraphs[skill];
      assigns[skill] =
        paras.length > 0 ? await alignSkillToSections(sections, paras, fastConfig) : [];
    }
    state.compare = { sections, assigns };
    $('statusText').textContent = `${prevStatus} · 分段对比就绪，点击顶栏「分段对比」查看`;
    toast('分段对比已就绪');
  } catch (err) {
    console.error('分段对比构建失败:', err);
    state.compare = null;
    $('statusText').textContent = prevStatus;
    toast('分段对比构建失败');
  } finally {
    state.compareBuilding = false;
    updateCompareUI();
  }
}

/** 对比视图 / 自由视图切换 */
function switchView(mode) {
  state.viewMode = mode;
  updateCompareUI();
}
function updateCompareUI() {
  const compareBtn = $('viewCompareBtn');
  const freeBtn = $('viewFreeBtn');
  const compareRow = $('compareView');
  const freeWrap = $('columnsWrap');
  const switchWrap = $('viewSwitch');
  if (!compareBtn || !freeBtn) return;
  // 对比数据存在（或构建中）才显示切换按钮
  switchWrap.style.display = state.compare || state.compareBuilding ? '' : 'none';
  compareBtn.classList.toggle('active', state.viewMode === 'compare');
  freeBtn.classList.toggle('active', state.viewMode === 'free');
  if (state.viewMode === 'compare') {
    freeWrap.style.display = 'none';
    compareRow.style.display = 'flex';
    renderCompare();
  } else {
    freeWrap.style.display = '';
    compareRow.style.display = 'none';
  }
}

/** 渲染分段对比视图：每个标准段一行，三 skill 横向并排 */
function renderCompare() {
  const wrap = $('compareView');
  if (!state.compare) {
    wrap.innerHTML = state.compareBuilding
      ? '<div class="thinking" style="padding:40px 0;justify-content:center"><div class="dots"><span></span><span></span><span></span></div>正在分析文章结构并对齐三列输出…</div>'
      : '<div class="stitch-empty" style="margin:40px 20px">分段对比数据不可用<br>可点击「重新生成」后再试</div>';
    return;
  }
  const { sections, assigns } = state.compare;
  const skills = ['human-writing', 'humanizer-zh', 'ljg-plain'];

  const renderCell = (pid, pi, paras) => {
    const isSel = state.selectedPicks.has(pid);
    return `<div class="para-card cmp-card ${isSel ? 'selected' : ''}" data-pid="${pid}">
      <span class="pnum">${pi + 1}</span>
      <p>${escapeHtml(paras[pi])}</p>
      <span class="copy-btn" onclick="event.stopPropagation();copyText('${pid}')">复制</span>
      <span class="pick-hint">双击收入拼接区</span>
    </div>`;
  };

  const rows = sections
    .map((sec, si) => {
      const cells = skills
        .map((skill) => {
          const paras = state.paragraphs[skill] || [];
          const mine = (assigns[skill] || [])
            .map((target, pi) => ({ target, pi }))
            .filter((x) => x.target === si);
          if (mine.length === 0) {
            return `<div class="cmp-cell cmp-empty"><span>（此段无对应输出）</span></div>`;
          }
          return `<div class="cmp-cell">${mine.map(({ pi }) => renderCell(`${skill}::${pi}`, pi, paras)).join('')}</div>`;
        })
        .join('');
      return `<div class="cmp-row">
        <div class="cmp-sec">
          <div class="cmp-sec-title">${si + 1}. ${escapeHtml(sec.title)}</div>
          <div class="cmp-sec-gist">${escapeHtml(sec.gist)}</div>
          <button class="btn btn-mini cmp-row-btn" onclick="addCompareRowToStitch(${si})" title="把此段中选中的（或全部）卡片收入拼接区">整行收入</button>
        </div>
        <div class="cmp-cells">${cells}</div>
      </div>`;
    })
    .join('');

  // 附加行：各 skill 标记为 -1 的「新增内容」（原文没有对应部分）
  const extraHasAny = skills.some(
    (skill) => (assigns[skill] || []).some((t) => t === -1) && (state.paragraphs[skill] || []).length > 0
  );
  let extraRows = '';
  if (extraHasAny) {
    const cells = skills
      .map((skill) => {
        const paras = state.paragraphs[skill] || [];
        const mine = (assigns[skill] || [])
          .map((target, pi) => ({ target, pi }))
          .filter((x) => x.target === -1);
        if (mine.length === 0) {
          return `<div class="cmp-cell cmp-empty"><span>（无新增）</span></div>`;
        }
        return `<div class="cmp-cell">${mine.map(({ pi }) => renderCell(`${skill}::${pi}`, pi, paras)).join('')}</div>`;
      })
      .join('');
    extraRows = `<div class="cmp-row cmp-row-extra">
      <div class="cmp-sec">
        <div class="cmp-sec-title">✦ 新增内容</div>
        <div class="cmp-sec-gist">原文中没有对应部分的补充段落（如结尾总结）</div>
      </div>
      <div class="cmp-cells">${cells}</div>
    </div>`;
  }

  wrap.innerHTML = rows + extraRows;
  // 绑定卡片交互（与自由视图一致）
  wrap.querySelectorAll('.para-card[data-pid]').forEach((card) => {
    card.addEventListener('click', () => togglePick(card.dataset.pid));
    card.addEventListener('dblclick', () => sendToStitch(card.dataset.pid));
  });
}

/** 把对比视图某一行中选中的（或全部）卡片收入拼接区 */
function addCompareRowToStitch(secIdx) {
  if (!state.compare) return;
  const { assigns } = state.compare;
  const skills = ['human-writing', 'humanizer-zh', 'ljg-plain'];
  const picked = [];
  skills.forEach((skill) => {
    (assigns[skill] || []).forEach((target, pi) => {
      if (target === secIdx && state.selectedPicks.has(`${skill}::${pi}`)) {
        picked.push({ skill, text: state.paragraphs[skill][pi] });
      }
    });
  });
  const items = picked.length > 0
    ? picked
    : skills
        .map((skill) => {
          const first = (assigns[skill] || []).findIndex((t) => t === secIdx);
          return first >= 0 ? { skill, text: state.paragraphs[skill][first] } : null;
        })
        .filter(Boolean);
  if (items.length === 0) { toast('此段没有可收入的内容'); return; }
  items.forEach((it) => state.stitch.push({ type: 'text', skill: it.skill, text: it.text, editing: false }));
  renderStitch();
  saveStitch();
  toast(`已收入 ${items.length} 段（可在拼接区排序）`);
}

/* ===== Imagifly 配图生成 ===== */

/**
 * 用 LLM 从原文一次性提取 3~5 个分段画面描述
 * 返回 [{segment, prompt}, ...]
 */
async function deriveImagePrompts(rawText, config) {
  const systemPrompt = `你是一个画面描述提取器。用户会给你一段完整文章，请按以下步骤工作：

1. 将文章按语义拆分成 3~5 个段落
2. 为每个段落提取一个适合做配图的画面描述

输出格式严格为 JSON 数组，不要输出任何其他内容：
[{"segment":"段落的中文摘要(20字内)","prompt":"english image description, under 60 words, including subject, style, lighting, color tone"}]

要求：
- 3 到 5 张图，根据文章长度决定
- prompt 必须纯英文，包含主体、风格、光线、色调
- segment 是该段落内容的中文摘要
- 不要输出任何解释、标题、代码块标记`;

  try {
    const result = await callLLM(systemPrompt, rawText, config, () => {});
    const text = result.text || '';
    // 尝试提取 JSON 数组
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((item) => ({
          segment: item.segment || '',
          prompt: item.prompt || '',
        }));
      }
    }
  } catch {}
  // 回退：按原文段落拆分取前 3 段
  const paras = splitParagraphs(rawText);
  return paras.slice(0, 3).map((p) => ({
    segment: p.substring(0, 30),
    prompt: p.substring(0, 100).replace(/\n/g, ' '),
  }));
}

/**
 * 提交生图请求 → 轮询 → 返回图片 URL
 */
async function generateImage(prompt) {
  const submitRes = await fetch('/imagifly-proxy/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      model: 'nano-banana-2',
      size: '1368x768',
      imageCount: 1,
    }),
  });
  if (!submitRes.ok) {
    const err = await submitRes.json().catch(() => ({ error: '提交失败' }));
    throw new Error(`提交生图失败: ${err.error || err.detail || '未知'}`);
  }
  const { gid } = await submitRes.json();
  if (!gid) throw new Error('未获取到 generation id');

  const MAX_POLLS = 40;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(`/imagifly-proxy/poll?id=${gid}`);
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    if (pollData.status === 'success' && pollData.imageUrl) {
      return pollData.imageUrl;
    }
    if (pollData.status === 'failed') {
      throw new Error(`生成失败: ${pollData.error || '未知'}`);
    }
  }
  throw new Error('轮询超时（200秒）');
}

/**
 * 生成全部配图（3~5 张），错开 20 秒提交避免限速
 */
async function generateAllImages(prompts, config) {
  state.imgBusy = true;
  $('galleryCol').style.display = '';
  const gallery = $('col-gallery');
  gallery.innerHTML = '';

  // 为每个 prompt 创建图片状态对象 + 渲染 loading 卡片
  prompts.forEach((p, i) => {
    const id = `img-${++imgIdCounter}`;
    const imgObj = { id, status: 'loading', prompt: p.prompt, caption: p.segment, url: null, idx: i };
    state.images.push(imgObj);
    renderGalleryCard(imgObj);
  });

  // 错开 20s 提交
  const promises = prompts.map((p, i) =>
    new Promise((resolve) => setTimeout(resolve, i * 20000))
      .then(() => generateImage(p.prompt))
      .then((url) => {
        const img = state.images.find((x) => x.idx === i);
        if (img) {
          img.status = 'done';
          img.url = url;
          renderGalleryCard(img);
        }
      })
      .catch((err) => {
        const img = state.images.find((x) => x.idx === i);
        if (img) {
          img.status = 'error';
          img.error = err.message;
          renderGalleryCard(img);
        }
      })
  );

  await Promise.allSettled(promises);
  state.imgBusy = false;
}

/**
 * 渲染配图库中的单张图片卡片
 */
function renderGalleryCard(img) {
  const gallery = $('col-gallery');
  // 清除空状态提示
  const empty = gallery.querySelector('.stitch-empty');
  if (empty) empty.remove();

  let card = gallery.querySelector(`[data-imgid="${img.id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'img-card';
    card.setAttribute('draggable', 'true');
    card.dataset.imgid = img.id;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/imgid', img.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
    gallery.appendChild(card);
  }

  if (img.status === 'loading') {
    card.innerHTML = `
      <div class="img-loading"><div class="dots"><span></span><span></span><span></span></div>生成中…</div>
      <div class="img-meta"><div class="img-caption">${escapeHtml(img.caption)}</div></div>
      <span class="img-idx">${img.idx + 1}</span>`;
  } else if (img.status === 'done') {
    const proxyUrl = `/imagifly-proxy/image?url=${encodeURIComponent(img.url)}`;
    card.innerHTML = `
      <div class="img-wrap"><img src="${proxyUrl}" alt="${escapeHtml(img.caption)}" /></div>
      <div class="img-meta"><div class="img-caption">${escapeHtml(img.caption)}</div></div>
      <span class="img-idx">${img.idx + 1}</span>
      <span class="img-drag-hint">拖拽到拼接区</span>`;
    // 点击放大
    card.querySelector('img').addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(proxyUrl, img.caption);
    });
  } else {
    card.innerHTML = `
      <div class="img-error">配图失败<br>${escapeHtml(img.error || '未知错误')}</div>
      <div class="img-meta"><div class="img-caption">${escapeHtml(img.caption)}</div></div>
      <span class="img-idx">${img.idx + 1}</span>`;
  }
}

/* ===== Lightbox ===== */
function openLightbox(src, caption) {
  $('lightboxImg').src = src;
  $('lightboxCaption').textContent = caption || '';
  $('lightbox').style.display = 'flex';
}
function closeLightbox() {
  $('lightbox').style.display = 'none';
  $('lightboxImg').src = '';
}

/* ===== 单列生成（流式 + 思考面板 + 段落拆分） ===== */
async function generateColumn(skill, rawText, config) {
  if (state.busy[skill]) return { ok: false, error: 'busy' };
  state.busy[skill] = true;
  const container = $('col-' + skill);
  container.innerHTML =
    '<div class="thinking"><div class="dots"><span></span><span></span><span></span></div>生成中…</div>';

  let streamCard = null;
  let reasoningPanel = null;
  let reasoningText = '';
  let reasoningChars = 0;
  let reasoningTimer = null;
  let reasoningStart = 0;
  let reasoningDone = false;

  // 思考进度：每秒更新「已思考 Xs · Y 字」
  const startReasoningProgress = () => {
    reasoningStart = Date.now();
    const update = () => {
      if (reasoningDone) return;
      const sec = Math.floor((Date.now() - reasoningStart) / 1000);
      const timeStr = sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
      const meter = reasoningPanel?.querySelector('.reasoning-meter');
      if (meter) {
        meter.textContent = reasoningChars > 0
          ? `已思考 ${timeStr} · ${reasoningChars} 字`
          : `已思考 ${timeStr}`;
      }
    };
    update();
    reasoningTimer = setInterval(update, 1000);
  };
  const stopReasoningProgress = (finished) => {
    reasoningDone = true;
    if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
    const meter = reasoningPanel?.querySelector('.reasoning-meter');
    if (meter && finished && reasoningStart) {
      const sec = Math.floor((Date.now() - reasoningStart) / 1000);
      const timeStr = sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
      meter.textContent = `思考完成 · ${timeStr} · ${reasoningChars} 字`;
      reasoningPanel?.classList.add('done');
    }
  };

  try {
    const result = await callLLM(
      SKILL_PROMPTS[skill],
      rawText,
      config,
      // 正文回调
      (delta) => {
        // 正文开始 → 停止计时（正文已出，无需再提示预期）
        if (!reasoningDone) stopReasoningProgress(false);
        if (!streamCard) {
          container.innerHTML = '';
          // 如果有思考面板，插在正文前面
          if (reasoningPanel) {
            container.appendChild(reasoningPanel);
          }
          streamCard = document.createElement('div');
          streamCard.className = 'para-card cursor-blink streaming';
          streamCard.innerHTML = `<p class="para-text"></p>`;
          container.appendChild(streamCard);
        }
        streamCard.querySelector('.para-text').textContent += delta;
        container.scrollTop = container.scrollHeight;
      },
      // 思考回调
      (delta) => {
        if (!reasoningPanel) {
          reasoningPanel = document.createElement('div');
          reasoningPanel.className = 'reasoning-panel collapsed';
          reasoningPanel.innerHTML = `
            <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
              <span class="reasoning-icon">💭</span>
              <span class="reasoning-label">思考过程</span>
              <span class="reasoning-meter">已思考 0s</span>
              <span class="reasoning-toggle">展开</span>
            </div>
            <div class="reasoning-body"></div>`;
          if (streamCard) {
            // 正文已开始，插在正文前面
            container.insertBefore(reasoningPanel, streamCard);
          } else {
            // 正文还没开始，先放进去
            container.innerHTML = '';
            container.appendChild(reasoningPanel);
          }
          startReasoningProgress();
        }
        reasoningText += delta;
        reasoningChars = reasoningText.length;
        const body = reasoningPanel.querySelector('.reasoning-body');
        body.textContent += delta;
        // 防超长思考链拖慢 DOM：面板内只保留最近 4000 字
        if (reasoningChars > 4000 && body.textContent.length > 4000) {
          body.textContent = '（前文思考过长已折叠）\n…' + body.textContent.slice(-4000);
        }
        // 思考阶段自动展开，正文开始后自动收起
        if (!streamCard && !reasoningPanel.classList.contains('expanded-once')) {
          reasoningPanel.classList.remove('collapsed');
        }
        container.scrollTop = container.scrollHeight;
      },
      // 重试前重置：清空上一次尝试残留的半截输出（防重试后正文出现两遍）
      () => {
        streamCard = null;
        reasoningPanel = null;
        reasoningText = '';
        reasoningChars = 0;
        reasoningDone = false;
        if (reasoningTimer) { clearInterval(reasoningTimer); reasoningTimer = null; }
        container.innerHTML =
          '<div class="thinking"><div class="dots"><span></span><span></span><span></span></div>连接中断，自动重试…</div>';
      }
    );

    // 正文开始后自动收起思考面板
    if (reasoningPanel) {
      stopReasoningProgress(true);
      reasoningPanel.classList.add('collapsed');
      const toggle = reasoningPanel.querySelector('.reasoning-toggle');
      if (toggle) toggle.textContent = '展开';
    }

    state.generated[skill] = result.text;
    state.paragraphs[skill] = splitParagraphs(result.text);
    if (streamCard) streamCard.classList.remove('cursor-blink');
    renderColumnCards(skill);
    return { ok: true };
  } catch (err) {
    stopReasoningProgress(false);
    container.innerHTML = `<div class="error-text">调用失败<br><span class="err-detail">${escapeHtml(err.message)}</span></div>`;
    return { ok: false, error: err.message };
  } finally {
    state.busy[skill] = false;
  }
}

/* ===== 渲染段落卡片 ===== */
function renderColumnCards(skill) {
  const container = $('col-' + skill);
  const paras = state.paragraphs[skill];
  if (paras.length === 0) {
    container.innerHTML = '<div class="error-text">无内容</div>';
    return;
  }
  container.innerHTML = paras
    .map((p, i) => {
      const pid = `${skill}::${i}`;
      const isSel = state.selectedPicks.has(pid);
      return `<div class="para-card ${isSel ? 'selected' : ''}" data-pid="${pid}">
        <span class="pnum">${i + 1}</span>
        <p>${escapeHtml(p)}</p>
        <span class="copy-btn" onclick="event.stopPropagation();copyText('${pid}')">复制</span>
        <span class="pick-hint">双击收入拼接区</span>
      </div>`;
    })
    .join('');
  container.querySelectorAll('.para-card').forEach((card) => {
    card.addEventListener('click', () => togglePick(card.dataset.pid));
    card.addEventListener('dblclick', () => sendToStitch(card.dataset.pid));
  });
}

/* ===== 生成三版 ===== */
async function generate() {
  const raw = $('rawInput').value.trim();
  if (!raw) { toast('请先粘贴内容'); return; }
  const config = getLLMConfig();
  if (!config.apiKey) { toast('请先填写 API Key'); return; }
  if (!config.model) { toast('请先选择模型'); return; }

  const imgEnabled = IMAGIFLY_ENABLED && $('imgToggle') && $('imgToggle').checked;

  state.rawText = raw;
  state.images = [];
  showResultPage();
  ['human-writing', 'humanizer-zh', 'ljg-plain'].forEach((s) => {
    state.generated[s] = '';
    state.paragraphs[s] = [];
    $('col-' + s).innerHTML = '';
  });
  // 隐藏配图库列（稍后如果配图开启再显示）
  $('galleryCol').style.display = 'none';
  $('col-gallery').innerHTML = '';

  state.selectedPicks.clear();
  state.compare = null;        // 重置分段对比
  state.viewMode = 'free';     // 回到自由视图
  updateCompareUI();
  renderStitch();
  $('statusText').textContent = '三技能并行调用 LLM…';

  const skills = ['human-writing', 'humanizer-zh', 'ljg-plain'];

  // 文字生成
  const textPromises = skills.map((skill) => generateColumn(skill, raw, config));

  // 配图生成（如果开启）
  let imgPromise = null;
  if (imgEnabled) {
    // 先用 LLM 提取画面描述（不等文字完成，并行跑；用快速模型避免推理模型拖慢）
    imgPromise = deriveImagePrompts(raw, { ...config, model: 'deepseek/deepseek-v4-flash' })
      .then((prompts) => generateAllImages(prompts, config))
      .catch((err) => {
        console.error('配图生成失败:', err);
        toast('配图生成失败');
      });
  }

  const results = await Promise.allSettled(textPromises);
  const okCount = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;

  if (imgEnabled && imgPromise) {
    $('statusText').textContent = `文字完成 · ${okCount}/3 成功，配图生成中…`;
    await imgPromise;
  }

  const imgOk = state.images.filter((i) => i.status === 'done').length;
  if (okCount === 3) {
    $('statusText').textContent = imgEnabled
      ? `生成完成 · 文字 ${okCount}/3 + 配图 ${imgOk}/${state.images.length}`
      : '生成完成 · 双击段落收入拼接区';
    toast(imgEnabled ? `三版文字 + ${imgOk} 张配图已生成` : '三版已生成');
    // 构建分段对比（原文标准分段 + 三列映射），不阻塞主流程
    buildCompare(config);
  } else {
    $('statusText').textContent = `完成 · ${okCount} 成功，${3 - okCount} 失败`;
    toast(`${3 - okCount} 个技能调用失败`);
  }
}

/* ===== 单列重新生成 ===== */
async function regenerateColumn(skill) {
  const config = getLLMConfig();
  if (!config.apiKey) { toast('请先填写 API Key'); return; }
  if (!state.rawText) { toast('没有原始内容'); return; }
  $('statusText').textContent = `重新生成 ${skill}…`;
  const result = await generateColumn(skill, state.rawText, config);
  if (result.ok) {
    $('statusText').textContent = `${skill} 已重新生成`;
    toast(`${skill} 已更新`);
    // 重新生成了该列 → 若对比数据存在，重新映射该列（用快速模型）
    if (state.compare) {
      try {
        state.compare.assigns[skill] = await alignSkillToSections(
          state.compare.sections,
          state.paragraphs[skill],
          { ...config, model: 'deepseek/deepseek-v4-flash' }
        );
        if (state.viewMode === 'compare') renderCompare();
        toast('分段对比已更新');
      } catch {}
    }
  } else {
    $('statusText').textContent = `${skill} 生成失败`;
  }
}

/* ===== 选中/复制 ===== */
function togglePick(pid) {
  if (state.selectedPicks.has(pid)) state.selectedPicks.delete(pid);
  else state.selectedPicks.add(pid);
  const el = document.querySelector(`.para-card[data-pid="${pid}"]`);
  if (el) el.classList.toggle('selected');
}
function pickAll(skill) {
  const paras = state.paragraphs[skill] || [];
  if (paras.length === 0) return;
  const allSel = paras.every((_, i) => state.selectedPicks.has(`${skill}::${i}`));
  paras.forEach((_, i) => {
    const pid = `${skill}::${i}`;
    if (allSel) state.selectedPicks.delete(pid);
    else state.selectedPicks.add(pid);
    const el = document.querySelector(`.para-card[data-pid="${pid}"]`);
    if (el) el.classList.toggle('selected', !allSel);
  });
  toast(allSel ? '已取消全选' : '已全选');
}
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    resolve();
  });
}
function copyText(pid) {
  const [skill, idxStr] = pid.split('::');
  const idx = parseInt(idxStr);
  const text = state.paragraphs[skill]?.[idx];
  if (!text) return;
  copyToClipboard(text).then(() => toast('已复制'));
}

/* ===== 选中段落加入拼接区 ===== */
function addSelectedToStitch(skill) {
  const paras = state.paragraphs[skill] || [];
  if (paras.length === 0) { toast('该列还没有内容'); return; }
  const selIdx = paras
    .map((_, i) => i)
    .filter((i) => state.selectedPicks.has(`${skill}::${i}`));
  const idxs = selIdx.length > 0 ? selIdx : paras.map((_, i) => i);
  idxs.forEach((i) => state.stitch.push({ type: 'text', skill, text: paras[i], editing: false }));
  renderStitch();
  saveStitch();
  toast(`已加入 ${idxs.length} 段`);
}

/* ===== 收入拼接区（文字） ===== */
function sendToStitch(pid) {
  const [skill, idxStr] = pid.split('::');
  const idx = parseInt(idxStr);
  const text = state.paragraphs[skill]?.[idx];
  if (!text) return;
  state.stitch.push({ type: 'text', skill, text, editing: false });
  renderStitch();
  saveStitch();
  toast('已加入拼接区');
}

/* ===== 收入拼接区（图片） ===== */
function sendImageToStitch(imgId) {
  const img = state.images.find((i) => i.id === imgId);
  if (!img || img.status !== 'done') return;
  state.stitch.push({
    type: 'image',
    imgId: img.id,
    prompt: img.prompt,
    url: img.url,
    caption: img.caption,
  });
  renderStitch();
  saveStitch();
  toast('图片已加入拼接区');
}

/* ===== 拼接区渲染（文字+图片混合） ===== */
function renderStitch() {
  const c = $('col-stitch');
  if (state.stitch.length === 0) {
    c.innerHTML =
      '<div class="stitch-empty">双击左侧任意段落<br>或从配图库拖拽图片<br>将它们收入拼接区<br><br>拼接后可拖拽排序、编辑、导出</div>';
    $('stitchCount').textContent = '';
    return;
  }
  c.innerHTML = state.stitch
    .map((item, i) => {
      const sel = state.selectedStitchIdx === i;
      if (item.type === 'image') {
        const proxyUrl = `/imagifly-proxy/image?url=${encodeURIComponent(item.url)}`;
        return `<div class="stitch-card stitch-img-card ${sel ? 'selected' : ''}" data-idx="${i}" draggable="true">
          <div class="s-tag"><span class="drag-handle">⋮⋮</span><span class="dot" style="background:var(--c2)"></span>配图</div>
          <div class="img-wrap"><img src="${proxyUrl}" alt="${escapeHtml(item.caption || '')}" /></div>
          <div class="img-meta"><div class="img-caption">${escapeHtml(item.caption || '')}</div></div>
          <div class="s-actions">
            <span class="s-act" onclick="event.stopPropagation();removeItem(${i})">✕</span>
          </div>
        </div>`;
      }
      // text
      const meta = SKILL_META[item.skill];
      if (item.editing) {
        return `<div class="stitch-card editing ${sel ? 'selected' : ''}" data-idx="${i}" draggable="false">
          <div class="s-tag"><span class="dot" style="background:${meta.color}"></span>${meta.label}</div>
          <textarea onblur="saveEdit(${i},this.value)">${escapeHtml(item.text)}</textarea>
        </div>`;
      }
      return `<div class="stitch-card ${sel ? 'selected' : ''}" data-idx="${i}" draggable="true">
        <div class="s-tag"><span class="drag-handle">⋮⋮</span><span class="dot" style="background:${meta.color}"></span>${meta.label}</div>
        <p>${escapeHtml(item.text)}</p>
        <div class="s-actions">
          <span class="s-act" onclick="event.stopPropagation();editStitch(${i})">编辑</span>
          <span class="s-act" onclick="event.stopPropagation();removeItem(${i})">✕</span>
        </div>
      </div>`;
    })
    .join('');

  const textCount = state.stitch.filter((s) => s.type === 'text').length;
  const imgCount = state.stitch.filter((s) => s.type === 'image').length;
  const totalChars = state.stitch
    .filter((s) => s.type === 'text')
    .reduce((a, s) => a + s.text.length, 0);
  $('stitchCount').textContent = `${textCount} 文本 + ${imgCount} 图 · ${totalChars} 字`;

  bindDragEvents();
  // 拼接区图片点击放大
  c.querySelectorAll('.stitch-img-card img').forEach((img) => {
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(img.src, img.alt || '');
    });
  });
  // 点击选中
  c.querySelectorAll('.stitch-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('s-act') || e.target.classList.contains('drag-handle') || e.target.tagName === 'IMG') return;
      selectStitch(parseInt(card.dataset.idx));
    });
  });
}

/* ===== 拖拽排序（文字+图片混合） ===== */
let dragSrcIdx = null;
let dragSrcType = null;  // 'stitch' | 'gallery'
let stitchColDropBound = false;  // 防止拼接区容器监听器重复绑定

function bindDragEvents() {
  const cards = document.querySelectorAll('#col-stitch .stitch-card[draggable="true"]');
  cards.forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      dragSrcIdx = parseInt(card.dataset.idx);
      dragSrcType = 'stitch';
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/stitch-idx', String(dragSrcIdx));
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.stitch-card').forEach((c) => c.classList.remove('drag-over'));
      dragSrcIdx = null;
      dragSrcType = null;
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = dragSrcType === 'gallery' ? 'copy' : 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');

      // 从配图库拖入
      const imgId = e.dataTransfer.getData('text/imgid');
      if (imgId) {
        const img = state.images.find((i) => i.id === imgId);
        if (img && img.status === 'done') {
          const dropIdx = parseInt(card.dataset.idx);
          state.stitch.splice(dropIdx, 0, {
            type: 'image',
            imgId: img.id,
            prompt: img.prompt,
            url: img.url,
            caption: img.caption,
          });
          renderStitch();
          saveStitch();
          toast('图片已插入拼接区');
        }
        return;
      }

      // 拼接区内部排序
      const dropIdx = parseInt(card.dataset.idx);
      if (dragSrcIdx === null || dragSrcIdx === dropIdx) return;
      const [moved] = state.stitch.splice(dragSrcIdx, 1);
      state.stitch.splice(dropIdx, 0, moved);
      state.selectedStitchIdx = dropIdx;
      renderStitch();
      saveStitch();
      dragSrcIdx = null;
    });
  });

  // 拼接区空白处也接受拖入（追加到末尾）—— 只绑定一次
  if (stitchColDropBound) return;
  stitchColDropBound = true;
  const stitchCol = $('col-stitch');
  stitchCol.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/imgid')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  stitchCol.addEventListener('drop', (e) => {
    // 如果 drop 到了卡片上，上面的 handler 已经处理，这里只处理空白区
    if (e.target.id === 'col-stitch' || e.target.classList.contains('stitch-empty')) {
      e.preventDefault();
      const imgId = e.dataTransfer.getData('text/imgid');
      if (imgId) {
        const img = state.images.find((i) => i.id === imgId);
        if (img && img.status === 'done') {
          state.stitch.push({
            type: 'image',
            imgId: img.id,
            prompt: img.prompt,
            url: img.url,
            caption: img.caption,
          });
          renderStitch();
          saveStitch();
          toast('图片已加入拼接区');
        }
      }
    }
  });
}

/* ===== 拼接区操作 ===== */
function selectStitch(idx) {
  state.selectedStitchIdx = idx;
  renderStitch();
}
function editStitch(idx) {
  if (state.stitch[idx].type !== 'text') return;
  state.stitch[idx].editing = true;
  renderStitch();
  setTimeout(() => {
    const ta = document.querySelector(`.stitch-card[data-idx="${idx}"] textarea`);
    if (ta) ta.focus();
  }, 50);
}
function saveEdit(idx, val) {
  state.stitch[idx].text = val;
  state.stitch[idx].editing = false;
  renderStitch();
  saveStitch();
}
function removeItem(idx) {
  state.stitch.splice(idx, 1);
  if (state.selectedStitchIdx === idx) state.selectedStitchIdx = null;
  else if (state.selectedStitchIdx > idx) state.selectedStitchIdx--;
  renderStitch();
  saveStitch();
  toast('已删除');
}
function deleteStitch() {
  if (state.selectedStitchIdx === null) { toast('请先选中一段'); return; }
  removeItem(state.selectedStitchIdx);
}
function clearStitch() {
  state.stitch = [];
  state.selectedStitchIdx = null;
  renderStitch();
  saveStitch();
  toast('已清空');
}

/* ===== 自动存稿 ===== */
function saveStitch() {
  localStorage.setItem('ww_stitch', JSON.stringify(state.stitch));
}
function loadStitch() {
  const raw = localStorage.getItem('ww_stitch');
  if (!raw) return;
  try {
    state.stitch = JSON.parse(raw);
    renderStitch();
  } catch {}
}

/* ===== 导出（文字+图片位置标记） ===== */
function exportText() {
  if (state.stitch.length === 0) { toast('拼接区为空'); return; }
  const parts = state.stitch.map((s) => {
    if (s.type === 'image') {
      return `[图片: ${s.caption || s.prompt || ''}]`;
    }
    return s.text;
  });
  const text = parts.join('\n\n');
  copyToClipboard(text)
    .then(() => toast('已复制到剪贴板'))
    .catch(() => {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'final_text.txt';
      a.click();
      URL.revokeObjectURL(url);
      toast('已下载文件');
    });
}

/* ===== 载入示例 ===== */
function loadDemo() {
  $('rawInput').value = DEMO_TEXT;
  toast('已载入示例');
}

/* ===== 暴露到 window ===== */
window.pickAll = pickAll;
window.copyText = copyText;
window.addSelectedToStitch = addSelectedToStitch;
window.sendToStitch = sendToStitch;
window.regenerateColumn = regenerateColumn;
window.selectStitch = selectStitch;
window.editStitch = editStitch;
window.saveEdit = saveEdit;
window.removeItem = removeItem;
window.deleteStitch = deleteStitch;
window.clearStitch = clearStitch;
window.exportText = exportText;
window.closeLightbox = closeLightbox;
window.sendImageToStitch = sendImageToStitch;
window.switchView = switchView;
window.addCompareRowToStitch = addCompareRowToStitch;

/* ===== 初始化 ===== */
$('generateBtn').addEventListener('click', generate);
$('demoBtn').addEventListener('click', loadDemo);
$('backBtn').addEventListener('click', showInputPage);
$('saveKeyBtn').addEventListener('click', saveKey);
$('clearKeyBtn').addEventListener('click', clearKey);
$('llmProvider').addEventListener('change', updateModelOptions);

// 快捷键
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if ($('page-input').style.display !== 'none') generate();
  }
  if (e.key === 'Escape') {
    if ($('lightbox').style.display !== 'none') {
      closeLightbox();
    } else if ($('page-result').classList.contains('active')) {
      showInputPage();
    }
  }
});

updateModelOptions();
loadKey();
loadStitch();

// 配图开关：仅在 imagifly cookie 已配置时显示
if (IMAGIFLY_ENABLED && $('imgToggleRow')) {
  $('imgToggleRow').style.display = '';
}
