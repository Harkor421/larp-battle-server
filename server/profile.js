import bs58 from "bs58";
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

// Robust profanity matcher (handles leetspeak, spacing, and other obfuscation).
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

const USERNAME_MIN = 2;
const USERNAME_MAX = 20;
// Letters, numbers, spaces, and a few safe symbols. No control chars / markup.
const USERNAME_ALLOWED = /^[\p{L}\p{N} _.\-]+$/u;

/**
 * Validate + normalize a username.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function validateUsername(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "Enter a username." };
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < USERNAME_MIN)
    return { ok: false, reason: "Username is too short." };
  if (name.length > USERNAME_MAX)
    return { ok: false, reason: `Username must be ${USERNAME_MAX} characters or fewer.` };
  if (!USERNAME_ALLOWED.test(name))
    return { ok: false, reason: "Use only letters, numbers, spaces, . _ or -" };
  // Check both the raw name and a separator-stripped form so "f u c k" or
  // "s.h.i.t" can't slip past by spacing the letters out.
  const stripped = name.replace(/[\s._-]+/g, "");
  if (matcher.hasMatch(name) || matcher.hasMatch(stripped))
    return { ok: false, reason: "That username isn't allowed. Pick another." };
  return { ok: true, value: name };
}

/**
 * Validate an OPTIONAL Solana address (base58-encoded 32-byte public key).
 * Empty / missing is allowed and returns an empty value.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function validateSolanaWallet(raw) {
  if (raw == null || (typeof raw === "string" && raw.trim() === ""))
    return { ok: true, value: "" }; // optional — no wallet is fine
  if (typeof raw !== "string")
    return { ok: false, reason: "That doesn't look like a Solana address." };
  const addr = raw.trim();
  if (addr.length < 32 || addr.length > 44)
    return { ok: false, reason: "That doesn't look like a Solana address." };
  try {
    const decoded = bs58.decode(addr);
    if (decoded.length !== 32)
      return { ok: false, reason: "That doesn't look like a Solana address." };
  } catch {
    return { ok: false, reason: "That doesn't look like a Solana address." };
  }
  return { ok: true, value: addr };
}

// Short display form of a wallet, e.g. 7xKXtg…9f2Ab1
export function shortWallet(addr) {
  if (typeof addr !== "string" || addr.length < 10) return addr || "";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
