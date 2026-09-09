# Agents

Notes for automation working in this repo.

## Ports and URLs

- Primary port `8787`, prod shift `8787-8796`, tests `18887-18896`.
- Tests-only guard `8780-8790`.
- Base URL `http://127.0.0.1:8787/v1`.
- Upstream `https://opencode.ai/zen`.

## Canonical Failure

- Bug: `lowerToolCall3` drops `arguments` when `input` is undefined. (Unverified: author-observed; no external links in repo.)
- Canonical block:
- `input[N]: { type: function_call, ... } missing required field: arguments`
- Full provider error:
- `Error from provider (Console): Upstream request failed: [invalid_request_error] input[403] missing required field arguments`
- Template: `input[N]` where `N` is the item index in `input[]`. (Unverified: `input[403]` is the single observed case.)

## Fix

- Rewrite `function_call` without `arguments` to `"{}"`.
- Cover Responses `input[].function_call`.
- Cover Chat `messages[].tool_calls[].function`.
- Listen `127.0.0.1:8787`, forward to upstream.

## Ops

- Logs to `stderr`; file only if `MUSE_PROXY_LOGFILE` or `LOGFILE` set.
- Server `EADDRINUSE` = `2`; installer port failure = `4`.
- SOCKS: installer auto-detects `127.0.0.1:10808`; server accepts `host:port` or `direct` with fail-fast exit `3`.
- Desktop `1.18.21` only (Unverified: author-tested; no external links in repo); full restart required.
- Files: `server.js`, `install_proxy.ps1`, `tools/rollback_proxy.ps1`, `tools/smoke-r3.js`, `tools/verify-r14-dryrun.bat`.
- See [Requirements](README.md#requirements), [Install](README.md#install), [Verify](README.md#verify).

## Install and Verify

- Install: run `install_proxy.ps1`, then full Desktop restart.
- Verify: run `tools/smoke-r3.js` and `tools/verify-r14-dryrun.bat`, check `healthz` JSON `status` `up`; `mutations=N` appears in proxy logs, not in `healthz`.
- See [Install](README.md#install) and [Verify](README.md#verify).
- Details: [The problem](README.md#the-problem), [Root cause](README.md#root-cause), [Solution principle](README.md#solution-principle), [Troubleshooting/FAQ](README.md#troubleshootingfaq).
