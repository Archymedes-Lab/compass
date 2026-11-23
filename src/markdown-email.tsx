import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.tsx";

export function markdownEmail(text: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fcfcfa">'
    + renderToStaticMarkup(<Markdown forEmail>{text}</Markdown>) + "</body></html>";
}
