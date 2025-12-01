/**
 * Central navigation/breadcrumb UI logic for the Zotero items pane.
 * Handles navigation history, breadcrumb rendering, overflow menus, and
 * the wiring to move the actual Zotero collection selection around.
 */
import { getDocument, getPane } from "./env";

type CollectionTreeRowType = _ZoteroTypes.CollectionTreeRow.Type;

type NavigationDeps = {
  scheduleRerender: (delay?: number) => void;
};

// Mutable dependency bag so the module stays mostly pure/testable.
const deps: NavigationDeps = {
  scheduleRerender: () => { },
};

function debugLog(message: string, ...args: any[]) {
  try {
    if (typeof Zotero !== "undefined" && typeof Zotero.debug === "function") {
      Zotero.debug(`[ZFE] ${message} ${args.map(String).join(" ")}`);
      return;
    }
  } catch (_err) { /* ignored */ }
  try {
    console.log("[ZFE]", message, ...args);
  } catch (_err) { /* ignored */ }
}

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
type PathSeg = {
  label: string;
  collectionID: number | null;
  libraryID: number | null;
  rowType: CollectionTreeRowType | null;
};

// Reference to DOM nodes that belong to a breadcrumb entry.
type BreadcrumbNode = {
  seg: PathSeg;
  crumb: HTMLSpanElement;
  separator: HTMLSpanElement | null;
};

// Breadcrumb overflow management constants.
const BREADCRUMB_TAIL_CLAMP_CLASS = "zfe-crumb-tail-clamped";
const BREADCRUMB_DROP_CLASS = "zfe-crumb-drop-target";
const COLLECTION_DRAG_MIME = "application/x-zfe-collection-id";
const BREADCRUMB_SCROLL_SETTLE_DELAY = 200;
const BREADCRUMB_RESIZE_RELEASE_TIMEOUT = 1200;
const NAV_STRIP_SUPPRESSED_ROW_TYPES = new Set<CollectionTreeRowType>([
  "duplicates",
  "publications",
  "trash",
  "unfiled",
  "retracted",
  "feeds",
  "feed",
  "search",
  "bucket",
  "share",
]);
const ROW_TYPE_DETECTORS: Array<[CollectionTreeRowType, string]> = [
  ["library", "isLibrary"],
  ["group", "isGroup"],
  ["feed", "isFeed"],
  ["collection", "isCollection"],
  ["search", "isSearch"],
  ["duplicates", "isDuplicates"],
  ["unfiled", "isUnfiled"],
  ["retracted", "isRetracted"],
  ["publications", "isPublications"],
  ["trash", "isTrash"],
  ["bucket", "isBucket"],
  ["share", "isShare"],
];
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
  if (cur?.parentID) {
    navigateToCollection(cur.parentID);
    deps.scheduleRerender(120);
    return;
  }
  const targetLibID = cur?.libraryID ?? pane?.getSelectedLibraryID?.() ?? null;
  if (navigateToLibraryRoot(targetLibID ?? null)) {
    deps.scheduleRerender(120);
  }
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

type ActiveLibraryMeta = { id: number | null; name: string };

/** Returns the currently selected tree row when available. */
function getSelectedTreeRow(): Zotero.CollectionTreeRow | null {
  try {
    const cached = Zotero.CollectionTreeCache?.lastTreeRow;
    if (cached) return cached;
  } catch (_err) {
    // ignored
  }
  try {
    const pane = getPane();
    const tree = pane?.collectionsView as _ZoteroTypes.CollectionTree | undefined;
    const selection = tree?.selection;
    const index =
      typeof selection?.currentIndex === "number" ? selection.currentIndex : -1;
    if (!tree || index == null || index < 0) return null;
    return getTreeRowAtIndex(tree, index);
  } catch (_err) {
    return null;
  }
}

/** Attempts to infer the row type using explicit metadata or helper predicates. */
function getTreeRowType(row: Zotero.CollectionTreeRow | null): CollectionTreeRowType | null {
  if (!row) return null;
  const direct = (row as any)?.type;
  if (direct && typeof direct === "string") {
    return direct as CollectionTreeRowType;
  }
  for (const [type, method] of ROW_TYPE_DETECTORS) {
    const fn: ((this: Zotero.CollectionTreeRow) => unknown) | undefined =
      (row as any)?.[method];
    if (typeof fn === "function") {
      try {
        if (fn.call(row)) return type;
      } catch (_err) {
        // Ignore detector failures.
      }
    }
  }
  return null;
}

/** Returns the library ID associated with a tree row if possible. */
function getRowLibraryID(row: Zotero.CollectionTreeRow | null): number | null {
  if (!row) return null;
  try {
    const ref: any = (row as any).ref;
    if (typeof ref?.libraryID === "number") return ref.libraryID;
    if (typeof ref?.library?.libraryID === "number") return ref.library.libraryID;
    if (typeof (row as any).libraryID === "number") return (row as any).libraryID;
  } catch (_err) {
    return null;
  }
  return null;
}

/** Resolves the most relevant library metadata for the breadcrumb root. */
function getActiveLibraryMeta(
  selected: any,
  row: Zotero.CollectionTreeRow | null,
): ActiveLibraryMeta {
  const pane = getPane();
  const inferredID =
    selected?.libraryID ??
    getRowLibraryID(row) ??
    pane?.getSelectedLibraryID?.() ??
    Zotero.Libraries?.userLibraryID ??
    null;
  const lib = inferredID != null ? Zotero.Libraries.get(inferredID) : null;
  const name = (lib as any)?.name || "Library";
  return { id: inferredID, name };
}

/** Returns the display label for a tree row or an empty string. */
function getRowDisplayName(row: Zotero.CollectionTreeRow | null): string {
  if (!row) return "";
  try {
    if (typeof row.getName === "function") {
      const name = row.getName();
      if (typeof name === "string" && name.trim()) return name;
    }
  } catch (_err) {
    // Fallback to trying direct properties below.
  }
  const ref: any = (row as any)?.ref;
  const label = ref?.name ?? ref?.label ?? ref?.title ?? "";
  return typeof label === "string" ? label : "";
}

/** Best-effort accessor for a tree row at a given index across Zotero versions. */
function getTreeRowAtIndex(
  tree: _ZoteroTypes.CollectionTree | any,
  index: number,
): Zotero.CollectionTreeRow | null {
  if (!tree || index == null || index < 0) return null;
  if (typeof tree.getRow === "function") {
    try {
      return tree.getRow(index) as Zotero.CollectionTreeRow;
    } catch (_err) {
      // Fall through to private row array if direct accessor throws.
    }
  }
  const rows: any[] | undefined = (tree as any)?._rows;
  if (Array.isArray(rows) && index >= 0 && index < rows.length) {
    return rows[index] as Zotero.CollectionTreeRow;
  }
  return null;
}

/** Builds the breadcrumb segments for the currently selected collection. */
function getPathSegments(selected: any, treeRowOverride?: Zotero.CollectionTreeRow | null): PathSeg[] {
  const segs: PathSeg[] = [];
  const treeRow = treeRowOverride ?? getSelectedTreeRow();
  const libraryMeta = getActiveLibraryMeta(selected, treeRow);
  segs.push({
    label: libraryMeta.name,
    collectionID: null,
    libraryID: libraryMeta.id,
    rowType: "library",
  });
  if (!selected) {
    if (treeRow && !treeRow.isLibrary?.()) {
      const rowLabel = getRowDisplayName(treeRow);
      if (rowLabel) {
        const maybeCollectionID =
          treeRow.isCollection?.() && typeof (treeRow as any)?.ref?.id === "number"
            ? Number((treeRow as any).ref.id)
            : null;
        segs.push({
          label: rowLabel,
          collectionID: maybeCollectionID,
          libraryID: libraryMeta.id,
          rowType: getTreeRowType(treeRow),
        });
      }
    }
    return segs;
  }
  const chain: any[] = [];
  let cur = selected;
  while (cur) { chain.unshift(cur); if (!cur.parentID) break; cur = Zotero.Collections.get(cur.parentID); }
  chain.forEach(col => segs.push({
    label: col.name,
    collectionID: col.id,
    libraryID: libraryMeta.id,
    rowType: "collection",
  }));
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
  .zfe-crumb.${BREADCRUMB_DROP_CLASS} {
    background: #e6f0ff;
    box-shadow: inset 0 0 0 1px #5c8df6;
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
  const strip = doc.getElementById("zfe-nav-strip") as HTMLElement | null;
  if (!strip) {
    mountNavStrip(doc);
    return updateNavStrip(selected);
  }
  const crumbs = doc.getElementById("zfe-nav-breadcrumbs") as HTMLElement | null;
  if (!crumbs) return;
  closeBreadcrumbOverflowMenu();
  crumbs.textContent = "";
  const treeRow = getSelectedTreeRow();
  const rowType = getTreeRowType(treeRow);
  const suppressNav = !!(rowType && NAV_STRIP_SUPPRESSED_ROW_TYPES.has(rowType));
  strip.style.display = suppressNav ? "none" : "flex";
  if (suppressNav) {
    updateNavButtonsEnabled();
    return;
  }
  const sel = selected ?? getPane()?.getSelectedCollection();
  const segs = getPathSegments(sel, treeRow);
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
    if (seg.libraryID != null) {
      crumb.setAttribute("data-zfe-library-id", String(seg.libraryID));
    } else {
      crumb.removeAttribute("data-zfe-library-id");
    }
    if (seg.rowType) {
      crumb.setAttribute("data-zfe-row-type", seg.rowType);
    } else {
      crumb.removeAttribute("data-zfe-row-type");
    }

    attachBreadcrumbDragHandlers(crumb, seg);

    crumb.addEventListener("click", () => {
      if (activateBreadcrumbSegment(seg)) {
        deps.scheduleRerender(120);
      }
    });
    crumb.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        const activated = activateBreadcrumbSegment(seg);
        if (activated) {
          ev.preventDefault();
          deps.scheduleRerender(120);
        }
      }
    });
    crumbs.appendChild(crumb);
    crumbNodes.push({ seg, crumb, separator });
  });
  scheduleBreadcrumbOverflowMeasurement(doc, crumbs, crumbNodes);
  updateNavButtonsEnabled();
}

/** Triggers navigation for a breadcrumb segment, returning true on success. */
function activateBreadcrumbSegment(seg: PathSeg): boolean {
  if (seg.collectionID != null) {
    navigateToCollection(seg.collectionID);
    return true;
  }
  if (seg.rowType) {
    return navigateToTreeRowType(seg.rowType, seg.libraryID ?? null);
  }
  return false;
}

/** Determines whether a breadcrumb segment represents a navigable target. */
function canActivateBreadcrumbSegment(seg: PathSeg): boolean {
  if (seg.collectionID != null) return true;
  return Boolean(seg.rowType);
}

function attachBreadcrumbDragHandlers(crumb: HTMLElement, seg: PathSeg) {
  if (seg.collectionID == null) return;
  const targetCollectionID = seg.collectionID;

  const handleEnter = (ev: DragEvent) => {
    if (!canAcceptBreadcrumbDrop(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    setDropEffectMove(ev);
    crumb.classList.add(BREADCRUMB_DROP_CLASS);
    debugLog("breadcrumb dragenter", {
      target: targetCollectionID,
      types: Array.from(ev.dataTransfer?.types ?? []),
      col: getDraggedCollectionID(ev),
    });
  };

  const handleOver = (ev: DragEvent) => {
    if (!canAcceptBreadcrumbDrop(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    setDropEffectMove(ev);
    crumb.classList.add(BREADCRUMB_DROP_CLASS);
  };

  const handleLeave = () => {
    crumb.classList.remove(BREADCRUMB_DROP_CLASS);
  };

  const handleDrop = async (ev: DragEvent) => {
    if (!canAcceptBreadcrumbDrop(ev)) return;
    ev.preventDefault();
    ev.stopPropagation();
    crumb.classList.remove(BREADCRUMB_DROP_CLASS);
    const collectionID = getDraggedCollectionID(ev);
    debugLog("breadcrumb drop", {
      target: targetCollectionID,
      from: collectionID,
      types: Array.from(ev.dataTransfer?.types ?? []),
      text: safeReadDT(ev.dataTransfer, "text/plain"),
    });
    if (collectionID != null && collectionID !== targetCollectionID && !isAncestorCollection(collectionID, targetCollectionID)) {
      debugLog("Drop collection on breadcrumb", { from: collectionID, to: targetCollectionID });
      await moveCollectionToParent(collectionID, targetCollectionID);
      return;
    }

    const itemIDs = getDraggedItemIDs(ev);
    if (!itemIDs.length) return;
    const sourceID = getPane()?.getSelectedCollection?.()?.id ?? null;
    debugLog("Drop items on breadcrumb", { items: itemIDs, to: targetCollectionID });
    await moveItemsToCollection(itemIDs, targetCollectionID, sourceID);
  };

  crumb.addEventListener("dragenter", handleEnter);
  crumb.addEventListener("dragover", handleOver);
  crumb.addEventListener("dragleave", handleLeave);
  crumb.addEventListener("drop", handleDrop);
}

function canAcceptBreadcrumbDrop(event: DragEvent | null): boolean {
  if (!event) return false;
  const dt = event.dataTransfer;
  if (dt?.types && Array.from(dt.types).some(t => `${t}`.toLowerCase().includes("zotero"))) {
    return true;
  }
  if (getDraggedItemIDs(event).length > 0) return true;
  const colID = getDraggedCollectionID(event);
  return colID != null;
}

function setDropEffectMove(ev: DragEvent) {
  try {
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  } catch (_err) {
    // ignored
  }
}

function getDraggedItemIDs(event?: DragEvent | null): number[] {
  const fromTransfer = extractItemIDsFromDataTransfer(event?.dataTransfer ?? null);
  if (fromTransfer.length) return fromTransfer;
  return getSelectedItemIDs();
}

function extractItemIDsFromDataTransfer(dt: DataTransfer | null): number[] {
  if (!dt) return [];
  const seenTypes = new Set<string>();
  const types = Array.from(dt.types || []);

  for (const type of types) {
    seenTypes.add(type);
    const ids = safelyParseIDs(dt, type);
    if (ids.length) return ids;
  }

  const candidateTypes = [
    "zotero/items",
    "zotero/item",
    "zotero/items-json",
    "application/x-zotero-item-ids",
    "application/x-zotero-items",
    "application/vnd.zotero.items+json",
    "application/vnd.zotero.item+json",
    "text/x-zotero-item",
    "text/x-zotero-items",
    "application/json",
    "text/plain",
  ];
  for (const type of candidateTypes) {
    if (seenTypes.has(type)) continue;
    const ids = safelyParseIDs(dt, type);
    if (ids.length) return ids;
  }
  return [];
}

function safelyParseIDs(dt: DataTransfer, type: string): number[] {
  let raw = "";
  try {
    raw = dt.getData(type);
  } catch (_err) {
    raw = "";
  }
  return parseItemIDPayload(raw);
}

function parseItemIDPayload(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizeItemIDs(parsed);
    if (parsed && Array.isArray((parsed as any).items)) {
      return normalizeItemIDs((parsed as any).items);
    }
    if (parsed && Array.isArray((parsed as any).ids)) {
      return normalizeItemIDs((parsed as any).ids);
    }
  } catch (_err) {
    // fall through
  }

  const matches = trimmed.match(/\d+/g);
  return matches ? normalizeItemIDs(matches) : [];
}

function getSelectedItemIDs(): number[] {
  const pane = getPane();
  if (!pane) return [];

  try {
    const idsFromPane = pane.getSelectedItems?.(true);
    if (Array.isArray(idsFromPane)) {
      return normalizeItemIDs(idsFromPane);
    }
  } catch (_err) { /* ignored */ }

  try {
    const items = pane.getSelectedItems?.();
    if (Array.isArray(items)) {
      const ids = items.map((item: any) => (typeof item === "number" ? item : item?.id));
      return normalizeItemIDs(ids);
    }
  } catch (_err) { /* ignored */ }

  try {
    const itemsView = pane.itemsView;
    const idsFromView = itemsView?.getSelectedItems?.(true);
    if (Array.isArray(idsFromView)) {
      return normalizeItemIDs(idsFromView);
    }
  } catch (_err) { /* ignored */ }

  return [];
}

function normalizeItemIDs(value: any): number[] {
  const unique = new Set<number>();
  const maybeArray = Array.isArray(value) ? value : [value];
  for (const entry of maybeArray) {
    const asNumber = typeof entry === "number" ? entry : Number(entry);
    if (Number.isFinite(asNumber)) unique.add(Math.trunc(asNumber));
  }
  return Array.from(unique);
}

function getDraggedCollectionID(event?: DragEvent | null): number | null {
  const dt = event?.dataTransfer;
  const candidateTypes = [
    COLLECTION_DRAG_MIME,
    "application/x-zotero-collection-id",
    "zotero/collection",
    "text/plain",
  ];
  for (const type of candidateTypes) {
    const id = parseSingleIDFromDT(dt, type);
    if (id != null) return id;
  }
  return null;
}

function parseSingleIDFromDT(dt: DataTransfer | null | undefined, type: string): number | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(type);
    if (!raw) return null;
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function safeReadDT(dt: DataTransfer | null | undefined, type: string): string | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(type);
    return raw || null;
  } catch (_err) {
    return null;
  }
}

async function moveItemsToCollection(
  itemIDs: number[],
  targetCollectionID: number,
  sourceCollectionID: number | null,
) {
  const ids = normalizeItemIDs(itemIDs);
  if (!ids.length) return;

  const targetCollection = Zotero.Collections.get(targetCollectionID);
  if (!targetCollection) return;

  const liveSelectedID = getPane()?.getSelectedCollection?.()?.id ?? null;
  const sourceID =
    (liveSelectedID && liveSelectedID !== targetCollectionID ? liveSelectedID : null) ??
    (sourceCollectionID && sourceCollectionID !== targetCollectionID ? sourceCollectionID : null);

  const runAdd = async () => {
    const collectionsAPI = Zotero.Collections as any;
    if (typeof targetCollection.addItems === "function") {
      await Promise.resolve(targetCollection.addItems(ids));
      return;
    }
    if (collectionsAPI && typeof collectionsAPI.addItems === "function") {
      await Promise.resolve(collectionsAPI.addItems(targetCollectionID, ids));
    }
  };

  const runRemove = async () => {
    if (!sourceID) return;
    await removeItemsFromCollection(ids, sourceID);
  };

  if (Zotero.DB?.executeTransaction) {
    await Zotero.DB.executeTransaction(async () => {
      await runAdd();
      await runRemove();
    });
  } else {
    await runAdd();
    await runRemove();
  }

  try {
    deps.scheduleRerender(140);
  } catch (_err) { /* ignored */ }
}

async function moveCollectionToParent(collectionID: number, newParentID: number) {
  if (collectionID === newParentID) return;
  const collection = Zotero.Collections.get(collectionID);
  if (!collection) return;

  if (isAncestorCollection(collectionID, newParentID)) return;

  const currentParent = collection.parentID ?? null;
  if (currentParent === newParentID) return;

  debugLog("moveCollectionToParent start", { collectionID, currentParent, newParentID });

  try {
    const win = Zotero.getMainWindow?.();
    const mover =
      (win as any)?.ZoteroPane?.moveCollection ||
      (globalThis as any)?.ZoteroPane_Local?.moveCollection ||
      (getPane() as any)?.moveCollection ||
      null;
    if (typeof mover === "function") {
      await Promise.resolve(
        mover.call(
          (win as any)?.ZoteroPane ?? (globalThis as any)?.ZoteroPane_Local ?? getPane(),
          collectionID,
          newParentID,
        ),
      );
      refreshCollectionsTree(collectionID);
      deps.scheduleRerender(200);
      debugLog("moveCollectionToParent via ZoteroPane_Local.moveCollection", {
        collectionID,
        newParentID,
      });
      return;
    }
  } catch (err) {
    debugLog("moveCollectionToParent pane helper failed", err);
  }

  const applyParent = async () => {
    try {
      collection.parentID = newParentID;
      if (typeof (collection as any).setField === "function") {
        (collection as any).setField("parentID", newParentID);
      }
      const parent = Zotero.Collections.get(newParentID);
      if (parent?.key && typeof (collection as any).setField === "function") {
        (collection as any).setField("parentKey", parent.key);
      } else if (parent?.key) {
        (collection as any).parentKey = parent.key;
      } else if ((collection as any).setField) {
        (collection as any).setField("parentKey", null);
      }
      updateCollectionParentCaches(collectionID, currentParent, newParentID);
      if (typeof collection.saveTx === "function") {
        await collection.saveTx({ skipEditCheck: true } as any);
      } else if (typeof collection.save === "function") {
        await collection.save({ skipEditCheck: true } as any);
      }
      debugLog("moveCollectionToParent saved", { collectionID, newParentID });
    } catch (err) {
      debugLog("moveCollectionToParent error", err);
    }
  };

  await applyParent();

  try {
    refreshCollectionsTree(collectionID);
    deps.scheduleRerender(200);
    scrollItemsBodyToTopSoon();
    debugLog("moveCollectionToParent rerender requested", { collectionID, newParentID });
  } catch (_err) { /* ignored */ }
}

function updateCollectionParentCaches(
  collectionID: number,
  oldParentID: number | null,
  newParentID: number | null,
) {
  try {
    if (oldParentID != null) {
      const oldParent = Zotero.Collections.get(oldParentID);
      if (oldParent?._childCollections instanceof Set) {
        oldParent._childCollections.delete(collectionID);
      }
    }
    if (newParentID != null) {
      const newParent = Zotero.Collections.get(newParentID);
      if (newParent?._childCollections instanceof Set) {
        newParent._childCollections.add(collectionID);
      }
    }
    debugLog("updateCollectionParentCaches", { collectionID, oldParentID, newParentID });
  } catch (_err) { /* ignored */ }
}

function refreshCollectionsTree(movedCollectionID: number) {
  const pane = getPane();
  const cv: any = pane?.collectionsView;
  try {
    const win = Zotero.getMainWindow?.();
    const tree = (win as any)?.document?.getElementById?.("zotero-collections-tree");
    if (cv?.tree && typeof cv.tree.invalidate === "function") {
      cv.tree.invalidate();
    } else if (cv?._treebox && typeof cv._treebox.invalidate === "function") {
      cv._treebox.invalidate();
    } else if (cv && typeof cv.invalidate === "function") {
      cv.invalidate();
    } else if (tree && typeof (tree as any).invalidate === "function") {
      (tree as any).invalidate();
    }
  } catch (err) {
    debugLog("refreshCollectionsTree error", err);
  }
}

function scrollItemsBodyToTopSoon() {
  try {
    const root = getPane()?.itemsView?.domEl as HTMLElement | null;
    if (!root) return;
    setTimeout(() => {
      try {
        const body =
          root.querySelector<HTMLElement>('[data-zfe-items-body]') ||
          root.querySelector<HTMLElement>('[role="rowgroup"].body') ||
          root.querySelector<HTMLElement>('.virtualized-table-body') ||
          root.querySelector<HTMLElement>('[role="rowgroup"]');
        if (body) body.scrollTop = 0;
      } catch (_err) { /* ignored */ }
    }, 120);
  } catch (_err) { /* ignored */ }
}

function isAncestorCollection(ancestorID: number, candidateChildID: number): boolean {
  if (ancestorID === candidateChildID) return true;
  let cursor = Zotero.Collections.get(candidateChildID);
  const safety = new Set<number>();
  while (cursor && typeof cursor.parentID === "number" && cursor.parentID) {
    if (safety.has(cursor.parentID)) break;
    safety.add(cursor.parentID);
    if (cursor.parentID === ancestorID) return true;
    cursor = Zotero.Collections.get(cursor.parentID);
  }
  return false;
}

async function removeItemsFromCollection(ids: number[], sourceCollectionID: number) {
  const sourceCollection = Zotero.Collections.get(sourceCollectionID);
  if (sourceCollection && typeof sourceCollection.removeItems === "function") {
    await Promise.resolve(sourceCollection.removeItems(ids));
  }

  const collectionsAPI = Zotero.Collections as any;
  if (collectionsAPI && typeof collectionsAPI.removeItems === "function") {
    await Promise.resolve(collectionsAPI.removeItems(sourceCollectionID, ids));
  }

  for (const id of ids) {
    try {
      const item = Zotero.Items?.get?.(id);
      if (item && typeof item.removeFromCollection === "function") {
        item.removeFromCollection(sourceCollectionID);
      }
    } catch (_err) { /* ignored */ }
  }
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

      if (!selectCollectionsTreeRowByIndex(cv, targetRowIndex)) return;
      deps.scheduleRerender(120);
    }, 200);

  } catch (_err) {
    // Ignore navigation errors; Zotero will continue functioning.
  }
}

/** Selects the root row for the provided library ID. */
function navigateToLibraryRoot(libraryID?: number | null): boolean {
  const pane = getPane();
  const tree = pane?.collectionsView as _ZoteroTypes.CollectionTree | undefined;
  const effectiveID =
    libraryID ??
    pane?.getSelectedLibraryID?.() ??
    Zotero.Libraries?.userLibraryID ??
    null;
  if (!tree || effectiveID == null) return false;
  try {
    if (typeof tree.selectLibrary === "function") {
      tree.selectLibrary(effectiveID);
      return true;
    }
  } catch (_err) {
    // Fall back to manual selection if selectLibrary fails.
  }
  return selectTreeRowByPredicate(
    tree,
    row => row.isLibrary?.() && getRowLibraryID(row) === effectiveID,
  );
}

/** Selects a non-collection tree row (trash, publications, etc.) when available. */
function navigateToTreeRowType(
  rowType: CollectionTreeRowType,
  libraryID: number | null,
): boolean {
  if (rowType === "library") {
    return navigateToLibraryRoot(libraryID);
  }
  const pane = getPane();
  const tree = pane?.collectionsView as _ZoteroTypes.CollectionTree | undefined;
  if (!tree) return false;
  const targetLibID = libraryID ?? pane?.getSelectedLibraryID?.() ?? null;
  ensureLibraryRowExpanded(tree, targetLibID);
  return selectTreeRowByPredicate(tree, row => {
    if ((row as any)?.type !== rowType) return false;
    const rowLibID = getRowLibraryID(row);
    if (targetLibID != null && rowLibID != null && rowLibID !== targetLibID) {
      return false;
    }
    return true;
  });
}

/** Ensures the matching library row is expanded so children are visible/selectable. */
function ensureLibraryRowExpanded(
  tree: _ZoteroTypes.CollectionTree | any,
  libraryID: number | null,
) {
  if (
    !tree ||
    libraryID == null ||
    typeof tree.isContainer !== "function" ||
    typeof tree.isContainerOpen !== "function" ||
    typeof tree.toggleOpenState !== "function"
  ) {
    return;
  }
  const index = findTreeRowIndex(
    tree,
    row => row.isLibrary?.() && getRowLibraryID(row) === libraryID,
  );
  if (index === -1) return;
  try {
    if (!tree.isContainerOpen(index)) {
      tree.toggleOpenState(index, true);
    }
  } catch (_err) {
    // Swallow failures opening the tree.
  }
}

/** Attempts to select a tree row by index using available Zotero APIs. */
function selectCollectionsTreeRowByIndex(tree: any, index: number): boolean {
  if (!tree || index == null || index < 0) return false;
  try {
    if (tree.selection) {
      tree.selection.select(index);
      if (tree.tree?.invalidate) tree.tree.invalidate();
      return true;
    }
    if (typeof tree._selectRow === "function") {
      tree._selectRow(index);
      return true;
    }
    if (tree._treebox?.getElementByIndex) {
      tree._treebox.getElementByIndex(index)?.click();
      return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

/** Iterates over rows and selects the first one that satisfies the predicate. */
function selectTreeRowByPredicate(
  tree: _ZoteroTypes.CollectionTree | any,
  predicate: (row: Zotero.CollectionTreeRow, index: number) => boolean,
): boolean {
  const index = findTreeRowIndex(tree, predicate);
  if (index === -1) return false;
  return selectCollectionsTreeRowByIndex(tree, index);
}

/** Locates the index in the collections tree that matches the predicate. */
function findTreeRowIndex(
  tree: _ZoteroTypes.CollectionTree | any,
  predicate: (row: Zotero.CollectionTreeRow, index: number) => boolean,
): number {
  if (!tree) return -1;
  const explicitCount = typeof tree.rowCount === "number" ? tree.rowCount : null;
  const rows: any[] | undefined = (tree as any)?._rows;
  const total =
    explicitCount != null
      ? explicitCount
      : Array.isArray(rows)
        ? rows.length
        : 0;
  for (let idx = 0; idx < total; idx++) {
    const row = getTreeRowAtIndex(tree, idx);
    if (!row) continue;
    let match = false;
    try {
      match = predicate(row, idx);
    } catch (_err) {
      match = false;
    }
    if (match) return idx;
  }
  return -1;
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
      const libraryAttr = crumb.getAttribute("data-zfe-library-id");
      const rowTypeAttr = crumb.getAttribute("data-zfe-row-type");
      const seg: PathSeg = {
        label,
        collectionID: collectionAttr && collectionAttr.length ? Number(collectionAttr) : null,
        libraryID: libraryAttr && libraryAttr.length ? Number(libraryAttr) : null,
        rowType:
          rowTypeAttr && rowTypeAttr.length
            ? (rowTypeAttr as CollectionTreeRowType)
            : null,
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
    if (!canActivateBreadcrumbSegment(seg)) {
      item.disabled = true;
    } else {
      item.addEventListener("click", () => {
        closeBreadcrumbOverflowMenu();
        if (activateBreadcrumbSegment(seg)) {
          deps.scheduleRerender(120);
        }
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
