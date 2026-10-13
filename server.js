import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const GROQ_API_KEYS = collectGroqKeys();
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const QUESTION_FILE = path.join(__dirname, 'data', 'cau-hoi.txt');
const rateBuckets = new Map();
const resultJobs = new Map();
const keyCooldowns = new Map();
let keyCursor = 0;
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

function isPlaceholderKey(value) {
  const key = String(value || '').trim();
  return !key || /^(PASTE|YOUR_|CHANGEME|REPLACE_)/i.test(key);
}

function collectGroqKeys() {
  const keys = [];
  // GROQ_API_KEYS accepts comma-separated or newline-separated keys.
  if (process.env.GROQ_API_KEYS) {
    keys.push(...process.env.GROQ_API_KEYS.split(/[\n,;]+/g).map(x => x.trim()));
  }
  // Numbered variables are useful when keys are managed separately.
  for (let i = 1; i <= 20; i++) {
    const key = (process.env[`GROQ_API_KEY_${i}`] || '').trim();
    if (key) keys.push(key);
  }
  // Backward compatibility with the original single-key configuration.
  if (process.env.GROQ_API_KEY) keys.push(process.env.GROQ_API_KEY.trim());
  return [...new Set(keys.filter(key => !isPlaceholderKey(key)))];
}

function requireAI(res) {
  if (!GROQ_API_KEYS.length) {
    sendJson(res, 503, { error: 'Hiện chưa thể tạo phản hồi. Vui lòng thử lại sau.' });
    return false;
  }
  return true;
}

function keyOrder() {
  if (!GROQ_API_KEYS.length) return [];
  const now = Date.now();
  const ordered = [];
  for (let offset = 0; offset < GROQ_API_KEYS.length; offset++) {
    const index = (keyCursor + offset) % GROQ_API_KEYS.length;
    const key = GROQ_API_KEYS[index];
    if ((keyCooldowns.get(key) || 0) <= now) ordered.push({ key, index });
  }
  if (ordered.length) keyCursor = (ordered[0].index + 1) % GROQ_API_KEYS.length;
  return ordered.map(item => item.key);
}

function markKeyCooldown(key, milliseconds) {
  keyCooldowns.set(key, Date.now() + milliseconds);
}

function groqUserMessage(status) {
  if (status === 429) return 'Lượt hỗ trợ đang đông. Câu trả lời của bạn vẫn được giữ lại, bạn có thể thử lại sau ít phút.';
  if (status === 401 || status === 403) return 'Hiện chưa thể tạo phản hồi. Vui lòng thử lại sau.';
  return 'Mình chưa thể hoàn thiện phản hồi lúc này. Câu trả lời của bạn vẫn được giữ lại, hãy thử lại sau nhé.';
}

async function callGroq(prompt, { temperature = 0.7, maxTokens = 700, timeoutMs = 15_000 } = {}) {
  const keys = keyOrder();
  if (!keys.length) throw Object.assign(new Error('No available AI credentials'), { statusCode: 503, userMessage: groqUserMessage(503) });
  const deadline = Date.now() + Math.max(timeoutMs, 10_000);
  let lastStatus = 502;
  let lastError = null;
  // Bounded failover. Cooldowns prevent a failing key from being hammered repeatedly.
  for (const key of keys) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: 'Bạn là trợ lý hỗ trợ cảm xúc học đường. Hãy tuân thủ yêu cầu và nếu được yêu cầu JSON, chỉ trả về JSON hợp lệ, không thêm markdown.' },
            { role: 'user', content: prompt }
          ],
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(Math.min(12_000, remaining))
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastStatus = response.status;
        const providerMessage = String(data?.error?.message || '');
        // A model/parameter error applies to every key; don't retry it pointlessly.
        if (response.status === 400 && /model|response_format|parameter|token/i.test(providerMessage)) {
          throw Object.assign(new Error('Model or request configuration was rejected'), { statusCode: 400, terminal: true, userMessage: 'Mình chưa thể tạo phản hồi lúc này. Vui lòng thử lại sau nhé.' });
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'));
          markKeyCooldown(key, Math.min(Math.max(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000, 15_000), 180_000));
          lastError = new Error('Rate limited');
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          markKeyCooldown(key, 5 * 60_000);
          lastError = new Error('Credential rejected');
          continue;
        }
        if (response.status >= 500 || response.status === 408) {
          markKeyCooldown(key, 8_000);
          lastError = new Error('Temporary provider issue');
          continue;
        }
        throw Object.assign(new Error('Provider rejected the request'), { statusCode: 502, terminal: true });
      }
      const result = data?.choices?.[0]?.message?.content?.trim();
      if (!result) {
        markKeyCooldown(key, 5_000);
        lastError = new Error('Empty AI response');
        continue;
      }
      keyCooldowns.delete(key);
      return parseModelJson(result);
    } catch (error) {
      if (error?.terminal) throw error;
      lastError = error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.name === 'TypeError') {
        markKeyCooldown(key, 8_000);
        continue;
      }
      throw error;
    }
  }
  const statusCode = lastStatus === 429 ? 429 : 502;
  throw Object.assign(lastError || new Error('No AI route available'), { statusCode, userMessage: groqUserMessage(statusCode) });
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
  const generated = await callGroq(prompt, { temperature: 0.8, maxTokens: 1500, timeoutMs: 22_000 });
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
  const data = await callGroq(prompt, { temperature: 0.45, maxTokens: 420, timeoutMs: 17_000 });
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

function makeQuickAnalysis(questions) {
  const answered = questions.filter(q => safeString(q.answer, 5000) && !/^\(Người tham gia bỏ qua/i.test(q.answer)).length;
  return {
    overview: `Cảm ơn bạn đã dành thời gian hoàn thành khảo sát. Bạn đã chia sẻ ${answered} trong số 10 câu, và chỉ riêng việc dừng lại để gọi tên cảm xúc của mình cũng có thể là một bước hữu ích. Bản tổng kết này không định nghĩa con người bạn; nó chỉ là một điểm bắt đầu để bạn hiểu rõ hơn điều mình cảm thấy và điều mình cần.`,
    observations: ['Cảm xúc có thể thay đổi theo thời gian, và bạn không cần vội đặt tên cho tất cả.', 'Bạn có quyền giữ riêng những điều mình chưa sẵn sàng chia sẻ.', 'Sự tôn trọng, an toàn và ranh giới cá nhân luôn đáng được cân nhắc trong một mối quan hệ.'],
    strengths: ['Bạn đã dành thời gian nhìn lại trải nghiệm của mình.', 'Bạn có thể chọn bước tiếp theo phù hợp với tốc độ riêng của mình.'],
    recommendations: ['Thử viết lại điều bạn đang cảm thấy mà không tự phán xét.', 'Tự hỏi điều gì khiến bạn cảm thấy được tôn trọng và an toàn.', 'Nếu một chuyện khiến bạn nặng lòng, hãy chia sẻ với người bạn tin tưởng khi đã sẵn sàng.'],
    supportiveClosing: 'Bạn không cần phải có tất cả câu trả lời ngay hôm nay. Hãy đối xử với mình bằng sự kiên nhẫn mà bạn cũng dành cho một người bạn.'
  };
}

async function makeFinalAnalysis({ userInfo, questions }) {
  const answersText = questions.map((q, i) => {
    const answer = safeString(q.answer, 700) || '(Bỏ qua)';
    const followUp = safeString(q.reflectionAnswer, 180);
    return `${i + 1}. ${safeString(q.title, 180)}\nChia sẻ: ${answer}${followUp ? `\nNói thêm: ${followUp}` : ''}`;
  }).join('\n\n').slice(0, 8_000);
  const prompt = `Bạn là trợ lý hỗ trợ cảm xúc học đường. Hãy viết một bản phản hồi ngắn, ấm áp và có ích dựa trên những câu trả lời bên dưới. Không chẩn đoán, không gắn nhãn tính cách, không suy đoán điều người dùng chưa nói, không xem khảo sát như kết luận lâm sàng. Tách điều quan sát được khỏi điều chưa thể biết. Nếu câu trả lời có dấu hiệu nguy hiểm tức thời hoặc tự làm hại, ưu tiên khuyến khích liên hệ người lớn đáng tin cậy hoặc dịch vụ khẩn cấp tại nơi ở.

Biệt danh: ${safeString(userInfo?.nickname, 80) || 'Ẩn danh'}
Độ tuổi: ${safeString(String(userInfo?.age || ''), 10) || 'Không cung cấp'}

Câu trả lời:
${answersText}

Viết ngắn để người đọc không phải chờ lâu. overview 2-3 câu, observations tối đa 3 ý, strengths tối đa 2 ý, recommendations tối đa 3 gợi ý cụ thể, supportiveClosing 1 câu. Chỉ trả JSON hợp lệ theo cấu trúc: {"overview":"...","observations":["..."],"strengths":["..."],"recommendations":["..."],"supportiveClosing":"..."}. Không markdown.`;
  const data = await callGroq(prompt, { temperature: 0.35, maxTokens: 650, timeoutMs: 18_000 });
  return {
    overview: safeString(data?.overview, 1800) || makeQuickAnalysis(questions).overview,
    observations: normalizeList(data?.observations, 3),
    strengths: normalizeList(data?.strengths, 2),
    recommendations: normalizeList(data?.recommendations, 3),
    supportiveClosing: safeString(data?.supportiveClosing, 600) || makeQuickAnalysis(questions).supportiveClosing
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

async function sendDiscordReport(reportText, analysis) {
  if (!DISCORD_WEBHOOK_URL || !isAllowedWebhook(DISCORD_WEBHOOK_URL)) {
    return { sent: false, reason: 'Máy chủ chưa cấu hình webhook Discord hợp lệ.' };
  }
  const form = new FormData();
  const summary = safeString(analysis.overview, 1800) || 'Đã nhận kết quả khảo sát.';
  const payload = {
    username: 'PsychoClass',
    embeds: [{
      title: 'Kết quả khảo sát tâm lý học đường',
      description: summary,
      color: 14446304,
      fields: [
        { name: 'Phản hồi AI', value: 'Báo cáo đầy đủ được đính kèm dưới dạng tệp TXT để tránh làm lộ câu trả lời trong nhiều embed.', inline: false },
        { name: 'Quyền riêng tư', value: 'Bản báo cáo này được gửi theo lựa chọn đồng ý của người tham gia.', inline: false }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'PsychoClass • Trợ lý phản hồi cảm xúc, không chẩn đoán' }
    }]
  };
  form.set('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([reportText], { type: 'text/plain;charset=utf-8' }), 'PsychoClass_Report.txt');
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok && response.status !== 204) {
    const error = new Error(`Discord từ chối yêu cầu (HTTP ${response.status}).`);
    error.statusCode = 502;
    throw error;
  }
  return { sent: true };
}


async function processSubmissionJob(jobId, { userInfo, questions, consentDiscord }) {
  const job = resultJobs.get(jobId);
  if (!job) return;
  let analysis = job.analysis;
  let analysisPersonalized = true;
  try {
    analysis = await makeFinalAnalysis({ userInfo, questions });
  } catch (error) {
    analysisPersonalized = false;
    // The immediate, supportive reflection remains usable if AI is temporarily unavailable.
    console.error('[summary]', error?.message || 'Summary generation failed');
  }
  const current = resultJobs.get(jobId);
  if (!current) return;
  current.analysis = analysis;
  current.analysisPersonalized = analysisPersonalized;
  current.reportText = buildReport({ userInfo, questions, analysis, timestamp: current.timestamp });
  current.stage = 'analysis-ready';
  current.updatedAt = Date.now();

  if (consentDiscord) {
    current.discord = { sent: false, pending: true, reason: 'Đang chuyển bản tổng kết của bạn theo lựa chọn đã đồng ý.' };
    try {
      const delivery = await sendDiscordReport(current.reportText, analysis);
      current.discord = delivery?.sent
        ? { sent: true, pending: false, reason: 'Bản tổng kết đã được chuyển thành công.' }
        : { sent: false, pending: false, reason: 'Chưa thể chuyển báo cáo lúc này. Bạn vẫn có thể tải hoặc sao chép kết quả.' };
    } catch (error) {
      console.error('[discord-send]', error?.message || 'Discord request failed');
      current.discord = { sent: false, pending: false, reason: 'Chưa thể chuyển báo cáo lúc này. Bạn vẫn có thể tải hoặc sao chép kết quả.' };
    }
  } else {
    current.discord = { sent: false, pending: false, reason: 'Báo cáo chỉ được lưu trong kết quả trên màn hình vì bạn không chọn gửi đi.' };
  }
  current.stage = 'complete';
  current.updatedAt = Date.now();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { sendHtml(res, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')); }
    catch { sendJson(res, 500, { error: 'Không đọc được index.html.' }); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/results') {
    const id = url.searchParams.get('id') || '';
    const job = resultJobs.get(id);
    if (!job) {
      sendJson(res, 404, { error: 'Không tìm thấy kết quả này. Hãy hoàn thành khảo sát lại.' });
      return;
    }
    sendJson(res, 200, {
      jobId: id,
      stage: job.stage,
      analysis: job.analysis,
      analysisPersonalized: Boolean(job.analysisPersonalized),
      analysisMessage: job.analysisPersonalized === false ? 'Mình đã chuẩn bị một lời nhắn hỗ trợ để bạn không phải chờ thêm. Bạn có thể thử làm mới phần tổng kết sau.' : '',
      discord: job.discord,
      reportText: job.reportText,
      timestamp: job.timestamp
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
        sendJson(res, 400, { error: 'Bài khảo sát cần đủ 10 câu hỏi.' });
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
      const consentDiscord = body?.consentDiscord === true;
      const timestamp = new Date().toISOString();
      const initialAnalysis = makeQuickAnalysis(normalizedQuestions);
      const jobId = randomUUID();
      const job = {
        stage: 'processing',
        analysis: initialAnalysis,
        analysisPersonalized: false,
        reportText: buildReport({ userInfo, questions: normalizedQuestions, analysis: initialAnalysis, timestamp }),
        timestamp,
        updatedAt: Date.now(),
        discord: consentDiscord
          ? { sent: false, pending: true, reason: 'Đang chuẩn bị bản tổng kết để chuyển theo lựa chọn đã đồng ý.' }
          : { sent: false, pending: false, reason: 'Báo cáo chỉ được lưu trong kết quả trên màn hình vì bạn không chọn gửi đi.' }
      };
      resultJobs.set(jobId, job);
      // Keep only recent, active in-memory results and avoid accumulating private reports indefinitely.
      if (resultJobs.size > 200) {
        for (const [id, oldJob] of resultJobs) {
          if (oldJob.stage === 'complete') resultJobs.delete(id);
          if (resultJobs.size <= 180) break;
        }
      }
      sendJson(res, 202, {
        jobId,
        stage: 'processing',
        analysis: initialAnalysis,
        analysisPersonalized: false,
        analysisMessage: 'Mình đã nhận được phần chia sẻ của bạn. Bạn có thể đọc lời nhắn mở đầu trong lúc mình hoàn thiện phản hồi cá nhân.',
        discord: job.discord,
        reportText: job.reportText,
        timestamp,
        provisional: true
      });
      // The user's result is already visible; finish AI analysis and Discord delivery in the background.
      void processSubmissionJob(jobId, { userInfo, questions: normalizedQuestions, consentDiscord });
      return;
    }
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    // Do not log request bodies, keys, or participants' answers.
    console.error('[request-error]', error?.message || 'Unknown error');
    const publicMessage = error?.userMessage || (status === 429
      ? 'Lượt hỗ trợ đang đông. Câu trả lời của bạn vẫn được giữ lại, hãy thử lại sau ít phút.'
      : status >= 500
        ? 'Mình chưa thể hoàn thiện phần này lúc này. Vui lòng thử lại sau nhé.'
        : error.message);
    sendJson(res, status, { error: publicMessage });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PsychoClass đang chạy tại http://localhost:${PORT}`);
  console.log(`AI key pool configured: ${GROQ_API_KEYS.length}`);
  console.log(`Discord notifications: ${DISCORD_WEBHOOK_URL && isAllowedWebhook(DISCORD_WEBHOOK_URL) ? 'configured' : 'not configured'}`);
});
