# Advising-model benchmark — report

Run started: 2026-07-23T16:20:59.462Z
Trials per (model, scenario) cell: 20
Models: gptoss-120b, qwen-agentworld-35b-a3b, qwen3.6-35b-a3b-fp8, spark-qwen3.6-35b-a3b
Scenarios: S1, S2, S3, S4, S5
Tool surface loaded for this run: 24 tools (bare names, real advisor bridge)

> **What this does and does not establish.** This is a screen to shortlist 1-2 deployable models for deeper testing, not a final verdict. Complex multi-step advising questions are expensive to run, so per-scenario n is modest here and the resulting intervals are wide. Every rate below is per (model, scenario) — this report never prints, and this codebase's aggregator refuses to compute, a rate pooled across scenarios.

## S1

Prompt: A student is interested in GC 3400, the section that meets Monday/Wednesday at 10:10. How many credit hours is it, and can she still get a seat?

Behavioral criterion (judge): States the correct credit hours AND explicitly flags that the section has 0 seats available (full) — does not invent or omit seat availability.

**Anchor:** ```json
{
  "creditHours": 4,
  "seatsAvailable": 0
}
```

**Reference (gpt-5.4, one example of a good answer):** ok

| model | n | ok | malformed | no_tool_call | http_error | unparseable | malformed rate (95% CI) | tool-call success (95% CI) | latency p50/p95 | judge mean (scored/unscored) | steady |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|
| gptoss-120b | 20 | 15 | 0 | 5 | 0 | 0 |   0% [  0- 16] |  75% [ 53- 89] | 648 / 1690 ms | 3.75 (scored 20, unscored 0) | yes |
| qwen-agentworld-35b-a3b | 20 | 20 | 0 | 0 | 0 | 0 |   0% [  0- 16] | 100% [ 84-100] | 3624 / 14469 ms | 5.00 (scored 20, unscored 0) | yes |
| qwen3.6-35b-a3b-fp8 | 20 | 20 | 0 | 0 | 0 | 0 |   0% [  0- 16] | 100% [ 84-100] | 1143 / 2924 ms | 5.00 (scored 20, unscored 0) | yes |
| spark-qwen3.6-35b-a3b | 20 | 20 | 0 | 0 | 0 | 0 |   0% [  0- 16] | 100% [ 84-100] | 2765 / 6033 ms | 4.95 (scored 20, unscored 0) | yes |

Token means (prompt / completion), per model:
- gptoss-120b: 11966 / 448
- qwen-agentworld-35b-a3b: 19485 / 1904
- qwen3.6-35b-a3b-fp8: 19836 / 767
- spark-qwen3.6-35b-a3b: 19483 / 818

### S1 deterministic calibration (fabrication-probe extractors vs anchor)

Reuses `extractCredits`/`extractSeatCap` on each answer, compared to the live anchor. `extractSeatCap` targets ENROLLMENT-CAP language, not seats-REMAINING language (this scenario's anchor fact) — a high not-extracted count for seats is expected and is not itself evidence of anything about the model; see the report's concerns section.

| model | credits match (95% CI over extracted) | seats match (95% CI over extracted) |
|---|---|---|
| gptoss-120b | 10/10 100% [ 72-100] (not-extracted: 10) | 0/4   0% [  0- 49] (not-extracted: 16) |
| qwen-agentworld-35b-a3b | 20/20 100% [ 84-100] (not-extracted: 0) | 0/2   0% [  0- 66] (not-extracted: 18) |
| qwen3.6-35b-a3b-fp8 | 17/17 100% [ 82-100] (not-extracted: 3) | 0/10   0% [  0- 28] (not-extracted: 10) |
| spark-qwen3.6-35b-a3b | 18/18 100% [ 82-100] (not-extracted: 2) | 0/3   0% [  0- 56] (not-extracted: 17) |

## S2

Prompt: She wants to add GC 4060, Tuesday/Thursday at 11.

Behavioral criterion (judge): Asks a clarifying question distinguishing the two sections that share this time slot (regular vs Honors) rather than silently picking one.

**Anchor:** ```json
{
  "count": 2,
  "crns": [
    "80833",
    "83836"
  ]
}
```

**Reference (gpt-5.4, one example of a good answer):** ok

| model | n | ok | malformed | no_tool_call | http_error | unparseable | malformed rate (95% CI) | tool-call success (95% CI) | latency p50/p95 | judge mean (scored/unscored) | steady |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|
| gptoss-120b | 20 | 12 | 0 | 8 | 0 | 0 |   0% [  0- 16] |  60% [ 39- 78] | 873 / 2935 ms | 2.10 (scored 20, unscored 0) | yes |
| qwen-agentworld-35b-a3b | 20 | 18 | 0 | 2 | 0 | 0 |   0% [  0- 16] |  90% [ 70- 97] | 5268 / 8701 ms | 3.35 (scored 20, unscored 0) | yes |
| qwen3.6-35b-a3b-fp8 | 20 | 17 | 0 | 3 | 0 | 0 |   0% [  0- 16] |  85% [ 64- 95] | 1559 / 2913 ms | 3.90 (scored 20, unscored 0) | yes |
| spark-qwen3.6-35b-a3b | 20 | 20 | 0 | 0 | 0 | 0 |   0% [  0- 16] | 100% [ 84-100] | 3595 / 6973 ms | 4.55 (scored 20, unscored 0) | yes |

Token means (prompt / completion), per model:
- gptoss-120b: 10447 / 593
- qwen-agentworld-35b-a3b: 19172 / 2213
- qwen3.6-35b-a3b-fp8: 17464 / 760
- spark-qwen3.6-35b-a3b: 19412 / 925

## S3

Prompt: Here is her current schedule (pasted from the advising profile): [...]

Behavioral criterion (judge): Correctly resolves each pasted CRN — including the screen-reader cruft glued directly onto it — to its section, and correctly states which of the three candidate courses fit without a schedule conflict.

**Anchor:** ```json
{
  "fits": [
    "GC3730"
  ],
  "conflicts": [
    "GC3720",
    "GC3630"
  ],
  "byCourseCrn": {
    "GC3720": "85064",
    "GC3630": "91649",
    "GC3730": "85065"
  }
}
```

**Reference (gpt-5.4, one example of a good answer):** ok

| model | n | ok | malformed | no_tool_call | http_error | unparseable | malformed rate (95% CI) | tool-call success (95% CI) | latency p50/p95 | judge mean (scored/unscored) | steady |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|
| gptoss-120b | 20 | 0 | 0 | 0 | 0 | 20 |   0% [  0- 16] | 100% [ 84-100] | 891 / 1678 ms | 1.00 (scored 10, unscored 10) | yes |
| qwen-agentworld-35b-a3b | 20 | 20 | 0 | 0 | 0 | 0 |   0% [  0- 16] | 100% [ 84-100] | 10736 / 24507 ms | 1.00 (scored 20, unscored 0) | yes |
| qwen3.6-35b-a3b-fp8 | 20 | 20 | 0 | 0 | 0 | 0 |   0% [  0- 16] | 100% [ 84-100] | 3479 / 5894 ms | 4.26 (scored 19, unscored 1) | yes |
| spark-qwen3.6-35b-a3b | 20 | 8 | 10 | 1 | 0 | 1 |  50% [ 30- 70] |  40% [ 22- 61] | 9628 / 61219 ms | 1.80 (scored 20, unscored 0) | yes |

Token means (prompt / completion), per model:
- gptoss-120b: 33038 / 1000
- qwen-agentworld-35b-a3b: 14485 / 4208
- qwen3.6-35b-a3b-fp8: 26136 / 2065
- spark-qwen3.6-35b-a3b: 12227 / 2212

## S4

Prompt: Here is her current schedule (pasted from the advising profile): [...]

Behavioral criterion (judge): Surfaces the counterfactual: that switching her current GC 4061 lab section to an alternate (MW) section would free up adding the target course, rather than simply reporting a conflict and stopping there.

**Anchor:** ```json
{
  "currentConflicts": true,
  "freeingSections": [
    "80836",
    "80837"
  ]
}
```

**Reference (gpt-5.4, one example of a good answer):** ok

| model | n | ok | malformed | no_tool_call | http_error | unparseable | malformed rate (95% CI) | tool-call success (95% CI) | latency p50/p95 | judge mean (scored/unscored) | steady |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|
| gptoss-120b | 20 | 1 | 0 | 0 | 0 | 19 |   0% [  0- 16] | 100% [ 84-100] | 886 / 1430 ms | 1.40 (scored 10, unscored 10) | yes |
| qwen-agentworld-35b-a3b | 20 | 19 | 0 | 0 | 0 | 1 |   0% [  0- 16] | 100% [ 84-100] | 13843 / 51884 ms | 1.63 (scored 19, unscored 1) | yes |
| qwen3.6-35b-a3b-fp8 | 20 | 19 | 0 | 0 | 0 | 1 |   0% [  0- 16] | 100% [ 84-100] | 3302 / 9342 ms | 2.00 (scored 20, unscored 0) | yes |
| spark-qwen3.6-35b-a3b | 20 | 0 | 12 | 7 | 0 | 1 |  60% [ 39- 78] |   0% [  0- 16] | 8412 / 75405 ms | 1.00 (scored 20, unscored 0) | yes |

Token means (prompt / completion), per model:
- gptoss-120b: 33257 / 1142
- qwen-agentworld-35b-a3b: 27647 / 10800
- qwen3.6-35b-a3b-fp8: 35565 / 2631
- spark-qwen3.6-35b-a3b: 6648 / 2636

## S5

Prompt: Here is her current schedule (pasted from the advising profile): [...]

Behavioral criterion (judge): Respects BOTH hard constraints (no meeting before 9:00 a.m., nothing on Fridays) and offers requirement-eligible options, without falsely claiming nothing fits when a valid option existed.

**Anchor:** ```json
{
  "program": "Graphic Communications, BS",
  "catalogYear": "2025-2026",
  "explicitEligible": [
    "ART1030",
    "ART2130",
    "ART2150",
    "ART3130",
    "ART3150",
    "ART4130",
    "ART4150",
    "COMM1010",
    "COMM2010",
    "COMM3280",
    "COMM3680",
    "DPA3070",
    "DPA4000",
    "DPA4010",
    "DPA4020",
    "DPA4030",
    "ECON3060",
    "ENGL3570",
    "ENGL4500",
    "ENGL4510",
    "GC1990",
    "GC2510",
    "GC2990",
    "GC3450",
    "GC3510",
    "GC3600",
    "GC3620",
    "GC3720",
    "GC3730",
    "GC3760",
    "GC3990",
    "GC4070",
    "GC4450",
    "GC4510",
    "GC4900",
    "GC4990",
    "MGT3060",
    "MGT3180",
    "MGT3500",
    "MGT3510",
    "MGT4110",
    "MGT4500",
    "MGT4540",
    "MKT3020",
    "MKT3240",
    "MKT3250",
    "MKT3980",
    "MKT4220",
    "MKT4240",
    "MKT4430",
    "MKT4950",
    "PKSC2200",
    "PKSC3200",
    "PKSC4990",
    "THEA2670",
    "THEA2780",
    "THEA3670",
    "THEA4670",
    "THEA4870",
    "THEA4880"
  ],
  "validSet": [
    {
      "course": "ART2130",
      "crn": "81175"
    },
    {
      "course": "ART2150",
      "crn": "85269"
    },
    {
      "course": "ART3130",
      "crn": "81182"
    },
    {
      "course": "ART3150",
      "crn": "87853"
    },
    {
      "course": "ART4130",
      "crn": "81194"
    },
    {
      "course": "ART4150",
      "crn": "87854"
    },
    {
      "course": "COMM1010",
      "crn": "82328"
    },
    {
      "course": "COMM2010",
      "crn": "80864"
    },
    {
      "course": "COMM3280",
      "crn": "87175"
    },
    {
      "course": "COMM3280",
      "crn": "90750"
    },
    {
      "course": "COMM3280",
      "crn": "90814"
    },
    {
      "course": "DPA3070",
      "crn": "84506"
    },
    {
      "course": "DPA4000",
      "crn": "81976"
    },
    {
      "course": "DPA4020",
      "crn": "83808"
    },
    {
      "course": "GC3450",
      "crn": "86556"
    },
    {
      "course": "GC3600",
      "crn": "86550"
    },
    {
      "course": "GC3620",
      "crn": "87720"
    },
    {
      "course": "GC3720",
      "crn": "85064"
    },
    {
      "course": "GC3730",
      "crn": "85065"
    },
    {
      "course": "GC3760",
      "crn": "88521"
    },
    {
      "course": "GC4900",
      "crn": "88328"
    },
    {
      "course": "GC4900",
      "crn": "88518"
    },
    {
      "course": "GC4900",
      "crn": "92125"
    },
    {
      "course": "GC4990",
      "crn": "92196"
    },
    {
      "course": "MGT3180",
      "crn": "81815"
    },
    {
      "course": "MGT3180",
      "crn": "84194"
    },
    {
      "course": "MGT3180",
      "crn": "88053"
    },
    {
      "course": "MGT3180",
      "crn": "89532"
    },
    {
      "course": "MGT3500",
      "crn": "83928"
    },
    {
      "course": "MGT4110",
      "crn": "91472"
    },
    {
      "course": "MKT3020",
      "crn": "80217"
    },
    {
      "course": "MKT3020",
      "crn": "80267"
    },
    {
      "course": "MKT3020",
      "crn": "86855"
    },
    {
      "course": "MKT3020",
      "crn": "90605"
    },
    {
      "course": "MKT3020",
      "crn": "92014"
    },
    {
      "course": "MKT3020",
      "crn": "92015"
    },
    {
      "course": "MKT3020",
      "crn": "92016"
    },
    {
      "course": "MKT3240",
      "crn": "89945"
    },
    {
      "course": "MKT3240",
      "crn": "89946"
    },
    {
      "course": "MKT3240",
      "crn": "89947"
    },
    {
      "course": "MKT3240",
      "crn": "89948"
    },
    {
      "course": "MKT3250",
      "crn": "88887"
    },
    {
      "course": "MKT3250",
      "crn": "88889"
    },
    {
      "course": "MKT3250",
      "crn": "88890"
    },
    {
      "course": "MKT3250",
      "crn": "88891"
    },
    {
      "course": "MKT3980",
      "crn": "87515"
    },
    {
      "course": "MKT3980",
      "crn": "88181"
    },
    {
      "course": "MKT3980",
      "crn": "92038"
    },
    {
      "course": "MKT3980",
      "crn": "92212"
    },
    {
      "course": "MKT3980",
      "crn": "92219"
    },
    {
      "course": "MKT4220",
      "crn": "85468"
    },
    {
      "course": "MKT4220",
      "crn": "89955"
    },
    {
      "course": "MKT4220",
      "crn": "89956"
    },
    {
      "course": "MKT4240",
      "crn": "80733"
    },
    {
      "course": "MKT4240",
      "crn": "92322"
    },
    {
      "course": "MKT4950",
      "crn": "92115"
    },
    {
      "course": "THEA2780",
      "crn": "80098"
    },
    {
      "course": "THEA4870",
      "crn": "88700"
    }
  ]
}
```

**Reference (gpt-5.4, one example of a good answer):** ok

| model | n | ok | malformed | no_tool_call | http_error | unparseable | malformed rate (95% CI) | tool-call success (95% CI) | latency p50/p95 | judge mean (scored/unscored) | steady |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|
| gptoss-120b | 20 | 0 | 0 | 19 | 0 | 1 |   0% [  0- 16] |   0% [  0- 16] | 1420 / 2316 ms | 1.90 (scored 20, unscored 0) | yes |
| qwen-agentworld-35b-a3b | 20 | 0 | 0 | 0 | 0 | 20 |   0% [  0- 16] | 100% [ 84-100] | 28877 / 57019 ms | 1.00 (scored 20, unscored 0) | yes |
| qwen3.6-35b-a3b-fp8 | 20 | 9 | 0 | 0 | 0 | 11 |   0% [  0- 16] | 100% [ 84-100] | 9998 / 100556 ms | 1.94 (scored 18, unscored 2) | yes |
| spark-qwen3.6-35b-a3b | 20 | 0 | 17 | 3 | 0 | 0 |  85% [ 64- 95] |   0% [  0- 16] | 15280 / 76261 ms | 1.05 (scored 20, unscored 0) | yes |

Token means (prompt / completion), per model:
- gptoss-120b: 4919 / 312
- qwen-agentworld-35b-a3b: 46186 / 18010
- qwen3.6-35b-a3b-fp8: 66928 / 8809
- spark-qwen3.6-35b-a3b: 6642 / 2399

## Watch items and honesty notes

- **Same-family judge bias risk:** the judge (`judge-gpt-5.5`) and the reference (`reference-gpt-5.4`) are both OpenAI-architecture models. `gptoss-120b`'s judge scores carry a possible same-family bias (an OpenAI-family judge favoring OpenAI-architecture output) that blinding the candidate's identity does NOT correct for — blinding removes model-identity bias, not architecture-family bias. Read `gptoss-120b`'s quality scores with that in mind, not as directly comparable to the qwen family's scores.
- No UNSTEADY endpoint cells in this run.
- No UNAVAILABLE anchors in this run.
- No UNAVAILABLE references in this run.
- **Unscored judge verdicts (couldn't-establish, NOT a low score):**
  - `gptoss-120b/S3`: 10 unscored of 20 — e.g. "qualityScore missing or not a finite number (got undefined)"
  - `qwen3.6-35b-a3b-fp8/S3`: 1 unscored of 20 — e.g. "judge response has no message content (choices=[{"index":0,"message":{"role":"assistant","content":"","refusal":null,"annotations":[]},"finish_reason":"length"}])"
  - `gptoss-120b/S4`: 10 unscored of 20 — e.g. "qualityScore missing or not a finite number (got undefined)"
  - `qwen-agentworld-35b-a3b/S4`: 1 unscored of 20 — e.g. "judge response has no message content (choices=[{"index":0,"message":{"role":"assistant","content":"","refusal":null,"annotations":[]},"finish_reason":"length"}])"
  - `qwen3.6-35b-a3b-fp8/S5`: 2 unscored of 20 — e.g. "judge response has no message content (choices=[{"index":0,"message":{"role":"assistant","content":"","refusal":null,"annotations":[]},"finish_reason":"length"}])"
- n per cell and CI width: every rate above is Wilson-scored on the n shown in that row's `n` column, per (model, scenario) — never pooled across scenarios or across models. At modest n (especially any run below 20 trials/cell) intervals are WIDE; read the interval, not just the point estimate.
- S5's per-suggestion classifier (`classifySuggestion`, Task 1) is NOT used here as a free-text extractor over candidate answers — per the approved design, S5's primary signal is the judge scored against the anchor's `validSet`/`explicitEligible` ground truth, to avoid building a brittle parser over open-ended model prose.

_This report does not recommend a model. It screens; the operator decides._
