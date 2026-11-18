# Playtopia Proxy

A Windows desktop tool that sits between the **Playtopia** game client and its Supabase backend, shows every REST call and Realtime WebSocket message live, and applies modification rules you define. It works like Fiddler or a Growtopia proxy such as GTProxy, but it knows about Supabase and Phoenix Channels.

- **Backend:** Python + [mitmproxy](https://mitmproxy.org) addon. Handles TLS interception, REST/WebSocket hooks, and the rule engine.
- **Frontend:** Electron + vanilla JS. Live traffic log, rule editor, and certificate/proxy setup.

> ⚠️ **Legal / ToS warning.** This is a **local analysis and learning tool**. Modifying live game traffic may violate Playtopia's Terms of Service and can get accounts banned. Use a **throwaway account**, don't use it to gain advantages over other players, and **do not distribute it as a cheat**. You are responsible for how you use it.

Who it's for: people curious about how a Supabase-backed game talks to its server, who want to inspect and experiment with that traffic on their own machine.

---

## Contents

1. [Prerequisites](#prerequisites)
2. [Setup (dev)](#setup-dev)
3. [First-run certificate setup](#first-run-certificate-setup)
4. [Running (dev)](#running-dev)
5. [Building the installer](#building-the-installer)
6. [Usage](#usage)
7. [Rule reference](#rule-reference)
8. [Troubleshooting](#troubleshooting)
9. [Architecture](#architecture)
10. [Non-goals](#non-goals)

---

## Prerequisites

| Requirement | Notes |
| :--- | :--- |
| Windows 10 / 11 | The certificate and system-proxy steps are Windows-specific. |
| Python 3.10+ | `python --version`. Only needed for development or for building the backend. |
| Node.js 18+ | `node --version`. Only needed for development or for building the installer. |
| Administrator rights | Needed once, to put the mitmproxy CA certificate in the Trusted Root store. |

**Target (already confirmed):** all game traffic goes to `vihkaevvrneoelpasidf.supabase.co:443` (TLS 1.3 behind Cloudflare). That covers REST (`/rest/v1/…` PostgREST, `/auth/v1/…` GoTrue) and the Realtime WebSocket (`/realtime/v1/websocket`, Phoenix Channels v1/v2). One host filter catches all of it.

---

## Setup (dev)

From the project root (`playtopia-proxy/`):

```powershell
# optional but recommended: keep mitmproxy's pinned dependencies out of your global Python
python -m venv .venv
.venv\Scripts\activate

pip install -r backend/requirements.txt

cd frontend
npm install
cd ..
```

If you use a venv, make sure it is active in the terminal where you run `npm start`, or set `PLAYTOPIA_PYTHON` to the venv's `python.exe`. The app runs `python` from `PATH` by default.

Run the backend unit tests (Phoenix parsing, JSON paths, and rule matching):

```powershell
cd backend
python -m unittest discover -s tests -v
```

---

## First-run certificate setup

All Playtopia traffic is HTTPS/WSS. To read it, the proxy presents its own certificate, and Windows has to trust mitmproxy's CA. **If you skip this, interception fails silently: you see no traffic and the game can't connect.** The app shows a red banner until it's done.

1. **Generate the CA.** Start the backend once (or just start the app). mitmproxy creates
   `%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer`.

   ```powershell
   python backend/run_backend.py --headless     # Ctrl+C after it prints "backend listening"
   ```

2. **Trust it.** Use one of these:
   - In the app: **Certificate Setup → Install now (admin prompt)**, then accept the UAC prompt.
   - Or in an **elevated** terminal:

     ```powershell
     certutil -addstore root "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer"
     ```

3. **Point the system proxy at the tool:** `127.0.0.1:8080`. Use one of these:
   - In the app: **Certificate Setup → Enable system proxy**. The app remembers your previous setting and restores it when it exits.
   - Or manually: *Settings → Network & Internet → Proxy → Manual proxy setup → Use a proxy server: On*, Address `127.0.0.1`, Port `8080`.

4. **Restart Playtopia** so it picks up the proxy and the certificate.

The Certificate Setup dialog shows a green ✓ or red ✗ for each step, and **Re-check** refreshes them.

By default the backend decrypts **only** the Playtopia host. Traffic to every other host is tunnelled untouched, so leaving the system proxy on while the app runs doesn't break other programs.

**To undo later:** `certutil -delstore root mitmproxy` (elevated), then turn the system proxy off. The proxy is restored automatically if the app set it.

---

## Running (dev)

**Normal: one terminal.** The app starts the backend for you:

```powershell
cd frontend
npm start
```

**Two-terminal flow (optional),** useful when working on the backend and you want its output in a terminal:

```powershell
# terminal 1: backend
python backend/run_backend.py            # waits for the UI on ws://127.0.0.1:8765, reconnecting every 2 s

# terminal 2: UI without spawning its own backend
cd frontend
npm start -- --no-backend
```

**Backend only, no UI.** Events are printed to the console:

```powershell
python backend/run_backend.py --headless
python backend/run_backend.py --headless --rules my.rules.json   # file holds a list of rules
# or plain mitmdump:
cd backend
mitmdump -s addons/playtopia.py
```

`run_backend.py` options:

| Flag | Default | Meaning |
| :--- | :--- | :--- |
| `--port` | `8080` | Proxy listen port |
| `--bridge-port` | `8765` | Port of the UI's bridge WebSocket server |
| `--headless` | off | No bridge; print events to the console |
| `--rules FILE` | – | Load a JSON list of rules at startup |
| `--target-host` | `vihkaevvrneoelpasidf.supabase.co` | Host to intercept |
| `--max-body` | `2000` | Truncate logged bodies (modification always uses the full body) |
| `--mode` | `regular` | mitmproxy mode, e.g. `local:Playtopia.exe` (see Troubleshooting) |
| `--intercept-all` | off | Decrypt every host, not just the target |
| `--parent-pid` | – | Exit when that process dies (the app passes its own PID) |
| `-v` | off | Debug logging |

App environment variables: `PLAYTOPIA_PYTHON` (interpreter used in dev), `PLAYTOPIA_PROXY_PORT`, and `PLAYTOPIA_BRIDGE_PORT`.

---

## Building the installer

```powershell
pip install pyinstaller
python backend/build_backend.py          # -> backend/dist/playtopia-backend.exe

cd frontend
npm run dist                             # -> frontend/dist/Playtopia Proxy Setup 1.0.0.exe
```

`npm run dist` uses `frontend/build.js` (the electron-builder config). It bundles `backend/dist/playtopia-backend.exe` and `shared/rules_schema.json` into the app's `resources/` folder and produces an NSIS installer. Build the backend first, or electron-builder will fail to find the exe.

The packaged app needs no Python or Node on the target machine. You still have to do the [certificate setup](#first-run-certificate-setup) on each machine.

---

## Usage

### The window

- **Top bar:** backend status (green *connected*, yellow *starting*, red *disconnected* with the reason). It also has the proxy address, **Pause/Resume**, **Certificate Setup**, and a **Restart backend** button that appears when the backend is down.
- **Banners:** red = certificate not trusted or TLS failures; yellow = system proxy not set; blue = no traffic seen after a minute.
- **Left: Live Traffic.** One line per event:

  | Colour | Meaning |
  | :--- | :--- |
  | 🔵 blue `REST` | HTTP request `→` or response `←` (status, method, path, duration, size) |
  | 🟢 green `WS` | WebSocket frame `→` client→server / `←` server→client, shown as `topic · event · ref`. `•` = socket opened/closed |
  | 🟠 orange `RULE` | A rule changed (or dropped) a message |
  | 🔴 red `ERR`/`TLS` | Errors, TLS handshake failures |
  | ⚪ grey `LOG` | Backend console output (hidden by default; toggle **Log**) |

  Click any line to expand it. You get the pretty-printed body, the original body if a rule changed it, headers (with `Authorization`/`apikey`/cookies redacted), and the buttons **Create rule from this**, **Copy body**, and **Copy event JSON**.
  The filter bar does a free-text search over path, topic, event, and body, and has per-type toggles. Uncheck **Autoscroll** to read without the log jumping.
- **Right: Rules.** Each card has an enable switch, a hit counter, and **Edit**/**Delete**. *Clear All Rules* removes everything. If a rule matched but couldn't change anything (e.g. JSON path not found), the card shows the reason under *last match without change*.

**Pause** turns the proxy into a pure pass-through: nothing is logged and no rules are applied until you resume.

### Adding a rule (example: change your display name)

1. Log in through the proxy. Find a `REST ← 200 GET /rest/v1/<table>?…` response whose body contains your name, and click it.
2. Click **Create rule from this**. Target, method, path, and direction (*server*) are pre-filled.
3. Action **replace_json_field**:
   - JSON path: PostgREST returns arrays, so use `*.display_name` (or `0.display_name` for just the first row). Use whatever key you actually see in the body.
   - New value: `"Tester"`
4. **Save rule.** It's stored locally and pushed to the backend immediately.

For a WebSocket chat example, expand a server→client `broadcast` frame. If the body is `{"event":"broadcast","payload":{"type":"broadcast","event":"chat","payload":{"message":"hi"}}}`, then the path `payload.payload.message` with a new value of `"intercepted!"` rewrites incoming chat text. The same path works for Phoenix v2 array frames (see below).

### Checking that a rule worked

- An orange `RULE` line appears each time the rule fires, and the rule's hit counter goes up.
- The affected traffic line gets a **modified** tag. Expand it to compare **Body (after rules)** with **Original body**.
- The change shows up in-game. Some data is cached client-side, so you may need to re-open the screen or re-enter the world.
- If nothing happens, look for *last match without change* on the rule card, then see [Troubleshooting](#troubleshooting).

Rules are saved in the app's `localStorage`. They survive restarts and are re-sent to the backend every time it (re)connects.

---

## Rule reference

The canonical definition is [`shared/rules_schema.json`](shared/rules_schema.json) (JSON Schema, with examples). The UI validates against it.

```json
{
  "id": "rename-me",
  "enabled": true,
  "target": "rest",
  "match": { "method": "GET", "path_contains": "/rest/v1/profiles", "direction": "server", "contains": "display_name" },
  "action": { "type": "replace_json_field", "path": ["*", "display_name"], "value": "Tester" }
}
```

**`target`:** `rest` (HTTP) or `ws` (WebSocket frames).

**`match`:** every field is optional, and all present fields must match.

| Field | Applies to | Meaning |
| :--- | :--- | :--- |
| `method` | rest | `GET` `POST` `PATCH` `PUT` `DELETE` |
| `path_contains` | both | Substring of the path + query (for ws: the socket URL) |
| `event` | ws | Exact Phoenix event (`phx_join`, `phx_reply`, `broadcast`, `postgres_changes`, `presence_diff`, …) |
| `direction` | both | `client` = request / client→server frame; `server` = response / server→client frame; omit for both |
| `contains` | both | Substring of the body/frame **before** modification |

An empty `match` is a **wildcard**. The UI warns you, because it applies to every message of that target.

**`action`:**

| Type | Fields | Notes |
| :--- | :--- | :--- |
| `replace_json_field` | `path`, `value` | Replaces an **existing** field only (never creates one). `path` is a list of keys/indices; `"*"` matches every array element or object value. `value` can be any JSON value. |
| `string_replace` | `from`, `to` | Replaces every occurrence in the body/frame text. |
| `drop` | – | **ws only.** The frame is never delivered. |

**Phoenix v1 vs v2:** v1 frames are objects (`{"topic","event","payload","ref"}`), and v2 frames are arrays (`[join_ref, ref, topic, event, payload]`). For ws rules, a path that starts with `payload` (or `topic`/`event`/`ref`/`join_ref`) is mapped to the right array index automatically, so one rule works for both.

Rules run in the order they were created, and each one sees the previous rule's output. Content-Length and compression are handled by mitmproxy. JWTs and auth headers are passed through untouched.

---

## Troubleshooting

**No traffic appears**
- Red certificate banner, or red `TLS` lines in the log: the CA isn't trusted. Redo [certificate setup](#first-run-certificate-setup) and **restart the game**.
- Yellow proxy banner: the system proxy isn't `127.0.0.1:8080`. Enable it in Certificate Setup.
- Both are green but still nothing: the game may ignore the system proxy (some engines do). Try mitmproxy's local capture mode, which needs an elevated terminal: `python backend/run_backend.py --mode local:Playtopia.exe` (use the game's real process name), then `npm start -- --no-backend`.
- TLS errors persist after installing the CA: the client may pin certificates. This tool doesn't bypass pinning (see [Non-goals](#non-goals)).
- The game's network breaks entirely while the app is closed: the system proxy still points at `127.0.0.1:8080`. Turn it off in Windows settings. The app restores it automatically only if the app was the one that set it.

**"Backend: disconnected"**
- **Port 8765 in use:** another program, or a second copy of the app, holds the bridge port. The app shows an error dialog at startup. Close the other program or set `PLAYTOPIA_BRIDGE_PORT` (and pass the same `--bridge-port` if you start the backend manually).
- **Port 8080 in use:** the backend exits right away and the status shows "Proxy port 8080 is already in use". Close the other proxy, or a manually started backend, or set `PLAYTOPIA_PROXY_PORT`.
- **`spawn python ENOENT` (dev):** Python isn't on `PATH`. Set `PLAYTOPIA_PYTHON=C:\path\to\python.exe`.
- **The backend crashed:** a dialog offers **Restart backend**, and the same button is in the top bar. The full backend output is in the log (toggle **Log**).

**Rules don't apply**
- **Paused:** the top bar shows a yellow *PAUSED* chip. Click **Resume**.
- **Host mismatch:** the backend only touches `vihkaevvrneoelpasidf.supabase.co`. If the game moved to another Supabase project, start the backend with `--target-host <new host>`. The connected log line shows which host is being intercepted.
- The rule card shows **not on backend**, or the sync line reads "Backend has N/M rule(s)": the backend rejected a rule (look for a red `ERR` line explaining why) or isn't connected.
- **Matched but didn't change:** the card shows *last match without change*. Typical reasons are a JSON path that isn't found (check the key names and array nesting; PostgREST returns arrays, so start with `*`), a body that isn't JSON, or a `from` text that isn't present.
- **Direction:** for a REST response you need direction `server` (or both).
- **The body was truncated in the log:** only the display is truncated (2000 chars); rules always see the full body.

---

## Architecture

The two processes talk over a local JSON-over-WebSocket bridge. stdin/stdout are deliberately not used, because mitmproxy writes logs to the console and that would corrupt a stdio channel. The backend is a mitmproxy addon (`backend/addons/playtopia.py`) that filters on the Supabase host. It logs REST requests/responses and WebSocket frames, detects the Phoenix v1/v2 format, applies rules, and streams events through `backend/addons/bridge.py`, a client that reconnects every 2 s and queues events while disconnected. The Electron main process (`frontend/main.js`) hosts the bridge server, spawns/kills/restarts the backend, relays events to the renderer, and relays the renderer's commands (`set_rule`, `delete_rule`, `clear_rules`, `set_paused`) back. TLS MITM, certificate generation, HTTP/2, and WebSocket framing are all delegated to mitmproxy.

```
 ┌──────────────┐  HTTPS / WSS   ┌────────────────────────────────────┐  HTTPS / WSS   ┌──────────────────────────────┐
 │ Playtopia    │ ─────────────► │ Backend (Python)                   │ ─────────────► │ vihkaevvrneoelpasidf         │
 │ game client  │ ◄───────────── │ mitmproxy + PlaytopiaAddon         │ ◄───────────── │   .supabase.co (Cloudflare)  │
 └──────────────┘  proxy :8080   │  • host filter  • rule engine      │                │  /rest/v1  /auth/v1          │
                                 │  • REST + WS hooks • Bridge client │                │  /realtime/v1/websocket      │
                                 └───────────────┬────────────────────┘                └──────────────────────────────┘
                                                 │ JSON over WebSocket
                                                 │ ws://127.0.0.1:8765
                                 ┌───────────────┴────────────────────┐
                                 │ Frontend (Electron)                │
                                 │  main.js: bridge server, spawns    │
                                 │           backend, cert/proxy diag │
                                 │  renderer: traffic log, rule editor│
                                 │           (rules in localStorage)  │
                                 └────────────────────────────────────┘
```

Bridge messages:

| Direction | Messages |
| :--- | :--- |
| backend → UI | `hello`, `rest`, `ws`, `ws_lifecycle`, `rule_applied`, `rule_noop`, `state`, `error`, `tls_error` |
| UI → backend | `set_rule`, `delete_rule`, `clear_rules`, `set_paused` |

Example events:

```json
{"type": "rest", "direction": "response", "method": "GET", "path": "/rest/v1/profiles?select=*", "status": 200, "body": "...", "timestamp": 1731974400.123}
{"type": "ws", "direction": "server", "text": "...", "is_binary": false, "length": 123, "topic": "realtime:world", "event": "phx_reply", "phx_version": "v2", "timestamp": 1731974400.456}
{"type": "rule_applied", "rule_id": "rename-me", "flow_summary": "REST response GET /rest/v1/profiles?select=* 200"}
```

Project layout:

```
playtopia-proxy/
├── README.md                  # this file (the only documentation)
├── .gitignore
├── backend/
│   ├── addons/
│   │   ├── __init__.py
│   │   ├── playtopia.py       # main interception addon + rule engine
│   │   └── bridge.py          # WebSocket client to Electron
│   ├── tests/test_playtopia.py
│   ├── run_backend.py         # entry point (programmatic mitmdump)
│   ├── requirements.txt
│   └── build_backend.py       # PyInstaller one-file build
├── frontend/
│   ├── main.js  preload.js  package.json  build.js
│   └── renderer/ index.html  app.js  style.css
└── shared/
    └── rules_schema.json      # canonical rule format (JSON Schema)
```

Safety details: the bridge server binds only to `127.0.0.1` and rejects connections that carry a browser `Origin` header. All traffic content is rendered as text, never as HTML. The backend exits if the app process dies, and the app kills the backend's whole process tree on quit.

---

## Non-goals

- No game-client patching, binary modification, memory editing, or anti-cheat / certificate-pinning bypass.
- No protocols beyond HTTP/HTTPS/WebSocket.
- No JWT forging or token manipulation. Tokens pass through untouched (and are redacted in the UI).
- No rule marketplace, remote sync, accounts, or telemetry. Nothing leaves your machine except the game's own traffic.
- No heavy frontend framework. The UI is vanilla JS.
- No interpretation of Playtopia's game logic. The tool is protocol-agnostic: it shows JSON and text, and you decide what to change.
