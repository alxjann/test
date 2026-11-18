'use strict';

// Playtopia Proxy — Electron main process.
//
// - hosts the bridge WebSocket server (ws://127.0.0.1:8765) the Python backend connects to
// - spawns / restarts / kills the backend process
// - relays backend events -> renderer ('proxy-event') and renderer commands -> backend
// - certificate + system-proxy diagnostics

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execFile } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

const PROXY_PORT = Number(process.env.PLAYTOPIA_PROXY_PORT) || 8080;
const BRIDGE_PORT = Number(process.env.PLAYTOPIA_BRIDGE_PORT) || 8765;
const SPAWN_BACKEND = !process.argv.includes('--no-backend');
const CERT_PATH = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.cer');
const INET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let win = null;
let wss = null;
const bridgeClients = new Set();

const backend = {
  child: null,
  state: 'stopped', // starting | running | stopped | exited | external
  exitCode: null,
  lastError: null,
  info: null, // the backend's hello message
  intentionalStop: false,
};

let savedProxySettings = null; // set when *we* changed the system proxy, restored on quit
let quitting = false;

// ---------------------------------------------------------------- helpers

function sendToRenderer(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('proxy-event', ev);
}

function status() {
  return {
    bridgeConnected: bridgeClients.size > 0,
    backendState: backend.state,
    pid: backend.child ? backend.child.pid : null,
    exitCode: backend.exitCode,
    lastError: backend.lastError,
    backendInfo: backend.info,
    mode: app.isPackaged ? 'packaged' : 'dev',
    spawnBackend: SPAWN_BACKEND,
    proxyPort: PROXY_PORT,
    bridgePort: BRIDGE_PORT,
  };
}

function pushStatus() {
  sendToRenderer({ type: 'backend_status', ...status(), timestamp: Date.now() / 1000 });
}

function setError(message) {
  backend.lastError = message;
  console.error('[main]', message);
  sendToRenderer({ type: 'error', message, timestamp: Date.now() / 1000 });
  pushStatus();
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), err });
    });
  });
}

// ---------------------------------------------------------------- bridge server

function startBridgeServer() {
  return new Promise((resolve) => {
    wss = new WebSocketServer({
      host: '127.0.0.1',
      port: BRIDGE_PORT,
      // Browsers always send an Origin header; the backend never does. This stops
      // web pages from talking to the bridge.
      verifyClient: (info) => !info.origin,
    });

    wss.on('listening', () => {
      console.log(`[main] bridge listening on ws://127.0.0.1:${BRIDGE_PORT}`);
      resolve(true);
    });

    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        setError(`Bridge port ${BRIDGE_PORT} is already in use. Close the other program (or other Playtopia Proxy instance) and restart.`);
        dialog.showErrorBox('Playtopia Proxy', `Port ${BRIDGE_PORT} is already in use.\n\nThe backend cannot report traffic to this window. Close whatever is using the port and restart the app.`);
      } else {
        setError(`Bridge server error: ${err.message}`);
      }
      resolve(false);
    });

    wss.on('connection', (ws) => {
      bridgeClients.add(ws);
      console.log('[main] backend connected to bridge');
      pushStatus();

      ws.on('message', (data) => {
        let ev;
        try { ev = JSON.parse(data.toString('utf8')); } catch { return; }
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'hello') {
          backend.info = ev;
          if (!backend.child) backend.state = 'external';
          backend.lastError = null;
          pushStatus();
        }
        sendToRenderer(ev);
      });

      ws.on('close', () => {
        bridgeClients.delete(ws);
        console.log('[main] backend disconnected from bridge');
        pushStatus();
      });
      ws.on('error', () => {});
    });
  });
}

function broadcast(cmd) {
  const data = JSON.stringify(cmd);
  let sent = 0;
  for (const ws of bridgeClients) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(data); sent++; }
  }
  return sent;
}

// ---------------------------------------------------------------- backend process

function backendCommand() {
  const args = ['--port', String(PROXY_PORT), '--bridge-port', String(BRIDGE_PORT),
    '--parent-pid', String(process.pid)];
  if (app.isPackaged) {
    return { file: path.join(process.resourcesPath, 'backend', 'playtopia-backend.exe'), args };
  }
  const python = process.env.PLAYTOPIA_PYTHON || 'python';
  const script = path.join(__dirname, '..', 'backend', 'run_backend.py');
  return { file: python, args: [script, ...args] };
}

function pipeLines(stream, name) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) handleBackendLine(line, name);
    }
  });
}

function handleBackendLine(line, stream) {
  console.log(`[backend] ${line}`);
  if (line.includes('[playtopia-proxy] backend listening on')) {
    backend.state = 'running';
    backend.lastError = null;
    pushStatus();
  }
  if (/address already in use|10048|Errno 98|only one usage of each socket/i.test(line)) {
    backend.lastError = `Proxy port ${PROXY_PORT} is already in use (is another proxy or a manually started backend running?).`;
    pushStatus();
  }
  sendToRenderer({ type: 'backend_log', stream, line, timestamp: Date.now() / 1000 });
}

function startBackend() {
  if (!SPAWN_BACKEND) {
    backend.state = bridgeClients.size ? 'external' : 'stopped';
    pushStatus();
    return;
  }
  if (backend.child) return;

  const { file, args } = backendCommand();
  if (app.isPackaged && !fs.existsSync(file)) {
    setError(`Backend executable not found at ${file}`);
    return;
  }

  console.log(`[main] spawning backend: ${file} ${args.join(' ')}`);
  backend.intentionalStop = false;
  backend.state = 'starting';
  backend.exitCode = null;
  backend.lastError = null;
  pushStatus();

  let child;
  try {
    child = spawn(file, args, {
      cwd: app.isPackaged ? path.dirname(file) : path.join(__dirname, '..', 'backend'),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    setError(`Failed to start backend: ${err.message}`);
    backend.state = 'exited';
    return;
  }
  backend.child = child;
  pipeLines(child.stdout, 'stdout');
  pipeLines(child.stderr, 'stderr');

  child.on('error', (err) => {
    const hint = err.code === 'ENOENT' && !app.isPackaged
      ? ' — is Python on PATH? (set PLAYTOPIA_PYTHON to the interpreter path)' : '';
    setError(`Backend process error: ${err.message}${hint}`);
  });

  child.on('exit', (code, signal) => {
    console.log(`[main] backend exited (code=${code}, signal=${signal})`);
    if (backend.child === child) backend.child = null;
    backend.exitCode = code;
    backend.state = 'exited';
    pushStatus();
    if (!backend.intentionalStop && !quitting) onUnexpectedExit(code);
  });
}

async function onUnexpectedExit(code) {
  sendToRenderer({ type: 'error', message: `Backend exited unexpectedly (code ${code}).${backend.lastError ? ' ' + backend.lastError : ''}`, timestamp: Date.now() / 1000 });
  if (!win || win.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Backend stopped',
    message: 'The proxy backend stopped unexpectedly.',
    detail: `Exit code: ${code}${backend.lastError ? '\n\n' + backend.lastError : ''}\n\nTraffic is no longer being intercepted. If your system proxy still points at 127.0.0.1:${PROXY_PORT}, network access will fail until the backend runs again or the proxy is disabled.`,
    buttons: ['Restart backend', 'Dismiss'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) startBackend();
}

function stopBackend() {
  const child = backend.child;
  if (!child) return Promise.resolve();
  backend.intentionalStop = true;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 3000);
    child.once('exit', done);
    if (process.platform === 'win32') {
      // /T kills the whole tree: the PyInstaller one-file exe runs Python in a child process.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGINT');
    }
  });
}

// ---------------------------------------------------------------- diagnostics

async function getCertThumbprint() {
  try {
    const pem = fs.readFileSync(CERT_PATH);
    const cert = new crypto.X509Certificate(pem);
    return cert.fingerprint.replace(/:/g, '').toLowerCase();
  } catch {
    return null;
  }
}

async function readProxySettings() {
  const r = await run('reg', ['query', INET_KEY]);
  const get = (name) => {
    const m = r.stdout.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi'));
    return m ? m[1].trim() : null;
  };
  const enableRaw = get('ProxyEnable');
  return {
    enabled: enableRaw ? parseInt(enableRaw, 16) === 1 : false,
    server: get('ProxyServer') || '',
    override: get('ProxyOverride'),
  };
}

async function getDiagnostics() {
  const certExists = fs.existsSync(CERT_PATH);
  const thumb = certExists ? await getCertThumbprint() : null;
  let machineStore = false;
  let userStore = false;
  if (thumb && /^[0-9a-f]{40}$/.test(thumb)) {
    // Exact thumbprint lookup. (`certutil -store Root <id>` is unreliable here: it
    // treats numeric-looking ids as an index and exits 0 even when nothing matches.)
    const T = thumb.toUpperCase();
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Test-Path 'Cert:\\LocalMachine\\Root\\${T}'),(Test-Path 'Cert:\\CurrentUser\\Root\\${T}') -join ','`]);
    const [m, u] = r.stdout.trim().split(',');
    machineStore = m === 'True';
    userStore = u === 'True';
  }
  const proxy = await readProxySettings();
  const target = new RegExp(`(127\\.0\\.0\\.1|localhost):${PROXY_PORT}(;|$)`, 'i');
  const proxyOk = proxy.enabled && target.test(proxy.server);
  return {
    certPath: CERT_PATH,
    certExists,
    certThumbprint: thumb,
    certInstalled: machineStore || userStore,
    certInMachineStore: machineStore,
    certInUserStore: userStore,
    installCommand: `certutil -addstore root "${CERT_PATH}"`,
    uninstallCommand: 'certutil -delstore root mitmproxy',
    systemProxy: proxy,
    systemProxyOk: proxyOk,
    proxyAddress: `127.0.0.1:${PROXY_PORT}`,
    proxyChangedByApp: savedProxySettings !== null,
  };
}

async function installCertificate() {
  if (!fs.existsSync(CERT_PATH)) {
    return { ok: false, message: `Certificate not found at ${CERT_PATH}. Start the backend once so mitmproxy generates it.` };
  }
  // Elevated certutil via UAC. Single quotes inside the PowerShell string are doubled.
  const p = CERT_PATH.replace(/'/g, "''");
  const ps = `$p = Start-Process -FilePath certutil -ArgumentList @('-addstore','root','"${p}"') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000 });
  const diag = await getDiagnostics();
  if (diag.certInstalled) return { ok: true, message: 'Certificate installed in the Trusted Root store.' };
  return { ok: false, message: r.code ? `certutil failed or the UAC prompt was cancelled (code ${r.code}).` : 'Certificate does not appear in the Root store.' };
}

const REFRESH_WININET = [
  '$s = \'[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);\'',
  '$t = Add-Type -MemberDefinition $s -Name WinInet -Namespace PlaytopiaProxy -PassThru',
  '[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
  '[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
].join('; ');

async function writeProxySettings({ enabled, server, override }) {
  await run('reg', ['add', INET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enabled ? '1' : '0', '/f']);
  if (server) await run('reg', ['add', INET_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
  else await run('reg', ['delete', INET_KEY, '/v', 'ProxyServer', '/f']);
  if (override) await run('reg', ['add', INET_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f']);
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REFRESH_WININET]);
}

async function setSystemProxy(enable) {
  if (enable) {
    if (!savedProxySettings) savedProxySettings = await readProxySettings();
    await writeProxySettings({ enabled: true, server: `127.0.0.1:${PROXY_PORT}`, override: '<local>' });
  } else if (savedProxySettings) {
    await writeProxySettings(savedProxySettings);
    savedProxySettings = null;
  } else {
    await run('reg', ['add', INET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REFRESH_WININET]);
  }
  return getDiagnostics();
}

function restoreProxySync() {
  // Called on quit: never leave the system pointing at a dead proxy.
  if (!savedProxySettings) return;
  const s = savedProxySettings;
  savedProxySettings = null;
  const reg = (args) => spawnSync('reg', args, { windowsHide: true });
  reg(['add', INET_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', s.enabled ? '1' : '0', '/f']);
  if (s.server) reg(['add', INET_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', s.server, '/f']);
  else reg(['delete', INET_KEY, '/v', 'ProxyServer', '/f']);
  if (s.override) reg(['add', INET_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', s.override, '/f']);
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REFRESH_WININET], { windowsHide: true });
}

// ---------------------------------------------------------------- IPC

function loadRulesSchema() {
  const candidates = [
    path.join(process.resourcesPath || '', 'shared', 'rules_schema.json'),
    path.join(__dirname, '..', 'shared', 'rules_schema.json'),
  ];
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try next */ }
  }
  return null;
}

ipcMain.on('proxy-command', (_e, cmd) => {
  if (cmd && typeof cmd === 'object' && typeof cmd.type === 'string') broadcast(cmd);
});
ipcMain.handle('get-backend-status', () => status());
ipcMain.handle('restart-backend', async () => {
  if (!SPAWN_BACKEND) return status();
  await stopBackend();
  startBackend();
  return status();
});
ipcMain.handle('get-rules-schema', () => loadRulesSchema());
ipcMain.handle('get-diagnostics', () => getDiagnostics());
ipcMain.handle('install-certificate', () => installCertificate());
ipcMain.handle('set-system-proxy', (_e, enable) => setSystemProxy(Boolean(enable)));
ipcMain.handle('copy-text', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('open-cert-folder', () => shell.openPath(path.dirname(CERT_PATH)));

// ---------------------------------------------------------------- app lifecycle

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'Playtopia Proxy',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Runs on every quit path (window close, Ctrl+Q, app.quit()). Must be synchronous:
// async work after 'before-quit' is not guaranteed to finish.
function shutdownSync() {
  if (quitting) return;
  quitting = true;
  restoreProxySync();
  const child = backend.child;
  if (child) {
    backend.intentionalStop = true;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGINT');
    }
  }
  if (wss) {
    for (const ws of bridgeClients) ws.terminate();
    wss.close();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    createWindow();
    const ok = await startBridgeServer();
    if (ok) startBackend();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', shutdownSync);
  app.on('will-quit', shutdownSync);
}
