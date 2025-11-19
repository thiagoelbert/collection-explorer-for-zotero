/**
 * Coordinates folder-row rendering with Zotero events. Watches collection changes,
 * debounces rerenders, and exposes lifecycle helpers for the addon hooks.
 */
import { getDocument, getPane } from "../env";
import { updateNavStrip } from "../navigation";
import {
  renderFolderRowsForCurrentCollection,
  removeFolderRows,
  teardownScrollTopCompensation,
  detachHeaderObservers,
  teardownWindowResizeListener,
  getLastRenderedCollectionID,
  getCurrentSelectionKey,
  requestNextFrame,
  cancelFrame,
  setRerenderTrigger,
} from "./render";

let checkInterval: any = null;
let collectionSelectCleanup: (() => void) | null = null;
let collectionSelectionRestore: (() => void) | null = null;
let rerenderTimer: number | null = null;
let rafHandle: number | null = null;
let renderInFlight = false;

/** Clears the last RAF handle so delayed renders don't fire after shutdown. */
function cancelScheduledFrame() {
  if (rafHandle) {
    cancelFrame(rafHandle);
    rafHandle = null;
  }
}

/**
 * Monkey patches `collectionsView.selection.select` so we can detect navigations
 * triggered via keyboard/mouse faster than Zotero's tree events.
 */
function patchCollectionSelection(pane?: any) {
  if (collectionSelectionRestore) return;
  try {
    const targetPane = pane || getPane();
    const selection = targetPane?.collectionsView?.selection;
    if (!selection || typeof selection.select !== "function") return;
    if ((selection as any).__zfePatched) return;

    const originalSelect = selection.select;
    selection.select = function patchedSelect(this: typeof selection, ...args: any[]) {
      const result = originalSelect.apply(this, args);
      try {
        maybeScheduleRerenderForCollection(120);
      } catch (_err) { /* ignored */ }
      return result;
    };
    (selection as any).__zfePatched = true;
    collectionSelectionRestore = () => {
      try {
        selection.select = originalSelect;
      } catch (_err) { /* ignored */ }
      try {
        delete (selection as any).__zfePatched;
      } catch (_err) { /* ignored */ }
      collectionSelectionRestore = null;
    };
  } catch (_err) {
    // Swallow errors from best-effort patching.
  }
}

/**
 * Attempts to find the collections tree DOM node across multiple Zotero versions.
 */
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
  } catch (_err) {
    return null;
  }
}

/**
 * Primary debounce wrapper; schedules folder-row rendering on a timer and RAF,
 * collapsing rapid successive collection changes.
 */
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
      } catch (_err) {
        // Ignore rendering errors; Zotero will continue functioning.
      } finally {
        renderInFlight = false;
        cancelScheduledFrame();
        rerenderTimer = null;
      }
    });
  }, delay) as unknown as number;
}
setRerenderTrigger(scheduleRerender);

/**
 * Hooks into the collections tree (and a polling fallback) so folder rows stay in sync
 * when Zotero users navigate via mouse, keyboard, or programmatic actions.
 */
export function setupCollectionChangeListener() {
  teardownCollectionChangeListener();

  const pane = getPane();
  patchCollectionSelection(pane);

  const tree = findCollectionsTreeElement();
  if (tree) {
    const handleSelect = () => {
      try {
        maybeScheduleRerenderForCollection(180);
      } catch (_err) { /* ignored */ }
    };
    tree.addEventListener("select", handleSelect, true);
    tree.addEventListener("keyup", handleSelect, true);
    collectionSelectCleanup = () => {
      tree.removeEventListener("select", handleSelect, true);
      tree.removeEventListener("keyup", handleSelect, true);
    };
  } else {
    // Tree lookup failed; fall back to timer polling below.
  }

  checkInterval = setInterval(() => {
    try {
      maybeScheduleRerenderForCollection(200);
    } catch (_err) { /* ignored */ }

    try {
      updateNavStrip();
    } catch (_err) { /* ignored */ }
  }, 500);
}

/** Removes every listener/interval created by `setupCollectionChangeListener`. */
export function teardownCollectionChangeListener() {
  if (collectionSelectCleanup) {
    try {
      collectionSelectCleanup();
    } catch (_err) { /* ignored */ }
    collectionSelectCleanup = null;
  }
  if (collectionSelectionRestore) {
    try {
      collectionSelectionRestore();
    } catch (_err) { /* ignored */ }
    collectionSelectionRestore = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

/**
 * Compares Zotero's currently selected collection with the last rendered ID
 * and triggers a rerender when they diverge.
 */
function maybeScheduleRerenderForCollection(delay: number) {
  const pane = getPane();
  if (!pane) return;
  const currentID = getCurrentSelectionKey();
  const lastRendered = getLastRenderedCollectionID();
  if (currentID !== lastRendered) {
    scheduleRerender(delay);
  }
}

/** Stops timers/observers and clears injected DOM when the addon unloads. */
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
