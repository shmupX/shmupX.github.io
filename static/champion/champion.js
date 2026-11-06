// The daily world champion, on the page: a player who sets a game's TODAY'S
// BEST can ask to be told, at 00:00 UTC, if it stood. The midnight job
// (lib/daily-champion/job.ts) sends that push.
//
// - This browser's champion id is a random secret kept in localStorage; the
//   board names it by the secret's hash, the holder. game.bundle.js asks
//   __SHMUPX_CHAMPION__.holder() for it and writes it onto today's board in
//   the same transaction as the value, then fires `shmupx:daily-best` when
//   the board it committed is this browser's.
// - On that event a player who has not said yes here is offered NOTIFY ME.
//   Yes registers /champion/sw.js (scope /champion/), subscribes with the
//   job's VAPID key and puts the subscription, sealed with the secret and the
//   games this browser raised a board in to the job's box key (box.js), at
//   shmupX/champions/subs/<holder>. A player who said yes is told each new
//   best is in hand, the box sealed again, with TURN OFF; one who blocked
//   notifications is never asked again by this page.
//
// It runs only where a push can reach a player for good: on the hosts
// config.json names (codemonkey.games and its level subdomains), in a secure
// context with service workers and the Push API. Elsewhere — the packaged
// launcher's loopback page, an exported app, a browser without Web Push —
// it offers no holder, so the game writes none.

import { fromB64url, holderFor, newSecret, seal } from "./box.js";

const STORE = "shmupx-champion-v1";
const SW = "/champion/sw.js";
const SCOPE = "/champion/";
const MAX_GAMES = 40;

function hostAllowed(hosts) {
  const host = location.hostname;
  return Array.isArray(hosts) &&
    hosts.some((h) => host === h || host.endsWith("." + h));
}

function supported() {
  return typeof window !== "undefined" && window.isSecureContext &&
    "serviceWorker" in navigator && "PushManager" in window &&
    "Notification" in window;
}

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || "null");
    return v && typeof v === "object" ? v : null;
  } catch (_e) {
    return null;
  }
}

function save(state) {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
    return true;
  } catch (_e) {
    return false;
  }
}

// The page to open when the notification is tapped: the game as it was
// played, without the switches a run was started with.
function gameUrl() {
  const level = new URLSearchParams(location.search).get("level");
  if (location.pathname.startsWith("/eshop/")) {
    return location.origin + location.pathname;
  }
  if (level) {
    return `${location.origin}/games/2028-ai?level=${encodeURIComponent(level)}`;
  }
  return location.origin + "/";
}

// --- the toast ---------------------------------------------------------------

let toastEl = null;
let toastTimer = 0;

// The window the toast goes in: the top page when it is this origin's. The
// launcher plays the game in an iframe and lays its touch pad over it, which
// would take the taps meant for the toast's buttons.
function host() {
  try {
    if (window.top !== window && window.top.document.body) return window.top;
  } catch (_e) {
    // another origin's page: stay in the frame
  }
  return window;
}

// The game listens for keys, pointers, mice and touches up to the top window;
// none of what lands on the toast reaches it.
const SWALLOWED = [
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "touchstart",
  "touchend",
];

function hideToast() {
  clearTimeout(toastTimer);
  if (toastEl) toastEl.remove();
  toastEl = null;
}

function toast(text, actions = [], ms = 9000) {
  hideToast();
  const doc = host().document;
  const el = doc.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:max(12px, env(safe-area-inset-bottom))",
    "transform:translateX(-50%)",
    "z-index:2147483000",
    "max-width:min(92vw, 420px)",
    "box-sizing:border-box",
    "padding:10px 12px",
    "border:2px solid #ffd54a",
    "border-radius:10px",
    "background:rgba(12, 12, 20, 0.94)",
    "color:#fff",
    "font:600 14px/1.35 system-ui, sans-serif",
    "box-shadow:0 6px 24px rgba(0,0,0,.5)",
    "display:flex",
    "flex-wrap:wrap",
    "gap:8px",
    "align-items:center",
    "justify-content:center",
    "text-align:center",
  ].join(";");
  const msg = doc.createElement("span");
  msg.textContent = text;
  msg.style.cssText = "flex:1 1 100%";
  el.append(msg);
  for (const a of actions) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    b.style.cssText = [
      "font:700 13px/1 system-ui, sans-serif",
      "padding:8px 12px",
      "border-radius:8px",
      "cursor:pointer",
      a.primary
        ? "background:#ffd54a;color:#111;border:0"
        : "background:transparent;color:#fff;border:1px solid #888",
    ].join(";");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      a.run();
    });
    el.append(b);
  }
  for (const type of SWALLOWED) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }
  doc.body.append(el);
  toastEl = el;
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}

// --- the subscription --------------------------------------------------------

async function activeRegistration() {
  const reg = await navigator.serviceWorker.register(SW, { scope: SCOPE });
  if (reg.active) return reg;
  const worker = reg.installing || reg.waiting;
  await new Promise((resolve) => {
    if (!worker || worker.state === "activated") return resolve();
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    });
  });
  return reg;
}

function sameKey(a, b) {
  if (!a || !b) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

async function subscription(config) {
  const reg = await activeRegistration();
  const key = fromB64url(config.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made under another VAPID key (rotated keys) cannot be
  // pushed to with ours.
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  }
  return sub;
}

function boxUrl(state) {
  const db = globalThis.__FIREBASE_CONFIG__ &&
    globalThis.__FIREBASE_CONFIG__.databaseURL;
  const root = globalThis.__RTDB_ROOT__ || "shmupX";
  if (!db) throw new Error("no database");
  return `${db}/${root}/champions/subs/${state.holder}.json?print=silent`;
}

async function storeBox(config, state, sub) {
  const url = boxUrl(state);
  const box = await seal(
    config.boxPublicKey,
    JSON.stringify({
      v: 1,
      secret: state.secret,
      subscription: sub.toJSON(),
      origin: location.origin,
      games: state.games || {},
    }),
  );
  const res = await fetch(url, {
    method: "PUT",
    body: JSON.stringify({ box, updatedAt: { ".sv": "timestamp" } }),
  });
  if (!res.ok) throw new Error(`database said ${res.status}`);
  state.endpoint = sub.endpoint;
  state.sealed = true;
  save(state);
}

// TURN OFF: the box out of the database, the subscription dropped.
async function optOut(state) {
  state.optedIn = false;
  state.sealed = false;
  delete state.endpoint;
  save(state);
  await fetch(boxUrl(state), { method: "DELETE" }).catch(() => {});
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe().catch(() => {});
}

// --- the page ----------------------------------------------------------------

async function start() {
  if (!supported()) return;
  let config;
  try {
    const res = await fetch("/champion/config.json", { cache: "no-cache" });
    config = res.ok ? await res.json() : null;
  } catch (_e) {
    config = null;
  }
  if (!config || !config.vapidPublicKey || !config.boxPublicKey) return;
  if (!hostAllowed(config.hosts)) return;

  let state = load();
  if (!state || typeof state.secret !== "string" || !state.secret) {
    state = { secret: newSecret(), games: {} };
  }
  state.games = state.games && typeof state.games === "object"
    ? state.games
    : {};
  state.holder = await holderFor(state.secret);
  // No storage, no lasting id: a holder this page cannot keep would name
  // nobody by tomorrow.
  if (!save(state)) return;

  globalThis.__SHMUPX_CHAMPION__ = {
    holder: () => state.holder,
  };

  const turnOff = {
    label: "TURN OFF",
    run: async () => {
      hideToast();
      await optOut(state);
      toast("Daily champion notifications are off.");
    },
  };

  // Subscribe and seal: true once the box is in the database. Only for a
  // player who said yes here (optedIn): permission this origin was given
  // for something else (the editor's export alerts) is not a yes to this.
  let busy = null;
  const optIn = (quiet) => {
    busy = busy || (async () => {
      try {
        const sub = await subscription(config);
        await storeBox(config, state, sub);
        if (!quiet) {
          toast(
            "🏆 You're on! If your score is still the best at 00:00 UTC, " +
              "you'll get a notification.",
            [turnOff],
          );
        }
        return true;
      } catch (e) {
        if (!quiet) {
          toast(`Couldn't turn on notifications (${e && e.message || e}).`);
        }
        return false;
      } finally {
        busy = null;
      }
    })();
    return busy;
  };

  // A yes whose box never made it in (the page closed, the network dropped),
  // a game added since the last seal, or a subscription the browser replaced
  // goes back in now, so tonight's push finds it.
  if (Notification.permission === "granted" && state.optedIn) {
    navigator.serviceWorker.getRegistration(SCOPE).then(async (reg) => {
      const sub = reg && await reg.pushManager.getSubscription();
      if (!state.sealed || !sub || sub.endpoint !== state.endpoint) {
        await optIn(true);
      }
    }).catch(() => {});
  }

  addEventListener("shmupx:daily-best", (event) => {
    const d = event.detail || {};
    if (d.holder !== state.holder || !d.gameId) return;
    // A board for a day that has already ended (a run that only landed after
    // midnight) is past the job that crowns it: nothing to offer.
    if (d.date !== new Date().toISOString().slice(0, 10)) return;
    // newest last, so the oldest go first past MAX_GAMES
    delete state.games[d.gameId];
    state.games[d.gameId] = { url: gameUrl(), name: d.name || undefined };
    const ids = Object.keys(state.games);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_GAMES))) {
      delete state.games[id];
    }
    // the box names the games this browser may be told about: seal it again
    state.sealed = false;
    save(state);
    const score = Number(d.value || 0).toLocaleString("en-US");
    if (state.optedIn && Notification.permission === "granted") {
      optIn(true).then((ok) => {
        if (ok) {
          toast(
            `🏆 TODAY'S BEST: ${score}! If it stands at 00:00 UTC, ` +
              "you'll get a notification.",
            [turnOff],
          );
        }
      });
      return;
    }
    if (Notification.permission === "denied") return;
    if (state.notNow === d.date) return;
    toast(
      `🏆 TODAY'S BEST: ${score}! Want a notification at 00:00 UTC ` +
        "if you're still the daily world champion?",
      [
        {
          label: "NOTIFY ME",
          primary: true,
          run: async () => {
            hideToast();
            state.optedIn = true;
            save(state);
            // asked from the tap, in the window it landed in
            const answer = Notification.permission === "granted"
              ? "granted"
              : await host().Notification.requestPermission();
            if (answer === "granted") await optIn(false);
            else {
              state.optedIn = false;
              save(state);
            }
          },
        },
        {
          label: "NOT NOW",
          run: () => {
            state.notNow = d.date;
            save(state);
            hideToast();
          },
        },
      ],
      20000,
    );
  });
}

start().catch(() => {});
