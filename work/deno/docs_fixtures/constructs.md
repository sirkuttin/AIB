---
title: Constructs test
tags: [docs, test]
---

# Constructs

Plain paragraph with **bold**, *italic*, `code`, ~~strike~~ and a [link](https://example.com "Example").
A soft-wrapped second line, __strong__ and _emphasis_, a hard break  
after two spaces, and one after a backslash\
then text. An autolink <https://example.com/x> and an escaped \*star\*.

Setext heading
==============

## Task list

- [ ] Open item
- [x] Done item
  - [ ] Nested open item

## Nested lists

1. First
   - Bullet under first
     - Deeper bullet
2. Second
   1. Sub one
   2. Sub two

* Star bullets
* stay stars

3) Paren list
4) goes on

- Loose item one

- Loose item two
  with a continuation line

## Table

| Left | Center | Right |
|:-----|:------:|------:|
| a `x\|y` | **b** | 3 |
| [l](u) | c | 4 |

## Code

```ts
const x: number = 1;
```

~~~
tilde fence, no language
~~~

    indented code

## HTML

<details>
<summary>More</summary>

Hidden text.

</details>

Line with <kbd>Ctrl</kbd>+<kbd>Z</kbd> inline.

> Quote line one
> Quote line two
>
> - a list in a quote

***

![Alt](img.png "Title") and a linked badge [![CI](https://example.com/b.svg)](https://example.com/ci)

[ref]: https://example.com/ref
