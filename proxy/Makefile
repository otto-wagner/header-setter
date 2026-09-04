BINARY    := header-setter-proxy
BUILD_DIR := build
CMD       := ./cmd/$(BINARY)

MOCKERY_VERSION       := v3.7.4
GOLANGCI_LINT_VERSION := v2.13.2

LDFLAGS := -s -w

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: fmt
fmt: ## Format every Go file
	gofmt -w .

.PHONY: fmt-check
fmt-check: ## Fail when a Go file is not formatted
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "not formatted:"; echo "$$unformatted"; exit 1; \
	fi

.PHONY: vet
vet: ## Run go vet
	go vet ./...

.PHONY: lint
lint: ## Run golangci-lint
	go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION) run ./...

.PHONY: test
test: ## Run the unit tests
	go test ./...

.PHONY: test-race
test-race: ## Run the unit tests with the race detector
	go test -race ./...

.PHONY: mocks
mocks: ## Regenerate the mocks configured in .mockery.yaml
	go run github.com/vektra/mockery/v3@$(MOCKERY_VERSION)

.PHONY: build
build: ## Build the binary into build/
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BUILD_DIR)/$(BINARY) $(CMD)

.PHONY: run
run: ## Run the proxy, for example: make run ARGS="staging.httpbin.org=httpbin.org"
	go run $(CMD) serve $(ARGS)

.PHONY: tidy
tidy: ## Tidy go.mod and go.sum
	go mod tidy

.PHONY: clean
clean: ## Remove the build output
	rm -rf $(BUILD_DIR)

.PHONY: check
check: fmt-check vet lint test-race ## Run every verification step
