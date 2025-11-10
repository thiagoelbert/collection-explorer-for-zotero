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
    detachHeaderObservers();
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

let folderRowsContainer: HTMLElement | null = null;
let lastRenderedCollectionID: number | null = null;
let checkInterval: any = null;
let collectionSelectCleanup: (() => void) | null = null;
let headerResizeObserver: ResizeObserver | null = null;
let columnsMutationObserver: MutationObserver | null = null;
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
        maybeScheduleRerenderForCollection(90, { force: true });
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
        maybeScheduleRerenderForCollection(180, { force: true });
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

function maybeScheduleRerenderForCollection(
  delay: number,
  options?: { force?: boolean }
) {
  const pane = getPane();
  if (!pane) return;
  const currentCollection = pane.getSelectedCollection();
  const currentID = currentCollection?.id || null;
  const shouldForce = options?.force === true;
  if (shouldForce || currentID !== lastRenderedCollectionID) {
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
  const root = pane.itemsView?.domEl as HTMLElement;
  if (!root) return;

  const headerRow = root.querySelector<HTMLElement>(
    '[role="row"][data-header], [role="row"][aria-rowindex="1"], .virtualized-table-header'
  );
  const headerCells = headerRow ? getHeaderCellsFrom(headerRow) : [];

  const body = findItemsBody(root);
  if (!body) {
    ztoolkit.log("Items body not found; abort folder-rows render");
    return;
  }

  if (!subcollections || subcollections.length === 0) return;

  // Build container
  const container = doc.createElement("div");
  container.id = "subcollection-folder-rows";
  container.setAttribute("role", "rowgroup");
  container.style.cssText = `
    --thiago-grid: auto;
    border-bottom: 1px solid rgba(0,0,0,.06);
  `;

  body.prepend(container);
  folderRowsContainer = container;

  // Grid alignment with header widths
  applyGridTemplateFromHeader(headerCells);

  // Build rows
  for (const sub of subcollections) {
    const row = buildFolderRow(sub);
    container.appendChild(row);
  }

  // Keep columns in sync
  attachHeaderObservers(headerRow, () => {
    const freshHeaderCells = headerRow ? getHeaderCellsFrom(headerRow) : [];
    applyGridTemplateFromHeader(freshHeaderCells);
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
    grid-template-columns: var(--thiago-grid, auto);
    align-items: center;
    min-height: 28px;
    padding: 0 6px;
    font-size: 12.5px;
    user-select: none;
    cursor: pointer;
  `;

  row.onmouseenter = () => (row.style.background = "rgba(79,124,207,0.08)");
  row.onmouseleave = () => (row.style.background = "");
  row.onmousedown = () => (row.style.background = "rgba(79,124,207,0.15)");
  row.onmouseup = () => (row.style.background = "rgba(79,124,207,0.08)");

  row.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      navigateToCollection(subCol.id);
      scheduleRerender(260);
    }
  });
  row.onclick = () => {
    navigateToCollection(subCol.id);
    scheduleRerender(260);
  };

  const columnCount = getCurrentColumnCount();
  for (let i = 0; i < columnCount; i++) {
    const cell = doc.createElement("div");
    cell.setAttribute("role", "gridcell");
    cell.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:2px 4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#222;";

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
      } catch { }

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
  if (!folderRowsContainer) return;
  if (!headerCells || headerCells.length === 0) {
    folderRowsContainer.style.setProperty("--thiago-grid", "1fr");
    return;
  }
  const widths = headerCells.map((c) => {
    const r = c.getBoundingClientRect();
    return Math.max(40, Math.round(r.width));
  });
  const template = widths.map((w) => `${w}px`).join(" ");
  folderRowsContainer.style.setProperty("--thiago-grid", template);

  folderRowsContainer
    .querySelectorAll<HTMLElement>('[role="row"]')
    .forEach((row: HTMLElement) => {
      row.style.gridTemplateColumns = `var(--thiago-grid, ${template})`;
    });
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
  try {
    if (folderRowsContainer) {
      folderRowsContainer.remove();
      folderRowsContainer = null;
    }
    const doc = getDocument();
    doc.querySelectorAll("#subcollection-folder-rows").forEach((el: Element) => (el as HTMLElement).remove());
  } catch { }
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
