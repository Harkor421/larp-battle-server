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

  // ---------- State ----------
  let ws = null, pc = null, localStream = null, battle = null;
  let captureTimer = null, countdownTimer = null, pendingCandidates = [];
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

  // ---------- Age gate ----------
  agreeCheck.addEventListener("change", () => { enterBtn.disabled = !agreeCheck.checked; });
  enterBtn.addEventListener("click", async () => {
    localStorage.setItem("larp_tos_accepted", new Date().toISOString());
    gate.classList.add("hidden");
    app.classList.remove("hidden");
    setScreen("lobby");
    await initMedia();
    connectWs();
  });

  // ---------- Media ----------
  async function initMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
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
    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener("close", () => {
      setStatus("Reconnecting…");
      teardownBattle();
      setTimeout(connectWs, 2000);
    });
  }
  function wsSend(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

  async function handleMessage(msg) {
    switch (msg.type) {
      case "hello": localCountry.textContent = regionName(msg.country); break;
      case "banned":
        setStatus("Access blocked: " + (msg.reason || "banned"));
        setScreen("lobby"); findBtn.disabled = true; break;
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
  againBtn.addEventListener("click", () => { hideVerdict(); setScreen("searching"); wsSend({ type: "join_queue" }); });
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
    remoteCountry.textContent = regionName(msg.peerCountry);
    remoteLabel.textContent = "Opponent";
    setScreen("connecting");
    setStatus("Opponent found in " + regionName(msg.peerCountry) + ". Connecting…");

    pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.ontrack = (ev) => { if (remoteVideo.srcObject !== ev.streams[0]) remoteVideo.srcObject = ev.streams[0]; };
    pc.onicecandidate = (ev) => { if (ev.candidate) wsSend({ type: "signal", data: { candidate: ev.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") { setStatus("Connected. Get ready…"); wsSend({ type: "ready" }); }
      else if (["failed", "disconnected"].includes(pc.connectionState)) setStatus("Connection lost.");
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
      const scale = Math.min(1, 768 / Math.max(vw, vh));
      captureCanvas.width = Math.round(vw * scale);
      captureCanvas.height = Math.round(vh * scale);
      captureCanvas.getContext("2d").drawImage(localVideo, 0, 0, captureCanvas.width, captureCanvas.height);
      const blob = await new Promise((r) => captureCanvas.toBlob(r, "image/jpeg", 0.75));
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
    // Decisive first, then by value.
    list.sort((a, b) => {
      const da = a.decisive ? 1 : 0, db = b.decisive ? 1 : 0;
      if (da !== db) return db - da;
      return (b.est_value_usd_high || 0) - (a.est_value_usd_high || 0);
    });
    list.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = "item" + (item.decisive ? " decisive" : "");
      li.style.animationDelay = (0.12 + i * 0.06) + "s";

      const main = document.createElement("div");
      main.className = "item-main";
      const name = document.createElement("div");
      name.className = "item-name";
      name.textContent = item.name || "Item";
      if (item.decisive) {
        const tag = document.createElement("span");
        tag.className = "tag"; tag.textContent = "DECISIVE";
        name.appendChild(tag);
      }
      const sub = document.createElement("div");
      sub.className = "item-sub";
      sub.textContent = item.brand_or_model || "unidentified";
      if (item.authenticity === "likely_replica") {
        const r = document.createElement("span");
        r.className = "repl"; r.textContent = " · likely replica";
        sub.appendChild(r);
      } else if (item.authenticity === "uncertain") {
        sub.append(" · authenticity uncertain");
      }
      main.appendChild(name); main.appendChild(sub);

      const val = document.createElement("div");
      val.className = "item-val";
      val.textContent = `${money(item.est_value_usd_low)}–${money(item.est_value_usd_high)}`;

      li.appendChild(main); li.appendChild(val);
      ul.appendChild(li);
    });
  }

  function showVerdict(myRole, verdict) {
    stopCapture(); teardownBattle();
    verdict = verdict || {};
    const players = Array.isArray(verdict.players) ? verdict.players : [];
    const me = players.find((p) => p && p.player === myRole) || {};
    const them = players.find((p) => p && p.player !== myRole) || {};
    const iWon = verdict.winner === myRole;
    const tie = verdict.winner === "tie" || !verdict.winner;

    const result = $("verdictResult");
    result.textContent = tie ? "Draw" : iWon ? "You win" : "You lose";
    result.className = "verdict-result " + (tie ? "tie" : iWon ? "win" : "lose");
    $("verdictReason").textContent = verdict.commentary || "";

    const sYou = clampScore(me.score), sThem = clampScore(them.score);
    const sideYou = $("sideYou"), sideThem = $("sideThem");
    sideYou.classList.toggle("win", iWon && !tie);
    sideYou.classList.toggle("lose", !iWon && !tie);
    sideThem.classList.toggle("win", !iWon && !tie);
    sideThem.classList.toggle("lose", iWon && !tie);

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

  // Hash-gated preview hook (only active with #demo) — lets you drive the UI
  // without a live opponent, e.g. window.LARP_DEMO.verdict('A', {...}). Harmless
  // in production; does nothing unless the URL ends in #demo.
  if (location.hash === "#demo") {
    window.LARP_DEMO = { verdict: showVerdict, screen: setScreen, confetti: launchConfetti };
  }
})();
