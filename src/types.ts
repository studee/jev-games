export type Phase = "ready" | "playing" | "dying" | "over";

export type PipeInfo = {
  px_until_pipe: number;
  gap_top_from_top_px: number;
  gap_bottom_from_top_px: number;
  gap_center_from_top_px: number;
};

export type GameSnapshot = {
  rules: string;
  phase: Phase;
  score: number;
  bird_from_top_px: number;
  bird_vy: number;
  ground_from_top_px: number;
  next_pipe: PipeInfo | string;
  if_wait_hits: boolean;
  if_flap_now_hits: boolean;
  waiting_hits: boolean;
  flapping_survives: boolean;
};

export type PilotResponse = {
  flap: boolean;
  should_flap: number;
  would_overshoot: number;
  model?: string;
  error?: string;
  detail?: string;
};

export type PongMove = "up" | "stay" | "down";

export type PongPaddleView = {
  side: "left" | "right";
  center_y: number;
  predicted_ball_y: number;
  error_px: number;
  ball_incoming: boolean;
};

export type PongSnapshot = {
  rules: string;
  mode: "user-vs-jev" | "jev-vs-jev";
  table: { width: number; height: number };
  ball: { x: number; y: number; vx: number; vy: number };
  left: PongPaddleView;
  right: PongPaddleView;
  score: { left: number; right: number };
  ask_left: boolean;
  ask_right: boolean;
};

export type PongPilotResponse = {
  left_aim?: number;
  right_aim?: number;
  model?: string;
  error?: string;
  detail?: string;
};

export type InvadersColumn = {
  id: number;
  x: number;
  lowest_y: number;
  count: number;
  points: number;
};

export type InvadersSnapshot = {
  rules: string;
  wave: number;
  score: number;
  lives: number;
  ship_x: number;
  can_fire: boolean;
  threat: { x: number; hits_if_stay: boolean } | null;
  ufo: { x: number } | null;
  columns: InvadersColumn[];
};

export type InvadersPilotResponse = {
  column?: number | "ufo";
  model?: string;
  error?: string;
  detail?: string;
};

export type WormsTeam = "you" | "jev";

export type WormsFoeView = {
  id: number;
  name: string;
  hp: number;
  x: number;
  y: number;
  loft_error_px: number;
  flat_error_px: number;
  loft_angle_deg: number;
  flat_angle_deg: number;
  loft_power: number;
  flat_power: number;
};

export type WormsWeapon = "bazooka" | "cluster" | "mortar";

export type WormsShotLog = {
  team: "you" | "jev";
  shooter: string;
  target_name: string;
  weapon: WormsWeapon;
  wind: number;
  loft: boolean;
  hit: boolean;
  miss_x: number;
  miss_y: number;
  impact_x: number;
  impact_y: number;
  intended_x: number;
  intended_y: number;
};

export type WormsWeaponScore = {
  id: WormsWeapon;
  error_px: number;
  target_id: number;
  target_name: string;
};

export type WormsSnapshot = {
  rules: string;
  wind: number;
  shooter: { id: number; name: string; x: number; y: number; facing: number };
  foes: WormsFoeView[];
  weapons: WormsWeaponScore[];
  recent_shots: WormsShotLog[];
};

export type WormsPilotResponse = {
  target_id?: number;
  loft?: number;
  power_adjust?: number;
  weapon?: WormsWeapon;
  model?: string;
  error?: string;
  detail?: string;
};

export type JevNoulAnswer = {
  type: "noul";
  noul: number;
};

export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type JevResult = {
  model?: string;
  answers?: Record<string, JevNoulAnswer | JevChoiceAnswer>;
};

export type FlightManeuver = "pursue" | "lead" | "guns" | "climb" | "dive" | "break" | "extend";

export type FlightSnapshot = {
  rules: string;
  you: { hp: number; x: number; y: number; z: number; heading_deg: number; speed: number };
  foe: { hp: number; x: number; y: number; z: number; heading_deg: number; speed: number };
  geometry: {
    range: number;
    bearing_deg: number;
    elevation_deg: number;
    aspect_deg: number;
    clock: string;
    high_or_low: "high" | "low" | "level";
    lined_up: boolean;
    they_have_guns_on_you: boolean;
    they_are_shooting: boolean;
    they_are_shooting_at_you: boolean;
    incoming_missile: boolean;
    closing: boolean;
    alt_diff: number;
  };
};

export type DriveManeuver = "chase" | "ram" | "circle" | "reverse" | "guns" | "brake" | "drift";

export type DriveSnapshot = {
  rules: string;
  you: { hp: number; x: number; z: number; heading_deg: number; speed: number; lap: number; checkpoint: number };
  foe: { hp: number; x: number; z: number; heading_deg: number; speed: number; lap: number; checkpoint: number };
  geometry: {
    range: number;
    bearing_deg: number;
    aspect_deg: number;
    clock: string;
    lined_up: boolean;
    they_have_guns_on_you: boolean;
    they_are_shooting: boolean;
    they_are_shooting_at_you: boolean;
    closing: boolean;
    wall_close: boolean;
    race_pos: number;
    laps_to_go: number;
    corner: "straight" | "entry" | "apex" | "exit";
  };
};

export type DrivePilotResponse = {
  maneuver?: DriveManeuver;
  fire?: number;
  model?: string;
  error?: string;
  detail?: string;
};

export type FlightPilotResponse = {
  maneuver?: FlightManeuver;
  fire?: number;
  model?: string;
  error?: string;
  detail?: string;
};
