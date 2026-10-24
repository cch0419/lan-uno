$ErrorActionPreference = 'Stop'
$voiceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$voiceCertDir = Join-Path $voiceRoot '.certs'
New-Item -ItemType Directory -Path $voiceCertDir -Force | Out-Null
$voiceOpenSsl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $voiceOpenSsl) {
    foreach ($voiceCandidate in @('C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe')) {
        if (Test-Path -LiteralPath $voiceCandidate) { $voiceOpenSsl = $voiceCandidate; break }
    }
}
if (-not $voiceOpenSsl) { throw 'OpenSSL is required. Install Git for Windows (includes OpenSSL), then rerun start-https.bat.' }
function Invoke-VoiceOpenSsl {
    & $voiceOpenSsl @args
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSL certificate generation failed.' }
}
$voiceCaKey = Join-Path $voiceCertDir 'lan-uno-ca.key'
$voiceCaCert = Join-Path $voiceCertDir 'lan-uno-ca.crt'
$voiceKey = Join-Path $voiceCertDir 'server.key'
$voiceCert = Join-Path $voiceCertDir 'server.crt'
$voiceAddresses = @('127.0.0.1') + @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '0.0.0.0'
} | Select-Object -ExpandProperty IPAddress | Sort-Object -Unique)
$voiceSan = 'DNS:localhost,IP:::1,' + (($voiceAddresses | ForEach-Object { 'IP:' + $_ }) -join ',')
$voiceAddressFile = Join-Path $voiceCertDir 'addresses.txt'
$voiceRequestConfig = Join-Path $voiceCertDir 'request.cnf'
@('[req]', 'distinguished_name=reqdn', 'prompt=no', '[reqdn]', 'CN=LAN UNO Voice') | Set-Content -LiteralPath $voiceRequestConfig -Encoding ascii
$voiceNewCa = $false
if (-not (Test-Path -LiteralPath $voiceCaKey) -or -not (Test-Path -LiteralPath $voiceCaCert)) {
    Invoke-VoiceOpenSsl req -config $voiceRequestConfig -x509 -newkey rsa:2048 -sha256 -nodes -keyout $voiceCaKey -out $voiceCaCert -days 3650 -subj '/CN=LAN UNO Local Voice CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign'
    $voiceNewCa = $true
}
if (-not $voiceNewCa -and (Test-Path -LiteralPath $voiceKey) -and (Test-Path -LiteralPath $voiceCert) -and
    (Test-Path -LiteralPath $voiceAddressFile) -and (Get-Content -LiteralPath $voiceAddressFile -Raw).Trim() -eq $voiceSan) {
    & $voiceOpenSsl x509 -checkend 604800 -noout -in $voiceCert 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Output 'Local HTTPS certificate is ready.'; exit 0 }
}
$voiceExtensions = Join-Path $voiceCertDir 'server.ext'
@("subjectAltName=$voiceSan", 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth') | Set-Content -LiteralPath $voiceExtensions -Encoding ascii
$voiceCsr = Join-Path $voiceCertDir 'server.csr'
Invoke-VoiceOpenSsl req -config $voiceRequestConfig -new -newkey rsa:2048 -sha256 -nodes -keyout $voiceKey -out $voiceCsr -subj '/CN=LAN UNO Voice'
Invoke-VoiceOpenSsl x509 -req -sha256 -in $voiceCsr -CA $voiceCaCert -CAkey $voiceCaKey -CAcreateserial -out $voiceCert -days 365 -extfile $voiceExtensions
$voiceSan | Set-Content -LiteralPath $voiceAddressFile -Encoding ascii
Write-Output 'HTTPS ready. Install and trust .certs/lan-uno-ca.crt on each device to enable microphone access.'
Write-Output 'No system trust settings were changed automatically. Never share the .key files.'
