import { BasicTool } from "zotero-plugin-toolkit";

/**
 * Clean build:
 * - No top "bar" UI at all.
 * - Only folder-like rows injected at top of the items list.
 * - Debounced re-render on collection changes for stability.
 */

class Hooks {
  static async onStartup() {
    const ADDON_NAME = "Zotero File Explorer";
    ztoolkit.log("Plugin starting...");

    await Zotero.uiReadyPromise;
    ztoolkit.log("UI ready");

    // (Optional) Quick test menu
    ztoolkit.Menu.register("menuTools", {
      tag: "menuitem",
      id: "zotero-plugin-hello",
      label: "Hello from MyPlugin",
      commandListener: () => {
        new ztoolkit.ProgressWindow(ADDON_NAME)
          .createLine({ text: "Hello from MyPlugin!", type: "success" })
          .show();
        debugCurrentState();
      },
    });

    // Let Zotero settle a tick and render
    await Zotero.Promise.delay(400);
    scheduleRerender(10);
    setupCollectionChangeListener();
  }

  static onShutdown(): void {
    ztoolkit.unregisterAll();
    removeFolderRows();
    teardownCollectionChangeListener();
    if (rerenderTimer) {
      clearTimeout(rerenderTimer);
      rerenderTimer = null;
    }
    cancelScheduledFrame();
    renderInFlight = false;
  }

  static onMainWindowLoad(): void { }
  static onMainWindowUnload(): void { }
  static async onDialogLaunch() { }
}

// ========== STATE / GLOBALS ==========

const FOLDER_ROW_SELECTED_BG_ACTIVE = "#4072e5";
const FOLDER_ROW_SELECTED_COLOR_ACTIVE = "#fff";
const FOLDER_ROW_HOVER_BG = "rgba(64, 114, 229, 0.08)";

type FolderRowEntry = {
  key: string;
  collectionID: number;
  name: string;
  childCount: number;
};

type FolderRowIntegrationState = {
  rows: FolderRowEntry[];
  selectedIndex: number | null;
};

type VirtualizedTablePatchState = {
  orig: Record<string, any>;
};

const folderRowState = new WeakMap<any, FolderRowIntegrationState>();
const vtablePatchState = new WeakMap<any, VirtualizedTablePatchState>();

let lastRenderedCollectionID: number | null = null;
let checkInterval: any = null;
let collectionSelectCleanup: (() => void) | null = null;
let collectionSelectionRestore: (() => void) | null = null;
let rerenderTimer: number | null = null;
let rafHandle: number | null = null;
let renderInFlight = false;

// ========== UTILS ==========

function getDocument(): Document {
  const win = Zotero.getMainWindow();
  if (!win) throw new Error("Main window not available");
  return win.document;
}

function getPane(): any {
  return Zotero.getActiveZoteroPane();
}

function ensureGlobalStyles(doc: Document) {
  if (doc.getElementById("thiago-folder-row-style")) return;
  const style = doc.createElement("style");
  style.id = "thiago-folder-row-style";
  style.textContent = `
    .thiago-folder-row {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 28px;
      padding: 0 6px;
      border-radius: 4px;
      user-select: none;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .thiago-folder-row .cell {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      color: inherit;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thiago-folder-row__icon {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      background: currentColor;
      display: inline-block;
    }
    .thiago-folder-row__label {
      font-weight: 600;
    }
    .thiago-folder-row__meta {
      font-size: 11px;
      color: #666;
    }
    .thiago-folder-row--selected {
      background: ${FOLDER_ROW_SELECTED_BG_ACTIVE};
      color: ${FOLDER_ROW_SELECTED_COLOR_ACTIVE};
    }
    .thiago-folder-row:not(.thiago-folder-row--selected):hover {
      background: ${FOLDER_ROW_HOVER_BG};
    }
  `;
  const head = doc.head || doc.querySelector("head") || doc.documentElement;
  if (!head) return;
  head.appendChild(style);
}

// ========== FOLDER ROW INTEGRATION ==========

function getItemTree(): any | null {
  const pane = getPane();
  return pane?.itemsView || null;
}

function getFolderState(tree: any | null, create = true): FolderRowIntegrationState | null {
  if (!tree) return null;
  let state = folderRowState.get(tree);
  if (!state && create) {
    state = { rows: [], selectedIndex: null };
    folderRowState.set(tree, state);
  }
  return state ?? null;
}

function getFolderRows(tree: any | null): FolderRowEntry[] {
  return getFolderState(tree, false)?.rows ?? [];
}

function getFolderRowCount(tree: any | null): number {
  return getFolderRows(tree).length;
}

function setFolderRowsForTree(tree: any | null, entries: FolderRowEntry[]) {
  const state = getFolderState(tree);
  if (!state) return;
  state.rows = entries;
  state.selectedIndex = null;
}

function setFolderRowSelection(tree: any | null, folderIndex: number | null) {
  const state = getFolderState(tree, false);
  if (!state) return;
  if (state.selectedIndex === folderIndex) return;
  const vt = tree?.tree;
  const previous = state.selectedIndex;
  state.selectedIndex = folderIndex;
  if (vt?.invalidateRow) {
    if (typeof previous === "number") vt.invalidateRow(previous);
    if (typeof folderIndex === "number") vt.invalidateRow(folderIndex);
  }
}

function translateTableIndex(tree: any | null, tableIndex: number) {
  const rows = getFolderRows(tree);
  if (tableIndex >= 0 && tableIndex < rows.length) {
    return { kind: "folder" as const, folderIndex: tableIndex, entry: rows[tableIndex] };
  }
  return { kind: "item" as const, itemIndex: tableIndex - rows.length };
}

function translateTableIndices(tree: any | null, indices: number[]) {
  const result = {
    folder: [] as number[],
    items: [] as { tableIndex: number; itemIndex: number }[],
  };
  indices.forEach((index) => {
    const info = translateTableIndex(tree, index);
    if (info.kind === "folder") {
      result.folder.push(info.folderIndex);
    } else {
      result.items.push({ tableIndex: index, itemIndex: info.itemIndex });
    }
  });
  return result;
}

function ensureVirtualizedTablePatched(tree: any | null) {
  const vt = tree?.tree;
  if (!vt?.props) return;

  let patch = vtablePatchState.get(vt);
  if (!patch) {
    patch = { orig: {} };
    vtablePatchState.set(vt, patch);
  }

  const getBase = (key: string) => {
    const current = vt.props[key];
    const base = current && current.__thiagoOrig ? current.__thiagoOrig : current;
    if (base) {
      patch!.orig[key] = base;
      return base;
    }
    return patch!.orig[key];
  };

  const wrapFunction = (
    key: string,
    wrapper: (original: any, ...args: any[]) => any
  ) => {
    const original = getBase(key);
    if (!original) return;
    const wrapped = function (this: any, ...args: any[]) {
      return wrapper.call(this, original, ...args);
    };
    Object.defineProperty(wrapped, "__thiagoOrig", {
      value: original,
      enumerable: false,
    });
    vt.props[key] = wrapped;
  };

  wrapFunction("getRowCount", (original: () => number) => {
    return (original?.() ?? 0) + getFolderRowCount(tree);
  });

  wrapFunction("renderItem", (original: any, index: number, selection: any, oldDiv: HTMLDivElement | null, columns: any[]) => {
    const info = translateTableIndex(tree, index);
    if (info.kind === "folder") {
      return renderFolderVirtualRow(tree, info.entry, index, selection, oldDiv, columns);
    }
    return original(info.itemIndex, selection, oldDiv, columns);
  });

  [
    { key: "isSelectable", folderValue: false },
    { key: "isContainer", folderValue: false },
    { key: "isContainerEmpty", folderValue: true },
    { key: "isContainerOpen", folderValue: false },
  ].forEach(({ key, folderValue }) => {
    wrapFunction(key, (original: any, index: number, ...rest: any[]) => {
      const info = translateTableIndex(tree, index);
      if (info.kind === "folder") {
        return folderValue;
      }
      return original(info.itemIndex, ...rest);
    });
  });

  wrapFunction("getParentIndex", (original: any, index: number, ...rest: any[]) => {
    const info = translateTableIndex(tree, index);
    if (info.kind === "folder") return -1;
    const parent = original(info.itemIndex, ...rest);
    if (typeof parent !== "number" || parent < 0) return parent;
    return parent + getFolderRowCount(tree);
  });

  wrapFunction("toggleOpenState", (original: any, index: number, ...rest: any[]) => {
    const info = translateTableIndex(tree, index);
    if (info.kind === "folder") return;
    return original(info.itemIndex, ...rest);
  });

  wrapFunction("getRowString", (original: any, index: number, ...rest: any[]) => {
    const info = translateTableIndex(tree, index);
    if (info.kind === "folder") {
      return info.entry.name;
    }
    return original(info.itemIndex, ...rest);
  });

  wrapFunction("onActivate", (original: any, event: MouseEvent | KeyboardEvent, indices: number[]) => {
    const translated = translateTableIndices(tree, indices || []);
    translated.folder.forEach((folderIndex) => handleFolderRowActivate(tree, folderIndex));
    if (translated.items.length) {
      const actual = translated.items.map((entry) => entry.itemIndex);
      original(event, actual);
    }
  });
}

function renderFolderVirtualRow(
  tree: any,
  entry: FolderRowEntry,
  tableIndex: number,
  _selection: any,
  oldDiv: HTMLDivElement | null,
  columns: any[]
) {
  const doc = tree?.domEl?.ownerDocument || getDocument();
  const row = (oldDiv || doc.createElement("div")) as HTMLDivElement & {
    __thiagoFolderBound?: boolean;
  };
  row.className = "row thiago-folder-row";
  row.dataset.tableIndex = String(tableIndex);
  row.dataset.collectionId = String(entry.collectionID);
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", "1");
  row.tabIndex = 0;
  row.draggable = false;

  const state = getFolderState(tree, false);
  row.classList.toggle("thiago-folder-row--selected", state?.selectedIndex === tableIndex);

  row.innerHTML = "";
  const visibleColumns = columns.filter((col: any) => !col.hidden);
  visibleColumns.forEach((column: any) => {
    const cell = doc.createElement("span");
    const classNames = ["cell", column.className || "", `column-${column.dataKey}`]
      .filter(Boolean)
      .join(" ");
    cell.className = classNames;
    cell.setAttribute("role", "gridcell");
    if (column.primary) {
      cell.classList.add("first-column");
      const icon = doc.createElement("span");
      icon.className = "thiago-folder-row__icon";
      icon.setAttribute("aria-hidden", "true");

      const label = doc.createElement("span");
      label.className = "thiago-folder-row__label";
      label.textContent = entry.name;
      label.title = entry.name;

      cell.append(icon, label);

      if (entry.childCount) {
        const meta = doc.createElement("span");
        meta.className = "thiago-folder-row__meta";
        meta.textContent = `(${entry.childCount})`;
        cell.append(meta);
      }
    } else {
      cell.textContent = "";
    }
    row.appendChild(cell);
  });

  bindFolderRowEvents(row, tree);
  return row;
}

function bindFolderRowEvents(row: HTMLDivElement & { __thiagoFolderBound?: boolean }, tree: any) {
  if (row.__thiagoFolderBound) return;

  const getIndex = () => Number(row.dataset.tableIndex ?? "-1");

  row.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    const idx = getIndex();
    if (Number.isFinite(idx)) {
      setFolderRowSelection(tree, idx);
    }
  });

  row.addEventListener("focus", () => {
    const idx = getIndex();
    if (Number.isFinite(idx)) {
      setFolderRowSelection(tree, idx);
    }
  });

  row.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const idx = getIndex();
    if (Number.isFinite(idx)) {
      handleFolderRowActivate(tree, idx);
    }
  });

  row.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const idx = getIndex();
      if (Number.isFinite(idx)) {
        handleFolderRowActivate(tree, idx);
      }
    }
  });

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const idx = getIndex();
    if (Number.isFinite(idx)) {
      setFolderRowSelection(tree, idx);
    }
  });

  row.__thiagoFolderBound = true;
}

function handleFolderRowActivate(tree: any | null, folderIndex: number) {
  const info = translateTableIndex(tree, folderIndex);
  if (info.kind !== "folder") return;
  navigateToCollection(info.entry.collectionID);
  scheduleRerender(200);
}

function navigateUp() {
  const pane = getPane();
  const cur = pane?.getSelectedCollection();
  if (!cur?.parentID) return;
  navigateToCollection(cur.parentID);
  scheduleRerender(120);
}

// Parse "Library / Parent / Child"
function commitPath(raw: string) {
  const target = resolveCollectionByPath(raw.trim());
  const doc = getDocument();
  const strip = doc.getElementById("thiago-nav-strip") as any;
  if (target) {
    navigateToCollection(target.id);
    scheduleRerender(120);
  }
  if (strip?.__stopEditPath) strip.__stopEditPath();
}

function resolveCollectionByPath(input: string): any | null {
  // tolerate extra spaces, allow either "Library / A / B" or just "A / B" using current library
  const parts = input.split("/").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  const pane = getPane();
  const sel = pane?.getSelectedCollection();
  const currentLibID = sel?.libraryID ?? Zotero.Libraries.userLibraryID;

  // If first segment matches any library name, start from that library; else use current
  let libID = currentLibID;
  const allLibs = Zotero.Libraries.getAll();
  const first = parts[0].toLowerCase();
  const libHit = allLibs.find((l: any) => (l.name || "").toLowerCase() === first);
  let idx = 0;
  if (libHit) { libID = libHit.libraryID; idx = 1; }

  // Walk collections by name (case-insensitive, first match among siblings)
  let parentID: number | null = null;
  let found: any = null;
  for (; idx < parts.length; idx++) {
    const name = parts[idx].toLowerCase();
    const siblings = parentID == null
      ? Zotero.Collections.getByLibrary(libID).filter((c: any) => !c.parentID)
      : Zotero.Collections.getByParent(parentID);
    found = siblings.find((c: any) => (c.name || "").toLowerCase() === name);
    if (!found) return null;
    parentID = found.id;
  }
  return found;
}


type PathSeg = { label: string; collectionID: number | null };

function getPathSegments(selected: any): PathSeg[] {
  // Library root + chain of parents down to selected
  const segs: PathSeg[] = [];
  if (!selected) {
    // Nothing selected â†’ show just Library names? Keep simple:
    return [{ label: "Library", collectionID: null }];
  }
  const lib = Zotero.Libraries.get(selected.libraryID);
  const libName = (lib as any)?.name || "Library";
  segs.push({ label: libName, collectionID: null });

  // climb parents
  const chain: any[] = [];
  let cur = selected;
  while (cur) { chain.unshift(cur); if (!cur.parentID) break; cur = Zotero.Collections.get(cur.parentID); }
  chain.forEach(col => segs.push({ label: col.name, collectionID: col.id }));
  return segs;
}

function getCurrentPathString(): string {
  const sel = getPane()?.getSelectedCollection();
  if (!sel) return "Library";
  const segs = getPathSegments(sel).map(s => s.label);
  return segs.join(" / ");
}


function ensureNavStripCSS(doc: Document) {
  if (doc.getElementById("thiago-nav-strip-style")) return;
  const s = doc.createElement("style");
  s.id = "thiago-nav-strip-style";
  s.textContent = `
  /* container */
  #thiago-nav-strip {
    display:flex; align-items:center; gap:8px;
    padding:6px 8px;
    border-bottom:1px solid var(--color-border, #dadada);
    background:var(--material-toolbar, #f9f9f9);
    position:sticky; top:0; z-index: 1;
  }
  #thiago-nav-strip button {
    border:none; background:transparent; padding:4px 6px; border-radius:6px;
    font-size:14px; line-height:1; cursor:pointer;
  }
  #thiago-nav-strip button:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  #thiago-nav-strip button:disabled { opacity:.35; cursor:default; }
  #thiago-nav-path {
    min-width: 240px; flex:1; display:flex; align-items:center; gap:6px;
    padding:2px 6px; border-radius:6px; background: var(--material-button, #fff); border:1px solid var(--color-border, #dadada);
    overflow:hidden;
  }
  .thiago-crumb {
    display:inline-flex; align-items:center; gap:6px; white-space:nowrap; padding:2px 4px; border-radius:4px; cursor:pointer;
  }
  .thiago-crumb:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  .thiago-crumb-sep { opacity:.6; user-select:none; }
  #thiago-nav-input {
    width:100%; border:none; outline:none; background:transparent; font:inherit; padding:0;
  }
  #thiago-nav-path.editing { outline:2px solid var(--accent-blue30, rgba(64,114,229,.3)); }
  `;
  const host = doc.head || doc.querySelector("head") || doc.documentElement;
  if (host) host.appendChild(s);
}

// --- history ---
const navHistory: number[] = [];
let navIndex = -1;

function pushToHistory(id: number | null) {
  if (id == null) return;
  if (navHistory.length && navHistory[navHistory.length - 1] === id) {
    navIndex = navHistory.length - 1;
    updateNavButtonsEnabled();
    return;
  }
  if (navIndex < navHistory.length - 1) navHistory.splice(navIndex + 1);
  navHistory.push(id);
  navIndex = navHistory.length - 1;
  updateNavButtonsEnabled();
}

function canGo(delta: -1 | 1) {
  const i = navIndex + delta;
  return i >= 0 && i < navHistory.length;
}

function navigateHistory(delta: -1 | 1) {
  if (!canGo(delta)) return;
  navIndex += delta;
  const id = navHistory[navIndex];
  navigateToCollection(id);
  scheduleRerender(120);
}

// --- UI mount/update ---
function mountNavStrip(doc: Document) {
  if (doc.getElementById("thiago-nav-strip")) return;

  const root = getPane()?.itemsView?.domEl as HTMLElement | null;
  if (!root) return;

  const windowed =
    root.querySelector(".virtualized-table-list") ||
    root.querySelector("#virtualized-table-list") ||
    root.querySelector(".windowed-list");
  const itemsToolbar =
    doc.getElementById("zotero-items-toolbar") ||
    root.querySelector<HTMLElement>("#zotero-items-toolbar");

  const strip = doc.createElement("div");
  strip.id = "thiago-nav-strip";
  strip.style.display = "flex";
  strip.style.alignItems = "center";
  strip.style.gap = "8px";
  strip.style.padding = "6px 8px";
  strip.style.borderBottom = "1px solid var(--color-border, #dadada)";
  strip.style.background = "var(--material-toolbar, #f9f9f9)";

  const buttonsWrap = doc.createElement("div");
  buttonsWrap.style.display = "flex";
  buttonsWrap.style.alignItems = "center";
  buttonsWrap.style.gap = "4px";

  const backBtn = createNavButton(doc, "thiago-nav-back", "Back (Alt+Left)", "\u2190");
  const fwdBtn = createNavButton(doc, "thiago-nav-forward", "Forward (Alt+Right)", "\u2192");
  const upBtn = createNavButton(doc, "thiago-nav-up", "Up (Alt+Up)", "\u2191");
  buttonsWrap.append(backBtn, fwdBtn, upBtn);

  const pathBox = doc.createElement("div");
  pathBox.id = "thiago-nav-path";
  pathBox.style.minWidth = "240px";
  pathBox.style.flex = "1";
  pathBox.style.display = "flex";
  pathBox.style.alignItems = "center";
  pathBox.style.gap = "6px";
  pathBox.style.padding = "2px 6px";
  pathBox.style.borderRadius = "6px";
  pathBox.style.background = "var(--material-button, #fff)";
  pathBox.style.border = "1px solid var(--color-border, #dadada)";
  pathBox.title = "Click to edit â€¢ Ctrl+L to focus";

  const crumbs = doc.createElement("div");
  crumbs.id = "thiago-nav-breadcrumbs";
  crumbs.style.display = "flex";
  crumbs.style.alignItems = "center";
  crumbs.style.gap = "4px";
  crumbs.style.flexWrap = "wrap";

  const input = doc.createElement("input");
  input.id = "thiago-nav-input";
  input.style.display = "none";
  input.style.flex = "1";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.background = "transparent";

  const pathRow = doc.createElement("div");
  pathRow.style.display = "flex";
  pathRow.style.alignItems = "center";
  pathRow.style.gap = "6px";
  pathRow.style.width = "100%";

  pathBox.append(crumbs, input);
  pathRow.append(pathBox);

  strip.append(buttonsWrap, pathRow);

  const itemsPaneContainer =
    doc.getElementById("zotero-items-pane-container") ||
    (root.closest("#zotero-items-pane-container") as HTMLElement | null);
  const toolbarContainer =
    doc.getElementById("zotero-toolbar-item-tree") ||
    (itemsToolbar?.closest("#zotero-toolbar-item-tree") as HTMLElement | null);

  if (
    itemsPaneContainer &&
    toolbarContainer &&
    toolbarContainer.parentElement === itemsPaneContainer
  ) {
    toolbarContainer.insertAdjacentElement("afterend", strip);
  } else if (itemsToolbar?.parentElement) {
    itemsToolbar.parentElement.insertBefore(strip, itemsToolbar.nextSibling);
  } else if (windowed?.parentElement) {
    windowed.parentElement.insertBefore(strip, windowed);
  } else {
    root.prepend(strip);
  }

  backBtn.addEventListener("click", () => navigateHistory(-1));
  fwdBtn.addEventListener("click", () => navigateHistory(1));
  upBtn.addEventListener("click", () => navigateUp());

  pathBox.addEventListener("click", () => startEditPath());
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPath(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      stopEditPath();
    }
  });
  input.addEventListener("blur", () => stopEditPath());

  const keydownHandler = (ev: KeyboardEvent) => {
    if (ev.altKey && ev.key === "ArrowLeft") {
      ev.preventDefault();
      navigateHistory(-1);
    } else if (ev.altKey && ev.key === "ArrowRight") {
      ev.preventDefault();
      navigateHistory(1);
    } else if (ev.altKey && ev.key === "ArrowUp") {
      ev.preventDefault();
      navigateUp();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "l") {
      ev.preventDefault();
      startEditPath(true);
    }
  };
  doc.addEventListener("keydown", keydownHandler);

  function startEditPath(selectAll = false) {
    pathBox.classList.add("editing");
    crumbs.style.display = "none";
    input.style.display = "";
    input.value = getCurrentPathString();
    setTimeout(() => {
      input.focus();
      if (selectAll) input.select();
    }, 0);
  }
  function stopEditPath() {
    pathBox.classList.remove("editing");
    input.style.display = "none";
    crumbs.style.display = "";
  }

  (strip as any).__stopEditPath = stopEditPath;
  (strip as any).__keydownHandler = keydownHandler;
}

function createNavButton(
  doc: Document,
  id: string,
  title: string,
  label: string
): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.id = id;
  btn.type = "button";
  btn.title = title;
  btn.textContent = label;
  btn.style.border = "none";
  btn.style.background = "transparent";
  btn.style.padding = "4px 6px";
  btn.style.borderRadius = "6px";
  btn.style.fontSize = "14px";
  btn.style.lineHeight = "1";
  btn.style.cursor = "pointer";
  btn.addEventListener("mouseenter", () => {
    if (btn.disabled) return;
    btn.style.background = "var(--accent-blue10, rgba(64,114,229,.1))";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "transparent";
  });
  return btn;
}

function updateNavStrip(selected?: any) {
  const doc = getDocument();
  ensureNavStripCSS(doc);
  mountNavStrip(doc);
  const strip = doc.getElementById("thiago-nav-strip") as any;
  if (strip?.__stopEditPath) {
    try {
      strip.__stopEditPath();
    } catch {}
  }

  const crumbsBox = doc.getElementById("thiago-nav-breadcrumbs") as HTMLDivElement | null;
  if (!crumbsBox) return;

  const sel = selected ?? getPane()?.getSelectedCollection();
  const segments = getPathSegments(sel);
  // rebuild crumbs
  crumbsBox.textContent = "";
  segments.forEach((seg, i) => {
    if (i > 0) {
      const sep = doc.createElement("span");
      sep.className = "thiago-crumb-sep";
      sep.textContent = "â€º";
      crumbsBox.appendChild(sep);
    }
    const c = doc.createElement("span");
    c.className = "thiago-crumb";
    c.textContent = seg.label;
    c.title = seg.label;
    c.onclick = () => { if (seg.collectionID != null) navigateToCollection(seg.collectionID); };
    crumbsBox.appendChild(c);
  });

  updateNavButtonsEnabled();
}

function updateNavButtonsEnabled() {
  const doc = getDocument();
  const b = doc.getElementById("thiago-nav-back") as HTMLButtonElement | null;
  const f = doc.getElementById("thiago-nav-forward") as HTMLButtonElement | null;
  const u = doc.getElementById("thiago-nav-up") as HTMLButtonElement | null;
  const sel = getPane()?.getSelectedCollection();
  if (b) b.disabled = !canGo(-1);
  if (f) f.disabled = !canGo(1);
  if (u) u.disabled = !(sel && sel.parentID);
}


function requestNextFrame(cb: FrameRequestCallback): number {
  try {
    const win = Zotero.getMainWindow();
    if (win?.requestAnimationFrame) {
      return win.requestAnimationFrame(cb);
    }
  } catch { }
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
}

function cancelFrame(handle: number) {
  try {
    const win = Zotero.getMainWindow();
    if (win?.cancelAnimationFrame) {
      win.cancelAnimationFrame(handle);
      return;
    }
  } catch { }
  clearTimeout(handle);
}

function cancelScheduledFrame() {
  if (rafHandle) {
    cancelFrame(rafHandle);
    rafHandle = null;
  }
}

function patchCollectionSelection(pane?: any) {
  if (collectionSelectionRestore) return;
  try {
    const targetPane = pane || getPane();
    const selection = targetPane?.collectionsView?.selection;
    if (!selection || typeof selection.select !== "function") return;
    if ((selection as any).__thiagoPatched) return;

    const originalSelect = selection.select;
    selection.select = function patchedSelect(
      this: typeof selection,
      ...args: any[]
    ) {
      const result = originalSelect.apply(this, args);
      try {
        maybeScheduleRerenderForCollection(120);
      } catch { }
      return result;
    };
    (selection as any).__thiagoPatched = true;
    collectionSelectionRestore = () => {
      try {
        selection.select = originalSelect;
      } catch { }
      try {
        delete (selection as any).__thiagoPatched;
      } catch { }
      collectionSelectionRestore = null;
      ztoolkit.log("Collections selection patch removed");
    };
    ztoolkit.log("Collections selection patched for fast rerender");
  } catch (e) {
    ztoolkit.log("patchCollectionSelection error:", e);
  }
}

function findCollectionsTreeElement(): HTMLElement | null {
  try {
    const doc = getDocument();
    const selectors = [
      "#zotero-collections-tree",
      '[data-id="zotero-collections-tree"]',
      ".collections-tree",
    ];
    for (const selector of selectors) {
      const node = doc.querySelector<HTMLElement>(selector);
      if (node) return node;
    }
    const pane = getPane();
    return (
      pane?.collectionsView?._treebox?.treeBody ||
      pane?.collectionsView?._treebox?.element ||
      null
    );
  } catch {
    return null;
  }
}

function debugCurrentState() {
  try {
    const pane = getPane();
    const selectedCollection = pane?.getSelectedCollection();
    const sub = selectedCollection
      ? Zotero.Collections.getByParent(selectedCollection.id)
      : [];
    ztoolkit.log(`[DEBUG] selected=${selectedCollection?.name} (${selectedCollection?.id}) sub=${sub.map(s => s.name).join(", ")}`);
  } catch (e) {
    ztoolkit.log("debugCurrentState error:", e);
  }
}

function scheduleRerender(delay = 90) {
  if (rerenderTimer) {
    clearTimeout(rerenderTimer);
    rerenderTimer = null;
  }
  cancelScheduledFrame();

  rerenderTimer = setTimeout(() => {
    rafHandle = requestNextFrame(() => {
      if (renderInFlight) return;
      renderInFlight = true;
      try {
        renderFolderRowsForCurrentCollection();
      } catch (e) {
        const msg =
          e && typeof e === "object" && "stack" in e
            ? (e as Error).stack || (e as Error).message
            : e;
        ztoolkit.log("scheduleRerender error:", msg);
      } finally {
        renderInFlight = false;
        cancelScheduledFrame();
        rerenderTimer = null;
      }
    });
  }, delay) as unknown as number;
}

// ========== LISTENERS ==========

function setupCollectionChangeListener() {
  teardownCollectionChangeListener();

  const pane = getPane();
  patchCollectionSelection(pane);

  const tree = findCollectionsTreeElement();
  if (tree) {
    const handleSelect = () => {
      try {
        maybeScheduleRerenderForCollection(180);
      } catch { }
    };
    tree.addEventListener("select", handleSelect, true);
    tree.addEventListener("keyup", handleSelect, true);
    ztoolkit.log("Collections tree listener attached");
    collectionSelectCleanup = () => {
      tree.removeEventListener("select", handleSelect, true);
      tree.removeEventListener("keyup", handleSelect, true);
      ztoolkit.log("Collections tree listener removed");
    };
  } else {
    ztoolkit.log("Collections tree not found; relying on timer polling");
  }

  checkInterval = setInterval(() => {
    try {
      maybeScheduleRerenderForCollection(200);
    } catch { }

    try {
      updateNavStrip();
    } catch { }

  }, 500);
}

function teardownCollectionChangeListener() {
  if (collectionSelectCleanup) {
    try {
      collectionSelectCleanup();
    } catch { }
    collectionSelectCleanup = null;
  }
  if (collectionSelectionRestore) {
    try {
      collectionSelectionRestore();
    } catch { }
    collectionSelectionRestore = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

function maybeScheduleRerenderForCollection(delay: number) {
  const pane = getPane();
  if (!pane) return;
  const currentCollection = pane.getSelectedCollection();
  const currentID = currentCollection?.id || null;
  if (currentID !== lastRenderedCollectionID) {
    ztoolkit.log(`Collection change: ${lastRenderedCollectionID} -> ${currentID}`);
    scheduleRerender(delay);
  }
}

// ========== RENDER (FOLDER ROWS ONLY) ==========

function renderFolderRowsForCurrentCollection() {
  const pane = getPane();
  const tree = pane?.itemsView;
  if (!pane?.itemsView?.domEl) return;

  const selected = pane.getSelectedCollection();
  lastRenderedCollectionID = selected?.id || null;

  const subcollections = selected ? Zotero.Collections.getByParent(selected.id) : [];
  const entries = subcollections.map((sub: any) => {
    let childCount = 0;
    try {
      childCount = Zotero.Collections.getByParent(sub.id)?.length || 0;
    } catch { }
    return {
      key: `thiago-folder-${sub.id}`,
      collectionID: sub.id,
      name: sub.name || "Untitled",
      childCount,
    };
  });

  ensureGlobalStyles(getDocument());
  setFolderRowsForTree(tree, entries);
  ensureVirtualizedTablePatched(tree);
  tree?.tree?.invalidate?.();

  if (selected?.id) pushToHistory(selected.id);
  updateNavStrip(selected);

  ztoolkit.log(
    `Render ${entries.length} subcollections for "${selected?.name || 'No Collection'}"`
  );
}

// ========== BODY LOOKUP / CLEANUP ==========

function removeFolderRows() {
  const tree = getItemTree();
  if (!tree) return;
  setFolderRowsForTree(tree, []);
  ensureVirtualizedTablePatched(tree);
  tree?.tree?.invalidate?.();
}

// ========== NAVIGATION ==========

function navigateToCollection(collectionID: number) {
  const pane = getPane();
  if (!pane?.collectionsView) {
    ztoolkit.log("No pane or collectionsView available");
    return;
  }
  try {
    const cv = pane.collectionsView;
    expandParentCollections(collectionID);

    setTimeout(() => {
      let targetRowIndex = -1;
      for (let i = 0; i < cv._rows.length; i++) {
        const row = cv._rows[i];
        if (row.ref?.id === collectionID) { targetRowIndex = i; break; }
      }
      if (targetRowIndex === -1) return;

      if (cv.selection) {
        cv.selection.select(targetRowIndex);
        if (cv.tree?.invalidate) cv.tree.invalidate();
      } else if (typeof cv._selectRow === "function") {
        cv._selectRow(targetRowIndex);
      } else if (cv._treebox?.getElementByIndex) {
        cv._treebox.getElementByIndex(targetRowIndex)?.click();
      }
      scheduleRerender(120);
    }, 200);

  } catch (e) {
    ztoolkit.log(`navigateToCollection error: ${e}`);
  }
}

function expandParentCollections(collectionID: number) {
  const pane = getPane();
  if (!pane?.collectionsView) return;

  try {
    const collection = Zotero.Collections.get(collectionID);
    if (!collection) return;

    const cv = pane.collectionsView;
    const parentIDs: number[] = [];
    let current = collection;
    while (current.parentID) {
      parentIDs.unshift(current.parentID);
      current = Zotero.Collections.get(current.parentID);
    }

    for (const parentID of parentIDs) {
      for (let i = 0; i < cv._rows.length; i++) {
        const row = cv._rows[i];
        if (row.ref?.id === parentID) {
          if (cv.isContainer(i) && !cv.isContainerOpen(i)) cv.toggleOpenState(i, true);
          break;
        }
      }
    }
  } catch (e) {
    ztoolkit.log(`expandParentCollections error: ${e}`);
  }
}

export default Hooks;
