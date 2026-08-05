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

### PATH inside the container

Because your home directory is mounted at the same absolute path, host binary
directories (`~/.local/bin`, `~/.cargo/bin`, nvm shims) are *visible* inside the
container — full of executables built for the host OS. Left alone they shadow
the container's own tools, and `claude` itself resolves to a macOS binary that
cannot run on Linux.

So container directories always win, and host-home directories are dropped from
`PATH`. Those tools are still reachable — through the host bridge, where they
can actually execute. Set `DOCLAUDE_KEEP_HOME_PATH=1` to opt out.

For the same reason shells in the container are **not** login shells: your
`.zshrc`/`.bash_profile` describe the host, not this Linux userland.

---

## Networks that inspect TLS

Corporate proxies (Zscaler, Netskope, most enterprise firewalls) re-sign every
HTTPS connection with a private root certificate. Your host trusts it; a stock
Debian container has never seen it. The symptom is a build that dies on its
first download:

```
curl: (60) SSL certificate problem: self-signed certificate in certificate chain
```

`install.sh` handles this on its own: it collects the extra roots your machine
already trusts — the macOS System keychain, `/usr/local/share/ca-certificates`
and `/etc/pki/ca-trust/source/anchors` on Linux, plus any of `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` set in your shell — and
installs them into the image before the first outbound request. If detection
comes up empty, point it at the root directly:

```bash
./install.sh --ca-file /path/to/corporate-root.crt     # repeatable
```

On macOS you can export everything your machine trusts with:

```bash
security find-certificate -a -p /Library/Keychains/System.keychain > roots.crt
```

Both paths are covered: the system trust store (curl, uv, apt, the build itself)
and `NODE_EXTRA_CA_CERTS` (node, npx, Claude Code). `NODE_EXTRA_CA_CERTS` is
*additive* — cc-docker deliberately never sets `SSL_CERT_FILE`, which would
**replace** the public roots and break everything the corporate CA did not sign.

A root added later takes effect on the next run without a rebuild: the
entrypoint refreshes the trust store when the bundle changes. `doclaude self
doctor` verifies a real TLS handshake from inside a real container.

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
| `caBundle` | `~/.cc-docker/certs/extra-ca.crt` | extra roots for TLS-inspecting networks |
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

**The build looks stuck on "Installing Claude Code".** Claude Code's native
binary is ~290 MB, and on a link that inspects TLS every byte is decrypted,
scanned and re-encrypted. cc-docker downloads it once (the official installer
fetches it twice) and prints a progress line every 15 seconds, so you can tell
a slow download from a dead one:

```
cc-docker: downloaded 160 MiB of 272 MiB (58%)
```

If those lines stop advancing, the transfer is aborted after five minutes below
1 KB/s and retried, resuming rather than starting over.

A build that fails part-way does not throw away what it fetched: the partial
download lives in a BuildKit cache mount, so re-running `./install.sh` picks up
where it stopped. (`--no-cache` discards it — avoid that flag on a slow link.)

If the download fails outright, the build stops instead of falling back to the
official installer: that installer fetches the same file from the same place,
twice, under its own ten-minute deadline, so it would only reach the same
failure more slowly. `Download timed out: exceeded the total deadline` is what
that looks like.

**`/usage` says "Failed to load usage data" while everything else works.**
Something has set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Claude Code tests
that variable for *presence*, not value — even `=0` switches it on — and in that
mode `/api/oauth/usage` is refused, along with `/design-sync` and ultrareview.
`doclaude self doctor` reports it. Remove it from `env` in
`~/.cc-docker/config.json` and from any `extraDockerArgs`.

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

The container finds the host agent by trying `host.docker.internal`,
`gateway.docker.internal`, `host.containers.internal` and finally the default
gateway, caching whichever answers — so no single runtime is assumed.
`doclaude self doctor` proves the route by opening a real socket from a real
container rather than inferring it.

### Verified

Exercised end to end on macOS 15 (Apple Silicon) with OrbStack 29.4:

* `/login` — Claude Code bound its OAuth listener on container port `36153`, the
  shim caught the browser open, the agent bound `127.0.0.1:36153` on the host,
  tunnelled it inward and released it when the session ended
* a native macOS Mach-O MCP server and a `uvx` server both reporting
  `✔ Connected` from inside the Linux container
* `osascript` executed on the host from the container
* Claude Code reading mounted host files and answering prompts

Not yet exercised: a Linux host, and Podman/colima specifically.

## Development

```bash
npm test                   # host agent, wire protocol, config generation
./test/tls-integration.sh  # extra root certificates (needs Docker + openssl)
./install.sh --no-build    # refresh config and the doclaude command only
DOCLAUDE_DEBUG=1 doclaude  # print the full docker run command line
```

## Licence

MIT
