[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$taskArtifacts = Join-Path $taskRoot ('artifacts\verification-' + $taskStamp)
[IO.Directory]::CreateDirectory($taskArtifacts) | Out-Null
$taskNpm = (Get-Command npm.cmd -ErrorAction Stop).Source
$taskSteps = @('typecheck', 'test', 'test:workers', 'build', 'demo')
$taskResults = @()
Push-Location -LiteralPath $taskRoot
try {
    foreach ($taskStep in $taskSteps) {
        $taskStart = [DateTime]::UtcNow
        $taskPreviousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $taskOutput = & $taskNpm run $taskStep 2>&1 | Out-String; $taskExit = $LASTEXITCODE }
        finally { $ErrorActionPreference = $taskPreviousPreference }
        $taskLog = Join-Path $taskArtifacts ($taskStep.Replace(':', '-') + '.log')
        [IO.File]::WriteAllText($taskLog, $taskOutput, (New-Object System.Text.UTF8Encoding($false)))
        $taskResults += [ordered]@{command=('npm run ' + $taskStep); exit_code=$taskExit; started_at=$taskStart.ToString('o'); ended_at=[DateTime]::UtcNow.ToString('o'); log=$taskLog}
        Write-Host ($taskStep + ': exit ' + $taskExit)
        if ($taskExit -ne 0) { break }
    }
    $taskFiles = & rg --files --hidden -g '!node_modules/**' -g '!.wrangler/**' -g '!dist/**' -g '!artifacts/**' -g '!*.local.json' -g '!*.local.jsonc' -g '!.dev.vars' -g '!.env' -g '!*.log'
    if ($LASTEXITCODE -ne 0) { throw 'Source inventory failed.' }
    $taskHashes = @($taskFiles | Sort-Object | ForEach-Object { [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $taskRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant()} })
    $taskSummary = [ordered]@{created_at=[DateTime]::UtcNow.ToString('o'); mode='mock'; branch=$null; commit=$null; repository='No Git repository initialized'; seed='Deterministic synthetic fixtures'; steps=$taskResults; all_passed=($taskResults.Count -eq $taskSteps.Count -and @($taskResults | Where-Object {$_.exit_code -ne 0}).Count -eq 0); source_hashes=$taskHashes}
    [IO.File]::WriteAllText((Join-Path $taskArtifacts 'summary.json'), ($taskSummary | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ('Evidence: ' + $taskArtifacts)
    if (-not $taskSummary.all_passed) { exit 1 }
} finally { Pop-Location }
