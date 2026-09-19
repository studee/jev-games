import { initLatencyChart, recordLatency } from "./latency.ts";
import type { SurvivalPeer, SurvivalPilotResponse, SurvivalRole, SurvivalSnapshot } from "./types.ts";

const W = 720;
const H = 720;
const CX = W / 2;
const CY = H / 2;
const ARENA = 318;
const DOT = 16;
const GREEN_SPD = 2.55;
const RED_SPD = 2.55;
const TURN = 0.2;
const N = 10;

type Dot = {
  id: number;
  name: string;
  you: boolean;
  red: boolean;
  x: number;
  y: number;
  heading: number;
  want: number;
  askAt: number;
  busy: boolean;
  taggedAt: number;
};

type Phase = "run" | "over";

const canvasEl = document.getElementById("game");
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error("Missing #game canvas");
const canvas: HTMLCanvasElement = canvasEl;
const context = canvas.getContext("2d");
if (!context) throw new Error("2D canvas is not available");
const ctx: CanvasRenderingContext2D = context;

const feedAction = document.getElementById("pilot-action");
const feedMeta = document.getElementById("pilot-meta");
const feedList = document.getElementById("decisions");

const keys = new Set<string>();
const dots: Dot[] = [];
let phase: Phase = "run";
let pointer: { x: number; y: number } | null = null;
let lastTag = 0;

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function angNorm(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function angMix(a: number, b: number, t: number): number {
  return a + angNorm(b - a) * t;
}

function bearing(from: Dot, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function edgeDist(d: Dot): number {
  return ARENA - DOT - Math.hypot(d.x - CX, d.y - CY);
}

function roleOf(d: Dot): SurvivalRole {
  return d.red ? "hunter" : "prey";
}

function greens(): Dot[] {
  return dots.filter((d) => !d.red);
}

function reds(): Dot[] {
  return dots.filter((d) => d.red);
}

function you(): Dot | undefined {
  return dots.find((d) => d.you);
}

function setStatus(action: string, meta: string): void {
  if (feedAction) feedAction.textContent = action;
  if (feedMeta) feedMeta.textContent = meta;
}

function logLine(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 12) feedList.removeChild(feedList.lastChild as Node);
}

function nearest(d: Dot, pred: (o: Dot) => boolean): Dot | null {
  let best: Dot | null = null;
  let bestD = Infinity;
  for (const o of dots) {
    if (o.id === d.id || !pred(o)) continue;
    const r = dist(d, o);
    if (r < bestD) {
      bestD = r;
      best = o;
    }
  }
  return best;
}

function peerView(me: Dot, o: Dot): SurvivalPeer {
  return {
    id: o.id,
    role: roleOf(o),
    x: Math.round(o.x),
    y: Math.round(o.y),
    dist: Math.round(dist(me, o)),
    bearing_deg: Math.round((bearing(me, o) * 180) / Math.PI),
  };
}

function huntClaims(): Map<number, Dot | null> {
  const map = new Map<number, Dot | null>();
  const usedG = new Set<number>();
  const usedR = new Set<number>();
  const pairs: { r: Dot; g: Dot; d: number }[] = [];
  for (const r of reds()) {
    for (const g of greens()) pairs.push({ r, g, d: dist(r, g) });
  }
  pairs.sort((a, b) => a.d - b.d || a.r.id - b.r.id);
  for (const p of pairs) {
    if (usedR.has(p.r.id) || usedG.has(p.g.id)) continue;
    map.set(p.r.id, p.g);
    usedR.add(p.r.id);
    usedG.add(p.g.id);
  }
  for (const r of reds()) if (!map.has(r.id)) map.set(r.id, null);
  return map;
}

function coverPoint(d: Dot): { x: number; y: number } {
  const pack = reds().slice().sort((a, b) => a.id - b.id);
  const i = Math.max(0, pack.findIndex((h) => h.id === d.id));
  const a = (i / Math.max(pack.length, 1)) * Math.PI * 2 + 0.35;
  return { x: CX + Math.cos(a) * ARENA * 0.48, y: CY + Math.sin(a) * ARENA * 0.48 };
}

function redSpread(d: Dot): { x: number; y: number } {
  let x = 0;
  let y = 0;
  const range = DOT * 12;
  for (const o of dots) {
    if (o.id === d.id || !o.red) continue;
    const r = dist(d, o);
    if (r < 0.001 || r > range) continue;
    const w = ((range - r) / range) ** 2;
    x += ((d.x - o.x) / r) * w;
    y += ((d.y - o.y) / r) * w;
  }
  return { x, y };
}

function greenSpread(d: Dot): { x: number; y: number } {
  let x = 0;
  let y = 0;
  const range = DOT * 10;
  for (const o of dots) {
    if (o.id === d.id || o.red) continue;
    const r = dist(d, o);
    if (r < 0.001 || r > range) continue;
    const w = ((range - r) / range) ** 2;
    x += ((d.x - o.x) / r) * w;
    y += ((d.y - o.y) / r) * w;
  }
  return { x, y };
}

function localWant(d: Dot): number {
  const inward = Math.atan2(CY - d.y, CX - d.x);
  const rim = edgeDist(d);
  if (d.red) {
    const prey = huntClaims().get(d.id) ?? null;
    const cover = coverPoint(d);
    const pack = redSpread(d);
    let tx = cover.x;
    let ty = cover.y;
    if (prey) {
      const lead = RED_SPD * 8;
      tx = prey.x + Math.cos(prey.heading) * lead;
      ty = prey.y + Math.sin(prey.heading) * lead;
    }
    let vx = tx - d.x + pack.x * 1.6;
    let vy = ty - d.y + pack.y * 1.6;
    if (rim < 40) {
      vx += Math.cos(inward) * 0.7;
      vy += Math.sin(inward) * 0.7;
    }
    if (vx === 0 && vy === 0) return inward;
    return Math.atan2(vy, vx);
  }
  const hunter = nearest(d, (o) => o.red);
  const huntR = hunter ? dist(d, hunter) : 999;
  const spread = greenSpread(d);
  let vx = spread.x * 1.35;
  let vy = spread.y * 1.35;
  if (hunter) {
    const fear = clamp(1.15 - huntR / 240, 0.28, 1);
    const hx = Math.cos(bearing(hunter, d)) * fear;
    const hy = Math.sin(bearing(hunter, d)) * fear;
    vx += hx;
    vy += hy;
  }
  if (rim < 70) {
    const pull = rim < 28 ? 0.9 : 0.45;
    vx += Math.cos(inward) * pull;
    vy += Math.sin(inward) * pull;
  }
  if (vx === 0 && vy === 0) return inward;
  return Math.atan2(vy, vx);
}

function snapshot(d: Dot): SurvivalSnapshot {
  const focusDot = d.red
    ? huntClaims().get(d.id) ?? nearest(d, (o) => !o.red)
    : nearest(d, (o) => o.red);
  const cover = d.red ? coverPoint(d) : null;
  return {
    rules:
      (d.red
        ? `You are ${d.name}, RED. Tag your assigned green in focus — do not pile on the same prey as other reds. ` +
          "If focus is null, go to cover and sweep a different slice of the circle."
        : `You are ${d.name}, GREEN. Stay untagged. Spread away from other greens so one tag cannot hit two of you.`) +
      " Arena is a circle. heading 0 is right, 0.25 down, 0.5 left, 0.75 up.",
    you: {
      id: d.id,
      name: d.name,
      role: roleOf(d),
      x: Math.round(d.x),
      y: Math.round(d.y),
      heading_deg: Math.round((((d.heading * 180) / Math.PI) + 360) % 360),
      edge_dist: Math.round(edgeDist(d)),
    },
    greens_left: greens().length,
    reds: reds().length,
    focus: focusDot ? peerView(d, focusDot) : null,
    nearest_green: (() => {
      const g = nearest(d, (o) => !o.red);
      return g ? peerView(d, g) : null;
    })(),
    cover: cover ? { x: Math.round(cover.x), y: Math.round(cover.y) } : null,
    others: dots.filter((o) => o.id !== d.id).map((o) => peerView(d, o)),
  };
}

async function askJev(d: Dot): Promise<void> {
  if (d.you || d.busy || phase === "over" || greens().length === 0) return;
  d.busy = true;
  const t0 = performance.now();
  try {
    const res = await fetch("/api/survival", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot(d)),
    });
    const ms = performance.now() - t0;
    recordLatency(ms);
    const data = (await res.json()) as SurvivalPilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    if (typeof data.heading === "number") d.want = data.heading * Math.PI * 2;
    else d.want = localWant(d);
    logLine(d.red ? "hunter" : "prey", `${d.name}  ${d.red ? "HUNT" : "FLEE"}  ${Math.round(ms)}ms`);
    setStatus(
      you()?.red ? "HUNT" : "SURVIVE",
      `${greens().length} green · ${reds().length} red · ${d.name}`,
    );
  } catch {
    d.want = localWant(d);
  } finally {
    d.busy = false;
    d.askAt = performance.now() + 420 + Math.random() * 280;
  }
}

function spawn(): void {
  dots.length = 0;
  for (let i = 0; i < N; i++) {
    const a = i === 0 ? Math.PI : (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
    const rad = i === 0 ? ARENA * 0.68 : ARENA * (0.28 + (i % 3) * 0.16);
    dots.push({
      id: i,
      name: i === 0 ? "YOU" : `JEV-${i}`,
      you: i === 0,
      red: i === 0,
      x: CX + Math.cos(a) * rad,
      y: CY + Math.sin(a) * rad,
      heading: a + Math.PI,
      want: a + Math.PI,
      askAt: performance.now() + 200 + i * 90,
      busy: false,
      taggedAt: 0,
    });
  }
  phase = "run";
  feedList?.replaceChildren();
  setStatus("HUNT", "← → ↑ ↓ or WASD · space rematch");
}

function userWant(): number | null {
  let dx = 0;
  let dy = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) dx -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) dx += 1;
  if (keys.has("ArrowUp") || keys.has("KeyW")) dy -= 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) dy += 1;
  const me = you();
  if (pointer && me) {
    dx = pointer.x - me.x;
    dy = pointer.y - me.y;
  }
  if (dx === 0 && dy === 0) return null;
  return Math.atan2(dy, dx);
}

function clampArena(d: Dot): void {
  const dx = d.x - CX;
  const dy = d.y - CY;
  const max = ARENA - DOT;
  const r = Math.hypot(dx, dy);
  if (r > max && r > 0) {
    const nx = dx / r;
    const ny = dy / r;
    d.x = CX + nx * max;
    d.y = CY + ny * max;
    const vx = Math.cos(d.heading);
    const vy = Math.sin(d.heading);
    const hit = vx * nx + vy * ny;
    if (hit > 0) {
      d.heading = Math.atan2(vy - 2 * hit * ny, vx - 2 * hit * nx);
      d.want = Math.atan2(CY - d.y, CX - d.x);
    }
  }
}

function separate(): void {
  const min = DOT * 4.4;
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const a = dots[i]!;
      const b = dots[j]!;
      if (a.red || b.red) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const r = Math.hypot(dx, dy) || 0.001;
      if (r >= min) continue;
      const push = (min - r) * 0.42;
      dx /= r;
      dy /= r;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
      clampArena(a);
      clampArena(b);
    }
  }
}

function maybeOver(): void {
  if (greens().length > 0) return;
  phase = "over";
  setStatus("ALL RED", "space to rematch");
}

function tag(): void {
  const now = performance.now();
  const hunters = reds();
  const prey = greens();
  for (const h of hunters) {
    if (now - h.taggedAt < 520) continue;
    for (const p of prey) {
      if (p.red) continue;
      if (dist(h, p) < DOT * 2) {
        p.red = true;
        p.taggedAt = now;
        lastTag = now;
        logLine("tag", `${h.name} tagged ${p.name}`);
        if (p.you) setStatus("YOU'RE IT", "now hunt the greens");
      }
    }
  }
  maybeOver();
}

function step(dt: number): void {
  maybeOver();
  if (phase === "over") return;
  const me = you();
  if (me) {
    const aim = userWant();
    if (aim != null) me.want = aim;
  }
  const now = performance.now();
  for (const d of dots) {
    if (!d.you && now >= d.askAt && !d.busy) void askJev(d);
    if (d.you) {
      const aim = userWant();
      if (aim == null) continue;
      d.want = aim;
    } else {
      d.want = angMix(localWant(d), d.want, 0.4);
    }
    d.heading += clamp(angNorm(d.want - d.heading), -TURN * dt, TURN * dt);
    const spd = (d.red ? RED_SPD : GREEN_SPD) * dt;
    d.x += Math.cos(d.heading) * spd;
    d.y += Math.sin(d.heading) * spd;
    clampArena(d);
  }
  tag();
  separate();
}

function drawDot(d: Dot): void {
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(d.heading);
  ctx.beginPath();
  ctx.arc(0, 0, DOT, 0, Math.PI * 2);
  ctx.fillStyle = d.red ? "#e23b32" : "#2ec86a";
  ctx.fill();
  ctx.lineWidth = d.you ? 3.2 : 1.6;
  ctx.strokeStyle = d.you ? "#fff4a3" : "#0d151c";
  ctx.stroke();
  ctx.fillStyle = "#0d151c";
  ctx.beginPath();
  ctx.arc(DOT * 0.28, -4.2, 2.4, 0, Math.PI * 2);
  ctx.arc(DOT * 0.28, 4.2, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(): void {
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  ctx.fillStyle = "#101820";
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.arc(CX, CY, ARENA, 0, Math.PI * 2);
  ctx.fillStyle = "#16222c";
  ctx.fill();
  ctx.strokeStyle = "#3d5364";
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = "rgba(80,110,128,0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(CX, CY, ARENA * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(CX - ARENA, CY);
  ctx.lineTo(CX + ARENA, CY);
  ctx.moveTo(CX, CY - ARENA);
  ctx.lineTo(CX, CY + ARENA);
  ctx.stroke();
  const flash = performance.now() - lastTag < 180;
  if (flash) {
    ctx.fillStyle = "rgba(226,59,50,0.12)";
    ctx.fillRect(0, 0, W, H);
  }
  for (const d of dots) drawDot(d);
  ctx.font = `11px "Press Start 2P", monospace`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4f7fb";
  ctx.fillText(`${greens().length} GREEN`, CX, 28);
  if (phase === "over") {
    ctx.fillStyle = "rgba(8,12,16,0.55)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff4a3";
    ctx.font = `18px "Press Start 2P", monospace`;
    ctx.fillText(you()?.red && greens().length === 0 ? "ALL RED" : "OVER", CX, CY - 8);
    ctx.font = `10px "Press Start 2P", monospace`;
    ctx.fillStyle = "#f4f7fb";
    ctx.fillText("SPACE TO REMATCH", CX, CY + 22);
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

function canvasPoint(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * W,
    y: ((ev.clientY - rect.top) / rect.height) * H,
  };
}

window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code) || /^Key[WASD]$/.test(e.code)) {
    e.preventDefault();
  }
  keys.add(e.code);
  if (e.code === "Space" && phase === "over") spawn();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
canvas.addEventListener("pointerdown", (e) => {
  pointer = canvasPoint(e);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (pointer) pointer = canvasPoint(e);
});
canvas.addEventListener("pointerup", () => {
  pointer = null;
});
canvas.addEventListener("pointercancel", () => {
  pointer = null;
});

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(2.2, (now - last) / (1000 / 60));
  last = now;
  step(dt);
  draw();
  requestAnimationFrame(loop);
}

resize();
initLatencyChart();
spawn();
window.addEventListener("resize", resize);
requestAnimationFrame(loop);
