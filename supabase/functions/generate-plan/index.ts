// Supabase Edge Function: generate-plan
// 作用：把前端的兴趣输入转给阿里云百炼（OpenAI 兼容接口），返回一周细化方案。
// 密钥只从服务端环境变量读取，绝不下发到前端。

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
// 优先用通义新版模型，依次回退到更旧的可用模型，提高开通/额度容错。
const MODELS = (Deno.env.get('DASHSCOPE_MODEL') || 'qwen3.8-flash')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean)
  .concat(['qwen-flash', 'qwen-turbo']);
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

function systemPrompt(hobby: string): string {
  return `你是一个每周兴趣培养方案生成器。用户会提供一个兴趣爱好。请生成一周（周一到周日）的具体方案。

输出格式要求：每一天必须包含以下四项，缺一不可：
- 活动：写清楚做什么，不少于 20 字，必须包含可执行的动作（如“练习XX的第X小节，重复N遍”）
- 时长：X分钟
- 材料/条件：列出具体物品或前提
- 完成标准：怎样算完成了这一天的任务

详细程度参考以下好例子，避免坏例子那种笼统表述。

【坏例子 - 不要这样输出】
周一：练习吉他。

【好例子 - 请按这个粒度输出】
周一
- 活动：用节拍器 60bpm 练习 C 大调音阶上下行，右手先练，每遍跟拍准确后换左手，各练 10 遍
- 时长：25 分钟
- 材料/条件：吉他、节拍器 App、音阶谱
- 完成标准：右手和左手各完成 10 遍，且节拍器无错拍

现在请为「${hobby}」生成下一周的方案。如果某天的“活动”描述少于 20 字，请重新生成那一天的内容。`;
}

async function callDashScope(apiKey: string, hobby: string): Promise<string> {
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
          { role: 'system', content: systemPrompt(hobby) },
          { role: 'user', content: `爱好：${hobby}` },
        ],
        temperature: 0.6,
        max_tokens: 2400,
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

  let hobby = '';
  try {
    const body = await req.json();
    hobby = String(body?.hobby ?? '').trim();
  } catch {
    return json({ error: '请求内容不是有效的 JSON。' }, 400);
  }

  if (!hobby) return json({ error: '请先输入一个兴趣爱好。' }, 400);
  if (hobby.length > 40) hobby = hobby.slice(0, 40);

  try {
    const plan = await callDashScope(apiKey, hobby);
    return json({ plan });
  } catch (error) {
    const message = String((error as Error)?.message || '方案生成失败，请稍后再试。');
    console.error('generate-plan failed:', message);
    return json({ error: message }, 502);
  }
});
