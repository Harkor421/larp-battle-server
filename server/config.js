import "dotenv/config.js";

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: num("PORT", 3000),

  // OpenAI (judge + free image moderation)
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  judgeModel: process.env.JUDGE_MODEL || "gpt-4.1-mini",

  // TURN (self-hosted coturn with use-auth-secret / REST credentials)
  turnHost: process.env.TURN_HOST || "",
  turnSecret: process.env.TURN_SECRET || "",
  turnTtlSeconds: num("TURN_TTL_SECONDS", 3600),
  stunUrls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Battle
  battleDurationMs: num("BATTLE_DURATION_MS", 60_000),
  frameIntervalMs: num("FRAME_INTERVAL_MS", 1000),
  readyTimeoutMs: num("READY_TIMEOUT_MS", 25_000),

  // Abuse limits
  // Trusted reverse-proxy hops in front of this server (Railway = 1;
  // Cloudflare in front of Railway = 2). Used to pick the real client IP from
  // x-forwarded-for; the leftmost/attacker-supplied entries are ignored.
  trustProxyHops:
    process.env.TRUST_PROXY_HOPS === undefined
      ? 1
      : Math.max(0, Number(process.env.TRUST_PROXY_HOPS) || 0),
  maxConnPerIp: num("MAX_CONN_PER_IP", 8),
  // Normally two connections from the same IP are never matched (prevents
  // self-battle + is pointless). Set true to allow it — useful for solo testing
  // in two tabs, or during very-low-traffic launch. Leave false in production.
  allowSameIpMatch: process.env.ALLOW_SAME_IP_MATCH === "true",

  // Admin panel (disabled unless ADMIN_TOKEN is set)
  adminToken: process.env.ADMIN_TOKEN || "",

  // Frames (high quality for accurate item identification)
  maxFrameBytes: num("MAX_FRAME_BYTES", 2_000_000),
  frameMaxEdge: num("FRAME_MAX_EDGE", 1280),
  frameJpegQuality: num("FRAME_JPEG_QUALITY", 92),
  maxStoredFramesPerPlayer: num("MAX_STORED_FRAMES_PER_PLAYER", 180),
  minFrameGapMs: num("MIN_FRAME_GAP_MS", 700),
  dedupeHammingThreshold: num("DEDUPE_HAMMING_THRESHOLD", 5),

  // Judging
  maxJudgeFramesPerPlayer: num("MAX_JUDGE_FRAMES_PER_PLAYER", 24),
  judgeAllFrames: process.env.JUDGE_ALL_FRAMES === "true",

  // Moderation (OpenAI omni-moderation-latest is free)
  moderationEveryNFrames: num("MODERATION_EVERY_N_FRAMES", 5),
  moderationAbortCategories: (
    process.env.MODERATION_ABORT_CATEGORIES || "sexual,sexual/minors"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  dataDir: process.env.DATA_DIR || "data",
};

if (!config.openaiApiKey) {
  console.warn(
    "[config] OPENAI_API_KEY is not set — battles will run but judging and moderation are disabled."
  );
}
if (!config.turnHost || !config.turnSecret) {
  console.warn(
    "[config] TURN_HOST / TURN_SECRET not set — clients get STUN only. " +
      "~10-20% of real-world calls will fail to connect until you deploy coturn (see coturn/DEPLOY.md)."
  );
}
