/**
 * Auto-escaping HTML templating.
 *
 * The previous email script interpolated `${item.title}`, `${item.url}` and
 * `${item.summary}` straight from third-party RSS into HTML. That is an
 * injection sink, and hand-escaping each call site is the kind of fix that
 * lasts until the next edit. Here escaping is the default and opting out
 * requires typing `raw()`, so the unsafe path is the loud one.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Blocks `javascript:` and `data:` hrefs a hostile feed could smuggle in. */
export function safeUrl(url: unknown): string {
  const value = String(url ?? "");
  return /^https?:\/\//i.test(value) ? escapeHtml(value) : "#";
}

export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): Raw {
  return new Raw(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = "";
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index >= values.length) return;
    const value = values[index];
    if (value instanceof Raw) out += value.value;
    else if (Array.isArray(value)) {
      out += value.map((entry) => (entry instanceof Raw ? entry.value : escapeHtml(entry))).join("");
    } else if (value === null || value === undefined || value === false) out += "";
    else out += escapeHtml(value);
  });
  return new Raw(out);
}
