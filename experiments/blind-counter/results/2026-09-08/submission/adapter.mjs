/**
 * Create an isolated in-memory Counter adapter.
 * @returns {{actions: {Initialize(input: object): void, Tick(input: {Stride: bigint}): void}, observe(): {Count: bigint}}}
 */
export function createAdapter() {
  let count = 0n;

  const actions = {
    Initialize(_input) {
      count = 0n;
    },

    Tick({ Stride }) {
      count += Stride;
    },
  };

  return {
    actions,
    observe() {
      return { Count: count };
    },
  };
}
