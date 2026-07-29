import { config } from "./config.js";

// Optional MongoDB layer. When MONGODB_URI is set we use Mongo as the durable
// store (survives redeploys AND volume loss, and is queryable/backup-able);
// otherwise every module falls back to JSON files on the persistent volume.
// db.js never throws to callers: if Mongo is unreachable, col() returns null and
// the caller keeps using files.

let client = null;
let database = null;
let enabled = false;

export function mongoEnabled() {
  return enabled;
}

/** Connect once at startup. Safe to call when MONGODB_URI is unset (no-op). */
export async function initMongo() {
  if (!config.mongoUri) {
    console.log("[db] MONGODB_URI not set — persisting to JSON files on the volume.");
    return false;
  }
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(config.mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    await client.connect();
    database = client.db(config.mongoDbName);
    await database.command({ ping: 1 });
    enabled = true;
    console.log(`[db] connected to MongoDB (database: ${config.mongoDbName}).`);
    // Best-effort indexes (ignore errors — data still works without them).
    try {
      await database.collection("payouts").createIndex({ ts: -1 });
      await database.collection("recordings").createIndex({ endedAt: -1 });
    } catch {
      /* ignore */
    }
    return true;
  } catch (err) {
    console.error("[db] MongoDB connect failed — falling back to files:", err?.message);
    enabled = false;
    return false;
  }
}

/** Collection handle, or null when Mongo is disabled/unavailable. */
export function col(name) {
  return enabled && database ? database.collection(name) : null;
}

export async function closeMongo() {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
}
