package main

import (
	"context"
	"os"

	"github.com/otto-wagner/header-setter/proxy/cmd/header-setter-proxy/commands"
)

func main() {
	if err := commands.NewRootCommand().ExecuteContext(context.Background()); err != nil {
		os.Exit(1)
	}
}
