<script>
  // ShmupX context menu — the coverflow picker over the Dezaemon .sav shelf.
  // Like Osd.svelte this is a dumb renderer: the Dashboard owns the library,
  // the selected index, the cover cache, and every handler, so gamepad,
  // keyboard, and touch/mouse all drive one source of truth.
  //
  // Item shape: { slug, file, title, titleJa?, developer?, developerJa?,
  //   genre?, video?, hasCover } — the editor shelf's normalized row, plus the
  //   YouTube id the Dashboard joins on from games-db.json. `covers` maps
  //   slug -> data URL (256x480 PNG), null for a failed fetch, undefined while
  //   not fetched; anything falsy renders the cartridge placeholder.
  let {
    open = false,
    items = [],
    sel = 0,
    covers = {},
    loading = false,
    error = '',
    favs = new Set(),
    onfav = () => {},
    onselect = () => {},
    onlaunch = () => {},
    onclose = () => {},
  } = $props();

  // Same id the Dashboard stores favorites under: every row carries a slug
  // (static-manifest rows get one computed at load), so the file fallback is
  // belt-only — and it matches the {#each} key below.
  const favId = (it) => it?.slug || it?.file || '';

  // Cards rendered per side. The outermost pair sits at opacity 0, so a card
  // entering the window mounts invisible at the edge and fades in as it slides
  // inward — a keyed {#each} mounts nodes at their final style, which would
  // otherwise pop.
  const WINDOW = 4;
  let visible = $derived.by(() => {
    const out = [];
    const lo = Math.max(0, sel - WINDOW), hi = Math.min(items.length - 1, sel + WINDOW);
    for (let i = lo; i <= hi; i++) out.push({ item: items[i], i, off: i - sel });
    return out;
  });
  let current = $derived(items[sel]);
  let curFav = $derived(!!current && favs.has(favId(current)));
  let counter = $derived(
    items.length
      ? String(sel + 1).padStart(3, '0') + ' / ' + String(items.length).padStart(3, '0')
      : '000 / 000'
  );

  // Fan layout: the centred card faces the viewer; the rest recede in a
  // classic coverflow arc. Distances are multiples of the card width
  // (--cf-w) so one variable resizes the whole fan.
  function cardStyle(off) {
    const abs = Math.abs(off);
    const sign = off < 0 ? -1 : 1;
    const x = off === 0 ? '0px' : `calc(${(sign * (0.66 + (abs - 1) * 0.30)).toFixed(2)} * var(--cf-w))`;
    const z = off === 0 ? '7vmin' : `calc(-6vmin - ${abs * 1.2}vmin)`;
    const ry = off === 0 ? 0 : -sign * 46;
    const sc = off === 0 ? 1 : 0.88;
    // The invisible outermost pair exists only as fade-in staging — it must
    // not be hit-testable (opacity 0 still takes clicks without this).
    const ghost = abs >= WINDOW;
    return `z-index:${100 - abs};opacity:${ghost ? 0 : 1};${ghost ? 'pointer-events:none;' : ''}` +
      `transform:translate(-50%, -50%) translateX(${x}) translateZ(${z}) rotateY(${ry}deg) scale(${sc});`;
  }

  // Swipe: the fan slides under the finger (~one cover per --cf-w * .55 of
  // travel); a drag past a few pixels swallows the trailing click so a swipe
  // never launches a game — same contract as the Dashboard's strip drag.
  let stageEl = $state(null);
  let drag = null;
  let dragMoveFn = null;
  let dragUpFn = null;
  let dragged = false;
  function stepPx() {
    const w = stageEl ? stageEl.clientWidth : 0;
    return Math.max(48, (w || 600) * 0.12);
  }
  function onStageDown(e) {
    // One drag at a time, primary pointer only: a second finger (or a resting
    // palm) must neither hijack the live drag's origin nor orphan its window
    // listeners, and a right-button press is the context menu's, not a swipe.
    if (drag || e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, sel0: sel, moved: false };
    dragMoveFn = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x;
      if (Math.abs(dx) > 6) { drag.moved = true; dropPreview(); }
      const next = Math.max(0, Math.min(items.length - 1, drag.sel0 + Math.round(-dx / stepPx())));
      if (next !== sel) onselect(next);
    };
    dragUpFn = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      dragged = !!drag.moved;
      endDrag();
    };
    window.addEventListener('pointermove', dragMoveFn);
    window.addEventListener('pointerup', dragUpFn);
    window.addEventListener('pointercancel', dragUpFn);
  }
  function endDrag() {
    drag = null;
    if (dragMoveFn) window.removeEventListener('pointermove', dragMoveFn);
    if (dragUpFn) {
      window.removeEventListener('pointerup', dragUpFn);
      window.removeEventListener('pointercancel', dragUpFn);
    }
    dragMoveFn = dragUpFn = null;
  }
  // Closing mid-swipe (Esc, gamepad B) unmounts the stage but not the window
  // listeners — drop them whenever the picker closes, and on teardown.
  $effect(() => {
    if (!open) { endDrag(); dropPreview(); }
    return () => { endDrag(); dropPreview(); };
  });
  function cardClick(off, i) {
    // The press that ends a hold-preview is spent; it must not launch.
    if (heldPreview) { heldPreview = false; dropPreview(); return; }
    if (dragged) { dragged = false; return; }
    if (off === 0) onlaunch(i);
    else onselect(i);
  }
  // Keyboard twin of cardClick: the cards are click-focusable (tabindex="-1"),
  // so a focused card has to answer Enter/Space itself — a role="option" div
  // synthesizes no click. stopPropagation keeps the Dashboard's window-level
  // onKey from acting on the same keystroke as well.
  function cardKey(off, i) {
    return (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      cardClick(off, i);
    };
  }

  // ── gameplay preview ────────────────────────────────────────────────────
  // A cover whose game has a video (scraped from its satakore.com page) plays
  // it muted in place of the art while the pointer rests on the card, or while
  // a finger holds it. One at a time, and the player is click-through, so the
  // card underneath is still what launches the game.
  let previewIdx = $state(-1);
  let previewTimer = 0;
  let heldPreview = false;

  function previewSrc(id) {
    return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) +
      '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1';
  }
  function armPreview(i, item, delay, hold) {
    if (!item?.video) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewIdx = i;
      if (hold) heldPreview = true;
    }, delay);
  }
  function dropPreview() {
    clearTimeout(previewTimer);
    previewTimer = 0;
    previewIdx = -1;
  }
  function cardEnter(e, v) {
    if (e.pointerType === 'mouse') armPreview(v.i, v.item, 320, false);
  }
  // Touch/pen: a hold is the hover. `heldPreview` marks the press as spent so
  // the release that ends the preview does not also launch the game.
  function cardDown(e, v) {
    if (e.pointerType === 'mouse') return;
    heldPreview = false;
    armPreview(v.i, v.item, 400, true);
  }
  function cardUp(e) {
    if (e.pointerType !== 'mouse') dropPreview();
  }

  // Wheel browses; both axes so trackpads and mice agree.
  let wheelAcc = 0;
  function onStageWheel(e) {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelAcc += d;
    while (wheelAcc >= 40) { wheelAcc -= 40; if (sel < items.length - 1) onselect(sel + 1); }
    while (wheelAcc <= -40) { wheelAcc += 40; if (sel > 0) onselect(sel - 1); }
  }
</script>

{#if open}
  <div class="sav-scrim" aria-hidden="true" onpointerdown={onclose}></div>
  <div class="sav-picker" role="menu" aria-label="Saved games">
    <div class="sav-hd">
      <span class="sav-title">SAVED GAMES</span>
      <span class="sav-sub">.SAV SHELF // DEZAEMON 2</span>
      <span class="sav-count">{items.length ? items.length + ' GAMES' : ''}</span>
      <button type="button" class="sav-x" aria-label="Close" onclick={onclose}>✕</button>
    </div>

    {#if loading}
      <div class="sav-note">READING SHELF…</div>
    {:else if error}
      <div class="sav-note err">{error}</div>
    {:else if !items.length}
      <div class="sav-note">NO SAVED GAMES REACHABLE — the database could not be read and this build ships no .sav collection.</div>
    {:else}
      <div
        class="sav-stage"
        role="listbox"
        aria-label="Saved games"
        tabindex="-1"
        bind:this={stageEl}
        onpointerdown={onStageDown}
        onwheel={onStageWheel}
      >
        {#each visible as v (v.item.slug || v.item.file)}
          <div
            class="cf-card {v.off === 0 ? 'center' : ''}"
            role="option"
            aria-selected={v.off === 0}
            tabindex="-1"
            style={cardStyle(v.off)}
            onclick={() => cardClick(v.off, v.i)}
            onkeydown={cardKey(v.off, v.i)}
            onpointerenter={(e) => cardEnter(e, v)}
            onpointerleave={dropPreview}
            onpointerdown={(e) => cardDown(e, v)}
            onpointerup={cardUp}
            onpointercancel={cardUp}
          >
            {#if previewIdx === v.i && v.item.video}
              <iframe
                class="cf-video"
                src={previewSrc(v.item.video)}
                title="{v.item.title} — gameplay"
                allow="autoplay; encrypted-media; picture-in-picture"
              ></iframe>
            {:else if v.item.slug && covers[v.item.slug]}
              <img class="cf-art" src={covers[v.item.slug]} alt={v.item.title} draggable="false" />
            {:else}
              <div class="cf-ph">
                <span class="cf-ph-mark">DEZAEMON 2</span>
                <span class="cf-ph-title">{v.item.title}</span>
                <span class="cf-ph-foot">.SAV</span>
              </div>
            {/if}
            {#if v.item.video && previewIdx !== v.i}
              <span class="cf-play" aria-hidden="true">▶</span>
            {/if}
            <!-- The centred card wears the live ★ toggle; the rest only mark
                 membership. pointerdown stops here so pressing the star never
                 starts a stage drag or arms the hold-preview underneath. -->
            {#if v.off === 0}
              <button
                type="button"
                class="cf-fav {curFav ? 'on' : ''}"
                aria-label={curFav ? 'Unpin from favorites' : 'Pin to favorites'}
                aria-pressed={curFav}
                onclick={(e) => { e.stopPropagation(); onfav(v.i); }}
                onpointerdown={(e) => e.stopPropagation()}
              >{curFav ? '★' : '☆'}</button>
            {:else if favs.has(favId(v.item))}
              <span class="cf-fav is-static on" aria-hidden="true">★</span>
            {/if}
          </div>
        {/each}
      </div>

      <div class="sav-caption">
        <div class="sav-name">
          {current?.title || '—'}{#if current?.titleJa && current.titleJa !== current.title}<span class="ja"> · {current.titleJa}</span>{/if}
        </div>
        <div class="sav-meta">
          {#if current?.developer}<span>{current.developer}</span>{/if}
          {#if current?.genre}<span>{current.genre}</span>{/if}
          <span class="sav-counter">{counter}</span>
        </div>
      </div>
    {/if}

    <div class="sav-foot">
      <span><b>A</b> Play</span>
      <span><b>B</b> Close</span>
      <span><b>X</b> Favorite</span>
      <span class="sav-foot-hint">← → browse · F favorites · hover or hold a cover to preview it · <b>Y</b> opens this shelf</span>
    </div>
  </div>
{/if}

<style>
  .sav-scrim { position: fixed; inset: 0; z-index: 102; background: rgba(0, 0, 0, .62); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }

  .sav-picker {
    position: fixed; inset: 0; z-index: 103;
    display: flex; flex-direction: column;
    padding: max(2.4vmin, 14px) max(3vmin, 16px);
    box-sizing: border-box; pointer-events: none;
    color: var(--green, #9CFF6B); font-family: 'Orbitron', sans-serif;
    animation: savIn .16s ease-out;
    --cf-w: clamp(120px, 30vmin, 220px);
  }
  .sav-picker > * { pointer-events: auto; }
  @keyframes savIn { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }

  .sav-hd { display: flex; align-items: baseline; gap: 14px; }
  .sav-title { font-weight: 800; letter-spacing: .26em; font-size: clamp(13px, 2.4vmin, 18px); text-shadow: 0 0 16px var(--green-glow, #7CFF4F); }
  .sav-sub, .sav-count {
    font-family: 'Share Tech Mono', monospace; font-size: clamp(9px, 1.6vmin, 12px);
    letter-spacing: .18em; opacity: .6; white-space: nowrap;
  }
  .sav-count { margin-left: auto; }
  .sav-x {
    appearance: none; border: 0; background: transparent; color: var(--green, #9CFF6B);
    opacity: .65; width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
    font-size: 15px; line-height: 1; align-self: center;
  }
  .sav-x:hover { opacity: 1; background: rgba(120, 255, 90, .12); }

  .sav-note {
    flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(11px, 2vmin, 14px);
    letter-spacing: .14em; opacity: .75; padding: 0 8vmin;
  }
  .sav-note.err { color: #ff9a7a; opacity: .95; }

  .sav-stage {
    position: relative; flex: 1; min-height: 0;
    perspective: 1100px; perspective-origin: 50% 46%;
    touch-action: pan-y; cursor: grab; overflow: hidden;
  }
  .cf-card {
    position: absolute; left: 50%; top: 47%;
    /* Height-led sizing: on short viewports the cap shrinks BOTH axes through
       the aspect ratio, instead of squashing a fixed width against it. */
    height: min(calc(var(--cf-w) * 1.875), 74%);
    aspect-ratio: 256 / 480;
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55));
    border-radius: 6px; overflow: hidden; background: #000;
    transition: transform .3s cubic-bezier(.22, .9, .32, 1), opacity .3s ease, box-shadow .3s ease;
    box-shadow: 0 1.6vmin 4vmin rgba(0, 0, 0, .7);
    -webkit-box-reflect: below 1.2vmin linear-gradient(transparent 68%, rgba(0, 0, 0, .30));
    cursor: pointer;
  }
  .cf-card.center {
    border-color: var(--yellow, #F6FF4A);
    box-shadow: 0 0 3.4vmin color-mix(in srgb, var(--green-glow, #7CFF4F) 55%, transparent), 0 2vmin 5vmin rgba(0, 0, 0, .75);
  }
  .cf-art { width: 100%; height: 100%; object-fit: cover; image-rendering: pixelated; display: block; }
  .cf-video {
    position: absolute; inset: 0; width: 100%; height: 100%; display: block;
    border: 0; background: #000;
    /* Click-through: the card under it stays the thing a press launches. */
    pointer-events: none;
  }
  .cf-play {
    position: absolute; right: 5%; bottom: 3.5%;
    width: 22%; aspect-ratio: 1; display: grid; place-items: center;
    border-radius: 50%; background: rgba(0, 0, 0, .55);
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55));
    color: var(--green, #9CFF6B); font-size: clamp(8px, 1.5vmin, 12px);
    text-shadow: 0 0 8px var(--green-glow, #7CFF4F); pointer-events: none;
  }
  .cf-fav {
    /* Diagonally opposite the ▶ chip, so a card with a video wears one
       affordance per bottom corner instead of stacking them on one edge. */
    position: absolute; left: 5%; bottom: 3.5%;
    width: 22%; aspect-ratio: 1; display: grid; place-items: center;
    border-radius: 50%; background: rgba(0, 0, 0, .55);
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55));
    color: var(--green, #9CFF6B); font-size: clamp(9px, 1.7vmin, 13px);
    padding: 0; appearance: none; cursor: pointer; line-height: 1;
  }
  .cf-fav:hover { color: var(--yellow, #F6FF4A); border-color: var(--yellow, #F6FF4A); }
  .cf-fav.on {
    color: var(--yellow, #F6FF4A); border-color: var(--yellow, #F6FF4A);
    text-shadow: 0 0 10px color-mix(in srgb, var(--yellow, #F6FF4A) 70%, transparent);
  }
  .cf-fav.is-static { width: 16%; opacity: .85; pointer-events: none; }

  .cf-ph {
    width: 100%; height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 1.6vmin; padding: 8%;
    box-sizing: border-box; text-align: center;
    background:
      linear-gradient(160deg, rgba(120, 255, 90, .12), transparent 42%),
      linear-gradient(180deg, #101c10, #060b06 78%);
  }
  .cf-ph-mark, .cf-ph-foot { font-family: 'Share Tech Mono', monospace; font-size: clamp(7px, 1.3vmin, 10px); letter-spacing: .3em; opacity: .5; }
  .cf-ph-title {
    font-weight: 700; font-size: clamp(10px, 2vmin, 15px); line-height: 1.35;
    letter-spacing: .08em; overflow-wrap: anywhere;
    text-shadow: 0 0 10px color-mix(in srgb, var(--green-glow, #7CFF4F) 60%, transparent);
  }

  .sav-caption { text-align: center; padding: 1vmin 0 0; }
  .sav-name { font-weight: 700; font-size: clamp(12px, 2.4vmin, 18px); letter-spacing: .1em; text-shadow: 0 0 14px color-mix(in srgb, var(--green-glow, #7CFF4F) 50%, transparent); }
  .sav-name .ja { font-weight: 500; opacity: .85; }
  .sav-meta {
    display: flex; justify-content: center; gap: 2.4vmin; margin-top: .6vmin;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(9px, 1.7vmin, 12px);
    letter-spacing: .14em; opacity: .65;
  }
  .sav-counter { color: var(--yellow, #F6FF4A); opacity: .9; }

  .sav-foot {
    display: flex; align-items: center; gap: 18px; padding-top: 1.4vmin;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(9px, 1.6vmin, 11px);
    letter-spacing: .12em; text-transform: uppercase; opacity: .7;
  }
  .sav-foot b {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2.6vmin; height: 2.6vmin; min-width: 16px; min-height: 16px;
    margin-right: 6px; border-radius: 50%;
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55));
    font-size: .85em;
  }
  .sav-foot-hint { margin-left: auto; text-transform: none; }
</style>
