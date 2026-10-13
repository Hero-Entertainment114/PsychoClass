import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);

// Xử lý hỗ trợ nhiều GroqCloud API Keys (phân tách bằng dấu phẩy, chấm phẩy hoặc khoảng trắng)
const rawGroqKeys = process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS || '';
const groqKeys = rawGroqKeys.split(/[,;\s]+/).map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

function getNextGroqApiKey() {
  if (groqKeys.length === 0) return '';
  const key = groqKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % groqKeys.length;
  return key;
}

const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const REPORT_EMAIL_FROM = (process.env.REPORT_EMAIL_FROM || '').trim();
const REPORT_EMAIL_TO = (process.env.REPORT_EMAIL_TO || '').trim();
const QUESTION_FILE = path.join(__dirname, 'data', 'cau-hoi.txt');

const rateBuckets = new Map();
const analysisJobs = new Map(); // Lưu trữ kết quả phân tích theo jobId để tương thích với frontend
let discordSendQueue = Promise.resolve();
const MAX_BODY_BYTES = 220_000;
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 15 * 60 * 1000;

// Dọn dẹp job cũ sau 30 phút để giải phóng bộ nhớ
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of analysisJobs.entries()) {
    if (now - job.createdAt > 30 * 60 * 1000) analysisJobs.delete(id);
  }
}, 10 * 60 * 1000);

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
  if (groqKeys.length === 0 || groqKeys.some(k => k.includes('PASTE_YOUR_'))) {
    sendJson(res, 503, {
      error: 'Chưa cấu hình GROQ_API_KEY hợp lệ. Hãy kiểm tra lại file .env.'
    });
    return false;
  }
  return true;
}

// Hàm gọi GroqCloud có cơ chế tự động chuyển đổi sang API Key tiếp theo nếu gặp lỗi 429 hoặc lỗi xác thực
async function callGroq(prompt, { temperature = 0.7 } = {}) {
  const attempts = Math.max(1, groqKeys.length);
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    const apiKey = getNextGroqApiKey();
    if (!apiKey) break;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
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
      
      if (response.ok) {
        const result = data?.choices?.[0]?.message?.content?.trim();
        if (result) return parseModelJson(result);
      }

      const providerMessage = data?.error?.message || `HTTP ${response.status}`;
      const err = new Error(`GroqCloud API lỗi (${response.status}): ${providerMessage}`);
      err.statusCode = response.status === 429 ? 429 : 502;
      lastError = err;

      // Nếu gặp lỗi quá tải (429) hoặc lỗi xác thực (401/403), thử ngay key tiếp theo trong vòng lặp
      if ([429, 401, 403].includes(response.status) && groqKeys.length > 1) {
        console.warn(`[groq-rotation] Key hiện tại gặp lỗi ${response.status}, đang chuyển sang API Key tiếp theo...`);
        continue;
      }
      throw err;
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) throw err;
    }
  }

  throw lastError || Object.assign(new Error('Tất cả các GroqCloud API Key đều không phản hồi thành công.'), { statusCode: 502 });
}

function parseModelJson(text) {
  try { return JSON.parse(text); } catch { /* tiếp tục trích xuất */ }
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(text.slice(objectStart, objectEnd + 1)); } catch { /* ném lỗi bên dưới */ }
  }
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try { return JSON.parse(text.slice(arrayStart, arrayEnd + 1)); } catch { /* ném lỗi bên dưới */ }
  }
  throw Object.assign(new Error('Không đọc được định dạng JSON do AI tạo. Hãy thử lại.'), { statusCode: 502 });
}

function parseQuestionBank() {
  if (!fs.existsSync(QUESTION_FILE)) throw new Error('Không tìm thấy tệp data/cau-hoi.txt.');
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
  const extraCount = 1 + Math.floor(Math.random() * 3);
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
  const prompt = `Bạn là trợ lý hỗ trợ cảm xúc học đường. Tạo chính xác ${aiCount} câu hỏi tự luận MỚI bằng tiếng Việt để hoàn thành khảo sát tổng cộng 10 câu về chủ đề cảm xúc học đường.

Tệp TXT đầy đủ:
${bankContext}

Các câu TXT đã chọn (không sao chép các câu này):
${selectedContext}

Chỉ trả JSON hợp lệ theo cấu trúc: {"questions":[{"title":"Câu hỏi kết thúc bằng dấu ?","category":"Chủ đề ngắn","description":"Lời dẫn ngắn","placeholder":"Gợi ý nhập"}]} . Phải có đúng ${aiCount} mục, không markdown.`;
  
  const generated = await callGroq(prompt, { temperature: 0.85 });
  const aiRows = Array.isArray(generated?.questions) ? generated.questions : Array.isArray(generated) ? generated : [];
  if (aiRows.length < aiCount) throw Object.assign(new Error(`AI chỉ tạo được ${aiRows.length}/${aiCount} câu. Hãy thử lại.`), { statusCode: 502 });
  
  const normalizedAiRows = aiRows.slice(0, aiCount).map((q) => {
    const title = safeString(q?.title, 260);
    if (!title) throw Object.assign(new Error('AI tạo ra câu hỏi trống. Hãy thử lại.'), { statusCode: 502 });
    return {
      id: randomUUID(),
      title,
      category: safeString(q?.category, 80) || 'Nhận diện cảm xúc',
      description: safeString(q?.description, 500) || 'Không có câu trả lời đúng hay sai.',
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
  const prompt = `Bạn là trợ lý hỗ trợ cảm xúc học đường, giao tiếp ấm áp, bình tĩnh và không phán xét. Không chẩn đoán y khoa.

Câu hỏi: ${safeString(question?.title, 500)}
Chủ đề: ${safeString(question?.category, 100)}
Trả lời của người dùng: ${safeString(answer, 5000)}

Chỉ trả JSON hợp lệ: {"reflection":"Cảm nhận thận trọng, 2-4 câu","advice":"Lời khuyên cụ thể, 2-4 câu","followUpQuestion":"Một câu hỏi gợi mở ngắn"}. Không markdown.`;
  const data = await callGroq(prompt, { temperature: 0.55 });
  return {
    reflection: safeString(data?.reflection, 1600) || 'Câu trả lời của bạn đáng được lắng nghe.',
    advice: safeString(data?.advice, 1600) || 'Hãy cho bản thân thời gian và giữ ranh giới phù hợp.',
    followUpQuestion: safeString(data?.followUpQuestion, 500) || 'Điều gì sẽ khiến bạn cảm thấy an toàn hơn trong tình huống này?'
  };
}

function normalizeList(value, limit = 5) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map(item => safeString(String(item ?? ''), 500)).filter(Boolean);
}

async function makeFinalAnalysis({ userInfo, questions }) {
  const answersText = questions.map((q, i) => {
    const line = [`Câu ${i + 1}: ${safeString(q.title, 300)}`, `Trả lời: ${safeString(q.answer, 3000) || '(Bỏ qua)'}`];
    return line.join('\n');
  }).join('\n\n');

  const prompt = `Tổng hợp khảo sát cảm xúc học đường. Biệt danh: ${safeString(userInfo?.nickname, 80) || 'Ẩn danh'}.

${answersText}

Chỉ trả JSON hợp lệ: {"overview":"Đoạn tổng quan 3-6 câu","observations":["Chủ đề quan sát"],"strengths":["Điểm tích cực"],"recommendations":["Gợi ý cụ thể"],"supportiveClosing":"Lời kết ngắn"}. Không markdown.`;
  const data = await callGroq(prompt, { temperature: 0.5 });
  return {
    overview: safeString(data?.overview, 3000) || 'Cảm ơn bạn đã chia sẻ.',
    observations: normalizeList(data?.observations, 5),
    strengths: normalizeList(data?.strengths, 5),
    recommendations: normalizeList(data?.recommendations, 6),
    supportiveClosing: safeString(data?.supportiveClosing, 1200) || 'Cảm xúc của bạn xứng đáng được lắng nghe.'
  };
}

function buildReport({ userInfo, questions, analysis, timestamp }) {
  const lines = [
    'PSYCHOCLASS • KẾT QUẢ KHẢO SÁT CẢM XÚC HỌC ĐƯỜNG',
    `Thời gian: ${timestamp}`,
    `Biệt danh: ${safeString(userInfo?.nickname, 80) || 'Ẩn danh'}`,
    `Độ tuổi: ${safeString(String(userInfo?.age || ''), 10) || 'Không cung cấp'}`,
    '',
    'PHẢN HỒI TỔNG QUAN',
    safeString(analysis.overview, 3000),
    '',
    'Các chủ đề quan sát được:',
    ...(analysis.observations.length ? analysis.observations.map(x => `• ${x}`) : ['• Không có mục cụ thể.']),
    '',
    'Gợi ý:',
    ...(analysis.recommendations.length ? analysis.recommendations.map((x, i) => `${i + 1}. ${x}`) : ['Hãy tự chăm sóc bản thân.']),
    '',
    analysis.supportiveClosing,
    '',
    '10 CÂU HỎI VÀ CÂU TRẢ LỜI'
  ];
  questions.forEach((q, i) => {
    lines.push('', `${i + 1}. ${safeString(q.title, 300)}`);
    lines.push(`Trả lời: ${safeString(q.answer, 5000) || '(Bỏ qua)'}`);
  });
  return lines.join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendDiscordReportNow(reportText, analysis) {
  if (!DISCORD_WEBHOOK_URL || !isAllowedWebhook(DISCORD_WEBHOOK_URL)) {
    return { sent: false, reason: 'Chưa cấu hình webhook Discord hợp lệ.' };
  }
  const summary = safeString(analysis.overview, 1800) || 'Đã nhận kết quả khảo sát.';
  const payload = {
    username: 'PsychoClass',
    embeds: [{
      title: 'Kết quả khảo sát tâm lý học đường',
      description: summary,
      color: 14446304,
      timestamp: new Date().toISOString()
    }]
  };
  const form = new FormData();
  form.set('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([reportText], { type: 'text/plain;charset=utf-8' }), 'PsychoClass_Report.txt');

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000)
  });
  if (response.ok || response.status === 204) return { sent: true };
  return { sent: false, reason: `Discord trả về lỗi HTTP ${response.status}.` };
}

function sendDiscordReport(reportText, analysis) {
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
    return { sent: false, reason: 'Chưa cấu hình email dự phòng.' };
  }
  const emailPayload = {
    from: REPORT_EMAIL_FROM,
    to: [REPORT_EMAIL_TO],
    subject: `PsychoClass: Báo cáo khảo sát ${timestamp}`,
    text: safeString(analysis?.overview, 3000),
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
  if (!response.ok) return { sent: false, reason: `Gửi email dự phòng thất bại (HTTP ${response.status}).` };
  return { sent: true };
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
    try { sourceQuestionCount = parseQuestionBank().length; } catch { /* bỏ qua */ }
    sendJson(res, 200, {
      ok: true,
      aiConfigured: groqKeys.length > 0 && !groqKeys.some(k => k.includes('PASTE_YOUR_')),
      discordConfigured: Boolean(DISCORD_WEBHOOK_URL && isAllowedWebhook(DISCORD_WEBHOOK_URL)),
      emailFallbackConfigured: isEmailFallbackConfigured(),
      sourceQuestionCount
    });
    return;
  }

  // Endpoint kết quả phân tích theo jobId phục vụ hàm watchAnalysisResult từ frontend
  if (req.method === 'GET' && url.pathname === '/api/results') {
    const jobId = url.searchParams.get('id');
    const job = jobId ? analysisJobs.get(jobId) : null;
    if (!job) {
      sendJson(res, 404, { error: 'Không tìm thấy tiến trình tổng kết.' });
      return;
    }
    sendJson(res, 200, job);
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
        sendJson(res, 400, { error: 'Cần có câu hỏi và câu trả lời để tạo phản hồi.' });
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
        answer: safeString(q?.answer, 5000)
      }));

      const userInfo = {
        nickname: safeString(body?.userInfo?.nickname, 80),
        age: safeString(String(body?.userInfo?.age || ''), 10)
      };

      const analysis = await makeFinalAnalysis({ userInfo, questions: normalizedQuestions });
      const timestamp = new Date().toISOString();
      const reportText = buildReport({ userInfo, questions: normalizedQuestions, analysis, timestamp });
      
      let discord = { sent: false, reason: 'Chưa đồng ý gửi Discord.' };
      let emailFallback = { sent: false, reason: 'Chưa cần dùng email dự phòng.' };
      let delivery = 'local';

      if (body?.consentDiscord === true) {
        try { discord = await sendDiscordReport(reportText, analysis); } catch { discord = { sent: false, reason: 'Lỗi gửi Discord.' }; }
        if (discord.sent) {
          delivery = 'discord';
        } else if (body?.consentEmailFallback === true) {
          try { emailFallback = await sendEmailFallback(reportText, analysis, timestamp); } catch { emailFallback = { sent: false, reason: 'Lỗi gửi email dự phòng.' }; }
          if (emailFallback.sent) delivery = 'email';
        }
      }

      const jobId = randomUUID();
      const jobData = {
        stage: 'complete',
        analysisPersonalized: true,
        analysis,
        discord,
        emailFallback,
        delivery,
        reportText,
        timestamp,
        createdAt: Date.now()
      };
      analysisJobs.set(jobId, jobData);

      sendJson(res, 200, {
        jobId,
        analysis,
        discord,
        emailFallback,
        delivery,
        reportText,
        timestamp,
        analysisMessage: 'Bản tổng kết cá nhân đã sẵn sàng.'
      });
      return;
    }
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    console.error('[request-error]', error?.message || 'Unknown error');
    sendJson(res, status, { error: error?.message || 'Dịch vụ tạm thời gặp lỗi. Hãy thử lại.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PsychoClass đang chạy tại http://localhost:${PORT}`);
  console.log(`GroqCloud: Đã tải ${groqKeys.length} API Key (Luân phiên & Tự động dự phòng).`);
});
