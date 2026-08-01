.PHONY: install install-skill install-mcp install-all doctor uninstall clean test lint format

# Resolve the absolute path to the repo root.
REPO_ROOT := $(shell pwd)
PYTHON ?= python3

# Default: full one-command install.
install: install-skill install-mcp
	@echo ""
	@echo "✓ PropProfessor installed. Try: pp-query doctor"

install-skill:
	@echo "→ Linking propprofessor-coach skill into hermes..."
	@$(PYTHON) scripts/install.py skill

install-mcp:
	@echo "→ Registering propprofessor MCP server with hermes..."
	@$(PYTHON) scripts/install.py mcp

install-all: install

doctor:
	@pp-query doctor

uninstall:
	@echo "→ Removing propprofessor from hermes..."
	@$(PYTHON) scripts/install.py uninstall

clean:
	@rm -rf node_modules coverage

test:
	@npm test

lint:
	@npm run lint

format:
	@npm run format