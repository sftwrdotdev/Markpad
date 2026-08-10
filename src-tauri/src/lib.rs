use comrak::nodes::NodeValue;
use comrak::{markdown_to_html, parse_document, Anchorizer, Arena, Options};
use regex::{Captures, Regex};
use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// `![[target]]` / `![[target|size]]`. Deliberately NOT `(?s)`: `.` must not
/// match a newline, so the pattern cannot pair a lone `![[` in prose with the
/// `]]` of a real embed several lines below. Obsidian's embed syntax does not
/// span lines either, so a stray opener is simply not an embed.
///
/// This is a line-count question, not only a correctness one — see the line
/// contract in `mod tests`. With `(?s)` the lazy `.*?` swallowed every line in
/// between into an `<img src>`, destroying the prose *and* renumbering every
/// task checkbox below it. Not matching (rather than matching and bailing out)
/// also leaves the later, well-formed embed free to render.
static INTERNAL_EMBED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[\[(.*?)\]\]").expect("valid regex literal"));
/// `[[target]]` / `[[target|alias]]` where the target names a heading — either
/// in this document (`#Setup`) or in another file (`Notes#Setup`). The `#` is
/// required: a wikilink without one is a bare note link, which Markpad has
/// never resolved and which this pattern deliberately does not claim (see the
/// `wikilinks_without_a_heading_are_deliberately_left_literal` test). The `#`
/// here is only a cheap prefilter — it can also fall in the alias half, so
/// `process_wikilinks` re-checks that the target half really has one.
/// The inner text stops at the first `]`, as the narrower `[[#…]]` pattern
/// this replaced also did.
static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[([^\]]*#[^\]]*)\]\]").expect("valid regex literal"));
/// ` ^block-id` at the end of a line. The leading whitespace is captured
/// because Obsidian also accepts a block id alone on the line after the block
/// it names, and `\s+` then spans the newline: the replacement has to put that
/// newline back, or the anchor is folded onto the previous line and every line
/// below it moves up one (see the line contract in `mod tests`).
static BLOCK_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)(\s+)\^([a-zA-Z0-9_-]+)$").expect("valid regex literal"));
/// The rendered task-list `<input>` this pass is allowed to mark.
///
/// The boolean attributes are matched as an unordered set rather than in a
/// fixed order. comrak 0.18 emitted `disabled="" checked=""` and 0.54 emits
/// `checked="" disabled=""`; the old pattern spelled the 0.18 order out, so
/// under 0.54 it stopped matching *completed* tasks only — every `- [x]` item
/// silently lost `data-task-checkbox` and became untoggleable while every
/// `- [ ]` item kept working. Nothing about the contract depends on the order,
/// so the pattern no longer depends on it either.
static TASK_ITEM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        // The two `class` groups are optional so this holds whether or not
        // `tasklist_classes` is on. It is on (see `markdown_options`), which
        // is what makes the CSS work — but writing the classes in as required
        // would mean flipping that option back would silently stop annotating
        // the checkboxes rather than fail a test, and an unannotated checkbox
        // is one the preview cannot toggle at all.
        r#"<li(?: class="task-list-item")? data-sourcepos="(?<sourcepos>(?<line>\d+):\d+-\d+:\d+)">(?<input><input type="checkbox"(?: class="task-list-item-checkbox")?(?: (?:checked|disabled)="")* />)"#,
    )
    .expect("valid regex literal")
});
static TASK_SOURCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\](?:\s|$)").expect("valid regex literal")
});

/// Distinguishes the temp files of `atomic_write` calls that share a process.
/// Never reset, and read with `fetch_add` so no two callers can be handed the
/// same value — the property the wall clock could not supply.
static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(0);

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
    if existing_perms.as_ref().is_some_and(|perms| perms.readonly()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is read-only", target.display()),
        ));
    }

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "markpad".to_string());

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

    if let Err(e) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    // Atomic on both Unix and modern Windows: std::fs::rename uses
    // `rename(2)` (POSIX) or `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`
    // (Windows since Rust 1.35). The destination is either fully replaced
    // or left untouched — never partially overwritten or missing. If the
    // rename fails (e.g. target locked by another process on Windows),
    // we clean up the temp file and surface the original error without
    // touching the target.
    if let Err(e) = fs::rename(&temp_path, target) {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
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
struct DecodedText {
    content: String,
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
    lossy: bool,
    /// What `encode_text` needs to turn the buffer back into the bytes it came
    /// from: a WHATWG label (`GBK`, `Big5`, `Shift_JIS`, `windows-1252`, …) or
    /// one of the four constants above. Travels to the frontend, is kept on
    /// the tab, and comes back with the save.
    ///
    /// Always `UTF-8` when `lossy`, so the rescue copy a user writes with Save
    /// As is Unicode rather than a re-encoding of replacement characters.
    encoding: String,
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
fn decode_text(bytes: &[u8]) -> DecodedText {
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
fn encode_text(content: &str, label: &str) -> Result<Vec<u8>, String> {
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

fn read_to_string_lossy(path: &str) -> std::io::Result<DecodedText> {
    Ok(decode_text(&fs::read(path)?))
}

/// Length of `bytes` with an incomplete trailing UTF-8 sequence removed.
/// Truncating a file at a raw byte offset can split a multi-byte character;
/// dropping the partial tail keeps the preview from ending in a replacement
/// character. Only the tail is inspected — a file that is not UTF-8 at all
/// must still produce a full-length (lossy) preview, so earlier bytes are
/// left alone.
fn utf8_truncation_boundary(bytes: &[u8]) -> usize {
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

/// HTML-escapes `value` for use inside a double-quoted attribute. Embed
/// rewriting builds `<img …>` by string concatenation, so an unescaped quote
/// in a wikilink target (`![[a" onerror="…]]`) would break out of the
/// attribute. The in-app viewer sanitizes with DOMPurify, but the HTML export
/// path writes this markup straight to disk.
fn escape_html_attribute(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// The comrak configuration the preview is rendered with.
///
/// Extracted because a second reader of the document — `heading_anchors`, for
/// the editor's link completion — has to parse it the same way the renderer
/// does, or it reports ids for headings the renderer never made and misses the
/// ones it did.
fn markdown_options<'a>() -> Options<'a> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    // Fifteen rules in styles.css hang off `li.task-list-item` and
    // `ul.contains-task-list` — the bullet suppression and the grid that puts
    // the checkbox beside its text — and comrak emits neither class unless
    // this is on. It defaulted to off, so all fifteen were dead: task lists
    // rendered with the list bullet still showing AND the checkbox on its own
    // line above the text. The classes are GitHub's, which is where those
    // selectors came from.
    //
    // They went missing in the 0.18 → 0.54 upgrade (#426) together with the
    // `disabled` change #320/#345 fixed, and unlike that one nobody reported
    // it as its own defect — it arrived looking like part of the same
    // breakage. #148 is where it finally surfaced, in a reader's screenshot.
    options.render.tasklist_classes = true;
    // `++ins++` — Pandoc's and CriticMarkup's spelling for inserted text, and
    // plain characters here until now. It is the only one of its group worth
    // taking, and the rule that decided the others is worth stating, because
    // it is not "is this syntax popular":
    //
    //     Accept a dialect only where it cannot misread ORDINARY TEXT.
    //
    // Measured against this renderer, three failed that:
    //
    //   `subscript` (`~sub~`). GFM defines strikethrough as "one or two
    //   tildes", so `~x~` is struck-through on GitHub and here. Subscripts
    //   take that spelling away, and a valid GFM document starts rendering
    //   differently in this app. `<sub>2</sub>` works in both places.
    //
    //   `superscript` (`^sup^`). Worse than taking a spelling — it takes
    //   PROSE. Two carets in a paragraph pair up, so `a^2 + b^2 = c^2`, which
    //   renders as written today both here and on GitHub, would become
    //   `a<sup>2 + b</sup>2 = c^2`.
    //
    //   `spoiler` (`||text||`). `||` is also an empty table cell: with
    //   spoilers on, `| 1 || 3 |` collapses into one cell reading "1 || 3".
    //
    // `++` passed: nothing else claims it, and `i++ then j++`, `C++ and C++`
    // and a `+` list all come through untouched. See `syntax_coexistence`,
    // `the_syntaxes_that_would_misread_ordinary_text` and
    // `an_empty_table_cell_is_not_a_spoiler`.
    //
    // `==highlight==` and `^[a note]` are parsed rather than pre-rewritten.
    // The regexes these replace could not see across a line break or past a
    // nested `]`, and each needed its own scan to avoid firing inside code.
    options.extension.highlight = true;
    options.extension.inline_footnotes = true;
    options.extension.insert = true;
    options.extension.footnotes = true;
    options.extension.description_lists = true;
    // `header_ids` in 0.18; the option only ever set the *prefix* prepended to
    // the anchorized heading text, and 0.52 renamed it to say so. `Some("")`
    // means "ids on, no prefix" in both spellings.
    options.extension.header_id_prefix = Some(String::new());
    options.render.r#unsafe = true;
    options.render.hardbreaks = true;
    options.render.sourcepos = true;
    options
}

/// The anchor id comrak assigns to a heading with this text. We call comrak's
/// own `Anchorizer` rather than re-implementing its rules (lowercase, strip
/// everything outside letters/marks/numbers/underscore/space/hyphen, spaces
/// to hyphens), so a comrak upgrade cannot silently desynchronize wikilink
/// targets from the ids actually rendered into the document.
///
/// A fresh anchorizer is used per lookup on purpose: its duplicate handling
/// appends `-1`, `-2`, … per *document*, and a link target can only ever
/// address the first heading with a given text.
fn heading_anchor_id(target: &str) -> String {
    Anchorizer::new().anchorize(target.trim())
}

/// File extensions the viewer will open as a document. Mirrors
/// `hasMarkdownLinkExtension` in src/lib/utils/markdownLinks.ts — a wikilink
/// whose href does not end in one of these is not claimed by the frontend's
/// local-navigation path at all, so emitting one would produce a link that
/// escapes to the external-URL opener instead of opening a tab.
const MARKDOWN_LINK_EXTENSIONS: [&str; 5] = ["md", "markdown", "mdown", "mkd", "txt"];

/// The extension of the last path component, if the trailing `.segment` really
/// reads as one. `v1.2 spec` has none (the tail is not alphanumeric) and
/// neither does `.gitignore` (no stem before the dot).
fn link_path_extension(path: &str) -> Option<&str> {
    let name = path.rsplit(['/', '\\']).next()?;
    let (stem, ext) = name.rsplit_once('.')?;
    let plausible = !stem.is_empty()
        && (1..=8).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric());
    plausible.then_some(ext)
}

/// Percent-encodes the characters that would otherwise end or corrupt a
/// markdown link destination (space, parentheses, angle brackets, quote) or
/// that the frontend's own href parsing reads as structure (`?`, which
/// `getMarkdownLinkTarget` strips as a query string). `%` is encoded first so
/// that a literal percent in a filename survives the frontend's
/// `decodeURIComponent`.
fn encode_link_destination(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for character in path.chars() {
        match character {
            '%' => encoded.push_str("%25"),
            ' ' => encoded.push_str("%20"),
            '(' => encoded.push_str("%28"),
            ')' => encoded.push_str("%29"),
            '<' => encoded.push_str("%3C"),
            '>' => encoded.push_str("%3E"),
            '"' => encoded.push_str("%22"),
            '?' => encoded.push_str("%3F"),
            _ => encoded.push(character),
        }
    }
    encoded
}

/// The link destination for the file half of a wikilink, or `None` when the
/// target is not something the viewer can open — in which case the wikilink is
/// left as literal text rather than turned into a link that goes nowhere
/// useful.
///
/// Obsidian writes note links without an extension (`[[Notes#Setup]]`) and
/// resolves them against a vault index. Markpad has no index, so the target is
/// treated as a path relative to the current document — the same resolution a
/// plain `[text](../other.md)` link already gets — and `.md` is appended when
/// the target carries no extension of its own.
fn wikilink_file_destination(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() || path.ends_with('/') || path.ends_with('\\') {
        return None;
    }
    match link_path_extension(path) {
        Some(extension) => MARKDOWN_LINK_EXTENSIONS
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
            .then(|| encode_link_destination(path)),
        None => Some(format!("{}.md", encode_link_destination(path))),
    }
}

fn safe_path_component<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
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

fn resolve_image_directory(parent_dir: &str, image_directory: &str) -> Result<(PathBuf, PathBuf), String> {
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

fn ensure_path_within_root(root: &Path, path: &Path) -> Result<(), String> {
    let resolved = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => path.canonicalize().map_err(|e| e.to_string())?,
        _ => path.to_path_buf(),
    };
    if resolved.starts_with(root) {
        Ok(())
    } else {
        Err("Image path must remain inside the document directory".to_string())
    }
}

const MAX_VSIX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_VSIX_ENTRIES: usize = 10_000;
const MAX_VSIX_UNCOMPRESSED_BYTES: u64 = 100 * 1024 * 1024;
const MAX_THEME_JSON_BYTES: u64 = 2 * 1024 * 1024;
const VSIX_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const VSIX_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Reads a VSIX entry as text under a hard byte ceiling.
///
/// The `size()` checks elsewhere use the size the archive *declares* in its
/// central directory, which a hostile file is free to understate — the zip
/// reader only bounds the *compressed* stream, so a small entry claiming to
/// be 1 KB can still inflate without limit. Reading through `take` makes the
/// ceiling apply to the bytes actually produced.
fn read_zip_entry_to_string<R: std::io::Read>(entry: R, limit: u64) -> Result<String, String> {
    use std::io::Read;
    let mut text = String::new();
    entry
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > limit {
        return Err("VSIX entry exceeds the allowed size".to_string());
    }
    Ok(text)
}

fn validate_vsix_archive_limits<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(), String> {
    if archive.len() > MAX_VSIX_ENTRIES {
        return Err("VSIX contains too many files".to_string());
    }

    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|e| e.to_string())?;
        total_size = total_size
            .checked_add(file.size())
            .ok_or("VSIX uncompressed size overflow")?;
        if total_size > MAX_VSIX_UNCOMPRESSED_BYTES {
            return Err("VSIX expands beyond the allowed size".to_string());
        }
    }
    Ok(())
}

mod asset_protocol;
mod error;
mod tab_transfer;
mod window_runtime;
use window_runtime::{AppState, WatcherState};

/// Byte ranges of code regions — fenced code blocks and inline code spans —
/// paired with CommonMark's rules. The regex alternation previously used for
/// protection (```` ```.*?```|`.*?` ````) cannot express them: a fence closes
/// only on a line-leading run of the same character at least as long as the
/// opener, and a span opened by N backticks closes only on a run of exactly
/// N. One mismatched pairing (e.g. a 4-backtick inline sample, or a ~~~
/// fence, which the old pattern did not know at all) desynchronized the
/// protection for the entire rest of the document.
///
/// The result is in ascending document order, which is not cosmetic:
/// `in_code_region` binary-searches it. That order is produced by
/// construction rather than by a sort at the end — the scan alternates
/// between the two kinds of region (the text before a fence, then the fence,
/// then the text after it), so each push is at a higher offset than the last.
/// The previous shape collected fences here and appended every inline span in
/// a second pass afterwards, which left the vector unsorted for any document
/// containing both, and made a single `sort_unstable()` call the only thing
/// standing between the search and a wrong answer.
fn code_region_ranges(content: &str) -> Vec<(usize, usize)> {
    let len = content.len();
    let mut regions: Vec<(usize, usize)> = Vec::new();
    // (fence char, opener run length, region start)
    let mut fence: Option<(u8, usize, usize)> = None;
    let mut seg_start = 0usize;

    let mut line_start = 0usize;
    while line_start < len {
        let line_end = content[line_start..]
            .find('\n')
            .map(|i| line_start + i + 1)
            .unwrap_or(len);
        let line = &content[line_start..line_end];
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let marker = trimmed.as_bytes().first().copied();
        let run_len = trimmed
            .as_bytes()
            .iter()
            .take_while(|&&b| Some(b) == marker)
            .count();
        let is_fence_line = indent <= 3
            && matches!(marker, Some(b'`') | Some(b'~'))
            && run_len >= 3;

        match fence {
            Some((ch, opener_len, start)) => {
                if is_fence_line
                    && marker == Some(ch)
                    && run_len >= opener_len
                    && trimmed[run_len..].trim().is_empty()
                {
                    regions.push((start, line_end));
                    fence = None;
                    seg_start = line_end;
                }
            }
            None => {
                // The info string of a backtick fence may not contain backticks.
                let info_ok = marker != Some(b'`') || !trimmed[run_len..].contains('`');
                if is_fence_line && info_ok {
                    // Before the fence region itself, so the two kinds of
                    // region stay interleaved in document order.
                    if seg_start < line_start {
                        push_inline_code_spans(content, seg_start, line_start, &mut regions);
                    }
                    fence = Some((marker.expect("fence marker"), run_len, line_start));
                }
            }
        }
        line_start = line_end;
    }
    match fence {
        // An unclosed fence runs to the end of the input.
        Some((_, _, start)) => regions.push((start, len)),
        None => {
            if seg_start < len {
                push_inline_code_spans(content, seg_start, len, &mut regions);
            }
        }
    }

    debug_assert!(
        regions.windows(2).all(|pair| pair[0] <= pair[1]),
        "code_region_ranges emitted regions out of document order, which \
         makes in_code_region's binary search miss them: {regions:?}",
    );
    regions
}

/// Splits `content[start..end]` — a stretch of text between fences — into
/// blocks and records the inline code spans of each.
///
/// CommonMark parses inline elements one block at a time and a blank line
/// ends a block, so pairing is confined to each blank-line-delimited chunk: a
/// stray backtick in prose must not open a span that runs on until the
/// opening backtick of a real code span paragraphs later, suppressing every
/// embed, wikilink and highlight in between.
fn push_inline_code_spans(
    content: &str,
    start: usize,
    end: usize,
    regions: &mut Vec<(usize, usize)>,
) {
    let mut chunk_start = start;
    let mut line_start = start;
    while line_start < end {
        let line_end = content[line_start..end]
            .find('\n')
            .map(|i| line_start + i + 1)
            .unwrap_or(end);
        if content[line_start..line_end].trim().is_empty() {
            pair_inline_code_runs(content, chunk_start, line_start, regions);
            chunk_start = line_end;
        }
        line_start = line_end;
    }
    pair_inline_code_runs(content, chunk_start, end, regions);
}

/// Records the inline code spans inside `content[start..end]`, which must be
/// a single block's worth of text. A run of N backticks pairs with the next
/// run of exactly N; runs that never pair are literal text.
fn pair_inline_code_runs(content: &str, start: usize, end: usize, regions: &mut Vec<(usize, usize)>) {
    let chunk = &content.as_bytes()[start..end];
    let mut runs: Vec<(usize, usize)> = Vec::new(); // (offset in chunk, len)
    let mut i = 0usize;
    while i < chunk.len() {
        if chunk[i] == b'`' {
            let run_start = i;
            while i < chunk.len() && chunk[i] == b'`' {
                i += 1;
            }
            runs.push((run_start, i - run_start));
        } else {
            i += 1;
        }
    }

    let mut r = 0usize;
    while r < runs.len() {
        let (open_start, open_len) = runs[r];
        if let Some(close) = (r + 1..runs.len()).find(|&j| runs[j].1 == open_len) {
            let (close_start, close_len) = runs[close];
            regions.push((start + open_start, start + close_start + close_len));
            r = close + 1;
        } else {
            r += 1;
        }
    }
}

fn in_code_region(regions: &[(usize, usize)], pos: usize) -> bool {
    regions
        .binary_search_by(|&(s, e)| {
            if pos < s {
                std::cmp::Ordering::Greater
            } else if pos >= e {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Picks the viewer window that should receive an externally opened file:
/// the focused viewer if any, else the viewer the user focused most
/// recently, else any viewer. The middle rung matters for Finder opens —
/// Finder is frontmost at that moment, so is_focused() is false for every
/// Markpad window and delivery would otherwise degrade to arbitrary map
/// order. Viewer windows are "main" and detached "window-*" windows;
/// "installer" never receives files.
fn pick_delivery_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    window_runtime::pick_delivery_window(app)
}

/// Creates the destination window for a tab transfer. The window's label
/// embeds the transfer token ("window-<token>"), so the new frontend can
/// derive which pending transfer to claim from its own label — no URL
/// query involved (the asset protocol 404s on "index.html?x=y" paths).
/// Deliberately async. `WebviewWindowBuilder::build()` deadlocks on Windows
/// when it runs inside a synchronous command: WebView2 needs the main thread
/// to pump messages while the webview is created, but a sync command IS the
/// main thread, blocked waiting for build() to return. The whole app then
/// freezes — no new window, no menus, an unresponsive close button
/// (tauri-apps/tauri#12521). An async command runs off the event loop, and
/// Tauri dispatches the actual window creation to the main thread itself, so
/// macOS's main-thread requirement is still satisfied.
#[tauri::command]
async fn create_transfer_window(app: AppHandle, token: String) -> Result<(), String> {
    window_runtime::create_transfer_window(app, token)
}

fn process_internal_embeds(content: &str) -> Cow<'_, str> {
    let regions = code_region_ranges(content);

    INTERNAL_EMBED_RE.replace_all(content, |caps: &Captures| {
        let full = caps.get(0).unwrap();
        if in_code_region(&regions, full.start()) {
            return full.as_str().to_string();
        }

        let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let mut parts = inner.split('|');
        let path = parts.next().unwrap_or("");
        let size = parts.next();

        // Every interpolated value is HTML-escaped: the target comes straight
        // from the document, so a quote in it would otherwise close the
        // attribute and let the rest be read as markup.
        let src = escape_html_attribute(&path.replace(" ", "%20"));
        let alt = escape_html_attribute(path);

        if let Some(size_str) = size {
            if size_str.contains('x') {
                let mut dims = size_str.split('x');
                let width = escape_html_attribute(dims.next().unwrap_or(""));
                let height = escape_html_attribute(dims.next().unwrap_or(""));
                format!(
                    "<img src=\"{}\" width=\"{}\" height=\"{}\" alt=\"{}\" />",
                    src, width, height, alt
                )
            } else {
                format!(
                    "<img src=\"{}\" width=\"{}\" alt=\"{}\" />",
                    src,
                    escape_html_attribute(size_str),
                    alt
                )
            }
        } else {
            format!("<img src=\"{}\" alt=\"{}\" />", src, alt)
        }
    })
}

fn process_wikilinks<'a>(content: &'a str) -> Cow<'a, str> {
    let mut processed = Cow::Borrowed(content);

    // 1. Process [[#heading]], [[file#heading]] and the |alias form of each.
    //    Obsidian documents all of these (help.obsidian.md/links:
    //    "[[About Obsidian#Links are first-class citizens]]",
    //    "[[2023-01-01#^37066d]]", "[[Example#Details|Section name]]"), and
    //    the file form is what Markpad's own "Copy Reference" menu item puts
    //    on the clipboard — it used to paste back in as dead literal text.
    //
    //    Obsidian's bare note link "[[Notes]]" is NOT handled: it is a
    //    separate feature rather than part of this defect, and claiming every
    //    "[[…]]" would capture bracketed citation numbering ("[[1]]") and
    //    pre-empt CommonMark reference links ("[[foo]]" with a "[foo]: url"
    //    definition). Every Copy Reference call site emits a "#", so requiring
    //    one fixes the defect completely without touching either.
    if WIKILINK_RE.is_match(&processed) {
        let regions = code_region_ranges(&processed);
        let source: &str = &processed;
        let replaced = WIKILINK_RE.replace_all(source, |caps: &Captures| {
            let full = caps.get(0).unwrap();
            let literal = || full.as_str().to_string();
            if in_code_region(&regions, full.start()) {
                return literal();
            }
            // The pattern is line-agnostic, but neither a heading id nor a
            // filename contains a newline, so a target spanning lines can
            // never resolve. Leaving it literal also keeps the line count
            // stable — rewriting it to a single line would shift the source
            // positions of every task checkbox below it (see
            // `multiline_wikilinks_do_not_shift_task_source_positions`).
            if full.as_str().contains('\n') {
                return literal();
            }
            // `![[…]]` is an embed, already rewritten by
            // process_internal_embeds; it is never a link.
            if source.as_bytes()[..full.start()].last() == Some(&b'!') {
                return literal();
            }
            // "[[1#x]](https://example.com)" is a CommonMark link whose text
            // is "[1#x]"; claiming the brackets would strand the "(url)".
            // Requiring a "#" already protects the common citation spelling
            // "[[1]](url)", but not the forms that do carry one.
            if source[full.end()..].starts_with('(') {
                return literal();
            }

            let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let (target, alias) = match inner.split_once('|') {
                Some((target, alias)) => (target, Some(alias)),
                None => (inner, None),
            };
            let alias = alias.filter(|a| !a.trim().is_empty());
            // The `#` the pattern matched may have been in the alias half
            // ("[[Notes|see #1]]"), which is a bare note link, not a heading
            // link. Only a `#` in the target counts.
            let Some((path, heading)) = target.split_once('#') else {
                return literal();
            };
            let (path, heading) = (path.trim(), heading.trim());
            if heading.is_empty() {
                return literal();
            }
            let anchor = heading_anchor_id(heading);

            if path.is_empty() {
                // Same document: [[#Setup]] / [[#Setup|jump]].
                return format!("[{}](#{anchor})", alias.unwrap_or(heading));
            }

            let Some(destination) = wikilink_file_destination(path) else {
                return literal();
            };
            // Obsidian renders an un-aliased heading link as "Note > Heading";
            // keeping that spelling means a pasted reference reads the same in
            // both apps.
            format!(
                "[{}]({destination}#{anchor})",
                alias
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{path} > {heading}")),
            )
        });
        processed = Cow::Owned(replaced.into_owned());
    }

    // 2. Process ^block-id at the end of lines
    // For block IDs, they are trailing. We skip code blocks but also need to be careful with inline code at EOL.
    if BLOCK_ID_RE.is_match(&processed) {
        let regions = code_region_ranges(&processed);
        let replaced = BLOCK_ID_RE.replace_all(&processed, |caps: &Captures| {
            let full = caps.get(0).unwrap();
            if in_code_region(&regions, full.start()) {
                return full.as_str().to_string();
            }
            // Re-emit the matched whitespace verbatim. For the common
            // trailing form (" ^id") that is the same single space this used
            // to hardcode; for an id on its own line it is the newline that
            // keeps the following lines at their original numbers.
            let leading = caps.get(1).map(|m| m.as_str()).unwrap_or(" ");
            let id = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            format!(
                "{}<a id=\"{}\" class=\"block-id-anchor\" data-label=\"{}\"></a>",
                leading, id, id
            )
        });
        processed = Cow::Owned(replaced.into_owned());
    }

    // `==highlight==` and `^[inline footnote]` were rewritten here too, by two
    // more regexes with two more code-region scans each. comrak parses both
    // itself now (`extension.highlight`, `extension.inline_footnotes`), and the
    // parser is better at it than the patterns were: a highlight may span a
    // line break, and an inline footnote may contain brackets. Both stopped at
    // those. See `markdown_options`.

    processed
}

fn process_parenthesized_autolinks(content: &str) -> Cow<'_, str> {
    let regions = code_region_ranges(content);
    let mut output = String::new();
    let mut copied_to = 0;
    let mut scan_from = 0;

    while let Some(opening_offset) = content[scan_from..].find('(') {
        let opening = scan_from + opening_offset;
        let url_start = opening + 1;
        let url_tail = &content[url_start..];
        if !(url_tail.starts_with("http://")
            || url_tail.starts_with("https://")
            || url_tail.starts_with("ftp://"))
        {
            scan_from = url_start;
            continue;
        }

        let mut depth = 1usize;
        let mut closing = None;
        for (offset, ch) in url_tail.char_indices() {
            if ch.is_whitespace() {
                break;
            }
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        closing = Some(url_start + offset);
                        break;
                    }
                }
                _ => {}
            }
        }

        let Some(closing) = closing else {
            scan_from = url_start;
            continue;
        };
        let after_closing = closing + ')'.len_utf8();
        let adjacent_text = content[after_closing..]
            .chars()
            .next()
            .is_some_and(char::is_alphanumeric);
        if !adjacent_text || in_code_region(&regions, opening) {
            scan_from = after_closing;
            continue;
        }

        let url = &content[url_start..closing];
        output.push_str(&content[copied_to..url_start]);
        output.push('[');
        output.push_str(url);
        output.push_str("](");
        output.push_str(url);
        output.push_str(")");
        output.push(')');
        copied_to = after_closing;
        scan_from = after_closing;
    }

    if output.is_empty() {
        Cow::Borrowed(content)
    } else {
        output.push_str(&content[copied_to..]);
        Cow::Owned(output)
    }
}

// ---------------------------------------------------------------------------
// Math spans
//
// comrak keeps applying CommonMark inline rules *inside* math delimiters, so
// the formula KaTeX finally sees has already been rewritten. Three reported
// bugs are the same bug:
//
//   #174  `$\bar{b}_{1} + \bar{b}_{2}$` — the two `_` pair into `<em>`, which
//         is why only the first subscript ever worked and why putting a space
//         in front of it "fixed" it (a space makes the `_` non-left-flanking).
//   #197  `$$ … \\ … $$` — `\\` is a CommonMark escape for a literal `\`, so
//         every row separator of an `aligned` block is eaten and the whole
//         block collapses onto one over-wide line.
//   #177  `\%` loses its backslash, and a bare `%` starts a TeX comment that
//         swallows the rest of the formula ("Unexpected end of input").
//
// Patching one character class at a time (the previous
// `protect_display_math_underscores` only rewrote `_`, and only between `$$`)
// cannot win: Markdown has no business parsing TeX at all. So the whole span
// is replaced by an opaque token before comrak runs and put back afterwards.
//
// Escaped dollars are hidden the same way, for the mirror-image reason. A
// reader who writes `\$\$x\$\$` is saying "not a formula", and CommonMark
// resolving that escape destroys the only evidence of it: the frontend, which
// is the side that actually decides, then sees the same bytes a real `$$x$$`
// produces and typesets the reader's dollar signs. See
// `find_escaped_dollar_spans`.
//
// Deliberately NOT handled here: `\(…\)` and `\[…\]`, which the frontend also
// renders. They have the same root cause and are not an oversight — CommonMark
// eats the backslash (`\(` → `(`) before the frontend ever sees a delimiter, so
// they have never worked in Markpad at all. Fixing them is a separate change
// with its own regression surface; masking them here would silently start
// claiming text that no released version ever treated as math. That the
// frontend *emits* those two spellings is a different matter: they are its
// private vocabulary for a decision it has already made.
//
// The token is deliberately plain ASCII rather than a private-use character:
// comrak percent-encodes anything non-ASCII that ends up in a link
// destination (`http://x/$a$` would come back as `http://x/%EE%80%80…`),
// while `[A-Z0-9]` survives text nodes, attribute values and hrefs verbatim
// and carries no CommonMark meaning. Uniqueness is established by
// construction instead of by luck: the prefix grows until it does not occur
// in the document.
// ---------------------------------------------------------------------------

const MATH_MASK_PREFIX: &str = "MPMATHMASK";
const MATH_MASK_SUFFIX: char = 'E';

struct MaskedMath {
    /// The source with every math span and every escaped dollar replaced by a
    /// token.
    text: String,
    /// The token prefix actually used — see `mask_math_spans`.
    prefix: String,
    /// The masked source, one entry per line of each span, indexed by token.
    spans: Vec<MaskedSpan>,
}

/// One masked piece of source and the two spellings it can come back as.
struct MaskedSpan {
    /// The source, verbatim. This is what a text node gets, because a text
    /// node is where the frontend's own passes run.
    text: String,
    /// What an attribute value gets instead. Nothing unescapes an `href` or an
    /// `alt` on the way to the reader, so an escaped dollar has to arrive there
    /// already resolved — the way comrak would have resolved it. For a math
    /// span the two spellings are the same string.
    attribute: String,
}

/// Byte ranges of `content` that may hold math: one entry per line, with the
/// code regions cut out.
///
/// The split mirrors what the frontend can see. `convert_markdown` renders
/// with `hardbreaks`, so every source line becomes its own DOM text node, and
/// `processInlineMath` skips `code`/`pre` subtrees entirely — a `$` on the far
/// side of a line break or of an inline code span is in a different text node
/// and can never pair. Scanning the raw buffer the same way is what keeps the
/// two ends agreeing, and it is also what stops a single `$$` inside a fenced
/// block from flipping the delimiter parity of the whole document.
fn math_scan_segments(content: &str, regions: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let len = content.len();
    let mut segments = Vec::new();
    let mut line_start = 0usize;
    // `regions` is sorted and both loops only move forward, so each region is
    // visited once across the whole document rather than once per line.
    let mut first_region = 0usize;
    loop {
        let newline = content[line_start..]
            .find('\n')
            .map(|offset| line_start + offset)
            .unwrap_or(len);
        let mut line_end = newline;
        if line_end > line_start && content.as_bytes()[line_end - 1] == b'\r' {
            line_end -= 1;
        }

        while first_region < regions.len() && regions[first_region].1 <= line_start {
            first_region += 1;
        }
        let mut cursor = line_start;
        for &(region_start, region_end) in &regions[first_region..] {
            if region_end <= cursor {
                continue;
            }
            if region_start >= line_end {
                break;
            }
            if region_start > cursor {
                segments.push((cursor, region_start.min(line_end)));
            }
            cursor = cursor.max(region_end);
            if cursor >= line_end {
                break;
            }
        }
        if cursor < line_end {
            segments.push((cursor, line_end));
        }

        if newline >= len {
            break;
        }
        line_start = newline + 1;
    }
    segments
}

fn char_before(content: &str, low: usize, at: usize) -> Option<char> {
    if at <= low {
        return None;
    }
    content[low..at].chars().next_back()
}

fn char_after(content: &str, high: usize, dollar: usize) -> Option<char> {
    let next = dollar + 1;
    if next >= high {
        return None;
    }
    content[next..high].chars().next()
}

/// The closing `$` of an inline span opened at `open`, or `None`.
///
/// A faithful port of `findInlineMathEnd` in `src/lib/utils/markdown.ts`, and
/// the reason `$100 and $200` is not math: the first candidate closer decides,
/// and a candidate preceded by whitespace or followed by a digit does not
/// merely get skipped — it abandons the span. Anything looser turns ordinary
/// prices into formulas, which is a far worse failure than the bug being
/// fixed here.
fn find_inline_close(content: &str, low: usize, high: usize, from: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut index = from;
    while index < high {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        let before = char_before(content, low, index);
        if before == Some('\\') {
            index += 1;
            continue;
        }
        if before.is_some_and(char::is_whitespace) {
            return None;
        }
        if char_after(content, high, index).is_some_and(|c| c.is_ascii_digit()) {
            return None;
        }
        return Some(index);
    }
    None
}

/// The end offset (exclusive) of a `$$…$$` span opened at `open`.
///
/// Within one line this is `findDisplayMathEnd`. Across lines it is the block
/// form `processDisplayMathBlocks` renders, so both delimiters must sit alone
/// on their line; that is what stops two unrelated `$$` in prose from pairing
/// across a hard break. The search stops at a blank line (which ends the
/// CommonMark block) and at any code region.
fn find_display_close(
    content: &str,
    regions: &[(usize, usize)],
    open: usize,
    segment_end: usize,
) -> Option<usize> {
    let bytes = content.as_bytes();
    let len = content.len();

    let mut index = open + 2;
    while index + 1 < segment_end {
        if bytes[index] == b'$' && bytes[index + 1] == b'$' && bytes[index - 1] != b'\\' {
            return Some(index + 2);
        }
        index += 1;
    }

    let (opener_line_end, mut next_line_start) = line_bounds(content, open);
    if !content[open + 2..opener_line_end].trim().is_empty() {
        return None;
    }
    while next_line_start < len {
        let (line_end, following) = line_bounds(content, next_line_start);
        let line = &content[next_line_start..line_end];
        if line.trim().is_empty() {
            return None;
        }
        if regions
            .iter()
            .any(|&(start, end)| start < line_end && end > next_line_start)
        {
            return None;
        }
        if let Some(offset) = line.find("$$") {
            let close = next_line_start + offset;
            if content[next_line_start..close].trim().is_empty()
                && content[close + 2..line_end].trim().is_empty()
            {
                return Some(close + 2);
            }
        }
        next_line_start = following;
    }
    None
}

/// `(end of the line holding `at`, start of the next line)`, with `\r`
/// excluded from the first and `len` used when there is no next line.
fn line_bounds(content: &str, at: usize) -> (usize, usize) {
    let len = content.len();
    let newline = content[at..]
        .find('\n')
        .map(|offset| at + offset)
        .unwrap_or(len);
    let mut line_end = newline;
    if line_end > 0 && content.as_bytes()[line_end - 1] == b'\r' {
        line_end -= 1;
    }
    (line_end, (newline + 1).min(len))
}

/// The math spans of `content`, as sorted, non-overlapping byte ranges.
///
/// A port of `convertInlineMathDelimiters` in `src/lib/utils/markdown.ts`,
/// which is the only thing that decides what the user actually sees rendered.
/// Recognising a span here that the frontend will not render would strip the
/// Markdown out of ordinary prose; recognising less would leave the formula
/// mangled — so the rules have to be the same rules.
fn find_math_spans(content: &str, regions: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let bytes = content.as_bytes();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut barrier = 0usize;

    for (segment_start, segment_end) in math_scan_segments(content, regions) {
        if segment_end <= barrier {
            continue;
        }
        // A multi-line span already consumed the head of this line.
        let low = segment_start.max(barrier);
        let mut index = low;
        // Lets `$a$$b$` open a second span while keeping `$$` itself out of it.
        let mut previous_dollar_allows_open = false;

        while index < segment_end {
            if bytes[index] != b'$' {
                previous_dollar_allows_open = false;
                index += content[index..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            let before = char_before(content, low, index);
            let after = char_after(content, segment_end, index);

            if before != Some('\\') && after == Some('$') {
                match find_display_close(content, regions, index, segment_end) {
                    Some(end) => {
                        spans.push((index, end));
                        if end > segment_end {
                            barrier = end;
                            break;
                        }
                        previous_dollar_allows_open = true;
                        index = end;
                    }
                    None => {
                        previous_dollar_allows_open = false;
                        index += 2;
                    }
                }
                continue;
            }

            if before == Some('\\')
                || (before == Some('$') && !previous_dollar_allows_open)
                || after.is_some_and(char::is_whitespace)
            {
                previous_dollar_allows_open = false;
                index += 1;
                continue;
            }

            match find_inline_close(content, low, segment_end, index + 1) {
                Some(close) => {
                    spans.push((index, close + 1));
                    previous_dollar_allows_open = true;
                    index = close + 1;
                }
                None => {
                    previous_dollar_allows_open = false;
                    index += 1;
                }
            }
        }
    }
    spans
}

/// The escaped dollars of `content`: a `$` carrying a run of backslashes in
/// front of it, masked together with the whole run.
///
/// Declining to treat `\$` as a delimiter — which `find_math_spans` already
/// does — protects the formula that is not there, and nothing else. comrak
/// still resolves the escape, so `\$\$x\$\$` reaches the frontend as the same
/// eight bytes an unescaped `$$x$$` does, and from that point on no rule can
/// tell the two apart: the frontend renders the reader's literal dollars as a
/// formula. `convertInlineMathDelimiters` has carried a "a `$` behind a
/// backslash is not a delimiter" branch since before #402, and it has never
/// once been able to fire, because the backslash is gone by the time the
/// frontend looks.
///
/// So the escape is hidden from comrak exactly the way math is, and put back
/// verbatim. The frontend gets its backslash, its dead branch comes alive, and
/// resolving the escape becomes the job of the side that also decides what is
/// math — which is the only way the two decisions can agree.
///
/// The whole backslash run is taken, not just the last one, so that `\\$`
/// (an escaped backslash, then a live dollar) is not mistaken for `\$` after
/// comrak has halved the run. Ranges inside a math span are skipped: there a
/// `\$` is TeX for a dollar sign, and the math span already shields it.
fn find_escaped_dollar_spans(
    content: &str,
    regions: &[(usize, usize)],
    math: &[(usize, usize)],
) -> Vec<(usize, usize)> {
    let bytes = content.as_bytes();
    let mut spans = Vec::new();
    for (segment_start, segment_end) in math_scan_segments(content, regions) {
        let mut index = segment_start;
        while index < segment_end {
            if bytes[index] != b'\\' {
                index += content[index..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            let mut run_end = index;
            while run_end < segment_end && bytes[run_end] == b'\\' {
                run_end += 1;
            }
            if run_end < segment_end && bytes[run_end] == b'$' {
                if !math.iter().any(|&(start, end)| start < run_end + 1 && end > index) {
                    spans.push((index, run_end + 1));
                }
                index = run_end + 1;
            } else {
                index = run_end;
            }
        }
    }
    spans
}

/// `\$` as comrak would have rendered it: every pair of backslashes collapses
/// to one, and the escaping backslash in front of the `$` disappears.
fn resolve_escaped_dollar(span: &str) -> String {
    let backslashes = span.len() - 1;
    let mut out = "\\".repeat(backslashes / 2);
    out.push('$');
    out
}

/// Replaces every math span — and every escaped dollar — with a token comrak
/// cannot rewrite.
///
/// One token per line of a span, so a six-line `$$…$$` block still occupies
/// six lines: the line-number contract in `mod tests` is not negotiable, and a
/// span collapsed into a single token would move every task checkbox below it.
/// Leading indentation stays outside the token so that a formula inside a list
/// item keeps belonging to that item.
fn mask_math_spans(content: &str) -> MaskedMath {
    // Case-insensitively, because comrak lowercases the token again when it
    // derives a heading id from it — see `restore_math_spans`.
    let haystack = content.to_ascii_lowercase();
    let mut prefix = String::from(MATH_MASK_PREFIX);
    while haystack.contains(&prefix.to_ascii_lowercase()) {
        prefix.push('X');
    }

    let regions = code_region_ranges(content);
    let math = find_math_spans(content, &regions);
    // Both halves of one decision: what the frontend must render, and what it
    // must refuse to render. Hiding only the first half is what let an
    // explicitly escaped `\$\$x\$\$` come out typeset.
    let mut found: Vec<(usize, usize, bool)> = math
        .iter()
        .map(|&(start, end)| (start, end, false))
        .chain(
            find_escaped_dollar_spans(content, &regions, &math)
                .into_iter()
                .map(|(start, end)| (start, end, true)),
        )
        .collect();
    found.sort_by_key(|&(start, _, _)| start);
    if found.is_empty() {
        return MaskedMath {
            text: content.to_owned(),
            prefix,
            spans: Vec::new(),
        };
    }

    let mut text = String::with_capacity(content.len());
    let mut spans: Vec<MaskedSpan> = Vec::new();
    let mut copied_to = 0usize;
    for (start, end, escaped) in found {
        text.push_str(&content[copied_to..start]);
        for piece in content[start..end].split_inclusive('\n') {
            let mut body = piece;
            let mut line_ending = "";
            if let Some(stripped) = body.strip_suffix('\n') {
                body = stripped;
                line_ending = "\n";
                if let Some(stripped) = body.strip_suffix('\r') {
                    body = stripped;
                    line_ending = "\r\n";
                }
            }
            let indent = body.len() - body.trim_start().len();
            text.push_str(&body[..indent]);
            let core = &body[indent..];
            if !core.is_empty() {
                text.push_str(&format!("{prefix}{}{MATH_MASK_SUFFIX}", spans.len()));
                spans.push(MaskedSpan {
                    attribute: if escaped {
                        resolve_escaped_dollar(core)
                    } else {
                        core.to_owned()
                    },
                    text: core.to_owned(),
                });
            }
            text.push_str(line_ending);
        }
        copied_to = end;
    }
    text.push_str(&content[copied_to..]);

    MaskedMath {
        text,
        prefix,
        spans,
    }
}

/// Puts the masked source back into the rendered HTML.
///
/// The span is re-escaped the way comrak escapes a text node, not inserted
/// raw: the token can legitimately land in a text node, an `alt` value or an
/// `href`, and `&<>"` are the four characters that would otherwise change the
/// meaning of the markup in any of the three. The frontend reads the span back
/// out with `textContent`, which undoes the escaping before KaTeX sees it.
///
/// A heading is the one place the token appears twice in two different
/// spellings: comrak anchorizes the heading's rendered text into `id=` and
/// `href="#…"`, which lowercases it. There the *anchorized* source goes back
/// instead, so that `[[#A heading with $x_1$]]` still resolves — the wikilink
/// side computes the same id from the raw buffer with `heading_anchor_id`.
///
/// Whether the token landed in markup or in text is tracked as it goes, and it
/// is not a nicety: an escaped dollar goes back as `\$` only where a frontend
/// pass will resolve it. Nothing resolves anything inside an `href` or an
/// `alt`, so a token that landed there gets the resolved `$` instead — putting
/// the backslash into a link destination would break the link. comrak escapes
/// `<` and `>` everywhere else, so an unclosed `<` really does mean "inside a
/// tag".
fn restore_math_spans(html: &str, masked: &MaskedMath) -> String {
    if masked.spans.is_empty() {
        return html.to_owned();
    }
    let anchor_prefix = masked.prefix.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let mut in_tag = false;
    while let Some((at, anchored)) = [
        (rest.find(masked.prefix.as_str()), false),
        (rest.find(anchor_prefix.as_str()), true),
    ]
    .into_iter()
    .filter_map(|(at, anchored)| at.map(|at| (at, anchored)))
    .min()
    {
        out.push_str(&rest[..at]);
        if let Some(bracket) = rest[..at].rfind(['<', '>']) {
            in_tag = rest.as_bytes()[bracket] == b'<';
        }
        let after = &rest[at + masked.prefix.len()..];
        let digits = after
            .as_bytes()
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        let suffix = if anchored {
            MATH_MASK_SUFFIX.to_ascii_lowercase()
        } else {
            MATH_MASK_SUFFIX
        };
        let index = if digits > 0 && after[digits..].starts_with(suffix) {
            after[..digits].parse::<usize>().ok()
        } else {
            None
        };
        match index.and_then(|index| masked.spans.get(index)) {
            Some(original) if anchored => {
                out.push_str(&Anchorizer::new().anchorize(&original.text));
                rest = &after[digits + suffix.len_utf8()..];
            }
            Some(original) => {
                out.push_str(&escape_html_text(if in_tag {
                    &original.attribute
                } else {
                    &original.text
                }));
                rest = &after[digits + suffix.len_utf8()..];
            }
            None => {
                out.push_str(&rest[at..at + masked.prefix.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape_html_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// ⚠️ Every preprocessing step below is bound by a line-number contract:
/// `sourcepos` describes the *preprocessed* text, but the frontend uses those
/// line numbers to edit the *raw* buffer, so input line N must stay output
/// line N. The contract, the rationale and the tests that enforce it live in
/// `mod tests` under "The line-number contract of `convert_markdown`" —
/// a new step here must also be registered in `line_preserving_transforms()`.
#[tauri::command]
fn convert_markdown(content: &str) -> String {
    // The buffer this command was called with, captured before anything runs
    // and never rebound. What `annotate_task_checkboxes` is handed at the end
    // has to be this rather than the parameter name: a new step written as a
    // `let content = ...` shadow would rebind that name and silently retarget
    // the call without touching it. See that function's doc comment and
    // `convert_markdown_hands_the_fail_safe_the_raw_buffer`.
    let raw_buffer = content;

    let processed_autolinks = process_parenthesized_autolinks(content);
    let processed_embeds = process_internal_embeds(&processed_autolinks);
    let processed_links = process_wikilinks(&processed_embeds);
    let masked_math = mask_math_spans(&processed_links);

    let options = markdown_options();

    let html = markdown_to_html(&masked_math.text, &options);
    annotate_task_checkboxes(restore_math_spans(&html, &masked_math), raw_buffer)
}

/// Marks the rendered task checkboxes the frontend is allowed to toggle.
///
/// `markdown` is the **raw, unpreprocessed** buffer — deliberately, and not a
/// bug. This is the fail-safe for the line contract described in `mod tests`.
///
/// The `data-sourcepos` line numbers in `html` describe the *preprocessed*
/// text, while a click on the checkbox makes the frontend rewrite that line
/// number of the *raw* buffer (`documentSession.toggleTaskCheckbox`). The two
/// only agree while every preprocessing step preserves line numbers. Checking
/// the raw buffer here is what turns a broken step into "the checkbox stays
/// disabled" instead of a write aimed at the wrong line of the user's
/// document — the P0 that issue #352 fixed.
///
/// What a wrong line costs is narrower than it was, and worth stating
/// precisely, because an overstated reason invites the next reader to check
/// it, find it false, and delete the guard as theatre. Since #352 the
/// frontend rewrites only lines that already match
/// `/^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)\[( |x|X)\]/`
/// (`documentSession.toggleTaskCheckbox`), so a wrong line that is ordinary
/// prose is a no-op and the toggle reports failure — it does NOT write a
/// `- [x]` marker into whatever happens to sit there, as this comment used to
/// claim of the pre-#352 frontend. What still corrupts is a wrong line that
/// is itself task-shaped, and neither spelling of that is exotic: a task list
/// quoted inside a fenced code block is ordinary content in a notes app, and
/// a real task elsewhere in the same document means the user clicks one
/// checkbox and a different one silently flips.
///
/// So do NOT "unify" this with the preprocessed text that produced the HTML.
/// Passing `&processed_links` here would make the two sides agree by
/// definition, delete the guard, and turn every future line-count regression
/// straight into a mis-aimed write. Nor is passing the *parameter name*
/// enough at the call site: `convert_markdown` captures its input as
/// `raw_buffer` first precisely so that a later `let content = …` cannot
/// retarget the call without touching it. Keep the contract honest in the
/// transforms instead; `every_preprocessing_step_preserves_source_line_numbers`
/// is what enforces it,
/// `task_checkboxes_stay_inert_when_the_html_and_the_buffer_disagree` pins
/// this guard, and `convert_markdown_hands_the_fail_safe_the_raw_buffer` pins
/// the argument it is given.
fn annotate_task_checkboxes(html: String, markdown: &str) -> String {
    let markdown_lines = markdown.lines().collect::<Vec<_>>();

    TASK_ITEM_RE
        .replace_all(&html, |captures: &Captures| {
            let line = captures["line"].parse::<usize>().unwrap_or_default();
            let source_line = markdown_lines.get(line.saturating_sub(1));
            if !source_line.is_some_and(|line| TASK_SOURCE_RE.is_match(line)) {
                return captures[0].to_string();
            }

            // Anchored on the tag name, not on one of the boolean attributes,
            // for the same reason `TASK_ITEM_RE` no longer spells their order
            // out: `disabled` is not guaranteed to be the first one.
            let input = captures["input"].replacen(
                "<input type=\"checkbox\"",
                "<input type=\"checkbox\" data-task-checkbox=\"\"",
                1,
            );
            format!(
                "<li data-sourcepos=\"{}\">{}",
                &captures["sourcepos"],
                input,
            )
        })
        .into_owned()
}

struct MarkdownPreview {
    html: String,
    content: String,
    is_full: bool,
    lossy: bool,
    encoding: String,
}

/// The body of `open_markdown_preview`, kept synchronous and path-taking so
/// the decode-fidelity behaviour can be exercised against real files.
fn build_markdown_preview(path: &Path, max_bytes: usize) -> Result<MarkdownPreview, String> {
    use std::io::Read;
    let path_str = path.to_str().ok_or("Invalid path")?;
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;

    let metadata = f.metadata().map_err(|e| e.to_string())?;
    if metadata.len() <= max_bytes as u64 {
        let decoded = read_to_string_lossy(path_str).map_err(|e| e.to_string())?;
        let html = convert_markdown(&decoded.content);
        return Ok(MarkdownPreview {
            html,
            content: decoded.content,
            is_full: true,
            lossy: decoded.lossy,
            encoding: decoded.encoding,
        });
    }

    // `Read::read` only guarantees *at most* `buf.len()` bytes and may
    // return a short read for reasons that have nothing to do with EOF,
    // truncating the preview well below the requested budget.
    // `take(..).read_to_end(..)` keeps reading to the limit or EOF.
    let mut vec_buf = Vec::new();
    Read::by_ref(&mut f)
        .take(max_bytes as u64)
        .read_to_end(&mut vec_buf)
        .map_err(|e| e.to_string())?;
    // The cut lands on a raw byte offset, which can slice a multi-byte
    // character in half; drop the partial tail instead of rendering it as
    // a replacement character. This also keeps a perfectly good UTF-8 file
    // from being reported as a lossy decode just because the preview budget
    // fell inside one of its characters.
    vec_buf.truncate(utf8_truncation_boundary(&vec_buf));

    // Detection runs on the prefix, so it can differ from what the whole file
    // would say — and a legacy multi-byte character cut in half here is a
    // `lossy` preview of a document that is perfectly decodable. Neither
    // matters for the file's safety: a truncated buffer is refused by
    // `saveContent` outright, and the full read that precedes any edit
    // (`ensureFullContent`) replaces both answers with the whole file's.
    let preview = decode_text(&vec_buf);

    let html = convert_markdown(&preview.content);
    Ok(MarkdownPreview {
        html,
        content: preview.content,
        is_full: false,
        lossy: preview.lossy,
        encoding: preview.encoding,
    })
}

/// Returns `(html, content, is_full, lossy, encoding)`. See `DecodedText`: the
/// frontend refuses to write a `lossy` buffer back over its file, and saves a
/// faithful one as the `encoding` it came in.
#[tauri::command]
async fn open_markdown_preview(
    path: String,
    max_bytes: usize,
) -> Result<(String, String, bool, bool, String), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let preview = build_markdown_preview(Path::new(&path), max_bytes)?;
        Ok((
            preview.html,
            preview.content,
            preview.is_full,
            preview.lossy,
            preview.encoding,
        ))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// A heading, and the id a link has to name to reach it.
#[derive(serde::Serialize)]
struct HeadingAnchor {
    /// 1-based line in the buffer the caller passed, for ordering the list.
    line: u32,
    level: u8,
    /// What the heading reads as — the completion's label, and what a
    /// `[[#…]]` wikilink is written with.
    text: String,
    /// What `[…](#…)` has to say. This is the id comrak renders, duplicates
    /// included: a second "Objectives" is `objectives-1`, and offering the
    /// bare slug for it would link to the first one.
    slug: String,
}

/// Every heading in `markdown`, with the anchor comrak gives it.
///
/// Parsed rather than scanned for `#`, because a `# comment` inside a fenced
/// code block is not a heading and this document is full of shell examples.
/// The parse uses `markdown_options()` — the renderer's own configuration —
/// so what comes back is what is actually on screen.
///
/// ONE anchorizer for the whole document, not one per heading. comrak numbers
/// repeated headings (`objectives`, `objectives-1`, …) and this list has to
/// carry the same numbering or completion hands the reader a link to the wrong
/// section. That is the opposite of `heading_anchor_id`, which is deliberately
/// fresh per lookup: a wikilink names a heading by TEXT, and text can only
/// ever address the first heading that reads that way.
///
/// The SAME preprocessing the renderer runs, for the same reason: comrak never
/// sees the buffer. `[[note#Setup]]` is a link by the time it is parsed, so the
/// heading reads "note > Setup" and is anchorized as such; parsing the raw
/// buffer instead reports an id for a heading that was never rendered. The
/// steps are line-preserving (`line_preserving_transforms`), so the sourcepos
/// numbers still address the caller's buffer.
///
/// Math is masked before the parse and comes back after it. Its token is put
/// back as the source it stands for, which is what the renderer's own
/// `restore_math_spans` writes into an anchor — and the two agree because
/// anchorizing is a per-character map with no collapsing, so doing it to the
/// pieces and doing it to the whole give the same string.
fn heading_anchors(markdown: &str) -> Vec<HeadingAnchor> {
    let autolinks = process_parenthesized_autolinks(markdown);
    let embeds = process_internal_embeds(&autolinks);
    let preprocessed = process_wikilinks(&embeds);
    let masked = mask_math_spans(&preprocessed);

    let arena = Arena::new();
    let options = markdown_options();
    let root = parse_document(&arena, &masked.text, &options);
    let mut anchorizer = Anchorizer::new();
    let mut anchors = Vec::new();

    for node in root.descendants() {
        let (level, line) = {
            let data = node.data.borrow();
            match data.value {
                NodeValue::Heading(heading) => (heading.level, data.sourcepos.start.line),
                _ => continue,
            }
        };

        let text = unmask_math_text(&collect_inline_text(node), &masked);
        if text.trim().is_empty() {
            continue;
        }

        anchors.push(HeadingAnchor {
            line: line as u32,
            level,
            slug: anchorizer.anchorize(text.trim()),
            text: text.trim().to_owned(),
        });
    }

    anchors
}

/// The text a heading reads as, which is what comrak anchorizes: the literals
/// of its inline children, with the emphasis and link markup dropped.
fn collect_inline_text<'a>(node: &'a comrak::nodes::AstNode<'a>) -> String {
    let mut text = String::new();
    for descendant in node.descendants() {
        match &descendant.data.borrow().value {
            NodeValue::Text(literal) => text.push_str(literal),
            NodeValue::Code(code) => text.push_str(&code.literal),
            _ => {}
        }
    }
    text
}

/// Puts masked math back into a piece of *text*, which is the spelling a text
/// node gets. The rendered anchor is built from the same source
/// (`restore_math_spans`, its `anchored` branch), so anchorizing this gives
/// the id that is on the heading.
fn unmask_math_text(text: &str, masked: &MaskedMath) -> String {
    if masked.spans.is_empty() {
        return text.to_owned();
    }

    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(masked.prefix.as_str()) {
        out.push_str(&rest[..at]);
        let after = &rest[at + masked.prefix.len()..];
        let digits = after
            .as_bytes()
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        let index = if digits > 0 && after[digits..].starts_with(MATH_MASK_SUFFIX) {
            after[..digits].parse::<usize>().ok()
        } else {
            None
        };
        match index.and_then(|index| masked.spans.get(index)) {
            Some(span) => {
                out.push_str(&span.text);
                rest = &after[digits + MATH_MASK_SUFFIX.len_utf8()..];
            }
            None => {
                out.push_str(&rest[at..at + masked.prefix.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[tauri::command]
async fn list_heading_anchors(markdown: String) -> Result<Vec<HeadingAnchor>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(heading_anchors(&markdown)))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
async fn render_markdown(content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(convert_markdown(&content))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Reads a file, with the fidelity of the decode and the encoding it was
/// decoded from: returns `(content, lossy, encoding)`. A caller that puts the
/// text into an EDITABLE buffer must carry BOTH onto the tab — `lossy` so the
/// first auto-save does not write U+FFFD over a file that could not be read,
/// and `encoding` so it does not write UTF-8 over one that could.
///
/// This is now the only read-to-string command. Its sibling
/// `read_file_content` returned the text and dropped the verdict; it survived
/// #379 for callers that re-read a file whose tab was already flagged, then
/// lost its last call site and stayed registered — a command whose defining
/// property is that it hides the flag, one `invoke` away from any new caller.
/// Deleting it makes "which command should this use" a question with one
/// answer rather than a convention.
///
/// Deliberately async, like every other file-touching command here. A
/// synchronous `#[tauri::command]` runs on the main thread, so a read from a
/// slow volume (SMB, iCloud, a failing USB stick) freezes the whole
/// application — every window, its menus and its scrolling — until the I/O
/// returns. `spawn_blocking` moves the wait onto the blocking pool, which is
/// what `tauri::async_runtime` provides it for.
#[tauri::command]
async fn read_file_content_checked(path: String) -> Result<(String, bool, String), String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_to_string_lossy(&path)
            .map(|decoded| (decoded.content, decoded.lossy, decoded.encoding))
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

fn mime_type_for_export_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

fn file_bytes_to_data_url(mime_type: &str, bytes: &[u8]) -> String {
    use base64::{engine::general_purpose, Engine as _};
    format!(
        "data:{};base64,{}",
        mime_type,
        general_purpose::STANDARD.encode(bytes)
    )
}

#[tauri::command]
async fn read_file_as_data_url(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let mime_type = mime_type_for_export_path(Path::new(&path));
        Ok(file_bytes_to_data_url(mime_type, &bytes))
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Writes `content` to `path` as `encoding` — the label the file was decoded
/// from, so a legacy document is saved as the bytes it arrived as instead of
/// being silently converted to UTF-8 behind the user's back. Callers with text
/// Markpad generated itself (the HTML and SVG exports) pass `UTF-8`.
///
/// The label is not trusted: it makes a round trip through the frontend, and
/// `encode_text` rejects one it does not recognise rather than falling back to
/// a default that would write the wrong bytes.
///
/// Encoding happens BEFORE `atomic_write`, so a document with a character its
/// encoding cannot represent fails without the file being touched at all.
///
/// Async because `atomic_write` fsyncs twice (the file, then its directory).
/// On a network or removable volume that is seconds of blocking I/O, and on
/// the main thread it would stall every window until the save completes.
#[tauri::command]
async fn save_file_content(path: String, content: String, encoding: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = encode_text(&content, &encoding)?;
        atomic_write(Path::new(&path), &bytes).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Resolve `path` to the identity the filesystem gives it — see
/// `canonical_identity` for what that folds and why the filesystem, rather
/// than a platform guess, is the thing being asked.
///
/// The frontend calls this once per path, when the path ENTERS the app, and
/// keeps the answer on the tab (`Tab.pathKey`). Comparisons themselves stay
/// synchronous string equality: `TabManager.claimPath` runs on every navigate
/// and cannot become async without turning six sync call sites into promises.
///
/// Async because `realpath` walks the path component by component and can hit
/// a network volume that is slow or unreachable.
#[tauri::command]
async fn canonicalize_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        canonical_identity(Path::new(&path))
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
fn print_pdf(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|error| error.to_string())
}

#[tauri::command]
async fn export_pdf_windows(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::mpsc::sync_channel;
        use std::time::Duration;
        use webview2_com::{
            PrintToPdfCompletedHandler,
            Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7},
        };
        use windows::core::{Interface, HSTRING};

        let (sender, receiver) = sync_channel(1);
        window
            .with_webview(move |platform_webview| unsafe {
                let result = (|| -> Result<(), String> {
                    let controller = platform_webview.controller();
                    let webview = controller
                        .CoreWebView2()
                        .map_err(|error| format!("failed to access WebView2: {error}"))?
                        .cast::<ICoreWebView2_7>()
                        .map_err(|error| {
                            format!("WebView2 runtime does not support PDF export: {error}")
                        })?;
                    let settings = platform_webview
                        .environment()
                        .cast::<ICoreWebView2Environment6>()
                        .map_err(|error| {
                            format!("WebView2 runtime does not support print settings: {error}")
                        })?
                        .CreatePrintSettings()
                        .map_err(|error| format!("failed to create PDF print settings: {error}"))?;

                    settings
                        .SetShouldPrintHeaderAndFooter(false)
                        .map_err(|error| {
                            format!("failed to disable PDF headers and footers: {error}")
                        })?;
                    settings
                        .SetShouldPrintBackgrounds(true)
                        .map_err(|error| format!("failed to enable PDF backgrounds: {error}"))?;

                    let callback_sender = sender.clone();
                    let completion =
                        PrintToPdfCompletedHandler::create(Box::new(move |status, succeeded| {
                            let result = status
                                .map_err(|error| format!("WebView2 PDF export failed: {error}"))
                                .and_then(|_| {
                                    succeeded.then_some(()).ok_or_else(|| {
                                        "WebView2 did not create the PDF file".to_string()
                                    })
                                });
                            let _ = callback_sender.send(result);
                            Ok(())
                        }));

                    webview
                        .PrintToPdf(&HSTRING::from(path), &settings, &completion)
                        .map_err(|error| format!("could not start PDF export: {error}"))
                })();

                if let Err(error) = result {
                    let _ = sender.send(Err(error));
                }
            })
            .map_err(|error| format!("failed to schedule PDF export: {error}"))?;

        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(60)))
            .await
            .map_err(|error| format!("PDF export task failed: {error}"))?
            .map_err(|error| format!("PDF export callback failed or timed out: {error}"))?
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, path);
        Err("controlled PDF export is only available on Windows".to_string())
    }
}

#[tauri::command]
async fn save_file_binary(path: String, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        atomic_write(Path::new(&path), &data).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Async because `reveal` blocks its caller until the file manager answers:
/// on Windows it spawns a COM worker for `SHOpenFolderAndSelectItems` and
/// joins it, on macOS it waits for `open -R`. Selecting a file on a network
/// volume makes that wait the share's, and on the main thread it would stall
/// every window until it returns.
#[tauri::command]
async fn open_file_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || opener::reveal(path).map_err(|e| e.to_string()))
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// Async because a rename is a round trip to whatever holds the path — on a
/// network or removable volume, seconds of blocking I/O for a metadata
/// operation that looks instant on a local disk.
#[tauri::command]
async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::rename(old_path, new_path).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// Async because arming a watcher opens the watched path, and an unreachable
/// one costs the full share timeout before it fails — `\\wsl$\…` with the
/// distro stopped is the case that prompted this. Inserting the new watcher
/// also drops the window's previous one, and that drop joins its thread.
///
/// `State` is resolved inside the closure rather than taken as a parameter:
/// `State<'_, _>` borrows from the app and cannot cross into a `'static`
/// blocking task. It is injected by Tauri either way, so the command's
/// frontend-facing arguments are unchanged.
#[tauri::command]
async fn watch_file(window: tauri::Window, handle: AppHandle, path: String) -> Result<(), String> {
    let state_handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = state_handle.state::<WatcherState>();
        window_runtime::watch_file(window, handle, state, path)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
fn save_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let theme_path = config_dir.join("theme.txt");
    atomic_write(&theme_path, theme.as_bytes()).map_err(|e| e.to_string())
}

fn theme_slug(value: &str) -> String {
    let lowercase = value.to_lowercase();
    lowercase
        .split(|c: char| !c.is_alphanumeric())
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[tauri::command]
async fn fetch_vscode_theme(app: AppHandle, url: String) -> Result<String, String> {
    use std::io::Cursor;
    // Parse URL: e.g. https://vscodethemes.com/e/teabyii.ayu/ayu-dark-bordered
    let parts: Vec<&str> = url.split('/').collect();
    if parts.len() < 5 || parts[3] != "e" {
        return Err("Invalid vscodethemes.com URL".to_string());
    }
    let pub_ext = parts[4];
    let theme_name = parts
        .get(5)
        .unwrap_or(&"")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let pe_parts: Vec<&str> = pub_ext.split('.').collect();
    if pe_parts.len() != 2 {
        return Err("Invalid extension format in URL".to_string());
    }
    let publisher = pe_parts[0];
    let extension = pe_parts[1];

    let vsix_url = format!("https://{publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/{publisher}/extension/{extension}/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage");

    // Bound the request explicitly. `reqwest::get` has no timeout at all, so
    // a marketplace host that accepts the connection and then stalls leaves
    // the theme import pending for the rest of the session.
    let client = reqwest::Client::builder()
        .connect_timeout(VSIX_CONNECT_TIMEOUT)
        .timeout(VSIX_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(&vsix_url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("VSIX download failed with HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|length| length > MAX_VSIX_DOWNLOAD_BYTES as u64) {
        return Err("VSIX download exceeds the allowed size".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_VSIX_DOWNLOAD_BYTES {
            return Err("VSIX download exceeds the allowed size".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    let reader = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    validate_vsix_archive_limits(&mut archive)?;

    let package_json_data = if let Ok(file) = archive.by_name("extension/package.json") {
        if file.size() > MAX_THEME_JSON_BYTES {
            return Err("VSIX package manifest exceeds the allowed size".to_string());
        }
        read_zip_entry_to_string(file, MAX_THEME_JSON_BYTES)?
    } else {
        return Err("No package.json found in VSIX".to_string());
    };

    let package_json: serde_json::Value =
        serde_json::from_str(&package_json_data).map_err(|e| e.to_string())?;
    let themes = package_json
        .get("contributes")
        .and_then(|c| c.get("themes"))
        .and_then(|t| t.as_array())
        .ok_or("No themes found in extension")?;

    let mut theme_path = None;
    let mut matched_name_str = theme_name.clone();

    for t in themes {
        let label = t
            .get("label")
            .or(t.get("id"))
            .and_then(|l| l.as_str())
            .unwrap_or("");
        let path = t.get("path").and_then(|p| p.as_str()).unwrap_or("");

        let label_slug = theme_slug(label);

        // If theme_name is empty, just take the first one
        if theme_name.is_empty()
            || label_slug == theme_name.to_lowercase()
            || path.to_lowercase().contains(&theme_name.to_lowercase())
        {
            theme_path = Some(path.to_string());
            if theme_name.is_empty() {
                matched_name_str = label_slug;
            }
            break;
        }
    }

    if let Some(mut path) = theme_path {
        if path.starts_with("./") {
            path = path[2..].to_string();
        }
        let full_path = format!("extension/{}", path).replace("\\", "/");
        let theme_file = archive.by_name(&full_path).map_err(|e| e.to_string())?;
        if theme_file.size() > MAX_THEME_JSON_BYTES {
            return Err("VSIX theme file exceeds the allowed size".to_string());
        }
        let theme_json = read_zip_entry_to_string(theme_file, MAX_THEME_JSON_BYTES)?;

        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let themes_dir = config_dir.join("themes");
        fs::create_dir_all(&themes_dir).map_err(|e| e.to_string())?;

        let dest_name = if matched_name_str.is_empty() {
            "downloaded_theme".to_string()
        } else {
            matched_name_str.clone()
        };
        let dest_name = safe_path_component(&dest_name, "theme name")?;
        let theme_file_path = themes_dir.join(format!("{}.json", dest_name));
        atomic_write(&theme_file_path, theme_json.as_bytes()).map_err(|e| e.to_string())?;

        return Ok(dest_name.to_string());
    }

    Err("Theme name not found in extension".to_string())
}

#[tauri::command]
fn get_saved_vscode_themes(app: AppHandle) -> Result<Vec<String>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let themes_dir = config_dir.join("themes");
    let mut themes = Vec::new();
    if let Ok(entries) = fs::read_dir(themes_dir) {
        for entry in entries.flatten() {
            if let Some(ext) = entry.path().extension() {
                if ext == "json" {
                    if let Some(name) = entry.path().file_stem().and_then(|n| n.to_str()) {
                        themes.push(name.to_string());
                    }
                }
            }
        }
    }
    Ok(themes)
}

#[tauri::command]
fn read_vscode_theme(app: AppHandle, name: String) -> Result<String, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let name = safe_path_component(&name, "theme name")?;
    let theme_file_path = config_dir.join("themes").join(format!("{}.json", name));
    fs::read_to_string(theme_file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_vscode_theme(app: AppHandle, name: String) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let name = safe_path_component(&name, "theme name")?;
    let theme_file_path = config_dir.join("themes").join(format!("{}.json", name));
    fs::remove_file(theme_file_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_win11() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hklim = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(current_version) =
            hklim.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        {
            if let Ok(current_build) = current_version.get_value::<String, _>("CurrentBuild") {
                if let Ok(build_num) = current_build.parse::<u32>() {
                    return build_num >= 22000;
                }
            }
        }
    }
    false
}

/// Async because enumerating every installed font family is a slow,
/// filesystem-heavy call (fontconfig on Linux, DirectWrite on Windows,
/// CoreText on macOS) and the settings dialog invokes it on open. On the main
/// thread it stalls every window for the duration.
#[tauri::command]
async fn get_system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        let mut families = source.all_families().unwrap_or_default();
        families.sort();
        families.dedup();
        families
    })
    .await
    .unwrap_or_default()
}

/// Whether this install is able to replace its own binary.
///
/// `tauri-plugin-updater` has exactly one install strategy on Linux: rename the
/// downloaded file over the running executable. That works for an AppImage,
/// which is a file the user owns, and for nothing else — a `.deb` or `.rpm`
/// puts the binary in `/usr/bin` and a snap mounts it from a read-only
/// squashfs.
///
/// It would normally choose `install_deb` / `install_rpm` instead, from a bundle
/// type patched into the binary after the build. That patch fails on Linux —
/// three `Failed to add bundler type to the binary` warnings in every release
/// build, one per bundle — so `tauri_utils::platform::bundle_type()` returns
/// `None` and all three formats fall through to the AppImage path. Those users
/// were told an update existed and then watched it fail to install. See #570;
/// `build.yml` already documents the same missing symbol for a different
/// consequence, the shape of `latest.json`'s platform keys.
///
/// Read through `Env` rather than `std::env::var("APPIMAGE")` directly: tauri
/// also checks that the running executable sits under `$TMPDIR/.mount_`, so
/// setting the variable by hand cannot make a package-managed install claim it
/// is updatable.
///
/// Windows and macOS are unaffected. Windows' updater runs the downloaded NSIS
/// installer rather than overwriting anything in place, and macOS is the one
/// platform where `bundle_type()` answers without the patch.
#[tauri::command]
fn self_update_supported(app: AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        app.env().appimage.is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        true
    }
}

#[tauri::command]
fn get_os_type() -> String {
    #[cfg(target_os = "macos")]
    {
        "macos".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "windows".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "linux".to_string()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unknown".to_string()
    }
}


#[tauri::command]
fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read_image(macos_image_scaling: bool) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    let _ = macos_image_scaling;

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let image = clipboard.get_image().map_err(|e| e.to_string())?;

    // encode as png
    let mut png_data = Vec::new();
    {
        let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        use image::ImageEncoder;
        
        // Check if running on macOS and scale image if needed
        #[cfg(target_os = "macos")]
        {
            if macos_image_scaling {
                // Use image crate for high-quality scaling
                use image::{DynamicImage, ImageBuffer, Rgba};
                
                // Convert arboard Image to ImageBuffer
                let mut img_buffer = ImageBuffer::new(image.width as u32, image.height as u32);
                for (x, y, pixel) in img_buffer.enumerate_pixels_mut() {
                    let idx = (y * image.width as u32 + x) as usize * 4;
                    if idx + 3 < image.bytes.len() {
                        *pixel = Rgba([
                            image.bytes[idx],
                            image.bytes[idx + 1],
                            image.bytes[idx + 2],
                            image.bytes[idx + 3]
                        ]);
                    }
                }
                
                // Create DynamicImage
                let dynamic_image = DynamicImage::ImageRgba8(img_buffer);
                
                // Resize with high-quality Lanczos3 filter
                let resized = dynamic_image.resize(
                    (image.width / 2) as u32,
                    (image.height / 2) as u32,
                    image::imageops::FilterType::Lanczos3
                );
                
                // Write the resized image
                let resized_rgba = resized.to_rgba8();
                encoder
                    .write_image(
                        resized_rgba.as_raw(),
                        (image.width / 2) as u32,
                        (image.height / 2) as u32,
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| e.to_string())?;
            } else {
                // Use original image if scaling is disabled
                encoder
                    .write_image(
                        image.bytes.as_ref(),
                        image.width as u32,
                        image.height as u32,
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        
        #[cfg(not(target_os = "macos"))]
        {
            // For other platforms, use the original image
            encoder
                .write_image(
                    image.bytes.as_ref(),
                    image.width as u32,
                    image.height as u32,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
        }
    }

    use base64::{engine::general_purpose, Engine as _};
    Ok(general_purpose::STANDARD.encode(&png_data))
}

#[tauri::command]
async fn save_image(
    parent_dir: String,
    filename: String,
    base64_data: String,
    image_directory: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_image_blocking(&parent_dir, &filename, &base64_data, &image_directory)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

fn save_image_blocking(
    parent_dir: &str,
    filename: &str,
    base64_data: &str,
    image_directory: &str,
) -> Result<String, String> {
    let filename = safe_path_component(filename, "image filename")?;
    let (root, img_dir) = resolve_image_directory(parent_dir, image_directory)?;
    let file_path = img_dir.join(filename);
    ensure_path_within_root(&root, &file_path)?;

    // remove potential data:image/png;base64, prefix
    let b64 = if let Some(pos) = base64_data.find("base64,") {
        &base64_data[pos + 7..]
    } else {
        base64_data
    };

    use base64::{engine::general_purpose, Engine as _};
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e: base64::DecodeError| e.to_string())?;

    atomic_write(&file_path, &bytes).map_err(|e| e.to_string())?;

    let rel_path = if image_directory.is_empty() {
        filename.to_string()
    } else {
        format!("{}/{}", image_directory, filename)
    };

    Ok(rel_path)
}

#[tauri::command]
async fn copy_file_to_img(
    src_path: String,
    parent_dir: String,
    image_directory: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_file_to_img_blocking(&src_path, &parent_dir, &image_directory)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

/// How many conflict names to try before giving up. Chromium's download path
/// reservation gives up after 100 for the same reason: past that, the user is
/// better served by an error than by an unbounded directory scan.
const MAX_IMG_NAME_ATTEMPTS: u32 = 100;

/// Builds the `attempt`-th conflict name, e.g. `photo_1.png`, `photo_2.png`.
///
/// Every mainstream implementation resolves a name conflict with an
/// incrementing counter — Chrome/Firefox downloads (`photo (1).png`), Windows
/// Explorer (`photo (2).png`), macOS Finder (`photo 2.png`) — and none uses a
/// timestamp. They disagree only on the decoration, so this picks the one that
/// survives the destination: the name is about to be pasted into a Markdown
/// link, where parentheses are metacharacters and spaces need escaping, while
/// `_` needs neither. It is also the separator this function already used.
///
/// An empty extension gets no separator: `Path::extension()` is `None` for a
/// dotfile such as `.png`, and appending the dot unconditionally produced
/// `photo_1.` — a name Windows silently creates *without* the trailing dot,
/// leaving the link written into the document pointing at nothing.
fn img_conflict_name(stem: &str, ext: &str, attempt: u32) -> String {
    if ext.is_empty() {
        format!("{stem}_{attempt}")
    } else {
        format!("{stem}_{attempt}.{ext}")
    }
}

fn copy_file_to_img_blocking(
    src_path: &str,
    parent_dir: &str,
    image_directory: &str,
) -> Result<String, String> {
    let (root, img_dir) = resolve_image_directory(parent_dir, image_directory)?;

    let src = Path::new(src_path);
    if !src.exists() {
        return Err("Source file does not exist".to_string());
    }

    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid source filename".to_string())?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut source = fs::File::open(src).map_err(|e| e.to_string())?;

    // The destination name is claimed with `create_new`, which is a single
    // atomic syscall (`O_EXCL` / `CREATE_NEW`): whoever creates the file wins
    // and everyone else gets `AlreadyExists` and moves to the next name. The
    // previous code tested `exists()` and then copied, so two drops that
    // computed the same name — trivially, since the name carried a
    // second-resolution timestamp that was never re-checked — both saw the
    // name as free and the second overwrote an image the document already
    // linked to.
    //
    // Residual races: `O_EXCL` is not reliable on old NFSv2 mounts, and
    // nothing stops an outside process from deleting our file after we create
    // it. Neither is a same-app data-loss path, which is what this guards.
    // Streaming into the handle we just created, rather than `fs::copy`, also
    // means the copy no longer inherits the source's permission bits — a
    // read-only original used to produce a read-only file in `img/`.
    let mut dest_name = file_name.to_string();
    let mut attempt: u32 = 0;
    loop {
        let candidate = img_dir.join(&dest_name);
        ensure_path_within_root(&root, &candidate)?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut dest) => {
                // The name is ours; only the bytes can still fail. Drop the
                // placeholder if they do, so a failed drop does not leave a
                // truncated image behind under a name the user may reuse.
                if let Err(e) = std::io::copy(&mut source, &mut dest) {
                    drop(dest);
                    let _ = fs::remove_file(&candidate);
                    return Err(e.to_string());
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt += 1;
                if attempt > MAX_IMG_NAME_ATTEMPTS {
                    return Err(format!(
                        "Too many images named \"{}\" in this folder",
                        file_name
                    ));
                }
                dest_name = img_conflict_name(stem, ext, attempt);
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    let rel_path = if image_directory.is_empty() {
        dest_name
    } else {
        format!("{}/{}", image_directory, dest_name)
    };

    Ok(rel_path)
}

/// Async because `fs::copy` streams the whole file. On a network or removable
/// volume that is seconds of blocking I/O, and on the main thread it would
/// stall every window until the copy completes — the same reason its sibling
/// `copy_file_to_img` already runs on the blocking pool.
#[tauri::command]
async fn copy_file(src: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[tauri::command]
async fn list_directory_contents(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&path);
        if !dir.exists() || !dir.is_dir() {
            return Err("Not a directory".to_string());
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                entries.push(format!("{}/", name));
            } else {
                entries.push(name);
            }
        }
        Ok(entries)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    #[cfg(target_os = "windows")]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--enable-features=SmoothScrolling",
        );
    }

    tauri::Builder::default()
        .manage(AppState::new())
        .manage(WatcherState::new())
        .manage(tab_transfer::TabTransferBroker::new())
        // Replaces Tauri's own `asset:` handler, which reads the file on the
        // thread the webview calls it on — see `asset_protocol` for why that
        // freezes every window on an unreachable path. Registering the scheme
        // here is what suppresses the built-in one.
        .register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
            let scope = ctx.app_handle().asset_protocol_scope();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(asset_protocol::respond(&request, &|path| {
                    scope.is_allowed(path)
                }));
            });
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            window_runtime::handle_single_instance(app, args, cwd);
        }))
        .plugin(tauri_plugin_prevent_default::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                // Detached tab windows share one saved state instead of
                // accumulating a state entry per generated label.
                .map_label(|label| {
                    if label.starts_with("window-") {
                        "secondary"
                    } else {
                        label
                    }
                })
                .build(),
        )
        .setup(|app| {
            let args: Vec<String> = std::env::args().collect();

            let label = "main";

            let mut window_builder = tauri::WebviewWindowBuilder::new(
                app,
                label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Markpad")
            .inner_size(900.0, 650.0)
            .min_inner_size(400.0, 300.0)
            .visible(false)
            .resizable(true)
            .shadow(false)
            .center();

            #[cfg(target_os = "macos")]
            {
                window_builder = window_builder
                    .decorations(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            #[cfg(not(target_os = "macos"))]
            {
                window_builder = window_builder.decorations(false);
            }

            let window = window_builder.build()?;

            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

                let app_name = app.package_info().name.clone();

                let check_item =
                    MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
                let settings_item = MenuItemBuilder::with_id("menu-app-settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;

                let app_submenu = SubmenuBuilder::new(app, &app_name)
                    .item(&PredefinedMenuItem::about(
                        app,
                        Some(&format!("About {}", app_name)),
                        None,
                    )?)
                    .separator()
                    .item(&settings_item)
                    .item(&check_item)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id(
                            "menu-app-quit",
                            format!("Quit {}", app_name),
                        )
                        .accelerator("CmdOrCtrl+Q")
                        .build(app)?,
                    )
                    .build()?;

                // WKWebView declines ⌘X/⌘C/⌘V/⌘A/⌘Z in plain inputs and hands
                // them to the main menu, so without an Edit submenu those keys
                // are dead in every native field (settings, modals). Monaco is
                // unaffected either way: it preventDefault()s the key first, so
                // the menu never sees it and its own paste handler still runs.
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;

                // ⌘M and ⌃⌘F are window-server actions, not document actions:
                // there is no web API the in-window controls could bind them
                // to, so they only exist as long as a menu item carries them.
                // Full Screen belongs in a View menu by convention, but View
                // would hold that one item and nothing else — Markpad's view
                // actions are all in-window (#281) — so it rides here instead.
                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .items(&[&app_submenu, &edit_submenu, &window_submenu])
                    .build()?;

                app.set_menu(menu)?;
            }

            let config_dir = app.path().app_config_dir()?;
            let theme_path = config_dir.join("theme.txt");
            let theme_pref =
                fs::read_to_string(theme_path).unwrap_or_else(|_| "system".to_string());

            let bg_color = match theme_pref.as_str() {
                "dark" => Some(tauri::window::Color(24, 24, 24, 255)),
                "light" => Some(tauri::window::Color(253, 253, 253, 255)),
                _ => {
                    if let Ok(t) = window.theme() {
                        match t {
                            tauri::Theme::Dark => Some(tauri::window::Color(24, 24, 24, 255)),
                            _ => Some(tauri::window::Color(253, 253, 253, 255)),
                        }
                    } else {
                        Some(tauri::window::Color(253, 253, 253, 255))
                    }
                }
            };

            let _ = window.set_background_color(bg_color);

            let _ = window.set_shadow(true);

            let file_path = args.iter().skip(1).find(|arg| !arg.starts_with("-"));

            if let Some(path) = file_path {
                let _ = window.emit("file-path", path.as_str());
                window_runtime::bring_to_front(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clipboard_write_text,
            clipboard_read_text,
            clipboard_read_image,
            open_markdown_preview,
            render_markdown,
            list_heading_anchors,
            window_runtime::send_markdown_path,
            read_file_content_checked,
            canonicalize_path,
            read_file_as_data_url,
            save_file_content,
            export_pdf_windows,
            print_pdf,
            save_file_binary,
            is_win11,
            open_file_folder,
            rename_file,
            watch_file,
            window_runtime::unwatch_file,
            window_runtime::show_window,
            save_theme,
            get_system_fonts,
            get_os_type,
            self_update_supported,
            fetch_vscode_theme,
            get_saved_vscode_themes,
            read_vscode_theme,
            delete_vscode_theme,
            save_image,
            copy_file_to_img,
            copy_file,
            list_directory_contents,
            tab_transfer::stage_detached_tab,
            tab_transfer::claim_detached_tab,
            tab_transfer::complete_detached_tab,
            tab_transfer::cancel_detached_tab,
            create_transfer_window,
            window_runtime::set_window_meta,
            window_runtime::list_viewer_windows,
            window_runtime::is_window_tag_taken,
            window_runtime::offer_tab_to_window,
            window_runtime::focus_window,
            window_runtime::list_pinned_tags,
            window_runtime::save_pinned_tag,
            window_runtime::remove_pinned_tag,
            window_runtime::save_window_state,
            window_runtime::load_window_state,
            window_runtime::clear_window_state,
            window_runtime::save_restore_progress,
            window_runtime::load_restore_progress,
            window_runtime::clear_restore_progress
        ])
        .on_window_event(window_runtime::handle_window_event)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // Emit to the focused webview window's label rather than
            // `window.emit(...)`, which broadcasts to every webview and
            // would fire menu actions (New/Close/Save…) in all windows at
            // once. Falls back to "main" if no window is focused (e.g. menu
            // fired while the app is in the background).
            let target = app
                .webview_windows()
                .into_values()
                .find(|w| w.is_focused().unwrap_or(false))
                .or_else(|| app.get_webview_window("main"));
            let Some(window) = target else { return };

            if id == "menu-app-settings" {
                let _ = app.emit_to(window.label(), "menu-app-settings", ());
            } else if id == "check-updates" {
                let _ = app.emit_to(window.label(), "menu-check-updates", ());
            } else if id == "menu-app-quit" {
                let _ = app.emit_to(window.label(), id, ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path_buf) = url.to_file_path() {
                        let path_str = path_buf.to_string_lossy().to_string();

                        let state = _app_handle.state::<AppState>();
                        window_runtime::lock_recover(&state.startup_files)
                            .push(path_str.clone());

                        if let Some(window) = pick_delivery_window(_app_handle) {
                            let _ = _app_handle.emit_to(window.label(), "file-path", path_str);
                            window_runtime::bring_to_front(&window);
                        }
                    }
                }
            }
        });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
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
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

        fs::remove_dir_all(dir).unwrap();
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
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");

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
    const CHINESE_SAMPLE: &str = "# 中文标题\n\n这是一个用国标编码保存的文档，里面全是汉字。\n";

    /// One realistic document per legacy encoding Markpad is likely to meet.
    /// Each is text that encoding can represent and UTF-8 disagrees with.
    const LEGACY_SAMPLES: [(&'static encoding_rs::Encoding, &str); 4] = [
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

    fn legacy_bytes(encoding: &'static encoding_rs::Encoding, text: &str) -> Vec<u8> {
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
    fn the_preview_decodes_a_legacy_file_at_both_sizes() {
        // The two branches the issue's size table describes. They used to
        // disagree — strict below the budget, lossy above it — so the same
        // document opened or failed depending on how long it was. One decoder
        // now serves both, and neither produces mojibake.
        let path = temp_path("gbk-preview.md");
        let mut original = legacy_bytes(encoding_rs::GBK, CHINESE_SAMPLE);
        original.extend_from_slice(&legacy_bytes(encoding_rs::GBK, CHINESE_SAMPLE));
        fs::write(&path, &original).unwrap();

        let whole = build_markdown_preview(&path, 50_000).unwrap();
        assert!(whole.is_full);
        assert!(
            !whole.lossy,
            "the small-file branch produced {:?}",
            whole.content
        );
        assert_eq!(whole.encoding, "GBK");
        assert_eq!(
            encode_text(&whole.content, &whole.encoding).unwrap(),
            original,
        );

        // Cut on a byte boundary the detector still has plenty of text before.
        let cut = build_markdown_preview(&path, original.len() / 2).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(!cut.is_full);
        assert!(
            !cut.content.contains("\u{FFFD}\u{FFFD}"),
            "the truncated branch fell back to mojibake: {:?}",
            cut.content,
        );
    }

    #[test]
    fn an_oversized_utf8_preview_is_not_flagged() {
        // The preview budget lands inside a multi-byte character. Reporting
        // that as lossy would lock every large CJK or emoji document out of
        // saving — a guard worse than the bug it protects against.
        let path = temp_path("utf8-preview.md");
        fs::write(&path, "中文标题很长".as_bytes()).unwrap();

        let preview = build_markdown_preview(&path, 4).unwrap();
        fs::remove_file(&path).unwrap();

        assert!(!preview.is_full);
        assert!(!preview.lossy, "unexpected flag on {:?}", preview.content);
        assert_eq!(preview.content, "中");
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
    fn zip_entry_reads_stop_at_the_limit_even_when_the_header_understates_size() {
        let payload = vec![b'a'; 64];
        assert_eq!(
            read_zip_entry_to_string(payload.as_slice(), 64).unwrap().len(),
            64,
        );
        assert!(
            read_zip_entry_to_string(payload.as_slice(), 32).is_err(),
            "an entry larger than the ceiling must be rejected, not buffered",
        );
    }

    #[test]
    fn export_data_url_uses_mime_from_extension_case_insensitively() {
        assert_eq!(mime_type_for_export_path(Path::new("diagram.PNG")), "image/png");
        assert_eq!(mime_type_for_export_path(Path::new("photo.JpEg")), "image/jpeg");
        assert_eq!(mime_type_for_export_path(Path::new("vector.svg")), "image/svg+xml");
        assert_eq!(mime_type_for_export_path(Path::new("unknown.bin")), "application/octet-stream");
    }

    #[test]
    fn export_data_url_encodes_bytes_with_mime() {
        assert_eq!(
            file_bytes_to_data_url("image/png", b"Markpad"),
            "data:image/png;base64,TWFya3BhZA==",
        );
    }

    #[test]
    fn task_list_checkbox_is_emitted_at_the_start_of_its_list_item() {
        // The attribute order here is comrak's, captured, not a requirement:
        // 0.18 wrote `disabled="" checked=""` and 0.54 writes them the other
        // way round, and `tasklist_classes` adds a `class` between the tag and
        // them. What this pins is that `data-task-checkbox` is present on
        // *both* items and that the marker sits at the start of the `<li>`.
        // `TASK_ITEM_RE` deliberately depends on neither the order nor the
        // presence of the class, so a future reordering fails here — loudly —
        // instead of quietly un-marking one of the two.
        //
        // Note the `<ul>` carries `contains-task-list` while these `<li>`s do
        // not carry `task-list-item`: comrak only writes the item class on the
        // branch that opens the `<li>` itself. styles.css asks for either, so
        // the bullet suppression still lands.
        let html = convert_markdown("- [ ] open task\n- [x] completed task\n");
        assert!(
            html.contains("<ul class=\"contains-task-list\""),
            "the list class the stylesheet needs is missing: {html}",
        );
        assert!(
            html.contains("<li data-sourcepos=\"1:1-1:15\"><input type=\"checkbox\" data-task-checkbox=\"\" class=\"task-list-item-checkbox\" disabled=\"\" /> open task</li>"),
            "unexpected task-list HTML: {html}",
        );
        assert!(
            html.contains("<li data-sourcepos=\"2:1-2:20\"><input type=\"checkbox\" data-task-checkbox=\"\" class=\"task-list-item-checkbox\" checked=\"\" disabled=\"\" /> completed task</li>"),
            "unexpected task-list HTML: {html}",
        );
    }

    #[test]
    fn raw_html_checkboxes_are_not_marked_as_tasks() {
        let html = convert_markdown("- <input type=\"checkbox\" /> raw control\n");
        assert!(
            !html.contains("data-task-checkbox"),
            "raw HTML control was incorrectly marked as a task: {html}",
        );
    }

    #[test]
    fn nested_and_quoted_task_checkboxes_are_marked() {
        let html = convert_markdown("- [ ] parent\n  - [x] nested\n\n> - [ ] quoted\n");
        assert_eq!(
            html.matches("data-task-checkbox").count(),
            3,
            "unexpected task-list HTML: {html}",
        );
    }

    #[test]
    fn markdown_protocol_preserves_task_markers_for_many_source_lines() {
        let markdown = (1..=64)
            .map(|line| match line % 3 {
                0 => format!("> - [ ] quoted task {line}"),
                1 => format!("- [ ] task {line}"),
                _ => format!("  - [x] nested task {line}"),
            })
            .collect::<Vec<_>>()
            .join("\n");

        let html = convert_markdown(&markdown);
        assert_eq!(html.matches("data-task-checkbox").count(), 64, "{html}");
        assert!(html.contains("data-sourcepos=\"64:1-64:"), "{html}");
    }

    #[test]
    fn multiline_wikilinks_do_not_shift_task_source_positions() {
        let html = convert_markdown("[[#first\nsecond|alias]]\n- [ ] task\n");
        assert!(
            html.contains("data-task-checkbox"),
            "task source position was shifted by a multiline wikilink: {html}",
        );
    }

    #[test]
    fn embed_protection_survives_longer_backtick_runs_earlier_in_the_doc() {
        // A 4-backtick inline sample desynchronized the old regex pairing and
        // exposed every later code span to rewriting.
        let input = "```` ```mermaid ```` fence sample\n\ncode: `![[not-an-embed.md]]`\n";
        let out = process_internal_embeds(input);
        assert!(out.contains("`![[not-an-embed.md]]`"), "got: {out}");
        assert!(!out.contains("<img"), "got: {out}");
    }

    #[test]
    fn embeds_inside_tilde_fences_are_protected() {
        // The old pattern only knew ``` fences; ~~~ was not protected at all.
        let input = "~~~\n![[inside.md]]\n~~~\n\n![[outside.md]]\n";
        let out = process_internal_embeds(input);
        assert!(out.contains("![[inside.md]]"), "got: {out}");
        assert!(out.contains("<img src=\"outside.md\""), "got: {out}");
    }

    #[test]
    fn fence_closes_only_on_a_run_at_least_as_long() {
        let input = "````\n```\n![[still-code.md]]\n````\n![[after.md]]\n";
        let out = process_internal_embeds(input);
        assert!(out.contains("![[still-code.md]]"), "got: {out}");
        assert!(out.contains("<img src=\"after.md\""), "got: {out}");
    }

    #[test]
    fn unclosed_fence_protects_to_end_of_input() {
        let input = "```\n![[never-closed.md]]\n";
        let out = process_internal_embeds(input);
        assert!(out.contains("![[never-closed.md]]"), "got: {out}");
    }

    #[test]
    fn double_backtick_span_pairs_only_with_double_backticks() {
        // `` a ` b `` is ONE span; the inner single backtick does not close it.
        let input = "`` a ` ![[in-span.md]] `` then ![[outside.md]]\n";
        let out = process_internal_embeds(input);
        assert!(out.contains("![[in-span.md]]"), "got: {out}");
        assert!(out.contains("<img src=\"outside.md\""), "got: {out}");
    }

    #[test]
    fn embeds_outside_code_are_still_rewritten_with_sizes() {
        let out = process_internal_embeds("![[pic.png|300x200]]\n");
        assert!(out.contains("width=\"300\""), "got: {out}");
        assert!(out.contains("height=\"200\""), "got: {out}");
    }

    #[test]
    fn highlight_protection_survives_quadruple_backtick_inline_code() {
        // Asserted through the renderer rather than through `process_wikilinks`:
        // highlighting is comrak's now, so the protection is the parser's own
        // rather than a code-region scan this crate performs. The property is
        // the same one — a `==…==` inside a code span is text.
        let input = "```` ``` ```` intro\n\n`==not highlighted==` but ==this is==\n";
        let out = convert_markdown(input);
        assert!(out.contains("==not highlighted=="), "got: {out}");
        assert!(!out.contains(">not highlighted</mark>"), "got: {out}");
        // comrak's `<mark>` carries a `data-sourcepos`, which the regex's did
        // not — matched loosely so this asserts the highlight, not the markup.
        assert!(out.contains(">this is</mark>"), "got: {out}");
    }

    #[test]
    fn wikilinks_and_inline_footnotes_in_code_spans_stay_literal() {
        let input = "`[[#heading]]` and `^[not a footnote]` but [[#real|jump]]\n";

        let out = process_wikilinks(input);
        assert!(out.contains("`[[#heading]]`"), "got: {out}");
        assert!(out.contains("[jump](#real)"), "got: {out}");

        // The footnote half moved to comrak with `inline_footnotes`, so the
        // rewriter passing it through is no longer evidence of anything. What
        // matters is that the RENDERED document still has it as code.
        let html = convert_markdown(input);
        assert!(html.contains("^[not a footnote]"), "got: {html}");
        assert!(!html.contains("not a footnote</p>"), "it became a footnote: {html}");
    }

    /// A document that has BOTH kinds of code region, with the inline span at
    /// a lower offset than the fence.
    ///
    /// `in_code_region` is a binary search, so `code_region_ranges` has to
    /// emit its regions in document order. The two kinds are found by
    /// different parts of the scan — fences by the line walk, inline spans by
    /// `push_inline_code_spans` over the text between fences — and a build
    /// order that appends all of one kind after all of the other leaves the
    /// vector unsorted for exactly this shape of document. The binary search
    /// then walks straight past the fence and every marker inside it is
    /// reported as ordinary prose (#375 / #389 all over again).
    ///
    /// Every marker below is checked, not just one. `process_wikilinks` runs
    /// a separate pass per marker kind and each probes `in_code_region` at its
    /// own offset, so a probe that happens to land inside the region does not
    /// say anything about the probes beside it.
    const FENCE_AFTER_INLINE_CODE: &str = concat!(
        "Prose with `a code span` in it.\n",
        "\n",
        "```text\n",
        "![[embed.md]]\n",
        "[[wikilink]]\n",
        "==highlight==\n",
        "^[footnote]\n",
        "```\n",
    );

    #[test]
    fn an_inline_span_before_a_fence_does_not_expose_the_fence_to_embeds() {
        let out = process_internal_embeds(FENCE_AFTER_INLINE_CODE);
        assert!(
            out.contains("![[embed.md]]") && !out.contains("<img"),
            "an embed inside the fence was rewritten — code regions reached \
             `in_code_region` out of document order: {out}",
        );
    }

    #[test]
    fn an_inline_span_before_a_fence_does_not_expose_the_fence_to_wikilinks() {
        let out = process_wikilinks(FENCE_AFTER_INLINE_CODE);
        for marker in ["[[wikilink]]", "==highlight==", "^[footnote]"] {
            assert!(
                out.contains(marker),
                "`{marker}` inside the fence was rewritten — code regions \
                 reached `in_code_region` out of document order: {out}",
            );
        }
        // The inline span itself is still protected, and still a span.
        assert!(out.contains("`a code span`"), "got: {out}");
    }

    #[test]
    fn an_inline_span_before_a_fence_does_not_expose_the_fence_to_autolinks() {
        // The third consumer. A bare URL inside a fence must stay text;
        // comrak's own autolinker never sees a code block.
        let input = "Prose with `a code span` in it.\n\n```text\n(https://example.com/x)y\n```\n";
        let out = process_parenthesized_autolinks(input);
        assert!(
            !out.contains("]("),
            "a URL inside the fence was linkified: {out}",
        );
    }

    #[test]
    fn an_inline_span_before_a_fence_does_not_expose_the_fence_to_math() {
        // The fourth consumer. `mask_math_spans` hides math from CommonMark's
        // inline rules; dollars inside a fence are not math and masking them
        // rewrites the code block the user typed.
        let input = "Prose with `a code span` in it.\n\n```text\n$x_1$ and $y_2$\n```\n";
        let masked = mask_math_spans(input);
        assert_eq!(
            masked.text, input,
            "dollars inside the fence were masked as math",
        );
    }

    #[test]
    fn multibyte_content_inside_a_fence_does_not_panic() {
        let input = "```text\n中文开头的一行\n```\n\n![[outside.png]]\n";
        let result = std::panic::catch_unwind(|| process_internal_embeds(input));

        let out = result.expect("fenced multibyte content must not panic");
        assert!(out.contains("中文开头的一行"), "got: {out}");
        assert!(out.contains("<img src=\"outside.png\""), "got: {out}");
    }

    #[test]
    fn autolink_inside_parentheses_stops_before_adjacent_text() {
        let input = "See (https://www.speedtest.net/awards/united_states/)for more information.";
        let html = convert_markdown(input);

        assert!(
            html.contains("href=\"https://www.speedtest.net/awards/united_states/\""),
            "got: {html}"
        );
        assert!(html.contains(")for more information."), "got: {html}");
        assert!(
            !html.contains("href=\"https://www.speedtest.net/awards/united_states/)for\""),
            "got: {html}"
        );
    }

    #[test]
    fn path_components_reject_traversal_separators_and_absolute_paths() {
        for invalid in ["", ".", "..", "../theme", "folder/theme", "folder\\theme", "/tmp/theme"] {
            assert!(safe_path_component(invalid, "test").is_err(), "{invalid}");
        }
        assert_eq!(safe_path_component("SynthWave '84", "test").unwrap(), "SynthWave '84");
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

    #[test]
    fn theme_slug_collapses_punctuation_runs() {
        assert_eq!(theme_slug("SynthWave '84"), "synthwave-84");
    }

    #[test]
    fn display_math_keeps_multiple_braced_subscripts_out_of_markdown_emphasis() {
        let html = convert_markdown("$$\\bar{b}_{1} + \\bar{b}_{2}$$\n");
        assert!(
            html.contains("$$\\bar{b}_{1} + \\bar{b}_{2}$$"),
            "unexpected parser output: {html}",
        );
        assert!(!html.contains("<em"), "unexpected parser output: {html}");
    }

    // -----------------------------------------------------------------
    // Math delimiters
    //
    // comrak runs CommonMark inline rules inside math delimiters, so KaTeX
    // never sees what the user typed. The three cases below are the
    // reported symptoms of that one cause; the block after them is the
    // other half of the bargain, because a rule that mistakes prose for
    // math breaks far more documents than the bug it fixes.
    // -----------------------------------------------------------------

    /// The rendered text with the markup taken back out, i.e. roughly what
    /// `textContent` hands to KaTeX in the frontend.
    fn rendered_math_source(html: &str) -> String {
        let mut out = String::new();
        let mut rest = html;
        while let Some(at) = rest.find('<') {
            out.push_str(&rest[..at]);
            match rest[at..].find('>') {
                Some(end) => rest = &rest[at + end + 1..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        out.push_str(rest);
        out.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&amp;", "&")
    }

    #[test]
    fn issue_174_inline_math_keeps_both_braced_subscripts() {
        // `$\bar{b}_{1} + \bar{b}_{2}$` — the two `_` are both left- and
        // right-flanking, so CommonMark pairs them into an `<em>` and KaTeX
        // receives `$\bar{b}<em>{1} + \bar{b}</em>{2}$`. That is the whole of
        // "only the first subscript can use braces", and why a space before
        // the first `_` appeared to fix it.
        let html = convert_markdown("Let $\\bar{b}_{1} + \\bar{b}_{2}$ be the estimates.\n");
        assert!(!html.contains("<em"), "math was parsed as emphasis: {html}");
        assert!(
            html.contains("$\\bar{b}_{1} + \\bar{b}_{2}$"),
            "the formula did not survive: {html}",
        );
    }

    #[test]
    fn issue_197_display_math_keeps_the_row_separators_of_an_aligned_block() {
        // `\\` is a CommonMark escape for a literal `\`, so every row
        // separator of the block is eaten and KaTeX renders "Only One
        // Long-Long Line" that overflows horizontally.
        let markdown =
            "$$\n\\begin{aligned}\na &= b \\\\\nc &= d \\\\\ne &= f\n\\end{aligned}\n$$\n";
        let html = convert_markdown(markdown);
        let source = rendered_math_source(&html);
        assert_eq!(
            source.matches("\\\\").count(),
            2,
            "the row separators were eaten as CommonMark escapes: {html}",
        );
        assert!(
            source.contains("a &= b \\\\"),
            "the row separators were eaten as CommonMark escapes: {html}",
        );
    }

    #[test]
    fn issue_177_math_keeps_escaped_percent_signs() {
        // `\%` loses its backslash to CommonMark, and the bare `%` then
        // starts a TeX comment: KaTeX reports "Unexpected end of input in a
        // macro argument".
        let html = convert_markdown("$$\\mathbf{Accuracy: 100\\%}$$\n");
        assert!(
            html.contains("\\mathbf{Accuracy: 100\\%}"),
            "the escaped percent sign was eaten: {html}",
        );
    }

    #[test]
    fn math_delimiters_survive_every_other_commonmark_inline_rule() {
        // The point of masking the span rather than one character class:
        // emphasis, escapes and code marks are all TeX here.
        let html = convert_markdown("$$a*b*c \\_ \\{ \\& ~y~ [z](w)$$\n");
        assert!(!html.contains("<em"), "got: {html}");
        assert!(!html.contains("<del"), "got: {html}");
        assert!(!html.contains("<a "), "got: {html}");
        assert!(
            rendered_math_source(&html).contains("$$a*b*c \\_ \\{ \\& ~y~ [z](w)$$"),
            "got: {html}",
        );
    }

    #[test]
    fn a_multiline_display_math_block_keeps_one_line_per_source_line() {
        // The mask is per line, so the block still occupies six lines and
        // the frontend still sees one `<br />` per row.
        let markdown = "$$\n\\begin{aligned}\nx &= 1\n\\end{aligned}\n$$\n\n- [ ] task\n";
        let html = convert_markdown(markdown);
        assert_eq!(html.matches("<br").count(), 4, "got: {html}");
        assert!(
            html.contains("data-sourcepos=\"7:1-7:10\""),
            "the task moved off line 7: {html}",
        );
    }

    #[test]
    fn a_crlf_display_math_block_keeps_its_line_endings() {
        let html = convert_markdown("$$\r\na_1 \\\\\r\nb_2\r\n$$\r\n");
        assert!(!html.contains("<em"), "got: {html}");
        assert!(
            rendered_math_source(&html).contains("a_1 \\\\"),
            "got: {html}",
        );
    }

    // --- the other half: prose that must NOT become math ----------------

    #[test]
    fn two_prices_in_one_sentence_are_not_a_math_span() {
        // The failure mode that matters most. `$100 and $200` pairs under any
        // naive "next `$` closes it" rule and would silently swallow the
        // Markdown of every document that mentions two prices.
        let html = convert_markdown("It cost $100 and $200 today.\n");
        assert!(
            html.contains("It cost $100 and $200 today."),
            "a price was treated as math: {html}",
        );
    }

    #[test]
    fn ordinary_dollar_amounts_are_not_math_spans() {
        for markdown in [
            "The price is $5.\n",
            "Between $5 and $10.\n",
            "$100$200 back to back.\n",
            "A lone $ sign.\n",
            "Trailing dollar $\n",
            "Costs $ 5 with a space.\n",
            "$5\n$6\n",
        ] {
            let html = convert_markdown(markdown);
            assert_eq!(
                rendered_math_source(&html).trim(),
                markdown.trim(),
                "input {markdown:?} was rewritten: {html}",
            );
        }
    }

    #[test]
    fn an_escaped_dollar_never_opens_a_math_span() {
        let html = convert_markdown("Pay \\$100 for $x$ items.\n");
        assert!(
            html.contains("Pay \\$100 for $x$ items."),
            "the escaped dollar opened a span: {html}",
        );
    }

    #[test]
    fn an_escaped_dollar_reaches_the_frontend_still_escaped() {
        // comrak resolves `\$` to `$`, after which nothing downstream can tell
        // "the reader wants a dollar sign" from "the reader wants a formula" —
        // and the frontend, which is the side that decides, renders the second.
        // So the escape is masked like math is and handed over intact; the
        // frontend resolves it in `convertInlineMathDelimiters`.
        let html = convert_markdown("Literal \\$\\$x\\$\\$ here.\n");
        assert!(
            html.contains("Literal \\$\\$x\\$\\$ here."),
            "the escape was resolved before the frontend could honour it: {html}",
        );
    }

    #[test]
    fn an_escaped_backslash_keeps_the_dollar_behind_it_live() {
        // `\\$` is an escaped backslash and then an ordinary `$`. Masking only
        // the last backslash would hand the frontend `\$` and lose the
        // distinction the whole mask exists to preserve.
        let html = convert_markdown("A backslash \\\\$ here.\n");
        assert!(
            html.contains("A backslash \\\\$ here."),
            "the backslash run was split: {html}",
        );
    }

    #[test]
    fn an_escaped_dollar_inside_a_formula_stays_part_of_the_formula() {
        // Inside math, `\$` is TeX for a dollar sign. The math span already
        // shields it, and claiming it separately would cut the span in two.
        let html = convert_markdown("$a \\$ b$\n");
        assert_eq!(rendered_math_source(&html).trim(), "$a \\$ b$");
    }

    #[test]
    fn an_escaped_dollar_in_a_link_destination_is_resolved_not_forwarded() {
        // Nothing unescapes an `href` on the way to the reader, so the
        // backslash would simply become part of the URL.
        let html = convert_markdown("[t](http://example.com/\\$5)\n");
        assert!(
            html.contains("href=\"http://example.com/$5\""),
            "the escape leaked into the link destination: {html}",
        );
    }

    #[test]
    fn an_escaped_dollar_inside_code_is_left_to_commonmark() {
        // A backslash is not an escape character inside code, so `\$` is two
        // literal characters there and comrak already gets it right.
        let html = convert_markdown("Use `\\$x\\$` here.\n");
        assert!(
            html.contains(">\\$x\\$</code>"),
            "the mask reached into a code span: {html}",
        );
    }

    #[test]
    fn dollars_inside_code_never_open_a_math_span() {
        // A single `$$` inside a fence used to flip the delimiter parity of
        // the entire document, because the old protection just split on `$$`.
        let markdown = "```sh\necho $$\n```\n\nA *word* and $$x_1$$ after.\n\n`$a$` stays code.\n";
        let html = convert_markdown(markdown);
        assert!(html.contains("<em"), "the fence ate the emphasis: {html}");
        assert!(
            html.contains("$$x_1$$"),
            "the math after the fence lost its protection: {html}",
        );
        assert!(
            html.contains(">$a$</code>"),
            "an inline code span was treated as math: {html}",
        );
    }

    #[test]
    fn a_math_span_never_reaches_across_an_inline_code_span() {
        // The frontend cannot pair delimiters across a `<code>` element —
        // `processInlineMath` rejects the whole subtree — so neither may the
        // backend: masking here would silently eat the code span.
        let html = convert_markdown("$a `x` b$ and *emphasis*.\n");
        assert!(html.contains(">x</code>"), "got: {html}");
        assert!(html.contains("<em"), "got: {html}");
    }

    #[test]
    fn a_math_span_never_reaches_across_a_line_break() {
        // `hardbreaks` puts each source line in its own text node, so an
        // unpaired `$` must not reach the next line and blank out its
        // Markdown.
        let html = convert_markdown("Costs $5 today\nand *this* is emphasis $\n");
        assert!(html.contains("<em"), "got: {html}");
    }

    #[test]
    fn an_unpaired_display_delimiter_does_not_swallow_the_document() {
        let markdown = "$$ unpaired\n\nA *word*.\n\nAnother paragraph with $$ too.\n";
        let html = convert_markdown(markdown);
        assert!(html.contains("<em"), "the stray `$$` ran away: {html}");
    }

    #[test]
    fn a_document_containing_the_mask_prefix_still_round_trips() {
        // Uniqueness is by construction, not by luck: the prefix grows until
        // the document does not contain it.
        let markdown = format!("{MATH_MASK_PREFIX}0{MATH_MASK_SUFFIX} and $x_1$ here.\n");
        let html = convert_markdown(&markdown);
        assert!(
            html.contains(&format!("{MATH_MASK_PREFIX}0{MATH_MASK_SUFFIX}")),
            "the document's own text was eaten: {html}",
        );
        assert!(html.contains("$x_1$"), "the math was lost: {html}");
        assert!(!html.contains("<em"), "got: {html}");
    }

    #[test]
    fn a_masked_span_is_escaped_the_way_comrak_escapes_text() {
        let html = convert_markdown("$a < b & c > d \"e\"$\n");
        assert!(
            html.contains("$a &lt; b &amp; c &gt; d &quot;e&quot;$"),
            "the restored span was not escaped: {html}",
        );
    }

    // -----------------------------------------------------------------
    // The cross-language math-delimiter contract
    //
    // Everything above proves the backend hides the right spans from
    // comrak. It cannot prove the thing correctness actually rests on:
    // that the set the backend hides equals the set the *frontend*
    // renders. Those are two implementations of one rule in two
    // languages, and until now only one of them was pinned — loosening
    // `findInlineMathEnd` in markdown.ts would have left every test in
    // this file green.
    //
    //   backend ⊂ frontend → comrak mangles the formula before KaTeX
    //                        sees it; that is #174, #177 and #197.
    //   backend ⊃ frontend → the text is held back from Markdown and
    //                        then rendered by nobody: the reader gets
    //                        dead text that is neither prose nor a
    //                        formula.
    //
    // So both sides are asserted against one shared, hand-authored
    // table: scripts/mathDelimiterCorpus.json. The other half lives in
    // scripts/mathDelimiterContract.test.ts and runs the real frontend.
    // Change one side's rule and exactly one of the two goes red.
    // -----------------------------------------------------------------

    #[derive(serde::Deserialize)]
    struct MathContractSpan {
        kind: String,
        source: String,
    }

    #[derive(serde::Deserialize)]
    struct MathContractCase {
        name: String,
        markdown: String,
        html: String,
        math: Vec<MathContractSpan>,
    }

    #[derive(serde::Deserialize)]
    struct MathContractCorpus {
        cases: Vec<MathContractCase>,
    }

    fn math_contract_corpus() -> MathContractCorpus {
        serde_json::from_str(include_str!("../../scripts/mathDelimiterCorpus.json"))
            .expect("scripts/mathDelimiterCorpus.json must stay valid JSON")
    }

    /// What the backend decided, in the corpus's vocabulary.
    fn recognised_math(markdown: &str) -> Vec<(String, String)> {
        let regions = code_region_ranges(markdown);
        find_math_spans(markdown, &regions)
            .into_iter()
            .map(|(start, end)| {
                let span = &markdown[start..end];
                match span
                    .strip_prefix("$$")
                    .and_then(|inner| inner.strip_suffix("$$"))
                {
                    // `extractDisplayMathBlock` trims; mirror it exactly.
                    Some(inner) => ("display".to_owned(), inner.trim().to_owned()),
                    None => ("inline".to_owned(), span[1..span.len() - 1].to_owned()),
                }
            })
            .collect()
    }

    #[test]
    fn the_backend_recognises_exactly_the_math_the_contract_lists() {
        for case in math_contract_corpus().cases {
            let expected: Vec<(String, String)> = case
                .math
                .iter()
                .map(|span| (span.kind.clone(), span.source.clone()))
                .collect();
            assert_eq!(
                recognised_math(&case.markdown),
                expected,
                "{}: the backend and the contract disagree about what is math\n  input: {:?}",
                case.name,
                case.markdown,
            );
        }
    }

    #[test]
    fn the_math_contract_corpus_is_a_live_capture() {
        // Keeps the `html` the frontend test consumes honest: it is what
        // this renderer produces today, not what it produced once.
        for case in math_contract_corpus().cases {
            assert_eq!(
                convert_markdown(&case.markdown),
                case.html,
                "{}: scripts/mathDelimiterCorpus.json no longer matches this \
                 renderer — replace its `html` with the value on the left, and \
                 leave `markdown` and `math` alone",
                case.name,
            );
        }
    }

    #[test]
    fn math_in_a_heading_keeps_the_anchor_a_wikilink_can_reach() {
        // comrak derives the heading id from the *rendered* text, so the mask
        // would otherwise become the anchor and silently break every
        // `[[#heading]]` pointing at a heading that contains a formula.
        let heading = "A heading with $x_1$";
        let html = convert_markdown(&format!("# {heading}\n"));
        assert!(html.contains("$x_1$"), "the math was lost: {html}");
        assert_eq!(
            heading_anchor_id(heading),
            "a-heading-with-x_1",
            "the wikilink side changed",
        );
        assert!(
            html.contains("id=\"a-heading-with-x_1\""),
            "the mask leaked into the anchor: {html}",
        );
    }

    #[test]
    fn math_in_a_link_destination_keeps_the_link_working() {
        // The token has to survive `escape_href` too, which is why it is
        // plain ASCII rather than a private-use character.
        let html = convert_markdown("[t](http://example.com/$a$)\n");
        assert!(
            html.contains("href=\"http://example.com/$a$\""),
            "the link destination was mangled: {html}",
        );
    }

    #[test]
    fn a_stray_backtick_does_not_swallow_later_paragraphs() {
        // CommonMark parses inline elements per block and a blank line ends a
        // block, so the loose backtick in the first paragraph cannot pair with
        // the opening backtick of `run()` two paragraphs down.
        let input =
            "Use the ` character to start code.\n\n![[photo.png]]\n\nThen `run()` finishes.\n";

        let out = process_internal_embeds(input);
        assert!(out.contains("<img src=\"photo.png\""), "got: {out}");
        assert!(out.contains("`run()`"), "got: {out}");
    }

    #[test]
    fn a_stray_backtick_does_not_swallow_later_highlights_or_wikilinks() {
        let input = "Use the ` character.\n\n==important== and [[#Some Heading|jump]]\n\nThen `run()` finishes.\n";

        // The wikilink half is still this crate's, and is still asserted on the
        // rewriter. The highlight half is comrak's, so it is asserted on the
        // rendered document.
        assert!(process_wikilinks(input).contains("(#some-heading)"));
        let out = convert_markdown(input);
        assert!(out.contains(">important</mark>"), "got: {out}");
        assert!(out.contains(">run()</code>"), "got: {out}");
    }

    #[test]
    fn inline_code_spans_still_pair_across_lines_inside_one_paragraph() {
        // A code span may legitimately span several lines of the same block;
        // the blank-line reset must not break that.
        let input = "start `code\n![[inside.png]]` end\n";
        let out = process_internal_embeds(input);
        assert!(out.contains("![[inside.png]]"), "got: {out}");
        assert!(!out.contains("<img"), "got: {out}");
    }

    #[test]
    fn embed_attributes_are_html_escaped() {
        // The viewer sanitizes with DOMPurify, but the HTML export path writes
        // this markup straight to disk, so the quote has to die here.
        let out = process_internal_embeds("![[a\" onerror=\"alert(1)]]\n");
        assert!(!out.contains("onerror=\""), "attribute injection: {out}");
        assert!(out.contains("&quot;"), "got: {out}");

        let sized = process_internal_embeds("![[p.png|300\" onload=\"x]]\n");
        assert!(!sized.contains("onload=\""), "attribute injection: {sized}");

        let single = process_internal_embeds("![[p.png|64\" onload=\"y]]\n");
        assert!(!single.contains("onload=\""), "attribute injection: {single}");
    }

    #[test]
    fn embed_attribute_escaping_keeps_ordinary_paths_readable() {
        let out = process_internal_embeds("![[my photo.png]]\n");
        assert!(out.contains("src=\"my%20photo.png\""), "got: {out}");
        assert!(out.contains("alt=\"my photo.png\""), "got: {out}");
    }

    #[test]
    fn wikilink_anchors_match_the_ids_comrak_actually_renders() {
        // Asserted against comrak's real output rather than a copy of its
        // rules: if a comrak upgrade changes anchorization, this fails instead
        // of silently producing wikilinks that jump nowhere.
        for heading in [
            "1. 概述",
            "Ticks aren't in",
            "Hello, World!",
            "Setup & Teardown",
            "under_score here",
        ] {
            let html = convert_markdown(&format!("## {heading}\n"));
            let rendered_id = html
                .split("id=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap_or_else(|| panic!("no heading id rendered: {html}"));
            assert_eq!(
                heading_anchor_id(heading),
                rendered_id,
                "anchor for {heading:?} drifted from comrak: {html}",
            );
        }
    }

    /// The list the editor completes from has to name the ids that are on
    /// screen. Rendering the same document and reading its `id=` attributes
    /// back is the only check that cannot drift from comrak with it.
    #[test]
    fn heading_anchors_are_the_ids_the_renderer_writes() {
        let markdown = concat!(
            "# 11. Mermaid Diagrams\n\n",
            "Prose.\n\n",
            "## Objectives\n\n",
            "Prose.\n\n",
            "## Objectives\n\n",
            "Setext heading\n",
            "---\n\n",
            "## A **bold** word and `code`\n\n",
            "## 1. 概述\n\n",
            "```bash\n",
            "# not a heading, a shell comment\n",
            "```\n",
        );

        let anchors = heading_anchors(markdown);
        let texts: Vec<&str> = anchors.iter().map(|a| a.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![
                "11. Mermaid Diagrams",
                "Objectives",
                "Objectives",
                "Setext heading",
                "A bold word and code",
                "1. 概述",
            ],
            "a fenced `#` line is not a heading, and setext headings are",
        );

        let html = convert_markdown(markdown);
        for anchor in &anchors {
            assert!(
                html.contains(&format!("id=\"{}\"", anchor.slug)),
                "id {:?} for heading {:?} is not in the rendered document: {html}",
                anchor.slug,
                anchor.text,
            );
        }

        // The repeated heading is numbered, or completion would offer one link
        // for two sections and silently reach only the first.
        let objectives: Vec<&str> = anchors
            .iter()
            .filter(|a| a.text == "Objectives")
            .map(|a| a.slug.as_str())
            .collect();
        assert_eq!(objectives, vec!["objectives", "objectives-1"]);

        // And the line numbers are the buffer's, so the list can be ordered
        // and a completion can say where it points.
        assert_eq!(anchors[0].line, 1);
        assert_eq!(anchors[0].level, 1);
        assert_eq!(anchors[1].level, 2);
    }

    /// comrak never sees the buffer: four preprocessing steps run first, and
    /// two of them rewrite what a heading READS as. A completion list built
    /// from the raw text reports ids for headings that were never rendered.
    /// Measured, before this was fixed:
    ///
    ///     ## Wiki [[note#Setup]] here   rendered wiki-note--setup-here
    ///                                   raw      wiki-notesetup-here
    ///     ## See $[a](b)$ inline        rendered see-ab-inline
    ///                                   raw      see-a-inline
    ///
    /// Every case is checked against the id the renderer actually wrote, so
    /// this cannot drift with a change to the preprocessing chain.
    #[test]
    fn heading_anchors_match_the_renderer_through_every_preprocessing_step() {
        for markdown in [
            // Math: masked before the parse, restored after it.
            "## A heading with $x_1$\n",
            "## 关于 $x_1$ 的说明\n",
            "## Solve $x + 1 = 2$ now\n",
            "## $$E = mc^2$$\n",
            "## Escaped \\$5 and $y_2$\n",
            // Math whose source looks like markup. The renderer anchorizes the
            // source; parsing the buffer would see a link and take its text.
            "## See $[a](b)$ inline\n",
            "## Math $a*b*c$ here\n",
            // A wikilink is a LINK by the time comrak parses it, and its text
            // is the "Note > Heading" spelling `process_wikilinks` chose.
            "## Wiki [[note#Setup]] here\n",
            "## Wiki [[#Setup|jump]] here\n",
            // Ordinary inline markup, which comrak strips for the id.
            "## A [real link](https://x.dev) here\n",
            "## Code `let x = 1;` here\n",
            "## A **bold** and *italic* heading\n",
        ] {
            let html = convert_markdown(markdown);
            let rendered = html
                .split("id=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap_or_default()
                .to_owned();
            let ours = heading_anchors(markdown)
                .first()
                .map(|anchor| anchor.slug.clone())
                .unwrap_or_default();

            assert!(!rendered.is_empty(), "no id rendered for {markdown:?}");
            assert_eq!(
                ours, rendered,
                "completion would offer {ours:?} for {markdown:?}, but the \
                 renderer wrote {rendered:?}",
            );
        }
    }

    /// The spellings people actually write, and the ones they collide with.
    ///
    /// Every extension added here takes a character some other feature already
    /// uses, so the question is never "does it work" but "what did it take
    /// from". Each row was measured before being enabled; the `||` row is the
    /// one that failed, which is why spoilers are off.
    /// The three that were measured and left off, and the ordinary text each
    /// would have misread. A test rather than a comment, so that turning one
    /// on shows what it costs before the pull request is opened.
    #[test]
    fn the_syntaxes_that_would_misread_ordinary_text() {
        // `~x~` is GFM strikethrough — one or two tildes — so a subscript
        // extension takes a spelling GitHub already renders.
        assert!(convert_markdown("H~2~O\n").contains("<del"));
        assert!(convert_markdown("~struck~\n").contains("<del"));

        // Two carets in a paragraph pair up. This sentence renders as written
        // today, here and on GitHub, and a superscript extension would eat it.
        let prose = convert_markdown("a^2 + b^2 = c^2\n");
        assert!(prose.contains("a^2 + b^2 = c^2"), "got: {prose}");
        assert!(!prose.contains("<sup"), "got: {prose}");

        // `||` is an empty table cell — see the dedicated test for the row it
        // would break.
        assert!(!convert_markdown("||spoiler||\n").contains("class=\"spoiler\""));
    }

    #[test]
    fn syntax_coexistence() {
        let cases: &[(&str, &str, &str)] = &[
            // The characters this group did NOT take, still meaning what they
            // meant. See `markdown_options` for why.
            ("~~gone~~", "<del", "strikethrough, unchanged"),
            ("H~2~O", "<del", "a lone tilde is still GFM strikethrough"),
            ("text^[a note]", "footnote-ref", "the inline footnote still owns `^[`"),
            ("A paragraph. ^abc123", "block-id-anchor", "and a block id its own shape"),
            // Inserted text against the `+` that starts a list.
            ("++added++", "<ins", "inserted text"),
            ("+ item one\n+ item two", "<ul", "a `+` list is still a list"),
            // The false positives that would make prose unreadable.
            ("I know C++ and also C++ well", "C++ and also C++", "C++ in prose is not inserted text"),
            ("see ~/notes and ~/tmp", "~/notes and ~/tmp", "home paths are not subscripts"),
            ("`H~2~O ^2^ ++y++`", "<code", "and none of it applies inside code"),
        ];

        for (markdown, expected, why) in cases {
            let html = convert_markdown(&format!("{markdown}\n"));
            assert!(html.contains(expected), "{why}: {markdown:?} produced {html}");
        }
    }

    /// Why `options.extension.spoiler` is off.
    ///
    /// `||text||` is the spoiler spelling, and `| 1 || 3 |` is how an empty
    /// table cell is written. With spoilers on, the row collapses into one cell
    /// reading "1 || 3" — measured, which is why this is a test and not a
    /// comment. Tables are core; spoilers are a Discord convention.
    #[test]
    fn an_empty_table_cell_is_not_a_spoiler() {
        let html = convert_markdown("| a | b |\n|---|---|\n| 1 || 3 |\n");
        assert!(html.contains("<td data-sourcepos=\"3:2-3:4\">1</td>"), "{html}");
        assert!(!html.contains("1 || 3"), "the `||` was swallowed: {html}");
        assert!(!html.contains("class=\"spoiler\""), "{html}");
    }

    /// What moving these two to comrak bought, beyond two fewer preprocessors.
    ///
    /// Both regexes were single-line and stopped at the first delimiter they
    /// saw. The parser has the block structure, so it does not have to.
    #[test]
    fn the_parser_reaches_where_the_patterns_could_not() {
        // `==([^=\n]+)==` could not cross a line break, so a highlight that
        // wrapped came out as literal `==` on both sides.
        let wrapped = convert_markdown("==a highlight that\nwraps a line==\n");
        assert!(wrapped.contains("</mark>"), "got: {wrapped}");
        assert!(!wrapped.contains("=="), "got: {wrapped}");

        // `\^\[([^\]\n]+)\]` stopped at the first `]`, so a note containing
        // brackets lost its tail and left a stray `]` in the paragraph.
        let nested = convert_markdown("text^[a note with [brackets] inside]\n");
        assert!(nested.contains("a note with [brackets] inside"), "got: {nested}");
        assert!(!nested.contains("inside]</p>"), "the tail was dropped: {nested}");
    }

    #[test]
    fn wikilink_targets_survive_punctuation_in_the_heading() {
        // "1. 概述" used to become "1.-概述" while comrak rendered "1-概述",
        // so the link resolved to nothing.
        assert_eq!(heading_anchor_id("1. 概述"), "1-概述");

        let out = process_wikilinks("[[#1. 概述|Overview]]\n");
        assert!(out.contains("[Overview](#1-概述)"), "got: {out}");
    }

    #[test]
    fn multiline_wikilinks_are_left_literal() {
        // A heading id can never contain a newline, so such a target cannot
        // resolve; rewriting it would also collapse two source lines into one
        // and shift every task checkbox below it.
        let out = process_wikilinks("[[#first\nsecond|alias]]\n");
        assert!(out.contains("[[#first\nsecond|alias]]"), "got: {out}");
    }

    // ---- [[file#heading]] wikilinks -------------------------------------
    //
    // What these tests do NOT cover, and why:
    //  * Bare note links, "[[Notes]]" with no heading. Deliberately out of
    //    scope — see `wikilinks_without_a_heading_are_deliberately_left_literal`.
    //  * Whether the target file exists. Resolution is the frontend's job
    //    (`resolveMarkdownTargetPath` in src/lib/utils/markdownLinks.ts); the
    //    Rust side never touches the filesystem here, so a link to a missing
    //    note is emitted like any other and simply fails to open.
    //  * Obsidian's nested-heading paths (`[[file#H1#H2]]`). Everything after
    //    the first `#` is taken as one heading name, so such a target
    //    anchorizes to the two names run together and will not resolve. That
    //    matches the existing behaviour of the same-document form.
    //  * Duplicate headings. comrak appends `-1`, `-2`, … to the second and
    //    later headings with the same text; a wikilink can only ever address
    //    the first one (see the doc comment on `heading_anchor_id`).
    //  * The actual click-through. The href *shape* the frontend accepts is
    //    pinned from the TypeScript side in scripts/wikilinkFileTargets.test.ts.

    #[test]
    fn copy_reference_output_becomes_a_real_link() {
        // `[[Notes#Setup]]` is exactly what the app's own "Copy Reference"
        // menu item writes to the clipboard (MarkdownViewer.svelte); it used
        // to render as literal text because the pattern required `#` to
        // follow `[[` immediately.
        let out = process_wikilinks("[[Notes#Setup]]\n");
        assert!(out.contains("[Notes > Setup](Notes.md#setup)"), "got: {out}");
    }

    #[test]
    fn file_wikilink_href_carries_a_markdown_extension_the_frontend_recognizes() {
        // getMarkdownLinkTarget() only claims a link whose path has a known
        // markdown extension, so a note name written without one — the way
        // Copy Reference writes it — has to gain one here or the click falls
        // through to the external-URL opener.
        let out = process_wikilinks("[[docs/Guide#Setup]]\n");
        assert!(out.contains("(docs/Guide.md#setup)"), "got: {out}");
    }

    #[test]
    fn file_wikilink_keeps_an_extension_it_was_already_given() {
        let out = process_wikilinks("[[Notes.md#Setup]]\n");
        assert!(out.contains("(Notes.md#setup)"), "got: {out}");
        assert!(!out.contains("Notes.md.md"), "got: {out}");

        let txt = process_wikilinks("[[log.txt#Errors]]\n");
        assert!(txt.contains("(log.txt#errors)"), "got: {txt}");
        assert!(!txt.contains("log.txt.md"), "got: {txt}");
    }

    #[test]
    fn wikilinks_without_a_heading_are_deliberately_left_literal() {
        // Obsidian's bare note link "[[Notes]]" is out of scope: this change
        // fixes Copy Reference, whose every call site emits a "#". Claiming
        // every "[[…]]" would also swallow bracketed citation numbering and
        // pre-empt CommonMark reference links, neither of which is a wikilink.
        // See the PR description.
        for input in [
            "[[Notes]]\n",
            "[[1]] Author, Title.\n",
            "[[TODO]] revisit this.\n",
            "[[foo]] and [[foo|bar]]\n",
            "[[docs/Guide|Guide]]\n",
        ] {
            assert_eq!(process_wikilinks(input), input, "should be literal");
        }

        // A "#" in the alias half does not make it a heading link either.
        let aliased = "[[Notes|see #1]]\n";
        assert_eq!(process_wikilinks(aliased), aliased);

        // A reference definition must keep resolving the CommonMark way.
        let html = convert_markdown("[[foo]] here.\n\n[foo]: https://example.com\n");
        assert!(html.contains("href=\"https://example.com\""), "got: {html}");
        assert!(!html.contains("foo.md"), "got: {html}");
    }

    #[test]
    fn file_wikilink_alias_and_subfolder_and_punctuated_heading() {
        let out = process_wikilinks("[[docs/Guide#1. 概述|Overview]]\n");
        assert!(out.contains("[Overview](docs/Guide.md#1-概述)"), "got: {out}");
    }

    #[test]
    fn file_wikilink_percent_encodes_what_would_break_the_destination() {
        // A space would end the destination and the rest would be read as a
        // title; parentheses would close it early. decodeLinkPath() on the
        // frontend undoes all of this.
        let out = process_wikilinks("[[My Notes (v2)#Setup]]\n");
        assert!(out.contains("(My%20Notes%20%28v2%29.md#setup)"), "got: {out}");
        assert!(out.contains("[My Notes (v2) > Setup]"), "got: {out}");
    }

    #[test]
    fn file_wikilink_block_reference_targets_the_block_id_anchor() {
        // `^abc123` at the end of a line becomes <a id="abc123">, and comrak's
        // anchorizer drops the caret, so both sides agree on "abc123".
        let out = process_wikilinks("[[Notes#^abc123]]\n");
        assert!(out.contains("(Notes.md#abc123)"), "got: {out}");
    }

    #[test]
    fn wikilinks_to_files_the_viewer_cannot_open_stay_literal() {
        // A non-markdown target would not be claimed by getMarkdownLinkTarget,
        // so the click would reach openUrl() with a relative path resolved
        // against the webview origin. Leaving it as text is the honest result.
        for input in ["[[report.pdf#Intro]]\n", "[[diagram.svg#part]]\n"] {
            let out = process_wikilinks(input);
            assert_eq!(out, input, "got: {out}");
        }
    }

    #[test]
    fn same_document_wikilinks_are_unchanged_by_the_file_form() {
        let out = process_wikilinks("[[#Some Heading|jump]]\n");
        assert!(out.contains("[jump](#some-heading)"), "got: {out}");

        let bare = process_wikilinks("[[#Setup]]\n");
        assert!(bare.contains("[Setup](#setup)"), "got: {bare}");
    }

    #[test]
    fn file_wikilinks_in_code_spans_and_fences_stay_literal() {
        let span = process_wikilinks("`[[Notes#Setup]]` but [[Notes#Setup]]\n");
        assert!(span.contains("`[[Notes#Setup]]`"), "got: {span}");
        assert!(span.contains("(Notes.md#setup)"), "got: {span}");

        let fence = process_wikilinks("```\n[[Notes#Setup]]\n```\n");
        assert!(fence.contains("```\n[[Notes#Setup]]\n```"), "got: {fence}");
    }

    #[test]
    fn embeds_are_not_also_treated_as_file_wikilinks() {
        // process_internal_embeds runs first and consumes `![[…]]`; the guard
        // matters for the standalone call and for an embed it declined.
        let out = process_wikilinks("![[photo.png]]\n");
        assert!(out.contains("![[photo.png]]"), "got: {out}");

        let html = convert_markdown("![[photo.png]]\n");
        assert!(html.contains("<img src=\"photo.png\""), "got: {html}");
    }

    #[test]
    fn bracketed_link_text_is_still_a_commonmark_link() {
        // "[[1]](https://example.com)" is a CommonMark link whose text is
        // "[1]" — a common citation spelling in READMEs. Requiring a "#"
        // already protects that spelling, so the first case here would pass
        // without the trailing-"(" guard; the second would not, which is why
        // the guard stays.
        for input in [
            "See [[1]](https://example.com) for details.\n",
            "See [[1#x]](https://example.com) for details.\n",
            "[[Notes#Setup]](https://example.com)\n",
        ] {
            assert_eq!(process_wikilinks(input), input, "should be literal");
            let html = convert_markdown(input);
            assert!(html.contains("href=\"https://example.com\""), "got: {html}");
        }
    }

    #[test]
    fn file_wikilink_survives_the_full_render_pipeline() {
        let html = convert_markdown("[[Notes#Setup]]\n");
        assert!(html.contains("href=\"Notes.md#setup\""), "got: {html}");
    }

    #[test]
    fn attribute_escaping_covers_the_html_metacharacters() {
        assert_eq!(
            escape_html_attribute("a\"b'c&d<e>f"),
            "a&quot;b&#39;c&amp;d&lt;e&gt;f",
        );
        assert_eq!(escape_html_attribute("plain.png"), "plain.png");
    }

    /// Creates `<root>/src<i>/<name>` holding `body` and returns its path.
    fn drop_source(root: &Path, index: usize, name: &str, body: &[u8]) -> PathBuf {
        let dir = root.join(format!("src{index}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        fs::write(&file, body).unwrap();
        file
    }

    fn drop_into_img(src: &Path, doc_dir: &Path) -> String {
        copy_file_to_img_blocking(src.to_str().unwrap(), doc_dir.to_str().unwrap(), "img").unwrap()
    }

    #[test]
    fn repeated_drops_of_the_same_name_never_overwrite_an_earlier_copy() {
        // Three same-named images from different folders, dropped in the same
        // second. The conflict name used to be a *second-resolution* timestamp
        // that was never re-checked for existence, so drops #2 and #3 computed
        // the identical name and #3 silently replaced the bytes behind a link
        // the document had already been given.
        let root = temp_path("imgcopy-repeat");
        let doc_dir = root.join("doc");
        fs::create_dir_all(&doc_dir).unwrap();
        let bodies: [&[u8]; 3] = [b"first", b"second", b"third"];
        let sources: Vec<PathBuf> = bodies
            .iter()
            .enumerate()
            .map(|(i, body)| drop_source(&root, i, "a.png", body))
            .collect();

        let written: Vec<String> = sources.iter().map(|src| drop_into_img(src, &doc_dir)).collect();

        let distinct: std::collections::HashSet<&String> = written.iter().collect();
        assert_eq!(distinct.len(), written.len(), "two drops shared a name: {written:?}");
        for (rel, body) in written.iter().zip(bodies.iter()) {
            assert_eq!(
                fs::read(doc_dir.join(rel)).unwrap(),
                *body,
                "{rel} no longer holds the image that was dropped for it",
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_conflicting_dotfile_name_does_not_grow_a_trailing_dot() {
        // ".png" is a dotfile, not an extension: the frontend's drop filter
        // reads the name with `split('.').pop()` and sees "png", so it lets it
        // through, while Rust's `Path::extension()` returns None. The old
        // format string appended the separator unconditionally, so the conflict
        // name ended in a dot. Windows strips a trailing dot when creating the
        // file, so the link written into the document named a file that does
        // not exist on disk; mac/Linux keep the dot and the link resolves.
        let root = temp_path("imgcopy-dotfile");
        let doc_dir = root.join("doc");
        fs::create_dir_all(&doc_dir).unwrap();
        let first = drop_source(&root, 0, ".png", b"first");
        let second = drop_source(&root, 1, ".png", b"second");

        drop_into_img(&first, &doc_dir);
        let rel = drop_into_img(&second, &doc_dir);

        assert!(!rel.ends_with('.'), "conflict name ends in a dot: {rel}");
        assert_eq!(fs::read(doc_dir.join(&rel)).unwrap(), b"second");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_drops_of_the_same_name_each_get_their_own_file() {
        // Two windows dropping the same image at the same moment: an
        // `exists()` test followed by a separate copy leaves a window in which
        // both callers see the name as free and one copy lands on top of the
        // other.
        const DROPS: usize = 8;
        let root = temp_path("imgcopy-concurrent");
        let doc_dir = root.join("doc");
        fs::create_dir_all(&doc_dir).unwrap();
        let sources: Vec<(PathBuf, Vec<u8>)> = (0..DROPS)
            .map(|i| {
                let body = format!("image-{i}").into_bytes();
                (drop_source(&root, i, "a.png", &body), body)
            })
            .collect();

        let written: Vec<(String, Vec<u8>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = sources
                .iter()
                .map(|(src, body)| {
                    let doc_dir = doc_dir.clone();
                    scope.spawn(move || (drop_into_img(src, &doc_dir), body.clone()))
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let distinct: std::collections::HashSet<&String> = written.iter().map(|(rel, _)| rel).collect();
        assert_eq!(distinct.len(), DROPS, "concurrent drops shared a name: {written:?}");
        for (rel, body) in &written {
            assert_eq!(
                &fs::read(doc_dir.join(rel)).unwrap(),
                body,
                "{rel} no longer holds the image that was dropped for it",
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    // ---------------------------------------------------------------------
    // The line-number contract of `convert_markdown`
    //
    // `convert_markdown` preprocesses the raw buffer, renders the *result*
    // with `sourcepos = true`, and hands those line numbers to the frontend.
    // The frontend then writes task-checkbox toggles back into the *raw*
    // buffer at that line number. So every preprocessing step has to map
    // input line N to output line N; a step that quietly eats or inserts a
    // line makes the reading-mode checkbox rewrite a different line of the
    // user's document (issue #352).
    //
    // A step MAY append after the last input line — the inline-footnote step
    // parks its `[^ifn-N]: …` definitions there, which cannot shift the
    // number of any line that already existed. It must never insert or drop
    // a line inside the document.
    //
    // ⚠️ EVERY preprocessing step of `convert_markdown` MUST be registered in
    // `line_preserving_transforms()` below. It is not optional and it is not
    // best-effort: `every_convert_markdown_preprocessing_step_is_registered`
    // re-reads this source file, extracts the calls `convert_markdown`
    // actually makes, and fails if one of them is missing from the list.
    // Adding a fifth transform without registering it turns that test red.
    // ---------------------------------------------------------------------

    type LineTransform = fn(&str) -> String;

    /// The registry the contract test walks. Add every new preprocessing step.
    fn line_preserving_transforms() -> Vec<(&'static str, LineTransform)> {
        vec![
            (
                "process_parenthesized_autolinks",
                (|s| process_parenthesized_autolinks(s).into_owned()) as LineTransform,
            ),
            (
                "process_internal_embeds",
                (|s| process_internal_embeds(s).into_owned()) as LineTransform,
            ),
            (
                "process_wikilinks",
                (|s| process_wikilinks(s).into_owned()) as LineTransform,
            ),
            (
                "mask_math_spans",
                (|s| mask_math_spans(s).text) as LineTransform,
            ),
        ]
    }

    /// Documents exercising every syntax the preprocessing steps claim, plus
    /// the malformed spellings of each one — a lone `![[`, an unterminated
    /// `^[`, a wikilink split over two lines — because those are exactly the
    /// inputs where a lazy or newline-crossing pattern runs away.
    const LINE_CONTRACT_CORPUS: &[&str] = &[
        // A stray embed opener with a real embed further down.
        "Prose with ![[ a stray opener.\n\n- [ ] task one\n\nLater an image ![[real.png]] here.\n",
        // An inline footnote whose text wraps onto a second line.
        "Some claim^[See the long explanation\nthat wraps to a second line] and more.\n\n- [ ] task\n",
        // A block id sitting on its own line, Obsidian's block-reference form.
        "A quotable paragraph.\n^blockid\n\n- [ ] task\n",
        // A block id at the end of its own line.
        "A quotable paragraph. ^blockid\n\n- [ ] task\n",
        // Every well-formed spelling at once.
        "![[pic.png|300x200]] [[#Setup|jump]] [[Notes#Setup]] ==mark== text^[note]\n\n- [ ] task\n",
        // A wikilink split over two lines (already guarded, kept as a pin).
        "[[#first\nsecond|alias]]\n- [ ] task\n",
        // Code fences and spans, which every step must leave alone.
        "```\n![[inside.md]]\n^[inside]\n==inside==\n```\n\n`==x==` ![[out.png]]\n",
        // Unclosed fence, longer fences, tilde fences.
        "~~~\n![[a.md]]\n\n````\n```\n![[b.md]]\n````\n\n```\n![[never-closed.md]]\n",
        // Parenthesized autolink with nested parentheses.
        "See (https://example.com/a(b)c)text here\n\n- [ ] task\n",
        // Display math with underscores.
        "$$\na_b\nc_d\n$$\n\nx^[note] and $$y_1$$\n\n- [ ] task\n",
        // Headings, quotes, tables, nested and quoted tasks.
        "# Head\n\n> quote ^qid\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] task\n  - [x] nested\n\n> - [ ] quoted\n",
        // Unbalanced brackets and carets in prose.
        "A ^[ dangling footnote opener and a [[ dangling wikilink\n\n- [ ] task\n",
        // Multibyte content — offsets are bytes, line numbers are not.
        "中文段落 ![[图片.png]] ^[脚注]\n\n- [ ] 任务\n",
        // Blank lines, CRLF, and no trailing newline.
        "one\r\ntwo ![[x.png]]\r\n\r\n- [ ] task",
    ];

    const LINE_CONTRACT_SENTINEL: &str = "MPLINECONTRACTSENTINEL";

    fn sentinel_line(text: &str) -> Option<usize> {
        text.lines()
            .position(|line| line.contains(LINE_CONTRACT_SENTINEL))
    }

    /// Asserts that `transform` keeps a marker line at the same line number.
    ///
    /// The marker is appended to every line-prefix of `input`, not just to
    /// the whole document: a step that drops one line and inserts another
    /// would leave the total unchanged, but no prefix boundary between the
    /// two survives. Checking the sentinel rather than the raw line count is
    /// what lets the inline-footnote step append its definitions afterwards.
    fn assert_transform_preserves_line_numbers(
        name: &str,
        transform: LineTransform,
        input: &str,
    ) {
        let lines: Vec<&str> = input.split_inclusive('\n').collect();
        for take in 0..=lines.len() {
            let mut probe = lines[..take].concat();
            if !probe.is_empty() && !probe.ends_with('\n') {
                probe.push('\n');
            }
            probe.push_str(LINE_CONTRACT_SENTINEL);
            probe.push('\n');

            let expected = sentinel_line(&probe).expect("the probe carries the sentinel");
            let output = transform(&probe);
            let actual = sentinel_line(&output).unwrap_or_else(|| {
                panic!(
                    "{name} swallowed the sentinel line entirely\n  input:  {probe:?}\n  output: {output:?}"
                )
            });
            assert_eq!(
                expected, actual,
                "{name} moved line {expected} to line {actual}\n  input:  {probe:?}\n  output: {output:?}",
            );
        }
    }

    #[test]
    fn every_preprocessing_step_preserves_source_line_numbers() {
        for (name, transform) in line_preserving_transforms() {
            for input in LINE_CONTRACT_CORPUS {
                assert_transform_preserves_line_numbers(name, transform, input);
            }
        }
    }

    #[test]
    fn the_whole_preprocessing_pipeline_preserves_source_line_numbers() {
        // Individually line-preserving steps could still compose badly: one
        // step's output is the next one's input, so a rewrite that creates a
        // new `^[` or `![[` opener would only show up here.
        let pipeline: LineTransform = |content| {
            let autolinks = process_parenthesized_autolinks(content);
            let embeds = process_internal_embeds(&autolinks);
            let links = process_wikilinks(&embeds);
            mask_math_spans(&links).text
        };
        for input in LINE_CONTRACT_CORPUS {
            assert_transform_preserves_line_numbers("the preprocessing pipeline", pipeline, input);
        }
    }

    /// The body of `convert_markdown`, read back out of this source file.
    ///
    /// The needle is assembled at runtime so that it does not match this
    /// file's own source text. Line endings are normalised first: git checks
    /// this file out with CRLF wherever `core.autocrlf` is on — the default
    /// on Windows, and what the Windows CI runner does — and the `\n`-anchored
    /// needles are about the shape of the source, not about how the working
    /// tree happens to store it.
    fn convert_markdown_body() -> String {
        let source = include_str!("lib.rs").replace("\r\n", "\n");
        let needle = format!("\nfn {}(content: &str) -> String {{", "convert_markdown");
        let start = source
            .find(&needle)
            .expect("convert_markdown must keep its `&str -> String` signature");
        let rest = &source[start + needle.len()..];
        rest[..rest
            .find("\n}\n")
            .expect("convert_markdown must be terminated")]
            .to_string()
    }

    #[test]
    fn convert_markdown_hands_the_fail_safe_the_raw_buffer() {
        // `annotate_task_checkboxes` is a fail-safe only while what reaches it
        // is the buffer the command was called with. The hazard is not the
        // call — it is the *name*: adding a step the obvious way,
        //
        //     let content = process_new_thing(content);
        //
        // near the top rebinds the parameter, and the unchanged call at the
        // bottom starts handing over preprocessed text. Nothing about that
        // edit looks wrong and no behavioural test can see it, because the two
        // sides it is supposed to cross-check now agree by definition.
        //
        // "This string is the one the caller passed in" is provenance, not a
        // type, so the compiler cannot be made to check it. What can be made
        // structural is the shadowing: `convert_markdown` copies its input to
        // `raw_buffer` before anything else runs, which turns the shadowing
        // edit above into a harmless one. This test pins the three properties
        // that copy depends on.
        let body = convert_markdown_body();

        let capture = "let raw_buffer = content;";
        let first_let = body
            .find("\n    let ")
            .map(|i| i + "\n    ".len())
            .expect("convert_markdown must bind something");
        assert!(
            body[first_let..].starts_with(capture),
            "the raw buffer must be captured before the first preprocessing \
             step, or the step can shadow `content` above it:\n{body}",
        );
        assert_eq!(
            body.matches(capture).count(),
            1,
            "`raw_buffer` is bound more than once — a second binding is the \
             same hole under a new name:\n{body}",
        );
        assert!(
            Regex::new(r"annotate_task_checkboxes\([^;]*,\s*raw_buffer\s*\)")
                .unwrap()
                .is_match(&body),
            "the fail-safe is no longer handed `raw_buffer`; whatever it now \
             receives can agree with the HTML by construction:\n{body}",
        );
    }

    #[test]
    fn every_convert_markdown_preprocessing_step_is_registered() {
        // Re-reads this file so that a fifth preprocessing step cannot be
        // added to `convert_markdown` without also being put under the line
        // contract. The needle is assembled at runtime so that it does not
        // match this test's own source text.
        //
        // Line endings are normalised first. Git checks this file out with
        // CRLF wherever `core.autocrlf` is on — the default on Windows, and
        // what the Windows CI runner does — and the `\n`-anchored needles
        // below are about the shape of the source, not about how the working
        // tree happens to store it.
        let source = include_str!("lib.rs").replace("\r\n", "\n");
        let needle = format!("\nfn {}(content: &str) -> String {{", "convert_markdown");
        let start = source
            .find(&needle)
            .expect("convert_markdown must keep its `&str -> String` signature");
        let rest = &source[start + needle.len()..];
        let body = &rest[..rest.find("\n}\n").expect("convert_markdown must be terminated")];

        // Bare `name(` calls: `.method(` and `Type::assoc(` are excluded by
        // the leading character class.
        let call = Regex::new(r"(?:^|[^A-Za-z0-9_:.])([a-z_][a-z0-9_]*)\s*\(").unwrap();
        // Calls in `convert_markdown` that are not preprocessing steps.
        // `annotate_task_checkboxes` runs on the rendered HTML, after
        // sourcepos numbers exist; it is the fail-safe for this contract
        // rather than a participant in it. `restore_math_spans` also runs on
        // the rendered HTML — it is the second half of `mask_math_spans`,
        // which *is* registered, and it never sees the source buffer.
        // `markdown_options` returns the parser configuration and never
        // touches the text at all; it is shared with `heading_anchors`, which
        // has to parse the document the way the renderer does.
        let not_a_transform = [
            "markdown_to_html",
            "annotate_task_checkboxes",
            "restore_math_spans",
            "markdown_options",
        ];

        let mut found: Vec<String> = call
            .captures_iter(body)
            .map(|caps| caps[1].to_string())
            .filter(|name| !not_a_transform.contains(&name.as_str()))
            .collect();
        found.sort();
        found.dedup();

        let mut registered: Vec<String> = line_preserving_transforms()
            .into_iter()
            .map(|(name, _)| name.to_string())
            .collect();
        registered.sort();

        assert_eq!(
            found, registered,
            "convert_markdown's preprocessing steps and the line-contract \
             registry have drifted apart — register every new step in \
             line_preserving_transforms() (or, if the call is not a \
             preprocessing step, add it to not_a_transform and say why)",
        );
    }

    #[test]
    fn a_stray_embed_opener_leaves_the_document_and_its_tasks_intact() {
        let markdown =
            "Prose with ![[ a stray opener.\n\n- [ ] task one\n\nLater an image ![[real.png]] here.\n";
        let html = convert_markdown(markdown);
        assert!(
            html.contains("task one"),
            "the stray opener swallowed the prose: {html}",
        );
        assert!(
            html.contains("data-task-checkbox"),
            "the stray opener shifted the task source position: {html}",
        );
        // A real embed further down still renders.
        assert!(html.contains("<img src=\"real.png\""), "got: {html}");
    }

    #[test]
    fn a_multiline_inline_footnote_does_not_shift_task_source_positions() {
        let html = convert_markdown(
            "Some claim^[See the long explanation\nthat wraps to a second line] and more.\n\n- [ ] task\n",
        );
        assert!(
            html.contains("data-task-checkbox"),
            "the multiline inline footnote shifted the task source position: {html}",
        );
    }

    #[test]
    fn a_block_id_on_its_own_line_does_not_shift_task_source_positions() {
        let markdown = "A quotable paragraph.\n^blockid\n\n- [ ] task\n";
        let html = convert_markdown(markdown);
        assert!(
            html.contains("id=\"blockid\""),
            "the block id anchor disappeared: {html}",
        );
        assert!(
            html.contains("data-task-checkbox"),
            "the block id shifted the task source position: {html}",
        );
    }

    #[test]
    fn task_checkboxes_stay_inert_when_the_html_and_the_buffer_disagree() {
        // The fail-safe in `annotate_task_checkboxes`. Feed it HTML whose
        // sourcepos numbers came from one document and the raw buffer of a
        // different one — the shape a broken line contract produces. Line 3
        // of the buffer is a fence, so annotating would let a click write a
        // "- [x]" marker into a code block (issue #352).
        let rendered =
            convert_markdown("intro paragraph\n\n- [ ] task\n").replace(" data-task-checkbox=\"\"", "");
        assert!(
            rendered.contains("data-sourcepos=\"3:1-3:10\"><input type=\"checkbox\""),
            "expected an unannotated task input on line 3: {rendered}",
        );

        let mismatched = annotate_task_checkboxes(
            rendered.clone(),
            "- [ ] real task\n\n```\nnot a task\n```\n",
        );
        assert!(
            !mismatched.contains("data-task-checkbox"),
            "the fail-safe let a checkbox through onto a line that is not a task: {mismatched}",
        );

        // Control: the same HTML against the buffer it was rendered from.
        let matching = annotate_task_checkboxes(rendered, "intro paragraph\n\n- [ ] task\n");
        assert!(
            matching.contains("data-task-checkbox"),
            "the fail-safe rejected a genuine task line: {matching}",
        );
    }
}
