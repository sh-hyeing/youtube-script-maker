"use client";

import { jsPDF } from "jspdf";
import { useEffect, useMemo, useRef, useState } from "react";
import { dedupePairs, processChunks, type ContentMode, type ScriptPair } from "@/lib/gemini";
import { downloadStudyScriptPdf } from "@/lib/pdf";
import { transcribeAudioWithGemini } from "@/lib/clientGeminiStt";

type TranscriptResponse = {
 normalizedUrl: string;
 transcriptText: string;
 transcriptChunks: string[];
 chunkCount: number;
 title?: string;
 fileName?: string;
 durationSeconds?: number;
 sttMode?: string;
 transcriptSource?: string;
 needsClientStt?: boolean;
 audioUrl?: string;
 audioMimeType?: string;
 audioSegments?: Array<{
  url?: string;
  mimeType?: string;
  index?: number;
  startSeconds?: number;
  endSeconds?: number;
 }>;
 expiresAt?: number;
};

type ViewMode = "bilingual" | "english" | "korean";

const isSongLikeContent = (value: string) => {
 const text = value.toLowerCase();

 const strongSongKeywords = [
  "lyrics",
  "lyric video",
  "official audio",
  "official mv",
  "music video",
  "visualizer",
  "live clip",
  "ost",
  "soundtrack",
  "karaoke",
  "cover",
  "remix",
 ];

 return strongSongKeywords.some((keyword) => text.includes(keyword));
};

const isConversationLikeContent = (value: string) => {
 const text = value.toLowerCase();
 const conversationKeywords = [
  "interview",
  "podcast",
  "conversation",
  "dialogue",
  "dialog",
  "movie",
  "film",
  "scene",
  "drama",
  "clip",
  "vlog",
  "q&a",
  "qa",
  "talk",
 ];

 return conversationKeywords.some((keyword) => text.includes(keyword));
};

const getRunModelConfig = ({
 title,
 fileName,
 chunkCount,
 transcriptPreview,
}: {
 title?: string;
 fileName?: string;
 chunkCount: number;
 transcriptPreview?: string;
}) => {
 const sourceText = `${title || ""} ${fileName || ""}`.trim();
 const isSong = isSongLikeContent(sourceText);
 const isConversation = !isSong && isConversationLikeContent(`${sourceText} ${transcriptPreview || ""}`);

 if (isConversation) {
  return {
   primaryModel: FLASH_MODEL,
   fallbackModel: FLASH_LITE_MODEL,
   preserveMarkedDuplicates: true,
   contentMode: "conversation" as ContentMode,
  };
 }

 if (isSong) {
  return {
   primaryModel: FLASH_MODEL,
   fallbackModel: FLASH_LITE_MODEL,
   preserveMarkedDuplicates: true,
   contentMode: "song" as ContentMode,
  };
 }

 if (chunkCount >= LONG_VIDEO_CHUNK_THRESHOLD) {
  return {
   primaryModel: FLASH_LITE_MODEL,
   fallbackModel: FLASH_MODEL,
   preserveMarkedDuplicates: false,
   contentMode: "learning" as ContentMode,
  };
 }

 return {
  primaryModel: FLASH_MODEL,
  fallbackModel: FLASH_LITE_MODEL,
  preserveMarkedDuplicates: false,
  contentMode: "learning" as ContentMode,
 };
};

const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_LITE_MODEL = "gemini-2.5-flash-lite";
const LONG_VIDEO_CHUNK_THRESHOLD = 25;
const STORAGE_KEY = "gemini_api_keys_v1";
const STORAGE_ACTIVE_KEY = "gemini_active_key_index_v1";
const STT_CACHE_PREFIX = "gemini_stt_cache_v1:";
const RESULT_CACHE_PREFIX = "study_result_cache_v1:";
const RESUME_STATE_PREFIX = "study_resume_state_v1:";
const MAX_STT_SEGMENT_CONCURRENCY = 1;
const MAX_TRANSLATION_CHUNK_CONCURRENCY = 1;
const TRANSCRIPT_CHUNK_MAX_LENGTH = 3600;

const chunkTextByLine = (text: string, maxLength = TRANSCRIPT_CHUNK_MAX_LENGTH) => {
 if (!text.trim()) return [];

 const lines = text.split("\n");
 const chunks: string[] = [];
 let current = "";

 for (const line of lines) {
  const candidate = current ? `${current}\n${line}` : line;

  if (candidate.length <= maxLength) {
   current = candidate;
   continue;
  }

  if (current) {
   chunks.push(current);
   current = line;
   continue;
  }

  let start = 0;
  while (start < line.length) {
   chunks.push(line.slice(start, start + maxLength));
   start += maxLength;
  }
 }

 if (current) {
  chunks.push(current);
 }

 return chunks;
};

const getContiguousTranscriptText = (parts: string[]) => {
 const contiguousParts: string[] = [];

 for (const part of parts) {
  if (typeof part !== "string") {
   break;
  }

  contiguousParts.push(part.trim());
 }

 return contiguousParts.filter(Boolean).join("\n").trim();
};

const normalizeYouTubeProcessingUrl = (value: string) => {
 const raw = value.trim();

 if (!raw) {
  return "";
 }

 try {
  const url = new URL(raw);
  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
   const videoId = url.pathname.split("/").filter(Boolean)[0];
   return videoId ? `https://www.youtube.com/watch?v=${videoId}` : raw;
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
   const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/i);
   if (shortsMatch?.[1]) {
    return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
   }

   const videoId = url.searchParams.get("v");
   return videoId ? `https://www.youtube.com/watch?v=${videoId}` : raw;
  }

  return raw;
 } catch {
  return raw;
 }
};

const getSttCacheKey = (videoUrl: string) => `${STT_CACHE_PREFIX}${normalizeYouTubeProcessingUrl(videoUrl)}`;
const getResultCacheKey = (videoUrl: string) => `${RESULT_CACHE_PREFIX}${normalizeYouTubeProcessingUrl(videoUrl)}`;
const getResumeStateKey = (videoUrl: string) => `${RESUME_STATE_PREFIX}${normalizeYouTubeProcessingUrl(videoUrl)}`;
const isContentMode = (value: unknown): value is ContentMode => value === "learning" || value === "song" || value === "conversation";

type CachedStudyResult = {
 originalScript: string;
 pairs: ScriptPair[];
 savedAt: number;
};

type CachedResumeState = {
 originalScript: string;
 pairs: ScriptPair[];
 savedTranscriptChunks: string[];
 resumeIndex: number;
 chunkCount: number;
 lastRunVideoUrl: string;
 isPaused: boolean;
 selectedModels: {
  primaryModel: string;
  fallbackModel: string;
  preserveMarkedDuplicates: boolean;
  contentMode: ContentMode;
 };
 savedAt: number;
};

const writeCachedSttText = (videoUrl: string, text: string) => {
 try {
  sessionStorage.setItem(
   getSttCacheKey(videoUrl),
   JSON.stringify({
    text,
    savedAt: Date.now(),
   }),
  );
 } catch {}
};

const clearCachedSttText = (videoUrl: string) => {
 try {
  sessionStorage.removeItem(getSttCacheKey(videoUrl));
 } catch {}
};

const normalizePairs = (value: unknown) => {
 return Array.isArray(value)
  ? value
    .map((item: unknown) => {
     const entry = item && typeof item === "object" ? (item as { en?: unknown; ko?: unknown; keepDuplicate?: unknown }) : {};
     const en = typeof entry.en === "string" ? entry.en : "";
     const ko = typeof entry.ko === "string" ? entry.ko : "";
     const keepDuplicate = entry.keepDuplicate === true;

     if (!en && !ko) {
      return null;
     }

     return keepDuplicate ? { en, ko, keepDuplicate: true } : { en, ko };
    })
    .filter(Boolean) as ScriptPair[]
  : [];
};

const readCachedStudyResult = (videoUrl: string): CachedStudyResult | null => {
 try {
  const raw = localStorage.getItem(getResultCacheKey(videoUrl));
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  const originalScript = typeof parsed?.originalScript === "string" ? parsed.originalScript : "";
  const pairs = normalizePairs(parsed?.pairs);

  if (!originalScript.trim() && pairs.length === 0) {
   return null;
  }

  return {
   originalScript,
   pairs,
   savedAt: typeof parsed?.savedAt === "number" ? parsed.savedAt : 0,
  };
 } catch {
  return null;
 }
};

const writeCachedStudyResult = (videoUrl: string, originalScript: string, pairs: ScriptPair[]) => {
 try {
  localStorage.setItem(
   getResultCacheKey(videoUrl),
   JSON.stringify({
    originalScript,
    pairs,
    savedAt: Date.now(),
   }),
  );
 } catch {}
};

const removeCachedStudyResult = (videoUrl: string) => {
 try {
  localStorage.removeItem(getResultCacheKey(videoUrl));
 } catch {}
};

const readCachedResumeState = (videoUrl: string): CachedResumeState | null => {
 try {
  const raw = localStorage.getItem(getResumeStateKey(videoUrl));
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  const lastRunVideoUrl = typeof parsed?.lastRunVideoUrl === "string" ? parsed.lastRunVideoUrl : "";
  const savedTranscriptChunks = Array.isArray(parsed?.savedTranscriptChunks)
   ? parsed.savedTranscriptChunks.map((item: unknown) => (typeof item === "string" ? item : "")).filter(Boolean)
   : [];
  const resumeIndex = typeof parsed?.resumeIndex === "number" && Number.isFinite(parsed.resumeIndex) ? parsed.resumeIndex : 0;
  const chunkCount =
   typeof parsed?.chunkCount === "number" && Number.isFinite(parsed.chunkCount) ? parsed.chunkCount : savedTranscriptChunks.length;
  const originalScript = typeof parsed?.originalScript === "string" ? parsed.originalScript : "";
  const pairs = normalizePairs(parsed?.pairs);
  const selectedModels: CachedResumeState["selectedModels"] =
   parsed?.selectedModels && typeof parsed.selectedModels === "object"
    ? {
       primaryModel:
        typeof (parsed.selectedModels as { primaryModel?: unknown }).primaryModel === "string"
         ? (parsed.selectedModels as { primaryModel: string }).primaryModel
         : FLASH_MODEL,
       fallbackModel:
       typeof (parsed.selectedModels as { fallbackModel?: unknown }).fallbackModel === "string"
         ? (parsed.selectedModels as { fallbackModel: string }).fallbackModel
         : FLASH_LITE_MODEL,
       preserveMarkedDuplicates: (parsed.selectedModels as { preserveMarkedDuplicates?: unknown }).preserveMarkedDuplicates === true,
       contentMode: isContentMode((parsed.selectedModels as { contentMode?: unknown }).contentMode)
        ? (parsed.selectedModels as { contentMode: ContentMode }).contentMode
        : "learning",
      }
    : {
       primaryModel: FLASH_MODEL,
       fallbackModel: FLASH_LITE_MODEL,
       preserveMarkedDuplicates: false,
       contentMode: "learning",
      };

  if (!lastRunVideoUrl.trim() || savedTranscriptChunks.length === 0) {
   return null;
  }

  return {
   originalScript,
   pairs,
   savedTranscriptChunks,
   resumeIndex: Math.max(0, Math.min(resumeIndex, savedTranscriptChunks.length)),
   chunkCount: Math.max(chunkCount, savedTranscriptChunks.length),
   lastRunVideoUrl,
   isPaused: parsed?.isPaused === true,
   selectedModels,
   savedAt: typeof parsed?.savedAt === "number" ? parsed.savedAt : 0,
  };
 } catch {
  return null;
 }
};

const writeCachedResumeState = (videoUrl: string, state: Omit<CachedResumeState, "savedAt">) => {
 try {
  localStorage.setItem(
   getResumeStateKey(videoUrl),
   JSON.stringify({
    ...state,
    savedAt: Date.now(),
   }),
  );
 } catch {}
};

const removeCachedResumeState = (videoUrl: string) => {
 try {
  localStorage.removeItem(getResumeStateKey(videoUrl));
 } catch {}
};

const parseJsonResponse = async <T,>(response: Response, fallbackMessage: string): Promise<T> => {
 const rawText = await response.text();

 try {
  return (rawText ? JSON.parse(rawText) : {}) as T;
 } catch {
  const preview = rawText.replace(/\s+/g, " ").trim().slice(0, 300);
  throw new Error(preview || fallbackMessage);
 }
};

const getTranscriptJobStageLabel = (stage?: string) => {
 switch (stage) {
  case "metadata":
   return "영상 정보 확인 중";
  case "subtitle":
   return "자막 확인 중";
  case "audio_download":
   return "오디오 다운로드 중";
  case "audio_segment":
   return "오디오 구간 분할 중";
  case "queued":
   return "자막 작업 대기 중";
  default:
   return "오디오 준비 중";
 }
};

export default function Page() {
 const [videoUrl, setVideoUrl] = useState("");
 const [apiKeyInput, setApiKeyInput] = useState("");
 const [apiKeys, setApiKeys] = useState<string[]>([]);
 const [activeKeyIndex, setActiveKeyIndex] = useState(0);
 const [originalScript, setOriginalScript] = useState("");
 const [pairs, setPairs] = useState<ScriptPair[]>([]);
 const [loadingTranscript, setLoadingTranscript] = useState(false);
 const [loadingGemini, setLoadingGemini] = useState(false);
 const [statusText, setStatusText] = useState("대기 중");
 const [errorMessage, setErrorMessage] = useState("");
 const [chunkCount, setChunkCount] = useState(0);
 const [viewMode, setViewMode] = useState<ViewMode>("bilingual");
 const [abortController, setAbortController] = useState<AbortController | null>(null);
 const [savedTranscriptChunks, setSavedTranscriptChunks] = useState<string[]>([]);
 const [resumeIndex, setResumeIndex] = useState(0);
 const [isPaused, setIsPaused] = useState(false);
 const [lastRunVideoUrl, setLastRunVideoUrl] = useState("");
 const [cooldownSeconds, setCooldownSeconds] = useState(0);
 const [isCooldownWaiting, setIsCooldownWaiting] = useState(false);
 const [sidebarSections, setSidebarSections] = useState({
  video: true,
  api: false,
  view: false,
  status: false,
 });

 const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
 const resumeRequestedRef = useRef(false);
 const lastCachedResultUrlRef = useRef("");
const selectedModelsRef = useRef({
 primaryModel: FLASH_MODEL,
 fallbackModel: FLASH_LITE_MODEL,
 preserveMarkedDuplicates: false,
 contentMode: "learning" as ContentMode,
});

 const applyResumeState = (resumeState: CachedResumeState) => {
  setErrorMessage("");
  setOriginalScript(resumeState.originalScript);
  setPairs(resumeState.pairs);
  setChunkCount(resumeState.chunkCount);
  setSavedTranscriptChunks(resumeState.savedTranscriptChunks);
  setResumeIndex(resumeState.resumeIndex);
  setIsPaused(resumeState.isPaused || resumeState.resumeIndex < resumeState.savedTranscriptChunks.length);
  setLastRunVideoUrl(resumeState.lastRunVideoUrl);
  selectedModelsRef.current = resumeState.selectedModels;
 };

 useEffect(() => {
  const savedKeys = localStorage.getItem(STORAGE_KEY);
  const savedIndex = localStorage.getItem(STORAGE_ACTIVE_KEY);

  if (savedKeys) {
   try {
    const parsed = JSON.parse(savedKeys);
    if (Array.isArray(parsed)) {
     const cleaned = parsed.map((item) => String(item || "").trim()).filter(Boolean);
     setApiKeys(cleaned);
     setApiKeyInput(cleaned.join("\n"));
    }
   } catch {}
  }

  if (savedIndex) {
   const index = Number(savedIndex);
   if (Number.isInteger(index) && index >= 0) {
    setActiveKeyIndex(index);
   }
  }
 }, []);

 useEffect(() => {
  if (loadingTranscript || loadingGemini || isCooldownWaiting) {
   return;
  }

  const normalizedUrl = normalizeYouTubeProcessingUrl(videoUrl);

  if (!normalizedUrl) {
   lastCachedResultUrlRef.current = "";
   return;
  }

  if (lastCachedResultUrlRef.current === normalizedUrl) {
   return;
  }

  lastCachedResultUrlRef.current = normalizedUrl;

  const cachedResumeState = readCachedResumeState(normalizedUrl);

  if (cachedResumeState && cachedResumeState.resumeIndex < cachedResumeState.savedTranscriptChunks.length) {
   applyResumeState(cachedResumeState);
   setStatusText("이어할 작업을 불러왔어요.");
   return;
  }

  const cachedResult = readCachedStudyResult(normalizedUrl);

  if (!cachedResult) {
   return;
  }

  const cachedChunks = chunkTextByLine(cachedResult.originalScript, TRANSCRIPT_CHUNK_MAX_LENGTH);
  setErrorMessage("");
  setOriginalScript(cachedResult.originalScript);
  setPairs(cachedResult.pairs);
  setChunkCount(cachedChunks.length);
  setSavedTranscriptChunks(cachedChunks);
  setResumeIndex(cachedChunks.length);
  setIsPaused(false);
  setLastRunVideoUrl(normalizedUrl);
  removeCachedResumeState(normalizedUrl);
  setStatusText("저장된 결과 불러옴");
 }, [videoUrl, loadingTranscript, loadingGemini, isCooldownWaiting]);

 useEffect(() => {
  if (!lastRunVideoUrl.trim()) {
   return;
  }

  if (savedTranscriptChunks.length === 0) {
   removeCachedResumeState(lastRunVideoUrl);
   return;
  }

  if (!isPaused && !loadingTranscript && !loadingGemini && resumeIndex >= savedTranscriptChunks.length) {
   removeCachedResumeState(lastRunVideoUrl);
   return;
  }

  writeCachedResumeState(lastRunVideoUrl, {
   originalScript,
   pairs,
   savedTranscriptChunks,
   resumeIndex,
   chunkCount,
   lastRunVideoUrl,
   isPaused: isPaused || isCooldownWaiting || loadingTranscript || loadingGemini,
   selectedModels: selectedModelsRef.current,
  });
 }, [
  chunkCount,
  isCooldownWaiting,
  isPaused,
  lastRunVideoUrl,
  loadingGemini,
  loadingTranscript,
  originalScript,
  pairs,
  resumeIndex,
  savedTranscriptChunks,
 ]);

 useEffect(() => {
  if (apiKeys.length === 0) {
   if (activeKeyIndex !== 0) {
    setActiveKeyIndex(0);
    localStorage.setItem(STORAGE_ACTIVE_KEY, "0");
   }
   return;
  }

  if (activeKeyIndex > apiKeys.length - 1) {
   setActiveKeyIndex(0);
   localStorage.setItem(STORAGE_ACTIVE_KEY, "0");
  }
 }, [apiKeys, activeKeyIndex]);

 useEffect(() => {
  return () => {
   if (cooldownTimerRef.current) {
    clearInterval(cooldownTimerRef.current);
   }
  };
 }, []);

 const isBusy = loadingTranscript || loadingGemini || isCooldownWaiting;

 const canResume =
  isPaused &&
  savedTranscriptChunks.length > 0 &&
  resumeIndex < savedTranscriptChunks.length &&
  lastRunVideoUrl.trim() === normalizeYouTubeProcessingUrl(videoUrl);

 const canRun = useMemo(() => {
  return normalizeYouTubeProcessingUrl(videoUrl).length > 0 && apiKeys.length > 0 && !isBusy;
 }, [videoUrl, apiKeys, isBusy]);

 const toggleSidebarSection = (section: keyof typeof sidebarSections) => {
  setSidebarSections((prev) => ({
   ...prev,
   [section]: !prev[section],
  }));
 };

 const getSectionChevron = (isOpen: boolean) => {
  return isOpen ? "▾" : "▸";
 };

 const clearCooldownTimer = () => {
  if (cooldownTimerRef.current) {
   clearInterval(cooldownTimerRef.current);
   cooldownTimerRef.current = null;
  }
 };

 const parseApiKeys = (value: string) => {
  return Array.from(
   new Set(
    value
     .split(/\r?\n|,/)
     .map((item) => item.trim())
     .filter(Boolean),
   ),
  );
 };

 const maskKey = (key: string) => {
  if (key.length <= 10) {
   return `${key.slice(0, 3)}...`;
  }
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
 };

 const handleSaveKeys = () => {
  const parsedKeys = parseApiKeys(apiKeyInput);
  const normalizedInput = parsedKeys.join("\n");
  const nextIndex = parsedKeys.length === 0 ? 0 : Math.min(activeKeyIndex, parsedKeys.length - 1);

  try {
   localStorage.setItem(STORAGE_KEY, JSON.stringify(parsedKeys));
   localStorage.setItem(STORAGE_ACTIVE_KEY, String(nextIndex));

   setApiKeys(parsedKeys);
   setApiKeyInput(normalizedInput);
   setActiveKeyIndex(nextIndex);
   setErrorMessage("");
   setStatusText(parsedKeys.length > 0 ? "API 키 저장됨" : "대기 중");
  } catch {
   setErrorMessage("브라우저 저장소에 저장하지 못했습니다.");
   setStatusText("오류");
  }
 };

 const handleClearKeys = () => {
  setApiKeys([]);
  setApiKeyInput("");
  setActiveKeyIndex(0);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_ACTIVE_KEY);
  setStatusText("API 키 삭제됨");
  setErrorMessage("");
 };

 const removeKey = (index: number) => {
  const next = apiKeys.filter((_, i) => i !== index);
  setApiKeys(next);
  setApiKeyInput(next.join("\n"));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));

  let nextIndex = activeKeyIndex;

  if (next.length === 0) {
   nextIndex = 0;
  } else if (index < activeKeyIndex) {
   nextIndex = activeKeyIndex - 1;
  } else if (activeKeyIndex >= next.length) {
   nextIndex = next.length - 1;
  }

  setActiveKeyIndex(nextIndex);
  localStorage.setItem(STORAGE_ACTIVE_KEY, String(nextIndex));
  setStatusText(next.length > 0 ? "API 키 업데이트됨" : "대기 중");
 };

 const removePair = (index: number) => {
  setPairs((prev) => {
   const nextPairs = prev.filter((_, pairIndex) => pairIndex !== index);

   if (lastRunVideoUrl) {
    if (nextPairs.length > 0 || originalScript.trim()) {
     writeCachedStudyResult(lastRunVideoUrl, originalScript, nextPairs);
    } else {
     removeCachedStudyResult(lastRunVideoUrl);
    }
   }

   return nextPairs;
  });
 };

 const extractTranscript = async (signal?: AbortSignal) => {
  const normalizedProcessingUrl = normalizeYouTubeProcessingUrl(videoUrl);
  setStatusText("자막 서버 연결 중");

  const configResponse = await fetch("/api/transcript-server", {
   method: "GET",
   cache: "no-store",
   signal,
  });
  const configData = await parseJsonResponse<{ baseUrl?: string; error?: string }>(configResponse, "자막 서버 설정 응답을 읽지 못했습니다.");

  if (!configResponse.ok || !configData.baseUrl) {
   throw new Error(configData.error || "자막 서버 주소를 가져오지 못했습니다.");
  }

  const transcriptServerBaseUrl = configData.baseUrl.replace(/\/+$/, "");

  setStatusText("자막 작업 준비 중");

  const startResponse = await fetch(`${transcriptServerBaseUrl}/transcript-job/start`, {
   method: "POST",
   headers: {
    "Content-Type": "application/json",
   },
   body: JSON.stringify({ videoUrl: normalizedProcessingUrl }),
   signal,
  });
  const startData = await parseJsonResponse<{ jobId?: string; error?: string; details?: string }>(startResponse, "자막 작업 시작 응답을 읽지 못했습니다.");

  if (!startResponse.ok || !startData.jobId) {
   throw new Error(startData.error || startData.details || "자막 작업을 시작하지 못했습니다.");
  }

  while (true) {
   if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
   }

   const jobResponse = await fetch(`${transcriptServerBaseUrl}/transcript-job/${startData.jobId}`, {
    method: "GET",
    cache: "no-store",
    signal,
   });
   const jobData = await parseJsonResponse<{
    status?: string;
    stage?: string;
    result?: Record<string, unknown>;
    error?: { message?: string } | string;
   }>(jobResponse, "자막 작업 상태 응답을 읽지 못했습니다.");

   if (!jobResponse.ok) {
    throw new Error(typeof jobData.error === "string" ? jobData.error : jobData.error?.message || "자막 작업 상태를 확인하지 못했습니다.");
   }

   if (jobData.status === "failed") {
    throw new Error(typeof jobData.error === "string" ? jobData.error : jobData.error?.message || "자막 작업에 실패했습니다.");
   }

   if (jobData.status === "ready" && jobData.result) {
    const data = jobData.result;
    const needsClientStt = data.needsClientStt === true;
    const transcriptText = typeof data.transcript === "string" ? data.transcript : typeof data.text === "string" ? data.text : "";
     const transcriptChunks = needsClientStt ? [] : chunkTextByLine(transcriptText, TRANSCRIPT_CHUNK_MAX_LENGTH);

     return {
      normalizedUrl: normalizedProcessingUrl,
      transcriptText: needsClientStt ? "" : transcriptText,
     transcriptChunks,
     chunkCount: transcriptChunks.length,
     title: typeof data.title === "string" ? data.title : "",
     fileName: typeof data.fileName === "string" ? data.fileName : "",
     durationSeconds: typeof data.durationSeconds === "number" ? data.durationSeconds : 0,
     sttMode: typeof data.sttMode === "string" ? data.sttMode : "",
     transcriptSource: typeof data.transcriptSource === "string" ? data.transcriptSource : needsClientStt ? "client_gemini_stt" : "official_subtitle",
     needsClientStt,
     audioUrl: typeof data.audioUrl === "string" ? data.audioUrl : "",
     audioMimeType: typeof data.audioMimeType === "string" ? data.audioMimeType : "",
     audioSegments: Array.isArray(data.audioSegments) ? data.audioSegments : [],
     expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : 0,
    } as TranscriptResponse;
   }

   setStatusText(jobData.status === "processing" ? getTranscriptJobStageLabel(jobData.stage) : "자막 작업 대기 중");
   await new Promise((resolve) => setTimeout(resolve, 1500));
  }
 };

 const startCooldownAndResume = (seconds: number) => {
  clearCooldownTimer();
  setCooldownSeconds(seconds);
  setIsCooldownWaiting(true);
  setIsPaused(true);
  setLoadingTranscript(false);
  setLoadingGemini(false);
  setStatusText("자동 재시도 대기 중");

  cooldownTimerRef.current = setInterval(() => {
   setCooldownSeconds((prev) => {
    if (prev <= 1) {
     clearCooldownTimer();
     setIsCooldownWaiting(false);
     setStatusText("곧 이어서 재개");
     if (resumeRequestedRef.current) {
      resumeRequestedRef.current = false;
      setTimeout(() => {
       resumeRun(true);
      }, 150);
     }
     return 0;
    }

    return prev - 1;
   });
  }, 1000);
 };

 const startFreshRun = async () => {
  const normalizedProcessingUrl = normalizeYouTubeProcessingUrl(videoUrl);

  if (!normalizedProcessingUrl) {
   setErrorMessage("유튜브 링크를 입력해 주세요.");
   return;
  }

  if (apiKeys.length === 0) {
   setErrorMessage("Gemini API 키를 한 개 이상 저장해 주세요.");
   return;
  }

  clearCooldownTimer();
  setCooldownSeconds(0);
  setIsCooldownWaiting(false);
  resumeRequestedRef.current = false;

  const controller = new AbortController();
  setAbortController(controller);

  setErrorMessage("");
  setOriginalScript("");
  setPairs([]);
  setChunkCount(0);
  setSavedTranscriptChunks([]);
  setResumeIndex(0);
  setIsPaused(false);
  setLastRunVideoUrl(normalizedProcessingUrl);
  removeCachedResumeState(normalizedProcessingUrl);
  clearCachedSttText(videoUrl);

  try {
   setLoadingTranscript(true);
   setStatusText("자막 불러오는 중");

   const transcriptData = await extractTranscript(controller.signal);

   if (controller.signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
   }

   let finalTranscriptText = transcriptData.transcriptText || "";
   let finalTranscriptChunks = transcriptData.transcriptChunks || [];

   if (transcriptData.needsClientStt) {
    const audioSegments = Array.isArray(transcriptData.audioSegments)
     ? transcriptData.audioSegments
       .filter((segment) => segment && typeof segment.url === "string" && segment.url.trim())
       .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
     : [];

    if (audioSegments.length > 0) {
     const sttParts: string[] = [];
     let nextSegmentIndex = 0;
     let completedSegmentCount = 0;
     let publishedText = "";
     const sttSegmentConcurrency = Math.min(apiKeys.length, MAX_STT_SEGMENT_CONCURRENCY, audioSegments.length);

     const publishCompletedSegments = () => {
      const nextText = getContiguousTranscriptText(sttParts);

      if (!nextText || nextText === publishedText) {
       return;
      }

      publishedText = nextText;
       const partialChunks = chunkTextByLine(nextText, TRANSCRIPT_CHUNK_MAX_LENGTH);
      setOriginalScript(nextText);
      setChunkCount(partialChunks.length);
      setSavedTranscriptChunks(partialChunks);
     };

     const runNextSegment = async (): Promise<void> => {
      while (nextSegmentIndex < audioSegments.length) {
       if (controller.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
       }

       const segmentIndex = nextSegmentIndex;
       nextSegmentIndex += 1;
       const segment = audioSegments[segmentIndex];
       const segmentActiveKeyIndex = (activeKeyIndex + segmentIndex) % apiKeys.length;
       setStatusText(`음성 인식 중 (병렬 ${sttSegmentConcurrency}개, ${completedSegmentCount}/${audioSegments.length} 완료, ${segmentIndex + 1}번 구간 처리 중)`);

       const segmentText = await transcribeAudioWithGemini({
        audioUrl: segment.url || "",
        apiKeys,
        activeKeyIndex: segmentActiveKeyIndex,
        titleHint: transcriptData.title || "",
        signal: controller.signal,
        onStatusChange: (text) => setStatusText(`음성 인식 중 (병렬 ${sttSegmentConcurrency}개, ${completedSegmentCount}/${audioSegments.length} 완료, ${segmentIndex + 1}번 구간) · ${text}`),
        onActiveKeyChange: (index) => {
         setActiveKeyIndex(index);
        },
        onPersistActiveKey: (index) => {
         localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
        },
       });

       sttParts[segmentIndex] = segmentText.trim();
       completedSegmentCount += 1;
       setStatusText(`음성 인식 중 (병렬 ${sttSegmentConcurrency}개, ${completedSegmentCount}/${audioSegments.length} 완료)`);
       publishCompletedSegments();
      }
     };

     await Promise.all(Array.from({ length: sttSegmentConcurrency }, () => runNextSegment()));

     finalTranscriptText = sttParts.join("\n").trim();
      finalTranscriptChunks = chunkTextByLine(finalTranscriptText, TRANSCRIPT_CHUNK_MAX_LENGTH);
     writeCachedSttText(videoUrl, finalTranscriptText);
    } else if (!transcriptData.audioUrl) {
     throw new Error("음성 인식용 오디오 주소를 받지 못했습니다.");
    } else {
     setStatusText(transcriptData.sttMode === "single" ? "음성 인식 중 (단일 오디오)" : "음성 인식 중");

     const sttText = await transcribeAudioWithGemini({
      audioUrl: transcriptData.audioUrl,
      apiKeys,
      activeKeyIndex,
      titleHint: transcriptData.title || "",
      signal: controller.signal,
      onStatusChange: setStatusText,
      onActiveKeyChange: setActiveKeyIndex,
      onPersistActiveKey: (index) => {
       localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
      },
     });

     finalTranscriptText = sttText;
      finalTranscriptChunks = chunkTextByLine(sttText, TRANSCRIPT_CHUNK_MAX_LENGTH);
     writeCachedSttText(videoUrl, sttText);
    }
   }

   if (!finalTranscriptText.trim()) {
    throw new Error("가공 가능한 자막 텍스트가 없습니다.");
   }

   if (finalTranscriptChunks.length === 0) {
    throw new Error("가공 가능한 자막 청크를 만들지 못했습니다.");
   }

   setOriginalScript(finalTranscriptText);
   setChunkCount(finalTranscriptChunks.length);
   setSavedTranscriptChunks(finalTranscriptChunks);
   setResumeIndex(0);
   setStatusText("자막 준비 완료");
   setLoadingTranscript(false);

   const selectedModels = getRunModelConfig({
    title: transcriptData.title,
    fileName: transcriptData.fileName,
    chunkCount: finalTranscriptChunks.length,
    transcriptPreview: finalTranscriptText.slice(0, 1200),
   });

   selectedModelsRef.current = selectedModels;

   setLoadingGemini(true);

   const mergedPairs = await processChunks({
    transcriptChunks: finalTranscriptChunks,
    startIndex: 0,
    initialPairs: [],
    signal: controller.signal,
    apiKeys,
    activeKeyIndex,
    primaryModel: selectedModels.primaryModel,
    fallbackModel: selectedModels.fallbackModel,
    preserveMarkedDuplicates: selectedModels.preserveMarkedDuplicates,
    contentMode: selectedModels.contentMode,
    onStatusChange: setStatusText,
    onActiveKeyChange: setActiveKeyIndex,
    onPersistActiveKey: (index) => {
     localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
    },
    onPairsChange: setPairs,
    onResumeIndexChange: setResumeIndex,
    concurrency: Math.min(apiKeys.length, MAX_TRANSLATION_CHUNK_CONCURRENCY, finalTranscriptChunks.length),
   });

   const finalPairs = dedupePairs(mergedPairs, { preserveMarkedDuplicates: selectedModels.preserveMarkedDuplicates });
   setPairs(finalPairs);
   setResumeIndex(finalTranscriptChunks.length);
   setIsPaused(false);
   writeCachedStudyResult(videoUrl, finalTranscriptText, finalPairs);
   removeCachedResumeState(videoUrl);
   setStatusText("완료");
  } catch (error) {
   const retryAfterSeconds =
    typeof error === "object" &&
    error !== null &&
    "retryAfterSeconds" in error &&
    typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
     ? (error as { retryAfterSeconds: number }).retryAfterSeconds
     : null;

   if (error instanceof DOMException && error.name === "AbortError") {
    setIsPaused(true);
    setStatusText("일시정지");
   } else if (retryAfterSeconds && retryAfterSeconds > 0) {
    resumeRequestedRef.current = true;
    startCooldownAndResume(retryAfterSeconds + 1);
   } else {
    setIsPaused(true);
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    setErrorMessage(message);
    setStatusText("오류");
   }
  } finally {
   setLoadingTranscript(false);
   setLoadingGemini(false);
   setAbortController(null);
  }
 };

 const resumeRun = async (automatic = false) => {
  const normalizedProcessingUrl = normalizeYouTubeProcessingUrl(videoUrl);
  let resumeChunks = savedTranscriptChunks;
  let nextResumeIndex = resumeIndex;
  let initialPairs = pairs;

  if (resumeChunks.length === 0) {
   const cachedResumeState = readCachedResumeState(normalizedProcessingUrl);

   if (cachedResumeState) {
    applyResumeState(cachedResumeState);
    resumeChunks = cachedResumeState.savedTranscriptChunks;
    nextResumeIndex = cachedResumeState.resumeIndex;
    initialPairs = cachedResumeState.pairs;
   }
  }

  if (resumeChunks.length === 0) {
   setErrorMessage("이어할 데이터가 없습니다.");
   return;
  }

  if (nextResumeIndex >= resumeChunks.length) {
   setErrorMessage("이미 모든 청크 처리가 끝났습니다.");
   return;
  }

  clearCooldownTimer();
  setCooldownSeconds(0);
  setIsCooldownWaiting(false);
  resumeRequestedRef.current = false;

  const controller = new AbortController();
  setAbortController(controller);
  setErrorMessage("");
  setIsPaused(false);

  try {
   setLoadingGemini(true);
   setStatusText(automatic ? "자동 이어하는 중" : "이어하는 중");

   const mergedPairs = await processChunks({
    transcriptChunks: resumeChunks,
    startIndex: nextResumeIndex,
    initialPairs,
    signal: controller.signal,
    apiKeys,
    activeKeyIndex,
    primaryModel: selectedModelsRef.current.primaryModel,
    fallbackModel: selectedModelsRef.current.fallbackModel,
    preserveMarkedDuplicates: selectedModelsRef.current.preserveMarkedDuplicates,
    contentMode: selectedModelsRef.current.contentMode,
    onStatusChange: setStatusText,
    onActiveKeyChange: setActiveKeyIndex,
    onPersistActiveKey: (index) => {
     localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
    },
    onPairsChange: setPairs,
    onResumeIndexChange: setResumeIndex,
    concurrency: Math.min(apiKeys.length, MAX_TRANSLATION_CHUNK_CONCURRENCY, resumeChunks.length - nextResumeIndex),
   });

   const finalPairs = dedupePairs(mergedPairs, { preserveMarkedDuplicates: selectedModelsRef.current.preserveMarkedDuplicates });
   setPairs(finalPairs);
   setResumeIndex(resumeChunks.length);
   setIsPaused(false);
   writeCachedStudyResult(videoUrl, originalScript, finalPairs);
   removeCachedResumeState(videoUrl);
   setStatusText("완료");
  } catch (error) {
   const retryAfterSeconds =
    typeof error === "object" &&
    error !== null &&
    "retryAfterSeconds" in error &&
    typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
     ? (error as { retryAfterSeconds: number }).retryAfterSeconds
     : null;

   if (error instanceof DOMException && error.name === "AbortError") {
    setIsPaused(true);
    setStatusText("일시정지");
   } else if (retryAfterSeconds && retryAfterSeconds > 0) {
    resumeRequestedRef.current = true;
    startCooldownAndResume(retryAfterSeconds + 1);
   } else {
    const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    setErrorMessage(message);
    setStatusText("오류");
   }
  } finally {
   setLoadingTranscript(false);
   setLoadingGemini(false);
   setAbortController(null);
  }
 };

 const handleAbort = () => {
  if (abortController) {
   abortController.abort();
  }

  clearCooldownTimer();
  setCooldownSeconds(0);
  setIsCooldownWaiting(false);
  resumeRequestedRef.current = false;
  setLoadingTranscript(false);
  setLoadingGemini(false);
  setIsPaused(true);
  setStatusText("일시정지");
 };

 const handleMainAction = () => {
  if (isBusy) {
   handleAbort();
   return;
  }

  if (canResume) {
   resumeRun(false);
   return;
  }

  startFreshRun();
 };

 const mainButtonLabel = isBusy ? "중단하기" : canResume ? "이어하기" : "스크립트 만들기";

 const isRunning = loadingTranscript || loadingGemini;
 const isWaiting = isCooldownWaiting;
 const isError = statusText === "오류" || Boolean(errorMessage);
 const isDone = statusText === "완료";

 const statusIndicatorClass = isWaiting ? "is-waiting" : isRunning ? "is-running" : isError ? "is-error" : isDone ? "is-done" : "is-idle";
 const statusLabel = isWaiting ? "자동 재시도 대기 중" : isRunning ? "작업 진행 중" : isError ? "오류 발생" : isDone ? "작업 완료" : "대기 중";

 const totalChunks = savedTranscriptChunks.length || chunkCount || 0;
 const processedChunks = totalChunks > 0 ? Math.min(resumeIndex, totalChunks) : 0;

 return (
  <div className="studio-desktop">
   <div className="studio-shell">
    <div className="studio-window">
     <header className="studio-topbar">
      <div className="studio-topbar-left">
       <div className="studio-lights">
        <span />
        <span />
        <span />
       </div>
       <div className="studio-title">Youtube Script Maker</div>
      </div>
      <div className="studio-meta">YouTube → Transcript → Study Script</div>
     </header>

     <div className="studio-body">
      <aside className="studio-sidebar">
       <section className="studio-card studio-card-collapsible">
        <button
         type="button"
         className="studio-card-toggle"
         onClick={() => toggleSidebarSection("video")}
         aria-expanded={sidebarSections.video}
         aria-controls="studio-card-video"
        >
         <span className="studio-card-title">VIDEO</span>
         <span className="studio-card-toggle-icon" aria-hidden="true">
          {getSectionChevron(sidebarSections.video)}
         </span>
        </button>

        {sidebarSections.video ? (
         <div id="studio-card-video" className="studio-card-body">
          <label className="studio-field">
           <span className="studio-label">YouTube URL</span>
           <input
            type="text"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            className="studio-input"
            placeholder="https://youtube.com/watch?v=..."
           />
          </label>

          <button type="button" className="studio-btn" onClick={handleMainAction} disabled={!isBusy && !canRun}>
           {mainButtonLabel}
          </button>

          {canResume && !isBusy ? (
           <button type="button" className="studio-btn studio-btn-secondary" onClick={startFreshRun}>
            처음부터 다시 만들기
           </button>
          ) : null}
         </div>
        ) : null}
       </section>

       <section className="studio-card studio-card-collapsible">
        <button
         type="button"
         className="studio-card-toggle"
         onClick={() => toggleSidebarSection("api")}
         aria-expanded={sidebarSections.api}
         aria-controls="studio-card-api"
        >
         <span className="studio-card-title">API</span>
         <span className="studio-card-toggle-icon" aria-hidden="true">
          {getSectionChevron(sidebarSections.api)}
         </span>
        </button>

        {sidebarSections.api ? (
         <div id="studio-card-api" className="studio-card-body">
          <label className="studio-field">
           <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer" className="studio-api-link">
            Gemini API 키 발급하러 가기
           </a>
           <div className="studio-input-shell studio-input-shell-textarea">
            <textarea
             value={apiKeyInput}
             onChange={(e) => setApiKeyInput(e.target.value)}
             className="studio-input studio-input-textarea"
             placeholder={"한 줄에 하나씩 입력하세요\nAIza...\nAIza..."}
             rows={7}
            />
           </div>
          </label>

          <div className="studio-action-stack">
           <button type="button" className="studio-btn" onClick={handleSaveKeys} disabled={isBusy}>
            키 목록 저장
           </button>

           <button type="button" className="studio-btn" onClick={handleClearKeys} disabled={isBusy}>
            키 전체 삭제
           </button>
          </div>

          {apiKeys.length > 0 ? (
           <div className="studio-key-section">
            <div className="studio-key-section-head">
             <span className="studio-key-section-title">저장된 키</span>
             <span className="studio-key-section-count">{apiKeys.length}개</span>
            </div>

            <div className="studio-key-list">
             {apiKeys.map((key, index) => (
              <div key={`${key}-${index}`} className={`studio-key-row ${index === activeKeyIndex ? "is-active" : "is-idle"}`}>
               <div className="studio-key-main">
                <span className="studio-key-badge">{index === activeKeyIndex ? "사용중" : "대기"}</span>
                <span className="studio-key-text">{maskKey(key)}</span>
               </div>

               <button
                type="button"
                className="studio-icon-btn"
                onClick={() => removeKey(index)}
                disabled={isBusy}
                aria-label={`API 키 ${index + 1} 삭제`}
                title="삭제"
               >
                ×
               </button>
              </div>
             ))}
            </div>
           </div>
          ) : null}
         </div>
        ) : null}
       </section>

       <section className="studio-card studio-card-collapsible">
        <button
         type="button"
         className="studio-card-toggle"
         onClick={() => toggleSidebarSection("view")}
         aria-expanded={sidebarSections.view}
         aria-controls="studio-card-view"
        >
         <span className="studio-card-title">VIEW</span>
         <span className="studio-card-toggle-icon" aria-hidden="true">
          {getSectionChevron(sidebarSections.view)}
         </span>
        </button>

        {sidebarSections.view ? (
         <div id="studio-card-view" className="studio-card-body">
          <div className="studio-check-list">
           <button
            type="button"
            className={`studio-check-option ${viewMode === "bilingual" ? "is-active" : ""}`}
            onClick={() => setViewMode("bilingual")}
           >
            <span className="studio-check-mark">{viewMode === "bilingual" ? "✓" : ""}</span>
            <span>원문+번역</span>
           </button>

           <button
            type="button"
            className={`studio-check-option ${viewMode === "english" ? "is-active" : ""}`}
            onClick={() => setViewMode("english")}
           >
            <span className="studio-check-mark">{viewMode === "english" ? "✓" : ""}</span>
            <span>원문</span>
           </button>

           <button type="button" className={`studio-check-option ${viewMode === "korean" ? "is-active" : ""}`} onClick={() => setViewMode("korean")}>
            <span className="studio-check-mark">{viewMode === "korean" ? "✓" : ""}</span>
            <span>번역</span>
           </button>
          </div>
         </div>
        ) : null}
       </section>

       <section className="studio-card studio-card-status studio-card-collapsible">
        <button
         type="button"
         className="studio-card-toggle"
         onClick={() => toggleSidebarSection("status")}
         aria-expanded={sidebarSections.status}
         aria-controls="studio-card-status"
        >
         <span className="studio-card-title">STATUS</span>
         <span className="studio-card-toggle-icon" aria-hidden="true">
          {getSectionChevron(sidebarSections.status)}
         </span>
        </button>

        {sidebarSections.status ? (
         <div id="studio-card-status" className="studio-card-body">
          <div className={`studio-status-shell ${statusIndicatorClass}`}>
           <div className="studio-status-top">
            {loadingGemini && totalChunks > 0 ? (
             <div className="studio-progress-spinner-wrap" aria-label="번역 진행 중">
              <span className="studio-progress-spinner" />
             </div>
            ) : (
             <div className={`studio-status-indicator ${statusIndicatorClass}`}>
              <span className="studio-status-spinner" />
             </div>
            )}

            <div className="studio-status-meta">
             <div className="studio-status-label">{statusLabel}</div>
            </div>
           </div>

           {loadingGemini && totalChunks > 0 ? (
            <div className="studio-status-progress-copy">
             <span>TRANSLATING</span>
             <span>
              {processedChunks} / {totalChunks}
             </span>
            </div>
           ) : null}
          </div>

          <div className="studio-status-grid">
           <div className="studio-status-sub">{chunkCount > 0 ? `청크 수: ${chunkCount}` : "청크 수: -"}</div>
           <div className="studio-status-sub">{pairs.length > 0 ? `정리된 문장 수: ${pairs.length}` : "정리된 문장 수: -"}</div>
           <div className="studio-status-sub">{apiKeys.length > 0 ? `저장된 키 수: ${apiKeys.length}` : "저장된 키 수: -"}</div>
           <div className="studio-status-sub">
            {apiKeys.length > 0 ? `현재 우선 키: ${activeKeyIndex + 1} / ${apiKeys.length}` : "현재 우선 키: -"}
           </div>
           <div className="studio-status-sub">{totalChunks > 0 ? `진행 위치: ${processedChunks} / ${totalChunks}` : "진행 위치: -"}</div>
           <div className="studio-status-sub">{isCooldownWaiting ? `자동 재시도까지: ${cooldownSeconds}초` : "자동 재시도까지: -"}</div>
          </div>

          <div className="studio-error">
           <p>여러 API 키를 등록해도 무료 사용 한도에 동시에 도달하면 바로 처리되지 않을 수 있습니다.</p>
           <p>이 경우 잠시 대기한 뒤, 중단된 지점부터 자동으로 다시 시작합니다.</p>
          </div>

          {errorMessage ? <div className="studio-error">{errorMessage}</div> : null}
         </div>
        ) : null}
       </section>
      </aside>

      <main className="studio-main">
       <div className="studio-panels study-single">
        <article className="studio-panel">
         <div className="studio-panel-head">
          <div>
           <div className="studio-panel-title">New Script</div>
           <div className="studio-panel-subtitle">
            {viewMode === "bilingual" ? "영어 한 줄 / 한국어 한 줄" : viewMode === "english" ? "영어만 표시" : "한국어만 표시"}
           </div>
          </div>

          <div className="studio-panel-actions">
           <button
            type="button"
            className="studio-inline-btn"
            onClick={() => downloadStudyScriptPdf({ pairs, videoUrl })}
            disabled={pairs.length === 0 || isBusy}
           >
            PDF 다운로드
           </button>
           <span className="studio-chip">{viewMode === "bilingual" ? "EN + KR" : viewMode === "english" ? "EN" : "KR"}</span>
          </div>
         </div>

         <div className="studio-viewer studio-viewer-soft">
          {pairs.length > 0 ? (
            <div className="study-script-list">
             {pairs.map((pair, index) => (
              <div className="study-script-item" key={`${pair.en}-${index}`}>
               {viewMode === "bilingual" ? (
                <>
                 <div className="study-script-topline">
                  <div className="study-line-en">{pair.en}</div>
                  <button
                   type="button"
                   className="studio-icon-btn study-script-remove-btn"
                   onClick={() => removePair(index)}
                   disabled={isBusy}
                   aria-label={`문장 ${index + 1} 삭제`}
                   title="삭제"
                  >
                   x
                  </button>
                 </div>
                 <div className="study-line-ko">{pair.ko}</div>
                </>
               ) : viewMode === "english" ? (
                <div className="study-script-topline">
                 <div className="study-line-en">{pair.en}</div>
                 <button
                  type="button"
                  className="studio-icon-btn study-script-remove-btn"
                  onClick={() => removePair(index)}
                  disabled={isBusy}
                  aria-label={`문장 ${index + 1} 삭제`}
                  title="삭제"
                 >
                  x
                 </button>
                </div>
               ) : (
                <div className="study-script-topline">
                 <div className="study-line-ko study-line-ko-only">{pair.ko}</div>
                 <button
                  type="button"
                  className="studio-icon-btn study-script-remove-btn"
                  onClick={() => removePair(index)}
                  disabled={isBusy}
                  aria-label={`문장 ${index + 1} 삭제`}
                  title="삭제"
                 >
                  x
                 </button>
                </div>
               )}
              </div>
             ))}
           </div>
          ) : (
           <div className="studio-empty">
            {originalScript ? "정리된 스크립트가 아직 없습니다." : "유튜브 URL과 API 키를 입력한 뒤 스크립트를 생성해 주세요."}
           </div>
          )}
         </div>
        </article>

        <article className="studio-panel">
         <div className="studio-panel-head">
          <div>
           <div className="studio-panel-title">Original Script</div>
           <div className="studio-panel-subtitle">원문</div>
          </div>
          <span className="studio-chip">{chunkCount > 0 ? `${chunkCount} CHUNKS` : "NO DATA"}</span>
         </div>

         <div className="studio-viewer">
          {originalScript ? (
           <pre className="studio-raw-text">{originalScript}</pre>
          ) : (
           <div className="studio-empty">아직 자막을 불러오지 않았습니다.</div>
          )}
         </div>
        </article>
       </div>
      </main>
     </div>
    </div>
   </div>
  </div>
 );
}
