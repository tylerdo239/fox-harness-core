// remark-gfm's parsing half (tables, strikethrough, task lists, autolinks, footnotes) — the same two extensions
// remark-gfm 4 registers, minus its markdown *serializer* (`gfmToMarkdown`): react-markdown only ever parses, and the
// serializer pulled mdast-util-to-markdown into the first-load bundle (docs/ui-performance-plan.md §7). Same parse,
// same output; remarkGfmParse.test.ts compares it with remark-gfm itself.
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm, type Options } from "micromark-extension-gfm";

// `this` is the unified processor; only its data store is used.
export default function remarkGfmParse(this: { data(): unknown }, options?: Options): void {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.micromarkExtensions.push(gfm(options ?? {}));
  data.fromMarkdownExtensions.push(gfmFromMarkdown());
}
