# One-off: pull everything API-Football has on one player. Double-click run-player-report.bat. Turn your VPN OFF first.
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'; exit 1
}
function Read-Secret($prompt, $check, $hint) {
  while ($true) {
    $s = Read-Host $prompt -AsSecureString
    $v = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    $v = ($v -replace '[^\x21-\x7E]', '')
    if ($v.Length -ge 40 -and $v.Length % 2 -eq 0 -and $v.Substring(0, $v.Length / 2) -eq $v.Substring($v.Length / 2)) { $v = $v.Substring(0, $v.Length / 2) }
    if (& $check $v) { return $v }
    Write-Host "That didn't look right ($($v.Length) characters). $hint" -ForegroundColor Yellow
  }
}
$env:API_FOOTBALL_KEY = Read-Secret 'Paste your API-Football key (right-click to paste), then press Enter' { param($v) $v -match '^[A-Za-z0-9]{24,40}$' } 'Paste with a RIGHT-CLICK, once.'
$id = Read-Host 'Player id (just press Enter for Ryan Naderi, 280305)'
if (-not $id) { $id = '280305' }
$m = Read-Host 'Also get his stats for every match this season? About 50 extra calls (y/N)'
if ($m -match '^[Yy]') { node tools/player-report.mjs $id --matches } else { node tools/player-report.mjs $id }
Write-Host ''
Write-Host 'The report is in the player-report folder inside the project folder.'
Read-Host 'Press Enter to close'
