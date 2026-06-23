/**
 * ============================================================================
 * m4-demo — the REAL loopback backend the meta-skill-scaffolded capability reaches.
 * ============================================================================
 *
 * A tiny LOOPBACK "facts" HTTP service the scaffolded `local-rest` read-only
 * capability dispatches against. It is the REAL backend that makes the headline
 * loop honest-green: the agent's granted `invoke` issues a REAL HTTP GET against
 * THIS service (over the gateway's `LocalRestTransport`), and we assert the agent
 * receives the EXACT value this service holds — not a trusted "ok".
 *
 * It binds 127.0.0.1 only — the local-rest egress policy allows loopback by
 * default, so the scaffolded capability is confined to this loopback surface and
 * cannot reach the wider network. State lives in-process so the demo can compare
 * the agent's returned value against the service's OWN view (the value is the
 * proof: the agent didn't fabricate it, it came back over the real pipeline).
 *
 * Mirrors the `m4-user-workflow/server.ts` loopback-service pattern.
 */

export interface FactsRecord {
  topic: string;
  /** The canonical value the agent must receive verbatim through the pipeline. */
  value: string;
  source: string;
}

export interface FactsService {
  /** The loopback base URL the scaffolded capability's route resolves to. */
  baseUrl: string;
  /** The ephemeral loopback port (used as the manifest's serviceHint.defaultPort). */
  port: number;
  /** The service's OWN view of a topic — the demo asserts the agent got THIS value. */
  factFor(topic: string): FactsRecord | undefined;
  stop(): Promise<void>;
}

/**
 * Stand up the loopback facts service. Seeds one real record the headline loop
 * reads back end-to-end. `GET /facts/<topic>` returns the record as JSON; an
 * unknown topic 404s (so the transport surfaces a real HTTP error, not a fake ok).
 */
export async function startFactsService(): Promise<FactsService> {
  const facts = new Map<string, FactsRecord>();
  // The REAL datum the headline loop proves the agent receives verbatim.
  facts.set("plexus", {
    topic: "plexus",
    value: "Plexus is a local capability gateway, v0.1.2 (gate 289, security reviewed-green).",
    source: "facts-service",
  });
  facts.set("m4", {
    topic: "m4",
    value: "M4 ships the extension-authoring story: meta-skill scaffold, user skills, user workflows.",
    source: "facts-service",
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // ephemeral free port
    fetch(req) {
      const url = new URL(req.url);
      // GET /facts/<topic> → the record, or 404 for an unknown topic.
      const m = url.pathname.match(/^\/facts\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const topic = decodeURIComponent(m[1]!);
        const rec = facts.get(topic);
        if (!rec) return new Response(JSON.stringify({ error: "unknown topic" }), { status: 404, headers: { "content-type": "application/json" } });
        return Response.json(rec);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port ?? 0;
  if (!port) throw new Error("facts service could not bind a loopback port");
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    factFor: (topic: string) => facts.get(topic),
    stop: async () => {
      server.stop(true);
    },
  };
}
