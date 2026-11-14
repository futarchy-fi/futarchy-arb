#!/usr/bin/env bash
# Alerts the Fleet - Status group when an arb bot's unit is not active or its heartbeat is stale.
# Defaults are for the NVDA two-outcome bot; set UNIT, HEARTBEAT_FILE, STAMP_FILE, BOT_NAME, LOG_FILE for another.
# At most one alert per hour; the stamp is cleared as soon as the bot is healthy again.
set -u
UNIT=${UNIT:-nvda-robinhood-arb-bot.service}
HB=${HEARTBEAT_FILE:-$HOME/shared/nvda-robinhood-arb-heartbeat.json}
MAX_AGE=${MAX_AGE_SECONDS:-300}
STAMP=${STAMP_FILE:-$HOME/.cache/nvda-robinhood-arb-watch.last-alert}
ALERT=${ALERT_CMD:-$HOME/.local/bin/general-status-send}
NAME=${BOT_NAME:-NVDA arb bot (Robinhood Chain)}
LOG=${LOG_FILE:-$HOME/data/arb-logs/nvda-robinhood-arb-bot.log}

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
"$ALERT" --source "${ALERT_SOURCE:-nvda-robinhood-arb}" "$NAME on $(hostname): $problem. Check: tail -50 $LOG"
