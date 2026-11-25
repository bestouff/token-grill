#!/usr/bin/env bash
# Usage: tools/service-session.sh [--zip FILE] [--wheel FILE] [--unsafe-helper DIR] [--kinds codex,claude] [--legacy-schemadir DIR] [--keep] OUT_DIR
#
# Tests the extension ZIP and the tokengrill service wheel together in a
# headless GNOME Shell that shares nothing writable with the session it runs
# in: a private D-Bus session bus, a private dconf database, a private keyring
# daemon, scratch XDG folders and runtime folder, and the service installed with
# pipx into a scratch PIPX_HOME. The real HOME is only read: the sign-ins of the
# account homes, and the 0.4 GSettings values of the installed extension.
#
# The accounts of the given kinds are copied from the 0.4 GSettings values into
# the private dconf database, so the extension's own migration imports them
# into the service.
#
#   --zip FILE            extension ZIP (default: `npm run pack`, then build/releases/)
#   --wheel FILE          service wheel (default: built from service/ with service/.venv)
#   --unsafe-helper DIR   a lab extension that sets global.context.unsafe_mode, so
#                         Eval and Screenshot work (or $TG_UNSAFE_HELPER); required
#   --kinds LIST          account kinds to import (default: codex,claude)
#   --legacy-schemadir    schema folder of the installed 0.4 extension
#                         (default: the user's installed copy)
#   --keep                keep the scratch folder
#
# OUT_DIR receives checks.txt, the screenshots and the logs. The exit status is
# 0 only when every check passes.
set -euo pipefail

UUID=tokengrill@sh02sahil.github.io
SCHEMA=org.gnome.shell.extensions.tokengrill
BUS_NAME=io.github.sh02sahil.TokenGrill
LEGACY_KEYS=(configuration-version active-provider-id refresh-interval-seconds notifications-enabled
    notification-step-percent diagnostics-journal panel-percentage-mode popup-account-picker
    panel-display-style panel-position)

usage() {
    sed -n '2p' "${BASH_SOURCE[0]}" | sed 's/^# //' >&2
    exit 2
}

# ---------------------------------------------------------------------------
# Inside the private D-Bus session.
# ---------------------------------------------------------------------------
in_session() {
    local S=$1 OUT=$2 R=$3 HELPER_UUID=$4
    local ext=$XDG_DATA_HOME/gnome-shell/extensions
    local pids=() shell_pid=""
    teardown() {
        if [[ -n "$shell_pid" ]]; then
            kill "$shell_pid" 2>/dev/null || true
            wait "$shell_pid" 2>/dev/null || true
        fi
        local p
        for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
    }
    trap teardown EXIT

    result() {
        printf '%s %s: %s\n' "$1" "$2" "$3" | tee -a "$OUT/checks.txt" >&3
    }
    check() {
        local name=$1 detail=$2
        shift 2
        if "$@"; then result PASS "$name" "$detail"; else result FAIL "$name" "$detail"; fi
    }
    info() {
        printf 'INFO %s\n' "$1" | tee -a "$OUT/checks.txt" >&3
    }
    matches() { [[ $1 =~ $2 ]]; }

    bus_call() {
        gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
            --method "org.freedesktop.DBus.$1" "${@:2}"
    }
    service_owned() {
        bus_call NameHasOwner "$BUS_NAME" 2>/dev/null | grep -q true
    }
    service_pid() {
        bus_call GetConnectionUnixProcessID "$BUS_NAME" 2>/dev/null | grep -o '[0-9]\+' | tail -1 || true
    }
    wait_owned() {
        local want=$1 limit=$2 i
        for ((i = 0; i < limit * 4; i++)); do
            if service_owned; then [[ $want == yes ]] && return 0; else [[ $want == no ]] && return 0; fi
            sleep 0.25
        done
        return 1
    }

    ev() {
        gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Eval "$1"
    }
    # The value of a JS expression, as Eval's JSON without the quotes of a string.
    evv() {
        ev "$1" 2>/dev/null | sed -n "s/^(true, '\(.*\)')$/\1/p" | sed 's/^"\(.*\)"$/\1/'
    }
    # Runs a JS function body with `i` bound to the Token Grill panel button.
    q() {
        evv "(i => { if (!i) return 'none'; $1 })(Main.panel.statusArea['$UUID'])"
    }
    client_status() { q 'return i._controller._client.status;'; }
    wait_q() {
        local body=$1 want=$2 limit=$3 i
        for ((i = 0; i < limit * 2; i++)); do
            [[ "$(q "$body")" == "$want" ]] && return 0
            sleep 0.5
        done
        return 1
    }

    state() {
        LC_ALL=C gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: //p'
    }
    wait_state() {
        local i
        for ((i = 0; i < 60; i++)); do
            [[ "$(state)" == "$1" ]] && return 0
            sleep 0.5
        done
        return 1
    }
    shot() {
        gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
            --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" >/dev/null
        [[ -s "$OUT/$1.png" ]]
    }
    open_menu() { ev "Main.panel.statusArea['$UUID'].menu.open(false); 'open'" >/dev/null; }
    close_menu() { ev "Main.panel.statusArea['$UUID'].menu.close(false); 'closed'" >/dev/null; }
    tg() { gsettings --schemadir "$ext/$UUID/schemas" "$@"; }

    # The keyring daemon gets its own runtime folder, so it never replaces the
    # socket of the real session.
    mkdir -m 700 "$R/k"
    printf '%s' tokengrill-lab | env XDG_RUNTIME_DIR="$R/k" gnome-keyring-daemon --foreground --unlock \
        --components=secrets > "$OUT/keyring.log" 2>&1 &
    pids+=($!)
    local i
    for ((i = 0; i < 50; i++)); do
        gdbus introspect --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
            >/dev/null 2>&1 && break
        sleep 0.2
    done
    dbus-monitor --session "type='method_call',interface='org.freedesktop.Secret.Service'" \
        "type='method_call',interface='org.freedesktop.Secret.Prompt'" > "$OUT/secret-calls.log" 2>&1 &
    pids+=($!)

    tokengrill setup > "$OUT/setup.log" 2>&1
    local service_file=$XDG_DATA_HOME/dbus-1/services/$BUS_NAME.service
    check "setup" "service file in the scratch data folder, Exec in the scratch pipx home" \
        grep -q "^Exec=$S/pipx/" "$service_file"
    check "not running before enable" "no owner of $BUS_NAME" wait_owned no 1

    gsettings set org.gnome.shell enabled-extensions "['$HELPER_UUID']"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "$(gnome-shell --version | grep -o '[0-9][0-9.]*')"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    local key value
    while IFS=$'\t' read -r key value; do
        tg set "$SCHEMA" "$key" "$value"
    done < "$S/legacy.tsv"
    local expected
    expected=$(cat "$S/expected-accounts")

    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 > "$OUT/shell.log" 2>&1 < /dev/null &
    shell_pid=$!
    for ((i = 0; i < 90; i++)); do
        ev true 2>/dev/null | grep -q '(true' && break
        sleep 1
    done
    info "shell: $(gnome-shell --version)"
    dbus-update-activation-environment WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR"

    # Activation on enable, and the import of the 0.4 accounts.
    local t0 pid1
    t0=$(date +%s)
    gnome-extensions enable "$UUID"
    wait_state ACTIVE || true
    check "ACTIVE after start" "state $(state)" [ "$(state)" == ACTIVE ]
    if wait_owned yes 30; then
        pid1=$(service_pid)
        check "service activated on enable" \
            "pid $pid1 after $(($(date +%s) - t0)) s, from the scratch pipx venv" \
            grep -qa "$S/pipx/" "/proc/$pid1/cmdline"
    else
        result FAIL "service activated on enable" "no owner of $BUS_NAME 30 s after enable"
        pid1=""
    fi
    wait_q 'return i._controller._client.status;' connected 30 || true
    wait_q 'return String(i._controller._client.state.accounts.length);' "$expected" 30 || true
    check "migration" "$(q 'return String(i._controller._client.state.accounts.length);') of $expected accounts imported, provider-instances-json now $(tg get "$SCHEMA" provider-instances-json)" \
        [ "$(q 'return String(i._controller._client.state.accounts.length);')" == "$expected" \
        -a "$(tg get "$SCHEMA" provider-instances-json)" == "'[]'" ]

    local states=""
    for i in 1 2 3; do
        gnome-extensions disable "$UUID"
        wait_state INACTIVE || true
        states+=" $(state)"
        gnome-extensions enable "$UUID"
        wait_state ACTIVE || true
        states+="/$(state)"
    done
    check "3 disable/enable cycles" "disabled/enabled:$states" [ "$states" == " INACTIVE/ACTIVE INACTIVE/ACTIVE INACTIVE/ACTIVE" ]
    ev "Main.sessionMode.pushMode('unlock-dialog'); Main.sessionMode.currentMode" >/dev/null
    wait_state INACTIVE || true
    local locked
    locked=$(state)
    ev "Main.sessionMode.popMode('unlock-dialog'); Main.sessionMode.currentMode" >/dev/null
    wait_state ACTIVE || true
    check "lock/unlock" "locked $locked, unlocked $(state)" [ "$locked" == INACTIVE -a "$(state)" == ACTIVE ]
    check "same service after cycles" "pid $(service_pid) (first $pid1)" [ -n "$pid1" -a "$(service_pid)" == "$pid1" ]

    # Wait until every account has answered, with a reading or an error, before the screenshots.
    wait_q 'return i._controller._client.status;' connected 30 || true
    local ready='const s = i._controller._client.state; if (!s) return "none";
        const busy = Object.values(s.runtime).filter(r => r.phase !== "idle").length;
        const done = s.accounts.filter(a => s.runtime[a.id] && s.runtime[a.id].completedAt !== null).length;
        return busy === 0 && done === s.accounts.length ? "ready" : `${done}/${s.accounts.length} answered, ${busy} busy`;'
    wait_q "$ready" ready 120 || true
    check "first refresh" "$(q "$ready")" [ "$(q "$ready")" == ready ]
    info "snapshot states: $(q 'const s = i._controller._client.state; return s.accounts.map(a => `${a.kind}:${s.snapshots[a.id] ? s.snapshots[a.id].state : "none"}`).join(" ");')"

    open_menu; sleep 1
    check "popup dark" "$OUT/popup-dark.png" shot popup-dark
    close_menu
    gsettings set org.gnome.desktop.interface color-scheme prefer-light
    sleep 2
    open_menu; sleep 1
    check "popup light" "$OUT/popup-light.png" shot popup-light
    close_menu
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark

    local prefs_errors_before prefs_errors
    prefs_errors_before=$(grep -c 'JS ERROR' "$OUT/bus.log" || true)
    gnome-extensions prefs "$UUID"
    sleep 8
    shot prefs || true
    prefs_errors=$(($(grep -c 'JS ERROR' "$OUT/bus.log" || true) - prefs_errors_before))
    check "preferences" "$prefs_errors JS errors in the Preferences process; $OUT/prefs.png" \
        [ "$prefs_errors" -eq 0 -a -s "$OUT/prefs.png" ]
    local prefs_pid
    prefs_pid=$(bus_call GetConnectionUnixProcessID org.gnome.Shell.Extensions 2>/dev/null | grep -o '[0-9]\+' | tail -1 || true)
    if [[ -n "$prefs_pid" ]]; then
        kill "$prefs_pid" 2>/dev/null || true
    fi

    # The CLI reaches the same service.
    if timeout 60 tokengrill status --json > "$S/status.json" 2> "$OUT/status.err"; then
        python3 - "$S/status.json" "$OUT/status-redacted.json" "$expected" <<'EOF' | tee -a "$OUT/checks.txt" >&3
import json, sys
state = json.load(open(sys.argv[1]))
accounts = state["accounts"]
# The account field can hold an e-mail address; the saved copy leaves it out.
for snap in state["snapshots"].values():
    if snap.get("account") is not None:
        snap["account"] = "<redacted>"
json.dump(state, open(sys.argv[2], "w"), indent=2)
kinds = ",".join(sorted(a["kind"] for a in accounts))
ok = len(accounts) == int(sys.argv[3]) and len(accounts) > 0
print(f"{'PASS' if ok else 'FAIL'} status --json: {len(accounts)} accounts ({kinds}), service {state['serviceVersion']}, api {state['apiVersion']}")
for a in accounts:
    snap = state["snapshots"].get(a["id"]) or {}
    print(f"INFO   {a['kind']} {a['displayName']!r}: {snap.get('state')}, {len(snap.get('windows') or [])} windows")
EOF
    else
        result FAIL "status --json" "exit $?, see $OUT/status.err"
    fi

    # A killed service: the popup keeps the last readings under the not-responding card,
    # and the 15 s retry starts a new service.
    local old_pid=$(service_pid)
    kill -9 "$old_pid"
    wait_owned no 10 || true
    sleep 2
    local silent='const c = i._ui.serviceCard; const s = i._controller._client.state;
        return `${i._controller._client.status} card=${c.visible}:${c.failure} detail=${i._ui.detail.actor.visible} snapshots=${s ? Object.keys(s.snapshots).length : 0}`;'
    local seen
    seen=$(q "$silent")
    open_menu; sleep 1
    shot popup-not-responding || true
    close_menu
    check "killed service: not-responding card with last readings" "pid $old_pid killed; $seen; $OUT/popup-not-responding.png" \
        matches "$seen" '^not-responding card=true:not-responding detail=true snapshots=[1-9]'
    t0=$(date +%s)
    wait_q 'return i._controller._client.status;' connected 45 || true
    local new_pid
    new_pid=$(service_pid)
    seen=$(q "$silent")
    open_menu; sleep 1
    shot popup-recovered || true
    close_menu
    local recovered=no
    [[ -n "$new_pid" && "$new_pid" != "$old_pid" && "$seen" =~ ^connected\ card=false:null ]] && recovered=yes
    check "retry recovers" "after $(($(date +%s) - t0)) s: new pid ${new_pid:-none}; $seen; $OUT/popup-recovered.png" \
        [ "$recovered" == yes ]

    # Idle exit after the last shell client leaves.
    gnome-extensions disable "$UUID"
    wait_state INACTIVE || true
    t0=$(date +%s)
    local gone=no
    wait_owned no 75 && gone=yes
    local waited=$(($(date +%s) - t0))
    check "idle exit after final disable" "state $(state), service gone=$gone after $waited s" \
        [ "$gone" == yes -a "$waited" -le 70 ]

    sleep 1
    local unlock prompt search
    unlock=$(grep -c 'member=Unlock' "$OUT/secret-calls.log" || true)
    prompt=$(grep -c 'interface=org.freedesktop.Secret.Prompt' "$OUT/secret-calls.log" || true)
    search=$(grep -c 'member=SearchItems' "$OUT/secret-calls.log" || true)
    check "keyring" "Unlock $unlock, Prompt $prompt (SearchItems $search)" [ "$unlock" -eq 0 -a "$prompt" -eq 0 ]

    kill "$shell_pid" 2>/dev/null || true
    wait "$shell_pid" 2>/dev/null || true
    shell_pid=""
    local tgl crit disposed
    tgl=$(grep -ciE 'token ?grill|tokengrill|token-grill' "$OUT/shell.log" || true)
    crit=$(grep -c 'CRITICAL' "$OUT/shell.log" || true)
    disposed=$(grep -c 'already disposed' "$OUT/shell.log" || true)
    check "shell log" "Token Grill lines $tgl, criticals $crit, already disposed $disposed" \
        [ "$tgl" -eq 0 -a "$crit" -eq 0 -a "$disposed" -eq 0 ]
    # The Preferences process and the service are started by the bus, so their output is in bus.log.
    local jserr bcrit bdisposed
    jserr=$(grep -c 'JS ERROR' "$OUT/bus.log" || true)
    bcrit=$(grep -c 'CRITICAL' "$OUT/bus.log" || true)
    bdisposed=$(grep -c 'already disposed' "$OUT/bus.log" || true)
    check "bus log (Preferences, service)" "JS errors $jserr, criticals $bcrit, already disposed $bdisposed" \
        [ "$jserr" -eq 0 -a "$bcrit" -eq 0 -a "$bdisposed" -eq 0 ]
}

if [[ "${1:-}" == --in-session ]]; then
    shift
    in_session "$@"
    exit 0
fi

# ---------------------------------------------------------------------------
# Outside: build, isolate, run, compare the real session before and after.
# ---------------------------------------------------------------------------
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zip="" wheel="" helper="${TG_UNSAFE_HELPER:-}" kinds=codex,claude keep=no
legacy_schemadir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID/schemas"
while [[ $# -gt 0 ]]; do
    case "$1" in
    --zip) zip=$2; shift 2 ;;
    --wheel) wheel=$2; shift 2 ;;
    --unsafe-helper) helper=$2; shift 2 ;;
    --kinds) kinds=$2; shift 2 ;;
    --legacy-schemadir) legacy_schemadir=$2; shift 2 ;;
    --keep) keep=yes; shift ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) break ;;
    esac
done
[[ $# -eq 1 ]] || usage
[[ -n "$helper" && -f "$helper/metadata.json" ]] || { echo "Give the unsafe-mode helper extension with --unsafe-helper." >&2; exit 2; }
OUT=$(realpath -m "$1")
mkdir -p "$OUT"
rm -f "$OUT"/*.png "$OUT/checks.txt"
helper=$(realpath "$helper")
helper_uuid=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$helper/metadata.json")

uid=$(id -u)
S=$(mktemp -d "${TMPDIR:-/tmp}/tg-session.XXXXXX")
# Wayland socket paths are limited to 108 bytes, so the runtime folder is short.
R=$(mktemp -d "/run/user/$uid/tgs.XXXXXX")
chmod 700 "$R"
sweep() {
    # Whatever still runs with the private runtime folder was started by this script.
    local p
    for p in $(grep -lsz "^XDG_RUNTIME_DIR=$R" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); do
        echo "INFO left over: $p $(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | cut -c1-80)"
        kill "$p" 2>/dev/null || true
    done
    if mountpoint -q "$R/gvfs" 2>/dev/null; then
        sleep 1
        fusermount3 -u -q "$R/gvfs" 2>/dev/null || fusermount -u -q "$R/gvfs" 2>/dev/null || true
    fi
}
cleanup() {
    sweep
    rm -rf "${R:?}"
    if [[ $keep == yes ]]; then echo "scratch kept: $S"; else rm -rf "${S:?}"; fi
}
trap cleanup EXIT

if [[ -z "$zip" ]]; then
    (cd "$root" && npm run pack) > "$OUT/build-zip.log" 2>&1
    zip=$root/build/releases/$UUID.shell-extension.zip
fi
if [[ -z "$wheel" ]]; then
    (cd "$root/service" && .venv/bin/python -m build --wheel -o "$S/wheel") > "$OUT/build-wheel.log" 2>&1
    wheel=$(ls "$S"/wheel/tokengrill-*.whl)
fi
zip=$(realpath "$zip") wheel=$(realpath "$wheel")
echo "zip: $zip"
echo "wheel: $wheel"

real_keyring() {
    printf 'control %s; daemons %s' "$(stat -c 'inode %i ctime %Z' "/run/user/$uid/keyring/control" 2>&1)" \
        "$(pgrep -u "$uid" -x gnome-keyring-d | tr '\n' ' ' || true)"
}
real_config() {
    local dir="${XDG_CONFIG_HOME:-$HOME/.config}/token-grill"
    local file="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/$BUS_NAME.service"
    { find "$dir" "$file" -printf '%p %s %T@\n' 2>/dev/null || true; } | sort | md5sum | cut -c1-12
}
keyring_before=$(real_keyring)
config_before=$(real_config)

# The 0.4 values, read from the real dconf database with the installed schema.
mkdir -p "$S/data" "$S/config" "$S/state" "$S/cache" "$S/services" "$S/pipx" "$S/bin" "$S/man"
python3 - "$legacy_schemadir" "$SCHEMA" "$kinds" "$S/legacy.tsv" "$S/expected-accounts" "${LEGACY_KEYS[@]}" <<'EOF'
import ast, json, os, subprocess, sys
schemadir, schema, kinds, out, count_file, *keys = sys.argv[1:]
wanted = set(kinds.split(","))
def get(key):
    return subprocess.check_output(["gsettings", "--schemadir", schemadir, "get", schema, key], text=True).strip()
if os.path.isdir(schemadir):
    entries = [e for e in json.loads(ast.literal_eval(get("provider-instances-json"))) if e.get("kind") in wanted]
    values = {key: get(key) for key in keys}
else:
    # No 0.4 install: one account of each kind in its default home.
    homes = {"codex": "~/.codex", "claude": "~/.claude"}
    entries = [{"schemaVersion": 2, "id": f"{kind}-lab", "kind": kind, "displayName": kind.title(),
                "accent": "blue", "enabled": True, "showInPanel": True, "sortOrder": n,
                "accountHome": homes[kind], "authFileOverride": None, "sessionsDirectoryOverride": None,
                "liveUsageEnabled": True, "localHistoryEnabled": False, "panelWindowPreference": "automatic"}
               for n, kind in enumerate(sorted(wanted & homes.keys()))]
    values = {"configuration-version": "uint32 2"}
text = json.dumps(entries)
values["provider-instances-json"] = "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"
with open(out, "w") as f:
    for key, value in values.items():
        f.write(f"{key}\t{value}\n")
open(count_file, "w").write(str(len(entries)))
print(f"legacy accounts to import: {len(entries)} ({','.join(sorted(e['kind'] for e in entries))})")
EOF

PIPX_HOME="$S/pipx" PIPX_BIN_DIR="$S/bin" PIPX_MAN_DIR="$S/man" XDG_CACHE_HOME="$S/cache" \
    XDG_CONFIG_HOME="$S/config" XDG_DATA_HOME="$S/data" XDG_STATE_HOME="$S/state" \
    pipx install --quiet "$wheel" > "$OUT/pipx.log" 2>&1

ext=$S/data/gnome-shell/extensions
mkdir -p "$ext/$UUID"
unzip -q "$zip" -d "$ext/$UUID"
glib-compile-schemas "$ext/$UUID/schemas"
cp -r "$helper" "$ext/$helper_uuid"

printf 'user-db:tokengrill_session\n' > "$S/dconf-profile"
# Nothing on the private bus may start a keyring daemon that uses the real runtime folder.
printf '[D-BUS Service]\nName=org.freedesktop.secrets\nExec=/bin/false\n' > "$S/services/org.freedesktop.secrets.service"
sed "s|<standard_session_servicedirs */>|<servicedir>$S/services</servicedir>&|" /usr/share/dbus-1/session.conf > "$S/session.conf"
grep -q "<servicedir>$S/services</servicedir>" "$S/session.conf"

echo "real keyring before: $keyring_before"
env -u GDK_BACKEND -u GSETTINGS_BACKEND -u WAYLAND_DISPLAY -u DISPLAY -u XAUTHORITY \
    -u GNOME_KEYRING_CONTROL -u SSH_AUTH_SOCK -u SESSION_MANAGER -u XDG_SESSION_ID -u XDG_SEAT -u XDG_VTNR \
    -u DESKTOP_STARTUP_ID -u XDG_ACTIVATION_TOKEN \
    PATH="$S/bin:$PATH" PIPX_HOME="$S/pipx" \
    XDG_DATA_HOME="$S/data" XDG_CONFIG_HOME="$S/config" XDG_STATE_HOME="$S/state" XDG_CACHE_HOME="$S/cache" \
    XDG_RUNTIME_DIR="$R" DCONF_PROFILE="$S/dconf-profile" \
    dbus-run-session --config-file="$S/session.conf" -- \
    bash "${BASH_SOURCE[0]}" --in-session "$S" "$OUT" "$R" "$helper_uuid" 3>&1 > "$OUT/bus.log" 2>&1 || true
sweep | tee -a "$OUT/checks.txt"

keyring_after=$(real_keyring)
echo "real keyring after: $keyring_after"
if [[ "$keyring_before" == "$keyring_after" && "$keyring_before" == *inode* ]]; then
    echo "PASS real keyring intact: $keyring_after" | tee -a "$OUT/checks.txt"
else
    echo "FAIL real keyring intact: before $keyring_before, after $keyring_after" | tee -a "$OUT/checks.txt"
fi
if [[ "$config_before" == "$(real_config)" ]]; then
    echo "PASS real token-grill config and service file untouched" | tee -a "$OUT/checks.txt"
else
    echo "FAIL real token-grill config or service file changed" | tee -a "$OUT/checks.txt"
fi

passed=$(grep -c '^PASS' "$OUT/checks.txt" || true)
failed=$(grep -c '^FAIL' "$OUT/checks.txt" || true)
echo "== $passed passed, $failed failed; output in $OUT"
[[ "$failed" -eq 0 ]]
