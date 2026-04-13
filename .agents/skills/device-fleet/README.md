# Device Fleet Reference — MoH Côte d'Ivoire

Quick reference for agents making device-dependent decisions. Source: `devices.json` telemetry (6,662 entries, 2,611 unique users).

## Device Tiers

| Tier | Storage | Fleet % | DB Budget | cacheSizeKb | fetchStrategy |
|------|---------|---------|-----------|-------------|---------------|
| **go** | <16GB | 56.3% | 200MB | 10,240 | sequential |
| **budget** | 16-32GB | 19.0% | 500MB | 25,600 | sequential |
| **standard** | 32-128GB | 14.1% | 1GB | 51,200 | buffered |
| **high** | 128GB+ | 6.4% | 2GB | 51,200 | buffered |
| **unknown** (desktop) | N/A | 4.3% | No constraint | 51,200 | buffered |

## OPFS Compatibility

- **99.1%** of unique devices have WebView 109+ → OPFS supported
- **22 users** lack OPFS:
  - 14 desktop browser users (Firefox/Safari, WV 18-28, no APK)
  - 6 old-WebView Android (WV 87, 88, 92, 94, 103)
  - 2 stale-WebView Android (WV 94, 99)
- Fallback: `IDBBatchAtomicVFS` (IndexedDB) — degrades >100MB but functional

## Go Edition Constraints (56.3% of fleet)

- **Storage**: ~11GB total, ~10GB free on fresh install, ~6GB OPFS quota (60% of disk)
- **RAM**: 2GB (Android Go limitation)
- **CPU**: MediaTek Helio A22 (4x Cortex-A53 @ 2.0GHz)
- **WebView**: 122.0.6261.90 (pinned, never updates)
- **Android**: 10 (Go edition)
- **WASM compile**: 3-8 seconds cold start
- **Process killing**: Aggressive — Android Go kills background apps to reclaim RAM
- **APK**: `v1.2.0-alpha.moh_civ_uat.1` (cht-android wrapper)

## Storage Pressure

66 telemetry entries show <1GB free storage, distributed across ALL tiers:
- 27GB devices: 21 entries (most common)
- 24-26GB devices: 19 entries
- 52-58GB devices: 10 entries
- 113-121GB devices: 6 entries
- 6GB device: 1 entry (extreme case)

**Implication**: Storage monitoring and purge are not just for Go edition.

## Non-OPFS Users (22 total)

### Desktop browsers (14 users, no APK)
These are supervisors/admins accessing via desktop. WV versions like 18, 19, 28 are Firefox/Safari UA strings, not WebView. They need cross-browser PowerSync Web SDK compatibility, not mobile optimization.

### Old-WebView Android (6 users, have APK)
- `diallo_adama`: Android 10, WV 88, 117GB — old WebView on capable device
- `ouattara_gaoussou26`: Android 10, WV 92, 117GB
- `test_asc_05`: Android 11, WV 87, 27GB
- `test_asc_100`: Android 12, WV 99, 54GB
- `test_asc_75`: Android 10, WV 88, 117GB
- `vhi_hortense`: Android 11, WV 94, 27GB

These users could potentially update their WebView via Google Play to gain OPFS support. However, IndexedDB fallback must work for them.

## Android Version Distribution (unique devices)

| Android | Users | % |
|---------|-------|---|
| 10 | 1,785 | 68.4% |
| 14 | 200 | 7.7% |
| 11 | 186 | 7.1% |
| 13 | 142 | 5.4% |
| 15 | 86 | 3.3% |
| 12 | 85 | 3.3% |
| 16 | 9 | 0.3% |
| 9 | 5 | 0.2% |
| 8.1.0 | 1 | 0.0% |

## CHT Versions in Production

| Version | Users |
|---------|-------|
| 4.10.0 | 1,548 |
| 4.21.1 | 616 |
| 4.9.0 | 418 |
| 4.3.1 | 13 |
| 4.5.1 | 12 |

PowerSync integration must work across these versions.
