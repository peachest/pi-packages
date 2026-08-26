package tracker

import (
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestMilestoneFrontMatterRoundTrip(t *testing.T) {
	original := MilestoneFrontMatter{
		Title:     "PPU MIG 设备插件",
		State:     "active",
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ClosedAt:  nil,
	}

	data, err := original.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	parsed, err := ParseMilestoneFrontMatter(data)
	if err != nil {
		t.Fatalf("ParseMilestoneFrontMatter() error = %v", err)
	}

	if diff := cmp.Diff(original, parsed); diff != "" {
		t.Errorf("round-trip mismatch (-want +got):\n%s", diff)
	}
}

func TestMilestoneFrontMatterClosed(t *testing.T) {
	closedAt := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	fm := MilestoneFrontMatter{
		Title:     "Closed MS",
		State:     "closed",
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ClosedAt:  &closedAt,
	}

	data, err := fm.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	parsed, err := ParseMilestoneFrontMatter(data)
	if err != nil {
		t.Fatalf("ParseMilestoneFrontMatter() error = %v", err)
	}

	if parsed.State != "closed" {
		t.Errorf("state = %q, want \"closed\"", parsed.State)
	}
	if parsed.ClosedAt == nil || !parsed.ClosedAt.Equal(closedAt) {
		t.Errorf("closed_at = %v, want %v", parsed.ClosedAt, closedAt)
	}
}
