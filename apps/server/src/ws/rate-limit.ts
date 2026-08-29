/**
 * A token bucket. Refill is computed from the clock on each call rather than
 * driven by a timer, so a thousand connections cost a thousand numbers.
 *
 * A fixed window would let a client spend its whole allowance at the end of one
 * window and again at the start of the next, as one burst at twice the rate.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  /** Spends `cost` if the budget allows it. Spends nothing when it does not. */
  take(cost: number): boolean {
    const now = Date.now();
    const elapsed = (now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updatedAt = now;

    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
