export type ScriptPair = {
 en: string;
 ko: string;
};

export type GeminiError = Error & {
 status?: number;
};

type RequestGeminiParams = {
 model: string;
 prompt: string;
 apiKey: string;
 signal?: AbortSignal;
};

type StructuredPairsParams = {
 model: string;
 chunk: string;
 index: number;
 total: number;
 apiKey: string;
 signal?: AbortSignal;
};

type CallGeminiChunkParams = {
 chunk: string;
 index: number;
 total: number;
 apiKeys: string[];
 activeKeyIndex: number;
 primaryModel: string;
 fallbackModel: string;
 signal?: AbortSignal;
 onStatusChange?: (text: string) => void;
 onActiveKeyChange?: (index: number) => void;
 onPersistActiveKey?: (index: number) => void;
 sleepMs?: number;
};

type ProcessChunksParams = {
 transcriptChunks: string[];
 startIndex: number;
 initialPairs: ScriptPair[];
 signal: AbortSignal;
 apiKeys: string[];
 activeKeyIndex: number;
 primaryModel: string;
 fallbackModel: string;
 onStatusChange?: (text: string) => void;
 onActiveKeyChange?: (index: number) => void;
 onPersistActiveKey?: (index: number) => void;
 onPairsChange?: (pairs: ScriptPair[]) => void;
 onResumeIndexChange?: (index: number) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const requestGeminiWithKey = async ({ model, prompt, apiKey, signal }: RequestGeminiParams) => {
 const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: {
   "Content-Type": "application/json",
   "x-goog-api-key": apiKey,
  },
  body: JSON.stringify({
   contents: [
    {
     parts: [{ text: prompt }],
    },
   ],
   generationConfig: {
    temperature: 0.1,
    topP: 0.8,
    responseMimeType: "application/json",
   },
  }),
  signal,
 });

 const data = await response.json();

 if (!response.ok) {
  const message = data?.error?.message || `Gemini 요청 실패 (${response.status})`;
  const error = new Error(message) as GeminiError;
  error.status = response.status;
  throw error;
 }

 const text =
  data?.candidates?.[0]?.content?.parts
   ?.map((part: { text?: string }) => part.text || "")
   .join("")
   .trim() || "";

 if (!text) {
  throw new Error("Gemini 응답이 비어 있습니다.");
 }

 return text;
};

export const safeParsePairs = (raw: string): ScriptPair[] => {
 try {
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) return [];

  return parsed
   .map((item) => ({
    en: typeof item?.en === "string" ? item.en.trim() : "",
    ko: typeof item?.ko === "string" ? item.ko.trim() : "",
   }))
   .filter((item) => item.en || item.ko);
 } catch {
  return [];
 }
};

export const requestStructuredPairs = async ({ model, chunk, index, total, apiKey, signal }: StructuredPairsParams) => {
 const prompt = [
  "다음은 유튜브 자막 원문입니다.",
  "한국어와 영어가 섞여 있고, 반복, 끊긴 문장, 자막 오류가 있습니다.",
  "학습용 스크립트로 재구성해 주세요.",
  "",
  "반드시 아래 규칙을 지키세요.",
  "1. 영어 학습 문장만 남기세요.",
  "2. 영상 소개, 광고, 동기부여 멘트, 구독 유도, 교재 홍보, 강의 홍보, 설명용 한국어 서론은 전부 제거하세요.",
  "3. 영어 문장을 기준으로 정리하세요.",
  "4. 같은 영어 문장이 반복되면 한 번만 남기세요.",
  "5. 잘린 영어 문장은 문맥상 자연스럽게 복원하세요.",
  "6. 각 영어 문장에 대응하는 자연스러운 한국어 번역을 붙이세요.",
  "7. 설명, 해설, 제목 없이 JSON 배열만 반환하세요.",
  '8. 각 항목은 {"en":"영어 문장","ko":"한국어 번역"} 형식이어야 합니다.',
  "9. 영어가 없는 한국어 안내 멘트는 제외하세요.",
  "10. 사진 묘사, 스피킹 표현, 실제 연습 문장처럼 영어 학습에 직접 쓰이는 문장만 남기세요.",
  "",
  `현재 청크: ${index + 1}/${total}`,
  "",
  chunk,
 ].join("\n");

 return requestGeminiWithKey({ model, prompt, apiKey, signal });
};

export const isRotationCandidate = (error: unknown) => {
 const status = typeof error === "object" && error !== null && "status" in error ? (error as GeminiError).status : undefined;
 const message = error instanceof Error ? error.message.toLowerCase() : "";

 if (status === 429 || status === 500 || status === 503) return true;
 if (status === 403 && (message.includes("quota") || message.includes("rate") || message.includes("exhausted"))) return true;
 if (message.includes("quota")) return true;
 if (message.includes("resource exhausted")) return true;
 if (message.includes("rate limit")) return true;
 if (message.includes("high demand")) return true;
 if (message.includes("overloaded")) return true;
 if (message.includes("try again later")) return true;

 return false;
};

export const extractRetrySeconds = (message: string) => {
 const match = message.match(/Please retry in\s+([\d.]+)s/i);
 if (!match) return null;
 const seconds = Math.ceil(Number(match[1]));
 if (!Number.isFinite(seconds) || seconds <= 0) return null;
 return seconds;
};

export const dedupePairs = (items: ScriptPair[]) => {
 const seen = new Set<string>();
 const result: ScriptPair[] = [];

 for (const item of items) {
  const en = item.en.replace(/\s+/g, " ").trim();
  const ko = item.ko.replace(/\s+/g, " ").trim();

  if (!en && !ko) continue;

  const key = `${en}|||${ko}`;
  if (seen.has(key)) continue;

  seen.add(key);
  result.push({ en, ko });
 }

 return result;
};

export const callGeminiChunk = async ({
 chunk,
 index,
 total,
 apiKeys,
 activeKeyIndex,
 primaryModel,
 fallbackModel,
 signal,
 onStatusChange,
 onActiveKeyChange,
 onPersistActiveKey,
 sleepMs = 300,
}: CallGeminiChunkParams) => {
 if (apiKeys.length === 0) {
  throw new Error("저장된 Gemini API 키가 없습니다.");
 }

 const models = [primaryModel, fallbackModel];
 const tried: string[] = [];
 let lastError: unknown;
 let maxRetrySeconds = 0;

 for (const model of models) {
  for (let keyLoop = 0; keyLoop < apiKeys.length; keyLoop += 1) {
   if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
   }

   const currentIndex = (activeKeyIndex + keyLoop) % apiKeys.length;
   const currentKey = apiKeys[currentIndex];

   try {
    onStatusChange?.("번역 중");

    const raw = await requestStructuredPairs({
     model,
     chunk,
     index,
     total,
     apiKey: currentKey,
     signal,
    });

    const parsed = safeParsePairs(raw);

    if (parsed.length === 0) {
     throw new Error("구조화된 JSON 응답 파싱에 실패했습니다.");
    }

    onActiveKeyChange?.(currentIndex);
    onPersistActiveKey?.(currentIndex);
    onStatusChange?.("번역 중");

    return parsed;
   } catch (error) {
    lastError = error;

    if (error instanceof DOMException && error.name === "AbortError") {
     throw error;
    }

    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    tried.push(`KEY ${currentIndex + 1} · ${model} · ${message}`);

    const retrySeconds = extractRetrySeconds(message);
    if (retrySeconds && retrySeconds > maxRetrySeconds) {
     maxRetrySeconds = retrySeconds;
    }

    if (!isRotationCandidate(error)) {
     throw error;
    }

    onStatusChange?.("다음 키로 재시도 중");
    await sleep(sleepMs);
   }
  }
 }

 const exhaustedError = new Error(
  lastError instanceof Error
   ? `${lastError.message}\n시도한 키:\n${tried.join("\n")}`
   : `사용 가능한 API 키가 없습니다.\n시도한 키:\n${tried.join("\n")}`,
 ) as GeminiError & { retryAfterSeconds?: number };

 if (maxRetrySeconds > 0) {
  exhaustedError.retryAfterSeconds = maxRetrySeconds;
 }

 throw exhaustedError;
};

export const processChunks = async ({
 transcriptChunks,
 startIndex,
 initialPairs,
 signal,
 apiKeys,
 activeKeyIndex,
 primaryModel,
 fallbackModel,
 onStatusChange,
 onActiveKeyChange,
 onPersistActiveKey,
 onPairsChange,
 onResumeIndexChange,
}: ProcessChunksParams) => {
 const mergedPairs: ScriptPair[] = [...initialPairs];
 let currentActiveKeyIndex = activeKeyIndex;

 for (let i = startIndex; i < transcriptChunks.length; i += 1) {
  if (signal.aborted) {
   onResumeIndexChange?.(i);
   throw new DOMException("Aborted", "AbortError");
  }

  try {
   const chunkPairs = await callGeminiChunk({
    chunk: transcriptChunks[i],
    index: i,
    total: transcriptChunks.length,
    apiKeys,
    activeKeyIndex: currentActiveKeyIndex,
    primaryModel,
    fallbackModel,
    signal,
    onStatusChange,
    onActiveKeyChange: (nextIndex) => {
     currentActiveKeyIndex = nextIndex;
     onActiveKeyChange?.(nextIndex);
    },
    onPersistActiveKey,
   });

   mergedPairs.push(...chunkPairs);
   const nextPairs = dedupePairs([...mergedPairs]);
   onPairsChange?.(nextPairs);
   onResumeIndexChange?.(i + 1);
  } catch (error) {
   const retryAfterSeconds =
    typeof error === "object" &&
    error !== null &&
    "retryAfterSeconds" in error &&
    typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
     ? (error as { retryAfterSeconds: number }).retryAfterSeconds
     : null;

   if (retryAfterSeconds && retryAfterSeconds > 0) {
    onResumeIndexChange?.(i);
   }

   throw error;
  }
 }

 return mergedPairs;
};
