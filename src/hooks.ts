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
    teardownScrollTopCompensation();
    detachHeaderObservers();
    teardownWindowResizeListener();
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

const ENABLE_SCROLLTOP_COMPENSATION = true;
const FOLDER_ROW_SELECTED_BG_ACTIVE = "#4072e5";
const FOLDER_ROW_SELECTED_BG_INACTIVE = "#d9d9d9";
const FOLDER_ROW_SELECTED_COLOR_ACTIVE = "#fff";
const FOLDER_ROW_SELECTED_COLOR_INACTIVE = "#222";
const FOLDER_ROW_DEFAULT_COLOR = "#222";
const FOLDER_ROW_HOVER_BG = "rgba(64, 114, 229, 0.08)";
const FOLDER_ROW_ACTIVE_PRESS_BG = "rgba(64, 114, 229, 0.15)";

let folderRows: HTMLElement[] = [];
let currentGridTemplate = "auto";
let selectedFolderRow: HTMLElement | null = null;
let itemsBodyCleanup: (() => void) | null = null;
let itemsPaneHasFocus = false;
let lastRenderedCollectionID: number | null = null;
let checkInterval: any = null;
let collectionSelectCleanup: (() => void) | null = null;
let headerResizeObserver: ResizeObserver | null = null;
let columnsMutationObserver: MutationObserver | null = null;
let collectionSelectionRestore: (() => void) | null = null;
let rerenderTimer: number | null = null;
let rafHandle: number | null = null;
let renderInFlight = false;
let folderRowsResizeObserver: ResizeObserver | null = null;
let windowResizeCleanup: (() => void) | null = null;
let extraTopOffset = 0;
let extraTopOffsetMeasureHandle: number | null = null;
let scrollCompensationState: ScrollCompensationState | null = null;

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
  if (!pane?.itemsView?.domEl) return;

  const selected = pane.getSelectedCollection();
  lastRenderedCollectionID = selected?.id || null;

  // Tear down previous UI
  removeFolderRows();
  detachHeaderObservers();

  if (!selected) return;

  if (selected?.id) pushToHistory(selected.id);
  updateNavStrip(selected);


  const subcollections = Zotero.Collections.getByParent(selected.id);
  ztoolkit.log(`Render ${subcollections.length} subcollections for "${selected.name}"`);

  renderFolderRows(subcollections);
}

/**
 * We inject into the scrollable body so rows behave like list entries.
 * - Find items body (rowgroup)
 * - Prepend our container
 * - Align via CSS grid to header widths
 */
function renderFolderRows(subcollections: any[]) {
  const pane = getPane();
  const doc = getDocument();
  ensureGlobalStyles(doc);
  const root = pane.itemsView?.domEl as HTMLElement;
  if (!root) return;

  const headerRow = root.querySelector<HTMLElement>(
    '[role="row"][data-header], [role="row"][aria-rowindex="1"], .virtualized-table-header'
  );
  const headerCells = headerRow ? getHeaderCellsFrom(headerRow) : [];

  const body = findItemsBody(root);
  if (!body) {
    ztoolkit.log("Items body not found; abort folder-rows render");
    detachFolderRowsResizeObserver();
    setExtraTopOffset(0);
    return;
  }
  body.setAttribute("data-thiago-items-body", "true");
  ensureScrollTopCompensation(body);

  if (!subcollections || subcollections.length === 0) {
    detachFolderRowsResizeObserver();
    setExtraTopOffset(0);
    return;
  }

  const fragment = doc.createDocumentFragment();
  const createdRows: HTMLElement[] = [];
  for (const sub of subcollections) {
    const row = buildFolderRow(sub);
    createdRows.push(row);
    fragment.appendChild(row);
  }

  const firstExistingRow =
    body.querySelector<HTMLElement>('[role="row"]') || body.firstChild;
  body.insertBefore(fragment, firstExistingRow ?? null);
  folderRows = createdRows;
  updateZebraFlipFlag();

  applyGridTemplateFromHeader(headerCells);
  applyRowStriping();
  attachItemsBodyListeners(body);
  ensureWindowResizeListener();
  attachFolderRowsResizeObserver(body);
  scheduleExtraTopOffsetMeasure();

  // Keep columns in sync
  attachHeaderObservers(headerRow, () => {
    const freshHeaderCells = headerRow ? getHeaderCellsFrom(headerRow) : [];
    applyGridTemplateFromHeader(freshHeaderCells);
    applyRowStriping();
    scheduleExtraTopOffsetMeasure();
  });
}

/** One folder-like row aligned to columns; opens on click/Enter/Space */
function buildFolderRow(subCol: any): HTMLElement {
  const doc = getDocument();
  const row = doc.createElement("div");
  row.setAttribute("role", "row");
  row.className = "thiago-folder-row";
  row.tabIndex = 0;

  row.style.cssText = `
    display: grid;
    align-items: center;
    min-height: 28px;
    padding: 0 6px;
    font-size: 12.5px;
    user-select: none;
    cursor: default;
    border-radius: 4px;
  `;
  row.style.gridTemplateColumns = currentGridTemplate || "auto";
  row.dataset.stripeColor = "";
  row.style.color = FOLDER_ROW_DEFAULT_COLOR;

  row.onclick = (ev) => {
    ev.preventDefault();
    setSelectedFolderRow(row);
  };
  row.ondblclick = (ev) => {
    ev.preventDefault();
    navigateToCollection(subCol.id);
    scheduleRerender(260);
  };
  row.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      navigateToCollection(subCol.id);
      scheduleRerender(260);
    }
  });

  const columnCount = getCurrentColumnCount();
  for (let i = 0; i < columnCount; i++) {
    const cell = doc.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:2px 4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:inherit;";

    if (i === 0) {
      const icon = doc.createElement("span");
      icon.textContent = "📁";
      icon.setAttribute("aria-hidden", "true");

      const name = doc.createElement("span");
      name.textContent = subCol.name;
      name.style.fontWeight = "600";

      const countSpan = doc.createElement("span");
      try {
        const children = Zotero.Collections.getByParent(subCol.id) || [];
        if (children.length) {
          countSpan.textContent = `(${children.length} sub)`;
          countSpan.style.cssText =
            "font-weight:400;color:#666;margin-left:6px;";
        }
      } catch {}

      cell.append(icon, name, countSpan);
    } else {
      cell.textContent = "";
    }

    row.appendChild(cell);
  }

  return row;
}

// ========== COLUMN SYNC / OBSERVERS ==========

function getHeaderCellsFrom(headerRow: HTMLElement): HTMLElement[] {
  const candidates = headerRow.querySelectorAll<HTMLElement>(
    '[role="columnheader"], .column-header-cell, .virtualized-table-header-cell'
  );
  return Array.from(candidates);
}

function getCurrentColumnCount(): number {
  const pane = getPane();
  const root = pane?.itemsView?.domEl as HTMLElement;
  if (!root) return 1;
  const headerRow = root.querySelector<HTMLElement>(
    '[role="row"][data-header], [role="row"][aria-rowindex="1"], .virtualized-table-header'
  );
  const cells = headerRow ? getHeaderCellsFrom(headerRow) : [];
  return Math.max(1, cells.length);
}

function applyGridTemplateFromHeader(headerCells: HTMLElement[]) {
  let template = "1fr";
  if (headerCells && headerCells.length > 0) {
    const widths = headerCells.map((c) => {
      const r = c.getBoundingClientRect();
      return Math.max(40, Math.round(r.width));
    });
    template = widths.map((w) => `${w}px`).join(" ");
  }
  updateFolderRowGridTemplate(template);
}

function updateFolderRowGridTemplate(template: string) {
  currentGridTemplate = template || "auto";
  folderRows.forEach((row) => {
    row.style.gridTemplateColumns = currentGridTemplate;
  });
}

function getExtraTopOffset(): number {
  if (!ENABLE_SCROLLTOP_COMPENSATION) return 0;
  return extraTopOffset;
}

function setExtraTopOffset(value: number) {
  const clamped = Math.max(0, Math.round(value));
  if (clamped === extraTopOffset) return;
  const previous = extraTopOffset;
  extraTopOffset = clamped;
  if (!scrollCompensationState) return;
  const delta = clamped - previous;
  if (!delta) return;
  try {
    const nativeScroll = scrollCompensationState.readNative();
    const next = Math.max(0, nativeScroll + delta);
    scrollCompensationState.writeNative(next);
  } catch { }
}

function scheduleExtraTopOffsetMeasure() {
  if (!ENABLE_SCROLLTOP_COMPENSATION) return;
  if (extraTopOffsetMeasureHandle) return;
  extraTopOffsetMeasureHandle = requestNextFrame(() => {
    extraTopOffsetMeasureHandle = null;
    measureExtraTopOffsetNow();
  });
}

function measureExtraTopOffsetNow() {
  if (!ENABLE_SCROLLTOP_COMPENSATION) {
    extraTopOffset = 0;
    return;
  }
  const container = getFolderRowsContainer();
  if (!container || folderRows.length === 0) {
    setExtraTopOffset(0);
    return;
  }
  const height = Math.round(folderRows.reduce((sum, row) => {
    if (!row.isConnected) return sum;
    const rect = row.getBoundingClientRect();
    return sum + rect.height;
  }, 0));
  setExtraTopOffset(height);
}

function getFolderRowsContainer(): HTMLElement | null {
  if (!folderRows.length) return null;
  const first = folderRows[0];
  return first?.parentElement || null;
}

function attachFolderRowsResizeObserver(container: HTMLElement | null) {
  if (!ENABLE_SCROLLTOP_COMPENSATION) return;
  detachFolderRowsResizeObserver();
  if (!container || typeof ResizeObserver === "undefined") return;
  try {
    folderRowsResizeObserver = new ResizeObserver(() => scheduleExtraTopOffsetMeasure());
    folderRowsResizeObserver.observe(container);
  } catch {
    folderRowsResizeObserver = null;
  }
}

function detachFolderRowsResizeObserver() {
  if (!folderRowsResizeObserver) return;
  try {
    folderRowsResizeObserver.disconnect();
  } catch { }
  folderRowsResizeObserver = null;
}

function ensureWindowResizeListener() {
  if (!ENABLE_SCROLLTOP_COMPENSATION) return;
  if (windowResizeCleanup) return;
  try {
    const win = getDocument().defaultView;
    if (!win) return;
    const handler = () => scheduleExtraTopOffsetMeasure();
    win.addEventListener("resize", handler);
    windowResizeCleanup = () => {
      try {
        win.removeEventListener("resize", handler);
      } catch { }
      windowResizeCleanup = null;
    };
  } catch { }
}

function teardownWindowResizeListener() {
  if (!windowResizeCleanup) return;
  try {
    windowResizeCleanup();
  } catch { }
  windowResizeCleanup = null;
}

type ScrollCompensationLayer = "accessor" | "proxy";

type ScrollCompensationState = {
  scroller: HTMLElement;
  layer: ScrollCompensationLayer;
  teardown: () => void;
  readNative: () => number;
  writeNative: (value: number) => void;
};

type ScrollCompensationSetupResult = {
  teardown: () => void;
  readNative: () => number;
  writeNative: (value: number) => void;
};

function ensureScrollTopCompensation(body: HTMLElement) {
  if (!ENABLE_SCROLLTOP_COMPENSATION) return;
  const scroller = getScrollHostForBody(body);
  if (!scroller) return;
  if (scrollCompensationState?.scroller === scroller) return;

  teardownScrollTopCompensation();

  const accessorSetup = tryPatchScrollTopAccessor(scroller);
  if (accessorSetup) {
    scrollCompensationState = {
      scroller,
      layer: "accessor",
      teardown: accessorSetup.teardown,
      readNative: accessorSetup.readNative,
      writeNative: accessorSetup.writeNative,
    };
    ztoolkit.log("ScrollTop compensation active via accessor patch");
    return;
  }

  const proxySetup = tryProxyScrollTop(scroller);
  if (proxySetup) {
    scrollCompensationState = {
      scroller,
      layer: "proxy",
      teardown: proxySetup.teardown,
      readNative: proxySetup.readNative,
      writeNative: proxySetup.writeNative,
    };
    ztoolkit.log("ScrollTop compensation active via proxy fallback");
  } else {
    ztoolkit.log("ScrollTop compensation unavailable (no workable layer)");
  }
}

function teardownScrollTopCompensation() {
  if (!scrollCompensationState) return;
  try {
    scrollCompensationState.teardown();
  } catch { }
  scrollCompensationState = null;
}

function tryPatchScrollTopAccessor(scroller: HTMLElement): ScrollCompensationSetupResult | null {
  try {
    let proto: any = scroller;
    let descriptor: PropertyDescriptor | undefined;
    while (proto && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(proto, "scrollTop");
      proto = Object.getPrototypeOf(proto);
    }
    if (!descriptor || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") {
      return null;
    }

    const patchDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get(this: HTMLElement) {
        const raw = descriptor!.get!.call(this);
        const logical = raw - getExtraTopOffset();
        return logical > 0 ? logical : 0;
      },
      set(this: HTMLElement, value: any) {
        if (!descriptor!.set) return;
        const desired = sanitizeScrollValue(value);
        const offset = getExtraTopOffset();
        const target = desired + offset;
        descriptor!.set!.call(this, target < 0 ? 0 : target);
      },
    };

    Object.defineProperty(scroller, "scrollTop", patchDescriptor);

    const readNative = () => {
      try {
        return descriptor!.get!.call(scroller) as number;
      } catch {
        return sanitizeScrollValue((scroller as any).__thiagoRawScrollTop ?? 0);
      }
    };

    const writeNative = (value: number) => {
      try {
        descriptor!.set!.call(scroller, value);
      } catch {
        try {
          (scroller as any).__thiagoRawScrollTop = value;
        } catch { }
      }
    };

    return {
      teardown: () => {
        try {
          delete (scroller as any).scrollTop;
        } catch {
          try {
            Object.defineProperty(scroller, "scrollTop", descriptor!);
          } catch { }
        }
      },
      readNative,
      writeNative,
    };
  } catch (error) {
    ztoolkit.log("ScrollTop accessor patch failed:", error);
    return null;
  }
}

function tryProxyScrollTop(scroller: HTMLElement): ScrollCompensationSetupResult | null {
  const pane = getPane();
  const itemsView = pane?.itemsView;
  if (!itemsView || typeof Proxy === "undefined") return null;

  const keys: string[] = [];
  try {
    for (const key of Object.keys(itemsView)) {
      if ((itemsView as any)[key] === scroller) {
        keys.push(key);
      }
    }
  } catch {
    return null;
  }

  if (!keys.length) return null;

  const proxy = createScrollerProxy(scroller);
  keys.forEach((key) => {
    try {
      (itemsView as any)[key] = proxy;
    } catch { }
  });

  return {
    teardown: () => {
      keys.forEach((key) => {
        try {
          (itemsView as any)[key] = scroller;
        } catch { }
      });
    },
    readNative: () => sanitizeScrollValue(scroller.scrollTop),
    writeNative: (value: number) => {
      const numeric = sanitizeScrollValue(value);
      scroller.scrollTop = Math.max(0, numeric);
    },
  };
}

function createScrollerProxy(scroller: HTMLElement): HTMLElement {
  const handler: ProxyHandler<HTMLElement> = {
    get(target, prop, receiver) {
      if (prop === "scrollTop") {
        const raw = Reflect.get(target, prop, target) as number;
        const logical = raw - getExtraTopOffset();
        return logical > 0 ? logical : 0;
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === "scrollTop") {
        const desired = sanitizeScrollValue(value);
        const offset = getExtraTopOffset();
        const next = Math.max(0, desired + offset);
        Reflect.set(target, prop, next);
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  };
  return new Proxy(scroller, handler) as unknown as HTMLElement;
}

function getScrollHostForBody(body: HTMLElement): HTMLElement {
  if (!body) return body;
  if (isScrollableElement(body)) return body;
  const parent = body.parentElement as HTMLElement | null;
  if (parent && isScrollableElement(parent)) return parent;
  return body;
}

function isScrollableElement(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.scrollHeight - el.clientHeight > 1) return true;
  try {
    const win = el.ownerDocument?.defaultView;
    const style = win?.getComputedStyle(el);
    if (!style) return false;
    return style.overflowY === "auto" || style.overflowY === "scroll";
  } catch {
    return false;
  }
}

function sanitizeScrollValue(value: any): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function attachItemsBodyListeners(body: HTMLElement) {
  detachItemsBodyListeners();
  const handleFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    itemsPaneHasFocus = true;
    if (target.closest(".thiago-folder-row")) {
      refreshSelectedFolderRowAppearance();
      return;
    }
    if (selectedFolderRow) setSelectedFolderRow(null);
  };

  const handleFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as HTMLElement | null;
    if (next && body.contains(next)) return;
    itemsPaneHasFocus = false;
    refreshSelectedFolderRowAppearance();
  };

  const handleMouseDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".thiago-folder-row")) {
      itemsPaneHasFocus = true;
      refreshSelectedFolderRowAppearance();
      return;
    }
    if (selectedFolderRow) setSelectedFolderRow(null);
  };
  body.addEventListener("focusin", handleFocusIn, true);
  body.addEventListener("focusout", handleFocusOut, true);
  body.addEventListener("mousedown", handleMouseDown, true);
  itemsBodyCleanup = () => {
    body.removeEventListener("focusin", handleFocusIn, true);
    body.removeEventListener("focusout", handleFocusOut, true);
    body.removeEventListener("mousedown", handleMouseDown, true);
    itemsBodyCleanup = null;
  };
}

function detachItemsBodyListeners() {
  if (itemsBodyCleanup) {
    try {
      itemsBodyCleanup();
    } catch { }
    itemsBodyCleanup = null;
  }
}

function applyRowStriping() {
  folderRows.forEach((row, index) => {
    const color = index % 2 === 0 ? "#fff" : "whitesmoke";
    row.dataset.stripeColor = color;
    row.style.borderRadius = color === "whitesmoke" ? "6px" : "4px";
    if (row !== selectedFolderRow) {
      applyRowBackground(row);
    }
  });
}

function setSelectedFolderRow(row: HTMLElement | null) {
  if (selectedFolderRow === row) return;
  if (selectedFolderRow) {
    const previousColor = selectedFolderRow.dataset.stripeColor || "";
    selectedFolderRow.style.background = previousColor;
    selectedFolderRow.classList.remove("thiago-folder-row--selected");
    selectedFolderRow.style.color = FOLDER_ROW_DEFAULT_COLOR;
  }

  selectedFolderRow = row;
  if (!row) return;

  row.classList.add("thiago-folder-row--selected");
  itemsPaneHasFocus = true;
  try {
    row.focus();
  } catch { }
  refreshSelectedFolderRowAppearance();
  clearNativeItemSelection();
}

function updateZebraFlipFlag() {
  try {
    const doc = getDocument();
    const tree = doc.getElementById("zotero-items-tree");
    if (!tree) return;
    if (folderRows.length % 2 === 1) {
      tree.setAttribute("data-thiago-flip", "1");
    } else {
      tree.removeAttribute("data-thiago-flip");
    }
  } catch { }
}

function refreshSelectedFolderRowAppearance() {
  if (!selectedFolderRow) return;
  if (itemsPaneHasFocus) {
    selectedFolderRow.style.background = FOLDER_ROW_SELECTED_BG_ACTIVE;
    selectedFolderRow.style.color = FOLDER_ROW_SELECTED_COLOR_ACTIVE;
  } else {
    selectedFolderRow.style.background = FOLDER_ROW_SELECTED_BG_INACTIVE;
    selectedFolderRow.style.color = FOLDER_ROW_SELECTED_COLOR_INACTIVE;
  }
}

function applyRowBackground(row: HTMLElement) {
  if (row === selectedFolderRow) {
    refreshSelectedFolderRowAppearance();
    return;
  }
  row.style.background = row.dataset.stripeColor || "";
  row.style.color = FOLDER_ROW_DEFAULT_COLOR;
  const color = (row.dataset.stripeColor || "").toLowerCase();
  row.style.borderRadius = color === "whitesmoke" ? "6px" : "4px";
}


function clearNativeItemSelection() {
  try {
    const pane = getPane();
    const itemsView = pane?.itemsView;
    if (!itemsView) return;

    const selection = itemsView.selection;
    if (selection?.clearSelection) {
      selection.clearSelection();
    } else if (selection?.clear) {
      selection.clear();
    }

    const treeSelection =
      itemsView.tree?.selection ||
      itemsView.tree?.view?.selection ||
      itemsView._treebox?.selection;
    if (treeSelection?.clearSelection) {
      treeSelection.clearSelection();
    }
  } catch { }
}

function attachHeaderObservers(headerRow: HTMLElement | null, onChange: () => void) {
  detachHeaderObservers();
  if (!headerRow) return;

  headerResizeObserver = new ResizeObserver(() => onChange());
  headerResizeObserver.observe(headerRow);

  columnsMutationObserver = new MutationObserver(() => onChange());
  columnsMutationObserver.observe(headerRow, {
    subtree: true,
    attributes: true,
    childList: true,
  });
}

function detachHeaderObservers() {
  if (headerResizeObserver) {
    try { headerResizeObserver.disconnect(); } catch { }
    headerResizeObserver = null;
  }
  if (columnsMutationObserver) {
    try { columnsMutationObserver.disconnect(); } catch { }
    columnsMutationObserver = null;
  }
}

// ========== BODY LOOKUP / CLEANUP ==========

function findItemsBody(root: HTMLElement): HTMLElement | null {
  let body = root.querySelector<HTMLElement>(
    '[role="rowgroup"].body, .virtualized-table-body, [data-role="items-body"]'
  );
  if (body) return body;

  body = root.querySelector<HTMLElement>('[role="rowgroup"]');
  if (body) return body;

  const hostWin = ((): Window | null => {
    try {
      return Zotero.getMainWindow();
    } catch {
      return null;
    }
  })();

  const docWin = ((): Window | null => {
    try {
      return getDocument().defaultView;
    } catch {
      return null;
    }
  })();

  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("div, section")
  ) as HTMLElement[];

  const computeStyle =
    hostWin && typeof hostWin.getComputedStyle === "function"
      ? hostWin.getComputedStyle.bind(hostWin)
      : docWin && typeof docWin.getComputedStyle === "function"
        ? docWin.getComputedStyle.bind(docWin)
        : null;

  for (const el of nodes) {
    const cs = computeStyle ? computeStyle(el) : null;
    if (!cs) continue;

    const scrollable = cs.overflowY === "auto" || cs.overflowY === "scroll";
    if (scrollable && el.querySelector('[role="row"]')) {
      return el;
    }
  }

  return null;
}

function removeFolderRows() {
  folderRows.forEach((row) => {
    try {
      row.remove();
    } catch { }
  });
  folderRows = [];
  selectedFolderRow = null;
  detachItemsBodyListeners();
  detachFolderRowsResizeObserver();
  if (extraTopOffsetMeasureHandle) {
    cancelFrame(extraTopOffsetMeasureHandle);
    extraTopOffsetMeasureHandle = null;
  }
  setExtraTopOffset(0);
  updateZebraFlipFlag();
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
