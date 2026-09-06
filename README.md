# Vita Radar

A daily deadline radar for one person's fellowship, MD/PhD, conference and
venture pipeline, running on free GitHub infrastructure. A scheduled Action
resolves 37 hand-verified programs out of `config/deadlines.yml`, works out what
is due and what needs confirming, ranks everything by how close it is rather than
how new it is, commits the result to this repo, writes a subscribable calendar
feed, and emails you one message every morning.

It exists because a missed news story costs nothing and a missed Rhodes
endorsement deadline costs a year. Everything in here follows from that
asymmetry.

---

## THE ONE RULE

**`config/deadlines.yml` is the source of truth for every date. Scrapers and
Claude are change-detectors layered on top of it. They may raise a flag; they may
never write a date.**

> A model may move a date toward a human, never toward an alert.

This is not caution for its own sake. It is what a morning of live probing found,
all on 2026-08-22:

| Host | What actually happens |
| --- | --- |
| `rhodeshouse.ox.ac.uk` | Renders fine, states **no date at all** — just "Applications for the Rhodes Scholarship 2027 are open!" |
| `rhodesscholar.org/applying-for-the-scholarship` | 301s to a different domain; the date is inside a PDF, three hops in |
| `gatescambridge.org/apply/` | 302s to `http://www.gatescambridge.org///` — downgraded scheme, triple slash — and lands on the homepage. A scraper that follows redirects extracts nothing and reports zero |
| `nucleate.org` | "Deadline for US chapters is October 21st" — **no year** — directly beside a "2024 COHORT" block |
| `uraf.harvard.edu` | Hard WAF **403 on every path, including `robots.txt`** |
| `broadinstitute.org` | Same: hard 403, every path |
| AAMC | HTTP **200** with a 3,038-byte F5/Shape "Client Challenge" body, so a naive monitor calls it healthy forever |
| `agingpharma.org/registration` | "The deadline is August 31" — no year — while the tidier `/deadline` page is frozen on 2025 |

Seven of those eight fail *silently*. A scraper pointed at them returns zero
items or a plausible wrong answer, and both look exactly like "nothing is due
today". These are roughly 45 rows that change once a year: scraping them trades
an hour a year of typing for an unbounded, unfalsifiable, silent-failure risk.

So the pipeline is a change-detector over a human-maintained file. When a page
disagrees with the YAML, that becomes a `discrepancy` on the item and a line in
the Verify block. It never becomes the date.

**Worked example of why this earns its keep.** The master timeline for this
project said ARDD 2026 was in Copenhagen, August 24–28, with an abstract deadline
of August 10. Verified live on 2026-08-22, all three are wrong: **ARDD 2026 is
October 1–3, 2026, at the David Rubenstein Treehouse, Harvard University, in
Boston**, and the abstract deadline is August 31. Acting on the old dates would
have meant skipping a conference held twenty minutes away. Also worth knowing:
`ardd.eu` is an unrelated French sustainable-development NGO, so a fuzzy search
lands you on the wrong organisation entirely.

---

## What runs today

Three layers, in strict order of how much you should trust them.

**1. The deadline tracker — no network, no model.** A pure function of
`config/deadlines.yml` and the clock: 37 programs, the countdown strip, the
Verify block, the subject-line escalation and `out/calendar.ics`. Every feed on
earth can 403 and this half is unchanged. It is why the project shipped in this
order.

**2. Sources — 29 feeds and 13 watched pages.** News narrowed hard to causal
human genetics, single-cell epigenomics and the tools/venture angle (the broad
industry feed is `biotech-insights`' job); ATS job boards for the FROs and the
genomics/aging companies; cycle early-warning from SDN, Gates Cambridge, PD
Soros, Schmidt and the NIH Guide. The 13 program pages are **hashed, never
parsed** — a change becomes one Verify line asking a human to look.

**3. Catalysts and the opener — additive, and provably so.** FDA PDUFA and
AdCom dates from two public tracker calendars (1,553 and 243 events; ~65
upcoming, 14 on the watchlist). No prices: every keyless quote source turned out
unusable — Yahoo 429s even from residential IPs, Stooq answers 200 with a
SHA-256 proof-of-work challenge, Alpha Vantage allows 25 requests a *day*, and
Tiingo's free tier is licensed "internal use only" so emailing the numbers would
breach it. That turned out not to matter, because the dates were the valuable
half: a PDUFA date is the same kind of object as a deadline, so it runs through
the same countdown machinery instead of sitting in a price table nobody acts on.

`pipeline/llm/` is reached through a **dynamic** import, so the layer is
genuinely deletable — `rm -rf pipeline/llm && npm run pipeline` exits 0 with the
countdown intact. It was a static import first, which made that claim false in
the most complete way available: module resolution failed before `main()` ran
and no digest was written at all. `tests/llm.contract.test.ts` pins it.


## Quick start

```bash
npm install
npm run pipeline -- --dry-run       # resolve every deadline, write nothing
npm run pipeline                    # write data/digests/<year>/<date>.json
npm run email                       # preview the email to .preview/; sends nothing
npm run ics                         # write out/calendar.ics
npm run validate                    # schema-check everything under data/
```

Nothing above needs configuration. Sending mail needs SMTP credentials and an
explicit `--send`; see `.env.example`, where every variable says why it exists.

## How it works

```
Action (cron 10:47 America/New_York, catch-up 16:47, or dispatch)

  registry   37 programs, hand-verified        config/deadlines.yml   ← the file you edit
  compile    validate, collect ALL problems    pipeline/config/deadlines.ts
  resolve    cycle + timezone → an instant     pipeline/normalize/dates.ts
  project    roll a closed cycle forward       pipeline/deadlines/project.ts
  build      items, countdown rows, verify     pipeline/deadlines/build.ts
  detect     page changes, hashes  (phase 2)   pipeline/ingest
  score      urgency + gating + lexicon − pen  pipeline/score
  select     rung ladder, lane caps            pipeline/select
  emit       data/digests/YYYY/YYYY-MM-DD.json pipeline/state/store.ts ← the database
  calendar   out/calendar.ics                  lib/calendar
  email      auto-escaped HTML + text part     lib/email/render.ts
  commit     re-parent onto origin, no merge   scripts/commit-data.sh
  ping       dead-man's switch                 .github/workflows/pipeline.yml
```

Digests are stored at `data/digests/<YYYY>/<YYYY-MM-DD>.json`. The year shard is
not tidiness: github.com truncates a directory listing at 1,000 entries, and a
daily file reaches that in under three years — at which point the newest digests
become invisible in the web UI while remaining perfectly present in git.

## The inverted temporal model

This is the one section to read if you read only one.

A news reader scores **recency**: `2^(-age/halfLife)`, so an item is worth most
the moment it appears and decays from there. That is right for news and exactly
backwards here. Rhodes is worthless in April and unmissable on September 28th. An
opportunity's value **rises** as its deadline approaches and then goes to zero.

So the score is a function of days *remaining*:

```
urgency(d) = 1 / (1 + (d / leadDays) ^ 2.2)        0 beyond the horizon, 0 once passed
```

- **Exactly 0.5 at `leadDays`**, and `leadDays` is deliberately not "the
  deadline" but "the distance at which you should already be working on it" — 35
  days for a fellowship that needs letters, 21 for a conference abstract, 60 for
  MSTP because of secondaries. Anchoring the halfway point there makes the score
  say *start now* rather than *panic now*.
- **Projected dates are discounted** (×0.7) so a projection can never outrank a
  confirmed date at the same distance. That ordering is the entire value of
  tracking `confirmed`.
- **Month precision is discounted** (×0.6) and can never ring an alert:
  "September 2026" resolved to the 1st would fire an alarm on a day nothing is
  due.
- **`rolling` and `unknown` are separate named branches**, never a shared
  fallthrough. Both have no date and they mean opposite things: rolling needs no
  action ever, unknown means there *is* a deadline and we do not know it — the
  single most actionable state in the system.
- Page age is not consulted for an opportunity at all. A Rhodes page last edited
  in March is not stale in September, and the discriminated union in
  `lib/types.ts` is what makes it impossible to write that bug by accident.

### The rung ladder vs. the continuous strip

Urgency alone keeps Rhodes above the keep threshold for 400 consecutive days,
which is how a tracker becomes nagware and stops being read. Two different
mechanisms solve that, and the split is the design:

- **Cards are episodic.** A card is emitted only when the distance *crosses* a
  rung: `365, 180, 90, 60, 45, 30, 21, 14, 10, 7, 6, 5, 4, 3, 2, 1, 0`. Inside
  seven days every day is a rung, because at six days out a daily reminder is not
  noise.
- **The strip is continuity.** Every program inside 60 days gets a countdown row
  *every single day*, independent of the ladder, and the strip is the last thing
  shed when the email is trimmed to fit under Gmail's clipping limit.

The rung comparison direction is not cosmetic, and there is a test for it: the
rung just crossed is the *smallest* rung `>= daysUntil`. Written the other way
round — largest rung at or below the distance — the ladder cascades early, and
with no rung between 365 and 180 the 180-day card fires six months ahead of time.
Simulated over 401 days that produced cards at 400, 364, 179, 89… each one a rung
too soon. That is the specific failure that erodes trust in a countdown: the
reader learns the numbers are decorative.

One more thing the ladder does *not* run off: the headline deadline. It runs off
the earliest unmet **gating** step. Rhodes is the reason — Harvard's internal
endorsement deadline precedes the national one by weeks, and missing it ends the
application regardless of what October 1st says.

## How the alarms work

Seven mechanisms, because a scraper returning zero items reads identically to "no
new opportunities today". Silence has to be impossible.

1. **Daily positive confirmation.** An email goes out every day, new content or
   not. The countdown strip is always populated, so an empty inbox is
   unambiguously a broken pipeline rather than a quiet week. This is why the
   strip may never be shed.
2. **Zero-is-an-error.** A run that resolves no deadlines, or produces a digest
   it judges unfit, exits **2** — "unusable". The workflow then commits nothing
   and emails nothing, so the day stays retryable and the catch-up cron gets a
   real second attempt. `npm run validate` asserts the same invariant against
   committed data: a non-empty `stats.deadlinesTracked` with an empty countdown
   strip fails CI, because that is the shape a silent failure has.
3. **Per-row staleness.** Every program carries `verifiedOn`, and `verifyEvery`
   (default 90 days). Crossing it is an event, not a warning: the row moves to
   the **Verify** block at the *top* of the email with "Confirm this year's
   date". A projected date additionally carries `verifyBy`, set 60 days ahead of
   itself, so a projection announces its own expiry.
4. **Subject-line escalation.** Inside 14 days of a gating deadline, the subject
   line changes. A digest you skim and a digest you act on should not look the
   same in a notification, and only a `provenance: yaml` date at day-or-better
   precision is allowed to do this — `canAlert()` in `pipeline/score/temporal.ts`
   is THE ONE RULE expressed as a function.
5. **The subscribable `.ics`.** `out/calendar.ics` is committed, so it has a
   stable raw URL a phone can subscribe to. This is the only output that keeps
   working when *everything else here is broken*: alarms already synced into a
   calendar keep firing whether or not this workflow ever runs again.
6. **The dead-man's switch.** After a successful send, the workflow pings
   `HEALTHCHECK_URL`. If no ping arrives inside the grace window, somebody else's
   infrastructure emails you. Every other alarm in this repo shares a failure
   domain with the thing it watches — a filed issue needs the workflow to run at
   all — and this one does not. It survives the repo being disabled, the workflow
   being disabled, SMTP breaking, GitHub dropping the cron, and the runner never
   starting, because in all of those cases the ping simply does not arrive.
   Absence is the signal.
7. **The three-layer heartbeat.** GitHub disables scheduled workflows in a public
   repo after 60 days with no repository activity, and `commit-data.sh` exits 0
   *silently* when the tree is unchanged. So a run of quiet days producing
   byte-identical output would switch the cron off, and the resulting silence
   looks exactly like a quiet season for deadlines. Three layers: the daily data
   commit; every digest embedding the run date and the countdown integers, which
   change daily by construction so a quiet day still writes a genuinely different
   file; and `.github/dependabot.yml`, which pushes a pull request a week even if
   the pipeline has been dead for two months.

Failures that *are* observed get a filed issue, one per failure class with its
own title — unusable digest, crashed pipeline, failed data commit, failed email —
commenting on the open issue rather than opening a duplicate. Four titles rather
than one, because a daily cron that files a "pipeline failing" issue a day trains
you to ignore the one that matters.

## Where Claude is and is not allowed

Phase 3, no-op without `ANTHROPIC_API_KEY`, and fenced in four ways.

**Claude is a locator, not a reader of record.** Its job is to answer "where
would this year's date be published, given that the obvious page 403s?" — a URL,
a PDF three hops in, a contact address to email. Finding where to look is
genuinely hard and cheap to check. Reading a date off a page and recording it is
easy to do wrong and expensive to catch.

- **`proposed*` fields only.** A model-derived date lands in a proposal field
  with `provenance: "claude-proposed"`. It never overwrites a `Deadline.date`,
  and `DateProvenance` exists precisely so the renderer can tell the two apart.
- **A pull request for a human to merge.** The output is a diff against
  `config/deadlines.yml` with the evidence span quoted verbatim. A human reads
  the page, agrees, merges. Nothing writes that file unattended.
- **Never in the alert path.** `canAlert()` requires `provenance === "yaml"`, so
  a proposed date cannot ring the subject line or the calendar alarm no matter
  how confident it is.
- **Never in the score.** No `ScoreFactor.key` may start with `llm` or `claude`,
  and `npm run validate` fails CI if one does. That assertion is the
  machine-checkable statement of this whole design: ranking is a deterministic
  weighted sum whose every term is auditable, and with no model to trust,
  explainability is the trust mechanism.

The one place Claude writes prose the reader sees is the optional `editorial`
paragraph, which renders **last**, after the countdown and the verify block, so
it can never displace a date.

## Adding a program to `config/deadlines.yml`

The single highest-leverage thing you will do in this repo. Copy the shape below.

```yaml
  - id: some-fellowship            # stable, kebab-case; changing it re-delivers the row
    label: Some Fellowship (US)    # what the email prints
    org: Some Trust
    lane: fellowships              # fellowships | mstp-labs | venture-founder | conferences | ...
    status: active                 # active | watch | ruled-out | closed | submitted | won
    priority: high                 # `high` pins the row regardless of the keep threshold
    url: https://example.org/apply
    timeZone: Europe/London        # omit to inherit America/New_York
    verifiedOn: 2026-08-22         # the day YOU read the page. Update it when you re-read
    verifyEvery: 90                # omit to inherit 90 days
    eligibility:
      notes: >
        Prose, shown verbatim. The system NEVER computes eligibility.
      source: https://example.org/eligibility
    cycles:
      - year: 2027                 # the year the AWARD starts, not the year the page was written
        deadline: 2026-10-01
        confirmed: true            # true ONLY if a human read an explicit date on the page
        timeOfDay: "23:59"         # PD Soros closes 14:00 ET and that moves the answer
        precision: day             # minute | day | month | unknown
        evidence: "Applications close 1 October 2026 at 23:59 BST."   # verbatim, never paraphrased
        steps:
          - id: internal-endorsement
            label: Institutional endorsement
            gating: true           # missing this ends the application
          - id: national-app
            label: National application
            due: 2026-10-01
            gating: true
            precondition: internal-endorsement
    recurrence: { cadence: annual, anchor: "10-01" }
```

Then run `npm run pipeline -- --dry-run` and read the output. The loader collects
*every* problem and throws once with all of them, so a batch of typos is one fix
rather than five runs.

The rules that actually matter:

- **`confirmed: true` only when a human read the page and the date is explicit.**
  It is scored at full urgency and may ring the subject line. `confirmed: false`
  is a projection: scored at 0.7×, can never outrank a confirmed date at the same
  distance, renders as "projected".
- **`kind: unknown` is not `kind: rolling`.** Unknown means there *is* a deadline
  and you do not know it — it stays in the Verify block until resolved. Rolling
  means there genuinely is no deadline, and it is delivered at most once every 45
  days.
- **`precision: month` when you only know the month.** It cannot ring an alert and
  renders "(day unknown)". Never invent a day to make a row look tidy; a
  fabricated deadline is the one output of this system that is both invisible and
  unrecoverable.
- **`gating: true` is the field that earns the whole project.** The T-minus ladder
  runs off the earliest unmet gating step, not off the headline deadline. If an
  internal endorsement, a separate course application, or a letter lock-in has to
  happen first, it is a gating step — even when you do not know its date yet.
  A gating step with `precision: month` and a note saying who to email is far
  more useful than no step at all.
- **`year:` is the cycle the award *starts*.** This is what makes a refreshed
  cycle a genuinely new item at an unchanged URL.
- **`timeZone` when the institution is not in the US.** Oxford deadlines are
  `Europe/London`; a five-hour shift can move the *day*. The email prints both
  zones — "1 Oct 2026, 23:59 BST (18:59 EDT)" — because printing one is how you
  submit a day late.
- **Ruled-out programs stay in the file.** Record the reason. They are never
  scored and never emailed (`npm run validate` asserts they appear in zero
  items), and keeping them stops you re-adding NSF GRFP in two years.
- **Update `verifiedOn` whenever you re-read a page**, even if nothing changed.
  That field is what the staleness alarm runs on.

## Commands

| Command | What it does |
| --- | --- |
| `npm run pipeline` | Resolve every deadline and write today's digest |
| `npm run pipeline -- --dry-run` | Same, writing nothing; prints what would ship |
| `npm run pipeline -- --date 2026-09-28` | Run as if it were another day — the way to test a ladder rung |
| `npm run pipeline -- --force` | Regenerate a digest that already exists |
| `npm run pipeline -- --no-llm` | Skip the phase-3 layer (already a no-op without an API key) |
| `npm run pipeline -- --no-market` | Skip the market section when a quote source misbehaves |
| `npm run email` | Preview to `.preview/<date>.html`; sends nothing |
| `npm run email -- --out /tmp/d.html` | Preview to a specific path |
| `npm run email -- --send` | Actually send it (needs SMTP env) |
| `npm run email -- --send --force` | Resend a digest already stamped `emailedAt` |
| `npm run ics` | Write `out/calendar.ics` |
| `npm run validate` | Schema-check everything under `data/`, including the no-model-scoring firewall |
| `npm test` | Vitest, including the rung-cascade and stale-opportunity regressions |
| `npm run typecheck` | `tsc --noEmit` |

Exit codes from `pipeline/run.ts` are a contract with CI: **0** ok, **2** the run
completed and its output is unusable (do not commit, do not email), **1** crashed.

## Repo layout

```
config/
  deadlines.yml       THE file you edit. 37 programs. Everything else is downstream
lib/
  types.ts            the frozen data contract, browser-safe, no runtime deps
  html.ts             auto-escaping `html` tagged template; opting out means typing raw()
  email/render.ts     renderEmail / renderText / renderSubject
  calendar/           the .ics writer
pipeline/
  config/             deadlines.ts (loader + validator), weights.json ← tune here
  normalize/dates.ts  the ONLY place text becomes an instant
  deadlines/          projection and item construction
  score/temporal.ts   urgency, canAlert, isStale, the rung ladder
  state/store.ts      read/write digests, rungs and run status
  run.ts              CLI entry; owns the exit-code contract
scripts/
  send-email.ts       preview by default, --send required
  validate-data.ts    hand-rolled schema check, no zod
  commit-data.sh      re-parents onto origin instead of merging generated files
  assert-fresh.sh     refuses a local run from a stale clone
data/                 committed digests and state. The database.
out/calendar.ics      committed artifact with a stable subscribe URL
tests/
```

Dependencies are `js-yaml` and `nodemailer`. Everything else is hand-rolled on
purpose: no zod, no date-fns, no HTTP client, no HTML builder. TypeScript runs
under `tsx` with no build step.

## Publishing (one-time setup)

1. **Push `main` to GitHub.** No Pages setup is needed — the site is phase 2.
2. **Settings → Secrets and variables → Actions**, add:

   | Secret | Required | Why |
   | --- | --- | --- |
   | `SMTP_HOST` | yes | e.g. `smtp.gmail.com` |
   | `SMTP_PORT` | yes | 465 or 587 only; port 25 is blocked on GitHub runners |
   | `SMTP_USER` | yes | |
   | `SMTP_PASSWORD` | yes | Gmail **App Password**, with 2-Step Verification on |
   | `MAIL_FROM` | yes | For Gmail, the same address as `SMTP_USER` or DMARC alignment suffers |
   | `MAIL_TO` | yes | |
   | `HEALTHCHECK_URL` | no | Dead-man's switch. The ping step no-ops without it |
   | `SITE_URL` | no | Phase 2. Unset means the email omits the "view on the web" link |
   | `ANTHROPIC_API_KEY` | no | Phase 3. The whole layer is a no-op without it |
   | `SEC_USER_AGENT` | if EDGAR | EDGAR 403s a client without a descriptive UA carrying a contact email |

   Do **not** use an `@college.harvard.edu` address as the SMTP sender: it is a
   Workspace account whose admin can revoke app passwords, and the failure
   arrives as a run of mornings with no email.
3. **Actions → Radar pipeline → Run workflow** with `force: true` and
   `send_email: true` to prove it end to end.
4. **Subscribe to the calendar** in whatever you actually use, from the raw URL of
   `out/calendar.ics` on `main`.

After that it runs at 10:47 America/New_York with a catch-up at 16:47, and emails
you each morning. The cron is written in the reader's timezone (Actions cron
gained `timezone` support, GA 2026-03-19), which retires the old dual-cron
EST/EDT hack.

## Maintenance

The whole maintenance cost of this design is one recurring task: **re-verify rows
and update `verifiedOn`.** The email tells you which ones — anything past
`verifyEvery` sits at the top under "Confirm this year's date", and every
projected date carries a `verifyBy` 60 days ahead of itself.

Two seasonal jobs the system cannot do for you:

- **Early September: email the Harvard fellowships office (URAF/OUE)** for the
  internal endorsement deadlines, then put the exact dates in the YAML and change
  those steps from `precision: month` to `precision: day`. This is the single
  highest-consequence row in the file and there is no machine-readable source for
  it anywhere.
- **After each cycle closes**, check that the projection that rolled forward is
  sane. `biennial` programs deliberately do not project at all — Keystone's
  epigenetics meeting runs every other year and a confident guess for a meeting
  that may not be scheduled is worse than no row, because a projection renders as
  a countdown.

## Known limits

Be clear-eyed about these.

- **Roughly 45 rows are hand-verified once a year, and that is the design.** If
  you stop doing it, the system degrades exactly as designed — projected dates,
  loud verify prompts, no confirmed alerts — but it does degrade. The alarms tell
  you that you have stopped; they cannot do the reading for you.
- **The internal Harvard endorsement dates require an email to URAF.**
  `uraf.harvard.edu` returns a hard WAF 403 on every path including
  `robots.txt`, so those deadlines exist on no machine-readable host anywhere on
  the internet. The Rhodes row will carry `precision: month` on its gating step
  until a human asks a person.
- **Projected dates are projections.** They are plausible, discounted and clearly
  labelled, and they are still guesses. The rolled-forward anchor is last cycle's
  date, and organisations move deadlines.
- **A month-precision date cannot ring**, by design. If a program only ever
  publishes "applications close in September", the system will keep asking you to
  confirm and will never alarm on it.
- **GitHub cron drifts and occasionally drops runs.** The catch-up cron and the
  per-calendar-day idempotence gate cover a dropped morning; nothing covers
  GitHub being down for a day, which is what the dead-man's switch is for.
- **`out/` is gitignored** (inherited from the sibling project, where `out/` is a
  Next static export). The pipeline drops that line from its own checkout before
  committing `out/calendar.ics`, which works and is documented at the step, but
  the honest fix is to stop ignoring the path. The alternative —
  `build-ics.ts --out <tracked dir>` — was not taken because a calendar's
  subscribe URL has to stay stable for the life of the subscription, and moving
  the file later freezes every existing subscriber's feed with no error anywhere.
- **No site yet, and no on-demand refresh.** Phase 2. Today the email and the
  `.ics` are the product; to force a run, use
  `gh workflow run pipeline.yml -f force=true -f send_email=true`.
- **The market section is decoration.** It exists because the tools-and-platforms
  lane has tickers attached, it is never allowed to make a run unusable, and
  `npm run validate` throws out any single-day move above 60% on the grounds that
  it is a data bug rather than news.
