export async function runWithConcurrencyLimit<T>(
  tasks: readonly T[],
  limit: number,
  fn: (task: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  for (let offset = 0; offset < tasks.length; offset += limit) {
    const chunk = tasks.slice(offset, offset + limit);
    results.push(...(await Promise.allSettled(chunk.map(fn))));
  }
  return results;
}
