# Muse Spark Proxy Fix for Desktop
![status](https://img.shields.io/static/v1?label=status&message=fix&color=brightgreen)
![scope](https://img.shields.io/static/v1?label=scope&message=desktop-baseURL&color=blue)
![tested-on](https://img.shields.io/static/v1?label=tested-on&message=Desktop-1.18.21&color=informational)
![license](https://img.shields.io/static/v1?label=license&message=MIT&color=lightgrey)

## TL;DR
Local proxy at `http://127.0.0.1:8787/v1` fixes Desktop `function_call without arguments` 403 by rewriting missing `arguments` to `"{}"` before forwarding to `https://opencode.ai/zen`.

## TOC
- [TL;DR](#tldr)
- [The problem](#the-problem)
- [Root cause](#root-cause)
- [Solution principle](#solution-principle)
- [Requirements](#requirements)
- [Install](#install)
- [Verify](#verify)
- [Troubleshooting/FAQ](#troubleshootingfaq)
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
`lowerToolCall3` drops `arguments` when input is undefined: `part.input === undefined` flows into `lowerToolCall3`, then `encodeJson` omits `arguments`, and the API returns 403.

## Solution principle
Proxy listens on `127.0.0.1:8787`, forwards to `https://opencode.ai/zen`, and rewrites any `function_call` without `arguments` to `"{}"`.
Covers Responses `input[].function_call` and Chat `messages[].tool_calls[].function`.
Fixed signal: `input[403]` error no longer appears, upstream returns 200 with mutated `arguments` `"{}"` and log `mutations=N`.

## Requirements
- Desktop 1.18.21 only.
- Node.js to run [server.js](./server.js).
- PowerShell to run [install_proxy.ps1](./install_proxy.ps1).
- Port 8787 free for prod; tests use 18887-18896; range 8780-8790 is tests-only guard, not for prod.
- SOCKS (optional): installer single-shot auto-detects `127.0.0.1:10808`; server accepts `host:port` or `direct` with strict TCP-probe fail-fast exit 3.

## Install
1. Clone repo.
```sh
git clone https://github.com/kuznecov-anatoliy/opencode-muse-missing-arguments-fix.git
cd opencode-muse-missing-arguments-fix
```
2. Run installer.
```powershell
powershell -ExecutionPolicy Bypass -File ./install_proxy.ps1
```
3. Set Desktop baseURL to:
```
http://127.0.0.1:8787/v1
```
4. Fully quit Desktop, then start it again.
5. Verify with health check below.

## Verify
1. Confirm baseURL is `http://127.0.0.1:8787/v1`.
2. Do a full Desktop restart after install or config change.
3. Health check:
```sh
curl http://127.0.0.1:8787/healthz
```
Expected JSON with `status` `up`.
4. Send a model call; expect upstream 200 with `arguments` `"{}"` and `mutations=N` in log.
Logs go to stderr by default; set `MUSE_PROXY_LOGFILE` to enable file output.

## Troubleshooting/FAQ
- `EADDRINUSE`: server exits 2; installer port failure exits 4 (server 2 maps to installer 4). Installer also uses 0,1,2,3,5,6,7.
- Change or free port 8787 if occupied; keep prod on 8787-8796, tests on 18887-18896.
- SOCKS failure exits 3; use `direct` or a reachable `host:port`.
- Still seeing 403? Confirm baseURL, full restart, and proxy logs show `mutations=N`.
- No file logs? Expected: stderr-only unless `MUSE_PROXY_LOGFILE` or `LOGFILE` is set.

## Limitations
- Only Desktop 1.18.21 is covered.
- Only Responses `input[].function_call` and Chat `messages[].tool_calls[].function` rewriting is covered.
- No support for other Desktop builds or other providers.

## What this is NOT
- Reasoning-pairing #2610: not a pairing or routing change, only a shape fix for missing `arguments`.
- LiteLLM: not a LiteLLM gateway or config, only this Node proxy.
- OpenRouter: not an OpenRouter setup, only forwarding to `https://opencode.ai/zen`.

## Keywords
missing required field arguments, input[403], function_call without arguments, muse spark, openai responses api proxy, baseURL fix, subagents bypass proxy

## License
MIT, see [LICENSE](./LICENSE).
