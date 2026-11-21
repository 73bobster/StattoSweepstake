# Launcher for the live-match poller (Windows PowerShell). Leave the window open while you want live updates from your home IP.
# Right-click this file > "Run with PowerShell". Turn your VPN OFF first.
# It asks for your two secrets (typed hidden, never saved to disk), then runs the loader.
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'; exit 1
}
function Read-Secret($prompt, $check, $hint) {
  while ($true) {
    $s = Read-Host $prompt -AsSecureString
    $v = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    $v = ($v -replace '[^\x21-\x7E]', '')   # drop stray control characters and spaces
    if (& $check $v) { return $v }
    Write-Host "That didn't look right ($($v.Length) characters). $hint" -ForegroundColor Yellow
  }
}
$paste = 'In this window, paste with a RIGHT-CLICK (Ctrl+V does not work here). Nothing shows as you paste, that is normal.'
$env:API_FOOTBALL_KEY = Read-Secret 'Paste your API-Football Pro key, then press Enter' { param($v) $v.Length -ge 20 } $paste
$env:DATABASE_URL = Read-Secret 'Paste the stattosweepstake (game) database connection string, then press Enter' { param($v) $v -match '^postgres(ql)?://' } $paste
node tools/poller.mjs
Read-Host 'Poller stopped. Press Enter to close'
