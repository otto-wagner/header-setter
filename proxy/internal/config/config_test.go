package config_test

import (
	"log/slog"
	"testing"

	"github.com/otto-wagner/header-setter/proxy/internal/config"
	"github.com/stretchr/testify/assert"
)

func validConfig() config.Config {
	return config.Config{
		ProxyAddr: config.DefaultProxyAddr,
		AdminAddr: config.DefaultAdminAddr,
	}
}

func TestConfig_Validate(t *testing.T) {
	tests := []struct {
		name    string
		modify  func(*config.Config)
		wantErr bool
	}{
		{
			name:   "accepts the defaults",
			modify: func(*config.Config) {},
		},
		{
			name:   "accepts localhost",
			modify: func(c *config.Config) { c.ProxyAddr = "localhost:8899" },
		},
		{
			name:   "accepts an IPv6 loopback address",
			modify: func(c *config.Config) { c.ProxyAddr = "[::1]:8899" },
		},
		{
			name:    "rejects a routable proxy address",
			modify:  func(c *config.Config) { c.ProxyAddr = "0.0.0.0:8899" },
			wantErr: true,
		},
		{
			name:    "rejects a routable admin address",
			modify:  func(c *config.Config) { c.AdminAddr = "192.168.1.10:8900" },
			wantErr: true,
		},
		{
			name:    "rejects a host name that is not loopback",
			modify:  func(c *config.Config) { c.AdminAddr = "example.com:8900" },
			wantErr: true,
		},
		{
			name:    "rejects an address without a port",
			modify:  func(c *config.Config) { c.ProxyAddr = "127.0.0.1" },
			wantErr: true,
		},
		{
			name:    "rejects an empty port",
			modify:  func(c *config.Config) { c.ProxyAddr = "127.0.0.1:" },
			wantErr: true,
		},
		{
			name:    "rejects the same port for both servers",
			modify:  func(c *config.Config) { c.AdminAddr = c.ProxyAddr },
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validConfig()
			test.modify(&cfg)

			err := cfg.Validate()

			if test.wantErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
		})
	}
}

func TestParseLogLevel(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		expected slog.Level
		wantErr  bool
	}{
		{name: "debug", value: "debug", expected: slog.LevelDebug},
		{name: "info", value: "info", expected: slog.LevelInfo},
		{name: "upper case", value: "WARN", expected: slog.LevelWarn},
		{name: "surrounded by spaces", value: " error ", expected: slog.LevelError},
		{name: "unknown name", value: "verbose", wantErr: true},
		{name: "empty", value: "", wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			level, err := config.ParseLogLevel(test.value)

			if test.wantErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, test.expected, level)
		})
	}
}
