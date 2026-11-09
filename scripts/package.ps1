# Builds dist/bot.zip with only the files any host needs.
# Usage: .\scripts\package.ps1              -> dist\bot.zip
#        .\scripts\package.ps1 -IncludeGit  -> dist\bot-git.zip (repo metadata too)
#
# -IncludeGit exists for one situation: the panel cannot clone the repo (its
# install script needs an empty directory, and some leftover files refuse to
# be deleted). Shipping .git/ alongside the code gives the host a valid
# working tree AND a remote, so its "Auto Update" pull works from then on.
#
# Entries are written with forward slashes on purpose. Compress-Archive (and
# anything else that uses Windows path separators) produces entries like
# "src\boot.js"; on Linux that extracts to a file literally named
# "src\boot.js" instead of a src/ directory, and the bot cannot start.
param([switch]$IncludeGit)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$zipName = if ($IncludeGit) { 'bot-git.zip' } else { 'bot.zip' }
$zip = Join-Path $dist $zipName

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

$include = @(
  'src',
  'assets',
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

# Embed the version the zip was built from. A plain zip host has no `.git`, so
# the marker is the only commit-audit trail; build-info.js falls back to it when
# `git rev-parse` is unavailable. A git-mode zip omits it because the checkout
# moves with every pull and would leave the marker stale.
$buildCommit = 'unknown'
$buildDate = ''
try {
  $buildCommit = (& git -C $root rev-parse --short HEAD).Trim()
  if ((& git -C $root status --porcelain)) { $buildCommit = "$buildCommit-dirty" }
  $buildDate = (& git -C $root log -1 --format=%cs).Trim()
} catch {
  Write-Warning 'Could not read the git commit; the build marker will say unknown.'
}

$buildJson = [ordered]@{
  commit  = $buildCommit
  date    = $buildDate
  builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json -Compress

$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')

try {
  # A git-mode zip carries a real `.git`, so the checkout itself is the build
  # marker. Shipping build.json there would only go stale on the first pull.
  if (-not $IncludeGit) {
    $marker = $archive.CreateEntry('build.json', [System.IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object System.IO.StreamWriter($marker.Open())
    try { $writer.Write($buildJson) } finally { $writer.Dispose() }
  }

  $addFile = {
    param($file)

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

  if ($IncludeGit) {
    # A git-mode zip must leave a clean checkout, otherwise `git pull` can
    # refuse to fast-forward over files the minimal runtime list omitted
    # (for example .gitignore). Ship every tracked file, then .git itself.
    foreach ($relative in (& git -C $root ls-files)) {
      $file = Get-Item (Join-Path $root $relative) -ErrorAction SilentlyContinue
      if ($file) { & $addFile $file }
    }

    foreach ($file in Get-ChildItem (Join-Path $root '.git') -Recurse -File) {
      & $addFile $file
    }
  } else {
    foreach ($item in $include) {
      $source = Join-Path $root $item
      if (-not (Test-Path $source)) { continue }

      $files = if (Test-Path $source -PathType Leaf) {
        @(Get-Item $source)
      } else {
        @(Get-ChildItem $source -Recurse -File)
      }

      foreach ($file in $files) { & $addFile $file }
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
  throw "dist\$zipName still contains Windows path separators: $($bad[0].FullName)"
}

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "Created dist\$zipName ($size KB, $count files, POSIX paths)"
Write-Host "Upload the zip to the panel, then extract it there."
