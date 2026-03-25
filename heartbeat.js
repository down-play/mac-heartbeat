const si = require('systeminformation');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const http = require('http');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

function getEnvNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

const baseConfig = {
    intervalMs: 30_000,
    logPath: 'log.txt',
    incidentLogPath: 'incidents.jsonl',
    maxLogBytes: 2 * 1024 * 1024,
    topAppsCount: 3,
    alertCooldownMs: 10 * 60 * 1000,
    dashboardPort: 7071,
    dashboardHost: '127.0.0.1',
    historyLimit: 120,
    incidentLimit: 30,
    slowScore: {
        warn: 60,
        critical: 80
    },
    lagThresholdMs: 120,
    sustainCycles: {
        warn: 2,
        critical: 2
    },
    thresholds: {
        pressurePercent: 60,
        swapGb: 5.0,
        cpuPercent: 85,
        diskPercent: 90,
        lagMs: 120
    }
};

const config = {
    ...baseConfig,
    intervalMs: getEnvNumber('HEARTBEAT_INTERVAL_MS', baseConfig.intervalMs),
    maxLogBytes: getEnvNumber('HEARTBEAT_MAX_LOG_BYTES', baseConfig.maxLogBytes),
    topAppsCount: getEnvNumber('HEARTBEAT_TOP_APPS_COUNT', baseConfig.topAppsCount),
    alertCooldownMs: getEnvNumber('HEARTBEAT_ALERT_COOLDOWN_MS', baseConfig.alertCooldownMs),
    dashboardPort: getEnvNumber('HEARTBEAT_DASHBOARD_PORT', baseConfig.dashboardPort),
    historyLimit: getEnvNumber('HEARTBEAT_HISTORY_LIMIT', baseConfig.historyLimit),
    incidentLimit: getEnvNumber('HEARTBEAT_INCIDENT_LIMIT', baseConfig.incidentLimit),
    lagThresholdMs: getEnvNumber('HEARTBEAT_LAG_THRESHOLD_MS', baseConfig.lagThresholdMs),
    slowScore: {
        warn: getEnvNumber('HEARTBEAT_SLOW_SCORE_WARN', baseConfig.slowScore.warn),
        critical: getEnvNumber('HEARTBEAT_SLOW_SCORE_CRITICAL', baseConfig.slowScore.critical)
    },
    sustainCycles: {
        warn: getEnvNumber('HEARTBEAT_SUSTAIN_CYCLES_WARN', baseConfig.sustainCycles.warn),
        critical: getEnvNumber('HEARTBEAT_SUSTAIN_CYCLES_CRITICAL', baseConfig.sustainCycles.critical)
    },
    thresholds: {
        pressurePercent: getEnvNumber('HEARTBEAT_PRESSURE_PERCENT', baseConfig.thresholds.pressurePercent),
        swapGb: getEnvNumber('HEARTBEAT_SWAP_GB', baseConfig.thresholds.swapGb),
        cpuPercent: getEnvNumber('HEARTBEAT_CPU_PERCENT', baseConfig.thresholds.cpuPercent),
        diskPercent: getEnvNumber('HEARTBEAT_DISK_PERCENT', baseConfig.thresholds.diskPercent),
        lagMs: getEnvNumber('HEARTBEAT_LAG_MS', baseConfig.thresholds.lagMs)
    }
};

let isRunning = false;
let lastAlertAt = 0;
let lastAlertSignature = '';
let previousLevel = 'ok';
let slowStreak = 0;
let criticalStreak = 0;
let latestSnapshot = null;
const metricHistory = [];
const incidentHistory = [];
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function toGB(bytes) {
    return bytes / 1024 / 1024 / 1024;
}

function normalizeMemRssToMB(memRss) {
    // systeminformation can report memRss in bytes or KB depending on platform.
    // Infer unit by magnitude to keep values realistic across macOS/Linux variants.
    if (memRss > 10 * 1024 * 1024) return memRss / 1024 / 1024; // bytes -> MB
    return memRss / 1024; // KB -> MB
}

function formatTopApps(list, count) {
    if (!Array.isArray(list) || list.length === 0) return 'unavailable';
    return list
        .sort((a, b) => b.memRss - a.memRss)
        .slice(0, count)
        .map((p) => `${p.name} (${normalizeMemRssToMB(p.memRss).toFixed(0)}MB)`)
        .join(', ');
}

async function safeGet(metricName, getter, fallbackValue) {
    try {
        return await getter();
    } catch (error) {
        console.error(`[${metricName}] unavailable:`, error.message);
        return fallbackValue;
    }
}

function percentOfThreshold(value, threshold) {
    if (!threshold) return 0;
    return Math.min(100, (value / threshold) * 100);
}

function getLagMetrics() {
    const meanMs = Number(loopDelay.mean) / 1e6;
    const maxMs = Number(loopDelay.max) / 1e6;
    loopDelay.reset();
    return {
        meanMs: Number.isFinite(meanMs) ? meanMs : 0,
        maxMs: Number.isFinite(maxMs) ? maxMs : 0
    };
}

function computeSlowScore({ pressurePercent, swapGb, cpuPercent, diskPercent, lagMs }) {
    const pressureScore = percentOfThreshold(pressurePercent, config.thresholds.pressurePercent);
    const swapScore = percentOfThreshold(swapGb, config.thresholds.swapGb);
    const cpuScore = percentOfThreshold(cpuPercent, config.thresholds.cpuPercent);
    const diskScore = percentOfThreshold(diskPercent, config.thresholds.diskPercent);
    const lagScore = percentOfThreshold(lagMs, config.thresholds.lagMs);

    const weighted =
        pressureScore * 0.28 +
        swapScore * 0.17 +
        cpuScore * 0.30 +
        diskScore * 0.10 +
        lagScore * 0.15;
    return Math.round(weighted);
}

function getLevel(score) {
    if (score >= config.slowScore.critical) return 'critical';
    if (score >= config.slowScore.warn) return 'warn';
    return 'ok';
}

function getPulse(level) {
    if (level === 'critical') return '❤';
    if (level === 'warn') return '❤';
    return '❤';
}

function trendArrow(current, previous, epsilon = 0.3) {
    if (typeof previous !== 'number') return '→';
    const delta = current - previous;
    if (Math.abs(delta) <= epsilon) return '→';
    return delta > 0 ? '↑' : '↓';
}

function compactReasonTag(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return '';
    const tags = [];
    if (reasons.some((r) => r.startsWith('pressure '))) tags.push('pressure');
    if (reasons.some((r) => r.startsWith('swap '))) tags.push('swap');
    if (reasons.some((r) => r.startsWith('cpu '))) tags.push('cpu');
    if (reasons.some((r) => r.startsWith('disk '))) tags.push('disk');
    if (reasons.some((r) => r.startsWith('event-loop lag '))) tags.push('lag');
    return tags.join('+');
}

function formatBatteryStatus(snapshot) {
    if (typeof snapshot.batteryPercent !== 'number') return 'BAT -';
    const charging = snapshot.batteryCharging ? ' ϟ' : '';
    return `BAT ${snapshot.batteryPercent.toFixed(0)}%${charging}`;
}

function parseWifiPercent(rssi) {
    if (typeof rssi !== 'number' || Number.isNaN(rssi)) return null;
    const clamped = Math.max(-90, Math.min(-30, rssi));
    return Math.round(((clamped + 90) / 60) * 100);
}

function getWifiQualityLabel(rssi) {
    if (typeof rssi !== 'number' || Number.isNaN(rssi)) return null;
    if (rssi >= -55) return 'Strong';
    if (rssi >= -67) return 'Good';
    if (rssi >= -75) return 'Fair';
    return 'Weak';
}

function execFileText(file, args, options = {}) {
    return new Promise((resolve) => {
        execFile(file, args, options, (error, stdout) => {
            if (error) {
                resolve('');
                return;
            }
            resolve(stdout || '');
        });
    });
}

function parseAirportWifiStatus(output) {
    if (!output) return null;
    const stateMatch = output.match(/^\s*state:\s*(.+)$/m);
    const rssiMatch = output.match(/^\s*agrCtlRSSI:\s*(-?\d+)\s*$/m);
    const state = stateMatch ? stateMatch[1].trim().toLowerCase() : '';
    if (state === 'running' && rssiMatch) {
        const rssi = Number(rssiMatch[1]);
        return { state: 'connected', percent: parseWifiPercent(rssi), quality: getWifiQualityLabel(rssi) };
    }
    return null;
}

function parseSystemProfilerWifiStatus(output) {
    if (!output) return null;
    const connected = /Status:\s*Connected/i.test(output);
    const signalMatch = output.match(/Signal \/ Noise:\s*(-?\d+)\s*dBm/i);
    if (connected && signalMatch) {
        const rssi = Number(signalMatch[1]);
        return { state: 'connected', percent: parseWifiPercent(rssi), quality: getWifiQualityLabel(rssi) };
    }
    if (/Status:\s*Off/i.test(output)) {
        return { state: 'off', percent: null, quality: null };
    }
    return null;
}

async function getWifiStatus() {
    const airportPath = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
    const airportOutput = await execFileText(airportPath, ['-I'], { timeout: 2_000 });
    const airportStatus = parseAirportWifiStatus(airportOutput);
    if (airportStatus) return airportStatus;

    const profilerOutput = await execFileText('system_profiler', ['SPAirPortDataType'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    const profilerStatus = parseSystemProfilerWifiStatus(profilerOutput);
    if (profilerStatus) return profilerStatus;

    return { state: 'off', percent: null, quality: null };
}

function formatUptime(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
    const totalMinutes = Math.floor(seconds / 60);
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `Up ${days}d ${hours}h`;
    if (hours > 0) return `Up ${hours}h ${minutes}m`;
    return `Up ${minutes}m`;
}

function formatMachineStatusLine(snapshot) {
    const parts = [];
    const batteryLabel = formatBatteryStatus(snapshot);
    if (batteryLabel !== 'BAT -') parts.push(batteryLabel);
    const uptimeLabel = formatUptime(snapshot.uptimeSeconds);
    if (uptimeLabel) parts.push(uptimeLabel);
    if (snapshot.wifiState === 'connected' && snapshot.wifiQuality) {
        parts.push(`Wi-Fi ${snapshot.wifiQuality}`);
    } else {
        parts.push('Wi-Fi off');
    }
    return `│ ${parts.join('   ')}`;
}

function formatConsoleHeartbeat(snapshot, previousSnapshot) {
    const pulse = getPulse(snapshot.level);
    const cpuTrend = trendArrow(snapshot.cpuPercent, previousSnapshot?.cpuPercent, 0.5);
    const pressureTrend = trendArrow(snapshot.pressurePercent, previousSnapshot?.pressurePercent, 0.5);
    const lagTrend = trendArrow(snapshot.lagMs, previousSnapshot?.lagMs, 1);
    const freeTrend = trendArrow(snapshot.freeGb, previousSnapshot?.freeGb, 0.03);
    const swapTrend = trendArrow(snapshot.swapGb, previousSnapshot?.swapGb, 0.03);
    const reasonTag = snapshot.level === 'ok' ? '' : compactReasonTag(snapshot.reasons);
    const timestamp = new Date(snapshot.timestamp).toLocaleTimeString();
    const datestamp = new Date(snapshot.timestamp).toLocaleDateString();
    const header = `┌ ${pulse} ${snapshot.level.toUpperCase()}  Score ${snapshot.slowScore}  @${timestamp} ${datestamp}`;
    const loadLine = `│ CPU ${snapshot.cpuPercent.toFixed(0)}% ${cpuTrend}   Pressure ${snapshot.pressurePercent.toFixed(0)}% ${pressureTrend}   Disk ${snapshot.diskPercent.toFixed(0)}%`;
    const resourceLine = `│ Free ${snapshot.freeGb.toFixed(2)}GB ${freeTrend}   Swap ${snapshot.swapGb.toFixed(2)}GB ${swapTrend}   Lag ${snapshot.lagMs.toFixed(0)}ms ${lagTrend}`;
    const envLine = formatMachineStatusLine(snapshot);
    const contextParts = [`Hogs ${snapshot.topApps}`];
    if (reasonTag) contextParts.push(`Reason ${reasonTag}`);
    if (snapshot.level !== 'ok') contextParts.push(snapshot.interpretation.cause);
    const hogsLine = `└ ${contextParts.join('   |   ')}`;
    return [header, loadLine, resourceLine, envLine, hogsLine, '┆'].join('\n');
}

function buildAlertReasons({ pressurePercent, swapGb, cpuPercent, diskPercent, lagMs }) {
    const reasons = [];
    if (pressurePercent >= config.thresholds.pressurePercent) reasons.push(`pressure ${pressurePercent}%`);
    if (swapGb >= config.thresholds.swapGb) reasons.push(`swap ${swapGb.toFixed(2)}GB`);
    if (cpuPercent >= config.thresholds.cpuPercent) reasons.push(`cpu ${cpuPercent.toFixed(0)}%`);
    if (diskPercent >= config.thresholds.diskPercent) reasons.push(`disk ${diskPercent.toFixed(0)}%`);
    if (lagMs >= config.thresholds.lagMs) reasons.push(`event-loop lag ${lagMs.toFixed(0)}ms`);
    return reasons;
}

function interpretSituation({ level, pressurePercent, swapGb, cpuPercent, diskPercent, lagMs }) {
    if (level === 'ok') {
        return {
            cause: 'System operating normally',
            action: 'No action needed.'
        };
    }
    if (swapGb >= config.thresholds.swapGb && pressurePercent >= config.thresholds.pressurePercent) {
        return {
            cause: 'Memory bottleneck likely',
            action: 'Close high-memory apps and reduce parallel tabs/processes.'
        };
    }
    if (cpuPercent >= config.thresholds.cpuPercent && pressurePercent < config.thresholds.pressurePercent) {
        return {
            cause: 'CPU-bound workload likely',
            action: 'Check top CPU processes and stop/defer heavy tasks.'
        };
    }
    if (diskPercent >= config.thresholds.diskPercent || lagMs >= config.thresholds.lagMs) {
        return {
            cause: 'I/O or responsiveness bottleneck likely',
            action: 'Free disk space and reduce concurrent disk-heavy activity.'
        };
    }
    return {
        cause: 'General system stress detected',
        action: 'Inspect top apps and run fewer heavy tasks at once.'
    };
}

function pushBounded(list, item, limit) {
    list.push(item);
    if (list.length > limit) list.shift();
}

async function appendIncident(incident) {
    pushBounded(incidentHistory, incident, config.incidentLimit);
    await fsp.appendFile(config.incidentLogPath, `${JSON.stringify(incident)}\n`);
}

function shouldAlert(level, reasons) {
    if (level === 'ok') return false;
    if (reasons.length === 0) return false;
    const now = Date.now();
    const signature = `${level}|${reasons.join('|')}`;
    const cooldownExpired = now - lastAlertAt >= config.alertCooldownMs;
    const reasonChanged = signature !== lastAlertSignature;
    if (cooldownExpired || reasonChanged) {
        lastAlertAt = now;
        lastAlertSignature = signature;
        return true;
    }
    return false;
}

function sendAlert(message) {
    const script = `const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayDialog(${JSON.stringify(message)}, { withTitle: "Mac Performance Alert" });`;
    execFile('osascript', ['-l', 'JavaScript', '-e', script], (error) => {
        if (error) console.error('Alert error:', error.message);
    });
}

async function rotateLogIfNeeded(timestamp) {
    try {
        const stats = await fsp.stat(config.logPath);
        if (stats.size > config.maxLogBytes) {
            await fsp.writeFile(config.logPath, `--- Log Reset (Auto-Clean) at ${timestamp} ---\n`);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function logSystemHealth() {
    if (isRunning) return;
    isRunning = true;
    try {
        const [mem, procs, load, disks, battery, cpuTemp, wifiStatus] = await Promise.all([
            safeGet('mem', () => si.mem(), { available: 0, swapused: 0, active: 0, total: 1 }),
            safeGet('processes', () => si.processes(), { list: [] }),
            safeGet('cpu', () => si.currentLoad(), { currentLoad: 0 }),
            safeGet('disk', () => si.fsSize(), []),
            safeGet('battery', () => si.battery(), { hasbattery: false, percent: null, ischarging: false, acconnected: false }),
            safeGet('cpuTemperature', () => si.cpuTemperature(), { main: null, max: null }),
            safeGet('wifi', () => getWifiStatus(), { state: 'off', percent: null, quality: null })
        ]);
        const timestamp = new Date().toLocaleString();

        const freeGb = toGB(mem.available);
        const swapGb = toGB(mem.swapused);
        const pressurePercent = ((mem.total - mem.available) / Math.max(mem.total, 1)) * 100;
        const cpuPercent = load.currentLoad;
        const rootDisk = disks.find((d) => d.mount === '/') || disks[0];
        const diskPercent = rootDisk ? rootDisk.use : 0;
        const lag = getLagMetrics();
        const lagMs = Math.max(lag.meanMs, lag.maxMs);
        const slowScore = computeSlowScore({ pressurePercent, swapGb, cpuPercent, diskPercent, lagMs });
        const level = getLevel(slowScore);
        const previousSnapshot = latestSnapshot;

        const topApps = formatTopApps(procs.list, config.topAppsCount);
        const reasons = buildAlertReasons({ pressurePercent, swapGb, cpuPercent, diskPercent, lagMs });
        const interpretation = interpretSituation({ level, pressurePercent, swapGb, cpuPercent, diskPercent, lagMs });
        const snapshot = {
            timestamp: new Date().toISOString(),
            pressurePercent: Number(pressurePercent.toFixed(1)),
            cpuPercent: Number(cpuPercent.toFixed(1)),
            diskPercent: Number(diskPercent.toFixed(1)),
            freeGb: Number(freeGb.toFixed(2)),
            swapGb: Number(swapGb.toFixed(2)),
            lagMs: Number(lagMs.toFixed(1)),
            batteryPercent: typeof battery.percent === 'number' ? Number(battery.percent.toFixed(0)) : null,
            batteryCharging: Boolean(battery.ischarging || battery.acconnected),
            cpuTempC: typeof cpuTemp.main === 'number' ? Number(cpuTemp.main.toFixed(1)) : null,
            uptimeSeconds: os.uptime(),
            wifiState: wifiStatus.state,
            wifiPercent: typeof wifiStatus.percent === 'number' ? wifiStatus.percent : null,
            wifiQuality: wifiStatus.quality || null,
            slowScore,
            level,
            topApps,
            reasons,
            interpretation
        };
        latestSnapshot = snapshot;
        pushBounded(metricHistory, snapshot, config.historyLimit);

        const batteryLogPart =
            typeof snapshot.batteryPercent === 'number'
                ? ` | Battery: ${snapshot.batteryPercent.toFixed(0)}%${snapshot.batteryCharging ? '⚡' : ''}`
                : '';
        const tempLogPart =
            typeof snapshot.cpuTempC === 'number'
                ? ` | Temp: ${(((snapshot.cpuTempC * 9) / 5) + 32).toFixed(0)}F`
                : '';
        const logMessage = `[${timestamp}] Level: ${level.toUpperCase()} | Score: ${slowScore} | Pressure: ${pressurePercent.toFixed(0)}% | CPU: ${cpuPercent.toFixed(0)}% | Disk: ${diskPercent.toFixed(0)}% | Lag: ${lagMs.toFixed(0)}ms | Free: ${freeGb.toFixed(2)}GB | Swap: ${snapshot.swapGb.toFixed(2)}GB${batteryLogPart}${tempLogPart} | Hogs: ${topApps} | Cause: ${interpretation.cause}\n`;
        const consoleMessage = formatConsoleHeartbeat(snapshot, previousSnapshot);

        await rotateLogIfNeeded(timestamp);
        await fsp.appendFile(config.logPath, logMessage);
        console.log(`${consoleMessage}\n`);

        slowStreak = level === 'ok' ? 0 : slowStreak + 1;
        criticalStreak = level === 'critical' ? criticalStreak + 1 : 0;

        if (level === 'ok' && previousLevel !== 'ok') {
            await appendIncident({
                timestamp: snapshot.timestamp,
                level: 'recovered',
                summary: 'System returned to normal',
                snapshot
            });
        }

        const sustained =
            (level === 'warn' && slowStreak >= config.sustainCycles.warn) ||
            (level === 'critical' && criticalStreak >= config.sustainCycles.critical);

        if (sustained && shouldAlert(level, reasons)) {
            const body = `${level.toUpperCase()} | ${reasons.join(' | ')}\n${interpretation.cause}\nAction: ${interpretation.action}`;
            sendAlert(body);
            await appendIncident({
                timestamp: snapshot.timestamp,
                level,
                reasons,
                interpretation,
                summary: `${level.toUpperCase()} slow condition`,
                snapshot
            });
        }
        previousLevel = level;
    } catch (e) {
        console.error('Monitoring Error:', e);
    } finally {
        isRunning = false;
    }
}

function json(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function dashboardHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Heartbeat Informant</title>
  <style>
    :root {
      --bg: #f5f2eb;
      --card: #fffaf2;
      --ink: #132a13;
      --accent: #2d6a4f;
      --warn: #b26b00;
      --critical: #a4161a;
      --ok: #1b4332;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-rounded, "Avenir Next", "Trebuchet MS", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 10% 10%, #d8f3dc 0, transparent 35%),
        radial-gradient(circle at 90% 20%, #ffe8cc 0, transparent 30%),
        var(--bg);
    }
    .wrap { max-width: 980px; margin: 24px auto; padding: 0 16px; }
    .head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    h1 { margin: 0; letter-spacing: 0.5px; }
    .sub { opacity: 0.75; font-size: 0.95rem; }
    .grid { margin-top: 14px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .card {
      background: var(--card);
      border: 1px solid #dad7cd;
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.05);
    }
    .k { font-size: 0.82rem; opacity: 0.75; text-transform: uppercase; }
    .v { font-size: 1.55rem; font-weight: 700; margin-top: 4px; }
    .state-ok { color: var(--ok); }
    .state-warn { color: var(--warn); }
    .state-critical { color: var(--critical); }
    .panel { margin-top: 16px; }
    ul { margin: 0; padding-left: 20px; }
    .item { padding: 10px 0; border-bottom: 1px solid #e9ecef; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>Heartbeat Informant</h1>
      <div class="sub" id="updated">Waiting for data...</div>
    </div>
    <div class="grid">
      <div class="card"><div class="k">Level</div><div class="v" id="level">-</div></div>
      <div class="card"><div class="k">Slow Score</div><div class="v" id="score">-</div></div>
      <div class="card"><div class="k">CPU</div><div class="v" id="cpu">-</div></div>
      <div class="card"><div class="k">Pressure</div><div class="v" id="pressure">-</div></div>
      <div class="card"><div class="k">Swap</div><div class="v" id="swap">-</div></div>
      <div class="card"><div class="k">Lag</div><div class="v" id="lag">-</div></div>
    </div>
    <div class="card panel">
      <div class="k">Interpretation</div>
      <div class="v" style="font-size:1.1rem" id="cause">-</div>
      <div id="action" style="margin-top:8px"></div>
      <div class="mono" id="hogs" style="margin-top:8px; font-size:0.9rem;"></div>
    </div>
    <div class="card panel">
      <div class="k">Recent Incidents</div>
      <ul id="incidents"></ul>
    </div>
  </div>
  <script>
    function fmtLevel(level) {
      const map = { ok: "OK", warn: "WARN", critical: "CRITICAL" };
      return map[level] || level || "-";
    }
    function cls(level) {
      return level ? "state-" + level : "";
    }
    async function refresh() {
      const res = await fetch('/api/status');
      const data = await res.json();
      const s = data.latestSnapshot;
      if (!s) return;
      document.getElementById('updated').textContent = "Updated: " + new Date(s.timestamp).toLocaleString();
      const levelEl = document.getElementById('level');
      levelEl.textContent = fmtLevel(s.level);
      levelEl.className = "v " + cls(s.level);
      document.getElementById('score').textContent = s.slowScore;
      document.getElementById('cpu').textContent = s.cpuPercent.toFixed(0) + "%";
      document.getElementById('pressure').textContent = s.pressurePercent.toFixed(0) + "%";
      document.getElementById('swap').textContent = s.swapGb.toFixed(2) + "GB";
      document.getElementById('lag').textContent = s.lagMs.toFixed(0) + "ms";
      document.getElementById('cause').textContent = s.interpretation.cause;
      document.getElementById('action').textContent = "Action: " + s.interpretation.action;
      document.getElementById('hogs').textContent = "Top hogs: " + s.topApps;
      const inc = document.getElementById('incidents');
      inc.innerHTML = "";
      data.incidents.slice().reverse().forEach((item) => {
        const li = document.createElement('li');
        li.className = 'item';
        li.textContent = "[" + new Date(item.timestamp).toLocaleTimeString() + "] " + (item.summary || item.level);
        inc.appendChild(li);
      });
    }
    refresh().catch(() => {});
    setInterval(() => refresh().catch(() => {}), 4000);
  </script>
</body>
</html>`;
}

function startDashboard() {
    const server = http.createServer((req, res) => {
        if (req.url === '/api/status') {
            return json(res, 200, {
                latestSnapshot,
                incidents: incidentHistory,
                history: metricHistory
            });
        }
        if (req.url === '/health') {
            return json(res, 200, { ok: true, updatedAt: latestSnapshot ? latestSnapshot.timestamp : null });
        }
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(dashboardHtml());
            return;
        }
        json(res, 404, { error: 'Not found' });
    });

    server.on('error', (error) => {
        console.error(`Dashboard disabled: ${error.message}`);
    });

    server.listen(config.dashboardPort, config.dashboardHost, () => {
        console.log(`Dashboard running at http://${config.dashboardHost}:${config.dashboardPort}`);
    });
}

function start() {
    startDashboard();
    logSystemHealth();
    setInterval(logSystemHealth, config.intervalMs);
}

process.on('SIGINT', () => {
    console.log('\nStopping monitor.');
    process.exit(0);
});

start();
