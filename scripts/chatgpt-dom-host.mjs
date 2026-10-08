import { app, BrowserWindow } from "electron";
import process from "node:process";

app.setPath("userData", process.env.CODEXGPT_BRIDGE_DOM_TEST_PROFILE);
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("about:blank");
});
