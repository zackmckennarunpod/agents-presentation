# Agents at Runpod — Live Presentation

You are SSH'd into a live presentation pod. Changes you make appear **instantly** for all viewers. Current slide position is preserved when slides are edited.

---

## Things you can do

### Add or edit slides

```bash
nano /workspace/presentation/slides.json
```

Save → hot-reloads for everyone. Slide format:

```json
[
  {
    "title": "Slide title",
    "bullets": ["Point one", "Point two"],
    "note": "Optional speaker note (shown in log)"
  },
  {
    "title": "Table slide",
    "table": [
      { "label": "Goal 1", "baseline": "33%", "q3": "50%", "y2026": "75%" }
    ]
  }
]
```

### Navigate slides

```bash
# Next slide
curl -s -X POST localhost:3000/nav -H 'Content-Type: application/json' -d '{"dir":"next"}'

# Prev slide
curl -s -X POST localhost:3000/nav -H 'Content-Type: application/json' -d '{"dir":"prev"}'

# Jump to slide index (0-based)
curl -s -X POST localhost:3000/nav -H 'Content-Type: application/json' -d '{"dir":2}'
```

### Post to chat

```bash
curl -s -X POST localhost:3000/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hello from the agent!", "author": "your-name"}'
```

### Change styles / add features

The entire server is a single file: `/workspace/presentation/server.ts`

It's a Bun HTTP server. The HTML, CSS, and JS are all generated inline by the `html()` function. Edit that function to:

- Change colors, fonts, layout — it's all raw CSS in template strings
- Add new slide layouts (the renderer is the `render()` function in the client JS)
- Add new REST endpoints by extending the `fetch()` handler
- Add animations, background effects, interactive elements

After editing, restart the server:

```bash
kill $(lsof -ti:3000) 2>/dev/null; sleep 1
nohup /root/.bun/bin/bun --watch run /workspace/presentation/server.ts \
  > /workspace/presentation/server.log 2>&1 </dev/null &
sleep 2 && tail -5 /workspace/presentation/server.log
```

`--watch` means file changes to server.ts auto-restart. You can also just save and it restarts itself.

### Add images

Drop images into `/workspace/presentation/` and serve them:

```bash
# The server already serves static files — add a route or inline as base64
# Quick approach: base64 encode and put in slides.json as a data URI
base64 -w0 myimage.png
# Then in slides.json: "image": "data:image/png;base64,<output>"
```

Or add a static file route in server.ts (search for `pathname === "/"` and add above it):

```typescript
if (pathname.startsWith("/assets/")) {
  const file = Bun.file(`/workspace/presentation${pathname}`);
  return new Response(file);
}
```

### Check current state

```bash
curl -s localhost:3000/state | jq .
```

### View live log

```bash
tail -f /workspace/presentation/server.log
```

---

## Server architecture

```
/workspace/presentation/
  server.ts       — Bun HTTP server, all-in-one (HTML + SSE + REST + MCP)
  slides.json     — slide content, hot-reloaded on save
  CLAUDE.md       — this file
  server.log      — runtime log
  backup.sh       — git commit + push every 60s
```

Key server internals:
- `html()` — generates the entire HTML page (find CSS here)
- `render(d)` — client-side JS that renders a slide to the DOM
- `broadcastSlide()` — sends slide to all connected viewers via SSE
- `handleMcpMessage()` — MCP JSON-RPC handler
- `uiBroadcast()` — sends events to all UI clients

---

## Presentation URL

`https://6gmuvmdongweal-3000.proxy.runpod.net`
