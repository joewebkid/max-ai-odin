# codex-lb server deploy

Separate PM2-managed Docker deployment for `codex-lb`.

Default external ports:

- `2455` - dashboard and OpenAI-compatible API
- `1455` - OAuth callback helper port used by codex-lb

Optional outbound proxy for OpenAI auth/upstream:

- add `--add-host=host.docker.internal:host-gateway` to the container run
- point `HTTP_PROXY` / `HTTPS_PROXY` to a host-level HTTP proxy such as `http://host.docker.internal:10809`
- enable `CODEX_LB_UPSTREAM_WEBSOCKET_TRUST_ENV=true` so websocket upstream traffic also uses the proxy
