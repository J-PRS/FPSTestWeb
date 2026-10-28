param([string]$file, [int]$n = 20)
Get-Content $file -Tail $n
