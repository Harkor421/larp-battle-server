# ⚔️ Larp Battle

Omegle-style random 1:1 video **flex battles**. Two strangers get matched, each
has 2 minutes to show their most valuable stuff on camera, and GPT-4.1-mini
identifies every item, prices it, and declares the bigger flexer. Each player
sees the other's country flag (from their IP).

## Architecture (built for cheap scale)

| Piece | How | Cost |
|---|---|---|
| Video | **P2P WebRTC** — browsers stream directly to each other; server only does signaling | ~$0 for ~85% of calls |
| NAT fallback | Self-hosted **coturn** on Hetzner EX44 (1 Gbit unmetered) | €44/mo per box |
| Matchmaking | In-memory queue over WebSockets (Redis upgrade path documented) | included |
| Country flags | Cloudflare `CF-IPCountry` header, fallback to bundled GeoLite2 (`geoip-lite`) | $0 |
| Judge | 1 frame/sec captured client-side → deduped server-side → **GPT-4.1-mini** with strict JSON output | ~$0.02/battle |
| Moderation | OpenAI `omni-moderation-latest` on every 5th frame (free) + report button + IP bans + evidence retention | $0 |

At 1,000 simultaneous battles this runs on one or two €44/mo Hetzner boxes plus
about $0.02 per battle in judge fees. Managed video APIs for the same workload
cost $49k–$360k/month — see `coturn/DEPLOY.md` for the deployment guide.

## Admin panel

A gated moderation dashboard lives on the **backend** at `/admin` (it needs the
live in-memory battle state, so it can't be on the static frontend). Set
`ADMIN_TOKEN` (env var) to enable it; leave it unset to disable.

- **URL:** `<backend-url>/admin` — e.g. https://larp-battle-server-production.up.railway.app/admin
- **Login:** the `ADMIN_TOKEN` value. Session is a 24h-max httpOnly+Secure+SameSite=Strict cookie; login is rate-limited (10 tries / 15 min / IP); token compare is constant-time.
- **Shows:** every live/recent battle, both players' country + IP + frame counts, a live-refreshing thumbnail of each player's latest captured frame, and the queue/ban stats.
- **Actions:** end any battle, ban either player's IP (also kills their battle).

## Key env vars (see `.env.example`)

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | GPT-4.1-mini judge + free moderation. Without it, battles run but verdicts are disabled. |
| `ADMIN_TOKEN` | Enables `/admin`. Generate with `openssl rand -hex 32`. |
| `TRUST_PROXY_HOPS` | Reverse-proxy hops in front of the app (Railway = 1, +Cloudflare = 2, local = 0). Wrong value = spoofable client IPs / broken bans. |
| `MAX_CONN_PER_IP` | Per-IP WebSocket cap (DoS guard). Default 8. |
| `ALLOW_SAME_IP_MATCH` | `true` lets two connections from one IP match (solo testing / low-traffic launch). Set `false` for real production. |
| `BATTLE_DURATION_MS` | Battle length. Default 60000 (1 minute). |
| `TURN_HOST` / `TURN_SECRET` | Self-hosted coturn for the ~15% of calls that can't connect P2P. Without them, STUN-only. |

## Quick start (local)

```bash
npm install
cp .env.example .env   # add your OPENAI_API_KEY
npm start              # http://localhost:3000
```

Open two browser windows (one private/incognito), accept the gate in both, and
click **Find a battle** in each. Local testing works without TURN (both peers
are on localhost). Without `OPENAI_API_KEY` everything runs except judging and
moderation.

## How a battle works

1. Both players accept the 18+ gate and Terms, grant camera/mic.
2. Server matches two queued players, tells each the other's country, and
   relays WebRTC offer/answer/ICE between them. Video goes peer-to-peer
   (TURN relay only when NAT blocks P2P).
3. On connection, a 2-minute battle starts. Each client captures a JPEG of its
   **own** camera every second and uploads it (`X-Battle-Token` auth).
4. Server pipeline per frame: resize to ≤768px → perceptual-hash dedupe
   (near-identical consecutive frames are dropped, so you don't pay the judge
   for 120 copies of the same shot) → every 5th frame through free OpenAI
   image moderation (flag ⇒ instant abort + IP ban + evidence kept).
5. At the buzzer, up to 24 frames per player (sampled evenly across the whole
   battle — set `JUDGE_ALL_FRAMES=true` to send everything) go to GPT-4.1-mini
   with a strict JSON schema: every distinct item, brand/model, used-market
   value range, confidence, replica risk, per-player totals, winner, and
   commentary.
6. Both players get the itemized scoreboard. Report button preserves the
   reported player's frames + metadata under `data/reports/<battleId>/`.

## Judge cost knobs

| Setting | Frames judged | ~Cost/battle (GPT-4.1-mini) |
|---|---|---|
| default (`MAX_JUDGE_FRAMES_PER_PLAYER=24`) | ≤48 deduped | ~$0.02 |
| `JUDGE_ALL_FRAMES=true` | every stored 1s frame (≤360) | ~$0.10–0.13 |
| `MAX_JUDGE_FRAMES_PER_PLAYER=12` | ≤24 | ~$0.01 |

Frames are captured every second either way (`FRAME_INTERVAL_MS=1000`); the
knobs only control how many of them are billed to the judge. Dedupe means a
player holding one watch still gets it analyzed — just not 120 times.

## Scaling path

- **10k concurrent users:** still one app box. Add a second Hetzner box for
  TURN redundancy.
- **100k concurrent:** move the matchmaking queue + battle state to Redis
  (sorted-set queue, pub/sub for cross-node signaling), run 2–4 app instances
  behind a load balancer. The design keeps all per-battle state in one place
  (`battles` map) specifically to make this swap contained.
- **Judge:** stateless — scales with your OpenAI rate limits, not your servers.

## Legal / safety (read this)

Random video chat is the category that killed Omegle (the lawsuit attacked the
random-matching design itself — Section 230 did not protect it). This repo
ships the minimum hooks: 18+ gate with Terms consent, per-frame AI moderation,
report + evidence retention, IP bans. Before a real launch you still need:

- A lawyer's pass over `public/terms.html` and `public/privacy.html` (they are
  templates with placeholders).
- Real age assurance (e.g. facial age estimation ~$0.10/signup) for UK/EU/AU
  exposure — or geoblock those jurisdictions until you have it.
- An NCMEC reporting workflow for CSAM evidence (US legal requirement once you
  become aware of it), and a human review queue for reports.

`geoip-lite` note: bundles MaxMind GeoLite2 data — keep the attribution in the
privacy policy and update the package periodically for fresh data.
