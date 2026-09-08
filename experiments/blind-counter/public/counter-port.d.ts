export interface CounterAdapter {
  readonly actions: {
    Initialize(input: Readonly<Record<string, never>>): void | Promise<void>;
    Tick(input: Readonly<{ Stride: bigint }>): void | Promise<void>;
  };
  observe(): Readonly<{ Count: bigint }> | Promise<Readonly<{ Count: bigint }>>;
  dispose?(): void | Promise<void>;
}

export type CreateCounterAdapter = () => CounterAdapter | Promise<CounterAdapter>;
