[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEnvPath = Join-Path $taskRoot '.dev.vars'
$taskValues = [ordered]@{}
if (Test-Path -LiteralPath $taskEnvPath) {
    foreach ($taskLine in [IO.File]::ReadAllLines($taskEnvPath)) {
        if ($taskLine -match '^([A-Z_]+)=(.*)$') { $taskValues[$Matches[1]] = $Matches[2] }
    }
}
foreach ($taskKey in @('MODEL_API_KEY', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN', 'FEISHU_ENCRYPT_KEY')) {
    if ($taskValues[$taskKey]) { Write-Host "$taskKey is already configured; keeping it."; continue }
    $taskSecure = Read-Host "Enter $taskKey (hidden; leave blank to configure later)" -AsSecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
    try { $taskValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
    if ($taskValue) {
        if ($taskValue -match '[\r\n]') { throw 'Only single-line secret values are accepted.' }
        $taskValues[$taskKey] = $taskValue
    }
}
$taskValues['MODEL_BASE_URL'] = 'https://api.openai.com/v1'
if (-not $taskValues['MODEL_ID']) { $taskValues['MODEL_ID'] = 'gpt-6.1-sol' }
foreach ($taskKey in @('ADMIN_AUTH_TOKEN', 'CONNECTOR_AUTH_TOKEN')) {
    if (-not $taskValues[$taskKey]) {
        $taskBytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($taskBytes)
        $taskValues[$taskKey] = [Convert]::ToBase64String($taskBytes)
    }
}
$taskLines = @('# Local runtime secrets. Do not commit.') + @($taskValues.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value })
[IO.File]::WriteAllLines($taskEnvPath, $taskLines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'Saved local configuration. No secret values are printed.'
