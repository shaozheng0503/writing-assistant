# 写作辅助工作台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Tech: Vite](https://img.shields.io/badge/Tech-Vite-646CFF.svg)](https://vitejs.dev)
[![Models: 13](https://img.shields.io/badge/LLM-%E5%85%B1%E7%BB%A9%E7%AE%97%E5%8A%9B%2013%E6%A8%A1%E5%9E%8B-blue)](https://console.suanli.cn/models)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/shaozheng0503/writing-assistant/pulls)

> 三技能对比 + 手动拼接 + 自动配图，去除 AI 味，写出像人写的文字。

一个写作辅助工具。粘贴你的原始内容（AI 生成的初稿、草稿、提纲等），三个「去 AI 味」技能各出一版并排展示，你从三列结果中挑选最好的段落，手动拼装成最终属于自己的正文。生成文字的同时，还能自动从原文分段提取画面描述，调用 Imagifly 生成 3~5 张配图，拖拽到拼接区与文字交错混排。

## 三个技能

| 技能 | 作者 | 方向 | GitHub |
|------|------|------|--------|
| human-writing | 卡兹克 | 活人感写作 | [KKKKhazix/human-writing](https://github.com/KKKKhazix/human-writing) |
| humanizer-zh | 归藏 | 去 AI 味 | [op7418/Humanizer-zh](https://github.com/op7418/Humanizer-zh) |
| ljg-plain | 李继刚 | 说人话 | [lijigang/ljg-skills](https://github.com/lijigang/ljg-skills) |

三个技能的 SKILL.md 原文见 [`/skills`](./skills) 目录，作为 LLM 的 system prompt 让模型按各自规则真实改写你的文本。

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。

### 配置 API Key

项目默认使用共绩算力 MaaS 平台（13 个模型，完全 OpenAI 兼容）。复制 `.env.example` 为 `.env`，填入你的 Key：

```bash
cp .env.example .env
# 编辑 .env
# VITE_SUANLI_API_KEY=你的key  ← 在 console.suanli.cn/models 获取
# IMAGIFLY_COOKIE=imagifly_session=xxx; ...  ← 可选，开启配图功能
```

配置后用户打开页面即可直接生成，无需手动输入。不配置也不影响使用，用户可在页面上手动填写。

### 开启自动配图（可选）

在 `.env` 中填入 Imagifly Cookie 即可开启自动配图：

```
IMAGIFLY_COOKIE=imagifly_session=xxx; _ga=xxx; ...
```

获取方式：打开 [imagifly.net](https://imagifly.net) 登录后，从浏览器 DevTools → Application → Cookies 复制全部 cookie。Cookie 只存在服务端 `.env` 中，不暴露给前端。

配置后，每次生成文字时会同时从全文分段提取 3~5 个画面描述，调用 Imagifly 生成配图。不配置则仅生成文字。

## 支持的 LLM

- **共绩算力 MaaS**（默认，13 个模型：DeepSeek / Minimax / Kimi / Qwen / GLM / 混元）— [console.suanli.cn/models](https://console.suanli.cn/models)
- OpenAI（GPT-4o / GPT-4o-mini / GPT-4 Turbo / GPT-3.5）
- DeepSeek（deepseek-chat / deepseek-reasoner）
- OpenRouter（Claude / Gemini / Llama 等）
- 任意 OpenAI 兼容 API（自定义 Base URL）

API Key 仅存在本地 localStorage，不会上传。

## 共绩算力全模型适配

项目对共绩算力 MaaS 的全部 13 个模型做了实测适配。不同模型在流式响应中 `content` 和 `reasoning_content` 字段的行为不同，分为三种类型：

| 类型 | 模型 | content | reasoning_content | 处理方式 |
|------|------|---------|-------------------|----------|
| normal | deepseek-v4-flash | 有 | 无 | 直接取 content 渲染 |
| reasoning | deepseek-v4-pro, glm-5 | 有 | 有（思考链） | reasoning→折叠面板, content→正文 |
| reasoning_only | flash-0731, glm-5.1, glm-5.2 | 无 | 有（即正文） | reasoning_content 直接当正文渲染 |

- 下拉框中推理模型标注「· 思考链」或「· 推理」标记
- 推理模型的思考过程用折叠面板展示在正文上方，思考阶段自动展开，正文开始后自动收起，点击可切换
- 未知模型默认 normal 类型（安全降级）
- 模型适配表在 `src/skills.js` 的 `MODEL_TRAITS` 中维护，可自行扩展

## 功能

### 文字生成

- 首页选 LLM Provider + 填 API Key + 粘贴原文
- 三个 SKILL.md 作为 system prompt，并行调用 LLM 改写
- 三列同时流式输出，逐字打出
- 推理模型（GLM-5/5.1/5.2, DeepSeek-V4-Pro 等）的思考过程用折叠面板展示
- 完成后按空行拆成段落卡片，每段有编号、复制按钮
- 单击段落选中，双击段落收入拼接区，「加入拼接区」按钮批量收入
- 每列可单独重新生成（↻ 按钮）

### 自动配图

- 用 LLM 从全文分段提取 3~5 个画面描述（含中文摘要 + 英文生图 prompt）
- 调用 Imagifly API 生成图片，错开 20 秒提交避免限速
- 配图库独立展示（最左侧列），每张图带序号 + 源段落摘要
- 统一 4:3 画幅，统一圆角卡片风格

### 图片交互

- 从配图库拖拽图片到拼接区任意位置（与文字卡片交错混排）
- 拼接区内图片可拖拽排序
- 点击任意图片 → 全屏 lightbox 预览（Esc 关闭）

### 拼接区

- 文字 + 图片混合排版
- 拖拽排序（文字和图片均可拖拽）
- 文字段落可编辑
- 删除、清空
- 导出（文字 + `[图片: 摘要]` 标记，复制到剪贴板或下载 txt）
- 自动存稿（localStorage），刷新不丢

### 其他

- 快捷键：Ctrl+Enter 生成，Esc 返回 / 关闭 lightbox
- 暗色主题
- 预填 API Key（.env 配置后用户打开即用）
- 五列布局：配图库 / human-writing / humanizer-zh / ljg-plain / 拼接区

## 项目结构

```
writing-workbench/
├── src/
│   ├── index.html      # 页面结构（输入页 + 结果页 + lightbox）
│   ├── styles.css      # 样式（dark 主题 + 配图库 + 思考面板 + lightbox）
│   ├── main.js         # 核心逻辑（LLM 调用、流式输出、配图、拼接、导出）
│   └── skills.js       # 技能元数据 + LLM Provider 配置 + 模型适配表
├── skills/
│   ├── README.md       # 三个 Skill 来源链接
│   ├── human-writing/
│   │   └── SKILL.md    # 卡兹克 human-writing 原文（system prompt）
│   ├── humanizer-zh/
│   │   └── SKILL.md    # 归藏 humanizer-zh 原文（system prompt）
│   └── ljg-plain/
│       └── SKILL.md    # 李继刚 ljg-plain 原文（system prompt）
├── .env.example        # 环境变量模板（API Key + Imagifly Cookie）
├── .env                # 本地环境变量（gitignore，不提交）
├── .gitignore
├── vite.config.js      # Vite 配置 + LLM/Imagifly CORS 代理插件 + env 注入
├── package.json
└── README.md
```

## 工作原理

### CORS 代理

浏览器直接调 LLM API 和 Imagifly API 会被 CORS 拦截。Vite dev server 提供两个代理中间件：

- `/llm-proxy?target=URL` — 转发 LLM API 请求，流式回传 SSE
- `/imagifly-proxy/submit|poll|image` — 转发 Imagifly 生图 API，cookie 注入在服务端

### 文字生成流程

1. 前端读取三个 SKILL.md 文件（通过 Vite `?raw` import）
2. 每个 SKILL.md 作为 system prompt，用户原文作为 user message，并行调用 LLM
3. LLM 返回流式 SSE 响应，前端根据模型类型分别处理 `content` 和 `reasoning_content`
4. 正文逐字渲染到对应列，思考过程渲染到折叠面板
5. 完成后按空行拆成段落卡片

### 配图生成流程

1. 用 LLM 从全文一次性提取 3~5 个分段画面描述（JSON 数组，含中文摘要 + 英文 prompt）
2. 错开 20 秒提交给 Imagifly API（避免限速）
3. 轮询生成状态（每 5 秒，最多 40 次 = 200 秒超时）
4. 成功后通过代理下载并显示在配图库

### 健壮性

- 180 秒超时 + 2 次自动重试（推理模型思考时间长）
- 5xx / 网络错误重试，4xx 不重试
- Content-Type 检测：非 `text/event-stream` 时解析 JSON 错误信息
- GLM 系列思考链适配（三种模型类型分流处理）
- 非安全上下文剪贴板兜底（textarea + execCommand）
- 拼接区容器拖拽监听器去重（防止重复插入）

## 共绩算力 MaaS 接入说明

项目默认使用共绩算力 MaaS 平台（[api.suanli.cn](https://api.suanli.cn/v1)），完全兼容 OpenAI 接口规范。

- API Base URL: `https://api.suanli.cn/v1/chat/completions`
- 认证: `Authorization: Bearer <API_KEY>`
- 获取 Key: [console.suanli.cn/models](https://console.suanli.cn/models)
- 可用模型: DeepSeek-V4-Flash/Pro、Minimax-M2.5/M2.7、Kimi-K2.6、Qwen3.6/3.7、GLM-5/5.1/5.2、混元3-preview

### 模型适配表

在 `src/skills.js` 的 `MODEL_TRAITS` 中维护，可自行扩展：

```js
export const MODEL_TRAITS = {
  'deepseek/deepseek-v4-flash': 'normal',
  'deepseek/deepseek-v4-flash-0731': 'reasoning_only',
  'deepseek/deepseek-v4-pro': 'reasoning',
  'z-ai/glm-5': 'reasoning',
  'z-ai/glm-5.1': 'reasoning_only',
  'z-ai/glm-5.2': 'reasoning_only',
};
```

- `normal`: 只输出 content（普通模型）
- `reasoning`: 先输出 reasoning_content（思考链），后输出 content（正文）
- `reasoning_only`: 只有 reasoning_content，content 为空（正文放在 reasoning 里）

未知模型默认为 `normal`（安全降级）。

## 技术栈

- Vite（开发服务器 + CORS 代理 + 构建）
- 纯原生 JS / HTML / CSS，零框架依赖

## License

MIT

## 致谢

- [human-writing](https://github.com/KKKKhazix/human-writing) by 卡兹克
- [humanizer-zh](https://github.com/op7418/Humanizer-zh) by 归藏
- [ljg-skills](https://github.com/lijigang/ljg-skills) by 李继刚
- [共绩算力 MaaS](https://suanli.cn) — LLM 推理服务
- [Imagifly](https://imagifly.net) — AI 图片生成
