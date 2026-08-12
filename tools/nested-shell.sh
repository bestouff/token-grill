#!/usr/bin/env bash
set -euo pipefail

uuid="$(node -p 'require("./metadata.json").uuid')"

target_path=""
for root in "$HOME/.local/share/gnome-shell/extensions" /usr/local/share/gnome-shell/extensions /usr/share/gnome-shell/extensions; do
  candidate="$root/$uuid"
  [[ -f "$candidate/metadata.json" ]] || continue
  installed_uuid="$(node -e '
    try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).uuid || ""); } catch {}
  ' "$candidate/metadata.json")"
  if [[ "$installed_uuid" == "$uuid" ]]; then
    target_path="$candidate"
    break
  fi
done

if [[ -z "$target_path" ]]; then
  echo "Token Grill is not installed as $uuid." >&2
  echo "Run 'npm run install:local' before starting the development shell." >&2
  exit 1
fi

for root in "$HOME/.local/share/gnome-shell/extensions" /usr/local/share/gnome-shell/extensions /usr/share/gnome-shell/extensions; do
  [[ -d "$root" ]] || continue
  for metadata in "$root"/*/metadata.json; do
    [[ -f "$metadata" ]] || continue
    candidate_uuid="$(node -e '
      try {
        const metadata = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (metadata.name === "Token Grill" && typeof metadata.uuid === "string") process.stdout.write(metadata.uuid);
      } catch {}
    ' "$metadata")"
    if [[ -n "$candidate_uuid" && "$candidate_uuid" != "$uuid" ]]; then
      echo "Conflicting Token Grill installation: $candidate_uuid" >&2
      echo "Path: ${metadata%/metadata.json}" >&2
      echo "Disable or uninstall it before testing $uuid." >&2
      exit 1
    fi
  done
done

if [[ "$(gnome-shell --version | awk '{print int($3)}')" -ge 49 ]]; then
  shell_args=(--devkit --wayland)
else
  shell_args=(--nested --wayland)
fi

# Keep the development shell in its own D-Bus session. This never replaces the
# user's current Shell session or closes its windows, and it also enables the
# freshly built extension on that private bus automatically.
exec dbus-run-session -- bash -c '
  gnome-shell "$@" >/tmp/tokengrill-shell.log 2>&1 &
  shell=$!
  trap "kill $shell 2>/dev/null || true" EXIT
  for _ in {1..20}; do
    kill -0 "$shell" 2>/dev/null || exit 1
    sleep 0.5
  done
  uuid="$(node -p "require(\"$PWD/metadata.json\").uuid")"
  gnome-extensions enable "$uuid"
  for _ in {1..20}; do
    if gnome-extensions info "$uuid" | grep -q "State: ACTIVE"; then
      echo "Token Grill $uuid is active in the nested shell."
      echo "Shell log: /tmp/tokengrill-shell.log"
      echo "Close this terminal to stop the development shell."
      wait "$shell"
      exit $?
    fi
    kill -0 "$shell" 2>/dev/null || exit 1
    sleep 0.25
  done
  echo "Token Grill $uuid did not reach ACTIVE state." >&2
  echo "Inspect /tmp/tokengrill-shell.log for details." >&2
  exit 1
' _ "${shell_args[@]}"
