import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { sampleEvenly } from "./frames.js";

// Recordings live on the (persistent) data volume:
//   <dataDir>/recordings/
//     index.json              — newest-first summary list for the admin grid
//     <battleId>/
//       meta.json             — players, verdict, per-frame timing offsets
//       A_000.jpg … A_0NN.jpg — player A camera frames
//       B_000.jpg … B_0NN.jpg — player B camera frames
// path.resolve so served files are always absolute (res.sendFile requires it).
const ROOT = path.resolve(config.dataDir, "recordings");
const INDEX = path.join(ROOT, "index.json");
const SHARP_OPTS = { limitInputPixels: 40_000_000 };

fs.mkdirSync(ROOT, { recursive: true });

function readIndex() {
  try {
    const v = JSON.parse(fs.readFileSync(INDEX, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  try {
    fs.writeFileSync(INDEX, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error("[rec] index write failed:", err?.message);
  }
}

function isValidId(id) {
  return typeof id === "string" && /^[a-f0-9-]{8,64}$/i.test(id);
}

async function reencode(buf) {
  return sharp(buf, SHARP_OPTS)
    .resize(config.recordingFrameEdge, config.recordingFrameEdge, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: config.recordingJpegQuality, mozjpeg: true })
    .toBuffer();
}

function playerSummary(meta, role) {
  const p = meta.players[role] || {};
  const v = meta.verdict?.players?.find((x) => x.player === role);
  return {
    username: p.username || "Anon",
    wallet: p.wallet || "",
    country: p.country || "??",
    score: v?.score ?? null,
    total: v?.total_value_usd ?? null,
  };
}

/**
 * Persist a finished battle's captured frames + verdict as a replayable
 * recording. Safe to fire-and-forget: the passed frame buffers are held by the
 * local `chosen` arrays, so delayed battle cleanup won't drop them mid-write.
 */
export async function saveRecording(battle) {
  if (!config.recordingsEnabled) return;
  try {
    const dir = path.join(ROOT, battle.id);
    await fsp.mkdir(dir, { recursive: true });

    const endedAt = Date.now();
    const start =
      battle.createdAt ||
      (battle.endsAt ? battle.endsAt - config.battleDurationMs : endedAt);

    const meta = {
      id: battle.id,
      createdAt: battle.createdAt || null,
      endedAt,
      durationMs: config.battleDurationMs,
      winner: battle.verdict?.winner || null,
      verdict: battle.verdict || null,
      players: {},
      frames: { A: [], B: [] },
    };

    for (const role of ["A", "B"]) {
      const p = battle.players[role];
      meta.players[role] = {
        username: p.username,
        wallet: p.wallet,
        country: p.country,
        framesReceived: p.framesReceived,
      };
      const chosen = sampleEvenly(p.frames, config.recordingMaxFrames);
      let idx = 0;
      for (const f of chosen) {
        const out = await reencode(f.buf);
        await fsp.writeFile(
          path.join(dir, `${role}_${String(idx).padStart(3, "0")}.jpg`),
          out
        );
        meta.frames[role].push({ i: idx, t: Math.max(0, (f.ts || start) - start) });
        idx++;
      }
    }

    await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    const list = readIndex().filter((r) => r.id !== battle.id);
    list.unshift({
      id: battle.id,
      endedAt,
      durationMs: meta.durationMs,
      winner: meta.winner,
      A: playerSummary(meta, "A"),
      B: playerSummary(meta, "B"),
      aFrames: meta.frames.A.length,
      bFrames: meta.frames.B.length,
    });
    writeIndex(list);
    await prune(list);

    console.log(
      `[rec] saved ${battle.id} (A:${meta.frames.A.length} B:${meta.frames.B.length} frames)`
    );
  } catch (err) {
    console.error("[rec] save failed:", err?.message);
  }
}

async function prune(list) {
  if (list.length <= config.maxRecordings) return;
  const keep = list.slice(0, config.maxRecordings);
  const remove = list.slice(config.maxRecordings);
  writeIndex(keep);
  for (const r of remove) {
    try {
      await fsp.rm(path.join(ROOT, r.id), { recursive: true, force: true });
    } catch (err) {
      console.error("[rec] prune failed:", err?.message);
    }
  }
}

export function listRecordings() {
  return readIndex();
}

export function getRecordingMeta(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, id, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Absolute path to a recording frame file, or null. Guards path traversal. */
export function getFramePath(id, role, idx) {
  if (!isValidId(id)) return null;
  if (role !== "A" && role !== "B") return null;
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  const p = path.join(ROOT, id, `${role}_${String(n).padStart(3, "0")}.jpg`);
  if (p !== path.normalize(p) || !p.startsWith(ROOT + path.sep)) return null;
  return fs.existsSync(p) ? p : null;
}

export async function deleteRecording(id) {
  if (!isValidId(id)) return false;
  try {
    await fsp.rm(path.join(ROOT, id), { recursive: true, force: true });
    writeIndex(readIndex().filter((r) => r.id !== id));
    return true;
  } catch {
    return false;
  }
}
