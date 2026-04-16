type TranscribeAudioParams = {
 audioUrl: string;
 apiKeys: string[];
 activeKeyIndex?: number;
 titleHint?: string;
 signal?: AbortSignal;
 model?: string;
 onStatusChange?: (text: string) => void;
 onActiveKeyChange?: (index: number) => void;
 onPersistActiveKey?: (index: number) => void;
};

type UploadResult = {
 name: string;
 uri: string;
 mimeType: string;
};

type GeminiFileResponse = {
 file?: {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
 };
 name?: string;
 uri?: string;
 mimeType?: string;
 state?: string;
};

type GeminiGenerateResponse = {
 candidates?: Array<{
  content?: {
   parts?: Array<{
    text?: string;
   }>;
  };
 }>;
 error?: {
  message?: string;
 };
};

const GEMINI_AUDIO_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"] as const;
const INLINE_AUDIO_LIMIT = 18 * 1024 * 1024;
const MAX_AUTO_RETRY_MS = 1000 * 60 * 30;

export const transcribeAudioWithGemini = async ({
 audioUrl,
 apiKeys,
 activeKeyIndex = 0,
 titleHint = "",
 signal,
 model,
 onStatusChange,
 onActiveKeyChange,
 onPersistActiveKey,
}: TranscribeAudioParams) => {
 if (apiKeys.length === 0) {
  throw new Error("저장된 Gemini API 키가 없습니다.");
 }

 const audioResponse = await fetch(audioUrl, {
  method: "GET",
  signal,
  cache: "no-store",
 });

 if (!audioResponse.ok) {
  throw new Error(`오디오 파일을 불러오지 못했습니다. (${audioResponse.status})`);
 }

 const audioBlob = await audioResponse.blob();
 const mimeType = audioBlob.type || guessMimeTypeFromUrl(audioUrl) || "audio/mp4";
 const models = model ? [model, ...GEMINI_AUDIO_MODELS.filter((item) => item !== model)] : [...GEMINI_AUDIO_MODELS];
 let currentActiveKeyIndex = activeKeyIndex;

 if (audioBlob.size <= INLINE_AUDIO_LIMIT) {
  return runWithModelAndKeyFallbackAndRetry({
   models,
   apiKeys,
   activeKeyIndex: currentActiveKeyIndex,
   signal,
   onStatusChange,
   onActiveKeyChange: (nextIndex) => {
    currentActiveKeyIndex = nextIndex;
    onActiveKeyChange?.(nextIndex);
   },
   onPersistActiveKey,
   runner: async ({ model: currentModel, apiKey: currentKey }) => {
    return requestInlineAudioTranscript({
     audioBlob,
     mimeType,
     apiKey: currentKey,
     model: currentModel,
     titleHint,
     signal,
    });
   },
  });
 }

 for (let keyLoop = 0; keyLoop < apiKeys.length; keyLoop += 1) {
  const currentKeyIndex = (currentActiveKeyIndex + keyLoop) % apiKeys.length;
  const currentKey = apiKeys[currentKeyIndex];

  for (let attempt = 0; attempt < 2; attempt += 1) {
   const uploadedFile = await uploadFileToGemini({
    audioBlob,
    mimeType,
    apiKey: currentKey,
    displayName: extractFileName(audioUrl),
    signal,
   });

   try {
    await waitForFileReady({
     name: uploadedFile.name,
     apiKey: currentKey,
     signal,
    });

    const result = await runWithModelAndKeyFallbackAndRetry({
     models,
     apiKeys: [currentKey],
     activeKeyIndex: 0,
     signal,
     onStatusChange,
     onActiveKeyChange: () => {},
     onPersistActiveKey: () => {},
     runner: async ({ model: currentModel, apiKey: runnerKey }) => {
      return requestUploadedAudioTranscript({
       fileUri: uploadedFile.uri,
       mimeType: uploadedFile.mimeType,
       apiKey: runnerKey,
       model: currentModel,
       titleHint,
       signal,
      });
     },
    });

    onActiveKeyChange?.(currentKeyIndex);
    onPersistActiveKey?.(currentKeyIndex);
    return result;
   } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
     throw error;
    }

    const message = error instanceof Error ? error.message : "";

    if (isFilePermissionError(message) && attempt < 1) {
     onStatusChange?.("파일 접근 오류로 재업로드 후 재시도 중");
     await sleep(1500);
     continue;
    }

    if (isFilePermissionError(message)) {
     onStatusChange?.("다음 키로 재시도 중");
     break;
    }

    throw error;
   } finally {
    await deleteGeminiFile({
     name: uploadedFile.name,
     apiKey: currentKey,
     signal,
    }).catch(() => {});
   }
  }
 }

 throw new Error("Gemini Files 처리에 실패했습니다.");
};

const runWithModelAndKeyFallbackAndRetry = async ({
 models,
 apiKeys,
 activeKeyIndex,
 signal,
 onStatusChange,
 onActiveKeyChange,
 onPersistActiveKey,
 runner,
}: {
 models: string[];
 apiKeys: string[];
 activeKeyIndex: number;
 signal?: AbortSignal;
 onStatusChange?: (text: string) => void;
 onActiveKeyChange?: (index: number) => void;
 onPersistActiveKey?: (index: number) => void;
 runner: (params: { model: string; apiKey: string; keyIndex: number }) => Promise<string>;
}) => {
 const startedAt = Date.now();
 const triedMessages: string[] = [];
 let modelIndex = 0;

 while (true) {
  if (signal?.aborted) {
   throw new DOMException("Aborted", "AbortError");
  }

  const currentModel = models[Math.min(modelIndex, models.length - 1)];
  let lastRetrySeconds: number | null = null;

  for (let keyLoop = 0; keyLoop < apiKeys.length; keyLoop += 1) {
   const currentKeyIndex = (activeKeyIndex + keyLoop) % apiKeys.length;
   const currentKey = apiKeys[currentKeyIndex];

   try {
    onStatusChange?.(modelIndex === 0 && keyLoop === 0 ? "음성 인식 중" : `음성 인식 중 (${currentModel} · 키 ${currentKeyIndex + 1})`);

    const result = await runner({
     model: currentModel,
     apiKey: currentKey,
     keyIndex: currentKeyIndex,
    });

    onActiveKeyChange?.(currentKeyIndex);
    onPersistActiveKey?.(currentKeyIndex);
    return result;
   } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
     throw error;
    }

    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    triedMessages.push(`KEY ${currentKeyIndex + 1} · ${currentModel} · ${message}`);

    if (isRetryableQuotaError(message)) {
     const retrySeconds = extractRetrySeconds(message) ?? getBackoffSeconds(Date.now() - startedAt);
     lastRetrySeconds = retrySeconds;
     onStatusChange?.(`${Math.ceil(retrySeconds)}초 뒤 다음 키로 재시도`);
     await sleep((retrySeconds + 1) * 1000);
     continue;
    }

    if (isFilePermissionError(message)) {
     onStatusChange?.("파일 접근 오류로 다음 키 시도 중");
     await sleep(1000);
     continue;
    }

    if (modelIndex < models.length - 1) {
     break;
    }

    throw error;
   }
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed >= MAX_AUTO_RETRY_MS) {
   throw new Error(`음성 인식 자동 재시도 시간이 초과되었습니다.\n${triedMessages.join("\n")}`);
  }

  if (modelIndex < models.length - 1) {
   modelIndex += 1;
   onStatusChange?.(`다른 모델로 재시도 중 (${models[modelIndex]})`);
   await sleep(1200);
   continue;
  }

  const retrySeconds = lastRetrySeconds ?? getBackoffSeconds(elapsed);
  onStatusChange?.(`${Math.ceil(retrySeconds)}초 뒤 자동 재시도`);
  await sleep((retrySeconds + 1) * 1000);
 }
};

const requestInlineAudioTranscript = async ({
 audioBlob,
 mimeType,
 apiKey,
 model,
 titleHint,
 signal,
}: {
 audioBlob: Blob;
 mimeType: string;
 apiKey: string;
 model: string;
 titleHint: string;
 signal?: AbortSignal;
}) => {
 const audioBase64 = await blobToBase64(audioBlob);
 const prompt = buildTranscriptPrompt(titleHint);

 const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
  method: "POST",
  headers: {
   "Content-Type": "application/json",
  },
  body: JSON.stringify({
   contents: [
    {
     parts: [
      { text: prompt },
      {
       inline_data: {
        mime_type: mimeType,
        data: audioBase64,
       },
      },
     ],
    },
   ],
   generationConfig: {
    temperature: 0,
   },
  }),
  signal,
 });

 const data = (await response.json().catch(() => null)) as GeminiGenerateResponse | null;

 if (!response.ok) {
  throw new Error(extractGeminiErrorMessage(data, response.status));
 }

 const text = extractGeminiText(data);

 if (!text) {
  throw new Error("Gemini STT 응답이 비어 있습니다.");
 }

 return normalizeTranscriptText(text);
};

const requestUploadedAudioTranscript = async ({
 fileUri,
 mimeType,
 apiKey,
 model,
 titleHint,
 signal,
}: {
 fileUri: string;
 mimeType: string;
 apiKey: string;
 model: string;
 titleHint: string;
 signal?: AbortSignal;
}) => {
 const prompt = buildTranscriptPrompt(titleHint);

 const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
  method: "POST",
  headers: {
   "Content-Type": "application/json",
  },
  body: JSON.stringify({
   contents: [
    {
     parts: [
      { text: prompt },
      {
       file_data: {
        mime_type: mimeType,
        file_uri: fileUri,
       },
      },
     ],
    },
   ],
   generationConfig: {
    temperature: 0,
   },
  }),
  signal,
 });

 const data = (await response.json().catch(() => null)) as GeminiGenerateResponse | null;

 if (!response.ok) {
  throw new Error(extractGeminiErrorMessage(data, response.status));
 }

 const text = extractGeminiText(data);

 if (!text) {
  throw new Error("Gemini STT 응답이 비어 있습니다.");
 }

 return normalizeTranscriptText(text);
};

const uploadFileToGemini = async ({
 audioBlob,
 mimeType,
 apiKey,
 displayName,
 signal,
}: {
 audioBlob: Blob;
 mimeType: string;
 apiKey: string;
 displayName: string;
 signal?: AbortSignal;
}): Promise<UploadResult> => {
 const startResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
  method: "POST",
  headers: {
   "X-Goog-Upload-Protocol": "resumable",
   "X-Goog-Upload-Command": "start",
   "X-Goog-Upload-Header-Content-Length": String(audioBlob.size),
   "X-Goog-Upload-Header-Content-Type": mimeType,
   "Content-Type": "application/json",
  },
  body: JSON.stringify({
   file: {
    display_name: displayName,
   },
  }),
  signal,
 });

 if (!startResponse.ok) {
  const data = (await startResponse.json().catch(() => null)) as GeminiGenerateResponse | null;
  throw new Error(extractGeminiErrorMessage(data, startResponse.status));
 }

 const uploadUrl = startResponse.headers.get("x-goog-upload-url");

 if (!uploadUrl) {
  throw new Error("Gemini Files 업로드 URL을 받지 못했습니다.");
 }

 const uploadResponse = await fetch(uploadUrl, {
  method: "POST",
  headers: {
   "X-Goog-Upload-Offset": "0",
   "X-Goog-Upload-Command": "upload, finalize",
   "Content-Length": String(audioBlob.size),
  },
  body: audioBlob,
  signal,
 });

 const uploadData = (await uploadResponse.json().catch(() => null)) as GeminiFileResponse | null;

 if (!uploadResponse.ok) {
  throw new Error(extractGeminiErrorMessage(uploadData, uploadResponse.status));
 }

 const file = uploadData && typeof uploadData === "object" && uploadData.file ? uploadData.file : uploadData;

 if (!file || typeof file !== "object") {
  throw new Error("Gemini Files 업로드 결과를 읽지 못했습니다.");
 }

 const name = typeof file.name === "string" ? file.name : "";
 const uri = typeof file.uri === "string" ? file.uri : "";
 const uploadedMimeType = typeof file.mimeType === "string" ? file.mimeType : mimeType;

 if (!name || !uri) {
  throw new Error("Gemini Files 업로드 결과가 올바르지 않습니다.");
 }

 return {
  name,
  uri,
  mimeType: uploadedMimeType,
 };
};

const waitForFileReady = async ({ name, apiKey, signal }: { name: string; apiKey: string; signal?: AbortSignal }) => {
 for (let i = 0; i < 40; i += 1) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(apiKey)}`, {
   method: "GET",
   signal,
   cache: "no-store",
  });

  const data = (await response.json().catch(() => null)) as GeminiFileResponse | null;

  if (!response.ok) {
   throw new Error(extractGeminiErrorMessage(data, response.status));
  }

  const file = data && typeof data === "object" && data.file ? data.file : data;
  const state = typeof file?.state === "string" ? file.state : "";

  if (!state || state === "ACTIVE") {
   return;
  }

  if (state !== "PROCESSING") {
   throw new Error(`Gemini Files 상태가 비정상적입니다: ${state}`);
  }

  await sleep(1500);
 }

 throw new Error("Gemini Files 준비 시간이 초과되었습니다.");
};

const deleteGeminiFile = async ({ name, apiKey, signal }: { name: string; apiKey: string; signal?: AbortSignal }) => {
 await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(apiKey)}`, {
  method: "DELETE",
  signal,
 });
};

const buildTranscriptPrompt = (titleHint: string) => {
 const normalizedTitleHint = titleHint.trim();

 return [
  "다음 오디오의 들리는 말만 보수적으로 전사하세요.",
  "설명, 요약, 해설, 제목, 머리말 없이 전사 텍스트만 출력하세요.",
  "들리지 않거나 확실하지 않은 부분은 추측해서 채우지 말고 생략하세요.",
  "외부 지식, 기억, 알려진 가사를 이용해 보완하지 마세요.",
  "같은 구절의 반복은 실제로 다시 또렷하게 들릴 때만 적고, 반복을 추정해서 늘리지 마세요.",
  "문장 순서를 유지하세요.",
  normalizedTitleHint ? `제목 힌트: ${normalizedTitleHint}` : "",
 ]
  .filter(Boolean)
  .join("\n");
};

const extractGeminiText = (data: unknown) => {
 if (!data || typeof data !== "object") return "";

 const candidates = "candidates" in data && Array.isArray(data.candidates) ? data.candidates : [];
 const firstCandidate = candidates[0];

 if (!firstCandidate || typeof firstCandidate !== "object") return "";

 const content = "content" in firstCandidate ? firstCandidate.content : null;
 if (!content || typeof content !== "object") return "";

 const parts = "parts" in content && Array.isArray(content.parts) ? content.parts : [];

 return parts
  .map((part: unknown) => {
   if (!part || typeof part !== "object") return "";
   return "text" in part && typeof part.text === "string" ? part.text : "";
  })
  .join("")
  .trim();
};

const extractGeminiErrorMessage = (data: unknown, status: number) => {
 if (
  data &&
  typeof data === "object" &&
  "error" in data &&
  data.error &&
  typeof data.error === "object" &&
  "message" in data.error &&
  typeof data.error.message === "string"
 ) {
  return data.error.message;
 }

 return `Gemini 요청 실패 (${status})`;
};

const isFilePermissionError = (message: string) => {
 const lower = message.toLowerCase();

 return lower.includes("you do not have permission to access the file") || lower.includes("permission_denied") || lower.includes("may not exist");
};

const isRetryableQuotaError = (message: string) => {
 const lower = message.toLowerCase();

 return (
  lower.includes("quota exceeded") ||
  lower.includes("resource exhausted") ||
  lower.includes("rate limit") ||
  lower.includes("please retry in") ||
  lower.includes("too many requests")
 );
};

const extractRetrySeconds = (message: string) => {
 const match = message.match(/Please retry in\s+([\d.]+)s/i);
 if (!match) return null;

 const seconds = Math.ceil(Number(match[1]));
 if (!Number.isFinite(seconds) || seconds <= 0) return null;

 return seconds;
};

const getBackoffSeconds = (elapsedMs: number) => {
 if (elapsedMs < 1000 * 60 * 3) return 15;
 if (elapsedMs < 1000 * 60 * 10) return 30;
 return 60;
};

const blobToBase64 = async (blob: Blob) => {
 const buffer = await blob.arrayBuffer();
 const bytes = new Uint8Array(buffer);
 let binary = "";
 const chunkSize = 0x8000;

 for (let i = 0; i < bytes.length; i += chunkSize) {
  const chunk = bytes.subarray(i, i + chunkSize);
  binary += String.fromCharCode(...chunk);
 }

 return btoa(binary);
};

const normalizeTranscriptText = (text: string) => {
 return text
  .replace(/\r/g, "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .join("\n")
  .trim();
};

const extractFileName = (audioUrl: string) => {
 try {
  const url = new URL(audioUrl);
  const lastSegment = url.pathname.split("/").pop() || "audio-file";
  return decodeURIComponent(lastSegment);
 } catch {
  return "audio-file";
 }
};

const guessMimeTypeFromUrl = (audioUrl: string) => {
 const lower = audioUrl.toLowerCase();

 if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
 if (lower.endsWith(".webm")) return "audio/webm";
 if (lower.endsWith(".mp3")) return "audio/mpeg";
 if (lower.endsWith(".wav")) return "audio/wav";
 if (lower.endsWith(".ogg")) return "audio/ogg";
 if (lower.endsWith(".flac")) return "audio/flac";

 return "";
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
