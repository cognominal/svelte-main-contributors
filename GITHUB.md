# GitHub API usage

- GET `https://api.github.com/users/{owner}`
  Purpose: Ensure the requested owner exists before fetching top-star repositories.
  Source: [src/routes/api/contribs/+server.ts][server-validate-owner]

- GET `https://api.github.com/search/repositories`
  Purpose: Discover an owner's top-starred repositories for batch cloning.
  Source: [src/routes/api/contribs/+server.ts][server-top-star]

- GET `https://api.github.com/search/users`
  Purpose: Suggest owner accounts while the user types.
  Source: [src/routes/+page.svelte][page-owner-suggestions]

- GET `https://api.github.com/search/repositories`
  Purpose: Suggest repositories owned by the selected account.
  Source: [src/routes/+page.svelte][page-repo-suggestions]

- GET `https://api.github.com/users/{login}`
  Purpose: Validate the owner client-side before submitting the form.
  Source: [src/routes/+page.svelte][page-validate-owner]
  Purpose: Confirm candidate profiles when resolving contributor emails.
  Source: [src/lib/server/gitStats.ts][gitstats-user-lookup]

- GET `https://api.github.com/repos/{login}/{repo}`
  Purpose: Validate the repository client-side before submitting the form.
  Source: [src/routes/+page.svelte][page-validate-repo]

- GET `https://api.github.com/repos/{slug}/commits/{sha}`
  Purpose: Map contributor emails to GitHub profiles using recent commits.
  Source: [src/lib/server/gitStats.ts][gitstats-commit]

- GET `https://api.github.com/search/users`
  Purpose: Cross-check contributor names when email lookups miss.
  Source: [src/lib/server/gitStats.ts][gitstats-name-search]

[server-validate-owner]: src/routes/api/contribs/+server.ts#L53
[server-top-star]: src/routes/api/contribs/+server.ts#L62
[page-owner-suggestions]: src/routes/+page.svelte#L1013
[page-repo-suggestions]: src/routes/+page.svelte#L1188
[page-validate-owner]: src/routes/+page.svelte#L1389
[page-validate-repo]: src/routes/+page.svelte#L1427
[gitstats-user-lookup]: src/lib/server/gitStats.ts#L477
[gitstats-commit]: src/lib/server/gitStats.ts#L382
[gitstats-name-search]: src/lib/server/gitStats.ts#L453
