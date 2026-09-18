# LocalAI Qwen3-ASR integration

## Purpose

Meetily uses an external OpenAI-compatible speech-to-text endpoint for
transcription via LocalAI and Qwen3-ASR. This lets a machine with a strong GPU
(in WSL2/Docker) do the transcription while the Meetily desktop app keeps its
one-click "Start Meeting" workflow.

## Architecture

```
Meetily (Tauri app)
  → Remote/OpenAI-compatible ASR provider (remoteWhisper)
  → LocalAI (http://127.0.0.1:8080)
  → Qwen3-ASR-1.7B
  → transcript stored in Meetily
```

The provider is implemented in
`frontend/src-tauri/src/audio/transcription/remote_whisper_provider.rs`. It
implements the same `TranscriptionProvider` trait as the built-in local
Whisper/Parakeet engines, so it plugs into the live recording pipeline
(per-chunk HTTP transcription while recording). It does not replace the
built-in engines — Parakeet and local Whisper remain available in
Settings → Transcription.

## Prerequisites

- LocalAI must be running (e.g. in Docker inside WSL2 with the port published
  to Windows localhost).
- The Qwen3-ASR model must be installed/served: `qwen3-asr-1.7b`.
- The endpoint must answer `/v1/models`.
- Docker/WSL/LocalAI are NOT managed from the Meetily UI: the user must
  provide a reachable URL themselves.

## Configuration (Windows + LocalAI)

In Meetily: Settings → Transcription → provider **Remote Whisper**:

```
Server URL:  http://127.0.0.1:8080        (…/v1 is also accepted — no double /v1)
API key:     localai                       (optional; leave empty when LocalAI has no auth)
Model:       qwen3-asr-1.7b               (required for LocalAI)
```

The same options are offered during onboarding ("Already running your own AI
servers?"). The optional API key is stored locally in the app database, sent
only as an `Authorization: Bearer …` header to the configured server, and never
logged. LocalAI commonly runs without auth — a placeholder value such as
`localai` is harmless.

## Verifying LocalAI (PowerShell)

```powershell
(curl.exe -s http://127.0.0.1:8080/v1/models | ConvertFrom-Json).data.id
# expected: qwen3-asr-1.7b
```

Example transcription request:

```powershell
curl.exe -X POST "http://127.0.0.1:8080/v1/audio/transcriptions" `
  -F "file=@C:\path\to\audio.wav" `
  -F "model=qwen3-asr-1.7b" `
  -F "language=ru" `
  -F "response_format=json"
```

In Meetily, the **Test connection** button performs a safe validation: it
probes the server (no meeting audio is sent) and, when a model ID is
configured, checks that the model appears in `/v1/models`.

## API contract

```
POST {base}/v1/audio/transcriptions
Content-Type: multipart/form-data (boundary set automatically)

file      recorded audio chunk (16 kHz mono PCM16 WAV)
model     configured model ID (e.g. qwen3-asr-1.7b) — required for LocalAI
language  optional ISO-639-1 code ("auto" sentinels are omitted)
Authorization: Bearer <key>  — only when an API key is configured
```

Base URL normalization: `http://host:port`, `http://host:port/`,
`http://host:port/v1` and `http://host:port/v1/` all resolve to
`http://host:port/v1/audio/transcriptions` — a double `/v1/v1` is impossible.

Response: JSON `{"text": "…"}` (extra fields such as `language`, `duration`,
`segments` are ignored). A response without `text` is an error; the existing
transcript is never overwritten with an empty string.

## Troubleshooting

- **Connection refused / HTTP 000** — LocalAI is not running or the WSL2/Docker
  port is not published to Windows localhost. Check `wsl docker ps` and the
  `-p 8080:8080` mapping.
- **Wrong base URL / double `/v1`** — pasting `http://host:8080/v1` is fine
  (normalized); `http://host:8080/nope` is not. Test with the Test button.
- **Model ID mismatch** — `/v1/models` must list the configured model exactly
  (`qwen3-asr-1.7b`).
- **404** — endpoint does not expose `/v1/audio/transcriptions`.
- **401/403** — LocalAI started with `API_KEY` set; configure the same key in
  Meetily.
- **422** — request format rejected (e.g. model field missing on a strict
  server).
- **Timeout** — each chunk has a 60 s budget; a cold Qwen3 model on first
  request can take a while on slower GPUs.
- **CUDA/LocalAI errors** — inspect LocalAI container logs; Meetily only
  surfaces the HTTP error excerpt.

## Security notes

- `127.0.0.1` base URLs are reachable only from the local machine.
- Do not commit the API key; it lives in the local app database only.
- Do not expose LocalAI on an external interface without auth and a reverse
  proxy.
- Do not paste personal transcripts into issues/logs.

## Current limitations

- Live transcription is per-chunk HTTP (non-streaming): audio chunks of a few
  seconds are POSTed during recording. No WebSocket streaming (see upstream
  issue #657).
- No translation: `/v1/audio/translations` is not called; "auto-translate" is
  coerced to auto-detect for this provider.
- Speaker diarization depends on the server response; the remote provider does
  not add its own.
- Long meetings: each request has a 60 s timeout; total meeting length is
  bounded by disk, not by this provider.
- One recording at a time (unchanged Meetily behavior).

## Upstream sync

The durable branch carrying this integration is `feat/localai-qwen3-asr`.
Weekly upstream syncs land via reviewable PRs from `sync/upstream-main-*`
branches (never direct merges into the feature branch).

Manual safe procedure:

```powershell
git remote -v
git fetch upstream --prune
git fetch origin --prune
git checkout feat/localai-qwen3-asr
git pull --ff-only origin feat/localai-qwen3-asr
git checkout -b sync/upstream-main-YYYY-MM-DD
git merge --no-ff upstream/main -m "chore(sync): merge upstream main YYYY-MM-DD"

# on conflict — inspect, resolve manually, never -X ours/-X theirs:
git status
git diff --name-only --diff-filter=U

# after resolving: install deps, typecheck, lint, tests, Rust checks,
# LocalAI/Qwen regression script, build — then open a PR:
#   base: feat/localai-qwen3-asr   head: sync/upstream-main-YYYY-MM-DD
```

Regression protection: `scripts/check-localai-qwen-asr.ps1` (and `.sh` on
Linux) fails when any critical code path (provider, endpoint contract, model
configuration, documentation) goes missing.
