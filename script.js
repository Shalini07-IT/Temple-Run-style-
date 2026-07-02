/* ==============================================================
   SPRINT RUNNER — script.js
   A Temple-Run-style endless runner built with pure vanilla JS
   and the 2D Canvas API. No frameworks, no assets, no network.

   Structure:
     1. Canvas / DOM setup
     2. Audio engine (Web Audio API synth sounds)
     3. Road / perspective math helpers
     4. Game state
     5. Player
     6. Obstacles & coins (spawning, update, draw)
     7. Particle system (crash sparks, coin sparkle, ambient dust)
     8. Background scenery (parallax hills, sky, clouds)
     9. Input handling (keyboard + touch swipe)
    10. Collision detection
    11. HUD / screens / localStorage high score
    12. Main loop (requestAnimationFrame)
   ============================================================== */

/* ---------------------------------------------------------
   1. CANVAS / DOM SETUP
   --------------------------------------------------------- */
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

let W = 0, H = 0; // logical canvas size (CSS pixels)

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeRoadGeometry();
}
window.addEventListener('resize', resizeCanvas);

/* ---------------------------------------------------------
   2. AUDIO ENGINE — synthesized sound effects, no audio files
   --------------------------------------------------------- */
const AudioEngine = (() => {
  let ctxAudio = null;
  let muted = false;

  function ensureCtx() {
    if (!ctxAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctxAudio = new AC();
    }
    if (ctxAudio.state === 'suspended') ctxAudio.resume();
    return ctxAudio;
  }

  // Generic tone with an ADSR-ish envelope
  function tone({ freq = 440, duration = 0.15, type = 'sine', volume = 0.2, freqEnd = null, delay = 0 }) {
    if (muted) return;
    const ac = ensureCtx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    const t0 = ac.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t0 + duration);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // Short noise burst (for crash) using a buffer source
  function noiseBurst({ duration = 0.35, volume = 0.35, filterFreq = 900 }) {
    if (muted) return;
    const ac = ensureCtx();
    const bufferSize = Math.floor(ac.sampleRate * duration);
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      // decaying white noise
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, ac.currentTime);
    filter.frequency.exponentialRampToValueAtTime(200, ac.currentTime + duration);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(volume, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start();
  }

  return {
    unlock() { ensureCtx(); },
    setMuted(v) { muted = v; },
    jump() { tone({ freq: 420, freqEnd: 780, duration: 0.18, type: 'triangle', volume: 0.18 }); },
    slide() { tone({ freq: 220, freqEnd: 90, duration: 0.16, type: 'square', volume: 0.14 }); },
    coin() {
      tone({ freq: 880, duration: 0.09, type: 'sine', volume: 0.2 });
      tone({ freq: 1320, duration: 0.14, type: 'sine', volume: 0.18, delay: 0.06 });
    },
    laneSwitch() { tone({ freq: 500, freqEnd: 620, duration: 0.08, type: 'sine', volume: 0.1 }); },
    crash() {
      noiseBurst({ duration: 0.4, volume: 0.4, filterFreq: 1200 });
      tone({ freq: 160, freqEnd: 40, duration: 0.35, type: 'sawtooth', volume: 0.25, delay: 0.02 });
    },
    click() { tone({ freq: 600, duration: 0.06, type: 'sine', volume: 0.12 }); },
    milestone() {
      tone({ freq: 660, duration: 0.1, type: 'triangle', volume: 0.15 });
      tone({ freq: 990, duration: 0.14, type: 'triangle', volume: 0.15, delay: 0.08 });
    },
    gameStart() {
      tone({ freq: 440, duration: 0.1, type: 'triangle', volume: 0.15 });
      tone({ freq: 660, duration: 0.14, type: 'triangle', volume: 0.15, delay: 0.09 });
    }
  };
})();

/* ---------------------------------------------------------
   3. ROAD / PERSPECTIVE MATH
   --------------------------------------------------------- */
// The road is drawn as a trapezoid: narrow at the horizon, wide at
// the bottom of the screen. All world entities (player, obstacles,
// coins) share a single "distance-to-y" mapping so everything scales
// and converges consistently -> convincing pseudo-3D perspective.
let ROAD = {
  horizonY: 0,
  playerY: 0,       // fixed screen-y where the player character stands
  topHalfWidth: 0,
  bottomHalfWidth: 0
};

function computeRoadGeometry() {
  ROAD.horizonY = H * 0.32;
  ROAD.playerY = H * 0.80;
  ROAD.topHalfWidth = W * 0.035;
  ROAD.bottomHalfWidth = W * 0.62;
}

// Half-width of the road at a given screen y (linear perspective interpolation)
function halfWidthAtY(y) {
  const t = clamp((y - ROAD.horizonY) / (H - ROAD.horizonY), 0, 1.3);
  return ROAD.topHalfWidth + (ROAD.bottomHalfWidth - ROAD.topHalfWidth) * t;
}

// Convert a lane index (-1, 0, 1) + screen-y into a screen x-coordinate
function laneX(lane, y) {
  const halfW = halfWidthAtY(y);
  const laneWidth = (halfW * 2) / 3;
  return W / 2 + lane * laneWidth;
}

// Perspective scale factor at a given screen-y, relative to the player line
function scaleAtY(y) {
  return halfWidthAtY(y) / halfWidthAtY(ROAD.playerY);
}

// Progress t (0..1+) -> screen y between horizon and the player line
function yForProgress(t) {
  return ROAD.horizonY + (ROAD.playerY - ROAD.horizonY) * t;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

/* ---------------------------------------------------------
   4. GAME STATE
   --------------------------------------------------------- */
const STATE = { START: 'start', PLAYING: 'playing', PAUSED: 'paused', GAMEOVER: 'gameover' };

const game = {
  state: STATE.START,
  worldSpeed: 300,       // world units per second entities travel toward player
  baseSpeed: 300,
  maxSpeed: 900,
  speedRampRate: 4.2,    // how fast speed increases per second survived
  elapsed: 0,
  distanceScore: 0,
  coins: 0,
  best: 0,
  spawnAccum: 0,
  spawnGap: 620,         // world-units between spawns (shrinks slightly with difficulty)
  decorAccum: 0,
  lastTime: 0,
  shake: 0               // camera shake magnitude (for crashes)
};

const SPAWN_DISTANCE = 1250; // world-units an entity travels from spawn to player line

/* ---------------------------------------------------------
   5. PLAYER
   --------------------------------------------------------- */
const player = {
  lane: 0,              // -1, 0, 1
  x: 0,                 // current smoothed screen x
  jumping: false,
  jumpT: 0,              // 0..1 progress of the jump arc
  jumpDuration: 0.62,
  sliding: false,
  slideT: 0,
  slideDuration: 0.55,
  legPhase: 0,           // for the running-legs animation
  crashed: false
};

function resetPlayer() {
  player.lane = 0;
  player.x = laneX(0, ROAD.playerY);
  player.jumping = false;
  player.jumpT = 0;
  player.sliding = false;
  player.slideT = 0;
  player.legPhase = 0;
  player.crashed = false;
}

function tryChangeLane(dir) {
  if (game.state !== STATE.PLAYING) return;
  const newLane = clamp(player.lane + dir, -1, 1);
  if (newLane !== player.lane) {
    player.lane = newLane;
    AudioEngine.laneSwitch();
  }
}

function tryJump() {
  if (game.state !== STATE.PLAYING) return;
  if (player.jumping || player.sliding) return;
  player.jumping = true;
  player.jumpT = 0;
  AudioEngine.jump();
}

function trySlide() {
  if (game.state !== STATE.PLAYING) return;
  if (player.sliding || player.jumping) return;
  player.sliding = true;
  player.slideT = 0;
  AudioEngine.slide();
}

function updatePlayer(dt) {
  player.legPhase += dt * (10 + game.worldSpeed * 0.01);

  // Smooth lane interpolation
  const targetX = laneX(player.lane, ROAD.playerY);
  player.x = lerp(player.x, targetX, Math.min(1, dt * 12));

  if (player.jumping) {
    player.jumpT += dt / player.jumpDuration;
    if (player.jumpT >= 1) {
      player.jumpT = 0;
      player.jumping = false;
    }
  }
  if (player.sliding) {
    player.slideT += dt / player.slideDuration;
    if (player.slideT >= 1) {
      player.slideT = 0;
      player.sliding = false;
    }
  }
}

// Current jump height in screen pixels (parabolic arc)
function currentJumpHeight() {
  if (!player.jumping) return 0;
  const t = player.jumpT;
  return Math.sin(t * Math.PI) * (H * 0.16);
}

function drawPlayer() {
  const y = ROAD.playerY;
  const scale = scaleAtY(y) * 1.05;
  const jumpH = currentJumpHeight();
  const baseSize = H * 0.09 * scale;
  const isSliding = player.sliding;

  const bodyH = isSliding ? baseSize * 0.55 : baseSize;
  const bodyW = baseSize * 0.62;
  const cx = player.x;
  const cy = y - jumpH - bodyH / 2;

  ctx.save();

  // Ground shadow — shrinks while jumping to sell the height
  const shadowScale = player.jumping ? clamp(1 - Math.sin(player.jumpT * Math.PI) * 0.6, 0.3, 1) : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, y + 4, bodyW * 0.55 * shadowScale, bodyW * 0.18 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();

  // Running legs animation (two simple trapezoids swinging)
  const legSwing = Math.sin(player.legPhase) * baseSize * 0.18;
  if (!isSliding) {
    ctx.fillStyle = '#2b2f4a';
    ctx.fillRect(cx - bodyW * 0.28, cy + bodyH * 0.38, bodyW * 0.22, bodyH * 0.5 + legSwing);
    ctx.fillRect(cx + bodyW * 0.06, cy + bodyH * 0.38, bodyW * 0.22, bodyH * 0.5 - legSwing);
  }

  // Body (rounded rect) — gradient for a modern glossy look
  const grad = ctx.createLinearGradient(cx, cy - bodyH / 2, cx, cy + bodyH / 2);
  grad.addColorStop(0, '#4fd6ff');
  grad.addColorStop(1, '#3a7bd5');
  roundRect(ctx, cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH, bodyW * 0.3);
  ctx.fillStyle = grad;
  ctx.fill();

  // Head
  ctx.beginPath();
  ctx.fillStyle = '#ffd9a0';
  ctx.arc(cx, cy - bodyH / 2 - bodyW * 0.22, bodyW * 0.26, 0, Math.PI * 2);
  ctx.fill();

  // Motion streak while jumping
  if (player.jumping) {
    ctx.strokeStyle = 'rgba(79,214,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - bodyW * 0.4, cy + bodyH * 0.5);
    ctx.lineTo(cx - bodyW * 0.4, cy + bodyH * 0.5 + jumpH * 0.5);
    ctx.moveTo(cx + bodyW * 0.4, cy + bodyH * 0.5);
    ctx.lineTo(cx + bodyW * 0.4, cy + bodyH * 0.5 + jumpH * 0.5);
    ctx.stroke();
  }

  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------------------------------------------------------
   6. OBSTACLES & COINS
   --------------------------------------------------------- */
let obstacles = [];
let coins = [];

const OBSTACLE_TYPES = ['low', 'high', 'block'];
// low   -> ground barrier, avoid by JUMPING
// high  -> overhead beam, avoid by SLIDING
// block -> full obstacle, avoid by CHANGING LANE only

function spawnEntities() {
  const lanes = [-1, 0, 1];
  const roll = Math.random();

  if (roll < 0.62) {
    // Spawn a single obstacle in a random lane
    const lane = lanes[Math.floor(Math.random() * 3)];
    const type = OBSTACLE_TYPES[Math.floor(Math.random() * OBSTACLE_TYPES.length)];
    obstacles.push({ lane, distance: SPAWN_DISTANCE, type, checked: false });

    // Occasionally place coins in one of the free lanes as a reward path
    if (Math.random() < 0.7) {
      const freeLanes = lanes.filter(l => l !== lane);
      const coinLane = freeLanes[Math.floor(Math.random() * freeLanes.length)];
      spawnCoinLine(coinLane, SPAWN_DISTANCE, 4);
    }
  } else if (roll < 0.8) {
    // Spawn two blocked lanes, leaving exactly one free lane -> forces a dodge
    const shuffled = [...lanes].sort(() => Math.random() - 0.5);
    const blockedLanes = shuffled.slice(0, 2);
    const freeLane = shuffled[2];
    blockedLanes.forEach(l => {
      obstacles.push({ lane: l, distance: SPAWN_DISTANCE, type: 'block', checked: false });
    });
    spawnCoinLine(freeLane, SPAWN_DISTANCE, 5);
  } else {
    // Pure coin arc across a lane, no obstacle - a breather / bonus moment
    const lane = lanes[Math.floor(Math.random() * 3)];
    spawnCoinLine(lane, SPAWN_DISTANCE, 6);
  }
}

function spawnCoinLine(lane, startDistance, count) {
  for (let i = 0; i < count; i++) {
    coins.push({
      lane,
      distance: startDistance - i * 70,
      collected: false,
      bob: Math.random() * Math.PI * 2
    });
  }
}

function updateEntities(dt) {
  const move = game.worldSpeed * dt;

  for (const o of obstacles) {
    const prev = o.distance;
    o.distance -= move;
    if (!o.checked && prev > 0 && o.distance <= 0) {
      o.checked = true;
      evaluateObstacleCollision(o);
    }
  }
  obstacles = obstacles.filter(o => o.distance > -300);

  for (const c of coins) {
    const prev = c.distance;
    c.distance -= move;
    c.bob += dt * 6;
    if (!c.collected && prev > -40 && c.distance <= 40 && c.distance > -40) {
      if (c.lane === player.lane) {
        c.collected = true;
        collectCoin(c);
      }
    }
  }
  coins = coins.filter(c => c.distance > -300 && !c.collected);
}

function drawEntities() {
  // Draw far-to-near so nearer objects overlap farther ones correctly
  const all = [
    ...obstacles.map(o => ({ ...o, kind: 'obstacle' })),
    ...coins.map(c => ({ ...c, kind: 'coin' }))
  ].sort((a, b) => b.distance - a.distance);

  for (const e of all) {
    const t = clamp(1 - e.distance / SPAWN_DISTANCE, 0.02, 1.08);
    const y = yForProgress(t);
    const x = laneX(e.lane, y);
    const scale = scaleAtY(y);
    if (e.kind === 'obstacle') drawObstacle(e, x, y, scale);
    else drawCoin(e, x, y, scale);
  }
}

function drawObstacle(o, x, y, scale) {
  const s = H * 0.11 * scale;
  ctx.save();
  if (o.type === 'low') {
    // Ground barrier — jump over it. Drawn as a glowing red bar near the ground.
    const w = s * 1.5, h = s * 0.55;
    const grad = ctx.createLinearGradient(x, y - h, x, y);
    grad.addColorStop(0, '#ff8a65');
    grad.addColorStop(1, '#d84315');
    roundRect(ctx, x - w / 2, y - h, w, h, h * 0.25);
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(255,90,60,0.6)';
    ctx.shadowBlur = 12 * scale;
    ctx.fill();
  } else if (o.type === 'high') {
    // Overhead beam — slide under it. Drawn suspended above ground level.
    const w = s * 1.6, h = s * 0.4;
    const gapAbove = s * 0.75; // gap under beam where sliding player fits
    const grad = ctx.createLinearGradient(x, y - gapAbove - h, x, y - gapAbove);
    grad.addColorStop(0, '#ba68c8');
    grad.addColorStop(1, '#6a1b9a');
    roundRect(ctx, x - w / 2, y - gapAbove - h, w, h, h * 0.2);
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(186,104,200,0.6)';
    ctx.shadowBlur = 12 * scale;
    ctx.fill();
    // Support posts for visual clarity
    ctx.fillStyle = '#4a148c';
    ctx.fillRect(x - w / 2, y - gapAbove, w * 0.08, gapAbove);
    ctx.fillRect(x + w / 2 - w * 0.08, y - gapAbove, w * 0.08, gapAbove);
  } else {
    // Full block — must change lanes. Drawn as a solid glossy crate.
    const w = s * 1.3, h = s * 1.3;
    const grad = ctx.createLinearGradient(x - w / 2, y - h, x + w / 2, y);
    grad.addColorStop(0, '#ffca28');
    grad.addColorStop(1, '#e65100');
    roundRect(ctx, x - w / 2, y - h, w, h, h * 0.14);
    ctx.fillStyle = grad;
    ctx.shadowColor = 'rgba(255,160,0,0.55)';
    ctx.shadowBlur = 14 * scale;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = Math.max(1, 2 * scale);
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y - h / 2); ctx.lineTo(x + w / 2, y - h / 2);
    ctx.moveTo(x, y - h); ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCoin(c, x, y, scale) {
  const r = H * 0.028 * scale;
  const bobY = Math.sin(c.bob) * r * 0.4;
  const cy = y - r * 1.6 + bobY;
  ctx.save();
  ctx.translate(x, cy);
  // Squash horizontally to fake a spinning coin
  const spin = Math.abs(Math.sin(c.bob * 0.7));
  ctx.scale(0.35 + spin * 0.65, 1);
  const grad = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
  grad.addColorStop(0, '#fff6d0');
  grad.addColorStop(0.6, '#ffd54f');
  grad.addColorStop(1, '#ff8f00');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.shadowColor = 'rgba(255,215,80,0.7)';
  ctx.shadowBlur = 10 * scale;
  ctx.fill();
  ctx.restore();
}

function collectCoin(c) {
  game.coins++;
  game.distanceScore += 5;
  AudioEngine.coin();
  const y = ROAD.playerY - H * 0.05;
  spawnSparkle(player.x, y);
  spawnFloatText(player.x, y, '+5', '#ffe17a');
  updateHUD();
}

/* ---------------------------------------------------------
   7. PARTICLE SYSTEM
   --------------------------------------------------------- */
let particles = [];      // gameplay particles (crash sparks, coin sparkle)
let ambientDust = [];    // ambient floating background particles

function spawnSparkle(x, y) {
  for (let i = 0; i < 10; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 220,
      vy: (Math.random() - 0.5) * 220 - 60,
      life: 0.5 + Math.random() * 0.3,
      age: 0,
      size: 2 + Math.random() * 3,
      color: '255,213,79'
    });
  }
}

function spawnCrashBurst(x, y) {
  for (let i = 0; i < 26; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 260;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 80,
      life: 0.6 + Math.random() * 0.5,
      age: 0,
      size: 3 + Math.random() * 4,
      color: Math.random() < 0.5 ? '255,94,126' : '255,180,80'
    });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 420 * dt; // gravity
  }
  particles = particles.filter(p => p.age < p.life);
}

function drawParticles() {
  for (const p of particles) {
    const alpha = clamp(1 - p.age / p.life, 0, 1);
    ctx.fillStyle = `rgba(${p.color},${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function initAmbientDust() {
  ambientDust = [];
  for (let i = 0; i < 40; i++) {
    ambientDust.push({
      x: Math.random() * W,
      y: Math.random() * H * 0.6,
      size: 0.5 + Math.random() * 1.8,
      speed: 8 + Math.random() * 18,
      alpha: 0.15 + Math.random() * 0.35
    });
  }
}

function updateAmbientDust(dt) {
  for (const d of ambientDust) {
    d.x -= d.speed * dt;
    if (d.x < -5) d.x = W + 5;
  }
}

function drawAmbientDust() {
  for (const d of ambientDust) {
    ctx.fillStyle = `rgba(255,255,255,${d.alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Floating "+N" text popups (DOM-based for crisp text + easy CSS animation)
const fxLayer = document.getElementById('fx-layer');
function spawnFloatText(x, y, text, color) {
  const el = document.createElement('div');
  el.className = 'float-text';
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.color = color;
  fxLayer.appendChild(el);
  setTimeout(() => el.remove(), 850);
}

/* ---------------------------------------------------------
   8. BACKGROUND SCENERY (sky, sun, parallax hills, clouds)
   --------------------------------------------------------- */
let sceneryOffset = 0;

function drawSky() {
  const grad = ctx.createLinearGradient(0, 0, 0, ROAD.horizonY + 40);
  grad.addColorStop(0, '#1a1c3a');
  grad.addColorStop(0.55, '#3a2f5c');
  grad.addColorStop(1, '#ff8f6b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, ROAD.horizonY + 40);

  // Glowing sun near the horizon
  const sunY = ROAD.horizonY - H * 0.02;
  const sunR = H * 0.09;
  const sunGrad = ctx.createRadialGradient(W / 2, sunY, 0, W / 2, sunY, sunR * 2.2);
  sunGrad.addColorStop(0, 'rgba(255,220,140,0.9)');
  sunGrad.addColorStop(1, 'rgba(255,220,140,0)');
  ctx.fillStyle = sunGrad;
  ctx.beginPath();
  ctx.arc(W / 2, sunY, sunR * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffe9c2';
  ctx.beginPath();
  ctx.arc(W / 2, sunY, sunR, 0, Math.PI * 2);
  ctx.fill();

  // Parallax hill silhouettes (slow drift for depth)
  drawHillLayer(ROAD.horizonY - H * 0.01, H * 0.05, 'rgba(40,30,70,0.55)', sceneryOffset * 0.15);
  drawHillLayer(ROAD.horizonY + H * 0.01, H * 0.035, 'rgba(25,18,48,0.75)', sceneryOffset * 0.3);
}

function drawHillLayer(baseY, amp, color, offset) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  const step = W / 8;
  for (let i = 0; i <= 8; i++) {
    const x = i * step;
    const y = baseY - Math.abs(Math.sin((i + offset * 0.02) * 1.3)) * amp;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, ROAD.horizonY + 40);
  ctx.lineTo(0, ROAD.horizonY + 40);
  ctx.closePath();
  ctx.fill();
}

function drawRoad() {
  // Road surface
  const topY = ROAD.horizonY;
  const botY = H;
  const topL = W / 2 - ROAD.topHalfWidth, topR = W / 2 + ROAD.topHalfWidth;
  const botL = W / 2 - halfWidthAtY(botY), botR = W / 2 + halfWidthAtY(botY);

  const roadGrad = ctx.createLinearGradient(0, topY, 0, botY);
  roadGrad.addColorStop(0, '#3a3d5c');
  roadGrad.addColorStop(1, '#1c1e30');
  ctx.fillStyle = roadGrad;
  ctx.beginPath();
  ctx.moveTo(topL, topY);
  ctx.lineTo(topR, topY);
  ctx.lineTo(botR, botY);
  ctx.lineTo(botL, botY);
  ctx.closePath();
  ctx.fill();

  // Roadside edge glow strips
  ctx.strokeStyle = 'rgba(79,214,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(topL, topY); ctx.lineTo(botL, botY);
  ctx.moveTo(topR, topY); ctx.lineTo(botR, botY);
  ctx.stroke();

  // Lane dividers — dashed, animated using sceneryOffset for forward motion
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  for (const lane of [-0.5, 0.5]) {
    ctx.beginPath();
    const dashCount = 14;
    for (let i = 0; i < dashCount; i++) {
      let t = (i / dashCount + (sceneryOffset % (1 / dashCount))) % 1;
      const t2 = t + 0.035;
      if (t2 > 1) continue;
      const y1 = yForProgress(t);
      const y2 = yForProgress(t2);
      const x1 = W / 2 + lane * (halfWidthAtY(y1) * 2 / 3) * 2;
      const x2 = W / 2 + lane * (halfWidthAtY(y2) * 2 / 3) * 2;
      ctx.lineWidth = Math.max(1, 3 * scaleAtY(y1));
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  // Side decoration posts for extra depth cues
  drawSidePosts();
}

function drawSidePosts() {
  const count = 10;
  for (let i = 0; i < count; i++) {
    let t = (i / count + (sceneryOffset % (1 / count))) % 1;
    if (t < 0.03) continue;
    const y = yForProgress(t);
    const scale = scaleAtY(y);
    const halfW = halfWidthAtY(y);
    const postH = H * 0.05 * scale;
    for (const side of [-1, 1]) {
      const x = W / 2 + side * (halfW + 10 * scale);
      ctx.fillStyle = 'rgba(255,204,51,0.85)';
      ctx.fillRect(x - 2 * scale, y - postH, 4 * scale, postH);
    }
  }
}

function updateScenery(dt) {
  sceneryOffset += dt * (game.worldSpeed / SPAWN_DISTANCE);
}

/* ---------------------------------------------------------
   9. INPUT HANDLING (keyboard + touch swipe)
   --------------------------------------------------------- */
window.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'ArrowLeft': e.preventDefault(); tryChangeLane(-1); break;
    case 'ArrowRight': e.preventDefault(); tryChangeLane(1); break;
    case 'ArrowUp': e.preventDefault(); tryJump(); break;
    case 'ArrowDown': e.preventDefault(); trySlide(); break;
    case 'KeyP': togglePause(); break;
  }
});

// Touch swipe controls
let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
canvas.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchStartTime = performance.now();
}, { passive: true });

canvas.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  const dt = performance.now() - touchStartTime;
  const absX = Math.abs(dx), absY = Math.abs(dy);
  const SWIPE_THRESHOLD = 30;

  if (dt < 600 && Math.max(absX, absY) > SWIPE_THRESHOLD) {
    if (absX > absY) {
      tryChangeLane(dx > 0 ? 1 : -1);
    } else {
      if (dy < 0) tryJump(); else trySlide();
    }
  }
}, { passive: true });

/* ---------------------------------------------------------
   10. COLLISION EVALUATION
   --------------------------------------------------------- */
function evaluateObstacleCollision(o) {
  if (o.lane !== player.lane) return; // different lane -> safe automatically

  let avoided = false;
  if (o.type === 'low' && player.jumping) avoided = true;
  if (o.type === 'high' && player.sliding) avoided = true;
  // 'block' type can never be avoided except by lane change

  if (!avoided) triggerGameOver();
}

/* ---------------------------------------------------------
   11. HUD / SCREENS / HIGH SCORE
   --------------------------------------------------------- */
const scoreValueEl = document.getElementById('score-value');
const coinValueEl = document.getElementById('coin-value');
const bestValueEl = document.getElementById('best-value');
const startBestEl = document.getElementById('start-best');
const finalScoreEl = document.getElementById('final-score');
const finalCoinsEl = document.getElementById('final-coins');
const finalBestEl = document.getElementById('final-best');
const newBestBanner = document.getElementById('new-best-banner');

const startScreen = document.getElementById('start-screen');
const pauseScreen = document.getElementById('pause-screen');
const gameoverScreen = document.getElementById('gameover-screen');

const HIGH_SCORE_KEY = 'sprintRunnerHighScore';

function loadHighScore() {
  const v = parseInt(localStorage.getItem(HIGH_SCORE_KEY), 10);
  return Number.isFinite(v) ? v : 0;
}
function saveHighScore(v) {
  localStorage.setItem(HIGH_SCORE_KEY, String(v));
}

function updateHUD() {
  scoreValueEl.textContent = Math.floor(game.distanceScore);
  coinValueEl.textContent = game.coins;
  bestValueEl.textContent = game.best;
}

function showScreen(el) {
  [startScreen, pauseScreen, gameoverScreen].forEach(s => s.classList.add('hidden'));
  if (el) el.classList.remove('hidden');
}

/* ---------------------------------------------------------
   12. GAME FLOW: start / pause / resume / game over / restart
   --------------------------------------------------------- */
function startGame() {
  AudioEngine.unlock();
  AudioEngine.gameStart();

  game.state = STATE.PLAYING;
  game.worldSpeed = game.baseSpeed;
  game.elapsed = 0;
  game.distanceScore = 0;
  game.coins = 0;
  game.spawnAccum = 0;
  obstacles = [];
  coins = [];
  particles = [];
  resetPlayer();
  updateHUD();
  showScreen(null);
}

function togglePause() {
  if (game.state === STATE.PLAYING) {
    game.state = STATE.PAUSED;
    showScreen(pauseScreen);
    AudioEngine.click();
  } else if (game.state === STATE.PAUSED) {
    game.state = STATE.PLAYING;
    showScreen(null);
    AudioEngine.click();
  }
}

function triggerGameOver() {
  if (game.state !== STATE.PLAYING) return;
  game.state = STATE.GAMEOVER;
  player.crashed = true;
  AudioEngine.crash();
  game.shake = 18;
  spawnCrashBurst(player.x, ROAD.playerY - H * 0.05);

  const finalScore = Math.floor(game.distanceScore);
  const isNewBest = finalScore > game.best;
  if (isNewBest) {
    game.best = finalScore;
    saveHighScore(game.best);
  }

  setTimeout(() => {
    finalScoreEl.textContent = finalScore;
    finalCoinsEl.textContent = game.coins;
    finalBestEl.textContent = game.best;
    newBestBanner.classList.toggle('hidden', !isNewBest);
    showScreen(gameoverScreen);
  }, 420);

  updateHUD();
}

function restartGame() {
  AudioEngine.click();
  startGame();
}

/* ---------------------------------------------------------
   Wire up buttons
   --------------------------------------------------------- */
document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('restart-btn').addEventListener('click', restartGame);
document.getElementById('restart-from-pause-btn').addEventListener('click', restartGame);
document.getElementById('resume-btn').addEventListener('click', togglePause);
document.getElementById('pause-btn').addEventListener('click', togglePause);

// Tap-to-jump on the canvas itself (nice for desktop mouse users too)
canvas.addEventListener('click', () => {
  if (game.state === STATE.PLAYING) tryJump();
});

/* ---------------------------------------------------------
   13. MAIN LOOP
   --------------------------------------------------------- */
function updateDifficulty(dt) {
  game.elapsed += dt;
  game.worldSpeed = Math.min(game.maxSpeed, game.baseSpeed + game.elapsed * game.speedRampRate);
  game.spawnGap = Math.max(360, 620 - game.elapsed * 2.2);
}

function updateGameplay(dt) {
  updateDifficulty(dt);
  updatePlayer(dt);
  updateEntities(dt);
  updateScenery(dt);

  // Spawn new obstacle/coin patterns based on world-distance traveled
  game.spawnAccum += game.worldSpeed * dt;
  if (game.spawnAccum >= game.spawnGap) {
    game.spawnAccum = 0;
    spawnEntities();
  }

  // Distance-based scoring (grows faster as speed increases)
  game.distanceScore += dt * (game.worldSpeed * 0.03);

  // Milestone chime every 500 points
  if (Math.floor(game.distanceScore / 500) > Math.floor((game.distanceScore - dt * game.worldSpeed * 0.03) / 500)) {
    AudioEngine.milestone();
  }

  updateHUD();
}

function render() {
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  if (game.shake > 0.2) {
    const dx = (Math.random() - 0.5) * game.shake;
    const dy = (Math.random() - 0.5) * game.shake;
    ctx.translate(dx, dy);
    game.shake *= 0.88;
  } else {
    game.shake = 0;
  }

  drawSky();
  drawAmbientDust();
  drawRoad();
  drawEntities();
  if (!player.crashed || game.shake > 0.2) drawPlayer();
  drawParticles();

  ctx.restore();
}

function loop(timestamp) {
  if (!game.lastTime) game.lastTime = timestamp;
  let dt = (timestamp - game.lastTime) / 1000;
  dt = Math.min(dt, 0.05); // clamp to avoid huge jumps on tab switch
  game.lastTime = timestamp;

  updateAmbientDust(dt);

  if (game.state === STATE.PLAYING) {
    updateGameplay(dt);
  } else if (game.state === STATE.GAMEOVER) {
    updateParticles(dt);
    updateScenery(dt * 0.2);
  }

  updateParticles(dt);
  render();
  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------
   INITIALIZATION
   --------------------------------------------------------- */
function init() {
  resizeCanvas();
  initAmbientDust();
  resetPlayer();
  game.best = loadHighScore();
  bestValueEl.textContent = game.best;
  startBestEl.textContent = game.best;
  showScreen(startScreen);
  requestAnimationFrame(loop);
}

init();
