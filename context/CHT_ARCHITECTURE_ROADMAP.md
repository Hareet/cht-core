Fit for the Future: CHT Architecture Roadmap 2026-2027
CHT and the evolution of eCHIS Kenya
The CHT has enabled Kenya to do what seemed impossible — digitizing community health delivery for 100,000+ CHPs at national scale. That achievement is real and should not be understated. But we also recognise that the architecture that got us here needs to evolve to meet the demands of the next decade. 

Our vision is a CHT that can power a single national instance of 100,000+ users, sync reliably in any connectivity environment, interoperate seamlessly with national health systems, and be maintained independently by MoH technical teams — without requiring specialized database expertise. This roadmap is how we get there.

Medic Mobile (Medic) is actively leading the structural evolution of the CHT to optimize its performance for the next decade of delivery for national digital health services. We have shaped our 2026+ community and platform closely with our implementing partners, including Medic Afya (Afya). We continue to be proactively engaged with our community stakeholders to optimize and evolve the CHT platform to deliver scalable digital health delivery in Kenya.  


Medic is committed to evolving the CHT architecture and continues to work in partnership with stakeholders to address challenges around eCHIS storage, sync performance, interoperability, the gradual replacement of CouchDB and long-term scalability.

We will do this iteratively and responsibly — each step delivering measurable improvements while progressively reducing dependency on CouchDB, until it is fully replaced.
What’s working
The CHT's core strengths remain sound and will carry forward:
Offline-first architecture: CHPs can collect and access data without connectivity — this is non-negotiable and will be preserved in any future architecture
CHP-centered workflow engine: The forms, tasks, targets, and care guide system that drives frontline health delivery is proven and stays
Configurable and adaptable: Partners can customize workflows for their context — this flexibility is a core differentiator
Open-source governance: The CHT is open-source and belongs to a global community of 47 organizations across 24 countries, 
The CHT application itself: What CHPs see and use on their phones — the app experience — does not change. 
The evolution we're proposing targets the data layer — not a rebuild of the entire platform. What we are strengthening is the underlying database and data layer that powers the platform behind the scenes.
What we’ve already delivered
The CHT v5.x has proven performance multiplier already live on 38/47 Kenya instances with measurable results from the first 25 upgraded.

Key Findings at a Glance
Instances covered in this report
25
Instances with improved system load
19 of 25 (76%)
Average system load reduction (improving instances)
~52%
Average improvement in 50th percentile replication
~74%
Average improvement in 90th percentile replication
~68%
Average improvement in max replication time
~54%
Instances with higher disk efficiency
21 of 22 (95%)


Standout examples: Makueni saw 99% improvement in P50 replication. Nyeri went from 143s to 3.3s at P50. Nyamira dropped from 115s to 2.2s. These are production results from live eCHIS instances serving CHPs.
Additional improvements already delivered:
CHT 5.0 Nouveau indexing: Up to 35% disk savings on large instances
CHT Sync: Replaced legacy couch2pg pipeline with improved data synchronization and monitoring
Hosting cost calculator: Realistic hosting TCO calculations based on eCHIS Kenya production data.
The full performance comparison report across 25 upgraded instances is available as a companion document.

We are waiting for the remaining large instances to complete upgrades before conducting a comprehensive analysis — this will serve as the baseline for all subsequent improvements.
The stabilization needs
Storage growth
CouchDB's indexes are significantly larger than comparable databases. This is because CouchDB allows emitting multiple keys per document and very large calculated values — flexibility that comes at a storage cost. Additionally, indexes are not sorted during rebuilds (e.g. during upgrades), causing them to be much larger than necessary. In CouchDB, an index is effectively another database — every index added creates additional storage overhead.

For comparison: indexes in Postgres (observed via CHT Sync) are much smaller than their CouchDB equivalents — by orders of magnitude — though a one-to-one comparison is difficult given CouchDB's greater flexibility.
Compaction
CouchDB uses an append-only storage model that stores multiple document versions until reclaimed through compaction. Compaction requires up to 2x the storage of the database being compacted (see CouchDB docs). While CouchDB runs compactions sequentially to limit impact, in practice, compaction often degrades service quality (we observed that apdex scores drop when compaction coincides with active syncing). Kenya instances have been configured to run compaction only at night, which helps, but means compaction can span multiple days before completing.

The severe compaction failures experienced in 2025 were likely caused by a CouchDB bug that appears to have been resolved in later versions. However, compaction remains operationally disruptive at scale.
Sync overhead
The current authorization function used in CHT syncing — which determines which documents offline clients need to download — scales in a complex way that is not simply related to the amount of data being transferred. Download sync must verify all documents a user has access to against the full database, meaning users with access to large numbers of documents can cause disproportionate CPU and performance impact.

Upload sync is efficient (changes push immediately as users submit reports). Download sync runs on a 5-minute timer specifically because of its heavier cost. The core issue: sync does not yet scale proportionally to the actual work being done, which is a fundamental constraint for truly large instances.
Specialized knowledge required
CouchDB requires deep, specialized expertise to be deployed and troubleshoot at scale — including knowledge of sharding, ddocs, compaction tuning, and view architecture. This creates a barrier for MoH and partner technical teams who need to maintain and operate eCHIS independently. Seemingly innocuous actions (e.g. adding a view to a design document) can trigger full re-indexing and cause severe downtime — something that has already happened in production a few months ago.
Interoperability constraints
Current interoperability workflows face challenges primarily on the write side — sending data back to CouchDB so CHPs can see referral results and other integrated data. Postgres (via CHT Sync) currently lags CouchDB by 2-3 days, making it unreliable as a data source for interoperability and impacting analytics. This forces all interoperability work to read from and write to CouchDB directly, limiting flexibility and performance.

Interoperability and syncing effectiveness are also limited by the fact that CHPs do not sync their data in real time due to connectivity challenges and a lack of airtime/data bundles (whitelisting) to allow them to submit their collected data free of cost.

Phased roadmap
Phase 1: Lay the Foundation (Now – TBD 2026)
Goal: Deliver significant relief on the most acute pain points while laying the groundwork for deeper architecture changes.

Complete v5.x upgrades across all 47 county instances and establish a performance baseline — updated numbers on replication, disk space, compute, and sync health across all instances. Every subsequent decision will be grounded in this data.

Implement data archiving: Move historical documents to Postgres, significantly reducing CouchDB storage size, index overhead, and sync times. The Medic engineering team is highly confident this will yield substantial results across the board — storage, indexing, and sync all improve when databases are smaller. This is the single highest-impact item in the near term. (GitHub issue)

Refactor the largest indexes: Targeted work on the most storage-intensive CouchDB indexes. Reduces their size and, for indexes that can be removed entirely, eliminates migration burden in later phases. (GitHub issue)

Expand the cht-datasource API abstraction layer: Decoupling application logic from direct CouchDB dependency. This also directly improves interoperability — cht-datasource provides REST APIs that external systems can query directly for the data they need, replacing the current reliance on outbound pushes, older APIs, and querying CouchDB databases that weren't designed for interoperability workflows. (GitHub issues)

Deliver improved monitoring and alerting across all instances via CHT Watchdog.

Ownership: Medic (CHT platform) · Medic Afya (rollout, monitoring, field feedback)
Phase 2: Build the New Data Layer (TBD – TBD 2026)
Goal: Make Postgres a first-class data source with real-time writes, enabling accurate data on which workflows perform better in which database.
Investigate and implement real-time transactional writes to Postgres — moving from the current delayed CHT Sync pipeline to a system where Postgres has current data. This is a prerequisite for moving any meaningful functionality away from CouchDB. (GitHub issue)
Enable cht-datasource to use Postgres directly, reducing reliance on CouchDB map-reduce views for data access. *This phase might temporarily increase disk usage (running two databases in parallel) — but the storage savings from Phase 1 should offset this.
Note: This is significant engineering work. The data structure for Postgres needs to be carefully designed, as it will determine what workflows can be migrated. Not all functionality currently in CouchDB can be naively replicated — eventual consistency, real-time requirements, and workflow dependencies all need to be accounted for.

Ownership: Medic (architecture & development) · CHU4UHC Technical Working Group & CHT Community (review)
Phase 3: Workflow Migration & Architecture Assessment (TBD 2026 – TBD 2027)
Goal: Based on Phase 2 results, systematically assess and migrate workflows between data sources.

Assess performance of workflows across both databases — evaluate against hosting TCO, performance, sync reliability, and scalability criteria. Determine which workflows are faster, more reliable, or more cost-effective in Postgres versus CouchDB.

Migrate workflows from CouchDB to Postgres where the evidence supports it. This is the phase where we prove the CHT can support 100,000+ users on a single instance — the capability that unlocks true national scale, not just for Kenya, but for any country using the CHT. Today, Kenya runs 47 separate instances because a single instance cannot handle the load. Eliminating that constraint is the ultimate goal.

Pilot the new architecture with real users in at least two counties, with clear evaluation criteria and a structured feedback loop. 

As a result, one data source could be fully retired. If CouchDB no longer serves a purpose that Postgres (or another database) cannot handle better, it will be removed. This decision will be driven by evidence, not predetermined.

Ownership:  Medic · Medic Afya · Community contributors
Phase 4: Complete the Transition (TBD – TBD 2027)
Goal: Complete CouchDB replacement and prepare for government handover.
Finalize the new architecture based on pilot learnings
Phased migration of remaining instances
Change management support for CHPs and county teams
Documentation and handover preparation ahead of August 2027 elections
Position the revamped CHT as the proven, scalable, open-source platform for national community health systems — backed by Kenya's experience as the reference deployment

Ownership:  Medic · Medic Afya

Evolving the data layer: exploring PostgreSQLWhy Postgres in phase 2
Postgres is our starting point for this evolution — not because we've concluded it's the final answer, but because it's the strongest candidate we have today, and we're not starting from zero.
We already use it. Postgres powers the CHT's analytics layer through CHT Sync. Every eCHIS instance already uses a Postgres database receiving replicated data from CouchDB. The infrastructure, tooling, and operational knowledge are already in place. This is not a greenfield experiment — it's an expansion of something that's already running in production across all 47 county instances.
Dramatically smaller indexes. Our own data shows that Postgres indexes are smaller than their CouchDB equivalents by orders of magnitude. CouchDB's flexibility — emitting multiple keys per document, storing large calculated values, and using append-only index files — comes at a significant storage cost. Postgres indexes are tightly encoded, sorted on write, and use well-established data types. While a one-to-one comparison isn't perfect (CouchDB's indexing is more flexible), the storage difference is substantial and directly relevant to the cost and scalability concerns stakeholders are raising.
ACID compliance and transactional integrity. Postgres is fully ACID-compliant, providing strict consistency guarantees that CouchDB's eventual consistency model does not. This matters for interoperability workflows where data accuracy and timeliness are critical — for example, referral results and integration (e.g. with SHA system) all require reliable, up-to-date data.
Widely understood and maintainable. Postgres is the most widely adopted open-source relational database in the world. MoH technical teams, partners, and the broader developer community are far more likely to have Postgres expertise than CouchDB knowledge. This directly addresses one of the key concerns raised — that CouchDB requires deep, specialized expertise that creates a dependency on Medic and makes independent maintenance difficult.
Strong ecosystem for interoperability. Postgres natively supports advanced indexing (B-tree, GIN, GiST), full-text search, and integrates well with health data standards like HL7 FHIR. These capabilities align with the interoperability requirements that eCHIS needs to meet.
Evolving offline-first landscape. While CouchDB's core strength has been its built-in offline sync via PouchDB, the landscape is shifting. We are not committing to any specific sync replacement today, but the ecosystem is moving in a direction that makes Postgres-based offline sync increasingly viable.

Postgres is not a drop-in replacement for CouchDB. CouchDB's offline-first sync protocol is deeply embedded in how the CHT works today, and replicating that functionality in Postgres is non-trivial. Postgres also uses MVCC and has its own compaction process (auto-vacuum), so some challenges are shared. Our phased approach exists precisely because we need to validate through real data and experimentation — not assumptions — that Postgres delivers on the promise at CHT scale. If evidence points to a different technology at any stage, we will adjust the roadmap accrodingly.
What we need
This is a significant undertaking that exceeds Medic's current capacity alone. To deliver on this timeline, we need:
Community co-development: Engaging CHT community partners and contributors in architecture design and development. The CHT does not belong to Medic — we need to bring everyone along in this journey.
External technical review: Independent architecture assessment to validate our approach and identify risks early. This was proposed in the CHU4UHC meeting, and we welcome it.
Additional resources: Dedicated engineering capacity, potentially through consultants, to augment the current team.
Funding: Support from eCHIS stakeholders and funders for the architecture work, with the understanding that improvements benefit the global CHT community across 24 countries, not just Kenya.
Medic Afya engagement: Active contribution of field data, performance feedback, and implementation insights. This input is essential for validating that architecture improvements translate into real-world gains for CHPs.
Our approach: iterative and evidence-based 
We are not presenting a finished architecture. We are presenting a phased process to get there, grounded in:
Evidence from production: Every decision will be informed by real data from live eCHIS instances, not theoretical benchmarks. We will establish baselines and measure against them at each phase.
Lessons learned: Our experience with CHT architecture changes — including efforts that were abandoned because they introduced more risk than they solved — has taught us that careful iteration beats ambitious rewrites.
Transparency: We will share progress, findings, and setbacks openly with the community at each phase. If something doesn't work, we acknowledge it and adjust.
Fail fast, adjust course: We start with Postgres as the most likely candidate to replace CouchDB, but if evidence points to a different technology, we will adjust. The phased approach exists precisely so that each step informs the next, rather than committing to a multi-year plan that cannot adapt.
The CHT helped Kenya do what seemed impossible — digitizing community health at national scale. The architecture that got us here needs to evolve, and we are committed to leading that evolution. This roadmap is our commitment to building the CHT that powers the next decade of community health — in Kenya and beyond.
Additional reading