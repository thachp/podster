# Shared by the script self-tests: a scratch folder, a result line per check, and a stand-in `curl` for staging.
# Nothing here touches the network.

scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"
fix="$tmp/fix"
mkdir -p "$bin" "$fix"

failures=0
check() { # check TITLE COMMAND...: passes when the command succeeds
  local title=$1
  shift
  if "$@"; then echo "ok   $title"; else echo "FAIL $title"; failures=$((failures + 1)); fi
}
finish() { # finish NAME
  if [ "$failures" -ne 0 ]; then echo "$failures failed"; exit 1; fi
  echo "$1 selftest passed"
}

# run EXPECTED-EXIT COMMAND...: runs it with the stand-ins first on PATH, keeps its output in $tmp/out.
run() {
  local expected=$1 code=0
  shift
  PATH="$bin:$PATH" "$@" > "$tmp/out" 2>&1 || code=$?
  LAST=$code
  [ "$code" -eq "$expected" ]
}
# Each takes one extended regular expression. `never_called` ignores case.
said() { grep -q -E -- "$1" "$tmp/out"; }
called() { grep -q -E -- "$1" "$fix/calls"; }
never_called() { ! grep -q -i -E -- "$1" "$fix/calls"; }

stub() { # stub NAME: writes stdin as an executable stand-in
  cat > "$bin/$1"
  chmod +x "$bin/$1"
}

# A stand-in curl that answers from $fix/<probe>.{status,body,headers}. It finds $fix beside itself, because the
# probes start curl with an empty environment.
stub_curl() {
  stub curl <<'EOF'
#!/usr/bin/env bash
fix="$(dirname "$0")/../fix"
echo "curl $*" >> "$fix/calls"
method=GET out=/dev/null headers=/dev/null url=
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift ;;
    -o) out=$2; shift ;;
    -D) headers=$2; shift ;;
    -H | -w | --proto | --max-time) shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$method $url" in
  "GET https://gateway-staging.podster.dev/api/v1/me") key=me ;;
  "POST https://gateway-staging.podster.dev/a2a") key=a2a ;;
  "POST https://gateway-staging.podster.dev/a2a/") key=a2a-slash ;;
  "POST https://gateway-staging.podster.dev/webhooks/github") key=webhook ;;
  "GET https://app-staging.podster.dev/p/pub_0000000000000000000000") key=public ;;
  *) echo "unexpected request: $method $url" >&2; exit 97 ;;
esac
status=$(cat "$fix/$key.status")
if [ "$status" = unreachable ]; then echo "curl: (7) could not connect" >&2; printf 000; exit 7; fi
cat "$fix/$key.body" > "$out"
cat "$fix/$key.headers" > "$headers"
printf '%s' "$status"
EOF
}

# What staging answers when all is well.
healthy_staging() {
  rm -f "$fix"/*.status "$fix"/*.body "$fix"/*.headers "$fix/calls"
  : > "$fix/calls"
  local key
  for key in me a2a a2a-slash webhook public; do
    printf 'HTTP/2 000\r\ncontent-type: application/json\r\n\r\n' > "$fix/$key.headers"
  done
  echo 401 > "$fix/me.status"; echo '{"error":{"code":"unauthenticated"}}' > "$fix/me.body"
  echo 401 > "$fix/a2a.status"; echo '{"error":"unauthorized"}' > "$fix/a2a.body"
  echo 401 > "$fix/a2a-slash.status"; echo '{"error":"unauthorized"}' > "$fix/a2a-slash.body"
  echo 401 > "$fix/webhook.status"; echo '{"error":{"code":"invalid_signature"}}' > "$fix/webhook.body"
  echo 404 > "$fix/public.status"; echo '<!doctype html><title>Not found</title><p>Not found</p>' > "$fix/public.body"
  printf 'HTTP/2 404\r\ncontent-type: text/html\r\nCache-Control: no-store, no-transform\r\n\r\n' > "$fix/public.headers"
}
