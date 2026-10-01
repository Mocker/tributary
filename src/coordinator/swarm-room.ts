export interface AgentPresence {
  agentId: string;
  role: string;
  forkName: string;
  activeFiles: string[];
  status: 'active' | 'testing' | 'conflict_arbitration' | 'completed';
  lastSeen: number;
}

export interface SwarmBroadcastMessage {
  type: 'agent_presence' | 'signature_invalidation' | 'conflict_alert' | 'learning_crystallized';
  payload: any;
  timestamp: number;
}

export class SwarmCoordinator {
  private state: DurableObjectState;
  private agents: Map<string, AgentPresence> = new Map();
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for live agent / dashboard connection
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      server.accept();
      this.sockets.add(server);

      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handleSocketMessage(server, data);
        } catch (e) {
          // ignore malformed payloads
        }
      });

      server.addEventListener('close', () => {
        this.sockets.delete(server);
      });

      // Send initial presence state
      server.send(
        JSON.stringify({
          type: 'swarm_state',
          agents: Array.from(this.agents.values()),
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP RPC endpoints
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = (await request.json()) as AgentPresence;
      this.agents.set(body.agentId, { ...body, lastSeen: Date.now() });
      this.broadcast({ type: 'agent_presence', payload: body, timestamp: Date.now() });
      return Response.json({ success: true, activeSwarmCount: this.agents.size });
    }

    if (url.pathname === '/invalidate' && request.method === 'POST') {
      const body = await request.json();
      this.broadcast({ type: 'signature_invalidation', payload: body, timestamp: Date.now() });
      return Response.json({ success: true });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return Response.json({
        activeAgents: Array.from(this.agents.values()),
        connectedClients: this.sockets.size,
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleSocketMessage(ws: WebSocket, msg: any) {
    if (msg.type === 'heartbeat') {
      const agent = this.agents.get(msg.agentId);
      if (agent) {
        agent.lastSeen = Date.now();
        if (msg.activeFiles) agent.activeFiles = msg.activeFiles;
      }
    }
  }

  private broadcast(msg: SwarmBroadcastMessage) {
    const serialized = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(serialized);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}
