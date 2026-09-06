/** The implementation under test has no dependency on Mirrors or its model. */
export class Counter {
  count = 0n;

  reset(): void {
    this.count = 0n;
  }

  increment(stride: bigint): void {
    this.count += stride;
  }
}

/** Deliberate implementation bug; the adapter still observes the actual count. */
export class BrokenCounter extends Counter {
  override increment(stride: bigint): void {
    this.count += stride - 1n;
  }
}
