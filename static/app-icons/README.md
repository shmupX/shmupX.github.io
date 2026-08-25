# Launcher app icons

The code-monkey mascot — 🐵 (U+1F435) on a **transparent** background. Every file
here is generated from one source by `scripts/gen-app-icons.py`, so don't
hand-edit them.

```
python3 scripts/gen-app-icons.py      # needs Pillow + Apple Color Emoji (macOS)
```

The glyph is rendered from Apple Color Emoji's largest bitmap strike (160px),
so 256/384/512 are upscaled — fine for a glossy emoji at icon sizes.

## Transparent vs. opaque

Backgrounds are transparent everywhere a platform can render alpha. **Two sets
can't be** and are flattened onto a muted leaf green (`#66994D`) — a deliberate,
unobtrusive backdrop that pairs with the brown/tan monkey:

- **iOS** rejects an alpha channel outright and flattens any transparency onto
  black on the Home Screen, so a truly transparent iOS icon is impossible.
- **PWA maskable** icons get masked to a shape by the launcher; transparent
  corners would punch holes, so they need a filled background.

## Files

| File | Size | BG | Use |
|------|------|----|-----|
| `icon-{16,32}.png` | 16, 32 | transparent | favicon |
| `icon-{48..152}.png` | 48,72,96,128,144,152 | transparent | web / PWA |
| `icon-180.png` | 180 | transparent | web PWA 180 (Safari uses `ios/icon-180`) |
| `icon-{192,256,384,512}.png` | 192–512 | transparent | PWA (192 & 512 required) |
| `maskable-{192,512}.png` | 192, 512 | opaque fill | PWA maskable (62% safe zone) |
| `launcher-{256,512}.png` | 256, 512 | transparent | Steam / desktop launcher |
| `cmg.ico` | 16–256 | transparent | Steam on Windows / favicon.ico |
| `android/<density>.png` | 36–192 | transparent | Cordova mipmap buckets |
| `android/playstore-512.png` | 512 | transparent | Play Store listing |
| `ios/icon-<px>.png` | 20–1024 | opaque fill | Cordova iOS app icons |

## Steam (the launcher binary)

The Linux AppImage build (`scripts/build-appimage.ts`) already embeds
`launcher-256.png` as its `.DirIcon`/desktop icon, so when the AppImage is added
to Steam as a non-Steam game it shows the monkey automatically. To set it by
hand on any shortcut: **Properties → click the icon** and choose
`launcher-512.png` (macOS/Linux) or `cmg.ico` (Windows).

## PWA

Serve `/app-icons/manifest.webmanifest` and add to your `<head>`:

```html
<link rel="manifest" href="/app-icons/manifest.webmanifest" />
<link rel="icon" href="/app-icons/icon-32.png" sizes="32x32" />
<link rel="apple-touch-icon" href="/app-icons/ios/icon-180.png" />
<meta name="theme-color" content="#000000" />
```

The `apple-touch-icon` points at the **opaque** `ios/icon-180.png`, not the
transparent `icon-180.png` — Safari's "Add to Home Screen" flattens alpha onto
black just like a native app icon. (In this repo the `<head>` lives in
`routes/index.tsx`.)

## Cordova / Android

In `config.xml`, under `<platform name="android">`:

```xml
<icon density="ldpi"    src="static/app-icons/android/ldpi.png" />
<icon density="mdpi"    src="static/app-icons/android/mdpi.png" />
<icon density="hdpi"    src="static/app-icons/android/hdpi.png" />
<icon density="xhdpi"   src="static/app-icons/android/xhdpi.png" />
<icon density="xxhdpi"  src="static/app-icons/android/xxhdpi.png" />
<icon density="xxxhdpi" src="static/app-icons/android/xxxhdpi.png" />
```

## Cordova / iOS

iOS icons are opaque (see above). In `config.xml`, under
`<platform name="ios">` — every @1x/@2x/@3x slot plus the 1024 App Store icon:

```xml
<icon src="static/app-icons/ios/icon-40.png"   width="40"   height="40" />   <!-- 20pt @2x -->
<icon src="static/app-icons/ios/icon-60.png"   width="60"   height="60" />   <!-- 20pt @3x -->
<icon src="static/app-icons/ios/icon-58.png"   width="58"   height="58" />   <!-- 29pt @2x -->
<icon src="static/app-icons/ios/icon-87.png"   width="87"   height="87" />   <!-- 29pt @3x -->
<icon src="static/app-icons/ios/icon-80.png"   width="80"   height="80" />   <!-- 40pt @2x -->
<icon src="static/app-icons/ios/icon-120.png"  width="120"  height="120" />  <!-- 40pt @3x / 60pt @2x -->
<icon src="static/app-icons/ios/icon-180.png"  width="180"  height="180" />  <!-- 60pt @3x (iPhone app) -->
<icon src="static/app-icons/ios/icon-76.png"   width="76"   height="76" />   <!-- 76pt @1x (iPad) -->
<icon src="static/app-icons/ios/icon-152.png"  width="152"  height="152" />  <!-- 76pt @2x (iPad) -->
<icon src="static/app-icons/ios/icon-167.png"  width="167"  height="167" />  <!-- 83.5pt @2x (iPad Pro) -->
<icon src="static/app-icons/ios/icon-20.png"   width="20"   height="20" />   <!-- 20pt @1x -->
<icon src="static/app-icons/ios/icon-29.png"   width="29"   height="29" />   <!-- 29pt @1x -->
<icon src="static/app-icons/ios/icon-40.png"   width="40"   height="40" />   <!-- 40pt @1x -->
<icon src="static/app-icons/ios/icon-1024.png" width="1024" height="1024" /> <!-- App Store marketing -->
```

> The 1024 marketing icon **must** have no alpha channel — these are flattened
> PNGs, so they're submission-ready.
