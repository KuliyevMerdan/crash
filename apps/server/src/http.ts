import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChainBook } from './chains.js';
import type { Game } from './game.js';
import type { Store } from './store/store.js';

const params = z.object({
  chainId: z.coerce.number().int().min(1),
  chainIndex: z.coerce.number().int().min(1),
});

/**
 * The game's only HTTP surface (docs/protocol.md §3.3) plus the probes. Everything a round does
 * happens on the socket; this is for verifying rounds without one, and for the platform's checks.
 */
export function registerRoutes(
  app: FastifyInstance,
  deps: { store: Store; chains: ChainBook; game: Game },
): void {
  const { store, chains, game } = deps;

  app.get('/health', async () => ({ ok: true }));

  /** Ready means: the store answers and the round loop is running. Names the check that failed. */
  app.get('/ready', async (_req, reply) => {
    const failed: string[] = [];
    try {
      store.ping();
    } catch {
      failed.push('store');
    }
    if (!game.isRunning) failed.push('game');
    if (failed.length > 0) return reply.code(503).send({ ready: false, failed });
    return { ready: true };
  });

  app.get('/fair/chains', async () => ({ chains: chains.listing() }));

  /** A revealed round, or 404 — an index not yet revealed never yields its seed. */
  app.get('/fair/:chainId/:chainIndex', async (req, reply) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success)
      return reply.code(400).send({ error: 'chainId and chainIndex are positive integers' });
    const reveal = store.reveal(parsed.data.chainId, parsed.data.chainIndex);
    if (reveal === null) return reply.code(404).send({ error: 'not revealed' });
    return reveal;
  });
}
