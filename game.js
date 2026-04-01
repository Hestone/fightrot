/**
 * FIGHTROT — game.js
 * Voice-controlled fighting game using the Web Audio API
 * Supports local mic + mobile phone controllers via WebSocket relay server
 */

'use strict';

// ============================================================
// 1. CONSTANTS & STATE
// ============================================================
const AURA_MAX         = 100;
const PUNCH_DAMAGE     = 10;
const COOLDOWN_MS      = 800;
const VOLUME_THRESHOLD = 40;   // 0-255
const LOW_BAND_END     = 8;    // freq bin index ≈ < 300 Hz
const HIGH_BAND_START  = 55;   // freq bin index ≈ > 2 kHz

// WebSocket relay — mirror the page's own protocol and host exactly.
// When served via a tunnel (Cloudflare, ngrok) on port 443/80, location.port is ""
// and we must NOT append a port number. Only add :port for non-standard ports (local dev).
const WS_PROTOCOL = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_HOST = location.port ? `${location.hostname}:${location.port}` : location.hostname;
const WS_URL  = `${WS_PROTOCOL}://${WS_HOST}`;

const state = {
  p1Aura: AURA_MAX,
  p2Aura: AURA_MAX,
  lastPunchTime: { Player1: 0, Player2: 0 },
  gameRunning: false,
  animFrameId: null,
  // Which players have a mobile phone connected (overrides local mic for that player)
  mobileConnected: { Player1: false, Player2: false },
  // Room codes for mobile pairing
  roomCodes: { Player1: null, Player2: null },
  // WebSocket connections for each player slot (host side)
  hostSockets: { Player1: null, Player2: null },
};

// Audio objects (local mic)
let analyser     = null;
let freqData     = null;
let audioContext = null;

// ============================================================
// 2. DOM REFS
// ============================================================
const $  = (id) => document.getElementById(id);
const p1El            = $('player1');
const p2El            = $('player2');
const p1AuraBar       = $('p1-aura-bar');
const p2AuraBar       = $('p2-aura-bar');
const p1AuraVal       = $('p1-aura-value');
const p2AuraVal       = $('p2-aura-value');
const hitFlash        = $('hit-flash');
const damageText      = $('damage-text');
const micStatus       = $('mic-status');
const startOverlay    = $('start-overlay');
const gameoverOverlay = $('gameover-overlay');
const winnerText      = $('winner-text');
const startBtn        = $('start-btn');
const restartBtn      = $('restart-btn');
const quitBtn         = $('quit-btn');
const quitBtn2        = $('quit-btn-2');
// Mobile connect UI
const p1CodeDisplay   = $('p1-code-display');
const p2CodeDisplay   = $('p2-code-display');
const p1ConnectBtn    = $('p1-connect-btn');
const p2ConnectBtn    = $('p2-connect-btn');
const p1MobileStatus  = $('p1-mobile-status');
const p2MobileStatus  = $('p2-mobile-status');
// Controller overlay (shown on mobile)
const controllerOverlay = $('controller-overlay');
const codeInput         = $('code-input');
const codeSubmitBtn     = $('code-submit-btn');
const controllerStatus  = $('controller-status');
const controllerActive  = $('controller-active');
const ctrlPlayerBadge   = $('ctrl-player-badge');
const micBarLow         = $('mic-bar-low');
const micBarHigh        = $('mic-bar-high');

// ============================================================
// 3. THE EAR — Microphone Analysis
// ============================================================

/**
 * Initialise the Web Audio API and request mic access.
 * Returns true on success, false on failure.
 */
async function initMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;        // 128 frequency bins
    analyser.smoothingTimeConstant = 0.75;

    source.connect(analyser);
    freqData = new Uint8Array(analyser.frequencyBinCount);  // unsigned byte array

    micStatus.textContent = '🎤 Mic active — SCREAM!';
    micStatus.classList.add('active');
    return true;
  } catch (err) {
    micStatus.textContent = '❌ Mic denied: ' + err.message;
    micStatus.classList.add('error');
    return false;
  }
}

/**
 * Analyse current microphone frequency data.
 *
 * Low frequencies  (bass / growls)  → Player 1 punches
 * High frequencies (treble / shrieks) → Player 2 punches
 *
 * @returns {'Player1'|'Player2'|null}
 */
function analyseMic() {
  if (!analyser) return null;

  analyser.getByteFrequencyData(freqData);   // fill unsigned byte array

  // Sum energy in low band
  let lowSum = 0;
  for (let i = 0; i <= LOW_BAND_END; i++) {
    lowSum += freqData[i];
  }
  const lowAvg = lowSum / (LOW_BAND_END + 1);

  // Sum energy in high band
  let highSum = 0;
  for (let i = HIGH_BAND_START; i < freqData.length; i++) {
    highSum += freqData[i];
  }
  const highAvg = highSum / (freqData.length - HIGH_BAND_START);

  const louder = Math.max(lowAvg, highAvg);

  // Must exceed volume threshold to avoid ambient noise triggering punches
  if (louder < VOLUME_THRESHOLD) return null;

  // Return whichever band is dominant
  return lowAvg >= highAvg ? 'Player1' : 'Player2';
}

// ============================================================
// 4. THE GAME LOOP
// ============================================================
function gameLoop() {
  if (!state.gameRunning) return;

  // Only use local mic if at least one player slot is NOT on mobile
  const needLocalMic = !state.mobileConnected.Player1 || !state.mobileConnected.Player2;

  if (needLocalMic) {
    const detected = analyseMic();
    const now = Date.now();

    if (detected) {
      // Skip if this player is handled by mobile
      if (state.mobileConnected[detected]) {
        // do nothing — mobile handles it
      } else {
        const cooldownOk = (now - state.lastPunchTime[detected]) >= COOLDOWN_MS;
        if (cooldownOk) {
          state.lastPunchTime[detected] = now;
          handlePunch(detected);
        }
      }
    }
  }

  state.animFrameId = requestAnimationFrame(gameLoop);
}

// ============================================================
// 5. PUNCH & COMBAT LOGIC
// ============================================================

/**
 * Trigger a punch for the given player.
 * Player1 punches → damages Player2 (and vice-versa).
 */
function handlePunch(punchingPlayer) {
  const isP1 = punchingPlayer === 'Player1';
  const attackerEl  = isP1 ? p1El : p2El;
  const defenderEl  = isP1 ? p2El : p1El;
  const punchClass  = isP1 ? 'punching-right' : 'punching-left';
  const flashClass  = isP1 ? 'flash-p1' : 'flash-p2';

  // --- Punch animation ---
  triggerPunch(attackerEl, punchClass);

  // --- Hit shake on defender ---
  triggerHitShake(defenderEl);

  // --- Screen flash ---
  triggerFlash(flashClass);

  // --- Reduce aura ---
  if (isP1) {
    state.p2Aura = Math.max(0, state.p2Aura - PUNCH_DAMAGE);
    updateAura('p2', state.p2Aura);
    showDamageText(`-${PUNCH_DAMAGE} AURA`, '#ff4757');
    if (state.p2Aura <= 0) triggerGameOver('Player 1');
  } else {
    state.p1Aura = Math.max(0, state.p1Aura - PUNCH_DAMAGE);
    updateAura('p1', state.p1Aura);
    showDamageText(`-${PUNCH_DAMAGE} AURA`, '#1e90ff');
    if (state.p1Aura <= 0) triggerGameOver('Player 2');
  }
}

// ============================================================
// 6. CHARACTER ANIMATIONS (CSS-driven)
// ============================================================

/**
 * Make a fighter lunge forward then return using CSS class.
 * Automatically removes the class after the animation ends.
 */
function triggerPunch(fighterEl, cssClass) {
  // Remove class in case it's mid-animation
  fighterEl.classList.remove('punching-right', 'punching-left');
  // Force reflow so re-adding triggers animation
  void fighterEl.offsetWidth;
  fighterEl.classList.add(cssClass);

  setTimeout(() => {
    fighterEl.classList.remove(cssClass);
  }, 460);
}

function triggerHitShake(fighterEl) {
  fighterEl.classList.remove('hit-shake');
  void fighterEl.offsetWidth;
  fighterEl.classList.add('hit-shake');
  setTimeout(() => fighterEl.classList.remove('hit-shake'), 360);
}

// ============================================================
// 7. AURA (HEALTH) BAR
// ============================================================

/**
 * Update a player's aura bar and numeric display.
 * @param {'p1'|'p2'} player
 * @param {number} value  0-100
 */
function updateAura(player, value) {
  const bar = player === 'p1' ? p1AuraBar : p2AuraBar;
  const val = player === 'p1' ? p1AuraVal : p2AuraVal;

  const pct = Math.max(0, value);
  bar.style.width = pct + '%';
  val.textContent  = pct;

  // Colour shift: green → yellow → red as aura depletes
  if (pct > 50) {
    bar.style.background = player === 'p1'
      ? 'linear-gradient(90deg, #ff4757, #ff6b81)'
      : 'linear-gradient(270deg, #1e90ff, #74b9ff)';
  } else if (pct > 25) {
    bar.style.background = 'linear-gradient(90deg, #ffa502, #ffcc02)';
  } else {
    bar.style.background = 'linear-gradient(90deg, #ff0000, #ff4500)';
    bar.classList.add('low');
  }
}

// ============================================================
// 8. VFX HELPERS
// ============================================================
function triggerFlash(cssClass) {
  hitFlash.className = cssClass + ' active';
  setTimeout(() => hitFlash.classList.remove('active'), 120);
}

function showDamageText(text, color) {
  damageText.textContent = text;
  damageText.style.color = color;
  damageText.classList.remove('pop');
  void damageText.offsetWidth;
  damageText.classList.add('pop');
}

// ============================================================
// 9. GAME OVER
// ============================================================
function triggerGameOver(winnerName) {
  state.gameRunning = false;
  cancelAnimationFrame(state.animFrameId);

  winnerText.textContent = `🏆 ${winnerName.toUpperCase()} WINS!`;
  gameoverOverlay.classList.remove('hidden');
}

// ============================================================
// 10. GAME RESET
// ============================================================
function resetGame() {
  state.p1Aura = AURA_MAX;
  state.p2Aura = AURA_MAX;
  state.lastPunchTime = { Player1: 0, Player2: 0 };

  updateAura('p1', AURA_MAX);
  updateAura('p2', AURA_MAX);
  p1AuraBar.classList.remove('low');
  p2AuraBar.classList.remove('low');

  p1El.className = 'fighter';
  p2El.className = 'fighter';

  hitFlash.className = '';
  damageText.className = '';
  damageText.textContent = '';

  gameoverOverlay.classList.add('hidden');
}

// ============================================================
// 11. MOBILE ROOM-CODE SYSTEM — WebSocket relay
// ============================================================

/**
 * Generate a random 4-digit numeric code, e.g. "3847"
 */
function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/**
 * Open a WebSocket to the relay server, register this host slot with
 * the given code, then listen for punch events from the phone.
 */
function activateMobileSlot(player) {
  const code = generateCode();
  state.roomCodes[player] = code;

  const codeDisplay = player === 'Player1' ? p1CodeDisplay : p2CodeDisplay;
  const statusEl    = player === 'Player1' ? p1MobileStatus : p2MobileStatus;
  const btn         = player === 'Player1' ? p1ConnectBtn : p2ConnectBtn;

  codeDisplay.textContent = code;
  statusEl.textContent = '⏳ Waiting for phone…';
  statusEl.className = 'mobile-status wait';
  btn.textContent = '🔄 New Code';
  updateStartButton(); // slot is now activated but not yet connected → disable start

  // Close any previous socket for this slot
  const old = state.hostSockets[player];
  if (old) old.close();

  const ws = new WebSocket(WS_URL);
  state.hostSockets[player] = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'host', code, player }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'phone_connected') {
      state.mobileConnected[player] = true;
      updateStartButton();
      statusEl.textContent = '✅ Phone connected!';
      statusEl.className = 'mobile-status ok';
      btn.classList.add('connected');
      btn.textContent = '📱 Connected';
    }

    if (msg.type === 'phone_disconnected') {
      state.mobileConnected[player] = false;
      updateStartButton();
      statusEl.textContent = '📵 Phone disconnected';
      statusEl.className = 'mobile-status';
      btn.classList.remove('connected');
      btn.textContent = '📱 Reconnect Phone';
    }

    if (msg.type === 'punch' && state.gameRunning) {
      const now = Date.now();
      if (now - state.lastPunchTime[player] >= COOLDOWN_MS) {
        state.lastPunchTime[player] = now;
        handlePunch(player);
      }
    }
  };

  ws.onerror = () => {
    statusEl.textContent = '❌ Server error';
    statusEl.className = 'mobile-status';
  };
}

// ============================================================
// 12. MOBILE CONTROLLER (runs on the phone tab)
// ============================================================

async function runMobileController() {
  // Hide the game start screen, show the controller UI
  startOverlay.classList.add('hidden');
  controllerOverlay.classList.remove('hidden');

  codeSubmitBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (code.length !== 4) {
      controllerStatus.textContent = '⚠️ Enter a 4-digit code!';
      return;
    }

    controllerStatus.textContent = '🔗 Connecting…';
    codeSubmitBtn.disabled = true;

    // Open WS first, attach ALL handlers before sending anything (fixes race condition)
    const ws = new WebSocket(WS_URL);

    const playerSlot = await new Promise((resolve) => {
      let settled = false;
      const done = (val) => { if (!settled) { settled = true; resolve(val); } };

      ws.onerror = () => done(null);

      // Attach onmessage BEFORE onopen so no message is ever missed
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ack')   done(msg.player);
        if (msg.type === 'error') { controllerStatus.textContent = '❌ ' + msg.message; done(null); }
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', code }));
      };

      setTimeout(() => done(null), 8000);
    });

    codeSubmitBtn.disabled = false;

    if (!playerSlot) {
      if (!controllerStatus.textContent.startsWith('❌')) {
        controllerStatus.textContent = '❌ No response — is the code correct?';
      }
      ws.close();
      return;
    }

    controllerStatus.textContent = '';
    controllerActive.classList.remove('hidden');
    ctrlPlayerBadge.textContent = playerSlot === 'Player1' ? 'PLAYER 1 🔴' : 'PLAYER 2 🔵';
    ctrlPlayerBadge.className = 'controller-player-badge ' +
      (playerSlot === 'Player1' ? 'badge-p1' : 'badge-p2');

    // Init microphone on the phone
    let ctrlAnalyser, ctrlFreq;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx    = new (window.AudioContext || window.webkitAudioContext)();
      const src    = ctx.createMediaStreamSource(stream);
      ctrlAnalyser = ctx.createAnalyser();
      ctrlAnalyser.fftSize = 256;
      ctrlAnalyser.smoothingTimeConstant = 0.75;
      src.connect(ctrlAnalyser);
      ctrlFreq = new Uint8Array(ctrlAnalyser.frequencyBinCount);
    } catch {
      controllerStatus.textContent = '❌ Mic access denied on phone!';
      return;
    }

    let lastSent = 0;
    const isP1   = playerSlot === 'Player1';

    // Keepalive ping every 20s to prevent WS timeout
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);

    ws.onclose = () => clearInterval(pingInterval);

    function ctrlLoop() {
      ctrlAnalyser.getByteFrequencyData(ctrlFreq);

      let lowSum = 0;
      for (let i = 0; i <= LOW_BAND_END; i++) lowSum += ctrlFreq[i];
      const lowAvg = lowSum / (LOW_BAND_END + 1);

      let highSum = 0;
      for (let i = HIGH_BAND_START; i < ctrlFreq.length; i++) highSum += ctrlFreq[i];
      const highAvg = highSum / (ctrlFreq.length - HIGH_BAND_START);

      // Animate mic bars
      const maxH = 44;
      if (micBarLow)  micBarLow.style.height  = Math.min(maxH, lowAvg  * (maxH / 80)) + 'px';
      if (micBarHigh) micBarHigh.style.height = Math.min(maxH, highAvg * (maxH / 80)) + 'px';

      const louder = Math.max(lowAvg, highAvg);
      if (louder >= VOLUME_THRESHOLD) {
        const match = isP1
          ? lowAvg >= highAvg    // P1 = bass/growl
          : highAvg > lowAvg;    // P2 = treble/shriek

        if (match) {
          const now = Date.now();
          if (now - lastSent >= COOLDOWN_MS) {
            lastSent = now;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'punch' }));
            }
          }
        }
      }

      requestAnimationFrame(ctrlLoop);
    }

    ctrlLoop();
  });
}

// ============================================================
// 13. QUIT BUTTON
// ============================================================
function setupQuitButton(btn) {
  btn.addEventListener('click', () => location.reload());
}
setupQuitButton(quitBtn);
setupQuitButton(quitBtn2);

// ============================================================
// 14. MOBILE CONNECT BUTTON LISTENERS
// ============================================================
p1ConnectBtn.addEventListener('click', () => activateMobileSlot('Player1'));
p2ConnectBtn.addEventListener('click', () => activateMobileSlot('Player2'));

// ============================================================
// 15. MAIN BUTTON LISTENERS
// ============================================================

/**
 * Update the START FIGHT button state based on whether both players are ready.
 * A player is "ready" if they have a connected phone OR the game will use the
 * shared local mic (i.e. neither player has activated a mobile slot).
 * 
 * Rules:
 *  - If NEITHER player has clicked "Connect Phone" → local mic mode, always allowed
 *  - If P1 clicked Connect Phone → P1 must be connected before starting
 *  - If P2 clicked Connect Phone → P2 must be connected before starting
 */
function updateStartButton() {
  const p1Activated = state.roomCodes.Player1 !== null;
  const p2Activated = state.roomCodes.Player2 !== null;

  const p1Ready = !p1Activated || state.mobileConnected.Player1;
  const p2Ready = !p2Activated || state.mobileConnected.Player2;

  if (p1Ready && p2Ready) {
    startBtn.disabled = false;
    startBtn.textContent = '⚔️ START FIGHT';
    startBtn.style.opacity = '1';
  } else {
    startBtn.disabled = true;
    const waiting = [];
    if (!p1Ready) waiting.push('P1');
    if (!p2Ready) waiting.push('P2');
    startBtn.textContent = `⏳ Waiting for ${waiting.join(' & ')}…`;
    startBtn.style.opacity = '0.5';
  }
}

// Call once on load so the button is in its correct initial state
updateStartButton();

// Patch activateMobileSlot and the phone_connected handler to call updateStartButton
// (done via a hook on state.mobileConnected — we re-define the property as a setter)
const _mobileConnected = { Player1: false, Player2: false };
Object.defineProperty(state, 'mobileConnected', {
  get() { return _mobileConnected; },
  // prevent accidental full replacement
});

startBtn.addEventListener('click', async () => {
  if (startBtn.disabled) return;
  startOverlay.classList.add('hidden');

  // Init local mic only if at least one player slot is NOT on mobile
  const needMic = !state.mobileConnected.Player1 || !state.mobileConnected.Player2;
  if (needMic) {
    const micOk = await initMicrophone();
    if (!micOk) {
      micStatus.textContent = '⌨️ Keyboard fallback: Z = P1 punch, / = P2 punch';
    }
  } else {
    micStatus.textContent = '📱 Both players on mobile!';
    micStatus.classList.add('active');
  }

  startGame();
});

restartBtn.addEventListener('click', () => {
  resetGame();
  startGame();
});

function startGame() {
  state.gameRunning = true;
  state.animFrameId = requestAnimationFrame(gameLoop);
}

// ============================================================
// 16. KEYBOARD FALLBACK
// ============================================================
function enableKeyboardFallback() {
  document.addEventListener('keydown', (e) => {
    if (!state.gameRunning) return;
    const now = Date.now();

    if (e.code === 'KeyZ' && !state.mobileConnected.Player1) {
      if (now - state.lastPunchTime['Player1'] >= COOLDOWN_MS) {
        state.lastPunchTime['Player1'] = now;
        handlePunch('Player1');
      }
    }

    if (e.code === 'Slash' && !state.mobileConnected.Player2) {
      if (now - state.lastPunchTime['Player2'] >= COOLDOWN_MS) {
        state.lastPunchTime['Player2'] = now;
        handlePunch('Player2');
      }
    }
  });
}

enableKeyboardFallback();

// ============================================================
// 17. ENTRY POINT — detect if this is a mobile controller tab
// ============================================================
if (new URLSearchParams(location.search).has('controller')) {
  runMobileController();
} else {
  // Use the current page URL as the phone URL hint (works for both local and ngrok)
  const hint = document.getElementById('phone-url-hint');
  if (hint) {
    const base = `${location.protocol}//${location.host}`;
    hint.textContent = `${base}/?controller`;
  }
}
