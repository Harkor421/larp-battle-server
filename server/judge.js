import OpenAI from "openai";
import { config } from "./config.js";
import { sampleEvenly } from "./frames.js";

const openai = config.openaiApiKey
  ? new OpenAI({ apiKey: config.openaiApiKey })
  : null;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["players", "winner", "commentary"],
  properties: {
    players: {
      type: "array",
      description: "Exactly two entries, one for player A and one for player B",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["player", "items", "total_value_usd", "notes"],
        properties: {
          player: { type: "string", enum: ["A", "B"] },
          items: {
            type: "array",
            description:
              "Each DISTINCT item of value shown on camera, counted once even if it appears in many frames",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "name",
                "brand_or_model",
                "est_value_usd_low",
                "est_value_usd_high",
                "confidence",
                "authenticity",
              ],
              properties: {
                name: {
                  type: "string",
                  description: "Short item name, e.g. 'wristwatch', 'sports car'",
                },
                brand_or_model: {
                  type: "string",
                  description:
                    "Best identification of brand/model, or 'unidentified' if not visible",
                },
                est_value_usd_low: { type: "number" },
                est_value_usd_high: { type: "number" },
                confidence: {
                  type: "number",
                  description: "0-1 confidence in the identification",
                },
                authenticity: {
                  type: "string",
                  enum: ["likely_genuine", "uncertain", "likely_replica"],
                },
              },
            },
          },
          total_value_usd: {
            type: "number",
            description:
              "Sum of midpoint values, discounted for low confidence and replica risk",
          },
          notes: { type: "string" },
        },
      },
    },
    winner: { type: "string", enum: ["A", "B", "tie"] },
    commentary: {
      type: "string",
      description:
        "2-4 sentence playful verdict announcing the winner, suitable to show both players",
    },
  },
};

const SYSTEM_PROMPT = `You are the judge of a "flex battle": two strangers on a video call each show off
their most valuable possessions (watches, cars, jewelry, designer clothes, electronics, sneakers, etc.).
You receive still frames captured from each player's camera during the battle.

Your job:
1. For EACH player, list every distinct item of monetary value visibly shown. Count each distinct
   item ONCE even if it appears in many frames. Ignore ordinary background objects (furniture,
   basic phones/laptops used to film, generic clothing) unless clearly luxury.
2. Identify brand and model where the frames allow it. If you cannot identify it, say "unidentified"
   and value it conservatively.
3. Estimate a fair USED-MARKET value range in USD for each item. Be skeptical: poor lighting,
   implausible combinations, or tell-tale flaws should lower confidence and raise replica suspicion.
   Discount likely replicas to replica prices.
4. Compute each player's total (midpoints, discounted by confidence and authenticity).
5. Declare the winner: the player whose shown items are worth more. Declare a tie only when the
   totals are within 15% of each other or neither player showed anything of value.
6. Write short, punchy, good-natured commentary (this is a game — be entertaining, never cruel,
   no comments about the players' bodies or appearance, only their items).

Frames labeled PLAYER A belong to player A; frames labeled PLAYER B belong to player B.
If one player's frames are missing or show nothing, score them zero and say so.`;

function frameParts(frames) {
  return frames.map((f) => ({
    type: "image_url",
    image_url: {
      url: `data:image/jpeg;base64,${f.buf.toString("base64")}`,
      detail: "high",
    },
  }));
}

export async function judgeBattle(framesA, framesB) {
  if (!openai) {
    return fallbackVerdict("Judging is disabled (no OPENAI_API_KEY set).");
  }
  const max = config.judgeAllFrames ? Infinity : config.maxJudgeFramesPerPlayer;
  const a = sampleEvenly(framesA, max === Infinity ? framesA.length : max);
  const b = sampleEvenly(framesB, max === Infinity ? framesB.length : max);

  if (a.length === 0 && b.length === 0) {
    return fallbackVerdict("Neither player sent any frames — no verdict.");
  }

  const userContent = [
    {
      type: "text",
      text: `PLAYER A — ${a.length} frame(s) captured during the battle:`,
    },
    ...frameParts(a),
    {
      type: "text",
      text: `PLAYER B — ${b.length} frame(s) captured during the battle:`,
    },
    ...frameParts(b),
    {
      type: "text",
      text: "Judge the battle now. Return only the JSON verdict.",
    },
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: config.judgeModel,
      max_tokens: 2000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "battle_verdict",
          strict: true,
          schema: VERDICT_SCHEMA,
        },
      },
    });
    const msg = resp.choices?.[0]?.message;
    if (msg?.refusal) {
      return fallbackVerdict("The judge declined to score this battle.");
    }
    const verdict = JSON.parse(msg.content);
    verdict.judged_frames = { A: a.length, B: b.length };
    return verdict;
  } catch (err) {
    console.error("[judge] scoring failed:", err?.message || err);
    return fallbackVerdict("Judging failed due to a technical error.");
  }
}

function fallbackVerdict(reason) {
  return {
    players: [
      { player: "A", items: [], total_value_usd: 0, notes: reason },
      { player: "B", items: [], total_value_usd: 0, notes: reason },
    ],
    winner: "tie",
    commentary: reason,
    judged_frames: { A: 0, B: 0 },
  };
}

// Free image moderation (omni-moderation-latest). Returns the list of
// triggered categories that are in the configured abort list, or [].
export async function moderateFrame(jpegBuffer) {
  if (!openai) return [];
  try {
    const resp = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${jpegBuffer.toString("base64")}`,
          },
        },
      ],
    });
    const result = resp.results?.[0];
    if (!result?.flagged) return [];
    return Object.entries(result.categories || {})
      .filter(([cat, hit]) => hit && config.moderationAbortCategories.includes(cat))
      .map(([cat]) => cat);
  } catch (err) {
    console.error("[moderation] check failed:", err?.message || err);
    return [];
  }
}
