# Vendored dependencies

Per the build brief §7.4: *"Vendored Solidity dependencies go in `lib/` and are committed. No
floating git refs."*

Each dependency below is committed as plain source with its VCS metadata removed, and pinned to an
exact released tag and commit. There is no `.gitmodules` and no submodule.

| Dependency | Path | Tag | Commit | Source |
|---|---|---|---|---|
| forge-std | `lib/forge-std` | `v1.16.2` | `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` | `https://github.com/foundry-rs/forge-std` |

To upgrade, replace the directory wholesale and update this table in the same commit. Do not run
`forge install` against this tree: it reintroduces a submodule, which is the floating ref this file
exists to prevent.
