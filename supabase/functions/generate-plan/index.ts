// Supabase Edge Function: generate-plan
// 作用：把前端的兴趣、目标、每周投入转给阿里云百炼（OpenAI 兼容接口），
// 返回「完整学习周期的阶段路线 + 本周细化安排」。
// 密钥只从服务端环境变量读取，绝不下发到前端。

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
// 优先用通义 qwen3.8-flash；若账号未开通该模型，依次回退到当前账号已开通的百炼模型。
const MODELS = (Deno.env.get('DASHSCOPE_MODEL') || 'qwen3.8-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean)
  .concat(['glm-5.3', 'kimi-k3', 'MiniMax-M2.5', 'qwen-turbo']);
// 去重保持顺序
const MODEL_LIST = MODELS.filter((m, i) => MODELS.indexOf(m) === i);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function systemPrompt(hobby: string, goal: string, hours: string): string {
  return `你是一个长期学习路径规划师。用户会提供一个兴趣、一个想达成的目标，以及每周能投入的时间。请先规划完整的学习周期，再细化本周的安排。

【第一部分：长期路线】
必须先输出总周期，再按阶段拆解，阶段要连续覆盖从第 1 周到总周期，不能有缺口。
周期长短由目标难度决定，不要一律按一周：
- 简单目标（例如学会一道菜、读完一本薄书）：4 周左右
- 常见目标（例如入门一项乐器、掌握基础摄影）：8–12 周
- 长期目标（例如流利使用一门外语、系统学习编程）：26–52 周
阶段数量控制在 3–8 个，每个阶段都要有明确的进阶关系。

长期路线必须严格使用下面的格式（不要加序号前缀，不要用 Markdown 表格）：

总周期：N 周
阶段1（第1-4周）：阶段名称
- 目标：这一阶段结束时达到什么水平
- 里程碑：可以用什么作品或检验来确认达标
- 关键练习：这一阶段反复练的 2-3 件事

阶段2（第5-8周）：阶段名称
- 目标：……
- 里程碑：……
- 关键练习：……

（按此格式继续，直至覆盖到总周期）

【第二部分：本周细化】
紧接着输出分隔行【本周细化】，然后给出周一到周日的具体安排。每一天必须包含以下五项，缺一不可：
- 活动：写清楚做什么，不少于 20 字，必须包含可执行的动作（如“练习XX的第X小节，重复N遍”）
- 时长：X分钟
- 材料/条件：列出具体物品或前提
- 完成标准：怎样算完成了这一天的任务
- 推荐参考：给出 2–3 个与当天活动直接相关的网站、App 或学习方法，用中文顿号“、”分隔；能给出公开网址时在名称后附完整链接（例如“JustinGuitar 官网 https://www.justinguitar.com”），不要使用 Markdown 链接格式。优先选择可长期访问的公开资源，不要编造不存在的网址。

详细程度参考以下好例子，避免坏例子那种笼统表述。

【坏例子 - 不要这样输出】
周一：练习吉他。

【好例子 - 请按这个粒度输出】
周一
- 活动：用节拍器 60bpm 练习 C 大调音阶上下行，右手先练，每遍跟拍准确后换左手，各练 10 遍
- 时长：25 分钟
- 材料/条件：吉他、节拍器 App、音阶谱
- 完成标准：右手和左手各完成 10 遍，且节拍器无错拍
- 推荐参考：JustinGuitar 官网 https://www.justinguitar.com、B站「吉他音阶入门」系列课、Fender Play App

每天推荐的学习方法可以按当天任务类型变化（例如跟练、拆段练习、回顾测验），避免七天全部重复同一条资源。

现在请为「${hobby}」规划完整学习周期。
用户目标：${goal}
每周可投入：${hours} 小时
本周细化要与当前所在的第一阶段目标对应。如果某天的“活动”描述少于 20 字，请重新生成那一天的内容。`;
}

// ===== 日程分类模式：判断类型 + 每小时消耗强度 =====
// 强度不含时长；时长由前端换算进每日负荷，避免重复计算。
const CLASSIFY_KINDS = [
  'class', 'study', 'work', 'project', 'exam', 'sport', 'social', 'chore', 'commute', 'rest', 'other',
];

function classifyPrompt(person: Record<string, unknown>): string {
  return `你是日程分类与个人负荷评估助手。根据用户提供的日程名称、备注、时长和个人节奏，判断它属于哪一类，并评估每小时的消耗强度。

类型只能从下面选一个 key：
class（课程/讲座/培训）、study（自学/作业/复习）、work（工作/会议/值班）、project（项目/创作/开发）、exam（考试/测验/答辩）、sport（运动/训练）、social（社交/聚会/社团）、chore（家务/采购/生活事务）、commute（通勤/出行）、rest（休息/恢复）、other（其他）

同时给出：
- typeLabel：不超过 8 个字，优先取自名称里的核心词（如「高等数学课」→「数学课」），禁止用「未知」「其他」「安排」这类泛称
- domainLabel：不超过 6 字的具体领域，如「数学」「语言」「编程」「运动」「职场」「生活」；无法判断时用「综合」
- effect：对当天负荷的作用，只能是 load（增加负荷，如学习、工作、运动）、neutral（不增不减的小任务，如打印、提交材料、洗澡、取快递、缴费）、rest（减少负荷的休息，如午睡、散步、打游戏放松、冥想、听歌发呆）
- intensity：仅 effect=load 时给 0–100 的每小时消耗强度，其他情况填 0。40 以下为轻量日常，40–70 为普通课程或工作，70–90 为高强度脑力/体力，90 以上为考试冲刺或重体力
- recovery：仅 effect=rest 时给 0–100 的每小时恢复力度，其他情况填 0
- reason：不超过 24 字，说明最主要的判断依据
- confidence：0–1，表示你对这次判断的把握

只输出一个 JSON 对象，不要 Markdown，不要解释。字段必须齐全。
示例：{"kind":"class","typeLabel":"数学课","domainLabel":"数学","effect":"load","intensity":72,"recovery":0,"reason":"需要连续推导和高度专注","confidence":0.86}
示例：{"kind":"rest","typeLabel":"午睡","domainLabel":"生活","effect":"rest","intensity":0,"recovery":60,"reason":"短时睡眠能恢复精力","confidence":0.9}

用户节奏参考：${JSON.stringify(person)}`;
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeClassify(raw: Record<string, unknown>) {
  const kind = CLASSIFY_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'other';
  const effect = ['load', 'neutral', 'rest'].includes(String(raw.effect)) ? String(raw.effect) : 'load';
  return {
    kind,
    typeLabel: String(raw.typeLabel || '').trim().slice(0, 8) || '自定义安排',
    domainLabel: String(raw.domainLabel || '').trim().slice(0, 6) || '生活',
    effect,
    intensity: effect === 'load' ? Math.round(clampNumber(raw.intensity, 0, 100, 60)) : 0,
    recovery: effect === 'rest' ? Math.round(clampNumber(raw.recovery, 0, 100, 55)) : 0,
    reason: String(raw.reason || '').trim().slice(0, 24) || '按活动性质综合判断',
    confidence: clampNumber(raw.confidence, 0, 1, 0.75),
  };
}

async function classifyActivity(apiKey: string, payload: Record<string, unknown>) {
  let lastError: Error | null = null;
  for (const model of MODEL_LIST) {
    const response = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: classifyPrompt((payload.person as Record<string, unknown>) || {}) },
          {
            role: 'user',
            content: `名称：${payload.title}\n备注：${payload.note || '无'}\n时长：${payload.minutes} 分钟`,
          },
        ],
        temperature: 0.1,
        max_tokens: 260,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractJson(text);
      if (parsed) return normalizeClassify(parsed);
      lastError = new Error('模型没有返回可解析的分类结果。');
      continue;
    }

    const detail = (await response.text()).slice(0, 200);
    console.error(`classify ${model} ${response.status}: ${detail}`);
    if (response.status === 401) throw new Error('DASHSCOPE_API_KEY 无效或没有权限。');
    if ([400, 403, 404, 429].includes(response.status) || response.status >= 500) {
      lastError = new Error('分类服务暂时不可用，请稍后再试。');
      continue;
    }
    lastError = new Error('分类失败，请稍后再试。');
  }
  throw lastError || new Error('分类失败，请稍后再试。');
}

async function callDashScope(apiKey: string, hobby: string, goal: string, hours: string): Promise<string> {
  let lastError: Error | null = null;

  for (const model of MODEL_LIST) {
    const response = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt(hobby, goal, hours) },
          { role: 'user', content: `爱好：${hobby}\n目标：${goal}\n每周可投入：${hours} 小时` },
        ],
        temperature: 0.6,
        max_tokens: 3200,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (text) return text;
      lastError = new Error('模型没有返回内容，请稍后再试。');
      continue;
    }

    const detail = (await response.text()).slice(0, 300);
    console.error(`DashScope ${model} ${response.status}: ${detail}`);

    if (response.status === 401) {
      throw new Error('DASHSCOPE_API_KEY 无效或没有权限，请在 Supabase 中重新设置密钥。');
    }
    if (response.status === 403) {
      // 403 通常是模型未开通或免费额度已用完，换下一个模型试试。
      lastError = new Error('模型服务未开通或免费额度已用完，请在百炼控制台开通 qwen3.8-flash 后再试。');
      continue;
    }
    if (response.status === 429) {
      lastError = new Error('生成请求太频繁了，请等一会儿再试。');
      continue; // 限流也换下一个模型
    }
    if (response.status === 400 || response.status === 404) {
      lastError = new Error('模型名称不可用，请检查 DASHSCOPE_MODEL 设置。');
      continue;
    }
    if (response.status >= 500) {
      lastError = new Error('方案服务暂时不可用，请稍后再试。');
      continue;
    }
    lastError = new Error('方案生成失败，请稍后再试。');
  }

  throw lastError || new Error('方案生成失败，请稍后再试。');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: '只支持 POST 请求。' }, 405);

  const apiKey = Deno.env.get('DASHSCOPE_API_KEY');
  if (!apiKey) {
    return json({ error: '服务端还没有配置 DASHSCOPE_API_KEY，请先在 Supabase 中设置。' }, 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: '请求内容不是有效的 JSON。' }, 400);
  }

  if (body?.mode === 'classify') {
    const title = String(body.title ?? '').trim().slice(0, 60);
    if (!title) return json({ error: '请先输入日程名称。' }, 400);
    const note = String(body.note ?? '').trim().slice(0, 120);
    const minutes = clampNumber(body.minutes, 1, 720, 60);
    try {
      const person = (body.person as Record<string, unknown>) || {};
      const result = await classifyActivity(apiKey, { title, note, minutes, person });
      return json({ result });
    } catch (error) {
      const message = String((error as Error)?.message || '分类失败，请稍后再试。');
      console.error('classify failed:', message);
      return json({ error: message }, 502);
    }
  }

  let hobby = String(body?.hobby ?? '').trim();
  let goal = String(body?.goal ?? '').trim();
  let hours = String(body?.hours ?? '').trim();

  if (!hobby) return json({ error: '请先输入一个兴趣爱好。' }, 400);
  if (hobby.length > 40) hobby = hobby.slice(0, 40);
  if (goal.length > 200) goal = goal.slice(0, 200);
  if (!goal) goal = '还没有写具体目标，请按常见入门水平规划。';
  if (!hours) hours = '1';

  try {
    const plan = await callDashScope(apiKey, hobby, goal, hours);
    return json({ plan });
  } catch (error) {
    const message = String((error as Error)?.message || '方案生成失败，请稍后再试。');
    console.error('generate-plan failed:', message);
    return json({ error: message }, 502);
  }
});
