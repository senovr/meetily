-- Remote OpenAI-compatible ASR provider (LocalAI / Qwen3-ASR):
-- model ID and optional API key for the "remoteWhisper" transcription provider.
-- The server base URL keeps using the existing `model` column
-- (see RemoteWhisperProvider), so these two columns carry the remaining
-- LocalAI/Qwen3-ASR configuration:
--   remoteWhisperModel    e.g. "qwen3-asr-1.7b"  (multipart `model` field)
--   remoteWhisperApiKey   optional bearer token  (LocalAI commonly runs without auth)
ALTER TABLE transcript_settings ADD COLUMN remoteWhisperModel TEXT;
ALTER TABLE transcript_settings ADD COLUMN remoteWhisperApiKey TEXT;
