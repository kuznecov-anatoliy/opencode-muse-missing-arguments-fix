# rollback_proxy.ps1 v2 — standalone rollback Node-proxy Muse Spark (only by marker).
# coverage coverage by SPEC (all outcomes + gates gate/gate)
# NOT delegates on Desktop «rollback proxy.ps1» (defect isolation wrapper v1 fixed).
# Reference logic: release\ref-rollback-proxy.ps1 (:14 config, :18-38 regex, :26 orphan-comma, :126-139 Restart).
# Differences v2: strict marker // @release-managed, jsonc-parser preservation (node -e),
# targeted kill only by script= from marker, -DryRun / -TestMode, idempotency.
#
# OUTCOMES (4, see. --help and gate):
# 1) valid marker → cleanup baseURL+marker + targeted kill + removal release- Task/bat → exit 0 (cleaned)
# 2) already clean → no marker and no baseURL → exit 0 (already clean)
# 3) foreign → baseURL foreign without OUR marker (no @release-managed lines) → exit 0 (nothing to do, without actions)
# 4) corrupt → line @release-managed present, but without required port=/script= or not parsed → exit 6 (marker corrupt, nothing not remove)
# Distinction texts: "marker corrupt" (marker) vs "jsonc fail" (config/parser). Not mix.
#
# FLAGS:
# -DryRun / -WhatIf — diff without actions (that bylo would removed).
# -TestMode — only release-* Task/bat + only temp config; refusal on equality live paths; real kill no (simulation).
# -RestartOpenCode — ONLY explicitly; order rollback «first config, then processes» (L21); restart in very end.
# -ConfigPath <path> — temp config for tests; prod-path by default from OPCODE_CONFIG_PATH.
# -StartupDir <path> — override Startup-directory for tests (in prod — %APPDATA%\...\Startup).
# -Help — show help and vyyti 0.
#
# EXIT-CODES: 0 success/already clean/nothing to do; 1 integrity (post-copy pin mismatch, original intact); 2 UNC/guard; 6 marker corrupt | jsonc fail (vendor/marker) | refusal live paths in TestMode. Copy throw → 6, pin mismatch → 1 (distinct).
# BEZOPASNOST: ports 8780-8790 not bind (only read-only Get-NetTCPConnection); live e2e forbidden;
# zero live requests with token; secrets masked (Bearer/sk-*=***); taskkill /F forbidden;
# live Task/Startup without marker not touch; fallback %APPDATA% for config forbidden.
# SYNTAX: only PS5.1-compatible (without null-coalescing and shorthand ternaries).
#
# Startup:
# pwsh -ExecutionPolicy Bypass -File rollback_proxy.ps1 [-DryRun] [-TestMode -ConfigPath <temp-jsonc>] [-RestartOpenCode]
# pwsh -ExecutionPolicy Bypass -File rollback_proxy.ps1 -Help

param(
    [switch]$DryRun,
    [switch]$WhatIf,
    [switch]$TestMode,
    [switch]$RestartOpenCode,
    [string]$ConfigPath = '',
    [string]$StartupDir = '',
    [switch]$Help
)

$ErrorActionPreference = 'Continue'

# : UNC-paths not supported (fail-fast, exit 2)
if ($PSScriptRoot -match '^\\\\') {
    Write-Error 'UNC path not supported (script runs from a network share), copy release/ to a local disk and rerun. exit 2'
    exit 2
}

function Show-RollbackHelp {
    Write-Host ''
    Write-Host 'rollback_proxy.ps1 v2 — standalone rollback (only by marker // @release-managed).'
    Write-Host ''
    Write-Host 'Marker (sole criterion «own», SPEC ):'
    Write-Host '  // @release-managed MuseSparkProxy port=<PORT> upstream=<URL> socks=<SOCKS|direct> task=<TASKNAME> date=<ISO8601> script=<abs-path server.js>'
    Write-Host ''
    Write-Host 'Outcomes (gate):'
    Write-Host ' # | Situatsiya | Soobshchenie | Exit | Deystviya'
    Write-Host ' 1 | Valid marker | cleaned | 0 | backup + removal baseURL+marker (node -e jsonc-parser preservation) + targeted kill by script= + removal own Task/bat'
    Write-Host ' 2 | No marker, no baseURL | already clean | 0 | nothing (idempotency: repeat run)'
    Write-Host ' 3 | Foreign baseURL without OUR marker | nothing to do | 0 | NOTHING (foreign not touch: nor baseURL, nor Task, nor processes)'
    Write-Host ' 4 | Marker present, but without port=/script= / not parsed | marker corrupt | 6 | NOTHING not remove; print path + contents marker + instructions manual cleanup (manual review required)'
    Write-Host ' - | Error jsonc-parser/validation | jsonc fail | 6 | NOTHING not write on top; text differs from marker corrupt'
    Write-Host ''
    Write-Host 'Flags: -DryRun/-WhatIf (diff), -TestMode (only release-* + temp config), -RestartOpenCode (only explicitly, in end), -ConfigPath, -StartupDir, -Help.'
    Write-Host 'Primery:'
    Write-Host '  pwsh -ExecutionPolicy Bypass -File rollback_proxy.ps1 -DryRun'
    Write-Host '  pwsh -ExecutionPolicy Bypass -File rollback_proxy.ps1 -TestMode -ConfigPath "$env:TEMP\release-test-1\opencode.jsonc" -DryRun'
    Write-Host '  pwsh -ExecutionPolicy Bypass -File rollback_proxy.ps1 -TestMode -ConfigPath "$env:TEMP\release-test-1\opencode.jsonc"'
}

if ($Help) {
    Show-RollbackHelp
    exit 0
}

$isDry = $false
if ($DryRun -or $WhatIf) { $isDry = $true }

function Mask-Secrets([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return $s }
    $o = $s
    # : masks level server.js sanitize (Bearer/sk-/x-api-key/Basic/password/query/CRLF/\uXXXX)
    try { $o = [regex]::Replace($o, '\\u([0-9a-fA-F]{4})', { param($mm) ([char]([Convert]::ToInt32($mm.Groups[1].Value, 16))).ToString() }) } catch { }
    $o = [regex]::Replace($o, '(?i)Bearer\s+[A-Za-z0-9\-._~+/=]+', 'Bearer ***REDACTED***')
    $o = [regex]::Replace($o, '(?i)sk-[A-Za-z0-9\-]+', 'sk-***REDACTED***')
    $o = [regex]::Replace($o, '(?i)["'']?(x-api-key|x-auth-token|x-access-token|proxy-authorization|api-key|apikey)["'']?\s*[=:]\s*["'']?[^"'',}\s]+', { param($mm) (($mm.Value -split '[=:]')[0] -replace '["'']', '') + '=***' })
    $o = [regex]::Replace($o, '(?i)Basic\s+[A-Za-z0-9+/=]+', 'Basic ***')
    $o = [regex]::Replace($o, '(?i)["'']?(password|passwd|client_secret|refresh_token)["'']?\s*[=:]\s*["'']?[^"'',}\s]+', { param($mm) (($mm.Value -split '[=:]')[0] -replace '["'']', '') + '=***' })
    $o = [regex]::Replace($o, '(?i)[?&](api_key|apikey|token|key|secret|access_token|auth|password|passwd|refresh_token|client_secret)=[^&\s]*', { param($mm) (($mm.Value -split '=')[0] + '=***') })
    $o = [regex]::Replace($o, "`r`n|`r|`n", '\n')
    return $o
}

# --- Resolver config (OPCODE_CONFIG_PATH; fallback %APPDATA% forbidden) ---
$liveConfig = "$env:USERPROFILE\.config\opencode\opencode.jsonc"
$cp = ''
if (-not [string]::IsNullOrEmpty($ConfigPath)) {
    $cp = $ConfigPath
} elseif (-not [string]::IsNullOrEmpty($env:OPCODE_CONFIG_PATH)) {
    $cp = $env:OPCODE_CONFIG_PATH
} else {
    $cp = $liveConfig
}

Write-Host "[cfg] config: $(Mask-Secrets $cp)"
if ($TestMode) { Write-Host '[mode] TestMode: only release-* + temp config; real kill no.' }
if ($isDry) { Write-Host '[mode] DryRun: diff without actions.' }

# Refusal on equality live paths in tests (prod untouchable).
if ($TestMode) {
    try {
        $a = [System.IO.Path]::GetFullPath($cp).TrimEnd('\').ToLowerInvariant()
        $b = [System.IO.Path]::GetFullPath($liveConfig).TrimEnd('\').ToLowerInvariant()
        if ($a -eq $b) {
            Write-Error "jsonc fail: refusing live config in TestMode: $cp (pass temp -ConfigPath)"
            exit 6
        }
    } catch {
        Write-Error "jsonc fail: bad ConfigPath in TestMode: $cp : $_"
        exit 6
    }
    # Ports 8780-8790 not bind and in TestMode zapreshchaem marker-port from this range clean silently:
    # (itself rollback ports not bindit — only read-only check; explicit marker from ban → warning, not refusal,
    # t.to. prod-marker 8787 in prod validen; in TestMode expect 18887+).
    # IN TestMode with foreign prod-marker side-effect only on temp-config (intended, not bug).
}

if (-not (Test-Path -LiteralPath $cp)) {
    Write-Host 'already clean, exit 0 (file config not found — nothing rollback).'
    exit 0
}

$raw = Get-Content -LiteralPath $cp -Raw

# --- Search marker ---
$markerLines = @()
try {
    $markerLines = @(Select-String -LiteralPath $cp -Pattern '@release-managed' -AllMatches | ForEach-Object { $_.Line })
} catch {
    $markerLines = @()
}

$hasBaseUrl = $raw -match '"baseURL"\s*:'

if ($markerLines.Count -eq 0) {
    # No OUR marker voobshche → foreign or already clean. Nothing not touch (substring rule, rule №1 ).
    if (-not $hasBaseUrl) {
        Write-Host 'already clean, exit 0 (no marker, baseURL no).'
        exit 0
    } else {
        Write-Host 'nothing to do, exit 0 (foreign baseURL without marker @release-managed — not touch).'
        exit 0
    }
}

# Present >=1 line with @release-managed → strict parsing (order port/upstream/socks/task/date/script).
$strict = '//\s*@release-managed\s+MuseSparkProxy\s+port=(?<port>\S+)\s+upstream=(?<upstream>\S+)\s+socks=(?<socks>\S+)\s+task=(?<task>\S+)\s+date=(?<date>\S+)\s+script=(?<script>.+?)\s*$'
$marker = $null
$markerText = ''
foreach ($ln in $markerLines) {
    $m = [regex]::Match($ln, $strict)
    if ($m.Success) {
        $markerText = $ln.Trim()
        $marker = @{
            port     = $m.Groups['port'].Value.Trim()
            upstream = $m.Groups['upstream'].Value.Trim()
            socks    = $m.Groups['socks'].Value.Trim()
            task     = $m.Groups['task'].Value.Trim()
            date     = $m.Groups['date'].Value.Trim()
            script   = $m.Groups['script'].Value.Trim().Trim('"').Trim("'")
        }
        break
    }
}

if ($marker -eq $null) {
    # Corrupt marker → exit 6, nothing not remove, print path + contents (manual review).
    Write-Error 'marker corrupt: manual review required (line @release-managed present, but required port=/script= missing or format not strict). Nothing not removed.'
    Write-Host "config: $cp"
    Write-Host '--- marker content ---'
    foreach ($ln in $markerLines) { Write-Host (Mask-Secrets $ln) }
    Write-Host '--- end marker ---'
    Write-Host 'Manual cleanup: open config, check line @release-managed and adjacent baseURL, remove only own pair manually, then repeat rollback.'
    exit 6
}

# Validation fields marker.
$portInt = 0
if (-not [int]::TryParse($marker['port'], [ref]$portInt)) { $portInt = 0 }
if ($portInt -lt 1 -or $portInt -gt 65535) {
    Write-Error ("marker corrupt: manual review required (port outside 1-65535: '" + (Mask-Secrets $marker['port']) + "'). Nothing not removed.")
    Write-Host "config: $cp"
    Write-Host (Mask-Secrets $markerText)
    exit 6
}
if ([string]::IsNullOrEmpty($marker['script'])) {
    Write-Error 'marker corrupt: manual review required (blanket script=). Nothing not removed.'
    Write-Host "config: $cp"
    Write-Host (Mask-Secrets $markerText)
    exit 6
}
if (-not [System.IO.Path]::IsPathRooted($marker['script'])) {
    Write-Error ("marker corrupt: manual review required (script= not absolute path: '" + (Mask-Secrets $marker['script']) + "'). Nothing not removed.")
    Write-Host "config: $cp"
    Write-Host (Mask-Secrets $markerText)
    exit 6
}
if ([string]::IsNullOrEmpty($marker['task'])) {
    Write-Error 'marker corrupt: manual review required (blanket task=). Nothing not removed.'
    Write-Host "config: $cp"
    Write-Host (Mask-Secrets $markerText)
    exit 6
}

Write-Host ("[marker] port=" + $marker['port'] + " task=" + (Mask-Secrets $marker['task']) + " socks=" + (Mask-Secrets $marker['socks']) + " script=" + (Mask-Secrets $marker['script']))

# TestMode: task must be release-* (isolation prod Task).
if ($TestMode -and -not ($marker['task'] -like 'release-*')) {
    Write-Host ("[TestMode] marker task='" + (Mask-Secrets $marker['task']) + "' not release-* → Task/kill skip (only simulation), config-part by temp-file continue.")
}

# --- Plan removal in config: line marker + line baseURL ONLY with own port (substring rule: broad match forbidden) ---
$lines = $raw -split "`r?`n"
$markerIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '@release-managed' -and $lines[$i] -match ([regex]::Escape($marker['port']) + '(?![0-9])') -and $lines[$i] -match 'MuseSparkProxy') { $markerIdx = $i; break }
}
if ($markerIdx -lt 0) {
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '@release-managed') { $markerIdx = $i; break }
    }
}
$baseIdx = -1
$portEsc = [regex]::Escape($marker['port'])
# legacy-read both forms, write canon /v1
$basePat = '"baseURL"\s*:\s*"http://127\.0\.0\.1:' + $portEsc + '(\/v1)?"'
# Prefer adjacent lines (marker above, baseURL below — format ; window ±2), otherwise full scan vsego file with OWN port.
$neighbors = @()
if ($markerIdx -ge 0) {
    foreach ($off8 in @(1, 2)) {
        if (($markerIdx + $off8) -lt $lines.Count) { $neighbors += @($markerIdx + $off8) }
        if (($markerIdx - $off8) -ge 0) { $neighbors += @($markerIdx - $off8) }
    }
}
foreach ($j in $neighbors) {
    if ($lines[$j] -match $basePat) { $baseIdx = $j; break }
}
if ($baseIdx -lt 0) {
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $basePat) { $baseIdx = $i; break }
    }
}

if ($markerIdx -lt 0 -and $baseIdx -lt 0) {
    Write-Host 'already clean, exit 0 (marker parsed, but lines for removal already no — idempotency).'
    exit 0
}

Write-Host '[diff] will removed:'
Write-Host (" - line $($markerIdx): " + (Mask-Secrets $lines[$markerIdx]))
if ($baseIdx -ge 0) { Write-Host (" - line $($baseIdx): " + (Mask-Secrets $lines[$baseIdx].Trim())) }

if ($isDry) {
    Write-Host 'DryRun: actions no (config, processes, Task/bat not touched). exit 0.'
    exit 0
}

# P0 post-copy/symlink verify backup: SHA256+size src vs dst via Get-FileHash + Length.
# Semantika codes preserved: vendor-pin -> exit 6, files-pin (this backup) -> exit 1; throw on Copy-Item remains exit 6 (jsonc fail), mismatch -> exit 1.
# Symlink/junction: resolve Target and compare content target (generic; hits symlink in release so far 0).
function Get-RbPostCopyHashInfo([string]$Path) {
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
                    if (-not [System.IO.Path]::IsPathRooted($t0)) { $t0 = Join-Path (Split-Path -Parent $Path) $t0 }
                    if (Test-Path -LiteralPath $t0) { $real = $t0 }
                }
            }
        } catch { }
        $h = (Get-FileHash -LiteralPath $real -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpper()
        $s = (Get-Item -LiteralPath $real -ErrorAction Stop).Length
        return @{ hash = $h; size = [long]$s }
    } catch { return $null }
}
function Assert-RbPostCopyPin([string]$Src, [string]$Dst) {
    # port-validation: distinct 1 vs 6 — pin mismatch (incomplete copy) -> exit 1; Copy-Item throw (infra/backup fail) -> exit 6 (catch step 1 below).
    # On mismatch: remove incomplete copy backup + exit 1 (original $Src not touched).
    $si = Get-RbPostCopyHashInfo $Src
    $di = Get-RbPostCopyHashInfo $Dst
    if ($si -eq $null -or $di -eq $null -or $si.hash -ne $di.hash -or $si.size -ne $di.size) {
        Write-Host ("FAIL: post-copy pin mismatch (" + $Src + " -> " + $Dst + "). Rollback (removal incomplete copy), exit 1")
        try { Remove-Item -LiteralPath $Dst -Force -ErrorAction SilentlyContinue } catch { }
        Write-Error ("post-copy pin mismatch: " + $Src + " -> " + $Dst + ". exit 1") -ErrorAction Continue
        exit 1
    }
    Write-Host ("Post-copy pin ok (" + $Src + " -> " + $Dst + " SHA256+size).")
    return $true
}
function Assert-RbPostWritePin([string]$Dst, [string]$ExpectedText, [string]$Bak) {
    # Post-verify after WriteAllText (raw UTF8-noBOM, as zapisano; NOT LF-canon — $new CRLF Join).
    # Mismatch -> restore live config from $Bak (Copy $Bak->$Dst, removal forbidden) + exit 6 (contract 0/1/2/6; 1 zarezervirovan for post-copy pin, here not vykhodit).
    $enc = New-Object System.Text.UTF8Encoding $false
    $expBytes = $enc.GetBytes($ExpectedText)
    $sha = New-Object System.Security.Cryptography.SHA256Managed
    $expHash = ([BitConverter]::ToString($sha.ComputeHash($expBytes)) -replace '-', '').ToUpper()
    $sha.Dispose()
    $expSize = [long]$expBytes.Length
    $di = Get-RbPostCopyHashInfo $Dst
    if ($di -eq $null -or $di.hash -ne $expHash -or $di.size -ne $expSize) {
        Write-Host ("FAIL: post-write pin mismatch (" + $Dst + " want " + $expHash + "/" + $expSize + "). Restore from backup, exit 6")
        # NB-07: SilentlyContinue knowingly — restore best-effort inside pin-check; throw here would drop would check past Write-Error/exit 6 below, failure restore visible by post-check config.
        try { Copy-Item -LiteralPath $Bak -Destination $Dst -Force -ErrorAction SilentlyContinue } catch { }
        Write-Error ("post-write pin mismatch: " + $Dst + ". Restored from backup: " + $Bak + ". exit 6") -ErrorAction Continue
        exit 6
    }
    Write-Host ("Post-write pin ok (" + $Dst + " SHA256+size).")
    return $true
}

# --- Step 1 (first — config, then processes; L21) ---
$bak = "$cp.bak-rollback-$(Get-Date -Format 'yyyyMMddHHmmss')"
try {
    # NB-02: -ErrorAction Stop required ($ErrorActionPreference='Continue', :43) — otherwise catch with exit 6 dead; symmetry with install_proxy.ps1:26.
    Copy-Item -LiteralPath $cp -Destination $bak -Force -ErrorAction Stop
    # P0: post-verify backup (SHA256+size, symlink-resolve); mismatch -> remove incomplete copy + exit 1
    Assert-RbPostCopyPin $cp $bak | Out-Null
    Write-Host " backup: $bak"
} catch {
    # port-validation: Copy-Item throw (infra/backup fail) -> exit 6 jsonc fail; distinct from pin mismatch -> exit 1 (Assert-RbPostCopyPin above).
    Write-Error "jsonc fail: not succeeded create backup $bak : $_" -ErrorAction Continue
    exit 6
}

$newLines = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -eq $markerIdx -or $i -eq $baseIdx) { continue }
    $newLines += $lines[$i]
}
$new = [string]::Join("`r`n", $newLines)
# orphan-comma regression-bridge (ref:26): dangling comma before } or ] after removal lines ().
$new = [regex]::Replace($new, ',\s*([\}\]])', '$1')

# jsonc-parser preservation: round-trip check via node -e + vendor 3.3.1 (see. SPEC ).
# Vendor: vendor\jsonc-parser relative script (NOT absolute path, NOT global npm-package).
# API 3.3.1: parse + modify + applyEdits (exit modify/applyEdits + repeat parse = round-trip); offline without vendor/node => fail-closed exit 6 ( canon gate/).
# Internal codes node -e (NOT public contract PS): process.exit(10) vendor-probe fail (:363), process.exit(11) parse-fail (:369), process.exit(12) re-parse-fail (:369), process.exit(0) ok. Lyuboy non-zero from node -e PS maps in exit 6 jsonc fail (:370-374). Public contract PS — only 0/1/2/6 (:23, :51-76 help, SPEC /gate): 1=integrity post-copy pin (original intact), 6=vendor/marker/jsonc. 11 decimal = 0x0B hex; literal «exit 0B»/«0x0B» in code no.
$nodeExe = ''
try { $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source } catch { $nodeExe = '' }
$vendorJsonc = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'vendor\jsonc-parser'
if (-not [string]::IsNullOrEmpty($nodeExe)) {
    $env:RB_VENDOR = $vendorJsonc
    $probe = & $nodeExe -e "try{var jp=require(process.env.RB_VENDOR);if(jp&&typeof jp.parse==='function'&&typeof jp.modify==='function'&&typeof jp.applyEdits==='function'){process.exit(0)}process.exit(10)}catch(e){process.exit(10)}" 2>&1
    if ($LASTEXITCODE -eq 0) {
        $tmpNew = Join-Path ([System.IO.Path]::GetTempPath()) ("release-rollback-check-" + [System.Guid]::NewGuid().ToString('N') + '.jsonc')
        try {
            [System.IO.File]::WriteAllText($tmpNew, $new, (New-Object System.Text.UTF8Encoding $false))
            # Round-trip validation: parse, then exit modify/applyEdits + repeat parse must be without errors.
            $v = & $nodeExe -e "var fs=require('fs');var jp=require(process.env.RB_VENDOR);var f=process.argv[1];var t=fs.readFileSync(f,'utf8');var errs=[];var v=jp.parse(t,errs,{allowTrailingComma:true,disallowComments:false});if(errs.length>0){console.error('parse errors: '+errs.length+' first offsets: '+errs.slice(0,3).map(function(e){return e.offset}).join(','));process.exit(11)}var ed=[];try{ed=jp.modify(t,['__rollback_noop__'],'1',{});}catch(noopErr){ed=[];}var out=jp.applyEdits(t,ed);var e2=[];jp.parse(out,e2,{});if(e2.length>0){process.exit(12)}process.exit(0);" $tmpNew 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Error ("jsonc fail: round-trip parse, exit modify/applyEdits, repeat parse not passed (node -e vendor exit " + $LASTEXITCODE + "). File not written, backup intact: $bak. Text error above.")
                try { Remove-Item -LiteralPath $tmpNew -Force -ErrorAction SilentlyContinue } catch { }
                $env:RB_VENDOR = $null
                exit 6
            }
            try { Remove-Item -LiteralPath $tmpNew -Force -ErrorAction SilentlyContinue } catch { }
            Write-Host ' OK: jsonc round-trip (node -e vendor parse, exit modify/applyEdits, repeat parse) PASS.'
        } catch {
            Write-Error "jsonc fail: exception checks jsonc-parser: $_ (file not written)."
            $env:RB_VENDOR = $null
            exit 6
        }
        $env:RB_VENDOR = $null
    } else {
        # fail-closed: vendor unavailable — write no, backup intact, exit 6 (canon install:546-549, gate/)
        $env:RB_VENDOR = $null
        Write-Error ("jsonc fail: vendor jsonc-parser unavailable (no round-trip possible). File NOT written, backup intact: " + $bak + ". exit 6 jsonc fail")
        exit 6
    }
} else {
    # fail-closed: node missing — write no, backup intact, exit 6
    Write-Error ("jsonc fail: node.exe missing (no round-trip possible). File NOT written, backup intact: " + $bak + ". exit 6 jsonc fail")
    exit 6
}

try {
    [System.IO.File]::WriteAllText($cp, $new, (New-Object System.Text.UTF8Encoding $false))
    Assert-RbPostWritePin $cp $new $bak | Out-Null
    Write-Host ' OK: baseURL+marker removed (preservation rest: removed only own lines).'
} catch {
    Write-Error "jsonc fail: write config not succeeded: $_ (backup: $bak)" -ErrorAction Continue
    exit 6
}

# --- Step 2: Startup bat/vbs — only with own REM @release-managed ---
$sdir = $StartupDir
if ([string]::IsNullOrEmpty($sdir)) {
    if ($TestMode) {
        $sdir = Join-Path ([System.IO.Path]::GetTempPath()) 'release-test-startup'
    } else {
        $sdir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
    }
}
# : UNC-paths targets (config/Startup) not supported (fail-fast, exit 2)
foreach ($tp24 in @($cp, $sdir)) {
    if (-not [string]::IsNullOrEmpty($tp24) -and ($tp24 -match '^\\\\')) {
        Write-Error ("UNC path not supported (" + $tp24 + "), copy release/ to a local disk and rerun. exit 2")
        exit 2
    }
}
Write-Host ("`n[2] Startup: " + $sdir)
$batNames = @('muse-spark-proxy.bat', 'muse-spark-proxy.vbs')
if ($TestMode) { $batNames = @('release-*.bat', 'release-*.vbs') }
foreach ($pat in $batNames) {
    $files = @()
    try { $files = @(Get-ChildItem -LiteralPath $sdir -Filter $pat -File -ErrorAction SilentlyContinue) } catch { $files = @() }
    foreach ($f in $files) {
        $txt = ''
        try { $txt = Get-Content -LiteralPath $f.FullName -Raw } catch { $txt = '' }
        $mine = ($txt -match '@release-managed') -and ($txt -match [regex]::Escape($marker['task']))
        if ($TestMode -and -not ($f.Name -like 'release-*')) { Write-Host (" SKIP (foreign, TestMode): " + $f.FullName); continue }
        if ($mine) {
            try {
                Remove-Item -LiteralPath $f.FullName -Force
                Write-Host (" OK: removed own: " + $f.FullName)
            } catch {
                Write-Host (" WARN: not removed " + $f.FullName + " : $_")
            }
        } else {
            Write-Host (" SKIP (foreign/without marker): " + $f.FullName)
        }
    }
}

# --- Step 3: Task + targeted kill (only Admin; kill only on match CommandLine with script=; taskkill /F forbidden) ---
Write-Host "`n[3] Task + processes..."
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { $isAdmin = $false }

$taskName = $marker['task']
$taskIsRelease = ($taskName -like 'release-*')
if ($TestMode -and -not $taskIsRelease) {
    Write-Host (" SKIP Task (TestMode, not release-*): " + (Mask-Secrets $taskName))
} elseif ($isAdmin) {
    $desc = ''
    try {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($t -ne $null) { $desc = [string]$t.Description }
    } catch { $desc = '' }
    # fallback (narrowly, only own): exact name not found, and task marker release-* —
    # search among release-* zadach tu, whose description contains @release-managed + name task from marker.
    if ($t -eq $null -and $taskIsRelease) {
        try {
            $cands = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'release-*' -and ([string]$_.Description -match '@release-managed') -and ([string]$_.Description -match [regex]::Escape($taskName)) })
            if ($cands.Count -gt 0) { $t = $cands[0]; $desc = [string]$t.Description }
        } catch { }
    }
    if ($t -ne $null -and $desc -match '@release-managed') {
        try {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            Write-Host (" OK: Task removed: " + (Mask-Secrets $taskName))
        } catch {
            Write-Host (" WARN: Task not removed: $_")
        }
    } elseif ($t -ne $null) {
        Write-Host (" SKIP (foreign Task without marker): " + (Mask-Secrets $taskName))
    } else {
        Write-Host (" INFO: Task not found: " + (Mask-Secrets $taskName))
    }

    # Targeted kill: Stop-Process node WHERE CommandLine CONTAINS script-path from marker (L16).
    # Broad CommandLine -match without check forbidden (substring rule) — use .Contains(script=).
    $scriptPath = $marker['script']
    try {
        $nodeProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    } catch { $nodeProcs = @() }
    $hit = @()
    foreach ($p in $nodeProcs) {
        $cmd = [string]$p.CommandLine
        if ([string]::IsNullOrEmpty($cmd)) { continue }
        # : case-insensitive compare ONLY own script-paths (foreign not touch)
        if ($cmd.ToLowerInvariant().Contains($scriptPath.ToLowerInvariant())) { $hit += $p }
    }
    if ($hit.Count -gt 0) {
        foreach ($p in $hit) {
            if ($TestMode) {
                Write-Host ("  [TestMode] would kill PID " + $p.ProcessId + " (script= matched, real kill skipped).")
            } else {
                try {
                    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                    Write-Host (" OK: stopped node.exe PID " + $p.ProcessId + " (script= matched).")
                } catch {
                    Write-Host ("  WARN: kill PID " + $p.ProcessId + " not succeed: $_")
                }
            }
        }
    } else {
        Write-Host ' INFO: processes own copy (CommandLine contains script=) not found.'
    }
} else {
    Write-Host ' WARN: without Admin — Task/kill skipped (as ref). Manual stop:'
    Write-Host ("    Stop-ScheduledTask -TaskName '" + (Mask-Secrets $taskName) + "'")
    Write-Host ("    Unregister-ScheduledTask -TaskName '" + (Mask-Secrets $taskName) + "' -Confirm:`$false")
}

# --- Step 4: post-checks (read-only; ports not bind) ---
Write-Host "`n[4] Post-checks (read-only)..."
try {
    $pc = Get-NetTCPConnection -LocalPort $portInt -State Listen -ErrorAction SilentlyContinue
    if ($pc) { Write-Host (" WARN: port " + $marker['port'] + " all yet busy.") }
    else { Write-Host (" OK: port " + $marker['port'] + " free.") }
} catch {
    Write-Host ' WARN: check port unavailable.'
}
try {
    # : boundary port (?![0-9]) — 8787 not matches 87871
    $refPat9 = [regex]::Escape('127.0.0.1:' + $marker['port']) + '(?![0-9])'
    $refs = Select-String -LiteralPath $cp -Pattern $refPat9 -AllMatches -ErrorAction SilentlyContinue
    if ($refs) { Write-Host ' WARN: config all yet contains refs on own port.' }
    else { Write-Host ' OK: config clean from own port.' }
} catch { }

Write-Host "`n=== GOTOVO (cleaned, exit 0) ==="

# --- RestartOpenCode only explicitly, in very end ---
if ($RestartOpenCode) {
    try {
        $oc = Get-Process -Name '*opencode*' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -match 'opencode-aidesktop') }
        if ($oc) {
            foreach ($o in $oc) {
                Write-Host (" Stopping: " + $o.Name + " PID " + $o.Id)
                if (-not $TestMode) { Stop-Process -Id $o.Id -Force -ErrorAction SilentlyContinue }
                else { Write-Host ' [TestMode] real stop skipped.' }
            }
            Write-Host ' OK: processes OpenCode stopped. Launch again.'
        } else {
            Write-Host ' INFO: processes OpenCode not found.'
        }
    } catch {
        Write-Host (" WARN: RestartOpenCode not done: $_")
    }
} else {
    Write-Host ' >>> Zakroyte all windows OpenCode Desktop and launch again, so that changes config vstupili in effect. <<<'
}
exit 0
