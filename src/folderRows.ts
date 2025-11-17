import { ensureGlobalStyles, getDocument, getPane } from "./env";
import { navigateToCollection, pushToHistory, updateNavStrip } from "./navigation";

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

export function debugCurrentState() {
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

export function scheduleRerender(delay = 90) {
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

export function setupCollectionChangeListener() {
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

export function teardownCollectionChangeListener() {
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
  const previousCollectionID = lastRenderedCollectionID;
  lastRenderedCollectionID = selected?.id || null;

  // Tear down previous UI
  removeFolderRows();
  detachHeaderObservers();

  if (!selected) return;

  if (selected?.id) pushToHistory(selected.id);
  updateNavStrip(selected);


  const subcollections = Zotero.Collections.getByParent(selected.id);
  const shouldResetScroll = previousCollectionID !== lastRenderedCollectionID;
  ztoolkit.log(`Render ${subcollections.length} subcollections for "${selected.name}"`);

  renderFolderRows(subcollections, { resetScroll: shouldResetScroll });
}

/**
 * We inject into the scrollable body so rows behave like list entries.
 * - Find items body (rowgroup)
 * - Prepend our container
 * - Align via CSS grid to header widths
 */
function renderFolderRows(subcollections: any[], options?: { resetScroll?: boolean }) {
  const resetScroll = !!options?.resetScroll;
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
  if (resetScroll) {
    scrollBodyToTop(body);
  }

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
      icon.textContent = "\u{1F4C1}";
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
  if (!first) return null;
  return first.parentElement as HTMLElement | null;
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

function scrollBodyToTop(body: HTMLElement) {
  if (!body) return;
  const scroller =
    (scrollCompensationState?.scroller?.isConnected ? scrollCompensationState.scroller : null) ||
    getScrollHostForBody(body) ||
    body;
  const snap = () => setScrollerActualScroll(scroller, 0);
  snap();
  requestNextFrame(() => {
    snap();
    requestNextFrame(() => snap());
  });
}

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

function setScrollerActualScroll(scroller: HTMLElement, actualValue: number): boolean {
  if (!scroller) return false;
  const numeric = Math.max(0, sanitizeScrollValue(actualValue));
  if (scrollCompensationState?.scroller === scroller) {
    try {
      scrollCompensationState.writeNative(numeric);
      return true;
    } catch { }
  }
  try {
    scroller.scrollTop = numeric;
    return true;
  } catch {
    return false;
  }
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

export function shutdownFolderRows() {
  removeFolderRows();
  teardownScrollTopCompensation();
  detachHeaderObservers();
  teardownWindowResizeListener();
  if (rerenderTimer) {
    clearTimeout(rerenderTimer);
    rerenderTimer = null;
  }
  cancelScheduledFrame();
  renderInFlight = false;
}
