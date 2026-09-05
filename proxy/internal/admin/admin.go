package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/otto-wagner/header-setter/proxy/internal/failures"
)

const (
	maxBodyBytes      = 64 << 10
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 15 * time.Second
	writeTimeout      = 15 * time.Second
	idleTimeout       = 60 * time.Second
	shutdownTimeout   = 5 * time.Second
)

// Store is the route table the API exposes.
type Store interface {
	All() map[string]string
	Replace(mappings map[string]string)
}

// Failures is why routed hosts could not be reached, shown to the user in the
// extension since a failed tunnel just shows as ERR_TUNNEL_CONNECTION_FAILED.
type Failures interface {
	All() map[string]failures.Failure
	Reset()
}

// Server serves the admin API. It must only ever be bound to a loopback address:
// setting a route redirects a host the browser visits.
type Server struct {
	store    Store
	failures Failures
	logger   *slog.Logger
}

// NewServer returns a Server that reads and writes routes through store and
// reports the connection failures collected in failures.
func NewServer(store Store, failures Failures, logger *slog.Logger) *Server {
	return &Server{store, failures, logger}
}

// Handler returns the routing tree of the API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/routes", s.handleRoutes)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/", s.handleUnknown)

	return s.withCORS(mux)
}

func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	server := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		ErrorLog:          slog.NewLogLogger(s.logger.Handler(), slog.LevelDebug),
	}

	shutdown := make(chan error, 1)
	go func() {
		<-ctx.Done()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		shutdown <- server.Shutdown(shutdownCtx)
	}()

	if err := server.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve admin api: %w", err)
	}
	if err := <-shutdown; err != nil {
		return fmt.Errorf("shut down admin api: %w", err)
	}
	return nil
}

type errorResponse struct {
	Error string `json:"error"`
}

type updateResponse struct {
	OK     bool              `json:"ok"`
	Routes map[string]string `json:"routes"`
}

type healthResponse struct {
	Status   string                     `json:"status"`
	Routes   int                        `json:"routes"`
	Failures map[string]failureResponse `json:"failures"`
}

// failureResponse is one failed connection attempt, phrased for the popup.
type failureResponse struct {
	Kind    string `json:"kind"`
	Target  string `json:"target"`
	Message string `json:"message"`
}

func (s *Server) handleRoutes(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.writeJSON(r.Context(), w, http.StatusOK, s.store.All())
	case http.MethodPost:
		s.replaceRoutes(w, r)
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, POST, OPTIONS")
		s.writeJSON(r.Context(), w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
	}
}

func (s *Server) replaceRoutes(w http.ResponseWriter, r *http.Request) {
	if !requiresJSON(r) {
		s.writeJSON(r.Context(), w, http.StatusUnsupportedMediaType, errorResponse{
			Error: "content type must be application/json",
		})
		return
	}

	var mappings map[string]string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&mappings); err != nil {
		s.logger.WarnContext(r.Context(), "rejected route update", slog.Any("error", err))
		s.writeJSON(r.Context(), w, http.StatusBadRequest, errorResponse{
			Error: `body must be a JSON object of "host": "target" pairs`,
		})
		return
	}

	s.store.Replace(mappings)
	// A new route makes past failures stale.
	s.failures.Reset()
	routes := s.store.All()
	s.logger.InfoContext(r.Context(), "routes replaced",
		slog.Int("count", len(routes)),
		slog.Any("routes", routes))

	s.writeJSON(r.Context(), w, http.StatusOK, updateResponse{OK: true, Routes: routes})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodOptions {
		w.Header().Set("Allow", "GET, OPTIONS")
		s.writeJSON(r.Context(), w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	s.writeJSON(r.Context(), w, http.StatusOK, healthResponse{
		Status:   "ok",
		Routes:   len(s.store.All()),
		Failures: failureResponses(s.failures.All()),
	})
}

func failureResponses(collected map[string]failures.Failure) map[string]failureResponse {
	reported := make(map[string]failureResponse, len(collected))
	for host, failure := range collected {
		reported[host] = failureResponse{
			Kind:    failure.Kind,
			Target:  failure.Target,
			Message: failure.Message,
		}
	}
	return reported
}

func (s *Server) handleUnknown(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.writeJSON(r.Context(), w, http.StatusNotFound, errorResponse{Error: "not found"})
}

func (s *Server) writeJSON(ctx context.Context, w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line is already on the wire, so the client can only be
		// told by closing the connection.
		s.logger.DebugContext(ctx, "cannot write response body", slog.Any("error", err))
	}
}

// withCORS allows chrome-extension:// origins (popup and service worker) and
// rejects everyone else.
func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !s.originAllowed(origin) {
			s.logger.WarnContext(r.Context(), "rejected request: this origin may not manage routes",
				slog.String("origin", origin))
			s.writeJSON(r.Context(), w, http.StatusForbidden, errorResponse{Error: "origin not allowed"})
			return
		}

		header := w.Header()
		if origin != "" {
			// Echoing the origin instead of "*" blocks a web page from reusing
			// the response.
			header.Set("Access-Control-Allow-Origin", origin)
			header.Add("Vary", "Origin")
		}
		header.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		header.Set("Access-Control-Allow-Headers", "Content-Type")
		header.Set("Access-Control-Max-Age", "600")

		// Chrome sends a Private Network Access preflight for extension-to-loopback
		// requests; without this header it fails with "Failed to fetch" regardless
		// of the other CORS headers.
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			header.Set("Access-Control-Allow-Private-Network", "true")
		}

		next.ServeHTTP(w, r)
	})
}

// originAllowed reports whether a request may use the API. No Origin header
// means a non-browser caller such as the CLI, which is always allowed.
// Otherwise, the origin must be a chrome-extension:// origin; the browser sets
// this header itself, so a page cannot forge it to add routes.
func (s *Server) originAllowed(origin string) bool {
	if origin == "" {
		return true
	}

	_, isExtension := extensionID(origin)
	return isExtension
}

func extensionID(origin string) (string, bool) {
	const scheme = "chrome-extension://"

	id, found := strings.CutPrefix(origin, scheme)
	if !found || id == "" || strings.ContainsAny(id, ":/") {
		return "", false
	}
	return id, true
}

// requiresJSON reports whether the request carries a JSON body. Requiring it
// forces a CORS preflight on every POST, which is where the origin check runs;
// a POST Chrome classifies as a simple request would skip that check.
func requiresJSON(r *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mediaType == "application/json"
}
