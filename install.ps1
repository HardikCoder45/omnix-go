$ErrorActionPreference = "Stop"

$PackageSpec = if ($env:OMNIX_GO_NPM_SPEC) { $env:OMNIX_GO_NPM_SPEC } else { "omnix-go" }
$InstallPrefix = if ($env:OMNIX_GO_PREFIX) { $env:OMNIX_GO_PREFIX } else { Join-Path $env:LOCALAPPDATA "OmniXGo" }
$RuntimeRoot = Join-Path $InstallPrefix "runtime"

function Test-NodeRuntime {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  $major = [int](& node -p 'Number(process.versions.node.split(".")[0])')
  return $major -ge 20
}

if (-not (Test-NodeRuntime)) {
  Write-Host "Installing a verified private Node.js runtime for OmniX Go..."
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $architecture = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
  $checksumsUrl = "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"
  $checksums = (Invoke-WebRequest -UseBasicParsing $checksumsUrl).Content
  $match = [regex]::Match($checksums, "(?m)^([a-f0-9]{64})\s+(node-v[^\s]+-win-$architecture\.zip)$")
  if (-not $match.Success) { throw "Could not resolve the official Node.js runtime archive." }
  $expected = $match.Groups[1].Value
  $archiveName = $match.Groups[2].Value
  $archive = Join-Path $RuntimeRoot $archiveName
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v24.x/$archiveName" -OutFile $archive
  $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Node.js runtime checksum verification failed." }
  $extract = Join-Path $RuntimeRoot "extract"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $extract
  Expand-Archive -Force $archive $extract
  $nodeDirectory = Get-ChildItem -Directory $extract | Select-Object -First 1
  $runtime = Join-Path $RuntimeRoot "node"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $runtime
  Move-Item $nodeDirectory.FullName $runtime
  Remove-Item -Recurse -Force $extract
  Remove-Item -Force $archive
  $env:PATH = "$runtime;$env:PATH"
}

New-Item -ItemType Directory -Force -Path $InstallPrefix | Out-Null
& npm install --global --prefix $InstallPrefix $PackageSpec
if ($LASTEXITCODE -ne 0) { throw "npm installation failed with exit code $LASTEXITCODE" }
& (Join-Path $InstallPrefix "omnix-go.cmd") service install --tunnel auto --workspace ([Environment]::GetFolderPath('UserProfile'))
if ($LASTEXITCODE -ne 0) { throw "OmniX Go service setup failed with exit code $LASTEXITCODE" }

$commandDirectory = $InstallPrefix
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $commandDirectory) {
  [Environment]::SetEnvironmentVariable("Path", "$commandDirectory;$userPath", "User")
}
Write-Host "OmniX Go is installed with its verified gateway runtime and per-user login service."
Write-Host "Provision your permanent endpoint with: omnix-go gateway provision --name <name>"
Write-Host "Open a new terminal and run: omnix-go"
