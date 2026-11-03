#!/bin/sh
# Start a virtual screen, then the server with Chrome shown on it (headed = a normal Chrome).
# (xvfb-run hangs when it is the container's first process, so do it by hand.)
set -e
Xvfb :99 -screen 0 1920x1200x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.3; done
exec node browser/server.mjs
