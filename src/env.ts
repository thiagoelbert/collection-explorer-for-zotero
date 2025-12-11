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
  const existing = doc.getElementById("zfe-folder-row-style") as HTMLStyleElement | null;
  const ensureFolderIconRule = (styleEl: HTMLStyleElement) => {
    if (styleEl.textContent?.includes('data-item-type="zfe-folder"')) return;
    styleEl.textContent = `${styleEl.textContent ?? ""}
    .icon-item-type[data-item-type="zfe-folder"] {
      -moz-context-properties: fill, stroke;
      fill: currentColor;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='currentColor'%3E%3Cpath d='M2 4.25a1.25 1.25 0 0 1 1.25-1.25H6l1 1h6.75A1.25 1.25 0 0 1 15 5.25v7a1.25 1.25 0 0 1-1.25 1.25h-10.5A1.25 1.25 0 0 1 2 12.25z'/%3E%3Cpath d='M2 5h12v1.25H2z' opacity='.35'/%3E%3C/svg%3E");
      background-position: center;
      background-repeat: no-repeat;
      background-size: 16px 16px;
    }
    `;
  };

  if (existing) {
    ensureFolderIconRule(existing);
    return;
  }

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
    .icon-item-type[data-item-type="zfe-folder"] {
      -moz-context-properties: fill, stroke;
      fill: currentColor;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='currentColor'%3E%3Cpath d='M2 4.25a1.25 1.25 0 0 1 1.25-1.25H6l1 1h6.75A1.25 1.25 0 0 1 15 5.25v7a1.25 1.25 0 0 1-1.25 1.25h-10.5A1.25 1.25 0 0 1 2 12.25z'/%3E%3Cpath d='M2 5h12v1.25H2z' opacity='.35'/%3E%3C/svg%3E");
      background-position: center;
      background-repeat: no-repeat;
      background-size: 16px 16px;
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
  ensureFolderIconRule(style);
  const head = doc.head || doc.querySelector("head") || doc.documentElement;
  if (!head) return;
  head.appendChild(style);
}
