/**
 * Excell AI - Backend Proxy Server
 * 
 * 🔐 Secure Google AI Studio API proxy
 * 🌐 Serves frontend + handles AI requests
 * 
 * Setup:
 * 1. npm install express dotenv cors helmet express-rate-limit
 * 2. Create .env with GEMINI_API_KEY
 * 3. Put frontend files in /public folder
 * 4. Run: node server.js
 * 5. Open: http://localhost:3001
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
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Validate API key
if (!API_KEY) {
  console.error('❌ CRITICAL: GEMINI_API_KEY not found in .env');
  console.error('   1. Create a .env file in project root');
  console.error('   2. Add: GEMINI_API_KEY=your_key_here');
  console.error('   3. Get key from: https://aistudio.google.com/app/apikey ');
  process.exit(1);
}

// ─────────────────────────────────────────────────────
// SECURITY & MIDDLEWARE
// ─────────────────────────────────────────────────────

// Helmet: Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      connectSrc: ["'self'", "https://generativelanguage.googleapis.com", "http://localhost:*"],
      imgSrc: ["'self'", "data:", "https:"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
}));

// CORS: Allow frontend to call backend
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:8000',
  'http://127.0.0.1:8000', 
  'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    console.warn(`⚠️ Blocked origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parser with size limit
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting: Prevent API abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === 'production' ? 30 : 200,
  message: { error: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

// ─────────────────────────────────────────────────────
// SERVE STATIC FILES (FRONTEND)
// ─────────────────────────────────────────────────────

// Serve files from /public folder
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: NODE_ENV === 'production' ? '1d' : '0',
  etag: true,
  lastModified: true,
}));

// Fallback: Serve index.html for SPA routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) {
      console.error('Error serving index.html:', err);
      res.status(500).send('Server error');
    }
  });
});

// ─────────────────────────────────────────────────────
// GOOGLE AI STUDIO API PROXY
// ─────────────────────────────────────────────────────

const AI_STUDIO_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const CONFIG = {
  DEVICES: ['light', 'fan', 'pump', 'heater', 'all'],
  ACTIONS: ['on', 'off', 'toggle'],
  SCENES: ['morning', 'night', 'work', 'relax'],
};

const SYSTEM_PROMPT = `You are Excell AI, a friendly smart home assistant.

AVAILABLE DEVICES: ${CONFIG.DEVICES.filter(d => d !== 'all').join(', ')} (plus "all" for all devices)
AVAILABLE ACTIONS: ${CONFIG.ACTIONS.join(', ')}
AVAILABLE SCENES: ${CONFIG.SCENES.join(', ')}

RULES:
1. Respond naturally and conversationally in the user's language
2. For device control, return ONLY this JSON format:
   {"action":{"type":"control_relay","params":{"device":"DEVICE_ID","action":"on|off|toggle"}}}
3. For scenes, return:
   {"action":{"type":"run_scene","params":{"scene":"SCENE_NAME"}}}
4. If request is unclear, ask ONE short clarifying question
5. Keep confirmations under 10 words: "✅ Light on"
6. If you can't help, respond politely with a helpful suggestion
7. Never make up device states - ask user or say you'll check

EXAMPLES:
User: "turn on the light"
→ {"action":{"type":"control_relay","params":{"device":"light","action":"on"}}}

User: "good morning"
→ {"action":{"type":"run_scene","params":{"scene":"morning"}}}

User: "is the fan running?"
→ {"response":"Let me check... The fan is currently off. Turn it on?"}

User: "make it cozy"
→ {"action":{"type":"run_scene","params":{"scene":"relax"}}}

User: "turn off everything"
→ {"action":{"type":"control_relay","params":{"device":"all","action":"off"}}}

IMPORTANT: Return valid JSON only. No markdown, no explanations outside JSON.`;

app.post('/api/chat', apiLimiter, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { message, history = [], devices = [], states = {} } = req.body;
    
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ 
        error: 'invalid_input',
        response: "I didn't catch that. Could you try again?"
      });
    }
    
    const trimmedMessage = message.trim();
    console.log(`🔍 [${new Date().toISOString()}] Request: "${trimmedMessage.substring(0, 100)}..."`);

    const contents = [
      { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
      ...history.slice(-10).map(h => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
      })),
      { 
        role: 'user', 
        parts: [{ 
          text: `Device states: ${JSON.stringify(states)}\n\nUser: ${trimmedMessage}` 
        }] 
      }
    ];

    const tools = [{
      functionDeclarations: [
        {
          name: 'control_relay',
          description: 'Control a smart home device (light, fan, pump, heater, or all)',
          parameters: {
            type: 'OBJECT',
            properties: {
              device: { 
                type: 'STRING', 
                enum: CONFIG.DEVICES, 
                description: 'Device ID to control' 
              },
              action: { 
                type: 'STRING', 
                enum: CONFIG.ACTIONS, 
                description: 'Action to perform' 
              }
            },
            required: ['device', 'action']
          }
        },
        {
          name: 'run_scene',
          description: 'Activate a predefined scene/mode',
          parameters: {
            type: 'OBJECT',
            properties: {
              scene: { 
                type: 'STRING', 
                enum: CONFIG.SCENES, 
                description: 'Scene name to activate' 
              }
            },
            required: ['scene']
          }
        }
      ]
    }];

    const aiResponse = await fetch(AI_STUDIO_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Excell-AI/1.0'
      },
      body: JSON.stringify({
        contents,
        tools,
        tool_config: {
          function_calling_config: {
            mode: 'AUTO',
          }
        },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 500,
          topP: 0.9,
          topK: 40,
          responseMimeType: 'text'
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
      
      if (aiResponse.status === 400) {
        return res.status(400).json({ 
          error: 'bad_request',
          response: "I'm having trouble understanding. Could you rephrase?"
        });
      }
      if (aiResponse.status === 429) {
        return res.status(429).json({ 
          error: 'rate_limited',
          response: "I'm a bit overwhelmed. Please wait a moment and try again."
        });
      }
      if (aiResponse.status === 401 || aiResponse.status === 403) {
        return res.status(500).json({ 
          error: 'auth_error',
          response: "I'm having connection issues. Please try again later."
        });
      }
      
      throw new Error(errorData.error?.message || `AI error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log(`✅ AI Response in ${latency}ms`);
    
    const candidate = aiData.candidates?.[0];
    if (!candidate?.content?.parts?.[0]) {
      console.warn('⚠️ Empty AI response');
      return res.json({ 
        response: "I'm thinking... Could you try that again?"
      });
    }

    const part = candidate.content.parts[0];
    let result = { response: '', action: null, metadata: { latency } };

    if (part.functionCall) {
      const { name, args } = part.functionCall;
      console.log(`🔧 Function call: ${name}`, args);
      
      if (name === 'control_relay' && args?.device && args?.action) {
        if (!CONFIG.DEVICES.includes(args.device) || !CONFIG.ACTIONS.includes(args.action)) {
          result.response = `I can't control "${args.device}". Available: ${CONFIG.DEVICES.filter(d=>d!=='all').join(', ')}.`;
        } else {
          result.action = { 
            type: 'control_relay', 
            params: { device: args.device, action: args.action } 
          };
          result.response = `✅ ${args.device === 'all' ? 'All devices' : args.device} → ${args.action}`;
        }
      } 
      else if (name === 'run_scene' && args?.scene) {
        if (!CONFIG.SCENES.includes(args.scene)) {
          result.response = `Available scenes: ${CONFIG.SCENES.join(', ')}.`;
        } else {
          result.action = { 
            type: 'run_scene', 
            params: { scene: args.scene } 
          };
          result.response = `🌟 Activating ${args.scene} scene`;
        }
      }
      else {
        result.response = "I'm not sure how to help with that. Try asking about lights, fans, or scenes!";
      }
    }
    else if (part.text) {
      const text = part.text.trim();
      
      if (text.startsWith('{') || text.startsWith('[')) {
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
      result.response = "I'm here to help! What would you like to control?";
    }

    console.log(`📤 Response: ${result.response?.substring(0, 100)}${result.response?.length > 100 ? '...' : ''}`);
    
    res.json(result);

  } catch (error) {
    const latency = Date.now() - startTime;
    console.error(`❌ Chat error after ${latency}ms:`, error.message);
    
    res.status(500).json({ 
      error: 'internal_error',
      response: "I'm having trouble connecting right now. Please check your internet and try again.",
      debug: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    model: MODEL
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    devices: CONFIG.DEVICES,
    actions: CONFIG.ACTIONS, 
    scenes: CONFIG.SCENES,
    version: '1.0.0'
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found', message: 'API endpoint not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err);
  
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'invalid_json', message: 'Invalid JSON in request' });
  }
  
  if (err.message?.includes('CORS')) {
    return res.status(403).json({ error: 'cors_error', message: 'Origin not allowed' });
  }
  
  res.status(500).json({ 
    error: 'server_error', 
    message: NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   ✅ Excell AI Server Running          ║
╠════════════════════════════════════════╣
║   🌐 Frontend: http://localhost:${PORT}          ║
║   🔗 API:      http://localhost:${PORT}/api/chat ║
║   🔍 Health:   http://localhost:${PORT}/api/health║
║   📁 Public:   ./public/              ║
║   🔑 Model:    ${MODEL}     ║
║   🌍 Env:      ${NODE_ENV}                    ║
╚════════════════════════════════════════╝
  `.trim());
  
  console.log(`🔓 Allowed origins: ${allowedOrigins.join(', ')}`);
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});
