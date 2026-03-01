.PHONY: test lint build check install dev typecheck

install:
	npm install

dev:
	npm run dev

test:
	npm test

lint:
	npm run lint

build:
	npm run build && npm run build:hooks

typecheck:
	npm run typecheck

check: lint typecheck test build  ## Vérification complète (pre-commit)
