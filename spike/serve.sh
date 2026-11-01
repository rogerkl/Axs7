#!/bin/sh
# Serves the test page on all interfaces, so a Windows browser reaches it when this runs in WSL.
# Works from any directory: ./spike/serve.sh [port]
#
# Open it as http://localhost:<port>. Web MIDI only exists on a secure origin (localhost or https), so the page
# also loads from the WSL IP, but without MIDI.
port="${1:-8000}"
dir="$(cd "$(dirname "$0")" && pwd)"
ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Open http://localhost:$port in Chrome or Edge (on Windows too, WSL forwards localhost)."
if [ -n "$ip" ]; then
  echo "http://$ip:$port loads the page as well, but without Web MIDI: it's not a secure origin."
fi
exec python3 -m http.server "$port" --bind 0.0.0.0 --directory "$dir"
