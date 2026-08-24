# Clipboard

Moonlight Web supports text clipboard transfer in both directions:

- **Paste into the desktop:** built in. The browser sends text through Moonlight Web's existing text-input packet, so no companion or Sunshine change is required.
- **Copy out of the desktop:** enable the optional clipboard companion on the Windows or Linux Sunshine host.

The full Moonlight client's `Ctrl+Alt+Shift+V` shortcut is a different implementation and is not used here.

## Use the clipboard panel

Open the sidebar while streaming:

- **Paste to desktop** sends text typed into the panel.
- **Use browser clipboard** reads the browser clipboard and pastes it.
- **Copy from desktop** copies the current remote selection, retrieves the host clipboard, and writes it to the browser clipboard.
- **Redirect Ctrl/Cmd+C and V** enables familiar shortcuts for the current browser. The choice is saved locally.

Browser clipboard access normally requires HTTPS or localhost. If browser copy is denied, Moonlight Web selects the retrieved text in the panel so it can still be copied manually.

## Enable copy-out

This is the supported split-host topology:

```text
Browser ──HTTPS──> NGINX + Moonlight Web (Linux bastion)
                         ^
                         │ outbound authenticated WSS
                         │
                  Clipboard companion + Sunshine
                  (Windows or Linux target desktop)
```

The companion is the same project-provided `web-server` executable in a separate mode. It makes an outbound authenticated WebSocket connection from the Sunshine target to the bastion, so the bastion does not need inbound access to the target. Run it in the logged-in graphical session that owns the clipboard—not Windows Session 0, a Windows service, or a headless Linux service. No Sunshine source change or plugin is required.

1. On the bastion, generate a secret and its hash:

   ```sh
   ./web-server clipboard-token
   ```

   Store `token_sha256` in the bastion config. Store the plaintext `token` only in the host's secret environment.

2. Find the host's **Web Id** in Moonlight Web's host details, then configure the bastion:

   ```json
   {
     "web_server": {
       "clipboard_bridge": {
         "agents": [
           {
             "host_id": 123,
             "token_sha256": "PASTE_TOKEN_SHA256_HERE"
           }
         ],
         "max_text_bytes": 262144,
         "request_timeout": { "secs": 5, "nanos": 0 }
       }
     }
   }
   ```

   Restart the bastion server after changing its config. Add one agent entry per Sunshine host.

3. Ensure NGINX forwards WebSocket upgrades. If your normal Moonlight Web proxy location already does this, no separate route is needed:

   ```nginx
   map $http_upgrade $connection_upgrade {
       default upgrade;
       ''      close;
   }

   location /moonlight/ {
       proxy_pass http://127.0.0.1:8080/moonlight/;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection $connection_upgrade;
       proxy_set_header Host $host;
   }
   ```

   Omit `/moonlight` when `url_path_prefix` is empty.

4. Run the matching release build on the Sunshine host (`x86_64-pc-windows-gnu` for Windows, or the matching GNU/musl Linux archive). The same executable can run either the web server or this companion mode; it does not start a second web UI when invoked with `clipboard-agent`.

   Windows PowerShell, in the logged-in desktop session:

   ```powershell
   $env:CLIPBOARD_AGENT_TOKEN = "PASTE_PLAINTEXT_TOKEN_HERE"
   .\web-server.exe clipboard-agent `
     --server wss://bastion.example.com/moonlight/api/clipboard/agent `
     --host-id 123
   ```

   Linux, in the graphical user's session:

   ```sh
   export CLIPBOARD_AGENT_TOKEN='PASTE_PLAINTEXT_TOKEN_HERE'
   ./web-server clipboard-agent \
     --server wss://bastion.example.com/moonlight/api/clipboard/agent \
     --host-id 123
   ```

For automatic startup, use a Windows Task Scheduler **At log on** task with **Run only when user is logged on**, or a Linux `systemd --user` service tied to the graphical session. Keep the token in a user-readable-only environment file or your host secret manager. The companion reconnects automatically.

## Behavior and limits

- Text only; the default maximum is 256 KiB in each direction.
- Copy-out is deliberately disabled when no companion is configured.
- If companion-assisted paste is temporarily unavailable, paste automatically falls back to Moonlight Web's native text-input path.
- Clipboard text and plaintext tokens are not written to application logs.
- No Sunshine patch, plugin, or host API exposure is required.
