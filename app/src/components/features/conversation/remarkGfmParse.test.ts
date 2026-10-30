// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import remarkGfmParse from "./remarkGfmParse.ts";

const SAMPLES = [
  "| a | b |\n|:--|--:|\n| 1 | **2** |\n| `x` | ~~y~~ |",
  "- [x] done\n- [ ] todo\n  - nested",
  "see https://example.com/path?q=1 and www.example.org, mail me@example.com",
  "text with footnote[^1].\n\n[^1]: the note",
  "~one~ ~~two~~ ~~~three~~~",
  "```python\nprint('x')\n```\n\n> quote | not a table",
  "| only header |\n|---|",
];

const render = (text: string, plugin: unknown) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [plugin as never] }, text));

describe("remarkGfmParse", () => {
  it.each(SAMPLES)("renders exactly like remark-gfm: %s", (text) => {
    expect(render(text, remarkGfmParse)).toBe(render(text, remarkGfm));
  });
});
