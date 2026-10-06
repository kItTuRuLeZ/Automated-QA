# LAN demo mode (optional)

Lets people on the same local network open this copy of the app in their browser for a stakeholder demo or user testing. **It is off by default.** Without the settings below the app listens on `127.0.0.1` only, exactly as before.

Read "What this does and does not protect" before using it.

## What changes in LAN mode

| Area | Behaviour |
| --- | --- |
| Where the app listens | Only on the one private IPv4 address you name in `CQA_LAN_HOST`, on `CQA_PORT` (default 4317). It does **not** listen on `127.0.0.1`, on `0.0.0.0`, or on any other address. |
| Host and Origin checks | The same checks as before, but the only accepted values are exactly `<your-ip>:<port>` and `http://<your-ip>:<port>`. Requests with any other Host or Origin, and cross-site requests, are refused. The `X-QA-Request` and JSON rules for changes are unchanged. |
| Sign-in | Required for the UI, every API, uploads, screenshots and every report download. Without a session, pages redirect to a sign-in page and API calls answer 401. Nothing is served before sign-in except the sign-in page itself. |
| Package server | Unchanged: `127.0.0.1:4318`, read only, separate origin. It is not reachable from the network. Scans of uploaded courses still open them from `http://127.0.0.1:4318`. |
| Worker, scan network rules, browser sandbox | Unchanged. Private, local and reserved addresses are still blocked for scanning, so a scan cannot be pointed at this app or at other devices on the LAN. |
| Failure | If anything in the LAN settings is missing or unsafe the app refuses to start and says why. It never falls back to another address. |

The bind address is decided in the server app (`apps/server/src/lan.ts`, `main.ts`). The shared core configuration (`SERVER_HOST`, `PACKAGE_PORT`) is not changed, which is why the package server stays on loopback.

## Settings

| Variable | Required | Meaning |
| --- | --- | --- |
| `CQA_LAN_HOST` | Yes, to turn LAN mode on | This computer's private IPv4 address, for example `192.168.1.50`. Must be in 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16 and belong to a network adapter on this computer. Not `0.0.0.0`, not `127.x`, not a name. |
| `CQA_LAN_PASSWORD` | Yes | At least 12 characters, not equal to the user name. There is no default. |
| `CQA_LAN_USER` | No | Defaults to `demo`. Letters, digits, `.`, `-`, `_`; up to 32 characters. |
| `CQA_PORT` | No | Port for the app, default 4317. |

## Windows: start it (PowerShell)

1. **Find this computer's address.** Open PowerShell and run:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object InterfaceAlias, IPAddress
   ```

   Pick the address of the network the other people are on (Wi-Fi or Ethernet). The steps below use `192.168.1.50`; use yours.

2. **Open the firewall for that one port, for that network only.** Run PowerShell **as Administrator** once. Replace `192.168.1.0/24` with your network (the first three numbers of your address, then `.0/24`):

   ```powershell
   New-NetFirewallRule -DisplayName "Course QA LAN demo" -Direction Inbound -Protocol TCP -LocalPort 4317 -LocalAddress 192.168.1.50 -RemoteAddress 192.168.1.0/24 -Profile Private -Action Allow
   ```

   If Windows labels your network "Public", either switch it to Private in Settings, or leave the rule as it is: it will not apply and others will not be able to connect. Do not use `-Profile Any` or `-RemoteAddress Any`.

3. **Start the app in a normal (not Administrator) PowerShell** in the repository folder. Set the settings only in this window:

   ```powershell
   cd D:\projects\Automated-QA\tool
   $env:CQA_LAN_HOST = "192.168.1.50"
   $env:CQA_LAN_USER = "demo"
   $secure = Read-Host "Demo password (12 or more characters)" -AsSecureString
   $env:CQA_LAN_PASSWORD = [System.Net.NetworkCredential]::new("", $secure).Password
   npm start
   ```

   `npm start` builds the interface and starts the app and the worker together. Both read the settings from this window. You should see `LAN demo mode is ON` followed by `server listening` with `http://192.168.1.50:4317`, and `package server listening` with `http://127.0.0.1:4318`.

4. **Check it works.** On this computer open `http://192.168.1.50:4317` (not `localhost` and not `127.0.0.1`: the app is not listening there in this mode). You should land on the sign-in page. On another device on the same network, open the same address.

5. **Share the address and password** with the people in the room, in person or in a message that is not public. Tell them it is plain HTTP.

6. **When the demo is over:** press `Ctrl+C` in the PowerShell window, close the window (this removes the password from the environment), and remove the firewall rule from an Administrator PowerShell:

   ```powershell
   Remove-NetFirewallRule -DisplayName "Course QA LAN demo"
   ```

To go back to this-computer-only mode, start the app in a window where `CQA_LAN_HOST`, `CQA_LAN_USER` and `CQA_LAN_PASSWORD` are not set (`Remove-Item Env:CQA_LAN_HOST, Env:CQA_LAN_USER, Env:CQA_LAN_PASSWORD -ErrorAction SilentlyContinue`).

## If it will not start

The app prints every problem and stops. Common ones:

| Message | Fix |
| --- | --- |
| `CQA_LAN_HOST ... is not an address of this computer` | The IP changed (Wi-Fi gives out new addresses). Run step 1 again. |
| `CQA_LAN_PASSWORD is required` / `at least 12 characters` | Set the password in the same window you run `npm start` in. |
| `CQA_LAN_PASSWORD is set but CQA_LAN_HOST is not` | Set `CQA_LAN_HOST`, or clear the password variable to stay local. |
| Port already in use | Another copy is running. Stop it, or set `CQA_PORT` and change the firewall rule to match. |
| Others cannot connect but it works on this computer | Firewall rule missing, wrong network profile (Public), different network or VLAN, or "client isolation" on the Wi-Fi. |

## What this does and does not protect

Protected:

- Nobody can see or change anything without signing in: the UI files, all APIs, uploads, screenshots and report downloads all require a session.
- A wrong password is never revealed as "wrong user" or "wrong password" separately; five wrong tries from one address lock that address out for five minutes.
- Sessions are random tokens held in the app's memory (stopping the app signs everyone out), end after 60 minutes without use or 8 hours at most, and the cookie is `HttpOnly` and `SameSite=Strict`.
- Responses are marked `no-store` so reports and screenshots are not kept in shared browser caches.

Not protected, so plan around it:

- **It is plain HTTP.** The password and session cookie cross the network unencrypted. Anyone who can watch traffic on the network (for example on shared or public Wi-Fi) can read them. Use it only on a network you trust, for a short time, and change the password for each demo. HTTPS is not part of this mode.
- **One shared account.** Everyone who signs in is the same user. Anyone signed in can create scans, change issue statuses, upload files and delete projects.
- **Uploads run course code.** A scan of an uploaded package runs its JavaScript in a browser on this computer without a container. Only let people you trust upload packages in a LAN demo.
- **Do not put real client data on a demo machine** unless everyone on the network is allowed to see it.
- The password is held in an environment variable for the life of the PowerShell window. Do not save it in a file or a shortcut.
