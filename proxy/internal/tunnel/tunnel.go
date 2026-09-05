package tunnel

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otto-wagner/header-setter/proxy/internal/failures"
)

var redactedHeaders = map[string]struct{}{
	"authorization":       {},
	"proxy-authorization": {},
	"cookie":              {},
}

type Resolver interface {
	Route(host string) (string, bool)
}

type FailureRecorder interface {
	Record(host, kind, target, message string)
	Clear(host string)
}

const (
	defaultPort             = "443"
	DefaultHandshakeTimeout = 10 * time.Second
	DefaultDialTimeout      = 10 * time.Second
	DefaultIdleTimeout      = 5 * time.Minute
)

type Options struct {
	// HandshakeTimeout limits how long a client may take to send its CONNECT
	// request after opening the connection.
	HandshakeTimeout time.Duration
	// DialTimeout limits a single connection attempt to an upstream host.
	DialTimeout time.Duration
	// IdleTimeout closes an established tunnel that carried no traffic in
	// either direction for that long.
	IdleTimeout time.Duration
	// Failures are where a failed connection attempt to a routed host is
	// remembered. While it is nil nothing is recorded and the log stays the only
	// place the reason appears.
	Failures FailureRecorder
}

type Server struct {
	resolver Resolver
	logger   *slog.Logger
	options  Options
	dialer   *net.Dialer
	sequence atomic.Uint64
}

func NewServer(resolver Resolver, options Options, logger *slog.Logger) *Server {
	if options.Failures == nil {
		options.Failures = discardedFailures{}
	}

	return &Server{
		resolver: resolver,
		logger:   logger,
		options:  options,
		dialer:   &net.Dialer{Timeout: options.DialTimeout},
	}
}

func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	var (
		tunnels  sync.WaitGroup
		serveErr error
	)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() == nil {
				serveErr = fmt.Errorf("accept connection: %w", err)
			}
			break
		}

		tunnels.Add(1)
		go func() {
			defer tunnels.Done()
			s.handle(ctx, conn)
		}()
	}

	tunnels.Wait()
	return serveErr
}

func (s *Server) handle(ctx context.Context, client net.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer func() { _ = client.Close() }()

	logger := s.logger.With(slog.Uint64("conn", s.sequence.Add(1)))

	request, err := s.readRequest(client)
	if err != nil {
		// Chrome opens speculative connections for every navigation and drops
		// many of them without sending anything. That is normal, not an error.
		logger.DebugContext(ctx, "no readable request from client", slog.Any("error", err))
		return
	}
	if request.Method != http.MethodConnect {
		logger.WarnContext(ctx, "rejected a non-CONNECT request", slog.String("method", request.Method))
		_ = writeStatus(client, "400 Bad Request")
		return
	}

	logRequest(ctx, logger, request.Request)
	if request.Host == "" {
		logger.WarnContext(ctx, "rejected CONNECT without a target host")
		_ = writeStatus(client, "400 Bad Request")
		return
	}

	requestedHost, requestedPort := splitAuthority(request.Host)
	if requestedPort == "" {
		requestedPort = defaultPort
	}
	target, routed := s.resolver.Route(requestedHost)
	if !routed {
		target = requestedHost
	}
	upstreamHost, upstreamPort := splitAuthority(target)
	if upstreamPort == "" {
		upstreamPort = requestedPort
	}
	upstreamAddr := net.JoinHostPort(upstreamHost, upstreamPort)

	upstream, err := s.dialer.DialContext(ctx, "tcp", upstreamAddr)
	if err != nil {
		s.reportDialError(ctx, logger, dial{
			requestedHost: requestedHost,
			upstreamHost:  upstreamHost,
			upstreamAddr:  upstreamAddr,
			routed:        routed,
		}, err)
		_ = writeStatus(client, "502 Bad Gateway")
		return
	}
	defer func() { _ = upstream.Close() }()
	s.clearFailure(requestedHost, routed)

	if err := writeStatus(client, "200 Connection Established"); err != nil {
		logger.DebugContext(ctx, "client gone before the tunnel started", slog.Any("error", err))
		return
	}

	pending, err := drainBuffer(request.buffered)
	if err != nil {
		logger.DebugContext(ctx, "cannot read buffered client bytes", slog.Any("error", err))
		return
	}

	logger.InfoContext(ctx, "tunnel established",
		slog.String("requested", net.JoinHostPort(requestedHost, requestedPort)),
		slog.String("upstream", upstreamAddr))

	started := time.Now()
	bytesToUpstream, bytesToClient := s.relay(ctx, cancel, logger, client, upstream, pending, nil)

	logger.InfoContext(ctx, "tunnel closed",
		slog.String("upstream", upstreamAddr),
		slog.Int64("bytes_to_upstream", bytesToUpstream),
		slog.Int64("bytes_to_client", bytesToClient),
		slog.Duration("duration", time.Since(started)))
}

func (s *Server) relay(
	ctx context.Context,
	stop context.CancelFunc,
	logger *slog.Logger,
	client, upstream net.Conn,
	clientPending, upstreamPending []byte,
) (int64, int64) {
	go func() {
		<-ctx.Done()
		_ = client.Close()
		_ = upstream.Close()
	}()

	clientConn := s.withIdleTimeout(client)
	upstreamConn := s.withIdleTimeout(upstream)

	clientSource := prepend(clientPending, clientConn)
	upstreamSource := prepend(upstreamPending, upstreamConn)

	var (
		bytesToUpstream, bytesToClient int64
		directions                     sync.WaitGroup
	)
	directions.Add(2)
	go func() {
		defer directions.Done()
		defer stop()
		bytesToUpstream = copyStream(ctx, logger, "client_to_upstream", upstreamConn, clientSource)
	}()
	go func() {
		defer directions.Done()
		defer stop()
		bytesToClient = copyStream(ctx, logger, "upstream_to_client", clientConn, upstreamSource)
	}()
	directions.Wait()

	return bytesToUpstream, bytesToClient
}

func prepend(pending []byte, conn net.Conn) io.Reader {
	if len(pending) == 0 {
		return conn
	}
	return io.MultiReader(bytes.NewReader(pending), conn)
}

func copyStream(ctx context.Context, logger *slog.Logger, direction string, dst io.Writer, src io.Reader) int64 {
	copied, err := io.Copy(dst, src)
	if err != nil {
		// Every closed tunnel ends in an error on one of the two directions,
		// so this is only interesting while debugging.
		logger.DebugContext(ctx, "relay ended",
			slog.String("direction", direction),
			slog.Int64("bytes", copied),
			slog.Any("error", err))
	}
	return copied
}

type request struct {
	*http.Request
	buffered *bufio.Reader
}

func (s *Server) readRequest(client net.Conn) (*request, error) {
	if s.options.HandshakeTimeout > 0 {
		if err := client.SetDeadline(time.Now().Add(s.options.HandshakeTimeout)); err != nil {
			return nil, fmt.Errorf("set handshake deadline: %w", err)
		}
	}

	buffered := bufio.NewReader(client)
	parsed, err := http.ReadRequest(buffered)
	if err != nil {
		return nil, fmt.Errorf("read request: %w", err)
	}

	// The handshake deadline must not outlive the handshake, otherwise a slow
	// upstream dial would make the following writes fail.
	if s.options.HandshakeTimeout > 0 {
		if err := client.SetDeadline(time.Time{}); err != nil {
			return nil, fmt.Errorf("clear handshake deadline: %w", err)
		}
	}
	return &request{Request: parsed, buffered: buffered}, nil
}

func (s *Server) withIdleTimeout(conn net.Conn) net.Conn {
	if s.options.IdleTimeout <= 0 {
		return conn
	}
	return &idleConn{Conn: conn, timeout: s.options.IdleTimeout}
}

type idleConn struct {
	net.Conn
	timeout time.Duration
}

func (c *idleConn) Read(p []byte) (int, error) {
	if err := c.refresh(); err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func (c *idleConn) Write(p []byte) (int, error) {
	if err := c.refresh(); err != nil {
		return 0, err
	}
	return c.Conn.Write(p)
}

func (c *idleConn) refresh() error {
	return c.SetDeadline(time.Now().Add(c.timeout))
}

func drainBuffer(buffered *bufio.Reader) ([]byte, error) {
	count := buffered.Buffered()
	if count == 0 {
		return nil, nil
	}

	pending := make([]byte, count)
	if _, err := io.ReadFull(buffered, pending); err != nil {
		return nil, fmt.Errorf("read buffered bytes: %w", err)
	}
	return pending, nil
}

func splitAuthority(authority string) (string, string) {
	host, port, err := net.SplitHostPort(authority)
	if err != nil {
		return authority, ""
	}
	return host, port
}

func writeStatus(w io.Writer, status string, headers ...string) error {
	var response strings.Builder
	response.WriteString("HTTP/1.1 ")
	response.WriteString(status)
	response.WriteString("\r\n")
	for _, header := range headers {
		response.WriteString(header)
		response.WriteString("\r\n")
	}
	response.WriteString("\r\n")

	if _, err := io.WriteString(w, response.String()); err != nil {
		return fmt.Errorf("write status %q: %w", status, err)
	}
	return nil
}

type dial struct {
	requestedHost string
	upstreamHost  string
	upstreamAddr  string
	routed        bool
}

func (s *Server) reportDialError(ctx context.Context, logger *slog.Logger, d dial, err error) {
	kind, message := describeDialError(d, err)

	if dnsErr, ok := errors.AsType[*net.DNSError](err); ok {
		logger.ErrorContext(ctx, "cannot resolve upstream host: the name is unknown to this machine's DNS, so an internal host usually needs a VPN connection",
			slog.String("upstream_host", d.upstreamHost),
			slog.String("dns_error", dnsErr.Err),
			slog.Bool("dns_not_found", dnsErr.IsNotFound))
	} else {
		logger.ErrorContext(ctx, "cannot connect to upstream host",
			slog.String("upstream", d.upstreamAddr),
			slog.Any("error", err))
	}

	if d.routed {
		s.options.Failures.Record(d.requestedHost, kind, d.upstreamAddr, message)
	}
}

func describeDialError(d dial, err error) (string, string) {
	if _, ok := errors.AsType[*net.DNSError](err); ok {
		return failures.KindDNS, fmt.Sprintf(
			"%s is unknown to this machine's DNS, so an internal host usually needs a VPN connection",
			d.upstreamHost)
	}

	// The full error repeats the address that is reported next to it anyway.
	reason := err.Error()
	if opErr, ok := errors.AsType[*net.OpError](err); ok && opErr.Err != nil {
		reason = opErr.Err.Error()
	}
	return failures.KindConnect, fmt.Sprintf("cannot connect to %s: %s", d.upstreamAddr, reason)
}

func (s *Server) clearFailure(requestedHost string, routed bool) {
	if routed {
		s.options.Failures.Clear(requestedHost)
	}
}

type discardedFailures struct{}

func (discardedFailures) Record(_, _, _, _ string) {}

func (discardedFailures) Clear(_ string) {}

func logRequest(ctx context.Context, logger *slog.Logger, request *http.Request) {
	if !logger.Enabled(ctx, slog.LevelDebug) {
		return
	}

	attributes := make([]any, 0, len(request.Header)+1)
	attributes = append(attributes, slog.String("request_line", request.Method+" "+request.RequestURI+" "+request.Proto))
	for name, values := range request.Header {
		value := strings.Join(values, ", ")
		if _, redacted := redactedHeaders[strings.ToLower(name)]; redacted {
			value = "[redacted]"
		}
		attributes = append(attributes, slog.String(strings.ToLower(name), value))
	}
	logger.DebugContext(ctx, "client request", attributes...)
}
