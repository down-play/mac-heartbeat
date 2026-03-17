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
