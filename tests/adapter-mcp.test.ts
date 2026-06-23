/**
 * t7 ADAPTER — MCP client roundtrip against a tiny in-test fake MCP server.
 *
 * The fake server speaks JSON-RPC 2.0 over an in-proc NDJSON `RpcChannel` (the SAME
 * channel abstraction the real stdio client uses — only the byte transport differs).
 * It exercises the genuine client code path:
 *   initialize (+ notifications/initialized) → tools/list (PAGINATED) +
 *   resources/list + prompts/list → tools/call (ok + isError) → resources/read →
 *   prompts/get.
 */

import { describe, it, expect } from "bun:test";
import { getPlatformServices } from "../src/platform/index.ts";
import { McpClientTransport } from "../src/transports/mcp.ts";
import { McpClient, type RpcChannel } from "../src/transports/mcp-client.ts";
import type { CapabilityEntry } from "../src/protocol/index.ts";

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

/**
 * A fake MCP server wired to the client over an in-proc channel. Records every
 * method it saw so the test can assert the handshake obligations. tools/list is
 * paginated across TWO pages to prove cursor-to-exhaustion.
 */
function makeFakeServerChannel(seen: string[]): RpcChannel {
  let lineCb: ((line: string) => void) | undefined;

  const reply = (id: number | string, result: unknown) => {
    // Deliver asynchronously, mimicking a real async transport.
    queueMicrotask(() => lineCb?.(JSON.stringify({ jsonrpc: "2.0", id, result })));
  };

  const channel: RpcChannel = {
    send(line: string) {
      const msg = JSON.parse(line) as JsonRpcReq;
      seen.push(msg.method);
      if (msg.id === undefined) return; // a notification — no response

      switch (msg.method) {
        case "initialize":
          reply(msg.id, {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "fake-mcp", version: "9.9.9" },
            capabilities: { tools: { listChanged: true } },
          });
          break;
        case "tools/list": {
          // Two pages: first returns nextCursor, second exhausts.
          if (!msg.params?.cursor) {
            reply(msg.id, {
              tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object" } }],
              nextCursor: "page2",
            });
          } else {
            reply(msg.id, {
              tools: [{ name: "fail", description: "Always errors", inputSchema: { type: "object" } }],
            });
          }
          break;
        }
        case "resources/list":
          reply(msg.id, { resources: [{ uri: "mem://note", name: "note", mimeType: "text/plain" }] });
          break;
        case "prompts/list":
          reply(msg.id, { prompts: [{ name: "greet", description: "Greeting prompt" }] });
          break;
        case "tools/call": {
          const name = msg.params?.name;
          if (name === "add") {
            const { a, b } = msg.params.arguments ?? {};
            reply(msg.id, {
              content: [{ type: "text", text: String((a ?? 0) + (b ?? 0)) }],
              structuredContent: { sum: (a ?? 0) + (b ?? 0) },
            });
          } else if (name === "fail") {
            reply(msg.id, { content: [{ type: "text", text: "boom" }], isError: true });
          } else {
            reply(msg.id, { content: [], isError: true });
          }
          break;
        }
        case "resources/read":
          reply(msg.id, {
            contents: [{ uri: msg.params.uri, mimeType: "text/plain", text: "hello world" }],
          });
          break;
        case "prompts/get":
          reply(msg.id, {
            messages: [{ role: "user", content: { type: "text", text: `hi ${msg.params.arguments?.who ?? ""}` } }],
          });
          break;
        default:
          queueMicrotask(() =>
            lineCb?.(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })),
          );
      }
    },
    onLine(cb) {
      lineCb = cb;
    },
    onClose() {},
    close() {},
  };
  return channel;
}

describe("adapter: MCP client roundtrip (in-proc fake server)", () => {
  it("initialize → list (paginated) → call/read/get over the real client", async () => {
    const seen: string[] = [];
    const client = new McpClient(makeFakeServerChannel(seen));

    const init = await client.initialize();
    expect(init.protocolVersion).toBe("2025-06-18");
    expect(init.serverInfo.name).toBe("fake-mcp");
    // Obligation: notifications/initialized sent after initialize, before any list.
    expect(seen).toContain("initialize");
    expect(seen).toContain("notifications/initialized");
    expect(seen.indexOf("notifications/initialized")).toBeGreaterThan(seen.indexOf("initialize"));

    const lists = await client.list();
    // tools/list paged to exhaustion → BOTH pages merged (add + fail).
    expect(lists.tools.map((t: any) => t.name).sort()).toEqual(["add", "fail"]);
    expect(lists.resources.length).toBe(1);
    expect(lists.prompts.length).toBe(1);

    const ok = await client.call("add", { a: 2, b: 3 });
    expect((ok.structuredContent as any).sum).toBe(5);

    const res = await client.readResource("mem://note");
    expect((res.contents as any[])[0].text).toBe("hello world");

    const prompt = await client.getPrompt("greet", { who: "ada" });
    expect((prompt.messages as any[])[0].content.text).toBe("hi ada");
  });

  it("McpClientTransport.dispatch branches on primitive and maps isError → mcp_tool_error", async () => {
    const seen: string[] = [];
    const transport = new McpClientTransport(getPlatformServices(), () => makeFakeServerChannel(seen));

    const toolEntry: CapabilityEntry = {
      id: "mcp.fake.add",
      source: "mcp:fake",
      kind: "capability",
      label: "Add",
      describe: "Add two numbers",
      grants: ["read"],
      transport: "mcp",
      mcp: { serverId: "fake", protocolVersion: "2025-06-18", primitive: "tool", originName: "add", raw: {} },
    };

    // tool → tools/call, verbatim mcpResult populated.
    const r = await transport.dispatch(toolEntry, { a: 4, b: 5 });
    expect(r.ok).toBe(true);
    expect((r.mcpResult?.structuredContent as any).sum).toBe(9);
    expect(r.mcpResult?.content).toBeDefined();

    // isError:true → ok:false + content preserved (the bridge maps to mcp_tool_error).
    const failEntry: CapabilityEntry = { ...toolEntry, id: "mcp.fake.fail", mcp: { ...toolEntry.mcp!, originName: "fail" } };
    const rf = await transport.dispatch(failEntry, {});
    expect(rf.ok).toBe(false);
    expect(rf.mcpResult?.isError).toBe(true);
    expect(rf.mcpResult?.content).toEqual([{ type: "text", text: "boom" }]);

    // resource → resources/read.
    const resEntry: CapabilityEntry = {
      ...toolEntry,
      id: "mcp.fake.note",
      mcp: { ...toolEntry.mcp!, primitive: "resource", originName: "mem://note" },
    };
    const rr = await transport.dispatch(resEntry, {});
    expect(rr.ok).toBe(true);
    expect((rr.mcpResult?.contents as any[])[0].text).toBe("hello world");

    // prompt → prompts/get.
    const promptEntry: CapabilityEntry = {
      ...toolEntry,
      id: "mcp.fake.greet",
      mcp: { ...toolEntry.mcp!, primitive: "prompt", originName: "greet" },
    };
    const rp = await transport.dispatch(promptEntry, { who: "grace" });
    expect(rp.ok).toBe(true);
    expect((rp.mcpResult?.messages as any[])[0].content.text).toBe("hi grace");

    transport.closeAll();
  });
});
