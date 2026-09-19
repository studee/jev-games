import { join, normalize } from "node:path";
import type {
  DrivePilotResponse,
  DriveSnapshot,
  FlightPilotResponse,
  FlightSnapshot,
  SpacePilotResponse,
  SpaceSnapshot,
  SurvivalPilotResponse,
  SurvivalSnapshot,
  GameSnapshot,
  InvadersPilotResponse,
  InvadersSnapshot,
  WormsPilotResponse,
  WormsSnapshot,
  WormsWeapon,
  JevChoiceAnswer,
  JevNoulAnswer,
  JevResult,
  PilotResponse,
  PongPilotResponse,
  PongSnapshot,
} from "./types.ts";

const PORT = Number(process.env.PORT ?? 8765);
const API_URL = "https://api.typesafe.ai/v1/systemone";
const API_KEY = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY ?? "";
const PUBLIC_DIR = join(import.meta.dir, "../public");

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
    signal: AbortSignal.timeout(8000),
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

function jsonError(err: unknown): Response {
  const error = err as Error & { status?: number; detail?: string };
  return Response.json(
    { error: error.message, detail: error.detail },
    { status: error.status ?? 502 },
  );
}

async function handleFlappy(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: GameSnapshot;
  try {
    state = (await req.json()) as GameSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const result = await systemOne(state, {
      should_flap: {
        type: "noul",
        instructions:
          "The bird should flap right now to stay in the next pipe gap. " +
          "Screen y grows downward: smaller y is higher in the sky. " +
          "Prefer flapping if waiting_hits is true, if the bird is below the gap center, " +
          "or if it is falling toward the ground with no time to spare.",
        criteria: {
          true: "Flap now; waiting is likely to hit a pipe or the ground.",
          false: "Do not flap; the bird is high enough or would overshoot the gap.",
        },
      },
      would_overshoot: {
        type: "noul",
        instructions:
          "A flap right now would send the bird into the top pipe or too high above the gap. Screen y grows downward.",
        criteria: {
          true: "Flapping now is too much lift.",
          false: "Flapping now still fits through the gap.",
        },
      },
    });
    const should = Number((result.answers?.should_flap as JevNoulAnswer | undefined)?.noul ?? 0);
    const overshoot = Number((result.answers?.would_overshoot as JevNoulAnswer | undefined)?.noul ?? 0);
    const body: PilotResponse = {
      flap: should >= 0.45,
      should_flap: should,
      would_overshoot: overshoot,
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

function paddleQuestion(side: "left" | "right") {
  return {
    type: "noul",
    instructions:
      `Where on the ${side.toUpperCase()} paddle should it meet the incoming ball? ` +
      "This is a one-shot aim for the whole approach, not a per-frame move. " +
      "0 meets with the top of the paddle (sit lower, larger y). " +
      "0.5 meets at the center. " +
      "1 meets with the bottom of the paddle (sit higher, smaller y). " +
      "Prefer center unless angling the return looks useful.",
    criteria: {
      true: "Meet with the bottom of the paddle (paddle sits higher).",
      false: "Meet with the top of the paddle (paddle sits lower).",
    },
  };
}

async function handlePong(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: PongSnapshot;
  try {
    state = (await req.json()) as PongSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const questions: Record<string, unknown> = {};
  if (state.ask_left) questions.left_aim = paddleQuestion("left");
  if (state.ask_right) questions.right_aim = paddleQuestion("right");
  if (Object.keys(questions).length === 0) {
    return Response.json({ error: "no paddles to ask" }, { status: 400 });
  }
  try {
    const result = await systemOne(state, questions);
    const body: PongPilotResponse = {
      left_aim: noul(result.answers?.left_aim as JevNoulAnswer | undefined),
      right_aim: noul(result.answers?.right_aim as JevNoulAnswer | undefined),
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

async function handleInvaders(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: InvadersSnapshot;
  try {
    state = (await req.json()) as InvadersSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const criteria: Record<string, string> = {};
  for (const col of state.columns) {
    criteria[String(col.id)] =
      `Attack column ${col.id} (x=${col.x}). ${col.count} aliens left. Lowest is at y=${col.lowest_y}, worth ${col.points}.`;
  }
  if (state.ufo) criteria.ufo = `Shoot the bonus UFO at x=${state.ufo.x}.`;
  if (Object.keys(criteria).length === 0) {
    return Response.json({ error: "no targets" }, { status: 400 });
  }
  try {
    const result = await systemOne(state, {
      column: {
        type: "choice",
        instructions:
          "Pick ONE target for this attack run. Prefer a column whose lowest alien is closest to the ship, " +
          "or the UFO if it is an easy bonus. This is a one-shot aim, not a per-frame move. " +
          "The cannon will slide under that x and fire. Incoming shots are dodged in code.",
        criteria,
      },
    });
    const pick = result.answers?.column as JevChoiceAnswer | undefined;
    const raw = pick?.choice;
    const body: InvadersPilotResponse = {
      column: raw === "ufo" ? "ufo" : raw != null && /^\d+$/.test(raw) ? Number(raw) : undefined,
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

async function handleWorms(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: WormsSnapshot;
  try {
    state = (await req.json()) as WormsSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const criteria: Record<string, string> = {};
  for (const foe of state.foes) {
    criteria[String(foe.id)] =
      `Fire at ${foe.name} (hp ${foe.hp}) at (${foe.x},${foe.y}). ` +
      `Flat shot error ${foe.flat_error_px}px at ${foe.flat_angle_deg}° power ${foe.flat_power}. ` +
      `Lofted shot error ${foe.loft_error_px}px at ${foe.loft_angle_deg}° power ${foe.loft_power}.`;
  }
  if (Object.keys(criteria).length === 0) {
    return Response.json({ error: "no targets" }, { status: 400 });
  }
  const weaponBlurb: Record<WormsWeapon, string> = {
    bazooka: "Single wind rocket, medium blast. Not the default — only if its error is best.",
    cluster: "Separating rockets. Splits into five bomblets. Use if worms are close or this error is best.",
    mortar: "Artillery. Almost no wind, steep drop, huge crater. Use for long plunges or if this error is best.",
  };
  const weaponCriteria: Record<string, string> = {};
  if (state.weapons?.length) {
    for (const row of state.weapons) {
      weaponCriteria[row.id] =
        `best_error_px ${row.error_px} on ${row.target_name}. ${weaponBlurb[row.id]}`;
    }
  } else {
    for (const id of Object.keys(weaponBlurb) as WormsWeapon[]) weaponCriteria[id] = weaponBlurb[id];
  }
  const lowest = [...(state.weapons ?? [])].sort((a, b) => a.error_px - b.error_px)[0];
  try {
    const result = await systemOne(state, {
      target_id: {
        type: "choice",
        instructions:
          "Pick ONE enemy worm for this shot. Prefer a worm you can actually hit " +
          "(small error_px). Finish low-HP worms if the shot is close. " +
          "If recent_shots missed the same worm twice, consider another target or the other arc.",
        criteria,
      },
      loft: {
        type: "noul",
        instructions:
          "Use a high arcing (lofted) shot instead of a flatter shot. " +
          "Prefer loft if the flat error is worse, if wind is strong, or if dirt is in the way. " +
          "If recent_shots show the last loft hit a cliff or overshot, prefer flat. " +
          "If the last shot landed short of the worm, loft can help.",
        criteria: {
          true: "Use the lofted / high-arc shot.",
          false: "Use the flatter shot.",
        },
      },
      power_adjust: {
        type: "noul",
        instructions:
          "Correct power from recent_shots (newest first). miss_x/miss_y is impact minus intended target. " +
          "Positive miss_x means the shell landed to the right of the target. " +
          "If the last shot was short of the target, choose true (more power). " +
          "If it overshot or slammed the near cliff, choose false (less power). " +
          "Choose 0.5 if there are no useful recent shots.",
        criteria: {
          true: "Add power; previous shot(s) fell short.",
          false: "Cut power; previous shot(s) overshot.",
        },
      },
      weapon: {
        type: "choice",
        instructions:
          "Pick ONE weapon. Prefer the lowest best_error_px in the weapons table. " +
          (lowest
            ? `${lowest.id} currently has the lowest error (${lowest.error_px}px) — pick it unless a special effect clearly helps more. `
            : "") +
          "Do not default to bazooka. Cluster for grouped worms, mortar for a heavy drop.",
        criteria: weaponCriteria,
      },
    });
    const pick = result.answers?.target_id as JevChoiceAnswer | undefined;
    const raw = pick?.choice;
    const wepAns = result.answers?.weapon as JevChoiceAnswer | undefined;
    const wepRaw = (wepAns?.choice ?? "").toLowerCase().trim();
    const weapons: WormsWeapon[] = ["bazooka", "cluster", "mortar"];
    let weapon = weapons.find((id) => wepRaw === id || wepRaw.includes(id));
    if (!weapon && wepAns?.probabilities) {
      const top = Object.entries(wepAns.probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      const key = (top?.[0] ?? "").toLowerCase();
      weapon = weapons.find((id) => key === id || key.includes(id));
    }
    const body: WormsPilotResponse = {
      target_id: raw != null && /^\d+$/.test(raw) ? Number(raw) : undefined,
      loft: noul(result.answers?.loft as JevNoulAnswer | undefined),
      power_adjust: noul(result.answers?.power_adjust as JevNoulAnswer | undefined),
      weapon,
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

async function handleFlight(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: FlightSnapshot;
  try {
    state = (await req.json()) as FlightSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const g = state.geometry;
    const result = await systemOne(state, {
      maneuver: {
        type: "choice",
        instructions:
          "You fly a Jev fighter in a free-for-all. Hunt and shoot the plane in foe until they are dead. " +
          "Everyone is a target. Last plane standing wins. Never run away. Never extend. " +
          "clock is where THEY are from YOUR nose (12 is ahead, 6 is behind, 3 is right). " +
          "they_are_shooting is true if they are firing guns right now. " +
          "they_are_shooting_at_you means those rounds are pointed at you. " +
          "If they_have_guns_on_you, turn toward them with a real bank — never instant 180, never fly backwards. " +
          "Default is pursue or lead. Pick guns whenever lined_up is true.",
        criteria: {
          pursue: `Turn hard onto them. They are at ${g.clock}, bearing ${g.bearing_deg}°, range ${g.range}. Use this if they are not at 12 o'clock.`,
          lead: `Aim ahead of their flight path and close. Range ${g.range}, ${g.high_or_low}. Best when they are near 12 but not quite lined_up.`,
          guns: `HOLD AND SHOOT. lined_up=${g.lined_up}. Pick this whenever lined_up is true.`,
          climb: `Pull up while still turning toward them. They are ${g.alt_diff} above you. Only if you need their altitude — keep chasing.`,
          dive: `Push over while still turning toward them. Only if they are below you — keep chasing.`,
          break: `Hard jink. they_are_shooting_at_you=${g.they_are_shooting_at_you}.`,
          extend: `Do not pick this. Running away loses. Pick pursue.`,
          reverse: `Turn toward a chaser. they_have_guns_on_you=${g.they_have_guns_on_you}. Bank and pitch only — no snap turn.`,
        },
      },
      fire: {
        type: "noul",
        instructions:
          "Kill whoever is in foe. Fire if lined_up is true. " +
          "Fire if they are at 12 o'clock and range < 180. " +
          "Hold fire only if you would shoot dirt or they are behind you (clock 5–7).",
        criteria: {
          true: "Open fire; press the attack.",
          false: "Hold fire this pass.",
        },
      },
    });
    const pick = result.answers?.maneuver as JevChoiceAnswer | undefined;
    const raw = (pick?.choice ?? "").toLowerCase().trim();
    const maneuvers = ["pursue", "lead", "guns", "climb", "dive", "break", "extend", "reverse"] as const;
    let maneuver = maneuvers.find((id) => raw === id || raw.includes(id));
    if (!maneuver && pick?.probabilities) {
      const top = Object.entries(pick.probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      const key = (top?.[0] ?? "").toLowerCase();
      maneuver = maneuvers.find((id) => key === id || key.includes(id));
    }
    const body: FlightPilotResponse = {
      maneuver,
      fire: noul(result.answers?.fire as JevNoulAnswer | undefined),
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

async function handleSpace(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: SpaceSnapshot;
  try {
    state = (await req.json()) as SpaceSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const g = state.geometry;
    const result = await systemOne(state, {
      maneuver: {
        type: "choice",
        instructions:
          "You fly a Jev starfighter in a solar-system free-for-all. Hunt and laser the ship in foe until they are dead. " +
          "Everyone is a target. Last ship standing wins. Never run. Never extend. " +
          "clock is where THEY are from YOUR nose (12 is ahead, 6 is behind). " +
          "If they_have_guns_on_you, turn toward them with a real bank — never instant 180, never fly backwards. " +
          "Pick guns whenever lined_up is true.",
        criteria: {
          pursue: `Turn onto them. They are at ${g.clock}, bearing ${g.bearing_deg}°, range ${g.range}.`,
          lead: `Aim ahead of their path and close. Range ${g.range}.`,
          guns: `HOLD AND FIRE LASERS. lined_up=${g.lined_up}.`,
          climb: `Pitch up while still turning toward them. alt_diff=${g.alt_diff}.`,
          dive: `Pitch down while still turning toward them.`,
          break: `Jink only if reverse is not available. they_are_shooting_at_you=${g.they_are_shooting_at_you}.`,
          extend: `Do not pick this. Pick reverse if they are on your tail, else pursue.`,
          reverse: `Turn toward a chaser. they_have_guns_on_you=${g.they_have_guns_on_you}. Bank and pitch only — no snap turn.`,
        },
      },
      fire: {
        type: "noul",
        instructions:
          "Kill the ship in foe with lasers. Fire if lined_up is true or they are at 12 o'clock and range < 220. " +
          "Hold fire if they are behind you (clock 5–7) or you would hit the sun.",
        criteria: {
          true: "Fire lasers.",
          false: "Hold fire this beat.",
        },
      },
    });
    const pick = result.answers?.maneuver as JevChoiceAnswer | undefined;
    const raw = (pick?.choice ?? "").toLowerCase().trim();
    const maneuvers = ["pursue", "lead", "guns", "climb", "dive", "break", "extend", "reverse"] as const;
    let maneuver = maneuvers.find((id) => raw === id || raw.includes(id));
    if (!maneuver && pick?.probabilities) {
      const top = Object.entries(pick.probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      const key = (top?.[0] ?? "").toLowerCase();
      maneuver = maneuvers.find((id) => key === id || key.includes(id));
    }
    const body: SpacePilotResponse = {
      maneuver,
      fire: noul(result.answers?.fire as JevNoulAnswer | undefined),
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

async function handleDrive(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: DriveSnapshot;
  try {
    state = (await req.json()) as DriveSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const g = state.geometry;
    const result = await systemOne(state, {
      maneuver: {
        type: "choice",
        instructions:
          "You drive the RED Formula car on an OVAL: two straights and two curved ends. 3 laps. " +
          "ONLY maneuver (lane change) when they_have_guns_on_you is true — you are in their crosshair. " +
          "If you are not in their crosshair, do not weave, do not brake, do not hunt. Just race. " +
          "clock is where THEY sit from YOUR nose.",
        criteria: {
          chase: `Race to win. Use whenever they_have_guns_on_you is false. pos ${g.race_pos}.`,
          ram: `Do not. Prefer chase.`,
          circle: `ONLY if they_have_guns_on_you=${g.they_have_guns_on_you}. Swerve off the gun line at speed.`,
          reverse: `Only if stuck. wall_close=${g.wall_close}.`,
          guns: `Fire if lined_up while still racing. lined_up=${g.lined_up}. Do not slow down.`,
          brake: `Almost never. wall_close=${g.wall_close}. Never because they are nearby.`,
          drift: `ONLY if they_have_guns_on_you. Break the crosshair at speed.`,
        },
      },
      fire: {
        type: "noul",
        instructions:
          "Fire if lined_up while racing. Hold if you are busy breaking their crosshair.",
        criteria: {
          true: "Open fire.",
          false: "Hold fire.",
        },
      },
    });
    const pick = result.answers?.maneuver as JevChoiceAnswer | undefined;
    const raw = (pick?.choice ?? "").toLowerCase().trim();
    const maneuvers = ["chase", "ram", "circle", "reverse", "guns", "brake", "drift"] as const;
    let maneuver = maneuvers.find((id) => raw === id || raw.includes(id));
    if (!maneuver && pick?.probabilities) {
      const top = Object.entries(pick.probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      const key = (top?.[0] ?? "").toLowerCase();
      maneuver = maneuvers.find((id) => key === id || key.includes(id));
    }
    const body: DrivePilotResponse = {
      maneuver,
      fire: noul(result.answers?.fire as JevNoulAnswer | undefined),
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

async function handleSurvival(req: Request): Promise<Response> {
  if (!API_KEY) return Response.json({ error: "JEV_API_KEY is not set" }, { status: 500 });
  let state: SurvivalSnapshot;
  try {
    state = (await req.json()) as SurvivalSnapshot;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const hunter = state.you.role === "hunter";
    const focus = state.focus;
    const result = await systemOne(state, {
      heading: {
        type: "noul",
        instructions:
          (hunter
            ? "You are RED. Hunt the GREEN in focus only — that is your assignment. " +
              "Other reds have different greens. Do not all chase the same one. " +
              "If focus is missing, steer toward cover to hold a different slice of the arena. " +
              "Stay away from other reds so you cover more ground."
            : "You are GREEN. Do not get tagged. Run away from the nearest RED. " +
              "Also stay far from other greens — do not clump. " +
              "If nearest_green is close, steer away from them unless a red is closer. " +
              "If edge_dist is small, cut inward, not into the wall.") +
          " heading 0 is right, 0.25 is down, 0.5 is left, 0.75 is up (screen y grows downward). " +
          (focus
            ? `Focus ${focus.role} id ${focus.id} is ${focus.dist} away at ${focus.bearing_deg}°. `
            : hunter
              ? `No assigned prey. Cover is (${state.cover?.x ?? 0},${state.cover?.y ?? 0}). `
              : "No focus. Stay inside the circle. ") +
          (state.nearest_green
            ? `Nearest other green is ${state.nearest_green.dist} away at ${state.nearest_green.bearing_deg}°. `
            : "") +
          `edge_dist=${state.you.edge_dist}. greens_left=${state.greens_left}.`,
        criteria: {
          true: "Aim downward / clockwise from right (toward 0.5–1).",
          false: "Aim upward / counterclockwise from right (toward 0–0.25).",
        },
      },
    });
    const body: SurvivalPilotResponse = {
      heading: noul(result.answers?.heading as JevNoulAnswer | undefined),
      model: result.model,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

function publicFile(pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, relative));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const route = url.pathname.replace(/\/$/, "") || "/";
    if (req.method === "POST" && route === "/api/pilot") return handleFlappy(req);
    if (req.method === "POST" && route === "/api/pong") return handlePong(req);
    if (req.method === "POST" && route === "/api/invaders") return handleInvaders(req);
    if (req.method === "POST" && route === "/api/worms") return handleWorms(req);
    if (req.method === "POST" && route === "/api/flight") return handleFlight(req);
    if (req.method === "POST" && route === "/api/space") return handleSpace(req);
    if (req.method === "POST" && route === "/api/drive") return handleDrive(req);
    if (req.method === "POST" && route === "/api/survival") return handleSurvival(req);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const filePath = publicFile(url.pathname);
    if (!filePath) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "Cache-Control": "no-store" } });
  },
});

console.log(`Jev arcade at http://${server.hostname}:${server.port}/`);
