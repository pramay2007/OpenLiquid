import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import { useStore } from "../state/store";

// The whitepaper is the Markdown in docs/whitepaper, the same files GitHub renders. One source,
// two readers.
const files = import.meta.glob<string>("../../../docs/whitepaper/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface DocPage {
  slug: string;
  file: string;
  title: string;
  html: string;
}

const PAGES: DocPage[] = Object.entries(files)
  .filter(([path]) => !path.endsWith("README.md"))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, source]) => {
    const file = path.split("/").pop()!;
    return {
      file,
      slug: file.replace(/^\d+-/, "").replace(/\.md$/, ""),
      title: /^#\s+(.+)$/m.exec(source)?.[1] ?? file,
      html: marked.parse(source, { gfm: true, async: false }),
    };
  });

export function DocsPage() {
  const slug = useStore((s) => s.doc);
  const openDoc = useStore((s) => s.openDoc);
  const index = Math.max(0, PAGES.findIndex((p) => p.slug === slug));
  const page = PAGES[index];
  const body = useRef<HTMLElement>(null);
  const html = useMemo(() => ({ __html: page?.html ?? "" }), [page]);

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [page]);

  if (!page) return null;
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];

  // Links between whitepaper pages are written as file names so they work on GitHub; here they
  // switch pages. Anything else opens in a new tab.
  function onClick(ev: React.MouseEvent) {
    const a = (ev.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    const target = PAGES.find((p) => href.split("#")[0] === p.file);
    ev.preventDefault();
    if (target) openDoc(target.slug);
    else if (/^https?:/.test(href)) window.open(href, "_blank", "noopener");
  }

  return (
    <main className="docs" ref={body}>
      <nav className="docs-nav" aria-label="Whitepaper">
        <div className="eyebrow">Whitepaper</div>
        {PAGES.map((p, i) => (
          <button key={p.slug} aria-current={i === index ? "page" : undefined} onClick={() => openDoc(p.slug)}>
            <span className="n">{String(i + 1).padStart(2, "0")}</span>
            {p.title}
          </button>
        ))}
      </nav>
      <article className="docs-body">
        <div className="prose" onClick={onClick} dangerouslySetInnerHTML={html} />
        <div className="docs-pager">
          {prev ? (
            <button onClick={() => openDoc(prev.slug)}>
              <span>Previous</span>
              {prev.title}
            </button>
          ) : (
            <i />
          )}
          {next && (
            <button className="next" onClick={() => openDoc(next.slug)}>
              <span>Next</span>
              {next.title}
            </button>
          )}
        </div>
      </article>
    </main>
  );
}
