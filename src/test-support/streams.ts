// Reads a stream to completion. Shared so a fix to reader handling lands in one place rather
// than in every streaming test file.
export async function drainStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return items;
    items.push(value as T);
  }
}
