#### Auto-sync to Greasy Fork on `git push`

Greasy Fork does not provide a direct publish API. The stable approach is webhook-based sync.

1. In Greasy Fork, open your script edit page and set the sync URL to the raw GitHub file URL:

```
https://raw.githubusercontent.com/<owner>/<repo>/<branch>/paperec.js
```

2. In Greasy Fork, go to **User page → Set up webhook** and generate your webhook secret.

3. In GitHub repository settings, create two Actions secrets:

- `GREASYFORK_WEBHOOK_URL`: the Greasy Fork webhook payload URL.
- `GREASYFORK_WEBHOOK_SECRET`: the same secret generated on Greasy Fork.

4. This repo includes workflow `.github/workflows/greasyfork-sync.yml`:

- Triggers on push to `main`/`master` when `paperec.js` changes.
- Only calls Greasy Fork when `// @version` actually changes.
- Sends a GitHub-style signed payload (`X-Hub-Signature`) to Greasy Fork webhook.