import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolClient {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: any }>>;
  /** Calls a tool and parses its JSON payload. */
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  /** Calls a tool and returns the raw result, including schema rejections. */
  callRaw(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }>;
  close(): Promise<void>;
}

/** Connects an in-memory MCP client to a server, as a real host would. */
export async function connectToolClient(server: McpServer): Promise<ToolClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const callRaw = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
  };

  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools;
    },
    async call(name, args = {}) {
      const { text } = await callRaw(name, args);
      try {
        return JSON.parse(text);
      } catch {
        return { _unparsed: text };
      }
    },
    callRaw,
    async close() {
      await client.close();
    },
  };
}
