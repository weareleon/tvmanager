"use strict";
/* tvmanager dashboard: channels, collections, media sources. Plain JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const view = $("#view");
const dlg = $("#dlg");

const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
const ALL_DAYS = DAYS.map((d) => d[0]);
const COLORS = ["#6aa5ff", "#a97cff", "#3fcf8e", "#f2b33d", "#ff7eb6", "#4fd1d9", "#ff8f5a", "#b5e35b"];
const TYPE_LABEL = { jellyfin: "Jellyfin", emby: "Emby", local: "Local" };
const KIND_LABEL = { movie: "Movies", episode: "Episodes", other: "Other videos" };

async function api(method, url, body, raw) {
  // The custom header proves the request comes from this dashboard (CSRF protection).
  const opts = { method, headers: { "X-Requested-With": "tvmanager" }, credentials: "same-origin" };
  if (raw) { opts.body = raw; opts.headers["Content-Type"] = raw.type; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth) {
    // Session expired or signed out elsewhere: back to the sign-in screen.
    showAuth();
    throw new Error("Please sign in.");
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ================= routing ================= */

let cleanup = null;        // current page's teardown
let dirtyCheck = null;     // returns true if the page has unsaved changes
let lastHash = location.hash;

const pages = {
  channels: pageChannels,
  channel: pageChannelEditor,
  collections: pageCollections,
  breaks: pageBreaks,
  sources: pageSources,
  settings: pageSettings,
};

function route() {
  if (dirtyCheck && dirtyCheck() && !confirm("You have unsaved changes. Leave without saving?")) {
    history.replaceState(null, "", lastHash);
    return;
  }
  lastHash = location.hash;
  cleanup?.();
  cleanup = null;
  dirtyCheck = null;
  const [page, arg] = (location.hash.slice(1) || "channels").split("/");
  const fn = pages[page] ?? pageChannels;
  const navPage = page === "channel" ? "channels" : (pages[page] ? page : "channels");
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === navPage));
  window.scrollTo(0, 0);
  fn(arg ? decodeURIComponent(arg) : undefined);
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if (dirtyCheck?.()) e.preventDefault(); });

/* ================= shared data ================= */

async function loadCollections() { return api("GET", "/api/collections"); }
async function loadSources() { return api("GET", "/api/sources"); }

/* ================= channels list ================= */

async function pageChannels() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Channels</h1><p class="sub">Channels keep their schedule even when nobody is watching. Click one to edit it.</p></div>
      <a class="btn primary" href="#channel/new" style="background:var(--accent);color:var(--accent-ink);border-color:transparent">New channel</a>
    </div>
    <div class="urls">
      <div class="card url"><div><small>Playlist (M3U)</small><code id="m3u-url">${esc(location.origin)}/iptv/channels.m3u</code></div><button class="ghost" data-copy="m3u-url">Copy</button></div>
      <div class="card url"><div><small>Guide (XMLTV)</small><code id="xmltv-url">${esc(location.origin)}/iptv/xmltv.xml</code></div><button class="ghost" data-copy="xmltv-url">Copy</button></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>#</th><th>Channel</th><th>Now</th><th class="hide-sm">Next</th><th>Watching</th></tr></thead>
        <tbody id="rows"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>`;
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#" + b.dataset.copy).textContent);
    toast("Copied");
  }));
  $("#rows").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = `#channel/${encodeURIComponent(tr.dataset.id)}`;
  });

  let timer;
  const load = async () => {
    try {
      const list = await api("GET", "/api/channels");
      const now = Date.now();
      $("#rows").innerHTML = list.length ? list.map((c) => {
        const cur = c.current;
        const pct = cur ? Math.min(100, Math.max(0, ((now - cur.start) / (cur.end - cur.start)) * 100)) : 0;
        const label = !cur ? "" : cur.kind === "filler" ? "Filler" : cur.kind === "break" ? `Break${cur.slot ? ` · ${cur.slot}` : ""}` : cur.kind === "card" ? "Up next card" : cur.kind === "slate" ? "Off air" : cur.title;
        const curHtml = cur
          ? `<div>${esc(label)}</div>${cur.subtitle ? `<div class="muted small">${esc(cur.subtitle)}</div>` : ""}
             <div class="muted small">until ${hhmm(cur.end)}</div><div class="progress"><b style="width:${pct}%"></b></div>`
          : `<span class="muted">Nothing scheduled</span>`;
        const next = c.next ? `<div>${esc(c.next.title)}</div><div class="muted small">${hhmm(c.next.start)}</div>` : `<span class="muted">—</span>`;
        const tags = [c.group, c.blocks ? `${c.blocks} block${c.blocks > 1 ? "s" : ""}` : null, c.hasWatermark ? "watermark" : null].filter(Boolean);
        return `<tr class="clickable" data-id="${esc(c.id)}">
          <td class="num">${c.number}</td>
          <td><div class="chname">${c.logo ? `<img class="chlogo" src="${esc(c.logo)}" alt="">` : ""}${esc(c.name)}</div>
              <div class="chips" style="margin-top:6px">${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div></td>
          <td>${curHtml}</td><td class="hide-sm">${next}</td>
          <td>${c.viewers ? `<span class="live-dot">${c.viewers}</span>` : `<span class="muted">—</span>`}</td></tr>`;
      }).join("") : `<tr><td colspan="5"><div class="empty"><h3>No channels yet</h3><p>Create your first channel to start broadcasting.</p><a class="btn primary" href="#channel/new">New channel</a></div></td></tr>`;
    } catch (e) {
      $("#rows").innerHTML = `<tr><td colspan="5" class="empty">Could not load channels: ${esc(e.message)}</td></tr>`;
    }
    timer = setTimeout(load, 10000);
  };
  load();
  cleanup = () => clearTimeout(timer);
}

/* ================= channel editor ================= */

function emptyContent() { return { type: "collection", collection: "", order: "sequential" }; }

const GRAPHIC_DEFAULTS = {
  upnext: { type: "upnext", enabled: true, secondsBeforeEnd: 120, duration: 12 },
  nowplaying: { type: "nowplaying", enabled: true, delay: 5, duration: 8 },
  countdown: { type: "countdown", enabled: true, target: "next-event", at: "", title: "", showHoursBefore: 24, position: "top-right", showDuring: "programmes" },
  ticker: { type: "ticker", enabled: true, text: "", label: "", speed: 120, showDuring: "programmes" },
  clock: { type: "clock", enabled: true, format: "24h", position: "top-left", showDuring: "programmes" },
};
const GRAPHIC_INFO = {
  upnext: ["Up next banner", "Slides in near the end of each programme with what's on next and when."],
  nowplaying: ["Now playing banner", "Shows the programme's title shortly after it starts."],
  countdown: ["Countdown", "Ticks down to a special event, then shows ON NOW while it's running."],
  ticker: ["Ticker", "Scrolling text along the bottom of the screen."],
  clock: ["Clock", "The current time in a corner."],
};

/** Config JSON -> editor state. */
function toEditor(raw) {
  const content = (c) => (c ? { order: "sequential", ...c } : { type: "none" });
  return {
    id: raw.id,
    number: raw.number,
    name: raw.name ?? "",
    group: raw.group ?? "",
    logo: raw.logo ?? "",
    filler: raw.filler ?? "",
    default: content(raw.default),
    watermark: raw.watermark ? { position: "bottom-right", opacity: 0.85, scale: 0.12, margin: 24, animation: "none", showDuring: "always", ...raw.watermark } : null,
    accent: raw.accent ?? "#6aa5ff",
    graphics: (raw.graphics ?? []).map((g) => ({ ...GRAPHIC_DEFAULTS[g.type], ...g })),
    breaks: raw.breaks
      ? { style: raw.breaks.style, between: raw.breaks.between !== false, midroll: { enabled: false, everyMinutes: 12, minLengthMinutes: 20, useChapters: true, ...(raw.breaks.midroll ?? {}) } }
      : null,
    schedule: (raw.schedule ?? []).map((r) => ({
      name: r.name ?? "",
      kind: r.date ? "event" : "weekly",
      days: r.days ? [...r.days] : [...ALL_DAYS],
      date: r.date ?? "",
      start: r.start, end: r.end,
      priority: r.priority ?? "",
      content: content(r.content),
    })),
  };
}

/** Editor state -> request body. */
function fromEditor(s) {
  const content = (c) => (c.type === "none" ? undefined : c);
  return {
    number: Number(s.number),
    name: s.name, group: s.group, logo: s.logo, filler: s.filler,
    default: content(s.default),
    watermark: s.watermark,
    breaks: s.breaks,
    accent: s.accent,
    graphics: s.graphics,
    schedule: s.schedule.map((r) => ({
      name: r.name, start: r.start, end: r.end, priority: r.priority,
      days: r.kind === "weekly" ? r.days : undefined,
      date: r.kind === "event" ? r.date : undefined,
      content: r.content,
    })),
  };
}

function contentPicker(key, c, collections, allowNone) {
  const types = [...(allowNone ? [["none", "Nothing"]] : []), ["collection", "Collection"], ["restream", "Live restream"]];
  let fields = "";
  if (c.type === "collection") {
    fields = `
      <label class="field">Collection
        <select data-cp="${key}" data-cf="collection">
          <option value="">Choose…</option>
          ${collections.map((col) => `<option value="${esc(col.id)}" ${col.id === c.collection ? "selected" : ""}>${esc(col.id)} (${col.items})</option>`).join("")}
        </select></label>
      <label class="field">Order
        <select data-cp="${key}" data-cf="order">
          <option value="sequential" ${c.order !== "shuffle" ? "selected" : ""}>In order</option>
          <option value="shuffle" ${c.order === "shuffle" ? "selected" : ""}>Shuffle</option>
        </select></label>`;
  } else if (c.type === "restream") {
    fields = `
      <label class="field" style="flex-basis:100%">Stream or M3U playlist URL
        <input type="text" data-cp="${key}" data-cf="source" value="${esc(c.source ?? "")}" placeholder="http://provider/playlist.m3u or http://…/stream.m3u8"></label>
      <label class="field">Channel in playlist <input type="text" data-cp="${key}" data-cf="channel" value="${esc(c.channel ?? "")}" placeholder="Leave blank for a direct stream"></label>
      <label class="field">Guide title <input type="text" data-cp="${key}" data-cf="title" value="${esc(c.title ?? "")}" placeholder="Shown in the TV guide"></label>`;
  } else {
    fields = `<div class="muted small" style="align-self:center">Shows an off-air screen with what's coming up next.</div>`;
  }
  return `<div class="content-picker" data-picker="${key}">
    <div class="seg">${types.map(([t, l]) => `<button type="button" data-cp="${key}" data-ctype="${t}" class="${c.type === t ? "on" : ""}">${l}</button>`).join("")}</div>
    ${fields}</div>`;
}

async function pageChannelEditor(id) {
  const creating = id === "new";
  view.innerHTML = `<div class="empty">Loading…</div>`;
  let collections, channels, raw, styles;
  try {
    [collections, channels, raw, styles] = await Promise.all([
      loadCollections(),
      api("GET", "/api/channels"),
      creating ? null : api("GET", `/api/channels/${encodeURIComponent(id)}/config`),
      api("GET", "/api/breaks"),
    ]);
  } catch (e) {
    view.innerHTML = `<div class="card empty"><h3>Couldn't open this channel</h3><p>${esc(e.message)}</p><a href="#channels">Back to channels</a></div>`;
    return;
  }

  const nextNumber = Math.max(0, ...channels.map((c) => c.number)) + 1;
  const s = creating
    ? toEditor({ id: "", number: nextNumber, name: "", schedule: [], default: undefined })
    : toEditor(raw);
  if (creating) s.default = collections.length ? { ...emptyContent(), collection: collections[0].id } : { type: "none" };
  let saved = JSON.stringify(s);
  let idTouched = false;
  let wmPreview = s.watermark ? `/api/channels/${encodeURIComponent(id)}/watermark?t=${Date.now()}` : "";
  const dirty = () => JSON.stringify(s) !== saved;
  dirtyCheck = dirty;

  view.innerHTML = `
    <div class="editor-head">
      <a class="btn ghost" href="#channels">← Channels</a>
      <h1 id="title"></h1>
      ${creating ? "" : `<a class="btn" href="/stream/${s.number}.ts" target="_blank" rel="noopener">Open stream</a>`}
    </div>
    <div class="editor-grid">
      <div>
        <section class="card sec">
          <div class="sec-head"><div><h2>Basics</h2><p>How the channel appears in the guide and your TV app.</p></div></div>
          <div class="grid3">
            <label class="field" style="grid-column:span 2">Name <input type="text" data-k="name" value="${esc(s.name)}" placeholder="Retro TV"></label>
            <label class="field">Number <input type="number" min="1" data-k="number" value="${esc(s.number)}"></label>
          </div>
          <div class="grid3">
            <label class="field">ID <input type="text" data-k="id" value="${esc(s.id)}" ${creating ? "" : "disabled"} placeholder="retro-tv">
              <span class="hint">${creating ? "Used in URLs. Can't be changed later." : "Can't be changed."}</span></label>
            <label class="field">Group <input type="text" data-k="group" value="${esc(s.group)}" placeholder="Entertainment"><span class="hint">Category in TV apps.</span></label>
            <label class="field">Logo URL <input type="url" data-k="logo" value="${esc(s.logo)}" placeholder="https://…/logo.png"><span class="hint">Shown in the guide.</span></label>
          </div>
        </section>

        <section class="card sec">
          <div class="sec-head"><div><h2>Programming</h2><p>What plays when no schedule block is active, and what fills the gaps before a block starts.</p></div></div>
          <div class="field" style="font-weight:500">Default programming <div id="default-picker" style="margin-top:6px"></div></div>
          <label class="field">Fill gaps with
            <select data-k="filler">
              <option value="">Nothing (show an "Up next" screen)</option>
              ${collections.map((c) => `<option value="${esc(c.id)}" ${c.id === s.filler ? "selected" : ""}>${esc(c.id)} (${c.items})</option>`).join("")}
            </select>
            <span class="hint">Short clips like bumpers or promos, used so blocks start exactly on time.</span></label>
        </section>

        <section class="card sec">
          <div class="sec-head"><div><h2>Ad breaks</h2><p>Commercial breaks between and inside programmes. Build break styles on the <a href="#breaks">Breaks</a> page.</p></div></div>
          <div id="breaks-ed"></div>
        </section>

        <section class="card sec">
          <div class="sec-head"><div><h2>Weekly schedule</h2><p>Blocks that repeat on chosen days. Click a block in the grid to jump to it.</p></div>
            <button type="button" data-act="add-weekly">+ Add block</button></div>
          <div id="week"></div>
          <div id="weekly" class="stack"></div>
        </section>

        <section class="card sec">
          <div class="sec-head"><div><h2>Special events</h2><p>One-off blocks on a specific date. They take priority over the weekly schedule.</p></div>
            <button type="button" data-act="add-event">+ Add event</button></div>
          <div id="events" class="stack"></div>
        </section>

        <section class="card sec">
          <div class="sec-head"><div><h2>Watermark</h2><p>A logo shown over everything on this channel.</p></div></div>
          <label class="switch"><input type="checkbox" id="wm-on" ${s.watermark ? "checked" : ""}> Show a watermark</label>
          <div id="wm"></div>
        </section>

        <section class="card sec">
          <div class="sec-head"><div><h2>On-screen graphics</h2><p>Animated banners, countdowns, ticker and clock, drawn live over the picture.</p></div>
            <label class="field" style="flex:0 0 auto;flex-direction:row;align-items:center;gap:8px">Accent <input type="color" data-k="accent" value="${esc(s.accent)}" style="width:44px;height:32px;padding:2px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg)"></label></div>
          <div class="tv tv-gfx" id="gfx-tv"></div>
          <div id="gfx-list" class="stack"></div>
          <div class="add-gfx" id="gfx-add"></div>
        </section>

        ${creating ? "" : `<section class="card sec"><div class="danger-zone">
          <div><h2>Delete channel</h2><p class="muted small" style="margin:4px 0 0">Removes it from the playlist and guide. Your media isn't touched.</p></div>
          <button type="button" class="danger" data-act="delete">Delete</button></div></section>`}
      </div>
      <aside class="side"><div class="card sec">
        <h2>Coming up</h2>
        <div class="upnext" id="upnext"><div class="muted">${creating ? "Save the channel to see its schedule." : "Loading…"}</div></div>
      </div></aside>
    </div>
    <div class="savebar" id="savebar">
      <div class="msg" id="save-msg">Unsaved changes</div>
      <button type="button" data-act="revert">Discard</button>
      <button type="button" class="primary" data-act="save">${creating ? "Create channel" : "Save changes"}</button>
    </div>`;

  const updateTitle = () => { $("#title").textContent = s.name || (creating ? "New channel" : s.id); };
  const updateBar = () => {
    const bar = $("#savebar");
    bar.classList.toggle("show", dirty() || creating);
    if (!$("#save-msg").classList.contains("err")) $("#save-msg").textContent = creating ? "New channel — not saved yet" : "Unsaved changes";
  };
  const touch = () => { updateBar(); };

  /* ---- content pickers ---- */
  const target = (key) => (key === "default" ? s.default : s.schedule[Number(key.split(":")[1])].content);
  const renderDefault = () => { $("#default-picker").innerHTML = contentPicker("default", s.default, collections, true); };

  /* ---- schedule blocks ---- */
  const color = (i) => COLORS[i % COLORS.length];
  const blockHtml = (r, i) => `
    <div class="block" id="block-${i}" style="--c:${color(i)}">
      <div class="block-row">
        <label class="field">Name <input type="text" data-b="${i}" data-bf="name" value="${esc(r.name)}" placeholder="${r.kind === "event" ? "New Year's Eve" : "Saturday Morning Cartoons"}"></label>
        ${r.kind === "event" ? `<label class="field" style="flex:0 0 160px">Date <input type="date" data-b="${i}" data-bf="date" value="${esc(r.date)}"></label>` : ""}
        <label class="field" style="flex:0 0 120px">Starts <input type="time" data-b="${i}" data-bf="start" value="${esc(r.start)}"></label>
        <label class="field" style="flex:0 0 120px">Ends <input type="time" data-b="${i}" data-bf="end" value="${esc(r.end)}"></label>
        <button type="button" class="ghost danger" data-act="remove-block" data-b="${i}" title="Remove block">Remove</button>
      </div>
      ${r.kind === "weekly" ? `<div class="days">${DAYS.map(([k, l]) => `<button type="button" data-b="${i}" data-day="${k}" class="${r.days.includes(k) ? "on" : ""}">${l}</button>`).join("")}
        <span class="hint" style="align-self:center;margin-left:6px">${r.end <= r.start && r.end ? "Runs past midnight" : ""}</span></div>` : ""}
      ${contentPicker(`block:${i}`, r.content, collections, false)}
      <details ${r.priority !== "" ? "open" : ""}><summary class="small">Priority</summary>
        <label class="field" style="max-width:220px"><input type="number" data-b="${i}" data-bf="priority" value="${esc(r.priority)}" placeholder="${r.kind === "event" ? "100" : "10"}">
        <span class="hint">When blocks overlap, the higher number wins. Events default to 100, weekly blocks to 10.</span></label>
      </details>
    </div>`;

  const renderBlocks = () => {
    const weekly = s.schedule.map((r, i) => [r, i]).filter(([r]) => r.kind === "weekly");
    const events = s.schedule.map((r, i) => [r, i]).filter(([r]) => r.kind === "event");
    $("#weekly").innerHTML = weekly.length ? weekly.map(([r, i]) => blockHtml(r, i)).join("") : `<div class="muted small">No weekly blocks. The default programming plays all week.</div>`;
    $("#events").innerHTML = events.length ? events.map(([r, i]) => blockHtml(r, i)).join("") : `<div class="muted small">No special events planned.</div>`;
    renderWeek();
  };

  const mins = (t) => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const renderWeek = () => {
    const segs = DAYS.map(() => []);
    s.schedule.forEach((r, i) => {
      if (r.kind !== "weekly") return;
      const a = mins(r.start), b = mins(r.end);
      if (a == null || b == null) return;
      for (const d of r.days) {
        const di = ALL_DAYS.indexOf(d);
        const prio = r.priority === "" ? 10 : Number(r.priority);
        if (b > a) segs[di].push({ i, a, b, prio });
        else {
          segs[di].push({ i, a, b: 1440, prio });
          if (b > 0) segs[(di + 1) % 7].push({ i, a: 0, b, prio });
        }
      }
    });
    const now = new Date();
    const today = (now.getDay() + 6) % 7;
    const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
    const defDesc = s.default.type === "none" ? "off air" : s.default.type === "restream" ? "live restream" : s.default.collection || "nothing chosen";
    $("#week").innerHTML = `
      <div class="week">
        <div class="wk-hours">${[0, 6, 12, 18, 24].map((h) => `<span style="top:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>`).join("")}</div>
        ${DAYS.map(([, l], di) => `<div class="wk-col"><div class="wk-day">${l}</div><div class="wk-track">
          ${segs[di].map((g) => `<div class="wk-block" data-jump="${g.i}" style="--c:${color(g.i)};top:${(g.a / 1440) * 100}%;height:${((g.b - g.a) / 1440) * 100}%;z-index:${g.prio}" title="${esc(s.schedule[g.i].name || `Block ${g.i + 1}`)} ${esc(s.schedule[g.i].start)}–${esc(s.schedule[g.i].end)}">${esc(s.schedule[g.i].name || `Block ${g.i + 1}`)}</div>`).join("")}
          ${di === today ? `<div class="wk-now" style="top:${nowPct}%"></div>` : ""}
        </div></div>`).join("")}
      </div>
      <div class="legend">Empty time plays the default programming (${esc(defDesc)}). The red line is now.</div>`;
  };

  /* ---- ad breaks ---- */
  const renderBreaks = () => {
    const b = s.breaks;
    const box = $("#breaks-ed");
    if (!styles.length) {
      box.innerHTML = `<div class="muted small">No break styles yet. <a href="#breaks">Create one</a> (for example: bumper, 3 ads, a promo, an "Up next" card), then pick it here.</div>`;
      return;
    }
    const st = b && styles.find((x) => x.id === b.style);
    box.innerHTML = `
      <label class="field">Break style
        <select data-br="style">
          <option value="">No ad breaks</option>
          ${styles.map((x) => `<option value="${esc(x.id)}" ${b?.style === x.id ? "selected" : ""}>${esc(x.name || x.id)} (about ${fmtSecs(x.estimate.seconds)})</option>`).join("")}
        </select>
        ${st ? `<span class="hint">${esc(slotSummary(st.slots))}</span>` : ""}
      </label>
      ${b ? `
        <label class="switch"><input type="checkbox" data-br="between" ${b.between ? "checked" : ""}> Between programmes</label>
        <label class="switch"><input type="checkbox" data-br="midroll.enabled" ${b.midroll.enabled ? "checked" : ""}> Inside long programmes (mid-roll)</label>
        ${b.midroll.enabled ? `<div class="grid3">
          <label class="field">Every <input type="number" min="0.1" step="0.5" data-br="midroll.everyMinutes" value="${esc(b.midroll.everyMinutes)}"><span class="hint">minutes of programme</span></label>
          <label class="field">Only programmes longer than <input type="number" min="0" step="1" data-br="midroll.minLengthMinutes" value="${esc(b.midroll.minLengthMinutes)}"><span class="hint">minutes</span></label>
          <label class="field">Cut points <select data-br="midroll.useChapters">
            <option value="true" ${b.midroll.useChapters ? "selected" : ""}>Snap to chapter markers</option>
            <option value="false" ${!b.midroll.useChapters ? "selected" : ""}>Exact intervals</option></select>
            <span class="hint">Chapters usually fall on scene changes.</span></label>
        </div>` : ""}
        <div class="muted small">Breaks never push a block past its start time: near a block boundary they're shortened or skipped.</div>` : ""}`;
  };

  /* ---- on-screen graphics ---- */
  const corners = (sel) => ["top-left", "top-right", "bottom-left", "bottom-right"].map((p) => `<option value="${p}" ${p === sel ? "selected" : ""}>${p.replace("-", " ")}</option>`).join("");
  const during = (g, i) => `<label class="field">Show during <select data-g="${i}" data-gf="showDuring">
      <option value="programmes" ${g.showDuring === "programmes" ? "selected" : ""}>Programmes only</option>
      <option value="always" ${g.showDuring === "always" ? "selected" : ""}>Everything (incl. breaks)</option></select></label>`;
  const nextEventOf = () => {
    const now = Date.now();
    return s.schedule.filter((r) => r.kind === "event" && r.date && r.start).map((r) => {
      const start = new Date(`${r.date}T${r.start}`).getTime();
      let end = new Date(`${r.date}T${r.end || r.start}`).getTime();
      if (end <= start) end += 86_400_000;
      return { title: r.name || "Special event", start, end };
    }).filter((e) => e.end > now).sort((a, b) => a.start - b.start)[0];
  };

  const gfxFields = (g, i) => {
    switch (g.type) {
      case "upnext": return `<div class="grid2">
        <label class="field">Appears <input type="number" min="5" data-g="${i}" data-gf="secondsBeforeEnd" value="${esc(g.secondsBeforeEnd)}"><span class="hint">seconds before the programme ends</span></label>
        <label class="field">Stays for <input type="number" min="3" max="120" data-g="${i}" data-gf="duration" value="${esc(g.duration)}"><span class="hint">seconds</span></label></div>`;
      case "nowplaying": return `<div class="grid2">
        <label class="field">Appears <input type="number" min="0" data-g="${i}" data-gf="delay" value="${esc(g.delay)}"><span class="hint">seconds after the programme starts</span></label>
        <label class="field">Stays for <input type="number" min="3" max="120" data-g="${i}" data-gf="duration" value="${esc(g.duration)}"><span class="hint">seconds</span></label></div>`;
      case "countdown": {
        const ev = nextEventOf();
        return `<div class="grid2">
        <label class="field">Count down to <select data-g="${i}" data-gf="target">
          <option value="next-event" ${g.target === "next-event" ? "selected" : ""}>The next special event</option>
          <option value="at" ${g.target === "at" ? "selected" : ""}>A date and time</option></select>
          <span class="hint">${g.target === "next-event" ? (ev ? `Next: ${esc(ev.title)}, ${new Date(ev.start).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "No upcoming special events on this channel.") : ""}</span></label>
        ${g.target === "at" ? `<label class="field">When <input type="datetime-local" data-g="${i}" data-gf="at" value="${esc(g.at)}"></label>` : `<div></div>`}
        <label class="field">Title <input type="text" data-g="${i}" data-gf="title" value="${esc(g.title)}" placeholder="${g.target === "next-event" ? "The event's name" : "New Year's Eve"}"></label>
        <label class="field">Show from <input type="number" min="0.05" step="0.5" data-g="${i}" data-gf="showHoursBefore" value="${esc(g.showHoursBefore)}"><span class="hint">hours before it starts</span></label>
        <label class="field">Corner <select data-g="${i}" data-gf="position">${corners(g.position)}</select></label>
        ${during(g, i)}</div>`;
      }
      case "ticker": return `<label class="field">Text <input type="text" data-g="${i}" data-gf="text" value="${esc(g.text)}" placeholder="Marathon weekend: every episode, back to back"></label>
        <div class="grid3">
        <label class="field">Label <input type="text" data-g="${i}" data-gf="label" value="${esc(g.label)}" placeholder="NEWS"><span class="hint">Optional tag on the left.</span></label>
        <label class="field">Speed <input type="range" min="40" max="400" step="10" data-g="${i}" data-gf="speed" value="${esc(g.speed)}"><span class="hint">${g.speed} px/s</span></label>
        ${during(g, i)}</div>`;
      case "clock": return `<div class="grid3">
        <label class="field">Format <select data-g="${i}" data-gf="format"><option value="24h" ${g.format === "24h" ? "selected" : ""}>24-hour</option><option value="12h" ${g.format === "12h" ? "selected" : ""}>12-hour</option></select></label>
        <label class="field">Corner <select data-g="${i}" data-gf="position">${corners(g.position)}</select></label>
        ${during(g, i)}</div>`;
    }
    return "";
  };

  const renderGfx = () => {
    $("#gfx-list").innerHTML = s.graphics.map((g, i) => `
      <div class="block" style="--c:${s.accent}">
        <div class="block-row" style="align-items:center">
          <label class="switch" style="flex:1"><input type="checkbox" data-g="${i}" data-gf="enabled" ${g.enabled ? "checked" : ""}> <span><b>${GRAPHIC_INFO[g.type][0]}</b><br><span class="hint">${GRAPHIC_INFO[g.type][1]}</span></span></label>
          <button type="button" class="ghost danger small" data-gremove="${i}">Remove</button>
        </div>
        ${gfxFields(g, i)}
      </div>`).join("") || `<div class="muted small">No graphics yet. Add one below.</div>`;
    const have = new Set(s.graphics.map((g) => g.type));
    $("#gfx-add").innerHTML = Object.keys(GRAPHIC_DEFAULTS).filter((t) => !have.has(t)).map((t) => `<button type="button" data-gadd="${t}">+ ${GRAPHIC_INFO[t][0]}</button>`).join("");
    renderGfxPreview();
  };

  let clockTimer;
  const renderGfxPreview = () => {
    const tv = $("#gfx-tv");
    if (!tv) return;
    clearInterval(clockTimer);
    const on = (t) => s.graphics.find((g) => g.type === t && g.enabled);
    const up = on("upnext"), np = on("nowplaying"), cd = on("countdown"), tk = on("ticker"), ck = on("clock");
    const w = s.watermark;
    const wmImg = w && wmPreview ? `<img class="wm-anim-${w.animation}" src="${esc(wmPreview)}" alt="" style="width:${w.scale * 100}%;opacity:${w.opacity};${w.position.endsWith("right") ? "right" : "left"}:${(w.margin / 1280) * 100}%;${w.position.startsWith("bottom") ? "bottom" : "top"}:${(w.margin / 720) * 100}%">` : "";
    const banner = up || np;
    const ev = cd && (cd.target === "at" && cd.at ? { title: cd.title || "Coming up", start: new Date(cd.at).getTime() } : nextEventOf());
    tv.style.setProperty("--accent", s.accent);
    tv.innerHTML = `
      ${wmImg}
      ${banner ? `<div class="g-banner ${tk ? "lifted" : ""}"><span class="g-kicker">${up ? "UP NEXT" : "YOU'RE WATCHING"}</span><span class="g-title">${up ? "Next Show Title" : "Current Show"}</span><span class="g-sub">S02E05 · Episode name${up ? "  ·  21:30" : ""}</span></div>` : ""}
      ${cd ? `<div class="g-corner ${cd.position}"><span class="g-label">${esc((cd.title || ev?.title || "Event").toUpperCase())}</span><span class="g-value" id="cd-val">--:--:--</span></div>` : ""}
      ${ck ? `<div class="g-corner ${ck.position}"><span class="g-value" id="ck-val"></span></div>` : ""}
      ${tk ? `<div class="g-ticker">${tk.label ? `<span class="g-tlabel">${esc(tk.label.toUpperCase())}</span>` : ""}<div class="g-track"><span style="animation-duration:${Math.max(4, (2400 / tk.speed)).toFixed(1)}s">${esc(tk.text || "Your ticker text scrolls here")}</span></div></div>` : ""}
      ${!s.graphics.some((g) => g.enabled) && !wmImg ? `<div class="g-empty">Graphics you add appear here</div>` : ""}`;
    const tick = () => {
      const pad = (n) => String(n).padStart(2, "0");
      const cv = $("#cd-val");
      if (cv) {
        const r = ev ? Math.max(0, Math.floor((ev.start - Date.now()) / 1000)) : null;
        cv.textContent = r == null ? "no event" : r === 0 ? "ON NOW" : `${pad(Math.floor(r / 3600))}:${pad(Math.floor(r / 60) % 60)}:${pad(r % 60)}`;
      }
      const kv = $("#ck-val");
      if (kv) {
        const d = new Date();
        kv.textContent = ck.format === "12h" ? `${pad(d.getHours() % 12 || 12)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  };

  /* ---- watermark ---- */
  const renderWm = () => {
    const w = s.watermark;
    const box = $("#wm");
    if (!w) { box.innerHTML = ""; return; }
    const pos = w.position;
    const style = [
      `width:${w.scale * 100}%`, `opacity:${w.opacity}`,
      pos.endsWith("right") ? `right:${(w.margin / 1280) * 100}%` : `left:${(w.margin / 1280) * 100}%`,
      pos.startsWith("bottom") ? `bottom:${(w.margin / 720) * 100}%` : `top:${(w.margin / 720) * 100}%`,
    ].join(";");
    box.innerHTML = `
      <div class="wm">
        <div class="stack">
          <div class="field" style="font-weight:500">Image
            <div class="upload">
              ${wmPreview ? `<img src="${esc(wmPreview)}" alt="">` : ""}
              <button type="button" data-act="upload">${w.image ? "Replace image" : "Upload image"}</button>
              <input type="file" id="wm-file" accept="image/png,image/webp,image/gif,image/jpeg" hidden>
            </div>
            <span class="hint">${w.image ? esc(w.image.split(/[\\/]/).pop()) : "A PNG with a transparent background works best."}</span>
          </div>
          <div class="field" style="font-weight:500">Position
            <div class="corner-pick">${["top-left", "top-right", "bottom-left", "bottom-right"].map((p) => `<button type="button" data-pos="${p}" class="${p === pos ? "on" : ""}">${p.replace("-", " ")}</button>`).join("")}</div>
          </div>
          <label class="field">Size <input type="range" min="2" max="40" step="1" data-wm="scale" value="${Math.round(w.scale * 100)}"><span class="hint" id="wm-scale-l">${Math.round(w.scale * 100)}% of the picture width</span></label>
          <label class="field">Opacity <input type="range" min="5" max="100" step="5" data-wm="opacity" value="${Math.round(w.opacity * 100)}"><span class="hint" id="wm-opacity-l">${Math.round(w.opacity * 100)}%</span></label>
          <label class="field">Distance from edge <input type="range" min="0" max="120" step="2" data-wm="margin" value="${w.margin}"><span class="hint" id="wm-margin-l">${w.margin}px</span></label>
          <div class="grid2">
            <label class="field">Animation <select data-wmsel="animation">
              ${[["none", "None"], ["fade", "Fade in and out"], ["pulse", "Gentle pulse"], ["slide", "Slide in"]].map(([v, l]) => `<option value="${v}" ${w.animation === v ? "selected" : ""}>${l}</option>`).join("")}
            </select><span class="hint">Animated GIFs play as they are.</span></label>
            <label class="field">Show during <select data-wmsel="showDuring">
              <option value="always" ${w.showDuring !== "programmes" ? "selected" : ""}>Everything</option>
              <option value="programmes" ${w.showDuring === "programmes" ? "selected" : ""}>Programmes only</option>
            </select><span class="hint">Hide the logo during breaks.</span></label>
          </div>
        </div>
        <div><div class="tv" id="tv"><div class="tv-title">${esc(s.name || "Your channel")}</div>${wmPreview ? `<img id="tv-wm" class="wm-anim-${w.animation}" src="${esc(wmPreview)}" alt="" style="${style}">` : ""}</div>
          <div class="hint" style="margin-top:6px">Preview. Changes apply to live viewers from the next programme.</div></div>
      </div>`;
    renderGfxPreview();
  };
  const updateWmPreview = () => {
    const w = s.watermark, img = $("#tv-wm");
    if (!w || !img) return;
    img.style.width = `${w.scale * 100}%`;
    img.style.opacity = w.opacity;
    const right = w.position.endsWith("right"), bottom = w.position.startsWith("bottom");
    img.style.left = right ? "" : `${(w.margin / 1280) * 100}%`;
    img.style.right = right ? `${(w.margin / 1280) * 100}%` : "";
    img.style.top = bottom ? "" : `${(w.margin / 720) * 100}%`;
    img.style.bottom = bottom ? `${(w.margin / 720) * 100}%` : "";
    $("#wm-scale-l").textContent = `${Math.round(w.scale * 100)}% of the picture width`;
    $("#wm-opacity-l").textContent = `${Math.round(w.opacity * 100)}%`;
    $("#wm-margin-l").textContent = `${w.margin}px`;
    renderGfxPreview();
  };

  /* ---- upcoming ---- */
  let upTimer;
  const loadUpcoming = async () => {
    if (creating) return;
    clearTimeout(upTimer);
    try {
      const items = await api("GET", `/api/channels/${encodeURIComponent(id)}/playout?hours=12`);
      const now = Date.now();
      // Fold filler/slates into readable rows.
      const rows = [];
      for (const it of items) {
        const inter = ["filler", "slate", "break", "card"].includes(it.kind);
        const label = it.kind === "filler" ? "Filler" : it.kind === "slate" ? "Off air / up next" : it.kind === "break" || it.kind === "card" ? "Commercial break" : it.title;
        const prev = rows.at(-1);
        if (prev && inter && prev.label === label) { prev.end = it.end; prev.n++; continue; }
        const sub = it.parts ? [it.subtitle, `part ${it.part + 1} of ${it.parts}`].filter(Boolean).join(" · ") : it.subtitle;
        rows.push({ start: it.start, end: it.end, label, sub, block: it.block, faint: inter, n: 1, kind: it.kind });
      }
      $("#upnext").innerHTML = rows.slice(0, 40).map((r) => `
        <div class="${r.start <= now && now < r.end ? "cur" : ""}"><time>${hhmm(r.start)}</time>
          <span class="${r.faint ? "muted" : ""}"><b>${esc(r.label)}</b>${r.label === "Commercial break" ? `<span class="muted small">${fmtSecs((r.end - r.start) / 1000)}</span>` : ""}${r.sub ? `<span class="muted small">${esc(r.sub)}</span>` : ""}
          ${r.block && r.block !== "Default" ? `<span class="chip" style="margin-top:3px;display:inline-block">${esc(r.block)}</span>` : ""}</span></div>`).join("")
        || `<div class="muted">Nothing scheduled.</div>`;
    } catch (e) {
      $("#upnext").innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
    upTimer = setTimeout(loadUpcoming, 30000);
  };

  /* ---- events ---- */
  view.addEventListener("input", onInput);
  view.addEventListener("change", onInput);
  view.addEventListener("click", onClick);

  function onInput(e) {
    const el = e.target;
    if (el.dataset.k) {
      const k = el.dataset.k;
      if (k === "id") { s.id = el.value.trim(); idTouched = true; }
      else s[k] = el.value;
      if (k === "name") {
        updateTitle();
        if (creating && !idTouched) { s.id = slug(el.value); $('[data-k="id"]').value = s.id; }
        $$(".tv-title").forEach((t) => (t.textContent = s.name || "Your channel"));
      }
      if (k === "accent") renderGfx();
      return touch();
    }
    if (el.dataset.cf) {
      target(el.dataset.cp)[el.dataset.cf] = el.value;
      if (el.dataset.cp === "default") renderWeek();
      return touch();
    }
    if (el.dataset.bf) {
      const r = s.schedule[Number(el.dataset.b)];
      r[el.dataset.bf] = el.value;
      if (["start", "end", "name"].includes(el.dataset.bf)) renderWeek();
      return touch();
    }
    if (el.dataset.br) {
      const k = el.dataset.br;
      if (k === "style") {
        s.breaks = el.value ? { ...(s.breaks ?? { between: true, midroll: { enabled: false, everyMinutes: 12, minLengthMinutes: 20, useChapters: true } }), style: el.value } : null;
        renderBreaks();
      } else if (k === "between") s.breaks.between = el.checked;
      else if (k === "midroll.enabled") { s.breaks.midroll.enabled = el.checked; renderBreaks(); }
      else if (k === "midroll.useChapters") s.breaks.midroll.useChapters = el.value === "true";
      else if (e.type === "change" || el.value !== "") s.breaks.midroll[k.split(".")[1]] = Number(el.value);
      return touch();
    }
    if (el.dataset.wm) {
      const v = Number(el.value);
      s.watermark[el.dataset.wm] = el.dataset.wm === "margin" ? v : v / 100;
      updateWmPreview();
      return touch();
    }
    if (el.dataset.wmsel) {
      s.watermark[el.dataset.wmsel] = el.value;
      renderWm();
      renderGfxPreview();
      return touch();
    }
    if (el.dataset.gf) {
      const g = s.graphics[Number(el.dataset.g)];
      const f = el.dataset.gf;
      if (f === "enabled") g[f] = el.checked;
      else if (["secondsBeforeEnd", "duration", "delay", "showHoursBefore", "speed"].includes(f)) { if (el.value === "") return; g[f] = Number(el.value); }
      else g[f] = el.value;
      if (e.type === "change" && ["target", "enabled"].includes(f)) renderGfx();
      else {
        if (f === "speed") el.nextElementSibling.textContent = `${el.value} px/s`;
        renderGfxPreview();
      }
      return touch();
    }
    if (el.id === "wm-on") {
      if (el.checked) s.watermark = s.watermark ?? { image: "", position: "bottom-right", opacity: 0.85, scale: 0.12, margin: 24 };
      else s.watermark = null;
      renderWm();
      return touch();
    }
    if (el.id === "wm-file" && el.files?.[0]) upload(el.files[0]);
  }

  async function upload(file) {
    try {
      const r = await api("POST", "/api/uploads", undefined, file);
      s.watermark.image = r.path;
      wmPreview = r.url;
      renderWm();
      touch();
    } catch (e) {
      toast(e.message);
    }
  }

  async function onClick(e) {
    const b = e.target.closest("button, .wk-block");
    if (!b) return;
    if (b.dataset.jump !== undefined) {
      const el = $(`#block-${b.dataset.jump}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.querySelector("input")?.focus({ preventScroll: true });
      return;
    }
    if (b.dataset.ctype) {
      const key = b.dataset.cp;
      const c = { type: b.dataset.ctype };
      if (c.type === "collection") Object.assign(c, emptyContent(), { collection: collections[0]?.id ?? "" });
      if (key === "default") { s.default = c; renderDefault(); renderWeek(); }
      else { s.schedule[Number(key.split(":")[1])].content = c; renderBlocks(); }
      return touch();
    }
    if (b.dataset.day) {
      const r = s.schedule[Number(b.dataset.b)];
      r.days = r.days.includes(b.dataset.day) ? r.days.filter((d) => d !== b.dataset.day) : ALL_DAYS.filter((d) => d === b.dataset.day || r.days.includes(d));
      b.classList.toggle("on");
      renderWeek();
      return touch();
    }
    if (b.dataset.gadd) {
      s.graphics.push({ ...GRAPHIC_DEFAULTS[b.dataset.gadd] });
      renderGfx();
      return touch();
    }
    if (b.dataset.gremove !== undefined) {
      s.graphics.splice(Number(b.dataset.gremove), 1);
      renderGfx();
      return touch();
    }
    if (b.dataset.pos) {
      s.watermark.position = b.dataset.pos;
      $$(".corner-pick button").forEach((x) => x.classList.toggle("on", x === b));
      updateWmPreview();
      return touch();
    }
    switch (b.dataset.act) {
      case "add-weekly":
      case "add-event": {
        const ev = b.dataset.act === "add-event";
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        s.schedule.push({ name: "", kind: ev ? "event" : "weekly", days: [...ALL_DAYS], date: ev ? date : "", start: ev ? "20:00" : "18:00", end: ev ? "22:00" : "21:00", priority: "", content: { ...emptyContent(), collection: collections[0]?.id ?? "" } });
        renderBlocks();
        const idx = s.schedule.length - 1;
        $(`#block-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        $(`#block-${idx} input`)?.focus({ preventScroll: true });
        return touch();
      }
      case "remove-block":
        s.schedule.splice(Number(b.dataset.b), 1);
        renderBlocks();
        return touch();
      case "upload":
        return $("#wm-file").click();
      case "revert":
        if (creating) { dirtyCheck = null; location.hash = "#channels"; return; }
        Object.assign(s, JSON.parse(saved));
        wmPreview = s.watermark ? `/api/channels/${encodeURIComponent(id)}/watermark?t=${Date.now()}` : "";
        renderAll();
        return touch();
      case "save":
        return save(b);
      case "delete":
        if (!confirm(`Delete the channel "${s.name}"? It will disappear from the playlist and guide.`)) return;
        try {
          await api("DELETE", `/api/channels/${encodeURIComponent(id)}`);
          dirtyCheck = null;
          toast("Channel deleted");
          location.hash = "#channels";
        } catch (err) { toast(err.message); }
        return;
    }
  }

  async function save(btn) {
    const msg = $("#save-msg");
    msg.classList.remove("err");
    if (s.watermark && !s.watermark.image) { msg.classList.add("err"); msg.textContent = "Upload a watermark image, or turn the watermark off."; return; }
    if (creating && !s.id) { msg.classList.add("err"); msg.textContent = "Give the channel a name."; return; }
    btn.disabled = true;
    try {
      await api("PUT", `/api/channels/${encodeURIComponent(s.id)}${creating ? "?create=1" : ""}`, fromEditor(s));
      saved = JSON.stringify(s);
      toast(creating ? "Channel created" : "Saved");
      if (creating) { dirtyCheck = null; location.hash = `#channel/${encodeURIComponent(s.id)}`; return; }
      updateBar();
      loadUpcoming();
    } catch (e) {
      msg.classList.add("err");
      msg.textContent = e.message;
      $("#savebar").classList.add("show");
    } finally {
      btn.disabled = false;
    }
  }

  function renderAll() {
    $$("[data-k]").forEach((el) => { el.value = s[el.dataset.k] ?? ""; });
    $("#wm-on").checked = !!s.watermark;
    updateTitle();
    renderDefault();
    renderBreaks();
    renderBlocks();
    renderWm();
    renderGfx();
  }

  renderAll();
  updateBar();
  loadUpcoming();
  cleanup = () => {
    clearTimeout(upTimer);
    clearInterval(clockTimer);
    view.removeEventListener("input", onInput);
    view.removeEventListener("change", onInput);
    view.removeEventListener("click", onClick);
  };
}

/* ================= collections ================= */

function filterChips(c) {
  const chips = [];
  if (c.library) chips.push(`library: ${c.library}`);
  if (c.kind) chips.push(KIND_LABEL[c.kind]);
  if (c.shows?.length) chips.push(c.shows.length > 2 ? `${c.shows.length} shows` : c.shows.join(", "));
  if (c.genres?.length) chips.push(c.genres.join(" / "));
  if (c.folder) chips.push(`folder: ${c.folder}`);
  if (c.match) chips.push(`contains "${c.match}"`);
  return chips.length ? chips : ["everything in the source"];
}

async function pageCollections() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Collections</h1><p class="sub">Groups of media that channels play from, e.g. "all Simpsons episodes" or "80s action movies".</p></div>
      <button class="primary" data-act="new">New collection</button>
    </div>
    <div id="list" class="cards"><div class="muted">Loading…</div></div>`;

  let cols = [], sources = [];
  const render = () => {
    $("#list").innerHTML = cols.length ? cols.map((c) => {
      const src = sources.find((s) => s.id === c.source);
      return `<div class="card tile">
        <div class="tile-head"><span class="badge ${src?.type ?? ""}">${esc(src ? src.id : c.source)}</span><h3>${esc(c.id)}</h3></div>
        <div class="chips">${filterChips(c).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
        <div class="status"><span class="dot" style="${c.items ? "" : "background:var(--warn)"}"></span>${c.items.toLocaleString()} items · ${esc(c.totalLabel)}</div>
        <div class="muted small">${c.usedBy.length ? `Used by ${c.usedBy.map(esc).join(", ")}` : "Not used by any channel"}</div>
        <div class="actions"><button data-act="edit" data-id="${esc(c.id)}">Edit</button><span class="spacer"></span>
          <button class="ghost danger" data-act="delete" data-id="${esc(c.id)}">Delete</button></div>
      </div>`;
    }).join("") : `<div class="card empty" style="grid-column:1/-1"><h3>No collections yet</h3><p>Collections pick media from your sources for channels to play.</p><button class="primary" data-act="new">New collection</button></div>`;
  };
  const load = async () => {
    [cols, sources] = await Promise.all([loadCollections(), loadSources()]);
    render();
  };

  const onClick = async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "new") return openCollectionEditor(null, sources, load);
    if (b.dataset.act === "edit") return openCollectionEditor(cols.find((c) => c.id === b.dataset.id), sources, load);
    if (b.dataset.act === "delete") {
      if (!confirm(`Delete the collection "${b.dataset.id}"? The media itself isn't touched.`)) return;
      try { await api("DELETE", `/api/collections/${encodeURIComponent(b.dataset.id)}`); toast("Collection deleted"); load(); }
      catch (err) { alert(err.message); }
    }
  };
  view.addEventListener("click", onClick);
  cleanup = () => view.removeEventListener("click", onClick);
  load().catch((e) => { $("#list").innerHTML = `<div class="card empty">Could not load: ${esc(e.message)}</div>`; });
}

async function openCollectionEditor(col, sources, onSaved) {
  if (!sources.length) { alert("Add a media source first (Media sources tab)."); return; }
  const editing = !!col;
  const c = {
    id: col?.id ?? "",
    source: col?.source ?? sources[0].id,
    library: col?.library ?? "", kind: col?.kind ?? "",
    shows: [...(col?.shows ?? [])], genres: [...(col?.genres ?? [])],
    folder: col?.folder ?? "", match: col?.match ?? "",
  };
  let facets = null;
  let showFilter = "";

  dlg.className = "wide";
  dlg.innerHTML = `
    <form method="dialog" novalidate>
      <div class="dlg-head"><h2>${editing ? `Edit ${esc(c.id)}` : "New collection"}</h2><button type="button" class="ghost" data-close>✕</button></div>
      <div class="dlg-body"><div class="dlg-split">
        <div class="stack" id="col-form"></div>
        <div><div class="preview" id="col-preview"><div class="muted">Loading…</div></div></div>
      </div><div class="form-error" id="col-err" hidden></div></div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button type="submit" class="primary">${editing ? "Save" : "Create collection"}</button></div>
    </form>`;

  const srcOf = () => sources.find((s) => s.id === c.source);

  const renderForm = () => {
    const src = srcOf();
    const server = src && src.type !== "local";
    const shows = (facets?.shows ?? []).filter((s) => !showFilter || s.name.toLowerCase().includes(showFilter.toLowerCase()));
    $("#col-form").innerHTML = `
      <div class="grid2">
        <label class="field">Name <input type="text" name="cid" value="${esc(c.id)}" ${editing ? "disabled" : ""} placeholder="simpsons"></label>
        <label class="field">Source <select name="source">${sources.map((s) => `<option value="${esc(s.id)}" ${s.id === c.source ? "selected" : ""}>${esc(s.id)} (${TYPE_LABEL[s.type]})</option>`).join("")}</select></label>
      </div>
      ${server ? `<label class="field">Library <select name="library"><option value="">Any library</option>${(facets?.libraries ?? []).map((l) => `<option ${l === c.library ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : ""}
      <div class="field" style="font-weight:500">Type
        <div class="seg" id="kind-seg" style="margin-top:6px">${[["", "Anything"], ["movie", "Movies"], ["episode", "Episodes"], ["other", "Other"]].map(([k, l]) => `<button type="button" data-kind="${k}" class="${c.kind === k ? "on" : ""}">${l}${facets && k ? ` <span class="faint">${facets.kinds[k] ?? 0}</span>` : ""}</button>`).join("")}</div>
      </div>
      ${c.kind !== "movie" && facets?.shows.length ? `<div class="field" style="font-weight:500">Shows <span class="hint">${c.shows.length ? `${c.shows.length} selected — only these shows` : "None selected — all shows"}</span>
        <input type="search" id="show-search" placeholder="Search shows…" value="${esc(showFilter)}">
        <div class="checklist">${shows.map((s) => `<label><input type="checkbox" data-show="${esc(s.name)}" ${c.shows.includes(s.name) ? "checked" : ""}> ${esc(s.name)} <small>${s.episodes} ep</small></label>`).join("") || `<div class="muted small" style="padding:8px">No matches</div>`}</div></div>` : ""}
      ${facets?.genres.length ? `<div class="field" style="font-weight:500">Genres <span class="hint">Match any selected genre.</span>
        <div class="toggle-chips">${facets.genres.map((g) => `<button type="button" data-genre="${esc(g)}" class="${c.genres.includes(g) ? "on" : ""}">${esc(g)}</button>`).join("")}</div></div>` : ""}
      ${!server ? `<label class="field">Folder <input type="text" name="folder" list="folders" value="${esc(c.folder)}" placeholder="TV/Cartoons">
        <datalist id="folders">${(facets?.folders ?? []).map((f) => `<option value="${esc(f)}">`).join("")}</datalist>
        <span class="hint">Relative to the source's folders, or a full path.</span></label>` : ""}
      <details ${c.match ? "open" : ""}><summary class="small">More filters</summary>
        <label class="field">File path contains <input type="text" name="match" value="${esc(c.match)}" placeholder="e.g. 1080p or Christmas"></label>
      </details>`;
    const search = $("#show-search");
    if (search && document.activeElement?.id !== "show-search" && showFilter) search.focus();
  };

  const preview = debounce(async () => {
    try {
      const p = await api("POST", "/api/collections/preview", c);
      $("#col-preview").innerHTML = `
        <div class="muted small">This collection contains</div>
        <div class="big">${p.items.toLocaleString()} item${p.items === 1 ? "" : "s"}</div>
        <div class="muted small">${esc(p.totalLabel)} of runtime${p.items ? ", in this order:" : ""}</div>
        ${p.items ? `<ol>${p.sample.map((x) => `<li>${esc(x.title)}${x.subtitle ? ` <span>${esc(x.subtitle)}</span>` : ""} <span>· ${esc(x.duration)}</span></li>`).join("")}</ol>${p.items > p.sample.length ? `<div class="muted small">…and ${p.items - p.sample.length} more</div>` : ""}` : `<div class="muted small">Nothing matches these filters yet.</div>`}`;
    } catch (e) {
      $("#col-preview").innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  }, 200);

  const loadFacets = async () => {
    facets = null;
    renderForm();
    try { facets = await api("GET", `/api/sources/${encodeURIComponent(c.source)}/facets`); } catch { facets = { libraries: [], shows: [], genres: [], folders: [], kinds: {} }; }
    renderForm();
    preview();
  };

  dlg.oninput = (e) => {
    const el = e.target;
    if (el.id === "show-search") { showFilter = el.value; renderForm(); $("#show-search").focus(); $("#show-search").setSelectionRange(showFilter.length, showFilter.length); return; }
    if (el.dataset.show !== undefined) {
      c.shows = el.checked ? [...c.shows, el.dataset.show] : c.shows.filter((x) => x !== el.dataset.show);
      $(".field .hint", el.closest(".field")).textContent = c.shows.length ? `${c.shows.length} selected — only these shows` : "None selected — all shows";
      return preview();
    }
    if (el.name === "cid") { c.id = el.value.trim(); return; }
    if (el.name === "source") { c.source = el.value; c.library = ""; c.shows = []; c.genres = []; c.folder = ""; return loadFacets(); }
    if (["library", "folder", "match"].includes(el.name)) { c[el.name] = el.value; return preview(); }
  };
  dlg.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-close")) return dlg.close();
    if (b.dataset.kind !== undefined) { c.kind = b.dataset.kind; if (c.kind === "movie") c.shows = []; renderForm(); return preview(); }
    if (b.dataset.genre !== undefined) {
      const g = b.dataset.genre;
      c.genres = c.genres.includes(g) ? c.genres.filter((x) => x !== g) : [...c.genres, g];
      b.classList.toggle("on");
      return preview();
    }
  };
  $("form", dlg).onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#col-err");
    err.hidden = true;
    const id = editing ? c.id : (c.id || "");
    if (!id) { err.textContent = "Give the collection a name."; err.hidden = false; return; }
    try {
      await api("PUT", `/api/collections/${encodeURIComponent(id)}${editing ? "" : "?create=1"}`, c);
      dlg.close();
      toast(editing ? "Collection saved" : "Collection created");
      onSaved?.();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };

  dlg.showModal();
  await loadFacets();
  if (!editing) $('[name="cid"]', dlg)?.focus();
}

/* ================= break styles ================= */

function fmtSecs(s) {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function slotSummary(slots) {
  return slots.map((x) => {
    if (x.type === "upnext") return `"Up next" card ${x.seconds}s`;
    const what = x.label || x.collection;
    return x.seconds ? `${what} (~${fmtSecs(x.seconds)})` : `${x.count ?? 1}× ${what}`;
  }).join(" → ");
}

async function pageBreaks() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Break styles</h1><p class="sub">What a commercial break is made of: bumpers, ads, promos and "Up next" cards, in order. Channels pick a style and where breaks go.</p></div>
      <button class="primary" data-act="new">New break style</button>
    </div>
    <div id="list" class="cards"><div class="muted">Loading…</div></div>`;
  let styles = [], collections = [];
  const load = async () => {
    [styles, collections] = await Promise.all([api("GET", "/api/breaks"), loadCollections()]);
    $("#list").innerHTML = styles.length ? styles.map((b) => `
      <div class="card tile">
        <div class="tile-head"><h3>${esc(b.name || b.id)}</h3><span class="chip">about ${fmtSecs(b.estimate.seconds)}</span></div>
        <ol class="slots-mini">${b.slots.map((x) => `<li>${x.type === "upnext"
          ? `<b>"Up next" card</b> <span class="muted">${x.seconds}s${x.background ? ` over ${esc(x.background)}` : ""}</span>`
          : `<b>${esc(x.label || "Clips")}</b> <span class="muted">${x.seconds ? `~${fmtSecs(x.seconds)}` : `${x.count ?? 1}×`} from ${esc(x.collection)}</span>`}</li>`).join("")}</ol>
        ${b.estimate.missing.length ? `<div class="status err"><span class="dot"></span>Empty collection${b.estimate.missing.length > 1 ? "s" : ""}: ${b.estimate.missing.map(esc).join(", ")}</div>` : ""}
        <div class="muted small">${b.usedBy.length ? `Used by ${b.usedBy.map(esc).join(", ")}` : "Not used by any channel"}</div>
        <div class="actions"><button data-act="edit" data-id="${esc(b.id)}">Edit</button><span class="spacer"></span>
          <button class="ghost danger" data-act="delete" data-id="${esc(b.id)}">Delete</button></div>
      </div>`).join("")
      : `<div class="card empty" style="grid-column:1/-1"><h3>No break styles yet</h3>
          <p>Start by making collections for your ads, promos and bumpers (for example a folder of ad clips), then build a break from them.</p>
          <button class="primary" data-act="new">New break style</button></div>`;
  };
  const onClick = async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "new") return openBreakEditor(null, collections, load);
    if (b.dataset.act === "edit") return openBreakEditor(styles.find((x) => x.id === b.dataset.id), collections, load);
    if (b.dataset.act === "delete") {
      if (!confirm(`Delete the break style "${b.dataset.id}"?`)) return;
      try { await api("DELETE", `/api/breaks/${encodeURIComponent(b.dataset.id)}`); toast("Break style deleted"); load(); }
      catch (err) { alert(err.message); }
    }
  };
  view.addEventListener("click", onClick);
  cleanup = () => view.removeEventListener("click", onClick);
  load().catch((e) => { $("#list").innerHTML = `<div class="card empty">Could not load: ${esc(e.message)}</div>`; });
}

function openBreakEditor(style, collections, onSaved) {
  if (!collections.length) { alert("Make a collection of clips first (Collections tab), e.g. your ads or bumpers."); return; }
  const editing = !!style;
  const b = {
    id: style?.id ?? "",
    name: style?.name ?? "",
    slots: (style?.slots ?? [
      { type: "clips", label: "Into break", collection: collections[0].id, count: 1 },
      { type: "upnext", seconds: 6 },
    ]).map((x) => ({ ...x, mode: x.type === "clips" && x.seconds ? "seconds" : "count", count: x.count ?? 1, seconds: x.seconds ?? (x.type === "upnext" ? 6 : 60) })),
  };
  const colOpts = (sel, allowNone) => `${allowNone ? `<option value="">Plain background</option>` : ""}${collections.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? "selected" : ""}>${esc(c.id)} (${c.items})</option>`).join("")}`;

  dlg.className = "wide";
  dlg.innerHTML = `
    <form method="dialog" novalidate>
      <div class="dlg-head"><h2>${editing ? `Edit ${esc(b.name || b.id)}` : "New break style"}</h2><button type="button" class="ghost" data-close>✕</button></div>
      <div class="dlg-body">
        <div class="grid2">
          <label class="field">Name <input type="text" name="bname" value="${esc(b.name)}" placeholder="Standard break"></label>
          <label class="field">ID <input type="text" name="bid" value="${esc(b.id)}" ${editing ? "disabled" : ""} placeholder="standard"></label>
        </div>
        <div><div class="field" style="font-weight:500">Slots <span class="hint">Played top to bottom. Clips are picked at random without repeating until the collection runs out.</span></div>
          <div id="slots" class="stack" style="margin-top:10px"></div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button type="button" data-add="clips">+ Clips</button>
            <button type="button" data-add="upnext">+ "Up next" card</button>
          </div>
        </div>
        <div class="test-result" id="est"></div>
        <div class="form-error" id="b-err" hidden></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button type="submit" class="primary">${editing ? "Save" : "Create break style"}</button></div>
    </form>`;

  const renderSlots = () => {
    $("#slots").innerHTML = b.slots.map((x, i) => `
      <div class="block" style="--c:${x.type === "upnext" ? "var(--warn)" : "var(--accent)"}">
        <div class="block-row">
          <span class="badge" style="align-self:center">${i + 1}. ${x.type === "upnext" ? "Up next card" : "Clips"}</span>
          <span class="spacer"></span>
          <button type="button" class="ghost small" data-move="-1" data-i="${i}" ${i === 0 ? "disabled" : ""} title="Move up">↑</button>
          <button type="button" class="ghost small" data-move="1" data-i="${i}" ${i === b.slots.length - 1 ? "disabled" : ""} title="Move down">↓</button>
          <button type="button" class="ghost small danger" data-remove="${i}">Remove</button>
        </div>
        ${x.type === "clips" ? `
        <div class="block-row">
          <label class="field">Label <input type="text" data-i="${i}" data-f="label" value="${esc(x.label ?? "")}" placeholder="Ads"></label>
          <label class="field">From collection <select data-i="${i}" data-f="collection">${colOpts(x.collection)}</select></label>
        </div>
        <div class="block-row">
          <div class="seg"><button type="button" data-i="${i}" data-mode="count" class="${x.mode === "count" ? "on" : ""}">Number of clips</button><button type="button" data-i="${i}" data-mode="seconds" class="${x.mode === "seconds" ? "on" : ""}">Up to a length</button></div>
          ${x.mode === "count"
            ? `<label class="field" style="flex:0 0 120px"><input type="number" min="1" max="50" data-i="${i}" data-f="count" value="${esc(x.count)}"></label><span class="hint" style="align-self:center">clips</span>`
            : `<label class="field" style="flex:0 0 120px"><input type="number" min="5" step="5" data-i="${i}" data-f="seconds" value="${esc(x.seconds)}"></label><span class="hint" style="align-self:center">seconds of clips</span>`}
        </div>` : `
        <div class="block-row">
          <label class="field" style="flex:0 0 140px">Seconds <input type="number" min="2" max="60" data-i="${i}" data-f="seconds" value="${esc(x.seconds)}"></label>
          <label class="field">Background <select data-i="${i}" data-f="background">${colOpts(x.background, true)}</select></label>
        </div>
        <div class="hint">Shows the next programme's name, episode and start time, drawn live over the background. In a mid-roll break it reads "Back to …".</div>`}
      </div>`).join("") || `<div class="muted small">No slots yet.</div>`;
  };

  const estimate = debounce(async () => {
    const box = $("#est");
    try {
      const r = await api("POST", "/api/breaks/estimate", b);
      box.className = `test-result ${r.missing.length ? "bad" : "ok"}`;
      box.innerHTML = `A break like this runs about <b>${fmtSecs(r.seconds)}</b>.${r.missing.length ? ` Empty collection${r.missing.length > 1 ? "s" : ""}: ${r.missing.map(esc).join(", ")} (those slots will be skipped).` : ""}`;
    } catch (e) {
      box.className = "test-result bad";
      box.textContent = e.message;
    }
  }, 200);

  dlg.oninput = (e) => {
    const el = e.target;
    if (el.name === "bname") { b.name = el.value; if (!editing && !b.idTouched) { b.id = slug(el.value); $('[name="bid"]', dlg).value = b.id; } return; }
    if (el.name === "bid") { b.id = el.value.trim(); b.idTouched = true; return; }
    if (el.dataset.f) {
      const x = b.slots[Number(el.dataset.i)];
      x[el.dataset.f] = ["count", "seconds"].includes(el.dataset.f) ? Number(el.value) : el.value;
      estimate();
    }
  };
  dlg.onclick = (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-close")) return dlg.close();
    if (t.dataset.add) {
      b.slots.push(t.dataset.add === "upnext"
        ? { type: "upnext", seconds: 6, mode: "count", count: 1 }
        : { type: "clips", label: "", collection: collections[0].id, mode: "count", count: 1, seconds: 60 });
    } else if (t.dataset.move) {
      const i = Number(t.dataset.i), j = i + Number(t.dataset.move);
      [b.slots[i], b.slots[j]] = [b.slots[j], b.slots[i]];
    } else if (t.dataset.remove) {
      b.slots.splice(Number(t.dataset.remove), 1);
    } else if (t.dataset.mode) {
      b.slots[Number(t.dataset.i)].mode = t.dataset.mode;
    } else return;
    renderSlots();
    estimate();
  };
  $("form", dlg).onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#b-err");
    err.hidden = true;
    if (!b.id) { err.textContent = "Give the break style a name."; err.hidden = false; return; }
    try {
      await api("PUT", `/api/breaks/${encodeURIComponent(b.id)}${editing ? "" : "?create=1"}`, b);
      dlg.close();
      toast(editing ? "Break style saved" : "Break style created");
      onSaved?.();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };

  renderSlots();
  estimate();
  dlg.showModal();
  if (!editing) $('[name="bname"]', dlg).focus();
}

/* ================= media sources ================= */

async function pageSources() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Media sources</h1><p class="sub">Where your channels get their media. Changes apply right away.</p></div>
      <button class="primary" data-act="add">Add source</button>
    </div>
    <div id="list" class="cards"><div class="muted">Loading…</div></div>`;
  let sources = [];
  let timer;

  const load = async () => {
    clearTimeout(timer);
    try { sources = await loadSources(); }
    catch (e) { $("#list").innerHTML = `<div class="card empty">Could not load sources: ${esc(e.message)}</div>`; return; }
    $("#list").innerHTML = sources.length ? sources.map((s) => {
      const st = s.status;
      let status;
      if (st.scanning) status = `<div class="status scanning"><span class="dot"></span>Scanning…</div>`;
      else if (st.error) status = `<div class="status err"><span class="dot"></span>${esc(st.error)}</div>`;
      else status = `<div class="status"><span class="dot"></span>${st.items.toLocaleString()} items${st.lastScan ? ` · scanned ${ago(st.lastScan)}` : ""}</div>`;
      const detail = s.type === "local" ? s.paths.map(esc).join("<br>") : `${esc(s.url)}${s.libraries ? ` · ${s.libraries.map(esc).join(", ")}` : " · all video libraries"}`;
      const used = s.usedBy.length
        ? `<div class="chips">${s.usedBy.map((c) => `<span class="chip">${esc(c.id)} · ${c.items}</span>`).join("")}</div>`
        : `<div class="muted small">Not used by any collection yet</div>`;
      return `<div class="card tile">
        <div class="tile-head"><span class="badge ${s.type}">${TYPE_LABEL[s.type]}</span><h3>${esc(s.id)}</h3></div>
        <div class="detail">${detail}</div>${status}${used}
        <div class="actions">
          <button data-act="scan" data-id="${esc(s.id)}" ${st.scanning ? "disabled" : ""}>Scan now</button>
          <button data-act="edit" data-id="${esc(s.id)}">Edit</button>
          <span class="spacer"></span>
          <button class="ghost danger" data-act="delete" data-id="${esc(s.id)}">Delete</button>
        </div></div>`;
    }).join("") : `<div class="card empty" style="grid-column:1/-1"><h3>No media sources yet</h3><p>Connect Jellyfin, Emby or a folder on this PC to start building channels.</p><button class="primary" data-act="add">Add source</button></div>`;
    timer = setTimeout(load, sources.some((s) => s.status.scanning) ? 1500 : 30000);
  };

  const onClick = async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "add": return openSourceEditor(null, load);
      case "edit": return openSourceEditor(sources.find((s) => s.id === id), load);
      case "scan":
        await api("POST", `/api/sources/${encodeURIComponent(id)}/scan`).catch((err) => toast(err.message));
        return setTimeout(load, 300);
      case "delete":
        if (!confirm(`Remove the source "${id}"? Your media files aren't touched.`)) return;
        try { await api("DELETE", `/api/sources/${encodeURIComponent(id)}`); toast("Source removed"); load(); }
        catch (err) { alert(err.message); }
    }
  };
  view.addEventListener("click", onClick);
  cleanup = () => { clearTimeout(timer); view.removeEventListener("click", onClick); };
  load();
}

function openSourceEditor(src, onSaved) {
  const editing = !!src;
  let type = src?.type ?? "jellyfin";
  let tested = null;
  dlg.className = "";
  dlg.innerHTML = `
    <form method="dialog" novalidate>
      <div class="dlg-head"><h2>${editing ? `Edit ${esc(src.id)}` : "Add source"}</h2><button type="button" class="ghost" data-close>✕</button></div>
      <div class="dlg-body">
        <div class="seg" id="type-seg" style="display:grid;grid-template-columns:repeat(3,1fr)">
          ${["jellyfin", "emby", "local"].map((t) => `<button type="button" data-type="${t}" ${editing ? "disabled" : ""}>${t === "local" ? "Local folders" : TYPE_LABEL[t]}</button>`).join("")}
        </div>
        <label class="field">Name <input type="text" name="id" autocomplete="off" value="${esc(src?.id ?? "jellyfin")}" ${editing ? "disabled" : ""}>
          <span class="hint">Used to refer to this source in collections. Letters, numbers, - and _.</span></label>
        <div data-for="server" class="stack">
          <label class="field">Server URL <input type="url" name="url" value="${esc(src?.url ?? "http://localhost:8096")}"></label>
          <label class="field">API key <input type="password" name="apiKey" autocomplete="off" placeholder="${src?.hasApiKey ? "•••••••• (saved)" : ""}"><span class="hint" id="key-hint"></span></label>
          <div><button type="button" id="test-btn">Test connection</button></div>
          <div id="test-result" hidden></div>
          <details><summary>Advanced</summary><div class="stack">
            <label class="field">Playback <select name="playback">
              <option value="auto">Automatic: read files directly when this PC can, otherwise stream</option>
              <option value="file">Always read files directly</option>
              <option value="stream">Always stream from the server</option></select></label>
            <label class="field">Path replacements <textarea name="pathReplacements" placeholder="/media => \\\\nas\\media">${esc((src?.pathReplacements ?? []).map((r) => `${r.from} => ${r.to}`).join("\n"))}</textarea>
              <span class="hint">One per line, <code>server path =&gt; path on this PC</code>. Needed when the server runs in Docker or on another machine.</span></label>
            <label class="field">User ID <input type="text" name="userId" value="${esc(src?.userId ?? "")}" placeholder="First administrator"></label>
          </div></details>
        </div>
        <div data-for="local"><label class="field">Folders
          <textarea name="paths" placeholder="D:\\Media\\TV&#10;D:\\Media\\Movies">${esc((src?.paths ?? []).join("\n"))}</textarea>
          <span class="hint">One folder per line. Subfolders are included.</span></label></div>
        <div class="form-error" id="form-error" hidden></div>
      </div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button type="submit" class="primary" id="save-btn">Save</button></div>
    </form>`;
  const form = $("form", dlg);
  if (src?.playback) form.playback.value = src.playback;

  const setType = (t) => {
    type = t;
    $$("#type-seg button").forEach((b) => b.classList.toggle("on", b.dataset.type === t));
    $('[data-for="server"]', dlg).hidden = t === "local";
    $('[data-for="local"]', dlg).hidden = t !== "local";
    $("#test-btn").textContent = t === "local" ? "Check folders" : "Test connection";
    $("#key-hint").innerHTML = src?.hasApiKey ? "A key is saved. Leave blank to keep it."
      : t === "emby" ? "In Emby: <b>Settings → Advanced → API Keys</b>." : "In Jellyfin: <b>Dashboard → API Keys → +</b>, name it tvmanager.";
    if (!editing && ["jellyfin", "emby", "local", "media"].includes(form.id.value)) form.id.value = t === "local" ? "media" : t;
  };

  const body = () => {
    const b = { type, id: form.id.value.trim() };
    if (type === "local") {
      b.paths = form.paths.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      return b;
    }
    Object.assign(b, { url: form.url.value.trim(), apiKey: form.apiKey.value.trim(), userId: form.userId.value.trim(), playback: form.playback.value });
    b.pathReplacements = form.pathReplacements.value.split(/\r?\n/).map((l) => l.split("=>").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]).map(([from, to]) => ({ from, to }));
    if (tested) {
      const picked = $$("#test-result input[type=checkbox]:checked", dlg).map((x) => x.value);
      const defaults = tested.libraries.filter((l) => l.video).map((l) => l.name);
      const same = picked.length === defaults.length && picked.every((p) => defaults.includes(p));
      b.libraries = same ? null : picked;
    }
    return b;
  };

  dlg.oninput = null;
  dlg.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-close")) return dlg.close();
    if (b.dataset.type && !editing) { setType(b.dataset.type); tested = null; $("#test-result").hidden = true; return; }
    if (b.id === "test-btn") {
      const box = $("#test-result");
      const label = b.textContent;
      b.disabled = true;
      b.textContent = type === "local" ? "Checking…" : "Connecting…";
      try {
        const r = await api("POST", "/api/sources/test", body());
        box.hidden = false;
        if (type === "local") {
          box.className = `test-result ${r.ok ? "ok" : "bad"}`;
          box.innerHTML = r.folders.length ? r.folders.map((f) => `${f.ok ? "✓" : "✗"} ${esc(f.path)}${f.ok ? "" : " (not found)"}`).join("<br>") : "Add at least one folder.";
        } else {
          tested = r;
          const chosen = src?.libraries;
          box.className = "test-result ok";
          box.innerHTML = `Connected to <b>${esc(r.serverName || "server")}</b> <span class="muted">(${TYPE_LABEL[type]} ${esc(r.version)})</span>
            <div class="muted small" style="margin-top:8px">Libraries to import:</div>
            <div class="libs">${r.libraries.map((l) => `<label><input type="checkbox" value="${esc(l.name)}" ${(chosen ? chosen.some((c) => c.toLowerCase() === l.name.toLowerCase()) : l.video) ? "checked" : ""}> ${esc(l.name)} <small class="faint">${esc(l.type)}</small></label>`).join("")}</div>`;
        }
      } catch (ex) {
        tested = null;
        box.hidden = false;
        box.className = "test-result bad";
        box.textContent = ex.message;
      } finally { b.disabled = false; b.textContent = label; }
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = body();
    const err = $("#form-error");
    err.hidden = true;
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (!b.id) return fail("Give the source a name.");
    if (type !== "local" && !b.url) return fail("Enter the server URL.");
    if (type !== "local" && !b.apiKey && !src?.hasApiKey) return fail("Enter the API key.");
    try {
      await api("PUT", `/api/sources/${encodeURIComponent(b.id)}${editing ? "" : "?create=1"}`, b);
      dlg.close();
      toast(editing ? "Saved, rescanning" : "Source added, scanning");
      onSaved?.();
    } catch (ex) { fail(ex.message); }
  };

  setType(type);
  dlg.showModal();
  (editing ? (type === "local" ? form.paths : form.apiKey) : form.apiKey).focus();
}

/* ================= sign-in ================= */

let currentUser = null;

function setUser(user) {
  currentUser = user;
  document.body.classList.toggle("signed-out", !user);
  $("#user-menu").innerHTML = user
    ? `<span class="muted small hide-sm">${esc(user)}</span><button class="ghost small" id="signout">Sign out</button>`
    : "";
  $("#signout")?.addEventListener("click", signOut);
}

async function signOut() {
  if (dirtyCheck?.() && !confirm("You have unsaved changes. Sign out anyway?")) return;
  await api("POST", "/api/auth/logout").catch(() => {});
  dirtyCheck = null;
  showAuth();
}

async function showAuth() {
  cleanup?.();
  cleanup = null;
  dirtyCheck = null;
  if (dlg.open) dlg.close();
  setUser(null);
  let st;
  try { st = await fetch("/api/auth/status").then((r) => r.json()); }
  catch { view.innerHTML = `<div class="card empty">Can't reach the tvmanager server.</div>`; return; }
  if (st.user) { setUser(st.user); return route(); }

  const setup = st.setup;
  view.innerHTML = `
    <form class="card auth-card" id="auth-form" novalidate>
      <div class="brand auth-brand"><i></i>tvmanager</div>
      <h1>${setup ? "Create your account" : "Sign in"}</h1>
      <p class="sub">${setup ? "This account manages channels, sources and settings. TV apps keep using the playlist and guide URLs without signing in." : "Sign in to manage your channels."}</p>
      <label class="field">Username <input type="text" name="username" autocomplete="username" required value="${setup ? "admin" : ""}"></label>
      <label class="field">Password <input type="password" name="password" autocomplete="${setup ? "new-password" : "current-password"}" required>
        ${setup ? `<span class="hint">At least 8 characters.</span>` : ""}</label>
      ${setup ? `<label class="field">Confirm password <input type="password" name="confirm" autocomplete="new-password" required></label>` : ""}
      ${st.needsCode ? `<label class="field">Setup code <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
        <span class="hint">You're not on the tvmanager PC, so enter the 6-digit code printed in the server's log. This stops anyone else on your network from claiming the server first.</span></label>` : ""}
      <div class="form-error" id="auth-err" hidden></div>
      <button type="submit" class="primary">${setup ? "Create account" : "Sign in"}</button>
      ${setup ? "" : `<p class="muted small" style="margin:0">Forgot your password? On the tvmanager PC, run <code>npm run reset-password -- &lt;username&gt;</code>.</p>`}
    </form>`;
  const form = $("#auth-form");
  (setup ? form.password : form.username).focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#auth-err");
    err.hidden = true;
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const b = { username: form.username.value.trim(), password: form.password.value };
    if (!b.username || !b.password) return fail("Enter a username and password.");
    if (setup) {
      if (b.password.length < 8) return fail("Use at least 8 characters.");
      if (b.password !== form.confirm.value) return fail("The passwords don't match.");
      if (st.needsCode) b.code = form.code.value.trim();
    }
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    try {
      const r = await api("POST", setup ? "/api/auth/setup" : "/api/auth/login", b);
      setUser(r.user);
      if (!location.hash || location.hash === "#") location.hash = "#channels";
      lastHash = location.hash;
      route();
      if (setup) toast("Account created");
    } catch (ex) {
      fail(ex.message);
      form.password.select();
    } finally {
      btn.disabled = false;
    }
  };
}

/* ================= settings ================= */

async function pageSettings() {
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p class="sub">Your account and who can manage this server.</p></div></div>
    <div class="settings-grid">
      <section class="card sec">
        <div class="sec-head"><div><h2>Change password</h2><p>Other devices you're signed in on will be signed out.</p></div></div>
        <form id="pw-form" class="stack" novalidate>
          <label class="field">Current password <input type="password" name="current" autocomplete="current-password"></label>
          <label class="field">New password <input type="password" name="next" autocomplete="new-password"><span class="hint">At least 8 characters.</span></label>
          <label class="field">Confirm new password <input type="password" name="confirm" autocomplete="new-password"></label>
          <div class="form-error" id="pw-err" hidden></div>
          <div><button type="submit" class="primary">Change password</button></div>
        </form>
      </section>
      <section class="card sec">
        <div class="sec-head"><div><h2>Users</h2><p>Everyone here can change everything.</p></div></div>
        <div id="users" class="stack"></div>
        <details><summary>Add a user</summary>
          <form id="add-form" class="stack" novalidate>
            <div class="grid2">
              <label class="field">Username <input type="text" name="username" autocomplete="off"></label>
              <label class="field">Password <input type="password" name="password" autocomplete="new-password"></label>
            </div>
            <div class="form-error" id="add-err" hidden></div>
            <div><button type="submit">Add user</button></div>
          </form>
        </details>
      </section>
      <section class="card sec">
        <div class="sec-head"><div><h2>Sessions</h2><p id="sess-info">Loading…</p></div></div>
        <div class="actions" style="padding:0"><button id="signout-others">Sign out other devices</button><button class="ghost" id="signout-here">Sign out</button></div>
      </section>
      <section class="card sec">
        <div class="sec-head"><div><h2>Access for TV apps</h2><p>The playlist, guide and streams don't need a login, so Plex, Jellyfin, TiVimate and VLC can use them. Anyone who can reach this server on your network can watch, but only signed-in users can change anything.</p></div></div>
      </section>
    </div>`;

  const load = async () => {
    const a = await api("GET", "/api/account");
    $("#users").innerHTML = a.users.map((u) => `
      <div class="user-row"><div><b>${esc(u.username)}</b>${u.username === a.user ? ` <span class="chip">you</span>` : ""}<div class="muted small">Added ${new Date(u.created).toLocaleDateString()}</div></div>
        ${u.username === a.user ? "" : `<button class="ghost danger small" data-remove="${esc(u.username)}">Remove</button>`}</div>`).join("");
    const others = a.sessions.filter((x) => !x.current).length;
    $("#sess-info").textContent = others ? `You're also signed in on ${others} other device${others > 1 ? "s" : ""}.` : "You're only signed in here.";
    $("#signout-others").disabled = !others;
  };

  const pw = $("#pw-form");
  pw.onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#pw-err");
    err.hidden = true;
    if (pw.next.value.length < 8) { err.textContent = "Use at least 8 characters."; err.hidden = false; return; }
    if (pw.next.value !== pw.confirm.value) { err.textContent = "The new passwords don't match."; err.hidden = false; return; }
    try {
      const r = await api("POST", "/api/account/password", { current: pw.current.value, next: pw.next.value });
      pw.reset();
      toast(r.signedOut ? `Password changed. Signed out ${r.signedOut} other session${r.signedOut > 1 ? "s" : ""}.` : "Password changed");
      load();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  const add = $("#add-form");
  add.onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#add-err");
    err.hidden = true;
    try {
      await api("POST", "/api/account/users", { username: add.username.value, password: add.password.value });
      add.reset();
      toast("User added");
      load();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $("#users").onclick = async (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b || !confirm(`Remove ${b.dataset.remove}? They'll be signed out right away.`)) return;
    try { await api("DELETE", `/api/account/users/${encodeURIComponent(b.dataset.remove)}`); toast("User removed"); load(); }
    catch (ex) { alert(ex.message); }
  };
  $("#signout-others").onclick = async () => {
    const r = await api("POST", "/api/account/signout-others");
    toast(`Signed out ${r.signedOut} other session${r.signedOut === 1 ? "" : "s"}`);
    load();
  };
  $("#signout-here").onclick = signOut;
  load().catch((e) => toast(e.message));
}

showAuth();
