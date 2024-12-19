class PromiseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromiseTimeoutError';
  }
}

export const runWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutInMs = 10000,
  message = `Promise did not resolve within ${timeoutInMs}ms`,
): Promise<T> => {
  let timeout: NodeJS.Timeout;

  const result = await Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new PromiseTimeoutError(message)), timeoutInMs);
    }),
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }

  return result as T;
};
