import { initLatencyChart, recordLatency } from "./latency.ts";
import type { PongMove, PongPilotResponse, PongSnapshot } from "./types.ts";

type Mode = "user-vs-jev" | "jev-vs-jev";

function writeSearch(patch: Record<string, string | null>): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (!v) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  const next = `${u.pathname}${u.search}${u.hash}`;
  if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", next);
}
type Side = "left" | "right";
type Paddle = { x: number; y: number; vy: number; intent: PongMove };
type Skill = {
  speed: number;
  noise: number;
  reactFrom: number;
  perfect: boolean;
  delayMs: number;
  missChance: number;
  edge: boolean;
  edgeT: number;
};
type SidePlan = {
  rally: number;
  vxSign: number;
  asked: boolean;
  aim: number;
  shown: number;
  followY: number;
  noise: number;
  applyAt: number;
};

const W = 800;
const H = 500;
const PADDLE_W = 14;
const PADDLE_H = 92;
const BALL_R = 8;
const USER_SPEED = 7.2;
const WIN = 7;
const LEVEL_NAMES = [
  "beginner",
  "easy",
  "casual",
  "medium",
  "fair",
  "sharp",
  "hard",
  "brutal",
  "expert",
  "impossible",
];

const canvasEl = document.getElementById("game");
if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error("Missing #game canvas");
const canvas: HTMLCanvasElement = canvasEl;
const context = canvas.getContext("2d");
if (!context) throw new Error("2D canvas is not available");
const ctx: CanvasRenderingContext2D = context;

const feedAction = document.getElementById("pilot-action");
const feedMeta = document.getElementById("pilot-meta");
const feedList = document.getElementById("decisions");
const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
const levelRow = document.getElementById("level-row");
const levelInput = document.getElementById("level");
const levelNum = document.getElementById("level-num");
const levelName = document.getElementById("level-name");

function emptyPlan(): SidePlan {
  return {
    rally: -1,
    vxSign: 0,
    asked: false,
    aim: 0.5,
    shown: 0.5,
    followY: H / 2,
    noise: 0,
    applyAt: 0,
  };
}

const state = {
  mode: "jev-vs-jev" as Mode,
  level: 4,
  rally: 0,
  playing: true,
  left: { x: 28, y: (H - PADDLE_H) / 2, vy: 0, intent: "stay" as PongMove },
  right: { x: W - 28 - PADDLE_W, y: (H - PADDLE_H) / 2, vy: 0, intent: "stay" as PongMove },
  ball: { x: W / 2, y: H / 2, vx: 5.2, vy: 2.4 },
  score: { left: 0, right: 0 },
  pause: 40,
  keys: { up: false, down: false },
  busy: false,
  plan: { left: emptyPlan(), right: emptyPlan() },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(from: number, to: number, dt: number, rate: number): number {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}

function skill(level: number): Skill {
  const t = clamp((level - 1) / 9, 0, 1);
  return {
    speed: 2.1 + t * 10.8,
    noise: (1 - t) * 150,
    reactFrom: 0.18 + t * 0.82,
    perfect: t >= 0.97,
    delayMs: (1 - t) * 280,
    missChance: (1 - t) * 0.32,
    edge: level >= 9,
    edgeT: level >= 10 ? 0.86 : 0.74,
  };
}

function activeSkill(side: Side): Skill {
  if (state.mode === "jev-vs-jev") return skill(7);
  if (side === "left") return skill(7);
  return skill(state.level);
}

function paddleOf(side: Side): Paddle {
  return side === "left" ? state.left : state.right;
}

function paddleCenter(p: Paddle): number {
  return p.y + PADDLE_H / 2;
}

function resetBall(direction: number): void {
  state.rally += 1;
  state.plan.left = emptyPlan();
  state.plan.right = emptyPlan();
  state.ball.x = W / 2;
  state.ball.y = H / 2;
  const angle = (Math.random() * 0.7 - 0.35) * Math.PI;
  const speed = 5.4;
  state.ball.vx = Math.cos(angle) * speed * direction;
  state.ball.vy = Math.sin(angle) * speed;
  state.pause = 36;
}

function predictY(paddleX: number): { y: number; incoming: boolean } {
  let x = state.ball.x;
  let y = state.ball.y;
  let vx = state.ball.vx;
  let vy = state.ball.vy;
  const leftSide = paddleX < W / 2;
  const incoming = leftSide ? vx < 0 : vx > 0;
  if (!incoming) return { y: H / 2, incoming: false };
  for (let i = 0; i < 500; i++) {
    if (leftSide && x <= paddleX + PADDLE_W) return { y: clamp(y, BALL_R, H - BALL_R), incoming };
    if (!leftSide && x >= paddleX) return { y: clamp(y, BALL_R, H - BALL_R), incoming };
    x += vx;
    y += vy;
    if (y < BALL_R) {
      y = BALL_R;
      vy *= -1;
    } else if (y > H - BALL_R) {
      y = H - BALL_R;
      vy *= -1;
    }
  }
  return { y: clamp(y, BALL_R, H - BALL_R), incoming };
}

function viewFor(p: Paddle, side: Side) {
  const pred = predictY(p.x);
  const center = paddleCenter(p);
  return {
    side,
    center_y: Math.round(center),
    predicted_ball_y: Math.round(pred.y),
    error_px: Math.round(pred.y - center),
    ball_incoming: pred.incoming,
  };
}

function snapshot(askLeft: boolean, askRight: boolean): PongSnapshot {
  return {
    rules: [
      "Classic Pong. Answer once per incoming shot.",
      "aim 0 meets with the top of the paddle (sit lower, larger y).",
      "aim 0.5 meets at the paddle center.",
      "aim 1 meets with the bottom of the paddle (sit higher, smaller y).",
      state.mode === "user-vs-jev" && state.level >= 9
        ? "This is an expert return: aim 0 or 1 to meet at a paddle EDGE for a steep angle. Pick the edge that sends the ball away from the opponent paddle."
        : "Prefer center unless angling the return is useful.",
    ].join(" "),
    mode: state.mode,
    table: { width: W, height: H },
    ball: {
      x: Math.round(state.ball.x),
      y: Math.round(state.ball.y),
      vx: Math.round(state.ball.vx * 10) / 10,
      vy: Math.round(state.ball.vy * 10) / 10,
    },
    left: viewFor(state.left, "left"),
    right: viewFor(state.right, "right"),
    score: { ...state.score },
    ask_left: askLeft,
    ask_right: askRight,
  };
}

function setStatus(action: string, meta: string): void {
  if (feedAction) feedAction.textContent = action;
  if (feedMeta) feedMeta.textContent = meta;
}

function logDecision(kind: string, text: string): void {
  if (!feedList) return;
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = text;
  feedList.prepend(li);
  while (feedList.children.length > 12) feedList.removeChild(feedList.lastChild as Node);
}

function moveIntent(p: Paddle, intent: PongMove, dt: number, speed: number): void {
  const dir = intent === "up" ? -1 : intent === "down" ? 1 : 0;
  p.vy = 0;
  p.y = clamp(p.y + dir * speed * dt, 12, H - 12 - PADDLE_H);
}

function easePaddle(p: Paddle, targetCenterY: number, dt: number, speed: number): void {
  const desired = clamp(targetCenterY - PADDLE_H / 2, 12, H - 12 - PADDLE_H);
  const error = desired - p.y;
  const want = clamp(error * 0.22, -speed, speed);
  p.vy = lerp(p.vy, want, dt, 0.38);
  p.vy = clamp(p.vy, -speed, speed);
  if (Math.abs(error) < 1.5 && Math.abs(p.vy) < 0.45) {
    p.y = desired;
    p.vy = 0;
    return;
  }
  p.y = clamp(p.y + p.vy * dt, 12, H - 12 - PADDLE_H);
}

function ballInReactRange(p: Paddle, s: Skill): boolean {
  if (p.x < W / 2) return state.ball.x < W * s.reactFrom;
  return state.ball.x > W * (1 - s.reactFrom);
}

function beginApproach(side: Side, predY: number): void {
  const s = activeSkill(side);
  const plan = state.plan[side];
  plan.rally = state.rally;
  plan.vxSign = Math.sign(state.ball.vx) || 1;
  plan.asked = false;
  plan.aim = 0.5;
  plan.shown = 0.5;
  plan.followY = predY;
  plan.applyAt = 0;
  plan.noise = 0;
  if (s.edge) {
    plan.aim = wantedEdgeT(side) < 0 ? 0 : 1;
  } else if (!s.perfect) {
    plan.noise = (Math.random() * 2 - 1) * s.noise;
    if (Math.random() < s.missChance) {
      plan.noise += (Math.random() < 0.5 ? -1 : 1) * (70 + s.noise * 0.4);
    }
  }
}

function wantedEdgeT(side: Side): number {
  const mag = activeSkill(side).edgeT;
  const opp = paddleCenter(side === "right" ? state.left : state.right);
  if (Math.abs(opp - H / 2) < 36) return (state.ball.vy >= 0 ? 1 : -1) * mag;
  return (opp < H / 2 ? 1 : -1) * mag;
}

function reachableT(predY: number, wantedT: number): number {
  const half = PADDLE_H / 2;
  const center = clamp(predY - wantedT * half, 12 + half, H - 12 - half);
  return (predY - center) / half;
}

function steerJev(p: Paddle, side: Side, dt: number): void {
  const s = activeSkill(side);
  const pred = predictY(p.x);
  const plan = state.plan[side];
  const sign = Math.sign(state.ball.vx) || 1;
  if (pred.incoming && (plan.rally !== state.rally || plan.vxSign !== sign)) {
    beginApproach(side, pred.y);
  }

  const followTarget = pred.incoming ? pred.y : H / 2;
  plan.followY = lerp(plan.followY, followTarget, dt, 0.16);

  if (!pred.incoming || !ballInReactRange(p, s)) {
    easePaddle(p, H / 2, dt, s.speed * 0.22);
    return;
  }

  const now = performance.now();
  if (s.edge) {
    const fromJev = plan.applyAt > 0 && now >= plan.applyAt;
    const wanted = fromJev ? (plan.aim < 0.5 ? -s.edgeT : s.edgeT) : wantedEdgeT(side);
    const t = reachableT(plan.followY, wanted);
    plan.shown = lerp(plan.shown, t < 0 ? 0 : 1, dt, 0.28);
    easePaddle(p, plan.followY - t * (PADDLE_H / 2), dt, s.speed);
    return;
  }
  const aim = plan.applyAt > 0 && now >= plan.applyAt ? plan.aim : 0.5;
  plan.shown = lerp(plan.shown, aim, dt, 0.14);
  const spin = (0.5 - plan.shown) * PADDLE_H * 0.64;
  const target = plan.followY + spin + (s.perfect ? 0 : plan.noise);
  easePaddle(p, target, dt, s.speed);
}

function steerUser(dt: number): void {
  if (state.keys.up === state.keys.down) {
    state.left.intent = "stay";
    state.left.vy = 0;
    return;
  }
  state.left.intent = state.keys.up ? "up" : "down";
  moveIntent(state.left, state.left.intent, dt, USER_SPEED);
}

function bounceOff(p: Paddle, direction: number): void {
  const t = (state.ball.y - paddleCenter(p)) / (PADDLE_H / 2);
  const mag = Math.min(9.5, Math.hypot(state.ball.vx, state.ball.vy) * 1.06);
  const angle = clamp(t, -0.92, 0.92) * 1.12;
  state.ball.vx = Math.cos(angle) * mag * direction;
  state.ball.vy = Math.sin(angle) * mag;
}

function hitPaddle(p: Paddle): boolean {
  return (
    state.ball.x + BALL_R >= p.x &&
    state.ball.x - BALL_R <= p.x + PADDLE_W &&
    state.ball.y + BALL_R >= p.y &&
    state.ball.y - BALL_R <= p.y + PADDLE_H
  );
}

function needsAsk(side: Side): boolean {
  if (side === "left" && state.mode === "user-vs-jev") return false;
  const p = paddleOf(side);
  const pred = predictY(p.x);
  if (!pred.incoming) return false;
  const s = activeSkill(side);
  if (!ballInReactRange(p, s)) return false;
  const plan = state.plan[side];
  const sign = Math.sign(state.ball.vx) || 1;
  if (plan.asked && plan.rally === state.rally && plan.vxSign === sign) return false;
  return true;
}

function aimLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

async function askJev(askLeft: boolean, askRight: boolean): Promise<void> {
  if (state.busy) return;
  const rally = state.rally;
  const vxSign = Math.sign(state.ball.vx) || 1;
  if (askLeft) state.plan.left.asked = true;
  if (askRight) state.plan.right.asked = true;
  state.busy = true;
  const t0 = performance.now();
  try {
    const res = await fetch("/api/pong", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot(askLeft, askRight)),
    });
    const ms = Math.round(performance.now() - t0);
    recordLatency(ms);
    const data = (await res.json()) as PongPilotResponse;
    if (!res.ok) throw new Error(data.detail || data.error || `http ${res.status}`);
    if (state.rally !== rally) return;

    const now = performance.now();
    const parts: string[] = [];
    if (askLeft && data.left_aim != null && state.plan.left.vxSign === vxSign) {
      state.plan.left.aim = data.left_aim;
      state.plan.left.applyAt = now;
      parts.push(`L ${aimLabel(data.left_aim)}`);
    }
    if (askRight && data.right_aim != null && state.plan.right.vxSign === vxSign) {
      const s = skill(state.level);
      const delay = state.mode === "user-vs-jev" ? s.delayMs : 0;
      const aim = s.edge ? (data.right_aim < 0.5 ? 0 : 1) : data.right_aim;
      state.plan.right.aim = aim;
      state.plan.right.applyAt = now + delay;
      parts.push(`R ${s.edge ? (aim < 0.5 ? "EDGE↑" : "EDGE↓") : aimLabel(aim)}`);
    }
    const levelBit = state.mode === "user-vs-jev" ? ` · lv ${state.level}` : "";
    const label = parts.length ? parts.join("  ·  ") : "AIM";
    setStatus(state.mode === "user-vs-jev" ? `YOU  ·  ${label}` : label, `${ms}ms${levelBit}`);
    logDecision("flap", `${label}  ${ms}ms`);
  } catch (err) {
    if (askLeft && state.plan.left.rally === rally) state.plan.left.asked = false;
    if (askRight && state.plan.right.rally === rally) state.plan.right.asked = false;
    const message = err instanceof Error ? err.message : "Jev call failed";
    setStatus("ERROR", message);
    logDecision("error", message);
  } finally {
    state.busy = false;
  }
}

function maybeAskJev(): void {
  if (state.busy) return;
  const askLeft = needsAsk("left");
  const askRight = needsAsk("right");
  if (!askLeft && !askRight) return;
  void askJev(askLeft, askRight);
}

function update(dt: number): void {
  maybeAskJev();
  if (state.mode === "user-vs-jev") steerUser(dt);
  else steerJev(state.left, "left", dt);
  steerJev(state.right, "right", dt);

  if (state.pause > 0) {
    state.pause -= dt;
    return;
  }

  state.ball.x += state.ball.vx * dt;
  state.ball.y += state.ball.vy * dt;

  if (state.ball.y - BALL_R < 0) {
    state.ball.y = BALL_R;
    state.ball.vy = Math.abs(state.ball.vy);
  } else if (state.ball.y + BALL_R > H) {
    state.ball.y = H - BALL_R;
    state.ball.vy = -Math.abs(state.ball.vy);
  }

  if (state.ball.vx < 0 && hitPaddle(state.left)) {
    state.ball.x = state.left.x + PADDLE_W + BALL_R;
    bounceOff(state.left, 1);
  } else if (state.ball.vx > 0 && hitPaddle(state.right)) {
    state.ball.x = state.right.x - BALL_R;
    bounceOff(state.right, -1);
  }

  if (state.ball.x < -20) {
    state.score.right += 1;
    resetBall(1);
  } else if (state.ball.x > W + 20) {
    state.score.left += 1;
    resetBall(-1);
  }
}

function drawCourt(): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#10202c");
  g.addColorStop(1, "#0b1620");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(143, 208, 201, 0.22)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, W - 20, H - 20);

  ctx.setLineDash([10, 14]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 22);
  ctx.lineTo(W / 2, H - 22);
  ctx.strokeStyle = "rgba(255, 244, 163, 0.35)";
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPaddle(p: Paddle, color: string): void {
  ctx.fillStyle = color;
  roundRect(p.x, p.y, PADDLE_W, PADDLE_H, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(p.x + 3, p.y + 8, 3, PADDLE_H - 16);
}

function drawBall(): void {
  ctx.fillStyle = "#fff4a3";
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.arc(state.ball.x - 2, state.ball.y - 2, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawScore(): void {
  ctx.font = `28px "Press Start 2P", monospace`;
  ctx.fillStyle = "#f4f7fb";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(String(state.score.left), W / 2 - 70, 28);
  ctx.fillText(String(state.score.right), W / 2 + 70, 28);
  ctx.font = `8px "Press Start 2P", monospace`;
  ctx.fillStyle = "#8fd0c9";
  ctx.fillText(state.mode === "user-vs-jev" ? "YOU" : "JEV", W / 2 - 70, 64);
  ctx.fillText("JEV", W / 2 + 70, 64);
  if (state.mode === "user-vs-jev") {
    ctx.fillStyle = "#fff4a3";
    ctx.fillText(`LV ${state.level}`, W - 64, 28);
  }
  if (state.score.left >= WIN || state.score.right >= WIN) {
    ctx.fillStyle = "#fff4a3";
    ctx.font = `14px "Press Start 2P", monospace`;
    ctx.fillText("FIRST TO 7", W / 2, H - 36);
  }
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

function draw(): void {
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  drawCourt();
  drawPaddle(state.left, state.mode === "user-vs-jev" ? "#7ad3c0" : "#f0c63a");
  drawPaddle(state.right, "#f0c63a");
  drawBall();
  drawScore();
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

function syncLevelUi(): void {
  const name = LEVEL_NAMES[state.level - 1] ?? "medium";
  if (levelNum) levelNum.textContent = String(state.level);
  if (levelName) levelName.textContent = name;
  if (levelInput instanceof HTMLInputElement) levelInput.value = String(state.level);
  if (levelRow) levelRow.hidden = state.mode !== "user-vs-jev";
}

function setLevel(level: number): void {
  state.level = clamp(Math.round(level), 1, 10);
  state.plan.right = emptyPlan();
  syncLevelUi();
  writeSearch({ level: state.mode === "user-vs-jev" ? String(state.level) : null });
  if (state.mode === "user-vs-jev") {
    setStatus("YOU vs JEV", `level ${state.level} ${LEVEL_NAMES[state.level - 1]}`);
  }
}

function setMode(mode: Mode): void {
  state.mode = mode;
  state.score.left = 0;
  state.score.right = 0;
  state.left.y = (H - PADDLE_H) / 2;
  state.right.y = (H - PADDLE_H) / 2;
  state.left.vy = 0;
  state.right.vy = 0;
  state.left.intent = "stay";
  state.right.intent = "stay";
  resetBall(Math.random() < 0.5 ? 1 : -1);
  feedList?.replaceChildren();
  syncLevelUi();
  setStatus(
    mode === "user-vs-jev" ? "YOU vs JEV" : "JEV vs JEV",
    mode === "user-vs-jev" ? `level ${state.level} · ↑ ↓ arrows` : "aim once per shot",
  );
  for (const btn of modeButtons) {
    btn.classList.toggle("is-active", btn.dataset.mode === mode);
  }
  writeSearch({
    mode: mode === "jev-vs-jev" ? null : mode,
    level: mode === "user-vs-jev" ? String(state.level) : null,
  });
}

window.addEventListener(
  "keydown",
  (event) => {
    if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
    event.preventDefault();
    if (event.code === "ArrowUp") state.keys.up = true;
    if (event.code === "ArrowDown") state.keys.down = true;
  },
  { passive: false },
);
window.addEventListener("keyup", (event) => {
  if (event.code === "ArrowUp") state.keys.up = false;
  if (event.code === "ArrowDown") state.keys.down = false;
});

for (const btn of modeButtons) {
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    const mode = btn.dataset.mode;
    if (mode === "user-vs-jev" || mode === "jev-vs-jev") setMode(mode);
  });
}

if (levelInput instanceof HTMLInputElement) {
  levelInput.addEventListener("input", () => {
    setLevel(Number(levelInput.value));
  });
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(2.2, (now - last) / (1000 / 60));
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener("resize", resize);
resize();
initLatencyChart();
{
  const q = new URLSearchParams(location.search);
  const mode = q.get("mode") === "user-vs-jev" ? "user-vs-jev" : "jev-vs-jev";
  setMode(mode);
  const level = Number(q.get("level"));
  if (mode === "user-vs-jev" && Number.isFinite(level) && level >= 1) setLevel(level);
}
window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  const mode = q.get("mode") === "user-vs-jev" ? "user-vs-jev" : "jev-vs-jev";
  setMode(mode);
});
requestAnimationFrame(loop);
