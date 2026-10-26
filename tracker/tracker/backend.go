package tracker

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
)

// Backend abstracts ticket storage. Three implementations:
//
//   - LocalBackend: markdown files under .scratch/ (the original behavior,
//     fully backward compatible, still the default).
//   - GitHubBackend: shells out to `gh`.
//   - GitLabBackend: shells out to `glab api` (raw REST JSON — glab's own
//     per-command output formats are too inconsistent to parse reliably).
//
// Local → remote field mapping (intentionally NOT 1:1 with markdown
// semantics; documented per method where it matters):
//
//	repo      ← the real git hosting repo (`gh -R` / `glab -R`)
//	map       ← label `map/<slug>` (a lighter stand-in for wayfinder's
//	            map+sub-issue pattern: covers listing/filtering, which is
//	            what this CLI needs; sub-issue APIs differ too much between
//	            GitHub and GitLab to share one interface)
//	type      ← label `type/<t>`
//	triage    ← label `triage/<role>`
//	status    ← issue state (open|closed) + optional label `status/claimed`;
//	            claimed = open + label (hosting platforms have no claimed)
//	blocked_by ← `Blocked by: #1, #2` marker line in the issue body
//	            (parsed back on read; sub-issue relations not used)
//	comment   ← platform-native issue comment
type Backend interface {
	ListMaps() ([]MapSummary, error)
	CreateTicket(opts TicketOpts) (TicketSummary, error)
	ListTickets(mapSlug string, filter ListFilter) ([]TicketSummary, error)
	GetTicket(mapSlug, ticketID string) (TicketDetail, error)
	AddComment(mapSlug, ticketID, body string) error
	SetStatus(mapSlug, ticketID, status string) error
	SetTriage(mapSlug, ticketID, triage string) error
	SetBlocking(mapSlug, ticketID string, blockedBy []string) error
	Frontier(mapSlug string) ([]TicketSummary, error)
	CloseVerify(opts CloseVerifyOpts) (CloseVerifyReport, error)
}

// TicketComment is one comment on a ticket.
type TicketComment struct {
	Author    string    `json:"author"`
	CreatedAt time.Time `json:"created_at"`
	Body      string    `json:"body"`
}

// TicketDetail is the full view of a ticket: summary + body + comments.
// For LocalBackend, Comments is nil (comments live as plain markdown inside
// Body's "## Comments" section) and Body is the file body.
type TicketDetail struct {
	TicketSummary
	Comments []TicketComment `json:"comments"`
	Body     string          `json:"body"`
	// Local-only lifecycle timestamps (route.md CLI output contract; remote
	// hosting platforms have no equivalent fields — nil there).
	ClaimedAt  *time.Time `json:"claimed_at"`
	ResolvedAt *time.Time `json:"resolved_at"`
}

// CloseVerifyOpts configures a close-verify run.
type CloseVerifyOpts struct {
	// Ref is a PR/MR number or a merge/commit SHA.
	Ref string
	// Apply performs the write actions (comment + close). Dry-run when false.
	Apply bool
}

// CloseRef is one referenced issue and its verification result.
type CloseRef struct {
	Issue  string `json:"issue"`
	State  string `json:"state"`  // local status vocabulary: open|claimed|resolved, or "not-found"
	Closed bool   `json:"closed"` // true when state == resolved
}

// CloseVerifyReport is the result of a close-verify run.
type CloseVerifyReport struct {
	Source    string     `json:"source"` // "pr #12" / "mr !3" / "commit abc1234"
	SourceURL string     `json:"source_url,omitempty"`
	Refs      []CloseRef `json:"refs"`
	// Applied lists issues that were commented+closed because Apply was set.
	Applied []string `json:"applied,omitempty"`
}

// --- blocked_by body marker (remote backends) ---

var blockedByLineRe = regexp.MustCompile(`(?m)^Blocked by:.*$`)

// parseBlockedBy extracts blocker IDs from a "Blocked by: #1, #2" body line.
// Returns [] (never nil) when the marker is absent.
func parseBlockedBy(body string) []string {
	line := blockedByLineRe.FindString(body)
	if line == "" {
		return []string{}
	}
	_, rest, found := strings.Cut(line, ":")
	if !found {
		return []string{}
	}
	var ids []string
	for _, tok := range strings.FieldsFunc(rest, func(r rune) bool { return r == ',' || r == ';' }) {
		tok = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(tok), "#"))
		if tok != "" {
			ids = append(ids, tok)
		}
	}
	return ids
}

// buildBodyWithBlockers replaces any existing marker line with one built from
// ids, prepending it to the body. Empty ids removes the marker entirely.
func buildBodyWithBlockers(body string, ids []string) string {
	body = blockedByLineRe.ReplaceAllString(body, "")
	body = strings.TrimSpace(body)
	if len(ids) == 0 {
		return body
	}
	refs := make([]string, len(ids))
	for i, id := range ids {
		refs[i] = "#" + remoteID(id)
	}
	return strings.TrimSpace("Blocked by: " + strings.Join(refs, ", ") + "\n\n" + body)
}

// remoteID normalizes a ticket ID for remote use: strips '#' and leading
// zeros ("#07" → "7"). Local zero-padded IDs ("01") and raw numbers both
// round-trip.
func remoteID(id string) string {
	s := strings.TrimPrefix(strings.TrimSpace(id), "#")
	if n, err := strconv.Atoi(s); err == nil {
		return strconv.Itoa(n)
	}
	return s
}

// validateTicketOpts checks type/triage values for remote backends (local
// validation lives inside CreateTicket). mapSlug+title required.
func validateTicketOpts(opts TicketOpts) error {
	if opts.MapSlug == "" {
		return errors.Wrap(ErrInvalidInput, "map slug is required")
	}
	if opts.Title == "" {
		return errors.Wrap(ErrInvalidInput, "title is required")
	}
	if !inList(validTypes, opts.Type) {
		return errors.Wrapf(ErrInvalidInput, "invalid type %q, valid values: %s", opts.Type, join(validTypes))
	}
	if opts.Triage != nil && !inList(validTriages, *opts.Triage) {
		return errors.Wrapf(ErrInvalidInput, "invalid triage %q, valid values: %s", *opts.Triage, join(validTriages))
	}
	return nil
}

func inList(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func join(list []string) string { return strings.Join(list, ", ") }

// MapSummary label helpers shared by remote backends.
func mapLabel(mapSlug string) string { return "map/" + mapSlug }

// validateStatus checks a status value against the shared vocabulary.
func validateStatus(status string) error {
	if !inList(validStatuses, status) {
		return errors.Wrapf(ErrInvalidInput, "invalid status %q, valid values: %v", status, validStatuses)
	}
	return nil
}

// closeSource is the backend-specific input for runCloseVerify: where the
// merge came from and every free-text that may carry closing patterns.
type closeSource struct {
	Source string
	URL    string
	Texts  []string
}

// runCloseVerify is the shared close-verify tail: parse closing refs from
// src.Texts, check each issue's state, and (with Apply) comment+close the
// still-open ones. mapSlug may be empty on remote backends (issue numbers
// are repo-global); local never reaches here.
func runCloseVerify(b Backend, mapSlug string, src closeSource, opts CloseVerifyOpts) (CloseVerifyReport, error) {
	seen := map[string]bool{}
	var refs []string
	for _, text := range src.Texts {
		for _, r := range ParseClosingRefs(text) {
			if !seen[r] {
				seen[r] = true
				refs = append(refs, r)
			}
		}
	}

	report := CloseVerifyReport{Source: src.Source, SourceURL: src.URL}
	for _, ref := range refs {
		cr := CloseRef{Issue: ref}
		detail, err := b.GetTicket(mapSlug, ref)
		switch {
		case err == nil:
			cr.State = detail.Status
			cr.Closed = detail.Status == "resolved"
		case errors.Is(err, ErrNotFound):
			cr.State = "not-found"
		default:
			return CloseVerifyReport{}, errors.Wrapf(err, "checking issue #%s", ref)
		}

		if opts.Apply && err == nil && !cr.Closed {
			note := fmt.Sprintf("Closed by %s (%s). Verified automatically by `tracker close-verify`.", src.Source, src.URL)
			// Close FIRST, then comment: if commenting fails after a successful
			// close, the ticket is closed with no note — recoverable by reading
			// the report. The reverse order leaves an open ticket wearing a
			// "Closed by" note, a lie on the record (ocr M4).
			if err := b.SetStatus(mapSlug, ref, "resolved"); err != nil {
				// Return the PARTIAL report: the caller must see which
				// tickets were already closed before the failure (ocr M'2 —
				// a zero-value report discards the audit trail).
				return report, errors.Wrapf(err, "closing issue #%s", ref)
			}
			if err := b.AddComment(mapSlug, ref, note); err != nil {
				cr.State = "resolved"
				cr.Closed = true
				report.Applied = append(report.Applied, ref)
				report.Refs = append(report.Refs, cr)
				return report, errors.Wrapf(err, "closing issue #%s succeeded but adding the close-note failed — ticket is closed, note missing", ref)
			}
			cr.State = "resolved"
			cr.Closed = true
			report.Applied = append(report.Applied, ref)
		}
		report.Refs = append(report.Refs, cr)
	}
	if report.Refs == nil {
		report.Refs = []CloseRef{}
	}
	return report, nil
}
