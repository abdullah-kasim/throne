#!/usr/bin/env bash
set -euo pipefail

selector="$1"
steps="${2:-24}"

agent-browser scrollintoview "$selector" >/dev/null
agent-browser wait 400 >/dev/null
read -r target_x target_y < <(agent-browser eval "(()=>{const r=document.querySelector($(printf '%s' "$selector" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')).getBoundingClientRect();return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)})()" | tr -d '"')
read -r start_x start_y < <(agent-browser eval "Math.round(innerWidth/2)+' '+Math.round(innerHeight/2)" | tr -d '"')

for ((i = 1; i <= steps; i++)); do
    t=$(python3 -c "import math; t=$i/$steps; print(1-math.pow(1-t,3))")
    x=$(python3 -c "print(round($start_x+($target_x-$start_x)*$t))")
    y=$(python3 -c "print(round($start_y+($target_y-$start_y)*$t))")
    agent-browser mouse move "$x" "$y" >/dev/null
done
echo "$target_x $target_y"
