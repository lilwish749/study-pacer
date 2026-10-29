// Supabase Edge Function: generate-plan
// 作用：把前端的兴趣输入转给 Cerebras（OpenAI 兼容接口），返回一周细化方案。
// 密钥只从服务端环境变量读取，绝不下发到前端。

const CEREBRAS_BASE = 'https://api.cerebras.ai/v1';
// Cerebras 的模型标识带连字符，可用 CEREBRAS_MODEL 覆盖默认值。
const PRIMARY_MODEL = Deno.env.get('CEREBRAS_MODEL') || 'llama-3.3-70b';
const FALLBACK_MODEL = 'llama-3.1-8b';

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

活动：写清楚做什么，不少于 20 字，必须包含可执行的动作（如“练习XX的第X小节，重复N遍”）

时长：X分钟

材料/条件：列出具体物品或前提

完成标准：怎样算完成了这一天的任务

详细程度参考以下好例子，避免坏例子那种笼统表述。

【坏例子 - 不要这样输出】
周一：练习吉他。

【好例子 - 请按这个粒度输出】
周一

活动：用节拍器 60bpm 练习 C 大调音阶上下行，右手先练，每遍跟拍准确后换左手，各练 10 遍

时长：25 分钟

材料/条件：吉他、节拍器 App、音阶谱

完成标准：右手和左手各完成 10 遍，且节拍器无错拍

现在请为「${hobby}」生成下一周的方案。如果某天的“活动”描述少于 20 字，请重新生成那一天的内容。`;
}

// 依次尝试主模型与备用模型，返回纯文本方案。
async function callCerebras(apiKey: string, hobby: string): Promise<string> {
  const models = [PRIMARY_MODEL, FALLBACK_MODEL].filter((m, i, all) => all.indexOf(m) === i);
  let lastDetail = '';

  for (const model of models) {
    const response = await fetch(`${CEREBRAS_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt(hobby) },
          { role: 'user', content: `兴趣爱好：${hobby}` },
        ],
        temperature: 0.6,
        max_tokens: 2400,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (text) return text;
      lastDetail = '模型没有返回内容。';
      continue;
    }

    const detail = (await response.text()).slice(0, 300);
    lastDetail = `Cerebras ${response.status}: ${detail}`;

    if (response.status === 429) throw new Error('生成请求太频繁了，请等一会儿再试。');
    if (response.status === 401 || response.status === 403) {
      throw new Error('CEREBRAS_API_KEY 无效或没有权限，请在 Supabase 中重新设置密钥。');
    }
    // 400 / 404 通常是模型名不可用，换下一个模型再试。
    if (response.status === 400 || response.status === 404) continue;
    throw new Error('方案服务暂时不可用，请稍后再试。');
  }

  throw new Error(lastDetail || '方案服务暂时不可用，请稍后再试。');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: '只支持 POST 请求。' }, 405);

  const apiKey = Deno.env.get('CEREBRAS_API_KEY');
  if (!apiKey) {
    return json({ error: '服务端还没有配置 CEREBRAS_API_KEY，请先在 Supabase 中设置。' }, 500);
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
    const plan = await callCerebras(apiKey, hobby);
    return json({ plan });
  } catch (error) {
    const message = String((error as Error)?.message || '方案生成失败，请稍后再试。');
    console.error('generate-plan failed:', message);
    return json({ error: message }, 502);
  }
});
