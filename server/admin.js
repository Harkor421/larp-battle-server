import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-memory admin sessions: sessionId -> expiresAt(ms). Cleared on restart.
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const COOKIE = "larp_admin";

// Per-IP login throttle.
const loginHits = new Map(); // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function newSession(res) {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}`
  );
}

function clearSession(req, res) {
  const id = parseCookies(req)[COOKIE];
  if (id) sessions.delete(id);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`
  );
}

function isAuthed(req) {
  const id = parseCookies(req)[COOKIE];
  if (!id) return false;
  const exp = sessions.get(id);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(id);
    return false;
  }
  return true;
}

function throttleLogin(ip) {
  const now = Date.now();
  let rec = loginHits.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginHits.set(ip, rec);
  }
  rec.count++;
  return rec.count > LOGIN_MAX;
}

/**
 * Mount the admin panel. deps: { battles, getQueue, bans, banIp, abortBattle, clientIp }
 */
export function mountAdmin(app, express, deps) {
  if (!config.adminToken) {
    console.warn("[admin] ADMIN_TOKEN not set — admin panel disabled.");
    app.get("/admin", (_req, res) =>
      res.status(404).send("Admin panel is disabled (ADMIN_TOKEN not set).")
    );
    return;
  }

  const requireAuth = (req, res, next) => {
    if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
    next();
  };

  // Login page + dashboard (single static file; JS handles the two states).
  app.get("/admin", (_req, res) =>
    res.sendFile(path.join(__dirname, "..", "public", "admin.html"))
  );

  app.post("/admin/login", express.json(), (req, res) => {
    const ip = deps.clientIp(req);
    if (throttleLogin(ip)) {
      return res.status(429).json({ error: "too many attempts, wait 15 min" });
    }
    const pw = req.body?.password || "";
    if (!timingSafeEqual(pw, config.adminToken)) {
      return res.status(403).json({ error: "wrong password" });
    }
    newSession(res);
    res.json({ ok: true });
  });

  app.post("/admin/logout", (req, res) => {
    clearSession(req, res);
    res.json({ ok: true });
  });

  // Live snapshot of all battles + queue.
  app.get("/admin/api/state", requireAuth, (_req, res) => {
    const now = Date.now();
    const list = [];
    for (const b of deps.battles.values()) {
      const mk = (p) => ({
        country: p.country,
        ip: p.ip,
        framesReceived: p.framesReceived,
        storedFrames: p.frames.length,
        ready: p.ready,
      });
      list.push({
        id: b.id,
        state: b.state,
        createdAt: b.createdAt,
        endsAt: b.endsAt || null,
        secondsLeft: b.endsAt ? Math.max(0, Math.round((b.endsAt - now) / 1000)) : null,
        winner: b.verdict?.winner || null,
        A: mk(b.players.A),
        B: mk(b.players.B),
      });
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    res.json({
      now,
      liveBattles: list.filter((b) => b.state === "live").length,
      totalBattles: list.length,
      queued: deps.getQueue().length,
      bans: [...deps.bans.entries()].map(([ip, info]) => ({ ip, ...info })),
      battles: list,
    });
  });

  // Latest captured frame for one player (moderation oversight thumbnail).
  app.get("/admin/api/battle/:id/frame/:role", requireAuth, (req, res) => {
    const b = deps.battles.get(req.params.id);
    const role = req.params.role === "A" ? "A" : req.params.role === "B" ? "B" : null;
    if (!b || !role) return res.status(404).end();
    const frames = b.players[role].frames;
    const last = frames[frames.length - 1];
    if (!last) return res.status(404).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(last.buf);
  });

  // Kill a battle.
  app.post("/admin/api/battle/:id/kill", requireAuth, (req, res) => {
    const b = deps.battles.get(req.params.id);
    if (!b) return res.status(404).json({ error: "no such battle" });
    deps.abortBattle(b, "This battle was ended by a moderator.");
    res.json({ ok: true });
  });

  // Ban an IP (and kill any battle it's in).
  app.post("/admin/api/ban", express.json(), requireAuth, (req, res) => {
    const ip = String(req.body?.ip || "").slice(0, 64);
    const reason = String(req.body?.reason || "admin ban").slice(0, 200);
    if (!ip) return res.status(400).json({ error: "ip required" });
    deps.banIp(ip, reason);
    for (const b of deps.battles.values()) {
      if (b.players.A.ip === ip || b.players.B.ip === ip) {
        deps.abortBattle(b, "This battle was ended by a moderator.");
      }
    }
    res.json({ ok: true });
  });

  // Sweep expired sessions occasionally.
  setInterval(() => {
    const now = Date.now();
    for (const [id, exp] of sessions) if (now > exp) sessions.delete(id);
  }, 60 * 60 * 1000).unref?.();

  console.log("[admin] panel enabled at /admin");
}
