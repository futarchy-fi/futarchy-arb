#!/usr/bin/env bash
# Alerts the Fleet - Status group when the NVDA arb bot's unit is not active or its heartbeat is stale.
# At most one alert per hour; the stamp is cleared as soon as the bot is healthy again.
set -u
UNIT=${UNIT:-nvda-robinhood-arb-bot.service}
HB=${HEARTBEAT_FILE:-$HOME/shared/nvda-robinhood-arb-heartbeat.json}
MAX_AGE=${MAX_AGE_SECONDS:-300}
STAMP=${STAMP_FILE:-$HOME/.cache/nvda-robinhood-arb-watch.last-alert}
ALERT=${ALERT_CMD:-$HOME/.local/bin/general-status-send}

problem=""
if ! systemctl --user is-active --quiet "$UNIT"; then
  problem="unit $UNIT is not active"
elif [ ! -f "$HB" ]; then
  problem="no heartbeat file at $HB"
else
  age=$(( $(date +%s) - $(stat -c %Y "$HB") ))
  if [ "$age" -gt "$MAX_AGE" ]; then problem="heartbeat is ${age}s old (limit ${MAX_AGE}s)"; fi
fi

if [ -z "$problem" ]; then
  rm -f "$STAMP"
  exit 0
fi

if [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -lt 3600 ]; then
  exit 0
fi
mkdir -p "$(dirname "$STAMP")"
touch "$STAMP"
echo "$(date -u +%FT%TZ) ALERT $problem"
"$ALERT" --source nvda-robinhood-arb "NVDA arb bot (Robinhood Chain) on $(hostname): $problem. Check: journalctl --user -u $UNIT -n 50"
