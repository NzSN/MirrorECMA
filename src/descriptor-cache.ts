import {
  MAX_MODEL_INTERFACE_DESCRIPTOR_BYTES,
  canonicalSemanticDescriptorBytes,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  type SemanticDescriptor,
  type SemanticDigest,
} from "./model-interface.js";

export const DEFAULT_DESCRIPTOR_CACHE_ENTRIES = 128;
export const DEFAULT_DESCRIPTOR_CACHE_BYTES = 16 * 1024 * 1024;

export type DescriptorCacheErrorCode =
  | "descriptor_cache_invalid_options"
  | "descriptor_cache_entry_too_large"
  | "descriptor_cache_corrupt"
  | "descriptor_cache_miss";

export class DescriptorCacheError extends Error {
  constructor(readonly code: DescriptorCacheErrorCode, message: string) {
    super(message);
    this.name = "DescriptorCacheError";
  }
}

export interface DescriptorCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface CachedSemanticDescriptor {
  readonly semanticDigest: SemanticDigest;
  readonly descriptorBytes: number;
  readonly descriptor: SemanticDescriptor;
  /** A fresh copy; mutating it cannot affect the cache. */
  readonly canonicalBytes: Uint8Array;
}

interface CacheEntry {
  readonly semanticDigest: SemanticDigest;
  readonly descriptor: SemanticDescriptor;
  readonly canonicalBytes: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DescriptorCacheError(
      "descriptor_cache_invalid_options",
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

/**
 * Explicit process-local LRU of fully verified descriptor entries.
 *
 * There is no singleton or disk state. Every visible entry is immutable, and
 * its canonical bytes and semantic digest are recomputed on every hit.
 */
export class DescriptorCache {
  readonly maxEntries: number;
  readonly maxBytes: number;
  private readonly entries = new Map<SemanticDigest, CacheEntry>();
  private storedBytes = 0;

  constructor(options: DescriptorCacheOptions = {}) {
    this.maxEntries = positiveSafeInteger(
      options.maxEntries ?? DEFAULT_DESCRIPTOR_CACHE_ENTRIES,
      "maxEntries",
    );
    this.maxBytes = positiveSafeInteger(
      options.maxBytes ?? DEFAULT_DESCRIPTOR_CACHE_BYTES,
      "maxBytes",
    );
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.storedBytes;
  }

  put(value: SemanticDescriptor): CachedSemanticDescriptor {
    const descriptor = decodeSemanticDescriptor(value);
    const canonicalBytes = canonicalSemanticDescriptorBytes(descriptor);
    if (canonicalBytes.byteLength > MAX_MODEL_INTERFACE_DESCRIPTOR_BYTES ||
        canonicalBytes.byteLength > this.maxBytes) {
      throw new DescriptorCacheError(
        "descriptor_cache_entry_too_large",
        `descriptor requires ${canonicalBytes.byteLength} bytes; cache entry limit is ${Math.min(MAX_MODEL_INTERFACE_DESCRIPTOR_BYTES, this.maxBytes)}`,
      );
    }
    const semanticDigest = semanticDescriptorDigest(descriptor);
    const existing = this.entries.get(semanticDigest);
    if (existing !== undefined) {
      const verified = this.verifyEntry(existing);
      if (!equalBytes(verified.canonicalBytes, canonicalBytes)) {
        this.quarantine(semanticDigest, existing);
        throw new DescriptorCacheError(
          "descriptor_cache_corrupt",
          "one semantic digest mapped to different canonical descriptor bytes",
        );
      }
      this.touch(semanticDigest, existing);
      return verified;
    }

    const entry: CacheEntry = Object.freeze({
      semanticDigest,
      descriptor,
      canonicalBytes: Uint8Array.from(canonicalBytes),
    });
    this.entries.set(semanticDigest, entry);
    this.storedBytes += entry.canonicalBytes.byteLength;
    this.evictToQuota();
    return this.verifyEntry(entry);
  }

  get(semanticDigest: SemanticDigest): CachedSemanticDescriptor | undefined {
    const entry = this.entries.get(semanticDigest);
    if (entry === undefined) return undefined;
    const verified = this.verifyEntry(entry);
    this.touch(semanticDigest, entry);
    return verified;
  }

  require(semanticDigest: SemanticDigest): CachedSemanticDescriptor {
    const entry = this.get(semanticDigest);
    if (entry === undefined) {
      throw new DescriptorCacheError(
        "descriptor_cache_miss",
        `descriptor ${semanticDigest} is not present in the cache`,
      );
    }
    return entry;
  }

  /** Most-recent verified digest, suitable for a subsequent ifNoneMatch. */
  mostRecentDigest(): SemanticDigest | undefined {
    const keys = [...this.entries.keys()];
    const digest = keys[keys.length - 1];
    if (digest === undefined) return undefined;
    this.get(digest);
    return digest;
  }

  private verifyEntry(entry: CacheEntry): CachedSemanticDescriptor {
    try {
      const descriptor = decodeSemanticDescriptor(entry.descriptor);
      const canonicalBytes = canonicalSemanticDescriptorBytes(descriptor);
      const digest = semanticDescriptorDigest(descriptor);
      if (digest !== entry.semanticDigest || !equalBytes(canonicalBytes, entry.canonicalBytes)) {
        throw new Error("cached descriptor identity mismatch");
      }
      return Object.freeze({
        semanticDigest: digest,
        descriptorBytes: canonicalBytes.byteLength,
        descriptor,
        canonicalBytes: Uint8Array.from(canonicalBytes),
      });
    } catch (cause) {
      this.quarantine(entry.semanticDigest, entry);
      throw new DescriptorCacheError(
        "descriptor_cache_corrupt",
        cause instanceof Error ? cause.message : "cached descriptor failed verification",
      );
    }
  }

  private touch(digest: SemanticDigest, entry: CacheEntry): void {
    this.entries.delete(digest);
    this.entries.set(digest, entry);
  }

  private quarantine(digest: SemanticDigest, entry: CacheEntry): void {
    if (this.entries.get(digest) !== entry) return;
    this.entries.delete(digest);
    this.storedBytes -= entry.canonicalBytes.byteLength;
  }

  private evictToQuota(): void {
    while (this.entries.size > this.maxEntries || this.storedBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [SemanticDigest, CacheEntry] | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest[0]);
      this.storedBytes -= oldest[1].canonicalBytes.byteLength;
    }
  }
}
