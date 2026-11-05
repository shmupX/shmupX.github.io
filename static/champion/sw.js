// The daily world champion's service worker: it shows the push the midnight
// job sends (lib/daily-champion/job.ts) and opens the game when it is tapped.
//
// champion.js registers it at scope /champion/, a path no page lives under, so
// it never sits in front of a request: the root scope belongs to /emu-sw.js,
// which the dashboard registers only for players who install an emulator or
// an eShop game. A push wakes a worker whatever pages it controls.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(
      data.title || "shmupX",
      {
        body: data.body || "",
        icon: "/app-icons/icon-192.png",
        badge: "/app-icons/icon-96.png",
        tag: data.tag || undefined,
        data: { url: data.url || "/" },
      },
    ),
  );
});

// Only a page of this origin: the job writes the URL the browser itself
// sealed, but a tap never leaves for anywhere else.
function sameOrigin(url) {
  try {
    const u = new URL(url, self.location.origin);
    if (u.origin === self.location.origin) return u.href;
  } catch (_e) {
    // fall through
  }
  return self.location.origin + "/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = sameOrigin(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of open) {
      if (client.url === target && "focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
