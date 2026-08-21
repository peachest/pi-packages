package tracker

import (
	"testing"
	"time"

	"github.com/spf13/afero"
)

func TestSetMapState(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch/m", 0755)

	// Create map.md with front matter
	mfm := MapFrontMatter{
		Title:     "Test Map",
		State:     "active",
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
	}
	data, _ := mfm.Marshal()
	data = append(data, []byte("\n# Test Map\n\n## Destination\n\ndone\n")...)
	afero.WriteFile(fs, "/p/.scratch/m/map.md", data, 0644)

	// Close
	closeTime := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	err := SetMapState(fs, "/p/.scratch", "m", "closed", closeTime)
	if err != nil {
		t.Fatalf("SetMapState() error = %v", err)
	}

	// Verify
	readData, _ := afero.ReadFile(fs, "/p/.scratch/m/map.md")
	parsed, err := ParseMapFrontMatter(readData)
	if err != nil {
		t.Fatalf("ParseMapFrontMatter() error = %v", err)
	}
	if parsed.State != "closed" {
		t.Errorf("state = %q, want \"closed\"", parsed.State)
	}
	if parsed.ClosedAt == nil || !parsed.ClosedAt.Equal(closeTime) {
		t.Errorf("closed_at = %v, want %v", parsed.ClosedAt, closeTime)
	}
}

func TestSetMapStateReopen(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch/m", 0755)

	closeTime := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	mfm := MapFrontMatter{
		Title:     "Test Map",
		State:     "closed",
		CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		ClosedAt:  &closeTime,
	}
	data, _ := mfm.Marshal()
	data = append(data, []byte("\n# Test Map\n")...)
	afero.WriteFile(fs, "/p/.scratch/m/map.md", data, 0644)

	// Reopen
	err := SetMapState(fs, "/p/.scratch", "m", "active", time.Now().UTC())
	if err != nil {
		t.Fatalf("SetMapState() error = %v", err)
	}

	readData, _ := afero.ReadFile(fs, "/p/.scratch/m/map.md")
	parsed, _ := ParseMapFrontMatter(readData)
	if parsed.State != "active" {
		t.Errorf("state = %q, want \"active\"", parsed.State)
	}
	if parsed.ClosedAt != nil {
		t.Errorf("closed_at = %v, want nil", parsed.ClosedAt)
	}
}

func TestSetMapStateNotFound(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch", 0755)

	err := SetMapState(fs, "/p/.scratch", "nonexistent", "closed", time.Now().UTC())
	if !isErr(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestListMaps(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch/map-a", 0755)
	fs.MkdirAll("/p/.scratch/map-b", 0755)
	fs.MkdirAll("/p/.scratch/.milestones", 0755)

	// Create map.md files with front matter
	for _, slug := range []string{"map-a", "map-b"} {
		mfm := MapFrontMatter{
			Title:     slug,
			State:     "active",
			CreatedAt: time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC),
		}
		data, _ := mfm.Marshal()
		data = append(data, []byte("\n# "+slug+"\n")...)
		afero.WriteFile(fs, "/p/.scratch/"+slug+"/map.md", data, 0644)
	}

	maps, err := ListMaps(fs, "/p/.scratch")
	if err != nil {
		t.Fatalf("ListMaps() error = %v", err)
	}

	if len(maps) != 2 {
		t.Fatalf("got %d maps, want 2", len(maps))
	}
	if maps[0].Slug != "map-a" || maps[1].Slug != "map-b" {
		t.Errorf("maps = %v %v, want map-a map-b", maps[0].Slug, maps[1].Slug)
	}
}

func TestListMapsFilterMilestone(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch/with-ms", 0755)
	fs.MkdirAll("/p/.scratch/no-ms", 0755)

	ms := "infra"
	mfm1 := MapFrontMatter{Title: "with-ms", State: "active", Milestone: &ms, CreatedAt: time.Now().UTC()}
	data1, _ := mfm1.Marshal()
	afero.WriteFile(fs, "/p/.scratch/with-ms/map.md", append(data1, []byte("\n# with-ms\n")...), 0644)

	mfm2 := MapFrontMatter{Title: "no-ms", State: "active", CreatedAt: time.Now().UTC()}
	data2, _ := mfm2.Marshal()
	afero.WriteFile(fs, "/p/.scratch/no-ms/map.md", append(data2, []byte("\n# no-ms\n")...), 0644)

	maps, err := ListMaps(fs, "/p/.scratch")
	if err != nil {
		t.Fatalf("ListMaps() error = %v", err)
	}

	// Filter by milestone
	filtered := FilterMapsByMilestone(maps, "infra")
	if len(filtered) != 1 {
		t.Fatalf("got %d filtered maps, want 1", len(filtered))
	}
	if filtered[0].Slug != "with-ms" {
		t.Errorf("filtered map = %q, want \"with-ms\"", filtered[0].Slug)
	}
}

func TestListMapsEmpty(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch", 0755)

	maps, err := ListMaps(fs, "/p/.scratch")
	if err != nil {
		t.Fatalf("ListMaps() error = %v", err)
	}
	if len(maps) != 0 {
		t.Errorf("got %d maps, want 0", len(maps))
	}
}

func TestListMapsIncludesClosed(t *testing.T) {
	fs := afero.NewMemMapFs()
	fs.MkdirAll("/p/.scratch/closed-map", 0755)

	closeTime := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	mfm := MapFrontMatter{Title: "closed-map", State: "closed", CreatedAt: time.Now().UTC(), ClosedAt: &closeTime}
	data, _ := mfm.Marshal()
	afero.WriteFile(fs, "/p/.scratch/closed-map/map.md", append(data, []byte("\n# closed-map\n")...), 0644)

	maps, err := ListMaps(fs, "/p/.scratch")
	if err != nil {
		t.Fatalf("ListMaps() error = %v", err)
	}
	if len(maps) != 1 {
		t.Fatalf("got %d maps, want 1 (closed maps included)", len(maps))
	}
	if maps[0].State != "closed" {
		t.Errorf("state = %q, want \"closed\"", maps[0].State)
	}
}
