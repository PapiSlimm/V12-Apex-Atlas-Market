# Desktop Edition

**Status: scaffold, not a shipped binary.** I could not build or sign a desktop app in this environment — no GUI toolchain, no code-signing certificates, no notarisation credentials. What is here is the architecture and the configuration; the build itself is a step you run on real machines.

The design is below; the checklist at the bottom of this file is what remains.

---

## The shape of it

The desktop app is **the same server**, not a reimplementation.

```
┌─ Tauri shell (Rust, ~5 MB) ────────────────────────┐
│  ┌─ WebView (system, not bundled) ──────────────┐  │
│  │  The existing SPA, loaded from 127.0.0.1     │  │
│  └──────────────────────────────────────────────┘  │
│  ┌─ Sidecar: dist/server.cjs on Node ───────────┐  │
│  │  Same routes, same store, same audit chain   │  │
│  │  SQLite in the OS app-data directory         │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

That choice is the whole point of the earlier work. Because storage is behind one interface and the server has no cloud-specific dependencies, the desktop edition is a packaging exercise rather than a second codebase. Concretely, it needs **zero changes** to `server/`, `src/` or the store.

Three things make it work already:

- **SQLite is the zero-config default.** No `DATABASE_URL`, no database to install.
- **Single-tenant is the default.** `MULTI_TENANT` unset means one organisation; the tenancy columns cost a desktop user nothing.
- **`JWT_SECRET` is generated on first run** and kept in the OS keychain, so there is no secret to configure.

## Why Tauri rather than Electron

Electron bundles Chromium: ~150 MB per app, and you inherit its patch cadence. Tauri uses the OS webview — ~5 MB, and the webview is patched by the OS vendor.

The counter-argument is real: the system webview means WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux, so you test three engines instead of one. For this app that is an acceptable trade — the UI is standard React and Tailwind with no exotic APIs — and the download size matters for a "premium desktop application."

No Tauri configuration is checked in yet — running `tauri init` in this directory produces the starting point, and the Node sidecar wiring described above is what needs adding to it.

## What the desktop edition adds that the cloud cannot

This is the part that justifies the tier, and it is worth being specific rather than listing "local AI" as a bullet:

| Capability | Why it needs to be local |
| --- | --- |
| **Local model inference** (Ollama / llama.cpp on `127.0.0.1`) | Documents never leave the machine. This is the actual reason a regulated buyer wants a desktop build. |
| **Offline operation** | The deterministic modules — routing, Hermes evaluation, the vault, the ledger, the audit chain — already work with no network. Only the model calls degrade, and they degrade to a labelled fallback rather than an error. |
| **Local filesystem vault** | The digital twin is markdown. On desktop it can live in a real folder the user syncs with their own tooling, rather than in a database. |
| **Hardware acceleration** | GPU inference for local models. |

The last one is worth a caveat: GPU acceleration is a property of the local model runtime, not of this app. Apex Atlas talks to Ollama over HTTP; Ollama decides whether that runs on the GPU.

## Build

Prerequisites: Rust toolchain, Node 22, and the platform's webview development headers.

Once the Tauri scaffold has been initialised in this directory (`npm create tauri-app`), which has **not** been done yet:

```bash
npm run build                 # produces dist/ — the sidecar payload
cd desktop
npm install
npm run tauri build           # per-platform bundle
```

Targets: `.msi`/`.exe` (Windows), `.dmg`/`.app` (macOS), `.AppImage`/`.deb` (Linux).

## What remains before this ships

Not small, and worth seeing plainly:

- [ ] **Initialise the Tauri scaffold.** There is no `package.json` or `src-tauri/` in this directory yet; the build commands above cannot run until there is.
- [ ] **Node sidecar bundling.** Tauri ships a single binary; Node is not one. Either bundle a Node runtime per platform (~50 MB) or compile the server with `node --experimental-sea-config` into a single executable. The latter is cleaner and needs testing against `better-sqlite3`'s native addon.
- [ ] **Code signing and notarisation.** Apple Developer ID plus notarisation for macOS; an EV certificate for Windows SmartScreen. This is procurement and money, not engineering, and it has a lead time — start it early.
- [ ] **Auto-update.** Tauri's updater needs a signed manifest and a hosting endpoint. Without it, every user is on the version they first downloaded, forever.
- [ ] **Keychain integration** for `JWT_SECRET`. Writing secrets to a plaintext config file on a customer's laptop is not acceptable for the buyers this edition targets.
- [ ] **Port selection.** The sidecar must bind an ephemeral port and tell the shell, rather than assuming 3000 is free.
- [ ] **Local model adapter.** An `Ollama` implementation alongside the Gemini client, selected by config. The seam exists; the adapter does not.
- [ ] **Three-platform QA.** Three webview engines, three filesystem layouts, three sets of permission prompts.

I would sequence signing first — it has the longest lead time and blocks any real distribution — and the Node sidecar second, because it determines the download size that the whole "premium desktop" positioning rests on.
