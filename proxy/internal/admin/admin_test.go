package admin_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/otto-wagner/header-setter/proxy/internal/admin"
	"github.com/otto-wagner/header-setter/proxy/internal/failures"
	"github.com/otto-wagner/header-setter/proxy/internal/routes"
	"github.com/otto-wagner/header-setter/proxy/mocks"
	"github.com/stretchr/testify/assert"
)

const (
	// testExtension and testExtensionOrigin stand in for the Header Setter
	// extension, which is the only kind of browser origin the API serves.
	testExtension       = "abcdefghijklmnopabcdefghijklmnop"
	testExtensionOrigin = "chrome-extension://" + testExtension
)

func newHandler(store admin.Store) http.Handler {
	return newHandlerFor(store, failures.NewLog())
}

// newHandlerFor uses the real failure log rather than a mock: the endpoint is only
// interesting together with what the tunnel recorded, and a mock would assert the
// call instead of the payload.
func newHandlerFor(store admin.Store, failed admin.Failures) http.Handler {
	return admin.NewServer(store, failed, slog.New(slog.DiscardHandler)).Handler()
}

// call sends a request the way the command line does: without an Origin header,
// and with the JSON content type the API insists on for a POST.
func call(t *testing.T, store admin.Store, method, target string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(method, target, body)
	if method == http.MethodPost {
		request.Header.Set("Content-Type", "application/json")
	}
	return serve(newHandler(store), request)
}

func serve(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestServer_GetRoutes(t *testing.T) {
	store := mocks.NewMockStore(t)
	store.EXPECT().All().Return(map[string]string{"staging.example.com": "prod.example.com"})

	response := call(t, store, http.MethodGet, "/routes", nil)

	assert.Equal(t, http.StatusOK, response.Code)
	assert.JSONEq(t, `{"staging.example.com":"prod.example.com"}`, response.Body.String())
	assert.Equal(t, "application/json", response.Header().Get("Content-Type"))
}

func TestServer_GetRoutesOnAnEmptyTable(t *testing.T) {
	store := mocks.NewMockStore(t)
	store.EXPECT().All().Return(map[string]string{})

	response := call(t, store, http.MethodGet, "/routes", nil)

	assert.Equal(t, http.StatusOK, response.Code)
	assert.JSONEq(t, `{}`, response.Body.String())
}

func TestServer_PostRoutesReplacesTheTable(t *testing.T) {
	mappings := map[string]string{"staging.example.com": "prod.example.com"}
	store := mocks.NewMockStore(t)
	store.EXPECT().Replace(mappings).Once()
	store.EXPECT().All().Return(mappings)

	response := call(t, store, http.MethodPost, "/routes", strings.NewReader(`{"staging.example.com":"prod.example.com"}`))

	assert.Equal(t, http.StatusOK, response.Code)
	assert.JSONEq(t, `{"ok":true,"routes":{"staging.example.com":"prod.example.com"}}`, response.Body.String())
}

func TestServer_PostRoutesAcceptsAnEmptyTable(t *testing.T) {
	store := mocks.NewMockStore(t)
	store.EXPECT().Replace(map[string]string{}).Once()
	store.EXPECT().All().Return(map[string]string{})

	response := call(t, store, http.MethodPost, "/routes", strings.NewReader(`{}`))

	assert.Equal(t, http.StatusOK, response.Code)
	assert.JSONEq(t, `{"ok":true,"routes":{}}`, response.Body.String())
}

// TestServer_PostRoutesRejectsInvalidBodies also asserts that the table is left
// alone: the mock has no Replace expectation, so any call fails the test.
func TestServer_PostRoutesRejectsInvalidBodies(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "broken json", body: `{"staging.example.com":`},
		{name: "json array", body: `["staging.example.com"]`},
		{name: "non string target", body: `{"staging.example.com":8443}`},
		{name: "nested object", body: `{"staging.example.com":{"host":"prod.example.com"}}`},
		{name: "empty body", body: ``},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := mocks.NewMockStore(t)

			response := call(t, store, http.MethodPost, "/routes", strings.NewReader(test.body))

			assert.Equal(t, http.StatusBadRequest, response.Code)
			assert.Contains(t, response.Body.String(), "must be a JSON object")
		})
	}
}

func TestServer_PostRoutesNormalizesThroughTheTable(t *testing.T) {
	table := routes.NewTable()

	response := call(t, table, http.MethodPost, "/routes",
		strings.NewReader(`{" STAGING.example.com ":" prod.example.com ","broken.example.com":""}`))

	assert.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, map[string]string{"staging.example.com": "prod.example.com"}, table.All())
}

// TestServer_RoutesPreflight pins that the allowed origin is echoed rather than
// answered with "*": echoing one origin is what makes the browser refuse the
// response when a web page tries the same call.
func TestServer_RoutesPreflight(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/routes", nil)
	request.Header.Set("Origin", testExtensionOrigin)

	response := serve(newHandler(mocks.NewMockStore(t)), request)

	assert.Equal(t, http.StatusNoContent, response.Code)
	assert.Equal(t, testExtensionOrigin, response.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "Origin", response.Header().Get("Vary"))
	assert.Equal(t, "GET, POST, OPTIONS", response.Header().Get("Access-Control-Allow-Methods"))
	assert.Equal(t, "Content-Type", response.Header().Get("Access-Control-Allow-Headers"))
}

// A request without an Origin header is the local command line, which needs no
// CORS grant at all, and answering it with one would only widen the API.
func TestServer_RoutesPreflightWithoutAnOrigin(t *testing.T) {
	response := call(t, mocks.NewMockStore(t), http.MethodOptions, "/routes", nil)

	assert.Equal(t, http.StatusNoContent, response.Code)
	assert.Empty(t, response.Header().Get("Access-Control-Allow-Origin"))
}

// TestServer_RoutesPreflightGrantsPrivateNetworkAccess covers the case that
// actually happens in the browser: a request from a chrome-extension:// page to
// loopback is a Private Network Access request, and Chrome only sends the POST
// when the preflight is answered with the matching allow header.
func TestServer_RoutesPreflightGrantsPrivateNetworkAccess(t *testing.T) {
	request := httptest.NewRequest(http.MethodOptions, "/routes", nil)
	request.Header.Set("Origin", "chrome-extension://abcdefghijklmnopabcdefghijklmnop")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "content-type")
	request.Header.Set("Access-Control-Request-Private-Network", "true")

	recorder := httptest.NewRecorder()
	newHandler(mocks.NewMockStore(t)).ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusNoContent, recorder.Code)
	assert.Equal(t, "true", recorder.Header().Get("Access-Control-Allow-Private-Network"))
}

// The header is only meaningful as an answer to the preflight, so a plain
// request must not carry it.
func TestServer_RoutesWithoutPrivateNetworkRequest(t *testing.T) {
	response := call(t, mocks.NewMockStore(t), http.MethodOptions, "/routes", nil)

	assert.Empty(t, response.Header().Get("Access-Control-Allow-Private-Network"))
}

func TestServer_RoutesRejectsOtherMethods(t *testing.T) {
	response := call(t, mocks.NewMockStore(t), http.MethodDelete, "/routes", nil)

	assert.Equal(t, http.StatusMethodNotAllowed, response.Code)
	assert.Equal(t, "GET, POST, OPTIONS", response.Header().Get("Allow"))
}

func TestServer_Health(t *testing.T) {
	store := mocks.NewMockStore(t)
	store.EXPECT().All().Return(map[string]string{"staging.example.com": "prod.example.com"})

	response := call(t, store, http.MethodGet, "/health", nil)

	assert.Equal(t, http.StatusOK, response.Code)
	assert.JSONEq(t, `{"status":"ok","routes":1,"failures":{}}`, response.Body.String())
}

// The popup has no other source for this: the browser turns a failed tunnel into
// ERR_TUNNEL_CONNECTION_FAILED, which says nothing about DNS or a missing VPN.
func TestServer_HealthReportsWhyARouteFailed(t *testing.T) {
	store := mocks.NewMockStore(t)
	store.EXPECT().All().Return(map[string]string{"staging.example.com": "prod.internal.example"})

	failed := failures.NewLog()
	failed.Record("staging.example.com", failures.KindDNS, "prod.internal.example:443", "no VPN, no DNS")

	handler := newHandlerFor(store, failed)
	response := serve(handler, httptest.NewRequest(http.MethodGet, "/health", nil))

	assert.Equal(t, http.StatusOK, response.Code)
	assert.JSONEq(t, `{
		"status": "ok",
		"routes": 1,
		"failures": {
			"staging.example.com": {
				"kind": "dns",
				"target": "prod.internal.example:443",
				"message": "no VPN, no DNS"
			}
		}
	}`, response.Body.String())
}

// A replaced table may point somewhere else entirely, which makes every recorded
// reason a statement about a target that is no longer used.
func TestServer_PostRoutesForgetsEarlierFailures(t *testing.T) {
	store := mocks.NewMockStore(t)
	store.EXPECT().Replace(map[string]string{"staging.example.com": "prod.example.com"}).Return()
	store.EXPECT().All().Return(map[string]string{"staging.example.com": "prod.example.com"})

	failed := failures.NewLog()
	failed.Record("staging.example.com", failures.KindDNS, "old.internal.example:443", "no VPN, no DNS")

	request := httptest.NewRequest(http.MethodPost, "/routes",
		strings.NewReader(`{"staging.example.com":"prod.example.com"}`))
	request.Header.Set("Content-Type", "application/json")
	response := serve(newHandlerFor(store, failed), request)

	assert.Equal(t, http.StatusOK, response.Code)
	assert.Empty(t, failed.All())
}

// TestServer_PostRoutesRejectsAnotherContentType covers a security control, not
// a formality: text/plain is a content type a web page may POST without a
// preflight, so accepting it would let any page add a route. The mock has no
// Replace expectation, which also proves the table was left alone.
func TestServer_PostRoutesRejectsAnotherContentType(t *testing.T) {
	tests := []string{"text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""}

	for _, contentType := range tests {
		t.Run("content type "+contentType, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/routes",
				strings.NewReader(`{"staging.example.com":"prod.example.com"}`))
			if contentType != "" {
				request.Header.Set("Content-Type", contentType)
			}

			response := serve(newHandler(mocks.NewMockStore(t)), request)

			assert.Equal(t, http.StatusUnsupportedMediaType, response.Code)
			assert.Contains(t, response.Body.String(), "application/json")
		})
	}
}

func TestServer_PostRoutesAcceptsAContentTypeWithACharset(t *testing.T) {
	mappings := map[string]string{"staging.example.com": "prod.example.com"}
	store := mocks.NewMockStore(t)
	store.EXPECT().Replace(mappings).Once()
	store.EXPECT().All().Return(mappings)

	request := httptest.NewRequest(http.MethodPost, "/routes", strings.NewReader(`{"staging.example.com":"prod.example.com"}`))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")

	response := serve(newHandler(store), request)

	assert.Equal(t, http.StatusOK, response.Code)
}

// TestServer_RejectsAWebPageOrigin is the reason the Origin header is checked at
// all: setting a route redirects a host the browser visits, so no website may be
// able to add one to a running proxy.
func TestServer_RejectsAWebPageOrigin(t *testing.T) {
	tests := []string{
		"https://evil.example.com",
		"http://localhost:3000",
		"null",
		"chrome-extension://",
		"chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html",
	}

	for _, origin := range tests {
		t.Run(origin, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/routes",
				strings.NewReader(`{"staging.example.com":"prod.example.com"}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", origin)

			response := serve(newHandler(mocks.NewMockStore(t)), request)

			assert.Equal(t, http.StatusForbidden, response.Code)
			assert.Empty(t, response.Header().Get("Access-Control-Allow-Origin"))
		})
	}
}

func TestServer_UnknownPath(t *testing.T) {
	response := call(t, mocks.NewMockStore(t), http.MethodGet, "/unknown", nil)

	assert.Equal(t, http.StatusNotFound, response.Code)
	assert.JSONEq(t, `{"error":"not found"}`, response.Body.String())
}
