# BELL — every workflow is a target. No tribal commands (build brief §6).
#
# `make build` from a fresh clone is the whole setup: it generates the shared constants and the
# cross-language fixtures from `spec/`, then compiles. `make test` and `make check` follow.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# The interpreter. `PYTHON` in the environment wins, then a project-local `.venv`, then whatever
# `python3` happens to be. The fallback chain matters: with a bare `PYTHON ?= python3`, a machine
# whose `python3` has no pytest fails `make test` with "No module named pytest", which reads like a
# broken repository rather than a missing setup step. `make venv` builds the middle option.
PYTHON ?= $(shell if [ -x .venv/bin/python ]; then echo .venv/bin/python; else echo python3; fi)
# The directory holding the console scripts for whichever interpreter `PYTHON` names. `lint-imports`
# is a console script with no `python -m` entry point, so the architecture check needs this on PATH
# -- and forgetting it is exactly how `make check` passes on one machine and fails on the next.
BIN_DIR := $(dir $(PYTHON))
CONTRACTS := contracts
CALIBRATOR := calibrator
SETTLEMENT := settlement
TOOLS := tools

.PHONY: help venv build test test-contracts test-calibrator test-settlement test-fork check \
        check-format check-lint check-types check-architecture check-layout check-generated \
        check-coverage check-fixtures deploy deploy-fork diagnostics gas coverage clean \
        ts-install ts-build ts-test ts-check

help: ## List every target
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------- setup

venv: ## Create .venv and install both workspaces with their development dependencies
	python3 -m venv .venv
	.venv/bin/python -m pip install --quiet --upgrade pip
	.venv/bin/python -m pip install --quiet -e "$(CALIBRATOR)[dev]" -e "$(SETTLEMENT)[dev]"
	@echo "Ready. Now run: make build && make test && make check"

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

# A missing test toolchain is a setup problem, not a failing test, and it should not read like one.
# Checked once here rather than left to surface as "No module named pytest" from deep inside a
# recipe, which sends a reader looking for a bug in the repository.
.PHONY: check-python
check-python:
	@$(PYTHON) -c "import pytest, ruff, mypy, importlinter" 2>/dev/null || { \
		echo ""; \
		echo "  The interpreter '$(PYTHON)' is missing the development dependencies."; \
		echo "  Run 'make venv' to build .venv, or name one that has them:"; \
		echo "      make $(or $(MAKECMDGOALS),test) PYTHON=/path/to/venv/bin/python"; \
		echo ""; \
		exit 1; \
	}

test: test-contracts test-calibrator test-settlement ts-test ## Run the full suite

test-contracts: ## Solidity unit, fuzz, invariant and differential suites
	cd $(CONTRACTS) && forge test -vv

test-calibrator: check-python ## Calibrator unit and cross-language contract suites
	cd $(CALIBRATOR) && $(PYTHON) -m pytest tests -q

test-settlement: check-python ## Settlement route and adjudication suites
	cd $(SETTLEMENT) && $(PYTHON) -m pytest tests -q

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
	cd $(CALIBRATOR) && $(PYTHON) -m pytest tests -q --cov=bell_calibrator --cov-report=term-missing
	cd $(SETTLEMENT) && $(PYTHON) -m pytest tests -q --cov=bell_settlement --cov-report=term-missing

gas: ## Per-operation gas report, against the brief's §13.3 budget
	cd $(CONTRACTS) && forge test --gas-report

# ---------------------------------------------------------------------------- check

check: check-format check-lint check-types check-architecture check-layout check-generated check-fixtures check-coverage ts-check ## Everything CI runs

check-format: ## Formatter check
	cd $(CONTRACTS) && forge fmt --check

check-lint: check-python ## Solidity linter and Python linter
	cd $(CONTRACTS) && forge lint
	cd $(CALIBRATOR) && $(PYTHON) -m ruff check src tests
	cd $(SETTLEMENT) && $(PYTHON) -m ruff check src tests

check-types: check-python ## mypy --strict
	cd $(CALIBRATOR) && $(PYTHON) -m mypy
	cd $(SETTLEMENT) && $(PYTHON) -m mypy

check-architecture: check-python ## The §5.3 dependency rule, mechanically
	cd $(CALIBRATOR) && PATH="$(BIN_DIR):$$PATH" PYTHONPATH=src lint-imports
	cd $(SETTLEMENT) && PATH="$(BIN_DIR):$$PATH" PYTHONPATH=src:../calibrator/src lint-imports

# Both halves, and the pair is the point -- the same reasoning as `check-generated` below. They
# overlap on Solidity deliberately. The Python half still walks Python's `ast` to prove `domain/`
# imports nothing but the standard library, and TypeScript cannot parse Python, so that check is not
# ported and dies with the tree it guards. The TypeScript half is the half that survives, and it is
# the only thing enforcing §8.1's 400-line rule and §6's banned module names on the TypeScript tree.
check-layout: ## The §6 layout rules, mechanically
	node $(TOOLS)/check_layout.ts
	$(PYTHON) $(TOOLS)/check_layout.py

# Both generators, and the pair is the point. The TypeScript one is what `make build` runs, so its
# check proves the committed files are what it renders. The Python one is the oracle the port was
# verified against (tracker A0) and is deliberately not edited to agree with its successor, so its
# check proves that two independent renderings of the same YAML still produce the same bytes. Either
# one failing is a finding; the Python half goes when the Python does (Phase B).
#
# The two fixture generators are the same shape of pair. Their TypeScript halves read the *compiled*
# calibrator, because a bare `node` will not resolve `models.ts`'s relative `'./constants.js'` to
# `constants.ts` -- so this target depends on `ts-build` rather than assuming an earlier `npm run
# build`. Their provenance banners name the derivation rather than the generator for the same reason
# the pair exists at all (F72).
check-generated: ts-build ## Fail if any generated file is stale
	node $(TOOLS)/gen_constants.ts --check
	$(PYTHON) $(TOOLS)/gen_constants.py --check
	node $(TOOLS)/gen_moments_fixture.ts --check
	$(PYTHON) $(TOOLS)/gen_moments_fixture.py --check
	node $(TOOLS)/gen_digest_fixture.ts --check
	$(PYTHON) $(TOOLS)/gen_digest_fixture.py --check

check-fixtures: ## Fail if any spec/ fixture carries an integer a JavaScript reader would round
	node $(TOOLS)/check_fixtures.ts

# The TypeScript half subsumes the Python one: it reproduces both contract rules and both service
# rules, and adds the TypeScript measurement, which nothing asserted before. `check_coverage.py` is
# therefore **not** in this path -- it would repeat the same forge run and the same two pytest runs
# for the same verdict, and the forge run is the expensive part. It is kept as the oracle the port
# was differentially verified against: `.recon/a7/probe.py` feeds both tools the same saved reports
# and requires byte-identical verdicts. It goes at Phase B, with the Python.
#
# `ts-build` because vitest resolves `@bell/calibrator/domain/*` through the calibrator's `exports`
# map, which points at `dist/`.
check-coverage: ts-build check-python ## Every coverage rule the brief states, asserted rather than eyeballed
	node $(TOOLS)/check_coverage.ts --interpreter $(PYTHON)

# ---------------------------------------------------------------------------- typescript

# The surrounding code is TypeScript (ruling R5). These targets are the counterparts of the Python
# ones above, and they run alongside them while the port is in progress.
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

ts-check: ts-build ## Format, lint, types and the §5.3 dependency rule, for TypeScript
	npm run format:check
	npm run lint
	npm run typecheck
	npm run architecture

# ---------------------------------------------------------------------------- housekeeping

clean: ## Remove build products
	cd $(CONTRACTS) && rm -rf out cache
	find $(CALIBRATOR) $(SETTLEMENT) -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf $(CALIBRATOR)/.pytest_cache $(CALIBRATOR)/.mypy_cache $(CALIBRATOR)/.ruff_cache
	rm -rf $(SETTLEMENT)/.pytest_cache $(SETTLEMENT)/.mypy_cache $(SETTLEMENT)/.ruff_cache
