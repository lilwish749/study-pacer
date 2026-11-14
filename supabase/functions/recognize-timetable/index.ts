// Supabase Edge Function: recognize-timetable
// 作用：接收前端传来的课程表图片（Base64 Data URL），转给阿里云百炼的视觉模型，
// 让它按固定结构返回课程列表。密钥只从服务端环境变量读取，绝不下发到前端。

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// 视觉模型：优先 qwen-vl-plus，未开通时依次回退到其他已开通的 qwen-vl 系列。
const MODELS = (Deno.env.get('DASHSCOPE_VL_MODEL') || 'qwen-vl-plus')
  .split(',')
  .map(m => m.trim())
  .filter(Boolean)
  .concat(['qwen-vl-max', 'qwen3-vl-plus', 'qwen2.5-vl-72b-instruct']);
const MODEL_LIST = MODELS.filter((m, i) => MODELS.indexOf(m) === i);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 请求体上限：前端已把图片压到长边 1400px，正常在 1MB 以内。
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

const PROMPT = `你是一个课程表信息提取器。用户会上传一张课程表图片，请从中提取所有课程安排。

输出要求：严格输出一个 JSON 数组，不要有任何解释文字，不要 Markdown 代码块。
数组中每个元素包含以下字段：
{"courseName":"课程名称","weekday":1,"startTime":"08:00","endTime":"09:40","location":"上课地点","weekRange":"1-8周","weekStart":1,"weekEnd":8,"weekParity":"all"}

字段规则：
- courseName：课程名称，按图片上的文字原样提取
- weekday：星期几，用数字 1-7 表示（1=周一，7=周日）
- startTime：开始时间，格式 HH:mm（24 小时制）
- endTime：结束时间，格式 HH:mm（24 小时制）
- location：上课地点，图片上没有就填空字符串
- weekRange：原始周次文本，例如 "1-8周"、"9-16周"、"1-16周(单)"、"2-15周(双)"，图中未标注则为空字符串
- weekStart：起始周次整数，无法确定时为 null
- weekEnd：结束周次整数，无法确定时为 null
- weekParity："all" | "odd" | "even"，无标注默认 "all"

周次换算规则：
- "1-8周" → weekStart=1, weekEnd=8, weekParity="all"
- "9-16周" → weekStart=9, weekEnd=16, weekParity="all"
- "1-16周(单)" → weekStart=1, weekEnd=16, weekParity="odd"
- "2-16周(双)" → weekStart=2, weekEnd=16, weekParity="even"
- 只标注单个周次如"第5周" → weekStart=5, weekEnd=5, weekParity="all"
- 完全没有周次标注 → weekStart=null, weekEnd=null, weekParity="all"

提取规则：
1. 所见即所得，只提取图片上真实存在的信息，不要猜测、不要补全、不要编造课程。
2. 如果图片上写的是节次（如「第1-2节」），请结合表格的节次时间表换算成具体的开始和结束时间；换算不出来就留空字符串。
3. 同一天有多段不同的课程，必须分别列出为多条记录。
4. 周末没有课程就不要输出。
5. 只输出 JSON 数组本身。如果一张课程都没有识别到，输出 []。`;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTime(value: unknown): string {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (!match) return '';
  const h = Math.min(23, Math.max(0, Number(match[1])));
  const m = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeWeek(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(60, Math.max(1, n)));
}

function normalizeCourses(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const courseName = String(row.courseName ?? row.name ?? '').trim().slice(0, 40);
    if (!courseName) continue;
    const weekday = Math.round(clampNumber(row.weekday, 1, 7, 1));
    const startTime = normalizeTime(row.startTime ?? row.start);
    const endTime = normalizeTime(row.endTime ?? row.end);
    const location = String(row.location ?? row.place ?? '').trim().slice(0, 40);
    const weekStart = normalizeWeek(row.weekStart ?? row.startWeek);
    const weekEndRaw = normalizeWeek(row.weekEnd ?? row.endWeek);
    const weekEnd = weekStart === null ? weekEndRaw : (weekEndRaw === null ? weekStart : weekEndRaw);
    const parity = ['all', 'odd', 'even'].includes(String(row.weekParity))
      ? String(row.weekParity)
      : 'all';
    const weekRange = String(row.weekRange ?? '').trim().slice(0, 40);
    result.push({ courseName, weekday, startTime, endTime, location, weekRange, weekStart, weekEnd, weekParity: parity });
  }
  return result.slice(0, 60);
}

function extractArray(text: string): unknown[] | null {
  let source = String(text || '').trim();
  // 去掉 ```json ... ``` 这类代码块包裹
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) source = fence[1].trim();
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // 继续尝试截取
  }
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

async function recognize(apiKey: string, image: string) {
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
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 2000,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      const parsed = extractArray(text);
      if (parsed) return normalizeCourses(parsed);
      console.error(`recognize ${model} unparsable: ${text.slice(0, 500)}`);
      lastError = new Error('无法解析识别结果，请尝试更清晰的图片。');
      continue;
    }

    const detail = (await response.text()).slice(0, 300);
    console.error(`recognize ${model} ${response.status}: ${detail}`);

    if (response.status === 401) {
      throw new Error('DASHSCOPE_API_KEY 无效或没有权限，请在 Supabase 中重新设置密钥。');
    }
    if ([400, 403, 404, 429].includes(response.status) || response.status >= 500) {
      lastError = new Error('识别服务暂时不可用，请稍后再试。');
      continue;
    }
    lastError = new Error('识别失败，请检查网络或稍后重试。');
  }

  throw lastError || new Error('识别失败，请检查网络或稍后重试。');
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

  const image = String(body?.image ?? '').trim();
  if (!image) return json({ error: '请先上传课程表图片。' }, 400);
  if (!/^data:image\/(png|jpe?g|webp|bmp);base64,/i.test(image)) {
    return json({ error: '图片格式不支持，请上传 JPG、PNG 或 WebP 图片。' }, 400);
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return json({ error: '图片过大，请压缩或重新截图。' }, 413);
  }

  try {
    const courses = await recognize(apiKey, image);
    return json({ courses });
  } catch (error) {
    const message = String((error as Error)?.message || '识别失败，请检查网络或稍后重试。');
    console.error('recognize-timetable failed:', message);
    return json({ error: message }, 502);
  }
});
