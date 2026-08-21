package tracker

import (
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestFrontMarshalFixedKeyOrder(t *testing.T) {
	fm := FrontMatter{
		ID:         "03",
		Title:      "Test",
		Map:        "test-map",
		Type:       "task",
		Status:     "open",
		Triage:     nil,
		BlockedBy:  []string{"01", "02"},
		CreatedAt:  time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ClaimedAt:  nil,
		ResolvedAt: nil,
	}

	out, err := fm.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	want := `---
id: "03"
title: Test
map: test-map
type: task
status: open
triage: null
blocked_by: ["01", "02"]
created_at: 2026-08-19T12:00:00Z
reviewed_at: null
claimed_at: null
resolved_at: null
---
`
	if diff := cmp.Diff(want, string(out)); diff != "" {
		t.Errorf("Marshal() mismatch (-want +got):\n%s", diff)
	}
}

func TestFrontMarshalEmptyBlockedBy(t *testing.T) {
	fm := FrontMatter{
		ID:        "01",
		Title:     "Empty",
		Map:       "m",
		Type:      "task",
		Status:    "open",
		BlockedBy: []string{},
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
	}

	out, err := fm.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	if !contains(string(out), "blocked_by: []") {
		t.Errorf("expected blocked_by: [], got:\n%s", string(out))
	}
}

func TestFrontMarshalNilBlockedBy(t *testing.T) {
	fm := FrontMatter{
		ID:        "01",
		Title:     "Nil",
		Map:       "m",
		Type:      "task",
		Status:    "open",
		BlockedBy: nil,
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
	}

	out, err := fm.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	if !contains(string(out), "blocked_by: []") {
		t.Errorf("expected blocked_by: [] for nil, got:\n%s", string(out))
	}
}

func TestFrontRoundTrip(t *testing.T) {
	original := FrontMatter{
		ID:         "05",
		Title:      "Round Trip 测试",
		Map:        "test-map",
		Type:       "research",
		Status:     "resolved",
		Triage:     strPtr("ready-for-agent"),
		BlockedBy:  []string{"01", "03"},
		CreatedAt:  time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ReviewedAt: timePtr(time.Date(2026, 8, 19, 12, 30, 0, 0, time.UTC)),
		ClaimedAt:  timePtr(time.Date(2026, 8, 19, 13, 0, 0, 0, time.UTC)),
		ResolvedAt: timePtr(time.Date(2026, 8, 19, 14, 0, 0, 0, time.UTC)),
	}

	data, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	parsed, err := ParseFrontMatter(data)
	if err != nil {
		t.Fatalf("ParseFrontMatter() error = %v", err)
	}

	if diff := cmp.Diff(original, parsed); diff != "" {
		t.Errorf("round-trip mismatch (-want +got):\n%s", diff)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func strPtr(s string) *string {
	return &s
}

func timePtr(t time.Time) *time.Time {
	return &t
}
