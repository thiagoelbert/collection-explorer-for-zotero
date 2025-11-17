export function getDocument(): Document {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Main window not available");
  return win.document;
}

export function getPane(): any {
  return Zotero.getActiveZoteroPane();
}

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
  `;
  const head = doc.head || doc.querySelector("head") || doc.documentElement;
  if (!head) return;
  head.appendChild(style);
}
