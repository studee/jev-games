type Sample = {
  at: number;
  ms: number;
};

const SMA_WINDOW = 8;
const MAX_SAMPLES = 90;
const samples: Sample[] = [];

let chart: HTMLCanvasElement | null = null;
let chartCtx: CanvasRenderingContext2D | null = null;
let lastEl: HTMLElement | null = null;
let avgEl: HTMLElement | null = null;

export function initLatencyChart(): void {
  const canvas = document.getElementById("latency-chart");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  chart = canvas;
  chartCtx = context;
  lastEl = document.getElementById("lat-last");
  avgEl = document.getElementById("lat-avg");
  resizeLatencyChart();
  drawLatencyChart();
  window.addEventListener("resize", resizeLatencyChart);
}

export function resizeLatencyChart(): void {
  if (!chart) return;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = chart.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (chart.width !== w || chart.height !== h) {
    chart.width = w;
    chart.height = h;
    drawLatencyChart();
  }
}

export function recordLatency(ms: number): void {
  samples.push({ at: performance.now(), ms });
  if (samples.length > MAX_SAMPLES) samples.shift();
  const avg = movingAverage(samples.length - 1);
  if (lastEl) lastEl.textContent = `${Math.round(ms)}ms`;
  if (avgEl) avgEl.textContent = `${Math.round(avg)}ms`;
  drawLatencyChart();
}

function movingAverage(index: number): number {
  const start = Math.max(0, index - SMA_WINDOW + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= index; i++) {
    const sample = samples[i];
    if (!sample) continue;
    sum += sample.ms;
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

function averages(): number[] {
  return samples.map((_, i) => movingAverage(i));
}

function niceMax(value: number): number {
  const padded = Math.max(400, value * 1.25);
  const step = padded > 2000 ? 500 : padded > 800 ? 200 : 100;
  return Math.ceil(padded / step) * step;
}

function drawLatencyChart(): void {
  if (!chart || !chartCtx) return;
  const ctx = chartCtx;
  const w = chart.width;
  const h = chart.height;
  ctx.clearRect(0, 0, w, h);

  const padL = 36 * (w / Math.max(1, chart.getBoundingClientRect().width));
  const padR = 10 * (w / Math.max(1, chart.getBoundingClientRect().width));
  const padT = 12 * (h / Math.max(1, chart.getBoundingClientRect().height));
  const padB = 22 * (h / Math.max(1, chart.getBoundingClientRect().height));
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.fillStyle = "#152430";
  roundRectPath(ctx, 0, 0, w, h, 12 * (w / 400));
  ctx.fill();

  if (samples.length === 0) {
    ctx.fillStyle = "#6d8193";
    ctx.font = `${11 * (w / 360)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("waiting for Jev calls", w / 2, h / 2);
    return;
  }

  const avgs = averages();
  const yMax = niceMax(Math.max(...samples.map((s) => s.ms), ...avgs));
  const x = (i: number) => padL + (samples.length === 1 ? plotW / 2 : (i / (samples.length - 1)) * plotW);
  const y = (ms: number) => padT + plotH - (ms / yMax) * plotH;

  ctx.strokeStyle = "rgba(143, 208, 201, 0.14)";
  ctx.lineWidth = 1;
  ctx.font = `${9 * (w / 360)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = "#6d8193";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const ms = (yMax / ticks) * i;
    const py = y(ms);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.fillText(`${Math.round(ms)}`, padL - 6, py);
  }

  ctx.beginPath();
  ctx.moveTo(x(0), y(avgs[0]));
  for (let i = 1; i < avgs.length; i++) ctx.lineTo(x(i), y(avgs[i]));
  ctx.lineTo(x(avgs.length - 1), padT + plotH);
  ctx.lineTo(x(0), padT + plotH);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  fill.addColorStop(0, "rgba(255, 244, 163, 0.28)");
  fill.addColorStop(1, "rgba(255, 244, 163, 0.02)");
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const px = x(i);
    const py = y(samples[i].ms);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = "rgba(197, 208, 218, 0.35)";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x(0), y(avgs[0]));
  for (let i = 1; i < avgs.length; i++) ctx.lineTo(x(i), y(avgs[i]));
  ctx.strokeStyle = "#fff4a3";
  ctx.lineWidth = 2.4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  const last = samples[samples.length - 1];
  const lastAvg = avgs[avgs.length - 1];
  ctx.fillStyle = "rgba(197, 208, 218, 0.9)";
  ctx.beginPath();
  ctx.arc(x(samples.length - 1), y(last.ms), 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff4a3";
  ctx.beginPath();
  ctx.arc(x(avgs.length - 1), y(lastAvg), 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#6d8193";
  ctx.font = `${9 * (w / 360)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText("raw", padL, h - 6);
  ctx.fillStyle = "#fff4a3";
  ctx.fillText("moving avg", padL + 36 * (w / 360), h - 6);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
