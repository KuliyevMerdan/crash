import type { CrashClient } from '@crash/client-core';
import { useEffect, useRef, useState } from 'react';
import { useClientState } from './useClient.js';

const LATENCIES = [0, 50, 150, 500, 1500] as const;
const LOSSES = [0, 0.05, 0.2, 0.5] as const;

/**
 * The network lab (ROADMAP P0): break your own connection and watch the client recover. It drives
 * the server's fault injection on this socket only (`devFaults`, `devStall`, `devDisconnect` —
 * docs/protocol.md §9), so nobody else at the table notices. The chosen link is re-applied on every
 * new connection, or a reconnect would quietly heal it. A server that does not listen ignores all
 * of it, and the ping shown below says so.
 */
export function NetworkLab({ client }: { client: CrashClient }) {
  const state = useClientState(client);
  const [latencyMs, setLatency] = useState<number>(0);
  const [lossRate, setLoss] = useState<number>(0);
  const [log, setLog] = useState<string[]>([]);
  const link = useRef({ latencyMs, lossRate });
  const dropped = useRef(false);

  const note = (line: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()} ${line}`, ...l].slice(0, 5));

  useEffect(
    () =>
      client.subscribe((_s, event) => {
        if (event.type === 'hello') {
          const { latencyMs: lat, lossRate: loss } = link.current;
          if (lat > 0 || loss > 0)
            client.sendDev({ type: 'devFaults', latencyMs: lat, lossRate: loss });
        } else if (event.type === 'status' && event.status === 'reconnecting') {
          dropped.current = true;
          note('connection lost — reconnecting');
        } else if (event.type === 'status' && event.status === 'live' && dropped.current) {
          dropped.current = false;
          note('back: a fresh hello restored the round');
        } else if (event.type === 'resync') {
          note(`out of step (${event.cause}) — asked for a fresh hello`);
        }
      }),
    [client],
  );

  const apply = (lat: number, loss: number) => {
    link.current = { latencyMs: lat, lossRate: loss };
    setLatency(lat);
    setLoss(loss);
    client.sendDev({ type: 'devFaults', latencyMs: lat, lossRate: loss });
  };

  // The server drops the connection (`devDisconnect`), and this end lets go too. A close the server
  // starts does not get through every proxy: behind Render's, the browser heard nothing until the
  // proxy timed out ~20 s later (P1). A close the browser starts does, at once.
  const drop = () => {
    if (!client.sendDev({ type: 'devDisconnect' })) return;
    note('dropped by the server');
    client.dropConnection();
  };

  const rtt = state.clock.rtt;
  return (
    <details className="lab">
      <summary>Network lab</summary>
      <p className="lab-why">
        Break your own connection — nobody else at the table is touched — and watch the game hold
        its round, its bets and your balance.
      </p>
      <div className="lab-row" role="group" aria-label="Latency, each way">
        <span>Latency</span>
        {LATENCIES.map((ms) => (
          <button
            key={ms}
            type="button"
            aria-pressed={latencyMs === ms}
            onClick={() => apply(ms, lossRate)}
          >
            {ms === 0 ? 'none' : `${ms} ms`}
          </button>
        ))}
      </div>
      <div className="lab-row" role="group" aria-label="Packet loss">
        <span>Loss</span>
        {LOSSES.map((loss) => (
          <button
            key={loss}
            type="button"
            aria-pressed={lossRate === loss}
            onClick={() => apply(latencyMs, loss)}
          >
            {loss === 0 ? 'none' : `${Math.round(loss * 100)}%`}
          </button>
        ))}
      </div>
      <div className="lab-row">
        <button
          type="button"
          onClick={() => client.sendDev({ type: 'devStall', ms: 3000 }) && note('frozen for 3 s')}
        >
          Freeze 3 s
        </button>
        <button type="button" onClick={drop}>
          Drop connection
        </button>
      </div>
      <p className="lab-status">
        {state.status} · ping {rtt === null ? '—' : `${Math.round(rtt)} ms`}
        {state.clock.offset !== null && ` · clock ${Math.round(state.clock.offset)} ms off`}
      </p>
      <p className="lab-small">
        Lost packets are resent, as TCP does: a frame arrives late and in order, never not at all.
        The ping is the median of the last five, one every 5 s — it catches up within ~15 s.
      </p>
      {log.length > 0 && (
        <ol className="lab-log" aria-live="polite">
          {log.map((line, i) => (
            <li key={`${i}-${line}`}>{line}</li>
          ))}
        </ol>
      )}
    </details>
  );
}
