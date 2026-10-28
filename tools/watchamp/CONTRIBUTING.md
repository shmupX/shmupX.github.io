# Contributing to Aloud

Thanks for helping make standalone audiobook playback on Wear OS better.

## Before opening an issue

Please check [existing issues](https://github.com/tuncoglu/aloud/issues) and
[ROADMAP.md](ROADMAP.md). For a playback or transfer problem, first try the
latest commit and restart Aloud.

Useful details include:

- watch model and Wear OS version
- Aloud version or commit
- MP3 or M4B, including whether the book has chapters
- whether Bluetooth was connected, disconnected, or shared with another device
- exact steps to reproduce
- relevant `adb logcat -s Aloud:W` output, with personal information removed

Never attach audiobook files, private library metadata, PINs, or keystore
material to an issue.

## Development

Use JDK 21 and an Android SDK with API 37:

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:lintDebug
./gradlew :app:assembleDebug
```

Keep changes focused. Preserve the standalone, local-first design: Aloud should
not acquire a phone companion, account, cloud dependency, analytics, or tracking
without an explicit design decision.

When changing playback, upload, storage, or chapter parsing, add or update tests.
For watch-specific behaviour, include the device and real-world verification
performed.

## Pull requests

Please explain:

1. What changed and why.
2. How it was tested, including on-device testing if applicable.
3. Any user-visible limitations or follow-up work.

Small, reviewable pull requests are easier to validate on a real watch.
