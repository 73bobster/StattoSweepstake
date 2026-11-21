# Double-click friendly launcher for the football-data loader (Windows PowerShell).
# Right-click this file > "Run with PowerShell". Turn your VPN OFF first.
# It asks for your two secrets (typed hidden, never saved to disk), then runs the loader.
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'; exit 1
}
function Read-Secret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
$env:API_FOOTBALL_KEY = Read-Secret 'Paste your API-Football Pro key (hidden) and press Enter'
$env:FOOTBALL_DATABASE_URL = Read-Secret 'Paste the football-data connection string (hidden) and press Enter'
node tools/load-football-data.mjs
Read-Host 'Finished or stopped. Press Enter to close'
