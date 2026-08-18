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
    '\n\n## 当前任务\n你是 human-writing 技能。用户会给你一段文字，请按本 SKILL.md 的规则改写它。直接输出改写后的正文，不要输出标题、不要展示内部提纲、不要解释你做了什么。\n\n## 思考约束\n如果你有思考过程，请控制在 400 字以内：只快速确认改写要点（语气/口吻/关键改法），不要逐句分析原文，不要预写草稿。',
  'humanizer-zh':
    skillHumanizerZh +
    '\n\n## 当前任务\n你是 humanizer-zh 技能。用户会给你一段文字，请按本 SKILL.md 的特征清单凭语感直接改写。输出要求：\n1. 只输出正文段落，禁止输出任何 markdown 标题（#、##）、禁止评分、禁止附更改总结\n2. 不要解释你做了什么\n\n## 思考约束（重要）\n你的思考过程必须在 300 字以内。禁止在思考中逐条对照特征清单、禁止逐句分析原文、禁止预写草稿。只快速记下 3~5 个命中要点（如「排比、空洞总结、破折号过多」），然后立刻开始写正文。',
  'ljg-plain':
    skillLjgPlain +
    '\n\n## 当前任务\n你是 ljg-plain 技能。用户会给你一段文字，请按本 SKILL.md 的 9 条红线改写它，让一个 12 岁孩子能懂。直接输出改写后的正文，不要写文件、不要附修改清单。\n\n## 思考约束\n如果你有思考过程，请控制在 400 字以内：只圈出需要降维的术语和长句，不要解释每条红线，不要预写草稿。',
};

/* ===== 自定义技能数据层 ===== */
/**
 * 自定义技能持久化：localStorage `ww_custom_skills`
 * 格式：[{id, name, color, prompt, enabled}]
 * - id 形如 custom-<base36 时间戳>，用作列 DOM id / state 键 / pid 前缀，
 *   只含安全字符（字母数字连字符），可直接拼进选择器
 * - 内置技能不可删改；自定义技能可增删改、可停用（停用后不参与生成/对齐）
 */
function loadCustomSkills() {
  try {
    const arr = JSON.parse(localStorage.getItem('ww_custom_skills') || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && s.id && s.name && s.prompt)
      .map((s) => ({
        id: String(s.id).replace(/[^a-zA-Z0-9-]/g, ''),
        name: String(s.name).slice(0, 24),
        color: /^#[0-9a-fA-F]{6}$/.test(s.color || '') ? s.color : '#7c3aed',
        prompt: String(s.prompt),
        enabled: s.enabled !== false,
      }))
      .filter((s) => s.id.startsWith('custom-'));
  } catch {
    return [];
  }
}
function saveCustomSkills() {
  localStorage.setItem('ww_custom_skills', JSON.stringify(state.customSkills));
}

/** 内置技能 id（顺序即列顺序） */
const BUILTIN_SKILLS = ['human-writing', 'humanizer-zh', 'ljg-plain'];

/** 当前生效技能列表（内置 + 已启用自定义）——全应用唯一技能来源 */
function getActiveSkills() {
  return [
    ...BUILTIN_SKILLS,
    ...state.customSkills.filter((s) => s.enabled).map((s) => s.id),
  ];
}
function getCustomSkill(id) {
  return state.customSkills.find((s) => s.id === id) || null;
}

/** 技能元信息（内置查 SKILL_META，自定义查 state；找不到给中性兜底） */
function getSkillMeta(skill) {
  if (SKILL_META[skill]) return SKILL_META[skill];
  const c = getCustomSkill(skill);
  if (c) return { label: c.name, color: c.color, desc: '自定义' };
  return { label: skill, color: '#7c3aed', desc: '' };
}

/** 自定义技能的通用任务后缀：与内置技能同样的输出纪律 */
const CUSTOM_TASK_SUFFIX = (name) =>
  `\n\n## 当前任务\n你是「${name}」技能。用户会给你一段文字，请严格按上述规则改写它。输出要求：\n1. 直接输出改写后的正文，禁止输出任何 markdown 标题（#、##）、禁止评分、禁止附更改总结\n2. 不要解释你做了什么\n\n## 思考约束\n如果你有思考过程，请控制在 400 字以内：只快速确认改写要点，不要逐句分析原文，不要预写草稿。`;

/** 技能 → system prompt（内置用 SKILL_PROMPTS，自定义用「用户提示词 + 任务后缀」运行时合成） */
function getSkillPrompt(skill) {
  if (SKILL_PROMPTS[skill]) return SKILL_PROMPTS[skill];
  const c = getCustomSkill(skill);
  if (c) return c.prompt.trim() + CUSTOM_TASK_SUFFIX(c.name);
  return '';
}

/** 为生效技能补齐 state 结构（generated/paragraphs/busy 以技能 id 为键） */
function ensureSkillState() {
  for (const id of getActiveSkills()) {
    if (!(id in state.generated)) state.generated[id] = '';
    if (!(id in state.paragraphs)) state.paragraphs[id] = [];
    if (!(id in state.busy)) state.busy[id] = false;
  }
}

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
  customSkills: loadCustomSkills(),  // 自定义技能 [{id,name,color,prompt,enabled}]
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

/**
 * 健壮的 JSON 数组提取器。
 * LLM 输出可能夹带杂质（解释文字、半截 token）或被流截断，
 * 直接 match(/\[[\s\S]*\]/) + JSON.parse 会把损坏数据当有效数据。
 * 策略：从首个 [ 开始，用括号配平找完整数组边界，损坏则返回 null。
 */
function extractJsonArray(text) {
  if (!text) return null;
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const arr = JSON.parse(candidate);
          return Array.isArray(arr) ? arr : null;
        } catch {
          return null; // 边界找到了但内容损坏 → 视为失败，交给上层降级
        }
      }
    }
  }
  return null; // 流被截断，找不到配平的右括号
}

/* ===== 主题切换（明/暗） ===== */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = theme === 'dark' ? '☀️' : '🌙';
  const b1 = $('themeBtn1'); const b2 = $('themeBtn2');
  if (b1) b1.textContent = icon;
  if (b2) b2.textContent = icon;
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ww_theme', next);
  applyTheme(next);
}
applyTheme(localStorage.getItem('ww_theme') || 'light');

/* ===== 阅读字号调节（结果页 A-/A+） ===== */
const READING_FS_STEPS = [14, 15, 16, 17, 18];
function getReadingFs() {
  const v = parseInt(localStorage.getItem('ww_reading_fs') || '15', 10);
  return READING_FS_STEPS.includes(v) ? v : 15;
}
function applyReadingFs() {
  const fs = getReadingFs();
  const pageEl = $('page-result');
  if (pageEl) pageEl.style.setProperty('--reading-fs', fs + 'px');
  const val = $('fsVal'); const down = $('fsDown'); const up = $('fsUp');
  if (val) val.textContent = fs;
  if (down) down.disabled = fs <= READING_FS_STEPS[0];
  if (up) up.disabled = fs >= READING_FS_STEPS[READING_FS_STEPS.length - 1];
}
function adjustReadingFs(delta) {
  const idx = READING_FS_STEPS.indexOf(getReadingFs());
  const next = READING_FS_STEPS[Math.min(READING_FS_STEPS.length - 1, Math.max(0, idx + delta))];
  localStorage.setItem('ww_reading_fs', String(next));
  applyReadingFs();
}
applyReadingFs();

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
    $('llmModel').innerHTML = p.models.map((m) => {
      const label = getModelLabel(m);
      return `<option value="${m}" title="${escapeHtml(label)}">${escapeHtml(label)}</option>`;
    }).join('');
  }
}

/* ===== 调用 LLM（流式 + 超时 + 重试 + 模型特性适配 + 空闲看门狗） ===== */
/**
 * onRetryReset（可选第 6 参）：重试开始前回调，调用方用它清空已渲染的残留输出，
 * 防止「第一次流式输出一半失败 → 重试成功 → 正文出现两遍」。
 */
async function callLLM(systemPrompt, userText, config, onChunk, onReasoning, onRetryReset) {
  const { model, apiKey, baseUrl, temperature } = config;
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
          temperature: temperature ?? 0.7,
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
      // 运行时特性纠正：供应商会调整模型行为（如 flash-0731 曾从只出 reasoning
      // 变为 reasoning+content 双出），静态特性表会过时。
      // 以「流里实际出现过什么字段」为准：
      // - 标 normal/reasoning_only，但流里双出 → 自动按 reasoning 处理（思考归面板）
      // - 流结束时正文为空但 reasoning 有内容 → reasoning 当正文（reasoning_only 行为）
      let sawReasoning = false;
      let sawContent = false;
      let effectiveTrait = trait;
      const applyDelta = (d) => {
        if (effectiveTrait === 'reasoning') {
          if (d.reasoning_content) {
            reasoning += d.reasoning_content;
            if (onReasoning) onReasoning(d.reasoning_content);
          }
          if (d.content) {
            full += d.content;
            if (onChunk) onChunk(d.content);
          }
        } else if (effectiveTrait === 'reasoning_only') {
          if (d.reasoning_content) {
            full += d.reasoning_content;
            if (onChunk) onChunk(d.reasoning_content);
          }
        } else {
          if (d.content) {
            full += d.content;
            if (onChunk) onChunk(d.content);
          }
        }
      };
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
            if (!delta) continue;
            if (delta.reasoning_content) sawReasoning = true;
            if (delta.content) sawContent = true;
            // 双流纠正：标错为 normal/reasoning_only 的模型实际是思考+正文双输出
            // 切换前先把已按旧规则渲染进正文/思考的内容撤回（full 已渲染给 onChunk，
            // 由外层的段落重建兜底；这里只保证最终返回值正确分区）
            if (sawReasoning && sawContent && effectiveTrait !== 'reasoning') {
              console.warn(`[callLLM] 特性纠正: ${model} 标记为 ${trait}，实际输出思考+正文双流，按 reasoning 处理`);
              full = '';
              effectiveTrait = 'reasoning';
            }
            applyDelta(delta);
          } catch {}
        }
      }
      clearTimeout(idleTimer);
      // 流结束纠正：全程只出了 reasoning 没有 content → 该模型正文全在 reasoning 里
      if (!full && reasoning) {
        console.warn(`[callLLM] 特性纠正: ${model} 正文为空，reasoning 当正文（reasoning_only 行为）`);
        return { text: reasoning, reasoning: '' };
      }
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
 *
 * 精度设计（解决边界偏移/粒度不一致）：
 * 1. LLM 不直接给边界位置，而是给每段「原文首句引文 anchor」——
 *    引文必须在原文中逐字存在，程序用 indexOf 定位真实字符偏移，
 *    边界由程序确定，LLM 只负责语义判断
 * 2. 粒度与原文自然段落数挂钩（程序先数好空行分段，提示词里给出
 *    推荐段数区间），避免长文切太粗、短文切太碎
 * 3. anchor 定位失败（LLM 改写了引文）→ 模糊匹配兜底 → 仍失败丢弃该段
 * 返回 [{title, gist, anchor, start}, ...]
 */
async function deriveSections(rawText, config) {
  // 程序先数自然段，给 LLM 明确的粒度锚
  const naturalParas = splitParagraphs(rawText);
  const n = naturalParas.length;
  const minSecs = Math.max(2, Math.min(8, Math.floor(n / 4)));
  const maxSecs = Math.max(minSecs, Math.min(8, Math.ceil(n / 2)));

  const systemPrompt = `你是一个文章结构分析器。把用户原文按语义拆分成 ${minSecs}~${maxSecs} 个「标准段落」。

输出格式严格为 JSON 数组，不要输出任何其他内容：
[{"title":"该段小标题(6~12字)","gist":"该段内容概要(30字内)","anchor":"该段第一句的前 10~20 个字，必须逐字摘自原文，不得改写"}]

要求：
- 按行文逻辑分段（引入/背景/展开/案例/转折/收尾等）
- **anchor 是关键**：必须是该段开头第一句的前 10~20 个字，逐字复制原文，一个字都不能改。
  程序会用它在原文中定位段落边界，改写或概括会导致定位失败
- 每段的 anchor 必须按原文出现顺序排列，后一段的 anchor 在原文中的位置必须晚于前一段
- 相邻两段不能来自同一个自然段的中途硬切——如果某个自然段主题完整，整段归入一个标准段
- title 概括该段主题；gist 说明该段讲了什么`;

  try {
    const result = await callLLM(systemPrompt, rawText, { ...config, temperature: 0 }, () => {});
    const text = result.text || '';
    const arr = extractJsonArray(text);
    if (arr && arr.length >= 2) {
      // 用 anchor 在原文定位每段起点；定位失败的段尝试模糊匹配，仍失败则丢弃
      let cursor = 0; // 保证顺序单调：后一段起点必须晚于前一段
      const sections = [];
      for (const s of arr) {
        const anchor = (s.anchor || '').trim();
        if (!anchor) continue;
        let start = rawText.indexOf(anchor, cursor);
        if (start === -1) {
          // 模糊兜底：取 anchor 前 8 字再找
          const prefix = anchor.substring(0, 8);
          if (prefix.length >= 4) start = rawText.indexOf(prefix, cursor);
        }
        if (start === -1 || start < cursor) continue; // 定位失败/乱序 → 丢弃该段
        sections.push({ title: s.title || '', gist: s.gist || '', anchor, start });
        cursor = start + anchor.length;
      }
      // 首段起点归 0：原文开头必然属于第一段（LLM 的 anchor 可能跳过引入句）
      if (sections.length >= 2) {
        if (sections[0].start > 0) sections[0].start = 0;
        return sections;
      }
    }
  } catch {}
  // 回退：按原文空行分段
  const paras = splitParagraphs(rawText);
  if (paras.length >= 2) {
    let off = 0;
    return paras.slice(0, 8).map((p) => {
      const start = rawText.indexOf(p, off);
      off = start + p.length;
      return { title: p.substring(0, 10), gist: p.substring(0, 30), anchor: p.substring(0, 15), start: Math.max(0, start) };
    });
  }
  return [{ title: '全文', gist: rawText.substring(0, 30), anchor: rawText.substring(0, 15), start: 0 }];
}

/**
 * 第二步：把某个 skill 的输出段落「分配」到标准分段上。
 * 只让 LLM 输出段落编号 → 标准段编号的映射（数字数组），
 * 文字本身原样保留（不丢任何细节）。
 * 返回 number[]，第 i 项 = 该段落归属的标准段 idx；-1 = 无法归属（新增内容）
 */
async function alignSkillToSections(sections, skillParas, config) {
  // 每个标准段附上 anchor 原文开头，让对齐器对照原文而非只看摘要猜
  const sectionList = sections
    .map((s, i) => `${i}. ${s.title}：${s.gist}\n   原文开头：…${(s.anchor || '').substring(0, 20)}…`)
    .join('\n');
  const paraList = skillParas.map((p, i) => `${i}. ${p.substring(0, 120)}`).join('\n');

  const systemPrompt = `你是一个段落对齐器。有一份「标准分段」（从原文提取，含每段的原文开头引文）和一份「改写稿的段落列表」（某个改写技能的输出，已按空行拆分并编号）。

标准分段：
${sectionList}

改写稿段落：
${paraList}

请判断：改写稿的每个段落分别对应当文中的哪个标准段。判断依据：改写稿段落的内容能与哪个标准段的「原文开头/概要」对应上（改写可能合并/拆分/调序/增删，按段落的主要内容判断归属）。

输出格式严格为 JSON 数字数组，长度必须等于改写稿段落数，不要输出任何其他内容：
[段0对应的标准段编号, 段1对应的编号, ...]

规则：
- 每项是 0 到 ${sections.length - 1} 的整数
- 若某段是改写稿新增的内容（原文没有对应部分，如结尾总结/观点延伸），填 -1
- 逐个数清楚，输出的数组长度必须与改写稿段落数一致
- 不要输出解释`;

  try {
    // 结构化映射任务用温度 0：实测温度 0.7 下 flash 模型会偶发漏数
    // （返回数组比段落数少 1~2 项），导致整体降级为顺序分配
    const result = await callLLM(systemPrompt, '开始对齐', { ...config, temperature: 0 }, () => {});
    const text = result.text || '';
    const arr = extractJsonArray(text);
    if (arr && arr.every((n) => Number.isInteger(n))) {
      const valid = (v) => (v >= -1 && v < sections.length ? v : -1);
      // 长度精确匹配：直接用
      if (arr.length === skillParas.length) return arr.map(valid);
      // 偏差 1~2 项（模型偶发漏数）：按邻近填充修补，仍可保留绝大部分正确映射
      if (Math.abs(arr.length - skillParas.length) <= 2) {
        const out = arr.slice(0, skillParas.length).map(valid);
        while (out.length < skillParas.length) out.push(out.length ? out[out.length - 1] : 0);
        return out;
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
    for (const skill of getActiveSkills()) {
      const paras = state.paragraphs[skill];
      assigns[skill] =
        paras.length > 0 ? await alignSkillToSections(sections, paras, fastConfig) : [];
    }
    state.compare = { sections, assigns };
    // 重渲染技能列：卡片按标准段着色 + 列头加当前段指示 + 绑定同步滚动
    getActiveSkills().forEach((s) => {
      renderColumnCards(s);
      const head = $('col-' + s).previousElementSibling;
      if (head && !head.querySelector('.sec-hint')) {
        const hint = document.createElement('div');
        hint.className = 'sec-hint';
        hint.id = 'secHint-' + s;
        head.appendChild(hint);
      }
    });
    bindSyncScroll();
    $('statusText').textContent = `${prevStatus} · 分段对比就绪（三列已同步联动）`;
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

/* ===== 三列同步滚动（自由视图，基于分段对齐映射） ===== */
/**
 * 滚动任一列 → 由该列当前顶部可见段落反查所属标准段 → 其余两列滚到
 * 该标准段的首张卡片。双向联动：任一列都能作为驱动方。
 * - 仅在 compare 数据就绪 + 自由视图下生效
 * - syncLock 防级联触发（程序滚动也会触发 scroll 事件）
 * - 用户滚到底部时驱动其余列也到底部（阅读长段时的自然预期）
 */
const syncScroll = { locked: false, raf: null };

function bindSyncScroll() {
  const skills = getActiveSkills();
  skills.forEach((skill) => {
    const el = $('col-' + skill);
    if (!el || el.dataset.syncBound) return;
    el.dataset.syncBound = '1';
    el.addEventListener('scroll', () => {
      if (syncScroll.locked || state.viewMode !== 'free' || !state.compare) return;
      syncScroll.locked = true;
      if (syncScroll.raf) cancelAnimationFrame(syncScroll.raf);
      syncScroll.raf = requestAnimationFrame(() => driveSyncScroll(skill));
    });
  });
}

/** 以 skill 列的当前视口为驱动，同步其余列 */
function driveSyncScroll(sourceSkill) {
  try {
    const { assigns } = state.compare;
    const skills = getActiveSkills();
    const srcEl = $('col-' + sourceSkill);
    const srcAssign = assigns[sourceSkill] || [];

    // 到底/接近底部 → 其余列也到底
    const atBottom = srcEl.scrollTop + srcEl.clientHeight >= srcEl.scrollHeight - 30;
    if (atBottom) {
      skills.forEach((sk) => {
        if (sk !== sourceSkill) {
          const el = $('col-' + sk);
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
      updateSectionIndicator(sourceSkill, srcAssign.length - 1);
      return;
    }

    // 找当前顶部可见的源列段落（视口顶部 + 少量偏移内第一张卡）
    const cards = Array.from(srcEl.querySelectorAll('.para-card'));
    const probe = srcEl.scrollTop + 40;
    let visIdx = 0;
    for (const c of cards) {
      if (c.offsetTop <= probe) visIdx = parseInt(c.dataset.pidx);
      else break;
    }
    const secIdx = srcAssign[visIdx];
    updateSectionIndicator(sourceSkill, visIdx);

    if (secIdx == null || secIdx < 0) return; // 新增内容段：无对齐目标，不驱动
    // 其余列滚到该标准段的首张卡片
    skills.forEach((sk) => {
      if (sk === sourceSkill) return;
      const el = $('col-' + sk);
      if (!el) return;
      const a = assigns[sk] || [];
      const firstPi = a.findIndex((t) => t === secIdx);
      if (firstPi < 0) return; // 该列此段无对应
      const target = el.querySelector(`.para-card[data-pidx="${firstPi}"]`);
      if (target) el.scrollTop = target.offsetTop - 8;
    });
  } finally {
    // 程序滚动触发其余列的 scroll 事件 → locked 挡住；稍后解锁
    setTimeout(() => { syncScroll.locked = false; }, 80);
  }
}

/** 列头当前段指示：更新列头下的「第 X/Y 段 · 标题」 */
function updateSectionIndicator(skill, paraIdx) {
  const hint = $('secHint-' + skill);
  if (!hint || !state.compare) return;
  const { sections, assigns } = state.compare;
  const secIdx = (assigns[skill] || [])[paraIdx];
  if (secIdx == null || secIdx < 0) {
    hint.textContent = '✦ 新增内容';
    hint.style.color = 'var(--c3)';
  } else {
    const total = sections.length;
    hint.textContent = `§${secIdx + 1}/${total} ${sections[secIdx].title}`;
    hint.style.color = SECTION_COLORS[secIdx % SECTION_COLORS.length];
  }
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

/* ===== 动态列渲染 ===== */
/**
 * 按当前生效技能（内置 + 已启用自定义）重建技能列 DOM。
 * 列布局固定为：[配图库][技能列 ×N][拼接区]，技能列整体在中间段重建。
 * 列 id 约定 col-<skill>，与既有交互（选择/双击收入/对齐联动/同步滚动）完全兼容。
 */
function renderColumns() {
  ensureSkillState();
  const wrap = $('columnsWrap');
  // 删掉旧技能列（data-skill 标记；配图库/拼接区不带该标记，保持不动）
  wrap.querySelectorAll('.col[data-skill]').forEach((el) => el.remove());
  const stitchColEl = wrap.querySelector('.col-stitch');
  const skills = getActiveSkills();
  const frag = document.createDocumentFragment();
  for (const skill of skills) {
    const meta = getSkillMeta(skill);
    const col = document.createElement('div');
    col.className = 'col col-skill';
    col.dataset.skill = skill;
    col.innerHTML = `
      <div class="col-head" style="border-top:3px solid ${meta.color}">
        <span class="col-dot" style="background:${meta.color}"></span>
        <span>${escapeHtml(meta.label)}</span>
        <span class="skill-desc">${escapeHtml(meta.author || meta.desc || '')}</span>
        <button class="btn btn-mini" onclick="addSelectedToStitch('${skill}')" title="把选中（或全文）段落加入拼接区">加入拼接区</button>
        <button class="btn btn-mini btn-regen" onclick="regenerateColumn('${skill}')" title="重新生成此列">↻</button>
        <button class="btn btn-mini" onclick="pickAll('${skill}')">全选</button>
      </div>
      <div class="col-body" id="col-${skill}"></div>`;
    frag.appendChild(col);
  }
  wrap.insertBefore(frag, stitchColEl);
}

/** 渲染分段对比视图：每个标准段一行，各 skill 横向并排 */
function renderCompare() {
  const wrap = $('compareView');
  if (!state.compare) {
    wrap.innerHTML = state.compareBuilding
      ? '<div class="thinking" style="padding:40px 0;justify-content:center"><div class="dots"><span></span><span></span><span></span></div>正在分析文章结构并对齐各列输出…</div>'
      : '<div class="stitch-empty" style="margin:40px 20px">分段对比数据不可用<br>可点击「重新生成」后再试</div>';
    return;
  }
  const { sections, assigns } = state.compare;
  const skills = getActiveSkills();

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
        <div class="cmp-sec" style="border-left:3px solid ${SECTION_COLORS[si % SECTION_COLORS.length]}">
          <div class="cmp-sec-title">${si + 1}. ${escapeHtml(sec.title)}</div>
          <div class="cmp-sec-gist">${escapeHtml(sec.gist)}</div>
          <button class="btn btn-mini cmp-row-btn" onclick="addCompareRowToStitch(${si})" title="把此段中选中的（或全部）卡片收入拼接区">整行收入</button>
        </div>
        <div class="cmp-cells" style="--cmp-n:${skills.length}">${cells}</div>
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
      <div class="cmp-cells" style="--cmp-n:${skills.length}">${cells}</div>
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
  const skills = getActiveSkills();
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

/* ===== 技能管理面板（输入页折叠面板：技能列表 + 添加/编辑/删除/启停） ===== */
/**
 * 面板数据流：
 * - renderSkillManager()：全量重绘技能列表（内置只读 + 自定义带操作按钮）
 * - 编辑态用 editingSkillId 标记（null=添加模式，'custom-xxx'=编辑模式）
 * - 增删改启停 → 更新 state.customSkills → saveCustomSkills() → renderSkillManager()
 */
let editingSkillId = null;

function renderSkillManager() {
  const listEl = $('skillManagerList');
  if (!listEl) return;
  // 内置技能（只读展示，附 GitHub 链接）
  const builtinRows = BUILTIN_SKILLS.map((id) => {
    const m = SKILL_META[id];
    return `<div class="sm-row sm-builtin">
      <span class="dot" style="background:${m.color}"></span>
      <span class="sm-name">${escapeHtml(m.label)}</span>
      <span class="sm-desc">${escapeHtml(m.desc || '')}</span>
      <a class="sm-link" href="${m.github}" target="_blank" title="查看 SKILL.md 源仓库">源仓库 ↗</a>
      <span class="sm-badge">内置</span>
    </div>`;
  }).join('');
  // 自定义技能
  const customRows = state.customSkills.map((s) => {
    const editing = editingSkillId === s.id;
    return `<div class="sm-row sm-custom ${editing ? 'sm-editing' : ''}">
      <input type="checkbox" class="sm-toggle" ${s.enabled ? 'checked' : ''} onchange="toggleCustomSkill('${s.id}')" title="${s.enabled ? '停用（不参与生成）' : '启用'}">
      <span class="dot" style="background:${s.color}"></span>
      <span class="sm-name">${escapeHtml(s.name)}</span>
      <span class="sm-desc">${escapeHtml(s.prompt.substring(0, 30))}${s.prompt.length > 30 ? '…' : ''}</span>
      <span class="sm-act" onclick="editCustomSkillForm('${s.id}')">编辑</span>
      <span class="sm-act sm-act-danger" onclick="deleteCustomSkill('${s.id}')">删除</span>
    </div>`;
  }).join('');
  listEl.innerHTML =
    builtinRows +
    (customRows || '<div class="sm-empty">还没有自定义技能。展开下方「添加技能」写一个试试。</div>');

  // 添加/编辑表单区
  const form = $('skillForm');
  if (!form) return;
  if (editingSkillId === null) {
    form.style.display = 'none';
    $('skillFormToggleText').textContent = '▸ 添加技能';
  } else {
    form.style.display = '';
    $('skillFormToggleText').textContent = '▾ 收起表单';
    const editing = editingSkillId !== '' ? getCustomSkill(editingSkillId) : null;
    if (editing) {
      $('skillName').value = editing.name;
      $('skillColor').value = editing.color;
      $('skillPrompt').value = editing.prompt;
      $('skillFormTitle').textContent = `编辑技能：${editing.name}`;
      $('skillFormSubmitText').textContent = '保存修改';
    } else {
      $('skillFormTitle').textContent = '添加自定义技能';
      $('skillFormSubmitText').textContent = '添加';
    }
  }
}

/** 展开添加表单（editingSkillId='' 表示新增模式） */
function openSkillForm() {
  editingSkillId = editingSkillId === null ? '' : null; // 再点一次收起
  if (editingSkillId === '') {
    $('skillName').value = '';
    $('skillColor').value = '#7c3aed';
    $('skillPrompt').value = '';
  }
  renderSkillManager();
}
function editCustomSkillForm(id) {
  editingSkillId = id;
  renderSkillManager();
}
function submitSkillForm() {
  const name = $('skillName').value.trim();
  const color = $('skillColor').value;
  const prompt = $('skillPrompt').value.trim();
  if (!name) { toast('技能名称不能为空'); return; }
  if (prompt.length < 10) { toast('系统提示词太短了（至少 10 字）'); return; }
  if (editingSkillId) {
    // 编辑模式
    const s = getCustomSkill(editingSkillId);
    if (!s) { toast('技能不存在'); editingSkillId = null; renderSkillManager(); return; }
    s.name = name.slice(0, 24);
    s.color = color;
    s.prompt = prompt;
    saveCustomSkills();
    editingSkillId = null;
    renderSkillManager();
    toast('技能已更新');
  } else {
    // 添加模式
    if (state.customSkills.length >= 5) { toast('最多 5 个自定义技能（列宽限制）'); return; }
    const id = 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.customSkills.push({ id, name: name.slice(0, 24), color, prompt, enabled: true });
    saveCustomSkills();
    editingSkillId = null;
    renderSkillManager();
    toast(`已添加技能「${name}」，点「生成三版」即会多出一列`);
  }
}
function toggleCustomSkill(id) {
  const s = getCustomSkill(id);
  if (!s) return;
  s.enabled = !s.enabled;
  saveCustomSkills();
  renderSkillManager();
  toast(s.enabled ? `已启用「${s.name}」` : `已停用「${s.name}」（下次生成不再出现）`);
}
function deleteCustomSkill(id) {
  const s = getCustomSkill(id);
  if (!s) return;
  if (!confirm(`确定删除自定义技能「${s.name}」？\n（拼接区中已收入的该技能段落不受影响）`)) return;
  state.customSkills = state.customSkills.filter((x) => x.id !== id);
  saveCustomSkills();
  if (editingSkillId === id) editingSkillId = null;
  renderSkillManager();
  toast('已删除');
}

/* ===== 技能试跑：表单草稿提示词 → 真实 LLM 调用 → 结果预览 ===== */
/**
 * 目的：新增/编辑技能时先验证提示词效果，避免保存后跑真文才发现问题。
 * 样文来源：输入框已有原文 → 取前 600 字；否则用 DEMO_TEXT。
 * 提示词：表单草稿 + CUSTOM_TASK_SUFFIX（与正式生成完全一致的合成规则）。
 */
let skillTesting = false;
async function testCustomSkill() {
  if (skillTesting) return; // 防重复点击
  const name = $('skillName').value.trim() || '未命名技能';
  const prompt = $('skillPrompt').value.trim();
  const resultEl = $('skillTestResult');
  const btn = $('skillTestBtn');
  if (prompt.length < 10) {
    resultEl.style.display = '';
    resultEl.className = 'sm-test-result warn';
    resultEl.innerHTML = '系统提示词太短（至少 10 字），先写好再试跑。';
    return;
  }
  const config = getLLMConfig();
  if (!config.apiKey) {
    resultEl.style.display = '';
    resultEl.className = 'sm-test-result err';
    resultEl.innerHTML = '请先在「① 文字模型」填好 API Key 再试跑。';
    return;
  }
  if (!config.model) {
    resultEl.style.display = '';
    resultEl.className = 'sm-test-result err';
    resultEl.innerHTML = '请先在「① 文字模型」选择模型再试跑。';
    return;
  }
  // 样文：输入框原文优先，截前 600 字；否则 DEMO_TEXT
  const raw = $('rawInput').value.trim();
  const sample = raw ? raw.substring(0, 600) : DEMO_TEXT;
  const sourceLabel = raw ? '输入框原文（前 600 字）' : '内置示例文';
  skillTesting = true;
  btn.disabled = true;
  btn.textContent = '试跑中…';
  resultEl.style.display = '';
  resultEl.className = 'sm-test-result loading';
  resultEl.innerHTML = `正在用「${escapeHtml(config.model)}」试跑（样文：${sourceLabel}），稍候…`;
  try {
    const { text } = await callLLM(
      prompt.trim() + CUSTOM_TASK_SUFFIX(name),
      sample,
      config
    );
    resultEl.className = 'sm-test-result ok';
    resultEl.innerHTML =
      `<div class="sm-test-head">✓ 试跑成功 · ${escapeHtml(name)} · ${escapeHtml(config.model)} · 样文：${sourceLabel}</div>` +
      `<div class="sm-test-body">${escapeHtml(text.trim() || '（空响应）')}</div>`;
  } catch (err) {
    resultEl.className = 'sm-test-result err';
    resultEl.innerHTML = `<div class="sm-test-head">✗ 试跑失败</div><div class="sm-test-body">${escapeHtml(err.message || String(err))}</div>`;
  } finally {
    skillTesting = false;
    btn.disabled = false;
    btn.textContent = '▶ 试跑';
  }
}

/* ===== 生图 API 配置面板 ===== */
/**
 * 交互流：
 * - 折叠面板（ww_imgapi_panel_collapsed 记忆态）
 * - 供应商切换 → 显隐 custom 字段 + 状态徽标更新
 * - API Key：password 输入框脱敏 + 👁 明文切换；已保存显示 ●●●尾4位
 * - 保存 → 校验 → ww_img_api 持久化 → 徽标/生图设置区同步刷新
 * - 测试连接 → testImgApiConnection → 成功绿/失败红 + 具体原因
 * - 恢复默认 → 确认后清 ww_img_api 回 imagifly
 */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
function initImgApiPanel() {
  const head = $('imgApiHead'), body = $('imgApiBody');
  if (!head || !body) return;
  const caret = $('imgApiCaret');
  const collapsed = localStorage.getItem('ww_imgapi_panel_collapsed') !== '0'; // 默认折叠，显式展开过才展开
  body.style.display = collapsed ? 'none' : '';
  if (caret) caret.textContent = collapsed ? '▸' : '▾';
  head.addEventListener('click', () => {
    const nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    if (caret) caret.textContent = nowCollapsed ? '▸' : '▾';
    localStorage.setItem('ww_imgapi_panel_collapsed', nowCollapsed ? '1' : '0');
  });

  // 供应商切换
  const provSel = $('imgApiProvider');
  if (provSel) {
    provSel.addEventListener('change', () => {
      // 切供应商只改 UI 预览，点保存才落库
      refreshImgApiCustomFields();
    });
  }

  // API Key 脱敏切换
  const keyInput = $('imgApiKey'), eye = $('imgApiKeyEye');
  if (keyInput && eye) {
    eye.addEventListener('click', () => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      eye.textContent = show ? '🙈' : '👁';
    });
  }

  // 比例预设 → 宽高联动
  const ratioSel = $('imgApiRatio');
  if (ratioSel) {
    ratioSel.addEventListener('change', () => {
      const hit = IMG_RATIO_PRESETS.find((p) => p.label === ratioSel.value);
      if (hit) {
        $('imgApiWidth').value = hit.w;
        $('imgApiHeight').value = hit.h;
      }
    });
  }
  // 宽高改动手输 → 比例下拉变「自定义」
  for (const id of ['imgApiWidth', 'imgApiHeight']) {
    const el = $(id);
    if (el) el.addEventListener('input', () => {
      const w = parseInt($('imgApiWidth').value), h = parseInt($('imgApiHeight').value);
      const rs = $('imgApiRatio');
      if (!rs) return;
      rs.value = IMG_RATIO_PRESETS.some((p) => p.w === w && p.h === h)
        ? IMG_RATIO_PRESETS.find((p) => p.w === w && p.h === h).label
        : '自定义';
    });
  }

  // 保存
  const saveBtn = $('imgApiSave');
  if (saveBtn) saveBtn.addEventListener('click', saveImgApiFromForm);
  // 测试连接
  const testBtn = $('imgApiTest');
  if (testBtn) testBtn.addEventListener('click', async () => {
    // 先保存当前表单（测试应基于所见配置），imagifly 供应商无需校验 key
    saveImgApiFromForm(true);
    const btn = $('imgApiTest'), out = $('imgApiTestResult');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '测试中…';
    out.style.display = 'none';
    const r = await testImgApiConnection();
    btn.disabled = false;
    btn.textContent = orig;
    out.style.display = '';
    out.className = 'imgapi-test-result ' + (r.ok ? 'ok' : 'err');
    out.textContent = (r.ok ? '✓ ' : '✗ ') + r.msg;
  });
  // 恢复默认
  const resetBtn = $('imgApiReset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!confirm('恢复默认生图配置？（切回 Imagifly 代理，清空自定义 API Key/地址/模型）')) return;
    localStorage.removeItem('ww_img_api');
    fillImgApiForm();
    refreshImgApiBadge();
    syncApiSizeInputs();
    toast('已恢复默认生图配置（Imagifly）');
  });

  fillImgApiForm();
  refreshImgApiBadge();
  syncApiSizeInputs();
}

/** 表单 → 配置对象 → 落库；silent=true 时不弹 toast（测试连接内部调用） */
function saveImgApiFromForm(silent) {
  const cfg = {
    provider: $('imgApiProvider').value,
    apiKey: $('imgApiKey').value.trim(),
    baseUrl: $('imgApiBaseUrl').value.trim(),
    model: $('imgApiModel').value.trim(),
    width: parseInt($('imgApiWidth').value) || IMG_API_DEFAULTS.width,
    height: parseInt($('imgApiHeight').value) || IMG_API_DEFAULTS.height,
  };
  if (cfg.provider === 'custom') {
    if (!cfg.apiKey) { if (!silent) toast('自定义 API 需填写 API Key'); return false; }
    if (!/^https?:\/\//.test(cfg.baseUrl)) { if (!silent) toast('接口地址需以 http(s):// 开头'); return false; }
    if (!cfg.model) { if (!silent) toast('请填写模型名（如 gpt-image-1）'); return false; }
    if (cfg.width < 64 || cfg.width > 4096 || cfg.height < 64 || cfg.height > 4096) {
      if (!silent) toast('宽高需在 64~4096 之间');
      return false;
    }
  }
  saveImgApiConfig(cfg);
  refreshImgApiBadge();
  syncApiSizeInputs();
  // 刷新脱敏标签（保存后立即可见已保存态）
  const maskedEl = $('imgApiKeyMasked');
  if (maskedEl) maskedEl.textContent = cfg.apiKey ? `已保存: ${maskKey(cfg.apiKey)}` : '未设置';
  if (!silent) toast('生图 API 配置已保存');
  return true;
}

/** 配置 → 表单（含 key 脱敏回显） */
function fillImgApiForm() {
  const cfg = getImgApiConfig();
  $('imgApiProvider').value = cfg.provider;
  $('imgApiKey').value = cfg.apiKey;
  $('imgApiKey').type = 'password';
  $('imgApiKeyEye').textContent = '👁';
  $('imgApiKeyMasked').textContent = cfg.apiKey ? `已保存: ${maskKey(cfg.apiKey)}` : '未设置';
  $('imgApiBaseUrl').value = cfg.baseUrl;
  $('imgApiModel').value = cfg.model;
  $('imgApiWidth').value = cfg.width;
  $('imgApiHeight').value = cfg.height;
  const hit = IMG_RATIO_PRESETS.find((p) => p.w === cfg.width && p.h === cfg.height);
  $('imgApiRatio').value = hit ? hit.label : '自定义';
  refreshImgApiCustomFields();
  $('imgApiTestResult').style.display = 'none';
}

/** custom 字段显隐（imagifly 时隐藏并提示走代理） */
function refreshImgApiCustomFields() {
  const isCustom = $('imgApiProvider').value === 'custom';
  const wrap = $('imgApiCustomFields');
  const note = $('imgApiImagiflyNote');
  if (wrap) wrap.style.display = isCustom ? '' : 'none';
  if (note) note.style.display = isCustom ? 'none' : '';
}

/** 状态徽标：imagifly / custom(模型名)；颜色区分 */
function refreshImgApiBadge() {
  const el = $('imgApiBadge');
  if (!el) return;
  const cfg = getImgApiConfig();
  if (cfg.provider === 'custom' && cfg.apiKey && cfg.baseUrl) {
    el.textContent = `自定义 · ${cfg.model || '未填模型'}`;
    el.className = 'imgapi-badge custom';
  } else if (cfg.provider === 'custom') {
    el.textContent = '自定义 · 配置不全';
    el.className = 'imgapi-badge warn';
  } else {
    el.textContent = 'Imagifly';
    el.className = 'imgapi-badge';
  }
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
    const result = await callLLM(systemPrompt, rawText, { ...config, temperature: 0.3 }, () => {});
    const text = result.text || '';
    const arr = extractJsonArray(text);
    if (arr && arr.length > 0) {
      return arr.map((item) => ({
        segment: item.segment || '',
        prompt: item.prompt || '',
      }));
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
 * 可用生图模型表（slug 与人类可读标签）。
 * slug 来源：imagifly.net 控制台观测（见 imagifly-batch 技能沉淀）。
 * Qwen-Image-Edit 是图生图模型，纯文生图场景不适用，故不列入。
 */
const IMAGE_MODELS = [
  { slug: 'nano-banana-2', label: 'nano-banana-2 · 综合质量好（默认）' },
  { slug: 'gpt-image-2', label: 'gpt-image-2 · 海报/含文字图' },
  { slug: 'Z-Image-Turbo', label: 'Z-Image-Turbo · 快速' },
  { slug: 'Wai-SDXL', label: 'Wai-SDXL · 二次元/插画' },
  { slug: 'grok-imagine-image-quality', label: 'grok-imagine · 高质量(易限流)' },
];
const DEFAULT_IMAGE_MODEL = 'nano-banana-2';

/** 读用户选择的生图模型（localStorage 持久化；未配置/失效值回退默认） */
function getImageModel() {
  const saved = localStorage.getItem('ww_img_model');
  return IMAGE_MODELS.some((m) => m.slug === saved) ? saved : DEFAULT_IMAGE_MODEL;
}
function setImageModel(slug) {
  if (!IMAGE_MODELS.some((m) => m.slug === slug)) return false;
  localStorage.setItem('ww_img_model', slug);
  return true;
}

/** 生图模型选择下拉框初始化（切换即时生效——generateImage 每次现读配置） */
function initImageModelSelect() {
  const sel = $('imgModelSelect');
  if (!sel) return;
  sel.innerHTML = IMAGE_MODELS.map(
    (m) => `<option value="${m.slug}"${m.slug === getImageModel() ? ' selected' : ''} title="${escapeHtml(m.label)}">${escapeHtml(m.label)}</option>`
  ).join('') + `<option value="__custom__">自定义 slug…</option>`;
  sel.addEventListener('change', () => {
    if (sel.value === '__custom__') {
      const slug = prompt('输入 Imagifly 生图模型的 slug（可在 imagifly.net 控制台查看）：');
      if (slug && slug.trim()) {
        localStorage.setItem('ww_img_model', slug.trim());
        toast(`生图模型已切换: ${slug.trim()}`);
        // 选中项显示自定义 slug（select 里没有对应 option，补一个）
        const opt = document.createElement('option');
        opt.value = slug.trim();
        opt.textContent = `${slug.trim()} · 自定义`;
        sel.insertBefore(opt, sel.lastElementChild);
        sel.value = slug.trim();
        return;
      }
      sel.value = getImageModel(); // 取消输入 → 回退当前生效值
      return;
    }
    setImageModel(sel.value);
    toast(`生图模型已切换: ${sel.value}`);
  });
}

/** 读生图尺寸/张数（下拉选择 + localStorage 持久化） */
const IMG_SIZES = ['1368x768', '1024x1024', '768x1368'];
const IMG_COUNTS = [1, 2, 3];
function getImageSize() {
  const saved = localStorage.getItem('ww_img_size');
  return IMG_SIZES.includes(saved) ? saved : '1368x768';
}
function getImageCount() {
  const saved = parseInt(localStorage.getItem('ww_img_count'));
  return IMG_COUNTS.includes(saved) ? saved : 1;
}
function initImageExtraSelects() {
  const sizeSel = $('imgSizeSelect');
  const countSel = $('imgCountSelect');
  if (sizeSel) {
    sizeSel.value = getImageSize();
    sizeSel.addEventListener('change', () => {
      localStorage.setItem('ww_img_size', sizeSel.value);
      toast(`图片尺寸: ${sizeSel.value}`);
      syncApiSizeInputs(); // API 配置面板的宽高联动
    });
  }
  if (countSel) {
    countSel.value = String(getImageCount());
    countSel.addEventListener('change', () => {
      localStorage.setItem('ww_img_count', countSel.value);
      toast(`每画面张数: ${countSel.value}`);
    });
  }
}

/* ===== 生图 API 配置（自定义 OpenAI 兼容接口 / Imagifly） ===== */
/**
 * localStorage `ww_img_api`：
 * {provider:'imagifly'|'custom', apiKey, baseUrl, model, width, height}
 * - provider=custom 且 apiKey+baseUrl 齐全 → generateImage 走自定义接口
 * - 否则走 Imagifly 代理（.env cookie）
 * - width/height 为数字，与快捷尺寸下拉（ww_img_size）双向联动
 */
const IMG_API_DEFAULTS = { provider: 'imagifly', apiKey: '', baseUrl: '', model: '', width: 1368, height: 768 };
const IMG_RATIO_PRESETS = [
  { label: '16:9 横图', w: 1368, h: 768 },
  { label: '1:1 方图', w: 1024, h: 1024 },
  { label: '9:16 竖图', w: 768, h: 1368 },
  { label: '4:3 横图', w: 1024, h: 768 },
  { label: '3:4 竖图', w: 768, h: 1024 },
];
function getImgApiConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem('ww_img_api') || '{}');
    return {
      provider: raw.provider === 'custom' ? 'custom' : 'imagifly',
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
      model: typeof raw.model === 'string' ? raw.model.trim() : '',
      width: Number.isInteger(raw.width) && raw.width >= 64 && raw.width <= 4096 ? raw.width : IMG_API_DEFAULTS.width,
      height: Number.isInteger(raw.height) && raw.height >= 64 && raw.height <= 4096 ? raw.height : IMG_API_DEFAULTS.height,
    };
  } catch {
    return { ...IMG_API_DEFAULTS };
  }
}
function saveImgApiConfig(cfg) {
  localStorage.setItem('ww_img_api', JSON.stringify(cfg));
}
/** 当前是否走自定义生图 API（配置齐全才启用，避免半配置状态打挂生成） */
function isCustomImgApi() {
  const c = getImgApiConfig();
  return c.provider === 'custom' && !!c.apiKey && !!c.baseUrl;
}
/** 自定义 API 的尺寸（面板宽高）优先；未配置时从快捷尺寸下拉解析 */
function getImageSizeForApi() {
  const c = getImgApiConfig();
  if (c.provider === 'custom' && c.width && c.height) return `${c.width}x${c.height}`;
  return getImageSize();
}

/** 面板宽高输入 ↔ 快捷尺寸下拉 双向同步 */
function syncApiSizeInputs() {
  const wEl = $('imgApiWidth'), hEl = $('imgApiHeight'), ratioSel = $('imgApiRatio');
  if (!wEl || !hEl) return;
  const cur = isCustomImgApi()
    ? getImgApiConfig()
    : (() => { const [w, h] = getImageSize().split('x').map(Number); return { width: w, height: h }; })();
  wEl.value = cur.width; hEl.value = cur.height;
  if (ratioSel) {
    const hit = IMG_RATIO_PRESETS.find((p) => p.w === cur.width && p.h === cur.height);
    ratioSel.value = hit ? hit.label : '自定义';
  }
}

/**
 * 测试连接：真实调用接口验证配置，返回 {ok, msg}
 * - imagifly：ping 代理（校验 cookie 是否已配置，零额度消耗）
 * - custom：POST 最小生图请求，按 HTTP 状态归因
 */
async function testImgApiConnection() {
  const cfg = getImgApiConfig();
  if (cfg.provider === 'imagifly') {
    try {
      const r = await fetch('/imagifly-proxy/ping');
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) return { ok: true, msg: `Imagifly 代理可用（cookie 已配置，模型 ${getImageModel()}）` };
      return { ok: false, msg: 'Imagifly 代理不可用：.env 未配置 IMAGIFLY_COOKIE，或 dev server 未重启' };
    } catch (e) {
      return { ok: false, msg: `无法连接本地代理: ${e.message}` };
    }
  }
  // custom：真实调用一次
  if (!cfg.apiKey) return { ok: false, msg: '请先填写 API Key' };
  if (!cfg.baseUrl) return { ok: false, msg: '请先填写接口地址' };
  const model = cfg.model || 'gpt-image-1';
  try {
    const r = await fetch(`/llm-proxy?target=${encodeURIComponent(cfg.baseUrl)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model, prompt: 'a red circle on white background', n: 1, size: `${cfg.width}x${cfg.height}` }),
    });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const hasImg = d.data && d.data[0] && (d.data[0].url || d.data[0].b64_json);
      return { ok: true, msg: `连接成功（模型 ${model} 已返回${hasImg ? '测试图片' : '响应'}）` };
    }
    const bodyText = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) return { ok: false, msg: `认证失败（HTTP ${r.status}）：API Key 无效或无权限` };
    if (r.status === 404) return { ok: false, msg: '接口地址错误（404）：请检查 URL 是否为完整的 …/images/generations 端点' };
    if (r.status === 429) return { ok: false, msg: '请求被限流（429）：Key 有效但额度/频率受限，配置本身可用' };
    if (r.status >= 500) return { ok: false, msg: `服务端错误（HTTP ${r.status}）：接口地址对但服务异常，可稍后重试` };
    // 4xx 其他：常见为模型名/参数不合法，透传服务端报错片段
    let detail = bodyText.slice(0, 140);
    try { detail = JSON.parse(bodyText).error?.message || detail; } catch {}
    return { ok: false, msg: `请求被拒（HTTP ${r.status}）：${detail || '请检查模型名与参数'}` };
  } catch (e) {
    return { ok: false, msg: `无法连接接口：${e.message}（检查地址是否可达、是否为 https）` };
  }
}

/**
 * 提交生图请求 → 轮询 → 返回图片 URL 数组（imageCount>1 时多张）
 * 按配置分支：自定义 OpenAI 兼容 API（llm-proxy 转发 + Bearer）/ Imagifly 代理
 */
async function generateImage(prompt) {
  if (isCustomImgApi()) return generateImageViaCustomApi(prompt);
  return generateImageViaImagifly(prompt);
}

/** 自定义 OpenAI 兼容生图接口：POST {model,prompt,n,size} → data[].url | b64_json */
async function generateImageViaCustomApi(prompt) {
  const cfg = getImgApiConfig();
  const count = getImageCount();
  const res = await fetch(`/llm-proxy?target=${encodeURIComponent(cfg.baseUrl)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      n: count,
      size: `${cfg.width}x${cfg.height}`,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    let detail = bodyText.slice(0, 160);
    try { detail = JSON.parse(bodyText).error?.message || detail; } catch {}
    if (res.status === 401 || res.status === 403) throw new Error(`生图认证失败（${res.status}）：API Key 无效或无权限`);
    throw new Error(`生图请求失败（HTTP ${res.status}）：${detail || '未知'}`);
  }
  const data = await res.json().catch(() => { throw new Error('返回体不是合法 JSON（检查接口地址是否为生图端点）'); });
  const items = Array.isArray(data.data) ? data.data : [];
  const urls = items.map((it) => it.url || (it.b64_json ? `data:image/png;base64,${it.b64_json}` : null)).filter(Boolean);
  if (urls.length === 0) throw new Error('接口返回成功但无图片（data 数组为空，检查模型名是否为生图模型）');
  return urls;
}

/** Imagifly 内置代理流程：submit → 轮询 → 全部图片 URL */
async function generateImageViaImagifly(prompt) {
  const submitRes = await fetch('/imagifly-proxy/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      model: getImageModel(), // 用户可配置，未配置回退 nano-banana-2
      size: getImageSize(),   // 用户可配置（16:9 / 1:1 / 9:16）
      imageCount: getImageCount(), // 用户可配置（1~3 张/画面）
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
    if (pollData.status === 'success') {
      // 多图：全部 URL；单图/旧代理：imageUrl
      const urls = Array.isArray(pollData.imageUrls) && pollData.imageUrls.length > 0
        ? pollData.imageUrls
        : pollData.imageUrl
          ? [pollData.imageUrl]
          : [];
      if (urls.length > 0) return urls;
      continue; // success 但没 URL（数据异常）→ 继续轮询几轮
    }
    if (pollData.status === 'failed') {
      throw new Error(`生成失败: ${pollData.error || '未知'}`);
    }
  }
  throw new Error('轮询超时（200秒）');
}

/**
 * 生成全部配图（3~5 个画面 × 每画面 1~3 张），错开 20 秒提交避免限速
 */
async function generateAllImages(prompts, config) {
  state.imgBusy = true;
  $('galleryCol').style.display = '';
  const gallery = $('col-gallery');
  gallery.innerHTML = '';

  // 为每个 prompt 的每张图创建状态对象 + 渲染 loading 卡片
  let flatIdx = 0;
  prompts.forEach((p) => {
    const count = getImageCount();
    for (let k = 0; k < count; k++) {
      const id = `img-${++imgIdCounter}`;
      const imgObj = {
        id, status: 'loading', prompt: p.prompt, caption: p.segment, url: null,
        idx: flatIdx++, subIdx: k, // subIdx：同一画面内的第几张
      };
      state.images.push(imgObj);
      renderGalleryCard(imgObj);
    }
  });

  // 错开 20s 提交（一个画面一次请求，返回 count 张图）
  const promises = prompts.map((p, i) =>
    new Promise((resolve) => setTimeout(resolve, i * 20000))
      .then(() => generateImage(p.prompt))
      .then((urls) => {
        const count = getImageCount();
        // 该画面的第 k 张 ← urls[k]（若返回张数少于预期，只填有的）
        for (let k = 0; k < count; k++) {
          const base = i * count; // 该画面在扁平序列中的起始 idx
          const img = state.images.find((x) => x.idx === base + k);
          const url = urls[k];
          if (img && url) {
            img.status = 'done';
            img.url = url;
            if (count > 1 && urls.length > 1) img.caption = `${img.caption}（${k + 1}）`;
            renderGalleryCard(img);
            // 自动落盘到本地 saved-images/（知乎等平台粘贴 dataURL 上传易失败，本地留原图最稳）
            // 外站 URL / dataURL 走通用保存端点（代理下载后落盘）；Imagifly URL 走 cookie 代理
            const saveUrl = url.startsWith('data:')
              ? `/imagifly-proxy/save-data?caption=${encodeURIComponent(img.caption || '')}`
              : `/imagifly-proxy/image?url=${encodeURIComponent(url)}&save=1&caption=${encodeURIComponent(img.caption || '')}`;
            const saveBody = url.startsWith('data:') ? url : null;
            fetch(saveUrl, saveBody ? { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: saveBody } : undefined)
              .then((r) => {
                const saved = r.headers.get('X-Saved-As');
                if (saved) {
                  img.savedAs = decodeURIComponent(saved);
                  const cap = document.querySelector(`[data-imgid="${img.id}"] .img-caption`);
                  if (cap) cap.title = `已保存: ${img.savedAs}`;
                }
              })
              .catch(() => {});
          } else if (img && !url) {
            // 服务器只返回了部分图片
            img.status = 'error';
            img.error = '本张未返回（张数不足）';
            renderGalleryCard(img);
          }
        }
      })
      .catch((err) => {
        const count = getImageCount();
        const base = i * count;
        for (let k = 0; k < count; k++) {
          const img = state.images.find((x) => x.idx === base + k);
          if (img) {
            img.status = 'error';
            img.error = err.message;
            renderGalleryCard(img);
          }
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
      getSkillPrompt(skill),
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
    // 剥离 markdown 标题行再分段：某些模型无视「不要输出标题」的指令，
    // 标题行若混入段落会干扰分段对比的对齐
    state.paragraphs[skill] = splitParagraphs(
      result.text.replace(/^#{1,6}\s+.*$/gm, '').trim()
    );
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
/** 分段配色盘：同一标准段在三列中用同色左边框，直观呈现对齐关系 */
const SECTION_COLORS = ['#2563eb', '#0d9668', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#c026d3'];

function renderColumnCards(skill) {
  const container = $('col-' + skill);
  const paras = state.paragraphs[skill];
  if (paras.length === 0) {
    container.innerHTML = '<div class="error-text">无内容</div>';
    return;
  }
  const assigns = state.compare ? state.compare.assigns[skill] : null;
  container.innerHTML = paras
    .map((p, i) => {
      const pid = `${skill}::${i}`;
      const isSel = state.selectedPicks.has(pid);
      // 有对齐数据时：卡片按所属标准段着色 + 显示段号
      const sec = assigns ? assigns[i] : null;
      const secStyle =
        sec != null && sec >= 0
          ? ` style="border-left:3px solid ${SECTION_COLORS[sec % SECTION_COLORS.length]}"`
          : ' style="border-left:3px dashed var(--border-strong)"';
      const secBadge = assigns ? (sec >= 0 ? `<span class="sec-badge" style="background:${SECTION_COLORS[sec % SECTION_COLORS.length]}">${sec + 1}</span>` : '<span class="sec-badge sec-badge-new">✦</span>') : '';
      return `<div class="para-card ${isSel ? 'selected' : ''}" data-pid="${pid}" data-pidx="${i}"${secStyle}>
        <span class="pnum">${i + 1}</span>${secBadge}
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
  if (state.generating) return; // 防并发重复点击
  const raw = $('rawInput').value.trim();
  if (!raw) { toast('请先粘贴内容'); return; }
  const config = getLLMConfig();
  if (!config.apiKey) { toast('请先填写 API Key'); return; }
  if (!config.model) { toast('请先选择模型'); return; }

  // 配图可用：imagifly cookie 已配 或 自定义生图 API 配置齐全
  const imgEnabled = (IMAGIFLY_ENABLED || isCustomImgApi()) && $('imgToggle') && $('imgToggle').checked;

  state.generating = true;
  const genBtn = $('generateBtn');
  genBtn.disabled = true;
  genBtn.textContent = '生成中…';
  try {

  state.rawText = raw;
  state.images = [];
  showResultPage();
  renderColumns(); // 按当前生效技能重建列 DOM
  getActiveSkills().forEach((s) => {
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

  const skills = getActiveSkills();

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
  const totalSkills = skills.length;

  if (imgEnabled && imgPromise) {
    $('statusText').textContent = `文字完成 · ${okCount}/${totalSkills} 成功，配图生成中…`;
    await imgPromise;
  }

  const imgOk = state.images.filter((i) => i.status === 'done').length;
  if (okCount === totalSkills) {
    $('statusText').textContent = imgEnabled
      ? `生成完成 · 文字 ${okCount}/${totalSkills} + 配图 ${imgOk}/${state.images.length}`
      : '生成完成 · 双击段落收入拼接区';
    toast(imgEnabled ? `${totalSkills} 版文字 + ${imgOk} 张配图已生成` : `${totalSkills} 版已生成`);
    // 构建分段对比（原文标准分段 + 各列映射），不阻塞主流程
    buildCompare(config);
  } else {
    $('statusText').textContent = `完成 · ${okCount} 成功，${totalSkills - okCount} 失败`;
    toast(`${totalSkills - okCount} 个技能调用失败`);
  }
  } finally {
    state.generating = false;
    genBtn.disabled = false;
    genBtn.textContent = '生成各版 →';
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
  // 同一 pid 在自由视图与对比视图各有一张卡片，选中态要同步到所有副本
  const sel = state.selectedPicks.has(pid);
  document.querySelectorAll(`.para-card[data-pid="${pid}"]`).forEach((el) => el.classList.toggle('selected', sel));
}
function pickAll(skill) {
  const paras = state.paragraphs[skill] || [];
  if (paras.length === 0) return;
  const allSel = paras.every((_, i) => state.selectedPicks.has(`${skill}::${i}`));
  paras.forEach((_, i) => {
    const pid = `${skill}::${i}`;
    if (allSel) state.selectedPicks.delete(pid);
    else state.selectedPicks.add(pid);
    document.querySelectorAll(`.para-card[data-pid="${pid}"]`).forEach((el) => el.classList.toggle('selected', !allSel));
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
      const meta = getSkillMeta(item.skill);
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

/* ===== 自动存稿（带恢复确认） ===== */
function saveStitch() {
  localStorage.setItem('ww_stitch', JSON.stringify(state.stitch));
}
/**
 * 启动时检测上次存稿。有的话不直接塞回页面，而是弹确认条：
 * 用户点「恢复」才载入；点「丢弃」清掉存稿开新稿。
 * （旧行为：无条件恢复 → 重新打开 webui 会被上次的拼接内容打个措手不及）
 */
function checkSavedStitch() {
  const raw = localStorage.getItem('ww_stitch');
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); } catch { localStorage.removeItem('ww_stitch'); return; }
  if (!Array.isArray(saved) || saved.length === 0) return;
  const bar = $('resumeBar');
  const nText = saved.filter((s) => s.type === 'text').length;
  const nImg = saved.filter((s) => s.type === 'image').length;
  $('resumeInfo').textContent = `检测到上次未完成的拼接稿（${nText} 段文字${nImg ? ` + ${nImg} 张图` : ''}）`;
  bar.style.display = 'flex';
  window.__resumeStitch = () => {
    state.stitch = saved;
    renderStitch();
    bar.style.display = 'none';
    toast('已恢复上次的拼接稿');
  };
  window.__discardStitch = () => {
    localStorage.removeItem('ww_stitch');
    state.stitch = [];
    bar.style.display = 'none';
    toast('已丢弃，开新稿');
  };
}

/* ===== 导出（多格式：富文本图文 / 纯文本 / Markdown / HTML 下载） ===== */

/** 拼接区 → 导出物料。图片统一经同源代理取回转 dataURL（内嵌后粘贴到任何平台都是真图） */
async function buildExportPayload() {
  const items = [];
  for (const s of state.stitch) {
    if (s.type === 'image') {
      let dataUrl = '';
      if (s.url) {
        try {
          const r = await fetch(`/imagifly-proxy/image?url=${encodeURIComponent(s.url)}`);
          if (r.ok) {
            const blob = await r.blob();
            dataUrl = await new Promise((resolve) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => resolve('');
              fr.readAsDataURL(blob);
            });
          }
        } catch {}
      }
      items.push({ type: 'image', caption: s.caption || '', dataUrl, src: s.url });
    } else {
      items.push({ type: 'text', text: s.text });
    }
  }
  return items;
}

/** 物料 → 三种格式的字符串 */
function payloadToPlain(items) {
  return items
    .map((it) => (it.type === 'image' ? `[图片: ${it.caption || '配图'}]` : it.text))
    .join('\n\n');
}
function payloadToMarkdown(items) {
  return items
    .map((it) => {
      if (it.type === 'image') {
        const alt = (it.caption || '配图').replace(/[[\]]/g, ' ');
        return `![${alt}](${it.src || ''})`;
      }
      return it.text;
    })
    .join('\n\n');
}
function payloadToHtml(items) {
  const body = items
    .map((it) => {
      if (it.type === 'image') {
        const cap = escapeHtml(it.caption || '');
        const src = it.dataUrl || it.src || '';
        return `<figure><img src="${src}" alt="${cap}" /><figcaption>${cap}</figcaption></figure>`;
      }
      return `<p>${escapeHtml(it.text).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>导出终稿</title>
<style>
  body { max-width: 720px; margin: 40px auto; padding: 0 20px;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 16px; line-height: 1.9; color: #1f2733; }
  p { margin: 0 0 1.2em; }
  figure { margin: 1.6em 0; text-align: center; }
  figure img { max-width: 100%; border-radius: 8px; }
  figcaption { font-size: 13px; color: #5a6678; margin-top: 8px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** 写剪贴板：文本 + 可选富文本（text/html）。富文本失败自动降级纯文本 */
async function copyWithHtml(text, html) {
  if (navigator.clipboard && window.isSecureContext && window.ClipboardItem && html) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return 'rich';
    } catch {}
  }
  // 降级：老式 execCommand
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok ? 'plain-fallback' : 'failed';
}

function openExportModal() {
  if (state.stitch.length === 0) { toast('拼接区为空，先双击段落或拖入图片'); return; }
  const modal = $('exportModal');
  const preview = $('exportPreview');
  // 预览：模拟真实导出排版（图片真实缩略、文本按段落），所见即所得
  const fs = getReadingFs();
  preview.innerHTML = state.stitch
    .map((s) =>
      s.type === 'image'
        ? `<figure class="ep-figure"><img src="${escapeHtml(s.src || '')}" alt="${escapeHtml(s.caption || '配图')}" loading="lazy" /><figcaption>${escapeHtml(s.caption || '配图')}</figcaption></figure>`
        : `<p class="ep-p">${escapeHtml(s.text.substring(0, 400))}${s.text.length > 400 ? '…' : ''}</p>`
    )
    .join('');
  preview.style.setProperty('--ep-fs', fs + 'px');
  modal.style.display = 'flex';
}
function closeExportModal() {
  $('exportModal').style.display = 'none';
}

async function doExport(kind) {
  const btns = { rich: $('exportRichBtn'), plain: $('exportPlainBtn'), md: $('exportMdBtn'), html: $('exportHtmlBtn') };
  const btn = btns[kind];
  if (!btn) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '准备中…';
  try {
    if (kind === 'html') {
      btn.textContent = '打包中…';
      const items = await buildExportPayload();
      const html = payloadToHtml(items);
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `终稿_${new Date().toISOString().slice(0, 10)}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast('HTML 已下载（图片内嵌，可直接打开/转发）');
      return;
    }
    if (kind === 'rich') {
      btn.textContent = '正在内嵌图片…';
      const items = await buildExportPayload();
      // 富文本片段：dataURL 图片 + 分段文本，粘贴到公众号/知乎/Word 图文混排
      const html = items
        .map((it) =>
          it.type === 'image'
            ? `<figure><img src="${it.dataUrl || it.src || ''}" alt="${escapeHtml(it.caption || '')}" /><figcaption>${escapeHtml(it.caption || '')}</figcaption></figure>`
            : `<p>${escapeHtml(it.text).replace(/\n/g, '<br>')}</p>`
        )
        .join('');
      btn.textContent = '复制中…';
      const res = await copyWithHtml(payloadToPlain(items), html);
      if (res === 'failed') throw new Error('复制失败');
      toast(res === 'rich' ? '已复制富文本，去公众号/Word 里 Ctrl+V 即可' : '已复制（富文本不可用，已降级纯文本）');
      return;
    }
    // plain / md
    const text = kind === 'md'
      ? payloadToMarkdown(state.stitch)
      : payloadToPlain(state.stitch);
    btn.textContent = '复制中…';
    const res = await copyWithHtml(text, null);
    if (res === 'failed') throw new Error('复制失败');
    toast(kind === 'md' ? '已复制 Markdown' : '已复制纯文本');
  } catch (err) {
    toast(`导出失败: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
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
window.exportText = openExportModal;
window.closeExportModal = closeExportModal;
window.doExport = doExport;
window.closeLightbox = closeLightbox;
window.sendImageToStitch = sendImageToStitch;
window.switchView = switchView;
window.addCompareRowToStitch = addCompareRowToStitch;
window.openImageFolder = async function () {
  try {
    const r = await fetch('/imagifly-proxy/open-folder');
    const d = await r.json();
    if (d.ok) toast('已打开 saved-images 文件夹');
    else toast('打开失败');
  } catch {
    toast('打开失败');
  }
};
window.toggleTheme = toggleTheme;
window.adjustReadingFs = adjustReadingFs;
window.openSkillForm = openSkillForm;
window.editCustomSkillForm = editCustomSkillForm;
window.submitSkillForm = submitSkillForm;
window.toggleCustomSkill = toggleCustomSkill;
window.deleteCustomSkill = deleteCustomSkill;
window.testCustomSkill = testCustomSkill;

/* ===== 初始化 ===== */
$('generateBtn').addEventListener('click', generate);
$('demoBtn').addEventListener('click', loadDemo);
$('backBtn').addEventListener('click', showInputPage);
$('saveKeyBtn').addEventListener('click', saveKey);
$('clearKeyBtn').addEventListener('click', clearKey);
$('llmProvider').addEventListener('change', updateModelOptions);

/* ===== 卡片键盘导航（结果页 ↑↓ 移动聚焦 / Space 选中 / Enter 收入） ===== */
/**
 * 自由视图下按 ↑/↓ 在「当前聚焦列」内逐卡移动（首次按键从第一列第一张开始）；
 * Space 切换选中（与点击一致，双视图副本同步）；Enter 等价双击收入拼接区。
 * 输入框/弹窗打开时不拦截；←/→ 可在列间切换。
 */
const kbNav = { focused: null };
function kbVisibleCards() {
  if (!$('page-result').classList.contains('active')) return [];
  if (state.viewMode !== 'free') return [];
  if ($('exportModal').style.display !== 'none' || $('lightbox').style.display !== 'none') return [];
  return [...document.querySelectorAll('#columnsWrap .col-skill .para-card')]
    .filter((c) => c.offsetParent !== null);
}
function kbFocusCard(card, scroll = true) {
  if (kbNav.focused === card) return;
  kbNav.focused?.classList.remove('kb-focused');
  kbNav.focused = card;
  card.classList.add('kb-focused');
  if (scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function kbMove(delta) {
  const cards = kbVisibleCards();
  if (cards.length === 0) return false;
  // 同列分组：↑/↓ 只在当前列内移动，到列首/列尾停住
  const colEl = kbNav.focused?.closest('.col-skill');
  const pool = colEl ? cards.filter((c) => c.closest('.col-skill') === colEl) : cards;
  const list = pool.length ? pool : cards;
  const idx = kbNav.focused ? list.indexOf(kbNav.focused) : -1;
  const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))] || list[delta < 0 ? 0 : list.length - 1];
  if (next) kbFocusCard(next);
  return true;
}
function kbSwitchCol(delta) {
  const cards = kbVisibleCards();
  if (cards.length === 0) return false;
  const cols = [...new Set(cards.map((c) => c.closest('.col-skill')))];
  const curCol = kbNav.focused?.closest('.col-skill') || cols[0];
  const ci = cols.indexOf(curCol);
  const target = cols[Math.min(cols.length - 1, Math.max(0, ci + delta))] || curCol;
  const first = cards.find((c) => c.closest('.col-skill') === target);
  if (first) kbFocusCard(first);
  return true;
}
document.addEventListener('keydown', (e) => {
  // 输入控件内不拦截（编辑卡片 textarea 等）
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'input' || tag === 'select' || e.target.isContentEditable) return;
  if (e.key === 'ArrowDown') { if (kbMove(1)) e.preventDefault(); return; }
  if (e.key === 'ArrowUp') { if (kbMove(-1)) e.preventDefault(); return; }
  if (e.key === 'ArrowRight') { if (kbSwitchCol(1)) e.preventDefault(); return; }
  if (e.key === 'ArrowLeft') { if (kbSwitchCol(-1)) e.preventDefault(); return; }
  if ((e.key === ' ' || e.code === 'Space') && kbNav.focused) {
    e.preventDefault();
    togglePick(kbNav.focused.dataset.pid);
    return;
  }
  if (e.key === 'Enter' && kbNav.focused) {
    e.preventDefault();
    sendToStitch(kbNav.focused.dataset.pid);
  }
});

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
checkSavedStitch();

// 技能管理面板：初始渲染 + 折叠交互 + 面板计数
renderSkillManager();
(function initSkillManagerPanel() {
  const head = $('skillManagerHead');
  const body = $('skillManagerBody');
  const caret = $('skillManagerCaret');
  if (!head || !body) return;
  const collapsed = localStorage.getItem('ww_skill_panel_collapsed') === '1';
  body.style.display = collapsed ? 'none' : '';
  if (caret) caret.textContent = collapsed ? '▸' : '▾';
  head.addEventListener('click', () => {
    const nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    if (caret) caret.textContent = nowCollapsed ? '▸' : '▾';
    localStorage.setItem('ww_skill_panel_collapsed', nowCollapsed ? '1' : '0');
  });
  const updCount = () => {
    const el = $('skillCount');
    if (el) {
      const n = getActiveSkills().length;
      const total = BUILTIN_SKILLS.length + state.customSkills.length;
      el.textContent = n === total ? `${n} 个技能` : `${n}/${total} 启用`;
    }
  };
  updCount();
  // 增删改启停后刷新计数：简单做法——钩在 renderSkillManager 尾部
  const orig = renderSkillManager;
  renderSkillManager = function () {
    orig();
    updCount();
  };
})();

// 配图开关：imagifly cookie 已配置 或 用户配了自定义生图 API 时显示
const imgApiReady = isCustomImgApi();
if ((IMAGIFLY_ENABLED || imgApiReady) && $('imgToggleRow')) {
  $('imgToggleRow').style.display = '';
  initImageModelSelect(); // 生图模型选择器与开关同显示
  initImageExtraSelects(); // 尺寸/张数
}
// 生图 API 配置面板：始终可用（自定义 API 不依赖 imagifly cookie）
initImgApiPanel();
// ③ 进阶设置折叠面板
(function initAdvancedPanel() {
  const head = $('advancedHead'), body = $('advancedBody'), caret = $('advancedCaret');
  if (!head || !body) return;
  const collapsed = localStorage.getItem('ww_advanced_collapsed');
  // 默认折叠：仅当用户显式展开过才展开
  const open = collapsed === '0';
  body.style.display = open ? '' : 'none';
  if (caret) caret.textContent = open ? '▾' : '▸';
  head.addEventListener('click', () => {
    const nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    if (caret) caret.textContent = nowCollapsed ? '▸' : '▾';
    localStorage.setItem('ww_advanced_collapsed', nowCollapsed ? '1' : '0');
  });
})();
// 步骤条：滚动高亮当前可见区块
(function initStepDots() {
  const page = $('page-input');
  const dots = [$('stepDot1'), $('stepDot2'), $('stepDot3')];
  if (!page || dots.some((d) => !d)) return;
  const sections = () => [
    $('llmConfig'),
    document.querySelector('.panel:not(#llmConfig) .panel-head')?.closest('.panel'),
    $('advancedHead')?.closest('.panel'),
  ].filter(Boolean);
  const update = () => {
    const viewMid = page.scrollTop + page.clientHeight * 0.4;
    const secs = sections();
    let active = 0;
    secs.forEach((sec, i) => { if (sec.offsetTop <= viewMid) active = i; });
    dots.forEach((d, i) => d.classList.toggle('active', i === active));
  };
  page.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
})();
// 用户保存自定义 API 后，若开关行还藏着（无 cookie 场景），保存时点亮它
(function watchImgApiForToggle() {
  const orig = saveImgApiFromForm;
  saveImgApiFromForm = function (silent) {
    const ok = orig(silent);
    if (ok && $('imgToggleRow') && $('imgToggleRow').style.display === 'none') {
      $('imgToggleRow').style.display = '';
      initImageModelSelect();
      initImageExtraSelects();
    }
    return ok;
  };
})();
