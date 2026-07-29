import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { config } from "./config.js";
import { col, mongoEnabled } from "./db.js";

const FILE = path.join(config.dataDir, "leaderboard.json");
const PAYOUTS_FILE = path.join(config.dataDir, "payouts.json");

// wallet -> { username, points, wins, battles, totalReceivedLamports }
const board = new Map();

fs.mkdirSync(config.dataDir, { recursive: true });
try {
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const [w, e] of Object.entries(saved)) board.set(w, e);
  console.log(`[leaderboard] loaded ${board.size} entr${board.size === 1 ? "y" : "ies"}`);
} catch {
  /* no file yet */
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(board), null, 2));
    } catch (err) {
      console.error("[leaderboard] persist failed:", err?.message);
    }
  }, 500);
}

// Mirror one wallet's entry into MongoDB (fire-and-forget; files remain the
// synchronous backup on the volume).
function mongoUpsert(wallet, e) {
  const c = col("leaderboard");
  if (!c) return;
  c.updateOne({ _id: wallet }, { $set: { ...e } }, { upsert: true }).catch((err) =>
    console.error("[leaderboard] mongo upsert failed:", err?.message)
  );
}

/**
 * Load durable state from MongoDB on startup (when enabled). If Mongo already
 * holds data it becomes the source of truth (survives volume loss); if Mongo is
 * empty, we seed it from whatever the JSON files loaded. Falls back silently to
 * files when Mongo is disabled/unreachable.
 */
export async function initLeaderboardStore() {
  if (!mongoEnabled()) return;
  try {
    const lc = col("leaderboard");
    const docs = await lc.find({}).toArray();
    if (docs.length) {
      board.clear();
      for (const d of docs) {
        board.set(d._id, {
          username: d.username || "Anon",
          points: d.points || 0,
          wins: d.wins || 0,
          battles: d.battles || 0,
          totalReceivedLamports: d.totalReceivedLamports || 0,
        });
      }
      console.log(`[leaderboard] loaded ${board.size} entr${board.size === 1 ? "y" : "ies"} from MongoDB`);
    } else if (board.size) {
      for (const [w, e] of board) mongoUpsert(w, e);
      console.log(`[leaderboard] seeded MongoDB from ${board.size} file entr${board.size === 1 ? "y" : "ies"}`);
    }

    const pc = col("payouts");
    const ph = await pc.find({}).sort({ ts: -1 }).limit(PAYOUT_HISTORY_MAX).toArray();
    if (ph.length) {
      payoutHistory = ph.map((d) => ({ ts: d.ts, totalSol: d.totalSol, count: d.count, items: d.items || [] }));
    } else if (payoutHistory.length) {
      for (const p of payoutHistory) pc.insertOne(p).catch(() => {});
    }
  } catch (err) {
    console.error("[leaderboard] mongo init failed (using files):", err?.message);
  }
}

/**
 * Award points for a finished battle. Only players with a wallet accrue points
 * (the wallet is the payout identity). Call once per player.
 */
export function recordBattle({ wallet, username, score, won }) {
  if (!wallet) return; // no wallet → not on the pot leaderboard
  const e = board.get(wallet) || {
    username: username || "Anon",
    points: 0,
    wins: 0,
    battles: 0,
    totalReceivedLamports: 0,
  };
  if (username) e.username = username; // keep the latest name
  e.battles += 1;
  e.points += config.participationPoints;
  if (won) {
    e.wins += 1;
    e.points += Math.max(1, Math.round((Number(score) || 0) * config.winPointsMult));
  }
  board.set(wallet, e);
  persist();
  mongoUpsert(wallet, e);
}

// ---- Pot balance (read-only) ----
let conn = null;
function connection() {
  if (!conn) conn = new Connection(config.solanaRpcUrl, "confirmed");
  return conn;
}

// Cache the pot balance so many clients polling the leaderboard don't hammer the
// RPC (public RPCs rate-limit hard).
let potCache = { lamports: 0, at: 0 };
const POT_TTL_MS = 20_000;

export async function getPotLamports() {
  if (!config.potWalletAddress) return 0;
  if (Date.now() - potCache.at < POT_TTL_MS) return potCache.lamports;
  try {
    const bal = await connection().getBalance(new PublicKey(config.potWalletAddress), "confirmed");
    potCache = { lamports: bal, at: Date.now() };
    return bal;
  } catch (err) {
    console.error("[leaderboard] pot balance failed:", err?.message);
    return potCache.lamports; // serve last known on error
  }
}

// ---- Leaderboard view with pot shares ----
export async function getLeaderboard() {
  const potLamports = await getPotLamports();
  // The distributable prize pool is a fixed fraction (default 80%) of the pot
  // wallet balance; the remaining fraction stays in the wallet.
  const poolLamports = Math.max(0, Math.floor(potLamports * config.potPayoutFraction));

  const rows = [...board.entries()]
    .map(([wallet, e]) => ({ wallet, ...e }))
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, config.maxLeaderboardRecipients);

  const totalPoints = rows.reduce((s, r) => s + r.points, 0);

  const entries = rows.map((r, i) => {
    const share = totalPoints > 0 ? r.points / totalPoints : 0;
    const shareLamports = Math.floor(poolLamports * share);
    return {
      rank: i + 1,
      username: r.username,
      wallet: r.wallet,
      points: r.points,
      wins: r.wins,
      battles: r.battles,
      sharePct: +(share * 100).toFixed(2),
      shareSol: +(shareLamports / LAMPORTS_PER_SOL).toFixed(4),
      receivedSol: +((r.totalReceivedLamports || 0) / LAMPORTS_PER_SOL).toFixed(4),
    };
  });

  return {
    pot: {
      wallet: config.potWalletAddress || null,
      lamports: potLamports,
      sol: +(potLamports / LAMPORTS_PER_SOL).toFixed(4),
      poolSol: +(poolLamports / LAMPORTS_PER_SOL).toFixed(4),
      payoutPct: Math.round(config.potPayoutFraction * 100),
      configured: !!config.potWalletAddress,
    },
    totalPoints,
    players: entries.length,
    entries,
    nextPayoutAt,
    intervalMs: config.distributeEveryMs,
    updatedAt: Date.now(),
  };
}

// ---- Distribution (admin-gated, dry-run unless a secret is configured) ----
function distributorKeypair() {
  try {
    if (config.distributorSecretJson) {
      return Keypair.fromSecretKey(new Uint8Array(JSON.parse(config.distributorSecretJson)));
    }
    if (config.distributorSecretBase58) {
      return Keypair.fromSecretKey(bs58.decode(config.distributorSecretBase58));
    }
  } catch (err) {
    console.error("[leaderboard] distributor key parse failed:", err?.message);
  }
  return null;
}

/**
 * Distribute the pot proportionally to points. Dry-run (no SOL moves) unless a
 * distributor secret is configured AND confirm === true.
 */
export async function distribute({ confirm = false } = {}) {
  const kp = distributorKeypair();
  const dryRun = !confirm || !kp;

  const lb = await getLeaderboard();
  const poolLamports = Math.floor(lb.pot.poolSol * LAMPORTS_PER_SOL);
  if (lb.totalPoints <= 0 || poolLamports <= 0) {
    return { ok: true, dryRun, reason: "nothing to distribute", potSol: lb.pot.sol, count: 0, items: [] };
  }
  if (kp && config.potWalletAddress && kp.publicKey.toBase58() !== config.potWalletAddress) {
    return { ok: false, reason: "distributor key does not match POT_WALLET_ADDRESS" };
  }

  // Plan: floor each share, then trim overflow from the tail.
  const planned = lb.entries.map((e) => ({
    to: e.wallet,
    username: e.username,
    lamports: Math.floor(poolLamports * (e.points / lb.totalPoints)),
  }));
  let sum = planned.reduce((s, p) => s + p.lamports, 0);
  for (let i = planned.length - 1; i >= 0 && sum > poolLamports; i--) {
    const cut = Math.min(planned[i].lamports, sum - poolLamports);
    planned[i].lamports -= cut;
    sum -= cut;
  }
  const payouts = planned.filter((p) => p.lamports > 0);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      note: kp ? "confirm:false" : "no distributor secret configured",
      potSol: lb.pot.sol,
      distributedSol: +(sum / LAMPORTS_PER_SOL).toFixed(4),
      count: payouts.length,
      items: payouts.map((p) => ({ to: p.to, username: p.username, sol: +(p.lamports / LAMPORTS_PER_SOL).toFixed(4), sig: null })),
    };
  }

  // Real transfers, batched.
  const c = connection();
  const txids = [];
  const items = [];
  for (let i = 0; i < payouts.length; i += config.maxRecipientsPerTx) {
    const batch = payouts.slice(i, i + config.maxRecipientsPerTx);
    const tx = new Transaction();
    for (const p of batch) {
      tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(p.to), lamports: p.lamports }));
    }
    tx.feePayer = kp.publicKey;
    try {
      const sig = await sendAndConfirmTransaction(c, tx, [kp], { commitment: "confirmed" });
      txids.push(sig);
      for (const p of batch) {
        const e = board.get(p.to);
        if (e) {
          e.totalReceivedLamports = (e.totalReceivedLamports || 0) + p.lamports;
          mongoUpsert(p.to, e);
        }
        items.push({ to: p.to, username: p.username, sol: +(p.lamports / LAMPORTS_PER_SOL).toFixed(4), sig });
      }
    } catch (err) {
      console.error("[leaderboard] batch transfer failed:", err?.message);
      for (const p of batch) items.push({ to: p.to, username: p.username, sol: +(p.lamports / LAMPORTS_PER_SOL).toFixed(4), sig: null, error: err?.message });
    }
  }
  persist();
  return {
    ok: true,
    dryRun: false,
    potSol: lb.pot.sol,
    distributedSol: +(payouts.reduce((s, p) => s + p.lamports, 0) / LAMPORTS_PER_SOL).toFixed(4),
    count: items.filter((x) => x.sig).length,
    txids,
    items,
  };
}

// ---- Payout scheduler + history ----
const PAYOUT_HISTORY_MAX = 60;
let payoutHistory = [];
let nextPayoutAt = 0;
let payoutTimer = null;

try {
  const saved = JSON.parse(fs.readFileSync(PAYOUTS_FILE, "utf8"));
  if (Array.isArray(saved)) payoutHistory = saved.slice(0, PAYOUT_HISTORY_MAX);
} catch {
  /* no file yet */
}
function persistPayouts() {
  try {
    fs.writeFileSync(PAYOUTS_FILE, JSON.stringify(payoutHistory, null, 2));
  } catch (err) {
    console.error("[payout] persist failed:", err?.message);
  }
}

async function runScheduledPayout() {
  nextPayoutAt = Date.now() + config.distributeEveryMs;
  try {
    const result = await distribute({ confirm: config.autoPayoutEnabled });
    // Only record REAL payouts (with on-chain sigs) — dry-runs don't clutter the page.
    if (result.ok && !result.dryRun && result.count > 0) {
      const record = {
        ts: Date.now(),
        totalSol: result.distributedSol,
        count: result.count,
        items: result.items.map((x) => ({ username: x.username, wallet: x.to, sol: x.sol, sig: x.sig })),
      };
      payoutHistory.unshift(record);
      if (payoutHistory.length > PAYOUT_HISTORY_MAX) payoutHistory.length = PAYOUT_HISTORY_MAX;
      persistPayouts();
      col("payouts")?.insertOne(record).catch((err) =>
        console.error("[payout] mongo insert failed:", err?.message)
      );
    }
  } catch (err) {
    console.error("[payout] scheduled run failed:", err?.message);
  }
}

export function startPayoutScheduler() {
  nextPayoutAt = Date.now() + config.distributeEveryMs;
  clearInterval(payoutTimer);
  payoutTimer = setInterval(runScheduledPayout, config.distributeEveryMs);
  payoutTimer.unref?.();
  console.log(
    `[payout] scheduler every ${Math.round(config.distributeEveryMs / 1000)}s — auto=${config.autoPayoutEnabled}`
  );
}

export function getPayouts() {
  return {
    nextPayoutAt,
    intervalMs: config.distributeEveryMs,
    autoEnabled: config.autoPayoutEnabled,
    history: payoutHistory,
  };
}

export function getNextPayoutAt() {
  return nextPayoutAt;
}
