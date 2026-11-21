param(
  [string]$File = 'latest.html'
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $root
try {
  $path = Join-Path '.trae-html-share-packages' $File
  if (-not (Test-Path $path)) { throw "preview file not found: $path (run npm run pack:html first)" }

  if (-not (Get-Command lark-cli -ErrorAction SilentlyContinue)) { throw 'lark-cli is not available' }

  $raw = (& lark-cli contact +get-user --format json | Out-String)
  $start = $raw.IndexOf('{')
  if ($start -lt 0) { throw 'cannot resolve the current Feishu user' }
  $user = ($raw.Substring($start) | ConvertFrom-Json).data.user
  if (-not $user.open_id) { throw 'missing Feishu open_id' }

  # lark-cli writes progress to stderr; discard it so it cannot abort the script
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $send = (& lark-cli im +messages-send --user-id $user.open_id --file $path 2>$null | Out-String)
  $sendCode = $LASTEXITCODE
  $ErrorActionPreference = $previous
  Write-Output $send
  if ($sendCode -ne 0 -or $send -notmatch '"ok"\s*:\s*true') { throw 'Feishu send failed' }

  [pscustomobject]@{
    sent_to = $user.name
    file    = (Resolve-Path $path).Path
    bytes   = (Get-Item $path).Length
  } | Format-List
}
finally {
  Pop-Location
}
