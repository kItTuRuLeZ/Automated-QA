# LAN demo mode (optional)

By default the app listens on `127.0.0.1:4317` and only this computer can open it. LAN demo mode lets other people on the same local network open the app from their own browser for a demo, behind one shared password.

It is off unless you turn it on at start-up. Nothing in the app can turn it on.

## What changes, and what does not

| Part | Default (loopback) | LAN demo mode |
| --- | --- | --- |
| App (UI and API) | `127.0.0.1:4317` | **only** `<your LAN IPv4>:4317`; no longer reachable on `127.0.0.1` |
| Accepted `Host` / `Origin` | `127.0.0.1` and `localhost` on 4317 and 5317 | exactly `<your LAN IPv4>:4317` and `http://<your LAN IPv4>:4317` |
| Sign-in | none | required for every page, API call, upload, report download, and screenshot |
| Other request checks (`Sec-Fetch-Site`, `X-QA-Request`, JSON-only, upload type) | on | on, unchanged, checked before sign-in |
| Package server | `127.0.0.1:4318` | `127.0.0.1:4318` (unchanged, never on the network) |
| Scan worker, network policy, browser sandbox | unchanged | unchanged |

The address is set only for the app's own listener in `apps/server/src/main.ts`. The shared setting `SERVER_HOST` in `packages/core/src/config.ts` stays `127.0.0.1`, which is what the package server, the worker, and the CLI use.

The server refuses to start in LAN mode (and exposes nothing) when:

- `CQA_LAN_HOST` is not a single IPv4 address, for example a host name, `0.0.0.0`, or an IPv6 address.
- The address is not private (`10.x.x.x`, `172.16.x.x` to `172.31.x.x`, `192.168.x.x`). Loopback, link-local (`169.254.x.x`), and public addresses are refused.
- The address does not belong to a network adapter of this computer.
- `CQA_LAN_PASSWORD` is missing or shorter than 12 characters.

## Windows: start in LAN demo mode

All commands are for **PowerShell**. Use Node.js 24 and run `npm install` and `npm run browsers:install` once beforehand, as in [SETUP.md](SETUP.md).

### 1. Find this computer's LAN address

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)' } | Select-Object IPAddress, InterfaceAlias
```

Pick the address of the adapter on the demo network (for example `Wi-Fi` or `Ethernet`). The examples below use `192.168.1.50`; replace it with yours. `ipconfig` shows the same thing as "IPv4 Address".

### 2. Check the network is marked Private

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias, Name, NetworkCategory
```

The demo network should show `Private`. Do not run the demo on a network marked `Public` (cafés, hotels, guest Wi-Fi). Changing the category is a Windows setting: **Settings > Network & internet > Wi-Fi (or Ethernet) > your network > Network profile type > Private network**.

### 3. Allow the app's port through Windows Firewall

Run this once in an **administrator** PowerShell window. It opens TCP 4317 only, only for Private networks, and only to devices on the same subnet. Port 4318 (the package server) is not opened.

```powershell
New-NetFirewallRule -DisplayName "Course QA LAN demo (TCP 4317)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4317 -Profile Private -RemoteAddress LocalSubnet
```

If Windows also shows a "Windows Defender Firewall has blocked some features of Node.js" prompt when the app starts, choose **Cancel** (or tick Private networks only). The rule above is enough, and it is narrower than the rule that prompt creates.

### 4. Start the app

In a normal PowerShell window, from the repository folder:

```powershell
cd D:\projects\Automated-QA\tool
$env:CQA_LAN_HOST = "192.168.1.50"
$env:CQA_LAN_PASSWORD = "choose-a-demo-password-12+"
npm start
```

The server log shows `LAN demo mode: app listening on the local network, sign-in required` with the address. If it shows an error instead, it says which of the rules above was not met.

These `$env:` values last only for that PowerShell window. Close the window (or open a new one) to go back to the default loopback mode.

Use LAN mode with `npm start` only. `npm run dev` (the Vite dev server) expects the app on `127.0.0.1` and will not work in LAN mode.

### 5. Open it

- From another device on the same network: `http://192.168.1.50:4317`
- From this computer: also `http://192.168.1.50:4317`. `http://127.0.0.1:4317` does not answer in LAN mode.

You are sent to a sign-in page first. Enter the demo password. A sign-in lasts 12 hours; to sign out, open `http://192.168.1.50:4317/logout`. Restarting the app signs everyone out. Ten wrong passwords from one device lock that device out for 15 minutes.

### 6. After the demo

Stop the app (Ctrl+C), close the PowerShell window, and remove the firewall rule in an administrator PowerShell window:

```powershell
Remove-NetFirewallRule -DisplayName "Course QA LAN demo (TCP 4317)"
```

## Using a different port

`CQA_PORT` changes the app's port in both modes. If you set it, use the same number in the firewall rule and in the address you open. Keep it different from `CQA_PACKAGE_PORT` (4318).

```powershell
$env:CQA_PORT = "8080"
New-NetFirewallRule -DisplayName "Course QA LAN demo (TCP 8080)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Private -RemoteAddress LocalSubnet
```

## Limits

- **Plain HTTP.** The password and session cookie travel unencrypted on the network. Use LAN mode only on a network you trust, and use a password you do not use anywhere else.
- **One shared password, no user accounts.** Everyone who signs in can see, change, and delete every project, scan, package, and report. Issue status changes are recorded as "local user".
- **Demo, not hosting.** This is not the shared, multi-user deployment described as not included on the About page.
- **Scans still run on this computer.** Courses and uploaded packages are scanned in Chromium on the computer running the app, with the same network policy. Scanned course code cannot reach the app at the LAN address: private addresses are denied by the scan proxy, and the scan browser never holds a sign-in cookie.
