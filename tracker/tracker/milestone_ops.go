package tracker

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/spf13/afero"
)

// MilestoneSummary is a compact view of a milestone for listing.
type MilestoneSummary struct {
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	State    string `json:"state"`
	MapCount int    `json:"map_count"`
}

// MilestoneProgressResult is the result of a milestone progress query.
type MilestoneProgressResult struct {
	Slug     string   `json:"slug"`
	Title    string   `json:"title"`
	State    string   `json:"state"`
	Maps     []string `json:"maps"`
	Progress Progress `json:"progress"`
}

// MilestonePath returns the path to a milestone file.
func MilestonePath(scratchDir, slug string) string {
	return filepath.Join(scratchDir, ".milestones", slug+".md")
}

// ReadMilestone reads a milestone's front matter.
func ReadMilestone(fs afero.Fs, scratchDir, slug string) (MilestoneFrontMatter, error) {
	path := MilestonePath(scratchDir, slug)
	data, err := afero.ReadFile(fs, path)
	if err != nil {
		return MilestoneFrontMatter{}, fmt.Errorf("%w: milestone %q not found. No .scratch/.milestones/%s.md file", ErrNotFound, slug, slug)
	}
	mfm, err := ParseMilestoneFrontMatter(data)
	if err != nil {
		return MilestoneFrontMatter{}, fmt.Errorf("parsing milestone front matter: %w", err)
	}
	return mfm, nil
}

// SetMilestoneState updates a milestone's state (active|closed) and closed_at timestamp.
func SetMilestoneState(fs afero.Fs, scratchDir, slug, newState string, now time.Time) error {
	if newState != "active" && newState != "closed" {
		return fmt.Errorf("%w: invalid state %q, valid values: active, closed", ErrInvalidInput, newState)
	}

	path := MilestonePath(scratchDir, slug)
	data, err := afero.ReadFile(fs, path)
	if err != nil {
		return fmt.Errorf("%w: milestone %q not found. No .scratch/.milestones/%s.md file", ErrNotFound, slug, slug)
	}

	mfm, err := ParseMilestoneFrontMatter(data)
	if err != nil {
		return fmt.Errorf("parsing milestone front matter: %w", err)
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
		return fmt.Errorf("marshaling milestone front matter: %w", err)
	}

	content := append(fmData, []byte(body)...)
	return afero.WriteFile(fs, path, content, 0644)
}

// ListMilestones scans .scratch/.milestones/ for milestone files.
func ListMilestones(fs afero.Fs, scratchDir string) ([]MilestoneSummary, error) {
	milestonesDir := filepath.Join(scratchDir, ".milestones")
	exists, err := afero.DirExists(fs, milestonesDir)
	if err != nil || !exists {
		return []MilestoneSummary{}, nil
	}

	entries, err := afero.ReadDir(fs, milestonesDir)
	if err != nil {
		return []MilestoneSummary{}, nil
	}

	maps, err := ListMaps(fs, scratchDir)
	if err != nil {
		maps = []MapSummary{}
	}

	var milestones []MilestoneSummary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}

		slug := strings.TrimSuffix(entry.Name(), ".md")
		mfm, err := ReadMilestone(fs, scratchDir, slug)
		if err != nil {
			continue // skip malformed
		}

		mapCount := len(FilterMapsByMilestone(maps, slug))

		milestones = append(milestones, MilestoneSummary{
			Slug:     slug,
			Title:    mfm.Title,
			State:    mfm.State,
			MapCount: mapCount,
		})
	}

	// Sort by slug ascending
	slices.SortFunc(milestones, func(a, b MilestoneSummary) int {
		return strings.Compare(a.Slug, b.Slug)
	})

	return milestones, nil
}

// MilestoneProgress computes progress across all maps referencing a milestone.
func MilestoneProgress(fs afero.Fs, scratchDir, slug string) (MilestoneProgressResult, error) {
	mfm, err := ReadMilestone(fs, scratchDir, slug)
	if err != nil {
		return MilestoneProgressResult{}, err
	}

	maps, err := ListMaps(fs, scratchDir)
	if err != nil {
		return MilestoneProgressResult{}, fmt.Errorf("listing maps: %w", err)
	}

	refMaps := FilterMapsByMilestone(maps, slug)

	var (
		aggregate Progress
		slugs     []string
	)
	for _, m := range refMaps {
		p, err := ComputeProgress(fs, scratchDir, m.Slug)
		if err != nil {
			continue
		}
		aggregate.Open += p.Open
		aggregate.Claimed += p.Claimed
		aggregate.Resolved += p.Resolved
		aggregate.Total += p.Total
		slugs = append(slugs, m.Slug)
	}

	// Sort slugs ascending
	slices.Sort(slugs)

	return MilestoneProgressResult{
		Slug:     slug,
		Title:    mfm.Title,
		State:    mfm.State,
		Maps:     slugs,
		Progress: aggregate,
	}, nil
}