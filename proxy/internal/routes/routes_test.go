package routes_test

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/otto-wagner/header-setter/proxy/internal/routes"
)

// TestTable_Route also pins the second return value, because it decides more
// than the target: the tunnel only terminates TLS for a host that is routed.
func TestTable_Route(t *testing.T) {
	tests := []struct {
		name          string
		mappings      map[string]string
		host          string
		expected      string
		expectedRoute bool
	}{
		{
			name:          "returns the mapped target",
			mappings:      map[string]string{"staging.example.com": "prod.example.com"},
			host:          "staging.example.com",
			expected:      "prod.example.com",
			expectedRoute: true,
		},
		{
			name:     "falls back to the requested host",
			mappings: map[string]string{"staging.example.com": "prod.example.com"},
			host:     "www.example.com",
			expected: "www.example.com",
		},
		{
			name:          "looks up a host case insensitively",
			mappings:      map[string]string{"staging.example.com": "prod.example.com"},
			host:          "STAGING.Example.Com",
			expected:      "prod.example.com",
			expectedRoute: true,
		},
		{
			name:          "stores a host case insensitively",
			mappings:      map[string]string{"STAGING.EXAMPLE.COM": "prod.example.com"},
			host:          "staging.example.com",
			expected:      "prod.example.com",
			expectedRoute: true,
		},
		{
			name:          "keeps an explicit port in the target",
			mappings:      map[string]string{"staging.example.com": "prod.example.com:8443"},
			host:          "staging.example.com",
			expected:      "prod.example.com:8443",
			expectedRoute: true,
		},
		{
			name:     "falls back on an empty table",
			mappings: nil,
			host:     "staging.example.com",
			expected: "staging.example.com",
		},
		{
			name:          "reports a route that points at the host itself",
			mappings:      map[string]string{"staging.example.com": "staging.example.com"},
			host:          "staging.example.com",
			expected:      "staging.example.com",
			expectedRoute: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			table := routes.NewTable()
			table.Replace(test.mappings)

			target, routed := table.Route(test.host)

			assert.Equal(t, test.expected, target)
			assert.Equal(t, test.expectedRoute, routed)
		})
	}
}

func TestTable_Replace(t *testing.T) {
	tests := []struct {
		name     string
		mappings map[string]string
		expected map[string]string
	}{
		{
			name:     "trims and lower cases entries",
			mappings: map[string]string{"  STAGING.example.com ": "  prod.example.com  "},
			expected: map[string]string{"staging.example.com": "prod.example.com"},
		},
		{
			name:     "drops an entry without a target",
			mappings: map[string]string{"staging.example.com": "  ", "qa.example.com": "prod.example.com"},
			expected: map[string]string{"qa.example.com": "prod.example.com"},
		},
		{
			name:     "drops an entry without a host",
			mappings: map[string]string{"": "prod.example.com", "qa.example.com": "prod.example.com"},
			expected: map[string]string{"qa.example.com": "prod.example.com"},
		},
		{
			name:     "accepts no mappings at all",
			mappings: nil,
			expected: map[string]string{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			table := routes.NewTable()
			table.Replace(test.mappings)

			assert.Equal(t, test.expected, table.All())
			assert.Equal(t, len(test.expected), table.Len())
		})
	}
}

func TestTable_ReplaceDropsPreviousEntries(t *testing.T) {
	table := routes.NewTable()
	table.Replace(map[string]string{"staging.example.com": "prod.example.com"})

	table.Replace(map[string]string{"qa.example.com": "prod.example.com"})

	assert.Equal(t, map[string]string{"qa.example.com": "prod.example.com"}, table.All())

	target, routed := table.Route("staging.example.com")
	assert.Equal(t, "staging.example.com", target)
	assert.False(t, routed, "the removed host must no longer count as routed")
}

func TestTable_AllReturnsACopy(t *testing.T) {
	table := routes.NewTable()
	table.Replace(map[string]string{"staging.example.com": "prod.example.com"})

	entries := table.All()
	entries["staging.example.com"] = "example.com"
	delete(entries, "staging.example.com")

	target, _ := table.Route("staging.example.com")
	assert.Equal(t, "prod.example.com", target)
}

// TestTable_ConcurrentAccess is meaningful under -race, which the Makefile and
// the CI workflow enable.
func TestTable_ConcurrentAccess(t *testing.T) {
	table := routes.NewTable()

	var work sync.WaitGroup
	for range 50 {
		work.Add(2)
		go func() {
			defer work.Done()
			table.Replace(map[string]string{"staging.example.com": "prod.example.com"})
		}()
		go func() {
			defer work.Done()
			_, _ = table.Route("staging.example.com")
			table.All()
			table.Len()
		}()
	}
	work.Wait()

	target, _ := table.Route("staging.example.com")
	assert.Equal(t, "prod.example.com", target)
}

func TestParse(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		expected map[string]string
		wantErr  bool
	}{
		{
			name:     "reads several mappings",
			args:     []string{"staging.example.com=prod.example.com", "qa.example.com=prod.example.com:8443"},
			expected: map[string]string{"staging.example.com": "prod.example.com", "qa.example.com": "prod.example.com:8443"},
		},
		{
			name:     "trims and lower cases a mapping",
			args:     []string{" STAGING.example.com = prod.example.com "},
			expected: map[string]string{"staging.example.com": "prod.example.com"},
		},
		{
			name:     "accepts no arguments",
			args:     nil,
			expected: map[string]string{},
		},
		{
			name:    "rejects an argument without a separator",
			args:    []string{"staging.example.com"},
			wantErr: true,
		},
		{
			name:    "rejects a mapping without a target",
			args:    []string{"staging.example.com="},
			wantErr: true,
		},
		{
			name:    "rejects a mapping without a host",
			args:    []string{"=prod.example.com"},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mappings, err := routes.Parse(test.args)

			if test.wantErr {
				assert.Error(t, err)
				assert.Nil(t, mappings)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, test.expected, mappings)
		})
	}
}
