.PHONY: check test build install dev-shell pack release-check

check:
	npm run check

test:
	npm test

build:
	npm run build

install:
	npm run install:local

dev-shell:
	npm run dev:shell

pack:
	npm run pack

release-check:
	npm run release:check
