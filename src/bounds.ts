/** Bounds short operations even when a transport ignores its abort signal. */
export async function deadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new Error("Request cancelled or timed out")); };
    parent?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, ms);
  });
  try {
    if (parent?.aborted) abort();
    return await Promise.race([stopped, Promise.resolve().then(() => run(controller.signal))]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

export async function boundedText(response: Response, limit = 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error("Response exceeded the size limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
