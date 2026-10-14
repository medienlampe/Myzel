# Myzel — convenience targets around pnpm and Docker. Run `make` for the list.
#
# Settings come from, in order: the environment / `make VAR=value`, then `.env`
# (read by Node's own --env-file parser, the same way the server sees it), then
# the defaults below. Works with GNU Make 3.81 (the version macOS ships).

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
ENV_FILE := $(ROOT)/.env
# Only when it exists: Node otherwise prints a notice on every run.
NODE_ENV_FILE := $(if $(wildcard $(ENV_FILE)),--env-file=$(ENV_FILE))

# Bundle the dev and agent targets work on. Unless BUNDLE_ROOT is set (in the
# environment or .env), that is demo-bundle/: a gitignored copy of
# sample-bundle/, so agent runs never dirty the tracked sample. Relative paths
# are taken from the repository root, wherever the target runs.
ENV_BUNDLE_ROOT := $(shell node $(NODE_ENV_FILE) -p 'process.env.BUNDLE_ROOT || ""' 2>/dev/null)
ENV_PROFILES_ROOT := $(shell node $(NODE_ENV_FILE) -p 'process.env.PROFILES_ROOT || ""' 2>/dev/null)
BUNDLE_ROOT ?= $(or $(ENV_BUNDLE_ROOT),demo-bundle)
# A leading ~/ is expanded here: zsh leaves `make BUNDLE_ROOT=~/x` unexpanded.
BUNDLE_HOME := $(patsubst ~/%,$(HOME)/%,$(BUNDLE_ROOT))
BUNDLE_PATH := $(abspath $(if $(filter /%,$(BUNDLE_HOME)),$(BUNDLE_HOME),$(ROOT)/$(BUNDLE_HOME)))
DEMO_BUNDLE := $(ROOT)/demo-bundle

# Profile mode (one memory per API key) when PROFILES_ROOT is set; resolved
# like BUNDLE_ROOT. Passed explicitly so a relative value still works from the
# package directories the targets run in.
PROFILES_ROOT ?= $(ENV_PROFILES_ROOT)
PROFILES_HOME := $(patsubst ~/%,$(HOME)/%,$(PROFILES_ROOT))
PROFILES_PATH := $(if $(PROFILES_HOME),$(abspath $(if $(filter /%,$(PROFILES_HOME)),$(PROFILES_HOME),$(ROOT)/$(PROFILES_HOME))))
PROFILES_ENV := $(if $(PROFILES_PATH),PROFILES_ROOT="$(PROFILES_PATH)")

# Where the settings page (ADMIN_TOKEN) saves its changes: a gitignored file in
# the repository root unless SETTINGS_FILE says otherwise. Resolved like BUNDLE_ROOT.
ENV_SETTINGS_FILE := $(shell node $(NODE_ENV_FILE) -p 'process.env.SETTINGS_FILE || ""' 2>/dev/null)
SETTINGS_FILE ?= $(or $(ENV_SETTINGS_FILE),.myzel-settings.json)
SETTINGS_HOME := $(patsubst ~/%,$(HOME)/%,$(SETTINGS_FILE))
SETTINGS_ENV := SETTINGS_FILE="$(abspath $(if $(filter /%,$(SETTINGS_HOME)),$(SETTINGS_HOME),$(ROOT)/$(SETTINGS_HOME)))"

IMAGE ?= myzel:local
IMAGE_CHECK_PORT ?= 3899

.PHONY: help install build dev start demo mcp-stdio profiles query mutate bundle reset-demo \
	check test coverage lint lint-fix format format-check audit \
	up down logs demo-up demo-down image image-check clean distclean \
	_dev-core _dev-server _dev-web

##@ Getting started

help: ## Show this help
	@awk 'BEGIN { FS = ":.*## " } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
		/^[a-zA-Z_-]+:.*## / { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@if [ -n "$(PROFILES_PATH)" ]; then printf '\nProfiles: %s (profile mode)\n' "$(PROFILES_PATH)"; \
	else printf '\nBundle: %s\n' "$(BUNDLE_PATH)"; fi
	@printf 'Examples: make dev · make query Q="What do we know about billing?" · make check\n'

install: node_modules ## Install dependencies exactly as locked (like CI)

node_modules: package.json pnpm-lock.yaml packages/*/package.json
	pnpm install --frozen-lockfile
	@touch node_modules

build: node_modules ## Build all packages (core, server, web)
	pnpm -r build

##@ Running

dev: node_modules bundle ## Run everything with live reload: server :3800, web UI :5180
	@pnpm --filter @myzel/core build >/dev/null
	@echo "Dev mode on $(or $(PROFILES_PATH),$(BUNDLE_PATH)) — web UI at http://localhost:5180 (Ctrl-C stops all)" >&2
	@$(MAKE) --no-print-directory -j3 _dev-core _dev-server _dev-web

_dev-core:
	@pnpm --filter @myzel/core dev
_dev-server:
	@cd packages/server && BUNDLE_ROOT="$(BUNDLE_PATH)" $(PROFILES_ENV) $(SETTINGS_ENV) node_modules/.bin/tsx watch $(NODE_ENV_FILE) src/index.ts
_dev-web:
	@pnpm --filter @myzel/web dev

start: build bundle ## Build, then serve the web UI, /api and /mcp on :3800
	@BUNDLE_ROOT="$(BUNDLE_PATH)" $(PROFILES_ENV) $(SETTINGS_ENV) node $(NODE_ENV_FILE) packages/server/dist/index.js

demo: build ## Read-only demo of a throwaway copy of sample-bundle/ on :3800 (DEMO_MODE)
	@tmp="$${TMPDIR:-/tmp}"; dir=$$(mktemp -d "$${tmp%/}/myzel-demo.XXXXXX"); \
	trap 'rm -rf "$$dir"' EXIT; \
	cp -R "$(ROOT)/sample-bundle/." "$$dir/"; \
	echo "Demo of sample-bundle/ (read-only) — http://localhost:$${PORT:-3800} (Ctrl-C stops it)" >&2; \
	DEMO_MODE=true BUNDLE_ROOT="$$dir" PROFILES_ROOT= node $(NODE_ENV_FILE) packages/server/dist/index.js

mcp-stdio: bundle ## Serve MCP over stdio (run `make build` first; for MCP client configs)
	@BUNDLE_ROOT="$(BUNDLE_PATH)" $(SETTINGS_ENV) exec node $(NODE_ENV_FILE) packages/server/dist/mcp/stdio.js

profiles: node_modules ## Manage profiles (PROFILES_ROOT): make profiles ARGS="create work"
	@[ -n "$(PROFILES_PATH)" ] || { echo "Set PROFILES_ROOT (environment, .env or make PROFILES_ROOT=…)" >&2; exit 2; }
	@cd packages/server && $(PROFILES_ENV) node_modules/.bin/tsx $(NODE_ENV_FILE) src/profiles-cli.ts $(ARGS)

query: node_modules bundle ## Ask the memory a question: make query Q="…"
	@[ -n "$$Q" ] || { echo 'Usage: make query Q="your question"' >&2; exit 2; }
	@cd packages/core && BUNDLE_ROOT="$(BUNDLE_PATH)" node_modules/.bin/tsx $(NODE_ENV_FILE) src/agent/cli.ts query "$$Q"

mutate: node_modules bundle ## Teach or change the memory: make mutate I="…"
	@[ -n "$$I" ] || { echo 'Usage: make mutate I="what to remember or change"' >&2; exit 2; }
	@cd packages/core && BUNDLE_ROOT="$(BUNDLE_PATH)" node_modules/.bin/tsx $(NODE_ENV_FILE) src/agent/cli.ts mutate "$$I"

bundle: ## Create demo-bundle/ from sample-bundle/ if it is the bundle in use and missing
	@[ -z "$(PROFILES_PATH)" ] || exit 0; \
	if [ "$(BUNDLE_PATH)" = "$(DEMO_BUNDLE)" ] && [ ! -d "$(DEMO_BUNDLE)" ]; then \
		cp -R "$(ROOT)/sample-bundle" "$(DEMO_BUNDLE)"; \
		echo "Created demo-bundle/ from sample-bundle/ (gitignored — safe to mutate)" >&2; \
	fi
	@[ -n "$(PROFILES_PATH)" ] || [ -d "$(BUNDLE_PATH)" ] || { echo "Bundle directory not found: $(BUNDLE_PATH)" >&2; exit 1; }

reset-demo: ## Throw away demo-bundle/ and copy sample-bundle/ again
	rm -rf "$(DEMO_BUNDLE)"
	cp -R "$(ROOT)/sample-bundle" "$(DEMO_BUNDLE)"

##@ Quality

check: install audit lint format-check coverage ## Everything CI runs, in CI's order

test: build ## Run all tests and typechecks
	pnpm test

coverage: build ## Tests with coverage; fails below 80% (reports in packages/*/coverage/)
	pnpm test:coverage

lint: node_modules ## Lint with ESLint
	pnpm lint

lint-fix: node_modules ## Lint and apply automatic fixes
	pnpm lint:fix

format: node_modules ## Format everything with Prettier
	pnpm format

format-check: node_modules ## Check formatting without changing files
	pnpm format:check

audit: node_modules ## Fail on high/critical advisories in production dependencies
	pnpm audit --prod --audit-level high

##@ Docker

up: ## Build and start the container (docker-compose.yml; mounts ./sample-bundle)
	docker compose up -d --build

down: ## Stop and remove the container
	docker compose down

logs: ## Follow the container's logs
	docker compose logs -f

demo-up: ## Build and start the read-only demo container (docker-compose.demo.yml)
	docker compose -f docker-compose.demo.yml up -d --build

demo-down: ## Stop and remove the demo container
	docker compose -f docker-compose.demo.yml down

image: ## Build the Docker image (tag: IMAGE, default myzel:local)
	docker build -t $(IMAGE) .

image-check: image ## Build, start and health-check the image, then stop it cleanly
	@name=myzel-image-check; \
	trap 'docker rm -f $$name >/dev/null 2>&1' EXIT; \
	docker rm -f $$name >/dev/null 2>&1; \
	docker run -d --name $$name -p 127.0.0.1:$(IMAGE_CHECK_PORT):3800 \
		-e LLM_API_BASE_URL=http://127.0.0.1:9/v1 -e LLM_API_KEY=dummy -e LLM_MODEL=dummy \
		$(IMAGE) >/dev/null; \
	echo "Waiting for the health check…"; \
	for i in $$(seq 1 60); do \
		status=$$(docker inspect -f '{{.State.Health.Status}}' $$name 2>/dev/null); \
		[ "$$status" = healthy ] && break; \
		[ "$$(docker inspect -f '{{.State.Running}}' $$name)" = true ] || break; \
		sleep 1; \
	done; \
	if [ "$$status" != healthy ]; then \
		echo "FAILED: container is not healthy (status: $${status:-exited})"; docker logs $$name; exit 1; \
	fi; \
	echo "healthy"; \
	docker stop $$name >/dev/null; \
	code=$$(docker inspect -f '{{.State.ExitCode}}' $$name); \
	[ "$$code" = 0 ] || { echo "FAILED: exit code $$code after docker stop"; docker logs $$name; exit 1; }; \
	echo "stopped cleanly — image OK"

##@ Cleaning

clean: ## Remove build output and coverage reports
	rm -rf packages/*/dist packages/*/*.tsbuildinfo packages/*/coverage

distclean: clean ## Also remove node_modules and demo-bundle/
	rm -rf node_modules packages/*/node_modules "$(DEMO_BUNDLE)"
