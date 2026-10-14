#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ $(uname -s) != Linux || $(uname -m) != aarch64 ]]; then
    printf '%s\n' 'Use 64-bit Raspberry Pi OS on the Pi (aarch64).'
    exit 1
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Python 3.12+ required; use current Raspberry Pi OS 64-bit (Trixie).")'
if [[ "$PWD" != "$HOME/senssun-scale-prototype/raspberry-pi" ]]; then
    printf '%s\n' 'Clone into ~/senssun-scale-prototype so the supplied user service has the correct paths.'
    exit 1
fi
umask 077
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python test_sync.py -v
mkdir -p "$HOME/.config/senssun-sync" "$HOME/.local/state/senssun-sync" "$HOME/.config/systemd/user"
chmod 700 "$HOME/.config/senssun-sync" "$HOME/.local/state/senssun-sync"
if [[ ! -e "$HOME/.config/senssun-sync/config.toml" ]]; then
    install -m 600 config.example.toml "$HOME/.config/senssun-sync/config.toml"
fi
install -m 644 senssun-sync.service "$HOME/.config/systemd/user/senssun-sync.service"
systemctl --user daemon-reload
printf '%s\n' 'Setup complete. Service is NOT started.' \
    'Follow README.md: scan, set the MAC address, verify a dry-run reading, login, then enable live syncing.'