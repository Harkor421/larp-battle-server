import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import geoip from "geoip-lite";

import { config } from "./config.js";
import { mountAdmin } from "./admin.js";
import { judgeBattle, moderateFrame } from "./judge.js";
import { validateUsername, validateSolanaWallet } from "./profile.js";
import {
  averageHash,
  hammingDistance,
  normalizeFrame,
} from "./frames.js";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, Battle>} battleId -> battle */
const battles = new Map();
/** Waiting players: [{ ws, ip, country }] */
let queue = [];
/** ip -> { reason, ts } */
const bans = new Map();
/** ip -> Set<ws> of that IP's active sockets. Enforces one competitor per IP:
 *  a newer session evicts older ones (so reconnects always succeed). */
const connByIp = new Map();

const BANS_FILE = path.join(config.dataDir, "bans.json");
const REPORTS_DIR = path.join(config.dataDir, "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
try {
  const saved = JSON.parse(fs.readFileSync(BANS_FILE, "utf8"));
  for (const [ip, info] of Object.entries(saved)) bans.set(ip, info);
  console.log(`[bans] loaded ${bans.size} ban(s)`);
} catch {
  /* no bans file yet */
}

function persistBans() {
  try {
    fs.writeFileSync(BANS_FILE, JSON.stringify(Object.fromEntries(bans), null, 2));
  } catch (err) {
    console.error("[bans] persist failed:", err?.message);
  }
}

function banIp(ip, reason) {
  bans.set(ip, { reason, ts: new Date().toISOString() });
  persistBans();
  console.log(`[bans] banned ${ip}: ${reason}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientIp(req) {
  // x-forwarded-for is "client, proxy1, proxy2, ...": each proxy APPENDS the
  // address it received the connection from, so a client can forge leftmost
  // entries but not the ones our trusted proxies appended. With H trusted hops,
  // the real client IP is the H-th entry from the right. Taking the leftmost
  // entry (or any raw client-supplied header) would let anyone spoof their IP
  // to evade bans or frame an innocent IP into a ban.
  const socketIp = req.socket?.remoteAddress || "unknown";
  const hops = config.trustProxyHops;
  if (hops === 0) return socketIp;
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return socketIp;
  const chain = String(xff)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return socketIp;
  return chain[chain.length - hops] || chain[0];
}

// Fast, synchronous best-guess country: Cloudflare header if present, else the
// offline geoip-lite DB (which can be stale). Used to fill the UI instantly.
function countryFast(req, ip) {
  const cf = req.headers["cf-ipcountry"];
  if (cf && cf !== "XX" && cf !== "T1") return String(cf).toUpperCase();
  const hit = geoip.lookup(ip);
  return hit?.country || "??";
}

function isPublicIp(ip) {
  if (!ip || ip === "unknown") return false;
  return !/^(10\.|127\.|192\.168\.|169\.254\.|::1|fc|fd|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(ip);
}

// Accurate, current country via a live lookup (ipwho.is — free, HTTPS, no key),
// cached per IP, with the offline DB as fallback. Note: for a user on a VPN this
// returns the VPN exit country, which is the best any IP lookup can do.
const geoCache = new Map(); // ip -> { cc, exp }
const GEO_TTL_MS = 24 * 60 * 60 * 1000;

async function resolveCountry(ip) {
  const now = Date.now();
  const cached = geoCache.get(ip);
  if (cached && cached.exp > now) return cached.cc;
  let cc = null;
  if (isPublicIp(ip)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(
        `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`,
        { signal: ctrl.signal }
      );
      clearTimeout(timer);
      const j = await res.json();
      if (j && j.success && j.country_code) cc = String(j.country_code).toUpperCase();
    } catch {
      /* fall through to offline DB */
    }
  }
  if (!cc) cc = geoip.lookup(ip)?.country || null;
  if (cc) geoCache.set(ip, { cc, exp: now + GEO_TTL_MS });
  return cc;
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// coturn REST credentials (use-auth-secret): username is an expiry unix
// timestamp, credential is base64(HMAC-SHA1(secret, username)).
function turnCredentials() {
  const iceServers = config.stunUrls.map((url) => ({ urls: url }));
  if (config.turnHost && config.turnSecret) {
    const username = String(
      Math.floor(Date.now() / 1000) + config.turnTtlSeconds
    );
    const credential = crypto
      .createHmac("sha1", config.turnSecret)
      .update(username)
      .digest("base64");
    iceServers.push({
      urls: [
        `turn:${config.turnHost}:3478?transport=udp`,
        `turn:${config.turnHost}:3478?transport=tcp`,
        `turns:${config.turnHost}:5349?transport=tcp`,
      ],
      username,
      credential,
    });
  }
  return iceServers;
}

// ---------------------------------------------------------------------------
// Battle lifecycle
// ---------------------------------------------------------------------------

function makePlayer(ws, ip, country) {
  return {
    ws,
    ip,
    country,
    username: ws.username || "Anon",
    wallet: ws.wallet || "",
    token: crypto.randomUUID(),
    ready: false,
    frames: [], // { buf, ts, hash }
    framesReceived: 0,
    lastFrameAt: 0,
    lastHash: null,
  };
}

function startBattleIfReady(battle) {
  if (battle.state !== "connecting") return;
  const { A, B } = battle.players;
  if (A.ready && B.ready) beginBattle(battle);
}

function beginBattle(battle) {
  if (battle.state !== "connecting") return;
  clearTimeout(battle.readyTimer);
  battle.state = "live";
  battle.endsAt = Date.now() + config.battleDurationMs;
  for (const role of ["A", "B"]) {
    send(battle.players[role].ws, {
      type: "battle_start",
      endsAt: battle.endsAt,
      durationMs: config.battleDurationMs,
    });
  }
  battle.endTimer = setTimeout(() => endBattle(battle), config.battleDurationMs);
  console.log(`[battle ${battle.id}] live`);
}

async function endBattle(battle) {
  if (battle.state !== "live") return;
  battle.state = "judging";
  for (const role of ["A", "B"]) {
    send(battle.players[role].ws, { type: "judging" });
  }
  console.log(
    `[battle ${battle.id}] judging (A: ${battle.players.A.frames.length} frames, B: ${battle.players.B.frames.length} frames)`
  );
  const verdict = await judgeBattle(
    battle.players.A.frames,
    battle.players.B.frames
  );
  battle.state = "done";
  battle.verdict = verdict;
  for (const role of ["A", "B"]) {
    send(battle.players[role].ws, { type: "verdict", role, verdict });
  }
  // Keep the battle around briefly so late frame uploads 404 cleanly and
  // reports can still grab evidence, then free the memory.
  battle.cleanupTimer = setTimeout(() => destroyBattle(battle.id), 120_000);
}

function abortBattle(battle, reason) {
  if (battle.state === "done" || battle.state === "aborted") return;
  battle.state = "aborted";
  clearTimeout(battle.readyTimer);
  clearTimeout(battle.endTimer);
  for (const role of ["A", "B"]) {
    send(battle.players[role].ws, { type: "battle_aborted", reason });
  }
  console.log(`[battle ${battle.id}] aborted: ${reason}`);
  battle.cleanupTimer = setTimeout(() => destroyBattle(battle.id), 60_000);
}

function destroyBattle(id) {
  const battle = battles.get(id);
  if (!battle) return;
  clearTimeout(battle.readyTimer);
  clearTimeout(battle.endTimer);
  clearTimeout(battle.cleanupTimer);
  for (const role of ["A", "B"]) {
    const p = battle.players[role];
    p.frames = [];
    // Only detach the socket if it's still pointing at THIS battle — the player
    // may already be in a newer battle (e.g. hit "Next") by the time this
    // delayed cleanup fires.
    if (p.ws && p.ws.battleId === id) p.ws.battleId = null;
  }
  battles.delete(id);
}

function tryMatch() {
  // Drop dead sockets from the queue first.
  queue = queue.filter((e) => e.ws.readyState === WebSocket.OPEN);
  while (queue.length >= 2) {
    const a = queue.shift();
    // Don't match a player against another connection from their own IP — that
    // is both a self-battle exploit and pointless. Find the first different IP.
    // (ALLOW_SAME_IP_MATCH bypasses this for solo testing / low-traffic launch.)
    const j = config.allowSameIpMatch
      ? 0
      : queue.findIndex((e) => e.ip !== a.ip);
    if (j === -1) {
      queue.unshift(a); // no eligible partner yet; wait for someone else
      break;
    }
    const b = queue.splice(j, 1)[0];
    const battle = {
      id: crypto.randomUUID(),
      state: "connecting",
      players: {
        A: makePlayer(a.ws, a.ip, a.country),
        B: makePlayer(b.ws, b.ip, b.country),
      },
      createdAt: Date.now(),
    };
    battles.set(battle.id, battle);
    a.ws.battleId = battle.id;
    a.ws.role = "A";
    b.ws.battleId = battle.id;
    b.ws.role = "B";

    const common = {
      type: "matched",
      battleId: battle.id,
      durationMs: config.battleDurationMs,
      frameIntervalMs: config.frameIntervalMs,
      iceServers: turnCredentials(),
    };
    // A is the caller (creates the WebRTC offer), B is the callee.
    send(a.ws, {
      ...common,
      role: "A",
      isCaller: true,
      token: battle.players.A.token,
      peerCountry: battle.players.B.country,
      peerName: battle.players.B.username,
      peerWallet: battle.players.B.wallet,
    });
    send(b.ws, {
      ...common,
      role: "B",
      isCaller: false,
      token: battle.players.B.token,
      peerCountry: battle.players.A.country,
      peerName: battle.players.A.username,
      peerWallet: battle.players.A.wallet,
    });

    // If the pair never gets media flowing, start anyway (frames may still
    // arrive) or abort if neither side is ready.
    battle.readyTimer = setTimeout(() => {
      if (battle.state !== "connecting") return;
      const { A, B } = battle.players;
      if (A.ready || B.ready) beginBattle(battle);
      else abortBattle(battle, "Could not establish a connection.");
    }, config.readyTimeoutMs);

    console.log(
      `[battle ${battle.id}] matched ${battle.players.A.country} vs ${battle.players.B.country}`
    );
  }
}

function peerOf(battle, role) {
  return battle.players[role === "A" ? "B" : "A"];
}

function leaveBattle(ws, notifyPeer = true) {
  const battle = battles.get(ws.battleId);
  ws.battleId = null;
  if (!battle) return;
  const role = ws.role;
  if (battle.state === "connecting" || battle.state === "live") {
    if (notifyPeer) {
      send(peerOf(battle, role).ws, { type: "peer_left" });
    }
    abortBattle(battle, "Your opponent left the battle.");
  }
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  if (bans.has(ip)) {
    send(ws, { type: "banned", reason: bans.get(ip).reason });
    ws.close();
    return;
  }
  ws.ip = ip;
  // One competitor per IP: evict the IP's older session(s), newest wins. This
  // also makes it impossible to match two players from the same IP.
  let ipSet = connByIp.get(ip);
  if (!ipSet) { ipSet = new Set(); connByIp.set(ip, ipSet); }
  while (ipSet.size >= config.maxConnPerIp) {
    const stale = ipSet.values().next().value;
    ipSet.delete(stale);
    try {
      send(stale, {
        type: "superseded",
        reason: "You opened Larp Battle in another tab or on another device.",
      });
      stale.close();
    } catch {
      /* ignore */
    }
  }
  ipSet.add(ws);
  ws.country = countryFast(req, ip); // instant best-guess
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  send(ws, { type: "hello", country: ws.country });

  // Refine with an accurate live lookup, then update the client's flag. There's
  // time before the user clicks "Find", so matches use the refined country.
  const cfHeader = req.headers["cf-ipcountry"];
  if (!(cfHeader && cfHeader !== "XX" && cfHeader !== "T1")) {
    resolveCountry(ip)
      .then((cc) => {
        if (cc && cc !== ws.country && ws.readyState === WebSocket.OPEN) {
          ws.country = cc;
          send(ws, { type: "hello", country: cc });
        }
      })
      .catch(() => {});
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "set_profile": {
        const u = validateUsername(msg.username);
        if (!u.ok) {
          send(ws, { type: "profile_error", field: "username", reason: u.reason });
          break;
        }
        const w = validateSolanaWallet(msg.wallet);
        if (!w.ok) {
          send(ws, { type: "profile_error", field: "wallet", reason: w.reason });
          break;
        }
        ws.username = u.value;
        ws.wallet = w.value;
        send(ws, { type: "profile_ok", username: u.value, wallet: w.value });
        break;
      }
      case "join_queue": {
        if (bans.has(ws.ip)) return;
        if (!ws.username || !ws.wallet) {
          send(ws, { type: "profile_error", reason: "Set your username and Solana wallet first." });
          return;
        }
        leaveBattle(ws);
        if (!queue.some((e) => e.ws === ws)) {
          queue.push({ ws, ip: ws.ip, country: ws.country });
        }
        send(ws, { type: "queued" });
        tryMatch();
        break;
      }
      case "leave_queue": {
        queue = queue.filter((e) => e.ws !== ws);
        break;
      }
      case "signal": {
        const battle = battles.get(ws.battleId);
        if (!battle || (battle.state !== "connecting" && battle.state !== "live"))
          return;
        send(peerOf(battle, ws.role).ws, { type: "signal", data: msg.data });
        break;
      }
      case "ready": {
        const battle = battles.get(ws.battleId);
        if (!battle || battle.state !== "connecting") return;
        battle.players[ws.role].ready = true;
        startBattleIfReady(battle);
        break;
      }
      case "leave": {
        leaveBattle(ws);
        break;
      }
      case "report": {
        handleReport(ws, String(msg.reason || "unspecified").slice(0, 500));
        break;
      }
    }
  });

  ws.on("close", () => {
    queue = queue.filter((e) => e.ws !== ws);
    leaveBattle(ws);
    const set = connByIp.get(ws.ip);
    if (set) {
      set.delete(ws);
      if (set.size === 0) connByIp.delete(ws.ip);
    }
  });
});

// Heartbeat: drop dead connections so the queue and battles don't leak.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

function handleReport(ws, reason) {
  const battle = battles.get(ws.battleId);
  if (!battle) return;
  const reportedRole = ws.role === "A" ? "B" : "A";
  const reported = battle.players[reportedRole];
  const dir = path.join(REPORTS_DIR, battle.id);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Persist reported player's frames as evidence, plus metadata.
    reported.frames.forEach((f, i) => {
      fs.writeFileSync(path.join(dir, `frame_${String(i).padStart(3, "0")}.jpg`), f.buf);
    });
    fs.writeFileSync(
      path.join(dir, "report.json"),
      JSON.stringify(
        {
          battleId: battle.id,
          reason,
          reportedAt: new Date().toISOString(),
          reportedRole,
          reportedCountry: reported.country,
          reporterCountry: battle.players[ws.role].country,
          // Store a hash, not the raw IP, for the reporter; raw IP for the
          // reported party (needed to action the report / ban).
          reportedIp: reported.ip,
          reporterIpHash: crypto
            .createHash("sha256")
            .update(battle.players[ws.role].ip)
            .digest("hex"),
          frameCount: reported.frames.length,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("[report] persist failed:", err?.message);
  }
  send(ws, { type: "report_received" });
  abortBattle(battle, "The battle was ended following a report.");
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

app.disable("x-powered-by");

// CORS — the frontend is served from a different origin (Vercel) than this
// backend (Railway). An image/jpeg POST is not a "simple" request, so browsers
// send an OPTIONS preflight that must be answered. Restrict to CORS_ORIGIN
// (comma-separated allowlist) if set; otherwise reflect the request origin.
const corsAllowlist = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (corsAllowlist.length === 0 || corsAllowlist.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Battle-Token");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Gated admin panel (before static so /admin routes take precedence).
mountAdmin(app, express, {
  battles,
  getQueue: () => queue,
  bans,
  banIp,
  abortBattle,
  clientIp,
});

app.use(express.static("public"));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    battles: battles.size,
    queued: queue.length,
    uptimeSec: Math.round(process.uptime()),
  });
});

// Note: TURN credentials are handed out only inside the authenticated `matched`
// WebSocket message (see tryMatch), never via an open HTTP endpoint — otherwise
// anyone could mint relay credentials and use the TURN server as a free proxy.

app.post(
  "/api/battle/:id/frame",
  express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: config.maxFrameBytes }),
  async (req, res) => {
    const battle = battles.get(req.params.id);
    const token = req.headers["x-battle-token"];
    if (!battle || battle.state !== "live") {
      return res.status(404).json({ error: "no live battle" });
    }
    const role = battle.players.A.token === token ? "A"
      : battle.players.B.token === token ? "B"
      : null;
    if (!role) return res.status(403).json({ error: "bad token" });
    const player = battle.players[role];
    if (bans.has(player.ip)) return res.status(403).json({ error: "banned" });

    const now = Date.now();
    if (now - player.lastFrameAt < config.minFrameGapMs) {
      return res.status(429).json({ error: "too fast" });
    }
    if (!req.body?.length) return res.status(400).json({ error: "empty frame" });
    player.lastFrameAt = now;
    player.framesReceived++;

    try {
      const buf = await normalizeFrame(req.body);
      const hash = await averageHash(buf);

      // Moderation on every Nth *received* frame (free via OpenAI).
      if (
        config.moderationEveryNFrames > 0 &&
        (player.framesReceived - 1) % config.moderationEveryNFrames === 0
      ) {
        moderateFrame(buf).then((cats) => {
          if (cats.length && battles.has(battle.id) && battle.state === "live") {
            banIp(player.ip, `moderation: ${cats.join(",")}`);
            abortBattle(battle, "The battle was ended by automated moderation.");
            player.ws?.close();
          }
        });
      }

      // Skip near-duplicates of the last accepted frame.
      if (
        player.lastHash &&
        hammingDistance(player.lastHash, hash) <= config.dedupeHammingThreshold
      ) {
        return res.json({ ok: true, stored: false });
      }
      player.lastHash = hash;
      if (player.frames.length < config.maxStoredFramesPerPlayer) {
        player.frames.push({ buf, ts: now, hash });
      }
      res.json({ ok: true, stored: true });
    } catch (err) {
      console.error("[frame] processing failed:", err?.message);
      res.status(400).json({ error: "bad image" });
    }
  }
);

// ---------------------------------------------------------------------------

server.listen(config.port, () => {
  console.log(`larp-battle listening on http://localhost:${config.port}`);
});
