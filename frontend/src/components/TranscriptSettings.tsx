import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Eye, EyeOff, Lock, Unlock, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';


export interface TranscriptModelProps {
    provider: 'localWhisper' | 'parakeet' | 'remoteWhisper' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
    /** Model ID for the remoteWhisper provider (e.g. "qwen3-asr-1.7b" on LocalAI). */
    remoteModel?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    onModelSelect?: () => void;
}

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
    const [apiKey, setApiKey] = useState<string | null>(transcriptModelConfig.apiKey || null);
    const [showApiKey, setShowApiKey] = useState<boolean>(false);
    const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(true);
    const [isLockButtonVibrating, setIsLockButtonVibrating] = useState<boolean>(false);
    const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);

    // Remote Whisper: local draft for the server URL input, decoupled from
    // transcriptModelConfig so keystrokes don't trigger a Tauri/DB write on every change.
    const [serverUrlDraft, setServerUrlDraft] = useState<string>(
        transcriptModelConfig.provider === 'remoteWhisper' ? transcriptModelConfig.model : ''
    );
    const [serverUrlStatus, setServerUrlStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [serverUrlError, setServerUrlError] = useState<string | null>(null);
    const [healthCheckStatus, setHealthCheckStatus] = useState<'idle' | 'checking' | 'reachable' | 'model-missing' | 'unreachable' | 'error'>('idle');
    const [healthCheckError, setHealthCheckError] = useState<string | null>(null);
    // Remote ASR model ID (multipart `model` field) and optional bearer token.
    const [remoteModelDraft, setRemoteModelDraft] = useState<string>(
        transcriptModelConfig.provider === 'remoteWhisper' ? (transcriptModelConfig.remoteModel || '') : ''
    );
    const [remoteApiKeyDraft, setRemoteApiKeyDraft] = useState<string>(
        transcriptModelConfig.provider === 'remoteWhisper' ? (transcriptModelConfig.apiKey || '') : ''
    );

    // Mirrors the latest transcriptModelConfig without pulling it into the
    // provider-switch effect's dependency array (same pattern as WhisperModelManager's autoSaveRef).
    const transcriptModelConfigRef = useRef(transcriptModelConfig);
    useEffect(() => {
        transcriptModelConfigRef.current = transcriptModelConfig;
    }, [transcriptModelConfig]);

    // Sync uiProvider when backend config changes (e.g., after model selection or initial load)
    useEffect(() => {
        setUiProvider(transcriptModelConfig.provider);
    }, [transcriptModelConfig.provider]);

    // Re-seed the Server URL draft and clear stale feedback whenever the user (re)selects
    // remoteWhisper in the provider dropdown. Only depends on uiProvider so that typing in
    // the field doesn't get clobbered by this effect on every keystroke.
    useEffect(() => {
        if (uiProvider !== 'remoteWhisper') {
            return;
        }
        const current = transcriptModelConfigRef.current;
        setServerUrlDraft(current.provider === 'remoteWhisper' ? current.model : '');
        setRemoteModelDraft(current.provider === 'remoteWhisper' ? (current.remoteModel || '') : '');
        setRemoteApiKeyDraft(current.provider === 'remoteWhisper' ? (current.apiKey || '') : '');
        setServerUrlStatus('idle');
        setServerUrlError(null);
        setHealthCheckStatus('idle');
        setHealthCheckError(null);
    }, [uiProvider]);

    useEffect(() => {
        if (transcriptModelConfig.provider === 'localWhisper' || transcriptModelConfig.provider === 'parakeet' || transcriptModelConfig.provider === 'remoteWhisper') {
            setApiKey(null);
        }
    }, [transcriptModelConfig.provider]);

    const fetchApiKey = async (provider: string) => {
        try {

            const data = await invoke('api_get_transcript_api_key', { provider }) as string;

            setApiKey(data || '');
        } catch (err) {
            console.error('Error fetching API key:', err);
            setApiKey(null);
        }
    };
    const modelOptions = {
        localWhisper: [], // Model selection handled by ModelManager component
        parakeet: [], // Model selection handled by ParakeetModelManager component
        remoteWhisper: [], // URL entered directly, no fixed model list
        deepgram: ['nova-2-phonecall'],
        elevenLabs: ['eleven_multilingual_v2'],
        groq: ['llama-3.3-70b-versatile'],
        openai: ['gpt-4o'],
    };
    const requiresApiKey = transcriptModelConfig.provider === 'deepgram' || transcriptModelConfig.provider === 'elevenLabs' || transcriptModelConfig.provider === 'openai' || transcriptModelConfig.provider === 'groq';

    const handleInputClick = () => {
        if (isApiKeyLocked) {
            setIsLockButtonVibrating(true);
            setTimeout(() => setIsLockButtonVibrating(false), 500);
        }
    };

    const handleWhisperModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'localWhisper', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    const handleParakeetModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'parakeet', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    const isValidServerUrl = (value: string) => /^https?:\/\//i.test(value);

    const trimmedServerUrl = serverUrlDraft.trim();
    const isServerUrlPersisted = transcriptModelConfig.provider === 'remoteWhisper' && transcriptModelConfig.model === trimmedServerUrl;
    const isServerUrlSaveDisabled = !trimmedServerUrl || !isValidServerUrl(trimmedServerUrl) || isServerUrlPersisted || serverUrlStatus === 'saving';

    // Persists the Remote Whisper configuration (URL + model ID + optional API
    // key). Shared by the Save button, blur, and Enter so validation /
    // skip-if-unchanged logic lives in one place. The "model" field is
    // repurposed to hold the base URL for this provider (see engine.rs), which
    // is the existing backend contract; the ASR model ID goes to `remoteModel`.
    const saveServerUrl = async () => {
        const trimmed = serverUrlDraft.trim();
        const trimmedModel = remoteModelDraft.trim();
        const trimmedKey = remoteApiKeyDraft.trim();

        if (trimmed !== serverUrlDraft) {
            setServerUrlDraft(trimmed);
        }

        if (!trimmed) {
            setServerUrlStatus('error');
            setServerUrlError('Server URL is required.');
            return;
        }

        if (!isValidServerUrl(trimmed)) {
            setServerUrlStatus('error');
            setServerUrlError('Server URL must start with http:// or https://.');
            return;
        }

        if (
            transcriptModelConfig.provider === 'remoteWhisper' &&
            transcriptModelConfig.model === trimmed &&
            (transcriptModelConfig.remoteModel || '') === trimmedModel &&
            (transcriptModelConfig.apiKey || '') === trimmedKey
        ) {
            // Nothing changed since the last persisted value - avoid a redundant write.
            setServerUrlStatus('saved');
            setServerUrlError(null);
            return;
        }

        setServerUrlStatus('saving');
        setServerUrlError(null);
        try {
            await invoke('api_save_transcript_config', {
                provider: 'remoteWhisper',
                model: trimmed,
                remoteModel: trimmedModel || null,
                apiKey: trimmedKey || null,
            });
            // Keep provider in sync even if the user only re-selected remoteWhisper
            // without retyping the URL - this was the original persistence gap.
            setTranscriptModelConfig({
                ...transcriptModelConfig,
                provider: 'remoteWhisper',
                model: trimmed,
                remoteModel: trimmedModel || null,
                apiKey: trimmedKey || null,
            });
            setServerUrlStatus('saved');
        } catch (error) {
            console.error('Failed to save remote Whisper configuration:', error);
            setServerUrlStatus('error');
            setServerUrlError(error instanceof Error ? error.message : String(error));
        }
    };

    const testRemoteWhisperConnection = async () => {
        const trimmed = serverUrlDraft.trim();
        const trimmedModel = remoteModelDraft.trim();
        const trimmedKey = remoteApiKeyDraft.trim();

        if (!trimmed) {
            setHealthCheckStatus('error');
            setHealthCheckError('Enter a server URL first.');
            return;
        }

        if (!isValidServerUrl(trimmed)) {
            setHealthCheckStatus('error');
            setHealthCheckError('Server URL must start with http:// or https://.');
            return;
        }

        setHealthCheckStatus('checking');
        setHealthCheckError(null);
        try {
            const report = await invoke<{ reachable: boolean; modelFound: boolean | null }>(
                'remote_whisper_check_health',
                { baseUrl: trimmed, model: trimmedModel || null, apiKey: trimmedKey || null },
            );
            if (!report.reachable) {
                setHealthCheckStatus('unreachable');
            } else if (report.modelFound === false) {
                setHealthCheckStatus('model-missing');
                setHealthCheckError(
                    trimmedModel
                        ? `Model "${trimmedModel}" was not found on this server. Check the model ID.`
                        : 'The configured model was not found on this server.',
                );
            } else {
                setHealthCheckStatus('reachable');
            }
        } catch (error) {
            console.error('Remote Whisper health check failed:', error);
            setHealthCheckStatus('error');
            setHealthCheckError(error instanceof Error ? error.message : String(error));
        }
    };

    return (
        <div>
            <div>
                {/* <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Transcript Settings</h3>
                </div> */}
                <div className="space-y-4 pb-6">
                    <div>
                        <Label className="block text-sm font-medium text-gray-700 mb-1">
                            Transcript Model
                        </Label>
                        <div className="flex space-x-2 mx-1">
                            <Select
                                value={uiProvider}
                                onValueChange={(value) => {
                                    const provider = value as TranscriptModelProps['provider'];
                                    setUiProvider(provider);
                                    if (provider !== 'localWhisper' && provider !== 'parakeet' && provider !== 'remoteWhisper') {
                                        fetchApiKey(provider);
                                    }
                                }}
                            >
                                <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                    <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="parakeet">⚡ Parakeet (Recommended - Real-time / Accurate)</SelectItem>
                                    <SelectItem value="localWhisper">🏠 Local Whisper (High Accuracy)</SelectItem>
                                    <SelectItem value="remoteWhisper">🖥️ Remote Whisper (self-hosted server)</SelectItem>
                                    {/* <SelectItem value="deepgram">☁️ Deepgram (Backup)</SelectItem>
                                    <SelectItem value="elevenLabs">☁️ ElevenLabs</SelectItem>
                                    <SelectItem value="groq">☁️ Groq</SelectItem>
                                    <SelectItem value="openai">☁️ OpenAI</SelectItem> */}
                                </SelectContent>
                            </Select>

                            {uiProvider !== 'localWhisper' && uiProvider !== 'parakeet' && uiProvider !== 'remoteWhisper' && (
                                <Select
                                    value={transcriptModelConfig.model}
                                    onValueChange={(value) => {
                                        const model = value as TranscriptModelProps['model'];
                                        setTranscriptModelConfig({ ...transcriptModelConfig, provider: uiProvider, model });
                                    }}
                                >
                                    <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {modelOptions[uiProvider].map((model) => (
                                            <SelectItem key={model} value={model}>{model}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}

                        </div>
                    </div>

                    {uiProvider === 'localWhisper' && (
                        <div className="mt-6">
                            <ModelManager
                                selectedModel={transcriptModelConfig.provider === 'localWhisper' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleWhisperModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}

                    {uiProvider === 'parakeet' && (
                        <div className="mt-6">
                            <ParakeetModelManager
                                selectedModel={transcriptModelConfig.provider === 'parakeet' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleParakeetModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}

                    {uiProvider === 'remoteWhisper' && (
                        <div>
                            <Label className="block text-sm font-medium text-gray-700 mb-1">
                                Server URL
                            </Label>
                            <Input
                                type="text"
                                className="mx-1 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                value={serverUrlDraft}
                                onChange={(e) => {
                                    setServerUrlDraft(e.target.value);
                                    if (serverUrlStatus !== 'idle') {
                                        setServerUrlStatus('idle');
                                        setServerUrlError(null);
                                    }
                                }}
                                onBlur={() => {
                                    void saveServerUrl();
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void saveServerUrl();
                                    }
                                }}
                                placeholder="http://127.0.0.1:8080 or http://192.168.1.100:8093"
                            />

                            <Label className="block text-sm font-medium text-gray-700 mb-1 mt-4">
                                Model
                            </Label>
                            <Input
                                type="text"
                                className="mx-1 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                value={remoteModelDraft}
                                onChange={(e) => {
                                    setRemoteModelDraft(e.target.value);
                                    if (serverUrlStatus !== 'idle') {
                                        setServerUrlStatus('idle');
                                        setServerUrlError(null);
                                    }
                                }}
                                onBlur={() => {
                                    void saveServerUrl();
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void saveServerUrl();
                                    }
                                }}
                                placeholder="qwen3-asr-1.7b (required for LocalAI, optional for faster-whisper)"
                            />

                            <Label className="block text-sm font-medium text-gray-700 mb-1 mt-4">
                                API Key (optional)
                            </Label>
                            <Input
                                type="password"
                                className="mx-1 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                                value={remoteApiKeyDraft}
                                onChange={(e) => {
                                    setRemoteApiKeyDraft(e.target.value);
                                    if (serverUrlStatus !== 'idle') {
                                        setServerUrlStatus('idle');
                                        setServerUrlError(null);
                                    }
                                }}
                                onBlur={() => {
                                    void saveServerUrl();
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void saveServerUrl();
                                    }
                                }}
                                placeholder="localai — leave empty when the server has no auth"
                            />

                            <div className="mt-2 mx-1 flex items-center gap-2">
                                <Button
                                    type="button"
                                    variant="default"
                                    size="sm"
                                    onClick={() => { void saveServerUrl(); }}
                                    disabled={isServerUrlSaveDisabled}
                                >
                                    {serverUrlStatus === 'saving' ? (
                                        <>
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
                                        </>
                                    ) : (
                                        'Save'
                                    )}
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => { void testRemoteWhisperConnection(); }}
                                    disabled={healthCheckStatus === 'checking'}
                                >
                                    {healthCheckStatus === 'checking' ? (
                                        <>
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing...
                                        </>
                                    ) : (
                                        'Test connection'
                                    )}
                                </Button>
                            </div>

                            <div className="mt-1 mx-1 flex flex-col gap-0.5">
                                {serverUrlStatus === 'saving' && (
                                    <p className="flex items-center gap-1 text-xs text-gray-500">
                                        <Loader2 className="h-3 w-3 animate-spin" /> Saving...
                                    </p>
                                )}
                                {serverUrlStatus === 'saved' && (
                                    <p className="flex items-center gap-1 text-xs text-green-600">
                                        <CheckCircle2 className="h-3 w-3" /> Saved
                                    </p>
                                )}
                                {serverUrlStatus === 'error' && serverUrlError && (
                                    <p className="flex items-center gap-1 text-xs text-red-600">
                                        <XCircle className="h-3 w-3" /> {serverUrlError}
                                    </p>
                                )}

                                {healthCheckStatus === 'reachable' && (
                                    <p className="flex items-center gap-1 text-xs text-green-600">
                                        <CheckCircle2 className="h-3 w-3" /> Server reachable
                                        {remoteModelDraft.trim() && ' · model found'}
                                    </p>
                                )}
                                {healthCheckStatus === 'model-missing' && (
                                    <p className="flex items-center gap-1 text-xs text-amber-600">
                                        <XCircle className="h-3 w-3" /> {healthCheckError || 'Model not found on server'}
                                    </p>
                                )}
                                {healthCheckStatus === 'unreachable' && (
                                    <p className="flex items-center gap-1 text-xs text-red-600">
                                        <XCircle className="h-3 w-3" /> Server did not respond
                                    </p>
                                )}
                                {healthCheckStatus === 'error' && healthCheckError && (
                                    <p className="flex items-center gap-1 text-xs text-red-600">
                                        <XCircle className="h-3 w-3" /> {healthCheckError}
                                    </p>
                                )}
                            </div>

                            <p className="mt-1 mx-1 text-xs text-gray-500">
                                Base URL of an OpenAI-compatible <code>/v1/audio/transcriptions</code> server
                                (e.g. LocalAI, or a self-hosted faster-whisper instance). Both
                                <code> http://host:port</code> and <code>http://host:port/v1</code> are accepted.
                                API key is optional — LocalAI commonly runs without auth.
                            </p>
                        </div>
                    )}


                    {requiresApiKey && (
                        <div>
                            <Label className="block text-sm font-medium text-gray-700 mb-1">
                                API Key
                            </Label>
                            <div className="relative mx-1">
                                <Input
                                    type={showApiKey ? "text" : "password"}
                                    className={`pr-24 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 ${isApiKeyLocked ? 'bg-gray-100 cursor-not-allowed' : ''
                                        }`}
                                    value={apiKey || ''}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    disabled={isApiKeyLocked}
                                    onClick={handleInputClick}
                                    placeholder="Enter your API key"
                                />
                                {isApiKeyLocked && (
                                    <div
                                        onClick={handleInputClick}
                                        className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-50 rounded-md cursor-not-allowed"
                                    />
                                )}
                                <div className="absolute inset-y-0 right-0 pr-1 flex items-center">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setIsApiKeyLocked(!isApiKeyLocked)}
                                        className={`transition-colors duration-200 ${isLockButtonVibrating ? 'animate-vibrate text-red-500' : ''
                                            }`}
                                        title={isApiKeyLocked ? "Unlock to edit" : "Lock to prevent editing"}
                                    >
                                        {isApiKeyLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                    >
                                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div >
    )
}








