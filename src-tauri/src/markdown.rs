//! Markdown rendering: the comrak configuration, the preprocessing steps that
//! run before it, the math masking that hides TeX from CommonMark, and the
//! heading anchors the editor completes from.
//!
//! Split out of `lib.rs`; the code and its tests are unchanged.

use crate::fs_safety::{decode_text, read_to_string_lossy, utf8_truncation_boundary};
use comrak::nodes::NodeValue;
use comrak::{markdown_to_html, parse_document, Anchorizer, Arena, Options};
use regex::{Captures, Regex};
use std::borrow::Cow;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

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
static INTERNAL_EMBED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[(.*?)\]\]").expect("valid regex literal"));
/// `[[target]]` / `[[target|alias]]` where the target names a heading — either
/// in this document (`#Setup`) or in another file (`Notes#Setup`). The `#` is
/// required: a wikilink without one is a bare note link, which Markpad has
/// never resolved and which this pattern deliberately does not claim (see the
/// `wikilinks_without_a_heading_are_deliberately_left_literal` test). The `#`
/// here is only a cheap prefilter — it can also fall in the alias half, so
/// `process_wikilinks` re-checks that the target half really has one.
/// The inner text stops at the first `]`, as the narrower `[[#…]]` pattern
/// this replaced also did.
static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]]*#[^\]]*)\]\]").expect("valid regex literal"));
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
        let is_fence_line =
            indent <= 3 && matches!(marker, Some(b'`') | Some(b'~')) && run_len >= 3;

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
fn pair_inline_code_runs(
    content: &str,
    start: usize,
    end: usize,
    regions: &mut Vec<(usize, usize)>,
) {
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
        output.push(')');
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
                if !math
                    .iter()
                    .any(|&(start, end)| start < run_end + 1 && end > index)
                {
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
///
/// Not a Tauri command, despite having carried `#[tauri::command]` until the
/// attribute was removed. It was never in `generate_handler!`, so no frontend
/// could ever invoke it — the registered entry point is `render_markdown`, and
/// this is what that and `build_markdown_preview` call underneath. A command
/// name is a string with no compiler behind it, so an attribute that claims an
/// exposure the app does not have is a claim nothing was ever going to check.
pub(crate) fn convert_markdown(content: &str) -> String {
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
                &captures["sourcepos"], input,
            )
        })
        .into_owned()
}

pub(crate) struct MarkdownPreview {
    pub(crate) html: String,
    pub(crate) content: String,
    pub(crate) is_full: bool,
    pub(crate) lossy: bool,
    pub(crate) encoding: String,
}

/// The body of `open_markdown_preview`, kept synchronous and path-taking so
/// the decode-fidelity behaviour can be exercised against real files.
pub(crate) fn build_markdown_preview(
    path: &Path,
    max_bytes: usize,
) -> Result<MarkdownPreview, String> {
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

/// A heading, and the id a link has to name to reach it.
#[derive(serde::Serialize)]
pub(crate) struct HeadingAnchor {
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
pub(crate) fn heading_anchors(markdown: &str) -> Vec<HeadingAnchor> {
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fs_safety::encode_text;
    use crate::fs_safety::tests::{legacy_bytes, temp_path, CHINESE_SAMPLE};

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
        assert!(
            !html.contains("not a footnote</p>"),
            "it became a footnote: {html}"
        );
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
        assert!(
            !single.contains("onload=\""),
            "attribute injection: {single}"
        );
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
            (
                "text^[a note]",
                "footnote-ref",
                "the inline footnote still owns `^[`",
            ),
            (
                "A paragraph. ^abc123",
                "block-id-anchor",
                "and a block id its own shape",
            ),
            // Inserted text against the `+` that starts a list.
            ("++added++", "<ins", "inserted text"),
            (
                "+ item one\n+ item two",
                "<ul",
                "a `+` list is still a list",
            ),
            // The false positives that would make prose unreadable.
            (
                "I know C++ and also C++ well",
                "C++ and also C++",
                "C++ in prose is not inserted text",
            ),
            (
                "see ~/notes and ~/tmp",
                "~/notes and ~/tmp",
                "home paths are not subscripts",
            ),
            (
                "`H~2~O ^2^ ++y++`",
                "<code",
                "and none of it applies inside code",
            ),
        ];

        for (markdown, expected, why) in cases {
            let html = convert_markdown(&format!("{markdown}\n"));
            assert!(
                html.contains(expected),
                "{why}: {markdown:?} produced {html}"
            );
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
        assert!(
            html.contains("<td data-sourcepos=\"3:2-3:4\">1</td>"),
            "{html}"
        );
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
        assert!(
            nested.contains("a note with [brackets] inside"),
            "got: {nested}"
        );
        assert!(
            !nested.contains("inside]</p>"),
            "the tail was dropped: {nested}"
        );
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
        assert!(
            out.contains("[Notes > Setup](Notes.md#setup)"),
            "got: {out}"
        );
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
        assert!(
            out.contains("[Overview](docs/Guide.md#1-概述)"),
            "got: {out}"
        );
    }

    #[test]
    fn file_wikilink_percent_encodes_what_would_break_the_destination() {
        // A space would end the destination and the rest would be read as a
        // title; parentheses would close it early. decodeLinkPath() on the
        // frontend undoes all of this.
        let out = process_wikilinks("[[My Notes (v2)#Setup]]\n");
        assert!(
            out.contains("(My%20Notes%20%28v2%29.md#setup)"),
            "got: {out}"
        );
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
    fn assert_transform_preserves_line_numbers(name: &str, transform: LineTransform, input: &str) {
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
        let source = include_str!("markdown.rs").replace("\r\n", "\n");
        let needle = format!(
            "\npub(crate) fn {}(content: &str) -> String {{",
            "convert_markdown"
        );
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
        let source = include_str!("markdown.rs").replace("\r\n", "\n");
        let needle = format!(
            "\npub(crate) fn {}(content: &str) -> String {{",
            "convert_markdown"
        );
        let start = source
            .find(&needle)
            .expect("convert_markdown must keep its `&str -> String` signature");
        let rest = &source[start + needle.len()..];
        let body = &rest[..rest
            .find("\n}\n")
            .expect("convert_markdown must be terminated")];

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
        let rendered = convert_markdown("intro paragraph\n\n- [ ] task\n")
            .replace(" data-task-checkbox=\"\"", "");
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
