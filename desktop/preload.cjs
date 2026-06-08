const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openclawWorkbench", {
  getContext: () => ipcRenderer.invoke("workbench:get-context"),
  runDoctor: () => ipcRenderer.invoke("workbench:run-doctor"),
  pickWorkspace: () => ipcRenderer.invoke("workbench:pick-workspace"),
  openAppData: () => ipcRenderer.invoke("workbench:open-app-data"),
});
