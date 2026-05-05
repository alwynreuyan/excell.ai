require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.GEMINI_API_KEY;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MODEL = 'gemini-2.0-flash';

if (!API_KEY) {
  console.error('❌ CRITICAL: GEMINI_API_KEY not found in .env');
  process.exit(1);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      connectSrc: ["'self'", "https://generativelanguage.googleapis.com", "http://192.168.1.100", "http://*.local"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

const authenticate = (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${AUTH_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL, timestamp: new Date().toISOString() });
});

app.post('/api/chat', authenticate, async (req, res) => {
  try {
    const { message, history = [], devices = [], states = {} } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid message' });
    }

    const deviceList = devices.map(d => `- ${d.name} (id: "${d.id}", currently: ${states[d.id] ? 'ON' : 'OFF'})`).join('\n');

    const systemPrompt = `You are Excell AI, a smart home assistant controlling ESP32 relays.

Available devices:
${deviceList || '- No devices configured'}

You MUST respond with valid JSON only. No markdown, no explanation outside the JSON.
Format:
{
  "action": {
    "type": "control_relay",
    "params": { "device": "<device_id>", "action": "on|off|toggle" }
  },
  "response": "Human-readable confirmation message"
}
OR for scenes:
{
  "action": {
    "type": "run_scene",
    "params": { "scene": "morning|night|work|relax" }
  },
  "response": "Human-readable confirmation message"
}
OR if no device action needed:
{
  "action": null,
  "response": "Your conversational reply here"
}

User message: ${message}`;

    const geminiBody = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 512,
      },
    };

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (geminiRes.status === 400 || geminiRes.status === 403) {
      return res.status(401).json({ error: 'Invalid Gemini API key or unauthorized.' });
    }

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      console.error('Gemini error:', errData);
      return res.status(502).json({ error: 'AI model error', details: errData });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Strip markdown fences and parse JSON
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Best-effort: return raw text as response if JSON parse fails
      console.warn('JSON parse failed, raw:', cleaned);
      return res.json({ action: null, response: cleaned || 'I could not understand that. Please try again.' });
    }

    return res.json({
      action: parsed.action || null,
      response: parsed.response || 'Done.',
    });

  } catch (error) {
    console.error('Server error:', error);
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ error: 'AI request timed out.' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Excell AI server running at http://localhost:${PORT}`);
  console.log(`🤖 Model: ${MODEL}`);
  console.log(`🔑 API key: ${API_KEY ? 'loaded' : 'MISSING'}`);
});