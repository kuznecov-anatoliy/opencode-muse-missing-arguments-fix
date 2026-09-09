# install_proxy.ps1 v2 — install muse-spark-proxy (8 stages SPEC, codes 0-7)
# Startup prod: pwsh -ExecutionPolicy Bypass -File install_proxy.ps1 [-Port 8787] [-Socks 127.0.0.1:10808|direct] [-Upstream https://opencode.ai/zen] [-SkipProbe] [-Force] [-UseScheduledTask] [-DryRun|-WhatIf] [-RestartOpenCode]
# Startup test: pwsh -ExecutionPolicy Bypass -File install_proxy.ps1 -TestMode [-Port 18887] [-Socks ...] [-Upstream <mock>] [-ConfigPath <temp>] [-DryRun]
# PS5.1-compatible syntax strict (without ??, ternaries, ?. ).
# Codes: 0 success / 1 environment / 2 network-upstream / 3 SOCKS / 4 port / 5 persistence / 6 JSONC-marker-vendor / 7 smoke.
# marker corrupt vs jsonc fail differ TEXT messages (both exit 6).
# files-pin (Test-FilesPin): mismatch/absence of baseline.json -> exit 1 (distinct from exit 6 JSONC/vendor; enforces files[]+changedFiles last-wins, norm SHA256 UPPER+size via Get-NormalizedBytes).
# Migration: old exit 1 on busy port -> exit 4. server exit(2) EADDRINUSE -> installer 4.

param(
    [int]$Port = 0,
    [string]$Socks = '',
    [string]$Upstream = '',
    [string]$ConfigPath = '',
    [string]$StartupDir = '',
    [switch]$SkipProbe,
    [switch]$Force,
    [switch]$UseScheduledTask,
    [switch]$DryRun,
    [switch]$WhatIf,
    [switch]$RestartOpenCode,
    [switch]$TestMode,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# baseline guard: self-guard (read-only + signature). Canonicalization hash: UTF8 without BOM, CRLF/CR->LF (unified LF mode), SHA256 HEX UPPER.
# Signature = SHA256 canonicalized text baseline.json WITHOUT signature-lines. Excision deterministically regex:
# (?m)^\s*"signature"\s*:\s*"[^"]*"\s*,?\s*\r?\n -> '' (pinned here and in smoke-r3.js).
# KNOWN LIMITATION: read-only bypassed (attrib easily strip), sidecar without external signature = self-signed.
# Therefore: mismatch signature -> fail-closed exit 1; absence read-only -> WARNING only. Re-verify after update baseline required.
# Prod-touch gate: live runs only with mock/upstream-override; default https://opencode.ai/zen — only default, not live request (probe only explicit curl, in DryRun/TestMode forbidden without -SkipProbe knowingly).
function Test-BaselineGuard14 {
    param([string]$BaseDir)
    $bl = Join-Path $BaseDir 'baseline.json'
    if (-not (Test-Path -LiteralPath $bl)) { Write-Host 'WARNING: baseline.json not found (B4 r14 guard skip).'; return $true }
    try {
        $it = Get-Item -LiteralPath $bl
        if (-not $it.IsReadOnly) { Write-Host 'WARNING: baseline.json not read-only (B4 r14 known limitation: read-only bypassable, self-signed sidecar).' }
    } catch { }
    try {
        $raw = [IO.File]::ReadAllText($bl, [Text.Encoding]::UTF8)
        $m = [regex]::Match($raw, '"signature"\s*:\s*"([^"]*)"')
        if (-not $m.Success) { Write-Host 'WARNING: baseline.json has no signature field (pre-r14, guard warn-only).'; return $true }
        $want = $m.Groups[1].Value.ToUpper()
        if ($want -eq 'PLACEHOLDER') { Write-Host 'WARNING: baseline signature PLACEHOLDER (update in progress, guard warn-only).'; return $true }
        $stripped = [regex]::Replace($raw, '(?m)^\s*"signature"\s*:\s*"[^"]*"\s*,?\s*\r?\n', '')
        $off = 0
        $bytes = [Text.Encoding]::UTF8.GetBytes($stripped)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $stripped = [Text.Encoding]::UTF8.GetString($bytes, 3, ($bytes.Length - 3)) }
        $stripped = $stripped -replace "`r`n", "`n"
        $stripped = $stripped -replace "`r", "`n"
        $norm = [Text.Encoding]::UTF8.GetBytes($stripped)
        $sha = New-Object System.Security.Cryptography.SHA256Managed
        $got = ([BitConverter]::ToString($sha.ComputeHash($norm)) -replace '-', '').ToUpper()
        $sha.Dispose()
        if ($got -ne $want) {
            Write-Host ("FAIL: baseline.json signature mismatch (got " + $got + " want " + $want + "). Re-verify after baseline update required. exit 1")
            exit 1
        }
        Write-Host 'Baseline guard r14 ok (signature match, LF-canonical SHA256).'
    } catch {
        if ($_.Exception.Message -like 'FAIL:*') { throw }
        Write-Host ("WARNING: baseline guard probe failed: " + $_.Exception.Message)
    }
    return $true
}
[void](Test-BaselineGuard14 -BaseDir $PSScriptRoot)

# : UNC-paths not supported (fail-fast, exit 2)
if ($PSScriptRoot -match '^\\\\') {
    Write-Host 'FAIL: UNC path not supported (script runs from a network share), copy release/ to a local disk and rerun. exit 2'
    exit 2
}

function Show-InstallHelp {
    Write-Host ''
    Write-Host 'install_proxy.ps1 v2 — install muse-spark-proxy (8 stages SPEC, codes 0-7).'
    Write-Host ''
    Write-Host 'MUSE_PROXY_* contract (units):'
    Write-Host ' MUSE_PROXY_HOST (string) default 127.0.0.1 — address listen'
    Write-Host ' MUSE_PROXY_PORT (int 1-65535) default 8787 (tests 18887; ban tests 8780-8790)'
    Write-Host ' MUSE_PROXY_UPSTREAM (URL http/https) default https://opencode.ai/zen — read-alias UPSTREAM'
    Write-Host ' MUSE_PROXY_LOGFILE (path) default (empty=stderr)'
    Write-Host ' MUSE_PROXY_DEBUG (bool 0/1) default 0'
    Write-Host ' MUSE_PROXY_SOCKS (host:port|direct) default direct (e.g.. 127.0.0.1:10808)'
    Write-Host ' MUSE_PROXY_CURL (path curl.exe) default C:\Windows\System32\curl.exe — fallback: MUSE_PROXY_CURL -> System32 -> where curl'
    Write-Host ' MUSE_PROXY_TASKNAME (string) default MuseSparkProxy (tests: release-*)'
    Write-Host ' MUSE_PROXY_MODE (startup|task) default startup (flag -UseScheduledTask takes precedence; task requires Admin)'
    Write-Host ' MUSE_PROXY_PROVIDERS (string) only Zen/Free via proxy; go/polza — directly (otherwise exit 2 without -Force)'
    Write-Host ' MUSE_PROXY_TIMEOUT_REQ_MS (ms) default 600000'
    Write-Host ' MUSE_PROXY_TIMEOUT_IDLE_MS (ms) default 60000'
    Write-Host ' MUSE_PROXY_TIMEOUT_SSE_MS (ms) default 130000'
    Write-Host ' MUSE_PROXY_TIMEOUT_CURL_S (s) default 600'
    Write-Host ' MUSE_PROXY_TIMEOUT_PROBE_S (s 1..60) default 5 — probe /v1/models and SOCKS TCP-probe single-shot'
    Write-Host ' MUSE_PROXY_TIMEOUT_POLL_MS (ms) default 200'
    Write-Host ' OPCODE_CONFIG_PATH (without prefix) PS1-contract — path opencode.jsonc'
    Write-Host ' Node-pin: v22.23.2 (https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip) — mismatch after resolution node = exit 1 with instructions manual install.'
    Write-Host ' Retry-policy: single-shot, no upstream retries (probe/SOCKS one attempt each).'
    Write-Host ''
    Write-Host 'Flags: -Port -Socks -Upstream -ConfigPath -StartupDir -SkipProbe -Force -UseScheduledTask -DryRun/-WhatIf -RestartOpenCode -TestMode -Help.'
}

if ($Help) {
    Show-InstallHelp
    exit 0
}

# ---------- constants ----------
$Script:ProdPortDefault = 8787
$Script:ProdPortMin = 8787
$Script:ProdPortMax = 8796
$Script:TestPortDefault = 18887
$Script:TestPortMin = 18887
$Script:TestPortMax = 18896
$Script:TestForbiddenMin = 8780
$Script:TestForbiddenMax = 8790
$Script:ProbeTimeoutS = 5
# : ProbeTimeoutS from env MUSE_PROXY_TIMEOUT_PROBE_S (seconds), validation 1..60
if ($env:MUSE_PROXY_TIMEOUT_PROBE_S -ne $null -and $env:MUSE_PROXY_TIMEOUT_PROBE_S -ne '') {
    try {
        $probeEnv = [int]$env:MUSE_PROXY_TIMEOUT_PROBE_S
        if ($probeEnv -ge 1 -and $probeEnv -le 60) {
            $Script:ProbeTimeoutS = $probeEnv
        } else {
            Write-Host ("WARNING: MUSE_PROXY_TIMEOUT_PROBE_S out of range 1..60 (got '" + $env:MUSE_PROXY_TIMEOUT_PROBE_S + "'), using default 5.")
        }
    } catch {
        Write-Host ("WARNING: bad MUSE_PROXY_TIMEOUT_PROBE_S ('" + $env:MUSE_PROXY_TIMEOUT_PROBE_S + "'), using default 5.")
    }
}
$Script:DefaultUpstream = 'https://opencode.ai/zen'
$Script:NodePinVersion = 'v22.23.2'
$Script:NodePinUrl = 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip'
$Script:NodePinSha = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
$Script:TaskNameProd = 'MuseSparkProxy'
$Script:MarkerTag = '@release-managed'

function Exit-With {
    param([int]$Code, [string]$Msg)
    if ($Msg -ne '' -and $Msg -ne $null) { Write-Host $Msg }
    exit $Code
}

function Mask-Secret {
    param([string]$Text)
    if ($Text -eq $null -or $Text -eq '') { return '' }
    $m = $Text
    # : masks level server.js sanitize (Bearer/sk-/x-api-key/Basic/password/query/CRLF/\uXXXX)
    try { $m = [regex]::Replace($m, '\\u([0-9a-fA-F]{4})', { param($mm) ([char]([Convert]::ToInt32($mm.Groups[1].Value, 16))).ToString() }) } catch { }
    $m = [regex]::Replace($m, '(?i)Bearer\s+[A-Za-z0-9\-._~+/=]+', 'Bearer ***REDACTED***')
    $m = [regex]::Replace($m, '(?i)sk-[A-Za-z0-9\-]+', 'sk-***REDACTED***')
    $m = [regex]::Replace($m, '(?i)["'']?(x-api-key|x-auth-token|x-access-token|proxy-authorization|api-key|apikey)["'']?\s*[=:]\s*["'']?[^"'',}\s]+', { param($mm) (($mm.Value -split '[=:]')[0] -replace '["'']', '') + '=***' })
    $m = [regex]::Replace($m, '(?i)Basic\s+[A-Za-z0-9+/=]+', 'Basic ***')
    $m = [regex]::Replace($m, '(?i)["'']?(password|passwd|client_secret|refresh_token)["'']?\s*[=:]\s*["'']?[^"'',}\s]+', { param($mm) (($mm.Value -split '[=:]')[0] -replace '["'']', '') + '=***' })
    $m = [regex]::Replace($m, '(?i)[?&](api_key|apikey|token|key|secret|access_token|auth|password|passwd|refresh_token|client_secret)=[^&\s]*', { param($mm) (($mm.Value -split '=')[0] + '=***') })
    # mask tokens/keys in query and base64-similar long secrets (for logs)
    $m = [regex]::Replace($m, '(?i)(token|key|secret|auth)(=|:)\s*[^\s&;"]+', '$1$2***')
    $m = [regex]::Replace($m, "`r`n|`r|`n", '\n')
    return $m
}

function Get-LiveConfigPath {
    # UNIFIED RESOLVER. Default USERPROFILE. Fallback APPDATA FORBIDDEN.
    $fromEnv = $env:OPCODE_CONFIG_PATH
    if ($fromEnv -ne $null -and $fromEnv -ne '') { return $fromEnv }
    return (Join-Path $env:USERPROFILE '.config\opencode\opencode.jsonc')
}

function Test-IsTempPath {
    param([string]$P)
    if ($P -eq $null -or $P -eq '') { return $false }
    $t = $env:TEMP
    if ($t -eq $null -or $t -eq '') { $t = $env:TMP }
    if ($t -eq $null -or $t -eq '') { return $false }
    return ($P.ToLower().StartsWith($t.ToLower()))
}

function Test-PortFree {
    param([int]$P)
    $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue
    if ($c -ne $null) { return $false }
    return $true
}

function Find-FreePort {
    param([int]$Start, [int]$Min, [int]$Max)
    $p = $Start
    if ($p -lt $Min -or $p -gt $Max) { $p = $Min }
    $tried = 0
    $range = $Max - $Min + 1
    while ($tried -lt $range) {
        if (Test-PortFree -P $p) { return $p }
        $p = $p + 1
        if ($p -gt $Max) { $p = $Min }
        $tried = $tried + 1
    }
    return 0
}

function Test-SocksProbe {
    param([string]$HostPort, [int]$TimeoutS)
    # single-shot TCP-probe 5s. Returns: 'ok' | 'fail' | 'slow'
    $parts = $HostPort.Split(':')
    if ($parts.Count -ne 2) { return 'fail' }
    $h = $parts[0]
    $po = 0
    if (-not [int]::TryParse($parts[1], [ref]$po)) { return 'fail' }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $cl = New-Object System.Net.Sockets.TcpClient
        $iar = $cl.BeginConnect($h, $po, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutS * 1000)
        $sw.Stop()
        $elapsed = $sw.Elapsed.TotalSeconds
        if (-not $ok) { $cl.Close(); return 'fail' }
        $cl.EndConnect($iar)
        $cl.Close()
        if ($elapsed -gt ($TimeoutS - 1)) { return 'slow' }
        return 'ok'
    } catch {
        $sw.Stop()
        return 'fail'
    }
}

# ---------- mode / flags normalization ----------
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $dir 'server.js'
$vendorDir = Join-Path $dir 'vendor'
$smokeScript = Join-Path $dir 'smoke-r3.js'
$isDry = ($DryRun -or $WhatIf)
$isTest = [bool]$TestMode

# Without -TestMode tests forbidden (fail-fast): temp ConfigPath / temp StartupDir / test port without flag = refusal
if (-not $isTest) {
    if ($ConfigPath -ne '' -and (Test-IsTempPath -P $ConfigPath)) {
        Write-Host "FAIL: temp -ConfigPath requires -TestMode (production config untouched). exit 6 jsonc fail: test config without TestMode"
        exit 6
    }
    if ($StartupDir -ne '' -and (Test-IsTempPath -P $StartupDir)) {
        Write-Host "FAIL: temp -StartupDir requires -TestMode. exit 5"
        exit 5
    }
    if ($Port -ge $Script:TestPortMin -and $Port -le $Script:TestPortMax) {
        Write-Host "FAIL: test port $Port requires -TestMode. exit 4 (canon SPEC: test-shift 18887-18896)"
        exit 4
    }
}

# Port: default depends on mode; explicit -Port in TestMode is validated against 8780-8790 -> exit 4
$portExplicit = ($Port -ne 0)
if ($isTest) {
    if (-not $portExplicit) { $Port = $Script:TestPortDefault }
    if ($Port -ge $Script:TestForbiddenMin -and $Port -le $Script:TestForbiddenMax) {
        Write-Host "FAIL: test mode forbids production range 8780-8790 (got $Port). exit 4"
        exit 4
    }
} else {
    if (-not $portExplicit) { $Port = $Script:ProdPortDefault }
    # prod: explicit port outside 1-65535 -> exit 4
    if ($Port -lt 1 -or $Port -gt 65535) {
        Write-Host "FAIL: bad port $Port. exit 4"
        exit 4
    }
}

# Upstream default + legacy alias UPSTREAM (canonical MUSE_PROXY_UPSTREAM takes precedence)
if ($Upstream -eq '' -or $Upstream -eq $null) {
    if ($env:MUSE_PROXY_UPSTREAM -ne $null -and $env:MUSE_PROXY_UPSTREAM -ne '') {
        $Upstream = $env:MUSE_PROXY_UPSTREAM
    } elseif ($env:UPSTREAM -ne $null -and $env:UPSTREAM -ne '') {
        $Upstream = $env:UPSTREAM
    } else {
        $Upstream = $Script:DefaultUpstream
    }
}

# TaskName: prod MuseSparkProxy; TestMode forces release- prefix
$taskName = $Script:TaskNameProd
if ($env:MUSE_PROXY_TASKNAME -ne $null -and $env:MUSE_PROXY_TASKNAME -ne '') { $taskName = $env:MUSE_PROXY_TASKNAME }
if ($isTest) {
    if (-not $taskName.StartsWith('release-')) { $taskName = 'release-' + $taskName + '-Test' }
}

# Mode: flag takes precedence over env MUSE_PROXY_MODE
$mode = 'startup'
if ($env:MUSE_PROXY_MODE -ne $null -and $env:MUSE_PROXY_MODE -ne '') { $mode = $env:MUSE_PROXY_MODE }
if ($UseScheduledTask) { $mode = 'task' }

# ConfigPath resolver + refusal on equality live paths in tests
$livePath = Get-LiveConfigPath
$configPathResolved = $ConfigPath
if ($configPathResolved -eq '' -or $configPathResolved -eq $null) {
    if ($isTest) {
        $tmpRoot = Join-Path $env:TEMP ('release-test-' + (Get-Date -Format 'yyyyMMddHHmmss'))
        $configPathResolved = Join-Path $tmpRoot 'opencode.jsonc'
    } else {
        $configPathResolved = $livePath
    }
}
if ($isTest) {
    # refusal on equality live paths (case-insensitive, normalization)
    try {
        $a = [IO.Path]::GetFullPath($configPathResolved).ToLower()
        $b = [IO.Path]::GetFullPath($livePath).ToLower()
        if ($a -eq $b) {
            Write-Host "FAIL: TestMode refuses live config path ($configPathResolved). exit 6 jsonc fail: live path in tests"
            exit 6
        }
    } catch {
        Write-Host "FAIL: bad -ConfigPath. exit 6 jsonc fail: $($_.Exception.Message)"
        exit 6
    }
}

# StartupDir / log: TestMode -> temp; prod -> real
$startupDirResolved = $StartupDir
$logFile = Join-Path $dir 'muse-proxy.log'
if ($isTest) {
    if ($startupDirResolved -eq '' -or $startupDirResolved -eq $null) {
        $tmpS = Join-Path $env:TEMP ('release-test-startup-' + (Get-Date -Format 'yyyyMMddHHmmss'))
        $startupDirResolved = $tmpS
    }
    $logFile = Join-Path $env:TEMP ('release-proxy-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.log')
} else {
    if ($startupDirResolved -eq '' -or $startupDirResolved -eq $null) {
        $startupDirResolved = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
    }
}
# Name bat/vbs: prod muse-spark-proxy.*, test release-*
$batName = 'muse-spark-proxy.bat'
$vbsName = 'muse-spark-proxy.vbs'
if ($isTest) { $batName = 'release-muse-spark-proxy.bat'; $vbsName = 'release-muse-spark-proxy.vbs' }

# : UNC-paths target directories/config not supported (fail-fast, exit 2)
foreach ($tp24 in @($startupDirResolved, $configPathResolved)) {
    if ($tp24 -ne $null -and $tp24 -ne '' -and ($tp24 -match '^\\\\')) {
        Exit-With -Code 2 -Msg ("FAIL: UNC path not supported (" + $tp24 + "), copy release/ to a local disk and rerun. exit 2")
    }
}

$isoDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

# ================= STAGE 1. Checks environment (exit 1) =================
try {
    $os = [Environment]::OSVersion.Version
    $build = 0
    try {
        $cv = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        $build = [int]$cv.CurrentBuildNumber
    } catch {
        $build = 0
    }
    if ($build -ne 0 -and $build -lt 17134) {
        Exit-With -Code 1 -Msg "FAIL: unsupported OS build $build (need Win10 1803+ build >=17134). exit 1"
    }
    # disk-space minimum (100 MB on disk script)
    $drive = (Get-Item -LiteralPath $dir).PSDrive.Name
    if ($drive -ne $null -and $drive -ne '') {
        $vol = Get-PSDrive -Name $drive -ErrorAction SilentlyContinue
        if ($vol -ne $null -and $vol.Free -ne $null -and $vol.Free -lt 104857600) {
            Exit-With -Code 1 -Msg "FAIL: low disk space on ${drive}:. exit 1"
        }
    }
    if (-not (Test-Path -LiteralPath $serverScript)) {
        Exit-With -Code 1 -Msg "FAIL: server.js not found: $serverScript. exit 1"
    }
    # PS-syntax self-check: Parse fallback (PSScriptAnalyzer where present — warning only)
    try {
        $psa = Get-Module -ListAvailable -Name PSScriptAnalyzer -ErrorAction SilentlyContinue
        if ($psa -ne $null) {
            $r = Invoke-ScriptAnalyzer -Path $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue
            if ($r -ne $null) {
                $errs = @($r | Where-Object { $_.Severity -eq 'Error' })
                if ($errs.Count -gt 0) {
                    Exit-With -Code 1 -Msg ("FAIL: PSScriptAnalyzer errors: " + $errs[0].Message + ". exit 1")
                }
            }
        } else {
            $tokens = $null; $errs = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($MyInvocation.MyCommand.Path, [ref]$tokens, [ref]$errs)
            if ($errs -ne $null -and $errs.Count -gt 0) {
                Exit-With -Code 1 -Msg ("FAIL: PS parse error: " + $errs[0].Message + ". exit 1")
            }
        }
    } catch {
        # parse check must not fail install if the checker itself is unavailable — proceed further
    }
} catch {
    if ($_.Exception.Message -like 'FAIL:*') { throw }
    Exit-With -Code 1 -Msg ("FAIL: environment check: " + $_.Exception.Message + ". exit 1")
}

# ================= STAGE 2. Node-bootstrap (exit 1; vendor-jsonc offline -> exit 6) =================
$node = $null
try {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -ne $null) { $node = $cmd.Source }
} catch { $node = $null }
if ($node -eq $null -or $node -eq '') {
    # try vendor node in release/
    $vendorNode = Join-Path $vendorDir 'node\node.exe'
    if (Test-Path -LiteralPath $vendorNode) { $node = $vendorNode }
}
if ($node -eq $null -or $node -eq '') {
    # download portable LTS with pin baseline + SHA256
    if ($isDry) {
        Write-Host ("DRYRUN node-bootstrap: would download " + $Script:NodePinUrl)
    } else {
        try {
            if ($isTest) {
                Exit-With -Code 1 -Msg "FAIL: no local node.exe in TestMode (offline bootstrap forbidden to touch prod paths). exit 1"
            }
            $nodeBase = Join-Path $env:LOCALAPPDATA 'MuseSparkProxy\node'
            $isAdminNow = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if ($isAdminNow) { $nodeBase = 'C:\ProgramData\MuseSparkProxy\node' }
            $zipPath = Join-Path $env:TEMP 'node-pin.zip'
            Write-Host ("Downloading Node " + $Script:NodePinVersion + " ...")
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $Script:NodePinUrl -OutFile $zipPath -UseBasicParsing
            $h = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
            if ($h -ne $Script:NodePinSha.ToLower()) {
                Exit-With -Code 1 -Msg "FAIL: node zip sha mismatch. exit 1"
            }
            if (-not (Test-Path -LiteralPath $nodeBase)) { New-Item -ItemType Directory -Path $nodeBase -Force | Out-Null }
            Expand-Archive -LiteralPath $zipPath -DestinationPath $nodeBase -Force
            $found = Get-ChildItem -LiteralPath $nodeBase -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found -eq $null) { Exit-With -Code 1 -Msg "FAIL: node.exe not found after unpack. exit 1" }
            $node = $found.FullName
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        } catch {
            if ($_.Exception.Message -like 'FAIL:*') { throw }
            Exit-With -Code 1 -Msg ("FAIL: node bootstrap offline/fail — install Node LTS " + $Script:NodePinVersion + " manually (" + $Script:NodePinUrl + "). " + $_.Exception.Message + ". exit 1")
        }
    }
}
# : enforce Node-pin after resolution (mismatch -> exit 1 with instructions; TestMode without node -> exit 1 above, saved)
if ($node -ne $null -and $node -ne '' -and (-not $isDry)) {
    try {
        $nodeVer = (& $node --version 2>$null | Out-String).Trim()
    } catch { $nodeVer = '' }
    if ($nodeVer -ne $Script:NodePinVersion) {
        Write-Host ("FAIL: Node version mismatch: got '" + $nodeVer + "', want '" + $Script:NodePinVersion + "'. Install manually: " + $Script:NodePinUrl + " (SHA256 " + $Script:NodePinSha + "). exit 1")
        exit 1
    }
}
if ($node -ne $null -and $node -ne '' -and (-not $isDry)) {
    try {
        & $node --version | Out-Null
        & $node --check $serverScript
        if ($LASTEXITCODE -ne 0) { Exit-With -Code 1 -Msg "FAIL: node --check server.js failed. exit 1" }
    } catch {
        Exit-With -Code 1 -Msg ("FAIL: node check: " + $_.Exception.Message + ". exit 1")
    }
}
# vendor jsonc-parser: strict gate/ — vendor must be; absence vendor = exit 6 (no write without round-trip via jsonc-parser)
$jsoncVendor = Join-Path $vendorDir 'jsonc-parser'
$jsoncVendorOk = Test-Path -LiteralPath $jsoncVendor
# vendor pin: verify vendor/jsonc-parser with baseline.json before jsonc-edit.
# Approach: SHA256 by CRLF-normalized content (CRLF/CR->LF, UTF8 without BOM) + normalized size.
# Reason: git-checkout on Windows gives CRLF, on Linux LF — byte-wise verify gave false mismatch;
# normalization removes false triggers, real tampering is still caught byte-wise.
# mismatch => fail-closed exit 6, file NOT written, backup intact. All files from baseline vendorPin.files are checked
# with override from revision sections' changedFiles (last-wins) — old sections not rewritten.
# pinning: verify ONLY norm (CRLF-normalized SHA256+size); raw is not gated (LICENSE raw vs norm hashes differ — norm is reference, raw would give false FAIL).
function Get-NormalizedBytes {
    param([string]$Path)
    $raw = [IO.File]::ReadAllBytes($Path)
    $off = 0
    if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) { $off = 3 }
    $txt = [Text.Encoding]::UTF8.GetString($raw, $off, ($raw.Length - $off))
    $txt = $txt -replace "`r`n", "`n"
    $txt = $txt -replace "`r", "`n"
    return [Text.Encoding]::UTF8.GetBytes($txt)
}
function Test-VendorPin {
    param([string]$BaseDir, [string]$VendorDir)
    $blPath = Join-Path $BaseDir 'baseline.json'
    if (-not (Test-Path -LiteralPath $blPath)) {
        Write-Host ("FAIL: jsonc fail: baseline.json not found (" + $blPath + "). File NOT written. exit 6 jsonc fail")
        exit 6
    }
    try {
        $bl = Get-Content -LiteralPath $blPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Host ("FAIL: jsonc fail: baseline.json unreadable. File NOT written. exit 6 jsonc fail")
        exit 6
    }
    $expected = @{}
    if ($bl.vendorPin -ne $null -and $bl.vendorPin.files -ne $null) {
        foreach ($f in $bl.vendorPin.files) { $expected[$f.name] = @{ sha256 = [string]$f.sha256; size = [long]$f.size } }
    }
    foreach ($rk in @('r6', 'r7', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19')) {
        $sec = $bl.$rk
        if ($sec -ne $null -and $sec.changedFiles -ne $null) {
            foreach ($f in $sec.changedFiles) {
                if ([string]$f.name -like 'vendor/*') { $expected[$f.name] = @{ sha256 = [string]$f.sha256; size = [long]$f.size } }
            }
        }
    }
    if ($expected.Count -eq 0) {
        Write-Host "FAIL: jsonc fail: no vendorPin in baseline.json. File NOT written. exit 6 jsonc fail"
        exit 6
    }
    foreach ($rel in $expected.Keys) {
        $full = Join-Path $BaseDir ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full)) {
            Write-Host ("FAIL: jsonc fail: vendor file missing (" + $rel + "). File NOT written, backup intact. exit 6 jsonc fail")
            exit 6
        }
        $exp = $expected[$rel]
        $norm = Get-NormalizedBytes -Path $full
        if ($norm.Length -ne $exp.size) {
            Write-Host ("FAIL: vendor size mismatch (" + $rel + " got " + $norm.Length + " want " + $exp.size + ", CRLF-normalized). File NOT written, backup intact. exit 6")
            exit 6
        }
        $sha = New-Object System.Security.Cryptography.SHA256Managed
        $got = ([BitConverter]::ToString($sha.ComputeHash($norm)) -replace '-', '').ToUpper()
        $sha.Dispose()
        if ($got -ne ([string]$exp.sha256).ToUpper()) {
            Write-Host ("FAIL: vendor sha mismatch (" + $rel + ", CRLF-normalized). File NOT written, backup intact. exit 6")
            exit 6
        }
    }
    Write-Host ("Vendor pin ok (" + $expected.Count + " files, CRLF-normalized SHA256+size).")
    return $true
}
# files-pin: enforce declarative files[] from baseline.json + override sections' changedFiles (last-wins, filter NOT vendor/*).
# Reuses Get-NormalizedBytes (CRLF/CR->LF, UTF8 without BOM, SHA256 HEX UPPER + norm size).
# Check each expected file present on disk; missing baseline.json -> fail-closed exit 1.
# Mismatch -> exit 1 (distinct from exit 6 JSONC/vendor, pinned in help-comment header). File NOT write, backup intact.
function Test-FilesPin {
    param([string]$BaseDir)
    $blPath = Join-Path $BaseDir 'baseline.json'
    if (-not (Test-Path -LiteralPath $blPath)) {
        Write-Host ("FAIL: files-pin: baseline.json not found (" + $blPath + "). File NOT written. exit 1")
        exit 1
    }
    try {
        $bl = Get-Content -LiteralPath $blPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Host ("FAIL: files-pin: baseline.json unreadable. File NOT written. exit 1")
        exit 1
    }
    $expected = @{}
    if ($bl.files -ne $null) {
        foreach ($f in $bl.files) { $expected[[string]$f.name] = @{ sha256 = [string]$f.sha256; size = [long]$f.size } }
    }
    foreach ($rk in @('r6', 'r7', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r21', 'r22', 'r23', 'r26', 'r27', 'r28', 'r29', 'r30', 'r31')) {
        $sec = $bl.$rk
        if ($sec -ne $null -and $sec.changedFiles -ne $null) {
            foreach ($f in $sec.changedFiles) {
                if (-not ([string]$f.name -like 'vendor/*')) { $expected[[string]$f.name] = @{ sha256 = [string]$f.sha256; size = [long]$f.size } }
            }
        }
    }
    if ($expected.Count -eq 0) {
        Write-Host "FAIL: files-pin: no files[] in baseline.json. File NOT written. exit 1"
        exit 1
    }
    foreach ($rel in $expected.Keys) {
        $full = Join-Path $BaseDir ($rel -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full)) {
            Write-Host ("FAIL: files-pin: file missing (" + $rel + "). File NOT written, backup intact. exit 1")
            exit 1
        }
        $exp = $expected[$rel]
        $norm = Get-NormalizedBytes -Path $full
        if ($norm.Length -ne $exp.size) {
            Write-Host ("FAIL: files-pin: size mismatch (" + $rel + " got " + $norm.Length + " want " + $exp.size + ", CRLF-normalized). File NOT written, backup intact. exit 1")
            exit 1
        }
        $sha = New-Object System.Security.Cryptography.SHA256Managed
        $got = ([BitConverter]::ToString($sha.ComputeHash($norm)) -replace '-', '').ToUpper()
        $sha.Dispose()
        if ($got -ne ([string]$exp.sha256).ToUpper()) {
            Write-Host ("FAIL: files-pin: sha mismatch (" + $rel + ", CRLF-normalized). File NOT written, backup intact. exit 1")
            exit 1
        }
    }
    Write-Host ("Files pin ok (" + $expected.Count + " files, CRLF-normalized SHA256+size).")
    return $true
}
# P0 post-copy/symlink verify: after KAZhDOGO Copy-Item and WriteAllText recalc SHA256+size src vs dst.
# Pre-copy pins (Test-VendorPin exit 6 / Test-FilesPin exit 1) not touch; post-verify always files-domen -> mismatch gives exit 1.
# Symlink/junction: resolve Target and compare content target (generic; hits symlink in release so far 0, but SPEC requires cover).
function Get-PostCopyHashInfo {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $it = Get-Item -LiteralPath $Path -ErrorAction Stop
        $real = $Path
        try {
            $lt = $null
            $tg = $null
            if ($it.PSObject.Properties['LinkType'] -ne $null) { $lt = $it.LinkType }
            if ($it.PSObject.Properties['Target'] -ne $null) { $tg = $it.Target }
            if ($lt -ne $null -and $lt -ne '' -and $tg -ne $null) {
                $t0 = $tg
                if ($t0 -is [array]) { $t0 = $t0[0] }
                $t0 = [string]$t0
                if ($t0 -ne '' -and $t0 -ne $null) {
                    if (-not [IO.Path]::IsPathRooted($t0)) { $t0 = Join-Path (Split-Path -Parent $Path) $t0 }
                    if (Test-Path -LiteralPath $t0) { $real = $t0 }
                }
            }
        } catch { }
        $h = (Get-FileHash -LiteralPath $real -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpper()
        $s = (Get-Item -LiteralPath $real -ErrorAction Stop).Length
        return @{ hash = $h; size = [long]$s; real = $real }
    } catch { return $null }
}
function Assert-PostCopyPin {
    param([string]$Src, [string]$Dst, [string]$Bak)
    # Post-verify file->file after Copy-Item. On mismatch: rollback from .bak (Copy-Item back) or Remove-Item incomplete copy + exit 1.
    $si = Get-PostCopyHashInfo -Path $Src
    $di = Get-PostCopyHashInfo -Path $Dst
    if ($si -eq $null -or $di -eq $null) {
        Write-Host ("FAIL: post-copy pin: no src/dst (" + $Src + " -> " + $Dst + "). Rollback, exit 1")
        try {
            if ($Bak -ne $null -and $Bak -ne '' -and (Test-Path -LiteralPath $Bak)) { Copy-Item -LiteralPath $Bak -Destination $Src -Force -ErrorAction SilentlyContinue }
            else { Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue }
        } catch { }
        Write-Error ("post-copy pin FAIL (missing side): " + $Src + " -> " + $Dst + ". exit 1") -ErrorAction Continue
        exit 1
    }
    if ($si.hash -ne $di.hash -or $si.size -ne $di.size) {
        Write-Host ("FAIL: post-copy pin mismatch (" + $Src + " -> " + $Dst + " src " + $si.hash + "/" + $si.size + " dst " + $di.hash + "/" + $di.size + "). Rollback, exit 1")
        try {
            if ($Bak -ne $null -and $Bak -ne '' -and (Test-Path -LiteralPath $Bak)) { Copy-Item -LiteralPath $Bak -Destination $Src -Force -ErrorAction SilentlyContinue }
            else { Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue }
        } catch { }
        Write-Error ("post-copy pin mismatch: " + $Src + " -> " + $Dst + ". exit 1") -ErrorAction Continue
        exit 1
    }
    Write-Host ("Post-copy pin ok (" + $Src + " -> " + $Dst + " SHA256+size).")
    return $true
}
function Assert-PostWritePin {
    param([string]$Dst, [string]$ExpectedText, [string]$Bak)
    # Post-verify after WriteAllText (UTF8 without BOM, as writes installer): expected text vs file. Mismatch -> rollback + exit 1.
    try {
        $enc = New-Object System.Text.UTF8Encoding $false
        $expBytes = $enc.GetBytes($ExpectedText)
        $sha = New-Object System.Security.Cryptography.SHA256Managed
        $expHash = ([BitConverter]::ToString($sha.ComputeHash($expBytes)) -replace '-', '').ToUpper()
        $sha.Dispose()
        $expSize = [long]$expBytes.Length
        $di = Get-PostCopyHashInfo -Path $Dst
        if ($di -eq $null -or $di.hash -ne $expHash -or $di.size -ne $expSize) {
            Write-Host ("FAIL: post-write pin mismatch (" + $Dst + " want " + $expHash + "/" + $expSize + "). Rollback, exit 1")
            try {
                if ($Bak -ne $null -and $Bak -ne '' -and (Test-Path -LiteralPath $Bak)) { Copy-Item -LiteralPath $Bak -Destination $Dst -Force -ErrorAction SilentlyContinue }
                else { Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue }
            } catch { }
            Write-Error ("post-write pin mismatch: " + $Dst + ". exit 1") -ErrorAction Continue
            exit 1
        }
        Write-Host ("Post-write pin ok (" + $Dst + " SHA256+size).")
        return $true
    } catch {
        if ($_.Exception.Message -like '*exit 1*') { throw }
        Write-Host ("FAIL: post-write pin exception (" + $Dst + "): " + $_.Exception.Message + ". Rollback, exit 1")
        try {
            if ($Bak -ne $null -and $Bak -ne '' -and (Test-Path -LiteralPath $Bak)) { Copy-Item -LiteralPath $Bak -Destination $Dst -Force -ErrorAction SilentlyContinue }
            else { Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue }
        } catch { }
        Write-Error ("post-write pin exception: " + $Dst + ". exit 1") -ErrorAction Continue
        exit 1
    }
}

# ================= STAGE 3. Detect network / SOCKS (exit 3) =================
$socksVal = $Socks
if ($socksVal -eq $null) { $socksVal = '' }
$socksVal = $socksVal.Trim()
if ($socksVal -eq '' -or $socksVal -eq $null) {
    if ($env:MUSE_PROXY_SOCKS -ne $null -and $env:MUSE_PROXY_SOCKS -ne '') {
        $socksVal = $env:MUSE_PROXY_SOCKS
    }
}
$socksMode = 'direct'
if ($socksVal -ne '' -and $socksVal.ToLower() -ne 'direct') {
    # manual override set
    $probe = Test-SocksProbe -HostPort $socksVal -TimeoutS $Script:ProbeTimeoutS
    if ($probe -eq 'fail') {
        Exit-With -Code 3 -Msg "FAIL: SOCKS unreachable $socksVal — check SOCKS or set MUSE_PROXY_SOCKS=direct. exit 3"
    } elseif ($probe -eq 'slow') {
        # canon 4s, sync with server.js:162 (PS-comment # instead //: // invalid in PS5.1)
        Write-Host ("WARNING: slow SOCKS " + (Mask-Secret $socksVal) + " (>4s probe) — using with warning.")
        $socksMode = $socksVal
    } else {
        $socksMode = $socksVal
    }
} elseif ($socksVal.ToLower() -eq 'direct') {
    $socksMode = 'direct'
} else {
    # auto-detect 127.0.0.1:10808 single-shot
    $probe = Test-SocksProbe -HostPort '127.0.0.1:10808' -TimeoutS $Script:ProbeTimeoutS
    if ($probe -eq 'ok') {
        $socksMode = '127.0.0.1:10808'
        Write-Host "SOCKS auto-detect: 127.0.0.1:10808 reachable -> MUSE_PROXY_SOCKS=127.0.0.1:10808"
    } elseif ($probe -eq 'slow') {
        $socksMode = '127.0.0.1:10808'
        # canon 4s, sync with server.js:162 (text warning edin with manual override above)
        Write-Host "WARNING: slow SOCKS 127.0.0.1:10808 (>4s probe) — using with warning."
    } else {
        $socksMode = 'direct'
        Write-Host "WARNING: SOCKS 127.0.0.1:10808 not detected -> direct (production Zen path may require SOCKS)."
    }
}
# loopback-exception always: 127.0.0.1,localhost in --noproxy (order SOCKS -> proxy pins server.js)

# ================= STAGE 4. Choice providers (exit 2 without -Force) =================
# Scope: only Zen/Free via proxy. opencode-go/polza — directly.
if ($env:MUSE_PROXY_PROVIDERS -ne $null -and $env:MUSE_PROXY_PROVIDERS -ne '') {
    $pv = $env:MUSE_PROXY_PROVIDERS.ToLower()
    if (($pv -like '*go*' -or $pv -like '*polza*') -and (-not $Force)) {
        Exit-With -Code 2 -Msg "FAIL: provider '$pv' must go direct (not via proxy). Use -Force to override at your risk. exit 2"
    }
}

# ================= STAGE 5. Choice upstream (exit 2; -SkipProbe under responsibility) =================
try {
    $u = $null
    if (-not [System.Uri]::TryCreate($Upstream, [System.UriKind]::Absolute, [ref]$u)) {
        Exit-With -Code 2 -Msg "FAIL: bad upstream URL $Upstream. exit 2"
    }
    if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') {
        Exit-With -Code 2 -Msg "FAIL: upstream scheme must be http/https. exit 2"
    }
} catch {
    if ($_.Exception.Message -like 'FAIL:*') { throw }
    Exit-With -Code 2 -Msg ("FAIL: bad upstream URL. exit 2")
}
if (-not $SkipProbe -and (-not $isDry)) {
    # probe GET <upstream>/v1/models via resolved MUSE_PROXY_CURL + SOCKS-chain, single-shot, secrets masked ()
    try {
        $curlBin = 'curl.exe'
        if ($env:MUSE_PROXY_CURL -ne $null -and $env:MUSE_PROXY_CURL -ne '') { $curlBin = $env:MUSE_PROXY_CURL }
        $probeUrl = $Upstream.TrimEnd('/') + '/v1/models'
        $args = @('-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', "$Script:ProbeTimeoutS", $probeUrl)
        if ($socksMode -ne 'direct') {
            $args = @('--socks5-hostname', $socksMode, '--noproxy', '127.0.0.1,localhost') + $args
        }
        $code = & $curlBin @args 2>$null
        $code = ($code | Out-String).Trim()
        Write-Host ("Upstream probe " + (Mask-Secret $probeUrl) + " -> " + (Mask-Secret $code))
        if ($code -ne '200') {
            Exit-With -Code 2 -Msg ("FAIL: upstream probe non-200 (" + $code + ") for " + (Mask-Secret $Upstream) + ". Retry / change URL / use -SkipProbe at your risk. exit 2")
        }
    } catch {
        if ($_.Exception.Message -like 'FAIL:*') { throw }
        Exit-With -Code 2 -Msg ("FAIL: upstream probe error for " + (Mask-Secret $Upstream) + ": " + $_.Exception.Message + ". Use -SkipProbe at your risk. exit 2")
    }
} elseif ($SkipProbe) {
    Write-Host "Upstream probe skipped (-SkipProbe) at user risk."
}

# ================= STAGE 6. Avtosdvig port (exit 4) =================
# server exit(2) EADDRINUSE -> installer 4 (mapping pinned here itself).
$rangeMin = $Script:ProdPortMin
$rangeMax = $Script:ProdPortMax
if ($isTest) { $rangeMin = $Script:TestPortMin; $rangeMax = $Script:TestPortMax }
$finalPort = 0
if (Test-PortFree -P $Port) {
    $finalPort = $Port
} else {
    if ($portExplicit) {
        Write-Host ("Port $Port busy -> autoshift in " + $rangeMin + "-" + $rangeMax + " ...")
    }
    $p = $Port + 1
    if ($p -lt $rangeMin -or $p -gt $rangeMax) { $p = $rangeMin }
    $finalPort = Find-FreePort -Start $p -Min $rangeMin -Max $rangeMax
    if ($finalPort -eq 0) {
        Exit-With -Code 4 -Msg "FAIL: no free port in $rangeMin-$rangeMax (10 attempts). exit 4"
    }
    Write-Host ("Port autoshift: $Port -> $finalPort")
}
# bind-probe on top netstat (catch server EADDRINUSE zaranee): fast TcpListener test
try {
    $lst = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $finalPort)
    $lst.Start()
    $lst.Stop()
} catch {
    # mapping server EADDRINUSE -> installer 4
    $nxt = Find-FreePort -Start ($finalPort + 1) -Min $rangeMin -Max $rangeMax
    if ($nxt -eq 0) { Exit-With -Code 4 -Msg "FAIL: port $finalPort EADDRINUSE (server exit 2 mapped to installer 4). No free port. exit 4" }
    Write-Host ("Port bind-probe EADDRINUSE on $finalPort (server exit 2 -> installer 4), shifted -> $nxt")
    $finalPort = $nxt
}
$baseUrl = 'http://127.0.0.1:' + $finalPort + '/v1'

# ================= marker =================
$markerLine = '// ' + $Script:MarkerTag + ' MuseSparkProxy port=' + $finalPort + ' upstream=' + $Upstream + ' socks=' + $socksMode + ' task=' + $taskName + ' date=' + $isoDate + ' script=' + $serverScript
$batMarker = 'REM ' + $Script:MarkerTag + ' MuseSparkProxy port=' + $finalPort + ' upstream=' + $Upstream + ' socks=' + $socksMode + ' task=' + $taskName + ' date=' + $isoDate + ' script=' + $serverScript

# JSONC-edit baseURL via node + vendor jsonc-parser 3.3.1 (exit 6): preservation required.
# Vendor: $PSScriptRoot\vendor\jsonc-parser (path relative from script, see. $vendorDir/$jsoncVendor below).
# API 3.3.1: parse + modify + applyEdits (print MISSING in this versii; exit modify/applyEdits + repeat parse = round-trip).
# Ban serialization for jsonc-paths (geyt: search banned-serializer empty); regex only fallback with marker; round-trip required.
function Invoke-JsoncSetBaseUrl {
    param([string]$NodeExe, [string]$Cfg, [string]$BaseUrl, [string]$Marker, [bool]$Dry)
    $cfgDir = Split-Path -Parent $Cfg
    if ($cfgDir -ne '' -and (-not (Test-Path -LiteralPath $cfgDir))) {
        if ($Dry) { Write-Host ("DRYRUN mkdir " + $cfgDir); return $true }
        New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $Cfg)) {
        if ($Dry) { Write-Host ("DRYRUN create " + $Cfg + " baseURL=" + $BaseUrl); return $true }
        $init = "{`r`n  `"provider`": {`r`n    `"opencode`": {`r`n      " + $Marker + "`r`n      `"options`": { `"baseURL`": `"" + $BaseUrl + "`" }`r`n    }`r`n  }`r`n}`r`n"
        $utf8 = New-Object System.Text.UTF8Encoding $false
        [IO.File]::WriteAllText($Cfg, $init, $utf8)
        [void](Assert-PostWritePin -Dst $Cfg -ExpectedText $init -Bak '')
        return $true
    }
    $nodeScript = @'
const fs=require('fs');
const cfg=process.env.R_CFG, base=process.env.R_BASE, marker=process.env.R_MARKER;
let text=fs.readFileSync(cfg,'utf8');
let used='regex-fallback';
try {
  const jp=require(process.env.R_VENDOR);
  if (jp && typeof jp.parse==='function' && typeof jp.modify==='function' && typeof jp.applyEdits==='function') {
    let errs=[]; const root=jp.parse(text,errs,{allowTrailingComma:true,disallowComments:false});
    if (errs&&errs.length) throw new Error('jsonc parse errs');
    if (text.replace(/\/\*[\s\S]*?\*\//g,'').split('\n').filter(l=>l.trim().indexOf('//')!==0).join('\n').indexOf('"opencode"')<0) throw new Error('OPENCODE_BLOCK_MISSING: provider opencode not found, polza/GO untouched');
    // set provider.opencode.options.baseURL preservation-path (vendor primary; regex only fallback below; top-level baseURL off-limits)
    const edits=jp.modify(text,['provider','opencode','options','baseURL'],base,{});
    let out=jp.applyEdits(text,edits);
    // SCOPE-opencode: marker/search only inside block "opencode" (balans brackets from name provider); polza/GO/other off-limits; comments ignore (// + /* */ single+multiline, lines with //,/* not comment); dubli FAIL
    const opKey='"opencode"';
    const stripC=(l,st)=>{ let s=l; if(st.inBlk){ const e=s.indexOf('*/'); if(e<0) return ''; s=s.slice(e+2); st.inBlk=false; l=s; } let out='',i=0; const n=l.length; let inS=false,esc=false; while(i<n){ const c=l[i],nx=(i+1<n)?l[i+1]:''; if(inS){ out+=c; if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inS=false; i++; continue; } if(c==='"'){ inS=true; out+=c; i++; continue; } if(c==='/'&&nx==='/') break; if(c==='/'&&nx==='*'){ const b=l.indexOf('*/',i+2); if(b>=0){ i=b+2; continue; } else { st.inBlk=true; break; } } out+=c; i++; } return out; };
    const dupOpencode=(ls)=>{ const st={inBlk:false}; let c=0; for(const l of ls){ if(/\"opencode\"\s*:/.test(stripC(l,st))) c++; } return c; };
    const opRange=(ls)=>{ if(dupOpencode(ls)>1) throw new Error('DUP_OPENCODE_BLOCK: multiple provider.opencode blocks, manual review, polza/GO untouched'); const st={inBlk:false}; const det=[],br=[]; for(const l of ls){ const t=stripC(l,st); det.push(t); br.push(t.replace(/"([^"\\]|\\.)*"/g,'""')); } let si=-1; for(let i=0;i<ls.length;i++){ if(det[i].indexOf(opKey)>=0){ si=i; break; } } if(si<0) throw new Error('OPENCODE_BLOCK_MISSING'); let d=0,stt=false,ei=ls.length-1; for(let i=si;i<ls.length;i++){ for(const ch of br[i]){ if(ch==='{'){d++;stt=true;} else if(ch==='}'){d--;} } if(stt&&d<=0){ei=i;break;} } return [si,ei]; };
    const baseIn=(ls,a,b)=>{ const st={inBlk:false}; const det=[]; for(let i=0;i<ls.length;i++) det.push(stripC(ls[i],st)); for(let i=a;i<=b;i++){ if(det[i].indexOf('"baseURL"')>=0) return i; } return -1; };
    if (out.indexOf('@release-managed')<0) {
      const lines=out.split('\n'); const rg=opRange(lines); const bi=baseIn(lines,rg[0],rg[1]);
      if (bi<0) throw new Error('OPENCODE_BLOCK_MISSING: baseURL not in opencode block');
      lines.splice(bi,0,'  '+marker+',');
      out=lines.join('\n');
    }
    // round-trip: repeat parse must be without errors (serializer forbidden in jsonc-paths)
    let e2=[]; jp.parse(out,e2,{allowTrailingComma:true,disallowComments:false});
    if (e2&&e2.length) throw new Error('roundtrip errs');
    fs.writeFileSync(cfg,out); console.log('jsonc-parser preservation ok');
  } else { throw new Error('no vendor'); }
} catch(e) {
  // fallback regex ONLY with marker AND ONLY inside block "opencode" (polza/GO/other off-limits; assert below; comments // + /* */ single+multiline ignore, lines with //,/* not comment)
  const opKey2='"opencode"';
  const stripC2=(l,st)=>{ let s=l; if(st.inBlk){ const e=s.indexOf('*/'); if(e<0) return ''; s=s.slice(e+2); st.inBlk=false; l=s; } let out='',i=0; const n=l.length; let inS=false,esc=false; while(i<n){ const c=l[i],nx=(i+1<n)?l[i+1]:''; if(inS){ out+=c; if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inS=false; i++; continue; } if(c==='"'){ inS=true; out+=c; i++; continue; } if(c==='/'&&nx==='/') break; if(c==='/'&&nx==='*'){ const b=l.indexOf('*/',i+2); if(b>=0){ i=b+2; continue; } else { st.inBlk=true; break; } } out+=c; i++; } return out; };
  const dupOpencode2=(ls)=>{ const st={inBlk:false}; let c=0; for(const l of ls){ if(/\"opencode\"\s*:/.test(stripC2(l,st))) c++; } return c; };
  const opRange2=(ls)=>{ if(dupOpencode2(ls)>1) { console.error('DUP_OPENCODE_BLOCK: multiple provider.opencode blocks, manual review, polza/GO untouched'); process.exit(6); } const st={inBlk:false}; const det=[],br=[]; for(const l of ls){ const t=stripC2(l,st); det.push(t); br.push(t.replace(/"([^"\\]|\\.)*"/g,'""')); } let si=-1; for(let i=0;i<ls.length;i++){ if(det[i].indexOf(opKey2)>=0){ si=i; break; } } if(si<0) return null; let d=0,stt=false,ei=ls.length-1; for(let i=si;i<ls.length;i++){ for(const ch of br[i]){ if(ch==='{'){d++;stt=true;} else if(ch==='}'){d--;} } if(stt&&d<=0){ei=i;break;} } return [si,ei]; };
  const baseIn2=(ls,a,b)=>{ const st={inBlk:false}; const det=[]; for(let i=0;i<ls.length;i++) det.push(stripC2(ls[i],st)); for(let i=a;i<=b;i++){ if(det[i].indexOf('"baseURL"')>=0) return i; } return -1; };
  const repBaseInCode=(line,base)=>{ let inS=false,esc=false; for(let i=0;i<line.length-1;i++){ const c=line[i],nx=line[i+1]; if(inS){ if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inS=false; continue; } if(c==='"'){ inS=true; continue; } if(c==='/'&&(nx==='/'||nx==='*')){ return line.slice(0,i).replace(/"baseURL"\s*:\s*"[^"]*"/, '"baseURL": "'+base+'"')+line.slice(i); } } return line.replace(/"baseURL"\s*:\s*"[^"]*"/, '"baseURL": "'+base+'"'); };
  const stripAll2=(s)=>{ let t=s.replace(/"([^"\\]|\\.)*"/g,'""'); t=t.replace(/\/\*[\s\S]*?\*\//g,''); const ls=t.split('\n'); const out=[]; for(const l of ls){ const ci=l.indexOf('//'); out.push(ci>=0?l.slice(0,ci):l); } return out.join('\n'); };
  const polzaN=(s)=>{ const t=stripAll2(s); return (t.match(/"polza"\s*:/g)||[]).length; };
  const goN=(s)=>{ const t=stripAll2(s); return (t.match(/"opencode-go"\s*:/g)||[]).length; };
  const stripForParse=(s)=>{ let out='',i=0; const n=s.length; let inS=false,esc=false,inL=false,inB=false; while(i<n){ const c=s[i],nx=(i+1<n)?s[i+1]:''; if(inL){ if(c==='\n'){ inL=false; out+=c; } i++; continue; } if(inB){ if(c==='*'&&nx==='/'){ inB=false; i+=2; continue; } if(c==='\n') out+=c; i++; continue; } if(inS){ out+=c; if(esc) esc=false; else if(c==='\\') esc=true; else if(c==='"') inS=false; i++; continue; } if(c==='"'){ inS=true; out+=c; i++; continue; } if(c==='/'&&nx==='/'){ inL=true; i+=2; continue; } if(c==='/'&&nx==='*'){ inB=true; i+=2; continue; } out+=c; i++; } return out.replace(/,(\s*[}\]])/g,'$1'); };
  const polzaBefore=polzaN(text);
  const goBefore=goN(text);
  const l0=text.split('\n'); const r0=opRange2(l0);
  if (!r0) { console.error('OPENCODE_BLOCK_MISSING: provider opencode not found, polza/GO untouched'); process.exit(6); }
  const b0=baseIn2(l0,r0[0],r0[1]);
  const assertPolza=(s)=>{ if(polzaN(s)!==polzaBefore) throw new Error('POLZA_TOUCHED'); if(goN(s)!==goBefore) throw new Error('GO_TOUCHED'); };
  if (text.indexOf('@release-managed')>=0 && b0>=0) {
    const lines=text.split('\n'); const rg=opRange2(lines); const bi=baseIn2(lines,rg[0],rg[1]);
    lines[bi]=repBaseInCode(lines[bi],base);
    let out=lines.join('\n');
    if (out.indexOf('@release-managed')>=0 || text.indexOf('@release-managed')>=0) { used='regex-fallback+marker-ok'; }
    else {
      const ls2=out.split('\n'); const rg2=opRange2(ls2); const bi2=baseIn2(ls2,rg2[0],rg2[1]);
      ls2.splice(bi2,0,'  '+marker+','); out=ls2.join('\n'); used='regex-fallback+marker-added';
    }
    assertPolza(out);
    // round-trip: strip // + trailing comma and JSON.parse
    const stripped=stripForParse(out);
    JSON.parse(stripped);
    fs.writeFileSync(cfg,out); console.log(used);
  } else if (text.indexOf('@release-managed')<0) {
    const lines=text.split('\n'); const rg=opRange2(lines);
    if (!rg) { console.error('OPENCODE_BLOCK_MISSING: provider opencode not found, polza/GO untouched'); process.exit(6); }
    let bi=baseIn2(lines,rg[0],rg[1]);
    let out='';
    if (bi>=0) { lines.splice(bi,0,'  '+marker+','); lines[bi+1]=repBaseInCode(lines[bi+1],base); out=lines.join('\n'); }
    else {
      const optIdx=(()=>{ const st={inBlk:false}; const det=[]; for(let i=0;i<lines.length;i++) det.push(stripC2(lines[i],st)); for(let i=rg[0];i<=rg[1];i++) if(det[i].indexOf('"options"')>=0) return i; return -1; })();
      if (optIdx>=0 && lines[optIdx].indexOf('{')>=0 && lines[optIdx].indexOf('}')>=0) { lines[optIdx]=lines[optIdx].replace('{', '{ "baseURL": "'+base+'", '); lines.splice(optIdx,0,'  '+marker+','); }
      else if (optIdx>=0 && lines[optIdx].indexOf('{')>=0) { lines.splice(optIdx+1,0,'    "baseURL": "'+base+'",'); lines.splice(optIdx+1,0,'  '+marker+','); }
      else { lines.splice(rg[0]+1,0,'  '+marker+',','  "options": { "baseURL": "'+base+'" },'); }
      out=lines.join('\n');
    }
    assertPolza(out);
    const stripped=stripForParse(out);
    JSON.parse(stripped);
    fs.writeFileSync(cfg,out); console.log('regex-fallback+marker-added');
  } else { console.error('MARKER_CORRUPT'); process.exit(6); }
}
'@
    if ($Dry) {
        Write-Host ("DRYRUN jsonc: set baseURL=" + $BaseUrl + " marker in " + $Cfg)
        Write-Host ("DRYRUN diff: + " + $Marker)
        Write-Host ("DRYRUN diff: + `"baseURL`": `"" + $BaseUrl + "`"")
        return $true
    }
    # backup .bak-date
    $bak = $Cfg + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $Cfg -Destination $bak -Force -ErrorAction Stop # NB-02: explicit Stop for symmetry with rollback_proxy.ps1:337 (on top Preference :26).
    # P0: post-verify backup (SHA256+size, symlink-resolve); mismatch -> remove incomplete copy + exit 1
    [void](Assert-PostCopyPin -Src $Cfg -Dst $bak -Bak '')
    Write-Host ("Config backup: " + $bak)
    $env:R_CFG = $Cfg
    $env:R_BASE = $BaseUrl
    $env:R_MARKER = $Marker
    if ($jsoncVendorOk) { $env:R_VENDOR = $jsoncVendor } else { $env:R_VENDOR = (Join-Path $vendorDir 'jsonc-parser-missing') }
    # strict fail-closed exit 6: vendor missing OR node unavailable — file NOT write, backup intact (canon gate/)
    if (-not $jsoncVendorOk) {
        Write-Host ("FAIL: jsonc fail: jsonc-parser vendor missing in release/vendor (no round-trip possible). File NOT written, backup intact: " + $bak + ". exit 6 jsonc fail")
        exit 6
    }
    if ($NodeExe -eq $null -or $NodeExe -eq '') {
        Write-Host ("FAIL: jsonc fail: no node for jsonc-parser round-trip. File NOT written, backup intact: " + $bak + ". exit 6 jsonc fail")
        exit 6
    }
    $tmpJs = Join-Path $env:TEMP ('release-jsonc-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.js')
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($tmpJs, $nodeScript, $utf8)
    [void](Assert-PostWritePin -Dst $tmpJs -ExpectedText $nodeScript -Bak '')
    try {
        $out = & $NodeExe $tmpJs 2>&1 | Out-String
        $ec = $LASTEXITCODE
        Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
        $env:R_CFG = $null; $env:R_BASE = $null; $env:R_MARKER = $null; $env:R_VENDOR = $null
        if ($ec -ne 0 -or ($out -like '*MARKER_CORRUPT*')) {
            if ($out -like '*MARKER_CORRUPT*') {
                Write-Host ("FAIL: marker corrupt in " + $Cfg + " (no port/script fields). manual review required, nothing removed. exit 6 marker corrupt")
            } else {
                Write-Host ("FAIL: jsonc fail for " + $Cfg + ": " + (Mask-Secret $out) + ". exit 6 jsonc fail")
            }
            exit 6
        }
        Write-Host ("JSONC updated (" + $out.Trim() + "): " + $Cfg)
        # node-write -> PS-verify, mismatch exit 6 (exact hash impossible — generit node; verify marker+baseURL in file)
        $__cfgText = $null
        try { $__cfgText = Get-Content -LiteralPath $Cfg -Raw -Encoding UTF8 } catch { $__cfgText = $null }
        $markerVerify = $Marker -replace '\s+date=\S+', ''
        $__cfgNoDate = $__cfgText -replace '\s+date=\S+', ''
        if ($__cfgText -eq $null -or $__cfgNoDate.IndexOf($markerVerify) -lt 0 -or $__cfgText.IndexOf($BaseUrl) -lt 0) {
            Write-Host ("FAIL: jsonc fail: node-write verify marker/baseURL missing in " + $Cfg + ". exit 6 jsonc fail")
            exit 6
        }
        # round-trip verify: strip // + /* */ single+multiline (lines with //,/* not comment, http:// intact) and JSON.parse via node
        $chk = & $NodeExe -e "const fs=require('fs');let s=fs.readFileSync(process.env.C,'utf8');let o='',i=0;const n=s.length;let a=false,e=false,l=false,b=false;const q=String.fromCharCode(34);while(i<n){const c=s[i],x=(i+1<n)?s[i+1]:'';if(l){if(c==='\n'){l=false;o+=c;}i++;continue;}if(b){if(c==='*'&&x==='/'){b=false;i+=2;continue;}if(c==='\n')o+=c;i++;continue;}if(a){o+=c;if(e)e=false;else if(c==='\\')e=true;else if(c===q)a=false;i++;continue;}if(c===q){a=true;o+=c;i++;continue;}if(c==='/'&&x==='/'){l=true;i+=2;continue;}if(c==='/'&&x==='*'){b=true;i+=2;continue;}o+=c;i++;}o=o.replace(/,(\s*[}\]])/g,'$1');JSON.parse(o);console.log('round-trip ok')" 2>&1 | Out-String
        $env:C = $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host ("FAIL: jsonc fail round-trip verify. exit 6 jsonc fail")
            exit 6
        }
        # ban serialization via JSON-module for jsonc-paths: verify that our node-script ego not used as primary mechanism
        # SELF-PATH fallback: inside function $MyInvocation.MyCommand.Path = name function (path null) -> $PSCommandPath/$PSScriptRoot/script-scope $dir; null/empty -> skip checks WITHOUT exit 6 (not mask under jsonc fail)
        $selfPath = $null
        try { $selfPath = $MyInvocation.MyCommand.Path } catch { $selfPath = $null }
        if ([string]::IsNullOrEmpty($selfPath)) { $selfPath = $PSCommandPath }
        if ([string]::IsNullOrEmpty($selfPath) -and (-not [string]::IsNullOrEmpty($PSScriptRoot))) { $selfPath = Join-Path $PSScriptRoot 'install_proxy.ps1' }
        if ([string]::IsNullOrEmpty($selfPath) -and (-not [string]::IsNullOrEmpty($script:dir))) { $selfPath = Join-Path $script:dir 'install_proxy.ps1' }
        if ([string]::IsNullOrEmpty($selfPath) -and (-not [string]::IsNullOrEmpty($dir))) { $selfPath = Join-Path $dir 'install_proxy.ps1' }
        if ([string]::IsNullOrEmpty($selfPath) -or (-not (Test-Path -LiteralPath $selfPath))) {
            Write-Host "WARN: self-check skipped, installer path unresolved (banned-serializer verify unavailable, jsonc write continues; NOT a jsonc fail)"
        } else {
            $selfHits = Select-String -Path $selfPath -Pattern ('JSON\.'+'stringify') -ErrorAction SilentlyContinue
            if ($selfHits -ne $null -and @($selfHits).Count -gt 0) {
                Write-Host "FAIL: banned serializer found in installer jsonc path. exit 6 jsonc fail"
                exit 6
            }
        }
        return $true
    } catch {
        try { Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue } catch { }
        if ($_.Exception.Message -like 'FAIL:*' -or $_.Exception.Message -like '*exit 6*') { throw }
        Write-Host ("FAIL: jsonc fail: " + $_.Exception.Message + ". exit 6 jsonc fail")
        exit 6
    }
}

# M-vendor-pin: verify until backup and until LYuBOY jsonc-edit (mismatch -> exit 6, file not write, extra .bak no).
# files-pin files-pin (spec refs ): verify files[]+r-changedFiles there itself (mismatch -> exit 1 distinct from exit 6, file not write).
if (Test-Path -LiteralPath $configPathResolved) {
    [void](Test-VendorPin -BaseDir $dir -VendorDir $vendorDir)
    [void](Test-FilesPin -BaseDir $dir)
}
# backup live config in prod (as spec) — in TestMode bekapitsya temp-copy inside Invoke-JsoncSetBaseUrl
if (-not $isTest -and (-not $isDry)) {
    if (Test-Path -LiteralPath $configPathResolved) {
        $bakLive = $configPathResolved + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $configPathResolved -Destination $bakLive -Force
        # P0: post-verify live backup (SHA256+size, symlink-resolve); mismatch -> remove incomplete copy + exit 1
        [void](Assert-PostCopyPin -Src $configPathResolved -Dst $bakLive -Bak '')
        Write-Host ("Config backup: " + $bakLive)
    }
}
try {
    if ($node -eq $null -or $node -eq '') {
        if ($isDry) { Write-Host "DRYRUN jsonc step skipped (no node in dryrun bootstrap)" }
        else { Exit-With -Code 6 -Msg "FAIL: no node for jsonc-parser step. exit 6 jsonc fail: no node" }
    } else {
        $env:C = $configPathResolved
        Invoke-JsoncSetBaseUrl -NodeExe $node -Cfg $configPathResolved -BaseUrl $baseUrl -Marker $markerLine -Dry $isDry
        $env:C = $null
    }
} catch {
    if ($_.Exception.Message -like 'FAIL:*') { throw }
    Exit-With -Code 6 -Msg ("FAIL: jsonc fail: " + $_.Exception.Message + ". exit 6 jsonc fail")
}

# ================= STAGE 7b. Persistence Startup/Task (exit 5) =================
# : strict validation TASKNAME/SOCKS until write bat (error -> exit 2, bat not written)
if ([string]::IsNullOrEmpty($taskName) -or ($taskName -match '[\\/:*?"<>|]')) {
    Exit-With -Code 2 -Msg ('FAIL: bad task name [' + $taskName + '] (empty or contains forbidden char). Set MUSE_PROXY_TASKNAME to a valid name. exit 2')
}
if ($socksMode -ne 'direct') {
    $sp17 = $socksMode.Split(':')
    $socksPort17 = 0
    if ($sp17.Count -ne 2 -or [string]::IsNullOrEmpty($sp17[0]) -or (-not [int]::TryParse($sp17[1], [ref]$socksPort17)) -or $socksPort17 -lt 1 -or $socksPort17 -gt 65535) {
        Exit-With -Code 2 -Msg ("FAIL: bad SOCKS '" + (Mask-Secret $socksMode) + "' (expected direct or host:port 1..65535). exit 2")
    }
}
try {
    if ($mode -eq 'task') {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not $isAdmin) { Exit-With -Code 5 -Msg "FAIL: task mode requires Administrator. exit 5" }
        $socksEnv = $socksMode
        if ($socksEnv -eq 'direct') { $socksEnv = '' }
        $cmdArg = '/c set "MUSE_PROXY_LOGFILE=' + $logFile + '" && set "MUSE_PROXY_UPSTREAM=' + $Upstream + '" && set "MUSE_PROXY_PORT=' + $finalPort + '" && set "MUSE_PROXY_SOCKS=' + $socksEnv + '" && set "HTTP_PROXY=" && set "HTTPS_PROXY=" && set "ALL_PROXY=" && set "NO_PROXY=" && set "http_proxy=" && set "https_proxy=" && set "all_proxy=" && set "no_proxy=" && "' + $node + '" "' + $serverScript + '"'
        if ($isDry) {
            Write-Host ("DRYRUN task: Register-ScheduledTask -TaskName '" + $taskName + "' AtLogOn RestartCount 0 desc='" + $batMarker + "'")
        } else {
            # : idempotency Task — compare description without date= (date changes each run)
            $existingTask = $null
            try { $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { $existingTask = $null }
            $normNew = $batMarker -replace '\s+date=\S+', ''
            $normEx = ''
            if ($existingTask -ne $null) { $normEx = ([string]$existingTask.Description -replace '\s+date=\S+', '') }
            if ($existingTask -ne $null -and $normEx -eq $normNew) {
                Write-Host ("NO-OP: task '" + $taskName + "' already up to date (marker same, date ignored).")
            } else {
                $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdArg -WorkingDirectory $dir
                $trigger = New-ScheduledTaskTrigger -AtLogOn
                $settings = New-ScheduledTaskSettingsSet -RestartCount 0 -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
                Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description $batMarker -Force | Out-Null
                Write-Host ("Scheduled Task '" + $taskName + "' created. marker ok")
            }
        }
    } else {
        if ($isDry) {
            Write-Host ("DRYRUN startup: bat=" + (Join-Path $startupDirResolved $batName) + " vbs=" + (Join-Path $startupDirResolved $vbsName) + " port=" + $finalPort)
        } else {
            if (-not (Test-Path -LiteralPath $startupDirResolved)) { New-Item -ItemType Directory -Path $startupDirResolved -Force | Out-Null }
            $batPath = Join-Path $startupDirResolved $batName
            $vbsPath = Join-Path $startupDirResolved $vbsName
            $socksEnv = $socksMode
            if ($socksEnv -eq 'direct') { $socksEnv = '' }
            $batContent = @"
$batMarker
@echo off
chcp 65001 >nul
set "MUSE_PROXY_LOGFILE=$logFile"
set "MUSE_PROXY_UPSTREAM=$Upstream"
set "MUSE_PROXY_PORT=$finalPort"
set "MUSE_PROXY_SOCKS=$socksEnv"
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set NO_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
set no_proxy=
set BACKOFF=5
:loop
netstat -ano | findstr /R ":$finalPort[^0-9]" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    timeout /t %BACKOFF% >nul
    goto loop
)
"$node" "$serverScript"
set EXITC=%errorlevel%
if %EXITC%==2 (
    echo EADDRINUSE port-guard: port $finalPort busy (server exit 2), backoff %BACKOFF%s
    timeout /t %BACKOFF% >nul
    goto backoff_inc
)
if %EXITC%==0 (
    set BACKOFF=5
    timeout /t 5 >nul
    goto loop
)
timeout /t %BACKOFF% >nul
:backoff_inc
set /a BACKOFF=%BACKOFF%*2
if %BACKOFF% GTR 60 set BACKOFF=60
set /a JITTER=%RANDOM% %% 3
set /a WAIT=%BACKOFF%+%JITTER%
timeout /t %WAIT% >nul
goto loop
"@
            $batContent = $batContent -replace "`r?`n", "`r`n"
            $vbsContent = @"
Set objShell = CreateObject("WScript.Shell")
objShell.Run """$batPath""", 0, False
"@
            $vbsContent = $vbsContent -replace "`r?`n", "`r`n"
            $utf8NoBom = New-Object System.Text.UTF8Encoding $false
            # idempotency by REM @release-managed: matched -> no-op
            $needBat = $true
            if (Test-Path -LiteralPath $batPath) {
                $ex = Get-Content -LiteralPath $batPath -Raw -Encoding UTF8
                $normBatNew = $batMarker -replace '\s+date=\S+', ''
                $normBatContent = $batContent -replace '\s+date=\S+', ''
                $normEx = ''
                if ($ex -ne $null) { $normEx = ([string]$ex -replace '\s+date=\S+', '') }
                if ($ex -ne $null -and $normEx.Contains($normBatNew) -and $normEx.Trim() -eq $normBatContent.Trim()) {
                    Write-Host "Startup .bat unchanged (idempotent, marker ok, date ignored)."
                    $needBat = $false
                } elseif ($ex -ne $null -and $ex.Contains($Script:MarkerTag) -and (-not $normEx.Contains($normBatNew))) {
                    $bakB = $batPath + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
                    Copy-Item -LiteralPath $batPath -Destination $bakB -Force
                    # P0: post-verify bat-backup (SHA256+size, symlink-resolve); mismatch -> remove incomplete copy + exit 1
                    [void](Assert-PostCopyPin -Src $batPath -Dst $bakB -Bak '')
                    Write-Host ("Startup .bat backup: " + $bakB)
                }
            }
            if ($needBat) {
                [IO.File]::WriteAllText($batPath, $batContent, $utf8NoBom)
                # P0: post-verify write bat (expected text vs file); mismatch -> rollback from .bak or removal + exit 1
                $__postBakB = ''
                try { if ($bakB -ne $null -and $bakB -ne '') { $__postBakB = $bakB } } catch { }
                [void](Assert-PostWritePin -Dst $batPath -ExpectedText $batContent -Bak $__postBakB)
                Write-Host ("Installed: " + $batPath)
            }
            $needVbs = $true
            if (Test-Path -LiteralPath $vbsPath) {
                $exv = Get-Content -LiteralPath $vbsPath -Raw -Encoding UTF8
                if ($exv -ne $null -and $exv.Trim() -eq $vbsContent.Trim()) {
                    Write-Host "Startup .vbs unchanged (idempotent)."
                    $needVbs = $false
                }
            }
            if ($needVbs) {
                [IO.File]::WriteAllText($vbsPath, $vbsContent, $utf8NoBom)
                # P0: post-verify write vbs (expected text vs file); backup vbs no -> mismatch removes partial, exit 1 (symmetry bat requires .bak — rejected, without change behavior)
                [void](Assert-PostWritePin -Dst $vbsPath -ExpectedText $vbsContent -Bak '')
                Write-Host ("Installed: " + $vbsPath)
            }
        }
    }
} catch {
    if ($_.Exception.Message -like 'FAIL:*') { throw }
    Exit-With -Code 5 -Msg ("FAIL: persistence: " + $_.Exception.Message + ". exit 5")
}

# ================= STAGE 8. Smoke + report (exit 7) =================
if (-not $isDry) {
    try {
        if (Test-Path -LiteralPath $smokeScript) {
            if ($isTest) {
                $sm = & $node $smokeScript --port $finalPort --mock 2>&1 | Out-String
                $sec = Select-String -InputObject $sm -Pattern '(?i)(sk-[A-Za-z0-9]|bearer [A-Za-z0-9]|api[_-]?key\s*[:=]\s*[A-Za-z0-9])' -AllMatches
                if ($sec -ne $null -and @($sec.Matches).Count -gt 0) {
                    Exit-With -Code 7 -Msg "FAIL: smoke log leaks secrets. exit 7"
                }
                if ($LASTEXITCODE -ne 0) {
                    Exit-With -Code 7 -Msg ("FAIL: smoke failed. rollback -LastInstall hint (by marker). " + (Mask-Secret $sm) + ". exit 7")
                }
                Write-Host "Smoke mock PASS."
            } else {
                Write-Host "Smoke: live e2e forbidden in gates — run mock manually: node smoke-r3.js --port $finalPort --mock"
            }
        } else {
            Write-Host "WARNING: smoke-r3.js not found — skipping smoke (no fail)."
        }
    } catch {
        if ($_.Exception.Message -like 'FAIL:*') { throw }
        Exit-With -Code 7 -Msg ("FAIL: smoke: " + $_.Exception.Message + ". exit 7")
    }
} else {
    Write-Host ("DRYRUN smoke: would run node smoke-r3.js --port " + $finalPort + " --mock")
}

# ---------- report ----------
$hash = ''
try { $hash = (Get-FileHash -LiteralPath $serverScript -Algorithm SHA256).Hash } catch { $hash = 'n/a' }
Write-Host ""
Write-Host "=== install_proxy v2 report ==="
Write-Host ("  mode:     " + $mode)
Write-Host ("  port:     " + $finalPort + " (baseURL " + $baseUrl + ")")
Write-Host ("  upstream: " + (Mask-Secret $Upstream))
Write-Host ("  socks:    " + (Mask-Secret $socksMode))
Write-Host ("  task:     " + $taskName)
Write-Host ("  config:   " + $configPathResolved)
Write-Host ("  startup:  " + $startupDirResolved)
Write-Host ("  log:      " + $logFile)
Write-Host ("  server:   " + $serverScript + " sha256=" + $hash)
Write-Host ("  marker:   " + $markerLine)
Write-Host ("  testMode: " + $isTest)
if ($RestartOpenCode) { Write-Host "NOTE: restart OpenCode/Desktop to pick up new baseURL (explicit -RestartOpenCode)." }
Write-Host "Rollback: pwsh -ExecutionPolicy Bypass -File rollback_proxy.ps1"
exit 0
