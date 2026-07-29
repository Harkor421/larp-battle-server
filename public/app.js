/* Larp Battle client: WebSocket signaling + WebRTC P2P + 1s frame capture. */
(() => {
  "use strict";

  // ---------- Backend origin (empty = same origin) ----------
  const BACKEND = (window.LARP_CONFIG && window.LARP_CONFIG.backendOrigin) || "";
  function wsUrl() {
    if (BACKEND) return BACKEND.replace(/^http/i, "ws") + "/ws";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }
  function apiUrl(path) { return BACKEND ? BACKEND + path : path; }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const gate = $("gate");
  const agreeCheck = $("agreeCheck");
  const enterBtn = $("enterBtn");
  const statusEl = $("status");
  const timerText = $("timerText");
  const localVideo = $("localVideo");
  const remoteVideo = $("remoteVideo");
  const localCountry = $("localCountry");
  const remoteCountry = $("remoteCountry");
  const remoteLabel = $("remoteLabel");
  const findBtn = $("findBtn");
  const cancelBtn = $("cancelBtn");
  const nextBtn = $("nextBtn");
  const reportBtn = $("reportBtn");
  const againBtn = $("againBtn");
  const usernameInput = $("usernameInput");
  const walletInput = $("walletInput");
  const profileError = $("profileError");
  const localName = $("localName");
  const localWallet = $("localWallet");

  // ---------- State ----------
  let ws = null, pc = null, localStream = null, battle = null;
  let captureTimer = null, countdownTimer = null, pendingCandidates = [];
  let stopReconnect = false; // set when banned or superseded — don't reconnect
  let myProfile = null;      // { username, wallet } once validated by the server
  let entered = false;       // whether we've revealed the app past the gate
  let opponent = null;       // { name, wallet, country } of the current opponent
  const captureCanvas = document.createElement("canvas");

  const regionFmt = (() => {
    try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
  })();
  function regionName(cc) {
    if (!cc || cc.length !== 2 || /[^A-Za-z]/.test(cc)) return "Unknown";
    try { return regionFmt ? regionFmt.of(cc.toUpperCase()) || cc.toUpperCase() : cc.toUpperCase(); }
    catch { return cc.toUpperCase(); }
  }

  function setStatus(t) { statusEl.textContent = t || ""; }

  function shortWallet(a) {
    return typeof a === "string" && a.length >= 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || "");
  }

  const reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Rotating search phrases ----------
  const SEARCH_PHRASES = [
    "Finding an opponent…",
    "Scanning the globe…",
    "Matching you with a challenger…",
    "Searching the arena…",
  ];
  let searchPhraseTimer = null;
  function startSearchPhrases() {
    const el = $("searchText");
    if (!el) return;
    let i = 0;
    el.textContent = SEARCH_PHRASES[0];
    clearInterval(searchPhraseTimer);
    searchPhraseTimer = setInterval(() => {
      i = (i + 1) % SEARCH_PHRASES.length;
      el.style.opacity = "0";
      setTimeout(() => { el.textContent = SEARCH_PHRASES[i]; el.style.opacity = "1"; }, 200);
    }, 2200);
  }
  function stopSearchPhrases() { clearInterval(searchPhraseTimer); searchPhraseTimer = null; }

  // ---------- Confetti ----------
  function launchConfetti() {
    if (reduceMotion) return;
    const canvas = $("confetti");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = window.innerWidth, H = window.innerHeight;
    const colors = ["#d8b45a", "#e8c877", "#ffffff", "#37c88a", "#7aa2ff"];
    const N = 160;
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * 120,
        y: H / 3,
        vx: (Math.random() - 0.5) * 12,
        vy: Math.random() * -14 - 4,
        size: Math.random() * 6 + 4,
        color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        life: 0,
      });
    }
    const start = performance.now();
    function frame(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of parts) {
        p.vy += 0.35; // gravity
        p.vx *= 0.99;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life++;
        if (p.y < H + 20) alive++;
        const fade = Math.max(0, 1 - elapsed / 2600);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (elapsed < 2600 && alive > 0) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  const BTN = { find: findBtn, cancel: cancelBtn, next: nextBtn, report: reportBtn };
  const SCREEN_BUTTONS = {
    lobby: ["find"], searching: ["cancel"],
    connecting: ["next", "report"], battle: ["next", "report"],
    judging: [], verdict: [],
  };
  function setScreen(name) {
    app.dataset.screen = name;
    const show = SCREEN_BUTTONS[name] || [];
    for (const k of Object.keys(BTN)) BTN[k].classList.toggle("hidden", !show.includes(k));
    if (name === "searching") startSearchPhrases();
    else stopSearchPhrases();
  }

  // ---------- Age gate + profile ----------
  // Prefill saved profile
  usernameInput.value = localStorage.getItem("larp_username") || "";
  walletInput.value = localStorage.getItem("larp_wallet") || "";

  agreeCheck.addEventListener("change", updateEnterEnabled);
  usernameInput.addEventListener("input", updateEnterEnabled);
  walletInput.addEventListener("input", updateEnterEnabled);
  function updateEnterEnabled() {
    enterBtn.disabled = !(agreeCheck.checked && usernameInput.value.trim().length >= 2);
  }
  function showProfileError(t) { profileError.textContent = t || ""; }

  enterBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim().replace(/\s+/g, " ");
    const wallet = walletInput.value.trim();
    if (username.length < 2) return showProfileError("Enter a username (2+ characters).");
    if (wallet && (wallet.length < 32 || wallet.length > 44))
      return showProfileError("Enter a valid Solana wallet, or leave it blank.");
    showProfileError("");
    enterBtn.disabled = true;
    myProfile = { username, wallet }; // provisional until server confirms
    if (ws && ws.readyState === WebSocket.OPEN) sendProfile();
    else connectWs(); // profile is sent on open
  });

  function sendProfile() {
    if (myProfile) wsSend({ type: "set_profile", username: myProfile.username, wallet: myProfile.wallet });
  }

  // ---------- Media ----------
  async function initMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      });
      localVideo.srcObject = localStream;
      setStatus("Camera ready. Start a battle when you are.");
    } catch {
      setStatus("Camera and microphone access is required. Reload and allow access.");
      findBtn.disabled = true;
    }
  }

  // ---------- WebSocket ----------
  function connectWs() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => {
      // (Re)establish the profile on this connection — the server tracks it per
      // socket, so reconnects must re-send it.
      if (myProfile) sendProfile();
    });
    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener("close", () => {
      if (stopReconnect) return;
      setStatus("Reconnecting…");
      teardownBattle();
      setTimeout(connectWs, 2000);
    });
  }
  function wsSend(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

  async function handleMessage(msg) {
    switch (msg.type) {
      case "hello": localCountry.textContent = regionName(msg.country); break;
      case "profile_ok": {
        myProfile = { username: msg.username, wallet: msg.wallet };
        localStorage.setItem("larp_username", msg.username);
        localStorage.setItem("larp_wallet", msg.wallet);
        localName.textContent = msg.username;
        localWallet.textContent = shortWallet(msg.wallet);
        if (!entered) {
          entered = true;
          localStorage.setItem("larp_tos_accepted", new Date().toISOString());
          gate.classList.add("hidden");
          app.classList.remove("hidden");
          setScreen("lobby");
          initMedia();
          startLeaderboardPolling();
        }
        enterBtn.disabled = false;
        break;
      }
      case "profile_error":
        enterBtn.disabled = false;
        if (!entered) showProfileError(msg.reason || "Please fix your profile.");
        else setStatus(msg.reason || "");
        break;
      case "banned":
        stopReconnect = true;
        teardownBattle();
        setStatus("Access blocked: " + (msg.reason || "banned"));
        setScreen("lobby"); findBtn.disabled = true; break;
      case "superseded":
        stopReconnect = true;
        teardownBattle();
        setScreen("lobby"); findBtn.disabled = true;
        setStatus((msg.reason || "This session was closed.") + " Reload to play here.");
        break;
      case "queued": setStatus("Searching for an opponent…"); break;
      case "matched": await onMatched(msg); break;
      case "signal": await onSignal(msg.data); break;
      case "battle_start": onBattleStart(msg); break;
      case "judging": stopCapture(); setScreen("judging"); setStatus("Scoring the match…"); break;
      case "verdict": showVerdict(msg.role, msg.verdict); break;
      case "battle_aborted":
        setStatus(msg.reason || "Match ended.");
        teardownBattle(); setScreen("lobby"); findBtn.textContent = "Find a battle"; break;
      case "peer_left": setStatus("Your opponent left."); break;
      case "report_received": setStatus("Report received. Thank you."); break;
    }
  }

  // ---------- Controls ----------
  findBtn.addEventListener("click", () => {
    hideVerdict(); setScreen("searching"); wsSend({ type: "join_queue" });
  });
  cancelBtn.addEventListener("click", () => {
    wsSend({ type: "leave_queue" }); setScreen("lobby"); setStatus("Search cancelled.");
  });
  againBtn.addEventListener("click", () => {
    wsSend({ type: "leave" });
    teardownBattle(); // now close the call
    hideVerdict();
    setScreen("searching");
    wsSend({ type: "join_queue" });
  });
  nextBtn.addEventListener("click", () => {
    wsSend({ type: "leave" }); teardownBattle(); hideVerdict();
    setScreen("searching"); wsSend({ type: "join_queue" });
  });
  reportBtn.addEventListener("click", () => {
    const reason = prompt("What happened? (nudity, harassment, scam, underage, other)");
    if (reason !== null) wsSend({ type: "report", reason: reason || "unspecified" });
  });

  // ---------- WebRTC ----------
  async function onMatched(msg) {
    battle = {
      id: msg.battleId, role: msg.role, token: msg.token,
      isCaller: msg.isCaller, frameIntervalMs: msg.frameIntervalMs || 1000,
    };
    pendingCandidates = [];
    opponent = { name: msg.peerName || "Opponent", wallet: msg.peerWallet || "", country: msg.peerCountry };
    remoteLabel.textContent = opponent.name;
    remoteCountry.textContent = regionName(msg.peerCountry);
    $("remoteWallet").textContent = shortWallet(opponent.wallet);
    setScreen("connecting");
    setStatus(opponent.name + " found in " + regionName(msg.peerCountry) + ". Connecting…");

    pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.ontrack = (ev) => { if (remoteVideo.srcObject !== ev.streams[0]) remoteVideo.srcObject = ev.streams[0]; };
    pc.onicecandidate = (ev) => { if (ev.candidate) wsSend({ type: "signal", data: { candidate: ev.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { setStatus("Connected. Get ready…"); wsSend({ type: "ready" }); }
      else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setStatus("Connection lost.");
        const hint = document.querySelector(".cta-hint");
        if (hint && app.dataset.screen === "verdict") hint.textContent = "Your opponent disconnected.";
      }
    };
    if (battle.isCaller) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: "signal", data: { sdp: pc.localDescription } });
    }
  }

  async function onSignal(data) {
    if (!pc) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
        pendingCandidates = [];
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ type: "signal", data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else pendingCandidates.push(data.candidate);
      }
    } catch (err) { console.error("signal error", err); }
  }

  // ---------- Battle ----------
  function onBattleStart(msg) {
    setScreen("battle");
    setStatus("Live — show your most valuable items.");
    startCountdown(msg.endsAt);
    startCapture();
    goFlash();
  }

  function goFlash() {
    if (reduceMotion) return;
    const f = $("flash");
    if (!f) return;
    f.innerHTML = "<span>GO</span>";
    f.classList.add("show");
    setTimeout(() => { f.classList.remove("show"); f.innerHTML = ""; }, 1050);
  }
  function startCountdown(endsAt) {
    clearInterval(countdownTimer);
    const timerEl = $("timer");
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      timerText.textContent = `${m}:${String(s).padStart(2, "0")}`;
      timerEl.classList.toggle("low", left > 0 && left <= 10000);
      if (left <= 0) clearInterval(countdownTimer);
    };
    tick(); countdownTimer = setInterval(tick, 250);
  }
  function startCapture() {
    stopCapture();
    captureTimer = setInterval(async () => {
      if (!battle || !localStream) return;
      const track = localStream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") return;
      const vw = localVideo.videoWidth, vh = localVideo.videoHeight;
      if (!vw || !vh) return;
      // Capture at high quality (up to 1280px long edge) so the judge can read
      // watch dials, logos, and model numbers. The server re-encodes to match.
      const scale = Math.min(1, 1280 / Math.max(vw, vh));
      captureCanvas.width = Math.round(vw * scale);
      captureCanvas.height = Math.round(vh * scale);
      const cctx = captureCanvas.getContext("2d");
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(localVideo, 0, 0, captureCanvas.width, captureCanvas.height);
      const blob = await new Promise((r) => captureCanvas.toBlob(r, "image/jpeg", 0.92));
      if (!blob || !battle) return;
      fetch(apiUrl(`/api/battle/${battle.id}/frame`), {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "X-Battle-Token": battle.token },
        body: blob,
      }).catch(() => {});
    }, battle.frameIntervalMs);
  }
  function stopCapture() { clearInterval(captureTimer); captureTimer = null; }

  function teardownBattle() {
    stopCapture();
    clearInterval(countdownTimer);
    $("timer").classList.remove("low");
    if (pc) { pc.close(); pc = null; }
    remoteVideo.srcObject = null;
    battle = null;
  }

  // ---------- Verdict ----------
  function money(n) {
    if (typeof n !== "number" || !isFinite(n)) return "$0";
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  function clampScore(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(10, n));
  }
  function countUp(el, target, suffixDecimals) {
    const start = performance.now(), dur = 900;
    function frame(now) {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(suffixDecimals);
      if (t < 1) requestAnimationFrame(frame);
      else el.textContent = target.toFixed(suffixDecimals);
    }
    requestAnimationFrame(frame);
  }

  function midpoint(it) {
    return ((Number(it.est_value_usd_low) || 0) + (Number(it.est_value_usd_high) || 0)) / 2;
  }
  function isCounted(it) { return it && it.counted !== false; }
  // Same weighting the backend scores with: TOP ITEM is the item that
  // contributed the most to the score, not merely the biggest sticker price
  // (a convincing fake with a huge sticker still contributes little).
  const AUTH_FACTOR = { likely_genuine: 1.0, uncertain: 0.2, likely_replica: 0.05 };
  function itemWeight(it) {
    if (!isCounted(it)) return 0;
    const low = Number(it.est_value_usd_low) || 0;
    const conf = Math.max(0, Math.min(1, Number(it.confidence) || 0));
    const auth = AUTH_FACTOR[it.authenticity] ?? 0.2;
    const base = it.authenticity === "likely_genuine" && conf >= 0.6 ? midpoint(it) : low;
    return Math.max(0, base * conf * auth);
  }

  function renderItems(ul, items) {
    ul.innerHTML = "";
    const list = Array.isArray(items) ? items.slice() : [];
    if (list.length === 0) {
      const li = document.createElement("li");
      li.className = "items-empty";
      li.textContent = "Nothing of value shown.";
      ul.appendChild(li);
      return;
    }

    // TOP ITEM = the biggest contributor to the score (and any co-headliner
    // within 70% of it), among COUNTED items only. Weighted, not raw sticker.
    const counted = list.filter(isCounted).sort((a, b) => itemWeight(b) - itemWeight(a));
    const top = counted.length ? itemWeight(counted[0]) : 0;
    const decisive = new Set();
    counted.forEach((it, i) => {
      if (top > 0 && (i === 0 || itemWeight(it) >= 0.7 * top) && decisive.size < 3) decisive.add(it);
    });

    // Order: counted by contribution desc, then uncounted by sticker value desc.
    list.sort((a, b) => {
      const ca = isCounted(a) ? 1 : 0, cb = isCounted(b) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return ca ? itemWeight(b) - itemWeight(a) : midpoint(b) - midpoint(a);
    });

    list.forEach((item, i) => {
      const counts = isCounted(item);
      const isDecisive = decisive.has(item);
      const li = document.createElement("li");
      li.className = "item" + (isDecisive ? " decisive" : "") + (counts ? "" : " uncounted");
      li.style.animationDelay = (0.12 + i * 0.06) + "s";

      const main = document.createElement("div");
      main.className = "item-main";
      const name = document.createElement("div");
      name.className = "item-name";
      name.textContent = item.name || "Item";
      if (isDecisive) {
        const tag = document.createElement("span");
        tag.className = "tag"; tag.textContent = "TOP ITEM";
        name.appendChild(tag);
      } else if (!counts) {
        const tag = document.createElement("span");
        tag.className = "tag muted"; tag.textContent = "NOT COUNTED";
        name.appendChild(tag);
      }
      const sub = document.createElement("div");
      sub.className = "item-sub";
      sub.textContent = item.brand_or_model || "unidentified";
      if (!counts) sub.append(" · shown on screen, doesn't count");
      else if (item.authenticity === "likely_replica") {
        const r = document.createElement("span");
        r.className = "repl"; r.textContent = " · likely replica";
        sub.appendChild(r);
      } else if (item.authenticity === "uncertain") {
        sub.append(" · authenticity uncertain");
      }
      main.appendChild(name); main.appendChild(sub);

      const val = document.createElement("div");
      val.className = "item-val" + (counts ? "" : " struck");
      val.textContent = `${money(item.est_value_usd_low)}–${money(item.est_value_usd_high)}`;

      li.appendChild(main); li.appendChild(val);
      ul.appendChild(li);
    });
  }

  function showVerdict(myRole, verdict) {
    // Stop frame capture + the countdown, but KEEP the peer connection alive so
    // the players can still see/hear each other behind the modal until one of
    // them hits "Next opponent" (which tears the call down).
    stopCapture();
    clearInterval(countdownTimer);
    $("timer").classList.remove("low");
    verdict = verdict || {};
    const players = Array.isArray(verdict.players) ? verdict.players : [];
    const me = players.find((p) => p && p.player === myRole) || {};
    const them = players.find((p) => p && p.player !== myRole) || {};
    const iWon = verdict.winner === myRole;
    const tie = verdict.winner === "tie" || !verdict.winner;

    $("whoYou").textContent = (myProfile && myProfile.username) || "You";
    $("whoThem").textContent = (opponent && opponent.name) || "Opponent";

    const result = $("verdictResult");
    result.textContent = tie ? "Draw" : iWon ? "You win" : "You got larped";
    result.className = "verdict-result " + (tie ? "tie" : iWon ? "win" : "lose");
    $("verdictReason").textContent = verdict.commentary || "";

    const sYou = clampScore(me.score), sThem = clampScore(them.score);
    const sideYou = $("sideYou"), sideThem = $("sideThem");
    sideYou.classList.toggle("win", iWon && !tie);
    sideYou.classList.toggle("lose", !iWon && !tie);
    sideThem.classList.toggle("win", !iWon && !tie);
    sideThem.classList.toggle("lose", iWon && !tie);

    // Totals/score/winner are computed server-side (weighted, tamper-proof) and
    // trusted here so the number, the score bar, and the outcome always agree.
    $("totalYou").textContent = money(me.total_value_usd);
    $("totalThem").textContent = money(them.total_value_usd);
    renderItems($("itemsYou"), me.items);
    renderItems($("itemsThem"), them.items);

    $("crown").classList.toggle("show", iWon && !tie);

    setScreen("verdict");
    setStatus("");
    // Animate after the screen paints.
    requestAnimationFrame(() => {
      countUp($("scoreYou"), sYou, 1);
      countUp($("scoreThem"), sThem, 1);
      $("barYou").style.width = sYou * 10 + "%";
      $("barThem").style.width = sThem * 10 + "%";
    });
    if (iWon && !tie) setTimeout(launchConfetti, 350);
  }

  function hideVerdict() {
    // Reset bars so the next reveal animates from zero.
    $("barYou").style.width = "0%";
    $("barThem").style.width = "0%";
  }

  // ---------- Leaderboard rail + payouts ----------
  const rail = $("rail"), railList = $("railList"), railEmpty = $("railEmpty");
  const railPotSol = $("railPotSol"), railCountdown = $("railCountdown");
  const payCountdown = $("payCountdown");
  const payouts = $("payouts"), payList = $("payList"), payEmpty = $("payEmpty");
  let lbPollTimer = null, cdTimer = null, payPollTimer = null, nextPayoutAt = 0;

  const solscanAcct = (w) => "https://solscan.io/account/" + encodeURIComponent(w);
  const solscanTx = (s) => "https://solscan.io/tx/" + encodeURIComponent(s);

  function fmtCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function tickCountdown() {
    const t = fmtCountdown(nextPayoutAt - Date.now());
    railCountdown.textContent = t;
    if (payCountdown) payCountdown.textContent = t;
  }

  async function fetchLeaderboard() {
    try {
      const d = await (await fetch(apiUrl("/api/leaderboard"))).json();
      nextPayoutAt = d.nextPayoutAt || nextPayoutAt;
      railPotSol.textContent = d.pot && d.pot.configured ? d.pot.sol : "—";
      renderRail(d.entries || []);
    } catch { /* keep last */ }
  }
  function renderRail(entries) {
    railList.innerHTML = "";
    railEmpty.style.display = entries.length ? "none" : "block";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "rank-row" + (e.rank <= 3 ? " top" + e.rank : "");
      const rank = document.createElement("div");
      rank.className = "rank-n"; rank.textContent = e.rank;
      const who = document.createElement("div"); who.className = "rank-who";
      const name = document.createElement("div"); name.className = "rank-name"; name.textContent = e.username;
      who.appendChild(name);
      if (e.wallet) {
        const a = document.createElement("a");
        a.className = "rank-wallet mono"; a.href = solscanAcct(e.wallet);
        a.target = "_blank"; a.rel = "noopener"; a.title = "View on Solscan";
        a.textContent = shortWallet(e.wallet);
        who.appendChild(a);
      }
      const sh = document.createElement("div"); sh.className = "rank-share";
      const pct = document.createElement("div"); pct.className = "rank-pct"; pct.textContent = e.sharePct + "%";
      const sol = document.createElement("div"); sol.className = "rank-sol"; sol.textContent = e.shareSol + " SOL";
      sh.appendChild(pct); sh.appendChild(sol);
      row.appendChild(rank); row.appendChild(who); row.appendChild(sh);
      railList.appendChild(row);
    }
  }
  function startLeaderboardPolling() {
    fetchLeaderboard();
    clearInterval(lbPollTimer); lbPollTimer = setInterval(fetchLeaderboard, 10000);
    clearInterval(cdTimer); cdTimer = setInterval(tickCountdown, 1000);
  }

  async function fetchPayouts() {
    try {
      const d = await (await fetch(apiUrl("/api/payouts"))).json();
      nextPayoutAt = d.nextPayoutAt || nextPayoutAt;
      renderPayouts(d.history || []);
    } catch { /* keep last */ }
  }
  function renderPayouts(history) {
    payList.innerHTML = "";
    payEmpty.style.display = history.length ? "none" : "block";
    for (const p of history) {
      const batch = document.createElement("div"); batch.className = "pay-batch";
      const head = document.createElement("div"); head.className = "pay-batch-head";
      head.textContent = new Date(p.ts).toLocaleString() + " · " + p.totalSol + " SOL to " + p.count + " player" + (p.count === 1 ? "" : "s");
      batch.appendChild(head);
      for (const it of p.items || []) {
        const row = document.createElement("div"); row.className = "pay-row";
        const who = document.createElement("span"); who.className = "pay-who"; who.textContent = it.username || shortWallet(it.wallet);
        const amt = document.createElement("span"); amt.className = "pay-amt"; amt.textContent = it.sol + " SOL";
        const link = document.createElement("a");
        if (it.sig) { link.href = solscanTx(it.sig); link.target = "_blank"; link.rel = "noopener"; link.className = "pay-link"; link.textContent = "view tx"; }
        else { link.className = "pay-link muted"; link.textContent = "—"; }
        row.appendChild(who); row.appendChild(amt); row.appendChild(link);
        batch.appendChild(row);
      }
      payList.appendChild(batch);
    }
  }
  function openPayouts() { payouts.classList.add("open"); fetchPayouts(); clearInterval(payPollTimer); payPollTimer = setInterval(fetchPayouts, 10000); }
  function closePayouts() { payouts.classList.remove("open"); clearInterval(payPollTimer); }

  $("payoutsBtn").addEventListener("click", openPayouts);
  $("railPayouts").addEventListener("click", openPayouts);
  $("payClose").addEventListener("click", closePayouts);
  $("ranksBtn").addEventListener("click", () => rail.classList.toggle("open"));
  $("railClose").addEventListener("click", () => rail.classList.remove("open"));

  // Hash-gated preview hook (only active with #demo) — lets you drive the UI
  // without a live opponent, e.g. window.LARP_DEMO.verdict('A', {...}). Harmless
  // in production; does nothing unless the URL ends in #demo.
  if (location.hash === "#demo") {
    window.LARP_DEMO = { verdict: showVerdict, screen: setScreen, confetti: launchConfetti };
  }
})();
