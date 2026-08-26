package tracker

import (
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/spf13/afero"
)

// MapSummary is a compact view of a map for listing.
type MapSummary struct {
	Slug      string   `json:"slug"`
	Title     string   `json:"title"`
	State     string   `json:"state"`
	Milestone *string  `json:"milestone"`
	Progress  Progress `json:"progress"`
}

// ReadMap reads a map's front matter (title/state/milestone/created_at/closed_at).
func ReadMap(fs afero.Fs, scratchDir, mapSlug string) (MapFrontMatter, error) {
	mapPath := filepath.Join(scratchDir, mapSlug, "map.md")
	data, err := afero.ReadFile(fs, mapPath)
	if err != nil {
		return MapFrontMatter{}, errors.Wrapf(ErrNotFound, "map %q not found. No .scratch/%s/map.md file", mapSlug, mapSlug)
	}
	mfm, err := ParseMapFrontMatter(data)
	if err != nil {
		return MapFrontMatter{}, errors.Wrapf(err, "parsing map front matter")
	}
	return mfm, nil
}

// SetMapState updates a map's state (active|closed) and closed_at timestamp.
func SetMapState(fs afero.Fs, scratchDir, mapSlug, newState string, now time.Time) error {
	if newState != "active" && newState != "closed" {
		return errors.Wrapf(ErrInvalidInput, "invalid state %q, valid values: active, closed", newState)
	}

	mapPath := filepath.Join(scratchDir, mapSlug, "map.md")
	exists, err := afero.Exists(fs, mapPath)
	if err != nil {
		return errors.Wrapf(err, "checking map.md")
	}
	if !exists {
		return errors.Wrapf(ErrNotFound, "map %q not found. No .scratch/%s/map.md file", mapSlug, mapSlug)
	}

	data, err := afero.ReadFile(fs, mapPath)
	if err != nil {
		return errors.Wrapf(err, "reading map.md")
	}

	mfm, err := ParseMapFrontMatter(data)
	if err != nil {
		return errors.Wrapf(err, "parsing map front matter")
	}

	mfm.State = newState
	if newState == "closed" {
		mfm.ClosedAt = &now
	} else {
		mfm.ClosedAt = nil
	}

	// Preserve body
	body := extractBody(data)

	fmData, err := mfm.Marshal()
	if err != nil {
		return errors.Wrapf(err, "marshaling map front matter")
	}

	content := append(fmData, []byte(body)...)
	return afero.WriteFile(fs, mapPath, content, 0644)
}

// ListMaps scans .scratch/ for directories containing map.md and returns summaries.
// Includes all maps (active + closed). Does NOT include frontier_size (G-Q6).
func ListMaps(fs afero.Fs, scratchDir string) ([]MapSummary, error) {
	entries, err := afero.ReadDir(fs, scratchDir)
	if err != nil {
		return []MapSummary{}, nil // scratch dir doesn't exist or unreadable → empty
	}

	var maps []MapSummary
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		mapPath := filepath.Join(scratchDir, entry.Name(), "map.md")
		exists, err := afero.Exists(fs, mapPath)
		if err != nil || !exists {
			continue
		}

		data, err := afero.ReadFile(fs, mapPath)
		if err != nil {
			continue
		}

		mfm, err := ParseMapFrontMatter(data)
		if err != nil {
			continue // skip malformed maps
		}

		progress, err := ComputeProgress(fs, scratchDir, entry.Name())
		if err != nil {
			progress = Progress{}
		}

		maps = append(maps, MapSummary{
			Slug:      entry.Name(),
			Title:     mfm.Title,
			State:     mfm.State,
			Milestone: mfm.Milestone,
			Progress:  progress,
		})
	}

	// Sort by slug ascending
	slices.SortFunc(maps, func(a, b MapSummary) int {
		return strings.Compare(a.Slug, b.Slug)
	})

	return maps, nil
}

// FilterMapsByMilestone filters maps by milestone slug.
func FilterMapsByMilestone(maps []MapSummary, milestoneSlug string) []MapSummary {
	var filtered []MapSummary
	for _, m := range maps {
		if m.Milestone != nil && *m.Milestone == milestoneSlug {
			filtered = append(filtered, m)
		}
	}
	return filtered
}
