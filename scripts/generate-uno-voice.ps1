# Regenerate the bundled energetic UNO call on Windows without network access.
# Run from the project root: powershell -File scripts/generate-uno-voice.ps1
Add-Type -AssemblyName System.Speech
$unoSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $unoSpeaker.SelectVoice('Microsoft Zira Desktop')
    $unoVoicePath = Join-Path $PSScriptRoot '../public/audio/uno.wav'
    $unoSpeaker.SetOutputToWaveFile([System.IO.Path]::GetFullPath($unoVoicePath))
    # Explicit pronunciation and a lifted, prolonged final syllable.
    $unoSpeaker.SpeakSsml(@'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <prosody volume="x-loud" rate="+8%">
    <emphasis level="strong">
      <prosody pitch="+18%"><phoneme alphabet="ipa" ph="u&#x2D0;">U</phoneme></prosody>
      <prosody pitch="+35%" rate="-15%"><phoneme alphabet="ipa" ph="no&#x28A;">no!</phoneme></prosody>
    </emphasis>
  </prosody>
</speak>
'@)
} finally {
    $unoSpeaker.Dispose()
}
