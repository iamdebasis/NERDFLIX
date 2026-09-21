# data/

Everything the app knows, in one place. Nothing is written outside this directory.

    db/       title records, one JSON file each — derived, rebuildable by rescanning
    state/    watch history, My List, paired volumes — yours, NOT rebuildable
    cache/    TMDB responses, artwork, capabilities.json, mpv-shaders — safe to delete
    .env      your TMDB read token

`state/` is the one that matters. Nothing regenerates it, which is why watch history
survives a prune, a rescan, or deleting `db/` outright.

Everything except this file is gitignored, and none of it is in a distributed archive.
If you replace the project folder rather than updating it in place, copy `data/` across
first — or point `NFL_DATA_DIR` somewhere outside the project and it stops being a risk.

`pnpm run doctor` prints which directory is in use.
