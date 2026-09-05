package commands

import (
	"log/slog"
	"os"

	"github.com/otto-wagner/header-setter/proxy/internal/config"
	"github.com/spf13/cobra"
)

func NewRootCommand() *cobra.Command {
	var logLevel string

	cmd := &cobra.Command{
		Use:          "header-setter-proxy",
		Short:        "Local proxy that routes hosts to other targets without changing Host or TLS SNI",
		SilenceUsage: true,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			level, err := config.ParseLogLevel(logLevel)
			if err != nil {
				return err
			}
			slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
			return nil
		},
	}

	cmd.PersistentFlags().StringVar(&logLevel, "log-level", config.DefaultLogLevel, "log level: debug, info, warn or error")

	cmd.AddCommand(newServeCommand())

	return cmd
}
