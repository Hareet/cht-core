/**
 * PowerSync device benchmark for CHT.
 *
 * Measures performance characteristics on real devices to validate
 * PowerSync viability on the Go edition fleet (Android 10, 2GB RAM,
 * WebView 122, ~11GB storage).
 *
 * Metrics collected:
 * - WASM compilation + DB init time
 * - Priority-1 sync time (contacts only)
 * - Full sync time (all streams)
 * - SQLite DB size via navigator.storage.estimate()
 * - Task list query latency
 * - Contact count + report count after sync
 *
 * Usage from browser console (dev mode):
 *   const { runBenchmark } = await import('./services/powersync/benchmark');
 *   const results = await runBenchmark({ powerSyncUrl: 'http://localhost:8080', ... });
 *   console.table(results.metrics);
 *
 * Or via Angular injector:
 *   const benchmarkService = injector.get(PowerSyncBenchmarkService);
 *   const results = await benchmarkService.run();
 */
import { Injectable } from '@angular/core';
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';

import { ChtPowerSyncSchema } from './powersync-schema';
import { ChtPowerSyncConnector } from './powersync-connector';
import { DeviceTierService } from './device-tier.service';
import type { DeviceTier } from './device-tier.service';

export interface BenchmarkConfig {
  /** PowerSync service URL */
  powerSyncUrl: string;
  /** CHT API base URL */
  apiBaseUrl: string;
  /** Dev mode user for token generation */
  devUser: {
    userId: string;
    contactId?: string;
    roles?: string[];
    reportDepth?: number;
    canViewUnallocated?: boolean;
  };
  /** Timeout for full sync in ms (default: 120000 = 2 min) */
  fullSyncTimeoutMs?: number;
  /** Timeout for priority-1 sync in ms (default: 60000 = 1 min) */
  priority1TimeoutMs?: number;
}

export interface BenchmarkMetric {
  name: string;
  value: number;
  unit: string;
}

export interface BenchmarkResult {
  deviceTier: DeviceTier;
  metrics: BenchmarkMetric[];
  timestamp: string;
  userAgent: string;
}

/**
 * Run a standalone benchmark without Angular DI.
 * Creates its own PowerSyncDatabase instance so it doesn't interfere
 * with the main app's database.
 */
export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  const deviceTierService = new DeviceTierService();
  const deviceTier = await deviceTierService.detect();
  const tierConfig = deviceTierService.getConfig(deviceTier.tier);
  const metrics: BenchmarkMetric[] = [];

  // Record storage before sync
  const storageBefore = await getStorageEstimate();
  metrics.push({
    name: 'storage_used_before_mb',
    value: round(storageBefore.usedBytes / 1e6),
    unit: 'MB',
  });

  // --- 1. WASM compilation + DB init ---
  const vfs = deviceTier.opfsAvailable
    ? WASQLiteVFS.OPFSCoopSyncVFS
    : WASQLiteVFS.IDBBatchAtomicVFS;

  const initStart = performance.now();
  const db = new PowerSyncDatabase({
    schema: ChtPowerSyncSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: 'cht-benchmark.db',
      vfs,
      cacheSizeKb: tierConfig.cacheSizeKb,
    }),
    flags: {
      useWebWorker: true,
      enableMultiTabs: false,
    },
  });
  // Force WASM compile by executing a trivial query
  await db.getAll('SELECT 1');
  const initEnd = performance.now();

  metrics.push({
    name: 'wasm_init_ms',
    value: round(initEnd - initStart),
    unit: 'ms',
  });
  metrics.push({
    name: 'vfs_selected',
    value: vfs === WASQLiteVFS.OPFSCoopSyncVFS ? 1 : 0,
    unit: 'bool (1=OPFS, 0=IDB)',
  });

  // --- 2. Connect and measure sync times ---
  const connector = new ChtPowerSyncConnector({
    apiBaseUrl: config.apiBaseUrl,
    powerSyncUrl: config.powerSyncUrl,
    devMode: true,
    devUser: config.devUser,
  });

  const connectStart = performance.now();
  db.connect(connector);

  // --- 3. Priority-1 sync (contacts) ---
  const p1TimeoutMs = config.priority1TimeoutMs ?? 60_000;
  const p1Start = performance.now();
  let p1Success = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), p1TimeoutMs);
    await db.waitForFirstSync({ signal: controller.signal, priority: 1 });
    clearTimeout(timeout);
    p1Success = true;
  } catch {
    // Timed out or aborted
  }
  const p1End = performance.now();

  metrics.push({
    name: 'priority1_sync_ms',
    value: round(p1End - p1Start),
    unit: 'ms',
  });
  metrics.push({
    name: 'priority1_sync_success',
    value: p1Success ? 1 : 0,
    unit: 'bool',
  });

  // Count contacts after priority-1 sync
  const contactCount = await countRows(db, 'contacts');
  metrics.push({
    name: 'contact_count_after_p1',
    value: contactCount,
    unit: 'count',
  });

  // --- 4. Full sync ---
  const fullTimeoutMs = config.fullSyncTimeoutMs ?? 120_000;
  let fullSyncSuccess = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fullTimeoutMs);
    await db.waitForFirstSync({ signal: controller.signal });
    clearTimeout(timeout);
    fullSyncSuccess = true;
  } catch {
    // Timed out
  }
  const fullEnd = performance.now();

  metrics.push({
    name: 'full_sync_ms',
    value: round(fullEnd - connectStart),
    unit: 'ms',
  });
  metrics.push({
    name: 'full_sync_success',
    value: fullSyncSuccess ? 1 : 0,
    unit: 'bool',
  });

  // --- 5. Row counts after full sync ---
  const reportCount = await countRows(db, 'reports');
  const taskCount = await countRows(db, 'tasks');
  const targetCount = await countRows(db, 'targets');

  metrics.push({ name: 'report_count', value: reportCount, unit: 'count' });
  metrics.push({ name: 'task_count', value: taskCount, unit: 'count' });
  metrics.push({ name: 'target_count', value: targetCount, unit: 'count' });

  // --- 6. Storage after sync ---
  const storageAfter = await getStorageEstimate();
  metrics.push({
    name: 'storage_used_after_mb',
    value: round(storageAfter.usedBytes / 1e6),
    unit: 'MB',
  });
  metrics.push({
    name: 'db_size_delta_mb',
    value: round((storageAfter.usedBytes - storageBefore.usedBytes) / 1e6),
    unit: 'MB',
  });
  metrics.push({
    name: 'storage_quota_mb',
    value: round(storageAfter.totalBytes / 1e6),
    unit: 'MB',
  });

  // --- 7. Query benchmarks ---
  // Task list query (the most performance-sensitive user-facing query)
  const taskQueryStart = performance.now();
  await db.getAll(
    `SELECT id, state, owner, due_date, emission FROM tasks WHERE state = 'Ready' ORDER BY due_date LIMIT 100`
  );
  const taskQueryEnd = performance.now();
  metrics.push({
    name: 'task_list_query_ms',
    value: round(taskQueryEnd - taskQueryStart),
    unit: 'ms',
  });

  // Contact by type query
  const contactQueryStart = performance.now();
  await db.getAll(
    `SELECT id, name, contact_type, parent_id FROM contacts WHERE contact_type = 'person' LIMIT 200`
  );
  const contactQueryEnd = performance.now();
  metrics.push({
    name: 'contact_by_type_query_ms',
    value: round(contactQueryEnd - contactQueryStart),
    unit: 'ms',
  });

  // Reports for patient query
  const reportQueryStart = performance.now();
  await db.getAll(
    `SELECT id, form, reported_date FROM reports ORDER BY reported_date DESC LIMIT 100`
  );
  const reportQueryEnd = performance.now();
  metrics.push({
    name: 'reports_query_ms',
    value: round(reportQueryEnd - reportQueryStart),
    unit: 'ms',
  });

  // Upload queue stats
  const queueStats = await db.getUploadQueueStats();
  metrics.push({
    name: 'upload_queue_pending',
    value: queueStats.count,
    unit: 'count',
  });

  // --- Cleanup ---
  await db.disconnectAndClear();

  return {
    deviceTier,
    metrics,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };
}

/**
 * Format benchmark results as a human-readable report.
 */
export function formatBenchmarkReport(result: BenchmarkResult): string {
  const lines = [
    '=== PowerSync Benchmark Report ===',
    `Timestamp: ${result.timestamp}`,
    `Device tier: ${result.deviceTier.tier}`,
    `OPFS: ${result.deviceTier.opfsAvailable}`,
    `Storage: ${result.deviceTier.storageFreeGB.toFixed(1)}GB free / ${result.deviceTier.storageTotalGB.toFixed(1)}GB total`,
    `WebView: ${result.deviceTier.webviewMajor}`,
    `UA: ${result.userAgent}`,
    '',
    'Metrics:',
  ];

  for (const m of result.metrics) {
    lines.push(`  ${m.name.padEnd(30)} ${String(m.value).padStart(10)} ${m.unit}`);
  }

  return lines.join('\n');
}

// --- Angular service wrapper ---

@Injectable({
  providedIn: 'root'
})
export class PowerSyncBenchmarkService {
  constructor(private deviceTierService: DeviceTierService) {}

  async run(config: BenchmarkConfig): Promise<BenchmarkResult> {
    return runBenchmark(config);
  }

  format(result: BenchmarkResult): string {
    return formatBenchmarkReport(result);
  }
}

// --- Helpers ---

async function countRows(db: PowerSyncDatabase, table: string): Promise<number> {
  try {
    const result = await db.get<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
    return result.cnt;
  } catch {
    return 0;
  }
}

async function getStorageEstimate(): Promise<{ usedBytes: number; totalBytes: number }> {
  try {
    if (navigator?.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usedBytes: est.usage ?? 0, totalBytes: est.quota ?? 0 };
    }
  } catch {
    // Storage API unavailable
  }
  return { usedBytes: 0, totalBytes: 0 };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
