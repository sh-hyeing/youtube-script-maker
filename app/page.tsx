"use client";

import { jsPDF } from "jspdf";
import { useEffect, useMemo, useRef, useState } from "react";
import { dedupePairs, processChunks, type ScriptPair } from "@/lib/gemini";
import { downloadStudyScriptPdf } from "@/lib/pdf";
import { transcribeAudioWithGemini } from "@/lib/clientGeminiStt";

type TranscriptResponse = {
 normalizedUrl: string;
 transcriptText: string;
 transcriptChunks: string[];
 chunkCount: number;
 title?: string;
 fileName?: string;
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
 startSeconds?: number;
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

const getRunModelConfig = ({ title, fileName, chunkCount }: { title?: string; fileName?: string; chunkCount: number }) => {
 const sourceText = `${title || ""} ${fileName || ""}`.trim();
 const isSong = isSongLikeContent(sourceText);

 if (isSong) {
  return {
   primaryModel: FLASH_MODEL,
   fallbackModel: FLASH_LITE_MODEL,
  };
 }

 if (chunkCount >= LONG_VIDEO_CHUNK_THRESHOLD) {
  return {
   primaryModel: FLASH_LITE_MODEL,
   fallbackModel: FLASH_MODEL,
  };
 }

 return {
  primaryModel: FLASH_MODEL,
  fallbackModel: FLASH_LITE_MODEL,
 };
};

const FLASH_MODEL = "gemini-2.5-flash";
const FLASH_LITE_MODEL = "gemini-2.5-flash-lite";
const LONG_VIDEO_CHUNK_THRESHOLD = 25;
const STORAGE_KEY = "gemini_api_keys_v1";
const STORAGE_ACTIVE_KEY = "gemini_active_key_index_v1";
const STT_CACHE_PREFIX = "gemini_stt_cache_v2:";

const chunkTextByLine = (text: string, maxLength = 2800) => {
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

const getSttCacheKey = (videoUrl: string) => `${STT_CACHE_PREFIX}${videoUrl.trim()}`;

const readCachedSttText = (videoUrl: string) => {
 try {
  const raw = sessionStorage.getItem(getSttCacheKey(videoUrl));
  if (!raw) return "";

  const parsed = JSON.parse(raw);
  return parsed && typeof parsed.text === "string" ? parsed.text : "";
 } catch {
  return "";
 }
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

const transcribeAudioSources = async ({
 transcriptData,
 apiKeys,
 activeKeyIndex,
 signal,
 onStatusChange,
 onActiveKeyChange,
 onPersistActiveKey,
}: {
 transcriptData: TranscriptResponse;
 apiKeys: string[];
 activeKeyIndex: number;
 signal: AbortSignal;
 onStatusChange: (text: string) => void;
 onActiveKeyChange: (index: number) => void;
 onPersistActiveKey: (index: number) => void;
}) => {
 const segmentUrls = Array.isArray(transcriptData.audioSegments)
  ? transcriptData.audioSegments
    .filter((segment) => segment && typeof segment.url === "string" && segment.url.trim())
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  : [];

 if (segmentUrls.length === 0) {
  if (!transcriptData.audioUrl) {
   throw new Error("음성 인식용 오디오 주소를 받지 못했습니다.");
  }

  onStatusChange("음성 인식 중");

  return transcribeAudioWithGemini({
   audioUrl: transcriptData.audioUrl,
   apiKeys,
   activeKeyIndex,
   titleHint: transcriptData.title || "",
   signal,
   onStatusChange,
   onActiveKeyChange,
   onPersistActiveKey,
  });
 }

 const transcriptParts: string[] = [];
 let currentActiveKeyIndex = activeKeyIndex;

 for (let i = 0; i < segmentUrls.length; i += 1) {
  const segment = segmentUrls[i];

  if (signal.aborted) {
   throw new DOMException("Aborted", "AbortError");
  }

  onStatusChange(`음성 인식 중 (${i + 1}/${segmentUrls.length})`);

  const text = await transcribeAudioWithGemini({
   audioUrl: segment.url || "",
   apiKeys,
   activeKeyIndex: currentActiveKeyIndex,
   titleHint: transcriptData.title || "",
   signal,
   onStatusChange: (status) => onStatusChange(`음성 인식 중 (${i + 1}/${segmentUrls.length}) · ${status}`),
   onActiveKeyChange: (index) => {
    currentActiveKeyIndex = index;
    onActiveKeyChange(index);
   },
   onPersistActiveKey,
  });

  if (text.trim()) {
   transcriptParts.push(text.trim());
  }
 }

 return transcriptParts.join("\n").trim();
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
 const selectedModelsRef = useRef({
  primaryModel: FLASH_MODEL,
  fallbackModel: FLASH_LITE_MODEL,
 });

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
  isPaused && savedTranscriptChunks.length > 0 && resumeIndex < savedTranscriptChunks.length && lastRunVideoUrl.trim() === videoUrl.trim();

 const canRun = useMemo(() => {
  return videoUrl.trim().length > 0 && apiKeys.length > 0 && !isBusy;
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

 const extractTranscript = async (signal?: AbortSignal) => {
  const res = await fetch("/api/transcript", {
   method: "POST",
   headers: {
    "Content-Type": "application/json",
   },
   body: JSON.stringify({ videoUrl }),
   signal,
  });

  const data = await res.json();

  if (!res.ok) {
   throw new Error(data.error || "자막 추출에 실패했습니다.");
  }

  return data as TranscriptResponse;
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
  if (!videoUrl.trim()) {
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
  setLastRunVideoUrl(videoUrl.trim());

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
    const cachedText = readCachedSttText(videoUrl);

    if (cachedText) {
     finalTranscriptText = cachedText;
     finalTranscriptChunks = chunkTextByLine(cachedText, 2800);
    } else {
     const sttText = await transcribeAudioSources({
      transcriptData,
      apiKeys,
      activeKeyIndex,
      signal: controller.signal,
      onStatusChange: setStatusText,
      onActiveKeyChange: setActiveKeyIndex,
      onPersistActiveKey: (index) => {
       localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
      },
     });

     finalTranscriptText = sttText;
     finalTranscriptChunks = chunkTextByLine(sttText, 2800);
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
    onStatusChange: setStatusText,
    onActiveKeyChange: setActiveKeyIndex,
    onPersistActiveKey: (index) => {
     localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
    },
    onPairsChange: setPairs,
    onResumeIndexChange: setResumeIndex,
   });

   setPairs(dedupePairs(mergedPairs));
   setResumeIndex(finalTranscriptChunks.length);
   setIsPaused(false);
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

 const resumeRun = async (automatic = false) => {
  if (savedTranscriptChunks.length === 0) {
   setErrorMessage("이어할 데이터가 없습니다.");
   return;
  }

  if (resumeIndex >= savedTranscriptChunks.length) {
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
    transcriptChunks: savedTranscriptChunks,
    startIndex: resumeIndex,
    initialPairs: pairs,
    signal: controller.signal,
    apiKeys,
    activeKeyIndex,
    primaryModel: selectedModelsRef.current.primaryModel,
    fallbackModel: selectedModelsRef.current.fallbackModel,
    onStatusChange: setStatusText,
    onActiveKeyChange: setActiveKeyIndex,
    onPersistActiveKey: (index) => {
     localStorage.setItem(STORAGE_ACTIVE_KEY, String(index));
    },
    onPairsChange: setPairs,
    onResumeIndexChange: setResumeIndex,
   });

   setPairs(dedupePairs(mergedPairs));
   setResumeIndex(savedTranscriptChunks.length);
   setIsPaused(false);
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
                <div className="study-line-en">{pair.en}</div>
                <div className="study-line-ko">{pair.ko}</div>
               </>
              ) : viewMode === "english" ? (
               <div className="study-line-en">{pair.en}</div>
              ) : (
               <div className="study-line-ko">{pair.ko}</div>
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
