#!/usr/bin/env bash
# Runs a Token Grill release ZIP in a nested GNOME Shell window, so you can try
# it without logging out. The nested shell has its own settings, extensions,
# data and keyring. Your session, its settings and its keyring do not change.
#
#     bash try.sh tokengrill@sh02sahil.github.io.shell-extension.zip
#
# In a clone of the repository, `npm run pack && npm run try` uses the ZIP of
# the current build.
set -euo pipefail

uuid=tokengrill@sh02sahil.github.io

# Runs inside the private D-Bus session.
run_nested() {
    gsettings set org.gnome.shell enabled-extensions "['$uuid']"
    gsettings set org.gnome.shell disable-user-extensions false
    # The welcome tour of a new user would cover the window.
    local version
    version="$(gnome-shell --version | grep -o '[0-9][0-9.]*' || true)"
    [[ -n "$version" ]] && gsettings set org.gnome.shell welcome-dialog-last-shown-version "$version"
    exec gnome-shell --devkit --wayland
}

if [[ "${1:-}" == --in-session ]]; then
    run_nested
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zip="${1:-$root/build/releases/$uuid.shell-extension.zip}"
if [[ ! -f "$zip" ]]; then
    echo "No ZIP file at $zip." >&2
    echo "Give the path of the release ZIP, or run 'npm run pack' first." >&2
    exit 1
fi
zip="$(realpath "$zip")"

session_conf=/usr/share/dbus-1/session.conf
if [[ ! -f "$session_conf" ]]; then
    echo "$session_conf is missing, so the nested D-Bus session cannot be set up." >&2
    exit 1
fi

scratch="$(mktemp -d)"
db=tokengrill_try
cleanup() {
    rm -rf "$scratch"
    if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
        rm -f "$XDG_RUNTIME_DIR/dconf/$db"
    fi
}
trap cleanup EXIT

data="$scratch/data"
extension="$data/gnome-shell/extensions/$uuid"
mkdir -p "$extension" "$scratch/config" "$scratch/state" "$scratch/cache" "$scratch/services"
mkdir -m 700 "$scratch/runtime"
unzip -q "$zip" -d "$extension"
glib-compile-schemas "$extension/schemas"

# OpenCode and kiro-cli keep their sign-ins in the data folder. Token Grill
# only reads them.
for app in opencode kiro-cli; do
    source_dir="${XDG_DATA_HOME:-$HOME/.local/share}/$app"
    if [[ -e "$source_dir" ]]; then
        ln -s "$source_dir" "$data/$app"
    fi
done

# A separate dconf database. Preferences and the nested shell tell each other
# about changes through D-Bus, which does not depend on free file watches.
printf 'user-db:%s\n' "$db" > "$scratch/dconf-profile"

# A keyring daemon started in the nested session would replace the keyring
# socket of your session in the runtime folder. This daemon gets its own
# runtime folder. The first key that you paste asks for a password for a new
# test keyring.
keyring="$(command -v gnome-keyring-daemon || true)"
if [[ -n "$keyring" ]]; then
    secrets_exec="/usr/bin/env XDG_RUNTIME_DIR=$scratch/runtime $keyring --start --foreground --components=secrets"
else
    secrets_exec=/bin/false
fi
printf '[D-BUS Service]\nName=org.freedesktop.secrets\nExec=%s\n' "$secrets_exec" \
    > "$scratch/services/org.freedesktop.secrets.service"
# The first service folder in the list takes priority.
sed "s|<standard_session_servicedirs */>|<servicedir>$scratch/services</servicedir>&|" \
    "$session_conf" > "$scratch/session.conf"
if ! grep -q "<servicedir>$scratch/services</servicedir>" "$scratch/session.conf"; then
    echo "$session_conf has an unknown layout, so the keyring of your session cannot be protected." >&2
    exit 1
fi

export XDG_DATA_HOME="$data" XDG_CONFIG_HOME="$scratch/config" \
    XDG_STATE_HOME="$scratch/state" XDG_CACHE_HOME="$scratch/cache" \
    DCONF_PROFILE="$scratch/dconf-profile"
unset GSETTINGS_BACKEND
# The devkit viewer is a client of your compositor. A forced backend such as
# GDK_BACKEND=x11 stops the viewer, and the nested shell exits at once.
unset GDK_BACKEND

cat <<EOF
Token Grill runs in the nested window. To stop, close the window.
When it stops, this script deletes $scratch, with the test keyring and
settings. Save a diagnostics report to a folder outside it.
EOF
dbus-run-session --config-file="$scratch/session.conf" -- bash "${BASH_SOURCE[0]}" --in-session
