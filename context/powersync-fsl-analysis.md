# PowerSync FSL Licensing: Alternatives Comparison for CHT Integration

---

## CHT's AGPL-3.0 license and PowerSync FSL compatibility

CHT Core is licensed under **AGPL-3.0** (GNU Affero General Public License v3), one of the strongest copyleft licenses in use. This creates a specific license compatibility concern with PowerSync's FSL-1.1-ALv2 that requires careful analysis.

### The incompatibility

AGPL-3.0 Section 10 states: "You may not impose any further restrictions on the exercise of the rights granted or affirmed under this License." FSL-1.1-ALv2 imposes a non-compete restriction prohibiting competing commercial use for two years. These requirements are fundamentally in tension: AGPL prohibits additional restrictions on downstream recipients, while FSL adds exactly such a restriction.

During FSL's two-year restriction period, PowerSync's server-side component cannot be relicensed under AGPL-3.0, and AGPL-3.0 code cannot incorporate FSL-restricted code as a derivative work. After FSL converts to Apache 2.0 (May 31, 2026 for the first release), Apache 2.0 is AGPL-compatible — the issue resolves itself on a rolling basis.

### Where the boundary falls in practice

PowerSync's architecture has a natural separation that may mitigate this concern:

**PowerSync client SDKs are Apache 2.0** — fully compatible with AGPL-3.0. These are the components that would be integrated into CHT's application code running on health workers' devices. Apache 2.0 code can be included in AGPL-3.0 projects without conflict. This is the primary integration surface.

**PowerSync Service (server-side) is FSL-1.1-ALv2** — this runs as a separate process, communicating with both PostgreSQL and client apps over network APIs (HTTP/WebSocket). It does not link into CHT's codebase. AGPL-3.0 Section 5 distinguishes between works "based on" the Program (derivative works, where copyleft propagates) and "aggregates" (separate programs distributed together, where it does not). A standalone sync service communicating via network APIs has a strong argument for being a separate program in an aggregate, not a derivative of CHT.

### Assessment

The architecture-level separation (separate process, network API communication) likely means PowerSync Service operates as an independent program alongside CHT rather than a derivative of it, avoiding AGPL copyleft propagation to the FSL-licensed component. However, this interpretation has not been tested in court, and organizations with strict license compliance requirements should obtain legal review.

**The safest path:** Wait for PowerSync's FSL-to-Apache-2.0 conversion (rolling, beginning May 31, 2026), after which all compatibility concerns disappear. For earlier adoption, the architectural separation argument is reasonable but should be documented and reviewed by legal counsel.

---

## Comparison with alternative sync solutions

PowerSync's FSL licensing is more restrictive than most alternatives in the offline-first sync space. However, **licensing permissiveness does not equal functional equivalence** — evaluating alternatives requires weighing both licensing freedom and architectural capability against CHT's requirements.

### Electric SQL: Apache 2.0 but read-only sync only

Electric SQL uses Apache 2.0 licensing with no restrictions — the most permissive option and fully AGPL-3.0 compatible. However, **Electric SQL provides only server-to-client (read-path) sync and has no built-in write-path synchronization**. This limitation is architectural, not a temporary gap: their July 2024 "Electric Next" rewrite deliberately removed bidirectional sync, and as of April 2026 (latest releases: sync service v1.4.14, client v1.5.13), this remains unchanged with no announced plans to add write-path capabilities.

Electric SQL's own documentation states explicitly that it does not provide or prescribe a solution for getting data back into Postgres from local apps. Developers must implement one of four custom write patterns, ranging from simple online-only API calls (no offline support) to complex through-the-database sync using PGlite with shadow tables, triggers, and custom conflict resolution — representing 100-300+ lines of custom code plus ongoing maintenance.

**For CHT's use case, this is disqualifying.** Community health workers collect data offline (form submissions, patient assessments, visit reports) and sync upstream when connectivity returns. This bidirectional offline-first write capability is a non-negotiable requirement for eCHIS. Electric SQL would require Medic to build and maintain a complete custom write-path sync layer — effectively recreating what PowerSync provides out of the box, estimated at 14+ weeks of additional engineering work on top of the gap work already identified for PowerSync integration.

Additionally, Electric SQL's client-side database (PGlite) lacks React Native support as of April 2026, limiting it to web-only deployments. CHT requires mobile app support for health worker devices.

**Bottom line:** Electric SQL is the strongest *licensing* alternative (Apache 2.0, fully AGPL-compatible) but is not a functional alternative for offline-first healthcare applications requiring bidirectional sync. It cannot replace PowerSync without building a substantial custom sync layer.

### RxDB: Apache 2.0 core with paid premium tier

RxDB's core is Apache 2.0 (AGPL-compatible), but performance-critical features (IndexedDB, OPFS, and SQLite storage adapters, Query Optimizer, Sharding) require paid annual subscriptions. The document-oriented (NoSQL) data model also diverges from CHT's migration toward relational PostgreSQL. RxDB's architectural incompatibilities with CHT's data model make it a poor technical fit despite favorable licensing.

### WatermelonDB: MIT with no server component

WatermelonDB uses MIT licensing (most permissive, AGPL-compatible) but provides only client-side sync APIs — no server component. Medic would need to build the entire backend sync infrastructure. WatermelonDB's architectural incompatibilities with CHT and the requirement to build custom server-side sync make the development burden prohibitive despite ideal licensing.

### Turso/libSQL: Apache 2.0 with bidirectional sync (beta)

Turso entered public beta in early 2026 with offline sync using libSQL (their SQLite fork), offering true bidirectional synchronization under Apache 2.0 licensing. This is architecturally promising and AGPL-compatible. However, **Turso explicitly warns of no durability guarantees and potential data loss in beta**, making it unsuitable for production healthcare deployments. Worth monitoring for general availability, but not a candidate for CHT's Fall 2027 timeline without significant maturation.

### Replicache/Zero: Transitioning, uncertain timeline

Replicache is in maintenance mode (bug fixes only) as creators build "Zero," a next-generation sync engine. Zero's licensing and GA timeline remain unclear as of April 2026. Not recommended for new healthcare projects given the transition uncertainty.

---

## Comparison matrix

| Dimension | PowerSync | Electric SQL | Turso/libSQL | WatermelonDB |
|-----------|-----------|-------------|--------------|--------------|
| **Server license** | FSL-1.1-ALv2 (→ Apache 2.0 after 2yr) | Apache 2.0 | Apache 2.0 | MIT (no server) |
| **Client SDK license** | Apache 2.0 | Apache 2.0 | Apache 2.0 | MIT |
| **AGPL-3.0 compatible (client)** | Yes (Apache 2.0) | Yes | Yes | Yes |
| **AGPL-3.0 compatible (server)** | Likely (separate process) — converts to yes after 2yr | Yes | Yes | N/A |
| **Sync direction** | Bidirectional | Read-only | Bidirectional | Client-only (BYO server) |
| **Offline writes** | Built-in upload queue | DIY (100-300+ LOC) | Built-in (beta) | Client-side only |
| **Production readiness** | GA, enterprise deployments | GA (read-path only) | Beta — no durability guarantees | Mature client, no server |
| **Mobile support** | Flutter, React Native, Swift, Kotlin | PGlite — web only (no React Native) | libSQL — iOS/Android | React Native |
| **Healthcare deployments** | Proven, HIPAA docs | None documented | None | None |
| **Custom dev needed for CHT** | ~14-19 weeks (gap work) | 14-19 weeks + full write-path layer | Unknown (beta) | Full server build |

---

## Recommendations

### The licensing-vs-functionality trade-off is real

**There is currently no Apache 2.0-licensed solution that provides the bidirectional offline-first sync CHT requires without substantial custom engineering.** The choice is not between equivalent products with different licenses — it's between a functionally complete solution with licensing nuance (PowerSync) and licensing-clean alternatives that each require building significant missing capabilities.

### Recommended approach for Medic

1. **Proceed with PowerSync** — the AGPL/FSL tension is manageable given the architectural separation (PowerSync Service as a separate process, client SDKs under Apache 2.0). The FSL server component communicates over network APIs and does not create a derivative work of CHT.

2. **Obtain written confirmation from PowerSync (Journey Mobile, Inc.)** that CHT's use case — embedding PowerSync as infrastructure within an AGPL-3.0 health platform serving government programs — constitutes a Permitted Purpose under FSL terms. Document this for governance and compliance records.

3. **Leverage the conversion timeline** — PowerSync's initial May 2024 releases convert to Apache 2.0 on May 31, 2026 (less than two months away). Subsequent releases follow on a rolling two-year basis. By the time CHT reaches production deployment with PowerSync (well into 2027), substantial portions of the PowerSync codebase will be fully Apache 2.0, further reducing any compatibility concern.

4. **Document the architectural boundary clearly** — maintain explicit technical documentation showing that PowerSync Service runs as an independent process communicating with CHT via network APIs, and that only Apache 2.0-licensed client SDKs are integrated into CHT's AGPL-3.0 codebase. This documentation supports the "aggregate" (not derivative work) interpretation under AGPL Section 5.

5. **Monitor Turso/libSQL** — if it reaches GA with durability guarantees and production maturity before CHT's PowerSync integration is complete, it could serve as a fully Apache 2.0 bidirectional alternative. Current beta status makes it unsuitable for healthcare.

6. **Do not treat Electric SQL as a fallback** — absent a major architectural change adding write-path sync (which Electric SQL has shown no indication of pursuing), it cannot serve CHT's offline-first requirements without building a custom sync layer that would eliminate the development efficiency advantage of using a sync solution at all.
