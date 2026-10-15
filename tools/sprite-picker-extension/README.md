# shmupX Sprite Picker

Chrome extension (Manifest V3) that detects individual sprites inside
sprite-sheet images on the web, lets you pick the ones you want, and sends
them into the **shmupX level editor's Atlas Manager** — straight into an open
editor tab, or through an **inbox** the editor picks up when it opens.

The UI is the level editor's own look (`static/editor/index.html`): green CRT
glass, Orbitron + Share Tech Mono type, lime text and borders, glossy yellow
selection.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `tools/sprite-picker-extension/`.

No build step: plain JS, the detector and the bundled font are the only
third-party code.

## Use

1. Open the level editor in a tab — `/editor/` (or `/editor/?game=…`) on
   `codemonkey.games`, a level subdomain, `shmupx.github.io`, or local dev
   (`http://localhost:5173`, `:8000`, the Windows desktop binary on `:8787`).
   It may be its own tab, the dashboard's **Level Editor** tile (the editor
   runs in an iframe there), or an installed PWA window. The popup shows
   **EDITOR ONLINE · TAB n · atlas** when it's found.

   No editor tab? Type the **PICKER CODE** the editor's **Atlas Manager**
   shows into the popup — or skip that: once the extension has seen an editor
   tab it keeps that editor's code itself (the popup says **LEARNED FROM THE
   EDITOR TAB**). Sends then go to the editor's inbox and the popup says
   **NO EDITOR TAB · INBOX ABCD-EFGH**. This is the road for the macOS /
   Linux desktop binary (a CEF window no extension can reach) and for any
   other device.
2. Browse to a sprite-sheet page. spriters-resource.com works out of the box;
   on any other site use the popup's **Inject picker on this tab** — it asks
   Chrome for a lasting permission on that site's origin so the image proxy
   can read its images afterwards (see the limit below).
3. Click the **⊕** button (bottom-right) to enter pick mode, then click a
   sprite-sheet image. Detected sprites get lime boxes (right-clicking an image
   → **Detect Sprites in This Image** also works).
4. Click boxes to select (they turn yellow), review thumbnails in the panel.
   The **TARGET** row says where the send will go; **TARGET ATLAS** lists the
   editor's current atlas first and selected (with no editor tab, **EDITOR'S
   CURRENT**, which names no atlas so the editor keeps its own), then the
   atlases the editor reports; **MODE** is **ADD** (new frames named
   `<SPRITE NAME>_0`, `_1`, … in reading order) or **REPLACE FRAME**
   (exactly one sprite; pick the frame from that atlas's list — the panel
   refuses a name the atlas does not have and suggests the nearest). REPLACE
   stays chosen while you change the selection; with any count but one the
   panel says **REPLACE NEEDS ONE SPRITE — SENDING AS ADD**.
5. **SEND TO SHMUPX** — the editor tab comes to the front with the sprites in
   its Atlas Manager, or the panel says **SENT … → INBOX ABCD-EFGH (THE
   EDITOR PICKS THEM UP WHEN IT OPENS)**. An inbox send gets 90 s; if it is
   still running the panel says **STILL SENDING — CHECK THE EDITOR BEFORE
   SENDING AGAIN** rather than inviting a duplicate.

### Inject-anywhere and image reading

The content script never reads pixels itself: it asks the service worker to
fetch the image (`FETCH_IMAGE`), which is a plain CORS-bound `fetch`. After
**Inject picker on this tab** the proxy can read images from the hosts in
`host_permissions` (spriters-resource and its CDN), the tab's own origin
(permanently once you accept the permission prompt, otherwise only while the
`activeTab` grant lasts — until you navigate), and any host that sends
`Access-Control-Allow-Origin`. A sprite sheet served from some other CDN
without CORS headers will fail with **DETECTION FAILED: Fetch failed**; open
the image directly in its own tab and inject there.

## How it works

```
content.js (sprite site)        service worker                 bridge (editor frame, any origin above)
  ⊕ pick → SpriteDetect ──SEND_SPRITES──► PING_EDITOR: tabs.query the editor
                                           origins, SHX_PING every tab (all
                                           frames; only an editor frame answers)
                                                 │
                              editor frame found │ no editor frame + PICKER CODE
                                                 ▼                      │
                                  SHX_INJECT ──► window.postMessage     │
                                  (frameId when known)                  │
                                  {source:'sprite-picker-bridge',       │
                                   type:'SPRITE_PICKER_INJECT',         │
                                   sprites, atlas?, mode, frameName?,   │
                                   batchId, from, at}                   │
                                                 │                      ▼
                                  the editor's Atlas Manager    PUT https://evil-invaders-default-rtdb
                                  adds / replaces the frames    .firebaseio.com/spritePicker/inbox/
                                  and notifies                  <CODE>/<batchId>.json
                                                                        │
                                                                the editor's inbox watcher
                                                                (open with that PICKER CODE)
```

- The target decision is one pure function, `chooseTarget` in
  `lib/picker-core.js`: the first editor frame wins; else a valid picker code
  means the inbox; else **NO TARGET** with the sentence that says what to do.
  The service worker returns the target it tried with every result, and the
  panel re-checks after a failed send, so the TARGET row never goes stale.
- `GET_ATLAS_FRAMES { requestId, atlas? }` is relayed the same way: the
  bridge posts it into the page and waits (3 s) for
  `{source:'sprite-picker-page', type:'ATLAS_FRAMES_RESPONSE', requestId,
  frames, atlas, currentAtlas, atlases, pickerCode}`. The editor answers for
  any atlas it knows without switching; the panel uses `currentAtlas` to lead
  and select the TARGET ATLAS list, `atlases` for the rest of it, and fetches
  (and caches) each atlas's `frames` for REPLACE FRAME's datalist as you
  change the select. With the inbox as target the answer is
  `{frames: [], atlas: null, inbox: true}`.
- Sprites travel as PNG data URLs: `{ name, dataURL, w, h }`, cmg's shape.
  An inbox batch is `{ at, from, batchId, atlas, mode, frameName, sprites }`
  (`inboxBody` in the core; nulls, never undefined) and is refused over
  4 MiB (`INBOX_MAX_BYTES`) — send fewer at a time. The PUT is abandoned
  after 80 s.
- Sprite detection (`lib/sprite-detect.js`) is the flood-fill /
  background-key-out algorithm ported from SpriteX's atlas manager — kept
  verbatim from cmg's extension.
- Recognising the editor: the bridge runs on every `localhost` /
  `127.0.0.1` port, where any project may have a `/editor` route, so a frame
  is the editor only when the path matches AND the page carries
  `<meta name="shmupx-editor" content="1">`. The dashboard (`#app-root` +
  `dashboard.bundle`) is reported separately.
- Bridging the dashboard: the editor inside the dashboard's iframe answers
  `SHX_PING` at once; the dashboard's own frame answers `{isDashboard:true}`
  250 ms later, so when both exist the editor's answer is the one the service
  worker keeps (one response per `tabs.sendMessage`). A content script cannot
  learn its own frameId, so an iframe editor is addressed with no frameId
  (`frameOptions` in the core) — every frame receives `SHX_INJECT`, and only
  the editor frame acts on it.
- Hardening on the sprite site: the toggle, overlay and panel render inside a
  **closed shadow root** on a host element, so the page cannot read the
  PICKER CODE out of the panel or reach its buttons; every handler also
  ignores untrusted (synthetic) events. `content.css` is linked into the
  shadow tree (the manifest's copy in the document only styles the page's
  images); the `SHX Orbitron` `@font-face` is injected into the document,
  since a shadow tree cannot declare fonts.

## The picker code

Eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O, 1/I),
shown as `ABCD-EFGH`. The editor shows its code in the **Atlas Manager** and
keeps it in `localStorage["shmupx-picker-code"]`; the extension keeps one in
`chrome.storage.local.pickerCode` — the one you typed (`pickerCodeSource:
"typed"`, never overwritten), or the one it learned from an editor tab
(`"editor"`, which follows the editor). The inbox lives at
`spritePicker/inbox/<CODE>/<batchId>` in the Realtime Database.

### Trust model

The inbox is a public, unauthenticated hand-off in the Realtime Database:
the code is the only secret. Anyone who has it can write a batch under that
path, and the editor applies what arrives on sight — so treat the code like
a room code, not like a password, and share it only with people you want
filing sprites into your atlas. Sprites in transit are readable by anyone
who knows the code (they are base64 PNGs, not encrypted), so do not send art
you would not publish. If a code leaks, clear `shmupx-picker-code` from the
editor's localStorage and the editor mints a new one; the extension then
learns the new code the next time it sees the editor tab (a typed code must
be retyped).

## Files

- `manifest.json` — MV3; content scripts on sprite sites + the editor origins
  (`all_frames`, the list is `Core.EDITOR_URL_PATTERNS`), host permissions
  for both and the inbox, `optional_host_permissions` for inject-anywhere.
- `lib/picker-core.js` — the pure core shared by every context: codes, editor
  URL rules, inbox path / body / size, batch ids, frame addressing, atlas
  options, nearest frame name, `chooseTarget`, the inject body.
- `background/service-worker.js` — CORS image proxy, editor discovery,
  picker-code learning, routing (tab or inbox), context menu.
- `bridge/shmupx-bridge.js` — on the editor origins, every frame: answers
  pings, relays injects and per-atlas frame listings into the page.
- `content/content.js` + `content.css` — pick mode, overlay, the CRT panel in
  a closed shadow root.
- `lib/sprite-detect.js` — detection algorithms (no dependencies, verbatim).
- `popup/` — target status, PICKER CODE (typed or learned),
  inject-on-any-site with an origin permission, recheck.
- `fonts/Orbitron-Variable.woff2` — bundled (OFL) so the panel matches the
  editor on any site.
- `icons/` — the shmupX app icon at 16 / 48 / 128.
- `test/` — `node --test` (`deno task sprite-picker:test`): every core
  function, and the manifest against the files beside it and the core's
  origin list.
