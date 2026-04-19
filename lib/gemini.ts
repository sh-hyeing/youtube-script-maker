export type ScriptPair = {
 en: string;
 ko: string;
 keepDuplicate?: boolean;
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
 const normalize = (value: unknown): ScriptPair[] => {
  if (!Array.isArray(value)) return [];

  return value
   .map((item) => {
    const en = typeof item?.en === "string" ? item.en.trim() : "";
    const ko = typeof item?.ko === "string" ? item.ko.trim() : "";

    if (!en && !ko) return null;

    if (item && typeof item === "object" && (item as { keepDuplicate?: unknown }).keepDuplicate === true) {
     return { en, ko, keepDuplicate: true } as ScriptPair;
    }

    return { en, ko } as ScriptPair;
   })
   .filter(Boolean) as ScriptPair[];
 };

 const cleaned = raw
  .trim()
  .replace(/^```json\s*/i, "")
  .replace(/^```\s*/i, "")
  .replace(/\s*```$/i, "");

 const candidates = [cleaned];

 const firstBracket = cleaned.indexOf("[");
 const lastBracket = cleaned.lastIndexOf("]");

 if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
  candidates.push(cleaned.slice(firstBracket, lastBracket + 1));
 }

 for (const candidate of candidates) {
  try {
   const parsed = JSON.parse(candidate);

   const direct = normalize(parsed);
   if (direct.length > 0) return direct;

   if (parsed && typeof parsed === "object") {
    const objectParsed = parsed as {
     pairs?: unknown;
     items?: unknown;
     data?: unknown;
     result?: unknown;
    };

    const nested = normalize(objectParsed.pairs) || normalize(objectParsed.items) || normalize(objectParsed.data) || normalize(objectParsed.result);

    if (nested.length > 0) return nested;
   }
  } catch {}
 }

 return [];
};

export const requestStructuredPairs = async ({ model, chunk, index, total, apiKey, signal }: StructuredPairsParams) => {
 const prompt = [
  "다음은 유튜브 자막 원문입니다.",
  "한국어와 영어가 섞여 있고, 반복, 끊긴 문장, 자막 오류가 있습니다.",
  "내부적으로만 일반 학습 영상인지 노래/가사인지 판단하고, 판단 결과를 설명하지 마세요.",
  "",
  "반드시 아래 규칙을 지키세요.",
  "1. 설명, 해설, 제목, 서론, 판단 근거를 쓰지 말고 JSON 배열만 반환하세요.",
  '2. 모든 항목은 반드시 {"en":"영어 문장","ko":"한국어 번역","keepDuplicate":true 또는 false} 형식으로만 반환하세요.',
  "3. JSON 배열 바깥에 어떤 문자도 쓰지 마세요.",
  "4. 한국어 번역은 직역투를 피하고 자연스럽게 의역하되, 원문의 말투, 분위기, 정보량, 의도는 최대한 그대로 유지하세요.",
  "5. 원문의 사실 관계를 바꾸거나, 없는 의미를 덧붙이거나, 내용을 축약, 미화, 왜곡하지 마세요.",
  "6. 고유명사는 임의로 과도하게 현지화하지 마세요.",
  "7. 일반 학습 영상이면 영어 학습에 직접 쓰는 문장만 남기세요.",
  "8. 일반 학습 영상이면 시작 인사, 영상 소개, 광고, 구독 유도, 동기부여 멘트, 교재 홍보, 강의 홍보, 설명용 한국어 서론, 설명용 한국어 마무리, 번호 읽기, 반복 안내, 따라 읽기 안내, 해설 멘트는 전부 제거하세요.",
  "9. 일반 학습 영상이면 같은 영어 문장이 반복돼도 한 번만 남기고 keepDuplicate는 false로 두세요.",
  "10. 일반 학습 영상이면 잘린 영어 문장은 문맥상 자연스럽게 복원하세요.",
  "11. 노래/가사라면 후렴, 훅, 브리지처럼 반복되는 가사를 순서대로 그대로 유지하고 합치지 마세요.",
  "12. 노래/가사라면 학습용 문장 추출 모드로 바꾸지 말고 입력 텍스트 정리 모드로 처리하세요.",
  "13. 노래/가사라면 입력 텍스트에 실제로 있는 반복만 유지하세요.",
  "14. 노래/가사라면 반복되는 줄을 합치지 말고 삭제하지도 마세요.",
  "15. 노래/가사라면 외부 지식, 기억, 알려진 원곡 가사를 이용해 보완하지 마세요.",
  "16. 노래/가사라면 불명확한 부분을 추측해서 복원하지 말고, 입력 텍스트에 있는 범위만 정리하세요.",
  '17. 노래/가사로 판단한 항목은 {"en":"영어 문장","ko":"한국어 번역","keepDuplicate":true} 형식으로 반환하세요.',
  "18. 번역문은 한국어로 자연스럽게 읽혀야 하지만, 원문의 화자 성격, 감정선, 높임 수준, 거친 말투나 부드러운 말투는 가능한 한 유지하세요.",
  "",
  "반환 예시:",
  '[{"en":"How are you?","ko":"어떻게 지내세요?","keepDuplicate":false}]',
  "",
  `현재 청크: ${index + 1}/${total}`,
  "",
  chunk,
 ].join("\\n");

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
  const keepDuplicate = item.keepDuplicate === true;

  if (!en && !ko) continue;

  if (keepDuplicate) {
   result.push({ en, ko, keepDuplicate: true });
   continue;
  }

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
     const preview = raw.replace(/\s+/g, " ").trim().slice(0, 300);
     throw new Error(preview ? `구조화된 JSON 응답 파싱에 실패했습니다. 응답 미리보기: ${preview}` : "구조화된 JSON 응답 파싱에 실패했습니다.");
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
