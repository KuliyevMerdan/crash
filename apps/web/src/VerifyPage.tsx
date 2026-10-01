import type { CrashClient, GameView } from '@crash/client-core';
import type { RoundLink } from '@crash/protocol';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { HistoryStrip } from './HistoryStrip.js';
import { HowItWorks } from './HowItWorks.js';
import { parseRoundRef, verifyHref } from './route.js';
import { useClientState } from './useClient.js';
import {
  browserFetchJson,
  browserPause,
  rHex,
  verdictOf,
  verifyRound,
  knownFrom,
  type Checked,
  type VerifyState,
} from './verify.js';

const x = (h: number) => `${(h / 100).toFixed(2)}×`;

/**
 * The verification page (ROADMAP C3). Paste a round — or arrive from the history strip — and every
 * step from the seed to the crash point to the published commit is recomputed here, by
 * `@crash/fair` running in this tab: the same code the server drew the result with.
 *
 * Mounted afresh for each round (`Root` keys it on the link), so the form and the report always
 * belong to the round in the URL.
 */
export function VerifyPage({ client, link }: { client: CrashClient; link: RoundLink | null }) {
  const state = useClientState(client);
  const game = state.game;
  const [text, setText] = useState(link ? `${link.chainId}:${link.chainIndex}` : '');
  const [bad, setBad] = useState(false);
  const verification = useVerification(link);
  const lastRevealed = game?.history.find((h) => h.link !== null)?.link ?? null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ref = parseRoundRef(text, game?.chain.id ?? null);
    setBad(ref === null);
    if (ref) window.location.hash = verifyHref(ref);
  };

  return (
    <main className="verify">
      <header className="bar">
        <a className="brand" href="#/">
          CRASH
        </a>
        <a className="back" href="#/">
          ← back to the game
        </a>
      </header>

      <h1>Verify a round</h1>
      <p className="lede">
        Nothing here takes the server's word for anything. It hands over a seed; this tab recomputes
        the crash point from it and walks it back to the commit published before the chain's first
        round — with <code>@crash/fair</code>, the code the server ran.
      </p>

      <form className="lookup" onSubmit={submit}>
        <label>
          <span>Round</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              lastRevealed
                ? `e.g. ${lastRevealed.chainIndex} or ${lastRevealed.chainId}:${lastRevealed.chainIndex}`
                : 'chain:round'
            }
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={bad}
          />
        </label>
        <button type="submit">Verify</button>
        {bad && (
          <p className="note bad">
            A round is its number on the chain — <code>84213</code>, <code>1:84213</code>, or a
            verification link.
          </p>
        )}
      </form>

      {game && game.history.length > 0 && (
        <section className="recent">
          <h2>Recent rounds</h2>
          <HistoryStrip history={game.history} />
        </section>
      )}

      {verification && <Report state={verification} game={game} />}

      <HowItWorks open={link === null} />
      <footer className="notice">18+ · play money only · no real money, no payments</footer>
    </main>
  );
}

function useVerification(link: RoundLink | null): VerifyState | null {
  const [state, setState] = useState<VerifyState | null>(null);
  const chainId = link?.chainId;
  const chainIndex = link?.chainIndex;
  useEffect(() => {
    if (chainId === undefined || chainIndex === undefined) return;
    const controller = new AbortController();
    void verifyRound(
      { chainId, chainIndex },
      {
        fetchJson: browserFetchJson,
        pause: browserPause,
        onUpdate: setState,
        signal: controller.signal,
      },
    );
    return () => controller.abort();
  }, [chainId, chainIndex]);
  return state;
}

function Report({ state, game }: { state: VerifyState; game: GameView | null }) {
  if (state.stage === 'loading') {
    return <p className="verdict pending">Fetching round {state.link.chainIndex}'s reveal…</p>;
  }
  if (state.stage === 'error') {
    return (
      <p className="verdict failed" role="alert">
        {state.message}
      </p>
    );
  }
  const c = state.checked;
  const known = knownFrom(game, c);
  const verdict = verdictOf(c, known);
  const commitOk = c.walk.reached === null ? null : c.walk.reached === c.chain.commit;
  const pct = Math.floor((c.walk.done / c.walk.total) * 100);

  return (
    <article className="report" aria-busy={verdict === 'checking'}>
      <Verdict c={c} verdict={verdict} />

      <ol className="steps">
        <Step n={1} title="What the server revealed" ok={null}>
          <Field name="round">
            chain {c.chain.id} · round {c.link.chainIndex} · <code>{c.reveal.roundId}</code>
          </Field>
          <Field name="seed">
            <Hash value={c.reveal.seed} />
          </Field>
          <Field name="previous seed">
            <Hash value={c.reveal.previousHash} />
          </Field>
          <Field name="recorded crash">{x(c.reveal.crashPoint)}</Field>
        </Step>

        <Step n={2} title="The seed links to the round before it" ok={c.linkOk}>
          <Field name="SHA-256(seed)">
            <Hash value={c.hashOfSeed} />
          </Field>
          <p className="why">
            {c.link.chainIndex === 1
              ? 'Round 1 hashes straight to the commit.'
              : `Must equal the seed revealed in round ${c.link.chainIndex - 1}.`}{' '}
            {c.linkOk ? 'It does.' : 'It does not.'}
          </p>
        </Step>

        <Step
          n={3}
          title="The seed produces the crash point"
          ok={c.pointOk && (known.seen === null || known.seen === c.trace.crashPoint)}
        >
          <Field name={`HMAC-SHA256(seed, "${c.chain.salt}")`}>
            <code className="hash">
              <mark>{rHex(c.trace.r)}</mark>
              {c.trace.hmac.slice(13)}
            </code>
          </Field>
          <Field name="r — its first 52 bits">
            0x{rHex(c.trace.r)} = {c.trace.r.toString()}
          </Field>
          <Field name="crash point">
            <code>⌊({10_000 - c.chain.houseEdgeBps} · 2⁵²) / (100 · (2⁵² − r))⌋</code> ={' '}
            <strong>{x(c.trace.crashPoint)}</strong>
          </Field>
          <p className="why">
            The server recorded {x(c.reveal.crashPoint)}
            {c.pointOk ? ' — the same.' : ' — a different number.'}
            {known.seen !== null &&
              ` This browser was shown ${x(known.seen)} for it${known.seen === c.trace.crashPoint ? ' — the same.' : ' — a different number.'}`}{' '}
            The house edge is {c.chain.houseEdgeBps / 100}%, set with the chain.
          </p>
        </Step>

        <Step n={4} title="The seed walks back to the published commit" ok={commitOk}>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={c.walk.total}
            aria-valuenow={c.walk.done}
            aria-label="Hashes taken"
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="why">
            SHA-256 applied {c.walk.done.toLocaleString('en')} of{' '}
            {c.walk.total.toLocaleString('en')} times, in this tab.
          </p>
          {c.walk.reached !== null && (
            <Field name="landed on">
              <Hash value={c.walk.reached} />
            </Field>
          )}
          <Field name={`chain ${c.chain.id} commit`}>
            <Hash value={c.chain.commit} />
          </Field>
        </Step>

        <Step
          n={5}
          title="That chain is the one you were given before you bet"
          ok={known.chainSeen}
        >
          <p className="why">
            {known.chainSeen === null
              ? game === null
                ? 'This browser has not joined the table yet, so it holds no chain of its own to compare. It will check the moment it does.'
                : `This browser is playing chain ${game.chain.id}, so it holds nothing of its own for chain ${c.chain.id} — but anyone who saved it can compare.`
              : known.chainSeen
                ? 'The server sent this exact commit, salt and house edge to this browser in hello, when it joined the table — before any bet placed from it. Every crash point of the chain was fixed by then.'
                : 'This browser was given a different commit, salt or house edge for this chain when it joined. The server changed its story.'}
          </p>
        </Step>
      </ol>
    </article>
  );
}

function Verdict({ c, verdict }: { c: Checked; verdict: ReturnType<typeof verdictOf> }) {
  if (verdict === 'checking') {
    return (
      <p className="verdict pending" role="status">
        Checking round {c.link.chainIndex}… walking the chain back to its commit.
      </p>
    );
  }
  if (verdict === 'failed') {
    return (
      <p className="verdict failed" role="alert">
        <strong>✗ Does not verify.</strong> At least one step below disagrees with what the server
        claims.
      </p>
    );
  }
  return (
    <p className="verdict verified" role="status">
      <strong>✓ Verified.</strong> Round {c.link.chainIndex} crashed at {x(c.trace.crashPoint)}, and
      that number was fixed by a commit published before the chain's first round — before your bet,
      and before anyone's.
    </p>
  );
}

function Step({
  n,
  title,
  ok,
  children,
}: {
  n: number;
  title: string;
  ok: boolean | null;
  children: ReactNode;
}) {
  const mark = ok === null ? '' : ok ? '✓' : '✗';
  return (
    <li className={`step ${ok === null ? '' : ok ? 'ok' : 'bad'}`}>
      <h2>
        <span className="n">{n}</span> {title} <span className="mark">{mark}</span>
      </h2>
      {children}
    </li>
  );
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{name}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function Hash({ value }: { value: string }) {
  return <code className="hash">{value}</code>;
}
