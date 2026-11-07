param([string]$Root = $PSScriptRoot)
Add-Type -AssemblyName System.Speech
$lines = (Get-Content "$Root\lines.json" | ConvertFrom-Json).lines
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($v in @('David','Zira','Hazel')) {
  $synth.SelectVoice("Microsoft $v Desktop")
  $synth.Rate = -2
  $dir = "$Root\raw\sapi-$($v.ToLower())"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($l in $lines) {
    $out = "$dir\$($l.chord).wav"
    if (Test-Path $out) { continue }
    $text = if ($l.alt -and $l.alt.sapi) { $l.alt.sapi } else { $l.text }
    $synth.SetOutputToWaveFile($out)
    $synth.Speak(($text -replace '!',''))
  }
}
$synth.SetOutputToNull()
Write-Host "done"
