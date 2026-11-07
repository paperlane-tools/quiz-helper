// ==UserScript==
// @name         易智教云课堂 · 自动作答助手
// @namespace    yzj-js
// @version      1.6.2
// @description  在已登录的 csgmooc 页面上，一键把整套题交给 AI 判题并自动填入答案（单选/多选/判断/填空/连线，支持多家 AI 服务商、自动检测可用模型、自动交卷与跳过规则）
// @author       yzj-js
// @match        https://www.csgmooc.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.deepseek.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

const YZJ_VERSION = "1.6.2";

  // ------------------------------------------------ v1.4.0：题型与跳过规则
  /** 站点题型编号（取自站点自己的模板与 stud_add_test.min.js） */
  const Q_TYPE = { SINGLE: 0, MULTI: 1, JUDGE: 2, BLANK: 3, SUBJECTIVE: 4, CODE: 5, LINE: 6, SORT: 7 };
  const Q_TYPE_NAME = { 0: "单选", 1: "多选", 2: "判断", 3: "填空", 4: "主观/问答", 5: "视听/代码", 6: "连线", 7: "排序" };
  /**
   * 支持作答的题型；其余一律整套跳过（不调 AI、不写、不交）。
   * v1.4.3 加连线(6)：站点口径是「左序号+右字母」用 # 连接，如 1A#2B#3C。
   */
  const SUPPORTED_Q_TYPES = [Q_TYPE.SINGLE, Q_TYPE.MULTI, Q_TYPE.JUDGE, Q_TYPE.BLANK, Q_TYPE.LINE];
  /** 作业/练习那套接口支持作答的题型（v1.4.1 加主观题：正文走 subResult） */
  const HOMEWORK_Q_TYPES = SUPPORTED_Q_TYPES.concat([Q_TYPE.SUBJECTIVE]);
  /** 填空答案分隔符（站点自己的口径，见 stud_add_test.min.js 的 .completions 拼接） */
  const BLANK_SEP = "#CSG#";

  /**
   * 默认跳过规则（v1）：主要拦截老师布置的开放题/上传题，避免 AI 瞎答。
   * 一行一条；默认按关键词子串匹配（忽略大小写与空白）；写成 /正则/ 时按正则匹配。
   */
  const SKIP_RULES_VERSION = 1;
  const DEFAULT_SKIP_RULES = [
    "你学会了",
    "学会了什么",
    "学到了什么",
    "有什么收获",
    "心得体会",
    "感想",
    "谈谈你",
    "自评",
    "自我评价",
    "拍照上传",
    "截图上传",
    "上传截图",
    "请上传",
    "上传作业",
    "上传视频",
    "上传音频",
  ];

  // ------------------------------------------------------------------ 配置
  // ------------------------------------------------------------ AI 服务商（v1.6.0）
  /**
   * 脚本只认三套「说话方式」（proto），市面上的服务商基本都能归到其中一套：
   *   openai    —— 绝大多数国产站、聚合站、自建网关都是它（/chat/completions）
   *   anthropic —— Claude 官方原生（/messages）
   *   gemini    —— Google 官方原生（/models/{model}:generateContent）
   * proto 决定：接口路径、鉴权头、请求体长什么样、模型列表怎么拉、回复从哪读。
   */
  const AI_PROTOCOLS = ["openai", "anthropic", "gemini"];
  const PROTO_LABEL = { openai: "OpenAI 兼容", anthropic: "Anthropic Claude", gemini: "Google Gemini" };

  /**
   * 预置服务商。base 是「base_url」——一律不要带 /chat/completions 或 /messages。
   * models 只是**起手用的常见型号**，真正权威的是「检测模型」拉回来的那份列表。
   * vision 是「确定能看图」的型号前缀，用来提示图片版试卷该用哪个。
   */
  const AI_PROVIDERS = [
    { id: "deepseek", name: "DeepSeek", proto: "openai",
      base: "https://api.deepseek.com",
      models: ["deepseek-flash", "deepseek-v4-pro"],
      vision: ["deepseek-flash"],
      keyUrl: "https://platform.deepseek.com/api_keys",
      note: "老默认，什么都不用改就能用。deepseek-flash 快、便宜、能看图（图片版试卷用它）；deepseek-v4-pro 更聪明但更贵。" },
    { id: "openai", name: "OpenAI", proto: "openai",
      base: "https://api.openai.com/v1",
      models: ["gpt-5.2", "gpt-5.2-mini", "gpt-4.1-mini"],
      vision: ["gpt-5.2", "gpt-5.2-mini", "gpt-4.1-mini"],
      keyUrl: "https://platform.openai.com/api-keys" },
    { id: "anthropic", name: "Anthropic Claude", proto: "anthropic",
      base: "https://api.anthropic.com/v1",
      models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      vision: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      keyUrl: "https://console.anthropic.com/settings/keys",
      note: "浏览器直连需要 anthropic-dangerous-direct-browser-access，脚本已经带上了。" },
    { id: "gemini", name: "Google Gemini", proto: "gemini",
      base: "https://generativelanguage.googleapis.com/v1beta",
      models: ["gemini-3-pro", "gemini-3-flash"],
      vision: ["gemini-3-pro", "gemini-3-flash"],
      keyUrl: "https://aistudio.google.com/apikey" },
    { id: "moonshot", name: "月之暗面 Kimi", proto: "openai",
      base: "https://api.moonshot.cn/v1",
      models: ["kimi-k2-turbo-preview", "moonshot-v1-8k-vision-preview"],
      vision: ["moonshot-v1-8k-vision-preview"],
      keyUrl: "https://platform.moonshot.cn/console/api-keys" },
    { id: "zhipu", name: "智谱 GLM", proto: "openai",
      base: "https://open.bigmodel.cn/api/paas/v4",
      models: ["glm-4.6", "glm-4.6v"],
      vision: ["glm-4.6v", "glm-4v"],
      keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
      note: "文字用 glm-4.6，图片版试卷把「图片模型」填成 glm-4.6v。" },
    { id: "dashscope", name: "阿里百炼 · 通义千问", proto: "openai",
      base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen3-max", "qwen3-vl-plus"],
      vision: ["qwen3-vl-plus", "qwen-vl"],
      keyUrl: "https://bailian.console.aliyun.com/" },
    { id: "volcengine", name: "火山方舟 · 豆包", proto: "openai",
      base: "https://ark.cn-beijing.volces.com/api/v3",
      models: [],
      keyUrl: "https://console.volcengine.com/ark",
      note: "模型名要填你在方舟建的「接入点 ID」(ep-xxxxx) 或模型 ID，点「检测模型」能直接列出来。" },
    { id: "siliconflow", name: "硅基流动", proto: "openai",
      base: "https://api.siliconflow.cn/v1",
      models: ["Qwen/Qwen3-VL-32B-Instruct"],
      vision: ["Qwen/Qwen3-VL-32B-Instruct"],
      keyUrl: "https://cloud.siliconflow.cn/account/ak",
      note: "模型名带 org/ 前缀，照抄检测出来的字符串就行。" },
    { id: "openrouter", name: "OpenRouter（一家通吃）", proto: "openai",
      base: "https://openrouter.ai/api/v1",
      models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-3-flash"],
      vision: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-3-flash"],
      keyUrl: "https://openrouter.ai/settings/keys",
      note: "一个 key 就能调各家模型；「检测模型」还会读出卖家标的模态，直接标出能不能看图。" },
    { id: "ollama", name: "本机 Ollama / LM Studio", proto: "openai",
      base: "http://127.0.0.1:11434/v1",
      models: [], noKey: true,
      note: "本地跑不需要 Key，留空即可。base 按你的实际端口改（LM Studio 一般是 :1234/v1）。" },
    { id: "custom", name: "自定义（OpenAI 兼容）", proto: "openai",
      base: "", models: [],
      note: "填任意 OpenAI 兼容站的 base_url，不要带 /chat/completions。" },
  ];

  function providerById(id) {
    return AI_PROVIDERS.find((p) => p.id === id) || null;
  }

  /** 当前服务商的中文名，只用于写日志 */
  function providerName() { return (providerById(CFG.provider) || {}).name || CFG.provider || "AI"; }

  /** 没显式选过服务商时，靠 base_url 里的域名猜一家出来（老版本用户升级上来能自动认领） */
  function guessProviderId(base) {
    const b = String(base || "").toLowerCase();
    if (!b) return "deepseek";
    const HOSTS = [["deepseek", "deepseek"], ["openai.com", "openai"], ["anthropic|claude", "anthropic"],
                   ["generativelanguage|gemini", "gemini"], ["moonshot", "moonshot"],
                   ["bigmodel|zhipu", "zhipu"], ["dashscope|aliyun", "dashscope"],
                   ["volces|volcengine", "volcengine"], ["siliconflow", "siliconflow"],
                   ["openrouter", "openrouter"], ["127\\.0\\.0\\.1|localhost", "ollama"]];
    for (const [re, id] of HOSTS) if (new RegExp(re).test(b)) return id;
    return "custom";
  }

  const CFG = {
    get baseUrl() { return GM_getValue("baseUrl", "https://api.deepseek.com"); },
    get apiKey() { return GM_getValue("apiKey", ""); },
    get model() { return GM_getValue("model", "deepseek-flash"); },
    // —— v1.6.0：多服务商 ——
    /** 当前服务商 id；没显式设过就按 baseUrl 猜（老用户升级上来自动认领） */
    get provider() { return GM_getValue("provider", "") || guessProviderId(GM_getValue("baseUrl", "")); },
    /** 说话方式；没设过就跟随服务商默认 */
    get proto() {
      const saved = String(GM_getValue("proto", "") || "");
      if (AI_PROTOCOLS.includes(saved)) return saved;
      const p = providerById(CFG.provider);
      return (p && p.proto) || "openai";
    },
    /** 图片专用模型：留空 = 和 model 用同一个（v1.6.0） */
    get modelVision() { return String(GM_getValue("modelVision", "") || "").trim(); },
    get autoFinalize() { return GM_getValue("autoFinalize", false); },
    get confirmBeforeFinalize() { return GM_getValue("confirmBeforeFinalize", true); },
    get readScoreAfterFinalize() { return GM_getValue("readScoreAfterFinalize", true); },
    get showTokens() { return GM_getValue("showTokens", true); },
    get lowConfidence() { return Number(GM_getValue("lowConfidence", 0.7)); },
    get timeoutSec() { return Number(GM_getValue("timeoutSec", 90)); },
    get unattended() { return GM_getValue("unattended", false); },
    get uaFinalize() { return GM_getValue("uaFinalize", true); },
    get uaSkipAnswered() { return GM_getValue("uaSkipAnswered", true); },
    get uaRetry() { return Number(GM_getValue("uaRetry", 2)); },
    get uaMaxTasks() { return Number(GM_getValue("uaMaxTasks", 20)); },
    get silent() { return GM_getValue("silent", true); },
    get lowConfStrict() { return GM_getValue("lowConfStrict", false); },
    get uaOnly() { return String(GM_getValue("uaOnly", "") || "").trim(); },
    // —— 判题分批（S1）——
    get batchSize() { return Math.max(1, Number(GM_getValue("batchSize", 10))); },
    get noReason() { return GM_getValue("noReason", false); },
    get useBank() { return GM_getValue("useBank", true); },
    get bankLearn() { return GM_getValue("bankLearn", true); },
    // —— 延迟提交（避免"一口气全交卷"太扎眼）——
    get delayEnabled() { return GM_getValue("delayEnabled", true); },
    get delayPerQuestion() { return GM_getValue("delayPerQuestion", true); },
    get delayQuestionMin() { return Number(GM_getValue("delayQuestionMin", 4)); },
    get delayQuestionMax() { return Number(GM_getValue("delayQuestionMax", 12)); },
    get delaySubmitMin() { return Number(GM_getValue("delaySubmitMin", 2)); },
    get delaySubmitMax() { return Number(GM_getValue("delaySubmitMax", 6)); },
    get delayBetweenMin() { return Number(GM_getValue("delayBetweenMin", 3)); },
    get delayBetweenMax() { return Number(GM_getValue("delayBetweenMax", 12)); },
    // —— v1.4.0：跳过规则（默认预置，可编辑、可更新）——
    get skipEnabled() { return GM_getValue("skipEnabled", true); },
    get skipRules() { return ensureSkipRules(); },
    get skipRulesVersion() { return Number(GM_getValue("skipRulesVersion", 0)) || 0; },
    // —— v1.4.0：答题预算（阶梯升档）——
    get maxTokensCap() { return Math.max(2000, Number(GM_getValue("maxTokensCap", 16000)) || 16000); },
    get reasoningEffort() { return String(GM_getValue("reasoningEffort", "high") || "high"); },
    get apiCourse() { return "https://www.csgmooc.com/uni-gateway/jxapi2/"; },
  };

  /** 配置齐了没：填了 Key，或者这家本来就不用 Key（本机 Ollama / LM Studio） */
  function aiReady() { return !!CFG.apiKey || !!((providerById(CFG.provider) || {}).noKey); }

  // ------------------------------------------------------ 跳过规则（v1.4.0）
  /** 首次使用时把默认规则写进存储；之后完全以用户编辑的为准 */
  function ensureSkipRules() {
    let list = GM_getValue("skipRules", null);
    if (!Array.isArray(list)) {
      list = DEFAULT_SKIP_RULES.slice();
      GM_setValue("skipRules", list);
      GM_setValue("skipRulesVersion", SKIP_RULES_VERSION);
    }
    return list;
  }

  function saveSkipRules(list) { GM_setValue("skipRules", (list || []).slice()); }
  function saveSkipRulesVersion(v) { GM_setValue("skipRulesVersion", Number(v) || 0); }

  /** 多行文本 <-> 规则数组 */
  function rulesToText(list) { return (list || []).join("\n"); }
  function parseRuleLines(text) {
    return String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }

  /** 有新版默认规则时，只把用户没有的条目追加进去（不删用户自己写的）；返回新增条数 */
  function mergeDefaultSkipRules() {
    const list = ensureSkipRules();
    const have = new Set(list);
    let added = 0;
    DEFAULT_SKIP_RULES.forEach((r) => { if (!have.has(r)) { list.push(r); have.add(r); added += 1; } });
    saveSkipRules(list);
    saveSkipRulesVersion(SKIP_RULES_VERSION);
    return added;
  }

  /** 规则命中判断：一行一条，默认按关键词（忽略大小写与空白），/正则/ 按正则 */
  function matchSkipRule(text) {
    if (!CFG.skipEnabled) return "";
    const t = String(text || "");
    if (!t) return "";
    const flat = t.replace(/\s+/g, "").toLowerCase();
    for (const raw of CFG.skipRules) {
      const rule = String(raw || "").trim();
      if (!rule) continue;
      if (rule.length > 2 && rule.startsWith("/") && rule.endsWith("/")) {
        let re = null;
        try { re = new RegExp(rule.slice(1, -1), "i"); } catch { re = null; }
        if (re) { if (re.test(t)) return rule; continue; }
      }
      if (flat.includes(rule.replace(/\s+/g, "").toLowerCase())) return rule;
    }
    return "";
  }

  // ------------------------------------------------------------------ 小工具
  // -------------------------------------------- DES（v1.4.1：主观题/作业提交要用）
  // 站点提交作业正文时是 CryptoJS.DES.encrypt(内容, Utf8.parse("csg_spoc"), {mode:ECB, padding:Pkcs7})，
  // 这里自带一份最小实现（ECB + PKCS7 + base64），不依赖页面有没有加载 crypto-js。
  // 口径已用站点自己的 crypto-js 对拍过 5 组（中文 / 长文本 / HTML / 空串 / 单字符）。
  const DES = (() => {
    const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,
                 63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
    const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
                 41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
    const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
                57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
    const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
                36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
    const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,
               24,25,26,27,28,29,28,29,30,31,32,1];
    const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
    const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
    const SBOX = [
      [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,
       4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
      [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,
       0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
      [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,
       13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
      [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,
       10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
      [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,
       4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
      [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,
       9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
      [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,
       1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
      [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,
       7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
    ];
    const permute = (bits, table) => table.map((p) => bits[p - 1]);
    const bitsOf = (buf) => {
      const out = new Array(buf.length * 8);
      for (let i = 0; i < buf.length; i += 1) {
        for (let j = 0; j < 8; j += 1) out[i * 8 + j] = (buf[i] >> (7 - j)) & 1;
      }
      return out;
    };
    const bytesOf = (bits) => {
      const out = new Uint8Array(bits.length / 8);
      for (let i = 0; i < out.length; i += 1) {
        let v = 0;
        for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i * 8 + j];
        out[i] = v;
      }
      return out;
    };
    const xor = (a, b) => a.map((v, i) => v ^ b[i]);
    const rotl = (arr, n) => arr.slice(n).concat(arr.slice(0, n));
    function subkeysOf(key) {
      const k = permute(bitsOf(key), PC1);
      let c = k.slice(0, 28), d = k.slice(28);
      const out = [];
      for (let i = 0; i < 16; i += 1) {
        c = rotl(c, SHIFTS[i]); d = rotl(d, SHIFTS[i]);
        out.push(permute(c.concat(d), PC2));
      }
      return out;
    }
    function feistel(r, k) {
      const x = xor(permute(r, E), k);
      const out = [];
      for (let i = 0; i < 8; i += 1) {
        const b = x.slice(i * 6, i * 6 + 6);
        const v = SBOX[i][((b[0] << 1) | b[5]) * 16 + ((b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4])];
        out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
      }
      return permute(out, P);
    }
    /** DES-ECB + PKCS7 + base64（与站点 CryptoJS 口径一致） */
    function encryptBase64(text, keyStr = "csg_spoc") {
      const raw = new TextEncoder().encode(String(text === undefined || text === null ? "" : text));
      const pad = 8 - (raw.length % 8);
      const data = new Uint8Array(raw.length + pad);
      data.set(raw); data.fill(pad, raw.length);
      const subkeys = subkeysOf(new TextEncoder().encode(keyStr));
      const out = new Uint8Array(data.length);
      for (let off = 0; off < data.length; off += 8) {
        const bits = permute(bitsOf(data.slice(off, off + 8)), IP);
        let l = bits.slice(0, 32), r = bits.slice(32);
        for (let i = 0; i < 16; i += 1) {
          const nl = r;
          const nr = xor(l, feistel(r, subkeys[i]));
          l = nl; r = nr;
        }
        out.set(bytesOf(permute(r.concat(l), FP)), off);
      }
      let s = "";
      for (let i = 0; i < out.length; i += 1) s += String.fromCharCode(out[i]);
      return btoa(s);
    }
    return { encryptBase64 };
  })();

  /** HTML 转义：模型/站点给的文本一律先转义再进 innerHTML（防 XSS，S9） */
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** 等 document.body 就绪（SPA 早期/被替换时 body 可能还不存在，S5） */
  async function safeBody(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.body) return document.body;
      await new Promise((r) => setTimeout(r, 150));
    }
    return document.body || null;
  }

  /** 用户点了取消：把"用户中断"和"执行失败"区分开（S4） */
  class CancelledError extends Error {
    constructor() { super("已取消"); this.name = "CancelledError"; }
  }

  /**
   * 主动跳过（v1.4.0）：不是失败，是"这套不该答"。
   * 跳过一律 不调 AI / 不写答案 / 不交卷 / 不计失败 / 不重试。
   */
  class SkipError extends Error {
    constructor(reason, kind = "skip") {
      super(String(reason || "已跳过"));
      this.name = "SkipError";
      this.reason = String(reason || "已跳过");
      this.kind = kind;                 // rule | unsupported | homework | empty
    }
  }

  // ------------------------------------------------------------ 单实例锁（S2 修正版）
  const LOCK_KEY = "runLock";
  const OWNER_KEY = "ownerId";
  const LOCK_ALIVE_MS = 90 * 1000;   // 心跳超过 90 秒视为已死（页面被关/跳转）
  const inflight = new Set();        // 正在飞的请求，停止时可一次性中止

  /** 本机（本浏览器里这个脚本）的固定身份：页面刷新/跳转后仍然是同一个 */
  function ownerId() {
    let id = GM_getValue(OWNER_KEY, "");
    if (!id) {
      id = "o-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      GM_setValue(OWNER_KEY, id);
    }
    return id;
  }

  function lockInfo() {
    const info = GM_getValue(LOCK_KEY, null);
    if (!info) return null;
    if (Date.now() - (info.at || 0) > LOCK_ALIVE_MS) return null;   // 过期
    return info;
  }

  /**
   * 抢锁。规则：
   *  - 锁是"同一个 owner + 同一个模式" → 视为自己续租（页面刷新后能接着跑，修掉"自己拦自己"）
   *  - 锁是"同一个 owner + 不同模式" → 冲突（无人值守 vs 一键批量，这才是要防的）
   *  - 锁是别的 owner 且心跳新鲜 → 冲突
   */
  function acquireLock(kind) {
    const cur = lockInfo();
    const mine = ownerId();
    if (cur && cur.ownerId === mine && cur.kind !== kind) return false;
    if (cur && cur.ownerId !== mine) return false;
    GM_setValue(LOCK_KEY, { ownerId: mine, kind, at: Date.now() });
    return true;
  }

  function heartbeatLock() {
    const cur = lockInfo();
    if (cur && cur.ownerId === ownerId()) GM_setValue(LOCK_KEY, { ...cur, at: Date.now() });
  }

  /** 只释放自己那种模式的锁（不指定 kind 就释放任何属于自己的锁） */
  function releaseLock(kind) {
    const cur = lockInfo();
    if (!cur || cur.ownerId !== ownerId()) return;
    if (kind && cur.kind !== kind) return;
    GM_setValue(LOCK_KEY, null);
  }

  /** 中止所有在飞的请求（点"停止"时用，避免停了还在花钱/还在写） */
  function abortInflight() {
    for (const h of inflight) { try { h && h.abort && h.abort(); } catch { /* ignore */ } }
    inflight.clear();
    hideProgress();
  }

  function lockBusyMessage() {
    const cur = lockInfo();
    const who = cur && cur.kind === "unattended" ? "无人值守"
      : (cur && cur.kind === "batch" ? "一键作答全部任务" : "另一个流程");
    return `已有「${who}」在运行，先等它结束（或点面板上的「停止（全部）」），避免两个流程同时写答案。`;
  }

  // ------------------------------------------------------------------ AI 报错（对齐官方文档）
  // 错误码含义/原因/解决办法全部照抄 DeepSeek 官方《错误码》：
  //   https://api-docs.deepseek.com/zh-cn/quick_start/error_codes
  // noRetry：配置/请求本身有问题，重试再多次结果一样 → 当场停手
  // backoff：官方建议"稍后重试"那类，重试前先等一会儿，别高频刷
  //   short/act 是给人看的一句话（结论 + 该干什么）；name/cause/fix 是官方原文，只进日志方便对照文档
  const AI_HTTP_DOC = {
    400: { name: "格式错误", short: "请求格式不对", act: "把日志发给作者", cause: "请求体格式错误",
           fix: "请根据错误信息提示修改请求体", noRetry: true },
    401: { name: "认证失败", short: "API Key 无效", act: "去设置里重填 Key", cause: "API key 错误，认证失败",
           fix: "请检查您的 API key 是否正确，如没有 API key，请先创建", noRetry: true },
    402: { name: "余额不足", short: "DeepSeek 余额不足", act: "去官网充值", cause: "账号余额不足",
           fix: "请确认账户余额，并前往充值页面进行充值", noRetry: true },
    422: { name: "参数错误", short: "请求参数不对", act: "把日志发给作者", cause: "请求体参数错误",
           fix: "请根据错误信息提示修改相关参数", noRetry: true },
    429: { name: "请求速率达到上限", short: "请求过快被限流", act: "已自动等一会儿再试", cause: "请求速率（TPM 或 RPM）达到上限",
           fix: "请合理规划您的请求速率", backoff: [6000, 20000] },
    500: { name: "服务器故障", short: "DeepSeek 服务器故障", act: "稍后自动重试", cause: "服务器内部故障",
           fix: "请等待后重试；若问题一直存在，请联系我们解决", backoff: [3000, 8000] },
    503: { name: "服务器繁忙", short: "DeepSeek 服务器繁忙", act: "稍后自动重试", cause: "服务器负载过高",
           fix: "请稍后重试您的请求", backoff: [3000, 8000] },
  };

  // 退避秒数可被测试改小（也方便以后做成设置项）
  const AI_BACKOFF = { 429: [6000, 20000], 500: [3000, 8000], 503: [3000, 8000] };

  // v1.6.0：换成别家之后 DeepSeek 那套说法就不适用了，这里按服务商覆盖文案。
  // 只覆盖 short/act（给人看的那句）；官方原文继续留在 AI_HTTP_DOC 里供对照。
  const PROVIDER_ERR = {
    deepseek: { 402: { short: "DeepSeek 余额不足", act: "去官网充值" },
                429: { short: "请求过快被限流", act: "已自动等一会儿再试" },
                500: { short: "DeepSeek 服务器故障", act: "稍后自动重试" },
                503: { short: "DeepSeek 服务器繁忙", act: "稍后自动重试" } },
    openai: { 401: { short: "OpenAI Key 无效", act: "去设置里重填 Key" },
              402: { short: "OpenAI 账户余额/配额不足", act: "去 platform.openai.com 看账单" },
              429: { short: "OpenAI 配额或限流", act: "查用量与账单，或等一会儿再试" } },
    anthropic: { 401: { short: "Claude Key 无效", act: "去 console.anthropic.com 重开一把" },
                 429: { short: "Claude 限流", act: "已自动等一会儿再试" },
                 529: { short: "Claude 服务过载", act: "稍后自动重试" } },
    gemini: { 400: { short: "Gemini 拒绝了请求", act: "多半是模型名不对，点「检测模型」挑一个" },
              429: { short: "Gemini 配额用尽", act: "换把 key，或等配额重置" },
              404: { short: "Gemini 找不到这个模型", act: "点「检测模型」重新挑一个" } },
    openrouter: { 402: { short: "OpenRouter 余额不足", act: "去官网充值" } },
    zhipu: { 429: { short: "智谱限流", act: "已自动等一会儿再试" } },
    dashscope: { 429: { short: "百炼限流", act: "已自动等一会儿再试" } },
  };

  // DeepSeek 官方文档没写的那些码，给个通用说法（换服务商之后很常见：404 模型名不对）
  const AI_HTTP_GENERIC = {
    403: { name: "无权访问", short: "这把 Key 没权限", act: "确认 Key 有效、且该模型对你开放",
           cause: "Key 有效但没有调用该模型的权限", fix: "在服务商后台给这把 Key 开权限，或换一个模型", noRetry: true },
    404: { name: "找不到", short: "接口或模型名不对", act: "先点「检测模型」看这把 Key 能用哪些",
           cause: "接口路径或模型名不存在", fix: "确认 base_url 不带 /chat/completions，且模型名与服务商一致", noRetry: true },
    405: { name: "方法不允许", short: "这个站不支持「拉模型列表」", act: "手动填模型名",
           cause: "该服务商没有 GET /models", fix: "自己按服务商文档填模型名", noRetry: true },
    413: { name: "请求体过大", short: "图片太大/太多", act: "把每批题数调小，或分几次做",
           cause: "请求体超过服务商上限", fix: "减小 batchSize 或减少一次附带的图片数", noRetry: true },
    502: { name: "网关错误", short: "网关错误", act: "稍后自动重试", cause: "上游网关返回 502",
           fix: "稍后重试", backoff: [3000, 8000] },
    504: { name: "网关超时", short: "服务商那边超时了", act: "稍后自动重试", cause: "上游网关超时",
           fix: "稍后重试，或调大请求超时", backoff: [3000, 8000] },
    529: { name: "服务过载", short: "服务商过载", act: "稍后自动重试", cause: "服务商整体过载",
           fix: "稍后重试", backoff: [5000, 15000] },
  };

  /** 按当前服务商 + 错误码，拼出「该说什么」的一份说明 */
  function aiDocFor(code) {
    if (!code) return null;
    let base = AI_HTTP_DOC[code] || AI_HTTP_GENERIC[code] || null;
    if (!base) {
      base = code >= 500
        ? { name: "服务端错误", short: `${code} 服务端报错`, act: "稍后自动重试",
            cause: `服务端返回 ${code}`, fix: "稍后重试；一直这样就是这家服务商的问题", backoff: [3000, 8000] }
        : (code >= 400
          ? { name: "请求被拒", short: `${code} 请求被拒`, act: "检查服务商设置和模型名",
              cause: `接口返回 ${code}`, fix: "确认「接口地址 / 模型名」和该服务商对得上", noRetry: true }
          : null);
    }
    if (!base) return null;
    const over = (PROVIDER_ERR[CFG.provider] || {})[code] || null;
    return over ? Object.assign({}, base, over) : base;
  }

  /** 从报错里抠出 DeepSeek 的 HTTP 状态码（脚本抛的错形如「接口返回 401：{...}"） */
  function aiHttpCode(e) {
    const msg = String((e && e.message) || e || "");
    const m = msg.match(/\b(400|401|402|403|404|405|413|422|429|500|502|503|504|529)\b/);
    return m ? Number(m[1]) : null;
  }

  /** 把 DeepSeek 返回体里的 error.message 抠出来（官方说"根据错误信息提示修改"，这就是那句提示） */
  function aiRawMessage(e) {
    const msg = String((e && e.message) || e || "");
    const m = msg.match(/"message"\s*:\s*"([^"]{1,200})"/);
    return m ? m[1] : "";
  }

  /** 统一取一次 AI 错误的分类结果：{code, doc, raw, fatal, backoff} */
  function aiErrorInfo(e) {
    const code = aiHttpCode(e);
    const doc = aiDocFor(code);
    return { code, doc, raw: aiRawMessage(e), fatal: !!(doc && doc.noRetry),
             backoff: (AI_BACKOFF[code] || (doc && doc.backoff)) || null };   // 以 AI_BACKOFF 为准，测试可以改小
  }

  /** 给人看的一句话：结论（码）→ 该干什么。短到一眼能看完（v1.5.1 起） */
  function explainError(e) {
    const msg = String((e && e.message) || e || "");
    if (/登录|203|login-error|未登录|authtoken/.test(msg)) return "云课堂登录过期 → 重新登录 csgmooc 再试";
    if (/model[\s\S]{0,30}?(not\s*exist|not\s*found|不存在|无效|invalid|unknown)/i.test(msg)
        || /没有(这个|该)?模型/.test(msg)) return "模型名不对 → 点「检测模型」挑一个能用的";
    const info = aiErrorInfo(e);
    if (info.doc) return `${info.doc.short}（${info.code}）→ ${info.doc.act}`;
    if (/超时|timeout/i.test(msg)) return `请求超时（${CFG.timeoutSec}s）→ 稍后重试`;
    if (/Failed to fetch|网络错误|NetworkError/.test(msg)) return "网络失败 → 检查网络后重试";
    if (/不是约定格式|JSON|漏答/.test(msg)) return "模型回复格式不对 → 已重试";
    if (/没有题干|既没有图片/.test(msg)) return "这套题没题干也没图片 → 需要手工做";
    if (/还没填 API Key/.test(msg)) return "还没填 API Key → 点「设置」填上";
    return msg || "未知错误";
  }

  /** 官方原文那一版（只写进日志，方便你拿去和 DeepSeek 文档对照） */
  function explainErrorDoc(e) {
    const info = aiErrorInfo(e);
    if (!info.doc) return "";
    const raw = info.raw ? `；原话：${info.raw}` : "";
    const who = CFG.provider === "deepseek"
      ? "官方"
      : `${((providerById(CFG.provider) || {}).name || CFG.provider)} 官方`;   // 换家之后别再挂 DeepSeek 的名
    return `${who} ${info.code} ${info.doc.name}：${info.doc.cause} → ${info.doc.fix}${raw}`;
  }

  /**
   * 这类错误重试多少次都没用：官方定义为"配置/请求问题"的 400/401/402/422，
   * 以及连续撞限流的 429（频率问题，继续刷只会更糟）。
   */
  function isFatalAiError(e) {
    const info = aiErrorInfo(e);
    return info.fatal || info.code === 429;      // 429 也算"先停下"：官方说别高频重试
  }
  // ---------------------------------------------------------------- 日志（可导出）
  const LOG_MAX = 1500;
  let logBufCache = null;      // 内存缓冲，攒批写入（避免每条日志都写一次存储，S10）
  let logDirty = false;
  let logFlushTimer = null;

  function logLine(level, msg) {
    try {
      if (!logBufCache) logBufCache = GM_getValue("logBuf", []) || [];
      logBufCache.push({ t: Date.now(), lv: level, m: String(msg).slice(0, 500) });
      if (logBufCache.length > LOG_MAX) logBufCache.splice(0, logBufCache.length - LOG_MAX);
      logDirty = true;
      if (!logFlushTimer) logFlushTimer = setTimeout(flushLog, 2000);
    } catch { /* 存储失败不影响主流程 */ }
  }

  function flushLog() {
    logFlushTimer = null;
    if (!logDirty || !logBufCache) return;
    logDirty = false;
    try { GM_setValue("logBuf", logBufCache); } catch { /* ignore */ }
  }

  const log = (...a) => { console.log("[yzj]", ...a); };

  function captureGlobals() {
    window.addEventListener("error", (e) => {
      // 标成 page：这类错误**可能来自站点页面自己**，不一定是插件（插件自己的错误会以 error 记）
      logLine("page", `页面脚本报错（不一定是插件）：${e.message || ""} @ ${String(e.filename || "").split("/").pop()}:${e.lineno || "?"}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      const r = e.reason || {};
      logLine("page", "页面未处理的异步错误（不一定是插件）：" + String(r.message || r));
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const token = () => sessionStorage.getItem("reslibAuthtoken") || "";

  let lastHandle = null;
  let lastUsage = 0;
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      let handle = null;
      const done = (fn) => (arg) => { if (handle) inflight.delete(handle); fn(arg); };
      handle = GM_xmlhttpRequest({
        ...opts,
        timeout: opts.timeout || CFG.timeoutSec * 1000,
        onload: done((res) => resolve(res)),
        onerror: done((e) => reject(new Error("网络错误：" + (e && e.error ? e.error : "unknown")))),
        ontimeout: done(() => reject(new Error(`请求超时（${CFG.timeoutSec}s）`))),
        onabort: done(() => reject(new Error("已取消"))),
      });
      lastHandle = handle;
      if (handle) inflight.add(handle);
    });
  }

  /** 顶部进度条（可取消），用来避免"看着像卡死" */
  let progressEl = null;
  function showProgress(text, onCancel) {
    if (!progressEl) {
      progressEl = document.createElement("div");
      progressEl.className = "yzj-progress";
      progressEl.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483002;"
        + "background:#1f6feb;color:#fff;padding:8px 14px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.25);"
        + "font:13px/1.4 'Microsoft YaHei',system-ui,sans-serif";
      document.body.appendChild(progressEl);
    }
    progressEl.innerHTML = `<span>${text}</span>
      <span class="yzj-btn gray" style="padding:1px 8px;margin-left:8px">取消</span>`;
    progressEl.querySelector(".yzj-btn").onclick = () => {
      try { if (lastHandle && lastHandle.abort) lastHandle.abort(); } catch { /* ignore */ }
      hideProgress();
      say("已取消本次请求。");
    };
  }
  function hideProgress() { if (progressEl) { progressEl.remove(); progressEl = null; } }

  /** 轻提示（不阻塞页面） */
  function toast(msg, ms = 4000) {
    let t = document.querySelector(".yzj-toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "yzj-toast";
      t.style.cssText = "position:fixed;left:50%;bottom:70px;transform:translateX(-50%);z-index:2147483002;"
        + "background:rgba(0,0,0,.82);color:#fff;padding:9px 16px;border-radius:8px;max-width:70vw;"
        + "font:13px/1.5 'Microsoft YaHei',system-ui,sans-serif;transition:opacity .3s;pointer-events:none";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => { t.style.opacity = "0"; }, ms);
  }

  /** 站点接口（同源 fetch，带 authtoken） */
  async function api(path, { method = "GET", body, form = false } = {}) {
    const headers = { authtoken: token() };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
      payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    }
    const t0 = performance.now();
    let res = null, text = "";
    try {
      res = await fetch(CFG.apiCourse + path, { method, headers, body: payload, credentials: "include" });
      text = await res.text();
    } catch (e) {
      logLine("error", `站点接口失败 ${method} ${path.slice(0, 70)} → ${e.message}`);
      throw e;
    }
    const ms = Math.round(performance.now() - t0);
    logLine("api", `${method} ${path.slice(0, 70)} → ${res.status} (${ms}ms, ${text.length}B)`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async function imageToDataUrl(url) {
    const blob = await fetchImageBlob(url);
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  // 图片只下载一次：AI 取图 + 算指纹共用（同一次运行内缓存）
  const imageBlobCache = new Map();
  async function fetchImageBlob(url) {
    if (imageBlobCache.has(url)) return imageBlobCache.get(url);
    const p = fetch(url, { credentials: "include" }).then((r) => r.blob());
    imageBlobCache.set(url, p);
    return p;
  }

  // ---------------------------------------------------------- AI 协议适配（v1.6.0）
  /**
   * 把 data URL（data:image/png;base64,xxxx）拆成协议各自要的形态。
   * 三个协议对图片的写法完全不同，所以统一在 here 拆一次，上层只管给 data URL。
   */
  function splitDataUrl(dataUrl) {
    const m = String(dataUrl || "").match(/^data:([^;,]+);base64,(.*)$/);
    return m ? { mime: m[1], data: m[2] } : { mime: "image/png", data: String(dataUrl || "") };
  }

  /**
   * 组 URL。kind: "chat"（判题）| "models"（拉模型列表）
   * opts 允许临时覆盖（设置页在保存前就要用输入框里的值去检测）。
   */
  function aiUrl(kind, opts = {}) {
    const base = String(opts.baseUrl != null ? opts.baseUrl : CFG.baseUrl).trim().replace(/\/+$/, "");
    const proto = opts.proto || CFG.proto;
    const model = String(opts.model != null ? opts.model : CFG.model).replace(/^models\//, "");
    if (proto === "gemini") {
      if (kind === "models") return base + "/models";
      return base + "/models/" + encodeURIComponent(model) + ":generateContent";
    }
    if (kind === "models") return base + "/models";
    return base + (proto === "anthropic" ? "/messages" : "/chat/completions");
  }

  /** 鉴权头：三家各不一样（Gemini 用 x-goog-api-key，省得把 key 写进 URL 进日志） */
  function aiHeaders(opts = {}) {
    const key = String(opts.apiKey != null ? opts.apiKey : CFG.apiKey || "").trim();
    const proto = opts.proto || CFG.proto;
    if (proto === "anthropic") {
      return { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
               "anthropic-dangerous-direct-browser-access": "true" };
    }
    if (proto === "gemini") return { "Content-Type": "application/json", "x-goog-api-key": key };
    return { "Content-Type": "application/json", Authorization: "Bearer " + key };
  }

  /**
   * 组请求体。parts = [{text}] 或 [{image: <dataUrl>}]（顺序即模型看到的顺序）。
   * thinking 只在 DeepSeek 那条路上带（reasoning_effort），别的家带上去有的会直接 400。
   */
  function aiBody({ proto, model, systemText, parts, maxTokens, temperature = 0, effort = "" }) {
    if (proto === "anthropic") {
      return { model, max_tokens: maxTokens, temperature, system: systemText,
        messages: [{ role: "user", content: parts.map((p) => (p.image != null
          ? (() => { const d = splitDataUrl(p.image); return { type: "image",
              source: { type: "base64", media_type: d.mime, data: d.data } }; })()
          : { type: "text", text: p.text })) }] };
    }
    if (proto === "gemini") {
      return { systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: "user", parts: parts.map((p) => (p.image != null
          ? (() => { const d = splitDataUrl(p.image); return { inline_data: { mime_type: d.mime, data: d.data } }; })()
          : { text: p.text })) }],
        generationConfig: { temperature, maxOutputTokens: maxTokens } };
    }
    return { model, temperature, max_tokens: maxTokens,
      messages: [{ role: "system", content: systemText },
        { role: "user", content: parts.map((p) => (p.image != null
          ? { type: "image_url", image_url: { url: p.image } }
          : { type: "text", text: p.text })) }],
      ...(proto === "openai" && isDeepSeek() && effort ? { reasoning_effort: effort } : {}),
    };
  }

  /** 从各家的返回体里把正文抠出来 */
  function aiTextOf(body, proto) {
    const b = body || {};
    if (proto === "anthropic") {
      return (b.content || []).filter((c) => c && c.type === "text").map((c) => c.text || "").join("");
    }
    if (proto === "gemini") {
      const c = (b.candidates || [])[0] || {};
      return (((c.content || {}).parts) || []).map((p) => (p && p.text) || "").join("");
    }
    const ch = (b.choices || [])[0] || {};
    return (ch.message && ch.message.content) || "";
  }

  /** 统一的「被截断了吗」：三家都有各自的说法，都归一成 "length" / "stop" */
  function aiFinishOf(body, proto) {
    const b = body || {};
    if (proto === "anthropic") return b.stop_reason === "max_tokens" ? "length" : "stop";
    if (proto === "gemini") {
      const c = (b.candidates || [])[0] || {};
      return String(c.finishReason || "").toUpperCase() === "MAX_TOKENS" ? "length" : "stop";
    }
    return ((b.choices || [])[0] || {}).finish_reason || "";
  }

  /** 统一的 token 用量（有的家叫 usage，有的叫 usageMetadata） */
  function aiUsageOf(body) {
    const b = body || {};
    const u = b.usage || b.usageMetadata || {};
    if (u.total_tokens) return Number(u.total_tokens);
    if (u.total_token_count) return Number(u.total_token_count);
    return Number(u.input_tokens || 0) + Number(u.output_tokens || 0);
  }

  /**
   * 把 /models 的返回体解析成 [{id, vision, note}]。
   * 只有 OpenRouter 这类聚合站会顺带告诉你「这个模型能不能吃图片」，其余家只能给个 id。
   */
  function parseModelList(body, proto) {
    const out = [];
    const push = (id, vision, note) => { if (id) out.push({ id: String(id), vision: vision || "", note: note || "" }); };
    const hasImg = (v) => /image|vision|multimodal/i.test(Array.isArray(v) ? v.join(",") : String(v || ""));
    const b = body || {};
    if (proto === "gemini") {
      for (const m of b.models || []) {
        const id = String(m.name || "").replace(/^models\//, "");
        push(id, hasImg(m.inputModalities || m.supportedGenerationMethods) ? "yes" : "", m.displayName || "");
      }
    } else if (proto === "anthropic") {
      for (const m of b.data || []) push(m.id, /claude/i.test(String(m.id || "")) ? "yes" : "", m.display_name || "");
    } else {
      for (const m of b.data || b.models || []) {
        if (typeof m === "string") { push(m, ""); continue; }
        const id = m.id || m.name || m.model;
        const mods = (m.architecture && m.architecture.input_modalities) || m.input_modalities || m.modalities;
        push(id, hasImg(mods) ? "yes" : "", (m.name && m.name !== id) ? String(m.name).slice(0, 40) : "");
      }
    }
    const seen = new Set(), uniq = [];
    for (const m of out) if (!seen.has(m.id)) { seen.add(m.id); uniq.push(m); }
    // 能看图的排前面，其余按字母序
    uniq.sort((a, x) => ((a.vision === "yes" ? 0 : 1) - (x.vision === "yes" ? 0 : 1)) || a.id.localeCompare(x.id));
    return uniq;
  }

  /** 拉一次模型列表。失败时抛错，调用方负责提示（设置页会把原话显示出来） */
  async function fetchModelList(opts = {}) {
    const proto = opts.proto || CFG.proto;
    const url = aiUrl("models", { baseUrl: opts.baseUrl, proto, model: opts.model });
    logLine("ai", `检测模型：GET ${url.slice(0, 90)}（${PROTO_LABEL[proto] || proto}）`);
    const res = await gmRequest({ method: "GET", url, headers: aiHeaders({ apiKey: opts.apiKey, proto }),
                                  timeout: Math.max(15000, CFG.timeoutSec * 1000) });
    if (res.status !== 200) {
      throw new Error("接口返回 " + res.status + "：" + String(res.responseText || "").slice(0, 200));
    }
    let body = null;
    try { body = JSON.parse(res.responseText); } catch { throw new Error("返回的不是 JSON：" + String(res.responseText).slice(0, 120)); }
    return parseModelList(body, proto);
  }

  /**
   * 「测一下这把 key + 这个模型到底通不通」：发一条最小请求（大约十几个 token）。
   * 比 /models 更可信——有的站 /models 是假的，但聊天接口是真能用的。
   */
  async function testAiConnection(opts = {}) {
    const proto = opts.proto || CFG.proto;
    const model = String(opts.model || CFG.model || "");
    const t0 = performance.now();
    const res = await gmRequest({
      method: "POST", url: aiUrl("chat", { baseUrl: opts.baseUrl, proto, model }),
      headers: aiHeaders({ apiKey: opts.apiKey, proto }),
      data: JSON.stringify(aiBody({ proto, model, systemText: "只回复 ok", parts: [{ text: "ping" }],
                                    maxTokens: 32, temperature: 0 })),
      timeout: Math.max(20000, CFG.timeoutSec * 1000),
    });
    const ms = Math.round(performance.now() - t0);
    if (res.status !== 200) throw new Error("接口返回 " + res.status + "：" + String(res.responseText || "").slice(0, 200));
    let body = null;
    try { body = JSON.parse(res.responseText); } catch { throw new Error("返回的不是 JSON：" + String(res.responseText).slice(0, 120)); }
    return { ms, model, text: aiTextOf(body, proto).slice(0, 60), tokens: aiUsageOf(body) };
  }

  /**
   * 文档感知哈希（64bit）：先裁掉白边，再把内容切成 8×8 网格算"墨迹密度"，按中位数二值化。
   * 比逐像素 dHash 更适合整页扫描件——抗缩放、抗 JPEG 重压缩。
   * 全白/解码失败返回 ""（调用方当作没有指纹）。
   */
  function dHash64(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const W = 320;                                   // 只为提速，等比缩小
          const scale = Math.min(1, W / img.width);
          const w = Math.max(8, Math.round(img.width * scale));
          const h = Math.max(8, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data;
          const ink = new Uint8Array(w * h);
          let minX = w, minY = h, maxX = -1, maxY = -1;
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const i = (y * w + x) * 4;
              const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
              const isInk = g < 200 ? 1 : 0;
              ink[y * w + x] = isInk;
              if (isInk) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) { resolve(""); return; }           // 全白，没有可用指纹
          const cw = maxX - minX + 1, ch = maxY - minY + 1;
          const cells = [];
          for (let gy = 0; gy < 8; gy += 1) {
            for (let gx = 0; gx < 8; gx += 1) {
              const x0 = minX + Math.floor(cw * gx / 8);
              const x1 = Math.max(x0 + 1, minX + Math.floor(cw * (gx + 1) / 8));
              const y0 = minY + Math.floor(ch * gy / 8);
              const y1 = Math.max(y0 + 1, minY + Math.floor(ch * (gy + 1) / 8));
              let sum = 0, n = 0;
              for (let y = y0; y < y1; y += 1) {
                for (let x = x0; x < x1; x += 1) { sum += ink[y * w + x]; n += 1; }
              }
              cells.push(n ? sum / n : 0);
            }
          }
          const med = cells.slice().sort((a, b) => a - b)[32];
          let bits = "";
          cells.forEach((v) => { bits += v >= med ? "1" : "0"; });
          let hex = "";
          for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
          resolve(hex);
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
      img.src = url;
    });
  }

  /** 两个 16 位十六进制哈希的汉明距离（用于"近似命中"） */
  function hammingHex(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i += 1) {
      const x = (parseInt(a[i], 16) || 0) ^ (parseInt(b[i], 16) || 0);
      d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
    }
    return d;
  }

  /** 一张图的两种指纹（任一算不出来都不影响主流程） */
  async function imageFingerprints(blob) {
    const fp = {};
    try {
      const buf = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      fp.sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    } catch { /* 某些环境没有 crypto.subtle，就只用 dHash */ }
    try { fp.dh = await dHash64(blob); } catch { /* ignore */ }
    return fp;
  }

  // ------------------------------------------------------------------ 界面
  const css = `
  .yzj-panel{position:fixed;right:18px;bottom:18px;width:380px;max-height:70vh;overflow:auto;z-index:2147483000;
    background:#fff;color:#222;border:1px solid #d7dbe0;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);
    font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif}
  .yzj-panel h3{margin:0;padding:10px 12px;font-size:14px;background:#1f6feb;color:#fff;border-radius:11px 11px 0 0;
    display:flex;gap:8px;align-items:center}
  .yzj-panel h3>span:first-child{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .yzj-ver{font-size:11px;font-weight:400;opacity:.85;flex:0 0 auto}
  .yzj-nav{display:flex;flex-wrap:wrap;gap:6px;padding:9px 12px 0}
  .yzj-nav .yzj-btn{margin:0}
  .yzj-body{padding:10px 12px}
  .yzj-btn{display:inline-block;padding:5px 10px;margin:2px 4px 2px 0;border-radius:7px;border:1px solid #1f6feb;
    background:#1f6feb;color:#fff;cursor:pointer;font-size:12px}
  .yzj-btn.sm{padding:3px 9px;font-size:12px;line-height:1.5}
  .yzj-btn.gray{background:#fff;color:#1f6feb}
  .yzj-btn.red{background:#d1352b;border-color:#d1352b}
  .yzj-btn:disabled{opacity:.5;cursor:not-allowed}
  .yzj-row{padding:6px 0;border-bottom:1px dashed #eceff3}
  .yzj-ans{font-weight:700;color:#0a7a3d}
  .yzj-log{max-height:150px;overflow:auto;background:#f6f8fa;border-radius:8px;padding:6px;font-size:12px;white-space:pre-wrap}
  .yzj-card{position:absolute;right:6px;top:6px;z-index:5}
  .yzj-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001;display:flex;align-items:center;justify-content:center}
  .yzj-dialog{background:#fff;border-radius:12px;padding:16px;width:420px;max-height:88vh;overflow-y:auto;
    font:13px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  .yzj-dialog::-webkit-scrollbar{width:8px}
  .yzj-dialog::-webkit-scrollbar-thumb{background:#ccd3dc;border-radius:4px}
  .yzj-dialog input:not([type=checkbox]){width:100%;padding:6px 8px;margin:4px 0 10px;border:1px solid #d7dbe0;border-radius:7px;font-size:13px}
  .yzj-dialog .yzj-check{display:flex;align-items:center;gap:8px;margin:4px 0 6px;cursor:pointer;user-select:none}
  .yzj-dialog .yzj-check input[type=checkbox]{width:16px;height:16px;margin:0;flex:0 0 auto;cursor:pointer}
  .yzj-dialog .yzj-check span{font-size:13px}
  .yzj-dialog .yzj-field{margin-top:2px}
  .yzj-dialog .yzj-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;margin:4px 0 8px}
  .yzj-dialog .yzj-check-row{display:flex;align-items:center;gap:2px}
  .yzj-dialog .yzj-sec{border-top:1px solid #eef1f5;margin:10px 0 6px;padding-top:8px;font-weight:600;color:#333}
  .yzj-info{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;
    background:#b9c2cc;color:#fff;font-size:11px;font-weight:700;margin-left:5px;cursor:help;position:relative;
    vertical-align:middle;line-height:1}
  .yzj-info:hover{background:#1f6feb}
  .yzj-tip{color:#666;font-size:12px}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  function injectStyle() {
    (document.head || document.documentElement || document.body).appendChild(style);
  }

  let panel = null;
  let panelEl = null;
  function ensurePanel(title = "易智教 · 自动作答助手") {
    if (panelEl && document.body.contains(panelEl)) return panelEl;
    panelEl = document.createElement("div");
    panelEl.className = "yzj-panel";
    panelEl.innerHTML = `<h3><span>${title}</span><span class="yzj-ver">v${YZJ_VERSION}</span>
        <span class="yzj-btn gray sm" data-act="close">收起</span></h3>
      <div class="yzj-nav">
        <span class="yzj-btn gray sm" data-act="bank">题库</span>
        <span class="yzj-btn gray sm" data-act="log">日志</span>
        <span class="yzj-btn gray sm" data-act="history">历史</span>
        <span class="yzj-btn gray sm" data-act="settings">设置</span>
      </div>
      <div class="yzj-body">
        <div class="yzj-setup" style="display:none;background:#fff7e6;border:1px solid #ffd591;border-radius:8px;padding:8px;margin-bottom:8px">
          ⚠️ 还没填 API Key，点这里 <span class="yzj-btn sm" data-act="settings2">去设置</span>
        </div>
        <div class="yzj-log">就绪。任务列表页：点卡片上的「AI 自动作答」；答题页：点右下角「AI 用本页作答」。</div>
      </div>`;
    document.body.appendChild(panelEl);
    const closeBtn = panelEl.querySelector('[data-act="close"]');
    closeBtn.textContent = "收起";
    closeBtn.onclick = () => { panelEl.style.display = "none"; showLauncher(); };
    panelEl.querySelector('[data-act="settings"]').onclick = openSettings;
    panelEl.querySelector('[data-act="history"]').onclick = openHistory;
    panelEl.querySelector('[data-act="log"]').onclick = openLog;
    panelEl.querySelector('[data-act="bank"]').onclick = openBank;
    panelEl.querySelector('[data-act="settings2"]').onclick = openSettings;
    if (onTaskPage()) panelBatchBar();
    refreshSetupHint();
    return panelEl;
  }

  function refreshSetupHint() {
    const hint = document.querySelector(".yzj-panel .yzj-setup");
    if (hint) hint.style.display = aiReady() ? "none" : "block";
  }

  function bodyEl() { return document.querySelector(".yzj-panel .yzj-body"); }
  function logEl() { return document.querySelector(".yzj-panel .yzj-log"); }
  function say(msg) {
    const el = logEl();
    if (el) { el.textContent += "\n" + msg; el.scrollTop = el.scrollHeight; }
    log(msg);
    logLine("info", msg);
  }

  /** 给设置项里的「!」绑定悬浮提示（用 fixed 浮层，避免被弹窗滚动区裁掉） */
  function attachTooltips(root) {
    root.querySelectorAll(".yzj-info").forEach((el) => {
      el.addEventListener("mouseenter", () => {
        const tip = document.createElement("div");
        tip.textContent = el.getAttribute("data-tip") || "";
        tip.style.cssText = "position:fixed;z-index:2147483006;background:#2b2f36;color:#fff;padding:8px 10px;"
          + "border-radius:8px;font:12px/1.65 'Microsoft YaHei',system-ui,sans-serif;width:280px;"
          + "box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none;white-space:pre-wrap";
        document.body.appendChild(tip);
        const r = el.getBoundingClientRect();
        let x = r.left + r.width / 2 - 140;
        let y = r.top - tip.offsetHeight - 8;
        if (y < 8) y = r.bottom + 8;                                  // 上面放不下就放下边
        x = Math.max(8, Math.min(window.innerWidth - 288, x));
        tip.style.left = x + "px";
        tip.style.top = y + "px";
        el.__tip = tip;
      });
      el.addEventListener("mouseleave", () => {
        if (el.__tip) { el.__tip.remove(); el.__tip = null; }
      });
    });
  }

  function openSettings() {
    const mask = document.createElement("div");
    mask.className = "yzj-mask";
    const info = (tip) => `<span class="yzj-info" data-tip="${tip}"></span>`;
    mask.innerHTML = `<div class="yzj-dialog" style="width:480px">
      <h3 style="margin:0 0 8px;font-size:15px">设置
        <span id="yzj-ver" style="font-size:11px;font-weight:400;color:#8a94a0">v${YZJ_VERSION}</span></h3>
      <div class="yzj-sec">AI 服务商</div>
      <div class="yzj-field">用哪家${info("脚本内置十几家（DeepSeek / OpenAI / Claude / Gemini / Kimi / 智谱 / 通义 / 火山 / 硅基流动 / OpenRouter / 本机 Ollama…）。\n选中哪家，「接口地址」和「协议」会自动跟着变；每家各自的 Key、地址、模型都会单独记着，切回来还在。\n自建网关选「自定义」。")}</div>
      <select id="yzj-prov" style="width:100%;padding:6px 8px;border:1px solid #d7dbe0;border-radius:7px;margin:4px 0 10px">
        ${AI_PROVIDERS.map((p) => `<option value="${p.id}" ${p.id === CFG.provider ? "selected" : ""}>${esc(p.name)}${p.noKey ? "（不用 Key）" : ""}</option>`).join("")}
      </select>
      <div class="yzj-tip" id="yzj-provnote" style="margin:-4px 0 8px"></div>
      <div class="yzj-field">API Key <span id="yzj-keylink"></span>${info("只保存在你这台浏览器里（Tampermonkey 存储），除了发给上面这个接口地址，不会发到别处。\n换服务商 = 换一把对应家的 Key，脚本会分别记着。")}</div>
      <input id="yzj-key" type="password" value="${CFG.apiKey}">
      <div class="yzj-field">协议${info("「说话方式」。OpenAI 兼容（绝大多数国产站、聚合站、自建网关）/ Anthropic Claude / Google Gemini。\n选好服务商后一般不用动它——只有自定义网关才需要手动挑。")}</div>
      <select id="yzj-proto" style="width:100%;padding:6px 8px;border:1px solid #d7dbe0;border-radius:7px;margin:4px 0 10px">
        ${AI_PROTOCOLS.map((k) => `<option value="${k}" ${k === CFG.proto ? "selected" : ""}>${PROTO_LABEL[k]}</option>`).join("")}
      </select>
      <div class="yzj-field">接口地址（base_url）${info("不要带 /chat/completions 或 /messages，填到版本号那一层就行，例如 https://api.openai.com/v1。")}</div>
      <input id="yzj-base" value="${CFG.baseUrl}">
      <div class="yzj-field">模型${info("文字版试卷用它。不确定填什么就点右边的「检测模型」——脚本会拿你这个 Key 去问服务商「你有哪些模型」，列出来给你挑。")}</div>
      <div style="display:flex;gap:6px;align-items:center">
        <input id="yzj-model" value="${CFG.model}" style="flex:1">
        <span class="yzj-btn gray" data-a="models" style="white-space:nowrap">检测模型</span>
      </div>
      <div class="yzj-field">图片模型（可留空）${info("图片版试卷（整页拍下来那种）要用能看图的模型。留空 = 和上面的模型用同一个。\n例如智谱文字用 glm-4.6、图片填 glm-4.6v；通义文字 qwen3-max、图片 qwen3-vl-plus。\n选了不能看图的模型，图片题会判不出来。")}</div>
      <input id="yzj-modelvision" value="${CFG.modelVision}" placeholder="留空 = 与上面同一个">
      <div id="yzj-models" style="display:none;border:1px solid #e3e8ef;border-radius:8px;padding:8px;margin:2px 0 10px">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
          <input id="yzj-modelfilter" placeholder="过滤模型名…" style="flex:1;margin:0">
          <span class="yzj-btn gray" data-a="testconn" style="white-space:nowrap">测一下通不通</span>
        </div>
        <div id="yzj-modelstat" class="yzj-tip" style="margin-bottom:6px"></div>
        <div id="yzj-modellist" style="max-height:210px;overflow:auto;background:#fafbfc;border-radius:6px;padding:4px"></div>
      </div>

      <div class="yzj-sec">显示 / 静默</div>
      <div class="yzj-check-row">
        <label class="yzj-check"><input id="yzj-silent" type="checkbox" ${CFG.silent ? "checked" : ""}><span>静默模式</span></label>
        ${info("勾上（默认）：批量/无人值守只在右下角滚动日志，不打扰你。\n取消勾选：每套题都弹出答案预览（前端实时渲染），无人值守时会在 5 秒后自动继续，你也可以随时点「取消并停止」。")}
      </div>

      <div class="yzj-sec">交卷行为</div>
      <div class="yzj-grid">
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-auto" type="checkbox" ${CFG.autoFinalize ? "checked" : ""}><span>写入后自动交卷</span></label>${info("点任务上的「AI 自动作答」时，写完答案直接交卷；不勾只填答案，交卷你自己来。")}</div>
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-tokens" type="checkbox" ${CFG.showTokens ? "checked" : ""}><span>显示 token 用量</span></label>${info("每次判题后显示这次用了多少 token，并在设置里累计，方便你估算花了多少钱。")}</div>
        <div id="yzj-finbox" style="display:none;grid-column:1/-1;border-left:3px solid #e3e8ef;padding-left:10px;margin:2px 0 4px">
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-confirm" type="checkbox" ${CFG.confirmBeforeFinalize ? "checked" : ""}><span>交卷前再确认一次</span></label>${info("交卷前弹窗告诉你「服务器上已作答 N/N 题」，点确认才提交。无人值守模式下会自动忽略这个确认。")}</div>
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-score" type="checkbox" ${CFG.readScoreAfterFinalize ? "checked" : ""}><span>交卷后读回成绩</span></label>${info("交卷成功后自动查询分数并弹提示（例如：得分 100 分（10/10 题正确））。")}</div>
        </div>
      </div>

      <div class="yzj-sec">判题</div>
      <div class="yzj-field">每批题数（大卷子分批问，避免被截断）${info("一次让模型回答多少题。题多的卷子（比如 49 题的课堂测验）会按这个数分批，默认 10。设小更稳但调用次数变多，设大更快但可能被截断。")}</div>
      <input id="yzj-batch" value="${CFG.batchSize}">
      <div class="yzj-check-row" style="margin-bottom:6px">
        <label class="yzj-check"><input id="yzj-noreason" type="checkbox" ${CFG.noReason ? "checked" : ""}><span>不要理由（更省更快）</span></label>
        ${info("勾上：让模型只返回字母、不返回解释，输出更短、更不容易被截断，也更省 token。调试期建议不勾，能看理由。")}
      </div>
      <div class="yzj-field">单次输出上限 max_tokens${info("判题时的上限。脚本按「max(2000, 本批题数×300)」起跳，遇到截断自动 ×3 重试，最高不超过这里填的数（默认 16000）。\n实测：1 题多选在 800 时会被模型思考吃满而失败，4000 才够。")}</div>
      <input id="yzj-maxtok" value="${CFG.maxTokensCap}">
      <div class="yzj-field">思考强度（只有 DeepSeek 认这个参数）${info("high（默认）：想得久、更准；low：推理 token 约减半（实测 1661 → 897），遇到截断时脚本会自动降到 low 重试；max：最贵最慢。\n换成别家（Claude / Gemini / 通义 / 智谱…）时这一项会被自动忽略，不会报错。")}</div>
      <select id="yzj-effort" style="width:100%;padding:6px 8px;border:1px solid #d7dbe0;border-radius:7px;margin:4px 0 10px">
        <option value="high">high（默认）</option>
        <option value="low">low（省 token）</option>
        <option value="max">max（最贵）</option>
      </select>

      <div class="yzj-sec">低置信度与超时</div>
      <div class="yzj-field">低置信度提醒阈值（0~1）${info("模型自评置信度低于这个值的题，会在答案预览里标黄并列出题号，提醒你人工看一眼。填 0.7 表示「低于 70% 就提醒」。")}</div>
      <input id="yzj-conf" value="${CFG.lowConfidence}">
      <div id="yzj-confbox" style="display:none;border-left:3px solid #e3e8ef;padding-left:10px;margin:2px 0 4px">
      <div class="yzj-check-row" style="margin-bottom:6px">
        <label class="yzj-check"><input id="yzj-confstrict" type="checkbox" ${CFG.lowConfStrict ? "checked" : ""}><span>低置信度时暂停，等我确认</span></label>
        ${info("勾上：只要有一套题里出现低于阈值的题，脚本就停下来弹预览等你点（无人值守也会暂停）。不勾：只标黄提示，照常自动继续。")}
      </div>
      </div>
      <div class="yzj-field">请求超时（秒）${info("单次调用 AI 的最长等待时间，超过就自动中止并提示（不会一直卡着）。网络慢可以调到 180。")}</div>
      <input id="yzj-timeout" value="${CFG.timeoutSec}">

      <div class="yzj-sec">跳过规则（默认开启）</div>
      <div class="yzj-check-row">
        <label class="yzj-check"><input id="yzj-skipen" type="checkbox" ${CFG.skipEnabled ? "checked" : ""}><span>命中规则的题目整套跳过</span></label>
        ${info("命中后：不调用 AI、不写答案、不交卷、不计失败，日志里记为「跳过」。\n默认规则主要拦老师布置的开放题/上传题（如「本节课你学会了什么」「请将练习作业拍照上传」），避免 AI 瞎答。\n说明：作业/练习里的简答题（主观题）会作答并提交（站点没有「只保存不提交」的接口）；连线题也支持；代码题/排序题仍然整套跳过。")}
      </div>
      <div id="yzj-skipbox" style="display:none;border-left:3px solid #e3e8ef;padding-left:10px;margin:2px 0 4px">
      <div class="yzj-field">规则（一行一条）${info("默认按关键词匹配（忽略大小写与空格），题干或选项里出现就算命中。\n想用正则就写成 /关键词1|关键词2/ 这样一行。\n改完点下面的「保存」生效；「恢复默认」会立刻把内置规则写回。")}</div>
      <textarea id="yzj-skiprules" rows="7" spellcheck="false"
        style="width:100%;padding:6px 8px;border:1px solid #d7dbe0;border-radius:7px;font:12px/1.6 Consolas,monospace;box-sizing:border-box"></textarea>
      <div style="margin:2px 0 8px;display:flex;align-items:center;gap:6px">
        <span class="yzj-btn gray" data-a="skipreset">恢复默认</span>
        <span class="yzj-btn gray" data-a="skipmerge">追加新默认规则</span>
        <span class="yzj-tip" id="yzj-skipver"></span>
      </div>
      </div>

      <div class="yzj-sec">延迟提交</div>
      <div class="yzj-check-row">
        <label class="yzj-check"><input id="yzj-delay" type="checkbox" ${CFG.delayEnabled ? "checked" : ""}><span>启用延迟提交</span></label>
        ${info("让「做完就交」变成「做完隔一会儿再交」，几套之间也随机间隔开，避免所有卷子集中在几分钟内全部交完。\n勾上后下面会展开更细的时间设置；取消勾选则收起并恢复「写完立刻交卷」。")}
      </div>
      <div id="yzj-delaybox" style="display:none;border-left:3px solid #e3e8ef;padding-left:10px;margin:2px 0 4px">
        <div class="yzj-check-row">
          <label class="yzj-check"><input id="yzj-dq" type="checkbox" ${CFG.delayPerQuestion ? "checked" : ""}><span>逐题之间加停顿</span></label>
          ${info("写入答案时，每道题之间随机停一会儿，模拟人答题的节奏（站点会记录作答时间）。不勾则一次性快速写完。")}
        </div>
        <div class="yzj-field">每道题停顿（秒）${info("例如 4 至 12，表示每写一题随机停 4~12 秒。10 题大约多花 1~2 分钟。")}</div>
        <input id="yzj-dqmin" value="${CFG.delayQuestionMin}" style="width:80px;display:inline-block">
        <span style="margin:0 6px">至</span>
        <input id="yzj-dqmax" value="${CFG.delayQuestionMax}" style="width:80px;display:inline-block">
        <div class="yzj-field">写完到交卷（分钟）${info("写完答案后随机等这么久才交卷，例如 2 至 6。交卷会进入队列，关掉页面也没关系，下次打开 csgmooc 自动补交。")}</div>
        <input id="yzj-dsm" value="${CFG.delaySubmitMin}" style="width:80px;display:inline-block">
        <span style="margin:0 6px">至</span>
        <input id="yzj-dsx" value="${CFG.delaySubmitMax}" style="width:80px;display:inline-block">
        <div class="yzj-field">两套之间（分钟）${info("做完一套到开始下一套的随机间隔，例如 3 至 12。填 0 至 0 表示不间隔。")}</div>
        <input id="yzj-dbm" value="${CFG.delayBetweenMin}" style="width:80px;display:inline-block">
        <span style="margin:0 6px">至</span>
        <input id="yzj-dbx" value="${CFG.delayBetweenMax}" style="width:80px;display:inline-block">
      </div>
      <div class="yzj-sec">题库（本地答案库）</div>
      <div class="yzj-grid">
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-usebank" type="checkbox" ${CFG.useBank ? "checked" : ""}><span>优先查题库</span></label>${info("做过的题（或同一个班同一份卷子）会存进本地题库。命中就直接作答，不再调用 AI——又快又省。\n文字版按「题干+选项」匹配（换班级、换账号都能命中）；图片版按「图片哈希+题号」匹配。")}</div>
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-banklearn" type="checkbox" ${CFG.bankLearn ? "checked" : ""}><span>交卷后自动学习</span></label>${info("交卷出成绩后，把「官方判定答对」的题写进题库；判错的从题库剔除（防止题库被污染）。")}</div>
      </div>
      <div class="yzj-tip">当前题库：<span id="yzj-bankstat">${bankStats().total}</span> 条</div>


      <div class="yzj-sec">无人值守</div>
      <div class="yzj-grid">
        <div class="yzj-check-row" style="flex-wrap:wrap"><label class="yzj-check"><input id="yzj-ua" type="checkbox" ${CFG.unattended ? "checked" : ""}><span style="white-space:nowrap">打开任务页自动开始</span></label><span id="yzj-ualbl" class="yzj-tip" style="white-space:nowrap"></span>${info("只要打开「我的任务」页面就自动开跑：找出没做完的任务，逐个判题、写答案、交卷，直到做完。\n旁边显示的是「单次最多处理任务数」（默认 20），展开后可改。")}</div>
      </div>
      <div id="yzj-uabox" style="display:none;border-left:3px solid #e3e8ef;padding-left:10px;margin:2px 0 4px">
      <div class="yzj-field">单次最多处理任务数${info("一次无人值守最多做多少套题，防止意外跑太多，默认 20。\n改完点「保存」；这个值也会显示在上面的开关标题里。")}</div>
      <input id="yzj-uamax" value="${CFG.uaMaxTasks}">
      <div class="yzj-grid">
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-uafin" type="checkbox" ${CFG.uaFinalize ? "checked" : ""}><span>自动交卷</span></label>${info("无人值守时是否自动交卷。关掉的话只写答案，交卷由你自己来。")}</div>
        <div class="yzj-check-row"><label class="yzj-check"><input id="yzj-uasj" type="checkbox" ${CFG.uaSkipAnswered ? "checked" : ""}><span>已答满的不重判</span></label>${info("之前已经写满答案的题，直接跳过判题去交卷，省 AI 调用费。")}</div>
      </div>
      <div class="yzj-field">每题重试次数${info("某套题失败（网络错、模型返回不合格等）重试几次后跳过，默认 2 次。")}</div>
      <input id="yzj-uaretry" value="${CFG.uaRetry}">
      <div class="yzj-field">只处理包含这些关键词的任务（范围锁）${info("留空 = 不限制。填多个用「|」或空格隔开，例如：阅读理解|完型。只有名称或训练里包含这些词的任务才会被处理，防止误跑其他课程。")}</div>
      <input id="yzj-uaonly" placeholder="例如：阅读理解|完型" value="${CFG.uaOnly}">
      </div>
      <div class="yzj-tip" style="margin-top:6px">Key 只保存在本机浏览器里（Tampermonkey 存储），不会发给除该接口以外的任何地方。
      累计用量：<span id="yzj-usage">${GM_getValue("tokenTotal", 0)}</span> tokens</div>
      <div id="yzj-foot" style="position:sticky;bottom:-16px;z-index:2;background:#fff;border-top:1px solid #eef1f5;margin-top:12px;padding:8px 0 4px;text-align:right">
        <span class="yzj-btn gray" data-a="cancel">取消</span>
        <span class="yzj-btn" data-a="save">保存</span></div>
    </div>`;
    document.body.appendChild(mask);
    attachTooltips(mask);

    // ------------------------------------------------ v1.6.1 分区跳转 + 上限回显
    // 设置项越加越多（手机上要滚两三屏），顶部放一排分区按钮，点哪去哪。
    const dlgEl = mask.querySelector(".yzj-dialog");
    const secEls = [...dlgEl.querySelectorAll(".yzj-sec")];
    if (secEls.length > 3) {
      const nav = document.createElement("div");
      nav.className = "yzj-secnav";
      nav.style.cssText = "position:sticky;top:-1px;z-index:3;display:flex;gap:6px;overflow-x:auto;"
        + "-webkit-overflow-scrolling:touch;padding:6px 0;margin:-4px 0 6px;background:#fff;"
        + "border-bottom:1px solid #eef1f5";
      secEls.forEach((sec, i) => {
        if (!sec.id) sec.id = "yzj-sec-" + i;
        sec.style.scrollMarginTop = "46px";        // 别被粘住的导航条盖住
        const chip = document.createElement("span");
        chip.className = "yzj-btn gray";
        chip.style.cssText = "flex:0 0 auto;padding:2px 9px;font-size:12px;white-space:nowrap";
        chip.textContent = sec.textContent.trim().split("（")[0].slice(0, 8);
        chip.onclick = () => sec.scrollIntoView({ block: "start", behavior: "smooth" });
        nav.appendChild(chip);
      });
      dlgEl.querySelector("h3").insertAdjacentElement("afterend", nav);
    }

    // 上限值直接写在开关标题上：哪怕折叠着，也能一眼看到"现在是几套"
    const uaMaxEl = mask.querySelector("#yzj-uamax");
    const uaLblEl = mask.querySelector("#yzj-ualbl");
    const syncUaLbl = () => {
      if (!uaMaxEl || !uaLblEl) return;
      const n = Number(uaMaxEl.value);
      const shown = Number.isFinite(n) && n >= 1 ? Math.min(100, Math.round(n)) : 20;
      uaLblEl.textContent = "上限 " + shown + " 套";
    };
    if (uaMaxEl) { uaMaxEl.addEventListener("input", syncUaLbl); syncUaLbl(); }

    // ------------------------------------------------ v1.6.0 服务商 / 模型检测
    const q1 = (sel) => mask.querySelector(sel);
    const provSel = q1("#yzj-prov"), protoSel = q1("#yzj-proto"), baseIn = q1("#yzj-base"),
          keyIn = q1("#yzj-key"), modelIn = q1("#yzj-model"), visionIn = q1("#yzj-modelvision"),
          provNote = q1("#yzj-provnote"), keyLink = q1("#yzj-keylink"),
          modelsBox = q1("#yzj-models"), modelStat = q1("#yzj-modelstat"),
          modelList = q1("#yzj-modellist"), modelFilter = q1("#yzj-modelfilter");
    let prevProv = provSel.value;          // 用来判断"你刚要离开的是哪一家"
    let lastModels = [];                   // 上次检测回来的模型清单

    function readSlot(id) { return GM_getValue("slot_" + id, null) || {}; }
    function writeSlot(id, obj) { GM_setValue("slot_" + id, obj); }

    /** 把「这家上次用的」搬进输入框；没有就用该服务商的默认值 */
    function fillForProvider(id, { keepTyped = false } = {}) {
      const p = providerById(id) || AI_PROVIDERS[0];
      provNote.textContent = p.note || (p.base ? "默认接口地址：" + p.base : "");
      keyLink.innerHTML = p.keyUrl
        ? `（<a href="${p.keyUrl}" target="_blank" rel="noreferrer" style="color:#1f6feb">去申请</a>）` : "";
      protoSel.value = p.proto;
      const slot = readSlot(p.id);
      baseIn.value = slot.base || p.base || (keepTyped ? baseIn.value : "");
      keyIn.value = slot.key != null ? slot.key : (keepTyped ? keyIn.value : "");
      modelIn.value = slot.model || (p.models && p.models[0]) || (keepTyped ? modelIn.value : "");
      visionIn.value = slot.modelVision != null ? slot.modelVision : "";
      modelIn.placeholder = (p.models && p.models.length) ? "例如：" + p.models[0] : "填该服务商的模型名";
      modelsBox.style.display = "none";
      modelStat.textContent = "";
      modelList.innerHTML = "";
    }

    provSel.addEventListener("change", () => {
      // 离开前先把这家填过的东西存下来（key 只在本地，存的还是本地存储）
      writeSlot(prevProv, { key: keyIn.value.trim(), base: baseIn.value.trim(),
                            model: modelIn.value.trim(), modelVision: visionIn.value.trim() });
      prevProv = provSel.value;
      fillForProvider(prevProv);
      const p = providerById(prevProv) || {};
      toast(p.noKey ? `${p.name}：本地服务不用填 Key，记得把接口地址改成你的端口` : `已切到 ${p.name}`, 4000);
    });

    function renderModels() {
      const q = String(modelFilter.value || "").trim().toLowerCase();
      const hit = lastModels.filter((m) => !q || String(m.id).toLowerCase().includes(q));
      const shown = hit.slice(0, 300);
      modelStat.textContent = lastModels.length
        ? `共 ${lastModels.length} 个，显示 ${shown.length} 个（服务商标了能看图的排前面、带 🖼）｜点一下填进「模型」框`
        : "这家没返回任何模型（有的站不做 /models）。直接手填模型名也一样能用。";
      modelList.innerHTML = shown.map((m, i) => `<div data-i="${i}" class="yzj-mrow"
        style="padding:4px 6px;border-radius:5px;cursor:pointer;font-size:12px;display:flex;gap:6px;align-items:baseline">
        <span style="flex:1;word-break:break-all">${esc(m.id)}</span>
        ${m.vision === "yes" ? '<span title="服务商标了它能看图" style="flex:0 0 auto">🖼</span>' : ""}
        ${m.note ? `<span class="yzj-tip" style="flex:0 0 auto">${esc(m.note)}</span>` : ""}
      </div>`).join("");
      modelList.querySelectorAll(".yzj-mrow").forEach((row) => {
        row.onmouseenter = () => { row.style.background = "#eef4fb"; };
        row.onmouseleave = () => { row.style.background = ""; };
        row.onclick = () => {
          const m = shown[Number(row.dataset.i)];
          if (!m) return;
          modelIn.value = m.id;
          if (m.vision === "yes" && !visionIn.value.trim()) visionIn.value = m.id;   // 能看图就顺手当图片模型
          modelStat.textContent = `已选 ${m.id}${m.vision === "yes" ? "（能看图）" : ""}。记得点下面的「保存」。`;
        };
      });
    }
    modelFilter.addEventListener("input", renderModels);

    q1('[data-a="models"]').onclick = async () => {
      const prov = providerById(provSel.value) || {};
      const baseUrl = baseIn.value.trim(), apiKey = keyIn.value.trim(), proto = protoSel.value;
      if (!baseUrl) { toast("先把「接口地址」填上", 4000); return; }
      if (!apiKey && !prov.noKey) { toast("先填 API Key，再检测模型", 5000); return; }
      modelsBox.style.display = "block";
      modelStat.textContent = "正在问 " + baseUrl + " 要模型列表…";
      modelList.innerHTML = "";
      try {
        lastModels = await fetchModelList({ baseUrl, apiKey, proto });
        GM_setValue("modelCache", { base: baseUrl, proto, at: Date.now(), models: lastModels.slice(0, 400) });
        renderModels();
      } catch (e) {
        lastModels = [];
        modelStat.textContent = "没拉到列表：" + explainError(e)
          + "｜" + String((e && e.message) || e).slice(0, 140) + "（手动填模型名照样能用）";
      }
    };

    q1('[data-a="testconn"]').onclick = async () => {
      const baseUrl = baseIn.value.trim(), apiKey = keyIn.value.trim(), proto = protoSel.value;
      const model = modelIn.value.trim();
      if (!model) { toast("先填模型名，再测", 4000); return; }
      modelStat.textContent = `正在发一条最小请求测「${model}」…`;
      try {
        const r = await testAiConnection({ baseUrl, apiKey, proto, model });
        modelStat.textContent = `✅ ${model} 通了（${r.ms}ms，${r.tokens} tokens）：${(r.text || "(空回复)").slice(0, 40)}`;
      } catch (e) {
        modelStat.textContent = "❌ " + explainError(e)
          + "｜" + String((e && e.message) || e).slice(0, 140);
      }
    };

    // 打开时按当前服务商点亮说明/申请链接（输入框里的值就是模板渲染的当前值，不要动）
    const initProv = providerById(CFG.provider) || AI_PROVIDERS[0];
    provNote.textContent = initProv.note || (initProv.base ? "默认接口地址：" + initProv.base : "");
    keyLink.innerHTML = initProv.keyUrl
      ? `（<a href="${initProv.keyUrl}" target="_blank" rel="noreferrer" style="color:#1f6feb">去申请</a>）` : "";
    modelIn.placeholder = (initProv.models && initProv.models.length)
      ? "例如：" + initProv.models[0] : "填该服务商的模型名";

    // v1.4.8：统一「总开关 → 子设置」折叠。开关关掉时下面那些设置本来就不生效，
    // 收起来免得你以为它们还在起作用；值照读照存，重新打开就回来了。
    const chk = (sel) => { const el = mask.querySelector(sel); return !!(el && el.checked); };
    const fold = (boxSel, masterSels, test) => {
      const box = mask.querySelector(boxSel);
      const masters = masterSels.map((sel) => mask.querySelector(sel)).filter(Boolean);
      if (!box || !masters.length) return;
      const sync = () => { box.style.display = test() ? "block" : "none"; };
      masters.forEach((m) => { m.addEventListener("change", sync); m.addEventListener("input", sync); });
      sync();
    };
    fold("#yzj-delaybox", ["#yzj-delay"], () => chk("#yzj-delay"));               // 延迟提交
    fold("#yzj-uabox", ["#yzj-ua"], () => chk("#yzj-ua"));                        // 无人值守
    fold("#yzj-skipbox", ["#yzj-skipen"], () => chk("#yzj-skipen"));              // 跳过规则
    // 低置信度阈值填 0 就等于没设阈值（没有题会低于 0），"暂停等我确认"自然永远触发不了
    const confBox = () => {
      const el = mask.querySelector("#yzj-conf");
      const n = parseFloat(el ? el.value : "0");
      return Number.isFinite(n) && n > 0;
    };
    fold("#yzj-confbox", ["#yzj-conf"], confBox);
    // 交卷前确认 / 交卷后读成绩：只有"真的会自动交卷"时才有意义（可能是手动一轮，也可能是无人值守）
    fold("#yzj-finbox", ["#yzj-auto", "#yzj-ua", "#yzj-uafin"],
      () => chk("#yzj-auto") || (chk("#yzj-ua") && chk("#yzj-uafin")));
    // v1.4.0 跳过规则：文本域 + 「恢复默认 / 追加新默认规则」
    const skipTa = mask.querySelector("#yzj-skiprules");
    const skipVer = mask.querySelector("#yzj-skipver");
    const effortSel = mask.querySelector("#yzj-effort");
    if (effortSel) effortSel.value = CFG.reasoningEffort;
    const syncSkipVer = () => {
      if (!skipVer) return;
      const hasNew = CFG.skipRulesVersion < SKIP_RULES_VERSION;
      skipVer.textContent = `内置默认 v${SKIP_RULES_VERSION}｜当前 ${CFG.skipRules.length} 条`
        + (hasNew ? "（有新版可追加）" : "");
    };
    if (skipTa) { skipTa.value = rulesToText(CFG.skipRules); syncSkipVer(); }
    const skipReset = mask.querySelector('[data-a="skipreset"]');
    if (skipReset) skipReset.onclick = () => {
      saveSkipRules(DEFAULT_SKIP_RULES.slice());
      saveSkipRulesVersion(SKIP_RULES_VERSION);
      if (skipTa) skipTa.value = rulesToText(DEFAULT_SKIP_RULES);
      syncSkipVer();
      toast(`已恢复默认跳过规则（${DEFAULT_SKIP_RULES.length} 条）`, 5000);
    };
    const skipMerge = mask.querySelector('[data-a="skipmerge"]');
    if (skipMerge) skipMerge.onclick = () => {
      if (skipTa) saveSkipRules(parseRuleLines(skipTa.value));   // 先把用户当前编辑存下，再追加
      const n = mergeDefaultSkipRules();
      if (skipTa) skipTa.value = rulesToText(ensureSkipRules());
      syncSkipVer();
      toast(n ? `已追加 ${n} 条新默认规则` : "已经是最新的默认规则了", 5000);
    };
    mask.querySelector('[data-a="cancel"]').onclick = () => mask.remove();
    mask.querySelector('[data-a="save"]').onclick = () => {
      GM_setValue("apiKey", mask.querySelector("#yzj-key").value.trim());
      GM_setValue("baseUrl", mask.querySelector("#yzj-base").value.trim().replace(/\/+$/, ""));
      GM_setValue("model", mask.querySelector("#yzj-model").value.trim());
      // v1.6.0：多服务商 —— 当前生效的这套值 + 按服务商各存一份，切回来还在
      const curProv = mask.querySelector("#yzj-prov").value;
      const curProto = mask.querySelector("#yzj-proto").value;
      const curVision = mask.querySelector("#yzj-modelvision").value.trim();
      GM_setValue("provider", curProv);
      GM_setValue("proto", AI_PROTOCOLS.includes(curProto) ? curProto : "openai");
      GM_setValue("modelVision", curVision);
      writeSlot(curProv, { key: mask.querySelector("#yzj-key").value.trim(),
                           base: mask.querySelector("#yzj-base").value.trim().replace(/\/+$/, ""),
                           model: mask.querySelector("#yzj-model").value.trim(), modelVision: curVision });
      GM_setValue("autoFinalize", mask.querySelector("#yzj-auto").checked);
      GM_setValue("confirmBeforeFinalize", mask.querySelector("#yzj-confirm").checked);
      GM_setValue("readScoreAfterFinalize", mask.querySelector("#yzj-score").checked);
      GM_setValue("showTokens", mask.querySelector("#yzj-tokens").checked);
      GM_setValue("silent", mask.querySelector("#yzj-silent").checked);
      GM_setValue("lowConfStrict", mask.querySelector("#yzj-confstrict").checked);
      GM_setValue("uaOnly", mask.querySelector("#yzj-uaonly").value.trim());
      const lc = Number(mask.querySelector("#yzj-conf").value);
      GM_setValue("lowConfidence", Number.isFinite(lc) ? Math.min(1, Math.max(0, lc)) : 0.7);
      const to = Number(mask.querySelector("#yzj-timeout").value);
      GM_setValue("timeoutSec", Number.isFinite(to) && to >= 10 ? Math.min(600, to) : 90);
      GM_setValue("unattended", mask.querySelector("#yzj-ua").checked);
      GM_setValue("uaFinalize", mask.querySelector("#yzj-uafin").checked);
      GM_setValue("uaSkipAnswered", mask.querySelector("#yzj-uasj").checked);
      const ur = Number(mask.querySelector("#yzj-uaretry").value);
      GM_setValue("uaRetry", Number.isFinite(ur) && ur >= 1 ? Math.min(5, ur) : 2);
      const um = Number(mask.querySelector("#yzj-uamax").value);
      GM_setValue("uaMaxTasks", Number.isFinite(um) && um >= 1 ? Math.min(100, um) : 20);
      // 分批 + 延迟提交
      const bs = Number(mask.querySelector("#yzj-batch").value);
      GM_setValue("batchSize", Number.isFinite(bs) && bs >= 1 ? Math.min(50, bs) : 10);
      GM_setValue("noReason", mask.querySelector("#yzj-noreason").checked);
      // v1.4.0：跳过规则 + 答题预算
      GM_setValue("skipEnabled", mask.querySelector("#yzj-skipen").checked);
      saveSkipRules(parseRuleLines(mask.querySelector("#yzj-skiprules").value));
      const capN = Number(mask.querySelector("#yzj-maxtok").value);
      GM_setValue("maxTokensCap", Number.isFinite(capN) && capN >= 2000 ? Math.min(200000, Math.round(capN)) : 16000);
      const eff = String(mask.querySelector("#yzj-effort").value || "high");
      GM_setValue("reasoningEffort", ["low", "high", "max"].includes(eff) ? eff : "high");
      GM_setValue("useBank", mask.querySelector("#yzj-usebank").checked);
      GM_setValue("bankLearn", mask.querySelector("#yzj-banklearn").checked);
      GM_setValue("delayEnabled", mask.querySelector("#yzj-delay").checked);
      GM_setValue("delayPerQuestion", mask.querySelector("#yzj-dq").checked);
      const norm = (v, dflt, lo, hi) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
      };
      const dsMin = norm(mask.querySelector("#yzj-dsm").value, 2, 0, 600);
      const dsMax = norm(mask.querySelector("#yzj-dsx").value, 6, 0, 600);
      GM_setValue("delaySubmitMin", Math.min(dsMin, dsMax));
      GM_setValue("delaySubmitMax", Math.max(dsMin, dsMax));
      const dbMin = norm(mask.querySelector("#yzj-dbm").value, 3, 0, 600);
      const dbMax = norm(mask.querySelector("#yzj-dbx").value, 12, 0, 600);
      GM_setValue("delayBetweenMin", Math.min(dbMin, dbMax));
      GM_setValue("delayBetweenMax", Math.max(dbMin, dbMax));
      const dqMin = norm(mask.querySelector("#yzj-dqmin").value, 4, 0, 600);
      const dqMax = norm(mask.querySelector("#yzj-dqmax").value, 12, 0, 600);
      GM_setValue("delayQuestionMin", Math.min(dqMin, dqMax));
      GM_setValue("delayQuestionMax", Math.max(dqMin, dqMax));
      mask.remove();
      say("设置已保存。");
      refreshSetupHint();
      updateLauncher();
    };
  }

  // ------------------------------------------------------------------ 悬浮入口（右下角，一直在）
  function launcherEl() { return document.querySelector(".yzj-launcher"); }

  function updateLauncher() {
    const b = launcherEl();
    if (!b) return;
    b.textContent = aiReady() ? "AI 易智教助手" : "AI 易智教助手（未设置）";
    b.style.background = aiReady() ? "#1f6feb" : "#d97706";
  }

  function showLauncher() {
    if (launcherEl()) { updateLauncher(); return; }
    if (!document.body) return;          // body 还没就绪就等下次（boot 在 DOMContentLoaded 后也会补）
    const b = document.createElement("div");
    b.className = "yzj-launcher";
    b.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#1f6feb;color:#fff;"
      + "padding:10px 14px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;"
      + "font:13px/1.2 'Microsoft YaHei',system-ui,sans-serif;user-select:none";
    b.onclick = () => {
      const p = ensurePanel();
      p.style.display = "";
      if (!aiReady()) openSettings();    // 没填 key 就直接弹设置，省得找不到
    };
    document.body.appendChild(b);
    updateLauncher();
  }

  // ------------------------------------------------------------------ AI 判题
  function stripHtml(html) {
    return String(html || "")
      .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, " ").trim();
  }

  /** 站点单题 → 内部结构（blanks：填空题一个 optionJson 就是一个空） */
  function mapQuestion(q) {
    const opts = q.optionJsons || [];
    // 连线题：optionJsons = 左侧（number 是数字）+ 右侧（number 是字母）
    const left = opts.filter((o) => !Number.isNaN(Number(String(o.number).trim())))
      .map((o) => ({ no: String(o.number).trim(), text: stripHtml(o.option) }))
      .sort((a, b) => Number(a.no) - Number(b.no));
    const right = opts.filter((o) => Number.isNaN(Number(String(o.number).trim())))
      .map((o) => ({ key: String(o.number).trim().toUpperCase(), text: stripHtml(o.option) }));
    return {
      id: q.sqid,
      type: Number(q.q_type),
      typeName: Q_TYPE_NAME[Number(q.q_type)] || `未知(${q.q_type})`,
      desc: stripHtml(q.q_desc),
      options: opts.map((o) => ({ letter: String(o.number || "").toUpperCase(), text: stripHtml(o.option) })),
      blanks: opts.length,
      left, right,
    };
  }

  /** 整套题目（未排序、未过滤）：题型判定 / 跳过规则都要用它 */
  async function fetchPaperQuestions(info) {
    const sum = await api(`student/testvalidatedetail/v2/getquestionsum?tmid=${info.tmid}&scid=${info.tcid}`);
    const list = [];
    for (const group of ((sum.data || {}).questionList || [])) {
      for (const q of (group.questions || [])) list.push(mapQuestion(q));
    }
    return list;
  }

  /**
   * 作业（getHomeWork）→ 内部结构（v1.4.1）
   * 作业只有一道"大题"：q_type=4 时是富文本正文，0/1/2/3 时 optionList 就是选项/空位。
   */
  function mapHomework(d) {
    const list = d.optionList || [];
    return {
      id: d.tqid || null,
      type: Number(d.q_type),
      typeName: Q_TYPE_NAME[Number(d.q_type)] || `未知(${d.q_type})`,
      desc: stripHtml(d.h_desc),
      options: list.map((o) => ({
        letter: String(o.opNumber || o.number || "").toUpperCase(),
        text: stripHtml(o.option || o.description || o.op_desc || ""),
      })),
      blanks: list.length,
      prompt: stripHtml(d.h_prompt || ""),
      homework: true,
    };
  }

  /** 文字版试卷：从站点接口取题干与选项（图片版试卷这里会是空的，靠图片） */
  async function loadTextQuestions(info, questionIds) {
    const list = await fetchPaperQuestions(info);
    const pos = new Map(questionIds.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 9999) - (pos.has(b.id) ? pos.get(b.id) : 9999));
    return list;
  }

  /** 一道题的全部可见文本（用于跳过规则匹配） */
  function questionPlainText(q) {
    if (!q) return "";
    const opts = (q.options || []).map((o) => o.text).join(" ");
    return [q.desc, opts].filter(Boolean).join(" ");
  }

  /**
   * 这道题有没有「能发给模型的文字」。
   *
   * v1.6.2：以前只看题干（desc），结果连线题整卷被误判成"没题干"直接跳过——
   * 连线题的题干经常是空的，内容全在左右两侧选项里。所以题干、连线左右项、
   * 选项文字，任意一样有内容就算有文字。
   */
  function hasSendableText(q) {
    if (!q) return false;
    if (q.desc && String(q.desc).trim().length > 2) return true;
    if (Number(q.type) === Q_TYPE.LINE) {
      return (q.left || []).length > 0 && (q.right || []).length > 0;
    }
    // 单选/多选/判断：题干缺失但选项有实质文字时也能答（纯字母 A/B/C 不算）
    return (q.options || []).some((o) => o && String(o.text || "").trim().length > 1);
  }

  /** 本题的合法选项字母（如 ["A","B","C","D"]） */
  function optionLetters(q) {
    return (q && q.options ? q.options : [])
      .map((o) => String(o.letter || "").toUpperCase()).filter(Boolean);
  }

  /**
   * 按题型把模型输出归一化成能直接写进服务器的 answerStr（v1.4.0）：
   *   单选/判断 → 一个字母
   *   多选     → 全部正确选项字母、按选项顺序相连（站点口径：ABD，无分隔符）
   *   填空     → 各空用 #CSG# 连接（站点口径）
   * 不合法一律抛错：宁可不写，也不把错答案落库。
   */
  function normalizeAnswer(q, raw, no) {
    const tag = no ? `第${no}题` : "本题";
    const type = Number(q && q.type);
    const letters = optionLetters(q);
    const s = String(raw === undefined || raw === null ? "" : raw).trim();
    if (!s) throw new Error(`${tag}答案为空`);

    if (type === Q_TYPE.SINGLE || type === Q_TYPE.JUDGE) {
      // 只允许字母与分隔符：挡住把连线题那种「1C#2A」洗成「CA」的混淆
      const cleaned = s.replace(/[\s,，、;；/|]+/g, "");
      if (!/^[A-Za-z]+$/.test(cleaned)) {
        throw new Error(`${tag}（${Q_TYPE_NAME[type]}）答案里应只有选项字母，模型给了「${s.slice(0, 20)}」`);
      }
      const one = cleaned.toUpperCase();
      if (one.length !== 1) throw new Error(`${tag}（${Q_TYPE_NAME[type]}）应是 1 个字母，模型给了「${s.slice(0, 20)}」`);
      if (letters.length && !letters.includes(one)) throw new Error(`${tag}答案 ${one} 不在选项 ${letters.join("/")} 里`);
      return one;
    }
    if (type === Q_TYPE.MULTI) {
      // 同上：多选只吃「字母 + 分隔符」，不吃数字和 #
      const cleaned = s.replace(/[\s,，、;；/|]+/g, "");
      if (!/^[A-Za-z]+$/.test(cleaned)) {
        throw new Error(`${tag}（多选）答案里应只有选项字母（如 ABD），模型给了「${s.slice(0, 20)}」`);
      }
      const picked = [...new Set(cleaned.toUpperCase().split(""))].filter(Boolean);
      if (!picked.length) throw new Error(`${tag}（多选）没给出任何字母`);
      if (letters.length) {
        const bad = picked.filter((c) => !letters.includes(c));
        if (bad.length) throw new Error(`${tag}（多选）出现非法选项 ${bad.join("")}，本题只有 ${letters.join("/")}`);
        return letters.filter((c) => picked.includes(c)).join("");   // 按选项顺序相连
      }
      return picked.sort().join("");
    }
    if (type === Q_TYPE.BLANK) {
      const parts = s.split(BLANK_SEP).map((x) => x.trim());
      const n = Number(q.blanks) || 0;
      if (n && parts.length !== n) throw new Error(`${tag}（填空）有 ${n} 个空，模型给了 ${parts.length} 段`);
      if (parts.some((x) => !x)) throw new Error(`${tag}（填空）存在空答案`);
      return parts.join(BLANK_SEP);
    }
    if (type === Q_TYPE.LINE) {
      // 站点口径：左序号 + 右字母，用 # 连接（如 1A#2B#3C）；没配的项直接不出现
      const leftNos = (q.left || []).map((x) => String(x.no));
      const rightKeys = (q.right || []).map((x) => String(x.key).toUpperCase());
      const seen = {};
      const pairs = [];
      for (const seg of s.split("#").map((x) => x.trim()).filter(Boolean)) {
        if (!/^\d+\s*[-–—>→:：,，]*\s*[A-Za-z]+$/.test(seg)) {
          throw new Error(`${tag}（连线）有一项写成了「${seg.slice(0, 12)}」，应为「左序号+字母」`);
        }
        const no = (seg.match(/\d+/g) || []).join("");
        const letter = (seg.match(/[A-Za-z]+/g) || []).join("").toUpperCase();
        if (leftNos.length && !leftNos.includes(no)) throw new Error(`${tag}（连线）出现了不存在的左序号 ${no}`);
        if (rightKeys.length && !rightKeys.includes(letter)) throw new Error(`${tag}（连线）出现了不存在的右选项 ${letter}`);
        if (seen[no]) throw new Error(`${tag}（连线）左序号 ${no} 配了两次`);
        seen[no] = letter;
        pairs.push({ no: Number(no), letter });
      }
      if (leftNos.length && pairs.length !== leftNos.length) {
        throw new Error(`${tag}（连线）应配 ${leftNos.length} 对，模型给了 ${pairs.length} 对`);
      }
      pairs.sort((a, b) => a.no - b.no);
      return pairs.map((x) => `${x.no}${x.letter}`).join("#");
    }
    throw new Error(`${tag}是不支持的题型（${Q_TYPE_NAME[type] || type}）`);
  }

  /** 每种题型该怎么写 answer（写进提示词，避免多选只回一个字母） */
  function typeInstruction(q) {
    const type = Number(q && q.type);
    if (type === Q_TYPE.MULTI) {
      return "多选题：answer 必须是**全部**正确选项的字母，按选项顺序直接相连，不要空格、逗号或其它符号，例如 ABD";
    }
    if (type === Q_TYPE.JUDGE) {
      return "判断题：answer 是一个字母（以本题选项为准）";
    }
    if (type === Q_TYPE.BLANK) {
      return `填空题（共 ${Number(q.blanks) || 1} 个空）：answer 是各空答案按顺序用 ${BLANK_SEP} 连接，`
        + `例如 LISTEN${BLANK_SEP}ESTABLISHED；只有一个空时直接写答案文本`;
    }
    if (type === Q_TYPE.SUBJECTIVE) {
      return "简答题：answer 是一段中文作答内容（可用换行分段），先给结论再分点解释，"
        + "控制在 100~300 字；只写答案本身，不要写「答案：」这类前缀，也不要 Markdown 代码块";
    }
    if (type === Q_TYPE.LINE) {
      return "连线题：把左侧每一项配到正确的右侧选项上。answer 写成「左序号+右字母」的配对，"
        + "用 # 连接，例如 1C#2A#3G；左侧每个序号都必须且只能出现一次，字母必须来自右侧选项";
    }
    return "单选题：answer 是一个字母";
  }

  function buildTextPrompt(questions, taskName, opt = {}) {
    const offset = opt.offset || 0;
    const noReason = !!opt.noReason;
    const head = [
      "你是试卷判题程序。下面是试卷的文字版（题干 + 选项）。",
      `任务：${taskName || ""}`,
      "请为每一题给出答案，并只输出如下 json（不要任何其它文字、不要代码块）：",
      noReason ? `{"answers":[{"no":${offset + 1},"answer":"A"}]}`
               : `{"answers":[{"no":${offset + 1},"answer":"A","confidence":0.95,"why":"简短理由"}]}`,
      `要求：answers 长度为 ${questions.length}，no 必须是**全局题号**（本次从 ${offset + 1} 到 ${offset + questions.length}）；`,
      "answer 是字符串，写法**严格按每题下面标注的要求**（示例里的 A 只是占位）；拿不准也要给出你认为最可能的答案。",
      noReason ? "不要写 why，也不要写其它字段。" : "why 不超过 8 个字。",
      "",
    ];
    const body = questions.map((q, i) => {
      const opts = (q.options || []).map((o) => `${o.letter}. ${o.text}`).join("   ");
      // 连线题经常没有题干，别骗模型"题干见图片"——它会以为有图却看不到
      const stem = q.desc || (Number(q.type) === Q_TYPE.LINE
        ? "（没有题干，内容在下面的左右两列）" : "（题干见图片）");
      const lines = [`第${offset + i + 1}题【${Q_TYPE_NAME[Number(q.type)] || "未知"}】：${stem}`];
      if (Number(q.type) === Q_TYPE.LINE && (q.left || []).length && (q.right || []).length) {
        // 连线题：左右两侧分开列，避免模型把它们当成一堆选项
        lines.push(`    左侧：${q.left.map((x) => `${x.no}. ${x.text}`).join("   ")}`);
        lines.push(`    右侧：${q.right.map((x) => `${x.key}. ${x.text}`).join("   ")}`);
      } else if (opts) {
        lines.push(`    选项：${opts}`);
      }
      lines.push(`    要求：${typeInstruction(q)}`);
      return lines.join("\n");
    });
    return head.concat(body).join("\n");
  }

  function buildPrompt(count, taskName, opt = {}) {
    const offset = opt.offset || 0;
    const noReason = !!opt.noReason;
    return [
      "你是一个英语试卷判题程序。下面给你一张试卷图片（图片版试卷，题目和选项都在图里）。",
      "题号按空位在文章中出现的先后顺序编号（第 1 个空 = 第 1 题），**不要用图片上印的编号**。",
      `本次只需要回答第 ${offset + 1} 到第 ${offset + count} 个空（共 ${count} 个）。`,
      `任务：${taskName || ""}`,
      "请为每一题选出正确选项，并只输出如下 JSON（不要输出任何其它文字、不要用代码块）：",
      noReason ? `{"answers":[{"no":${offset + 1},"answer":"A"}]}`
               : `{"answers":[{"no":${offset + 1},"answer":"A","confidence":0.95,"why":"简短理由"}]}`,
      `要求：answers 长度为 ${count}，no 用全局题号（${offset + 1} 到 ${offset + count}），`
        + "answer 是 A~J 中的大写字母（图里通常只有 A~D）；若该题标准答案不止一个，"
        + "就把所有正确字母按顺序连在一起写，例如 ABD"
        + (noReason ? "；不要写 why。" : "；why 不超过 8 个字。"),
    ].join("\n");
  }

  function extractJson(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = t.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i += 1) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
  }

  const isDeepSeek = () => /deepseek/i.test(CFG.baseUrl);

  /**
   * 一次请求的 max_tokens（v1.4.0 阶梯，v1.4.5 调高起跳值）：
   * level 0 起跳 = max(6000, 本批题数 × 400)，每升一级 ×3，天花板 = 设置里的 maxTokensCap。
   *
   * 为什么起跳给这么大：max_tokens 只是上限，模型答完就停（finish=stop），**不会因为上限高就多花钱**；
   * 反过来起跳太低，推理模型会先把预算烧在思考上、正文被截断，这一发就白烧了。
   * 实测（2026-10-05，58 套作业：64 次请求 87k tokens）：起跳 2000 时有 8 次被截断，
   * 白烧 23k tokens（27%），升到 6000 才成功。
   */
  function budgetFor(count, noReason, level = 0, subject = false) {
    const base = Math.max(subject ? 8000 : 6000, Math.round((count || 1) * (noReason ? 300 : 400)));
    const cap = CFG.maxTokensCap;
    return Math.max(1000, Math.min(cap, Math.round(base * Math.pow(3, level))));
  }

  /** 一次请求。count=本批题数；offset=本批第一题在整卷里的序号（从 0 开始） */
  /** 这一次该用哪个模型：带图片就用「图片模型」（没填就还是主模型） */
  function modelForRequest(hasImages) {
    return (hasImages && CFG.modelVision) ? CFG.modelVision : CFG.model;
  }

  async function askOnce({ imageUrls = [], questions = null, count, taskName, noReason = false, offset = 0,
                          maxTokens = 0, effort = "" }) {
    const prov = providerById(CFG.provider);
    if (!CFG.apiKey && !(prov && prov.noKey)) throw new Error("还没填 API Key：点右上角「设置」");
    const proto = CFG.proto;
    const promptText = questions && questions.length
      ? buildTextPrompt(questions, taskName, { offset, noReason })
      : buildPrompt(count, taskName, { offset, noReason });
    const dataUrls = [];
    for (const url of imageUrls) dataUrls.push(await imageToDataUrl(url));
    const mt = maxTokens || budgetFor(count, noReason, 0);
    const useEffort = effort || CFG.reasoningEffort;
    // 图片版试卷优先用「图片模型」（没填就还是用主模型）
    const useModel = modelForRequest(dataUrls.length > 0);
    const payload = aiBody({
      proto, model: useModel,
      systemText: "你只输出一个 json 对象，不要解释、不要 Markdown 代码块。",
      parts: [{ text: promptText }].concat(dataUrls.map((u) => ({ image: u }))),
      // 动态长度 + 阶梯升档（S1 / v1.4.0）：推理模型会把预算吃在思考上，所以要给够
      maxTokens: mt, effort: useEffort,
    });
    const rangeText = count ? `第 ${offset + 1}–${offset + count} 题` : "";
    showProgress(`AI 判题中（${useModel}）${rangeText} … 最长 ${CFG.timeoutSec} 秒，可点取消`);
    let res;
    const t0 = performance.now();
    logLine("ai", `请求 ${useModel}（${(prov && prov.name) || CFG.provider}／${PROTO_LABEL[proto] || proto}）：`
      + `${dataUrls.length ? dataUrls.length + " 张图" : "文字"}，`
      + `${rangeText}（${count} 题，max_tokens=${payload.max_tokens}`
      + `${isDeepSeek() ? `，effort=${useEffort}` : ""}${noReason ? "，只要答案" : ""}），`
      + `prompt ${promptText.length} 字`);
    try {
      res = await gmRequest({
        method: "POST",
        url: aiUrl("chat", { proto, model: useModel }),
        headers: aiHeaders({ proto }),
        data: JSON.stringify(payload),
      });
    } catch (e) {
      if (/已取消/.test(String(e && e.message))) throw new CancelledError();
      throw e;
    } finally {
      hideProgress();
    }
    if (res.status !== 200) {
      logLine("error", `AI 接口 ${res.status}（${Math.round(performance.now() - t0)}ms）：${String(res.responseText).slice(0, 160)}`);
      throw new Error("接口返回 " + res.status + "：" + String(res.responseText).slice(0, 200));
    }
    logLine("ai", `返回 200（${Math.round(performance.now() - t0)}ms，${String(res.responseText).length}B）`);
    const body = JSON.parse(res.responseText);
    const usage = body.usage || {};
    lastUsage = aiUsageOf(body) || 0;
    if (lastUsage) {
      const total = Number(GM_getValue("tokenTotal", 0)) + Number(lastUsage);
      GM_setValue("tokenTotal", total);
      if (CFG.showTokens) say(`本次用量 ${lastUsage} tokens（累计 ${total}）`);
    }
    const finish = aiFinishOf(body, proto);
    if (finish === "length") {
      logLine("warn", `模型输出被 max_tokens=${payload.max_tokens} 截断（${rangeText}），将加大预算重试`);
      throw new Error("模型输出被截断（length）");
    }
    const text = aiTextOf(body, proto);
    const json = extractJson(text);
    if (!json || !Array.isArray(json.answers)) throw new Error("模型返回不是约定格式：" + String(text).slice(0, 200));
    return { answers: json.answers, usage, finish };
  }

  /** 判题（分批 + 三级降级）：返回按全局题号对齐的 answers 数组（元素含 no/letter/confidence/why） */
  /**
   * 分批判题。ranges 为空时处理 [0,count) 全部；
   * 传 ranges=[[a,b),…] 时只处理这些区间（题库命中的题就不用问了）。
   */
  async function askAI({ imageUrls = [], questions = null, count, taskName, ranges = null }) {
    const size = CFG.batchSize;
    const out = [];
    const failedRanges = [];      // v1.4.0：这些题号范围的模型没判出来（只跳过它们，不整卷失败）
    let lastErrAll = null;        // v1.4.9：跨批次记住最后一次真实错误，供上层写进"跳过理由"
    const plan = [];
    if (ranges && ranges.length) {
      for (const [ra, rb] of ranges) for (let f = ra; f < rb; f += size) plan.push([f, Math.min(rb, f + size)]);
    } else {
      for (let f = 0; f < count; f += size) plan.push([f, Math.min(count, f + size)]);
    }
    for (const [from, to] of plan) {
      const n = to - from;
      const sliceQs = questions ? questions.slice(from, to) : null;
      // 简答题要写正文，预算给足（v1.4.1）
      const isSubject = !!(sliceQs && sliceQs.some((q) => Number(q.type) === Q_TYPE.SUBJECTIVE));

      let got = null, lastErr = null;
      const attempts = [
        { label: "正常", level: 0, effort: CFG.reasoningEffort },
        { label: `加大预算(${budgetFor(n, CFG.noReason, 1, isSubject)})`, level: 1, effort: "low" },
        { label: `再加大预算(${budgetFor(n, CFG.noReason, 2, isSubject)})`, level: 2, effort: "low" },
      ];
      let fatalErr = null;
      for (let ai = 0; ai < attempts.length; ai += 1) {
        const att = attempts[ai];
        try {
          got = await askOnce({
            imageUrls, questions: sliceQs, count: n, taskName, noReason: CFG.noReason, offset: from,
            maxTokens: budgetFor(n, CFG.noReason, att.level, isSubject), effort: att.effort,
          });
          if (got && got.answers && got.answers.length) break;
          got = null;
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          lastErr = e;
          lastErrAll = e;
          logLine("warn", `第 ${from + 1}–${to} 题「${att.label}」失败：${explainError(e)}`);
          const einfo = aiErrorInfo(e);
          if (einfo.fatal) {                    // 官方定义：400/401/402/422 属于请求/配置问题，重试没意义
            fatalErr = e;
            logLine("error", `不再重试：${explainError(e)}｜${explainErrorDoc(e)}`);
            break;
          }
          if (einfo.code === 429) {             // 官方：请合理规划请求速率 —— 先等一会儿，别立刻再撞
            fatalErr = e;
            const wait = (einfo.backoff || [6000])[Math.min(ai, (einfo.backoff || [6000]).length - 1)];
            logLine("warn", `${providerName()} 429 ${einfo.doc.short} → 按建议等 ${Math.round(wait / 1000)} 秒再试`);
            await sleep(wait);
            continue;                            // 计一次尝试，但不算进"加大预算"那两级
          }
          if (einfo.backoff) {                   // 500/503：官方让"稍后重试"
            const wait = einfo.backoff[Math.min(ai, einfo.backoff.length - 1)];
            logLine("warn", `${providerName()} ${einfo.code} ${einfo.doc.name} → 按建议等 ${Math.round(wait / 1000)} 秒再重试`);
            await sleep(wait);
          }
        }
        heartbeatLock();
      }
      if (fatalErr && !got) throw new SkipError(explainError(fatalErr), "config");   // 只是"这一次"撞限流/配置错，但后来成功了就别停
      if (!got) {
        // v1.4.0：一轮判不了就不再拖垮整套——把这批题标成"判不了"，其余照常写
        logLine("error", `第 ${from + 1}–${to} 题三轮都失败：${explainError(lastErr)}｜${explainErrorDoc(lastErr)}`);
        failedRanges.push([from + 1, to]);
        continue;
      }

      // 把本批结果对齐到全局题号（兼容模型用局部编号或全局编号）
      for (const a of got.answers) {
        const rawNo = Number(a && a.no);
        if (!Number.isFinite(rawNo)) continue;
        let g = null;
        if (rawNo > from && rawNo <= to) g = rawNo;            // 全局编号
        else if (rawNo >= 1 && rawNo <= n) g = from + rawNo;   // 局部编号
        if (g === null) continue;
        out[g - 1] = {
          no: g,
          // v1.4.0：answer 是通用字段（多选=ABD、填空=空1#CSG#空2）；兼容旧字段 letter
          answer: String(a.answer !== undefined && a.answer !== null ? a.answer : (a.letter || "")).trim(),
          confidence: a.confidence === undefined ? null : Number(a.confidence),
          why: a.why || "",
        };
      }
      heartbeatLock();
    }
    return { answers: out, failedRanges, lastError: lastErrAll ? explainError(lastErrAll) : "" };
  }

  // ------------------------------------------------------------------ 任务列表页
  function infoFromCard(card) {
    const nameEl = card.querySelector(".tm_name");
    const titleEl = card.querySelector(".title2");
    const hw = card.getAttribute("homeworkid");
    return {
      tmid: card.getAttribute("tmid"),
      sclassid: card.getAttribute("sclassid"),
      tcid: card.getAttribute("tcid"),
      ttid: card.getAttribute("ttid"),
      submitId: card.getAttribute("tm_subid"),
      // v1.4.0：作业卡才有 homeworkid；测验卡是空的（站点自己也是这么区分的）
      homeworkid: hw && hw !== "null" && hw !== "0" ? hw : "",
      name: nameEl ? nameEl.textContent.trim() : "",
      title: titleEl ? (titleEl.getAttribute("title") || "") : "",
    };
  }

  let busy = false;
  async function runForTask(info, btn) {
    if (busy) { toast("上一个任务还在处理中，请稍候…"); return; }
    busy = true;
    try {
      if (btn) { btn.disabled = true; btn.textContent = "识别中…"; }
      say(`开始处理：${info.title || info.name}（tmid=${info.tmid}）`);
      // 判题逻辑只保留一份：judgeTask（含题库命中优先、分批、选项校验）
      const judged = await judgeTask(info);
      say("判题完成：" + judged.questions.map((_, i) => `${i + 1}${judged.byNo[i + 1] || "（判不了）"}`).join(" "));
      const choice = await showPreview(info, judged.questions, judged.byNo, judged.answers, judged.answerText);
      if (choice === "cancel") { say("已取消，未写入。"); return; }
      if (judged.incomplete) say(`⚠ 有 ${judged.missing.length} 题判不了，这次不自动交卷（写入其余题目，空缺留给你补）`);
      const wantFinal = choice === "writeFinal" && !judged.incomplete;
      await writeAnswers(info, judged.questions, judged.byNo, wantFinal, judged.keysByNo);
    } catch (e) {
      if (e instanceof SkipError) {
        say(`已跳过：${e.reason}`);
        toast(`「${info.title || info.name}」已跳过：${e.reason}`, 8000);
        return;
      }
      const why = explainError(e);
      say("失败：" + why);
      toast("自动作答失败：" + why, 8000);
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = "AI 自动作答"; }
    }
  }

  function handleCard(card, btn) { return runForTask(infoFromCard(card), btn); }

  /** 答案预览窗口。返回 Promise<"write"|"writeFinal"|"cancel">
   *  opts.autoMs：倒计时多少毫秒后自动继续（无人值守/批量在非静默模式下用）
   *  opts.finalize：自动继续时选的动作是「写入并交卷」还是「写入答案」
   *  opts.onCancel：点取消时的回调
   */
  function showPreview(info, questions, byNo, raw, answerText = {}, opts = {}) {
    const why = {};
    const conf = {};
    (raw || []).forEach((a) => {
      if (!a || !a.no) return;
      why[Number(a.no)] = a.why || "";
      if (a.confidence !== undefined && a.confidence !== null) conf[Number(a.no)] = Number(a.confidence);
    });
    const low = questions.map((_, i) => i + 1)
      .filter((n) => conf[n] !== undefined && conf[n] < CFG.lowConfidence);
    const isHw = !!(questions && questions[0] && questions[0].homework);
    const rows = questions.map((qid, i) => {
      const ans = String(byNo[i + 1] || "");
      // 简答题正文很长，单独成块显示（转义后再进 DOM）
      const shown = !ans ? '<span class="yzj-tip">（模型判不了，留空）</span>'
        : (ans.length > 30
          ? `<div class="yzj-ans" style="font-weight:400;white-space:pre-wrap;border-left:3px solid #0a7a3d;`
            + `padding-left:8px;margin:4px 0">${esc(stripHtml(ans))}</div>`
          : `<span class="yzj-ans">${esc(ans)}</span>`);
      const tip = ans.length > 30 ? "" : (answerText[i + 1] ? "<b>" + esc(answerText[i + 1]) + "</b> " : "");
      return `
      <div class="yzj-row" ${low.includes(i + 1) ? 'style="background:#fff7e6"' : ""}>
      第 ${i + 1} 题 → ${shown}
      ${tip}
      ${low.includes(i + 1) ? '⚠️' : ""}
      <span class="yzj-tip">${conf[i + 1] !== undefined ? "[" + Math.round(conf[i + 1] * 100) + "%] " : ""}${why[i + 1] ? "（" + esc(why[i + 1]) + "）" : ""}</span></div>`;
    }).join("");
    return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "yzj-mask";
    box.innerHTML = `<div class="yzj-dialog" style="width:460px">
      <h3 style="margin:0 0 6px;font-size:15px">${esc(info.title || info.name)} · AI 判题结果</h3>
      ${low.length ? `<div style="background:#fff7e6;border:1px solid #ffd591;border-radius:8px;padding:6px 8px;margin-bottom:6px">
        低置信度题号：${low.join("、")}（阈值 ${CFG.lowConfidence}，建议人工看一眼）</div>` : ""}
      ${isHw ? `<div style="background:#fff7e6;border:1px solid #ffd591;border-radius:8px;padding:6px 8px;margin-bottom:6px">
        这是<b>作业/练习</b>：站点没有「只保存不提交」的接口，点下面按钮就等于<b>提交作业</b>。</div>` : ""}
      <div style="max-height:46vh;overflow:auto">${rows}</div>
      ${opts.autoMs ? `<div class="yzj-tip" style="margin-top:8px">无人值守：<b id="yzj-count">${Math.round(opts.autoMs / 1000)}</b> 秒后自动${opts.finalize ? "交卷" : "写入"}（点「取消并停止」可中断）</div>` : ""}
      <div style="margin-top:12px;text-align:right">
        <span class="yzj-btn gray" data-a="cancel">${opts.autoMs ? "取消并停止" : "取消"}</span>
        ${isHw ? "" : '<span class="yzj-btn" data-a="write">写入答案</span>'}
        <span class="yzj-btn red" data-a="writeFinal">${isHw ? "提交作业" : "写入并交卷"}</span>
      </div></div>`;
    document.body.appendChild(box);
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      box.remove();
      resolve(choice);
    };
    box.querySelector('[data-a="cancel"]').onclick = () => { if (opts.onCancel) opts.onCancel(); finish("cancel"); };
    const writeBtn = box.querySelector('[data-a="write"]');
    if (writeBtn) writeBtn.onclick = () => finish("write");     // 作业模式没有这个按钮
    box.querySelector('[data-a="writeFinal"]').onclick = () => finish("writeFinal");
    let timer = null;
    if (opts.autoMs) {
      let left = Math.round(opts.autoMs / 1000);
      timer = setInterval(() => {
        left -= 1;
        const el = box.querySelector("#yzj-count");
        if (el) el.textContent = String(Math.max(0, left));
        if (left <= 0) finish(opts.finalize ? "writeFinal" : "write");
      }, 1000);
    }
    });
  }

  async function writeAnswers(info, questions, byNo, finalize, keysByNo) {
    try {
      // v1.4.1：作业（含主观题）没有"只保存不提交"的接口，这里就是提交
      if (info.homeworkid) {
        const w = await writeTask(info, questions, byNo);
        histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                  count: 1, answers: w.answers, keys: keysByNo, tokens: lastUsage,
                  source: "作业(提交)", score: null,
                  note: w.queued ? `已排队，约 ${w.dueInMin} 分钟后提交` : (w.confirmed ? "服务器已确认" : "已发出") });
        toast(w.queued
          ? `「${info.title || info.name}」作业已排队：约 ${w.dueInMin} 分钟后自动提交`
          : `「${info.title || info.name}」作业已提交${w.confirmed ? "（已确认）" : ""}`, 9000);
        return;
      }
      say("正在写入答案…");
      let ok = 0, skipped = 0;
      for (let i = 0; i < questions.length; i += 1) {
        if (!byNo[i + 1]) { skipped += 1; continue; }   // v1.4.0：判不了的题留空
        const r = await api("student/testquiz/v1/saveQuestionRecord", {
          method: "POST",
          body: {
            answerStr: byNo[i + 1], needAnalysis: 0, questionId: questions[i],
            stuClassId: info.sclassid, submitId: info.submitId, tmid: info.tmid,
            files: null, gradeId: null, isActiveRepulse: 0,
          },
        });
        if (r && r.data && r.data.flag === 1) ok += 1;
        await sleep(150);
      }
      say(`写入完成：${ok}/${questions.length} 题成功` + (skipped ? `，${skipped} 题留空（模型判不了）` : "") + "。");
      histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                count: questions.length, answers: byNo, keys: keysByNo, tokens: lastUsage,
                source: finalize ? "手动+交卷" : "手动", score: null });
      if (finalize) {
        const r = await deliverSubmit(info, questions.length);
        if (r.queued) {
          toast(`已排入提交队列：约 ${r.dueInMin} 分钟后自动交卷（关页面也没事，下次打开会继续）`, 9000);
        } else if (r.ok) {
          histUpdate(info.tmid, { score: r.score, right: r.right, total: r.total });
        } else if (onTestPage()) {
          const res = await finalizeNow(info, questions.length);   // 就在答题页上：走界面兜底
          if (res && res.ok) histUpdate(info.tmid, { score: res.score, right: res.right, total: res.total });
          else histUpdate(info.tmid, { note: "交卷未成功：" + ((res && res.reason) || "未知") });
        } else {
          GM_setValue("pendingFinalize", { ...info, count: questions.length, at: Date.now() });
          say("接口交卷没成功 → 打开答题页用界面交卷…");
          const li = document.querySelector(`li.contentLi[tmid="${info.tmid}"]`) || document.querySelectorAll("li.contentLi")[0];
          if (li) li.click(); else say("没找到任务卡片，请在答题页手动交卷。");
        }
      } else {
        toast(`已写入 ${ok}/${questions.length} 题（没有交卷）`, 6000);
      }
    } catch (e) {
      say("写入失败：" + e.message);
      toast("写入失败：" + e.message, 8000);
    }
  }

  function decorateTaskCards() {
    const cards = document.querySelectorAll("li.contentLi");
    cards.forEach((card) => {
      if (card.querySelector(".yzj-card")) return;
      if (!card.style.position) card.style.position = "relative";
      const btn = document.createElement("span");
      btn.className = "yzj-btn yzj-card";
      btn.textContent = "AI 自动作答";
      btn.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); ensurePanel(); handleCard(card, btn); };
      card.appendChild(btn);
    });
    return cards.length;
  }

  // ------------------------------------------------------------------ 批量作答
  /** 只判题 + 写答案（不弹预览、不跳页），用于"一键作答全部任务" */
  /**
   * 第一步 A：预检（v1.4.0）——先判"该不该答 / 能不能答"，再决定要不要花钱调 AI。
   * 返回 {verdict:"ok"|"skip", kind, reason, ids, questions}
   */
  async function inspectTask(info) {
    // 1) 有 homeworkid → 作业页那套接口（v1.4.1：主观题也能答，正文走 subResult）
    if (info.homeworkid) {
      let d = null;
      try {
        const h = await api(`student/grouptaskdetail/getHomeWork?tmid=${info.tmid}`
          + `&homeworkid=${info.homeworkid}&sclassid=${info.sclassid}`);
        d = (h && h.data) || {};
      } catch (e) {
        logLine("warn", "读作业内容失败：" + explainError(e));
        return { verdict: "skip", kind: "homework", reason: "读不到作业内容，需人工" };
      }
      const text = [d && d.h_title, stripHtml(d && d.h_desc), stripHtml(d && d.h_prompt)]
        .filter(Boolean).join(" ");
      // 规则优先：老师布置的开放题/上传题照样整套跳过
      const hit = matchSkipRule(text);
      if (hit) return { verdict: "skip", kind: "rule", reason: `命中跳过规则「${hit}」` };
      const q = mapHomework(d);
      if (!HOMEWORK_Q_TYPES.includes(q.type)) {
        return { verdict: "skip", kind: "homework", reason: `作业/练习（${q.typeName}），脚本暂不支持` };
      }
      if (q.type === Q_TYPE.SUBJECTIVE) {
        if (!q.desc) return { verdict: "skip", kind: "homework", reason: "作业题干是空的，需人工" };
      } else if (!q.options.length) {
        return { verdict: "skip", kind: "homework", reason: `作业/练习（${q.typeName}）读不到选项，需人工` };
      }
      return { verdict: "ok", kind: "homework", homework: true, ids: [q.id], questions: [q], reason: "" };
    }

    // 2) 测验：先看服务器上有没有题目（空任务直接跳过，不再重试）
    const ansResp = await api("student/testquiz/v1/getStuTestQuizAnswer", {
      method: "POST", form: true,
      body: { stuClassId: info.sclassid, submitId: info.submitId, tmid: info.tmid },
    });
    const rows = Array.isArray(ansResp && ansResp.data) ? ansResp.data : [];
    if (!rows.length) {
      const code = (ansResp && (ansResp.code || ansResp.errcode)) || 0;
      if (code && code !== 200) {
        throw new Error(`读题目列表失败（${code} ${(ansResp && (ansResp.message || ansResp.errmsg)) || ""}）`);
      }
      return { verdict: "skip", kind: "empty", reason: "服务器上没有题目（空任务）" };
    }
    const ids = rows.map((x) => x && x.questionId).filter((x) => x !== undefined && x !== null);

    // 3) 题型 + 内容规则：全部在调 AI 之前判掉
    let qs = [];
    try { qs = await loadTextQuestions(info, ids); } catch (e) { qs = []; }
    const bad = unsupportedTypes(qs);
    if (bad.length) {
      const names = [...new Set(bad.map((q) => q.typeName || Q_TYPE_NAME[q.type] || String(q.type)))].join("/");
      return { verdict: "skip", kind: "unsupported", reason: `含暂不支持题型（${names}）`, ids, questions: qs };
    }
    const hit = matchSkipRule(qs.map(questionPlainText).join(" \n "));
    if (hit) return { verdict: "skip", kind: "rule", reason: `命中跳过规则「${hit}」`, ids, questions: qs };
    return { verdict: "ok", ids, questions: qs, reason: "" };
  }

  /** 第一步 B：判题（不写任何东西），返回题目与答案 */
  async function judgeTask(info, pre = null) {
    loadTaskMeta();                              // v1.4.7: warm up course/class cache for bank tags
    const insp = pre || await inspectTask(info);
    if (insp.verdict === "skip") throw new SkipError(insp.reason, insp.kind);
    if (insp.homework) return judgeHomework(info, insp);
    const questions = insp.ids;

    const paper = await api(`student/testvalidatedetail/gettestpaperofimage?tmid=${info.tmid}`);
    const urls = ((paper.data || {}).attrlist || []).map((a) => "https://www.csgmooc.com" + a.imgurl);
    const qs = insp.questions && insp.questions.length ? insp.questions : null;
    // v1.6.2：连线题的题干是空的，但左右选项就是内容 —— 用 hasSendableText 判，别再只数 desc
    const textCount = qs ? qs.filter(hasSendableText).length : 0;
    const textOk = !!(qs && qs.length === questions.length
      && textCount >= Math.ceil(questions.length * 0.6));
    if (!textOk && !urls.length) {
      logLine("warn", `这套题取到 ${qs ? qs.length : 0}/${questions.length} 道，其中带文字（题干或选项）的 ${textCount} 道，且没有试卷图片`);
      throw new SkipError("既没有图片也没有题干文本（多半是作业/主观题）", "unsupported");
    }

    // 图片版：先算图片指纹（同一次运行内只下载一次），供题库跨卷子匹配
    let imageFp = null;
    if (!textOk && urls.length) {
      if (urls.length > 1) logLine("warn", `这套有 ${urls.length} 张图，题库指纹只用第一张（其余照常发给 AI）`);
      try {
        imageFp = await imageFingerprints(await fetchImageBlob(urls[0]));
        logLine("info", `图片指纹：sha=${imageFp.sha || "-"} dhash=${imageFp.dh || "-"}`);
      } catch (e) { logLine("warn", "算图片指纹失败（不影响判题）：" + e.message); }
    }

    // 题库优先：命中的题直接作答，不再调用 AI
    const keysByNo = {};
    const sourceByNo = {};
    const byNo = {};
    for (let i = 0; i < questions.length; i += 1) {
      const idx = i + 1;
      const keys = bankKeys(info, textOk ? qs[i] : null, idx, imageFp);
      keysByNo[idx] = keys;
      if (!CFG.useBank) continue;
      const hit = bankLookup(keys, imageFp, idx);
      if (!hit) continue;
      let norm = "";
      try {
        // 文字版：命中答案必须按该题题型合法（多选/填空同样校验），否则当作不可信
        norm = textOk ? normalizeAnswer(qs[i], hit.a, idx) : String(hit.a).toUpperCase();
      } catch (e) {
        logLine("warn", `题库命中第${idx}题但不可信（${e.message}），忽略该条`);
        continue;
      }
      if (!norm) continue;
      byNo[idx] = norm;
      sourceByNo[idx] = "bank";
    }
    const missIdx = questions.map((_, i) => i + 1).filter((n) => !byNo[n]);
    if (textOk) bankNoteMany(keysByNo, qs, info);      // v1.4.4：先把题干记进题库便签
    let failedNos = [];
    let aiLastError = "";              // v1.4.9：把 AI 的真实错误提到块外，供"整套判不了"写理由
    if (missIdx.length) {
      const ranges = [];                 // 未命中的题号合成连续区间，交给 askAI 分批
      missIdx.forEach((n) => {
        const last = ranges[ranges.length - 1];
        if (last && last[1] === n - 1) last[1] = n;
        else ranges.push([n - 1, n]);
      });
      say(`题库命中 ${questions.length - missIdx.length}/${questions.length} 题，剩 ${missIdx.length} 题问 AI`);
      const aiRes = await askAI({
        imageUrls: textOk ? [] : urls, questions: textOk ? qs : null,
        count: questions.length, taskName: `${info.name} ${info.title}`, ranges,
      });
      ((aiRes && aiRes.answers) || []).forEach((a) => {
        if (!a || !a.no) return;
        byNo[Number(a.no)] = String(a.answer || "").trim();
        sourceByNo[Number(a.no)] = "ai";
      });
      ((aiRes && aiRes.failedRanges) || []).forEach(([ra, rb]) => {
        for (let n = ra; n <= rb; n += 1) if (!byNo[n]) failedNos.push(n);
      });
      aiLastError = (aiRes && aiRes.lastError) || "";
      if (failedNos.length) {
        logLine("warn", `有 ${failedNos.length} 题模型判不了（题号 ${failedNos.join("、")}），这几题留空`);
        say(`⚠ 有 ${failedNos.length} 题模型判不了（题号 ${failedNos.join("、")}），先留空`);
      }
    } else {
      say(`题库全部命中（${questions.length} 题），这次不调用 AI`);
    }

    // S6 + v1.4.0：文字版按题型校验并归一化（多选 ABD、填空 a#CSG#b）；不合法就整卷不写
    if (textOk) {
      const invalid = [];
      for (let i = 0; i < qs.length; i += 1) {
        const n = i + 1;
        if (!byNo[n]) continue;                    // 判不了的题先放一边
        try { byNo[n] = normalizeAnswer(qs[i], byNo[n], n); }
        catch (e) { invalid.push(e.message); }
      }
      if (invalid.length) throw new Error(invalid.slice(0, 5).join("；"));
    } else {
      // 图片版：只认 A~J 的字母（多选就多个字母，最多 4 个，去重），挡住"unknown"这类噪声
      const invalid = [];
      for (let i = 1; i <= questions.length; i += 1) {
        if (!byNo[i]) continue;
        const picked = [...new Set(String(byNo[i]).toUpperCase().replace(/[^A-J]/g, "").split(""))].filter(Boolean);
        if (!picked.length || picked.length > 4) { invalid.push(`第${i}题=${String(byNo[i]).slice(0, 12)}`); continue; }
        byNo[i] = picked.sort().join("");
      }
      if (invalid.length) throw new Error("图片版答案不合法：" + invalid.slice(0, 5).join("、"));
    }

    const missing = [];
    for (let i = 1; i <= questions.length; i += 1) if (!byNo[i]) missing.push(i);
    if (missing.length === questions.length) {
      const why = aiLastError;                             // v1.4.9：别一律甩锅给"截断"
      throw new SkipError(why ? `整套题都判不了（${why}）` : "整套题模型都判不了（输出被截断）",
                          isFatalAiError(why) ? "config" : "unjudgeable");
    }
    const hardMissing = missing.filter((n) => !failedNos.includes(n));
    if (hardMissing.length) throw new Error("模型漏答：" + hardMissing.join(","));

    const answerText = {};
    if (textOk) {
      qs.forEach((q, i) => {
        const got = byNo[i + 1];
        if (!got) return;
        if (Number(q.type) === Q_TYPE.BLANK) { answerText[i + 1] = got.split(BLANK_SEP).join(" / "); return; }
        if (Number(q.type) === Q_TYPE.LINE) {
          const lmap = new Map((q.left || []).map((x) => [String(x.no), x.text]));
          const rmap = new Map((q.right || []).map((x) => [String(x.key).toUpperCase(), x.text]));
          answerText[i + 1] = got.split("#").map((p) => {
            const m = /^(\d+)([A-Z]+)$/.exec(p) || [];
            return `${m[1]}.${lmap.get(m[1]) || "?"} → ${m[2]}.${rmap.get(m[2]) || "?"}`;
          }).join("；");
          return;
        }
        const hit = (q.options || []).filter((o) => got.includes(String(o.letter).toUpperCase()));
        if (hit.length) answerText[i + 1] = hit.map((o) => o.text).join("；");
      });
    }
    const answers = Object.keys(byNo).sort((a, b) => a - b).map((n) => ({ no: Number(n), answer: byNo[n] }));
    return {
      questions, byNo, answers, answerText, count: questions.length, keysByNo, sourceByNo,
      failedNos, missing, incomplete: missing.length > 0,
    };
  }

  /** 简答正文 → 富文本 HTML（站点存的就是 UEditor 的 innerHTML） */
  function toHtmlAnswer(text) {
    const s = String(text === undefined || text === null ? "" : text).trim();
    if (!s) return "";
    if (/^</.test(s)) return s;                       // 模型直接给了 HTML 就用原样
    return s.split(/\n+/).map((line) => line.trim()).filter(Boolean)
      .map((line) => `<p>${esc(line)}</p>`).join("");
  }

  /**
   * 提交作业（v1.4.1）：站点 ajaxRequest 默认 form-urlencoded，
   * 正文要先 DES-ECB 加密再当 subResult 传（口径与站点 CryptoJS 一致）。
   */
  async function submitHomework(info, answerHtml) {
    const r = await api("student/taskmodule/v2/subResult", {
      method: "POST", form: true,
      body: {
        mId: info.tmid,
        refId: info.sclassid,
        submitId: info.submitId,
        subResult: DES.encryptBase64(answerHtml),
        ttid: info.ttid,
        scid: info.tcid,
        needAnalysis: 1,
        fileIdJson: "[]",
      },
    });
    const code = (r && (r.errcode || r.code)) || 0;
    if (code !== 200) {
      throw new Error(`提交作业失败（${code} ${(r && (r.errmsg || r.message)) || ""}）`);
    }
    return r;
  }

  /** 这套作业在服务器上是不是已经提交过了（memberAnswer.sub_time 非空即已交） */
  async function homeworkSubmitted(info) {
    try {
      const r = await api(`student/taskmodule/getResultOfStudent?tmid=${info.tmid}&submitId=${info.submitId}`);
      const m = (r && r.data && r.data.memberAnswer) || {};
      return !!m.sub_time;
    } catch (e) {
      return false;                 // 读不到就当没交（后面还有"提交后回读"兜底）
    }
  }

  /** 提交后回读确认（最多等 tries×1.5 秒） */
  async function waitHomeworkSubmitted(info, tries = 6) {
    for (let i = 0; i < tries; i += 1) {
      await sleep(1500);
      if (await homeworkSubmitted(info)) return true;
    }
    return false;
  }

  /** 作业/练习：题库 → AI → 按题型归一化（主观题转 HTML） */
  async function judgeHomework(info, insp) {
    loadTaskMeta();                              // v1.4.7: same as judgeTask
    const q = insp.questions[0];
    const keysByNo = {}, sourceByNo = {}, byNo = {};
    const keys = bankKeys(info, q, 1, null);
    keysByNo[1] = keys;
    if (CFG.useBank) {
      const hit = bankLookup(keys, null, 1);
      if (hit && hit.a) { byNo[1] = String(hit.a); sourceByNo[1] = "bank"; }
    }
    if (!byNo[1]) {
      const r = await askAI({
        imageUrls: [], questions: [q], count: 1,
        taskName: `${info.name} ${info.title}`, ranges: [[0, 1]],
      });
      const a = ((r && r.answers) || [])[0];
      if (a && a.answer) { byNo[1] = String(a.answer).trim(); sourceByNo[1] = "ai"; }
      if (!byNo[1]) {
        const why = (r && r.lastError) || "";
        throw new SkipError(why ? `模型没给出作答内容（${why}）` : "模型没给出作答内容（可能被截断）",
                            isFatalAiError(why) ? "config" : "unjudgeable");
      }
    }
    if (q.type === Q_TYPE.SUBJECTIVE) byNo[1] = toHtmlAnswer(byNo[1]);
    else byNo[1] = normalizeAnswer(q, byNo[1], 1);
    if (!byNo[1]) throw new SkipError("作答内容为空", "unjudgeable");
    bankNoteMany(keysByNo, [q], info);                 // v1.4.4：题干记进题库便签
    say(`  作答：${q.desc.slice(0, 30)}…`);
    return {
      homework: true, questions: [q], byNo, answers: [{ no: 1, answer: byNo[1] }],
      answerText: { 1: byNo[1] }, count: 1, keysByNo, sourceByNo,
      failedNos: [], missing: [], incomplete: false,
    };
  }

  /** 第二步：写答案 */
  async function writeTask(info, questions, byNo) {
    // v1.4.1：作业正文只能靠 subResult 落库（提交即生效，没有"只保存"的接口）
    if (info.homeworkid) {
      const ans = byNo[1];
      if (!ans) return { ok: 0, skipped: 1, total: 1, answers: byNo, count: 1, homework: true };
      // v1.4.2：作业也遵守「延迟提交」——先排队，到点再交，避免几套作业挤在几分钟内
      if (CFG.delayEnabled && CFG.delaySubmitMax > 0) {
        const mins = randInt(CFG.delaySubmitMin, CFG.delaySubmitMax);
        enqueueSubmit({ ...info, homework: true, homeworkAnswer: ans }, 1, Date.now() + mins * 60000);
        say(`作业已排入提交队列：约 ${mins} 分钟后自动提交（设置里可改）。`);
        return { ok: 1, queued: true, dueInMin: mins, skipped: 0, total: 1, answers: byNo, count: 1, homework: true };
      }
      const t0 = Date.now();
      await submitHomework(info, ans);
      const confirmed = await waitHomeworkSubmitted(info, 6);
      logLine("info", `作业提交${confirmed ? "已确认" : "已发出（未回读到提交时间）"}，`
        + `用时 ${Math.round((Date.now() - t0) / 1000)}s`);
      say(`作业已提交${confirmed ? "（服务器已确认）" : "（已发出）"}。`);
      return { ok: 1, skipped: 0, total: 1, answers: byNo, count: 1, homework: true, confirmed };
    }
    let ok = 0, skipped = 0;
    for (let i = 0; i < questions.length; i += 1) {
      // v1.4.0：模型判不了的题留空，不硬写
      if (!byNo[i + 1]) { skipped += 1; continue; }
      const r = await api("student/testquiz/v1/saveQuestionRecord", {
        method: "POST",
        body: {
          answerStr: byNo[i + 1], needAnalysis: 0, questionId: questions[i],
          stuClassId: info.sclassid, submitId: info.submitId, tmid: info.tmid,
          files: null, gradeId: null, isActiveRepulse: 0,
        },
      });
      if (r && r.data && r.data.flag === 1) ok += 1;
      // 延迟功能：逐题之间加随机间隔，让"作答过程"看起来像人做的（可在设置里关）
      if (CFG.delayEnabled && CFG.delayPerQuestion) {
        await sleep(randInt(CFG.delayQuestionMin * 1000, CFG.delayQuestionMax * 1000));
      } else {
        await sleep(120);
      }
      heartbeatLock();
    }
    return { ok, skipped, total: questions.length, answers: byNo, count: questions.length };
  }

  /** 判题 + 写答案（静默流程用） */
  async function answerOne(info) {
    const j = await judgeTask(info);
    const w = await writeTask(info, j.questions, j.byNo);
    return { ...w, count: j.count, raw: j.answers, answerText: j.answerText, keys: j.keysByNo,
             incomplete: j.incomplete, missing: j.missing };
  }

  /**
   * 不支持作答的题型（v1.4.0）：只有 单选/多选/判断/填空 能答，其余（主观/代码/连线/排序）一律整套跳过。
   */
  function unsupportedTypes(qs) {
    return (qs || []).filter((q) => q.type !== undefined && q.type !== null
      && !SUPPORTED_Q_TYPES.includes(Number(q.type)));
  }

  function lowConfItems(rawAnswers) {
    return (rawAnswers || [])
      .filter((a) => a && a.confidence !== undefined && a.confidence !== null
        && Number(a.confidence) < CFG.lowConfidence)
      .map((a) => Number(a.no));
  }

  function panelBatchBar() {
    const body = bodyEl();
    if (!body || body.querySelector(".yzj-batch")) return;
    const bar = document.createElement("div");
    bar.className = "yzj-batch";
    bar.style.cssText = "margin-bottom:8px;padding-bottom:8px;border-bottom:1px dashed #e5e9ef";
    bar.innerHTML = `<span class="yzj-btn" data-a="batch">一键作答全部任务</span>
      <span class="yzj-btn" data-a="ua" style="background:#0a7a3d;border-color:#0a7a3d">开始无人值守</span>
      <span class="yzj-btn red" data-a="uastop">停止（全部）</span>`;
    bar.querySelector('[data-a="batch"]').onclick = () => batchAll();
    bar.querySelector('[data-a="ua"]').onclick = () => uaStart(false);
    bar.querySelector('[data-a="uastop"]').onclick = () => stopEverything("手动停止");
    body.insertBefore(bar, body.firstChild);
  }

  async function batchAll() {
    const token = ++batchRunToken;
    const alive = () => token === batchRunToken;
    const cards = [...document.querySelectorAll("li.contentLi")];
    if (!cards.length) { alert("没找到任务卡片"); return; }
    const doFinal = CFG.autoFinalize;
    const yes = await askConfirm(`批量作答 ${cards.length} 个任务？`,
      `将对这 ${cards.length} 个任务逐个 AI 判题并写入答案。`
      + (doFinal ? "<br><b>设置里开了「写入后自动交卷」，写完会逐个交卷（每次都会先问你一次）。</b>"
                 : "<br>只写答案，不交卷。"), "开始作答");
    if (!yes) return;
    if (!acquireLock("batch")) { alert(lockBusyMessage()); return; }
    say("开始批量作答…");
    const infos = cards.map(infoFromCard);
    let submitted = 0, skipped = 0;
    for (let i = 0; i < infos.length; i += 1) {
      if (!alive()) { say("批量作答已被停止。"); break; }
      const info = infos[i];
      heartbeatLock();
      say(`[${i + 1}/${infos.length}] ${info.title || info.name} 判题中…`);
      try {
        // v1.4.2：已提交过的作业不再重复交
        if (CFG.uaSkipAnswered && info.homeworkid && await homeworkSubmitted(info)) {
          skipped += 1;
          say(`[${i + 1}/${infos.length}] 这套作业已经提交过了，跳过`);
          histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                    count: 0, answers: {}, tokens: 0, source: "跳过", score: null, note: "作业已提交过" });
          continue;
        }
        let count = 0, toFinal = false;
        if (CFG.silent) {
          const r = await answerOne(info);
          count = r.count;
          say(`[${i + 1}/${infos.length}] 写入 ${r.ok}/${r.total} 题：`
            + Object.keys(r.answers).map((k) => k + r.answers[k]).join(" "));
          histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                    count, answers: r.answers, keys: r.keys, tokens: lastUsage, source: "批量", score: null });
          if (r.incomplete) say(`[${i + 1}/${infos.length}] ⚠ 有 ${r.missing.length} 题判不了，这套不自动交卷`);
          toFinal = doFinal && !r.incomplete;
          if (r.homework) toFinal = false;              // 作业在写入时就已提交，别再走选择题的交卷
        } else {
          const j = await judgeTask(info);
          const choice = await showPreview(info, j.questions, j.byNo, j.answers, j.answerText,
            { autoMs: 5000, finalize: doFinal, onCancel: () => say("批量已停止。") });
          if (choice === "cancel") { say("批量作答已被取消。"); break; }
          const w = await writeTask(info, j.questions, j.byNo);
          count = j.count;
          say(`[${i + 1}/${infos.length}] 写入 ${w.ok}/${w.total} 题`);
          histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                    count, answers: w.answers, keys: j.keysByNo, tokens: lastUsage, source: "批量", score: null });
          if (j.incomplete) say(`[${i + 1}/${infos.length}] ⚠ 有 ${j.missing.length} 题判不了，这套不自动交卷`);
          toFinal = choice === "writeFinal" && !j.incomplete;
          if (w.homework) toFinal = false;              // 同上：作业提交即生效
        }
        if (toFinal) {
          const r = await deliverSubmit(info, count);
          if (r.queued) say(`[${i + 1}/${infos.length}] 已排入提交队列（约 ${r.dueInMin} 分钟后交卷）`);
          else if (r.ok) { submitted += 1; histUpdate(info.tmid, { score: r.score, right: r.right, total: r.total }); }
          else say(`[${i + 1}/${infos.length}] 交卷没成功，已排队稍后重试`);
        }
      } catch (e) {
        if (e instanceof CancelledError || /已取消/.test(String(e && e.message))) {
          say("批量作答已被取消。");
          break;
        }
        if (e instanceof SkipError) {
          skipped += 1;
          say(`[${i + 1}/${infos.length}] 已跳过：${e.reason}`);
          histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                    count: 0, answers: {}, tokens: 0, source: "跳过", score: null, note: e.reason });
          await sleep(600);
          continue;
        }
        const why = explainError(e);
        say(`[${i + 1}/${infos.length}] 失败：${why}`);
        histAdd({ at: Date.now(), tmid: String(info.tmid), name: info.name, title: info.title,
                  count: 0, answers: {}, tokens: lastUsage, source: "批量(失败)", score: null, note: why });
      }
      const gap = (CFG.delayEnabled && CFG.delayBetweenMax > 0)
        ? randInt(CFG.delayBetweenMin, CFG.delayBetweenMax) * 60000 : 800;
      if (gap > 5000 && i < infos.length - 1) {
        const deadline = Date.now() + gap;
        while (Date.now() < deadline) {
          if (!alive()) break;
          heartbeatLock();
          const waiting = Math.max(0, Math.round((deadline - Date.now()) / 1000));
          showProgress(`批量：等 ${Math.floor(waiting / 60)}:${String(waiting % 60).padStart(2, "0")} 后处理下一套…`);
          await sleep(5000);
        }
        hideProgress();
      } else {
        await sleep(gap);
      }
    }
    releaseLock("batch");
    hideProgress();
    const pending = submitQueueAll().length;
    toast(`批量完成：已交卷 ${submitted} 套` + (skipped ? `，跳过 ${skipped} 套` : "")
      + (pending ? `，${pending} 套在提交队列里等时间` : "")
      + "。可在「历史」里核对。", 9000);
  }

  function onTaskPage() { return location.pathname.endsWith("stud_task.html"); }

  let batchRunToken = 0;      // 批量作答的代际标记：递增即可让旧的那一轮退出

  // ------------------------------------------------------------------ 历史记录
  // ------------------------------------------------------------------ 题库（本地答案库）
  // 思路同市面上的刷题工具：先查本地题库，命中就直接作答（不再调 AI），交卷后按官方判定自学习。
  const BANK_KEY = "answerBank";
  const BANK_MAX = 5000;

  function normText(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/[\s\u3000]+/g, "")
      .replace(/[，。、！？；：“”‘’（）《》,.!?;:"'()<>\[\]{}]/g, "")
      .toLowerCase();
  }

  function hash32(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /**
   * 题库指纹（一个题可以有多把钥匙，命中任意一把即算命中）：
   *   文字版：q + 题干&选项哈希（跨卷子、跨账号通用）
   *   图片版：i + 图片精确哈希 + 题号；d + 图片感知哈希 + 题号（防同一张图被重新压缩）
   *   兜底：p + 卷子(tmid) + 题号（同一份卷子重做时最稳）
   */
  function bankKeys(info, question, index, imageFp) {
    const keys = [];
    const desc = question && question.desc ? normText(question.desc) : "";
    const opts = question ? normText((question.options || []).map((o) => o.text).join("|")) : "";
    if (desc.length >= 6) keys.push("q" + hash32(desc + "||" + opts));
    if (imageFp) {
      if (imageFp.sha) keys.push(`i${imageFp.sha}@${index}`);     // 完全相同的文件
      if (imageFp.dh) keys.push(`d${imageFp.dh}@${index}`);      // 近似（重压缩/缩放）
    }
    if (info && info.tmid) keys.push("p" + hash32(String(info.tmid) + "#" + index));
    return keys;
  }

  const bankAll = () => GM_getValue(BANK_KEY, {}) || {};

  /**
   * 查题库：先精确命中（keys 里任意一把），再对"文档感知哈希"做近似匹配。
   * 阈值 12/64 是实测定的：同一张图重压缩后距离只有 2~8，而不同试卷之间距离约 38。
   * 近似匹配只在同一题号内比较，避免误命中别的题。
   */
  function bankLookup(keys, imageFp, index) {
    const bank = bankAll();
    for (const k of keys) if (bank[k] && bank[k].a) return { key: k, ...bank[k] };
    if (imageFp && imageFp.dh && index) {
      let best = null, bestDist = 13;
      for (const k of Object.keys(bank)) {
        const m = /^d([0-9a-f]+)@(\d+)$/.exec(k);
        if (!m || Number(m[2]) !== Number(index)) continue;
        const dist = hammingHex(m[1], imageFp.dh);
        if (dist <= 12 && dist < bestDist) { best = k; bestDist = dist; }
      }
      if (best) return { key: best, ...bank[best], near: bestDist };
    }
    return null;
  }

  function bankPut(key, answer, src) {
    if (!key || !answer) return;
    const bank = bankAll();
    // v1.4.4：把"这道题是什么"（题干 + 题型）一并存进条目，导出的 JSON 才看得懂、改得动
    const note = (GM_getValue(NOTE_KEY, {}) || {})[key];
    bank[key] = Object.assign({ a: String(answer), at: Date.now(), src: src || "learn" },
      note ? { q: note.q, t: note.t, subj: note.subj, cls: note.cls, stu: note.stu, who: note.who } : {});
    const keys = Object.keys(bank);
    if (keys.length > BANK_MAX) {
      keys.sort((x, y) => (bank[x].at || 0) - (bank[y].at || 0))
        .slice(0, keys.length - BANK_MAX).forEach((k) => delete bank[k]);
    }
    GM_setValue(BANK_KEY, bank);
  }

  // ---------------------------------------------------- 题库便签（v1.4.4）
  // 判题时先把「这一题是什么」按 key 记下来；等交卷自学习写入答案时再合并进条目。
  // 这样导出的题库里就有题干，能看懂、能搜、能改。
  const NOTE_KEY = "bankNotes";
  const NOTE_MAX = BANK_MAX;

  // -------------------------------------------------- 来源标注（v1.4.7）
  // 每题记三样：哪门课（tc_name）、哪个班（tt_name）、哪个账号（学号 + 姓名）。
  // 课程/班级名来自任务列表接口 student/task/gettaskmodule（和 paper_pipeline 用的是同一个：
  // 它的 tc_name 是课程/章节、tt_name 是班级）。取不到就退回卡片上的任务名，绝不自造。
  let taskMetaCache = null;                    // tmid -> {subj, cls}
  let taskMetaLoading = null;
  function loadTaskMeta() {
    if (taskMetaCache) return Promise.resolve(taskMetaCache);
    if (taskMetaLoading) return taskMetaLoading;
    const qs = new URLSearchParams({
      stuid: sessionStorage.getItem("stuId") || "",
      gid: sessionStorage.getItem("indexpage:gid") || "",
      ttid: "", sclassid: "", key: "", taskTypeJson: "", sublastType: "", type: 0, pcFlag: 0,
    });
    taskMetaLoading = api("student/task/gettaskmodule?" + qs.toString())
      .then((j) => {
        const map = {};
        for (const g of ((j && j.data) || [])) {
          for (const t of (g.taskModuleInfos || [])) {
            if (t && t.tmid) {
              map[String(t.tmid)] = { subj: String(t.tc_name || ""), cls: String(t.tt_name || "") };
            }
          }
        }
        taskMetaCache = map;
        logLine("info", `来源标注：已缓存 ${Object.keys(map).length} 条任务的课程/班级`);
        return map;
      })
      .catch((e) => {
        logLine("warn", "来源标注：课程/班级没取到（不影响判题）：" + e.message);
        taskMetaCache = {};
        return taskMetaCache;
      })
      .finally(() => { taskMetaLoading = null; });
    return taskMetaLoading;
  }
  function accountTag() {
    return {
      stu: sessionStorage.getItem("login_number") || sessionStorage.getItem("userAccount") || "",
      who: sessionStorage.getItem("login_name") || "",
    };
  }
  function metaFor(info) {
    const hit = (taskMetaCache && info && taskMetaCache[String(info.tmid)]) || null;
    const subj = (hit && hit.subj) || (info && (info.name || info.title)) || "";
    return {
      subj: String(subj).replace(/\s+/g, " ").trim().slice(0, 60),
      cls: String((hit && hit.cls) || "").replace(/\s+/g, " ").trim().slice(0, 40),
    };
  }

  function bankNoteMany(keysByNo, questions, info) {
    if (!questions || !questions.length) return 0;
    const meta = metaFor(info);                  // v1.4.7：这一题是哪门课、哪个班
    const acc = accountTag();                    //           以及是哪个账号收的
    const notes = GM_getValue(NOTE_KEY, {}) || {};
    let added = 0;
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      const desc = (q && q.desc ? String(q.desc) : "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!desc) continue;                       // 图片版没有题干，只能靠图片指纹
      const note = { q: desc, t: Number(q.type), at: Date.now(),
                     subj: meta.subj, cls: meta.cls, stu: acc.stu, who: acc.who };
      for (const k of (keysByNo[i + 1] || [])) {
        // v1.4.7：题干/题型只写给"按题干"的 q 键（其它键本来也没题干）；
        // 但来源标注（课程/班级/学号）每个键都写，图片版的 i/d/p 键也要能看出是哪一科。
        const isQ = k[0] === "q";
        const nk = isQ ? note : { at: note.at, subj: note.subj, cls: note.cls, stu: note.stu, who: note.who };
        const cur = notes[k];
        if (!cur || cur.q !== nk.q || cur.t !== nk.t
            || cur.subj !== nk.subj || cur.stu !== nk.stu) { notes[k] = nk; added += 1; }
      }
    }
    if (!added) return 0;
    const ks = Object.keys(notes);
    if (ks.length > NOTE_MAX) {                  // 超了就按写入时间裁掉最老的
      ks.sort((x, y) => (notes[x].at || 0) - (notes[y].at || 0))
        .slice(0, ks.length - NOTE_MAX).forEach((k) => delete notes[k]);
    }
    GM_setValue(NOTE_KEY, notes);
    return added;
  }

  function bankDel(key) {
    const bank = bankAll();
    if (bank[key]) { delete bank[key]; GM_setValue(BANK_KEY, bank); }
  }

  function bankStats() {
    const bank = bankAll();
    const keys = Object.keys(bank);
    const byQuestion = keys.filter((k) => k[0] === "q").length;
    const withText = keys.filter((k) => bank[k] && bank[k].q).length;   // 已记录题干（v1.4.4）
    return { total: keys.length, byQuestion, byPaper: keys.length - byQuestion, withText };
  }

  /** 题库"元信息"：条数 + 最后更新时间（用于导入时判断哪份更新） */
  function bankMeta(bank) {
    const items = bank || bankAll();
    const keys = Object.keys(items).filter((k) => !k.startsWith("__"));
    let latest = 0;
    keys.forEach((k) => { const at = Number(items[k] && items[k].at) || 0; if (at > latest) latest = at; });
    return { count: keys.length, latestAt: latest, latestText: latest ? new Date(latest).toLocaleString("zh-CN") : "（无记录）" };
  }

  /**
   * 合并导入的题库条目（纯函数，便于测试）：
   *  - 跳过没有答案的条目和 __meta__ 这类元数据；
   *  - 同 key 覆盖（后来者赢），分别统计 新增 / 覆盖 / 跳过。
   */
  function bankMerge(items) {
    const bank = bankAll();
    let added = 0, updated = 0, skipped = 0;
    Object.keys(items || {}).forEach((k) => {
      if (k.startsWith("__")) return;
      const v = items[k];
      if (!v || !v.a) { skipped += 1; return; }
      const existed = Object.prototype.hasOwnProperty.call(bank, k);
      // v1.4.4：导入时保留题干/题型（导出文件里能看到、也能手改）
      const keep = {};
      if (v.q) keep.q = String(v.q).slice(0, 100);
      if (v.t !== undefined && v.t !== null) keep.t = Number(v.t);
      bank[k] = Object.assign({ a: String(v.a), at: Number(v.at) || Date.now(), src: "import" }, keep);
      if (existed) updated += 1; else added += 1;
    });
    GM_setValue(BANK_KEY, bank);
    return { added, updated, skipped, total: bankMeta(bank).count, latestText: bankMeta(bank).latestText };
  }

  /** 只预览"导入会发生什么"，不写任何东西（危险操作先给用户看） */
  function bankPreview(items) {
    const bank = bankAll();
    let added = 0, updated = 0, older = 0, skipped = 0;
    Object.keys(items || {}).forEach((k) => {
      if (k.startsWith("__")) return;
      const v = items[k];
      if (!v || !v.a) { skipped += 1; return; }
      const cur = bank[k];
      if (!cur) added += 1;
      else if (Number(v.at || 0) > Number(cur.at || 0)) updated += 1;
      else older += 1;
    });
    return { added, updated, older, skipped, localCount: bankMeta(bank).count };
  }

  /** 交卷后自学习：官方判对 → 入库；判错 → 剔除（避免污染题库） */
  function bankLearn(keysByNo, answersByNo, rows) {
    let added = 0, removed = 0;
    (rows || []).forEach((row, i) => {
      const no = row.no || i + 1;
      const keys = keysByNo[no] || [];
      const mine = answersByNo[no];
      if (!keys.length || !mine) return;
      if (row.right === 1) { keys.forEach((k) => bankPut(k, mine, "official")); added += 1; }
      else if (row.right === 0) { keys.forEach((k) => bankDel(k)); removed += 1; }
    });
    if (added || removed) logLine("info", `题库自学习：写入/更新 ${added} 题，剔除 ${removed} 题`);
    return { added, removed };
  }

  function openBank() {
    const st = bankStats();
    const bank = bankAll();
    const meta = bankMeta(bank);
    const recent = Object.keys(bank)
      .sort((a, b) => (bank[b].at || 0) - (bank[a].at || 0)).slice(0, 30)
      .map((k) => `<div class="yzj-row" style="font-size:12px">
        ${bank[k].q ? `<div>${esc(bank[k].q)}</div>` : `<div class="yzj-tip">${esc(k)}</div>`}
        ${bank[k].t !== undefined ? `<span class="yzj-tip">[${esc(Q_TYPE_NAME[Number(bank[k].t)] || bank[k].t)}]</span> ` : ""}
        → <span class="yzj-ans">${esc(bank[k].a)}</span>
        <span class="yzj-tip">${new Date(bank[k].at).toLocaleString("zh-CN")}　${esc(bank[k].src || "")}</span></div>`).join("");
    const mask = document.createElement("div");
    mask.className = "yzj-mask";
    mask.innerHTML = `<div class="yzj-dialog" style="width:520px">
      <h3 style="margin:0 0 8px;font-size:15px">题库（本地答案库）</h3>
      <div>共 <b>${st.total}</b> 条：按题干 <b>${st.byQuestion}</b> 条、按卷子+题号 <b>${st.byPaper}</b> 条
        ${st.withText ? `（其中 <b>${st.withText}</b> 条记了题干，导出后能看懂）` : ""}
        　最后更新：<b>${meta.latestText}</b></div>
      <div class="yzj-tip" style="margin:4px 0 8px">命中题库的题直接作答、不再调用 AI；交卷后官方判定答对的题会自动写回题库。</div>
      <div style="max-height:45vh;overflow:auto;background:#fafbfc;border-radius:8px;padding:6px">${recent || '<div class="yzj-tip">题库还是空的。</div>'}</div>
      <div style="text-align:right;margin-top:12px">
        <span class="yzj-btn gray" data-a="close">关闭</span>
        <span class="yzj-btn gray" data-a="exp">导出题库</span>
        <span class="yzj-btn gray" data-a="expcsv">导出 CSV</span>
        <span class="yzj-btn gray" data-a="imp">导入题库</span>
        <span class="yzj-btn gray" data-a="clear">清空</span></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('[data-a="close"]').onclick = () => mask.remove();
    mask.querySelector('[data-a="clear"]').onclick = async () => {
      const n = bankStats().total;
      const ok = await askConfirmEx("清空题库？",
        `将删除本机全部 <b>${n}</b> 条题库记录，<b>不可恢复</b>。<br>`
        + `<span class="yzj-tip">建议先点「导出题库」备份一份；如果你在另一台设备上还有题库，也可以之后重新导入。</span>`,
        "确认清空", "清空");
      if (!ok) return;
      GM_setValue(BANK_KEY, {});
      mask.remove();
      toast("题库已清空（可用「导入题库」恢复）", 6000);
      logLine("warn", `用户清空了题库（原有 ${n} 条）`);
    };
    mask.querySelector('[data-a="exp"]').onclick = () => {
      const all = bankAll();
      const m = bankMeta(all);
      // 带上 __meta__：导入方就能看到"这份库多少条、何时导出、来自哪个账号"
      const payload = {
        __meta__: {
          app: "yzj-csgmooc-helper", version: YZJ_VERSION, exportedAt: Date.now(),
          count: m.count, latestAt: m.latestAt,
          account: sessionStorage.getItem("login_name") || "",
          stuId: sessionStorage.getItem("stuId") || "",
        },
        ...all,
      };
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `yzj-bank-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      toast(`题库已导出（${m.count} 条）`, 5000);
    };
    // v1.4.4：导出 CSV（Excel 能直接打开、直接改；JSON 那个是给导入用的）
    mask.querySelector('[data-a="expcsv"]').onclick = () => {
      const all = bankAll();
      const rows = [["key", "题型", "题干", "答案", "写入时间", "来源"]];
      Object.keys(all).forEach((k) => {
        const v = all[k] || {};
        if (!v.a) return;
        rows.push([k, Q_TYPE_NAME[Number(v.t)] || (v.t === undefined ? "" : String(v.t)),
          v.q || "", v.a,
          v.at ? new Date(v.at).toLocaleString("zh-CN") : "", v.src || ""]);
      });
      const csv = "\uFEFF" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `yzj-bank-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      toast(`已导出 CSV（${rows.length - 1} 条，Excel 可直接打开）`, 6000);
    };
    mask.querySelector('[data-a="imp"]').onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          try {
            const inc = JSON.parse(String(fr.result));
            const src = inc && inc.__meta__ ? inc.__meta__ : {};     // 老版本导出的文件（没有 __meta__）也能导
            const before = bankMeta();
            const pv = bankPreview(inc);
            // 导入会覆盖同名条目 → 先给"将要发生什么"，用户确认后才真正写入
            askConfirmEx("确认导入题库？",
              `<b>来源文件</b>：${esc(f.name)}<br>`
              + `<b>来源题库</b>：${src.count ? esc(String(src.count)) + " 条" : "（未标注）"}`
              + `${src.latestAt ? "　最后更新 " + esc(new Date(Number(src.latestAt)).toLocaleString("zh-CN")) : ""}`
              + `${src.account ? "<br>来自账号：" + esc(String(src.account)) : ""}`
              + `<hr style="border:none;border-top:1px dashed #e5e9ef;margin:8px 0">`
              + `本机现有 <b>${pv.localCount}</b> 条；本次将 <b>新增 ${pv.added}</b> 条、`
              + `<b>覆盖同名 ${pv.updated}</b> 条` + (pv.older ? `、跳过较旧 ${pv.older} 条` : "")
              + (pv.skipped ? `、跳过无效 ${pv.skipped} 条` : "")
              + `<div class="yzj-tip" style="margin-top:6px">合并规则：保留本机其它条目，同 key 以导入文件里的为准。</div>`,
              "确认导入").then((ok) => {
              if (!ok) { toast("已取消导入"); return; }
              finishImport(f, inc, src, before);
            });
          } catch (e) { toast("导入失败：" + e.message); }
        };
        fr.readAsText(f);
      };
      input.click();
    };
  }

  /** 导入确认后的实际写入 + 报告（拆出来是为了让"确认"这步干净） */
  function finishImport(file, inc, src, before) {
    const r = bankMerge(inc);
    document.querySelectorAll(".yzj-mask").forEach((m) => m.remove());
    // 导入报告：来源信息 + 本机变化 + 合并结果（D：方便判断哪份更新）
    const rep = document.createElement("div");
    rep.className = "yzj-mask";
    rep.innerHTML = `<div class="yzj-dialog" style="width:470px">
      <h3 style="margin:0 0 8px;font-size:15px">导入完成</h3>
      <div class="yzj-row"><b>来源文件</b>：${esc(file.name)}</div>
      <div class="yzj-row"><b>来源题库</b>：${src.count ? esc(String(src.count)) + " 条" : "（未标注条数）"}
      ${src.latestAt ? "<br>最后更新：" + esc(new Date(Number(src.latestAt)).toLocaleString("zh-CN")) : ""}
      ${src.exportedAt ? "<br>导出时间：" + esc(new Date(Number(src.exportedAt)).toLocaleString("zh-CN")) : ""}
      ${src.account ? "<br>来自账号：" + esc(String(src.account)) + (src.stuId ? "（" + esc(String(src.stuId)) + "）" : "") : ""}</div>
      <div class="yzj-row"><b>本机题库</b>：导入前 ${before.count} 条（最后更新 ${esc(before.latestText)}）<br>
      导入后 <b>${r.total}</b> 条（最后更新 ${esc(r.latestText)}）</div>
      <div class="yzj-row"><b>合并结果</b>：新增 <b>${r.added}</b> 条，覆盖同名 <b>${r.updated}</b> 条${r.skipped ? `，跳过无效 <b>${r.skipped}</b> 条` : ""}</div>
      <div class="yzj-tip" style="margin-top:6px">合并规则：保留本机已有条目，同 key 以导入的为准，不会删除其它条目。</div>
      <div style="text-align:right;margin-top:12px"><span class="yzj-btn" data-a="ok">知道了</span></div></div>`;
    document.body.appendChild(rep);
    rep.querySelector('[data-a="ok"]').onclick = () => rep.remove();
    toast(`导入完成：新增 ${r.added}，覆盖 ${r.updated}`, 8000);
    logLine("info", `题库导入：来源 ${src.count || "?"} 条，新增 ${r.added}，覆盖 ${r.updated}，跳过 ${r.skipped}`);
  }

  function histAll() { return GM_getValue("history", []) || []; }

  function histAdd(entry) {
    const list = histAll();
    list.unshift(entry);
    GM_setValue("history", list.slice(0, 200));
  }

  function histUpdate(tmid, patch) {
    const list = histAll();
    const hit = list.find((x) => x.tmid === String(tmid) && x.__open !== false);
    if (hit) { Object.assign(hit, patch); GM_setValue("history", list); }
  }

  function histCsv() {
    const rows = [["时间", "任务", "训练", "题数", "答案", "得分", "正确", "token", "来源", "备注"]];
    histAll().forEach((h) => rows.push([
      new Date(h.at).toLocaleString("zh-CN"), h.name || "", h.title || "", h.count || "",
      Object.keys(h.answers || {}).map((k) => k + h.answers[k]).join(" "),
      h.score === null || h.score === undefined ? "" : h.score,
      h.right === undefined ? "" : `${h.right}/${h.total}`,
      h.tokens || "", h.source || "", h.note || "",
    ]));
    return "\uFEFF" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  }

  // ---------------------------------------------------------------- 日志：查看 / 导出
  function logText() {
    flushLog();
    const buf = GM_getValue("logBuf", []) || [];
    const mask = (k) => (k ? k.slice(0, 6) + "…" + k.slice(-4) : "(未设置)");
    const settings = {
      silent: CFG.silent, autoFinalize: CFG.autoFinalize, confirmBeforeFinalize: CFG.confirmBeforeFinalize,
      readScoreAfterFinalize: CFG.readScoreAfterFinalize, showTokens: CFG.showTokens,
      lowConfidence: CFG.lowConfidence, lowConfStrict: CFG.lowConfStrict, timeoutSec: CFG.timeoutSec,
      unattended: CFG.unattended, uaFinalize: CFG.uaFinalize, uaSkipAnswered: CFG.uaSkipAnswered,
      uaRetry: CFG.uaRetry, uaMaxTasks: CFG.uaMaxTasks, uaOnly: CFG.uaOnly,
      skipEnabled: CFG.skipEnabled, skipRules: CFG.skipRules, skipRulesVersion: CFG.skipRulesVersion,
      maxTokensCap: CFG.maxTokensCap, reasoningEffort: CFG.reasoningEffort,
    };
    const head = [
      "===== 易智教助手 诊断日志 =====",
      "脚本版本：" + YZJ_VERSION,
      "导出时间：" + new Date().toLocaleString("zh-CN"),
      "页面地址：" + location.href,
      "浏览器：" + navigator.userAgent,
      "服务商：" + ((providerById(CFG.provider) || {}).name || CFG.provider)
        + "（" + (PROTO_LABEL[CFG.proto] || CFG.proto) + "）",
      "模型：" + CFG.model + (CFG.modelVision ? "　图片模型：" + CFG.modelVision : "") + "　接口：" + CFG.baseUrl,
      "API Key：" + (CFG.apiKey ? mask(CFG.apiKey) : "（未填 / 本机模型不需要）") + "（已脱敏）",
      "账号：stuId=" + (sessionStorage.getItem("stuId") || "-")
        + "　姓名=" + (sessionStorage.getItem("login_name") || "-")
        + "　登录态=" + (token() ? "有效" : "缺失"),
      "累计 token：" + GM_getValue("tokenTotal", 0),
      "当前设置：" + JSON.stringify(settings),
      "无人值守状态：" + JSON.stringify(GM_getValue("uaState", null)),
      "待交卷标记：" + JSON.stringify(GM_getValue("pendingFinalize", null)),
      "作答历史：" + (histAll().length) + " 条（最近 5 条见文末）",
      "------------------------------",
      `日志（共 ${buf.length} 条，最新在最后）：`,
    ].join("\n");
    const body = buf.map((x) => `[${new Date(x.t).toLocaleString("zh-CN")}] ${x.lv.padEnd(5)} ${x.m}`).join("\n");
    const hist = histAll().slice(0, 5).map((h) => `  ${new Date(h.at).toLocaleString("zh-CN")} ${h.name} `
      + `${Object.keys(h.answers || {}).map((k) => k + h.answers[k]).join(" ")}`
      + ` ${h.score === null || h.score === undefined ? "" : " 得分 " + h.score}`
      + ` ${h.tokens ? " " + h.tokens + " tokens" : ""} ${h.note ? " " + h.note : ""}`).join("\n");
    return head + "\n" + body + "\n\n===== 最近 5 条作答 =====" + "\n" + (hist || "  （无）") + "\n";
  }

  function openLog() {
    flushLog();
    const buf = GM_getValue("logBuf", []) || [];
    const tail = buf.slice(-200);
    const rows = tail.length
      ? tail.map((x) => `<div class="yzj-row" style="font-size:12px">`
          + `<span class="yzj-tip">${new Date(x.t).toLocaleTimeString("zh-CN")}</span> `
          + `<b>${x.lv}</b> ${String(x.m).replace(/</g, "&lt;").slice(0, 160)}</div>`).join("")
      : `<div class="yzj-tip">还没有日志。</div>`;
    const mask = document.createElement("div");
    mask.className = "yzj-mask";
    mask.innerHTML = `<div class="yzj-dialog" style="width:560px">
      <h3 style="margin:0 0 8px;font-size:15px">运行日志（共 ${buf.length} 条，显示最近 200 条）</h3>
      <div style="max-height:55vh;overflow:auto;background:#fafbfc;border-radius:8px;padding:6px">${rows}</div>
      <div class="yzj-tip" style="margin-top:8px">出问题就把「导出日志」的文件发给我，里面有版本、设置（Key 已脱敏）、接口耗时和报错，一般看这个就够定位。</div>
      <div style="text-align:right;margin-top:12px">
        <span class="yzj-btn gray" data-a="close">关闭</span>
        <span class="yzj-btn gray" data-a="copy">复制到剪贴板</span>
        <span class="yzj-btn" data-a="export">导出日志文件</span>
        <span class="yzj-btn gray" data-a="clear">清空</span></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('[data-a="close"]').onclick = () => mask.remove();
    mask.querySelector('[data-a="clear"]').onclick = async () => {
      const n = (GM_getValue("logBuf", []) || []).length;
      const ok = await askConfirmEx("清空日志？",
        `将删除全部 <b>${n}</b> 条运行日志。<br>`
        + `<span class="yzj-tip">日志用于排查问题，建议先点「导出日志文件」再清。</span>`, "确认清空", "清空");
      if (!ok) return;
      logBufCache = [];
      logDirty = false;
      GM_setValue("logBuf", []);
      mask.remove();
      toast("日志已清空", 5000);
    };
    mask.querySelector('[data-a="copy"]').onclick = () => {
      const text = logText();
      try { GM_setClipboard(text, "text"); toast("日志已复制，粘贴给我即可"); }
      catch { navigator.clipboard.writeText(text).then(() => toast("日志已复制")).catch(() => toast("复制失败，请用「导出日志文件」")); }
    };
    mask.querySelector('[data-a="export"]').onclick = () => {
      try {
        const blob = new Blob([logText()], { type: "text/plain;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        a.download = `yzj-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
          + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
        document.body.appendChild(a); a.click(); a.remove();
        toast("日志已导出到「下载」文件夹", 6000);
      } catch (e) { toast("导出失败：" + e.message); logLine("error", "导出日志失败：" + e.message); }
    };
  }

  function openHistory() {
    const list = histAll();
    const rows = list.length ? list.map((h) => `
      <div class="yzj-row">
        <div><b>${h.name || ""}</b> <span class="yzj-tip">${h.title || ""}</span></div>
        <div class="yzj-tip">${new Date(h.at).toLocaleString("zh-CN")}　
          答案：${Object.keys(h.answers || {}).map((k) => k + h.answers[k]).join(" ") || "-"}　
          ${h.score === null || h.score === undefined ? "" : "得分 " + h.score + "　"}
          ${h.tokens ? h.tokens + " tokens" : ""}</div>
      </div>`).join("") : `<div class="yzj-tip">还没有记录。</div>`;
    const mask = document.createElement("div");
    mask.className = "yzj-mask";
    mask.innerHTML = `<div class="yzj-dialog" style="width:520px">
      <h3 style="margin:0 0 8px;font-size:15px">作答历史（最近 ${list.length} 条，最多留 200 条）</h3>
      <div style="max-height:60vh;overflow:auto">${rows}</div>
      <div style="text-align:right;margin-top:12px">
        <span class="yzj-btn gray" data-a="close">关闭</span>
        <span class="yzj-btn" data-a="csv">导出 CSV</span>
        <span class="yzj-btn gray" data-a="clear">清空</span></div></div>`;
    document.body.appendChild(mask);
    mask.querySelector('[data-a="close"]').onclick = () => mask.remove();
    mask.querySelector('[data-a="clear"]').onclick = async () => {
      const n = histAll().length;
      const ok = await askConfirmEx("清空作答历史？",
        `将删除全部 <b>${n}</b> 条作答记录，<b>不可恢复</b>。<br>`
        + `<span class="yzj-tip">建议先点「导出 CSV」留一份。</span>`, "确认清空", "清空");
      if (!ok) return;
      GM_setValue("history", []);
      mask.remove();
      toast("作答历史已清空", 5000);
      logLine("warn", `用户清空了作答历史（原有 ${n} 条）`);
    };
    mask.querySelector('[data-a="csv"]').onclick = () => {
      const blob = new Blob([histCsv()], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `易智教作答记录_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      toast("已导出 CSV");
    };
  }

  // ------------------------------------------------------------------ 无人值守
  const UA = {
    read() { return GM_getValue("uaState", null); },
    write(v) { GM_setValue("uaState", v); },
  };

  function uaStart(auto) {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const st = { active: true, runId, startedAt: Date.now(), done: [], failed: [], attempts: {}, scores: {}, log: [] };
    UA.write(st);
    say(auto ? "无人值守：已启动（设置里可关）" : "无人值守：已启动");
    toast(`无人值守已启动：自动判题${CFG.uaFinalize ? " + 自动交卷" : "（不交卷）"}，最多 ${CFG.uaMaxTasks} 套`, 6000);
    uaTick(runId);
  }

  function uaStop(reason, { keepLock = false } = {}) {
    abortInflight();
    const st = UA.read() || {};
    st.active = false;
    st.runId = null;
    st.endedAt = Date.now();
    st.reason = reason || "已停止";
    UA.write(st);
    if (!keepLock) releaseLock("unattended");
    const scores = Object.keys(st.scores || {}).map((k) => `${k}:${st.scores[k]}分`).join("  ");
    const skipN = Object.keys(st.skipped || {}).length;
    const doneN = (st.done || []).length - skipN;      // done 里含跳过，这里分开算
    say(`无人值守：结束 —— ${st.reason}；完成 ${Math.max(0, doneN)} 套`
      + (skipN ? `，跳过 ${skipN} 套` : "")
      + ((st.failed || []).length ? `，失败 ${st.failed.length} 套` : ""));
    if (scores) say("成绩：" + scores);
    toast(`无人值守结束：${st.reason}｜完成 ${Math.max(0, doneN)} 套`
      + (skipN ? `｜跳过 ${skipN} 套` : "") + (scores ? `（${scores}）` : ""), 9000);
    hideProgress();
  }

  /** 停止当前所有流程（无人值守 + 批量 + 在飞的请求） */
  function stopEverything(reason) {
    batchRunToken += 1;                 // 让批量的循环在下一步退出
    uaStop(reason || "手动停止");
    toast("已停止当前流程（无人值守/批量）", 6000);
  }

  /** 主循环：挑一套没处理过的 → 判题写答案 → （可选）交卷 → 下一套 */
  async function uaTick(runId) {
    // 只有"我这一轮"还活着才继续：被停止或被新一轮替代（runId 变了）就立刻退出，
    // 这样旧协程不会因为新一轮把 active 又置 true 而"复活"（修 S2 的并发）
    const alive = () => {
      const s = UA.read();
      return !!(s && s.active && (!runId || s.runId === runId));
    };
    let st = UA.read();
    if (!st || !alive()) return;
    if (st.done.length + st.failed.length >= CFG.uaMaxTasks) return uaStop(`已达到上限 ${CFG.uaMaxTasks} 套`);
    if (!acquireLock("unattended")) { say(lockBusyMessage()); return uaStop("已有其它流程在运行"); }

    while (true) {
      if (!alive()) return;                       // 被停止 / 被新一轮替代 → 退出
      st = UA.read();
      // v1.4.5：上限必须在循环里也判。之前只在入口判过一次，进入 while 后就再也不看，
      // 结果设置「单次最多处理任务数 = 20」，一轮却把列表里 58 套全跑完了。
      if (st.done.length + st.failed.length >= CFG.uaMaxTasks) {
        say(`  已达到上限 ${CFG.uaMaxTasks} 套，停止本轮`);
        return uaStop(`已达到上限 ${CFG.uaMaxTasks} 套`);
      }
      heartbeatLock();
      // 等任务列表渲染
      let cards = [];
      for (let i = 0; i < 30; i += 1) {
        cards = [...document.querySelectorAll("li.contentLi")];
        if (cards.length) break;
        await sleep(1000);
      }
      // 范围锁：设置里填了关键词就只处理匹配的任务
      const kws = CFG.uaOnly ? CFG.uaOnly.split(/[|,，\s]+/).filter(Boolean) : [];
      const infos = cards.map(infoFromCard).filter((x) => {
        if (!kws.length) return true;
        const text = `${x.name} ${x.title}`;
        return kws.some((k) => text.includes(k));
      });
      if (!infos.length && kws.length) {
        return uaStop(`当前列表没有匹配「${CFG.uaOnly}」的任务（范围锁生效，未处理任何任务）`);
      }
      const next = infos.find((x) => !st.done.includes(x.tmid) && !st.failed.includes(x.tmid));
      if (!next) return uaStop(infos.length ? "列表里的任务都处理过了" : "任务列表已空");

      st.current = next.tmid;
      UA.write(st);
      const label = next.title || next.name;
      const pos = st.done.length + st.failed.length + 1;
      showProgress(`无人值守 ${pos}/${CFG.uaMaxTasks}：${label} 判题中…`);
      say(`无人值守：开始处理「${label}」`);

      try {
        const pre = await serverAnswered(next).catch(() => null);
        if (!alive()) return;
        // v1.4.2：作业提交过就别再交一次（选择题由 uaSkipAnswered 兜底，作业另查一次）
        if (CFG.uaSkipAnswered && next.homeworkid && await homeworkSubmitted(next)) {
          say("  这套作业已经在服务器上提交过了，跳过");
          st.done.push(next.tmid);
          UA.write(st);
          hideProgress();
          continue;
        }
        if (!alive()) return;
        let count = pre ? pre.total : 0;
        let wantFinalize = CFG.uaFinalize;
        let wrote = null;
        let judged = null;
        if (CFG.uaSkipAnswered && pre && pre.total > 0 && pre.answered >= pre.total) {
          say("  这套已有全部答案，跳过判题");
        } else {
          judged = await judgeTask(next);
          if (!alive()) return;
          count = judged.count;
          const low = lowConfItems(judged.answers);
          const mustPause = CFG.lowConfStrict && low.length > 0;
          if (mustPause) say(`  有 ${low.length} 道题置信度低于 ${CFG.lowConfidence}（题号 ${low.join("、")}），按设置停下来等你确认`);
          if (mustPause || !CFG.silent) {
            const choice = await showPreview(next, judged.questions, judged.byNo, judged.answers, judged.answerText,
              { autoMs: mustPause ? 0 : 5000, finalize: CFG.uaFinalize, onCancel: () => uaStop("用户取消") });
            if (choice === "cancel") return;
            wantFinalize = choice === "writeFinal" && !judged.incomplete;
          }
          if (judged.incomplete) {
            say(`  ⚠ 有 ${judged.missing.length} 题判不了（题号 ${judged.missing.join("、")}），这套不自动交卷`);
            wantFinalize = false;
          }
          wrote = await writeTask(next, judged.questions, judged.byNo);
          if (!alive()) return;
          if (wrote.homework) wantFinalize = false;     // 作业提交即生效，不用再走交卷
          say(`  写入 ${wrote.ok}/${wrote.total} 题` + (wrote.skipped ? `（${wrote.skipped} 题留空）` : "")
            + "：" + Object.keys(wrote.answers).filter((k) => wrote.answers[k]).map((k) => k + wrote.answers[k]).join(" "));
          histAdd({ at: Date.now(), tmid: String(next.tmid), name: next.name, title: next.title,
                    count, answers: wrote.answers, keys: judged.keysByNo, tokens: lastUsage,
                    source: "unattended", score: null });
        }
        st = UA.read() || st;
        hideProgress();

        if (wantFinalize) {
          const r = await deliverSubmit(next, count);
          if (!alive()) return;
          if (r.queued) {
            say(`  已排入提交队列：约 ${r.dueInMin} 分钟后自动交卷`);
            st.done.push(next.tmid);
            UA.write(st);
          } else if (r.ok) {
            st.done.push(next.tmid);
            if (r.score !== null && r.score !== undefined) st.scores[next.tmid] = r.score;
            UA.write(st);
            histUpdate(next.tmid, { score: r.score, right: r.right, total: r.total });
          } else {
            say("  立即交卷没成功 → 改为排队，稍后重试");
            const mins = Math.max(1, randInt(CFG.delaySubmitMin, CFG.delaySubmitMax));
            enqueueSubmit(next, count, Date.now() + mins * 60000);
            st.done.push(next.tmid);
            UA.write(st);
          }
        } else {
          st.done.push(next.tmid);
          UA.write(st);
        }
      } catch (e) {
        st = UA.read() || st;
        if (!alive()) return;
        if (e instanceof CancelledError || /已取消/.test(String(e && e.message))) {
          say("  你在进度条上点了取消 → 无人值守暂停（答案已写的不受影响）");
          UA.write({ ...st, active: false, runId: null, endedAt: Date.now(), reason: "用户取消" });
          toast("已取消并停止无人值守", 6000);
          hideProgress();
          return;
        }
        // v1.4.0：主动跳过（作业/命中规则/含不支持题型/整套判不了）——不重试、不计失败
        if (e instanceof SkipError) {
          if (e.kind === "config") {          // v1.4.9：Key 错/余额不足 → 继续跑下一套只会重复同样的错
            UA.write({ ...st, active: false, runId: null, endedAt: Date.now(), reason: e.reason });
            say(`  停了：${e.reason}`);
            toast("⛔ " + e.reason, 15000);
            hideProgress();
            return;
          }
          st.skipped = st.skipped || {};
          st.skipped[next.tmid] = e.reason;
          st.done.push(next.tmid);
          UA.write(st);
          say(`  已跳过（${e.reason}），不算失败`);
          histAdd({ at: Date.now(), tmid: String(next.tmid), name: next.name, title: next.title,
                    count: 0, answers: {}, tokens: 0, source: "跳过", score: null, note: e.reason });
          hideProgress();
          continue;
        }
        st.attempts[next.tmid] = (st.attempts[next.tmid] || 0) + 1;
        const why = explainError(e);
        say(`  失败（第 ${st.attempts[next.tmid]} 次）：${why}`);
        if (st.attempts[next.tmid] >= CFG.uaRetry) {
          st.failed.push(next.tmid);
          say("  重试次数用尽，跳过这套");
          toast(`「${label}」处理失败，已跳过`, 6000);
        }
        histAdd({ at: Date.now(), tmid: String(next.tmid), name: next.name, title: next.title,
                  count: 0, answers: {}, tokens: lastUsage, source: "无人值守(失败)", score: null,
                  note: `失败第 ${st.attempts[next.tmid]} 次：${why}` });
        UA.write(st);
        hideProgress();
      }
      // 两套之间随机间隔（延迟提交的一部分：避免一口气全做完）
      const gap = (CFG.delayEnabled && CFG.delayBetweenMax > 0)
        ? randInt(CFG.delayBetweenMin, CFG.delayBetweenMax) * 60000 : 1200;
      if (gap > 5000) {
        say(`  下一套将在 ${Math.round(gap / 60000)} 分钟后开始（设置里可改）`);
        const deadline = Date.now() + gap;
        while (Date.now() < deadline) {
          if (!alive()) { hideProgress(); return; }      // 等待期间被停止 → 直接退出
          heartbeatLock();
          const waiting = Math.max(0, Math.round((deadline - Date.now()) / 1000));
          showProgress(`等待 ${Math.floor(waiting / 60)}:${String(waiting % 60).padStart(2, "0")} 后处理下一套…`);
          await sleep(5000);
        }
        hideProgress();
      } else {
        await sleep(gap);
      }
      hideProgress();
    }
  }

  // ------------------------------------------------------------------ 答题页：自动交卷
  /** 读答题卡："答题卡 10 / 10" -> {answered:10,total:10}；没渲染出来返回 null */
  function readCard() {
    const el = document.querySelector(".answer-title");
    if (!el) return null;
    const m = el.innerText.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { answered: Number(m[1]), total: Number(m[2]) } : null;
  }

  async function maybeFinalize() {
    const pending = GM_getValue("pendingFinalize", null);
    if (!pending || !pending.tmid) return;
    if (Date.now() - pending.at > 10 * 60 * 1000) { GM_setValue("pendingFinalize", null); return; }
    if (!onTestPage()) return;
    const expected = Number(pending.count) || 0;
    say(`检测到待交卷任务（${expected} 题），等待答题页就绪…`);
    const res = await finalizeNow(pending, expected);
    GM_setValue("pendingFinalize", null);
    if (pending.unattended) {
      const st = UA.read();
      if (st && st.active) {
        st.attempts = st.attempts || {};
        if (res && res.ok) {
          st.done.push(pending.tmid);
          if (res.score !== null && res.score !== undefined) st.scores[pending.tmid] = res.score;
        } else {
          st.attempts[pending.tmid] = (st.attempts[pending.tmid] || 0) + 1;
          if (st.attempts[pending.tmid] >= CFG.uaRetry) st.failed.push(pending.tmid);
          histUpdate(pending.tmid, { note: "交卷未成功：" + ((res && res.reason) || "未知") });
        }
        st.current = null;
        UA.write(st);
        // 交卷结束，回到任务列表继续无人值守（列表页 boot() 会接着跑）
        location.assign("https://www.csgmooc.com/spoc/html/stud_task.html");
      }
    }
  }

  function onTestPage() {
    return location.pathname.includes("/spoc4") || location.hash.includes("student-test");
  }

  /** 服务器上这套题到底答了几题（以服务器为准，不看页面） */
  async function serverAnswered(info) {
    const r = await api("student/testquiz/v1/getStuTestQuizAnswer", {
      method: "POST", form: true,
      body: { stuClassId: info.sclassid, submitId: info.submitId, tmid: info.tmid },
    });
    const rows = r.data || [];
    return { total: rows.length, answered: rows.filter((x) => (x.answerStr || "").trim() !== "").length, rows };
  }

  /** 自己弹一个确认框（不依赖站点弹窗） */
function askConfirm(title, html, yesLabel = "确认交卷") {
    return askConfirmEx(title, html, yesLabel);
  }

  /**
   * 危险操作的二次确认（删数据/清空/覆盖导入这类不可逆动作都要走这里）：
   *  - 必须点"确认"才返回 true；
   *  - needType 非空时，还要求把指定文字（例如「清空」）原样打一遍；
   *  - 默认把确认按钮做成红色，并在文案里提示先备份。
   */
  function askConfirmEx(title, html, yesLabel = "确认", needType = "", danger = true) {
    return new Promise((resolve) => {
      const box = document.createElement("div");
      box.className = "yzj-mask";
      box.innerHTML = `<div class="yzj-dialog" style="width:420px">
        <h3 style="margin:0 0 8px;font-size:15px">${esc(title)}</h3>
        <div>${html}</div>
        ${needType ? `<div class="yzj-field" style="margin-top:10px">请输入「${esc(needType)}」以确认：</div>
          <input id="yzj-typectx" placeholder="${esc(needType)}" autocomplete="off">` : ""}
        <div style="text-align:right;margin-top:12px">
          <span class="yzj-btn gray" data-a="no">取消</span>
          <span class="yzj-btn${danger ? " red" : ""}" data-a="yes" style="opacity:.5">${esc(yesLabel)}</span>
        </div></div>`;
      document.body.appendChild(box);
      const yes = box.querySelector('[data-a="yes"]');
      const input = box.querySelector("#yzj-typectx");
      const sync = () => {
        const ok = !needType || (input && input.value.trim() === needType);
        yes.style.opacity = ok ? "1" : ".5";
        yes.style.pointerEvents = ok ? "auto" : "none";
      };
      if (input) { input.addEventListener("input", sync); input.focus(); }
      sync();
      box.querySelector('[data-a="no"]').onclick = () => { box.remove(); resolve(false); };
      yes.onclick = () => { box.remove(); resolve(true); };
    });
  }

  /** 交卷自检：把判断依据打印出来，不点任何按钮 */
  async function selfCheck(info, expected) {
    const lines = [];
    let serverOk = false;
    try {
      const s = await serverAnswered(info);
      serverOk = s.total > 0 && s.answered >= s.total;
      lines.push(`服务器：${s.answered}/${s.total} 题已作答` + (serverOk ? " ✓" : " ⚠ 还没答满"));
    } catch (e) { lines.push("服务器查询失败：" + e.message); }
    const card = readCard();
    lines.push(card ? `页面答题卡：${card.answered}/${card.total}（仅供参考）` : "页面答题卡：还没渲染出来（仅供参考，不影响交卷）");
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "交卷");
    lines.push(btn ? "交卷按钮：已找到" : "交卷按钮：还没出现（接口交卷不需要它）");
    say("自检：" + lines.join("；"));
    return lines;
  }

  /** 读官方成绩 */
  async function readScore(info) {
    try {
      const r = await api(`student/testvalidatedetail/getanswersheetofstudent?tmid=${info.tmid}&sclassid=${info.sclassid}`);
      const d = (r && r.data) || {};
      const cards = (d.answerSheetOfCards || []).flatMap((c) => c.answerOfCards || []);
      const right = cards.filter((a) => a.is_right === 1).length;
      // 交卷时间和批阅状态才是"是否真的提交过"的依据
      const graded = Boolean(d.sub_time) || (d.correct_status !== undefined && d.correct_status !== null && d.correct_status !== 0);
      const rows = cards.map((a, i) => ({
        no: i + 1, mine: a.tq_answer, right: a.is_right === 1 ? 1 : (a.is_right === 0 ? 0 : null),
      }));
      return { graded, score: d.task_score, right, total: cards.length, subTime: d.sub_time, rows };
    } catch (e) { return null; }
  }

  /** 交卷出成绩后的统一收尾：回填历史成绩 + 按官方判定自学习题库 */
  function applyScoreAndLearn(info, graded) {
    if (!graded) return;
    histUpdate(info.tmid, { score: graded.score, right: graded.right, total: graded.total });
    if (!CFG.bankLearn || !graded.rows) return;
    const entry = histAll().find((h) => String(h.tmid) === String(info.tmid) && h.keys);
    if (!entry) return;
    try {
      const r = bankLearn(entry.keys, entry.answers || {}, graded.rows);
      if (r.added || r.removed) say(`  题库自学习：+${r.added} / -${r.removed}`);
    } catch (e) { logLine("warn", "题库自学习失败：" + e.message); }
  }

  /** 直接调接口交卷（payload 与站点点"交卷→确认"时发的一致，稳定得多） */
  async function submitByApi(info) {
    const payload = {
      stuClassId: Number(info.sclassid),
      tmid: Number(info.tmid),
      ttid: Number(info.ttid),
      scid: String(info.tcid),
      isActiveRepulse: 0,
    };
    const r = await api("student/testquiz/v2/submitTestQuiz", { method: "POST", body: payload });
    return { payload, resp: r };
  }

  /**
   * 在当前答题页交卷。判断依据 = 服务器答案（不是页面渲染），
   * 交卷前可选二次确认，交卷后可选读回成绩。
   */
  /** 轮询「服务器上是否已出现交卷记录」——这是交卷成功与否的唯一判据 */
  async function verifyGraded(info, timeoutSec = 40) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const s = await readScore(info);
      if (s && s.graded) return s;
      await sleep(1000);
    }
    return null;
  }

  /** 纯接口交卷（不需要停在答题页），失败返回 {ok:false} */
  async function submitViaApi(info, { quiet = false } = {}) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const { resp } = await submitByApi(info);
        if (!quiet) say(`接口交卷（第 ${attempt} 次）：` + JSON.stringify(resp).slice(0, 120));
        return { ok: true, resp };
      } catch (e) {
        if (!quiet) say(`接口交卷失败（第 ${attempt} 次）：${explainError(e)}`);
        await sleep(2000);
      }
    }
    return { ok: false };
  }

  /** 界面兜底：点「交卷」→ 等弹窗 → 在弹窗内点「确认」 */
  async function submitViaUi() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const btn = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "交卷" && !b.disabled);
      if (!btn) { await sleep(1500); continue; }
      btn.scrollIntoView({ block: "center" });
      btn.click();
      say(`已点「交卷」按钮（第 ${attempt} 次），等待确认弹窗…`);
      let dlg = null;
      for (let i = 0; i < 14; i += 1) {
        await sleep(500);
        const cand = document.querySelector(".ep-message-box, .el-message-box");
        if (cand && cand.getBoundingClientRect().width > 0 && cand.innerText) { dlg = cand; break; }
      }
      if (dlg) {
        const okBtn = [...dlg.querySelectorAll("button")]
          .find((b) => ["确认", "确定", "提交"].includes(b.textContent.trim()));
        if (okBtn) { okBtn.click(); say("  已点弹窗内的「确认」。"); return true; }
        say("  确认框里没找到「确认」按钮。");
      }
      say("  没等到确认弹窗，重试…");
      await sleep(1200);
    }
    return false;
  }

  async function finalizeNow(info, expected) {
    say("交卷前自检…");
    await selfCheck(info, expected);

    // 1) 以服务器为准：确认这套题确实全部作答了
    let served = null;
    for (let i = 0; i < 10; i += 1) {
      try { served = await serverAnswered(info); } catch (e) { log(e.message); }
      if (served && served.total > 0 && served.answered >= served.total) break;
      await sleep(1500);
    }
    if (!served || served.total === 0) { say("读不到题目列表，放弃自动交卷。"); return { ok: false, reason: "no-questions" }; }
    if (served.answered < served.total) {
      say(`服务器上只有 ${served.answered}/${served.total} 题有答案，放弃自动交卷（避免交空白卷）。`);
      return { ok: false, reason: "not-all-answered" };
    }
    say(`服务器确认 ${served.answered}/${served.total} 题已作答。`);

    // 2) 二次确认（可关；无人值守时自动跳过）
    if (CFG.confirmBeforeFinalize && !info.unattended) {
      const yes = await askConfirm("确认交卷？",
        `${info.title || info.name}<br>服务器上已作答 <b>${served.answered}/${served.total}</b> 题，确认现在提交吗？`);
      if (!yes) { say("已取消交卷（答案仍然保留）。"); return { ok: false, reason: "user-cancel" }; }
    }

    // 3) 首选接口交卷（站点弹窗确认时发的就是它），失败再用界面兜底
    const api = await submitViaApi(info);
    if (!api.ok) await submitViaUi();

    // 4) 以「服务器出现交卷时间」为判据
    showProgress("已提交，等待服务器确认…");
    const graded = await verifyGraded(info, 40);
    hideProgress();
    if (!graded) {
      say("⚠ 服务器上还没出现交卷记录：交卷可能没成功，请手动点一次「交卷」。");
      toast("交卷可能没成功，请手动确认一次", 10000);
      return { ok: false, reason: "not-graded" };
    }
    const scoreText = (graded.score === null || graded.score === undefined)
      ? "已交卷（成绩待出）" : `得分 ${graded.score} 分（${graded.right}/${graded.total} 题正确）`;
    say("交卷成功：" + scoreText);
    if (CFG.readScoreAfterFinalize) toast("交卷成功！" + scoreText, 9000);
    applyScoreAndLearn(info, graded);
    return { ok: true, score: graded.score, right: graded.right, total: graded.total, graded };
  }

  // ------------------------------------------------------------------ 启动
  // ---------------------------------------------------------- 延迟提交（提交队列）
  const submitQueueAll = () => GM_getValue("submitQueue", []) || [];
  const randInt = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  };

  function enqueueSubmit(info, count, dueAt) {
    const q = submitQueueAll().filter((x) => String(x.tmid) !== String(info.tmid));
    q.push({
      tmid: String(info.tmid), sclassid: info.sclassid, tcid: info.tcid, ttid: info.ttid,
      submitId: info.submitId, name: info.name, title: info.title, count, dueAt, addedAt: Date.now(),
      // v1.4.2：作业也走同一个队列（提交正文先存下来，到点再加密提交）
      homework: !!info.homework, homeworkid: info.homeworkid || "", homeworkAnswer: info.homeworkAnswer || "",
    });
    q.sort((a, b) => a.dueAt - b.dueAt);
    GM_setValue("submitQueue", q);
    logLine("info", `已排入提交队列：${info.title || info.name}，计划 `
      + `${new Date(dueAt).toLocaleTimeString("zh-CN")} 交卷（约 ${Math.round((dueAt - Date.now()) / 60000)} 分钟后）`);
  }

  /**
   * 交卷入口（唯一的）：开了延迟就排队，否则立即交。
   * 立即交卷也优先走接口（不需要停在答题页），接口失败再回退到"打开答题页点按钮"。
   */
  async function deliverSubmit(info, count) {
    if (CFG.delayEnabled && CFG.delaySubmitMax > 0) {
      const mins = randInt(CFG.delaySubmitMin, CFG.delaySubmitMax);
      enqueueSubmit(info, count, Date.now() + mins * 60000);
      return { ok: true, queued: true, dueInMin: mins };
    }
    const r = await submitViaApi(info);
    if (r.ok) {
      const g = await verifyGraded(info, 40);
      if (g) {
        const txt = g.score === null || g.score === undefined ? "已交卷（成绩待出）" : `得分 ${g.score} 分（${g.right}/${g.total} 题正确）`;
        say("交卷成功：" + txt);
        if (CFG.readScoreAfterFinalize) toast("交卷成功！" + txt, 9000);
        applyScoreAndLearn(info, g);
        return { ok: true, score: g.score, right: g.right, total: g.total };
      }
    }
    return { ok: false, reason: "api-failed" };
  }

  /** 提交队列处理器：到点的就交卷（任何 csgmooc 页面都会跑，可关页面，下次打开继续） */
  async function processSubmitQueue(force = false) {
    const all = submitQueueAll();
    if (!all.length) return 0;
    let done = 0;
    for (const item of all) {
      if (!force && Number(item.dueAt) > Date.now()) continue;
      if (!acquireLock("submitQueue")) { say(lockBusyMessage()); return done; }
      try {
        // v1.4.2：队列里排的是「作业」——到点直接提交正文
        if (item.homework) {
          if (await homeworkSubmitted(item)) {
            say(`「${item.title || item.name}」这套作业已经在服务器上提交过了，出队。`);
          } else {
            const mins = Math.max(0, Math.round((Date.now() - item.addedAt) / 60000));
            say(`到点了：提交作业「${item.title || item.name}」（写完已 ${mins} 分钟）`);
            await submitHomework(item, item.homeworkAnswer);
            const okHw = await waitHomeworkSubmitted(item, 6);
            if (!okHw) {
              say("  作业提交没等到服务器确认 → 留在队列里，稍后自动重试。");
              toast(`「${item.title || item.name}」作业延迟提交没确认，稍后重试`, 8000);
              continue;
            }
            say("延迟提交成功：作业已提交（服务器已确认）。");
            toast(`「${item.title || item.name}」作业已提交`, 9000);
            histUpdate(item.tmid, { note: "延迟提交成功（作业）" });
            const stHw = UA.read();
            if (stHw && stHw.active) { stHw.done.push(item.tmid); UA.write(stHw); }
          }
          GM_setValue("submitQueue", submitQueueAll().filter((x) => String(x.tmid) !== String(item.tmid)));
          done += 1;
          continue;
        }
        const before = await readScore(item);
        if (before && before.graded) {
          say(`「${item.title || item.name}」已经在服务器上处于已交卷状态，出队。`);
        } else {
          say(`到点了：提交「${item.title || item.name}」（写入已 ${Math.round((Date.now() - item.addedAt) / 60000)} 分钟）`);
          const r = await submitViaApi(item, { quiet: true });
          let g = null;
          if (r.ok) {
            showProgress("等待服务器确认交卷…");
            g = await verifyGraded(item, 40);
            hideProgress();
          }
          if (!g) {
            say("  接口交卷没成功 → 保留在队列里，稍后自动重试（或你手动交一次）。");
            toast(`「${item.title || item.name}」延迟交卷没成功，稍后重试`, 8000);
            continue;
          }
          const txt = g.score === null || g.score === undefined ? "已交卷（成绩待出）" : `得分 ${g.score} 分（${g.right}/${g.total} 题正确）`;
          say("延迟交卷成功：" + txt);
          toast(`${item.title || item.name} 延迟交卷成功：${txt}`, 9000);
          applyScoreAndLearn(item, g);
          const st = UA.read();
          if (st && st.active) { st.done.push(item.tmid); st.scores[item.tmid] = g.score; UA.write(st); }
        }
        GM_setValue("submitQueue", submitQueueAll().filter((x) => String(x.tmid) !== String(item.tmid)));
        done += 1;
      } catch (e) {
        say("延迟交卷出错：" + explainError(e));
      } finally {
        releaseLock();
      }
      await sleep(1500);
    }
    return done;
  }

  /** 记住用户点开的任务，这样"自己点开答题页"也能一键作答 */
  function rememberClickedTask() {
    document.addEventListener("click", (ev) => {
      const li = ev.target && ev.target.closest && ev.target.closest("li.contentLi");
      if (!li) return;
      const info = infoFromCard(li);
      if (info.tmid) GM_setValue("lastTask", { ...info, at: Date.now() });
    }, true);
  }

  /** 答题页上的按钮：直接用 AI 作答当前这套 */
  function addTestPageButton() {
    if (document.querySelector(".yzj-testbtn")) return;
    const btn = document.createElement("div");
    btn.className = "yzj-btn yzj-testbtn";
    btn.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483000;padding:10px 16px;font-size:14px;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,.2)";
    btn.textContent = "AI 用本页作答";
    btn.onclick = async () => {
      const saved = GM_getValue("lastTask", null);
      if (!saved || !saved.tmid || Date.now() - saved.at > 30 * 60 * 1000) {
        alert("没识别到这是哪套题。请回到「我的任务」列表，点任务卡片上的「AI 自动作答」。");
        return;
      }
      ensurePanel();
      await runForTask(saved, null);
    };
    document.body.appendChild(btn);
  }

  function boot() {
    try {
      bootInner();
    } catch (e) {
      logLine("error", "插件启动失败：" + (e && e.message ? e.message : String(e)));
      console.error("[yzj] 启动失败", e);
    }
  }

  function bootInner() {
    injectStyle();
    captureGlobals();
    logLine("info", `脚本启动 v${YZJ_VERSION}：${location.pathname}${location.hash.slice(0, 30)}`);
    showLauncher();                       // 每个 csgmooc 页面右下角都常驻入口
    // 提交队列：到点的在这里自动交卷（任何 csgmooc 页面都会检查，关掉页面也不影响下次继续）
    setTimeout(() => processSubmitQueue(), 2500);
    setInterval(() => processSubmitQueue(), 20000);
    if (location.pathname.endsWith("stud_task.html")) {
      rememberClickedTask();
      const timer = setInterval(() => {
        if (decorateTaskCards() > 0) { clearInterval(timer); log("任务卡片已加按钮"); }
      }, 1500);
      decorateTaskCards();
      setTimeout(() => clearInterval(timer), 60000);
      // 无人值守：设置里开了就自动开始；已经在跑的继续跑（交卷后会回到这个页面）
      const ua = UA.read();
      if (ua && ua.active) {
        say(`无人值守进行中（已完成 ${ua.done.length} 套），3 秒后继续…`);
        setTimeout(() => uaTick(), 3000);
      } else if (CFG.unattended) {
        setTimeout(() => uaStart(true), 3000);
      }
    }
    if (onTestPage()) {
      const t = setInterval(() => { if (document.querySelector(".answer-title")) { addTestPageButton(); clearInterval(t); } }, 1500);
      setTimeout(() => clearInterval(t), 60000);
    }
    maybeFinalize();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 调试/自检入口（也方便后续扩展与自动化测试）
  window.__yzj = {
    VERSION: YZJ_VERSION, CFG,
    selfCheck, serverAnswered, readScore, submitByApi, submitViaApi, verifyGraded,
    finalizeNow, answerOne, judgeTask, writeTask, runForTask, batchAll,
    infoFromCard, explainError,
    histAll, histAdd, histUpdate, histCsv, lowConfItems, unsupportedTypes, openHistory,
    openSettings,
    openLog, logText, logLine, flushLog,
    acquireLock, lockInfo, releaseLock, lockBusyMessage,
    deliverSubmit, enqueueSubmit, submitQueueAll, processSubmitQueue,
    uaTick, uaStart, uaStop, buildPrompt, buildTextPrompt, askAI, esc,
    bankKeys, bankPut, bankLookup, bankDel, bankStats, bankAll, bankLearn, openBank,
    imageFingerprints, dHash64, normText, hash32, applyScoreAndLearn,
    hammingHex,
    // v1.4.0
    inspectTask, normalizeAnswer, matchSkipRule, questionPlainText, optionLetters,
    mergeDefaultSkipRules, ensureSkipRules, saveSkipRules, parseRuleLines, rulesToText,
    saveSkipRulesVersion,
    budgetFor, typeInstruction, fetchPaperQuestions, mapQuestion,
    SkipError, Q_TYPE, Q_TYPE_NAME, SUPPORTED_Q_TYPES, HOMEWORK_Q_TYPES, BLANK_SEP,
    DEFAULT_SKIP_RULES, SKIP_RULES_VERSION,
    // v1.4.1 作业/主观题
    DES, mapHomework, judgeHomework, submitHomework, toHtmlAnswer,
    // v1.4.6 面板（方便自动化测试直接开面板/入口）
    ensurePanel, showLauncher, launcherEl,
    // v1.4.7 来源标注（题库里每题记课程/班级/学号）
    loadTaskMeta, metaFor, accountTag,
    // v1.5.0 AI 报错（对齐 DeepSeek 官方错误码）
    AI_HTTP_DOC, AI_BACKOFF, aiErrorInfo, aiHttpCode, explainErrorDoc,
    // v1.6.0 多服务商 + 模型检测
    AI_PROVIDERS, AI_PROTOCOLS, PROTO_LABEL, AI_HTTP_GENERIC, PROVIDER_ERR,
    providerById, guessProviderId, aiReady, aiDocFor,
    aiUrl, aiHeaders, aiBody, aiTextOf, aiFinishOf, aiUsageOf, splitDataUrl,
    parseModelList, fetchModelList, testAiConnection, modelForRequest,
  };
})();
