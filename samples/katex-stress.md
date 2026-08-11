# KaTeX stress

A manual fixture for the one part of maths rendering no automated test reaches.
The suite checks that the export machinery *finds* KaTeX's fonts; nothing in it
renders a formula, so nothing in it can tell you a formula came out wrong.

Open this after a KaTeX upgrade, or after touching preview styling or PDF
export. Three things to look at, in order of how likely they are to be wrong:

1. **Fonts.** Variables italic serif, operators upright, `\mathbb` and
   `\mathcal` visibly unlike plain letters. A family that failed to load falls
   back to Times or the UI font, which is obvious once you are looking for it.
2. **Spacing and stacking.** Fractions, roots, matrices, big operators with
   limits above and below. A styling rule that stopped applying shows up as
   collapsed or overlapping layout rather than as an error.
3. **Export to PDF.** `src/lib/utils/exportFonts.ts` reads `katex.min.css` and
   subsets the KaTeX faces into the exported file. **Export this document and
   read the maths in the PDF**, not only on screen — the two can disagree.

KaTeX 0.18.0 renamed its internal CSS classes, which is the shape of upgrade
this exists for: everything still parses, and the result can still be wrong.

---

## 1 Inline, in running text

The mass–energy relation $E = mc^2$ sits inline, as does a fraction
$\tfrac{1}{2}$, a root $\sqrt{2}$, a subscript $x_i$, a superscript $x^2$, and
a combined $x_i^{2}$. Greek runs inline too: $\alpha\beta\gamma\delta\epsilon$,
$\Gamma\Delta\Theta\Lambda\Xi\Pi\Sigma\Phi\Psi\Omega$.

Inline next to **bold text $a+b$ inside bold**, and *italic with $c+d$ inside*.
A `code span` then $e+f$ then more text. Punctuation right after maths: $g$,
$h$. and $i$; and $j$?

Two dollars that are not maths: costs \$5 and \$10. A single `$` alone.

## 2 Display, one per block

$$
E = mc^2
$$

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$

$$
\lim_{x \to 0} \frac{\sin x}{x} = 1
\qquad
\prod_{i=1}^{n} i = n!
$$

## 3 Fonts — the check that matters most

$$
\mathrm{upright} \quad \mathit{italic} \quad \mathbf{bold} \quad
\mathsf{sans} \quad \mathtt{mono} \quad \mathcal{ABCDEFG} \quad
\mathbb{ABCDEFGHIJKLMNOPQRSTUVWXYZ} \quad \mathfrak{ABCDEFG}
$$

$$
\text{Roman text inside maths, with a variable } x \text{ between words.}
$$

Each of those eight should look **visibly different from the others**. If two
collapse to the same face, a font family did not make it.

## 4 Structure — stacking, spacing, delimiters

$$
\frac{\displaystyle\frac{a}{b}}{\displaystyle\frac{c}{d}}
\qquad
\sqrt{\sqrt{\sqrt{x}}}
\qquad
x^{y^{z^{w}}}
$$

$$
\left( \frac{1}{2} \right)
\left[ \frac{1}{2} \right]
\left\{ \frac{1}{2} \right\}
\left| \frac{1}{2} \right|
\left\| \frac{1}{2} \right\|
\left\langle \frac{1}{2} \right\rangle
\left\lceil \frac{1}{2} \right\rceil
\left\lfloor \frac{1}{2} \right\rfloor
$$

Delimiters must grow with their contents. If they stay small next to a tall
fraction, the sizing rules did not apply.

## 5 Matrices and arrays

$$
\begin{pmatrix} a & b \\ c & d \end{pmatrix}
\begin{bmatrix} a & b \\ c & d \end{bmatrix}
\begin{vmatrix} a & b \\ c & d \end{vmatrix}
\begin{Bmatrix} a & b \\ c & d \end{Bmatrix}
$$

$$
A = \begin{pmatrix}
a_{11} & a_{12} & \cdots & a_{1n} \\
a_{21} & a_{22} & \cdots & a_{2n} \\
\vdots & \vdots & \ddots & \vdots \\
a_{m1} & a_{m2} & \cdots & a_{mn}
\end{pmatrix}
$$

## 6 Aligned environments

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0 \\
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0\mathbf{J} + \mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}
\end{aligned}
$$

$$
\begin{cases}
x + y = 1 & \text{if } x > 0 \\
x - y = 2 & \text{otherwise}
\end{cases}
$$

The `&` columns must line up. This is the shape #197 was about — multi-line
aligned vector calculus — so it is worth a second look.

## 7 Accents, arrows, operators

$$
\hat{a} \; \bar{b} \; \vec{c} \; \dot{d} \; \ddot{e} \; \tilde{f} \; \check{g}
\; \breve{h} \; \acute{i} \; \grave{j} \; \mathring{k} \; \widehat{lmn} \;
\overline{opq} \; \underline{rst} \; \overrightarrow{uvw}
$$

$$
\to \gets \leftrightarrow \Rightarrow \Leftarrow \Leftrightarrow \mapsto
\longmapsto \rightharpoonup \rightleftharpoons \nearrow \searrow \swarrow \nwarrow
$$

$$
\leq \geq \neq \approx \equiv \sim \simeq \cong \propto \parallel \perp
\subset \subseteq \supset \supseteq \in \notin \cup \cap \setminus
\forall \exists \nexists \emptyset \infty \partial \nabla \pm \mp \times \div
$$

## 8 Over- and under-set limits

$$
\overbrace{a + b + c}^{\text{three terms}}
\qquad
\underbrace{x + y + z}_{\text{also three}}
$$

$$
\lim_{n \to \infty} \quad \max_{x \in S} \quad \operatorname*{argmin}_{\theta} \quad
\bigcup_{i=1}^{n} \quad \bigcap_{i=1}^{n} \quad \bigoplus_{i} \quad \iint_D \quad \oint_C
$$

## 9 Long line — does it scroll or overflow?

$$
f(x) = a_0 + a_1x + a_2x^2 + a_3x^3 + a_4x^4 + a_5x^5 + a_6x^6 + a_7x^7 + a_8x^8 + a_9x^9 + a_{10}x^{10} + a_{11}x^{11} + a_{12}x^{12} + a_{13}x^{13} + a_{14}x^{14}
$$

A display wider than the pane should scroll inside its own box rather than push
the page sideways. Check this in the exported PDF too — that is where an
overflow becomes a clipped formula instead of a scrollbar.

## 10 Maths inside other things

> A blockquote with display maths inside it:
>
> $$
> \oint_{\partial \Sigma} \mathbf{B} \cdot d\boldsymbol{\ell} = \mu_0 I
> $$

1. A list item with inline $\alpha$ and a display below it:

   $$
   \frac{\partial u}{\partial t} = \alpha \frac{\partial^2 u}{\partial x^2}
   $$

2. Another item, $\beta$, to check the list keeps its numbering.

| formula | meaning |
|---|---|
| $e^{i\pi} + 1 = 0$ | Euler's identity |
| $\sum_{k=0}^{n} \binom{n}{k} = 2^n$ | binomial sum |
| $\det(A - \lambda I) = 0$ | characteristic equation |

- [ ] A task item with maths: $\nabla^2 \phi = 0$
- [x] A ticked one: $\hbar = \frac{h}{2\pi}$

The two task items are a pair on purpose: a ticked item is struck through, and
the strikethrough must not swallow or squash the formula beside it. Compare the
two lines against each other rather than judging the second one alone.

## 11 CJK next to maths

中文里的行内公式 $a^2 + b^2 = c^2$ 紧挨着汉字，前后都不加空格。

日本語の $\int_0^1 x\,dx = \frac12$ も同様に。

한국어 문장 안의 $\lim_{n\to\infty} a_n = L$ 도 확인.

Full-width punctuation right after maths: $x$。$y$，$z$、

## 12 Things that should NOT render as maths

Not maths: `$100 + $200`. In a code fence:

```
$$
this must stay literal
$$
```

Escaped: \$x^2\$ should print dollars and a caret, not a superscript.

## 13 Deliberately broken — should show an error, not vanish

$$
\frac{1}{
$$

$$
\undefinedmacro{x}
$$

Both should render KaTeX's error state — red, in place — rather than
disappearing silently or taking the rest of the document with them.
