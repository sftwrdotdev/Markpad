/**
 * Markdown input → `convert_markdown` output, captured from a real comrak run.
 *
 * These are INPUTS, not expected values: `renderProtocol.test.ts` feeds the
 * `html` of each case to the frontend's `processMarkdownHtml` and asserts what
 * the frontend does with it. Nothing here re-asserts comrak's own behaviour —
 * that is `src-tauri/src/lib.rs`'s `mod tests` job, and it already covers it.
 *
 * Provenance: every `html` below is the return value of `convert_markdown`
 * itself — the real function, not a restatement of it — for the `markdown`
 * beside it, most recently captured against comrak 0.54. Earlier captures were
 * assembled from comrak plus verbatim copies of the post-passes, and seven of
 * the `math*` entries had drifted out of date that way, which is why the whole
 * table is now taken from one call.
 *
 * The wikilink/embed/autolink pre-passes are no-ops on every input below.
 *
 * To refresh after a comrak upgrade or a renderer change, re-run
 * `convert_markdown` over `markdown` and replace `html`. Do not hand-edit
 * `html`: a fixture that no longer matches the renderer makes every assertion
 * here a lie.
 */

type RenderFixture = {
	/** Markdown handed to `convert_markdown`. */
	markdown: string;
	/** Exactly what `convert_markdown` returned. */
	html: string;
};

export const renderFixtures = {
	// --- protocol 1 — task-list markers and source positions ---
	taskSimple: {
		markdown: "- [ ] open task\n- [x] completed task\n",
		html: "<ul data-sourcepos=\"1:1-2:20\">\n<li data-sourcepos=\"1:1-1:15\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> open task</li>\n<li data-sourcepos=\"2:1-2:20\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> completed task</li>\n</ul>\n",
	},
	taskNested: {
		markdown: "- [ ] parent\n  - [x] nested\n",
		html: "<ul data-sourcepos=\"1:1-2:14\">\n<li data-sourcepos=\"1:1-2:14\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> parent\n<ul data-sourcepos=\"2:3-2:14\">\n<li data-sourcepos=\"2:3-2:14\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> nested</li>\n</ul>\n</li>\n</ul>\n",
	},
	taskQuoted: {
		markdown: "> - [ ] quoted task\n",
		html: "<blockquote data-sourcepos=\"1:1-1:19\">\n<ul data-sourcepos=\"1:3-1:19\">\n<li data-sourcepos=\"1:3-1:19\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> quoted task</li>\n</ul>\n</blockquote>\n",
	},
	taskOrdered: {
		markdown: "1. [ ] ordered open\n2. [x] ordered done\n",
		html: "<ol data-sourcepos=\"1:1-2:19\">\n<li data-sourcepos=\"1:1-1:19\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> ordered open</li>\n<li data-sourcepos=\"2:1-2:19\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> ordered done</li>\n</ol>\n",
	},
	taskSurrounded: {
		markdown: "# Title\n\nIntro paragraph.\n\n- [ ] after prose\n\nTrailing prose.\n\n- [x] after blank\n",
		html: "<h1 id=\"title\" data-sourcepos=\"1:1-1:7\">Title<a href=\"#title\" aria-label=\"Link to heading 'Title'\" data-heading-content=\"Title\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"3:1-3:16\">Intro paragraph.</p>\n<ul data-sourcepos=\"5:1-5:17\">\n<li data-sourcepos=\"5:1-5:17\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> after prose</li>\n</ul>\n<p data-sourcepos=\"7:1-7:15\">Trailing prose.</p>\n<ul data-sourcepos=\"9:1-9:17\">\n<li data-sourcepos=\"9:1-9:17\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> after blank</li>\n</ul>\n",
	},
	taskCrlf: {
		markdown: "- [ ] crlf open\r\n- [x] crlf done\r\n",
		html: "<ul data-sourcepos=\"1:1-2:15\">\n<li data-sourcepos=\"1:1-1:15\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> crlf open</li>\n<li data-sourcepos=\"2:1-2:15\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> crlf done</li>\n</ul>\n",
	},
	taskLoose: {
		markdown: "- [ ] loose one\n\n- [x] loose two\n",
		html: "<ul data-sourcepos=\"1:1-3:15\">\n<li data-sourcepos=\"1:1-1:15\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> \n<p data-sourcepos=\"1:7-1:15\">loose one</p>\n</li>\n<li data-sourcepos=\"3:1-3:15\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> \n<p data-sourcepos=\"3:7-3:15\">loose two</p>\n</li>\n</ul>\n",
	},
	taskContinuation: {
		markdown: "- [ ] first line\n  continued line\n- [x] second task\n",
		html: "<ul data-sourcepos=\"1:1-3:17\">\n<li data-sourcepos=\"1:1-2:16\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> first line<br data-sourcepos=\"1:17-1:17\" />\ncontinued line</li>\n<li data-sourcepos=\"3:1-3:17\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> second task</li>\n</ul>\n",
	},
	taskParenOrdered: {
		markdown: "1) [ ] paren marker\n",
		html: "<ol data-sourcepos=\"1:1-1:19\">\n<li data-sourcepos=\"1:1-1:19\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> paren marker</li>\n</ol>\n",
	},
	taskStarPlus: {
		markdown: "* [ ] star marker\n+ [x] plus marker\n",
		html: "<ul data-sourcepos=\"1:1-1:17\">\n<li data-sourcepos=\"1:1-1:17\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> star marker</li>\n</ul>\n<ul data-sourcepos=\"2:1-2:17\">\n<li data-sourcepos=\"2:1-2:17\"><input type=\"checkbox\" data-task-checkbox=\"\" checked=\"\" disabled=\"\" /> plus marker</li>\n</ul>\n",
	},
	taskTextAfterBlock: {
		markdown: "- [ ] task\n  ```sh\n  make\n  ```\n  then **check** it\n- [ ] next\n",
		html: "<ul class=\"contains-task-list\" data-sourcepos=\"1:1-6:10\">\n<li data-sourcepos=\"1:1-5:19\"><input type=\"checkbox\" data-task-checkbox=\"\" class=\"task-list-item-checkbox\" disabled=\"\" /> task\n<pre data-sourcepos=\"2:3-4:5\"><code class=\"language-sh\">make\n</code></pre>\nthen <strong data-sourcepos=\"5:8-5:16\">check</strong> it</li>\n<li data-sourcepos=\"6:1-6:10\"><input type=\"checkbox\" data-task-checkbox=\"\" class=\"task-list-item-checkbox\" disabled=\"\" /> next</li>\n</ul>\n",
	},
	// --- protocol 2 — $$…$$ underscore protection (issue #174 shapes) ---
	mathBracedSubscripts: {
		markdown: "$$\\bar{b}_{1} + \\bar{b}_{2}$$\n",
		html: "<p data-sourcepos=\"1:1-1:12\">$$\\bar{b}_{1} + \\bar{b}_{2}$$</p>\n",
	},
	mathPlainSubscripts: {
		markdown: "$$x_1 + y_2 + z_3$$\n",
		html: "<p data-sourcepos=\"1:1-1:12\">$$x_1 + y_2 + z_3$$</p>\n",
	},
	mathBlockOwnLines: {
		markdown: "$$\na_i = b_i + c_i\n$$\n",
		html: "<p data-sourcepos=\"1:1-3:12\">$$<br data-sourcepos=\"1:13-1:13\" />\na_i = b_i + c_i<br data-sourcepos=\"2:13-2:13\" />\n$$</p>\n",
	},
	mathTwoBlocksOneLine: {
		markdown: "before $$a_1$$ middle $$b_2$$ after\n",
		html: "<p data-sourcepos=\"1:1-1:45\">before $$a_1$$ middle $$b_2$$ after</p>\n",
	},
	mathEscapedUnderscore: {
		markdown: "$$x\\_y_z$$\n",
		html: "<p data-sourcepos=\"1:1-1:12\">$$x\\_y_z$$</p>\n",
	},
	mathEmphasisOutsideStillWorks: {
		markdown: "_emphasis_ then $$p_1 + q_2$$ then _more_\n",
		html: "<p data-sourcepos=\"1:1-1:40\"><em data-sourcepos=\"1:1-1:10\">emphasis</em> then $$p_1 + q_2$$ then <em data-sourcepos=\"1:35-1:40\">more</em></p>\n",
	},
	mathInsideListItem: {
		markdown: "- $$u_1 + v_2$$\n",
		html: "<ul data-sourcepos=\"1:1-1:14\">\n<li data-sourcepos=\"1:1-1:14\">$$u_1 + v_2$$</li>\n</ul>\n",
	},
	// --- protocol 3 — heading ids and fold anchors (#371) ---
	headingPunctuation: {
		markdown: "## Hello, World!\n",
		html: "<h2 id=\"hello-world\" data-sourcepos=\"1:1-1:16\">Hello, World!<a href=\"#hello-world\" aria-label=\"Link to heading 'Hello, World!'\" data-heading-content=\"Hello, World!\" class=\"anchor\"></a></h2>\n",
	},
	headingDuplicates: {
		markdown: "# Title\n\nfirst\n\n# Title\n\nsecond\n\n# Title\n\nthird\n",
		html: "<h1 id=\"title\" data-sourcepos=\"1:1-1:7\">Title<a href=\"#title\" aria-label=\"Link to heading 'Title'\" data-heading-content=\"Title\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"3:1-3:5\">first</p>\n<h1 id=\"title-1\" data-sourcepos=\"5:1-5:7\">Title<a href=\"#title-1\" aria-label=\"Link to heading 'Title'\" data-heading-content=\"Title\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"7:1-7:6\">second</p>\n<h1 id=\"title-2\" data-sourcepos=\"9:1-9:7\">Title<a href=\"#title-2\" aria-label=\"Link to heading 'Title'\" data-heading-content=\"Title\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"11:1-11:5\">third</p>\n",
	},
	headingChinese: {
		markdown: "## 中文标题\n",
		html: "<h2 id=\"中文标题\" data-sourcepos=\"1:1-1:15\">中文标题<a href=\"#中文标题\" aria-label=\"Link to heading '中文标题'\" data-heading-content=\"中文标题\" class=\"anchor\"></a></h2>\n",
	},
	headingNumericDot: {
		markdown: "## 1. 概述\n",
		html: "<h2 id=\"1-概述\" data-sourcepos=\"1:1-1:12\">1. 概述<a href=\"#1-概述\" aria-label=\"Link to heading '1. 概述'\" data-heading-content=\"1. 概述\" class=\"anchor\"></a></h2>\n",
	},
	headingApostrophe: {
		markdown: "## Ticks aren't in\n",
		html: "<h2 id=\"ticks-arent-in\" data-sourcepos=\"1:1-1:18\">Ticks aren't in<a href=\"#ticks-arent-in\" aria-label=\"Link to heading 'Ticks aren't in'\" data-heading-content=\"Ticks aren't in\" class=\"anchor\"></a></h2>\n",
	},
	headingUnderscore: {
		markdown: "## under_score here\n",
		html: "<h2 id=\"under_score-here\" data-sourcepos=\"1:1-1:19\">under_score here<a href=\"#under_score-here\" aria-label=\"Link to heading 'under_score here'\" data-heading-content=\"under_score here\" class=\"anchor\"></a></h2>\n",
	},
	headingNesting: {
		markdown: "# A\n\nbody a\n\n## B\n\nbody b\n\n# C\n\nbody c\n",
		html: "<h1 id=\"a\" data-sourcepos=\"1:1-1:3\">A<a href=\"#a\" aria-label=\"Link to heading 'A'\" data-heading-content=\"A\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"3:1-3:6\">body a</p>\n<h2 id=\"b\" data-sourcepos=\"5:1-5:4\">B<a href=\"#b\" aria-label=\"Link to heading 'B'\" data-heading-content=\"B\" class=\"anchor\"></a></h2>\n<p data-sourcepos=\"7:1-7:6\">body b</p>\n<h1 id=\"c\" data-sourcepos=\"9:1-9:3\">C<a href=\"#c\" aria-label=\"Link to heading 'C'\" data-heading-content=\"C\" class=\"anchor\"></a></h1>\n<p data-sourcepos=\"11:1-11:6\">body c</p>\n",
	},
	// --- protocol 4 — raw HTML checkboxes are not markdown tasks (#319) ---
	rawCheckboxListItem: {
		markdown: "- <input type=\"checkbox\" /> raw control\n",
		html: "<ul data-sourcepos=\"1:1-1:39\">\n<li data-sourcepos=\"1:1-1:39\"><input type=\"checkbox\" /> raw control</li>\n</ul>\n",
	},
	rawCheckboxDisabled: {
		markdown: "- <input type=\"checkbox\" disabled=\"\" /> raw disabled control\n",
		html: "<ul data-sourcepos=\"1:1-1:60\">\n<li data-sourcepos=\"1:1-1:60\"><input type=\"checkbox\" disabled=\"\" /> raw disabled control</li>\n</ul>\n",
	},
	rawCheckboxHtmlList: {
		markdown: "<ul>\n<li><input type=\"checkbox\" disabled=\"\" /> hand written</li>\n</ul>\n",
		html: "<ul>\n<li><input type=\"checkbox\" disabled=\"\" /> hand written</li>\n</ul>\n",
	},
	rawCheckboxMixedWithTask: {
		markdown: "- [ ] real task\n- <input type=\"checkbox\" /> raw control\n",
		html: "<ul data-sourcepos=\"1:1-2:39\">\n<li data-sourcepos=\"1:1-1:15\"><input type=\"checkbox\" data-task-checkbox=\"\" disabled=\"\" /> real task</li>\n<li data-sourcepos=\"2:1-2:39\"><input type=\"checkbox\" /> raw control</li>\n</ul>\n",
	},
	rawCheckboxParagraph: {
		markdown: "A paragraph with <input type=\"checkbox\" /> inline.\n",
		html: "<p data-sourcepos=\"1:1-1:50\">A paragraph with <input type=\"checkbox\" /> inline.</p>\n",
	},

	// --- protocol 5 — media substitutions keep their source range ---
	videoImage: {
		markdown: "![clip](clip.mp4)\n",
		html: "<p data-sourcepos=\"1:1-1:17\"><img data-sourcepos=\"1:1-1:17\" src=\"clip.mp4\" alt=\"clip\" /></p>\n",
	},
	videoImageSurrounded: {
		markdown: "Intro paragraph.\n\n![clip](clip.mp4)\n\nTrailing prose.\n",
		html: "<p data-sourcepos=\"1:1-1:16\">Intro paragraph.</p>\n<p data-sourcepos=\"3:1-3:17\"><img data-sourcepos=\"3:1-3:17\" src=\"clip.mp4\" alt=\"clip\" /></p>\n<p data-sourcepos=\"5:1-5:15\">Trailing prose.</p>\n",
	},
	audioImage: {
		markdown: "![take](take.mp3)\n",
		html: "<p data-sourcepos=\"1:1-1:17\"><img data-sourcepos=\"1:1-1:17\" src=\"take.mp3\" alt=\"take\" /></p>\n",
	},
	youtubeImage: {
		markdown: "![demo](https://youtu.be/dQw4w9WgXcQ)\n",
		html: "<p data-sourcepos=\"1:1-1:37\"><img data-sourcepos=\"1:1-1:37\" src=\"https://youtu.be/dQw4w9WgXcQ\" alt=\"demo\" /></p>\n",
	},
	youtubeLink: {
		markdown: "[demo](https://youtu.be/dQw4w9WgXcQ)\n",
		html: "<p data-sourcepos=\"1:1-1:36\"><a data-sourcepos=\"1:1-1:36\" href=\"https://youtu.be/dQw4w9WgXcQ\">demo</a></p>\n",
	},
} as const satisfies Record<string, RenderFixture>;
