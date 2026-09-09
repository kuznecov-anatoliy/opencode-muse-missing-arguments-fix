# Overview

Local proxy that normalizes tool-call payloads for Muse Spark.

## Composition

- `server.js` - proxy entrypoint, listen and forward.
- `install_proxy.ps1` - install and configure autostart.
- `tools/rollback_proxy.ps1` - remove proxy configuration.
- `tools/smoke-r3.js` - mock smoke test for normalization.
- `tools/verify-r14-dryrun.bat` - installer dry-run verification.

## Network

- Listen: `127.0.0.1:8787`.
- Upstream: `https://opencode.ai/zen`.
- Primary port: `8787`.
- Prod shift range: `8787-8796`.
- Test range: `18887-18896`.
- Range `8780-8790` is tests-only guard, never for prod.
- Base URL: `http://127.0.0.1:8787/v1`.
- SOCKS: installer auto-detects `127.0.0.1:10808`; server accepts `host:port` or `direct` with fail-fast exit `3`.

## Bug and Fix

- `lowerToolCall3` drops `arguments` when `input` is undefined.
- Provider rejects with `403`:
- `Error from provider (Console): Upstream request failed: [invalid_request_error] input[403] missing required field arguments`
- Proxy rewrites `function_call` without `arguments` to `"{}"`.
- Applies to Responses `input[].function_call`.
- Applies to Chat `messages[].tool_calls[].function`.
- See [The problem](README.md#the-problem), [Root cause](README.md#root-cause), [Solution principle](README.md#solution-principle).

## Logging

- Default output is `stderr`.
- File output only if `MUSE_PROXY_LOGFILE` or `LOGFILE` is set.
- See [Verify](README.md#verify), [Troubleshooting/FAQ](README.md#troubleshootingfaq).

## Exit Codes

- Server `EADDRINUSE` exits with `2`.
- Installer port failures exit with `4`.
- Server `2` maps to installer `4`.
- See [Troubleshooting/FAQ](README.md#troubleshootingfaq).

## Desktop

- Supported version: `1.18.21` only.
- After config change do full Desktop restart.
- Health check: `healthz` returns JSON with `status` `up`.
- Health includes `mutations=N` counter.
- See [Requirements](README.md#requirements), [Install](README.md#install), [Verify](README.md#verify).

## Verified

- Mock smoke: normalize plus `413` plus upstream `403/429/500` passthrough.
- Installer dry-run passed.
- Base URL plus full Desktop restart plus `healthz` JSON verified.
- See [Install](README.md#install) and [Verify](README.md#verify).
