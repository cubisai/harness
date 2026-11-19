# CubiQ installer for Windows (PowerShell 5.1 and PowerShell 7).
#
#   irm https://raw.githubusercontent.com/cubisai/harness/main/scripts/install/install.ps1 | iex
#   powershell -c "irm https://raw.githubusercontent.com/cubisai/harness/main/scripts/install/install.ps1 | iex"
#
# Environment:
#   VERSION          release to install, e.g. 0.1.3 (default: the latest release)
#   CUBIQ_NO_LAUNCH  set to 1 to skip launching CubiQ after installing
#   GITHUB_TOKEN     optional GitHub token; anonymous API calls are capped at 60/hour

function Install-CubiQ {
    # Set inside the function so `| iex` leaves the caller's session as it was.
    $ErrorActionPreference = 'Stop'
    # The progress bar redraws per chunk on 5.1, which makes downloads several times slower.
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'CubiQ requires 64-bit Windows.'
    }
    # The published build is x64 only; Windows on ARM runs it under emulation.
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        Write-Host 'warning: only an x64 build is published; it runs under emulation on Windows on ARM.'
    }

    $pin = $env:VERSION
    if ($pin) { $pin = $pin -replace '^(cubiq-)?v', '' }

    $apiUrl = if ($pin) {
        "https://api.github.com/repos/cubisai/harness/releases/tags/cubiq-v$pin"
    } else {
        'https://api.github.com/repos/cubisai/harness/releases/latest'
    }

    $headers = @{ 'User-Agent' = 'cubiq-installer' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }

    Write-Host '==> Looking up CubiQ release metadata...'
    try {
        $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
    } catch {
        throw "Could not read $apiUrl (has a release been published yet?): $($_.Exception.Message)"
    }

    $version = $release.tag_name -replace '^cubiq-v', ''
    if (-not $version -or $version -eq $release.tag_name) {
        throw "No cubiq-v* release found at $apiUrl."
    }

    $asset = $release.assets | Where-Object { $_.name -match '^CubiQ-Setup-.*\.exe$' } | Select-Object -First 1
    if (-not $asset) {
        throw "Release $version has no Windows installer (CubiQ-Setup-*.exe)."
    }

    Write-Host "==> Downloading CubiQ $version..."
    $exe = Join-Path $env:TEMP $asset.name
    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing
    } catch {
        throw "Download failed: $($_.Exception.Message)"
    }

    Write-Host '==> Stopping a running CubiQ...'
    Get-Process CubiQ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host '==> Running the installer...'
    $installer = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
    if ($installer.ExitCode -ne 0) {
        throw "Installer exited with code $($installer.ExitCode)."
    }
    Remove-Item $exe -Force -ErrorAction SilentlyContinue

    # Per-user by default; Program Files when an earlier install chose all users.
    $app = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\CubiQ\CubiQ.exe'),
        (Join-Path $env:ProgramFiles 'CubiQ\CubiQ.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($env:CUBIQ_NO_LAUNCH -ne '1') {
        if ($app) {
            Start-Process -FilePath $app | Out-Null
        } else {
            Write-Host 'warning: could not find CubiQ.exe; start it from the Start menu.'
        }
    }

    Write-Host "CubiQ $version installed. It updates itself from now on."
}

# Defined last so a truncated download exits before doing anything.
Install-CubiQ
