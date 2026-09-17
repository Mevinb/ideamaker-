# IdeaArena

A local idea-generation workbench. New conversations are a free group chat between four voices (Sam, Alex, Robin, Kai): no roles, no script. Everyone pitches an idea, anyone can jump into the debate in any order, then everyone votes for the strongest direction. A deadlock triggers a round of fresh ideas; a second deadlock hands the tie-break to you. If a model is unavailable, the speaker automatically retries with another model; a speaker that cannot reach any model sits out instead of stopping the chat, and the run only fails if no reply gets through at all. Auto selection and automatic fallbacks only use free-quota models and never pick a billed OpenAI model; hand-picked models are still honored. A model that reports a quota or rate-limit error is parked for the session. Older explorations, chats, and tournaments retain their original workflow.

## Experimental exploration

The default taste is wild and experimental. Taste and surprise must each score at least 7/10; duplicates and hard-constraint violations are excluded. These scores are subjective model assessments, not proof of originality. If fewer than three concepts pass, the app reports the shortfall rather than padding the shortlist. The first round does not select a winner. Use **Develop this idea** to explicitly choose a direction for a later round; otherwise the group continues exploring.

All 13 roles have optional manual model selections. Auto spreads roles across providers and favors larger/reasoning model families when identifiable from the catalog; model names are a routing heuristic, not a quality guarantee. Failed calls can fall back to other eligible models, with attribution in the event log. No provider is selected or excluded based on price.

**More like this**, **Too familiar**, and **Wrong direction** persist explicit feedback locally. An optional reason tells the reviewers what you liked or disliked. **Clear saved taste preferences** clears these explicit preferences; it does not delete historical ideas. Compact concept records from the latest 20 other runs, including rejected drafts, provide historical exclusions within a 35,000-character context budget. Legacy records are read without rewriting them.

Execution is limited to three concurrent calls, 96 total attempts, and 20 minutes per round. Repairs and failovers count toward the same budget. Completed agent tasks and concept revisions are checkpointed in SQLite; an expiring execution lease prevents duplicate workers. **Resume interrupted exploration** reuses successful tasks after a server restart or failure. Time spent interrupted still counts against the round's elapsed-time budget. Stop aborts active model calls. Continuous discussion permits one additional round, then pauses.

Optional Tavily research supplies related public work when configured. Without it, external novelty is explicitly unverified. Inspect **Agent activity and review decisions** for progress, rejection reasons, and search status; individual agent outputs are expandable.

Run `npx tsx scripts/smoke-exploration.ts` to exercise two real explorations of the same brief in an isolated temporary database. This makes real gateway calls. `IDEAARENA_SMOKE_MODEL` pins the validation roles to a specific route when needed. The script reports all shortlisted mechanisms, attempts, and failures.

## Run locally

Run `./run.sh` from this folder (or invoke it by its full path from any directory). It installs dependencies if missing and starts IdeaArena on localhost. Start `omniroute` in another terminal if it is not already running. Set `PORT=3001 ./run.sh` to use another port. Stop with Ctrl+C.

1. Start the gateway in another terminal: `omniroute`
2. Copy `.env.example` to `.env.local` and adjust the gateway URL if needed.
3. Install packages: `npm install --cache /tmp/ideaarena-npm-cache`
4. Start the app: `npm run dev`
5. Open `http://localhost:3000`

Model dropdowns use OmniRoute's catalog and read-only local account metadata from `~/.omniroute/storage.sqlite` (override with `OMNIROUTE_DATABASE_PATH`). All prices are eligible. Inactive, unhealthy, and currently rate-limited connections are excluded. Account-synced model lists are used when present; Antigravity requires recent model-specific quota evidence with remaining quota. Providers without account model sync use their connected-provider catalog. Credentials are never read from this database. These records establish discovery eligibility, not a successful inference test for every model or a guarantee against upstream failures.

Every role defaults to Auto. At run start, IdeaArena assigns Auto slots across the filtered available models and saves those concrete assignments with the run. Manual dropdown selections are preserved. This does not send unrestricted Auto/combo routes to OmniRoute. The server rechecks all selections before creating the run. Each new run records requested routes and gateway-reported response identities in its local event log. Finalists show their generator, mutation model, and individual jurors; jury prompts remain anonymous. Older runs cannot retroactively recover identities that were not recorded. Add `TAVILY_API_KEY` to enable optional external novelty evidence.

All prompts, debate history, and scores are stored in `data/ideaarena.db` on this machine. Provider calls are made only to the configured gateway and optional research service.

The Run history panel opens previous reports and saved conversations, including failed and cancelled runs. During a run, the live conversation shows validated responses as each model finishes, with generator/critic roles, gateway model names, and idea pairings. It is message-by-message, not token streaming. Older reports show their saved debate records when no live transcript exists. Polling recovers messages if the event stream disconnects.

The browser refreshes availability every 15 seconds and no longer restores stale catalog entries from local storage. A gateway or metadata failure clears choices and blocks starting until availability can be checked. Start `omniroute serve --no-open` in your terminal and use Refresh connection. Refresh model/quota data in OmniRoute if the eligible list is empty.

## Validation and troubleshooting

Run `npm test`, `npm run lint`, and `npm run build` for regression tests and compilation checks. Tests use an isolated temporary database and a deterministic provider fixture; they do not call external models.

Run `IDEAARENA_DATA_DIR=/tmp/ideaarena-live-validation npx tsx scripts/smoke-tournament.ts` for a complete live tournament using the configured gateway. This makes real provider calls. Set `IDEAARENA_SMOKE_MODEL` to override `auto`. The script deliberately disables optional search to isolate the model pipeline.

Every model request includes its complete JSON Schema. Prose lengths are editorial targets: longer text is preserved with a warning, up to a 20,000-character safety ceiling per field. Invalid output is repaired at most twice per model with precise errors and the original prompt. If a model fails, the current step automatically tries other eligible text models, preferring another provider. Switches are logged live; manual assignments may also fail over. Cancellation stops retries, and exhaustion of all alternatives fails honestly. Invalid jury IDs, omitted scores, and incomplete duplicate clusters are never replaced with invented scores.

Failed runs remain in the database. New exploration runs support explicit checkpoint recovery. Legacy tournaments only persist events and their final report; start a new legacy run after a failure. Keep the local server running while agents are working.
