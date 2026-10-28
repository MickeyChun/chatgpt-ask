[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeDirectory,
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'
$taskProjectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$taskRuntimeRoot = (Resolve-Path -LiteralPath $RuntimeDirectory).ProviderPath
if (-not (Test-Path -LiteralPath $taskRuntimeRoot -PathType Container)) {
    throw 'RuntimeDirectory must be an existing directory.'
}
if ($taskRuntimeRoot.TrimEnd('\') -ieq $taskProjectRoot.TrimEnd('\')) {
    throw 'RuntimeDirectory must differ from the source project directory.'
}
$taskNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskEntries = foreach ($taskName in @('chatgpt-ask.mjs', 'chatgpt-ask-mcp.mjs')) {
    $taskSource = Join-Path $taskProjectRoot $taskName
    if (-not (Test-Path -LiteralPath $taskSource -PathType Leaf)) { throw "Missing source: $taskSource" }
    $taskQuotedSource = ConvertTo-Json -InputObject $taskSource -Compress
    [pscustomobject]@{
        Destination = Join-Path $taskRuntimeRoot $taskName
        Source = $taskSource
        Content = "#!/usr/bin/env node`n// Compatibility entry point; maintained source lives in the project repository.`nimport { pathToFileURL } from 'node:url';`nawait import(pathToFileURL($taskQuotedSource).href);`n"
    }
}
if ($Preview) {
    $taskEntries | ConvertTo-Json -Depth 3
    exit 0
}
foreach ($taskEntry in $taskEntries) {
    [IO.File]::WriteAllText($taskEntry.Destination, $taskEntry.Content, [Text.UTF8Encoding]::new($false))
    & $taskNode --check $taskEntry.Destination
    if ($LASTEXITCODE -ne 0) { throw "Invalid entry point: $($taskEntry.Destination)" }
    Write-Output "$($taskEntry.Destination) -> $($taskEntry.Source)"
}
