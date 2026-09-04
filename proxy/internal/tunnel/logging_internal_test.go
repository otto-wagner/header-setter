package tunnel

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/otto-wagner/header-setter/proxy/internal/failures"
	"github.com/stretchr/testify/assert"
)

func readTestRequest(t *testing.T, raw string) *request {
	t.Helper()

	buffered := bufio.NewReader(strings.NewReader(raw))
	parsed, err := http.ReadRequest(buffered)
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	return &request{Request: parsed, buffered: buffered}
}

// TestReportDialError_NamesADNSFailure pins the operator-facing wording for the
// failure that hides behind a generic dial error most often: an internal
// hostname that only resolves against a company DNS server.
func TestReportDialError_NamesADNSFailure(t *testing.T) {
	var logged bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelError}))
	server := NewServer(nil, Options{}, logger)

	server.reportDialError(context.Background(), logger, dial{
		requestedHost: "qa.example.com",
		upstreamHost:  "qa.example.com",
		upstreamAddr:  "qa.example.com:443",
	}, &net.OpError{
		Op:  "dial",
		Net: "tcp",
		Err: &net.DNSError{
			Err:        "nodename nor servname provided, or not known",
			Name:       "qa.example.com",
			IsNotFound: true,
		},
	})

	output := logged.String()
	assert.Contains(t, output, "cannot resolve upstream host")
	assert.Contains(t, output, "VPN connection")
	assert.Contains(t, output, "upstream_host=qa.example.com")
	assert.Contains(t, output, "nodename nor servname provided")
	assert.Contains(t, output, "dns_not_found=true")
}

func TestReportDialError_ReportsOtherFailuresAsConnectionErrors(t *testing.T) {
	var logged bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelError}))
	server := NewServer(nil, Options{}, logger)

	server.reportDialError(context.Background(), logger, dial{
		requestedHost: "prod.example.com",
		upstreamHost:  "prod.example.com",
		upstreamAddr:  "prod.example.com:443",
	}, &net.OpError{
		Op:  "dial",
		Net: "tcp",
		Err: assert.AnError,
	})

	output := logged.String()
	assert.Contains(t, output, "cannot connect to upstream host")
	assert.Contains(t, output, "upstream=prod.example.com:443")
	assert.NotContains(t, output, "cannot resolve upstream host")
}

// The message ends up in the popup, where nobody has the log next to it, so it
// has to name both the host that failed and what to do about it.
func TestDescribeDialError_ExplainsAnUnresolvableName(t *testing.T) {
	kind, message := describeDialError(dial{
		upstreamHost: "qa.internal.example",
		upstreamAddr: "qa.internal.example:443",
	}, &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", IsNotFound: true}})

	assert.Equal(t, failures.KindDNS, kind)
	assert.Contains(t, message, "qa.internal.example")
	assert.Contains(t, message, "VPN connection")
}

// A connection error carries its own reason, which is the useful half of a
// net.OpError; the "dial tcp ..." prefix around it only repeats the address.
func TestDescribeDialError_KeepsTheReasonOfAConnectionError(t *testing.T) {
	kind, message := describeDialError(dial{
		upstreamHost: "prod.example.com",
		upstreamAddr: "prod.example.com:443",
	}, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")})

	assert.Equal(t, failures.KindConnect, kind)
	assert.Equal(t, "cannot connect to prod.example.com:443: connection refused", message)
}

func TestSplitAuthority(t *testing.T) {
	tests := []struct {
		name         string
		authority    string
		expectedHost string
		expectedPort string
	}{
		{name: "host and port", authority: "prod.example.com:443", expectedHost: "prod.example.com", expectedPort: "443"},
		{name: "host only", authority: "prod.example.com", expectedHost: "prod.example.com", expectedPort: ""},
		{name: "empty port", authority: "prod.example.com:", expectedHost: "prod.example.com", expectedPort: ""},
		{name: "bracketed IPv6 with port", authority: "[::1]:443", expectedHost: "::1", expectedPort: "443"},
		{name: "bare IPv6 without port", authority: "2001:db8::1", expectedHost: "2001:db8::1", expectedPort: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			host, port := splitAuthority(test.authority)

			assert.Equal(t, test.expectedHost, host)
			assert.Equal(t, test.expectedPort, port)
		})
	}
}

func TestLogRequest_RedactsCredentialHeaders(t *testing.T) {
	var logged bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))

	parsed := readTestRequest(t, "CONNECT prod.example.com:443 HTTP/1.1\r\nHost: prod.example.com:443\r\nProxy-Authorization: Basic c2VjcmV0\r\nUser-Agent: Chrome\r\n\r\n")
	logRequest(context.Background(), logger, parsed.Request)

	output := logged.String()
	assert.Contains(t, output, "user-agent=Chrome")
	assert.Contains(t, output, "proxy-authorization=[redacted]")
	assert.NotContains(t, output, "c2VjcmV0")
}

func TestLogRequest_StaysSilentBelowDebugLevel(t *testing.T) {
	var logged bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelInfo}))

	parsed := readTestRequest(t, "CONNECT prod.example.com:443 HTTP/1.1\r\nHost: prod.example.com:443\r\nUser-Agent: Chrome\r\n\r\n")
	logRequest(context.Background(), logger, parsed.Request)

	assert.Empty(t, logged.String())
}
