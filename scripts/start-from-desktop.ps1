param(
    [Parameter(Mandatory)][string]$Executable,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = (Get-Location).Path,
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$program = (Resolve-Path -LiteralPath $Executable).Path
$directory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$arguments = ($ArgumentList | ForEach-Object {
    if ($_ -match '["\r\n]') { throw 'Pass plain arguments without embedded quotes or newlines.' }
    '"' + ($_ -replace '(\\+)$', '$1$1') + '"'
}) -join ' '

# Invoke ShellExecute on the existing Explorer desktop so the child uses the
# same AppData view as applications opened from the Windows desktop.
$shell = New-Object -ComObject Shell.Application
$windows = $shell.Windows()
$location = 0
$root = [Type]::Missing
$desktopHandle = 0
$desktop = $windows.FindWindowSW([ref]$location, [ref]$root, 8, [ref]$desktopHandle, 1)
if (!$desktop) { throw 'The Windows desktop is unavailable.' }
$show = if ($Background) { 0 } else { 1 }
$desktop.Document.Application.ShellExecute($program, $arguments, $directory, 'open', $show)
