# Setup (browser only)

One action per step. Do them in order. No terminal needed.

Cloudflare moves buttons around sometimes. If a label below doesn't match what you see, look for the closest thing with the same meaning, or check the linked Cloudflare doc for that step.

Before you start, you need two files from the **Studio Build** folder on your computer (NOT inside the `gcs-studio-build` folder):

- `seed.sql`
- `PRIVATE_LINKS_DELETE_AFTER_SAVING.txt`

Never upload either of those to GitHub.

---

## Part 1: GitHub repo

**1. Create the repo.**
Go to github.com, open the **The-Greg-Cote-Show** organization, click **Repositories**, then the green **New repository** button.
Name it `gcs-studio-build`. Pick **Public**. Leave everything else unchecked. Click **Create repository**.

> Why public: GitHub Pages on a free organization only works for public repos. That's fine here. The code has no keys, links or data in it. The board itself is still private because nothing loads without a valid link.

**2. Upload the files.**
On the new empty repo page, click the **uploading an existing file** link.
Open the `gcs-studio-build` folder on your computer, select everything inside it (`docs`, `worker`, `scripts`, `README.md`, `SETUP.md`, `.gitignore`) and drag it onto the page. Click **Commit changes**.

**3. Check it landed.**
The repo should now show `docs`, `worker`, `scripts`, `README.md`, `SETUP.md`. If `.gitignore` is missing, that's OK for now, it only matters if someone ever uses git from a computer.

---

## Part 2: Database

**4. Create the database.**
In the Cloudflare dashboard, find **D1 SQL database** (it's under **Storage & databases** in the left menu). Click **Create Database**.
Name it `gcs-studio-build`. Click **Create**.
Doc: https://developers.cloudflare.com/d1/get-started/

**5. Make the tables.**
On the new database's page, click the **Console** tab.
In GitHub, open `worker/schema.sql`, click the **Copy raw file** button (top right of the file), and paste it into the Console. Click **Execute**.

**6. Copy the Database ID.**
Still on the database page, find **Database ID** and copy it. It's a long string of letters, numbers and dashes.

**7. Put the Database ID in the repo.**
In GitHub, open `worker/wrangler.toml` and click the pencil icon (**Edit this file**).
Replace `PASTE-DATABASE-ID-HERE` with the ID you copied. Keep the quote marks around it.
Click **Commit changes**, then **Commit changes** again in the pop-up.

**8. Add the three people.**
Open `seed.sql` from the Studio Build folder on your computer (Notepad is fine). Copy all of it.
Back in Cloudflare, on the database **Console** tab, paste it and click **Execute**.
Check: click the **Tables** tab, then `people`. You should see Greg, Chris and Yeti.

---

## Part 3: Worker (the API)

**9. Connect the repo to a Worker.**
In the Cloudflare dashboard, go to **Workers & Pages**, click **Create application**, then choose the option to import a repository from **GitHub**.
If it asks, connect your GitHub account and pick the **The-Greg-Cote-Show** organization.
Doc: https://developers.cloudflare.com/workers/ci-cd/builds/

**9a. If `gcs-studio-build` isn't in the list.**
That's the known gotcha. The Cloudflare app on GitHub only has access to the older repos.
Go to https://github.com/organizations/The-Greg-Cote-Show/settings/installations, find **Cloudflare Workers & Pages**, click **Configure**. Under **Repository access**, add `gcs-studio-build` (or pick **All repositories**). Click **Save**. Then go back to Cloudflare and refresh the repo list.

**10. Fill in the build settings, then deploy.**
Pick `gcs-studio-build`, then set:
- **Project name** (or Worker name): `gcs-studio-build-api` (it must match exactly)
- **Root directory**: `worker`
- **Build command**: leave empty
- **Deploy command**: `npx wrangler deploy` (usually already filled in)

Click **Save and Deploy** (or **Deploy**). Wait for it to say it succeeded.

**11. Copy the Worker address.**
On the Worker's page, find its address. It ends in `.workers.dev`, like `https://gcs-studio-build-api.something.workers.dev`.
Open it in a new tab. It should say **Nothing here.** That means it's running. Copy that address.

**12. Tell the page where the Worker is.**
In GitHub, open `docs/config.js` and click the pencil icon.
Replace `https://gcs-studio-build-api.YOUR-ACCOUNT.workers.dev` with the address you copied. No slash at the end. Keep the quote marks.
Click **Commit changes** twice.

From now on, any change committed to GitHub redeploys the Worker by itself. Don't edit the Worker inside the Cloudflare dashboard, GitHub would overwrite it.

---

## Part 4: The page

**13. Turn on GitHub Pages.**
In the repo, click **Settings**, then **Pages** in the left menu.
Under **Build and deployment**, set **Source** to **Deploy from a branch**. Set the branch to `main` and the folder to `/docs`. Click **Save**.

**14. Wait for it.**
Give it a minute or two. Refresh the Pages settings screen until it shows the address: `https://the-greg-cote-show.github.io/gcs-studio-build/`

---

## Part 5: Check it

**15. Open the three links.**
Open `PRIVATE_LINKS_DELETE_AFTER_SAVING.txt`. Open each link in a different browser (or a private window for each).
- Greg's link says **Hi Greg**.
- Chris's link says **Hi Chris**.
- Yeti's link says **Hi Yeti** and has an **Admin** button.

**16. Save the links, then delete the file.**
Put the links somewhere safe, send Greg and Chris theirs, then delete `PRIVATE_LINKS_DELETE_AFTER_SAVING.txt`. You can delete `seed.sql` too.

If anyone ever loses their link, open Admin > People and tap **Make a new link**.

---

## If something doesn't work

- **Page says "The board isn't hooked up yet."** Step 12 didn't save, or GitHub Pages hasn't picked it up yet. Wait a minute and refresh.
- **Page says "Can't reach the board right now."** The address in `docs/config.js` is wrong, or the Worker deploy failed. Check the Worker's **Deployments** or build log in Cloudflare.
- **Page says "This link isn't valid."** Step 8 didn't run, or the link was copied with a piece missing.
- **Worker build fails mentioning the database.** The Database ID in step 7 is wrong or still says PASTE.
- **Worker build fails mentioning the name.** The Worker name in Cloudflare must be exactly `gcs-studio-build-api`.
- **You named the repo something other than `gcs-studio-build`.** The page address changes, so the links need the new address in front of the `#k=` part. The part after `#k=` stays the same. Also check `ALLOWED_ORIGINS` in `worker/wrangler.toml` is still `https://the-greg-cote-show.github.io`.
