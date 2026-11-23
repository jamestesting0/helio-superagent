# Run as the Windows desktop account that owns the Ubuntu-22.04 distribution.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$name = 'Helio Foreground Start'
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
if ($Remove) {
    $folder.DeleteTask($name, 0)
    return
}

$terminal = (Get-Command wt.exe -CommandType Application).Source
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definition = $scheduler.NewTask(0)
$definition.RegistrationInfo.Description = 'Open the fixed Helio foreground launcher on demand.'
$definition.Principal.UserId = $account
$definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
$definition.Settings.AllowDemandStart = $true
$definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$action = $definition.Actions.Create(0)
$action.Path = $terminal
$action.Arguments = '--window new wsl.exe -d Ubuntu-22.04 -u root --exec /usr/bin/systemd-run --scope --quiet --unit helio-isolated /usr/bin/python3 -I /opt/helio-beta-service/scripts/helio_isolated_launcher.py --desktop-start $(Arg0)'
$folder.RegisterTaskDefinition($name, $definition, 6, $account, $null, 3, $null) | Out-Null
