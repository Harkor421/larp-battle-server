/* Larp Battle client: WebSocket signaling + WebRTC P2P + 1s frame capture. */
(() => {
  "use strict";

  // ---------- Backend origin (empty = same origin) ----------
  const BACKEND =
    (window.LARP_CONFIG && window.LARP_CONFIG.backendOrigin) || "";
  function wsUrl() {
    if (BACKEND) return BACKEND.replace(/^http/i, "ws") + "/ws";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }
  function apiUrl(path) {
    return BACKEND ? BACKEND + path : path;
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const gate = $("gate");
  const agreeCheck = $("agreeCheck");
  const enterBtn = $("enterBtn");
  const appEl = $("app");
  const statusEl = $("status");
  const timerEl = $("timer");
  const localVideo = $("localVideo");
  const remoteVideo = $("remoteVideo");
  const localFlag = $("localFlag");
  const remoteFlag = $("remoteFlag");
  const remoteLabel = $("remoteLabel");
  const captureDot = $("captureDot");
  const findBtn = $("findBtn");
  const nextBtn = $("nextBtn");
  const reportBtn = $("reportBtn");
  const verdictEl = $("verdict");
  const verdictTitle = $("verdictTitle");
  const verdictCommentary = $("verdictCommentary");
  const scoreTitleYou = $("scoreTitleYou");
  const scoreTitleThem = $("scoreTitleThem");
  const itemsYou = $("itemsYou");
  const itemsThem = $("itemsThem");

  // ---------- State ----------
  let ws = null;
  let pc = null;
  let localStream = null;
  let battle = null; // { id, role, token, isCaller, iceServers, frameIntervalMs }
  let captureTimer = null;
  let countdownTimer = null;
  let pendingCandidates = [];
  const captureCanvas = document.createElement("canvas");

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function flagEmoji(cc) {
    if (!cc || cc.length !== 2 || /[^A-Za-z]/.test(cc)) return "🏳️";
    const A = 0x1f1e6;
    const up = cc.toUpperCase();
    return (
      String.fromCodePoint(A + up.charCodeAt(0) - 65) +
      String.fromCodePoint(A + up.charCodeAt(1) - 65)
    );
  }

  // ---------- Age gate ----------
  agreeCheck.addEventListener("change", () => {
    enterBtn.disabled = !agreeCheck.checked;
  });
  enterBtn.addEventListener("click", async () => {
    localStorage.setItem("larp_tos_accepted", new Date().toISOString());
    gate.classList.add("hidden");
    appEl.classList.remove("hidden");
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
      setStatus("Camera ready. Find a battle!");
    } catch (err) {
      setStatus("Camera/mic access is required to battle. Reload and allow access.");
      findBtn.disabled = true;
    }
  }

  // ---------- WebSocket ----------
  function connectWs() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });
    ws.addEventListener("close", () => {
      setStatus("Disconnected from server. Reconnecting…");
      teardownBattle();
      setTimeout(connectWs, 2000);
    });
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  async function handleMessage(msg) {
    switch (msg.type) {
      case "hello":
        localFlag.textContent = flagEmoji(msg.country);
        break;
      case "banned":
        setStatus(`You are banned: ${msg.reason}`);
        findBtn.disabled = true;
        break;
      case "queued":
        setStatus("Searching for an opponent…");
        break;
      case "matched":
        await onMatched(msg);
        break;
      case "signal":
        await onSignal(msg.data);
        break;
      case "battle_start":
        onBattleStart(msg);
        break;
      case "judging":
        stopCapture();
        setStatus("⏳ The AI judge is pricing your items…");
        break;
      case "verdict":
        showVerdict(msg.role, msg.verdict);
        break;
      case "battle_aborted":
        setStatus(msg.reason || "Battle ended.");
        teardownBattle();
        showIdleButtons();
        break;
      case "peer_left":
        setStatus("Your opponent left.");
        break;
      case "report_received":
        setStatus("Report received. Thank you.");
        break;
    }
  }

  // ---------- Matchmaking / WebRTC ----------
  findBtn.addEventListener("click", () => {
    hideVerdict();
    findBtn.classList.add("hidden");
    wsSend({ type: "join_queue" });
    setStatus("Searching for an opponent…");
  });

  nextBtn.addEventListener("click", () => {
    wsSend({ type: "leave" });
    teardownBattle();
    hideVerdict();
    wsSend({ type: "join_queue" });
    setStatus("Searching for an opponent…");
    nextBtn.classList.add("hidden");
    reportBtn.classList.add("hidden");
  });

  reportBtn.addEventListener("click", () => {
    const reason = prompt(
      "What happened? (nudity, harassment, scam, underage, other)"
    );
    if (reason !== null) {
      wsSend({ type: "report", reason: reason || "unspecified" });
    }
  });

  async function onMatched(msg) {
    battle = {
      id: msg.battleId,
      role: msg.role,
      token: msg.token,
      isCaller: msg.isCaller,
      frameIntervalMs: msg.frameIntervalMs || 1000,
      durationMs: msg.durationMs,
    };
    pendingCandidates = [];
    remoteFlag.textContent = flagEmoji(msg.peerCountry);
    remoteLabel.textContent = `Stranger (${msg.peerCountry})`;
    setStatus(`Matched with someone in ${msg.peerCountry}. Connecting…`);
    reportBtn.classList.remove("hidden");
    nextBtn.classList.remove("hidden");

    pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
    pc.ontrack = (ev) => {
      if (remoteVideo.srcObject !== ev.streams[0]) {
        remoteVideo.srcObject = ev.streams[0];
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) wsSend({ type: "signal", data: { candidate: ev.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setStatus("Connected! Waiting for the battle to start…");
        wsSend({ type: "ready" });
      } else if (["failed", "disconnected"].includes(pc.connectionState)) {
        setStatus("Connection lost.");
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
        for (const c of pendingCandidates) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        pendingCandidates = [];
        if (data.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ type: "signal", data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(data.candidate).catch(() => {});
        } else {
          pendingCandidates.push(data.candidate);
        }
      }
    } catch (err) {
      console.error("signal error", err);
    }
  }

  // ---------- Battle ----------
  function onBattleStart(msg) {
    setStatus("🔥 BATTLE LIVE — show your most expensive stuff!");
    timerEl.classList.remove("hidden");
    captureDot.classList.remove("hidden");
    startCountdown(msg.endsAt);
    startCapture();
  }

  function startCountdown(endsAt) {
    clearInterval(countdownTimer);
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
      if (left <= 0) clearInterval(countdownTimer);
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  // Capture a frame of the LOCAL camera every frameIntervalMs and upload it.
  function startCapture() {
    stopCapture();
    captureTimer = setInterval(async () => {
      if (!battle || !localStream) return;
      const track = localStream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") return;
      const vw = localVideo.videoWidth;
      const vh = localVideo.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.min(1, 768 / Math.max(vw, vh));
      captureCanvas.width = Math.round(vw * scale);
      captureCanvas.height = Math.round(vh * scale);
      const ctx = captureCanvas.getContext("2d");
      ctx.drawImage(localVideo, 0, 0, captureCanvas.width, captureCanvas.height);
      const blob = await new Promise((resolve) =>
        captureCanvas.toBlob(resolve, "image/jpeg", 0.75)
      );
      if (!blob || !battle) return;
      fetch(apiUrl(`/api/battle/${battle.id}/frame`), {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "X-Battle-Token": battle.token,
        },
        body: blob,
      }).catch(() => {});
    }, battle.frameIntervalMs);
  }

  function stopCapture() {
    clearInterval(captureTimer);
    captureTimer = null;
    captureDot.classList.add("hidden");
  }

  function teardownBattle() {
    stopCapture();
    clearInterval(countdownTimer);
    timerEl.classList.add("hidden");
    if (pc) {
      pc.close();
      pc = null;
    }
    remoteVideo.srcObject = null;
    battle = null;
  }

  function showIdleButtons() {
    findBtn.classList.remove("hidden");
    nextBtn.classList.add("hidden");
    reportBtn.classList.add("hidden");
  }

  // ---------- Verdict ----------
  function money(n) {
    if (typeof n !== "number" || !isFinite(n)) return "$0";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function renderItems(tbody, items) {
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = "Nothing of value shown 💀";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const item of items) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = item.name;
      name.appendChild(strong);
      const meta = document.createElement("div");
      meta.className = "item-meta";
      const auth =
        item.authenticity === "likely_replica"
          ? " · ⚠️ likely replica"
          : item.authenticity === "uncertain"
          ? " · authenticity uncertain"
          : "";
      meta.textContent = `${item.brand_or_model}${auth}`;
      name.appendChild(meta);
      const val = document.createElement("td");
      val.className = "val";
      val.textContent = `${money(item.est_value_usd_low)}–${money(item.est_value_usd_high)}`;
      tr.appendChild(name);
      tr.appendChild(val);
      tbody.appendChild(tr);
    }
  }

  function showVerdict(myRole, verdict) {
    stopCapture();
    teardownBattle();
    const me = verdict.players.find((p) => p.player === myRole);
    const them = verdict.players.find((p) => p.player !== myRole);
    const iWon = verdict.winner === myRole;
    const tie = verdict.winner === "tie";

    verdictTitle.textContent = tie
      ? "🤝 It's a tie"
      : iWon
      ? "🏆 YOU WIN — certified flexer"
      : "💀 You lost — bigger larper wins";
    verdictTitle.className = tie ? "" : iWon ? "won" : "lost";
    verdictCommentary.textContent = verdict.commentary || "";
    scoreTitleYou.textContent = `You — ${money(me?.total_value_usd)}`;
    scoreTitleThem.textContent = `Them — ${money(them?.total_value_usd)}`;
    renderItems(itemsYou, me?.items);
    renderItems(itemsThem, them?.items);
    verdictEl.classList.remove("hidden");
    setStatus("Battle over.");
    showIdleButtons();
    findBtn.textContent = "🎲 Battle again";
  }

  function hideVerdict() {
    verdictEl.classList.add("hidden");
  }
})();
