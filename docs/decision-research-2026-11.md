# Decision-model research, November 2026

What we read before the v4 decision layer, what we built from it, and what we left for later. Sources were read as
abstracts or summaries unless noted; numbers quoted from them are theirs, not ours.

## Built

| Change | Why | Source |
|---|---|---|
| One value model (CoD ÷ effort + flow) instead of Borda over 8 frameworks | Five of the frameworks divide by effort, so they are not independent voters; Borda over them mostly re-weighted effort. Frameworks stay as explanations. | Reinertsen / Arnold, CD3 ([Black Swan Farming](https://blackswanfarming.com/cost-of-delay-divided-by-duration/)) |
| P(top 5), P(first), rank range by seeded simulation | A single order hides close calls; rank uncertainty is standard Bayesian ranking practice. Certified / unresolved top-k is a 2026 theme. | [arXiv 2605.29395](https://arxiv.org/pdf/2605.29395) (May 2026) |
| Bold bet = argmax E[max(V − V₁, 0)] among unproven tasks | cdm's innovation slot: unknown is not risky; test it rather than veto it. | `~/creative-decision` MATH.md §3, L6 |
| Preposterior VOI for check-in questions | Ask where the expected answer changes the top of the list, weighted by belief, not where it could swing in the extreme. | Dong et al., ACL 2026 ([2601.06407](https://arxiv.org/html/2601.06407v1)) |
| Shrinkage for level bias; effort as a log-ratio by Bayesian regression on size | Overruns are multiplicative and size-dependent; two founders produce few outcomes, so a hard "3 data points" rule wastes the first two and over-trusts the third. | Halkjelsvik & Jørgensen 2018 ([OAPEN](https://library.oapen.org/handle/20.500.12657/42903)); Ernst 2018 ([1804.02443](https://www.arxiv.org/pdf/1804.02443)) |
| Temperature fitted from outcomes | Jev is trained for calibration (RLCD), but Orion tempers by a fixed 1.3; the fit tells us which is right on our data. | cdm `Calibrator.fit` (MATH.md B2) |
| Forecast ledger, ranked probability score, skill vs. uniform | Judges can be highly consistent and still biased; silent model updates shift scores. Only outcomes tell. | [2606.19544](https://arxiv.org/abs/2606.19544) (Jun 2026); [2504.19076](https://arxiv.org/pdf/2504.19076) |
| Order-disagreement measured, used to widen beliefs | Jev docs: Score levels are judged one at a time, so reversal may be unnecessary on 1.14; cdm's 1.13 audit found a direction bias. First live run: JS divergence 0.003–0.04. | docs.typesafe.ai primitives/score; cdm README |
| Lens moved from state to instructions; situation criteria for defensibility and quality; Score confidence formula | Jev docs: state is data; "describe situations, not degrees"; documented distance-aware confidence. | docs.typesafe.ai concepts/state, primitives/score, confidence |

## Not built, and why

- **Never extremize the two level orders.** Same model, same information: extremizing helps only when sources know
  different things (Satopää 2014). Tempering is the right direction.
- **Pairwise comparisons for close calls** (soft Bradley–Terry on pairs with P(i > j) ∈ [0.35, 0.65]). Evidence is
  mixed: pairwise preferences flipped ~35% under distractors vs ~9% for absolute scores ([2504.14716](https://arxiv.org/abs/2504.14716)).
  Worth trying once the ledger shows where the close calls are.
- **Founder-fitted CoD weights.** The weights (impact 2, others 1) give impact WSJF's one-third share. Fitting them
  to the founders' own "which first?" choices is the principled next step.
- **Splitting Orion's multi-part questions** (effort, leverage, urgency each ask several things; Jev docs call atomic
  questions "probably the most important concept"). They are shared with Orion, so the change belongs there.
- **Beta calibration per dimension** (Kull 2017): after ~15 outcomes per dimension; isotonic needs hundreds.
- **CVaR risk lens, weekly knapsack plan, 2-hop re-judging**: useful once the graph is denser.
- **Dropping the reversed order**: decide from the ledger's disagreement after a few weeks of real judgments.
- **Other decision models** (Cloudflare Clef, Strands Decider, Laya; all Sep–Oct 2026): calibration claims are the
  vendors'. Run one beside Jev through the ledger before switching.
