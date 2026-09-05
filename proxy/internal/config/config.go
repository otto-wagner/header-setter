package config

import (
	"fmt"
	"log/slog"
	"net"
	"strings"
)

const (
	DefaultProxyAddr = "127.0.0.1:8899"
	DefaultAdminAddr = "127.0.0.1:8900"
	DefaultLogLevel  = "info"
)

type Config struct {
	ProxyAddr string
	AdminAddr string
	Routes    map[string]string
}

func (c Config) Validate() error {
	if err := validateLoopbackAddr("proxy address", c.ProxyAddr); err != nil {
		return err
	}
	if err := validateLoopbackAddr("admin address", c.AdminAddr); err != nil {
		return err
	}
	if c.ProxyAddr == c.AdminAddr {
		return fmt.Errorf("proxy address and admin address must differ, both are %q", c.ProxyAddr)
	}
	return nil
}

func ParseLogLevel(value string) (slog.Level, error) {
	var level slog.Level
	if err := level.UnmarshalText([]byte(strings.TrimSpace(value))); err != nil {
		return 0, fmt.Errorf("invalid log level %q: expected debug, info, warn or error", value)
	}
	return level, nil
}

func validateLoopbackAddr(name, addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%s %q: expected host:port", name, addr)
	}
	if port == "" {
		return fmt.Errorf("%s %q: port is missing", name, addr)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("%s %q: must be a loopback address such as 127.0.0.1, so the proxy is not reachable from the network", name, addr)
	}
	return nil
}
