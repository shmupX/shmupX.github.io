// tileset-extractor.js — the TILESET EXTRACTOR tab.
//
// A port of André Michelle's Online Tileset Extractor
// (easierbycode.com/tileset-extractor): take a level screenshot, cut it on a
// grid, keep every distinct tile once (a tolerance lets near-identical tiles
// merge), and hand back the unique tiles as one sheet plus the map of which
// tile went where. What is added here:
//
//   - margin / spacing (padding) and a free grid OFFSET, so a screenshot with
//     a HUD strip or a sheet with gutters still lines up — drag the grid on
//     the image, nudge it with the arrow keys, or type the offset;
//   - a live cut: the tiles under the current grid, redrawn as it moves, so
//     alignment is checked by eye before the (slow) extraction runs;
//   - cells the image edge cuts through are skipped rather than refused;
//   - "OPEN AS MAP" — the result becomes a Tiled map in the MAP EDITOR tab.
//
// The comparison runs in a Worker built from a Blob (no extra file to
// serve); it is the original's algorithm with the geometry generalised.

const $ = (id) => document.getElementById(id);

const WORKER_SRC = `
self.onmessage = function (event) {
  var d = event.data;
  if (d.action === "extract") extract(d);
};
function extract(d) {
  var src = d.imageData.data, W = d.imageData.width;
  var tw = d.tileWidth, th = d.tileHeight, tol = d.tolerance;
  var cells = d.cells; // [{x, y}] top-left of every cell to cut, in map order
  var start = Date.now();
  var tiles = [];
  var map = new Array(cells.length);
  function cut(c) {
    var out = new Uint8ClampedArray(tw * th * 4);
    var o = 0;
    for (var y = 0; y < th; y++) {
      var s = ((c.y + y) * W + c.x) << 2;
      for (var x = 0; x < tw * 4; x++) out[o++] = src[s++];
    }
    return out;
  }
  function same(tile, c) {
    var diff = 0, o = 0;
    for (var y = 0; y < th; y++) {
      var s = ((c.y + y) * W + c.x) << 2;
      for (var x = 0; x < tw * 4; x++) {
        diff += Math.abs(tile[o++] - src[s++]);
        if (diff > tol) return false;
      }
    }
    return true;
  }
  self.postMessage({ action: "start" });
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    var found = -1;
    for (var t = 0; t < tiles.length; t++) {
      if (same(tiles[t], c)) { found = t; break; }
    }
    if (found < 0) { tiles.push(cut(c)); found = tiles.length - 1; }
    map[i] = found;
    if ((i & 31) === 0) self.postMessage({ action: "progress", progress: i / cells.length });
  }
  self.postMessage({ action: "result", tiles: tiles, map: map, time: Date.now() - start });
}
`;

const ZOOMS = [1, 2, 3, 4, 6];

export function initTilesetExtractor({ openAsMap, setStatus }) {
  const canvas = $("exCanvas");
  const overlay = $("exOverlay");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const octx = overlay.getContext("2d");

  let source = null; // HTMLImageElement
  let imageData = null;
  let zoom = 2;
  let worker = null;
  let result = null; // { tiles: Uint8ClampedArray[], map: number[], cols, rows, tw, th, sheet: canvas, recreation: canvas, sheetCols, sheetRows }
  let dragging = null;

  const num = (id, fallback) => {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) ? v : fallback;
  };

  function params() {
    return {
      tw: Math.max(4, num("exTileW", 16)),
      th: Math.max(4, num("exTileH", 16)),
      margin: Math.max(0, num("exMargin", 0)),
      spacing: Math.max(0, num("exSpacing", 0)),
      offX: num("exOffX", 0),
      offY: num("exOffY", 0),
      tolerance: Math.max(0, num("exTolerance", 0)) * 1024,
    };
  }

  // Every cell fully inside the image, in reading order, plus the grid size.
  function gridCells(p) {
    if (!source) return { cells: [], cols: 0, rows: 0 };
    const x0 = p.offX + p.margin, y0 = p.offY + p.margin;
    const stepX = p.tw + p.spacing, stepY = p.th + p.spacing;
    const cols = Math.max(0, Math.floor((source.width - x0 + p.spacing) / stepX));
    const rows = Math.max(0, Math.floor((source.height - y0 + p.spacing) / stepY));
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + c * stepX, y = y0 + r * stepY;
        if (x < 0 || y < 0 || x + p.tw > source.width || y + p.th > source.height) continue;
        cells.push({ x, y, c, r });
      }
    }
    return { cells, cols, rows, x0, y0, stepX, stepY };
  }

  function applyZoom() {
    if (!source) return;
    canvas.style.width = `${source.width * zoom}px`;
    canvas.style.height = `${source.height * zoom}px`;
    overlay.style.width = `${source.width * zoom}px`;
    overlay.style.height = `${source.height * zoom}px`;
    $("exZoomBtn").textContent = `ZOOM: ${zoom}x`;
  }

  function drawGrid() {
    if (!source) return;
    const p = params();
    const g = gridCells(p);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    // Lines at the tile edges; with spacing every tile is its own box.
    octx.lineWidth = 1;
    if (p.spacing === 0) {
      octx.strokeStyle = "rgba(246,255,74,.55)";
      octx.beginPath();
      for (let c = 0; c <= g.cols; c++) {
        const x = g.x0 + c * g.stepX + 0.5;
        octx.moveTo(x, g.y0);
        octx.lineTo(x, g.y0 + g.rows * g.stepY);
      }
      for (let r = 0; r <= g.rows; r++) {
        const y = g.y0 + r * g.stepY + 0.5;
        octx.moveTo(g.x0, y);
        octx.lineTo(g.x0 + g.cols * g.stepX, y);
      }
      octx.stroke();
    } else {
      octx.strokeStyle = "rgba(246,255,74,.5)";
      for (const c of g.cells) octx.strokeRect(c.x + 0.5, c.y + 0.5, p.tw - 1, p.th - 1);
    }
    // Origin marker.
    octx.fillStyle = "rgba(246,255,74,.9)";
    octx.fillRect(g.x0 - 1, g.y0 - 1, 3, 3);
    $("exInfo").textContent = `${source.width}×${source.height} · GRID ${g.cols}×${g.rows} · ${g.cells.length} CELLS · ORIGIN ${g.x0},${g.y0}`;
    drawLiveCut(p, g);
  }

  // Up to 64 cells under the grid, cut live — the eye test for alignment.
  // They are taken from the part of the image scrolled into view (falling
  // back to the first cells), so scrolling to a busy area shows its tiles.
  function drawLiveCut(p, g) {
    const wrap = $("exLiveCut");
    wrap.innerHTML = "";
    if (!g.cells.length) {
      wrap.innerHTML = '<div class="sx-empty-hint" style="grid-column:1/-1">NO WHOLE CELLS UNDER THE GRID</div>';
      return;
    }
    const cont = $("exContainer");
    const vx = Math.max(0, (cont.scrollLeft - 16) / zoom), vy = Math.max(0, (cont.scrollTop - 16) / zoom);
    const vw = cont.clientWidth / zoom, vh = cont.clientHeight / zoom;
    let show = g.cells.filter((c) => c.x + p.tw > vx && c.x < vx + vw && c.y + p.th > vy && c.y < vy + vh);
    if (!show.length) show = g.cells;
    show = show.slice(0, 64);
    for (const c of show) {
      const t = document.createElement("canvas");
      t.width = p.tw;
      t.height = p.th;
      t.getContext("2d").drawImage(source, c.x, c.y, p.tw, p.th, 0, 0, p.tw, p.th);
      t.title = `cell ${c.c},${c.r} @ ${c.x},${c.y}`;
      wrap.appendChild(t);
    }
    $("exCutInfo").textContent = `${g.cells.length} whole cell${g.cells.length === 1 ? "" : "s"} of ${p.tw}×${p.th}${g.cells.length > 64 ? " — first 64 shown" : ""}. Drag the grid until the edges land on tile boundaries, then EXTRACT.`;
  }

  async function loadSource(src, label) {
    reset();
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("could not load " + label));
      img.src = src;
    });
    source = img;
    canvas.width = img.width;
    canvas.height = img.height;
    overlay.width = img.width;
    overlay.height = img.height;
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, img.width, img.height);
    zoom = img.width > 2000 ? 1 : 2;
    applyZoom();
    $("exDims").textContent = `${img.width}×${img.height}`;
    $("btnExtract").disabled = false;
    drawGrid();
    setStatus(`EXTRACTOR · ${label.toUpperCase()} · ${img.width}×${img.height}`);
  }

  function reset() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    result = null;
    $("exProgress").hidden = true;
    $("exStats").textContent = "";
    for (const id of ["btnOpenAsMap", "btnDlTiles", "btnDlMap", "btnDlTmx", "btnDlRecreation"]) $(id).disabled = true;
    for (const id of ["exTilesCanvas", "exRecreationCanvas"]) {
      const c = $(id);
      c.width = 1;
      c.height = 1;
    }
  }

  function extract() {
    if (!source || !imageData) return;
    const p = params();
    const g = gridCells(p);
    if (!g.cells.length) {
      setStatus("EXTRACTOR · NO WHOLE CELLS UNDER THE GRID");
      return;
    }
    if (worker) worker.terminate();
    result = null;
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
    worker.onmessage = (ev) => {
      const d = ev.data;
      if (d.action === "start") {
        $("exProgress").hidden = false;
        $("exProgress").value = 0;
      } else if (d.action === "progress") {
        $("exProgress").value = Math.min(1, d.progress);
      } else if (d.action === "result") {
        $("exProgress").hidden = true;
        finish(p, g, d.tiles, d.map, d.time);
        worker.terminate();
        worker = null;
      }
    };
    worker.postMessage({
      action: "extract",
      tileWidth: p.tw,
      tileHeight: p.th,
      tolerance: p.tolerance,
      cells: g.cells.map((c) => ({ x: c.x, y: c.y })),
      imageData,
    });
    setStatus(`EXTRACTING ${g.cells.length} CELLS…`);
  }

  function finish(p, g, tiles, map, time) {
    // The map is over the FULL grid; cells the image edge cut are 0 (empty),
    // extracted ones are index + 1 so 0 can mean "nothing".
    const full = new Array(g.cols * g.rows).fill(0);
    g.cells.forEach((c, i) => {
      full[c.r * g.cols + c.c] = map[i] + 1;
    });
    // As square a sheet as the count allows (the original's rule).
    const sheetRows = Math.max(1, Math.floor(Math.sqrt(tiles.length)));
    const sheetCols = Math.ceil(tiles.length / sheetRows);
    const sheet = document.createElement("canvas");
    sheet.width = sheetCols * p.tw;
    sheet.height = sheetRows * p.th;
    const sctx = sheet.getContext("2d");
    tiles.forEach((t, i) => {
      sctx.putImageData(new ImageData(t, p.tw, p.th), (i % sheetCols) * p.tw, Math.floor(i / sheetCols) * p.th);
    });
    const recreation = document.createElement("canvas");
    recreation.width = g.cols * p.tw;
    recreation.height = g.rows * p.th;
    const rctx = recreation.getContext("2d");
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const id = full[r * g.cols + c];
        if (!id) continue;
        rctx.putImageData(new ImageData(tiles[id - 1], p.tw, p.th), c * p.tw, r * p.th);
      }
    }
    result = { tiles, map: full, cols: g.cols, rows: g.rows, tw: p.tw, th: p.th, sheet, recreation, sheetCols, sheetRows };
    const tc = $("exTilesCanvas");
    tc.width = sheet.width;
    tc.height = sheet.height;
    tc.getContext("2d").drawImage(sheet, 0, 0);
    const rc = $("exRecreationCanvas");
    rc.width = recreation.width;
    rc.height = recreation.height;
    rc.getContext("2d").drawImage(recreation, 0, 0);
    $("exStats").textContent = `${tiles.length} UNIQUE OF ${g.cells.length} · ${time}ms`;
    for (const id of ["btnOpenAsMap", "btnDlTiles", "btnDlMap", "btnDlTmx", "btnDlRecreation"]) $(id).disabled = false;
    setStatus(`EXTRACTED ${tiles.length} UNIQUE TILES FROM ${g.cells.length} CELLS IN ${time}MS`);
  }

  // The result as a Tiled map + embedded tileset, the shape the MAP EDITOR
  // (and mario-sp, spriteX) already read.
  function toTiled(name) {
    const r = result;
    return {
      type: "map",
      version: "1.10",
      orientation: "orthogonal",
      renderorder: "right-down",
      infinite: false,
      width: r.cols,
      height: r.rows,
      tilewidth: r.tw,
      tileheight: r.th,
      nextlayerid: 2,
      nextobjectid: 1,
      layers: [{
        id: 1,
        name: "tiles",
        type: "tilelayer",
        visible: true,
        opacity: 1,
        x: 0,
        y: 0,
        width: r.cols,
        height: r.rows,
        data: r.map.slice(),
      }],
      tilesets: [{
        firstgid: 1,
        name: name || "tiles",
        image: "tiles.png",
        imagewidth: r.sheet.width,
        imageheight: r.sheet.height,
        tilewidth: r.tw,
        tileheight: r.th,
        margin: 0,
        spacing: 0,
        columns: r.sheetCols,
        tilecount: r.tiles.length,
      }],
    };
  }

  function toTmx() {
    const r = result;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const rowsCsv = [];
    for (let y = 0; y < r.rows; y++) rowsCsv.push(r.map.slice(y * r.cols, (y + 1) * r.cols).join(","));
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<map version="1.10" orientation="orthogonal" renderorder="right-down" width="${r.cols}" height="${r.rows}" tilewidth="${r.tw}" tileheight="${r.th}" nextlayerid="2" nextobjectid="1">\n` +
      ` <tileset firstgid="1" name="${esc("tiles")}" tilewidth="${r.tw}" tileheight="${r.th}" tilecount="${r.tiles.length}" columns="${r.sheetCols}">\n` +
      `  <image source="tiles.png" width="${r.sheet.width}" height="${r.sheet.height}"/>\n` +
      " </tileset>\n" +
      ` <layer id="1" name="tiles" width="${r.cols}" height="${r.rows}">\n` +
      '  <data encoding="csv">\n' + rowsCsv.join(",\n") + "\n  </data>\n" +
      " </layer>\n</map>\n";
  }

  function download(name, content, type) {
    const a = document.createElement("a");
    const url = content instanceof Blob ? URL.createObjectURL(content) : content;
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (content instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- grid drag / nudge ----
  overlay.addEventListener("pointerdown", (ev) => {
    if (!source) return;
    ev.preventDefault();
    overlay.setPointerCapture(ev.pointerId);
    dragging = { x: ev.clientX, y: ev.clientY, offX: params().offX, offY: params().offY };
    overlay.style.cursor = "grabbing";
  });
  overlay.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const p = params();
    const stepX = p.tw + p.spacing, stepY = p.th + p.spacing;
    // The grid is periodic: an offset is only meaningful modulo one step.
    let ox = dragging.offX + Math.round((ev.clientX - dragging.x) / zoom);
    let oy = dragging.offY + Math.round((ev.clientY - dragging.y) / zoom);
    ox = ((ox % stepX) + stepX) % stepX;
    oy = ((oy % stepY) + stepY) % stepY;
    $("exOffX").value = ox;
    $("exOffY").value = oy;
    drawGrid();
  });
  const endDrag = () => {
    dragging = null;
    overlay.style.cursor = "grab";
  };
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);
  let scrollTimer = 0;
  $("exContainer").addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (source) drawLiveCut(params(), gridCells(params()));
    }, 120);
  });

  for (const id of ["exTileW", "exTileH", "exMargin", "exSpacing", "exOffX", "exOffY", "exTolerance"]) {
    $(id).addEventListener("input", drawGrid);
  }
  $("exZoomBtn").addEventListener("click", () => {
    zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length];
    applyZoom();
  });
  $("btnExtract").addEventListener("click", extract);
  $("exFileInput").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) loadSource(URL.createObjectURL(f), f.name);
    ev.target.value = "";
  });
  $("btnDemoMario").addEventListener("click", () => loadSource("demo/mario.png", "demo · mario"));
  $("btnDemoZelda").addEventListener("click", () => loadSource("demo/zelda.png", "demo · zelda"));
  $("btnOpenAsMap").addEventListener("click", () => {
    if (!result) return;
    openAsMap({ map: toTiled("extracted"), png: result.sheet.toDataURL("image/png"), name: "extracted" });
  });
  $("btnDlTiles").addEventListener("click", () => result && download("tiles.png", result.sheet.toDataURL("image/png")));
  $("btnDlRecreation").addEventListener("click", () => result && download("tilemap.png", result.recreation.toDataURL("image/png")));
  $("btnDlMap").addEventListener("click", () => {
    if (!result) return;
    download("map.json", new Blob([JSON.stringify({ map: result.map.map((v) => v - 1), numCols: result.cols, numRows: result.rows, tiled: toTiled("tiles") })], { type: "application/json" }));
  });
  $("btnDlTmx").addEventListener("click", () => result && download("tiled.tmx", new Blob([toTmx()], { type: "text/xml" })));

  // Files dropped on the tab load as the source image.
  const panel = $("extractPanel");
  ["dragenter", "dragover"].forEach((n) => panel.addEventListener(n, (ev) => ev.preventDefault()));
  panel.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) loadSource(URL.createObjectURL(f), f.name);
  });

  return {
    loadSource,
    extract,
    nudge(dx, dy) {
      if (!source) return;
      $("exOffX").value = params().offX + dx;
      $("exOffY").value = params().offY + dy;
      drawGrid();
    },
    getResult: () => result,
    getParams: params,
    getGrid: () => gridCells(params()),
  };
}
