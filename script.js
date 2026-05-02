// ── State ──────────────────────────────────────────────────────────────────────
const RELAYS = [
  { id: 'light',  icon: '💡', name: 'Light' },
  { id: 'fan',    icon: '🌀', name: 'Fan' },
  { id: 'pump',   icon: '💧', name: 'Pump' },
  { id: 'heater', icon: '🔥', name: 'Heater' },
];
let states = { light: false, fan: false, pump: false, heater: false };
let recognition = null;
let listening = false;

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    document.getElementById('browser-warn').style.display = 'block';
    document.getElementById('mic-btn').disabled = true;
    document.getElementById('mic-btn').title = 'Voice not supported';
  }
  buildRelayCards();
  checkConnection();
});

// ── Relay Card Builder ─────────────────────────────────────────────────────────
function buildRelayCards() {
  const grid = document.getElementById('relays-grid');
  grid.innerHTML = RELAYS.map(r => `
    <div class="relay-card" id="card-${r.id}">
      <div class="relay-top">
        <div>
          <div class="relay-name">${r.name}</div>
          <div class="relay-state" id="state-label-${r.id}">OFFLINE</div>
        </div>
        <div class="relay-icon">${r.icon}</div>
      </div>
      <div class="toggle-wrap">
        <label class="toggle">
          <input type="checkbox" id="toggle-${r.id}" onchange="onToggle('${r.id}', this.checked)">
          <div class="toggle-track"></div>
          <div class="toggle-thumb"></div>
        </label>
        <span class="toggle-label" id="toggle-lbl-${r.id}">OFF</span>
      </div>
      <div class="relay-btns">
        <button class="rbtn on"  onclick="sendCmd('${r.id}','on')">ON</button>
        <button class="rbtn off" onclick="sendCmd('${r.id}','off')">OFF</button>
        <button class="rbtn"     onclick="sendCmd('${r.id}','toggle')">TOGGLE</button>
      </div>
    </div>
  `).join('');
}

function onToggle(id, checked) {
  sendCmd(id, checked ? 'on' : 'off');
}

function updateUI() {
  RELAYS.forEach(r => {
    const on = states[r.id];
    const card = document.getElementById('card-' + r.id);
    const lbl  = document.getElementById('state-label-' + r.id);
    const tlbl = document.getElementById('toggle-lbl-' + r.id);
    const chk  = document.getElementById('toggle-' + r.id);
    if (!card) return;
    card.classList.toggle('on', on);
    lbl.textContent  = on ? 'ACTIVE' : 'STANDBY';
    tlbl.textContent = on ? 'ON' : 'OFF';
    chk.checked = on;
  });
}

// ── IP / Connection ────────────────────────────────────────────────────────────
function getIP() { return document.getElementById('ip-input').value.trim(); }

async function checkConnection() {
  const dot = document.getElementById('conn-dot');
  dot.className = 'conn-dot';
  try {
    const r = await fetch(`http://${getIP()}/status`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const data = await r.json();
      Object.assign(states, data);
      updateUI();
      dot.className = 'conn-dot ok';
      log('info', `Connected to ${getIP()}`);
    } else throw new Error('Bad response');
  } catch {
    dot.className = 'conn-dot err';
    log('err', `Cannot reach ${getIP()}`);
  }
}

// ── Send Command ───────────────────────────────────────────────────────────────
async function sendCmd(device, action) {
  const url = `http://${getIP()}/cmd?device=${device}&action=${action}`;
  setStatus(`Sending → ${device} ${action}…`, 'info');
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = await r.json();
    if (data.ok) {
      if (device === 'all') {
        const on = action === 'on' ? true : action === 'off' ? false : null;
        RELAYS.forEach(r => {
          states[r.id] = on !== null ? on : !states[r.id];
        });
      } else {
        states[device] = data.state;
      }
      updateUI();
      setStatus(`✓ ${device.toUpperCase()} → ${action.toUpperCase()}`, 'ok');
      log('ok', `${device} → ${action}`);
    } else {
      setStatus(data.error || 'Command failed', 'err');
      log('err', data.error || 'Command failed');
    }
  } catch (e) {
    setStatus('ESP32 unreachable', 'err');
    log('err', `Fetch failed: ${e.message}`);
  }
}

async function fetchStatus() {
  try {
    const r = await fetch(`http://${getIP()}/status`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    Object.assign(states, data);
    updateUI();
    log('info', 'Status refreshed');
    setStatus('Status updated', 'ok');
  } catch {
    log('err', 'Status fetch failed');
  }
}

// ── Voice Recognition ──────────────────────────────────────────────────────────
function toggleListening() {
  if (listening) stopListening();
  else startListening();
}

function startListening() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    listening = true;
    document.getElementById('mic-btn').classList.add('listening');
    setStatus('Listening… speak now', 'info');
    log('info', 'Voice recognition started');
  };

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results)
      .map(r => r[0].transcript).join(' ').toLowerCase().trim();
    document.getElementById('transcript-text').textContent = `"${transcript}"`;

    if (e.results[0].isFinal) {
      log('voice', `Heard: "${transcript}"`);
      parseAndSend(transcript);
    }
  };

  recognition.onerror = (e) => {
    setStatus(`Voice error: ${e.error}`, 'err');
    log('err', `Speech error: ${e.error}`);
    stopListening();
  };

  recognition.onend = () => { stopListening(); };
  recognition.start();
}

function stopListening() {
  listening = false;
  document.getElementById('mic-btn').classList.remove('listening');
  if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
  if (document.getElementById('status-text').textContent.startsWith('Listening')) {
    setStatus('Ready', '');
  }
}

function parseAndSend(text) {
  const devices = ['light', 'fan', 'pump', 'heater', 'all'];
  let device = null, action = null;

  const turnMatch = text.match(/turn\s+(on|off)\s+(?:the\s+)?(\w+)/);
  if (turnMatch) { action = turnMatch[1]; device = turnMatch[2]; }

  const turnMatch2 = text.match(/turn\s+(?:the\s+)?(\w+)\s+(on|off)/);
  if (!device && turnMatch2) { device = turnMatch2[1]; action = turnMatch2[2]; }

  if (!device) {
    for (const d of devices) { if (text.includes(d)) { device = d; break; } }
  }

  if (!action) {
    if (text.includes(' on')) action = 'on';
    else if (text.includes(' off')) action = 'off';
    else if (text.includes('toggle') || text.includes('switch') || text.includes('flip')) action = 'toggle';
  }

  if (text.includes('everything') || text.includes('all')) device = 'all';

  if (device && action) {
    if (!devices.includes(device)) { setStatus(`Unknown device: "${device}"`, 'err'); return; }
    setStatus(`Voice → ${device} ${action}`, 'info');
    sendCmd(device, action);
  } else {
    setStatus('Could not parse command', 'err');
    log('err', `Unrecognized: "${text}"`);
  }
}

function setStatus(msg, cls) {
  const el = document.getElementById('status-text');
  el.textContent = msg;
  el.className = cls || '';
}

function log(type, msg) {
  const box = document.getElementById('log-box');
  const ts = new Date().toTimeString().slice(0,8);
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="ts">[${ts}]</span><span class="msg">${msg}</span>`;
  box.appendChild(entry);
  box.scrollTop = box.scrollHeight;
}