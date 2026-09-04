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

Send the **single-line content** of `~/.tauri/markpad-updater.key.pub` (no comments, no header lines) to the developer who'll commit it to `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. The committed value is the live public key — steps 1–3 are here for whoever has to redo the setup, not for the next release.

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

**`build.yml` checks this before creating a release.** It fetches that URL and asserts the feed's download URLs still name this repository. A network failure warns instead of blocking.

### 6. Optional: a stable macOS signing identity

This is unrelated to the minisign keypair above, and it is not the Apple Developer Program. Skip it and macOS releases behave exactly as they did before.

**What it buys.** macOS binds a persisted file-access grant — including the Full Disk Access checkbox — to the app's *designated requirement*, not to its bytes. Today's bundles carry no certificate, so the requirement is a content hash that changes with every build, and every update looks like a different app to TCC. Users re-grant folder access after each release ([#209](https://github.com/sftwrdotdev/Markpad/issues/209)). Signing with a certificate that outlives releases replaces that hash with `identifier "com.alecdotdev.markpad" and certificate leaf = H"..."`, which does not move when the code does.

**What it does not buy.** Nothing about Gatekeeper. The app stays un-notarized, so a downloaded `.dmg` still warns on first launch — the same as today.

**Create the certificate** (once, on a Mac, no Apple account involved):

1. Keychain Access → menu bar → *Certificate Assistant* → *Create a Certificate…*
2. Name it `markpad-codesign-certificate`, Identity Type *Self Signed Root*, Certificate Type **Code Signing**, and tick *Let me override defaults*.
3. **Set the validity period to something long — 7300 days.** The default is 365, and an expired certificate is as disruptive as a lost one.
4. Finish, then right-click the certificate → *Export…* → `.p12`, and set a password.

**Add three secrets** (Settings → Secrets and variables → Actions):

| Name | Value |
|---|---|
| `MACOS_CERTIFICATE` | `base64 -i markpad-codesign-certificate.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `MACOS_SIGNING_IDENTITY` | `markpad-codesign-certificate` (the certificate's common name) |

With all three set, the macOS job imports the certificate into a throwaway keychain and `tauri build` signs with it. With `MACOS_CERTIFICATE` absent, the step prints one line and exits.

### 7. CRITICAL: the signing certificate has no revocation path

Apple can revoke a Developer ID certificate. Nobody can revoke this one. Two consequences worth accepting deliberately before step 6:

- **If the `.p12` leaks**, whoever holds it can sign a build that satisfies the same designated requirement — and therefore inherits every folder grant users gave the real Markpad. The only remedy is to switch certificates, which costs every user their permissions.
- **If it is lost or expires**, same outcome: a new certificate is a new identity, and every user re-grants from scratch.

Back it up in the same place as the minisign private key, and treat it with the same care.

### 8. Optional: Authenticode signing for Windows

The certificate comes from [SignPath Foundation](https://signpath.org), free for open-source projects, and it is what stops SmartScreen calling Markpad an unrecognized app from an unknown publisher ([#334](https://github.com/sftwrdotdev/Markpad/issues/334), [#466](https://github.com/sftwrdotdev/Markpad/issues/466), [#562](https://github.com/sftwrdotdev/Markpad/issues/562)). Skip it and Windows releases behave exactly as they did before.

Set up in [app.signpath.io](https://app.signpath.io), once:

1. Install the **SignPath GitHub App** on `sftwrdotdev` with access to this repository, and add **GitHub.com** as a trusted build system linked to the project. Both are how SignPath establishes that the artifact came from a workflow run rather than from whoever holds the API token.
2. The **artifact configuration** describes the artifact the workflow submits — a ZIP holding the four executables, each `<pe-file>` with `<authenticode-sign/>`: `Markpad_*_x64-setup.exe`, `Markpad_*_x64.exe`, `Markpad_*_arm64-setup.exe`, `Markpad_*_arm64.exe`.
3. Put yourself in the signing policy's **approvers**. Every release stops for that click.
4. Create a **CI user with submitter permission** and generate an API token for it.

**Add one secret** (Settings → Secrets and variables → Actions):

| Name | Value |
|---|---|
| `SIGNPATH_API_TOKEN` | the CI user's API token |

The other four values — organization id, project slug, signing policy slug, artifact configuration slug — are not secrets and are written into the `sign-windows` job in [`build.yml`](.github/workflows/build.yml). Change them there.

With the secret set, `sign-windows` submits one request for all four executables and waits up to an hour for approval; nothing is uploaded before it comes back, so a timeout is a re-run of one job rather than a half-signed release. Without it, the job uploads what the matrix built, unsigned, and the release notes keep the SmartScreen note.

**Authenticode changes the installer's bytes, so `*-setup.exe.sig` is regenerated after signing** — that file is the updater's minisign signature, and a stale one makes every Windows install reject its next update. This is why signing lives in a job of its own rather than in the build matrix.

## Per-release workflow

The workflow uses `npm ci`, so its installed dependency graph is exactly the committed lockfile. Do not replace it with `npm install` in release jobs. `scripts/releaseWorkflow.test.ts` guards that.

[`snapcraft.yaml`](snapcraft.yaml) builds nothing. It packages the `.deb` the release already shipped (`plugin: dump`, `source-type: deb`), so the snap carries the same binary as the `.deb` and the AppImage. The same test asserts it is packaging rather than building.

1. **Bump the version:**
   ```bash
   npm run release X.Y.Z
   ```
   It writes all three files the version lives in and checks they agree —
   [`package.json`](package.json), [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml)
   `[package].version`, and the `Markpad` entry in
   [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock). The lock is the one that gets
   forgotten by hand: nothing in the editing loop reads it, so a bump without it
   lands green and stays wrong.

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
4. **Wait** ~30 min for matrix builds to finish, plus ~2 min for `generate-update-feed`. Once one-time setup step 8 is done, the `sign-windows` job pauses in between until you approve the signing request in SignPath — it emails you, and the job's log holds the link.
5. **Open the draft release** on the [Releases page](https://github.com/sftwrdotdev/Markpad/releases). Verify the assets:
   - **macOS**: `*.dmg`, `*.app.tar.gz`, `*.app.tar.gz.sig`
     - Once one-time setup step 6 is done, check the signature took as well: mount the `.dmg` and run `codesign -d -r-` against the `.app` inside it. It must print `certificate leaf = H"…"`. `code object is not signed at all` means the secrets are missing or the import step exited early — the build is green either way, and shipping it costs every macOS user their folder grants again.
   - **Windows x64**: `Markpad_<version>_x64.exe` (portable), `*_x64-setup.exe` (NSIS installer), `*_x64-setup.exe.sig`
   - **Windows ARM64**: `Markpad_<version>_arm64.exe` (portable), `*_arm64-setup.exe` (NSIS installer), `*_arm64-setup.exe.sig`
     - Once one-time setup step 8 is done, check the signature took: right-click a downloaded `.exe` → *Properties* → *Digital Signatures*, which must list a certificate. An unsigned build is green either way, and the release notes will have said the executables are signed.
   - **Linux**: `*.deb`, `*.rpm`, `*.AppImage`, `*.AppImage.sig`
   - **Update feed**: `latest.json` (one entry per successfully built platform)
6. **Click "Publish release"** — this is the gate. It activates auto-update for all clients pointing at `releases/latest/download/latest.json`, **and** it starts [`publish-packages.yml`](.github/workflows/publish-packages.yml), which pushes to Chocolatey and the Snap Store.
7. **Watch `Publish Packages` finish.** Two independent jobs, neither swallowing a failure; either can fail without affecting the release that already went out. Fix, then re-run it with the tag as `workflow_dispatch` input — that path also works against an already-published tag, which is the only way to exercise `snapcraft.yaml` or the Chocolatey packaging without cutting a release, since neither is reachable from a pull request.

## First auto-update-capable release

The first release after auto-update is enabled does **not** auto-update existing users — older Markpad builds don't have the updater wiring yet. They must download and install this version manually once. From then on, every subsequent release reaches users automatically.

Mention this clearly in the release notes for the first auto-update-capable version, e.g.:

> This release activates in-app auto-updates. **Install it manually one last time** — future releases will update Markpad on their own.

## First signed macOS release

Turning on one-time setup step 6 changes the app's identity once. Existing bundles are pinned to an ad-hoc content hash; the signed one is pinned to the certificate, so to macOS the first signed release is a different app. Its users grant folder access one last time, and from then on the grant survives updates. No other platform is affected.

Say so in that release's notes, e.g.:

> macOS will ask for folder access once more after this update. **This is the last time** — from this release on, the permission carries across updates.

## Coverage notes

- **macOS** uses one universal binary (`darwin-aarch64` + `darwin-x86_64` share the same `.app.tar.gz` and signature).
- **Windows** uses NSIS — the auto-updater downloads `*-setup.exe` (verified by `*-setup.exe.sig`) and runs it in `passive` install mode. The existing raw portable `.exe` distribution path is preserved alongside, so users who download the portable `.exe` directly continue to work; only the auto-updater path uses the NSIS installer.
- **Linux**: only `AppImage` users get auto-updates — `tauri-plugin-updater` doesn't support `.deb` or `.rpm`, and there is no apt or dnf repository either. `.deb` and `.rpm` are therefore one-time installs: those users upgrade by downloading a newer package, and the app's *Check for Updates…* tells them so rather than offering one. This is stated in the README as well; if a repository is ever published, both change together.
- **Snap / Chocolatey**: independent distribution channels, published by `publish-packages.yml` after the release is published. Their update mechanisms are unaffected. The Chocolatey package wraps the release's own `Markpad_<version>_x64.exe` rather than a second build, which is what `packaging/choco/tools/VERIFICATION.txt` promises.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|---------------------|
| Build fails: "missing `TAURI_SIGNING_PRIVATE_KEY`" | Step 2 of one-time setup wasn't done, or Secret name doesn't match. |
| macOS build fails at `security import` | The `.p12` was exported by a recent `openssl` with its default cipher, which `security` cannot read (it reports a MAC failure, not a cipher failure). Re-export from Keychain Access, or pass `-legacy -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1`. |
| macOS build logs `no identity found` | The certificate is a CA rather than a leaf — `codesign` will not sign with it. Keychain Access's *Create a Certificate…* produces the right kind; `openssl req -x509` needs an explicit `basicConstraints=critical,CA:FALSE`. |
| `sign-windows` fails with a timeout | Nobody approved the signing request within the hour. Nothing was uploaded; re-run the job and approve it. |
| `sign-windows` fails before submitting | Usually the SignPath GitHub App is not installed on the repository, or GitHub.com is not a trusted build system for the project — one-time setup step 8.1. |
| `generate-update-feed` succeeds but `latest.json` lacks a platform | That platform's matrix build failed silently (or the `.sig` file wasn't produced). Check the failed build's logs. |
| `latest.json` missing entirely | The `generate-update-feed` job didn't run — usually because no `*.sig` files were uploaded. Check the `Upload * Artifacts` steps. |
| Users don't see the update | (1) Did you click *Publish release*? Drafts aren't visible to clients. (2) Is the user on a version older than the first auto-update-capable release? They need a one-time manual reinstall. |
| Update download succeeds but install fails with signature error | Pubkey mismatch — the Secrets and `tauri.conf.json` `pubkey` belong to different keypairs. |
| An AppImage check fails | Three scripts run against it and the log says which: [`check-appimage-libraries.sh`](scripts/check-appimage-libraries.sh) (what it bundles), [`strip-appimage.sh`](scripts/strip-appimage.sh) (removing the host-coupled ones), [`smoke-appimage.sh`](scripts/smoke-appimage.sh) (whether it starts). All three run locally against the AppImage from the draft release; no signing key, no FUSE. |
| `Publish Packages` / snap job fails | Read the snapcraft error rather than re-running. `snapcraft.yaml` only unpacks a `.deb`, so the two live failures are: the job did not put `markpad.deb` next to it (the message names the path), or the `snapcraft` snap the runner installs changed under us — the job prints `snap list snapcraft`. Fix, then re-run with the tag as `workflow_dispatch` input. |
| `Publish Packages` / chocolatey job fails on push | A version can only be pushed to Chocolatey once. If it is already there, nothing needs doing; if it is not, check `CHOCO_API_KEY`. |

## Out of scope (not handled by this workflow)

- **Apple Developer ID code-signing & notarization** — not done, and one-time setup step 6 is not a substitute: a self-signed certificate gives the bundle a stable identity for TCC, but macOS still shows a Gatekeeper warning on first launch because the app is not notarized. Minisign verification by the updater is independent of both.
- **Windows Authenticode signing without SignPath** — one-time setup step 8 is the only path wired here. With it unconfigured, neither the portable `.exe` nor the `*-setup.exe` NSIS installer is signed, and users may see a SmartScreen warning. Minisign verification by the updater is independent of both.
- **Retroactive signing** of older releases.
