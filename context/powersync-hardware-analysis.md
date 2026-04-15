# PowerSync Client-Side Architecture: Hardware Constraints & Software Dependencies

## Engineering Analysis for CHT PostgreSQL Migration

**Author:** Hareet / medic.org architecture team
**Date:** April 2026
**Branch:** `Hareet/cht-core@playtime`
**First target deployment:** MoH Côte d'Ivoire (moh_civ)
**Status:** PowerSync + PostgreSQL server-side implementation nearing completion; client-side migration planning

---

## 1. Executive Summary

The CHT's migration from PouchDB/CouchDB to PowerSync/PostgreSQL requires choosing the correct client-side SQLite storage engine for the target device population. This decision is driven by hardware constraints, not software preferences.

Analysis of real telemetry data from the MoH Côte d'Ivoire deployment reveals a device fleet dominated by Android 10 Go edition phones with ~11GB total storage running Android System WebView 122. These devices support OPFS (Origin Private File System), the high-performance browser storage API that PowerSync's web SDK relies on for SQLite persistence. This means the **pure WebView path (Path A)** using PowerSync's JavaScript Web SDK with wa-sqlite is viable for the initial deployment without requiring changes to `cht-android`.

A secondary **native SQLite bridge path (Path B)** via the PowerSync Capacitor SDK is available as an upgrade if performance testing reveals issues on the most constrained devices. Both paths share identical PowerSync schemas, sync rules, and backend infrastructure — the difference is purely the client-side storage engine.

**Key finding:** The concurrent read/write limitation of wa-sqlite on web is **not a regression** from the current PouchDB/IndexedDB architecture, which has the same single-writer constraint. The primary risk is storage pressure on Go edition devices with limited free space.

---

## 2. Device Landscape: MoH Côte d'Ivoire Telemetry

### 2.1 Critical Architecture Detail: CHT Runs in Android WebView, Not Chrome

CHT Android (`cht-android`) is a thin native wrapper that loads the CHT web application inside **Android System WebView** — it does not launch Chrome. The browser version captured in telemetry (`browser.version`) reflects the **WebView version** from `window.navigator.userAgent`, not the Chrome browser app. Android manages Chrome and WebView as separate system components that are often on different versions.

This distinction matters because:

- All browser API availability (OPFS, Web Workers, WASM) depends on the **WebView version**, not Chrome
- WebView updates are delivered via Google Play as a system component, separate from Chrome updates
- On Android 10 Go edition devices, WebView may be pinned at a specific version and stop receiving updates
- The PowerSync Capacitor SDK's native SQLite bridge is architecturally compatible with `cht-android`'s existing WebView wrapper pattern

### 2.2 Android Version Distribution

| Android Version | Prevalence | Typical Device Profile |
|----------------|------------|----------------------|
| **Android 10** | ~65-70% (dominant) | Go edition, 11-26GB storage, WebView 122 |
| **Android 11** | ~10-15% | Budget phones, 26GB storage, WebView 130-143 |
| **Android 14** | ~8-12% | Mid-to-high range, 52-242GB storage, WebView 136-145 |
| **Android 12** | ~3-5% | Mixed, 26-121GB storage, WebView 136-143 |
| **Android 13** | ~3-5% | Mixed, 57-248GB storage, WebView 125-143 |
| **Android 15** | ~2-3% | Newer devices, 112-242GB storage, WebView 137-142 |
| **Android 9** | ~1% (legacy) | Older device, 135GB storage, WebView 103 (**no OPFS**) |
| **Desktop/no-APK** | ~2-3% | Browser-only access (supervisors, admins) |

### 2.3 WebView Version Distribution & OPFS Compatibility

OPFS support in Android WebView shipped at **version 109** (January 2023). The `createSyncAccessHandle()` method that enables high-performance synchronous file access shipped at WebView 102, and the `readwrite-unsafe` mode enabling multiple concurrent handles shipped at WebView 121.

| WebView Version | OPFS | SyncAccessHandle | readwrite-unsafe | Notes |
|----------------|------|------------------|-----------------|-------|
| **122.0.6261.90** | YES | YES | YES | **Dominant version.** Pinned on Android 10 Go edition devices. |
| **136.x – 145.x** | YES | YES | YES | Android 11-15 devices with active WebView updates. |
| **117.x – 135.x** | YES | YES | YES (121+) | Various older Android 11+ devices. |
| **103.0.5060.129** | **NO** | **NO** | **NO** | Android 9 legacy device. Falls back to IndexedDB. |
| **94.0.4606.61** | **NO** | **NO** | **NO** | Android 11 device with stale WebView. |
| **88.0.4324.93** | **NO** | **NO** | **NO** | Android 10 device with very old WebView. |
| **99.0.4844.88** | **NO** | **NO** | **NO** | No-APK desktop access. |

**OPFS compatibility: ~97-98% of device sessions have WebView 109+ and full OPFS support.** The 2-3% without OPFS are isolated legacy devices and desktop browser sessions. PowerSync's Web SDK automatically falls back to IndexedDB (`IDBBatchAtomicVFS`) on these devices.

### 2.4 Device Storage Tiers

| Storage Tier | Typical Total | Typical Free | Android | Profile |
|-------------|--------------|-------------|---------|---------|
| **~11GB (Go edition)** | 11,011,944,448 bytes | ~10GB (but see §2.5) | 10 | Dominant device class. Heavily storage-constrained. |
| **~26GB (budget)** | 26,283,515,904 bytes | ~24GB | 10-11 | Second most common. Moderate headroom. |
| **~52-58GB (mid-range)** | varies | varies widely | 10-14 | Some show <2GB free despite larger disks. |
| **~113-242GB (high-end)** | varies | 48-213GB free | 13-15 | Ample headroom. Not the constraining devices. |

### 2.5 Storage Pressure Analysis

The ~11GB Go edition devices report ~10GB "free," but this is misleading — Android OS, system apps, and WhatsApp consume significant space over time. Several devices in the dataset show critically low free storage:

- Multiple devices observed with **<1GB free** on 26GB total (e.g., `storageFree: 516194304` = 492MB)
- Devices with **<2GB free** appear across all storage tiers, not just Go edition
- The `storageFree` metric captures a snapshot; actual available OPFS quota is further constrained by Chrome's 60%-of-disk heuristic

**Implication:** PowerSync's default 50MB SQLite cache (`cacheSizeKb`) should be tuned down to **10-20MB** for the Go edition device tier. Data archiving and purge strategies are essential — this aligns with the CHT Architecture Roadmap Phase 1 data archiving work.

---

## 3. PowerSync Web SDK: Technical Constraints for CHT

### 3.1 Storage Engine: wa-sqlite with OPFS

PowerSync's JavaScript Web SDK uses **wa-sqlite** — SQLite compiled to WebAssembly (~938KB) — with the `OPFSCoopSyncVFS` virtual filesystem for persistence on devices that support OPFS. On devices without OPFS, it falls back to `IDBBatchAtomicVFS` (IndexedDB-backed).

Performance characteristics from PowerSync's own testing:

- `OPFSCoopSyncVFS` maintains performance even with databases exceeding 1GB
- `IDBBatchAtomicVFS` degrades significantly beyond 100MB database size
- A `fetchStrategy: 'sequential'` option processes sync events one at a time, reducing CPU pressure on lower-end hardware with minimal sync performance impact
- The Rust-based sync client (now default in PowerSync JS SDK v1.34+) improves sync performance and UI smoothness over the older JavaScript client

### 3.2 Concurrency Model: Single Connection (Not a Regression)

PowerSync's Web SDK operates with a **single database connection** — no concurrent read/write transactions. There is currently no web VFS implementation that supports SQLite WAL mode with shared memory, which would be required for concurrent readers alongside a writer.

**This is not a regression from the current CHT architecture.** PouchDB uses IndexedDB as its storage backend, and IndexedDB enforces the same single-writer constraint — exclusive locks are required on object stores for any write operation. CHPs today already experience serialized reads behind write locks during sync. Moving to PowerSync/wa-sqlite on OPFS is a **lateral move** on concurrency.

If concurrent read/write becomes a requirement in the future (e.g., for smoother UI during heavy sync), **Path B (native SQLite via Capacitor)** enables WAL mode with concurrent readers, which would be a genuine improvement over both the current PouchDB architecture and the wa-sqlite web path.

### 3.3 WebAssembly Compilation Overhead

The wa-sqlite WASM binary must be compiled on first load. On Go edition devices with budget MediaTek processors, this adds an estimated 3-8 seconds to initial app startup. Subsequent loads use the browser's compiled WASM cache. If Android clears the WebView cache (common on low-storage devices), recompilation occurs.

**Mitigation:** The CHT app already has a loading/initial-sync UX flow. WASM compilation can be absorbed into this existing experience. The compiled module should be cached via the service worker where possible.

### 3.4 Storage Persistence

OPFS storage is subject to browser quota restrictions and can be cleared by Android's storage management or by the user. This is the same risk profile as PouchDB's IndexedDB storage today. CHT should:

- Call `navigator.storage.persist()` to request durable storage
- Monitor usage via `navigator.storage.estimate()`
- Implement proactive low-storage warnings to CHPs
- Ensure the PowerSync upload queue (which lives in the same SQLite database) syncs data to the server before storage eviction becomes a risk

### 3.5 Background Sync

PWAs cannot perform true background sync when the app is closed. The Background Sync API offers a single-shot mechanism when connectivity returns, and Periodic Background Sync has a minimum 12-hour interval and requires site engagement heuristics. **This is identical to the current PouchDB/CouchDB PWA constraint** — CHPs must open the app while connected for sync to occur. PowerSync does not change this.

### 3.6 Multi-Tab Behavior

PowerSync's Web SDK supports multi-tab usage via SharedWorker where available (WebView 148+; currently beyond the fleet's WebView versions). Without SharedWorker, each tab spawns its own Web Worker, and only one tab can sync at a time. **This is a non-issue for CHT** — the app runs as a single-instance WebView inside `cht-android`, not as a multi-tab browser experience. CHT's in-app navigation tabs (Tasks, Targets, Messages, Reports, Contacts) are Angular route views within a single SPA, not browser tabs.

### 3.7 WebView-Specific OPFS Considerations

OPFS was explicitly shipped for both Android Chrome and Android WebView at version 109. However, some device-specific WebView configurations on newer Android versions (reported on WebView 132 / Android 14) have been observed to enforce stricter origin-isolation policies that can block OPFS access. The MoH-CiV fleet's dominant WebView 122 on Android 10 is not expected to be affected, but Android 14 devices with newer WebViews should be explicitly tested during the PoC.

---

## 4. Implementation Paths

### Path A: Pure WebView (Recommended for Initial PoC)

**Architecture:** CHT web app → PowerSync JS Web SDK → wa-sqlite (WASM) → OPFS → existing `cht-android` WebView wrapper

**Changes required:**
- Replace PouchDB with PowerSync JS Web SDK in cht-core webapp (in progress on `playtime` branch)
- Configure `OPFSCoopSyncVFS` as primary VFS with `IDBBatchAtomicVFS` fallback
- Tune `cacheSizeKb` based on device storage tier detection
- Set `fetchStrategy: 'sequential'` for Go edition devices
- **No changes to `cht-android`**

**Advantages:**
- Minimal deployment surface — no native Android changes
- Validates PowerSync sync mechanics, schema design, and backend integration independent of storage engine
- Covers ~97-98% of the device fleet with OPFS performance
- Fallback to IndexedDB for the ~2-3% legacy devices

**Risks:**
- WASM compilation overhead on first load (3-8 seconds on Go edition)
- Storage quota pressure on ~11GB devices under heavy use
- Single-connection concurrency (same as today, but worth monitoring if sync volume increases)

### Path B: Native SQLite Bridge (Upgrade Path)

**Architecture:** CHT web app → PowerSync Capacitor SDK → `@capacitor-community/sqlite` → native Android SQLite (WAL mode) → `cht-android` with Capacitor plugin

**Changes required:**
- Integrate `@capacitor-community/sqlite` as a native plugin in `cht-android`
- Either: migrate `cht-android` to Capacitor shell, or: build a custom bridge plugin
- PowerSync SDK detects platform and uses native SQLite on Android, wa-sqlite on web

**Advantages:**
- Eliminates WASM compilation overhead entirely
- Native SQLite WAL mode enables concurrent readers during sync (genuine improvement)
- Filesystem-based persistence — no OPFS quota concerns, no browser eviction risk
- Better performance on Go edition devices (no JS↔WASM boundary crossing)
- Reduced memory footprint (no WASM runtime in memory)

**Risks:**
- PowerSync Capacitor SDK is currently in **alpha** (stable Web SDK foundation, but native bridge is new)
- Requires native Android development and testing in `cht-android`
- Additional build/release complexity for the APK
- Encryption via SQLCipher not yet supported in the Capacitor SDK

**When to consider Path B:** If PoC testing on Go edition devices reveals unacceptable WASM startup times, query latency during sync, or storage quota exhaustion that cannot be mitigated by tuning.

### Path Compatibility

Both paths share:
- Identical PowerSync sync rules and bucket definitions
- Same PostgreSQL schema and Row-Level Security policies
- Same `uploadData()` backend connector implementation
- Same client-side schema definitions (`AppSchema`)
- Same reactive query patterns (`useQuery`, `watch`, `onChange`)

The storage engine can be swapped via configuration without changing application logic. A feature flag can route specific device profiles to Path B while keeping others on Path A.

---

## 5. Configuration Recommendations

### 5.1 PowerSync Web SDK Configuration

```typescript
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';

// Detect device tier from available storage
const storageEstimate = await navigator.storage?.estimate();
const availableGB = (storageEstimate?.quota || 0) / 1e9;
const isGoEdition = availableGB < 8; // ~11GB devices get ~6GB OPFS quota

export const db = new PowerSyncDatabase({
  schema: CHTSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: 'cht-powersync.db',
    vfs: WASQLiteVFS.OPFSCoopSyncVFS, // OPFS primary, auto-fallback to IndexedDB
  }),
  flags: {
    enableMultiTabs: false, // Single WebView instance, no multi-tab needed
  }
});

// Connect with device-appropriate settings
await db.connect({
  fetchStrategy: isGoEdition ? 'sequential' : 'buffered',
  // sequential: processes one sync event at a time, better for low-end hardware
  // buffered: default, better throughput on capable devices
});
```

### 5.2 Storage Management

```typescript
// Request persistent storage on app init
if (navigator.storage?.persist) {
  const persisted = await navigator.storage.persist();
  if (!persisted) {
    console.warn('Storage persistence not granted — data may be evicted');
  }
}

// Monitor storage usage
async function checkStorageHealth(): Promise<'ok' | 'warning' | 'critical'> {
  const estimate = await navigator.storage.estimate();
  const usedMB = (estimate.usage || 0) / 1e6;
  const quotaMB = (estimate.quota || 0) / 1e6;
  const usagePercent = usedMB / quotaMB * 100;
  
  if (usagePercent > 80 || quotaMB - usedMB < 50) return 'critical';
  if (usagePercent > 60 || quotaMB - usedMB < 100) return 'warning';
  return 'ok';
}
```

### 5.3 SQLite Cache Tuning

PowerSync's Web SDK defaults to a 50MB SQLite cache. For the Go edition device tier, reduce this:

```typescript
const db = new PowerSyncDatabase({
  schema: CHTSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: 'cht-powersync.db',
    vfs: WASQLiteVFS.OPFSCoopSyncVFS,
    cacheSizeKb: isGoEdition ? 10240 : 51200, // 10MB for Go, 50MB default
  }),
});
```

---

## 6. PoC Testing Plan for MoH-CiV

### 6.1 Target Devices

Based on the telemetry analysis, the PoC must include testing on:

| Device Profile | Priority | Why |
|---------------|----------|-----|
| Android 10 + WebView 122 + ~11GB storage | **P0** | Dominant device class. Represents ~50%+ of the fleet. Use actual Go edition hardware (Tecno/Itel). |
| Android 10 + WebView 122 + ~26GB storage | **P0** | Second most common profile. Budget Android devices. |
| Android 14 + WebView 136+ + 113GB+ storage | **P1** | Newer devices. Verify OPFS works in newer WebView with stricter policies. |
| Android 11 + WebView 130+ + ~26GB storage | **P1** | Mid-tier devices. |
| Android 9 + WebView 103 (no OPFS) | **P2** | Legacy fallback. Verify IndexedDB fallback works. |

### 6.2 Test Scenarios

**Initial sync performance:**
- Measure time from first app load to usable state with realistic dataset (1,000-5,000 contacts, 10,000+ reports)
- Break down: WASM compilation time + PowerSync initial sync time + first query time
- Compare against current PouchDB initial replication baseline

**Operational query latency during sync:**
- While PowerSync download sync is active, measure time to: open Tasks tab, load a household contact, submit a form
- This tests the single-connection serialization under real workload
- Use `fetchStrategy: 'sequential'` and `fetchStrategy: 'buffered'` — compare both

**Storage footprint over time:**
- After initial sync, measure total OPFS usage via `navigator.storage.estimate()`
- Compare against current PouchDB/IndexedDB footprint for same dataset
- Simulate 30 days of CHP usage (daily form submissions, sync cycles)
- Monitor for storage pressure on 11GB devices

**Offline resilience:**
- Collect forms while offline for 24+ hours
- Reconnect and verify upload queue drains correctly
- Verify no data loss through airplane mode, app force-close, device restart cycles

**WebView OPFS edge cases:**
- Test on Android 14 device with WebView 132+ (reported OPFS restriction issues)
- Test OPFS behavior when device storage is critically low (<500MB free)
- Test behavior in Chrome Incognito (100MB database size limit — not typical CHT use but worth documenting)

### 6.3 Success Criteria

| Metric | Target | Current Baseline |
|--------|--------|-----------------|
| Initial sync (5,000 contacts) | <60 seconds on Go edition | Measure current PouchDB baseline |
| Task list load during active sync | <2 seconds | Measure current baseline |
| Form submission (offline) | <500ms to local persistence | Should be near-instant with SQLite |
| Storage footprint (same dataset) | ≤ current PouchDB footprint | Expect smaller (SQL vs JSON revision trees) |
| Upload queue reliability | 0 data loss across 100 offline cycles | Must match current CouchDB reliability |
| OPFS availability | Works on ≥95% of test devices | 97-98% expected from telemetry |

---

## 7. Key References

- **PowerSync Web SDK docs:** https://docs.powersync.com/client-sdks/reference/javascript-web
- **PowerSync Capacitor SDK (alpha):** https://docs.powersync.com/client-sdks/reference/capacitor
- **PowerSync performance & limits:** https://docs.powersync.com/resources/performance-and-limits
- **wa-sqlite OPFS state of the art:** https://www.powersync.com/blog/sqlite-persistence-on-the-web
- **PowerSync Flutter benchmarks:** https://www.powersync.com/blog/how-fast-is-powersync-performance-benchmarks-for-flutter
- **OPFS on Android WebView (Chromium intent-to-ship):** https://groups.google.com/a/chromium.org/g/blink-dev/c/GyxqF8ZDK5Q
- **MDN OPFS compat data confirming WebView 109+:** https://github.com/mdn/browser-compat-data/pull/18365
- **CHT Android architecture:** https://github.com/medic/cht-android
- **CHT Architecture Roadmap:** (companion document)
- **Implementation branch:** https://github.com/Hareet/cht-core/tree/playtime

---

## Appendix A: Device Telemetry Source

Analysis based on user-device telemetry from the MoH Côte d'Ivoire UAT deployment (`moh_civ_uat`). The telemetry data captures `window.navigator.userAgent` from inside the `cht-android` WebView, providing the actual WebView version (not Chrome browser version) that governs API availability.

Key patterns identified in the dataset:

- **WebView 122.0.6261.90** appears pinned/frozen on Android 10 Go edition devices — it ships with the device and does not update. This version fully supports OPFS, `createSyncAccessHandle()`, and `readwrite-unsafe` mode.
- **~11GB total storage** (`storageTotal: ~11,011,944,448` bytes ≈ 10.25GB) identifies Android Go edition devices. These typically show ~10GB free on fresh installs but degrade as users install apps and accumulate data.
- **~26GB total storage** (`storageTotal: ~26,283,515,904` bytes ≈ 24.5GB) identifies standard budget Android devices commonly procured for CHW programs.
- The **APK field** (`apk: "v1.2.0-alpha.moh_civ_uat.1"`) confirms deployment via the `cht-android` native wrapper, not direct browser access.

## Appendix B: OPFS vs IndexedDB Decision Tree

```
Device loads CHT web app in cht-android WebView
  │
  ├─ WebView ≥ 109?
  │   ├─ YES → Use OPFSCoopSyncVFS (high performance, 1GB+ capable)
  │   │   ├─ Device storage < 16GB?
  │   │   │   ├─ YES → cacheSizeKb = 10240, fetchStrategy = 'sequential'
  │   │   │   └─ NO  → cacheSizeKb = 51200, fetchStrategy = 'buffered'
  │   │   └─ Request navigator.storage.persist()
  │   │
  │   └─ OPFS access denied? (device-specific WebView policy)
  │       └─ Fall back to IDBBatchAtomicVFS
  │
  └─ WebView < 109?
      └─ Use IDBBatchAtomicVFS (IndexedDB fallback)
          └─ Warn: performance degrades >100MB database size
              └─ Aggressive data archiving required
```

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **wa-sqlite** | SQLite compiled to WebAssembly by Roy Hashimoto. Used by PowerSync's Web SDK for client-side SQL in browsers. |
| **OPFS** | Origin Private File System. Browser storage API providing high-performance, private file access. Used as the persistence layer for wa-sqlite. |
| **OPFSCoopSyncVFS** | wa-sqlite's cooperative synchronous VFS implementation using OPFS. PowerSync's recommended storage mode. |
| **IDBBatchAtomicVFS** | wa-sqlite's IndexedDB-backed VFS. Fallback when OPFS is unavailable. Performance degrades with larger databases. |
| **createSyncAccessHandle()** | OPFS method providing synchronous read/write access to files from Web Workers. Critical for SQLite performance. Available in WebView 102+. |
| **WebView** | Android System WebView. The system component that renders web content inside native Android apps. Separate from the Chrome browser app. |
| **Go edition** | Android Go — a lightweight Android variant for devices with ≤2GB RAM and limited storage. Ships with reduced system apps and pinned system component versions. |
| **WAL mode** | SQLite Write-Ahead Logging. Enables concurrent readers alongside a single writer. Available in native SQLite but **not in wa-sqlite on web** (requires shared memory VFS not yet implemented). |
| **Capacitor** | Ionic's native runtime for web apps. The PowerSync Capacitor SDK uses it to bridge web code to native SQLite on Android/iOS. |
| **cht-android** | Medic's thin Android wrapper that loads CHT Core in a WebView. Distributed as an APK. |
