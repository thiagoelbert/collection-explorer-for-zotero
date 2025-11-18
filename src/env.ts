/**
 * Convenience wrapper that returns Zotero's main window document,
 * throwing early if the UI is not yet ready.
 */
export function getDocument(): Document {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Main window not available");
  return win.document;
}

/**
 * Returns the active Zotero pane so call sites don't have to guard every access.
 */
export function getPane(): any {
  return Zotero.getActiveZoteroPane();
}

/**
 * Injects a stylesheet containing the shared look-and-feel for our synthetic folder rows.
 * Only runs once per window (identified by the style element ID).
 */
export function ensureGlobalStyles(doc: Document) {
  if (doc.getElementById("thiago-folder-row-style")) return;
  const style = doc.createElement("style");
  style.id = "thiago-folder-row-style";
  style.textContent = `
    .thiago-folder-row {
      transition: background-color 120ms ease, color 120ms ease;
    }
    [data-thiago-items-body] [role="row"] {
      cursor: default;
    }
    #zotero-items-tree[data-thiago-flip="1"] .virtualized-table .row.even:not(.selected) {
      background-color: var(--material-stripe) !important;
    }
    #zotero-items-tree[data-thiago-flip="1"] .virtualized-table .row.odd:not(.selected) {
      background-color: var(--material-background) !important;
    }
    .thiago-folder-row:focus,
    .thiago-folder-row:focus-visible {
      outline: none;
      box-shadow: none;
    }
  `;
  const head = doc.head || doc.querySelector("head") || doc.documentElement;
  if (!head) return;
  head.appendChild(style);
}
