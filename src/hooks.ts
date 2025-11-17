import { debugCurrentState, scheduleRerender, setupCollectionChangeListener, teardownCollectionChangeListener, shutdownFolderRows } from "./folderRows";
import { configureNavigation } from "./navigation";

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

    await Zotero.Promise.delay(400);
    scheduleRerender(10);
    setupCollectionChangeListener();
  }

  static onShutdown(): void {
    ztoolkit.unregisterAll();
    shutdownFolderRows();
    teardownCollectionChangeListener();
  }

  static onMainWindowLoad(): void { }
  static onMainWindowUnload(): void { }
  static async onDialogLaunch() { }
}

configureNavigation({ scheduleRerender });

export default Hooks;
