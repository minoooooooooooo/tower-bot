# Builds dist/bot.zip with only the files any host needs.
# Usage: .\scripts\package.ps1
#
# Entries are written with forward slashes on purpose. Compress-Archive (and
# anything else that uses Windows path separators) produces entries like
# "src\boot.js"; on Linux that extracts to a file literally named
# "src\boot.js" instead of a src/ directory, and the bot cannot start.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist 'bot.zip'

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

$include = @(
  'src',
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.env.example',
  'README.md',
  'docs'
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')

try {
  foreach ($item in $include) {
    $source = Join-Path $root $item
    if (-not (Test-Path $source)) { continue }

    $files = if (Test-Path $source -PathType Leaf) {
      @(Get-Item $source)
    } else {
      @(Get-ChildItem $source -Recurse -File)
    }

    foreach ($file in $files) {
      # Relative to the project root, with POSIX separators so Linux/macOS
      # unzip and every hosting panel create real directories.
      $entryName = $file.FullName.Substring($root.Length + 1).Replace('\', '/')

      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $file.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  }
}
finally {
  $archive.Dispose()
}

# Verify before declaring success: a single backslash would break the upload.
$verify = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $bad = @($verify.Entries | Where-Object { $_.FullName -like '*\*' })
  $count = $verify.Entries.Count
}
finally {
  $verify.Dispose()
}

if ($bad.Count -gt 0) {
  throw "dist\bot.zip still contains Windows path separators: $($bad[0].FullName)"
}

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "Created dist\bot.zip ($size KB, $count files, POSIX paths)"
Write-Host "Upload the zip to the panel, then extract it there."
