/**
 * Renders faux "folder rows" above Zotero's items list so navigating collections
 * feels similar to a filesystem explorer. Responsible for DOM injection,
 * keyboard/mouse handling, resize sync, and scroll compensation.
 */
import { ensureGlobalStyles, getDocument, getPane } from "../env";
import { navigateToCollection, pushToHistory, updateNavStrip } from "../navigation";

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
let itemsBodyElement: HTMLElement | null = null;
let itemsKeyboardTarget: HTMLElement | null = null;
let itemsPaneHasFocus = false;
let lastRenderedCollectionID: number | null = null;
let headerResizeObserver: ResizeObserver | null = null;
let columnsMutationObserver: MutationObserver | null = null;
let folderRowsResizeObserver: ResizeObserver | null = null;
let windowResizeCleanup: (() => void) | null = null;
let extraTopOffset = 0;
let extraTopOffsetMeasureHandle: number | null = null;
let scrollCompensationState: ScrollCompensationState | null = null;

/** Exposes which collection ID the injected rows currently represent. */
export function getLastRenderedCollectionID() {
  return lastRenderedCollectionID;
}

type RerenderTrigger = (delay?: number) => void;
let rerenderTrigger: RerenderTrigger = () => { };

/** Allows the controller to override the debounced rerender entry point. */
export function setRerenderTrigger(trigger: RerenderTrigger) {
  rerenderTrigger = trigger;
}

// ========== UTILS ==========

/**
 * Schedules a callback for the next animation frame in the Zotero window,
 * falling back to `setTimeout` when the host API is unavailable.
 */
export function requestNextFrame(cb: FrameRequestCallback): number {
  try {
    const win = Zotero.getMainWindow();
    if (win?.requestAnimationFrame) {
      return win.requestAnimationFrame(cb);
    }
  } catch (_err) { /* ignored */ }
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
}

/** Mirrors `requestNextFrame` by clearing via native RAF or `clearTimeout`. */
export function cancelFrame(handle: number) {
  try {
    const win = Zotero.getMainWindow();
    if (win?.cancelAnimationFrame) {
      win.cancelAnimationFrame(handle);
      return;
    }
  } catch (_err) { /* ignored */ }
  clearTimeout(handle);
}

// ========== RENDER (FOLDER ROWS ONLY) ==========

/**
 * Public entry point: clears previous UI and rebuilds folder rows for
 * whichever collection Zotero currently has selected.
 */
export function renderFolderRowsForCurrentCollection() {
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

  renderFolderRows(subcollections, { resetScroll: shouldResetScroll });
}

/**
 * We inject into the scrollable body so rows behave like list entries.
 * - Find items body (rowgroup)
 * - Prepend our container
 * - Align via CSS grid to header widths
 */
/**
 * Injects folder rows into the scrollable items body, sizing each column to match
 * the native header cells and optionally resetting the scroll position.
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
    detachFolderRowsResizeObserver();
    setExtraTopOffset(0);
    return;
  }
  body.setAttribute("data-zfe-items-body", "true");
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
  row.className = "zfe-folder-row";
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
    rerenderTrigger(260);
  };
  row.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      navigateToCollection(subCol.id);
      rerenderTrigger(260);
      return;
    }
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const delta = ev.key === "ArrowDown" ? 1 : -1;
      const handled = handleFolderRowArrowNavigation(delta, row);
      if (handled) {
        ev.preventDefault();
        ev.stopPropagation();
      }
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
      } catch (_err) { /* ignored */ }

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
  } catch (_err) { /* ignored */ }
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
  } catch (_err) {
    folderRowsResizeObserver = null;
  }
}

function detachFolderRowsResizeObserver() {
  if (!folderRowsResizeObserver) return;
  try {
    folderRowsResizeObserver.disconnect();
  } catch (_err) { /* ignored */ }
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
      } catch (_err) { /* ignored */ }
      windowResizeCleanup = null;
    };
  } catch (_err) { /* ignored */ }
}

export function teardownWindowResizeListener() {
  if (!windowResizeCleanup) return;
  try {
    windowResizeCleanup();
  } catch (_err) { /* ignored */ }
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
  } else {
    // Unable to patch scroll behavior; continue without compensation.
  }
}

export function teardownScrollTopCompensation() {
  if (!scrollCompensationState) return;
  try {
    scrollCompensationState.teardown();
  } catch (_err) { /* ignored */ }
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
      } catch (_err) {
        return sanitizeScrollValue((scroller as any).__zfeRawScrollTop ?? 0);
      }
    };

    const writeNative = (value: number) => {
      try {
        descriptor!.set!.call(scroller, value);
      } catch (_err) {
        try {
          (scroller as any).__zfeRawScrollTop = value;
        } catch (_err) { /* ignored */ }
      }
    };

    return {
      teardown: () => {
        try {
          delete (scroller as any).scrollTop;
        } catch (_err) {
          try {
            Object.defineProperty(scroller, "scrollTop", descriptor!);
          } catch (_err) { /* ignored */ }
        }
      },
      readNative,
      writeNative,
    };
  } catch (_err) {
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
  } catch (_err) {
    return null;
  }

  if (!keys.length) return null;

  const proxy = createScrollerProxy(scroller);
  keys.forEach((key) => {
    try {
      (itemsView as any)[key] = proxy;
    } catch (_err) { /* ignored */ }
  });

  return {
    teardown: () => {
      keys.forEach((key) => {
        try {
          (itemsView as any)[key] = scroller;
        } catch (_err) { /* ignored */ }
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
  } catch (_err) {
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
    } catch (_err) { /* ignored */ }
  }
  try {
    scroller.scrollTop = numeric;
    return true;
  } catch (_err) {
    return false;
  }
}

function attachItemsBodyListeners(body: HTMLElement) {
  detachItemsBodyListeners();
  itemsBodyElement = body;
  const keydownTarget =
    (body.closest(".virtualized-table") as HTMLElement | null) || body;
  itemsKeyboardTarget = keydownTarget;
  const handleFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    itemsPaneHasFocus = true;
    if (target.closest(".zfe-folder-row")) {
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
    if (target.closest(".zfe-folder-row")) {
      itemsPaneHasFocus = true;
      refreshSelectedFolderRowAppearance();
      return;
    }
    if (selectedFolderRow) setSelectedFolderRow(null);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp") return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!folderRows.length) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".zfe-folder-row")) return;
    const row =
      (target.closest('[role="row"], [role="treeitem"], .row') as HTMLElement | null) ||
      getFocusedNativeRow();
    if (!row || !isFirstNativeRow(row)) return;
    event.preventDefault();
    event.stopPropagation();
    const lastFolder = folderRows[folderRows.length - 1];
    if (lastFolder) setSelectedFolderRow(lastFolder);
  };

  body.addEventListener("focusin", handleFocusIn, true);
  body.addEventListener("focusout", handleFocusOut, true);
  body.addEventListener("mousedown", handleMouseDown, true);
  keydownTarget?.addEventListener("keydown", handleKeyDown, true);
  itemsBodyCleanup = () => {
    body.removeEventListener("focusin", handleFocusIn, true);
    body.removeEventListener("focusout", handleFocusOut, true);
    body.removeEventListener("mousedown", handleMouseDown, true);
    keydownTarget?.removeEventListener("keydown", handleKeyDown, true);
    itemsBodyElement = null;
    itemsKeyboardTarget = null;
    itemsBodyCleanup = null;
  };
}

function detachItemsBodyListeners() {
  if (itemsBodyCleanup) {
    try {
      itemsBodyCleanup();
    } catch (_err) { /* ignored */ }
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

function handleFolderRowArrowNavigation(delta: number, originRow: HTMLElement): boolean {
  if (!folderRows.length) return false;
  const currentIndex = folderRows.indexOf(originRow);
  if (currentIndex === -1) return false;

  const isAtStart = currentIndex === 0;
  const isAtEnd = currentIndex === folderRows.length - 1;

  if (delta < 0 && isAtStart) {
    return true;
  }

  if (delta > 0 && isAtEnd) {
    if (hasNativeItemRows()) {
      setSelectedFolderRow(null);
      const firstNative = getFirstNativeRow();
      if (firstNative) {
        selectNativeRowElement(firstNative);
      }
      return true;
    }
    return true;
  }

  const nextIndex = Math.max(0, Math.min(folderRows.length - 1, currentIndex + delta));
  const nextRow = folderRows[nextIndex];
  if (nextRow && nextRow !== originRow) {
    setSelectedFolderRow(nextRow);
  }
  return true;
}

const NATIVE_ROW_SELECTOR =
  '.windowed-list .row, [role="treeitem"], [role="row"]:not(.zfe-folder-row)';
const NATIVE_FOCUSED_SELECTOR =
  '.windowed-list .row.focused, [role="treeitem"].focused, [role="row"].focused';

function getNativeRows(): HTMLElement[] {
  if (!itemsBodyElement) return [];
  const nodes = itemsBodyElement.querySelectorAll(NATIVE_ROW_SELECTOR);
  const rows: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  nodes.forEach((node: Element) => {
    const element = node as HTMLElement;
    if (!isNativeItemRow(element)) return;
    if (seen.has(element)) return;
    seen.add(element);
    rows.push(element);
  });
  return rows;
}

function getFirstNativeRow(): HTMLElement | null {
  const rows = getNativeRows();
  return rows.length ? rows[0] : null;
}

function hasNativeItemRows(): boolean {
  return getNativeRows().length > 0;
}

function isFirstNativeRow(row: HTMLElement): boolean {
  const rows = getNativeRows();
  if (!rows.length) return false;
  return rows[0] === row;
}

function getFocusedNativeRow(): HTMLElement | null {
  if (!itemsBodyElement) return null;
  return itemsBodyElement.querySelector(NATIVE_FOCUSED_SELECTOR) as HTMLElement | null;
}

function clearNativeRowFocus() {
  if (!itemsBodyElement) return;
  const nodes = itemsBodyElement.querySelectorAll(NATIVE_FOCUSED_SELECTOR);
  for (const node of Array.from(nodes)) {
    (node as HTMLElement).classList.remove("focused");
  }
}

function isNativeItemRow(node: HTMLElement): boolean {
  if (!node) return false;
  if (node.classList.contains("zfe-folder-row")) return false;
  const role = node.getAttribute("role");
  if (role === "treeitem") return true;
  if (role === "row") return true;
  return node.classList.contains("row");
}

function selectNativeRowElement(row: HTMLElement) {
  const index = getNativeRowIndex(row);
  const pane = getPane();
  const itemsView = pane?.itemsView;
  if (!itemsView) return;
  const selection =
    itemsView.selection ||
    itemsView.tree?.selection ||
    itemsView.tree?.view?.selection ||
    itemsView._treebox?.selection ||
    itemsView._treebox?.view?.selection;

  if (index != null) {
    try {
      if (selection?.clearAndSelect) {
        selection.clearAndSelect(index);
      } else if (selection?.select) {
        selection.select(index);
      }
    } catch (_err) { /* ignored */ }
  } else {
    try {
      row.click();
    } catch (_err) { /* ignored */ }
  }

  focusItemsTreeContainer();
}

function getNativeRowIndex(row: HTMLElement): number | null {
  const ariaIndex = row.getAttribute("aria-rowindex");
  if (ariaIndex) {
    const parsed = Number(ariaIndex);
    if (Number.isFinite(parsed)) return parsed - 1;
  }
  const dataIndex = (row as any)?.dataset?.index;
  if (dataIndex != null) {
    const parsed = Number(dataIndex);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (row.id) {
    const match = row.id.match(/row-(\d+)/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function getItemsKeyboardTarget(): HTMLElement | null {
  if (!itemsKeyboardTarget && itemsBodyElement) {
    itemsKeyboardTarget =
      (itemsBodyElement.closest(".virtualized-table") as HTMLElement | null) ||
      itemsBodyElement;
  }
  return itemsKeyboardTarget;
}

function focusItemsTreeContainer() {
  const target = getItemsKeyboardTarget();
  if (!target) return;
  try {
    target.focus();
  } catch (_err) { /* ignored */ }
}

function blurItemsTreeContainer() {
  const target = getItemsKeyboardTarget();
  if (!target) return;
  try {
    target.blur();
  } catch (_err) { /* ignored */ }
}

function setSelectedFolderRow(row: HTMLElement | null) {
  if (selectedFolderRow === row) return;
  if (selectedFolderRow) {
    const previousColor = selectedFolderRow.dataset.stripeColor || "";
    selectedFolderRow.style.background = previousColor;
    selectedFolderRow.classList.remove("zfe-folder-row--selected");
    selectedFolderRow.style.color = FOLDER_ROW_DEFAULT_COLOR;
  }

  selectedFolderRow = row;
  if (!row) {
    itemsPaneHasFocus = false;
    return;
  }

  row.classList.add("zfe-folder-row--selected");
  itemsPaneHasFocus = true;
  blurItemsTreeContainer();
  try {
    row.focus();
  } catch (_err) { /* ignored */ }
  refreshSelectedFolderRowAppearance();
  clearNativeItemSelection();
}

function updateZebraFlipFlag() {
  try {
    const doc = getDocument();
    const tree = doc.getElementById("zotero-items-tree");
    if (!tree) return;
    if (folderRows.length % 2 === 1) {
      tree.setAttribute("data-zfe-flip", "1");
    } else {
      tree.removeAttribute("data-zfe-flip");
    }
  } catch (_err) { /* ignored */ }
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
    clearNativeRowFocus();
  } catch (_err) { /* ignored */ }
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

/** Disconnects ResizeObserver/MutationObserver watching the items header. */
export function detachHeaderObservers() {
  if (headerResizeObserver) {
    try { headerResizeObserver.disconnect(); } catch (_err) { /* ignored */ }
    headerResizeObserver = null;
  }
  if (columnsMutationObserver) {
    try { columnsMutationObserver.disconnect(); } catch (_err) { /* ignored */ }
    columnsMutationObserver = null;
  }
}

// ========== BODY LOOKUP / CLEANUP ==========

/**
 * Locates the scrollable container that holds Zotero's item rows.
 * Falls back through heuristics because the host DOM differs per version/theme.
 */
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
    } catch (_err) {
      return null;
    }
  })();

  const docWin = ((): Window | null => {
    try {
      return getDocument().defaultView;
    } catch (_err) {
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

/**
 * Removes every injected row and associated listeners/timers so the UI can rebuild cleanly.
 */
export function removeFolderRows() {
  folderRows.forEach((row) => {
    try {
      row.remove();
    } catch (_err) { /* ignored */ }
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

