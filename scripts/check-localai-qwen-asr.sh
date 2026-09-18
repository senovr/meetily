#!/usr/bin/env bash
# check-localai-qwen-asr.sh
#
# Regression guard for the LocalAI/Qwen3-ASR remote transcription provider
# (Linux/CI counterpart of check-localai-qwen-asr.ps1). Fails (exit 1) when
# any critical code path or artifact goes missing after an upstream sync.
#
# Usage: bash scripts/check-localai-qwen-asr.sh   (from repo root)

set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
failures=()

assert_contains() {
    local path="$1" pattern="$2" what="$3"
    if [ ! -f "$root/$path" ]; then
        failures+=("MISSING FILE: $path")
        return
    fi
    if ! grep -qF "$pattern" "$root/$path"; then
        failures+=("MISSING in $path: $what")
    fi
}

# 1. Documentation present
[ -f "$root/docs/localai-qwen-asr.md" ] || failures+=("MISSING FILE: docs/localai-qwen-asr.md")

# 2. Remote ASR provider exists and is selectable in the UI
assert_contains 'frontend/src/components/TranscriptSettings.tsx' 'value="remoteWhisper"' 'provider selector entry'

# 3. Endpoint contract: /v1/audio/transcriptions built from normalized base URL
assert_contains 'frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs' '/v1/audio/transcriptions' 'endpoint construction'

# 4. Model ID sent in the multipart form (required by LocalAI)
assert_contains 'frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs' 'form.text("model"' 'multipart model field'

# 5. /v1 double-path normalization present
assert_contains 'frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs' 'normalize_base_url' 'base URL normalization'

# 6. Model + API key persistence columns
assert_contains 'frontend/src-tauri/src/database/repositories/setting.rs' 'remoteWhisperModel' 'model column mapping'
assert_contains 'frontend/src-tauri/src/database/repositories/setting.rs' 'remoteWhisperApiKey' 'api key column mapping'

# 7. Engine dispatch still knows the provider
assert_contains 'frontend/src-tauri/src/audio/transcription/engine.rs' 'remoteWhisper' 'engine dispatch branch'

# 8. Built-in providers untouched
assert_contains 'frontend/src/components/TranscriptSettings.tsx' 'value="parakeet"' 'built-in Parakeet entry'
assert_contains 'frontend/src/components/TranscriptSettings.tsx' 'value="localWhisper"' 'built-in local Whisper entry'

if [ "${#failures[@]}" -gt 0 ]; then
    echo "LocalAI/Qwen3-ASR regression check: FAIL"
    for f in "${failures[@]}"; do
        echo "  - $f"
    done
    exit 1
fi

echo "LocalAI/Qwen3-ASR regression check: PASS (provider, endpoint, model config, docs present)"
exit 0
