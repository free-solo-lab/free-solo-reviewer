# Review lifecycle

Reviewer keeps three independent baselines:

- `workflow.initial` pins the initial project base. Refreshing remote metadata does not silently move it. Explicitly choosing another local base starts a new source scope.
- `AnalysisRun.previousReviewId` and `session.update` define the technical incremental analysis. The visible comparison never changes this scope.
- `workflow.checkpoints` records confirmed GitHub review publications and accepted local comment packets. The latest human checkpoint is the default display baseline, including when its source equals the current source.

The overview combines semantic follow-ups across the selected display period, so an earlier fixed remark remains visible through later technical analyses. Every visible comparison ends at `current`. Baselines are initial source, saved analyses and human checkpoints, rather than arbitrary intermediate commits. Comparison snapshots are persisted, retain a canonical snapshot ID for editing/comments/view marks and can resolve sources after a server restart.

## Source identity and retained descriptions

Source hashes cover sorted reviewable file paths and contents, independently of commit SHA, PR number, title, discussion and review status. Immutable snapshot trees remain the source of evidence. Metadata-only updates synchronize discussions without scheduling Codex.

Incremental merging identifies indexed methods by repository, path, owner and normalized signature, including overloads. Exact method blocks, unambiguous local dependencies and parameter/result model definitions determine reuse. Unchanged descriptions retain their original text and IDs; only evidence locations move. Changed entities without a replacement retain links to their old descriptions and sources in `pendingDescriptions`.

Evidence relocation accepts only exact source fragments, disambiguated by surrounding context. An ambiguous draft anchor retains its original text, immutable source and evidence, is marked outdated, and is excluded from inline publication on the current code. New source and relocated drafts are saved in one SQLite transaction.

## Fixes and continuation

Analysis and fixes share the bottom Codex panel and visible history. Technical model sessions remain scoped to their individual stages; fix threads and their authenticated workspace homes persist per project/repository across source snapshots. Completed/skipped comment IDs remain in history.

A successful whole fix packet persists a pending server update before acknowledging completion. The repository stays reserved until source capture finishes. Exactly one automatic refresh follows the packet; code changes start an incremental analysis in scenarios → database → changed tests order. No-code fixes do not call the analyzer. When the reviewer has not run any technical analysis yet, `technicalDelta` pins the pre-fix source so the first automatic job reviews only that packet’s changes, rather than the entire original PR. Questions, approvals, failures, individual unfinished steps and cancellation never schedule the automatic transition.

`workflow.fixUpdates` makes retries idempotent. Pending updates recover on server startup; an already-created partial analysis remains resumable rather than starting over. Older interrupted requests migrate their fingerprint format while keeping their model thread and checkpoint.

## Publication and remote state

PR creation requires a preview and an explicit publish action. A persisted publication ID identifies preparation, commit, push, uncertain response and completed adoption. Publishing constructs a commit with a separate Git index, containing only the previewed source paths. It never stages unrelated files, changes the checkout, force-pushes or runs project hooks. The initial base's other files stay intact.

A dedicated branch carries a newly created PR. Existing-PR fixes use the same PR branch and an explicit **Publish fixes** action. Unpublished working changes are represented separately from the GitHub commit and cannot be silently reviewed as published source. Adopting identical published code keeps the project ID, history, chat, drafts, review points, viewed marks and analysis.

A marker plus remote branch/base lookup reconciles uncertain PR creation before any retry. An ambiguous outcome blocks a duplicate publication; definite HTTP rejection remains retryable. Publishing a local commit/PR alone never calls Codex.

Opening/focusing a remote review and a 60-second timer synchronize discussions and GitHub's aggregate `reviewDecision` and PR state without analysis. Approved review state, requested changes, closed and merged PRs are displayed separately from technical analysis status. Merging remains an action in GitHub.

## Verification boundaries

Workflow tests use temporary repositories, local bare remotes, fake GitHub gateways and fake model providers. They cover content-only identity, retained overload descriptions and model dependencies, relocated/outdated comments, human baselines, persisted comparisons, fix continuation/restart, safe publication and uncertain-response reconciliation. They never publish a real PR or spend model tokens. Live GitHub permissions, branch policies and native-window layout still depend on the user's environment.
