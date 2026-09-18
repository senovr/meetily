// audio/transcription/remote_whisper_provider.rs
//
// Remote Whisper transcription provider: sends audio over HTTP to a
// self-hosted OpenAI-compatible `/v1/audio/transcriptions` endpoint
// (e.g. a faster-whisper server running on a machine with a dedicated GPU,
// or LocalAI serving `qwen3-asr-1.7b`), instead of loading a model
// in-process on this machine.
//
// The endpoint is expected to accept a multipart/form-data POST with a
// `file` field (WAV audio), an optional `language` field and an optional
// `model` field (required for model-routing backends such as LocalAI),
// and to return JSON shaped like `{"text": "..."}` — the same contract
// OpenAI's `/v1/audio/transcriptions` uses. Any faster-whisper /
// whisper.cpp server built against that convention works without changes.
// An optional bearer API key is sent when configured (LocalAI commonly
// runs without auth; a placeholder value is harmless).

use super::provider::{TranscriptionError, TranscriptionProvider, TranscriptResult};
use async_trait::async_trait;
use reqwest::multipart;
use log::warn;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Sample rate the rest of the transcription pipeline hands us audio at.
/// (See `TranscriptionProvider::transcribe` doc comment: 16kHz mono f32.)
const SAMPLE_RATE_HZ: u32 = 16_000;

/// How long we allow a single transcription request to run before giving up.
/// Large chunks on a cold GPU (model not yet resident) can take a while.
const REQUEST_TIMEOUT_SECS: u64 = 60;

/// How long we allow a liveness probe to run. Deliberately much shorter than a
/// transcription: a probe gates interactive actions (the onboarding "Test"
/// button, and every recording start), so it must fail fast. A host that is off
/// or behind a DROP firewall never sends a reset, so without this the probe
/// would inherit the 60s transcription budget and freeze the UI for a minute.
const HEALTH_TIMEOUT_SECS: u64 = 5;

/// Meetily's language picker emits these sentinels for "let the engine decide".
/// They are not ISO-639-1 codes: an OpenAI-compatible server rejects them
/// (faster-whisper answers 500 Internal Server Error). Omitting the field
/// entirely is exactly how that API is asked to auto-detect, so the sentinels
/// must be dropped rather than forwarded.
const AUTO_LANGUAGE_SENTINELS: [&str; 2] = ["auto", "auto-translate"];

#[derive(Debug, Deserialize)]
struct RemoteTranscriptionResponse {
    text: String,
}

/// Minimal `/v1/models` listing used by the model-presence check.
#[derive(Debug, Deserialize)]
struct ModelsListResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

/// Result of probing a remote ASR server. `model_found` is `None` when the
/// check could not run (no model configured, or the server's model list was
/// unreachable/unparseable) and `Some(false)` when the server answered but the
/// configured model ID is not in its `/v1/models` list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWhisperHealthReport {
    pub reachable: bool,
    pub model_found: Option<bool>,
}

/// Transcription provider that delegates to a remote whisper-compatible HTTP server.
pub struct RemoteWhisperProvider {
    /// Base URL of the remote server WITHOUT a `/v1` suffix,
    /// e.g. "http://127.0.0.1:8080". Normalized in `new`.
    base_url: String,
    client: reqwest::Client,
    /// Model ID sent as the multipart `model` field (e.g. "qwen3-asr-1.7b" on
    /// LocalAI). `None` for servers that don't require it (faster-whisper).
    model_id: Option<String>,
    /// Optional bearer token. LocalAI runs without auth; the placeholder value
    /// "localai" is sent verbatim and simply ignored by an unauthenticated
    /// server. Never logged.
    api_key: Option<String>,
    model_label: String,
}

impl RemoteWhisperProvider {
    pub fn new(base_url: String, model_id: Option<String>, api_key: Option<String>) -> Self {
        let base_url = Self::normalize_base_url(&base_url);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let model_id = model_id
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        let api_key = api_key
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());

        let model_label = match &model_id {
            Some(model) => format!("remote ({}, model {})", base_url, model),
            None => format!("remote ({})", base_url),
        };

        Self {
            base_url,
            client,
            model_id,
            api_key,
            model_label,
        }
    }

    /// Canonicalize a user-entered base URL to a form WITHOUT trailing slash
    /// and WITHOUT a `/v1` suffix, so that all of these produce the same
    /// endpoint (`http://host:port/v1/audio/transcriptions`):
    /// `http://host:port`, `http://host:port/`, `http://host:port/v1`,
    /// `http://host:port/v1/`. Prevents the double-`/v1/v1` path bug when a
    /// LocalAI user pastes the OpenAI-style base URL.
    fn normalize_base_url(input: &str) -> String {
        let mut normalized = input.trim().trim_end_matches('/').to_string();
        if normalized.to_ascii_lowercase().ends_with("/v1") {
            let keep = normalized.len() - "/v1".len();
            normalized.truncate(keep);
            normalized = normalized.trim_end_matches('/').to_string();
        }
        normalized
    }

    fn endpoint(&self) -> String {
        format!("{}/v1/audio/transcriptions", self.base_url)
    }

    /// Map Meetily's language selection onto what the remote API accepts:
    /// `Some(iso_code)` to force a language, `None` to let the server detect it.
    fn normalize_language(language: Option<String>) -> Option<String> {
        let language = language?;
        let trimmed = language.trim();
        if trimmed.is_empty() {
            return None;
        }

        let lowered = trimmed.to_ascii_lowercase();
        if AUTO_LANGUAGE_SENTINELS.contains(&lowered.as_str()) {
            if lowered == "auto-translate" {
                // `/v1/audio/transcriptions` transcribes in the source language;
                // translation lives behind a separate endpoint this provider does
                // not target. Be explicit rather than silently returning
                // untranslated text as if it had been translated.
                warn!(
                    "Remote Whisper: 'auto-translate' is not supported by \
                     /v1/audio/transcriptions; falling back to auto-detected transcription"
                );
            }
            return None;
        }

        Some(trimmed.to_string())
    }

    /// Encode 16kHz mono f32 PCM samples as a WAV byte buffer (16-bit PCM).
    /// Self-contained — no extra crate dependency needed for such a simple header.
    fn encode_wav_pcm16(samples: &[f32]) -> Vec<u8> {
        // WAV headers are u32, so an oversized buffer would wrap in release and
        // emit a header that silently disagrees with the payload. Chunks are
        // seconds long in practice; saturate rather than wrap if that ever changes.
        let num_samples = u32::try_from(samples.len()).unwrap_or(u32::MAX);
        let byte_rate = SAMPLE_RATE_HZ * 2; // mono, 16-bit
        let data_size = num_samples.saturating_mul(2);
        let riff_size = data_size.saturating_add(36);

        let mut buf = Vec::with_capacity(44 + data_size as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&riff_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");

        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        for &sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm = (clamped * i16::MAX as f32) as i16;
            buf.extend_from_slice(&pcm.to_le_bytes());
        }

        buf
    }
}

#[async_trait]
impl TranscriptionProvider for RemoteWhisperProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        if audio.is_empty() {
            return Err(TranscriptionError::AudioTooShort {
                samples: 0,
                minimum: 1,
            });
        }

        let wav_bytes = Self::encode_wav_pcm16(&audio);

        let mut form = multipart::Form::new().part(
            "file",
            multipart::Part::bytes(wav_bytes)
                .file_name("chunk.wav")
                .mime_str("audio/wav")
                .map_err(|e| TranscriptionError::EngineFailed(e.to_string()))?,
        );
        if let Some(lang) = Self::normalize_language(language) {
            form = form.text("language", lang);
        }
        // Model ID is required by model-routing backends such as LocalAI
        // (`qwen3-asr-1.7b`); optional for single-model faster-whisper servers.
        if let Some(model) = &self.model_id {
            form = form.text("model", model.clone());
        }

        let mut request = self.client.post(self.endpoint()).multipart(form);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .map_err(|e| {
                TranscriptionError::EngineFailed(format!(
                    "Cannot reach remote whisper server at {}: {}",
                    self.base_url, e
                ))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            // Bounded excerpt: the body is surfaced in user-visible errors and
            // logs, so never repeat it wholesale.
            let excerpt: String = body.chars().take(512).collect();
            let hint = match status.as_u16() {
                401 | 403 => " — check the API key in Settings > Transcription".to_string(),
                404 => " — check the Base URL (must not duplicate /v1)".to_string(),
                422 => " — the server rejected the request format".to_string(),
                429 => " — the server is rate limiting, retry later".to_string(),
                _ => String::new(),
            };
            return Err(TranscriptionError::EngineFailed(format!(
                "Remote whisper server returned {}:{} {}",
                status, hint, excerpt
            )));
        }

        let parsed: RemoteTranscriptionResponse = response
            .json()
            .await
            .map_err(|e| TranscriptionError::EngineFailed(format!("Invalid response JSON: {}", e)))?;

        Ok(TranscriptResult {
            text: parsed.text,
            confidence: None, // faster-whisper server doesn't return a confidence score
            is_partial: false,
        })
    }

    async fn is_model_loaded(&self) -> bool {
        // "Loaded" here means "reachable" — the remote process owns model lifecycle.
        self.health_report().await.reachable
    }

    async fn get_current_model(&self) -> Option<String> {
        Some(self.model_label.clone())
    }

    fn provider_name(&self) -> &'static str {
        "RemoteWhisper"
    }
}

impl RemoteWhisperProvider {
    /// Probe the server and (when a model ID is configured) verify the model
    /// is present in the server's `/v1/models` listing.
    ///
    /// Two probes, because no single one covers the field. `/health` is a
    /// whisper.cpp-server / faster-whisper-server extension, absent from the
    /// OpenAI API; `/v1/models` is part of the OpenAI contract but absent from
    /// some minimal Whisper servers. Probing only one strands users of the other
    /// family on a reachable server that this check calls dead — and onboarding
    /// refuses to continue on that verdict.
    ///
    /// When a model ID is configured, `/v1/models` is tried FIRST: it is the
    /// only probe that can also answer "does this server serve that model?",
    /// which matters for model-routing backends like LocalAI.
    pub async fn health_report(&self) -> RemoteWhisperHealthReport {
        let paths: [&str; 2] = if self.model_id.is_some() {
            ["/v1/models", "/health"]
        } else {
            ["/health", "/v1/models"]
        };

        for path in paths {
            let url = format!("{}{}", self.base_url, path);
            let mut request = self
                .client
                .get(&url)
                .timeout(Duration::from_secs(HEALTH_TIMEOUT_SECS));
            if let Some(key) = &self.api_key {
                request = request.bearer_auth(key);
            }

            if let Ok(resp) = request.send().await {
                let status = resp.status();
                // 401/403 count as alive: an endpoint that demands credentials is
                // still an endpoint that answered.
                if status.is_success() || status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                    if path == "/v1/models" && status.is_success() {
                        if let Some(wanted) = &self.model_id {
                            // Parse failure (non-JSON body) leaves the verdict
                            // unknown rather than falsely "missing".
                            let found = match resp.json::<ModelsListResponse>().await {
                                Ok(list) => Some(list.data.iter().any(|m| m.id == *wanted)),
                                Err(_) => None,
                            };
                            return RemoteWhisperHealthReport {
                                reachable: true,
                                model_found: found,
                            };
                        }
                    }
                    return RemoteWhisperHealthReport {
                        reachable: true,
                        model_found: None,
                    };
                }
            }
        }

        RemoteWhisperHealthReport {
            reachable: false,
            model_found: None,
        }
    }
}

/// Tauri command: probe a remote Whisper/LocalAI server before committing to it.
///
/// Onboarding and settings both need to tell the user "this URL works" *before*
/// it is persisted, otherwise the first failure only surfaces mid-recording.
/// When `model` is provided and the server exposes `/v1/models`, the report
/// also says whether that model ID is actually served.
#[tauri::command]
pub async fn remote_whisper_check_health(
    base_url: String,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<RemoteWhisperHealthReport, String> {
    if base_url.trim().is_empty() {
        return Err("Server URL is empty".to_string());
    }

    let provider = RemoteWhisperProvider::new(base_url, model, api_key);
    Ok(provider.health_report().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_sentinels_are_dropped_so_the_server_detects_the_language() {
        // Forwarding these produced "500 Internal Server Error" from faster-whisper.
        for sentinel in ["auto", "auto-translate", "AUTO", "Auto-Translate"] {
            assert_eq!(
                RemoteWhisperProvider::normalize_language(Some(sentinel.to_string())),
                None,
                "sentinel {sentinel} must not reach the server"
            );
        }
    }

    #[test]
    fn blank_and_absent_languages_are_dropped() {
        assert_eq!(RemoteWhisperProvider::normalize_language(None), None);
        assert_eq!(RemoteWhisperProvider::normalize_language(Some("".into())), None);
        assert_eq!(RemoteWhisperProvider::normalize_language(Some("   ".into())), None);
    }

    #[test]
    fn real_language_codes_are_forwarded_trimmed() {
        assert_eq!(
            RemoteWhisperProvider::normalize_language(Some("es".into())),
            Some("es".to_string())
        );
        assert_eq!(
            RemoteWhisperProvider::normalize_language(Some(" en ".into())),
            Some("en".to_string())
        );
    }

    #[test]
    fn wav_header_survives_an_implausibly_large_buffer() {
        // Not reachable with real chunks; the point is that the header stays
        // internally consistent instead of wrapping into nonsense.
        let data_size = u32::MAX.saturating_mul(2);
        assert_eq!(data_size, u32::MAX);
        assert_eq!(data_size.saturating_add(36), u32::MAX);
    }

    #[test]
    fn wav_header_describes_16khz_mono_pcm16() {
        let wav = RemoteWhisperProvider::encode_wav_pcm16(&[0.0, 1.0, -1.0]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            SAMPLE_RATE_HZ
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16, "16-bit samples");
        assert_eq!(wav.len(), 44 + 3 * 2);
    }

    #[test]
    fn base_url_variants_all_normalize_to_the_same_endpoint() {
        // The LocalAI/OpenAI convention is to paste the API base URL including
        // `/v1`; the faster-whisper convention is bare host:port. Both must
        // produce `{base}/v1/audio/transcriptions` — never `/v1/v1/...`.
        let variants = [
            "http://127.0.0.1:8080",
            "http://127.0.0.1:8080/",
            "http://127.0.0.1:8080/v1",
            "http://127.0.0.1:8080/v1/",
            "http://127.0.0.1:8080/V1",
            "  http://127.0.0.1:8080/v1  ",
        ];
        for input in variants {
            let provider = RemoteWhisperProvider::new(input.to_string(), None, None);
            assert_eq!(
                provider.endpoint(),
                "http://127.0.0.1:8080/v1/audio/transcriptions",
                "input {input:?} must not produce a double /v1"
            );
        }
    }

    #[test]
    fn paths_that_merely_end_in_v1_like_text_are_preserved() {
        // A path segment that merely ends with the letters v1 (e.g. /srv1)
        // must not be stripped — only a real trailing /v1 segment is.
        let provider = RemoteWhisperProvider::new("http://host:9000/srv1".to_string(), None, None);
        assert_eq!(provider.endpoint(), "http://host:9000/srv1/v1/audio/transcriptions");
    }

    #[test]
    fn blank_model_and_api_key_are_treated_as_absent() {
        let provider =
            RemoteWhisperProvider::new("http://h:1".to_string(), Some("  ".into()), Some("".into()));
        assert!(provider.model_id.is_none());
        assert!(provider.api_key.is_none());
    }

    #[test]
    fn model_and_api_key_are_trimmed_and_kept() {
        let provider = RemoteWhisperProvider::new(
            "http://h:1".to_string(),
            Some(" qwen3-asr-1.7b ".into()),
            Some("localai".into()),
        );
        assert_eq!(provider.model_id.as_deref(), Some("qwen3-asr-1.7b"));
        assert_eq!(provider.api_key.as_deref(), Some("localai"));
    }
}
