import { watch } from "fs";

const PORT = parseInt(process.env.PORT ?? "3000");
const SSH_HOST = process.env.SSH_HOST ?? "213.173.105.94";
const SSH_PORT = process.env.SSH_PORT ?? "15855";
const PROXY_URL = process.env.PROXY_URL ?? "https://6gmuvmdongweal-3000.proxy.runpod.net";
const SLIDES_FILE = "/workspace/presentation/slides.json";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Slide {
  title: string;
  bullets?: string[];
  table?: { label: string; baseline: string; q3: string; y2026: string }[];
  note?: string;
  code?: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

let slides: Slide[] = await loadSlides();
let currentIndex = 0;

// SSE clients for the web UI
const uiClients = new Set<ReadableStreamDefaultController<string>>();

// MCP sessions: sessionId → SSE controller
const mcpSessions = new Map<string, ReadableStreamDefaultController<string>>();

async function loadSlides(): Promise<Slide[]> {
  try {
    return JSON.parse(await Bun.file(SLIDES_FILE).text());
  } catch {
    return defaultSlides();
  }
}

function defaultSlides(): Slide[] {
  return [
    {
      title: "Agents at Runpod",
      bullets: ["What are we building?", "Why does it matter?", "What does success look like?"],
    },
    {
      title: "Agent Primitives",
      bullets: [
        "Orchestration — control logic, routing, policy",
        "Context — prompts, skills, memory injection",
        "State — memory, filesystem, git, artifacts",
        "Compute — harness execution, tool execution, sandboxes",
        "Observability — traces, evaluations",
      ],
      note: "rand.arete",
    },
    {
      title: "The Runpod Stack",
      bullets: [
        "Sandbox — lightweight, easy to define resources",
        "Snapshot / suspend / resume support",
        "Routing — endpoint → sandbox → inference → tools",
        "Auth — safe credential management",
        "Telemetry — OTel / OpenLLMetry stream",
      ],
      note: "Our p0 surface",
    },
    {
      title: "Roadmap",
      bullets: [
        "P0: lightweight sandbox + routing + auth + telemetry",
        "P1: durable execution (restate / temporal / inngest)",
        "P1: fine-tune / accumulate tools tendril-style",
        "Open question: custom orchestration vs off-the-shelf?",
      ],
      note: "Sean + rand.arete + Zack",
    },
    {
      title: "Goals",
      table: [
        { label: "Goal 1", baseline: "33%", q3: "50%", y2026: "75%" },
        { label: "Goal 2", baseline: "41%", q3: "70%", y2026: "95%" },
        { label: "Goal 3 (latency)", baseline: "5s", q3: "4s", y2026: "3s" },
        { label: "Goal 4 (cost)", baseline: "400%", q3: "25%", y2026: "10%" },
      ],
    },
  ];
}

// ── UI broadcast ──────────────────────────────────────────────────────────────

function uiBroadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of uiClients) {
    try { ctrl.enqueue(msg); } catch { uiClients.delete(ctrl); }
  }
}

function broadcastSlide() {
  uiBroadcast("slide", { index: currentIndex, total: slides.length, slide: slides[currentIndex] });
}

// ── File watcher ──────────────────────────────────────────────────────────────

try {
  watch(SLIDES_FILE, async () => {
    slides = await loadSlides();
    broadcastSlide();
    uiBroadcast("activity", { line: "✏️  slides.json updated" });
  });
} catch { /* file may not exist yet */ }

// ── SSH key management ────────────────────────────────────────────────────────

async function addKey(key: string, name: string): Promise<string> {
  const file = "/root/.ssh/authorized_keys";
  const existing = await Bun.file(file).text().catch(() => "");
  if (existing.includes(key.trim())) return `Key for ${name} already present`;
  await Bun.write(file, existing + "\n" + key.trim() + "\n");
  uiBroadcast("activity", { line: `🔑 ${name} joined` });
  return `SSH access granted to ${name}`;
}

async function addFromGitHub(username: string): Promise<string> {
  const res = await fetch(`https://github.com/${username}.keys`);
  if (!res.ok) return `@${username} not found on GitHub`;
  const keys = (await res.text()).trim().split("\n").filter(Boolean);
  if (!keys.length) return `No public keys for @${username}`;
  let added = 0;
  for (const k of keys) {
    const msg = await addKey(k, `@${username}`);
    if (!msg.includes("already")) added++;
  }
  return added > 0 ? `Added ${added} key(s) for @${username}` : `@${username} already has access`;
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

function mcpSend(sessionId: string, payload: unknown) {
  const ctrl = mcpSessions.get(sessionId);
  if (ctrl) ctrl.enqueue(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

const MCP_TOOLS = [
  {
    name: "list_slides",
    description: "List all slides with their index and title",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_current_slide",
    description: "Get the current slide content and index",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "next_slide",
    description: "Advance to the next slide (visible to all viewers)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prev_slide",
    description: "Go back to the previous slide",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "goto_slide",
    description: "Jump to a slide by 0-based index",
    inputSchema: {
      type: "object",
      properties: { index: { type: "number", description: "0-based slide index" } },
      required: ["index"],
    },
  },
  {
    name: "add_ssh_key",
    description: "Grant SSH access to a collaborator by GitHub username or raw public key",
    inputSchema: {
      type: "object",
      properties: {
        github: { type: "string", description: "GitHub username to import keys from" },
        key: { type: "string", description: "Raw public key (ssh-ed25519 or ssh-rsa)" },
        name: { type: "string", description: "Display name for the activity feed" },
      },
    },
  },
  {
    name: "edit_slides",
    description: "Replace all slides with new content. Changes hot-reload for all viewers.",
    inputSchema: {
      type: "object",
      properties: {
        slides: {
          type: "array",
          description: "Array of slide objects with title, bullets[], table[], note, code fields",
          items: { type: "object" },
        },
      },
      required: ["slides"],
    },
  },
  {
    name: "add_slide",
    description: "Append a new slide after the current one",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        bullets: { type: "array", items: { type: "string" } },
        note: { type: "string" },
      },
      required: ["title"],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_slides":
      return { content: [{ type: "text", text: JSON.stringify(slides.map((s, i) => ({ index: i, title: s.title })), null, 2) }] };

    case "get_current_slide":
      return { content: [{ type: "text", text: JSON.stringify({ index: currentIndex, total: slides.length, slide: slides[currentIndex] }, null, 2) }] };

    case "next_slide":
      currentIndex = Math.min(currentIndex + 1, slides.length - 1);
      broadcastSlide();
      return { content: [{ type: "text", text: `Now on slide ${currentIndex + 1}/${slides.length}: "${slides[currentIndex].title}"` }] };

    case "prev_slide":
      currentIndex = Math.max(currentIndex - 1, 0);
      broadcastSlide();
      return { content: [{ type: "text", text: `Now on slide ${currentIndex + 1}/${slides.length}: "${slides[currentIndex].title}"` }] };

    case "goto_slide": {
      const idx = args.index as number;
      currentIndex = Math.max(0, Math.min(idx, slides.length - 1));
      broadcastSlide();
      return { content: [{ type: "text", text: `Jumped to slide ${currentIndex + 1}: "${slides[currentIndex].title}"` }] };
    }

    case "add_ssh_key": {
      const msg = args.github
        ? await addFromGitHub(args.github as string)
        : await addKey(args.key as string, (args.name as string) ?? "agent");
      return { content: [{ type: "text", text: msg }] };
    }

    case "edit_slides": {
      slides = args.slides as Slide[];
      await Bun.write(SLIDES_FILE, JSON.stringify(slides, null, 2));
      broadcastSlide();
      uiBroadcast("activity", { line: "🤖 agent edited slides" });
      return { content: [{ type: "text", text: `Updated — ${slides.length} slides now live` }] };
    }

    case "add_slide": {
      const slide: Slide = {
        title: args.title as string,
        ...(args.bullets && { bullets: args.bullets as string[] }),
        ...(args.note && { note: args.note as string }),
      };
      slides.splice(currentIndex + 1, 0, slide);
      currentIndex++;
      await Bun.write(SLIDES_FILE, JSON.stringify(slides, null, 2));
      broadcastSlide();
      uiBroadcast("activity", { line: `🤖 agent added slide: ${slide.title}` });
      return { content: [{ type: "text", text: `Added slide at index ${currentIndex}: "${slide.title}"` }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

async function handleMcpMessage(msg: Record<string, unknown>, sessionId: string) {
  const { id, method, params } = msg as { id: unknown; method: string; params?: Record<string, unknown> };

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "presentation", version: "1.0.0" },
        },
      };

    case "notifications/initialized":
      return null; // no response needed

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };

    case "tools/call": {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      uiBroadcast("activity", { line: `🤖 tool: ${p.name}` });
      const result = await callTool(p.name, p.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    }

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // ── Web UI ──

    if (pathname === "/" || pathname === "/audience") {
      return new Response(html(), { headers: { "Content-Type": "text/html", ...cors } });
    }

    if (pathname === "/events") {
      const stream = new ReadableStream<string>({
        start(ctrl) {
          uiClients.add(ctrl);
          ctrl.enqueue(`event: slide\ndata: ${JSON.stringify({ index: currentIndex, total: slides.length, slide: slides[currentIndex] })}\n\n`);
        },
        cancel(ctrl) { uiClients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors },
      });
    }

    if (pathname === "/nav" && req.method === "POST") {
      const { dir } = await req.json() as { dir: "next" | "prev" | number };
      if (dir === "next") currentIndex = Math.min(currentIndex + 1, slides.length - 1);
      else if (dir === "prev") currentIndex = Math.max(currentIndex - 1, 0);
      else if (typeof dir === "number") currentIndex = Math.max(0, Math.min(dir, slides.length - 1));
      broadcastSlide();
      return Response.json({ ok: true, index: currentIndex }, { headers: cors });
    }

    if (pathname === "/ssh-key" && req.method === "POST") {
      const body = await req.json() as { github?: string; key?: string; name?: string };
      const msg = body.github
        ? await addFromGitHub(body.github)
        : body.key ? await addKey(body.key, body.name ?? "collaborator") : "missing key or github";
      return Response.json({ ok: true, message: msg }, { headers: cors });
    }

    if (pathname === "/state") {
      return Response.json({ index: currentIndex, total: slides.length, slide: slides[currentIndex], viewers: uiClients.size }, { headers: cors });
    }

    // ── MCP SSE transport ──

    if (pathname === "/sse") {
      const sessionId = crypto.randomUUID();
      const stream = new ReadableStream<string>({
        start(ctrl) {
          mcpSessions.set(sessionId, ctrl);
          ctrl.enqueue(`event: endpoint\ndata: ${JSON.stringify(`/message?sessionId=${sessionId}`)}\n\n`);
          uiBroadcast("activity", { line: `🔌 MCP client connected` });
        },
        cancel() {
          mcpSessions.delete(sessionId);
          uiBroadcast("activity", { line: `🔌 MCP client disconnected` });
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors },
      });
    }

    if (pathname === "/message" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!mcpSessions.has(sessionId)) return new Response("session not found", { status: 404 });
      const msg = await req.json() as Record<string, unknown>;
      const response = await handleMcpMessage(msg, sessionId);
      if (response !== null) mcpSend(sessionId, response);
      return new Response(null, { status: 202, headers: cors });
    }

    return new Response("not found", { status: 404 });
  },
});

const mcpUrl = `${PROXY_URL}/sse`;
console.log(`✅ Presentation server :${PORT}`);
console.log(`   View:  ${PROXY_URL}`);
console.log(`   SSH:   ssh -p ${SSH_PORT} root@${SSH_HOST}`);
console.log(`   MCP:   ${mcpUrl}`);
console.log(``);
console.log(`Connect with Claude Code:`);
console.log(`  echo '{"mcpServers":{"presentation":{"type":"sse","url":"${mcpUrl}"}}}' > .mcp.json`);

// ── HTML ──────────────────────────────────────────────────────────────────────

function html() {
  const sshCmd = `ssh -p ${SSH_PORT} root@${SSH_HOST}`;
  const mcpCmd = `echo '{"mcpServers":{"presentation":{"type":"sse","url":"${PROXY_URL}/sse"}}}' > .mcp.json`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agents at Runpod</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#07070f;color:#e2e8f0;font-family:'JetBrains Mono','Fira Code',ui-monospace,monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(124,58,237,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(124,58,237,.05) 1px,transparent 1px);background-size:60px 60px;pointer-events:none}
.orb{position:fixed;border-radius:50%;pointer-events:none;filter:blur(80px)}
.orb1{width:500px;height:500px;background:rgba(124,58,237,.15);top:-150px;left:-150px;animation:drift1 18s ease-in-out infinite alternate}
.orb2{width:400px;height:400px;background:rgba(37,99,235,.12);bottom:-100px;right:-100px;animation:drift2 22s ease-in-out infinite alternate}
@keyframes drift1{to{transform:translate(180px,120px)}}
@keyframes drift2{to{transform:translate(-120px,-80px)}}
#progress{height:3px;background:#0f0f1a;flex-shrink:0}
#bar{height:100%;background:linear-gradient(90deg,#7c3aed,#2563eb,#0ea5e9);transition:width .5s ease}
#slide{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:3rem 4rem;position:relative;z-index:1;text-align:center;overflow:hidden}
.slide-label{font-size:.65rem;color:#7c3aed;text-transform:uppercase;letter-spacing:.18em;margin-bottom:1rem}
.slide-title{font-size:clamp(2rem,5vw,4rem);font-weight:700;background:linear-gradient(135deg,#a78bfa 0%,#60a5fa 60%,#34d399 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.1;margin-bottom:2rem}
.slide-bullets{list-style:none;max-width:760px;text-align:left}
.slide-bullets li{color:#94a3b8;font-size:clamp(.85rem,1.6vw,1.15rem);line-height:1.7;padding:.3rem 0 .3rem 1.5rem;position:relative}
.slide-bullets li::before{content:"▸";color:#7c3aed;position:absolute;left:0}
.slide-note{margin-top:1.5rem;color:#334155;font-size:.72rem;font-style:italic}
.goals-table{width:100%;max-width:900px;border-collapse:collapse;font-size:.88rem}
.goals-table th{text-align:left;color:#475569;font-weight:500;font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;padding:.4rem .75rem .75rem 0;border-bottom:1px solid #1e1e2e}
.goals-table th:first-child{border-bottom-color:#7c3aed}
.goals-table td{padding:.9rem .75rem .9rem 0;border-bottom:1px solid #0f0f1a;color:#94a3b8;vertical-align:top}
.goals-table td:first-child{color:#e2e8f0;font-weight:600}
.goals-table td:nth-child(3){color:#a78bfa;font-weight:600}
.goals-table td:nth-child(4){color:#34d399;font-weight:600}
#counter{position:fixed;top:1rem;right:1.5rem;font-size:.72rem;color:#334155;z-index:10}
#ticker{position:fixed;bottom:72px;left:0;right:0;height:26px;overflow:hidden;pointer-events:none;z-index:8}
#ticker-inner{font-size:.7rem;color:#334155;white-space:nowrap;padding:0 1.5rem;line-height:26px;transition:opacity .6s}
#bottom{position:fixed;bottom:0;left:0;right:0;background:#07070f;border-top:1px solid #13131f;display:flex;align-items:center;gap:.6rem;padding:.55rem 1rem;z-index:9;flex-wrap:wrap}
.nav-btn{background:#0f0f1a;border:1px solid #1e1e2e;border-radius:6px;color:#94a3b8;padding:.35rem .9rem;cursor:pointer;font-family:inherit;font-size:.75rem;transition:all .15s;white-space:nowrap}
.nav-btn:hover{border-color:#7c3aed;color:#e2e8f0}
input.ki{background:#0a0a15;border:1px solid #1e1e2e;border-radius:6px;color:#e2e8f0;padding:.35rem .65rem;font-family:inherit;font-size:.75rem;width:130px}
input.ki:focus{outline:none;border-color:#7c3aed}
.join-btn{background:#7c3aed;border:none;border-radius:6px;color:#fff;padding:.35rem .8rem;cursor:pointer;font-family:inherit;font-size:.75rem;white-space:nowrap}
.join-btn:hover{background:#6d28d9}
#ssh-msg{font-size:.7rem;color:#4ade80;min-width:60px;white-space:nowrap}
#dot{position:fixed;top:1rem;left:1.25rem;font-size:.7rem;color:#334155;z-index:10}
#dot.live::before{content:"● ";color:#22c55e}
#dot.dead::before{content:"● ";color:#ef4444}

/* connect panel */
#connect-panel{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:20;display:flex;flex-direction:row;align-items:stretch}
#connect-tab{background:#0f0f1a;border:1px solid #1e1e2e;border-right:none;border-radius:8px 0 0 8px;padding:.75rem .5rem;cursor:pointer;writing-mode:vertical-rl;text-orientation:mixed;font-size:.65rem;color:#475569;letter-spacing:.1em;text-transform:uppercase;transition:all .15s;user-select:none}
#connect-tab:hover{color:#a78bfa;border-color:#7c3aed}
#connect-drawer{background:#0a0a15;border:1px solid #1e1e2e;border-right:none;border-radius:8px 0 0 8px;width:0;overflow:hidden;transition:width .25s ease;display:flex;flex-direction:column;gap:0}
#connect-drawer.open{width:340px}
.cp-section{padding:1rem 1.25rem;border-bottom:1px solid #13131f}
.cp-section:last-child{border-bottom:none}
.cp-label{font-size:.6rem;color:#475569;text-transform:uppercase;letter-spacing:.12em;margin-bottom:.5rem}
.cp-cmd{background:#07070f;border:1px solid #1e1e2e;border-radius:6px;padding:.5rem .75rem;font-size:.72rem;color:#4ade80;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:.5rem;transition:border-color .15s;word-break:break-all;line-height:1.4}
.cp-cmd:hover{border-color:#4ade80}
.cp-cmd.purple{color:#a78bfa}
.cp-cmd.purple:hover{border-color:#a78bfa}
.cp-copy{font-size:.6rem;color:#334155;flex-shrink:0;white-space:nowrap}
.cp-cmd:hover .cp-copy{color:#e2e8f0}
.cp-row{display:flex;gap:.5rem;margin-top:.5rem}
.cp-input{background:#07070f;border:1px solid #1e1e2e;border-radius:6px;color:#e2e8f0;padding:.4rem .65rem;font-family:inherit;font-size:.75rem;flex:1;min-width:0}
.cp-input:focus{outline:none;border-color:#7c3aed}
.cp-btn{background:#7c3aed;border:none;border-radius:6px;color:#fff;padding:.4rem .75rem;cursor:pointer;font-family:inherit;font-size:.75rem;white-space:nowrap}
.cp-btn:hover{background:#6d28d9}
#cp-msg{font-size:.7rem;color:#4ade80;margin-top:.4rem;min-height:.9rem}
</style>
</head>
<body>
<div class="orb orb1"></div>
<div class="orb orb2"></div>
<div id="dot" class="dead">connecting</div>
<div id="counter">— / —</div>
<div id="progress"><div id="bar" style="width:0%"></div></div>

<div id="slide"><div class="slide-title">Connecting...</div></div>

<div id="ticker"><div id="ticker-inner" style="opacity:0"></div></div>

<div id="bottom">
  <button class="nav-btn" onclick="nav('prev')">← Prev</button>
  <button class="nav-btn" onclick="nav('next')">Next →</button>
  <input class="ki" id="gh" placeholder="GitHub user" />
  <button class="join-btn" onclick="joinGh()">Add key →</button>
  <span id="ssh-msg"></span>
</div>

<!-- connect panel -->
<div id="connect-panel">
  <div id="connect-drawer">
    <div class="cp-section">
      <div class="cp-label">SSH into the pod</div>
      <div class="cp-cmd" onclick="cpCopy(this,'${sshCmd}')">
        <span>${sshCmd}</span>
        <span class="cp-copy">copy</span>
      </div>
    </div>
    <div class="cp-section">
      <div class="cp-label">Connect via MCP (Claude Code)</div>
      <div class="cp-cmd purple" onclick="cpCopy(this,${JSON.stringify(mcpCmd)})">
        <span>echo '{...}' &gt; .mcp.json</span>
        <span class="cp-copy">copy full cmd</span>
      </div>
      <div style="font-size:.68rem;color:#334155;margin-top:.5rem;line-height:1.5">
        Tools: next/prev/goto_slide · add_slide · edit_slides · add_ssh_key
      </div>
    </div>
    <div class="cp-section">
      <div class="cp-label">Add your key</div>
      <div class="cp-row">
        <input class="cp-input" id="cp-gh" placeholder="GitHub username" />
        <button class="cp-btn" onclick="cpJoin()">Import →</button>
      </div>
      <div id="cp-msg"></div>
    </div>
    <div class="cp-section">
      <div class="cp-label">Live log</div>
      <div id="cp-log" style="font-size:.68rem;color:#334155;line-height:1.8;max-height:120px;overflow-y:auto"></div>
    </div>
  </div>
  <div id="connect-tab" onclick="togglePanel()">Connect</div>
</div>

<script>
const es = new EventSource('/events');
const dot = document.getElementById('dot');
es.onopen = () => { dot.className = 'live'; dot.textContent = 'live'; };
es.onerror = () => { dot.className = 'dead'; dot.textContent = 'reconnecting'; };
es.addEventListener('slide', e => render(JSON.parse(e.data)));
es.addEventListener('activity', e => tick(JSON.parse(e.data).line));

function render({index, total, slide: s}) {
  document.getElementById('bar').style.width = ((index+1)/total*100)+'%';
  document.getElementById('counter').textContent = (index+1)+' / '+total;
  const el = document.getElementById('slide');
  if (s.table) {
    el.innerHTML = \`
      <div class="slide-label">runpod // agents</div>
      <div class="slide-title">\${esc(s.title)}</div>
      <table class="goals-table">
        <thead><tr><th></th><th>Baseline</th><th>Q3 Target</th><th>2026 Target</th></tr></thead>
        <tbody>\${s.table.map(r=>\`<tr><td>\${esc(r.label)}</td><td>\${esc(r.baseline)}</td><td>\${esc(r.q3)}</td><td>\${esc(r.y2026)}</td></tr>\`).join('')}</tbody>
      </table>\`;
  } else {
    el.innerHTML = \`
      <div class="slide-label">runpod // agents</div>
      <div class="slide-title">\${esc(s.title)}</div>
      \${s.bullets?'<ul class="slide-bullets">'+s.bullets.map(b=>'<li>'+esc(b)+'</li>').join('')+'</ul>':''}
      \${s.code?'<pre style="margin-top:1.5rem;background:#0a0a15;border:1px solid #1e1e2e;border-radius:8px;padding:1.25rem;font-size:.82rem;color:#a9b1d6;text-align:left;max-width:760px;width:100%">'+esc(s.code)+'</pre>':''}
      \${s.note?'<div class="slide-note">— '+esc(s.note)+'</div>':''}\`;
  }
}

function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

async function nav(dir){
  await fetch('/nav',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir})});
}

document.addEventListener('keydown',e=>{
  if(e.key==='ArrowRight'||e.key===' ')nav('next');
  if(e.key==='ArrowLeft')nav('prev');
});

function copy(text, msgId) {
  navigator.clipboard.writeText(text).then(()=>{
    const el = document.getElementById(msgId);
    el.textContent='copied!';
    setTimeout(()=>el.textContent='',2000);
  });
}

async function joinGh(){
  const gh=document.getElementById('gh').value.trim();
  if(!gh)return;
  const msg=document.getElementById('ssh-msg');
  msg.style.color='#94a3b8';msg.textContent='fetching...';
  const r=await fetch('/ssh-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github:gh})});
  const d=await r.json();
  msg.style.color='#4ade80';msg.textContent=d.message;
}

function tick(line){
  const t=document.getElementById('ticker-inner');
  t.textContent=line;t.style.opacity='1';
  setTimeout(()=>t.style.opacity='0',5000);
  logLine(line);
}

function logLine(line){
  const log=document.getElementById('cp-log');
  if(!log)return;
  const ts=new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const d=document.createElement('div');
  d.style.cssText='color:#475569;padding:.1rem 0;border-bottom:1px solid #0f0f1a';
  d.innerHTML='<span style="color:#334155">'+ts+'</span> '+esc(line);
  log.appendChild(d);
  log.scrollTop=log.scrollHeight;
}

let panelOpen=false;
function togglePanel(){
  panelOpen=!panelOpen;
  document.getElementById('connect-drawer').classList.toggle('open',panelOpen);
}

function cpCopy(el,text){
  navigator.clipboard.writeText(text).then(()=>{
    const c=el.querySelector('.cp-copy');
    c.textContent='copied!';c.style.color='#4ade80';
    setTimeout(()=>{c.textContent='copy';c.style.color='';},2000);
  });
}

async function cpJoin(){
  const gh=document.getElementById('cp-gh').value.trim();
  if(!gh)return;
  const msg=document.getElementById('cp-msg');
  msg.style.color='#94a3b8';msg.textContent='fetching...';
  const r=await fetch('/ssh-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({github:gh})});
  const d=await r.json();
  msg.style.color='#4ade80';msg.textContent=d.message;
}
</script>
</body>
</html>`;
}
