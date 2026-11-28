# Run one SQL migration file on the Render database (called by run-render-sql.bat).
#
# Why PowerShell instead of pasting into the .bat prompt:
#  - the URL is read straight from the clipboard, so it cannot be pasted twice
#    (a doubled paste made psql look for a database named "...postgresql://...");
#  - the URL must contain exactly one postgresql:// link, otherwise nothing runs;
#  - the password goes to psql through the PGPASSWORD environment variable, never on
#    the command line, so a psql error message can no longer print it;
#  - the clipboard is cleared afterwards. Nothing is saved to disk.
param([Parameter(Mandatory = $true)][string]$File)

if (-not (Test-Path -LiteralPath $File)) { Write-Host "File not found: $File"; exit 1 }
$env:PATH = "$env:PATH;C:\Program Files\PostgreSQL\18\bin"
$env:PGCLIENTENCODING = 'UTF8'

Write-Host ''
Write-Host 'In Render: Database > Connections > External Database URL > click the COPY button.'
Write-Host 'Then come back here and press Enter (do not paste anything).'
[void](Read-Host)

$raw = Get-Clipboard -Raw
if (-not $raw) { Write-Host 'The clipboard is empty - cancelled. Nothing was run.'; exit 1 }
$raw = $raw.Trim()
$count = ([regex]::Matches($raw, 'postgres(ql)?://')).Count
if ($count -ne 1) {
  Write-Host "The clipboard must contain exactly ONE database URL (found $count) - cancelled. Nothing was run."
  Write-Host 'Click the copy button in Render once more, then run this command again.'
  exit 1
}
$m = [regex]::Match($raw, '^postgres(?:ql)?://([^:@/\s]+):([^@\s]+)@([^:/?\s]+)(?::(\d+))?/([^?\s]+)(?:\?\S*)?$')
if (-not $m.Success) { Write-Host 'That does not look like a Render External Database URL - cancelled. Nothing was run.'; exit 1 }

$dbUser = [uri]::UnescapeDataString($m.Groups[1].Value)
$env:PGPASSWORD = [uri]::UnescapeDataString($m.Groups[2].Value)
$dbHost = $m.Groups[3].Value
$dbPort = if ($m.Groups[4].Success) { $m.Groups[4].Value } else { '5432' }
$dbName = [uri]::UnescapeDataString($m.Groups[5].Value)
$env:PGSSLMODE = 'require'
$raw = $null
cmd /c "echo off | clip"   # clear the clipboard so the password does not linger
Clear-Host

Write-Host "Running $File on $dbHost / $dbName ..."
Write-Host ''
& psql -h $dbHost -p $dbPort -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f $File
$rc = $LASTEXITCODE
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
Write-Host ''
if ($rc -eq 0) { Write-Host '===== DONE - no errors =====' } else { Write-Host '===== FAILED - see the ERROR line above =====' }
exit $rc
