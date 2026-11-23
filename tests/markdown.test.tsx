import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, escapeMarkdown } from "../src/markdown.tsx";
import { markdownEmail } from "../src/markdown-email.tsx";
import { scrub } from "../src/projects.ts";

const sample = "## Release review\n\nA **clear** update with `inline code`.\n\n1. Read the report\n2. Check the build\n\n- [x] Review complete\n- [ ] Deploy\n\n> Waiting for approval\n\n```ts\nconst ready = true;\n  console.log(ready);\n```\n\n| Task | State |\n| --- | --- |\n| Review | Done |\n\n[Open Compass](https://compass.archymedes.xyz/#conversation)";
test("chat renders headings, emphasis, lists, tasks, quotes, code, tables and links", () => {
  const html = renderToStaticMarkup(<Markdown>{sample}</Markdown>);
  for (const expected of ["<h2>Release review</h2>", "<strong>clear</strong>", "<code>inline code</code>", "<ol>", "<li>Read the report</li>", 'type="checkbox"', "<blockquote>", '<code class="language-ts">', "const ready = true;\n  console.log(ready);", '<div class="markdown-table"><table>', "<th>Task</th>", 'href="https://compass.archymedes.xyz/#conversation"']) expect(html).toContain(expected);
});
test("HTML, unsafe links and automatic image requests are excluded in chat and email", () => {
  const source = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n![Tracking](https://tracker.example/pixel)\n\n[unsafe](data:text/html,hello)';
  for (const html of [renderToStaticMarkup(<Markdown>{source}</Markdown>), markdownEmail(source)]) {
    expect(html).not.toContain("<script"); expect(html).not.toContain("<img"); expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:"); expect(html).not.toContain("data:text/html"); expect(html).not.toContain("tracker.example");
    expect(html).toContain("[Image: Tracking]");
  }
});
test("email uses the same Markdown semantics with inline presentation styles", () => {
  const html = markdownEmail(sample);
  expect(html).toContain("<!doctype html>"); expect(html).toContain("<strong>clear</strong>");
  expect(html).toContain('border-collapse:collapse'); expect(html).toContain('white-space:pre-wrap');
  expect(html).toContain("<th style="); expect(html).toContain("<li style=");
});
test("relative and anchor links work while encoded script schemes remain blocked", () => {
  const html = renderToStaticMarkup(<Markdown>{"[Guide](docs/guide.md) [Tasks](#tasks) [bad](javascript&#58;alert%281%29)"}</Markdown>);
  expect(html).toContain('href="docs/guide.md"'); expect(html).toContain('href="#tasks"'); expect(html).not.toContain("javascript:");
});
test("conversation scrubbing retains Markdown whitespace and still redacts multiline secrets", () => {
  const source = sample + "\n\n-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----";
  expect(scrub(source, 12000, true)).toBe(sample + "\n\n[redacted]");
  expect(scrub("a\n\n  b")).toBe("a b");
  expect(scrub("line\r\n\r\nnext", 12000, true)).toBe("line\n\nnext");
});
test("saved task titles cannot inject masked links, emphasis or extra list items", () => {
  const title = "[deploy](https://untrusted.example) **now**\n- extra";
  const html = renderToStaticMarkup(<Markdown>{`**Saved changes:**\n\n- ${escapeMarkdown(title)}`}</Markdown>);
  expect(html).not.toContain(">deploy</a>"); expect(html).not.toContain("<strong>now</strong>");
  expect(html.match(/<li>/g)).toHaveLength(1);
});
