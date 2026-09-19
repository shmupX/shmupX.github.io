<script>
  // The first-run offer to install the Linux AppImage — shown once, at boot,
  // to a player running shmupX straight from the file they downloaded.
  //
  // Like Osd.svelte and SavPicker.svelte this is a dumb renderer: the Dashboard
  // owns the verdict (static/steam-nudge.js), the selected row, the press, and
  // the remembered decision. Two rows and no state of its own, so keyboard,
  // gamepad and mouse all drive the one source of truth.
  let {
    open = false,
    sel = 0,
    headline = '',
    detail = '',
    restart = false,
    busy = false,
    onselect = () => {},
    onactivate = () => {},
    ondismiss = () => {},
  } = $props();

  // Enter/Space on a focused row is the browser's own click, so only the keys
  // the Dashboard does not already own need answering here — and it owns all
  // of them while this is up. Kept so a tab-focused row still feels like a
  // button to a screen reader.
  function rowKey(e) {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  }
</script>

{#if open}
  <div class="nudge-scrim" aria-hidden="true" onpointerdown={ondismiss}></div>
  <div class="nudge-wrap" role="dialog" aria-modal="true" aria-label={headline}>
    <div class="nudge-card">
      <span class="nudge-kicker">FIRST RUN</span>
      <h2 class="nudge-hd">{headline}</h2>
      <p class="nudge-detail">{detail}</p>
      {#if restart}
        <p class="nudge-warn">
          Steam is running — it rewrites its own shortcut list when it quits, so
          <b>restart Steam</b> to keep the new entry.
        </p>
      {/if}
      <div class="nudge-rows" role="menu">
        <button
          type="button" role="menuitem" class="nudge-row go {sel === 0 ? 'sel' : ''}"
          disabled={busy}
          onmouseenter={() => onselect(0)}
          onclick={onactivate}
          onkeydown={rowKey}
        >
          <span class="nudge-row-label">{busy ? 'INSTALLING…' : 'ADD TO STEAM'}</span>
          <span class="nudge-row-sub">installs it, then adds it to your library</span>
        </button>
        <button
          type="button" role="menuitem" class="nudge-row {sel === 1 ? 'sel' : ''}"
          onmouseenter={() => onselect(1)}
          onclick={ondismiss}
          onkeydown={rowKey}
        >
          <span class="nudge-row-label">NOT NOW</span>
          <span class="nudge-row-sub">Settings › ADD TO STEAM does this later</span>
        </button>
      </div>
      <span class="nudge-foot">↑ ↓ choose · <b>A</b> / <b>Enter</b> picks · <b>B</b> / <b>Esc</b> dismisses</span>
    </div>
  </div>
{/if}

<style>
  .nudge-scrim { position: fixed; inset: 0; z-index: 102; background: rgba(0, 0, 0, .72); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }

  .nudge-wrap {
    position: fixed; inset: 0; z-index: 103;
    display: flex; align-items: center; justify-content: center;
    padding: max(2.4vmin, 14px);
    box-sizing: border-box; pointer-events: none;
    color: var(--green, #9CFF6B); font-family: 'Orbitron', sans-serif;
    animation: nudgeIn .16s ease-out;
  }
  @keyframes nudgeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .nudge-wrap { animation: none; } }

  .nudge-card {
    pointer-events: auto;
    width: min(560px, 92vw); box-sizing: border-box;
    display: flex; flex-direction: column; gap: 10px;
    padding: max(2.6vmin, 20px);
    background: rgba(6, 12, 6, .94);
    border: 1px solid color-mix(in srgb, var(--green, #9CFF6B) 46%, transparent);
    border-radius: 10px;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .6), 0 18px 60px rgba(0, 0, 0, .7);
  }

  .nudge-kicker { font-size: 11px; letter-spacing: .28em; opacity: .62; }
  .nudge-hd { margin: 0; font-size: clamp(18px, 3.2vmin, 26px); letter-spacing: .1em; }
  .nudge-detail, .nudge-warn {
    margin: 0; font-family: 'Share Tech Mono', monospace;
    font-size: clamp(12px, 1.8vmin, 14px); line-height: 1.5; opacity: .82;
  }
  .nudge-warn { color: var(--amber, #FFC46B); opacity: .95; }

  .nudge-rows { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
  .nudge-row {
    display: flex; flex-direction: column; gap: 2px; text-align: left;
    padding: 12px 14px; cursor: pointer;
    color: inherit; font: inherit;
    background: rgba(156, 255, 107, .05);
    border: 1px solid color-mix(in srgb, var(--green, #9CFF6B) 24%, transparent);
    border-radius: 6px;
  }
  .nudge-row.sel {
    background: color-mix(in srgb, var(--green, #9CFF6B) 18%, transparent);
    border-color: var(--green, #9CFF6B);
  }
  .nudge-row.go.sel { box-shadow: 0 0 18px color-mix(in srgb, var(--green, #9CFF6B) 34%, transparent); }
  .nudge-row:disabled { cursor: progress; opacity: .6; }
  .nudge-row-label { font-size: clamp(13px, 2vmin, 15px); letter-spacing: .14em; }
  .nudge-row-sub {
    font-family: 'Share Tech Mono', monospace;
    font-size: clamp(10px, 1.5vmin, 12px); opacity: .68;
  }

  .nudge-foot {
    margin-top: 2px; font-family: 'Share Tech Mono', monospace;
    font-size: 11px; opacity: .55;
  }
  .nudge-foot b { color: var(--green, #9CFF6B); font-weight: 400; }
</style>
