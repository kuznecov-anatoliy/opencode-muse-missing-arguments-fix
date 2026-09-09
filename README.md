# Muse Spark Proxy Fix for Desktop
![status](https://img.shields.io/static/v1?label=status&message=fix&color=brightgreen)
![scope](https://img.shields.io/static/v1?label=scope&message=desktop-baseURL&color=blue)
![tested-on](https://img.shields.io/static/v1?label=tested-on&message=Desktop-1.18.21&color=informational)
![license](https://img.shields.io/static/v1?label=license&message=MIT&color=lightgrey)

## TL;DR
Local proxy at `http://127.0.0.1:8787/v1` fixes Desktop `function_call without arguments` 403 (`invalid_request_error`) by rewriting missing `arguments` to `"{}"` before forwarding to `https://opencode.ai/zen`.

## TOC
- [TL;DR](#tldr)
- [The problem](#the-problem)
- [Root cause](#root-cause)
- [Solution principle](#solution-principle)
- [Requirements](#requirements)
- [Install](#install)
- [Verify](#verify)
- [Troubleshooting/FAQ](#troubleshootingfaq)
- [Rollback](#rollback)
- [Limitations](#limitations)
- [What this is NOT](#what-this-is-not)
- [Keywords](#keywords)
- [License](#license)

## The problem
Generic shape:
```
input[N]: { type: function_call, ... } missing required field: arguments
```
Observed provider error:
```
Error from provider (Console): Upstream request failed: [invalid_request_error] input[403] missing required field arguments
```
Upstream rejects function_call without arguments with 403.
Related size limit:
```
Error from provider (Console): Upstream request failed: [invalid_request_error] payload_too_large
```
Note: string 411 was not found in current code/docs; only 413 payload_too_large is implemented.
Proxy returns 413 payload_too_large when body exceeds MAX_BODY_BYTES (10 MB, see max_body_bytes in /healthz).

## Root cause
`lowerToolCall3` drops `arguments` when input is undefined: `part.input === undefined` flows into `lowerToolCall3`, then `encodeJson` omits `arguments`, and the API returns 403. (Unverified: author-observed on Desktop 1.18.21; `input[403]` is the single observed case of the `input[N]` template; no external references in this repo.)

## Solution principle
Proxy listens on `127.0.0.1:8787`, forwards to `https://opencode.ai/zen`, and rewrites any `function_call` without `arguments` to `"{}"`.
Covers Responses `input[].function_call` and Chat `messages[].tool_calls[].function`.
Fixed signal: `input[403]` error no longer appears, upstream returns 200 with mutated `arguments` `"{}"` and log `mutations=N`.
Details: [Overview](docs/OVERVIEW.md).

## Requirements
- Windows with PowerShell (installer and tools are Windows-only: Startup/Scheduled Task persistence, `curl.exe` transport).
- Desktop 1.18.21 only. (Unverified: author-tested build; no external references in this repo.)
- Node.js `v22.23.2` to run [server.js](./server.js) (installer pins this version, mismatch exits 1).
- PowerShell to run [install_proxy.ps1](./install_proxy.ps1) (Administrator is required only for `-UseScheduledTask`).
- Port 8787 free for prod; tests use 18887-18896; range 8780-8790 is tests-only guard, not for prod. (Installer STAGE 6 auto-shifts within 8787-8796 if the port is busy; use the port from the install report.)
- SOCKS (optional): installer single-shot auto-detects `127.0.0.1:10808`; server accepts `host:port` or `direct` with strict TCP-probe fail-fast exit 3. To force direct upstream: `-Socks direct`.

## Install
1. Clone repo.
```sh
git clone https://github.com/kuznecov-anatoliy/opencode-muse-missing-arguments-fix.git
cd opencode-muse-missing-arguments-fix
```
2. Run installer.
```powershell
powershell -ExecutionPolicy Bypass -File ./install_proxy.ps1
# To force direct upstream (no SOCKS): add -Socks direct
```
The installer writes `provider.opencode.options.baseURL` into `%USERPROFILE%\.config\opencode\opencode.jsonc` automatically (STAGE 6, `Invoke-JsoncSetBaseUrl`); `$env:OPCODE_CONFIG_PATH` takes priority as the config path when set. The manual baseURL edit below is the equivalent manual step.
3. Set Desktop baseURL to the value from the install report (STAGE 6 auto-shifts within 8787-8796 if the port is busy; default 8787):
```
http://127.0.0.1:8787/v1
```
4. Fully quit Desktop, then start it again. (`-RestartOpenCode` only prints a reminder, it does not restart; Administrator is required only for `-UseScheduledTask`.)
5. Verify with health check below.

## Verify
Use the port from the install report (`baseURL` in `%USERPROFILE%\.config\opencode\opencode.jsonc`); default `8787` (STAGE 6 auto-shifts within `8787-8796` if busy).
1. Confirm baseURL matches the install report, e.g. `http://127.0.0.1:8787/v1`.
2. Do a full Desktop restart after install or config change.
3. Health check:
```powershell
$port = 8787  # from install report / baseURL
curl.exe -s "http://127.0.0.1:$port/healthz"
```
Expected JSON with `status` `up`. (`mutations=N` appears in proxy logs, not in `healthz`; logs go to stderr unless `MUSE_PROXY_LOGFILE` or `LOGFILE` is set.)
4. Send a model call (copyable example, `POST /v1/responses`):
```powershell
$port = 8787  # from install report / baseURL
curl.exe -s "http://127.0.0.1:$port/v1/responses" -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_TOKEN_HERE" -d '{"input":[{"type":"function_call","id":"c1","name":"ping"}],"stream":false}'
```
Expect upstream 200 with `arguments` `"{}"` and `mutations=N` in the proxy log.
5. Repo checks: `node ./tools/smoke-r3.js --port 18887 --mock` (r3 = mock-upstream smoke on test ports) and `tools/verify-r14-dryrun.bat --dry-run` (r14 = installer dry-run, installs nothing).

## Troubleshooting/FAQ
- `EADDRINUSE`: server exits 2; installer port failure exits 4 (server 2 maps to installer 4). Installer also uses 0,1,2,3,5,6,7.
- Change or free port 8787 if occupied; keep prod on 8787-8796, tests on 18887-18896.
- SOCKS failure exits 3; use `direct` or a reachable `host:port`.
- Still seeing 403? Confirm baseURL, full restart, and proxy logs show `mutations=N`.
- No file logs? Expected: stderr-only unless `MUSE_PROXY_LOGFILE` or `LOGFILE` is set.

## Rollback
```powershell
pwsh -ExecutionPolicy Bypass -File ./tools/rollback_proxy.ps1
```
Preview only (no changes, diff output): add `-DryRun`. See `tools/rollback_proxy.ps1 -Help` for outcomes and exit codes.

## Limitations
- Only Desktop 1.18.21 is covered. (Unverified: author-tested build; no external references in this repo.)
- Only Responses `input[].function_call` and Chat `messages[].tool_calls[].function` rewriting is covered.
- No support for other Desktop builds or other providers.
- Windows-only (see Requirements).
- Node.js pinned to `v22.23.2` by the installer.
- Scope: only Zen/Free (`https://opencode.ai/zen`) go via proxy; go/polza connect directly (installer exits 2 without `-Force`).

## What this is NOT
- Reasoning-pairing #2610: not a pairing or routing change, only a shape fix for missing `arguments`.
- LiteLLM: not a LiteLLM gateway or config, only this Node proxy.
- OpenRouter: not an OpenRouter setup, only forwarding to `https://opencode.ai/zen`.

## Keywords
missing required field arguments, input[403], invalid_request_error, function_call without arguments, muse spark, openai responses api proxy, baseURL fix, subagents bypass proxy

## License
MIT, see [LICENSE](./LICENSE).
