/** Utilitaires partagés : géo + concurrence + constantes. */

/** Prix plafond (€) : au-delà, on ignore l'offre (revendeur opportuniste). */
export const PRICE_MAX = 1100;

/** Distance haversine en km (arrondie). */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** Pool de promesses à concurrence limitée. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  async function run(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
      done++;
      onDone?.(done, items.length);
    }
  }
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    run,
  );
  await Promise.all(runners);
  return results;
}

/** Réessaie une fonction async avec backoff linéaire. */
export async function withRetry<R>(
  fn: () => Promise<R>,
  tries = 3,
  delayMs = 400,
): Promise<R> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}
