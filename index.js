/**
 * Roblox Studio MCP Server
 * 
 * This server bridges Claude AI with Roblox Studio via:
 * - MCP tools that Claude can call
 * - A command queue that the Roblox Studio plugin polls
 * - SSE transport for Claude Desktop compatibility
 */

import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// COMMAND QUEUE (in-memory)
// The Roblox plugin polls /studio/poll and picks
// up pending commands, then posts results back.
// ─────────────────────────────────────────────
let commandQueue = [];   // { id, tool, args, status, result }
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
        reject(new Error("Timeout waiting for Roblox Studio response. Is the plugin running?"));
      }
    }, 200);
  });
}

// ─────────────────────────────────────────────
// STUDIO PLUGIN ENDPOINTS
// ─────────────────────────────────────────────

// Plugin polls this to get pending commands
app.get("/studio/poll", (req, res) => {
  const pending = commandQueue.filter((c) => c.status === "pending");
  // Mark them as "sent"
  pending.forEach((c) => (c.status = "sent"));
  res.json(pending);
});

// Plugin posts results back here
app.post("/studio/result", (req, res) => {
  const { id, result, error } = req.body;
  const cmd = commandQueue.find((c) => c.id === id);
  if (cmd) {
    cmd.status = "done";
    cmd.result = error ? { error } : result;
  }
  res.json({ ok: true });
});

// Health check / status
app.get("/", (req, res) => {
  res.json({
    status: "🟢 Roblox MCP Server running",
    pendingCommands: commandQueue.filter((c) => c.status !== "done").length,
    docs: "Connect Claude Desktop to /sse  |  Point Studio plugin to this URL",
  });
});

// ─────────────────────────────────────────────
// MCP SERVER + TOOLS
// ─────────────────────────────────────────────
const mcpServer = new McpServer({
  name: "roblox-studio",
  version: "1.0.0",
});

// ── Helper to send a command and await result ──
async function studioCall(tool, args) {
  const id = enqueueCommand(tool, args);
  const result = await waitForResult(id);
  if (result && result.error) throw new Error(result.error);
  return result;
}

// ── TOOL: Run Lua Script ──
mcpServer.tool(
  "run_script",
  "Execute a Lua script in Roblox Studio and return the output.",
  {
    code: z.string().describe("The Lua code to run in the Studio command bar / environment"),
    context: z.enum(["Server", "Client", "Plugin"]).default("Plugin").describe("Where to run the script"),
  },
  async ({ code, context }) => {
    const result = await studioCall("run_script", { code, context });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── TOOL: Insert Instance ──
mcpServer.tool(
  "insert_instance",
  "Insert a new Instance (Part, Script, Model, etc.) into the Roblox Studio hierarchy.",
  {
    className: z.string().describe("Roblox class name e.g. Part, Script, LocalScript, Model, RemoteEvent"),
    parent: z.string().describe("Path to parent e.g. 'game.Workspace' or 'game.ServerScriptService'"),
    name: z.string().optional().describe("Name for the new instance"),
    properties: z.record(z.any()).optional().describe("Key/value map of properties to set"),
  },
  async ({ className, parent, name, properties }) => {
    const result = await studioCall("insert_instance", { className, parent, name, properties });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── TOOL: Edit Script Source ──
mcpServer.tool(
  "edit_script",
  "Edit the source code of an existing Script or LocalScript in Studio.",
  {
    path: z.string().describe("Full path to the script e.g. 'game.ServerScriptService.MyScript'"),
    source: z.string().describe("The new Lua source code"),
  },
  async ({ path, source }) => {
    const result = await studioCall("edit_script", { path, source });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── TOOL: Get Script Source ──
mcpServer.tool(
  "get_script",
  "Read the source code of a Script or LocalScript from Studio.",
  {
    path: z.string().describe("Full path to the script e.g. 'game.ServerScriptService.MyScript'"),
  },
  async ({ path }) => {
    const result = await studioCall("get_script", { path });
    return { content: [{ type: "text", text: result.source ?? "No source found" }] };
  }
);

// ── TOOL: Set Property ──
mcpServer.tool(
  "set_property",
  "Set a property on any instance in the Studio hierarchy.",
  {
    path: z.string().describe("Full path to the instance"),
    property: z.string().describe("Property name e.g. 'Position', 'BrickColor', 'Anchored'"),
    value: z.any().describe("Value to set (string, number, boolean, or {X,Y,Z} table for Vector3)"),
  },
  async ({ path, property, value }) => {
    const result = await studioCall("set_property", { path, property, value });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── TOOL: List Children ──
mcpServer.tool(
  "list_children",
  "List all children of an instance in the Studio hierarchy.",
  {
    path: z.string().default("game").describe("Path to the instance e.g. 'game.Workspace'"),
  },
  async ({ path }) => {
    const result = await studioCall("list_children", { path });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── TOOL: Delete Instance ──
mcpServer.tool(
  "delete_instance",
  "Delete an instance from the Studio hierarchy.",
  {
    path: z.string().describe("Full path to the instance to delete"),
  },
  async ({ path }) => {
    const result = await studioCall("delete_instance", { path });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── TOOL: Move Instance ──
mcpServer.tool(
  "move_instance",
  "Move/reparent an instance to a new parent.",
  {
    path: z.string().describe("Full path to the instance to move"),
    newParent: z.string().describe("Full path to the new parent"),
  },
  async ({ path, newParent }) => {
    const result = await studioCall("move_instance", { path, newParent });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── TOOL: Insert Model from Toolbox ──
mcpServer.tool(
  "insert_free_model",
  "Insert a free Roblox Toolbox asset into the game by assetId.",
  {
    assetId: z.number().describe("The Roblox asset ID to insert"),
    parent: z.string().default("game.Workspace").describe("Path to place the model"),
  },
  async ({ assetId, parent }) => {
    const result = await studioCall("insert_free_model", { assetId, parent });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ─────────────────────────────────────────────
// SSE TRANSPORT SETUP (Claude Desktop compatible)
// ─────────────────────────────────────────────
const transports = {};

app.get("/sse", async (req, res) => {
  console.log("🔌 Claude connected via SSE");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    console.log("🔌 Claude disconnected");
    delete transports[transport.sessionId];
  });
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Roblox MCP Server started on port ${PORT}`);
  console.log(`   Claude Desktop SSE:  http://localhost:${PORT}/sse`);
  console.log(`   Studio Plugin URL:   http://localhost:${PORT}/studio/poll\n`);
});
