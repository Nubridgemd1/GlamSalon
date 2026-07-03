# Glam Salon — Admin (braid styles & photos)

Manage the braid‑style lookbook from your phone at **`/admin`**
(e.g. https://glamsalondebeaute.com/admin). Add a photo (camera or gallery),
set the **price** and **duration**, write a short description — then **Save & publish**.
Changes go live on the site in about a minute.

## How persistence works
Saves are written to the running server **and committed to the GitHub repo**
(`public/styles.json`), so they survive the next redeploy. Photos are compressed
in the browser and stored inside `styles.json`.

## One‑time setup (environment variables on Hyperlift)
Set these on the Glam app in Hyperlift, then redeploy:

| Variable | What | Example |
|---|---|---|
| `ADMIN_EMAIL` | login email | `info@glamsalondebeaute.com` |
| `ADMIN_PASSWORD_HASH` | password hash (see below) | `a1b2…:c3d4…` |
| `SESSION_SECRET` | long random string (signs the login cookie) | 40+ random chars |
| `GITHUB_TOKEN` | GitHub PAT with **contents: write** on `Nubridgemd1/GlamSalon` | `github_pat_…` |
| `SESSION_HOURS` *(optional)* | how long a login lasts | `12` |
| `GIT_REPO` *(optional)* | override repo | `Nubridgemd1/GlamSalon` |

### Generate the password hash
```
node tools/hash-password.js "the password you want"
```
Copy the printed `salt:hash` into `ADMIN_PASSWORD_HASH`.

### GitHub token (for persistence)
Create a **fine‑grained PAT** limited to the `GlamSalon` repo with
**Contents: Read and write**, and put it in `GITHUB_TOKEN`. Without it, edits
still work on the live server but revert on the next redeploy.

## Notes
- `/admin` is hidden from search engines and rate‑limits failed logins.
- Until admin env vars are set, the site shows the default (seed) styles.
