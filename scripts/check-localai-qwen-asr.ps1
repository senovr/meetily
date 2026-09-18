# check-localai-qwen-asr.ps1
#
# Regression guard for the LocalAI/Qwen3-ASR remote transcription provider.
# Fails (exit 1) when any critical code path or artifact goes missing after an
# upstream sync. This is a supplement to real unit tests, not a replacement.
#
# Usage: pwsh -File scripts/check-localai-qwen-asr.ps1   (from repo root)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$failures = @()

function Assert-FileContains {
    param([string]$Path, [string]$Pattern, [string]$What)
    if (-not (Test-Path (Join-Path $root $Path))) {
        $script:failures += "MISSING FILE: $Path"
        return
    }
    $content = Get-Content (Join-Path $root $Path) -Raw
    if ($content -notmatch [regex]::Escape($Pattern)) {
        $script:failures += "MISSING in ${Path}: $What"
    }
}

# 1. Documentation present
if (-not (Test-Path (Join-Path $root 'docs/localai-qwen-asr.md'))) {
    $failures += 'MISSING FILE: docs/localai-qwen-asr.md'
}

# 2. Remote ASR provider exists and is selectable in the UI
Assert-FileContains 'frontend/src/components/TranscriptSettings.tsx' 'value="remoteWhisper"' 'provider selector entry'

# 3. Endpoint contract: /v1/audio/transcriptions built from normalized base URL
Assert-FileContains 'frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs' '/v1/audio/transcriptions' 'endpoint construction'

# 4. Model ID sent in the multipart form (required by LocalAI)
Assert-FileContains 'frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs' 'form.text("model"' 'multipart model field'

# 5. /v1 double-path normalization present
Assert-FileContains 'frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs' 'normalize_base_url' 'base URL normalization'

# 6. Model + API key persistence columns
Assert-FileContains 'frontend/src-tauri/src/database/repositories/setting.rs' 'remoteWhisperModel' 'model column mapping'
Assert-FileContains 'frontend/src-tauri/src/database/repositories/setting.rs' 'remoteWhisperApiKey' 'api key column mapping'

# 7. Engine dispatch still knows the provider
Assert-FileContains 'frontend/src-tauri/src/audio/transcription/engine.rs' 'remoteWhisper' 'engine dispatch branch'

# 8. Built-in providers untouched
Assert-FileContains 'frontend/src/components/TranscriptSettings.tsx' 'value="parakeet"' 'built-in Parakeet entry'
Assert-FileContains 'frontend/src/components/TranscriptSettings.tsx' 'value="localWhisper"' 'built-in local Whisper entry'

if ($failures.Count -gt 0) {
    Write-Output 'LocalAI/Qwen3-ASR regression check: FAIL'
    $failures | ForEach-Object { Write-Output "  - $_" }
    exit 1
}

Write-Output 'LocalAI/Qwen3-ASR regression check: PASS (provider, endpoint, model config, docs present)'
exit 0
