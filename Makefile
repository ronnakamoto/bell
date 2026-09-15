# BELL — every workflow is a target. No tribal commands (build brief §6).
#
# `make build` from a fresh clone is the whole setup: it generates the shared constants and the
# cross-language fixtures from `spec/`, then compiles. `make test` and `make check` follow.
#
# **There is no Python here, and B1 is why.** Until Phase B this file carried a second toolchain --
# `PYTHON`, `BIN_DIR`, a `venv` target, a `check-python` preflight, a pytest target per workspace,
# and ruff, mypy and `lint-imports` passes -- because both services were Python and the TypeScript
# port ran beside them. Ruling R5 made TypeScript the implementation and B1 deleted the Python, so
# the Python half of every target went with it.
#
# The gate *names* are unchanged, and that is deliberate. Two of them (`check-types` was mypy,
# `check-architecture` was `lint-imports`) had no subject left but a live counterpart, so they now
# name that counterpart rather than disappearing from a list a reader has learned. The two whose
# subject was Python and nothing else are gone: `check-python` (there is no interpreter to preflight)
# and the per-workspace `test-calibrator` / `test-settlement` (the suites are `ts-test`). Nothing
# below needs an interpreter that is not `node`.

SHELL := /bin/bash
.DEFAULT_GOAL := help

CONTRACTS := contracts
CALIBRATOR := calibrator
SETTLEMENT := settlement
TOOLS := tools

.PHONY: help build test test-contracts test-fork check \
        check-format check-lint check-types check-architecture check-layout check-generated \
        check-coverage check-fixtures deploy deploy-fork diagnostics gas coverage clean \
        ts-install ts-build ts-test ts-check

help: ## List every target
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------- build

build: ## Generate spec-derived artifacts, then compile everything
	@echo "== generating from spec/ =="
	node $(TOOLS)/gen_constants.ts
	@echo "== compiling the TypeScript workspaces =="
	npm run build
	@echo "== generating the fixtures the domain produces =="
	node $(TOOLS)/gen_moments_fixture.ts
	node $(TOOLS)/gen_digest_fixture.ts
	@echo "== compiling contracts =="
	cd $(CONTRACTS) && forge build

# ---------------------------------------------------------------------------- test

test: test-contracts ts-test ## Run the full suite

test-contracts: ## Solidity unit, fuzz, invariant and differential suites
	cd $(CONTRACTS) && forge test -vv

test-fork: ## Fork suite against the pinned chain. Requires BELL_RPC_URL; skipped if unset
	@if [ -z "$$BELL_RPC_URL" ]; then \
		echo "BELL_RPC_URL is not set; skipping the fork suite (see DESIGN_NOTES.md F6)"; \
	else \
		cd $(CONTRACTS) && forge test --match-path "test/fork/*" -vv; \
	fi

deploy: ## Simulate the deployment locally and print the manifest. No broadcast
	cd $(CONTRACTS) && forge script script/Deploy.s.sol

deploy-fork: ## Broadcast the deployment to a fork. Requires BELL_RPC_URL and BELL_DEPLOYER_KEY
	@if [ -z "$$BELL_RPC_URL" ]; then \
		echo "BELL_RPC_URL is not set; cannot deploy (see DESIGN_NOTES.md F6)"; exit 1; \
	fi
	cd $(CONTRACTS) && forge script script/Deploy.s.sol \
		--rpc-url $$BELL_RPC_URL --broadcast --private-key $$BELL_DEPLOYER_KEY

diagnostics: ## Print the lattice, canonical, AMM and fee diagnostics from the deployed code
	cd $(CONTRACTS) && forge script script/PrintDiagnostics.s.sol

coverage: ## Print coverage for everything. `make check-coverage` asserts the thresholds
	cd $(CONTRACTS) && forge coverage --report summary
	npm run coverage

gas: ## Per-operation gas report, against the brief's §13.3 budget
	cd $(CONTRACTS) && forge test --gas-report

# ---------------------------------------------------------------------------- check

check: check-format check-lint check-types check-architecture check-layout check-generated check-fixtures check-coverage ts-check ## Everything CI runs

check-format: ## Solidity formatter check. The TypeScript half is `ts-check`
	cd $(CONTRACTS) && forge fmt --check

check-lint: ## Solidity linter. The TypeScript half is `ts-check`
	cd $(CONTRACTS) && forge lint

# This was `mypy --strict` over both service workspaces until B1. The subject is unchanged -- "the
# types are right" -- but it moved to TypeScript, so the gate names the checker that now holds it.
check-types: ## TypeScript type check, per project
	npm run typecheck

# This was `lint-imports` against each workspace's `pyproject.toml` contracts until B1.
# `dependency-cruiser` enforces the same §5.3 rule on the tree that survives, and as an allow-list
# rather than a deny-list of categories -- strictly the stronger check (see `check_layout`'s header).
check-architecture: ## The §5.3 dependency rule, mechanically
	npm run architecture

# The Python half of this gate is gone with the Python (B1). It walked Python's `ast` to prove
# `domain/` imported nothing but the standard library -- a check TypeScript cannot perform and no
# longer needs, because there is no Python left to be impure. What remains is the half that was
# always going to survive: §8.1's 400-line rule and §6's banned module names, over the contracts and
# the TypeScript tree. The two tools overlapped on Solidity deliberately while both existed; with the
# Python deleted there is only this one.
check-layout: ## The §6 layout rules, mechanically
	node $(TOOLS)/check_layout.ts

# `dist/` mirrors `src/` is the sixth rule here, and it is the one F82 added. `calibrator/package.json`
# maps `./domain/*.js` onto `./dist/domain/*.js`, so `dist/` is what `tsc` and node resolve every
# cross-package specifier to -- and `tsc -b` never removes the output of a file that has been deleted
# or renamed, so a module `src/` no longer contains stays importable. It is a rule rather than a prune
# in the build for two measured reasons: `tsc -b --clean` does not remove an orphan (it removes only
# what its build info records having emitted), and a bulk `rm -rf dist` discards `tsc -b`'s
# incrementality while being refused outright by a guarded run at 320 targets. The rule is
# one-directional -- a *missing* output is `tsc`'s business and every test that imports it will say so.
#
# This target has no `ts-build` prerequisite, so it also runs on a tree that has never been built, and
# an absent `dist/` passes: nothing can be orphaned in a directory that does not exist.

# Until B1 this ran both renderings of `spec/constants.yaml` in `--check` mode, and the pair asserted
# that two independent implementations agreed -- the differential that accepted the port. The Python
# generator is deleted, so there is one rendering and the check is what it always was underneath: the
# committed artifacts are what the generator renders. The two fixture generators are the same shape of
# check, and both read the *compiled* calibrator, because a bare `node` will not resolve `models.ts`'s
# relative `'./constants.js'` to `constants.ts` -- hence `ts-build` rather than an assumption that
# `npm run build` already ran.
check-generated: ts-build ## Fail if any generated file is stale
	node $(TOOLS)/gen_constants.ts --check
	node $(TOOLS)/gen_moments_fixture.ts --check
	node $(TOOLS)/gen_digest_fixture.ts --check

check-fixtures: ## Fail if any spec/ fixture carries an integer a JavaScript reader would round
	node $(TOOLS)/check_fixtures.ts

# `ts-build` because vitest resolves `@bell/calibrator/domain/*` through the calibrator's `exports`
# map, which points at `dist/`. Until B1 this also passed `--interpreter` so the tool could run the
# two service suites through pytest; both the flag and the Python rule it fed are gone. The rule is
# asserted for both TypeScript workspaces -- 95% on lines and branches separately, per workspace, plus
# 100% on all four metrics for every file under either `domain/` tree (F80).
check-coverage: ts-build ## Every coverage rule the brief states, asserted rather than eyeballed
	node $(TOOLS)/check_coverage.ts

# ---------------------------------------------------------------------------- typescript

# The surrounding code is TypeScript (ruling R5), and after B1 it is the only surrounding code.
#
# **`ts-build` is a prerequisite of both `ts-test` and `ts-check`, and it is not a formality.** The
# settlement consumes the calibrator through its `exports` map, which points at `dist/` -- so with no
# build, `tsc` reports `Cannot find module '@bell/calibrator/domain/...'` and vitest cannot resolve the
# same specifier at runtime. That dependency was invisible until A6 created the first cross-workspace
# import, which is why it was not a prerequisite before. The alternative -- a `paths` mapping from the
# specifier to `../calibrator/src/` -- would make the type checker read sources while node runs `dist`,
# i.e. check one thing and execute another, which is the divergence this repository exists to avoid.
#
# The prerequisite also removes a staleness hazard the tests would otherwise have: editing a
# calibrator domain module and running the settlement suite without rebuilding would exercise the
# *previous* build and pass.

ts-install: ## Install the TypeScript workspaces
	npm install

ts-build: ## Compile the TypeScript workspaces
	npm run build

ts-test: ts-build ## The TypeScript suites
	npm run test

# Format and lint only. Types are `check-types` and the dependency rule is `check-architecture`, so a
# full `make check` runs each of those once rather than twice. `npm run verify` is the target that runs
# the whole TypeScript half in one go.
ts-check: ts-build ## Format and lint the TypeScript tree
	npm run format:check
	npm run lint

# ---------------------------------------------------------------------------- housekeeping

# `dist/` and the `tsc -b` build info are build products too, and were the two the target had stopped
# covering: it removed Python's caches until B1, and `npm run build` writes these. Removing them here
# is what makes the docstring true, and it is what keeps the workspace variables above in use.
clean: ## Remove build products
	cd $(CONTRACTS) && rm -rf out cache
	rm -rf $(CALIBRATOR)/dist $(SETTLEMENT)/dist
	find $(CALIBRATOR) $(SETTLEMENT) -name '*.tsbuildinfo' -delete
