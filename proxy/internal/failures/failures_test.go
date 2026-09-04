package failures_test

import (
	"testing"

	"github.com/otto-wagner/header-setter/proxy/internal/failures"
	"github.com/stretchr/testify/assert"
)

func TestLog_RecordsTheLastFailurePerHost(t *testing.T) {
	log := failures.NewLog()

	log.Record("staging.example.com", failures.KindDNS, "prod.internal.example:443", "no DNS")
	log.Record("staging.example.com", failures.KindConnect, "prod.internal.example:443", "refused")
	log.Record("qa.example.com", failures.KindDNS, "qa.internal.example:443", "no DNS")

	assert.Equal(t, map[string]failures.Failure{
		"staging.example.com": {
			Kind:    failures.KindConnect,
			Target:  "prod.internal.example:443",
			Message: "refused",
		},
		"qa.example.com": {
			Kind:    failures.KindDNS,
			Target:  "qa.internal.example:443",
			Message: "no DNS",
		},
	}, log.All())
}

// The popup asks for the host as the user typed it, and the tunnel records the
// host the browser sent, so the two only ever meet in one case.
func TestLog_IsCaseInsensitive(t *testing.T) {
	log := failures.NewLog()

	log.Record("Staging.Example.COM", failures.KindDNS, "prod.example.com:443", "no DNS")

	assert.Contains(t, log.All(), "staging.example.com")

	log.Clear("STAGING.example.com")

	assert.Empty(t, log.All())
}

func TestLog_ClearForgetsOneHostOnly(t *testing.T) {
	log := failures.NewLog()
	log.Record("staging.example.com", failures.KindDNS, "prod.example.com:443", "no DNS")
	log.Record("qa.example.com", failures.KindDNS, "qa.example.com:443", "no DNS")

	log.Clear("staging.example.com")

	assert.NotContains(t, log.All(), "staging.example.com")
	assert.Contains(t, log.All(), "qa.example.com")
}

func TestLog_ResetForgetsEverything(t *testing.T) {
	log := failures.NewLog()
	log.Record("staging.example.com", failures.KindDNS, "prod.example.com:443", "no DNS")

	log.Reset()

	assert.Empty(t, log.All())
}

// All returns a copy, so a caller that keeps the map cannot see later failures or
// change what the next caller reads.
func TestLog_AllReturnsACopy(t *testing.T) {
	log := failures.NewLog()
	log.Record("staging.example.com", failures.KindDNS, "prod.example.com:443", "no DNS")

	taken := log.All()
	delete(taken, "staging.example.com")

	assert.Contains(t, log.All(), "staging.example.com")
}
