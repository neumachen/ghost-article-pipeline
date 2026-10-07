# GitHub to Ghost: Part 1 reference

Companion source for [Publishing to Ghost from GitHub, Part 1](https://neumachen.dev/articles/github-to-ghost-publishing-part-1/).
The `part-1.0.1` tag preserves the implementation described in the article. Part
1.5 will expand the follow-along guide; Part 2 will cover self-hosted runners.
No prebuilt publisher image or reusable workflow is released with this edition.

The publisher, launcher and tests come from source revision
`c6e1b3e61f8a5522c9255820ae5f9a3467773b34`. Application logic is unchanged.
This snapshot has an empty registry, article-only mise tasks, MIT licensing,
public source metadata, and this guide. It contains no site theme, unpublished
articles, credentials or history from the original repository.

## Prerequisites and checkout

Use Git, a running Docker daemon with Compose v2, and
[mise](https://mise.jdx.dev/getting-started.html) on macOS or Linux. You also need
your own Ghost site with custom-integration access, and an empty GitHub repository
you can administer. Hosted execution uses `ubuntu-24.04`. Local Docker Desktop
integration tests require its host-networking option; ordinary checks and previews do not.

```sh
git clone --branch part-1.0.1 --single-branch https://github.com/neumachen/ghost-article-pipeline.git ghost-publishing
cd ghost-publishing
git switch -c main
git remote rename origin reference
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git remote -v
mise trust
docker info
docker compose version
mise run article:image
mise run article:check -- --working-tree
mise run article:test
```

Replace the capitalized account/repository placeholders. Check that `origin`
points to your own empty repository. Inspect the mise tasks before trusting
them. The application runs in Docker; no host npm install is needed. An empty
registry is valid. Unit tests skip the 24 scenarios needing a running Ghost.

## Enroll a draft

On a new branch (`git switch -c first-article`), create
`editorial/articles/hello-ghost/article.md`:

```markdown
---
id: hello-ghost
title: "Hello from GitHub"
slug: hello-from-github
status: draft
tags:
  - Engineering
---

## A paragraph with somewhere to go

This article started as a file in Git.
```

Replace `editorial/articles/registry.json` with:

```json
{
  "schema": "neumachen-article-registry/1",
  "articles": [{ "id": "hello-ghost", "path": "editorial/articles/hello-ghost" }]
}
```

Keep `status: draft` explicit: omitting it defaults to `published`. The stable
ID must match the registry; changing a slug does not change the article's identity.

```sh
mise run article:check -- --working-tree
mise run article:preview -- --article hello-ghost --working-tree --out /out/hello-ghost-preview.html
git add editorial/articles
git commit -m "Add first Ghost draft"
mise run article:prepare -- --article hello-ghost --revision HEAD
```

Validation should report `OK hello-ghost` and `status=draft`. Open
`dist/article/hello-ghost-preview.html`. The candidate directory
`dist/article/hello-ghost/` contains HTML and JSON files; check its revision
against `git rev-parse HEAD`. Do not commit generated `dist/` files.

## GitHub and Ghost configuration

1. In Ghost Admin, create a [custom integration](https://ghost.org/integrations/custom-integrations/).
   Use its **Admin API key** and API URL, not its Content API key.
2. In your GitHub repository's **Settings → Environments**, create `ghost-production`.
   Restrict deployment branches to **Selected branches and tags → Branch → main**.
3. Add environment **variable** `GHOST_ADMIN_API_URL` with the integration's URL
   (for example, `https://your-site.ghost.io`). Add environment **secret**
   `GHOST_ADMIN_API_KEY` with the Admin API key. Never commit the key.
4. Enable Actions if required, and make `main` the default branch. Environment
   availability in private repositories depends on your GitHub plan; see
   [GitHub's environment guide](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Push the reference's `main` and your article branch to your repository:

```sh
git push -u origin main
git push -u origin first-article
```

Open and review a PR from `first-article` into `main`. Wait for Article CI to
pass, then merge. After merge, wait for the **push run on main** to pass too.
That run prepares `article-candidates-<full-commit-SHA>`. Its artifact contains
the candidate that production can use; the PR artifact is review material.
The workflow's `GITHUB_TOKEN` is supplied by GitHub, not a secret you must create.

## Plan, create the draft, and repeat

In **Actions → Article publish → Run workflow**, choose branch `main` and:

| Input | First run |
| --- | --- |
| article | `hello-ghost` |
| revision | Full 40-character SHA of the successful main push run |
| operation | `plan` |
| confirm | `no` |
| repair_state | `false` |

The record artifact should show `outcome: planned`, `status: draft`,
`live_changed: no`, post/tag mutations `none` and zero asset uploads. Check
that the intended action is `create` for a new article or `update` for a changed one.

Run the workflow again for **the same revision**, changing only `operation`
to `publish` and `confirm` to `yes`. It creates a **draft**, because status comes
from the committed article. Inspect it in Ghost Admin and open its preview.
The record should show `created` (or `updated`) and successful saved-content
verification. Public-page verification is skipped for drafts.

Repeat the same publish inputs once: expect `unchanged`, no new uploads and
the same post ID. To make the article public later, change its front matter to
`status: published`, commit, PR, merge, wait for that main revision's CI, then
plan and publish **that new revision**. Newsletter delivery is not part of this pipeline.

## Reading failures

The `article-publish-record` artifact is retained even after a failed write.
Inspect it before retrying. A missing/expired candidate needs a successful CI
run for the selected main revision. An authentication error needs the matching
environment variable and Admin API secret. A Ghost-side content conflict means
bring the intended edit back into Git; there is no force-overwrite switch.
Exit 5 means the write or saved state is uncertain. Exit 6 means the post write
was confirmed but public-page verification failed. Neither means "nothing happened".

`repair_state` is normally false. It only reconciles recorded state when the
committed candidate already matches the live post; it does not overwrite content.
Restore earlier prose in a **new** Git revision, not by publishing an ancestor.

## Additional local checks

```sh
mise run article:runtime-check
mise run article:evidence
mise run article:integration
```

The last task creates and removes a disposable Ghost stack, including its data
volume. It never receives production credentials. Set `ARTICLE_GHOST_PORT` if
23680 is already occupied. Do not run concurrent integration stacks from this
reference: they share the `article-integration-ghost` container name.

## License

MIT; see [LICENSE](LICENSE). Locked dependencies retain their own licenses.
