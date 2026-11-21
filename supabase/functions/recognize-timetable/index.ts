// Supabase Edge Function: recognize-timetable
// 作用：接收前端传来的课程表图片（Base64 Data URL），转给阿里云百炼的视觉模型，
// 让它按固定结构返回课程列表。密钥只从服务端环境变量读取，绝不下发到前端。

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
// 国际站：如果密钥是在国际站创建的，国内站会返回 403 Access denied，这时切到国际站再试一次。
const DASHSCOPE_INTL_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

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

输出要求：严格输出一个 JSON 对象，不要有任何解释文字，不要 Markdown 代码块。格式：
{"periods":[{"from":5,"to":6,"start":"13:00","end":"14:30"},{"from":5,"to":7,"start":"13:00","end":"15:15"}],"courses":[{"courseName":"体育","weekday":1,"weekdayText":"周一","periodStart":5,"periodEnd":6,"startTime":"","endTime":"","location":"上课地点","weekRange":"3-8周、10-16周","weekSegments":[{"start":3,"end":8,"parity":"all"},{"start":10,"end":16,"parity":"all"}],"weekStart":3,"weekEnd":8,"weekParity":"all"}]}

periods 字段（节次时间对照表，只有用户提供了节次表才填）：
- 把节次表里每一行原样抄成一条 {"from":起始节,"to":结束节,"start":"HH:mm","end":"HH:mm"}，一行都不能漏。
- 一个单元格的时间同时覆盖两节课时（例如同一行里并列写着「第5节」「第6节」，右侧时间是 13:00-14:30），输出 from=5、to=6。
- 如果节次表右侧还有「三节连排」「两节连排」这类合并列（例如 13:00-15:15（三节连排）），必须单独抄成一条 from=5、to=7，不要和两节的行混在一起。
- 只抄表，不要自己推算、不要合并、不要补全不存在的行。没有提供节次表时输出 "periods":[]。

字段规则：
- courseName：课程名称，按图片上的文字原样提取
- weekday：星期几，用数字 1-7 表示（1=周一，7=周日）
- weekdayText：这门课所在那一列的表头原文，例如「周一」「星期三」「Mon」。必须先读表头再确定 weekday，两者必须一致
- periodStart / periodEnd：该课程格子里标注的起止节次（整数）。课程写着「第5-6节」就是 5 和 6；写着「第5-7节」才是 5 和 7；只占一节课就两个都填那个节次。课程直接写了具体时间时这两个填 null
- startTime：只有当课程格子里直接写了时间才填写，格式 HH:mm（24 小时制）。用节次表示时必须是空字符串
- endTime：结束时间，格式 HH:mm（24 小时制）
- location：上课地点，图片上没有就填空字符串
- weekRange：原始周次文本，例如 "1-8周"、"9-16周"、"1-16周(单)"、"2-15周(双)"、"3-8周、10-16周"，图中未标注则为空字符串
- weekSegments：把周次拆成数组，每一段一个对象 {"start":起始周,"end":结束周,"parity":"all|odd|even"}。中间断开的周次必须拆成多段，缺失的周不要包含进来
- weekStart：第一段的起始周次整数，无法确定时为 null
- weekEnd：第一段的结束周次整数，无法确定时为 null
- weekParity：第一段的单双周，"all" | "odd" | "even"，无标注默认 "all"

周次换算规则：
- "1-8周" → weekSegments=[{start:1,end:8,parity:"all"}]
- "9-16周" → weekSegments=[{start:9,end:16,parity:"all"}]
- "1-16周(单)" → weekSegments=[{start:1,end:16,parity:"odd"}]
- "2-16周(双)" → weekSegments=[{start:2,end:16,parity:"even"}]
- "3-8周、10-16周" → weekSegments=[{start:3,end:8,parity:"all"},{start:10,end:16,parity:"all"}]，第 9 周不上课，不能写成一整段 3-16
- "1-8周、10-16周(单)" → weekSegments=[{start:1,end:8,parity:"all"},{start:10,end:16,parity:"odd"}]
- 只标注单个周次如"第5周" → weekSegments=[{start:5,end:5,parity:"all"}]
- 完全没有周次标注 → weekSegments=[]，weekStart/weekEnd=null，weekParity="all"

提取规则：
1. 逐列读：先看表头确认这一列是周几，再读格子里的课。不同天的课程绝不能归到同一天。读完后自查：如果同一天里出现两门课时间重叠，几乎一定是星期列读错了，必须回到原图重新核对。所见即所得，只提取图片上真实存在的信息，不要猜测、不要补全、不要编造课程。
2. 只读节次，绝不自己算时间。课程用节次表示时，periodStart/periodEnd 填原文节次，startTime/endTime 必须留空，由系统查节次表换算。即使你认为自己知道时间也不许填。
3. 一条课程记录只对应课程表格子里的一个连续节次区间。格子写「5-6节」就是 5 到 6，绝不能因为节次表里有「三节连排」就把两节课扩成三节；只有格子明确写「5-7节」时才填 5 到 7。
4. 同一天有多段不同的课程，必须分别列出为多条记录。
5. 周末没有课程就不要输出。
6. 只输出 JSON 对象本身。如果一张课程都没有识别到，输出 {"periods":[],"courses":[]}。`;

// 用户补充的节次时间对照（纯文字）直接拼进 Prompt；图片形式的对照作为第二张图传给模型。
function buildPrompt(periods: string): string {
  if (!periods) return PROMPT;
  return `${PROMPT}

用户补充的节次时间对照（请原样抄进 periods 字段，不要自己推算时间）：
${periods}`;
}

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
    const weekdayText = String(row.weekdayText ?? '').trim().slice(0, 20);
    // 列标题是硬证据：能从「周三」这类文字解析出星期，就以它为准，覆盖模型给的数字。
    const weekday = parseWeekdayText(weekdayText) ?? Math.round(clampNumber(row.weekday, 1, 7, 1));
    const startTime = normalizeTime(row.startTime ?? row.start);
    const endTime = normalizeTime(row.endTime ?? row.end);
    const periodStart = normalizeWeek(row.periodStart);
    const periodEnd = normalizeWeek(row.periodEnd);
    const location = String(row.location ?? row.place ?? '').trim().slice(0, 40);
    const weekStart = normalizeWeek(row.weekStart ?? row.startWeek);
    const weekEndRaw = normalizeWeek(row.weekEnd ?? row.endWeek);
    const weekEnd = weekStart === null ? weekEndRaw : (weekEndRaw === null ? weekStart : weekEndRaw);
    const parity = ['all', 'odd', 'even'].includes(String(row.weekParity))
      ? String(row.weekParity)
      : 'all';
    const weekRange = String(row.weekRange ?? '').trim().slice(0, 80);
    // 多段周次：模型给了 weekSegments 就用它，否则退回单段 weekStart/weekEnd。
    const segments: Array<{ start: number; end: number; parity: string }> = [];
    if (Array.isArray(row.weekSegments)) {
      for (const seg of row.weekSegments as Array<Record<string, unknown>>) {
        if (!seg || typeof seg !== 'object') continue;
        const s = normalizeWeek(seg.start), e = normalizeWeek(seg.end);
        if (s === null) continue;
        const p = ['all', 'odd', 'even'].includes(String(seg.parity)) ? String(seg.parity) : parity;
        segments.push({ start: s, end: e === null ? s : e, parity: p });
      }
    }
    if (!segments.length && weekStart !== null) segments.push({ start: weekStart, end: weekEnd ?? weekStart, parity });
    result.push({ courseName, weekday, startTime, endTime, periodStart, periodEnd, location, weekRange, weekSegments: segments, weekStart, weekEnd, weekParity: parity });
  }
  return result.slice(0, 60);
}

function extractPayload(text: string): { periods: unknown[]; courses: unknown[] } | null {
  let source = String(text || '').trim();
  // 去掉 ```json ... ``` 这类代码块包裹
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) source = fence[1].trim();
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
  let parsed = tryParse(source);
  if (parsed === null) {
    const start = source.indexOf('{'), end = source.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = tryParse(source.slice(start, end + 1));
  }
  if (parsed === null) {
    const start = source.indexOf('['), end = source.lastIndexOf(']');
    if (start >= 0 && end > start) parsed = tryParse(source.slice(start, end + 1));
  }
  if (Array.isArray(parsed)) return { periods: [] as unknown[], courses: parsed as unknown[] };
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const courses = Array.isArray(obj.courses) ? obj.courses : (Array.isArray(obj.data) ? obj.data : []);
    const periods = Array.isArray(obj.periods) ? obj.periods : [];
    return { periods, courses };
  }
  return null;
}

type PeriodRange = { from: number; to: number; start: string; end: string };

// 把模型抄下来的节次表规范化，供后面的时间换算使用。
function normalizePeriods(raw: unknown): PeriodRange[] {
  if (!Array.isArray(raw)) return [];
  const out: PeriodRange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const from = normalizeWeek(row.from ?? row.periodStart ?? row.startPeriod);
    const to = normalizeWeek(row.to ?? row.periodEnd ?? row.endPeriod);
    const start = normalizeTime(row.start ?? row.startTime);
    const end = normalizeTime(row.end ?? row.endTime);
    if (from === null || !start || !end) continue;
    out.push({ from, to: to === null ? from : to, start, end });
  }
  return out;
}

// 用节次表把 periodStart/periodEnd 换算成时间。只要有节次，就以节次表为准，覆盖模型自己填的时间。
function resolveTimes(courses: Array<Record<string, unknown>>, periods: PeriodRange[]) {
  if (!periods.length) return courses;
  for (const course of courses) {
    const ps = Number(course.periodStart), pe = Number(course.periodEnd);
    if (!Number.isFinite(ps) || !Number.isFinite(pe)) continue;
    // 优先找完全相同的节次段（如 5-6 对应 13:00-14:30，5-7 对应 13:00-15:15）。
    const exact = periods.find(p => p.from === ps && p.to === pe);
    if (exact) { course.startTime = exact.start; course.endTime = exact.end; continue; }
    // 没有完全匹配时，取覆盖起始节的最细一段的开始、覆盖结束节的最细一段的结束。
    const span = (p: PeriodRange) => p.to - p.from;
    const first = periods.filter(p => p.from <= ps && ps <= p.to).sort((a, b) => span(a) - span(b))[0];
    const last = periods.filter(p => p.from <= pe && pe <= p.to).sort((a, b) => span(a) - span(b))[0];
    if (first) course.startTime = first.start;
    if (last) course.endTime = last.end;
  }
  return courses;
}

const WEEKDAY_WORDS: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

function parseWeekdayText(raw: unknown): number | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  const cn = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/);
  if (cn) return WEEKDAY_WORDS[cn[1]] ?? null;
  const idx = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].findIndex(k => text.startsWith(k));
  return idx >= 0 ? idx + 1 : null;
}

function minutesOf(time: string): number {
  const [h, m] = String(time || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

type CourseConflict = { weekday: number; a: string; b: string; start: string; end: string };

// 找出同一天里时间交叠的课程对。
function detectConflicts(courses: Array<Record<string, unknown>>): CourseConflict[] {
  const out: CourseConflict[] = [];
  for (let day = 1; day <= 7; day++) {
    const list = courses.filter(c => Number(c.weekday) === day && c.startTime && c.endTime)
      .sort((a, b) => minutesOf(String(a.startTime)) - minutesOf(String(b.startTime)));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (minutesOf(String(b.startTime)) >= minutesOf(String(a.endTime))) break;
        out.push({ weekday: day, a: String(a.courseName), b: String(b.courseName), start: String(b.startTime), end: String(a.endTime) });
      }
    }
  }
  return out;
}

// 出现重叠时带着原图再问一次模型，让它重新确认这些课到底在哪一列、占哪几节。
async function verifyConflicts(apiKey: string, image: string, periodImage: string, suspects: Array<Record<string, unknown>>) {
  const list = suspects.map(c => ({ courseName: c.courseName, weekday: c.weekday, periodStart: c.periodStart, periodEnd: c.periodEnd }));
  const content: Array<Record<string, unknown>> = [{ type: 'image_url', image_url: { url: image } }];
  if (periodImage) content.push({ type: 'image_url', image_url: { url: periodImage } });
  content.push({
    type: 'text',
    text: `下面这些课程被读到了同一天并且时间重叠，很可能是星期列或节次读错了。请重新仔细查看原图核实：\n${JSON.stringify(list)}\n\n输出 JSON：{"items":[{"courseName":"课程名","weekdayText":"该课所在列的标题原文，如 周三","periodStart":5,"periodEnd":6}]}\n要求：必须重新看图判断，不要照抄上面给的值；如果原图里确实同一天重叠，也照实回答。只输出 JSON。`,
  });
  for (const model of MODEL_LIST.slice(0, 2)) {
    try {
      const response = await postChat(apiKey, model, content, 1200, 35000);
      if (!response.ok) {
        console.error(`verify ${model} ${response.status}`);
        continue;
      }
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content || '');
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim());
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).items)) {
        return ((parsed as Record<string, unknown>).items as Array<Record<string, unknown>>);
      }
    } catch (error) {
      console.error(`verify ${model} failed: ${String(error)}`);
    }
  }
  return [] as Array<Record<string, unknown>>;
}

// 统一发请求：国内站被 403 拒绝时，自动换国际站再试，兼容国际站创建的密钥。
async function postChat(apiKey: string, model: string, content: Array<Record<string, unknown>>, maxTokens: number, timeoutMs: number) {
  const bases = [DASHSCOPE_BASE, DASHSCOPE_INTL_BASE];
  let lastResponse: Response | null = null;
  for (const base of bases) {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 403) { lastResponse = response; continue; }
    return response;
  }
  return lastResponse as Response;
}

async function recognize(apiKey: string, image: string, periods: string, periodImage: string) {
  let lastError: Error | null = null;
  const content: Array<Record<string, unknown>> = [{ type: 'image_url', image_url: { url: image } }];
  if (periodImage) {
    content.push({ type: 'text', text: '第二张图片是节次时间表，请把表里每一行原样抄进 periods 字段。' });
    content.push({ type: 'image_url', image_url: { url: periodImage } });
  }
  content.push({ type: 'text', text: buildPrompt(periods) });

  for (const model of MODEL_LIST) {
    let response: Response;
    try {
      response = await postChat(apiKey, model, content, 4000, 45000);
    } catch (error) {
      console.error(`recognize ${model} request failed: ${String(error)}`);
      lastError = new Error('识别服务响应超时，请稍后重试。');
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      const payload = extractPayload(text);
      if (payload) {
        const periodTable = normalizePeriods(payload.periods);
        const courses = resolveTimes(normalizeCourses(payload.courses), periodTable);
        const detected = detectConflicts(courses);
        let fixed = 0;
        // 一发现同一天时间重叠，就带原图再核对一次，判断是识别错误还是课表本身重叠。
        if (detected.length && detected.length <= 12) {
          const names = new Set<string>();
          detected.forEach(c => { names.add(c.a); names.add(c.b); });
          const suspects = courses.filter(c => names.has(String(c.courseName)));
          const verified = await verifyConflicts(apiKey, image, periodImage, suspects);
          for (const item of verified) {
            const target = courses.find(c => String(c.courseName).trim() === String(item.courseName ?? '').trim());
            if (!target) continue;
            const before = `${target.weekday}|${target.periodStart}|${target.periodEnd}`;
            const mapped = parseWeekdayText(item.weekdayText);
            if (mapped) target.weekday = mapped;
            else if (item.weekday !== undefined) target.weekday = Math.round(clampNumber(item.weekday, 1, 7, Number(target.weekday)));
            const ps = normalizeWeek(item.periodStart), pe = normalizeWeek(item.periodEnd);
            if (ps !== null) target.periodStart = ps;
            if (pe !== null) target.periodEnd = pe;
            if (`${target.weekday}|${target.periodStart}|${target.periodEnd}` !== before) fixed++;
          }
          resolveTimes(courses, periodTable);
        }
        const remaining = detectConflicts(courses);
        console.log(`recognize ${model} ok: courses=${courses.length} periods=${periodTable.length} detected=${detected.length} fixed=${fixed} remaining=${remaining.length}`);
        return { courses, report: { detected: detected.length, fixed, remaining } };
      }
      console.error(`recognize ${model} unparsable: ${text.slice(0, 500)}`);
      lastError = new Error('无法解析识别结果，请尝试更清晰的图片。');
      continue;
    }

    const detail = (await response.text()).slice(0, 300);
    console.error(`recognize ${model} ${response.status}: ${detail}`);

    if (response.status === 401) {
      throw new Error('DASHSCOPE_API_KEY 无效或没有权限，请在 Supabase 中重新设置密钥。');
    }
    // 把百炼返回的原因带出来，方便定位是额度、限流还是模型未开通。
    const reason = (() => {
      try {
        const body = JSON.parse(detail);
        return String(body?.error?.message || body?.message || '').replace(/\s+/g, ' ').slice(0, 90);
      } catch {
        return detail.replace(/\s+/g, ' ').slice(0, 90);
      }
    })();
    if (response.status === 403) {
      lastError = new Error('百炼拒绝访问（HTTP 403）：密钥没有该模型的权限，或账号未开通模型、欠费、未实名。请到百炼控制台确认已开通 qwen-vl-plus 且账户可用。');
      continue;
    }
    if ([400, 404, 429].includes(response.status) || response.status >= 500) {
      lastError = new Error(`识别服务暂时不可用（HTTP ${response.status}${reason ? '：' + reason : ''}）。`);
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

  // 可选的节次时间对照：文字直接拼进 Prompt，图片作为第二张图喂给模型。
  const periods = String(body?.periods ?? '').trim().slice(0, 800);
  const periodImage = String(body?.periodImage ?? '').trim();
  if (periodImage) {
    if (!/^data:image\/(png|jpe?g|webp|bmp);base64,/i.test(periodImage)) {
      return json({ error: '节次时间表的图片格式不支持，请上传 JPG、PNG 或 WebP 图片。' }, 400);
    }
    if (periodImage.length > MAX_IMAGE_CHARS) {
      return json({ error: '节次时间表图片过大，请压缩或重新截图。' }, 413);
    }
  }

  try {
    const result = await recognize(apiKey, image, periods, periodImage);
    return json(result);
  } catch (error) {
    const message = String((error as Error)?.message || '识别失败，请检查网络或稍后重试。');
    console.error('recognize-timetable failed:', message);
    return json({ error: message }, 502);
  }
});
