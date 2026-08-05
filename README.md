# cc-docker

Run **Claude Code inside a Docker container** while it still behaves like it is
running on your machine: your files, your MCP servers, your skills and plugins,
your browser for login.

```bash
git clone <this-repo> cc-docker
cd cc-docker
./install.sh
```

That single command checks prerequisites, builds the image, writes your
configuration and installs a `doclaude` command. From then on:

```bash
cd ~/projects/my-app
doclaude                     # Claude Code, containerised, in this directory
```

---

## Why this is not just `docker run`

Putting Claude Code in a container is easy. Keeping it *useful* is the hard
part, because three things normally break the moment you do:

| Breaks in a plain container | What cc-docker does |
|---|---|
| **Login.** Claude Code's OAuth listener binds a *random* port on the container's loopback. Your host browser redirects to `localhost:<that port>` and hits nothing. | A host agent notices the `redirect_uri`, binds that exact port on the host, and reverse-tunnels it into the container. Login works with a real browser, first try. |
| **MCP servers.** Locally installed stdio servers are host binaries — a macOS Mach-O executable simply cannot run on Linux. | stdio servers are transparently executed *on the host* and their JSON-RPC stream is piped into the container. Native binaries, host runtimes and host credentials all keep working. |
| **Skills, plugins, memory.** Copying them at build time means they go stale the moment you install one. | They are symlinked at your real `~/.claude`, so anything installed on the host is live inside the container immediately. |

Everything else — credentials, transcripts, `.claude.json` — stays
container-side in `~/.cc-docker/claude`, so a Linux container never fights your
host installation, and **you log in once**.

---

## How it fits together

```
  HOST                                        │  CONTAINER
                                              │
  doclaude ──starts──► host agent             │
                       (127.0.0.1:random)     │
                            ▲   ▲   ▲         │
   browser ◄──opens─────────┘   │   │         │
      │                         │   └─────────┼──◄ ccd-mcp <name>   (stdio MCP)
      │                         │             │      └► real server runs on the host
      │                         └─────────────┼──◄ ccd-host <cmd>   (open, pbcopy, …)
      │                                       │
      └─http://localhost:PORT/callback───────►┼──► ccd-relay ──► 127.0.0.1:PORT
              (reverse tunnel)                │        Claude Code's OAuth listener
                                              │
   ~/                ──bind mount───────────► │  same absolute path
   ~/.claude/skills  ──bind mount──►symlink──►│  $CLAUDE_CONFIG_DIR/skills
   ~/.cc-docker/claude ─bind mount──────────► │  $CLAUDE_CONFIG_DIR (credentials, state)
```

The container's `HOME` is the **same absolute path** as on the host. That one
decision is what makes symlinks, `.mcp.json` paths, git worktrees and Claude
Code's own project keys line up on both sides instead of silently diverging.

---

## Authentication

Run `doclaude`, then `/login`. Your host browser opens, you approve, and the
redirect is tunnelled back to the listener inside the container. The token lands
in `~/.cc-docker/claude/.credentials.json` and is reused by every later run —
no second login.

Already signed in on the host? Skip the browser entirely:

```bash
doclaude self auth import     # macOS Keychain or ~/.claude/.credentials.json
doclaude self auth status     # what each side currently holds
```

API-key users need nothing special: `ANTHROPIC_API_KEY` is forwarded from your
shell by default (see `forwardEnv`).

---

## MCP servers

At container start, every server in your `~/.claude.json` is classified:

* **stdio** (anything with a `command`) → rewritten to `ccd-mcp <name>`, which
  runs the real server back on the host, in your login shell, with your PATH.
* **http / sse** → passed through untouched; the container reaches them directly.

Check what happened:

```bash
doclaude self shell -c 'cat "$CLAUDE_CONFIG_DIR/.claude.json" | jq .mcpServers'
doclaude self agent log        # every host-side server launch is logged
```

Override any individual server in `~/.cc-docker/config.json`:

```jsonc
"mcpPolicy": {
  "stdio": "host",             // default for stdio servers
  "remote": "container",       // default for http/sse servers
  "overrides": {
    "some-npx-server": "container",  // fine to run inside the image
    "noisy-server":    "skip"        // not available in the container at all
  }
}
```

Servers declared in a project's committed `.mcp.json` run **inside** the
container by default; name one in `overrides` to push it to the host instead.

---

## Host commands from inside the container

Desktop integration that only exists on the host is exposed as ordinary
commands. `open`, `pbcopy`, `osascript`, `notify-send` and friends are detected
at install time and shimmed onto the container's `PATH`.

Anything *not* in the image also falls back to the host automatically (via
bash's `command_not_found_handle`), but only if it is allow-listed:

```jsonc
"shimCommands": ["open", "pbcopy", "pbpaste", "osascript"],
"hostCommands":  ["open", "xdg-open", "pbcopy", "pbpaste", "osascript"],
"allowAnyHostExec": false
```

`security`, `docker` and `sudo` are **not** allow-listed by default — each would
hand the container a way out of its own sandbox. Adding them is a deliberate
edit.

---

## Configuration

Everything lives in `~/.cc-docker/config.json` (`doclaude self config edit`).
Re-running `install.sh` merges new defaults without discarding your edits.

| Key | Default | What it controls |
|---|---|---|
| `image` | `cc-docker:latest` | image tag to build and run |
| `claudeVersion` | `latest` | pin Claude Code inside the image |
| `mountProfile` | `home` | `home` mounts all of `$HOME`; `project` mounts only the working directory plus what Claude Code needs |
| `extraMounts` | `[]` | additional `source:target:mode` binds |
| `extraDockerArgs` | `[]` | raw flags appended to `docker run` |
| `linkFromHost` | skills, plugins, agents, commands, hooks, output-styles, scripts | live-linked from `~/.claude` |
| `settingsMode` | `copy` | `copy` seeds `settings.json` once, `link` keeps it live, `skip` leaves it alone |
| `mcpPolicy` | stdio→host, remote→container | where each MCP server runs |
| `shimCommands` / `hostCommands` | auto-detected | host commands reachable from the container |
| `allowAnyHostExec` | `false` | drop the allow-list entirely |
| `forwardEnv` | API keys, proxies, `GH_TOKEN` | environment inherited from your shell |
| `forwardPorts` | `[]` | container ports pre-tunnelled to the host (dev servers) |
| `sshAgentMode` | `auto` | `auto`, `docker-desktop`, `direct`, `off` |
| `containerSudo` | `true` | passwordless sudo inside the container |
| `agentBind` | loopback / docker bridge | where the host agent listens |

### `home` vs `project`

`home` is the default because "full access to my local environment" is the
point of the tool. If you want the container to see less, switch to `project`:

```bash
doclaude self config edit      # "mountProfile": "project"
```

`project` mounts the working directory, `~/.claude`, `~/.cc-docker` and any
sibling directories skills symlink into — enough for everything above to keep
working, without exposing the rest of your home directory.

---

## Command reference

```
doclaude [claude args...]        run Claude Code in the container
doclaude self shell [cmd...]     a shell inside the container
doclaude self doctor             verify the whole setup
doclaude self auth <status|import|export|reset>
doclaude self agent <start|stop|restart|status|log [-f]>
doclaude self rebuild [--no-cache]
doclaude self update             git pull + reinstall
doclaude self config [show|edit|path]
```

Anything not under `self` goes straight to Claude Code, so `doclaude -p "hi"`,
`doclaude mcp list` and `doclaude --resume` all behave as usual.

---

## Troubleshooting

Start with `doclaude self doctor` — it checks the runtime, the image, the agent,
the token, the bind address, your host config and your login state.

**The browser opens but the redirect fails.** The callback port was already
taken on the host. `doclaude self agent log` says so explicitly. Retry `/login`;
the port is random, so a second attempt almost always lands. Failing that, use
the manual code-entry option Claude Code offers.

**An MCP server shows as failed.** `doclaude self agent log` records the exact
command line and the server's stderr. The usual cause is a tool that your login
shell only puts on `PATH` interactively — confirm with
`doclaude self shell -c 'ccd-host <the-command> --version'`.

**"command not found" for something you have on the host.** Add it to
`shimCommands` in `~/.cc-docker/config.json`. No rebuild required.

**Linux: nothing can reach the host agent.** The agent must listen on the docker
bridge, not loopback. `doclaude self doctor` flags this; `install.sh` sets
`agentBind` automatically.

---

## Security

This tool deliberately makes the container porous — that is what it is for — so
be clear about what that means:

* With `mountProfile: "home"` the container can read and write your entire home
  directory. Use `project` if that is more than you want.
* The host agent listens on loopback (or the docker bridge on Linux) and
  requires a 256-bit token that only exists in `~/.cc-docker/agent.token`, mode
  `600`. Any process running as you could read it — the container is not a
  security boundary against yourself.
* Host command execution is allow-listed by default. `allowAnyHostExec: true`
  turns the container into a general-purpose remote shell on your machine.
* Credentials imported with `auth import` are written as plaintext to
  `~/.cc-docker/claude/.credentials.json` (mode `600`), because that is the only
  format the Linux build of Claude Code reads. On macOS your host copy stays in
  the Keychain.

---

## Requirements

* Docker, Podman, OrbStack or colima — anything providing a `docker`-compatible CLI
* Node.js 18+ **on the host** (runs the agent; the container brings its own)
* macOS or Linux host

## Development

```bash
npm test                   # host agent, wire protocol, config generation
./install.sh --no-build    # refresh config and the doclaude command only
DOCLAUDE_DEBUG=1 doclaude  # print the full docker run command line
```

## Licence

MIT
