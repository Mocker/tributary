import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types (mirror src/types/index.ts in the Worker)
// ---------------------------------------------------------------------------
export interface Claim {
  id: string;
  proposalId: string;
  agentId: string;
  paths: string[];
  symbols: string[];
  rationale: string;
  leaseExpiresAt: number;
  status: 'active' | 'released' | 'expired' | 'superseded';
  createdAt: number;
}

export interface Attestation {
  gateId: string;
  commitSha: string;
  verdict: 'pass' | 'fail';
  summary: string;
  detailsUri?: string;
  signedAt: number;
  signature: string;
}

export interface ChangeProposal {
  id: string;
  baselineRepo: string;
  forkRepo: string;
  agentId: string;
  taskRef: string;
  status: string;
  claims: Claim[];
  attestations: Attestation[];
  createdAt: number;
  updatedAt: number;
}

export interface LearningRule {
  date: string;
  slug: string;
  title: string;
  whatHappened: string;
  rule: string;
  filePath: string;
}

export interface InterventionCard {
  id: string;
  proposalId: string;
  title: string;
  description: string;
  conflictingClaim?: Claim;
  decision: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
}

export interface ClaimRejectedEvent {
  type: 'claim_rejected';
  proposalId: string;
  agentId: string;
  reason?: string;
  conflictingClaim?: Claim;
  interventionId?: string;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// REST helpers (same-origin: the Worker serves ui/dist alongside /v1)
// ---------------------------------------------------------------------------
async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchClaims(): Promise<Claim[]> {
  const d = await getJSON<{ claims: Claim[] }>('/v1/claims');
  return d.claims ?? [];
}

export async function fetchProposals(): Promise<ChangeProposal[]> {
  const d = await getJSON<{ proposals: ChangeProposal[] }>('/v1/proposals');
  return d.proposals ?? [];
}

export async function fetchLearnings(): Promise<LearningRule[]> {
  const d = await getJSON<{ learnings: LearningRule[] }>('/v1/learnings');
  return d.learnings ?? [];
}

export async function fetchInterventions(): Promise<InterventionCard[]> {
  const d = await getJSON<{ interventions: InterventionCard[] }>('/v1/interventions');
  return d.interventions ?? [];
}

export async function resolveIntervention(id: string, decision: 'approve' | 'reject'): Promise<void> {
  const res = await fetch(`/v1/interventions/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw new Error(`resolve -> ${res.status}`);
}

export async function runSimulation(): Promise<void> {
  const res = await fetch('/v1/admin/simulate', { method: 'POST' });
  if (!res.ok) throw new Error(`simulate -> ${res.status}`);
}

// ---------------------------------------------------------------------------
// Radar state hook: REST polling backbone + SSE context bus for live events
// ---------------------------------------------------------------------------
export type ConnectionState = 'connecting' | 'live' | 'unreachable';

export interface RadarState {
  claims: Claim[];
  proposals: ChangeProposal[];
  learnings: LearningRule[];
  interventions: InterventionCard[];
  lastRejection: ClaimRejectedEvent | null;
  connection: ConnectionState;
  refresh: () => void;
  dismissRejection: () => void;
}

const POLL_MS = 2500;

export function useRadar(): RadarState {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [proposals, setProposals] = useState<ChangeProposal[]>([]);
  const [learnings, setLearnings] = useState<LearningRule[]>([]);
  const [interventions, setInterventions] = useState<InterventionCard[]>([]);
  const [lastRejection, setLastRejection] = useState<ClaimRejectedEvent | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const sseRef = useRef<EventSource | null>(null);
  const sseTargetRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, p, l, i] = await Promise.all([
        fetchClaims(),
        fetchProposals(),
        fetchLearnings(),
        fetchInterventions(),
      ]);
      setClaims(c);
      setProposals(p);
      setLearnings(l);
      setInterventions(i);
      setConnection('live');
    } catch {
      setConnection((prev) => (prev === 'live' ? 'unreachable' : prev));
    }
  }, []);

  // Polling backbone (also covers environments where SSE is unavailable)
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // SSE: subscribe to the context bus of the most recently active proposal.
  // Live events (claim_rejected, claim_added, attestation_recorded,
  // proposal_merged, intervention_resolved) trigger an immediate refresh so
  // the panels stay in sync between polls.
  useEffect(() => {
    const latest = [...proposals].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest || sseTargetRef.current === latest.id) return;
    sseTargetRef.current = latest.id;
    sseRef.current?.close();

    let es: EventSource | null = null;
    try {
      es = new EventSource(`/v1/proposals/${latest.id}/events`);
    } catch {
      return;
    }
    sseRef.current = es;

    const onEvent = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && data.type === 'claim_rejected') {
          setLastRejection({ ...data, receivedAt: Date.now() } as ClaimRejectedEvent);
        }
        refresh();
      } catch {
        /* ignore malformed events */
      }
    };
    es.onmessage = onEvent;
    es.addEventListener('snapshot', onEvent);
    es.onerror = () => {
      /* polling keeps the radar alive; SSE reconnects on next proposal change */
    };
    return () => {
      es?.close();
    };
  }, [proposals, refresh]);

  const dismissRejection = useCallback(() => setLastRejection(null), []);

  return { claims, proposals, learnings, interventions, lastRejection, connection, refresh, dismissRejection };
}
