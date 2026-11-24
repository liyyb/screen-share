param([ValidateSet('Lan','Internet')][string]$Mode = 'Lan', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Test-Node([string]$Path) {
    if (!$Path -or !(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $version = & $Path --version
        return ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18)
    } catch { return $false }
}

function Get-Node {
    $installed = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installed -and (Test-Node $installed.Source)) { return $installed.Source }
    $archName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = @{AMD64='x64'; ARM64='arm64'; x86='x86'}[$archName]
    if (!$arch) { throw "Unsupported Windows architecture: $archName" }
    $dir = Join-Path $env:LOCALAPPDATA "SHARE\runtime\node22-$arch"
    $node = Join-Path $dir 'node.exe'
    if (Test-Node $node) { return $node }
    Write-Host "Installing the official Node.js 22 runtime for this Windows user ($arch)..."
    $base = 'https://nodejs.org/dist/latest-v22.x'
    $manifest = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content
    $hash = [regex]::Match([string]$manifest, "(?m)^([a-fA-F0-9]{64})\s+win-$arch/node\.exe\s*$")
    if (!$hash.Success) { throw 'Official Node.js checksum not found. Check access to nodejs.org.' }
    [void][IO.Directory]::CreateDirectory($dir)
    $temp = Join-Path $dir ("download-" + [guid]::NewGuid() + '.exe')
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest "$base/win-$arch/node.exe" -OutFile $temp -UseBasicParsing -TimeoutSec 300
        if ((Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash -ne $hash.Groups[1].Value) {
            throw 'Node.js integrity check failed. Relaunch to retry.'
        }
        if (!(Test-Node $temp)) { throw 'Downloaded Node.js cannot run on this device.' }
        if (!(Test-Node $node)) { Move-Item -LiteralPath $temp -Destination $node -Force }
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
    return $node
}

function Find-Tailscale {
    $cmd = Get-Command tailscale.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($baseDir in @($env:ProgramW6432, $env:ProgramFiles)) {
        if (!$baseDir) { continue }
        $file = Join-Path $baseDir 'Tailscale\tailscale.exe'
        if (Test-Path -LiteralPath $file) { return $file }
    }
}

function Get-Tailscale {
    $cli = Find-Tailscale
    if (!$cli) {
        Write-Host 'Installing Tailscale for Internet mode. Windows may ask for administrator approval.'
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            & $winget.Source install --id Tailscale.Tailscale --exact --source winget --accept-source-agreements --accept-package-agreements | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "Tailscale install failed ($LASTEXITCODE). Check Windows approval and network, then retry." }
        } else {
            $temp = Join-Path ([IO.Path]::GetTempPath()) ("share-tailscale-" + [guid]::NewGuid() + '.exe')
            try {
                Invoke-WebRequest 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe' -UseBasicParsing -OutFile $temp -TimeoutSec 300
                $sig = Get-AuthenticodeSignature -LiteralPath $temp
                if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '(?i)\bTailscale\b') { throw 'Invalid Tailscale installer signature.' }
                $installer = Start-Process -FilePath $temp -ArgumentList '/install','/passive','/norestart' -Wait -PassThru
                if ($installer.ExitCode -notin 0,3010) { throw "Tailscale installer returned $($installer.ExitCode)." }
            } finally {
                if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
            }
        }
        $cli = Find-Tailscale
    }
    if (!$cli) { throw 'Tailscale CLI missing after installation. Restart Windows if the installer requested it.' }
    return $cli
}

$child = $null
try {
    $node = Get-Node
    Write-Host "Node: $node"
    if ($Mode -eq 'Internet') {
        $env:HOST = '127.0.0.1'
        if (!$env:PORT) { $env:PORT = '3001' }
        if ($env:TLS_CERT_FILE -or $env:TLS_KEY_FILE) { throw 'Funnel terminates HTTPS. Clear TLS_CERT_FILE and TLS_KEY_FILE for this launcher.' }
        $cli = Get-Tailscale
        $status = & $cli status --json | Out-String | ConvertFrom-Json
        if ($status.BackendState -ne 'Running') {
            if ($CheckOnly) { throw 'Tailscale is installed. Sign in before starting Internet mode.' }
            Write-Host 'Complete Tailscale sign-in in the browser.'
            & $cli up
            if ($LASTEXITCODE -ne 0) { throw 'Tailscale login failed.' }
            $status = & $cli status --json | Out-String | ConvertFrom-Json
        }
        $name = ([string]$status.Self.DNSName).TrimEnd('.')
        if ($status.BackendState -ne 'Running' -or !$name.EndsWith('.ts.net')) { throw 'Check Tailscale sign-in and enable MagicDNS for this device.' }
        $env:PUBLIC_ORIGIN = "https://$name"
    } else {
        if (!$env:PORT) { $env:PORT = '3000' }
        if (!$env:HOST) { $env:HOST = '0.0.0.0' }
    }
    & $node server/preflight.mjs
    $result = $LASTEXITCODE
    if ($result -notin 0,2) { throw 'Preflight failed. See the check results above.' }
    if ($CheckOnly) { exit 0 }
    if ($Mode -eq 'Lan') {
        if ($result -eq 2) {
            $scheme = if ($env:TLS_CERT_FILE) { 'https' } else { 'http' }
            if (!$env:NO_BROWSER) { Start-Process "${scheme}://localhost:$($env:PORT)" }
            exit 0
        }
        if (!$env:NO_BROWSER) { $env:SHARE_OPEN_BROWSER = '1' }
        & $node server/main.mjs
        exit $LASTEXITCODE
    }
    if ($result -eq 2) { throw 'The demo port already runs SHARE. Use that window, or stop it before restarting Internet mode.' }
    $env:SHARE_OPEN_BROWSER = '0'
    $child = Start-Process -FilePath $node -ArgumentList 'server/main.mjs' -WorkingDirectory $PWD.Path -WindowStyle Hidden -PassThru
    $local = "http://127.0.0.1:$($env:PORT)"
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ($child.HasExited) { throw 'Local server exited before Funnel started.' }
        try { $ready = (Invoke-RestMethod "$local/health" -TimeoutSec 1).app -eq 'share' } catch {}
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
    }
    if (!$ready -or $child.HasExited) { throw 'Local demo server did not become ready.' }
    Write-Host "Open $($env:PUBLIC_ORIGIN) after Funnel reports Available on the internet."
    Write-Host 'Keep this window open. Press Ctrl+C to stop the public demo.'
    & $cli funnel $local
    if ($LASTEXITCODE -ne 0) { throw 'Funnel failed. Check the authorization link, HTTPS and Funnel permission shown above.' }
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($child -and !$child.HasExited) { $child.Kill(); $child.WaitForExit() }
}
