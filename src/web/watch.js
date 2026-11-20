"use strict";
/* Public watch pages: /watch (channel grid) and /watch/<number> (player). No sign-in. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const pct = (p) => (p ? Math.min(100, Math.max(0, ((Date.now() - p.start) / (p.end - p.start)) * 100)) : 0);
const app = $("#app");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function get(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}

const tickClock = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
tickClock();
setInterval(tickClock, 10_000);

const badge = (c) => `<div class="w-badge">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : esc(c.number)}</div>`;

/* ================= channel grid ================= */

async function gridPage() {
  document.title = "Watch TV";
  let timer;
  const load = async () => {
    try {
      const list = await get("/watch-api/channels");
      app.innerHTML = `
        <div class="w-head"><h1>What's on</h1><p>Pick a channel to start watching.</p></div>
        ${list.length ? `<div class="w-grid">${list.map((c) => `
          <a class="w-card" href="/watch/${c.number}" style="--c:${esc(c.accent)}">
            <div class="w-card-top">${badge(c)}<div><h2>${esc(c.name)}</h2><div class="w-num">Channel ${c.number}${c.group ? ` · ${esc(c.group)}` : ""}</div></div></div>
            <div class="w-now">${c.now
              ? `<div class="w-label">Now</div><div class="w-title">${esc(c.now.title)}</div>${c.now.subtitle ? `<div class="w-sub">${esc(c.now.subtitle)}</div>` : ""}<div class="w-progress"><b style="width:${pct(c.now)}%"></b></div>`
              : `<div class="w-sub">Off air</div>`}</div>
            <div class="w-next">${c.next ? `<time>${hhmm(c.next.start)}</time>${esc(c.next.title)}` : "&nbsp;"}</div>
          </a>`).join("")}</div>` : `<div class="w-empty">No channels yet.</div>`}`;
    } catch (e) {
      app.innerHTML = `<div class="w-empty">${esc(e.message === "404" ? "Not available." : e.message)}</div>`;
    }
    timer = setTimeout(load, 30_000);
  };
  await load();
  return () => clearTimeout(timer);
}

/* ================= player ================= */

let player = null;
let current = null;      // channel number being played
let channels = [];
let tab = "guide";
let infoTimer, osdTimer, retryTimer;

function destroyPlayer() {
  clearTimeout(retryTimer);
  if (!player) return;
  try { player.pause(); player.unload(); player.detachMediaElement(); player.destroy(); } catch { /* already gone */ }
  player = null;
}

function setStatus(text, spinning = true) {
  $("#status").innerHTML = text ? `<div class="p-status">${spinning ? `<span class="p-spin"></span>` : ""}${esc(text)}</div>` : "";
}

function showOsd(c) {
  const osd = $("#osd");
  osd.innerHTML = `${c.number}<span>${esc(c.name)}</span>`;
  osd.classList.remove("hide");
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osd.classList.add("hide"), 3000);
}

function canPlay() {
  return window.mpegts && mpegts.isSupported() && mpegts.getFeatureList().mseLivePlayback;
}

function startStream(n) {
  destroyPlayer();
  const video = $("#video");
  // Absolute: mpegts.js fetches from a Web Worker, which can't resolve page-relative URLs.
  const url = new URL(`/stream/${n}.ts`, location.href).href;
  if (!canPlay()) {
    const abs = url;
    $("#stage").insertAdjacentHTML("beforeend", `<div class="p-fallback"><div>
      <p>This browser can't play live TV directly (common on iPhone and iPad). Open the channel in VLC instead:</p>
      <a class="btn" href="vlc://${esc(abs)}">Open in VLC</a><code>${esc(abs)}</code></div></div>`);
    return;
  }
  setStatus("Tuning in…");
  player = mpegts.createPlayer({ type: "mpegts", isLive: true, url }, {
    enableWorker: true,
    lazyLoad: false,
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 6,
    liveBufferLatencyMinRemain: 1.5,
    autoCleanupSourceBuffer: true,
  });
  player.attachMediaElement(video);
  player.load();
  video.muted = store.get("tvm-muted") !== "0";
  const attempt = player.play();
  if (attempt?.catch) attempt.catch(() => { video.muted = true; player?.play()?.catch?.(() => {}); updateMuteUi(); });
  updateMuteUi();
  player.on(mpegts.Events.ERROR, () => {
    setStatus("Reconnecting…");
    retryTimer = setTimeout(() => { if (current === n) startStream(n); }, 2500);
  });
}

function updateMuteUi() {
  const v = $("#video");
  $("#unmute").hidden = !v.muted;
  $("#mute").textContent = v.muted ? "Unmute (M)" : "Mute (M)";
}

function toggleMute(force) {
  const v = $("#video");
  v.muted = force ?? !v.muted;
  store.set("tvm-muted", v.muted ? "1" : "0");
  if (!v.muted) player?.play()?.catch?.(() => {});
  updateMuteUi();
}

async function renderInfo() {
  let c;
  try { c = await get(`/watch-api/channels/${current}`); } catch (e) { $("#info").innerHTML = `<div class="w-sub">${esc(e.message)}</div>`; return; }
  document.title = `${c.name} · Watch TV`;
  document.documentElement.style.setProperty("--c", c.accent);
  $("#info").innerHTML = `
    <div>
      <div class="p-chan">${badge(c)}<div><b>${esc(c.name)}</b><div class="w-num w-sub">Channel ${c.number}</div></div></div>
      ${c.now ? `<div class="w-label">Now · until ${hhmm(c.now.end)}</div><h1>${esc(c.now.title)}</h1>${c.now.subtitle ? `<div class="w-sub">${esc(c.now.subtitle)}</div>` : ""}
        <div class="w-progress" style="max-width:480px"><b style="width:${pct(c.now)}%"></b></div>` : `<h1>Off air</h1>`}
      ${c.next ? `<div class="p-next-line">Next <time>${hhmm(c.next.start)}</time> · ${esc(c.next.title)}</div>` : ""}
    </div>
    <div class="p-zap"><button data-zap="-1" title="Previous channel (↓)">▼ Ch</button><button data-zap="1" title="Next channel (↑)">Ch ▲</button></div>`;
  if (tab === "guide") {
    $("#list").innerHTML = c.guide.map((p, i) => `
      <div class="p-row ${i === 0 && p.start <= Date.now() ? "on" : ""}"><time>${hhmm(p.start)}</time>
        <div><b>${esc(p.title)}</b>${p.subtitle ? `<span class="w-sub">${esc(p.subtitle)}</span>` : ""}</div></div>`).join("") || `<div class="p-row"><span></span><span class="w-sub">Nothing scheduled.</span></div>`;
  }
}

async function renderChannels() {
  try { channels = await get("/watch-api/channels"); } catch { return; }
  if (tab !== "channels") return;
  $("#list").innerHTML = channels.map((c) => `
    <a class="p-row ${String(c.number) === String(current) ? "on" : ""}" href="/watch/${c.number}" data-ch="${c.number}">
      <span class="p-n">${c.number}</span><div><b>${esc(c.name)}</b><span class="w-sub">${c.now ? esc(c.now.title) : "Off air"}</span></div></a>`).join("");
}

function tune(n, push = true) {
  n = String(n);
  if (push && n !== current) history.pushState(null, "", `/watch/${n}`);
  current = n;
  const c = channels.find((x) => String(x.number) === n);
  if (c) showOsd(c);
  startStream(n);
  renderInfo();
  if (tab === "channels") renderChannels();
}

function zap(dir) {
  if (!channels.length) return;
  const i = channels.findIndex((c) => String(c.number) === current);
  const next = channels[(i + dir + channels.length) % channels.length];
  tune(next.number);
}

async function playerPage(n) {
  current = String(n);
  app.innerHTML = `
    <div class="p-layout">
      <div>
        <div class="p-stage" id="stage">
          <video id="video" playsinline autoplay></video>
          <div class="p-overlay" id="status"></div>
          <div class="p-osd hide" id="osd"></div>
          <button class="p-unmute" id="unmute" hidden>🔊 Tap to unmute</button>
          <div class="p-controls"><button id="mute">Mute (M)</button><button id="fs">Fullscreen (F)</button></div>
        </div>
        <div class="p-info" id="info"></div>
        <div class="w-hint"><kbd>↑</kbd> <kbd>↓</kbd> change channel · <kbd>M</kbd> mute · <kbd>F</kbd> fullscreen · <a href="/watch" style="text-decoration:underline">All channels</a></div>
      </div>
      <aside class="p-side">
        <div class="p-tabs"><button data-tab="guide" class="on">Coming up</button><button data-tab="channels">Channels</button></div>
        <div class="p-list" id="list"></div>
      </aside>
    </div>`;

  const video = $("#video");
  video.addEventListener("playing", () => setStatus(""));
  video.addEventListener("waiting", () => setStatus("Buffering…"));
  video.addEventListener("volumechange", updateMuteUi);
  $("#unmute").onclick = () => toggleMute(false);
  $("#mute").onclick = () => toggleMute();
  $("#fs").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $("#stage").requestFullscreen?.());

  const onClick = (e) => {
    const z = e.target.closest("[data-zap]");
    if (z) return zap(Number(z.dataset.zap));
    const t = e.target.closest("[data-tab]");
    if (t) {
      tab = t.dataset.tab;
      document.querySelectorAll(".p-tabs button").forEach((b) => b.classList.toggle("on", b === t));
      return tab === "guide" ? renderInfo() : renderChannels();
    }
    const ch = e.target.closest("[data-ch]");
    if (ch) { e.preventDefault(); tune(ch.dataset.ch); }
  };
  const onKey = (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); zap(1); }
    else if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); zap(-1); }
    else if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "f" || e.key === "F") $("#fs").click();
  };
  const onPop = () => { const m = location.pathname.match(/^\/watch\/(\d+)/); if (m) tune(m[1], false); };
  app.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  window.addEventListener("popstate", onPop);

  await renderChannels();
  const c = channels.find((x) => String(x.number) === current);
  if (c) showOsd(c);
  startStream(current);
  renderInfo();
  infoTimer = setInterval(() => { renderInfo(); if (tab === "channels") renderChannels(); }, 20_000);
}

const m = location.pathname.match(/^\/watch\/(\d+)/);
if (m) playerPage(m[1]);
else gridPage();
