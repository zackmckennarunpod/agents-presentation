# Agents at Runpod — Live Presentation

You are connected to a live presentation running on a Runpod pod. Slides update in real time for everyone watching.

## Connect via MCP (fastest for agents)

Run this once in any directory to wire the MCP server into Claude Code:

```bash
echo '{"mcpServers":{"presentation":{"type":"sse","url":"https://6gmuvmdongweal-3000.proxy.runpod.net/sse"}}}' > .mcp.json
```

Then use these tools in Claude Code:

| Tool | What it does |
|------|-------------|
| `list_slides` | List all slides with index + title |
| `get_current_slide` | Get slide content and current index |
| `next_slide` | Advance — visible to all viewers instantly |
| `prev_slide` | Go back |
| `goto_slide(index)` | Jump to any slide by 0-based index |
| `add_slide(title, bullets, note)` | Append a new slide after the current one |
| `edit_slides(slides[])` | Replace all slides — hot-reloads for everyone |
| `add_ssh_key(github / key, name)` | Grant SSH access without restarting |

## Connect via SSH

```bash
ssh -p 15855 root@213.173.105.94
```

Add your key first — paste your GitHub username in the bar at the bottom of the page, or:

```bash
curl -X POST https://6gmuvmdongweal-3000.proxy.runpod.net/ssh-key \
  -H 'Content-Type: application/json' \
  -d '{"github": "your-github-username"}'
```

## Edit slides directly

```bash
nano /workspace/presentation/slides.json
```

Save → changes appear instantly for all viewers. Slide format:

```json
[
  {
    "title": "Slide title",
    "bullets": ["First point", "Second point"],
    "note": "optional speaker note"
  },
  {
    "title": "Goals (table format)",
    "table": [
      { "label": "Goal 1", "baseline": "33%", "q3": "50%", "y2026": "75%" }
    ]
  }
]
```

## REST API

```bash
# Navigate
curl -X POST https://6gmuvmdongweal-3000.proxy.runpod.net/nav \
  -H 'Content-Type: application/json' -d '{"dir": "next"}'   # or "prev" or 2 (index)

# Current state
curl https://6gmuvmdongweal-3000.proxy.runpod.net/state

# Add SSH key
curl -X POST https://6gmuvmdongweal-3000.proxy.runpod.net/ssh-key \
  -H 'Content-Type: application/json' \
  -d '{"github": "username"}'

# SSE stream (live events)
curl -N https://6gmuvmdongweal-3000.proxy.runpod.net/events
```

## Backup slides to your local machine

```bash
rsync -az -e "ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no -p 15855" \
  root@213.173.105.94:/workspace/presentation/ \
  ./presentation/
```

Run this anytime to pull the latest `slides.json` and anything else in the workspace.

## Presentation URL

`https://6gmuvmdongweal-3000.proxy.runpod.net`

Anyone can open this — no auth required. Arrow keys / Space to advance slides.
