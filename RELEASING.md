# Releasing Markpad

This document is the maintainer-facing runbook for cutting a Markpad release with auto-update enabled. Auto-update is wired through [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/), which verifies signed update bundles using [minisign](https://jedisct1.github.io/minisign/).

## One-time setup (do once, before the first auto-update-capable release)

### 1. Generate the signing keypair

On your local machine, in the Markpad checkout:

```bash
npm run tauri signer generate -- -w ~/.tauri/markpad-updater.key
```

You'll be prompted for a password. **Pick a strong one and store it together with the private key in your password manager.** The command produces two files:

- `~/.tauri/markpad-updater.key`     — **PRIVATE**. Never commit. Never share. Back up to a password manager.
- `~/.tauri/markpad-updater.key.pub` — **PUBLIC**. Shared with developers; ends up shipped inside Markpad.

### 2. Add Secrets to `sftwrdotdev/Markpad`

In the GitHub repo settings → Secrets and variables → Actions → New repository secret:

| Name                                  | Value                                              |
|---------------------------------------|----------------------------------------------------|
| `TAURI_SIGNING_PRIVATE_KEY`           | full content of `~/.tauri/markpad-updater.key`     |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`  | the password you set in step 1                     |

The build workflow reads both at signing time on macOS, Windows, and Linux runners.

### 3. Send the public key content

Send the **single-line content** of `~/.tauri/markpad-updater.key.pub` (no comments, no header lines) to the developer who'll commit it to `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. This already happened for the current keypair — the committed value is the live public key, not a placeholder — so steps 1–3 are kept as history for anyone who ever has to redo the setup. While the field held a placeholder, auto-update was inert: the app surfaced a clean error state instead of contacting the update server.

### 4. CRITICAL: the pubkey is permanent

Once a release ships with the pubkey embedded, **it cannot be rotated** without breaking auto-update for every existing user. Rotation means everyone re-installs Markpad manually. Treat the keypair as a long-lived release secret.

If you ever lose the private key:

- Existing users can still use Markpad, but they will not auto-update again.
- A new keypair has to be generated, embedded in a new release, and that release has to be installed manually by every user.
- Communicate this in release notes so users aren't blindsided.

### 5. `alecdotdev/Markpad` is load-bearing

The updater endpoint in `src-tauri/tauri.conf.json` points at **`sftwrdotdev/Markpad`**. (`scripts/releaseWorkflow.test.ts` holds that name and the endpoint together — if the repository ever moves again, this line moves with it.)

That only helps builds made from here on. The endpoint is compiled into the binary, so every copy up to and including v2.7.0 asks GitHub for `https://github.com/alecdotdev/Markpad/releases/latest/download/latest.json` and reaches the current feed only because GitHub answers with a 301. Those installs use that redirect for as long as they run.

GitHub voids a transfer redirect if the old location is occupied. From [Transferring a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository):

> If you create a new repository or fork at the previous repository location, the redirects to the transferred repository will be permanently deleted.

So: **do not create a repository named `Markpad` under `alecdotdev`, do not fork this repository to `alecdotdev`, and do not transfer Markpad back and away again.** A fork is the easy mistake — it copies the code and not the releases, so that URL 404s the moment one exists.

The failure is quiet and unfixable from here: `latest.json` 404s, the updater reports no update available, and users on old versions simply stop being offered new ones. It is not a code-execution risk — the pinned `pubkey` means whoever serves that URL cannot produce a signature that installs.

**`build.yml` checks this before creating a release.** It fetches that URL and asserts the feed's download URLs still name this repository, so it tests what actually matters rather than whether a repository exists at the old location — occupying it while serving a correct feed would pass, correctly. A network failure warns instead of blocking.

## Per-release workflow

The workflow uses `npm ci`, so its installed dependency graph is exactly the committed lockfile. Do not replace it with `npm install` in release jobs. `scripts/releaseWorkflow.test.ts` guards that.

[`snapcraft.yaml`](snapcraft.yaml) no longer builds anything. It packages the `.deb` the release already shipped (`plugin: dump`, `source-type: deb`), so the snap carries the same binary as the `.deb` and the AppImage rather than a second compilation of the same source — which is also what removed rust and node from a file that had failed four release attempts on them. The same test asserts it is packaging rather than building.

1. **Bump the version:**
   ```bash
   npm run release X.Y.Z
   ```
   It writes all three files the version lives in and checks they agree —
   [`package.json`](package.json), [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml)
   `[package].version`, and the `Markpad` entry in
   [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock). The lock is the one that gets
   forgotten by hand: nothing in the editing loop reads it, so a bump without it
   lands green and stays wrong until someone's `cargo build` rewrites the line.
   That is how the 2.7.2/2.7.3 skew was found, one release after it shipped.

   It stops there. Committing, tagging and dispatching stay below, on purpose.
2. **Commit, tag, push:**
   ```bash
   git commit -am "chore: bump version to X.Y.Z"
   git tag vX.Y.Z
   git push origin master vX.Y.Z
   ```
3. **Trigger the workflow:**
   - GitHub UI: Actions → "Build and Release" → Run workflow → master
   - Or CLI: `gh workflow run build.yml --ref master`

   Only one release build runs at a time — a second dispatch queues behind the
   first instead of racing it to the same draft.
4. **Wait** ~30 min for matrix builds to finish, plus ~2 min for `generate-update-feed`.
5. **Open the draft release** on the [Releases page](https://github.com/sftwrdotdev/Markpad/releases). Verify the assets:
   - **macOS**: `*.dmg`, `*.app.tar.gz`, `*.app.tar.gz.sig`
   - **Windows x64**: `Markpad_<version>_x64.exe` (portable), `*_x64-setup.exe` (NSIS installer), `*_x64-setup.exe.sig`
   - **Windows ARM64**: `Markpad_<version>_arm64.exe` (portable), `*_arm64-setup.exe` (NSIS installer), `*_arm64-setup.exe.sig`
   - **Linux**: `*.deb`, `*.rpm`, `*.AppImage`, `*.AppImage.sig`
   - **Update feed**: `latest.json` (one entry per successfully built platform)
6. **Click "Publish release"** — this is the gate. It activates auto-update for all clients pointing at `releases/latest/download/latest.json`, **and** it starts [`publish-packages.yml`](.github/workflows/publish-packages.yml), which pushes to Chocolatey and the Snap Store.
7. **Watch `Publish Packages` finish.** Two independent jobs; either can fail without affecting the release that already went out. Re-run the failed job after fixing, or run the workflow by hand with the tag as input.

### Why package managers publish after the release, not during the build

Chocolatey and the Snap Store used to be pushed from inside `build.yml`'s platform matrix, so an irreversible external side effect happened *before* anything decided whether a release existed.

That is not hypothetical. Chocolatey's `markpad-app` 2.7.2 was published at 15:37 UTC on 2026-08-07 by run `31192564528` — a run that then failed on Linux and produced no release. The release users actually got came out of a different run three hours later. A Chocolatey version cannot be un-pushed.

Both steps also carried `continue-on-error: true`, which turned a dead channel into a green check: the snap build failed from v2.6.11 onward and the Snap Store went on serving 2.6.11 for three months and six versions, while every release told people to `sudo snap install markpad`. Neither job swallows a failure now. `scripts/releaseWorkflow.test.ts` holds both properties.

`publish-packages.yml` also takes `workflow_dispatch` with a tag, so it can be exercised against an already-published release without cutting a new one — worth doing after any change to `snapcraft.yaml` or the Chocolatey packaging, since neither is reachable from a pull request.

## First auto-update-capable release

The first release after auto-update is enabled does **not** auto-update existing users — older Markpad builds don't have the updater wiring yet. They must download and install this version manually once. From then on, every subsequent release reaches users automatically.

Mention this clearly in the release notes for the first auto-update-capable version, e.g.:

> This release activates in-app auto-updates. **Install it manually one last time** — future releases will update Markpad on their own.

## Coverage notes

- **macOS** uses one universal binary (`darwin-aarch64` + `darwin-x86_64` share the same `.app.tar.gz` and signature).
- **Windows** uses NSIS — the auto-updater downloads `*-setup.exe` (verified by `*-setup.exe.sig`) and runs it in `passive` install mode. The existing raw portable `.exe` distribution path is preserved alongside, so users who download the portable `.exe` directly continue to work; only the auto-updater path uses the NSIS installer.
- **Linux**: only `AppImage` users get auto-updates — `tauri-plugin-updater` doesn't support `.deb` or `.rpm`, and there is no apt or dnf repository either. `.deb` and `.rpm` are therefore one-time installs: those users upgrade by downloading a newer package. Since #573 the app asks `self_update_supported` *before* it checks, so those installs are told where their updates come from instead of being offered one that then fails to install — `__TAURI_BUNDLE_TYPE` is not patched into the Linux binary, so every Linux package would otherwise take the AppImage install path (#570). This is stated in the README as well; if a repository is ever published, both change together.
- **Snap / Chocolatey**: independent distribution channels, published by `publish-packages.yml` after the release is published. Their update mechanisms are unaffected. The Chocolatey package wraps the release's own `Markpad_<version>_x64.exe` rather than a second build, which is what `packaging/choco/tools/VERIFICATION.txt` promises.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|---------------------|
| Build fails: "missing `TAURI_SIGNING_PRIVATE_KEY`" | Step 2 of one-time setup wasn't done, or Secret name doesn't match. |
| `generate-update-feed` succeeds but `latest.json` lacks a platform | That platform's matrix build failed silently (or the `.sig` file wasn't produced). Check the failed build's logs. |
| `latest.json` missing entirely | The `generate-update-feed` job didn't run — usually because no `*.sig` files were uploaded. Check the `Upload * Artifacts` steps. |
| Users don't see the update | (1) Did you click *Publish release*? Drafts aren't visible to clients. (2) Is the user on a version older than the first auto-update-capable release? They need a one-time manual reinstall. |
| Update download succeeds but install fails with signature error | Pubkey mismatch — the Secrets and `tauri.conf.json` `pubkey` belong to different keypairs. |
| `Strip host-coupled libraries from AppImage` fails | Run [`scripts/strip-appimage.sh`](scripts/strip-appimage.sh) locally against the AppImage from the draft release — it needs no signing key. It failed in two of the three v2.7.2 attempts, once because `signer sign` had a stray flag and once because it was reading the deprecated `TAURI_PRIVATE_KEY` names on a CLI too old to accept the current ones. |
| `Publish Packages` / snap job fails | Read the snapcraft error rather than re-running. `snapcraft.yaml` only unpacks a `.deb` now, so the two live failures are: the job did not put `markpad.deb` next to the file (the message names the path), or the `snapcraft` snap the runner installed that day changed under us — the job prints `snap list snapcraft`, and an 8.14.5 → 9.0.1 bump is exactly what killed the snap for three months. Fix, then re-run the workflow with the tag as `workflow_dispatch` input. |
| An AppImage check fails in `test_build.yml` | Three scripts run against it and say which one: [`check-appimage-libraries.sh`](scripts/check-appimage-libraries.sh) (what it bundles), [`strip-appimage.sh`](scripts/strip-appimage.sh) (removing the host-coupled ones), [`smoke-appimage.sh`](scripts/smoke-appimage.sh) (whether it starts). All three run locally against the AppImage from the draft release and need no signing key; the tooling does not need FUSE. |
| `Publish Packages` / chocolatey job fails on push | A version can only be pushed to Chocolatey once. If it is already there, nothing needs doing; if it is not, check `CHOCO_API_KEY`. |

## Out of scope (not handled by this workflow)

- **Apple Developer ID code-signing & notarization** — `.app` bundles are unsigned. macOS may show a Gatekeeper warning on first launch. Minisign verification by the updater is independent of Apple code-signing.
- **Windows Authenticode signing** — neither the portable `.exe` nor the `*-setup.exe` NSIS installer is signed with a code-signing certificate. Users may see a SmartScreen warning. Minisign verification by the updater is independent.
- **Retroactive signing** of older releases.
