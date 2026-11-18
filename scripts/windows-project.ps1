param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('deps', 'build', 'install', 'dev')]
    [string]$Task,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$script:nodeExe = $null
$script:npmCli = $null

function Initialize-Node {
    if ($script:nodeExe) { return }
    $candidates = @()
    if ($env:JARVIS_NODE_HOME) { $candidates += Join-Path $env:JARVIS_NODE_HOME 'node.exe' }
    $candidates += @(Get-Command node.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)

    # Find real nvm installs too: a PATH entry may be an unconfigured version-manager shim.
    $nvmRoots = @($env:NVM_HOME)
    $nvm = Get-Command nvm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nvm) { $nvmRoots += Split-Path -Parent $nvm.Source }
    foreach ($root in @($nvmRoots | Where-Object { $_ } | Select-Object -Unique)) {
        foreach ($parent in @((Join-Path $root 'installs'), $root)) {
            $versions = @(Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } |
                Sort-Object { [version]$_.Name.Substring(1) } -Descending)
            foreach ($version in $versions) { $candidates += Join-Path $version.FullName 'node.exe' }
        }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $directory = Split-Path -Parent $candidate
        $npm = Join-Path $directory 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { continue }
        try {
            $version = & $candidate --version 2>$null
            if ($LASTEXITCODE -ne 0 -or ([version]([string]$version).Trim().TrimStart('v')) -lt [version]'22.12.0') { continue }
        } catch { continue }
        $script:nodeExe = $candidate
        $script:npmCli = $npm
        $env:PATH = $directory + ';' + $env:PATH
        Write-Host "Node.js $version ($directory)"
        return
    }
    throw 'Node.js 22.12+ with npm was not found. Install Node.js or set JARVIS_NODE_HOME to its installation folder.'
}

function Require-NativeTools {
    $dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $dotnet) { throw '.NET SDK 8+ was not found. Install the SDK (not just the runtime).' }
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_NOLOGO = '1'
    $sdks = @(& $dotnet.Source --list-sdks)
    if ($LASTEXITCODE -ne 0 -or -not @($sdks | Where-Object { $_ -match '^(\d+)\.' -and [int]$Matches[1] -ge 8 }).Count) {
        throw '.NET SDK 8+ is required to build the Windows helper.'
    }
    foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32\$dll"))) {
            throw 'Microsoft Visual C++ 2015-2022 x64 Redistributable is required for the bundled voice runtime.'
        }
    }
    Write-Host '.NET SDK and Visual C++ runtime: OK'
}

function Invoke-Npm {
    param([string[]]$NpmArgs)
    Write-Host ('> npm ' + ($NpmArgs -join ' '))
    if ($Check) { return }
    & $script:nodeExe $script:npmCli @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm exited with code $LASTEXITCODE. Fix the error above and run this BAT file again." }
}

function Install-Dependencies {
    Initialize-Node
    Invoke-Npm -NpmArgs @('ci')
    # Recent Electron releases install their executable on demand; fetch it now, before dev/build.
    Write-Host '> node node_modules/electron/install.js'
    if (-not $Check) {
        & $script:nodeExe (Join-Path $projectRoot 'node_modules\electron\install.js')
        if ($LASTEXITCODE -ne 0) { throw 'Electron installation failed. Check the connection and retry install-deps.bat.' }
    }
}

function Ensure-Dependencies {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\.bin\electron-vite.cmd'))) {
        Install-Dependencies
    }
}

function Get-InstallerPath {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
    if ($package.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'Invalid package version.' }
    return Join-Path $projectRoot ("release\Jarvis-Setup-" + $package.version + '.exe')
}

function Build-Installer {
    Initialize-Node
    Require-NativeTools
    Ensure-Dependencies
    Invoke-Npm -NpmArgs @('run', 'typecheck')
    # dist builds native resources, the app and the full local NSIS installer. Never publish a release here.
    Invoke-Npm -NpmArgs @('run', 'dist', '--', '--publish', 'never')
    $installer = Get-InstallerPath
    if (-not $Check -and -not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "The build did not produce $installer" }
    Write-Host "Installer: $installer"
}

try {
    Write-Host "Jarvis project: $projectRoot"
    if ($Check) { Write-Host '[CHECK] Commands will be shown without installing, building or launching anything.' }
    switch ($Task) {
        'deps' { Install-Dependencies }
        'build' { Build-Installer }
        'install' {
            $installer = Get-InstallerPath
            if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { Build-Installer }
            Write-Host "Starting local installer: $installer"
            if (-not $Check) {
                # The user launches install.bat to interact with this installer window.
                $setup = Start-Process -FilePath $installer -Wait -PassThru
                if ($setup.ExitCode -eq 3010) { Write-Host 'Installation completed. Windows reports that a restart is needed.' }
                elseif ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)." }
            }
        }
        'dev' {
            Initialize-Node
            Require-NativeTools
            Ensure-Dependencies
            Invoke-Npm -NpmArgs @('run', 'native')
            Invoke-Npm -NpmArgs @('run', 'dev')
        }
    }
    Write-Host '[OK] Done.'
    exit 0
} catch {
    Write-Host ('[ERROR] ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
