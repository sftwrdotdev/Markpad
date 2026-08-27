//! Filesystem safety: durable writes, file identity, text decoding, and the
//! path checks every command that touches the disk goes through.
//!
//! Split out of `lib.rs`; the code and its tests are unchanged.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Distinguishes the temp files of `atomic_write` calls that share a process.
/// Never reset, and read with `fetch_add` so no two callers can be handed the
/// same value — the property the wall clock could not supply.
static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Temp-name prefixes already swept this run — see `sweep_abandoned_temps`.
static SWEPT_TEMP_PREFIXES: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Below this, a temp file could belong to a write that is still running —
/// this process's own or another Markpad's — and nothing may touch it.
const IN_FLIGHT_GRACE: Duration = Duration::from_secs(60);

/// How old a temp file that still has contents has to be before it counts as
/// abandoned. Long, because such a file can be the only copy of a document a
/// crash caught between the `fsync` and the rename.
const ABANDONED_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

/// Remove the temp file this call created, and if that fails, say so in the
/// error being returned.
///
/// The two are one thing on purpose. A write or rename that fails leaves the
/// temp file behind, and the reason the CLEANUP failed is the interesting half
/// — the failure that reaches the user is "could not save", while the file
/// they then find in their folder is explained by an error nobody kept
/// (#722). `let _ =` discarded exactly that.
fn remove_temp_or_say_why(error: std::io::Error, temp_path: &Path) -> std::io::Error {
    match fs::remove_file(temp_path) {
        Ok(()) => error,
        // Already gone is the outcome this wanted.
        Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup) => std::io::Error::new(
            error.kind(),
            format!(
                "{error} — and {} could not be cleaned up either: {cleanup}",
                temp_path.display()
            ),
        ),
    }
}

/// Clear temp files earlier runs left beside `document`, once per document
/// per run.
///
/// Two callers, because one of them cannot reach everything. A save sweeps the
/// document it is writing, which clears a folder the next time the user edits
/// what is in it — and never clears the folder of a document nobody edits
/// again. Startup sweeps the documents Markpad already knows about (the recent
/// list, and whatever the session restored), which is where a leftover would
/// otherwise sit for good.
///
/// Once per document per run because the scan only ever finds garbage from
/// earlier runs: repeating it finds nothing new, and it would put a `read_dir`
/// in front of every 1.5s auto-save, which on a network folder is the kind of
/// cost that shows up as a stutter while typing.
pub(crate) fn sweep_document_temps(document: &Path) {
    let Some(file_name) = document
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return;
    };
    let parent = match document.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let first_time = SWEPT_TEMP_PREFIXES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(parent.join(&file_name));
    if first_time {
        sweep_abandoned_temps(&parent, &file_name);
    }
}

/// Delete temp files for `file_name` that an earlier run left in `parent`.
///
/// Cleanup at the time of the failure is the first line and stays the main
/// one, but it cannot run at all when the process dies mid-write, and it can
/// be refused by whatever refused the write. Both leave a file the user has
/// to find and delete by hand, which is what #722 is: a portable Windows
/// build accumulating `.doc.md.markpad-tmp-…` siblings across sessions.
///
/// `IN_FLIGHT_GRACE` is what keeps this off a write that is still happening —
/// a temp file lives for one `write_all` and one `fsync`, so a minute is four
/// orders of magnitude past any of them, on any volume. Past that, two kinds
/// of leftover with different stakes:
///
/// - **Empty**: there is nothing in it to lose, so it goes. This is the #722
///   shape, and waiting an hour to clear a file that can never be anything but
///   garbage only means the user finds it first.
/// - **Not empty**: it may be the only copy of a document, from a process that
///   died between the `fsync` and the rename. `ABANDONED_TEMP_AGE` gives that
///   a wide berth before Markpad decides it is garbage.
fn sweep_abandoned_temps(parent: &Path, file_name: &str) {
    let prefix = format!(".{file_name}.markpad-tmp-");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(&prefix) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Some(age) = meta
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        else {
            continue;
        };
        if age < IN_FLIGHT_GRACE {
            continue;
        }
        if meta.len() == 0 || age >= ABANDONED_TEMP_AGE {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Write `bytes` to `target` durably and atomically: write to a sibling temp
/// file, fsync it, then rename over the target. Atomic on both Unix and
/// modern Windows — `std::fs::rename` calls `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING` on Windows since Rust 1.35, so an existing
/// destination is replaced atomically without a dedicated fallback path.
/// Markpad targets Tauri v2 (Rust 1.70+), so we can rely on this everywhere.
///
/// **Other correctness preservations vs. plain `fs::write`:**
/// - **Symlinks:** if `target` is a symlink, follow it to the real file so we
///   replace the linked content rather than the link itself.
/// - **Permissions:** on overwrite, restore the destination's original mode
///   bits after the rename; the temp file otherwise inherits the process
///   umask.
/// - **Read-only targets:** refuse up front. Replacing an inode only needs
///   write permission on the *directory*, so without this check a read-only
///   file (Unix `chmod 444`) would be silently rewritten and then have its
///   read-only bit restored, while Windows' `MoveFileExW` refuses a read-only
///   destination outright — the same document would be writable on one
///   platform and not on another.
/// - **POSIX durability:** on Unix, fsync the parent directory after the
///   rename so the directory entry update survives a crash. Windows NTFS
///   journals this on its own, so no extra step is needed there.
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // Resolve symlinks so we update the real file. `symlink_metadata` does NOT
    // follow links (unlike `metadata`); if target is a symlink, canonicalize
    // returns the real path it points to. For a non-existent target or a
    // regular file, we keep the original path.
    let resolved: PathBuf = match fs::symlink_metadata(target) {
        Ok(m) if m.file_type().is_symlink() => target.canonicalize()?,
        _ => target.to_path_buf(),
    };
    let target = resolved.as_path();

    // For a relative path with no leading directory (e.g. just "foo.md"),
    // `target.parent()` returns Some("") which is unusable for the temp
    // file. Treat that as the current directory so we can still place the
    // temp alongside the target and keep the rename atomic.
    let parent_path: PathBuf = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };

    // Snapshot existing permissions so we can re-apply them after rename.
    // `fs::rename` brings over the temp file's permissions, dropping mode
    // bits / ACLs that the destination had. `None` means "target didn't
    // exist", in which case there's nothing to restore.
    let existing_perms = fs::metadata(target).ok().map(|m| m.permissions());

    // Refuse a read-only destination before creating anything. The rename
    // below swaps the inode, which the target's own mode bits do not guard —
    // only the parent directory's do — so a `chmod 444` file would otherwise
    // be rewritten on Unix while the identical operation fails on Windows.
    if existing_perms
        .as_ref()
        .is_some_and(|perms| perms.readonly())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is read-only", target.display()),
        ));
    }

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "markpad".to_string());

    sweep_document_temps(target);

    // Claim a temp file nobody else holds. The name must be unique or two
    // concurrent writers of the same target collide, and a collision is not a
    // harmless retry: the loser used to delete `temp_path` on its way out,
    // which is the *winner's* file, and the winner then failed its rename with
    // ENOENT. So uniqueness comes from a per-process counter rather than the
    // clock — macOS timer granularity is coarser than a nanosecond, and two
    // threads calling `SystemTime::now` back to back routinely read the same
    // value. `create_new` still arbitrates across processes (a stale temp left
    // by a dead process whose pid we inherited), hence the bounded retry.
    let (mut file, temp_path) = {
        let pid = std::process::id();
        let mut attempts = 0;
        loop {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
            let mut candidate = parent_path.clone();
            candidate.push(format!(".{file_name}.markpad-tmp-{pid}-{nanos}-{seq}"));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => break (file, candidate),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempts < 16 => {
                    attempts += 1;
                }
                // Anything else — no such directory, permission denied — will
                // not improve on a retry, and neither will an `AlreadyExists`
                // that survived 16 fresh names.
                Err(e) => return Err(e),
            }
        }
    };

    // From here on `temp_path` is a file this call created, so cleaning it up
    // can never touch another writer's temp file.
    let write_result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();

    // Closed before the rename and before any cleanup, rather than at the end
    // of the function. Both of those operations are ones an open handle takes
    // part in on Windows: `MoveFileExW` and `DeleteFileW` fail with a sharing
    // violation when a handle without `FILE_SHARE_DELETE` is open on the file,
    // and our own handle joins whatever an antivirus scanner or indexer is
    // already holding on a file created one instruction ago. A `DeleteFileW`
    // that does get through with a handle still open only marks the file
    // delete-pending, so it stays visible in the directory meanwhile.
    drop(file);

    if let Err(e) = write_result {
        return Err(remove_temp_or_say_why(e, &temp_path));
    }

    // Atomic on both Unix and modern Windows: std::fs::rename uses
    // `rename(2)` (POSIX) or `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`
    // (Windows since Rust 1.35). The destination is either fully replaced
    // or left untouched — never partially overwritten or missing. If the
    // rename fails (e.g. target locked by another process on Windows),
    // we clean up the temp file and surface the original error without
    // touching the target.
    if let Err(e) = fs::rename(&temp_path, target) {
        return Err(remove_temp_or_say_why(e, &temp_path));
    }

    // A rename that reported success has left nothing at the old name, and on
    // every machine this has been run on that is what happens. #722 is a
    // machine where it does not: an endpoint agent (亚信安全 TrustOne) sits in
    // the filesystem, and the reporter gets one 0-byte `.doc.md.markpad-tmp-…`
    // per save while the save itself succeeds — no error, the tab's modified
    // dot clears, the document holds the new text. Whatever the agent is doing
    // with the source name, this call is the moment we still know it, and one
    // `remove_file` on a path that is normally already gone is a cheaper way
    // to find out than any amount of reasoning about filter drivers.
    //
    // Best-effort, and deliberately not folded into the error above: the write
    // has landed, the document is correct, and a save must not start failing
    // over a file that should not be there in the first place.
    if temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }

    // Best-effort restore of the original mode bits. If this fails (e.g. the
    // filesystem doesn't support it, or the user lacks privileges), the file
    // contents are still correctly written, so we don't surface the error.
    if let Some(perms) = existing_perms {
        let _ = fs::set_permissions(target, perms);
    }

    // POSIX durability: a rename is not durable until the parent directory's
    // metadata is also flushed to disk. Without this, a crash right after
    // rename could leave the target missing or pointing at the old inode.
    // Windows doesn't expose directory fsync semantics — its NTFS journal
    // already handles this, so we skip the call there.
    #[cfg(unix)]
    {
        if let Ok(dir) = fs::File::open(&parent_path) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// Strip Windows' verbatim (`\\?\`) prefix, which `canonicalize` adds and
/// nothing else in Markpad wants: the string reaches window titles, the recent
/// files list and the tab bar, and several Win32 APIs reject it. `\\?\C:\a`
/// becomes `C:\a` and `\\?\UNC\server\share` becomes `\\server\share`. A no-op
/// everywhere else, so callers do not need to know the platform.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = match path.to_str() {
        Some(text) => text,
        // Not UTF-8: leave it alone rather than mangle it. The prefix is ASCII,
        // so this only gives up on paths that could not round-trip anyway.
        None => return path,
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// The identity of a file, as the filesystem itself defines it.
///
/// Markpad compares paths to answer one question in three places — "is this
/// the same file?" — and exact string equality gets it wrong three ways:
///
/// - **case**: `/notes/A.md` and `/notes/a.md` are one file on APFS and NTFS.
/// - **Unicode normalization**: `café.md` spelled NFC and NFD are one file on
///   APFS, and no amount of case folding makes those strings equal — they are
///   different code points, not different cases.
/// - **symlinks**: `notes/today.md` may be a link to `archive/2026-08-03.md`.
///
/// Which of those hold is a property of the **volume**, not of the platform:
/// macOS can be formatted case-sensitive (APFSX), Linux can mount a
/// case-insensitive volume, and the folding table used is the volume's, not
/// Unicode's. That is why this asks the filesystem via `realpath`
/// (`std::fs::canonicalize`) instead of guessing with `to_lowercase` — the
/// guess is wrong in both directions, and being wrong in the "these are the
/// same file" direction merges two genuinely different documents.
///
/// Symlinks are resolved deliberately. Every caller is really asking "would
/// writing here destroy what that other buffer holds?", and for a link and its
/// target the answer is yes — `atomic_write` above follows links precisely so
/// that a write lands on the real file. Treating them as two documents is what
/// would let two auto-save timers take turns overwriting one file.
///
/// A path that does not exist yet — Save As to a new name — has no canonical
/// form, so the parent directory is canonicalized and the file name appended.
/// That still folds and resolves the directory part, and the file name cannot
/// be an alias of an existing file: if it were, the file would exist and the
/// first branch would have handled it.
pub(crate) fn canonical_identity(path: &Path) -> std::io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(resolved) => Ok(strip_verbatim_prefix(resolved)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let Some(file_name) = path.file_name() else {
                return Err(e);
            };
            let parent = match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
                _ => PathBuf::from("."),
            };
            Ok(strip_verbatim_prefix(fs::canonicalize(parent)?).join(file_name))
        }
        Err(e) => Err(e),
    }
}

/// The encoding label of a plain UTF-8 file — the default for a new buffer
/// and for everything Markpad generates itself (HTML and SVG exports).
const UTF8_LABEL: &str = "UTF-8";
/// UTF-8 with a leading byte order mark. Not a WHATWG label, because WHATWG
/// has no name for it: `encoding_rs` reports both as "UTF-8" and the BOM is
/// carried out of band. Windows editors write it constantly and a save that
/// dropped it would change the file for every other tool that reads it.
const UTF8_BOM_LABEL: &str = "UTF-8-BOM";
const UTF16LE_LABEL: &str = "UTF-16LE";
const UTF16BE_LABEL: &str = "UTF-16BE";

/// Text decoded from a file, together with the fidelity of that decode and
/// the encoding it has to be written back as.
pub(crate) struct DecodedText {
    pub(crate) content: String,
    /// `true` when the decoder could not represent some of the bytes and put
    /// U+FFFD in their place. `content` is then a destructive rendering of the
    /// file: the original bytes cannot be recovered from it, so writing it
    /// back over the source file destroys the document permanently. This is
    /// known exactly once — at the moment of decoding — so it travels to the
    /// frontend with the text it describes, and the frontend refuses that
    /// write (see `documentSession.saveContent`).
    ///
    /// Detection made this rare rather than routine: a GBK document used to
    /// set it on every byte above ASCII, and now sets it only when nothing
    /// decodes the file cleanly — a truncated multi-byte tail, or bytes that
    /// are not text at all.
    pub(crate) lossy: bool,
    /// What `encode_text` needs to turn the buffer back into the bytes it came
    /// from: a WHATWG label (`GBK`, `Big5`, `Shift_JIS`, `windows-1252`, …) or
    /// one of the four constants above. Travels to the frontend, is kept on
    /// the tab, and comes back with the save.
    ///
    /// Always `UTF-8` when `lossy`, so the rescue copy a user writes with Save
    /// As is Unicode rather than a re-encoding of replacement characters.
    pub(crate) encoding: String,
}

/// Decode a document, detecting its encoding the way a browser does.
///
/// Three steps, in the order of how much they can be trusted:
///
/// 1. **A byte order mark decides on its own.** UTF-8, UTF-16LE and UTF-16BE
///    BOMs are unambiguous, and Windows-authored Markdown is full of them.
/// 2. **Valid UTF-8 is UTF-8.** No heuristic gets a say over the encoding
///    every modern file is actually in, and this keeps the common path free.
/// 3. **Otherwise guess**, with `chardetng` — the detector Firefox ships for
///    exactly this question — and decode with what it says. UTF-8 is denied
///    because step 2 has already ruled it out; ISO-2022-JP is allowed, which
///    a browser must not do (it can smuggle script through an escape
///    sequence) and a text editor has no reason not to.
///
/// Known gap: UTF-16 without a BOM. Step 1 misses it and `chardetng` does not
/// look for it by design, so such a file reaches step 3 and is guessed at as a
/// single-byte encoding — readable as nonsense, with every other byte a NUL.
/// It round-trips (the guess is a total mapping, so a save reproduces it), and
/// no BOM-less UTF-16 has been reported; naming it is cheaper than a detector
/// that would have to weigh NUL frequency against genuinely binary input.
///
/// Before this, every read decoded as UTF-8 and substituted U+FFFD, so a
/// legacy-encoded (GBK/Big5/Shift-JIS/CP-1252) document opened as mojibake
/// that could not be saved. The detection is a heuristic and can be wrong;
/// what protects the file is not the guess but `lossy` plus writing back
/// through the same encoding, so the document's TEXT survives a save even
/// when the guess is wrong, and a character the encoding cannot hold is
/// never written at all.
///
/// Text, not bytes. Several legacy encodings spell one character more than
/// one way — Shift_JIS reaches U+2160 at both 0x8754 (NEC) and 0xFA4A (IBM)
/// — and a decode followed by an encode normalises to whichever the encoder
/// prefers. Saving an untouched document written by a tool that chose the
/// other spelling therefore rewrites those bytes, silently and losslessly.
/// This is what every editor with one encoder per encoding does, VS Code
/// included; it is worth knowing before reading `lossy` as a byte-level
/// guarantee, which it is not.
pub(crate) fn decode_text(bytes: &[u8]) -> DecodedText {
    let decoded = |encoding: &'static encoding_rs::Encoding, label: &str, body: &[u8]| {
        let (content, had_errors) = encoding.decode_without_bom_handling(body);
        DecodedText {
            content: content.into_owned(),
            lossy: had_errors,
            encoding: if had_errors { UTF8_LABEL } else { label }.to_owned(),
        }
    };

    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let label = if encoding == encoding_rs::UTF_8 {
            UTF8_BOM_LABEL
        } else {
            encoding.name()
        };
        return decoded(encoding, label, &bytes[bom_len..]);
    }

    if let Ok(content) = std::str::from_utf8(bytes) {
        return DecodedText {
            content: content.to_owned(),
            lossy: false,
            encoding: UTF8_LABEL.to_owned(),
        };
    }

    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, chardetng::Utf8Detection::Deny);
    decoded(encoding, encoding.name(), bytes)
}

/// What `encode_text` refuses with when the buffer holds a character the
/// document's encoding has no representation for — an emoji pasted into a GBK
/// file, say. Matched by `documentSession.saveContent`, which turns it into a
/// translated toast.
///
/// A marker, carrying nothing. The label was in here at first and it was
/// redundant: the frontend passed the encoding INTO this call, so it already
/// knows which one refused.
const UNMAPPABLE_CODE: &str = "ENCODING_UNMAPPABLE";

/// Turn a buffer back into bytes in `label`'s encoding, or refuse.
///
/// The refusals are the point. A legacy encoding covers a fraction of Unicode,
/// so an emoji pasted into a Shift-JIS document has no representation in it —
/// and `encoding_rs::Encoding::encode` would quietly write `&#128512;`, a
/// numeric character reference that is only meaningful in HTML. Reporting the
/// failure leaves the buffer dirty and puts the reason in a toast, which is
/// how the read-only case behaves (#373); writing a corrupted approximation is
/// the same data loss this whole change exists to remove, arriving from the
/// other direction.
///
/// UTF-16 is encoded here rather than by `encoding_rs`, whose UTF-16 encoders
/// are defined by WHATWG to emit UTF-8 — correct for the web, and a silent
/// change of the file's encoding for an editor. Every other label is checked
/// against `output_encoding` for the same substitution.
pub(crate) fn encode_text(content: &str, label: &str) -> Result<Vec<u8>, String> {
    let utf16 = |big_endian: bool| {
        let mut bytes = if big_endian {
            vec![0xFE, 0xFF]
        } else {
            vec![0xFF, 0xFE]
        };
        for unit in content.encode_utf16() {
            let pair = if big_endian {
                unit.to_be_bytes()
            } else {
                unit.to_le_bytes()
            };
            bytes.extend_from_slice(&pair);
        }
        Ok(bytes)
    };

    match label {
        UTF8_LABEL => Ok(content.as_bytes().to_vec()),
        UTF8_BOM_LABEL => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        UTF16LE_LABEL => utf16(false),
        UTF16BE_LABEL => utf16(true),
        _ => {
            let encoding = encoding_rs::Encoding::for_label(label.as_bytes())
                .filter(|encoding| encoding.output_encoding() == *encoding)
                .ok_or_else(|| format!("Unknown text encoding: {label}"))?;
            let (bytes, _, unmappable) = encoding.encode(content);
            if unmappable {
                // A marker, not a sentence. The frontend has to say this in
                // the user's own language — its sibling refusal
                // (`toast.lossySaveBlocked`, for a buffer nothing could
                // decode) is translated six ways, and the reason a save was
                // refused is the half of the message that has to be
                // understood.
                return Err(UNMAPPABLE_CODE.to_owned());
            }
            Ok(bytes.into_owned())
        }
    }
}

pub(crate) fn read_to_string_lossy(path: &str) -> std::io::Result<DecodedText> {
    Ok(decode_text(&fs::read(path)?))
}

/// Length of `bytes` with an incomplete trailing UTF-8 sequence removed.
/// Truncating a file at a raw byte offset can split a multi-byte character;
/// dropping the partial tail keeps the preview from ending in a replacement
/// character. Only the tail is inspected — a file that is not UTF-8 at all
/// must still produce a full-length (lossy) preview, so earlier bytes are
/// left alone.
pub(crate) fn utf8_truncation_boundary(bytes: &[u8]) -> usize {
    let len = bytes.len();
    // A UTF-8 sequence is at most four bytes, so at most three trailing bytes
    // can belong to an unfinished one.
    for back in 1..=3.min(len) {
        let index = len - back;
        let byte = bytes[index];
        if byte & 0b1100_0000 == 0b1000_0000 {
            // Continuation byte; keep walking left for its lead byte.
            continue;
        }
        let needed = if byte & 0b1000_0000 == 0 {
            1
        } else if byte & 0b1110_0000 == 0b1100_0000 {
            2
        } else if byte & 0b1111_0000 == 0b1110_0000 {
            3
        } else if byte & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            // Not a valid lead byte, so this is not a split character.
            return len;
        };
        return if back < needed { index } else { len };
    }
    len
}

pub(crate) fn safe_path_component<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\'])
        || Path::new(value).is_absolute()
    {
        return Err(format!("Invalid {}", label));
    }
    Ok(value)
}

pub(crate) fn resolve_image_directory(
    parent_dir: &str,
    image_directory: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(parent_dir)
        .canonicalize()
        .map_err(|e| format!("Invalid image parent directory: {}", e))?;
    let requested_dir = if image_directory.is_empty() {
        root.clone()
    } else {
        root.join(safe_path_component(image_directory, "image directory")?)
    };

    fs::create_dir_all(&requested_dir).map_err(|e| e.to_string())?;
    let image_dir = requested_dir.canonicalize().map_err(|e| e.to_string())?;
    if !image_dir.starts_with(&root) {
        return Err("Image directory must remain inside the document directory".to_string());
    }
    Ok((root, image_dir))
}

pub(crate) fn ensure_path_within_root(root: &Path, path: &Path) -> Result<(), String> {
    let resolved = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            path.canonicalize().map_err(|e| e.to_string())?
        }
        _ => path.to_path_buf(),
    };
    if resolved.starts_with(root) {
        Ok(())
    } else {
        Err("Image path must remain inside the document directory".to_string())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp_path(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("markpad-{tag}-{nonce}"))
    }

    /// A directory to work in, so the case/normalization probes below cannot
    /// collide with anything else in the temp dir.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = temp_path(tag);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Does the volume `dir` lives on fold case? The tests below assert
    /// different things depending on the answer, because the point of
    /// `canonical_identity` is that it reports what the FILESYSTEM does rather
    /// than what the platform usually does — a case-sensitive volume on macOS
    /// and a case-insensitive volume on Linux both exist and both must work.
    fn folds_case(dir: &Path) -> bool {
        let upper = dir.join("CaseProbe.md");
        fs::write(&upper, b"probe").unwrap();
        let found = fs::metadata(dir.join("caseprobe.md")).is_ok();
        fs::remove_file(&upper).unwrap();
        found
    }

    #[test]
    fn canonical_identity_reports_what_the_filesystem_does_about_case() {
        let dir = temp_dir("canon-case");
        let real = dir.join("Alpha.md");
        fs::write(&real, b"body").unwrap();

        let by_real = canonical_identity(&real).unwrap();
        let lowered = dir.join("alpha.md");
        // What the frontend consumes is whether these two come out EQUAL, so
        // that is what gets asserted — not whether the lookup happened to
        // succeed. Asking `is_err()` here tested the mechanism instead of the
        // property, and got it wrong: on a case-sensitive volume the lowercase
        // spelling names no file, but `canonical_identity` still answers for it
        // through the parent-directory fallback that Save As depends on.
        let by_lowered = canonical_identity(&lowered).ok();

        // Either way, the identity is the name the DIRECTORY holds rather than
        // the spelling that was asked for — otherwise the answer would depend
        // on which spelling happened to be opened first.
        assert_eq!(by_real.file_name().unwrap(), "Alpha.md");

        if folds_case(&dir) {
            // The two spellings name ONE file: opening both must not give two
            // tabs, and saving through one must not be treated as a save to a
            // different file. Both reduce to the same identity string, which
            // is what lets the frontend keep comparing with `===`.
            assert_eq!(
                by_lowered.as_ref(),
                Some(&by_real),
                "one file must have one identity whichever way it is spelled",
            );
        } else {
            // On a case-sensitive volume these are two different files and must
            // keep being two. A `to_lowercase()` scheme would merge them here
            // and quietly close a tab holding a genuinely different document —
            // which is VS Code's open bug #123660, and the thing this whole
            // approach exists to avoid.
            assert_ne!(
                by_lowered.as_ref(),
                Some(&by_real),
                "two files must keep two identities",
            );
        }

        fs::remove_file(&real).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn canonical_identity_folds_unicode_normalization_when_the_volume_does() {
        // APFS is normalization-INSENSITIVE as well as case-insensitive: a
        // file written as NFC opens under its NFD spelling and vice versa.
        // Case folding cannot reach this — the two strings differ in code
        // points, not in case — so it is the clearest evidence that the
        // question has to go to the filesystem.
        //
        // The two axes are independent, and all four combinations are real:
        // default APFS folds both, case-sensitive APFS folds only
        // normalization, NTFS folds only case, ext4 folds neither. So this
        // probes normalization on its own rather than inferring it from the
        // case answer or from the platform.
        let dir = temp_dir("canon-nfd");
        let nfc = dir.join("caf\u{e9}.md"); // café
        let nfd = dir.join("cafe\u{301}.md"); // cafe + combining acute
        fs::write(&nfc, b"body").unwrap();

        let by_nfc = canonical_identity(&nfc).unwrap();
        let by_nfd = canonical_identity(&nfd).ok();

        if fs::metadata(&nfd).is_ok() {
            assert_eq!(
                by_nfd.as_ref(),
                Some(&by_nfc),
                "one file must have one identity whichever way it is spelled",
            );
        } else {
            // A volume that keeps them apart really does have two files here,
            // so the identities must stay apart too. As above, the assertion is
            // on the identities and not on whether the lookup succeeded: the
            // NFD spelling names nothing, but the parent-directory fallback
            // still answers for it.
            assert_ne!(
                by_nfd.as_ref(),
                Some(&by_nfc),
                "two files must keep two identities",
            );
        }

        fs::remove_file(&nfc).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn canonical_identity_resolves_a_symlink_to_its_target() {
        // A link and its target are one file for every purpose Markpad has:
        // `atomic_write` follows the link when it writes, so two tabs on the
        // two names would be two auto-save timers on one document.
        let dir = temp_dir("canon-link");
        let target = dir.join("archive.md");
        let link = dir.join("today.md");
        fs::write(&target, b"body").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(
            canonical_identity(&link).unwrap(),
            canonical_identity(&target).unwrap(),
        );

        fs::remove_file(&link).unwrap();
        fs::remove_file(&target).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn canonical_identity_still_answers_for_a_file_that_does_not_exist_yet() {
        // Save As names a file that is not there yet, so `realpath` fails on
        // it. The directory is still resolvable, and that is the part that
        // carries the symlinks and the `..` segments.
        let dir = temp_dir("canon-new");
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();

        let indirect = nested.join("..").join("sub").join("fresh.md");
        assert_eq!(
            canonical_identity(&indirect).unwrap(),
            canonical_identity(&nested).unwrap().join("fresh.md"),
        );

        // A missing DIRECTORY has no identity to report; the caller keeps the
        // literal path, which is what it would have used anyway.
        assert!(canonical_identity(&dir.join("nope").join("x.md")).is_err());

        // The fallback must never manufacture the identity of a file that DOES
        // exist — that would merge a Save As target into an unrelated open
        // document. This is the property both branches above lean on whenever a
        // volume distinguishes two spellings: the spelling that names nothing
        // still gets an identity, and it has to be a different one.
        //
        // It runs on every platform and every volume, which matters because the
        // two axes cannot all be reproduced on one machine: macOS folds Unicode
        // normalization on every filesystem it mounts, so the "normalization
        // distinguishes these" branch of the test above is only ever taken on
        // Linux and Windows. This asserts the same underlying property here.
        let existing = nested.join("taken.md");
        fs::write(&existing, b"body").unwrap();
        assert_ne!(
            canonical_identity(&nested.join("not-taken.md")).unwrap(),
            canonical_identity(&existing).unwrap(),
            "a name that resolves to nothing must not borrow another file's identity",
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn verbatim_prefix_is_stripped_so_paths_stay_displayable() {
        // `canonicalize` returns `\\?\C:\...` on Windows. That string reaches
        // the tab bar, the window title and the recent-files list, and several
        // Win32 APIs reject it, so it never leaves this module.
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\C:\notes\a.md")),
            PathBuf::from(r"C:\notes\a.md"),
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\a.md")),
            PathBuf::from(r"\\server\share\a.md"),
        );
        // Untouched everywhere else.
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from("/notes/a.md")),
            PathBuf::from("/notes/a.md"),
        );
    }

    #[test]
    fn atomic_write_refuses_a_read_only_target() {
        // Replacing an inode by rename only needs write permission on the
        // parent directory, so without an explicit check a `chmod 444` file
        // would be rewritten on Unix and its read-only bit put back, while
        // Windows' MoveFileExW refuses the same operation.
        let path = temp_path("readonly");
        fs::write(&path, b"original").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms).unwrap();

        let error = atomic_write(&path, b"replacement")
            .expect_err("a read-only target must be refused, not silently replaced");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&path).unwrap(), b"original");

        // Deleting needs write permission on the directory rather than the
        // file, so Unix needs no permission restore here; Windows refuses to
        // delete a file that still carries the read-only attribute.
        #[cfg(windows)]
        {
            let mut perms = fs::metadata(&path).unwrap().permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            fs::set_permissions(&path, perms).unwrap();
        }
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn atomic_write_replaces_the_target_and_leaves_no_temp_file() {
        let dir = temp_path("atomic-dir");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        fs::write(&path, b"{\"old\":true}").unwrap();

        atomic_write(&path, b"{\"new\":true}").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"{\"new\":true}");
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("markpad-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_temp_file_an_earlier_run_abandoned_is_swept_by_the_next_write() {
        // #722: temp files accumulating beside a document across sessions.
        // The next save of that document is the moment Markpad knows both the
        // folder and the name, and the only moment it is guaranteed to be
        // looking at them.
        let dir = temp_path("atomic-sweep");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.md");
        fs::write(&path, b"body").unwrap();

        // Old, and with contents — the case that has to wait out
        // `ABANDONED_TEMP_AGE`, because a temp file with a document in it can
        // be the only copy of that document.
        let stale = dir.join(".notes.md.markpad-tmp-4242-1787728728439865400-4");
        fs::write(&stale, b"a whole document").unwrap();
        set_modified_ago(&stale, Duration::from_secs(3 * 60 * 60));

        // Empty, and only minutes old. Nothing in it can be lost, and this is
        // the shape #722 produces one of per save.
        let empty = dir.join(".notes.md.markpad-tmp-4242-1787728728439865400-5");
        fs::write(&empty, b"").unwrap();
        set_modified_ago(&empty, Duration::from_secs(5 * 60));

        // Another document's leftovers, equally stale. The sweep is scoped to
        // the file being written, so a folder full of documents is cleaned by
        // the saves that touch each of them rather than by the first save to
        // reach the folder.
        let neighbour = dir.join(".other.md.markpad-tmp-4242-1787728728439865400-6");
        fs::write(&neighbour, b"").unwrap();
        set_modified_ago(&neighbour, Duration::from_secs(3 * 60 * 60));

        atomic_write(&path, b"edited").unwrap();

        assert!(
            !stale.exists(),
            "an abandoned temp file must not survive a save"
        );
        assert!(
            !empty.exists(),
            "an empty temp file has nothing in it to wait for"
        );
        assert!(
            neighbour.exists(),
            "the sweep must not reach past the document being written",
        );
        assert_eq!(fs::read(&path).unwrap(), b"edited");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_document_nobody_edits_again_is_still_swept() {
        // The reason `sweep_document_temps` is reachable without a write: the
        // per-save sweep only ever clears the folder of a document someone is
        // still editing. Startup calls this for the recent list and the
        // restored tabs, which is the only thing that reaches leftovers beside
        // a document that is never saved again.
        let dir = temp_path("atomic-sweep-startup");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("archived.md");
        fs::write(&path, b"body").unwrap();

        let leftover = dir.join(".archived.md.markpad-tmp-4242-1787728728439865400-4");
        fs::write(&leftover, b"").unwrap();
        set_modified_ago(&leftover, Duration::from_secs(5 * 60));

        sweep_document_temps(&path);

        assert!(!leftover.exists());
        assert_eq!(
            fs::read(&path).unwrap(),
            b"body",
            "sweeping must not touch the document itself",
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_temp_file_that_could_still_be_in_flight_is_left_alone() {
        // The dangerous half of a sweep: another Markpad, or another thread
        // here, is between `create_new` and `rename` right now. Deleting its
        // temp file fails its rename with ENOENT — the exact breakage
        // `concurrent_atomic_writes_to_one_target_all_succeed` exists for. A
        // write in that window is milliseconds old, and it is EMPTY for the
        // stretch between `create_new` and `write_all`, so age has to be the
        // first question the sweep asks and the empty-file rule the second.
        let dir = temp_path("atomic-sweep-live");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.md");
        fs::write(&path, b"body").unwrap();

        let just_created = dir.join(".notes.md.markpad-tmp-4242-1787728728439865400-4");
        fs::write(&just_created, b"").unwrap();
        let half_written = dir.join(".notes.md.markpad-tmp-4242-1787728728439865400-5");
        fs::write(&half_written, b"half a document").unwrap();

        atomic_write(&path, b"edited").unwrap();

        assert!(
            just_created.exists(),
            "a temp file young enough to be a live write must survive, empty or not",
        );
        assert!(half_written.exists());

        fs::remove_dir_all(dir).unwrap();
    }

    /// Backdate `path`'s mtime, which is what the sweep reads to tell an
    /// abandoned temp file from a live one.
    fn set_modified_ago(path: &Path, ago: Duration) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(SystemTime::now() - ago))
            .unwrap();
    }

    #[test]
    fn concurrent_atomic_writes_to_one_target_all_succeed() {
        // Two threads used to derive the same temp name from the same clock
        // reading (macOS ticks coarser than a nanosecond), and the collision
        // took down *both* writers: the loser of `create_new` got EEXIST, and
        // its cleanup deleted the winner's temp file, so the winner's rename
        // failed with ENOENT. Concurrent writers are ordinary here — every
        // `save_file`, theme write and window-state flush shares this path.
        let dir = temp_path("atomic-concurrent");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("contended.json");

        const WRITERS: usize = 8;
        let bodies: Vec<Vec<u8>> = (0..WRITERS)
            .map(|i| format!("{{\"writer\":{i}}}").into_bytes())
            .collect();

        let failures: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = bodies
                .iter()
                .map(|body| {
                    let path = path.as_path();
                    scope.spawn(move || atomic_write(path, body).map_err(|e| e.to_string()))
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().unwrap().err())
                .collect()
        });
        assert!(
            failures.is_empty(),
            "every concurrent write must succeed, got: {failures:?}",
        );

        // Last writer wins, and the winner is whole: a torn or empty file
        // would mean the rename published a temp file some other thread had
        // deleted or was still filling.
        let final_bytes = fs::read(&path).unwrap();
        assert!(
            bodies.contains(&final_bytes),
            "final contents are not one of the values written: {:?}",
            String::from_utf8_lossy(&final_bytes),
        );

        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("markpad-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    // --- Decode fidelity ------------------------------------------------
    //
    // #372: a legacy-encoded document used to be decoded as UTF-8 with U+FFFD
    // substituted for every byte the decoder disagreed with, and writing that
    // buffer back destroyed the file — U+FFFD is not reversible. The decoder
    // now detects the encoding instead, and the save writes the same encoding
    // back, so the bytes on disk survive a save that changed nothing.
    //
    // The load-bearing assertion in most of these is the byte-for-byte round
    // trip. Whether the detector names the encoding the author had in mind is
    // a heuristic and can be wrong; what protects the document is that the
    // bytes it produces are the bytes it was given.

    /// A Simplified Chinese line long enough for the detector to have
    /// something to work with — four bytes of CJK could be almost any legacy
    /// codepage, and a real document never is that short.
    pub(crate) const CHINESE_SAMPLE: &str =
        "# 中文标题\n\n这是一个用国标编码保存的文档，里面全是汉字。\n";

    /// One realistic document per legacy encoding Markpad is likely to meet.
    /// Each is text that encoding can represent and UTF-8 disagrees with.
    const LEGACY_SAMPLES: [(&encoding_rs::Encoding, &str); 4] = [
        (encoding_rs::GBK, CHINESE_SAMPLE),
        (
            encoding_rs::BIG5,
            "# 中文標題\n\n這是一個用大五碼儲存的文件。\n",
        ),
        (
            encoding_rs::SHIFT_JIS,
            "# 日本語の見出し\n\nこれはシフトJISで保存された文書です。\n",
        ),
        (
            encoding_rs::WINDOWS_1252,
            "# Café résumé\n\nNaïve façade — priced at 50\u{A0}£.\n",
        ),
    ];

    pub(crate) fn legacy_bytes(encoding: &'static encoding_rs::Encoding, text: &str) -> Vec<u8> {
        let (bytes, _, unmappable) = encoding.encode(text);
        assert!(
            !unmappable,
            "fixture must be representable in {}",
            encoding.name()
        );
        assert!(
            std::str::from_utf8(&bytes).is_err(),
            "fixture must not also be valid UTF-8, or it proves nothing",
        );
        bytes.into_owned()
    }

    /// The bug, in one assertion: these bytes must not come back as U+FFFD.
    #[test]
    fn a_legacy_encoded_document_decodes_instead_of_becoming_replacement_characters() {
        for (encoding, text) in LEGACY_SAMPLES {
            let decoded = decode_text(&legacy_bytes(encoding, text));

            assert!(
                !decoded.lossy,
                "{} was reported as undecodable",
                encoding.name()
            );
            assert!(
                !decoded.content.contains('\u{FFFD}'),
                "{} decoded to mojibake: {:?}",
                encoding.name(),
                decoded.content,
            );
            assert_eq!(
                decoded.content,
                text,
                "{} decoded to the wrong text",
                encoding.name()
            );
        }
    }

    /// The destructive path itself: open a legacy file, save it back
    /// unchanged, and the file on disk must be the file that was opened. This
    /// is the test that fails if anything ever routes a save through UTF-8
    /// again.
    #[test]
    fn saving_an_unedited_legacy_document_reproduces_its_canonical_bytes() {
        // CANONICAL, not "the bytes any tool would have written": the samples
        // below are encoded by `encoding_rs` itself, so this pins the round
        // trip for the spelling its encoder emits. Where a legacy encoding
        // offers a second spelling of the same character (Shift_JIS's IBM
        // extension, for one) a save normalises to this one. See the note on
        // `decode_text` — the guarantee is over the text, not the bytes.
        for (encoding, text) in LEGACY_SAMPLES {
            let original = legacy_bytes(encoding, text);
            let decoded = decode_text(&original);
            assert!(!decoded.lossy, "{} decode was lossy", encoding.name());

            let written = encode_text(&decoded.content, &decoded.encoding)
                .unwrap_or_else(|e| panic!("{} could not be written back: {e}", encoding.name()));
            assert_eq!(
                written,
                original,
                "a save of an unedited {} document changed the file",
                encoding.name(),
            );
        }
    }

    /// The reported symptom, from the other side: the U+FFFD buffer the old
    /// decoder produced cannot be turned back into the document. Not a test of
    /// current behaviour — a statement of why the round trip above has to be
    /// the mechanism rather than a nicety.
    #[test]
    fn a_lossy_decode_cannot_be_reversed() {
        let original = legacy_bytes(encoding_rs::GBK, CHINESE_SAMPLE);
        let mojibake = String::from_utf8_lossy(&original).into_owned();

        assert!(mojibake.contains('\u{FFFD}'));
        assert_ne!(mojibake.into_bytes(), original);
    }

    #[test]
    fn valid_utf8_is_never_handed_to_the_detector() {
        // Detection is a heuristic; UTF-8 is not. A file that decodes as UTF-8
        // is UTF-8, whatever a frequency table thinks of it.
        let decoded = decode_text("中文".as_bytes());
        assert!(!decoded.lossy);
        assert_eq!(decoded.content, "中文");
        assert_eq!(decoded.encoding, UTF8_LABEL);
    }

    #[test]
    fn a_byte_order_mark_survives_the_round_trip() {
        // Windows-authored Markdown, all three flavours. The BOM is kept out
        // of the buffer — `\u{FEFF}# Title` is not a heading, so leaving it in
        // silently un-renders the first line — and put back on the save.
        for (label, bom) in [
            (UTF8_BOM_LABEL, vec![0xEF, 0xBB, 0xBF]),
            (UTF16LE_LABEL, vec![0xFF, 0xFE]),
            (UTF16BE_LABEL, vec![0xFE, 0xFF]),
        ] {
            let text = "# Title\n\nBody.\n";
            let mut original = bom;
            match label {
                UTF16LE_LABEL => original.extend(text.encode_utf16().flat_map(u16::to_le_bytes)),
                UTF16BE_LABEL => original.extend(text.encode_utf16().flat_map(u16::to_be_bytes)),
                _ => original.extend_from_slice(text.as_bytes()),
            }

            let decoded = decode_text(&original);
            assert!(!decoded.lossy, "{label} decode was lossy");
            assert_eq!(decoded.encoding, label);
            assert_eq!(decoded.content, text, "{label} left the BOM in the buffer");
            assert_eq!(
                encode_text(&decoded.content, &decoded.encoding).unwrap(),
                original,
                "a save dropped or moved the {label} byte order mark",
            );
        }
    }

    #[test]
    fn bytes_nothing_decodes_are_still_reported_as_lossy() {
        // The guard that predates detection has to keep working, because
        // detection does not make every file readable: a UTF-16 document with
        // a half character at the end has no faithful reading, and the buffer
        // it produces must not be written back over it. Reported as UTF-8 so
        // the Save As rescue copy is Unicode rather than a re-encoding of
        // replacement characters.
        let truncated = [0xFF, 0xFE, b'A', 0x00, b'B'];

        let decoded = decode_text(&truncated);
        assert!(decoded.lossy, "got {:?}", decoded.content);
        assert!(decoded.content.contains('\u{FFFD}'));
        assert_eq!(decoded.encoding, UTF8_LABEL);
    }

    #[test]
    fn a_character_the_encoding_cannot_represent_fails_the_save() {
        // Typing an emoji into a GBK document. `encoding_rs::encode` would
        // write `&#128512;` — an HTML escape, in a Markdown file, replacing
        // the character the user typed. Refusing leaves the buffer dirty and
        // sends the reason to a toast, which is how a read-only file behaves.
        let error = encode_text("hello 😀", "GBK").unwrap_err();

        // A code the frontend can match, carrying the label it has to name.
        // The wording itself lives in `i18n.ts`, translated: the reason a save
        // was refused is the half of the message that must be understood, and
        // an English sentence from Rust is the half that would not be.
        assert_eq!(error, "ENCODING_UNMAPPABLE");

        assert!(encode_text("hello 😀", UTF8_LABEL).is_ok());
        // UTF-16 holds every character too, and takes the other branch.
        assert!(encode_text("hello 😀", UTF16LE_LABEL).is_ok());
    }

    #[test]
    fn an_unrecognised_encoding_label_is_refused_rather_than_defaulted() {
        // The label makes a round trip through the frontend, so it is untrusted
        // input by the time it comes back. Falling back to UTF-8 here would
        // write the wrong bytes over the file the label came from.
        assert!(encode_text("text", "definitely-not-an-encoding").is_err());
        // WHATWG defines the UTF-16 and `replacement` ENCODERS as emitting
        // UTF-8, which for a browser is a security rule and for an editor is a
        // silent conversion of the user's file. UTF-16 is handled before this
        // branch; `replacement` has no business getting past it.
        assert!(encode_text("text", "iso-2022-kr").is_err());
    }

    #[test]
    fn read_file_content_checked_reports_the_encoding_it_used() {
        let path = temp_path("gbk-checked.md");
        let original = legacy_bytes(encoding_rs::GBK, CHINESE_SAMPLE);
        fs::write(&path, &original).unwrap();

        let decoded = read_to_string_lossy(path.to_str().unwrap()).unwrap();
        fs::remove_file(&path).unwrap();

        assert!(!decoded.lossy);
        assert_eq!(decoded.content, CHINESE_SAMPLE);
        assert_eq!(
            encode_text(&decoded.content, &decoded.encoding).unwrap(),
            original,
        );
    }

    #[test]
    fn truncation_boundary_drops_only_a_split_trailing_character() {
        assert_eq!(utf8_truncation_boundary(&[]), 0);
        assert_eq!(utf8_truncation_boundary(b"ab"), 2);

        let three_byte = "中".as_bytes();
        assert_eq!(utf8_truncation_boundary(three_byte), 3);
        assert_eq!(utf8_truncation_boundary(&three_byte[..2]), 0);
        assert_eq!(utf8_truncation_boundary(&three_byte[..1]), 0);

        let four_byte = "🙂".as_bytes();
        assert_eq!(utf8_truncation_boundary(four_byte), 4);
        assert_eq!(utf8_truncation_boundary(&four_byte[..3]), 0);

        // Only the tail is affected; earlier bytes are kept.
        let mixed = "ab中".as_bytes();
        assert_eq!(utf8_truncation_boundary(&mixed[..4]), 2);

        // A buffer that is not UTF-8 at all must still yield a full-length
        // preview; at most the last three bytes can ever be dropped.
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        assert!(utf8_truncation_boundary(&gbk) >= gbk.len() - 3);
    }

    #[test]
    fn path_components_reject_traversal_separators_and_absolute_paths() {
        for invalid in [
            "",
            ".",
            "..",
            "../theme",
            "folder/theme",
            "folder\\theme",
            "/tmp/theme",
        ] {
            assert!(safe_path_component(invalid, "test").is_err(), "{invalid}");
        }
        assert_eq!(
            safe_path_component("SynthWave '84", "test").unwrap(),
            "SynthWave '84"
        );
    }

    #[cfg(unix)]
    #[test]
    fn image_directory_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("markpad-path-root-{nonce}"));
        let outside = std::env::temp_dir().join(format!("markpad-path-outside-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("images")).unwrap();

        assert!(resolve_image_directory(root.to_str().unwrap(), "images").is_err());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
