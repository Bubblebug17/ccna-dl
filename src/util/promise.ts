export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function catchedRace<T extends readonly unknown[] | []>(
  values: T
): Promise<Awaited<T[number]>>;
export function catchedRace<T>(
  values: Iterable<T | PromiseLike<T>>
): Promise<Awaited<T>>;
export function catchedRace<T>(
  values: Iterable<T | PromiseLike<T>> | T[]
): Promise<Awaited<T>> {
  return Promise.race(
    Array.from(values).map((value) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'catch' in value &&
        typeof value.catch === 'function'
      ) {
        return value.catch(() => {});
      }
      return value;
    })
  );
}
