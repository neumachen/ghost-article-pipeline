---
id: raw-html-fixture
title: The raw HTML fixture article
slug: raw-html-fixture
status: draft
authors: []
excerpt: A fixture exercising nested raw HTML and every src quoting form the pipeline must discover and rewrite.
tags:
  - Demo
feature_image: assets/cover.png
---

# The raw HTML fixture article

A paragraph with an ordinary image, a heading and a link, so the renderer-emitted markup sits beside the raw HTML below.

![diagram](assets/diagram.png)

Nested raw HTML the pipeline must wrap as ONE whole element, inline children and nesting intact:

<figure class="callout"><p>text with <strong>bold</strong></p></figure>

Every src quoting form, one raw element each:

<div class="quoted"><img src="assets/cover.png" alt="double quoted"></div>

<div class="single"><img src='assets/diagram.png' alt="single quoted"></div>

<div class="unquoted"><img src=assets/diagram.png alt="unquoted"></div>

A raw element whose src is a complete prefix of another, longer path, so a substring rewrite would corrupt it:

<div class="prefix"><img src=assets/diagram.png alt="a ref that is a prefix of a longer path"></div>
