/**
 * Automated tests for the stdio bridge's behaviour while Arduino Agent is closed,
 * starting, or running. A fake upstream stands in for the IDE's MCP server.
 *
 *   yarn test:bridge        (from arduino-mcp-extension, after `yarn build`)
 *
 * Node builtins only, like the bridge itself.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', '..', 'bridge', 'arduino-agent-bridge.js');
const LIB = path.join(__dirname, '..', '..', 'lib', 'common');
const libBuilt = fs.existsSync(path.join(LIB, 'mcp-tool-router.js'));
const needsLib = { skip: libBuilt ? false : 'compiled extension missing - run yarn build first' };
const TOKEN = 'test-token';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Minimal stand-in for the IDE's Streamable HTTP MCP server. */
function fakeIde(port, { tools, token = TOKEN } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const msg = JSON.parse(raw);
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (msg.method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-ide' } };
      } else if (msg.method === 'tools/list') {
        result = { tools };
      } else if (msg.method === 'tools/call') {
        calls.push(msg.params.name);
        result = { content: [{ type: 'text', text: `ran ${msg.params.name}` }] };
      } else {
        result = {};
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fake-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })
    )
  );
}

/** Spawns the bridge with an isolated home directory and a JSON-RPC client around it. */
function startBridge(port, env = {}, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-bridge-test-'));
  if (settings) {
    fs.mkdirSync(path.join(home, '.arduinoIDE'));
    fs.writeFileSync(path.join(home, '.arduinoIDE', 'settings.json'), JSON.stringify(settings));
  }
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ARDUINO_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    ARDUINO_MCP_TOKEN: TOKEN,
    ARDUINO_MCP_WATCH_INTERVAL: '0.2',
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  const child = spawn(process.execPath, [BRIDGE], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });

  const received = [];
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      received.push(msg);
      for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });

  let nextId = 1;
  const client = {
    received,
    waitFor(match, timeoutMs = 5000) {
      const seen = received.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiters.indexOf(w);
          if (at !== -1) { waiters.splice(at, 1); reject(new Error('timed out waiting for a bridge message')); }
        }, timeoutMs);
        const w = { match, resolve: (msg) => { clearTimeout(timer); resolve(msg); } };
        waiters.push(w);
      });
    },
    request(method, params, timeoutMs) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return client.waitFor((m) => m.id === id, timeoutMs);
    },
    async init() {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    close() {
      child.kill();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return client;
}

const textOf = (msg) => msg.result?.content?.[0]?.text ?? '';
const names = (msg) => msg.result.tools.map((t) => t.name);
const router = () => require(path.join(LIB, 'mcp-tool-router.js'));

test('offline: advertises the router tools from the compiled extension', needsLib, async () => {
  const bridge = startBridge(await freePort());
  try {
    await bridge.init();
    const list = await bridge.request('tools/list');
    assert.deepStrictEqual(names(list), router().ROUTER_TOOLS.map((t) => t.name));
  } finally {
    bridge.close();
  }
});

test('offline: follows the direct tool mode set in the IDE preferences', needsLib, async () => {
  const bridge = startBridge(await freePort(), {}, { 'arduino.mcp.toolMode': 'direct' });
  try {
    await bridge.init();
    const list = await bridge.request('tools/list');
    const { ARDUINO_TOOLS } = require(path.join(LIB, 'mcp-tools.js'));
    assert.deepStrictEqual(names(list), ARDUINO_TOOLS.map((t) => t.name));
  } finally {
    bridge.close();
  }
});

test('offline: discovery tools are answered exactly like the server', needsLib, async () => {
  const bridge = startBridge(await freePort());
  try {
    await bridge.init();
    const found = await bridge.request('tools/call', { name: 'search_tools', arguments: { query: 'wait_for' } });
    assert.strictEqual(found.result.isError, undefined);
    assert.strictEqual(
      textOf(found),
      JSON.stringify(router().runRouterDiscoveryTool('search_tools', { query: 'wait_for' }), null, 2)
    );
    const bad = await bridge.request('tools/call', { name: 'get_category_tools', arguments: { category: 'nope' } });
    assert.strictEqual(bad.result.isError, true);
    assert.match(textOf(bad), /Unknown category: nope/);
  } finally {
    bridge.close();
  }
});

test('offline: prompts still work', needsLib, async () => {
  const bridge = startBridge(await freePort());
  try {
    await bridge.init();
    const list = await bridge.request('prompts/list');
    assert.ok(list.result.prompts.some((p) => p.name === 'bringup'));
    const got = await bridge.request('prompts/get', { name: 'bringup', arguments: {} });
    assert.match(got.result.messages[0].content.text, /arduino_board/);
  } finally {
    bridge.close();
  }
});

test('offline without ARDUINO_AGENT_PATH: a tool that needs the IDE says how to fix it, fast', async () => {
  const bridge = startBridge(await freePort(), { ARDUINO_AGENT_PATH: undefined });
  try {
    await bridge.init();
    const started = Date.now();
    const res = await bridge.request('tools/call', { name: 'execute_tool', arguments: { tool_name: 'arduino_context', params: {} } });
    assert.ok(Date.now() - started < 3000);
    assert.strictEqual(res.result.isError, true);
    assert.match(textOf(res), /not running/);
    assert.match(textOf(res), /ARDUINO_AGENT_PATH/);
  } finally {
    bridge.close();
  }
});

test('IDE coming up sends tools/list_changed when its tools differ', async () => {
  const port = await freePort();
  const bridge = startBridge(port);
  let ide;
  try {
    await bridge.init();
    await bridge.request('tools/list');
    const ideTools = [{ name: 'arduino_context', description: 'ctx', inputSchema: { type: 'object', properties: {} } }];
    ide = await fakeIde(port, { tools: ideTools });
    await bridge.waitFor((m) => m.method === 'notifications/tools/list_changed', 3000);
    const list = await bridge.request('tools/list');
    assert.deepStrictEqual(names(list), ['arduino_context']);
  } finally {
    bridge.close();
    await ide?.close();
  }
});

test('IDE coming up with the same tools sends no notification', needsLib, async () => {
  const port = await freePort();
  const bridge = startBridge(port);
  let ide;
  try {
    await bridge.init();
    const offline = await bridge.request('tools/list');
    ide = await fakeIde(port, { tools: offline.result.tools });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!bridge.received.some((m) => m.method === 'notifications/tools/list_changed'));
  } finally {
    bridge.close();
    await ide?.close();
  }
});

test('a tool call starts the IDE, waits for it, then runs', async () => {
  const port = await freePort();
  // node.exe stands in for the IDE executable: it starts and exits; the fake
  // server below plays the IDE's MCP server coming up a second later.
  const bridge = startBridge(port, { ARDUINO_AGENT_PATH: process.execPath, ARDUINO_MCP_LAUNCH_TIMEOUT: '10' });
  let ide;
  try {
    await bridge.init();
    const pending = bridge.request('tools/call', { name: 'execute_tool', arguments: { tool_name: 'arduino_context', params: {} } }, 15000);
    await new Promise((r) => setTimeout(r, 1000));
    ide = await fakeIde(port, { tools: [] });
    const res = await pending;
    assert.strictEqual(res.result.isError, undefined);
    assert.strictEqual(textOf(res), 'ran execute_tool');
  } finally {
    bridge.close();
    await ide?.close();
  }
});

test('an IDE that never answers gives a clear error and is not started twice', async () => {
  const bridge = startBridge(await freePort(), { ARDUINO_AGENT_PATH: process.execPath, ARDUINO_MCP_LAUNCH_TIMEOUT: '1' });
  try {
    await bridge.init();
    const call = { name: 'execute_tool', arguments: { tool_name: 'arduino_context', params: {} } };
    const first = await bridge.request('tools/call', call);
    assert.strictEqual(first.result.isError, true);
    assert.match(textOf(first), /did not answer within 1s/);
    const second = await bridge.request('tools/call', call);
    assert.match(textOf(second), /already started once/);
  } finally {
    bridge.close();
  }
});

test('a wrong ARDUINO_AGENT_PATH is reported, not waited on', async () => {
  const bridge = startBridge(await freePort(), {
    ARDUINO_AGENT_PATH: path.join(os.tmpdir(), 'no-such-dir', 'Arduino IDE.exe'),
    ARDUINO_MCP_LAUNCH_TIMEOUT: '10',
  });
  try {
    await bridge.init();
    const started = Date.now();
    const res = await bridge.request('tools/call', { name: 'execute_tool', arguments: { tool_name: 'x', params: {} } });
    assert.ok(Date.now() - started < 5000);
    assert.match(textOf(res), /could not start/);
  } finally {
    bridge.close();
  }
});

test('a rejected token gives a readable tool error, and tools/list still answers', async () => {
  const port = await freePort();
  const ide = await fakeIde(port, { tools: [], token: 'a-different-token' });
  const bridge = startBridge(port);
  try {
    await bridge.init();
    const res = await bridge.request('tools/call', { name: 'execute_tool', arguments: { tool_name: 'x', params: {} } });
    assert.strictEqual(res.result.isError, true);
    assert.match(textOf(res), /rejected the bridge's auth token/);
    const list = await bridge.request('tools/list');
    assert.ok(Array.isArray(list.result.tools));
  } finally {
    bridge.close();
    await ide.close();
  }
});
