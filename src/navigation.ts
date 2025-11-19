/**
 * Central navigation/breadcrumb UI logic for the Zotero items pane.
 * Handles navigation history, breadcrumb rendering, overflow menus, and
 * the wiring to move the actual Zotero collection selection around.
 */
import { getDocument, getPane } from "./env";

type NavigationDeps = {
  scheduleRerender: (delay?: number) => void;
};

// Mutable dependency bag so the module stays mostly pure/testable.
const deps: NavigationDeps = {
  scheduleRerender: () => { },
};

/**
 * Allows consumers to supply their own implementations (mostly useful in tests).
 */
export function configureNavigation(newDeps: NavigationDeps) {
  deps.scheduleRerender = newDeps.scheduleRerender;
}

// --- history ---
// Keeps a lightweight back/forward stack matching Zotero's selection history.
const navHistory: number[] = [];
let navIndex = -1;
const pendingHistoryNavigations: number[] = [];
let navStripEnabled = true;
let navStripCleanup: (() => void) | null = null;
let navOverflowMenuCleanup: (() => void) | null = null;
let navOverflowMenuAnchor: HTMLElement | null = null;

// Minimal representation of a location in the breadcrumb trail.
type PathSeg = { label: string; collectionID: number | null };

// Reference to DOM nodes that belong to a breadcrumb entry.
type BreadcrumbNode = {
  seg: PathSeg;
  crumb: HTMLSpanElement;
  separator: HTMLSpanElement | null;
};

// Breadcrumb overflow management constants.
const BREADCRUMB_TAIL_CLAMP_CLASS = "zfe-crumb-tail-clamped";
const BREADCRUMB_SCROLL_SETTLE_DELAY = 200;
const BREADCRUMB_RESIZE_RELEASE_TIMEOUT = 1200;
type BreadcrumbScrollTarget = "start" | "end";
type BreadcrumbScrollController = {
  target: BreadcrumbScrollTarget;
  applied: BreadcrumbScrollTarget;
  timer: number | null;
  timerOwner: Window | null;
  resizeLocked: boolean;
};
// Track scroll controllers for each breadcrumb container so we can reuse timers.
const breadcrumbScrollControllers = new WeakMap<HTMLElement, BreadcrumbScrollController>();
const breadcrumbControllerElements = new Set<HTMLElement>();
// Used to temporarily pause expensive overflow calculations while resizing.
let breadcrumbResizeLockActive = false;
let breadcrumbResizeUnlockTimer: number | null = null;
let breadcrumbResizeUnlockTimerOwner: Window | null = null;

/** Whether the UI should be mounted at all. */
export function isNavStripEnabled() {
  return navStripEnabled;
}

/** Toggles the nav strip and tears it down when disabled. */
export function setNavStripEnabled(value: boolean) {
  if (navStripEnabled === value) return;
  navStripEnabled = value;
  if (!value) {
    removeNavStrip();
  } else {
    updateNavStrip();
  }
}

/** Selects the parent collection of the currently selected node. */
export function navigateUp() {
  const pane = getPane();
  const cur = pane?.getSelectedCollection();
  if (!cur?.parentID) return;
  navigateToCollection(cur.parentID);
  deps.scheduleRerender(120);
}

/**
 * Parses manual input from the breadcrumb path textbox and navigates there if possible.
 */
function commitPath(raw: string) {
  const target = resolveCollectionByPath(raw.trim());
  const doc = getDocument();
  const strip = doc.getElementById("zfe-nav-strip") as any;
  if (target) {
    navigateToCollection(target.id);
    deps.scheduleRerender(120);
  }
  if (strip?.__stopEditPath) strip.__stopEditPath();
}

/**
 * Attempts to resolve a string path (Library\Subcollection) into a Zotero collection.
 */
function resolveCollectionByPath(input: string): any | null {
  const parts = input
    .split(/[\\/]/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const pane = getPane();
  const sel = pane?.getSelectedCollection();
  const currentLibID = sel?.libraryID ?? Zotero.Libraries.userLibraryID;

  let libID = currentLibID;
  const allLibs = Zotero.Libraries.getAll();
  const first = parts[0].toLowerCase();
  const libHit = allLibs.find((l: any) => (l.name || "").toLowerCase() === first);
  let idx = 0;
  if (libHit) { libID = libHit.libraryID; idx = 1; }

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

/** Builds the breadcrumb segments for the currently selected collection. */
function getPathSegments(selected: any): PathSeg[] {
  const segs: PathSeg[] = [];
  if (!selected) {
    return [{ label: "Library", collectionID: null }];
  }
  const lib = Zotero.Libraries.get(selected.libraryID);
  const libName = (lib as any)?.name || "Library";
  segs.push({ label: libName, collectionID: null });

  const chain: any[] = [];
  let cur = selected;
  while (cur) { chain.unshift(cur); if (!cur.parentID) break; cur = Zotero.Collections.get(cur.parentID); }
  chain.forEach(col => segs.push({ label: col.name, collectionID: col.id }));
  return segs;
}

/** Returns a printable string representation of the current breadcrumb path. */
export function getCurrentPathString(): string {
  const sel = getPane()?.getSelectedCollection();
  if (!sel) return "Library";
  const segs = getPathSegments(sel).map(s => s.label);
  return segs.join("\\");
}

/** Injects stylesheet rules once so the strip renders correctly in Zotero. */
function ensureNavStripCSS(doc: Document) {
  if (doc.getElementById("zfe-nav-strip-style")) return;
  const s = doc.createElement("style");
  s.id = "zfe-nav-strip-style";
  s.textContent = `
  /* container */
  #zfe-nav-strip {
    display:flex; align-items:center; gap:8px;
    padding:6px 8px;
    border-bottom:1px solid var(--color-border, #dadada);
    background:var(--material-toolbar, #f9f9f9);
    position:sticky; top:0; z-index: 1;
    box-sizing:border-box;
    max-width:100%;
  }
  #zfe-nav-strip button {
    border:none; background:transparent; padding:4px 6px; border-radius:6px;
    font-size:14px; line-height:1; cursor:pointer;
  }
  #zfe-nav-strip button:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  #zfe-nav-strip button:disabled { opacity:.35; cursor:default; }
  #zfe-nav-path {
    flex:1 1 240px; min-width:0; display:flex; align-items:center; gap:6px;
    padding:2px 6px; border-radius:6px; background: var(--material-button, #fff); border:1px solid var(--color-border, #dadada);
    overflow:hidden;
  }
  #zfe-nav-strip .zfe-nav-flex-spacer {
    flex:0 0 12px;
    min-width:12px;
    height:1px;
    pointer-events:none;
  }
  #zfe-nav-breadcrumbs {
    display:flex; align-items:center; gap:4px;
    flex-wrap:nowrap;
    overflow:hidden;
    min-width:0;
    white-space:nowrap;
  }
  .zfe-crumb {
    display:inline-flex; align-items:center; gap:6px; white-space:nowrap; padding:2px 4px; border-radius:4px; cursor:pointer;
    flex-shrink:0;
  }
  .zfe-crumb.${BREADCRUMB_TAIL_CLAMP_CLASS} {
    flex-shrink:1;
    min-width:0;
    max-width:100%;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .zfe-crumb:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  .zfe-crumb.zfe-nav-menu-open { background: var(--accent-blue20, rgba(64,114,229,.2)); }
  .zfe-crumb-ellipsis { font-weight:600; }
  .zfe-crumb-sep {
    opacity:.6;
    user-select:none;
    margin:0 4px;
  }
  .zfe-nav-overflow-menu {
    position:fixed;
    display:flex;
    flex-direction:column;
    background: var(--material-button, #fff);
    border:1px solid var(--color-border, #dadada);
    border-radius:6px;
    box-shadow:0 6px 20px rgba(0,0,0,.15);
    padding:4px 0;
    z-index:2147483647;
    min-width:160px;
  }
  .zfe-nav-overflow-menu button {
    background:transparent;
    border:none;
    text-align:left;
    padding:6px 12px;
    font:inherit;
    cursor:pointer;
  }
  .zfe-nav-overflow-menu button:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  .zfe-nav-overflow-menu button:disabled { opacity:.5; cursor:default; }
  #zfe-nav-input {
    width:100%; border:none; outline:none; background:transparent; font:inherit; padding:0;
  }
  #zfe-nav-path.editing { outline:2px solid var(--accent-blue30, rgba(64,114,229,.3)); }
  `;
  const host = doc.head || doc.querySelector("head") || doc.documentElement;
  if (host) host.appendChild(s);
}

/**
 * Records a newly visited collection so the back/forward buttons can use it.
 * Guards against duplicate entries and waits for pending async navigation.
 */
export function pushToHistory(id: number | null) {
  if (id == null) return;
  if (
    pendingHistoryNavigations.length &&
    pendingHistoryNavigations[0] === id
  ) {
    pendingHistoryNavigations.shift();
    updateNavButtonsEnabled();
    return;
  }
  if (pendingHistoryNavigations.length) {
    return;
  }
  if (navIndex >= 0 && navHistory[navIndex] === id) {
    updateNavButtonsEnabled();
    return;
  }
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

// Quick bounds-check helper for history navigation.
function canGo(delta: -1 | 1) {
  const i = navIndex + delta;
  return i >= 0 && i < navHistory.length;
}

/** Moves back/forward in the custom history stack. */
export function navigateHistory(delta: -1 | 1) {
  if (!canGo(delta)) return;
  navIndex += delta;
  const id = navHistory[navIndex];
  pendingHistoryNavigations.push(id);
  navigateToCollection(id);
  deps.scheduleRerender(120);
  updateNavButtonsEnabled();
}

/**
 * Mounts the toolbar-like navigation strip into the Zotero items pane.
 * Does nothing if the UI already exists or the pane cannot be resolved.
 */
export function mountNavStrip(doc: Document) {
  if (!navStripEnabled) {
    removeNavStrip(doc);
    return;
  }
  if (doc.getElementById("zfe-nav-strip")) return;

  const pane = getPane();
  const root = pane?.itemsView?.domEl as HTMLElement | null;
  if (!root) return;

  const windowed =
    root.querySelector(".virtualized-table-list") ||
    root.querySelector("#virtualized-table-list") ||
    root.querySelector(".windowed-list");
  const itemsToolbar =
    doc.getElementById("zotero-items-toolbar") ||
    root.querySelector<HTMLElement>("#zotero-items-toolbar");

  const strip = doc.createElement("div");
  strip.id = "zfe-nav-strip";
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

  const backBtn = createNavButton(doc, "zfe-nav-back", "Back (Alt+Left)", "\u2190");
  const fwdBtn = createNavButton(doc, "zfe-nav-forward", "Forward (Alt+Right)", "\u2192");
  const upBtn = createNavButton(doc, "zfe-nav-up", "Up (Alt+Up)", "\u2191");
  buttonsWrap.append(backBtn, fwdBtn, upBtn);

  const pathBox = doc.createElement("div");
  pathBox.id = "zfe-nav-path";
  pathBox.style.minWidth = "0";
  pathBox.style.flex = "1";
  pathBox.style.display = "flex";
  pathBox.style.alignItems = "center";
  pathBox.style.gap = "6px";
  pathBox.style.padding = "2px 6px";
  pathBox.style.borderRadius = "6px";
  pathBox.style.background = "var(--material-button, #fff)";
  pathBox.style.border = "1px solid var(--color-border, #dadada)";
  pathBox.title = "Click to edit / Ctrl+L to focus";

  const crumbs = doc.createElement("div");
  crumbs.id = "zfe-nav-breadcrumbs";
  crumbs.style.display = "flex";
  crumbs.style.alignItems = "center";
  crumbs.style.gap = "4px";
  crumbs.style.flexWrap = "nowrap";
  crumbs.style.overflow = "hidden";
  crumbs.style.minWidth = "0";
  crumbs.style.whiteSpace = "nowrap";
  crumbs.style.flex = "1";

  const input = doc.createElement("input");
  input.id = "zfe-nav-input";
  input.style.display = "none";
  input.style.flex = "1";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.background = "transparent";

  const pathRow = doc.createElement("div");
  pathRow.style.display = "flex";
  pathRow.style.alignItems = "center";
  pathRow.style.gap = "6px";
  pathRow.style.flex = "1 1 auto";
  pathRow.style.minWidth = "0";
  pathRow.style.boxSizing = "border-box";

  pathBox.append(crumbs, input);
  pathRow.append(pathBox);

  const flexSpacer = doc.createElement("div");
  flexSpacer.className = "zfe-nav-flex-spacer";
  flexSpacer.setAttribute("aria-hidden", "true");

  strip.append(buttonsWrap, flexSpacer, pathRow);
  const cleanupTasks: Array<() => void> = [];

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

  pathBox.addEventListener("click", () => {
    if (pathBox.classList.contains("editing")) return;
    startEditPath(true);
  });
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

  const widthCleanup = setupNavStripWidthTracking(doc, strip);
  if (widthCleanup) cleanupTasks.push(widthCleanup);

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
  cleanupTasks.push(() => {
    doc.removeEventListener("keydown", keydownHandler);
  });
  navStripCleanup = () => {
    cleanupTasks.splice(0).forEach(fn => {
      try {
        fn();
      } catch (_err) { /* ignored */ }
    });
    navStripCleanup = null;
  };

  // Switches the breadcrumb display into an editable textbox.
  function startEditPath(selectAll = false) {
    closeBreadcrumbOverflowMenu();
    pathBox.classList.add("editing");
    crumbs.style.display = "none";
    input.style.display = "block";
    input.value = getCurrentPathString();
    if (selectAll) {
      input.select();
    } else {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // Restores the breadcrumb display after editing.
  function stopEditPath() {
    pathBox.classList.remove("editing");
    crumbs.style.display = "flex";
    input.style.display = "none";
  }

  (strip as any).__stopEditPath = stopEditPath;
  ensureNavStripCSS(doc);
  updateNavButtonsEnabled();
}

/** Small helper to standardize nav buttons (back/forward/up). */
function createNavButton(doc: Document, id: string, title: string, glyph: string) {
  const btn = doc.createElement("button");
  btn.id = id;
  btn.textContent = glyph;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  return btn;
}

/**
 * Rebuilds the breadcrumb DOM to reflect the currently selected collection.
 * Can be invoked with a fake selection for testing.
 */
export function updateNavStrip(selected?: any) {
  const doc = getDocument();
  if (!navStripEnabled) {
    removeNavStrip(doc);
    return;
  }
  const strip = doc.getElementById("zfe-nav-strip");
  if (!strip) {
    mountNavStrip(doc);
    return updateNavStrip(selected);
  }
  const crumbs = doc.getElementById("zfe-nav-breadcrumbs") as HTMLElement | null;
  if (!crumbs) return;
  closeBreadcrumbOverflowMenu();
  crumbs.textContent = "";
  const sel = selected ?? getPane()?.getSelectedCollection();
  const segs = getPathSegments(sel);
  const crumbNodes: BreadcrumbNode[] = [];
  segs.forEach((seg, idx) => {
    let separator: HTMLSpanElement | null = null;
    if (idx > 0) {
      const sep = doc.createElement("span");
      sep.className = "zfe-crumb-sep";
      sep.textContent = ">";
      crumbs.appendChild(sep);
      separator = sep;
    }
    const crumb = doc.createElement("span");
    crumb.className = "zfe-crumb";
    crumb.textContent = seg.label;
    crumb.title = seg.label;
    crumb.tabIndex = 0;
    crumb.setAttribute("data-zfe-label", seg.label);
    if (seg.collectionID != null) {
      crumb.setAttribute("data-zfe-collection-id", String(seg.collectionID));
    } else {
      crumb.removeAttribute("data-zfe-collection-id");
    }
    crumb.addEventListener("click", () => {
      if (seg.collectionID != null) {
        navigateToCollection(seg.collectionID);
        deps.scheduleRerender(120);
      }
    });
    crumb.addEventListener("keydown", (ev: KeyboardEvent) => {
      if ((ev.key === "Enter" || ev.key === " ") && seg.collectionID != null) {
        ev.preventDefault();
        navigateToCollection(seg.collectionID);
        deps.scheduleRerender(120);
      }
    });
    crumbs.appendChild(crumb);
    crumbNodes.push({ seg, crumb, separator });
  });
  scheduleBreadcrumbOverflowMeasurement(doc, crumbs, crumbNodes);
  updateNavButtonsEnabled();
}

/** Enables/disables back/forward buttons depending on available history. */
function updateNavButtonsEnabled() {
  const doc = getDocument();
  const backBtn = doc.getElementById("zfe-nav-back") as HTMLButtonElement | null;
  const fwdBtn = doc.getElementById("zfe-nav-forward") as HTMLButtonElement | null;
  if (backBtn) backBtn.disabled = !canGo(-1);
  if (fwdBtn) fwdBtn.disabled = !canGo(1);
}

/**
 * Imperatively moves Zotero's selection to the target collection.
 * Falls back through multiple internal APIs because the host UI differs by version.
 */
export function navigateToCollection(collectionID: number) {
  const pane = getPane();
  if (!pane?.collectionsView) {
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
      deps.scheduleRerender(120);
    }, 200);

  } catch (_err) {
    // Ignore navigation errors; Zotero will continue functioning.
  }
}

/**
 * Ensures every ancestor of the target collection is expanded,
 * otherwise the later selection cannot find the target row.
 */
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
  } catch (_err) {
    // Ignore expansion errors; children might already be visible.
  }
}

/**
 * Observes relevant layout containers so the strip can resize with the Zotero UI.
 * Returns a cleanup function that removes observers/listeners.
 */
function setupNavStripWidthTracking(doc: Document, strip: HTMLElement) {
  const win = doc.defaultView;
  const schedule = (() => {
    let pending = false;
    const run = () => {
      pending = false;
      updateNavStripWidth(doc, strip);
      refreshBreadcrumbOverflow(doc);
    };
    return () => {
      if (pending) return;
      pending = true;
      if (win?.requestAnimationFrame) {
        win.requestAnimationFrame(run);
      } else {
        setTimeout(run, 0);
      }
    };
  })();

  schedule();

  const cleanupFns: Array<() => void> = [];

  if (win?.ResizeObserver) {
    const observer = new win.ResizeObserver(() => schedule());
    const observed = new Set<HTMLElement>();
    const maybeObserve = (el: HTMLElement | null) => {
      if (el && !observed.has(el)) {
        observer.observe(el);
        observed.add(el);
      }
    };
    maybeObserve(doc.getElementById("zotero-items-pane") as HTMLElement | null);
    maybeObserve(doc.getElementById("zotero-items-pane-container") as HTMLElement | null);
    maybeObserve(doc.getElementById("zotero-layout-switcher") as HTMLElement | null);
    if (observed.size) {
      cleanupFns.push(() => observer.disconnect());
    }
  }

  if (win) {
    const handleResize = () => {
      beginBreadcrumbResizeHold(win);
      schedule();
      scheduleBreadcrumbResizeRelease(win);
    };
    win.addEventListener("resize", handleResize);
    cleanupFns.push(() => win.removeEventListener("resize", handleResize));

    const releaseResizeHold = () => {
      if (breadcrumbResizeLockActive) {
        endBreadcrumbResizeHold();
      }
    };
    ["mouseup", "pointerup", "touchend"].forEach(type => {
      win.addEventListener(type, releaseResizeHold, true);
      cleanupFns.push(() => win.removeEventListener(type, releaseResizeHold, true));
    });
  }

  if (!cleanupFns.length) {
    return () => { };
  }
  return () => {
    cleanupFns.splice(0).forEach(fn => {
      try {
        fn();
      } catch (_err) { /* ignored */ }
    });
  };
}

/** Applies the current container width to the nav strip element. */
function updateNavStripWidth(doc: Document, strip?: HTMLElement | null) {
  const nav = strip ?? (doc.getElementById("zfe-nav-strip") as HTMLElement | null);
  if (!nav) return;
  const hostRect = getNavHostRect(doc);
  if (hostRect && hostRect.width > 0) {
    nav.style.maxWidth = `${hostRect.width}px`;
    nav.style.width = "100%";
  } else {
    nav.style.maxWidth = "";
    nav.style.width = "100%";
  }
}

/** Finds the bounding rect of the Zotero items pane (or best available fallback). */
function getNavHostRect(doc: Document): DOMRect | null {
  const itemsPane = doc.getElementById("zotero-items-pane") as HTMLElement | null;
  if (itemsPane) {
    const rect = itemsPane.getBoundingClientRect();
    if (rect.width) return rect;
  }
  const fallback = doc.getElementById("zotero-items-pane-container") as HTMLElement | null;
  return fallback?.getBoundingClientRect() ?? null;
}

/**
 * Repeatedly measures the breadcrumb row to figure out which crumbs should be hidden.
 * Called on resize, theme changes, and when the crumb list is rebuilt.
 */
function refreshBreadcrumbOverflow(doc: Document) {
  const crumbs = doc.getElementById("zfe-nav-breadcrumbs") as HTMLElement | null;
  if (!crumbs || crumbs.style.display === "none" || !crumbs.isConnected) return;
  closeBreadcrumbOverflowMenu();
  removeBreadcrumbEllipsis(crumbs);
  resetBreadcrumbScroll(crumbs);
  const nodes = collectBreadcrumbNodesFromDOM(doc, crumbs);
  if (!nodes.length) return;
  nodes.forEach(node => {
    node.crumb.style.display = "";
    if (node.separator) node.separator.style.display = "";
    clearBreadcrumbTailClamp(node);
  });
  scheduleBreadcrumbOverflowMeasurement(doc, crumbs, nodes, false);
}

/** Removes the previously inserted ellipsis node before re-measuring overflow. */
function removeBreadcrumbEllipsis(crumbsEl: HTMLElement) {
  const toRemove = crumbsEl.querySelectorAll(".zfe-crumb-ellipsis, .zfe-crumb-ellipsis-sep");
  toRemove.forEach((el: Element) => {
    if (el.parentElement === crumbsEl) {
      el.remove();
    }
  });
}

/** Re-hydrates breadcrumb metadata by reading attributes from the DOM. */
function collectBreadcrumbNodesFromDOM(doc: Document, crumbsEl: HTMLElement): BreadcrumbNode[] {
  const nodes: BreadcrumbNode[] = [];
  let child = crumbsEl.firstElementChild;
  while (child) {
    if (
      child.classList.contains("zfe-crumb") &&
      !child.classList.contains("zfe-crumb-ellipsis")
    ) {
      const crumb = child as HTMLSpanElement;
      const prev = crumb.previousElementSibling;
      const separator =
        prev && prev.classList.contains("zfe-crumb-sep") ? (prev as HTMLSpanElement) : null;
      const label = crumb.getAttribute("data-zfe-label") || crumb.textContent || "";
      const collectionAttr = crumb.getAttribute("data-zfe-collection-id");
      const seg: PathSeg = {
        label,
        collectionID: collectionAttr && collectionAttr.length ? Number(collectionAttr) : null,
      };
      nodes.push({ seg, crumb, separator });
    }
    child = child.nextElementSibling;
  }
  return nodes;
}

/** Clears the ellipsis/truncation applied to the last breadcrumb. */
function clearBreadcrumbTailClamp(node: BreadcrumbNode) {
  node.crumb.classList.remove(BREADCRUMB_TAIL_CLAMP_CLASS);
  node.crumb.style.removeProperty("maxWidth");
  node.crumb.textContent = node.seg.label;
}

/**
 * Applies ellipsis/truncation to the deepest breadcrumb node so the tail is always visible.
 */
function clampBreadcrumbTail(node: BreadcrumbNode | undefined, crumbsEl: HTMLElement): boolean {
  if (!node) return false;
  const crumb = node.crumb;
  const available = getTailAvailableWidth(crumbsEl, crumb);
  if (!available) return false;
  const label = node.seg.label;
  crumb.textContent = label;
  crumb.classList.add(BREADCRUMB_TAIL_CLAMP_CLASS);
  crumb.style.maxWidth = `${Math.floor(available)}px`;
  if (crumb.scrollWidth <= crumb.clientWidth + 1) return true;
  for (let idx = 1; idx < label.length; idx++) {
    crumb.textContent = `\u2026${label.slice(idx)}`;
    if (crumb.scrollWidth <= crumb.clientWidth + 1) return true;
  }
  return true;
}

/** Calculates how much width is left for the final breadcrumb after hiding others. */
function getTailAvailableWidth(crumbsEl: HTMLElement, tail: HTMLElement) {
  const explicitMax = parseFloat(crumbsEl.style.maxWidth || "") || 0;
  const total =
    crumbsEl.clientWidth ||
    crumbsEl.getBoundingClientRect().width ||
    explicitMax ||
    0;
  if (!total) return 0;
  const doc = tail.ownerDocument;
  const win = doc?.defaultView;
  let occupied = 0;
  const children = Array.from(crumbsEl.children) as HTMLElement[];
  children.forEach(child => {
    if (child === tail) return;
    const display = win?.getComputedStyle?.(child)?.display ?? "";
    if (display === "none") return;
    occupied += child.getBoundingClientRect().width;
  });
  const available = total - occupied - 4;
  return available > 0 ? available : 0;
}

/** Resets scroll state when the breadcrumb UI is rebuilt from scratch. */
function resetBreadcrumbScroll(crumbsEl: HTMLElement) {
  crumbsEl.scrollLeft = 0;
  const controller = breadcrumbScrollControllers.get(crumbsEl);
  if (controller) {
    cancelBreadcrumbScrollTimer(controller);
    controller.target = "start";
    controller.applied = "start";
  }
}

/** Scrolls to the end so the latest crumb remains visible when overflow happens. */
function scrollBreadcrumbsToEnd(crumbsEl: HTMLElement) {
  const maxScroll =
    crumbsEl.scrollWidth -
    (crumbsEl.clientWidth || crumbsEl.getBoundingClientRect().width || 0);
  crumbsEl.scrollLeft = maxScroll > 0 ? maxScroll : 0;
  const controller = breadcrumbScrollControllers.get(crumbsEl);
  if (controller) {
    cancelBreadcrumbScrollTimer(controller);
    controller.target = "end";
    controller.applied = "end";
  }
}

/**
 * Keeps breadcrumbs scrolled to either the start or the end depending on overflow state.
 * Uses a timer to avoid fighting with native scrolling during resize.
 */
function updateBreadcrumbScrollAlignment(
  crumbsEl: HTMLElement,
  alignEnd: boolean,
  immediate: boolean,
) {
  const controller = ensureBreadcrumbScrollController(crumbsEl);
  controller.target = alignEnd ? "end" : "start";
  if (controller.resizeLocked && !immediate) {
    return;
  }
  const win = crumbsEl.ownerDocument?.defaultView ?? controller.timerOwner ?? null;
  cancelBreadcrumbScrollTimer(controller);
  const apply = () => {
    applyBreadcrumbScrollState(crumbsEl, controller.target);
    controller.applied = controller.target;
  };
  if (immediate || !win) {
    apply();
    return;
  }
  if (controller.applied === controller.target) {
    return;
  }
  controller.timerOwner = win;
  controller.timer = win.setTimeout(() => {
    controller.timer = null;
    controller.timerOwner = null;
    apply();
  }, BREADCRUMB_SCROLL_SETTLE_DELAY);
}

/** Applies the requested scroll alignment immediately. */
function applyBreadcrumbScrollState(el: HTMLElement, target: BreadcrumbScrollTarget) {
  if (target === "end") {
    scrollBreadcrumbsToEnd(el);
  } else {
    resetBreadcrumbScroll(el);
  }
}

/** Lazily creates (and memoizes) controller state for a breadcrumb element. */
function ensureBreadcrumbScrollController(crumbsEl: HTMLElement): BreadcrumbScrollController {
  let controller = breadcrumbScrollControllers.get(crumbsEl);
  if (!controller) {
    controller = {
      target: "start",
      applied: "start",
      timer: null,
      timerOwner: null,
      resizeLocked: false,
    };
    breadcrumbScrollControllers.set(crumbsEl, controller);
    breadcrumbControllerElements.add(crumbsEl);
  }
  return controller;
}

/** Clears any pending scroll timers tied to a controller. */
function cancelBreadcrumbScrollTimer(controller: BreadcrumbScrollController) {
  if (controller.timer != null && controller.timerOwner) {
    try {
      controller.timerOwner.clearTimeout(controller.timer);
    } catch (_err) { /* ignored */ }
  }
  controller.timer = null;
  controller.timerOwner = null;
}

/** Helper to iterate over every live breadcrumb controller entry. */
function forEachBreadcrumbController(
  callback: (crumbsEl: HTMLElement, controller: BreadcrumbScrollController) => void,
) {
  breadcrumbControllerElements.forEach(el => {
    const controller = breadcrumbScrollControllers.get(el);
    if (!controller || !el.isConnected) {
      breadcrumbControllerElements.delete(el);
      breadcrumbScrollControllers.delete(el);
      return;
    }
    callback(el, controller);
  });
}

/** Fully tears down the controller bookkeeping for a breadcrumb element. */
function disposeBreadcrumbScrollController(crumbsEl: HTMLElement, win?: Window | null) {
  const controller = breadcrumbScrollControllers.get(crumbsEl);
  if (!controller) return;
  if (controller.timer != null && (win ?? controller.timerOwner)) {
    try {
      (win ?? controller.timerOwner)?.clearTimeout(controller.timer);
    } catch (_err) { /* ignored */ }
  }
  breadcrumbScrollControllers.delete(crumbsEl);
  breadcrumbControllerElements.delete(crumbsEl);
}

/**
 * Temporarily suspends scroll adjustments during drag-resizes so the UI feels stable.
 */
function beginBreadcrumbResizeHold(win?: Window | null) {
  if (breadcrumbResizeLockActive) return;
  breadcrumbResizeLockActive = true;
  if (breadcrumbResizeUnlockTimer != null && (win ?? breadcrumbResizeUnlockTimerOwner)) {
    try {
      (win ?? breadcrumbResizeUnlockTimerOwner)?.clearTimeout(breadcrumbResizeUnlockTimer);
    } catch (_err) { /* ignored */ }
    breadcrumbResizeUnlockTimer = null;
    breadcrumbResizeUnlockTimerOwner = null;
  }
  forEachBreadcrumbController((_, controller) => {
    controller.resizeLocked = true;
  });
}

/** Starts a timer that releases the resize lock after interactions stop. */
function scheduleBreadcrumbResizeRelease(win: Window | null) {
  if (!win) return;
  if (breadcrumbResizeUnlockTimer != null && breadcrumbResizeUnlockTimerOwner) {
    try {
      breadcrumbResizeUnlockTimerOwner.clearTimeout(breadcrumbResizeUnlockTimer);
    } catch (_err) { /* ignored */ }
  }
  breadcrumbResizeUnlockTimerOwner = win;
  breadcrumbResizeUnlockTimer = win.setTimeout(() => {
    breadcrumbResizeUnlockTimer = null;
    breadcrumbResizeUnlockTimerOwner = null;
    endBreadcrumbResizeHold();
  }, BREADCRUMB_RESIZE_RELEASE_TIMEOUT);
}

/** Cancels the resize lock immediately and reapplies the desired scroll alignment. */
function endBreadcrumbResizeHold() {
  if (!breadcrumbResizeLockActive) return;
  breadcrumbResizeLockActive = false;
  if (breadcrumbResizeUnlockTimer != null && breadcrumbResizeUnlockTimerOwner) {
    try {
      breadcrumbResizeUnlockTimerOwner.clearTimeout(breadcrumbResizeUnlockTimer);
    } catch (_err) { /* ignored */ }
    breadcrumbResizeUnlockTimer = null;
    breadcrumbResizeUnlockTimerOwner = null;
  }
  forEachBreadcrumbController((crumbsEl, controller) => {
    controller.resizeLocked = false;
    updateBreadcrumbScrollAlignment(crumbsEl, controller.target === "end", true);
  });
}

/**
 * Defers overflow calculations to the next frame so the layout can settle first.
 */
function scheduleBreadcrumbOverflowMeasurement(
  doc: Document,
  crumbsEl: HTMLElement,
  nodes: BreadcrumbNode[],
  immediateScroll = true,
) {
  if (!nodes.length) return;
  const runner = () => {
    if (!crumbsEl.isConnected) return;
    applyBreadcrumbOverflow(doc, crumbsEl, nodes, { immediateScroll });
  };
  const win = doc.defaultView;
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(runner);
  } else {
    setTimeout(runner, 0);
  }
}

/**
 * Core layout routine that hides breadcrumbs (or truncates the tail) once space runs out.
 */
function applyBreadcrumbOverflow(
  doc: Document,
  crumbsEl: HTMLElement,
  nodes: BreadcrumbNode[],
  options?: { immediateScroll?: boolean },
) {
  const immediateScroll = options?.immediateScroll ?? true;
  const containerWidth = getBreadcrumbAvailableWidth(doc, crumbsEl);
  if (!containerWidth) {
    crumbsEl.style.maxWidth = "";
    updateBreadcrumbScrollAlignment(crumbsEl, false, true);
    return;
  }
  crumbsEl.style.maxWidth = `${containerWidth}px`;
  const hidden: BreadcrumbNode[] = [];
  const isOverflowing = () => crumbsEl.scrollWidth > containerWidth + 1;
  if (!isOverflowing()) {
    updateBreadcrumbScrollAlignment(crumbsEl, false, true);
    return;
  }
  let overflowActive = false;
  for (let i = 0; i < nodes.length - 1 && isOverflowing(); i++) {
    const node = nodes[i];
    hidden.push(node);
    node.crumb.style.display = "none";
    if (node.separator) node.separator.style.display = "none";
    const next = nodes[i + 1];
    if (next?.separator) next.separator.style.display = "none";
  }
  if (hidden.length) {
    insertBreadcrumbEllipsis(doc, crumbsEl, hidden.map(n => n.seg));
    overflowActive = true;
  }
  if (isOverflowing()) {
    if (clampBreadcrumbTail(nodes[nodes.length - 1], crumbsEl)) {
      overflowActive = true;
    }
  }
  updateBreadcrumbScrollAlignment(crumbsEl, overflowActive, immediateScroll);
}

/** Computes how many pixels the breadcrumb row can occupy within the host toolbar. */
function getBreadcrumbAvailableWidth(doc: Document, crumbsEl: HTMLElement) {
  const hostRect = getNavHostRect(doc);
  if (hostRect) {
    const crumbsRect = crumbsEl.getBoundingClientRect();
    const available = hostRect.right - crumbsRect.left - 4;
    if (available > 0) {
      return available;
    }
  }
  return crumbsEl.clientWidth || crumbsEl.getBoundingClientRect().width || 0;
}

/** Injects an ellipsis crumb that reveals the hidden path segments. */
function insertBreadcrumbEllipsis(doc: Document, crumbsEl: HTMLElement, segments: PathSeg[]) {
  if (!segments.length) return;
  const ellipsis = doc.createElement("span");
  ellipsis.className = "zfe-crumb zfe-crumb-ellipsis";
  ellipsis.textContent = "\u2026";
  ellipsis.title = segments.map(seg => seg.label).join(" > ");
  ellipsis.tabIndex = 0;
  ellipsis.setAttribute("role", "button");
  const activate = () => toggleBreadcrumbOverflowMenu(ellipsis, segments);
  ellipsis.addEventListener("click", (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    activate();
  });
  ellipsis.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      activate();
    }
  });
  const sep = doc.createElement("span");
  sep.className = "zfe-crumb-sep zfe-crumb-ellipsis-sep";
  sep.textContent = ">";
  crumbsEl.prepend(sep);
  crumbsEl.prepend(ellipsis);
}

/** Opens or closes the menu containing the hidden breadcrumb segments. */
function toggleBreadcrumbOverflowMenu(target: HTMLElement, segments: PathSeg[]) {
  if (navOverflowMenuAnchor === target) {
    closeBreadcrumbOverflowMenu();
  } else {
    openBreadcrumbOverflowMenu(target, segments);
  }
}

/** Renders a floating menu containing every hidden crumb segment. */
function openBreadcrumbOverflowMenu(target: HTMLElement, segments: PathSeg[]) {
  closeBreadcrumbOverflowMenu();
  const doc = target.ownerDocument;
  if (!doc) return;
  const host = doc.body || doc.documentElement;
  if (!host) return;
  const menu = doc.createElement("div");
  menu.id = "zfe-nav-overflow-menu";
  menu.className = "zfe-nav-overflow-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  segments.forEach(seg => {
    const item = doc.createElement("button");
    item.className = "zfe-nav-menu-item";
    item.type = "button";
    item.textContent = seg.label;
    item.title = seg.label;
    item.setAttribute("role", "menuitem");
    if (seg.collectionID == null) {
      item.disabled = true;
    } else {
      const targetID = seg.collectionID;
      item.addEventListener("click", () => {
        closeBreadcrumbOverflowMenu();
        navigateToCollection(targetID);
        deps.scheduleRerender(120);
      });
    }
    menu.appendChild(item);
  });
  if (!menu.childElementCount) {
    menu.remove();
    return;
  }
  host.appendChild(menu);
  const rect = target.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const win = doc.defaultView;
  const viewportWidth =
    win?.innerWidth ??
    doc.documentElement?.clientWidth ??
    host.clientWidth ??
    menuRect.width;
  const viewportHeight =
    win?.innerHeight ??
    doc.documentElement?.clientHeight ??
    host.clientHeight ??
    menuRect.height;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + menuRect.width > viewportWidth - 8) {
    left = Math.max(8, viewportWidth - menuRect.width - 8);
  }
  if (top + menuRect.height > viewportHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height - 4);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const handlePointer = (ev: MouseEvent) => {
    const node = ev.target as Node | null;
    if (node && (menu.contains(node) || target.contains(node))) return;
    closeBreadcrumbOverflowMenu();
  };
  const handleKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeBreadcrumbOverflowMenu();
    }
  };
  doc.addEventListener("mousedown", handlePointer, true);
  doc.addEventListener("contextmenu", handlePointer, true);
  doc.addEventListener("keydown", handleKey, true);
  navOverflowMenuCleanup = () => {
    try {
      menu.remove();
    } catch (_err) { /* ignored */ }
    doc.removeEventListener("mousedown", handlePointer, true);
    doc.removeEventListener("contextmenu", handlePointer, true);
    doc.removeEventListener("keydown", handleKey, true);
    target.classList.remove("zfe-nav-menu-open");
    navOverflowMenuAnchor = null;
  };
  navOverflowMenuAnchor = target;
  target.classList.add("zfe-nav-menu-open");
}

/** Safely disposes the overflow menu if present. */
function closeBreadcrumbOverflowMenu() {
  if (navOverflowMenuCleanup) {
    try {
      navOverflowMenuCleanup();
    } catch (_err) { /* ignored */ }
    navOverflowMenuCleanup = null;
    navOverflowMenuAnchor = null;
  }
}

/** Removes the nav strip DOM and associated listeners/styles. */
function removeNavStrip(doc?: Document) {
  const documentRef = doc ?? (() => {
    try {
      return getDocument();
    } catch (_err) {
      return null;
    }
  })();
  if (!documentRef) return;
  closeBreadcrumbOverflowMenu();
  const crumbs = documentRef.getElementById("zfe-nav-breadcrumbs") as HTMLElement | null;
  const strip = documentRef.getElementById("zfe-nav-strip");
  if (strip) {
    try {
      strip.remove();
    } catch (_err) { /* ignored */ }
  }
  if (crumbs) {
    disposeBreadcrumbScrollController(crumbs, documentRef.defaultView);
  }
  if (navStripCleanup) {
    try {
      navStripCleanup();
    } catch (_err) { /* ignored */ }
    navStripCleanup = null;
  }
}
