# Publishing Vexlo on GitHub and shipping releases

Written for Windows and for people new to Git ([Tiếng Việt](PUBLISHING.md)). Go through it from top to bottom.
The project already has a `.gitignore`, a `LICENSE` (MIT) and a workflow that builds the installer whenever you push a
version tag (`.github/workflows/release.yml`).

## 0. Prepare (once)

1. Install **Git for Windows**: https://git-scm.com/download/win (just keep clicking Next).
2. Create an account at https://github.com if you do not have one.
3. Install the **GitHub CLI** to sign in easily: https://cli.github.com, then in PowerShell:
   ```
   gh auth login
   ```
   Choose GitHub.com, HTTPS, "Login with a web browser" and follow the steps.
4. Tell Git who you are:
   ```
   git config --global user.name "Your Name"
   git config --global user.email "the-email-you-use-on-github@example.com"
   ```

## 1. Name the project and fill in your details

Search GitHub to see whether the name `vexlo` is taken (https://github.com/search?q=vexlo&type=repositories). If it is, choose another name everywhere below.

Edit these places in `package.json` (replace `YOUR_GITHUB_USERNAME` with your GitHub account and `YOUR_NAME` with your name):

- `"author"`, `"homepage"`, `"repository"` (top of the file)
- `"build"` > `"publish"` > `"owner"` and `"repo"`

Also replace `YOUR_NAME` in the `LICENSE` file.

> `owner` and `repo` must be real: the app uses them to look for updates and to show the "What's new" window.

## 2. Create the repository and push the code

In the project folder (PowerShell or the VS Code terminal):

```
npm install
git init -b main
git add .
git commit -m "Vexlo 0.1.0"
gh repo create vexlo --public --source . --remote origin --push
```

- `npm install` creates `package-lock.json`. Let it be committed too.
- `gh repo create` makes a public repository named `vexlo` on your account and pushes everything. Open the repo page to check.
- Not pushed: `node_modules/`, `dist/`, `extension-edge/` (they are in `.gitignore`).

If you prefer a graphical tool, use **GitHub Desktop** (https://desktop.github.com): "Add local repository" > "Publish repository".

## 3. Ship a release (one command)

The project has a `ship` command. It runs the tests, bumps the version, commits with the message **you write**, pushes the code and creates the tag:

```
npm run ship -- patch "A short description of what you changed"
```

- The `--` is required, and `patch` is written without dashes. Without it npm swallows the argument.
- `patch` raises the last number (0.1.18 becomes 0.1.19), `minor` the middle one (0.1.19 becomes 0.2.0), `major` the first. You can also type a version, for example `0.3.0`.
- Run `npm run ship` with nothing else and it asks for each value. In VS Code you can use Terminal > Run Task > "Ship release".
- Versions are compared number by number, so 0.1.10 is newer than 0.1.9 (it is not compared as text).

Then open the **Actions** tab of the repository. The "Release" workflow takes about 5 to 10 minutes. When it finishes, the **Releases** tab has:

- `Vexlo-Setup-x.y.z.exe`: the Windows installer
- `latest.yml` and `*.blockmap`: files the app uses to update itself (do not delete them)
- `Vexlo-firefox-extension.zip`, `Vexlo-edge-extension.zip`: the browser extensions
- The release description is **written by the workflow from your commit messages** since the previous release. So write clear commit messages: users read them in the app's "What's new" window after an update. To polish the text, click Edit on the Release page.

If the workflow shows a red error, open that run and read the failing line (usually a wrong `owner`/`repo`, or a missing `package-lock.json`).

To build on your own PC without GitHub: `npm run dist`. The files are in `dist\`.

## 4. How users install and update

- Users download `Vexlo-Setup-x.y.z.exe` from the Releases page and run it.
- The installer is **not code-signed**, so Windows SmartScreen shows "Windows protected your PC": click **More info** > **Run anyway**.
  Say this in your repository README so nobody panics.
- Once installed, the app checks GitHub Releases for a new version 20 seconds after it starts and every 4 hours, and there is a "Check for updates" button in Settings.
  A new version downloads in the background; when no download is running, the app quits, installs it and starts again.
  Users can turn it off in Settings > General > "Check for updates automatically".
- To get free code signing for an open-source project, look at the **SignPath Foundation** program (https://signpath.org). It is optional.

## 5. Put the extensions in the stores (one-click install)

### Firefox (addons.mozilla.org, free)

A temporary add-on is lost every time Firefox closes, so for everyday use you want the signed version.

1. Sign in at https://addons.mozilla.org/developers/ > **Submit a New Add-on**.
2. Choose **On your own** (self-distributed, signed quickly, not listed in the store) or **On this site** (public, slower review).
3. Upload `Vexlo-firefox-extension.zip` (from the Releases page). `manifest.json` must be at the root of the zip: if Mozilla says it cannot
   find it, zip the **contents** of the `extension` folder, not the folder itself.
4. Each new upload needs a higher `"version"` in `extension/manifest.json` than the last one you submitted.
5. When it is approved, download the signed `.xpi`, attach it to the Release (or let users install from the store page).
6. Users drag the `.xpi` into Firefox to install it.

### Edge (Microsoft Edge Add-ons, free)

1. Register as a developer at https://partner.microsoft.com/dashboard/microsoftedge (free).
2. **Create new extension** > upload `Vexlo-edge-extension.zip`.
3. **Important:** once it is approved, Edge gives the extension a **new ID**. Open `src/main/main.js`, find `CHROMIUM_EXT_IDS`
   and add that ID to the array, then ship a new app version. Without it the app will not pair with the extension installed from the store.

### Chrome (optional)

The Chrome Web Store charges a one-time developer fee of about 5 USD. It uses the same `Vexlo-edge-extension.zip`; do the same as for Edge (and add the ID to `CHROMIUM_EXT_IDS` too).

## 6. Checklist for every release

- [ ] Write a clear commit message (it becomes the release notes)
- [ ] `npm run ship -- patch "commit message"` (it already runs the tests and bumps the version)
- [ ] Watch the Actions tab until it finishes and check that the Release has `latest.yml`
- [ ] Install the new version on a clean PC and check: downloads work, the extension pairs by itself, uninstall removes the app data

## 7. Common problems

| Symptom | What to do |
|---|---|
| `git push` is refused (login) | Run `gh auth login` again |
| Workflow fails on `npm ci` or a missing lockfile | Run `npm install` and commit `package-lock.json` |
| The Release has no `latest.yml` | The workflow has not finished or failed. Open the Actions tab |
| The app does not see the update | Check `owner`/`repo` in `package.json`, and that the new version is higher than the installed one |
| `npm run ship` says "Bump must be patch, minor, major..." | Type `npm run ship -- patch "message"` (with `--`, and `patch` without dashes) |
| A tag was pushed but you want to redo it | `git tag -d v0.1.0`, `git push origin :refs/tags/v0.1.0`, delete the Release on GitHub, then tag again |
