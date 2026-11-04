# Tervyn Browser on your own Windows PC: free, no session limits.
# Double-click run-local.bat (or run this in PowerShell). It starts the browser
# server and a free Cloudflare quick tunnel, then shows the https address and
# access key to open from any device (phone too).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { '8090' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Please install Node.js 20 or newer (LTS) from https://nodejs.org, then run this again.'
  Read-Host 'Press Enter to close'; exit 1
}
if (-not (Test-Path node_modules)) { npm ci --omit=dev }
npx --yes playwright install chromium | Out-Null

# Access key: made once, kept in browser\.access-key (private).
if (-not (Test-Path .access-key)) { node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))" | Out-File -Encoding ascii .access-key }
$env:ACCESS_KEY = (Get-Content .access-key -Raw).Trim()
# Your proxies: every .txt file in browser\proxies\ (e.g. your Webshare downloads).
$lines = Get-ChildItem proxies -Filter *.txt -ErrorAction SilentlyContinue | Get-Content | Where-Object { $_ -match '\d+\.\d+\.\d+\.\d+' }
$env:PRIVATE_PROXIES = ($lines -join ' ')
$env:PORT = $port
if (-not $env:IDLE_MINUTES) { $env:IDLE_MINUTES = '0' }

$server = Start-Process node -ArgumentList 'server.mjs' -NoNewWindow -PassThru
$tunnel = $null
try {
  $cf = Join-Path $PSScriptRoot 'cloudflared.exe'
  $cfExe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cfExe) {
    if (-not (Test-Path $cf)) {
      Write-Host 'Downloading cloudflared (free Cloudflare tunnel)...'
      Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf
    }
    $cfExe = $cf
  }
  $log = Join-Path $env:TEMP 'tervyn-tunnel.log'
  if (Test-Path $log) { Remove-Item $log }
  $tunnel = Start-Process $cfExe -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://localhost:$port" -RedirectStandardError $log -NoNewWindow -PassThru
  $url = $null
  for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } }
  }
  $count = ($lines | ForEach-Object { ($_ -split ':')[0..1] -join ':' } | Sort-Object -Unique).Count
  Write-Host ''
  Write-Host '  Tervyn Browser is running'
  Write-Host ('  Open:  ' + $(if ($url) { $url } else { "http://localhost:$port  (tunnel didn't start; see $log)" }))
  Write-Host ('  Key:   ' + $env:ACCESS_KEY)
  Write-Host ('  Servers from browser\proxies\: ' + $count)
  Write-Host '  Keep this window open. Close it to stop.'
  Wait-Process -Id $server.Id
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
