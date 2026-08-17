/**
 * skills.js — 三技能定义 + SKILL.md 全文
 *
 * 生成时把 SKILL.md 作为 system prompt 发给 LLM，
 * 让 LLM 按每个 Skill 的规则改写用户输入。
 */

/** 示例输入文本 */
export const DEMO_TEXT = `人工智能正在改变我们的工作方式。此外，它不仅仅是一种工具，而是代表着一种全新的生产力范式。值得注意的是，AI的崛起不仅仅是技术层面的进步，更在于它深刻地重塑了人类与信息的关系。

从某种程度上说，这种变革标志着人类社会进入了一个关键转折点。专家认为，未来五年内，AI将对各行各业产生不可磨灭的影响。尽管面临诸多挑战，但前景依然光明。

更重要的是，我们需要认识到，AI不是要取代人类，而是增强人类的能力。这不是一场零和游戏，而是一次协作共赢的机会。通过人机协作，我们可以实现效率的显著提升，为创新奠定坚实基础。`;

/** 三技能元数据 */
export const SKILL_META = {
  'human-writing': {
    label: 'human-writing',
    author: '卡兹克',
    desc: '活人感写作',
    color: '#378add',
    github: 'https://github.com/KKKKhazix/human-writing',
  },
  'humanizer-zh': {
    label: 'humanizer-zh',
    author: '归藏',
    desc: '去 AI 味',
    color: '#5dcaa5',
    github: 'https://github.com/op7418/Humanizer-zh',
  },
  'ljg-plain': {
    label: 'ljg-plain',
    author: '李继刚',
    desc: '说人话',
    color: '#ef9f27',
    github: 'https://github.com/lijigang/ljg-skills',
  },
};

/**
 * 三技能的 SKILL.md 全文，作为 LLM 的 system prompt。
 * 用 Vite 的 ?raw 后缀在 main.js 里 import，
 * 所以这里只导出文件路径映射。
 */
export const SKILL_FILES = {
  'human-writing': '/skills/human-writing/SKILL.md',
  'humanizer-zh': '/skills/humanizer-zh/SKILL.md',
  'ljg-plain': '/skills/ljg-plain/SKILL.md',
};

/** LLM Provider 配置 */
export const LLM_PROVIDERS = {
  suanli: {
    label: '共绩算力 MaaS',
    models: [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash-0731',
      'deepseek/deepseek-v4-pro',
      'minimax/minimax-m2.5',
      'minimax/minimax-m2.7',
      'minimax/minimax-m2.7-highspeed',
      'moonshotai/kimi-k2.6',
      'qwen/qwen3.6-flash',
      'qwen/qwen3.7-max',
      'tencent/hy3-preview',
      'z-ai/glm-5',
      'z-ai/glm-5.1',
      'z-ai/glm-5.2',
    ],
    baseUrl: 'https://api.suanli.cn/v1/chat/completions',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    baseUrl: 'https://api.openai.com/v1/chat/completions',
  },
  deepseek: {
    label: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  },
  openrouter: {
    label: 'OpenRouter',
    models: ['anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash', 'meta-llama/llama-3.3-70b-instruct'],
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  },
  custom: {
    label: '自定义 (OpenAI 兼容)',
    models: [],
    baseUrl: '',
  },
};

/**
 * 模型特性表 — 决定如何处理流式响应中的 content / reasoning_content
 *
 * 三种类型：
 * - 'normal':      只输出 content（普通模型）
 * - 'reasoning':   先输出 reasoning_content（思考），后输出 content（正文）
 * - 'reasoning_only': 只有 reasoning_content，没有 content（正文放在 reasoning 里）
 *
 * 未知模型默认为 'normal'（安全降级）
 */
export const MODEL_TRAITS = {
  // deepseek 系列
  'deepseek/deepseek-v4-flash': 'normal',
  'deepseek/deepseek-v4-flash-0731': 'reasoning',
  'deepseek/deepseek-v4-pro': 'reasoning',
  // z-ai glm 系列
  'z-ai/glm-5': 'reasoning',
  'z-ai/glm-5.1': 'reasoning_only',
  'z-ai/glm-5.2': 'reasoning_only',
};

/**
 * 获取模型特性
 */
export function getModelTrait(model) {
  return MODEL_TRAITS[model] || 'normal';
}

/**
 * 获取模型显示标签（下拉框中展示）
 */
export function getModelLabel(model) {
  const trait = MODEL_TRAITS[model];
  if (trait === 'reasoning') return `${model} · 思考链`;
  if (trait === 'reasoning_only') return `${model} · 推理`;
  return model;
}

/**
 * 预填 API Key（可选）。
 * 来源：Vite 环境变量 VITE_SUANLI_API_KEY（在 .env 文件中配置）。
 * 这样开源部署者可以在 .env 填自己的 key，用户打开即用，无需手动输入。
 * 如果未配置则为空字符串，不影响手动填入。
 * 注意：必须用 import.meta.env.VITE_XXX 直接引用，Vite 才会做静态替换。
 */
const _envKey = import.meta.env.VITE_SUANLI_API_KEY;
export const PREFILLED_KEY = typeof _envKey === 'string' ? _envKey : '';
