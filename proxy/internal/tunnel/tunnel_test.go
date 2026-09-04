package tunnel_test

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/otto-wagner/header-setter/proxy/internal/failures"
	"github.com/otto-wagner/header-setter/proxy/internal/routes"
	"github.com/otto-wagner/header-setter/proxy/internal/tunnel"
	"github.com/otto-wagner/header-setter/proxy/mocks"
)

const clientTimeout = 5 * time.Second

func TestServer_TunnelsToTheMappedUpstream(t *testing.T) {
	upstream := startEchoServer(t)
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": upstream}), tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, "staging.example.com:443")

	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)
	assert.Equal(t, "tunnelled bytes", client.echo(t, "tunnelled bytes"))
}

func TestServer_FallsBackToTheRequestedHost(t *testing.T) {
	upstream := startEchoServer(t)
	proxy := startProxy(t, routes.NewTable(), tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, upstream)

	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)
	assert.Equal(t, "unrouted", client.echo(t, "unrouted"))
}

func TestServer_KeepsTheRequestedPortWhenTheTargetHasNone(t *testing.T) {
	upstream := startEchoServer(t)
	upstreamHost, upstreamPort := splitAddr(t, upstream)
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": upstreamHost}), tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, net.JoinHostPort("staging.example.com", upstreamPort))

	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)
	assert.Equal(t, "same port", client.echo(t, "same port"))
}

func TestServer_LooksUpTheRequestedHostWithoutItsPort(t *testing.T) {
	upstream := startEchoServer(t)
	resolver := mocks.NewMockResolver(t)
	resolver.EXPECT().Route("staging.example.com").Return(upstream, true).Once()

	proxy := startProxy(t, resolver, tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, "staging.example.com:443")

	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)
}

func TestServer_ForwardsBytesThatArriveWithTheConnectRequest(t *testing.T) {
	upstream := startEchoServer(t)
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": upstream}), tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	client.write(t, "CONNECT staging.example.com:443 HTTP/1.1\r\nHost: staging.example.com:443\r\n\r\nearly bytes")
	status, _ := client.readHead(t)

	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)
	assert.Equal(t, "early bytes", client.read(t, len("early bytes")))
}

// A request in origin form is a plain (non-CONNECT) request, and this proxy no
// longer forwards those: only https:// via CONNECT is supported.
func TestServer_RejectsARequestWithoutTheFullURL(t *testing.T) {
	proxy := startProxy(t, routes.NewTable(), tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	client.write(t, "GET / HTTP/1.1\r\nHost: "+proxy.addr+"\r\n\r\n")
	status, _ := client.readHead(t)

	assert.Equal(t, "HTTP/1.1 400 Bad Request", status)
}

func TestServer_ReportsAnUnreachableUpstream(t *testing.T) {
	unreachable := closedAddr(t)
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": unreachable}), tunnel.Options{
		DialTimeout: clientTimeout,
	})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, "staging.example.com:443")

	assert.Equal(t, "HTTP/1.1 502 Bad Gateway", status)
}

// The reason a route did not work exists nowhere a user looks: Chrome shows a bare
// ERR_TUNNEL_CONNECTION_FAILED for a tunnel the proxy answered with 502. The popup
// reads it from here instead.
func TestServer_RemembersWhyARoutedHostCouldNotBeReached(t *testing.T) {
	failed := failures.NewLog()
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": closedAddr(t)}), tunnel.Options{
		DialTimeout: clientTimeout,
		Failures:    failed,
	})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, "staging.example.com:443")
	assert.Equal(t, "HTTP/1.1 502 Bad Gateway", status)

	failure, recorded := failed.All()["staging.example.com"]
	require.True(t, recorded, "the failure is keyed by the host the browser asked for")
	assert.Equal(t, failures.KindConnect, failure.Kind)
	assert.Contains(t, failure.Message, "cannot connect to")
}

// A host that has no route failed on its own, so it is none of this proxy's
// business and must not show up next to a route in the popup.
func TestServer_DoesNotRememberAnUnroutedHost(t *testing.T) {
	failed := failures.NewLog()
	proxy := startProxy(t, routes.NewTable(), tunnel.Options{
		DialTimeout: clientTimeout,
		Failures:    failed,
	})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, closedAddr(t))
	assert.Equal(t, "HTTP/1.1 502 Bad Gateway", status)

	assert.Empty(t, failed.All())
}

// A reason that is no longer true must not stay in the popup, so the next
// connection that works forgets it.
func TestServer_ForgetsAFailureAfterAWorkingConnection(t *testing.T) {
	failed := failures.NewLog()
	table := tableWith(map[string]string{"staging.example.com": closedAddr(t)})
	proxy := startProxy(t, table, tunnel.Options{DialTimeout: clientTimeout, Failures: failed})

	failing := dialProxy(t, proxy.addr)
	status, _ := failing.connect(t, "staging.example.com:443")
	require.Equal(t, "HTTP/1.1 502 Bad Gateway", status)
	require.NotEmpty(t, failed.All())

	table.Replace(map[string]string{"staging.example.com": startEchoServer(t)})
	working := dialProxy(t, proxy.addr)
	status, _ = working.connect(t, "staging.example.com:443")
	require.Equal(t, "HTTP/1.1 200 Connection Established", status)

	assert.Empty(t, failed.All())
}

func TestServer_ClosesOpenTunnelsOnShutdown(t *testing.T) {
	upstream := startEchoServer(t)
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": upstream}), tunnel.Options{})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, "staging.example.com:443")
	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)

	assert.NoError(t, proxy.shutdown())

	_, err := client.reader.ReadByte()
	assert.Error(t, err, "the tunnel must be closed once the server shut down")
}

func TestServer_ClosesAnIdleTunnel(t *testing.T) {
	upstream := startEchoServer(t)
	proxy := startProxy(t, tableWith(map[string]string{"staging.example.com": upstream}), tunnel.Options{
		IdleTimeout: 100 * time.Millisecond,
	})

	client := dialProxy(t, proxy.addr)
	status, _ := client.connect(t, "staging.example.com:443")
	assert.Equal(t, "HTTP/1.1 200 Connection Established", status)

	_, err := client.reader.ReadByte()
	assert.Error(t, err, "an idle tunnel must be closed after the idle timeout")
}

func tableWith(mappings map[string]string) *routes.Table {
	table := routes.NewTable()
	table.Replace(mappings)
	return table
}

type testProxy struct {
	addr     string
	shutdown func() error
}

// startProxy runs a Server on a loopback port and asserts on cleanup that it
// shut down without an error.
func startProxy(t *testing.T, resolver tunnel.Resolver, options tunnel.Options) *testProxy {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for proxy: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	server := tunnel.NewServer(resolver, options, slog.New(slog.DiscardHandler))

	stopped := make(chan error, 1)
	go func() {
		stopped <- server.Serve(ctx, listener)
	}()

	done := false
	shutdown := func() error {
		if done {
			return nil
		}
		done = true
		cancel()
		return <-stopped
	}

	t.Cleanup(func() {
		if err := shutdown(); err != nil {
			t.Errorf("serve returned an error: %v", err)
		}
	})
	return &testProxy{addr: listener.Addr().String(), shutdown: shutdown}
}

// startEchoServer stands in for the real upstream host and returns whatever it
// receives, which is enough to prove that bytes pass through unchanged.
func startEchoServer(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for echo server: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return listener.Addr().String()
}

// closedAddr returns an address nothing listens on any more.
func closedAddr(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for closed address: %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	return addr
}

func splitAddr(t *testing.T, addr string) (string, string) {
	t.Helper()

	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %q: %v", addr, err)
	}
	return host, port
}

type testClient struct {
	conn   net.Conn
	reader *bufio.Reader
}

func dialProxy(t *testing.T, addr string) *testClient {
	t.Helper()

	conn, err := net.DialTimeout("tcp", addr, clientTimeout)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if err := conn.SetDeadline(time.Now().Add(clientTimeout)); err != nil {
		t.Fatalf("set client deadline: %v", err)
	}
	return &testClient{conn: conn, reader: bufio.NewReader(conn)}
}

func (c *testClient) connect(t *testing.T, authority string) (string, []string) {
	t.Helper()

	c.write(t, "CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\n\r\n")
	return c.readHead(t)
}

func (c *testClient) write(t *testing.T, raw string) {
	t.Helper()

	if _, err := io.WriteString(c.conn, raw); err != nil {
		t.Fatalf("write to proxy: %v", err)
	}
}

// readHead reads the status line and the headers of the proxy response and
// leaves the tunnelled bytes in the buffer.
func (c *testClient) readHead(t *testing.T) (string, []string) {
	t.Helper()

	status, err := c.reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read status line: %v", err)
	}

	var headers []string
	for {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read header: %v", err)
		}
		if line == "\r\n" {
			break
		}
		headers = append(headers, strings.TrimRight(line, "\r\n"))
	}
	return strings.TrimRight(status, "\r\n"), headers
}

func (c *testClient) echo(t *testing.T, payload string) string {
	t.Helper()

	c.write(t, payload)
	return c.read(t, len(payload))
}

func (c *testClient) read(t *testing.T, count int) string {
	t.Helper()

	received := make([]byte, count)
	if _, err := io.ReadFull(c.reader, received); err != nil {
		t.Fatalf("read from tunnel: %v", err)
	}
	return string(received)
}
