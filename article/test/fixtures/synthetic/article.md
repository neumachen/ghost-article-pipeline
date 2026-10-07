---
id: synthetic-fixture
title: The synthetic fixture article
slug: synthetic-fixture
status: published
authors: []
excerpt: A representative synthetic article exercising every construct the pipeline must carry to Ghost.
tags:
  - Demo
  - Self-hosting
feature_image: assets/cover.png
---

# The synthetic fixture article

A paragraph with a [link to the repo](https://github.com/neumachen/neumachen.dev) and some `inline code`, plus **bold** and *italic* text.

## Prose that is not ASCII

An article is not ASCII with punctuation bolted on: café, naïve, résumé, Zürich
and São Paulo are ordinary words, and an editor reaches for an em dash — not a
hyphen — an en dash in a range like 1–10, “double curly quotes”, ‘single curly
quotes’, and an ellipsis… The public page serves these as UTF-8, so a client
that decodes the response as anything else shows mojibake where they belong.

## Inline formatting the renderer supports

**Bold**, *italic*, `inline code`, ~~struck through~~, and a
[link with a title](https://example.invalid/titled "The title attribute") —
nested as ***bold italic*** and as `code with **stars** inside`.

## A second-level heading

### A third-level heading

A fenced code block whose whitespace is meaningful — the indentation IS the
Python, and the block quotes HTML literally:

```python
def publish(candidate):
    if candidate.status == "published":
        return send(candidate)
    return hold(candidate)
```

A fenced block that holds image markup as an EXAMPLE. Neither `src` below is
an asset this article carries: discovering one would make a documentation
snippet an upload and a rewrite target, and rewriting one would replace the
example with a live URL.

```html
<figure class="kg-card kg-image-card">
  <img src="assets/inside-code.png" alt="This file does not exist">
  <img src=assets/also-inside-code.png alt=Nor does this one>
</figure>
```

An inline `<img src="assets/in-inline-code.png">` example is the same case in
a `<code>` span rather than a fence.

A GFM table:

| Format | Verified | Notes |
| --- | --- | --- |
| HTML | yes | stored with Ghost's rewrites |
| Lexical | no | the admin API is asked for html |

A `-` list:

- first item
- second item

A numbered list:

1. build
2. verify
3. publish

A blockquote:

> A quoted passage that must survive Ghost's rewrite.

A block image on its own line, double-quoted:

![diagram](assets/diagram.png)

A linked image — an image inside a link, which is neither a plain image nor a
plain link and must survive as both:

[![The linked image's alt text](assets/linked.png)](https://example.invalid/linked-target)

An inline image with text on the same line, before and after it, so the image
is part of a paragraph rather than a block of its own:

Text before the inline image ![inline](assets/inline.png) and text after it.

Raw HTML the pipeline must pass through untouched, nested — a figure holding a
paragraph that holds inline formatting, which is one element and must be
wrapped as one:

<figure class="callout">
  <p>A callout written as raw HTML, with <strong>bold</strong> and a
  <a href="https://example.invalid/callout">link</a> inside it.</p>
</figure>

The same image reference in every quoting form the renderer and raw HTML can
produce — double-quoted above, single-quoted and unquoted here:

<div class="quoted"><img src='assets/unquoted.png' alt='single quoted'></div>

<div class="unquoted"><img src=assets/unquoted.png alt=unquoted></div>

A horizontal rule:

---
