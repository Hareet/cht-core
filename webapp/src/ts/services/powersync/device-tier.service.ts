/**
 * Device tier detection for adaptive PowerSync configuration.
 *
 * Classifies the current device into one of four tiers based on storage capacity,
 * then provides tier-appropriate PowerSync configuration (cache size, DB budget).
 *
 * Tier thresholds derived from MoH Cote d'Ivoire fleet telemetry:
 *   - go:       <16GB total storage  (56.3% of fleet — Android Go, 2GB RAM)
 *   - budget:   16-32GB              (19.0% — low-end Android)
 *   - standard: 32-128GB             (14.1% — mid-range)
 *   - high:     128GB+               (6.4% — flagship/tablets)
 *
 * OPFS availability is feature-detected, not inferred from UA string.
 */
import { Injectable } from '@angular/core';

export type DeviceTierName = 'go' | 'budget' | 'standard' | 'high';

export interface DeviceTier {
  tier: DeviceTierName;
  opfsAvailable: boolean;
  storageFreeGB: number;
  storageTotalGB: number;
  webviewMajor: number;
}

export interface TierConfig {
  /** SQLite page cache size in KB for WASQLiteOpenFactory cacheSizeKb */
  cacheSizeKb: number;
  /** Max DB size budget in MB before StorageHealthMonitor warns */
  dbSizeBudgetMB: number;
}

/** Storage thresholds in bytes */
const GB = 1024 * 1024 * 1024;
const TIER_THRESHOLDS = {
  go: 16 * GB,
  budget: 32 * GB,
  standard: 128 * GB,
};

const TIER_CONFIGS: Record<DeviceTierName, TierConfig> = {
  go:       { cacheSizeKb: 10240,  dbSizeBudgetMB: 200 },   // 10MB cache, 200MB budget
  budget:   { cacheSizeKb: 25600,  dbSizeBudgetMB: 500 },   // 25MB cache, 500MB budget
  standard: { cacheSizeKb: 51200,  dbSizeBudgetMB: 1024 },  // 50MB cache, 1GB budget
  high:     { cacheSizeKb: 51200,  dbSizeBudgetMB: 2048 },  // 50MB cache, 2GB budget
};

@Injectable({
  providedIn: 'root'
})
export class DeviceTierService {
  private detected: DeviceTier | null = null;

  /**
   * Detect the device tier. Caches result after first call.
   * Safe to call multiple times — subsequent calls return cached result.
   */
  async detect(): Promise<DeviceTier> {
    if (this.detected) {
      return this.detected;
    }

    const [storageEstimate, opfsAvailable] = await Promise.all([
      this.getStorageEstimate(),
      this.detectOPFS(),
    ]);

    const storageTotalGB = storageEstimate.total / GB;
    const storageFreeGB = storageEstimate.free / GB;
    const webviewMajor = this.getWebViewMajorVersion();

    const tier = this.classifyTier(storageEstimate.total);

    this.detected = {
      tier,
      opfsAvailable,
      storageFreeGB,
      storageTotalGB,
      webviewMajor,
    };

    return this.detected;
  }

  /**
   * Get the cached device tier, or null if detect() hasn't been called yet.
   */
  getCachedTier(): DeviceTier | null {
    return this.detected;
  }

  /**
   * Get tier-specific PowerSync configuration.
   */
  getConfig(tier: DeviceTierName): TierConfig {
    return TIER_CONFIGS[tier];
  }

  private classifyTier(totalBytes: number): DeviceTierName {
    if (totalBytes < TIER_THRESHOLDS.go) {
      return 'go';
    }
    if (totalBytes < TIER_THRESHOLDS.budget) {
      return 'budget';
    }
    if (totalBytes < TIER_THRESHOLDS.standard) {
      return 'standard';
    }
    return 'high';
  }

  private async getStorageEstimate(): Promise<{ total: number; free: number }> {
    try {
      if (navigator?.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const total = estimate.quota ?? 0;
        const used = estimate.usage ?? 0;
        return { total, free: Math.max(0, total - used) };
      }
    } catch {
      // Storage API not available
    }
    // Fallback: assume budget-tier device if API unavailable
    return { total: 16 * GB, free: 8 * GB };
  }

  /**
   * Feature-detect OPFS by actually trying to get the root directory handle.
   * More reliable than UA string parsing.
   */
  private async detectOPFS(): Promise<boolean> {
    try {
      if (navigator?.storage?.getDirectory) {
        await navigator.storage.getDirectory();
        return true;
      }
    } catch {
      // OPFS not available
    }
    return false;
  }

  /**
   * Extract major WebView/Chrome version from UA string.
   * Falls back to 0 if unparseable.
   */
  private getWebViewMajorVersion(): number {
    try {
      const ua = navigator?.userAgent || '';
      // Match "Chrome/NNN" or "CriOS/NNN" patterns
      const match = ua.match(/(?:Chrome|CriOS)\/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }
}
