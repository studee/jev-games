import { initLatencyChart, recordLatency } from "./latency.ts";
import type { GameSnapshot, Phase, PilotResponse } from "./types.ts";

type Point = { x: number; y: number };
type Bird = {
  x: number;
  y: number;
  vy: number;
  rot: number;
  wing: number;
  alive: boolean;
};
type Pipe = { x: number; top: number; gap: number; scored: boolean };
type Cloud = { x: number; y: number; s: number; v: number };
type Building = { x: number; w: number; h: number; windows: number };
type Bush = { x: number; y: number; s: number };
type Forecast = {
  y: number;
  hit: boolean;
  hitTop: boolean;
  hitBottom: boolean;
  hitGround: boolean;
  frames: number;
};

const WORLD_W = 420;
const WORLD_H = 720;
const GROUND_H = 112;
const BIRD_X = 118;
const BIRD_R = 16;
const PIPE_W = 72;
const PIPE_CAP = 28;
const BEST_KEY = "flappy-bird-best";

const STATE = {
  READY: "ready",
  PLAYING: "playing",
  DYING: "dying",
  OVER: "over",
} as const satisfies Record<string, Phase>;

const canvasEl = document.getElementById("game");
if (!(canvasEl instanceof HTMLCanvasElement)) {
  throw new Error("Missing #game canvas");
}
const canvas: HTMLCanvasElement = canvasEl;
const context = canvas.getContext("2d");
if (!context) throw new Error("2D canvas is not available");
const ctx: CanvasRenderingContext2D = context;

const audio: { ctx: AudioContext | null; muted: boolean } = {
  ctx: null,
  muted: false,
};

function createBird(): Bird {
  return { x: BIRD_X, y: 400, vy: 0, rot: 0, wing: 0, alive: true };
}

function seedClouds(): Cloud[] {
  return Array.from({ length: 6 }, (_, i) => ({
    x: (i * 110 + 40) % (WORLD_W + 160),
    y: 50 + ((i * 47) % 160),
    s: 0.7 + (i % 3) * 0.25,
    v: 0.18 + (i % 3) * 0.06,
  }));
}

function seedBuildings(): Building[] {
  const items: Building[] = [];
  let x = -20;
  while (x < WORLD_W + 80) {
    const w = 36 + ((x * 13) % 28);
    const h = 50 + ((x * 17) % 90);
    items.push({ x, w, h, windows: 2 + ((x * 3) % 3) });
    x += w + 8;
  }
  return items;
}

function seedBushes(): Bush[] {
  return Array.from({ length: 8 }, (_, i) => ({
    x: i * 70 + 10,
    y: WORLD_H - GROUND_H - 18,
    s: 0.8 + (i % 3) * 0.2,
  }));
}

const game = {
  state: STATE.READY as Phase,
  night: false,
  frame: 0,
  score: 0,
  best: Number(localStorage.getItem(BEST_KEY) || 0),
  bird: createBird(),
  pipes: [] as Pipe[],
  spawnTimer: 0,
  flash: 0,
  overDelay: 0,
  groundX: 0,
  clouds: seedClouds(),
  buildings: seedBuildings(),
  bushes: seedBushes(),
};

const pilot = {
  enabled: true,
  busy: false,
  lastFlapAt: 0,
  lastAction: "STARTING",
  lastMeta: "calling Jev…",
  shouldFlap: 0,
  flash: 0,
  calls: 0,
};

const feedAction = document.getElementById("pilot-action");
const feedMeta = document.getElementById("pilot-meta");
const feedList = document.getElementById("decisions");

function ensureAudio(): void {
  if (audio.ctx) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return;
  audio.ctx = new Ctor();
}

function beep(freq: number, duration: number, type: OscillatorType, gain: number): void {
  if (audio.muted || !audio.ctx) return;
  const t = audio.ctx.currentTime;
  const osc = audio.ctx.createOscillator();
  const g = audio.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(g);
  g.connect(audio.ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

function sfxFlap(): void {
  beep(520, 0.09, "square", 0.05);
}
function sfxScore(): void {
  beep(880, 0.08, "triangle", 0.06);
  setTimeout(() => beep(1170, 0.1, "triangle", 0.05), 70);
}
function sfxHit(): void {
  beep(140, 0.22, "sawtooth", 0.08);
}
function sfxDie(): void {
  beep(220, 0.18, "square", 0.05);
  setTimeout(() => beep(140, 0.28, "square", 0.05), 90);
}

function resetRound(keepTheme = false): void {
  game.state = STATE.READY;
  game.score = 0;
  game.bird = createBird();
  game.pipes = [];
  game.spawnTimer = 0;
  game.flash = 0;
  game.overDelay = 0;
  if (!keepTheme) game.night = Math.random() < 0.28;
}

function startPlay(): void {
  if (game.state !== STATE.READY) return;
  game.state = STATE.PLAYING;
  game.spawnTimer = 88;
  game.bird.y = 400;
  game.bird.vy = 0;
}

function flapBird(): void {
  if (game.state === STATE.OVER || game.state === STATE.DYING) return;
  game.bird.vy = -8.6;
  game.bird.wing = 0;
  sfxFlap();
}

function currentGap(): number {
  return Math.max(128, 168 - game.score * 1.1);
}

function currentSpeed(): number {
  return Math.min(4.15, 2.55 + game.score * 0.045);
}

function groundY(): number {
  return WORLD_H - GROUND_H - 4;
}

function upcomingPipe(): Pipe | null {
  return game.pipes.find((p) => p.x + PIPE_W >= game.bird.x - BIRD_R) ?? null;
}

function forecast(flapNow: boolean): Forecast {
  const pipe = upcomingPipe();
  const speed = currentSpeed();
  const floor = groundY();
  const r = BIRD_R - 3;
  let y = game.bird.y;
  let vy = flapNow ? -8.6 : game.bird.vy;
  let px = pipe ? pipe.x : 9999;
  let hitTop = false;
  let hitBottom = false;
  let hitGround = false;
  let frames = 0;
  const max = 200;
  for (; frames < max; frames++) {
    vy = Math.min(12.5, vy + 0.48);
    y += vy;
    px -= speed;
    if (y + BIRD_R > floor || y < -30) {
      hitGround = true;
      break;
    }
    if (pipe && px < game.bird.x + r && px + PIPE_W > game.bird.x - r) {
      if (y - r < pipe.top) {
        hitTop = true;
        break;
      }
      if (y + r > pipe.top + pipe.gap) {
        hitBottom = true;
        break;
      }
    }
    if (pipe && px + PIPE_W < game.bird.x - BIRD_R) break;
  }
  return {
    y: Math.round(y),
    hit: hitTop || hitBottom || hitGround,
    hitTop,
    hitBottom,
    hitGround,
    frames,
  };
}

function snapshot(): GameSnapshot {
  const pipe = upcomingPipe();
  const wait = forecast(false);
  const flapPath = forecast(true);
  return {
    rules: [
      "Flappy Bird. The bird's x stays fixed; pipes move left.",
      "Screen y grows downward: 0 is the top of the sky, larger y is closer to the ground.",
      "A flap instantly sets a strong upward velocity (smaller y).",
      "Stay in the lower half of the pipe gap. Do not flap if the bird is near the top pipe.",
      "Decide now; the next answer usually arrives in about 300ms.",
    ].join(" "),
    phase: game.state,
    score: game.score,
    bird_from_top_px: Math.round(game.bird.y),
    bird_vy: Math.round(game.bird.vy * 10) / 10,
    ground_from_top_px: groundY(),
    next_pipe: pipe
      ? {
          px_until_pipe: Math.round(pipe.x - game.bird.x),
          gap_top_from_top_px: Math.round(pipe.top),
          gap_bottom_from_top_px: Math.round(pipe.top + pipe.gap),
          gap_center_from_top_px: Math.round(pipe.top + pipe.gap / 2),
        }
      : "no pipe on screen yet; keep the bird in the middle of the sky",
    if_wait_hits: wait.hit,
    if_flap_now_hits: flapPath.hit,
    waiting_hits: wait.hit,
    flapping_survives: !flapPath.hit,
  };
}

function setPilotStatus(action: string, meta: string): void {
  pilot.lastAction = action;
  pilot.lastMeta = meta;
  if (feedAction) feedAction.textContent = action;
  if (feedMeta) feedMeta.textContent = meta;
}

function logDecision(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 14) feedList.removeChild(feedList.lastChild as Node);
}

function tooCloseToCeiling(pipe: Pipe | null): boolean {
  if (!pipe) return game.bird.y < 310;
  return game.bird.y < pipe.top + 56;
}

function steer(): void {
  if (!pilot.enabled || game.state !== STATE.PLAYING) return;
  const now = performance.now();
  if (now - pilot.lastFlapAt < 170) return;
  if (game.bird.vy < -1.2) return;

  const pipe = upcomingPipe();
  if (tooCloseToCeiling(pipe)) return;

  const target = pipe ? pipe.top + pipe.gap * 0.72 : 410;
  const wait = forecast(false);
  const lift = forecast(true);
  if (wait.hitTop && !wait.hitBottom && !wait.hitGround) return;
  if (lift.hitTop) return;

  const tooLow = game.bird.y > target && game.bird.vy > 0.35;
  const mustJump = wait.hitBottom || wait.hitGround;
  if (!(mustJump || tooLow)) return;

  flapBird();
  pilot.lastFlapAt = now;
  pilot.flash = 1;
  const why = mustJump ? "need jump" : "below gap";
  setPilotStatus("FLAP", why);
  logDecision("flap", `FLAP  ${why}`);
}

async function askJev(): Promise<void> {
  if (!pilot.enabled || pilot.busy) return;
  if (game.state === STATE.READY) {
    startPlay();
    setPilotStatus("PLAYING", "Jev has the controls");
    return;
  }
  if (game.state === STATE.OVER && game.overDelay <= 0) {
    resetRound(true);
    feedList?.replaceChildren();
    setPilotStatus("RESTART", "next round");
    return;
  }
  if (game.state !== STATE.PLAYING) return;

  const state = snapshot();
  pilot.busy = true;
  const t0 = performance.now();
  try {
    const res = await fetch("/api/pilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    const ms = Math.round(performance.now() - t0);
    recordLatency(ms);
    const data = (await res.json()) as PilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    pilot.calls += 1;
    const wantFlap = Boolean(data.flap) || Number(data.should_flap) >= 0.45;
    pilot.shouldFlap = Number(data.should_flap);
    const should = Number(data.should_flap).toFixed(2);
    const over = Number(data.would_overshoot).toFixed(2);
    if (wantFlap && performance.now() - pilot.lastFlapAt > 170) {
      const pipe = upcomingPipe();
      if (!tooCloseToCeiling(pipe) && game.bird.vy > -1.2 && !forecast(true).hitTop) {
        flapBird();
        pilot.lastFlapAt = performance.now();
        pilot.flash = 1;
      }
    }
    const action = wantFlap ? "FLAP" : "WAIT";
    setPilotStatus(action, `${ms}ms · flap ${should} · overshoot ${over}`);
    logDecision(wantFlap ? "flap" : "wait", `${action}  ${should}  ${ms}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Jev call failed";
    setPilotStatus("ERROR", message);
    logDecision("error", message);
  } finally {
    pilot.busy = false;
  }
}

function spawnPipe(): void {
  const gap = currentGap();
  const floor = WORLD_H - GROUND_H;
  const minTop = 70;
  const maxTop = floor - gap - 70;
  const top = minTop + Math.random() * (maxTop - minTop);
  game.pipes.push({ x: WORLD_W + 20, top, gap, scored: false });
}

function circleRectHits(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function hitPipes(bird: Bird): boolean {
  const r = BIRD_R - 3;
  const floor = WORLD_H - GROUND_H;
  for (const p of game.pipes) {
    if (circleRectHits(bird.x, bird.y, r, p.x, 0, PIPE_W, p.top)) return true;
    const bottomY = p.top + p.gap;
    if (circleRectHits(bird.x, bird.y, r, p.x, bottomY, PIPE_W, floor - bottomY)) return true;
  }
  return false;
}

function kill(): void {
  if (game.state !== STATE.PLAYING) return;
  game.state = STATE.DYING;
  game.flash = 1;
  game.bird.alive = false;
  game.bird.vy = Math.min(game.bird.vy, 2);
  sfxHit();
  sfxDie();
  if (game.score > game.best) {
    game.best = game.score;
    localStorage.setItem(BEST_KEY, String(game.best));
  }
}

function update(dt: number): void {
  game.frame += dt;
  game.groundX = (game.groundX - currentSpeed() * dt * (game.state === STATE.READY ? 0.7 : 1)) % 48;
  for (const c of game.clouds) {
    c.x -= c.v * dt;
    if (c.x < -80) c.x = WORLD_W + 60;
  }

  if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 0.08);
  if (pilot.flash > 0) pilot.flash = Math.max(0, pilot.flash - dt * 0.12);

  const bird = game.bird;
  bird.wing += (game.state === STATE.PLAYING ? 0.55 : 0.22) * dt;

  if (game.state === STATE.READY) {
    bird.y = 400 + Math.sin(game.frame * 0.08) * 7;
    bird.vy = 0;
    bird.rot = 0;
    return;
  }

  bird.vy += 0.48 * dt;
  bird.vy = Math.min(bird.vy, 12.5);
  bird.y += bird.vy * dt;
  bird.rot += (Math.min(1.25, Math.max(-0.55, bird.vy * 0.075)) - bird.rot) * 0.18 * dt;

  const floor = WORLD_H - GROUND_H - 4;
  if (bird.y + BIRD_R > floor) {
    bird.y = floor - BIRD_R;
    bird.vy = 0;
    if (game.state === STATE.PLAYING) kill();
    if (game.state === STATE.DYING) {
      game.state = STATE.OVER;
      game.overDelay = 18;
    }
  }

  if (game.state === STATE.PLAYING) {
    steer();
    game.spawnTimer -= dt;
    if (game.spawnTimer <= 0) {
      spawnPipe();
      game.spawnTimer = 92;
    }

    const speed = currentSpeed();
    for (const p of game.pipes) {
      p.x -= speed * dt;
      if (!p.scored && p.x + PIPE_W < bird.x) {
        p.scored = true;
        game.score += 1;
        sfxScore();
      }
    }
    game.pipes = game.pipes.filter((p) => p.x > -PIPE_W - 10);

    if (hitPipes(bird) || bird.y < -30) kill();
  }

  if (game.state === STATE.DYING && bird.y + BIRD_R >= floor - 0.5) {
    game.state = STATE.OVER;
    game.overDelay = 18;
  }

  if (game.state === STATE.OVER) {
    game.overDelay = Math.max(0, game.overDelay - dt);
  }
}

function skyColors(): [string, string, string] {
  if (game.night) return ["#0b1c3a", "#16345d", "#1d4b72"];
  return ["#70d4de", "#4ec0ca", "#7ad3c0"];
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawSky(): void {
  const [a, b, c] = skyColors();
  const g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  g.addColorStop(0, a);
  g.addColorStop(0.55, b);
  g.addColorStop(1, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  if (game.night) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < 28; i++) {
      const x = (i * 73 + 18) % WORLD_W;
      const y = 20 + ((i * 41) % 240);
      ctx.globalAlpha = 0.35 + ((i * 17) % 50) / 100;
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#f7e7a1";
    ctx.beginPath();
    ctx.arc(330, 78, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#16345d";
    ctx.beginPath();
    ctx.arc(338, 72, 16, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(255,236,150,0.9)";
    ctx.beginPath();
    ctx.arc(68, 72, 26, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCloud(c: Cloud): void {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(c.s, c.s);
  ctx.fillStyle = game.night ? "rgba(190,210,230,0.35)" : "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.arc(-18, 6, 16, 0, Math.PI * 2);
  ctx.arc(4, 0, 22, 0, Math.PI * 2);
  ctx.arc(24, 8, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCity(): void {
  const base = WORLD_H - GROUND_H - 26;
  ctx.fillStyle = game.night ? "#24364c" : "#d7ece2";
  for (const b of game.buildings) {
    ctx.fillRect(b.x, base - b.h, b.w, b.h);
    ctx.fillStyle = game.night ? "#f4d27a" : "#8ec4b8";
    const cols = b.windows;
    const rows = Math.max(2, Math.floor(b.h / 16));
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        if ((r + col + b.x) % 5 === 0) continue;
        ctx.fillRect(b.x + 6 + col * 10, base - b.h + 8 + r * 14, 5, 7);
      }
    }
    ctx.fillStyle = game.night ? "#24364c" : "#d7ece2";
  }
}

function drawBush(b: Bush): void {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.scale(b.s, b.s);
  ctx.fillStyle = game.night ? "#2f6a3a" : "#73c13a";
  ctx.beginPath();
  ctx.arc(-12, 8, 16, 0, Math.PI * 2);
  ctx.arc(8, 0, 20, 0, Math.PI * 2);
  ctx.arc(24, 10, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = game.night ? "#3f8848" : "#8ee04c";
  ctx.beginPath();
  ctx.arc(4, -4, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPipe(p: Pipe): void {
  const floor = WORLD_H - GROUND_H;
  const body = game.night ? "#3e8f32" : "#59bf2b";
  const dark = game.night ? "#24661d" : "#3e8a1c";
  const lite = game.night ? "#7ad24a" : "#98e24f";
  const lip = game.night ? "#2f7a26" : "#4aa822";

  function column(x: number, y: number, h: number): void {
    ctx.fillStyle = body;
    ctx.fillRect(x + 6, y, PIPE_W - 12, h);
    ctx.fillStyle = lite;
    ctx.fillRect(x + 10, y, 8, h);
    ctx.fillStyle = dark;
    ctx.fillRect(x + PIPE_W - 16, y, 8, h);
    ctx.strokeStyle = "#1d4d12";
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 6.5, y + 0.5, PIPE_W - 13, h - 1);
  }

  function cap(x: number, y: number): void {
    roundRect(x, y, PIPE_W, PIPE_CAP, 6);
    ctx.fillStyle = lip;
    ctx.fill();
    ctx.fillStyle = lite;
    ctx.fillRect(x + 8, y + 5, 10, PIPE_CAP - 10);
    ctx.fillStyle = dark;
    ctx.fillRect(x + PIPE_W - 16, y + 5, 8, PIPE_CAP - 10);
    ctx.strokeStyle = "#1d4d12";
    ctx.lineWidth = 3;
    roundRect(x + 1.5, y + 1.5, PIPE_W - 3, PIPE_CAP - 3, 5);
    ctx.stroke();
  }

  column(p.x, 0, p.top);
  cap(p.x, p.top - PIPE_CAP);
  const bottomY = p.top + p.gap;
  column(p.x, bottomY, floor - bottomY);
  cap(p.x, bottomY);
}

function drawGround(): void {
  const y = WORLD_H - GROUND_H;
  ctx.fillStyle = game.night ? "#c9b36a" : "#ded895";
  ctx.fillRect(0, y, WORLD_W, GROUND_H);
  ctx.fillStyle = game.night ? "#3f8f2e" : "#5adc4a";
  ctx.fillRect(0, y, WORLD_W, 22);
  ctx.fillStyle = game.night ? "#2f6e22" : "#449e34";
  ctx.fillRect(0, y + 22, WORLD_W, 6);
  ctx.fillStyle = game.night ? "#4aa338" : "#73e85a";
  for (let x = game.groundX - 48; x < WORLD_W + 48; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, y + 22);
    ctx.quadraticCurveTo(x + 12, y - 2, x + 24, y + 22);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  for (let x = 8; x < WORLD_W; x += 18) {
    for (let row = 0; row < 4; row++) {
      ctx.fillRect(x + ((row * 9) % 12), y + 40 + row * 16, 3, 3);
    }
  }
  ctx.fillStyle = "#1d4d12";
  ctx.fillRect(0, y, WORLD_W, 3);
}

function drawBird(): void {
  const b = game.bird;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  const wing = Math.sin(b.wing) * 0.55;

  ctx.fillStyle = "rgba(0,0,0,0.16)";
  ctx.beginPath();
  ctx.ellipse(4, 16, 14, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f8d34a";
  ctx.beginPath();
  ctx.ellipse(0, 0, 20, 15, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fff1a8";
  ctx.beginPath();
  ctx.ellipse(-4, 4, 12, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(-4, 2);
  ctx.rotate(wing - 0.25);
  ctx.fillStyle = "#f08a2a";
  ctx.beginPath();
  ctx.ellipse(0, 0, 13, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffd36a";
  ctx.beginPath();
  ctx.ellipse(-2, -1, 7, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#f08a2a";
  ctx.beginPath();
  ctx.ellipse(10, -8, 7, 5, -0.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(10, -3, 6.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#3a2a12";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(12.2, -3, 2.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f26b1d";
  ctx.beginPath();
  ctx.moveTo(16, -1);
  ctx.lineTo(30, 2);
  ctx.lineTo(16, 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ff9448";
  ctx.beginPath();
  ctx.moveTo(16, 1);
  ctx.lineTo(28, 3.5);
  ctx.lineTo(16, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawOutlinedText(text: string, x: number, y: number, size: number, fill = "#fff"): void {
  ctx.font = `${size}px "Press Start 2P", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#3a2a12";
  ctx.lineWidth = Math.max(4, size / 4);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function drawMute(): void {
  const x = WORLD_W - 42;
  const y = 18;
  roundRect(x, y, 28, 24, 6);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillRect(x + 6, y + 8, 6, 8);
  ctx.beginPath();
  ctx.moveTo(x + 12, y + 8);
  ctx.lineTo(x + 18, y + 5);
  ctx.lineTo(x + 18, y + 19);
  ctx.lineTo(x + 12, y + 16);
  ctx.closePath();
  ctx.fill();
  if (audio.muted) {
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 7, y + 6);
    ctx.lineTo(x + 21, y + 18);
    ctx.stroke();
  }
}

function drawPilotHud(): void {
  roundRect(12, 14, 118, 34, 8);
  ctx.fillStyle = pilot.enabled ? "rgba(42,74,40,0.92)" : "rgba(0,0,0,0.35)";
  ctx.fill();
  ctx.font = `9px "Press Start 2P", monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff4a3";
  ctx.fillText(pilot.enabled ? "JEV ON" : "JEV OFF", 22, 32);

  if (pilot.flash > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, pilot.flash);
    ctx.font = `14px "Press Start 2P", monospace`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff4a3";
    ctx.fillText("FLAP", game.bird.x, game.bird.y - 36);
    ctx.restore();
  }
}

function drawReady(): void {
  drawOutlinedText("FLAPPY BIRD", WORLD_W / 2, 118, 22, "#fff4a3");
  drawOutlinedText("GET READY", WORLD_W / 2, 168, 16);
  roundRect(WORLD_W / 2 - 96, WORLD_H - GROUND_H - 78, 192, 42, 10);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fill();
  ctx.font = `10px "Press Start 2P", monospace`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.fillText(pilot.enabled ? "JEV FLYING" : "TAP / SPACE", WORLD_W / 2, WORLD_H - GROUND_H - 57);
}

function medalColor(): [string, string] | null {
  if (game.score >= 40) return ["#e8f4ff", "#8fd0ff"];
  if (game.score >= 20) return ["#ffe27a", "#f0b400"];
  if (game.score >= 10) return ["#e8e8e8", "#9aa3ad"];
  if (game.score >= 5) return ["#e0a070", "#a85a28"];
  return null;
}

function drawOver(): void {
  roundRect(46, 168, WORLD_W - 92, 268, 16);
  ctx.fillStyle = "#f3e2b2";
  ctx.fill();
  ctx.strokeStyle = "#6b4a1e";
  ctx.lineWidth = 5;
  ctx.stroke();

  drawOutlinedText("GAME OVER", WORLD_W / 2, 150, 20, "#fff4a3");
  ctx.fillStyle = "#c07a2a";
  ctx.font = `10px "Press Start 2P", monospace`;
  ctx.textAlign = "left";
  ctx.fillText("SCORE", 78, 220);
  ctx.fillText("BEST", 78, 292);
  ctx.textAlign = "right";
  ctx.fillStyle = "#3a2a12";
  ctx.font = `20px "Press Start 2P", monospace`;
  ctx.fillText(String(game.score), WORLD_W - 78, 252);
  ctx.fillText(String(game.best), WORLD_W - 78, 324);

  const medal = medalColor();
  if (medal) {
    const [a, b] = medal;
    const g = ctx.createRadialGradient(110, 318, 4, 110, 322, 28);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(110, 322, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b4a1e";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#3a2a12";
    ctx.font = `10px "Press Start 2P", monospace`;
    ctx.textAlign = "center";
    ctx.fillText("M", 110, 326);
  }

  roundRect(WORLD_W / 2 - 78, 392, 156, 46, 10);
  ctx.fillStyle = "#f0c63a";
  ctx.fill();
  ctx.strokeStyle = "#6b4a1e";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "#3a2a12";
  ctx.font = `12px "Press Start 2P", monospace`;
  ctx.textAlign = "center";
  ctx.fillText("RESTART", WORLD_W / 2, 418);
}

function draw(): void {
  ctx.setTransform(canvas.width / WORLD_W, 0, 0, canvas.height / WORLD_H, 0, 0);
  drawSky();
  for (const c of game.clouds) drawCloud(c);
  drawCity();
  for (const b of game.bushes) drawBush(b);
  for (const p of game.pipes) drawPipe(p);
  drawGround();
  drawBird();

  if (game.state === STATE.PLAYING || game.state === STATE.DYING) {
    drawOutlinedText(String(game.score), WORLD_W / 2, 64, 28);
  }
  if (game.state === STATE.READY) drawReady();
  if (game.state === STATE.OVER) drawOver();
  drawMute();
  drawPilotHud();

  if (game.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${game.flash * 0.7})`;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  }
}

function resize(): void {
  const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function canvasPoint(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * WORLD_W,
    y: ((event.clientY - rect.top) / rect.height) * WORLD_H,
  };
}

function inMute(p: Point): boolean {
  return p.x >= WORLD_W - 46 && p.x <= WORLD_W - 10 && p.y >= 14 && p.y <= 48;
}

function inPilot(p: Point): boolean {
  return p.x >= 12 && p.x <= 130 && p.y >= 14 && p.y <= 48;
}

function onPointer(event: PointerEvent): void {
  event.preventDefault();
  ensureAudio();
  void audio.ctx?.resume();
  const p = canvasPoint(event);
  if (inMute(p)) {
    audio.muted = !audio.muted;
    return;
  }
  if (inPilot(p)) {
    pilot.enabled = !pilot.enabled;
    setPilotStatus(
      pilot.enabled ? "JEV ON" : "MANUAL",
      pilot.enabled ? "Jev has the controls" : "tap to flap",
    );
    return;
  }
  if (pilot.enabled) return;
  if (game.state === STATE.READY) {
    startPlay();
    return;
  }
  if (game.state === STATE.PLAYING) {
    flapBird();
    return;
  }
  if (game.state === STATE.OVER && game.overDelay <= 0) resetRound(true);
}

function onKey(event: KeyboardEvent): void {
  if (event.repeat) return;
  if (event.code === "KeyM") {
    audio.muted = !audio.muted;
    return;
  }
  if (event.code === "KeyJ") {
    pilot.enabled = !pilot.enabled;
    setPilotStatus(
      pilot.enabled ? "JEV ON" : "MANUAL",
      pilot.enabled ? "Jev has the controls" : "tap to flap",
    );
    return;
  }
  if (pilot.enabled) return;
  if (event.code === "Space" || event.code === "ArrowUp" || event.code === "KeyW") {
    event.preventDefault();
    ensureAudio();
    void audio.ctx?.resume();
    if (game.state === STATE.READY) startPlay();
    else if (game.state === STATE.PLAYING) flapBird();
    else if (game.state === STATE.OVER && game.overDelay <= 0) resetRound(true);
  }
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(2.2, (now - last) / (1000 / 60));
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

canvas.addEventListener("pointerdown", onPointer);
window.addEventListener("keydown", onKey, { passive: false });
window.addEventListener("resize", resize);
resize();
initLatencyChart();
setPilotStatus("JEV ON", "first decision coming up");
setInterval(() => {
  void askJev();
}, 120);
requestAnimationFrame(loop);

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
