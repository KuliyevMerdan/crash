const ADR = 'https://github.com/KuliyevMerdan/crash/blob/main/docs/adr';

/** The short version of the two decisions everything hangs on, with the long versions linked. */
export function HowItWorks({ open = false }: { open?: boolean }) {
  return (
    <details className="how" open={open}>
      <summary>How this works</summary>
      <p>
        <strong>The result exists before anyone bets.</strong> Every round's crash point comes from
        a seed in a hash chain the server generated in advance. It published the chain's last link —
        the <em>commit</em> — before the first round, and reveals one seed per round, from the far
        end back. Each seed hashes into the one revealed before it, so none can be swapped in after
        the fact without breaking the chain back to the commit.{' '}
        <a href={`${ADR}/ADR-0001-committed-crash-point.md`} target="_blank" rel="noreferrer">
          ADR-0001
        </a>
      </p>
      <p>
        <strong>The server's clock decides a cash-out.</strong> The number on screen is a
        prediction; what pays is the curve at the moment your press reaches the server. That is why
        the button prices the press half a round trip ahead, and why an auto cash-out — which fires
        on the server, at exactly its target — is the honest answer to latency.{' '}
        <a href={`${ADR}/ADR-0002-server-time-cashout.md`} target="_blank" rel="noreferrer">
          ADR-0002
        </a>
      </p>
      <p>
        Pick any past round in the strip to check it yourself: this page recomputes it in your
        browser with the same code the server ran. <a href="#/verify">Open the verifier</a>
      </p>
    </details>
  );
}
