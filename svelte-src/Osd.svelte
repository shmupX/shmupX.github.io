<script>
  // In-game OSD ("Guide") — the Tweaks-panel design from the Xbox Dashboard
  // handoff, re-skinned to the dashboard's green/Orbitron CRT aesthetic. It is a
  // dumb renderer: the Dashboard owns the item list, the selected index, and the
  // handlers (so gamepad/keyboard nav and touch/mouse share one source of truth).
  //
  // Under the XBOX 360 theme (theme === 'xbox360') the same item list renders as
  // the authentic Xbox-360 NXE "blades" Guide: a centered steel blue-gray panel
  // (the active blade) with the other sections peeking as vertical tabs on either
  // side, a green lit selection bar, a top status strip (battery / pad / avatar /
  // now-playing / clock) and a colored A/B footer legend below — matching the
  // 360 Guide reference. Navigation is unchanged: the expanded (center) panel
  // simply follows the group that owns the selected index.
  //
  // Item shape: { key, kind:'button'|'toggle'|'slider'|'color', label,
  //   section?, value?, options?(color), min?,max?,step?,unit?(slider) }
  let {
    open = false,
    items = [],
    sel = 0,
    theme = 'xbox',
    clock = '',
    title = '',
    // Footer open-chord hint — supplied by the Dashboard so it can advertise
    // the chord that actually works on the detected pad/platform (e.g.
    // SELECT + L2 on Android, where the SNES pad's D-pad doesn't report).
    hint = 'SELECT + ↓ · two-corner tap',
    onactivate = () => {},
    onsetvalue = () => {},
    onselect = () => {},
    onclose = () => {},
  } = $props();

  let blades = $derived(theme === 'xbox360');

  // 24h "HH:MM:SS" clock → 360-style 12-hour "H:MM AM/PM" for the status strip.
  let clock12 = $derived.by(() => {
    const m = /^(\d{1,2}):(\d{2})/.exec(clock || '');
    if (!m) return clock || '';
    let h = +m[1];
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m[2]} ${ap}`;
  });

  function rowClick(it, i) {
    onselect(i);
    // Buttons + toggles act on the row tap; slider/color have their own controls.
    if (it.kind === 'button' || it.kind === 'toggle') onactivate(i);
  }
  // Keyboard twin of rowClick: a row is click-focusable (tabindex="-1"), and a
  // role="menuitem" div synthesizes no click on Enter/Space. stopPropagation so
  // the Dashboard's window-level onKey doesn't activate the row a second time.
  function rowKey(it, i) {
    return (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      rowClick(it, i);
    };
  }

  // ── blade grouping ──────────────────────────────────────────────────────────
  // Fold the flat item list into [{ key, label, headerIndex, collapsed, rows }]
  // keeping each row's original index so every callback still speaks the
  // Dashboard's flat-index protocol.
  let groups = $derived.by(() => {
    const out = [];
    let cur = null;
    items.forEach((it, i) => {
      if (it.kind === 'section') {
        cur = { key: it.key, label: it.label, headerIndex: i, collapsed: !!it.collapsed, rows: [] };
        out.push(cur);
      } else {
        if (!cur) {
          cur = { key: '__pre', label: '', headerIndex: -1, collapsed: false, rows: [] };
          out.push(cur);
        }
        cur.rows.push({ it, i });
      }
    });
    return out;
  });

  // The expanded blade is whichever group owns the selection, so gamepad nav
  // slides between blades for free (arrowing past a blade's last row lands on
  // the next section header, which expands that blade).
  let activeGroup = $derived.by(() => {
    let a = 0;
    groups.forEach((g, gi) => {
      if (g.headerIndex === sel || g.rows.some((r) => r.i === sel)) a = gi;
    });
    return a;
  });

  function bladePick(gi) {
    const g = groups[gi];
    if (gi === activeGroup) return; // clicks inside the open blade are the rows'
    if (g.rows.length) onselect(g.rows[0].i);
    else if (g.headerIndex >= 0) {
      onselect(g.headerIndex);
      // A Dashboard-collapsed section has no rows in the list — opening its
      // blade should expand it, like tapping the header in the panel layout.
      if (g.collapsed) onactivate(g.headerIndex);
    }
  }

  // While the Music blade is expanded with a player toggled on, the Dashboard's
  // docked music sidebar hosts the only player iframe — reparenting it into the
  // blade would reload it and cut the audio. Instead the blade renders an empty
  // player slot, publishes its rect as --osd-music-* vars, and flags
  // body.osd-music-blade; dashboard.css lifts the sidebar into the slot. The
  // ResizeObserver keeps the rect fresh through the blade-expand transition.
  // Keep the selected row visible as gamepad/keyboard nav moves it — both
  // scrollable bodies (.osd-body in the panel skin, .blade-body in the 360
  // skin) clip long lists (cheats/plugins) and short viewports, and selection
  // is index-based rather than focus-based, so the browser won't scroll for us.
  $effect(() => {
    void sel;
    void items;
    if (!open) return;
    const el = document.querySelector('.osd-body .sel, .blade-body .sel, .blade-tab.sel');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  let playerSlot = $state(null);
  $effect(() => {
    const el = playerSlot;
    if (!el) {
      document.body.classList.remove('osd-music-blade');
      return;
    }
    const root = document.documentElement;
    const apply = () => {
      const r = el.getBoundingClientRect();
      root.style.setProperty('--osd-music-x', r.left + 'px');
      root.style.setProperty('--osd-music-y', r.top + 'px');
      root.style.setProperty('--osd-music-w', r.width + 'px');
      root.style.setProperty('--osd-music-h', r.height + 'px');
    };
    apply();
    document.body.classList.add('osd-music-blade');
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      document.body.classList.remove('osd-music-blade');
    };
  });
</script>

{#snippet row(it, i)}
  <div
    class="osd-row kind-{it.kind} {i === sel ? 'sel' : ''}"
    role="menuitem"
    tabindex="-1"
    onpointerenter={() => onselect(i)}
    onclick={() => rowClick(it, i)}
    onkeydown={rowKey(it, i)}
  >
    <span class="osd-lbl">{it.label}</span>

    {#if it.kind === 'button'}
      <span class="osd-chev" aria-hidden="true">▸</span>
    {:else if it.kind === 'toggle'}
      <span class="osd-toggle" data-on={it.value ? '1' : '0'} aria-hidden="true"><i></i></span>
    {:else if it.kind === 'slider'}
      <span class="osd-ctl" role="presentation" onclick={(e) => e.stopPropagation()}>
        <span class="osd-val">{it.value}{it.unit ?? ''}</span>
        <!-- it.commit sliders (cheats, which reload the game on apply)
             fire on change/drag-end only; live sliders (tweaks) on input. -->
        <input
          class="osd-slider"
          type="range"
          min={it.min} max={it.max} step={it.step}
          value={it.value}
          oninput={(e) => { if (!it.commit) onsetvalue(i, Number(e.currentTarget.value)); }}
          onchange={(e) => { if (it.commit) onsetvalue(i, Number(e.currentTarget.value)); }}
        />
      </span>
    {:else if it.kind === 'color'}
      <span class="osd-chips" role="presentation" onclick={(e) => e.stopPropagation()}>
        {#each it.options as opt (opt.hue)}
          <button
            type="button"
            class="osd-chip {opt.hue === it.value ? 'on' : ''}"
            style="background: {opt.hex}"
            aria-label={opt.hex}
            onclick={() => { onselect(i); onsetvalue(i, opt.hue); }}
          ></button>
        {/each}
      </span>
    {/if}
  </div>
{/snippet}

{#if open}
  <div class="osd-scrim {blades ? 'x360' : ''}" aria-hidden="true" onpointerdown={onclose}></div>

  {#if blades}
    <!-- Xbox 360 NXE Guide (Settings → Theme → XBOX 360). Centered steel panel
         (active blade) with the other sections peeking as side tabs. -->
    <div
      class="osd-blades"
      role="menu"
      aria-label="Guide"
      tabindex="-1"
      onpointerdown={(e) => { if (e.target === e.currentTarget) onclose(); }}
    >
      <!-- Top status strip — battery / pad / avatar / now-playing / clock. -->
      <div class="osd-guide-top">
        <div class="gt-left" aria-hidden="true">
          <span class="gt-batt"><i></i><i></i><i></i></span>
          <svg class="gt-pad" viewBox="0 0 28 18" width="24" height="15" aria-hidden="true">
            <rect x="1" y="4" width="26" height="11" rx="5.5" fill="currentColor" opacity=".9" />
            <circle cx="8" cy="9.5" r="2.3" fill="#1c2530" />
            <circle cx="20" cy="9.5" r="2.3" fill="#1c2530" />
          </svg>
        </div>
        <div class="gt-mid">
          <span class="gt-avatar" aria-hidden="true">🐵</span>
          {#if title}<span class="gt-track">{title}</span>{/if}
        </div>
        <div class="gt-clock">{clock12}</div>
      </div>

      <!-- Blade rack: side tabs + the centered active panel. -->
      <div class="blade-rack">
        {#each groups as g, gi (g.key)}
          <div
            class="blade {gi === activeGroup ? 'active' : ''}"
            role="presentation"
            onclick={() => bladePick(gi)}
          >
            <div class="blade-sheen" aria-hidden="true"></div>
            <button
              type="button"
              class="blade-tab {g.headerIndex === sel ? 'sel' : ''}"
              aria-expanded={gi === activeGroup && !g.collapsed ? 'true' : 'false'}
              onclick={(e) => {
                if (gi !== activeGroup) return; // let the blade's own pick handler run
                e.stopPropagation();
                if (g.headerIndex >= 0) { onselect(g.headerIndex); onactivate(g.headerIndex); }
              }}
            >
              {#if gi === activeGroup}<span class="blade-ring" aria-hidden="true"></span>{/if}
              <span class="blade-tab-txt">{g.label || 'Guide'}</span>
              {#if gi === activeGroup && g.headerIndex >= 0}
                <span class="blade-chev" data-collapsed={g.collapsed ? '1' : '0'} aria-hidden="true">▾</span>
              {/if}
            </button>
            {#if gi === activeGroup}
              <div class="blade-body" role="presentation" onclick={(e) => e.stopPropagation()}>
                {#each g.rows as r (r.it.key)}
                  {@render row(r.it, r.i)}
                {/each}
                {#if !g.rows.length}
                  <div class="blade-empty">{g.collapsed ? 'Press A to expand' : 'Nothing here yet'}</div>
                {/if}
                {#if g.rows.some((r) => r.it.music && r.it.value)}
                  <!-- The Dashboard's music sidebar is repositioned over this slot
                       (see the playerSlot effect) so the player renders inline. -->
                  <div class="blade-player-slot" bind:this={playerSlot} aria-hidden="true"></div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Shared footer legend below the rack (A green / B red), 360-style. -->
      <div class="osd-guide-foot">
        <span class="gf-btn"><b class="gf-a">A</b> Select</span>
        <span class="gf-btn"><b class="gf-b">B</b> Back</span>
        <span class="gf-hint">{hint}</span>
      </div>

      <button type="button" class="osd-blades-x" aria-label="Close" onclick={onclose}>✕</button>
    </div>
  {:else}
    <div class="osd-panel" role="menu" aria-label="Guide">
      <div class="osd-hd">
        <span class="osd-title">GUIDE</span>
        <button type="button" class="osd-x" aria-label="Close" onclick={onclose}>✕</button>
      </div>
      <div class="osd-body">
        {#each items as it, i (it.key)}
          {#if it.kind === 'section'}
            <!-- Collapsible section header: a real, navigable row. A / tap toggles
                 collapse; a collapsed section hides its child rows (see Dashboard). -->
            <button
              type="button"
              class="osd-sect {i === sel ? 'sel' : ''}"
              onpointerenter={() => onselect(i)}
              onclick={() => { onselect(i); onactivate(i); }}
              aria-expanded={it.collapsed ? 'false' : 'true'}
            >
              <span>{it.label}</span>
              <span class="osd-sect-chev" data-collapsed={it.collapsed ? '1' : '0'} aria-hidden="true">▾</span>
            </button>
          {:else}
            {@render row(it, i)}
          {/if}
        {/each}
      </div>
      <div class="osd-foot">
        <span><b>A</b> Select</span>
        <span><b>B</b> Close</span>
        <span class="osd-foot-hint">{hint}</span>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Dim the game behind the panel; tap-out closes. */
  .osd-scrim { position: fixed; inset: 0; z-index: 102; background: rgba(0, 0, 0, .45); }
  /* The 360 Guide sits on a darker, neutral top-lit scrim. */
  .osd-scrim.x360 { background: radial-gradient(120% 120% at 50% 0, rgba(10, 16, 22, .82), rgba(0, 0, 0, .93)); }

  .osd-panel {
    position: fixed; right: 2.4vmin; bottom: 2.4vmin; z-index: 103;
    width: min(340px, 88vw); max-height: min(76vh, 620px);
    display: flex; flex-direction: column; overflow: hidden;
    color: var(--ink); font-family: var(--font-display);
    background: linear-gradient(180deg, oklch(0.249 0.051 calc(var(--h) + 20) / 0.94), oklch(0.182 0.032 calc(var(--h) + 23) / 0.96));
    border: 1px solid var(--tile-edge, rgba(140, 255, 110, .55));
    border-radius: 12px;
    box-shadow: 0 0 38px oklch(0.793 0.202 calc(var(--h) + 16) / 0.3), inset 0 0 0 1px oklch(0.902 0.212 calc(var(--h) + 10) / 0.08);
    -webkit-backdrop-filter: blur(8px) saturate(140%);
    backdrop-filter: blur(8px) saturate(140%);
    animation: osdIn .16s ease-out;
  }
  @keyframes osdIn { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }

  .osd-hd {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 12px 10px 16px; border-bottom: 1px solid oklch(0.902 0.212 calc(var(--h) + 10) / 0.18);
  }
  .osd-title { font-weight: 800; letter-spacing: .28em; font-size: 14px; color: oklch(0.973 0.063 calc(var(--h) - 2)); text-shadow: 0 0 14px oklch(0.892 0.236 calc(var(--h) + 10) / 0.5); }
  .osd-x {
    appearance: none; border: 0; background: transparent; color: oklch(0.957 0.103 calc(var(--h) - 1) / 0.6);
    width: 26px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1;
  }
  .osd-x:hover { background: oklch(0.892 0.236 calc(var(--h) + 10) / 0.12); color: oklch(0.973 0.063 calc(var(--h) - 2)); }

  .osd-body { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: oklch(0.902 0.212 calc(var(--h) + 10) / 0.3) transparent; }
  .osd-sect {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
    appearance: none; border: 0; background: transparent; text-align: left; cursor: pointer;
    font-family: var(--font-mono); font-size: 10px; letter-spacing: .22em;
    text-transform: uppercase; color: oklch(0.925 0.165 calc(var(--h) + 6) / 0.5); padding: 8px 4px 4px;
    transition: color .15s ease, text-shadow .15s ease;
  }
  .osd-sect:first-child { padding-top: 2px; }
  .osd-sect:hover { color: oklch(0.940 0.135 calc(var(--h) + 3) / 0.8); }
  .osd-sect.sel { color: var(--yellow, #F6FF4A); text-shadow: 0 0 10px color-mix(in srgb, var(--select-hot) 40%, transparent); }
  .osd-sect-chev { font-size: 9px; opacity: .8; transition: transform .15s ease; }
  .osd-sect-chev[data-collapsed="1"] { transform: rotate(-90deg); }

  .osd-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 40px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid oklch(0.902 0.212 calc(var(--h) + 10) / 0.18);
    background: linear-gradient(180deg, oklch(0.686 0.163 calc(var(--h) + 17) / 0.08), color-mix(in srgb, var(--surface-hi) 40%, transparent));
    transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease;
  }
  .osd-row.sel {
    color: var(--select-ink); border-color: #fff36a;
    background: linear-gradient(180deg, #fffea1 0%, var(--yellow, #F6FF4A) 30%, #d8e640 70%, #a4b00b 100%);
    box-shadow: 0 0 22px color-mix(in srgb, var(--select-hot) 45%, transparent);
  }
  .osd-lbl { font-weight: 600; font-size: 14px; letter-spacing: .06em; white-space: nowrap; }
  .osd-chev { color: oklch(0.957 0.103 calc(var(--h) - 1) / 0.5); }
  .osd-row.sel .osd-chev { color: rgba(40, 30, 0, .6); }

  .osd-ctl { display: flex; align-items: center; gap: 8px; flex: 1; justify-content: flex-end; }
  .osd-val { font-family: var(--font-mono); font-size: 12px; color: oklch(0.957 0.103 calc(var(--h) - 1) / 0.7); min-width: 3em; text-align: right; }
  .osd-row.sel .osd-val { color: rgba(40, 30, 0, .7); }

  .osd-slider { appearance: none; -webkit-appearance: none; width: 100%; max-width: 150px; height: 4px; border-radius: 999px; background: oklch(0.902 0.212 calc(var(--h) + 10) / 0.25); outline: none; }
  .osd-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: oklch(0.973 0.063 calc(var(--h) - 2)); border: 1px solid oklch(0.689 0.158 calc(var(--h) + 16) / 0.8); box-shadow: 0 0 8px oklch(0.892 0.236 calc(var(--h) + 10) / 0.6); cursor: pointer; }
  .osd-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: oklch(0.973 0.063 calc(var(--h) - 2)); border: 1px solid oklch(0.689 0.158 calc(var(--h) + 16) / 0.8); }

  .osd-chips { display: flex; gap: 6px; }
  .osd-chip { width: 24px; height: 24px; border-radius: 6px; border: 1px solid rgba(0, 0, 0, .35); cursor: pointer; padding: 0; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink-hi) 15%, transparent); transition: transform .12s ease; }
  .osd-chip:hover { transform: translateY(-1px); }
  .osd-chip.on { box-shadow: 0 0 0 2px var(--ink-hi), 0 0 10px color-mix(in srgb, var(--ink-hi) 60%, transparent); }

  .osd-toggle { position: relative; width: 34px; height: 19px; border-radius: 999px; background: oklch(0.902 0.212 calc(var(--h) + 10) / 0.22); transition: background .15s ease; flex-shrink: 0; }
  .osd-toggle[data-on="1"] { background: oklch(0.763 0.182 calc(var(--h) + 18)); }
  .osd-toggle i { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: oklch(0.973 0.063 calc(var(--h) - 2)); box-shadow: 0 1px 2px rgba(0, 0, 0, .4); transition: transform .15s ease; }
  .osd-toggle[data-on="1"] i { transform: translateX(15px); }
  .osd-row.sel .osd-toggle { background: rgba(40, 30, 0, .25); }
  .osd-row.sel .osd-toggle[data-on="1"] { background: oklch(0.525 0.125 calc(var(--h) + 17)); }

  .osd-foot { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-top: 1px solid oklch(0.902 0.212 calc(var(--h) + 10) / 0.18); font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em; color: oklch(0.957 0.103 calc(var(--h) - 1) / 0.55); text-transform: uppercase; }
  .osd-foot b { color: oklch(0.973 0.063 calc(var(--h) - 2)); }
  .osd-foot-hint { margin-left: auto; opacity: .7; }

  /* ═══ Xbox 360 NXE Guide ═════════════════════════════════════════════════
     Authentic New Xbox Experience blades: a centered steel blue-gray panel
     (the active blade) with the other sections peeking as vertical tabs on
     either side, a bright green lit selection bar, a top status strip and a
     colored A/B footer legend below — matching the 360 Guide reference. */
  .osd-blades {
    position: fixed; inset: 0; z-index: 103;
    display: flex; flex-direction: column; align-items: center; justify-content: safe center;
    gap: 14px; padding: 20px; box-sizing: border-box; overflow-y: auto;
    font-family: 'Orbitron', sans-serif; color: #eef2f5;
    -webkit-tap-highlight-color: transparent;
    animation: osdIn .16s ease-out;
    /* steel panel + green selection tokens */
    --steel-hi: #5c6b78; --steel-mid: #3a444e; --steel-lo: #262f38;
    --panel-edge: rgba(214, 225, 235, .38);
    --tab-hi: #414d59; --tab-lo: #212a32;
    --sel-hi: #c6f06a; --sel-mid: #9fd63f; --sel-lo: #74b02a;
    --ink: #eef2f5; --muted: #a9b4be;
  }

  /* ── top status strip ── */
  .osd-guide-top {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    width: min(1000px, 94vw); padding: 0 6px;
    font-family: var(--font-mono); color: var(--muted); font-size: 13px;
  }
  .gt-left { display: flex; align-items: center; gap: 10px; }
  .gt-batt {
    position: relative; display: inline-flex; align-items: center; gap: 1.5px;
    width: 24px; height: 13px; padding: 2px; border-radius: 2px;
    border: 1px solid rgba(200, 214, 228, .55);
  }
  .gt-batt::after { content: ""; position: absolute; right: -3px; top: 3px; width: 2px; height: 5px; border-radius: 0 1px 1px 0; background: rgba(200, 214, 228, .55); }
  .gt-batt i { flex: 1; align-self: stretch; background: oklch(0.761 0.174 var(--h)); border-radius: 1px; }
  .gt-pad { color: rgba(200, 214, 228, .8); display: block; }
  .gt-mid { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .gt-avatar {
    width: 30px; height: 30px; flex-shrink: 0; border-radius: 6px;
    display: flex; align-items: center; justify-content: center; font-size: 18px;
    background: linear-gradient(180deg, #4a5560, #2a333c);
    border: 1px solid rgba(214, 225, 235, .3); box-shadow: 0 2px 6px rgba(0, 0, 0, .4);
  }
  .gt-track { color: #dfe6ec; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gt-clock { color: #eaf0f5; letter-spacing: .06em; flex-shrink: 0; }

  /* ── blade rack ── */
  /* justify-content:center keeps the whole cluster (side tabs + centered panel)
     centered with dark gutters at the far edges, like the NXE reference — the
     active panel has a bounded width (below) rather than filling the rack, so it
     stays centered no matter which section is open. */
  .blade-rack {
    display: flex; justify-content: center; gap: 5px; box-sizing: border-box;
    width: min(1000px, 94vw); height: clamp(360px, 58vh, 540px);
  }
  .blade {
    position: relative; flex: 0 0 52px; border-radius: 9px; overflow: hidden; cursor: pointer;
    /* NB: do NOT transition flex-basis — the active blade's width rides on it,
       and a flex-basis transition freezes mid-swap when two blades resize at
       once (the size ends up stuck on whichever opened first). Snap the size;
       ease only the cosmetics. */
    transition: background .2s ease, box-shadow .2s ease, border-radius .2s ease;
    display: flex; flex-direction: column;
    background: linear-gradient(180deg, var(--tab-hi) 0%, var(--tab-lo) 100%);
    border: 1px solid rgba(210, 222, 234, .16);
    box-shadow: 0 10px 26px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .12);
  }
  /* flex-basis is a plain 56vw (capped by max-width) — NOT clamp()/min()/max(),
     which can't interpolate against the inactive 52px and would freeze the
     .28s expand transition mid-swap. */
  .blade.active {
    flex: 0 1 56vw; min-width: 0; max-width: 760px; cursor: default; border-radius: 14px;
    background: linear-gradient(180deg, var(--steel-hi) 0%, var(--steel-mid) 40%, var(--steel-lo) 100%);
    border: 1px solid var(--panel-edge);
    box-shadow: 0 18px 50px rgba(0, 0, 0, .6), inset 0 1px 0 rgba(255, 255, 255, .28);
  }
  /* Glossy top-lit gradient over the blade. */
  .blade-sheen { position: absolute; inset: 0; pointer-events: none; border-radius: inherit; background: linear-gradient(180deg, rgba(255, 255, 255, .22), rgba(255, 255, 255, 0) 38%); }

  .blade-tab {
    appearance: none; border: 0; background: transparent; cursor: inherit;
    position: relative; flex: 0 0 auto; width: 100%;
    font-family: inherit; color: var(--ink); text-shadow: 0 1px 2px rgba(0, 0, 0, .55);
  }
  /* Inactive: rotated spine label (the "peek"). */
  .blade:not(.active) .blade-tab { display: flex; align-items: center; justify-content: center; height: 100%; padding: 12px 0; }
  .blade:not(.active) .blade-tab-txt {
    writing-mode: vertical-rl; transform: rotate(180deg);
    font-weight: 700; font-size: 13px; letter-spacing: .16em; text-transform: uppercase;
    color: #c7d0d8;
  }
  /* Active: slim left-aligned caption bar with an activity ring + collapse chevron. */
  .blade.active .blade-tab {
    cursor: pointer; display: flex; align-items: center; gap: 10px;
    padding: 13px 18px 9px; text-align: left;
  }
  .blade.active .blade-tab-txt { font-weight: 700; font-size: 13px; letter-spacing: .2em; text-transform: uppercase; color: #d3dbe2; }
  .blade.active .blade-tab.sel .blade-tab-txt { color: #eaf6d4; text-shadow: 0 0 12px rgba(160, 220, 90, .5), 0 1px 2px rgba(0, 0, 0, .5); }
  .blade-ring {
    width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0;
    border: 2px solid rgba(200, 230, 160, .35); border-top-color: var(--sel-mid);
    animation: bladeSpin 1.4s linear infinite;
  }
  @keyframes bladeSpin { to { transform: rotate(360deg); } }
  .blade-chev { margin-left: auto; font-size: 11px; opacity: .8; transition: transform .15s ease; color: #c7d0d8; }
  .blade-chev[data-collapsed="1"] { transform: rotate(-90deg); }

  .blade-body {
    position: relative; flex: 1 1 auto; overflow-y: auto;
    padding: 4px 12px 14px; display: flex; flex-direction: column; gap: 2px;
    scrollbar-width: thin; scrollbar-color: rgba(220, 230, 240, .3) transparent;
  }
  .blade-empty { opacity: .8; font-size: 14px; padding: 14px 8px; color: var(--muted); text-shadow: 0 1px 2px rgba(0, 0, 0, .4); }
  /* Placeholder the music sidebar is lifted onto; the card only shows for the
     instant before the sidebar snaps into place. */
  .blade-player-slot { flex: 1 1 auto; min-height: 200px; margin: 8px 4px 2px; border-radius: 10px; border: 1px solid rgba(210, 222, 234, .16); background: rgba(0, 0, 0, .3); }

  /* Rows: white on steel; the SELECTED row is the bright green lit bar. */
  .osd-blades .osd-row {
    flex-shrink: 0; min-height: 42px; margin: 0; padding: 9px 14px; gap: 12px;
    border: 0; border-radius: 6px; background: transparent; color: var(--ink);
    text-shadow: 0 1px 2px rgba(0, 0, 0, .5);
  }
  .osd-blades .osd-row:not(.sel):hover { background: rgba(255, 255, 255, .07); }
  .osd-blades .osd-row.sel {
    color: #21330a; text-shadow: none;
    background: linear-gradient(180deg, var(--sel-hi) 0%, var(--sel-mid) 42%, var(--sel-lo) 100%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .55), 0 0 18px rgba(150, 220, 70, .4);
  }
  .osd-blades .osd-lbl { font-size: 15px; font-weight: 600; letter-spacing: .04em; }
  .osd-blades .osd-row.sel .osd-lbl { font-weight: 700; }
  .osd-blades .osd-chev { color: rgba(230, 238, 245, .55); }
  .osd-blades .osd-row.sel .osd-chev { color: rgba(33, 51, 10, .7); }
  .osd-blades .osd-val { color: rgba(230, 238, 245, .8); }
  .osd-blades .osd-row.sel .osd-val { color: rgba(33, 51, 10, .8); }
  .osd-blades .osd-slider { background: rgba(220, 230, 240, .28); }
  .osd-blades .osd-slider::-webkit-slider-thumb { background: #eef2f5; border: 1px solid rgba(30, 40, 50, .8); box-shadow: 0 1px 3px rgba(0, 0, 0, .4); }
  .osd-blades .osd-slider::-moz-range-thumb { background: #eef2f5; border: 1px solid rgba(30, 40, 50, .8); }
  .osd-blades .osd-row.sel .osd-slider { background: rgba(33, 51, 10, .28); }
  .osd-blades .osd-toggle { background: rgba(255, 255, 255, .22); }
  .osd-blades .osd-toggle[data-on="1"] { background: #5aa832; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .35); }
  .osd-blades .osd-toggle i { background: #eef2f5; }
  .osd-blades .osd-row.sel .osd-toggle { background: rgba(33, 51, 10, .3); }
  .osd-blades .osd-row.sel .osd-toggle[data-on="1"] { background: #2f6d16; }

  /* ── footer legend (below the rack) ── */
  .osd-guide-foot {
    display: flex; align-items: center; gap: 22px;
    width: min(1000px, 94vw); padding: 0 8px;
    font-family: var(--font-mono); font-size: 12px; letter-spacing: .1em;
    text-transform: uppercase; color: rgba(220, 228, 236, .8);
  }
  .gf-btn { display: inline-flex; align-items: center; gap: 8px; }
  .gf-btn b {
    width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--font-display); font-weight: 800; font-size: 12px; color: var(--ink-hi);
    box-shadow: inset -1px -2px 6px rgba(0, 0, 0, .45), 0 0 10px rgba(0, 0, 0, .35);
  }
  .gf-a { background: radial-gradient(circle at 35% 30%, oklch(0.952 0.111 calc(var(--h) + 1)) 0%, oklch(0.801 0.188 calc(var(--h) + 7)) 26%, oklch(0.619 0.176 calc(var(--h) + 10)) 70%, oklch(0.329 0.093 calc(var(--h) + 11)) 100%); border: 1px solid oklch(0.848 0.164 calc(var(--h) + 8) / 0.7); }
  .gf-b { background: radial-gradient(circle at 35% 30%, #ffcaca 0%, #f0645a 26%, #c02a22 70%, #400a06 100%); border: 1px solid rgba(240, 140, 130, .7); }
  .gf-hint { margin-left: auto; opacity: .7; text-transform: none; letter-spacing: .06em; }

  .osd-blades-x {
    position: absolute; top: 22px; right: 26px; z-index: 5;
    width: 38px; height: 38px; border-radius: 50%; cursor: pointer;
    border: 1px solid rgba(210, 222, 234, .3); background: rgba(10, 16, 22, .5);
    color: #eef2f5; font-size: 17px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .osd-blades-x:hover { background: rgba(20, 28, 38, .7); }

  @media (max-width: 560px) {
    .blade-rack { height: clamp(320px, 64vh, 520px); }
    .gt-track { max-width: 30vw; }
  }
  /* Short / landscape viewports: let the rack shrink instead of forcing a 360px
     floor, so the status strip and A/B footer are never pushed off-screen (the
     column also scrolls via overflow-y:auto + safe centering as a backstop). */
  @media (max-height: 520px) {
    .blade-rack { height: clamp(220px, 74vh, 420px); }
  }
</style>
