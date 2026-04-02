# mac-heartbeat

A lightweight in-terminal Mac performance heartbeat monitor for local machines.

It logs one-line snapshots every 30 seconds and tracks short incident history (also exposes a local dashboard if you want)

## What It Monitors

- CPU load
- Memory pressure and swap usage
- Disk usage
- Event-loop lag (responsiveness)
- Top memory-hungry processes

The console output is compact and human-readable:

- Starts with `❤ | Level ...`
- Includes trend arrows (`↑`, `↓`, `→`)
- Adds compact `Reason`/`Cause` only when status is not OK

## Requirements

- macOS
- Node.js 18+ (recommended)
- npm
- PM2 (optional, but recommended for always-on running)

## Install

```bash
npm install
```

## Run

```bash
node heartbeat.js
```

To use private local overrides, create a `.env.local` file first:

```bash
cp .env.example .env.local
```

## Run With PM2

Start:

```bash
pm2 start heartbeat.js --name heartbeat
```

`pm2 start` keeps the monitor running in the background.

See what is currently running:

```bash
pm2 list
```

**Main way to interact day-to-day (watch heartbeat output):**

```bash
pm2 logs heartbeat
or pm2 logs heartbeat --lines 20 to see prev lines before stream
```


Restart:

```bash
pm2 restart heartbeat
```


## Local Dashboard (optional)

When running, open:

- [http://127.0.0.1:7071](http://127.0.0.1:7071)

Useful endpoints:

- `/api/status` (JSON status/history)
- `/health` (basic health check)

## Log Files

Runtime files are local-only and should not be committed:

- `log.txt`
- `incidents.jsonl`

`log.txt` is auto-capped by the script using `maxLogBytes` in `heartbeat.js` (currently `2 * 1024 * 1024`, about 2 MB). When it exceeds that size, it resets automatically.

If you prefer 1 MB, set:

```js
maxLogBytes: 1 * 1024 * 1024
```

## What The Score Means

The `Score` is a simple 0-100 stress score that estimates how "slow" or overloaded the machine looks.

Lower is better. Higher means the machine looks more stressed.

It is based on a weighted mix of:

- CPU load
- Memory pressure
- Swap usage
- Disk usage
- Event-loop lag (responsiveness)

The current weighting is:

- CPU: 20%
- Memory pressure: 42%
- Swap: 18%
- Disk: 5%
- Lag: 15%

Each metric is compared against a threshold in `heartbeat.js`, then combined into one score.

On macOS, the `Pressure` value now comes from the native `memory_pressure -Q` tool, which tracks system-wide free-memory pressure more closely than simple RAM occupancy. If that command is unavailable, the app falls back to the older `used vs available RAM` estimate.

The score now also leans harder on memory pressure and less on background metrics like disk fullness, so a higher-capacity Mac should look meaningfully healthier under the same light workload. Swap thresholding scales with installed RAM, capped at `12 GB`, so bigger-memory machines do not get over-penalized for small amounts of swap.

To avoid false positives, very low-level background activity is treated as noise before it starts contributing to the score.

Current thresholds:

- Pressure: `60%`
- Swap: `5 GB`
- CPU: `85%`
- Disk: `90%`
- Lag: `120 ms`

Levels are:

- `OK` under `60`
- `WARN` from `60` to `79`
- `CRITICAL` at `80+`

Shared defaults live near the top of `heartbeat.js`, but you usually should not edit them for personal tuning.

For local-only customization, put overrides in `.env.local` instead. That file is ignored by git, so your personal settings will not affect the repo.

Example:

```env
HEARTBEAT_PRESSURE_PERCENT=70
HEARTBEAT_SWAP_GB=8
HEARTBEAT_CPU_PERCENT=90
HEARTBEAT_DISK_PERCENT=92
HEARTBEAT_LAG_MS=150
```

Most people will only need these local overrides:

- `HEARTBEAT_PRESSURE_PERCENT`
- `HEARTBEAT_SWAP_GB`
- `HEARTBEAT_CPU_PERCENT`
- `HEARTBEAT_DISK_PERCENT`
- `HEARTBEAT_LAG_MS`
- `HEARTBEAT_SLOW_SCORE_WARN`
- `HEARTBEAT_SLOW_SCORE_CRITICAL`

Additional optional overrides are also supported for advanced tuning, including interval, log size, alert cooldown, dashboard port, history limits, and sustain-cycle settings.

If you want to change how much each metric affects the score, edit the `weights` block near the top of `heartbeat.js`, or override them locally with:

```env
HEARTBEAT_WEIGHT_PRESSURE=0.42
HEARTBEAT_WEIGHT_SWAP=0.18
HEARTBEAT_WEIGHT_CPU=0.20
HEARTBEAT_WEIGHT_DISK=0.05
HEARTBEAT_WEIGHT_LAG=0.15
```

Advanced users can also adjust the low-end noise floors:

```env
HEARTBEAT_FLOOR_PRESSURE=0.25
HEARTBEAT_FLOOR_SWAP=0.10
HEARTBEAT_FLOOR_CPU=0.20
HEARTBEAT_FLOOR_DISK=0.50
HEARTBEAT_FLOOR_LAG=0.25
```

## Alerts

On sustained WARN/CRITICAL conditions, the script triggers a macOS dialog via `osascript`.

## How Friends Can Help

- Test on their own Mac and share threshold/false-positive feedback
- Suggest better score weighting for your real workload
- Improve dashboard UX and incident summaries
- Add tests or small quality-of-life improvements

## Safety Before Making Public

Before switching the GitHub repo visibility to public, confirm:

- No secrets/tokens/passwords are committed
- `.env` or local config files are ignored
- Runtime output files remain ignored
