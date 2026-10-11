import { useState } from 'react';
import {
  useRadar,
  resolveIntervention,
  runSimulation,
  type Attestation,
  type ChangeProposal,
  type Claim,
  type InterventionCard,
  type LearningRule,
} from './api';
import './index.css';

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------
function leaseMinutes(claim: Claim): number {
  return Math.max(0, Math.round((claim.leaseExpiresAt - Date.now()) / 60000));
}

function Empty({ children }: { children: string }) {
  return <div className="empty">{children}</div>;
}

function Panel({ title, icon, badge, children }: { title: string; icon: string; badge?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <span>{icon}</span>
          <h2>{title}</h2>
        </div>
        {badge && <span className="pill">{badge}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function ClaimCard({ claim }: { claim: Claim }) {
  return (
    <div className="card">
      <div className="card-row">
        <span className="agent">{claim.agentId}</span>
        <span className="meta">lease: {leaseMinutes(claim)}m</span>
      </div>
      <div className="tags">
        {claim.paths.map((p) => (
          <span key={p} className="tag">{p}</span>
        ))}
        {(claim.symbols ?? []).map((s) => (
          <span key={s} className="tag sym">sym:{s}</span>
        ))}
      </div>
      {claim.rationale && <div className="rationale">{claim.rationale}</div>}
    </div>
  );
}

function AttestationCard({ a, agentId }: { a: Attestation; agentId: string }) {
  const pass = a.verdict === 'pass';
  return (
    <div className="card">
      <div className="card-row">
        <span className="gate">gate:{a.gateId}</span>
        <span className={`verdict ${pass ? 'pass' : 'fail'}`}>{a.verdict.toUpperCase()}</span>
      </div>
      <div className="meta">commit: {a.commitSha.slice(0, 10)} · {agentId}</div>
      <div className="summary">{a.summary}</div>
      <div className="sig" title={a.signature}>sig: {a.signature.slice(0, 32)}…</div>
    </div>
  );
}

function LearningCard({ l }: { l: LearningRule }) {
  return (
    <div className="card memory">
      <div className="memory-title">{l.title}</div>
      <blockquote>{l.rule}</blockquote>
      <div className="meta">{l.filePath}</div>
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  claiming: 'st-claiming',
  working: 'st-working',
  gating: 'st-gating',
  merging: 'st-merging',
  merged: 'st-merged',
  rejected: 'st-rejected',
  expired: 'st-expired',
};

function MergeQueue({ proposals }: { proposals: ChangeProposal[] }) {
  if (proposals.length === 0) return null;
  return (
    <section className="queue">
      <div className="queue-head">
        <span>🔀</span>
        <h2>Merge Queue</h2>
        <span className="pill">{proposals.length} open</span>
      </div>
      <div className="queue-list">
        {proposals.map((p) => (
          <div key={p.id} className="queue-item">
            <span className="queue-task">{p.taskRef}</span>
            <span className="meta">{p.agentId}</span>
            <span className={`status ${STATUS_CLASS[p.status] ?? ''}`}>{p.status}</span>
            <span className="meta">
              {(p.claims ?? []).length} claims · {(p.attestations ?? []).length} gates
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function InterventionDrawer({
  interventions,
  onResolved,
}: {
  interventions: InterventionCard[];
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (interventions.length === 0) return null;

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusy(id);
    setError(null);
    try {
      await resolveIntervention(id, decision);
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'resolve failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="drawer">
      <div className="drawer-head">
        <span className="action-required">ACTION REQUIRED</span>
        <h2>Claim Overlap Interventions</h2>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="drawer-list">
        {interventions.map((card) => (
          <div key={card.id} className="card intervention">
            <div className="card-row">
              <span className="agent">{card.title}</span>
              <span className="meta">{new Date(card.createdAt).toLocaleTimeString()}</span>
            </div>
            {/* The one-sentence rejection explanation — the money shot */}
            <p className="rejection-reason">“{card.description}”</p>
            {card.conflictingClaim && (
              <div className="meta">
                held by <b>{card.conflictingClaim.agentId}</b> on{' '}
                {card.conflictingClaim.paths.join(', ')}
              </div>
            )}
            <div className="btn-row">
              <button
                className="btn reject"
                disabled={busy === card.id}
                onClick={() => decide(card.id, 'reject')}
              >
                1-Tap Reject
              </button>
              <button
                className="btn approve"
                disabled={busy === card.id}
                onClick={() => decide(card.id, 'approve')}
              >
                1-Tap Approve
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Judge Tour with Quick curl Snippets
// ---------------------------------------------------------------------------
function JudgeTour({ onClose }: { onClose: () => void }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const snippets = [
    {
      title: '1. Mint Agent API Key',
      desc: 'Mint an authorized key for an agent. Keys are SHA-256 hashed in Cloudflare KV.',
      cmd: `curl -s -X POST https://tributary.sokercap.workers.dev/v1/admin/keys \\
  -H 'Content-Type: application/json' \\
  -d '{"agentId":"agent-alpha","name":"Alpha Agent"}'`,
    },
    {
      title: '2. Declare Claim (Collision Check)',
      desc: 'Declare intent on paths and symbols. Overlaps are rejected at claim time with HTTP 409.',
      cmd: `curl -s -X POST https://tributary.sokercap.workers.dev/v1/proposals/<PROPOSAL_ID>/claims \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H 'Content-Type: application/json' \\
  -d '{"paths":["src/auth/**"],"symbols":["createSession"],"rationale":"Auth upgrade"}'`,
    },
    {
      title: '3. Run Verification Gate',
      desc: 'Deterministic test gate emits cryptographically signed HMAC attestation on commit SHA.',
      cmd: `curl -s -X POST https://tributary.sokercap.workers.dev/v1/proposals/<PROPOSAL_ID>/gates/test/run \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H 'Content-Type: application/json' \\
  -d '{"commitSha":"a1b2c3d4e5f67890123456789012345678901234"}'`,
    },
    {
      title: '4. Physical Merge & Memory Invariant',
      desc: 'Worker runs isomorphic-git in MemoryFS, validates CAS, and commits learnings/ to git.',
      cmd: `curl -s -X POST https://tributary.sokercap.workers.dev/v1/proposals/<PROPOSAL_ID>/merge \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H 'Content-Type: application/json' \\
  -d '{"commitSha":"a1b2c3d4e5f67890123456789012345678901234","learning":{"title":"Shared Session Boundary","whatHappened":"Collision avoided","rule":"Always claim session.ts explicitly"}}'`,
    },
    {
      title: '5. Run 6-Act Swarm Simulation (1-Tap)',
      desc: 'Execute complete 6-act swarm collision walkthrough through live CoordinatorDO.',
      cmd: `curl -s -X POST https://tributary.sokercap.workers.dev/v1/admin/simulate`,
    },
  ];

  const copy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  return (
    <section className="tour-panel">
      <div className="tour-head">
        <div>
          <span className="tour-badge">JUDGE API QUICK TOUR</span>
          <h2>Zero-Friction Terminal Walkthrough</h2>
          <p className="tour-subtitle">
            Drive Tributary directly from your local terminal against this live Cloudflare Workers + Artifacts deployment.
          </p>
        </div>
        <button className="btn dismiss" onClick={onClose}>✕ Close</button>
      </div>
      <div className="tour-grid">
        {snippets.map((s, idx) => (
          <div key={idx} className="tour-step">
            <div className="tour-step-head">
              <span className="tour-step-title">{s.title}</span>
              <button
                className="btn copy-btn"
                onClick={() => copy(s.cmd, idx)}
              >
                {copiedIdx === idx ? '✓ Copied' : '📋 Copy curl'}
              </button>
            </div>
            <p className="tour-step-desc">{s.desc}</p>
            <pre className="tour-code"><code>{s.cmd}</code></pre>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const { claims, proposals, learnings, interventions, lastRejection, connection, refresh, dismissRejection } =
    useRadar();
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [showTour, setShowTour] = useState(false);

  const allAttestations: { a: Attestation; agentId: string }[] = [...proposals]
    .sort((x, y) => y.updatedAt - x.updatedAt)
    .flatMap((p: ChangeProposal) =>
      (p.attestations ?? []).map((a) => ({ a, agentId: p.agentId })),
    )
    .sort((x, y) => y.a.signedAt - x.a.signedAt)
    .slice(0, 8);

  const openProposals = [...proposals]
    .filter((p) => !['merged', 'rejected', 'expired'].includes(p.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const doSimulate = async () => {
    setSimulating(true);
    setSimError(null);
    try {
      await runSimulation();
      await refresh();
    } catch (e) {
      setSimError(e instanceof Error ? e.message : 'simulation failed');
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <div className="brand">
            <span className="wave">🌊</span>
            <span className="brand-name">Tributary</span>
            <span className="live-badge">LIVE RADAR</span>
            <span className={`conn ${connection}`}>
              {connection === 'live' ? '● connected' : connection === 'connecting' ? '● connecting…' : '● backend unreachable'}
            </span>
          </div>
          <p className="thesis">“GitHub coordinates humans. Tributary coordinates agents.”</p>
        </div>
        <div className="header-actions">
          <div className="substrate">
            Substrate: <b>Artifacts</b> | Runtime: <b>Workers DO</b>
          </div>
          <button className="btn tour" onClick={() => setShowTour((v) => !v)}>
            {showTour ? '✕ Hide API Tour' : '📖 Judge API Tour'}
          </button>
          <button className="btn simulate" onClick={doSimulate} disabled={simulating}>
            {simulating ? '⏳ Simulating…' : '▶️ Run Swarm Simulation'}
          </button>
        </div>
      </header>
      {simError && <div className="error">{simError}</div>}
      {showTour && <JudgeTour onClose={() => setShowTour(false)} />}

      {/* Claim rejection banner — surfaces the one-sentence reason prominently */}
      {lastRejection && (
        <div className="rejection-banner" role="alert">
          <div>
            <div className="rejection-kicker">🚨 CLAIM REJECTED AT CLAIM TIME — zero compute wasted</div>
            <p className="rejection-reason big">“{lastRejection.reason ?? 'Overlapping claim detected.'}”</p>
            <div className="meta">
              {lastRejection.agentId} · {new Date(lastRejection.receivedAt).toLocaleTimeString()}
            </div>
          </div>
          <button className="btn dismiss" onClick={dismissRejection}>
            Dismiss
          </button>
        </div>
      )}

      <div className="grid">
        <Panel title="1. Live Claims" icon="🛡️" badge={`${claims.length} active`}>
          {claims.length === 0 ? (
            <Empty>No active claims</Empty>
          ) : (
            claims.map((c) => <ClaimCard key={c.id} claim={c} />)
          )}
        </Panel>

        <Panel title="2. Gate Attestations" icon="⚡" badge={`${allAttestations.length} latest · HMAC`}>
          {allAttestations.length === 0 ? (
            <Empty>Awaiting gate runs</Empty>
          ) : (
            allAttestations.map(({ a, agentId }, i) => (
              <AttestationCard key={`${a.gateId}-${a.commitSha}-${i}`} a={a} agentId={agentId} />
            ))
          )}
        </Panel>

        <Panel title="3. Epistemic Memory" icon="🧠" badge="learnings/">
          {learnings.length === 0 ? (
            <Empty>No learnings crystallized</Empty>
          ) : (
            learnings.map((l) => <LearningCard key={l.slug} l={l} />)
          )}
        </Panel>
      </div>

      <InterventionDrawer interventions={interventions} onResolved={refresh} />

      <MergeQueue proposals={openProposals} />

      <footer className="footer">
        {openProposals.length} open · {proposals.length} total proposals · Tributary Radar
      </footer>
    </div>
  );
}
