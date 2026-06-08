const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { runDoctor } = require("./doctor.cjs");

let mainWindow = null;

function createWindow() {
  const appDataDir = app.getPath("userData");
  fs.mkdirSync(appDataDir, { recursive: true });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    title: "OpenClaw Workbench",
    backgroundColor: "#f7f4ec",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  const prototypePath = path.join(__dirname, "..", "docs", "prototypes", "windows-skill-platform.html");
  mainWindow.loadFile(prototypePath);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle("workbench:get-context", () => ({
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    appDataDir: app.getPath("userData"),
    homeDir: app.getPath("home"),
  }));

  ipcMain.handle("workbench:run-doctor", () =>
    runDoctor({
      homeDir: app.getPath("home"),
      platform: process.platform,
      env: process.env,
    }),
  );

  ipcMain.handle("workbench:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择授权工作区",
      properties: ["openDirectory", "createDirectory"],
    });
    return {
      canceled: result.canceled,
      path: result.filePaths[0] ?? null,
    };
  });

  ipcMain.handle("workbench:open-app-data", async () => {
    await shell.openPath(app.getPath("userData"));
    return { ok: true };
  });
}

function installMenu() {
  const template = [
    {
      label: "OpenClaw Workbench",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "打开本地数据目录",
          click: () => {
            void shell.openPath(app.getPath("userData"));
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  app.setName("OpenClaw Workbench");
  registerIpc();
  installMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
