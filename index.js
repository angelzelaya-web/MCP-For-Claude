import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── Command Queue ───────────────────────────
let commandQueue = [];
let commandIdCounter = 0;

function enqueueCommand(tool, args) {
  const id = ++commandIdCounter;
  commandQueue.push({ id, tool, args, status: "pending", result: null });
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
        reject(new Error("Timeout - Is the Roblox Studio plugin running?"));
      }
    }, 200);
  });
}

async function studioCall(tool, args) {
  const id = enqueueCommand(tool, args);
  const result = await waitForResult(id);
  if (result && result.error) throw new Error(result.error);
  return result;
}

// ─── Tool Definitions ─────────────────────────
const TOOLS = [
  { name: "run_script",       description: "Execute Lua code in Roblox Studio.", inputSchema: { type: "object", properties: { code: { type: "string" }, context: { type: "string", enum: ["Server","Client","Plugin"], default: "Plugin" } }, required: ["code"] } },
  { name: "insert_instance",  description: "Insert a new Instance into Roblox Studio.", inputSchema: { type: "object", properties: { className: { type: "string" }, parent: { type: "string" }, name: { type: "string" }, properties: { type: "object" } }, required: ["className","parent"] } },
  { name: "edit_script",      description: "Edit a script's source code in Studio.", inputSchema: { type: "object", properties: { path: { type: "string" }, source: { type: "string" } }, required: ["path","source"] } },
  { name: "get_script",       description: "Read a script's source code from Studio.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "set_property",     description: "Set a property on any instance in Studio.", inputSchema: { type: "object", properties: { path: { type: "string" }, property: { type: "string" }, value: {} }, required: ["path","property","value"] } },
  { name: "list_children",    description: "List children of an instance in Studio.", inputSchema: { type: "object", properties: { path: { type: "string", default: "game" } }, required: [] } },
  { name: "delete_instance",  description: "Delete an instance from Studio.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "move_instance",    description: "Move/reparent an instance in Studio.", inputSchema: { type: "object", properties: { path: { type: "string" }, newParent: { type: "string" } }, required: ["path","newParent"] } },
];

// ─── Create a fresh Server per connection ────
function createServer() {
  const server = new Server(
    { name: "roblox-studio", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await studioCall(name, args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  });

  return server;
}

// ─── Studio Plugin Endpoints ─────────────────
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
  res.json({ status: "🟢 Roblox MCP Server running", queue: commandQueue.length });
});

// ─── SSE Transport ───────────────────────────
const transports = {};

app.get("/sse", async (req, res) => {
  console.log("🔌 Claude connecting...");
  try {
    const transport = new SSEServerTransport("/messages", res);
    const server = createServer();

    transports[transport.sessionId] = { transport, server };

    res.on("close", () => {
      console.log("🔌 Claude disconnected:", transport.sessionId);
      delete transports[transport.sessionId];
    });

    await server.connect(transport);
    console.log("✅ Connected:", transport.sessionId);
  } catch (err) {
    console.error("SSE error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports[sessionId];
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  try {
    await session.transport.handlePostMessage(req, res);
  } catch (err) {
    console.error("Message error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Roblox MCP Server running on port ${PORT}`);
});
