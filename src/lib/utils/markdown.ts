import { convertFileSrc } from "@tauri-apps/api/core";
import { assignFoldKey, isFolded } from "./foldState.js";
import { parseSourceposLineRange } from "./previewAnchor.js";
import { carrySourcepos } from "./richContent.js";

const alertIcons: Record<string, string> = {
	note: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
	info: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
	todo: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-big"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>',
	tip: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
	important: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-alert-circle"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>',
	warning: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
	caution: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-octagon-alert"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>',
	faq: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-help"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
	question: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-help"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
	example: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>',
};

/**
 * Resolves a **filesystem path** an author wrote in a document — an image
 * `src`, a local file link — against the document holding it.
 *
 * Deliberately not the same function as `resolveHrefRelativePath` in
 * ./markdownLinks.ts, which resolves an *href*. The two were named alike and
 * differ in three ways that are each right for one caller and wrong for the
 * other, so `three path resolvers stay three` in scripts/exportHtml.test.ts
 * pins the differences rather than papering over them:
 *
 *   - `\` separates here, in the relative half too: a Windows author writes
 *     `![](img\a.png)` and means a directory. In an href `\` is an ordinary
 *     character and must survive.
 *   - Empty segments survive (`a//b` stays `a//b`), because a path is bytes
 *     the OS will be handed, not a URL to tidy up.
 *   - A base with no separator at all — an unsaved buffer's `""`, a bare
 *     `note.md` — yields a *relative* result rather than one rooted at `/`.
 *     Callers that cannot use a relative answer refuse it themselves;
 *     `resolveLocalFileLinkPath` is the one that does.
 */
export function resolveDocumentRelativePath(
	basePath: string,
	relativePath: string,
): string {
	if (relativePath.match(/^[a-zA-Z]:/) || relativePath.startsWith("/"))
		return relativePath;
	const parts = basePath.split(/[/\\]/);
	parts.pop();
	for (const p of relativePath.split(/[/\\]/)) {
		if (p === ".") continue;
		if (p === "..") parts.pop();
		else parts.push(p);
	}
	return parts.join("/");
}

function isYoutubeLink(url: string): boolean {
	return (
		url.includes("youtube.com/watch") ||
		url.includes("youtube.com/embed/") ||
		url.includes("youtube.com/v/") ||
		url.includes("youtube.com/u/") ||
		url.includes("youtu.be/")
	);
}

function getYoutubeId(url: string): string | null {
	const match = url.match(
		/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/,
	);
	return match && match[2].length === 11 ? match[2] : null;
}

function replaceWithYoutubeLink(element: Element, videoId: string, href: string) {
	const link = element.ownerDocument.createElement("a");
	link.className = "youtube-link";
	carrySourcepos(element, link);
	link.href = href;
	link.setAttribute("aria-label", "Open YouTube video in browser");

	const thumbnail = element.ownerDocument.createElement("img");
	thumbnail.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	thumbnail.alt = "YouTube video thumbnail";
	link.appendChild(thumbnail);

	element.replaceWith(link);
}

function processInlineMath(root: Element) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			let curr = node.parentElement;
			while (curr && curr !== root) {
				if (curr.hasAttribute("data-math"))
					return NodeFilter.FILTER_REJECT;
				if (["CODE", "PRE", "SCRIPT", "STYLE"].includes(curr.tagName))
					return NodeFilter.FILTER_REJECT;
				curr = curr.parentElement;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const toReplace: { node: Text; newText: string }[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const text = (node as Text).nodeValue || "";
		if (text.includes("$")) {
			const newText = convertInlineMathDelimiters(text);
			if (newText !== text) toReplace.push({ node: node as Text, newText });
		}
	}
	for (const { node, newText } of toReplace) {
		node.nodeValue = newText;
	}
}

function processDisplayMathBlocks(root: Element, doc: Document) {
	for (const element of Array.from(root.querySelectorAll("p, li"))) {
		const math = extractDisplayMathBlock(element);
		if (!math) continue;

		element.setAttribute("data-math", "display");
		element.setAttribute("data-math-source", math);
		element.replaceChildren(doc.createTextNode(math));
	}
}

function extractDisplayMathBlock(element: Element): string | null {
	let text = "";
	let previousWasBreak = false;

	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			let value = child.nodeValue || "";
			if (previousWasBreak) value = value.replace(/^\n+/, "");
			text += value;
			previousWasBreak = false;
		} else if (
			child.nodeType === Node.ELEMENT_NODE &&
			(child as Element).tagName === "BR"
		) {
			text += "\n";
			previousWasBreak = true;
		} else {
			return null;
		}
	}

	const trimmed = text.trim();
	if (!trimmed.startsWith("$$") || !trimmed.endsWith("$$")) return null;

	const math = trimmed.slice(2, -2).trim();
	return math ? math : null;
}

/**
 * Rewrites the math of one text node into delimiters KaTeX's auto-renderer can
 * find, and resolves the dollar escapes the backend handed over intact.
 *
 * The output vocabulary is deliberately small and deliberately unspellable in
 * Markdown: `\(…\)` for inline, `\[…\]` for a same-line `$$…$$`. CommonMark
 * eats a user-typed `\(` or `\[` long before this function runs, so every one
 * of these that exists was minted here — which is what lets KaTeX be given no
 * `$`-based delimiter at all (see MATH_DELIMITERS in richContent.ts) and what
 * makes this function the single place that decides what a reader sees as a
 * formula.
 *
 * That in turn is why `\$` arrives here still escaped. comrak would have
 * resolved it, and then `\$\$x\$\$` and `$$x$$` would be the same eight bytes
 * and the reader's literal dollars would be typeset. `mask_math_spans` in
 * src-tauri/src/lib.rs hides the escape from comrak for exactly this moment.
 */
function convertInlineMathDelimiters(text: string): string {
	const parts: string[] = [];
	let index = 0;
	// Allows adjacent inline spans like `$a$$b$` without treating `$$` display
	// delimiters as inline math openings.
	let previousDollarAllowsInlineOpen = false;

	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			let run = 1;
			while (text[index + run] === "\\") run += 1;
			if (text[index + run] !== "$") {
				parts.push(text.slice(index, index + run));
				previousDollarAllowsInlineOpen = false;
				index += run;
				continue;
			}
			// CommonMark's own arithmetic: each `\\` is one literal backslash,
			// and the odd one left over is what marks the `$` as text. Whether
			// the run is odd or even the `$` is not a delimiter — that is the
			// rule the backend ports in `find_math_spans`, and the two have to
			// stay the same rule.
			parts.push("\\".repeat(run >> 1) + "$");
			previousDollarAllowsInlineOpen = false;
			index += run + 1;
			continue;
		}
		if (char !== "$") {
			parts.push(char);
			previousDollarAllowsInlineOpen = false;
			index += 1;
			continue;
		}

		if (text[index + 1] === "$") {
			const displayEnd = findDisplayMathEnd(text, index + 2);
			if (displayEnd !== -1) {
				parts.push(`\\[${text.slice(index + 2, displayEnd).trim()}\\]`);
				previousDollarAllowsInlineOpen = true;
				index = displayEnd + 2;
				continue;
			}

			parts.push("$$");
			previousDollarAllowsInlineOpen = false;
			index += 2;
			continue;
		}

		// A backslash in front of this `$` is impossible: the branch above
		// consumes the whole run together with the `$` it escapes.
		if (
			(text[index - 1] === "$" && !previousDollarAllowsInlineOpen) ||
			/\s/.test(text[index + 1] || "")
		) {
			parts.push(char);
			previousDollarAllowsInlineOpen = false;
			index += 1;
			continue;
		}

		const end = findInlineMathEnd(text, index + 1);
		if (end === -1) {
			parts.push(char);
			previousDollarAllowsInlineOpen = false;
			index += 1;
			continue;
		}

		parts.push(`\\(${text.slice(index + 1, end)}\\)`);
		index = end + 1;
		previousDollarAllowsInlineOpen = true;
	}

	return parts.join("");
}

function findDisplayMathEnd(text: string, start: number): number {
	for (let index = start; index < text.length - 1; index += 1) {
		if (
			text[index] === "$" &&
			text[index + 1] === "$" &&
			text[index - 1] !== "\\"
		) {
			return index;
		}
	}
	return -1;
}

function findInlineMathEnd(text: string, start: number): number {
	for (let index = start; index < text.length; index += 1) {
		if (text[index] !== "$") continue;
		// Escaped dollars are math content, not closing delimiters.
		if (text[index - 1] === "\\") continue;

		const beforeEnd = text[index - 1] || "";
		const afterEnd = text[index + 1] || "";
		// A following `$` may open an adjacent inline span; the outer loop handles it.
		if (/\s/.test(beforeEnd) || /\d/.test(afterEnd)) return -1;

		return index;
	}
	return -1;
}

function processBlockIds(root: Element, doc: Document) {
	for (const el of Array.from(
		root.querySelectorAll(".block-id, [data-block-id]"),
	)) {
		const rawId =
			el.getAttribute("data-block-id") ||
			(el as HTMLElement).textContent?.replace(/^\^/, "").trim() ||
			"";
		if (!rawId) continue;
		const anchor = doc.createElement("a");
		anchor.id = rawId;
		anchor.className = "block-id-anchor";
		anchor.setAttribute("data-label", rawId);
		anchor.setAttribute("aria-hidden", "true");
		el.replaceWith(anchor);
	}

	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			if (
				[
					"CODE",
					"PRE",
					"SCRIPT",
					"STYLE",
					"H1",
					"H2",
					"H3",
					"H4",
					"H5",
					"H6",
				].includes(parent.tagName)
			)
				return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const blockIdPattern = / \^([a-zA-Z0-9_-]+)\s*$/;
	const nodes: { node: Text; id: string }[] = [];
	let textNode: Node | null;
	while ((textNode = walker.nextNode())) {
		const text = (textNode as Text).nodeValue || "";
		const match = text.match(blockIdPattern);
		if (match) nodes.push({ node: textNode as Text, id: match[1] });
	}

	for (const { node, id } of nodes) {
		const text = node.nodeValue || "";
		const cleanText = text.replace(blockIdPattern, "");
		const anchor = doc.createElement("a");
		anchor.id = id;
		anchor.className = "block-id-anchor";
		anchor.setAttribute("data-label", id);
		anchor.setAttribute("aria-hidden", "true");
		const parent = node.parentNode;
		if (parent) {
			const textBefore = doc.createTextNode(cleanText);
			parent.replaceChild(anchor, node);
			parent.insertBefore(textBefore, anchor);
		}
	}
}

const taskTextBoundaryTags = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DD",
	"DETAILS",
	"DIALOG",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"UL",
]);

function stripLeadingWhitespace(nodes: Node[]) {
	for (let index = 0; index < nodes.length; ) {
		const node = nodes[index];
		if (node.nodeType !== 3) break;

		const trimmed = node.textContent?.replace(/^\s+/, "") || "";
		if (trimmed) {
			node.textContent = trimmed;
			break;
		}
		node.parentNode?.removeChild(node);
		nodes.splice(index, 1);
	}
}

function processTaskItems(root: Element) {
	for (const input of Array.from(
		root.querySelectorAll('li input[type="checkbox"]'),
	)) {
		const li = input.closest("li");
		if (!li) continue;
		if (!input.hasAttribute("data-task-checkbox")) {
			input.setAttribute("disabled", "");
			continue;
		}

		input.setAttribute("data-task-checkbox", "");
		input.removeAttribute("disabled");
		(input as HTMLInputElement).style.cursor = "pointer";

		// comrak writes `task-list-item` only on the branch where it opens the
		// `<li>` itself, which a plain task item does not take — so the `<ul>`
		// gets `contains-task-list` and the items get nothing. That asymmetry
		// showed as half a fix: the bullet disappeared, because that rule can
		// match the list, while the grid that puts the checkbox beside its text
		// stayed dead, because every one of those rules names the item.
		//
		// Added here rather than by widening fifteen selectors to
		// `ul.contains-task-list > li`: this loop already owns which items are
		// really tasks — `data-task-checkbox` is the renderer's own verdict,
		// checked above — so the class lands on exactly that set and nothing
		// else, including in documents where a `<ul>` holds both kinds.
		li.classList.add("task-list-item");

		const inputParagraph = input.parentElement;
		if (inputParagraph?.tagName === "P" && inputParagraph.parentElement === li) {
			li.insertBefore(input, inputParagraph);
		}

		const nodes = Array.from(li.childNodes);
		const inputIdx = nodes.indexOf(input);
		if (inputIdx === -1) continue;
		const afterInput = nodes.slice(inputIdx + 1);

		const inlineNodes: Node[] = [];
		let paragraphNode: Element | null = null;
		for (const n of afterInput) {
			if (n.nodeType === 3 && !n.textContent?.trim()) {
				inlineNodes.push(n);
				continue;
			}

			if (n.nodeType === 1 && taskTextBoundaryTags.has((n as Element).tagName)) {
				const onlyLeadingWhitespace = inlineNodes.every(
					(node) => node.nodeType === 3 && !node.textContent?.trim(),
				);
				if ((n as Element).tagName === "P" && onlyLeadingWhitespace) {
					paragraphNode = n as Element;
				}
				break;
			}
			inlineNodes.push(n);
		}

		const hasInlineText = inlineNodes.some(
			(n) => n.nodeType !== 3 || n.textContent?.trim(),
		);
		if (paragraphNode) {
			stripLeadingWhitespace(inlineNodes);
			const paragraphChildren = Array.from(paragraphNode.childNodes);
			const hasParagraphText = paragraphChildren.some(
				(n) => n.nodeType !== 3 || n.textContent?.trim(),
			);
			if (!hasParagraphText) {
				paragraphNode.remove();
			} else {
				stripLeadingWhitespace(paragraphChildren);
				const wrapper = root.ownerDocument!.createElement("span");
				wrapper.className = "task-text";
				for (const n of paragraphChildren) wrapper.appendChild(n);
				paragraphNode.replaceWith(wrapper);
			}
		} else if (hasInlineText) {
			const insertBeforeNode = afterInput[inlineNodes.length] || null;
			stripLeadingWhitespace(inlineNodes);
			const wrapper = root.ownerDocument!.createElement("span");
			wrapper.className = "task-text";
			for (const n of inlineNodes) wrapper.appendChild(n);
			li.insertBefore(wrapper, insertBeforeNode);
		} else {
			stripLeadingWhitespace(inlineNodes);
		}

		if ((input as HTMLInputElement).checked) {
			li.classList.add("task-done");
		}
	}
}

/**
 * How many source lines a block has to span before its soft line breaks are
 * worth anchoring.
 *
 * Two lines cost half a line of interpolation error at worst, which nobody can
 * see; the anchors are for the long paragraphs where the error accumulates.
 * Keeping short blocks untouched is most of the DOM saving, because most
 * paragraphs are short.
 */
const LINE_ANCHOR_MIN_SPAN = 3;

/**
 * Give each soft line break inside a long block a measurable position.
 *
 * Split-view scroll sync is asymmetric. The editor answers "which line is at
 * this pixel" from Monaco's real layout, so it knows the height of every line
 * including its wraps. The preview answers the reverse by interpolating across
 * the block that owns the line — which assumes every source line in the block
 * renders to the same height. Prose breaks that assumption whenever one line
 * wraps to three and the next to one, and a long paragraph is where the error
 * shows.
 *
 * The information to do better is already in the DOM. `render.hardbreaks` is
 * on, so every source newline becomes a `<br>`, and comrak stamps each one
 * with the line it ended. What a `<br>` cannot do is be measured: it generates
 * no CSS box, which is why `BOXLESS_TAGS` in previewAnchor.ts excludes it —
 * resolving to one hands the caller `offsetTop = 0` and scrolls to the top of
 * the document.
 *
 * So each break gets a sibling that does generate a box, carrying the line the
 * break starts rather than the one it ends. Zero-width and zero-height, so it
 * changes nothing on screen; `previewAnchor` needs only `offsetTop` from it,
 * because a single-line range never interpolates and never reads the height.
 *
 * The `<br>` itself is left alone. Replacing it would put the layout, text
 * selection and copy behaviour of every wrapped paragraph at risk to save one
 * node per line.
 */
function processSoftLineAnchors(root: Element, doc: Document) {
	for (const block of Array.from(root.querySelectorAll("[data-sourcepos]"))) {
		const range = parseSourceposLineRange(block.getAttribute("data-sourcepos"));
		if (!range || range.endLine - range.startLine + 1 < LINE_ANCHOR_MIN_SPAN) continue;

		for (const br of Array.from(block.querySelectorAll("br[data-sourcepos]"))) {
			// Only the breaks this block owns. A nested block keeps its own, and
			// it will be visited in its own turn if it is long enough to qualify.
			//
			// From the PARENT: `closest` matches the element it starts on, and
			// the `<br>` carries a `data-sourcepos` of its own, so starting on
			// it answers with the `<br>` every time and nothing would qualify.
			if (br.parentElement?.closest("[data-sourcepos]") !== block) continue;

			const at = parseSourceposLineRange(br.getAttribute("data-sourcepos"));
			if (!at) continue;

			// The line AFTER the break: the anchor marks where the next source
			// line starts on screen, which is the question the mapping asks.
			const line = at.endLine + 1;
			if (line > range.endLine) continue;

			const anchor = doc.createElement("span");
			anchor.className = "source-line-anchor";
			anchor.setAttribute("data-sourcepos", `${line}:1-${line}:1`);
			anchor.setAttribute("aria-hidden", "true");
			// `insertBefore` rather than `after`: it is the older API, and the
			// render-protocol DOM the tests drive implements it.
			br.parentNode?.insertBefore(anchor, br.nextSibling);
		}
	}
}

export function processMarkdownHtml(
	html: string,
	filePath: string,
	foldOverrides: Set<string>,
): string {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, "text/html");

	// The keys handed out in THIS render, shared by the callout pass and the
	// heading pass below so that neither can hand out a key the other used.
	const foldKeys = new Set<string>();

	for (const img of doc.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		let finalSrc = src;
		if (src && !src.startsWith("http") && !src.startsWith("data:")) {
			try {
				const decodedSrc = decodeURIComponent(src);
				finalSrc = convertFileSrc(
					resolveDocumentRelativePath(filePath, decodedSrc),
				);
				img.setAttribute("src", finalSrc);
			} catch (e) {
				console.error("Failed to decode/resolve image src:", src, e);
			}
		}

		if (src) {
			const ext = src.split(".").pop()?.toLowerCase();
			const isVideo = ["mp4", "webm", "ogg", "mov"].includes(ext || "");
			const isAudio = ["mp3", "wav", "aac", "flac", "m4a"].includes(
				ext || "",
			);

			if (isVideo || isAudio) {
				const media = doc.createElement(isVideo ? "video" : "audio");
				media.setAttribute("controls", "");
				media.setAttribute("src", finalSrc || "");
				media.style.maxWidth = "100%";
				carrySourcepos(img, media);

				if (img.hasAttribute("width"))
					media.setAttribute("width", img.getAttribute("width")!);
				if (img.hasAttribute("height"))
					media.setAttribute("height", img.getAttribute("height")!);
				if (img.hasAttribute("alt"))
					media.setAttribute("aria-label", img.getAttribute("alt")!);
				if (img.hasAttribute("title"))
					media.setAttribute("title", img.getAttribute("title")!);

				img.replaceWith(media);
				continue;
			}

			if (isYoutubeLink(src)) {
				const videoId = getYoutubeId(src);
				if (videoId) replaceWithYoutubeLink(img, videoId, src);
			}
		}
	}

	for (const a of doc.querySelectorAll("a")) {
		const href = a.getAttribute("href");
		if (href && isYoutubeLink(href)) {
			const parent = a.parentElement;
			if (
				parent &&
				(parent.tagName === "P" || parent.tagName === "DIV") &&
				parent.childNodes.length === 1
			) {
				const videoId = getYoutubeId(href);
				if (videoId) replaceWithYoutubeLink(a, videoId, href);
			}
		}
	}

	const stripLeadingBreaks = (node: Node) => {
		const brs = (node as Element).querySelectorAll("br");
		for (const br of Array.from(brs)) {
			// If the BR is the first meaningful node in its parent or overall block
			let prev = br.previousSibling;
			let isLeading = true;
			while (prev) {
				if (prev.nodeType === 3 && prev.textContent?.replace(/\xA0|\s|&nbsp;/g, "").trim()) {
					isLeading = false;
					break;
				} else if (prev.nodeType === 1) {
					isLeading = false;
					break;
				}
				prev = prev.previousSibling;
			}
			if (isLeading) {
				br.parentElement?.removeChild(br);
			}
		}

		// Also clean up leading empty text nodes and paragraphs
		while (node.firstChild) {
			const child = node.firstChild;
			if (child.nodeType === 3 && child.textContent?.replace(/\xA0|\s|&nbsp;/g, "").trim() === "") {
				child.parentElement?.removeChild(child);
			} else if (child.nodeType === 1 && (child as Element).tagName === "P" && (child as Element).innerHTML.replace(/\xA0|\s|&nbsp;/g, "").trim() === "") {
				child.parentElement?.removeChild(child);
			} else {
				break;
			}
		}
	};

	// parse callouts
	for (const bq of Array.from(doc.querySelectorAll("blockquote"))) {
		const walker = doc.createTreeWalker(bq, NodeFilter.SHOW_TEXT);
		let textNode: Text | null = null;
		let matchResult: RegExpMatchArray | null = null;
		
		let curr: Node | null;
		while (curr = walker.nextNode()) {
			const m = curr.nodeValue?.match(/^\s*\[!([a-zA-Z0-9_\-]+)\]([+-]?)\s*/i);
			if (m) {
				textNode = curr as Text;
				matchResult = m;
				break;
			}
		}

		if (textNode && matchResult) {
			const type = matchResult[1].toLowerCase();
			const fold = matchResult[2] || "";
			const isFoldable = fold === "+" || fold === "-";
			
			textNode.nodeValue = textNode.nodeValue!.slice(matchResult[0].length);

			const titleNodes: Node[] = [];
			let currentLineNode: Node | null = textNode;
			while (currentLineNode) {
				if (currentLineNode.nodeType === 1 && (currentLineNode as Element).tagName === "BR") {
					const br = currentLineNode;
					currentLineNode = br.nextSibling;
					br.parentElement?.removeChild(br);
					break;
				}
				const next: Node | null = currentLineNode.nextSibling;
				titleNodes.push(currentLineNode);
				currentLineNode = next;
			}

			const container = doc.createElement("div");
			container.className = `markdown-alert markdown-alert-${type}${isFoldable ? ' callout-foldable' : ''}`;
			
			const titleEl = doc.createElement("p");
			titleEl.className = "markdown-alert-title";
			if (isFoldable) titleEl.classList.add("callout-toggle");

			const titleInner = doc.createElement("span");
			titleInner.className = "callout-title-inner";
			for (const tn of titleNodes) titleInner.appendChild(tn);
			
			// Restore default title if empty
			if (titleInner.textContent?.trim() === "") {
				titleInner.textContent = type.charAt(0).toUpperCase() + type.slice(1);
			}
			
			// Omit rendering any stray <br> tags in the title
			for (const br of Array.from(titleInner.querySelectorAll("br"))) {
				br.parentElement?.removeChild(br);
			}

			const svgIconHtml = alertIcons[type] || "";
			if (svgIconHtml) {
				const temp = doc.createElement("div");
				temp.innerHTML = svgIconHtml;
				if (temp.firstChild) titleEl.appendChild(temp.firstChild);
			}
			titleEl.appendChild(titleInner);

			if (isFoldable) {
				const chevron = doc.createElement("div");
				chevron.innerHTML = `<svg class="callout-fold-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
				titleEl.appendChild(chevron.firstChild!);
			}
			container.appendChild(titleEl);

			const contentWrapper = doc.createElement("div");
			contentWrapper.className = "markdown-alert-content";
			const contentInner = doc.createElement("div");
			contentInner.className = "content-inner";
			contentWrapper.appendChild(contentInner);

			while (bq.firstChild) {
				contentInner.appendChild(bq.firstChild);
			}

			stripLeadingBreaks(contentInner);
			
			while (contentInner.lastChild) {
				const child = contentInner.lastChild;
				if (child.nodeType === 3 && child.textContent?.trim() === "") child.parentElement?.removeChild(child);
				else if (child.nodeType === 1 && (child as Element).tagName === "P" && (child as Element).innerHTML.trim() === "") child.parentElement?.removeChild(child);
				else break;
			}

			if (contentInner.childNodes.length === 0) {
				container.classList.add("callout-title-only");
			} else {
				// A callout the reader folds is remembered exactly like a
				// heading, and `> [!note]-` is the document's opening position
				// rather than a state of its own — see `foldState.ts`. A
				// title-only callout hides nothing and so is not a fold at all,
				// which is why the key is assigned in this branch.
				if (isFoldable) {
					const key = assignFoldKey(container, foldKeys);
					if (isFolded(foldOverrides, key, fold === "-")) {
						contentWrapper.classList.add("is-collapsed");
						container.classList.add("is-collapsed");
					}
				}
				container.appendChild(contentWrapper);
			}
			bq.replaceWith(container);
		}
	}

	processDisplayMathBlocks(doc.body, doc);
	processBlockIds(doc.body, doc);
	processTaskItems(doc.body);
	processInlineMath(doc.body);
	processSoftLineAnchors(doc.body, doc);

	const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6"));
	// The heading↔wrapper pairing only needs to be unique within this
	// render's output (the previous DOM is replaced wholesale), so a
	// counter keeps the HTML deterministic for identical input.
	let nextFoldId = 0;
	for (const h of headings) {
		// comrak puts the deduplicated heading id ("title", "title-1", ...)
		// on an empty inner <a class="anchor">, so h.id is empty and the fold
		// key falls all the way back to the heading text — which collides for
		// duplicate titles and never matches an id-based anchor link. Promote
		// the id onto the heading itself (and off the anchor, so the document
		// keeps unique ids). See `assignFoldKey`.
		const headingAnchor = h.querySelector("a.anchor");
		if (headingAnchor && headingAnchor.id && !h.id) {
			h.id = headingAnchor.id;
			headingAnchor.removeAttribute("id");
		}

		const chevron = doc.createElement("span");
		chevron.className = "header-fold-icon";
		chevron.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
		h.insertBefore(chevron, h.firstChild);
		h.classList.add("foldable-header");

		const wrapper = doc.createElement("div");
		wrapper.className = "foldable-content-wrapper";
		const inner = doc.createElement("div");
		inner.className = "content-inner";
		wrapper.appendChild(inner);

		let current = h.nextElementSibling;
		const level = parseInt(h.tagName[1], 10);
		while (current) {
			const isHeader = /^H[1-6]$/.test(current.tagName);
			if (isHeader) {
				const nextLevel = parseInt(current.tagName[1], 10);
				if (nextLevel <= level) break;
			}
			const next = current.nextElementSibling;
			inner.appendChild(current);
			current = next;
		}
		if (h.parentNode) h.parentNode.insertBefore(wrapper, h.nextSibling);

		const mappingId = "wrap-" + nextFoldId++;
		h.setAttribute("data-fold-target", mappingId);
		wrapper.id = mappingId;

		const key = assignFoldKey(h, foldKeys);
		if (isFolded(foldOverrides, key)) {
			h.classList.add("is-collapsed");
			wrapper.classList.add("is-collapsed");
		}
	}

	// Clean up empty paragraphs that might be leftovers from blank lines
	Array.from(doc.querySelectorAll("p")).forEach((p) => {
		if (p.innerHTML.replace(/&nbsp;|\s/g, "").trim() === "") {
			p.remove();
		}
	});

	return doc.body.innerHTML;
}
