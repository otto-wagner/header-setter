package commands

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/otto-wagner/header-setter/proxy/internal/admin"
	"github.com/otto-wagner/header-setter/proxy/internal/config"
	"github.com/otto-wagner/header-setter/proxy/internal/failures"
	"github.com/otto-wagner/header-setter/proxy/internal/routes"
	"github.com/otto-wagner/header-setter/proxy/internal/tunnel"
	"github.com/spf13/cobra"
)

const longDescription = `Routes selected hosts to a different target on the connection level.

The proxy listens on a loopback port and only tunnels https:// traffic: a
request arrives as CONNECT and is relayed byte for byte without terminating
TLS. Chrome keeps deriving the Host header and TLS SNI from the original URL,
which is the only way to redirect traffic without rewriting a header
extensions cannot touch.

Routes can be passed as host=target arguments at startup. The Header Setter
extension manages routes through the admin API instead, which replaces the
whole table and overrides the arguments given here.

No TLS is terminated, so the browser validates the target's certificate
against the requested host: such a route only works if that certificate is
also valid for the requested host.`

func newServeCommand() *cobra.Command {
	var (
		proxyAddr string
		adminAddr string
	)

	cmd := &cobra.Command{
		Use:   "serve [host=target ...]",
		Short: "Starts the proxy and the admin API",
		Long:  longDescription,
		Args:  cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			mappings, err := routes.Parse(args)
			if err != nil {
				return err
			}

			cfg := config.Config{
				ProxyAddr: proxyAddr,
				AdminAddr: adminAddr,
				Routes:    mappings,
			}
			if err := cfg.Validate(); err != nil {
				return err
			}
			return runServe(cmd.Context(), cfg)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&proxyAddr, "proxy-addr", config.DefaultProxyAddr, "loopback address the proxy listens on")
	flags.StringVar(&adminAddr, "admin-addr", config.DefaultAdminAddr, "loopback address the admin API listens on")

	return cmd
}

func runServe(ctx context.Context, cfg config.Config) error {
	logger := slog.Default()

	ctx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	table := routes.NewTable()
	table.Replace(cfg.Routes)
	failed := failures.NewLog()

	proxyListener, err := net.Listen("tcp", cfg.ProxyAddr)
	if err != nil {
		return fmt.Errorf("listen for proxy on %s: %w", cfg.ProxyAddr, err)
	}
	adminListener, err := net.Listen("tcp", cfg.AdminAddr)
	if err != nil {
		_ = proxyListener.Close()
		return fmt.Errorf("listen for admin api on %s: %w", cfg.AdminAddr, err)
	}

	tunnelServer := tunnel.NewServer(table, tunnel.Options{
		HandshakeTimeout: tunnel.DefaultHandshakeTimeout,
		DialTimeout:      tunnel.DefaultDialTimeout,
		IdleTimeout:      tunnel.DefaultIdleTimeout,
		Failures:         failed,
	}, logger.With(slog.String("component", "tunnel")))

	adminServer := admin.NewServer(table, failed, logger.With(slog.String("component", "admin")))

	logger.InfoContext(ctx, "proxy started",
		slog.String("proxy_addr", proxyListener.Addr().String()),
		slog.String("admin_addr", adminListener.Addr().String()),
		slog.Int("routes", table.Len()))

	ctx, stop := context.WithCancel(ctx)
	defer stop()

	serveErrors := make(chan error, 2)
	var servers sync.WaitGroup

	servers.Add(2)
	go func() {
		defer servers.Done()
		defer stop()
		if err := tunnelServer.Serve(ctx, proxyListener); err != nil {
			serveErrors <- fmt.Errorf("connect proxy: %w", err)
		}
	}()
	go func() {
		defer servers.Done()
		defer stop()
		if err := adminServer.Serve(ctx, adminListener); err != nil {
			serveErrors <- fmt.Errorf("admin api: %w", err)
		}
	}()

	servers.Wait()
	close(serveErrors)

	var collected []error
	for failure := range serveErrors {
		collected = append(collected, failure)
	}
	if err = errors.Join(collected...); err != nil {
		return err
	}

	logger.Info("proxy stopped")
	return nil
}
