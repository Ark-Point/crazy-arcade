#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_WAS_SET="${PORT+x}"
ORIGIN_URL_WAS_SET="${ORIGIN_URL+x}"
PORT="${PORT:-3000}"
ORIGIN_URL="${ORIGIN_URL:-http://localhost:${PORT}}"
SERVER_STARTUP_TIMEOUT="${SERVER_STARTUP_TIMEOUT:-30}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-1}"
AUTO_PORT_SCAN_LIMIT="${AUTO_PORT_SCAN_LIMIT:-50}"
SERVER_PID=""

usage() {
  cat <<'EOF'
Run the Crazay Arkade server and expose it with a Cloudflare Quick Tunnel.

Usage:
  npm run deploy:tunnel
  PORT=4000 npm run deploy:tunnel
  ORIGIN_URL=http://localhost:3000 npm run deploy:tunnel

Environment:
  PORT                    Local server port. Default: 3000, or next free port if 3000 is busy.
  ORIGIN_URL              URL passed to cloudflared. Default: http://localhost:$PORT
  SERVER_STARTUP_TIMEOUT  Seconds to wait for the local server. Default: 30
  CLOUDFLARED_BIN         cloudflared executable path/name. Default: cloudflared
  AUTO_PORT_SCAN_LIMIT    Ports to scan for an existing Crazay Arkade server. Default: 50
  SKIP_INSTALL=1          Do not run npm install when node_modules is missing.
EOF
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo
    echo "Stopping Crazay Arkade server..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

port_is_available() {
  node - "$1" <<'NODE'
const net = require('net');

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.exit(1);
}

const server = net.createServer();
server.once('error', () => process.exit(1));
server.once('listening', () => {
  server.close(() => process.exit(0));
});
server.listen(port, '127.0.0.1');
NODE
}

find_available_port() {
  local candidate="$1"
  while (( candidate <= 65535 )); do
    if port_is_available "$candidate"; then
      echo "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done

  return 1
}

origin_url_is_crazay_arkade() {
  local url="$1"
  curl -fsS --max-time "$HTTP_TIMEOUT" "$url" 2>/dev/null | grep -F 'id="game-canvas"' >/dev/null
}

find_existing_crazay_arkade_port() {
  local candidate="$1"
  local checked=0

  while (( candidate <= 65535 && checked < AUTO_PORT_SCAN_LIMIT )); do
    if origin_url_is_crazay_arkade "http://localhost:${candidate}"; then
      echo "$candidate"
      return 0
    fi

    candidate=$((candidate + 1))
    checked=$((checked + 1))
  done

  return 1
}

can_auto_select_port() {
  [[ -z "$PORT_WAS_SET" && -z "$ORIGIN_URL_WAS_SET" && "$PORT" =~ ^[0-9]+$ ]]
}

http_is_up() {
  curl -fsS --max-time "$HTTP_TIMEOUT" "$ORIGIN_URL" >/dev/null 2>&1
}

origin_is_crazay_arkade() {
  origin_url_is_crazay_arkade "$ORIGIN_URL"
}

running_tunnel_pid_for_origin() {
  ps -axo pid=,command= |
    awk -v origin="$ORIGIN_URL" '$0 ~ /[c]loudflared/ && $0 ~ /tunnel --url/ && index($0, origin) { print $1; exit }'
}

running_tunnel_public_url() {
  local metrics_port
  local public_url

  for metrics_port in $(seq 20241 20280); do
    public_url="$(
      { curl -fsS --max-time "$HTTP_TIMEOUT" "http://127.0.0.1:${metrics_port}/metrics" 2>/dev/null || true; } |
        sed -n 's/.*userHostname="\([^"]*\)".*/\1/p' |
        head -n 1
    )"

    if [[ -n "$public_url" ]]; then
      echo "$public_url"
      return 0
    fi
  done

  return 1
}

exit_if_tunnel_already_running() {
  local tunnel_pid
  tunnel_pid="$(running_tunnel_pid_for_origin)"

  if [[ -z "$tunnel_pid" ]]; then
    return 0
  fi

  echo "Cloudflare Quick Tunnel is already running for $ORIGIN_URL (pid $tunnel_pid)."

  local public_url
  if public_url="$(running_tunnel_public_url)"; then
    echo "Public URL: $public_url"
  else
    echo "Public URL: check the terminal where cloudflared was started."
  fi

  echo "Leave it running to keep the URL online. Stop it with: kill $tunnel_pid"
  exit 0
}

wait_for_server() {
  local elapsed=0
  while (( elapsed < SERVER_STARTUP_TIMEOUT )); do
    if http_is_up; then
      return 0
    fi

    if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID" 2>/dev/null || true
      echo "Crazay Arkade server exited before it was ready." >&2
      return 1
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "Timed out waiting for $ORIGIN_URL after ${SERVER_STARTUP_TIMEOUT}s." >&2
  return 1
}

warn_cloudflared_config() {
  local config_path
  for config_path in "$HOME/.cloudflared/config.yaml" "$HOME/.cloudflared/config.yml"; do
    if [[ -f "$config_path" ]]; then
      echo "Warning: Quick Tunnels may fail while $config_path exists."
      echo "If cloudflared refuses to start, temporarily move that config file."
      return 0
    fi
  done
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_cmd npm
  require_cmd node
  require_cmd curl

  if ! command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1; then
    echo "Missing cloudflared executable: $CLOUDFLARED_BIN" >&2
    echo "Install it first, then run this script again:" >&2
    echo "  brew install cloudflared" >&2
    echo "  # or see https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/" >&2
    exit 1
  fi

  cd "$ROOT_DIR"

  local suggested_port=4000
  if [[ "$PORT" =~ ^[0-9]+$ ]]; then
    suggested_port=$((PORT + 1))
  fi

  if [[ ! -d node_modules && "${SKIP_INSTALL:-0}" != "1" ]]; then
    echo "node_modules is missing. Installing dependencies..."
    npm install
  fi

  if http_is_up; then
    if ! origin_is_crazay_arkade; then
      if can_auto_select_port; then
        local existing_port
        if existing_port="$(find_existing_crazay_arkade_port "$((PORT + 1))")"; then
          echo "$ORIGIN_URL is already serving a different app."
          PORT="$existing_port"
          ORIGIN_URL="http://localhost:${PORT}"
          echo "Using existing Crazay Arkade server at $ORIGIN_URL instead."
        else
          local fallback_port
          if ! fallback_port="$(find_available_port "$((PORT + 1))")"; then
            echo "Could not find an available local port after $PORT." >&2
            exit 1
          fi
          echo "$ORIGIN_URL is already serving a different app."
          PORT="$fallback_port"
          ORIGIN_URL="http://localhost:${PORT}"
          echo "Using $ORIGIN_URL instead."
        fi
      else
        echo "$ORIGIN_URL is already serving a different app." >&2
        echo "Stop the process using that port or choose another port, for example:" >&2
        echo "  PORT=${suggested_port} npm run deploy:tunnel" >&2
        exit 1
      fi
    else
      echo "Using existing Crazay Arkade server at $ORIGIN_URL"
    fi
  fi

  if http_is_up && origin_is_crazay_arkade; then
    exit_if_tunnel_already_running
  fi

  if ! http_is_up; then
    echo "Starting Crazay Arkade server at $ORIGIN_URL"
    PORT="$PORT" npm start &
    SERVER_PID="$!"
    wait_for_server

    if ! origin_is_crazay_arkade; then
      echo "The server at $ORIGIN_URL did not look like Crazay Arkade after startup." >&2
      exit 1
    fi
  fi

  warn_cloudflared_config

  echo
  echo "Starting Cloudflare Quick Tunnel for $ORIGIN_URL"
  echo "Keep this process running. The public trycloudflare.com URL will appear below."
  echo
  "$CLOUDFLARED_BIN" tunnel --url "$ORIGIN_URL"
}

trap cleanup EXIT INT TERM
main "$@"
