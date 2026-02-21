import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json());

let commandQueue = [];
let commandIdCounter = 0;

function enqueueCommand(tool, args) {
  const id = ++commandIdCounter;
  const cmd = { id, tool, args, status: "pending", result: null };
  commandQueue.push(cmd);
  return id;
}

function waitForResult(id, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const cmd = commandQueue.find((c) => c.id === id);
      if (!cmd) { clearInterval(interval); reject(new Error("Command not found")); return; }
      if (cmd.status === "done") {
        clearInterval(interval);
        commandQueue = commandQueue.filter((c) => c.id !== id);
        resolve(cmd.result);
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        commandQueue = commandQueue.filter((c) => c.id !== id);
        reject(new Error("Timeout - Is Roblox Studio plugin running?"));
      }
    }, 200);
  });
}

app.get("/studio/poll", (req, res) => {
  const pending = commandQueue.filter((c) => c.status === "pending");
  pending.forEach((c) => (c.status = "sent"));
  res.json(pending);
});

app.post("/studio/result", (req, res) => {
  const { id, result, error } = req.body;
  const cmd = commandQueue.find((c) => c.id === id);
  if (cmd) {
    cmd.status = "done";
    cmd.result = error ? { error } : result;
  }
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.json({ status: "🟢 Roblox MCP Server running" });
});

const mcpServer = new McpServer({ name: "roblox-studio", version: "1.0.0" });

async function studioCall(tool, args) {
  const id = enqueueCommand(tool, args);
  const result = await waitForResult(id);
  if (result && result.error) throw new Error(result.error);
  return result;
}

mcpServer.tool("run_script", "Execute Lua in Roblox Studio.",
  { code: z.string(), context: z.enum(["Server", "Client", "Plugin"]).default("Plugin") },
  async ({ code, context }) => {
    const result = await studioCall("run_script", { code, context });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool("insert_instance", "Insert a new Instance into Roblox Studio.",
  { className: z.string(), parent: z.string(), name: z.string().optional(), properties: z.record(z.any()).optional() },
  async (args) => {
    const result = await studioCall("insert_instance", args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool("edit_script", "Edit a script's source code.",
  { path: z.string(), source: z.string() },
  async (args) => {
    const result = await studioCall("edit_script", args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool("get_script", "Read a script's source code.",
  { path: z.string() },
  async ({ path }) => {
    const result = await studioCall("get_script", { path });
    return { content: [{ type: "text", text: result.source ?? "No source found" }] };
  }
);

mcpServer.tool("set_property", "Set a property on any instance.",
  { path: z.string(), property: z.string(), value: z.any() },
  async (args) => {
    const result = await studioCall("set_property", args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool("list_children", "List children of an instance.",
  { path: z.string().default("game") },
  async ({ path }) => {
    const result = await studioCall("list_children", { path });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool("delete_instance", "Delete an instance.",
  { path: z.string() },
  async ({ path }) => {
    const result = await studioCall("delete_instance", { path });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

mcpServer.tool("move_instance", "Move/reparent an instance.",
  { path: z.string(), newParent: z.string() },
  async (args) => {
    const result = await studioCall("move_instance", args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transports = {};

app.get("/sse", async (req, res) => {
  console.log("🔌 Claude connected via SSE");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) { res.status(404).json({ error: "Session not found" }); return; }
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
