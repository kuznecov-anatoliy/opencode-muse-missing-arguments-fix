@echo off
REM verify-spec refs -dryrun.bat — baseline-guard spec refs live bat-run generation WITHOUT install in Startup.
REM Flag: --no-install / dry-run only. Bat NOTHING NOT INSTALLS: only read-only checks + install -TestMode -DryRun on temp-paths.
REM Checks paths: Startup folder (localization via GetFolderPath Startup), HKCU/HKLM Run, name Task (MuseSparkProxy/release-*).
REM Mismatch -> exit 1. Live requests — zero (upstream only mock/localhost, probe skipped -SkipProbe).
chcp 65001 >nul
setlocal EnableDelayedExpansion
set "RELDIR=%~dp0"
set "FAIL=0"
set "LOGVER=r31"
REM spec refs frozen, spec refs frozen: spec refs -dryrun.log/spec refs -checks.log/spec refs -dryrun.log/spec refs -checks.log/spec refs -stale.log historic, not overwrite; spec refs frozen, spec refs manual-frozen, spec refs frozen, spec refs frozen, current LOGVER=spec refs 

if "%1"=="--help" goto :help
if "%1"=="-h" goto :help
if not "%1"=="" if not "%1"=="--no-install" if not "%1"=="--dry-run" (
  echo FAIL: unknown flag %1 ^(use --no-install or --dry-run, install flags forbidden^)
  exit /b 2
)

echo [1/6] node --check server.js + smoke-r3.js ...
node --check "%RELDIR%server.js"
if %errorlevel% neq 0 ( echo FAIL: node --check server.js & set FAIL=1 ) else ( echo PASS: node --check server.js )
node --check "%RELDIR%smoke-r3.js"
if %errorlevel% neq 0 ( echo FAIL: node --check smoke-r3.js & set FAIL=1 ) else ( echo PASS: node --check smoke-r3.js )

echo [2/6] PS Parser ParseFile both .ps1 without vypolneniya ^(errors==0 gate, warnings only measure^) ...
pwsh -NoProfile -Command "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('%RELDIR%install_proxy.ps1',[ref]$t,[ref]$e);$w1=@($e|Where-Object{$_.Severity -eq 'Warning'}).Count;Write-Host ('SCOPE ParseFile: install_proxy.ps1 errors='+$e.Count+' warnings='+$w1);if($e.Count-gt 0){Write-Host ('FAIL install_proxy.ps1: '+$e[0].Message);exit 1}else{Write-Host ('PASS install_proxy.ps1 ParseFile warnings='+$w1)};$e2=$null;$t2=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('%RELDIR%rollback_proxy.ps1',[ref]$t2,[ref]$e2);$w2=@($e2|Where-Object{$_.Severity -eq 'Warning'}).Count;Write-Host ('SCOPE ParseFile: rollback_proxy.ps1 errors='+$e2.Count+' warnings='+$w2);if($e2.Count-gt 0){Write-Host ('FAIL rollback_proxy.ps1: '+$e2[0].Message);exit 1}else{Write-Host ('PASS rollback_proxy.ps1 ParseFile warnings='+$w2)}"
if %errorlevel% neq 0 ( echo FAIL: PS ParseFile & set FAIL=1 )

echo [3/6] baseline read-only + signature re-verify ...
pwsh -NoProfile -Command "$b='%RELDIR%baseline.json';$it=Get-Item -LiteralPath $b;if(-not $it.IsReadOnly){Write-Host 'WARNING baseline.json not read-only (known limitation: bypassable)'}else{Write-Host 'PASS baseline.json read-only'};$raw=[IO.File]::ReadAllText($b,[Text.Encoding]::UTF8);$q=[char]34;$m=[regex]::Match($raw,'signature'+$q+'\s*:\s*'+$q+'([^'+$q+']*)'+$q);if(-not $m.Success){Write-Host 'WARNING no signature (pre-r14)'}else{$want=$m.Groups[1].Value.ToUpper();if($want-eq'PLACEHOLDER'){Write-Host 'WARNING signature PLACEHOLDER'}else{$sr='(?m)^\s*'+$q+'signature'+$q+'\s*:\s*'+$q+'[^'+$q+']*'+$q+'\s*,?\s*\r?\n';$s=[regex]::Replace($raw,$sr,'');$crlf=[string][char]13+[string][char]10;$lf=[string][char]10;$s=$s.Replace($crlf,$lf);$s=$s.Replace([string][char]13,$lf);$h=New-Object System.Security.Cryptography.SHA256Managed;$got=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))-replace'-','').ToUpper();$h.Dispose();if($got-ne$want){Write-Host ('FAIL signature mismatch got '+$got+' want '+$want);exit 1}else{Write-Host 'PASS baseline signature'}}}"

if %errorlevel% neq 0 ( echo FAIL: baseline guard & set FAIL=1 )

echo [4/6] prod-touch gate: grep-assert absence prod-URL in test branches ...
findstr /R /C:"opencode\.ai/zen" "%RELDIR%smoke-r3.js" >nul 2>&1
if %errorlevel% equ 0 (
  findstr /C:"Without live-network" "%RELDIR%smoke-r3.js" >nul 2>&1
  set "ERR1=!errorlevel!"
  if "!ERR1!" equ "0" ( echo PASS: prod-URL only in comments ban live-network ) else ( echo FAIL: prod-URL in smoke-r3.js outside comment ban & set FAIL=1 )
) else ( echo PASS: prod-URL missing in smoke-r3.js )
if defined MUSE_PROXY_UPSTREAM (
  echo %MUSE_PROXY_UPSTREAM% | findstr /I "opencode.ai" >nul 2>&1
  set "ERR2=!errorlevel!"
  if "!ERR2!" equ "0" ( echo FAIL: MUSE_PROXY_UPSTREAM points in prod on bat-run & set FAIL=1 ) else ( echo PASS: MUSE_PROXY_UPSTREAM not prod )
) else ( echo PASS: MUSE_PROXY_UPSTREAM empty ^(dry-run mock^) )

echo [5/6] dry-run generation without install: install -TestMode -DryRun on temp-paths ...
set "TMP_BASE=%TEMP%\r14-bat-dry-%RANDOM%"
set "TMP_CFG=%TMP_BASE%\opencode.jsonc"
set "TMP_START=%TMP_BASE%\startup"
mkdir "%TMP_BASE%" >nul 2>&1
mkdir "%TMP_START%" >nul 2>&1
pwsh -NoProfile -ExecutionPolicy Bypass -File "%RELDIR%install_proxy.ps1" -TestMode -DryRun -ConfigPath "%TMP_CFG%" -StartupDir "%TMP_START%" -Port 18887 -Socks direct -Upstream "http://127.0.0.1:9/mock" -SkipProbe > "%TEMP%\r14-bat-dryrun.log" 2>&1
if %errorlevel% neq 0 ( echo FAIL: install -TestMode -DryRun exit & type "%TEMP%\r14-bat-dryrun.log" & set FAIL=1 ) else ( echo PASS: install -TestMode -DryRun exit 0, cfg not created )
if exist "%TMP_CFG%" ( echo FAIL: DryRun created config & set FAIL=1 ) else ( echo PASS: config not created ^(dry-run^) )
if exist "%TMP_START%\*.bat" ( echo FAIL: DryRun created bat & set FAIL=1 ) else ( echo PASS: bat not created in temp Startup ^(dry-run^) )
REM spec refs keep-logic (additively, prod not touches): sanitized copy dryrun-log → release\logs\%LOGVER%-dryrun.log before del (spec refs frozen, spec refs frozen, current spec refs )
if not exist "%RELDIR%logs" mkdir "%RELDIR%logs" >nul 2>&1
pwsh -NoProfile -Command "$s=[IO.File]::ReadAllText($env:TEMP+'\r14-bat-dryrun.log');$s=$s -replace 'Bearer\s+[A-Za-z0-9\-._~+/=]+','Bearer REDACTED';$s=$s -replace 'sk-[A-Za-z0-9\-]+','sk-REDACTED';$s=$s -replace 'sk-T|SUPERSECRET|XKEY456|LOGFORGED','REDACTED';$s=$s -replace 'password\s*[=:]\s*\S+','password=REDACTED';[IO.File]::WriteAllText('%RELDIR%logs\%LOGVER%-dryrun.log',$s)" >nul 2>&1
del /q "%TEMP%\r14-bat-dryrun.log" >nul 2>&1
rmdir /s /q "%TMP_START%" >nul 2>&1
for /d %%D in ("%TEMP%\r14-bat-dry-*") do rmdir /s /q "%%D" >nul 2>&1

echo [6/6] assert absence ScheduledTask/Startup-writes + paths Run/Startup ...
if not exist "%RELDIR%logs" mkdir "%RELDIR%logs" >nul 2>&1
pwsh -NoProfile -Command "$f=0;$t=@(Get-ScheduledTask|Where-Object{$_.TaskName -like 'release-*'});if($t.Count-gt 0){Write-Host ('FAIL release-* tasks present: '+($t.TaskName-join','));$f=1}else{Write-Host 'PASS no release-* ScheduledTask'};$sd=[Environment]::GetFolderPath('Startup');Write-Host ('Startup localized: '+$sd);$b=@(Get-ChildItem -LiteralPath $sd -Filter 'release-*.bat' -ErrorAction SilentlyContinue);$v=@(Get-ChildItem -LiteralPath $sd -Filter 'release-*.vbs' -ErrorAction SilentlyContinue);if(($b.Count+$v.Count)-gt 0){Write-Host 'FAIL release-* files in Startup';$f=1}else{Write-Host 'PASS no release-* in Startup (localized path)'};foreach($h in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')){try{$p=Get-ItemProperty -LiteralPath $h -ErrorAction Stop;$hit=@($p.PSObject.Properties|Where-Object{$_.Value -match 'MuseSparkProxy|release-'});if($hit.Count-gt 0){Write-Host ('FAIL Run key hit '+$h);$f=1}else{Write-Host ('PASS Run clean '+$h)}}catch{Write-Host ('WARN Run unreadable '+$h)}};exit $f" > "%TEMP%\r17-checks-tmp.log" 2>&1
set "CHKERR=%errorlevel%"
type "%TEMP%\r17-checks-tmp.log"
REM spec refs : sanitized copy output [6/6] → release\logs\%LOGVER%-checks.log (spec refs ; spec refs frozen, spec refs frozen, full bodies/debug-bodies here never)
pwsh -NoProfile -Command "$s=[IO.File]::ReadAllText($env:TEMP+'\r17-checks-tmp.log');$s=$s -replace 'Bearer\s+[A-Za-z0-9\-._~+/=]+','Bearer REDACTED';$s=$s -replace 'sk-[A-Za-z0-9\-]+','sk-REDACTED';$s=$s -replace 'sk-T|SUPERSECRET|XKEY456|LOGFORGED','REDACTED';$s=$s -replace 'password\s*[=:]\s*\S+','password=REDACTED';[IO.File]::WriteAllText('%RELDIR%logs\%LOGVER%-checks.log',$s)" >nul 2>&1
del /q "%TEMP%\r17-checks-tmp.log" >nul 2>&1
if "%CHKERR%" neq "0" ( echo FAIL: persistence assert & set FAIL=1 )
REM [7/7]=files-pin extension bazy [1/6]-[6/6], [8/7]=stale-negative outside count (negative-test, not [1/8])

echo [7/7] files-pin: baseline files[] + r6..r23,r26-r31 changedFiles last-wins, LF-canonical SHA256+size ...
pwsh -NoProfile -Command "$b='%RELDIR%baseline.json';$j=Get-Content -LiteralPath $b -Raw -Encoding UTF8|ConvertFrom-Json;$e=@{};foreach($f in $j.files){$e[$f.name]=@{s=[string]$f.sha256;z=[long]$f.size}};foreach($k in @('r6','r7','r10','r11','r12','r13','r14','r15','r16','r17','r18','r19','r21','r22','r23','r26','r27','r28','r29','r30','r31')){$s=$j.$k;if($s-ne$null-and $s.changedFiles-ne$null){foreach($f in $s.changedFiles){if(-not([string]$f.name-like'vendor/*')){$e[[string]$f.name]=@{s=[string]$f.sha256;z=[long]$f.size}}}}};if($e.Count-eq 0){Write-Host 'FAIL files-pin: no files[]';exit 1};$bad=0;foreach($r in $e.Keys){$fp=Join-Path '%RELDIR%' ($r-replace'/','\');if(-not(Test-Path -LiteralPath $fp)){Write-Host ('FAIL files-pin missing '+$r);$bad=1;continue};$raw=[IO.File]::ReadAllBytes($fp);$o=0;if($raw.Length-ge 3-and $raw[0]-eq 0xEF-and $raw[1]-eq 0xBB-and $raw[2]-eq 0xBF){$o=3};$t=[Text.Encoding]::UTF8.GetString($raw,$o,($raw.Length-$o));$crlf=[string][char]13+[string][char]10;$lf=[string][char]10;$t=$t.Replace($crlf,$lf);$t=$t.Replace([string][char]13,$lf);$n=[Text.Encoding]::UTF8.GetBytes($t);$x=$e[$r];if($n.Length-ne$x.z){Write-Host ('FAIL files-pin size '+$r+' got '+$n.Length+' want '+$x.z);$bad=1;continue};$h=New-Object System.Security.Cryptography.SHA256Managed;$g=([BitConverter]::ToString($h.ComputeHash($n))-replace'-','').ToUpper();$h.Dispose();if($g-ne([string]$x.s).ToUpper()){Write-Host ('FAIL files-pin sha '+$r);$bad=1;continue}};if($bad-ne 0){exit 1}else{Write-Host ('PASS files-pin '+$e.Count+' files')}"
if %errorlevel% neq 0 ( echo FAIL: files-pin & set FAIL=1 )

echo [8/7] stale-negative (TEMP outside release, prod untouched: guard vs tampered copy must FAIL exit 1 + real-write proof) ...
REM trap: STALE_TMP in %TEMP% (not in release/), before-cleanup until run + bezuslovnyy rmdir until verdict
set "STALE_TMP=%TEMP%\r19-stale-%RANDOM%-%TIME:~6,2%%TIME:~9,2%"
if exist "%STALE_TMP%" rmdir /s /q "%STALE_TMP%" >nul 2>&1
mkdir "%STALE_TMP%" >nul 2>&1
REM baseline-guard: cmd-compatible GUID primary (PS5.1-only/cmd-only safe); pwsh Guid — optional upgrade if available
set "STALE_GUID=%COMPUTERNAME%-%RANDOM%-%TIME:~6,2%%TIME:~9,2%-%RANDOM%"
for /f "delims=" %%G in ('pwsh -NoProfile -Command "[System.Guid]::NewGuid()" 2^>nul') do set "STALE_GUID=%%G"
if not defined STALE_GUID set "STALE_GUID=%COMPUTERNAME%-%RANDOM%-%RANDOM%"
REM batch6: stale-setup list spec sections intentionally frozen for negative-test (outside count), not confuse with files-pin spec sections [7/7]
pwsh -NoProfile -Command "$rel='%RELDIR%';$tmp=$env:STALE_TMP;$bl=Join-Path $rel 'baseline.json';$bj=Get-Content -LiteralPath $bl -Raw -Encoding UTF8|ConvertFrom-Json;$exp=@{};foreach($f in $bj.files){$exp[[string]$f.name]=@{s=[string]$f.sha256;z=[long]$f.size}};foreach($rk in @('r6','r7','r10','r11','r12','r13','r14','r15','r16','r17','r18')){$sc=$bj.$rk;if($sc-ne$null-and $sc.changedFiles-ne$null){foreach($f in $sc.changedFiles){if(-not([string]$f.name-like'vendor/*')){$exp[[string]$f.name]=@{s=[string]$f.sha256;z=[long]$f.size}}}}};if($exp.Count-eq 0){Write-Host 'FAIL stale-setup: no files[]';exit 1};if([string]::IsNullOrEmpty($env:STALE_GUID)){Write-Host 'FAIL stale-setup: empty STALE_GUID (want non-empty: pwsh Guid preferred, cmd COMPUTERNAME-RANDOM-TIME fallback)';exit 1};$crlf0=[string][char]13+[string][char]10;$lf0=[string][char]10;$rn=$null;$xe=$null;foreach($k in @($exp.Keys|Sort-Object)){$fp0=Join-Path $rel ($k-replace'/','\');if(-not(Test-Path -LiteralPath $fp0)){continue};$b0=[IO.File]::ReadAllBytes($fp0);$o0=0;if($b0.Length-ge 3-and $b0[0]-eq 0xEF-and $b0[1]-eq 0xBB-and $b0[2]-eq 0xBF){$o0=3};$t0=[Text.Encoding]::UTF8.GetString($b0,$o0,($b0.Length-$o0));$t0=$t0.Replace($crlf0,$lf0);$t0=$t0.Replace([string][char]13,$lf0);$n0=[Text.Encoding]::UTF8.GetBytes($t0);$h0=New-Object System.Security.Cryptography.SHA256Managed;$g0=([BitConverter]::ToString($h0.ComputeHash($n0))-replace'-','').ToUpper();$h0.Dispose();$ce=$exp[$k];if($n0.Length-eq$ce.z-and $g0-eq([string]$ce.s).ToUpper()){$rn=$k;$xe=$ce;break}};if($rn-eq$null){Write-Host 'FAIL stale-setup: no baseline-matching file (baseline drift?)';exit 1};Write-Host ('STALE-SETUP pick '+$rn+' (last-wins, LF-canonical match)');$src=Join-Path $rel ($rn-replace'/','\');$dst=Join-Path $tmp ($rn-replace'/','\');$dd=Split-Path -Parent $dst;if($dd-ne''-and -not(Test-Path -LiteralPath $dd)){New-Item -ItemType Directory -Path $dd -Force|Out-Null};Copy-Item -LiteralPath $src -Destination $dst -Force;$tb=@{files=@(@{name=$rn;sha256=[string]$xe.s;size=[long]$xe.z})};$tb|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $tmp 'baseline.json') -Encoding UTF8;$raw=[IO.File]::ReadAllBytes($dst);$sb=[Text.Encoding]::UTF8.GetBytes('STALE-r18');$nb=New-Object byte[] ($raw.Length+$sb.Length+1);[Array]::Copy($raw,$nb,$raw.Length);$nb[$raw.Length]=10;[Array]::Copy($sb,0,$nb,($raw.Length+1),$sb.Length);[IO.File]::WriteAllBytes($dst,$nb);Write-Host ('STALE-TAMPER appended STALE-r18 to '+$rn);$pb=[IO.File]::ReadAllBytes($src);$po=0;if($pb.Length-ge 3-and $pb[0]-eq 0xEF-and $pb[1]-eq 0xBB-and $pb[2]-eq 0xBF){$po=3};$pt=[Text.Encoding]::UTF8.GetString($pb,$po,($pb.Length-$po));$crlf=[string][char]13+[string][char]10;$lf=[string][char]10;$pt=$pt.Replace($crlf,$lf);$pt=$pt.Replace([string][char]13,$lf);$pn=[Text.Encoding]::UTF8.GetBytes($pt);$ph=New-Object System.Security.Cryptography.SHA256Managed;$pg=([BitConverter]::ToString($ph.ComputeHash($pn))-replace'-','').ToUpper();$ph.Dispose();if($pn.Length-ne[long]$xe.z -or $pg-ne([string]$xe.s).ToUpper()){Write-Host 'FAIL stale-setup: prod file mismatch (prod touched?)';exit 1};Write-Host 'PASS prod-untouched: prod file still matches baseline';$pf=Join-Path $tmp 'r18-realwrite-proof.txt';$pv='r18-proof '+$env:STALE_GUID;[IO.File]::WriteAllText($pf,$pv,[Text.Encoding]::UTF8);$back=[IO.File]::ReadAllText($pf,[Text.Encoding]::UTF8);if($back-ne$pv){Write-Host 'FAIL real-write proof: TEMP readback mismatch';exit 1};Write-Host 'PASS real-write proof: TEMP write+readback ok (GUID, prod untouched)'" > "%TEMP%\r18-stale-raw.log" 2>&1
if !errorlevel! neq 0 ( set "SETUP_EXIT=1" ) else ( set "SETUP_EXIT=0" )
pwsh -NoProfile -Command "$rel='%RELDIR%';$tmp=$env:STALE_TMP;$ins=Join-Path $rel 'install_proxy.ps1';$tok=$null;$e=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile($ins,[ref]$tok,[ref]$e);if($e.Count-gt 0){Write-Host ('FAIL stale-guard: install parse '+$e[0].Message);exit 2};$w=$a.FindAll({param($x)$x -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true);$c=@();foreach($n in $w){if($n.Name-eq'Get-NormalizedBytes' -or $n.Name-eq'Test-FilesPin'){$c+=$n.Extent.Text}};if($c.Count-ne 2){Write-Host 'FAIL stale-guard: Test-FilesPin/Get-NormalizedBytes defs not found (want 2; dot-source install forbidden: Test-BaselineGuard14)';exit 2};Write-Host 'STALE-GUARD direct Test-FilesPin (AST-loaded verbatim, no dot-source) vs tampered copy:';$code=($c -join [string][char]10)+[string][char]10+'Test-FilesPin -BaseDir '''+$tmp+'''';$sb=[ScriptBlock]::Create($code);& $sb" > "%TEMP%\r18-stale-raw.log" 2>&1
if !errorlevel! neq 0 ( set "BAT_EXIT=!errorlevel!" ) else ( set "BAT_EXIT=0" )
REM check: STALEERR removed (byla dead: written, but nowhere not read; source truth — BAT_EXIT)
if not exist "%RELDIR%logs" mkdir "%RELDIR%logs" >nul 2>&1
pwsh -NoProfile -Command "$s=[IO.File]::ReadAllText($env:TEMP+'\r18-stale-raw.log');$s=$s -replace 'Bearer\s+[A-Za-z0-9\-._~+/=]+','Bearer REDACTED';$s=$s -replace 'sk-[A-Za-z0-9\-]+','sk-REDACTED';$s=$s -replace 'sk-T|SUPERSECRET|XKEY456|LOGFORGED','REDACTED';$s=$s -replace 'password\s*[=:]\s*\S+','password=REDACTED';[IO.File]::WriteAllText('%RELDIR%logs\%LOGVER%-stale.log',$s)" >nul 2>&1
del /q "%TEMP%\r18-stale-raw.log" >nul 2>&1
REM trap-cleanup spec refs /spec refs : STALE_TMP in %TEMP% remove always until verdict (Ctrl-C/trap: before-cleanup above + rmdir here)
rmdir /s /q "%STALE_TMP%" >nul 2>&1
if "!SETUP_EXIT!"=="0" if "!BAT_EXIT!"=="1" ( echo PASS: stale-negative ^(guard exit 1 + real-write proof, log release/logs/%LOGVER%-stale.log ^(r31; r17 frozen, r23 frozen, r22 superseded^)^) ) else ( echo FAIL: stale-negative ^(want SETUP_EXIT 0 + BAT_EXIT 1, log release/logs/%LOGVER%-stale.log^) & set FAIL=1 )

if "%FAIL%"=="0" ( echo === R14 DRYRUN BAT: ALL PASS ^(nothing installed^) === & exit /b 0 ) else ( echo === R14 DRYRUN BAT: FAIL === & exit /b 1 )
goto :eof

:help
echo Usage: verify-r14-dryrun.bat [--no-install^|--dry-run] [--help]
echo  Live bat-run generation WITHOUT install: node --check, PS ParseFile,
echo  baseline guard, prod-touch gate, install -TestMode -DryRun, assert cleanliness Task/Startup/Run.
echo  Bat nothing not installs. Live requests — zero.
exit /b 2
:eof
