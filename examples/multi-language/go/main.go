// QuorumProof REST quickstart — Go (standard library only).
//
// Implements the scenario in ../SPEC.md. Run:
//
//	QP_API_URL=http://localhost:3000 go run .
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

var (
	baseURL = strings.TrimRight(getenv("QP_API_URL", "http://localhost:3000"), "/")
	apiKey  = os.Getenv("QP_API_KEY")
	client  = &http.Client{Timeout: 10 * time.Second}
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// request sends a JSON request and decodes the response body into out.
// Non-2xx responses still carry a Problem Details body, so it is decoded too.
func request(method, path string, body, out any) (int, error) {
	var reader *bytes.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(buf)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, baseURL+path, reader)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, json.NewDecoder(resp.Body).Decode(out)
}

type credential struct {
	CredentialType int    `json:"credential_type"`
	Revoked        bool   `json:"revoked"`
	Issuer         string `json:"issuer"`
}

type batchResponse struct {
	Results []struct {
		CredentialID int    `json:"credential_id"`
		ClaimType    string `json:"claim_type"`
		Status       string `json:"status"`
	} `json:"results"`
	Summary struct {
		Total      int `json:"total"`
		Verified   int `json:"verified"`
		NotFound   int `json:"not_found"`
		Duplicates int `json:"duplicates_deduplicated"`
	} `json:"summary"`
}

type problem struct {
	Title string `json:"title"`
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func main() {
	// 1. Fetch a credential.
	var cred credential
	if status, err := request("GET", "/api/v2/credentials/42", nil, &cred); err != nil || status != 200 {
		fail("GET credential 42 failed: HTTP %d %v", status, err)
	}
	fmt.Printf("credential 42: type=%d revoked=%t issuer=%s\n", cred.CredentialType, cred.Revoked, cred.Issuer)

	// 2. Batch-verify claims.
	items := map[string]any{"items": []map[string]any{
		{"credential_id": 42, "claim_type": "HasDegree"},
		{"credential_id": 42, "claim_type": "HasDegree"},
		{"credential_id": 99, "claim_type": "HasLicense"},
	}}
	var batch batchResponse
	if status, err := request("POST", "/api/verify/batch", items, &batch); err != nil || status != 200 {
		fail("POST verify/batch failed: HTTP %d %v", status, err)
	}
	s := batch.Summary
	fmt.Printf("batch: total=%d verified=%d not_found=%d duplicates=%d\n", s.Total, s.Verified, s.NotFound, s.Duplicates)
	for _, r := range batch.Results {
		fmt.Printf("  %d %s -> %s\n", r.CredentialID, r.ClaimType, r.Status)
	}

	// 3. Handle a missing credential.
	var p problem
	if status, err := request("GET", "/api/v2/credentials/99", nil, &p); err != nil || status != 404 {
		fail("GET credential 99: expected 404, got HTTP %d %v", status, err)
	}
	fmt.Printf("credential 99: not found (%s)\n", p.Title)
}
