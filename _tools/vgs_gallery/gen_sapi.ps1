# Windows SAPI (System.Speech) VGS renders — one WAV per line per voice.
param([string]$Root = $PSScriptRoot)
Add-Type -AssemblyName System.Speech
$lines = (Get-Content "$Root\lines.json" | ConvertFrom-Json).lines
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
Write-Host "voices: $($voices -join ', ')"
foreach ($v in $voices) {
  $dir = "$Root\out\sapi-$($v -replace '[^A-Za-z0-9]','')"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $synth.SelectVoice($v)
  $synth.Rate = 0
  foreach ($l in $lines) {
    $out = "$dir\$($l.chord).wav"
    if (Test-Path $out) { continue }
    $text = if ($l.alt -and $l.alt.sapi) { $l.alt.sapi } else { $l.text }
    $text = $text -replace '!',''
    $synth.SetOutputToWaveFile($out)
    $synth.Speak($text)
  }
}
$synth.SetOutputToNull()
Write-Host "done"
