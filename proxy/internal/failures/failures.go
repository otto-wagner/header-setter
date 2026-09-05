package failures

import (
	"maps"
	"strings"
	"sync"
)

const (
	// KindDNS means the target name did not resolve on this machine.
	KindDNS = "dns"
	// KindConnect means the name resolved but the connection did not come up.
	KindConnect = "connect"
)

type Failure struct {
	// Kind is KindDNS or KindConnect.
	Kind    string
	Target  string
	Message string
}

type Log struct {
	mu      sync.RWMutex
	entries map[string]Failure
}

func NewLog() *Log {
	return &Log{entries: make(map[string]Failure)}
}

func (l *Log) Record(host, kind, target, message string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.entries[strings.ToLower(host)] = Failure{Kind: kind, Target: target, Message: message}
}

func (l *Log) Clear(host string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	delete(l.entries, strings.ToLower(host))
}

func (l *Log) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.entries = make(map[string]Failure)
}

func (l *Log) All() map[string]Failure {
	l.mu.RLock()
	defer l.mu.RUnlock()

	entries := make(map[string]Failure, len(l.entries))
	maps.Copy(entries, l.entries)
	return entries
}
