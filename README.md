# Axhibit A

A portable Windows player for **AXIS Camera Station Pro** exports, built to replace the bundled AXIS File Player. It adds:

- **Fisheye dewarping**: PTZ, panorama, double panorama, quad, with auto lens-circle detection
- **Synced multi-camera playback** on a shared recorded-time timeline (handles gaps and multiple segments per camera)
- **Redaction**: keyframed blur / pixelate / solid boxes that hold in every view
- **Animated PTZ export**: record a view path and export the moving view
- **Signed video verification** using Axis' open-source signed-video-framework (incl. ONVIF Media Signing)
- **Evidence-safe export**: H.264 MP4 that plays anywhere, plus a provenance manifest (source and output SHA-256, camera metadata, every operation, exact FFmpeg commands, signed-video result)

Originals are opened read-only and never modified. *Not an Axis product.*

See [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for users; developers start at [CLAUDE.md](CLAUDE.md).

## Build

```bash
npm install
npm run fetch:ffmpeg          # pinned LGPL FFmpeg for Windows → resources/bin (Windows uses the built-in tar.exe to unzip)
npm run lint                  # tsc --noEmit
npm test                      # unit tests
npm run dist:win              # dist/AxhibitA-<version>-portable.exe (native on Windows; from Linux with wine)
```

The signed-video validator `resources/bin/sv-validate.exe` is a build output and isn't committed. Build it with `bash scripts/build-native.sh` (**Linux/WSL only**; it cross-compiles with mingw-w64 and a static OpenSSL, and uses the `native/signed-video-framework` submodule), or copy it from a release build. Without it the app runs normally, but the Verify tab reports that the validator isn't included.

E2E tests build the app, then run `tests/e2e/features.mjs` against a folder of real ACS exports (opened read-only, hashed before and after). They use a throwaway profile, so they run fine with Axhibit A open. Footage isn't part of the repo:
- copy `tests/e2e/samples.example.json` to `tests/e2e/samples.local.json` (git-ignored) and fill in file names from your exports folder;
- the signed-video checks use `tests/fixtures/media/signed.mkv` and `tampered.mkv`, which `scripts/make-signed-fixtures.sh` generates (Linux/WSL). They're skipped if those files are absent.

```bash
AXHIBIT_SAMPLES="D:\ACS exports" npm run test:e2e   # PowerShell: $env:AXHIBIT_SAMPLES='...'; npm run test:e2e
xvfb-run -a npm run test:e2e                                       # Linux, samples in ./samples
```

`npm run bench:export` times one dewarp export (same env var). Use it when working on export speed.

## License
Axhibit A is released under the [MIT License](LICENSE). "AXIS" and "AXIS Camera Station" are trademarks of Axis AB; this project is not affiliated with or endorsed by Axis.

## Licenses of bundled components
FFmpeg (LGPL 2.1, BtbN LGPL build, no GPL components) · Axis signed-video-framework and ONVIF media-signing-framework (MIT) · OpenSSL 3 (Apache 2.0) · Inter typeface (SIL OFL 1.1) · Electron/Chromium (MIT/BSD). License texts ship in `resources/bin/LICENSES`.
