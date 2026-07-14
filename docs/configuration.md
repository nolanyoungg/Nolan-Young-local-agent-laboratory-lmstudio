# Configuration

Configuration precedence is CLI, environment, explicitly selected trusted application configuration, then safe defaults. Only the laboratory root `.env` is loaded. A target workspace `.env` is never read.

Common variables:

| Variable              | Default                 | Meaning                                     |
| --------------------- | ----------------------- | ------------------------------------------- |
| `LM_STUDIO_BASE_URL`  | `http://127.0.0.1:1234` | Loopback HTTP control-plane URL             |
| `LM_STUDIO_API_TOKEN` | unset                   | Selects authenticated native REST transport |
| `LM_STUDIO_MODEL`     | `openai/gpt-oss-20b`    | Exact or resolvable LM Studio model key     |
| `REPORTS_DIRECTORY`   | `reports/runs`          | Trusted run/lock root                       |

URLs containing credentials, paths, queries, fragments, LAN addresses, or remote hostnames are rejected. The SDK WebSocket URL is derived internally from the validated HTTP URL. Policies are loaded only from files shipped by this laboratory or from an operator-supplied path explicitly named on the command line.
