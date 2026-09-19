import type { DrawArea, DrawPixel, DrawRequest, JevNoulAnswer } from "./types.ts";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const API_KEY = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? "";

const COLS = 24;
const ROWS = 18;
const SECTS = 3;
const TILE_W = 4;
const TILE_H = 3;

type Cell = { r: number; g: number; b: number } | null;
type JevResult = {
  answers?: Record<string, JevNoulAnswer>;
};

function noul(answer: JevNoulAnswer | undefined): number | undefined {
  if (!answer || typeof answer.noul !== "number" || Number.isNaN(answer.noul)) return undefined;
  return Math.max(0, Math.min(1, answer.noul));
}

async function systemOne(state: unknown, questions: Record<string, unknown>): Promise<JevResult> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(7000),
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`jev http ${response.status}`), {
      status: response.status,
      detail: text.slice(0, 500),
    });
  }
  return JSON.parse(text) as JevResult;
}

function rgbQ(channel: string, at: string, around: string) {
  return {
    type: "noul",
    instructions:
      `Absolute ${channel} 0–1 for pixel ${at}. 0 is none, 1 is full ${channel}. ` +
      `This IS the color. Already printed neighbors: ${around}. ` +
      `Match neighbors if you are in the same region. Jump only at an edge of an object.`,
    criteria: {
      true: `This pixel is strongly ${channel}.`,
      false: `This pixel has almost no ${channel}.`,
    },
  };
}

function seedColor(prompt: string, y: number): { r: number; g: number; b: number } {
  const p = prompt.toLowerCase();
  const t = y / Math.max(1, ROWS - 1);
  let sky = { r: 0.4, g: 0.62, b: 0.88 };
  let ground = { r: 0.35, g: 0.5, b: 0.28 };
  if (/(night|moon|space)/.test(p)) sky = { r: 0.08, g: 0.1, b: 0.28 };
  if (/(ocean|sea|water|blue)/.test(p)) {
    sky = { r: 0.25, g: 0.5, b: 0.82 };
    ground = { r: 0.1, g: 0.28, b: 0.55 };
  }
  if (/(sun|sunset|orange|fire)/.test(p)) sky = { r: 0.95, g: 0.45, b: 0.16 };
  if (/(forest|tree|grass|green)/.test(p)) ground = { r: 0.18, g: 0.5, b: 0.18 };
  if (/(snow|white)/.test(p)) ground = { r: 0.86, g: 0.88, b: 0.92 };
  if (/(sand|desert|yellow)/.test(p)) ground = { r: 0.84, g: 0.7, b: 0.32 };
  if (/(red|rose)/.test(p) && t > 0.35) ground = { r: 0.78, g: 0.18, b: 0.16 };
  const u = t < 0.55 ? t / 0.55 : 1;
  return {
    r: sky.r + (ground.r - sky.r) * u,
    g: sky.g + (ground.g - sky.g) * u,
    b: sky.b + (ground.b - sky.b) * u,
  };
}

function idx(x: number, y: number): number {
  return y * COLS + x;
}

function neighbors(grid: Cell[], x0: number, y0: number, w: number, h: number): DrawPixel[] {
  const out: DrawPixel[] = [];
  for (let y = y0 - 1; y <= y0 + h; y++) {
    for (let x = x0 - 1; x <= x0 + w; x++) {
      if (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h) continue;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
      const cell = grid[idx(x, y)];
      if (!cell) continue;
      out.push({ x, y, r: cell.r, g: cell.g, b: cell.b });
    }
  }
  return out;
}

function avgOrSeed(around: DrawPixel[], prompt: string, y: number): { r: number; g: number; b: number } {
  if (!around.length) return seedColor(prompt, y);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of around) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  const n = around.length;
  return { r: r / n, g: g / n, b: b / n };
}

export async function handleDraw(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let body: DrawRequest;
  try {
    body = (await req.json()) as DrawRequest;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const prompt = (body.prompt ?? "").trim().slice(0, 240);
  if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const grid: Cell[] = Array.from({ length: COLS * ROWS }, () => null);
      const sw = COLS / SECTS;
      const sh = ROWS / SECTS;
      send({ started: true, cols: COLS, rows: ROWS, sections: 9, tile: { w: TILE_W, h: TILE_H } });
      const workers = [];
      for (let sr = 0; sr < SECTS; sr++) {
        for (let sc = 0; sc < SECTS; sc++) {
          workers.push(
            (async () => {
              const ox = sc * sw;
              const oy = sr * sh;
              for (let y = oy; y < oy + sh; y += TILE_H) {
                for (let x = ox; x < ox + sw; x += TILE_W) {
                  const area = await paintArea(prompt, grid, x, y, TILE_W, TILE_H);
                  for (const px of area.pixels) grid[idx(px.x, px.y)] = px;
                  send({ area });
                }
              }
            })(),
          );
        }
      }
      await Promise.all(workers);
      send({ done: true });
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}

async function paintArea(
  prompt: string,
  grid: Cell[],
  x0: number,
  y0: number,
  w: number,
  h: number,
): Promise<DrawArea> {
  const t0 = Date.now();
  const around = neighbors(grid, x0, y0, w, h);
  const fallback = avgOrSeed(around, prompt, y0);
  const aroundText =
    around.length === 0
      ? "none yet"
      : around
          .slice(0, 24)
          .map((p) => `${p.x},${p.y}=(${p.r.toFixed(2)},${p.g.toFixed(2)},${p.b.toFixed(2)})`)
          .join("; ");
  const questions: Record<string, unknown> = {};
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const at = `(${x0 + lx},${y0 + ly})`;
      questions[`r_${lx}_${ly}`] = rgbQ("red", at, aroundText);
      questions[`g_${lx}_${ly}`] = rgbQ("green", at, aroundText);
      questions[`b_${lx}_${ly}`] = rgbQ("blue", at, aroundText);
    }
  }
  const pixels: DrawPixel[] = [];
  try {
    const result = await systemOne(
      {
        rules:
          "Paint a small rectangle of pixels. Use the prompt. " +
          "already_printed_around are finished neighbors — stay coherent with them. " +
          "y=0 is the top of the picture (usually sky). Larger y is lower (ground/water).",
        prompt,
        canvas: { cols: COLS, rows: ROWS },
        paint_this_area: { x: x0, y: y0, w, h },
        already_printed_around: around,
      },
      questions,
    );
    const answers = result.answers ?? {};
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        pixels.push({
          x: x0 + lx,
          y: y0 + ly,
          r: noul(answers[`r_${lx}_${ly}`]) ?? fallback.r,
          g: noul(answers[`g_${lx}_${ly}`]) ?? fallback.g,
          b: noul(answers[`b_${lx}_${ly}`]) ?? fallback.b,
        });
      }
    }
  } catch {
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        const s = seedColor(prompt, y0 + ly);
        pixels.push({ x: x0 + lx, y: y0 + ly, r: s.r, g: s.g, b: s.b });
      }
    }
  }
  return { x: x0, y: y0, w, h, ms: Date.now() - t0, pixels };
}
