import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const execAsync = promisify(exec);

const RUNTIME_DIR = join(process.cwd(), "runtime");
const SYSTEM_MONITOR_CACHE_FILE = join(RUNTIME_DIR, "system-monitor-cache.json");

const SYSTEM_MONITOR_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface CpuInfo {
  model: string;
  cores: number;
  usage: number;
}

interface MemoryInfo {
  total: number;
  used: number;
  free: number;
  usagePercent: number;
}

interface DiskInfo {
  total: number;
  used: number;
  free: number;
  usagePercent: number;
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  command: string;
}

interface SystemMonitorData {
  hostname: string;
  uptime: number;
  loadAverage: number[];
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  processes: ProcessInfo[];
  fetchedAt: string;
}

interface CacheEntry {
  data: SystemMonitorData;
  fetchedAt: number;
}

let cachedData: CacheEntry | undefined;
let monitorInterval: NodeJS.Timeout | undefined;

async function ensureRuntimeDir(): Promise<void> {
  try {
    await mkdir(RUNTIME_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function getCachedData(): Promise<SystemMonitorData | null> {
  const now = Date.now();
  if (cachedData && now - cachedData.fetchedAt < SYSTEM_MONITOR_INTERVAL_MS) {
    return cachedData.data;
  }

  try {
    const content = await readFile(SYSTEM_MONITOR_CACHE_FILE, "utf-8");
    const entry: CacheEntry = JSON.parse(content);
    if (now - entry.fetchedAt < SYSTEM_MONITOR_INTERVAL_MS) {
      cachedData = entry;
      return cachedData.data;
    }
  } catch {
    // No cache file or expired, will fetch fresh data
  }

  return null;
}

async function saveCache(data: SystemMonitorData): Promise<void> {
  await ensureRuntimeDir();
  cachedData = { data, fetchedAt: Date.now() };
  await writeFile(SYSTEM_MONITOR_CACHE_FILE, JSON.stringify(cachedData, null, 2), "utf-8");
}

async function fetchSystemInfo(): Promise<SystemMonitorData> {
  const [hostname, uptime, loadAverage, cpuInfo, memInfo, diskInfo, processes] = await Promise.all([
    getHostname(),
    getUptime(),
    getLoadAverage(),
    getCpuInfo(),
    getMemoryInfo(),
    getDiskInfo(),
    getTopProcesses(),
  ]);

  return {
    hostname,
    uptime,
    loadAverage,
    cpu: cpuInfo,
    memory: memInfo,
    disk: diskInfo,
    processes,
    fetchedAt: new Date().toISOString(),
  };
}

async function getHostname(): Promise<string> {
  try {
    const { stdout } = await execAsync("hostname");
    return stdout.trim();
  } catch {
    return "Unknown";
  }
}

async function getUptime(): Promise<number> {
  try {
    const { stdout } = await execAsync("cat /proc/uptime | awk '{print $1}'");
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function getLoadAverage(): Promise<number[]> {
  try {
    const { stdout } = await execAsync("uptime | grep -oE 'load average: [0-9.]+, [0-9.]+, [0-9.]+' | sed 's/load average: //' | tr ',' ' '");
    const parts = stdout.trim().split(/\s+/).map(parseFloat);
    return parts.length === 3 ? parts : [0, 0, 0];
  } catch {
    return [0, 0, 0];
  }
}

async function getCpuInfo(): Promise<CpuInfo> {
  try {
    // Get CPU model
    let model = "Unknown";
    try {
      const { stdout: modelOut } = await execAsync("grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | sed 's/^ *//'");
      model = modelOut.trim() || "Unknown";
    } catch {
      // try alternative
      try {
        const { stdout: modelOut } = await execAsync("sysctl -n machdep.cpu.brand_string");
        model = modelOut.trim() || "Unknown";
      } catch {
        // keep default
      }
    }

    // Get number of cores
    let cores = 1;
    try {
      const { stdout: coresOut } = await execAsync("nproc");
      cores = parseInt(coresOut.trim(), 10) || 1;
    } catch {
      try {
        const { stdout: coresOut } = await execAsync("sysctl -n hw.ncpu");
        cores = parseInt(coresOut.trim(), 10) || 1;
      } catch {
        // keep default
      }
    }

    // Get CPU usage
    let usage = 0;
    try {
      const { stdout } = await execAsync("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'");
      usage = parseFloat(stdout.trim()) || 0;
    } catch {
      try {
        // macOS
        const { stdout } = await execAsync("top -l 1 -n 0 | grep 'CPU usage' | awk '{print $3}' | tr -d '%'");
        usage = parseFloat(stdout.trim()) || 0;
      } catch {
        // keep default
      }
    }

    return { model, cores, usage };
  } catch {
    return { model: "Unknown", cores: 1, usage: 0 };
  }
}

async function getMemoryInfo(): Promise<MemoryInfo> {
  try {
    const { stdout } = await execAsync("free -b 2>/dev/null || vm_stat");
    const lines = stdout.trim().split("\n");

    if (lines[0].includes("Mem:")) {
      // Linux format: Mem: total used free available
      const parts = lines[1].trim().split(/\s+/);
      const total = parseInt(parts[1], 10) || 0;
      const used = parseInt(parts[2], 10) || 0;
      const free = parseInt(parts[3], 10) || 0;
      return {
        total,
        used,
        free,
        usagePercent: total > 0 ? (used / total) * 100 : 0,
      };
    } else {
      // Try alternative: parse /proc/meminfo
      return await getMemoryInfoFromMeminfo();
    }
  } catch {
    return await getMemoryInfoFromMeminfo();
  }
}

async function getMemoryInfoFromMeminfo(): Promise<MemoryInfo> {
  try {
    const content = await readFile("/proc/meminfo", "utf-8");
    const lines = content.split("\n");

    let memTotal = 0;
    let memFree = 0;
    let memAvailable = 0;

    for (const line of lines) {
      if (line.startsWith("MemTotal:")) {
        memTotal = parseInt(line.split(/\s+/)[1], 10) * 1024;
      } else if (line.startsWith("MemFree:")) {
        memFree = parseInt(line.split(/\s+/)[1], 10) * 1024;
      } else if (line.startsWith("MemAvailable:")) {
        memAvailable = parseInt(line.split(/\s+/)[1], 10) * 1024;
      }
    }

    const used = memTotal - memAvailable;
    return {
      total: memTotal,
      used,
      free: memFree,
      usagePercent: memTotal > 0 ? (used / memTotal) * 100 : 0,
    };
  } catch {
    // Try macOS
    try {
      const { stdout } = await execAsync("vm_stat | head -6");
      const lines = stdout.trim().split("\n");
      // Parse vm_stat output...
      return { total: 0, used: 0, free: 0, usagePercent: 0 };
    } catch {
      return { total: 0, used: 0, free: 0, usagePercent: 0 };
    }
  }
}

async function getDiskInfo(): Promise<DiskInfo> {
  try {
    const { stdout } = await execAsync("df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'");
    const parts = stdout.trim().split(/\s+/);
    const total = parseInt(parts[0], 10) || 0;
    const used = parseInt(parts[1], 10) || 0;
    const free = parseInt(parts[2], 10) || 0;
    const usagePercent = parseInt(parts[3].replace("%", ""), 10) || 0;

    return { total, used, free, usagePercent };
  } catch {
    return { total: 0, used: 0, free: 0, usagePercent: 0 };
  }
}

async function getTopProcesses(): Promise<ProcessInfo[]> {
  try {
    // Try ps command for top processes by CPU
    const { stdout } = await execAsync(
      "ps aux --sort=-%cpu | head -11 | tail -10 | awk '{print $2,$3,$4,$11}' | head -10",
    );

    const processes: ProcessInfo[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const pid = parseInt(parts[0], 10);
        const cpu = parseFloat(parts[1]);
        const memory = parseFloat(parts[2]);
        const name = parts[3]?.split("/").pop() || parts[3] || "Unknown";
        const command = parts.slice(3).join(" ");

        if (!isNaN(pid) && pid > 0) {
          processes.push({
            pid,
            name: name.substring(0, 30),
            cpu: isNaN(cpu) ? 0 : cpu,
            memory: isNaN(memory) ? 0 : memory,
            command: command.substring(0, 60),
          });
        }
      }
    }

    return processes.slice(0, 10);
  } catch {
    // Fallback: try simpler ps
    try {
      const { stdout } = await execAsync("ps -eo pid,pcpu,pmem,comm --no-headers | head -10");
      const processes: ProcessInfo[] = [];
      const lines = stdout.trim().split("\n");

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          processes.push({
            pid: parseInt(parts[0], 10) || 0,
            name: parts[3]?.substring(0, 30) || "Unknown",
            cpu: parseFloat(parts[1]) || 0,
            memory: parseFloat(parts[2]) || 0,
            command: parts.slice(3).join(" ").substring(0, 60),
          });
        }
      }

      return processes.slice(0, 10);
    } catch {
      return [];
    }
  }
}

export interface SystemMonitorSnapshot {
  data: SystemMonitorData | null;
  error: string | null;
  isStale: boolean;
  nextRefreshIn: number;
}

let lastFetchError: string | null = null;

export async function getSystemMonitorSnapshot(forceRefresh = false): Promise<SystemMonitorSnapshot> {
  if (forceRefresh) {
    cachedData = undefined;
  }

  const cached = await getCachedData();
  if (cached && !forceRefresh) {
    const nextRefreshIn = SYSTEM_MONITOR_INTERVAL_MS - (Date.now() - (cachedData?.fetchedAt || 0));
    return {
      data: cached,
      error: null,
      isStale: false,
      nextRefreshIn: Math.max(0, nextRefreshIn),
    };
  }

  try {
    const data = await fetchSystemInfo();
    await saveCache(data);
    lastFetchError = null;

    return {
      data,
      error: null,
      isStale: false,
      nextRefreshIn: SYSTEM_MONITOR_INTERVAL_MS,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Failed to fetch system info";
    lastFetchError = errorMsg;

    // Return cached data if available even on error
    if (cachedData) {
      return {
        data: cachedData.data,
        error: errorMsg,
        isStale: true,
        nextRefreshIn: 0,
      };
    }

    return {
      data: null,
      error: errorMsg,
      isStale: true,
      nextRefreshIn: 0,
    };
  }
}

export function startSystemMonitor(intervalMs = SYSTEM_MONITOR_INTERVAL_MS): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }

  // Initial fetch
  void getSystemMonitorSnapshot(true);

  // Set up interval
  monitorInterval = setInterval(() => {
    void getSystemMonitorSnapshot(true);
  }, intervalMs);
}

export function stopSystemMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = undefined;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  } else if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}
