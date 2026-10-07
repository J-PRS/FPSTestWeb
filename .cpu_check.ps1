$a = @{}
Get-Process | ForEach-Object { $a[$_.Id] = $_.CPU }
Start-Sleep -Seconds 3
Get-Process | ForEach-Object {
  $d = (($_.CPU - $a[$_.Id]) / 3) * 100
  if ($d -gt 3) {
    '{0,-32} {1,6:N0}% cpu  {2,6:N0} MB' -f $_.Name, $d, [math]::Round($_.WorkingSet64/1MB)
  }
} | Sort-Object { [double](($_ -split '\s{2,}')[1] -replace '% cpu','') } -Descending | Select-Object -First 15
