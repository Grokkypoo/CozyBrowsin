# lightbrowser

A plain Chromium window with no browser UI, like Vesktop's "Open Links in App", for everyday personal use. It has its own profile, so it's separate from Discord.

## Status

| Part | State |
|---|---|
| Linux package with everything bundled | Built; the unpacked build starts and loads pages |
| Update check against a feed | Works: the packaged app requested `latest-linux.yml` |
| Download, install and restart | **Not proven.** `test/update-e2e.mjs` has never completed; the cause is unresolved |
| Rejecting a tampered download | **Not proven**, same test |
| Windows installer | **Not built.** It needs Wine or Windows, and neither was usable here. `release.yml` should build it on GitHub, but that workflow has never been run |

The AppImage and `.tar.gz` in `dist/` are **test builds**. Their updater points at a local test address, so don't install them for real use.

The AppImage uses a static runtime, so it doesn't need `libfuse2`, but the system still needs `fusermount` (the `fuse3` package). Without it, run the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1`, or use the `.tar.gz`, which doesn't use FUSE but doesn't update itself.

## Run from source

```bash
npm install
npx electron .
```

## Build

The packaged app needs no separate Node install, because Electron ships its own runtime. Node is only needed to build.

```bash
LIGHTBROWSER_UPDATE_URL=https://github.com/OWNER/REPO/releases/latest/download npm run dist:linux
```

The URL is built into the app and is where it looks for updates.

## Releasing an update

1. Put this folder in a GitHub repo. Update downloads must be publicly reachable, so a private repo won't work with this setup.
2. Raise `version` in `package.json`, and bump `electron` too, because that is how browser security fixes reach you.
3. Commit, then tag and push: `git tag v0.2.0 && git push --tags`.

Installed apps check 5 seconds after starting, download in the background, then ask before restarting. To check by hand, press Alt to show the menu, then **Browse > Check for Updates**.

Builds are unsigned. Windows SmartScreen will warn on install. Updates are protected only by HTTPS and the checksum in the release metadata, so anyone who controls the GitHub repo can push code to installed copies.

## Keys

| Key | Action |
|---|---|
| Ctrl+L | Type an address or search |
| Alt+Left / Alt+Right | Back / forward |
| Ctrl+R | Reload |
| Ctrl+N | New window |
| Ctrl+W | Close window |
| F12 | Developer tools |
| Ctrl+Q | Quit |

## Good to know

- There are no tabs, by design. Each page is a window.
- Camera, mic, location, notifications, screen capture and clipboard reading ask first. Answers last until you quit.
- Chromium saves cookies on a delay, so a crash or force-kill can lose very recent logins. Quit with Ctrl+Q.
- It has no ad blocker, password manager or Safe Browsing.
- It only gets browser security fixes when a new release is published, so publish regularly.
- To change the home page or search engine, edit `HOME` in `main.js`.
