# Golf Scheduler - Windows Task Scheduler Setup
# Runs the booking bot twice a week (Monday and Thursday at 6:00 AM)
# to keep tee times booked one month ahead

$taskName = "GolfScheduler"
$workingDir = "C:\Users\Bruce\source\repos\GolfScheduler"
$nodeExe = (Get-Command node).Source

# Remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument "src/index.js book" `
    -WorkingDirectory $workingDir

# Run every Monday and Thursday at 6:00 AM
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Thursday -At 6:00AM

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Auto-book golf tee times twice weekly (Mon/Thu 6 AM)"

Write-Host ""
Write-Host "Task '$taskName' created successfully!" -ForegroundColor Green
Write-Host "Schedule: Every Monday and Thursday at 6:00 AM"
Write-Host "Working directory: $workingDir"
Write-Host ""
Write-Host "To verify: Get-ScheduledTask -TaskName '$taskName'"
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$taskName'"
Write-Host "To run now: Start-ScheduledTask -TaskName '$taskName'"
