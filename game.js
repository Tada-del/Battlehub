/* Clash of Banners — top-down troop battle
 * Pure-canvas, dependency-free. ~60fps on modern devices.
 * (c) 2026
 */
(() => {
'use strict';

// ---------- Utility ----------
const TAU = Math.PI * 2;
const rand  = (a=1, b) => b === undefined ? Math.random()*a : a + Math.random()*(b-a);
const randi = (a, b) => Math.floor(rand(a, b));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp  = (a, b, t) => a + (b - a) * t;
const dist2 = (ax, ay, bx, by) => { const dx = bx-ax, dy = by-ay; return dx*dx + dy*dy; };
const len   = (x, y) => Math.hypot(x, y);

// ---------- Audio (WebAudio synth, no assets) ----------
const Audio = (() => {
  let ctx = null, master = null, muted = false, lastPlayed = {};
  const init = () => {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  };
  const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume(); };
  // throttle: don't play same sound more than every N ms
  const allow = (key, ms) => {
    const t = performance.now();
    if (lastPlayed[key] && t - lastPlayed[key] < ms) return false;
    lastPlayed[key] = t; return true;
  };
  const env = (gain, t0, attack, hold, release, peak = 1) => {
    gain.gain.cancelScheduledValues(t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.setValueAtTime(peak, t0 + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
  };
  const tone = (freq, dur, type='sine', peak=0.5, slideTo=null) => {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo != null) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    o.connect(g); g.connect(master);
    env(g, t, 0.005, Math.max(0, dur - 0.08), 0.07, peak);
    o.start(t); o.stop(t + dur + 0.08);
  };
  const noiseBurst = (dur, peak=0.5, filterFreq=1500, type='lowpass') => {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = filterFreq;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(master);
    env(g, t, 0.005, dur * 0.4, dur * 0.6, peak);
    src.start(t); src.stop(t + dur + 0.05);
  };
  return {
    init, resume,
    setMuted: v => { muted = v; if (master) master.gain.value = v ? 0 : 0.35; },
    isMuted: () => muted,
    sword:  () => allow('sword', 40)  && (tone(880, 0.07, 'square', 0.18, 1400), noiseBurst(0.06, 0.10, 3500, 'highpass')),
    bow:    () => allow('bow', 80)    && (tone(220, 0.10, 'triangle', 0.18, 660), noiseBurst(0.05, 0.08, 2000, 'highpass')),
    fire:   () => allow('fire', 80)   && (tone(180, 0.20, 'sawtooth', 0.22, 90), noiseBurst(0.18, 0.18, 800, 'lowpass')),
    pike:   () => allow('pike', 60)   && tone(520, 0.06, 'triangle', 0.14, 720),
    heal:   () => allow('heal', 80)   && (tone(660, 0.18, 'sine', 0.16, 990)),
    hit:    () => allow('hit', 25)    && noiseBurst(0.05, 0.18, 1200, 'lowpass'),
    death:  () => allow('death', 60)  && (tone(180, 0.22, 'sawtooth', 0.18, 70), noiseBurst(0.15, 0.10, 600, 'lowpass')),
    explode:() => allow('explode', 80)&& (tone(90, 0.30, 'sawtooth', 0.30, 40), noiseBurst(0.30, 0.25, 700, 'lowpass')),
    castle: () => allow('castle', 80) && (tone(70, 0.25, 'square', 0.25, 35), noiseBurst(0.20, 0.18, 500, 'lowpass')),
    coin:   () => allow('coin', 60)   && (tone(1320, 0.05, 'square', 0.10, 1980)),
    deny:   () => allow('deny', 60)   && tone(180, 0.10, 'square', 0.12, 90),
    siege:  () => allow('siege', 100) && (tone(110, 0.14, 'square', 0.20, 60)),
    knife:  () => allow('knife', 30)  && (tone(2200, 0.04, 'square', 0.10, 3300), noiseBurst(0.04, 0.08, 4500, 'highpass')),
    win:    () => {
      if (!ctx || muted) return;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.22), i * 90));
    },
  };
})();

// ---------- World constants ----------
const W = 1280, H = 720;
const GROUND_Y = 60;       // top edge of playable battlefield
const GROUND_H = H - 80;
const CASTLE_W = 70, CASTLE_H = 110;
const RED_CASTLE_X  = 40;
const BLUE_CASTLE_X = W - 40 - CASTLE_W;
const FRIEND_BAND   = 80;  // closest deploy distance to your castle
const MIDLINE_PAD   = 40;  // can't deploy past midline
const MAX_UNITS     = 220;

// ---------- Troop definitions ----------
// HP, dmg, range (px), speed (px/s), atkSpeed (atk/s), radius, color base, role
const TROOPS = {
  sword: {
    key:'sword', name:'Swordsman', cost:50, hp:90, dmg:14, range:22, speed:62,
    atkSpeed:1.2, r:11, role:'melee', kbResist:0.6,
    desc:'Cheap frontline. Strong vs Archers.',
  },
  archer: {
    key:'archer', name:'Archer', cost:80, hp:55, dmg:18, range:240, speed:55,
    atkSpeed:0.9, r:10, role:'ranged', projectile:'arrow', kbResist:0.4,
    desc:'Long range single target.',
  },
  knight: {
    key:'knight', name:'Knight', cost:150, hp:180, dmg:24, range:24, speed:95,
    atkSpeed:1.0, r:13, role:'melee', kbResist:0.8, charge:true,
    desc:'Fast bruiser. Charge bonus.',
  },
  pike: {
    key:'pike', name:'Pikeman', cost:100, hp:110, dmg:16, range:34, speed:55,
    atkSpeed:0.9, r:11, role:'melee', kbResist:0.7, antiCav:2.0,
    desc:'Bonus dmg vs Knights.',
  },
  mage: {
    key:'mage', name:'Mage', cost:180, hp:60, dmg:22, range:200, speed:50,
    atkSpeed:0.7, r:10, role:'ranged', projectile:'fireball', splash:38, kbResist:0.4,
    desc:'AoE fireballs.',
  },
  healer: {
    key:'healer', name:'Healer', cost:120, hp:70, dmg:0, range:90, speed:55,
    atkSpeed:1.4, r:10, role:'support', heal:10, kbResist:0.5,
    desc:'Heals nearby allies.',
  },
  giant: {
    key:'giant', name:'Giant', cost:300, hp:520, dmg:38, range:28, speed:38,
    atkSpeed:0.8, r:18, role:'melee', kbResist:0.95, splash:30,
    desc:'Massive HP. Slow stomper.',
  },
  assassin: {
    key:'assassin', name:'Assassin', cost:140, hp:60, dmg:55, range:22, speed:120,
    atkSpeed:1.6, r:9, role:'melee', kbResist:0.3, antiRanged:1.5,
    desc:'Fast striker. Bonus vs ranged.',
  },
  catapult: {
    key:'catapult', name:'Catapult', cost:260, hp:140, dmg:34, range:340, speed:24,
    atkSpeed:0.35, r:16, role:'ranged', projectile:'rock', splash:46, kbResist:0.9,
    siegeBonus:2.5,
    desc:'Long-range siege. 2.5× vs castles.',
  },
};
const TROOP_ORDER = ['sword','archer','knight','pike','mage','healer','giant','assassin','catapult'];
const HOTKEYS = {1:'sword',2:'archer',3:'knight',4:'pike',5:'mage',6:'healer',7:'giant',8:'assassin',9:'catapult'};

// ---------- Game state ----------
const state = {
  mode: 'vsAI',          // 'vsAI' | 'sandbox'
  playerSide: 'red',     // 'red' | 'blue'
  selected: 'sword',
  paused: false,
  over: false,
  winner: null,
  time: 0,               // seconds
  lastTime: performance.now(),
  units: [],
  projectiles: [],
  particles: [],
  damageText: [],
  red:  { gold: 200, castleHP: 1000, castleMaxHP: 1000, incomeBoost: 1 },
  blue: { gold: 200, castleHP: 1000, castleMaxHP: 1000, incomeBoost: 1 },
  goldRate: 28,          // gold per second baseline per side
  ai: { nextDecision: 1.5 },
};

// ---------- Canvas setup ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
function fitCanvas(){
  // Backing-store kept at logical size (1280x720); CSS scales to container.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== W * dpr || canvas.height !== H * dpr){
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

// ---------- Static background (cached) ----------
const bg = document.createElement('canvas');
bg.width = W; bg.height = H;
buildBackground();
function buildBackground(){
  const c = bg.getContext('2d');
  // Sky/horizon
  const sky = c.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#0b132b');
  sky.addColorStop(1, '#1d2a55');
  c.fillStyle = sky; c.fillRect(0, 0, W, GROUND_Y);

  // Distant mountains
  c.fillStyle = '#1a2348';
  c.beginPath();
  c.moveTo(0, GROUND_Y);
  for (let x = 0; x <= W; x += 40){
    const y = GROUND_Y - (Math.sin(x*0.011)*8 + Math.sin(x*0.027)*5 + 12);
    c.lineTo(x, y);
  }
  c.lineTo(W, GROUND_Y); c.closePath(); c.fill();

  // Battlefield grass
  const grass = c.createLinearGradient(0, GROUND_Y, 0, H);
  grass.addColorStop(0, '#1f3d24');
  grass.addColorStop(0.4, '#244a2c');
  grass.addColorStop(1, '#16321b');
  c.fillStyle = grass; c.fillRect(0, GROUND_Y, W, H - GROUND_Y);

  // Subtle hex/grid hint
  c.strokeStyle = 'rgba(255,255,255,0.025)';
  c.lineWidth = 1;
  for (let x = 0; x < W; x += 40){
    c.beginPath(); c.moveTo(x, GROUND_Y); c.lineTo(x, H); c.stroke();
  }
  for (let y = GROUND_Y; y < H; y += 40){
    c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
  }

  // Random tufts of grass / flowers (deterministic seed-ish)
  let s = 1234;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 220; i++){
    const x = rng() * W;
    const y = GROUND_Y + 20 + rng() * (H - GROUND_Y - 30);
    const tuftColor = rng() < 0.85 ? 'rgba(60,120,55,0.55)' : (rng() < 0.5 ? 'rgba(255,220,120,0.7)' : 'rgba(220,120,170,0.7)');
    c.fillStyle = tuftColor;
    c.beginPath(); c.ellipse(x, y, 2 + rng()*1.4, 1, 0, 0, TAU); c.fill();
  }

  // Path of trodden ground
  c.fillStyle = 'rgba(0,0,0,0.10)';
  c.beginPath();
  c.ellipse(W/2, H/2 + 30, W*0.42, 70, 0, 0, TAU);
  c.fill();

  // Midline marker
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.setLineDash([8, 8]);
  c.beginPath(); c.moveTo(W/2, GROUND_Y + 6); c.lineTo(W/2, H - 10); c.stroke();
  c.setLineDash([]);
}

// ---------- Castle drawing (cached per side) ----------
const castleCanvas = {};
for (const side of ['red','blue']){
  const cc = document.createElement('canvas');
  cc.width = CASTLE_W + 20; cc.height = CASTLE_H + 30;
  drawCastleSprite(cc.getContext('2d'), side);
  castleCanvas[side] = cc;
}
function drawCastleSprite(c, side){
  const x = 10, y = 20;
  const main = side === 'red' ? '#5a1a1a' : '#1a2c5a';
  const stone = '#3d3d44';
  const stoneL = '#5a5a64';
  // Main keep
  c.fillStyle = stone;
  c.fillRect(x, y, CASTLE_W, CASTLE_H);
  // Stone blocks
  c.fillStyle = stoneL;
  for (let by = 0; by < CASTLE_H; by += 12){
    for (let bx = 0; bx < CASTLE_W; bx += 18){
      const off = (by/12) % 2 ? 9 : 0;
      c.fillRect(x + bx + off, y + by, 16, 10);
    }
  }
  // Battlements
  for (let i = 0; i < 4; i++){
    c.fillStyle = stone;
    c.fillRect(x + i * 18, y - 8, 12, 10);
  }
  // Banner
  c.fillStyle = main;
  c.fillRect(x + CASTLE_W/2 - 8, y + 16, 16, 40);
  c.beginPath();
  c.moveTo(x + CASTLE_W/2 - 8, y + 56);
  c.lineTo(x + CASTLE_W/2,     y + 50);
  c.lineTo(x + CASTLE_W/2 + 8, y + 56);
  c.closePath(); c.fill();
  // Door
  c.fillStyle = '#2a1b10';
  c.fillRect(x + CASTLE_W/2 - 9, y + CASTLE_H - 28, 18, 28);
  c.strokeStyle = '#191008'; c.lineWidth = 2;
  c.strokeRect(x + CASTLE_W/2 - 9, y + CASTLE_H - 28, 18, 28);
  // Flagpole
  c.fillStyle = '#7a5a2a';
  c.fillRect(x + CASTLE_W/2 - 1, y - 22, 2, 16);
  c.fillStyle = main;
  c.beginPath();
  c.moveTo(x + CASTLE_W/2 + 1, y - 22);
  c.lineTo(x + CASTLE_W/2 + 14, y - 18);
  c.lineTo(x + CASTLE_W/2 + 1, y - 12);
  c.closePath(); c.fill();
}

// ---------- Roster UI ----------
const redRoster = document.getElementById('redRoster');
const blueRoster = document.getElementById('blueRoster');
function buildRoster(container, side){
  container.innerHTML = '';
  TROOP_ORDER.forEach((key, idx) => {
    const t = TROOPS[key];
    const el = document.createElement('div');
    el.className = 'troop';
    el.dataset.key = key;
    el.dataset.side = side;
    el.innerHTML = `
      <span class="hot">${idx+1}</span>
      <canvas class="icon" width="38" height="38" aria-hidden="true"></canvas>
      <div class="name">${t.name}</div>
      <div class="cost">${t.cost}g</div>
    `;
    el.title = `${t.name} — ${t.desc}\nHP ${t.hp} • DMG ${t.dmg} • RNG ${t.range}`;
    drawTroopIcon(el.querySelector('canvas').getContext('2d'), key, side);
    el.addEventListener('click', () => {
      if (!isPlayerSide(side)) return;
      state.selected = key;
      updateSelectedHighlight();
    });
    container.appendChild(el);
  });
}
function isPlayerSide(side){
  if (state.mode === 'sandbox') return true;
  return state.playerSide === side;
}
function updateSelectedHighlight(){
  document.querySelectorAll('.troop').forEach(el => {
    const sideOK = isPlayerSide(el.dataset.side);
    el.classList.toggle('disabled', !sideOK);
    el.classList.toggle('selected', sideOK && el.dataset.key === state.selected);
  });
}
buildRoster(redRoster, 'red');
buildRoster(blueRoster, 'blue');
updateSelectedHighlight();

// ---------- Troop icons ----------
function drawTroopIcon(c, key, side){
  c.clearRect(0,0,38,38);
  const body = side === 'red' ? '#ef4444' : '#3b82f6';
  const dark = side === 'red' ? '#7f1d1d' : '#1e3a8a';
  // base shadow
  c.fillStyle = 'rgba(0,0,0,.35)';
  c.beginPath(); c.ellipse(19, 33, 10, 2.5, 0, 0, TAU); c.fill();
  // body
  c.fillStyle = body;
  c.beginPath(); c.arc(19, 22, 8, 0, TAU); c.fill();
  c.fillStyle = dark; c.beginPath(); c.arc(19, 22, 8, 0, TAU); c.stroke();
  // head
  c.fillStyle = '#f5d0a9';
  c.beginPath(); c.arc(19, 12, 5, 0, TAU); c.fill();

  // weapon / accessory
  c.strokeStyle = '#cbd5e1'; c.lineWidth = 2;
  c.fillStyle = '#cbd5e1';
  switch(key){
    case 'sword':
      c.beginPath(); c.moveTo(28, 8); c.lineTo(32, 22); c.stroke();
      c.fillStyle = '#94a3b8'; c.fillRect(26, 6, 2, 6); break;
    case 'archer':
      c.strokeStyle = '#a3704b'; c.lineWidth = 2;
      c.beginPath(); c.arc(30, 18, 7, -1.0, 1.0); c.stroke();
      c.strokeStyle = '#e2e8f0';
      c.beginPath(); c.moveTo(30, 11); c.lineTo(30, 25); c.stroke(); break;
    case 'knight':
      c.fillStyle = '#cbd5e1';
      c.fillRect(8, 20, 22, 4); // lance
      c.fillStyle = '#7f8aa8'; c.fillRect(12, 9, 14, 6); break; // helm
    case 'pike':
      c.strokeStyle = '#94a3b8'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(32, 4); c.lineTo(8, 30); c.stroke();
      c.fillStyle = '#cbd5e1';
      c.beginPath(); c.moveTo(32,4); c.lineTo(28,4); c.lineTo(30,8); c.closePath(); c.fill(); break;
    case 'mage':
      c.fillStyle = '#facc15';
      c.beginPath(); c.arc(28, 14, 4, 0, TAU); c.fill();
      c.strokeStyle = '#7c5cff'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(28, 14); c.lineTo(20, 22); c.stroke();
      c.fillStyle = '#7c5cff';
      c.beginPath(); c.moveTo(15, 5); c.lineTo(23, 5); c.lineTo(19, 12); c.closePath(); c.fill(); break;
    case 'healer':
      c.fillStyle = '#fff';
      c.fillRect(15, 18, 8, 2); c.fillRect(18, 15, 2, 8); break;
    case 'giant':
      c.clearRect(0,0,38,38);
      c.fillStyle = 'rgba(0,0,0,.35)';
      c.beginPath(); c.ellipse(19, 34, 13, 3, 0, 0, TAU); c.fill();
      c.fillStyle = body; c.beginPath(); c.arc(19, 22, 11, 0, TAU); c.fill();
      c.fillStyle = '#f5d0a9'; c.beginPath(); c.arc(19, 9, 6, 0, TAU); c.fill();
      c.strokeStyle = '#cbd5e1'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(7, 22); c.lineTo(31, 22); c.stroke(); break;
    case 'assassin':
      // dark hood
      c.fillStyle = '#111827';
      c.beginPath(); c.arc(19, 11, 6, Math.PI, TAU); c.fill();
      c.fillStyle = '#1f2937';
      c.beginPath(); c.moveTo(13, 12); c.lineTo(25, 12); c.lineTo(23, 18); c.lineTo(15, 18); c.closePath(); c.fill();
      // dual daggers
      c.strokeStyle = '#e2e8f0'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(11, 18); c.lineTo(8, 26); c.stroke();
      c.beginPath(); c.moveTo(27, 18); c.lineTo(30, 26); c.stroke(); break;
    case 'catapult':
      c.clearRect(0,0,38,38);
      c.fillStyle = 'rgba(0,0,0,.35)';
      c.beginPath(); c.ellipse(19, 33, 14, 3, 0, 0, TAU); c.fill();
      // wheels
      c.fillStyle = '#3a2a1a';
      c.beginPath(); c.arc(11, 28, 4, 0, TAU); c.fill();
      c.beginPath(); c.arc(27, 28, 4, 0, TAU); c.fill();
      // chassis
      c.fillStyle = '#7a5a2a';
      c.fillRect(8, 22, 22, 5);
      // arm
      c.strokeStyle = '#a78140'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(11, 24); c.lineTo(28, 10); c.stroke();
      // payload
      c.fillStyle = '#94a3b8';
      c.beginPath(); c.arc(28, 10, 3.5, 0, TAU); c.fill();
      // banner color
      c.fillStyle = body;
      c.fillRect(18, 18, 3, 5); break;
  }
}

// ---------- Unit class (lightweight object, not class for perf) ----------
function makeUnit(key, side, x, y){
  const T = TROOPS[key];
  return {
    key, side,
    x, y,
    vx: 0, vy: 0,
    hp: T.hp, maxHp: T.hp,
    cd: rand(0, 0.6),
    target: null,
    targetCastle: false,
    facing: side === 'red' ? 1 : -1,
    walkPhase: rand(0, TAU),
    flash: 0,
    chargeBoost: T.charge ? 1.0 : 0,
    alive: true,
    hitFlash: 0,
    isUnit: true,
    bornAt: state.time,
  };
}

// ---------- Spawning ----------
function tryDeploy(side, key, x, y){
  const sideState = state[side];
  const T = TROOPS[key];
  if (!T || sideState.gold < T.cost || state.over) return false;
  // Validate position
  if (y < GROUND_Y + 18 || y > H - 16) return false;
  if (side === 'red' && x > W/2 - MIDLINE_PAD) return false;
  if (side === 'blue' && x < W/2 + MIDLINE_PAD) return false;
  if (side === 'red' && x < RED_CASTLE_X + CASTLE_W + 6) return false;
  if (side === 'blue' && x > BLUE_CASTLE_X - 6) return false;
  if (state.units.length >= MAX_UNITS) return false;

  sideState.gold -= T.cost;
  state.units.push(makeUnit(key, side, x, y));
  spawnPuff(x, y, side);
  Audio.coin();
  return true;
}

function spawnPuff(x, y, side){
  const color = side === 'red' ? '#fca5a5' : '#93c5fd';
  for (let i = 0; i < 14; i++){
    const a = Math.random() * TAU;
    state.particles.push({
      x, y, vx: Math.cos(a)*rand(20, 70), vy: Math.sin(a)*rand(20, 70) - 30,
      life: 0.6, max: 0.6, color, size: rand(2, 3.5), gravity: 60,
    });
  }
}

// ---------- AI ----------
function aiTick(dt){
  if (state.mode !== 'vsAI' || state.over) return;
  state.ai.nextDecision -= dt;
  if (state.ai.nextDecision > 0) return;
  state.ai.nextDecision = rand(0.8, 1.6);

  const side = state.playerSide === 'red' ? 'blue' : 'red';
  const me = state[side];

  // Count own units to bias towards composition
  let melee = 0, ranged = 0, support = 0;
  for (const u of state.units){
    if (u.side !== side) continue;
    const T = TROOPS[u.key];
    if (T.role === 'melee') melee++;
    else if (T.role === 'ranged') ranged++;
    else support++;
  }
  // Survey enemy
  let enemyCount = 0, enemyMelee = 0, enemyRanged = 0;
  for (const u of state.units){
    if (u.side === side) continue;
    enemyCount++;
    const T = TROOPS[u.key];
    if (T.role === 'melee') enemyMelee++;
    else if (T.role === 'ranged') enemyRanged++;
  }

  // Choose what to spawn based on simple heuristics + budget
  const choices = [];
  const wantTank = melee < 3;
  if (wantTank) choices.push(['sword', 4]);
  if (enemyMelee >= 3) choices.push(['archer', 3], ['mage', 2]);
  if (enemyRanged >= 2) choices.push(['knight', 3], ['sword', 2]);
  if (melee >= 3 && support === 0) choices.push(['healer', 2]);
  if (me.gold >= 300 && Math.random() < 0.4) choices.push(['giant', 2]);
  if (me.gold >= 260 && Math.random() < 0.5) choices.push(['catapult', 2]);
  if (enemyRanged >= 2 && Math.random() < 0.6) choices.push(['assassin', 3]);
  choices.push(['pike', 2], ['archer', 2], ['knight', 1], ['assassin', 1], ['catapult', 1]);

  // Weighted random
  let total = 0;
  for (const [, w] of choices) total += w;
  let r = Math.random() * total;
  let pick = 'sword';
  for (const [k, w] of choices){ if ((r -= w) <= 0){ pick = k; break; } }

  const T = TROOPS[pick];
  if (me.gold < T.cost) return;

  // Position: along blue side, vary Y, bias towards engaging
  const x = side === 'red'
    ? rand(RED_CASTLE_X + CASTLE_W + 30, RED_CASTLE_X + CASTLE_W + 120)
    : rand(BLUE_CASTLE_X - 120, BLUE_CASTLE_X - 30);
  const y = rand(GROUND_Y + 40, H - 30);
  tryDeploy(side, pick, x, y);
}

// ---------- Combat / movement ----------
function update(dt){
  // Income
  state.red.gold  += state.goldRate * dt * state.red.incomeBoost;
  state.blue.gold += state.goldRate * dt * state.blue.incomeBoost;
  state.red.gold  = Math.min(state.red.gold,  600);
  state.blue.gold = Math.min(state.blue.gold, 600);

  aiTick(dt);

  // Build spatial grid for unit lookup
  const cell = 60;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const grid = new Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = null;
  const idx = (x, y) => {
    const cx = clamp(Math.floor(x / cell), 0, cols-1);
    const cy = clamp(Math.floor(y / cell), 0, rows-1);
    return cy * cols + cx;
  };
  for (const u of state.units){
    if (!u.alive) continue;
    const i = idx(u.x, u.y);
    if (!grid[i]) grid[i] = [];
    grid[i].push(u);
  }
  function neighbors(x, y, radCells = 1){
    const cx = clamp(Math.floor(x / cell), 0, cols-1);
    const cy = clamp(Math.floor(y / cell), 0, rows-1);
    const out = [];
    for (let yy = cy - radCells; yy <= cy + radCells; yy++){
      if (yy < 0 || yy >= rows) continue;
      for (let xx = cx - radCells; xx <= cx + radCells; xx++){
        if (xx < 0 || xx >= cols) continue;
        const arr = grid[yy * cols + xx];
        if (arr) for (const u of arr) out.push(u);
      }
    }
    return out;
  }

  // Per-unit AI / movement
  for (const u of state.units){
    if (!u.alive) continue;
    const T = TROOPS[u.key];

    // --- Acquire target ---
    // Healers seek wounded allies; others seek nearest enemy in vision
    let target = null, targetD2 = Infinity, targetCastle = false;
    if (T.role === 'support'){
      const visR = T.range * 1.4;
      const cellsR = Math.max(1, Math.ceil(visR / cell));
      for (const o of neighbors(u.x, u.y, cellsR)){
        if (!o.alive || o === u || o.side !== u.side) continue;
        if (o.hp >= o.maxHp - 0.1) continue;
        const d2 = dist2(u.x, u.y, o.x, o.y);
        if (d2 < targetD2){ targetD2 = d2; target = o; }
      }
    } else {
      const visR = Math.max(T.range * 2 + 80, 220);
      const cellsR = Math.max(2, Math.ceil(visR / cell));
      for (const o of neighbors(u.x, u.y, cellsR)){
        if (!o.alive || o.side === u.side) continue;
        const d2 = dist2(u.x, u.y, o.x, o.y);
        if (d2 < targetD2){ targetD2 = d2; target = o; }
      }
      // Siege units: prefer castle when in range
      if (u.key === 'catapult'){
        const enemySide = u.side === 'red' ? 'blue' : 'red';
        const cx = enemySide === 'red' ? RED_CASTLE_X + CASTLE_W/2 : BLUE_CASTLE_X + CASTLE_W/2;
        if (Math.abs(u.x - cx) < T.range){
          target = { x: cx, y: H/2, isUnit: false, isCastle: true, side: enemySide };
          targetCastle = true;
        }
      }
    }
    // If no enemy near & not support, march toward enemy castle
    if (!target && T.role !== 'support'){
      const cx = u.side === 'red' ? BLUE_CASTLE_X + CASTLE_W/2 : RED_CASTLE_X + CASTLE_W/2;
      const cy = H/2;
      target = { x: cx, y: cy, isUnit: false, isCastle: true, side: u.side === 'red' ? 'blue' : 'red' };
      targetCastle = true;
    } else if (!target && T.role === 'support'){
      // healer wanders behind line
      const cx = u.side === 'red' ? RED_CASTLE_X + CASTLE_W + 90 : BLUE_CASTLE_X - 90;
      target = { x: cx, y: u.y, isUnit: false, isCastle: false };
    }
    u.target = target;
    u.targetCastle = targetCastle;

    // --- Move / attack ---
    const dx = target.x - u.x;
    const dy = target.y - u.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    const desiredRange = T.role === 'support' ? Math.min(T.range * 0.6, 50) : T.range;

    let move = true;
    if (target.isUnit && d <= desiredRange + 1){
      move = false;
      u.cd -= dt;
      if (u.cd <= 0){
        attack(u, target);
        u.cd = 1 / T.atkSpeed;
      }
    } else if (target.isCastle){
      const cdx = u.side === 'red' ? BLUE_CASTLE_X : RED_CASTLE_X + CASTLE_W;
      const reach = Math.abs(u.x - cdx);
      if (reach <= desiredRange + 4){
        move = false;
        u.cd -= dt;
        if (u.cd <= 0){
          attackCastle(u);
          u.cd = 1 / T.atkSpeed;
        }
      }
    }

    if (move){
      let speed = T.speed;
      // Knight charge: speed boost when far from contact
      if (T.charge && d > 100) speed *= 1.25;
      const nx = dx / d, ny = dy / d;
      u.vx = nx * speed; u.vy = ny * speed;
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      u.facing = nx >= 0 ? 1 : -1;
      u.walkPhase += dt * 8;
    } else {
      u.vx *= 0.85; u.vy *= 0.85;
      u.x += u.vx * dt; u.y += u.vy * dt;
    }

    // Bounds
    u.y = clamp(u.y, GROUND_Y + 12, H - 12);
    u.x = clamp(u.x, RED_CASTLE_X + CASTLE_W + 4, BLUE_CASTLE_X - 4);

    // Decay flash
    if (u.hitFlash > 0) u.hitFlash = Math.max(0, u.hitFlash - dt * 4);
  }

  // Soft separation between units (avoid overlap stacks)
  for (let i = 0; i < state.units.length; i++){
    const a = state.units[i];
    if (!a.alive) continue;
    const Ta = TROOPS[a.key];
    const near = neighbors(a.x, a.y, 1);
    for (const b of near){
      if (b === a || !b.alive) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx*dx + dy*dy;
      const minD = Ta.r + TROOPS[b.key].r;
      if (d2 > 0 && d2 < minD * minD){
        const d = Math.sqrt(d2);
        const overlap = (minD - d) * 0.5;
        const ux = dx / d, uy = dy / d;
        // friendlies push gently, enemies less (they want to engage)
        const k = a.side === b.side ? 0.9 : 0.35;
        a.x -= ux * overlap * k;
        a.y -= uy * overlap * k;
        b.x += ux * overlap * k;
        b.y += uy * overlap * k;
      }
    }
  }

  // Heal effect (support attack = heal pulse)
  // Cleanup dead
  for (let i = state.units.length - 1; i >= 0; i--){
    const u = state.units[i];
    if (!u.alive){
      spawnDeath(u);
      state.units.splice(i, 1);
    }
  }

  // --- Projectiles ---
  for (let i = state.projectiles.length - 1; i >= 0; i--){
    const p = state.projectiles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === 'arrow'){
      // gravity arc just for visual
      p.vy += 80 * dt;
    } else if (p.kind === 'rock'){
      p.vy += 240 * dt;
      if (Math.random() < 0.3){
        state.particles.push({
          x: p.x, y: p.y, vx: rand(-10,10), vy: rand(-10,10),
          life: 0.4, max:0.4, color: '#9ca3af', size: 1.6, gravity: 0,
        });
      }
    } else if (p.kind === 'fireball'){
      // small wobble
      p.spin = (p.spin || 0) + dt * 12;
      // trail particles
      if (Math.random() < 0.8){
        state.particles.push({
          x: p.x, y: p.y, vx: rand(-15,15), vy: rand(-15,15),
          life: 0.35, max: 0.35, color: '#ffb142', size: 2.5, gravity: 0,
        });
      }
    }

    let hit = false;
    if (p.targetId != null){
      const tg = state.units.find(uu => uu.uid === p.targetId);
      if (tg && tg.alive){
        const T = TROOPS[tg.key];
        if (dist2(p.x, p.y, tg.x, tg.y) <= (T.r + 4) * (T.r + 4)){
          applyDamage(p.owner, tg, p.dmg, p);
          hit = true;
        }
      }
    } else {
      // Targeting castle
      if (p.targetCastleSide){
        const side = p.targetCastleSide;
        const cx = side === 'red' ? RED_CASTLE_X : BLUE_CASTLE_X;
        if (p.x >= cx && p.x <= cx + CASTLE_W && p.y >= H/2 - CASTLE_H/2 && p.y <= H/2 + CASTLE_H/2){
          damageCastle(p.owner, side, p.dmg * (p.siegeBonus || 1));
          hit = true;
        }
      }
    }

    if (hit){
      if (p.kind === 'fireball'){
        explode(p.x, p.y, p.splash || 36, p.dmg * 0.6, p.owner);
      }
      state.projectiles.splice(i, 1);
    } else if (p.life <= 0 || p.x < -20 || p.x > W+20 || p.y < -20 || p.y > H+20){
      if (p.kind === 'fireball'){
        explode(p.x, p.y, p.splash || 36, p.dmg * 0.4, p.owner);
      }
      state.projectiles.splice(i, 1);
    }
  }

  // --- Particles ---
  for (let i = state.particles.length - 1; i >= 0; i--){
    const p = state.particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += (p.gravity || 0) * dt;
    if (p.life <= 0){ state.particles.splice(i,1); }
  }
  for (let i = state.damageText.length - 1; i >= 0; i--){
    const d = state.damageText[i];
    d.life -= dt; d.y -= dt * 18;
    if (d.life <= 0) state.damageText.splice(i,1);
  }

  // Win check
  if (!state.over){
    if (state.red.castleHP <= 0){ endGame('blue'); }
    else if (state.blue.castleHP <= 0){ endGame('red'); }
  }
}

// Assign unique ids on the fly
let UID = 1;
function ensureUid(u){ if (u.uid == null) u.uid = UID++; return u.uid; }

function attack(attacker, target){
  const T = TROOPS[attacker.key];
  ensureUid(target);
  if (T.role === 'support'){
    // Heal pulse
    const heal = T.heal;
    target.hp = Math.min(target.maxHp, target.hp + heal);
    Audio.heal();
    state.particles.push({
      x: target.x, y: target.y - 14, vx: 0, vy: -20,
      life: 0.5, max: 0.5, color: '#86efac', size: 4, gravity: 0,
    });
    state.damageText.push({ x: target.x, y: target.y - 16, text: '+'+heal, color:'#86efac', life:0.7 });
    // Healer "pulse" ring
    state.particles.push({
      x: attacker.x, y: attacker.y, vx:0, vy:0, life:0.4, max:0.4,
      color:'#86efac', size: 6, ring:true, gravity:0, radius: 8, growTo: 60,
    });
    return;
  }
  if (T.range > 60){
    // Ranged: spawn projectile aimed at target predicted pos
    fireProjectile(attacker, target);
    if (T.projectile === 'fireball') Audio.fire();
    else if (T.projectile === 'rock') Audio.siege();
    else if (T.projectile === 'knife') Audio.knife();
    else Audio.bow();
  } else {
    // Melee: instant hit, slight knockback animation
    let dmg = T.dmg;
    const Tt = TROOPS[target.key];
    if (T.antiCav && Tt && Tt.charge) dmg *= T.antiCav;
    if (T.antiRanged && Tt && Tt.role === 'ranged') dmg *= T.antiRanged;
    if (T.charge && attacker.chargeBoost > 0){
      dmg *= 1 + attacker.chargeBoost;
      attacker.chargeBoost = 0;
    }
    applyDamage(attacker, target, dmg);
    if (attacker.key === 'pike') Audio.pike();
    else if (attacker.key === 'sword') Audio.sword();
    else if (attacker.key === 'knight') Audio.sword();
    else Audio.hit();
    if (T.splash){
      explode(target.x, target.y, T.splash, T.dmg * 0.5, attacker);
    }
    // Slash particles
    const ang = Math.atan2(target.y - attacker.y, target.x - attacker.x);
    for (let i = 0; i < 5; i++){
      const a = ang + rand(-0.3, 0.3);
      state.particles.push({
        x: target.x, y: target.y, vx: Math.cos(a)*rand(40,90), vy: Math.sin(a)*rand(40,90),
        life: 0.35, max: 0.35, color: '#ffffff', size: 1.6, gravity: 80,
      });
    }
  }
  attacker.flash = 0.12;
}

function attackCastle(u){
  const T = TROOPS[u.key];
  const side = u.side === 'red' ? 'blue' : 'red';
  if (T.range > 60){
    fireProjectileAtCastle(u, side);
    if (T.projectile === 'fireball') Audio.fire();
    else if (T.projectile === 'rock') Audio.siege();
    else Audio.bow();
  } else {
    damageCastle(u, side, T.dmg * (T.siegeBonus || 1));
    Audio.castle();
    // dust
    const cx = side === 'red' ? RED_CASTLE_X + CASTLE_W : BLUE_CASTLE_X;
    for (let i = 0; i < 6; i++){
      state.particles.push({
        x: cx + rand(-4,4), y: H/2 + rand(-CASTLE_H/2, CASTLE_H/2), vx: rand(-30,30), vy: rand(-60,-10),
        life: 0.6, max: 0.6, color:'#cbd5e1', size: 2, gravity: 90,
      });
    }
  }
  u.flash = 0.12;
}

function fireProjectile(owner, target){
  const T = TROOPS[owner.key];
  ensureUid(target);
  // lead the target slightly
  const dx = target.x - owner.x;
  const dy = target.y - owner.y - 6;
  const d = Math.hypot(dx, dy) || 1;
  let speed = 360, life = 1.4, kind = 'arrow';
  if (T.projectile === 'fireball'){ speed = 280; life = 1.6; kind = 'fireball'; }
  else if (T.projectile === 'rock'){ speed = 220; life = 2.4; kind = 'rock'; }
  else if (T.projectile === 'knife'){ speed = 480; life = 0.8; kind = 'knife'; }
  const vx = dx / d * speed;
  // arrows/rocks arc: subtract some vy to lift
  const liftMap = { arrow: 60, rock: 220, fireball: 0, knife: 0 };
  const vy = dy / d * speed - (liftMap[kind] || 0);
  state.projectiles.push({
    x: owner.x, y: owner.y - 8, vx, vy,
    dmg: T.dmg, life, kind,
    owner, targetId: target.uid,
    splash: T.splash || 0, color: kind === 'fireball' ? '#ff7a18' : '#f1f5f9',
    siegeBonus: T.siegeBonus || 1,
  });
}
function fireProjectileAtCastle(owner, side){
  const T = TROOPS[owner.key];
  const tx = side === 'red' ? RED_CASTLE_X + CASTLE_W/2 : BLUE_CASTLE_X + CASTLE_W/2;
  const ty = H/2;
  const dx = tx - owner.x, dy = ty - owner.y - 6;
  const d = Math.hypot(dx, dy) || 1;
  let speed = 360, life = 2, kind = 'arrow';
  if (T.projectile === 'fireball'){ speed = 280; life = 2; kind = 'fireball'; }
  else if (T.projectile === 'rock'){ speed = 220; life = 3; kind = 'rock'; }
  const vx = dx / d * speed;
  const liftMap = { arrow: 60, rock: 240, fireball: 0, knife: 0 };
  const vy = dy / d * speed - (liftMap[kind] || 0);
  state.projectiles.push({
    x: owner.x, y: owner.y - 8, vx, vy,
    dmg: T.dmg, life, kind,
    owner, targetCastleSide: side, splash: T.splash || 0,
    color: kind === 'fireball' ? '#ff7a18' : '#f1f5f9',
    siegeBonus: T.siegeBonus || 1,
  });
}

function applyDamage(attacker, target, dmg, p){
  if (!target.alive) return;
  target.hp -= dmg;
  target.hitFlash = 1;
  // small knockback
  const T = TROOPS[target.key];
  const dx = target.x - (p ? p.x : attacker.x);
  const dy = target.y - (p ? p.y : attacker.y);
  const d = Math.hypot(dx, dy) || 1;
  const k = (1 - T.kbResist) * 14;
  target.x += (dx / d) * k;
  target.y += (dy / d) * k * 0.6;
  state.damageText.push({ x: target.x, y: target.y - 12, text: Math.round(dmg)+'', color:'#fff', life:0.55 });
  if (target.hp <= 0){
    target.alive = false;
  }
}

function explode(x, y, radius, dmg, owner){
  Audio.explode();
  for (const u of state.units){
    if (!u.alive || u.side === owner.side) continue;
    if (dist2(x, y, u.x, u.y) <= radius * radius){
      applyDamage(owner, u, dmg);
    }
  }
  for (let i = 0; i < 18; i++){
    const a = Math.random() * TAU;
    const sp = rand(40, 160);
    state.particles.push({
      x, y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp,
      life: 0.5, max: 0.5, color: i % 2 ? '#ffd166' : '#ff5a3a', size: rand(2, 4), gravity: 50,
    });
  }
  state.particles.push({
    x, y, vx:0, vy:0, life:0.45, max:0.45, color:'#ffd166',
    size: 6, ring:true, gravity:0, radius: 4, growTo: radius,
  });
}

function spawnDeath(u){
  Audio.death();
  const color = u.side === 'red' ? '#ef4444' : '#3b82f6';
  for (let i = 0; i < 16; i++){
    const a = Math.random() * TAU;
    const sp = rand(30, 120);
    state.particles.push({
      x: u.x, y: u.y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp - 30,
      life: 0.7, max: 0.7, color, size: rand(2, 3.5), gravity: 120,
    });
  }
  state.damageText.push({ x: u.x, y: u.y - 20, text:'✖', color, life:0.6 });
}

function damageCastle(attacker, side, dmg){
  const cs = state[side];
  cs.castleHP = Math.max(0, cs.castleHP - dmg);
  // shake + dust at door
  const cx = side === 'red' ? RED_CASTLE_X + CASTLE_W : BLUE_CASTLE_X;
  for (let i = 0; i < 4; i++){
    state.particles.push({
      x: cx + rand(-8,8), y: H/2 + rand(-CASTLE_H/2, CASTLE_H/2),
      vx: rand(-20, 20), vy: rand(-40, -10),
      life: 0.5, max:0.5, color:'#cbd5e1', size: 2, gravity: 80,
    });
  }
  state.damageText.push({ x: cx, y: H/2 - 30, text:'-'+Math.round(dmg), color:'#ffb4b4', life:0.6 });
  shakeAmount = Math.min(8, shakeAmount + Math.min(2, dmg / 10));
}

let shakeAmount = 0;

function endGame(winner){
  state.over = true;
  state.winner = winner;
  Audio.win();
  const banner = document.getElementById('banner');
  banner.textContent = (winner === 'red' ? 'Red' : 'Blue') + ' wins!';
  banner.classList.remove('red','blue');
  banner.classList.add('show', winner);
  // Confetti / fireworks
  for (let i = 0; i < 80; i++){
    state.particles.push({
      x: rand(W*0.3, W*0.7), y: rand(H*0.2, H*0.5),
      vx: rand(-160,160), vy: rand(-220, -40),
      life: rand(1.2, 1.8), max: 1.8,
      color: ['#fde68a','#fca5a5','#93c5fd','#86efac','#f0abfc'][randi(0,5)],
      size: rand(2, 4), gravity: 220,
    });
  }
}

// ---------- Rendering ----------
function render(){
  fitCanvas();

  // Camera shake
  let sx = 0, sy = 0;
  if (shakeAmount > 0){
    sx = (Math.random() - 0.5) * shakeAmount;
    sy = (Math.random() - 0.5) * shakeAmount;
    shakeAmount = Math.max(0, shakeAmount - 0.5);
  }
  ctx.save();
  ctx.translate(sx, sy);

  // Background
  ctx.drawImage(bg, 0, 0);

  // Castles
  drawCastle('red');
  drawCastle('blue');

  // Sort units by Y for crude depth
  const sorted = state.units.slice().sort((a, b) => a.y - b.y);
  for (const u of sorted) drawUnit(u);

  // Projectiles
  for (const p of state.projectiles) drawProjectile(p);

  // Particles
  for (const p of state.particles) drawParticle(p);

  // Damage text
  ctx.font = 'bold 14px Inter, system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const d of state.damageText){
    const a = clamp(d.life * 1.6, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = d.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeText(d.text, d.x, d.y);
    ctx.fillText(d.text, d.x, d.y);
  }
  ctx.globalAlpha = 1;

  // Deploy preview
  drawDeployPreview();

  ctx.restore();

  // Top-bar HP/gold
  const rHP = state.red.castleHP / state.red.castleMaxHP;
  const bHP = state.blue.castleHP / state.blue.castleMaxHP;
  document.getElementById('redHP').style.width  = (rHP * 100) + '%';
  document.getElementById('blueHP').style.width = (bHP * 100) + '%';
  document.getElementById('redGold').textContent  = Math.floor(state.red.gold);
  document.getElementById('blueGold').textContent = Math.floor(state.blue.gold);

  // Disable troops we can't afford
  document.querySelectorAll('.troop').forEach(el => {
    const T = TROOPS[el.dataset.key];
    const sideOK = isPlayerSide(el.dataset.side);
    const canAfford = state[el.dataset.side].gold >= T.cost;
    el.classList.toggle('disabled', !sideOK || !canAfford || state.over);
  });
}

function drawCastle(side){
  const x = side === 'red' ? RED_CASTLE_X - 10 : BLUE_CASTLE_X - 10;
  const y = H/2 - CASTLE_H/2 - 20;
  ctx.save();
  if (side === 'blue'){
    // Mirror banner orientation
    ctx.translate(x + CASTLE_W + 20, y);
    ctx.scale(-1, 1);
    ctx.drawImage(castleCanvas[side], 0, 0);
  } else {
    ctx.drawImage(castleCanvas[side], x, y);
  }
  ctx.restore();

  // Castle HP arc above castle
  const cx = side === 'red' ? RED_CASTLE_X + CASTLE_W/2 : BLUE_CASTLE_X + CASTLE_W/2;
  const cy = H/2 - CASTLE_H/2 - 30;
  const w = 80, h = 6;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(cx - w/2 - 1, cy - 1, w + 2, h + 2);
  const ratio = clamp(state[side].castleHP / state[side].castleMaxHP, 0, 1);
  const grad = ctx.createLinearGradient(cx - w/2, cy, cx + w/2, cy);
  if (side === 'red'){ grad.addColorStop(0,'#fca5a5'); grad.addColorStop(1,'#7f1d1d'); }
  else { grad.addColorStop(0,'#93c5fd'); grad.addColorStop(1,'#1e3a8a'); }
  ctx.fillStyle = grad;
  ctx.fillRect(cx - w/2, cy, w * ratio, h);
}

function drawUnit(u){
  const T = TROOPS[u.key];
  const body = u.side === 'red' ? '#ef4444' : '#3b82f6';
  const dark = u.side === 'red' ? '#7f1d1d' : '#1e3a8a';

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(u.x, u.y + T.r * 0.95, T.r * 1.1, T.r * 0.4, 0, 0, TAU);
  ctx.fill();

  // Walk bob
  const moving = (u.vx*u.vx + u.vy*u.vy) > 25;
  const bob = (u.key === 'catapult') ? 0 : (moving ? Math.sin(u.walkPhase) * 1.6 : 0);

  ctx.save();
  ctx.translate(u.x, u.y + bob);

  const fl = u.hitFlash;

  if (u.key !== 'catapult'){
    // Standard humanoid: body + head
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, -T.r * 0.6, T.r * 0.85, 0, TAU); ctx.fill();
    ctx.fillStyle = dark; ctx.lineWidth = 2;
    ctx.strokeStyle = dark;
    ctx.beginPath(); ctx.arc(0, -T.r * 0.6, T.r * 0.85, 0, TAU); ctx.stroke();

    ctx.fillStyle = '#f5d0a9';
    ctx.beginPath(); ctx.arc(0, -T.r * 1.6, T.r * 0.55, 0, TAU); ctx.fill();
  } else {
    // Catapult base banner color (small flag on side)
    ctx.fillStyle = body;
    ctx.fillRect(-T.r * 0.2, -T.r * 0.7, 3, 6);
  }

  // Per-troop weapon / cosmetic
  drawTroopDeco(u, T);

  // Hit flash
  if (fl > 0){
    ctx.globalAlpha = fl * 0.7;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, -T.r * 0.6, T.r * 0.85, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // HP bar
  if (u.hp < u.maxHp){
    const w = T.r * 1.8;
    const h = 3;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(-w/2 - 1, -T.r * 2.4, w + 2, h + 2);
    const ratio = clamp(u.hp / u.maxHp, 0, 1);
    ctx.fillStyle = ratio > 0.5 ? '#86efac' : ratio > 0.25 ? '#fde68a' : '#fca5a5';
    ctx.fillRect(-w/2, -T.r * 2.4 + 1, w * ratio, h);
  }
  ctx.restore();
}

function drawTroopDeco(u, T){
  const facing = u.facing;
  ctx.save();
  ctx.scale(facing, 1);
  switch (u.key){
    case 'sword': {
      // Sword arc when attacking: cd from 0..1/atk
      const swing = 1 - clamp(u.cd / (1 / T.atkSpeed || 1), 0, 1);
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(T.r * 0.4, -T.r * 0.5);
      ctx.lineTo(T.r * 0.4 + 12, -T.r * 1.4 - swing * 4);
      ctx.stroke();
      break;
    }
    case 'archer': {
      ctx.strokeStyle = '#a3704b'; ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(T.r * 0.6, -T.r * 0.9, 8, -0.9, 0.9);
      ctx.stroke();
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath(); ctx.moveTo(T.r * 0.6, -T.r * 0.9 - 8); ctx.lineTo(T.r * 0.6, -T.r * 0.9 + 8); ctx.stroke();
      break;
    }
    case 'knight': {
      // helmet plume
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(-T.r * 0.4, -T.r * 1.95, T.r * 0.8, 4);
      // lance
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(-T.r * 0.4, -T.r * 0.7); ctx.lineTo(T.r * 1.6, -T.r * 0.85); ctx.stroke();
      break;
    }
    case 'pike': {
      ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-T.r * 0.5, T.r * 0.4); ctx.lineTo(T.r * 1.9, -T.r * 1.6); ctx.stroke();
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.moveTo(T.r * 1.9, -T.r * 1.6);
      ctx.lineTo(T.r * 1.6, -T.r * 1.4);
      ctx.lineTo(T.r * 1.85, -T.r * 1.25);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'mage': {
      // staff with orb
      ctx.strokeStyle = '#7c5cff'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(T.r * 0.5, T.r * 0.5); ctx.lineTo(T.r * 1.2, -T.r * 1.7); ctx.stroke();
      const glow = 0.6 + 0.4 * Math.sin(state.time * 6);
      const grd = ctx.createRadialGradient(T.r * 1.2, -T.r * 1.7, 0, T.r * 1.2, -T.r * 1.7, 8);
      grd.addColorStop(0, `rgba(255,210,90,${0.9*glow})`);
      grd.addColorStop(1, 'rgba(255,210,90,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(T.r * 1.2, -T.r * 1.7, 9, 0, TAU); ctx.fill();
      // hat
      ctx.fillStyle = '#7c5cff';
      ctx.beginPath();
      ctx.moveTo(-T.r * 0.6, -T.r * 1.6);
      ctx.lineTo(T.r * 0.6, -T.r * 1.6);
      ctx.lineTo(0, -T.r * 2.4);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'healer': {
      // white hood + cross
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(0, -T.r * 1.6, T.r * 0.6, Math.PI, TAU); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillRect(-T.r * 0.35, -T.r * 0.7, T.r * 0.7, T.r * 0.2);
      ctx.fillRect(-T.r * 0.1, -T.r * 1.0, T.r * 0.2, T.r * 0.7);
      const glow = 0.5 + 0.5 * Math.sin(state.time * 4);
      ctx.globalAlpha = 0.18 * glow;
      ctx.fillStyle = '#86efac';
      ctx.beginPath(); ctx.arc(0, -T.r * 0.6, T.r * 1.3, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      break;
    }
    case 'giant': {
      ctx.fillStyle = '#cbd5e1';
      // huge club
      ctx.fillRect(T.r * 0.5, -T.r * 0.8, T.r * 1.4, 5);
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath(); ctx.arc(T.r * 1.9, -T.r * 0.55, 7, 0, TAU); ctx.fill();
      break;
    }
    case 'assassin': {
      // dark hood overlay on head
      ctx.fillStyle = '#0f172a';
      ctx.beginPath(); ctx.arc(0, -T.r * 1.6, T.r * 0.62, Math.PI * 0.9, TAU * 1.05); ctx.fill();
      // glowing eyes
      const ey = 0.5 + 0.5 * Math.sin(state.time * 6);
      ctx.fillStyle = `rgba(220,38,38,${0.6 + ey * 0.4})`;
      ctx.fillRect(-T.r * 0.25, -T.r * 1.55, 2, 1.5);
      ctx.fillRect( T.r * 0.10, -T.r * 1.55, 2, 1.5);
      // dual daggers
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
      const swing = 1 - clamp(u.cd / (1 / T.atkSpeed || 1), 0, 1);
      const off = swing * 4;
      ctx.beginPath(); ctx.moveTo(T.r * 0.4, -T.r * 0.5); ctx.lineTo(T.r * 0.9 + off, -T.r * 1.2 - off); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-T.r * 0.4, -T.r * 0.5); ctx.lineTo(-T.r * 0.9 - off, -T.r * 1.2 - off); ctx.stroke();
      break;
    }
    case 'catapult': {
      // wheels (drawn under body — visible because body is small)
      ctx.fillStyle = '#3a2a1a';
      ctx.beginPath(); ctx.arc(-T.r * 0.7, T.r * 0.4, 4.5, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc( T.r * 0.7, T.r * 0.4, 4.5, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#1f1208'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(-T.r * 0.7, T.r * 0.4, 4.5, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc( T.r * 0.7, T.r * 0.4, 4.5, 0, TAU); ctx.stroke();
      // chassis
      ctx.fillStyle = '#7a5a2a';
      ctx.fillRect(-T.r, -T.r * 0.1, T.r * 2, 6);
      // throwing arm — animates with cooldown (cocked when cd close to firing)
      const reload = clamp(u.cd / (1 / T.atkSpeed || 1), 0, 1);
      const armAngle = -Math.PI / 2 + (1 - reload) * (Math.PI / 1.6); // back when ready
      ctx.save();
      ctx.translate(-T.r * 0.4, -T.r * 0.1);
      ctx.rotate(armAngle);
      ctx.strokeStyle = '#a78140'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -T.r * 1.6); ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath(); ctx.arc(0, -T.r * 1.6, 4, 0, TAU); ctx.fill();
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

function drawProjectile(p){
  if (p.kind === 'arrow'){
    const ang = Math.atan2(p.vy, p.vx);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(-8, -1, 14, 2);
    ctx.fillStyle = '#a3704b';
    ctx.fillRect(-10, -2, 3, 4);
    ctx.restore();
  } else if (p.kind === 'fireball'){
    const r = 5;
    const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
    grd.addColorStop(0, '#fff5b6');
    grd.addColorStop(0.4, '#ff9f1c');
    grd.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
  } else if (p.kind === 'rock'){
    p.spin = (p.spin || 0) + 0.4;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.spin);
    ctx.fillStyle = '#3f3f46';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(6, -3);
    ctx.lineTo(7, 4);
    ctx.lineTo(0, 8);
    ctx.lineTo(-6, 4);
    ctx.lineTo(-7, -2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#52525b';
    ctx.beginPath(); ctx.arc(-2, -2, 2, 0, TAU); ctx.fill();
    ctx.restore();
  } else if (p.kind === 'knife'){
    const ang = Math.atan2(p.vy, p.vx);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(-5, 0); ctx.lineTo(4, -1.5); ctx.lineTo(6, 0); ctx.lineTo(4, 1.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#7f1d1d';
    ctx.fillRect(-7, -1, 3, 2);
    ctx.restore();
  }
}

function drawParticle(p){
  const a = clamp(p.life / p.max, 0, 1);
  ctx.globalAlpha = a;
  if (p.ring){
    const t = 1 - a;
    const r = lerp(p.radius, p.growTo, t);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
  } else {
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------- Mouse / deploy ----------
const mouse = { x: 0, y: 0, inside: false };
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) * (W / r.width);
  mouse.y = (e.clientY - r.top)  * (H / r.height);
  mouse.inside = true;
});
canvas.addEventListener('mouseleave', () => mouse.inside = false);
canvas.addEventListener('click', e => {
  if (state.over) return;
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (W / r.width);
  const y = (e.clientY - r.top)  * (H / r.height);
  const side = decideSide(x);
  if (!side) return;
  if (!isPlayerSide(side)) return;
  tryDeploy(side, state.selected, x, y);
});
function decideSide(x){
  if (state.mode === 'sandbox') return x < W/2 ? 'red' : 'blue';
  return state.playerSide;
}

function drawDeployPreview(){
  if (!mouse.inside || state.over) return;
  const side = decideSide(mouse.x);
  if (!side) return;
  if (!isPlayerSide(side)) return;
  const T = TROOPS[state.selected];
  const ok =
    mouse.y > GROUND_Y + 18 && mouse.y < H - 16 &&
    state[side].gold >= T.cost &&
    ((side === 'red' && mouse.x > RED_CASTLE_X + CASTLE_W + 6 && mouse.x < W/2 - MIDLINE_PAD) ||
     (side === 'blue' && mouse.x < BLUE_CASTLE_X - 6 && mouse.x > W/2 + MIDLINE_PAD));
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = ok ? (side === 'red' ? '#fca5a5' : '#93c5fd') : '#ef4444';
  ctx.setLineDash([4,4]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, T.r + 4, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  // Allowed deploy zone shading
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = side === 'red' ? '#ef4444' : '#3b82f6';
  if (side === 'red'){
    ctx.fillRect(RED_CASTLE_X + CASTLE_W + 6, GROUND_Y + 18, (W/2 - MIDLINE_PAD) - (RED_CASTLE_X + CASTLE_W + 6), H - 16 - (GROUND_Y + 18));
  } else {
    ctx.fillRect(W/2 + MIDLINE_PAD, GROUND_Y + 18, (BLUE_CASTLE_X - 6) - (W/2 + MIDLINE_PAD), H - 16 - (GROUND_Y + 18));
  }
  ctx.restore();
}

// ---------- Controls (UI) ----------
document.getElementById('restartBtn').addEventListener('click', restart);
document.getElementById('muteBtn').addEventListener('click', () => {
  Audio.init(); Audio.resume();
  const m = !Audio.isMuted();
  Audio.setMuted(m);
  const btn = document.getElementById('muteBtn');
  btn.textContent = m ? '🔇 Muted' : '🔊 Sound';
  btn.setAttribute('aria-pressed', m ? 'true' : 'false');
});
// Resume / init audio on first user interaction (browser autoplay policy)
const _firstGesture = () => { Audio.init(); Audio.resume(); window.removeEventListener('pointerdown', _firstGesture); window.removeEventListener('keydown', _firstGesture); };
window.addEventListener('pointerdown', _firstGesture);
window.addEventListener('keydown', _firstGesture);

document.getElementById('pauseBtn').addEventListener('click', () => {
  state.paused = !state.paused;
  document.getElementById('pauseBtn').textContent = state.paused ? '▶ Resume' : '❚❚ Pause';
});
document.getElementById('modeSelect').addEventListener('change', (e) => {
  state.mode = e.target.value;
  updateSelectedHighlight();
});
document.getElementById('sideSelect').addEventListener('change', (e) => {
  state.playerSide = e.target.value;
  updateSelectedHighlight();
});

window.addEventListener('keydown', e => {
  if (HOTKEYS[e.key]){ state.selected = HOTKEYS[e.key]; updateSelectedHighlight(); }
  if (e.key === ' '){
    state.paused = !state.paused;
    document.getElementById('pauseBtn').textContent = state.paused ? '▶ Resume' : '❚❚ Pause';
    e.preventDefault();
  }
  if (e.key === 'r' || e.key === 'R'){ restart(); }
});

function restart(){
  state.units.length = 0;
  state.projectiles.length = 0;
  state.particles.length = 0;
  state.damageText.length = 0;
  state.red.gold = 200; state.blue.gold = 200;
  state.red.castleHP = state.red.castleMaxHP;
  state.blue.castleHP = state.blue.castleMaxHP;
  state.over = false; state.winner = null;
  state.time = 0; state.ai.nextDecision = 1.5;
  shakeAmount = 0;
  const banner = document.getElementById('banner');
  banner.classList.remove('show','red','blue');
}

// ---------- Main loop ----------
function loop(now){
  const dt = Math.min(0.05, (now - state.lastTime) / 1000);
  state.lastTime = now;
  if (!state.paused){
    state.time += dt;
    update(dt);
  }
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(now => { state.lastTime = now; loop(now); });

})();
