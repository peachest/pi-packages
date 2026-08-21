package tracker

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/spf13/afero"
)

var validTypes = []string{"research", "prototype", "grilling", "task"}
var validTriages = []string{"needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"}

// TicketOpts holds parameters for creating a ticket.
type TicketOpts struct {
	MapSlug   string
	Title     string
	Type      string
	BlockedBy []string
	Triage    *string
}

// TicketSummary is a compact view of a ticket for listing.
type TicketSummary struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Type      string   `json:"type"`
	Status    string   `json:"status"`
	Triage    *string  `json:"triage"`
	BlockedBy []string `json:"blocked_by"`
}

// ListFilter holds optional filters for listing tickets.
// All filters are AND-combined. Zero-value fields are ignored.
type ListFilter struct {
	Status    string // "open", "claimed", "resolved"; "" = no filter
	Type      string // "research", "prototype", "grilling", "task"; "" = no filter
	Triage    string // specific triage role; "" = no filter
	TriageNull bool  // if true, match triage=null (overrides Triage)
}

// CreateTicket creates a new ticket file in the map's issues/ directory.
func CreateTicket(fs afero.Fs, scratchDir string, opts TicketOpts, now time.Time) (TicketSummary, error) {
	// Validate type (G-Q10)
	if !slices.Contains(validTypes, opts.Type) {
		return TicketSummary{}, fmt.Errorf("%w: invalid type %q, valid values: %s", ErrInvalidInput, opts.Type, strings.Join(validTypes, ", "))
	}

	// Validate triage if provided (G-Q10)
	if opts.Triage != nil && !slices.Contains(validTriages, *opts.Triage) {
		return TicketSummary{}, fmt.Errorf("%w: invalid triage %q, valid values: %s", ErrInvalidInput, *opts.Triage, strings.Join(validTriages, ", "))
	}

	// Check map exists
	if !MapExists(fs, scratchDir, opts.MapSlug) {
		return TicketSummary{}, fmt.Errorf("%w: map %q not found. No .scratch/%s/ directory. Run 'tracker map list' to see available maps", ErrNotFound, opts.MapSlug, opts.MapSlug)
	}

	// Validate blocked_by IDs exist (G-Q4)
	if len(opts.BlockedBy) > 0 {
		existingIDs, err := collectTicketIDs(fs, scratchDir, opts.MapSlug)
		if err != nil {
			return TicketSummary{}, err
		}
		for _, id := range opts.BlockedBy {
			normalized := normalizeID(id)
			if !slices.Contains(existingIDs, normalized) {
				return TicketSummary{}, fmt.Errorf("%w: ticket #%s not found in map. Cannot block on a non-existent ticket", ErrInvalidInput, normalized)
			}
		}
		// Normalize blocked_by
		opts.BlockedBy = normalizeIDs(opts.BlockedBy)
	}

	// Ensure issues/ directory exists
	issuesDir := IssuesDir(scratchDir, opts.MapSlug)
	if err := fs.MkdirAll(issuesDir, 0755); err != nil {
		return TicketSummary{}, fmt.Errorf("creating issues directory: %w", err)
	}

	// Assign next ID
	nextID, err := nextTicketID(fs, issuesDir)
	if err != nil {
		return TicketSummary{}, err
	}

	// Ensure blocked_by is never nil
	blockedBy := opts.BlockedBy
	if blockedBy == nil {
		blockedBy = []string{}
	}

	// Build front matter
	fm := FrontMatter{
		ID:         nextID,
		Title:      opts.Title,
		Map:        opts.MapSlug,
		Type:       opts.Type,
		Status:    "open",
		Triage:    opts.Triage,
		BlockedBy: blockedBy,
		CreatedAt: now,
		ReviewedAt: nil,
	}

	fmData, err := fm.Marshal()
	if err != nil {
		return TicketSummary{}, fmt.Errorf("marshaling front matter: %w", err)
	}

	// Build body skeleton (G4: only ## Answer + ## Comments)
	body := fmt.Sprintf("# %s\n\n## Answer\n\n## Comments\n", opts.Title)

	content := append(fmData, []byte("\n"+body)...)

	// Write file
	filename := fmt.Sprintf("%s-%s.md", nextID, Slug(opts.Title))
	path := TicketPath(scratchDir, opts.MapSlug, filename)
	if err := afero.WriteFile(fs, path, content, 0644); err != nil {
		return TicketSummary{}, fmt.Errorf("writing ticket file: %w", err)
	}

	return TicketSummary{
		ID:        nextID,
		Title:     opts.Title,
		Type:      opts.Type,
		Status:    "open",
		Triage:    opts.Triage,
		BlockedBy: blockedBy,
	}, nil
}

// ListTickets reads all tickets in a map and optionally filters them.
func ListTickets(fs afero.Fs, scratchDir, mapSlug string, filter ListFilter) ([]TicketSummary, error) {
	issuesDir := IssuesDir(scratchDir, mapSlug)
	exists, err := afero.DirExists(fs, issuesDir)
	if err != nil {
		return nil, fmt.Errorf("checking issues directory: %w", err)
	}
	if !exists {
		return []TicketSummary{}, nil
	}

	entries, err := afero.ReadDir(fs, issuesDir)
	if err != nil {
		return nil, fmt.Errorf("reading issues directory: %w", err)
	}

	var tickets []TicketSummary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(issuesDir, entry.Name())
		data, err := afero.ReadFile(fs, path)
		if err != nil {
			continue // skip unreadable files
		}

		fm, err := ParseFrontMatter(data)
		if err != nil {
			continue // skip malformed files
		}

		ticket := TicketSummary{
			ID:        fm.ID,
			Title:     fm.Title,
			Type:      fm.Type,
			Status:    fm.Status,
			Triage:    fm.Triage,
			BlockedBy: fm.BlockedBy,
		}

		if !matchesFilter(ticket, filter) {
			continue
		}

		tickets = append(tickets, ticket)
	}

	// Sort by ID ascending
	slices.SortFunc(tickets, func(a, b TicketSummary) int {
		return strings.Compare(a.ID, b.ID)
	})

	return tickets, nil
}

func matchesFilter(t TicketSummary, f ListFilter) bool {
	if f.Status != "" && t.Status != f.Status {
		return false
	}
	if f.Type != "" && t.Type != f.Type {
		return false
	}
	if f.TriageNull {
		return t.Triage == nil
	}
	if f.Triage != "" {
		if t.Triage == nil || *t.Triage != f.Triage {
			return false
		}
	}
	return true
}

// nextTicketID scans the issues directory for existing IDs and returns the next one.
func nextTicketID(fs afero.Fs, issuesDir string) (string, error) {
	entries, err := afero.ReadDir(fs, issuesDir)
	if err != nil {
		return "", fmt.Errorf("reading issues directory for numbering: %w", err)
	}

	maxNum := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		name := entry.Name()
		// Extract leading number before first "-"
		dashIdx := strings.Index(name, "-")
		var idStr string
		if dashIdx > 0 {
			idStr = name[:dashIdx]
		} else {
			idStr = strings.TrimSuffix(name, ".md")
		}
		var num int
		if _, err := fmt.Sscanf(idStr, "%d", &num); err != nil {
			continue
		}
		if num > maxNum {
			maxNum = num
		}
	}

	return fmt.Sprintf("%02d", maxNum+1), nil
}

func collectTicketIDs(fs afero.Fs, scratchDir, mapSlug string) ([]string, error) {
	tickets, err := ListTickets(fs, scratchDir, mapSlug, ListFilter{})
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(tickets))
	for i, t := range tickets {
		ids[i] = t.ID
	}
	return ids, nil
}

func normalizeID(id string) string {
	var num int
	if _, err := fmt.Sscanf(id, "%d", &num); err != nil {
		return id
	}
	return fmt.Sprintf("%02d", num)
}

func normalizeIDs(ids []string) []string {
	result := make([]string, len(ids))
	for i, id := range ids {
		result[i] = normalizeID(id)
	}
	return result
}

// errorsIs is a wrapper to avoid importing errors in test helpers.
func errorsIs(err, target error) bool {
	return errors.Is(err, target)
}

// ReadTicketForDisplay reads a ticket's front matter for display purposes.
func ReadTicketForDisplay(fs afero.Fs, scratchDir, mapSlug, ticketID string) (string, FrontMatter, error) {
	return readTicket(fs, scratchDir, mapSlug, ticketID)
}

// ReviewTicket marks a ticket as reviewed by setting reviewed_at.
// Can be called multiple times (re-review updates reviewed_at).
func ReviewTicket(fs afero.Fs, scratchDir, mapSlug, ticketID string, now time.Time) error {
	path, fm, err := readTicket(fs, scratchDir, mapSlug, ticketID)
	if err != nil {
		return err
	}

	fm.ReviewedAt = &now

	return writeTicket(fs, path, fm)
}

// readTicket finds and reads a ticket file by ID.
func readTicket(fs afero.Fs, scratchDir, mapSlug, ticketID string) (string, FrontMatter, error) {
	normalizedID := normalizeID(ticketID)
	issuesDir := IssuesDir(scratchDir, mapSlug)
	entries, err := afero.ReadDir(fs, issuesDir)
	if err != nil {
		return "", FrontMatter{}, fmt.Errorf("reading issues directory: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(issuesDir, entry.Name())
		data, err := afero.ReadFile(fs, path)
		if err != nil {
			continue
		}
		fm, err := ParseFrontMatter(data)
		if err != nil {
			continue
		}
		if fm.ID == normalizedID {
			return path, fm, nil
		}
	}

	return "", FrontMatter{}, fmt.Errorf("%w: ticket #%s not found in map %s", ErrNotFound, normalizedID, mapSlug)
}

// writeTicket writes front matter + existing body back to the ticket file.
func writeTicket(fs afero.Fs, path string, fm FrontMatter) error {
	// Read existing file to preserve body
	data, err := afero.ReadFile(fs, path)
	if err != nil {
		return fmt.Errorf("reading ticket file: %w", err)
	}

	// Extract body (everything after the closing ---)
	body := extractBody(data)

	fmData, err := fm.Marshal()
	if err != nil {
		return fmt.Errorf("marshaling front matter: %w", err)
	}

	content := append(fmData, []byte(body)...)
	return afero.WriteFile(fs, path, content, 0644)
}

// extractBody returns the content after the YAML front matter (after the second ---).
func extractBody(data []byte) string {
	content := string(data)
	// Skip first ---
	if idx := strings.Index(content, "---\n"); idx >= 0 {
		content = content[idx+4:]
	}
	// Find closing ---
	if idx := strings.Index(content, "\n---\n"); idx >= 0 {
		content = content[idx+5:]
	} else if idx := strings.Index(content, "\n---"); idx >= 0 {
		content = content[idx+4:]
	}
	return content
}
