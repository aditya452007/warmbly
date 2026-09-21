// Bounded worker pool: at most `concurrency` tasks in flight. One slow or
// failing worker never blocks or kills the others; every task settles and
// reports independently.
export interface TaskResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

export async function runBounded<T>(concurrency: number, tasks: Array<() => Promise<T>>): Promise<TaskResult<T>[]> {
  const n = Math.max(1, Math.floor(concurrency));
  const results: TaskResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(n, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
