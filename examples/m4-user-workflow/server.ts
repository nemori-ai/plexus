/**
 * A tiny LOOPBACK "journal" HTTP service the workflow members reach over the
 * `local-rest` transport. It is the REAL side-effecting backend that makes the
 * fan-out honest-green: the workflow's append member POSTs here (mutating in-memory
 * state we can read back), and the list member GETs the state back.
 *
 * It binds 127.0.0.1 only — the local-rest egress policy allows loopback by default,
 * so no host allow-list is needed. State lives in-process so the demo can read the
 * service's OWN view back and assert the append really executed (not trusting the
 * workflow's return value).
 */

export interface JournalService {
  /** The loopback base URL the member `route.baseUrl` points at. */
  baseUrl: string;
  /** The service's own view of its state — read back to prove a real mutation. */
  state(): { entries: string[]; count: number };
  stop(): Promise<void>;
}

export async function startJournalService(): Promise<JournalService> {
  const entries: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // ephemeral free port
    async fetch(req) {
      const url = new URL(req.url);

      // POST /entry  { text } → append the line; return what landed + the new count.
      if (req.method === "POST" && url.pathname === "/entry") {
        let body: { text?: unknown } = {};
        try {
          body = (await req.json()) as { text?: unknown };
        } catch {
          /* empty body */
        }
        const text = typeof body.text === "string" ? body.text : "";
        entries.push(text);
        return Response.json({ stored: text, count: entries.length });
      }

      // GET /entries → the whole log back.
      if (req.method === "GET" && url.pathname === "/entries") {
        return Response.json({ entries: [...entries], count: entries.length });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl,
    state: () => ({ entries: [...entries], count: entries.length }),
    stop: async () => {
      server.stop(true);
    },
  };
}
