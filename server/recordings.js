import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { sampleEvenly } from "./frames.js";
import { col, mongoEnabled } from "./db.js";

// Recordings live on the (persistent) data volume:
//   <dataDir>/recordings/
//     index.json              — newest-first summary list (file fallback)
//     <battleId>/
//       meta.json             — players, verdict, per-frame timing offsets
//       A_000.jpg … A_0NN.jpg — player A camera keyframes (deduped)
//       B_000.jpg … B_0NN.jpg — player B camera keyframes
//       A.webm / B.webm       — full video+audio clip uploaded by each client
// When MongoDB is enabled, the newest-first summary list is ALSO mirrored to the
// `recordings` collection so the admin list survives a volume reset (the media
// files themselves still require the volume). path.resolve keeps served paths
// absolute (res.sendFile requires it).
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

function summaryEntry(meta) {
  return {
    id: meta.id,
    endedAt: meta.endedAt,
    durationMs: meta.durationMs,
    winner: meta.winner,
    A: playerSummary(meta, "A"),
    B: playerSummary(meta, "B"),
    aFrames: meta.frames.A.length,
    bFrames: meta.frames.B.length,
    video: { A: hasVideo(meta.id, "A"), B: hasVideo(meta.id, "B") },
  };
}

function hasVideo(id, role) {
  if (role !== "A" && role !== "B") return false;
  return fs.existsSync(path.join(ROOT, id, `${role}.webm`));
}

function mongoUpsertSummary(entry) {
  const c = col("recordings");
  if (!c) return;
  c.updateOne({ _id: entry.id }, { $set: { ...entry } }, { upsert: true }).catch((err) =>
    console.error("[rec] mongo upsert failed:", err?.message)
  );
}

/** Load the recording summary list from Mongo into index.json on startup. */
export async function initRecordingsStore() {
  if (!mongoEnabled()) return;
  try {
    const c = col("recordings");
    const docs = await c.find({}).sort({ endedAt: -1 }).limit(config.maxRecordings).toArray();
    if (docs.length) {
      writeIndex(docs.map((d) => ({ ...d, id: d._id, _id: undefined })));
      console.log(`[rec] loaded ${docs.length} recording summar${docs.length === 1 ? "y" : "ies"} from MongoDB`);
    } else {
      for (const e of readIndex()) mongoUpsertSummary(e);
    }
  } catch (err) {
    console.error("[rec] mongo init failed (using files):", err?.message);
  }
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

    const entry = summaryEntry(meta); // picks up any webm already uploaded
    const list = readIndex().filter((r) => r.id !== battle.id);
    list.unshift(entry);
    writeIndex(list);
    mongoUpsertSummary(entry);
    await prune(list);

    console.log(
      `[rec] saved ${battle.id} (A:${meta.frames.A.length} B:${meta.frames.B.length} frames)`
    );
  } catch (err) {
    console.error("[rec] save failed:", err?.message);
  }
}

/**
 * Store the full video+audio clip a client uploaded for its side of a battle.
 * Arrives shortly after saveRecording (both start on match end), so this patches
 * the already-written summary/meta to flag the video as available.
 */
export async function saveRecordingVideo(battle, role, buf, mime = "webm") {
  const id = battle.id;
  if (!isValidId(id) || (role !== "A" && role !== "B")) throw new Error("bad target");
  const dir = path.join(ROOT, id);
  await fsp.mkdir(dir, { recursive: true });
  const ext = mime === "mp4" ? "mp4" : "webm";
  await fsp.writeFile(path.join(dir, `${role}.${ext}`), buf);

  // Patch meta.json (best-effort) so getRecordingMeta reflects the video.
  try {
    const metaPath = path.join(dir, "meta.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    meta.video = { ...(meta.video || {}), [role]: true };
    meta.videoMime = ext;
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch {
    /* meta not written yet — saveRecording's summaryEntry will detect the file */
  }

  // Patch the summary list + Mongo doc.
  const list = readIndex();
  const item = list.find((r) => r.id === id);
  if (item) {
    item.video = { ...(item.video || {}), [role]: true };
    writeIndex(list);
  }
  col("recordings")?.updateOne({ _id: id }, { $set: { [`video.${role}`]: true } }, { upsert: false }).catch(() => {});
  console.log(`[rec] video saved ${id} ${role} (${buf.length} bytes)`);
}

async function prune(list) {
  if (list.length <= config.maxRecordings) return;
  const keep = list.slice(0, config.maxRecordings);
  const remove = list.slice(config.maxRecordings);
  writeIndex(keep);
  for (const r of remove) {
    try {
      await fsp.rm(path.join(ROOT, r.id), { recursive: true, force: true });
      col("recordings")?.deleteOne({ _id: r.id }).catch(() => {});
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
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, id, "meta.json"), "utf8"));
    meta.video = { A: hasVideo(id, "A"), B: hasVideo(id, "B") };
    return meta;
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

/** Absolute path to a recording's webm/mp4 video for a role, or null. */
export function getVideoPath(id, role) {
  if (!isValidId(id) || (role !== "A" && role !== "B")) return null;
  for (const ext of ["webm", "mp4"]) {
    const p = path.join(ROOT, id, `${role}.${ext}`);
    if (p === path.normalize(p) && p.startsWith(ROOT + path.sep) && fs.existsSync(p)) {
      return { path: p, mime: ext === "mp4" ? "video/mp4" : "video/webm" };
    }
  }
  return null;
}

export async function deleteRecording(id) {
  if (!isValidId(id)) return false;
  try {
    await fsp.rm(path.join(ROOT, id), { recursive: true, force: true });
    writeIndex(readIndex().filter((r) => r.id !== id));
    col("recordings")?.deleteOne({ _id: id }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
