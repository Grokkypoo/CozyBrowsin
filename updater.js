// Checks for a new release at startup and on demand, downloads it in the background,
// then asks before restarting. If you pick Later, it installs when you next quit.
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const STARTUP_DELAY_MS = 5000;
let manualCheck = false;

function setUpUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) dialog.showMessageBox({ type: 'info', message: `LightBrowser ${app.getVersion()} is up to date.` });
    manualCheck = false;
  });
  autoUpdater.on('update-available', info => {
    if (manualCheck) dialog.showMessageBox({ type: 'info', message: `Downloading LightBrowser ${info.version} in the background.` });
    manualCheck = false;
  });
  autoUpdater.on('error', err => {
    // Being offline at startup is normal, so only report errors the user asked about.
    console.error('Update check failed:', err.message);
    if (manualCheck) dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.', detail: err.message });
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Restart and update', 'Later'], defaultId: 0, cancelId: 1, message: `LightBrowser ${info.version} is ready to install.`, detail: 'Choosing Later installs it the next time you quit.' });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), STARTUP_DELAY_MS);
}

function checkForUpdatesNow() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', message: 'Updates only work in the installed app.' });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

module.exports = { setUpUpdater, checkForUpdatesNow };
