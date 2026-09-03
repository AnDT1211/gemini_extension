export interface WaitForConditionOptions {
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
}

export async function waitForCondition<T>(
  predicate: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  options: WaitForConditionOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const startTime = Date.now();

  while (true) {
    const result = await predicate();
    if (result) {
      return result;
    }

    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(`Timeout waiting for condition: ${options.description ?? 'unspecified condition'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
