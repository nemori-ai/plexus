# Plexus desktop — build & packaging (P6)

How the macOS desktop app is built, how the runtime sidecar is bundled, and the
exact steps to produce a **real** (signed + notarized) distribution. References
`docs/archive/design/REDESIGN-ARCHITECTURE.md` §5.

---

## What ships

```
Plexus.app/
  Contents/
    MacOS/Plexus                     # the Electron app
    Resources/
      icon.icns                      # dock / bundle icon (assets/icon.icns)
      app.asar                       # main/ JS + the tray template PNGs
      runtime/
        plexus-runtime-darwin-arm64  # the COMPILED Bun runtime sidecar (extraResource)
```

The runtime is **not** ported into Electron-main — it stays the same headless
binary a server runs (§3.1). Electron-main spawns it as a supervised child.

## Dev vs packaged sidecar resolution

`main/main.js` calls `resolveRuntimeCommand(...)` (pure, in `src/runtime-resolver.ts`):

| Mode | `app.isPackaged` | Spawns |
|---|---|---|
| **dev** (`electron .`) | `false` | `bun run packages/runtime/bin/plexus` (TS source) |
| **prod** (packaged) | `true`  | `<resourcesPath>/runtime/plexus-runtime-darwin-<arch>` (compiled exe) |

Identical supervisor code in both; only the resolved `{command, args}` differs.

## Build the runtime sidecar

`bun build --compile` produces a single-file native executable that carries its
own Bun — **no Bun install required on the user's machine** (§5.1):

```sh
# from packages/runtime
bun run build:compile            # both macOS arches → dist/plexus-runtime-darwin-{arm64,x64}
bun run build:compile:arm64      # one arch
```

Verify it boots:

```sh
PLEXUS_HOME=$(mktemp -d) PLEXUS_PORT=0 ./dist/plexus-runtime-darwin-arm64
# → prints PLEXUS_READY {"port":…,"pid":…,"lraVersion":"1.0"} and serves /v1/health
```

## Pack the desktop app (UNSIGNED — proves bundling)

```sh
# from packages/desktop
bun run pack       # build:helpers + compile sidecar + stage + electron-builder --dir
```

Output: `release/mac-arm64/Plexus.app` with the sidecar at
`Contents/Resources/runtime/plexus-runtime-darwin-arm64`.

`scripts/stage-sidecar.sh` copies the compiled exe(s) from `packages/runtime/dist`
into `build/runtime/`, which `electron-builder.yml` ships as an `extraResource`.

## Icons

```sh
bun run build:icons   # scripts/gen-icons.{py,sh} → trayTemplate*.png + icon.icns
```

- **Tray:** `assets/trayTemplate.png` / `@2x` — a monochrome diamond. The
  `…Template.png` name + `setTemplateImage(true)` makes macOS auto-invert it for
  dark/light menubars. (`main/tray.js`.)
- **App:** `assets/icon.icns` — a colored diamond on a slate plate, for the dock/bundle.

These are simple committed placeholders; swap the art without touching `tray.js`.

---

## Real distribution: signing + notarization (DEFERRED — needs the owner's cert)

The unsigned `--dir`/`.dmg` build runs locally but Gatekeeper blocks it on other
machines. A real release needs an **Apple Developer ID** cert and notarization.
**Both the Electron app AND the bundled Bun exe must be signed** — Bun's compiled
binary is a JIT-capable native child process; an unsigned/un-notarized child trips
Gatekeeper when the app spawns it (§5.2).

### 1. Certificate

Obtain a **Developer ID Application** certificate (Apple Developer Program, ~$99/yr)
in Keychain, or export a `.p12`:

```sh
export CSC_LINK=/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='<p12 password>'
```

### 2. Sign the bundled Bun exe

electron-builder signs nested binaries it knows about; the runtime sidecar lives
under `Resources/runtime/`, so make sure it is covered. With the hardened runtime,
`build/entitlements.mac.plist` (already referenced in `electron-builder.yml`) grants
the Bun exe `allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation`.
If a binary is missed, sign it explicitly before packing:

```sh
codesign --force --options runtime \
  --entitlements build/entitlements.mac.plist \
  --sign "Developer ID Application: <NAME> (<TEAMID>)" \
  packages/runtime/dist/plexus-runtime-darwin-arm64
```

In `electron-builder.yml`, set `mac.identity` to your Developer ID (remove
`identity: null`) so electron-builder signs the app + nested binaries with the
hardened runtime.

### 3. Notarize + staple

Add an `afterSign` notarize hook (e.g. `@electron/notarize`) and credentials:

```sh
export APPLE_ID='you@apple.id'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'   # appleid.apple.com app password
export APPLE_TEAM_ID='<TEAMID>'
```

Then `bun run dist` builds the signed `.dmg`, submits it to Apple's notary
service, and staples the ticket. Verify:

```sh
spctl -a -vvv -t install release/Plexus.dmg     # → "accepted, source=Notarized Developer ID"
codesign -dvvv --verify Plexus.app
```

### Auto-update (deferred)

`electron-updater` (Squirrel.Mac) ships updates; the sidecar updates *with* the app
(it's a bundled resource — one version the user sees). The `lraVersion`/`protocolVersion`
negotiation (§2.4) degrades a mid-update skew gracefully. Not wired here (needs a
signed feed + release host).

---

## Deferred in P6

- Real code signing + notarization + auto-update (need the owner's Apple Developer ID).
- Windows (`.exe`/NSIS) + Linux (`.AppImage`/`.deb`) packaging — needs the Win32/Linux
  platform-seam impls (REDESIGN §4, Phase 4) and per-OS `bun-windows-x64`/`bun-linux-x64`
  compile targets (the `build-compile.ts` target table is ready to extend).
- Universal (arm64+x64) DMG: `stage-sidecar.sh --all` stages both exes; pair with an
  electron-builder `--universal` (or per-arch) target.
