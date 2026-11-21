'use strict';
const { app, BrowserWindow, Menu, net, session, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const REPO = 'ryansimacon44-coder/Accessible-Soundboard-Cartwall-';
const BRANCH = 'main';
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const ALLOWED = ['index.html', 'core.js', 'icon.svg'];
const INSTALLER_PREFIX = `https://github.com/${REPO}/releases/download/`;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const bundled = global.RC_BUNDLED || __dirname;
const override = path.join(app.getPath('userData'), 'app');
const bundledVer = JSON.parse(fs.readFileSync(path.join(bundled, 'package.json'), 'utf8')).version;

function readVer(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version; } catch (e) { return null; }
}
function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
function currentDir() {
  const ov = readVer(override);
  return ov && newer(ov, bundledVer) && fs.existsSync(path.join(override, 'index.html')) ? override : bundled;
}
function currentVer() { return currentDir() === override ? readVer(override) : bundledVer; }

let win = null;
function say(msg) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.rcAnnounce&&window.rcAnnounce(${JSON.stringify(msg)})`).catch(() => {});
}
async function get(rel) {
  const r = await net.fetch(BASE + rel + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(rel + ' ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
function installerVer() {
  try { return fs.readFileSync(path.join(path.dirname(process.execPath), 'installer-version.txt'), 'utf8').trim() || '1.0.0'; } catch (e) { return '1.0.0'; }
}
/* version.json may also carry: "installer": { "version": "2.0.0", "url": "<GitHub release download link>", "sha256": "<64 hex>" }.
   When that version is newer than the installed one, the new Setup is downloaded at once and the person is asked to install it. */
function installerInfo(meta) {
  const i = meta && meta.installer;
  if (!i || !/^\d+(\.\d+){0,3}$/.test(String(i.version)) || typeof i.url !== 'string' || !i.url.startsWith(INSTALLER_PREFIX) || !/^[0-9a-f]{64}$/i.test(String(i.sha256))) return null;
  return newer(i.version, installerVer()) ? i : null;
}
let asked = false;
async function installerStep(info, manual) {
  const dir = path.join(app.getPath('userData'), 'installer');
  const file = path.join(dir, 'Setup-' + info.version + '.exe');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  let ready = false;
  try { ready = fs.existsSync(file) && sha(fs.readFileSync(file)).toLowerCase() === info.sha256.toLowerCase(); } catch (e) {}
  if (!ready) {
    say('A new installer, version ' + info.version + ', is needed. Downloading it now in the background. The music is not interrupted.');
    const r = await net.fetch(info.url, { cache: 'no-store' });
    if (!r.ok) throw new Error('installer ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (sha(buf).toLowerCase() !== info.sha256.toLowerCase()) throw new Error('installer damaged');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.part', buf);
    fs.renameSync(file + '.part', file);
  }
  if (asked && !manual) return;
  asked = true;
  say('The new installer is ready. A window is asking if you want to install it now.');
  const res = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'question', buttons: ['Install now', 'Later'], defaultId: 0, cancelId: 1,
    title: 'Accessible Soundboard Cartwall',
    message: 'A new version of the installer is ready (version ' + info.version + ').',
    detail: 'Choose Install now. The app will close, update itself, and open again in a moment. Your sounds and settings are kept. Choose Later to be asked again next time you open the app.'
  });
  if (res.response === 0) {
    spawn(file, ['/silent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
  } else say('Okay. You will be asked again next time you open the app.');
}
let busy = false;
async function checkUpdate(manual) {
  if (busy) return;
  busy = true;
  try {
    const meta = JSON.parse((await get('version.json')).toString('utf8'));
    if (!/^\d+(\.\d+){0,3}$/.test(String(meta.version)) || !Array.isArray(meta.files) || !meta.files.includes('index.html')) throw new Error('bad version.json');
    const inst = installerInfo(meta);
    if (!newer(meta.version, currentVer())) {
      if (inst) await installerStep(inst, manual);
      else if (manual) say('Up to date. Version ' + currentVer() + '.');
      return;
    }
    say('Update found: version ' + meta.version + '. Downloading in the background. The music is not interrupted.');
    const tmp = override + '.tmp';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of meta.files) {
      if (!ALLOWED.includes(f)) throw new Error('unexpected file ' + f);
      const data = await get(f);
      if (f === 'core.js') new vm.Script(data.toString('utf8'), { filename: 'core.js' });
      if (f === 'index.html' && data.length < 2000) throw new Error('index.html too small');
      fs.writeFileSync(path.join(tmp, f), data);
    }
    fs.writeFileSync(path.join(tmp, 'version.json'), JSON.stringify({ version: meta.version }));
    fs.rmSync(override, { recursive: true, force: true });
    fs.renameSync(tmp, override);
    say('Updated to version ' + meta.version + '. Close and reopen the app to use it. Nothing was restarted.');
    if (inst) await installerStep(inst, manual);
  } catch (e) {
    try { fs.rmSync(override + '.tmp', { recursive: true, force: true }); } catch (e2) {}
    if (manual) say('Could not check for updates. Check your internet connection.');
  } finally { busy = false; }
}

function create() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({ width: 1100, height: 800, title: 'Accessible Soundboard/Cartwall', backgroundColor: '#eef1f4', autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } });
  win.loadFile(path.join(currentDir(), 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'u') { e.preventDefault(); checkUpdate(true); }
  });
  win.webContents.once('did-finish-load', () => {
    try { if (global.RC_FLAG) fs.rmSync(global.RC_FLAG, { force: true }); } catch (e) {}
    setTimeout(() => checkUpdate(false), 4000);
  });
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const ok = (p) => p === 'media' || p === 'audioCapture';
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ok(perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm) => ok(perm));
    create();
  });
  app.on('window-all-closed', () => app.quit());
}
