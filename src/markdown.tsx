import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export const escapeMarkdown = (text: string) => text.replace(/\s+/g, " ").replace(/[\\`*{}\[\]()#+.!_|>~:/@-]/g, "\\$&");
const safeUrl = (url: string) => {
  try { return ["http:", "https:", "mailto:"].includes(new URL(url, "https://compass.archymedes.xyz").protocol) ? url : ""; }
  catch { return ""; }
};
const base: Components = {
  a: ({ href, children }) => href ? <a href={href} rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
  // Messages must not load remote images or tracking pixels automatically.
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
  table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
};
const email: Components = {
  ...base,
  p: ({ children }) => <p style={{ margin: "0 0 14px", lineHeight: 1.6 }}>{children}</p>,
  h1: ({ children }) => <h1 style={{ fontSize: 24, margin: "24px 0 12px" }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: 20, margin: "20px 0 10px" }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 17, margin: "18px 0 8px" }}>{children}</h3>,
  ul: ({ children }) => <ul style={{ paddingLeft: 24, margin: "0 0 16px" }}>{children}</ul>,
  ol: ({ children, start }) => <ol start={start} style={{ paddingLeft: 24, margin: "0 0 16px" }}>{children}</ol>,
  li: ({ children }) => <li style={{ marginBottom: 6 }}>{children}</li>,
  a: ({ href, children }) => href ? <a href={href} style={{ color: "#235fc2" }} rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
  pre: ({ children }) => <pre style={{ padding: 16, background: "#f0f1f2", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{children}</pre>,
  code: ({ children }) => <code style={{ fontFamily: "Menlo,Consolas,monospace", fontSize: "0.9em" }}>{children}</code>,
  blockquote: ({ children }) => <blockquote style={{ borderLeft: "3px solid #dadde0", paddingLeft: 16, marginLeft: 0, color: "#555" }}>{children}</blockquote>,
  table: ({ children }) => <table cellPadding={8} style={{ borderCollapse: "collapse", marginBottom: 16 }}>{children}</table>,
  th: ({ children }) => <th style={{ border: "1px solid #dadde0", textAlign: "left" }}>{children}</th>,
  td: ({ children }) => <td style={{ border: "1px solid #dadde0" }}>{children}</td>,
};
export function Markdown({ children, forEmail = false }: { children: string; forEmail?: boolean }) {
  return <div className="markdown-body" style={forEmail ? { fontFamily: "Helvetica,Arial,sans-serif", color: "#111214", fontSize: 15, lineHeight: 1.6 } : undefined}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={forEmail ? email : base}>{children}</ReactMarkdown>
  </div>;
}
