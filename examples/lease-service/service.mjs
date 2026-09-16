/** Controlled-clock lease service. No model, trace or framework dependencies. */
export class LeaseService {
  constructor(fault = 'correct') { this.fault = fault; this.reset(); }
  reset() {
    this.owners = new Set(); this.epoch = 0n; this.expires = 0n;
    this.now = 0n; this.accepted = false; this.writes = 0n;
  }
  valid(client, token) {
    return this.owners.has(client) && token === this.epoch && this.now < this.expires;
  }
  acquire(client) {
    this.accepted = this.owners.size === 0 || this.now >= this.expires;
    if (this.fault === 'overlapping-ownership' && !this.accepted) {
      this.owners.add(client); this.accepted = true; return;
    }
    if (this.accepted) {
      this.owners = new Set([client]); this.epoch++; this.expires = this.now + 3n;
    }
  }
  renew(client, token) {
    this.accepted = this.fault === 'invalid-renewal' || this.valid(client, token);
    if (this.accepted) this.expires = this.now + 3n;
  }
  release(client, token) {
    this.accepted = this.fault === 'stale-release' || this.valid(client, token);
    if (this.accepted) this.owners.clear();
  }
  write(client, token) {
    this.accepted = this.fault === 'expired-token'
      ? this.owners.has(client) && token === this.epoch : this.valid(client, token);
    if (this.accepted) this.writes++;
  }
  advance(amount) { this.now += amount; }
  snapshot() {
    return { Owners: new Set(this.owners), Epoch: this.epoch, Expires: this.expires,
      Now: this.now, Accepted: this.accepted, Writes: this.writes };
  }
}

/** Same observer for every variant: snapshots the real service fields. */
export function createAdapter(fault = 'correct') {
  const service = new LeaseService(fault);
  return {
    actions: {
      Initialize: () => service.reset(),
      Acquire: ({ Client }) => service.acquire(Client),
      Renew: ({ Client, Token }) => service.renew(Client, Token),
      Release: ({ Client, Token }) => service.release(Client, Token),
      Write: ({ Client, Token }) => service.write(Client, Token),
      Advance: ({ Amount }) => service.advance(Amount),
    },
    observe: () => service.snapshot(),
    dispose: async () => {},
  };
}
