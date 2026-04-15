/**
 * Storage health monitor for PowerSync on resource-constrained devices.
 *
 * Periodically checks navigator.storage.estimate() and fires callbacks
 * when storage crosses warning or critical thresholds.
 *
 * Thresholds:
 *   - warning:  <100MB free OR >60% quota used
 *   - critical: <50MB free  OR >80% quota used
 *
 * On critical: consumers should pause non-essential sync and show persistent alert.
 * On warning:  consumers should show a dismissible notification.
 */
import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type StorageHealthLevel = 'healthy' | 'warning' | 'critical';

export interface StorageHealthStatus {
  level: StorageHealthLevel;
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
  usagePercent: number;
}

const MB = 1024 * 1024;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const WARNING_FREE_THRESHOLD = 100 * MB;
const CRITICAL_FREE_THRESHOLD = 50 * MB;
const WARNING_USAGE_PERCENT = 60;
const CRITICAL_USAGE_PERCENT = 80;

@Injectable({
  providedIn: 'root'
})
export class StorageHealthService implements OnDestroy {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  private statusSubject = new BehaviorSubject<StorageHealthStatus>({
    level: 'healthy',
    usedBytes: 0,
    totalBytes: 0,
    freeBytes: 0,
    usagePercent: 0,
  });

  readonly status$ = this.statusSubject.asObservable();

  /**
   * Start periodic storage checks.
   * Safe to call multiple times — restarts the interval.
   */
  startMonitoring(): void {
    this.stopMonitoring();
    // Check immediately, then periodically
    this.checkStorage();
    this.intervalId = setInterval(() => this.checkStorage(), CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic checks.
   */
  stopMonitoring(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check storage once and update status.
   */
  async checkStorage(): Promise<StorageHealthStatus> {
    const status = await this.getStorageStatus();
    this.statusSubject.next(status);
    return status;
  }

  /**
   * Get current cached status without triggering a new check.
   */
  getCurrentStatus(): StorageHealthStatus {
    return this.statusSubject.value;
  }

  /**
   * Whether monitoring is currently active.
   */
  isMonitoring(): boolean {
    return this.intervalId !== null;
  }

  private async getStorageStatus(): Promise<StorageHealthStatus> {
    let totalBytes = 0;
    let usedBytes = 0;

    try {
      if (navigator?.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        totalBytes = estimate.quota ?? 0;
        usedBytes = estimate.usage ?? 0;
      }
    } catch {
      // Storage API unavailable — return healthy with zeros
    }

    const freeBytes = Math.max(0, totalBytes - usedBytes);
    const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

    const level = this.classifyLevel(freeBytes, usagePercent);

    return { level, usedBytes, totalBytes, freeBytes, usagePercent };
  }

  private classifyLevel(freeBytes: number, usagePercent: number): StorageHealthLevel {
    if (freeBytes < CRITICAL_FREE_THRESHOLD || usagePercent > CRITICAL_USAGE_PERCENT) {
      return 'critical';
    }
    if (freeBytes < WARNING_FREE_THRESHOLD || usagePercent > WARNING_USAGE_PERCENT) {
      return 'warning';
    }
    return 'healthy';
  }

  ngOnDestroy(): void {
    this.stopMonitoring();
  }
}
