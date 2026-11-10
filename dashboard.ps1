#Requires -Version 5.1
<#
.SYNOPSIS
  Starts, stops and sets up the PhotoSort dashboard. Everything stays on this PC.

.DESCRIPTION
  start (default)  set up what is missing (asks first), start the server and open the window
  stop             close the window and stop the server (a running job is never killed)
  restart          stop, then start
  status           running or not, versions and PAIR state (no file names or paths)
  open             open the window for a running server
  setup            install or update what the dashboard needs, without starting it
  selftest         fixture mode only: prove the window's network guard, token handling and GPU, then quit

  Real mode shows your library. -Fixture uses synthetic data, a fake PAIR proxy and its own data folder and port;
  coding agents and tests use fixture mode only.

.EXAMPLE
  .\dashboard.ps1
.EXAMPLE
  .\dashboard.ps1 stop
.EXAMPLE
  .\dashboard.ps1 start -Fixture -NoOpen
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'open', 'setup', 'selftest')]
    [string]$Command = 'start',
    [int]$Port = 0,
    [switch]$NoOpen,
    [switch]$Fixture,
    [switch]$Yes,
    [switch]$LeaveJobRunning,
    [switch]$Force,
    [switch]$Rebuild,
    [switch]$Update,
    [switch]$UseSystemNode,
    [string]$Python = '',
    [ValidateSet('auto', 'rtx', 'igpu')]
    [string]$Gpu = 'auto'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 1

$NodeMajor = 26
$PhotoSortDir = $PSScriptRoot
$DashDir = Join-Path $PhotoSortDir 'dashboard'
$AppRoot = Join-Path $env:LOCALAPPDATA 'PhotoSort'
$RuntimeDir = Join-Path $AppRoot 'runtime'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if ($Fixture) {
    $Mode = 'fixture'
    $DataDir = Join-Path $AppRoot 'dashboard-fixture'
    $ConfigPath = Join-Path $DashDir 'fixtures\config.fixture.json'
    $DefaultPort = 47616
} else {
    $Mode = 'real'
    $DataDir = Join-Path $AppRoot 'dashboard'
    $ConfigPath = Join-Path $PhotoSortDir 'config.json'
    $DefaultPort = 47615
}
$StatePath = Join-Path $DataDir 'state.json'
$ShellStatePath = Join-Path $DataDir 'shell.json'
$LogDir = Join-Path $DataDir 'logs'
$ElectronExe = Join-Path $DashDir 'node_modules\electron\dist\electron.exe'

# ---------------------------------------------------------------- output (agent-safe: no user paths or names)

function Hide-Paths([string]$s) {
    if (-not $s) { return '' }
    return $s.Replace($env:LOCALAPPDATA, '%LOCALAPPDATA%').Replace($env:USERPROFILE, '%USERPROFILE%')
}
function Say([string]$msg) { Write-Host (Hide-Paths $msg) }
function Warn([string]$msg) { Write-Host ('Warning: ' + (Hide-Paths $msg)) -ForegroundColor Yellow }
function Fail([string]$msg, [int]$code = 1) {
    $e = New-Object System.Exception($msg)
    $e.Data['exit'] = $code
    throw $e
}
function Format-Seconds($sw) { return ('{0:0.0} s' -f $sw.Elapsed.TotalSeconds) }
function Format-Uptime([double]$s) {
    if ($s -lt 60) { return ('{0:0} s' -f $s) }
    if ($s -lt 3600) { return ('{0} min' -f [Math]::Floor($s / 60)) }
    return ('{0} h {1} min' -f [Math]::Floor($s / 3600), [Math]::Floor(($s % 3600) / 60))
}

function Confirm-Step([string]$question) {
    if ($Yes) { return $true }
    if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
        Say "$question -> not done: nobody to ask here. Rerun with -Yes to allow it."
        return $false
    }
    $a = Read-Host "$question [Y/n]"
    return ($a -eq '' -or $a -match '^(y|yes)$')
}

# ---------------------------------------------------------------- helpers

function ConvertTo-Arg([string]$a) {
    if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { return $a }
    $e = $a -replace '(\\*)"', '$1$1\"'
    $e = $e -replace '(\\+)$', '$1$1'
    return '"' + $e + '"'
}
function Join-Args([string[]]$argv) { return (($argv | ForEach-Object { ConvertTo-Arg $_ }) -join ' ') }

function Invoke-Capture([string]$exe, [string[]]$argv, [string]$cwd = $PhotoSortDir) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = Join-Args $argv
    $psi.WorkingDirectory = $cwd
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    return @{ Code = $p.ExitCode; Out = $out.Result; Err = $err.Result }
}

function New-SetupLog {
    $null = New-Item -ItemType Directory -Force -Path $LogDir
    return (Join-Path $LogDir ('setup-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date)))
}

function Invoke-Logged([string]$exe, [string[]]$argv, [string]$cwd, [string]$log) {
    $r = Invoke-Capture $exe $argv $cwd
    $head = '> ' + (Split-Path -Leaf $exe) + ' ' + (Join-Args $argv) + "  (exit $($r.Code))"
    Add-Content -LiteralPath $log -Value @($head, $r.Out, $r.Err) -Encoding UTF8
    return $r.Code
}

function Write-JsonFile([string]$path, $obj) {
    $tmp = "$path.tmp"
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 5), $Utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Test-UnderOneDrive([string]$p) {
    $t = ([IO.Path]::GetFullPath($p)).TrimEnd('\').ToLowerInvariant() + '\'
    foreach ($k in @('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial')) {
        $root = [Environment]::GetEnvironmentVariable($k)
        if ($root -and $t.StartsWith(([IO.Path]::GetFullPath($root)).TrimEnd('\').ToLowerInvariant() + '\')) { return $true }
    }
    return $false
}

function Test-Loopback([string]$url) {
    try { $u = [Uri]$url } catch { return $false }
    $h = $u.Host.Trim('[', ']')
    return ($u.Scheme -eq 'http' -and ($h -eq 'localhost' -or $h -eq '::1' -or $h -match '^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$'))
}

function New-HttpClient([int]$timeoutS) {
    Add-Type -AssemblyName System.Net.Http
    $h = New-Object System.Net.Http.HttpClientHandler
    $h.UseProxy = $false
    $c = New-Object System.Net.Http.HttpClient($h)
    $c.Timeout = [TimeSpan]::FromSeconds($timeoutS)
    return $c
}

function Invoke-Server($st, [string]$method, [string]$path, [string]$body = '', [int]$timeoutS = 5) {
    $c = New-HttpClient $timeoutS
    try {
        $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($method)), "http://127.0.0.1:$($st.port)$path")
        if ($st.token) { $null = $req.Headers.TryAddWithoutValidation('X-PhotoSort-Token', [string]$st.token) }
        if ($body) { $req.Content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json') }
        $res = $c.SendAsync($req).GetAwaiter().GetResult()
        return @{ Status = [int]$res.StatusCode; Body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
    } catch {
        return @{ Status = 0; Body = '' }
    } finally {
        $c.Dispose()
    }
}

# ---------------------------------------------------------------- process checks

function ConvertTo-UtcDate($v) {
    if ($v -is [datetime]) { return $v.ToUniversalTime() }
    return [DateTime]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

# True only for the exact process we started: same executable, same creation time and (for the server) our nonce
# on its command line, so a reused PID is never mistaken for ours.
function Test-OwnProcess($procId, [string]$exe, $startUtc, [string]$needle) {
    if (-not $procId -or -not $exe -or -not $startUtc) { return $false }
    $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$([int]$procId)" -ErrorAction SilentlyContinue
    if (-not $p -or -not $p.ExecutablePath -or $p.ExecutablePath -ne $exe) { return $false }
    try { $delta = [Math]::Abs(($p.CreationDate.ToUniversalTime() - (ConvertTo-UtcDate $startUtc)).TotalSeconds) } catch { return $false }
    if ($delta -gt 3) { return $false }
    if ($needle -and ($p.CommandLine -notlike "*$needle*")) { return $false }
    return $true
}

function Get-RunningServer([string]$dataDir = $DataDir) {
    $st = Read-JsonFile (Join-Path $dataDir 'state.json')
    if (-not $st -or -not $st.running) { return $null }
    if (Test-OwnProcess $st.pid $st.nodePath $st.startTimeUtc $st.nonce) { return $st }
    return $null
}

function Clear-StaleState {
    $s = Read-JsonFile $StatePath
    if ($s -and $s.running) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        Say 'Removed the state of a server that is no longer running.'
    }
}

function Wait-ProcessGone([int]$procId, [double]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 100
    }
    return (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue))
}

function Get-OpenShell {
    $sh = Read-JsonFile $ShellStatePath
    if ($sh -and (Test-OwnProcess $sh.pid $sh.exe $sh.startTimeUtc '')) { return $sh }
    return $null
}

function Stop-Shell([double]$waitS) {
    $sh = Get-OpenShell
    if ($sh -and -not (Wait-ProcessGone $sh.pid $waitS)) {
        if (Test-OwnProcess $sh.pid $sh.exe $sh.startTimeUtc '') { Stop-Process -Id ([int]$sh.pid) -Force }
    }
    Remove-Item -LiteralPath $ShellStatePath -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- setup steps

function Get-NodeVersion([string]$exe) { return (Invoke-Capture $exe @('--version')).Out.Trim() }

function Find-PrivateNode {
    if (-not (Test-Path -LiteralPath $RuntimeDir)) { return $null }
    $dirs = @(Get-ChildItem -LiteralPath $RuntimeDir -Directory | Where-Object {
            $_.Name -match "^node-v$NodeMajor\.\d+\.\d+-win-x64$" -and (Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe')) })
    if ($dirs.Count -eq 0) { return $null }
    $best = $dirs | Sort-Object { [version]($_.Name -replace '^node-v', '' -replace '-win-x64$', '') } -Descending | Select-Object -First 1
    return (Join-Path $best.FullName 'node.exe')
}

function Install-PrivateNode {
    if (-not (Confirm-Step "Download Node.js $NodeMajor LTS (about 35 MB) from nodejs.org for the dashboard only? Your system Node.js is not changed.")) {
        Fail 'The dashboard needs Node.js. Rerun and answer yes, or use -UseSystemNode.' 2
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
        $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    } catch {
        Fail 'Could not reach nodejs.org. Connect to the internet once to install the dashboard.' 2
    }
    $rel = $index | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
    if (-not $rel) { Fail "No Node.js $NodeMajor LTS release for Windows x64 was found." 2 }
    $v = $rel.version
    $zipName = "node-$v-win-x64.zip"
    $base = "https://nodejs.org/dist/$v"
    $sums = [string](Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -TimeoutSec 30).Content
    $want = $null
    foreach ($line in ($sums -split "`n")) {
        if ($line -match ('^([0-9a-f]{64})\s+' + [regex]::Escape($zipName) + '\s*$')) { $want = $Matches[1] }
    }
    if (-not $want) { Fail 'The Node.js checksum list has no entry for the download.' 1 }
    $null = New-Item -ItemType Directory -Force -Path $RuntimeDir
    $tag = [guid]::NewGuid().ToString('N')
    $tmpZip = Join-Path $RuntimeDir ".download-$tag.zip"
    $tmpDir = Join-Path $RuntimeDir ".extract-$tag"
    $target = Join-Path $RuntimeDir "node-$v-win-x64"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$zipName" -OutFile $tmpZip -TimeoutSec 600
        $hash = (Get-FileHash -LiteralPath $tmpZip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $want) { Fail 'The Node.js download failed its checksum; nothing was installed.' 1 }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($tmpZip, $tmpDir)
        Move-Item -LiteralPath (Join-Path $tmpDir "node-$v-win-x64") -Destination $target
    } finally {
        Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Say "Node.js $v installed in $(Format-Seconds $sw) (checksum verified)."
    return (Join-Path $target 'node.exe')
}

function Get-Node {
    if ($UseSystemNode) {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { Fail 'No system Node.js on PATH.' 2 }
        $ver = Get-NodeVersion $cmd.Path
        $major = [int]($ver.TrimStart('v').Split('.')[0])
        if ($major -lt 24 -or $major -gt 26) { Fail "System Node.js $ver is not supported (24 to 26 are)." 2 }
        if ($major % 2 -eq 1) {
            Warn "System Node.js $ver is not a long-term-support release."
            if (-not (Confirm-Step 'Use it anyway?')) { Fail 'Stopped.' 2 }
        }
        return $cmd.Path
    }
    $n = Find-PrivateNode
    if (-not $n) { $n = Install-PrivateNode }
    return $n
}

function Get-NpmCli([string]$node) {
    $cli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $cli)) { Fail 'npm was not found next to node.exe.' 2 }
    return $cli
}

function Get-ElectronVersion {
    $pkg = Read-JsonFile (Join-Path $DashDir 'node_modules\electron\package.json')
    if ($pkg) { return [string]$pkg.version }
    return 'not installed'
}

function Assert-NothingRunning([string]$what) {
    foreach ($d in @((Join-Path $AppRoot 'dashboard'), (Join-Path $AppRoot 'dashboard-fixture'))) {
        if (Get-RunningServer $d) { Fail "The dashboard is running; stop it before $what (dashboard.ps1 stop, with -Fixture for fixture mode)." 1 }
    }
}

function Install-Packages([string]$node) {
    $lock = Join-Path $DashDir 'package-lock.json'
    $marker = Join-Path $DashDir 'node_modules\.photosort-lock.sha256'
    $want = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
    if ((Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath $ElectronExe) -and
        ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $want)) { return }
    Assert-NothingRunning 'its packages are installed'
    if (-not (Confirm-Step 'Install the dashboard packages (about 500 MB including Electron) from npm and GitHub?')) {
        Fail 'The dashboard needs its packages.' 2
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $log = New-SetupLog
    $npm = Get-NpmCli $node
    $code = Invoke-Logged $node @($npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=warn') $DashDir $log
    if ($code -ne 0) { Fail "Installing packages failed (npm exit $code). Check the internet connection. Log: $log" 2 }
    $code = Invoke-Logged $node @((Join-Path $DashDir 'node_modules\electron\install.js')) $DashDir $log
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $ElectronExe)) { Fail "Downloading Electron failed. Log: $log" 2 }
    [IO.File]::WriteAllText($marker, $want, $Utf8NoBom)
    Say "Packages installed in $(Format-Seconds $sw) (Electron $(Get-ElectronVersion))."
}

function Update-Electron([string]$node) {
    $npm = Get-NpmCli $node
    $r = Invoke-Capture $node @($npm, 'view', 'electron', 'version') $DashDir
    if ($r.Code -ne 0) { Warn 'Could not check for a newer Electron (offline?).'; return }
    $latest = $r.Out.Trim()
    $current = Get-ElectronVersion
    if ($current -ne 'not installed' -and [version]$latest -le [version]$current) { Say "Electron $current is the latest."; return }
    if (-not (Confirm-Step "Update Electron $current to $latest? This changes package.json and package-lock.json.")) { return }
    Assert-NothingRunning 'Electron is updated'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $log = New-SetupLog
    $code = Invoke-Logged $node @($npm, 'install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', "electron@$latest") $DashDir $log
    if ($code -eq 0) { $code = Invoke-Logged $node @((Join-Path $DashDir 'node_modules\electron\install.js')) $DashDir $log }
    if ($code -ne 0) { Fail "Updating Electron failed. Log: $log" 2 }
    $hash = (Get-FileHash -LiteralPath (Join-Path $DashDir 'package-lock.json') -Algorithm SHA256).Hash
    [IO.File]::WriteAllText((Join-Path $DashDir 'node_modules\.photosort-lock.sha256'), $hash, $Utf8NoBom)
    Say "Electron updated to $latest in $(Format-Seconds $sw)."
}

function Get-WebHash {
    $web = Join-Path $DashDir 'web'
    $files = @(Get-ChildItem -LiteralPath (Join-Path $web 'src') -Recurse -File) +
        @(Get-Item -LiteralPath (Join-Path $web 'index.html'), (Join-Path $web 'vite.config.ts'), (Join-Path $DashDir 'package-lock.json'))
    $sb = New-Object System.Text.StringBuilder
    foreach ($f in ($files | Sort-Object FullName)) {
        $null = $sb.Append($f.FullName.Substring($DashDir.Length)).Append(':').Append((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash).Append("`n")
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sb.ToString()))) -replace '-', '') }
    finally { $sha.Dispose() }
}

function Build-Web([string]$node) {
    $marker = Join-Path $DashDir 'web\dist\.build.sha256'
    $want = Get-WebHash
    if (-not $Rebuild -and (Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $want)) { return }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $log = New-SetupLog
    $code = Invoke-Logged $node @((Join-Path $DashDir 'node_modules\vite\bin\vite.js'), 'build', '--config', 'web/vite.config.ts') $DashDir $log
    if ($code -ne 0) { Fail "Building the web app failed. Log: $log" 1 }
    [IO.File]::WriteAllText($marker, $want, $Utf8NoBom)
    Say "Web app built in $(Format-Seconds $sw)."
}

function Get-PythonPath {
    if ($Python) { return $Python }
    foreach ($line in (Get-Content -LiteralPath (Join-Path $PhotoSortDir 'photosort.cmd'))) {
        if ($line -match '^\s*set\s+"PY=(.+)"\s*$') { return [Environment]::ExpandEnvironmentVariables($Matches[1]) }
    }
    return (Join-Path $env:USERPROFILE 'miniconda3\envs\utils\python.exe')
}

function Test-Python([string]$py) {
    if (-not (Test-Path -LiteralPath $py)) { Fail 'The Python for PhotoSort was not found. Follow Setup in README.md, or pass -Python.' 2 }
    $req = Join-Path $PhotoSortDir 'requirements.txt'
    $key = $py + '|' + (Get-Item -LiteralPath $py).LastWriteTimeUtc.Ticks + '|' + (Get-FileHash -LiteralPath $req -Algorithm SHA256).Hash
    $cache = Join-Path $RuntimeDir 'python-check.json'
    $c = Read-JsonFile $cache
    if ($c -and $c.key -eq $key) { return [string]$c.version }
    $probe = @('-c', 'import sys, PIL, pillow_heif, av, numpy, requests; print(sys.version.split()[0])')
    $r = Invoke-Capture $py $probe
    if ($r.Code -ne 0) {
        if (-not (Confirm-Step 'Python packages PhotoSort needs are missing. Install them with pip from requirements.txt?')) {
            Fail 'Python packages are missing (see Setup in README.md).' 2
        }
        $log = New-SetupLog
        $code = Invoke-Logged $py @('-m', 'pip', 'install', '-r', $req) $PhotoSortDir $log
        $r = Invoke-Capture $py $probe
        if ($code -ne 0 -or $r.Code -ne 0) { Fail "Installing Python packages failed. Log: $log" 2 }
    }
    $null = New-Item -ItemType Directory -Force -Path $RuntimeDir
    Write-JsonFile $cache @{ key = $key; version = $r.Out.Trim() }
    return $r.Out.Trim()
}

function Build-Fixtures([string]$py) {
    $r = Invoke-Capture $py @((Join-Path $DashDir 'fixtures\make_fixtures.py'))
    if ($r.Code -ne 0) { Fail 'Building the fixture library failed.' 1 }
    Say ('Fixtures: ' + $r.Out.Trim())
}

function Show-PairCheck {
    $cfg = Read-JsonFile $ConfigPath
    if (-not $cfg) { Warn 'config.json could not be read.'; return }
    $base = [string]$cfg.base_url
    if (-not (Test-Loopback $base)) { Warn 'config.json base_url is not on this PC; PhotoSort refuses it.'; return }
    $c = New-HttpClient 3
    try {
        $json = $c.GetStringAsync($base.TrimEnd('/') + '/api/tags').GetAwaiter().GetResult()
        Say ('PAIR proxy reachable: {0} models.' -f @(($json | ConvertFrom-Json).models).Count)
    } catch {
        Warn 'PAIR proxy not reachable: start NVIDIA PAIR (sort, group, index and search need it).'
    } finally {
        $c.Dispose()
    }
}

function Invoke-Setup([switch]$Explicit) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if (Test-UnderOneDrive $AppRoot) { Fail 'LOCALAPPDATA is inside OneDrive. The dashboard keeps private data there, so it refuses to run.' 1 }
    $null = New-Item -ItemType Directory -Force -Path $LogDir
    $node = Get-Node
    $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
    Install-Packages $node
    if ($Update) { Update-Electron $node }
    Build-Web $node
    $py = Get-PythonPath
    $pyVersion = Test-Python $py
    if ($Fixture) { Build-Fixtures $py }
    if ($Explicit) {
        if (-not $Fixture) { Show-PairCheck }
        Say "Setup done in $(Format-Seconds $sw): Node.js $(Get-NodeVersion $node), Electron $(Get-ElectronVersion), Python $pyVersion."
    }
    return @{ Node = $node; Python = $py }
}

# ---------------------------------------------------------------- commands

function Test-PortFree([int]$p) {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    try { $l.Start(); return $true } catch { return $false } finally { try { $l.Stop() } catch { } }
}

function Select-Port {
    if ($Port -gt 0) {
        if (-not (Test-PortFree $Port)) { Fail "Port $Port is in use." 1 }
        return $Port
    }
    $avoid = @()
    $fx = Read-JsonFile (Join-Path $DashDir 'fixtures\config.fixture.json')
    if ($fx) { $avoid += ([Uri]$fx.base_url).Port }
    foreach ($p in $DefaultPort..($DefaultPort + 10)) {
        if ($avoid -notcontains $p -and (Test-PortFree $p)) { return $p }
    }
    Fail 'No free port near the default. Pass -Port.' 1
}

function Resolve-Gpu {
    if ($Gpu -ne 'auto') { return $Gpu }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $line = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus.ToString()
    } catch { $line = 'Unknown' }
    if ($line -eq 'Offline') { return 'igpu' }
    return 'rtx'
}

function Set-GpuPreference([string]$choice) {
    # Chromium has no GPU-choice switch on Windows; the per-app preference (Settings > Display > Graphics) decides.
    # It is set for the private electron.exe only and takes effect when the window starts.
    $key = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
    $value = @{ rtx = 'GpuPreference=2;'; igpu = 'GpuPreference=1;' }[$choice]
    try {
        if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }
        $null = New-ItemProperty -LiteralPath $key -Name $ElectronExe -Value $value -PropertyType String -Force
    } catch { Warn "Could not set the window's GPU preference: $($_.Exception.Message)" }
}

function Open-Shell($st) {
    if (-not (Test-Path -LiteralPath $ElectronExe)) { Fail 'Electron is not installed; run dashboard.ps1 setup.' 2 }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $already = Get-OpenShell
    $choice = Resolve-Gpu
    if (-not $already) { Set-GpuPreference $choice }
    $argv = @((Join-Path $DashDir 'shell'), '--state', $StatePath, '--gpu', $choice)
    $p = Start-Process -FilePath $ElectronExe -ArgumentList (Join-Args $argv) -WorkingDirectory $DashDir -PassThru
    if ($already) { Say 'The window was already open; brought it to the front.'; return }
    $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue
    if ($proc) {
        Write-JsonFile $ShellStatePath @{ pid = $p.Id; exe = $ElectronExe; startTimeUtc = $proc.CreationDate.ToUniversalTime().ToString('o'); gpu = $choice }
    }
    $label = @{ rtx = 'high-performance GPU (on AC power)'; igpu = 'power-saving GPU (on battery)' }[$choice]
    if ($Gpu -ne 'auto') { $label = "$choice (chosen with -Gpu)" }
    Say "Window opened; graphics on the $label."
}

function Start-Dashboard {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $st = Get-RunningServer
    if ($st) {
        Say "Already running ($Mode mode): http://127.0.0.1:$($st.port), pid $($st.pid)."
        if (-not $NoOpen) { Open-Shell $st }
        return 0
    }
    Clear-StaleState
    $envInfo = Invoke-Setup
    $p = Select-Port
    $nonce = [guid]::NewGuid().ToString('N')
    $argv = @((Join-Path $DashDir 'server\start.mjs'), '--mode', $Mode, '--port', "$p", '--data-dir', $DataDir,
        '--config', $ConfigPath, '--python', $envInfo.Python, '--photosort-dir', $PhotoSortDir, '--nonce', $nonce)
    $proc = Start-Process -FilePath $envInfo.Node -ArgumentList (Join-Args $argv) -WorkingDirectory $DashDir -WindowStyle Hidden -PassThru
    $st = $null
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $s = Read-JsonFile $StatePath
        if ($s -and $s.running -and $s.nonce -eq $nonce) { $st = $s; break }
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $st) { Fail "The server did not start. Its log is in $LogDir (server-crash.log or server-<date>.log)." 1 }
    $h = Invoke-Server $st 'GET' '/healthz'
    if ($h.Status -ne 200) { Fail "The server started but does not answer. Log: $LogDir" 1 }
    if (-not $NoOpen) { Open-Shell $st }
    Say "Started in $(Format-Seconds $sw) ($Mode mode): http://127.0.0.1:$p, pid $($st.pid)."
    return 0
}

function Stop-Dashboard {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $st = Get-RunningServer
    if (-not $st) {
        Clear-StaleState
        Stop-Shell 0
        Say "Not running ($Mode mode)."
        return 0
    }
    $job = 'refuse'
    if ($LeaveJobRunning) { $job = 'leave' }
    $r = Invoke-Server $st 'POST' '/api/shutdown' (@{ job = $job } | ConvertTo-Json -Compress)
    if ($r.Status -eq 409) {
        $info = ($r.Body | ConvertFrom-Json).job
        Say ('A {0} job is running ({1} of {2} done).' -f $info.kind, $info.done, $info.total)
        if ($Yes) { $job = 'cancel' }
        elseif ([Console]::IsInputRedirected) { Say 'Rerun with -Yes to cancel it gracefully, or -LeaveJobRunning.'; return 1 }
        else {
            $a = Read-Host '[C]ancel the job gracefully and stop, [L]eave the job running and stop the dashboard, or [A]bort'
            if ($a -match '^c') { $job = 'cancel' } elseif ($a -match '^l') { $job = 'leave' } else { Say 'Nothing stopped.'; return 1 }
        }
        $r = Invoke-Server $st 'POST' '/api/shutdown' (@{ job = $job } | ConvertTo-Json -Compress) 180
    }
    if ($r.Status -ne 200) { Warn "The server did not accept the stop request (HTTP $($r.Status))." }
    if (-not (Wait-ProcessGone $st.pid 10)) {
        if (-not ($Force -or (Confirm-Step 'The server did not stop within 10 s. End it now? A running job is never ended.'))) {
            Fail 'The server is still stopping. Run dashboard.ps1 stop -Force to end it.' 1
        }
        if (Test-OwnProcess $st.pid $st.nodePath $st.startTimeUtc $st.nonce) { Stop-Process -Id ([int]$st.pid) -Force }
        $null = Wait-ProcessGone $st.pid 5
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    }
    Stop-Shell 8
    Say "Stopped in $(Format-Seconds $sw) ($Mode mode)."
    return 0
}

function Show-Status {
    $st = Get-RunningServer
    if (-not $st) { Say "PhotoSort dashboard: not running ($Mode mode)."; return 3 }
    $m = $null
    $meta = Invoke-Server $st 'GET' '/api/meta'
    if ($meta.Status -eq 200) { $m = $meta.Body | ConvertFrom-Json }
    $health = Invoke-Server $st 'GET' '/api/health' '' 8
    $pair = $null
    if ($health.Status -eq 200) { $pair = ($health.Body | ConvertFrom-Json).pair }
    Say "PhotoSort dashboard: running ($Mode mode)"
    if ($m) { Say ("  Server:   http://127.0.0.1:{0}, pid {1}, up {2}, version {3}, Node.js {4}" -f $st.port, $st.pid, (Format-Uptime $m.uptimeS), $m.version, $m.node) }
    else { Say ("  Server:   http://127.0.0.1:{0}, pid {1}, not answering (HTTP {2})" -f $st.port, $st.pid, $meta.Status) }
    $window = 'closed'
    if (Get-OpenShell) { $window = 'open' }
    Say "  Window:   $window (Electron $(Get-ElectronVersion))"
    if (-not $pair) { Say '  PAIR:     unknown' }
    elseif ($pair.reachable) {
        $cloudNote = ''
        if ($pair.cloudModelsListed -gt 0) { $cloudNote = " ($($pair.cloudModelsListed) cloud, never used)" }
        Say ('  PAIR:     reachable in {0} ms, {1} models{2}' -f $pair.ms, $pair.models, $cloudNote)
        foreach ($x in @($pair.required)) {
            $s = 'ok'
            if ($x.cloud) { $s = 'CLOUD MODEL: refused' } elseif (-not $x.present) { $s = 'missing' }
            Say ('            {0} model {1}: {2}' -f $x.role, $x.name, $s)
        }
    } else { Say '  PAIR:     not reachable' }
    Say '  Jobs:     none (job support arrives in phase P1)'
    return 0
}

function Open-Window {
    $st = Get-RunningServer
    if (-not $st) { Say "Not running ($Mode mode). Start it with dashboard.ps1 start."; return 3 }
    Open-Shell $st
    return 0
}

function Invoke-SelfTest {
    if (-not $Fixture) { Fail 'selftest runs in fixture mode only: dashboard.ps1 selftest -Fixture' 1 }
    $st = Get-RunningServer
    if (-not $st) { Fail 'Start the fixture dashboard first: dashboard.ps1 start -Fixture -NoOpen' 3 }
    if (-not (Test-Path -LiteralPath $ElectronExe)) { Fail 'Electron is not installed; run dashboard.ps1 setup -Fixture.' 2 }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = Join-Path $DataDir 'selftest.json'
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $choice = Resolve-Gpu
    Set-GpuPreference $choice
    $argv = @((Join-Path $DashDir 'shell'), '--state', $StatePath, '--gpu', $choice, '--self-test', $out)
    $p = Start-Process -FilePath $ElectronExe -ArgumentList (Join-Args $argv) -WorkingDirectory $DashDir -PassThru
    if (-not $p.WaitForExit(45000)) { Stop-Process -Id $p.Id -Force; Fail 'The window self-test timed out.' 1 }
    $r = Read-JsonFile $out
    if (-not $r) { Fail 'The window self-test wrote no result.' 1 }
    $hosts = @($r.blockedHosts.PSObject.Properties | ForEach-Object { $_.Name })
    $gpuName = 'unknown'
    if ($r.gpuDevice) { $gpuName = [string]$r.gpuDevice.vendor }
    # Only meaningful on hybrid laptops (Intel iGPU plus NVIDIA/AMD); single-GPU machines always pass.
    $adapters = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.PNPDeviceID })
    $gpuOk = $true
    if (($adapters -match 'VEN_8086') -and ($adapters -match 'VEN_10DE|VEN_1002')) {
        if ($choice -eq 'rtx') { $gpuOk = @('NVIDIA', 'AMD') -contains $gpuName } else { $gpuOk = $gpuName -eq 'Intel' }
    }
    $checks = @(
        @('API reachable with the injected token', ($r.page.apiStatus -eq 200 -and $r.page.mode -eq 'fixture')),
        @('Page cannot see the token or cookies', ($r.page.cookie -eq '')),
        @('Page has no Node.js (require, process)', (-not $r.page.hasRequire -and -not $r.page.hasProcess)),
        @('Page bridge exposes only info and setProtection', ((@($r.page.bridge) -join ',') -eq 'info,setProtection')),
        @('Requests to the internet and LAN are blocked', ($r.blockedByProbe -ge 3 -and $hosts -contains 'example.com' -and $hosts -contains '192.168.0.1')),
        @('Navigation away from the dashboard is blocked', [bool]$r.stayedOnOrigin),
        @('GPU compositing is on', ([string]$r.gpuFeatures.gpu_compositing -like 'enabled*')),
        @("The window runs on the chosen GPU ($choice)", $gpuOk)
    )
    $failed = 0
    foreach ($c in $checks) {
        if ($c[1]) { Say "  PASS  $($c[0])" } else { Say "  FAIL  $($c[0])"; $failed++ }
    }
    Say ('  Info: GPU {0} (choice {1}), video decode {2}, blocked hosts: {3}' -f $gpuName, $r.gpuChoice, $r.gpuFeatures.video_decode, ($hosts -join ', '))
    Say "Self-test finished in $(Format-Seconds $sw): $($checks.Count - $failed) of $($checks.Count) passed."
    if ($failed -gt 0) { return 1 }
    return 0
}

function Invoke-Main {
    switch ($Command) {
        'setup' { $null = Invoke-Setup -Explicit; return 0 }
        'start' { return (Start-Dashboard) }
        'stop' { return (Stop-Dashboard) }
        'restart' {
            $c = Stop-Dashboard
            if ($c -ne 0) { return $c }
            return (Start-Dashboard)
        }
        'status' { return (Show-Status) }
        'open' { return (Open-Window) }
        'selftest' { return (Invoke-SelfTest) }
    }
    return 1
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\PhotoSort-Dashboard')
$owned = $false
$exitCode = 1
try {
    try { $owned = $mutex.WaitOne(60000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { Say 'Another dashboard.ps1 is still running; try again in a minute.' }
    else { $exitCode = [int](@(Invoke-Main)[-1]) }
} catch {
    $ex = $_.Exception
    Write-Host ('Failed: ' + (Hide-Paths $ex.Message)) -ForegroundColor Red
    if ($ex.Data['exit']) { $exitCode = [int]$ex.Data['exit'] } else { $exitCode = 1 }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
