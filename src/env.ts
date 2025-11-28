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
  if (doc.getElementById("zfe-folder-row-style")) return;
  const style = doc.createElement("style");
  style.id = "zfe-folder-row-style";
  style.textContent = `
    .zfe-folder-row {
      transition: background-color 120ms ease, color 120ms ease;
    }
    .zfe-folder-row--dragover {
      background-color: #e6f0ff;
      box-shadow: inset 0 0 0 1px #5c8df6;
    }
    [data-zfe-items-body] [role="row"] {
      cursor: default;
    }
    #zotero-items-tree[data-zfe-flip="1"] .virtualized-table .row.even:not(.selected):not(.zfe-folder-row) {
      background-color: var(--material-stripe) !important;
    }
    #zotero-items-tree[data-zfe-flip="1"] .virtualized-table .row.odd:not(.selected):not(.zfe-folder-row) {
      background-color: var(--material-background) !important;
    }
    .zfe-folder-row:focus,
    .zfe-folder-row:focus-visible {
      outline: none;
      box-shadow: none;
    }
  `;
  const head = doc.head || doc.querySelector("head") || doc.documentElement;
  if (!head) return;
  head.appendChild(style);
}
