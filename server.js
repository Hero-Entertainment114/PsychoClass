import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
// Email fallback uses the Resend HTTP API; no extra npm package is required.
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const REPORT_EMAIL_FROM = (process.env.REPORT_EMAIL_FROM || '').trim();
const REPORT_EMAIL_TO = (process.env.REPORT_EMAIL_TO || '').trim();
const QUESTION_FILE = path.join(__dirname, 'data', 'cau-hoi.txt');
const rateBuckets = new Map();
// Serialize Discord webhook submissions within this server process to reduce bursts.
let discordSendQueue = Promise.resolve();
const MAX_BODY_BYTES = 220_000;
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 15 * 60 * 1000;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalAt = line.indexOf('=');
    if (equalAt < 1) continue;
    const key = line.slice(0, equalAt).trim();
    let value = line.slice(equalAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(html);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Dữ liệu gửi lên quá lớn.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('Nội dung JSON không hợp lệ.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function isAllowedWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['discord.com', 'discordapp.com'].includes(url.hostname) &&
      /^\/api\/webhooks\/\d+\//.test(url.pathname);
  } catch {
    return false;
  }
}

function rateLimit(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) bucket = { start: now, count: 0 };
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) if (now - value.start > RATE_WINDOW_MS) rateBuckets.delete(key);
  }
  if (bucket.count > RATE_LIMIT) {
    sendJson(res, 429, { error: 'Có quá nhiều yêu cầu trong thời gian ngắn. Hãy thử lại sau ít phút.' });
    return false;
  }
  return true;
}

function requireAI(res) {
  if (!GROQ_API_KEY || GROQ_API_KEY.includes('PASTE_YOUR_')) {
    sendJson(res, 503, {
      error: 'Chưa cấu hình GROQ_API_KEY. Hãy sao chép .env.example thành .env và điền API key của GroqCloud.'
    });
    return false;
  }
  return true;
}

async function callGroq(prompt, { temperature = 0.7 } = {}) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: 'Bạn là trợ lý hỗ trợ cảm xúc học đường. Hãy tuân thủ yêu cầu trong tin nhắn người dùng và nếu được yêu cầu JSON, chỉ trả về JSON hợp lệ, không thêm markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerMessage = data?.error?.message || `HTTP ${response.status}`;
    const error = new Error(`GroqCloud API không phản hồi thành công: ${providerMessage}`);
    error.statusCode = response.status === 429 ? 429 : 502;
    throw error;
  }
  const result = data?.choices?.[0]?.message?.content?.trim();
  if (!result) throw Object.assign(new Error('GroqCloud không trả về nội dung.'), { statusCode: 502 });
  return parseModelJson(result);
}

function parseModelJson(text) {
  try { return JSON.parse(text); } catch { /* continue with bounded extraction */ }
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(text.slice(objectStart, objectEnd + 1)); } catch { /* throw below */ }
  }
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try { return JSON.parse(text.slice(arrayStart, arrayEnd + 1)); } catch { /* throw below */ }
  }
  throw Object.assign(new Error('Không đọc được JSON do AI tạo. Hãy thử lại.'), { statusCode: 502 });
}

function parseQuestionBank() {
  if (!fs.existsSync(QUESTION_FILE)) throw new Error('Không tìm thấy data/cau-hoi.txt.');
  const source = fs.readFileSync(QUESTION_FILE, 'utf8').replace(/^\uFEFF/, '');
  const questions = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)[.)]\s*(.+)$/u);
    if (!match) continue;
    const title = match[2].replace(/\s*\(Tự luận\)\s*$/iu, '').replace(/\s*\*+\s*$/u, '').trim();
    if (title) questions.push({ number: Number(match[1]), title });
  }
  if (questions.length < 3) throw new Error('Tệp TXT cần có ít nhất 3 câu hỏi được đánh số.');
  const first = questions.find(q => q.number === 1);
  const second = questions.find(q => q.number === 2);
  if (!first || !second) throw new Error('Tệp TXT phải chứa câu số 1 và câu số 2.');
  return questions;
}

function shuffled(items) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function safeString(value, maxLength = 5000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

async function makeQuestionSet() {
  const bank = parseQuestionBank();
  const mustInclude = [bank.find(q => q.number === 1), bank.find(q => q.number === 2)];
  const remaining = bank.filter(q => q.number !== 1 && q.number !== 2);
  const extraCount = 1 + Math.floor(Math.random() * 3); // 1–3 more TXT questions.
  const selectedSource = [...mustInclude, ...shuffled(remaining).slice(0, extraCount)];
  const sourceRows = selectedSource.map(q => ({
    id: randomUUID(),
    title: q.title,
    category: 'Câu hỏi từ tệp TXT',
    description: 'Bạn có thể trả lời bằng trải nghiệm của mình, chỉ chia sẻ ở mức khiến bạn thấy thoải mái.',
    placeholder: 'Viết suy nghĩ của bạn ở đây…',
    sourceType: 'txt',
    sourceNumber: q.number
  }));
  const aiCount = 10 - sourceRows.length;
  const bankContext = bank.map(q => `${q.number}. ${q.title}`).join('\n');
  const selectedContext = selectedSource.map(q => `${q.number}. ${q.title}`).join('\n');
  const prompt = `Bạn là trợ lý hỗ trợ cảm xúc học đường, có kiến thức về tâm lý phát triển vị thành niên nhưng KHÔNG phải bác sĩ/nhà trị liệu và không chẩn đoán.

Nhiệm vụ: tạo chính xác ${aiCount} câu hỏi tự luận MỚI bằng tiếng Việt để hoàn thành khảo sát tổng cộng 10 câu. Chủ đề phải dựa sát tệp câu hỏi gốc: cảm giác thích/yêu, nhận diện cảm xúc, rung động, cách bày tỏ, từ chối và ranh giới, niềm tin, thất vọng, khó khăn trong quan hệ tình cảm ở tuổi học trò.

Tệp TXT đầy đủ:
${bankContext}

Các câu TXT sẽ xuất hiện trong bài khảo sát, KHÔNG được sao chép hoặc diễn đạt lại gần như giống các câu này:
${selectedContext}

Yêu cầu mỗi câu: mở, dễ hiểu với học sinh; không ép khai danh tính thật; không hỏi chi tiết tình dục; không gợi ý hành vi nguy hiểm; không phán xét hoặc mặc định mọi người phải yêu đương. Câu hỏi phải đa dạng, cụ thể và không trùng ý. Viết mô tả ngắn giúp người trả lời thấy an toàn khi chia sẻ.

Chỉ trả JSON hợp lệ theo cấu trúc: {"questions":[{"title":"Câu hỏi kết thúc bằng dấu ?","category":"Chủ đề ngắn","description":"Lời dẫn ngắn","placeholder":"Gợi ý nhập câu trả lời"}]} . Phải có đúng ${aiCount} mục, không markdown.`;
  const generated = await callGroq(prompt, { temperature: 0.85 });
  const aiRows = Array.isArray(generated?.questions) ? generated.questions : Array.isArray(generated) ? generated : [];
  if (aiRows.length < aiCount) throw Object.assign(new Error(`AI chỉ tạo được ${aiRows.length}/${aiCount} câu. Hãy thử tạo lại.`), { statusCode: 502 });
  const normalizedAiRows = aiRows.slice(0, aiCount).map((q, index) => {
    const title = safeString(q?.title, 260);
    if (!title) throw Object.assign(new Error('AI có tạo ra câu hỏi trống. Hãy thử lại.'), { statusCode: 502 });
    return {
      id: randomUUID(),
      title,
      category: safeString(q?.category, 80) || 'Nhận diện cảm xúc',
      description: safeString(q?.description, 500) || 'Không có câu trả lời đúng hay sai; hãy chia sẻ theo mức độ thoải mái của bạn.',
      placeholder: safeString(q?.placeholder, 160) || 'Viết suy nghĩ của bạn ở đây…',
      sourceType: 'ai',
      sourceNumber: null
    };
  });
  const combined = shuffled([...sourceRows, ...normalizedAiRows]).map((q, index) => ({ ...q, position: index + 1 }));
  if (combined.length !== 10) throw Object.assign(new Error('Bộ câu hỏi không đủ 10 câu.'), { statusCode: 500 });
  return { questions: combined, sourceCount: sourceRows.length, aiCount };
}

async function coachAnswer({ question, answer, age }) {
  const prompt = `Bạn là trợ lý hỗ trợ cảm xúc học đường, giao tiếp ấm áp, bình tĩnh, tôn trọng và không phán xét. Bạn không phải chuyên gia lâm sàng đang khám trực tiếp, không chẩn đoán hay suy đoán chắc chắn về nhân cách chỉ từ một câu trả lời.

Thông tin bối cảnh: đây là khảo sát tự luận về cảm xúc thích/yêu và các mối quan hệ tuổi học trò. Độ tuổi được cung cấp (nếu có): ${age || 'không cung cấp'}.
Câu hỏi khảo sát: ${safeString(question?.title, 500)}
Chủ đề: ${safeString(question?.category, 100)}
Câu trả lời của người dùng: ${safeString(answer, 5000)}

Hãy phản hồi cho chính câu trả lời này, không phán xét và không gán nhãn. Nêu cảm nhận/điều bạn hiểu được một cách thận trọng, một lời khuyên thực tế, và một câu hỏi gợi mở tiếp nối đúng chủ đề. Công nhận rằng người trả lời có thể có cảm xúc phức tạp hoặc chưa rõ mình muốn gì. Không áp đặt phải yêu, phải tỏ tình hay phải tha thứ. Nếu câu trả lời có dấu hiệu nguy hiểm tức thời/tự làm hại, ưu tiên khuyên tìm người lớn đáng tin cậy hoặc dịch vụ khẩn cấp tại nơi ở, không chỉ đưa lời khuyên chung.

Chỉ trả JSON hợp lệ: {"reflection":"Cảm nhận thận trọng, 2-4 câu","advice":"Lời khuyên cụ thể, 2-4 câu","followUpQuestion":"Một câu hỏi gợi mở ngắn, không gây áp lực"}. Không chẩn đoán, không markdown.`;
  const data = await callGroq(prompt, { temperature: 0.55 });
  return {
    reflection: safeString(data?.reflection, 1600) || 'Câu trả lời của bạn đáng được lắng nghe, và bạn không cần phải có ngay một kết luận về cảm xúc của mình.',
    advice: safeString(data?.advice, 1600) || 'Hãy cho bản thân thời gian, giữ ranh giới phù hợp và trò chuyện với người đáng tin cậy khi cần.',
    followUpQuestion: safeString(data?.followUpQuestion, 500) || 'Điều gì sẽ khiến bạn cảm thấy an toàn và được tôn trọng hơn trong tình huống này?'
  };
}

function normalizeList(value, limit = 5) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map(item => safeString(String(item ?? ''), 500)).filter(Boolean);
}

async function makeFinalAnalysis({ userInfo, questions }) {
  const answersText = questions.map((q, i) => {
    const line = [`Câu ${i + 1}: ${safeString(q.title, 300)}`, `Nguồn: ${q.sourceType === 'txt' ? `TXT câu ${q.sourceNumber}` : 'AI'}`, `Trả lời: ${safeString(q.answer, 3000) || '(Bỏ qua)'}`];
    if (q.coach) line.push(`Phản hồi trước đó: ${safeString(q.coach.reflection, 700)}`, `Lời khuyên trước đó: ${safeString(q.coach.advice, 700)}`);
    if (q.reflectionAnswer) line.push(`Trả lời câu hỏi gợi mở (không bắt buộc): ${safeString(q.reflectionAnswer, 1500)}`);
    return line.join('\n');
  }).join('\n\n');
  const prompt = `Bạn là trợ lý hỗ trợ cảm xúc học đường, không phải chuyên gia lâm sàng chẩn đoán. Hãy đọc 10 câu trả lời trong khảo sát về cảm xúc thích/yêu và quan hệ tuổi học trò. Viết bằng tiếng Việt tự nhiên, ấm áp, tôn trọng, không lên lớp. Không đưa chẩn đoán, không kết luận quá mức từ khảo sát ngắn, không chấm điểm và không gọi người dùng là bất thường.

Biệt danh (có thể là ẩn danh): ${safeString(userInfo?.nickname, 80) || 'Ẩn danh'}
Độ tuổi: ${safeString(String(userInfo?.age || ''), 10) || 'Không cung cấp'}

${answersText}

Hãy tổng hợp cảm nhận và lời khuyên cân bằng. Chỉ ra các chủ đề/cảm xúc thể hiện trực tiếp trong câu trả lời, tách biệt điều quan sát được khỏi điều chưa thể biết; nêu điểm mạnh hoặc cách ứng xử tích cực nếu câu trả lời thực sự cho thấy điều đó; đưa ra 3-5 gợi ý nhỏ, cụ thể. Đừng bịa thêm sự kiện hoặc tự nhận người dùng đang có một vấn đề sức khỏe tâm thần. Nếu có nội dung ám chỉ nguy cơ làm hại bản thân/người khác, nói rõ cần liên hệ người lớn đáng tin cậy hoặc dịch vụ hỗ trợ khẩn cấp tại địa phương.

Chỉ trả JSON hợp lệ: {"overview":"Đoạn tổng quan 3-6 câu","observations":["Chủ đề quan sát 1"],"strengths":["Điểm tích cực được hỗ trợ bởi câu trả lời"],"recommendations":["Gợi ý cụ thể"],"supportiveClosing":"Lời kết ngắn, không phán xét"}. Không markdown.`;
  const data = await callGroq(prompt, { temperature: 0.5 });
  return {
    overview: safeString(data?.overview, 3000) || 'Cảm ơn bạn đã chia sẻ. Một khảo sát ngắn không thể định nghĩa toàn bộ con người hay cảm xúc của bạn.',
    observations: normalizeList(data?.observations, 5),
    strengths: normalizeList(data?.strengths, 5),
    recommendations: normalizeList(data?.recommendations, 6),
    supportiveClosing: safeString(data?.supportiveClosing, 1200) || 'Cảm xúc của bạn xứng đáng được lắng nghe. Bạn có thể đi từng bước và tìm người đáng tin cậy để trò chuyện khi cần.'
  };
}

function buildReport({ userInfo, questions, analysis, timestamp }) {
  const lines = [
    'PSYCHOCLASS • KẾT QUẢ KHẢO SÁT CẢM XÚC HỌC ĐƯỜNG',
    `Thời gian: ${timestamp}`,
    `Biệt danh: ${safeString(userInfo?.nickname, 80) || 'Ẩn danh'}`,
    `Độ tuổi: ${safeString(String(userInfo?.age || ''), 10) || 'Không cung cấp'}`,
    '',
    'PHẢN HỒI TỔNG QUAN CỦA AI',
    safeString(analysis.overview, 3000),
    '',
    'Các chủ đề quan sát được:',
    ...(analysis.observations.length ? analysis.observations.map(x => `• ${x}`) : ['• Không có mục được tách riêng.']),
    '',
    'Điểm tích cực được ghi nhận:',
    ...(analysis.strengths.length ? analysis.strengths.map(x => `• ${x}`) : ['• Không đưa ra nhận định cụ thể.']),
    '',
    'Gợi ý:',
    ...(analysis.recommendations.length ? analysis.recommendations.map((x, i) => `${i + 1}. ${x}`) : ['Hãy tự chăm sóc bản thân và trò chuyện với người đáng tin cậy khi cần.']),
    '',
    analysis.supportiveClosing,
    '',
    '10 CÂU HỎI VÀ CÂU TRẢ LỜI'
  ];
  questions.forEach((q, i) => {
    lines.push('', `${i + 1}. ${safeString(q.title, 300)} [${q.sourceType === 'txt' ? `TXT #${q.sourceNumber}` : 'AI'}]`);
    lines.push(`Trả lời: ${safeString(q.answer, 5000) || '(Bỏ qua)'}`);
    if (q.coach) {
      lines.push(`Cảm nhận AI: ${safeString(q.coach.reflection, 1600)}`);
      lines.push(`Lời khuyên AI: ${safeString(q.coach.advice, 1600)}`);
      lines.push(`Câu hỏi gợi mở: ${safeString(q.coach.followUpQuestion, 500)}`);
    }
    if (q.reflectionAnswer) lines.push(`Trả lời câu hỏi gợi mở: ${safeString(q.reflectionAnswer, 1500)}`);
  });
  lines.push('', 'Lưu ý: Đây là phản hồi hỗ trợ và tự suy ngẫm, không phải chẩn đoán hay thay thế chuyên gia tâm lý.');
  return lines.join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendDiscordReportNow(reportText, analysis) {
  if (!DISCORD_WEBHOOK_URL || !isAllowedWebhook(DISCORD_WEBHOOK_URL)) {
    return { sent: false, reason: 'Máy chủ chưa cấu hình webhook Discord hợp lệ.' };
  }

  const summary = safeString(analysis.overview, 1800) || 'Đã nhận kết quả khảo sát.';
  const payload = {
    username: 'PsychoClass',
    embeds: [{
      title: 'Kết quả khảo sát tâm lý học đường',
      description: summary,
      color: 14446304,
      fields: [
        { name: 'Phản hồi AI', value: 'Báo cáo đầy đủ được đính kèm dưới dạng tệp TXT.', inline: false },
        { name: 'Quyền riêng tư', value: 'Bản báo cáo này được gửi theo lựa chọn đồng ý của người tham gia.', inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'PsychoClass • Trợ lý phản hồi cảm xúc, không chẩn đoán' }
    }]
  };

  // Retry only on 429, honoring Discord's Retry-After / retry_after values.
  // Rebuild FormData for every attempt rather than reusing a consumed request body.
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const form = new FormData();
    form.set('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([reportText], { type: 'text/plain;charset=utf-8' }), 'PsychoClass_Report.txt');

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000)
    });

    if (response.ok || response.status === 204) {
      console.log('[discord-send] Báo cáo đã được gửi.');
      return { sent: true };
    }

    const responseText = await response.text().catch(() => '');
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = response.headers.get('retry-after');
      let retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : Number.NaN;
      try {
        const data = JSON.parse(responseText);
        if (Number.isFinite(Number(data?.retry_after))) {
          retryAfterSeconds = Math.max(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0, Number(data.retry_after));
        }
      } catch {
        // Use the Retry-After header if the response body isn't JSON.
      }
      if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) retryAfterSeconds = 2 ** (attempt + 1);
      if (retryAfterSeconds > 25) {
        console.warn(`[discord-send] HTTP 429; Discord yêu cầu chờ ${retryAfterSeconds}s, vượt thời gian chờ đồng bộ.`);
        return { sent: false, reason: `Discord đang giới hạn tần suất. Hãy thử lại sau khoảng ${Math.ceil(retryAfterSeconds)} giây.` };
      }
      const waitMs = Math.ceil(retryAfterSeconds * 1000) + 300;
      console.warn(`[discord-send] HTTP 429; thử lại sau ${waitMs}ms (lần ${attempt + 1}/${maxRetries}).`);
      await sleep(waitMs);
      continue;
    }

    // Do not retry permanent errors such as an invalid or revoked webhook.
    console.error(`[discord-send] HTTP ${response.status}: ${responseText.slice(0, 300)}`);
    return {
      sent: false,
      reason: response.status === 404
        ? 'Webhook Discord không tồn tại hoặc đã bị thu hồi. Hãy kiểm tra DISCORD_WEBHOOK_URL.'
        : response.status === 401 || response.status === 403
          ? 'Discord từ chối webhook. Hãy kiểm tra URL và quyền truy cập.'
          : `Discord trả về lỗi HTTP ${response.status}.`
    };
  }
  return { sent: false, reason: 'Discord vẫn giới hạn tần suất sau nhiều lần thử. Hãy thử lại sau ít phút.' };
}

function sendDiscordReport(reportText, analysis) {
  // Queue submissions to avoid sending concurrent requests to the same webhook.
  const task = discordSendQueue.then(() => sendDiscordReportNow(reportText, analysis));
  discordSendQueue = task.catch(() => {});
  return task;
}

function isEmailFallbackConfigured() {
  return Boolean(
    RESEND_API_KEY &&
    !RESEND_API_KEY.includes('PASTE_YOUR_') &&
    REPORT_EMAIL_FROM &&
    REPORT_EMAIL_TO &&
    REPORT_EMAIL_FROM.includes('@') &&
    REPORT_EMAIL_TO.includes('@')
  );
}

async function sendEmailFallback(reportText, analysis, timestamp) {
  if (!isEmailFallbackConfigured()) {
    return { sent: false, reason: 'Chưa cấu hình email dự phòng. Cần RESEND_API_KEY, REPORT_EMAIL_FROM và REPORT_EMAIL_TO.' };
  }

  const emailPayload = {
    from: REPORT_EMAIL_FROM,
    to: [REPORT_EMAIL_TO],
    subject: `PsychoClass: Báo cáo khảo sát ${timestamp}`,
    text: [
      'Discord không gửi được báo cáo PsychoClass; hệ thống chuyển sang email dự phòng theo lựa chọn đồng ý của người tham gia.',
      '',
      safeString(analysis?.overview, 3000),
      '',
      'Báo cáo đầy đủ được đính kèm dưới dạng tệp TXT.',
      'Lưu ý: Nội dung khảo sát có thể nhạy cảm; chỉ người được ủy quyền mới nên truy cập.'
    ].join('\n'),
    attachments: [{
      filename: 'PsychoClass_Report.txt',
      content: Buffer.from(reportText, 'utf8').toString('base64'),
      content_type: 'text/plain; charset=utf-8'
    }]
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload),
    signal: AbortSignal.timeout(20_000)
  });
  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    // Do not log the report or participant answers.
    console.error(`[email-fallback] Resend HTTP ${response.status}: ${responseText.slice(0, 250)}`);
    return {
      sent: false,
      reason: response.status === 401 || response.status === 403
        ? 'Nhà cung cấp email từ chối API key hoặc quyền gửi. Hãy kiểm tra cấu hình Resend.'
        : `Gửi email dự phòng thất bại (HTTP ${response.status}).`
    };
  }

  console.log('[email-fallback] Báo cáo đã được chuyển cho nhà cung cấp email.');
  return { sent: true, provider: 'resend' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { sendHtml(res, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')); }
    catch { sendJson(res, 500, { error: 'Không đọc được index.html.' }); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    let sourceQuestionCount = 0;
    try { sourceQuestionCount = parseQuestionBank().length; } catch { /* health response remains safe */ }
    sendJson(res, 200, {
      ok: true,
      aiConfigured: Boolean(GROQ_API_KEY && !GROQ_API_KEY.includes('PASTE_YOUR_')),
      discordConfigured: Boolean(DISCORD_WEBHOOK_URL && isAllowedWebhook(DISCORD_WEBHOOK_URL)),
      emailFallbackConfigured: isEmailFallbackConfigured(),
      sourceQuestionCount
    });
    return;
  }
  if (!['POST'].includes(req.method) || !['/api/questions', '/api/coach', '/api/submit'].includes(url.pathname)) {
    sendJson(res, 404, { error: 'Không tìm thấy đường dẫn.' });
    return;
  }
  if (!rateLimit(req, res)) return;
  if (!requireAI(res)) return;
  try {
    const body = await readJson(req);
    if (url.pathname === '/api/questions') {
      const result = await makeQuestionSet();
      sendJson(res, 200, result);
      return;
    }
    if (url.pathname === '/api/coach') {
      const question = body?.question;
      const answer = safeString(body?.answer, 5000);
      if (!question || !safeString(question.title, 500) || !answer) {
        sendJson(res, 400, { error: 'Cần có câu hỏi và câu trả lời không trống để tạo phản hồi.' });
        return;
      }
      const result = await coachAnswer({ question, answer, age: safeString(String(body?.age || ''), 10) });
      sendJson(res, 200, result);
      return;
    }
    if (url.pathname === '/api/submit') {
      const questions = Array.isArray(body?.questions) ? body.questions.slice(0, 10) : [];
      if (questions.length !== 10) {
        sendJson(res, 400, { error: 'Báo cáo cần đủ 10 câu hỏi.' });
        return;
      }
      const normalizedQuestions = questions.map(q => ({
        title: safeString(q?.title, 300),
        sourceType: q?.sourceType === 'txt' ? 'txt' : 'ai',
        sourceNumber: Number.isInteger(q?.sourceNumber) ? q.sourceNumber : null,
        category: safeString(q?.category, 100),
        answer: safeString(q?.answer, 5000),
        coach: q?.coach && typeof q.coach === 'object' ? {
          reflection: safeString(q.coach.reflection, 1600),
          advice: safeString(q.coach.advice, 1600),
          followUpQuestion: safeString(q.coach.followUpQuestion, 500)
        } : null,
        reflectionAnswer: safeString(q?.reflectionAnswer, 1500)
      }));
      const userInfo = {
        nickname: safeString(body?.userInfo?.nickname, 80),
        age: safeString(String(body?.userInfo?.age || ''), 10)
      };
      const analysis = await makeFinalAnalysis({ userInfo, questions: normalizedQuestions });
      const timestamp = new Date().toISOString();
      const reportText = buildReport({ userInfo, questions: normalizedQuestions, analysis, timestamp });
      let discord = { sent: false, reason: 'Người tham gia chưa đồng ý gửi báo cáo đến Discord.' };
      let emailFallback = { sent: false, reason: 'Chưa cần dùng email dự phòng.' };
      let delivery = 'local';
      if (body?.consentDiscord === true) {
        try {
          discord = await sendDiscordReport(reportText, analysis);
        } catch (error) {
          console.error('[discord-send]', error?.message || 'Discord request failed');
          discord = { sent: false, reason: 'Không gửi được đến Discord.' };
        }
        if (discord.sent) {
          delivery = 'discord';
        } else if (body?.consentEmailFallback === true) {
          // Email is a separate destination, so only use it after explicit consent.
          try {
            emailFallback = await sendEmailFallback(reportText, analysis, timestamp);
          } catch (error) {
            console.error('[email-fallback]', error?.message || 'Email fallback failed');
            emailFallback = { sent: false, reason: 'Không gửi được email dự phòng. Bạn vẫn có thể tải hoặc sao chép báo cáo.' };
          }
          if (emailFallback.sent) delivery = 'email';
        } else {
          emailFallback = { sent: false, reason: 'Chưa có sự đồng ý riêng để gửi báo cáo qua email dự phòng.' };
        }
      }
      sendJson(res, 200, { analysis, discord, emailFallback, delivery, reportText, timestamp });
      return;
    }
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    // Do not log request bodies or participants' answers.
    console.error('[request-error]', error?.message || 'Unknown error');
    sendJson(res, status, { error: status >= 500 ? (error?.message || 'Dịch vụ AI tạm thời gặp lỗi. Hãy thử lại.') : error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PsychoClass đang chạy tại http://localhost:${PORT}`);
  console.log(`GroqCloud: ${GROQ_API_KEY && !GROQ_API_KEY.includes('PASTE_YOUR_') ? 'đã cấu hình' : 'chưa cấu hình, xem file .env.example'}`);
  console.log(`Discord: ${DISCORD_WEBHOOK_URL && isAllowedWebhook(DISCORD_WEBHOOK_URL) ? 'đã cấu hình' : 'chưa cấu hình'}`);
});
