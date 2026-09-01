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
    // The alpha rail's rows — [{ key, at, n }], already ordered by `at`, every
    // `at` a real index into `items`. Derived on the Dashboard side so the
    // gamepad steps the same bands the rail draws.
    bands = [],
    query = '',
    findOpen = false,
    onfav = () => {},
    onselect = () => {},
    onlaunch = () => {},
    onclose = () => {},
    onquery = () => {},
    onfind = () => {},
    onescape = () => {},
    onband = () => {},
    onscrub = () => {},
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
  // A filter can shrink `items` a frame before the owner re-points `sel` at it.
  // Rendering off the raw prop for that one frame gives lo > hi — a blank stage
  // with a "051 / 003" counter and no empty-state note to explain it.
  let selC = $derived(Math.max(0, Math.min(items.length - 1, sel)));
  let visible = $derived.by(() => {
    const out = [];
    const lo = Math.max(0, selC - WINDOW), hi = Math.min(items.length - 1, selC + WINDOW);
    for (let i = lo; i <= hi; i++) out.push({ item: items[i], i, off: i - selC });
    return out;
  });
  let current = $derived(items[selC]);
  let curFav = $derived(!!current && favs.has(favId(current)));
  let counter = $derived(
    items.length
      ? String(selC + 1).padStart(3, '0') + ' / ' + String(items.length).padStart(3, '0')
      : '000 / 000'
  );
  // Which band the centred cover sits in — the last one starting at or before
  // it, bands being ordered by `at`. Lights the rail as the fan moves, however
  // the fan was moved.
  let bandSel = $derived.by(() => {
    let at = -1;
    for (let b = 0; b < bands.length; b++) {
      if (bands[b].at <= selC) at = b; else break;
    }
    return at;
  });

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
    drag = { id: e.pointerId, x: e.clientX, sel0: selC, moved: false };
    dragMoveFn = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x;
      if (Math.abs(dx) > 6) { drag.moved = true; dropPreview(); }
      const next = Math.max(0, Math.min(items.length - 1, drag.sel0 + Math.round(-dx / stepPx())));
      if (next !== selC) onselect(next);
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
  // Every plain <button> in the picker needs this: the Dashboard's window-level
  // onKey preventDefaults Enter and Space while the picker is open (they launch
  // the centred game), which cancels the button's own activation — a tabbed-to
  // ⌕ or ★ would launch a game instead of doing its job. stopPropagation keeps
  // the window handler out of it; no preventDefault, so native activation still
  // fires the onclick.
  function btnKey(e) {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
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
  // Tracked by the game's id, not its row number: a filter keystroke or a
  // favorite toggle re-points every index in `items`, and an index-keyed
  // preview would keep playing under whatever game inherited that slot.
  let previewId = $state('');
  let previewTimer = 0;
  let heldPreview = false;

  function previewSrc(id) {
    return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) +
      '?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1';
  }
  function armPreview(item, delay, hold) {
    if (!item?.video) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewId = favId(item);
      if (hold) heldPreview = true;
    }, delay);
  }
  function dropPreview() {
    clearTimeout(previewTimer);
    previewTimer = 0;
    previewId = '';
  }
  function cardEnter(e, v) {
    if (e.pointerType === 'mouse') armPreview(v.item, 320, false);
  }
  // Touch/pen: a hold is the hover. `heldPreview` marks the press as spent so
  // the release that ends the preview does not also launch the game.
  function cardDown(e, v) {
    if (e.pointerType === 'mouse') return;
    heldPreview = false;
    armPreview(v.item, 400, true);
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
    while (wheelAcc >= 40) { wheelAcc -= 40; if (selC < items.length - 1) onselect(selC + 1); }
    while (wheelAcc <= -40) { wheelAcc += 40; if (selC > 0) onselect(selC - 1); }
  }

  // ── alpha rail ──────────────────────────────────────────────────────────
  // A vertical A-Z index down the right edge: run a finger (or the mouse) down
  // it and the fan scrubs to that letter's first game. Deliberately its OWN
  // surface rather than a second axis on the stage drag — two gestures sharing
  // one element need an axis lock, and a lock that guesses wrong here teleports
  // you across 258 games with no undo.
  //
  // Absolute mapping: the rail IS the index, so the band under the finger is
  // the band you get, exactly like a phone contact list's A-Z strip.
  let railEl = $state(null);
  let railDrag = $state(null); // { id } while a pointer owns the rail
  let railHit = $state(-1);   // band under the finger, -1 = idle
  let railY = $state(0);      // bubble position, px from the rail's top

  function railBandAt(clientY) {
    if (!railEl || !bands.length) return -1;
    const r = railEl.getBoundingClientRect();
    if (!r.height) return -1;
    // Clamped both ends: a pointer captured past the rail runs the ratio past
    // 1 and floor() straight off the end of the array.
    const n = Math.floor(((clientY - r.top) / r.height) * bands.length);
    return Math.max(0, Math.min(bands.length - 1, n));
  }
  function railApply(clientY) {
    const b = railBandAt(clientY);
    if (b < 0) return;
    const r = railEl.getBoundingClientRect();
    railY = Math.max(0, Math.min(r.height, clientY - r.top));
    // Only on a change: onband runs through savPickerJump, which plays a nav
    // blip, and a sweep would otherwise machine-gun it frame by frame.
    if (b !== railHit) { railHit = b; onband(b); }
  }
  function onRailDown(e) {
    // Same primary-pointer / left-button contract as the stage drag: a resting
    // palm must not hijack a live scrub, and a right-click is the menu's.
    if (railDrag || e.isPrimary === false || !bands.length) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    railDrag = { id: e.pointerId };
    // Pointer capture rather than window listeners: it follows the finger off
    // the rail (the whole point of a scrub) and releases itself if the node
    // goes away mid-gesture, so there is nothing to leak.
    try { railEl.setPointerCapture(e.pointerId); } catch (_) { /* capture is a nicety */ }
    dropPreview();
    onscrub(true);
    railHit = -1;
    railApply(e.clientY);
  }
  function onRailMove(e) {
    if (!railDrag || e.pointerId !== railDrag.id) return;
    railApply(e.clientY);
  }
  function endRail(e) {
    if (!railDrag || (e && e.pointerId !== railDrag.id)) return;
    try { railEl?.releasePointerCapture(railDrag.id); } catch (_) { /* already gone */ }
    railDrag = null;
    railHit = -1;
    onscrub(false);
  }
  // Closing mid-scrub (Esc, gamepad B) hides the rail but leaves the capture
  // and the Dashboard's scrub flag set — which would keep cover prefetch off
  // for the rest of the session. Same reason endDrag() lives in this effect.
  $effect(() => {
    if (!open) endRail(null);
    return () => endRail(null);
  });

  // ── search ──────────────────────────────────────────────────────────────
  // Focus on mount rather than through an effect: the field only exists once
  // Svelte has flushed findOpen, and a later pass would land after iOS has
  // already decided not to raise the keyboard.
  function findMount(node) { node.focus(); }
  function onFindKey(e) {
    // The Dashboard's window handler bows out for text fields, so the keys the
    // field wants the picker to act on are answered here.
    if (e.key === 'Escape') { e.preventDefault(); onescape(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items.length) onlaunch(selC); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Step off the field and back onto the fan without losing the query.
      e.preventDefault();
      e.currentTarget.blur();
      stageEl?.focus();
    }
  }
</script>

{#if open}
  <div class="sav-scrim" aria-hidden="true" onpointerdown={onclose}></div>
  <div class="sav-picker" role="menu" aria-label="Saved games">
    <div class="sav-hd">
      <span class="sav-title">SAVED GAMES</span>
      <span class="sav-sub">.SAV SHELF // DEZAEMON 2</span>
      <span class="sav-count" role="status">
        {#if query}{items.length} MATCH{:else if items.length}{items.length} GAMES{/if}
      </span>
      <button
        type="button"
        class="sav-x {findOpen ? 'on' : ''}"
        aria-label={findOpen ? 'Close the filter' : 'Filter saved games'}
        aria-pressed={findOpen}
        onclick={onfind}
        onkeydown={btnKey}
      >⌕</button>
      <button type="button" class="sav-x" aria-label="Close" onclick={onclose} onkeydown={btnKey}>✕</button>
    </div>

    <!-- Its own full-width row rather than a slot in the header: packed into
         .sav-hd it pushed ✕ off the right edge of a 375px phone, and no amount
         of flex-shrink makes five fixed-size things fit one narrow line. -->
    {#if findOpen}
      <div class="sav-findbar">
        <input
          class="sav-find"
          type="search"
          value={query}
          placeholder="FILTER BY TITLE, MAKER, GENRE"
          aria-label="Filter saved games"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          use:findMount
          oninput={(e) => onquery(e.currentTarget.value)}
          onkeydown={onFindKey}
        />
      </div>
    {/if}

    {#if loading}
      <div class="sav-note">READING SHELF…</div>
    {:else if error}
      <div class="sav-note err">{error}</div>
    {:else if !items.length && query}
      <!-- A search miss and an unreachable shelf are both "no items"; only the
           query tells them apart, so the copy has to split on it. -->
      <div class="sav-note">
        NO MATCH FOR “{query}”
        <button type="button" class="sav-clear" onclick={() => onquery('')} onkeydown={btnKey}>CLEAR FILTER</button>
      </div>
    {:else if !items.length}
      <div class="sav-note">NO SAVED GAMES REACHABLE — the database could not be read and this build ships no .sav collection.</div>
    {:else}
      <!-- One row: the fan, then the rail beside it. The rail has to be a
           sibling of the stage rather than a child so the stage's overflow
           clip and its pointerdown-to-drag never reach it. -->
      <div class="sav-body">
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
              {#if previewId === favId(v.item) && v.item.video}
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
              {#if v.item.video && previewId !== favId(v.item)}
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
                  onkeydown={btnKey}
                  onpointerdown={(e) => e.stopPropagation()}
                >{curFav ? '★' : '☆'}</button>
              {:else if favs.has(favId(v.item))}
                <span class="cf-fav is-static on" aria-hidden="true">★</span>
              {/if}
            </div>
          {/each}
        </div>

        <div
          class="sav-rail {railDrag ? 'live' : ''}"
          bind:this={railEl}
          role="listbox"
          aria-label="Jump to letter"
          tabindex="-1"
          onpointerdown={onRailDown}
          onpointermove={onRailMove}
          onpointerup={endRail}
          onpointercancel={endRail}
          onlostpointercapture={endRail}
        >
          {#each bands as b, i (b.key)}
            <span class="sav-band {i === (railDrag ? railHit : bandSel) ? 'on' : ''}"
                  role="option" aria-selected={i === bandSel} aria-label="{b.key}, {b.n} games">{b.key}</span>
          {/each}
          <!-- Inside the rail so `top` is rail-relative, and to its left so a
               thumb on the right edge never covers what it is picking. -->
          {#if railDrag && bands[railHit]}
            <div class="sav-bub" style="top:{railY}px" aria-hidden="true">
              <span class="sav-bub-key">{bands[railHit].key}</span>
              <span class="sav-bub-sub">{items[bands[railHit].at]?.title || ''}</span>
            </div>
          {/if}
        </div>
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
      <span class="sav-foot-hint">← → browse · swipe the A–Z rail (or <b>[</b> <b>]</b> / right stick) to jump a letter · <b>/</b> filters · F favorites · hold a cover to preview · <b>Y</b> opens this shelf</span>
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

  /* One line, always. Everything but the subtitle is fixed-size; the subtitle
     is the only thing allowed to shrink, so a narrow phone truncates the
     decoration rather than pushing ✕ off the screen. */
  .sav-hd { display: flex; align-items: baseline; gap: clamp(7px, 1.6vmin, 14px); }
  .sav-title {
    flex: 0 0 auto; white-space: nowrap;
    font-weight: 800; letter-spacing: .26em; font-size: clamp(13px, 2.4vmin, 18px); text-shadow: 0 0 16px var(--green-glow, #7CFF4F);
  }
  .sav-sub, .sav-count {
    font-family: 'Share Tech Mono', monospace; font-size: clamp(9px, 1.6vmin, 12px);
    letter-spacing: .18em; opacity: .6; white-space: nowrap;
  }
  .sav-sub { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .sav-count { flex: 0 0 auto; margin-left: auto; }
  .sav-x {
    flex: 0 0 auto;
    appearance: none; border: 0; background: transparent; color: var(--green, #9CFF6B);
    opacity: .65; width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
    font-size: 15px; line-height: 1; align-self: center;
  }
  .sav-x:hover, .sav-x.on { opacity: 1; background: rgba(120, 255, 90, .12); }
  .sav-x.on { color: var(--yellow, #F6FF4A); }

  .sav-findbar { flex: 0 0 auto; display: flex; padding-top: 1.2vmin; }
  .sav-find {
    flex: 1; min-width: 0;
    appearance: none; -webkit-appearance: none;
    background: rgba(0, 0, 0, .5); color: var(--green, #9CFF6B);
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55)); border-radius: 6px;
    padding: .5em .7em; box-sizing: border-box;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(10px, 1.7vmin, 13px);
    letter-spacing: .14em; text-transform: uppercase;
  }
  .sav-find:focus { outline: none; border-color: var(--yellow, #F6FF4A); }
  .sav-find::placeholder { color: currentColor; opacity: .38; }
  /* The UA's own clear affordance draws a grey ✕ that reads as a stray pixel
     against the phosphor palette — the ⌕ toggle already clears the filter. */
  .sav-find::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }

  .sav-clear {
    display: block; margin: 2.2vmin auto 0;
    appearance: none; cursor: pointer;
    background: rgba(120, 255, 90, .1); color: var(--green, #9CFF6B);
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55)); border-radius: 6px;
    padding: .8em 1.6em;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(10px, 1.7vmin, 12px);
    letter-spacing: .18em;
  }
  .sav-clear:hover { color: var(--yellow, #F6FF4A); border-color: var(--yellow, #F6FF4A); }

  .sav-note {
    /* Column so the no-match note can hang a CLEAR FILTER button under itself
       instead of beside it. */
    flex: 1; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(11px, 2vmin, 14px);
    letter-spacing: .14em; opacity: .75; padding: 0 8vmin;
  }
  .sav-note.err { color: #ff9a7a; opacity: .95; }

  .sav-body { display: flex; flex: 1; min-height: 0; }
  .sav-stage {
    position: relative; flex: 1; min-width: 0; min-height: 0;
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

  /* The A-Z rail. touch-action: none because the whole gesture is ours — the
     browser's vertical pan would otherwise eat the scrub before pointermove
     ever fires. Sized like the footer's key chips so it stays a finger-wide
     target without a breakpoint. */
  .sav-rail {
    position: relative; flex: 0 0 auto;
    display: flex; flex-direction: column;
    width: max(6vmin, 30px);
    touch-action: none; cursor: pointer; user-select: none; -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  /* Every band an equal slice of the rail: railBandAt maps the finger by
     dividing the rail's height by the band count, so any other distribution
     would light one letter and jump to another. */
  .sav-band {
    flex: 1 1 0; min-height: 0; display: grid; place-items: center; line-height: 1;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(7px, 1.3vmin, 11px);
    letter-spacing: .06em; opacity: .5; pointer-events: none;
    transition: color .12s ease, opacity .12s ease, transform .12s ease;
  }
  .sav-band.on {
    color: var(--yellow, #F6FF4A); opacity: 1; transform: scale(1.5);
    text-shadow: 0 0 10px color-mix(in srgb, var(--yellow, #F6FF4A) 70%, transparent);
  }
  /* :not(.on) so this never outweighs .sav-band.on above — the descendant
     selector's extra compound would otherwise win on specificity and dim the
     one band the finger is actually on. */
  .sav-rail.live .sav-band:not(.on) { opacity: .75; }

  /* Left of the rail so a thumb on the edge never covers its own target. */
  .sav-bub {
    position: absolute; right: 100%; margin-right: 1.4vmin; transform: translateY(-50%);
    display: flex; align-items: baseline; gap: 1.4vmin;
    max-width: 46vw; padding: .8vmin 1.8vmin; box-sizing: border-box;
    border: 1px solid var(--yellow, #F6FF4A); border-radius: 8px;
    background: rgba(0, 0, 0, .82); pointer-events: none;
  }
  .sav-bub-key {
    font-weight: 800; font-size: clamp(20px, 6vmin, 44px); line-height: 1;
    color: var(--yellow, #F6FF4A);
    text-shadow: 0 0 16px color-mix(in srgb, var(--green-glow, #7CFF4F) 60%, transparent);
  }
  .sav-bub-sub {
    /* min-width:0 or the flex row refuses to shrink it and the ellipsis never
       kicks in — a long title would just push the bubble off-screen. */
    min-width: 0;
    font-family: 'Share Tech Mono', monospace; font-size: clamp(9px, 1.7vmin, 12px);
    letter-spacing: .1em; opacity: .7;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
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
    flex: 0 0 auto;
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
  /* Truncates instead of wrapping: wrapped, it grows upward into the A/B/X
     chips beside it. */
  .sav-foot-hint {
    flex: 0 1 auto; min-width: 0; margin-left: auto; text-transform: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
