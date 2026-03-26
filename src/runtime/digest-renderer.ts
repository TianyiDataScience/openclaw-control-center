import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIGEST_DIR = join(process.cwd(), "runtime", "digests");

export interface LatestDigest {
  generatedAt: string;
  date?: string;
  path?: string;
  markdown?: string;
  html?: string;
}

export async function loadLatestDigest(): Promise<LatestDigest> {
  const generatedAt = new Date().toISOString();

  try {
    const files = await readdir(DIGEST_DIR);
    const latest = files
      .filter((name) => name.endsWith(".md"))
      .sort((a, b) => b.localeCompare(a))[0];

    if (!latest) {
      return { generatedAt };
    }

    const path = join(DIGEST_DIR, latest);
    const markdown = await readFile(path, "utf8");

    return {
      generatedAt,
      date: latest.slice(0, -3),
      path,
      markdown,
      html: renderMarkdownDigest(markdown),
    };
  } catch {
    return { generatedAt };
  }
}

export function renderLatestDigestPage(digest: LatestDigest): string {
  if (!digest.markdown || !digest.html) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Digest Latest</title>
  <style>
    body { font-family: "SF Mono", Menlo, monospace; background: #0b1016; color: #d6e7f9; margin: 0; padding: 16px; }
    .meta { color: #93aac2; font-size: 12px; }
    a { color: #7dd3fc; }
    .card { margin-top: 10px; border: 1px solid #27405a; border-radius: 8px; padding: 12px; background: #111923; }
    @media (max-width: 740px) { body { padding: 12px; } }
  </style>
</head>
<body>
  <h1>Latest Digest</h1>
  <div class="meta">generatedAt=${escapeHtml(digest.generatedAt)} | status=missing</div>
  <div class="card">No digest markdown found in <code>${escapeHtml(DIGEST_DIR)}</code>.</div>
  <p class="meta"><a href="/">home</a></p>
</body>
</html>`;
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Digest ${escapeHtml(digest.date ?? "latest")}</title>
  <style>
    body { font-family: "SF Mono", Menlo, monospace; background: #0b1016; color: #d6e7f9; margin: 0; padding: 16px; }
    .meta { color: #93aac2; font-size: 12px; }
    a { color: #7dd3fc; }
    .card { margin-top: 10px; border: 1px solid #27405a; border-radius: 8px; padding: 12px; background: #111923; }
    h1,h2,h3 { margin: 0; }
    h2,h3 { margin-top: 14px; }
    p { margin: 8px 0; }
    ul { margin: 8px 0 8px 18px; padding: 0; }
    code { color: #9bd5ff; }
    @media (max-width: 740px) { body { padding: 12px; } }
  </style>
</head>
<body>
  <h1>Latest Digest</h1>
  <div class="meta">date=${escapeHtml(digest.date ?? "unknown")} | generatedAt=${escapeHtml(digest.generatedAt)}</div>
  <div class="meta">source=${escapeHtml(digest.path ?? "n/a")}</div>
  <div class="card">${digest.html}</div>
  <p class="meta"><a href="/">home</a></p>
</body>
</html>`;
}

function renderMarkdownDigest(markdown: string): string {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let inList = false;

  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    if (trimmed.startsWith("### ")) {
      closeList();
      out.push(`<h3>${renderInline(trimmed.slice(4))}</h3>`);
      continue;
    }

    if (trimmed.startsWith("## ")) {
      closeList();
      out.push(`<h2>${renderInline(trimmed.slice(3))}</h2>`);
      continue;
    }

    if (trimmed.startsWith("# ")) {
      closeList();
      out.push(`<h1>${renderInline(trimmed.slice(2))}</h1>`);
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInline(trimmed.slice(2))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${renderInline(trimmed)}</p>`);
  }

  closeList();
  return out.join("\n");
}

function renderInline(input: string): string {
  const escaped = escapeHtml(input);
  return escaped.replace(/`([^`]+)`/g, (_match, group) => `<code>${group}</code>`);
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
