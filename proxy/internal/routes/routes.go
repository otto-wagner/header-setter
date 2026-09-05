package routes

import (
	"fmt"
	"maps"
	"strings"
	"sync"
)

type Table struct {
	mu      sync.RWMutex
	entries map[string]string
}

func NewTable() *Table {
	return &Table{entries: make(map[string]string)}
}

func (t *Table) Route(host string) (string, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()

	if target, ok := t.entries[strings.ToLower(host)]; ok {
		return target, true
	}
	return host, false
}

func (t *Table) Replace(mappings map[string]string) {
	entries := make(map[string]string, len(mappings))
	for host, target := range mappings {
		host = strings.ToLower(strings.TrimSpace(host))
		target = strings.TrimSpace(target)
		if host == "" || target == "" {
			continue
		}
		entries[host] = target
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	t.entries = entries
}

func (t *Table) All() map[string]string {
	t.mu.RLock()
	defer t.mu.RUnlock()

	entries := make(map[string]string, len(t.entries))
	maps.Copy(entries, t.entries)
	return entries
}

func (t *Table) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()

	return len(t.entries)
}

func Parse(args []string) (map[string]string, error) {
	mappings := make(map[string]string, len(args))
	for _, arg := range args {
		host, target, found := strings.Cut(arg, "=")
		host = strings.ToLower(strings.TrimSpace(host))
		target = strings.TrimSpace(target)
		if !found || host == "" || target == "" {
			return nil, fmt.Errorf("invalid mapping %q: expected host=target, for example staging.httpbin.org=httpbin.org", arg)
		}
		mappings[host] = target
	}
	return mappings, nil
}
