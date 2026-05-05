/**
 * Excell AI - Client-Side JavaScript (FIXED)
 */

// ─────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────
const CONFIG = {
  API_PROXY: 'http://localhost:3001/api/chat', // Fixed: Full URL
  API_TIMEOUT: 20000,
  MAX_HISTORY: 10,
  RECONNECT_DELAY: 2000,
};

// ─────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────
const ESP32_PINS = [2,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33,34,35];
const EMOJI_OPTIONS = ['💡','🌀','💧','🔥','🔌','📺','🎵','❄️','🌡️','🔒','🚿','🍳','💨','🌿','🖥️','📡','🔆','🔋','⚡','🎛️'];

const DEFAULT_RELAYS = [
  {id:'light', icon:'💡',name:'Light', desc:'Main lighting', pin:2, type:'normal',initState:'off'},
  {id:'fan', icon:'🌀',name:'Fan', desc:'Ceiling fan', pin:4, type:'normal',initState:'off'},
  {id:'pump', icon:'💧',name:'Pump', desc:'Water pump', pin:5, type:'normal',initState:'off'},
  {id:'heater',icon:'🔥',name:'Heater',desc:'Space heater', pin:12, type:'normal',initState:'off'},
];

let relays = JSON.parse(localStorage.getItem('vr_relays') || 'null') || DEFAULT_RELAYS.map(r=>({...r}));
let states = {};
let settings = JSON.parse(localStorage.getItem('vr_settings') || 'null') || {
  theme:'cyber',tts:true,ttsRate:1.0,ttsPitch:1.0,ttsVoiceName:'',
  autoConnect:true,continuousVoice:false,wakeWord:'hey excell',wakeEnabled:false,
};
relays.forEach(r => states[r.id] = r.initState === 'on');

// Voice & AI State
let recognition = null, wakeRecognition = null, listening = false, wakeListening = false;
let wakeTimeout = null, ttsVoice = null, modalMode = 'add', editingRelayId = null;
let selectedPin = null, selectedEmoji = '💡', micPermission = 'unknown';
let conversationHistory = [], isProcessing = false, retryCount = 0;
const MAX_RETRIES = 3;

// ─────────────────────────────────────────────────────
// AUDIO VISUALIZER
// ─────────────────────────────────────────────────────
const canvas = document.getElementById('spectrum-canvas');
const ctx = canvas.getContext('2d');
let audioCtx, analyser, micStream, micSource, ttsAnalyser, ttsAudioCtx;
let spectrumMode = 'idle', animFrame, idlePhase = 0;

function resizeCanvas() {
  if(!canvas) return;
  const wrap = canvas.parentElement;
  canvas.width = wrap.offsetWidth;
  canvas.height = wrap.offsetHeight;
}
window.addEventListener('resize', resizeCanvas);

function getAccentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00d4ff';
}
function getRedColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || '#ff3b5c';
}

function drawSpectrum() {
  animFrame = requestAnimationFrame(drawSpectrum);
  if(!canvas) return;
  resizeCanvas();
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (spectrumMode === 'mic' && analyser) drawBars(analyser, getRedColor(), W, H);
  else if (spectrumMode === 'tts' && ttsAnalyser) drawBars(ttsAnalyser, getAccentColor(), W, H);
  else drawIdle(W, H);
}

function drawBars(anal, color, W, H) {
  const data = new Uint8Array(anal.frequencyBinCount);
  anal.getByteFrequencyData(data);
  const barCount = Math.min(80, data.length);
  const barW = W / barCount;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color);
  grad.addColorStop(0.6, color + '99');
  grad.addColorStop(1, color + '22');
  ctx.fillStyle = grad;
  for (let i = 0; i < barCount; i++) {
    const v = data[Math.floor(i * data.length / barCount)] / 255;
    const bH = Math.max(2, v * H * 0.95);
    ctx.fillRect(i * barW + 1, H - bH, barW - 2, bH);
    ctx.globalAlpha = 0.15;
    ctx.fillRect(i * barW + 1, H, barW - 2, bH * 0.3);
    ctx.globalAlpha = 1;
  }
}

function drawIdle(W, H) {
  idlePhase += 0.04;
  const accent = getAccentColor();
  for (let i = 0; i < 60; i++) {
    const wave = Math.sin(idlePhase + i * 0.3) * 0.4 + 0.5;
    const bH = Math.max(2, wave * H * 0.15);
    ctx.fillStyle = accent + Math.floor((0.2 + wave * 0.3) * 255).toString(16).padStart(2,'0');
    ctx.fillRect(i * (W/60) + 1, H - bH, (W/60) - 2, bH);
  }
}

async function startMicSpectrum() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({audio:true});
  if (micSource) micSource.disconnect();
  micSource = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  micSource.connect(analyser);
  spectrumMode = 'mic';
  updateSpectrumBadge();
}

function stopMicSpectrum() { if (spectrumMode === 'mic') { spectrumMode = 'idle'; updateSpectrumBadge(); } }

function startTTSSpectrum() {
  spectrumMode = 'tts';
  updateSpectrumBadge();
  if (!ttsAudioCtx) ttsAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  ttsAnalyser = ttsAudioCtx.createAnalyser();
  ttsAnalyser.fftSize = 256;
  const osc = ttsAudioCtx.createOscillator();
  const gain = ttsAudioCtx.createGain();
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(ttsAnalyser);
  osc.start();
  const sp = ttsAudioCtx.createScriptProcessor(256, 0, 1);
  let phase = 0;
  sp.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    phase += 0.1;
    for (let i = 0; i < out.length; i++) {
      out[i] = (Math.sin(phase + i*0.3) * 0.5 + (Math.random() - 0.5) * 0.3) * 0.6;
    }
  };
  sp.connect(ttsAnalyser);
  window._ttsProc = sp;
  window._ttsOsc = osc;
}

function stopTTSSpectrum() {
  try { window._ttsProc?.disconnect(); window._ttsOsc?.stop(); } catch {}
  spectrumMode = 'idle';
  updateSpectrumBadge();
}

function updateSpectrumBadge() {
  const badge = document.getElementById('spectrum-badge');
  if(!badge) return;
  badge.className = 'spectrum-mode-badge';
  if (spectrumMode === 'mic') { badge.textContent = '🔴 MIC'; badge.classList.add('mic-active'); }
  else if (spectrumMode === 'tts') { badge.textContent = '🔵 AI'; badge.classList.add('tts-active'); }
  else badge.textContent = 'IDLE';
}

// ─────────────────────────────────────────────────────
// MIC PERMISSION
// ─────────────────────────────────────────────────────
async function checkMicPermission() {
  if (navigator.permissions) {
    try {
      const perm = await navigator.permissions.query({name:'microphone'});
      micPermission = perm.state;
      perm.onchange = () => { micPermission = perm.state; updatePermBanner(); if(perm.state==='granted') initMic(); };
    } catch { micPermission = 'unknown'; }
  }
  updatePermBanner();
  if (micPermission === 'granted') initMic();
}

async function requestMicPermission() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio:true});
    micPermission = 'granted';
    updatePermBanner();
    initMic();
    log('ok','Mic granted');
  } catch(e) {
    micPermission = 'denied';
    updatePermBanner();
    log('err','Mic denied: '+e.message);
  }
}

async function initMic() {
  if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({audio:true});
  const btn = document.getElementById('mic-btn');
  if(btn) btn.classList.remove('disabled-btn');
  log('info','Mic ready');
}

function updatePermBanner() {
  const banner = document.getElementById('perm-banner');
  const ok = document.getElementById('perm-ok-banner');
  if(!banner || !ok) return;
  if (micPermission === 'granted') {
    banner.classList.remove('visible');
    ok.classList.add('visible');
    setTimeout(()=>ok.classList.remove('visible'),4000);
  } else if (micPermission === 'denied') {
    banner.querySelector('.perm-banner-text').textContent = '🚫 Mic denied. Check Chrome Settings → Site Settings.';
    banner.classList.add('visible');
  } else banner.classList.add('visible');
}

// ─────────────────────────────────────────────────────
// INIT & CORE FUNCTIONS
// ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(settings.theme);
  syncSettingsUI();
  populateVoices();
  if(window.speechSynthesis) window.speechSynthesis.addEventListener('voiceschanged', populateVoices);
  checkMicPermission();
  
  // Build UI
  buildRelayCards(); 
  buildQuickChips();
  updateStatsRow();
  
  startClock();
  resizeCanvas();
  drawSpectrum();
  
  if (settings.autoConnect) checkConnection();
  if (settings.wakeEnabled) startWakeWordListening();
  
  const textInput = document.getElementById('text-cmd-input');
  if(textInput) textInput.addEventListener('keydown', e => { if(e.key==='Enter') sendTextCommand(); });
  
  const wakeInput = document.getElementById('wake-word-input');
  if(wakeInput) wakeInput.addEventListener('keydown', e => { if(e.key==='Enter') saveWakeWord(); });
});

function startClock() {
  const el = document.getElementById('topbar-time');
  if(!el) return;
  const tick = () => el.textContent = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  tick(); setInterval(tick,1000);
}

function updateStatsRow() {
  const activeEl = document.getElementById('stat-active');
  const totalEl = document.getElementById('stat-total');
  const connEl = document.getElementById('stat-conn');
  const connSubEl = document.getElementById('stat-conn-sub');
  const wakeEl = document.getElementById('stat-wake');
  
  if(activeEl) activeEl.textContent = Object.values(states).filter(Boolean).length;
  if(totalEl) totalEl.textContent = relays.length;
  
  const connDot = document.getElementById('conn-dot');
  const ok = connDot ? connDot.classList.contains('ok') : false;
  
  if(connEl) connEl.textContent = ok ? '✓' : '—';
  if(connSubEl) connSubEl.textContent = ok ? 'connected' : 'offline';
  
  if(wakeEl) {
    if (settings.wakeEnabled) { wakeEl.textContent='ON'; wakeEl.className='stat-value green'; }
    else { wakeEl.textContent='OFF'; wakeEl.className='stat-value warn'; }
  }
}

function applyTheme(name) {
  settings.theme = name;
  document.documentElement.dataset.theme = name==='cyber'?'':name;
  document.querySelectorAll('.theme-swatch').forEach(s=>s.classList.toggle('active',s.dataset.theme===name));
  saveSettings();
}

function getIP() { 
  const el = document.getElementById('ip-input');
  return el ? el.value.trim() : '192.168.1.100'; 
}

async function checkConnection() {
  const dot = document.getElementById('conn-dot'); 
  const label = document.getElementById('conn-label');
  if(!dot || !label) return;
  
  dot.className='conn-dot'; 
  label.textContent='Connecting…';
  
  try {
    const r = await fetch(`http://${getIP()}/status`, {signal:AbortSignal.timeout(3000)});
    if(r.ok) {
      const data = await r.json();
      relays.forEach(rel=>{if(data[rel.id]!==undefined) states[rel.id]=data[rel.id];});
      updateUI(); 
      dot.className='conn-dot ok'; 
      label.textContent='Connected';
      log('info',`Connected → ${getIP()}`);
    } else throw new Error('Bad response');
  } catch { 
    dot.className='conn-dot err'; 
    label.textContent='Offline'; 
    // Only log if it's not a CSP error (which we fixed in server)
    console.log(`Cannot reach ${getIP()} (This is normal if ESP32 is off)`); 
  }
  updateStatsRow();
}

async function sendCmd(device, action) {
  const url = `http://${getIP()}/cmd?device=${device}&action=${action}`;
  setStatus(`Sending → ${device} ${action}…`, 'info');
  try {
    const r = await fetch(url, {signal:AbortSignal.timeout(4000)});
    const data = await r.json();
    if(data.ok) {
      if(device==='all') {
        const on = action==='on'?true:action==='off'?false:null;
        relays.forEach(rel=>{states[rel.id]=on!==null?on:!states[rel.id];});
      } else states[device] = data.state??(action==='on');
      updateUI();
      const msg = `${device.toUpperCase()} turned ${action.toUpperCase()}`;
      setStatus(`✓ ${msg}`,'ok'); 
      log('ok',`${device} → ${action}`);
      speakResponse(msg); 
      showAIResponse(msg);
    } else { 
      setStatus(data.error||'Failed','err'); 
      log('err',data.error||'Command failed'); 
    }
  } catch(e) {
    setStatus('ESP32 unreachable','err'); 
    log('err',`Fetch failed: ${e.message}`);
    // Don't speak error for every click, just log it
  }
}

function updateUI() {
  relays.forEach(r => {
    const on = states[r.id];
    const card = document.getElementById('card-'+r.id);
    if(!card) return;
    
    card.classList.toggle('on', on);
    
    const lbl = document.getElementById('state-label-'+r.id);
    if(lbl) lbl.textContent = on?'ACTIVE':'STANDBY';
    
    const tlbl = document.getElementById('toggle-lbl-'+r.id);
    if(tlbl) tlbl.textContent = on?'ON':'OFF';
    
    const chk = document.getElementById('toggle-'+r.id);
    if(chk) chk.checked = on;
  });
  updateStatsRow();
}

function runScene(name) {
  const scenes = {morning:{light:true,fan:true}, night:{light:false,fan:false}, work:{light:true,fan:true}, relax:{light:true,heater:true}};
  const s = scenes[name]; 
  if(!s) return;
  
  relays.forEach(r=>{if(s[r.id]!==undefined) states[r.id]=s[r.id];});
  updateUI(); 
  log('info',`Scene: ${name}`); 
  setStatus(`Scene → ${name}`,'ok');
  speakResponse(`${name} scene activated.`); 
  showAIResponse(`🌟 Scene "${name}" activated.`);
}

// ─────────────────────────────────────────────────────
// 🧠 AI PROCESSING
// ─────────────────────────────────────────────────────
async function processWithAI(userInput) {
  if (isProcessing) { setStatus("Processing...", "info"); return; }
  isProcessing = true;
  setStatus("Excell is thinking...", "info");
  
  addToHistory('user', userInput);
  
  try {
    const response = await fetch(CONFIG.API_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userInput,
        history: conversationHistory.slice(-CONFIG.MAX_HISTORY * 2),
        devices: relays.map(r => ({ id: r.id, name: r.name })),
        states: states
      }),
      signal: AbortSignal.timeout(CONFIG.API_TIMEOUT)
    });

    if (!response.ok) {
      const err = await response.json().catch(()=>({}));
      throw new Error(err.error || `Server error: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.action) {
      if (data.action.type === 'control_relay') {
        await sendCmd(data.action.params.device, data.action.params.action);
        const msg = `✅ ${data.action.params.device} turned ${data.action.params.action}`;
        showAIResponse(msg); 
        speakResponse(msg); 
        addToHistory('model', msg);
      } else if (data.action.type === 'run_scene') {
        runScene(data.action.params.scene);
        addToHistory('model', `Activated ${data.action.params.scene}`);
      }
    }
    
    if (data.response) {
      showAIResponse(data.response);
      speakResponse(data.response);
      addToHistory('model', data.response);
    }
    
    retryCount = 0;
    setStatus("Ready", "");
    
  } catch (error) {
    console.error("AI Error:", error);
    if (retryCount < MAX_RETRIES && (error.message.includes('network')||error.message.includes('timeout'))) {
      retryCount++;
      setStatus(`Retrying... (${retryCount}/${MAX_RETRIES})`, "warn");
      setTimeout(() => processWithAI(userInput), CONFIG.RECONNECT_DELAY * retryCount);
      return;
    }
    const fallback = "I'm having connection issues. Please try again.";
    setStatus("Connection issue", "err");
    showAIResponse(fallback); 
    speakResponse(fallback);
    log('err', `AI Error: ${error.message}`);
    retryCount = 0;
  } finally {
    isProcessing = false;
  }
}

function addToHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > CONFIG.MAX_HISTORY * 2) {
    conversationHistory = conversationHistory.slice(-CONFIG.MAX_HISTORY * 2);
  }
}

// ─────────────────────────────────────────────────────
// TEXT/VOICE COMMANDS
// ─────────────────────────────────────────────────────
function sendTextCommand() {
  const input = document.getElementById('text-cmd-input');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  
  const tBox = document.getElementById('transcript-display-text');
  if(tBox) tBox.textContent = text;
  
  log('text-cmd', `Text: "${text}"`);
  setStatus(`Command: "${text}"`, 'info');
  processWithAI(text);
  
  if(input) input.value = '';
}

function toggleListening() {
  if (micPermission === 'denied') {
    alert('Mic access denied. Check Chrome Settings → Site Settings → Microphone.');
    return;
  }
  if (listening) stopListening(); else startListening();
}

function startListening() {
  if (wakeListening) { try{wakeRecognition.stop();}catch{} }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus('Speech API not supported — use Chrome','err'); return; }
  
  recognition = new SR();
  recognition.continuous = settings.continuousVoice;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  
  recognition.onstart = () => {
    listening = true;
    const btn = document.getElementById('mic-btn');
    const lbl = document.getElementById('mic-label');
    const dot = document.getElementById('mic-live-dot');
    
    if(btn) btn.classList.add('listening');
    if(lbl) lbl.textContent = 'LISTENING…';
    if(dot) dot.classList.add('active');
    
    setStatus('Listening…', 'info');
    startMicSpectrum();
  };
  
  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r=>r[0].transcript).join(' ').toLowerCase().trim();
    const tBox = document.getElementById('transcript-display-text');
    const isFinal = e.results[e.results.length-1].isFinal;
    
    if(tBox) {
      tBox.textContent = `"${transcript}"`;
      tBox.classList.toggle('interim', !isFinal);
    }
    
    if (isFinal) { 
      log('voice', `Heard: "${transcript}"`); 
      processWithAI(transcript); 
    }
  };
  
  recognition.onerror = (e) => { 
    setStatus(`Voice error: ${e.error}`,'err'); 
    log('err', e.error); 
    stopListening(); 
  };
  
  recognition.onend = () => { 
    if(settings.continuousVoice && listening) recognition.start(); 
    else stopListening(); 
  };
  
  try { recognition.start(); } catch(e) { listening=false; stopMicSpectrum(); }
}

function stopListening() {
  listening = false;
  const btn = document.getElementById('mic-btn');
  const dot = document.getElementById('mic-live-dot');
  const lbl = document.getElementById('mic-label');
  
  if(btn) btn.classList.remove('listening');
  if(dot) dot.classList.remove('active');
  
  stopMicSpectrum();
  
  if (recognition) { try{recognition.stop();}catch{} recognition=null; }
  
  const statusEl = document.getElementById('status-text');
  if (statusEl && statusEl.textContent.startsWith('Listening')) setStatus('Ready','');
  
  const tBox = document.getElementById('transcript-display-text');
  if(tBox) tBox.classList.remove('interim');
  
  if (settings.wakeEnabled && !wakeListening) {
    setTimeout(startWakeWordListening, 400);
    if(lbl) lbl.textContent = 'WAKE WORD ACTIVE';
  } else if (!settings.wakeEnabled) {
    if(lbl) lbl.textContent = 'TAP TO SPEAK';
  }
}

// ─────────────────────────────────────────────────────
// WAKE WORD
// ─────────────────────────────────────────────────────
function startWakeWordListening() {
  if (wakeListening) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  
  wakeRecognition = new SR();
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = true;
  wakeRecognition.lang = 'en-US';
  
  wakeRecognition.onstart = () => {
    wakeListening = true;
    const banner = document.getElementById('wake-banner');
    const btn = document.getElementById('mic-btn');
    const lbl = document.getElementById('mic-label');
    
    if(banner) banner.classList.add('visible');
    if(btn) btn.classList.add('wake-standby');
    if(lbl) lbl.textContent = 'WAKE WORD ACTIVE';
    
    log('wake', `Listening for: "${settings.wakeWord}"`);
  };
  
  wakeRecognition.onresult = (e) => {
    if (listening) return;
    const transcript = Array.from(e.results).map(r=>r[0].transcript).join(' ').toLowerCase().trim();
    if (transcript.includes(settings.wakeWord.toLowerCase())) onWakeDetected();
  };
  
  wakeRecognition.onerror = (e) => {
    if (e.error!=='no-speech' && e.error!=='aborted') {
      log('err', `Wake error: ${e.error}`);
      wakeListening = false;
      if (settings.wakeEnabled) setTimeout(startWakeWordListening, 1500);
    }
  };
  
  wakeRecognition.onend = () => {
    wakeListening = false;
    if (settings.wakeEnabled && !listening) setTimeout(startWakeWordListening, 300);
  };
  
  try { wakeRecognition.start(); } catch { wakeListening = false; }
}

function stopWakeWordListening() {
  wakeListening = false;
  if (wakeRecognition) { try{wakeRecognition.stop();}catch{} wakeRecognition=null; }
  const banner = document.getElementById('wake-banner');
  const btn = document.getElementById('mic-btn');
  const lbl = document.getElementById('mic-label');
  
  if(banner) banner.classList.remove('visible');
  if(btn) btn.classList.remove('wake-standby');
  if (!listening && lbl) lbl.textContent = 'TAP TO SPEAK';
}

function onWakeDetected() {
  if (wakeRecognition) { try{wakeRecognition.stop();}catch{} }
  wakeListening = false;
  log('wake', 'Wake word detected!');
  setStatus('🎙 Speak your command…', 'ok');
  showAIResponse('Listening…');
  speakResponse('Yes?');
  startCommandMode();
}

function startCommandMode() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  listening = true;
  
  const btn = document.getElementById('mic-btn');
  const lbl = document.getElementById('mic-label');
  const dot = document.getElementById('mic-live-dot');
  
  if(btn) btn.classList.add('listening');
  if(lbl) lbl.textContent = 'LISTENING…';
  if(dot) dot.classList.add('active');
  
  startMicSpectrum();
  
  const timeout = setTimeout(() => {
    if (listening) { try{recognition.stop();}catch{} resetToWake(); }
  }, 5000);
  
  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r=>r[0].transcript).join(' ').toLowerCase().trim();
    const tBox = document.getElementById('transcript-display-text');
    const isFinal = e.results[e.results.length-1].isFinal;
    
    if(tBox) {
      tBox.textContent = `"${transcript}"`;
      tBox.classList.toggle('interim', !isFinal);
    }
    
    if (isFinal) { 
      clearTimeout(timeout); 
      log('voice', `Command: "${transcript}"`); 
      processWithAI(transcript); 
    }
  };
  
  recognition.onerror = (e) => { 
    clearTimeout(timeout); 
    setStatus(`Error: ${e.error}`,'err'); 
    resetToWake(); 
  };
  
  recognition.onend = () => { 
    clearTimeout(timeout); 
    listening=false; 
    stopMicSpectrum(); 
    resetToWake(); 
  };
  
  try { recognition.start(); } catch { listening=false; stopMicSpectrum(); resetToWake(); }
}

function resetToWake() {
  listening = false;
  const btn = document.getElementById('mic-btn');
  const dot = document.getElementById('mic-live-dot');
  const lbl = document.getElementById('mic-label');
  const tBox = document.getElementById('transcript-display-text');
  
  if(btn) btn.classList.remove('listening');
  if(dot) dot.classList.remove('active');
  stopMicSpectrum();
  
  if (settings.wakeEnabled) {
    setTimeout(startWakeWordListening, 400);
    if(lbl) lbl.textContent = 'WAKE WORD ACTIVE';
  } else {
    if(lbl) lbl.textContent = 'TAP TO SPEAK';
  }
  if(tBox) tBox.classList.remove('interim');
}

// ─────────────────────────────────────────────────────
// TTS & UTILITIES
// ─────────────────────────────────────────────────────
function populateVoices() {
  const voices = window.speechSynthesis?.getVoices() || [];
  const select = document.getElementById('voice-select-list');
  if (!select) return;
  
  select.innerHTML = '';
  voices.filter(v=>v.lang.startsWith('en')).forEach(v => {
    const chip = document.createElement('span');
    chip.className = 'voice-chip' + (settings.ttsVoiceName===v.name?' active':'');
    chip.textContent = v.name.replace('Google ','').replace('Microsoft ','').split(' ')[0];
    chip.onclick = () => {
      ttsVoice = v; settings.ttsVoiceName = v.name; saveSettings();
      document.querySelectorAll('.voice-chip').forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      speakResponse(`Voice: ${v.name.split(' ')[0]}`);
    };
    select.appendChild(chip);
    if (v.name === settings.ttsVoiceName) ttsVoice = v;
  });
}

function speakResponse(text) {
  if (!settings.tts || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  if (ttsVoice) utt.voice = ttsVoice;
  utt.rate = parseFloat(settings.ttsRate) || 1.0;
  utt.pitch = parseFloat(settings.ttsPitch) || 1.0;
  
  const respEl = document.getElementById('ai-response-text');
  
  utt.onstart = () => { 
    if(respEl) respEl.classList.add('speaking'); 
    startTTSSpectrum(); 
  };
  utt.onend = () => { 
    if(respEl) respEl.classList.remove('speaking'); 
    stopTTSSpectrum(); 
  };
  utt.onerror = () => { 
    if(respEl) respEl.classList.remove('speaking'); 
    stopTTSSpectrum(); 
  };
  
  window.speechSynthesis.speak(utt);
}

function stopSpeaking() {
  window.speechSynthesis?.cancel();
  const respEl = document.getElementById('ai-response-text');
  if(respEl) respEl.classList.remove('speaking');
  stopTTSSpectrum();
}

function testSpeech() { speakResponse('Excell AI is ready.'); }

// ─────────────────────────────────────────────────────
// SETTINGS & HELPERS
// ─────────────────────────────────────────────────────
function openSettings() { 
  const overlay = document.getElementById('settings-overlay');
  const drawer = document.getElementById('settings-drawer');
  if(overlay) overlay.classList.add('open');
  if(drawer) drawer.classList.add('open'); 
}

function closeSettings() { 
  const overlay = document.getElementById('settings-overlay');
  const drawer = document.getElementById('settings-drawer');
  if(overlay) overlay.classList.remove('open');
  if(drawer) drawer.classList.remove('open'); 
}

function syncSettingsUI() {
  const ttsToggle = document.getElementById('tts-toggle-setting');
  const ttsRate = document.getElementById('tts-rate');
  const ttsPitch = document.getElementById('tts-pitch');
  const autoConn = document.getElementById('auto-connect');
  const wakeToggle = document.getElementById('wake-toggle-setting');
  const wakeInput = document.getElementById('wake-word-input');
  const wakeDisplay = document.getElementById('wake-word-display');
  const wakeChip = document.getElementById('wake-status-chip');
  
  if(ttsToggle) ttsToggle.checked = settings.tts;
  if(ttsRate) ttsRate.value = settings.ttsRate;
  if(ttsPitch) ttsPitch.value = settings.ttsPitch;
  if(autoConn) autoConn.checked = settings.autoConnect;
  if(wakeToggle) wakeToggle.checked = settings.wakeEnabled;
  if(wakeInput) wakeInput.value = settings.wakeWord || 'hey excell';
  if(wakeDisplay) wakeDisplay.textContent = settings.wakeWord || 'hey excell';
  
  if(wakeChip) {
    wakeChip.textContent = settings.wakeEnabled ? 'ACTIVE' : 'OFF';
    wakeChip.classList.toggle('active', settings.wakeEnabled);
  }
}

function onTTSToggle(v) { settings.tts = v; if(!v) stopSpeaking(); saveSettings(); }
function onRateChange(v) { settings.ttsRate = parseFloat(v); saveSettings(); }
function onPitchChange(v) { settings.ttsPitch = parseFloat(v); saveSettings(); }
function onAutoConnectToggle(v) { settings.autoConnect = v; saveSettings(); }
function onContinuousToggle(v) { settings.continuousVoice = v; if(!v && listening) stopListening(); saveSettings(); }

function onWakeToggle(v) { 
  settings.wakeEnabled = v; 
  saveSettings(); 
  if(v) startWakeWordListening(); 
  else stopWakeWordListening(); 
  updateStatsRow(); 
}

function saveWakeWord() {
  const input = document.getElementById('wake-word-input');
  const val = input ? input.value.trim().toLowerCase() : '';
  if (!val) return;
  
  settings.wakeWord = val; 
  saveSettings();
  
  const display = document.getElementById('wake-word-display');
  if(display) display.textContent = val;
  
  updateStatsRow(); 
  log('info', `Wake word: "${val}"`);
  showAIResponse(`Wake word: "${val}"`);
  
  if (settings.wakeEnabled) { 
    stopWakeWordListening(); 
    setTimeout(startWakeWordListening, 400); 
  }
}

function saveRelays() { localStorage.setItem('vr_relays', JSON.stringify(relays)); }
function saveSettings() { localStorage.setItem('vr_settings', JSON.stringify(settings)); }

function setStatus(msg, cls) { 
  const el = document.getElementById('status-text'); 
  if(el) { el.textContent = msg; el.className = cls||''; }
}

function showAIResponse(msg) { 
  const el = document.getElementById('ai-response-text'); 
  if(!el) return; 
  el.textContent = msg; 
  log('ai', msg.substring(0,80)+(msg.length>80?'…':'')); 
}

function log(type, msg) {
  const box = document.getElementById('log-box');
  if(!box) return;
  const ts = new Date().toTimeString().slice(0,8);
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="ts">[${ts}]</span><span class="msg">${escHtml(msg)}</span>`;
  box.appendChild(entry); 
  box.scrollTop = box.scrollHeight;
}

function clearLog() { 
  const box = document.getElementById('log-box');
  if(box) box.innerHTML = ''; 
}

function escHtml(s) { 
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); 
}

// ─────────────────────────────────────────────────────
// MODAL & RELAY FUNCTIONS (FIXED)
// ─────────────────────────────────────────────────────
function openAddModal() { 
  modalMode='add'; 
  editingRelayId=null; 
  selectedPin=null; 
  selectedEmoji='💡'; 
  prepModal('➕ ADD RELAY','SAVE RELAY'); 
}

function openEditModal(id) { 
  const r=relays.find(x=>x.id===id); 
  if(!r)return; 
  modalMode='edit'; 
  editingRelayId=id; 
  selectedPin=r.pin; 
  selectedEmoji=r.icon; 
  prepModal('✏ EDIT','UPDATE',r); 
}

function prepModal(title,btnText,r=null) {
  const titleEl = document.getElementById('modal-title');
  const saveBtn = document.getElementById('modal-save-btn');
  const nameEl = document.getElementById('modal-name');
  const descEl = document.getElementById('modal-desc');
  const typeEl = document.getElementById('modal-type');
  const initEl = document.getElementById('modal-init');
  const errEl = document.getElementById('modal-error');
  const pinErr = document.getElementById('pin-error');
  const modal = document.getElementById('relay-modal');
  
  if(titleEl) titleEl.textContent=title;
  if(saveBtn) saveBtn.textContent=btnText;
  if(nameEl) nameEl.value=r?.name||'';
  if(descEl) descEl.value=r?.desc||'';
  if(typeEl) typeEl.value=r?.type||'normal';
  if(initEl) initEl.value=r?.initState||'off';
  if(errEl) errEl.classList.remove('visible');
  if(pinErr) pinErr.classList.remove('visible');
  
  buildPinGrid(r?.pin); 
  buildEmojiPicker(r?.icon||'💡');
  if(modal) modal.classList.add('open');
}

function closeRelayModal() { 
  const modal = document.getElementById('relay-modal');
  if(modal) modal.classList.remove('open'); 
}

function buildPinGrid(cur) {
  const grid = document.getElementById('pin-grid');
  if(!grid) return;
  const used=relays.map(r=>r.pin).filter(p=>p!==undefined);
  grid.innerHTML=ESP32_PINS.map(p=>{
    const usedPin=used.includes(p)&&p!==cur, sel=p===cur;
    return `<div class="pin-opt ${usedPin?'used':''} ${sel?'selected':''}" onclick="${usedPin?'':'selectPin('+p+')'}">GPIO<br>${p}</div>`;
  }).join('');
}

function selectPin(p) { 
  selectedPin=p; 
  buildPinGrid(p); 
  const pinErr = document.getElementById('pin-error');
  if(pinErr) pinErr.classList.remove('visible'); 
}

function buildEmojiPicker(cur) {
  const picker = document.getElementById('modal-emoji-picker');
  if(!picker) return;
  selectedEmoji=cur||'💡';
  picker.innerHTML=EMOJI_OPTIONS.map(e=>
    `<span class="emoji-opt ${e===selectedEmoji?'selected':''}" onclick="selectEmoji('${e}')">${e}</span>`
  ).join('');
}

function selectEmoji(e) { 
  selectedEmoji=e; 
  document.querySelectorAll('#modal-emoji-picker .emoji-opt').forEach(el=>el.classList.toggle('selected',el.textContent===e)); 
}

function saveRelay() {
  const nameEl=document.getElementById('modal-name');
  const name=nameEl ? nameEl.value.trim() : '';
  const descEl=document.getElementById('modal-desc');
  const desc=descEl ? descEl.value.trim() : '';
  const typeEl=document.getElementById('modal-type');
  const type=typeEl ? typeEl.value : 'normal';
  const initEl=document.getElementById('modal-init');
  const init=initEl ? initEl.value : 'off';
  
  const errEl=document.getElementById('modal-error'); 
  const pinErr=document.getElementById('pin-error');
  
  if(errEl) errEl.classList.remove('visible'); 
  if(pinErr) pinErr.classList.remove('visible'); 
  if(nameEl) nameEl.classList.remove('error');
  
  if(!name){
    if(nameEl) nameEl.classList.add('error');
    if(errEl){errEl.textContent='Name required.';errEl.classList.add('visible');}
    return;
  }
  if(selectedPin===null){
    if(pinErr) pinErr.classList.add('visible');
    return;
  }
  
  const id=name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
  
  if(modalMode==='add') {
    if(relays.some(r=>r.id===id)){
      if(errEl){errEl.textContent='Already exists.';errEl.classList.add('visible');}
      return;
    }
    relays.push({id,icon:selectedEmoji,name,desc,pin:selectedPin,type,initState:init});
    states[id]=init==='on'; 
    log('info',`Added: ${name}`); 
    showAIResponse(`Added ${name}`); 
    speakResponse(`Created ${name}`);
  } else {
    const idx=relays.findIndex(r=>r.id===editingRelayId); 
    if(idx===-1)return;
    const newId=name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
    const prev=states[editingRelayId];
    if(newId!==editingRelayId) {
      if(relays.some((r,i)=>r.id===newId&&i!==idx)){
        if(errEl){errEl.textContent='Already exists.';errEl.classList.add('visible');}
        return;
      }
      delete states[editingRelayId]; 
      states[newId]=prev;
    }
    relays[idx]={id:newId,icon:selectedEmoji,name,desc,pin:selectedPin,type,initState:init};
    log('info',`Updated: ${name}`); 
    showAIResponse(`Updated ${name}`);
  }
  saveRelays(); 
  buildRelayCards(); 
  closeRelayModal();
}

function confirmDeleteRelay(id) {
  const r=relays.find(x=>x.id===id); 
  if(!r)return;
  if(!confirm(`Delete "${r.name}"?`))return;
  relays=relays.filter(x=>x.id!==id); 
  delete states[id];
  saveRelays(); 
  buildRelayCards(); 
  log('info',`Deleted: ${r.name}`); 
  showAIResponse(`Deleted ${r.name}`);
}

// ✅ CRITICAL: This function was missing or broken
function buildRelayCards() {
  const grid = document.getElementById('relays-grid');
  const chipsContainer = document.getElementById('quick-chips');
  if(!grid) return;
  
  grid.innerHTML = relays.map(r => {
    const isOn = states[r.id];
    return `
    <div class="relay-card ${isOn?'on':''}" id="card-${r.id}">
      <div class="relay-header">
        <div class="relay-icon">${r.icon}</div>
        <div class="relay-actions">
          <button class="icon-btn" onclick="openEditModal('${r.id}')" title="Edit">✏️</button>
          <button class="icon-btn" onclick="confirmDeleteRelay('${r.id}')" title="Delete" style="color:var(--red)">🗑️</button>
        </div>
      </div>
      <div class="relay-name">${r.name}</div>
      <div class="relay-desc">${r.desc||''}</div>
      <div class="relay-state-label" id="state-label-${r.id}">${isOn?'ACTIVE':'STANDBY'}</div>
      <div class="relay-toggle-wrap">
        <label class="relay-toggle">
          <input type="checkbox" id="toggle-${r.id}" ${isOn?'checked':''} onchange="onToggle('${r.id}',this.checked)">
          <div class="toggle-track"></div>
          <div class="toggle-thumb"></div>
        </label>
        <div class="toggle-text" id="toggle-lbl-${r.id}">${isOn?'ON':'OFF'}</div>
      </div>
    </div>
    `;
  }).join('');
  
  buildQuickChips();
}

function buildQuickChips() {
  const container=document.getElementById('quick-chips');
  if(!container) return;
  const extra=[{l:'all on',f:()=>sendCmd('all','on')},{l:'all off',f:()=>sendCmd('all','off')},{l:'refresh',f:checkConnection}];
  const chips=relays.flatMap(r=>[{l:`${r.name.toLowerCase()} on`,f:()=>sendCmd(r.id,'on')},{l:`${r.name.toLowerCase()} off`,f:()=>sendCmd(r.id,'off')}]);
  const all=[...chips,...extra];
  container.innerHTML=all.map((c,i)=>`<span class="chip" onclick="window._chips[${i}].f()">${c.l}</span>`).join('');
  window._chips=all;
}

function onToggle(id,checked) { 
  sendCmd(id,checked?'on':'off'); 
}

// Expose functions to window for inline HTML onclick handlers
window.sendTextCommand = sendTextCommand;
window.sendCmd = sendCmd;
window.runScene = runScene;
window.toggleListening = toggleListening;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.openAddModal = openAddModal;
window.openEditModal = openEditModal;
window.closeRelayModal = closeRelayModal;
window.selectPin = selectPin;
window.selectEmoji = selectEmoji;
window.saveRelay = saveRelay;
window.confirmDeleteRelay = confirmDeleteRelay;
window.onToggle = onToggle;
window.checkConnection = checkConnection;
window.requestMicPermission = requestMicPermission;
window.stopSpeaking = stopSpeaking;
window.testSpeech = testSpeech;
window.onTTSToggle = onTTSToggle;
window.onRateChange = onRateChange;
window.onPitchChange = onPitchChange;
window.onAutoConnectToggle = onAutoConnectToggle;
window.onContinuousToggle = onContinuousToggle;
window.onWakeToggle = onWakeToggle;
window.saveWakeWord = saveWakeWord;
window.clearLog = clearLog;
window.applyTheme = applyTheme;