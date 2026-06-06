// Deadline MVP - 纯前端 H5
// 浏览器直调 OpenAI 协议 API · localStorage 存任务
(function () {
  'use strict';

  // ============ 常量 ============
  const STORAGE_KEY_CFG  = 'dlm_config';
  const STORAGE_KEY_TASKS = 'dlm_tasks';
  const TYPE_LABELS = { homework: '作业', exam: '考试', registration: '报名', assignment: '任务', other: '其他' };
  const TYPE_EMOJI = { homework: '📚', exam: '📝', registration: '🎟️', assignment: '📌', other: '📦' };
  const TYPE_COLORS = {
    homework:      'bg-blue-100 text-blue-700',
    exam:          'bg-red-100 text-red-700',
    registration:  'bg-purple-100 text-purple-700',
    assignment:    'bg-amber-100 text-amber-700',
    other:         'bg-gray-100 text-gray-700',
  };

  const PRESETS = {
    doubao:    { baseURL: 'https://ark.cn-beijing.volces.com/api/v3',              model: 'doubao-1-5-vision-pro-32k-250115' },
    qwen:      { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',      model: 'qwen-vl-plus' },
    deepseek:  { baseURL: 'https://api.deepseek.com/v1',                            model: 'deepseek-chat' },
    openai:    { baseURL: 'https://api.openai.com/v1',                              model: 'gpt-4o-mini' },
    openrouter:{ baseURL: 'https://openrouter.ai/api/v1',                           model: 'google/gemini-2.0-flash-exp:free' },
  };

  // ============ AI 提示词（与 backend/services/ai-prompts.js 保持一致） ============
  const SYSTEM_PROMPT = `
# 角色
你是一个大学生作业/任务提取助手。你的任务是从用户上传的截图、PDF 或纯文本中,
识别出所有"任务"(作业/考试/报名/竞赛/通知/课程/重复事项 等)。

你不是聊天助手,不是作业答疑助手,不是日程规划助手。
你只做"识别 + 结构化"这一件事,其他一概不答。

# 任务
1. 阅读输入内容(可能是一张图片,可能是 PDF 页面,可能是纯文本,可能是口语化的"帮我建个任务")
2. 识别其中**所有**任务 —— 包括:
   - 有截止时间的(作业/考试/报名): 提取 deadline
   - **周期性的**(每周二/每月10号/每3天): is_recurring=true,recurrence 填规则,deadline **留空字符串**
   - 口语意图("帮我设置一个周期任务" "记一下每周三"): 也算任务,尽力推断;推断不出的就用空 title + confidence 0.3 让用户补
3. 对每个任务,严格按下方 JSON Schema 输出
4. **重要**: 如果完全看不出任何任务(连口语意图都没有),返回 {"tasks": []}

# 输出结构(JSON,必须可被 JSON.parse 解析)
{
  "tasks": [
    {
      "title": "string,≤50字",
      "description": "string,≤500字,可空",
      "deadline": "ISO 8601 with +08:00,如 2026-06-10T23:59:00+08:00",
      "type": "homework|exam|registration|assignment|other",
      "urgency": "high|medium|low(任务本身的重要度,跟 deadline 远近无关!期末考/竞赛报名=high,日常作业=medium,顺手做的事=low)",
      "estimated_prep_days": "number, 1-30, 任务制作周期/需要多少天完成(视频作业≈7,PPT≈2,小作业≈1,期末考复习≈14)",
      "is_recurring": "boolean, 是否周期任务(每周二/每月10号/每3天 等)",
      "recurrence": {
        "freq": "weekly|biweekly|monthly|custom",
        "interval_days": "number, 自定义频次时用,每 N 天(3/5/7 等)",
        "recurrence_dates": ["ISO 日期数组, 用户在月历里点选的具体日期,如 [2026-06-09, 2026-06-12, 2026-06-22]"],
        "start_date": "ISO 日期, 周期开始",
        "end_date": "ISO 日期 or null, 周期结束(可空,无限重复)"
      },
      "remind_before": [3, 1],
      "confidence": 0.0~1.0,
      "raw_text": "从原图中**直接抄录**的任务相关原文,50~200字"
    }
  ]
}

# 时间解析规则(关键)
- 当前时间:系统会通过 user 消息注入,你**必须**基于此推算相对时间
- 相对时间: "明天下午5点" = (今天+1) 17:00:00;"下周五" = 下一个周五 23:59:00
- 中文日期: "6月10号" / "6月10日" / "六月十号" 都解析为月+日
- 默认时间: 仅说"X日前"没说具体时刻 → 23:59:00
- 截止日期: 必须是**未来**(对比当前时间),过期时间的 confidence 设为 0.3
- 时区: 一律 +08:00(北京时间)
- ISO 8601 格式: "YYYY-MM-DDTHH:mm:ss+08:00"

# 多任务处理
- 一张截图/一段文字可能包含多个独立任务(如"高数作业+英语翻译+大创报名")
- 每个任务输出一个独立对象,放入 tasks 数组
- 若完全识别不出任务(如"hi" "你好"),返回 {"tasks": []},**不要兜底**
- 若用户口语"帮我建一个周期任务/记一下每周X"但没说具体内容,也要返回 1 个占位任务(title 留空,confidence 0.3,is_recurring=true,freq=weekly),让用户在前端补
- 若只能识别出部分(如文字模糊看不清),只输出能确认的,confidence 给低分

# 周期任务识别要点
- "每周X" / "每周X/X" → freq=weekly,recurrence_dates 取下个匹配 X 的日期(作为示例)
- "每两周X" / "隔周X" → freq=biweekly
- "每月X号" / "每月X/X号" → freq=monthly,recurrence_dates 取本月 X 号
- "每N天" / "N天一次" → freq=custom,interval_days=N
- start_date 默认今天(用 user 消息里注入的当前时间)
- end_date 默认 null(无限重复)
- 周期任务 deadline 留空字符串 ""(用户在前端月历里点,或者不填用 start_date)

# 质量红线(违反即失败)
1. deadline 必须是 ISO 8601 字符串,不能是"明天下午5点"这种自然语言
2. 字段名严格用英文(title/description/deadline/type/urgency/is_recurring/recurrence/remind_before/confidence/raw_text),值用中文
3. confidence < 0.6 时,在 description 末尾加 "[AI不确定,请人工核对]"
4. 不要输出 JSON 之外的任何文字(不要"好的,以下是..."这种开场白,不要 markdown 代码块)
5. 不要编造没在原文中出现的时间或任务

# 🪞 自检(输出前在心里过一遍)
- [ ] tasks 是数组吗?即使 0 个也要返回数组
- [ ] deadline 是不是 ISO 8601 格式(以 +08:00 结尾)?
- [ ] 截图里所有的任务都识别完了吗?(尤其是多个并列的)
- [ ] 相对时间是相对于"当前时间"算的,不是相对于训练截止日
- [ ] 没识别的内容 raw_text 留空字符串,不要瞎编
- [ ] confidence 是否反映了真实把握度(看得清的→高,模糊的→低)

# 输入/输出模板
输入: [图片 + "当前时间: 2026-06-04 12:41 +08:00, 来源类型: qq"]
输出: { "tasks": [ {title, description, deadline, type, remind_before, confidence, raw_text}, ... ] }
`.trim();

  // ============ 拆解追问(单任务) ============
  const CLARIFY_SYSTEM_PROMPT = `
# 角色
你是大学生任务拆解的"提问助手"。给定一个已识别出来的任务(如"高数期末论文 6/20 提交"),
你的工作是**问 1-3 个能显著影响后续拆解粒度的问题**,不是拆解本身。

# 任务
1. 仔细看输入的任务字段(title/description/deadline/type/urgency/estimated_prep_days)
2. 想清楚:**哪些信息不补,后面拆的步骤要么太粗要么太细?**
3. 输出 1-3 个澄清问题,每个问题:
   - 必须是**单选**(type: "single")—— 选项让用户能一键点,体验最好
   - 选项互斥且穷尽(必要时最后一个选项写"其他/不确定")
   - 不要问用户已经知道能从任务字段里推出的事
   - 不要问开放式问题(如"你有什么想法?")

# 问题质量红线
- ❌ 不要问"任务是什么"(任务已经给了)
- ❌ 不要问"截止时间"(已经在 deadline 里)
- ❌ 不要问太宽的(如"你的目标是什么?")
- ✅ 问"高数论文 8000 字还是 15000 字?"——**影响步骤数量和细化程度**
- ✅ 问"现在是没开始/做了一半/快收尾了?"——**影响从哪步开始**
- ✅ 问"小组作业还是个人作业?"——**影响是否需要协作步骤**

# 不同任务类型的关注点(参考,不必全用)
- 作业/论文(homework/assignment): 问字数/页数、类型(研究/综述/案例)、个人/小组、当前进度
- 考试(exam): 问范围(全册/章节)、开卷/闭卷、是否需要复习计划
- 报名(registration): 问材料是否齐、是否需要审批/盖章、是否抢名额
- 其他(other): 灵活,但仍要"影响拆解粒度"

# 输出结构(JSON,必须可被 JSON.parse 解析)
{
  "questions": [
    {
      "id": "q1",
      "text": "问用户的具体问题文字",
      "type": "single",
      "options": ["选项A", "选项B", "选项C"]
    }
  ]
}

# 数量控制
- 简单任务(deadline <3天,无 estimated_prep_days) → 0~1 个问题(信息够了,直接拆)
- 中等任务(3-7天) → 1~2 个问题
- 复杂任务(>7天 或 exam/assignment) → 2~3 个问题

# 自检
- [ ] 每个问题都有 2-5 个选项?
- [ ] 最后一个选项是不是"其他/不确定/还没想好"兜底?
- [ ] 问题总数 ≤3?
- [ ] 不要 markdown 包裹,直接 JSON
`.trim();

  // ============ 任务拆解(基于追问答案) ============
  const BREAKDOWN_SYSTEM_PROMPT = `
# 角色
你是大学生任务拆解助手。给定一个已识别的任务 + 用户对澄清问题的回答,
把任务拆成 3-7 步**可立即执行**的 checklist。

# 任务
1. 综合任务字段 + 用户回答,推出合理的执行步骤
2. 每一步必须:
   - 是**动作**(动词开头,"找文献"✅, "文献"❌)
   - 粒度适中(不要"打开电脑"这种废话,也不要"完成第三章第二节第二段"这种过细)
   - 必要时括号备注关键细节(字数/比例/数量/工具),帮助用户立刻知道做到什么程度算完成
3. 步骤之间要**有先后依赖**(前一步是后一步的前置)

# 颗粒度参考
- estimated_prep_days ≤ 2(签到/小作业) → 拆 3 步
- 3-7 天(PPT/小论文/报名) → 拆 4-5 步
- 7-14 天(视频/中等论文) → 拆 5-6 步
- >14 天(期末考/毕设) → 拆 6-7 步

# 用户回答的处理
- 用户选了"还没开始"→ 从准备/选题/资料 起步
- 用户选了"有一半了"→ 跳过已完成部分,从中间起步
- 用户选了"只差收尾"→ 聚焦润色/查重/提交
- 用户说"8000字" vs "15000字" → 体现在"写一稿"步骤的备注里
- 用户说"小组作业" → 包含"分工""对齐进度"等协作步骤

# 输出结构(JSON,必须可被 JSON.parse 解析)
{
  "steps": [
    "步骤1: 动作描述(关键备注)",
    "步骤2: 动作描述(关键备注)",
    "步骤3: 动作描述(关键备注)"
  ]
}

# 质量红线
- ❌ 步骤不能是名词("大纲")→ ✅ 必须是动作("列 3 个候选选题方向")
- ❌ 不要"完成""搞定"这种空话 → ✅ 要具体("改二稿:补论据 + 调结构")
- ❌ 不要重复任务的 deadline 表述
- ❌ 不要 markdown 包裹,直接 JSON
- ❌ 不要"以上是..."开场白

# 自检
- [ ] 步骤总数在 3-7 之间?
- [ ] 每步都是动词开头?
- [ ] 用户答案的关键信息(字数/进度/类型)有没有体现在步骤备注里?
- [ ] 步骤顺序对吗?(先准备→后执行→最后收尾)
`.trim();

  function buildUserPrompt(source) {
    const now = new Date();
    const tzOffsetMs = now.getTimezoneOffset() * 60 * 1000;
    const localISO = new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 19);
    return `当前时间: ${localISO} +08:00, 来源类型: ${source}。请按 system 指令提取任务。`;
  }

  // ============ 状态 ============
  let currentTab = 'pending';
  let currentView = 'list';
  let currentCalDate = new Date(); // 周历/月历当前显示的日期
  let filterKeyword = '';
  let filterType = '';
  let filterUrgency = '';
  let selectedSource = 'qq';
  let currentFile = null; // { dataUrl, mimeType, name }
  let pendingTasks = [];  // AI 提取后待确认的

  // ============ 存储 ============
  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_CFG)) || {}; } catch { return {}; }
  }
  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY_CFG, JSON.stringify(cfg));
  }
  function loadTasks() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TASKS)) || []; } catch { return []; }
  }
  function saveTasks(tasks) {
    localStorage.setItem(STORAGE_KEY_TASKS, JSON.stringify(tasks));
  }

  // ============ UI 工具 ============
  function toast(message, type = 'info', duration = 2500) {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 200);
    }, duration);
  }

  function showLoading(text = '加载中...') {
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `<div class="spinner"></div><div>${text}</div>`;
    document.body.appendChild(overlay);
    return () => overlay.remove();
  }

  // 🎉 庆祝动画: 中央爆开 + 顶部 confetti 飘落
  function celebrate() {
    // 中心 🎉
    const burst = document.createElement('div');
    burst.className = 'celebrate-burst';
    burst.textContent = '🎉';
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 1300);

    // confetti 雨
    const overlay = document.createElement('div');
    overlay.className = 'celebrate-overlay';
    document.body.appendChild(overlay);
    const emojis = ['🎉', '✨', '🌟', '💫', '🎊', '⭐', '🥳', '👏', '🏆', '💪'];
    for (let i = 0; i < 40; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      c.style.left = Math.random() * 100 + 'vw';
      c.style.fontSize = (16 + Math.random() * 18) + 'px';
      c.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      c.style.animationDelay = Math.random() * 0.5 + 's';
      overlay.appendChild(c);
    }
    setTimeout(() => overlay.remove(), 3500);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[<>&"']/g, c => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function typeLabel(t) { return (TYPE_EMOJI[t] || '📦') + ' ' + (TYPE_LABELS[t] || t || '其他'); }
  function typeColor(t) { return TYPE_COLORS[t] || TYPE_COLORS.other; }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatCountdown(deadline) {
    const now = Date.now();
    const ts = new Date(deadline).getTime();
    const diff = ts - now;
    if (isNaN(ts)) return { text: '⚠️ 时间无效', cls: 'text-gray-500' };
    if (diff < 0) {
      const days = Math.floor(-diff / (24 * 3600 * 1000));
      if (days === 0) return { text: '💀 已过期', cls: 'text-red-600 font-medium' };
      return { text: `💀 已过期 ${days} 天`, cls: 'text-red-600 font-medium' };
    }
    const days = Math.floor(diff / (24 * 3600 * 1000));
    const hours = Math.floor((diff % (24 * 3600 * 1000)) / (3600 * 1000));
    if (days === 0) {
      if (hours < 6) return { text: `🔥 ${hours}小时后`, cls: 'text-red-600 font-medium' };
      return { text: `⏰ 今天 ${hours}时`, cls: 'text-red-600 font-medium' };
    }
    if (days === 1) return { text: '⚡ 明天', cls: 'text-red-600 font-medium' };
    if (days <= 3) return { text: `🍊 ${days}天后`, cls: 'text-orange-600 font-medium' };
    return { text: `🌳 ${days}天后`, cls: 'text-gray-600' };
  }

  // 紧迫度: 按 deadline 远近自动算(不存,前端实时算)
  //  红色 < 1 天 / 过期
  //  橙色 1-3 天
  //  绿色 > 3 天
  function computeUrgencyLevel(deadline) {
    const ts = new Date(deadline).getTime();
    if (isNaN(ts)) return 'green';
    const diff = ts - Date.now();
    if (diff < 0) return 'red';
    const days = diff / (24 * 3600 * 1000);
    if (days < 1) return 'red';
    if (days <= 3) return 'orange';
    return 'green';
  }
  const URGENCY_BAR = {
    red:    'border-l-4 border-red-500',
    orange: 'border-l-4 border-orange-400',
    green:  'border-l-4 border-green-500',
  };
  const URGENCY_BAR_BG = {
    red:    'bg-red-500',
    orange: 'bg-orange-400',
    green:  'bg-green-500',
  };
  // 重要度(任务性质,跟 deadline 无关): high/medium/low → 标签 + 颜色 + emoji
  const URGENCY_OPTIONS = [
    { value: 'high',   label: '重要', emoji: '🔴', color: 'text-red-600 border-red-400 bg-red-50' },
    { value: 'medium', label: '普通', emoji: '🔵', color: 'text-blue-600 border-blue-400 bg-blue-50' },
    { value: 'low',    label: '次要', emoji: '⚪', color: 'text-gray-500 border-gray-300 bg-gray-50' },
  ];
  function getImportanceMeta(level) {
    return URGENCY_OPTIONS.find(o => o.value === level) || URGENCY_OPTIONS[1];
  }
  function starsHtml(level) {
    const meta = getImportanceMeta(level);
    return `<span class="text-xs px-2 py-0.5 rounded border ${meta.color} font-medium">${meta.emoji} ${meta.label}</span>`;
  }

  // 提醒提前量选项(用户自由勾选)
  const REMIND_OPTIONS = [1, 3, 7, 14];
  // 根据制作周期推默认勾选(只在 AI 给了 estimated_prep_days 时用)
  function deriveRemindByPrepDays(days) {
    if (days <= 1)  return [1];
    if (days <= 3)  return [3, 1];
    if (days <= 7)  return [7, 3, 1];
    return [14, 7, 3, 1];
  }

  // ============ 周期任务 ============
  // 频次选项
  const FREQ_OPTIONS = [
    { value: 'weekly',    label: '📅 每周',  desc: '按星期几重复' },
    { value: 'biweekly',  label: '🗓️ 每两周', desc: '隔周重复' },
    { value: 'monthly',   label: '📆 每月',  desc: '按几号重复' },
    { value: 'custom',    label: '🔁 自定义', desc: '每 N 天重复' },
  ];
  // 星期标签
  const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

  // 把 YYYY-MM-DD 转 Date(本地 0 点)
  function parseISODate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function toISODate(d) {
    if (!d) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 算周期任务"下次发生时间"(今天之后)
  //  rec: { freq, interval_days, recurrence_dates:[ISO], start_date, end_date }
  //  lastCompletedAt: ISO 字符串(可选),如果今天已"本次完成",则跳过今天
  //  返回: { nextDate: ISO, isLast: bool } 或 null(已过期)
  function nextOccurrence(rec, lastCompletedAt) {
    if (!rec || !rec.start_date) return null;
    const start = parseISODate(rec.start_date);
    const end = rec.end_date ? parseISODate(rec.end_date) : null;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    // "本次完成"在今天 → 最小查询日期跳到明天
    let minDate = today;
    if (lastCompletedAt) {
      const lc = new Date(lastCompletedAt);
      lc.setHours(0, 0, 0, 0);
      if (lc >= today) {
        minDate = new Date(today); minDate.setDate(minDate.getDate() + 1);
      }
    }

    if (end && end < minDate) return null; // 已过结束日期

    if (rec.freq === 'custom' && rec.interval_days) {
      const n = rec.interval_days;
      let cur = new Date(start);
      if (cur < minDate) {
        const diff = Math.floor((minDate - cur) / (24 * 3600 * 1000));
        const advance = Math.ceil(diff / n) * n;
        cur.setDate(cur.getDate() + advance);
      }
      if (end && cur > end) return null;
      return { nextDate: toISODate(cur), isLast: end && cur >= end };
    }

    if (!rec.recurrence_dates || rec.recurrence_dates.length === 0) return null;
    const dates = rec.recurrence_dates.map(parseISODate).filter(Boolean).sort((a, b) => a - b);
    if (dates.length === 0) return null;

    if (rec.freq === 'weekly') {
      const wds = [...new Set(dates.map(d => d.getDay()))].sort();
      if (wds.length === 0) return null;
      for (let i = 0; i < 14; i++) {
        const d = new Date(minDate); d.setDate(d.getDate() + i);
        if (wds.includes(d.getDay())) {
          if (end && d > end) return null;
          return { nextDate: toISODate(d), isLast: false };
        }
      }
      return null;
    }

    if (rec.freq === 'biweekly') {
      const wds = [...new Set(dates.map(d => d.getDay()))].sort();
      if (wds.length === 0) return null;
      const startMon = new Date(start); startMon.setDate(startMon.getDate() - startMon.getDay());
      for (let i = 0; i < 28; i++) {
        const d = new Date(minDate); d.setDate(d.getDate() + i);
        if (!wds.includes(d.getDay())) continue;
        const dMon = new Date(d); dMon.setDate(dMon.getDate() - dMon.getDay());
        const weekDiff = Math.floor((dMon - startMon) / (7 * 24 * 3600 * 1000));
        if (weekDiff % 2 !== 0) continue;
        if (end && d > end) return null;
        return { nextDate: toISODate(d), isLast: false };
      }
      return null;
    }

    if (rec.freq === 'monthly') {
      const days = [...new Set(dates.map(d => d.getDate()))].sort((a, b) => a - b);
      if (days.length === 0) return null;
      for (let monthOffset = 0; monthOffset < 24; monthOffset++) {
        const year  = minDate.getFullYear() + Math.floor((minDate.getMonth() + monthOffset) / 12);
        const month = (minDate.getMonth() + monthOffset) % 12;
        for (const day of days) {
          const d = new Date(year, month, day);
          if (d < minDate) continue;
          if (end && d > end) return null;
          return { nextDate: toISODate(d), isLast: monthOffset > 0 };
        }
      }
      return null;
    }

    return null;
  }

  // 把"在月历里点选的日期"按 freq 归一化成 recurrence_dates
  //  weekly/biweekly: 存对应 weekday 的"示例日期"(取第一个)
  //  monthly: 存对应 day-of-month 的"示例日期"
  //  custom: 忽略 recurrence_dates,用 interval_days
  function normalizeRecurrence(rec) {
    if (!rec) return null;
    if (rec.freq === 'custom') {
      return { ...rec, recurrence_dates: [] };
    }
    if (!rec.recurrence_dates || rec.recurrence_dates.length === 0) return rec;
    if (rec.freq === 'weekly' || rec.freq === 'biweekly') {
      // 留一个示例日期,周几从它算
      const wd = rec.recurrence_dates.map(parseISODate).filter(Boolean).map(d => d.getDay());
      const uniqueWd = [...new Set(wd)].sort();
      // 找 start_date 所在月的一个匹配周几的日期
      const start = parseISODate(rec.start_date) || new Date();
      let sample = new Date(start);
      while (sample.getDay() !== uniqueWd[0]) sample.setDate(sample.getDate() + 1);
      return { ...rec, recurrence_dates: [toISODate(sample)] };
    }
    if (rec.freq === 'monthly') {
      const days = rec.recurrence_dates.map(parseISODate).filter(Boolean).map(d => d.getDate());
      const uniqueDays = [...new Set(days)].sort((a, b) => a - b);
      const start = parseISODate(rec.start_date) || new Date();
      const samples = uniqueDays.map(d => {
        // 找一个示例日期,用 start_date 所在月
        return toISODate(new Date(start.getFullYear(), start.getMonth(), Math.min(d, 28)));
      });
      return { ...rec, recurrence_dates: samples };
    }
    return rec;
  }

  // 频率简短标签
  function freqLabel(rec) {
    if (!rec) return '';
    if (rec.freq === 'custom') return `🔁 每 ${rec.interval_days || '?'} 天`;
    if (!rec.recurrence_dates || rec.recurrence_dates.length === 0) return '周期';
    const sample = parseISODate(rec.recurrence_dates[0]);
    if (!sample) return '周期';
    if (rec.freq === 'weekly' || rec.freq === 'biweekly') {
      const wds = rec.recurrence_dates.map(parseISODate).filter(Boolean).map(d => d.getDay());
      const unique = [...new Set(wds)].sort();
      return (rec.freq === 'biweekly' ? '🗓️ 每两周 ' : '📅 每周 ') + unique.map(d => '周' + WEEKDAY_LABELS[d]).join('·');
    }
    if (rec.freq === 'monthly') {
      const days = rec.recurrence_dates.map(parseISODate).filter(Boolean).map(d => d.getDate());
      const unique = [...new Set(days)].sort((a, b) => a - b);
      return '📆 每月 ' + unique.join('·') + ' 号';
    }
    return '周期';
  }

  // 任务拆解 checklist 渲染
  function renderChecklist(task) {
    const items = Array.isArray(task.checklist) ? task.checklist : [];
    const done = items.filter(i => i.done).length;
    const total = items.length;
    const pct = total ? Math.round(done / total * 100) : 0;

    if (total === 0) {
      return `
        <div class="border-2 border-dashed border-gray-300 rounded-lg p-3 text-center bg-gray-50">
          <div class="text-xs text-gray-500 mb-2">还没拆。让 AI 帮你拆成 3-7 步</div>
          <button type="button" data-breakdown-btn
            class="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 font-medium">
            🧠 智能拆解
          </button>
        </div>
      `;
    }

    return `
      <div class="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
        <div class="flex items-center justify-between text-xs text-gray-600">
          <span>📋 进度: <b>${done}/${total}</b> (${pct}%)</span>
          <button type="button" data-breakdown-btn
            class="text-blue-600 hover:underline">🔄 重新拆解</button>
        </div>
        <div class="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-blue-500 to-green-500 transition-all" style="width:${pct}%"></div>
        </div>
        <div class="space-y-1 pt-1" data-checklist-list>
          ${items.map(item => `
            <div class="flex items-center gap-2 bg-white rounded px-2 py-1.5 border border-gray-200 group">
              <input type="checkbox" data-checklist-done data-check-id="${item.id}" ${item.done ? 'checked' : ''}
                class="w-4 h-4 flex-shrink-0 cursor-pointer">
              <input type="text" data-checklist-text data-check-id="${item.id}" value="${escapeHtml(item.text)}"
                maxlength="200"
                class="flex-1 text-sm bg-transparent border-none focus:outline-none ${item.done ? 'line-through text-gray-400' : 'text-gray-800'}">
              <button type="button" data-checklist-remove data-check-id="${item.id}"
                class="text-red-400 hover:text-red-600 text-xs opacity-0 group-hover:opacity-100 transition px-1">×</button>
            </div>
          `).join('')}
        </div>
        <button type="button" data-checklist-add
          class="w-full text-xs py-1.5 border border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-600">
          + 添加步骤
        </button>
      </div>
    `;
  }

  // 月历点选器(用于周期任务选具体日期)
  // onChange: (selectedDates: ISO[]) => void
  // 复用组件: 多个具体时刻输入(单次和周期任务都用)
  function renderRemindTimes(times) {
    const list = (times && times.length) ? times : ['08:00'];
    return `
      <div class="space-y-2" data-remind-times-wrap>
        <div class="text-xs text-gray-500">每天这几个时刻提醒(可加可减,最多 3 个)</div>
        <div class="flex flex-wrap gap-2">
          ${list.map((t, i) => `
            <div class="flex items-center gap-1 bg-white border border-gray-300 rounded-lg px-2 py-1">
              <input type="time" data-time-idx="${i}" value="${t}"
                class="text-sm focus:outline-none w-20">
              ${list.length > 1 ? `<button type="button" data-time-remove="${i}" class="text-red-400 hover:text-red-600 text-xs px-1">×</button>` : ''}
            </div>
          `).join('')}
          ${list.length < 3 ? `<button type="button" data-time-add class="text-xs px-3 py-1.5 border border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-600">+ 加时刻</button>` : ''}
        </div>
      </div>
    `;
  }

  // 频率切换后渲染的详细配置区
  function renderFreqDetail(task) {
    const rec = task.recurrence || { freq: 'weekly', recurrence_dates: [], start_date: toISODate(new Date()), end_date: null };
    if (rec.freq === 'custom') {
      return `
        <div class="text-xs text-gray-600 space-y-2">
          <div>从 <input type="date" data-custom-start value="${rec.start_date || toISODate(new Date())}" class="border rounded px-2 py-1 ml-1 text-xs"> 起,每
            <input type="number" data-custom-interval value="${rec.interval_days || 3}" min="1" max="365" class="border rounded px-2 py-1 mx-1 w-16 text-xs"> 天发生一次
          </div>
          <div>到 <input type="date" data-custom-end value="${rec.end_date || ''}" class="border rounded px-2 py-1 ml-1 text-xs"> 结束
            <span class="text-gray-400">(留空 = 无限重复)</span>
          </div>
        </div>
      `;
    }
    // weekly/biweekly/monthly 都用月历点选
    const today = new Date();
    const sel = rec.recurrence_dates || [];
    return renderMonthPicker(today.getFullYear(), today.getMonth(), sel, () => {});
  }

  // 月历点选器(用于周期任务选具体日期)
  // onChange: (selectedDates: ISO[]) => void
  function renderMonthPicker(year, month, selectedDates, onChange) {
    const firstDay = new Date(year, month, 1);
    const lastDay  = new Date(year, month + 1, 0);
    const startWd  = firstDay.getDay(); // 0=日
    const daysInMonth = lastDay.getDate();
    const sel = new Set(selectedDates);
    const cells = [];
    // 前面空格
    for (let i = 0; i < startWd; i++) cells.push(null);
    // 当月日期
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = toISODate(new Date(year, month, d));
      cells.push({ day: d, iso, selected: sel.has(iso) });
    }
    return `
      <div class="month-picker" data-year="${year}" data-month="${month}">
        <div class="flex items-center justify-between mb-2">
          <button type="button" data-cal-prev class="text-xs px-2 py-1 rounded hover:bg-gray-100">‹ 上月</button>
          <span class="text-sm font-medium">${year} 年 ${month + 1} 月</span>
          <button type="button" data-cal-next class="text-xs px-2 py-1 rounded hover:bg-gray-100">下月 ›</button>
        </div>
        <div class="grid grid-cols-7 gap-1 text-center text-xs text-gray-500 mb-1">
          ${['日','一','二','三','四','五','六'].map(w => `<div>${w}</div>`).join('')}
        </div>
        <div class="grid grid-cols-7 gap-1">
          ${cells.map(c => c === null
            ? '<div></div>'
            : `<button type="button" data-cal-day="${c.iso}" class="aspect-square rounded text-sm transition
                ${c.selected ? 'bg-blue-500 text-white font-medium' : 'hover:bg-blue-50 text-gray-700'}">${c.day}</button>`
          ).join('')}
        </div>
        <div class="mt-2 text-xs text-gray-500">已选 ${selectedDates.length} 天 · 点格子切换</div>
      </div>
    `;
  }

  // ============ 设置面板 ============
  function initSettings() {
    const cfg = loadConfig();
    document.getElementById('cfg-baseurl').value = cfg.baseURL || '';
    document.getElementById('cfg-key').value     = cfg.apiKey  || '';
    document.getElementById('cfg-model').value   = cfg.model   || '';

    document.querySelectorAll('[data-preset]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const p = PRESETS[a.dataset.preset];
        if (!p) return;
        document.getElementById('cfg-baseurl').value = p.baseURL;
        document.getElementById('cfg-model').value   = p.model;
        toast(`已填入 ${a.textContent} 预设`, 'info', 1500);
      });
    });

    document.getElementById('cfg-save').addEventListener('click', () => {
      const baseURL = document.getElementById('cfg-baseurl').value.trim();
      const apiKey  = document.getElementById('cfg-key').value.trim();
      const model   = document.getElementById('cfg-model').value.trim();
      if (!baseURL || !apiKey || !model) {
        toast('三项都要填', 'error');
        return;
      }
      saveConfig({ baseURL, apiKey, model });
      toast('已保存', 'success');
    });

    document.getElementById('cfg-test').addEventListener('click', async () => {
      const baseURL = document.getElementById('cfg-baseurl').value.trim();
      const apiKey  = document.getElementById('cfg-key').value.trim();
      const model   = document.getElementById('cfg-model').value.trim();
      if (!baseURL || !apiKey || !model) { toast('三项都要填', 'error'); return; }
      const url = baseURL.replace(/\/$/, '') + '/chat/completions';
      const hide = showLoading('测试连接...');
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: '说"ok"即可' }],
            max_tokens: 20,
          }),
        });
        if (!resp.ok) {
          const t = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
        }
        const data = await resp.json();
        const reply = data.choices?.[0]?.message?.content || '(无内容)';
        toast(`✅ 连接成功 · 回复: ${reply.slice(0, 30)}`, 'success', 4000);
      } catch (e) {
        // [调试] 详细错误日志
        console.error('[测试连接失败]', {
          url, model,
          errorName: e.name,        // TypeError / AbortError / etc.
          errorMsg:  e.message,     // Failed to fetch / Load failed / etc.
          stack:     e.stack?.split('\n').slice(0, 3).join('\n'),
        });
        const hint = e.name === 'TypeError' && e.message === 'Failed to fetch'
          ? ' (CORS/DNS/代理,看 Console)'
          : '';
        toast(`❌ 失败: ${e.message}${hint}`, 'error', 5000);
      } finally {
        hide();
      }
    });

    document.getElementById('settings-btn').addEventListener('click', () => {
      document.getElementById('settings-panel').classList.toggle('hidden');
    });
  }

  // ============ AI 提取 ============
  // 底层: 调 OpenAI 兼容协议,返回 JSON 解析后的对象
  async function callAIWithSystem(systemPrompt, userMessage, opts = {}) {
    const cfg = loadConfig();
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      throw new Error('请先在「设置」里填 Base URL / API Key / 模型名');
    }

    // userMessage 可以是 string,也可以是 content 数组(带图片)
    const userContent = typeof userMessage === 'string'
      ? [{ type: 'text', text: userMessage }]
      : userMessage;

    const url = cfg.baseURL.replace(/\/$/, '') + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 2048,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      // [调试] HTTP 状态码错误的详细日志
      console.error('[AI 调用 HTTP 失败]', {
        url, model: cfg.model, stage: opts.stage || '?',
        status: resp.status,
        statusText: resp.statusText,
        headers: Object.fromEntries(resp.headers.entries()),
        body: t.slice(0, 500),
      });
      throw new Error(`AI HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('AI 返回为空');

    // 清洗 markdown 包裹
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }
    try { return JSON.parse(cleaned); }
    catch (e) { throw new Error('AI 返回非 JSON: ' + raw.slice(0, 200)); }
  }

  // 上层 1: 提取主任务(带图)
  async function callAI(file, text) {
    const userContent = [];
    if (file) {
      userContent.push({ type: 'image_url', image_url: { url: file.dataUrl } });
    }
    userContent.push({ type: 'text', text: buildUserPrompt(selectedSource) + (text ? `\n\n附加文本: ${text}` : '') });

    const parsed = await callAIWithSystem(SYSTEM_PROMPT, userContent, { stage: 'extract' });
    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('AI 返回缺少 tasks 数组');
    }
    return parsed.tasks.map(t => {
      const merged = {
        type: 'other',
        urgency: 'medium',
        estimated_prep_days: null,
        is_recurring: false,
        recurrence: null,
        remind_before: [3, 1],
        remind_times: ['08:00'],
        confidence: 1.0,
        description: '',
        raw_text: '',
        ...t,
      };
      // 提醒提前量根据制作周期自动推
      if (merged.estimated_prep_days && !t.remind_before) {
        merged.remind_before = deriveRemindByPrepDays(merged.estimated_prep_days);
      }
      // 周期任务归一化
      if (merged.is_recurring && !merged.recurrence) {
        merged.is_recurring = false;
      }
      // 时刻格式校验
      if (Array.isArray(merged.remind_times)) {
        merged.remind_times = merged.remind_times
          .filter(t => /^\d{2}:\d{2}$/.test(t))
          .slice(0, 3);
        if (merged.remind_times.length === 0) merged.remind_times = ['08:00'];
      } else {
        merged.remind_times = ['08:00'];
      }
      return merged;
    });
  }

  // 上层 2: 追问(返回 1-3 个澄清问题)
  async function askClarifyingQuestions(task) {
    const userMsg = `请针对以下任务生成澄清问题:\n\n${JSON.stringify({
      title: task.title, description: task.description, deadline: task.deadline,
      type: task.type, urgency: task.urgency, estimated_prep_days: task.estimated_prep_days,
    }, null, 2)}`;
    const parsed = await callAIWithSystem(CLARIFY_SYSTEM_PROMPT, userMsg, {
      stage: 'clarify', maxTokens: 1024,
    });
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions
      .filter(q => q && q.text && Array.isArray(q.options) && q.options.length >= 2)
      .slice(0, 3)
      .map(q => ({
        id: q.id || ('q' + Math.random().toString(36).slice(2, 7)),
        text: q.text,
        type: q.type || 'single',
        options: q.options.slice(0, 5),
      }));
  }

  // 上层 3: 拆解(基于追问答案返回 3-7 步 checklist)
  async function breakdownTask(task, answers) {
    // answers: [{ questionId, questionText, answer }]
    const userMsg = `请拆解以下任务:\n\n任务信息:\n${JSON.stringify({
      title: task.title, description: task.description, deadline: task.deadline,
      type: task.type, urgency: task.urgency, estimated_prep_days: task.estimated_prep_days,
    }, null, 2)}\n\n用户回答的澄清问题:\n${answers.map(a => `- ${a.questionText}\n  → ${a.answer}`).join('\n')}`;
    const parsed = await callAIWithSystem(BREAKDOWN_SYSTEM_PROMPT, userMsg, {
      stage: 'breakdown', maxTokens: 1024,
    });
    if (!Array.isArray(parsed.steps)) return [];
    return parsed.steps
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .slice(0, 7)
      .map(text => ({
        id: 'c' + Math.random().toString(36).slice(2, 10),
        text: text.trim(),
        done: false,
      }));
  }

  // ============ 上传区 ============
  function initUpload() {
    const uploadArea    = document.getElementById('upload-area');
    const fileInput     = document.getElementById('file-input');
    const previewBox    = document.getElementById('preview-container');
    const previewImg    = document.getElementById('preview-image');
    const previewClear  = document.getElementById('preview-clear');
    const textInput     = document.getElementById('text-input');
    const extractBtn    = document.getElementById('extract-btn');

    // 来源切换
    document.querySelectorAll('.source-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.source-chip').forEach(b => {
          b.className = 'source-chip flex-1 py-1.5 rounded-lg border border-gray-300 text-gray-600';
        });
        btn.className = 'source-chip flex-1 py-1.5 rounded-lg border border-gray-300 bg-blue-50 text-blue-700 font-medium';
        selectedSource = btn.dataset.source;
      });
    });

    function refreshExtractEnabled() {
      const has = currentFile || textInput.value.trim();
      extractBtn.disabled = !has;
    }

    function readFile(file) {
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast('MVP 阶段只支持图片，PDF 暂未支持', 'error');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        toast('文件超过 5MB', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = e => {
        currentFile = { dataUrl: e.target.result, mimeType: file.type, name: file.name };
        previewImg.src = e.target.result;
        previewBox.classList.remove('hidden');
        uploadArea.classList.add('hidden');
        refreshExtractEnabled();
      };
      reader.readAsDataURL(file);
    }

    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => readFile(e.target.files[0]));
    uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('border-blue-400'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('border-blue-400'));
    uploadArea.addEventListener('drop', e => {
      e.preventDefault();
      uploadArea.classList.remove('border-blue-400');
      readFile(e.dataTransfer.files[0]);
    });

    previewClear.addEventListener('click', () => {
      currentFile = null;
      fileInput.value = '';
      previewBox.classList.add('hidden');
      uploadArea.classList.remove('hidden');
      refreshExtractEnabled();
    });

    textInput.addEventListener('input', refreshExtractEnabled);

    extractBtn.addEventListener('click', async () => {
      const text = textInput.value.trim();
      if (!currentFile && !text) return;
      const hide = showLoading('AI 正在识别...');
      try {
        const tasks = await callAI(currentFile, text);
        if (tasks.length === 0) {
          toast('AI 没识别出任务，换张图或加点文本再试', 'error', 4000);
          return;
        }
        pendingTasks = tasks;
        renderConfirm();
        document.getElementById('confirm-panel').classList.remove('hidden');
        document.getElementById('confirm-panel').scrollIntoView({ behavior: 'smooth' });
      } catch (e) {
        // [调试] 详细错误日志(覆盖网络层/解析层所有 throw)
        console.error('[AI 提取失败]', {
          errorName: e.name,
          errorMsg:  e.message,
          stack:     e.stack?.split('\n').slice(0, 3).join('\n'),
        });
        const hint = e.name === 'TypeError' && e.message === 'Failed to fetch'
          ? ' (CORS/DNS/代理,看 Console)'
          : '';
        toast(`❌ ${e.message}${hint}`, 'error', 5000);
      } finally {
        hide();
      }
    });
  }

  // ============ 确认面板 ============
  function renderConfirm() {
    const list = document.getElementById('confirm-list');
    const count = document.getElementById('confirm-count');
    list.innerHTML = '';
    count.textContent = pendingTasks.length;

    pendingTasks.forEach((task, i) => {
      const isLow = (task.confidence || 1) < 0.6;
      const isRec = !!task.is_recurring;
      // 周期任务: 不要紧迫度色条(没有"远近"概念),也不要"提前几天"提醒
      const barCls = isRec ? '' : URGENCY_BAR[task.deadline ? computeUrgencyLevel(task.deadline) : 'green'];
      const card = document.createElement('div');
      card.className = `bg-white rounded-xl border ${barCls} transition shadow-sm hover:shadow-md ${
        isLow ? 'border-amber-300' : 'border-gray-200'
      } p-4 space-y-2`;
      card.dataset.index = i;
      card.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="text-xs px-2 py-0.5 rounded ${isLow ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}">
            ${isLow ? '⚠️ AI 不确定' : '✨ 已识别'} · ${Math.round((task.confidence || 1) * 100)}%
          </span>
          <button data-action="remove" class="text-xs text-red-500 hover:underline">🗑 删除</button>
        </div>
        <div>
          <label class="block text-xs text-gray-600 mb-1">📝 任务名 *</label>
          <input data-field="title" type="text" maxlength="50" value="${escapeHtml(task.title || '')}"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs text-gray-600 mb-1">⏰ 截止时间 ${isRec ? '<span class="text-gray-400">(选填,留空用周期开始日期)</span>' : '* (ISO 8601 / +08:00)'}</label>
          <input data-field="deadline" type="${isRec ? 'date' : 'text'}" value="${isRec && task.deadline ? (task.deadline.split('T')[0]) : escapeHtml(task.deadline || '')}" placeholder="${isRec ? '' : '2026-06-10T23:59:00+08:00'}"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs text-gray-600 mb-1">⏰ 几点提醒(每天这几个时刻弹通知)</label>
          ${renderRemindTimes(task.remind_times)}
        </div>
        <div>
          <label class="block text-xs text-gray-600 mb-1">🏷️ 类型</label>
          <select data-field="type" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="homework"      ${task.type === 'homework'      ? 'selected' : ''}>📚 作业</option>
            <option value="exam"          ${task.type === 'exam'          ? 'selected' : ''}>📝 考试</option>
            <option value="registration"  ${task.type === 'registration'  ? 'selected' : ''}>🎟️ 报名</option>
            <option value="assignment"    ${task.type === 'assignment'    ? 'selected' : ''}>📌 任务</option>
            <option value="other"         ${task.type === 'other'         ? 'selected' : ''}>📦 其他</option>
          </select>
        </div>
        ${isRec ? '' : `
        <div>
          <label class="block text-xs text-gray-600 mb-1">🧩 任务拆解(checklist)</label>
          ${renderChecklist(task)}
        </div>
        `}
        ${isRec ? '' : `
        <div>
          <label class="block text-xs text-gray-600 mb-1">🎯 重要度(任务本身的重要/紧急程度)</label>
          <div class="flex gap-2">
            ${URGENCY_OPTIONS.map(o => `
              <button data-urgency="${o.value}" type="button"
                class="urgency-btn flex-1 py-2 rounded-lg border text-sm font-medium transition
                  ${task.urgency === o.value
                    ? o.color
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'}">
                ${o.emoji} ${o.label}
              </button>
            `).join('')}
          </div>
        </div>
        <div>
          <label class="block text-xs text-gray-600 mb-1">🔔 提前几天提醒(根据制作周期勾选,可多选)</label>
          <div class="flex gap-2">
            ${REMIND_OPTIONS.map(d => `
              <label class="remind-chip flex-1 flex items-center justify-center gap-1 py-2 rounded-lg border cursor-pointer text-sm transition
                ${(task.remind_before || []).includes(d)
                  ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'}">
                <input type="checkbox" data-remind="${d}" ${(task.remind_before || []).includes(d) ? 'checked' : ''} class="hidden">
                <span>${task.remind_before && task.remind_before.includes(d) ? '✅' : '⬜'}</span>
                <span>${d} 天前</span>
              </label>
            `).join('')}
          </div>
        </div>
        `}
        <div>
          <label class="block text-xs text-gray-600 mb-1">💬 详细说明</label>
          <textarea data-field="description" maxlength="500" rows="2"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">${escapeHtml(task.description || '')}</textarea>
        </div>
        <div>
          <label class="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" data-recurring-toggle ${isRec ? 'checked' : ''} class="w-4 h-4">
            <span>🔁 设为周期任务(每周/每月/自定义)</span>
          </label>
        </div>
        <div class="recurring-config ${isRec ? '' : 'hidden'} space-y-2">
          <div class="flex gap-1 flex-wrap">
            ${FREQ_OPTIONS.map(o => `
              <button type="button" data-freq="${o.value}"
                class="freq-btn px-3 py-1.5 rounded-lg border text-xs font-medium transition
                  ${(task.recurrence && task.recurrence.freq === o.value)
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'}">
                ${o.label}
              </button>
            `).join('')}
          </div>
          <div class="freq-detail">
            ${isRec ? renderFreqDetail(task) : ''}
          </div>
        </div>
        ${task.raw_text ? `
          <details class="text-xs text-gray-500">
            <summary class="text-blue-500 hover:underline cursor-pointer">📄 AI 看到的原文</summary>
            <div class="mt-2 p-2 bg-gray-50 rounded">${escapeHtml(task.raw_text)}</div>
          </details>
        ` : ''}
      `;
      card.querySelectorAll('[data-field]').forEach(el => {
        el.addEventListener('input', e => {
          pendingTasks[parseInt(card.dataset.index, 10)][e.target.dataset.field] = e.target.value;
        });
      });
      card.querySelectorAll('[data-urgency]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index, 10);
          pendingTasks[idx].urgency = btn.dataset.urgency;
          renderConfirm();
        });
      });
      card.querySelectorAll('[data-remind]').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = parseInt(card.dataset.index, 10);
          const day = parseInt(cb.dataset.remind, 10);
          const cur = pendingTasks[idx].remind_before || [];
          if (cb.checked) {
            if (!cur.includes(day)) pendingTasks[idx].remind_before = [...cur, day].sort((a, b) => b - a);
          } else {
            pendingTasks[idx].remind_before = cur.filter(d => d !== day);
          }
          renderConfirm();
        });
      });
      card.querySelector('[data-action="remove"]').addEventListener('click', () => {
        pendingTasks.splice(parseInt(card.dataset.index, 10), 1);
        renderConfirm();
        if (pendingTasks.length === 0) {
          document.getElementById('confirm-panel').classList.add('hidden');
          toast('已全部删除', 'info');
        }
      });

      // 周期任务开关
      const recToggle = card.querySelector('[data-recurring-toggle]');
      if (recToggle) {
        recToggle.addEventListener('change', () => {
          const idx = parseInt(card.dataset.index, 10);
          if (recToggle.checked) {
            pendingTasks[idx].is_recurring = true;
            if (!pendingTasks[idx].recurrence) {
              pendingTasks[idx].recurrence = {
                freq: 'weekly',
                interval_days: null,
                recurrence_dates: [],
                start_date: toISODate(new Date()),
                end_date: null,
              };
            }
          } else {
            pendingTasks[idx].is_recurring = false;
          }
          renderConfirm();
        });
      }
      // 频次切换
      card.querySelectorAll('[data-freq]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index, 10);
          const f = btn.dataset.freq;
          const old = pendingTasks[idx].recurrence || {};
          pendingTasks[idx].recurrence = {
            freq: f,
            interval_days: f === 'custom' ? (old.interval_days || 3) : null,
            recurrence_dates: old.recurrence_dates || [],
            start_date: old.start_date || toISODate(new Date()),
            end_date: old.end_date || null,
          };
          renderConfirm();
        });
      });
      // 月历: 点格子切换
      card.querySelectorAll('[data-cal-day]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index, 10);
          const iso = btn.dataset.calDay;
          const cur = pendingTasks[idx].recurrence?.recurrence_dates || [];
          if (cur.includes(iso)) {
            pendingTasks[idx].recurrence.recurrence_dates = cur.filter(d => d !== iso);
          } else {
            pendingTasks[idx].recurrence.recurrence_dates = [...cur, iso];
          }
          renderConfirm();
        });
      });
      card.querySelectorAll('[data-cal-prev], [data-cal-next]').forEach(btn => {
        btn.addEventListener('click', () => {
          // 暂不实现翻月(简单起见),刷新当前月
          renderConfirm();
        });
      });
      // 自定义频次
      const ci = card.querySelector('[data-custom-interval]');
      if (ci) ci.addEventListener('input', e => {
        const idx = parseInt(card.dataset.index, 10);
        pendingTasks[idx].recurrence.interval_days = parseInt(e.target.value, 10) || 3;
      });
      const cs = card.querySelector('[data-custom-start]');
      if (cs) cs.addEventListener('change', e => {
        const idx = parseInt(card.dataset.index, 10);
        pendingTasks[idx].recurrence.start_date = e.target.value;
      });
      const ce = card.querySelector('[data-custom-end]');
      if (ce) ce.addEventListener('change', e => {
        const idx = parseInt(card.dataset.index, 10);
        pendingTasks[idx].recurrence.end_date = e.target.value || null;
      });

      // 时刻: 改 / 加 / 删
      card.querySelectorAll('[data-time-idx]').forEach(inp => {
        inp.addEventListener('change', e => {
          const idx = parseInt(card.dataset.index, 10);
          const i = parseInt(e.target.dataset.timeIdx, 10);
          if (!pendingTasks[idx].remind_times) pendingTasks[idx].remind_times = ['08:00'];
          pendingTasks[idx].remind_times[i] = e.target.value;
        });
      });
      card.querySelectorAll('[data-time-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index, 10);
          const i = parseInt(btn.dataset.timeRemove, 10);
          pendingTasks[idx].remind_times = (pendingTasks[idx].remind_times || []).filter((_, k) => k !== i);
          if (pendingTasks[idx].remind_times.length === 0) pendingTasks[idx].remind_times = ['08:00'];
          renderConfirm();
        });
      });
      const addTime = card.querySelector('[data-time-add]');
      if (addTime) addTime.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index, 10);
        const cur = pendingTasks[idx].remind_times || ['08:00'];
        if (cur.length < 3) {
          pendingTasks[idx].remind_times = [...cur, '20:00'];
          renderConfirm();
        }
      });

      // Checklist 事件绑定
      const breakdownBtn = card.querySelector('[data-breakdown-btn]');
      if (breakdownBtn) {
        breakdownBtn.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index, 10);
          openClarifyModal(idx);
        });
      }
      card.querySelectorAll('[data-checklist-done]').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = parseInt(card.dataset.index, 10);
          const id = cb.dataset.checkId;
          const list = pendingTasks[idx].checklist || [];
          const item = list.find(i => i.id === id);
          if (item) { item.done = cb.checked; renderConfirm(); }
        });
      });
      card.querySelectorAll('[data-checklist-text]').forEach(inp => {
        inp.addEventListener('change', () => {
          const idx = parseInt(card.dataset.index, 10);
          const id = inp.dataset.checkId;
          const list = pendingTasks[idx].checklist || [];
          const item = list.find(i => i.id === id);
          if (item) { item.text = inp.value.trim(); }
        });
      });
      card.querySelectorAll('[data-checklist-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index, 10);
          const id = btn.dataset.checkId;
          pendingTasks[idx].checklist = (pendingTasks[idx].checklist || []).filter(i => i.id !== id);
          renderConfirm();
        });
      });
      const addCheck = card.querySelector('[data-checklist-add]');
      if (addCheck) addCheck.addEventListener('click', () => {
        const idx = parseInt(card.dataset.index, 10);
        if (!pendingTasks[idx].checklist) pendingTasks[idx].checklist = [];
        pendingTasks[idx].checklist.push({
          id: 'c' + Math.random().toString(36).slice(2, 10),
          text: '新步骤',
          done: false,
        });
        renderConfirm();
      });

      list.appendChild(card);
    });
  }

  // ============ 智能拆解: 追问 + 拆解流程 ============
  let clarifyTaskIdx = -1;     // 当前正在拆的 task 在 pendingTasks 里的下标
  let clarifyAnswers = [];     // [{ questionId, questionText, answer }]

  function openClarifyModal(taskIdx) {
    const task = pendingTasks[taskIdx];
    if (!task) return;
    clarifyTaskIdx = taskIdx;
    clarifyAnswers = [];

    const modal = document.getElementById('clarify-modal');
    const container = document.getElementById('clarify-questions');
    modal.classList.remove('hidden');
    container.innerHTML = '<div class="text-center text-sm text-gray-500 py-4">🤖 AI 在想该问什么...</div>';

    askClarifyingQuestions(task).then(questions => {
      if (!questions || questions.length === 0) {
        // AI 判断不用追问,直接拆
        container.innerHTML = '<div class="text-center text-sm text-gray-500 py-4">✨ 任务够清楚了,直接拆 ↓</div>';
        return;
      }
      container.innerHTML = questions.map((q, qi) => `
        <div>
          <div class="text-sm font-medium text-gray-800 mb-2">Q${qi + 1}. ${escapeHtml(q.text)}</div>
          <div class="flex flex-wrap gap-2" data-q-id="${q.id}" data-q-text="${escapeHtml(q.text)}">
            ${q.options.map((opt, oi) => `
              <button type="button" data-opt-idx="${oi}" data-opt-text="${escapeHtml(opt)}"
                class="clarify-opt text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 transition">
                ${escapeHtml(opt)}
              </button>
            `).join('')}
          </div>
        </div>
      `).join('');

      // 选项点击 → 收集到 clarifyAnswers(单选:替换,多选:追加)
      container.querySelectorAll('.clarify-opt').forEach(btn => {
        btn.addEventListener('click', () => {
          const wrap = btn.closest('[data-q-id]');
          const qId = wrap.dataset.qId;
          const qText = wrap.dataset.qText;
          const aText = btn.dataset.optText;
          const isMulti = questions.find(q => q.id === qId)?.type === 'multi';

          // 视觉: 单选把同组其他去掉高亮,多选可多个
          wrap.querySelectorAll('.clarify-opt').forEach(b => {
            b.className = b.className.replace(/border-blue-500 bg-blue-50 text-blue-700 font-medium/g, '').trim();
            b.classList.add('border-gray-300', 'text-gray-700');
          });

          if (isMulti) {
            btn.classList.add('border-blue-500', 'bg-blue-50', 'text-blue-700', 'font-medium');
            btn.classList.remove('border-gray-300', 'text-gray-700');
          } else {
            btn.classList.add('border-blue-500', 'bg-blue-50', 'text-blue-700', 'font-medium');
            btn.classList.remove('border-gray-300', 'text-gray-700');
            // 单选: 替换答案
            clarifyAnswers = clarifyAnswers.filter(a => a.questionId !== qId);
            clarifyAnswers.push({ questionId: qId, questionText: qText, answer: aText });
          }
        });
      });
    }).catch(e => {
      container.innerHTML = `<div class="text-sm text-red-500 py-4">❌ 追问失败: ${escapeHtml(e.message)}<br><span class="text-xs text-gray-500">可以点"跳过"直接拆</span></div>`;
      console.error('[追问失败]', e);
    });
  }

  function closeClarifyModal() {
    document.getElementById('clarify-modal').classList.add('hidden');
    clarifyTaskIdx = -1;
    clarifyAnswers = [];
  }

  // 拆解按钮的真正执行(无论"生成拆解"还是"跳过"都走这里)
  async function runBreakdown() {
    if (clarifyTaskIdx < 0) return;
    const task = pendingTasks[clarifyTaskIdx];
    // 收集所有问题的答案(单选只取最后一个,多选合并)
    const container = document.getElementById('clarify-questions');
    const grouped = {};
    container.querySelectorAll('[data-q-id]').forEach(wrap => {
      const qId = wrap.dataset.qId;
      const qText = wrap.dataset.qText;
      const selected = wrap.querySelectorAll('.clarify-opt.border-blue-500');
      if (selected.length > 0) {
        grouped[qId] = {
          questionId: qId,
          questionText: qText,
          answer: Array.from(selected).map(s => s.dataset.optText).join(' / '),
        };
      }
    });
    const answers = Object.values(grouped);
    closeClarifyModal();

    const hide = showLoading('AI 正在拆解...');
    try {
      const steps = await breakdownTask(task, answers);
      if (steps.length === 0) {
        toast('AI 没拆出步骤,重试或手动加', 'error', 4000);
        return;
      }
      task.checklist = steps;
      renderConfirm();
      toast(`✅ 已拆出 ${steps.length} 步`, 'success', 2000);
    } catch (e) {
      console.error('[拆解失败]', e);
      const hint = e.name === 'TypeError' && e.message === 'Failed to fetch'
        ? ' (CORS/DNS/代理,看 Console)'
        : '';
      toast(`❌ 拆解失败: ${e.message}${hint}`, 'error', 5000);
    } finally {
      hide();
    }
  }

  function initConfirm() {
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      if (!confirm('放弃所有任务？')) return;
      pendingTasks = [];
      document.getElementById('confirm-panel').classList.add('hidden');
    });

    document.getElementById('confirm-save').addEventListener('click', () => {
      const final = [];
      let invalid = 0;
      pendingTasks.forEach(t => {
        if (!t.title) { invalid++; return; }
        // 周期任务: deadline 选填(不填用 recurrence.start_date),单次任务必填
        if (!t.is_recurring && !t.deadline) {
          invalid++;
          toast(`"${t.title}" 是单次任务,截止时间必填`, 'error', 4000);
          return;
        }
        // deadline 格式校验
        const isIso  = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t.deadline || '');
        const isDate = /^\d{4}-\d{2}-\d{2}$/.test(t.deadline || '');
        if (t.is_recurring) {
          if (t.deadline && !isIso && !isDate) {
            invalid++;
            toast(`"${t.title}" 周期任务的日期格式不对(填 YYYY-MM-DD 或 ISO 8601)`, 'error', 4000);
            return;
          }
        } else {
          if (!isIso) {
            invalid++;
            toast(`"${t.title}" 的时间格式不对(要 ISO 8601,带 T 和时分秒)`, 'error', 4000);
            return;
          }
        }
        // 周期任务: 必须有可重复的规则
        if (t.is_recurring) {
          const rec = t.recurrence || {};
          if (rec.freq === 'custom') {
            if (!rec.interval_days || rec.interval_days < 1) {
              invalid++;
              toast(`"${t.title}" 周期任务: 请设置每 N 天的 N 值`, 'error', 4000);
              return;
            }
          } else {
            if (!rec.recurrence_dates || rec.recurrence_dates.length === 0) {
              invalid++;
              toast(`"${t.title}" 周期任务: 请在月历里至少选一天`, 'error', 4000);
              return;
            }
          }
          // 周期任务 deadline 没填,自动用 start_date
          if (!t.deadline && rec.start_date) {
            t.deadline = rec.start_date + 'T23:59:00+08:00';
          }
        }
        // 周期任务时如果是纯日期,补上 T23:59:00+08:00 让下游统一
        const finalDeadline = t.is_recurring && isDate
          ? t.deadline + 'T23:59:00+08:00'
          : t.deadline;
        final.push({
          id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
          title: t.title,
          description: t.description || '',
          deadline: finalDeadline,
          type: t.type || 'other',
          urgency: t.urgency || 'medium',
          remind_before: t.remind_before || [3, 1],
          remind_times: t.remind_times || ['08:00'],
          confidence: t.confidence || 1.0,
          source: selectedSource,
          is_recurring: t.is_recurring || false,
          recurrence: t.is_recurring && t.recurrence ? t.recurrence : null,
          checklist: Array.isArray(t.checklist) && t.checklist.length > 0 ? t.checklist : undefined,
          last_completed_at: null,
          status: 'pending',
          created_at: new Date().toISOString(),
        });
      });
      if (final.length === 0) {
        toast('请至少填写一条有效任务', 'error');
        return;
      }
      const all = loadTasks();
      all.push(...final);
      saveTasks(all);
      pendingTasks = [];
      document.getElementById('confirm-panel').classList.add('hidden');
      // 清理上传区
      currentFile = null;
      document.getElementById('file-input').value = '';
      document.getElementById('preview-container').classList.add('hidden');
      document.getElementById('upload-area').classList.remove('hidden');
      document.getElementById('text-input').value = '';
      document.getElementById('extract-btn').disabled = true;
      toast(`✓ 入库 ${final.length} 条${invalid ? `，跳过 ${invalid} 条无效` : ''}`, 'success');
      currentTab = 'pending';
      renderTabs();
      renderTasks();
    });
  }

  // ============ 任务列表 ============
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentTab = btn.dataset.tab;
        renderTabs();
        renderTasks();
      });
    });
  }

  function renderTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      if (btn.dataset.tab === currentTab) {
        btn.className = 'tab-btn px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 font-medium';
      } else {
        btn.className = 'tab-btn px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100';
      }
    });
  }

  function initViews() {
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentView = btn.dataset.view;
        renderViews();
        renderTasks();
      });
    });
  }

  function renderViews() {
    document.querySelectorAll('.view-btn').forEach(btn => {
      if (btn.dataset.view === currentView) {
        btn.className = 'view-btn px-2 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-xs font-medium';
      } else {
        btn.className = 'view-btn px-2 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 text-xs';
      }
    });
  }

  // 列表卡片里的 checklist(精简版: 进度条 + 可勾选列表)
  function renderTaskChecklist(t) {
    const items = Array.isArray(t.checklist) ? t.checklist : [];
    if (items.length === 0) return '';
    const done = items.filter(i => i.done).length;
    const pct = Math.round(done / items.length * 100);
    return `
      <div class="bg-gray-50 rounded-lg p-2 space-y-1 border border-gray-200" data-list-checklist>
        <div class="flex items-center justify-between text-xs text-gray-600">
          <span>📋 进度 <b>${done}/${items.length}</b> (${pct}%)</span>
          ${done === items.length ? '<span class="text-green-600 font-medium">✨ 已全部完成</span>' : ''}
        </div>
        <div class="h-1 bg-gray-200 rounded-full overflow-hidden">
          <div class="h-full ${done === items.length ? 'bg-green-500' : 'bg-blue-500'} transition-all" style="width:${pct}%"></div>
        </div>
        <div class="space-y-0.5 pt-0.5">
          ${items.map(item => `
            <label class="flex items-center gap-2 text-xs cursor-pointer hover:bg-white px-1 py-0.5 rounded">
              <input type="checkbox" data-list-check="${item.id}" ${item.done ? 'checked' : ''}
                class="w-3.5 h-3.5 flex-shrink-0 cursor-pointer">
              <span class="${item.done ? 'line-through text-gray-400' : 'text-gray-700'}">${escapeHtml(item.text)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderTasks() {
    const all = loadTasks();
    // 筛选区只在列表视图显示
    const filterBar = document.getElementById('filter-bar');
    if (filterBar) filterBar.style.display = currentView === 'list' ? 'flex' : 'none';
    const filtered = all
      .filter(t => t.status === currentTab)
      .filter(t => !filterType || t.type === filterType)
      .filter(t => !filterUrgency || t.urgency === filterUrgency)
      .filter(t => {
        if (!filterKeyword) return true;
        const k = filterKeyword.toLowerCase();
        return (t.title || '').toLowerCase().includes(k) || (t.description || '').toLowerCase().includes(k);
      })
      .map(t => {
        // 周期任务: 把 deadline 临时换成"下次发生时间"用于排序/紧迫度/倒计时
        if (t.is_recurring && t.recurrence) {
          const occ = nextOccurrence(t.recurrence, t.last_completed_at);
          if (occ) {
            return { ...t, deadline: occ.nextDate + 'T23:59:00+08:00', _recurringDisplay: freqLabel(t.recurrence) };
          }
          // 周期已过期,显示原始 deadline
          return { ...t, _recurringDisplay: freqLabel(t.recurrence) + ' ⏸️ 已结束' };
        }
        return t;
      })
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

    const list = document.getElementById('task-list');
    const empty = document.getElementById('empty-state');
    list.innerHTML = '';
    list.className = 'space-y-3';

    // 视图分发
    if (currentView === 'week') {
      empty.classList.add('hidden');
      renderWeekView(filtered, list);
      return;
    }
    if (currentView === 'month') {
      empty.classList.add('hidden');
      renderMonthView(filtered, list);
      return;
    }
    // list 视图继续往下走
    list.className = 'space-y-3';

    if (filtered.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    filtered.forEach(t => {
      const isExpired = t.status === 'pending' && new Date(t.deadline).getTime() < Date.now();
      const urgencyLevel = t.status === 'pending' ? computeUrgencyLevel(t.deadline) : 'green';
      const barCls = t.status === 'done' || t.status === 'cancelled' ? '' : URGENCY_BAR[urgencyLevel];
      const card = document.createElement('div');
      card.className = `bg-white rounded-xl border ${barCls} transition shadow-sm hover:shadow-md ${
        t.status === 'done' ? 'border-gray-200 opacity-60' :
        t.status === 'cancelled' ? 'border-gray-200 opacity-50' :
        isExpired ? 'border-red-200' : 'border-gray-200'
      } p-4 space-y-2`;
      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="font-medium text-gray-900 text-sm flex-1">
            <span class="mr-1" title="重要度">${starsHtml(t.urgency)}</span>${escapeHtml(t.title)}
          </div>
          <span class="text-xs px-2 py-0.5 rounded ${typeColor(t.type)}">${typeLabel(t.type)}</span>
        </div>
        <div class="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
          ${t._recurringDisplay ? `<span class="text-purple-600 font-medium">${t._recurringDisplay}</span>` : ''}
          ${t.is_recurring && t.last_completed_at ? '<span class="text-green-600 font-medium">✅ 本次已完成</span>' : ''}
          <span>🕒 ${formatDate(t.deadline)}</span>
          <span class="${formatCountdown(t.deadline).cls}">${formatCountdown(t.deadline).text}</span>
          ${t.remind_times && t.remind_times.length ? `<span class="text-blue-600" title="每天这几个时刻提醒">⏰ ${t.remind_times.join(' · ')}</span>` : ''}
          ${(!t.is_recurring && t.remind_before && t.remind_before.length) ? `<span class="text-gray-400" title="提前几天提醒">🔔 提前 ${t.remind_before.join('/')} 天</span>` : ''}
        </div>
        ${t.description ? `<div class="text-xs text-gray-600 leading-relaxed">${escapeHtml(t.description)}</div>` : ''}
        ${renderTaskChecklist(t)}
        <div class="flex gap-2 pt-1">${actionsHtml(t)}</div>
      `;
      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => handleAction(t, btn.dataset.action));
      });
      // checklist 勾选事件(列表卡片里的精简版)
      card.querySelectorAll('[data-list-check]').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.dataset.listCheck;
          const all = loadTasks();
          const task = all.find(x => x.id === t.id);
          if (!task) return;
          const item = (task.checklist || []).find(i => i.id === id);
          if (item) {
            item.done = cb.checked;
            // 全部勾上 → 自动标完成
            const all2 = task.checklist;
            if (all2.length > 0 && all2.every(i => i.done) && task.status === 'pending') {
              task.status = 'done';
              toast(`🎉 "${task.title}" 全部步骤完成,自动标为已完成`, 'success', 3000);
            }
            saveTasks(all);
            renderTasks();
          }
        });
      });
      list.appendChild(card);
    });
  }

  // 周历视图: 显示当前所在周(周日~周六)的 7 天 + 当天任务
  function renderWeekView(tasks, list) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay(); // 0=周日
    const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - dayOfWeek);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);

    // 收集这周内的任务(按 deadline 在这周内的)
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart); d.setDate(d.getDate() + i);
      return d;
    });
    const tasksByDay = days.map(d => {
      const dStr = toISODate(d);
      return tasks.filter(t => {
        if (!t.deadline) return false;
        const td = parseISODate(t.deadline.split('T')[0]);
        return td && toISODate(td) === dStr;
      });
    });

    const isToday = (d) => toISODate(d) === toISODate(today);

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold text-gray-700">📅 本周 (${formatDate(weekStart.toISOString())} ~ ${formatDate(new Date(weekEnd.getTime() - 86400000).toISOString())})</h3>
      </div>
      <div class="grid grid-cols-7 gap-1">
        ${days.map((d, i) => {
          const dayTasks = tasksByDay[i];
          const today_ = isToday(d);
          return `
            <div class="rounded-lg p-2 min-h-[100px] ${today_ ? 'bg-blue-50 border-2 border-blue-300' : 'bg-white border border-gray-200'}">
              <div class="text-xs text-gray-500 mb-1">${WEEKDAY_LABELS[i]}</div>
              <div class="text-lg font-semibold ${today_ ? 'text-blue-600' : 'text-gray-800'}">${d.getDate()}</div>
              <div class="mt-1 space-y-1">
                ${dayTasks.slice(0, 4).map(t => `
                  <div class="text-xs px-1.5 py-0.5 rounded ${typeColor(t.type)} truncate" title="${escapeHtml(t.title)}">
                    ${t.is_recurring ? '🔁 ' : ''}${escapeHtml(t.title)}
                  </div>
                `).join('')}
                ${dayTasks.length > 4 ? `<div class="text-xs text-gray-400">+${dayTasks.length - 4} 更多</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    list.appendChild(wrap);
  }

  // 月历视图: 整月任务散点
  function renderMonthView(tasks, list) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const year  = currentCalDate.getFullYear();
    const month = currentCalDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay  = new Date(year, month + 1, 0);
    const startWd  = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const cells = [];
    for (let i = 0; i < startWd; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

    // 任务按日期分组
    const tasksByDate = {};
    tasks.forEach(t => {
      if (!t.deadline) return;
      const d = parseISODate(t.deadline.split('T')[0]);
      if (!d) return;
      const key = toISODate(d);
      if (!tasksByDate[key]) tasksByDate[key] = [];
      tasksByDate[key].push(t);
    });

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <button data-cal-prev class="text-sm px-3 py-1.5 rounded-lg hover:bg-gray-100">‹</button>
        <h3 class="text-sm font-semibold text-gray-700">🗓️ ${year} 年 ${month + 1} 月</h3>
        <button data-cal-next class="text-sm px-3 py-1.5 rounded-lg hover:bg-gray-100">›</button>
      </div>
      <div class="grid grid-cols-7 gap-1 text-center text-xs text-gray-500 mb-1">
        ${['日','一','二','三','四','五','六'].map(w => `<div>${w}</div>`).join('')}
      </div>
      <div class="grid grid-cols-7 gap-1">
        ${cells.map(d => {
          if (!d) return '<div class="min-h-[60px]"></div>';
          const key = toISODate(d);
          const dayTasks = tasksByDate[key] || [];
          const isToday = toISODate(d) === toISODate(today);
          return `
            <div class="rounded p-1 min-h-[60px] ${isToday ? 'bg-blue-50 border border-blue-300' : 'bg-white border border-gray-200'}">
              <div class="text-xs ${isToday ? 'text-blue-600 font-bold' : 'text-gray-700'}">${d.getDate()}</div>
              <div class="space-y-0.5 mt-0.5">
                ${dayTasks.slice(0, 2).map(t => `
                  <div class="text-[10px] px-1 py-0.5 rounded ${typeColor(t.type)} truncate" title="${escapeHtml(t.title)}">
                    ${t.is_recurring ? '🔁 ' : ''}${escapeHtml(t.title)}
                  </div>
                `).join('')}
                ${dayTasks.length > 2 ? `<div class="text-[10px] text-gray-400">+${dayTasks.length - 2}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    list.appendChild(wrap);

    // 翻月
    wrap.querySelector('[data-cal-prev]').addEventListener('click', () => {
      currentCalDate = new Date(year, month - 1, 1);
      renderTasks();
    });
    wrap.querySelector('[data-cal-next]').addEventListener('click', () => {
      currentCalDate = new Date(year, month + 1, 1);
      renderTasks();
    });
  }

  function actionsHtml(t) {
    if (t.status === 'done' || t.status === 'cancelled') {
      return `
        <button data-action="edit"   class="text-xs px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700">✏️ 编辑</button>
        <button data-action="reopen" class="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">↩️ 重新打开</button>
        <button data-action="delete" class="text-xs px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600">🗑️ 删除</button>
      `;
    }
    return `
      <button data-action="done"   class="text-xs px-3 py-1.5 rounded-lg bg-green-50 hover:bg-green-100 text-green-700">✅ 完成</button>
      <button data-action="cancel" class="text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">❌ 取消</button>
      <button data-action="edit"   class="text-xs px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700">✏️ 编辑</button>
      <button data-action="delete" class="text-xs px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 ml-auto">🗑️</button>
    `;
  }

  function handleAction(t, action) {
    const all = loadTasks();
    const idx = all.findIndex(x => x.id === t.id);
    if (idx < 0) return;
    if (action === 'delete' && !confirm(`确认删除「${t.title}」？`)) return;
    if (action === 'done') {
      if (t.is_recurring) {
        // 周期任务: 标记本次完成 → 记录时间,任务保留,下次发生时间自动跳过今天
        all[idx].last_completed_at = new Date().toISOString();
        all[idx].status = 'pending'; // 保持 pending,只是本次已完成
        toast('本次完成 ✓ 下次会自动出现', 'success');
        celebrate();
      } else {
        all[idx].status = 'done';
        toast('已标记完成 🎉', 'success');
        celebrate();
      }
    }
    if (action === 'cancel') { all[idx].status = 'cancelled'; toast('已取消', 'info'); }
    if (action === 'reopen') { all[idx].status = 'pending'; toast('已重新打开', 'info'); }
    if (action === 'delete') { all.splice(idx, 1); toast('已删除', 'info'); }
    if (action === 'edit')   { openEditModal(t.id); return; }
    saveTasks(all);
    renderTasks();
  }

  // ============ 编辑弹窗 ============
  function openEditModal(taskId) {
    const all = loadTasks();
    const original = all.find(x => x.id === taskId);
    if (!original) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'edit-modal';
    backdrop.innerHTML = `
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-base font-semibold text-gray-900">✏️ 编辑任务</h3>
          <button id="edit-close" class="text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100">×</button>
        </div>
        <div id="edit-form"></div>
        <div class="flex gap-2 mt-4">
          <button id="edit-cancel" class="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-200">
            ↩️ 取消
          </button>
          <button id="edit-save" class="flex-[2] bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">
            💾 保存修改
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    // 渲染编辑表单
    const form = backdrop.querySelector('#edit-form');
    const t = { ...original }; // 工作副本
    // 周期任务时确保 remind_times 至少有 1 个
    if (!t.remind_times || t.remind_times.length === 0) t.remind_times = ['08:00'];

    const renderForm = () => {
      const isRec = !!t.is_recurring;
      const urgencyLevel = (t.deadline && !isRec) ? computeUrgencyLevel(t.deadline) : 'green';
      form.innerHTML = `
        <div class="space-y-3">
          <div>
            <label class="block text-xs text-gray-600 mb-1">📝 任务名 *</label>
            <input id="ef-title" type="text" maxlength="50" value="${escapeHtml(t.title || '')}"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-xs text-gray-600 mb-1">⏰ 截止时间 ${isRec ? '<span class="text-gray-400">(选填,留空用周期开始日期)</span>' : '* (ISO 8601 / +08:00)'}</label>
            <input id="ef-deadline" type="${isRec ? 'date' : 'text'}" value="${isRec && t.deadline ? (t.deadline.split('T')[0]) : escapeHtml(t.deadline || '')}" placeholder="${isRec ? '' : '2026-06-10T23:59:00+08:00'}"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-xs text-gray-600 mb-1">⏰ 几点提醒(每天这几个时刻弹通知)</label>
            ${renderRemindTimes(t.remind_times)}
          </div>
          <div>
            <label class="block text-xs text-gray-600 mb-1">🏷️ 类型</label>
            <select id="ef-type" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="homework"      ${t.type === 'homework'      ? 'selected' : ''}>📚 作业</option>
              <option value="exam"          ${t.type === 'exam'          ? 'selected' : ''}>📝 考试</option>
              <option value="registration"  ${t.type === 'registration'  ? 'selected' : ''}>🎟️ 报名</option>
              <option value="assignment"    ${t.type === 'assignment'    ? 'selected' : ''}>📌 任务</option>
              <option value="other"         ${t.type === 'other'         ? 'selected' : ''}>📦 其他</option>
            </select>
          </div>
          ${isRec ? '' : `
          <div>
            <label class="block text-xs text-gray-600 mb-1">🧩 任务拆解(checklist)</label>
            ${renderEditChecklist(t)}
          </div>
          `}
          ${isRec ? '' : `
          <div>
            <label class="block text-xs text-gray-600 mb-1">🎯 重要度</label>
            <div class="flex gap-2">
              ${URGENCY_OPTIONS.map(o => `
                <button data-urgency="${o.value}" type="button"
                  class="urgency-btn flex-1 py-2 rounded-lg border text-sm font-medium transition
                    ${t.urgency === o.value
                      ? o.color
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50'}">
                  ${o.emoji} ${o.label}
                </button>
              `).join('')}
            </div>
          </div>
          <div>
            <label class="block text-xs text-gray-600 mb-1">🔔 提醒提前量(可多选)</label>
            <div class="flex gap-2">
              ${REMIND_OPTIONS.map(d => `
                <label class="remind-chip flex-1 flex items-center justify-center gap-1 py-2 rounded-lg border cursor-pointer text-sm transition
                  ${(t.remind_before || []).includes(d)
                    ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'}">
                  <input type="checkbox" data-remind="${d}" ${(t.remind_before || []).includes(d) ? 'checked' : ''} class="hidden">
                  <span>${(t.remind_before || []).includes(d) ? '✅' : '⬜'}</span>
                  <span>${d} 天前</span>
                </label>
              `).join('')}
            </div>
          </div>
          `}
          <div>
            <label class="block text-xs text-gray-600 mb-1">💬 详细说明</label>
            <textarea id="ef-desc" maxlength="500" rows="2"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">${escapeHtml(t.description || '')}</textarea>
          </div>
          <div>
            <label class="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input type="checkbox" id="ef-recurring-toggle" ${isRec ? 'checked' : ''} class="w-4 h-4">
              <span>🔁 设为周期任务</span>
            </label>
          </div>
          <div class="recurring-config-edit ${isRec ? '' : 'hidden'} space-y-2">
            <div class="flex gap-1 flex-wrap">
              ${FREQ_OPTIONS.map(o => `
                <button type="button" data-edit-freq="${o.value}"
                  class="edit-freq-btn px-3 py-1.5 rounded-lg border text-xs font-medium transition
                    ${(t.recurrence && t.recurrence.freq === o.value)
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-50'}">
                  ${o.label}
                </button>
              `).join('')}
            </div>
            <div class="edit-freq-detail">
              ${isRec ? renderEditFreqDetail(t) : ''}
            </div>
          </div>
          ${isRec ? '' : `
          <div class="text-xs text-gray-400 flex items-center gap-2 p-2 bg-gray-50 rounded">
            <span>当前紧迫度:</span>
            <span data-urgency-hint class="font-medium ${urgencyLevel === 'red' ? 'text-red-600' : urgencyLevel === 'orange' ? 'text-orange-600' : 'text-green-600'}">
              ${urgencyLevel === 'red' ? '🔴 紧急(<1天/过期)' : urgencyLevel === 'orange' ? '🟠 临近(1-3天)' : '🟢 充裕(>3天)'}
            </span>
            <span>· 按 deadline 自动算</span>
          </div>
          `}
          ${isRec && t.recurrence ? `<div class="text-xs text-gray-400 flex items-center gap-2 p-2 bg-purple-50 rounded">
            <span>📅 频率:</span><span class="font-medium text-purple-700">${freqLabel(t.recurrence)}</span>
          </div>` : ''}
        </div>
      `;
      bindEditForm();
    };

    // 编辑模式: checklist(用 ef- 前缀,跟其他编辑字段一致)
    function renderEditChecklist(task) {
      const items = Array.isArray(task.checklist) ? task.checklist : [];
      const done = items.filter(i => i.done).length;
      const total = items.length;
      const pct = total ? Math.round(done / total * 100) : 0;

      if (total === 0) {
        return `
          <div class="border-2 border-dashed border-gray-300 rounded-lg p-3 text-center bg-gray-50">
            <div class="text-xs text-gray-500 mb-2">还没拆解步骤</div>
            <button type="button" data-edit-add-step
              class="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 font-medium">
              + 手动添加步骤
            </button>
          </div>
        `;
      }

      return `
        <div class="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
          <div class="flex items-center justify-between text-xs text-gray-600">
            <span>📋 进度: <b>${done}/${total}</b> (${pct}%)</span>
          </div>
          <div class="h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-blue-500 to-green-500 transition-all" style="width:${pct}%"></div>
          </div>
          <div class="space-y-1 pt-1">
            ${items.map(item => `
              <div class="flex items-center gap-2 bg-white rounded px-2 py-1.5 border border-gray-200 group">
                <input type="checkbox" data-ef-check-done data-ef-check-id="${item.id}" ${item.done ? 'checked' : ''}
                  class="w-4 h-4 flex-shrink-0 cursor-pointer">
                <input type="text" data-ef-check-text data-ef-check-id="${item.id}" value="${escapeHtml(item.text)}"
                  maxlength="200"
                  class="flex-1 text-sm bg-transparent border-none focus:outline-none ${item.done ? 'line-through text-gray-400' : 'text-gray-800'}">
                <button type="button" data-ef-check-remove data-ef-check-id="${item.id}"
                  class="text-red-400 hover:text-red-600 text-xs opacity-0 group-hover:opacity-100 transition px-1">×</button>
              </div>
            `).join('')}
          </div>
          <button type="button" data-ef-check-add
            class="w-full text-xs py-1.5 border border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-600">
            + 添加步骤
          </button>
        </div>
      `;
    }

    // 编辑模式: 周期任务详细配置
    function renderEditFreqDetail(task) {
      const rec = task.recurrence || { freq: 'weekly', recurrence_dates: [], start_date: toISODate(new Date()), end_date: null };
      if (rec.freq === 'custom') {
        return `
          <div class="text-xs text-gray-600 space-y-2">
            <div>从 <input type="date" id="ef-custom-start" value="${rec.start_date || toISODate(new Date())}" class="border rounded px-2 py-1 ml-1 text-xs"> 起,每
              <input type="number" id="ef-custom-interval" value="${rec.interval_days || 3}" min="1" max="365" class="border rounded px-2 py-1 mx-1 w-16 text-xs"> 天发生一次
            </div>
            <div>到 <input type="date" id="ef-custom-end" value="${rec.end_date || ''}" class="border rounded px-2 py-1 ml-1 text-xs"> 结束
              <span class="text-gray-400">(留空 = 无限重复)</span>
            </div>
          </div>
        `;
      }
      const today = new Date();
      const sel = rec.recurrence_dates || [];
      return `
        <div class="text-xs text-gray-500 mb-1">点格子选择重复日期(每周/每月会从你选的日期提取规则)</div>
        ${renderMonthPicker(today.getFullYear(), today.getMonth(), sel, () => {})}
      `;
    }

    // 绑定所有事件(每次 renderForm 后调)
    function bindEditForm() {
      form.querySelector('#ef-title').addEventListener('input', e => t.title = e.target.value);
      const dlInput = form.querySelector('#ef-deadline');
      if (dlInput) {
        if (t.is_recurring) {
          // type=date 存的是 YYYY-MM-DD
          dlInput.addEventListener('change', e => t.deadline = e.target.value ? e.target.value + 'T23:59:00+08:00' : '');
        } else {
          dlInput.addEventListener('input', e => {
            t.deadline = e.target.value;
            const hint = form.querySelector('[data-urgency-hint]');
            if (hint) {
              const lv = t.deadline ? computeUrgencyLevel(t.deadline) : 'green';
              hint.textContent = lv === 'red' ? '🔴 紧急(<1天/过期)' : lv === 'orange' ? '🟠 临近(1-3天)' : '🟢 充裕(>3天)';
              hint.className = 'font-medium ' + (lv === 'red' ? 'text-red-600' : lv === 'orange' ? 'text-orange-600' : 'text-green-600');
            }
          });
        }
      }
      form.querySelector('#ef-type').addEventListener('change', e => t.type = e.target.value);
      form.querySelector('#ef-desc').addEventListener('input', e => t.description = e.target.value);
      form.querySelectorAll('[data-urgency]').forEach(btn => {
        btn.addEventListener('click', () => { t.urgency = btn.dataset.urgency; renderForm(); });
      });
      form.querySelectorAll('[data-remind]').forEach(cb => {
        cb.addEventListener('change', () => {
          const day = parseInt(cb.dataset.remind, 10);
          const cur = t.remind_before || [];
          if (cb.checked) {
            if (!cur.includes(day)) t.remind_before = [...cur, day].sort((a, b) => b - a);
          } else {
            t.remind_before = cur.filter(d => d !== day);
          }
          renderForm();
        });
      });
      // 时刻: 改 / 加 / 删
      form.querySelectorAll('[data-time-idx]').forEach(inp => {
        inp.addEventListener('change', e => {
          const i = parseInt(e.target.dataset.timeIdx, 10);
          t.remind_times[i] = e.target.value;
        });
      });
      form.querySelectorAll('[data-time-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.timeRemove, 10);
          t.remind_times = t.remind_times.filter((_, k) => k !== i);
          if (t.remind_times.length === 0) t.remind_times = ['08:00'];
          renderForm();
        });
      });
      const addTime = form.querySelector('[data-time-add]');
      if (addTime) addTime.addEventListener('click', () => {
        if (t.remind_times.length < 3) {
          t.remind_times = [...t.remind_times, '20:00'];
          renderForm();
        }
      });
      // 周期任务开关
      const recToggle = form.querySelector('#ef-recurring-toggle');
      if (recToggle) recToggle.addEventListener('change', () => {
        if (recToggle.checked) {
          t.is_recurring = true;
          if (!t.recurrence) {
            t.recurrence = {
              freq: 'weekly',
              interval_days: null,
              recurrence_dates: [],
              start_date: toISODate(new Date()),
              end_date: null,
            };
          }
        } else {
          t.is_recurring = false;
        }
        renderForm();
      });
      // 频次切换
      form.querySelectorAll('[data-edit-freq]').forEach(btn => {
        btn.addEventListener('click', () => {
          const f = btn.dataset.editFreq;
          const old = t.recurrence || {};
          t.recurrence = {
            freq: f,
            interval_days: f === 'custom' ? (old.interval_days || 3) : null,
            recurrence_dates: old.recurrence_dates || [],
            start_date: old.start_date || toISODate(new Date()),
            end_date: old.end_date || null,
          };
          renderForm();
        });
      });
      // 月历点选
      form.querySelectorAll('[data-cal-day]').forEach(btn => {
        btn.addEventListener('click', () => {
          const iso = btn.dataset.calDay;
          const cur = t.recurrence?.recurrence_dates || [];
          if (cur.includes(iso)) {
            t.recurrence.recurrence_dates = cur.filter(d => d !== iso);
          } else {
            t.recurrence.recurrence_dates = [...cur, iso];
          }
          renderForm();
        });
      });
      // 自定义频次字段
      const ci = form.querySelector('#ef-custom-interval');
      if (ci) ci.addEventListener('input', e => t.recurrence.interval_days = parseInt(e.target.value, 10) || 3);
      const cs = form.querySelector('#ef-custom-start');
      if (cs) cs.addEventListener('change', e => t.recurrence.start_date = e.target.value);
      const ce = form.querySelector('#ef-custom-end');
      if (ce) ce.addEventListener('change', e => t.recurrence.end_date = e.target.value || null);

      // Checklist 事件(编辑弹窗版)
      form.querySelectorAll('[data-ef-check-done]').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = cb.dataset.efCheckId;
          const item = (t.checklist || []).find(i => i.id === id);
          if (item) { item.done = cb.checked; renderForm(); }
        });
      });
      form.querySelectorAll('[data-ef-check-text]').forEach(inp => {
        inp.addEventListener('change', () => {
          const id = inp.dataset.efCheckId;
          const item = (t.checklist || []).find(i => i.id === id);
          if (item) { item.text = inp.value.trim(); }
        });
      });
      form.querySelectorAll('[data-ef-check-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.efCheckId;
          t.checklist = (t.checklist || []).filter(i => i.id !== id);
          renderForm();
        });
      });
      const efAdd = form.querySelector('[data-ef-check-add]');
      if (efAdd) efAdd.addEventListener('click', () => {
        if (!t.checklist) t.checklist = [];
        t.checklist.push({ id: 'c' + Math.random().toString(36).slice(2, 10), text: '新步骤', done: false });
        renderForm();
      });
      const efAddEmpty = form.querySelector('[data-edit-add-step]');
      if (efAddEmpty) efAddEmpty.addEventListener('click', () => {
        if (!t.checklist) t.checklist = [];
        t.checklist.push({ id: 'c' + Math.random().toString(36).slice(2, 10), text: '新步骤', done: false });
        renderForm();
      });
    }

    renderForm();
    // 标记紧迫度 hint 位置(简化:用 data-urgency-hint 在紧迫度那一行)
    // 这里偷个懒:把渲染后那个 span 加属性
    const _origRender = renderForm;
    const _wrappedRender = () => {
      _origRender();
      // 找到 "当前紧迫度:" 后面的 span,标 data-urgency-hint
      const spans = form.querySelectorAll('span');
      for (const s of spans) {
        if (/🔴|🟠|🟢/.test(s.textContent) && s.textContent.length < 30) {
          s.dataset.urgencyHint = '1';
        }
      }
    };
    _wrappedRender();

    // 关闭逻辑
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onEsc);
    };
    backdrop.addEventListener('click', close);
    document.getElementById('edit-close').addEventListener('click', close);
    document.getElementById('edit-cancel').addEventListener('click', close);

    // Esc
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);

    // 保存
    document.getElementById('edit-save').addEventListener('click', () => {
      if (!t.title) { toast('任务名必填', 'error'); return; }
      // 周期任务: deadline 选填,没填就用 start_date
      let finalDeadline = t.deadline || '';
      if (t.is_recurring) {
        const rec = t.recurrence || {};
        if (rec.freq === 'custom') {
          if (!rec.interval_days || rec.interval_days < 1) {
            toast('周期任务: 请设置每 N 天的 N 值', 'error'); return;
          }
        } else if (!rec.recurrence_dates || rec.recurrence_dates.length === 0) {
          toast('周期任务: 请在月历里至少选一天', 'error'); return;
        }
        if (!finalDeadline && rec.start_date) {
          finalDeadline = rec.start_date + 'T23:59:00+08:00';
        }
      } else {
        // 单次任务: deadline 必填 + ISO 8601
        if (!finalDeadline) { toast('单次任务截止时间必填', 'error'); return; }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(finalDeadline)) {
          toast('截止时间格式不对', 'error'); return;
        }
      }
      const cur = loadTasks();
      const idx = cur.findIndex(x => x.id === taskId);
      if (idx < 0) { close(); return; }
      // checklist 全部勾上 → 自动标完成
      const cl = Array.isArray(t.checklist) ? t.checklist : [];
      const allDone = cl.length > 0 && cl.every(i => i.done);
      cur[idx] = {
        ...cur[idx],
        title: t.title,
        description: t.description || '',
        deadline: finalDeadline,
        type: t.type || 'other',
        urgency: t.is_recurring ? 'medium' : (t.urgency || 'medium'),
        remind_before: t.is_recurring ? [] : (t.remind_before || [3, 1]),
        remind_times: t.remind_times || ['08:00'],
        is_recurring: t.is_recurring || false,
        recurrence: t.is_recurring && t.recurrence ? t.recurrence : null,
        checklist: cl.length > 0 ? cl : undefined,
        // checklist 全勾上 → 自动完成(仅对单次任务;周期任务不走"完成"概念)
        status: (!t.is_recurring && allDone && cur[idx].status === 'pending') ? 'done' : cur[idx].status,
        // 如果从周期切到单次,清掉 last_completed_at
        last_completed_at: t.is_recurring ? cur[idx].last_completed_at : null,
      };
      saveTasks(cur);
      if (allDone && cur[idx].status === 'done' && !t.is_recurring) {
        toast(`🎉 "${cur[idx].title}" 全部步骤完成,已自动标为已完成`, 'success', 3000);
      } else {
        toast('✓ 已保存', 'success');
      }
      close();
      renderTasks();
    });
  }

  // ============ 启动 ============
  function initFilters() {
    const si = document.getElementById('search-input');
    if (si) si.addEventListener('input', e => { filterKeyword = e.target.value.trim(); renderTasks(); });
    const ft = document.getElementById('filter-type');
    if (ft) ft.addEventListener('change', e => { filterType = e.target.value; renderTasks(); });
    const fu = document.getElementById('filter-urgency');
    if (fu) fu.addEventListener('change', e => { filterUrgency = e.target.value; renderTasks(); });
  }

  function init() {
    initSettings();
    initUpload();
    initConfirm();
    initTabs();
    renderTabs();
    initViews();
    renderViews();
    initFilters();
    renderTasks();

    // 追问模态框全局事件
    document.getElementById('clarify-close').addEventListener('click', closeClarifyModal);
    document.getElementById('clarify-backdrop').addEventListener('click', e => {
      // 点背景(非卡片)关闭
      if (e.target.id === 'clarify-backdrop') closeClarifyModal();
    });
    document.getElementById('clarify-submit').addEventListener('click', runBreakdown);
    document.getElementById('clarify-skip').addEventListener('click', runBreakdown);

    // 首次打开若没配 key，提示一下
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      setTimeout(() => {
        document.getElementById('settings-panel').classList.remove('hidden');
        toast('请先点 ⚙️ 设置 填入 API 配置', 'info', 4000);
      }, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
