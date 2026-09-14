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
        check-coverage deploy deploy-fork diagnostics gas coverage clean

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
	$(PYTHON) $(TOOLS)/gen_constants.py
	$(PYTHON) $(TOOLS)/gen_moments_fixture.py
	$(PYTHON) $(TOOLS)/gen_digest_fixture.py
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

test: test-contracts test-calibrator test-settlement ## Run the full suite

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

coverage: ## Branch coverage. The brief requires 100% on libraries/ and >=95% overall
	cd $(CONTRACTS) && forge coverage --report summary
	cd $(CALIBRATOR) && $(PYTHON) -m pytest tests -q --cov=bell_calibrator --cov-report=term-missing

gas: ## Per-operation gas report, against the brief's §13.3 budget
	cd $(CONTRACTS) && forge test --gas-report

# ---------------------------------------------------------------------------- check

check: check-format check-lint check-types check-architecture check-layout check-generated check-coverage ## Everything CI runs

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

check-layout: ## The §6 layout rules, mechanically
	$(PYTHON) $(TOOLS)/check_layout.py

check-generated: ## Fail if any generated file is stale
	$(PYTHON) $(TOOLS)/gen_constants.py --check

check-coverage: ## The brief's two coverage rules, asserted rather than eyeballed
	$(PYTHON) $(TOOLS)/check_coverage.py

# ---------------------------------------------------------------------------- housekeeping

clean: ## Remove build products
	cd $(CONTRACTS) && rm -rf out cache
	find $(CALIBRATOR) $(SETTLEMENT) -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf $(CALIBRATOR)/.pytest_cache $(CALIBRATOR)/.mypy_cache $(CALIBRATOR)/.ruff_cache
	rm -rf $(SETTLEMENT)/.pytest_cache $(SETTLEMENT)/.mypy_cache $(SETTLEMENT)/.ruff_cache
