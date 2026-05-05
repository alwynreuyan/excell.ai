require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// --- GROQ CONFIGURATION ---
const API_KEY = process.env.GROQ_API_KEY; 
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const MODEL = 'llama-3.1-8b-instant'; // Groq's updated fast model

if (!API_KEY) {
  console.error('❌ CRITICAL: GROQ_API_KEY not found in .env');
  process.exit(1);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      // Updated to allow Groq instead of Google
      connectSrc: ["'self'", "https://api.groq.com", "http://192.168.1.100", "http://*.local"],
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

    // --- NEW GROQ API CALL ---
    const groqBody = {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      response_format: { type: "json_object" }, // Guarantees pure JSON output
      temperature: 0.3,
      max_tokens: 512
    };

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}` 
      },
      body: JSON.stringify(groqBody),
      signal: AbortSignal.timeout(15000),
    });

    if (groqRes.status === 401 || groqRes.status === 403) {
      return res.status(401).json({ error: 'Invalid Groq API key or unauthorized.' });
    }

    if (!groqRes.ok) {
      const errData = await groqRes.json().catch(() => ({}));
      console.error('Groq error:', errData);

      if (groqRes.status === 429) {
        console.warn('Groq API rate limit reached. Asking user to wait.');
        return res.json({ 
          action: null, 
          response: "I'm receiving too many requests right now. Please wait about a minute and try again." 
        });
      }

      return res.status(502).json({ error: 'AI model error', details: errData });
    }

    const groqData = await groqRes.json();
    const rawText = groqData?.choices?.[0]?.message?.content || '';
    // -------------------------

    // Strip markdown fences just in case (though response_format makes this rare)
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
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
  console.log(`🤖 Model: ${MODEL} (Groq)`);
  console.log(`🔑 API key: ${API_KEY ? 'loaded' : 'MISSING'}`);
});