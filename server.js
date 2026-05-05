/**
 * Excell AI - Backend Proxy Server
 * 
 * 🔐 Secure Google AI Studio API proxy
 * 🌐 Serves frontend + handles AI requests
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ─────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.GEMINI_API_KEY;
// Hardcoded to ensure the correct free model is used
const MODEL = 'gemini-1.5-flash-latest'; 
const NODE_ENV = process.env.NODE_ENV || 'development';

// Validate API key
if (!API_KEY) {
  console.error('❌ CRITICAL: GEMINI_API_KEY not found in .env');
  process.exit(1);
}

// ─────────────────────────────────────────────────────
// SECURITY & MIDDLEWARE
// ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], 
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      connectSrc: [
        "'self'", 
        "https://generativelanguage.googleapis.com", 
        "http://localhost:*", 
        "http://127.0.0.1:*",
        "http://192.168.1.100"
      ],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrcAttr: ["'unsafe-inline'"], 
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
}));

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:8000', 'http://127.0.0.1:8000', 
  'http://localhost:5500', 'http://localhost:3000',
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === 'production' ? 30 : 200,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

// ─────────────────────────────────────────────────────
// SERVE STATIC FILES
// ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '1d' : '0',
  etag: true,
  lastModified: true,
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.status(500).send('Server error');
  });
});

// ─────────────────────────────────────────────────────
// GOOGLE AI STUDIO API PROXY
// ─────────────────────────────────────────────────────
// FIX: Removed the space after 'models/'
const AI_STUDIO_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const CONFIG = {
  DEVICES: ['light', 'fan', 'pump', 'heater', 'all'],
  ACTIONS: ['on', 'off', 'toggle'],
  SCENES: ['morning', 'night', 'work', 'relax'],  
};

const SYSTEM_PROMPT = `You are Excell AI, a friendly smart home assistant.
AVAILABLE DEVICES: ${CONFIG.DEVICES.filter(d => d !== 'all').join(', ')} (plus "all")
AVAILABLE ACTIONS: ${CONFIG.ACTIONS.join(', ')}
AVAILABLE SCENES: ${CONFIG.SCENES.join(', ')}
RULES:
1. Respond naturally.
2. For device control, return ONLY JSON: {"action":{"type":"control_relay","params":{"device":"DEVICE_ID","action":"on|off|toggle"}}}
3. For scenes: {"action":{"type":"run_scene","params":{"scene":"SCENE_NAME"}}}
4. Keep confirmations short.
5. Return valid JSON only. No markdown.`;

app.post('/api/chat', apiLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { message, history = [], devices = [], states = {} } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'invalid_input', response: "I didn't catch that." });
    }
    
    const trimmedMessage = message.trim();
    console.log(`🔍 [${new Date().toISOString()}] Request: "${trimmedMessage.substring(0, 50)}..."`);

    const contents = [
      { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
      ...history.slice(-10).map(h => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
      })),
      { 
        role: 'user', 
        parts: [{ text: `Device states: ${JSON.stringify(states)}\n\nUser: ${trimmedMessage}` }] 
      }
    ];

    const tools = [{
      functionDeclarations: [
        {
          name: 'control_relay',
          description: 'Control a smart home device',
          parameters: {
            type: 'OBJECT',
            properties: {
              device: { type: 'STRING', enum: CONFIG.DEVICES, description: 'Device ID' },
              action: { type: 'STRING', enum: CONFIG.ACTIONS, description: 'Action' }
            },
            required: ['device', 'action']
          }
        },
        {
          name: 'run_scene',
          description: 'Activate a scene',
          parameters: {
            type: 'OBJECT',
            properties: {
              scene: { type: 'STRING', enum: CONFIG.SCENES, description: 'Scene name' }
            },
            required: ['scene']
          }
        }
      ]
    }];

    const aiResponse = await fetch(AI_STUDIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        tools,
        tool_config: { function_calling_config: { mode: 'AUTO' } },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 500,
          topP: 0.9,
          topK: 40
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
        ]
      }),
      signal: AbortSignal.timeout(20000)
    });

    const latency = Date.now() - startTime;
    
    if (!aiResponse.ok) {
      const errorData = await aiResponse.json().catch(() => ({}));
      console.error(`❌ AI Studio API Error ${aiResponse.status}:`, errorData);
      
      if (aiResponse.status === 400) return res.status(400).json({ error: 'bad_request', response: "Invalid request." });
      if (aiResponse.status === 429) return res.status(429).json({ error: 'rate_limited', response: "Too many requests." });
      if (aiResponse.status === 401 || aiResponse.status === 403) return res.status(500).json({ error: 'auth_error', response: "API Key invalid." });
      
      throw new Error(errorData.error?.message || `AI error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log(`✅ AI Response in ${latency}ms`);
    
    const candidate = aiData.candidates?.[0];
    if (!candidate?.content?.parts?.[0]) {
      return res.json({ response: "Thinking..." });
    }

    const part = candidate.content.parts[0];
    let result = { response: '', action: null, metadata: { latency } };

    if (part.functionCall) {
      const { name, args } = part.functionCall;
      console.log(`🔧 Function call: ${name}`, args);
      
      if (name === 'control_relay' && args?.device && args?.action) {
        if (!CONFIG.DEVICES.includes(args.device) || !CONFIG.ACTIONS.includes(args.action)) {
          result.response = `Invalid device or action.`;
        } else {
          result.action = { type: 'control_relay', params: { device: args.device, action: args.action } };
          result.response = `✅ ${args.device} → ${args.action}`;
        }
      } 
      else if (name === 'run_scene' && args?.scene) {
        if (!CONFIG.SCENES.includes(args.scene)) {
          result.response = `Unknown scene.`;
        } else {
          result.action = { type: 'run_scene', params: { scene: args.scene } };
          result.response = `🌟 Activating ${args.scene}`;
        }
      }
      else {
        result.response = "Not sure how to help.";
      }
    }
    else if (part.text) {
      const text = part.text.trim();
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.action) result.action = parsed.action;
          if (parsed.response) result.response = parsed.response;
          if (!result.response && !result.action) result.response = text;
        } catch (e) {
          result.response = text;
        }
      } else {
        result.response = text;
      }
    }

    if (!result.response && !result.action) {
      result.response = "Ready to help.";
    }

    console.log(`📤 Response: ${result.response}`);
    res.json(result);

  } catch (error) {
    console.error(`❌ Chat error:`, error.message);
    res.status(500).json({ 
      error: 'internal_error',
      response: "Connection trouble. Check internet.",
      debug: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), model: MODEL });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   ✅ Excell AI Server Running          ║
╠════════════════════════════════════════╣
║   🌐 Frontend: http://localhost:${PORT}          ║
║   🔗 API:      http://localhost:${PORT}/api/chat ║
║   🔑 Model:    ${MODEL}     ║
╚════════════════════════════════════════╝
  `.trim());
});