# Pixel Composer — sprite voxelizer service

Turns 2D sprite frames into voxelized versions: every opaque pixel becomes a
shaded 3D cube column rendered to PNG (optionally a MagicaVoxel `.vox` model).
Lives at `/pixel-composer/`, styled like the rest of the CMG workbench, and
doubles as a postMessage service for SpriteX and the Level Editor.

## Files

- `pixel-composer.js` — dependency-free engine (`window.PixelComposerEngine`)
  plus the `installBridge()` postMessage service. Also bundled inside
  `static/cmg-net-downloads/spritex.zip` so SpriteX voxelizes offline.
- `pc-client.js` — requester helper (`window.CMGPixelComposer`). Uses the
  engine in-process when bundled, otherwise talks to a hidden
  `/pixel-composer/` iframe.
- `spritex-addon.js` — SpriteX UI hook (VOXELIZE buttons on the EXTRACT and
  VIEW docks; results land in PACKER · UPLOADED SPRITES). Shipped inside the
  spritex zip.
- `index.html` — standalone workbench (drop frames, tune the rig, download
  PNG/.vox) and the iframe service page.

## Protocol

Requester → composer window:

```js
{ type: 'pixel-composer-voxelize', requestId, frames: [{ name, dataURL }], options }
```

Composer → requester (`e.source`):

```js
{ type: 'pixel-composer-ready' }                    // on boot
{ type: 'pixel-composer-voxelize-ack', requestId }  // request received
{ type: 'pixel-composer-voxelize-result', requestId, ok,
  frames: [{ name, dataURL, w, h, views?, vox? }],  // name = <source>_voxel
  errors: [{ name, error }], error? }
```

Clients re-post the request every 500ms until the ack arrives (the launcher's
spritex-preload delivery idiom) — the service page may still be loading.

### Options (all optional, clamped by the service)

| option           | default   | range                | meaning                                   |
| ---------------- | --------- | -------------------- | ----------------------------------------- |
| `mode`           | `extrude` | `extrude`/`heightmap`| uniform depth vs luminance → column height |
| `depth`          | 6         | 1–32                 | extrusion depth in voxels                  |
| `pixelSize`      | 4         | 1–12                 | rendered voxel edge in px                  |
| `yaw`, `pitch`   | 30, 30    | ±360, 0–80           | camera orbit angles (degrees)              |
| `turntable`      | 0         | 0, 2–16              | N evenly spaced yaw views per frame        |
| `outline`        | false     | bool                 | 1px dark silhouette outline                |
| `alphaThreshold` | 8         | 1–255                | source alpha below this is empty           |
| `vox`            | false     | bool                 | attach a MagicaVoxel `.vox` (base64)       |

Caps: 64 frames / 24 MB per request, 128×128 px per frame.

## Usage from an app

```html
<script src="/pixel-composer/pc-client.js"></script>
```

```js
const res = await CMGPixelComposer.voxelize(
  [{ name: 'enemyA_0', canvas }],          // or { name, dataURL }
  { depth: 6, pixelSize: 3, turntable: 8 }
);
// res.frames[0].views → 8 rotated renders
```

- **Level Editor** (`/editor/`): SPRITES browser modal → select frames →
  “⬢ Voxelize” → results join the atlas as `<name>_voxel` frames (repack to
  persist).
- **SpriteX**: EXTRACT/VIEW dock → “⬢ VOXELIZE SELECTED” → results appear
  under PACKER · UPLOADED SPRITES.
