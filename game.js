import * as THREE from 'three';

/* ============================================================
   STRIKEPOINT — wave-based browser FPS (Three.js, no build step)
   ============================================================ */

const bootError = (msg) => {
  const el = document.getElementById('boot-error');
  if (el) { el.textContent = 'Failed to start 3D engine: ' + msg; el.classList.remove('hidden'); }
  console.error('[strikepoint]', msg);
};

// ---------- tiny helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const $ = (id) => document.getElementById(id);

// ---------- config ----------
const ARENA = 44;            // playable half-extent
const EYE = 1.7;
const MAX_WAVE = 8;
const BEST_KEY = 'strikepoint_best_v1';

const WEAPONS = {
  ar:  { name: 'AR-7 "HORNET"', mag: 30, reserve: 150, damage: 26, headMult: 2.0, rpm: 540, spread: 0.014, adsSpread: 0.003, reload: 1.6, kick: 0.011, range: 120, tracer: 0xffc26b, auto: true },
  dmr: { name: 'DMR-12 "LONGSHOT"', mag: 10, reserve: 50, damage: 78, headMult: 2.2, rpm: 170, spread: 0.006, adsSpread: 0.0008, reload: 2.2, kick: 0.03, range: 160, tracer: 0x9be8ff, auto: false },
};

// ---------- audio (procedural, no assets) ----------
const AudioSys = {
  ctx: null, master: null, volume: 0.7,
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    } catch (e) { console.warn('audio unavailable', e); }
  },
  resume() { this.init(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  env(gainNode, t0, peak, decay) {
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.008);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  },
  noiseBurst({ duration = 0.12, peak = 0.5, freq = 1800, q = 0.6, type = 'lowpass' } = {}) {
    if (!this.ctx) return;
    const t0 = this.now();
    const len = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); this.env(g, t0, peak, duration);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + duration + 0.05);
  },
  tone({ freq = 440, end = 0, duration = 0.1, peak = 0.25, type = 'square' } = {}) {
    if (!this.ctx) return;
    const t0 = this.now();
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (end) o.frequency.exponentialRampToValueAtTime(end, t0 + duration);
    const g = this.ctx.createGain(); this.env(g, t0, peak, duration);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + duration + 0.05);
  },
  shoot(dmr) {
    this.noiseBurst({ duration: dmr ? 0.22 : 0.13, peak: dmr ? 0.65 : 0.5, freq: dmr ? 900 : 2200, type: 'lowpass' });
    this.tone({ freq: dmr ? 140 : 220, end: 45, duration: 0.12, peak: 0.4, type: 'sawtooth' });
  },
  enemyShoot() { this.noiseBurst({ duration: 0.1, peak: 0.16, freq: 1200 }); },
  dry() { this.tone({ freq: 1400, duration: 0.05, peak: 0.15 }); },
  reload() { this.tone({ freq: 500, end: 900, duration: 0.07, peak: 0.2 }); setTimeout(() => this.tone({ freq: 700, end: 1100, duration: 0.07, peak: 0.22 }), 160); },
  hit() { this.tone({ freq: 2100, duration: 0.045, peak: 0.2, type: 'sine' }); },
  kill() { this.tone({ freq: 660, end: 990, duration: 0.12, peak: 0.25, type: 'triangle' }); },
  hurt() { this.noiseBurst({ duration: 0.18, peak: 0.4, freq: 400 }); this.tone({ freq: 110, end: 60, duration: 0.2, peak: 0.3, type: 'sawtooth' }); },
  pickup() { this.tone({ freq: 520, end: 1040, duration: 0.14, peak: 0.25, type: 'sine' }); },
  horn() { this.tone({ freq: 98, duration: 0.5, peak: 0.4, type: 'sawtooth' }); setTimeout(() => this.tone({ freq: 147, duration: 0.5, peak: 0.35, type: 'sawtooth' }), 180); },
  step() { this.noiseBurst({ duration: 0.05, peak: 0.07, freq: 500 }); },
  uplink() { this.tone({ freq: 880, duration: 0.08, peak: 0.14, type: 'sine' }); },
  victory() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone({ freq: f, duration: 0.25, peak: 0.3, type: 'triangle' }), i * 160)); },
};

// ---------- procedural canvas textures ----------
function canvasTex(size, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function groundTexture() {
  return canvasTex(512, (g, s) => {
    g.fillStyle = '#4a4a42'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const v = Math.random();
      g.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,240,0.05)';
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo((i * s) / 4, 0); g.lineTo((i * s) / 4, s); g.stroke();
      g.beginPath(); g.moveTo(0, (i * s) / 4); g.lineTo(s, (i * s) / 4); g.stroke();
    }
    g.strokeStyle = 'rgba(255,200,120,0.5)'; g.lineWidth = 5; g.setLineDash([26, 20]);
    g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.stroke();
  }, 10, 10);
}
function concreteTexture() {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#8d8d88'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.07)';
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(Math.random() * s, 0); g.lineTo(Math.random() * s, s); g.stroke(); }
  }, 1, 1);
}
function metalTexture() {
  return canvasTex(256, (g, s) => {
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, '#7a4a28'); grad.addColorStop(0.5, '#a36532'); grad.addColorStop(1, '#6e4223');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(0,0,0,0.28)';
    for (let x = 16; x < s; x += 32) g.fillRect(x, 0, 4, s);
    g.fillStyle = 'rgba(255,220,170,0.12)';
    for (let x = 0; x < s; x += 32) g.fillRect(x, 0, 3, s);
    g.fillStyle = 'rgba(30,18,8,0.85)'; g.font = 'bold 34px monospace';
    g.fillText('CARGO-7', 40, 120); g.fillText('MAX 24T', 60, 165);
  }, 1, 1);
}
function camoTexture(base = '#5a6242') {
  return canvasTex(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    const cols = ['#3d4430', '#6e7350', '#2e3325', '#7a7a62'];
    for (let i = 0; i < 46; i++) {
      g.fillStyle = cols[i % cols.length];
      g.beginPath();
      g.ellipse(Math.random() * s, Math.random() * s, rand(12, 42), rand(8, 26), Math.random() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }, 1, 1);
}
function crateTexture() {
  return canvasTex(256, (g, s) => {
    g.fillStyle = '#7d6440'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#4a3a22'; g.lineWidth = 14; g.strokeRect(7, 7, s - 14, s - 14);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(s, s); g.moveTo(s, 0); g.lineTo(0, s); g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.2)';
    for (let i = 0; i < 40; i++) g.fillRect(Math.random() * s, Math.random() * s, rand(4, 20), 2);
  }, 1, 1);
}

// ---------- three.js boot ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true, powerPreference: 'high-performance' });
} catch (e) { bootError(e.message || e); throw e; }
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a5c4);
scene.fog = new THREE.Fog(0x9fb4c8, 55, 165);

const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 400);
camera.rotation.order = 'YXZ';

// lights
const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6a6350, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
sun.position.set(38, 52, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.far = 160;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
// camera fill so the viewmodel and nearby cover read well on shadowed sides
const fill = new THREE.PointLight(0xffe6c0, 6, 12);
camera.add(fill);
fill.position.set(0, 0.3, 0.2);

// ---------- sky dome, mountains, clouds ----------
{
  const skyGeo = new THREE.SphereGeometry(320, 24, 16);
  const top = new THREE.Color(0x2f5d9e), mid = new THREE.Color(0x87a5c4), bot = new THREE.Color(0xd9c9a8);
  const pos = skyGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 320;
    if (h > 0.25) c.copy(mid).lerp(top, clamp((h - 0.25) / 0.75, 0, 1));
    else if (h > -0.08) c.copy(bot).lerp(mid, clamp((h + 0.08) / 0.33, 0, 1));
    else c.copy(bot);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));

  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(14, 32), new THREE.MeshBasicMaterial({ color: 0xfff6e0, fog: false }));
  sunDisc.position.set(150, 170, 90); sunDisc.lookAt(0, 0, 0); scene.add(sunDisc);

  const mMat = new THREE.MeshLambertMaterial({ color: 0x5d6b7a });
  const mMat2 = new THREE.MeshLambertMaterial({ color: 0x4c5a68 });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const r = rand(190, 250);
    const m = new THREE.Mesh(new THREE.ConeGeometry(rand(28, 60), rand(35, 80), 5), i % 2 ? mMat : mMat2);
    m.position.set(Math.cos(a) * r, -4, Math.sin(a) * r);
    m.rotation.y = Math.random() * Math.PI;
    scene.add(m);
  }
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, fog: false });
  for (let i = 0; i < 10; i++) {
    const grp = new THREE.Group();
    for (let j = 0; j < 4; j++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(rand(6, 13), 10, 8), cloudMat);
      p.position.set(j * rand(7, 11) - 18, rand(-2, 2), rand(-4, 4));
      p.scale.y = 0.45; grp.add(p);
    }
    grp.position.set(rand(-220, 220), rand(70, 120), rand(-220, 220));
    scene.add(grp);
  }
}

// ---------- level ----------
const colliders = [];   // {minX,maxX,minZ,maxZ}
const solids = [];      // meshes for bullet/LOS raycasts
function addCollider(mesh, pad = 0) {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  colliders.push({ minX: box.min.x - pad, maxX: box.max.x + pad, minZ: box.min.z - pad, maxZ: box.max.z + pad });
  solids.push(mesh);
}
function box(w, h, d, mat, x, y, z, ry = 0, collide = true, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.y = ry;
  m.castShadow = shadow; m.receiveShadow = true;
  scene.add(m);
  if (collide) addCollider(m);
  return m;
}

const groundTex = groundTexture();
const ground = new THREE.Mesh(new THREE.PlaneGeometry(280, 280), new THREE.MeshLambertMaterial({ map: groundTex }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);
// warm bounce light card under player area
{
  const bounce = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshBasicMaterial({ color: 0xcfa96a, transparent: true, opacity: 0.06, depthWrite: false }));
  bounce.rotation.x = -Math.PI / 2; bounce.position.y = 0.02; scene.add(bounce);
}

const concreteMat = new THREE.MeshLambertMaterial({ map: concreteTexture() });
const crateMat = new THREE.MeshLambertMaterial({ map: crateTexture() });
const containerMat = new THREE.MeshLambertMaterial({ map: metalTexture() });
const camoMat = new THREE.MeshLambertMaterial({ map: camoTexture() });
const darkMetal = new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 0.6, metalness: 0.55 });
const barrierMat = new THREE.MeshLambertMaterial({ color: 0xc8bfa8 });
const accentMat = new THREE.MeshLambertMaterial({ color: 0xcc4422, emissive: 0x581800 });

// perimeter walls
{
  const H = 5, T = 1.2, W = ARENA * 2 + 8;
  box(W, H, T, concreteMat, 0, H / 2, -ARENA - 4, 0);
  box(W, H, T, concreteMat, 0, H / 2, ARENA + 4, 0);
  box(T, H, W, concreteMat, -ARENA - 4, H / 2, 0, 0);
  box(T, H, W, concreteMat, ARENA + 4, H / 2, 0, 0);
  // wall trim lights
  const trimMat = new THREE.MeshBasicMaterial({ color: 0xffb454 });
  for (let x = -36; x <= 36; x += 12) {
    for (const z of [-ARENA - 3.3, ARENA + 3.3]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.18, 0.18), trimMat);
      s.position.set(x, 4.1, z); scene.add(s);
    }
  }
}
// shipping containers (cover lanes)
box(12, 3, 3, containerMat, -18, 1.5, -14, 0.08);
box(12, 3, 3, containerMat, -18, 4.5, -14.1, 0.08);
box(12, 3, 3, containerMat, 20, 1.5, 12, -0.06);
box(12, 3, 3, containerMat, 16, 1.5, -22, 0.5);
box(12, 3, 3, containerMat, -24, 1.5, 20, -0.35);
// crate clusters
const crateSpots = [[-8, -6], [-6.4, -6], [-7.2, -4.4], [10, 4], [11.6, 4.2], [10.8, 5.8], [2, -20], [3.6, -20], [-14, 6], [24, -4], [-28, -18], [28, 22], [6, 18]];
for (const [x, z] of crateSpots) {
  const s = rand(1.4, 2.1);
  box(s, s, s, crateMat, x, s / 2, z, rand(0, Math.PI / 2));
}
box(2, 2, 2, crateMat, -7.2, 2.9, -5.4, 0.3);
// concrete barriers
for (const [x, z, ry] of [[0, -2, 0.2], [-4, 12, 1.7], [14, -10, 0.1], [-20, -2, 1.4], [8, 24, 0.3], [-2, -30, 0]]) {
  box(4.4, 1.2, 0.9, barrierMat, x, 0.6, z, ry);
  box(4.4, 0.25, 0.95, accentMat, x, 1.3, z, ry, false, false);
}
// watchtower
{
  const legM = darkMetal;
  for (const [x, z] of [[-30, -30], [-27, -30], [-30, -27], [-27, -27]]) box(0.35, 7, 0.35, legM, x, 3.5, z);
  box(4.4, 0.4, 4.4, crateMat, -28.5, 7, -28.5);
  box(4.4, 1.1, 0.25, crateMat, -28.5, 7.9, -30.6);
  box(4.4, 1.1, 0.25, crateMat, -28.5, 7.9, -26.4);
  box(0.25, 1.1, 4.4, crateMat, -30.6, 7.9, -28.5);
  box(0.25, 1.1, 4.4, crateMat, -26.4, 7.9, -28.5);
  box(5, 0.3, 5, darkMetal, -28.5, 8.7, -28.5);
}
// camo tents (low cover)
for (const [x, z, ry] of [[-10, 26, 0.2], [26, -16, 1.2]]) {
  const tent = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 3.2, 3, 4, 1), camoMat);
  tent.position.set(x, 1.5, z); tent.rotation.y = ry;
  tent.castShadow = tent.receiveShadow = true;
  scene.add(tent); addCollider(tent);
}
// uplink point
const UPLINK = { x: 0, z: 8, r: 4.2 };
{
  const ring = new THREE.Mesh(new THREE.RingGeometry(UPLINK.r - 0.35, UPLINK.r, 48),
    new THREE.MeshBasicMaterial({ color: 0x57e6c9, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(UPLINK.x, 0.05, UPLINK.z);
  ring.name = 'uplink-ring'; scene.add(ring);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(UPLINK.r - 0.35, 48),
    new THREE.MeshBasicMaterial({ color: 0x57e6c9, transparent: true, opacity: 0.10, side: THREE.DoubleSide, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2; disc.position.set(UPLINK.x, 0.04, UPLINK.z); scene.add(disc);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 5.4, 10), darkMetal);
  mast.position.set(UPLINK.x + UPLINK.r + 1, 2.7, UPLINK.z); mast.castShadow = true; scene.add(mast); addCollider(mast, 0.15);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x57e6c9 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), lampMat);
  lamp.position.set(UPLINK.x + UPLINK.r + 1, 5.6, UPLINK.z); scene.add(lamp);
  const pl = new THREE.PointLight(0x57e6c9, 12, 22); pl.position.copy(lamp.position); scene.add(pl);
}
// scattered glow drums
{
  const drumMat = new THREE.MeshLambertMaterial({ color: 0x7a2a1a });
  for (const [x, z] of [[-34, 10], [34, -8], [12, 32], [-12, -32]]) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.8, 12), drumMat);
    d.position.set(x, 0.9, z); d.castShadow = d.receiveShadow = true; scene.add(d); addCollider(d, 0.1);
  }
}
// flag poles for orientation
{
  const flagCols = [0xcc4422, 0x57e6c9];
  [[-ARENA + 2, -ARENA + 2], [ARENA - 2, ARENA - 2]].forEach(([x, z], i) => {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 9, 8), darkMetal);
    p.position.set(x, 4.5, z); scene.add(p);
    const f = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.3), new THREE.MeshBasicMaterial({ color: flagCols[i], side: THREE.DoubleSide }));
    f.position.set(x + 1.15, 8, z); scene.add(f);
  });
}

// ---------- gun viewmodel ----------
const gunRig = new THREE.Group();
camera.add(gunRig);
scene.add(camera);
gunRig.position.set(0.28, -0.26, -0.5);
const gunMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.45, metalness: 0.6 });
const gunAccent = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.5, metalness: 0.3 });
const gunGlow = new THREE.MeshBasicMaterial({ color: 0xffb454 });
function buildRifle() {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.rotation.z = rz; g.add(m); return m;
  };
  add(new THREE.BoxGeometry(0.09, 0.13, 0.62), gunMat, 0, 0, -0.1);                       // receiver
  add(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 10), gunMat, 0, 0.02, -0.6).rotation.x = Math.PI / 2; // barrel
  add(new THREE.BoxGeometry(0.07, 0.16, 0.1), gunMat, 0, -0.12, 0.02, 0, 0.25);            // grip/mag
  add(new THREE.BoxGeometry(0.08, 0.1, 0.24), gunAccent, 0, -0.02, 0.28);                 // stock
  add(new THREE.BoxGeometry(0.05, 0.05, 0.3), gunMat, 0, -0.045, -0.35);                  // handguard
  add(new THREE.BoxGeometry(0.03, 0.09, 0.03), gunMat, 0, 0.1, -0.05);                    // front sight
  add(new THREE.BoxGeometry(0.03, 0.07, 0.06), gunMat, 0, 0.09, 0.12);                    // rear sight
  add(new THREE.BoxGeometry(0.095, 0.02, 0.2), gunGlow, 0, 0.075, -0.1);                  // glow strip
  const tip = new THREE.Object3D(); tip.position.set(0, 0.02, -0.88); g.add(tip); g.userData.tip = tip;
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34),
    new THREE.MeshBasicMaterial({ color: 0xffd58a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  flash.position.copy(tip.position); g.add(flash); g.userData.flash = flash;
  return g;
}
function buildDMR() {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  add(new THREE.BoxGeometry(0.085, 0.12, 0.7), gunMat, 0, 0, -0.05);
  add(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), gunMat, 0, 0.02, -0.72).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 12), gunMat, 0, 0.12, -0.02).rotation.x = Math.PI / 2; // scope
  add(new THREE.BoxGeometry(0.07, 0.18, 0.09), gunMat, 0, -0.13, 0.05);
  add(new THREE.BoxGeometry(0.075, 0.11, 0.3), gunAccent, 0, -0.01, 0.32);
  add(new THREE.BoxGeometry(0.02, 0.14, 0.02), gunMat, 0, -0.1, -0.45);                   // bipod leg hint
  add(new THREE.BoxGeometry(0.09, 0.02, 0.24), gunGlow, 0, 0.07, -0.05);
  const tip = new THREE.Object3D(); tip.position.set(0, 0.02, -1.12); g.add(tip); g.userData.tip = tip;
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42),
    new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  flash.position.copy(tip.position); g.add(flash); g.userData.flash = flash;
  return g;
}
const gunModels = { ar: buildRifle(), dmr: buildDMR() };
gunRig.add(gunModels.ar, gunModels.dmr);
const muzzleLight = new THREE.PointLight(0xffc26b, 0, 9);
scene.add(muzzleLight);

// ---------- pooled tracers & particles ----------
const tracers = [];
{
  for (let i = 0; i < 26; i++) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffc26b, transparent: true, opacity: 0 });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false; scene.add(line);
    tracers.push({ line, life: 0 });
  }
}
let tracerIdx = 0;
function fireTracer(from, to, color = 0xffc26b) {
  const t = tracers[tracerIdx++ % tracers.length];
  t.line.geometry.setFromPoints([from, to]);
  t.line.material.color.setHex(color);
  t.line.material.opacity = 0.95;
  t.life = 0.09;
  t.line.visible = true;
}
const P_MAX = 320;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(P_MAX * 3);
const pVel = new Float32Array(P_MAX * 3);
const pLife = new Float32Array(P_MAX);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const pMat = new THREE.PointsMaterial({ color: 0xffcf8a, size: 0.14, transparent: true, opacity: 0.95, depthWrite: false });
const points = new THREE.Points(pGeo, pMat);
points.frustumCulled = false; scene.add(points);
let pIdx = 0;
function burst(at, n = 10, color = 0xffcf8a, speed = 5) {
  pMat.color.setHex(color);
  for (let i = 0; i < n; i++) {
    const k = pIdx++ % P_MAX;
    pPos[k * 3] = at.x; pPos[k * 3 + 1] = at.y; pPos[k * 3 + 2] = at.z;
    const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI;
    pVel[k * 3] = Math.sin(ph) * Math.cos(th) * speed * Math.random();
    pVel[k * 3 + 1] = Math.abs(Math.cos(ph)) * speed * Math.random() + 1;
    pVel[k * 3 + 2] = Math.sin(ph) * Math.sin(th) * speed * Math.random();
    pLife[k] = rand(0.3, 0.7);
  }
}
function updateParticles(dt) {
  for (let k = 0; k < P_MAX; k++) {
    if (pLife[k] <= 0) continue;
    pLife[k] -= dt;
    pVel[k * 3 + 1] -= 9.5 * dt;
    pPos[k * 3] += pVel[k * 3] * dt;
    pPos[k * 3 + 1] += pVel[k * 3 + 1] * dt;
    pPos[k * 3 + 2] += pVel[k * 3 + 2] * dt;
    if (pPos[k * 3 + 1] < 0.02) { pPos[k * 3 + 1] = 0.02; pVel[k * 3 + 1] *= -0.3; }
    if (pLife[k] <= 0) pPos[k * 3 + 1] = -50;
  }
  pGeo.attributes.position.needsUpdate = true;
}
function updateTracers(dt) {
  for (const t of tracers) {
    if (t.life <= 0) { t.line.visible = false; continue; }
    t.life -= dt;
    t.line.material.opacity = Math.max(0, t.life / 0.09) * 0.95;
    if (t.life <= 0) t.line.visible = false;
  }
}

// ---------- enemies ----------
const enemies = [];
const enemyBodyGeo = new THREE.CapsuleGeometry(0.42, 0.85, 6, 12);
const enemyHeadGeo = new THREE.SphereGeometry(0.26, 14, 12);
const enemyGunGeo = new THREE.BoxGeometry(0.1, 0.14, 0.9);
const spawnPoints = [
  [-ARENA + 3, -ARENA + 3], [ARENA - 3, -ARENA + 3],
  [-ARENA + 3, ARENA - 3], [ARENA - 3, ARENA - 3],
  [0, -ARENA + 2], [0, ARENA - 2], [-ARENA + 2, 0], [ARENA - 2, 0],
];
function makeHealthSprite() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 8;
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.1, 0.14, 1); sp.userData.canvas = c; sp.userData.tex = tex;
  return sp;
}
function drawHealth(sp, frac) {
  const g = sp.userData.canvas.getContext('2d');
  g.clearRect(0, 0, 64, 8);
  g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(0, 0, 64, 8);
  g.fillStyle = frac > 0.5 ? '#54ff8a' : frac > 0.25 ? '#ffc26b' : '#ff5a5a';
  g.fillRect(1, 1, 62 * clamp(frac, 0, 1), 6);
  sp.userData.tex.needsUpdate = true;
}
function spawnEnemy(wave) {
  const sp = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
  const grp = new THREE.Group();
  const hp = Math.round(55 + wave * 22);
  const suitCols = [0x8a2f24, 0x6b5a2e, 0x3d4a5a, 0x4a3d5a];
  const suit = new THREE.MeshStandardMaterial({ color: suitCols[Math.floor(Math.random() * suitCols.length)], roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9a184, roughness: 0.7 });
  const body = new THREE.Mesh(enemyBodyGeo, suit);
  body.position.y = 1.05; body.castShadow = true;
  body.userData.enemy = true; body.userData.part = 'body';
  const head = new THREE.Mesh(enemyHeadGeo, skin);
  head.position.y = 1.95; head.castShadow = true;
  head.userData.enemy = true; head.userData.part = 'head';
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
  visor.position.set(0, 1.98, 0.2); grp.add(visor);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.29, 12, 8, 0, Math.PI * 2, 0, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.5, metalness: 0.4 }));
  helm.position.y = 2.0; grp.add(helm);
  const gun = new THREE.Mesh(enemyGunGeo, new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.5 }));
  gun.position.set(0.3, 1.3, -0.4); grp.add(gun);
  const bar = makeHealthSprite(); bar.position.y = 2.45; grp.add(bar);
  grp.add(body, head);
  grp.position.set(clamp(sp[0] + rand(-2, 2), -ARENA, ARENA), 0, clamp(sp[1] + rand(-2, 2), -ARENA, ARENA));
  scene.add(grp);
  drawHealth(bar, 1);
  burst(new THREE.Vector3(grp.position.x, 1.2, grp.position.z), 14, 0xff5a5a, 4);
  const e = {
    grp, body, head, bar, hp, maxHp: hp,
    speed: rand(3.0, 4.2) + wave * 0.22,
    fireTimer: rand(1.0, 2.2), burstLeft: 0, burstTimer: 0,
    strafeDir: Math.random() < 0.5 ? -1 : 1, strafeTimer: rand(1, 3),
    bob: Math.random() * 10, flash: 0, dead: false,
    dmg: 6 + wave * 1.6,
  };
  body.userData.ref = e; head.userData.ref = e;
  enemies.push(e);
  return e;
}
function damageEnemy(e, dmg, isHead, hitPoint) {
  if (e.dead) return;
  e.hp -= dmg;
  e.flash = 0.12;
  drawHealth(e.bar, e.hp / e.maxHp);
  burst(hitPoint, isHead ? 12 : 7, isHead ? 0xffe08a : 0xff6a5a, 5);
  AudioSys.hit();
  showHitmarker(!e || e.hp <= 0);
  if (e.hp <= 0) killEnemy(e, isHead, hitPoint);
  else { e.strafeDir *= -1; }
}
function killEnemy(e, isHead, hitPoint) {
  e.dead = true;
  burst(hitPoint || e.grp.position.clone().setY(1.3), 22, 0xff8a5a, 7);
  burst(e.grp.position.clone().setY(0.4), 10, 0x8a2f24, 4);
  scene.remove(e.grp);
  const i = enemies.indexOf(e);
  if (i >= 0) enemies.splice(i, 1);
  player.kills++;
  const pts = (isHead ? 150 : 100) + (game.wave - 1) * 15 + Math.round(player.captureBonus / 10);
  player.score += pts;
  AudioSys.kill();
  feed(`${isHead ? 'HEADSHOT' : 'HOSTILE DOWN'} +${pts}`, isHead);
  showHitmarker(true);
  updateHUD();
  // drops
  const r = Math.random();
  if (r < 0.16) spawnPickup('med', e.grp.position);
  else if (r < 0.30) spawnPickup('armor', e.grp.position);
  else if (r < 0.48) spawnPickup('ammo', e.grp.position);
  checkWaveClear();
}

// ---------- pickups ----------
const pickups = [];
const pickupGeos = {
  med: new THREE.BoxGeometry(0.5, 0.3, 0.5),
  armor: new THREE.OctahedronGeometry(0.32),
  ammo: new THREE.BoxGeometry(0.45, 0.28, 0.3),
};
function spawnPickup(kind, at) {
  const cols = { med: 0x54ff8a, armor: 0x3fa9ff, ammo: 0xffb454 };
  const m = new THREE.Mesh(pickupGeos[kind], new THREE.MeshStandardMaterial({
    color: cols[kind], emissive: cols[kind], emissiveIntensity: 0.55, roughness: 0.4,
  }));
  m.position.set(clamp(at.x, -ARENA, ARENA), 0.7, clamp(at.z, -ARENA, ARENA));
  if (kind === 'med') {
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    c1.position.y = 0.16; c2.position.y = 0.16; m.add(c1, c2);
  }
  scene.add(m);
  pickups.push({ mesh: m, kind, t: 0, life: 30 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt; p.life -= dt;
    p.mesh.rotation.y += dt * 2.2;
    p.mesh.position.y = 0.7 + Math.sin(p.t * 3) * 0.12;
    const dx = p.mesh.position.x - player.pos.x, dz = p.mesh.position.z - player.pos.z;
    if (dx * dx + dz * dz < 2.6) {
      applyPickup(p.kind);
      scene.remove(p.mesh); pickups.splice(i, 1); continue;
    }
    if (p.life <= 0) { scene.remove(p.mesh); pickups.splice(i, 1); }
  }
}
function applyPickup(kind) {
  AudioSys.pickup();
  $('heal-flash').classList.add('on');
  setTimeout(() => $('heal-flash').classList.remove('on'), 120);
  if (kind === 'med') { player.health = clamp(player.health + 40, 0, 100); feed('+40 HEALTH'); }
  if (kind === 'armor') { player.armor = clamp(player.armor + 50, 0, 100); feed('+50 ARMOR'); }
  if (kind === 'ammo') {
    for (const k of ['ar', 'dmr']) { player.weapons[k].reserve += k === 'ar' ? 60 : 15; }
    feed('+AMMO'); 
  }
  updateHUD();
}

// ---------- game state ----------
const game = { state: 'menu', wave: 0, spawnQueue: 0, spawnTimer: 0, intermission: 0, capture: 0, captureBonus: 0, time: 0 };
const player = {
  pos: new THREE.Vector3(0, EYE, 26),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  health: 100, armor: 0, score: 0, kills: 0,
  onGround: true, vy: 0,
  weapons: {
    ar: { ...WEAPONS.ar, magAmmo: WEAPONS.ar.mag, reloading: 0 },
    dmr: { ...WEAPONS.dmr, magAmmo: WEAPONS.dmr.mag, reloading: 0 },
  },
  current: 'ar',
  lastShot: 0, triggerHeld: false,
  ads: 0, adsOn: false, spreadBloom: 0,
  hurtCd: 0, stepT: 0, captureBonus: 0,
};
const keys = {};
let canvasLocked = false;

// ---------- HUD ----------
const hud = {
  el: $('hud'), health: $('health-fill'), healthNum: $('health-num'),
  armor: $('armor-fill'), armorNum: $('armor-num'),
  mag: $('ammo-mag'), reserve: $('ammo-reserve'), ammoBox: $('ammo-box'),
  weapon: $('weapon-name'), reloadHint: $('reload-hint'),
  wave: $('wave-num'), left: $('enemies-left'), score: $('score'),
  feed: $('killfeed'), toast: $('wave-toast'), hint: $('interact-hint'),
  cross: $('crosshair'), hit: $('hitmarker'),
};
function updateHUD() {
  hud.health.style.width = clamp(player.health, 0, 100) + '%';
  hud.health.classList.toggle('low', player.health <= 30);
  hud.healthNum.textContent = Math.max(0, Math.ceil(player.health));
  hud.armor.style.width = clamp(player.armor, 0, 100) + '%';
  hud.armorNum.textContent = Math.max(0, Math.ceil(player.armor));
  const w = player.weapons[player.current];
  hud.mag.textContent = w.magAmmo;
  hud.reserve.textContent = '/ ' + w.reserve;
  hud.ammoBox.classList.toggle('reloading', w.reloading > 0);
  hud.weapon.textContent = w.name;
  hud.reloadHint.classList.toggle('hidden', !(w.magAmmo === 0 && w.reloading <= 0 && game.state === 'playing'));
  hud.wave.textContent = Math.max(1, game.wave);
  const remaining = enemies.length + game.spawnQueue;
  hud.left.textContent = game.state === 'playing' ? `${remaining} HOSTILE${remaining === 1 ? '' : 'S'}` : '—';
  hud.score.textContent = player.score;
}
function feed(text, headshot = false) {
  const d = document.createElement('div');
  d.textContent = text;
  if (headshot) d.classList.add('headshot');
  hud.feed.prepend(d);
  while (hud.feed.children.length > 5) hud.feed.lastChild.remove();
  setTimeout(() => d.remove(), 4200);
}
function showHitmarker(kill) {
  hud.hit.classList.remove('show', 'kill');
  void hud.hit.offsetWidth;
  if (kill) hud.hit.classList.add('kill');
  hud.hit.classList.add('show');
}
function toast(text) {
  hud.toast.textContent = text;
  hud.toast.classList.remove('hidden', 'show');
  void hud.toast.offsetWidth;
  hud.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hud.toast.classList.add('hidden'), 2450);
}

// ---------- collision ----------
function collideCircle(p, radius) {
  for (const c of colliders) {
    const nx = clamp(p.x, c.minX, c.maxX), nz = clamp(p.z, c.minZ, c.maxZ);
    const dx = p.x - nx, dz = p.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < radius * radius) {
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = nx + (dx / d) * radius;
        p.z = nz + (dz / d) * radius;
      } else {
        // center inside box: push out along smallest penetration
        const pl = p.x - c.minX, pr = c.maxX - p.x, pt = p.z - c.minZ, pb = c.maxZ - p.z;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pl) p.x = c.minX - radius;
        else if (m === pr) p.x = c.maxX + radius;
        else if (m === pt) p.z = c.minZ - radius;
        else p.z = c.maxZ + radius;
      }
    }
  }
  p.x = clamp(p.x, -ARENA - 2.5, ARENA + 2.5);
  p.z = clamp(p.z, -ARENA - 2.5, ARENA + 2.5);
}

// ---------- shooting ----------
const raycaster = new THREE.Raycaster();
const _dir = new THREE.Vector3();
function currentWeapon() { return player.weapons[player.current]; }
function tryFire(now) {
  const w = currentWeapon();
  if (w.reloading > 0 || game.state !== 'playing') return;
  const interval = 60 / w.rpm;
  if (now - player.lastShot < interval) return;
  if (!w.auto && player._firedThisPress) return;
  if (w.magAmmo <= 0) { AudioSys.dry(); player.lastShot = now; if (!w.auto) player._firedThisPress = true; startReload(); return; }
  player._firedThisPress = true;
  w.magAmmo--;
  player.lastShot = now;
  AudioSys.shoot(player.current === 'dmr');
  // direction with spread
  const spread = lerp(w.spread, w.adsSpread, player.ads) + player.spreadBloom;
  camera.getWorldDirection(_dir);
  _dir.x += rand(-spread, spread); _dir.y += rand(-spread, spread); _dir.z += rand(-spread, spread);
  _dir.normalize();
  raycaster.set(camera.getWorldPosition(new THREE.Vector3()), _dir);
  raycaster.far = w.range;
  // walls first
  const wallHits = raycaster.intersectObjects(solids, false);
  const wallDist = wallHits.length ? wallHits[0].distance : w.range;
  // enemies
  const targets = [];
  for (const e of enemies) targets.push(e.body, e.head);
  const hits = raycaster.intersectObjects(targets, false);
  let end;
  if (hits.length && hits[0].distance < wallDist) {
    const h = hits[0];
    const ref = h.object.userData.ref;
    const isHead = h.object.userData.part === 'head';
    damageEnemy(ref, w.damage * (isHead ? w.headMult : 1) * rand(0.92, 1.08), isHead, h.point);
    end = h.point;
  } else if (wallHits.length) {
    end = wallHits[0].point;
    burst(end, 6, 0xd8cfb8, 3.5);
  } else {
    end = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(_dir, w.range);
  }
  // tracer from muzzle
  const tip = gunModels[player.current].userData.tip;
  const from = tip.getWorldPosition(new THREE.Vector3());
  fireTracer(from, end.clone(), w.tracer);
  // muzzle flash
  const flash = gunModels[player.current].userData.flash;
  flash.material.opacity = 1;
  flash.rotation.z = Math.random() * Math.PI;
  flash.scale.setScalar(rand(0.8, 1.3));
  muzzleLight.position.copy(from);
  muzzleLight.color.setHex(player.current === 'dmr' ? 0x9be8ff : 0xffc26b);
  muzzleLight.intensity = 26;
  // recoil
  player.pitch += w.kick * rand(0.7, 1.3);
  player.yaw += rand(-w.kick, w.kick) * 0.35;
  player.spreadBloom = Math.min(0.03, player.spreadBloom + (player.current === 'dmr' ? 0.012 : 0.004));
  gunModels[player.current].position.z += player.current === 'dmr' ? 0.09 : 0.05;
  hud.cross.style.setProperty('--spread', `${4 + player.spreadBloom * 900}px`);
  if (w.magAmmo === 0) startReload();
  updateHUD();
}
function startReload() {
  const w = currentWeapon();
  if (w.reloading > 0 || w.magAmmo >= w.mag || w.reserve <= 0 || game.state !== 'playing') return;
  w.reloading = w.reload;
  AudioSys.reload();
  updateHUD();
}
function finishReload(w) {
  const need = w.mag - w.magAmmo;
  const take = Math.min(need, w.reserve);
  w.magAmmo += take; w.reserve -= take;
  AudioSys.reload();
}

// ---------- enemy AI ----------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
function hasLOS(from, to) {
  _v3.copy(to).sub(from);
  const dist = _v3.length();
  _v3.normalize();
  raycaster.set(from, _v3);
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(solids, false);
  return hits.length === 0;
}
function updateEnemies(dt, now) {
  for (const e of [...enemies]) {
    const gp = e.grp.position;
    e.bob += dt * 9;
    // face player
    _v1.set(player.pos.x - gp.x, 0, player.pos.z - gp.z);
    const distToPlayer = _v1.length();
    _v1.normalize();
    const targetYaw = Math.atan2(_v1.x, -_v1.z + 1e-6);
    e.grp.rotation.y = Math.atan2(player.pos.x - gp.x, player.pos.z - gp.z) + Math.PI;
    void targetYaw;
    // strafe flipping
    e.strafeTimer -= dt;
    if (e.strafeTimer <= 0) { e.strafeDir *= -1; e.strafeTimer = rand(0.8, 2.4); }
    // movement: approach until ~10m, then strafe orbit
    const desired = distToPlayer > 11 ? 1 : 0.25;
    _v2.set(0, 0, 0);
    if (distToPlayer > 9) { _v2.x += _v1.x * desired; _v2.z += _v1.z * desired; }
    else if (distToPlayer < 5) { _v2.x -= _v1.x * 0.8; _v2.z -= _v1.z * 0.8; }
    _v2.x += -_v1.z * e.strafeDir * 0.7;
    _v2.z += _v1.x * e.strafeDir * 0.7;
    const ml = _v2.length();
    if (ml > 0.01) {
      _v2.normalize().multiplyScalar(e.speed * dt);
      _v1.set(gp.x + _v2.x, 0, gp.z + _v2.z);
      const test = { x: _v1.x, z: _v1.z };
      // reuse collide with temp
      const tmp = { x: gp.x, z: gp.z };
      tmp.x += _v2.x; tmp.z += _v2.z;
      collideCircle(tmp, 0.55);
      gp.x = tmp.x; gp.z = tmp.z;
    }
    // bob + lean + hit flash
    e.body.position.y = 1.05 + Math.abs(Math.sin(e.bob)) * 0.06;
    e.grp.rotation.z = lerp(e.grp.rotation.z, e.strafeDir * -0.06, 0.1);
    if (e.flash > 0) {
      e.flash -= dt;
      e.body.material.emissive = e.body.material.emissive || new THREE.Color();
      e.body.material.emissive.setHex(0xff2222);
      e.body.material.emissiveIntensity = 0.9;
    } else if (e.body.material.emissiveIntensity) {
      e.body.material.emissiveIntensity = 0;
    }
    // firing
    e.fireTimer -= dt;
    const eye = _v2.set(gp.x, 1.8, gp.z);
    const pEye = _v1.set(player.pos.x, EYE - 0.1, player.pos.z);
    if (e.fireTimer <= 0 && distToPlayer < 46 && game.state === 'playing') {
      if (hasLOS(eye, pEye)) { e.burstLeft = 3; e.burstTimer = 0; }
      e.fireTimer = rand(1.5, 2.7) - Math.min(0.7, game.wave * 0.06);
    }
    if (e.burstLeft > 0) {
      e.burstTimer -= dt;
      if (e.burstTimer <= 0) {
        e.burstTimer = 0.14;
        e.burstLeft--;
        enemyFire(e, distToPlayer);
      }
    }
  }
}
const enemyMats = [];
function enemyFire(e, dist) {
  AudioSys.enemyShoot();
  const from = e.grp.position.clone(); from.y = 1.45;
  const to = player.pos.clone(); to.y = EYE - 0.15;
  to.x += rand(-1, 1) * (0.5 + dist * 0.03);
  to.y += rand(-0.6, 0.6);
  to.z += rand(-1, 1) * (0.5 + dist * 0.03);
  fireTracer(from, to, 0xff5a5a);
  burst(from, 3, 0xff8a5a, 2);
  // does the shot land? recompute against player with dodge-by-movement
  const moving = player.vel.length() > 4;
  const hitChance = clamp(0.45 - dist * 0.008 - (moving ? 0.15 : 0) - (player.ads > 0.5 ? 0 : 0.02), 0.06, 0.5);
  if (Math.random() < hitChance && hasLOS(from, player.pos.clone().setY(EYE - 0.1))) {
    hurtPlayer(e.dmg * rand(0.8, 1.2));
  }
}
function hurtPlayer(dmg) {
  if (game.state !== 'playing' || player.hurtCd > 0) return;
  player.hurtCd = 0.12;
  let rest = dmg;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, rest * 0.6);
    player.armor -= absorbed; rest -= absorbed;
  }
  player.health -= rest;
  AudioSys.hurt();
  $('damage-vignette').classList.add('on');
  setTimeout(() => $('damage-vignette').classList.remove('on'), 160);
  updateHUD();
  if (player.health <= 0) endRun(false);
}

// ---------- waves ----------
function startWave(n) {
  game.wave = n;
  game.spawnQueue = 3 + n * 2;
  game.spawnTimer = 0;
  player.hurtCd = Math.max(player.hurtCd, 1.5); // breathing room each wave
  toast(`WAVE ${n}`);
  AudioSys.horn();
  $('objective-text').textContent = n === MAX_WAVE ? 'Final stand — wipe them out' : 'Eliminate all hostiles';
  updateHUD();
}
function checkWaveClear() {
  if (game.state !== 'playing' || game.spawnQueue > 0 || enemies.length > 0) return;
  player.score += 250 + game.wave * 50;
  player.health = clamp(player.health + 15, 0, 100);
  feed(`WAVE ${game.wave} CLEAR +${250 + game.wave * 50}`);
  updateHUD();
  if (game.wave >= MAX_WAVE) { endRun(true); return; }
  game.intermission = 5;
  toast('AREA SECURE');
}
function updateSpawns(dt) {
  if (game.intermission > 0) {
    game.intermission -= dt;
    if (game.intermission <= 0) startWave(game.wave + 1);
    return;
  }
  if (game.spawnQueue > 0) {
    game.spawnTimer -= dt;
    const alive = enemies.length;
    if (game.spawnTimer <= 0 && alive < 10) {
      spawnEnemy(game.wave);
      game.spawnQueue--;
      game.spawnTimer = rand(0.5, 1.2);
      updateHUD();
    }
  }
}

// ---------- run lifecycle ----------
function resetWorld() {
  for (const e of [...enemies]) scene.remove(e.grp);
  enemies.length = 0;
  for (const p of pickups) scene.remove(p.mesh);
  pickups.length = 0;
  player.pos.set(0, EYE, 26); player.vel.set(0, 0, 0);
  player.yaw = 0; player.pitch = 0;
  player.health = 100; player.armor = 0; player.score = 0; player.kills = 0;
  player.weapons.ar = { ...WEAPONS.ar, magAmmo: WEAPONS.ar.mag, reloading: 0 };
  player.weapons.dmr = { ...WEAPONS.dmr, magAmmo: WEAPONS.dmr.mag, reloading: 0 };
  player.current = 'ar'; player.ads = 0; player.adsOn = false;
  player.spreadBloom = 0; player.captureBonus = 0;
  game.capture = 0; game.captureBonus = 0; game.time = 0;
  gunModels.ar.visible = true; gunModels.dmr.visible = false;
gunRig.position.set(0.28, -0.26, -0.5);
gunRig.scale.setScalar(0.8);
  updateHUD();
}
function startRun() {
  AudioSys.resume();
  resetWorld();
  game.state = 'playing';
  game.wave = 0; game.spawnQueue = 0; game.intermission = 1.2;
  $('menu').classList.add('hidden');
  $('end').classList.add('hidden');
  $('pause').classList.add('hidden');
  hud.el.classList.remove('hidden');
  hud.el.setAttribute('aria-hidden', 'false');
  player.hurtCd = 2.5; // spawn protection
  if (isTouch) $('touch-ui').classList.remove('hidden');
  toast('DEFEND THE COMPOUND');
  lockPointer();
  updateHUD();
}
function endRun(victory) {
  if (game.state !== 'playing') return;
  game.state = victory ? 'victory' : 'dead';
  document.exitPointerLock?.();
  $('touch-ui').classList.add('hidden');
  const best = Math.max(player.score, Number(localStorage.getItem(BEST_KEY) || 0));
  localStorage.setItem(BEST_KEY, String(best));
  $('menu-best').textContent = best;
  $('end-kicker').textContent = victory ? 'MISSION COMPLETE' : 'AFTER ACTION REPORT';
  $('end-title').textContent = victory ? 'COMPOUND HELD' : 'K.I.A.';
  $('end-title').className = victory ? 'victory' : 'dead';
  $('end-sub').textContent = victory
    ? `All ${MAX_WAVE} waves repelled with ${player.kills} confirmed kills. Outstanding work, operator.`
    : `You fell on wave ${game.wave} with ${player.kills} kills. The compound remembers.`;
  $('end-score').textContent = player.score;
  $('end-kills').textContent = player.kills;
  $('end-wave').textContent = `${game.wave} / ${MAX_WAVE}`;
  $('end-best').textContent = best;
  setTimeout(() => { $('end').classList.remove('hidden'); hud.el.classList.add('hidden'); }, 900);
  if (victory) AudioSys.victory();
}
function pauseGame() {
  if (game.state !== 'playing') return;
  game.state = 'paused';
  $('pause').classList.remove('hidden');
}
function resumeGame() {
  if (game.state !== 'paused') return;
  game.state = 'playing';
  $('pause').classList.add('hidden');
  lockPointer();
}
function lockPointer() {
  if (isTouch) return;
  try {
    const p = $('scene').requestPointerLock?.();
    if (p && p.catch) p.catch(() => {});
  } catch { /* headless / unsupported: game still runs */ }
}

// ---------- input ----------
const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Digit1') switchWeapon('ar');
  if (e.code === 'Digit2') switchWeapon('dmr');
  if (e.code === 'KeyP' || e.code === 'Escape') { /* Escape handled by pointerlock */ if (e.code === 'KeyP') { game.state === 'playing' ? pauseGame() : game.state === 'paused' && resumeGame(); } }
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });
function switchWeapon(k) {
  if (player.current === k || game.state !== 'playing') return;
  player.current = k;
  player.adsOn = false;
  gunModels.ar.visible = k === 'ar';
  gunModels.dmr.visible = k === 'dmr';
  AudioSys.reload();
  updateHUD();
}
document.addEventListener('mousemove', (e) => {
  if (!canvasLocked || game.state !== 'playing') return;
  const sens = 0.0021 * Number($('opt-sens')?.value || 1);
  player.yaw -= e.movementX * sens * (player.ads > 0.5 ? 0.6 : 1);
  player.pitch -= e.movementY * sens * (player.ads > 0.5 ? 0.6 : 1);
  player.pitch = clamp(player.pitch, -1.45, 1.45);
  gunModels[player.current].rotation.y = clamp(-e.movementX * 0.0004, -0.05, 0.05);
});
document.addEventListener('mousedown', (e) => {
  if (game.state !== 'playing') return;
  if (!canvasLocked && !isTouch) { lockPointer(); return; }
  if (e.button === 0) { player.triggerHeld = true; player._firedThisPress = false; }
  if (e.button === 2) player.adsOn = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) player.triggerHeld = false;
  if (e.button === 2) player.adsOn = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if (game.state !== 'playing') return;
  switchWeapon(player.current === 'ar' ? 'dmr' : 'ar');
}, { passive: true });
document.addEventListener('pointerlockchange', () => {
  canvasLocked = document.pointerLockElement === $('scene');
  if (!canvasLocked && game.state === 'playing' && !isTouch) pauseGame();
});
// touch controls
const stick = { active: false, id: -1, x: 0, y: 0 };
let lookTouch = { id: -1, lx: 0, ly: 0 };
if (isTouch) {
  const zone = $('stick-zone'), base = $('stick-base'), knob = $('stick-knob');
  zone.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    stick.active = true; stick.id = t.identifier;
    base.style.display = 'block';
    base.style.left = (t.clientX - 60) + 'px'; base.style.top = 'auto'; base.style.bottom = (window.innerHeight - t.clientY - 60) + 'px';
    e.preventDefault();
  }, { passive: false });
  zone.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stick.id) continue;
      const r = base.getBoundingClientRect();
      let dx = t.clientX - (r.left + 60), dy = t.clientY - (r.top + 60);
      const m = Math.hypot(dx, dy) || 1, max = 52;
      if (m > max) { dx *= max / m; dy *= max / m; }
      knob.style.left = (35 + dx) + 'px'; knob.style.top = (35 + dy) + 'px';
      stick.x = dx / max; stick.y = dy / max;
    }
    e.preventDefault();
  }, { passive: false });
  const endStick = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stick.id) continue;
      stick.active = false; stick.x = stick.y = 0;
      knob.style.left = '35px'; knob.style.top = '35px';
      base.style.display = 'none';
    }
  };
  zone.addEventListener('touchend', endStick); zone.addEventListener('touchcancel', endStick);
  $('scene').addEventListener('touchstart', (e) => {
    if (game.state !== 'playing') return;
    const t = e.changedTouches[0];
    lookTouch = { id: t.identifier, lx: t.clientX, ly: t.clientY };
  }, { passive: true });
  $('scene').addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouch.id) continue;
      const sens = 0.0042 * Number($('opt-sens')?.value || 1);
      player.yaw -= (t.clientX - lookTouch.lx) * sens;
      player.pitch = clamp(player.pitch - (t.clientY - lookTouch.ly) * sens, -1.45, 1.45);
      lookTouch.lx = t.clientX; lookTouch.ly = t.clientY;
    }
    e.preventDefault();
  }, { passive: false });
  $('btn-fire').addEventListener('touchstart', (e) => { player.triggerHeld = true; player._firedThisPress = false; e.preventDefault(); }, { passive: false });
  $('btn-fire').addEventListener('touchend', () => { player.triggerHeld = false; });
  $('btn-reload').addEventListener('touchstart', (e) => { startReload(); e.preventDefault(); }, { passive: false });
  $('btn-aim').addEventListener('touchstart', (e) => { player.adsOn = !player.adsOn; e.preventDefault(); }, { passive: false });
}
// menu wiring
$('btn-start').addEventListener('click', startRun);
$('btn-again').addEventListener('click', startRun);
$('btn-restart').addEventListener('click', startRun);
$('btn-resume').addEventListener('click', resumeGame);
$('btn-how').addEventListener('click', () => $('how-panel').classList.toggle('hidden'));
$('opt-vol')?.addEventListener('input', (e) => AudioSys.setVolume(Number(e.target.value)));
$('opt-shadows')?.addEventListener('change', (e) => {
  renderer.shadowMap.enabled = e.target.checked;
  sun.castShadow = e.target.checked;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
});
$('menu-best').textContent = localStorage.getItem(BEST_KEY) || 0;
AudioSys.volume = Number($('opt-vol')?.value || 0.7);

// ---------- per-frame player movement ----------
const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3();
function updatePlayer(dt, now) {
  // look applied via events; movement:
  const sprint = (keys.ShiftLeft || keys.ShiftRight) && player.ads < 0.3;
  const speed = (player.ads > 0.5 ? 3.4 : sprint ? 8.2 : 5.4);
  _fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  _rgt.set(-_fwd.z, 0, _fwd.x);
  // touch stick
  let ix = 0, iz = 0;
  if (keys.KeyW || keys.ArrowUp) iz += 1;
  if (keys.KeyS || keys.ArrowDown) iz -= 1;
  if (keys.KeyA || keys.ArrowLeft) ix -= 1;
  if (keys.KeyD || keys.ArrowRight) ix += 1;
  if (stick.active) { ix += stick.x; iz -= stick.y; }
  const il = Math.hypot(ix, iz);
  if (il > 1) { ix /= il; iz /= il; }
  _v1.set(0, 0, 0).addScaledVector(_fwd, iz).addScaledVector(_rgt, ix).multiplyScalar(speed);
  const accel = player.onGround ? 14 : 4;
  player.vel.x = lerp(player.vel.x, _v1.x, clamp(accel * dt, 0, 1));
  player.vel.z = lerp(player.vel.z, _v1.z, clamp(accel * dt, 0, 1));
  // jump / gravity
  if ((keys.Space) && player.onGround) { player.vy = 4.6; player.onGround = false; }
  player.vy -= 12.5 * dt;
  let ny = player.pos.y + player.vy * dt;
  if (ny <= EYE) { ny = EYE; player.vy = 0; player.onGround = true; }
  player.pos.y = ny;
  const tmp = { x: player.pos.x + player.vel.x * dt, z: player.pos.z + player.vel.z * dt };
  collideCircle(tmp, 0.6);
  player.pos.x = tmp.x; player.pos.z = tmp.z;
  camera.position.copy(player.pos);
  camera.rotation.set(player.pitch, player.yaw, 0);
  // footsteps
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (hSpeed > 2 && player.onGround) {
    player.stepT -= dt * hSpeed;
    if (player.stepT <= 0) { player.stepT = 3.4; AudioSys.step(); }
  }
  // ADS
  const adsTarget = (player.adsOn && game.state === 'playing') ? 1 : 0;
  player.ads = lerp(player.ads, adsTarget, clamp(12 * dt, 0, 1));
  const fov = lerp(78, 52, player.ads);
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = fov; camera.updateProjectionMatrix(); }
  hud.cross.classList.toggle('ads', player.ads > 0.6);
  const narrow = camera.aspect < 0.9;
  const gx = lerp(narrow ? 0.20 : 0.28, 0.0, player.ads), gy = lerp(-0.26, -0.185, player.ads);
  gunRig.position.x = lerp(gunRig.position.x, gx, clamp(12 * dt, 0, 1));
  gunRig.position.y = lerp(gunRig.position.y, gy + Math.sin(game.time * 2.2) * 0.004, clamp(12 * dt, 0, 1));
  // weapon bob + recoil recovery
  const bobA = clamp(hSpeed / 8, 0, 1) * (1 - player.ads * 0.8);
  gunRig.position.y += Math.abs(Math.sin(game.time * 9)) * 0.012 * bobA;
  gunRig.position.x += Math.sin(game.time * 4.5) * 0.006 * bobA;
  for (const k of Object.keys(gunModels)) {
    const gm = gunModels[k];
    gm.position.z = lerp(gm.position.z, 0, clamp(10 * dt, 0, 1));
    gm.rotation.x = lerp(gm.rotation.x, 0, clamp(10 * dt, 0, 1));
    gm.userData.flash.material.opacity = Math.max(0, gm.userData.flash.material.opacity - dt * 14);
  }
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 320);
  player.spreadBloom = Math.max(0, player.spreadBloom - dt * 0.05);
  hud.cross.style.setProperty('--spread', `${4 + player.spreadBloom * 900 - player.ads * 2}px`);
  // reload timers
  for (const k of ['ar', 'dmr']) {
    const w = player.weapons[k];
    if (w.reloading > 0) {
      w.reloading -= dt;
      if (w.reloading <= 0) { w.reloading = 0; finishReload(w); updateHUD(); }
    }
  }
  if (player.triggerHeld) tryFire(now);
  else if (!currentWeapon().auto) player._firedThisPress = false;
  player.hurtCd = Math.max(0, player.hurtCd - dt);
  // uplink capture
  const dx = player.pos.x - UPLINK.x, dz = player.pos.z - UPLINK.z;
  const inside = dx * dx + dz * dz < UPLINK.r * UPLINK.r;
  if (inside && game.state === 'playing') {
    game.capture += dt;
    if (game.capture >= 1) {
      game.capture = 0;
      player.score += 25; player.captureBonus += 25;
      player.weapons.ar.reserve = Math.min(300, player.weapons.ar.reserve + 6);
      AudioSys.uplink();
      updateHUD();
    }
    hud.hint.textContent = 'CAPTURING UPLINK… +25 PTS/S';
    hud.hint.classList.remove('hidden');
  } else hud.hint.classList.add('hidden');
}

// ---------- minimap ----------
const mm = $('minimap').getContext('2d');
let mmTick = 0;
function drawMinimap() {
  const S = 148, C = S / 2, scale = C / (ARENA + 6);
  mm.clearRect(0, 0, S, S);
  mm.fillStyle = 'rgba(6,12,14,0.9)';
  mm.beginPath(); mm.arc(C, C, C - 2, 0, Math.PI * 2); mm.fill();
  mm.save();
  mm.beginPath(); mm.arc(C, C, C - 2, 0, Math.PI * 2); mm.clip();
  // walls
  mm.strokeStyle = 'rgba(200,200,200,0.5)'; mm.lineWidth = 2;
  mm.strokeRect(C - (ARENA + 4) * scale, C - (ARENA + 4) * scale, (ARENA + 4) * 2 * scale, (ARENA + 4) * 2 * scale);
  // uplink
  mm.fillStyle = '#57e6c9';
  mm.beginPath(); mm.arc(C + UPLINK.x * scale, C + UPLINK.z * scale, UPLINK.r * scale, 0, Math.PI * 2); mm.globalAlpha = 0.35; mm.fill(); mm.globalAlpha = 1;
  // pickups
  for (const p of pickups) {
    mm.fillStyle = p.kind === 'med' ? '#54ff8a' : p.kind === 'armor' ? '#3fa9ff' : '#ffb454';
    mm.fillRect(C + p.mesh.position.x * scale - 2, C + p.mesh.position.z * scale - 2, 4, 4);
  }
  // enemies (rotated so up = player forward)
  mm.save();
  mm.translate(C, C); mm.rotate(-player.yaw + Math.PI); mm.translate(-C, -C);
  const px = C + player.pos.x * scale, pz = C + player.pos.z * scale;
  for (const e of enemies) {
    mm.fillStyle = '#ff5a5a';
    mm.beginPath(); mm.arc(C + e.grp.position.x * scale, C + e.grp.position.z * scale, 3, 0, Math.PI * 2); mm.fill();
  }
  mm.restore();
  // player arrow
  mm.fillStyle = '#ffd58a';
  mm.save(); mm.translate(px, pz);
  mm.beginPath(); mm.moveTo(0, -7); mm.lineTo(5, 5); mm.lineTo(-5, 5); mm.closePath(); mm.fill();
  mm.restore();
  mm.restore();
}

// ---------- uplink ring pulse ----------
const uplinkRing = scene.getObjectByName('uplink-ring');

// ---------- main loop ----------
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now() / 1000;
  if (game.state === 'playing') {
    game.time += dt;
    updateSpawns(dt);
    updatePlayer(dt, now);
    updateEnemies(dt, now);
    updatePickups(dt);
    if (uplinkRing) {
      uplinkRing.material.opacity = 0.6 + Math.sin(game.time * 3) * 0.25;
      const s = 1 + Math.sin(game.time * 3) * 0.01;
      uplinkRing.scale.set(s, s, 1);
    }
    if (++mmTick % 2 === 0) drawMinimap();
  } else if (game.state === 'menu' || game.state === 'victory' || game.state === 'dead') {
    // slow cinematic orbit behind the menu
    game.time += dt;
    const a = game.time * 0.08;
    camera.position.set(Math.sin(a) * 30, 9 + Math.sin(game.time * 0.3) * 1.5, Math.cos(a) * 30);
    camera.lookAt(0, 2, 0);
    camera.fov = lerp(camera.fov, 60, 0.02); camera.updateProjectionMatrix();
    updateEnemies(dt, now); // let leftover bots mill around on end screen
    updateParticles(dt); updateTracers(dt);
    updatePickups(dt);
    renderer.render(scene, camera);
    return;
  } else if (game.state === 'paused') {
    renderer.render(scene, camera);
    return;
  }
  updateParticles(dt);
  updateTracers(dt);
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// menu backdrop: place camera for a good first frame before loop starts
camera.position.set(20, 8, 34);
camera.lookAt(0, 2, 0);
updateHUD();
frame();

// debug / verification handle
window.__strikepoint = { game, player, enemies, startRun, THREE, tryFire, spawnEnemy, startReload, switchWeapon, killEnemy, endRun, pauseGame, resumeGame };
