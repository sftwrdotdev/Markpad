//! What the editor should colour, decided by the renderer rather than guessed.
//!
//! Monaco colours Markdown with a Monarch grammar: line-oriented regexes with a
//! dozen token names between them. It cannot tell a heading's `#` from the words
//! after it, calls a task checkbox a link, and has never heard of `==highlight==`,
//! `++insert++`, `$math$`, wikilinks or footnotes — all of which this app renders.
//! Worse, it guesses: `snake_case_word` matches its emphasis rule, and comrak
//! renders no emphasis there at all.
//!
//! So the editor asks the renderer. Every span here comes from the same comrak
//! parse the preview is built from, which makes the rule behind the colours
//! exact: **if it is coloured, it renders.**
//!
//! Two things are deliberate and easy to get wrong later.
//!
//! **The raw buffer, not the preprocessed one.** `convert_markdown` rewrites
//! wikilinks, internal embeds and parenthesized autolinks before comrak sees the
//! text, and those rewrites change the *length* of a line (`[[a]]` becomes
//! `[a](a.md)`). Line numbers survive — that contract is what `data-sourcepos`
//! and the task-checkbox toggle rest on — but columns do not, and columns are
//! the whole point here. Parsing the raw buffer keeps every column exact; the
//! cost is that comrak does not see the app's own syntaxes, which is why
//! `app_syntax_spans` scans for them separately.
//!
//! **Columns are converted to UTF-16.** comrak reports 1-based *byte* offsets
//! within a line; Monaco counts UTF-16 code units. For `# 标题` those disagree
//! from the first character on, and a span computed in bytes lands in the middle
//! of a character — where Monaco silently drops it.

use comrak::nodes::{AstNode, ListType, NodeValue};

use crate::markdown::markdown_options;

/// One coloured range, in the coordinates Monaco's semantic tokens speak:
/// zero-based line, zero-based UTF-16 column, length in UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SemanticSpan {
    /// A legend entry in `utils/semanticTokens.ts`. `kind.marker` there is a
    /// token type plus its `marker` modifier, which is how Monaco's theme
    /// lookup spells it (`tokenTheme._match("heading.marker")`).
    pub kind: &'static str,
    pub line: u32,
    pub start: u32,
    pub len: u32,
}

/// A half-open byte range inside one line, before the UTF-16 conversion.
#[derive(Debug, Clone, Copy)]
struct ByteSpan {
    line: usize,
    start: usize,
    end: usize,
}

/// The spans for `content`, sorted by position and non-overlapping.
///
/// Non-overlapping is a requirement, not a nicety: Monaco's semantic tokens are
/// delta-encoded from one token to the next, and two tokens covering the same
/// character produce a negative delta that the decoder reads as a new line.
pub fn semantic_spans(content: &str) -> Vec<SemanticSpan> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut raw: Vec<(ByteSpan, &'static str)> = Vec::new();

    let arena = comrak::Arena::new();
    let options = markdown_options();
    let root = comrak::parse_document(&arena, content, &options);
    for node in root.descendants() {
        collect_node(node, &lines, &mut raw);
    }
    app_syntax_spans(&lines, &mut raw);

    // Sort, then keep the first claim on any character. The order matters: an
    // inline construct nested in another (`**bold `code`**`) has both claiming
    // the same run, and the narrower one is pushed later by `descendants()`.
    raw.sort_by_key(|(span, _)| (span.line, span.start, std::cmp::Reverse(span.end)));

    let mut spans: Vec<SemanticSpan> = Vec::new();
    let mut claimed: Option<(usize, usize)> = None; // (line, end byte)
    for (span, kind) in raw {
        let start = match claimed {
            Some((line, end)) if line == span.line && end > span.start => end,
            _ => span.start,
        };
        if start >= span.end {
            continue;
        }
        claimed = Some((span.line, span.end));
        let line = lines.get(span.line).copied().unwrap_or("");
        let (Some(start_utf16), Some(end_utf16)) =
            (utf16_column(line, start), utf16_column(line, span.end))
        else {
            continue;
        };
        if end_utf16 <= start_utf16 {
            continue;
        }
        spans.push(SemanticSpan {
            kind,
            line: span.line as u32,
            start: start_utf16 as u32,
            len: (end_utf16 - start_utf16) as u32,
        });
    }
    spans
}

/// The UTF-16 offset of a byte offset, or `None` if it is not a char boundary.
fn utf16_column(line: &str, byte: usize) -> Option<usize> {
    if byte > line.len() {
        return Some(line.encode_utf16().count());
    }
    if !line.is_char_boundary(byte) {
        return None;
    }
    Some(line[..byte].encode_utf16().count())
}

/// The node's own range, as `(line, start_byte, end_byte)` per line touched.
fn node_lines(node: &AstNode, lines: &[&str]) -> Vec<ByteSpan> {
    let sp = node.data.borrow().sourcepos;
    let mut out = Vec::new();
    for line_no in sp.start.line..=sp.end.line {
        let Some(text) = lines.get(line_no.saturating_sub(1)) else {
            continue;
        };
        let start = if line_no == sp.start.line {
            sp.start.column.saturating_sub(1)
        } else {
            0
        };
        let end = if line_no == sp.end.line {
            sp.end.column.min(text.len())
        } else {
            text.len()
        };
        if end > start {
            out.push(ByteSpan {
                line: line_no - 1,
                start,
                end,
            });
        }
    }
    out
}

fn collect_node<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let value = node.data.borrow().value.clone();
    match value {
        NodeValue::Heading(_) => {
            // The `#` run and the space after it, then the words. Splitting them
            // is the thing Monarch cannot do — it emits one `keyword` for the
            // whole line, markup and prose alike.
            emit_gaps(node, lines, "heading.marker", out);
            emit_text_children(node, lines, "heading", out);
        }
        NodeValue::Item(item) => {
            emit_item_marker(node, lines, item.list_type, out);
        }
        NodeValue::TaskItem(_) => {
            // A task item *replaces* the Item node rather than nesting inside
            // it, so the bullet has to be emitted here too — the `Item` arm
            // above never sees a checklist.
            emit_item_marker(node, lines, ListType::Bullet, out);
            // Monarch reads the brackets as a link, which is why a checklist is
            // currently purple.
            emit_task_marker(node, lines, out);
        }
        NodeValue::BlockQuote => emit_line_prefix(node, lines, '>', "quote.marker", out),
        NodeValue::ThematicBreak => emit_whole_lines(node, lines, "rule", out),
        NodeValue::CodeBlock(ref block) => {
            if block.fenced {
                emit_fence_lines(node, lines, out);
            }
        }
        NodeValue::FrontMatter(_) => emit_whole_lines(node, lines, "frontmatter", out),
        NodeValue::Table(_) => {
            // The `|---|---|` row is not a `TableRow` — it belongs to the table
            // itself — so its pipes have to be picked up here or the frame
            // breaks at exactly one line.
            let sp = node.data.borrow().sourcepos;
            emit_pipes_on_line(lines, sp.start.line + 1, out);
        }
        NodeValue::TableRow(_) => emit_pipes(node, lines, out),
        NodeValue::Code(ref code) => {
            // Not `emit_gaps`: inline code keeps its text in the node's own
            // value rather than in a child, so the gap arithmetic would call the
            // whole span markup. The backtick runs are a known length instead.
            emit_delimited(node, lines, code.num_backticks, "code", out);
        }
        NodeValue::Strong => emit_gaps(node, lines, "strong.marker", out),
        NodeValue::Emph => emit_gaps(node, lines, "emph.marker", out),
        NodeValue::Strikethrough => {
            emit_gaps(node, lines, "strike.marker", out);
            emit_text_children(node, lines, "strike", out);
        }
        NodeValue::Insert | NodeValue::Underline => {
            emit_gaps(node, lines, "insert.marker", out);
            emit_text_children(node, lines, "insert", out);
        }
        NodeValue::Highlight => {
            emit_gaps(node, lines, "highlight.marker", out);
            emit_text_children(node, lines, "highlight", out);
        }
        NodeValue::Link(_) => {
            emit_gaps(node, lines, "link.marker", out);
            emit_text_children(node, lines, "link", out);
        }
        NodeValue::Image(_) => {
            emit_gaps(node, lines, "image.marker", out);
            emit_text_children(node, lines, "image", out);
        }
        NodeValue::FootnoteReference(_) | NodeValue::FootnoteDefinition(_) => {
            emit_self(node, lines, "footnote", out);
        }
        NodeValue::Math(ref math) => {
            emit_delimited(
                node,
                lines,
                if math.display_math { 2 } else { 1 },
                "math",
                out,
            );
        }
        NodeValue::WikiLink(_) => {
            emit_gaps(node, lines, "wikilink.marker", out);
            emit_text_children(node, lines, "wikilink", out);
        }
        NodeValue::HtmlInline(_) | NodeValue::HtmlBlock(_) => emit_self(node, lines, "html", out),
        _ => {}
    }
}

/// The parts of `node`'s range no child covers — the markup characters.
fn emit_gaps<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let mut child_ranges: Vec<ByteSpan> = Vec::new();
    for child in node.children() {
        child_ranges.extend(node_lines(child, lines));
    }
    for own in node_lines(node, lines) {
        let mut cursor = own.start;
        let mut covering: Vec<&ByteSpan> =
            child_ranges.iter().filter(|c| c.line == own.line).collect();
        covering.sort_by_key(|c| c.start);
        for child in covering {
            if child.start > cursor {
                out.push((
                    ByteSpan {
                        line: own.line,
                        start: cursor,
                        end: child.start.min(own.end),
                    },
                    kind,
                ));
            }
            cursor = cursor.max(child.end);
        }
        if cursor < own.end {
            out.push((
                ByteSpan {
                    line: own.line,
                    start: cursor,
                    end: own.end,
                },
                kind,
            ));
        }
    }
}

/// A construct whose delimiters are a known number of characters at each end,
/// and whose content is not a child node — inline code, and `$math$`.
fn emit_delimited<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    delimiter: usize,
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let marker: &'static str = match kind {
        "code" => "code.marker",
        "math" => "math.marker",
        _ => "code.marker",
    };
    let ranges = node_lines(node, lines);
    let (Some(first), Some(last)) = (ranges.first(), ranges.last()) else {
        return;
    };
    if first.line == last.line && first.end - first.start <= delimiter * 2 {
        out.push((*first, marker));
        return;
    }
    out.push((
        ByteSpan {
            line: first.line,
            start: first.start,
            end: first.start + delimiter,
        },
        marker,
    ));
    out.push((
        ByteSpan {
            line: last.line,
            start: last.end.saturating_sub(delimiter),
            end: last.end,
        },
        marker,
    ));
    for (index, range) in ranges.iter().enumerate() {
        let start = if index == 0 {
            range.start + delimiter
        } else {
            range.start
        };
        let end = if index == ranges.len() - 1 {
            range.end.saturating_sub(delimiter)
        } else {
            range.end
        };
        if end > start {
            out.push((
                ByteSpan {
                    line: range.line,
                    start,
                    end,
                },
                kind,
            ));
        }
    }
}

/// The direct `Text` children — the words, as opposed to the markup.
fn emit_text_children<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    for child in node.children() {
        if matches!(child.data.borrow().value, NodeValue::Text(_)) {
            out.extend(
                node_lines(child, lines)
                    .into_iter()
                    .map(|span| (span, kind)),
            );
        }
    }
}

fn emit_self<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    out.extend(node_lines(node, lines).into_iter().map(|span| (span, kind)));
}

fn emit_whole_lines<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    emit_self(node, lines, kind, out);
}

/// The bullet or number that opens a list item, and nothing after it.
fn emit_item_marker<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    list_type: ListType,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let sp = node.data.borrow().sourcepos;
    let Some(text) = lines.get(sp.start.line.saturating_sub(1)) else {
        return;
    };
    let start = sp.start.column.saturating_sub(1);
    let rest = &text[start.min(text.len())..];
    let marker_len = match list_type {
        ListType::Bullet => rest
            .chars()
            .next()
            .filter(|c| "-+*".contains(*c))
            .map(|c| c.len_utf8()),
        ListType::Ordered => {
            let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            let delimiter = rest[digits..]
                .chars()
                .next()
                .filter(|c| *c == '.' || *c == ')');
            delimiter
                .map(|c| digits + c.len_utf8())
                .filter(|_| digits > 0)
        }
    };
    if let Some(len) = marker_len {
        out.push((
            ByteSpan {
                line: sp.start.line - 1,
                start,
                end: start + len,
            },
            "list.marker",
        ));
    }
}

/// `[ ]` or `[x]`, which Monarch reads as a link.
fn emit_task_marker<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let sp = node.data.borrow().sourcepos;
    let Some(text) = lines.get(sp.start.line.saturating_sub(1)) else {
        return;
    };
    let from = sp.start.column.saturating_sub(1);
    let Some(open) = text[from.min(text.len())..].find('[') else {
        return;
    };
    let start = from + open;
    let Some(close) = text[start..].find(']') else {
        return;
    };
    out.push((
        ByteSpan {
            line: sp.start.line - 1,
            start,
            end: start + close + 1,
        },
        "task.marker",
    ));
}

/// The `>` run at the head of every line the quote covers.
fn emit_line_prefix<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    marker: char,
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let sp = node.data.borrow().sourcepos;
    for line_no in sp.start.line..=sp.end.line {
        let Some(text) = lines.get(line_no.saturating_sub(1)) else {
            continue;
        };
        let mut end = 0;
        for (index, ch) in text.char_indices() {
            if ch == marker {
                end = index + ch.len_utf8();
            } else if ch != ' ' && ch != '\t' {
                break;
            }
        }
        if end > 0 {
            out.push((
                ByteSpan {
                    line: line_no - 1,
                    start: 0,
                    end,
                },
                kind,
            ));
        }
    }
}

/// The ``` lines, not the code between them — that keeps its own colouring.
fn emit_fence_lines<'a>(
    node: &'a AstNode<'a>,
    lines: &[&str],
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    let sp = node.data.borrow().sourcepos;
    for line_no in [sp.start.line, sp.end.line] {
        let Some(text) = lines.get(line_no.saturating_sub(1)) else {
            continue;
        };
        let trimmed = text.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            out.push((
                ByteSpan {
                    line: line_no - 1,
                    start: 0,
                    end: text.len(),
                },
                "fence",
            ));
        }
    }
}

/// Every `|` on a table row's lines.
fn emit_pipes<'a>(node: &'a AstNode<'a>, lines: &[&str], out: &mut Vec<(ByteSpan, &'static str)>) {
    let sp = node.data.borrow().sourcepos;
    for line_no in sp.start.line..=sp.end.line {
        emit_pipes_on_line(lines, line_no, out);
    }
}

fn emit_pipes_on_line(lines: &[&str], line_no: usize, out: &mut Vec<(ByteSpan, &'static str)>) {
    let Some(text) = lines.get(line_no.saturating_sub(1)) else {
        return;
    };
    for (index, ch) in text.char_indices() {
        if ch == '|' {
            out.push((
                ByteSpan {
                    line: line_no - 1,
                    start: index,
                    end: index + 1,
                },
                "table.marker",
            ));
        }
    }
}

/// The syntaxes this app renders that comrak does not see in the raw buffer.
///
/// `convert_markdown` rewrites these into standard Markdown before parsing, so
/// the parse above cannot report them — see the note at the top of this module
/// for why it is handed the raw buffer anyway. Both are scanned the same way the
/// rewriter scans them, and both are line-local.
fn app_syntax_spans(lines: &[&str], out: &mut Vec<(ByteSpan, &'static str)>) {
    math_spans(lines, out);
    for (index, text) in lines.iter().enumerate() {
        let bytes = text.as_bytes();
        let mut at = 0;
        while at + 1 < bytes.len() {
            if bytes[at] == b'[' && bytes[at + 1] == b'[' {
                if let Some(close) = text[at..].find("]]") {
                    let end = at + close + 2;
                    out.push((
                        ByteSpan {
                            line: index,
                            start: at,
                            end: at + 2,
                        },
                        "wikilink.marker",
                    ));
                    out.push((
                        ByteSpan {
                            line: index,
                            start: at + 2,
                            end: end - 2,
                        },
                        "wikilink",
                    ));
                    out.push((
                        ByteSpan {
                            line: index,
                            start: end - 2,
                            end,
                        },
                        "wikilink.marker",
                    ));
                    at = end;
                    continue;
                }
            }
            at += 1;
        }
    }
}

/// `$…$` and `$$…$$`, found the way the renderer finds them.
///
/// Not a second scanner: `find_math_spans` is the one `mask_math_spans` uses to
/// decide what the frontend will typeset, so the editor colours exactly what
/// KaTeX will render — including the code regions it refuses to look inside.
fn math_spans(lines: &[&str], out: &mut Vec<(ByteSpan, &'static str)>) {
    let content = lines.join("\n");
    let regions = crate::markdown::code_region_ranges(&content);
    let mut line_starts = Vec::with_capacity(lines.len());
    let mut at = 0usize;
    for line in lines {
        line_starts.push(at);
        at += line.len() + 1;
    }

    for (start, end) in crate::markdown::find_math_spans(&content, &regions) {
        // Display math spans lines: `$$` opens on one and closes on another,
        // with the formula in between. Every range here is therefore cut at the
        // line boundaries rather than assumed to sit inside one line.
        let delimiter = if content[start..].starts_with("$$") {
            2
        } else {
            1
        };
        if end < start + 2 * delimiter {
            continue;
        }
        emit_byte_range(
            lines,
            &line_starts,
            start,
            start + delimiter,
            "math.marker",
            out,
        );
        emit_byte_range(
            lines,
            &line_starts,
            start + delimiter,
            end - delimiter,
            "math",
            out,
        );
        emit_byte_range(
            lines,
            &line_starts,
            end - delimiter,
            end,
            "math.marker",
            out,
        );
    }
}

/// A byte range over the whole document, as one `ByteSpan` per line it covers.
fn emit_byte_range(
    lines: &[&str],
    line_starts: &[usize],
    start: usize,
    end: usize,
    kind: &'static str,
    out: &mut Vec<(ByteSpan, &'static str)>,
) {
    if end <= start {
        return;
    }
    let first = line_starts
        .partition_point(|&begin| begin <= start)
        .saturating_sub(1);
    for line in first..lines.len() {
        let base = line_starts[line];
        if base >= end {
            break;
        }
        let (from, to) = (
            start.max(base) - base,
            end.min(base + lines[line].len()) - base,
        );
        if to > from {
            out.push((
                ByteSpan {
                    line,
                    start: from,
                    end: to,
                },
                kind,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(text: &str) -> Vec<(String, u32, u32, u32)> {
        semantic_spans(text)
            .into_iter()
            .map(|s| (s.kind.to_string(), s.line, s.start, s.len))
            .collect()
    }

    fn kinds_on(text: &str, line: u32) -> Vec<String> {
        spans(text)
            .into_iter()
            .filter(|s| s.1 == line)
            .map(|s| s.0)
            .collect()
    }

    #[test]
    fn a_heading_separates_its_hashes_from_its_words() {
        // The distinction Monarch cannot express: it emits one `keyword` for the
        // whole line, markup and prose alike.
        let found = spans("## Title\n");
        assert!(
            found.contains(&("heading.marker".into(), 0, 0, 3)),
            "{found:?}"
        );
        assert!(found.contains(&("heading".into(), 0, 3, 5)), "{found:?}");
    }

    #[test]
    fn columns_are_utf16_not_bytes() {
        // comrak reports byte offsets; Monaco counts UTF-16. `中文 ` is 7 bytes
        // and 3 units, so an unconverted span would start four characters late
        // and land mid-character, where Monaco drops it.
        let found = spans("中文 **粗体**\n");
        assert!(
            found.contains(&("strong.marker".into(), 0, 3, 2)),
            "{found:?}"
        );
        assert!(
            found.contains(&("strong.marker".into(), 0, 7, 2)),
            "{found:?}"
        );
    }

    #[test]
    fn an_emoji_line_still_lands_on_character_boundaries() {
        // An astral character is two UTF-16 units and four bytes: three counting
        // systems, and only one of them is Monaco's.
        let found = spans("🎉 `code`\n");
        assert!(found.iter().any(|s| s.0 == "code" && s.1 == 0), "{found:?}");
        let code = found.iter().find(|s| s.0 == "code").unwrap();
        assert_eq!(
            code.2, 4,
            "the backtick sits after an emoji (2) and a space (1), plus its own tick"
        );
    }

    #[test]
    fn a_task_checkbox_is_not_a_link() {
        let kinds = kinds_on("- [x] done\n", 0);
        assert!(kinds.contains(&"task.marker".to_string()), "{kinds:?}");
        assert!(!kinds.iter().any(|k| k.starts_with("link")), "{kinds:?}");
    }

    #[test]
    fn the_syntaxes_monarch_cannot_see_are_reported() {
        for (text, kind) in [
            ("~~gone~~\n", "strike"),
            ("==lit==\n", "highlight"),
            ("++new++\n", "insert"),
            ("[[a page]]\n", "wikilink"),
        ] {
            let kinds = kinds_on(text, 0);
            assert!(
                kinds.contains(&kind.to_string()),
                "{kind} missing in {kinds:?}"
            );
        }
    }

    #[test]
    fn display_math_is_cut_at_its_line_ends() {
        // `$$…$$` opens on one line and closes on another, so its range is not
        // an offset into any single line — slicing it out of the opening line
        // panics, and the release profile aborts on panic.
        let found = spans("$$\nE=mc^2\n$$\n");
        assert_eq!(
            found,
            vec![
                ("math.marker".into(), 0, 0, 2),
                ("math".into(), 1, 0, 6),
                ("math.marker".into(), 2, 0, 2),
            ],
            "{found:?}"
        );
    }

    #[test]
    fn emphasis_that_does_not_render_is_not_reported() {
        // Monarch's `\b_[^_]+_\b` matches inside `snake_case_word`; CommonMark
        // does not emphasise intraword underscores, so neither does this.
        let kinds = kinds_on("snake_case_word here\n", 0);
        assert!(kinds.is_empty(), "{kinds:?}");
        // And an unclosed run is not emphasis either.
        assert!(kinds_on("**unclosed\n", 0).is_empty());
    }

    #[test]
    fn spans_never_overlap() {
        let text = "# Head `code` **bold _mixed_**\n\n> quote with `tick`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let mut seen: Vec<(u32, u32, u32)> = semantic_spans(text)
            .into_iter()
            .map(|s| (s.line, s.start, s.len))
            .collect();
        seen.sort();
        for pair in seen.windows(2) {
            let (line, start, len) = pair[0];
            let (next_line, next_start, _) = pair[1];
            if line == next_line {
                assert!(
                    start + len <= next_start,
                    "overlap at line {line}: {:?} then {:?}",
                    pair[0],
                    pair[1]
                );
            }
        }
    }

    #[test]
    fn a_fenced_block_marks_its_fences_and_leaves_the_code_alone() {
        let found = spans("```rust\nlet x = 1;\n```\n");
        assert!(found.iter().any(|s| s.0 == "fence" && s.1 == 0));
        assert!(found.iter().any(|s| s.0 == "fence" && s.1 == 2));
        assert!(
            !found.iter().any(|s| s.1 == 1),
            "the code itself keeps its own colouring: {found:?}"
        );
    }
}
