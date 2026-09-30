import { createChain, type Chain } from '@crash/fair';
import type { ChainInfo } from '@crash/protocol';
import type { Logger } from 'pino';
import type { ServerConfig } from './config.js';
import { chainSeed } from './ids.js';
import type { Store, StoredChain } from './store/store.js';

/** The link a round is drawn from — the `source` of an engine `openRound`. */
export interface Link {
  readonly chain: { readonly id: number; readonly salt: string };
  readonly chainIndex: number;
  readonly seed: string;
  readonly previousHash: string;
}

/**
 * The chains (docs/protocol.md §3.3): which one rounds draw from, the next link, and the next
 * chain published before the current one runs out.
 *
 * A chain is generated once and only ever added — `s₀` is the chain, and a new `s₀` for a published
 * commit would silently break every past verification (ADR-0001). Building a chain in memory costs
 * `N` hashes (≈0.7 s for a million): once at boot for the current chain, and once per rotation,
 * which `Game` runs during the pause after a crash, when no bet or cash-out is in flight to be
 * stamped late.
 */
export class ChainBook {
  private readonly built = new Map<number, Chain>();

  private constructor(
    private readonly store: Store,
    private readonly config: ServerConfig['chain'],
    private readonly houseEdgeBps: number,
    private readonly log: Logger,
  ) {}

  static open(
    store: Store,
    config: ServerConfig['chain'],
    houseEdgeBps: number,
    log: Logger,
  ): ChainBook {
    const book = new ChainBook(store, config, houseEdgeBps, log);
    if (store.chains().length === 0) book.generate(1, config.devSeed ?? chainSeed());
    book.build(book.current());
    return book;
  }

  /** The chain rounds draw from: the oldest with an unconsumed link. */
  current(): StoredChain {
    const chain = this.store.chains().find((c) => c.consumed < c.length - 1);
    if (chain === undefined) {
      throw new Error(
        'every chain is exhausted — the next one should have been published 50,000 rounds ago',
      );
    }
    return chain;
  }

  /** The next link. The caller records it as consumed, in the same transaction as the round it opens. */
  next(): Link {
    const stored = this.current();
    const chain = this.build(stored);
    const chainIndex = stored.consumed + 1;
    return {
      chain: { id: stored.id, salt: stored.salt },
      chainIndex,
      seed: chain.seedAt(chainIndex),
      previousHash: chainIndex === 1 ? chain.commit : chain.seedAt(chainIndex - 1),
    };
  }

  /** Publishes the next chain once the current one is within `rotateAt` rounds of its end. */
  rotateIfDue(): void {
    const chains = this.store.chains();
    const current = this.current();
    const remaining = current.length - 1 - current.consumed;
    const hasNext = chains.some((c) => c.id > current.id);
    if (remaining <= this.config.rotateAt && !hasNext) this.generate(current.id + 1, chainSeed());
  }

  /** `hello.chain` — the chain the current round draws from. */
  info(): ChainInfo {
    const { id, commit, salt, length } = this.current();
    return { id, commit, salt, length };
  }

  /** `GET /fair/chains` — every chain, including a published next one. Never `s₀`. */
  listing(): Array<ChainInfo & { houseEdgeBps: number }> {
    return this.store.chains().map(({ id, commit, salt, length, houseEdgeBps }) => ({
      id,
      commit,
      salt,
      length,
      houseEdgeBps,
    }));
  }

  private generate(id: number, s0: string): void {
    const started = Date.now();
    const chain = createChain(s0, this.config.length);
    this.store.addChain({
      id,
      s0,
      salt: `${this.config.saltPrefix}${id}`,
      length: this.config.length,
      houseEdgeBps: this.houseEdgeBps,
      commit: chain.commit,
      consumed: 0,
    });
    this.built.set(id, chain);
    this.log.info(
      { chainId: id, commit: chain.commit, length: this.config.length, ms: Date.now() - started },
      'chain published',
    );
  }

  private build(stored: StoredChain): Chain {
    let chain = this.built.get(stored.id);
    if (chain === undefined) {
      chain = createChain(stored.s0, stored.length);
      if (chain.commit !== stored.commit) {
        throw new Error(`chain ${stored.id}: s₀ does not produce the published commit`);
      }
      this.built.set(stored.id, chain);
    }
    return chain;
  }
}
